/**
 * Mock ACP agent subprocess for integration testing.
 *
 * Communicates via stdin/stdout using NDJSON (the ACP protocol transport).
 * Stdout must remain clean NDJSON — all diagnostic output goes to stderr.
 *
 * Usage:
 *   node --import tsx tests/helpers/mock-agent.ts
 */

import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type AuthenticateRequest,
} from '@agentclientprotocol/sdk';

// Redirect console.log/info to stderr so stdout stays clean NDJSON.
const log = (...args: unknown[]) => process.stderr.write('[mock-agent] ' + args.join(' ') + '\n');

function createAgent(connection: AgentSideConnection): Agent {
  // Per-session cancel flags.
  const cancelledSessions = new Set<string>();

  return {
    async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
      log('initialize called');
      return {
        protocolVersion: PROTOCOL_VERSION,
        agentInfo: { name: 'mock-agent', version: '0.0.1' },
        agentCapabilities: {},
      };
    },

    async authenticate(_params: AuthenticateRequest) {
      log('authenticate called');
      return {};
    },

    async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
      const sessionId = `mock-session-${Date.now()}`;
      log(`newSession called → ${sessionId}`);
      return { sessionId };
    },

    async prompt(params: PromptRequest): Promise<PromptResponse> {
      const { sessionId } = params;
      log(`prompt called for session ${sessionId}`);

      // 1. agent_message_chunk: "Hello from mock agent!"
      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Hello from mock agent!' },
        },
      });

      // 2. tool_call: pending read
      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'tc-1',
          title: 'Read file.ts',
          kind: 'read',
          status: 'pending',
        },
      });

      // 3. tool_call_update: completed with content
      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'tc-1',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'file contents here' },
            },
          ],
        },
      });

      // 4. agent_message_chunk: " Done."
      await connection.sessionUpdate({
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' Done.' },
        },
      });

      const cancelled = cancelledSessions.has(sessionId);
      log(`prompt finishing, cancelled=${cancelled}`);
      return { stopReason: cancelled ? 'cancelled' : 'end_turn' };
    },

    async cancel(params: CancelNotification): Promise<void> {
      log(`cancel called for session ${params.sessionId}`);
      cancelledSessions.add(params.sessionId);
    },
  };
}

// Build the ACP stream from stdin/stdout.
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const stream = ndJsonStream(output, input);

const connection = new AgentSideConnection(createAgent, stream);

log('mock-agent ready, waiting for connection…');

// Keep the process alive until the connection closes.
connection.closed.then(() => {
  log('connection closed, exiting');
  process.exit(0);
});
