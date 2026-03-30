// examples/server.ts
// Run: node --import tsx examples/server.ts
import { serve } from '@hono/node-server';
import { CloudRuntime, createServer } from '../src/index.js';

const runtime = new CloudRuntime({
  agents: {
    pi: { command: 'npx', args: ['-y', 'pi-acp'] },
    mock: { command: 'node', args: ['--import', 'tsx', 'tests/helpers/mock-agent.ts'] },
  },
});

const app = createServer(runtime, {
  apiKey: process.env.API_KEY,
});

const PORT = Number(process.env.PORT ?? 3000);
const server = serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`ACP Cloud Runtime on http://localhost:${PORT}`);
  console.log(`Agents: ${runtime.listAgents().join(', ')}`);
});

const shutdown = async () => {
  console.log('\nShutting down...');
  server.close();
  await runtime.shutdown();
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
