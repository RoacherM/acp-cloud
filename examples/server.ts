// examples/server.ts
// Run: node --import tsx examples/server.ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { serve } from '@hono/node-server';
import { CloudRuntime, createServer } from '../src/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const runtime = new CloudRuntime({
  agents: {
    pi: {
      command: 'npx',
      args: ['-y', 'pi-acp'],
      env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY },
    },
    claude: {
      command: 'npx',
      args: ['-y', '@zed-industries/claude-agent-acp'],
      env: { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY },
    },
    codex: {
      command: join(__dirname, '..', 'node_modules', '.bin', 'codex-acp'),
      args: [],
      env: { OPENAI_API_KEY: process.env.OPENAI_API_KEY },
    },
    mock: { command: 'node', args: ['--import', 'tsx', 'tests/helpers/mock-agent.ts'] },
  },
});

const WORKSPACE = process.env.WORKSPACE ?? join(__dirname, '..', 'workspace');

const app = createServer(runtime, {
  apiKey: process.env.API_KEY,
  workspace: WORKSPACE,
});

// Serve Web UI at root (public — skips auth via publicPaths in createServer)
app.get('/', (c) => {
  const html = readFileSync(join(__dirname, 'client.html'), 'utf-8');
  return c.html(html);
});

const PORT = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`ACP Cloud Runtime on http://localhost:${PORT}`);
  console.log(`Agents: ${runtime.listAgents().join(', ')}`);
});

const shutdown = async () => {
  console.log('\nShutting down...');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await runtime.shutdown();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
