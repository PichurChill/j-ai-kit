import { describe, it, expect, vi, afterEach } from "vitest";
import { SEE_IMAGE_TOOL } from "../src/tools/see.js";
import { EARLY_STOP_CONSECUTIVE } from "../src/tools/each.js";
import { VisionPool } from "../src/pool.js";
import type { RetryTuning } from "../src/retry.js";
import type { AppConfig } from "../src/config.js";
import type { FetchLike } from "../src/vision.js";
import {
  runVision,
  makePng,
  readerFrom,
  mockFetchSeq,
  TEST_CONFIG,
} from "./helpers.js";

const silence = () =>
  vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 秒级常量缩到毫秒级，测试免等待 */
const FAST: RetryTuning = {
  degradeReserveMs: 200,
  skipFullThresholdMs: 100,
  minAttemptBudgetMs: 20,
};

/**
 * 串行化配置：worker 数 = J_SEE_MAX_CONCURRENT = 1，
 * 图序即上游调用序 —— mockFetchSeq 的「第 i 次调用」才对得上「第 i 张图」。
 */
const SERIAL_CONFIG: AppConfig = { ...TEST_CONFIG, J_SEE_MAX_CONCURRENT: 1 };

const failWith = (status: number): FetchLike & { count(): number } => {
  let n = 0;
  const fn = (async () => {
    n++;
    return new Response("err", { status });
  }) as unknown as FetchLike & { count(): number };
  Object.defineProperty(fn, "count", { value: () => n });
  return fn;
};

describe("see_image each 批量模式", () => {
  it("全部成功：逐图编号结果，无未处理清单", async () => {
    silence();
    const png = await makePng(50, 50);
    const f = mockFetchSeq(["图一内容", "图二内容", "图三内容"]);
    const text = await runVision(
      SEE_IMAGE_TOOL,
      { source: ["a.png", "b.png", "c.png"], each: true, prompt: "这是什么" },
      {
        reader: readerFrom({ "a.png": png, "b.png": png, "c.png": png }),
        fetchImpl: f,
        pool: new VisionPool(1),
        tuning: FAST,
      },
      SERIAL_CONFIG,
    );
    expect(text).toContain("共 3 张：完成 3，失败 0，未处理 0");
    expect(text).toContain("[1] a.png\n图一内容");
    expect(text).toContain("[2] b.png\n图二内容");
    expect(text).toContain("[3] c.png\n图三内容");
    expect(text).not.toContain("继续处理");
    expect(f.count()).toBe(3);
  });

  it("单张失败跳过并记录原因，其余照常完成（图彼此独立）", async () => {
    silence();
    const png = await makePng(50, 50);
    // 第 2 张返回空内容 → empty 重试 1 次仍空 → 该张失败，第 3 张继续
    const f = mockFetchSeq(["图一", "", "", "图三"]);
    const text = await runVision(
      SEE_IMAGE_TOOL,
      { source: ["a.png", "b.png", "c.png"], each: true, prompt: "p" },
      {
        reader: readerFrom({ "a.png": png, "b.png": png, "c.png": png }),
        fetchImpl: f,
        pool: new VisionPool(1),
        sleepImpl: async () => {},
        tuning: FAST,
      },
      SERIAL_CONFIG,
    );
    expect(text).toContain("完成 2，失败 1");
    expect(text).toContain("[2] b.png\n识别失败：VisionError");
    expect(text).toContain("[3] c.png\n图三");
  });

  it("完成序连续 3 张失败早停：停止派发并给出上游不可用结论", async () => {
    silence();
    const png = await makePng(50, 50);
    const f = failWith(500); // 全部 5xx：每张重试 2 次耗尽后失败
    const sources = ["a.png", "b.png", "c.png", "d.png", "e.png"];
    const text = await runVision(
      SEE_IMAGE_TOOL,
      { source: sources, each: true, prompt: "p" },
      {
        reader: readerFrom(Object.fromEntries(sources.map((s) => [s, png]))),
        fetchImpl: f,
        pool: new VisionPool(1),
        sleepImpl: async () => {},
        tuning: FAST,
      },
      SERIAL_CONFIG,
    );
    expect(text).toContain(`连续 ${EARLY_STOP_CONSECUTIVE} 张失败`);
    expect(text).toContain("上游当前不可用");
    expect(text).toContain("失败 3，未处理 2");
    // 3 张 × (首发 + 2 重试) = 9 次上游调用后停，d/e 未派发
    expect(f.count()).toBe(9);
    expect(text).toContain('"source":["d.png","e.png"]');
  });

  it("总预算耗尽：未处理清单 + 可复制续调参数（prompt/max_edge 原样带上）", async () => {
    silence();
    const png = await makePng(50, 50);
    const f = mockFetchSeq(["不该被调用"]);
    const text = await runVision(
      SEE_IMAGE_TOOL,
      {
        source: ["a.png", "b.png"],
        each: true,
        prompt: "识别文字",
        max_edge: 512,
      },
      {
        reader: readerFrom({ "a.png": png, "b.png": png }),
        fetchImpl: f,
        pool: new VisionPool(1),
        tuning: FAST,
      },
      // 预算 1ms：一张都来不及发起
      { ...SERIAL_CONFIG, J_SEE_TASK_BUDGET_MS: 1 },
    );
    expect(text).toContain("完成 0，失败 0，未处理 2");
    expect(text).toContain("（未处理：总预算耗尽）");
    expect(text).toContain(
      'see_image({"source":["a.png","b.png"],"each":true,"prompt":"识别文字","max_edge":512})',
    );
    expect(f.count()).toBe(0);
  });

  it("each: true 单图也走批量格式（续调剩 1 张时格式不突变）", async () => {
    silence();
    const png = await makePng(50, 50);
    const f = mockFetchSeq(["独图内容"]);
    const text = await runVision(
      SEE_IMAGE_TOOL,
      { source: "a.png", each: true, prompt: "p" },
      {
        reader: readerFrom({ "a.png": png }),
        fetchImpl: f,
        pool: new VisionPool(1),
        tuning: FAST,
      },
      SERIAL_CONFIG,
    );
    expect(text).toContain("共 1 张：完成 1");
    expect(text).toContain("[1] a.png\n独图内容");
  });

  it("max_edge 生效：请求体中的图不超过指定长边", async () => {
    silence();
    const png = await makePng(1000, 500);
    const f = mockFetchSeq(["ok"]);
    await runVision(
      SEE_IMAGE_TOOL,
      { source: "a.png", prompt: "p", max_edge: 200 },
      {
        reader: readerFrom({ "a.png": png }),
        fetchImpl: f,
        pool: new VisionPool(1),
        tuning: FAST,
      },
    );
    const body = JSON.parse(
      (f.calls[0][1] as RequestInit).body as string,
    ) as { messages: Array<{ content: Array<{ image_url?: { url: string } }> }> };
    const dataUrl = body.messages[0].content[0].image_url!.url;
    const { Jimp } = await import("jimp");
    const img = await Jimp.read(
      Buffer.from(dataUrl.split(",")[1], "base64"),
    );
    expect(Math.max(img.width, img.height)).toBeLessThanOrEqual(200);
  });

  it("max_edge 越界被 schema 拒绝", () => {
    expect(
      SEE_IMAGE_TOOL.schema.safeParse({ source: "a.png", max_edge: 32 })
        .success,
    ).toBe(false);
    expect(
      SEE_IMAGE_TOOL.schema.safeParse({ source: "a.png", max_edge: 5000 })
        .success,
    ).toBe(false);
  });

  it("each + region 被 schema 拒绝（不静默丢弃参数）", () => {
    const parsed = SEE_IMAGE_TOOL.schema.safeParse({
      source: "a.png",
      each: true,
      region: "0,0,10,10",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain(
      "each 批量模式不支持 region",
    );
  });
});
