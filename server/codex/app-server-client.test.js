const test = require('node:test');
const assert = require('node:assert/strict');
const { CodexAppServerClient } = require('./app-server-client');

function turn(status = 'completed', items = []) {
    return { id: 'turn-1', status, items, error: null };
}

function errorEvent() {
    return {
        method: 'error',
        params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            willRetry: true,
            error: { message: 'Reconnecting... 5/5', additionalDetails: '401 Unauthorized' },
        },
    };
}

test('decorates an empty completed turn with its recorded provider error', () => {
    const client = new CodexAppServerClient();
    client._handleMessage(errorEvent());

    const decorated = client.decorateThread({ id: 'thread-1', turns: [turn()] });
    assert.equal(decorated.turns[0].status, 'failed');
    assert.equal(decorated.turns[0].error.additionalDetails, '401 Unauthorized');
});

test('broadcasts a failed completed turn when retries produced no answer', () => {
    const client = new CodexAppServerClient();
    const notifications = [];
    client.on('notification', (event) => notifications.push(event));
    client._handleMessage(errorEvent());
    client._handleMessage({
        method: 'turn/completed',
        params: { threadId: 'thread-1', turn: turn() },
    });

    const completed = notifications.at(-1).params.turn;
    assert.equal(completed.status, 'failed');
    assert.equal(completed.error.message, 'Reconnecting... 5/5');
});

test('clears a retry error after an agent response succeeds', () => {
    const client = new CodexAppServerClient();
    client._handleMessage(errorEvent());
    client._handleMessage({
        method: 'item/completed',
        params: {
            threadId: 'thread-1',
            turnId: 'turn-1',
            item: { type: 'agentMessage', text: 'OK' },
        },
    });

    const decorated = client.decorateThread({
        id: 'thread-1',
        turns: [turn('completed', [{ type: 'agentMessage', text: 'OK' }])],
    });
    assert.equal(decorated.turns[0].status, 'completed');
    assert.equal(decorated.turns[0].error, null);
});
