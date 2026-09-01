import { describe, it, expect } from "vitest";
import { imageSize } from "image-size";
import {
  OCR_LONG_TOOL,
  mergeTwo,
  planChunks,
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

describe("planChunks", () => {
  it("短图不分块", () => {
    expect(planChunks(800, 1568, 188)).toEqual([{ y: 0, yEnd: 800 }]);
  });

  it("长图按 step = 块高 - 重叠 切分，末块贴底", () => {
    const chunks = planChunks(3136, 1568, 188);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toEqual({ y: 0, yEnd: 1568 });
    expect(chunks[1].y).toBe(1380); // 1568 - 188
    expect(chunks[chunks.length - 1].yEnd).toBe(3136);
  });

  it("相邻块确实重叠（重叠区是刻意制造的）", () => {
    const chunks = planChunks(5000, 1568, 188);
    for (let i = 1; i < chunks.length; i++) {
      expect(chunks[i].y).toBeLessThan(chunks[i - 1].yEnd);
    }
  });
});

describe("buildAudit", () => {
  const overlap = 188;

  it("去重成功的边界：列出删除的行 + 误删风险提示", () => {
    const out = buildAudit(
      [{ index: 1, removed: ["BBB"], overlapFrom: 1380, overlapTo: 1568 }],
      overlap,
    );
    expect(out).toContain("块1→块2");
    expect(out).toContain("「BBB」");
    expect(out).toContain("y 1380–1568");
    expect(out).toContain("误删");
  });

  it("去重失败的边界必须明确警告，且给出可复核坐标", () => {
    const out = buildAudit(
      [{ index: 1, removed: null, overlapFrom: 1380, overlapTo: 1568 }],
      overlap,
    );
    expect(out).toContain("未能识别重叠内容");
    expect(out).toContain("可能残留重复文字");
    expect(out).toContain("y 1380–1568");
    expect(out).toContain("region");
  });

  it("混合场景：成功与失败的边界各自如实呈现", () => {
    const out = buildAudit(
      [
        { index: 1, removed: null, overlapFrom: 1380, overlapTo: 1568 },
        { index: 2, removed: ["CCC"], overlapFrom: 2760, overlapTo: 2948 },
      ],
      overlap,
    );
    expect(out).toContain("块1→块2");
    expect(out).toContain("未能识别重叠内容");
    expect(out).toContain("块2→块3");
    expect(out).toContain("「CCC」");
    // 两个方向的风险都要披露
    expect(out).toContain("可能残留重复文字");
    expect(out).toContain("误删");
  });

  it("无边界（短图单块）时不产生审计段落", () => {
    expect(buildAudit([], overlap)).toBe("");
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

  it("长图分块并发 OCR：块数正确，合并去重，附边界审计", async () => {
    // 高 3136 > maxEdge 1568 → 3 块。各块返回相同内容 → 断言与完成顺序无关
    const png = await makePng(100, 3136, 0xffffffff);
    const f = mockFetch("AAA\nBBB");
    const text = await runVision(
      OCR_LONG_TOOL,
      { source: "x.png" },
      { reader: readerOf(png), fetchImpl: f },
    );
    expect(f.count()).toBe(3);
    expect(text).toContain("分 3 块");
    expect(text).toContain("2 条边界");
    // 三块内容相同 → 两条边界都应去重，正文只留一份
    expect(text).toContain("均已去重");
    expect(text).not.toContain("AAA\nBBB\nAAA");
    expect(text).toContain("边界审计");
    // 契约：全部完成时正文不得出现任何缺口标记（曾有 prev=-2 初值导致首行假标记）
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
    // 23000px 高 → 17 块 > 上限 16
    const png = await makePng(50, 23000, 0xffffffff);
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
    expect(text).toContain("第 1 块（y 0–1568）");
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
