import { describe, it, expect } from 'vitest';
import { PermissionController } from '../src/permission.js';
import type { RequestPermissionRequest, PermissionOption } from '@agentclientprotocol/sdk';

function makeRequest(toolKind: string, options: PermissionOption[]): RequestPermissionRequest {
  return {
    toolCall: {
      toolCallId: 'tc-1',
      title: 'Test tool',
      kind: toolKind as any,
      status: 'pending',
    },
    options,
  };
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
      expect(result.outcome.optionId).toBe('allow-a');
    });

    it('falls back to allow_once when allow_always is not available', () => {
      const ctrl = new PermissionController('approve-all');
      const result = ctrl.resolve(makeRequest('read', [rejectOnce, allowOnce]));
      expect(result.outcome.optionId).toBe('allow-1');
    });
  });

  describe('deny-all', () => {
    it('selects reject_once when available', () => {
      const ctrl = new PermissionController('deny-all');
      const result = ctrl.resolve(makeRequest('edit', [allowOnce, rejectOnce, rejectAlways]));
      expect(result.outcome.optionId).toBe('reject-1');
    });

    it('falls back to reject_always', () => {
      const ctrl = new PermissionController('deny-all');
      const result = ctrl.resolve(makeRequest('read', [allowOnce, rejectAlways]));
      expect(result.outcome.optionId).toBe('reject-a');
    });
  });

  describe('approve-reads (degrades to deny-all in Phase 1.5)', () => {
    it('rejects read tools (no delegation)', () => {
      const ctrl = new PermissionController('approve-reads');
      const result = ctrl.resolve(makeRequest('read', [allowOnce, rejectOnce]));
      expect(result.outcome.optionId).toBe('reject-1');
    });

    it('rejects write tools', () => {
      const ctrl = new PermissionController('approve-reads');
      const result = ctrl.resolve(makeRequest('edit', [allowOnce, rejectOnce]));
      expect(result.outcome.optionId).toBe('reject-1');
    });
  });
});
