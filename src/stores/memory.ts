import type { SessionStore, SessionRecord, SessionFilter } from './interface.js';
import { applySessionFilter } from './filters.js';

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
    const records = Array.from(this.map.values());
    return applySessionFilter(records, filter).map(copyRecord);
  }
}
