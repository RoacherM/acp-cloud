# ACP Cloud Runtime — FAQ

## 为什么不直接对接 Pi 的 RPC 协议？

Pi agent 支持 `--mode rpc`，通过 stdin/stdout JSONL 通信。但 Pi RPC 和 ACP 是**完全不同的协议**：

| | Pi RPC (`--mode rpc`) | ACP |
|---|---|---|
| 帧格式 | JSONL | NDJSON JSON-RPC 2.0 |
| 发 prompt | `{"type":"prompt","message":"..."}` | `session/prompt` JSON-RPC request |
| 事件流 | `message_update`, `tool_execution_*`, `agent_end` | `session/update` notification |
| 权限控制 | 无 | `session/request_permission` |
| 会话管理 | `new_session`, `switch_session`, `fork` | `session/new`, `session/load` |

`pi-acp`（ACP 注册表中的官方 adapter）已经做了 Pi RPC → ACP 的完整翻译：

```
Runtime ──ACP──► pi-acp ──Pi RPC──► pi --mode rpc
```

如果我们直接对接 Pi RPC，等于为一个 agent 多维护一套协议适配。而 ACP 注册表有 28+ 个 agent 都说 ACP，只需要一套协议就能全部覆盖。

**结论：** 使用 pi-acp 是正确选择。我们只说 ACP 一种协议，Pi 特有功能（thinking level、fork、compaction 等）由 pi-acp 处理，不是 runtime 的职责。

**验证记录：** 2026-03-26 通过 `pi-acp v0.0.23` 成功完成了完整的 ACP 调用链路（initialize → session/new → session/prompt → 流式事件 → end_turn），确认可用。
