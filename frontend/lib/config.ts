// === Frontend Configuration ===
// Single-port mode: API and WS are on the same origin as the page.
// No proxy, no CORS, no port discovery needed.

export const API_BASE = typeof window !== 'undefined' && window.location.port === '3000'
    ? `${window.location.protocol}//${window.location.hostname}:3510`
    : '';

// WS URL — same host/port as the page, just switch protocol
let _wsUrl: string | null = null;

export function getWsUrl(): Promise<string> {
    if (_wsUrl) return Promise.resolve(_wsUrl);

    const isBrowser = typeof window !== 'undefined';
    if (!isBrowser) return Promise.resolve('ws://localhost:3510');

    const loc = API_BASE ? new URL(API_BASE) : window.location;
    const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
    _wsUrl = `${proto}://${loc.host}/ws/codex`;
    return Promise.resolve(_wsUrl);
}

/**
 * Agent WebSocket URL — /ws/agent on the same origin.
 */
export async function getAgentWsUrl(): Promise<string> {
    const base = await getWsUrl();
    return `${base}/ws/agent`;
}

/**
 * Orchestrator WebSocket URL — /ws/orchestrator on the same origin.
 */
export async function getOrchestratorWsUrl(): Promise<string> {
    const base = await getWsUrl();
    return `${base}/ws/orchestrator`;
}

// Legacy sync export (used as initial value — overridden when getWsUrl() resolves)
export const WS_URL = '';
