// examples/pi-agent.ts
// Test the CloudRuntime SDK with a real Pi agent via pi-acp.
// Run: node --import tsx examples/pi-agent.ts
import { CloudRuntime } from '../src/index.js';

async function main() {
  const runtime = new CloudRuntime({
    agents: {
      pi: { command: 'npx', args: ['-y', 'pi-acp'] },
    },
  });

  console.log('Creating Pi session...');
  const session = await runtime.createSession({
    agent: 'pi',
    cwd: process.cwd(),
  });
  console.log(`Session: ${session.id}\n`);

  // Subscribe first
  const events = runtime.subscribeSession(session.id);

  console.log('Sending prompt: "What is 2+2? Reply in one word."\n');
  await runtime.promptSession(session.id, [
    { type: 'text', text: 'What is 2+2? Reply in one word.' },
  ]);

  for await (const event of events) {
    switch (event.type) {
      case 'agent_message_chunk':
        if (event.content.type === 'text') {
          process.stdout.write(event.content.text);
        }
        break;
      case 'agent_thought_chunk':
        if (event.content.type === 'text') {
          process.stderr.write(`[think] ${event.content.text}`);
        }
        break;
      case 'tool_call':
        console.log(`\n[Tool] ${event.title} (${event.kind ?? 'unknown'})`);
        break;
      case 'run_completed':
        console.log(`\n\nStop reason: ${event.stopReason}`);
        break;
    }
    if (event.type === 'run_completed') break;
  }

  await runtime.shutdown();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
