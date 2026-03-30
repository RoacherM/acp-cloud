# ACP Cloud Runtime

Turn any [ACP](https://agentclientprotocol.org/) coding agent into a cloud-accessible HTTP/SSE service. One npm package gives you session management, real-time streaming, permission control, and a ready-to-use Web UI — for Pi, Claude Code, Codex, or any ACP-compatible agent.

## Why

Coding agents (Pi, Claude Code, Codex) run as local CLI tools over stdio. This project wraps them as stateful HTTP services, so you can:

- Deploy agents on a server and access them from anywhere
- Build custom UIs or integrate agents into your own platform
- Manage multiple concurrent sessions with different agents
- Add your own skills and let agents execute them remotely

## Architecture

```
┌─────────────────────────────────────────────────┐
│  Your Application / Web UI / API Client         │
│  (HTTP + SSE)                                   │
└───────────────┬─────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────┐
│  createServer(runtime, opts)    ← Hono HTTP     │
│  ┌────────────────────────────────────────────┐ │
│  │  CloudRuntime                              │ │
│  │  ├── SessionController (per session)       │ │
│  │  │   ├── EventHub (SSE streaming)          │ │
│  │  │   ├── Permission delegation             │ │
│  │  │   └── Run lifecycle                     │ │
│  │  ├── AgentPool (process management)        │ │
│  │  └── SessionStore (memory / file / custom) │ │
│  └────────────────────────────────────────────┘ │
└───────────────┬─────────────────────────────────┘
                │  stdio (ACP / JSON-RPC)
    ┌───────────┼───────────┐
    ▼           ▼           ▼
┌────────┐ ┌────────┐ ┌────────┐
│ pi-acp │ │ claude │ │ codex  │
│        │ │ -agent │ │ -acp   │
│        │ │ -acp   │ │        │
└────────┘ └────────┘ └────────┘
```

## Quick Start

### As a library (integrate into your service)

```bash
npm install acp-cloud-runtime
```

```typescript
import { CloudRuntime, createServer } from 'acp-cloud-runtime';
import { serve } from '@hono/node-server';

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
      },
    },
  },
});

const app = createServer(runtime, {
  apiKey: process.env.API_KEY,       // optional Bearer auth
  workspace: '/path/to/workspace',   // agent working directory
});

// Mount additional routes on the same Hono app
app.get('/my-route', (c) => c.json({ custom: true }));

serve({ fetch: app.fetch, port: 3000 });
```

`createServer` returns a standard Hono app — you can mount it as a sub-router, add middleware, or combine with your existing server.

### Standalone (run directly)

```bash
git clone <repo-url> && cd ai-cloud-code
npm install

# Set your API key
export OPENROUTER_API_KEY=sk-or-...

# Start
node --import tsx examples/server.ts
```

Open http://localhost:3000 for the Web UI.

### Docker

```bash
# Build
docker build -t acp-cloud-runtime .

# Run
docker run -d \
  -p 3000:3000 \
  -e OPENROUTER_API_KEY=sk-or-... \
  -v $(pwd)/workspace:/home/agent/workspace \
  -v $(pwd)/config/pi:/home/agent/.pi/agent \
  acp-cloud-runtime
```

### Docker Compose

```bash
# Create .env
cat > .env << EOF
OPENROUTER_API_KEY=sk-or-...
API_KEY=my-secret-token
EOF

docker compose up -d
docker compose logs -f
```

## API

```
GET    /agents                                    List available agents
POST   /sessions                                  Create session
GET    /sessions                                  List sessions
GET    /sessions/:id                              Get session details
GET    /sessions/:id/events                       SSE event stream
POST   /sessions/:id/prompt                       Send prompt
POST   /sessions/:id/cancel                       Cancel active run
POST   /sessions/:id/permissions/:reqId/respond   Respond to permission
DELETE /sessions/:id                              Close session
```

### Create a session and send a prompt

```bash
# Create session
SESSION_ID=$(curl -s -X POST http://localhost:3000/sessions \
  -H 'Content-Type: application/json' \
  -d '{"agent":"pi","cwd":"/home/agent/workspace"}' | jq -r '.id')

# Listen to events (in another terminal)
curl -N http://localhost:3000/sessions/$SESSION_ID/events

# Send prompt
curl -X POST http://localhost:3000/sessions/$SESSION_ID/prompt \
  -H 'Content-Type: application/json' \
  -d '{"text":"Write a Python script that prints fibonacci numbers"}'
```

### SSE Events

| Event | Description |
|---|---|
| `session_status_changed` | Status transition (ready → busy → ready) |
| `run_started` | New run began |
| `agent_thought_chunk` | Streaming thinking/reasoning |
| `agent_message_chunk` | Streaming response text |
| `tool_call` | Agent invoked a tool |
| `tool_call_update` | Tool execution progress |
| `run_completed` | Run finished (with `stopReason`) |
| `run_error` | Run failed |
| `permission_request` | Agent needs permission for an action |
| `permission_timeout` | Permission request timed out |

## Adding Skills

Skills are agent-specific instructions placed in the workspace. When an agent starts a session with `cwd` pointing to your workspace, it discovers and uses them automatically.

```
workspace/
├── .pi/skills/           # Pi agent skills
│   ├── my-skill/
│   │   └── instructions.md
│   └── another-skill/
│       └── instructions.md
├── .claude/skills/       # Claude Code skills
│   └── my-skill/
│       └── instructions.md
├── .codex/skills/        # Codex skills
│   └── my-skill/
│       └── instructions.md
└── AGENTS.md             # Shared instructions for Codex
```

Each skill folder contains an `instructions.md` that describes when and how the agent should use it. The same skill can be provided to multiple agents by placing it in each agent's skill directory.

## OpenRouter Configuration

All agents route through [OpenRouter](https://openrouter.ai/) with a single API key. The default model is `moonshotai/kimi-k2.5`.

### Environment Variables

| Variable | Description |
|---|---|
| `OPENROUTER_API_KEY` | OpenRouter API key (used by Pi and Codex) |
| `ANTHROPIC_BASE_URL` | Set to `https://openrouter.ai/api` for Claude via OpenRouter |
| `ANTHROPIC_AUTH_TOKEN` | OpenRouter key (for Claude agent) |
| `ANTHROPIC_API_KEY` | Set to empty string when using OpenRouter |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Override Claude's default model (e.g. `moonshotai/kimi-k2.5`) |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Override Claude's opus model |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Override Claude's haiku model |
| `API_KEY` | Bearer token to protect the HTTP API (optional) |
| `PORT` | Server port (default: 3000) |

### Agent-specific config files

**Pi** — `config/pi/settings.json` (mounted to `~/.pi/agent/` in Docker):
```json
{
  "defaultProvider": "openrouter",
  "defaultModel": "moonshotai/kimi-k2.5"
}
```

**Codex** — `config/codex/config.toml` (baked into Docker image at `~/.codex/`):
```toml
model_provider = "openrouter"
model = "moonshotai/kimi-k2.5"

[model_providers.openrouter]
name = "openrouter"
base_url = "https://openrouter.ai/api/v1"
env_key = "OPENROUTER_API_KEY"
```

## Library API

### CloudRuntime

```typescript
import { CloudRuntime } from 'acp-cloud-runtime';

const runtime = new CloudRuntime({
  agents: { /* AgentDefinition map */ },
  sessionStore: new FileSessionStore('./sessions'),  // optional, default: MemorySessionStore
  defaultPermissionMode: 'approve-all',              // optional
  permissionTimeoutMs: 30_000,                       // optional
});

// Core operations
await runtime.createSession({ agent: 'pi', cwd: '/workspace' });
await runtime.promptSession(sessionId, [{ type: 'text', text: 'hello' }]);
await runtime.cancelRun(sessionId);
await runtime.respondToPermission(sessionId, reqId, optionId);
await runtime.closeSession(sessionId);
await runtime.shutdown();

// Queries
runtime.listAgents();
await runtime.listSessions();
await runtime.getSession(sessionId);

// Streaming
for await (const event of runtime.subscribeSession(sessionId)) {
  console.log(event.type, event);
}
```

### createServer

```typescript
import { createServer } from 'acp-cloud-runtime';

const app = createServer(runtime, {
  apiKey: 'secret',           // optional Bearer auth
  basePath: '/api/v1',        // optional route prefix
  workspace: '/workspace',    // reported via /config endpoint
});
```

Returns a Hono app. Use it standalone or mount as a sub-app in your existing server.

### Session Stores

```typescript
import { MemorySessionStore, FileSessionStore } from 'acp-cloud-runtime';

// In-memory (default) — sessions lost on restart
new MemorySessionStore()

// File-based — persists session records to disk
new FileSessionStore('./data/sessions')
```

Implement the `SessionStore` interface for custom backends (Redis, PostgreSQL, etc.).

## Deployment

See [docs/deployment.md](docs/deployment.md) for production deployment guides including:

- systemd service configuration
- nginx reverse proxy with SSE support
- Docker best practices

## License

Apache-2.0
