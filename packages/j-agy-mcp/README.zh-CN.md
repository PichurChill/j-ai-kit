# j-agy-mcp

[English](./README.md) | 中文

把 **Antigravity CLI(`agy`)** 包装为 MCP 工具的 server,供 **CodeX / Claude Code** 等主代理通过 MCP 协议将探索、检索或编码任务派发给 AGY 作为外部子代理执行。

本 server 不注入任何行为规范——AGY 扮演什么角色(只读探子 / 执行者)完全由调用方的 prompt 与项目规范(如 AGENTS.md)决定。

## 提供的工具

| 工具 | 作用 |
|:---|:---|
| `agy_prompt` | 派发一个自包含任务并等待最终结果。AGY 上下文与主代理独立,任务描述需写明目标、目录与验收方式。返回 `conversation_id` 供续聊 |
| `agy_conversation` | 在已有对话上继续追问或迭代,执行参数与 `agy_prompt` 一致(不会丢失工作目录、模式、模型控制) |
| `agy_models` | 查询当前环境可用的模型列表 |

`agy_prompt` / `agy_conversation` 公共参数:

| 参数 | 默认值 | 说明 |
|:---|:---|:---|
| `cwd` | server 启动目录 | 任务工作目录(绝对路径) |
| `add_dirs` | - | 额外加入工作区的目录 |
| `mode` | `accept-edits` | `accept-edits`(自动应用修改)或 `plan`(仅规划) |
| `model` | `Gemini 3.7 Flash (High)` | 模型名,可用 `agy_models` 查询 |
| `effort` | `high` | 推理强度;模型名已含强度后缀时忽略 |
| `skip_permissions` | `true` | 自动批准所有权限请求 |
| `sandbox` | `true` | 启用终端沙箱 |
| `timeout_seconds` | `300` | 超时秒数(1–3600) |

## 特性

- **并发安全**:每次调用独立日志 `<系统临时目录>/j-agy-mcp/<executionId>.log`,互不覆盖;`latest.log` 软链始终指向最近一次,可 `tail -f` 追踪;并发时 stderr 流式输出带 `[agy:xxxxxx]` 短 ID 前缀
- **结果携带出处**:工具结果元数据包含 `conversation_id`、耗时、turns、tokens 与本次日志路径
- **进度通知**:客户端提供 `progressToken` 时按 MCP `notifications/progress` 推送增量
- **超时兜底**:进程级超时先 SIGTERM、2 秒后升级 SIGKILL;并给 CLI 传 `--print-timeout`(超时 +30s)保证结果不会被 CLI 先行放弃
- **错误可归因**:非零退出、超时、启动失败均携带 stderr 尾部;agy 输出的无法解析行写 stderr 留痕
- **日志清扫**:启动时自动清理超过 7 天的旧日志

## 使用预设:让 j-agy 干不同的活

j-agy 本身不带角色——AGY 干什么,由派发时的任务描述与你的项目规范(如 AGENTS.md)决定。三个常见用法各有完整可直接复制的 AGENTS.md 片段:

- [搜索后端](https://github.com/PichurChill/j-ai-kit/tree/main/packages/j-agy-mcp/docs/preset-search.md) — 自带搜索额度用完、故障、结果不满意或主动要求时,当第二搜索出口(不强制,内置优先)
- [识图后端](https://github.com/PichurChill/j-ai-kit/tree/main/packages/j-agy-mcp/docs/preset-vision.md) — 主模型无多模态、识图故障或失败时的替补(有眼睛先用眼睛)
- [编码子代理](https://github.com/PichurChill/j-ai-kit/tree/main/packages/j-agy-mcp/docs/preset-coding.md) — 内置子代理不可用、需要保护主上下文或主动要求时外包实现(默认自己写)

## 安装与配置

依赖:本机已安装 Antigravity CLI(`agy`)并完成登录。

```json
{
  "mcpServers": {
    "j-agy-mcp": {
      "command": "npx",
      "args": ["j-agy-mcp"]
    }
  }
}
```

CodeX(`~/.codex/config.toml`):

```toml
[mcp_servers.j-agy-mcp]
command = "npx"
args = ["j-agy-mcp"]
```

### 环境变量

| 变量 | 说明 |
|:---|:---|
| `AGY_BIN` | agy 可执行文件完整路径。MCP server 由 GUI 客户端启动时 PATH 常缺少 `~/.local/bin`,此时必须显式指定,例如 `/Users/you/.local/bin/agy` |

### 本地开发

```bash
npm install
npm test        # typecheck + build + vitest(fake agy 覆盖执行器与协议层)
npm run build
node dist/index.js
```

## 安全说明

默认开启 `--dangerously-skip-permissions`(自动批准)+ `--sandbox`(沙箱),与常见「全自动子代理」用法一致;若要收紧,调用时传 `skip_permissions: false` 或 `sandbox: false`,或用 `mode: "plan"` 限制为只规划。未做服务级禁用开关,保持工具面最小。

## 与 @itoseo/agy-mcp 的差异

j-agy-mcp 参考了 [@itoseo/agy-mcp](https://www.npmjs.com/package/@itoseo/agy-mcp) 的行为契约,独立实现(MIT 许可),主要修复:

1. `agy_conversation` 补齐 `cwd` / `mode` / `model` / `effort` / `add_dirs` 等执行参数(原实现续聊时回落到 server 启动目录)
2. 超时 SIGTERM 2 秒后升级 SIGKILL,错误信息携带 stderr 尾部(原实现进程可能残留且超时无法排障)
3. 结果渲染防御式读取,agy 返回结构变化时降级显示而非 TypeError
4. `skip_permissions` / `sandbox` 可按调用关闭;日志目录按系统临时目录解析(跨平台)
5. `mode` 默认值显式传递,与文档一致
6. stderr 进入日志;无法解析的输出行可见;progress 不再携带无意义的 `total: 0`

## License

MIT
