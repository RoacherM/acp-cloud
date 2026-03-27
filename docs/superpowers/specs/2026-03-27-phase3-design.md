# Phase 3: Production HTTP/SSE Server — Design Spec

> **Status:** Approved design. This is the MVP completion line.
>
> **Prerequisite:** Phase 2 complete (FileSessionStore, permission delegation, cancelRun, run_error event).
>
> **Authoritative scope:** `docs/mvp-plan-refined.md`

---

## Goal

Promote the example HTTP server to a production-grade, exportable `createServer()` factory. Add ACP `session/close` for graceful teardown. This completes the MVP: any compatible ACP agent is accessible as a cloud service over HTTP/SSE.

---

## Architecture

```
src/server.ts        → createServer(runtime, opts) returns Hono app
examples/server.ts   → ~15 lines: new CloudRuntime + createServer + serve()
```

### Dependencies

| Dependency | Purpose |
|---|---|
| `hono` (new) | Router, middleware, SSE streaming (~14KB, zero native deps, TS-first) |
| `@hono/node-server` (new) | Hono adapter for Node `http.createServer` |
| `zod` (existing) | Request body validation |

No additional dependencies. No Hono zod middleware — validation is a thin in-house helper.

---

## REST API Surface

```
GET    /agents                                    → list available agents
POST   /sessions                                  → create session
GET    /sessions                                   → list sessions
GET    /sessions/:id                               → single session details (new)
GET    /sessions/:id/events                        → SSE event stream
POST   /sessions/:id/prompt                        → send prompt
POST   /sessions/:id/cancel                        → cancel active run
POST   /sessions/:id/permissions/:reqId/respond    → respond to permission request
DELETE /sessions/:id                               → close session
```

### Request Validation (Zod, minimal)

| Endpoint | Schema |
|---|---|
| `POST /sessions` | `{ agent: string, cwd?: string, permissionMode?: PermissionMode }` |
| `POST /sessions/:id/prompt` | `{ text: string }` |
| `POST /sessions/:id/permissions/:reqId/respond` | `{ optionId: string }` |

Validation failure returns `400 { error: "<human-readable description>" }`.

Implementation: a thin helper function in `src/server.ts` that takes a Zod schema and the request body, returns parsed data or throws a 400. Not a Hono middleware — just a function call per endpoint.

### Error Response Format

All 4xx/5xx responses use a single shape:

```json
{ "error": "Session not found: abc-123" }
```

Runtime throw messages are forwarded directly.

---

## Authentication

Bearer token auth, optional.

- `ServerOptions.apiKey` — if provided, all routes require `Authorization: Bearer <key>`
- Missing or mismatched token → `401 { error: "Unauthorized" }`
- If `apiKey` is not provided → auth disabled (local dev mode)
- Implemented as a Hono middleware applied to all routes

Agent credentials (e.g., `ANTHROPIC_API_KEY`) are passed via `AgentDefinition.env` to the spawned agent process. This already works — no changes needed.

---

## SSE Event Streaming

Replace the manual `Map<sessionId, Set<ServerResponse>>` broadcaster with Hono's native `streamSSE`:

```typescript
app.get('/sessions/:id/events', async (c) => {
  return streamSSE(c, async (stream) => {
    for await (const event of runtime.subscribeSession(id)) {
      await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
    }
  });
});
```

- Each SSE connection independently consumes `subscribeSession()` via AsyncIterable
- Connection close → Hono interrupts the stream → `for await` exits naturally
- EventHub already supports multiple subscribers
- No manual client tracking, no broadcast function, no `req.on('close')` cleanup

---

## ACP `session/close`

### Current Behavior

`SessionController.close()` kills the agent process directly via `pool.kill(handle)`.

### New Behavior

```
cancelActiveRun()
→ check agent capability: agentCapabilities.sessionCapabilities?.close
→ if supported: connection.unstable_closeSession({ sessionId }) with 5s timeout
→ if unsupported / timeout / error: skip
→ pool.kill(handle)
→ persist record → emit terminated
```

### Required Changes

1. **`AgentHandle`**: add `agentCapabilities` field, populated from `initialize()` response
2. **`SessionController.close()`**: attempt ACP `session/close` before kill, with timeout
3. **No changes to `runtime.shutdown()`**: it already calls `ctrl.close()` for each controller — the new `session/close` logic flows through naturally

### Edge Cases

- Agent doesn't declare `session.close` capability → direct kill (same as today)
- `session/close` times out after 5s → kill, don't block shutdown
- `session/close` throws → catch, ignore, kill

---

## Graceful Shutdown

Signal-driven only. No HTTP shutdown endpoint.

```
SIGTERM / SIGINT received
  1. server.close()              — stop accepting new connections
  2. await runtime.shutdown()    — close all sessions (session/close + kill)
  3. process.exit(0)
```

`runtime.shutdown()` already iterates all controllers and calls `close()`. With the `session/close` improvement above, each agent gets a chance to clean up before being killed.

Shutdown is the caller's responsibility (in `examples/server.ts`), not built into `createServer()`.

---

## File Changes

### New Files

| File | Responsibility |
|---|---|
| `src/server.ts` | `createServer(runtime, opts)` → Hono app with all routes, auth, validation |

### Modified Files

| File | Change |
|---|---|
| `src/agent-pool.ts` | `AgentHandle` adds `agentCapabilities` field from initialize response |
| `src/session-controller.ts` | `close()` adds ACP `session/close` with capability check + timeout |
| `src/index.ts` | Export `createServer`, `ServerOptions` |
| `examples/server.ts` | Slim down to ~15 lines using `createServer` |
| `package.json` | Add `hono`, `@hono/node-server` |

### Unchanged Files

- `src/runtime.ts` — API is feature-complete, `shutdown()` already delegates to `close()`
- `src/events.ts` — no new event types
- `src/stores/*` — not involved
- `src/permission.ts` — not involved

### Public API Additions

```typescript
// src/index.ts
export { createServer } from './server.js';
export type { ServerOptions } from './server.js';

// src/server.ts
interface ServerOptions {
  apiKey?: string;       // omit to disable auth
  basePath?: string;     // route prefix, default '/'
}

function createServer(runtime: CloudRuntime, opts?: ServerOptions): Hono;
```

---

## Testing Strategy

### Unit Tests (new)

- Request validation: valid body passes, missing/wrong fields → 400
- Auth middleware: valid token passes, invalid → 401, no apiKey → pass-through
- `session/close` with capable agent: sends close, then kills
- `session/close` with incapable agent: skips close, kills directly
- `session/close` timeout: kills after timeout, doesn't hang

### Integration Tests (against mock agent)

- Full lifecycle: create session → prompt → SSE events → close
- Permission delegation round-trip via HTTP
- Cancel via HTTP
- Graceful shutdown: all sessions closed, process exits cleanly

### Existing Tests

80 tests remain unchanged. All Phase 2 session/permission/store/event logic is unaffected.

---

## Out of Scope

- Agent end-to-end validation (2-3 agents) — separate effort after server ships
- Operational documentation — separate, after API is stable
- Rate limiting, request size limits — post-MVP
- Container sandboxing, multi-tenancy — post-MVP
- Postgres-backed persistence — post-MVP
