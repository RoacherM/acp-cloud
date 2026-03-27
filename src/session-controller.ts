// src/session-controller.ts
import { randomUUID } from 'node:crypto';
import type { ContentBlock, StopReason } from '@agentclientprotocol/sdk';
import { AgentPool, type AgentHandle } from './agent-pool.js';
import { PermissionController } from './permission.js';
import { EventHub } from './event-hub.js';
import { sessionUpdateToSessionEvent } from './events.js';
import type { SessionEvent } from './events.js';
import type {
  SessionRecord,
  SessionStore,
  SessionExecution,
  SessionStatus,
  PermissionMode,
  RunInfo,
  StatusChangeReason,
} from './types.js';
import { derivePublicStatus } from './types.js';

// ── Options ─────────────────────────────────────────────────────────────

export interface SessionControllerOptions {
  agentId: string;
  cwd: string;
  permissionMode: PermissionMode;
  pool: AgentPool;
  store: SessionStore;
}

// ── SessionController ───────────────────────────────────────────────────

export class SessionController {
  readonly sessionId: string;
  private record: SessionRecord;
  private execution: SessionExecution | null;
  private pool: AgentPool;
  private store: SessionStore;
  private permissionController: PermissionController;
  private eventHub: EventHub;

  private constructor(
    record: SessionRecord,
    execution: SessionExecution,
    pool: AgentPool,
    store: SessionStore,
    permissionController: PermissionController,
  ) {
    this.sessionId = record.id;
    this.record = record;
    this.execution = execution;
    this.pool = pool;
    this.store = store;
    this.permissionController = permissionController;
    this.eventHub = new EventHub();
  }

  get publicStatus(): SessionStatus {
    return derivePublicStatus(this.record, this.execution);
  }

  getRecord(): SessionRecord {
    return { ...this.record };
  }

  /**
   * Factory: spawns agent, creates ACP session, returns ready controller.
   * Blocks until ready or throws on failure.
   */
  static async create(opts: SessionControllerOptions): Promise<SessionController> {
    const id = randomUUID();
    const now = new Date();

    const handle = await opts.pool.spawn(opts.agentId);

    let acpSessionId: string;
    try {
      const result = await handle.connection.newSession({
        cwd: opts.cwd,
        mcpServers: [] as any,  // protocol compatibility, not a product capability
      });
      acpSessionId = result.sessionId;
    } catch (err) {
      opts.pool.kill(handle);
      throw err;
    }

    const record: SessionRecord = {
      id,
      acpSessionId,
      agentId: opts.agentId,
      cwd: opts.cwd,
      permissionMode: opts.permissionMode,
      status: 'ready',
      pid: handle.pid,
      createdAt: now,
      lastActivity: now,
      metadata: {},
    };

    try {
      await opts.store.create(record);
    } catch (err) {
      opts.pool.kill(handle);
      throw err;
    }

    const execution: SessionExecution = {
      handle,
      activeRunId: null,
    };

    const permissionController = new PermissionController(opts.permissionMode);

    return new SessionController(record, execution, opts.pool, opts.store, permissionController);
  }

  /**
   * Send a prompt. Returns RunInfo immediately; events stream via subscribe().
   */
  async prompt(content: ContentBlock[]): Promise<RunInfo> {
    if (this.publicStatus !== 'ready') {
      throw new Error(`Cannot prompt: session status is '${this.publicStatus}', expected 'ready'`);
    }

    const runId = randomUUID();
    this.execution!.activeRunId = runId;

    this.record.lastActivity = new Date();
    await this.store.update(this.record);

    // Emit status change BEFORE buffer starts — late subscribers should NOT replay the status change
    this.emitStatusChanged('ready', 'busy', 'prompt_started');
    // Buffer starts at run_started — spec: "replay from run_started onward"
    this.eventHub.startRunBuffer(runId);
    this.eventHub.push({ type: 'run_started', sessionId: this.sessionId, runId });

    this.executePrompt(content, runId).catch(() => {
      // Error handling: complete the run with cancelled if not already done
      if (this.execution?.activeRunId === runId) {
        this.completeRun(runId, 'cancelled');
      }
    });

    return {
      id: runId,
      sessionId: this.sessionId,
      status: 'running',
      stopReason: null,
    };
  }

  private async executePrompt(content: ContentBlock[], runId: string): Promise<void> {
    const handle = this.execution!.handle;

    handle.handlers.onSessionUpdate = (notification) => {
      // Override ACP sessionId with our cloud session ID, inject runId
      const event = sessionUpdateToSessionEvent(notification, this.sessionId);
      this.eventHub.push({ ...event, runId });
    };

    handle.handlers.onPermissionRequest = async (request) => {
      return this.permissionController.resolve(request);
    };

    const response = await handle.connection.prompt({
      sessionId: this.record.acpSessionId,
      prompt: content,
    });

    this.completeRun(runId, response.stopReason);
  }

  /** Cancel any in-flight run, emitting run_completed. Returns true if a run was active. */
  private cancelActiveRun(): boolean {
    if (!this.execution?.activeRunId) return false;

    const runId = this.execution.activeRunId;
    this.execution.activeRunId = null;
    this.eventHub.push({ type: 'run_completed', sessionId: this.sessionId, runId, stopReason: 'cancelled' });
    this.eventHub.clearRunBuffer();
    return true;
  }

  private completeRun(runId: string, stopReason: StopReason): void {
    if (this.execution?.activeRunId !== runId) return; // Already completed

    this.execution.activeRunId = null;
    this.eventHub.push({ type: 'run_completed', sessionId: this.sessionId, runId, stopReason });
    this.eventHub.clearRunBuffer();
    this.emitStatusChanged('busy', 'ready', 'run_completed');

    this.record.lastActivity = new Date();
    this.store.update(this.record).catch(() => {});
  }

  /**
   * Subscribe to session events. Returns an AsyncIterable.
   */
  subscribe(): AsyncIterable<SessionEvent> {
    return this.eventHub.subscribe();
  }

  /**
   * Handle agent process crash. Called by CloudRuntime via AgentPool callback.
   */
  handleCrash(): void {
    if (this.record.status === 'terminated') return;

    const wasBusy = this.cancelActiveRun();
    this.emitStatusChanged(wasBusy ? 'busy' : 'ready', 'terminated', 'agent_crashed');

    this.execution = null;
    this.record.status = 'terminated';
    this.record.pid = null;
    this.record.lastActivity = new Date();
    this.store.update(this.record).catch(() => {});
    this.eventHub.close();
  }

  /**
   * Close the session. Kills agent process and terminates.
   */
  async close(): Promise<void> {
    if (this.record.status === 'terminated') return;

    const prevStatus = this.cancelActiveRun() ? 'busy' as const : this.publicStatus;

    if (this.execution) {
      this.pool.kill(this.execution.handle);
      this.execution = null;
    }

    this.record.status = 'terminated';
    this.record.pid = null;
    this.record.lastActivity = new Date();
    await this.store.update(this.record);

    this.emitStatusChanged(prevStatus, 'terminated', 'user_closed');
    this.eventHub.close();
  }

  /** Get the AgentHandle (used by CloudRuntime for crash matching). */
  getHandle(): AgentHandle | null {
    return this.execution?.handle ?? null;
  }

  private emitStatusChanged(from: SessionStatus, to: SessionStatus, reason: StatusChangeReason): void {
    this.eventHub.push({
      type: 'session_status_changed',
      sessionId: this.sessionId,
      from,
      to,
      reason,
    });
  }
}
