'use client';

import { useState, useEffect, useRef, useCallback, memo } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { wsService } from '@/lib/ws-service';
import { Trash2, ArrowDown, MessageSquare } from 'lucide-react';
import { TRANSPORT_CONFIG, LOG_COLORS, LOG_ICONS, formatTimestamp } from '@/lib/agent-utils';
import type { AgentLogEntry } from '@/lib/agent-api';

const MAX_LOG_ENTRIES = 500;

const TRANSPORT_FILTERS = ['All', 'Discord', 'WS', 'HTTP', 'UI'] as const;
const LEVEL_FILTERS = ['All', 'Info', 'Warn', 'Error'] as const;

function getTransportFilter(transport: string): string {
    if (transport === 'discord') return 'Discord';
    if (transport === 'websocket' || transport === 'websocket-ui') return transport === 'websocket-ui' ? 'UI' : 'WS';
    if (transport === 'http') return 'HTTP';
    return 'WS';
}

function getLevelFilter(logType: string): string {
    if (logType === 'error') return 'Error';
    if (logType === 'warn' || logType === 'warning') return 'Warn';
    return 'Info';
}

// ── Log Entry (memoized) ────────────────────────────────────────────────

const LogEntry = memo(function LogEntry({ entry }: { entry: AgentLogEntry }) {
    const transport = TRANSPORT_CONFIG[entry.transport] || TRANSPORT_CONFIG.unknown;
    const color = LOG_COLORS[entry.logType] || LOG_COLORS.system;
    const Icon = LOG_ICONS[entry.logType] || MessageSquare;
    const time = formatTimestamp(entry.timestamp);

    return (
        <div className="flex items-start gap-2 px-3 py-1.5 border-b border-border/5 hover:bg-muted/5 transition-colors">
            <span className="text-[9px] text-muted-foreground/25 font-mono shrink-0 mt-0.5 w-[52px]">{time}</span>
            <Badge variant="outline" className={cn('text-[8px] px-1 py-0 shrink-0', transport.color, transport.bg)}>
                {transport.label}
            </Badge>
            <span className="text-[9px] text-muted-foreground/30 font-mono shrink-0 w-[32px]">
                {entry.sessionId?.substring(0, 4) || '----'}
            </span>
            <Icon className={cn('w-3 h-3 mt-0.5 shrink-0', color)} />
            <p className={cn('text-[10px] break-words leading-relaxed flex-1 min-w-0', color)}>
                {entry.message}
            </p>
        </div>
    );
});

// ── Main Panel ──────────────────────────────────────────────────────────

export function AgentLogsPanel() {
    const [entries, setEntries] = useState<AgentLogEntry[]>([]);
    const [transportFilter, setTransportFilter] = useState<string>('All');
    const [levelFilter, setLevelFilter] = useState<string>('All');
    const [autoScroll, setAutoScroll] = useState(true);
    const bottomRef = useRef<HTMLDivElement>(null);
    const scrollContainerRef = useRef<HTMLDivElement>(null);

    // WS listener for log events
    useEffect(() => {
        if (!wsService) return;
        const off = wsService.on('agent_sessions', (data) => {
            if (data.event !== 'session_log') return;
            const entry: AgentLogEntry = {
                sessionId: data.sessionId as string,
                transport: data.transport as string,
                logType: data.logType as string,
                message: data.message as string,
                timestamp: (data.timestamp as number) || Date.now(),
            };
            setEntries(prev => {
                const next = [...prev, entry];
                return next.length > MAX_LOG_ENTRIES ? next.slice(-MAX_LOG_ENTRIES) : next;
            });
        });
        return off;
    }, []);

    // Auto-scroll
    useEffect(() => {
        if (autoScroll) {
            bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [entries.length, autoScroll]);

    // Detect manual scroll up
    const handleScroll = useCallback(() => {
        const el = scrollContainerRef.current;
        if (!el) return;
        const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
        setAutoScroll(atBottom);
    }, []);

    const handleClear = useCallback(() => { setEntries([]); }, []);

    // Filter entries
    const filtered = entries.filter(e => {
        if (transportFilter !== 'All' && getTransportFilter(e.transport) !== transportFilter) return false;
        if (levelFilter !== 'All' && getLevelFilter(e.logType) !== levelFilter) return false;
        return true;
    });

    return (
        <div className="flex flex-col h-full">
            {/* Filters */}
            <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/20 shrink-0">
                <div className="flex items-center gap-0.5">
                    {TRANSPORT_FILTERS.map(f => (
                        <Button key={f} variant={transportFilter === f ? 'secondary' : 'ghost'}
                            size="sm" className="h-5 text-[9px] px-1.5"
                            onClick={() => setTransportFilter(f)}>
                            {f}
                        </Button>
                    ))}
                </div>
                <span className="text-muted-foreground/20">|</span>
                <div className="flex items-center gap-0.5">
                    {LEVEL_FILTERS.map(f => (
                        <Button key={f} variant={levelFilter === f ? 'secondary' : 'ghost'}
                            size="sm" className="h-5 text-[9px] px-1.5"
                            onClick={() => setLevelFilter(f)}>
                            {f}
                        </Button>
                    ))}
                </div>
                <div className="flex-1" />
                <span className="text-[9px] text-muted-foreground/30">{filtered.length}</span>
                <Button variant="ghost" size="icon" className="h-5 w-5" onClick={handleClear} title="Clear logs">
                    <Trash2 className="h-3 w-3 text-muted-foreground/30" />
                </Button>
            </div>

            {/* Log entries */}
            <div className="flex-1 overflow-y-auto" ref={scrollContainerRef} onScroll={handleScroll}>
                {filtered.length === 0 ? (
                    <div className="flex items-center justify-center h-full">
                        <p className="text-[10px] text-muted-foreground/30">No log entries</p>
                    </div>
                ) : (
                    filtered.map((e, i) => <LogEntry key={`${e.timestamp}-${i}`} entry={e} />)
                )}
                <div ref={bottomRef} />
            </div>

            {/* Scroll to bottom button */}
            {!autoScroll && (
                <div className="absolute bottom-12 right-4">
                    <Button size="icon" variant="secondary" className="h-7 w-7 rounded-full shadow-lg"
                        onClick={() => { setAutoScroll(true); bottomRef.current?.scrollIntoView({ behavior: 'smooth' }); }}>
                        <ArrowDown className="h-3 w-3" />
                    </Button>
                </div>
            )}
        </div>
    );
}
