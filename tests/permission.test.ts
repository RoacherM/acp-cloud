import { describe, it, expect } from 'vitest';
import { PermissionController } from '../src/permission.js';
import type { RequestPermissionRequest, PermissionOption } from '@agentclientprotocol/sdk';

function makeRequest(toolKind: string | null, options: PermissionOption[]): RequestPermissionRequest {
  return {
    toolCall: {
      toolCallId: 'tc-1',
      title: 'Test tool',
      kind: toolKind as any,
      status: 'pending',
    },
    options,
  } as RequestPermissionRequest;
}

const allowOnce: PermissionOption = { optionId: 'allow-1', name: 'Allow', kind: 'allow_once' };
const allowAlways: PermissionOption = { optionId: 'allow-a', name: 'Allow Always', kind: 'allow_always' };
const rejectOnce: PermissionOption = { optionId: 'reject-1', name: 'Reject', kind: 'reject_once' };
const rejectAlways: PermissionOption = { optionId: 'reject-a', name: 'Reject Always', kind: 'reject_always' };

describe('PermissionController', () => {
  describe('approve-all', () => {
    it('selects allow_always when available', () => {
      const ctrl = new PermissionController('approve-all');
      const result = ctrl.resolve(makeRequest('edit', [rejectOnce, allowAlways, allowOnce]));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow-a' });
    });

    it('falls back to allow_once', () => {
      const ctrl = new PermissionController('approve-all');
      const result = ctrl.resolve(makeRequest('read', [rejectOnce, allowOnce]));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow-1' });
    });

    it('shouldDelegate returns false', () => {
      const ctrl = new PermissionController('approve-all');
      expect(ctrl.shouldDelegate(makeRequest('edit', [allowOnce, rejectOnce]))).toBe(false);
    });
  });

  describe('deny-all', () => {
    it('selects reject_once', () => {
      const ctrl = new PermissionController('deny-all');
      const result = ctrl.resolve(makeRequest('edit', [allowOnce, rejectOnce, rejectAlways]));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'reject-1' });
    });

    it('shouldDelegate returns false', () => {
      const ctrl = new PermissionController('deny-all');
      expect(ctrl.shouldDelegate(makeRequest('edit', [allowOnce, rejectOnce]))).toBe(false);
    });
  });

  describe('approve-reads', () => {
    it('auto-approves read operations', () => {
      const ctrl = new PermissionController('approve-reads');
      const result = ctrl.resolve(makeRequest('read', [allowOnce, rejectOnce]));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow-1' });
    });

    it('auto-approves search operations', () => {
      const ctrl = new PermissionController('approve-reads');
      const result = ctrl.resolve(makeRequest('search', [allowOnce, rejectOnce]));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'allow-1' });
    });

    it('shouldDelegate returns false for read', () => {
      const ctrl = new PermissionController('approve-reads');
      expect(ctrl.shouldDelegate(makeRequest('read', [allowOnce, rejectOnce]))).toBe(false);
    });

    it('shouldDelegate returns true for edit (write operation)', () => {
      const ctrl = new PermissionController('approve-reads');
      expect(ctrl.shouldDelegate(makeRequest('edit', [allowOnce, rejectOnce]))).toBe(true);
    });

    it('shouldDelegate returns true for null kind', () => {
      const ctrl = new PermissionController('approve-reads');
      expect(ctrl.shouldDelegate(makeRequest(null, [allowOnce, rejectOnce]))).toBe(true);
    });

    it('shouldDelegate returns true for execute', () => {
      const ctrl = new PermissionController('approve-reads');
      expect(ctrl.shouldDelegate(makeRequest('execute', [allowOnce, rejectOnce]))).toBe(true);
    });
  });

  describe('delegate', () => {
    it('shouldDelegate returns true for all operations', () => {
      const ctrl = new PermissionController('delegate');
      expect(ctrl.shouldDelegate(makeRequest('read', [allowOnce, rejectOnce]))).toBe(true);
      expect(ctrl.shouldDelegate(makeRequest('edit', [allowOnce, rejectOnce]))).toBe(true);
    });

    it('resolve still works as fallback (deny)', () => {
      const ctrl = new PermissionController('delegate');
      const result = ctrl.resolve(makeRequest('edit', [allowOnce, rejectOnce]));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'reject-1' });
    });
  });
});
