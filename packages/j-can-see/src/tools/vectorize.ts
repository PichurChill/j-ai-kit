/**
 * 本地矢量化工具（不调视觉模型）：trace / extract_fg。
 *
 * - trace：把扁平高对比图形（线框图/图标/流程图）矢量化为 SVG。
 *   固有限制：照片/复杂渐变效果差（矢量化算法本质）。
 * - extract_fg：把图标前景从背景中分离，输出透明 PNG。
 */
import { z } from "zod";
import { ResizeStrategy } from "jimp";
import { ImageTracer } from "@image-tracer-ts/core";
import type { BaseConfig } from "../config.js";
import { decodeJimp, resolveRegion } from "../image.js";
import { readSource } from "../sources/index.js";
import { expandPath } from "../sources/file.js";
import {
  sampleBackgroundCorners,
  hexToRgb,
  linearColorDiff,
} from "./color.js";
import { writeOutput, deriveDefaultOutput, OUTPUT_PATH_CONVENTION } from "./output.js";
import {
  limitsOf,
  regionSchema,
  regionProperty,
  singleSourceSchema,
  type ToolDeps,
  type LocalToolEntry,
} from "./types.js";

// ---------- trace ----------

/**
 * 自动放大阈值：短边小于此值的图先放大再描摹 —— 矢量化器的 speckle 过滤
 * 会把 1x 下的小图标直接打成空（30px 图标放大后才能干净出形）。
 * （avt trace 的 TARGET_MIN_SIDE 同源论据）
 */
const TRACE_MIN_SIDE = 256;

/**
 * 把 SVG 根元素的 width/height 设为指定尺寸（缺失则插入；viewBox 不动，
 * 渲染器按 viewBox→width 比例缩放）。image-tracer 的输出只有 viewBox、
 * 无 width/height —— 放大描摹后若不写回，渲染尺寸会是放大图的。
 */
function rescaleSvgSize(svg: string, w: number, h: number): string {
  return svg.replace(/<svg\b([^>]*)>/, (_m, attrs: string) => {
    let fixed = attrs;
    if (/\swidth="[\d.]+"/.test(fixed)) {
      fixed = fixed.replace(/\swidth="[\d.]+"/, ` width="${w}"`);
    } else {
      fixed = ` width="${w}"${fixed}`;
    }
    if (/\sheight="[\d.]+"/.test(fixed)) {
      fixed = fixed.replace(/\sheight="[\d.]+"/, ` height="${h}"`);
    } else {
      fixed = ` height="${h}"${fixed}`;
    }
    return `<svg${fixed}>`;
  });
}

/** 0-path 时的恢复阶梯（按成本从低到高），避免调用方退回"凭感觉猜形状" */
const TRACE_EMPTY_RECOVERY =
  "描摹结果为空（没有任何路径在二值化后存活）。依次尝试：" +
  "① 传更小的 region 收紧到图形本体；② 换成亮色系图或预先反转（浅色图形在浅背景上会被当背景剔除）；" +
  "③ 提高 colors（调色板更大，牺牲简洁）；④ 照片/复杂渐变不适合 trace —— 这是算法边界，不要硬试。";

export const traceSchema = z.object({
  source: singleSourceSchema,
  region: regionSchema,
  colors: z.number().int().min(2).max(64).optional(),
  output: z.string().optional(),
});
export type TraceArgs = z.infer<typeof traceSchema>;

/**
 * image-tracer-ts 的 traceImageToSvg 签名要 DOM 的 ImageData，
 * 但实现只读 data/width/height 三个字段。本项目 lib 为 ES2022（无 DOM），
 * 拿不到 ImageData 类型，因此递参时必须有一次断言。
 * data 用零拷贝视图构造为真正的 Uint8ClampedArray —— 不是谎报类型，
 * 只是把结构等价的对象递给一个签名过窄的 API。
 */
interface TracerImageData {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

export const TRACE_TOOL: LocalToolEntry<TraceArgs> = {
  tool: {
    name: "trace",
    description:
      "把图片中的扁平高对比图形矢量化为 SVG（本地操作，不调视觉模型）。" +
      "适合线框图、简单图标、流程图、手绘草图转可编辑矢量。" +
      "注意：照片、复杂渐变、阴影丰富的图矢量化效果差。" +
      "指定 output 写入 .svg 文件；省略则直接返回 SVG 内容。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "图片来源" },
        region: regionProperty,
        colors: {
          type: "number",
          description: "调色板颜色数（2-64，默认 16）。色块越少越简洁",
        },
        output: {
          type: "string",
          description:
            "输出 .svg 文件路径（支持 ~ 展开）。省略则返回 SVG 字符串内容。" +
            OUTPUT_PATH_CONVENTION,
        },
      },
      required: ["source"],
    },
  },
  schema: traceSchema,
  needsVision: false,
  async run(
    args: TraceArgs,
    config: BaseConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const raw = await readSource(args.source, deps.reader);
    const image = await decodeJimp(raw, limitsOf(config));
    if (args.region) {
      const box = resolveRegion(args.region, image.width, image.height);
      image.crop({ x: box.x, y: box.y, w: box.w, h: box.h });
    }

    // 小图自动放大再描摹（speckle 过滤会打掉 1x 小图标）；
    // 记下原始尺寸，描摹后把 SVG 的 width/height 写回原图尺寸（viewBox 保持放大坐标）
    const origW = image.width;
    const origH = image.height;
    const minSide = Math.min(origW, origH);
    let traceScale = 1;
    if (minSide < TRACE_MIN_SIDE) {
      traceScale = Math.max(2, Math.ceil(TRACE_MIN_SIDE / minSide));
      image.scale({ f: traceScale, mode: ResizeStrategy.BICUBIC });
    }

    const pixels = image.bitmap.data;
    const input: TracerImageData = {
      data: new Uint8ClampedArray(
        pixels.buffer,
        pixels.byteOffset,
        pixels.byteLength,
      ),
      width: image.width,
      height: image.height,
    };

    const tracer = new ImageTracer({ numberOfColors: args.colors ?? 16 });
    let svg = tracer.traceImageToSvg(input as never);
    if (traceScale > 1) {
      svg = rescaleSvgSize(svg, origW, origH);
    }
    const pathCount = (svg.match(/<path/g) ?? []).length;

    if (pathCount === 0) {
      // 空结果配恢复阶梯：比返回一段空 SVG 更能阻止调用方退回目测猜形状
      if (args.output) {
        const outPath = expandPath(args.output);
        await writeOutput(outPath, svg);
        return `已保存到 ${outPath}，但 ${TRACE_EMPTY_RECOVERY}`;
      }
      return TRACE_EMPTY_RECOVERY;
    }

    const scaleNote =
      traceScale > 1
        ? `，已自动放大 ${traceScale}× 描摹，SVG width/height 已设回原图尺寸（viewBox 为放大坐标）`
        : "";
    if (args.output) {
      const outPath = expandPath(args.output);
      await writeOutput(outPath, svg);
      return `已矢量化并保存到 ${outPath}（${origW}×${origH}，SVG ${svg.length} 字符${scaleNote}）`;
    }
    return traceScale > 1 ? `（${scaleNote.slice(1)}）\n${svg}` : svg;
  },
};

// ---------- extract_fg ----------

export const extractFgSchema = z.object({
  source: singleSourceSchema,
  region: regionSchema,
  background: z.string().optional(),
  threshold: z.number().min(0).max(255).optional(),
  output: z.string().optional(),
});
export type ExtractFgArgs = z.infer<typeof extractFgSchema>;

/**
 * 前景判定阈值（0-255，线性色差 = 三通道绝对差的最大值）。
 * 与背景色差 ≤ threshold 的像素视为背景（透明化）——
 * 值越小保留越多，越大抠除越狠。
 */
const DEFAULT_FG_THRESHOLD = 64;

export const EXTRACT_FG_TOOL: LocalToolEntry<ExtractFgArgs> = {
  tool: {
    name: "extract_fg",
    description:
      "把图标/前景从背景中分离，输出透明 PNG（本地操作，不调视觉模型）。" +
      "背景色默认从图片四角自动采样；可显式指定 background。" +
      "用于提取 logo / 图标素材为可复用的透明 PNG。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "图片来源" },
        region: regionProperty,
        background: {
          type: "string",
          description: "背景色 hex（如 #ffffff）。省略则自动采样四角估计",
        },
        threshold: {
          type: "number",
          description:
            "前景/背景判定阈值（线性色差 0-255，默认 64）：与背景色差 ≤ 该值的像素透明化。越小保留越多，越大抠除越狠",
        },
        output: {
          type: "string",
          description:
            "输出 .png 文件路径（支持 ~ 展开）。省略时要求 source 为本地文件路径（同目录生成 _fg.png）；URL/clipboard/latest 必传。" +
            OUTPUT_PATH_CONVENTION,
        },
      },
      required: ["source"],
    },
  },
  schema: extractFgSchema,
  needsVision: false,
  async run(
    args: ExtractFgArgs,
    config: BaseConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const threshold = args.threshold ?? DEFAULT_FG_THRESHOLD;
    // 输出路径决策放在读取之前：非文件 source 缺 output 时直接报错
    const outPath = args.output
      ? expandPath(args.output)
      : deriveDefaultOutput(args.source, "_fg", ".png");
    const raw = await readSource(args.source, deps.reader);
    const image = await decodeJimp(raw, limitsOf(config));
    if (args.region) {
      const box = resolveRegion(args.region, image.width, image.height);
      image.crop({ x: box.x, y: box.y, w: box.w, h: box.h });
    }

    const w = image.width;
    const h = image.height;
    const data = image.bitmap.data;
    const bg = args.background
      ? hexToRgb(args.background)
      : sampleBackgroundCorners(data, w, h);

    let fgPixels = 0;
    const total = w * h;
    for (let i = 0; i < total; i++) {
      const r = data[i * 4];
      const g = data[i * 4 + 1];
      const b = data[i * 4 + 2];
      // 线性色差（三通道绝对差最大值，0-255）：与背景差 ≤ 阈值 → 背景透明化
      if (linearColorDiff({ r, g, b }, bg) <= threshold) {
        data[i * 4 + 3] = 0;
      } else {
        fgPixels++;
      }
    }

    await writeOutput(outPath, await image.getBuffer("image/png"));

    let result = `已提取前景并保存到 ${outPath}（${fgPixels}/${total} 像素为前景）`;
    if (fgPixels === 0) {
      result +=
        "\n警告：没有任何像素被判定为前景，输出是全透明图。可尝试调小 threshold 或显式指定 background。";
    }
    return result;
  },
};
