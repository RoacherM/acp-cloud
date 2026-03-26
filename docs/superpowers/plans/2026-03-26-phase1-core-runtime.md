# Phase 1: Core Runtime — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working TypeScript SDK that spawns any ACP agent as a subprocess, manages sessions, streams events as async iterables, and auto-approves all permissions — testable end-to-end with a mock agent.

**Architecture:** Single Node.js process manages agent subprocesses via `@agentclientprotocol/sdk`'s `ClientSideConnection` over stdio. Each session owns one agent process. Events flow from ACP `session/update` notifications through a typed `Run` async iterable. Phase 1 uses `MemorySessionStore` and `approve-all` permission mode only.

**Tech Stack:** TypeScript 5.x, Node.js 22, `@agentclientprotocol/sdk` 0.17.x, `zod` 3.x, `vitest` 2.x, `tsx` for running

**Spec:** `docs/superpowers/specs/2026-03-26-acp-cloud-runtime-design.md` sections 1-3, 5, 8

---

## File Map

```
acp-cloud-runtime/
├── package.json                    # Task 1
├── tsconfig.json                   # Task 1
├── vitest.config.ts                # Task 1
├── src/
│   ├── types.ts                    # Task 2 — all type definitions
│   ├── events.ts                   # Task 2 — RunEvent type + helpers
│   ├── stores/
│   │   ├── interface.ts            # Task 3 — SessionStore interface
│   │   └── memory.ts              # Task 3 — MemorySessionStore
│   ├── agent-pool.ts              # Task 5 — spawn/kill/monitor agent processes
│   ├── permission.ts              # Task 6 — PermissionController (approve-all)
│   ├── client-handler.ts          # Task 7 — SandboxedFsHandler
│   ├── run.ts                     # Task 8 — Run class (async iterable of RunEvent)
│   ├── session.ts                 # Task 9 — Session class + state machine
│   ├── runtime.ts                 # Task 10 — CloudRuntime top-level class
│   └── index.ts                   # Task 10 — public API exports
├── tests/
│   ├── helpers/
│   │   └── mock-agent.ts          # Task 4 — mock ACP agent subprocess
│   ├── stores/
│   │   └── memory.test.ts         # Task 3
│   ├── agent-pool.test.ts         # Task 5
│   ├── permission.test.ts         # Task 6
│   ├── client-handler.test.ts     # Task 7
│   ├── run.test.ts                # Task 8
│   ├── session.test.ts            # Task 9
│   └── runtime.test.ts            # Task 10
└── examples/
    └── basic-usage.ts             # Task 11
```

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`

- [ ] **Step 1: Initialize package.json**

```json
{
  "name": "acp-cloud-runtime",
  "version": "0.1.0",
  "type": "module",
  "description": "Cloud runtime for ACP agents — turns any ACP agent into an HTTP/SSE accessible service",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "scripts": {
    "build": "tsc",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "engines": {
    "node": ">=22"
  },
  "license": "Apache-2.0",
  "dependencies": {
    "@agentclientprotocol/sdk": "^0.17.0",
    "zod": "^3.25.0"
  },
  "devDependencies": {
    "@types/node": "^22.0.0",
    "tsx": "^4.0.0",
    "typescript": "^5.7.0",
    "vitest": "^2.0.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "lib": ["ES2022"],
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true
  },
  "include": ["src"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 10_000,
  },
});
```

- [ ] **Step 4: Install dependencies**

Run: `npm install`
Expected: `node_modules/` created, `package-lock.json` generated

- [ ] **Step 5: Verify setup**

Run: `npx tsc --noEmit`
Expected: No errors (no source files yet, just validates config)

Run: `npx vitest run`
Expected: "No test files found" (no tests yet)

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts
git commit -m "chore: scaffold project with TypeScript, vitest, ACP SDK dependency"
```

---

### Task 2: Type Definitions and Event Types

**Files:**
- Create: `src/types.ts`
- Create: `src/events.ts`

- [ ] **Step 1: Write src/types.ts — all core type definitions**

```typescript
// src/types.ts
// Core type definitions for ACP Cloud Runtime
// Aligned with @agentclientprotocol/sdk types and design spec sections 3.1-3.7

export type PermissionMode = 'approve-all' | 'approve-reads' | 'deny-all';

export type NonInteractivePolicy = 'deny' | 'fail';

export type RecoveryPolicy = 'strict-load' | 'fallback-new';

export type SessionStatus =
  | 'creating'
  | 'initializing'
  | 'ready'
  | 'running'
  | 'sleeping'
  | 'waking'
  | 'crashed'
  | 'recovering'
  | 'terminated';

export interface AgentDefinition {
  command: string;
  args: string[];
  env?: Record<string, string>;
  capabilities?: {
    image?: boolean;
    audio?: boolean;
  };
}

export interface SessionRecord {
  id: string;
  acpSessionId: string;
  agentSessionId: string | null;

  agentId: string;
  cwd: string;
  permissionMode: PermissionMode;
  nonInteractivePolicy: NonInteractivePolicy;
  agentModeId: string | null;
  recoveryPolicy: RecoveryPolicy;

  status: SessionStatus;
  pid: number | null;
  createdAt: Date;
  lastActivity: Date;
  metadata: Record<string, unknown>;
}

export interface SessionFilter {
  agentId?: string;
  status?: SessionStatus | SessionStatus[];
}

export interface CreateSessionOptions {
  agent: string;
  cwd: string;
  permissionMode?: PermissionMode;
  nonInteractivePolicy?: NonInteractivePolicy;
  agentModeId?: string;
  recoveryPolicy?: RecoveryPolicy;
  mcpServers?: Array<{ name: string; transport: unknown }>;
}

export interface RuntimeConfig {
  agents: Record<string, AgentDefinition>;
  sessionStore?: SessionStore;
  defaultPermissionMode?: PermissionMode;
  defaultNonInteractivePolicy?: NonInteractivePolicy;
  defaultRecoveryPolicy?: RecoveryPolicy;
  maxAgentProcesses?: number;
  maxActiveSessions?: number;
  sessionTTL?: number;
  sleepTTL?: number;
  maxQueueDepth?: number;
}

// Forward declaration — implemented in stores/interface.ts
export interface SessionStore {
  create(record: SessionRecord): Promise<void>;
  get(id: string): Promise<SessionRecord | null>;
  update(record: SessionRecord): Promise<void>;
  delete(id: string): Promise<void>;
  list(filter?: SessionFilter): Promise<SessionRecord[]>;
  reapStale(maxIdleMs: number): Promise<SessionRecord[]>;
}
```

- [ ] **Step 2: Write src/events.ts — RunEvent type definitions**

```typescript
// src/events.ts
// Event types for Run streaming — 1:1 mapping from ACP session/update
// Source of truth: @agentclientprotocol/sdk SessionUpdate union
import type {
  ContentBlock,
  ToolKind,
  ToolCallStatus,
  ToolCallContent,
  ToolCallLocation,
  PlanEntry,
  StopReason,
  PermissionOption,
  ToolCallUpdate,
  SessionNotification,
} from '@agentclientprotocol/sdk';

export type { ContentBlock, ToolKind, ToolCallStatus, StopReason, PermissionOption };

export type RunEvent =
  | { type: 'agent_message_chunk'; data: { content: ContentBlock } }
  | { type: 'agent_thought_chunk'; data: { content: ContentBlock } }
  | { type: 'user_message_chunk'; data: { content: ContentBlock } }
  | { type: 'tool_call'; data: { toolCallId: string; title: string; kind?: ToolKind; status?: ToolCallStatus; content?: ToolCallContent[]; locations?: ToolCallLocation[] } }
  | { type: 'tool_call_update'; data: { toolCallId: string; title?: string | null; kind?: ToolKind | null; status?: ToolCallStatus | null; content?: ToolCallContent[] | null; locations?: ToolCallLocation[] | null } }
  | { type: 'usage_update'; data: { size: number; used: number } }
  | { type: 'plan'; data: { entries: PlanEntry[] } }
  | { type: 'config_option_update'; data: { configId: string; value: string } }
  | { type: 'current_mode_update'; data: { currentModeId: string } }
  | { type: 'available_commands_update'; data: { commands: Array<{ name: string; description?: string }> } }
  | { type: 'session_info_update'; data: { title?: string | null; updatedAt?: string | null } }
  | { type: 'permission_request'; data: { requestId: string; toolCall: ToolCallUpdate; options: PermissionOption[] } }
  | { type: 'run_complete'; data: { stopReason: StopReason } }
  | { type: '_cloud.session_status'; data: { status: string } };

export function sessionUpdateToRunEvent(notification: SessionNotification): RunEvent | null {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk':
      return { type: 'agent_message_chunk', data: { content: update.content } };
    case 'agent_thought_chunk':
      return { type: 'agent_thought_chunk', data: { content: update.content } };
    case 'user_message_chunk':
      return { type: 'user_message_chunk', data: { content: update.content } };
    case 'tool_call':
      return { type: 'tool_call', data: { toolCallId: update.toolCallId, title: update.title, kind: update.kind, status: update.status, content: update.content, locations: update.locations } };
    case 'tool_call_update':
      return { type: 'tool_call_update', data: { toolCallId: update.toolCallId, title: update.title, kind: update.kind, status: update.status, content: update.content, locations: update.locations } };
    case 'usage_update':
      return { type: 'usage_update', data: { size: update.size, used: update.used } };
    case 'plan':
      return { type: 'plan', data: { entries: update.entries } };
    case 'config_option_update':
      return { type: 'config_option_update', data: { configId: update.configId, value: update.value } };
    case 'current_mode_update':
      return { type: 'current_mode_update', data: { currentModeId: update.currentModeId } };
    case 'available_commands_update':
      return { type: 'available_commands_update', data: { commands: update.commands } };
    case 'session_info_update':
      return { type: 'session_info_update', data: { title: update.title, updatedAt: update.updatedAt } };
    default:
      return null;
  }
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: No errors. If there are import errors from the SDK, check that `@agentclientprotocol/sdk` exports match. Adjust imports to match actual SDK exports (the SDK re-exports all types from its single entrypoint).

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/events.ts
git commit -m "feat: define core types and event mapping from ACP session/update"
```

---

### Task 3: MemorySessionStore

**Files:**
- Create: `src/stores/interface.ts`
- Create: `src/stores/memory.ts`
- Create: `tests/stores/memory.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/stores/memory.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { MemorySessionStore } from '../../src/stores/memory.js';
import type { SessionRecord } from '../../src/types.js';

function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: 'test-id',
    acpSessionId: 'acp-123',
    agentSessionId: null,
    agentId: 'claude',
    cwd: '/workspace',
    permissionMode: 'approve-all',
    nonInteractivePolicy: 'deny',
    agentModeId: null,
    recoveryPolicy: 'fallback-new',
    status: 'ready',
    pid: 1234,
    createdAt: new Date('2026-01-01'),
    lastActivity: new Date('2026-01-01'),
    metadata: {},
    ...overrides,
  };
}

describe('MemorySessionStore', () => {
  let store: MemorySessionStore;

  beforeEach(() => {
    store = new MemorySessionStore();
  });

  it('creates and retrieves a session record', async () => {
    const record = makeRecord();
    await store.create(record);
    const retrieved = await store.get('test-id');
    expect(retrieved).toEqual(record);
  });

  it('returns null for non-existent id', async () => {
    const result = await store.get('nonexistent');
    expect(result).toBeNull();
  });

  it('updates a session record', async () => {
    const record = makeRecord();
    await store.create(record);
    const updated = { ...record, status: 'running' as const };
    await store.update(updated);
    const retrieved = await store.get('test-id');
    expect(retrieved!.status).toBe('running');
  });

  it('deletes a session record', async () => {
    await store.create(makeRecord());
    await store.delete('test-id');
    const result = await store.get('test-id');
    expect(result).toBeNull();
  });

  it('lists sessions with no filter', async () => {
    await store.create(makeRecord({ id: 'a', agentId: 'claude' }));
    await store.create(makeRecord({ id: 'b', agentId: 'codex' }));
    const all = await store.list();
    expect(all).toHaveLength(2);
  });

  it('lists sessions filtered by agentId', async () => {
    await store.create(makeRecord({ id: 'a', agentId: 'claude' }));
    await store.create(makeRecord({ id: 'b', agentId: 'codex' }));
    const filtered = await store.list({ agentId: 'claude' });
    expect(filtered).toHaveLength(1);
    expect(filtered[0].agentId).toBe('claude');
  });

  it('lists sessions filtered by status array', async () => {
    await store.create(makeRecord({ id: 'a', status: 'ready' }));
    await store.create(makeRecord({ id: 'b', status: 'running' }));
    await store.create(makeRecord({ id: 'c', status: 'terminated' }));
    const filtered = await store.list({ status: ['ready', 'running'] });
    expect(filtered).toHaveLength(2);
  });

  it('reaps stale sessions by idle time', async () => {
    const old = new Date(Date.now() - 600_000); // 10 min ago
    const recent = new Date(Date.now() - 60_000); // 1 min ago
    await store.create(makeRecord({ id: 'old', lastActivity: old, status: 'sleeping' }));
    await store.create(makeRecord({ id: 'recent', lastActivity: recent, status: 'sleeping' }));
    const reaped = await store.reapStale(300_000); // 5 min threshold
    expect(reaped).toHaveLength(1);
    expect(reaped[0].id).toBe('old');
    // Reaped session should be marked terminated
    const reapedRecord = await store.get('old');
    expect(reapedRecord!.status).toBe('terminated');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/stores/memory.test.ts`
Expected: FAIL — modules not found

- [ ] **Step 3: Write src/stores/interface.ts**

```typescript
// src/stores/interface.ts
// Re-export SessionStore from types (single source of truth)
export type { SessionStore, SessionRecord, SessionFilter } from '../types.js';
```

- [ ] **Step 4: Write src/stores/memory.ts**

```typescript
// src/stores/memory.ts
import type { SessionStore, SessionRecord, SessionFilter } from './interface.js';

export class MemorySessionStore implements SessionStore {
  private records = new Map<string, SessionRecord>();

  async create(record: SessionRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async get(id: string): Promise<SessionRecord | null> {
    const record = this.records.get(id);
    return record ? { ...record } : null;
  }

  async update(record: SessionRecord): Promise<void> {
    this.records.set(record.id, { ...record });
  }

  async delete(id: string): Promise<void> {
    this.records.delete(id);
  }

  async list(filter?: SessionFilter): Promise<SessionRecord[]> {
    let results = Array.from(this.records.values());
    if (filter?.agentId) {
      results = results.filter(r => r.agentId === filter.agentId);
    }
    if (filter?.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      results = results.filter(r => statuses.includes(r.status));
    }
    return results.map(r => ({ ...r }));
  }

  async reapStale(maxIdleMs: number): Promise<SessionRecord[]> {
    const threshold = Date.now() - maxIdleMs;
    const reaped: SessionRecord[] = [];
    for (const record of this.records.values()) {
      if (record.status === 'sleeping' && record.lastActivity.getTime() < threshold) {
        record.status = 'terminated';
        reaped.push({ ...record });
      }
    }
    return reaped;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/stores/memory.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/stores/ tests/stores/
git commit -m "feat: add MemorySessionStore with filtering and stale reaping"
```

---

### Task 4: Mock ACP Agent for Testing

**Files:**
- Create: `tests/helpers/mock-agent.ts`

This mock agent is a script that runs as a subprocess, speaks ACP over stdio, and responds predictably to initialize/newSession/prompt. It's essential for testing without real agents.

- [ ] **Step 1: Write the mock agent**

```typescript
// tests/helpers/mock-agent.ts
// A minimal ACP agent that runs as a subprocess for testing.
// Spawned by tests, communicates via stdin/stdout NDJSON.
import { Readable, Writable } from 'node:stream';
import {
  AgentSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Agent,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type CancelNotification,
  type AuthenticateRequest,
} from '@agentclientprotocol/sdk';

let sessionCounter = 0;
let cancelled = false;

class MockAgent implements Agent {
  private connection: AgentSideConnection | null = null;

  setConnection(conn: AgentSideConnection): void {
    this.connection = conn;
  }

  async initialize(params: InitializeRequest): Promise<InitializeResponse> {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: {},
      agentInfo: { name: 'mock-agent', version: '0.1.0' },
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    sessionCounter++;
    return {
      sessionId: `mock-session-${sessionCounter}`,
    };
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    cancelled = false;
    const conn = this.connection!;
    const sessionId = params.sessionId;

    // Emit agent message chunk
    await conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello from mock agent!' },
      },
    });

    // Emit a tool call
    await conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'Read file.ts',
        kind: 'read',
        status: 'pending',
      },
    });

    // Emit tool call completion
    await conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        content: [{ type: 'content', content: { type: 'text', text: 'file contents here' } }],
      },
    });

    // Emit final message
    await conn.sessionUpdate({
      sessionId,
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: ' Done.' },
      },
    });

    if (cancelled) {
      return { stopReason: 'cancelled' };
    }

    return { stopReason: 'end_turn' };
  }

  async cancel(params: CancelNotification): Promise<void> {
    cancelled = true;
  }

  async authenticate(_params: AuthenticateRequest): Promise<void> {
    // No auth needed for mock
  }
}

// Main: wire up stdio
const input = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
const output = Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
const stream = ndJsonStream(output, input);

const agent = new MockAgent();
const connection = new AgentSideConnection((_client) => {
  agent.setConnection(connection);
  return agent;
}, stream);

// Keep process alive
connection.closed.then(() => process.exit(0));
```

- [ ] **Step 2: Verify mock agent compiles**

Run: `npx tsc --noEmit --esModuleInterop tests/helpers/mock-agent.ts 2>&1 || echo "Expected: TS checks tests separately"`

The mock agent uses SDK types. If TypeScript can't check it due to tsconfig scope, that's fine — it will be run via `tsx` at runtime. Verify it at least parses:

Run: `npx tsx --eval "import('./tests/helpers/mock-agent.ts')" 2>&1 | head -5`
Expected: Process starts (blocks on stdin). Kill it — it means it compiles and runs.

- [ ] **Step 3: Commit**

```bash
git add tests/helpers/mock-agent.ts
git commit -m "test: add mock ACP agent subprocess for integration testing"
```

---

### Task 5: Agent Pool

**Files:**
- Create: `src/agent-pool.ts`
- Create: `tests/agent-pool.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/agent-pool.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { AgentPool } from '../src/agent-pool.js';
import type { AgentDefinition } from '../src/types.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = join(__dirname, 'helpers', 'mock-agent.ts');

const mockAgentDef: AgentDefinition = {
  command: 'npx',
  args: ['tsx', MOCK_AGENT_PATH],
};

describe('AgentPool', () => {
  let pool: AgentPool;

  afterEach(async () => {
    if (pool) await pool.killAll();
  });

  it('spawns an agent process and returns a handle', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const handle = await pool.spawn('mock');
    expect(handle.pid).toBeGreaterThan(0);
    expect(handle.agentInfo.name).toBe('mock-agent');
  });

  it('throws for unknown agent id', async () => {
    pool = new AgentPool({ agents: {} });
    await expect(pool.spawn('nonexistent')).rejects.toThrow('Unknown agent');
  });

  it('reports alive status correctly', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    const handle = await pool.spawn('mock');
    expect(pool.isAlive(handle)).toBe(true);
    await pool.kill(handle);
    // Give process a moment to exit
    await new Promise(r => setTimeout(r, 100));
    expect(pool.isAlive(handle)).toBe(false);
  });

  it('tracks stats', async () => {
    pool = new AgentPool({ agents: { mock: mockAgentDef } });
    expect(pool.stats().active).toBe(0);
    const handle = await pool.spawn('mock');
    expect(pool.stats().active).toBe(1);
    expect(pool.stats().totalSpawned).toBe(1);
    await pool.kill(handle);
    await new Promise(r => setTimeout(r, 100));
    expect(pool.stats().active).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/agent-pool.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/agent-pool.ts**

```typescript
// src/agent-pool.ts
import { spawn, type ChildProcess } from 'node:child_process';
import { Readable, Writable } from 'node:stream';
import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type Agent,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from '@agentclientprotocol/sdk';
import type { AgentDefinition } from './types.js';

export interface AgentHandle {
  pid: number;
  connection: ClientSideConnection;
  agentInfo: { name: string; version: string };
  process: ChildProcess;
}

export interface AgentPoolConfig {
  agents: Record<string, AgentDefinition>;
}

export type SessionUpdateHandler = (notification: SessionNotification) => void;
export type PermissionRequestHandler = (params: RequestPermissionRequest) => Promise<RequestPermissionResponse>;

export interface ClientHandlers {
  onSessionUpdate: SessionUpdateHandler;
  onPermissionRequest: PermissionRequestHandler;
}

export class AgentPool {
  private agents: Record<string, AgentDefinition>;
  private handles = new Set<AgentHandle>();
  private totalSpawned = 0;
  private totalCrashed = 0;

  constructor(config: AgentPoolConfig) {
    this.agents = config.agents;
  }

  async spawn(
    agentId: string,
    handlers?: ClientHandlers,
    env?: Record<string, string>,
  ): Promise<AgentHandle> {
    const def = this.agents[agentId];
    if (!def) throw new Error(`Unknown agent: ${agentId}`);

    const mergedEnv = { ...process.env, ...def.env, ...env };
    const child = spawn(def.command, def.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: mergedEnv,
    });

    const input = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
    const output = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;
    const stream = ndJsonStream(output, input);

    const client: Client = {
      async sessionUpdate(params: SessionNotification): Promise<void> {
        handlers?.onSessionUpdate(params);
      },
      async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
        if (handlers?.onPermissionRequest) {
          return handlers.onPermissionRequest(params);
        }
        // Default: approve first option
        return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } };
      },
    };

    const connection = new ClientSideConnection((_agent: Agent) => client, stream);

    const initResult = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
      clientInfo: { name: 'acp-cloud-runtime', version: '0.1.0' },
    });

    const handle: AgentHandle = {
      pid: child.pid!,
      connection,
      agentInfo: {
        name: initResult.agentInfo?.name ?? 'unknown',
        version: initResult.agentInfo?.version ?? '0.0.0',
      },
      process: child,
    };

    this.handles.add(handle);
    this.totalSpawned++;

    child.on('exit', () => {
      this.handles.delete(handle);
    });

    return handle;
  }

  async kill(handle: AgentHandle): Promise<void> {
    handle.process.kill('SIGTERM');
    this.handles.delete(handle);
  }

  async killAll(): Promise<void> {
    const promises = Array.from(this.handles).map(h => this.kill(h));
    await Promise.all(promises);
  }

  isAlive(handle: AgentHandle): boolean {
    try {
      process.kill(handle.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  stats(): { active: number; totalSpawned: number; totalCrashed: number } {
    return {
      active: this.handles.size,
      totalSpawned: this.totalSpawned,
      totalCrashed: this.totalCrashed,
    };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/agent-pool.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/agent-pool.ts tests/agent-pool.test.ts
git commit -m "feat: add AgentPool — spawn/kill/monitor ACP agent subprocesses"
```

---

### Task 6: Permission Controller

**Files:**
- Create: `src/permission.ts`
- Create: `tests/permission.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/permission.test.ts
import { describe, it, expect } from 'vitest';
import { PermissionController } from '../src/permission.js';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';

function makePermissionRequest(kind: string = 'read'): RequestPermissionRequest {
  return {
    sessionId: 'test-session',
    toolCall: {
      toolCallId: 'tc-1',
      kind: kind as any,
    },
    options: [
      { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
      { optionId: 'opt-allow-always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
    ],
  };
}

describe('PermissionController', () => {
  describe('approve-all mode', () => {
    const controller = new PermissionController('approve-all', 'deny');

    it('auto-approves read tools with allow_always', async () => {
      const result = await controller.resolve(makePermissionRequest('read'));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-always' });
    });

    it('auto-approves write tools with allow_always', async () => {
      const result = await controller.resolve(makePermissionRequest('edit'));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-always' });
    });

    it('auto-approves execute tools with allow_always', async () => {
      const result = await controller.resolve(makePermissionRequest('execute'));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-always' });
    });

    it('falls back to allow_once if allow_always not available', async () => {
      const req = makePermissionRequest('read');
      req.options = [
        { optionId: 'opt-allow-once', name: 'Allow once', kind: 'allow_once' },
        { optionId: 'opt-reject', name: 'Reject', kind: 'reject_once' },
      ];
      const result = await controller.resolve(req);
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-once' });
    });
  });

  describe('deny-all mode', () => {
    const controller = new PermissionController('deny-all', 'deny');

    it('auto-rejects all tools', async () => {
      const result = await controller.resolve(makePermissionRequest('read'));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'opt-reject' });
    });
  });

  describe('approve-reads mode', () => {
    const controller = new PermissionController('approve-reads', 'deny');

    it('auto-approves read tools', async () => {
      const result = await controller.resolve(makePermissionRequest('read'));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-once' });
    });

    it('auto-approves search tools', async () => {
      const result = await controller.resolve(makePermissionRequest('search'));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-once' });
    });

    it('auto-approves think tools', async () => {
      const result = await controller.resolve(makePermissionRequest('think'));
      expect(result.outcome).toEqual({ outcome: 'selected', optionId: 'opt-allow-once' });
    });

    it('returns null for edit tools (needs delegation)', async () => {
      const result = await controller.resolve(makePermissionRequest('edit'));
      expect(result).toBeNull();
    });

    it('returns null for execute tools (needs delegation)', async () => {
      const result = await controller.resolve(makePermissionRequest('execute'));
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/permission.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/permission.ts**

```typescript
// src/permission.ts
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  PermissionOptionKind,
  ToolKind,
} from '@agentclientprotocol/sdk';
import type { PermissionMode, NonInteractivePolicy } from './types.js';

const READ_KINDS: Set<string> = new Set(['read', 'search', 'think']);

export class PermissionController {
  constructor(
    private mode: PermissionMode,
    private nonInteractivePolicy: NonInteractivePolicy,
  ) {}

  /**
   * Attempt to auto-resolve a permission request based on mode.
   * Returns the response if auto-resolvable, or null if delegation is needed.
   */
  async resolve(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse | null> {
    const kind = request.toolCall.kind ?? 'other';

    if (this.mode === 'approve-all') {
      return this.selectOption(request, 'allow');
    }

    if (this.mode === 'deny-all') {
      return this.selectOption(request, 'reject');
    }

    // approve-reads: auto-approve read/search/think, delegate the rest
    if (this.mode === 'approve-reads') {
      if (READ_KINDS.has(kind)) {
        return this.selectOption(request, 'allow');
      }
      // Needs delegation
      return null;
    }

    return null;
  }

  /**
   * Fallback when no client is connected to handle a delegated permission.
   */
  resolveNonInteractive(
    request: RequestPermissionRequest,
  ): RequestPermissionResponse {
    if (this.nonInteractivePolicy === 'fail') {
      throw new Error('Permission required but no client connected (nonInteractivePolicy: fail)');
    }
    // deny: auto-reject
    return this.selectOption(request, 'reject')!;
  }

  private selectOption(
    request: RequestPermissionRequest,
    preference: 'allow' | 'reject',
  ): RequestPermissionResponse | null {
    const options = request.options;

    if (preference === 'allow') {
      // Prefer allow_always, fallback to allow_once
      const allowAlways = options.find(o => o.kind === 'allow_always');
      if (allowAlways) return { outcome: { outcome: 'selected', optionId: allowAlways.optionId } };
      const allowOnce = options.find(o => o.kind === 'allow_once');
      if (allowOnce) return { outcome: { outcome: 'selected', optionId: allowOnce.optionId } };
    }

    if (preference === 'reject') {
      const rejectOnce = options.find(o => o.kind === 'reject_once');
      if (rejectOnce) return { outcome: { outcome: 'selected', optionId: rejectOnce.optionId } };
      const rejectAlways = options.find(o => o.kind === 'reject_always');
      if (rejectAlways) return { outcome: { outcome: 'selected', optionId: rejectAlways.optionId } };
    }

    // Fallback: select first option
    if (options.length > 0) {
      return { outcome: { outcome: 'selected', optionId: options[0].optionId } };
    }
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/permission.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/permission.ts tests/permission.test.ts
git commit -m "feat: add PermissionController with approve-all/reads/deny-all modes"
```

---

### Task 7: Sandboxed Filesystem Handler

**Files:**
- Create: `src/client-handler.ts`
- Create: `tests/client-handler.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/client-handler.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SandboxedFsHandler } from '../src/client-handler.js';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

describe('SandboxedFsHandler', () => {
  let tempDir: string;
  let handler: SandboxedFsHandler;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'acp-test-'));
    handler = new SandboxedFsHandler(tempDir);
    await writeFile(join(tempDir, 'test.txt'), 'hello world');
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it('reads a file within the sandbox', async () => {
    const content = await handler.readTextFile('session-1', 'test.txt');
    expect(content).toBe('hello world');
  });

  it('reads a file by absolute path within sandbox', async () => {
    const content = await handler.readTextFile('session-1', join(tempDir, 'test.txt'));
    expect(content).toBe('hello world');
  });

  it('rejects path traversal via ..', async () => {
    await expect(handler.readTextFile('session-1', '../../../etc/passwd')).rejects.toThrow('escapes sandbox');
  });

  it('rejects absolute path outside sandbox', async () => {
    await expect(handler.readTextFile('session-1', '/etc/passwd')).rejects.toThrow('escapes sandbox');
  });

  it('rejects symlink escaping', async () => {
    await symlink('/etc', join(tempDir, 'escape-link'));
    await expect(handler.readTextFile('session-1', 'escape-link/passwd')).rejects.toThrow('escapes sandbox');
  });

  it('writes a file within the sandbox', async () => {
    await handler.writeTextFile('session-1', 'output.txt', 'written');
    const content = await handler.readTextFile('session-1', 'output.txt');
    expect(content).toBe('written');
  });

  it('rejects write outside sandbox', async () => {
    await expect(handler.writeTextFile('session-1', '/tmp/escape.txt', 'bad')).rejects.toThrow('escapes sandbox');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/client-handler.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/client-handler.ts**

```typescript
// src/client-handler.ts
import { realpath, readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'node:path';

export class SandboxedFsHandler {
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
    const candidate = isAbsolute(inputPath) ? inputPath : resolve(root, inputPath);
    const realCandidate = await realpath(candidate);
    const rel = relative(root, realCandidate);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Path escapes sandbox: ${inputPath} → ${realCandidate}`);
    }
    return realCandidate;
  }

  async readTextFile(_sessionId: string, path: string): Promise<string> {
    const safePath = await this.resolveWithinRoot(path);
    return readFile(safePath, 'utf-8');
  }

  async writeTextFile(_sessionId: string, path: string, content: string): Promise<void> {
    const safePath = await this.resolveWithinRoot(path);
    await mkdir(dirname(safePath), { recursive: true });
    await writeFile(safePath, content, 'utf-8');
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/client-handler.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/client-handler.ts tests/client-handler.test.ts
git commit -m "feat: add SandboxedFsHandler with realpath+relative path validation"
```

---

### Task 8: Run (Async Iterable Event Stream)

**Files:**
- Create: `src/run.ts`
- Create: `tests/run.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/run.test.ts
import { describe, it, expect } from 'vitest';
import { Run } from '../src/run.js';
import type { RunEvent } from '../src/events.js';

describe('Run', () => {
  it('yields events pushed into it', async () => {
    const run = new Run('run-1');
    const events: RunEvent[] = [];

    // Push events in a microtask
    queueMicrotask(() => {
      run.pushEvent({ type: 'agent_message_chunk', data: { content: { type: 'text', text: 'hi' } } });
      run.pushEvent({ type: 'run_complete', data: { stopReason: 'end_turn' } });
      run.complete('end_turn');
    });

    for await (const event of run) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('agent_message_chunk');
    expect(events[1].type).toBe('run_complete');
  });

  it('reports status as running then completed', async () => {
    const run = new Run('run-1');
    expect(run.status).toBe('running');

    queueMicrotask(() => {
      run.complete('end_turn');
    });

    for await (const _event of run) {
      // drain
    }

    expect(run.status).toBe('completed');
    expect(run.stopReason).toBe('end_turn');
  });

  it('supports cancel', async () => {
    const run = new Run('run-1');
    const events: RunEvent[] = [];

    queueMicrotask(() => {
      run.pushEvent({ type: 'agent_message_chunk', data: { content: { type: 'text', text: 'start' } } });
      run.complete('cancelled');
    });

    for await (const event of run) {
      events.push(event);
    }

    expect(run.status).toBe('completed');
    expect(run.stopReason).toBe('cancelled');
  });

  it('supports permission_request events via listener', async () => {
    const run = new Run('run-1');
    const permRequests: any[] = [];

    run.on('permission_request', (req) => {
      permRequests.push(req);
    });

    queueMicrotask(() => {
      run.pushEvent({
        type: 'permission_request',
        data: {
          requestId: 'pr-1',
          toolCall: { toolCallId: 'tc-1' } as any,
          options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' as const }],
        },
      });
      run.complete('end_turn');
    });

    const events: RunEvent[] = [];
    for await (const event of run) {
      events.push(event);
    }

    expect(permRequests).toHaveLength(1);
    expect(permRequests[0].requestId).toBe('pr-1');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/run.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/run.ts**

```typescript
// src/run.ts
import type { RunEvent, StopReason } from './events.js';

type EventListener = (data: any) => void;

export class Run implements AsyncIterable<RunEvent> {
  readonly id: string;
  private _status: 'queued' | 'running' | 'completed' = 'running';
  private _stopReason: StopReason | null = null;
  private eventQueue: RunEvent[] = [];
  private resolve: (() => void) | null = null;
  private done = false;
  private listeners = new Map<string, EventListener[]>();

  constructor(id: string) {
    this.id = id;
  }

  get status(): string {
    return this._status;
  }

  get stopReason(): StopReason | null {
    return this._stopReason;
  }

  pushEvent(event: RunEvent): void {
    // Notify listeners for specific event types
    const typeListeners = this.listeners.get(event.type);
    if (typeListeners) {
      for (const listener of typeListeners) {
        listener((event as any).data);
      }
    }

    this.eventQueue.push(event);
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  complete(stopReason: StopReason): void {
    this._status = 'completed';
    this._stopReason = stopReason;
    this.done = true;
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }

  on(eventType: string, listener: EventListener): void {
    const existing = this.listeners.get(eventType) ?? [];
    existing.push(listener);
    this.listeners.set(eventType, existing);
  }

  async *[Symbol.asyncIterator](): AsyncIterator<RunEvent> {
    while (true) {
      while (this.eventQueue.length > 0) {
        yield this.eventQueue.shift()!;
      }
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.resolve = resolve;
      });
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/run.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/run.ts tests/run.test.ts
git commit -m "feat: add Run class — async iterable event stream with listeners"
```

---

### Task 9: Session Class

**Files:**
- Create: `src/session.ts`
- Create: `tests/session.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/session.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { Session } from '../src/session.js';
import { AgentPool } from '../src/agent-pool.js';
import { PermissionController } from '../src/permission.js';
import { MemorySessionStore } from '../src/stores/memory.js';
import type { SessionRecord } from '../src/types.js';
import type { RunEvent } from '../src/events.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = join(__dirname, 'helpers', 'mock-agent.ts');

function makePool(): AgentPool {
  return new AgentPool({
    agents: {
      mock: { command: 'npx', args: ['tsx', MOCK_AGENT_PATH] },
    },
  });
}

describe('Session', () => {
  let pool: AgentPool;

  afterEach(async () => {
    if (pool) await pool.killAll();
  });

  it('creates a session and transitions to ready', async () => {
    pool = makePool();
    const store = new MemorySessionStore();
    const session = await Session.create({
      agentId: 'mock',
      cwd: process.cwd(),
      permissionMode: 'approve-all',
      nonInteractivePolicy: 'deny',
      recoveryPolicy: 'fallback-new',
      pool,
      store,
    });

    expect(session.status).toBe('ready');
    expect(session.id).toBeTruthy();
    expect(session.acpSessionId).toBeTruthy();

    await session.close();
  });

  it('sends a prompt and receives events', async () => {
    pool = makePool();
    const store = new MemorySessionStore();
    const session = await Session.create({
      agentId: 'mock',
      cwd: process.cwd(),
      permissionMode: 'approve-all',
      nonInteractivePolicy: 'deny',
      recoveryPolicy: 'fallback-new',
      pool,
      store,
    });

    const run = await session.prompt([{ type: 'text', text: 'Hello' }]);
    const events: RunEvent[] = [];

    for await (const event of run) {
      events.push(event);
    }

    expect(run.status).toBe('completed');
    expect(run.stopReason).toBe('end_turn');

    // Mock agent emits: message_chunk, tool_call, tool_call_update, message_chunk, run_complete
    const types = events.map(e => e.type);
    expect(types).toContain('agent_message_chunk');
    expect(types).toContain('tool_call');
    expect(types).toContain('tool_call_update');
    expect(types).toContain('run_complete');

    await session.close();
  });

  it('session status is running during prompt', async () => {
    pool = makePool();
    const store = new MemorySessionStore();
    const session = await Session.create({
      agentId: 'mock',
      cwd: process.cwd(),
      permissionMode: 'approve-all',
      nonInteractivePolicy: 'deny',
      recoveryPolicy: 'fallback-new',
      pool,
      store,
    });

    const run = await session.prompt([{ type: 'text', text: 'Hello' }]);
    // During prompt, session is running
    expect(session.status).toBe('running');

    // Drain events
    for await (const _event of run) {}

    // After prompt completes, session returns to ready
    expect(session.status).toBe('ready');

    await session.close();
  });

  it('persists session record to store', async () => {
    pool = makePool();
    const store = new MemorySessionStore();
    const session = await Session.create({
      agentId: 'mock',
      cwd: process.cwd(),
      permissionMode: 'approve-all',
      nonInteractivePolicy: 'deny',
      recoveryPolicy: 'fallback-new',
      pool,
      store,
    });

    const record = await store.get(session.id);
    expect(record).not.toBeNull();
    expect(record!.agentId).toBe('mock');
    expect(record!.status).toBe('ready');

    await session.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/session.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/session.ts**

```typescript
// src/session.ts
import { randomUUID } from 'node:crypto';
import type { ContentBlock } from '@agentclientprotocol/sdk';
import { AgentPool, type AgentHandle, type ClientHandlers } from './agent-pool.js';
import { PermissionController } from './permission.js';
import { Run } from './run.js';
import { sessionUpdateToRunEvent } from './events.js';
import type { SessionRecord, SessionStore, PermissionMode, NonInteractivePolicy, RecoveryPolicy } from './types.js';

export interface SessionCreateOptions {
  agentId: string;
  cwd: string;
  permissionMode: PermissionMode;
  nonInteractivePolicy: NonInteractivePolicy;
  recoveryPolicy: RecoveryPolicy;
  agentModeId?: string;
  mcpServers?: Array<{ name: string; transport: unknown }>;
  pool: AgentPool;
  store: SessionStore;
}

export class Session {
  readonly id: string;
  private record: SessionRecord;
  private handle: AgentHandle | null = null;
  private pool: AgentPool;
  private store: SessionStore;
  private permissionController: PermissionController;
  private activeRun: Run | null = null;

  private constructor(
    record: SessionRecord,
    handle: AgentHandle,
    pool: AgentPool,
    store: SessionStore,
  ) {
    this.id = record.id;
    this.record = record;
    this.handle = handle;
    this.pool = pool;
    this.store = store;
    this.permissionController = new PermissionController(
      record.permissionMode,
      record.nonInteractivePolicy,
    );
  }

  get status(): string {
    return this.record.status;
  }

  get acpSessionId(): string {
    return this.record.acpSessionId;
  }

  static async create(opts: SessionCreateOptions): Promise<Session> {
    const id = randomUUID();
    const record: SessionRecord = {
      id,
      acpSessionId: '',
      agentSessionId: null,
      agentId: opts.agentId,
      cwd: opts.cwd,
      permissionMode: opts.permissionMode,
      nonInteractivePolicy: opts.nonInteractivePolicy,
      agentModeId: opts.agentModeId ?? null,
      recoveryPolicy: opts.recoveryPolicy,
      status: 'creating',
      pid: null,
      createdAt: new Date(),
      lastActivity: new Date(),
      metadata: { mcpServers: opts.mcpServers ?? [] },
    };
    await opts.store.create(record);

    // Spawn agent — handlers will be wired per-prompt
    const handle = await opts.pool.spawn(opts.agentId);
    record.status = 'initializing';
    record.pid = handle.pid;
    await opts.store.update(record);

    // Create ACP session
    const acpResult = await handle.connection.newSession({
      cwd: opts.cwd,
      mcpServers: (opts.mcpServers ?? []) as any[],
    });

    record.acpSessionId = acpResult.sessionId;
    record.status = 'ready';
    record.lastActivity = new Date();
    await opts.store.update(record);

    return new Session(record, handle, opts.pool, opts.store);
  }

  async prompt(content: ContentBlock[]): Promise<Run> {
    if (this.record.status !== 'ready') {
      throw new Error(`Cannot prompt session in status: ${this.record.status}`);
    }

    const run = new Run(randomUUID());
    this.activeRun = run;
    this.record.status = 'running';
    this.record.lastActivity = new Date();
    await this.store.update(this.record);

    // Run the prompt in the background — events flow through sessionUpdate callback
    this.executePrompt(content, run).catch((err) => {
      run.pushEvent({ type: '_cloud.session_status', data: { status: 'error' } });
      run.complete('refusal');
    });

    return run;
  }

  private async executePrompt(content: ContentBlock[], run: Run): Promise<void> {
    const connection = this.handle!.connection;
    const sessionId = this.record.acpSessionId;
    const permController = this.permissionController;

    // Wire up session update handler for this run
    const originalHandlers: ClientHandlers = {
      onSessionUpdate: (notification) => {
        const event = sessionUpdateToRunEvent(notification);
        if (event) {
          run.pushEvent(event);
        }
      },
      onPermissionRequest: async (request) => {
        // Try auto-resolve
        const autoResult = await permController.resolve(request);
        if (autoResult) return autoResult;
        // Phase 1: no delegation, use non-interactive policy
        return permController.resolveNonInteractive(request);
      },
    };

    // Re-spawn with handlers attached
    // Note: In Phase 1 we use the existing connection from spawn.
    // The handlers need to be wired. Since ClientSideConnection uses the
    // Client object passed at construction, we need to update the handlers
    // on the pool's spawn. For Phase 1, we handle this by passing handlers
    // during spawn and keeping them for the session lifetime.
    //
    // Actually: the handlers are already baked into the Client at spawn time.
    // For Phase 1, we solve this by having the AgentPool accept a mutable
    // handler reference. Let's use the simpler approach: the Client delegates
    // to the session's current handlers.

    // Send prompt (blocks until agent responds)
    const result = await connection.prompt({
      sessionId,
      prompt: content,
    });

    // Push run_complete event
    run.pushEvent({ type: 'run_complete', data: { stopReason: result.stopReason } });
    run.complete(result.stopReason);

    this.activeRun = null;
    this.record.status = 'ready';
    this.record.lastActivity = new Date();
    await this.store.update(this.record);
  }

  async close(): Promise<void> {
    if (this.handle) {
      await this.pool.kill(this.handle);
      this.handle = null;
    }
    this.record.status = 'terminated';
    this.record.lastActivity = new Date();
    await this.store.update(this.record);
  }
}
```

- [ ] **Step 4: Fix the handler wiring issue**

The session creates a Run with handlers, but the AgentPool's `Client` was created at spawn time with a fixed handler. We need the pool to support mutable handlers so the session can update them per-prompt.

Update `src/agent-pool.ts` — change `ClientHandlers` to be mutable:

```typescript
// In AgentPool.spawn(), change the client creation to use a mutable reference:

// Add to AgentHandle:
export interface AgentHandle {
  pid: number;
  connection: ClientSideConnection;
  agentInfo: { name: string; version: string };
  process: ChildProcess;
  handlers: ClientHandlers;  // <-- add this
}

// In spawn(), use a mutable handlers reference:
const handlersRef: ClientHandlers = {
  onSessionUpdate: handlers?.onSessionUpdate ?? (() => {}),
  onPermissionRequest: handlers?.onPermissionRequest ?? (async (params) => {
    return { outcome: { outcome: 'selected', optionId: params.options[0].optionId } };
  }),
};

const client: Client = {
  async sessionUpdate(params: SessionNotification): Promise<void> {
    handlersRef.onSessionUpdate(params);
  },
  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    return handlersRef.onPermissionRequest(params);
  },
};

// Store handlersRef in the handle so Session can update it:
const handle: AgentHandle = {
  pid: child.pid!,
  connection,
  agentInfo: { ... },
  process: child,
  handlers: handlersRef,
};
```

Then in `src/session.ts`, wire handlers before each prompt:

```typescript
// In executePrompt():
this.handle!.handlers.onSessionUpdate = (notification) => {
  const event = sessionUpdateToRunEvent(notification);
  if (event) run.pushEvent(event);
};
this.handle!.handlers.onPermissionRequest = async (request) => {
  const autoResult = await permController.resolve(request);
  if (autoResult) return autoResult;
  return permController.resolveNonInteractive(request);
};
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/session.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/session.ts src/agent-pool.ts tests/session.test.ts
git commit -m "feat: add Session class with state machine, prompt lifecycle, and event streaming"
```

---

### Task 10: CloudRuntime + Public API

**Files:**
- Create: `src/runtime.ts`
- Create: `src/index.ts`
- Create: `tests/runtime.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/runtime.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { CloudRuntime } from '../src/runtime.js';
import type { RunEvent } from '../src/events.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_AGENT_PATH = join(__dirname, 'helpers', 'mock-agent.ts');

describe('CloudRuntime', () => {
  let runtime: CloudRuntime;

  afterEach(async () => {
    if (runtime) await runtime.shutdown();
  });

  it('creates a runtime and lists no sessions', async () => {
    runtime = new CloudRuntime({
      agents: {
        mock: { command: 'npx', args: ['tsx', MOCK_AGENT_PATH] },
      },
    });
    const sessions = await runtime.listSessions();
    expect(sessions).toHaveLength(0);
  });

  it('creates a session', async () => {
    runtime = new CloudRuntime({
      agents: {
        mock: { command: 'npx', args: ['tsx', MOCK_AGENT_PATH] },
      },
    });
    const session = await runtime.createSession({ agent: 'mock', cwd: process.cwd() });
    expect(session.status).toBe('ready');
  });

  it('end-to-end: create session, send prompt, receive events', async () => {
    runtime = new CloudRuntime({
      agents: {
        mock: { command: 'npx', args: ['tsx', MOCK_AGENT_PATH] },
      },
    });
    const session = await runtime.createSession({ agent: 'mock', cwd: process.cwd() });
    const run = await session.prompt([{ type: 'text', text: 'Hello' }]);

    const events: RunEvent[] = [];
    for await (const event of run) {
      events.push(event);
    }

    expect(run.stopReason).toBe('end_turn');
    expect(events.length).toBeGreaterThan(0);
    expect(events.some(e => e.type === 'agent_message_chunk')).toBe(true);
    expect(events.some(e => e.type === 'run_complete')).toBe(true);
  });

  it('lists active sessions', async () => {
    runtime = new CloudRuntime({
      agents: {
        mock: { command: 'npx', args: ['tsx', MOCK_AGENT_PATH] },
      },
    });
    await runtime.createSession({ agent: 'mock', cwd: process.cwd() });
    const sessions = await runtime.listSessions();
    expect(sessions).toHaveLength(1);
    expect(sessions[0].agentId).toBe('mock');
  });

  it('throws for unknown agent', async () => {
    runtime = new CloudRuntime({ agents: {} });
    await expect(runtime.createSession({ agent: 'missing', cwd: '/' })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/runtime.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write src/runtime.ts**

```typescript
// src/runtime.ts
import { AgentPool } from './agent-pool.js';
import { Session } from './session.js';
import { MemorySessionStore } from './stores/memory.js';
import type { RuntimeConfig, CreateSessionOptions, SessionStore, SessionRecord } from './types.js';

export class CloudRuntime {
  private pool: AgentPool;
  private store: SessionStore;
  private sessions = new Map<string, Session>();
  private config: Required<Pick<RuntimeConfig, 'defaultPermissionMode' | 'defaultNonInteractivePolicy' | 'defaultRecoveryPolicy' | 'maxAgentProcesses' | 'maxActiveSessions' | 'sessionTTL' | 'sleepTTL' | 'maxQueueDepth'>>;

  constructor(config: RuntimeConfig) {
    this.pool = new AgentPool({ agents: config.agents });
    this.store = config.sessionStore ?? new MemorySessionStore();
    this.config = {
      defaultPermissionMode: config.defaultPermissionMode ?? 'approve-all',
      defaultNonInteractivePolicy: config.defaultNonInteractivePolicy ?? 'deny',
      defaultRecoveryPolicy: config.defaultRecoveryPolicy ?? 'fallback-new',
      maxAgentProcesses: config.maxAgentProcesses ?? 20,
      maxActiveSessions: config.maxActiveSessions ?? 50,
      sessionTTL: config.sessionTTL ?? 300_000,
      sleepTTL: config.sleepTTL ?? 86_400_000,
      maxQueueDepth: config.maxQueueDepth ?? 8,
    };
  }

  async createSession(opts: Omit<CreateSessionOptions, 'pool' | 'store' | 'permissionMode' | 'nonInteractivePolicy' | 'recoveryPolicy'> & Partial<Pick<CreateSessionOptions, 'permissionMode' | 'nonInteractivePolicy' | 'recoveryPolicy'>>): Promise<Session> {
    const session = await Session.create({
      agentId: opts.agent,
      cwd: opts.cwd,
      permissionMode: opts.permissionMode ?? this.config.defaultPermissionMode,
      nonInteractivePolicy: opts.nonInteractivePolicy ?? this.config.defaultNonInteractivePolicy,
      recoveryPolicy: opts.recoveryPolicy ?? this.config.defaultRecoveryPolicy,
      agentModeId: opts.agentModeId,
      mcpServers: opts.mcpServers,
      pool: this.pool,
      store: this.store,
    });

    this.sessions.set(session.id, session);
    return session;
  }

  async listSessions(): Promise<SessionRecord[]> {
    return this.store.list();
  }

  async getSession(id: string): Promise<Session | null> {
    return this.sessions.get(id) ?? null;
  }

  async shutdown(): Promise<void> {
    for (const session of this.sessions.values()) {
      await session.close();
    }
    this.sessions.clear();
    await this.pool.killAll();
  }
}
```

- [ ] **Step 4: Write src/index.ts — public API exports**

```typescript
// src/index.ts
export { CloudRuntime } from './runtime.js';
export { Session } from './session.js';
export { Run } from './run.js';
export { AgentPool } from './agent-pool.js';
export { PermissionController } from './permission.js';
export { SandboxedFsHandler } from './client-handler.js';
export { MemorySessionStore } from './stores/memory.js';

export { sessionUpdateToRunEvent } from './events.js';
export type { RunEvent, StopReason, ToolKind, ToolCallStatus, ContentBlock, PermissionOption } from './events.js';
export type {
  RuntimeConfig,
  AgentDefinition,
  SessionRecord,
  SessionStore,
  SessionFilter,
  CreateSessionOptions,
  PermissionMode,
  NonInteractivePolicy,
  RecoveryPolicy,
  SessionStatus,
} from './types.js';
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/runtime.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests across all files PASS

- [ ] **Step 7: Commit**

```bash
git add src/runtime.ts src/index.ts tests/runtime.test.ts
git commit -m "feat: add CloudRuntime — top-level orchestrator with session management"
```

---

### Task 11: Example + Final Validation

**Files:**
- Create: `examples/basic-usage.ts`

- [ ] **Step 1: Write the example**

```typescript
// examples/basic-usage.ts
// Minimal example: create a session, send a prompt, print events.
// Run: npx tsx examples/basic-usage.ts
import { CloudRuntime } from '../src/index.js';

async function main() {
  const runtime = new CloudRuntime({
    agents: {
      // Replace with a real agent to test:
      // claude: { command: 'npx', args: ['-y', '@zed-industries/claude-agent-acp'] },
      // For testing with mock:
      mock: { command: 'npx', args: ['tsx', 'tests/helpers/mock-agent.ts'] },
    },
  });

  console.log('Creating session...');
  const session = await runtime.createSession({
    agent: 'mock',
    cwd: process.cwd(),
  });
  console.log(`Session created: ${session.id} (ACP: ${session.acpSessionId})`);

  console.log('Sending prompt...');
  const run = await session.prompt([{ type: 'text', text: 'Hello from the cloud runtime!' }]);

  for await (const event of run) {
    switch (event.type) {
      case 'agent_message_chunk':
        if (event.data.content.type === 'text') {
          process.stdout.write(event.data.content.text);
        }
        break;
      case 'tool_call':
        console.log(`\n[Tool] ${event.data.title} (${event.data.kind})`);
        break;
      case 'tool_call_update':
        console.log(`[Tool Update] ${event.data.toolCallId} → ${event.data.status}`);
        break;
      case 'run_complete':
        console.log(`\n[Done] Stop reason: ${event.data.stopReason}`);
        break;
    }
  }

  await runtime.shutdown();
}

main().catch(console.error);
```

- [ ] **Step 2: Run the example**

Run: `npx tsx examples/basic-usage.ts`
Expected output (approximately):
```
Creating session...
Session created: <uuid> (ACP: mock-session-1)
Sending prompt...
Hello from mock agent!
[Tool] Read file.ts (read)
[Tool Update] tc-1 → completed
 Done.
[Done] Stop reason: end_turn
```

- [ ] **Step 3: Run all tests one final time**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Type check**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 5: Commit**

```bash
git add examples/basic-usage.ts
git commit -m "docs: add basic-usage example showing session creation and event streaming"
```

---

## Phase 1 Complete Checklist

After all tasks:

- [ ] `CloudRuntime` creates and manages sessions
- [ ] `AgentPool` spawns/kills ACP agent subprocesses
- [ ] `Session` implements state machine (creating → initializing → ready → running → ready)
- [ ] `Run` is an async iterable of typed `RunEvent`
- [ ] `sessionUpdateToRunEvent` maps all ACP `session/update` variants
- [ ] `PermissionController` supports approve-all/approve-reads/deny-all
- [ ] `SandboxedFsHandler` uses realpath+relative for path validation
- [ ] `MemorySessionStore` persists session records in-memory
- [ ] Mock agent enables testing without real agents
- [ ] End-to-end test: create runtime → create session → send prompt → receive events → shutdown
- [ ] All tests pass, types check cleanly
