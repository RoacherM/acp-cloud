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

### 1. 提示词 → 响应

```
客户端                   云端运行时                   Agent 进程
  │                         │                           │
  │ POST /sessions/:id/     │                           │
  │      prompt             │                           │
  │────────────────────────>│                           │
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
  │  {optionId: "allow"}    │                           │
  │────────────────────────>│                           │
  │                         │ respond: allow_once        │
  │                         │─────────────────────────>│
  │                         │                           │
  │                         │ (agent 继续执行工具)       │
```

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
  ├── uvx:    command='uvx', args=['run', package, ...args]
  └── binary: 下载 + SHA256 校验 → 缓存路径
  │
  ▼
Agent 安装器 (AgentInstaller)
  ├── 按 OS/arch 匹配二进制包
  ├── 下载到 ~/.acp-cloud-runtime/agents/<id>/<version>/
  └── 校验 SHA256
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
                     │                    ▲                        ▲
                     ▼                    │ run complete           │
                [running]  ───────────────┘                       │
                     │                              respawn +     │
                     │ 进程死亡                    session/load    │
                     ▼                        或 fallback-new     │
                [crashed] ───────────────────────────────────────┘
                     │
                     │ 恢复失败（不可恢复错误 或 strict-load 模式）
                     ▼
                [terminated]
```

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
