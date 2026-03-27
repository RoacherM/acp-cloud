# ACP Cloud Runtime — MVP Plan

## What This Is

A TypeScript SDK that turns any ACP agent into a cloud-accessible HTTP/SSE service. The "LangGraph Platform for ACP."

```
Client (HTTP/SSE) → CloudRuntime (SDK) → Agent (ACP stdio)
```

---

## ACP Protocol Coverage

### Client → Agent Methods

| ACP Method | Status | Notes |
|---|---|---|
| `initialize` | ✅ Supported | Protocol version + capability negotiation |
| `session/new` | ✅ Supported | Creates session with `cwd` |
| `session/prompt` | ✅ Supported | Full prompt with streaming events |
| `session/cancel` | ❌ Phase 2 | Graceful cancel, session stays alive |
| `session/load` | ❌ Future | Crash recovery (respawn + replay) |
| `session/list` | ❌ Not needed | Runtime manages its own session registry |
| `session/set_mode` | ❌ Future | Agent mode switching (ask/code/architect) |
| `session/set_config_option` | ❌ Future | Dynamic config |
| `session/close` | ❌ UNSTABLE | Runtime uses process kill instead |
| `session/fork` | ❌ UNSTABLE | — |
| `session/resume` | ❌ UNSTABLE | — |
| `session/set_model` | ❌ UNSTABLE | — |
| `authenticate` | ❌ UNSTABLE | — |

### Agent → Client Callbacks

| ACP Callback | Status | Notes |
|---|---|---|
| `session/update` | ✅ All 11 types | Full event streaming to client |
| `client/request_permission` | ✅ Auto-resolve | `approve-all` / `deny-all` work; `approve-reads` degrades |
| `client/request_permission` | ❌ Phase 2 | Interactive delegation (`delegate` mode) |
| `fs/read_text_file` | ✅ Sandboxed | Path-validated to session `cwd` |
| `fs/write_text_file` | ✅ Sandboxed | Path-validated to session `cwd` |
| `terminal/create` | ❌ Disabled | Security: no terminal in cloud |
| `terminal/output` | ❌ Disabled | — |
| `terminal/kill` | ❌ Disabled | — |

### Session Events Streamed (14 types)

**ACP events (11):** `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update`

**Lifecycle events (3):** `run_started`, `run_completed`, `session_status_changed`

**Phase 2 adds (2):** `permission_request`, `permission_timeout`

### Capability Negotiation

| Capability | Status |
|---|---|
| `fs.readTextFile` | ✅ When `cwd` provided |
| `fs.writeTextFile` | ✅ When `cwd` provided |
| `terminal` | ❌ Explicitly `false` |
| `mcp` | ❌ Agent's responsibility |
| `audio` / `image` | ❌ Not negotiated |

---

## HTTP/SSE API

### Current Endpoints (examples/server.ts)

```
GET    /agents                              → List available agents
POST   /sessions                            → Create session
GET    /sessions                            → List sessions
GET    /sessions/:id                        → Get session info
GET    /sessions/:id/events                 → SSE event stream
POST   /sessions/:id/prompt                 → Send prompt
DELETE /sessions/:id                        → Close session
```

### Phase 2 Additions

```
POST   /sessions/:id/cancel                → Cancel active run
POST   /sessions/:id/permissions/:rid/respond  → Respond to permission request
```

### SSE Event Stream

Client connects to `GET /sessions/:id/events`, receives:

```
event: connected
data: {"sessionId":"..."}

event: session_status_changed
data: {"type":"session_status_changed","from":"ready","to":"busy","reason":"prompt_started"}

event: run_started
data: {"type":"run_started","sessionId":"...","runId":"..."}

event: agent_message_chunk
data: {"type":"agent_message_chunk","sessionId":"...","runId":"...","content":{"type":"text","text":"Hello"}}

event: tool_call
data: {"type":"tool_call","sessionId":"...","runId":"...","toolCallId":"...","title":"read_file","kind":"read"}

event: run_completed
data: {"type":"run_completed","sessionId":"...","runId":"...","stopReason":"end_turn"}

event: session_status_changed
data: {"type":"session_status_changed","from":"busy","to":"ready","reason":"run_completed"}
```

### Typical Client Flow

```
1. GET  /agents                           → ["claude","codex","pi"]
2. POST /sessions  {agent:"claude",cwd:"/app"}  → {id, status:"ready", eventsUrl, promptUrl}
3. GET  /sessions/:id/events              → SSE stream opens
4. POST /sessions/:id/prompt {text:"..."}  → {runId, status:"running"}
   ... SSE events flow ...
   ... run_completed arrives ...
5. POST /sessions/:id/prompt {text:"..."}  → next turn
6. DELETE /sessions/:id                    → session closed
```

---

## Session State Machine

```
[*] → ready : createSession() blocks until ready
ready → busy : promptSession()
busy → ready : run completes (end_turn / max_tokens / cancelled)
busy → terminated : close() or agent crash
ready → terminated : close() or agent crash
terminated → [*]
```

**Key:** `busy` is derived from `activeRunId !== null`, not persisted. Only `ready` | `terminated` are durable.

---

## SDK Public API (CloudRuntime)

### Current (Phase 1.5)

```typescript
createSession(opts: { agent, cwd, permissionMode? }): Promise<SessionInfo>
getSession(id): Promise<SessionInfo | null>
listSessions(filter?): Promise<SessionInfo[]>
closeSession(id): Promise<void>
promptSession(id, content: ContentBlock[]): Promise<RunInfo>
subscribeSession(id): AsyncIterable<SessionEvent>
listAgents(): string[]
shutdown(): Promise<void>
```

### Phase 2 Additions

```typescript
cancelRun(sessionId, runId?): Promise<void>
respondToPermission(sessionId, requestId, optionId): Promise<void>
```

---

## Phased Roadmap

### Phase 1 — Core Runtime ✅ Done

- CloudRuntime with manual agent config
- AgentPool: spawn, initialize, session/new, prompt
- MemorySessionStore
- Permission: approve-all only
- Event streaming: all 11 ACP event types + 3 lifecycle events
- Tested with pi-acp

### Phase 1.5 — Architecture Refactoring ✅ Done

- Id-centric API (no session objects)
- SessionController actor model
- EventHub with run buffering for late subscribers
- Durable/ephemeral state separation (RecordStatus vs SessionStatus)
- Crash supervision (AgentPool exit callback)
- Admission control (maxAgentProcesses, maxActiveSessions)
- SandboxedFsHandler wired to ACP client
- 61 tests passing

### Phase 2 — Persistence, Permission Delegation & Cancel ← Current

- **FileSessionStore**: JSON-per-session durable persistence
- **Permission delegation**: `delegate` mode (interactive via EventHub); fix `approve-reads`
- **cancelRun**: graceful ACP `session/cancel`
- **Cleanup**: remove `mcpServers` from session path (agent's responsibility)

### Phase 3 — HTTP/SSE Server (Layer 3)

- Promote `examples/server.ts` to production `src/server.ts`
- All REST endpoints including cancel + permission response
- Permission bridge (SSE push → POST respond)
- Request validation
- Basic auth middleware
- Graceful shutdown
- OpenAPI spec

### Phase 4 — Reliability & Lifecycle

- Crash recovery (respawn + `session/load`)
- Session TTL / sleeping states
- Prompt queue / backpressure
- `session/set_mode` support

### Phase 5 — Client SDK & Ecosystem

- `CloudClient`: typed HTTP/SSE client
- React hooks: `useSession()`, `usePrompt()`
- ACP registry integration (auto-discover agents)
- Multi-agent validation (Claude, Codex, Gemini, Goose)
- PostgresSessionStore

---

## What We Explicitly Don't Do

| Feature | Reason |
|---|---|
| Terminal access | Security: no terminal in cloud runtime |
| MCP server management | Agent's responsibility, not runtime's |
| Conversation storage | Agent owns history; runtime stores metadata only |
| Agent authentication | UNSTABLE in ACP spec |
| Container sandboxing | Post-MVP |
| Multi-tenancy | Post-MVP |
| Agent orchestration | Post-MVP (fan-out, chaining) |
