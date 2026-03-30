// tests/server.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CloudRuntime } from '../src/runtime.js';
import { createServer } from '../src/server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = join(__dirname, 'helpers', 'mock-agent.ts');

function makeRuntime() {
  return new CloudRuntime({
    agents: {
      mock: { command: 'node', args: ['--import', 'tsx', MOCK_AGENT_PATH] },
    },
  });
}

describe('createServer', () => {
  let runtime: CloudRuntime;

  afterEach(async () => {
    await runtime?.shutdown();
  });

  describe('auth', () => {
    it('rejects requests without token when apiKey is set', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime, { apiKey: 'secret-key' });

      const res = await app.request('/agents');
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe('Unauthorized');
    });

    it('accepts requests with valid token', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime, { apiKey: 'secret-key' });

      const res = await app.request('/agents', {
        headers: { Authorization: 'Bearer secret-key' },
      });
      expect(res.status).toBe(200);
    });

    it('allows all requests when no apiKey is set', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime);

      const res = await app.request('/agents');
      expect(res.status).toBe(200);
    });
  });

  describe('validation', () => {
    it('returns 400 for malformed JSON body', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime);

      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not-json{{{',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it('returns 400 for missing agent in POST /sessions', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime);

      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toBeTruthy();
    });

    it('returns 400 for missing text in POST /sessions/:id/prompt', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime);

      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'mock', cwd: '/tmp' }),
      });
      const { id } = await createRes.json() as any;

      const res = await app.request(`/sessions/${id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('error mapping', () => {
    it('returns 404 for unknown session', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime);

      const res = await app.request('/sessions/nonexistent');
      expect(res.status).toBe(404);
    });

    it('returns 404 for unknown agent', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime);

      const res = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'nonexistent', cwd: '/tmp' }),
      });
      expect(res.status).toBe(404);
    });

    it('returns 409 for prompt while busy', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime);

      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'mock', cwd: '/tmp' }),
      });
      const { id } = await createRes.json() as any;

      // Send slow prompt to keep session busy
      await app.request(`/sessions/${id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'slow hello' }),
      });

      // Second prompt while busy
      const res = await app.request(`/sessions/${id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'another' }),
      });
      expect(res.status).toBe(409);
    });
  });

  describe('routes', () => {
    it('GET /agents returns agent list', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime);

      const res = await app.request('/agents');
      expect(res.status).toBe(200);
      const body = await res.json() as any;
      expect(body.agents).toContain('mock');
    });

    it('full lifecycle: create → prompt → close', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime);

      // Create session
      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'mock', cwd: '/tmp' }),
      });
      expect(createRes.status).toBe(201);
      const session = await createRes.json() as any;
      expect(session.id).toBeTruthy();
      expect(session.status).toBe('ready');

      // Get single session
      const getRes = await app.request(`/sessions/${session.id}`);
      expect(getRes.status).toBe(200);
      const getBody = await getRes.json() as any;
      expect(getBody.id).toBe(session.id);

      // Prompt
      const promptRes = await app.request(`/sessions/${session.id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' }),
      });
      expect(promptRes.status).toBe(202);

      // Wait for run to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      // Close
      const closeRes = await app.request(`/sessions/${session.id}`, {
        method: 'DELETE',
      });
      expect(closeRes.status).toBe(200);
    });

    it('POST /sessions/:id/cancel returns 200', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime);

      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'mock', cwd: '/tmp' }),
      });
      const { id } = await createRes.json() as any;

      // Send slow prompt
      await app.request(`/sessions/${id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'slow hello' }),
      });

      const cancelRes = await app.request(`/sessions/${id}/cancel`, {
        method: 'POST',
      });
      expect(cancelRes.status).toBe(200);
    });

    it('GET /sessions lists sessions', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime);

      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'mock', cwd: '/tmp' }),
      });
      expect(createRes.status).toBe(201);

      const listRes = await app.request('/sessions');
      expect(listRes.status).toBe(200);
      const body = await listRes.json() as any;
      expect(Array.isArray(body)).toBe(true);
      expect(body.length).toBeGreaterThanOrEqual(1);
    });

    it('basePath prefixes all routes', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime, { basePath: '/api/v1' });

      const res = await app.request('/api/v1/agents');
      expect(res.status).toBe(200);

      // Without prefix should 404
      const res2 = await app.request('/agents');
      expect(res2.status).toBe(404);
    });

    it('GET /sessions/:id/events streams actual SSE events', async () => {
      runtime = makeRuntime();
      const app = createServer(runtime);

      // Create session
      const createRes = await app.request('/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent: 'mock', cwd: '/tmp' }),
      });
      const { id } = await createRes.json() as any;

      // Start SSE and prompt in parallel
      const ssePromise = app.request(`/sessions/${id}/events`);

      // Small delay to let SSE connect
      await new Promise(resolve => setTimeout(resolve, 100));

      await app.request(`/sessions/${id}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Hello' }),
      });

      // Wait for run to complete
      await new Promise(resolve => setTimeout(resolve, 500));

      // Close session to end SSE stream
      await app.request(`/sessions/${id}`, { method: 'DELETE' });

      const sseRes = await ssePromise;
      expect(sseRes.status).toBe(200);
      expect(sseRes.headers.get('content-type')).toContain('text/event-stream');

      // Read the SSE body and verify actual events were streamed
      const body = await sseRes.text();
      expect(body).toContain('event: run_started');
      expect(body).toContain('event: run_completed');
      expect(body).toContain('event: agent_message_chunk');
    });
  });
});
