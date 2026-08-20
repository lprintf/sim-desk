'use client';

import { useState, useRef, useEffect, useCallback, memo } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { ScrollArea } from '@/components/ui/scroll-area';
import {
    Wifi, WifiOff, Send, Check, X, RefreshCw, Unplug,
    Loader2, AlertCircle, MessageSquare,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SESSION_STATE_CONFIG } from '@/lib/agent-utils';
import type { UseAgentWsReturn } from '@/hooks/use-agent-ws';
import type { AgentMessage } from '@/lib/agent-api';

interface ChatPanelProps {
    agentWs: UseAgentWsReturn;
    workspaces: string[];
}

// ── Message bubble ──────────────────────────────────────────────────────

const MessageBubble = memo(function MessageBubble({ msg }: { msg: AgentMessage }) {
    if (msg.role === 'system') {
        return (
            <div className="flex justify-center py-1">
                <span className="text-[10px] text-muted-foreground/40 italic text-center max-w-[80%]">
                    {msg.content}
                </span>
            </div>
        );
    }

    const isUser = msg.role === 'user';

    return (
        <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
            <div className={cn(
                'max-w-[85%] rounded-lg px-3 py-2 text-xs',
                isUser
                    ? 'bg-primary/10 text-foreground/80'
                    : 'bg-muted/10 text-foreground/80'
            )}>
                {isUser ? (
                    <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                ) : (
                    <div className="prose prose-invert prose-xs max-w-none [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
                        <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {msg.content}
                        </ReactMarkdown>
                    </div>
                )}
                {msg.stepCount != null && (
                    <div className="text-[9px] text-muted-foreground/30 mt-1">
                        Step {msg.stepIndex}/{msg.stepCount}
                    </div>
                )}
            </div>
        </div>
    );
});

// ── Main Panel ──────────────────────────────────────────────────────────

export function AgentChatPanel({ agentWs, workspaces }: ChatPanelProps) {
    const { state, sessionId, cascadeId, workspace, messages, error } = agentWs;
    const [selectedWorkspace, setSelectedWorkspace] = useState<string>('');
    const [inputText, setInputText] = useState('');
    const bottomRef = useRef<HTMLDivElement>(null);

    const isConnected = state === 'connected' || state === 'busy';
    const isBusy = state === 'busy';

    // Auto-scroll on new messages
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    const handleSend = () => {
        const text = inputText.trim();
        if (!text || isBusy) return;
        agentWs.send(text);
        setInputText('');
    };

    const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);
    const handleDisconnect = useCallback(() => {
        if (!confirmingDisconnect) {
            setConfirmingDisconnect(true);
            setTimeout(() => setConfirmingDisconnect(false), 3000);
            return;
        }
        setConfirmingDisconnect(false);
        agentWs.disconnect();
    }, [confirmingDisconnect, agentWs]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    // ── Not connected state ─────────────────────────────────────────────

    if (!isConnected && state !== 'connecting' && state !== 'reconnecting') {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-4 px-6">
                <div className="w-12 h-12 rounded-2xl bg-muted/10 flex items-center justify-center">
                    <MessageSquare className="h-6 w-6 text-muted-foreground/15" />
                </div>

                <div className="text-center space-y-1">
                    <p className="text-xs text-muted-foreground/50 font-medium">Agent Chat</p>
                    <p className="text-[10px] text-muted-foreground/30">Select a workspace and connect to start</p>
                </div>

                {error && (
                    <div className="flex items-center gap-1.5 text-red-400/70">
                        <AlertCircle className="h-3 w-3" />
                        <span className="text-[10px]">{error}</span>
                    </div>
                )}

                <div className="w-full max-w-[200px] space-y-2">
                    <Select value={selectedWorkspace} onValueChange={setSelectedWorkspace}>
                        <SelectTrigger className="h-8 text-[11px]">
                            <SelectValue placeholder="Select workspace" />
                        </SelectTrigger>
                        <SelectContent>
                            {workspaces.map(ws => (
                                <SelectItem key={ws} value={ws} className="text-[11px]">{ws}</SelectItem>
                            ))}
                        </SelectContent>
                    </Select>

                    <Button
                        size="sm"
                        className="w-full h-8 text-[11px]"
                        disabled={!selectedWorkspace}
                        onClick={() => agentWs.connect(selectedWorkspace)}
                    >
                        <Wifi className="h-3 w-3 mr-1.5" />
                        Connect
                    </Button>
                </div>
            </div>
        );
    }

    // ── Connecting / Reconnecting state ─────────────────────────────────

    if (state === 'connecting' || state === 'reconnecting') {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground/30" />
                <p className="text-[10px] text-muted-foreground/40">
                    {state === 'connecting' ? 'Connecting…' : 'Reconnecting…'}
                </p>
            </div>
        );
    }

    // ── Connected state ─────────────────────────────────────────────────

    return (
        <div className="flex flex-col h-full">
            {/* Session info bar */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-border/20 shrink-0">
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground/60">
                    <span className={cn('w-1.5 h-1.5 rounded-full', isBusy ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400')} />
                    <span className="font-mono">{sessionId?.substring(0, 8)}</span>
                    <span>•</span>
                    <span>{workspace}</span>
                    {cascadeId && (
                        <>
                            <span>•</span>
                            <span className="font-mono">#{cascadeId.substring(0, 8)}</span>
                        </>
                    )}
                </div>
                <span className={cn('text-[9px]', isBusy ? 'text-amber-400' : 'text-emerald-400')}>
                    {isBusy ? 'Processing…' : 'Ready'}
                </span>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-3 space-y-2">
                {messages.map(msg => (
                    <MessageBubble key={msg.id} msg={msg} />
                ))}
                {isBusy && messages[messages.length - 1]?.role === 'user' && (
                    <div className="flex justify-start">
                        <div className="bg-muted/10 rounded-lg px-3 py-2">
                            <Loader2 className="h-3 w-3 animate-spin text-muted-foreground/30" />
                        </div>
                    </div>
                )}
                <div ref={bottomRef} />
            </div>

            {/* Input + Controls */}
            <div className="border-t border-border/20 p-2 space-y-1.5 shrink-0">
                <div className="flex gap-1.5">
                    <Input
                        value={inputText}
                        onChange={e => setInputText(e.target.value)}
                        onKeyDown={handleKeyDown}
                        placeholder={isBusy ? 'Waiting for response…' : 'Send a message…'}
                        disabled={isBusy}
                        className="text-[11px] h-8"
                    />
                    <Button
                        size="icon"
                        className="h-8 w-8 shrink-0"
                        onClick={handleSend}
                        disabled={isBusy || !inputText.trim()}
                    >
                        <Send className="h-3 w-3" />
                    </Button>
                </div>

                {/* Session controls */}
                <div className="flex items-center gap-1">
                    <Button variant="ghost" size="sm" className="h-6 text-[9px] px-1.5"
                        onClick={agentWs.accept} title="Accept code changes">
                        <Check className="h-3 w-3 mr-0.5 text-emerald-400" /> Accept
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 text-[9px] px-1.5"
                        onClick={agentWs.reject} title="Reject code changes">
                        <X className="h-3 w-3 mr-0.5 text-red-400" /> Reject
                    </Button>
                    <Button variant="ghost" size="sm" className="h-6 text-[9px] px-1.5"
                        onClick={agentWs.newCascade} title="New cascade">
                        <RefreshCw className="h-3 w-3 mr-0.5" /> New Cascade
                    </Button>
                    <div className="flex-1" />
                    <Button variant="ghost" size="sm"
                        className={cn('h-6 text-[9px] px-1.5', confirmingDisconnect ? 'text-red-400 font-medium' : 'text-red-400/60 hover:text-red-400')}
                        onClick={handleDisconnect}>
                        <Unplug className="h-3 w-3 mr-0.5" /> {confirmingDisconnect ? 'Confirm?' : 'Disconnect'}
                    </Button>
                </div>
            </div>
        </div>
    );
}
