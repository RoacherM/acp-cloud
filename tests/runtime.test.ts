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

  it('subscribeSession returns empty iterable for unknown session', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });
    const sub = runtime.subscribeSession('nonexistent');

    const events: SessionEvent[] = [];
    for await (const e of sub) {
      events.push(e);
    }
    expect(events).toHaveLength(0);
  });
});
