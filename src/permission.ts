// src/permission.ts
import type { RequestPermissionRequest, RequestPermissionResponse, PermissionOption } from '@agentclientprotocol/sdk';
import type { PermissionMode } from './types.js';

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
   * Resolve a permission request based on the mode.
   *
   * Phase 1.5 behavior:
   * - approve-all: auto-approve everything
   * - approve-reads: degrades to deny-all (no interactive delegation)
   * - deny-all: auto-reject everything
   */
  resolve(request: RequestPermissionRequest): RequestPermissionResponse {
    const { options } = request;

    switch (this.mode) {
      case 'approve-all': {
        const option = this.findOption(options, 'allow_always', 'allow_once');
        if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
        // Fallback: pick first option
        return { outcome: { outcome: 'selected', optionId: options[0].optionId } };
      }

      case 'deny-all':
      case 'approve-reads': {
        // Phase 1.5: approve-reads degrades to deny-all (no delegation path)
        const option = this.findOption(options, 'reject_once', 'reject_always');
        if (option) return { outcome: { outcome: 'selected', optionId: option.optionId } };
        // Fallback: pick first option
        return { outcome: { outcome: 'selected', optionId: options[0].optionId } };
      }
    }
  }
}
