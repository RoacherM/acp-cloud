import { AgentPool } from './agent-pool.js';
import { Session } from './session.js';
import { MemorySessionStore } from './stores/memory.js';
import type {
  RuntimeConfig,
  SessionStore,
  SessionRecord,
  CreateSessionOptions,
  PermissionMode,
  NonInteractivePolicy,
  RecoveryPolicy,
} from './types.js';

export class CloudRuntime {
  private pool: AgentPool;
  private store: SessionStore;
  private sessions = new Map<string, Session>();
  private config: {
    defaultPermissionMode: PermissionMode;
    defaultNonInteractivePolicy: NonInteractivePolicy;
    defaultRecoveryPolicy: RecoveryPolicy;
    maxAgentProcesses: number;
    maxActiveSessions: number;
    sessionTTL: number;
    sleepTTL: number;
    maxQueueDepth: number;
  };

  constructor(config: RuntimeConfig) {
    this.pool = new AgentPool({ agents: config.agents });
    this.store = config.sessionStore ?? new MemorySessionStore();
    this.config = {
      defaultPermissionMode: config.defaultPermissionMode ?? 'approve-all',
      defaultNonInteractivePolicy: config.defaultNonInteractivePolicy ?? 'deny',
      defaultRecoveryPolicy: config.defaultRecoveryPolicy ?? 'fallback-new',
      maxAgentProcesses: config.maxAgentProcesses ?? 20,
      maxActiveSessions: config.maxActiveSessions ?? 50,
      sessionTTL: config.sessionTTL ?? 300_000,
      sleepTTL: config.sleepTTL ?? 86_400_000,
      maxQueueDepth: config.maxQueueDepth ?? 8,
    };
  }

  async createSession(opts: CreateSessionOptions): Promise<Session> {
    const session = await Session.create({
      agentId: opts.agent,
      cwd: opts.cwd,
      permissionMode: opts.permissionMode ?? this.config.defaultPermissionMode,
      nonInteractivePolicy: opts.nonInteractivePolicy ?? this.config.defaultNonInteractivePolicy,
      recoveryPolicy: opts.recoveryPolicy ?? this.config.defaultRecoveryPolicy,
      agentModeId: opts.agentModeId,
      mcpServers: opts.mcpServers,
      pool: this.pool,
      store: this.store,
    });
    this.sessions.set(session.id, session);
    return session;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.store.list();
  }

  async getSession(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.close();
    }
    this.sessions.clear();
    this.pool.killAll();
  }
}
