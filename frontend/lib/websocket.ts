'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Step, TrajectorySummary } from './types';
import type { CodexEvent, CodexServerRequest, CodexThread, CodexThreadItem, CodexTurn } from './codex-types';
import { codexWebSocketUrl, getCodexThread, getCodexThreads, getCodexWorkspaces } from './codex-api';
import { getWorkspaceResources } from './cascade-api';
import type { ResourceSnapshot } from './cascade-api';

interface WSState {
    connected: boolean;
    detected: boolean;
    swapping: boolean;
    steps: Step[];
    baseIndex: number;
    stepCount: number;
    loadingOlder: boolean;
    conversations: Record<string, TrajectorySummary>;
    currentConvId: string | null;
    cascadeStatus: string | null;
    lastUpdate: string;
    conversationsVersion: number;
    stepContentVersion: number;
    workspaceResources: ResourceSnapshot | null;
    codexError: string | null;
}

const THREAD_KEY = 'antigravity-current-conv-id';

function textContent(item: CodexThreadItem): string {
    if (item.text) return item.text;
    if (!Array.isArray(item.content)) return '';
    return item.content
        .filter((entry) => entry && typeof entry === 'object')
        .map((entry) => typeof entry.text === 'string' ? entry.text : '')
        .filter(Boolean)
        .join('\n');
}

function stringify(value: unknown): string {
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value, null, 2); } catch { return String(value ?? ''); }
}

function errorText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!value || typeof value !== 'object') return String(value || 'Codex turn failed');
    const error = value as Record<string, unknown>;
    if (typeof error.message === 'string') {
        const details = typeof error.additionalDetails === 'string' ? error.additionalDetails : '';
        return details && !error.message.includes(details) ? `${error.message}\n${details}` : error.message;
    }
    for (const key of ['userErrorMessage', 'shortError', 'error']) {
        if (error[key]) return errorText(error[key]);
    }
    return stringify(value);
}

function diffLines(diff: string): Array<{ text: string; type: string }> {
    return diff.split('\n')
        .filter((line) => !line.startsWith('diff --git') && !line.startsWith('index ') && !line.startsWith('@@') && !line.startsWith('---') && !line.startsWith('+++'))
        .map((line) => {
            if (line.startsWith('+')) return { text: line.slice(1), type: 'ADDED' };
            if (line.startsWith('-')) return { text: line.slice(1), type: 'REMOVED' };
            return { text: line.startsWith(' ') ? line.slice(1) : line, type: 'UNCHANGED' };
        });
}

function itemToSteps(item: CodexThreadItem): Step[] {
    const status = item.status || 'completed';

    if (item.type === 'userMessage') {
        return [{
            type: 'CORTEX_STEP_TYPE_USER_INPUT',
            status,
            userInput: { items: [{ text: textContent(item) }] },
        }];
    }

    if (item.type === 'agentMessage') {
        return [{
            type: 'CORTEX_STEP_TYPE_NOTIFY_USER',
            status,
            notifyUser: { notificationContent: item.text || '' },
        }];
    }

    if (item.type === 'reasoning') {
        const content = [
            ...(Array.isArray(item.summary) ? item.summary : []),
            ...(Array.isArray(item.content) ? item.content.map((part) => stringify(part)) : []),
        ].filter(Boolean).join('\n\n');
        return [{
            type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
            status,
            plannerResponse: { thinking: content, response: content },
        }];
    }

    if (item.type === 'commandExecution') {
        const command = item.command || 'Command';
        const steps: Step[] = [{
            type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
            status,
            runCommand: { commandLine: command },
            metadata: { name: 'Codex command' },
        }];
        if (item.aggregatedOutput || item.exitCode !== null) {
            steps.push({
                type: 'CORTEX_STEP_TYPE_COMMAND_STATUS',
                status,
                commandStatus: { output: { full: item.aggregatedOutput || '' } },
                metadata: { resultJson: stringify({ exitCode: item.exitCode, cwd: item.cwd }) },
            });
        }
        return steps;
    }

    if (item.type === 'fileChange') {
        return [{
            type: 'CORTEX_STEP_TYPE_CODE_ACKNOWLEDGEMENT',
            status,
            codeAcknowledgement: {
                isAccept: status !== 'failed',
                acknowledgementScope: 'Codex file changes',
                codeAcknowledgementInfos: (item.changes || []).map((change) => ({
                    uriPath: change.path,
                    diff: { lines: diffLines(change.diff || '') },
                })),
            },
        }];
    }

    if (item.type === 'plan') {
        return [{
            type: 'CORTEX_STEP_TYPE_TASK_BOUNDARY',
            status,
            taskBoundary: { taskName: 'Plan', taskStatus: status, taskSummary: item.text || '' },
        }];
    }

    if (item.type === 'webSearch') {
        return [{ type: 'CORTEX_STEP_TYPE_READ_URL_CONTENT', status, metadata: { name: 'Web search' } }];
    }

    if (item.type === 'mcpToolCall' || item.type === 'dynamicToolCall') {
        const name = [item.server, item.tool].filter(Boolean).join(' / ') || 'Tool call';
        return [{
            type: 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE',
            status,
            ephemeralMessage: { content: `${name}\n\n${stringify(item.result || item.error || item.arguments)}` },
            metadata: { name, argumentsJson: stringify(item.arguments), resultJson: stringify(item.result || item.error) },
        }];
    }

    if (item.type === 'contextCompaction') {
        return [{ type: 'CORTEX_STEP_TYPE_CHECKPOINT', status, checkpoint: { modelName: 'Context compacted' } }];
    }

    if (item.type === 'turnError') {
        return [{
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'failed',
            errorMessage: errorText(item.error),
            metadata: { name: 'Codex request failed' },
        }];
    }

    const label = item.type || 'Codex activity';
    const content = item.error ? stringify(item.error) : label;
    return [{
        type: item.status === 'failed' ? 'CORTEX_STEP_TYPE_ERROR_MESSAGE' : 'CORTEX_STEP_TYPE_EPHEMERAL_MESSAGE',
        status,
        errorMessage: item.status === 'failed' ? content : undefined,
        ephemeralMessage: item.status === 'failed' ? undefined : { content },
        metadata: { name: label },
    }];
}

export function threadToSteps(thread: CodexThread): Step[] {
    return (thread.turns || []).flatMap((turn) => {
        const steps = (turn.items || []).flatMap(itemToSteps);
        if (turn.status !== 'failed') return steps;
        if ((turn.items || []).some((item) => item.type === 'turnError')) return steps;
        return [...steps, {
            type: 'CORTEX_STEP_TYPE_ERROR_MESSAGE',
            status: 'failed',
            errorMessage: errorText(turn.error),
            metadata: { name: 'Codex request failed' },
        }];
    });
}

function cascadeStatus(thread: CodexThread): string {
    const lastTurn = thread.turns?.[thread.turns.length - 1];
    if (lastTurn?.status === 'inProgress') return 'CASCADE_RUN_STATUS_RUNNING';
    if (lastTurn?.status === 'failed') return 'CASCADE_RUN_STATUS_FAILED';
    if (lastTurn?.status === 'interrupted') return 'CASCADE_RUN_STATUS_CANCELLED';
    return 'CASCADE_RUN_STATUS_COMPLETED';
}

function summary(thread: CodexThread): TrajectorySummary {
    const timestamp = Number(thread.updatedAt || thread.createdAt || 0);
    const millis = timestamp > 0 && timestamp < 10_000_000_000 ? timestamp * 1000 : timestamp;
    return {
        summary: thread.name || thread.preview || 'Untitled',
        stepCount: (thread.turns || []).reduce((count, turn) => count + (turn.items?.length || 0), 0),
        status: thread.turns?.length ? cascadeStatus(thread) : thread.status?.type,
        lastModifiedTime: millis ? new Date(millis).toISOString() : '',
    };
}

function mergeItem(turn: CodexTurn, item: CodexThreadItem): CodexTurn {
    const items = [...(turn.items || [])];
    const index = item.id ? items.findIndex((candidate) => candidate.id === item.id) : -1;
    if (index >= 0) items[index] = item;
    else items.push(item);
    return { ...turn, items };
}

function updateTurn(thread: CodexThread, turnId: string, updater: (turn: CodexTurn) => CodexTurn): CodexThread {
    const turns = [...(thread.turns || [])];
    const index = turns.findIndex((turn) => turn.id === turnId);
    const initial: CodexTurn = { id: turnId, items: [], status: 'inProgress' };
    if (index >= 0) turns[index] = updater(turns[index]);
    else turns.push(updater(initial));
    return { ...thread, turns, updatedAt: Date.now() };
}

function applyEvent(thread: CodexThread, event: CodexEvent): CodexThread {
    const params = event.params;
    if (params.threadId && params.threadId !== thread.id) return thread;
    if (event.method === 'thread/name/updated') return { ...thread, name: String(params.threadName || '') };
    if (event.method === 'turn/started' && params.turn) {
        return updateTurn(thread, params.turn.id, () => params.turn as CodexTurn);
    }
    if (event.method === 'turn/completed' && params.turn) {
        return updateTurn(thread, params.turn.id, (existing) => {
            const completed = params.turn as CodexTurn;
            const items = completed.items?.length ? completed.items : existing.items;
            const hasAgentMessage = items.some((item) => item.type === 'agentMessage');
            const turnError = [...items].reverse().find((item) => item.type === 'turnError');
            return {
                ...existing,
                ...completed,
                items: hasAgentMessage ? items.filter((item) => item.type !== 'turnError') : items,
                status: completed.status === 'completed' && turnError && !hasAgentMessage ? 'failed' : completed.status,
                error: completed.error || turnError?.error || null,
            };
        });
    }
    if (event.method === 'error' && params.turnId && params.error) {
        return updateTurn(thread, params.turnId, (turn) => mergeItem(turn, {
            id: `turn-error-${params.turnId}`,
            type: 'turnError',
            status: 'failed',
            error: params.error,
        }));
    }
    if ((event.method === 'item/started' || event.method === 'item/completed') && params.turnId && params.item) {
        return updateTurn(thread, params.turnId, (turn) => mergeItem(turn, params.item as CodexThreadItem));
    }
    if (!params.turnId || !params.itemId) return thread;

    return updateTurn(thread, params.turnId, (turn) => {
        const existing = turn.items.find((item) => item.id === params.itemId) || { id: params.itemId, type: 'agentMessage' };
        if (event.method === 'item/agentMessage/delta') {
            return mergeItem(turn, { ...existing, type: 'agentMessage', text: `${existing.text || ''}${params.delta || ''}` });
        }
        if (event.method === 'item/commandExecution/outputDelta') {
            return mergeItem(turn, { ...existing, type: 'commandExecution', aggregatedOutput: `${existing.aggregatedOutput || ''}${params.delta || ''}` });
        }
        if (event.method.includes('reasoning') && event.method.endsWith('Delta')) {
            const parts = Array.isArray(existing.summary) ? existing.summary : [];
            const next = [...parts];
            const delta = String(params.delta || '');
            if (next.length) next[next.length - 1] += delta;
            else next.push(delta);
            return mergeItem(turn, { ...existing, type: 'reasoning', summary: next });
        }
        if (event.method === 'item/plan/delta') {
            return mergeItem(turn, { ...existing, type: 'plan', text: `${existing.text || ''}${params.delta || ''}` });
        }
        return turn;
    });
}

function savedThreadId(): string | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = localStorage.getItem(THREAD_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

export function useWebSocket() {
    const initialThreadId = savedThreadId();
    const [state, setState] = useState<WSState>({
        connected: false,
        detected: false,
        swapping: false,
        steps: [],
        baseIndex: 0,
        stepCount: 0,
        loadingOlder: false,
        conversations: {},
        currentConvId: initialThreadId,
        cascadeStatus: null,
        lastUpdate: '',
        conversationsVersion: 0,
        stepContentVersion: 0,
        workspaceResources: null,
        codexError: null,
    });
    const currentThreadIdRef = useRef<string | null>(initialThreadId);
    const currentThreadRef = useRef<CodexThread | null>(null);
    const approvalsRef = useRef<CodexServerRequest[]>([]);

    const publishApprovals = useCallback((requests: CodexServerRequest[]) => {
        approvalsRef.current = requests;
        window.dispatchEvent(new CustomEvent('codex-approvals-changed', { detail: { requests } }));
    }, []);

    const publishThread = useCallback((thread: CodexThread) => {
        if (thread.id !== currentThreadIdRef.current) return;
        currentThreadRef.current = thread;
        const steps = threadToSteps(thread);
        setState((previous) => ({
            ...previous,
            steps,
            stepCount: steps.length,
            cascadeStatus: approvalsRef.current.some((request) => request.params.threadId === thread.id)
                ? 'CASCADE_RUN_STATUS_WAITING_FOR_USER'
                : cascadeStatus(thread),
            lastUpdate: new Date().toLocaleTimeString(),
            stepContentVersion: previous.stepContentVersion + 1,
        }));
    }, []);

    const loadCurrentThread = useCallback(async (threadId: string) => {
        try {
            const result = await getCodexThread(threadId);
            publishThread(result.thread);
        } catch (error) {
            console.error('Failed to load Codex thread:', error);
        }
    }, [publishThread]);

    const loadConversations = useCallback(async () => {
        try {
            const workspaceResult = await getCodexWorkspaces();
            const groups = await Promise.allSettled(workspaceResult.data.map((workspace) => getCodexThreads(workspace.path)));
            const conversations: Record<string, TrajectorySummary> = {};
            for (const group of groups) {
                if (group.status !== 'fulfilled') continue;
                for (const thread of group.value.data) conversations[thread.id] = summary(thread);
            }
            setState((previous) => ({ ...previous, conversations }));
        } catch (error) {
            console.error('Failed to load Codex threads:', error);
        }
    }, []);

    useEffect(() => {
        let socket: WebSocket | null = null;
        let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
        let stopped = false;
        let retry = 0;

        const connect = () => {
            socket = new WebSocket(codexWebSocketUrl());
            socket.onopen = () => {
                retry = 0;
                setState((previous) => ({ ...previous, connected: true }));
            };
            socket.onmessage = (message) => {
                try {
                    const payload = JSON.parse(message.data);
                    if (payload.type === 'connected') {
                        const running = Boolean(payload.state?.running);
                        setState((previous) => ({
                            ...previous,
                            connected: true,
                            detected: running,
                            codexError: payload.state?.error || null,
                        }));
                        publishApprovals(payload.pendingRequests || []);
                        loadConversations();
                        if (currentThreadIdRef.current) loadCurrentThread(currentThreadIdRef.current);
                        return;
                    }
                    if (payload.type === 'codex-state') {
                        setState((previous) => ({
                            ...previous,
                            detected: Boolean(payload.state?.running),
                            codexError: payload.state?.error || null,
                        }));
                        return;
                    }
                    if (payload.type === 'codex-request') {
                        publishApprovals([...approvalsRef.current.filter((item) => item.requestId !== payload.request.requestId), payload.request]);
                        setState((previous) => ({ ...previous, cascadeStatus: 'CASCADE_RUN_STATUS_WAITING_FOR_USER' }));
                        return;
                    }
                    if (payload.type === 'codex-request-resolved') {
                        publishApprovals(approvalsRef.current.filter((item) => item.requestId !== payload.requestId));
                        if (currentThreadRef.current) publishThread(currentThreadRef.current);
                        return;
                    }
                    if (payload.type === 'codex-event') {
                        const event = payload.event as CodexEvent;
                        const relevant = !event.params.threadId || event.params.threadId === currentThreadIdRef.current;
                        if (relevant && currentThreadRef.current) publishThread(applyEvent(currentThreadRef.current, event));
                        if (['thread/started', 'thread/name/updated', 'thread/status/changed', 'turn/started', 'turn/completed'].includes(event.method)) {
                            setState((previous) => ({ ...previous, conversationsVersion: previous.conversationsVersion + 1 }));
                            loadConversations();
                        }
                    }
                } catch (error) {
                    console.error('Codex WebSocket message failed:', error);
                }
            };
            socket.onclose = () => {
                setState((previous) => ({ ...previous, connected: false }));
                if (!stopped) {
                    retry += 1;
                    reconnectTimer = setTimeout(connect, Math.min(1000 * 2 ** retry, 15000));
                }
            };
            socket.onerror = () => socket?.close();
        };

        connect();
        return () => {
            stopped = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            socket?.close();
        };
    }, [loadConversations, loadCurrentThread, publishApprovals, publishThread]);

    useEffect(() => {
        let cancelled = false;
        const refresh = async () => {
            try {
                const resources = await getWorkspaceResources();
                if (!cancelled) setState((previous) => ({ ...previous, workspaceResources: resources }));
            } catch { /* resource sampling is optional */ }
        };
        refresh();
        const timer = setInterval(refresh, 5000);
        return () => { cancelled = true; clearInterval(timer); };
    }, []);

    const selectConversation = useCallback((id: string | null) => {
        currentThreadIdRef.current = id;
        currentThreadRef.current = null;
        setState((previous) => ({
            ...previous,
            currentConvId: id,
            steps: [],
            baseIndex: 0,
            stepCount: 0,
            cascadeStatus: null,
        }));
        if (id) loadCurrentThread(id);
    }, [loadCurrentThread]);

    const loadOlder = useCallback(async () => undefined, []);

    return { ...state, selectConversation, loadOlder };
}
