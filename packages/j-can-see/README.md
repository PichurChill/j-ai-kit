# j-can-see

English | [中文文档](./README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/j-can-see)](https://www.npmjs.com/package/j-can-see)
[![npm downloads](https://img.shields.io/npm/dm/j-can-see)](https://www.npmjs.com/package/j-can-see)
[![license: MIT](https://img.shields.io/npm/l/j-can-see)](https://www.npmjs.com/package/j-can-see)

An MCP server that gives text-only AI coding agents a vision toolkit: describe/OCR images, locate elements by pixel coordinates, diff images, pick exact colors, and vectorize graphics.

## Why

Text-only models cannot read image files. `j-can-see` exposes vision as normal MCP tools, so Claude Code, Codex, and other MCP clients can work with local files, URLs, clipboard images, and screenshots without multimodal input support.

## Requirements

- Node.js >= 20
- No installation required; the commands below run the published npm package via `npx`

## Claude Code

### One command (recommended)

```bash
claude mcp add j-can-see -s user \
    -e J_SEE_TOKEN='your-key' \
    -e J_SEE_BASE_URL='https://your-vision-endpoint' \
    -e J_SEE_MODEL='grok-4.5' \
    -- npx -y j-can-see
```

`-s user` writes to the user-level config, outside any git repository.

### Manual

Add this to the `mcpServers` section of `~/.claude.json` (macOS/Linux) or `%USERPROFILE%\.claude.json` (Windows):

```jsonc
"j-can-see": {
  "command": "npx",
  "args": ["-y", "j-can-see"],
  "env": {
    "J_SEE_TOKEN": "your-key",
    "J_SEE_BASE_URL": "https://your-vision-endpoint",
    "J_SEE_MODEL": "grok-4.5"
  }
}
```

## Codex

### One command (recommended)

```bash
codex mcp add j-can-see \
    --env J_SEE_TOKEN='your-key' \
    --env J_SEE_BASE_URL='https://your-vision-endpoint' \
    --env J_SEE_MODEL='grok-4.5' \
    -- npx -y j-can-see
```

### Manual

Add this to `~/.codex/config.toml` (macOS/Linux) or `%USERPROFILE%\.codex\config.toml` (Windows):

```toml
[mcp_servers.j-can-see]
type = "stdio"
command = "npx"
args = ["-y", "j-can-see"]

[mcp_servers.j-can-see.env]
J_SEE_TOKEN = "your-key"
J_SEE_BASE_URL = "https://your-vision-endpoint"
J_SEE_MODEL = "grok-4.5"
```

## Config file locations

| Client | macOS / Linux | Windows |
|---|---|---|
| Claude Code MCP | `~/.claude.json` | `%USERPROFILE%\.claude.json` |
| Claude Code hooks/settings | `~/.claude/settings.json` | `%USERPROFILE%\.claude\settings.json` |
| Codex MCP | `~/.codex/config.toml` | `%USERPROFILE%\.codex\config.toml` |

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `J_SEE_TOKEN` | Yes | - | Vision model API key |
| `J_SEE_BASE_URL` | Yes | - | Vision endpoint base URL; trailing slashes are stripped |
| `J_SEE_MODEL` | Yes | - | Vision model name supported by your endpoint |
| `J_SEE_API_SPEC` | No | `responses` | `responses` / `openai` / `anthropic` |
| `J_SEE_REASONING` | No | `none` | Reasoning effort; only used by the `openai` spec |
| `J_SEE_MAX_EDGE` | No | `1568` | Max long-edge pixels for image compression |
| `J_SEE_MAX_BYTES` | No | `52428800` | Max source file size in bytes |
| `J_SEE_MAX_PIXELS` | No | `40000000` | Max decoded pixels, checked from the header before decode |
| `J_SEE_TIMEOUT_MS` | No | `90000` | Total budget per vision tool call in ms (incl. queueing and retries); timeouts auto-retry at lower resolution with a note in the result |
| `J_SEE_OCR_TOTAL_TIMEOUT_MS` | No | `85000` | Total budget for multi-chunk `ocr_long` in ms; returns partial results when exhausted |
| `J_SEE_MAX_CONCURRENT` | No | `3` | Global vision concurrency cap (1-8); auto-demotes on 429/5xx/timeout, probes back up on new calls |
| `J_SEE_MAX_ATTEMPTS` | No | `3` | Max attempts per vision call (first try + retries) |
| `J_SEE_TASK_BUDGET_MS` | No | `85000` | Total budget for `see_image` each-batch mode in ms; returns partial results + resume params when exhausted |
| `J_SEE_SKILL_AUTO_INSTALL` | No | `1` | Set to `0` to disable automatic skill installation |

The server still starts without `J_SEE_TOKEN` / `J_SEE_BASE_URL` / `J_SEE_MODEL`: local pixel tools keep working, and vision tools return a clear config error when called.

## API spec

| `J_SEE_API_SPEC` | Endpoint | Use case |
|---|---|---|
| `responses` (default) | `/v1/responses` | OpenAI Responses, aligned with GPT-5 / Codex ecosystem |
| `openai` | `/v1/chat/completions` | OpenAI Chat Completions and OpenAI-compatible proxies |
| `anthropic` | `/v1/messages` | Anthropic native API, no proxy needed |

If your endpoint returns 404 for `/v1/responses`, set `J_SEE_API_SPEC=openai`. To call Anthropic directly:

```bash
claude mcp add j-can-see -s user \
    -e J_SEE_API_SPEC='anthropic' \
    -e J_SEE_TOKEN='sk-ant-...' \
    -e J_SEE_BASE_URL='https://api.anthropic.com' \
    -e J_SEE_MODEL='claude-sonnet-4-5' \
    -- npx -y j-can-see
```

## Tools

### Vision tools

| Tool | Purpose |
|---|---|
| `see_image` | Describe or compare images, zoom into regions |
| `locate` | Find one target and return its pixel coordinates |
| `inspect` | Enumerate all elements of one type with text and coordinates |
| `ocr_long` | OCR tall screenshots in chunks, merged with a dedup audit |

### Local tools (no vision config needed)

| Tool | Purpose |
|---|---|
| `crop` | Crop a region to a file |
| `image_diff` | Pixel diff percentage and densest changed grid cells |
| `colors` | Exact dominant or candidate colors |
| `trace` | Vectorize flat high-contrast graphics to SVG |
| `extract_fg` | Cut a foreground icon into a transparent PNG |

Detailed usage methodology: [SKILL.md](./SKILL.md).

## Agent skill

The server auto-installs `SKILL.md` into `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, and `~/.zcode/skills` on every start, unless `J_SEE_SKILL_AUTO_INSTALL=0` is set.

```bash
npx j-can-see --skill        # install the skill manually
npx j-can-see --print-skill  # print SKILL.md contents
npx j-can-see --hook         # print the Claude Code hook script
```

## Optional: Claude Code hook

Without the hook, a text-only model may try to `Read` an image file and fail. The hook redirects `Read` calls on image files to `see_image`:

```bash
mkdir -p ~/.claude/hooks
npx j-can-see --hook > ~/.claude/hooks/block-image-read.mjs
chmod +x ~/.claude/hooks/block-image-read.mjs
```

Then add this to `~/.claude/settings.json` (`%USERPROFILE%\.claude\settings.json` on Windows):

```jsonc
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.claude/hooks/block-image-read.mjs"
          }
        ]
      }
    ]
  }
}
```

## Limitations

- Linux clipboard is not supported; use a file path instead
- Transparent PNGs are converted to JPEG
- No retries or fallback: vision failures are reported as-is

## Development

```bash
npm install
npm test
npm run build
```
