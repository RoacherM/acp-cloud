import { realpath, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';

/**
 * Walk up the directory tree to find the nearest existing ancestor of `p`.
 * Returns `p` itself if it exists, otherwise its first existing parent.
 */
async function findExistingAncestor(p: string): Promise<string> {
  let current = p;
  while (true) {
    try {
      await access(current);
      return current;
    } catch {
      const parent = dirname(current);
      if (parent === current) return current; // filesystem root
      current = parent;
    }
  }
}

export class SandboxedFsHandler {
  private realRoot: string | null = null;

  constructor(private allowedRoot: string) {}

  private async getRealRoot(): Promise<string> {
    if (!this.realRoot) {
      this.realRoot = await realpath(this.allowedRoot);
    }
    return this.realRoot;
  }

  /**
   * Resolve `inputPath` to an absolute, real path that must lie within the
   * sandbox root. Two-phase check:
   *
   * 1. Resolve platform symlinks in the *existing* ancestor of the candidate
   *    (covers /var → /private/var on macOS and detects traversal via `..`).
   * 2. If the full path exists, call realpath on it to follow any symlinks in
   *    the final component (catches symlink-based escaping).
   */
  private async resolveWithinRoot(inputPath: string): Promise<string> {
    const root = await this.getRealRoot();
    const candidate = isAbsolute(inputPath) ? inputPath : resolve(root, inputPath);

    // Phase 1: realpath the nearest existing ancestor, then reconstruct the
    // remainder so platform-level symlinks (e.g. /var → /private/var) are
    // resolved before the relative() check.
    const ancestor = await findExistingAncestor(candidate);
    const realAncestor = await realpath(ancestor);
    const remainder = relative(ancestor, candidate); // path suffix that may not exist yet
    const realCandidatePre = remainder ? resolve(realAncestor, remainder) : realAncestor;

    const preRel = relative(root, realCandidatePre);
    if (preRel.startsWith('..') || isAbsolute(preRel)) {
      throw new Error(`Path escapes sandbox: ${inputPath} → ${realCandidatePre}`);
    }

    // Phase 2: if the full path exists, follow all symlinks to catch symlink escaping.
    let realCandidate: string;
    try {
      realCandidate = await realpath(candidate);
    } catch {
      // Path doesn't exist yet (e.g., write target) — pre-validated path is safe.
      return realCandidatePre;
    }

    const rel = relative(root, realCandidate);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path escapes sandbox: ${inputPath} → ${realCandidate}`);
    }
    return realCandidate;
  }

  async readTextFile(_sessionId: string, path: string): Promise<string> {
    const safePath = await this.resolveWithinRoot(path);
    return readFile(safePath, 'utf-8');
  }

  async writeTextFile(_sessionId: string, path: string, content: string): Promise<void> {
    // 1. Validate the parent directory is within the sandbox BEFORE any fs mutation.
    //    resolveWithinRoot handles non-existent paths via findExistingAncestor,
    //    so we validate on dirname(candidate) which may partially exist.
    const root = await this.getRealRoot();
    const candidate = isAbsolute(path) ? path : resolve(root, path);
    const parentDir = dirname(candidate);
    await this.resolveWithinRoot(parentDir);

    // 2. Now that we know the parent is within the sandbox, create directories.
    await mkdir(parentDir, { recursive: true });

    // 3. Resolve the full target path (now that parent exists) and write.
    const safePath = await this.resolveWithinRoot(path);
    await writeFile(safePath, content, 'utf-8');
  }
}
