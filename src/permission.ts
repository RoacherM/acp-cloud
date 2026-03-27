import type { RequestPermissionRequest, RequestPermissionResponse, PermissionOption } from '@agentclientprotocol/sdk';
import type { PermissionMode } from './types.js';

/** ToolKind values considered read-only (auto-approved by approve-reads mode). */
const READ_KINDS = new Set(['read', 'search', 'think', 'fetch']);

export class PermissionController {
  constructor(private readonly mode: PermissionMode) {}

  private findOption(
    options: PermissionOption[],
    ...kinds: PermissionOption['kind'][]
  ): PermissionOption | undefined {
    for (const kind of kinds) {
      const found = options.find((o) => o.kind === kind);
      if (found) return found;
    }
    return undefined;
  }

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
   */
  resolve(request: RequestPermissionRequest): RequestPermissionResponse {
    const { options } = request;

    switch (this.mode) {
      case 'approve-all':
      case 'approve-reads': {
        const option = this.findOption(options, 'allow_once', 'allow_always');
        if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
        return { outcome: { outcome: 'selected', optionId: options[0].optionId } };
      }

      case 'deny-all':
      case 'delegate': {
        const option = this.findOption(options, 'reject_once', 'reject_always');
        if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
        return { outcome: { outcome: 'selected', optionId: options[0].optionId } };
      }
    }
  }
}
