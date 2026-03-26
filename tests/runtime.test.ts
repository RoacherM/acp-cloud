import { describe, it, expect, afterEach } from 'vitest';
import { CloudRuntime } from '../src/runtime.js';
import type { RunEvent } from '../src/events.js';
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

  it('creates a session with status ready', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });

    const session = await runtime.createSession({ agent: 'mock', cwd: '/tmp' });

    expect(session.status).toBe('ready');
    expect(session.id).toBeTruthy();
  });

  it('end-to-end: create session, send prompt, receive events', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });

    const session = await runtime.createSession({ agent: 'mock', cwd: '/tmp' });
    const run = await session.prompt([{ type: 'text', text: 'Hello' }]);

    const events: RunEvent[] = [];
    for await (const event of run) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('agent_message_chunk');
    expect(run.stopReason).toBe('end_turn');
    expect(run.status).toBe('completed');
  });

  it('lists active sessions after creation', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });

    const session = await runtime.createSession({ agent: 'mock', cwd: '/tmp' });

    const records = await runtime.listSessions();
    expect(records.length).toBeGreaterThanOrEqual(1);
    expect(records.some((r) => r.agentId === 'mock')).toBe(true);
  });

  it('throws for unknown agent', async () => {
    runtime = new CloudRuntime({ agents: { mock: mockAgentDef } });

    await expect(
      runtime.createSession({ agent: 'nonexistent', cwd: '/tmp' }),
    ).rejects.toThrow('Unknown agent: nonexistent');
  });
});
