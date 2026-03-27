// tests/session-controller.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AgentPool } from '../src/agent-pool.js';
import { SessionController } from '../src/session-controller.js';
import { MemorySessionStore } from '../src/stores/memory.js';
import type { SessionEvent } from '../src/events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = join(__dirname, 'helpers', 'mock-agent.ts');

const mockAgentDef = {
  command: 'node',
  args: ['--import', 'tsx', MOCK_AGENT_PATH],
};

describe('SessionController', () => {
  let pool: AgentPool;

  afterEach(() => {
    pool.killAll();
  });

  it('creates controller and reaches ready state', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const store = new MemorySessionStore();

    const ctrl = await SessionController.create({
      agentId: 'mock',
      cwd: '/tmp',
      permissionMode: 'approve-all',
      pool,
      store,
    });

    expect(ctrl.sessionId).toBeTruthy();
    expect(ctrl.publicStatus).toBe('ready');

    const record = await store.get(ctrl.sessionId);
    expect(record).not.toBeNull();
    expect(record!.status).toBe('ready');

    await ctrl.close();
  });

  it('prompt transitions to busy and back to ready', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const store = new MemorySessionStore();

    const ctrl = await SessionController.create({
      agentId: 'mock',
      cwd: '/tmp',
      permissionMode: 'approve-all',
      pool,
      store,
    });

    // Subscribe before prompt
    const sub = ctrl.subscribe();
    const runInfo = await ctrl.prompt([{ type: 'text', text: 'Hello' }]);

    expect(runInfo.status).toBe('running');
    expect(ctrl.publicStatus).toBe('busy');

    // Collect events until run_completed
    const events: SessionEvent[] = [];
    for await (const event of sub) {
      events.push(event);
      if (event.type === 'run_completed') break;
    }

    expect(ctrl.publicStatus).toBe('ready');

    const types = events.map(e => e.type);
    expect(types).toContain('run_started');
    expect(types).toContain('agent_message_chunk');
    expect(types).toContain('run_completed');

    // All ACP events during run should have runId
    const acpEvents = events.filter(e => e.type === 'agent_message_chunk');
    for (const e of acpEvents) {
      expect((e as any).runId).toBe(runInfo.id);
    }

    await ctrl.close();
  });

  it('rejects prompt when busy', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const store = new MemorySessionStore();

    const ctrl = await SessionController.create({
      agentId: 'mock',
      cwd: '/tmp',
      permissionMode: 'approve-all',
      pool,
      store,
    });

    const sub = ctrl.subscribe();
    await ctrl.prompt([{ type: 'text', text: 'First' }]);

    await expect(
      ctrl.prompt([{ type: 'text', text: 'Second' }]),
    ).rejects.toThrow();

    // Drain events
    for await (const event of sub) {
      if (event.type === 'run_completed') break;
    }

    await ctrl.close();
  });

  it('close during busy emits run_completed(cancelled) then status change', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const store = new MemorySessionStore();

    const ctrl = await SessionController.create({
      agentId: 'mock',
      cwd: '/tmp',
      permissionMode: 'approve-all',
      pool,
      store,
    });

    const sub = ctrl.subscribe();
    await ctrl.prompt([{ type: 'text', text: 'Hello' }]);

    // Close while busy
    await ctrl.close();

    const events: SessionEvent[] = [];
    for await (const event of sub) {
      events.push(event);
    }

    const types = events.map(e => e.type);
    const runCompletedIdx = types.indexOf('run_completed');
    const statusChangedIdx = types.lastIndexOf('session_status_changed');

    expect(runCompletedIdx).toBeGreaterThanOrEqual(0);
    expect(statusChangedIdx).toBeGreaterThan(runCompletedIdx);

    const runCompleted = events[runCompletedIdx] as any;
    expect(runCompleted.stopReason).toBe('cancelled');

    const statusChanged = events[statusChangedIdx] as any;
    expect(statusChanged.to).toBe('terminated');
  });

  it('emits session_status_changed on close from ready', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const store = new MemorySessionStore();

    const ctrl = await SessionController.create({
      agentId: 'mock',
      cwd: '/tmp',
      permissionMode: 'approve-all',
      pool,
      store,
    });

    const sub = ctrl.subscribe();
    await ctrl.close();

    const events: SessionEvent[] = [];
    for await (const event of sub) {
      events.push(event);
    }

    expect(events.some(e => e.type === 'session_status_changed')).toBe(true);
    const sc = events.find(e => e.type === 'session_status_changed') as any;
    expect(sc.from).toBe('ready');
    expect(sc.to).toBe('terminated');
    expect(sc.reason).toBe('user_closed');
  });

  it('persists record to store with correct status', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const store = new MemorySessionStore();

    const ctrl = await SessionController.create({
      agentId: 'mock',
      cwd: '/tmp',
      permissionMode: 'approve-all',
      pool,
      store,
    });

    let record = await store.get(ctrl.sessionId);
    expect(record!.status).toBe('ready');

    await ctrl.close();

    record = await store.get(ctrl.sessionId);
    expect(record!.status).toBe('terminated');
  });
});
