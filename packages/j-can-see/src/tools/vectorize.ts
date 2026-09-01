/**
 * 本地矢量化工具（不调视觉模型）：trace / extract_fg。
 *
 * - trace：把扁平高对比图形（线框图/图标/流程图）矢量化为 SVG。
 *   固有限制：照片/复杂渐变效果差（矢量化算法本质）。
 * - extract_fg：把图标前景从背景中分离，输出透明 PNG。
 */
import { z } from "zod";
import { ImageTracer } from "@image-tracer-ts/core";
import type { BaseConfig } from "../config.js";
import { decodeJimp, resolveRegion } from "../image.js";
import { readSource } from "../sources/index.js";
import { expandPath } from "../sources/file.js";
import { createColorClusters, hexToRgb, linearColorDiff, type Rgb } from "./color.js";
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
    const svg = tracer.traceImageToSvg(input as never);

    if (args.output) {
      const outPath = expandPath(args.output);
      await writeOutput(outPath, svg);
      return `已矢量化并保存到 ${outPath}（${image.width}×${image.height}，SVG ${svg.length} 字符）`;
    }
    return svg;
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
      : sampleBackground(data, w, h);

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

/**
 * 采样图片四角与边缘中点，取出现最多的颜色作为背景估计。
 *
 * 走 createColorClusters：量化值只作分桶键，返回的是**簇内真实均值**。
 * 直接返回量化值会带来最多 7/通道的偏差 —— 实测背景 #FEFEFE 被量化成
 * #F8F8F8 后色差为 7，threshold=4 的精确抠图会把整张背景判成前景
 *（1600/1600 像素皆前景，等于原图原样输出）。
 */
function sampleBackground(data: Buffer, w: number, h: number): Rgb {
  const pts: ReadonlyArray<readonly [number, number]> = [
    [0, 0],
    [w - 1, 0],
    [0, h - 1],
    [w - 1, h - 1],
    [Math.floor(w / 2), 0],
    [0, Math.floor(h / 2)],
  ];
  const clusters = createColorClusters();
  for (const [x, y] of pts) {
    const idx = (y * w + x) * 4;
    clusters.add(data[idx], data[idx + 1], data[idx + 2]);
  }
  // 采样点恒 ≥ 1，result() 必非空
  return clusters.result()[0].rgb;
}
