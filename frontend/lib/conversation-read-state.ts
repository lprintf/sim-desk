'use client';

import { useEffect, useMemo, useState } from 'react';

const STORAGE_KEY = 'sim-desk-conversation-read-state-v1';
const CHANGE_EVENT = 'sim-desk-conversation-read-state-changed';
const MAX_MARKERS = 2000;

interface ReadState {
    version: 1;
    baselineAt: number;
    readThrough: Record<string, number>;
}

export interface ReadableConversation {
    id: string;
    lastModifiedTime: string;
    status?: string;
}

function modifiedAt(conversation: ReadableConversation): number {
    const value = Date.parse(conversation.lastModifiedTime || '');
    return Number.isFinite(value) ? value : 0;
}

function loadState(): ReadState {
    const fallback: ReadState = { version: 1, baselineAt: Date.now(), readThrough: {} };
    if (typeof window === 'undefined') return fallback;
    try {
        const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null') as Partial<ReadState> | null;
        if (parsed?.version === 1 && Number.isFinite(parsed.baselineAt) && parsed.readThrough) {
            return {
                version: 1,
                baselineAt: Number(parsed.baselineAt),
                readThrough: parsed.readThrough,
            };
        }
    } catch { }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback));
    return fallback;
}

function saveState(state: ReadState) {
    const entries = Object.entries(state.readThrough)
        .sort((a, b) => b[1] - a[1])
        .slice(0, MAX_MARKERS);
    localStorage.setItem(STORAGE_KEY, JSON.stringify({
        ...state,
        readThrough: Object.fromEntries(entries),
    }));
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

export function isConversationActive(status?: string): boolean {
    const normalized = String(status || '').toUpperCase();
    return normalized.includes('RUNNING') || normalized.includes('WAITING');
}

export function markConversationRead(id: string, lastModifiedTime = '') {
    if (typeof window === 'undefined' || !id) return;
    const state = loadState();
    const readThrough = Math.max(Date.now(), Date.parse(lastModifiedTime || '') || 0);
    if ((state.readThrough[id] || 0) >= readThrough) return;
    saveState({
        ...state,
        readThrough: { ...state.readThrough, [id]: readThrough },
    });
}

export function useConversationUnread(
    conversations: ReadableConversation[],
    currentConversationId: string | null = null,
): ReadonlySet<string> {
    const [state, setState] = useState<ReadState | null>(null);

    useEffect(() => {
        const refresh = () => setState(loadState());
        const onStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY) refresh();
        };
        refresh();
        window.addEventListener(CHANGE_EVENT, refresh);
        window.addEventListener('storage', onStorage);
        return () => {
            window.removeEventListener(CHANGE_EVENT, refresh);
            window.removeEventListener('storage', onStorage);
        };
    }, []);

    useEffect(() => {
        if (!currentConversationId) return;
        const current = conversations.find((conversation) => conversation.id === currentConversationId);
        if (current && !isConversationActive(current.status)) {
            markConversationRead(current.id, current.lastModifiedTime);
        }
    }, [conversations, currentConversationId]);

    return useMemo(() => {
        const unread = new Set<string>();
        if (!state) return unread;
        for (const conversation of conversations) {
            if (isConversationActive(conversation.status)) continue;
            const normalized = String(conversation.status || '').toUpperCase();
            if (normalized.includes('FAILED') || normalized.includes('CANCELLED')) continue;
            const changedAt = modifiedAt(conversation);
            const readThrough = state.readThrough[conversation.id] || state.baselineAt;
            if (changedAt > readThrough) unread.add(conversation.id);
        }
        return unread;
    }, [conversations, state]);
}
