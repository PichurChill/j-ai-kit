/**
 * ocr_long 工具：长截图 / 长页面 / 长聊天记录的分块 OCR。
 *
 * 策略：按 maxEdge 高度分块 + 重叠区（防止行被切断）→ 每块逐字 OCR →
 * 合并时按行去除重叠区的重复内容。
 *
 * 比一次性 OCR 整张超长图更可靠（避免服务端降采样丢字）。
 *
 * 去重是保守的：只在「相邻块首尾若干行完全一致」时才删，宁可漏删不误删。
 * 因此每条边界的处理结果都会如实报告 —— 漏删和误删两个方向的风险都要
 * 让调用方看得见（见 buildAudit）。
 */
import { z } from "zod";
import { Jimp } from "jimp";
import type { AppConfig } from "../config.js";
import { ImageError, VisionTimeoutError } from "../errors.js";
import { readSource } from "../sources/index.js";
import {
  decodeJimp,
  encodeProcessed,
  type DecodedImage,
  type ProcessedImage,
} from "../image.js";
import { callVisionPooled } from "../retry.js";
import { getGlobalPool, newCallContext } from "../pool.js";
import {
  limitsOf,
  singleSourceSchema,
  singleSourceProperty,
  VISION_TOOL_GATE,
  type ToolDeps,
  type VisionToolEntry,
} from "./types.js";

export const ocrLongSchema = z.object({
  source: singleSourceSchema,
  prompt: z.string().optional(),
});
export type OcrLongArgs = z.infer<typeof ocrLongSchema>;

/** 重叠区占块高的比例 */
const OVERLAP_RATIO = 0.12;

/** OCR 块的输出 token 上限：密集文字块 2000 会截断 */
const OCR_MAX_TOKENS = 8192;

// 并发不再由本工具自定：块调用统一过全局池（J_SEE_MAX_CONCURRENT），
// worker 数取池上限作上界 —— 杜绝「OCR 4 并发 + 批量 3 并发」两套上限叠加打上游

/** 块数上限：超出则在切块前就 fail fast，而不是跑到一半让客户端超时 */
const OCR_MAX_CHUNKS = 16;

/**
 * 剩余预算低于此值时不再发起新块 —— 此时的调用几乎必然超时，
 * 发出去只是白烧一次调用费。
 */
const MIN_CHUNK_BUDGET_MS = 10_000;

function ocrPrompt(extra?: string): string {
  const base =
    "Transcribe all text in this image verbatim, strictly preserving the original " +
    "line breaks, indentation, and structure.\n" +
    "Preserve speaker names, timestamps, quotes, lists, and other formatting as-is.\n" +
    "Output only the transcribed text — no explanations, comments, or extra notes.";
  return extra ? `${base}\n\nAdditional requirements: ${extra}` : base;
}

/** 归一化比较（忽略空白差异），保留原文输出 */
const norm = (s: string) => s.replace(/\s+/g, "");

interface MergeResult {
  readonly text: string;
  /** 本次去重删除的行（null = 未发生去重） */
  readonly removed: readonly string[] | null;
}

/**
 * 合并相邻两段文本：若前段尾部若干行 ≈ 后段头部（忽略空白差异），去重拼接。
 *
 * 匹配是精确的（仅忽略空白）—— 保守是刻意的：重叠区去重无法区分
 * 「同一行被转录两次」与「原文本就连续重复的行」，放宽匹配会引入误删。
 * 代价是行被切断导致两侧转录不一致时去重会失败，这种失败必须被如实报告。
 *
 * 导出供单测直接覆盖：并发下块的完成顺序不定，合并逻辑按纯函数测更精确。
 */
export function mergeTwo(prev: string, next: string): MergeResult {
  const aLines = prev.split("\n");
  const bLines = next.split("\n");
  const maxK = Math.min(aLines.length, bLines.length, 12);
  for (let k = maxK; k >= 1; k--) {
    const aTail = aLines.slice(-k).join("\n").trim();
    const bHead = bLines.slice(0, k).join("\n").trim();
    if (aTail && norm(aTail) === norm(bHead)) {
      return {
        text: [...aLines, ...bLines.slice(k)].join("\n"),
        removed: bLines.slice(0, k).map((l) => l.trim()),
      };
    }
  }
  return { text: `${prev}\n${next}`, removed: null };
}

interface Chunk {
  readonly y: number;
  readonly yEnd: number;
}

/** 计算分块的 y 区间列表。导出供单测覆盖（块数直接决定是否触发上限） */
export function planChunks(
  totalH: number,
  chunkH: number,
  overlap: number,
): Chunk[] {
  if (totalH <= chunkH) return [{ y: 0, yEnd: totalH }];
  const step = Math.max(1, chunkH - overlap);
  const chunks: Chunk[] = [];
  for (let y = 0; y < totalH; y += step) {
    const yEnd = Math.min(y + chunkH, totalH);
    chunks.push({ y, yEnd });
    if (yEnd >= totalH) break;
  }
  return chunks;
}

/**
 * 从已解码的整图按 y 区间取出一块，只分配块大小的 buffer。
 *
 * 不用 image.clone() + crop：那会为每块完整拷贝一次整图 bitmap
 *（长图可达数十 MB），随即又把其中绝大部分裁掉。
 *
 * 用 Jimp.fromBitmap 而非 new Jimp({data,...})：jimp 的 .d.ts 里构造签名的
 * 返回类型漏掉了插件方法（scaleToFit / crop 等只挂在 read()/fromBitmap() 的
 * 返回类型上），而块随后要交给 encodeProcessed 做缩放。fromBitmap 是
 * 「从裸 bitmap 建图」的正规入口，返回类型完整。
 */
function sliceBlock(image: DecodedImage, chunk: Chunk): DecodedImage {
  const w = image.width;
  const data = Buffer.from(
    image.bitmap.data.subarray(chunk.y * w * 4, chunk.yEnd * w * 4),
  );
  return Jimp.fromBitmap({ data, width: w, height: chunk.yEnd - chunk.y });
}

/**
 * 预算内的并发 OCR：worker 从共享队列取块，块调用超时压到剩余预算。
 *
 * 两种停止方式，语义不同：
 *  - 预算耗尽：不算错误 —— 已完成的块构成部分结果，
 *    未处理的块在输出里如实列出（含 y 区间）供调用方补齐
 *  - 真实错误（网络/上游拒绝）：fail fast —— 第一个错误直接上抛，
 *    并通过共享 AbortSignal **立即取消所有在途调用**（否则要等它们各自跑满
 *    超时才见错误，最坏数倍于单次超时）
 */
export async function ocrWithBudget(
  chunks: readonly Chunk[],
  concurrency: number,
  budgetMs: number,
  perCallMs: number,
  run: (index: number, timeoutMs: number, signal: AbortSignal) => Promise<string>,
  /** 剩余预算低于此值不再发起新块；参数化供测试注入小值 */
  minStartBudgetMs = MIN_CHUNK_BUDGET_MS,
): Promise<{ results: Map<number, string>; error?: unknown }> {
  const deadline = Date.now() + budgetMs;
  const remaining = () => deadline - Date.now();
  const results = new Map<number, string>();
  const errorStop = new AbortController();
  let next = 0;
  let stopped = false;
  let error: unknown;

  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (stopped || i >= chunks.length) return;
      const left = remaining();
      if (left <= minStartBudgetMs) {
        stopped = true; // 预算耗尽：停，不报错（在途调用有自己的超时上限）
        return;
      }
      try {
        results.set(
          i,
          await run(i, Math.min(perCallMs, remaining()), errorStop.signal),
        );
      } catch (e) {
        stopped = true;
        // 分类看类型而非发生时刻/文案：超时（无论预算是否耗尽）= 该块未完成，
        // 不算故障；其余（网络/上游拒绝等）哪怕恰在 deadline 之后到达也照常上报
        if (e instanceof VisionTimeoutError) {
          return; // 该块记为未处理
        }
        errorStop.abort(); // 真实故障：取消其他在途调用，让 fail fast 真正快
        error ??= e;
        return;
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, chunks.length) }, worker),
  );
  return { results, error };
}

export interface AssembleResult {
  readonly text: string;
  readonly boundaries: readonly Boundary[];
}

/**
 * 把各块的 OCR 结果按块序拼装成正文。
 *
 * 契约（部分返回设计成立的前提）：**「有缺口标记 ⇔ 真的缺了块」** ——
 * 全部完成时不得出现任何标记；第一块完成时不产生标记；缺口（开头/中间/尾部）
 * 必须给出准确的块号与 y 区间。相邻完成块之间走去重合并并产生边界记录。
 *
 * 导出供单测直接覆盖。
 */
export function assembleChunks(
  chunks: readonly Chunk[],
  results: ReadonlyMap<number, string>,
): AssembleResult {
  const order = chunks.map((_, i) => i).filter((i) => results.has(i));
  if (order.length === 0) return { text: "", boundaries: [] };

  let merged = "";
  const boundaries: Boundary[] = [];
  let prev = -1;
  for (const i of order) {
    const piece = results.get(i)!;
    if (prev >= 0 && prev === i - 1) {
      // 相邻完成块：走去重合并（重叠区只存在于相邻块之间）
      const r = mergeTwo(merged, piece);
      merged = r.text;
      boundaries.push({
        index: i,
        removed: r.removed,
        overlapFrom: chunks[i].y,
        overlapTo: chunks[i - 1].yEnd,
      });
    } else {
      const from = prev + 1;
      const gapChunks = chunks.slice(from, i);
      const parts: string[] = [];
      if (merged) parts.push(merged);
      if (gapChunks.length > 0) {
        const gap = gapChunks
          .map((c, k) => `第 ${from + k + 1} 块（y ${c.y}–${c.yEnd}）`)
          .join("、");
        parts.push(`⋯⋯［${gap} 未完成，内容缺失］⋯⋯`);
      }
      parts.push(piece);
      merged = parts.join("\n");
    }
    prev = i;
  }

  // 尾部缺口
  const tailStart = order[order.length - 1] + 1;
  if (tailStart < chunks.length) {
    const tail = chunks
      .slice(tailStart)
      .map((c, k) => `第 ${tailStart + k + 1} 块（y ${c.y}–${c.yEnd}）`)
      .join("、");
    merged += `\n⋯⋯［${tail} 未完成，内容缺失］⋯⋯`;
  }
  return { text: merged, boundaries };
}

interface Boundary {
  /** 边界位于块 index 与 index+1 之间（1-based 展示） */
  readonly index: number;
  readonly removed: readonly string[] | null;
  /** 该边界重叠区在原图中的 y 区间 */
  readonly overlapFrom: number;
  readonly overlapTo: number;
}

/**
 * 边界审计：每条边界都必须给出结论。
 *
 * 重叠区是本工具自己制造的，正常情况下必然有重复内容 ——
 * 「没检测到重叠」几乎总是意味着去重失败（模型两次转录不一致），
 * 绝不能陈述成一切正常。
 *
 * 导出供单测直接覆盖。
 */
export function buildAudit(
  boundaries: readonly Boundary[],
  overlap: number,
): string {
  if (boundaries.length === 0) return "";
  const lines = boundaries.map((b) => {
    const range = `原图 y ${b.overlapFrom}–${b.overlapTo}`;
    return b.removed
      ? `- 块${b.index}→块${b.index + 1}（${range}）：去除重复 ${
          b.removed.length
        } 行：${b.removed.map((l) => `「${l}」`).join("")}`
      : `- 块${b.index}→块${b.index + 1}（${range}）：⚠️ 未能识别重叠内容，此处可能残留重复文字`;
  });

  const failed = boundaries.filter((b) => !b.removed);
  const deduped = boundaries.filter((b) => b.removed);
  let note = `\n\n边界审计（重叠区约 ${overlap}px，去重仅在首尾行完全一致时执行）：\n${lines.join(
    "\n",
  )}`;
  if (failed.length > 0) {
    note +=
      `\n未识别重叠通常是该处有文字行被切断、两侧转录不一致所致 —— ` +
      `这些边界可能残留重复内容，可用 see_image 的 region 复核对应 y 区间。`;
  }
  if (deduped.length > 0) {
    note +=
      `\n已去重的行若在原文中本就连续重复（如聊天记录里的重复消息），` +
      `则属误删，同样可用 region 复核。`;
  }
  return note;
}

export const OCR_LONG_TOOL: VisionToolEntry<OcrLongArgs> = {
  tool: {
    name: "ocr_long",
    description:
      "对长截图 / 长页面 / 长聊天记录做分块 OCR 并合并（调视觉模型）。" +
      VISION_TOOL_GATE +
      "注：两屏以上的超长图原生直读通常已被降采样破坏（丢字），那已属「原生失效」，可直接用本工具。" +
      "自动按高度切块 + 重叠区防丢字，比一次性 OCR 超长图更可靠。" +
      "保留发言人/时间戳/引用等结构，输出纯文本。" +
      "多块时受总时间预算（J_SEE_OCR_TOTAL_TIMEOUT_MS，默认 85s）约束：" +
      "预算耗尽返回已完成部分并列出未处理块的 y 区间（可用 crop 裁出后单独补齐），不会整单失败。" +
      "多块时附每条边界的去重审计（含未能去重的边界与可复核坐标）。" +
      "短图（不超高）自动退化为单次 OCR。",
    inputSchema: {
      type: "object",
      properties: {
        source: singleSourceProperty,
        prompt: {
          type: "string",
          description: "可选额外指令，如「只转录中文部分」「忽略页眉页脚」",
        },
      },
      required: ["source"],
    },
  },
  schema: ocrLongSchema,
  needsVision: true,
  async run(
    args: OcrLongArgs,
    config: AppConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const limits = limitsOf(config);
    const pool = deps.pool ?? getGlobalPool(config.J_SEE_MAX_CONCURRENT);
    // 整个 ocr_long 调用一枚试探权
    const ctx = newCallContext();
    const raw = await readSource(args.source, deps.reader);
    const image = await decodeJimp(raw, limits);
    const maxEdge = limits.maxEdge;
    const overlap = Math.floor(maxEdge * OVERLAP_RATIO);
    const chunks = planChunks(image.height, maxEdge, overlap);
    const prompt = ocrPrompt(args.prompt);

    if (chunks.length > OCR_MAX_CHUNKS) {
      throw new ImageError(
        `图片高 ${image.height}px 需切成 ${chunks.length} 块（上限 ${OCR_MAX_CHUNKS}），` +
          `逐块 OCR 的耗时会超出合理等待。请先用 crop 把图纵向切成几段，再分别 ocr_long。`,
      );
    }

    // 块调用只过池 + 失败降档（callVisionPooled），不叠重试/降质 ——
    // ocr 自有预算与部分结果机制，块内重试会吃掉其他块的预算；
    // 排队时间计入块超时，等不到槽 = 该块未完成（VisionTimeoutError）
    const ocrBlock = (
      img: ProcessedImage,
      timeoutMs: number,
      label: string,
      signal?: AbortSignal,
    ): Promise<string> =>
      callVisionPooled(
        { images: [img], prompt, maxTokens: OCR_MAX_TOKENS },
        Date.now() + timeoutMs,
        label,
        { config, pool, ctx, fetchImpl: deps.fetchImpl, signal },
      );

    // 短图：单次 OCR（无需分块，也就没有边界与去重；单次超时受 J_SEE_TIMEOUT_MS 约束）
    if (chunks.length === 1) {
      return ocrBlock(
        await encodeProcessed(image, maxEdge),
        config.J_SEE_TIMEOUT_MS,
        "ocr_long",
      );
    }

    const { results, error } = await ocrWithBudget(
      chunks,
      config.J_SEE_MAX_CONCURRENT,
      config.J_SEE_OCR_TOTAL_TIMEOUT_MS,
      config.J_SEE_TIMEOUT_MS,
      async (i, timeoutMs, signal) =>
        ocrBlock(
          await encodeProcessed(sliceBlock(image, chunks[i]), maxEdge),
          timeoutMs,
          `ocr_long chunk=${i + 1}/${chunks.length}`,
          signal,
        ),
    );
    if (error) throw error;

    const missing = chunks
      .map((_, i) => i)
      .filter((i) => !results.has(i));
    if (missing.length === chunks.length) {
      // 一块都没完成：预算内颗粒无收，给出可操作的补齐指引
      const ranges = missing
        .map((i) => `第 ${i + 1} 块（y ${chunks[i].y}–${chunks[i].yEnd}）`)
        .join("、");
      return (
        `（分 ${chunks.length} 块 OCR：总预算 ${config.J_SEE_OCR_TOTAL_TIMEOUT_MS}ms 内没有任何块完成，` +
        `未处理：${ranges}。可按情况调整：块本身耗时长于单次超时（${config.J_SEE_TIMEOUT_MS}ms）` +
        `时调大 J_SEE_TIMEOUT_MS；要一口气处理更多块时调大 J_SEE_OCR_TOTAL_TIMEOUT_MS ` +
        `或客户端 MCP 工具超时；图特别长时用 crop 逐段裁出后单独 ocr_long）`
      );
    }

    // 按块序拼装：相邻(索引连续)的完成块走去重合并；缺口处插入显式标记。
    // 拼装逻辑抽为纯函数 assembleChunks，缺口标记的准确性有独立测试锁定
    const { text: merged, boundaries } = assembleChunks(chunks, results);

    const failed = boundaries.filter((b) => !b.removed).length;
    let header: string;
    if (missing.length === 0) {
      header =
        `（分 ${chunks.length} 块 OCR，${boundaries.length} 条边界` +
        (failed > 0 ? `，其中 ${failed} 条未能自动去重）` : `，均已去重）`);
    } else {
      const ranges = missing
        .map((i) => `第 ${i + 1} 块（y ${chunks[i].y}–${chunks[i].yEnd}）`)
        .join("、");
      header =
        `（分 ${chunks.length} 块 OCR：${results.size} 块完成；总预算 ` +
        `${config.J_SEE_OCR_TOTAL_TIMEOUT_MS}ms 耗尽，${missing.length} 块未处理 —— ` +
        `${ranges}。可用 crop 裁出上述 y 区间后单独 ocr_long 补齐）`;
    }
    return `${header}\n${merged}${buildAudit(boundaries, overlap)}`;
  },
};
