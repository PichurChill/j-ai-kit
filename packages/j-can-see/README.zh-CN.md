# j-can-see

[English](./README.md) | 中文

[![npm version](https://img.shields.io/npm/v/j-can-see)](https://www.npmjs.com/package/j-can-see)
[![npm downloads](https://img.shields.io/npm/dm/j-can-see)](https://www.npmjs.com/package/j-can-see)
[![license: MIT](https://img.shields.io/npm/l/j-can-see)](https://www.npmjs.com/package/j-can-see)

一个 MCP server，让纯文本 AI 编程客户端获得视觉能力：描述/OCR 图片、定位元素像素坐标、图片对比、取色、矢量化和抠图。

## 为什么需要

主模型不支持图片输入时，直接读图会在 API 层失败。`j-can-see` 把识图变成普通 MCP 工具调用，Claude Code、Codex 等客户端就能处理本地文件、URL、剪贴板图片和截图。

## 环境要求

- Node.js >= 20
- 无需安装，直接通过 `npx` 运行发布包

## Claude Code

### 一行命令（推荐）

```bash
claude mcp add j-can-see -s user \
    -e J_SEE_TOKEN='你的key' \
    -e J_SEE_BASE_URL='https://你的视觉端点' \
    -e J_SEE_MODEL='grok-4.5' \
    -- npx -y j-can-see
```

`-s user` 写入用户级配置，配置在 git 仓库之外。

### 手动配置

在 `~/.claude.json`（macOS/Linux）或 `%USERPROFILE%\.claude.json`（Windows）的 `mcpServers` 下添加：

```jsonc
"j-can-see": {
  "command": "npx",
  "args": ["-y", "j-can-see"],
  "env": {
    "J_SEE_TOKEN": "你的key",
    "J_SEE_BASE_URL": "https://你的视觉端点",
    "J_SEE_MODEL": "grok-4.5"
  }
}
```

## Codex

### 一行命令（推荐）

```bash
codex mcp add j-can-see \
    --env J_SEE_TOKEN='你的key' \
    --env J_SEE_BASE_URL='https://你的视觉端点' \
    --env J_SEE_MODEL='grok-4.5' \
    -- npx -y j-can-see
```

### 手动配置

在 `~/.codex/config.toml`（macOS/Linux）或 `%USERPROFILE%\.codex\config.toml`（Windows）中添加：

```toml
[mcp_servers.j-can-see]
type = "stdio"
command = "npx"
args = ["-y", "j-can-see"]

[mcp_servers.j-can-see.env]
J_SEE_TOKEN = "你的key"
J_SEE_BASE_URL = "https://你的视觉端点"
J_SEE_MODEL = "grok-4.5"
```

## 配置文件位置

| 客户端 | macOS / Linux | Windows |
|---|---|---|
| Claude Code MCP | `~/.claude.json` | `%USERPROFILE%\.claude.json` |
| Claude Code Hook 设置 | `~/.claude/settings.json` | `%USERPROFILE%\.claude\settings.json` |
| Codex MCP | `~/.codex/config.toml` | `%USERPROFILE%\.codex\config.toml` |

## 环境变量

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `J_SEE_TOKEN` | 是 | - | 视觉模型 API key |
| `J_SEE_BASE_URL` | 是 | - | 视觉模型端点根地址；末尾斜杠自动去除 |
| `J_SEE_MODEL` | 是 | - | 你的端点实际支持的视觉模型名 |
| `J_SEE_API_SPEC` | 否 | `responses` | `responses` / `openai` / `anthropic` |
| `J_SEE_REASONING` | 否 | `none` | 推理强度；仅 `openai` 规范生效 |
| `J_SEE_MAX_EDGE` | 否 | `1568` | 图片压缩长边像素上限 |
| `J_SEE_MAX_BYTES` | 否 | `52428800` | 源文件体积上限（字节） |
| `J_SEE_MAX_PIXELS` | 否 | `40000000` | 解码后像素数上限，解码前从图片头校验 |
| `J_SEE_TIMEOUT_MS` | 否 | `90000` | 单次视觉工具调用的总预算（毫秒，含排队与重试）；超时会自动降质重试并在结果中注明 |
| `J_SEE_OCR_TOTAL_TIMEOUT_MS` | 否 | `85000` | `ocr_long` 多块总预算（毫秒）；耗尽时返回已完成的部分 |
| `J_SEE_MAX_CONCURRENT` | 否 | `3` | 全局视觉并发上限（1-8）；429/5xx/超时自动降档，新调用自动试探回升 |
| `J_SEE_MAX_ATTEMPTS` | 否 | `3` | 单次视觉调用的总尝试上限（首发 + 重试） |
| `J_SEE_TASK_BUDGET_MS` | 否 | `85000` | `see_image` each 批量模式总预算（毫秒）；耗尽时返回部分结果 + 续调参数 |
| `J_SEE_SKILL_AUTO_INSTALL` | 否 | `1` | 设为 `0` 关闭自动安装 skill |

缺 `J_SEE_TOKEN` / `J_SEE_BASE_URL` / `J_SEE_MODEL` 不影响 server 启动：本地像素工具照常可用，视觉工具被调用时返回清晰的配置错误。

## API 规范

| `J_SEE_API_SPEC` | 端点 | 适用场景 |
|---|---|---|
| `responses`（默认） | `/v1/responses` | OpenAI Responses，与 GPT-5 / Codex 生态对齐 |
| `openai` | `/v1/chat/completions` | OpenAI Chat Completions 及兼容代理 |
| `anthropic` | `/v1/messages` | Anthropic 原生 API，无需代理 |

如果端点不支持 `/v1/responses`（返回 404），设 `J_SEE_API_SPEC=openai`。直连 Claude：

```bash
claude mcp add j-can-see -s user \
    -e J_SEE_API_SPEC='anthropic' \
    -e J_SEE_TOKEN='sk-ant-...' \
    -e J_SEE_BASE_URL='https://api.anthropic.com' \
    -e J_SEE_MODEL='claude-sonnet-4-5' \
    -- npx -y j-can-see
```

## 工具集

### 视觉工具

| 工具 | 用途 |
|---|---|
| `see_image` | 描述或对比图片，支持局部放大 |
| `locate` | 定位单个目标并返回像素坐标 |
| `inspect` | 枚举同类元素，返回编号、文字和坐标 |
| `ocr_long` | 超长截图分块 OCR，合并并做去重审计 |

### 本地工具（无需视觉配置）

| 工具 | 用途 |
|---|---|
| `crop` | 把区域裁成文件 |
| `image_diff` | 像素差异比例和差异最密集的网格块 |
| `colors` | 精确主色或候选色 |
| `trace` | 把扁平高对比图形矢量化成 SVG |
| `extract_fg` | 把前景图标抠成透明 PNG |

详细使用方法见 [SKILL.md](./SKILL.md)。

## Agent Skill

server 每次启动会自动把 `SKILL.md` 安装到 `~/.claude/skills`、`~/.codex/skills`、`~/.agents/skills` 和 `~/.zcode/skills`，除非设置 `J_SEE_SKILL_AUTO_INSTALL=0`。

```bash
npx j-can-see --skill        # 手动安装 skill
npx j-can-see --print-skill  # 打印 SKILL.md 内容
npx j-can-see --hook         # 输出 Claude Code hook 脚本
```

## 可选：Claude Code Hook

不配置 hook 时，纯文本模型看到图片路径可能会尝试 `Read` 然后失败。hook 会拦截对图片文件的 `Read` 调用并引导到 `see_image`：

```bash
mkdir -p ~/.claude/hooks
npx j-can-see --hook > ~/.claude/hooks/block-image-read.mjs
chmod +x ~/.claude/hooks/block-image-read.mjs
```

然后写入 `~/.claude/settings.json`（Windows 为 `%USERPROFILE%\.claude\settings.json`）：

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

## 限制

- Linux 不支持剪贴板，请改用文件路径
- 透明 PNG 会转为 JPEG
- 不重试、不降级：视觉调用失败原样上报

## 开发

```bash
npm install
npm test
npm run build
```
