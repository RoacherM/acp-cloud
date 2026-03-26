import { spawn as cpSpawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Agent,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AgentDefinition } from './types.js';

// ── Public interfaces ───────────────────────────────────────────────────

export interface ClientHandlers {
  onSessionUpdate: (notification: SessionNotification) => void;
  onPermissionRequest: (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;
}

export interface AgentHandle {
  pid: number;
  connection: ClientSideConnection;
  agentInfo: { name: string; version: string };
  process: ChildProcess;
  handlers: ClientHandlers;
}

export interface AgentPoolConfig {
  agents: Record<string, AgentDefinition>;
}

// ── AgentPool ───────────────────────────────────────────────────────────

export class AgentPool {
  private readonly config: AgentPoolConfig;
  private readonly handles = new Set<AgentHandle>();
  private totalSpawned = 0;
  private totalCrashed = 0;

  constructor(config: AgentPoolConfig) {
    this.config = config;
  }

  getAgentIds(): string[] {
    return Object.keys(this.config.agents);
  }

  async spawn(agentId: string): Promise<AgentHandle> {
    const def = this.config.agents[agentId];
    if (!def) {
      throw new Error(`Unknown agent: ${agentId}`);
    }

    // 1. Spawn the child process
    const child = cpSpawn(def.command, def.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...def.env },
    });

    // 2. Convert Node streams to Web streams
    const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;

    // 3. Build the NDJSON stream (writable first, readable second)
    const stream = ndJsonStream(output, input);

    // 4. Create mutable handlers reference with defaults
    const handlersRef: ClientHandlers = {
      onSessionUpdate: () => {},
      onPermissionRequest: async (params) => ({
        outcome: {
          outcome: 'selected' as const,
          optionId: params.options[0].optionId,
        },
      }),
    };

    // 5. Create Client that delegates to handlersRef
    const client: Client = {
      async sessionUpdate(notification: SessionNotification): Promise<void> {
        handlersRef.onSessionUpdate(notification);
      },
      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        return handlersRef.onPermissionRequest(params);
      },
    };

    // 6. Create the client-side ACP connection
    const connection = new ClientSideConnection((_agent: Agent) => client, stream);

    // 7. Initialize the ACP protocol
    const initResponse = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: 'acp-cloud-runtime', version: '0.1.0' },
    });

    // 8. Build the handle
    const handle: AgentHandle = {
      pid: child.pid!,
      connection,
      agentInfo: {
        name: initResponse.agentInfo.name,
        version: initResponse.agentInfo.version,
      },
      process: child,
      handlers: handlersRef,
    };

    // 9. Track and listen for exit
    this.handles.add(handle);
    this.totalSpawned++;

    child.on('exit', (code, signal) => {
      this.handles.delete(handle);
      // Crashed = exited unexpectedly (non-zero code or signal, and still tracked)
      if (code !== 0 && code !== null) {
        this.totalCrashed++;
      } else if (signal !== null) {
        // Killed by signal — not a crash if we initiated it via kill()
        // We already removed from handles, so no further tracking needed
      }
    });

    return handle;
  }

  kill(handle: AgentHandle): void {
    this.handles.delete(handle);
    handle.process.kill('SIGTERM');
  }

  killAll(): void {
    for (const handle of this.handles) {
      handle.process.kill('SIGTERM');
    }
    this.handles.clear();
  }

  isAlive(handle: AgentHandle): boolean {
    try {
      process.kill(handle.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  stats(): { active: number; totalSpawned: number; totalCrashed: number } {
    return {
      active: this.handles.size,
      totalSpawned: this.totalSpawned,
      totalCrashed: this.totalCrashed,
    };
  }
}
