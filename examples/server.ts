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
      command: 'pi-acp',
      args: [],
      env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY },
    },
    claude: {
      command: 'claude-agent-acp',
      args: [],
      env: {
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL,
        ANTHROPIC_DEFAULT_SONNET_MODEL: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL,
        ANTHROPIC_DEFAULT_OPUS_MODEL: process.env.ANTHROPIC_DEFAULT_OPUS_MODEL,
      },
    },
    codex: {
      command: 'codex-acp',
      args: [],
      env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY },
    },
    mock: { command: 'node', args: ['--import', 'tsx', 'tests/helpers/mock-agent.ts'] },
  },
});

const WORKSPACE = process.env.WORKSPACE ?? join(__dirname, '..', 'workspace');

const app = createServer(runtime, {
  apiKey: process.env.API_KEY,
  workspace: WORKSPACE,
});

// Serve Web UI files (public — skips auth via publicPaths in createServer)
app.get('/', (c) => {
  return c.html(readFileSync(join(__dirname, 'index.html'), 'utf-8'));
});
app.get('/acp-client.js', (c) => {
  c.header('Content-Type', 'application/javascript');
  return c.body(readFileSync(join(__dirname, 'acp-client.js'), 'utf-8'));
});
app.get('/acp-components.js', (c) => {
  c.header('Content-Type', 'application/javascript');
  return c.body(readFileSync(join(__dirname, 'acp-components.js'), 'utf-8'));
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
