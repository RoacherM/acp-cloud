# ACP Cloud Runtime — Architecture Overview

## Positioning

The missing piece of the ACP ecosystem: turn any ACP Agent into a cloud service accessible via HTTP/SSE.

```
Ecosystem Role            Project
─────────────────────────────────────────
Protocol Spec             ACP (agentclientprotocol.com)
Protocol SDK              @agentclientprotocol/sdk
Agent Adapters            claude-agent-acp, codex-acp, + native agents
IDE Integration           Zed
Cloud Runtime ←           This project (the missing piece)
```

## Two-Layer Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Frontend / API Callers                     │
│              Web Apps · CLI Tools · Third-Party Clients       │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP + SSE
┌──────────────────────────┴──────────────────────────────────┐
│  Layer 2 · HTTP/SSE Server (optional, built on Layer 1)      │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │ REST API │ │SSE Stream│ │Permission│ │  Auth        │   │
│  │ /agents  │ │ Event    │ │ Bridge   │ │  Middleware   │   │
│  │/sessions │ │ Fan-out  │ │SSE→POST  │ │  (API key)   │   │
│  │ /prompt  │ │          │ │ Respond  │ │              │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │ CloudRuntime API
┌──────────────────────────┴──────────────────────────────────┐
│  Layer 1 · Core SDK (primary deliverable)                    │
│                                                              │
│  ┌────────────────────────┐ ┌────────────────────────────┐  │
│  │   SessionController    │ │       AgentPool             │  │
│  │ Create · Prompt · Close│ │ Spawn · Kill · Exit detect  │  │
│  │ Two IDs: id + acpSess. │ │ child_process.spawn         │  │
│  │ Run lifecycle tracking │ │                             │  │
│  └────────────────────────┘ └────────────────────────────┘  │
│                                                              │
│  ┌──────────────┐ ┌──────────────────┐ ┌──────────────┐    │
│  │   EventHub   │ │ PermissionCtrl   │ │ SessionStore │    │
│  │ Per-session   │ │approve-all       │ │Memory · File │    │
│  │ event stream  │ │approve-reads     │ │Pluggable     │    │
│  │ Run buffering │ │deny-all          │ │  interface   │    │
│  │ + replay      │ │delegate (to SSE) │ │              │    │
│  └──────────────┘ └──────────────────┘ └──────────────┘    │
└──────────────────────────┬──────────────────────────────────┘
                           │ ClientSideConnection
┌──────────────────────────┴──────────────────────────────────┐
│  Layer 0 · @agentclientprotocol/sdk (direct dependency)      │
│  ┌──────────────────┐ ┌────────────┐ ┌──────────────────┐  │
│  │ClientSideConn.   │ │ndJsonStream│ │ Protocol types   │  │
│  │JSON-RPC bidir    │ │stdio↔NDJSON│ │SessionUpdate etc.│  │
│  └──────────────────┘ └────────────┘ └──────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │ stdio (stdin/stdout NDJSON)
┌──────────────────────────┴──────────────────────────────────┐
│  ACP Agent Processes (launched as-is, no modifications)      │
│                                                              │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐              │
│  │ Claude │ │ Codex  │ │ Gemini │ │Copilot │              │
│  │adapter │ │adapter │ │native  │ │native  │              │
│  └────────┘ └────────┘ └────────┘ └────────┘              │
└─────────────────────────────────────────────────────────────┘
```

## Resource Model

Modeled after LangGraph Platform resource abstractions:

```
ACP Cloud Runtime     LangGraph Platform    Description
─────────────────────────────────────────────────────
Agent                 Assistant             Agent type from config
Session               Thread                Persistent conversation, bound to one agent process
Run                   Run                   One prompt → response lifecycle
Event                 Stream event          Fine-grained SSE events (1:1 ACP session/update mapping)
```

## Key Data Flows

### 0. Concurrency Model

#### Deployment Constraint: Single Instance

Current version is single-instance only. No cross-instance session migration, distributed locks, or shared-nothing clustering.

```
Total throughput = min(active session concurrency, maxAgentProcesses, host CPU/memory)
```

#### Global Resource Limits

| Parameter | Default | Description |
|-----------|---------|-------------|
| `maxAgentProcesses` | 20 | Max concurrent agent processes |
| `maxActiveSessions` | 50 | Max non-terminated sessions |
| `defaultPermissionMode` | `approve-all` | Default permission mode for new sessions |
| `permissionTimeoutMs` | 30000 | Timeout before auto-rejecting delegated permission requests |

#### Admission Control

When limits are reached, new session creation is rejected:

```
controllers.size + pendingCreations >= maxActiveSessions → Error('Max active sessions reached')
controllers.size + pendingCreations >= maxAgentProcesses → Error('Max agent processes reached')
```

There is no TTL-based sleep/wake cycle or resource reclamation. Sessions stay alive until explicitly closed or the agent process crashes.

#### Per-Session Serial, Inter-Session Parallel

**Core constraint: one Session has at most one active Run at a time.**

This is an inherent ACP protocol semantic -- `session/prompt` is request-response; the agent must respond before the turn ends.

**Different Sessions run fully in parallel.** Session A's run does not block Session B. Each Session has its own agent process and `ClientSideConnection`.

```
Client A                  Cloud Runtime                    Agent
  │                           │                              │
  │ POST prompt "fix login"   │                              │
  │──────────────────────────>│ status=ready → execute       │
  │                           │ session/prompt ──────────────>│
  │  SSE: events...           │<─────────────────────────────│
  │<──────────────────────────│                              │
  │                           │                              │
Client B                      │                              │
  │ POST prompt "add feature" │                              │
  │──────────────────────────>│ status=busy → 409 Conflict   │
  │  409 "Cannot prompt:      │                              │
  │   session status is busy" │                              │
  │<──────────────────────────│                              │
```

**Rules:**
- If a session is `busy`, new prompts are rejected with an error (no queue)
- `POST /sessions/:id/cancel` sends ACP `session/cancel` to the agent
- Client SSE disconnect does not affect run execution (run continues, events buffer for replay)

---

### 1. Prompt → Response

```
Client                   Cloud Runtime                   Agent Process
  │                         │                               │
  │ POST /sessions/:id/     │                               │
  │      prompt             │                               │
  │────────────────────────>│ status=ready → execute        │
  │                         │ session/prompt                │
  │  202 {runId, status:    │──────────────────────────────>│
  │       "running"}        │                               │
  │<────────────────────────│                               │
  │                         │ session/update                 │
  │                         │  (agent_message_chunk)         │
  │  SSE: agent_message_    │<──────────────────────────────│
  │       chunk             │                               │
  │<────────────────────────│ session/update                 │
  │                         │  (tool_call)                   │
  │  SSE: tool_call         │<──────────────────────────────│
  │<────────────────────────│                               │
  │                         │ session/update                 │
  │  SSE: tool_call_update  │  (tool_call_update)            │
  │<────────────────────────│<──────────────────────────────│
  │                         │                               │
  │  SSE: run_complete      │ prompt response                │
  │<────────────────────────│<──────────────────────────────│
```

### 2. Permission Request (delegate mode / approve-reads with write operation)

```
Client                   Cloud Runtime                   Agent Process
  │                         │                               │
  │                         │ requestPermission              │
  │                         │  (kind: edit)                  │
  │                         │<──────────────────────────────│
  │                         │                               │
  │                         │ PermissionController:          │
  │                         │  mode=approve-reads            │
  │                         │  kind=edit → delegate          │
  │                         │                               │
  │  SSE: permission_       │                               │
  │       request           │                               │
  │<────────────────────────│                               │
  │                         │                               │
  │ POST /sessions/:id/     │                               │
  │  permissions/:reqId/    │                               │
  │  respond                │                               │
  │  {optionId: "opt_3a7x"} │  ← opaque token, returned    │
  │────────────────────────>│    as-is to agent              │
  │                         │                               │
  │                         │ respond(optionId)              │
  │                         │──────────────────────────────>│
  │                         │                               │
  │                         │ (agent continues tool exec)    │
```

**Important:** `optionId` is an opaque token from the agent. The client must return it as-is.
Each agent may use different option ID formats -- semantic info is in `option.name` and `option.kind`,
but the response only needs the `optionId` string.

**Timeout:** If no client response within `permissionTimeoutMs` (default 30s), the request auto-resolves
with a `reject_once` or `reject_always` option, and a `permission_timeout` event is emitted.

### 3. Agent Process Crash

```
Cloud Runtime                              Agent Process
  │                                           │
  │  Detects process exit (exit/signal)       │ ✗
  │                                           │
  │  Cancel pending permissions               │
  │  Cancel active run (if any)               │
  │  session.status = 'terminated'            │
  │  Emit session_status_changed              │
  │  Close EventHub                           │
```

There is no crash recovery or respawn. When an agent process dies unexpectedly, the session transitions directly to `terminated`.

### 4. Agent Discovery & Launch

```
CloudRuntime.createSession({agent: "claude-code"})
  │
  ▼
AgentPool.spawn(agentId)
  │
  ▼
Lookup AgentDefinition from config
  { command: "npx", args: ["-y", "@anthropic-ai/claude-code", "--agent"] }
  │
  ▼
child_process.spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] })
  │
  ▼
ndJsonStream(stdin, stdout)
  │
  ▼
ClientSideConnection
  │
  ▼
initialize({ protocolVersion, clientInfo, clientCapabilities })
  │
  ▼
AgentHandle { pid, connection, agentInfo, agentCapabilities, handlers }
  │
  ▼
connection.newSession({ cwd, mcpServers: [] })
  │
  ▼
Session ready (status: 'ready')
```

Agents are defined in the `RuntimeConfig.agents` map — a `Record<string, AgentDefinition>` where each entry specifies `command`, `args`, optional `env`, and optional `capabilities`. There is no registry fetching or agent installation; agents must be pre-configured.

## Session State Machine

```
                spawn + initialize + session/new
    ────────────────────────────────────────────► [ready]
                                                    │  ▲
                                             prompt │  │ run complete
                                                    ▼  │
                                                 [busy]
                                                    │
                            ┌───────────────────────┤
                            │                       │
                     user close /              process crash
                     DELETE session
                            │                       │
                            ▼                       ▼
                                 [terminated]

  Notes:
  - User close from ready or busy → terminated
  - Process crash from ready or busy → terminated (no recovery)
  - Close attempts ACP session/close if agent supports it, then SIGTERM
```

**State descriptions:**

| Status | Process Alive | Description |
|--------|--------------|-------------|
| `ready` | Yes | Idle, can accept a prompt |
| `busy` | Yes | Executing a prompt (one active run) |
| `terminated` | No | Session ended (user closed, crash, or init failure) |

**Internal vs Public status:**

The `SessionRecord` (durable, persisted to store) has `RecordStatus`: `'ready' | 'terminated'`.

The public `SessionStatus` adds `'busy'`: derived at query time from `RecordStatus` + whether `execution.activeRunId` is set.

```typescript
function derivePublicStatus(record, execution): SessionStatus {
  if (record.status === 'terminated') return 'terminated';
  if (execution?.activeRunId) return 'busy';
  return 'ready';
}
```

## Session ID Model

```
┌─────────────────────────────────────────────────────────┐
│  id (Runtime session ID)                                 │
│  ├── UUID generated by CloudRuntime                      │
│  ├── Persisted in SessionStore                           │
│  └── Used in all HTTP API paths                          │
│                                                          │
│  acpSessionId (ACP protocol session ID)                  │
│  ├── Obtained from session/new response                  │
│  ├── Used for session/prompt, session/cancel, etc.       │
│  └── Internal — not exposed to HTTP clients              │
└─────────────────────────────────────────────────────────┘
```

## HTTP API Routes

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Health check (no auth) |
| `GET` | `/config` | Returns workspace path |
| `GET` | `/agents` | List configured agent IDs |
| `POST` | `/sessions` | Create session `{agent, cwd?, permissionMode?}` → 201 |
| `GET` | `/sessions` | List all sessions |
| `GET` | `/sessions/:id` | Get session info |
| `GET` | `/sessions/:id/events` | SSE event stream |
| `POST` | `/sessions/:id/prompt` | Send prompt `{text}` → 202 `RunInfo` |
| `POST` | `/sessions/:id/cancel` | Cancel active run |
| `POST` | `/sessions/:id/permissions/:reqId/respond` | Respond to permission `{optionId}` |
| `DELETE` | `/sessions/:id` | Close and terminate session |

**Auth:** Optional API key via `Bearer` token in `Authorization` header. Public paths (`/health`, `/`) and static assets skip auth.

**Error classification:**
- `404` — session/agent not found
- `409` — cannot prompt (busy), invalid permission response
- `400` — malformed JSON or validation failure
- `500` — unexpected errors

## Event System

### Event Types

Events are delivered via SSE on `GET /sessions/:id/events`.

**ACP events** (mapped 1:1 from ACP `session/update` notifications):
- `user_message_chunk` — echoed user message content
- `agent_message_chunk` — agent response content
- `agent_thought_chunk` — agent thinking/reasoning content
- `tool_call` — tool invocation started
- `tool_call_update` — tool invocation progress/completion
- `plan` — agent plan entries
- `available_commands_update` — available slash commands changed
- `current_mode_update` — agent mode changed
- `config_option_update` — configuration options changed
- `session_info_update` — session title/timestamp changed
- `usage_update` — token usage and cost update

**Lifecycle events** (emitted by SessionController):
- `run_started` — run began
- `run_completed` — run finished (includes `stopReason`)
- `run_error` — run failed with error

**Control events:**
- `session_status_changed` — status transition (`from`, `to`, `reason`)
- `permission_request` — permission delegation to client
- `permission_timeout` — permission auto-rejected after timeout
- `store_error` — session store persistence failure (non-fatal)

### EventHub & Run Buffering

Each session has an `EventHub` that manages event distribution:
- Late subscribers receive a replay of buffered events from the current run (starting from `run_started`)
- Buffer is cleared when the run completes
- `status_changed` events are emitted *before* the buffer starts, so they are not replayed

## Session Store

Pluggable persistence via the `SessionStore` interface:

```typescript
interface SessionStore {
  create(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  update(record: SessionRecord): Promise<void>;
  delete(id: string): Promise<void>;
  list(filter?: SessionFilter): Promise<SessionRecord[]>;
}
```

**Implementations:**
- `MemorySessionStore` — in-memory `Map`, copy-on-read/write semantics
- `FileSessionStore` — JSON files in a directory, atomic writes via rename

**SessionFilter** supports filtering by `agentId` and/or `status`.

## Deployment

Core value: **deploy our server, users access agents via standard HTTP/SSE.**

```
Deployment                Command/Usage                     Use Case
──────────────────────────────────────────────────────────────────────
docker compose up         Container deployment              Production
createServer(runtime)     Programmatic                      Embed in existing Node service
new CloudRuntime(config)  SDK only                          Custom server framework
```

```
Client  ──HTTP/SSE──►  acp-cloud server  ──stdio/ACP──►  Agent Process
                       (our deliverable)                  (Claude/Codex/Gemini...)
```

Users don't need to understand the ACP protocol or manage agent processes. They call standard HTTP APIs.

**Boundary:** Current version is single-instance only. No cross-instance session migration or distributed locks.

## Design Principles

| # | Principle | Description |
|---|-----------|-------------|
| 1 | **ACP Native** | Use the protocol directly, no invented abstractions |
| 2 | **Don't Reinvent Wheels** | Depend on @agentclientprotocol/sdk, launch agents as-is |
| 3 | **Library First** | Importable SDK (Layer 1), HTTP server optional (Layer 2) |
| 4 | **Agent Agnostic** | Any ACP-speaking agent works with zero code changes |
| 5 | **Fine-Grained Streaming** | Every ACP session/update event is forwarded to the client |
| 6 | **Community Aligned** | Track ACP spec evolution, design for Proxy Chains compatibility |
