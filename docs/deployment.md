# ACP Cloud Runtime — Deployment Guide

## Quick Start (Local)

```bash
# Clone and install
git clone <repo-url> && cd ai-cloud-code
npm install

# Set API key
export ANTHROPIC_API_KEY=sk-ant-...

# Start server
node --import tsx examples/server.ts
```

Open http://localhost:3000 for the Web UI.

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `ANTHROPIC_API_KEY` | For Claude agent | Anthropic API key |
| `OPENROUTER_API_KEY` | For Pi agent | OpenRouter API key (pi default provider) |
| `OPENAI_API_KEY` | For Codex agent | OpenAI API key |
| `API_KEY` | No | Bearer token to protect HTTP API (omit to disable auth) |
| `PORT` | No | Server port (default: 3000) |

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
  -e ANTHROPIC_API_KEY=sk-ant-... \
  -e OPENROUTER_API_KEY=sk-or-... \
  -e OPENAI_API_KEY=sk-... \
  -e API_KEY=my-secret-token \
  -v $(pwd)/workspace:/home/agent/workspace \
  -v $(pwd)/config/pi:/home/agent/.pi/agent \
  acp-cloud-runtime
```

### Docker Compose

```bash
# Create .env file
cat > .env << EOF
ANTHROPIC_API_KEY=sk-ant-...
OPENROUTER_API_KEY=sk-or-...
OPENAI_API_KEY=sk-...
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
| Node.js 22 | Runtime for server + pi-acp |
| pi-acp + pi-coding-agent | Default ACP coding agent |
| Python 3 | Skills scripts (Dify workflows, etc.) |
| git, curl, jq, ripgrep | Dev tools used by coding agents |
| Non-root `agent` user | Security: agents run without root |
| Healthcheck | `GET /agents` every 30s |

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

Events: `session_status_changed`, `run_started`, `agent_thought_chunk`, `agent_message_chunk`, `tool_call`, `tool_call_update`, `run_completed`, `run_error`, `permission_request`, `permission_timeout`, `store_error`

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Session creation hangs | pi-acp not installed or npx downloading | Pre-install globally: `npm i -g pi-acp` |
| `EADDRINUSE` | Port already in use | `PORT=3001 node --import tsx examples/server.ts` |
| Agent crashes immediately | Missing API key | Set `ANTHROPIC_API_KEY` |
| SSE events not streaming through nginx | Proxy buffering enabled | Add `proxy_buffering off` |
| Permission denied in container | Running as root | Ensure `USER agent` in Dockerfile |
| `session/close timeout` in logs | Agent slow to respond to close | Normal — falls back to kill after 5s |
