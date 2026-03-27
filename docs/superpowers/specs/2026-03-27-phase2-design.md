# Phase 2: Persistence, Permission Delegation & Cancel — Design Spec

## 1. Goal

Make the ACP Cloud Runtime production-ready for Phase 3 (HTTP/SSE server) by adding durable session persistence, interactive permission delegation, and graceful run cancellation.

## 2. Scope

Three features plus one cleanup:

1. **FileSessionStore** — JSON-per-session durable persistence
2. **Permission delegation** — interactive `delegate` mode via EventHub; fix `approve-reads` to actually work
3. **cancelRun** — graceful ACP `session/cancel`, session stays alive
4. **Cleanup** — remove `mcpServers` from `CreateSessionOptions` and session creation path

### Out of Scope (deferred)

- Crash recovery (respawn + `session/load`) — comes with FileSessionStore value
- Session TTL / sleeping states — lifecycle optimization
- Prompt queue / backpressure — concurrency optimization
- Multi-agent validation — Phase 3+

## 3. Design Principle: MCP Boundary

**MCP servers are the agent's responsibility, not the runtime's.**

The runtime is a session lifecycle manager. Agents are self-contained — they configure, load, and recover their own MCP connections and tool context.

Implications:
- `CreateSessionOptions` does not expose `mcpServers`
- `newSession()` / future `loadSession()` do not pass MCP config
- `SessionRecord` does not store MCP config
- Agents that require client-provided `mcpServers` are not compatible with this runtime model

## 4. FileSessionStore

**Location:** `src/stores/file.ts`

### Interface

Implements the existing `SessionStore` interface — drop-in replacement for `MemorySessionStore`.

```typescript
class FileSessionStore implements SessionStore {
  constructor(dir: string)
  create(record: SessionRecord): Promise<void>
  get(id: string): Promise<SessionRecord | null>
  update(record: SessionRecord): Promise<void>
  delete(id: string): Promise<void>
  list(filter?: SessionFilter): Promise<SessionRecord[]>
}
```

### Storage Format

- One JSON file per session: `<dir>/<session-id>.json`
- JSON serialization with ISO date strings
- Date revival on read: ISO strings → `Date` objects
- Atomic writes: write to `<id>.tmp` then `rename()` (prevents corruption on crash)
- `delete()` removes the file via `unlink()`
- `list()` reads directory via `readdir()`, loads each file, applies filter in memory

### Constraints

- No external dependencies — `fs/promises` + `path` only
- Single-runtime assumption — no cross-process file locking
- Directory must exist — constructor does not auto-create (caller's responsibility)

### SessionRecord Shape (unchanged)

```
id, acpSessionId, agentId, cwd, permissionMode,
status, pid, createdAt, lastActivity, metadata
```

Lightweight metadata only. No conversation content — agents own their history.

## 5. Permission Delegation

### Permission Modes

| Mode | Behavior |
|---|---|
| `approve-all` | Auto-select first `allow_*` option for all requests |
| `approve-reads` | Auto-approve read operations; delegate write operations to client |
| `delegate` | Delegate ALL permission requests to client via EventHub |
| `deny-all` | Auto-select first `reject_*` option for all requests |

**`approve-reads` read/write determination:** Uses `toolCall.kind` from the ACP permission request (`ToolKind`). Read-only kinds (e.g. `read_file`) are auto-approved by selecting the first `allow_once` option. Write kinds, unknown kinds, and `null` kinds are delegated to the client — same flow as `delegate` mode. The exact read-kind list will be determined from the ACP SDK's `ToolKind` enum during implementation.

### New Types

```typescript
type PermissionMode = 'approve-all' | 'approve-reads' | 'deny-all' | 'delegate'

interface PermissionRequestEvent {
  type: 'permission_request'
  sessionId: string
  runId: string
  requestId: string
  toolCall: {
    toolCallId: string
    title?: string | null
    kind?: string | null
    status?: string | null
  }
  options: Array<{
    optionId: string
    name: string
    kind: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always'
  }>
}

interface PermissionTimeoutEvent {
  type: 'permission_timeout'
  sessionId: string
  requestId: string
}
```

### Pending Permission State

Stored on `SessionExecution` (ephemeral, per-session):

```typescript
interface PendingPermission {
  runId: string
  resolve: (resp: RequestPermissionResponse) => void
  timer: ReturnType<typeof setTimeout>
}

interface SessionExecution {
  handle: AgentHandle
  activeRunId: string | null
  pendingPermissions: Map<string, PendingPermission>  // requestId -> pending
}
```

### Delegation Flow

1. Agent fires `onPermissionRequest` → SessionController handler
2. `PermissionController.shouldDelegate(request)` returns `true` for `delegate` mode, or for `approve-reads` when the operation is a write
3. SessionController generates `requestId` (UUID), creates a Promise, stores resolver + timeout timer in `pendingPermissions`
4. Emits `PermissionRequestEvent` via EventHub
5. Awaits Promise — blocks the ACP permission handler
6. Client sees event via `subscribeSession()`, calls `runtime.respondToPermission(sessionId, requestId, optionId)`
7. CloudRuntime → SessionController → resolves stored Promise with `{ outcome: { outcome: 'selected', optionId } }`
8. ACP handler returns the `RequestPermissionResponse` to the agent

### Timeout

Default: 30 seconds. Configurable via `RuntimeConfig.permissionTimeoutMs`.

On timeout:
- Auto-deny: resolve with first `reject_once` option from the original request
- Emit `PermissionTimeoutEvent` via EventHub
- Remove from `pendingPermissions`

### Cleanup Semantics

| Trigger | Pending permissions outcome |
|---|---|
| Client responds | `{ outcome: { outcome: 'selected', optionId } }` |
| Timeout (30s) | Auto-deny (first `reject_once` option) |
| `cancelRun()` | `{ outcome: { outcome: 'cancelled' } }` |
| `close()` | `{ outcome: { outcome: 'cancelled' } }` |
| Agent crash | `{ outcome: { outcome: 'cancelled' } }` |

All pending permissions are resolved and timers cleared before the triggering operation proceeds.

## 6. cancelRun

### API

```typescript
// CloudRuntime
cancelRun(sessionId: string, runId?: string): Promise<void>
```

`runId` is optional. If omitted, cancels the active run. If provided, validates it matches the active run (rejects stale requests with an error).

### Flow

1. Client calls `runtime.cancelRun(sessionId)`
2. CloudRuntime routes to SessionController
3. SessionController.cancel():
   a. Resolve all `pendingPermissions` with `{ outcome: { outcome: 'cancelled' } }`, clear timers
   b. Call `connection.cancel({ sessionId: acpSessionId })` — ACP native cancel notification
   c. Agent stops LLM/tool work, sends final `session/update` events, returns `StopReason::Cancelled`
   d. `prompt()` resolves naturally → `completeRun(runId, 'cancelled')` → status returns to `ready`

### Properties

- **No process kill.** Session stays alive. Agent accepts new prompts immediately.
- **Cancel when not busy** → no-op (silent, no error)
- **Cancel during permission wait** → permissions cancelled first, then ACP cancel sent
- **Agent ignores cancel** → prompt completes with whatever `StopReason` the agent returns; we don't force termination

## 7. Cleanup: Remove mcpServers from Session Path

### Changes

- `CreateSessionOptions`: remove `mcpServers` field
- `SessionControllerOptions`: remove `mcpServers` field
- `SessionController.create()`: stop passing `mcpServers` to `connection.newSession()`
- `AgentPool.spawn()`: remove `mcpServers` from spawn path (already doesn't use it, but clean up any references)

### newSession Call After Cleanup

```typescript
const result = await handle.connection.newSession({ cwd: opts.cwd });
```

## 8. Public API Changes

### New CloudRuntime Methods

```typescript
cancelRun(sessionId: string, runId?: string): Promise<void>
respondToPermission(sessionId: string, requestId: string, optionId: string): Promise<void>
```

### New RuntimeConfig Fields

```typescript
interface RuntimeConfig {
  // ... existing ...
  permissionTimeoutMs?: number  // default: 30000
}
```

### New Exports

```typescript
export { FileSessionStore } from './stores/file.js'
// PermissionRequestEvent and PermissionTimeoutEvent added to SessionEvent union
```

### Removed Fields

```typescript
// CreateSessionOptions — mcpServers removed
interface CreateSessionOptions {
  agent: string
  cwd: string
  permissionMode?: PermissionMode
}
```

## 9. Files Touched

| File | Change |
|---|---|
| `src/types.ts` | Remove mcpServers from CreateSessionOptions; add `delegate` to PermissionMode; add `permissionTimeoutMs` to RuntimeConfig; add `pendingPermissions` to SessionExecution |
| `src/events.ts` | Add PermissionRequestEvent, PermissionTimeoutEvent to SessionEvent union |
| `src/permission.ts` | Implement `approve-reads` (auto-approve reads, delegate writes); add `delegate` routing; add `shouldDelegate()` method |
| `src/session-controller.ts` | Permission delegation flow with pending map; `cancel()` public method; pending permission lifecycle on complete/close/crash |
| `src/runtime.ts` | Add `cancelRun()`, `respondToPermission()`; remove mcpServers from create flow |
| `src/stores/file.ts` | NEW — FileSessionStore implementation |
| `src/agent-pool.ts` | Clean up any mcpServers references in spawn path |
| `src/index.ts` | Export FileSessionStore; new event types already covered by SessionEvent |

## 10. Testing Strategy

- **FileSessionStore:** CRUD operations, atomic write (verify no partial files), Date serialization round-trip, filter behavior, missing file handling
- **Permission delegation:** Full delegate flow (request → event → respond → ACP response), timeout auto-deny, approve-reads routing (read auto-approve vs write delegate), cleanup on cancel/close/crash (verify `cancelled` outcome)
- **cancelRun:** Graceful cancel (ACP `session/cancel` called, prompt resolves with `cancelled`), cancel when idle (no-op), cancel during permission wait, stale runId rejection
- **mcpServers removal:** Verify newSession called without mcpServers
