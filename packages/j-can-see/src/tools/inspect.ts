/**
 * inspect 工具：枚举图片中所有同类元素，返回编号列表 + 文字 + 坐标（原图坐标）。
 *
 * 用于盘点页面/界面布局，再配合 locate/see_image 做精确分析。
 */
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { readSource } from "../sources/index.js";
import { processImageWithScale } from "../image.js";
import {
  runManagedVisionCall,
  degradeNotice,
  DEGRADE_EDGE,
} from "../retry.js";
import { getGlobalPool, newCallContext } from "../pool.js";
import {
  extractBoxByLabel,
  toOriginal,
  clampBox,
  formatBox,
  type Box,
} from "./coords.js";
import {
  limitsOf,
  singleSourceSchema,
  singleSourceProperty,
  VISION_TOOL_GATE,
  type ToolDeps,
  type VisionToolEntry,
} from "./types.js";

export const inspectSchema = z.object({
  source: singleSourceSchema,
  kind: z.string().optional(),
});

export type InspectArgs = z.infer<typeof inspectSchema>;

// 嵌入英文 prompt，默认值同用英文（模型被指示对无文字元素写 "(no text)"，
// 解析兜底与之保持同一占位符，避免同一输出混两种写法）
const DEFAULT_KIND =
  "UI elements (buttons, links, inputs, icons, titles, images, badges)";

/** 密集屏幕的元素列表输出较长，2000 会截断 */
const INSPECT_MAX_TOKENS = 8192;

interface InspectItem {
  readonly index: number;
  readonly label: string;
  readonly box: Box;
}

/**
 * 逐行解析模型返回的元素列表，坐标换算为原图坐标并 clamp 到图界。
 * 标签剥离只认带分隔符的坐标（"x1: 100"）—— "1920x1080" 这类正文不会被吃掉。
 */
function parseInspectLines(
  text: string,
  scale: number,
  originalWidth: number,
  originalHeight: number,
): InspectItem[] {
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const items: InspectItem[] = [];
  for (const line of lines) {
    const box = extractBoxByLabel(line);
    if (!box) continue;
    // 文字：去掉坐标标签片段（前置非字符边界 + 后置非数字边界 + 强制分隔符，
    // "box1: 20" / "1920x1080" / "x1 20" 等正文不会被吃掉）+ 行首序号 / markdown 符号
    const label =
      line
        .replace(/(?<![\w])[xy][12](?!\d)\s*[:：,，]\s*-?\d+/gi, "")
        .replace(/^\s*[-*•]?\s*\d+\s*[.、)]?\s*/, "")
        .replace(/[,，\s]+/g, " ")
        .trim() || "(no text)";
    items.push({
      index: items.length + 1,
      label,
      box: clampBox(
        toOriginal(box, scale),
        originalWidth,
        originalHeight,
      ),
    });
  }
  return items;
}

export const INSPECT_TOOL: VisionToolEntry<InspectArgs> = {
  tool: {
    name: "inspect",
    description:
      "枚举图片中所有同类元素，返回编号列表（含可见文字 + 原图像素坐标）。" +
      VISION_TOOL_GATE +
      "用于盘点页面/界面布局（如「列出所有按钮」「列出所有输入框」）。" +
      "建议先 inspect 扫布局，再 locate 定位具体目标，最后 see_image 的 region 放大细节。" +
      "密集屏幕可缩小 kind 范围分多次调用。",
    inputSchema: {
      type: "object",
      properties: {
        source: singleSourceProperty,
        kind: {
          type: "string",
          description:
            '要枚举的元素类型，如 "buttons"（按钮）、"links"（链接）、"inputs"（输入框）、"icons"（图标）。省略则枚举所有常见 UI 元素。',
        },
      },
      required: ["source"],
    },
  },
  schema: inspectSchema,
  needsVision: true,
  async run(
    args: InspectArgs,
    config: AppConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const pool = deps.pool ?? getGlobalPool(config.J_SEE_MAX_CONCURRENT);
    const deadline = Date.now() + config.J_SEE_TIMEOUT_MS;
    const limits = limitsOf(config);
    const raw = await readSource(args.source, deps.reader);

    const kind = args.kind?.trim() || DEFAULT_KIND;
    const prompt =
      `Find all "${kind}" elements in the image.\n` +
      "Return one line per element, strictly in this format:\n" +
      "<index>. <visible text> x1: <n>, y1: <n>, x2: <n>, y2: <n>\n" +
      "Coordinates are in image pixels (origin at top-left). " +
      "For elements without text, write (no text).\n" +
      "Do not output anything else.";

    const r = await runManagedVisionCall<{
      scale: number;
      originalWidth: number;
      originalHeight: number;
    }>(
      {
        buildImages: async (maxEdge) => {
          const img = await processImageWithScale(raw, {
            ...limits,
            maxEdge,
          });
          return {
            images: [{ base64: img.base64, mime: img.mime }],
            meta: {
              scale: img.scale,
              originalWidth: img.originalWidth,
              originalHeight: img.originalHeight,
            },
          };
        },
        prompt,
        maxTokens: INSPECT_MAX_TOKENS,
        fullMaxEdge: limits.maxEdge,
        degradable: limits.maxEdge > DEGRADE_EDGE,
        deadline,
        label: "inspect",
        busyHint: "可稍后重试，或缩小 kind 范围减少输出。",
      },
      {
        config,
        pool,
        ctx: newCallContext(),
        fetchImpl: deps.fetchImpl,
        sleepImpl: deps.sleepImpl,
        tuning: deps.tuning,
      },
    );
    const notice = degradeNotice(r.degraded);

    // 换算用 meta 里的 scale —— 与实际发送的那张图（可能已降质）严格对应
    const items = parseInspectLines(
      r.text,
      r.meta.scale,
      r.meta.originalWidth,
      r.meta.originalHeight,
    );
    if (items.length === 0) {
      return `未检测到「${kind}」。模型返回原文：\n${r.text}${notice}`;
    }
    return (
      items.map((i) => `${i.index}. ${i.label} ${formatBox(i.box)}`).join("\n") +
      notice
    );
  },
};
