import { describe, it, expect } from "vitest";
import { loadConfig, loadBaseConfig } from "../src/config.js";

const BASE = {
  J_SEE_TOKEN: "tok_x",
  J_SEE_BASE_URL: "https://example.com",
  J_SEE_MODEL: "grok-4.5",
} as const;

describe("loadBaseConfig", () => {
  it("空环境可用（纯本地工具模式），base 项默认值齐全", () => {
    const c = loadBaseConfig({});
    expect(c.J_SEE_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(c.J_SEE_MAX_EDGE).toBe(1568);
    expect(c.J_SEE_MAX_PIXELS).toBe(40_000_000);
    expect(c.J_SEE_API_SPEC).toBe("responses");
  });

  it("不含视觉字段：不再用空串伪造占位", () => {
    const c = loadBaseConfig({ ...BASE });
    expect("J_SEE_TOKEN" in c).toBe(false);
    expect("J_SEE_BASE_URL" in c).toBe(false);
    expect("J_SEE_MODEL" in c).toBe(false);
  });

  it("base 项显式配置生效", () => {
    expect(loadBaseConfig({ J_SEE_MAX_BYTES: "1024" }).J_SEE_MAX_BYTES).toBe(
      1024,
    );
    expect(
      loadBaseConfig({ J_SEE_MAX_PIXELS: "1000000" }).J_SEE_MAX_PIXELS,
    ).toBe(1000000);
  });

  it("base 项非法时仍抛 ConfigError（如非法 API_SPEC）", () => {
    expect(() => loadBaseConfig({ J_SEE_API_SPEC: "gemini" })).toThrow(
      /J_SEE_API_SPEC/,
    );
  });
});

describe("loadConfig", () => {
  it("应用默认值", () => {
    const c = loadConfig(BASE);
    expect(c.J_SEE_MODEL).toBe("grok-4.5");
    expect(c.J_SEE_API_SPEC).toBe("responses");
    expect(c.J_SEE_REASONING).toBe("none");
    expect(c.J_SEE_MAX_EDGE).toBe(1568);
    expect(c.J_SEE_MAX_BYTES).toBe(50 * 1024 * 1024);
    expect(c.J_SEE_TIMEOUT_MS).toBe(90000);
  });

  it("去除 BASE_URL 末尾斜杠", () => {
    expect(
      loadConfig({ ...BASE, J_SEE_BASE_URL: "https://x.com/" })
        .J_SEE_BASE_URL,
    ).toBe("https://x.com");
    expect(
      loadConfig({ ...BASE, J_SEE_BASE_URL: "https://x.com///" })
        .J_SEE_BASE_URL,
    ).toBe("https://x.com");
  });

  it("缺少 TOKEN 抛 ConfigError", () => {
    expect(() => loadConfig({ J_SEE_BASE_URL: "https://x.com" })).toThrow(
      /J_SEE_TOKEN/,
    );
  });

  it("变量完全缺失（undefined）也用可读中文提示，而非 zod 默认英文文案", () => {
    expect(() => loadConfig({})).toThrow(/J_SEE_TOKEN 未配置/);
    expect(() => loadConfig({ J_SEE_TOKEN: "x" })).toThrow(
      /J_SEE_BASE_URL 未配置/,
    );
    expect(() =>
      loadConfig({ J_SEE_TOKEN: "x", J_SEE_BASE_URL: "https://x.com" }),
    ).toThrow(/J_SEE_MODEL 未配置/);
  });

  it("传空串同样报「未配置」", () => {
    expect(() =>
      loadConfig({
        J_SEE_TOKEN: "",
        J_SEE_BASE_URL: "https://x.com",
        J_SEE_MODEL: "m",
      }),
    ).toThrow(/J_SEE_TOKEN 未配置/);
  });

  it("缺少 BASE_URL 抛错", () => {
    expect(() => loadConfig({ J_SEE_TOKEN: "x" })).toThrow(/J_SEE_BASE_URL/);
  });

  it("缺少 MODEL 抛错", () => {
    expect(() =>
      loadConfig({ J_SEE_TOKEN: "x", J_SEE_BASE_URL: "https://x.com" }),
    ).toThrow(/J_SEE_MODEL/);
  });

  it("空字符串 MODEL 抛错", () => {
    expect(() => loadConfig({ ...BASE, J_SEE_MODEL: "" })).toThrow(
      /J_SEE_MODEL/,
    );
  });

  it("非法 URL 抛错", () => {
    expect(() =>
      loadConfig({ ...BASE, J_SEE_BASE_URL: "not-a-url" }),
    ).toThrow();
  });

  it("MAX_EDGE 字符串可 coerce 为数字", () => {
    expect(
      loadConfig({ ...BASE, J_SEE_MAX_EDGE: "800" }).J_SEE_MAX_EDGE,
    ).toBe(800);
  });

  it("REASONING 非法值抛错", () => {
    expect(() =>
      loadConfig({ ...BASE, J_SEE_REASONING: "turbo" }),
    ).toThrow();
  });

  it("API_SPEC 默认 responses，可显式设为 openai / anthropic", () => {
    expect(loadConfig(BASE).J_SEE_API_SPEC).toBe("responses");
    expect(
      loadConfig({ ...BASE, J_SEE_API_SPEC: "openai" }).J_SEE_API_SPEC,
    ).toBe("openai");
    expect(
      loadConfig({ ...BASE, J_SEE_API_SPEC: "anthropic" }).J_SEE_API_SPEC,
    ).toBe("anthropic");
  });

  it("API_SPEC 非法值抛错", () => {
    expect(() =>
      loadConfig({ ...BASE, J_SEE_API_SPEC: "gemini" }),
    ).toThrow();
  });
});
