import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, buildAgyArgs, resolveModelArgs } from "../src/executor.js";

describe("resolveModelArgs", () => {
  it("未指定时使用默认模型,名字含强度后缀不再传 --effort", () => {
    expect(resolveModelArgs(undefined, undefined)).toEqual(["--model", DEFAULT_MODEL]);
  });

  it("显示名含强度后缀时忽略 effort 参数", () => {
    expect(resolveModelArgs("Gemini 3.7 Flash (Medium)", "low")).toEqual(["--model", "Gemini 3.7 Flash (Medium)"]);
  });

  it("id 风格名称含强度后缀时同样忽略 effort", () => {
    expect(resolveModelArgs("gemini-3.7-flash-high", "low")).toEqual(["--model", "gemini-3.7-flash-high"]);
  });

  it("普通模型名传原生 --effort", () => {
    expect(resolveModelArgs("claude-sonnet-4-6", "medium")).toEqual([
      "--model",
      "claude-sonnet-4-6",
      "--effort",
      "medium",
    ]);
  });

  it("普通模型名未指定 effort 时默认 high", () => {
    expect(resolveModelArgs("claude-sonnet-4-6")).toEqual(["--model", "claude-sonnet-4-6", "--effort", "high"]);
  });
});

describe("buildAgyArgs", () => {
  const base = { prompt: "任务描述" };

  it("--print 用分离参数形式,prompt 不拼进旗标", () => {
    const args = buildAgyArgs(base);
    expect(args[0]).toBe("--print");
    expect(args[1]).toBe("任务描述");
  });

  it("输出 stream-json,且 print-timeout 晚于进程级超时 30s", () => {
    const args = buildAgyArgs(base);
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    expect(args[args.indexOf("--print-timeout") + 1]).toBe("330s");
    const longer = buildAgyArgs({ ...base, timeoutSeconds: 600 });
    expect(longer[longer.indexOf("--print-timeout") + 1]).toBe("630s");
  });

  it("默认开启 skip-permissions 与 sandbox", () => {
    const args = buildAgyArgs(base);
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--sandbox");
  });

  it("可通过开关关闭 skip-permissions 与 sandbox", () => {
    const args = buildAgyArgs({ ...base, skipPermissions: false, sandbox: false });
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--sandbox");
  });

  it("会话续聊、多目录、模式均正确传递", () => {
    const args = buildAgyArgs({ ...base, conversationId: "c-9", addDirs: ["/a", "/b"], mode: "plan" });
    expect(args[args.indexOf("--conversation") + 1]).toBe("c-9");
    expect(args.filter((arg) => arg === "--add-dir")).toHaveLength(2);
    expect(args[args.indexOf("--mode") + 1]).toBe("plan");
  });
});
