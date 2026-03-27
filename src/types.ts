// src/types.ts
import type { ContentBlock, StopReason } from '@agentclientprotocol/sdk';

// ── Permission ──────────────────────────────────────────────────────────

export type PermissionMode = 'approve-all' | 'approve-reads' | 'deny-all';

// ── Agent ───────────────────────────────────────────────────────────────

export interface AgentDefinition {
  command: string;
  args: string[];
  env?: Record<string, string>;
  capabilities?: { image?: boolean; audio?: boolean };
}

// ── Session Status ──────────────────────────────────────────────────────

/** Durable status — only states that survive process restart. */
export type RecordStatus = 'ready' | 'terminated';

/** Public status — what clients see via SessionInfo. */
export type SessionStatus = 'ready' | 'busy' | 'terminated';

// ── Session Record (Durable) ────────────────────────────────────────────

export interface SessionRecord {
  id: string;
  acpSessionId: string;
  agentId: string;
  cwd: string;
  permissionMode: PermissionMode;
  status: RecordStatus;
  pid: number | null;
  createdAt: Date;
  lastActivity: Date;
  metadata: Record<string, unknown>;
}

// ── Session Execution (Ephemeral) ───────────────────────────────────────

import type { AgentHandle } from './agent-pool.js';

export interface SessionExecution {
  handle: AgentHandle;
  activeRunId: string | null;
}

// ── Public DTOs ─────────────────────────────────────────────────────────

export interface SessionInfo {
  id: string;
  agentId: string;
  status: SessionStatus;
  createdAt: Date;
  lastActivity: Date;
}

export interface RunInfo {
  id: string;
  sessionId: string;
  status: 'running' | 'completed';
  stopReason: StopReason | null;
}

// ── Status Derivation ───────────────────────────────────────────────────

export function derivePublicStatus(
  record: SessionRecord,
  execution: SessionExecution | null,
): SessionStatus {
  if (record.status === 'terminated') return 'terminated';
  if (execution?.activeRunId) return 'busy';
  return 'ready';
}

export function toSessionInfo(
  record: SessionRecord,
  execution: SessionExecution | null,
): SessionInfo {
  return {
    id: record.id,
    agentId: record.agentId,
    status: derivePublicStatus(record, execution),
    createdAt: record.createdAt,
    lastActivity: record.lastActivity,
  };
}

// ── Status Change Reason ────────────────────────────────────────────────

export type StatusChangeReason =
  | 'prompt_started'
  | 'run_completed'
  | 'user_closed'
  | 'agent_crashed'
  | 'init_failed';

// ── Session Filter ──────────────────────────────────────────────────────

export interface SessionFilter {
  agentId?: string;
  status?: RecordStatus | RecordStatus[];
}

// ── Create Session Options ──────────────────────────────────────────────

export interface CreateSessionOptions {
  agent: string;
  cwd: string;
  permissionMode?: PermissionMode;
  mcpServers?: Array<{ name: string; transport: unknown }>;
}

// ── Runtime Config ──────────────────────────────────────────────────────

export interface RuntimeConfig {
  agents: Record<string, AgentDefinition>;
  sessionStore?: SessionStore;
  defaultPermissionMode?: PermissionMode;
  maxAgentProcesses?: number;
  maxActiveSessions?: number;
}

// ── Session Store ───────────────────────────────────────────────────────

export interface SessionStore {
  create(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  update(record: SessionRecord): Promise<void>;
  delete(id: string): Promise<void>;
  list(filter?: SessionFilter): Promise<SessionRecord[]>;
}

// ── Re-exports for convenience ──────────────────────────────────────────

export type { ContentBlock, StopReason } from '@agentclientprotocol/sdk';
