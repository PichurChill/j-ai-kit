import { describe, expect, it } from "vitest";
import { formatResult, stepDelta } from "../src/tools.js";

describe("formatResult", () => {
  it("成功结果:响应在前,元数据在后且带日志路径", () => {
    const rendered = formatResult(
      {
        conversation_id: "c-1",
        status: "SUCCESS",
        response: "结果文本",
        duration_seconds: 8.382,
        num_turns: 3,
        usage: { total_tokens: 15956 },
      },
      "/tmp/j-agy/prompt-1.log",
    );
    expect(rendered.isError).toBeUndefined();
    expect(rendered.content[0].text).toBe("结果文本");
    expect(rendered.content[1].text).toContain("conversation_id: c-1");
    expect(rendered.content[1].text).toContain("duration: 8.4s");
    expect(rendered.content[1].text).toContain("turns: 3");
    expect(rendered.content[1].text).toContain("tokens: 15956");
    expect(rendered.content[1].text).toContain("log: /tmp/j-agy/prompt-1.log");
  });

  it("ERROR 状态返回 isError,文本优先 error 字段", () => {
    const rendered = formatResult({ status: "ERROR", error: "boom", response: "partial" }, "/tmp/x.log");
    expect(rendered.isError).toBe(true);
    expect(rendered.content[0].text).toBe("错误: boom");
  });

  it("字段缺失时防御式降级,不抛错", () => {
    const rendered = formatResult({}, "/tmp/x.log");
    expect(rendered.isError).toBeUndefined();
    expect(rendered.content[0].text).toBe("");
    expect(rendered.content[1].text).toContain("conversation_id: 未知");
    expect(rendered.content[1].text).toContain("duration: 未知");
    expect(rendered.content[1].text).toContain("turns: 未知");
    expect(rendered.content[1].text).toContain("tokens: 未知");
  });
});

describe("stepDelta", () => {
  it("从 step_update 事件提取非空 text_delta", () => {
    expect(stepDelta({ event: "step_update", step_update: { text_delta: "你好" } })).toBe("你好");
  });

  it("非 step_update 事件、空 delta、缺字段均返回 undefined", () => {
    expect(stepDelta({ event: "init" })).toBeUndefined();
    expect(stepDelta({ event: "step_update", step_update: { state: "DONE" } })).toBeUndefined();
    expect(stepDelta({ event: "step_update", step_update: { text_delta: "" } })).toBeUndefined();
    expect(stepDelta({ event: "step_update" })).toBeUndefined();
  });
});
