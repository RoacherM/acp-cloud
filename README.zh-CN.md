# ACP Cloud Runtime

将任何 [ACP](https://agentclientprotocol.org/)（Agent Client Protocol）编程智能体变成可远程调用的云端 HTTP/SSE 服务。一个 npm 包即可获得会话管理、实时流式输出、权限管控和开箱即用的 Web UI — 支持 Pi、Claude Code、Codex 以及任何 ACP 兼容智能体。

## 为什么需要它

Pi、Claude Code、Codex 等编程智能体本身以本地 CLI 工具的形式通过 stdio 运行。本项目将它们封装为有状态的 HTTP 服务，使你能够：

- 在服务器上部署智能体，从任何设备远程访问
- 构建自定义 UI 或将智能体集成到你自己的平台
- 同时管理多个智能体的并发会话
- 添加自定义 Skills 让智能体远程执行

---

## 架构

```
┌─────────────────────────────────────────────────┐
│  你的应用 / Web UI / API 客户端                   │
│  (HTTP + SSE)                                   │
└───────────────┬─────────────────────────────────┘
                │
┌───────────────▼─────────────────────────────────┐
│  createServer(runtime, opts)    ← Hono HTTP     │
│  ┌────────────────────────────────────────────┐ │
│  │  CloudRuntime                              │ │
│  │  ├── SessionController (每个会话独立)        │ │
│  │  │   ├── EventHub (SSE 流式推送)            │ │
│  │  │   ├── Permission (权限委托)              │ │
│  │  │   └── Run lifecycle (执行生命周期)        │ │
│  │  ├── AgentPool (进程管理)                   │ │
│  │  └── SessionStore (内存 / 文件 / 自定义)     │ │
│  └────────────────────────────────────────────┘ │
└───────────────┬─────────────────────────────────┘
                │  stdio (ACP / JSON-RPC)
    ┌───────────┼───────────┐
    ▼           ▼           ▼
┌────────┐ ┌────────┐ ┌────────┐
│ pi-acp │ │ claude │ │ codex  │
│        │ │ -agent │ │ -acp   │
│        │ │ -acp   │ │        │
└────────┘ └────────┘ └────────┘
```

### 核心模块说明

| 模块 | 文件 | 职责 |
|------|------|------|
| **CloudRuntime** | `src/runtime.ts` | 中央调度器，管理多个并发会话，负责准入控制 |
| **SessionController** | `src/session-controller.ts` | 每个会话的状态机，管理运行生命周期和事件缓冲 |
| **AgentPool** | `src/agent-pool.ts` | 子进程管理，通过 stdio 建立 ACP 连接 |
| **EventHub** | `src/event-hub.ts` | 内存事件队列，支持缓冲和回放，供 SSE 推送 |
| **Permission** | `src/permission.ts` | 权限控制，4 种委托模式 |
| **SessionStore** | `src/stores/` | 会话持久化（内存/文件/自定义后端） |
| **HTTP Server** | `src/server.ts` | Hono 路由，Bearer 认证，SSE 端点 |

### 会话状态机

```
[ready] ──prompt()──▶ [busy] ──完成──▶ [ready]
                        ├──失败──────▶ [ready]
                        └──崩溃──────▶ [ready] 或 [terminated]

[任何状态] ──close()──▶ [terminated]
```

- **ready** — 空闲，等待用户提交 prompt
- **busy** — 正在执行，事件流推送中
- **terminated** — 会话已关闭

---

## 快速开始

### 作为 npm 库集成到你的服务

```bash
npm install acp-cloud-runtime
```

```typescript
import { CloudRuntime, createServer } from 'acp-cloud-runtime';
import { serve } from '@hono/node-server';

const runtime = new CloudRuntime({
  agents: {
    pi: {
      command: 'pi-acp',
      args: [],
      env: { OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY },
    },
    claude: {
      command: 'claude-agent-acp',
      args: [],
      env: {
        ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
        ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
        ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      },
    },
  },
});

const app = createServer(runtime, {
  apiKey: process.env.API_KEY,       // 可选 Bearer 认证
  workspace: '/path/to/workspace',   // 智能体工作目录
});

// 在同一个 Hono app 上挂载你自己的路由
app.get('/my-route', (c) => c.json({ custom: true }));

serve({ fetch: app.fetch, port: 3000 });
```

`createServer` 返回标准 Hono 应用 — 可作为子路由挂载、添加中间件，或与现有服务合并。

### 独立运行

```bash
git clone https://github.com/RoacherM/acp-cloud.git && cd acp-cloud
npm install

# 设置 API Key
export OPENROUTER_API_KEY=sk-or-...

# 启动
node --import tsx examples/server.ts
```

打开 http://localhost:3000 即可使用 Web UI。

### Docker

```bash
# 构建
docker build -t acp-cloud-runtime .

# 运行
docker run -d \
  -p 3000:3000 \
  -e OPENROUTER_API_KEY=sk-or-... \
  -v $(pwd)/workspace:/home/agent/workspace \
  -v $(pwd)/config/pi:/home/agent/.pi/agent \
  acp-cloud-runtime
```

### Docker Compose

```bash
# 创建 .env
cat > .env << EOF
OPENROUTER_API_KEY=sk-or-...
API_KEY=my-secret-token
EOF

docker compose up -d
docker compose logs -f
```

---

## API 参考

### 端点一览

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/health` | 健康检查（公开，无需认证） |
| `GET` | `/config` | 获取工作目录配置 |
| `GET` | `/agents` | 列出可用智能体 |
| `POST` | `/sessions` | 创建会话 |
| `GET` | `/sessions` | 列出所有会话 |
| `GET` | `/sessions/:id` | 获取会话详情 |
| `GET` | `/sessions/:id/events` | SSE 实时事件流 |
| `POST` | `/sessions/:id/prompt` | 发送提示词（异步，结果通过 SSE 推送） |
| `POST` | `/sessions/:id/cancel` | 取消当前运行 |
| `POST` | `/sessions/:id/permissions/:reqId/respond` | 回应权限请求 |
| `DELETE` | `/sessions/:id` | 关闭会话 |

### 认证

设置了 `API_KEY` 环境变量后，所有非公开端点需要 Bearer Token：

```
Authorization: Bearer <your-api-key>
```

公开路径（不需要认证）：`/health`、`/`、静态资源（`.js`、`.css`、`.png`、`.svg`、`.ico`）

---

### 1. 列出可用智能体

```bash
curl http://localhost:3000/agents \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

**响应：**

```json
{ "agents": ["pi", "claude", "codex"] }
```

### 2. 创建会话

```bash
curl -X POST http://localhost:3000/sessions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -d '{
    "agent": "pi",
    "cwd": "/home/agent/workspace",
    "permissionMode": "approve-all"
  }'
```

**请求体字段：**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `agent` | string | 是 | 智能体 ID，如 `"pi"`、`"claude"`、`"codex"` |
| `cwd` | string | 否 | 工作目录，默认为服务器当前目录 |
| `permissionMode` | string | 否 | 权限模式：`approve-all`（默认）、`approve-reads`、`deny-all`、`delegate` |

**响应（201）：**

```json
{
  "id": "a1b2c3d4-...",
  "agentId": "pi",
  "status": "ready",
  "createdAt": "2026-03-31T10:00:00.000Z",
  "lastActivity": "2026-03-31T10:00:00.000Z"
}
```

### 3. 订阅 SSE 事件流

```bash
curl -N http://localhost:3000/sessions/SESSION_ID/events \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

> **注意：** 标准浏览器 `EventSource` 不支持自定义 Header。如需在前端传递 API Key，请使用项目提供的 `AcpEventSource`（基于 fetch 实现）或在查询参数中传递 token。

连接建立后，会立即回放当前运行已缓冲的事件（从 `run_started` 开始），然后进入实时推送模式。

### 4. 发送提示词

```bash
curl -X POST http://localhost:3000/sessions/SESSION_ID/prompt \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -d '{"text": "写一个 Python 脚本打印斐波那契数列"}'
```

**响应（202）：**

```json
{
  "id": "run-uuid-...",
  "sessionId": "a1b2c3d4-...",
  "status": "running",
  "stopReason": null
}
```

此端点立即返回，执行结果通过 SSE 事件流实时推送。

### 5. 取消运行

```bash
curl -X POST http://localhost:3000/sessions/SESSION_ID/cancel \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

**响应：** `{ "cancelled": true }`

### 6. 回应权限请求

当 `permissionMode` 为 `delegate` 或 `approve-reads` 时，智能体执行写操作前会通过 SSE 发送 `permission_request` 事件。你需要调用此端点来批准或拒绝：

```bash
curl -X POST http://localhost:3000/sessions/SESSION_ID/permissions/REQ_ID/respond \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer YOUR_API_KEY' \
  -d '{"optionId": "allow_once"}'
```

**可用的 optionId：**

| optionId | 说明 |
|----------|------|
| `allow_once` | 本次允许 |
| `allow_always` | 始终允许此类操作 |
| `reject_once` | 本次拒绝 |
| `reject_always` | 始终拒绝此类操作 |

> 权限请求超时时间默认 30 秒，超时自动拒绝。

### 7. 关闭会话

```bash
curl -X DELETE http://localhost:3000/sessions/SESSION_ID \
  -H 'Authorization: Bearer YOUR_API_KEY'
```

**响应：** `{ "closed": true }`

---

## SSE 事件参考

通过 `GET /sessions/:id/events` 订阅，每个事件格式为：

```
event: <事件类型>
data: <JSON 数据>
```

### 会话生命周期事件

#### `session_status_changed` — 状态变更

```json
{
  "type": "session_status_changed",
  "sessionId": "uuid",
  "from": "ready",
  "to": "busy",
  "reason": "prompt_started"
}
```

`reason` 取值：`prompt_started`、`run_completed`、`run_error`、`user_closed`、`agent_crashed`、`init_failed`

#### `run_started` — 运行开始

```json
{
  "type": "run_started",
  "sessionId": "uuid",
  "runId": "uuid"
}
```

#### `run_completed` — 运行完成

```json
{
  "type": "run_completed",
  "sessionId": "uuid",
  "runId": "uuid",
  "stopReason": "end_turn"
}
```

`stopReason` 取值：`user_message`、`max_tokens`、`end_turn`、`cancelled`

#### `run_error` — 运行出错

```json
{
  "type": "run_error",
  "sessionId": "uuid",
  "runId": "uuid",
  "error": "错误描述"
}
```

### 流式内容事件

#### `agent_message_chunk` — 智能体回复（流式）

```json
{
  "type": "agent_message_chunk",
  "sessionId": "uuid",
  "runId": "uuid",
  "content": { "text": "部分回复内容..." },
  "messageId": "uuid"
}
```

#### `agent_thought_chunk` — 智能体思考过程（流式）

```json
{
  "type": "agent_thought_chunk",
  "sessionId": "uuid",
  "runId": "uuid",
  "content": { "text": "正在思考..." },
  "messageId": "uuid"
}
```

### 工具调用事件

#### `tool_call` — 智能体调用了工具

```json
{
  "type": "tool_call",
  "sessionId": "uuid",
  "runId": "uuid",
  "toolCallId": "uuid",
  "title": "run_command",
  "kind": "execute",
  "status": "in_progress",
  "content": [{ "type": "text", "text": "ls -la" }]
}
```

`kind` 取值：`read`、`write`、`execute` 等
`status` 取值：`in_progress`、`completed`、`failed`

#### `tool_call_update` — 工具执行进度

```json
{
  "type": "tool_call_update",
  "sessionId": "uuid",
  "runId": "uuid",
  "toolCallId": "uuid",
  "status": "completed",
  "rawOutput": "工具执行结果..."
}
```

### 权限事件

#### `permission_request` — 需要用户授权

```json
{
  "type": "permission_request",
  "sessionId": "uuid",
  "runId": "uuid",
  "requestId": "uuid",
  "toolCall": {
    "toolCallId": "uuid",
    "title": "write_file",
    "kind": "write",
    "status": "pending"
  },
  "options": [
    { "optionId": "allow_once", "name": "Allow once", "kind": "allow_once" },
    { "optionId": "allow_always", "name": "Allow always", "kind": "allow_always" },
    { "optionId": "reject_once", "name": "Reject once", "kind": "reject_once" },
    { "optionId": "reject_always", "name": "Reject always", "kind": "reject_always" }
  ]
}
```

#### `permission_timeout` — 授权超时

```json
{
  "type": "permission_timeout",
  "sessionId": "uuid",
  "requestId": "uuid"
}
```

### 其他事件

| 事件类型 | 说明 |
|----------|------|
| `user_message_chunk` | 用户消息确认 |
| `plan` | 智能体生成的任务计划 |
| `available_commands_update` | 可用命令列表变更 |
| `current_mode_update` | 智能体模式变更 |
| `usage_update` | Token 用量统计 |
| `store_error` | 会话存储操作失败 |

---

## 完整调用示例

### 使用 curl（命令行）

```bash
# 0. 设置变量
BASE_URL="http://localhost:3000"
API_KEY="your-api-key"
AUTH="Authorization: Bearer $API_KEY"

# 1. 查看可用智能体
curl -s "$BASE_URL/agents" -H "$AUTH" | jq

# 2. 创建会话
SESSION_ID=$(curl -s -X POST "$BASE_URL/sessions" \
  -H 'Content-Type: application/json' \
  -H "$AUTH" \
  -d '{"agent":"pi","cwd":"/home/agent/workspace"}' | jq -r '.id')
echo "Session: $SESSION_ID"

# 3. 在另一个终端监听事件流
curl -N "$BASE_URL/sessions/$SESSION_ID/events" -H "$AUTH"

# 4. 发送提示词
curl -s -X POST "$BASE_URL/sessions/$SESSION_ID/prompt" \
  -H 'Content-Type: application/json' \
  -H "$AUTH" \
  -d '{"text":"用 Python 写一个快速排序算法"}' | jq

# 5. 完成后关闭会话
curl -s -X DELETE "$BASE_URL/sessions/$SESSION_ID" -H "$AUTH" | jq
```

### 使用 JavaScript（浏览器/Node.js）

项目提供了框架无关的客户端库 `acp-client.js`，可用于任何前端框架（React、Vue、Angular、原生 JS）：

```javascript
import { AcpClient } from './acp-client.js';

const client = new AcpClient('http://localhost:3000', 'your-api-key');

// 1. 列出可用智能体
const { agents } = await client.listAgents();
console.log('可用智能体:', agents);

// 2. 创建会话
const session = await client.createSession('pi', '/home/agent/workspace');
console.log('会话 ID:', session.id);

// 3. 订阅事件流
const sse = client.subscribe(session.id);

// 监听智能体回复
sse.addEventListener('agent_message_chunk', (e) => {
  process.stdout.write(e.detail.content.text);  // 流式输出
});

// 监听思考过程
sse.addEventListener('agent_thought_chunk', (e) => {
  console.log('[思考]', e.detail.content.text);
});

// 监听工具调用
sse.addEventListener('tool_call', (e) => {
  console.log('[工具]', e.detail.title, '→', e.detail.status);
});

// 监听运行完成
sse.addEventListener('run_completed', (e) => {
  console.log('\n运行完成:', e.detail.stopReason);
});

// 监听权限请求
sse.addEventListener('permission_request', async (e) => {
  const { requestId } = e.detail;
  // 自动批准（或展示 UI 让用户选择）
  await client.respondToPermission(session.id, requestId, 'allow_once');
});

// 4. 发送提示词
await client.prompt(session.id, '写一个 Python 脚本打印斐波那契数列');

// 5. 等运行完成后关闭
// await client.closeSession(session.id);
// sse.close();
```

### 使用 Python

```python
import requests
import sseclient  # pip install sseclient-py
import json
import threading

BASE_URL = "http://localhost:3000"
HEADERS = {
    "Authorization": "Bearer your-api-key",
    "Content-Type": "application/json"
}

# 1. 创建会话
session = requests.post(f"{BASE_URL}/sessions", headers=HEADERS, json={
    "agent": "pi",
    "cwd": "/home/agent/workspace"
}).json()
session_id = session["id"]
print(f"会话已创建: {session_id}")

# 2. 在后台线程监听 SSE 事件
def listen_events():
    resp = requests.get(
        f"{BASE_URL}/sessions/{session_id}/events",
        headers={"Authorization": "Bearer your-api-key", "Accept": "text/event-stream"},
        stream=True
    )
    client = sseclient.SSEClient(resp)
    for event in client.events():
        data = json.loads(event.data)
        if event.event == "agent_message_chunk":
            print(data["content"]["text"], end="", flush=True)
        elif event.event == "run_completed":
            print(f"\n运行完成: {data['stopReason']}")
            break

thread = threading.Thread(target=listen_events, daemon=True)
thread.start()

# 3. 发送提示词
requests.post(f"{BASE_URL}/sessions/{session_id}/prompt", headers=HEADERS, json={
    "text": "用 Python 写一个快速排序算法"
})

# 等待完成
thread.join()

# 4. 关闭会话
requests.delete(f"{BASE_URL}/sessions/{session_id}", headers=HEADERS)
```

---

## 权限模式详解

| 模式 | 说明 |
|------|------|
| `approve-all` | 自动批准所有工具调用（默认） |
| `approve-reads` | 自动批准读操作（read、search、think、fetch），写操作需要用户授权 |
| `deny-all` | 拒绝所有工具调用 |
| `delegate` | 所有操作都通过 SSE 发送 `permission_request` 给客户端，由用户决定 |

使用 `delegate` 模式时，客户端需要监听 `permission_request` 事件，并通过 `/sessions/:id/permissions/:reqId/respond` 端点回应。30 秒内未回应将自动拒绝。

---

## 添加 Skills

Skills 是放在工作目录下的智能体专属指令文件。当智能体以 `cwd` 指向该目录启动会话时，会自动发现并使用它们。

```
workspace/
├── .pi/skills/           # Pi 智能体的 Skills
│   ├── my-skill/
│   │   └── instructions.md
│   └── another-skill/
│       └── instructions.md
├── .claude/skills/       # Claude Code 的 Skills
│   └── my-skill/
│       └── instructions.md
├── .codex/skills/        # Codex 的 Skills
│   └── my-skill/
│       └── instructions.md
└── AGENTS.md             # Codex 共享指令
```

每个 Skill 文件夹包含 `instructions.md`，描述智能体应在何时、如何使用该 Skill。同一个 Skill 可以放在多个智能体目录下以供多个智能体使用。

---

## Library API

### CloudRuntime

```typescript
import { CloudRuntime } from 'acp-cloud-runtime';

const runtime = new CloudRuntime({
  agents: { /* AgentDefinition map */ },
  sessionStore: new FileSessionStore('./sessions'),  // 可选，默认 MemorySessionStore
  defaultPermissionMode: 'approve-all',              // 可选
  permissionTimeoutMs: 30_000,                       // 可选
});

// 核心操作
await runtime.createSession({ agent: 'pi', cwd: '/workspace' });
await runtime.promptSession(sessionId, [{ type: 'text', text: 'hello' }]);
await runtime.cancelRun(sessionId);
await runtime.respondToPermission(sessionId, reqId, optionId);
await runtime.closeSession(sessionId);
await runtime.shutdown();

// 查询
runtime.listAgents();
await runtime.listSessions();
await runtime.getSession(sessionId);

// 流式订阅
for await (const event of runtime.subscribeSession(sessionId)) {
  console.log(event.type, event);
}
```

### createServer

```typescript
import { createServer } from 'acp-cloud-runtime';

const app = createServer(runtime, {
  apiKey: 'secret',           // 可选 Bearer 认证
  basePath: '/api/v1',        // 可选路由前缀
  workspace: '/workspace',    // 通过 /config 端点暴露
});
```

返回标准 Hono 应用，可独立使用或挂载为子路由。

### 会话存储

```typescript
import { MemorySessionStore, FileSessionStore } from 'acp-cloud-runtime';

// 内存存储（默认）— 服务重启后会话丢失
new MemorySessionStore()

// 文件存储 — 会话记录持久化到磁盘
new FileSessionStore('./data/sessions')
```

实现 `SessionStore` 接口即可接入自定义后端（Redis、PostgreSQL 等）。

---

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `OPENROUTER_API_KEY` | OpenRouter API Key（Pi 和 Codex 使用） | — |
| `ANTHROPIC_BASE_URL` | Claude 代理的 API 端点 | `https://openrouter.ai/api` |
| `ANTHROPIC_AUTH_TOKEN` | OpenRouter Key（Claude 使用） | — |
| `ANTHROPIC_API_KEY` | Claude 直连 Key（使用 OpenRouter 时设为空） | 空 |
| `ANTHROPIC_DEFAULT_HAIKU_MODEL` | Claude Haiku 模型覆盖 | `moonshotai/kimi-k2.5` |
| `ANTHROPIC_DEFAULT_SONNET_MODEL` | Claude Sonnet 模型覆盖 | `moonshotai/kimi-k2.5` |
| `ANTHROPIC_DEFAULT_OPUS_MODEL` | Claude Opus 模型覆盖 | `moonshotai/kimi-k2.5` |
| `API_KEY` | HTTP API 的 Bearer Token（可选） | 空（不启用认证） |
| `PORT` | HTTP 服务端口 | `3000` |
| `WORKSPACE` | 默认工作目录 | `./workspace` |

所有智能体默认通过 [OpenRouter](https://openrouter.ai/) 路由，使用统一 API Key。默认模型为 `moonshotai/kimi-k2.5`。

---

## Web UI

项目内置了基于 Lit Web Components 的聊天界面（`examples/` 目录），启动服务后打开 http://localhost:3000 即可使用。

### Web UI 组件结构

| 组件 | 说明 |
|------|------|
| `<acp-app>` | 根组件，管理全局状态，协调 REST 客户端与 SSE |
| `<acp-header>` | 顶部栏：状态指示灯、智能体选择、API Key 输入、新建/取消/关闭按钮 |
| `<acp-sidebar>` | 左侧面板：会话列表，显示状态徽标，点击切换 |
| `<acp-chat>` | 消息列表，自动滚动到底部，显示打字指示器 |
| `<acp-message>` | 聊天气泡（用户靠右，智能体靠左），支持 Markdown 渲染和语法高亮 |
| `<acp-input>` | 自动增长的输入框 + 发送按钮（Enter 发送，Shift+Enter 换行） |
| `<acp-thinking>` | 可折叠的思考过程区块 |
| `<acp-tool-call>` | 紧凑的工具调用状态条（琥珀色进行中/绿色完成/红色失败） |
| `<acp-permission>` | 权限请求对话框，提供批准/拒绝按钮 |
| `<acp-system-notice>` | 系统消息（会话创建、运行结束、错误提示） |

### 数据流

```
用户输入 → <acp-input> 触发 send-prompt 事件
→ <acp-app> 监听，调用 client.prompt()
→ 服务器通过 SSE 实时推送事件
→ agent_message_chunk 追加到当前消息文本
→ updated() 渲染 Markdown，高亮代码
→ 自动滚动到底部（用户在底部 80px 内时）
```

---

## 部署

详见 [docs/deployment.md](docs/deployment.md)，包含：

- systemd 服务配置
- nginx 反向代理（SSE 支持配置：`proxy_buffering off`、`proxy_read_timeout`）
- Docker 最佳实践

### 生产环境建议

- **会话存储：** 升级为 `FileSessionStore` 或自定义 Redis/PostgreSQL 后端
- **API Key：** 务必设置 `API_KEY` 环境变量
- **进程限制：** 根据服务器配置调整 `maxActiveSessions` 和 `maxAgentProcesses`
- **健康检查：** `GET /health` 返回 `200 OK`

---

## 错误处理

所有 API 错误返回统一格式：

```json
{ "error": "错误描述信息" }
```

| HTTP 状态码 | 触发条件 |
|-------------|----------|
| `400` | JSON 格式错误或请求参数校验失败 |
| `401` | 缺少或无效的 Bearer Token |
| `404` | 会话/智能体不存在 |
| `409` | 状态冲突（如会话忙碌时再次 prompt、权限请求不存在等） |
| `500` | 服务器内部错误 |

---

## License

Apache-2.0
