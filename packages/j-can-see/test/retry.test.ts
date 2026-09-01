import { describe, it, expect, vi, afterEach } from "vitest";
import {
  retryDecision,
  shouldDemote,
  degradeNotice,
  runManagedVisionCall,
  callVisionPooled,
  DEGRADE_EDGE,
  type RetryTuning,
  type PreparedImages,
} from "../src/retry.js";
import { VisionPool, newCallContext } from "../src/pool.js";
import { VisionError, VisionTimeoutError } from "../src/errors.js";
import type { FetchLike } from "../src/vision.js";
import { TEST_CONFIG } from "./helpers.js";

const silence = () =>
  vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 测试用小时间参数：秒级常量缩到毫秒级，逻辑不变 */
const FAST: RetryTuning = {
  degradeReserveMs: 200,
  skipFullThresholdMs: 100,
  minAttemptBudgetMs: 20,
};

const openaiOk = (content: string) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** 按序返回预设结果的 fetch；"hang" 表示挂起直到 abort（模拟超时） */
function scriptedFetch(
  script: Array<Response | "hang">,
): FetchLike & { edges: number[]; count(): number } {
  let i = 0;
  const calls: RequestInit[] = [];
  const fn = (async (_url: string, init: RequestInit) => {
    calls.push(init);
    const step = script[Math.min(i, script.length - 1)];
    i++;
    if (step === "hang") {
      return new Promise<Response>((_, reject) => {
        const fail = () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        };
        // 贴近真实 fetch 语义：signal 已 aborted 时立即拒绝（监听器不会再触发）
        if (init.signal?.aborted) fail();
        else init.signal?.addEventListener("abort", fail);
      });
    }
    return step;
  }) as FetchLike & { edges: number[]; count(): number };
  Object.defineProperty(fn, "count", { value: () => i });
  return fn;
}

/** buildImages 桩：记录每次请求的 maxEdge，meta 携带 edge 供断言 */
function edgeRecorder() {
  const edges: number[] = [];
  const build = async (maxEdge: number): Promise<PreparedImages<number>> => {
    edges.push(maxEdge);
    return { images: [{ base64: "aa", mime: "image/jpeg" }], meta: maxEdge };
  };
  return { edges, build };
}

function managedInput<M>(
  over: Partial<Omit<Parameters<typeof runManagedVisionCall<M>>[0], "buildImages">> & {
    buildImages: (maxEdge: number) => Promise<PreparedImages<M>>;
  },
) {
  return {
    prompt: "p",
    fullMaxEdge: 1568,
    degradable: true,
    deadline: Date.now() + 5000,
    label: "test",
    busyHint: "稍后重试",
    ...over,
  };
}

describe("retryDecision", () => {
  it("timeout 可降质：重试 1 次并降质，无退避", () => {
    const d = retryDecision("timeout", { degradable: true });
    expect(d).toEqual({ retry: true, backoffMs: 0, degrade: true, maxRetries: 1 });
  });

  it("timeout 无降质后手：显式不可重试（不是留一条走不到的分支）", () => {
    expect(retryDecision("timeout", { degradable: false }).retry).toBe(false);
  });

  it("rate_limit 优先用 Retry-After，缺省 1s 退避", () => {
    expect(
      retryDecision("rate_limit", { degradable: true, retryAfterMs: 2500 })
        .backoffMs,
    ).toBe(2500);
    expect(retryDecision("rate_limit", { degradable: false }).backoffMs).toBe(
      1000,
    );
    expect(retryDecision("rate_limit", { degradable: false }).maxRetries).toBe(2);
  });

  it("server 1s 退避重试 2 次；network 0.5s；empty 直接重试 1 次", () => {
    expect(retryDecision("server", { degradable: false })).toMatchObject({
      retry: true,
      backoffMs: 1000,
      maxRetries: 2,
    });
    expect(retryDecision("network", { degradable: false })).toMatchObject({
      retry: true,
      backoffMs: 500,
      maxRetries: 2,
    });
    expect(retryDecision("empty", { degradable: false })).toMatchObject({
      retry: true,
      backoffMs: 0,
      maxRetries: 1,
    });
  });

  it("parse / client / busy / 未知不重试", () => {
    for (const kind of ["parse", "client", "busy", undefined] as const) {
      expect(retryDecision(kind, { degradable: true }).retry).toBe(false);
    }
  });
});

describe("shouldDemote", () => {
  it("仅上游容量信号（timeout/429/5xx）降档", () => {
    expect(shouldDemote("timeout")).toBe(true);
    expect(shouldDemote("rate_limit")).toBe(true);
    expect(shouldDemote("server")).toBe(true);
    expect(shouldDemote("network")).toBe(false);
    expect(shouldDemote("parse")).toBe(false);
    expect(shouldDemote("empty")).toBe(false);
    expect(shouldDemote(undefined)).toBe(false);
  });
});

describe("runManagedVisionCall", () => {
  it("一次成功：全质量 edge，degraded=false，无说明行", async () => {
    silence();
    const pool = new VisionPool(3);
    const { edges, build } = edgeRecorder();
    const r = await runManagedVisionCall(
      managedInput({ buildImages: build }),
      {
        config: TEST_CONFIG,
        pool,
        ctx: newCallContext(),
        fetchImpl: scriptedFetch([openaiOk("看到了")]),
        tuning: FAST,
      },
    );
    expect(r.text).toBe("看到了");
    expect(r.degraded).toBe(false);
    expect(edges).toEqual([1568]);
    expect(degradeNotice(r.degraded)).toBe("");
    expect(pool.activeCount).toBe(0); // 槽已释放
  });

  it("429 → 按退避重试成功，池降档一次", async () => {
    silence();
    const pool = new VisionPool(3);
    const sleeps: number[] = [];
    const { build } = edgeRecorder();
    const r = await runManagedVisionCall(
      managedInput({ buildImages: build }),
      {
        config: TEST_CONFIG,
        pool,
        ctx: newCallContext(),
        fetchImpl: scriptedFetch([
          new Response("busy", { status: 429, headers: { "retry-after": "1" } }),
          openaiOk("成功"),
        ]),
        sleepImpl: async (ms) => {
          sleeps.push(ms);
        },
        tuning: FAST,
      },
    );
    expect(r.text).toBe("成功");
    expect(r.degraded).toBe(false);
    expect(sleeps).toEqual([1000]); // Retry-After: 1s
    expect(pool.currentLimit).toBe(2); // 降档一次
  });

  it("超时 → 降质重试成功：edge 变 1024，degraded=timeout，附说明行", async () => {
    silence();
    const pool = new VisionPool(3);
    const { edges, build } = edgeRecorder();
    const r = await runManagedVisionCall(
      managedInput({
        buildImages: build,
        deadline: Date.now() + 700, // 首发超时 = 700-200=500ms 真实等待
      }),
      {
        config: TEST_CONFIG,
        pool,
        ctx: newCallContext(),
        fetchImpl: scriptedFetch(["hang", openaiOk("降质后成功")]),
        tuning: FAST,
      },
    );
    expect(r.text).toBe("降质后成功");
    expect(r.degraded).toBe("timeout");
    expect(edges).toEqual([1568, DEGRADE_EDGE]);
    expect(r.meta).toBe(DEGRADE_EDGE); // meta 对应实际发送的图
    expect(degradeNotice(r.degraded)).toContain("因超时已降质重试");
    expect(pool.currentLimit).toBe(2); // 超时降档
  });

  it("预算不足以全质量发起：跳过全质量直接降质起手（degraded=budget）", async () => {
    silence();
    const pool = new VisionPool(3);
    const { edges, build } = edgeRecorder();
    const r = await runManagedVisionCall(
      managedInput({
        buildImages: build,
        // 剩余 250ms − reserve 200ms = 50ms < skip 阈值 100ms → 降质起手
        deadline: Date.now() + 250,
      }),
      {
        config: TEST_CONFIG,
        pool,
        ctx: newCallContext(),
        fetchImpl: scriptedFetch([openaiOk("小图结果")]),
        tuning: FAST,
      },
    );
    expect(r.degraded).toBe("budget");
    expect(edges).toEqual([DEGRADE_EDGE]);
    expect(degradeNotice(r.degraded)).toContain("预算不足");
  });

  it("非可降质调用超时：不重试，原样抛 VisionTimeoutError", async () => {
    silence();
    const pool = new VisionPool(3);
    const { edges, build } = edgeRecorder();
    await expect(
      runManagedVisionCall(
        managedInput({
          buildImages: build,
          degradable: false,
          fullMaxEdge: 800,
          deadline: Date.now() + 300,
        }),
        {
          config: TEST_CONFIG,
          pool,
          ctx: newCallContext(),
          fetchImpl: scriptedFetch(["hang"]),
          tuning: FAST,
        },
      ),
    ).rejects.toBeInstanceOf(VisionTimeoutError);
    expect(edges).toEqual([800]); // 全程只有一次全预算尝试
  });

  it("重试耗尽：上报最后一次真实错误（429 首发 + 2 次重试）", async () => {
    silence();
    const pool = new VisionPool(3);
    const { build } = edgeRecorder();
    const f = scriptedFetch([
      new Response("a", { status: 429 }),
      new Response("b", { status: 429 }),
      new Response("c", { status: 429 }),
    ]);
    await expect(
      runManagedVisionCall(managedInput({ buildImages: build }), {
        config: TEST_CONFIG,
        pool,
        ctx: newCallContext(),
        fetchImpl: f,
        sleepImpl: async () => {},
        tuning: FAST,
      }),
    ).rejects.toMatchObject({ kind: "rate_limit", status: 429 });
    expect(f.count()).toBe(3); // 总尝试 = J_SEE_MAX_ATTEMPTS
    expect(pool.currentLimit).toBe(1); // 三次降档，floor 1
    expect(pool.activeCount).toBe(0);
  });

  it("parse 错误不重试，一次即抛", async () => {
    silence();
    const pool = new VisionPool(3);
    const { build } = edgeRecorder();
    const f = scriptedFetch([
      new Response("not json", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      }),
    ]);
    await expect(
      runManagedVisionCall(managedInput({ buildImages: build }), {
        config: TEST_CONFIG,
        pool,
        ctx: newCallContext(),
        fetchImpl: f,
        tuning: FAST,
      }),
    ).rejects.toMatchObject({ kind: "parse" });
    expect(f.count()).toBe(1);
    expect(pool.currentLimit).toBe(3); // parse 不降档
  });

  it("池满且预算内等不到槽：抛 busy 错误并带工具提示", async () => {
    silence();
    const pool = new VisionPool(1);
    const holder = newCallContext();
    await pool.acquire(Date.now() + 60_000, holder); // 占住唯一槽位

    const { build } = edgeRecorder();
    await expect(
      runManagedVisionCall(
        managedInput({
          buildImages: build,
          deadline: Date.now() + 150,
          busyHint: "建议改用批量模式",
        }),
        {
          config: TEST_CONFIG,
          pool,
          ctx: newCallContext(),
          fetchImpl: scriptedFetch([openaiOk("不会到这")]),
          tuning: FAST,
        },
      ),
    ).rejects.toMatchObject({
      kind: "busy",
      message: expect.stringContaining("建议改用批量模式"),
    });
  });
});

describe("callVisionPooled", () => {
  it("排队等不到槽抛 VisionTimeoutError（ocr 语义：块未完成而非熔断）", async () => {
    silence();
    const pool = new VisionPool(1);
    await pool.acquire(Date.now() + 60_000, newCallContext());
    await expect(
      callVisionPooled(
        { images: [{ base64: "aa", mime: "image/jpeg" }], prompt: "p" },
        Date.now() + 50,
        "ocr chunk=1",
        { config: TEST_CONFIG, pool, ctx: newCallContext() },
      ),
    ).rejects.toBeInstanceOf(VisionTimeoutError);
  });

  it("429 失败：降档且原样抛出，不重试", async () => {
    silence();
    const pool = new VisionPool(3);
    const f = scriptedFetch([new Response("x", { status: 429 })]);
    await expect(
      callVisionPooled(
        { images: [{ base64: "aa", mime: "image/jpeg" }], prompt: "p" },
        Date.now() + 5000,
        "ocr chunk=2",
        { config: TEST_CONFIG, pool, ctx: newCallContext(), fetchImpl: f },
      ),
    ).rejects.toMatchObject({ kind: "rate_limit" });
    expect(f.count()).toBe(1);
    expect(pool.currentLimit).toBe(2);
    expect(pool.activeCount).toBe(0);
  });

  it("外部取消（ocr 熔断在途块）不降档：假容量信号不进池", async () => {
    silence();
    const pool = new VisionPool(3);
    const abort = new AbortController();
    const pending = callVisionPooled(
      { images: [{ base64: "aa", mime: "image/jpeg" }], prompt: "p" },
      Date.now() + 5000,
      "ocr chunk=4",
      {
        config: TEST_CONFIG,
        pool,
        ctx: newCallContext(),
        fetchImpl: scriptedFetch(["hang"]),
        signal: abort.signal,
      },
    );
    abort.abort(); // 模拟 ocrWithBudget 真实故障熔断
    await expect(pending).rejects.toMatchObject({
      name: "VisionTimeoutError",
      external: true,
    });
    expect(pool.currentLimit).toBe(3); // 关键：池档位不动
    expect(pool.activeCount).toBe(0);
  });

  it("成功路径：返回文本并释放槽位", async () => {
    silence();
    const pool = new VisionPool(3);
    const text = await callVisionPooled(
      { images: [{ base64: "aa", mime: "image/jpeg" }], prompt: "p" },
      Date.now() + 5000,
      "ocr chunk=3",
      {
        config: TEST_CONFIG,
        pool,
        ctx: newCallContext(),
        fetchImpl: scriptedFetch([openaiOk("块文本")]),
      },
    );
    expect(text).toBe("块文本");
    expect(pool.activeCount).toBe(0);
  });
});
