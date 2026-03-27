import type { SessionStore, SessionRecord, SessionFilter } from './interface.js';

function copyRecord(record: SessionRecord): SessionRecord {
  return {
    ...record,
    createdAt: new Date(record.createdAt.getTime()),
    lastActivity: new Date(record.lastActivity.getTime()),
    metadata: { ...record.metadata },
  };
}

export class MemorySessionStore implements SessionStore {
  private readonly map = new Map<string, SessionRecord>();

  async create(record: SessionRecord): Promise<void> {
    this.map.set(record.id, copyRecord(record));
  }

  async get(id: string): Promise<SessionRecord | null> {
    const record = this.map.get(id);
    return record ? copyRecord(record) : null;
  }

  async update(record: SessionRecord): Promise<void> {
    if (!this.map.has(record.id)) {
      throw new Error(`SessionRecord not found: ${record.id}`);
    }
    this.map.set(record.id, copyRecord(record));
  }

  async delete(id: string): Promise<void> {
    this.map.delete(id);
  }

  async list(filter?: SessionFilter): Promise<SessionRecord[]> {
    let records = Array.from(this.map.values());

    if (filter?.agentId !== undefined) {
      records = records.filter(r => r.agentId === filter.agentId);
    }

    if (filter?.status !== undefined) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      records = records.filter(r => statuses.includes(r.status));
    }

    return records.map(copyRecord);
  }
}
