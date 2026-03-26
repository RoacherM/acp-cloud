export type PermissionMode = 'approve-all' | 'approve-reads' | 'deny-all';
export type NonInteractivePolicy = 'deny' | 'fail';
export type RecoveryPolicy = 'strict-load' | 'fallback-new';

export type SessionStatus =
  | 'creating' | 'initializing' | 'ready' | 'running'
  | 'sleeping' | 'waking' | 'crashed' | 'recovering' | 'terminated';

export interface AgentDefinition {
  command: string;
  args: string[];
  env?: Record<string, string>;
  capabilities?: { image?: boolean; audio?: boolean };
}

export interface SessionRecord {
  id: string;
  acpSessionId: string;
  agentSessionId: string | null;
  agentId: string;
  cwd: string;
  permissionMode: PermissionMode;
  nonInteractivePolicy: NonInteractivePolicy;
  agentModeId: string | null;
  recoveryPolicy: RecoveryPolicy;
  status: SessionStatus;
  pid: number | null;
  createdAt: Date;
  lastActivity: Date;
  metadata: Record<string, unknown>;
}

export interface SessionFilter {
  agentId?: string;
  status?: SessionStatus | SessionStatus[];
}

export interface CreateSessionOptions {
  agent: string;
  cwd: string;
  permissionMode?: PermissionMode;
  nonInteractivePolicy?: NonInteractivePolicy;
  agentModeId?: string;
  recoveryPolicy?: RecoveryPolicy;
  mcpServers?: Array<{ name: string; transport: unknown }>;
}

export interface RuntimeConfig {
  agents: Record<string, AgentDefinition>;
  sessionStore?: SessionStore;
  defaultPermissionMode?: PermissionMode;
  defaultNonInteractivePolicy?: NonInteractivePolicy;
  defaultRecoveryPolicy?: RecoveryPolicy;
  maxAgentProcesses?: number;
  maxActiveSessions?: number;
  sessionTTL?: number;
  sleepTTL?: number;
  maxQueueDepth?: number;
}

export interface SessionStore {
  create(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  update(record: SessionRecord): Promise<void>;
  delete(id: string): Promise<void>;
  list(filter?: SessionFilter): Promise<SessionRecord[]>;
  reapStale(maxIdleMs: number): Promise<SessionRecord[]>;
}
