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
  type AgentCapabilities,
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
  agentCapabilities: AgentCapabilities;
  process: ChildProcess;
  handlers: ClientHandlers;
}

export interface AgentPoolConfig {
  agents: Record<string, AgentDefinition>;
  onProcessExit?: (handle: AgentHandle, code: number | null, signal: string | null) => void;
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

    const child = cpSpawn(def.command, def.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...def.env },
    });

    const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;

    const stream = ndJsonStream(output, input);

    const handlersRef: ClientHandlers = {
      onSessionUpdate: () => {},
      onPermissionRequest: async () => {
        throw new Error('Permission request received before handler was wired');
      },
    };

    const client: Client = {
      async sessionUpdate(notification: SessionNotification): Promise<void> {
        handlersRef.onSessionUpdate(notification);
      },
      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        return handlersRef.onPermissionRequest(params);
      },
    } as any;

    const connection = new ClientSideConnection((_agent: Agent) => client, stream);

    const initResponse = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        terminal: false,
      },
      clientInfo: { name: 'acp-cloud-runtime', version: '0.1.0' },
    });

    const handle: AgentHandle = {
      pid: child.pid!,
      connection,
      agentInfo: {
        name: initResponse.agentInfo.name,
        version: initResponse.agentInfo.version,
      },
      agentCapabilities: initResponse.agentCapabilities ?? {},
      process: child,
      handlers: handlersRef,
    };

    this.handles.add(handle);
    this.totalSpawned++;

    child.on('exit', (code, signal) => {
      this.handles.delete(handle);
      // Crashed = exited unexpectedly (non-zero code or signal, and still tracked)
      if (code !== 0 && code !== null) {
        this.totalCrashed++;
      }
      this.config.onProcessExit?.(handle, code, signal);
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
