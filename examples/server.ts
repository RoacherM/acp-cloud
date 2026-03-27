// examples/server.ts
// Minimal HTTP/SSE server for chatting with ACP agents.
// Run: node --import tsx examples/server.ts
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { CloudRuntime, type SessionEvent } from '../src/index.js';

const runtime = new CloudRuntime({
  agents: {
    pi: { command: 'npx', args: ['-y', 'pi-acp'] },
    mock: { command: 'node', args: ['--import', 'tsx', 'tests/helpers/mock-agent.ts'] },
  },
});

// SSE connections per session
const sseClients = new Map<string, Set<ServerResponse>>();

function sendSSE(sessionId: string, event: string, data: unknown) {
  const clients = sseClients.get(sessionId);
  if (!clients) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    if (!res.destroyed) {
      res.write(payload);
    }
  }
}

function parseBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, `http://${req.headers.host}`);
  const path = url.pathname;
  const method = req.method!;

  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  try {
    if (method === 'GET' && path === '/agents') {
      return json(res, 200, { agents: runtime.listAgents() });
    }

    if (method === 'POST' && path === '/sessions') {
      const body = await parseBody(req);
      const agent = body.agent ?? 'pi';
      const cwd = body.cwd ?? process.cwd();
      console.log(`Creating session for agent: ${agent}`);
      const info = await runtime.createSession({ agent, cwd });
      sseClients.set(info.id, new Set());

      // Start session event forwarding to SSE
      (async () => {
        for await (const event of runtime.subscribeSession(info.id)) {
          sendSSE(info.id, event.type, event);
        }
      })();

      return json(res, 201, {
        id: info.id,
        agent: info.agentId,
        status: info.status,
        eventsUrl: `/sessions/${info.id}/events`,
        promptUrl: `/sessions/${info.id}/prompt`,
      });
    }

    if (method === 'GET' && path === '/sessions') {
      const list = await runtime.listSessions();
      return json(res, 200, list);
    }

    const sessionMatch = path.match(/^\/sessions\/([^/]+)(\/.*)?$/);
    if (!sessionMatch) {
      return json(res, 404, { error: 'Not found' });
    }

    const sessionId = sessionMatch[1];
    const subpath = sessionMatch[2] ?? '';

    const info = await runtime.getSession(sessionId);
    if (!info) {
      return json(res, 404, { error: `Session not found: ${sessionId}` });
    }

    if (method === 'GET' && subpath === '/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
      });
      res.write(`event: connected\ndata: {"sessionId":"${sessionId}"}\n\n`);

      const clients = sseClients.get(sessionId);
      if (clients) {
        clients.add(res);
        req.on('close', () => clients.delete(res));
      }
      return;
    }

    if (method === 'POST' && subpath === '/prompt') {
      const body = await parseBody(req);
      const text = body.text ?? body.message ?? '';
      console.log(`[${sessionId.slice(0, 8)}] Prompt: ${text.slice(0, 80)}`);

      const runInfo = await runtime.promptSession(sessionId, [{ type: 'text', text }]);
      return json(res, 202, { runId: runInfo.id, status: runInfo.status });
    }

    if (method === 'DELETE' && subpath === '') {
      await runtime.closeSession(sessionId);
      sseClients.delete(sessionId);
      return json(res, 200, { closed: true });
    }

    if (method === 'POST' && subpath === '/cancel') {
      await runtime.cancelRun(sessionId);
      return json(res, 200, { cancelled: true });
    }

    const permMatch = subpath.match(/^\/permissions\/([^/]+)\/respond$/);
    if (method === 'POST' && permMatch) {
      const requestId = permMatch[1];
      const body = await parseBody(req);
      await runtime.respondToPermission(sessionId, requestId, body.optionId);
      return json(res, 200, { responded: true });
    }

    json(res, 404, { error: 'Not found' });
  } catch (err: any) {
    console.error('Error:', err.message);
    json(res, 500, { error: err.message });
  }
});

const PORT = Number(process.env.PORT ?? 3000);
server.listen(PORT, () => {
  console.log(`\nACP Cloud Runtime server running on http://localhost:${PORT}\n`);
  console.log('Usage:');
  console.log(`  1. Create session:  curl -X POST http://localhost:${PORT}/sessions -H 'Content-Type: application/json' -d '{"agent":"pi"}'`);
  console.log(`  2. Open SSE:        curl -N http://localhost:${PORT}/sessions/<ID>/events`);
  console.log(`  3. Send prompt:     curl -X POST http://localhost:${PORT}/sessions/<ID>/prompt -H 'Content-Type: application/json' -d '{"text":"Hello!"}'`);
  console.log(`  4. Close session:   curl -X DELETE http://localhost:${PORT}/sessions/<ID>`);
  console.log(`\nAvailable agents: pi, mock\n`);
});

process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await runtime.shutdown();
  server.close();
  process.exit(0);
});
