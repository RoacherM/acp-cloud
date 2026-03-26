import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AgentPool } from '../src/agent-pool.js';
import { Session } from '../src/session.js';
import { MemorySessionStore } from '../src/stores/memory.js';
import type { RunEvent } from '../src/events.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = join(__dirname, 'helpers', 'mock-agent.ts');

const mockAgentDef = {
  command: 'node',
  args: ['--import', 'tsx', MOCK_AGENT_PATH],
};

describe('Session', () => {
  let pool: AgentPool;

  afterEach(() => {
    pool.killAll();
  });

  it('creates session and transitions to ready', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const store = new MemorySessionStore();

    const session = await Session.create({
      agentId: 'mock',
      cwd: '/tmp',
      permissionMode: 'approve-all',
      nonInteractivePolicy: 'deny',
      recoveryPolicy: 'strict-load',
      pool,
      store,
    });

    expect(session.status).toBe('ready');
    expect(session.id).toBeTruthy();
    expect(session.acpSessionId).toBeTruthy();

    await session.close();
  });

  it('sends prompt and receives events', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const store = new MemorySessionStore();

    const session = await Session.create({
      agentId: 'mock',
      cwd: '/tmp',
      permissionMode: 'approve-all',
      nonInteractivePolicy: 'deny',
      recoveryPolicy: 'strict-load',
      pool,
      store,
    });

    const run = await session.prompt([{ type: 'text', text: 'Hello' }]);

    const events: RunEvent[] = [];
    for await (const event of run) {
      events.push(event);
    }

    const types = events.map((e) => e.type);
    expect(types).toContain('agent_message_chunk');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_call_update');
    expect(run.stopReason).toBe('end_turn');

    await session.close();
  });

  it('session status is running during prompt', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const store = new MemorySessionStore();

    const session = await Session.create({
      agentId: 'mock',
      cwd: '/tmp',
      permissionMode: 'approve-all',
      nonInteractivePolicy: 'deny',
      recoveryPolicy: 'strict-load',
      pool,
      store,
    });

    const run = await session.prompt([{ type: 'text', text: 'Hello' }]);

    // Status should be 'running' immediately after prompt() returns
    expect(session.status).toBe('running');

    // Drain events to let the prompt complete
    for await (const _event of run) {
      // consume
    }

    expect(session.status).toBe('ready');

    await session.close();
  });

  it('persists session record to store', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const store = new MemorySessionStore();

    const session = await Session.create({
      agentId: 'mock',
      cwd: '/tmp',
      permissionMode: 'approve-all',
      nonInteractivePolicy: 'deny',
      recoveryPolicy: 'strict-load',
      pool,
      store,
    });

    const record = await store.get(session.id);
    expect(record).not.toBeNull();
    expect(record!.agentId).toBe('mock');
    expect(record!.status).toBe('ready');

    await session.close();
  });
});
