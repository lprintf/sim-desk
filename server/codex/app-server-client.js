const { EventEmitter } = require('events');
const { spawn, spawnSync } = require('child_process');
const readline = require('readline');

function cleanDiagnostic(value) {
    return String(value || '')
        .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
        .replace(/[\r\n]+/g, ' ')
        .trim();
}

function resolveCommand(command) {
    if (process.platform !== 'win32' || /[\\/]/.test(command)) {
        return { command, found: true };
    }

    const lookup = spawnSync('where.exe', [command], {
        encoding: 'utf8',
        windowsHide: true,
    });
    if (lookup.status !== 0) return { command, found: false };

    const candidates = lookup.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean);
    const resolved = candidates.find((item) => /\.(?:exe|com)$/i.test(item)) || candidates[0];
    return { command: resolved || command, found: Boolean(resolved) };
}

class CodexAppServerClient extends EventEmitter {
    constructor(options = {}) {
        super();
        this.command = options.command || process.env.CODEX_BIN || 'codex';
        const resolution = resolveCommand(this.command);
        this.resolvedCommand = resolution.command;
        this.commandFound = resolution.found;
        this.requestTimeoutMs = options.requestTimeoutMs || 30000;
        this.restartBackoffMs = options.restartBackoffMs || 3000;
        this.proc = null;
        this.nextId = 1;
        this.pending = new Map();
        this.serverRequests = new Map();
        this.loadedThreads = new Set();
        this.readyPromise = null;
        this.stopping = false;
        this.lastError = null;
        this.lastStartFailure = null;
        this.retryAfter = 0;
        this.stderrTail = [];
    }

    get running() {
        return Boolean(this.proc && this.proc.exitCode === null);
    }

    async start() {
        if (this.readyPromise) return this.readyPromise;
        if (this.lastStartFailure && Date.now() < this.retryAfter) {
            return Promise.reject(this.lastStartFailure);
        }

        this.readyPromise = this._start().catch((error) => {
            this.readyPromise = null;
            this.lastStartFailure = error;
            this.retryAfter = Date.now() + this.restartBackoffMs;
            throw error;
        });
        return this.readyPromise;
    }

    async _start() {
        this.stopping = false;
        this.stderrTail = [];
        if (!this.commandFound) {
            throw new Error(
                `Codex executable "${this.command}" was not found on PATH. ` +
                'Install Codex CLI or set CODEX_BIN to its full path.',
            );
        }
        const useShell = process.platform === 'win32' &&
            (!/[\\/]/.test(this.resolvedCommand) || /\.(?:cmd|bat)$/i.test(this.resolvedCommand));
        this.proc = spawn(this.resolvedCommand, ['app-server', '--stdio'], {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
            shell: useShell,
            env: process.env,
        });

        this.proc.once('error', (error) => {
            const startupError = new Error(
                `Could not launch Codex app-server with "${this.resolvedCommand}": ${error.message}`,
            );
            this.lastError = startupError.message;
            this.proc = null;
            this._rejectAll(startupError);
            this.emit('state', { running: false, error: startupError.message });
        });

        this.proc.once('exit', (code, signal) => {
            const detail = this.stderrTail.slice(-6).join(' | ').slice(-2000);
            const suffix = detail ? `: ${detail}` : '';
            const error = new Error(`Codex app-server exited (${signal || code})${suffix}`);
            this.lastError = error.message;
            this.proc = null;
            this.readyPromise = null;
            this.loadedThreads.clear();
            this.serverRequests.clear();
            this._rejectAll(error);
            this.emit('state', { running: false, error: error.message });
        });

        readline.createInterface({ input: this.proc.stdout }).on('line', (line) => {
            const trimmed = line.trim();
            if (!trimmed) return;
            try {
                this._handleMessage(JSON.parse(trimmed));
            } catch (error) {
                this.emit('protocolError', { message: error.message, line: trimmed.slice(0, 500) });
            }
        });

        readline.createInterface({ input: this.proc.stderr }).on('line', (line) => {
            const diagnostic = cleanDiagnostic(line);
            if (!diagnostic) return;
            this.stderrTail.push(diagnostic);
            if (this.stderrTail.length > 20) this.stderrTail.shift();
            this.lastError = diagnostic;
            this.emit('stderr', diagnostic);
        });

        await this._requestWithoutStart('initialize', {
            clientInfo: {
                name: 'sim_desk',
                title: 'Sim Desk',
                version: '0.1.0',
            },
        });
        this.notify('initialized', {});
        this.lastError = null;
        this.lastStartFailure = null;
        this.retryAfter = 0;
        this.emit('state', { running: true, error: null });
    }

    async request(method, params = {}, timeoutMs = this.requestTimeoutMs) {
        await this.start();
        return this._requestWithoutStart(method, params, timeoutMs);
    }

    _requestWithoutStart(method, params = {}, timeoutMs = this.requestTimeoutMs) {
        if (!this.proc?.stdin?.writable) {
            return Promise.reject(new Error('Codex app-server is not running'));
        }

        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(String(id));
                reject(new Error(`Codex request timed out: ${method}`));
            }, timeoutMs);

            this.pending.set(String(id), { resolve, reject, timer, method });
            this._write({ method, id, params });
        });
    }

    notify(method, params = {}) {
        this._write({ method, params });
    }

    respondToServerRequest(requestId, result) {
        const key = String(requestId);
        const request = this.serverRequests.get(key);
        if (!request) throw new Error('Approval request is no longer pending');
        this._write({ id: request.id, result });
        this.serverRequests.delete(key);
        this.emit('serverRequestResolved', { requestId: key });
    }

    getPendingServerRequests() {
        return Array.from(this.serverRequests.entries()).map(([requestId, request]) => ({
            requestId,
            method: request.method,
            params: request.params,
        }));
    }

    async ensureThreadLoaded(threadId) {
        if (this.loadedThreads.has(threadId)) return;
        await this.request('thread/resume', { threadId });
        this.loadedThreads.add(threadId);
    }

    _handleMessage(message) {
        if (Object.prototype.hasOwnProperty.call(message, 'id') && (message.result !== undefined || message.error)) {
            const pending = this.pending.get(String(message.id));
            if (!pending) return;
            clearTimeout(pending.timer);
            this.pending.delete(String(message.id));
            if (message.error) {
                const error = new Error(message.error.message || `Codex request failed: ${pending.method}`);
                error.code = message.error.code;
                error.data = message.error.data;
                pending.reject(error);
            } else {
                pending.resolve(message.result);
            }
            return;
        }

        if (Object.prototype.hasOwnProperty.call(message, 'id') && message.method) {
            const requestId = String(message.id);
            this.serverRequests.set(requestId, message);
            this.emit('serverRequest', { requestId, method: message.method, params: message.params });
            return;
        }

        if (message.method) this.emit('notification', message);
    }

    _write(message) {
        if (!this.proc?.stdin?.writable) throw new Error('Codex app-server is not running');
        this.proc.stdin.write(`${JSON.stringify(message)}\n`);
    }

    _rejectAll(error) {
        for (const pending of this.pending.values()) {
            clearTimeout(pending.timer);
            pending.reject(error);
        }
        this.pending.clear();
    }

    stop() {
        this.stopping = true;
        if (this.proc && this.proc.exitCode === null) this.proc.kill();
    }
}

module.exports = { CodexAppServerClient };
