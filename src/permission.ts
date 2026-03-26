import type { RequestPermissionRequest, RequestPermissionResponse, PermissionOption } from '@agentclientprotocol/sdk';
import type { PermissionMode, NonInteractivePolicy } from './types.js';

const READ_KINDS = new Set(['read', 'search', 'think']);

export class PermissionController {
  constructor(
    private readonly mode: PermissionMode,
    private readonly nonInteractivePolicy: NonInteractivePolicy,
  ) {}

  /**
   * Find the first option matching one of the given kinds, in priority order.
   */
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
   * Returns a response if the request can be auto-resolved, or null if delegation is needed.
   */
  async resolve(request: RequestPermissionRequest): Promise<RequestPermissionResponse | null> {
    const { options } = request;

    switch (this.mode) {
      case 'approve-all': {
        const option = this.findOption(options, 'allow_always', 'allow_once');
        if (!option) return null;
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
      }

      case 'deny-all': {
        const option = this.findOption(options, 'reject_once', 'reject_always');
        if (!option) return null;
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
      }

      case 'approve-reads': {
        const kind = request.toolCall.kind;
        if (kind != null && READ_KINDS.has(kind)) {
          const option = this.findOption(options, 'allow_once', 'allow_always');
          if (!option) return null;
          return { outcome: { outcome: 'selected', optionId: option.optionId } };
        }
        // Not a read-like tool — needs delegation
        return null;
      }
    }
  }

  /**
   * Fallback resolution when no client is connected.
   * - 'fail': throws an error
   * - 'deny': auto-rejects using a reject option
   */
  resolveNonInteractive(request: RequestPermissionRequest): RequestPermissionResponse {
    switch (this.nonInteractivePolicy) {
      case 'fail':
        throw new Error(
          `Permission required for tool call '${request.toolCall.toolCallId}' but no client is connected and non-interactive policy is 'fail'.`,
        );

      case 'deny': {
        const { options } = request;
        const option = this.findOption(options, 'reject_once', 'reject_always');
        if (!option) {
          throw new Error(
            `No reject option available for non-interactive denial of tool call '${request.toolCall.toolCallId}'.`,
          );
        }
        return { outcome: { outcome: 'selected', optionId: option.optionId } };
      }
    }
  }
}
