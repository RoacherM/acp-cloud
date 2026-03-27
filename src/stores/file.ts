import { readFile, writeFile, rename, unlink, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionStore, SessionRecord, SessionFilter } from './interface.js';

const DATE_FIELDS: (keyof SessionRecord)[] = ['createdAt', 'lastActivity'];

function reviveDates(record: any): SessionRecord {
  for (const field of DATE_FIELDS) {
    if (typeof record[field] === 'string') {
      record[field] = new Date(record[field]);
    }
  }
  return record as SessionRecord;
}

export class FileSessionStore implements SessionStore {
  constructor(private readonly dir: string) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private tmpPath(id: string): string {
    return join(this.dir, `${id}.tmp`);
  }

  async create(record: SessionRecord): Promise<void> {
    const data = JSON.stringify(record);
    const tmp = this.tmpPath(record.id);
    await writeFile(tmp, data, 'utf-8');
    await rename(tmp, this.filePath(record.id));
  }

  async get(id: string): Promise<SessionRecord | null> {
    try {
      const data = await readFile(this.filePath(id), 'utf-8');
      return reviveDates(JSON.parse(data));
    } catch (err: any) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  }

  async update(record: SessionRecord): Promise<void> {
    const existing = await this.get(record.id);
    if (!existing) {
      throw new Error(`SessionRecord not found: ${record.id}`);
    }
    const data = JSON.stringify(record);
    const tmp = this.tmpPath(record.id);
    await writeFile(tmp, data, 'utf-8');
    await rename(tmp, this.filePath(record.id));
  }

  async delete(id: string): Promise<void> {
    try {
      await unlink(this.filePath(id));
    } catch (err: any) {
      if (err.code === 'ENOENT') return;
      throw err;
    }
  }

  async list(filter?: SessionFilter): Promise<SessionRecord[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch (err: any) {
      if (err.code === 'ENOENT') return [];
      throw err;
    }

    const jsonFiles = entries.filter(e => e.endsWith('.json'));
    const records: SessionRecord[] = [];

    for (const file of jsonFiles) {
      try {
        const data = await readFile(join(this.dir, file), 'utf-8');
        records.push(reviveDates(JSON.parse(data)));
      } catch {
        // Skip corrupted or partial files
      }
    }

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
}
