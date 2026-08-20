const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const { isWithin } = require('./workspace-store');
const { ShellSessionManager } = require('./shell-session-manager');

const execFileAsync = promisify(execFile);

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function validateRelative(workspaces, workspaceId, relativePath = '') {
    const root = workspaces.resolveId(workspaceId);
    if (typeof relativePath !== 'string' || relativePath.includes('\0') || path.isAbsolute(relativePath)) {
        throw new Error('Invalid workspace path');
    }
    const segments = relativePath.split(/[/\\]/);
    if (segments.some((segment) => segment === '..')) throw new Error('Path traversal is not allowed');

    const candidate = path.resolve(root, relativePath || '.');
    if (!isWithin(root, candidate)) throw new Error('Path is outside the workspace');
    return { root, path: candidate };
}

function resolveRelative(workspaces, workspaceId, relativePath = '') {
    const validated = validateRelative(workspaces, workspaceId, relativePath);
    const { root } = validated;
    const candidate = validated.path;
    const real = fs.realpathSync(candidate);
    if (!isWithin(root, real)) throw new Error('Resolved path is outside the workspace');
    return { root, path: real };
}

function runGit(args, cwd) {
    return new Promise((resolve, reject) => {
        const child = spawn('git', args, { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const max = 10 * 1024 * 1024;
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (chunk) => {
            stdout += chunk;
            if (stdout.length > max) child.kill();
        });
        child.stderr.on('data', (chunk) => { stderr += chunk; });
        child.on('error', () => reject(new Error('Git is not available')));
        child.on('close', (code) => {
            if (stdout.length > max) return reject(new Error('Git output is too large'));
            if (code !== 0) {
                const error = new Error('Git command failed');
                error.stderr = stderr;
                return reject(error);
            }
            resolve(stdout);
        });
    });
}

function shellSpec(command, profile) {
    if (profile.kind === 'powershell') {
        return { executable: profile.executable, args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] };
    }
    if (profile.kind === 'wsl') return { executable: profile.executable, args: ['--', 'bash', '-lc', command] };
    return { executable: profile.executable, args: ['-lc', command] };
}

function spawnShell(command, cwd, profile) {
    const spec = shellSpec(command, profile);
    return spawn(spec.executable, spec.args, {
        cwd,
        windowsHide: true,
        env: { ...process.env, TERM: 'dumb', COLUMNS: '200' },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

class ResourceSampler {
    constructor(client) {
        this.client = client;
        this.previousCpu = this._cpuTimes();
        this.previousUsage = process.cpuUsage();
        this.previousAt = Date.now();
        this.processSamples = new Map();
        this.history = [];
    }

    _cpuTimes() {
        return os.cpus().reduce((totals, cpu) => {
            for (const [key, value] of Object.entries(cpu.times)) totals[key] = (totals[key] || 0) + value;
            return totals;
        }, {});
    }

    _systemCpu() {
        const current = this._cpuTimes();
        const previous = this.previousCpu;
        this.previousCpu = current;
        const total = Object.values(current).reduce((sum, value) => sum + value, 0) - Object.values(previous).reduce((sum, value) => sum + value, 0);
        const idle = current.idle - previous.idle;
        return total > 0 ? Math.max(0, Math.min(100, ((total - idle) / total) * 100)) : 0;
    }

    _backendCpu() {
        const now = Date.now();
        const usage = process.cpuUsage();
        const elapsedMicros = Math.max((now - this.previousAt) * 1000, 1);
        const usedMicros = (usage.user - this.previousUsage.user) + (usage.system - this.previousUsage.system);
        this.previousUsage = usage;
        this.previousAt = now;
        return Math.max(0, Math.min(100, (usedMicros / elapsedMicros) * 100 / Math.max(os.cpus().length, 1)));
    }

    async _childStats(pid) {
        if (!pid) return { cpuPercent: 0, memMB: 0 };
        try {
            if (process.platform === 'win32') {
                const script = `$p=Get-Process -Id ${Number(pid)} -ErrorAction Stop; @($p.CPU,$p.WorkingSet64) -join ','`;
                const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 3000, windowsHide: true });
                const [cpuSeconds, memBytes] = stdout.trim().split(',').map(Number);
                const now = Date.now();
                const previous = this.processSamples.get(pid);
                this.processSamples.set(pid, { cpuSeconds, at: now });
                const cpuPercent = previous && now > previous.at
                    ? Math.max(0, ((cpuSeconds - previous.cpuSeconds) * 1000 / (now - previous.at)) * 100 / Math.max(os.cpus().length, 1))
                    : 0;
                return { cpuPercent, memMB: Math.round(memBytes / 1024 / 1024) };
            }
            const { stdout } = await execFileAsync('ps', ['-p', String(pid), '-o', '%cpu=,rss='], { timeout: 3000 });
            const [cpu, rss] = stdout.trim().split(/\s+/).map(Number);
            return { cpuPercent: cpu || 0, memMB: Math.round((rss || 0) / 1024) };
        } catch {
            return { cpuPercent: 0, memMB: 0 };
        }
    }

    async snapshot() {
        const cpuPercent = this._systemCpu();
        const total = os.totalmem();
        const used = total - os.freemem();
        const memPercent = total > 0 ? used / total * 100 : 0;
        const backend = {
            pid: process.pid,
            cpuPercent: this._backendCpu(),
            memMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        };
        const codexPid = this.client.proc?.pid || null;
        const codex = await this._childStats(codexPid);
        this.history.push({ t: Date.now(), cpu: cpuPercent, mem: memPercent });
        if (this.history.length > 60) this.history.shift();

        return {
            system: {
                cpuPercent,
                memUsedMB: Math.round(used / 1024 / 1024),
                memTotalMB: Math.round(total / 1024 / 1024),
                memPercent,
                cpuCores: os.cpus().length,
            },
            selfStats: {
                backend,
                frontend: { pid: null, cpuPercent: 0, memMB: 0 },
                totalCpuPercent: backend.cpuPercent + codex.cpuPercent,
                totalMemMB: backend.memMB + codex.memMB,
            },
            workspaces: codexPid ? {
                [String(codexPid)]: {
                    cpuPercent: codex.cpuPercent,
                    memBytes: codex.memMB * 1024 * 1024,
                    memMB: codex.memMB,
                    name: 'Codex App Server',
                    headless: false,
                },
            } : {},
            history: this.history,
        };
    }
}

function setupWorkspaceToolsRoutes(app, { workspaces, client, shellProfile }) {
    const running = new Map();
    const shellSessions = new ShellSessionManager({ profile: shellProfile });
    const dataRoot = process.env.DECK_DATA_DIR || path.join(os.homedir(), '.sim-desk');
    const historyRoot = path.join(dataRoot, 'shell-history');
    fs.mkdirSync(historyRoot, { recursive: true });
    const resources = new ResourceSampler(client);

    const historyKey = (workspaceId) => {
        const workspacePath = workspaces.resolveId(workspaceId);
        const workspace = workspaces.list().find((item) => item.path === workspacePath);
        if (!workspace) throw new Error('Unknown workspace');
        return workspace.id;
    };

    const historyDir = (workspaceId) => {
        const dir = path.join(historyRoot, historyKey(workspaceId));
        fs.mkdirSync(dir, { recursive: true });
        return dir;
    };

    const historyReference = (workspaceId, filename) => `.sim-desk/shell-history/${historyKey(workspaceId)}/${filename}`;

    const saveHistory = (workspaceId, command, result) => {
        const dir = historyDir(workspaceId);
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `${timestamp}_${command.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 36) || 'command'}.txt`;
        const content = `$ ${command}\n# cwd: ${result.cwd}\n# exit: ${result.exitCode}\n# duration: ${result.duration}ms\n# ---\n${result.stdout}${result.stderr ? `\n# STDERR:\n${result.stderr}` : ''}`;
        fs.writeFileSync(path.join(dir, filename), content, 'utf8');
        return filename;
    };

    app.get('/api/codex/workspaces/:workspaceId/fs/list', (req, res) => {
        const relative = typeof req.query.path === 'string' ? req.query.path : '';
        const resolved = resolveRelative(workspaces, req.params.workspaceId, relative);
        if (!fs.statSync(resolved.path).isDirectory()) return res.status(400).json({ error: 'Path is not a directory' });
        const showHidden = req.query.showHidden === 'true';
        const entries = fs.readdirSync(resolved.path, { withFileTypes: true })
            .filter((entry) => showHidden || !entry.name.startsWith('.'))
            .slice(0, 1000)
            .map((entry) => {
                const fullPath = path.join(resolved.path, entry.name);
                const stat = fs.statSync(fullPath);
                return {
                    name: entry.name,
                    type: entry.isDirectory() ? 'dir' : 'file',
                    size: entry.isFile() ? stat.size : undefined,
                    ext: entry.isFile() ? path.extname(entry.name).slice(1).toLowerCase() : undefined,
                };
            })
            .sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1);
        res.json({ entries, path: relative });
    });

    app.get('/api/codex/workspaces/:workspaceId/file/read', (req, res) => {
        const relative = typeof req.query.file === 'string' ? req.query.file : '';
        const resolved = resolveRelative(workspaces, req.params.workspaceId, relative);
        const stat = fs.statSync(resolved.path);
        if (!stat.isFile()) return res.status(400).json({ error: 'Path is not a file' });
        if (stat.size > 5 * 1024 * 1024) return res.status(413).json({ error: 'File is too large to preview' });
        const buffer = fs.readFileSync(resolved.path);
        if (buffer.subarray(0, 8192).includes(0)) return res.json({ content: null, path: relative, error: 'Binary file preview is not supported' });
        res.json({ content: buffer.toString('utf8'), path: relative });
    });

    app.get('/api/codex/workspaces/:workspaceId/git/status', asyncRoute(async (req, res) => {
        const cwd = workspaces.resolveId(req.params.workspaceId);
        try { await runGit(['rev-parse', '--is-inside-work-tree'], cwd); } catch { return res.json({ files: [], error: 'Not a Git repository' }); }
        const porcelain = String(await runGit(['status', '--porcelain'], cwd)).trimEnd();
        if (!porcelain) return res.json({ files: [] });
        const stats = new Map();
        try {
            const numstat = String(await runGit(['diff', '--numstat'], cwd));
            for (const line of numstat.split('\n')) {
                const [added, deleted, file] = line.split('\t');
                if (file) stats.set(file, { additions: Number(added) || 0, deletions: Number(deleted) || 0 });
            }
        } catch { }
        const statusNames = { M: 'modified', A: 'added', D: 'deleted', R: 'renamed', C: 'copied', '??': 'untracked' };
        const files = porcelain.split('\n').filter(Boolean).map((line) => {
            const code = line.slice(0, 2).trim() || '??';
            const rawPath = line.slice(3).trim();
            const filePath = rawPath.includes(' -> ') ? rawPath.split(' -> ').pop() : rawPath;
            const stat = stats.get(filePath) || { additions: 0, deletions: 0 };
            return { path: filePath, status: statusNames[code] || statusNames[code[0]] || code, statusCode: code, ...stat };
        });
        res.json({ files });
    }));

    app.get('/api/codex/workspaces/:workspaceId/git/diff', asyncRoute(async (req, res) => {
        const cwd = workspaces.resolveId(req.params.workspaceId);
        const file = typeof req.query.file === 'string' ? req.query.file : '';
        if (file) validateRelative(workspaces, req.params.workspaceId, file);
        const args = file ? ['diff', '--', file] : ['diff'];
        res.json({ diff: String(await runGit(args, cwd)) });
    }));

    app.get('/api/codex/workspaces/:workspaceId/git/show', asyncRoute(async (req, res) => {
        const cwd = workspaces.resolveId(req.params.workspaceId);
        const file = typeof req.query.file === 'string' ? req.query.file : '';
        if (!file) return res.status(400).json({ error: 'File is required' });
        validateRelative(workspaces, req.params.workspaceId, file);
        try {
            res.json({ content: String(await runGit(['show', `HEAD:${file}`], cwd)) });
        } catch (error) {
            if (/does not exist|exists on disk/i.test(error.stderr || '')) return res.json({ content: null, error: 'File is not present in HEAD' });
            throw error;
        }
    }));

    const executeOneShot = (req, res, streaming) => {
        const { command, workspace: workspaceId, timeout = streaming ? 60000 : 30000 } = req.body || {};
        if (typeof command !== 'string' || !command.trim()) return res.status(400).json({ error: 'Command is required' });
        if (command.length > 20000) return res.status(413).json({ error: 'Command is too large' });
        const cwd = workspaces.resolveId(workspaceId);
        const child = spawnShell(command, cwd, shellProfile);
        const procId = `proc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const startedAt = Date.now();
        const max = 256 * 1024;
        let stdout = '';
        let stderr = '';
        let truncated = false;
        let finished = false;
        running.set(procId, child);

        if (streaming) {
            res.status(200).set({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            res.flushHeaders();
            res.write(`data: ${JSON.stringify({ type: 'start', procId })}\n\n`);
        } else {
            res.setHeader('X-Shell-Proc-Id', procId);
        }

        const append = (kind, chunk) => {
            const text = chunk.toString();
            if (kind === 'stdout') stdout = (stdout + text).slice(0, max);
            else stderr = (stderr + text).slice(0, max);
            if (stdout.length >= max || stderr.length >= max) truncated = true;
            if (streaming && !res.writableEnded) res.write(`data: ${JSON.stringify({ type: kind, text })}\n\n`);
        };
        child.stdout.on('data', (chunk) => append('stdout', chunk));
        child.stderr.on('data', (chunk) => append('stderr', chunk));

        const timer = setTimeout(() => child.kill(), Math.min(Math.max(Number(timeout) || 30000, 1000), 120000));
        child.on('error', (error) => {
            clearTimeout(timer);
            finished = true;
            running.delete(procId);
            if (streaming && !res.writableEnded) {
                res.write(`data: ${JSON.stringify({ type: 'error', message: error.message })}\n\n`);
                res.end();
            } else if (!res.headersSent) res.status(500).json({ error: error.message });
        });
        child.on('close', (code, signal) => {
            clearTimeout(timer);
            if (finished) return;
            finished = true;
            running.delete(procId);
            const result = {
                exitCode: code ?? -1,
                signal: signal || null,
                stdout,
                stderr,
                truncated,
                killed: child.killed,
                cwd,
                duration: Date.now() - startedAt,
                procId,
            };
            result.outputFile = historyReference(workspaceId, saveHistory(workspaceId, command, result));
            if (streaming && !res.writableEnded) {
                res.write(`data: ${JSON.stringify({ type: 'done', ...result })}\n\n`);
                res.end();
            } else if (!res.headersSent) res.json(result);
        });
        res.on('close', () => {
            if (streaming && !finished && running.has(procId)) child.kill();
        });
    };

    app.post('/api/codex/shell/session', asyncRoute(async (req, res) => {
        const workspaceId = String(req.body?.workspace || '');
        const root = workspaces.resolveId(workspaceId);
        const session = shellSessions.create({
            workspaceId,
            root,
            resumeSessionId: req.body?.resumeSessionId,
        });
        try {
            await session.waitUntilReady();
        } catch (error) {
            shellSessions.close(session.id);
            throw error;
        }
        res.json(session.info());
    }));

    app.get('/api/codex/shell/session/:sessionId', (req, res) => {
        const workspaceId = String(req.query.workspace || '');
        workspaces.resolveId(workspaceId);
        res.json(shellSessions.get(req.params.sessionId, workspaceId).info());
    });

    app.delete('/api/codex/shell/session/:sessionId', (req, res) => {
        res.json({ closed: shellSessions.close(req.params.sessionId) });
    });

    const executePersistent = async (req, res, streaming) => {
        const { command, workspace: workspaceId, sessionId, timeout = streaming ? 60000 : 30000 } = req.body || {};
        if (typeof command !== 'string' || !command.trim()) return res.status(400).json({ error: 'Command is required' });
        if (command.length > 20000) return res.status(413).json({ error: 'Command is too large' });
        workspaces.resolveId(workspaceId);
        const session = shellSessions.get(sessionId, workspaceId);
        let finished = false;
        let activeProcId = null;

        if (streaming) {
            res.status(200).set({
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
            });
            res.flushHeaders();
        }

        res.on('close', () => {
            if (!finished && activeProcId) shellSessions.interrupt(activeProcId);
        });

        const result = await session.execute(command, {
            timeout,
            onEvent: (event) => {
                if (event.type === 'start') activeProcId = event.procId;
                if (streaming && !res.writableEnded) res.write(`data: ${JSON.stringify(event)}\n\n`);
            },
        });
        result.outputFile = historyReference(workspaceId, saveHistory(workspaceId, command, result));
        finished = true;
        if (streaming) {
            if (!res.writableEnded) {
                res.write(`data: ${JSON.stringify({ type: 'done', ...result })}\n\n`);
                res.end();
            }
        } else if (!res.headersSent) {
            res.json(result);
        }
    };

    app.post('/api/codex/shell/exec', asyncRoute(async (req, res) => {
        if (!req.body?.sessionId) return executeOneShot(req, res, false);
        return executePersistent(req, res, false);
    }));
    app.post('/api/codex/shell/exec/stream', asyncRoute(async (req, res) => {
        if (!req.body?.sessionId) return executeOneShot(req, res, true);
        return executePersistent(req, res, true);
    }));
    app.post('/api/codex/shell/kill', (req, res) => {
        if (shellSessions.interrupt(req.body?.procId)) return res.json({ killed: true });
        const child = running.get(req.body?.procId);
        if (!child) return res.json({ killed: false, error: 'Process is not running' });
        child.kill();
        running.delete(req.body.procId);
        res.json({ killed: true });
    });
    app.post('/api/codex/shell/complete', (req, res) => {
        const workspaceId = req.body?.workspace;
        const prefix = typeof req.body?.prefix === 'string' ? req.body.prefix : '';
        if (!prefix || path.isAbsolute(prefix) || prefix.split(/[/\\]/).includes('..')) return res.json({ completions: [] });
        try {
            const root = workspaces.resolveId(workspaceId);
            const directoryPart = path.dirname(prefix) === '.' ? '' : path.dirname(prefix);
            const basenamePart = path.basename(prefix).toLowerCase();
            const base = req.body?.sessionId ? shellSessions.get(req.body.sessionId, workspaceId).cwd : root;
            const candidate = path.resolve(base, directoryPart || '.');
            if (!isWithin(root, candidate)) return res.json({ completions: [] });
            const real = fs.realpathSync(candidate);
            if (!isWithin(root, real)) return res.json({ completions: [] });
            const completions = fs.readdirSync(real, { withFileTypes: true })
                .filter((entry) => entry.name.toLowerCase().startsWith(basenamePart))
                .slice(0, 20)
                .map((entry) => `${directoryPart ? `${directoryPart}/` : ''}${entry.name}${entry.isDirectory() ? '/' : ''}`);
            res.json({ completions, cwd: base });
        } catch { res.json({ completions: [] }); }
    });
    app.get('/api/codex/shell/history', (req, res) => {
        const workspaceId = String(req.query.workspace || '');
        const dir = historyDir(workspaceId);
        const cwd = workspaces.resolveId(workspaceId);
        const entries = fs.readdirSync(dir).filter((file) => file.endsWith('.txt')).sort().reverse().slice(0, 50).map((filename) => {
            const content = fs.readFileSync(path.join(dir, filename), 'utf8');
            const stat = fs.statSync(path.join(dir, filename));
            const lines = content.split('\n');
            return {
                filename,
                path: historyReference(workspaceId, filename),
                command: lines[0]?.replace(/^\$ /, '') || filename,
                exitCode: Number(lines.find((line) => line.startsWith('# exit:'))?.split(':')[1]) || 0,
                duration: Number(lines.find((line) => line.startsWith('# duration:'))?.match(/\d+/)?.[0]) || 0,
                size: stat.size,
                time: stat.mtime.toISOString(),
            };
        });
        res.json({ entries, cwd });
    });
    app.get('/api/codex/shell/history/:filename', (req, res) => {
        const workspaceId = String(req.query.workspace || '');
        const filename = req.params.filename;
        if (filename !== path.basename(filename) || !filename.endsWith('.txt')) return res.status(400).json({ error: 'Invalid filename' });
        const file = path.join(historyDir(workspaceId), filename);
        if (!fs.existsSync(file)) return res.status(404).json({ error: 'History entry not found' });
        res.json({ content: fs.readFileSync(file, 'utf8'), filename });
    });
    app.delete('/api/codex/shell/history', (req, res) => {
        const dir = historyDir(String(req.query.workspace || ''));
        const files = fs.readdirSync(dir).filter((file) => file.endsWith('.txt'));
        for (const file of files) fs.unlinkSync(path.join(dir, file));
        res.json({ cleared: files.length });
    });

    app.get('/api/codex/resources', asyncRoute(async (_req, res) => res.json(await resources.snapshot())));
    return shellSessions;
}

module.exports = { setupWorkspaceToolsRoutes, resolveRelative, validateRelative, ResourceSampler };
