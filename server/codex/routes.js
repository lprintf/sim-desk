function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function setupCodexRoutes(app, { client, workspaces }) {
    app.get('/api/codex/status', asyncRoute(async (_req, res) => {
        try {
            await client.start();
            const account = await client.request('account/read', { refreshToken: false });
            res.json({ running: true, account: account?.account || null });
        } catch (error) {
            res.status(503).json({ running: false, error: error.message });
        }
    }));

    app.get('/api/codex/workspaces', (_req, res) => {
        res.json({ data: workspaces.list(), roots: workspaces.roots });
    });

    app.get('/api/codex/models', asyncRoute(async (_req, res) => {
        const result = await client.request('model/list', { limit: 100, includeHidden: false });
        res.json(result);
    }));

    app.get('/api/codex/threads', asyncRoute(async (req, res) => {
        const cwd = workspaces.resolve(req.query.cwd);
        const result = await client.request('thread/list', {
            limit: 100,
            sortKey: 'updated_at',
            sortDirection: 'desc',
            cwd,
        });
        res.json(result);
    }));

    app.get('/api/codex/threads/:threadId', asyncRoute(async (req, res) => {
        const result = await client.request('thread/read', {
            threadId: req.params.threadId,
            includeTurns: true,
        });
        workspaces.resolve(result.thread.cwd);
        res.json(result);
    }));

    app.post('/api/codex/threads', asyncRoute(async (req, res) => {
        const cwd = workspaces.resolve(req.body.cwd);
        const params = {
            cwd,
            sandbox: req.body.sandbox || process.env.CODEX_SANDBOX || 'workspace-write',
            approvalPolicy: req.body.approvalPolicy || process.env.CODEX_APPROVAL_POLICY || 'on-request',
        };
        if (req.body.model) params.model = req.body.model;

        const result = await client.request('thread/start', params);
        client.loadedThreads.add(result.thread.id);
        res.status(201).json(result);
    }));

    app.post('/api/codex/threads/:threadId/turns', asyncRoute(async (req, res) => {
        const text = typeof req.body.text === 'string' ? req.body.text.trim() : '';
        if (!text) return res.status(400).json({ error: 'Message text is required' });
        if (text.length > 100000) return res.status(413).json({ error: 'Message is too large' });

        await client.ensureThreadLoaded(req.params.threadId);
        const result = await client.request('turn/start', {
            threadId: req.params.threadId,
            input: [{ type: 'text', text, text_elements: [] }],
        });
        res.status(201).json(result);
    }));

    app.post('/api/codex/threads/:threadId/archive', asyncRoute(async (req, res) => {
        const current = await client.request('thread/read', {
            threadId: req.params.threadId,
            includeTurns: false,
        });
        workspaces.resolve(current.thread.cwd);
        await client.request('thread/archive', { threadId: req.params.threadId });
        client.loadedThreads.delete(req.params.threadId);
        res.status(204).end();
    }));

    app.post('/api/codex/threads/:threadId/turns/:turnId/interrupt', asyncRoute(async (req, res) => {
        await client.request('turn/interrupt', {
            threadId: req.params.threadId,
            turnId: req.params.turnId,
        });
        res.status(204).end();
    }));

    app.post('/api/codex/approvals/:requestId', (req, res, next) => {
        try {
            const request = client.serverRequests.get(String(req.params.requestId));
            if (!request) return res.status(404).json({ error: 'Approval request is no longer pending' });
            const allowed = new Set(['accept', 'acceptForSession', 'decline', 'cancel']);
            const decision = req.body.decision;
            if (!allowed.has(decision)) return res.status(400).json({ error: 'Invalid approval decision' });
            if (!['item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(request.method)) {
                return res.status(400).json({ error: `Unsupported request type: ${request.method}` });
            }
            client.respondToServerRequest(req.params.requestId, { decision });
            res.status(204).end();
        } catch (error) {
            next(error);
        }
    });
}

function setupCodexWebSocket(wss, { client, authenticate }) {
    const sockets = new Set();
    const broadcast = (payload) => {
        const encoded = JSON.stringify(payload);
        for (const socket of sockets) {
            if (socket.readyState === 1) socket.send(encoded);
        }
    };

    client.on('notification', (event) => broadcast({ type: 'codex-event', event }));
    client.on('serverRequest', (request) => broadcast({ type: 'codex-request', request }));
    client.on('serverRequestResolved', ({ requestId }) => broadcast({ type: 'codex-request-resolved', requestId }));
    client.on('state', (state) => broadcast({ type: 'codex-state', state }));

    wss.on('connection', (socket, req) => {
        if (!authenticate(req)) {
            socket.close(1008, 'Unauthorized');
            return;
        }
        sockets.add(socket);
        socket.send(JSON.stringify({
            type: 'connected',
            state: { running: client.running, error: client.lastError },
            pendingRequests: client.getPendingServerRequests(),
        }));
        socket.on('close', () => sockets.delete(socket));
        socket.on('error', () => sockets.delete(socket));
    });
}

module.exports = { setupCodexRoutes, setupCodexWebSocket };
