// examples/basic-usage.ts
// Minimal example: create a session with a mock agent, send a prompt, print events.
// Run: node --import tsx examples/basic-usage.ts
import { CloudRuntime } from '../src/index.js';

async function main() {
  const runtime = new CloudRuntime({
    agents: {
      // For testing with mock agent:
      mock: { command: 'node', args: ['--import', 'tsx', 'tests/helpers/mock-agent.ts'] },
      // Replace with real agents:
      // claude: { command: 'npx', args: ['-y', '@zed-industries/claude-agent-acp'] },
      // codex: { command: 'npx', args: ['-y', '@zed-industries/codex-acp'] },
    },
  });

  console.log('Creating session...');
  const session = await runtime.createSession({
    agent: 'mock',
    cwd: process.cwd(),
  });
  console.log(`Session created: ${session.id} (ACP: ${session.acpSessionId})`);

  console.log('\nSending prompt...\n');
  const run = await session.prompt([{ type: 'text', text: 'Hello from the cloud runtime!' }]);

  for await (const event of run) {
    switch (event.type) {
      case 'agent_message_chunk':
        if (event.content.type === 'text') {
          process.stdout.write(event.content.text);
        }
        break;
      case 'tool_call':
        console.log(`\n[Tool] ${event.title} (${event.kind})`);
        break;
      case 'tool_call_update':
        console.log(`[Tool Update] ${event.toolCallId} → ${event.status}`);
        break;
    }
  }

  console.log(`\n\n[Done] Stop reason: ${run.stopReason}`);


  await runtime.shutdown();
}

main().catch(console.error);
