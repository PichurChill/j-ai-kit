import { describe, it, expect } from "vitest";
import { imageSize } from "image-size";
import {
  OCR_LONG_TOOL,
  mergeTwo,
  planChunksAdaptive,
  buildAudit,
  ocrWithBudget,
  assembleChunks,
} from "../src/tools/ocr.js";
import { VisionError, VisionTimeoutError } from "../src/errors.js";
import {
  runVision,
  makePng,
  readerOf,
  mockFetch,
  TEST_CONFIG,
} from "./helpers.js";

/** 合成位图：content(y) 为 true 的行是深色（高能量），false 是白色空白带 */
function stripeData(
  w: number,
  h: number,
  content: (y: number) => boolean,
): Buffer {
  const buf = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const dark = content(y);
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      buf[o] = dark ? 20 : 255;
      buf[o + 1] = dark ? 20 : 255;
      buf[o + 2] = dark ? 20 : 255;
      buf[o + 3] = 255;
    }
  }
  return buf;
}

/** 文本样行：严格明暗交替 → 每对相邻行都高能量（真实文本的低能量行来自
 *  行间隙；测试里低能量行只由空白带提供，可控且确定） */
const textRows = (y: number) => y % 2 === 0;

/** 把合成位图编码成 PNG（供工具级测试当 source 用） */
async function stripedPng(
  w: number,
  h: number,
  content: (y: number) => boolean,
): Promise<Buffer> {
  const { Jimp } = await import("jimp");
  return Jimp.fromBitmap({
    data: stripeData(w, h, content),
    width: w,
    height: h,
  }).getBuffer("image/png");
}

describe("mergeTwo", () => {
  it("尾部与头部完全一致时去重，并报告删除的行", () => {
    const r = mergeTwo("AAA\nBBB", "BBB\nCCC");
    expect(r.text).toBe("AAA\nBBB\nCCC");
    expect(r.removed).toEqual(["BBB"]);
  });

  it("多行重叠一并去重", () => {
    const r = mergeTwo("A\nB\nC", "B\nC\nD");
    expect(r.text).toBe("A\nB\nC\nD");
    expect(r.removed).toEqual(["B", "C"]);
  });

  it("仅空白差异仍能去重（模型对重叠区轻微改写）", () => {
    const r = mergeTwo("A\nB", "B  \n C");
    expect(r.removed).toEqual(["B"]);
    expect(r.text.split("\n").filter((l) => l.trim() === "B")).toHaveLength(1);
  });

  it("行被切断导致两侧转录不一致时不去重，removed 为 null", () => {
    // 这正是分块 OCR 的常态：块尾半行 vs 块首整行
    const r = mergeTwo("第一行\n第三行文字被切", "第三行文字被切断了\n第四行");
    expect(r.removed).toBeNull();
    // 内容原样保留（保守：宁可漏删也不误删）
    expect(r.text).toContain("第三行文字被切\n第三行文字被切断了");
  });
});

describe("planChunksAdaptive（内容感知分块）", () => {
  const W = 64;
  const CHUNK_H = 1568;
  const OVERLAP = 188;

  it("短图不分块", () => {
    const chunks = planChunksAdaptive(
      stripeData(W, 800, textRows),
      W,
      800,
      CHUNK_H,
      OVERLAP,
    );
    expect(chunks).toEqual([{ y: 0, yEnd: 800 }]);
  });

  it("低内容带（空白行）处安全切口：两侧无重叠", () => {
    // y 1540-1600 是空白带（含期望切口 1568）→ 切口应落在带内且无重叠
    const h = 3136;
    const data = stripeData(W, h, (y) => (y >= 1540 && y <= 1600 ? false : textRows(y)));
    const chunks = planChunksAdaptive(data, W, h, CHUNK_H, OVERLAP);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0].yEnd).toBeGreaterThanOrEqual(1540);
    expect(chunks[0].yEnd).toBeLessThanOrEqual(1600);
    // 安全切口：下一块起点 == 上一块终点（无重叠、无去重负担）
    expect(chunks[1].y).toBe(chunks[0].yEnd);
    expect(chunks[chunks.length - 1].yEnd).toBe(h);
  });

  it("密集内容找不到安全切口：退回等高 + 重叠兜底（与旧版一致）", () => {
    // 空白带占底部 ~30%（y 2200 起）：p30 被拉到近 0；切口窗口 [1474,1662]
    // 内全是文本行 → min 能量仍高于阈值 → 兜底重叠
    const h = 3136;
    const data = stripeData(W, h, (y) => (y >= 2200 ? false : textRows(y)));
    const chunks = planChunksAdaptive(data, W, h, CHUNK_H, OVERLAP);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // 兜底边界：相邻块确实重叠（重叠区是刻意制造的）
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].y).toBeLessThan(chunks[i - 1].yEnd);
    }
    expect(chunks[0].yEnd).toBe(CHUNK_H);
  });

  it("尾部剩余略多于一块时合并收尾，不切出零头小块", () => {
    // 兜底路径下 3136 高：{0,1568} + y=1380，剩余 1756 ≤ 1.2×1568 → 一块收尾
    const h = 3136;
    const data = stripeData(W, h, (y) => (y >= 2200 ? false : textRows(y)));
    const chunks = planChunksAdaptive(data, W, h, CHUNK_H, OVERLAP);
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toEqual({ y: CHUNK_H - OVERLAP, yEnd: h });
  });
});

describe("buildAudit", () => {
  it("去重成功的边界：列出删除的行 + 误删风险提示", () => {
    const out = buildAudit([
      {
        index: 1,
        removed: ["BBB"],
        overlapFrom: 1380,
        overlapTo: 1568,
        overlapPx: 188,
      },
    ]);
    expect(out).toContain("块1→块2");
    expect(out).toContain("重叠 188px");
    expect(out).toContain("「BBB」");
    expect(out).toContain("y 1380–1568");
    expect(out).toContain("误删");
  });

  it("去重失败的边界必须明确警告，且给出可复核坐标", () => {
    const out = buildAudit([
      {
        index: 1,
        removed: null,
        overlapFrom: 1380,
        overlapTo: 1568,
        overlapPx: 188,
      },
    ]);
    expect(out).toContain("未能识别重叠内容");
    expect(out).toContain("可能残留重复文字");
    expect(out).toContain("y 1380–1568");
    expect(out).toContain("region");
  });

  it("安全切口边界：标注无重叠未去重，不冒充风险也不冒充成功去重", () => {
    const out = buildAudit([
      {
        index: 1,
        removed: null,
        overlapFrom: 1474,
        overlapTo: 1474,
        overlapPx: 0,
      },
    ]);
    expect(out).toContain("安全切口");
    expect(out).toContain("未做去重");
    expect(out).not.toContain("未能识别重叠内容");
    expect(out).not.toContain("误删");
  });

  it("混合场景：安全切口/去重成功/去重失败各自如实呈现", () => {
    const out = buildAudit([
      {
        index: 1,
        removed: null,
        overlapFrom: 1474,
        overlapTo: 1474,
        overlapPx: 0,
      },
      {
        index: 2,
        removed: null,
        overlapFrom: 1380,
        overlapTo: 1568,
        overlapPx: 188,
      },
      {
        index: 3,
        removed: ["CCC"],
        overlapFrom: 2760,
        overlapTo: 2948,
        overlapPx: 188,
      },
    ]);
    expect(out).toContain("块1→块2");
    expect(out).toContain("安全切口");
    expect(out).toContain("未能识别重叠内容");
    expect(out).toContain("「CCC」");
    // 两个方向的风险都要披露
    expect(out).toContain("可能残留重复文字");
    expect(out).toContain("误删");
  });

  it("无边界（短图单块）时不产生审计段落", () => {
    expect(buildAudit([])).toBe("");
  });
});

describe("OCR_LONG_TOOL", () => {
  it("短图（高度未超限）退化为单次 OCR，无分块前缀与审计", async () => {
    const png = await makePng(100, 800, 0xffffffff);
    const f = mockFetch("短图文字内容");
    const text = await runVision(
      OCR_LONG_TOOL,
      { source: "x.png" },
      { reader: readerOf(png), fetchImpl: f },
    );
    expect(text).toBe("短图文字内容");
    expect(f.count()).toBe(1);
  });

  it("长图分块并发 OCR（纯色图 → 安全切口，无重叠无去重）", async () => {
    // 高 3136 白图：每行能量相同 → 全部切口判安全 → 2 块、边界无重叠
    const png = await makePng(100, 3136, 0xffffffff);
    const f = mockFetch("AAA\nBBB");
    const text = await runVision(
      OCR_LONG_TOOL,
      { source: "x.png" },
      { reader: readerOf(png), fetchImpl: f },
    );
    expect(f.count()).toBe(2);
    expect(text).toContain("分 2 块");
    expect(text).toContain("1 条边界");
    expect(text).toContain("1 安全切口");
    expect(text).toContain("安全切口（低内容带，无重叠，未做去重）");
    // 两块内容相同且无重叠 → 原样保留两份（安全切口不去重是刻意的：
    // 无重叠时"重复"只可能是原文连续重复，删了才是误删）
    expect(text).toContain("AAA\nBBB\nAAA");
    // 契约：全部完成时正文不得出现任何缺口标记（曾有 prev=-2 初值导致首行假标记）
    expect(text).not.toContain("内容缺失");
  });

  it("长图分块并发 OCR（密集图 → 重叠兜底 + 去重 + 审计）", async () => {
    // 底部 ~30% 空白拉低 p30 → 切口窗口内无安全带 → 兜底重叠；
    // 两块内容相同 → 去重后只留一份
    const png = await stripedPng(100, 3136, (y) => (y >= 2200 ? false : textRows(y)));
    const f = mockFetch("AAA\nBBB");
    const text = await runVision(
      OCR_LONG_TOOL,
      { source: "x.png" },
      { reader: readerOf(png), fetchImpl: f },
    );
    expect(f.count()).toBe(2);
    expect(text).toContain("分 2 块");
    expect(text).toContain("重叠 188px");
    expect(text).toContain("去除重复");
    expect(text).not.toContain("AAA\nBBB\nAAA");
    expect(text).not.toContain("内容缺失");
  });

  it("块宽超过 maxEdge 时会被缩放（覆盖 sliceBlock 产出物的缩放路径）", async () => {
    // 前一个用例的块是 100×1568，两边都不超 maxEdge，encodeProcessed 里的
    // scaleToFit 根本不会执行 —— 那条路径需要宽图才能覆盖到。
    // 2000×4000 → 3 块，每块 2000×1568，宽超限触发缩放。
    // 注意：本用例做真实 8M 像素解码/编码，负载下耗时可能远超默认 5s 超时，
    // 显式放宽，并把断言做成 header-only（imageSize 不解码像素，毫秒级）。
    // 30s 是防御性上限：正常环境 1-2s，极端负载也够。
    const png = await makePng(2000, 4000, 0xffffffff);
    const f = mockFetch("文字");
    const text = await runVision(
      OCR_LONG_TOOL,
      { source: "x.png" },
      { reader: readerOf(png), fetchImpl: f },
    );
    expect(f.count()).toBe(3);
    expect(text).toContain("分 3 块");

    // 请求体里的图确实被缩到了长边上限内（imageSize 只读 header，不解码像素）
    const body = JSON.parse(f.calls[0][1].body as string);
    const url: string = body.messages[0].content[0].image_url.url;
    const sent = imageSize(Buffer.from(url.split(",")[1], "base64"));
    expect(sent.width).toBeLessThanOrEqual(1568);
    expect(sent.height).toBeLessThanOrEqual(1568);
  }, 30_000);

  it("块数超过上限时在发起 OCR 之前 fail fast", async () => {
    // 25000px 高（纯色安全切口每块进 1474px）→ 17 块 > 上限 16
    const png = await makePng(50, 25000, 0xffffffff);
    const f = mockFetch("不该被调用");
    await expect(
      runVision(
        OCR_LONG_TOOL,
        { source: "x.png" },
        { reader: readerOf(png), fetchImpl: f },
      ),
    ).rejects.toThrow(/需切成 17 块|上限 16/);
    // 一次视觉调用都不该发生
    expect(f.count()).toBe(0);
  });

  it("schema 拒绝数组 source（ocr_long 只支持单图）", () => {
    expect(
      OCR_LONG_TOOL.schema.safeParse({ source: ["a.png", "b.png"] }).success,
    ).toBe(false);
  });

  it("总预算低于发块门槛时不发起任何调用，返回可操作的补齐指引", async () => {
    // 预算 5ms < 发块门槛 10s → 0 块完成；给出逐段 crop 补齐建议
    const png = await makePng(100, 3136, 0xffffffff);
    const f = mockFetch("不该被调用");
    const text = await runVision(
      OCR_LONG_TOOL,
      { source: "x.png" },
      { reader: readerOf(png), fetchImpl: f },
      { ...TEST_CONFIG, J_SEE_OCR_TOTAL_TIMEOUT_MS: 5 },
    );
    expect(f.count()).toBe(0);
    expect(text).toContain("没有任何块完成");
    expect(text).toContain("第 1 块（y 0–1474）"); // 纯色图安全切口：第一块到 1474
    expect(text).toContain("crop");
  });

  it("真实 callVision 超时端到端归类为未处理（类型契约跨模块生效）", async () => {
    // 慢上游尊重 abort signal；单次超时 30ms < 每块实际 100ms → 三块全部超时。
    // 若 ocr 侧的分类退回按文案/时刻判断，这里会变成整单抛错而非部分返回指引
    const png = await makePng(100, 3136, 0xffffffff);
    const slow = (async (_url: string, init: RequestInit) => {
      if (init.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 100);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as import("../src/vision.js").FetchLike;
    const text = await runVision(
      OCR_LONG_TOOL,
      { source: "x.png" },
      { reader: readerOf(png), fetchImpl: slow },
      { ...TEST_CONFIG, J_SEE_TIMEOUT_MS: 30 },
    );
    expect(text).toContain("没有任何块完成");
    expect(text).not.toContain("已抛错");
  });

  it("上游真实错误仍 fail fast（不用部分结果掩盖故障）", async () => {
    const png = await makePng(100, 3136, 0xffffffff);
    const broken = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(
      runVision(
        OCR_LONG_TOOL,
        { source: "x.png" },
        { reader: readerOf(png), fetchImpl: broken as never },
      ),
    ).rejects.toThrow(/fetch failed/);
  });
});

describe("ocrWithBudget（预算调度）", () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  /** 模拟一次调用：实际耗时 duration[i]，到点被 abort 则抛错（真 fetch 的行为） */
  function makeRun(durations: number[]) {
    return async (
      i: number,
      timeoutMs: number,
      signal: AbortSignal,
    ): Promise<string> => {
      // 模拟真实 fetch：到点完成/超时，外部 signal 触发时立即以超时同型错误退出
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          if (durations[i] > timeoutMs) {
            reject(new VisionTimeoutError(`视觉调用超时（${timeoutMs}ms）`));
          } else {
            resolve();
          }
        }, Math.min(durations[i], timeoutMs));
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new VisionTimeoutError(`视觉调用超时（${timeoutMs}ms）`));
          },
          { once: true },
        );
      });
      return `piece${i}`;
    };
  }

  it("预算内全部完成", async () => {
    const chunks = [{ y: 0, yEnd: 10 }, { y: 5, yEnd: 15 }, { y: 10, yEnd: 20 }];
    const { results, error } = await ocrWithBudget(
      chunks, 2, 1000, 500, makeRun([5, 5, 5]), 10,
    );
    expect(error).toBeUndefined();
    expect([...results.keys()].sort()).toEqual([0, 1, 2]);
  });

  it("预算耗尽：已完成的保留、超时的算未处理、不算错误", async () => {
    // 预算 120、并发 2、perCall 10s：块 0/1 各 10ms 完成；
    // 块 2/3 cap=剩余≈110ms < 实际 500ms → deadline 处 abort → 未处理
    const chunks = [0, 1, 2, 3].map((i) => ({ y: i * 5, yEnd: i * 5 + 10 }));
    const { results, error } = await ocrWithBudget(
      chunks, 2, 120, 10_000, makeRun([10, 10, 500, 500]), 30,
    );
    expect(error).toBeUndefined();
    expect([...results.keys()].sort()).toEqual([0, 1]);
  });

  it("真实错误 fail fast：立即取消在途调用（不必等其跑满），新块不再发起", async () => {
    // 4 块并发 2：worker A 拿块 0 立刻抛错；worker B 的块 1 需要 400ms ——
    // 共享 abort 应立即掐断它，整体墙钟远小于 400ms
    const chunks = [0, 1, 2, 3].map((i) => ({ y: i * 5, yEnd: i * 5 + 10 }));
    const started: number[] = [];
    const run = async (i: number, _t: number, signal: AbortSignal): Promise<string> => {
      started.push(i);
      if (i === 0) throw new TypeError("boom");
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 400);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new VisionTimeoutError("视觉调用超时（被取消）"));
        }, { once: true });
      });
      return `piece${i}`;
    };
    const t0 = Date.now();
    const { results, error } = await ocrWithBudget(chunks, 2, 5000, 1000, run, 10);
    const elapsed = Date.now() - t0;
    expect((error as Error).message).toBe("boom");
    expect(started).toEqual([0, 1]); // 块 2/3 未发起
    expect(results.has(1)).toBe(false); // 块 1 被取消，未完成
    expect(elapsed).toBeLessThan(300); // 不等 400ms 的在途调用
  });

  it("单块调用超时（预算仍充足）归为未处理而非错误", async () => {
    // perCall=50 < budget=5000：慢块在 50ms 被单次超时掐断，预算还剩 ~4.9s
    const chunks = [0, 1, 2].map((i) => ({ y: i * 5, yEnd: i * 5 + 10 }));
    const { results, error } = await ocrWithBudget(
      chunks, 2, 5000, 50, makeRun([10, 500, 500]), 10,
    );
    expect(error).toBeUndefined();
    expect([...results.keys()]).toEqual([0]);
  });

  it("deadline 之后到达的真实错误照常上报（不因时刻被吞成未处理）", async () => {
    const chunks = [{ y: 0, yEnd: 10 }];
    const run = async (): Promise<string> => {
      await sleep(30);
      throw new VisionError("视觉调用失败：HTTP 401", { status: 401 });
    };
    const { results, error } = await ocrWithBudget(chunks, 1, 10, 1000, run, 5);
    expect((error as VisionError).status).toBe(401);
    expect(results.size).toBe(0);
  });
});

describe("assembleChunks（缺口标记契约）", () => {
  const mkChunks = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ y: i * 100, yEnd: i * 100 + 150 }));

  it("全部完成：无任何缺口标记，首行即正文", () => {
    const r = assembleChunks(mkChunks(3), new Map([[0, "A"], [1, "B"], [2, "C"]]));
    expect(r.text).toBe("A\nB\nC");
    expect(r.text).not.toContain("内容缺失");
    expect(r.boundaries).toHaveLength(2);
  });

  it("开头缺块：标记在正文最前，块号与 y 区间准确", () => {
    const r = assembleChunks(mkChunks(3), new Map([[1, "B"], [2, "C"]]));
    expect(r.text.startsWith("⋯⋯［第 1 块（y 0–150） 未完成，内容缺失］⋯⋯")).toBe(true);
    expect(r.text).toContain("B\nC");
    expect(r.boundaries).toHaveLength(1); // 1→2 相邻仍合并
  });

  it("中间缺块：标记插在两侧正文之间", () => {
    const r = assembleChunks(mkChunks(3), new Map([[0, "A"], [2, "C"]]));
    expect(r.text).toBe(
      "A\n⋯⋯［第 2 块（y 100–250） 未完成，内容缺失］⋯⋯\nC",
    );
    expect(r.boundaries).toHaveLength(0); // 0 与 2 不相邻，不走去重
  });

  it("尾部缺块：标记缀在正文末尾", () => {
    const r = assembleChunks(mkChunks(3), new Map([[0, "A"]]));
    expect(r.text).toBe(
      "A\n⋯⋯［第 2 块（y 100–250）、第 3 块（y 200–350） 未完成，内容缺失］⋯⋯",
    );
  });

  it("空结果：返回空文本，不产生前导换行或标记", () => {
    const r = assembleChunks(mkChunks(2), new Map());
    expect(r.text).toBe("");
    expect(r.boundaries).toHaveLength(0);
  });
});
