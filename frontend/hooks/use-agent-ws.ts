'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { getAgentWsUrl } from '@/lib/config';
import { authWsUrl } from '@/lib/auth';
import type { AgentWsState, AgentMessage } from '@/lib/agent-api';

// ── State machine ──────────────────────────────────────────────────────
//
//   disconnected ──connect()──→ connecting ──'connected' msg──→ connected
//       ↑                         │ error                        │ send()
//       │                         ↓                              ↓
//       │                    reconnecting ←── WS close ────── busy
//       │                         │ 3 retries                    │ 'response'
//       │                         ↓                              ↓
//       ←────────────────────── error                     connected
//       ←────── disconnect()

const MAX_RETRIES = 3;
const BACKOFF = [1000, 2000, 4000];

let _msgIdCounter = 0;
function nextMsgId(): string {
    return `msg-${Date.now()}-${++_msgIdCounter}`;
}

export interface UseAgentWsReturn {
    state: AgentWsState;
    sessionId: string | null;
    cascadeId: string | null;
    workspace: string | null;
    messages: AgentMessage[];
    error: string | null;
    connect: (workspace: string) => Promise<void>;
    send: (text: string) => void;
    accept: () => void;
    reject: () => void;
    newCascade: () => void;
    disconnect: () => void;
}

export function useAgentWs(): UseAgentWsReturn {
    const [state, setState] = useState<AgentWsState>('disconnected');
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [cascadeId, setCascadeId] = useState<string | null>(null);
    const [workspace, setWorkspace] = useState<string | null>(null);
    const [messages, setMessages] = useState<AgentMessage[]>([]);
    const [error, setError] = useState<string | null>(null);

    const wsRef = useRef<WebSocket | null>(null);
    const retryCountRef = useRef(0);
    const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const workspaceRef = useRef<string | null>(null);
    const mountedRef = useRef(true);

    // Keep workspace ref in sync
    useEffect(() => { workspaceRef.current = workspace; }, [workspace]);

    // Cleanup on unmount
    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
            if (retryTimerRef.current) clearTimeout(retryTimerRef.current);
            if (wsRef.current) {
                wsRef.current.onclose = null; // prevent reconnect on unmount
                wsRef.current.close();
                wsRef.current = null;
            }
        };
    }, []);

    const addMessage = useCallback((msg: AgentMessage) => {
        setMessages(prev => [...prev, msg]);
    }, []);

    const addSystemMessage = useCallback((content: string) => {
        addMessage({ id: nextMsgId(), role: 'system', content, timestamp: Date.now() });
    }, [addMessage]);

    const wsSend = useCallback((data: Record<string, unknown>) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send(JSON.stringify(data));
        }
    }, []);

    const handleMessage = useCallback((event: MessageEvent) => {
        if (!mountedRef.current) return;
        let data: Record<string, unknown>;
        try {
            data = JSON.parse(event.data as string);
        } catch { return; }

        switch (data.type) {
            case 'connected':
                setSessionId(data.sessionId as string);
                setCascadeId(data.cascadeId as string | null);
                setWorkspace(data.workspace as string);
                setState('connected');
                retryCountRef.current = 0;
                setError(null);
                addSystemMessage(`Connected to ${data.workspace} (session ${(data.sessionId as string).substring(0, 8)})`);
                break;

            case 'response':
                addMessage({
                    id: nextMsgId(),
                    role: 'agent',
                    content: data.text as string,
                    timestamp: Date.now(),
                    stepIndex: data.stepIndex as number | undefined,
                    stepCount: data.stepCount as number | undefined,
                    stepType: data.stepType as string | undefined,
                });
                setState('connected');
                break;

            case 'busy':
                if (data.isBusy) {
                    setState('busy');
                } else {
                    setState('connected');
                }
                break;

            case 'cascade_transition':
                setCascadeId(data.newId as string);
                addSystemMessage(
                    `Cascade transitioned: ${(data.oldShort as string) || '?'} → ${(data.newShort as string) || '?'}${data.reason ? ` (${data.reason})` : ''}`
                );
                break;

            case 'status_change':
                // Backend state change — informational
                break;

            case 'step_limit_warning':
                addSystemMessage(
                    `⚠️ Approaching step limit: ${data.stepCount}/${data.softLimit}`
                );
                break;

            case 'busy_rejected':
                addSystemMessage('⚠️ Agent is busy processing a previous message');
                setState('connected');
                break;

            case 'error':
                setError(data.message as string);
                addSystemMessage(`❌ Error: ${data.message}`);
                break;

            case 'disconnected':
                setState('disconnected');
                setSessionId(null);
                setCascadeId(null);
                addSystemMessage('Disconnected');
                break;

            case 'workspace_switched':
                setCascadeId(data.cascadeId as string | null);
                addSystemMessage(`Workspace switched to ${data.workspace}`);
                break;

            case 'accepted':
                addSystemMessage('✅ Code changes accepted');
                break;

            case 'rejected':
                addSystemMessage('❌ Code changes rejected');
                break;
        }
    }, [addMessage, addSystemMessage]);

    const attemptConnect = useCallback(async (ws_workspace: string) => {
        try {
            const agentUrl = await getAgentWsUrl();
            const url = authWsUrl(agentUrl);
            const ws = new WebSocket(url);
            wsRef.current = ws;

            ws.onopen = () => {
                if (!mountedRef.current) { ws.close(); return; }
                // Send connect message with transport identification
                ws.send(JSON.stringify({
                    type: 'connect',
                    workspace: ws_workspace,
                    transport: 'websocket-ui',
                }));
            };

            ws.onmessage = handleMessage;

            ws.onclose = () => {
                if (!mountedRef.current) return;
                wsRef.current = null;
                setSessionId(null);
                setCascadeId(null);

                // Attempt reconnect if we were connected (not a manual disconnect)
                setState(prev => {
                    if (prev === 'disconnected') return prev; // manual disconnect
                    if (retryCountRef.current >= MAX_RETRIES) {
                        setError('Connection lost. Reconnect failed after 3 attempts.');
                        return 'error';
                    }
                    const delay = BACKOFF[retryCountRef.current] || 4000;
                    retryCountRef.current++;
                    retryTimerRef.current = setTimeout(() => {
                        if (mountedRef.current && workspaceRef.current) {
                            attemptConnect(workspaceRef.current);
                        }
                    }, delay);
                    addSystemMessage(`Connection lost. Reconnecting (${retryCountRef.current}/${MAX_RETRIES})...`);
                    return 'reconnecting';
                });
            };

            ws.onerror = () => {
                // onclose will fire after this
            };
        } catch (e) {
            if (!mountedRef.current) return;
            setError(e instanceof Error ? e.message : 'Connection failed');
            setState('error');
        }
    }, [handleMessage, addSystemMessage]);

    const connect = useCallback(async (ws_workspace: string) => {
        // Clean up existing connection
        if (wsRef.current) {
            wsRef.current.onclose = null;
            wsRef.current.close();
            wsRef.current = null;
        }
        if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
        }
        retryCountRef.current = 0;
        setError(null);
        setState('connecting');
        setWorkspace(ws_workspace);
        workspaceRef.current = ws_workspace;
        await attemptConnect(ws_workspace);
    }, [attemptConnect]);

    const send = useCallback((text: string) => {
        if (state === 'busy') {
            addSystemMessage('⚠️ Agent is busy — wait for current response');
            return;
        }
        if (state !== 'connected') return;

        addMessage({
            id: nextMsgId(),
            role: 'user',
            content: text,
            timestamp: Date.now(),
        });
        setState('busy');
        wsSend({ type: 'send', message: text });
    }, [state, addMessage, addSystemMessage, wsSend]);

    const accept = useCallback(() => { wsSend({ type: 'accept' }); }, [wsSend]);
    const reject = useCallback(() => { wsSend({ type: 'reject' }); }, [wsSend]);

    const newCascade = useCallback(() => {
        if (workspaceRef.current) {
            wsSend({ type: 'switch_workspace', workspace: workspaceRef.current });
        }
    }, [wsSend]);

    const disconnect = useCallback(() => {
        if (retryTimerRef.current) {
            clearTimeout(retryTimerRef.current);
            retryTimerRef.current = null;
        }
        retryCountRef.current = 0;
        if (wsRef.current) {
            wsSend({ type: 'disconnect' });
            wsRef.current.onclose = null;
            wsRef.current.close();
            wsRef.current = null;
        }
        setState('disconnected');
        setSessionId(null);
        setCascadeId(null);
        setError(null);
        addSystemMessage('Disconnected');
    }, [wsSend, addSystemMessage]);

    return {
        state, sessionId, cascadeId, workspace, messages, error,
        connect, send, accept, reject, newCascade, disconnect,
    };
}
