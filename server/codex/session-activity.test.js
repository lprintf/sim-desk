const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { SessionActivityTracker, ACTIVITY_STATUS } = require('./session-activity');

function event(type, turnId = 'turn-1', at = new Date().toISOString()) {
    return `${JSON.stringify({
        timestamp: at,
        type: 'event_msg',
        payload: { type, turn_id: turnId },
    })}\n`;
}

function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sim-desk-activity-'));
    const sessionsRoot = path.join(root, 'sessions');
    fs.mkdirSync(sessionsRoot);
    const file = path.join(sessionsRoot, 'rollout.jsonl');
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { sessionsRoot, file };
}

test('tracks an external task and records its completion time', (t) => {
    const { sessionsRoot, file } = fixture(t);
    const completedAt = '2026-07-28T05:30:00.000Z';
    fs.writeFileSync(file, event('task_started', 'turn-1', '2026-07-28T05:20:00.000Z'));
    const tracker = new SessionActivityTracker({ sessionsRoot });
    const thread = { path: file, status: { type: 'notLoaded' }, turns: [] };

    assert.equal(tracker.statusFor(thread), ACTIVITY_STATUS.RUNNING);
    fs.appendFileSync(file, event('task_complete', 'turn-1', completedAt));
    assert.deepEqual(tracker.inspect(thread), {
        status: ACTIVITY_STATUS.COMPLETED,
        lastActivityAt: Date.parse(completedAt),
    });
});

test('session activity overrides an interrupted snapshot from another app-server', (t) => {
    const { sessionsRoot, file } = fixture(t);
    fs.writeFileSync(file, event('task_started', 'external-turn'));
    const tracker = new SessionActivityTracker({ sessionsRoot });
    const thread = {
        path: file,
        status: { type: 'notLoaded' },
        turns: [{ id: 'external-turn', status: 'interrupted', items: [] }],
    };

    assert.equal(tracker.statusFor(thread), ACTIVITY_STATUS.RUNNING);
});

test('expires an unterminated activity marker after the stale window', (t) => {
    const { sessionsRoot, file } = fixture(t);
    fs.writeFileSync(file, event('task_started'));
    const now = Date.now();
    const staleTime = new Date(now - 60_000);
    fs.utimesSync(file, staleTime, staleTime);
    const tracker = new SessionActivityTracker({ sessionsRoot, staleAfterMs: 1000, now: () => now });

    assert.equal(tracker.statusFor({ path: file, status: { type: 'notLoaded' }, turns: [] }), ACTIVITY_STATUS.COMPLETED);
});

test('prefers a native waiting state when this app-server owns the turn', () => {
    const tracker = new SessionActivityTracker();
    const thread = { status: { type: 'active', activeFlags: ['waitingOnApproval'] }, turns: [] };

    assert.equal(tracker.statusFor(thread), ACTIVITY_STATUS.WAITING);
});
