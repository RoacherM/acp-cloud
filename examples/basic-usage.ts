// examples/basic-usage.ts
// Minimal example: create a session, send a prompt, print events.
// Run: node --import tsx examples/basic-usage.ts
import { CloudRuntime } from '../src/index.js';

async function main() {
  const runtime = new CloudRuntime({
    agents: {
      mock: { command: 'node', args: ['--import', 'tsx', 'tests/helpers/mock-agent.ts'] },
    },
  });

  console.log('Creating session...');
  const session = await runtime.createSession({ agent: 'mock', cwd: process.cwd() });
  console.log(`Session created: ${session.id} (status: ${session.status})`);

  // Subscribe first, then prompt
  const events = runtime.subscribeSession(session.id);

  console.log('\nSending prompt...\n');
  const runInfo = await runtime.promptSession(session.id, [
    { type: 'text', text: 'Hello from the cloud runtime!' },
  ]);
  console.log(`Run started: ${runInfo.id}`);

  for await (const event of events) {
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
      case 'run_completed':
        console.log(`\n\n[Done] Stop reason: ${event.stopReason}`);
        break;
    }
    if (event.type === 'run_completed') break;
  }

  await runtime.shutdown();
}

main().catch(console.error);
