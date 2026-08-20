const fs = require('fs');
const os = require('os');
const path = require('path');
const { StringDecoder } = require('string_decoder');

const RUNNING = 'CASCADE_RUN_STATUS_RUNNING';
const WAITING = 'CASCADE_RUN_STATUS_WAITING_FOR_USER';
const COMPLETED = 'CASCADE_RUN_STATUS_COMPLETED';
const FAILED = 'CASCADE_RUN_STATUS_FAILED';
const CANCELLED = 'CASCADE_RUN_STATUS_CANCELLED';

const TERMINAL_EVENTS = new Set([
    'task_complete',
    'turn_aborted',
    'task_cancelled',
    'task_failed',
    'thread_rolled_back',
]);

function isWithin(root, target) {
    const relative = path.relative(root, target);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function statusText(value) {
    return String(value || '').replace(/[^a-z]/gi, '').toLowerCase();
}

function timestamp(value) {
    const millis = Date.parse(String(value || ''));
    return Number.isFinite(millis) ? millis : 0;
}

class SessionActivityTracker {
    constructor(options = {}) {
        const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
        this.sessionsRoot = path.resolve(options.sessionsRoot || path.join(codexHome, 'sessions'));
        const configuredStaleMs = Number(options.staleAfterMs ?? process.env.CODEX_ACTIVITY_STALE_MS);
        this.staleAfterMs = Number.isFinite(configuredStaleMs) && configuredStaleMs > 0
            ? configuredStaleMs
            : 10 * 60 * 1000;
        this.now = options.now || Date.now;
        this.files = new Map();
    }

    statusFor(thread) {
        return this.inspect(thread).status;
    }

    inspect(thread) {
        const nativeType = statusText(thread.status?.type);
        const activeFlags = Array.isArray(thread.status?.activeFlags)
            ? thread.status.activeFlags.map(statusText).join(' ')
            : '';
        const activity = this._readActivity(thread.path);
        const activityTime = activity
            ? (activity.active ? activity.mtimeMs : activity.lastLifecycleAt)
            : 0;

        if (nativeType.includes('active') || nativeType.includes('running') || nativeType.includes('inprogress')) {
            const status = activeFlags.includes('wait') || activeFlags.includes('approval') || activeFlags.includes('input')
                ? WAITING
                : RUNNING;
            return { status, lastActivityAt: activityTime };
        }

        if (activity?.active && this.now() - activity.mtimeMs <= this.staleAfterMs) {
            return { status: RUNNING, lastActivityAt: activityTime };
        }

        const lastTurn = thread.turns?.[thread.turns.length - 1];
        if (lastTurn?.status === 'inProgress') return { status: RUNNING, lastActivityAt: activityTime };
        if (lastTurn?.status === 'failed' || nativeType.includes('fail') || nativeType.includes('error')) {
            return { status: FAILED, lastActivityAt: activityTime };
        }
        if (lastTurn?.status === 'interrupted' || nativeType.includes('interrupt') || nativeType.includes('cancel')) {
            return { status: CANCELLED, lastActivityAt: activityTime };
        }
        return { status: COMPLETED, lastActivityAt: activityTime };
    }

    _readActivity(filePath) {
        if (typeof filePath !== 'string' || !filePath) return null;
        const target = path.resolve(filePath);
        if (!isWithin(this.sessionsRoot, target)) return null;

        let stat;
        try {
            stat = fs.statSync(target);
            if (!stat.isFile()) return null;
        } catch {
            return null;
        }

        const key = process.platform === 'win32' ? target.toLowerCase() : target;
        let entry = this.files.get(key);
        if (!entry || stat.size < entry.offset) {
            entry = {
                offset: 0,
                remainder: '',
                decoder: new StringDecoder('utf8'),
                active: false,
                activeTurnId: null,
                lastLifecycleAt: 0,
                mtimeMs: stat.mtimeMs,
            };
            this.files.set(key, entry);
        }

        if (stat.size > entry.offset) this._readAppended(target, stat.size, entry);
        entry.mtimeMs = stat.mtimeMs;
        return entry;
    }

    _readAppended(filePath, size, entry) {
        const descriptor = fs.openSync(filePath, 'r');
        const buffer = Buffer.allocUnsafe(64 * 1024);
        try {
            while (entry.offset < size) {
                const length = Math.min(buffer.length, size - entry.offset);
                const bytesRead = fs.readSync(descriptor, buffer, 0, length, entry.offset);
                if (!bytesRead) break;
                entry.offset += bytesRead;
                this._consume(entry, entry.decoder.write(buffer.subarray(0, bytesRead)));
            }
        } finally {
            fs.closeSync(descriptor);
        }
    }

    _consume(entry, chunk) {
        entry.remainder += chunk;
        let newline = entry.remainder.indexOf('\n');
        while (newline >= 0) {
            const line = entry.remainder.slice(0, newline).trim();
            entry.remainder = entry.remainder.slice(newline + 1);
            this._consumeLine(entry, line);
            newline = entry.remainder.indexOf('\n');
        }
    }

    _consumeLine(entry, line) {
        if (!line || (!line.includes('task_') && !line.includes('turn_aborted') && !line.includes('thread_rolled_back'))) {
            return;
        }

        let record;
        try {
            record = JSON.parse(line);
        } catch {
            return;
        }
        if (record.type !== 'event_msg') return;

        const eventType = record.payload?.type;
        const turnId = record.payload?.turn_id || null;
        if (eventType === 'task_started') {
            entry.active = true;
            entry.activeTurnId = turnId;
            entry.lastLifecycleAt = timestamp(record.timestamp) || entry.lastLifecycleAt;
            return;
        }
        if (!TERMINAL_EVENTS.has(eventType)) return;
        if (!turnId || !entry.activeTurnId || turnId === entry.activeTurnId) {
            entry.active = false;
            entry.activeTurnId = null;
            entry.lastLifecycleAt = timestamp(record.timestamp) || entry.lastLifecycleAt;
        }
    }
}

module.exports = {
    SessionActivityTracker,
    ACTIVITY_STATUS: { RUNNING, WAITING, COMPLETED, FAILED, CANCELLED },
};
