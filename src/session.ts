import { randomUUID } from 'node:crypto';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { AgentPool, type AgentHandle } from './agent-pool.js';
import { PermissionController } from './permission.js';
import { Run } from './run.js';
import { sessionUpdateToRunEvent } from './events.js';
import type {
  SessionRecord,
  SessionStore,
  SessionStatus,
  PermissionMode,
  NonInteractivePolicy,
  RecoveryPolicy,
} from './types.js';

// ── Options ─────────────────────────────────────────────────────────────

export interface SessionCreateOptions {
  agentId: string;
  cwd: string;
  permissionMode: PermissionMode;
  nonInteractivePolicy: NonInteractivePolicy;
  recoveryPolicy: RecoveryPolicy;
  agentModeId?: string;
  mcpServers?: Array<{ name: string; transport: unknown }>;
  pool: AgentPool;
  store: SessionStore;
}

// ── Session ─────────────────────────────────────────────────────────────

export class Session {
  readonly id: string;
  private record: SessionRecord;
  private handle: AgentHandle | null;
  private pool: AgentPool;
  private store: SessionStore;
  private permissionController: PermissionController;

  private constructor(
    record: SessionRecord,
    handle: AgentHandle,
    pool: AgentPool,
    store: SessionStore,
    permissionController: PermissionController,
  ) {
    this.id = record.id;
    this.record = record;
    this.handle = handle;
    this.pool = pool;
    this.store = store;
    this.permissionController = permissionController;
  }

  get status(): SessionStatus {
    return this.record.status;
  }

  get acpSessionId(): string {
    return this.record.acpSessionId;
  }

  private async setStatus(status: SessionStatus): Promise<void> {
    this.record.status = status;
    this.record.lastActivity = new Date();
    await this.store.update(this.record);
  }

  /**
   * Factory: spawns an agent, creates an ACP session, and returns a ready Session.
   *
   * State transitions: creating → initializing → ready
   */
  static async create(opts: SessionCreateOptions): Promise<Session> {
    const id = randomUUID();
    const now = new Date();

    // 1. Create record with status 'creating'
    const record: SessionRecord = {
      id,
      acpSessionId: '',
      agentSessionId: null,
      agentId: opts.agentId,
      cwd: opts.cwd,
      permissionMode: opts.permissionMode,
      nonInteractivePolicy: opts.nonInteractivePolicy,
      agentModeId: opts.agentModeId ?? null,
      recoveryPolicy: opts.recoveryPolicy,
      status: 'creating',
      pid: null,
      createdAt: now,
      lastActivity: now,
      metadata: {},
    };
    await opts.store.create(record);

    // 2. Spawn agent → status 'initializing'
    record.status = 'initializing';
    const handle = await opts.pool.spawn(opts.agentId);
    record.pid = handle.pid;
    await opts.store.update(record);

    // 3. Create ACP session
    const { sessionId: acpSessionId } = await handle.connection.newSession({
      cwd: opts.cwd,
      mcpServers: (opts.mcpServers ?? []) as any,
    });

    // 4. Status → 'ready'
    record.acpSessionId = acpSessionId;
    record.status = 'ready';
    record.lastActivity = new Date();
    await opts.store.update(record);

    const permissionController = new PermissionController(
      opts.permissionMode,
      opts.nonInteractivePolicy,
    );

    return new Session(record, handle, opts.pool, opts.store, permissionController);
  }

  /**
   * Send a prompt to the agent. Returns a Run immediately; the ACP prompt
   * call executes in the background.
   */
  async prompt(content: ContentBlock[]): Promise<Run> {
    if (this.record.status !== 'ready') {
      throw new Error(`Cannot prompt: session status is '${this.record.status}', expected 'ready'`);
    }

    const run = new Run(randomUUID());

    // Transition to 'running'
    await this.setStatus('running');

    // Start prompt execution in the background (don't await)
    this.executePrompt(content, run).catch((err) => {
      // If the prompt fails, push an error and complete the run
      run.complete('cancelled');
      this.setStatus('ready').catch(() => {});
    });

    return run;
  }

  /**
   * Execute the prompt against the ACP agent. Wires handlers on the AgentHandle
   * so that session/update notifications stream into the Run.
   */
  private async executePrompt(content: ContentBlock[], run: Run): Promise<void> {
    const handle = this.handle!;

    // Wire session update handler
    handle.handlers.onSessionUpdate = (notification) => {
      const event = sessionUpdateToRunEvent(notification);
      if (event) {
        run.pushEvent(event);
      }
    };

    // Wire permission handler
    handle.handlers.onPermissionRequest = async (request) => {
      const autoResult = await this.permissionController.resolve(request);
      if (autoResult) return autoResult;
      return this.permissionController.resolveNonInteractive(request);
    };

    // Call the ACP prompt (blocks until the agent finishes the turn)
    const response = await handle.connection.prompt({
      sessionId: this.record.acpSessionId,
      prompt: content,
    });

    // Complete the run
    run.complete(response.stopReason);

    // Transition back to 'ready'
    await this.setStatus('ready');
  }

  /**
   * Terminates the agent process and marks the session as terminated.
   */
  async close(): Promise<void> {
    if (this.handle) {
      this.pool.kill(this.handle);
      this.handle = null;
    }
    await this.setStatus('terminated');
  }
}
