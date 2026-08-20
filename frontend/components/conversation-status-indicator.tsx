'use client';

import { cn } from '@/lib/utils';

export function ConversationStatusIndicator({
    status,
    unread = false,
    className,
}: {
    status?: string;
    unread?: boolean;
    className?: string;
}) {
    const normalized = String(status || '').toUpperCase();

    if (normalized.includes('RUNNING')) {
        return (
            <span
                className={cn('inline-flex h-3 w-3 shrink-0 animate-spin rounded-full border-[1.5px] border-emerald-400/25 border-t-emerald-400', className)}
                title="Running"
                aria-label="Running"
            />
        );
    }
    if (normalized.includes('WAITING')) {
        return (
            <span
                className={cn('inline-flex h-3 w-3 shrink-0 rounded-full border-[1.5px] border-amber-400', className)}
                title="Waiting for input"
                aria-label="Waiting for input"
            />
        );
    }
    if (normalized.includes('FAILED')) {
        return <span className={cn('inline-flex h-2 w-2 shrink-0 rounded-full bg-red-400', className)} title="Failed" aria-label="Failed" />;
    }
    if (unread) {
        return <span className={cn('inline-flex h-2 w-2 shrink-0 rounded-full bg-sky-400', className)} title="Completed, unread" aria-label="Completed, unread" />;
    }
    return null;
}
