# ACP Cloud Runtime — 架构总览

## 定位

ACP 生态的缺失拼图：将任意 ACP Agent（注册表 28+ 个）变为可通过 HTTP/SSE 访问的云端服务。

```
生态角色                项目
─────────────────────────────────────────
协议规范                ACP (agentclientprotocol.com)
协议 SDK               @agentclientprotocol/sdk
Agent 适配器            claude-agent-acp, codex-acp, + 26 原生 agent
IDE 集成                Zed
云端运行时 ←            本项目（缺失拼图）
```

## 三层架构

```
┌─────────────────────────────────────────────────────────────┐
│                    前端 / API 调用方                          │
│              React 应用 · CLI 工具 · 第三方客户端              │
└──────────────────────────┬──────────────────────────────────┘
                           │ HTTP + SSE
┌──────────────────────────┴──────────────────────────────────┐
│  第三层 · HTTP/SSE 服务（可选，基于第二层构建）                  │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐   │
│  │ REST API │ │SSE 推流器│ │ 权限桥接  │ │认证 & 多租户 │   │
│  │ /agents  │ │事件扇出  │ │SSE→POST  │ │  中间件      │   │
│  │/sessions │ │分发      │ │响应      │ │              │   │
│  │ /runs    │ │          │ │          │ │              │   │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘   │
└──────────────────────────┬──────────────────────────────────┘
                           │ CloudRuntime API
┌──────────────────────────┴──────────────────────────────────┐
│  第二层 · 核心 SDK（主要交付物）                               │
│                                                              │
│  ┌────────────────────────┐ ┌────────────────────────────┐  │
│  │       会话管理器        │ │       Agent 进程池          │  │
│  │ 创建·持久化·恢复·取消   │ │ 启动·复用·监控·终止         │  │
│  │ 三层ID: 运行时/ACP/原生 │ │ TTL 保活 · 崩溃检测        │  │
│  │ 恢复: strict/fallback  │ │ 分发解析器 · Agent 安装器   │  │
│  └────────────────────────┘ └────────────────────────────┘  │
│                                                              │
│  ┌──────────────┐ ┌──────────────────┐ ┌──────────────┐    │
│  │   事件总线    │ │    权限控制器     │ │   会话存储    │    │
│  │session/update│ │approve-all       │ │Memory · File │    │
│  │→ RunEvent    │ │approve-reads     │ │Postgres      │    │
│  │1:1 ACP 映射  │ │deny-all          │ │可插拔接口     │    │
│  │              │ │非交互: deny|fail  │ │              │    │
│  └──────────────┘ └──────────────────┘ └──────────────┘    │
└──────────────────────────┬──────────────────────────────────┘
                           │ ClientSideConnection
┌──────────────────────────┴──────────────────────────────────┐
│  第一层 · @agentclientprotocol/sdk（直接依赖，不修改）         │
│  ┌──────────────────┐ ┌────────────┐ ┌──────────────────┐  │
│  │ClientSideConn.   │ │ndJsonStream│ │   协议类型定义     │  │
│  │JSON-RPC 双向通信  │ │stdio↔NDJSON│ │SessionUpdate etc.│  │
│  └──────────────────┘ └────────────┘ └──────────────────┘  │
└──────────────────────────┬──────────────────────────────────┘
                           │ stdio（stdin/stdout NDJSON）
┌──────────────────────────┴──────────────────────────────────┐
│  ACP Agent 进程（注册表 28+ 个，原样启动无需修改）              │
│                                                              │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐              │
│  │ Claude │ │ Codex  │ │ Gemini │ │Copilot │              │
│  │适配器  │ │适配器  │ │原生ACP │ │原生ACP │              │
│  └────────┘ └────────┘ └────────┘ └────────┘              │
│  ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐              │
│  │ Goose  │ │ Cline  │ │ Cursor │ │+20 更多│              │
│  │原生    │ │原生    │ │原生    │ │注册表  │              │
│  └────────┘ └────────┘ └────────┘ └────────┘              │
└─────────────────────────────────────────────────────────────┘
```

## 资源模型

对标 LangGraph Platform 的资源抽象：

```
ACP Cloud Runtime     LangGraph Platform    说明
─────────────────────────────────────────────────────
Agent                 Assistant             注册表中的 agent 类型
Session               Thread                持久化对话会话，绑定一个 agent 进程
Run                   Run                   一次 prompt → response 生命周期
Event                 Stream event          细粒度 SSE 事件（1:1 ACP session/update）
```

## 关键数据流

### 0. 并发模型

#### 部署约束：单实例

当前版本仅单实例部署。不做跨实例 session 迁移、分布式锁或 shared-nothing 集群。

```
总吞吐 = min(活跃会话并行数, maxAgentProcesses, 主机 CPU/内存瓶颈)
```

#### 全局资源上限

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `maxAgentProcesses` | 20 | 最大并发 agent 进程数（running + ready） |
| `maxActiveSessions` | 50 | 最大非终止状态 session 数（含 sleeping） |
| `sessionTTL` | 300s | 空闲 → sleeping |
| `sleepTTL` | 24h | sleeping → terminated |
| `maxQueueDepth` | 8 | 单 session prompt 队列上限 |

#### 资源回收优先级

达到 `maxAgentProcesses` 上限时：

```
回收优先级（最先回收）:
  1. sleeping 状态，按空闲时长倒序（最久未用的先回收）
  2. ready 状态，按空闲时长倒序（kill 进程 → 转为 sleeping）
  ✗ 绝不回收：running / waking / recovering / creating / initializing
```

回收 sleeping session 只释放进程槽，记录保留，后续仍可 waking 恢复。
无可回收 session 时拒绝新建（`503 Service Unavailable`）。

#### 每 Session 串行，Session 间并行

**核心约束：一个 Session 同一时刻只有一个活跃 Run。**

这是 ACP 协议的固有语义 —— `session/prompt` 是 request-response 对，agent 必须响应后才算 turn 结束。acpx、codex-acp、claude-agent-acp 均遵循此模型。

**不同 Session 完全并行。** Session A 的 run 不阻塞 Session B。每个 Session 有独立的 agent 进程和 `ClientSideConnection`。

```
客户端 A                  云端运行时（串行队列）             Agent
  │                           │                              │
  │ POST prompt "修复登录"     │                              │
  │──────────────────────────>│ enqueue → 队列为空 → 立即执行  │
  │                           │ session/prompt ──────────────>│
  │  SSE: 事件流...           │<─────────────────────────────│
  │<──────────────────────────│                              │
  │                           │                              │
客户端 B                      │                              │
  │ POST prompt "加个功能"     │                              │
  │──────────────────────────>│ enqueue → 队列非空 → 排队等待  │
  │  202 Accepted (queued)    │                              │
  │<──────────────────────────│                              │
  │                           │                              │
  │                           │ run_complete (修复登录)       │
  │                           │<─────────────────────────────│
  │                           │                              │
  │                           │ 出队 → 执行下一个             │
  │                           │ session/prompt ──────────────>│
  │  SSE: 事件流...           │<─────────────────────────────│
  │<──────────────────────────│                              │
```

**规则：**
- 队列深度上限：可配置（默认 8），超限返回 `429 Too Many Requests`
- `POST /cancel` 作用于**当前活跃 run**（发送 ACP `session/cancel`）
- 队列中的待执行 prompt 可通过 `DELETE /sessions/:id/queue/:runId` 移除
- 客户端断开 SSE 不影响 run 执行（run 继续完成，结果写入 session 历史）

---

### 1. 提示词 → 响应

```
客户端                   云端运行时                   Agent 进程
  │                         │                           │
  │ POST /sessions/:id/     │                           │
  │      prompt             │                           │
  │────────────────────────>│ 入队 → 队列空 → 立即执行   │
  │                         │ session/prompt             │
  │                         │─────────────────────────>│
  │                         │                           │
  │                         │ session/update             │
  │                         │  (agent_message_chunk)     │
  │  SSE: agent_message_    │<─────────────────────────│
  │       chunk             │                           │
  │<────────────────────────│ session/update             │
  │                         │  (tool_call)               │
  │  SSE: tool_call         │<─────────────────────────│
  │<────────────────────────│                           │
  │                         │ session/update             │
  │  SSE: tool_call_update  │  (tool_call_update)        │
  │<────────────────────────│<─────────────────────────│
  │                         │                           │
  │  SSE: run_complete      │ prompt response            │
  │<────────────────────────│<─────────────────────────│
```

### 2. 权限请求（approve-reads 模式下写操作）

```
客户端                   云端运行时                   Agent 进程
  │                         │                           │
  │                         │ requestPermission          │
  │                         │  (kind: edit)              │
  │                         │<─────────────────────────│
  │                         │                           │
  │                         │ 权限控制器检查:             │
  │                         │  mode=approve-reads        │
  │                         │  kind=edit → 需要委托      │
  │                         │                           │
  │  SSE: permission_       │                           │
  │       request           │                           │
  │<────────────────────────│                           │
  │                         │                           │
  │ POST /permissions/      │                           │
  │      :reqId             │                           │
  │  {optionId: "opt_3a7x"} │  ← opaque token，原样     │
  │────────────────────────>│    回传 agent 下发的 ID    │
  │                         │                           │
  │                         │ respond(optionId)          │
  │                         │─────────────────────────>│
  │                         │                           │
  │                         │ (agent 继续执行工具)       │
```

**重要：** `optionId` 是 agent 下发的 opaque token，客户端必须原样回传，不做本地语义推断。
每个 agent 的 option ID 格式和含义可能不同 —— 语义信息在 `option.name` 和 `option.kind` 中，
但最终响应只需要传 `optionId` 字符串。

### 3. 崩溃恢复

```
云端运行时                              Agent 进程
  │                                       │
  │  检测到进程死亡 (exit/signal)           │ ✗
  │                                       │
  │  session.status = 'recovering'        │
  │  重新 spawn agent 进程                 │
  │───────────────────────────────────────>│ (新进程)
  │                                       │
  │  session/load(acpSessionId,           │
  │              cwd, mcpServers)          │
  │───────────────────────────────────────>│
  │                                       │
  │  ┌─ 成功: status = 'ready'            │
  │  │  (agent 回放历史)                   │
  │  │                                    │
  │  └─ 失败 + recoveryPolicy=fallback:   │
  │     session/new(cwd, mcpServers)       │
  │────────────────────────────────────── >│
  │     更新 acpSessionId                  │
  │     status = 'ready'（丢失历史）        │
```

### 4. Agent 发现与启动

```
GET /agents
  │
  ▼
注册表拉取 (cdn.agentclientprotocol.com/registry/v1/latest/registry.json)
  │
  ▼
分发解析器 (DistributionResolver)
  ├── npx:    command='npx', args=['-y', package, ...args]
  │           （npm registry 提供内置完整性校验）
  ├── uvx:    command='uvx', args=[package, ...args]
  │           （命令模板可配置，不硬编码子命令）
  └── binary: HTTPS 下载 → 可选 checksum 校验 → 缓存路径
  │
  ▼
Agent 安装器 (AgentInstaller)
  ├── 按 OS/arch 匹配二进制包
  ├── 下载到 ~/.acp-cloud-runtime/agents/<id>/<version>/
  └── 校验策略：
      ├── 优先：registry 提供 checksum 时做 SHA256 校验
      ├── 回退：registry 无 checksum（当前现状）→ 信任 HTTPS transport
      └── 可选：配置 trusted mirror 或 sidecar checksums 文件
  │
  ▼
child_process.spawn(command, args)
  │
  ▼
ClientSideConnection + ndJsonStream
  │
  ▼
initialize → session/new → 就绪
```

## 会话状态机

```
                      spawn agent
    [creating] ──────────────────────► [initializing]
                                            │
                                     initialize + session/new
                                            │
                                            ▼
                   prompt              [ready] ◄───────────── [recovering]
                     │                    ▲  ▲                      ▲
                     ▼                    │  │ spawn + session/load  │
                [running]  ───────────────┘  │                      │
                     │         run complete   │                     │
                     │                   [waking]                   │
                     │                       ▲                      │
                     │                       │ 收到新 prompt         │
                     │                       │                      │
                     │                  [sleeping]                  │
                     │                       ▲                      │
                     │                       │ TTL 到期              │
                     │                       │ (进程回收,记录保留)    │
                     │                       │                      │
                     │              [ready] ─┘                      │
                     │                                              │
                     │ 进程死亡（非预期）              respawn +     │
                     ▼                           session/load       │
                [crashed] ─────────────────── 或 fallback-new ─────┘
                     │
                     │ 恢复失败（不可恢复错误 或 strict-load 模式）
                     ▼
                [terminated]
```

**状态说明：**

| 状态 | 进程存活 | 记录保留 | 说明 |
|------|---------|---------|------|
| creating | 启动中 | 是 | spawn 进程 |
| initializing | 是 | 是 | ACP initialize + session/new |
| ready | 是 | 是 | 空闲，可接受 prompt |
| running | 是 | 是 | 正在执行 prompt turn |
| sleeping | **否** | 是 | TTL 到期后进程已回收，仅保留记录 |
| waking | 启动中 | 是 | 收到新 prompt，重新 spawn + session/load |
| crashed | 否 | 是 | 非预期死亡，等待恢复 |
| recovering | 启动中 | 是 | respawn + session/load 或 fallback-new |
| terminated | 否 | 归档 | 不可恢复，或用户主动关闭 |

**TTL 与休眠策略：**
- `ready` 状态空闲超过 `sessionTTL`（默认 300s，对齐 acpx）→ 进入 `sleeping`
- `sleeping` 时进程已被 kill，SessionRecord 保留（含 acpSessionId）
- 新 prompt 到达 sleeping session → `waking` → spawn + session/load → `ready` → 执行
- `waking` 与 `recovering` 共享恢复路径，区别仅在触发原因（预期 vs 非预期）
- sleeping session 超过 `sleepTTL`（可配置，默认 24h）→ `terminated`

## 三层会话 ID 模型

```
┌─────────────────────────────────────────────────────────┐
│  id (运行时记录 ID)                                      │
│  ├── 我们生成的 UUID                                     │
│  ├── 在 SessionStore 中持久化                            │
│  └── 跨 crash recovery 稳定不变                          │
│                                                          │
│  acpSessionId (ACP 协议会话 ID)                          │
│  ├── 从 session/new 响应获取                             │
│  ├── 用于 session/load、session/prompt 等协议调用         │
│  └── fallback-new 恢复后会变更                           │
│                                                          │
│  agentSessionId (Agent 原生会话 ID)                      │
│  ├── Agent 内部标识（如 Claude SDK session、Codex thread）│
│  ├── 可能与 acpSessionId 不同                            │
│  └── 用于 agent 自身的会话持久化                          │
└─────────────────────────────────────────────────────────┘
```

## 分发形态

核心价值：**部署我们的 server，用户通过标准 HTTP/SSE 访问后端 agent。**

```
部署方式                    命令                              适用场景
──────────────────────────────────────────────────────────────────────
npx acp-cloud start         一行命令                          本地开发、快速验证
docker compose up            容器化                            生产部署
createServer(runtime)        编程方式                          嵌入已有 Node 服务
new CloudRuntime(config)     纯 SDK                           自定义服务框架
CloudClient + React hooks    前端消费                          Web 应用集成
```

```
用户/前端  ──HTTP/SSE──►  acp-cloud server  ──stdio/ACP──►  Agent 进程
                          (我们的交付物)                     (Claude/Codex/Gemini...)
```

用户不需要了解 ACP 协议，不需要管理 agent 进程。只需调用标准 HTTP API。

**边界：** 当前版本仅单实例，不做跨实例 session 迁移或分布式锁。

## 设计原则

| # | 原则 | 说明 |
|---|------|------|
| 1 | **ACP 原生** | 直接使用协议，不发明新抽象 |
| 2 | **不造轮子** | 依赖 @agentclientprotocol/sdk，读注册表，原样启动 agent |
| 3 | **库优先** | 可导入的 SDK（第二层），HTTP 服务可选（第三层） |
| 4 | **Agent 无关** | 任何 ACP-speaking agent 零代码接入 |
| 5 | **细粒度推流** | 每个 ACP session/update 事件都透传到客户端 |
| 6 | **社区对齐** | 跟踪 ACP 规范演进，为 Proxy Chains 兼容预留设计 |
| 7 | **与 acpx 行为一致** | 权限命名、恢复策略、非交互策略均对齐 acpx |
