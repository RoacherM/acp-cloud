import { describe, it, expect } from 'vitest';
import { PermissionController } from '../src/permission.js';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';

function makePermissionRequest(kind: string = 'read'): RequestPermissionRequest {
  return {
    sessionId: 'test-session',
    toolCall: { toolCallId: 'tc-1', kind: kind as any },
    options: [
      { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'opt-allow-always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
    ],
  };
}

describe('PermissionController - approve-all mode', () => {
  it('auto-approves read with allow_always', async () => {
    const ctrl = new PermissionController('approve-all', 'deny');
    const result = await ctrl.resolve(makePermissionRequest('read'));
    expect(result).not.toBeNull();
    expect(result!.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-always' });
  });

  it('auto-approves edit with allow_always', async () => {
    const ctrl = new PermissionController('approve-all', 'deny');
    const result = await ctrl.resolve(makePermissionRequest('edit'));
    expect(result).not.toBeNull();
    expect(result!.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-always' });
  });

  it('auto-approves execute with allow_always', async () => {
    const ctrl = new PermissionController('approve-all', 'deny');
    const result = await ctrl.resolve(makePermissionRequest('execute'));
    expect(result).not.toBeNull();
    expect(result!.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-always' });
  });

  it('falls back to allow_once if allow_always not available', async () => {
    const ctrl = new PermissionController('approve-all', 'deny');
    const request: RequestPermissionRequest = {
      sessionId: 'test-session',
      toolCall: { toolCallId: 'tc-1', kind: 'edit' as any },
      options: [
        { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
      ],
    };
    const result = await ctrl.resolve(request);
    expect(result).not.toBeNull();
    expect(result!.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-once' });
  });
});

describe('PermissionController - deny-all mode', () => {
  it('auto-rejects all tools', async () => {
    const ctrl = new PermissionController('deny-all', 'deny');
    const result = await ctrl.resolve(makePermissionRequest('execute'));
    expect(result).not.toBeNull();
    expect(result!.outcome).toEqual({ outcome: 'selected', optionId: 'opt-reject' });
  });
});

describe('PermissionController - approve-reads mode', () => {
  it('auto-approves read tools', async () => {
    const ctrl = new PermissionController('approve-reads', 'deny');
    const result = await ctrl.resolve(makePermissionRequest('read'));
    expect(result).not.toBeNull();
    expect(result!.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-once' });
  });

  it('auto-approves search and think tools', async () => {
    const ctrl = new PermissionController('approve-reads', 'deny');

    const searchResult = await ctrl.resolve(makePermissionRequest('search'));
    expect(searchResult).not.toBeNull();
    expect(searchResult!.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-once' });

    const thinkResult = await ctrl.resolve(makePermissionRequest('think'));
    expect(thinkResult).not.toBeNull();
    expect(thinkResult!.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-once' });
  });

  it('returns null for edit/execute (needs delegation)', async () => {
    const ctrl = new PermissionController('approve-reads', 'deny');

    const editResult = await ctrl.resolve(makePermissionRequest('edit'));
    expect(editResult).toBeNull();

    const executeResult = await ctrl.resolve(makePermissionRequest('execute'));
    expect(executeResult).toBeNull();
  });
});
