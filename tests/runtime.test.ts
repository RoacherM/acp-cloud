import { describe, it, expect, afterEach } from 'vitest';
import { CloudRuntime } from '../src/runtime.js';
import type { SessionEvent } from '../src/events.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = join(__dirname, 'helpers', 'mock-agent.ts');

const mockAgentDef = {
  command: 'node',
  args: ['--import', 'tsx', MOCK_AGENT_PATH],
};

describe('CloudRuntime', () => {
  let runtime: CloudRuntime;

  afterEach(async () => {
    await runtime.shutdown();
  });

  it('creates runtime and lists no sessions', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    const sessions = await runtime.listSessions();
    expect(sessions).toHaveLength(0);
  });

  it('createSession returns SessionInfo with ready status', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    const info = await runtime.createSession({ agent: 'mock', cwd: '/tmp' });

    expect(info.status).toBe('ready');
    expect(info.id).toBeTruthy();
    expect(info.agentId).toBe('mock');
    // SessionInfo should NOT have acpSessionId
    expect((info as any).acpSessionId).toBeUndefined();
  });

  it('getSession returns SessionInfo by id', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    const created = await runtime.createSession({ agent: 'mock', cwd: '/tmp' });

    const retrieved = await runtime.getSession(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.status).toBe('ready');
  });

  it('getSession returns null for unknown id', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    const result = await runtime.getSession('nonexistent');
    expect(result).toBeNull();
  });

  it('end-to-end: subscribe, prompt, receive events via id-centric API', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    const info = await runtime.createSession({ agent: 'mock', cwd: '/tmp' });

    // Subscribe first, then prompt
    const sub = runtime.subscribeSession(info.id);
    const runInfo = await runtime.promptSession(info.id, [{ type: 'text', text: 'Hello' }]);

    expect(runInfo.status).toBe('running');
    expect(runInfo.sessionId).toBe(info.id);

    const events: SessionEvent[] = [];
    for await (const event of sub) {
      events.push(event);
      if (event.type === 'run_completed') break;
    }

    const types = events.map(e => e.type);
    expect(types).toContain('run_started');
    expect(types).toContain('agent_message_chunk');
    expect(types).toContain('run_completed');

    // Verify runId on events
    const runCompleted = events.find(e => e.type === 'run_completed') as any;
    expect(runCompleted.runId).toBe(runInfo.id);
    expect(runCompleted.stopReason).toBe('end_turn');
  });

  it('listSessions returns active sessions', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    await runtime.createSession({ agent: 'mock', cwd: '/tmp' });

    const list = await runtime.listSessions();
    expect(list.length).toBeGreaterThanOrEqual(1);
    expect(list.some(s => s.agentId === 'mock')).toBe(true);
  });

  it('closeSession terminates and removes controller', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    const info = await runtime.createSession({ agent: 'mock', cwd: '/tmp' });

    await runtime.closeSession(info.id);

    const retrieved = await runtime.getSession(info.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.status).toBe('terminated');
  });

  it('throws for unknown agent', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    await expect(
      runtime.createSession({ agent: 'nonexistent', cwd: '/tmp' }),
    ).rejects.toThrow('Unknown agent: nonexistent');
  });

  it('admission control rejects when maxActiveSessions exceeded', async () => {
    runtime = new CloudRuntime({
      agents: { mock: mockAgentDef },
      maxActiveSessions: 1,
    });

    await runtime.createSession({ agent: 'mock', cwd: '/tmp' });

    await expect(
      runtime.createSession({ agent: 'mock', cwd: '/tmp' }),
    ).rejects.toThrow('Max active sessions reached');
  });

  it('admission control rejects when maxAgentProcesses exceeded', async () => {
    runtime = new CloudRuntime({
      agents: { mock: mockAgentDef },
      maxAgentProcesses: 1,
    });

    await runtime.createSession({ agent: 'mock', cwd: '/tmp' });

    await expect(
      runtime.createSession({ agent: 'mock', cwd: '/tmp' }),
    ).rejects.toThrow('Max agent processes reached');
  });

  it('shutdown closes all sessions without triggering crash handler', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });

    // Create multiple sessions to increase race window
    const info1 = await runtime.createSession({ agent: 'mock', cwd: '/tmp' });
    const info2 = await runtime.createSession({ agent: 'mock', cwd: '/tmp' });
    const sub1 = runtime.subscribeSession(info1.id);
    const sub2 = runtime.subscribeSession(info2.id);

    await runtime.shutdown();

    // Give exit callbacks time to fire after shutdown
    await new Promise(resolve => setTimeout(resolve, 200));

    const collectEvents = async (sub: AsyncIterable<any>) => {
      const events: any[] = [];
      for await (const event of sub) events.push(event);
      return events;
    };

    const events1 = await collectEvents(sub1);
    const events2 = await collectEvents(sub2);
    const allEvents = [...events1, ...events2];

    const statusChanges = allEvents.filter(e => e.type === 'session_status_changed');
    const reasons = statusChanges.map((e: any) => e.reason);

    // Every status change should be user_closed, never agent_crashed
    expect(reasons.every((r: string) => r === 'user_closed')).toBe(true);
    expect(reasons).not.toContain('agent_crashed');

    // Re-create runtime so afterEach doesn't call shutdown on a dead instance
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
  });

  it('subscribeSession returns empty iterable for unknown session', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    const sub = runtime.subscribeSession('nonexistent');

    const events: SessionEvent[] = [];
    for await (const e of sub) {
      events.push(e);
    }
    expect(events).toHaveLength(0);
  });

  it('cancelRun cancels active run gracefully', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    const info = await runtime.createSession({ agent: 'mock', cwd: '/tmp' });

    const sub = runtime.subscribeSession(info.id);
    await runtime.promptSession(info.id, [{ type: 'text', text: 'slow Hello' }]);

    await runtime.cancelRun(info.id);

    const events: SessionEvent[] = [];
    for await (const event of sub) {
      events.push(event);
      if (event.type === 'run_completed') break;
    }

    const runCompleted = events.find(e => e.type === 'run_completed') as any;
    expect(runCompleted.stopReason).toBe('cancelled');

    const session = await runtime.getSession(info.id);
    expect(session!.status).toBe('ready');
  });

  it('cancelRun is no-op for idle session', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    const info = await runtime.createSession({ agent: 'mock', cwd: '/tmp' });

    await runtime.cancelRun(info.id);
    expect((await runtime.getSession(info.id))!.status).toBe('ready');
  });

  it('cancelRun throws for unknown session', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    await expect(runtime.cancelRun('nonexistent')).rejects.toThrow('Session not found');
  });

  it('respondToPermission resolves pending permission', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    const info = await runtime.createSession({
      agent: 'mock',
      cwd: '/tmp',
      permissionMode: 'delegate',
    });

    const sub = runtime.subscribeSession(info.id);
    await runtime.promptSession(info.id, [{ type: 'text', text: 'test permission request' }]);

    const events: SessionEvent[] = [];
    for await (const event of sub) {
      events.push(event);
      if (event.type === 'permission_request') {
        const pe = event as any;
        await runtime.respondToPermission(info.id, pe.requestId, 'opt-allow');
      }
      if (event.type === 'run_completed') break;
    }

    expect(events.some(e => e.type === 'permission_request')).toBe(true);
    const runCompleted = events.find(e => e.type === 'run_completed') as any;
    expect(runCompleted.stopReason).toBe('end_turn');
  });
});
