/**
 * MCP stdio 冒烟:启动 dist/index.js,fake agy 注入 PATH,
 * 走完整 JSON-RPC 流(initialize → tools/list → tools/call)。
 * 依赖 npm run build 先产出 dist(由 `npm test` 的脚本顺序保证)。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installMockAgy } from "./helpers/mock-agy.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverEntry = path.join(rootDir, "dist", "index.js");

let child: ChildProcess;
let mockBinDir: string;
let originalPath: string;
const pending = new Map<number, (message: any) => void>();

function request(id: number, method: string, params: unknown): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`请求超时: ${method}`));
    }, 15000);
    pending.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}

function notify(method: string, params?: unknown): void {
  child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
}

beforeAll(async () => {
  if (!existsSync(serverEntry)) {
    throw new Error("缺少构建产物 dist/index.js,请先运行 npm run build(或通过 npm test 走完整流程)");
  }
  mockBinDir = mkdtempSync(path.join(tmpdir(), "j-agy-smokebin-"));
  installMockAgy(mockBinDir);
  originalPath = process.env.PATH ?? "";
  process.env.PATH = `${mockBinDir}${path.delimiter}${originalPath}`;
  child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, MOCK_AGY_SCENARIO: "success" },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const rl = createInterface({ input: child.stdout! });
  rl.on("line", (line) => {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof message.id === "number" && pending.has(message.id)) {
      const resolve = pending.get(message.id)!;
      pending.delete(message.id);
      resolve(message);
    }
  });
  const init = await request(1, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "j-agy-smoke", version: "0.0.0" },
  });
  expect(init.result.serverInfo.name).toBe("j-agy-mcp");
  notify("notifications/initialized");
}, 20000);

afterAll(() => {
  child?.kill();
  process.env.PATH = originalPath;
  rmSync(mockBinDir, { recursive: true, force: true });
});

describe("MCP stdio 冒烟", () => {
  it("tools/list 注册四个工具", async () => {
    const response = await request(2, "tools/list", {});
    const names = response.result.tools.map((tool: { name: string }) => tool.name).sort();
    expect(names).toEqual(["agy_conversation", "agy_models", "agy_prompt", "agy_status"]);
  });

  it("agy_models 透传模型列表", async () => {
    const response = await request(3, "tools/call", { name: "agy_models", arguments: {} });
    expect(response.result.content[0].text).toContain("Gemini 3.7 Flash (High)");
  });

  it("agy_prompt 全链路:响应文本 + 元数据带 conversation_id 与日志路径", async () => {
    const response = await request(4, "tools/call", { name: "agy_prompt", arguments: { prompt: "测试" } });
    expect(response.result.isError).toBeUndefined();
    expect(response.result.content[0].text).toBe("你好");
    const meta = response.result.content[1].text;
    expect(meta).toContain("conversation_id: c-1");
    expect(meta).toMatch(/log: .+\/prompt-.+\.log/);
  });

  it("agy_conversation 携带 conversation_id 且执行参数齐全", async () => {
    const response = await request(5, "tools/call", {
      name: "agy_conversation",
      arguments: { conversation_id: "c-1", prompt: "继续", cwd: "/tmp" },
    });
    expect(response.result.isError).toBeUndefined();
    expect(response.result.content[0].text).toBe("你好");
  });

  it("background 全链路:启动即返回 task_id,agy_status 轮询至 done", async () => {
    const started = await request(6, "tools/call", {
      name: "agy_prompt",
      arguments: { prompt: "后台测试", background: true },
    });
    const startedText = started.result.content[0].text;
    expect(startedText).toContain("status: running");
    const taskId = /task_id: (\S+)/.exec(startedText)![1];

    let done = false;
    let finalText = "";
    for (let i = 0; i < 25 && !done; i++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const status = await request(100 + i, "tools/call", {
        name: "agy_status",
        arguments: { task_id: taskId },
      });
      const text = status.result.content[0].text as string;
      if (text.startsWith("status: done")) {
        done = true;
        // done 时 content = [状态行, response, 元数据]
        finalText = [text, status.result.content[1]?.text, status.result.content[2]?.text]
          .filter(Boolean)
          .join("\n");
      }
    }
    expect(done).toBe(true);
    expect(finalText).toContain("你好");
    expect(finalText).toContain("conversation_id: c-1");
  });

  it("agy_status 查询未知任务 ID 返回错误", async () => {
    const response = await request(7, "tools/call", {
      name: "agy_status",
      arguments: { task_id: "prompt-nonexistent" },
    });
    expect(response.result.isError).toBe(true);
    expect(response.result.content[0].text).toContain("未知任务 ID");
  });
});
