import { describe, it, expect } from 'vitest';
import { derivePublicStatus, toSessionInfo } from '../src/types.js';
import type { SessionRecord, SessionExecution } from '../src/types.js';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'sess-1',
    acpSessionId: 'acp-1',
    agentId: 'mock',
    cwd: '/tmp',
    permissionMode: 'approve-all',
    status: 'ready',
    pid: 1234,
    createdAt: new Date('2024-01-01'),
    lastActivity: new Date('2024-01-01'),
    metadata: {},
    ...overrides,
  };
}

describe('derivePublicStatus', () => {
  it('returns ready when record is ready and no active run', () => {
    const record = makeRecord({ status: 'ready' });
    const execution = { handle: {} as any, activeRunId: null };
    expect(derivePublicStatus(record, execution)).toBe('ready');
  });

  it('returns busy when record is ready and there is an active run', () => {
    const record = makeRecord({ status: 'ready' });
    const execution = { handle: {} as any, activeRunId: 'run-1' };
    expect(derivePublicStatus(record, execution)).toBe('busy');
  });

  it('returns terminated when record is terminated regardless of execution', () => {
    const record = makeRecord({ status: 'terminated' });
    const execution = { handle: {} as any, activeRunId: 'run-1' };
    expect(derivePublicStatus(record, execution)).toBe('terminated');
  });

  it('returns ready when execution is null and record is ready', () => {
    const record = makeRecord({ status: 'ready' });
    expect(derivePublicStatus(record, null)).toBe('ready');
  });

  it('returns terminated when execution is null and record is terminated', () => {
    const record = makeRecord({ status: 'terminated' });
    expect(derivePublicStatus(record, null)).toBe('terminated');
  });
});

describe('toSessionInfo', () => {
  it('builds SessionInfo DTO from record and execution', () => {
    const record = makeRecord({ status: 'ready' });
    const info = toSessionInfo(record, null);
    expect(info).toEqual({
      id: 'sess-1',
      agentId: 'mock',
      status: 'ready',
      createdAt: record.createdAt,
      lastActivity: record.lastActivity,
    });
  });

  it('reflects busy status from active run', () => {
    const record = makeRecord({ status: 'ready' });
    const execution = { handle: {} as any, activeRunId: 'run-1' };
    const info = toSessionInfo(record, execution);
    expect(info.status).toBe('busy');
  });
});
