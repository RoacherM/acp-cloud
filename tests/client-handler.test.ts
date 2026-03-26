import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SandboxedFsHandler } from '../src/client-handler.js';

const SESSION_ID = 'test-session-123';

describe('SandboxedFsHandler', () => {
  let tmpDir: string;
  let handler: SandboxedFsHandler;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'sandboxed-fs-test-'));
    await writeFile(join(tmpDir, 'test.txt'), 'hello world');
    handler = new SandboxedFsHandler(tmpDir);
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reads a file within the sandbox (relative path)', async () => {
    const content = await handler.readTextFile(SESSION_ID, 'test.txt');
    expect(content).toBe('hello world');
  });

  it('reads a file by absolute path within sandbox', async () => {
    const absolutePath = join(tmpDir, 'test.txt');
    const content = await handler.readTextFile(SESSION_ID, absolutePath);
    expect(content).toBe('hello world');
  });

  it('rejects path traversal via ..', async () => {
    await expect(
      handler.readTextFile(SESSION_ID, '../etc/passwd')
    ).rejects.toThrow(/escapes sandbox/);
  });

  it('rejects absolute path outside sandbox (/etc/passwd)', async () => {
    await expect(
      handler.readTextFile(SESSION_ID, '/etc/passwd')
    ).rejects.toThrow(/escapes sandbox/);
  });

  it('rejects symlink escaping (symlink to /etc)', async () => {
    const symlinkPath = join(tmpDir, 'evil-link');
    await symlink('/etc', symlinkPath);

    await expect(
      handler.readTextFile(SESSION_ID, 'evil-link/passwd')
    ).rejects.toThrow(/escapes sandbox/);
  });

  it('writes a file within the sandbox', async () => {
    await handler.writeTextFile(SESSION_ID, 'output.txt', 'written content');
    const content = await handler.readTextFile(SESSION_ID, 'output.txt');
    expect(content).toBe('written content');
  });

  it('rejects write outside sandbox', async () => {
    await expect(
      handler.writeTextFile(SESSION_ID, '../outside.txt', 'malicious')
    ).rejects.toThrow(/escapes sandbox/);
  });
});
