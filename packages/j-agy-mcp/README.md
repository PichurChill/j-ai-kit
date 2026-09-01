# j-agy-mcp

English | [中文文档](./README.zh-CN.md)

An MCP server that wraps the **Antigravity CLI (`agy`)** as tools, letting **CodeX / Claude Code** and other MCP clients dispatch exploration, retrieval, or coding tasks to AGY as an external subagent.

The server itself injects no behavior — what role AGY plays (read-only scout or executor) is entirely decided by the caller's prompt and project conventions (e.g. AGENTS.md).

## Tools

| Tool | Purpose |
|:---|:---|
| `agy_prompt` | Dispatch a self-contained task and wait for the final result. AGY's context is independent from the main agent, so the task description must state the goal, directories, and acceptance criteria. Returns a `conversation_id` for follow-ups |
| `agy_conversation` | Continue an existing conversation. Execution parameters are identical to `agy_prompt` (cwd, mode, model control are not lost) |
| `agy_models` | List models available in the current environment |

Parameters shared by `agy_prompt` / `agy_conversation`:

| Parameter | Default | Description |
|:---|:---|:---|
| `cwd` | server start directory | Working directory for the task (absolute path) |
| `add_dirs` | - | Extra directories to add to the workspace |
| `mode` | `accept-edits` | `accept-edits` (apply edits automatically) or `plan` (planning only) |
| `model` | `Gemini 3.7 Flash (High)` | Model name; query with `agy_models` |
| `effort` | `high` | Reasoning effort; ignored when the model name already carries an effort suffix |
| `skip_permissions` | `true` | Auto-approve all permission requests |
| `sandbox` | `true` | Enable the terminal sandbox |
| `timeout_seconds` | `300` | Timeout in seconds (1–3600) |

## Features

- **Concurrency-safe**: each call writes its own log at `<os tmpdir>/j-agy-mcp/<executionId>.log`; a `latest.log` symlink always points to the most recent run (`tail -f` friendly); concurrent stderr output is prefixed with a short id like `[agy:xxxxxx]`
- **Traceable results**: tool results carry `conversation_id`, duration, turns, tokens, and the log path of that exact run
- **Progress notifications**: pushes `notifications/progress` increments when the client supplies a `progressToken`
- **Timeout hardening**: process-level timeout sends SIGTERM, escalating to SIGKILL after 2s; the CLI also gets `--print-timeout` (timeout + 30s) so the CLI never gives up before we do
- **Attributable errors**: non-zero exits, timeouts, and launch failures all include the stderr tail; unparseable agy output lines are logged instead of silently dropped
- **Log hygiene**: logs older than 7 days are swept at startup

## Usage presets

j-agy ships no role of its own — what AGY does is decided by the task prompt and your project conventions (e.g. AGENTS.md). Three common setups each come with a ready-to-copy AGENTS.md snippet (docs in Chinese):

- [Search backend](https://github.com/PichurChill/j-ai-kit/tree/main/packages/j-agy-mcp/docs/en/preset-search.md) — a second search outlet when built-in search is out of quota, broken, or unsatisfying; built-in first, never forced
- [Vision backend](https://github.com/PichurChill/j-ai-kit/tree/main/packages/j-agy-mcp/docs/en/preset-vision.md) — a fallback when the main model has no multimodal input or image reading fails; use your own eyes first
- [Coding subagent](https://github.com/PichurChill/j-ai-kit/tree/main/packages/j-agy-mcp/docs/en/preset-coding.md) — outsource implementation when built-in subagents are unavailable or the main context needs protection; the main agent writes code by default

## Install & Configure

Prerequisite: the Antigravity CLI (`agy`) is installed and signed in on your machine.

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

CodeX (`~/.codex/config.toml`):

```toml
[mcp_servers.j-agy-mcp]
command = "npx"
args = ["j-agy-mcp"]
```

### Environment variables

| Variable | Description |
|:---|:---|
| `AGY_BIN` | Full path to the `agy` executable. When an MCP server is launched by a GUI client, `PATH` often lacks `~/.local/bin`; set this explicitly in that case, e.g. `/Users/you/.local/bin/agy` |

### Local development

```bash
npm install
npm test        # typecheck + build + vitest (fake agy covers the executor and protocol layers)
npm run build
node dist/index.js
```

## Security notes

`--dangerously-skip-permissions` (auto-approve) and `--sandbox` are enabled by default, matching the common "fully automatic subagent" setup. To tighten it, pass `skip_permissions: false` or `sandbox: false` per call, or use `mode: "plan"` for planning-only runs. There is deliberately no server-level kill switch — the tool surface stays minimal.

## Differences from @itoseo/agy-mcp

j-agy-mcp follows the behavioral contract of [@itoseo/agy-mcp](https://www.npmjs.com/package/@itoseo/agy-mcp) but is an independent MIT-licensed implementation, with these fixes:

1. `agy_conversation` now accepts the full execution parameter set (`cwd` / `mode` / `model` / `effort` / `add_dirs`; the original fell back to the server's start directory)
2. Timeout escalates SIGTERM → SIGKILL after 2s, and error messages carry the stderr tail (the original could leave processes behind and gave nothing to debug timeouts with)
3. Result rendering reads fields defensively — a changed agy response shape degrades the display instead of throwing TypeError
4. `skip_permissions` / `sandbox` can be disabled per call; the log directory resolves to the OS temp dir (cross-platform)
5. The `mode` default is passed explicitly, matching the docs
6. stderr goes into the log; unparseable output lines are visible; progress no longer carries a meaningless `total: 0`

## License

MIT
