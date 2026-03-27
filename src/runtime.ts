// src/runtime.ts
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { AgentPool, type AgentHandle } from './agent-pool.js';
import { SessionController } from './session-controller.js';
import { MemorySessionStore } from './stores/memory.js';
import type {
  RuntimeConfig,
  SessionStore,
  SessionInfo,
  RunInfo,
  CreateSessionOptions,
  PermissionMode,
  SessionFilter,
} from './types.js';
import { toSessionInfo, derivePublicStatus } from './types.js';
import type { SessionEvent } from './events.js';

export class CloudRuntime {
  private pool: AgentPool;
  private store: SessionStore;
  private controllers = new Map<string, SessionController>();
  private handleToSession = new Map<AgentHandle, string>();
  private pendingCreations = 0;
  private config: {
    defaultPermissionMode: PermissionMode;
    maxAgentProcesses: number;
    maxActiveSessions: number;
  };

  constructor(config: RuntimeConfig) {
    this.store = config.sessionStore ?? new MemorySessionStore();
    this.config = {
      defaultPermissionMode: config.defaultPermissionMode ?? 'approve-all',
      maxAgentProcesses: config.maxAgentProcesses ?? 20,
      maxActiveSessions: config.maxActiveSessions ?? 50,
    };

    this.pool = new AgentPool({
      agents: config.agents,
      onProcessExit: (handle, code, signal) => {
        this.handleProcessExit(handle, code, signal);
      },
    });
  }

  // ── Lifecycle ───────────────────────────────────────────────────────

  async createSession(opts: CreateSessionOptions): Promise<SessionInfo> {
    // Admission control: synchronous check + reservation
    const currentActive = this.controllers.size + this.pendingCreations;
    if (currentActive >= this.config.maxActiveSessions) {
      throw new Error('Max active sessions reached');
    }
    if (this.pool.stats().active + this.pendingCreations >= this.config.maxAgentProcesses) {
      throw new Error('Max agent processes reached');
    }
    this.pendingCreations++;

    try {
      const ctrl = await SessionController.create({
        agentId: opts.agent,
        cwd: opts.cwd,
        permissionMode: opts.permissionMode ?? this.config.defaultPermissionMode,
        mcpServers: opts.mcpServers,
        pool: this.pool,
        store: this.store,
      });

      this.controllers.set(ctrl.sessionId, ctrl);

      // Map handle → sessionId for crash lookup
      const handle = ctrl.getHandle();
      if (handle) {
        this.handleToSession.set(handle, ctrl.sessionId);
      }

      return toSessionInfo(ctrl.getRecord(), 'ready');
    } finally {
      this.pendingCreations--;
    }
  }

  async getSession(id: string): Promise<SessionInfo | null> {
    const record = await this.store.get(id);
    if (!record) return null;
    const ctrl = this.controllers.get(id);
    if (ctrl) {
      return toSessionInfo(record, ctrl.publicStatus);
    }
    return toSessionInfo(record, derivePublicStatus(record, null));
  }

  async listSessions(filter?: SessionFilter): Promise<SessionInfo[]> {
    const records = await this.store.list(filter);
    return records.map(record => {
      const ctrl = this.controllers.get(record.id);
      if (ctrl) {
        return toSessionInfo(record, ctrl.publicStatus);
      }
      return toSessionInfo(record, derivePublicStatus(record, null));
    });
  }

  async closeSession(id: string): Promise<void> {
    const ctrl = this.controllers.get(id);
    if (!ctrl) return;

    const handle = ctrl.getHandle();
    if (handle) {
      this.handleToSession.delete(handle);
    }

    await ctrl.close();
    this.controllers.delete(id);
  }

  // ── Prompting ───────────────────────────────────────────────────────

  async promptSession(id: string, content: ContentBlock[]): Promise<RunInfo> {
    const ctrl = this.controllers.get(id);
    if (!ctrl) throw new Error(`Session not found: ${id}`);
    return ctrl.prompt(content);
  }

  // ── Events ──────────────────────────────────────────────────────────

  subscribeSession(id: string): AsyncIterable<SessionEvent> {
    const ctrl = this.controllers.get(id);
    if (!ctrl) {
      return {
        [Symbol.asyncIterator]() {
          return { async next() { return { done: true, value: undefined }; } };
        },
      };
    }
    return ctrl.subscribe();
  }

  // ── Discovery ─────────────────────────────────────────────────────

  listAgents(): string[] {
    return this.pool.getAgentIds();
  }

  // ── Shutdown ──────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    await Promise.all(
      Array.from(this.controllers.values()).map(ctrl => ctrl.close()),
    );
    this.controllers.clear();
    this.handleToSession.clear();
    this.pool.killAll();
  }

  // ── Private ───────────────────────────────────────────────────────

  private handleProcessExit(handle: AgentHandle, _code: number | null, _signal: string | null): void {
    const sessionId = this.handleToSession.get(handle);
    if (!sessionId) return;

    const ctrl = this.controllers.get(sessionId);
    if (!ctrl) return;

    this.handleToSession.delete(handle);
    ctrl.handleCrash();
    this.controllers.delete(sessionId);
  }
}
