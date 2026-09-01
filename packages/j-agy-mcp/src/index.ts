#!/usr/bin/env node
/**
 * j-agy-mcp MCP server 入口(stdio 传输)。
 *
 * 把 Antigravity CLI(agy)包装为 MCP 工具(agy_prompt / agy_conversation / agy_models),
 * 供 CodeX / Claude Code 等主代理把探索、检索或编码任务派发给 AGY 作为外部子代理执行。
 * 本 server 不注入任何行为规范,AGY 扮演什么角色由调用方的 prompt(如 AGENTS.md 协议)决定。
 */
import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { sweepOldLogs } from "./logging.js";
import { registerTools } from "./tools.js";
import { VERSION } from "./version.js";

void (async () => {
  // 启动时顺带清扫过期日志(best-effort)
  sweepOldLogs();
  await serveStdio(() => {
    const server = new McpServer({ name: "j-agy-mcp", version: VERSION });
    registerTools(server);
    return server;
  });
})();
