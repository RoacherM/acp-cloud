// src/session-controller.ts
import { randomUUID } from 'node:crypto';
import type { ContentBlock, StopReason, RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { AgentPool, type AgentHandle } from './agent-pool.js';
import { PermissionController, findPermissionOption } from './permission.js';
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
  PendingPermission,
} from './types.js';
import { derivePublicStatus } from './types.js';

// ── Options ─────────────────────────────────────────────────────────────

const DEFAULT_PERMISSION_TIMEOUT_MS = 30_000;

export interface SessionControllerOptions {
  agentId: string;
  cwd: string;
  permissionMode: PermissionMode;
  pool: AgentPool;
  store: SessionStore;
  permissionTimeoutMs?: number;
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
  private permissionTimeoutMs: number;

  private constructor(
    record: SessionRecord,
    execution: SessionExecution,
    pool: AgentPool,
    store: SessionStore,
    permissionController: PermissionController,
    permissionTimeoutMs: number,
  ) {
    this.sessionId = record.id;
    this.record = record;
    this.execution = execution;
    this.pool = pool;
    this.store = store;
    this.permissionController = permissionController;
    this.eventHub = new EventHub();
    this.permissionTimeoutMs = permissionTimeoutMs;
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
      pendingPermissions: new Map(),
    };

    const permissionController = new PermissionController(opts.permissionMode);

    return new SessionController(
      record, execution, opts.pool, opts.store, permissionController,
      opts.permissionTimeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS,
    );
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

    this.executePrompt(content, runId).catch((err) => {
      // Only act if the run is still ours and the process is alive.
      // If the process died, handleCrash() will drive the transition
      // via the exit callback — completing here would emit a wrong
      // busy→ready before the crash handler's ready→terminated.
      if (
        this.execution?.activeRunId === runId &&
        this.execution.handle &&
        this.pool.isAlive(this.execution.handle)
      ) {
        this.failRun(runId, err instanceof Error ? err.message : String(err));
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
      const event = sessionUpdateToSessionEvent(notification, this.sessionId);
      this.eventHub.push({ ...event, runId });
    };

    handle.handlers.onPermissionRequest = async (request) => {
      return this.handlePermissionRequest(request, runId);
    };

    const response = await handle.connection.prompt({
      sessionId: this.record.acpSessionId,
      prompt: content,
    });

    this.completeRun(runId, response.stopReason);
  }

  private async handlePermissionRequest(
    request: RequestPermissionRequest,
    runId: string,
  ): Promise<RequestPermissionResponse> {
    if (!this.permissionController.shouldDelegate(request)) {
      return this.permissionController.resolve(request);
    }

    const requestId = randomUUID();
    const permissionPromise = new Promise<RequestPermissionResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.execution?.pendingPermissions.delete(requestId);
        const rejectOption = findPermissionOption(request.options, 'reject_once', 'reject_always');
        if (!rejectOption) throw new Error('No reject option available for timeout resolution');
        this.eventHub.push({ type: 'permission_timeout', sessionId: this.sessionId, requestId });
        resolve({ outcome: { outcome: 'selected', optionId: rejectOption.optionId } });
      }, this.permissionTimeoutMs);

      const validOptionIds = new Set(request.options.map(o => o.optionId));
      const pending: PendingPermission = { runId, validOptionIds, resolve, timer };
      this.execution!.pendingPermissions.set(requestId, pending);
    });

    this.eventHub.push({
      type: 'permission_request',
      sessionId: this.sessionId,
      runId,
      requestId,
      toolCall: {
        toolCallId: request.toolCall.toolCallId,
        title: request.toolCall.title,
        kind: request.toolCall.kind ?? null,
        status: request.toolCall.status ?? null,
      },
      options: request.options.map(o => ({
        optionId: o.optionId,
        name: o.name,
        kind: o.kind,
      })),
    });

    return permissionPromise;
  }

  /**
   * Cancel the active run via ACP session/cancel.
   * No-op if no run is active.
   */
  async cancel(runId?: string): Promise<void> {
    if (!this.execution?.activeRunId) return;

    if (runId && this.execution.activeRunId !== runId) {
      throw new Error(`Run ${runId} is not the active run`);
    }

    this.cancelPendingPermissions();
    await this.execution.handle.connection.cancel({
      sessionId: this.record.acpSessionId,
    });
    // Agent will return StopReason::Cancelled from prompt(),
    // which triggers completeRun() naturally.
  }

  respondToPermission(requestId: string, optionId: string): void {
    const pending = this.execution?.pendingPermissions.get(requestId);
    if (!pending) {
      throw new Error(`No pending permission request: ${requestId}`);
    }
    if (!pending.validOptionIds.has(optionId)) {
      throw new Error(`Invalid optionId '${optionId}' for permission request ${requestId}`);
    }
    clearTimeout(pending.timer);
    this.execution!.pendingPermissions.delete(requestId);
    pending.resolve({ outcome: { outcome: 'selected', optionId } });
  }

  private cancelPendingPermissions(): void {
    if (!this.execution) return;
    for (const [_id, pending] of this.execution.pendingPermissions) {
      clearTimeout(pending.timer);
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    this.execution.pendingPermissions.clear();
  }

  /** Cancel any in-flight run, emitting run_completed. Returns true if a run was active. */
  private cancelActiveRun(): boolean {
    if (!this.execution?.activeRunId) return false;

    const runId = this.execution.activeRunId;
    this.execution.activeRunId = null;
    this.cancelPendingPermissions();
    this.eventHub.push({ type: 'run_completed', sessionId: this.sessionId, runId, stopReason: 'cancelled' });
    this.eventHub.clearRunBuffer();
    return true;
  }

  private completeRun(runId: string, stopReason: StopReason): void {
    this.finishRun(runId, { type: 'run_completed', sessionId: this.sessionId, runId, stopReason }, 'run_completed');
  }

  private failRun(runId: string, error: string): void {
    this.finishRun(runId, { type: 'run_error', sessionId: this.sessionId, runId, error }, 'run_error');
  }

  private finishRun(runId: string, event: SessionEvent, reason: StatusChangeReason): void {
    if (this.execution?.activeRunId !== runId) return;

    this.execution.activeRunId = null;
    this.cancelPendingPermissions();
    this.eventHub.push(event);
    this.eventHub.clearRunBuffer();
    this.emitStatusChanged('busy', 'ready', reason);

    this.record.lastActivity = new Date();
    this.persistRecord();
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

    this.cancelPendingPermissions();
    const wasBusy = this.cancelActiveRun();
    this.emitStatusChanged(wasBusy ? 'busy' : 'ready', 'terminated', 'agent_crashed');

    this.execution = null;
    this.record.status = 'terminated';
    this.record.pid = null;
    this.record.lastActivity = new Date();
    this.persistRecord().finally(() => {
      this.eventHub.close();
    });
  }

  /**
   * Close the session. Kills agent process and terminates.
   */
  async close(): Promise<void> {
    if (this.record.status === 'terminated') return;

    const prevStatus = this.cancelActiveRun() ? 'busy' as const : this.publicStatus;

    if (this.execution) {
      // Attempt ACP session/close if agent supports it
      const caps = this.execution.handle.agentCapabilities;
      if (caps.sessionCapabilities?.close) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            this.execution.handle.connection.unstable_closeSession({
              sessionId: this.record.acpSessionId,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('session/close timeout')), 5000);
            }),
          ]);
        } catch (err) {
          process.stderr.write(`[acp-cloud-runtime] session/close failed for ${this.sessionId}: ${err instanceof Error ? err.message : err}\n`);
        } finally {
          clearTimeout(timer);
        }
      } else {
        process.stderr.write(`[acp-cloud-runtime] agent does not support session/close, falling back to kill for ${this.sessionId}\n`);
      }

      this.pool.kill(this.execution.handle);
      this.execution = null;
    }

    this.record.status = 'terminated';
    this.record.pid = null;
    this.record.lastActivity = new Date();
    await this.persistRecord();

    this.emitStatusChanged(prevStatus, 'terminated', 'user_closed');
    this.eventHub.close();
  }

  /** Get the AgentHandle (used by CloudRuntime for crash matching). */
  getHandle(): AgentHandle | null {
    return this.execution?.handle ?? null;
  }

  /** Fire-and-forget store update; emits store_error on failure. */
  private persistRecord(): Promise<void> {
    return this.store.update(this.record).catch((err) => {
      this.eventHub.push({
        type: 'store_error',
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
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
