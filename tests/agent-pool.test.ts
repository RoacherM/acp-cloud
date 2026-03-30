import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { AgentPool } from '../src/agent-pool.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = join(__dirname, 'helpers', 'mock-agent.ts');

const mockAgentDef = {
  command: 'node',
  args: ['--import', 'tsx', MOCK_AGENT_PATH],
};

describe('AgentPool', () => {
  let pool: AgentPool;

  afterEach(() => {
    pool.killAll();
  });

  it('spawns agent and returns handle with pid and agentInfo', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const handle = await pool.spawn('mock');

    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.agentInfo).toEqual({ name: 'mock-agent', version: '0.0.1' });
    expect(handle.connection).toBeDefined();
    expect(handle.process).toBeDefined();
    expect(handle.handlers).toBeDefined();
  });

  it('throws for unknown agent id', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });

    await expect(pool.spawn('nonexistent')).rejects.toThrow('Unknown agent: nonexistent');
  });

  it('reports alive/dead status correctly after kill', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const handle = await pool.spawn('mock');

    expect(pool.isAlive(handle)).toBe(true);

    pool.kill(handle);

    // Give the process a moment to actually die
    await new Promise((resolve) => handle.process.on('exit', resolve));

    expect(pool.isAlive(handle)).toBe(false);
  });

  it('tracks stats (active count, totalSpawned)', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });

    expect(pool.stats()).toEqual({ active: 0, totalSpawned: 0, totalCrashed: 0 });

    const h1 = await pool.spawn('mock');
    expect(pool.stats()).toEqual({ active: 1, totalSpawned: 1, totalCrashed: 0 });

    const h2 = await pool.spawn('mock');
    expect(pool.stats()).toEqual({ active: 2, totalSpawned: 2, totalCrashed: 0 });

    pool.kill(h1);
    await new Promise((resolve) => h1.process.on('exit', resolve));
    expect(pool.stats()).toEqual({ active: 1, totalSpawned: 2, totalCrashed: 0 });
  });

  it('calls onProcessExit callback when agent process dies', async () => {
    let exitInfo: { code: number | null; signal: string | null } | null = null;

    pool = new AgentPool({
      agents: { mock: mockAgentDef },
      onProcessExit: (_handle, code, signal) => {
        exitInfo = { code, signal };
      },
    });

    const handle = await pool.spawn('mock');
    pool.kill(handle);

    await new Promise((resolve) => handle.process.on('exit', resolve));

    expect(exitInfo).not.toBeNull();
  });

  it('spawn returns handle with agentCapabilities', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const handle = await pool.spawn('mock');
    expect(handle.agentCapabilities).toBeDefined();
    expect(typeof handle.agentCapabilities).toBe('object');
    pool.kill(handle);
  });

  it('does not advertise fs capabilities', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const handle = await pool.spawn('mock');
    expect(handle).toBeDefined();
    expect(handle.pid).toBeGreaterThan(0);

    pool.kill(handle);
    await new Promise((resolve) => handle.process.on('exit', resolve));
  });
});
