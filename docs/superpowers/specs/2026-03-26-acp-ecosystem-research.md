# ACP Ecosystem Research Report

Date: 2026-03-26

## 1. ACP Protocol (Agent Client Protocol)

### Overview
- Created by Zed Industries, now an open standard at agentclientprotocol.com
- JSON-RPC 2.0 based, bidirectional communication between clients and coding agents
- Inspired by LSP — eliminates M*N integration problem for AI agents
- Transport: **stdio** (required, stable), **HTTP/WebSocket** (WIP, not yet standardized)

### Session Lifecycle
1. **Initialize** — capability negotiation (client/agent capabilities, auth methods)
2. **Session setup** — `session/new` (fresh) or `session/load` (resume)
3. **Prompt turns** — `session/prompt` → streaming events → response
4. **Configuration** — `session/set_mode`, `session/set_config_option`
5. **Cancellation** — `session/cancel` (cooperative, notification-based)

### Streaming Events (session/update variants)
| Event | Description |
|---|---|
| `agent_message_chunk` | Streaming text from agent |
| `user_message_chunk` | Echoed user message |
| `tool_call` | Initial tool call (pending status) |
| `tool_call_update` | Progress/completion of tool call |
| `tool_result` | Final tool result |
| `plan` | Full plan with entries (replaces previous) |
| `config_option_update` | Agent-initiated config change |
| `current_mode_update` | Agent-initiated mode change |
| `available_commands_update` | Slash commands list |
| `session_info_update` | Session metadata change |

### Permission Model
- Agent sends `session/request_permission` before executing tools
- Request contains `toolCall` details and `options[]` with `kind`: allow_once, allow_always, reject_once, reject_always
- Client responds with selected option or `cancelled`
- Tool kinds: read, edit, delete, move, search, execute, think, fetch, other

### Content Block Types
- `text` (always supported), `image`, `audio` (capability-gated)
- `resource`, `resource_link` (embedded context)
- `diff` (path, oldText, newText — for tool call content)
- `terminal` (terminal reference)

### Proxy Chains RFD (Prototype, Not Accepted)
- Enables message interception: Client → Conductor → Proxy1 → Proxy2 → Agent
- Use cases: context injection, tool filtering, skill routing, MCP provision
- Working prototype in Rust crates (`sacp`, `sacp-tokio`, `sacp-proxy`, `sacp-conductor`)
- Proxies receive `proxy/initialize` (not `initialize`)
- Conductor manages chain lifecycle, routes messages
- Cannot modify agent system prompts directly (only prepend messages)

---

## 2. ACP Registry — 28+ Agents

### Official Registry Agents

| Agent | ID | Version | Author | Type | Distribution | License |
|---|---|---|---|---|---|---|
| Amp | amp-acp | 0.7.0 | Community | Adapter | Binaries | Apache-2.0 |
| Auggie CLI | auggie | 0.21.0 | Augment Code | Native | NPX | Proprietary |
| Autohand Code | autohand | 0.2.1 | Autohand AI | Adapter | NPX | Apache-2.0 |
| Claude Agent | claude-acp | 0.23.0 | Anthropic | Adapter | NPX | Proprietary |
| Cline | cline | 2.9.0 | Cline Bot Inc. | Native | NPX | Apache-2.0 |
| Codebuddy Code | codebuddy-code | 2.66.0 | Tencent Cloud | Native | NPX | Proprietary |
| Codex CLI | codex-acp | 0.10.0 | OpenAI / Zed | Adapter | Binaries + NPX | Apache-2.0 |
| Corust Agent | corust-agent | 0.4.0 | Corust AI | Native | Binaries | GPL-3.0 |
| crow-cli | crow-cli | 0.1.14 | Thomas Wood | Native | UVX (Python) | Apache-2.0 |
| Cursor | cursor | 0.1.0 | Cursor | Native | Binaries | Proprietary |
| DeepAgents | deepagents | 0.1.4 | LangChain | Native | NPX | MIT |
| DimCode | dimcode | 0.0.19 | ArcShips | Native | NPX | Proprietary |
| Factory Droid | factory-droid | 0.85.0 | Factory AI | Native | NPX | Proprietary |
| fast-agent | fast-agent | 0.6.9 | fast-agent.ai | Native | UVX (Python) | Apache-2.0 |
| Gemini CLI | gemini | 0.35.0 | Google | Native | NPX | Apache-2.0 |
| GitHub Copilot | github-copilot-cli | 1.0.11 | GitHub | Native | NPX | Proprietary |
| Goose | goose | 1.28.0 | Block (Square) | Native | Binaries | Apache-2.0 |
| Junie | junie | 888.212.0 | JetBrains | Native | Binaries | Proprietary |
| Kilo | kilo | 7.1.4 | Kilo Code | Native | Binaries + NPX | MIT |
| Kimi CLI | kimi | 1.26.0 | Moonshot AI | Native | Binaries | MIT |
| Minion Code | minion-code | 0.1.44 | femto | Native | UVX (Python) | AGPL-3.0 |
| Mistral Vibe | mistral-vibe | 2.6.2 | Mistral AI | Native | Binaries | Apache-2.0 |
| Nova | nova | 1.0.86 | Compass AI | Native | NPX | Proprietary |
| OpenCode | opencode | 1.3.2 | Anomaly | Native | Binaries | MIT |
| pi ACP | pi-acp | 0.0.23 | Sergii Kozak | Adapter | NPX | MIT |
| Qoder CLI | qoder | 0.1.35 | Qoder AI | Native | NPX | Proprietary |
| Qwen Code | qwen-code | 0.13.0 | Alibaba Qwen | Native | NPX | Apache-2.0 |
| Stakpak | stakpak | 0.3.69 | Stakpak | Native | Binaries | Apache-2.0 |

### Additional Agents (on zed.dev/acp, not yet in registry)
AutoDev, Blackbox AI, Code Assistant, Docker cagent, fount, Kiro CLI (AWS), OpenClaw, OpenHands, VT Code

### Community Adapters (not in registry)
aider-acp (experimental, 7 stars), kiro-agent-acp-npm, cursor-agent-acp-npm

---

## 3. SDK Implementations Deep Dive

### claude-agent-acp (Zed Industries)
- **Architecture**: In-process library (Claude Agent SDK embedded)
- **Key class**: `ClaudeAcpAgent` implements ACP `Agent` interface
- **Permission pattern**: `canUseTool(sessionId)` returns callback → `requestPermission()` RPC to client
- **Library-importable**: YES — `lib.ts` exports `ClaudeAcpAgent`, `runAcp`, etc.
- **Session persistence**: Delegates to Claude Agent SDK's session files
- **Streaming**: SDK `Query` async iterator → `sessionUpdate` notifications via `streamEventToAcpNotifications()`
- **Maturity**: Production (v0.23.0, 347 commits, 1.3k stars)

### codex-acp (Zed Industries)
- **Architecture**: Rust binary wrapping Codex CLI
- **Distribution**: NPX + pre-built binaries
- **Library-importable**: NO (binary only)
- **Features**: Context mentions, images, tool calls, code review, MCP passthrough
- **Maturity**: Production (v0.10.0, 528 stars)

### acpx (OpenClaw)
- **Architecture**: Subprocess orchestrator (spawns any ACP agent)
- **Session management**: Persistent records in `~/.acpx/sessions/`, queue owner per session
- **Queue/IPC**: Unix domain socket, submit_prompt/cancel/set_mode protocol
- **TTL**: Queue owners stay alive for configurable TTL (default 300s) after last prompt
- **Crash recovery**: Detect dead PID → respawn → session/load → fallback session/new
- **Permission modes**: approve-all, deny-all, approve-reads (with non-interactive fallback)
- **Library-importable**: NO (CLI tool only)

### pi-acp (Community)
- **Architecture**: Subprocess bridge (spawns `pi --mode rpc`)
- **No ACP permission delegation**: Pi handles all tool execution internally
- **Turn queue**: Built into session, sequential drain on agent_end
- **Session persistence**: Via pi's own files + session-map.json
- **Library-importable**: NO (CLI tool only)

### ACP TypeScript SDK (@agentclientprotocol/sdk)
- **Core abstractions**: `AgentSideConnection`, `ClientSideConnection`, `Stream`, `ndJsonStream`
- **Transport-agnostic**: `Stream` = `{readable, writable}` of `AnyMessage`
- **Building any client**: Use `ClientSideConnection(clientFactory, stream)` + implement `Client` interface
- **Client interface requires**: `sessionUpdate()`, `requestPermission()`
- **Optional client methods**: `readTextFile`, `writeTextFile`, terminal methods
- **Maturity**: Production (v0.17.0, 847 npm dependents)

---

## 4. Cloud Runtime Landscape

### OpenAI Codex
- **Cloud**: OpenAI-managed containers, two-phase execution (setup with network → agent offline)
- **Sandbox**: Landlock + seccomp (built-in, on by default)
- **SDK**: TypeScript (`@openai/codex-sdk`), Python, app-server
- **Session**: Thread-based, 12hr container cache
- **Cost**: $20-200/mo subscription + credits (~25 credits per cloud task)

### Claude Agent SDK
- **Cloud**: Self-managed Docker containers (official images ~600MB)
- **Sandbox**: Delegated to container provider (Docker, gVisor, Firecracker, E2B, Modal, etc.)
- **SDK**: Python + TypeScript, CLI headless mode (`claude -p`)
- **Session**: Session IDs, resumable/forkable, hybrid hydration pattern
- **Deployment patterns**: Ephemeral, long-running, hybrid, single-container
- **Cost**: Pay-per-token ($3-25/M), ~$6/dev/day average

### Pi Agent
- **Cloud**: None (local-first, single process)
- **Sandbox**: None ("YOLO by default")
- **SDK**: Interactive, print/JSON, RPC, embedded SDK modes
- **Provider-agnostic**: 15+ LLM providers
- **Cost**: Free (OSS), LLM tokens only

### Industry Trends (2025-2026)
1. MicroVMs becoming gold standard for secure agent execution
2. "Bring your own sandbox" pattern dominates
3. Protocol convergence: MCP (tools) + ACP (agent comm) + A2A (discovery)
4. Ephemeral-by-default with session hydration as preferred cloud pattern

---

## 5. LangGraph Platform (Key Competitor/Inspiration)

### Resource Model
- **Assistants** — configured graph instances
- **Threads** — persistent conversation sessions
- **Runs** — individual invocations
- **Store** — cross-thread key-value memory

### Streaming (5 SSE modes)
- `values` — full state snapshot after each step
- `updates` — state delta after each step
- `messages` — token-level LLM output
- `custom` — arbitrary user-defined events
- `debug` — full execution trace

### Human-in-the-loop
- `interrupt()` pauses graph, returns control to caller
- `Command(resume=value)` resumes from interrupt
- Checkpoints persist full state to PostgreSQL

### Architecture
- Stateless API servers + stateless queue workers
- PostgreSQL for durable state
- Redis for ephemeral pub/sub
- Container-based deployment

### Key Differences from Our Approach
- LangGraph hosts **graphs** (code). We host **ACP agent processes** (binaries).
- LangGraph is framework-locked. We are agent-agnostic via ACP.
- LangGraph's streaming is proprietary. Ours maps directly from ACP session/update.
- LangGraph's human-in-the-loop uses interrupt/Command. Ours uses ACP's requestPermission.

---

## 6. Key Insight

The ACP ecosystem has everything except a cloud runtime. 28+ agents speak ACP, two production SDKs exist, IDE integration is solved (Zed). The missing piece is exactly what we're building: **the bridge from ACP stdio to cloud HTTP/SSE services**.

This is not a new protocol or framework — it's the infrastructure layer that makes the existing ACP ecosystem cloud-accessible.
