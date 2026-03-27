import { readFile, writeFile, rename, unlink, readdir, access } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionStore, SessionRecord, SessionFilter } from './interface.js';
import { applySessionFilter } from './filters.js';

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

  private async atomicWrite(id: string, data: string): Promise<void> {
    const tmp = join(this.dir, `${id}.tmp`);
    await writeFile(tmp, data, 'utf-8');
    await rename(tmp, this.filePath(id));
  }

  async create(record: SessionRecord): Promise<void> {
    await this.atomicWrite(record.id, JSON.stringify(record));
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
    // Verify file exists without reading its contents
    try {
      await access(this.filePath(record.id));
    } catch (err: any) {
      if (err.code === 'ENOENT') throw new Error(`SessionRecord not found: ${record.id}`);
      throw err;
    }
    await this.atomicWrite(record.id, JSON.stringify(record));
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

    return applySessionFilter(records, filter);
  }
}
