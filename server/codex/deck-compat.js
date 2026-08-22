const fs = require('fs');
const path = require('path');
const { isWithin } = require('./workspace-store');
const { SessionActivityTracker } = require('./session-activity');

function asyncRoute(handler) {
    return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function asIso(value) {
    if (!value) return '';
    const numeric = Number(value);
    const millis = numeric > 0 && numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(millis).toISOString();
}

function summaryOf(thread, activityTracker) {
    const activity = activityTracker.inspect(thread);
    const threadTime = Number(thread.updatedAt || thread.createdAt || 0);
    const threadMillis = threadTime > 0 && threadTime < 10_000_000_000 ? threadTime * 1000 : threadTime;
    return {
        summary: thread.name || thread.preview || 'Untitled',
        stepCount: (thread.turns || []).reduce((count, turn) => count + (turn.items?.length || 0), 0),
        status: activity.status,
        createdTime: asIso(thread.createdAt),
        lastModifiedTime: asIso(Math.max(threadMillis || 0, activity.lastActivityAt || 0)),
    };
}

function workspaceRecord(workspace) {
    return {
        pid: workspace.id,
        workspaceId: workspace.id,
        workspaceName: workspace.relativePath,
        workspaceDisplayName: workspace.name,
        workspaceRelativePath: workspace.relativePath,
        workspaceFolderUri: workspace.path,
        depth: workspace.depth,
        category: 'workspace',
        port: 0,
        headless: false,
    };
}

function imageInput(image) {
    if (!image?.mimeType || !image?.inlineData) return null;
    return { type: 'image', url: `data:${image.mimeType};base64,${image.inlineData}` };
}

function turnInput(message, images) {
    const input = [];
    if (typeof message === 'string' && message.trim()) {
        input.push({ type: 'text', text: message.trim(), text_elements: [] });
    }
    for (const image of images || []) {
        const mapped = imageInput(image);
        if (mapped) input.push(mapped);
    }
    if (input.length === 0) throw new Error('A message or image is required');
    return input;
}

function setupDeckCompatRoutes(app, { client, workspaces, runtimeSettings }) {
    let threadCache = { loadedAt: 0, data: [] };
    const activityTracker = new SessionActivityTracker();

    const allThreads = async (force = false) => {
        if (!force && Date.now() - threadCache.loadedAt < 2000) return threadCache.data;
        const data = [];
        let cursor;
        for (let page = 0; page < 10; page += 1) {
            const params = { limit: 100, sortKey: 'updated_at', sortDirection: 'desc' };
            if (cursor) params.cursor = cursor;
            const result = await client.request('thread/list', params);
            data.push(...(result.data || []).map((thread) => client.decorateThread(thread)));
            cursor = result.nextCursor;
            if (!cursor) break;
        }
        workspaces.remember(data.map((thread) => thread.cwd));
        threadCache = { loadedAt: Date.now(), data };
        return data;
    };

    client.on('notification', (event) => {
        if (['thread/started', 'thread/name/updated', 'thread/status/changed', 'turn/started', 'turn/completed'].includes(event.method)) {
            threadCache.loadedAt = 0;
        }
        if (event.params?.thread?.cwd) workspaces.remember([event.params.thread.cwd]);
    });

    const resolveWorkspace = (value) => {
        if (!value) return workspaces.list()[0];
        const workspacePath = workspaces.resolveId(value);
        return workspaces.list().find((item) => item.path === workspacePath);
    };

    const readThread = async (threadId, includeTurns = true) => {
        const result = await client.request('thread/read', { threadId, includeTurns });
        workspaces.resolve(result.thread.cwd);
        return client.decorateThread(result.thread);
    };

    const listThreads = async (workspace) => {
        const target = process.platform === 'win32' ? workspace.path.toLowerCase() : workspace.path;
        return (await allThreads()).filter((thread) => {
            const cwd = process.platform === 'win32' ? thread.cwd?.toLowerCase() : thread.cwd;
            return cwd === target;
        });
    };

    app.get('/api/workspaces', asyncRoute(async (_req, res) => {
        await allThreads();
        res.json(workspaces.list().map(workspaceRecord));
    }));

    app.get('/api/workspaces/folders', asyncRoute(async (_req, res) => {
        await allThreads();
        const openPaths = new Set(workspaces.list().map((item) => item.path));
        const folders = workspaces.available().map((workspace) => ({
            name: workspace.relativePath,
            displayName: workspace.name,
            path: workspace.path,
            uri: workspace.path,
            open: openPaths.has(workspace.path),
            wsName: openPaths.has(workspace.path) ? workspace.relativePath : null,
        }));
        res.json({ root: workspaces.roots[0], folders });
    }));

    const createWorkspace = (req, res) => {
        const root = workspaces.roots[0];
        const requestedPath = typeof req.body.path === 'string' ? req.body.path.trim() : '';
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        if (!requestedPath && !name) return res.status(400).json({ error: 'Workspace name or path is required' });
        if (name && (!/^[^\\/:*?"<>|]{1,100}$/.test(name) || name === '.' || name === '..')) {
            return res.status(400).json({ error: 'Invalid workspace name' });
        }
        const candidate = path.resolve(requestedPath || path.join(root, name));
        if (!isWithin(root, candidate)) return res.status(400).json({ error: 'Workspace must be inside the configured root' });
        const existed = fs.existsSync(candidate);
        if (!existed) fs.mkdirSync(candidate, { recursive: false });
        const real = fs.realpathSync(candidate);
        if (!isWithin(root, real)) throw new Error('Workspace is outside the configured root');
        const workspace = workspaces.activate(real);
        res.status(existed ? 200 : 201).json({
            created: !existed,
            alreadyOpen: existed,
            workspace: workspaceRecord(workspace),
            message: existed ? 'Workspace already exists' : 'Workspace created',
        });
    };

    app.post('/api/workspaces/create', createWorkspace);
    app.post('/api/workspaces/create-headless', createWorkspace);

    app.delete('/api/workspaces/:workspaceName', (req, res) => {
        const workspace = workspaces.remove(req.params.workspaceName);
        res.json({
            removed: true,
            filesDeleted: false,
            workspace: workspaceRecord(workspace),
        });
    });

    app.get('/api/workspaces/:workspaceName/conversations', asyncRoute(async (req, res) => {
        const workspace = resolveWorkspace(req.params.workspaceName);
        const threads = await listThreads(workspace);
        const trajectorySummaries = Object.fromEntries(threads.map((thread) => [thread.id, summaryOf(thread, activityTracker)]));
        res.json({ trajectorySummaries });
    }));

    app.get('/api/conversations', asyncRoute(async (_req, res) => {
        const trajectorySummaries = {};
        const active = new Set(workspaces.list().map((workspace) => process.platform === 'win32' ? workspace.path.toLowerCase() : workspace.path));
        for (const thread of await allThreads()) {
            const cwd = process.platform === 'win32' ? thread.cwd?.toLowerCase() : thread.cwd;
            if (active.has(cwd)) trajectorySummaries[thread.id] = summaryOf(thread, activityTracker);
        }
        res.json({ trajectorySummaries });
    }));

    app.get('/api/models', asyncRoute(async (_req, res) => {
        const result = await client.request('model/list', { limit: 100, includeHidden: false });
        const models = (result.data || []).map((model) => ({
            label: model.displayName || model.model || model.id,
            modelId: model.model || model.id,
            supportsImages: true,
            isRecommended: Boolean(model.isDefault),
            quota: 1,
        }));
        const preferred = runtimeSettings.defaultModel;
        const fallback = (result.data || []).find((model) => model.isDefault);
        res.json({ models, defaultModel: preferred || fallback?.model || fallback?.id || models[0]?.modelId || '' });
    }));

    app.get('/api/user/profile', asyncRoute(async (_req, res) => {
        const result = await client.request('account/read', { refreshToken: false });
        const account = result?.account || {};
        const name = account.name || account.email || account.type || 'Codex';
        res.json({
            user: { name, email: account.email || '', userTier: { name: account.planType || account.type || 'Codex CLI' } },
            profilePicture: null,
            account,
        });
    }));

    app.post('/api/file/read', (req, res) => {
        const requested = typeof req.body.path === 'string' ? req.body.path : '';
        if (!requested) return res.status(400).json({ error: 'File path is required' });
        const candidates = path.isAbsolute(requested)
            ? [path.resolve(requested)]
            : workspaces.list().map((workspace) => path.resolve(workspace.path, requested));
        for (const candidate of candidates) {
            const workspace = workspaces.list().find((item) => isWithin(item.path, candidate));
            if (!workspace || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
            const real = fs.realpathSync(candidate);
            if (!isWithin(workspace.path, real)) continue;
            const size = fs.statSync(real).size;
            if (size > 4 * 1024 * 1024) return res.status(413).json({ error: 'File is too large to preview' });
            return res.json({ path: real, content: fs.readFileSync(real, 'utf8') });
        }
        return res.status(404).json({ error: 'File was not found in an allowed workspace' });
    });

    app.post('/api/media/save', (_req, res) => res.json({}));

    app.post('/api/cascade/submit', asyncRoute(async (req, res) => {
        const workspace = resolveWorkspace(req.body.workspace);
        const params = {
            cwd: workspace.path,
            sandbox: process.env.CODEX_SANDBOX || 'workspace-write',
            approvalPolicy: runtimeSettings.autoAccept ? 'never' : (process.env.CODEX_APPROVAL_POLICY || 'on-request'),
        };
        if (req.body.modelId) params.model = req.body.modelId;
        const started = await client.request('thread/start', params);
        client.loadedThreads.add(started.thread.id);
        const result = await client.request('turn/start', {
            threadId: started.thread.id,
            input: turnInput(req.body.message, req.body.images),
        });
        res.status(201).json({ cascadeId: started.thread.id, result: { status: 200, data: JSON.stringify(result.turn) } });
    }));

    app.post('/api/cascade/send', asyncRoute(async (req, res) => {
        const thread = await readThread(req.body.cascadeId, false);
        await client.ensureThreadLoaded(thread.id);
        const result = await client.request('turn/start', {
            threadId: thread.id,
            input: turnInput(req.body.message, req.body.images),
        });
        res.json({ status: 200, data: JSON.stringify(result.turn) });
    }));

    app.get('/api/cascade/:threadId/status', asyncRoute(async (req, res) => {
        const thread = await readThread(req.params.threadId, true);
        res.json({ cascadeId: thread.id, ...summaryOf(thread, activityTracker) });
    }));

    app.get('/api/cascade/:threadId/metadata', asyncRoute(async (req, res) => {
        await readThread(req.params.threadId, false);
        res.json({ generatorMetadata: [] });
    }));

    app.post('/api/cascade/:threadId/cancel', asyncRoute(async (req, res) => {
        const thread = await readThread(req.params.threadId, true);
        const active = [...(thread.turns || [])].reverse().find((turn) => turn.status === 'inProgress');
        if (!active) return res.json({ cancelled: false, reason: 'No active turn' });
        await client.request('turn/interrupt', { threadId: thread.id, turnId: active.id });
        res.json({ cancelled: true });
    }));

    app.post('/api/cascade/:threadId/accept', asyncRoute(async (req, res) => {
        await readThread(req.params.threadId, false);
        const decision = req.body.action === 'reject' ? 'decline' : 'accept';
        const pending = client.getPendingServerRequests().filter((request) => request.params?.threadId === req.params.threadId);
        for (const request of pending) client.respondToServerRequest(request.requestId, { decision });
        res.json({ resolved: pending.length, decision });
    }));

    app.delete('/api/cascade/:threadId', asyncRoute(async (req, res) => {
        const thread = await readThread(req.params.threadId, false);
        const workspace = resolveWorkspace(thread.cwd);
        await client.request('thread/archive', { threadId: thread.id });
        client.loadedThreads.delete(thread.id);
        res.json({ deleted: true, workspace: workspaceRecord(workspace) });
    }));

    app.get('/api/codex/approvals', (_req, res) => res.json({ data: client.getPendingServerRequests() }));

    app.get('/api/auto-accept', (_req, res) => res.json({ enabled: runtimeSettings.autoAccept }));
    app.post('/api/auto-accept', (req, res) => {
        runtimeSettings.autoAccept = Boolean(req.body.enabled);
        res.json({ enabled: runtimeSettings.autoAccept });
    });
    app.get('/api/auto-continue', (_req, res) => res.json({ enabled: runtimeSettings.autoContinue }));
    app.post('/api/auto-continue', (req, res) => {
        runtimeSettings.autoContinue = Boolean(req.body.enabled);
        res.json({ enabled: runtimeSettings.autoContinue });
    });

    app.get('/api/workflows', (_req, res) => res.json([]));
    app.get('/api/workflows/:name', (req, res) => res.status(404).json({ error: `Unknown command: ${req.params.name}` }));
    app.delete('/api/cache/:threadId', (_req, res) => res.json({ cleared: true }));
    app.get('/api/conversations/:threadId/steps/older', (_req, res) => res.json({ steps: [], baseIndex: 0, hasMore: false }));
}

module.exports = { setupDeckCompatRoutes };
