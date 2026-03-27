import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileSessionStore } from '../../src/stores/file.js';
import type { SessionRecord } from '../../src/types.js';

function makeRecord(id: string, overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id,
    acpSessionId: `acp-${id}`,
    agentId: 'mock',
    cwd: '/tmp',
    permissionMode: 'approve-all',
    status: 'ready',
    pid: 1234,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    lastActivity: new Date('2026-01-01T01:00:00.000Z'),
    metadata: { foo: 'bar' },
    ...overrides,
  };
}

describe('FileSessionStore', () => {
  let dir: string;
  let store: FileSessionStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fss-'));
    store = new FileSessionStore(dir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('create and get round-trip with Date revival', async () => {
    const record = makeRecord('s1');
    await store.create(record);
    const got = await store.get('s1');
    expect(got).not.toBeNull();
    expect(got!.id).toBe('s1');
    expect(got!.createdAt).toBeInstanceOf(Date);
    expect(got!.createdAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    expect(got!.lastActivity).toBeInstanceOf(Date);
    expect(got!.metadata).toEqual({ foo: 'bar' });
  });

  it('get returns null for missing id', async () => {
    const got = await store.get('nonexistent');
    expect(got).toBeNull();
  });

  it('update overwrites existing record', async () => {
    const record = makeRecord('s1');
    await store.create(record);
    record.status = 'terminated';
    record.lastActivity = new Date('2026-01-02T00:00:00.000Z');
    await store.update(record);
    const got = await store.get('s1');
    expect(got!.status).toBe('terminated');
    expect(got!.lastActivity.toISOString()).toBe('2026-01-02T00:00:00.000Z');
  });

  it('update throws for nonexistent record', async () => {
    const record = makeRecord('s1');
    await expect(store.update(record)).rejects.toThrow();
  });

  it('delete removes the record', async () => {
    await store.create(makeRecord('s1'));
    await store.delete('s1');
    const got = await store.get('s1');
    expect(got).toBeNull();
  });

  it('list returns all records', async () => {
    await store.create(makeRecord('s1'));
    await store.create(makeRecord('s2', { agentId: 'other' }));
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it('list filters by agentId', async () => {
    await store.create(makeRecord('s1', { agentId: 'a' }));
    await store.create(makeRecord('s2', { agentId: 'b' }));
    const filtered = await store.list({ agentId: 'a' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].agentId).toBe('a');
  });

  it('list filters by status', async () => {
    await store.create(makeRecord('s1', { status: 'ready' }));
    await store.create(makeRecord('s2', { status: 'terminated' }));
    const filtered = await store.list({ status: 'terminated' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].id).toBe('s2');
  });

  it('create does not mutate the input record', async () => {
    const record = makeRecord('s1');
    const originalDate = record.createdAt.getTime();
    await store.create(record);
    const got = await store.get('s1');
    got!.createdAt.setFullYear(2000);
    expect(record.createdAt.getTime()).toBe(originalDate);
  });
});
