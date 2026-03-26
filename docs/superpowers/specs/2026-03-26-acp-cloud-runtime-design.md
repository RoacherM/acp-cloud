# ACP Cloud Runtime — Design Spec

## 1. Overview

### Problem

The ACP (Agent Client Protocol) ecosystem has exploded: 28+ agents in the official registry, covering Claude, Codex, Gemini, Copilot, Cursor, Goose, Cline, Junie, Kiro, DeepAgents, and more. However, ACP is fundamentally a **local stdio protocol** — agents communicate via stdin/stdout JSON-RPC with a host editor process.

There is no standard way to:
- Run ACP agents as **cloud-accessible services**
- Expose their fine-grained streaming output over **HTTP/SSE**
- Manage agent **sessions at scale** with persistence and crash recovery
- Route **human-in-the-loop permission requests** to web clients
- Support **multi-tenant** deployment

### Solution

**ACP Cloud Runtime** — a TypeScript SDK + optional HTTP server that turns any ACP agent into a cloud service. It is the "LangGraph Platform for ACP" — agent-agnostic, protocol-native, and community-aligned.

### Positioning

| Ecosystem Role | Project |
|---|---|
| Protocol spec | ACP (agentclientprotocol.com) |
| Protocol SDK | @agentclientprotocol/sdk (TypeScript, Python) |
| Agent adapters | claude-agent-acp, codex-acp, + 26 native agents |
| IDE integration | Zed |
| **Cloud runtime** | **This project (missing piece)** |

### Design Principles

1. **ACP-native** — use the protocol as-is, don't invent new abstractions
2. **Don't reinvent the wheel** — depend on `@agentclientprotocol/sdk`, read from the ACP registry, spawn existing agents unmodified
3. **Library-first** — importable SDK (Layer 2), HTTP server is optional (Layer 3)
4. **Agent-agnostic** — any ACP-speaking agent plugs in with zero adapter code
5. **Fine-grained streaming** — every ACP `session/update` event surfaces to the client
6. **Community-aligned** — track ACP spec evolution, design for Proxy Chains compatibility

---

## 2. Architecture

### Layer Diagram

```
Layer 3: HTTP/SSE Server (optional, built on Layer 2)
  ├── REST API (/agents, /sessions, /runs)
  ├── SSE Streamer (event fan-out to web clients)
  ├── Permission Bridge (approve-all / approve-reads / deny-all routing)
  └── Auth & Multi-tenancy

Layer 2: Cloud Session Manager (core SDK, the primary deliverable)
  ├── Session Lifecycle (create, persist, resume, cancel, crash recovery)
  ├── Agent Pool (spawn / reuse / terminate ACP agent processes)
  ├── Event Bus (ACP session/update → typed event emitter)
  └── Permission Controller (mode-based auto-approve / delegate)

Layer 1: ACP Client Foundation (direct dependency, no modification)
  ├── ClientSideConnection (one per session)
  ├── ndJsonStream (stdio ↔ JSON-RPC framing)
  └── Protocol types (SessionUpdate, PermissionOption, ContentBlock, etc.)
```

**Layer 1** — `@agentclientprotocol/sdk`. Used as-is.

**Layer 2** — The core SDK. Manages agent process lifecycle, sessions, events, permissions. Importable as a library. Borrows patterns from `acpx` (crash recovery, TTL, queue) but redesigned as a composable library rather than a CLI tool.

**Layer 3** — Optional HTTP/SSE server built on Layer 2. Provides the LangGraph-style REST API. Users who want a different HTTP framework or transport can use Layer 2 directly.

### Resource Model

| ACP Cloud Runtime | LangGraph Platform | ACP Protocol | Description |
|---|---|---|---|
| **Agent** | Assistant | (registry entry) | An agent type from the ACP registry or local config |
| **Session** | Thread | session | A persistent conversation session bound to one agent process |
| **Run** | Run | prompt turn | One prompt → response lifecycle within a session |
| **Event** | Stream event | session/update | A fine-grained streaming event |
| **PermissionRequest** | (interrupt) | request_permission | A pending human-in-the-loop decision |

### Process Model

```
CloudRuntime (Node.js process)
  │
  ├── Session A ──── ClientSideConnection ──── stdio ──── Agent Process (e.g. claude-agent-acp)
  ├── Session B ──── ClientSideConnection ──── stdio ──── Agent Process (e.g. codex-acp)
  ├── Session C ──── ClientSideConnection ──── stdio ──── Agent Process (e.g. gemini --acp)
  └── Session D ──── ClientSideConnection ──── stdio ──── Agent Process (e.g. goose acp)
```

Each session owns exactly one agent subprocess. The `ClientSideConnection` from `@agentclientprotocol/sdk` handles all JSON-RPC framing over stdio.

---

## 3. Layer 2: Cloud Session Manager (Core SDK)

### 3.1 CloudRuntime

The top-level entry point. Manages the agent registry and session lifecycle.

```typescript
import { CloudRuntime } from 'acp-cloud-runtime';

const runtime = new CloudRuntime({
  // Agent definitions: how to spawn each agent type
  agents: {
    'claude':  { command: 'npx', args: ['-y', '@zed-industries/claude-agent-acp'] },
    'codex':   { command: 'npx', args: ['-y', '@zed-industries/codex-acp'] },
    'gemini':  { command: 'npx', args: ['-y', '@google/gemini-cli', '--acp'] },
    'goose':   { command: 'goose', args: ['acp'] },
    'cline':   { command: 'npx', args: ['-y', 'cline'] },
    'copilot': { command: 'npx', args: ['-y', '@github/copilot', '--acp'] },
  },
  // Or auto-discover from ACP registry
  registry: 'https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json',

  // Session persistence (pluggable)
  sessionStore: new PostgresSessionStore(DATABASE_URL),
  // Or: new FileSessionStore('/data/sessions'),
  // Or: new MemorySessionStore(), // for dev

  // Defaults
  defaultPermissionMode: 'approve-reads',
  sessionTTL: 300_000, // 5 min idle TTL before process cleanup
});
```

**Agent Definition Schema:**

```typescript
// Manual agent definition (when you know exactly how to spawn)
interface AgentDefinition {
  command: string;           // executable (npx, binary path, etc.)
  args: string[];            // arguments
  env?: Record<string, string>; // additional env vars
  capabilities?: {           // override capability negotiation
    image?: boolean;
    audio?: boolean;
  };
}
```

**Registry Integration — DistributionResolver + Installer:**

The ACP registry has three distribution types (npx, binary, uvx) with OS-specific binary archives and optional env requirements. A raw registry entry cannot always be directly spawned — it needs resolution and possibly installation first.

```typescript
// Registry entry distribution types (from actual registry schema)
type RegistryDistribution =
  | { type: 'npx'; package: string; args?: string[] }
  | { type: 'binary'; archives: Record<Platform, { url: string; sha256?: string }> }
  | { type: 'uvx'; package: string; args?: string[] };

type Platform = 'darwin-arm64' | 'darwin-x64' | 'linux-arm64' | 'linux-x64' | 'win32-x64';

// DistributionResolver: registry entry → AgentDefinition
interface DistributionResolver {
  // Resolve a registry entry to a spawnable AgentDefinition
  resolve(registryEntry: RegistryEntry): Promise<AgentDefinition>;

  // Check if an agent is already installed/available
  isAvailable(registryEntry: RegistryEntry): Promise<boolean>;
}

// Installer: handles binary download, verification, caching
interface AgentInstaller {
  // Download and verify binary archives for the current platform
  install(registryEntry: RegistryEntry): Promise<string>; // returns binary path

  // Get cached binary path if already installed
  getCached(agentId: string, version: string): string | null;

  // Clean up old versions
  gc(keepVersions?: number): Promise<void>;
}
```

**Resolution rules by distribution type:**

| Distribution | Resolution | Integrity |
|---|---|---|
| `npx` | `command: 'npx'`, `args: ['-y', package, ...entry.args]` | npm registry built-in integrity (HTTPS + package-lock) |
| `uvx` | `command: 'uvx'`, `args: [package, ...entry.args]` (template configurable, no hardcoded subcommand) | PyPI built-in integrity |
| `binary` | Download for current OS/arch → `command: cachedBinaryPath`, `args: entry.args` | HTTPS required; SHA256 if registry provides it; otherwise trust transport |

**Binary verification strategy:** Current ACP registry does not include `sha256` fields. The resolver follows a fallback chain:
1. Registry provides checksum → verify SHA256
2. Registry has no checksum (current state) → trust HTTPS transport security
3. Operator provides sidecar checksums file → verify against it
This is a pragmatic choice — npx/uvx already handle their own integrity; binary is the only case that needs explicit policy.

**Fallback chain:** Manual `AgentDefinition` in config → Registry auto-resolve → Error (agent not found).

Note: The manual config examples above are for illustration. In production, use the DistributionResolver to auto-resolve from registry entries — it always has the correct, up-to-date command and args for each agent.

### 3.2 Session Lifecycle

```typescript
// Create a new session
const session = await runtime.createSession({
  agent: 'claude',
  cwd: '/workspace/my-project',
  // Runtime permission policy (our concept, NOT ACP agent mode)
  permissionMode: 'approve-reads',   // 'approve-all' | 'approve-reads' | 'deny-all'
  // Non-interactive fallback when no client is connected to respond
  nonInteractivePolicy: 'deny',      // 'deny' | 'fail' (aligned with acpx)
  // ACP agent mode (agent-specific, set via session/set_mode after init)
  agentModeId: 'code',               // optional, depends on agent capabilities
  mcpServers: [                       // optional MCP servers to pass through
    { name: 'filesystem', transport: { type: 'stdio', command: 'mcp-fs', args: ['/workspace'] } }
  ],
});

// session.id              → string (runtime record ID)
// session.acpSessionId    → string (ACP protocol session ID)
// session.agentSessionId  → string | null (agent-native session ID, if different)
// session.agent           → 'claude'
// session.status          → 'ready'
// session.agentModes      → available ACP agent modes
// session.config          → available config options from agent

// Resume a previous session
const session = await runtime.loadSession(sessionId);

// List sessions
const sessions = await runtime.listSessions({ agent: 'claude', status: 'active' });

// Close a session (graceful agent process termination)
await session.close();
```

**Session State Machine:**

```
                    spawn agent
  [creating] ─────────────────────► [initializing]
                                          │
                                   initialize + session/new
                                          │
                                          ▼
                 prompt              [ready] ◄──────────── [recovering]
                   │                  ▲  ▲                      ▲
                   ▼                  │  │ spawn+session/load    │
              [running] ──────────────┘  │                      │
                   │       run complete  [waking]                │
                   │                      ▲                     │
                   │                      │ new prompt           │
                   │                 [sleeping]                  │
                   │                      ▲                     │
                   │                      │ TTL expired          │
                   │                 [ready]─┘                  │
                   │                                            │
                   │ process death (unexpected)                 │
                   ▼                                            │
              [crashed] ───── respawn + recovery ──────────────┘
                   │
                   │ recovery failed / unrecoverable
                   ▼
              [terminated]
```

**Sleeping/waking lifecycle:**
- `ready` idle for `sessionTTL` (default 300s, aligned with acpx) → `sleeping`: process killed, record preserved
- New prompt arrives at `sleeping` session → `waking`: respawn + `session/load` → `ready` → execute
- `waking` shares recovery path with `recovering` (difference is trigger: expected vs unexpected)
- `sleeping` for longer than `sleepTTL` (configurable, default 24h) → `terminated`

**Session Record (persisted to SessionStore):**

Three-layer ID model (aligned with acpx's `acpxRecordId`/`acpSessionId`/`agentSessionId` separation):

```typescript
interface SessionRecord {
  // Three-layer ID model
  id: string;                    // Runtime record ID (our UUID, stable across recovery)
  acpSessionId: string;          // ACP protocol session ID (from session/new response)
  agentSessionId: string | null; // Agent-native session ID (e.g. Claude SDK session, Codex thread)
                                 // May differ from acpSessionId; used by session/load

  agentId: string;
  cwd: string;
  permissionMode: PermissionMode;           // Runtime concept: approve-all | approve-reads | deny-all
  nonInteractivePolicy: 'deny' | 'fail';   // What to do when no client can respond
  agentModeId: string | null;               // ACP agent mode (from session/set_mode)
  recoveryPolicy: RecoveryPolicy;           // How to handle session/load failure

  status: 'creating' | 'initializing' | 'ready' | 'running' | 'sleeping' | 'waking' | 'crashed' | 'recovering' | 'terminated';
  pid: number | null;
  createdAt: Date;
  lastActivity: Date;
  metadata: Record<string, unknown>;  // agent-specific info (agent capabilities, etc.)
}
```

### 3.3 Prompt Concurrency Model

**Core constraint: one active Run per Session at any time.**

This is inherent to the ACP protocol — `session/prompt` is a request-response pair, and the agent must respond before the turn ends. acpx, codex-acp, and claude-agent-acp all enforce this.

```typescript
// Prompt queue behavior
const run1 = await session.prompt([{ type: 'text', text: 'Fix login bug' }]);
// run1 starts immediately (queue was empty)

const run2 = session.enqueue([{ type: 'text', text: 'Add feature X' }]);
// run2 is queued (run1 still active), returns immediately with status 'queued'
// run2 starts automatically when run1 completes

// Cancel active run
await session.cancelActiveRun();  // sends ACP session/cancel

// Remove queued (not yet active) run
await session.dequeue(run2.id);
```

**Queue rules:**

| Rule | Value | Rationale |
|---|---|---|
| Max queue depth | Configurable (default 8) | Prevent unbounded memory growth |
| Queue full behavior | Reject with error | Backpressure to client |
| `cancel()` target | Current active run only | ACP session/cancel semantics |
| Client SSE disconnect | Run continues to completion | Results saved to session history |
| Session enters `sleeping` | Queue drained, all runs complete | No orphaned work |

### 3.4 Prompt / Run

```typescript
// Send a prompt → get an async iterable of events
const run = await session.prompt([
  { type: 'text', text: 'Fix the login bug in auth.ts' }
]);

// run.id → string
// run.status → 'running' | 'queued'

// Consume events (async iterable)
for await (const event of run) {
  switch (event.type) {
    case 'agent_message_chunk':
      process.stdout.write(event.data.text);
      break;
    case 'tool_call':
      console.log(`Tool: ${event.data.title} (${event.data.kind})`);
      break;
    case 'tool_call_update':
      if (event.data.status === 'completed') {
        console.log(`Tool done: ${event.data.toolCallId}`);
      }
      break;
    case 'plan':
      console.log('Plan:', event.data.entries);
      break;
    case 'permission_request':
      // See section 3.4
      break;
    case 'run_complete':
      console.log('Done:', event.data.stopReason);
      break;
  }
}

// Cancel a running prompt
await run.cancel();
```

**Run Event Types (1:1 mapping from ACP `session/update` — aligned with `@agentclientprotocol/sdk` `SessionUpdate` union):**

```typescript
// These types MUST stay in sync with @agentclientprotocol/sdk SessionUpdate.
// Source of truth: typescript-sdk/src/types.gen.ts
type RunEvent =
  // Standard ACP session/update events (exact match to SDK SessionUpdate variants)
  | { type: 'agent_message_chunk'; data: { text: string } }
  | { type: 'agent_thought_chunk'; data: { text: string } }     // SDK: agent_thought_chunk
  | { type: 'user_message_chunk'; data: { content: ContentBlock[] } }
  | { type: 'tool_call'; data: { toolCallId: string; title: string; kind: ToolKind; status: 'pending'; locations?: Location[] } }
  | { type: 'tool_call_update'; data: { toolCallId: string; status: ToolCallStatus; content?: ContentBlock[] } }
  | { type: 'usage_update'; data: UsageInfo }                   // SDK: usage_update
  | { type: 'plan'; data: { entries: PlanEntry[] } }
  | { type: 'config_option_update'; data: { configId: string; value: string } }
  | { type: 'current_mode_update'; data: { modeId: string } }
  | { type: 'available_commands_update'; data: { commands: SlashCommand[] } }
  | { type: 'session_info_update'; data: Record<string, unknown> }
  // Permission request (human-in-the-loop, from session/request_permission)
  | { type: 'permission_request'; data: PermissionRequestEvent }
  // Run lifecycle (from session/prompt response)
  | { type: 'run_complete'; data: { stopReason: StopReason } }
  // Cloud-specific extensions (prefixed with _ per ACP extension convention)
  | { type: '_cloud.session_status'; data: { status: SessionStatus } };

// Aligned with SDK ToolKind enum (including switch_mode)
type ToolKind = 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute' | 'think' | 'fetch' | 'switch_mode' | 'other';

// Aligned with SDK ToolCallStatus enum (no 'cancelled' — cancellation surfaces as run-level StopReason)
type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed';

type StopReason = 'end_turn' | 'max_tokens' | 'max_turn_requests' | 'refusal' | 'cancelled';

// NOTE: tool_result is NOT a session/update variant in the SDK.
// Tool results are delivered as tool_call_update with status: 'completed' and content[].
```

### 3.4 Permission Controller

The permission controller intercepts ACP `session/request_permission` calls and routes them based on the session's `permissionMode`.

**Important distinction:** `permissionMode` is a **runtime concept** (our policy for auto-approving/delegating tool requests). It is completely separate from ACP's `session/set_mode` which controls agent-internal behavior (e.g. "ask"/"architect"/"code" in Claude). These are stored as separate fields (`permissionMode` vs `agentModeId`) and surfaced through separate API endpoints.

```typescript
// Three built-in modes (identical naming to acpx's PermissionMode)
type PermissionMode = 'approve-all' | 'approve-reads' | 'deny-all';
```

**Mode behavior:**

| Mode | read/search/think tools | write/edit/execute/switch_mode tools | Unknown tools |
|---|---|---|---|
| `approve-all` | Auto-approve (allow_always) | Auto-approve (allow_always) | Auto-approve |
| `approve-reads` | Auto-approve (allow_once) | Delegate to client | Delegate to client |
| `deny-all` | Auto-reject | Auto-reject | Auto-reject |

**Non-interactive fallback** (when delegation is needed but no client is connected):

| `nonInteractivePolicy` | Behavior |
|---|---|
| `deny` (default) | Auto-select reject option, agent continues |
| `fail` | Return error, prompt turn fails |

This matches acpx's `nonInteractivePolicy` behavior.

**Delegation flow (approve-reads when tool needs approval and client is connected):**

1. Agent sends `session/request_permission` to `ClientSideConnection`
2. Permission Controller checks `permissionMode` and tool kind
3. If auto-resolvable → respond immediately
4. If delegation needed → check if client is connected
   - Connected: emit `permission_request` event on the Run, wait for response
   - Not connected: apply `nonInteractivePolicy` (deny or fail)
5. Client calls `run.respondToPermission(requestId, optionId)`
6. Permission Controller resolves the pending promise in the `ClientSideConnection`
7. Agent receives the response and proceeds

```typescript
// Programmatic permission handling
run.on('permission_request', async (req) => {
  console.log(`Permission needed: ${req.toolCall.title}`);
  console.log('Options:', req.options.map(o => `${o.optionId}: ${o.name} (${o.kind})`));

  // Auto-approve example
  const allow = req.options.find(o => o.kind === 'allow_once');
  await run.respondToPermission(req.requestId, allow.optionId);

  // Or delegate to UI and wait
  // The HTTP layer (Layer 3) does this automatically via SSE + POST
});
```

**Important:** `optionId` is an **opaque token** provided by the agent. Clients must pass it back verbatim — do not infer semantics from the ID string. Semantic information is in `option.name` (display label) and `option.kind` (allow_once, allow_always, reject_once, reject_always). Each agent may use different ID formats.

### 3.5 Agent Pool

Manages agent subprocess lifecycle.

```typescript
interface AgentPool {
  // Spawn a new agent process, return ACP ClientSideConnection
  spawn(agentId: string, env?: Record<string, string>): Promise<AgentHandle>;

  // Kill an agent process
  kill(handle: AgentHandle): Promise<void>;

  // Check if a process is alive
  isAlive(handle: AgentHandle): boolean;

  // Get stats
  stats(): { active: number; total_spawned: number; total_crashed: number };
}

interface AgentHandle {
  pid: number;
  connection: ClientSideConnection;
  agentInfo: AgentInfo;
  agentCapabilities: AgentCapabilities;
}
```

**Spawn flow:**

1. Look up `AgentDefinition` by agent ID
2. `child_process.spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env })`
3. Create `ndJsonStream(child.stdout, child.stdin)` from `@agentclientprotocol/sdk`
4. Create `ClientSideConnection(clientFactory, stream)`
5. Send `initialize` request, negotiate capabilities
6. Return `AgentHandle`

**Process monitoring:**

- Listen to `child.on('exit')` for unexpected termination
- Periodic liveness check (`kill(pid, 0)`) as fallback
- On death: emit `session_status: 'crashed'` event, attempt crash recovery

### 3.6 Crash Recovery

Borrowed from acpx's proven approach, adapted for library use with configurable recovery policy.

```typescript
// Recovery policy (per-session, configurable at creation)
type RecoveryPolicy =
  | 'strict-load'    // session/load only; if it fails, mark terminated
  | 'fallback-new';  // try session/load; on failure, create session/new (lose history but keep running)

// Default: 'fallback-new' (aligned with acpx behavior for non-fatal errors)
```

**Recovery flow:**

```typescript
async function recoverSession(session: SessionRecord): Promise<void> {
  session.status = 'recovering';
  await sessionStore.update(session);

  // 1. Spawn new agent process
  const handle = await agentPool.spawn(session.agentId);

  // 2. Attempt session/load (using acpSessionId, not runtime record id)
  try {
    // SDK LoadSessionRequest requires sessionId, cwd, and mcpServers
    const result = await handle.connection.loadSession({
      sessionId: session.acpSessionId,
      cwd: session.cwd,
      mcpServers: session.metadata.mcpServers ?? [],
    });
    // Agent replays history via session/update notifications
    session.status = 'ready';
    session.pid = handle.pid;
    await sessionStore.update(session);
    return;
  } catch (err) {
    // 3. Check recovery policy
    if (session.recoveryPolicy === 'strict-load') {
      // Strict: session/load failed → terminated
      session.status = 'terminated';
      await sessionStore.update(session);
      await agentPool.kill(handle);
      return;
    }

    // 4. Fallback: try session/new (lose conversation history, keep session alive)
    // Only fallback on recoverable errors (resource_not_found, etc.)
    // Immediately terminate on unrecoverable errors (auth failure, agent crash)
    if (isUnrecoverableError(err)) {
      session.status = 'terminated';
      await sessionStore.update(session);
      await agentPool.kill(handle);
      return;
    }

    try {
      const newResult = await handle.connection.newSession({
        cwd: session.cwd,
        mcpServers: session.metadata.mcpServers ?? [],
      });
      // Update ACP session ID (it changed)
      session.acpSessionId = newResult.sessionId;
      session.agentSessionId = null; // agent-native session is new
      session.status = 'ready';
      session.pid = handle.pid;
      await sessionStore.update(session);
    } catch (fallbackErr) {
      session.status = 'terminated';
      await sessionStore.update(session);
      await agentPool.kill(handle);
    }
  }
}

function isUnrecoverableError(err: unknown): boolean {
  const code = (err as any)?.code;
  // Auth required is always unrecoverable
  if (code === -32000) return true;
  // -32002 (not found) is recoverable — session simply doesn't exist, fallback to new
  // -32603 (internal error) is NOT blanket-unrecoverable: acpx treats some -32603 cases
  // (empty history, adapter quirks) as recoverable. Only treat as unrecoverable if the
  // error message indicates a truly fatal condition (e.g. "agent binary not found").
  // Default: recoverable — prefer session continuity over strictness.
  return false;
}
```

### 3.7 Session Store (Pluggable)

```typescript
interface SessionStore {
  create(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  update(record: SessionRecord): Promise<void>;
  delete(id: string): Promise<void>;
  list(filter?: SessionFilter): Promise<SessionRecord[]>;
  // Cleanup stale sessions
  reapStale(maxIdleMs: number): Promise<SessionRecord[]>;
}

// Built-in implementations
class MemorySessionStore implements SessionStore { /* for dev/testing */ }
class FileSessionStore implements SessionStore { /* JSON files, like acpx */ }
class PostgresSessionStore implements SessionStore { /* for production */ }
```

### 3.8 Client Interface (what Layer 2 user implements)

For users of the SDK who need to handle filesystem and terminal operations from agents:

```typescript
interface CloudClientHandler {
  // Called when agent wants to read a file
  readTextFile?(sessionId: string, path: string, line?: number, limit?: number): Promise<string>;

  // Called when agent wants to write a file
  writeTextFile?(sessionId: string, path: string, content: string): Promise<void>;

  // Called when agent wants to create a terminal
  createTerminal?(sessionId: string, command: string, args: string[], cwd: string): Promise<TerminalHandle>;
}
```

Default implementation: direct filesystem access with cwd sandboxing (agent can only access files within its session's `cwd`). Production deployments should provide container-based or gVisor-based implementations.

---

## 4. Layer 3: HTTP/SSE Server

### 4.1 API Endpoints

```
# Agent Discovery
GET    /api/agents                              → AgentInfo[]
GET    /api/agents/:agentId                     → AgentInfo + capabilities

# Session Management
POST   /api/sessions                            → SessionInfo
       Body: { agent: string, cwd: string,
               permissionMode?: PermissionMode,        // runtime policy
               nonInteractivePolicy?: 'deny' | 'fail',
               agentModeId?: string,                    // ACP agent mode
               recoveryPolicy?: RecoveryPolicy,
               mcpServers?: MCP[] }
GET    /api/sessions                            → SessionInfo[] (with filters)
GET    /api/sessions/:sessionId                 → SessionInfo
DELETE /api/sessions/:sessionId                 → void (graceful close)

# Runtime permission policy (our concept)
PATCH  /api/sessions/:sessionId/permission-mode → void
       Body: { permissionMode: PermissionMode }

# ACP agent mode (delegated to session/set_mode)
PATCH  /api/sessions/:sessionId/agent-mode      → void
       Body: { modeId: string }

# ACP config options (delegated to session/set_config_option)
PATCH  /api/sessions/:sessionId/config          → void
       Body: { configId: string, value: string }

# Prompt / Run
POST   /api/sessions/:sessionId/prompt          → RunInfo
       Body: { content: ContentBlock[] }
POST   /api/sessions/:sessionId/cancel          → void
GET    /api/sessions/:sessionId/messages         → Message[]

# SSE Event Stream
GET    /api/sessions/:sessionId/events           → SSE stream

# Permission Response
POST   /api/sessions/:sessionId/permissions/:requestId → void
       Body: { optionId: string }
```

### 4.2 SSE Event Stream Format

```
GET /api/sessions/abc123/events

event: agent_message_chunk
data: {"text":"Let me look at the auth.ts file..."}

event: tool_call
data: {"toolCallId":"tc_1","title":"Read auth.ts","kind":"read","status":"pending"}

event: tool_call_update
data: {"toolCallId":"tc_1","status":"completed","content":[{"type":"text","text":"...file content..."}]}

event: agent_message_chunk
data: {"text":"I found the issue. The token validation..."}

event: tool_call
data: {"toolCallId":"tc_2","title":"Edit auth.ts","kind":"edit","status":"pending"}

event: permission_request
data: {"requestId":"pr_1","toolCall":{"title":"Edit auth.ts","kind":"edit"},"options":[{"optionId":"allow","name":"Allow","kind":"allow_once"},{"optionId":"reject","name":"Reject","kind":"reject_once"}]}

event: tool_call_update
data: {"toolCallId":"tc_2","status":"completed","content":[{"type":"diff","path":"auth.ts","oldText":"...","newText":"..."}]}

event: run_complete
data: {"stopReason":"end_turn"}
```

### 4.3 Server Setup

```typescript
import { CloudRuntime } from 'acp-cloud-runtime';
import { createServer } from 'acp-cloud-runtime/server';

const runtime = new CloudRuntime({ /* config */ });
const server = createServer(runtime, {
  port: 3000,
  auth: myAuthMiddleware,       // optional
  cors: { origin: '*' },       // optional
});

await server.start();
// API available at http://localhost:3000/api/
```

The server is a thin HTTP layer over the `CloudRuntime` SDK. It:
- Maps REST endpoints to `CloudRuntime` method calls
- Creates SSE connections that subscribe to session event streams
- Holds pending permission requests in a Map, resolves them on POST

---

## 5. Filesystem & Terminal Delegation

ACP agents can request filesystem and terminal access via the protocol. The Cloud Runtime must handle these.

### 5.1 Filesystem Strategy

| Deployment | Strategy |
|---|---|
| Development | Direct filesystem access, sandboxed to session `cwd` |
| Production (basic) | Container volume mounts per session |
| Production (secure) | gVisor / Firecracker microVM per session |
| Serverless | Ephemeral container with workspace hydration from object storage |

The `CloudClientHandler` interface (section 3.8) abstracts this. Default implementation does direct fs access with path validation.

**Path validation requirements** (aligned with acpx `resolvePathWithinRoot` and codex-acp `ensure_within_root`):

1. Resolve the candidate path to its **real path** (`realpath`) to defeat symlink escaping
2. Resolve the root to its **real path** as well
3. Compute the **relative path** from root to candidate — if it starts with `..`, reject
4. Reject absolute paths that don't fall under the root
5. Never use `startsWith` string comparison (vulnerable to prefix collision: `/workspace/a` vs `/workspace/a2`)

```typescript
import { realpath, readFile } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';

class SandboxedFsHandler {
  private realRoot: string | null = null;

  constructor(private allowedRoot: string) {}

  private async getRealRoot(): Promise<string> {
    if (!this.realRoot) {
      this.realRoot = await realpath(this.allowedRoot);
    }
    return this.realRoot;
  }

  private async resolveWithinRoot(inputPath: string): Promise<string> {
    const root = await this.getRealRoot();

    // Resolve to absolute (relative paths resolved against root)
    const candidate = isAbsolute(inputPath) ? inputPath : resolve(root, inputPath);

    // Follow symlinks to get the true filesystem location
    const realCandidate = await realpath(candidate);

    // Single check: relative path from root must not escape
    // This handles ALL cases: prefix collision, symlink escaping, absolute paths outside root
    const rel = relative(root, realCandidate);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path escapes sandbox: ${inputPath} → ${realCandidate}`);
    }

    return realCandidate;
  }

  async readTextFile(sessionId: string, path: string): Promise<string> {
    const safePath = await this.resolveWithinRoot(path);
    return readFile(safePath, 'utf-8');
  }

  async writeTextFile(sessionId: string, path: string, content: string): Promise<void> {
    const safePath = await this.resolveWithinRoot(path);
    await writeFile(safePath, content, 'utf-8');
  }
}
```

### 5.2 Terminal Strategy

Agent terminal requests (`terminal/create`) spawn shell commands. The runtime wraps them with resource limits:

```typescript
class TerminalManager {
  async create(command: string, args: string[], cwd: string): Promise<TerminalHandle> {
    const proc = spawn(command, args, {
      cwd,
      timeout: 60_000,     // 1 min default
      // In production: run inside container/sandbox
    });
    return new ProcessTerminalHandle(proc);
  }
}
```

---

## 6. Agent Compatibility Matrix

Based on research of all 28+ ACP registry agents:

| Agent | Distribution | ACP Type | Permission Model | Session Load | Notes |
|---|---|---|---|---|---|
| Claude (claude-agent-acp) | NPX | Adapter (library) | Full `requestPermission` | Yes | Most complete ACP implementation |
| Codex (codex-acp) | NPX + binaries | Adapter (Rust binary) | Full `requestPermission` | Yes | Sandbox modes built-in |
| Gemini CLI | NPX | Native | `requestPermission` | Yes | `--acp` flag |
| GitHub Copilot | NPX | Native | `requestPermission` | TBD | Newest addition |
| Cursor | Binaries | Native | `requestPermission` | TBD | `cursor --acp` |
| Goose | Binaries | Native | `requestPermission` | Yes | `goose acp` |
| Cline | NPX | Native | `requestPermission` | Yes | Apache-2.0 |
| Junie (JetBrains) | Binaries | Native | `requestPermission` | TBD | Proprietary |
| Kiro (AWS) | CLI | Native | `requestPermission` | TBD | `kiro-cli acp` |
| DeepAgents (LangChain) | NPX | Native | TBD | TBD | v0.1.4, early |
| Qwen Code | NPX | Native | `requestPermission` | TBD | Apache-2.0 |
| Kimi CLI | Binaries | Native | `requestPermission` | TBD | MIT |
| Pi (pi-acp) | NPX | Adapter | No permission delegation | Via session-map | Pi handles tools internally |
| Mistral Vibe | Binaries | Native | `requestPermission` | TBD | Apache-2.0 |

All agents that implement ACP `session/request_permission` will work seamlessly with the Permission Controller. Pi is the exception (handles tools internally), but still works — it just never triggers permission requests.

---

## 7. Relationship to Existing Projects

| Project | Our Relationship | Rationale |
|---|---|---|
| `@agentclientprotocol/sdk` | **Direct dependency** | Protocol foundation, no fork needed |
| ACP Registry | **Read at runtime** | Auto-discover agents |
| `acpx` | **Learn patterns** | Session manager, crash recovery, TTL — reimplemented as library |
| `claude-agent-acp` | **Spawn as agent** | Unmodified, via NPX |
| `codex-acp` | **Spawn as agent** | Unmodified, via NPX |
| All native ACP agents | **Spawn as agent** | Unmodified, via their native commands |
| ACP Proxy Chains RFD | **Track, don't depend** | Design to be compatible; migrate when stable |
| LangGraph Platform | **Inspiration** | Resource model (Agents/Threads/Runs), streaming patterns, API design |
| IBM ACP Agent Stack | **Awareness** | Different protocol (Agent Communication Protocol), different problem space |

---

## 8. Package Structure

```
acp-cloud-runtime/
├── package.json
├── src/
│   ├── index.ts                  # Public API exports
│   ├── runtime.ts                # CloudRuntime class
│   ├── session.ts                # Session lifecycle + state machine
│   ├── run.ts                    # Run (prompt turn) + event stream
│   ├── agent-pool.ts             # Agent process spawning + monitoring
│   ├── permission.ts             # Permission controller (approve-all/approve-reads/deny-all)
│   ├── registry.ts               # ACP registry client + DistributionResolver
│   ├── installer.ts              # AgentInstaller (binary download, verify, cache)
│   ├── recovery.ts               # Crash recovery logic (strict-load / fallback-new)
│   ├── events.ts                 # Event type definitions (aligned with SDK SessionUpdate)
│   ├── client-handler.ts         # CloudClientHandler interface + SandboxedFsHandler
│   ├── stores/
│   │   ├── interface.ts          # SessionStore interface
│   │   ├── memory.ts             # MemorySessionStore
│   │   ├── file.ts               # FileSessionStore
│   │   └── postgres.ts           # PostgresSessionStore
│   └── server/
│       ├── index.ts              # createServer()
│       ├── routes.ts             # HTTP route handlers
│       ├── sse.ts                # SSE connection manager
│       └── middleware.ts         # Auth, CORS, error handling
│   ├── cli/
│   │   ├── index.ts              # CLI entry point (npx acp-cloud)
│   │   ├── commands/
│   │   │   ├── start.ts          # acp-cloud start
│   │   │   └── prompt.ts         # acp-cloud prompt <agent> "..."
│   │   └── config.ts             # Config file loader (acp-cloud.config.ts)
│   └── client/
│       ├── index.ts              # CloudClient class
│       ├── stream.ts             # SSE event stream consumer
│       └── react.ts              # React hooks (useSession, usePrompt)
├── Dockerfile                    # Production container image
├── docker-compose.yml            # Multi-agent + Postgres example
├── tests/
│   ├── runtime.test.ts
│   ├── session.test.ts
│   ├── permission.test.ts
│   ├── recovery.test.ts
│   ├── server.test.ts
│   └── client.test.ts
└── examples/
    ├── basic-usage.ts            # Minimal Layer 2 example
    ├── http-server.ts            # Layer 3 server example
    └── multi-agent.ts            # Multiple agents in one runtime
```

---

## 9. Distribution Layer

The core product value is: **deploy our server, users access agents via standard HTTP/SSE.** The distribution layer makes this trivially easy.

### 9.1 CLI (`npx acp-cloud`)

```bash
# Start server with default config (reads acp-cloud.config.ts if present)
npx acp-cloud start

# Start with inline options
npx acp-cloud start --agents claude,codex,gemini --port 3000

# Quick single-prompt test (no server needed)
npx acp-cloud prompt claude "Fix the login bug in auth.ts"

# Show available agents from registry
npx acp-cloud agents list
```

**Config file (`acp-cloud.config.ts`):**

```typescript
import { defineConfig } from 'acp-cloud-runtime';

export default defineConfig({
  port: 3000,
  agents: {
    claude: { command: 'npx', args: ['-y', '@zed-industries/claude-agent-acp'] },
    codex: { command: 'npx', args: ['-y', '@zed-industries/codex-acp'] },
  },
  // Or auto-discover from registry:
  registry: true,
  allowlist: ['claude-acp', 'codex-acp', 'gemini', 'goose'],

  sessionStore: { type: 'postgres', url: process.env.DATABASE_URL },
  defaultPermissionMode: 'approve-reads',
  sessionTTL: 300_000,
});
```

### 9.2 Docker

```dockerfile
FROM node:22-slim
RUN npm install -g acp-cloud-runtime
EXPOSE 3000
CMD ["acp-cloud", "start", "--port", "3000"]
```

```yaml
# docker-compose.yml
services:
  acp-cloud:
    image: acp-cloud-runtime
    ports: ["3000:3000"]
    environment:
      - ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
      - OPENAI_API_KEY=${OPENAI_API_KEY}
      - DATABASE_URL=postgres://postgres:postgres@db:5432/acp
    volumes:
      - ./workspace:/workspace
      - ./acp-cloud.config.ts:/app/acp-cloud.config.ts
    depends_on: [db]

  db:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: postgres
      POSTGRES_DB: acp
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

**One command to deploy:**

```bash
docker compose up
# Server ready at http://localhost:3000
# POST /api/sessions { agent: "claude", cwd: "/workspace" }
```

### 9.3 Client SDK

Typed HTTP/SSE client for consuming the API from any JavaScript/TypeScript environment.

```typescript
import { CloudClient } from 'acp-cloud-runtime/client';

const client = new CloudClient('http://localhost:3000');

// List available agents
const agents = await client.listAgents();

// Create session + send prompt
const session = await client.createSession({ agent: 'claude', cwd: '/workspace' });
const run = await session.prompt([{ type: 'text', text: 'Fix the login bug' }]);

for await (const event of run) {
  if (event.type === 'agent_message_chunk') {
    process.stdout.write(event.data.text);
  }
  if (event.type === 'permission_request') {
    // Approve the first allow option
    const allow = event.data.options.find(o => o.kind === 'allow_once');
    await session.respondToPermission(event.data.requestId, allow.optionId);
  }
}
```

**React hooks:**

```typescript
import { useSession, usePrompt } from 'acp-cloud-runtime/client/react';

function AgentChat() {
  const session = useSession({ agent: 'claude', cwd: '/workspace' });
  const { events, send, cancel, permissions } = usePrompt(session);

  return (
    <div>
      {events.map(e => /* render based on event type */)}
      {permissions.map(p => (
        <PermissionDialog
          key={p.requestId}
          request={p}
          onRespond={(optionId) => session.respondToPermission(p.requestId, optionId)}
        />
      ))}
      <input onSubmit={(text) => send([{ type: 'text', text }])} />
    </div>
  );
}
```

### 9.4 Integration Summary

```
部署方式                    命令                              适用场景
──────────────────────────────────────────────────────────────────────
npx acp-cloud start         一行命令                          本地开发、快速验证
docker compose up            容器化                            生产部署
createServer(runtime)        编程方式                          嵌入已有 Node 服务
new CloudRuntime(config)     纯 SDK                           自定义服务框架
CloudClient + React hooks    前端消费                          Web 应用集成
```

---

## 10. MVP Scope

### Phase 1: Core Runtime (Week 1)

- `CloudRuntime` with manual agent config (no registry auto-discover)
- `AgentPool`: spawn agent, create `ClientSideConnection`, `initialize`, `session/new`
- `Session`: create, prompt, cancel, close
- `Run`: async iterable of `RunEvent`, maps all ACP `session/update` types
- `MemorySessionStore` only
- Permission mode: `approve-all` only (auto-approve everything)
- Test with `claude-agent-acp`

### Phase 2: Interaction + Persistence (Week 2)

- Permission Controller: `approve-reads` and `deny-all` modes + `nonInteractivePolicy`
- Permission delegation flow (emit event → wait for response)
- `FileSessionStore` for persistence
- Crash recovery (detect death → respawn → `session/load`)
- Session TTL and idle cleanup
- Test with `codex-acp` and `gemini`

### Phase 3: HTTP/SSE Server + CLI + Docker (Week 3)

- All REST API endpoints
- SSE event streaming
- Permission bridge (SSE push → POST response)
- Basic auth middleware
- `PostgresSessionStore`
- **CLI**: `npx acp-cloud start` with config file support
- **CLI**: `npx acp-cloud prompt <agent> "..."` for quick testing
- **Dockerfile** + **docker-compose.yml** (runtime + Postgres)
- OpenAPI spec generation

### Phase 4: Client SDK + Multi-Agent Validation (Week 4)

- **`CloudClient`**: typed HTTP/SSE client for consuming the API
- **React hooks**: `useSession()`, `usePrompt()` for frontend integration
- ACP registry integration (auto-discover agents)
- Validate with 5+ different agents (Claude, Codex, Gemini, Goose, Cline)
- Document per-agent quirks and compatibility notes
- Performance benchmarks (session creation latency, event throughput)

---

## 11. Future Considerations (Post-MVP)

### ACP Remote Transport
When ACP standardizes HTTP/WebSocket transport, the Cloud Runtime could optionally expose sessions as ACP-over-HTTP endpoints, making it a true ACP proxy. This would allow ACP clients (like Zed) to connect to cloud-hosted agents through the runtime.

### Proxy Chains Integration
When ACP Proxy Chains RFD is accepted, the Skill Router and Permission Controller could be reimplemented as ACP proxies in the chain, yielding a cleaner architecture:

```
Client → Cloud Proxy (routing + auth) → Permission Proxy → Agent
```

### Multi-Tenant Deployment
- Tenant isolation at the session level (separate cwd, env vars, resource limits)
- Per-tenant agent allowlists
- Usage metering and rate limiting

### Container Sandboxing
- Integrate with Docker, Firecracker, or gVisor for per-session isolation
- Pre-built container images with common agent binaries pre-installed
- Workspace volume management (create, snapshot, restore)

### Agent Orchestration
- Route a single user prompt to multiple agents (fan-out)
- Agent chaining (output of one → input of another)
- Agent selection based on task classification

---

## 12. Key Technical Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Protocol | ACP (Agent Client Protocol) by Zed | 28+ agents, active ecosystem, fine-grained streaming |
| Transport (agent ↔ runtime) | stdio + NDJSON | Only ACP transport that's required/stable |
| Transport (runtime ↔ client) | HTTP + SSE | Standard, works everywhere, LangGraph-proven |
| Event model | 1:1 ACP session/update mapping | No abstraction tax, frontends can read ACP docs |
| Session persistence | Pluggable store interface | Different deployments need different storage |
| Permission model | Three modes (approve-all/approve-reads/deny-all) + nonInteractivePolicy | Identical to acpx, proven in production |
| Language | TypeScript | ACP SDK is TS, agent ecosystem is TS-heavy |
| Agent spawning | child_process.spawn | Standard Node.js, works with npx/binaries/any CLI |

---

## 13. Design Decisions Log

Decisions made during review, recorded for traceability.

| # | Question | Decision | Rationale |
|---|---|---|---|
| D1 | Auto-discover all registry agents, or curated allowlist? | **Curated allowlist + registry auto-resolve for listed agents.** Phase 4 validates top-5 agents; others added incrementally as tested. | Untested agents may have ACP implementation quirks. Allowlist gives quality control; DistributionResolver handles the mechanics for listed agents. |
| D2 | Permission mode naming: yolo/interactive or acpx-aligned? | **acpx-aligned: approve-all / approve-reads / deny-all** | Reduces cognitive load for developers familiar with acpx. Identical semantics, no reason to diverge. |
| D3 | Recovery policy default? | **fallback-new** (try session/load, degrade to session/new on non-fatal errors) | Matches acpx behavior. Maximizes session availability at the cost of losing conversation history on failure. Users who need strict consistency can opt into strict-load. |
| D4 | Non-interactive policy default? | **deny** (auto-reject when no client connected) | Matches acpx. Safe default — agents can still progress on tasks that don't require write permissions. |

---

## 14. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| ACP spec breaking changes | High | Pin SDK version, abstract protocol types behind internal interfaces |
| Agent-specific quirks in ACP implementation | Medium | Per-agent compatibility tests, document quirks in compatibility matrix |
| ACP remote transport diverges from our HTTP API | Medium | Design HTTP layer as thin wrapper; migrate when remote transport stabilizes |
| Agent process memory leaks (long-running sessions) | Medium | Session TTL, periodic health checks, automatic restart |
| Permission request timeout (user never responds) | Low | Configurable timeout with default action (reject) |
| NPX cold start latency for agents | Low | Agent process pooling, pre-warm option |

---

## Appendix A: ACP Protocol Quick Reference

### Session Lifecycle
1. `initialize` → capability negotiation
2. `session/new` or `session/load` → session setup
3. `session/prompt` → start a run
4. `session/update` (notifications) → streaming events during run
5. `session/request_permission` → human-in-the-loop
6. `session/cancel` → abort current run
7. `session/set_mode` / `session/set_config_option` → runtime configuration

### session/update Variants (aligned with SDK SessionUpdate union)
`agent_message_chunk` | `agent_thought_chunk` | `user_message_chunk` | `tool_call` | `tool_call_update` | `usage_update` | `plan` | `config_option_update` | `current_mode_update` | `available_commands_update` | `session_info_update`

Note: `tool_result` is NOT a session/update variant. Tool results are delivered as `tool_call_update` with `status: 'completed'`.

### Content Block Types
`text` | `image` | `audio` | `resource` | `resource_link` | `diff` | `terminal`

### Tool Kinds (aligned with SDK ToolKind enum)
`read` | `edit` | `delete` | `move` | `search` | `execute` | `think` | `fetch` | `switch_mode` | `other`

### Tool Call Statuses (aligned with SDK ToolCallStatus enum)
`pending` | `in_progress` | `completed` | `failed`

Note: No `cancelled` status. Cancellation surfaces as run-level `StopReason: 'cancelled'`.

## Appendix B: Research Sources

- ACP Protocol Spec: https://agentclientprotocol.com/
- ACP Prompt Turn Lifecycle: https://agentclientprotocol.com/protocol/prompt-turn
- ACP Proxy Chains RFD: https://agentclientprotocol.com/rfds/proxy-chains
- ACP TypeScript SDK: https://github.com/agentclientprotocol/typescript-sdk
- ACP Registry: https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json
- claude-agent-acp: https://github.com/zed-industries/claude-agent-acp
- codex-acp: https://github.com/zed-industries/codex-acp
- acpx: https://github.com/openclaw/acpx
- pi-acp: https://github.com/svkozak/pi-acp
- LangGraph Platform API: https://langchain-ai.github.io/langgraph/cloud/reference/api/
- DeepAgents: https://github.com/langchain-ai/deepagentsjs
- Claude Agent SDK: https://platform.claude.com/docs/en/agent-sdk/overview
- OpenAI Codex: https://developers.openai.com/codex/
