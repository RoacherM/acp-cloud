# ACP Cloud Runtime — MVP Plan Refined

## Status

This document is the refined MVP definition for the current runtime direction.

It narrows the product boundary compared with the broader roadmap documents:

- The runtime is a session lifecycle and event-streaming layer.
- It does not act as a full ACP environment client.
- It does not manage MCP servers, filesystem access, or terminal access for agents.

The practical goal is:

> Run compatible ACP agents as a remote service over HTTP/SSE.

Not:

> Support any ACP agent, regardless of required client capabilities.

---

## What This Is

A TypeScript runtime that turns compatible ACP agents into a cloud-accessible HTTP/SSE service.

```text
Client (HTTP/SSE) -> CloudRuntime -> Agent (ACP stdio)
```

The runtime owns:

- session creation
- prompt execution
- event streaming
- permission delegation
- cancellation
- session shutdown
- lightweight session metadata persistence

The agent owns:

- conversation history
- tool semantics
- MCP loading and recovery
- any environment-specific capabilities it requires internally

---

## Product Boundary

### Runtime Responsibilities

- Maintain session registry and lifecycle state
- Spawn and supervise ACP agent processes
- Route prompts and cancellations
- Stream session events to external clients
- Bridge interactive permission requests
- Persist `SessionRecord` metadata

### Runtime Does Not Manage

- MCP server configuration
- client-side filesystem operations
- terminal operations
- conversation transcript storage
- container sandboxing
- multi-tenant isolation

### MCP Boundary

MCP is agent-owned, not runtime-owned.

Implications:

- `CreateSessionOptions` should not expose session-scoped `mcpServers`
- `SessionRecord` should not persist MCP config
- crash recovery, when added later, should not depend on runtime-managed MCP state
- agents that require runtime-provided MCP configuration are outside this MVP compatibility model

Protocol note:

- The ACP SDK currently expects an `mcpServers` field on some session requests.
- The runtime may pass `mcpServers: []` internally to satisfy protocol shape.
- This is a protocol compatibility detail, not a product capability.

---

## ACP-Native MVP Surface

### Client -> Agent Methods

| ACP Method | MVP Status | Notes |
|---|---|---|
| `initialize` | ✅ Supported | Protocol version + capability negotiation |
| `session/new` | ✅ Supported | Creates a session with `cwd` |
| `session/prompt` | ✅ Supported | Main execution path |
| `session/cancel` | ✅ Phase 2 | Graceful run cancellation |
| `session/load` | ❌ Post-MVP | Needed for crash recovery, not MVP |
| `session/list` | ❌ Not needed | Runtime owns registry |
| `session/set_mode` | ❌ Post-MVP | Useful, but not required for service MVP |
| `session/set_config_option` | ❌ Post-MVP | Not part of MVP cut line |
| `session/close` | ✅ MVP required | Graceful session teardown; compatible agents must support it |
| unstable ACP methods | ❌ Out | Not part of MVP |

### Agent -> Client Callbacks

| ACP Callback | MVP Status | Notes |
|---|---|---|
| `session/update` | ✅ Supported | Core event stream |
| `client/request_permission` | ✅ Supported | Auto modes + delegated mode |
| `fs/read_text_file` | ❌ Unsupported | Runtime does not expose client-side FS |
| `fs/write_text_file` | ❌ Unsupported | Runtime does not expose client-side FS |
| `terminal/create` | ❌ Unsupported | No terminal capability |
| `terminal/output` | ❌ Unsupported | No terminal capability |
| `terminal/kill` | ❌ Unsupported | No terminal capability |

### Capability Negotiation

| Capability | Status | Notes |
|---|---|---|
| `fs` | ❌ Not advertised | No client-side file IO |
| `terminal` | ❌ Explicitly disabled | No terminal support |
| `auth` | Optional later | Not required for runtime MVP internals |
| `elicitation` | ❌ Not used | Permission bridge is the relevant interaction path |

`mcp` is not a capability-negotiation item in ACP and should not appear in the capability table.

---

## Session Model

The session model remains intentionally small:

```text
ready <-> busy -> terminated
```

Key rules:

- `busy` is derived from an active run, not stored durably
- `SessionRecord` stores only lightweight metadata
- `SessionExecution` stores only live process state
- conversation history stays inside the agent

This is the right shape for an "agent as a service" runtime. The runtime manages process/session orchestration, not the agent's internal memory model.

---

## Permission Model

Permission delegation is part of the MVP because it is required to safely expose interactive agents as a service.

### Supported Modes

| Mode | Behavior |
|---|---|
| `approve-all` | Auto-allow |
| `deny-all` | Auto-deny |
| `approve-reads` | Auto-allow read-only operations; delegate the rest |
| `delegate` | Delegate all permission requests to the external client |

### MVP Permission Flow

```text
agent requestPermission
-> SessionController receives callback
-> runtime either auto-resolves or emits permission_request
-> external client responds by API
-> runtime resolves ACP permission request
```

This is enough to support "use agent as a service" without turning the runtime into a full interactive IDE client.

---

## HTTP/SSE Service Shape

### Current Example Server

Today the example server demonstrates the basic transport shape:

```text
GET    /agents
POST   /sessions
GET    /sessions
GET    /sessions/:id/events
POST   /sessions/:id/prompt
DELETE /sessions/:id
```

### MVP Completion API

The refined MVP is considered complete when the production server exposes:

```text
GET    /agents
POST   /sessions
GET    /sessions
GET    /sessions/:id
GET    /sessions/:id/events
POST   /sessions/:id/prompt
POST   /sessions/:id/cancel
POST   /sessions/:id/permissions/:requestId/respond
DELETE /sessions/:id
```

### Event Stream Expectations

The event stream is the primary interface for long-running work:

- lifecycle events
- ACP forwarded session updates
- permission request events
- permission timeout events

This preserves the "agent as a service" model: request/response for control, SSE for run progress.

---

## Phased MVP Cut

### Phase 1 — Core Runtime

Delivered foundation:

- `CloudRuntime`
- `AgentPool`
- `SessionController`
- in-memory session persistence
- event streaming
- basic permission auto-resolution

### Phase 1.5 — Architecture Refactor

Delivered architecture cleanup:

- id-centric runtime API
- per-session actor model
- durable vs ephemeral state split
- event buffering for active runs
- crash supervision
- admission control

### Phase 2 — Persistence, Permission Delegation, Cancel

Required before service completion:

- `FileSessionStore`
- interactive permission delegation
- correct `approve-reads`
- `cancelRun`
- remove session-scoped MCP management from runtime API
- ensure unsupported client capabilities stay disabled

### Phase 3 — Production HTTP/SSE Service

This is the MVP completion line.

Required:

- production server promoted from example
- complete REST + SSE surface
- graceful session close via ACP `session/close`
- permission response bridge
- request validation
- basic auth
- graceful shutdown
- basic operational documentation

### Post-MVP

Deferred work:

- crash recovery with `session/load`
- TTL / sleeping / queueing
- `session/set_mode`
- registry integration
- client SDK / React hooks
- Web UI: sidebar with session history + message persistence (runtime-side SSE event capture)
- container sandboxing
- multi-tenancy
- Postgres-backed persistence

---

## MVP Completion Criteria

The MVP is complete only when all of the following are true:

1. A remote client can create a session against a compatible ACP agent.
2. A remote client can prompt that session and receive a complete SSE event stream.
3. A remote client can cancel an active run without killing the session.
4. A remote client can respond to delegated permission requests.
5. Session metadata survives process restarts via `FileSessionStore`.
6. The service can close sessions cleanly via ACP `session/close`.
7. Compatibility boundaries are documented clearly.
8. At least 2 to 3 compatible agents pass end-to-end validation.

Important:

- End of Phase 2 is not yet MVP complete.
- End of Phase 3 is the correct MVP cut line.

---

## Compatibility Model

This runtime is compatible with ACP agents that:

- work over stdio ACP
- support `session/close`
- do not require client-provided filesystem callbacks
- do not require terminal callbacks
- do not require runtime-managed MCP configuration
- can operate with the runtime's supported permission flow

This runtime is not aiming to support all ACP agents universally.

That is an intentional product decision, not a temporary limitation.

---

## Explicit Non-Goals

These are not part of the MVP:

- cloud filesystem proxying
- terminal proxying
- runtime-managed MCP lifecycle
- transcript persistence
- general-purpose IDE remoting
- agent orchestration across multiple sessions
- multi-tenant hard isolation

The runtime should stay narrow: agent session orchestration as a service.
