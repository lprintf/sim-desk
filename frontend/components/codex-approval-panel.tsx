'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { FileCode2, Loader2, ShieldAlert, Terminal } from 'lucide-react';
import { answerCodexApproval } from '@/lib/codex-api';
import type { CodexServerRequest } from '@/lib/codex-types';
import { authHeaders } from '@/lib/auth';
import { API_BASE } from '@/lib/config';
import { Button } from '@/components/ui/button';

interface ApprovalEvent extends Event {
    detail?: { requests?: CodexServerRequest[] };
}

function description(request: CodexServerRequest): string {
    const params = request.params;
    if (request.method.includes('commandExecution')) {
        return typeof params.command === 'string' ? params.command : 'Run a command';
    }
    return String(params.reason || params.grantRoot || 'Apply file changes');
}

export function CodexApprovalPanel({ threadId }: { threadId: string | null }) {
    const [requests, setRequests] = useState<CodexServerRequest[]>([]);
    const [busyId, setBusyId] = useState<string | null>(null);
    const [error, setError] = useState('');

    useEffect(() => {
        const receive = (event: Event) => {
            setRequests((event as ApprovalEvent).detail?.requests || []);
        };
        window.addEventListener('codex-approvals-changed', receive);
        fetch(`${API_BASE}/api/codex/approvals`, { headers: authHeaders() })
            .then((response) => response.ok ? response.json() : { data: [] })
            .then((payload) => setRequests(payload.data || []))
            .catch(() => undefined);
        return () => window.removeEventListener('codex-approvals-changed', receive);
    }, []);

    const visible = useMemo(
        () => requests.filter((request) => !threadId || request.params.threadId === threadId),
        [requests, threadId],
    );

    const decide = useCallback(async (requestId: string, decision: 'accept' | 'acceptForSession' | 'decline') => {
        setBusyId(requestId);
        setError('');
        try {
            await answerCodexApproval(requestId, decision);
            setRequests((current) => current.filter((request) => request.requestId !== requestId));
        } catch (cause) {
            setError(cause instanceof Error ? cause.message : 'Approval failed');
        } finally {
            setBusyId(null);
        }
    }, []);

    if (visible.length === 0) return null;

    return (
        <div className="border-y border-amber-500/25 bg-amber-500/[0.06] px-3 py-2.5 sm:px-6">
            <div className="mx-auto max-w-4xl space-y-2">
                {visible.map((request) => {
                    const isCommand = request.method.includes('commandExecution');
                    const Icon = isCommand ? Terminal : FileCode2;
                    const busy = busyId === request.requestId;
                    return (
                        <div key={request.requestId} className="flex flex-col gap-2 sm:flex-row sm:items-center">
                            <div className="flex min-w-0 flex-1 items-start gap-2.5">
                                <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-400" />
                                <div className="min-w-0">
                                    <div className="flex items-center gap-1.5 text-xs font-medium text-foreground/90">
                                        <Icon className="size-3.5" />
                                        {isCommand ? 'Command approval' : 'File change approval'}
                                    </div>
                                    <p className="mt-0.5 break-all font-mono text-[11px] leading-4 text-muted-foreground">
                                        {description(request)}
                                    </p>
                                </div>
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5 pl-6 sm:pl-0">
                                <Button size="sm" variant="ghost" disabled={busy} onClick={() => decide(request.requestId, 'decline')}>Reject</Button>
                                <Button size="sm" variant="outline" disabled={busy} onClick={() => decide(request.requestId, 'acceptForSession')}>Allow session</Button>
                                <Button size="sm" disabled={busy} onClick={() => decide(request.requestId, 'accept')}>
                                    {busy && <Loader2 className="size-3.5 animate-spin" />}
                                    Allow once
                                </Button>
                            </div>
                        </div>
                    );
                })}
                {error && <p className="pl-6 text-xs text-destructive">{error}</p>}
            </div>
        </div>
    );
}
