# ACP Cloud Runtime — Deployment Guide

## Quick Start (Local)

```bash
# Clone and install
git clone <repo-url> && cd ai-cloud-code
npm install

# Set API key
export OPENROUTER_API_KEY=sk-or-...

# Start server
node --import tsx examples/server.ts
```

Open http://localhost:3000 for the Web UI.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENROUTER_API_KEY` | For Pi, Codex, Claude (default) | OpenRouter API key — used by pi and codex agents directly, and as the default for `ANTHROPIC_AUTH_TOKEN` |
| `ANTHROPIC_API_KEY` | For Claude agent | Anthropic API key (native Anthropic usage) |
| `ANTHROPIC_BASE_URL` | No | Base URL for Claude agent API calls (default: `https://openrouter.ai/api`) |
| `ANTHROPIC_AUTH_TOKEN` | No | Auth token for Claude agent API calls (defaults to `OPENROUTER_API_KEY`) |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | No | Model ID mapped to Haiku slot (default: `moonshotai/kimi-k2.5`) |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | No | Model ID mapped to Sonnet slot (default: `moonshotai/kimi-k2.5`) |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | No | Model ID mapped to Opus slot (default: `moonshotai/kimi-k2.5`) |
| `MINIMAX_API_KEY` | For MiniMax agent | MiniMax API key (global region) |
| `MINIMAX_CN_API_KEY` | For MiniMax agent | MiniMax API key (China region, minimaxi.com) |
| `API_KEY` | No | Bearer token to protect HTTP API (omit to disable auth) |
| `PORT` | No | Server port (default: 3000) |
| `WORKSPACE` | No | Agent workspace path (default: `./workspace` locally, `/home/agent/workspace` in Docker) |

At least one agent API key is needed. Agents without their key will fail at prompt time, not at startup.

### With Auth

```bash
API_KEY=my-secret-token node --import tsx examples/server.ts
```

API requests require `Authorization: Bearer my-secret-token` header. The Web UI page (`/`) and healthcheck (`/health`) are served without auth. Enter the API key in the Web UI's header input field to authenticate API calls from the browser. The token is stored in `sessionStorage` (cleared on tab close, never in URL or localStorage).

---

## Docker Deployment

### Build

```bash
docker build -t acp-cloud-runtime .
```

### Run

```bash
docker run -d \
  --name acp-cloud \
  -p 3000:3000 \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e ANTHROPIC_BASE_URL=https://openrouter.ai/api \
  -e ANTHROPIC_AUTH_TOKEN=sk-or-... \
  -e API_KEY=my-secret-token \
  -e WORKSPACE=/home/agent/workspace \
  -v $(pwd)/workspace:/home/agent/workspace \
  -v $(pwd)/config/pi:/home/agent/.pi/agent \
  acp-cloud-runtime
```

### Docker Compose

```bash
# Create .env file
cat > .env << EOF
OPENROUTER_API_KEY=sk-or-...
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_BASE_URL=https://openrouter.ai/api
ANTHROPIC_AUTH_TOKEN=sk-or-...
ANTHROPIC_DEFAULT_HAIKU_MODEL=moonshotai/kimi-k2.5
ANTHROPIC_DEFAULT_SONNET_MODEL=moonshotai/kimi-k2.5
ANTHROPIC_DEFAULT_OPUS_MODEL=moonshotai/kimi-k2.5
MINIMAX_API_KEY=
MINIMAX_CN_API_KEY=
API_KEY=my-secret-token
EOF

# Start
docker compose up -d

# View logs
docker compose logs -f

# Stop
docker compose down
```

### What's in the Image

| Component | Purpose |
|---|---|
| Node.js LTS (Bookworm) | Runtime for server + ACP agents |
| pi-acp + pi-coding-agent | Default ACP coding agent |
| claude-agent-acp | Claude Code ACP agent |
| codex-acp | Codex ACP agent |
| Python 3 | Skills scripts (Dify workflows, etc.) |
| git, curl, jq, ripgrep | Dev tools used by coding agents |
| Non-root `agent` user | Security: agents run without root |
| Healthcheck | `GET /health` every 30s |

### Agent Workspace

Mount your project or workspace directory to `/home/agent/workspace`:

```bash
-v /path/to/your/project:/home/agent/workspace
```

The agent operates within this directory. Place skill definitions in:
- `.pi/skills/` for pi-acp
- `.claude/skills/` for Claude Code agents

### Pi Agent Configuration

Pi reads settings from `~/.pi/agent/settings.json` (inside container: `/home/agent/.pi/agent/settings.json`). Mount your config to customize default provider and model:

```bash
-v $(pwd)/config/pi:/home/agent/.pi/agent
```

Default `config/pi/settings.json`:
```json
{
  "defaultProvider": "openrouter",
  "defaultModel": "moonshotai/kimi-k2.5"
}
```

---

## Cloud Deployment

### Generic VPS (Ubuntu)

```bash
# Install Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs python3 python3-pip git curl jq

# Install pi-acp globally
sudo npm install -g @mariozechner/pi-coding-agent pi-acp

# Clone and install
git clone <repo-url> && cd ai-cloud-code
npm ci --omit=dev

# Run with systemd (see below)
```

### systemd Service

Create `/etc/systemd/system/acp-cloud.service`:

```ini
[Unit]
Description=ACP Cloud Runtime
After=network.target

[Service]
Type=simple
User=agent
WorkingDirectory=/opt/acp-cloud-runtime
ExecStart=/usr/bin/node --import tsx examples/server.ts
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000
EnvironmentFile=/opt/acp-cloud-runtime/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable acp-cloud
sudo systemctl start acp-cloud
sudo journalctl -u acp-cloud -f
```

### Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name acp.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/acp.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/acp.yourdomain.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        # SSE support
        proxy_set_header Connection '';
        proxy_buffering off;
        proxy_cache off;
        chunked_transfer_encoding off;

        # Timeouts for long-running agent sessions
        proxy_read_timeout 600s;
        proxy_send_timeout 600s;
    }
}
```

Key nginx settings for SSE:
- `proxy_buffering off` — don't buffer SSE events
- `proxy_read_timeout 600s` — agent runs can take minutes
- `Connection ''` — prevent connection upgrade issues

---

## API Reference

```
GET    /health                                     Healthcheck (public, no auth)
GET    /config                                     Server config (workspace path)
GET    /agents                                     List available agents
POST   /sessions                                   Create session
GET    /sessions                                   List sessions
GET    /sessions/:id                               Get session details
GET    /sessions/:id/events                        SSE event stream
POST   /sessions/:id/prompt                        Send prompt
POST   /sessions/:id/cancel                        Cancel active run
POST   /sessions/:id/permissions/:reqId/respond    Respond to permission
DELETE /sessions/:id                               Close session
```

### Create Session

```bash
curl -X POST http://localhost:3000/sessions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <API_KEY>' \
  -d '{"agent": "pi", "cwd": "/home/agent/workspace"}'
```

Response:
```json
{
  "id": "uuid",
  "agentId": "pi",
  "status": "ready",
  "createdAt": "2026-03-30T...",
  "lastActivity": "2026-03-30T..."
}
```

### Send Prompt

```bash
curl -X POST http://localhost:3000/sessions/<id>/prompt \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <API_KEY>' \
  -d '{"text": "Hello, write a Python script that prints fibonacci numbers"}'
```

### SSE Event Stream

```bash
curl -N http://localhost:3000/sessions/<id>/events \
  -H 'Authorization: Bearer <API_KEY>'
```

#### SSE Event Types

**Lifecycle events** (emitted by the cloud runtime):

| Event | Description |
|---|---|
| `session_status_changed` | Session status transition (ready/busy/terminated) |
| `run_started` | New prompt run began |
| `run_completed` | Run finished (includes `stopReason`) |
| `run_error` | Run failed with error |
| `permission_request` | Agent needs permission to proceed |
| `permission_timeout` | Permission request timed out |
| `store_error` | Session store persistence error |

**ACP events** (forwarded from the agent process):

| Event | Description |
|---|---|
| `user_message_chunk` | User message content block |
| `agent_message_chunk` | Agent response content block |
| `agent_thought_chunk` | Agent reasoning/thinking content block |
| `tool_call` | New tool invocation with title, kind, status |
| `tool_call_update` | Update to an existing tool call |
| `plan` | Agent plan with entries |
| `available_commands_update` | Available slash commands changed |
| `current_mode_update` | Agent mode changed |
| `config_option_update` | Session config options changed |
| `session_info_update` | Session metadata changed (title, updatedAt) |
| `usage_update` | Token usage and cost update |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Session creation hangs | pi-acp not installed or npx downloading | Pre-install globally: `npm i -g pi-acp` |
| `EADDRINUSE` | Port already in use | `PORT=3001 node --import tsx examples/server.ts` |
| Agent crashes immediately | Missing API key | Set `OPENROUTER_API_KEY` or `ANTHROPIC_API_KEY` |
| SSE events not streaming through nginx | Proxy buffering enabled | Add `proxy_buffering off` |
| Permission denied in container | Running as root | Ensure `USER agent` in Dockerfile |
| `session/close timeout` in logs | Agent slow to respond to close | Normal — falls back to kill after 5s |
