const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const helmet = require('helmet');
const { rateLimit } = require('express-rate-limit');
const { WebSocketServer } = require('ws');
const { CodexAppServerClient } = require('./codex/app-server-client');
const { WorkspaceStore } = require('./codex/workspace-store');
const { setupCodexRoutes, setupCodexWebSocket } = require('./codex/routes');
const { setupWorkspaceToolsRoutes } = require('./codex/workspace-tools');
const { shellProfile } = require('./codex/shell-session-manager');
const { setupDeckCompatRoutes } = require('./codex/deck-compat');

const app = express();
const server = http.createServer(app);
const codexWss = new WebSocketServer({ noServer: true });
const portArgIndex = process.argv.indexOf('--port');
const PORT = Number(portArgIndex >= 0 ? process.argv[portArgIndex + 1] : process.env.PORT) || 3500;
const HOST = process.env.HOST || '0.0.0.0';
const noAuth = process.argv.includes('--no-auth');
const AUTH_KEY = noAuth ? '' : (process.env.AUTH_KEY || '');
const client = new CodexAppServerClient();
const workspaces = new WorkspaceStore(__dirname);
const deckShell = shellProfile();
const runtimeSettings = {
    defaultModel: process.env.CODEX_MODEL || '',
    autoAccept: false,
    autoContinue: true,
};

client.on('stderr', (line) => console.error(`[Codex app-server] ${line}`));
client.on('protocolError', ({ message, line }) => {
    console.error(`[Codex app-server protocol] ${message}: ${line}`);
});

function safeEqual(value, expected) {
    if (!value || !expected || value.length !== expected.length) return false;
    return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(expected));
}

function requestKey(req) {
    if (req.headers['x-auth-key']) return String(req.headers['x-auth-key']);
    try {
        return new URL(req.url, 'http://localhost').searchParams.get('auth_key') || '';
    } catch {
        return '';
    }
}

function authenticate(req) {
    return !AUTH_KEY || safeEqual(requestKey(req), AUTH_KEY);
}

app.disable('x-powered-by');
app.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 1));
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
            connectSrc: ["'self'", 'http://localhost:3500', 'ws://localhost:3500', 'http://127.0.0.1:3500', 'ws://127.0.0.1:3500'],
            objectSrc: ["'none'"],
            frameSrc: ["'none'"],
            upgradeInsecureRequests: null,
        },
    },
}));
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
        let allowed = false;
        try {
            const originUrl = new URL(origin);
            allowed = originUrl.host === req.headers.host ||
                ['http://localhost:3000', 'http://127.0.0.1:3000'].includes(origin);
        } catch { }
        if (allowed) {
            res.setHeader('Access-Control-Allow-Origin', origin);
            res.setHeader('Vary', 'Origin');
            res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Key');
            res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
        }
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
});

app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));
app.get('/api/status', (_req, res) => res.json({ service: 'sim-desk', codexRunning: client.running, detected: client.running, swapping: false }));
app.get('/api/healthz', (_req, res) => res.status(client.running ? 200 : 503).json({
    service: 'sim-desk',
    ready: client.running,
}));
app.get('/api/ws-url', (_req, res) => res.json({ wsPort: PORT }));
app.use('/api', (req, res, next) => {
    if (!AUTH_KEY || req.path === '/status' || req.path === '/ws-url') return next();
    if (!safeEqual(requestKey(req), AUTH_KEY)) return res.status(401).json({ error: 'Unauthorized' });
    next();
});
app.get('/api/settings', (_req, res) => res.json({
    workspaceRoots: workspaces.roots,
    defaultWorkspaceRoot: workspaces.roots[0] || '',
    defaultModel: runtimeSettings.defaultModel,
    sandbox: process.env.CODEX_SANDBOX || 'workspace-write',
    approvalPolicy: process.env.CODEX_APPROVAL_POLICY || 'on-request',
    authEnabled: Boolean(AUTH_KEY),
    host: HOST,
    port: PORT,
    shell: deckShell.label,
    shellExecutable: deckShell.executable,
}));
app.post('/api/settings', (req, res) => {
    if (typeof req.body.defaultModel === 'string') runtimeSettings.defaultModel = req.body.defaultModel;
    res.json({
        workspaceRoots: workspaces.roots,
        defaultWorkspaceRoot: workspaces.roots[0] || '',
        defaultModel: runtimeSettings.defaultModel,
        sandbox: process.env.CODEX_SANDBOX || 'workspace-write',
        approvalPolicy: runtimeSettings.autoAccept ? 'never' : (process.env.CODEX_APPROVAL_POLICY || 'on-request'),
        authEnabled: Boolean(AUTH_KEY),
        host: HOST,
        port: PORT,
        shell: deckShell.label,
        shellExecutable: deckShell.executable,
    });
});

setupCodexRoutes(app, { client, workspaces });
const shellSessions = setupWorkspaceToolsRoutes(app, { client, workspaces, shellProfile: deckShell });
setupDeckCompatRoutes(app, { client, workspaces, runtimeSettings });
setupCodexWebSocket(codexWss, { client, authenticate });

server.on('upgrade', (req, socket, head) => {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = ''; }
    if (pathname !== '/ws/codex') {
        socket.destroy();
        return;
    }
    codexWss.handleUpgrade(req, socket, head, (ws) => codexWss.emit('connection', ws, req));
});

const frontendPath = path.join(__dirname, '..', 'frontend', 'out');
if (fs.existsSync(frontendPath)) {
    app.use(express.static(frontendPath, {
        maxAge: '1h',
        setHeaders(res, filePath) {
            if (filePath.endsWith('.html') || filePath.endsWith('sw.js')) {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            }
        },
    }));
    app.get('*', (req, res) => {
        if (req.path.startsWith('/api') || req.path.startsWith('/ws')) return res.status(404).end();
        res.sendFile(path.join(frontendPath, 'index.html'));
    });
}

app.use((error, _req, res, _next) => {
    console.error('[Sim Desk]', error.message);
    const status = /allowlist|required|outside|unknown workspace|invalid|traversal|not a/i.test(error.message) ? 400 : 500;
    res.status(status).json({ error: error.message || 'Internal server error' });
});

server.listen(PORT, HOST, async () => {
    console.log(`Sim Desk listening on http://${HOST}:${PORT}`);
    console.log(`Workspace roots: ${workspaces.roots.join(', ')}`);
    console.log(AUTH_KEY ? 'Authentication enabled' : 'WARNING: authentication is disabled');
    console.log(`Codex executable: ${client.resolvedCommand}`);
    try {
        await client.start();
        console.log('Codex app-server ready');
    } catch (error) {
        console.error(`Codex app-server failed to start: ${error.message}`);
    }
});

function shutdown() {
    shellSessions.closeAll();
    client.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
