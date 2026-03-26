// examples/pi-agent.ts
// Test the CloudRuntime SDK with a real Pi agent via pi-acp.
// Run: node --import tsx examples/pi-agent.ts
import { CloudRuntime } from '../src/index.js';

async function main() {
  const runtime = new CloudRuntime({
    agents: {
      pi: { command: 'npx', args: ['-y', 'pi-acp'] },
    },
    defaultPermissionMode: 'approve-all',
  });

  console.log('Creating Pi session...');
  const session = await runtime.createSession({
    agent: 'pi',
    cwd: process.cwd(),
  });
  console.log(`Session: ${session.id} (ACP: ${session.acpSessionId})\n`);

  console.log('Sending prompt: "What is 2+2? Reply in one word."\n');
  const run = await session.prompt([{ type: 'text', text: 'What is 2+2? Reply in one word.' }]);

  for await (const event of run) {
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
      case 'tool_call_update':
        if (event.status === 'completed') {
          console.log(`[Tool Done] ${event.toolCallId}`);
        }
        break;
      case 'available_commands_update':
        // Skip — Pi sends slash commands on session start
        break;
      case 'session_info_update':
        // Skip — Pi sends queue depth updates
        break;
      default:
        // Log unexpected event types for debugging
        console.log(`[${event.type}]`);
    }
  }

  console.log(`\n\nStop reason: ${run.stopReason}`);
  await runtime.shutdown();
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
