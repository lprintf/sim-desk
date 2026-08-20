const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const pty = require('node-pty');
const { isWithin } = require('./workspace-store');

const DEFAULT_IDLE_MS = 30 * 60 * 1000;
const READY_TIMEOUT_MS = 5000;
const MAX_CAPTURE = 256 * 1024;
const READY_PREFIX = '__CODEX_DECK_READY_';
const DONE_PREFIX = '__CODEX_DECK_DONE_';
const ECHO_PREFIX = '__CODEX_DECK_ECHO_';

function executableOnPath(name) {
    const extensions = process.platform === 'win32'
        ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
        : [''];
    for (const directory of String(process.env.PATH || '').split(path.delimiter)) {
        if (!directory) continue;
        for (const extension of extensions) {
            const candidate = path.join(directory, process.platform === 'win32' && !path.extname(name) ? `${name}${extension}` : name);
            if (fs.existsSync(candidate)) return candidate;
        }
    }
    return null;
}

function gitBashPath() {
    if (process.platform !== 'win32') return null;
    const roots = [process.env.ProgramW6432, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    const candidates = roots.flatMap((root) => [
        path.join(root, 'Git', 'bin', 'bash.exe'),
        path.join(root, 'Git', 'usr', 'bin', 'bash.exe'),
    ]);
    const git = executableOnPath('git');
    if (git) {
        const installRoot = path.dirname(path.dirname(git));
        candidates.unshift(path.join(installRoot, 'bin', 'bash.exe'));
    }
    return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function shellProfile(value = process.env.DECK_SHELL || process.env.CODEX_SHELL || 'auto') {
    const requested = String(value || 'auto').trim();
    const alias = requested.toLowerCase();
    let executable = requested;

    if (!requested || alias === 'auto') {
        executable = process.platform === 'win32'
            ? (gitBashPath() || executableOnPath('pwsh') || executableOnPath('powershell') || 'powershell.exe')
            : (process.env.SHELL || executableOnPath('bash') || '/bin/bash');
    } else if (alias === 'git-bash' || alias === 'gitbash') {
        executable = gitBashPath();
        if (!executable) throw new Error('Git Bash is not installed');
    } else if (alias === 'powershell') {
        executable = executableOnPath('powershell') || 'powershell.exe';
    } else if (alias === 'pwsh') {
        executable = executableOnPath('pwsh');
        if (!executable) throw new Error('PowerShell 7 is not installed');
    } else if (alias === 'wsl') {
        executable = executableOnPath('wsl') || 'wsl.exe';
    }

    if (!executable) throw new Error(`Shell is unavailable: ${requested}`);
    const name = path.basename(executable).toLowerCase();
    const isGitBash = process.platform === 'win32' && name === 'bash.exe' && /[\\/]git[\\/]/i.test(executable);
    if (name === 'bash' || name === 'bash.exe' || name === 'zsh' || name === 'zsh.exe') {
        return {
            executable,
            args: ['--noprofile', '--norc'],
            kind: 'bash',
            label: isGitBash ? 'Git Bash' : path.basename(executable),
            isGitBash,
            useConpty: isGitBash ? false : undefined,
        };
    }
    if (name === 'wsl' || name === 'wsl.exe') {
        return {
            executable,
            args: ['--', 'bash', '--noprofile', '--norc'],
            kind: 'wsl',
            label: 'WSL Bash',
            isGitBash: false,
        };
    }
    if (name.includes('powershell') || name === 'pwsh' || name === 'pwsh.exe') {
        return {
            executable,
            args: ['-NoLogo', '-NoProfile', '-NoExit'],
            kind: 'powershell',
            label: name.startsWith('pwsh') ? 'PowerShell 7' : 'Windows PowerShell',
            isGitBash: false,
        };
    }
    throw new Error(`Persistent sessions do not support this shell: ${executable}`);
}

function consumeTerminalControls(value, state = { mode: 'text' }) {
    let output = '';
    for (const character of String(value)) {
        const code = character.charCodeAt(0);
        if (state.mode === 'text') {
            if (character === '\x1b') state.mode = 'escape';
            else if (code === 9 || code === 10 || code === 13 || code >= 32 && code !== 127) output += character;
        } else if (state.mode === 'escape') {
            if (character === '[') state.mode = 'csi';
            else if (character === ']') state.mode = 'osc';
            else if ('PX^_'.includes(character)) state.mode = 'string';
            else if ('()'.includes(character)) state.mode = 'charset';
            else state.mode = character === '\x1b' ? 'escape' : 'text';
        } else if (state.mode === 'csi') {
            if (code >= 0x40 && code <= 0x7e) state.mode = 'text';
        } else if (state.mode === 'osc') {
            if (character === '\x07') state.mode = 'text';
            else if (character === '\x1b') state.mode = 'osc-escape';
        } else if (state.mode === 'string') {
            if (character === '\x1b') state.mode = 'string-escape';
        } else if (state.mode === 'osc-escape' || state.mode === 'string-escape') {
            if (character === '\\') state.mode = 'text';
            else state.mode = state.mode === 'osc-escape' ? 'osc' : 'string';
        } else if (state.mode === 'charset') {
            state.mode = 'text';
        }
    }
    return output;
}

function stripTerminalControls(value) {
    return consumeTerminalControls(value);
}

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function decodeBase64(value) {
    try { return Buffer.from(value, 'base64').toString('utf8'); } catch { return ''; }
}

class ShellSession {
    constructor({ id, workspaceId, root, profile, idleMs = DEFAULT_IDLE_MS, onIdle }) {
        this.id = id;
        this.workspaceId = workspaceId;
        this.root = root;
        this.cwd = root;
        this.profile = profile;
        this.idleMs = idleMs;
        this.onIdle = onIdle;
        this.pending = null;
        this.starting = false;
        this.ready = false;
        this.dead = false;
        this.exited = false;
        this.lineBuffer = '';
        this.controlState = { mode: 'text' };
        this.lastUsedAt = Date.now();
        this._readyToken = crypto.randomBytes(10).toString('hex');
        this._spawn();
        this._touch();
    }

    _spawn() {
        const env = {
            ...process.env,
            TERM: 'dumb',
            NO_COLOR: '1',
            COLUMNS: '200',
            LANG: process.env.LANG || 'C.UTF-8',
            CHERE_INVOKING: '1',
            MSYS2_PATH_TYPE: 'inherit',
        };
        this.proc = pty.spawn(this.profile.executable, this.profile.args, {
            cwd: this.root,
            cols: 200,
            rows: 30,
            env,
            useConpty: this.profile.useConpty,
        });
        this.proc.onData((data) => this._onData(data));
        this.proc.onExit(({ exitCode, signal }) => {
            this.exited = true;
            this.dead = true;
            if (this.pending) this._finish({ exitCode: exitCode ?? 1, signal: signal || null, killed: false, error: 'Shell session exited' });
        });

        if (this.profile.kind === 'bash') {
            this.proc.write(`stty -echo; export PS1=''; unset PROMPT_COMMAND; printf '${READY_PREFIX}${this._readyToken}__\\n'\r`);
        } else if (this.profile.kind === 'powershell') {
            const encoding = '[System.Text.UTF8Encoding]::new($false)';
            this.proc.write(`[Console]::InputEncoding=${encoding}; [Console]::OutputEncoding=${encoding}; $OutputEncoding=${encoding}; function prompt { '' }; Write-Output '${READY_PREFIX}${this._readyToken}__'\r`);
        } else {
            this.proc.write(`printf '${READY_PREFIX}${this._readyToken}__\\n'\r`);
        }
    }

    _touch() {
        this.lastUsedAt = Date.now();
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.onIdle(this.id), this.idleMs);
        this.idleTimer.unref?.();
    }

    info() {
        return {
            sessionId: this.id,
            workspace: this.workspaceId,
            cwd: this.cwd,
            shell: this.profile.label,
            executable: this.profile.executable,
            busy: Boolean(this.pending || this.starting),
            ready: this.ready,
        };
    }

    waitUntilReady(timeout = READY_TIMEOUT_MS) {
        if (this.ready) return Promise.resolve();
        const deadline = Date.now() + timeout;
        return new Promise((resolve, reject) => {
            const check = () => {
                if (this.ready) return resolve();
                if (this.dead) return reject(new Error('Shell session exited before it was ready'));
                if (Date.now() >= deadline) return reject(new Error('Shell session did not become ready'));
                setTimeout(check, 20);
            };
            check();
        });
    }

    _emitText(text) {
        if (!this.pending || !text) return;
        const remaining = Math.max(0, MAX_CAPTURE - this.pending.stdout.length);
        if (remaining > 0) this.pending.stdout += text.slice(0, remaining);
        if (text.length > remaining) this.pending.truncated = true;
        this.pending.onEvent?.({ type: 'stdout', text });
    }

    _onData(data) {
        const clean = consumeTerminalControls(data, this.controlState).replace(/\r/g, '');
        if (!clean) return;
        this.lineBuffer = (this.lineBuffer || '') + clean;
        const lines = this.lineBuffer.split('\n');
        this.lineBuffer = lines.pop() || '';

        for (const line of lines) {
            if (!this.ready) {
                if (line.trim() === `${READY_PREFIX}${this._readyToken}__`) this.ready = true;
                continue;
            }
            if (!this.pending) continue;
            if (this.profile.kind === 'powershell' && line.includes(this.pending.echoNeedle)) continue;
            const marker = `${DONE_PREFIX}${this.pending.token}__:`;
            const markerIndex = line.indexOf(marker);
            if (markerIndex >= 0) {
                const beforeMarker = line.slice(0, markerIndex);
                if (beforeMarker) this._emitText(beforeMarker);
                const [exitCodeRaw, cwdBase64] = line.slice(markerIndex + marker.length).trim().split(':', 2);
                const reportedCwd = decodeBase64(cwdBase64 || '');
                const nextCwd = reportedCwd && isWithin(this.root, path.resolve(reportedCwd)) ? path.resolve(reportedCwd) : this.root;
                if (nextCwd !== path.resolve(reportedCwd || this.root)) this._resetCwd();
                this.cwd = nextCwd;
                const parsedExitCode = Number(exitCodeRaw);
                this._finish({
                    exitCode: Number.isFinite(parsedExitCode) ? parsedExitCode : 1,
                    signal: this.pending.killed ? 'SIGINT' : null,
                    killed: this.pending.killed,
                });
                continue;
            }
            if (line.includes(DONE_PREFIX)) continue;
            this._emitText(`${line}\n`);
        }
    }

    _resetCwd() {
        if (this.profile.kind === 'powershell') {
            const encoded = Buffer.from(this.root, 'utf16le').toString('base64');
            this.proc.write(`Set-Location ([Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')))\r`);
            return;
        }
        const target = this.profile.isGitBash ? this.root.replace(/\\/g, '/') : this.root;
        const encoded = Buffer.from(`cd -- ${shellQuote(target)}`, 'utf8').toString('base64');
        this.proc.write(`eval "$(printf '%s' '${encoded}' | base64 -d)"\r`);
    }

    _commandScript(command, token) {
        if (this.profile.kind === 'powershell') {
            const encoded = Buffer.from(command, 'utf16le').toString('base64');
            return `$__deck_echo='${ECHO_PREFIX}${token}__'; $__deck_cmd=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encoded}')); Invoke-Expression $__deck_cmd; $__deck_ec=if($?){0}else{1}; $__deck_pwd=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path)); $__deck_done='__CODEX_DECK_'+'DONE_${token}__:'; Write-Output ($__deck_done+[string]$__deck_ec+':'+$__deck_pwd)\r`;
        }
        const encoded = Buffer.from(command, 'utf8').toString('base64');
        const pwd = this.profile.isGitBash ? 'pwd -W 2>/dev/null || pwd' : 'pwd';
        return `__deck_cmd=$(printf '%s' '${encoded}' | base64 -d); eval "$__deck_cmd"; __deck_ec=$?; __deck_pwd="$(${pwd})"; __deck_pwd_b64=$(printf '%s' "$__deck_pwd" | base64 | tr -d '\\r\\n'); printf '${DONE_PREFIX}${token}__:%s:%s\\n' "$__deck_ec" "$__deck_pwd_b64"\r`;
    }

    _interruptProbe(token) {
        if (this.profile.kind === 'powershell') {
            return `$__deck_echo='${ECHO_PREFIX}${token}__'; $__deck_pwd=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-Location).Path)); $__deck_done='__CODEX_DECK_'+'DONE_${token}__:130:'; Write-Output ($__deck_done+$__deck_pwd)\r`;
        }
        const pwd = this.profile.isGitBash ? 'pwd -W 2>/dev/null || pwd' : 'pwd';
        return `__deck_pwd="$(${pwd})"; __deck_pwd_b64=$(printf '%s' "$__deck_pwd" | base64 | tr -d '\\r\\n'); printf '${DONE_PREFIX}${token}__:130:%s\\n' "$__deck_pwd_b64"\r`;
    }

    async execute(command, { timeout = 60000, onEvent } = {}) {
        if (this.dead) return Promise.reject(new Error('Shell session is no longer running'));
        if (this.pending || this.starting) return Promise.reject(new Error('Shell session is busy'));
        if (typeof command !== 'string' || !command.trim()) return Promise.reject(new Error('Command is required'));
        this._touch();
        this.starting = true;
        try {
            await this.waitUntilReady();
        } catch (error) {
            this.starting = false;
            throw error;
        }
        const token = crypto.randomBytes(12).toString('hex');
        const procId = `pty-${this.id}-${token}`;
        const startedAt = Date.now();

        return new Promise((resolve, reject) => {
            if (this.dead) {
                this.starting = false;
                reject(new Error('Shell session is no longer running'));
                return;
            }
            this.pending = {
                token,
                procId,
                command,
                echoNeedle: `${ECHO_PREFIX}${token}__`,
                startedAt,
                stdout: '',
                truncated: false,
                killed: false,
                onEvent,
                resolve,
                reject,
            };
            this.starting = false;
            onEvent?.({ type: 'start', procId, sessionId: this.id, cwd: this.cwd, shell: this.profile.label });
            const boundedTimeout = Math.min(Math.max(Number(timeout) || 60000, 1000), 120000);
            this.pending.timer = setTimeout(() => this.interrupt(procId), boundedTimeout);
            this.proc.write(this._commandScript(command.trim(), token));
        });
    }

    _finish({ exitCode, signal, killed, error }) {
        const pending = this.pending;
        if (!pending) return;
        clearTimeout(pending.timer);
        clearTimeout(pending.probeTimer);
        clearTimeout(pending.interruptTimer);
        this.pending = null;
        this._touch();
        const result = {
            exitCode: Number(exitCode) || 0,
            signal: signal || null,
            stdout: pending.stdout,
            stderr: '',
            truncated: pending.truncated,
            killed: Boolean(killed),
            cwd: this.cwd,
            duration: Date.now() - pending.startedAt,
            procId: pending.procId,
            sessionId: this.id,
            shell: this.profile.label,
        };
        if (error) result.error = error;
        pending.resolve(result);
    }

    interrupt(procId) {
        if (!this.pending || this.pending.procId !== procId) return false;
        if (this.pending.killed) return true;
        this.pending.killed = true;
        this.proc.write('\x03');
        const token = this.pending.token;
        this.pending.probeTimer = setTimeout(() => {
            if (this.pending?.procId === procId) this.proc.write(this._interruptProbe(token));
        }, 250);
        this.pending.probeTimer.unref?.();
        this.pending.interruptTimer = setTimeout(() => {
            if (this.pending?.procId === procId) {
                this._finish({ exitCode: 130, signal: 'SIGINT', killed: true, error: 'Command did not stop; shell session was closed' });
                this.close();
            }
        }, 2000);
        this.pending.interruptTimer.unref?.();
        return true;
    }

    close() {
        clearTimeout(this.idleTimer);
        const wasPending = Boolean(this.pending);
        if (this.pending) this._finish({ exitCode: 130, signal: 'SIGTERM', killed: true, error: 'Shell session closed' });
        if (!this.dead) {
            if (this.profile.kind === 'powershell') {
                if (wasPending) {
                    try { this.proc.write('\x03'); } catch { }
                }
                const exitTimer = setTimeout(() => {
                    if (!this.exited) {
                        try { this.proc.write('exit\r'); } catch { }
                    }
                }, wasPending ? 100 : 0);
                exitTimer.unref?.();
                const killTimer = setTimeout(() => {
                    if (!this.exited) {
                        try { this.proc.kill(); } catch { }
                    }
                }, 1500);
                killTimer.unref?.();
            } else {
                try { this.proc.kill(); } catch { }
            }
        }
        this.dead = true;
    }
}

class ShellSessionManager {
    constructor(options = {}) {
        this.sessions = new Map();
        this.profile = options.profile || shellProfile();
        this.idleMs = options.idleMs || DEFAULT_IDLE_MS;
    }

    create({ workspaceId, root, resumeSessionId }) {
        if (resumeSessionId) {
            const existing = this.sessions.get(resumeSessionId);
            if (existing && !existing.dead && existing.workspaceId === workspaceId && existing.root === root) {
                existing._touch();
                return existing;
            }
        }
        const id = crypto.randomBytes(18).toString('base64url');
        const session = new ShellSession({
            id,
            workspaceId,
            root,
            profile: this.profile,
            idleMs: this.idleMs,
            onIdle: (sessionId) => this.close(sessionId),
        });
        this.sessions.set(id, session);
        return session;
    }

    get(sessionId, workspaceId) {
        const session = this.sessions.get(String(sessionId || ''));
        if (!session || session.dead) throw new Error('Shell session was not found');
        if (workspaceId && session.workspaceId !== workspaceId) throw new Error('Shell session belongs to another workspace');
        session._touch();
        return session;
    }

    interrupt(procId) {
        for (const session of this.sessions.values()) {
            if (session.interrupt(procId)) return true;
        }
        return false;
    }

    close(sessionId) {
        const session = this.sessions.get(String(sessionId || ''));
        if (!session) return false;
        session.close();
        this.sessions.delete(session.id);
        return true;
    }

    closeAll() {
        for (const session of this.sessions.values()) session.close();
        this.sessions.clear();
    }
}

module.exports = {
    ShellSessionManager,
    shellProfile,
    stripTerminalControls,
};
