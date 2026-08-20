const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

function isWithin(root, candidate) {
    const relative = path.relative(root, candidate);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

class WorkspaceStore {
    constructor(projectDir) {
        const configured = process.env.CODEX_WORKSPACE_ROOTS || process.env.CODEX_WORKSPACE_ROOT || process.env.DECK_WORKSPACE_ROOT;
        const rawRoots = configured
            ? configured.split(path.delimiter).filter(Boolean)
            : [os.homedir()];

        this.roots = Array.from(new Set(rawRoots.map((root) => this._realDirectory(root))));
        this.statePath = process.env.CODEX_WORKSPACE_STATE_FILE || path.join(process.env.DECK_DATA_DIR || projectDir, 'codex-workspaces.json');
        this.activePaths = new Set();
        this.recentPaths = new Set();
        this._loadState();

        // Compose explicitly selects one initial location. Its children are
        // never scanned or pinned automatically.
        if (this.activePaths.size === 0) {
            const initialPath = process.env.SIM_DESK_INITIAL_WORKSPACE || projectDir;
            if (this._insideBoundary(initialPath)) {
                const workspacePath = this._realDirectory(initialPath);
                this.activePaths.add(this._key(workspacePath));
                this.recentPaths.add(this._key(workspacePath));
                this._saveState();
            }
        }
    }

    _key(value) {
        const resolved = path.resolve(value);
        return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }

    _insideBoundary(candidate) {
        const resolved = path.resolve(candidate);
        return this.roots.some((root) => isWithin(root, resolved));
    }

    _realDirectory(value) {
        const resolved = fs.realpathSync(path.resolve(value));
        if (!fs.statSync(resolved).isDirectory()) throw new Error(`Workspace root is not a directory: ${value}`);
        return resolved;
    }

    _workspaceDirectory(value) {
        const resolved = this._realDirectory(value);
        if (!this._insideBoundary(resolved)) throw new Error('Workspace is outside the configured root');
        return resolved;
    }

    _loadState() {
        try {
            if (!fs.existsSync(this.statePath)) return;
            const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
            for (const value of state.activePaths || []) {
                if (typeof value === 'string' && fs.existsSync(value) && this._insideBoundary(value)) {
                    this.activePaths.add(this._key(fs.realpathSync(value)));
                }
            }
            for (const value of state.recentPaths || []) {
                if (typeof value === 'string' && fs.existsSync(value) && this._insideBoundary(value)) {
                    this.recentPaths.add(this._key(fs.realpathSync(value)));
                }
            }
        } catch (error) {
            console.warn(`[Sim Desk] Could not read workspace state: ${error.message}`);
        }
    }

    _saveState() {
        fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
        const state = {
            version: 2,
            activePaths: Array.from(this.activePaths).sort(),
            recentPaths: Array.from(this.recentPaths).sort(),
        };
        fs.writeFileSync(this.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    }

    _items(paths) {
        const items = [];
        for (const storedPath of paths) {
            try {
                const workspacePath = this._workspaceDirectory(storedPath);
                items.push(this._describe(workspacePath));
            } catch { /* stale paths disappear from the UI */ }
        }
        return items.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
    }

    list() {
        return this._items(this.activePaths);
    }

    available() {
        return this._items(new Set([...this.recentPaths, ...this.activePaths]));
    }

    remember(paths) {
        let changed = false;
        for (const candidate of paths) {
            if (typeof candidate !== 'string' || !candidate) continue;
            try {
                const workspacePath = this._workspaceDirectory(candidate);
                const key = this._key(workspacePath);
                if (!this.recentPaths.has(key)) {
                    this.recentPaths.add(key);
                    changed = true;
                }
            } catch { /* ignore Codex history outside configured roots */ }
        }
        if (changed) this._saveState();
        return this.available();
    }

    activate(identifier) {
        let workspace = this._find(this.available(), identifier);
        if (!workspace && typeof identifier === 'string') {
            workspace = this._describe(this._workspaceDirectory(identifier));
        }
        if (!workspace) throw new Error('Unknown workspace');
        this.activePaths.add(this._key(workspace.path));
        this.recentPaths.add(this._key(workspace.path));
        this._saveState();
        return workspace;
    }

    remove(identifier) {
        const workspace = this._find(this.list(), identifier);
        if (!workspace) throw new Error('Unknown workspace');
        this.activePaths.delete(this._key(workspace.path));
        this.recentPaths.add(this._key(workspace.path));
        this._saveState();
        return workspace;
    }

    resolve(candidate) {
        if (!candidate || typeof candidate !== 'string') throw new Error('A workspace is required');
        const resolved = this._workspaceDirectory(candidate);
        const allowed = this.activePaths.has(this._key(resolved));
        if (!allowed) throw new Error('Workspace is not pinned in Sim Desk');
        return resolved;
    }

    resolveId(id) {
        const workspace = this._find(this.list(), id);
        if (!workspace) throw new Error('Unknown workspace');
        return workspace.path;
    }

    _find(items, identifier) {
        const raw = String(identifier);
        const normalizedPath = this._key(raw);
        const normalizedText = process.platform === 'win32' ? raw.toLowerCase() : raw;
        const matches = items.filter((item) => {
            if (this._key(item.path) === normalizedPath) return true;
            return [item.id, item.name, item.relativePath].some((value) => {
                const candidate = process.platform === 'win32' ? value.toLowerCase() : value;
                return candidate === normalizedText;
            });
        });
        if (matches.length > 1) throw new Error('Workspace name is ambiguous; use its relative path or stable ID');
        return matches[0] || null;
    }

    _describe(workspacePath) {
        const matchingRoots = this.roots.filter((root) => isWithin(root, workspacePath)).sort((a, b) => b.length - a.length);
        const root = matchingRoots[0];
        const relative = path.relative(root, workspacePath);
        const relativePath = relative || path.basename(workspacePath);
        return {
            id: crypto.createHash('sha256').update(this._key(workspacePath)).digest('base64url').slice(0, 16),
            name: path.basename(workspacePath),
            relativePath,
            depth: relative ? relative.split(path.sep).length - 1 : 0,
            parentPath: relative ? path.dirname(workspacePath) : null,
            root,
            path: workspacePath,
            git: fs.existsSync(path.join(workspacePath, '.git')),
        };
    }
}

module.exports = { WorkspaceStore, isWithin };
