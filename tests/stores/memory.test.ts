import { describe, it, expect, beforeEach } from 'vitest';
import { MemorySessionStore } from '../../src/stores/memory.js';
import type { SessionRecord } from '../../src/stores/interface.js';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-1',
    acpSessionId: 'acp-1',
    agentId: 'agent-alpha',
    cwd: '/tmp',
    permissionMode: 'approve-all',
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
    const updated = { ...record, status: 'terminated' as const, pid: 1234 };
    await store.update(updated);
    const result = await store.get('sess-1');
    expect(result?.status).toBe('terminated');
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
    await store.create(makeRecord({ id: 'b', status: 'terminated' }));
    const results = await store.list({ status: 'ready' });
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('ready');
  });

  it('filters by a status array', async () => {
    await store.create(makeRecord({ id: 'a', status: 'ready' }));
    await store.create(makeRecord({ id: 'b', status: 'terminated' }));
    const results = await store.list({ status: ['ready', 'terminated'] });
    expect(results).toHaveLength(2);
  });
});
