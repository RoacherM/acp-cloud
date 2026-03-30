// src/server.ts
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { streamSSE } from 'hono/streaming';
import { z, type ZodSchema } from 'zod';
import type { CloudRuntime } from './runtime.js';
import type { PermissionMode } from './types.js';

// ── Options ─────────────────────────────────────────────────────────────

export interface ServerOptions {
  apiKey?: string;
  basePath?: string;
  workspace?: string;
}

// ── Helpers ──────────────────────────────────────────────────────────────

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function parseJsonBody<T>(c: { req: { json: () => Promise<unknown> } }, schema: ZodSchema<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpError(400, 'Malformed JSON body');
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const message = result.error.issues.map(i => i.message).join('; ');
    throw new HttpError(400, message);
  }
  return result.data;
}

// ── Error classification (centralized — not scattered across routes) ────

function classifyError(err: unknown): { status: number; message: string } {
  if (err instanceof HttpError) {
    return { status: err.status, message: err.message };
  }

  const message = err instanceof Error ? err.message : String(err);

  if (/not found|unknown agent/i.test(message)) {
    return { status: 404, message };
  }
  if (/cannot prompt|not the active run|invalid optionId|no pending permission/i.test(message)) {
    return { status: 409, message };
  }

  return { status: 500, message };
}

// ── Schemas ─────────────────────────────────────────────────────────────

const CreateSessionSchema = z.object({
  agent: z.string(),
  cwd: z.string().default(process.cwd()),
  permissionMode: z.enum(['approve-all', 'approve-reads', 'deny-all', 'delegate']).optional() as z.ZodOptional<z.ZodType<PermissionMode>>,
});

const PromptSchema = z.object({
  text: z.string(),
});

const PermissionRespondSchema = z.object({
  optionId: z.string(),
});

// ── Factory ─────────────────────────────────────────────────────────────

export function createServer(runtime: CloudRuntime, opts?: ServerOptions): Hono {
  const app = new Hono();
  const base = opts?.basePath ?? '';

  // CORS
  app.use('*', logger());
  app.use('*', cors());

  // Public routes (no auth)
  const publicPaths = new Set(['/health', '/']);
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // Auth middleware — skip public paths
  if (opts?.apiKey) {
    const expectedToken = opts.apiKey;
    app.use('*', async (c, next) => {
      if (publicPaths.has(c.req.path)) return next();
      const auth = c.req.header('Authorization');
      if (auth !== `Bearer ${expectedToken}`) {
        return c.json({ error: 'Unauthorized' }, 401);
      }
      await next();
    });
  }

  // ── Routes ──────────────────────────────────────────────────────────

  app.get('/config', (c) => c.json({ workspace: opts?.workspace ?? process.cwd() }));

  app.get(`${base}/agents`, (c) => {
    return c.json({ agents: runtime.listAgents() });
  });

  app.post(`${base}/sessions`, async (c) => {
    const body = await parseJsonBody(c, CreateSessionSchema);
    const info = await runtime.createSession({
      agent: body.agent,
      cwd: body.cwd as string,
      permissionMode: body.permissionMode,
    });
    return c.json(info, 201);
  });

  app.get(`${base}/sessions`, async (c) => {
    const list = await runtime.listSessions();
    return c.json(list);
  });

  app.get(`${base}/sessions/:id`, async (c) => {
    const info = await runtime.getSession(c.req.param('id'));
    if (!info) throw new HttpError(404, `Session not found: ${c.req.param('id')}`);
    return c.json(info);
  });

  app.get(`${base}/sessions/:id/events`, async (c) => {
    const id = c.req.param('id');
    const info = await runtime.getSession(id);
    if (!info) throw new HttpError(404, `Session not found: ${id}`);

    return streamSSE(c, async (stream) => {
      for await (const event of runtime.subscribeSession(id)) {
        await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
      }
    });
  });

  app.post(`${base}/sessions/:id/prompt`, async (c) => {
    const body = await parseJsonBody(c, PromptSchema);
    const runInfo = await runtime.promptSession(
      c.req.param('id'),
      [{ type: 'text', text: body.text }],
    );
    return c.json(runInfo, 202);
  });

  app.post(`${base}/sessions/:id/cancel`, async (c) => {
    await runtime.cancelRun(c.req.param('id'));
    return c.json({ cancelled: true });
  });

  app.post(`${base}/sessions/:id/permissions/:reqId/respond`, async (c) => {
    const body = await parseJsonBody(c, PermissionRespondSchema);
    await runtime.respondToPermission(
      c.req.param('id'),
      c.req.param('reqId'),
      body.optionId,
    );
    return c.json({ responded: true });
  });

  app.delete(`${base}/sessions/:id`, async (c) => {
    await runtime.closeSession(c.req.param('id'));
    return c.json({ closed: true });
  });

  // ── Error handler ───────────────────────────────────────────────────

  app.onError((err, c) => {
    const { status, message } = classifyError(err);
    return c.json({ error: message }, status as any);
  });

  return app;
}
