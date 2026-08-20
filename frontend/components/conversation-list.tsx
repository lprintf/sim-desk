'use client';
import { useState, useEffect, useCallback, useRef } from 'react';
import { API_BASE } from '@/lib/config';
import { authHeaders } from '@/lib/auth';
import type { Workspace } from '@/lib/cascade-api';
import { getWorkspaces } from '@/lib/cascade-api';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Skeleton } from '@/components/ui/skeleton';
import { ConversationStatusIndicator } from '@/components/conversation-status-indicator';
import { markConversationRead, useConversationUnread } from '@/lib/conversation-read-state';
import { Plus, ChevronRight, Folder, MessageSquare, Power } from 'lucide-react';

interface ConvSummary {
    id: string;
    summary: string;
    stepCount: number;
    lastModifiedTime: string;
    status?: string;
}

interface ConversationSummariesResponse {
    trajectorySummaries?: Record<string, Partial<Omit<ConvSummary, 'id'>>>;
}

interface ConversationListProps {
    workspaceName: string;
    wsVersion: number;
    onSelectConversation: (convId: string) => void;
    onNewChat: () => void;
    onWorkspaceRemoved?: () => void;
}

export function ConversationList({ workspaceName, wsVersion, onSelectConversation, onNewChat, onWorkspaceRemoved }: ConversationListProps) {
    const [conversations, setConversations] = useState<ConvSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [workspace, setWorkspace] = useState<Workspace | null>(null);
    const [killing, setKilling] = useState(false);
    const hasLoadedRef = useRef(false);
    const unreadIds = useConversationUnread(conversations);

    const loadConversations = useCallback(async () => {
        if (!hasLoadedRef.current) setLoading(true);
        try {
            const workspaces = await getWorkspaces();
            const ws = workspaces.find(w => w.workspaceName === workspaceName);
            if (ws) setWorkspace(ws);

            const res = await fetch(`${API_BASE}/api/workspaces/${encodeURIComponent(workspaceName)}/conversations`, { headers: authHeaders() });
            const json = await res.json() as ConversationSummariesResponse;
            const convs: ConvSummary[] = Object.entries(json.trajectorySummaries || {}).map(
                ([id, info]) => ({
                    id,
                    summary: info.summary || 'Untitled',
                    stepCount: info.stepCount || 0,
                    lastModifiedTime: info.lastModifiedTime || '',
                    status: info.status || '',
                })
            );
            convs.sort((a, b) => (b.lastModifiedTime || '').localeCompare(a.lastModifiedTime || ''));
            setConversations(convs);
        } catch (e) {
            console.error('Failed to load conversations:', e);
            setConversations([]);
        } finally {
            hasLoadedRef.current = true;
            setLoading(false);
        }
    }, [workspaceName]);

    useEffect(() => {
        const timer = window.setTimeout(loadConversations, 0);
        return () => window.clearTimeout(timer);
    }, [loadConversations, wsVersion]);

    useEffect(() => {
        const interval = window.setInterval(() => {
            if (!document.hidden) void loadConversations();
        }, 5000);
        return () => clearInterval(interval);
    }, [loadConversations]);

    const formatTime = (iso: string) => {
        if (!iso) return '';
        try {
            const d = new Date(iso);
            const now = new Date();
            const diffMs = now.getTime() - d.getTime();
            const diffMin = Math.floor(diffMs / 60000);
            if (diffMin < 1) return 'Just now';
            if (diffMin < 60) return `${diffMin}m ago`;
            const diffHr = Math.floor(diffMin / 60);
            if (diffHr < 24) return `${diffHr}h ago`;
            const diffDay = Math.floor(diffHr / 24);
            if (diffDay < 7) return `${diffDay}d ago`;
            return d.toLocaleDateString();
        } catch {
            return '';
        }
    };

    const handleKillHeadless = useCallback(async () => {
        if (!workspace?.headless || !workspace?.pid) return;
        if (!confirm(`Stop headless workspace "${workspaceName}"?\nThis will terminate the LS process and all active cascades.`)) return;
        setKilling(true);
        try {
            const res = await fetch(`${API_BASE}/api/workspaces/headless/${workspace.pid}`, {
                method: 'DELETE',
                headers: authHeaders(),
            });
            if (res.ok) {
                onWorkspaceRemoved?.();
            } else {
                const error = await res.json().catch(() => ({})) as { error?: string };
                alert(`Failed to stop: ${error.error || res.statusText}`);
            }
        } catch (error: unknown) {
            alert(`Error: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            setKilling(false);
        }
    }, [workspace, workspaceName, onWorkspaceRemoved]);

    return (
        <div className="flex-1 flex flex-col min-h-0">
            {/* Header */}
            <div className="px-4 pt-4 pb-3 sm:px-6 sm:pt-6 sm:pb-4 border-b border-border/50 flex-shrink-0">
                <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2.5">
                        <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center text-sm">
                            <Folder className="h-4 w-4" />
                        </div>
                        <div>
                            <h2 className="text-base font-semibold text-foreground">
                                {workspace?.workspaceName || 'Workspace'}
                            </h2>
                            <p className="text-xs text-muted-foreground">
                                {conversations.length} conversation{conversations.length !== 1 ? 's' : ''}
                                {workspace?.headless && <span className="ml-1.5 text-emerald-400/80">● headless</span>}
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-1.5">
                        {workspace?.headless && (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={handleKillHeadless}
                                disabled={killing}
                                className="gap-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
                                title="Stop headless LS"
                            >
                                <Power className="h-3.5 w-3.5" />
                                <span className="hidden sm:inline">{killing ? 'Stopping...' : 'Stop'}</span>
                            </Button>
                        )}
                        <Button size="sm" onClick={onNewChat} className="gap-1.5">
                            <Plus className="h-3.5 w-3.5" />
                            New Chat
                        </Button>
                    </div>
                </div>
            </div>

            {/* Conversation list */}
            {loading ? (
                <div className="p-4 space-y-2">
                    {Array.from({ length: 5 }).map((_, i) => (
                        <Skeleton key={i} className="h-14 w-full rounded-lg" />
                    ))}
                </div>
            ) : conversations.length === 0 ? (
                <div className="flex-1 flex items-center justify-center">
                    <div className="text-center space-y-3">
                        <div className="flex items-center justify-center gap-3">
                            <MessageSquare className="h-8 w-8 text-muted-foreground/40" />
                            <h3 className="text-sm font-medium text-foreground/70">No conversations yet</h3>
                        </div>
                        <p className="text-xs text-muted-foreground max-w-xs">
                            Start a new chat to begin working in this workspace.
                        </p>
                        <Button variant="outline" size="sm" onClick={onNewChat} className="mt-2">
                            Start your first chat
                        </Button>
                    </div>
                </div>
            ) : (
                <ScrollArea className="flex-1">
                    <div className="p-2 sm:p-4 space-y-1 sm:space-y-1.5">
                        {conversations.map(conv => (
                            <Button
                                key={conv.id}
                                variant="ghost"
                                onClick={() => {
                                    markConversationRead(conv.id, conv.lastModifiedTime);
                                    onSelectConversation(conv.id);
                                }}
                                className="w-full h-auto text-left justify-start px-3 sm:px-4 py-3 rounded-lg border border-transparent hover:border-border/50 group"
                            >
                                <div className="flex items-start gap-3 w-full min-w-0">
                                    <div className="flex-1 min-w-0">
                                        <div className="flex items-center justify-between gap-2 mb-0.5">
                                            <span className="text-sm font-medium truncate text-foreground/90 group-hover:text-foreground">
                                                {conv.summary}
                                            </span>
                                            <span className="flex shrink-0 items-center gap-2 text-[10px] text-muted-foreground/60">
                                                <ConversationStatusIndicator status={conv.status} unread={unreadIds.has(conv.id)} />
                                                <span>{formatTime(conv.lastModifiedTime)}</span>
                                            </span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                            <span className="text-[10px] text-muted-foreground/50">
                                                {conv.stepCount} steps
                                            </span>
                                            <span className="text-[10px] text-muted-foreground/30 font-mono">
                                                {conv.id.substring(0, 8)}
                                            </span>
                                        </div>
                                    </div>
                                    <ChevronRight className="w-4 h-4 text-muted-foreground/30 group-hover:text-muted-foreground/60 shrink-0 mt-1 transition-colors" />
                                </div>
                            </Button>
                        ))}
                    </div>
                </ScrollArea>
            )}
        </div>
    );
}
