// src/events.ts
import type {
  SessionNotification,
  SessionUpdate,
  ContentBlock,
  ContentChunk,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  PlanEntry,
  AvailableCommand,
  SessionConfigOption,
  Cost,
  StopReason,
  PermissionOption,
} from '@agentclientprotocol/sdk';

import type { SessionStatus, StatusChangeReason } from './types.js';

// ── ACP event subset (returned by converter, supports runId injection) ───

export type AcpSessionEvent =
  | UserMessageChunkEvent
  | AgentMessageChunkEvent
  | AgentThoughtChunkEvent
  | ToolCallEvent
  | ToolCallUpdateEvent
  | PlanEvent
  | AvailableCommandsUpdateEvent
  | CurrentModeUpdateEvent
  | ConfigOptionUpdateEvent
  | SessionInfoUpdateEvent
  | UsageUpdateEvent;

// ── SessionEvent: full union covering ACP + lifecycle events ────────────

export type SessionEvent =
  | AcpSessionEvent
  | RunStartedEvent
  | RunCompletedEvent
  | SessionStatusChangedEvent;

// ── ACP session/update events (with optional runId) ─────────────────────

export interface UserMessageChunkEvent {
  type: 'user_message_chunk';
  sessionId: string;
  runId?: string;
  content: ContentBlock;
  messageId?: string | null;
}

export interface AgentMessageChunkEvent {
  type: 'agent_message_chunk';
  sessionId: string;
  runId?: string;
  content: ContentBlock;
  messageId?: string | null;
}

export interface AgentThoughtChunkEvent {
  type: 'agent_thought_chunk';
  sessionId: string;
  runId?: string;
  content: ContentBlock;
  messageId?: string | null;
}

export interface ToolCallEvent {
  type: 'tool_call';
  sessionId: string;
  runId?: string;
  toolCallId: string;
  title: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  locations?: ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface ToolCallUpdateEvent {
  type: 'tool_call_update';
  sessionId: string;
  runId?: string;
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ToolCallContent[] | null;
  locations?: ToolCallLocation[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

export interface PlanEvent {
  type: 'plan';
  sessionId: string;
  runId?: string;
  entries: PlanEntry[];
}

export interface AvailableCommandsUpdateEvent {
  type: 'available_commands_update';
  sessionId: string;
  runId?: string;
  availableCommands: AvailableCommand[];
}

export interface CurrentModeUpdateEvent {
  type: 'current_mode_update';
  sessionId: string;
  runId?: string;
  currentModeId: string;
}

export interface ConfigOptionUpdateEvent {
  type: 'config_option_update';
  sessionId: string;
  runId?: string;
  configOptions: SessionConfigOption[];
}

export interface SessionInfoUpdateEvent {
  type: 'session_info_update';
  sessionId: string;
  runId?: string;
  title?: string | null;
  updatedAt?: string | null;
}

export interface UsageUpdateEvent {
  type: 'usage_update';
  sessionId: string;
  runId?: string;
  size: number;
  used: number;
  cost?: Cost | null;
}

// ── Lifecycle events (emitted by SessionController) ─────────────────────

export interface RunStartedEvent {
  type: 'run_started';
  sessionId: string;
  runId: string;
}

export interface RunCompletedEvent {
  type: 'run_completed';
  sessionId: string;
  runId: string;
  stopReason: StopReason;
}

export interface SessionStatusChangedEvent {
  type: 'session_status_changed';
  sessionId: string;
  from: SessionStatus;
  to: SessionStatus;
  reason: StatusChangeReason;
}

// ── Converter: ACP SessionNotification → SessionEvent ───────────────────

/**
 * Converts a raw ACP SessionNotification into a typed AcpSessionEvent.
 * Accepts an optional `overrideSessionId` to replace the ACP-internal session ID
 * with the cloud runtime's public session ID.
 */
export function sessionUpdateToSessionEvent(
  notification: SessionNotification,
  overrideSessionId?: string,
): AcpSessionEvent {
  const sessionId = overrideSessionId ?? notification.sessionId;
  const { update } = notification;

  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return { type: 'user_message_chunk', sessionId, content: update.content, messageId: update.messageId };
    case 'agent_message_chunk':
      return { type: 'agent_message_chunk', sessionId, content: update.content, messageId: update.messageId };
    case 'agent_thought_chunk':
      return { type: 'agent_thought_chunk', sessionId, content: update.content, messageId: update.messageId };
    case 'tool_call':
      return {
        type: 'tool_call', sessionId, toolCallId: update.toolCallId, title: update.title,
        kind: update.kind, status: update.status, content: update.content,
        locations: update.locations, rawInput: update.rawInput, rawOutput: update.rawOutput,
      };
    case 'tool_call_update':
      return {
        type: 'tool_call_update', sessionId, toolCallId: update.toolCallId,
        title: update.title, kind: update.kind, status: update.status, content: update.content,
        locations: update.locations, rawInput: update.rawInput, rawOutput: update.rawOutput,
      };
    case 'plan':
      return { type: 'plan', sessionId, entries: update.entries };
    case 'available_commands_update':
      return { type: 'available_commands_update', sessionId, availableCommands: update.availableCommands };
    case 'current_mode_update':
      return { type: 'current_mode_update', sessionId, currentModeId: update.currentModeId };
    case 'config_option_update':
      return { type: 'config_option_update', sessionId, configOptions: update.configOptions };
    case 'session_info_update':
      return { type: 'session_info_update', sessionId, title: update.title, updatedAt: update.updatedAt };
    case 'usage_update':
      return { type: 'usage_update', sessionId, size: update.size, used: update.used, cost: update.cost };
    default: {
      const _exhaustive: never = update;
      throw new Error(`Unknown session update type: ${(update as SessionUpdate).sessionUpdate}`);
    }
  }
}

// ── Re-exports ──────────────────────────────────────────────────────────

export type {
  SessionNotification, SessionUpdate, ContentBlock, ContentChunk,
  ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind,
  PlanEntry, AvailableCommand, SessionConfigOption,
  Cost, StopReason, PermissionOption,
};
