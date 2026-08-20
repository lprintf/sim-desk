import { authHeaders, authWsUrl } from './auth';
import type { CodexModel, CodexThread, CodexWorkspace } from './codex-types';

function backendOrigin(): string {
  if (typeof window === 'undefined') return '';
  if (window.location.port === '3000') {
    return `${window.location.protocol}//${window.location.hostname}:3500`;
  }
  return '';
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${backendOrigin()}${path}`, {
    ...init,
    headers: authHeaders(init?.headers as Record<string, string> | undefined),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Request failed (${response.status})`);
  }
  if (response.status === 204) return undefined as T;
  return response.json();
}

export function codexWebSocketUrl(): string {
  const origin = backendOrigin();
  const base = origin || window.location.origin;
  const url = new URL('/ws/codex', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return authWsUrl(url.toString());
}

export async function getCodexStatus() {
  return api<{ running: boolean; account?: unknown; error?: string }>('/api/codex/status');
}

export async function getCodexWorkspaces() {
  return api<{ data: CodexWorkspace[]; roots: string[] }>('/api/codex/workspaces');
}

export async function getCodexModels() {
  return api<{ data: CodexModel[] }>('/api/codex/models');
}

export async function getCodexThreads(cwd: string) {
  return api<{ data: CodexThread[] }>(`/api/codex/threads?cwd=${encodeURIComponent(cwd)}`);
}

export async function getCodexThread(threadId: string) {
  return api<{ thread: CodexThread }>(`/api/codex/threads/${encodeURIComponent(threadId)}`);
}

export async function createCodexThread(cwd: string, model?: string) {
  return api<{ thread: CodexThread }>('/api/codex/threads', {
    method: 'POST',
    body: JSON.stringify({ cwd, model: model || undefined }),
  });
}

export async function startCodexTurn(threadId: string, text: string) {
  return api<{ turn: import('./codex-types').CodexTurn }>(`/api/codex/threads/${encodeURIComponent(threadId)}/turns`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
}

export async function archiveCodexThread(threadId: string) {
  return api<void>(`/api/codex/threads/${encodeURIComponent(threadId)}/archive`, {
    method: 'POST',
  });
}

export async function interruptCodexTurn(threadId: string, turnId: string) {
  return api<void>(`/api/codex/threads/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/interrupt`, {
    method: 'POST',
  });
}

export async function answerCodexApproval(requestId: string, decision: string) {
  return api<void>(`/api/codex/approvals/${encodeURIComponent(requestId)}`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  });
}
