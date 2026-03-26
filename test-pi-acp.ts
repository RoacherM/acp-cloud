// Quick test: spawn pi via pi-acp adapter and send a prompt via ACP protocol
import { spawn } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Agent,
  type SessionNotification,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
} from '@agentclientprotocol/sdk';

// Try pi-acp first, fallback to pi --mode rpc
const USE_PI_ACP = true; // pi-acp installed, use it as ACP adapter

class TestClient implements Client {
  async sessionUpdate(params: SessionNotification): Promise<void> {
    const update = params.update;
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          process.stdout.write(update.content.text);
        }
        break;
      case 'agent_thought_chunk':
        if (update.content.type === 'text') {
          process.stderr.write(`[think] ${update.content.text}\n`);
        }
        break;
      case 'tool_call':
        console.log(`\n[Tool] ${update.title} (${update.kind ?? 'unknown'}) — ${update.status}`);
        break;
      case 'tool_call_update':
        console.log(`[Tool Update] ${update.toolCallId} → ${update.status}`);
        break;
      case 'plan':
        console.log('[Plan]', update.entries.map(e => `${e.status}: ${e.content}`).join(', '));
        break;
      case 'usage_update':
        console.log(`[Usage] ${update.used}/${update.size} tokens`);
        break;
      default:
        console.log(`[${update.sessionUpdate}]`, JSON.stringify(update).slice(0, 200));
    }
  }

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    console.log(`\n[Permission] ${params.toolCall.title ?? params.toolCall.toolCallId}`);
    console.log('  Options:', params.options.map(o => `${o.name} (${o.kind})`).join(', '));
    // Auto-approve everything for this test
    const allow = params.options.find(o => o.kind === 'allow_once' || o.kind === 'allow_always');
    const optionId = allow?.optionId ?? params.options[0].optionId;
    console.log(`  → Auto-approving: ${optionId}`);
    return { outcome: { outcome: 'selected', optionId } };
  }
}

async function main() {
  console.log('--- ACP Cloud Runtime: Pi Agent Test ---\n');

  // Spawn pi-acp (or pi --mode rpc)
  let child;
  if (USE_PI_ACP) {
    console.log('Spawning pi-acp...');
    child = spawn('npx', ['-y', 'pi-acp'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
  } else {
    console.log('Spawning pi --mode rpc...');
    child = spawn('pi', ['--mode', 'rpc'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
  }

  // Pipe stderr for debugging
  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) console.error(`[pi stderr] ${msg}`);
  });

  child.on('error', (err) => {
    console.error('Failed to spawn:', err.message);
    process.exit(1);
  });

  const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
  const stream = ndJsonStream(output, input);

  const connection = new ClientSideConnection(
    (_agent: Agent) => new TestClient(),
    stream,
  );

  // 1. Initialize
  console.log('\n[Step 1] Initializing ACP connection...');
  const initResult = await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
      terminal: true,
    },
    clientInfo: { name: 'acp-cloud-runtime-test', version: '0.1.0' },
  });
  console.log(`Agent: ${initResult.agentInfo?.name} v${initResult.agentInfo?.version}`);

  // 2. Create session
  console.log('\n[Step 2] Creating session...');
  const session = await connection.newSession({
    cwd: process.cwd(),
    mcpServers: [],
  });
  console.log(`Session ID: ${session.sessionId}`);

  // 3. Send a simple prompt
  console.log('\n[Step 3] Sending prompt: "What is 2+2? Reply in one word."\n');
  console.log('--- Agent Response ---');
  const result = await connection.prompt({
    sessionId: session.sessionId,
    prompt: [{ type: 'text', text: 'What is 2+2? Reply in one word.' }],
  });
  console.log('\n--- End Response ---');
  console.log(`\nStop reason: ${result.stopReason}`);

  // Cleanup
  child.kill('SIGTERM');
  console.log('\nTest complete!');
  process.exit(0);
}

main().catch((err) => {
  console.error('Error:', err);
  process.exit(1);
});
