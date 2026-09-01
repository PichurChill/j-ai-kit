/**
 * locate 工具：在图片中定位单个目标，返回像素坐标（已换算为原图坐标）。
 *
 * 坐标系与 see_image/inspect 的 region 一致，
 * AI 可直接把返回坐标喂给 see_image --region 放大查看。
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

/** locate/inspect 共用：缩放图与坐标换算所需的元数据（随降质档位变化） */
interface ScaleMeta {
  readonly scale: number;
  readonly originalWidth: number;
  readonly originalHeight: number;
}

export const locateSchema = z.object({
  source: singleSourceSchema,
  target: z.string().min(1, "target 不能为空"),
});

export type LocateArgs = z.infer<typeof locateSchema>;

export const LOCATE_TOOL: VisionToolEntry<LocateArgs> = {
  tool: {
    name: "locate",
    description:
      "在图片中定位单个目标，返回其像素坐标（已换算为原图坐标，格式 x1,y1,x2,y2）。" +
      VISION_TOOL_GATE +
      "用于 GUI 自动化（定位控件后操作）或粗到细分析（定位后用 see_image 的 region 放大查看）。" +
      "返回坐标可直接作为 see_image/crop 的 region 参数。",
    inputSchema: {
      type: "object",
      properties: {
        source: singleSourceProperty,
        target: {
          type: "string",
          description: "要定位的目标描述，如「发送按钮」「用户名输入框」「右上角的头像」",
        },
      },
      required: ["source", "target"],
    },
  },
  schema: locateSchema,
  needsVision: true,
  async run(
    args: LocateArgs,
    config: AppConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const pool = deps.pool ?? getGlobalPool(config.J_SEE_MAX_CONCURRENT);
    const deadline = Date.now() + config.J_SEE_TIMEOUT_MS;
    const limits = limitsOf(config);
    const raw = await readSource(args.source, deps.reader);

    const prompt =
      `Locate "${args.target}" in the image.\n` +
      "Return exactly one line in this format (coordinates in pixels, origin at top-left):\n" +
      "x1: <n>, y1: <n>, x2: <n>, y2: <n>\n" +
      "If not found, return only: NOT_FOUND\n" +
      "Do not output anything else.";

    const r = await runManagedVisionCall<ScaleMeta>(
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
        fullMaxEdge: limits.maxEdge,
        degradable: limits.maxEdge > DEGRADE_EDGE,
        deadline,
        label: "locate",
        busyHint: "可稍后重试，或先用 crop 裁出目标区域后在局部图上重试。",
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
    const text = r.text;
    const notice = degradeNotice(r.degraded);

    if (/NOT_FOUND/i.test(text.trim())) {
      return (
        `未找到目标「${args.target}」。可尝试：` +
        `① 长图/高图会被等比压缩（长边上限 ${config.J_SEE_MAX_EDGE}px），` +
        `小目标可能因此不可辨 —— 先用 crop 裁出大致区域，在局部图上重新 locate；` +
        `② 改用 inspect 枚举全部元素后自行挑选；` +
        `③ 大块纯色背景区域不是模型认得的「元素」，定位背景区块请改用 colors` +
        `（profile/region 做像素探测）或以 inspect 找到的邻近元素反推` +
        notice
      );
    }

    // 按行提取坐标框：模型返回多个匹配时全部列出（静默取首个会误导 GUI 自动化）。
    // 换算用 meta 里的 scale —— 与实际发送的那张图（可能已降质）严格对应
    const toOrig = (b: Box) =>
      clampBox(
        toOriginal(b, r.meta.scale),
        r.meta.originalWidth,
        r.meta.originalHeight,
      );
    const lineBoxes = text
      .split("\n")
      .map((l) => extractBoxByLabel(l.trim()))
      .filter((b): b is Box => b != null)
      .map(toOrig);
    const boxes =
      lineBoxes.length > 0
        ? lineBoxes
        : (() => {
            // 行级解析不到时退回整段解析（模型可能把坐标和说明写在同一行）
            const b = extractBoxByLabel(text);
            return b ? [toOrig(b)] : [];
          })();

    if (boxes.length === 0) {
      return `无法解析坐标，模型返回原文：\n${text}${notice}`;
    }
    if (boxes.length === 1) {
      return `找到「${args.target}」：${formatBox(boxes[0])}${notice}`;
    }
    return (
      `找到 ${boxes.length} 个「${args.target}」匹配（target 描述可能过于宽泛，` +
      `建议细化后重试；已全部列出）：\n` +
      boxes.map((b, i) => `${i + 1}. ${formatBox(b)}`).join("\n") +
      notice
    );
  },
};
