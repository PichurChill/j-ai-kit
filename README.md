# j-ai-kit

PichurChill's AI toolkit monorepo — MCP servers, skills, and other small AI helpers. Every package under `packages/` is an independent npm package with its own version and changelog; publish them separately from their directories.

English | 中文说明见各包内的 `README.zh-CN.md`。

## Packages

| Package | npm | Description |
|:---|:---|:---|
| [`packages/j-agy-mcp`](./packages/j-agy-mcp) | [j-agy-mcp](https://www.npmjs.com/package/j-agy-mcp) | MCP server wrapping the Antigravity CLI (`agy`) — dispatch exploration, retrieval, or coding tasks to AGY as an external subagent, with ready-to-copy AGENTS.md presets for search / vision / coding |
| [`packages/j-can-see`](./packages/j-can-see) | [j-can-see](https://www.npmjs.com/package/j-can-see) | Vision toolkit for text-only AI coding agents: describe/OCR images, locate elements with pixel coordinates, diff images, pick exact colors, vectorize graphics |

## Repo layout

```
packages/   # independent npm packages (one directory = one package)
skills/     # agent skills, not published to npm (added as they land)
```

## Development

```bash
npm install        # installs all workspaces
npm test           # runs every package's test suite
```
