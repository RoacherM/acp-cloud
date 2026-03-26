import { describe, it, expect, beforeEach } from 'vitest';
import { MemorySessionStore } from '../../src/stores/memory.js';
import type { SessionRecord } from '../../src/stores/interface.js';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-1',
    acpSessionId: 'acp-1',
    agentSessionId: null,
    agentId: 'agent-alpha',
    cwd: '/tmp',
    permissionMode: 'approve-all',
    nonInteractivePolicy: 'deny',
    agentModeId: null,
    recoveryPolicy: 'strict-load',
    status: 'ready',
    pid: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    lastActivity: new Date('2024-01-01T00:00:00Z'),
    metadata: {},
    ...overrides,
  };
}

describe('MemorySessionStore', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it('creates and retrieves a record', async () => {
    const record = makeRecord();
    await store.create(record);
    const retrieved = await store.get('sess-1');
    expect(retrieved).toEqual(record);
  });

  it('returns null for a non-existent id', async () => {
    const result = await store.get('does-not-exist');
    expect(result).toBeNull();
  });

  it('get returns a copy, not the original reference', async () => {
    const record = makeRecord();
    await store.create(record);
    const retrieved = await store.get('sess-1');
    expect(retrieved).not.toBe(record);
  });

  it('updates an existing record', async () => {
    const record = makeRecord();
    await store.create(record);
    const updated = { ...record, status: 'running' as const, pid: 1234 };
    await store.update(updated);
    const result = await store.get('sess-1');
    expect(result?.status).toBe('running');
    expect(result?.pid).toBe(1234);
  });

  it('update throws for a non-existent record', async () => {
    const record = makeRecord({ id: 'ghost' });
    await expect(store.update(record)).rejects.toThrow();
  });

  it('deletes a record', async () => {
    const record = makeRecord();
    await store.create(record);
    await store.delete('sess-1');
    const result = await store.get('sess-1');
    expect(result).toBeNull();
  });

  it('delete is a no-op for non-existent id', async () => {
    await expect(store.delete('ghost')).resolves.toBeUndefined();
  });

  it('lists all records when no filter is provided', async () => {
    await store.create(makeRecord({ id: 'a', agentId: 'agent-alpha' }));
    await store.create(makeRecord({ id: 'b', agentId: 'agent-beta' }));
    const results = await store.list();
    expect(results).toHaveLength(2);
  });

  it('list returns copies, not references', async () => {
    const record = makeRecord();
    await store.create(record);
    const [listed] = await store.list();
    expect(listed).not.toBe(record);
  });

  it('filters by agentId', async () => {
    await store.create(makeRecord({ id: 'a', agentId: 'agent-alpha' }));
    await store.create(makeRecord({ id: 'b', agentId: 'agent-beta' }));
    await store.create(makeRecord({ id: 'c', agentId: 'agent-alpha' }));
    const results = await store.list({ agentId: 'agent-alpha' });
    expect(results).toHaveLength(2);
    expect(results.every(r => r.agentId === 'agent-alpha')).toBe(true);
  });

  it('filters by a single status', async () => {
    await store.create(makeRecord({ id: 'a', status: 'ready' }));
    await store.create(makeRecord({ id: 'b', status: 'running' }));
    const results = await store.list({ status: 'ready' });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('ready');
  });

  it('filters by a status array', async () => {
    await store.create(makeRecord({ id: 'a', status: 'ready' }));
    await store.create(makeRecord({ id: 'b', status: 'running' }));
    await store.create(makeRecord({ id: 'c', status: 'crashed' }));
    const results = await store.list({ status: ['ready', 'running'] });
    expect(results).toHaveLength(2);
    expect(results.map(r => r.status).sort()).toEqual(['ready', 'running']);
  });

  it('filters by agentId and status together', async () => {
    await store.create(makeRecord({ id: 'a', agentId: 'alpha', status: 'ready' }));
    await store.create(makeRecord({ id: 'b', agentId: 'alpha', status: 'running' }));
    await store.create(makeRecord({ id: 'c', agentId: 'beta', status: 'ready' }));
    const results = await store.list({ agentId: 'alpha', status: 'ready' });
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('a');
  });

  describe('reapStale', () => {
    it('marks sleeping sessions with old lastActivity as terminated', async () => {
      const oldDate = new Date(Date.now() - 60_000); // 60 seconds ago
      await store.create(makeRecord({ id: 'a', status: 'sleeping', lastActivity: oldDate }));
      const reaped = await store.reapStale(30_000); // threshold: 30 seconds
      expect(reaped).toHaveLength(1);
      expect(reaped[0].id).toBe('a');
      const stored = await store.get('a');
      expect(stored?.status).toBe('terminated');
    });

    it('does not reap sleeping sessions with recent lastActivity', async () => {
      const recentDate = new Date(Date.now() - 5_000); // 5 seconds ago
      await store.create(makeRecord({ id: 'a', status: 'sleeping', lastActivity: recentDate }));
      const reaped = await store.reapStale(30_000);
      expect(reaped).toHaveLength(0);
      const stored = await store.get('a');
      expect(stored?.status).toBe('sleeping');
    });

    it('does not reap non-sleeping sessions even if old', async () => {
      const oldDate = new Date(Date.now() - 60_000);
      await store.create(makeRecord({ id: 'a', status: 'ready', lastActivity: oldDate }));
      await store.create(makeRecord({ id: 'b', status: 'running', lastActivity: oldDate }));
      const reaped = await store.reapStale(30_000);
      expect(reaped).toHaveLength(0);
    });

    it('returns records with the updated terminated status', async () => {
      const oldDate = new Date(Date.now() - 60_000);
      await store.create(makeRecord({ id: 'a', status: 'sleeping', lastActivity: oldDate }));
      const reaped = await store.reapStale(30_000);
      expect(reaped[0].status).toBe('terminated');
    });

    it('reaps multiple stale sleeping sessions', async () => {
      const oldDate = new Date(Date.now() - 60_000);
      await store.create(makeRecord({ id: 'a', status: 'sleeping', lastActivity: oldDate }));
      await store.create(makeRecord({ id: 'b', status: 'sleeping', lastActivity: oldDate }));
      await store.create(makeRecord({ id: 'c', status: 'sleeping', lastActivity: new Date() }));
      const reaped = await store.reapStale(30_000);
      expect(reaped).toHaveLength(2);
      expect(reaped.map(r => r.id).sort()).toEqual(['a', 'b']);
    });
  });
});
