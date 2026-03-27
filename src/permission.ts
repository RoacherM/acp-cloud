import type { RequestPermissionRequest, RequestPermissionResponse, PermissionOption } from '@agentclientprotocol/sdk';
import type { PermissionMode } from './types.js';

/** ToolKind values considered read-only (auto-approved by approve-reads mode). */
const READ_KINDS = new Set(['read', 'search', 'think', 'fetch']);

/** Find the first option matching any of the given kinds. */
export function findPermissionOption(
  options: PermissionOption[],
  ...kinds: PermissionOption['kind'][]
): PermissionOption | undefined {
  for (const kind of kinds) {
    const found = options.find((o) => o.kind === kind);
    if (found) return found;
  }
  return undefined;
}

export class PermissionController {
  constructor(private readonly mode: PermissionMode) {}

  /**
   * Should this request be delegated to the external client?
   */
  shouldDelegate(request: RequestPermissionRequest): boolean {
    switch (this.mode) {
      case 'approve-all':
      case 'deny-all':
        return false;
      case 'delegate':
        return true;
      case 'approve-reads': {
        const kind = request.toolCall.kind;
        if (kind && READ_KINDS.has(kind)) return false;
        return true;
      }
    }
  }

  /**
   * Auto-resolve a permission request (used for non-delegated requests).
   * Throws if no suitable option exists — never silently picks the wrong kind.
   */
  resolve(request: RequestPermissionRequest): RequestPermissionResponse {
    const { options } = request;

    switch (this.mode) {
      case 'approve-all':
      case 'approve-reads': {
        const option = findPermissionOption(options, 'allow_once', 'allow_always');
        if (!option) throw new Error('No allow option available in permission request');
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
      }

      case 'deny-all':
      case 'delegate': {
        const option = findPermissionOption(options, 'reject_once', 'reject_always');
        if (!option) throw new Error('No reject option available in permission request');
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
      }
    }
  }
}
