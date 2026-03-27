import type { SessionRecord, SessionFilter } from './interface.js';

export function applySessionFilter(
  records: SessionRecord[],
  filter: SessionFilter | undefined,
): SessionRecord[] {
  let result = records;

  if (filter?.agentId !== undefined) {
    result = result.filter(r => r.agentId === filter.agentId);
  }

  if (filter?.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    result = result.filter(r => statuses.includes(r.status));
  }

  return result;
}
