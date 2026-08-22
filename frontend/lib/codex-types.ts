export interface CodexWorkspace {
  id: string;
  name: string;
  path: string;
  git: boolean;
}

export interface CodexModel {
  id: string;
  model: string;
  displayName: string;
  description: string;
  isDefault: boolean;
}

export interface CodexThreadItem {
  type: string;
  id?: string;
  text?: string;
  content?: Array<{ type: string; text?: string; url?: string; path?: string }>;
  summary?: string[];
  command?: string;
  cwd?: string;
  status?: string;
  aggregatedOutput?: string | null;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: Array<{ path: string; kind: string; diff: string }>;
  server?: string;
  tool?: string;
  arguments?: unknown;
  result?: unknown;
  error?: unknown;
  [key: string]: unknown;
}

export interface CodexTurn {
  id: string;
  items: CodexThreadItem[];
  status: 'completed' | 'interrupted' | 'failed' | 'inProgress';
  error?: unknown;
  startedAt?: number | null;
  completedAt?: number | null;
  durationMs?: number | null;
}

export interface CodexThread {
  id: string;
  preview: string;
  name: string | null;
  cwd: string;
  modelProvider: string;
  createdAt: number;
  updatedAt: number;
  status: { type: string; activeFlags?: string[] };
  turns: CodexTurn[];
}

export interface CodexServerRequest {
  requestId: string;
  method: string;
  params: {
    threadId?: string;
    turnId?: string;
    itemId?: string;
    command?: string | null;
    cwd?: string | null;
    reason?: string | null;
    grantRoot?: string | null;
    [key: string]: unknown;
  };
}

export interface CodexEvent {
  method: string;
  params: Record<string, unknown> & {
    threadId?: string;
    turnId?: string;
    itemId?: string;
    delta?: string;
    item?: CodexThreadItem;
    turn?: CodexTurn;
    thread?: CodexThread;
  };
}
