import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AgyLaunchError, executeAgy } from "../src/executor.js";
import { installMockAgy } from "./helpers/mock-agy.js";

let mockBinDir: string;
let emptyBinDir: string;
let originalPath: string;

function setScenario(scenario: string): void {
  process.env.MOCK_AGY_SCENARIO = scenario;
}

beforeAll(() => {
  mockBinDir = mkdtempSync(path.join(tmpdir(), "j-agy-mockbin-"));
  installMockAgy(mockBinDir);
  emptyBinDir = mkdtempSync(path.join(tmpdir(), "j-agy-emptybin-"));
  originalPath = process.env.PATH ?? "";
});

afterEach(() => {
  process.env.PATH = originalPath;
  delete process.env.MOCK_AGY_SCENARIO;
});

afterAll(() => {
  rmSync(mockBinDir, { recursive: true, force: true });
  rmSync(emptyBinDir, { recursive: true, force: true });
});

describe("executeAgy(fake agy)", () => {
  it("success 场景:解析 result 并把事件按序透传", async () => {
    process.env.PATH = `${mockBinDir}${path.delimiter}${originalPath}`;
    setScenario("success");
    const events: Array<{ event: string }> = [];
    const result = await executeAgy({
      prompt: "hi",
      onEvent: (event) => {
        events.push(event);
      },
    });
    expect(result.status).toBe("SUCCESS");
    expect(result.response).toBe("你好");
    expect(result.conversation_id).toBe("c-1");
    expect(result.usage?.total_tokens).toBe(42);
    expect(events.map((event) => event.event)).toEqual(["init", "step_update", "result"]);
  });

  it("ERROR 状态仍 resolve,由渲染层判定错误", async () => {
    process.env.PATH = `${mockBinDir}${path.delimiter}${originalPath}`;
    setScenario("error-status");
    const result = await executeAgy({ prompt: "hi" });
    expect(result.status).toBe("ERROR");
    expect(result.error).toBe("boom");
  });

  it("非零退出且无 result:错误消息包含退出码与 stderr", async () => {
    process.env.PATH = `${mockBinDir}${path.delimiter}${originalPath}`;
    setScenario("exit-nonzero");
    await expect(executeAgy({ prompt: "hi" })).rejects.toThrow(/code=3[\s\S]*mock stderr noise/);
  });

  it("无法解析的输出行写入 stderr 留痕,不影响后续结果", async () => {
    process.env.PATH = `${mockBinDir}${path.delimiter}${originalPath}`;
    setScenario("garbage");
    const writes: string[] = [];
    const spy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(((chunk: unknown) => {
        writes.push(String(chunk));
        return true;
      }) as typeof process.stderr.write);
    try {
      const result = await executeAgy({ prompt: "hi" });
      expect(result.response).toBe("fine");
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).toContain("无法解析的行");
  });

  it("进程忽略 SIGTERM 时超时升级 SIGKILL 并报超时", async () => {
    process.env.PATH = `${mockBinDir}${path.delimiter}${originalPath}`;
    setScenario("hang");
    await expect(executeAgy({ prompt: "hi", timeoutSeconds: 1 })).rejects.toThrow(/超时/);
  }, 15000);

  it("PATH 中无 agy 时报启动失败", async () => {
    process.env.PATH = emptyBinDir;
    await expect(executeAgy({ prompt: "hi" })).rejects.toBeInstanceOf(AgyLaunchError);
  });
});
