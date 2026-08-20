'use client';

import { useState, useEffect, useCallback, memo } from 'react';
import { cn } from '@/lib/utils';
import { wsService } from '@/lib/ws-service';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Trash2, RefreshCw, Loader2, AlertCircle, Users } from 'lucide-react';
import { SESSION_STATE_CONFIG, TRANSPORT_CONFIG, formatTimestamp } from '@/lib/agent-utils';
import { fetchAgentSessions, destroyAgentSession } from '@/lib/agent-api';
import type { AgentSessionInfo } from '@/lib/agent-api';

// ── Session Card (memoized) ─────────────────────────────────────────────

const SessionCard = memo(function SessionCard({
    session,
    onDestroy,
}: {
    session: AgentSessionInfo;
    onDestroy: (id: string) => void;
}) {
    const transport = TRANSPORT_CONFIG[session.transport] || TRANSPORT_CONFIG.unknown;
    const stateConf = SESSION_STATE_CONFIG[session.state] || SESSION_STATE_CONFIG.IDLE;
    const pct = session.stepSoftLimit > 0
        ? Math.min((session.stepCount / session.stepSoftLimit) * 100, 100)
        : 0;

    // Derive status dot based on state + busy
    let dotClass: string = stateConf.dot;
    let statusLabel: string = stateConf.label;
    if (session.state === 'ACTIVE' && session.isBusy) {
        dotClass = 'bg-amber-400 animate-pulse';
        statusLabel = 'Busy';
    }

    const elapsed = Date.now() - session.lastActivity;
    const relativeTime = elapsed < 60000 ? 'just now'
        : elapsed < 3600000 ? `${Math.floor(elapsed / 60000)}m ago`
        : `${Math.floor(elapsed / 3600000)}h ago`;

    const [confirming, setConfirming] = useState(false);

    return (
        <Card className="bg-muted/5 border-border/20">
            <CardContent className="p-3 space-y-2">
                {/* Header: ID + Transport badge + Status dot */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                        <span className={cn('w-2 h-2 rounded-full shrink-0', dotClass)} />
                        <span className="text-xs font-mono text-foreground/70">
                            {session.id.substring(0, 4)}…{session.id.substring(session.id.length - 4)}
                        </span>
                        <Badge variant="outline" className={cn('text-[9px] px-1.5 py-0', transport.color, transport.bg)}>
                            {transport.label}
                        </Badge>
                    </div>
                    <span className={cn('text-[10px]', stateConf.color)}>{statusLabel}</span>
                </div>

                {/* Workspace + cascade */}
                <div className="flex items-center justify-between text-[10px] text-muted-foreground/60">
                    <span>{session.workspace}</span>
                    {session.cascadeIdShort && session.cascadeIdShort !== '--------' && (
                        <span className="font-mono">#{session.cascadeIdShort}</span>
                    )}
                </div>

                {/* Step progress */}
                <div className="space-y-1">
                    <div className="flex justify-between text-[9px] text-muted-foreground/50">
                        <span>{session.stepCount}/{session.stepSoftLimit} steps</span>
                        <span>{relativeTime}</span>
                    </div>
                    <div className="w-full h-1 rounded-full bg-muted/20 overflow-hidden">
                        <div
                            className={cn(
                                'h-full rounded-full transition-all duration-500',
                                pct > 85 ? 'bg-red-400/70' : pct > 60 ? 'bg-amber-400/70' : 'bg-emerald-400/70'
                            )}
                            style={{ width: `${pct}%` }}
                        />
                    </div>
                </div>

                {/* Destroy action */}
                <div className="flex justify-end">
                    {confirming ? (
                        <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-red-400">Destroy?</span>
                            <Button size="sm" variant="destructive" className="h-6 text-[10px] px-2"
                                onClick={() => { onDestroy(session.id); setConfirming(false); }}>
                                Yes
                            </Button>
                            <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2"
                                onClick={() => setConfirming(false)}>
                                No
                            </Button>
                        </div>
                    ) : (
                        <Button variant="ghost" size="icon" className="h-6 w-6"
                            onClick={() => setConfirming(true)} title="Destroy session">
                            <Trash2 className="h-3 w-3 text-muted-foreground/30 hover:text-red-400" />
                        </Button>
                    )}
                </div>
            </CardContent>
        </Card>
    );
});

// ── Main Panel ──────────────────────────────────────────────────────────

export function AgentSessionsPanel() {
    const [sessions, setSessions] = useState<AgentSessionInfo[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const loadSessions = useCallback(async () => {
        try {
            setError(null);
            const data = await fetchAgentSessions();
            setSessions(data);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Failed to load sessions');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        loadSessions();

        if (!wsService) return;

        const off = wsService.on('agent_sessions', (data) => {
            const event = data.event as string;

            switch (event) {
                case 'session_created':
                    setSessions(prev => {
                        // Avoid duplicate
                        if (prev.some(s => s.id === data.sessionId)) return prev;
                        return [...prev, {
                            id: data.sessionId as string,
                            state: (data.state as AgentSessionInfo['state']) || 'ACTIVE',
                            cascadeId: data.cascadeId as string | null,
                            cascadeIdShort: data.cascadeIdShort as string || '--------',
                            stepCount: (data.stepCount as number) || 0,
                            stepSoftLimit: (data.stepSoftLimit as number) || 500,
                            isBusy: !!data.isBusy,
                            workspace: (data.workspace as string) || '',
                            transport: (data.transport as string) || 'unknown',
                            lastActivity: (data.lastActivity as number) || Date.now(),
                        }];
                    });
                    break;

                case 'session_destroyed':
                    setSessions(prev => prev.filter(s => s.id !== data.sessionId));
                    break;

                case 'session_status_change':
                    setSessions(prev => prev.map(s => {
                        if (s.id !== data.sessionId) return s;
                        return {
                            ...s,
                            state: (data.state as AgentSessionInfo['state']) || s.state,
                            isBusy: data.isBusy != null ? !!data.isBusy : s.isBusy,
                            lastActivity: Date.now(),
                        };
                    }));
                    break;
            }
        });

        // Re-fetch on WS reconnect
        const offOpen = wsService.on('__ws_open', () => { loadSessions(); });

        return () => { off(); offOpen(); };
    }, [loadSessions]);

    const handleDestroy = useCallback(async (id: string) => {
        try {
            await destroyAgentSession(id);
            setSessions(prev => prev.filter(s => s.id !== id));
        } catch { /* WS event will handle removal */ }
    }, []);

    if (loading) {
        return (
            <div className="flex items-center justify-center h-full">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/30" />
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3 px-6">
                <AlertCircle className="h-6 w-6 text-red-400/50" />
                <p className="text-xs text-red-400/70">{error}</p>
                <Button size="sm" variant="outline" onClick={loadSessions} className="text-[10px]">
                    <RefreshCw className="h-3 w-3 mr-1" /> Retry
                </Button>
            </div>
        );
    }

    if (sessions.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3 px-6">
                <div className="w-12 h-12 rounded-2xl bg-muted/10 flex items-center justify-center">
                    <Users className="h-6 w-6 text-muted-foreground/15" />
                </div>
                <div className="text-center space-y-1">
                    <p className="text-xs text-muted-foreground/50 font-medium">No active agent sessions</p>
                    <p className="text-[10px] text-muted-foreground/30">
                        Connect from the Chat tab or from an external agent via WebSocket/HTTP API
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div className="p-3 space-y-2 overflow-y-auto h-full">
            {sessions.map(s => (
                <SessionCard key={s.id} session={s} onDestroy={handleDestroy} />
            ))}
        </div>
    );
}
