import type {
  SessionNotification,
  SessionUpdate,
  ContentBlock,
  ContentChunk,
  ToolCall,
  ToolCallUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  Plan,
  PlanEntry,
  AvailableCommandsUpdate,
  AvailableCommand,
  CurrentModeUpdate,
  ConfigOptionUpdate,
  SessionConfigOption,
  SessionInfoUpdate,
  UsageUpdate,
  Cost,
  StopReason,
  PermissionOption,
} from '@agentclientprotocol/sdk';

// ── RunEvent: flattened union mirroring SessionUpdate variants ──────────

export type RunEvent =
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

// ── Individual event types ─────────────────────────────────────────────

export interface UserMessageChunkEvent {
  type: 'user_message_chunk';
  sessionId: string;
  content: ContentBlock;
  messageId?: string | null;
}

export interface AgentMessageChunkEvent {
  type: 'agent_message_chunk';
  sessionId: string;
  content: ContentBlock;
  messageId?: string | null;
}

export interface AgentThoughtChunkEvent {
  type: 'agent_thought_chunk';
  sessionId: string;
  content: ContentBlock;
  messageId?: string | null;
}

export interface ToolCallEvent {
  type: 'tool_call';
  sessionId: string;
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
  entries: PlanEntry[];
}

export interface AvailableCommandsUpdateEvent {
  type: 'available_commands_update';
  sessionId: string;
  availableCommands: AvailableCommand[];
}

export interface CurrentModeUpdateEvent {
  type: 'current_mode_update';
  sessionId: string;
  currentModeId: string;
}

export interface ConfigOptionUpdateEvent {
  type: 'config_option_update';
  sessionId: string;
  configOptions: SessionConfigOption[];
}

export interface SessionInfoUpdateEvent {
  type: 'session_info_update';
  sessionId: string;
  title?: string | null;
  updatedAt?: string | null;
}

export interface UsageUpdateEvent {
  type: 'usage_update';
  sessionId: string;
  size: number;
  used: number;
  cost?: Cost | null;
}

// ── Converter ──────────────────────────────────────────────────────────

/**
 * Converts a raw ACP SessionNotification into a flattened RunEvent.
 *
 * Maps 1:1 from the discriminated `sessionUpdate` field on SessionUpdate
 * to the `type` field on RunEvent, pulling relevant fields up to top level.
 */
export function sessionUpdateToRunEvent(notification: SessionNotification): RunEvent {
  const { sessionId, update } = notification;

  switch (update.sessionUpdate) {
    case 'user_message_chunk':
      return {
        type: 'user_message_chunk',
        sessionId,
        content: update.content,
        messageId: update.messageId,
      };

    case 'agent_message_chunk':
      return {
        type: 'agent_message_chunk',
        sessionId,
        content: update.content,
        messageId: update.messageId,
      };

    case 'agent_thought_chunk':
      return {
        type: 'agent_thought_chunk',
        sessionId,
        content: update.content,
        messageId: update.messageId,
      };

    case 'tool_call':
      return {
        type: 'tool_call',
        sessionId,
        toolCallId: update.toolCallId,
        title: update.title,
        kind: update.kind,
        status: update.status,
        content: update.content,
        locations: update.locations,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
      };

    case 'tool_call_update':
      return {
        type: 'tool_call_update',
        sessionId,
        toolCallId: update.toolCallId,
        title: update.title,
        kind: update.kind,
        status: update.status,
        content: update.content,
        locations: update.locations,
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
      };

    case 'plan':
      return {
        type: 'plan',
        sessionId,
        entries: update.entries,
      };

    case 'available_commands_update':
      return {
        type: 'available_commands_update',
        sessionId,
        availableCommands: update.availableCommands,
      };

    case 'current_mode_update':
      return {
        type: 'current_mode_update',
        sessionId,
        currentModeId: update.currentModeId,
      };

    case 'config_option_update':
      return {
        type: 'config_option_update',
        sessionId,
        configOptions: update.configOptions,
      };

    case 'session_info_update':
      return {
        type: 'session_info_update',
        sessionId,
        title: update.title,
        updatedAt: update.updatedAt,
      };

    case 'usage_update':
      return {
        type: 'usage_update',
        sessionId,
        size: update.size,
        used: update.used,
        cost: update.cost,
      };

    default: {
      // Exhaustiveness check: if a new variant is added to the SDK,
      // TypeScript will error here at compile time.
      const _exhaustive: never = update;
      throw new Error(`Unknown session update type: ${(update as SessionUpdate).sessionUpdate}`);
    }
  }
}

// ── Re-exports for downstream convenience ──────────────────────────────

export type {
  SessionNotification,
  SessionUpdate,
  ContentBlock,
  ContentChunk,
  ToolCall,
  ToolCallUpdate,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  Plan,
  PlanEntry,
  AvailableCommandsUpdate,
  AvailableCommand,
  CurrentModeUpdate,
  ConfigOptionUpdate,
  SessionConfigOption,
  SessionInfoUpdate,
  UsageUpdate,
  Cost,
  StopReason,
  PermissionOption,
};
