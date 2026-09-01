/**
 * see_image 工具：读取图片 → 预处理 → 调视觉模型返回文字描述。
 *
 * 支持 region（先裁后看，局部放大）、多图对比（source 传数组，一次上游调用）、
 * each 批量模式（逐图独立识别，each.ts）、max_edge（调用方按精度需求控制
 * 发送分辨率 —— 粗看传小值省时间，精细看传大值）。
 * 现有 see_image({source, prompt}) 调用方式 100% 向后兼容。
 */
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { readSource } from "../sources/index.js";
import { processImage, cropAndProcess } from "../image.js";
import {
  runManagedVisionCall,
  degradeNotice,
  DEGRADE_EDGE,
  type PreparedImages,
} from "../retry.js";
import { getGlobalPool, newCallContext } from "../pool.js";
import { runEachBatch } from "./each.js";
import {
  limitsOf,
  sourceSchema,
  regionSchema,
  sourceProperty,
  regionProperty,
  VISION_TOOL_GATE,
  type ToolDeps,
  type VisionToolEntry,
} from "./types.js";

export const DEFAULT_PROMPT =
  "Describe this image in detail, including text, UI elements, colors, and layout. " +
  "If any detail (color shade, texture, count, etc.) cannot be confirmed with certainty, " +
  'say "cannot confirm" explicitly — do not speculate or invent.';

export const seeImageSchema = z
  .object({
    source: sourceSchema,
    prompt: z.string().optional(),
    region: regionSchema,
    max_edge: z.coerce.number().int().min(64).max(4096).optional(),
    each: z.boolean().optional(),
  })
  .refine((v) => !(v.region && v.source.length > 1), {
    message: "region 仅支持单图，多图对比时不能指定 region",
  })
  .refine((v) => !(v.each && v.region), {
    message:
      "each 批量模式不支持 region（逐图独立识别不做裁剪；需要局部识别请先用 crop 裁出后再批量）",
  });

export type SeeImageArgs = z.infer<typeof seeImageSchema>;

export const SEE_IMAGE_TOOL: VisionToolEntry<SeeImageArgs> = {
  tool: {
    name: "see_image",
    description:
      "读取图片（本地文件 / URL / 剪贴板 / 最近截图）并通过视觉模型返回文字描述。" +
      VISION_TOOL_GATE +
      "支持多图对比（source 传数组），" +
      "支持 region 局部放大（先裁后看，常配合 locate/inspect 返回的坐标）。" +
      "多张独立识图（每张各自识别而非互相对比）传 each: true —— 一次调用自动排队并发，" +
      "总预算内做完几张是几张，未处理的返回续调参数，续调到清空即完成。" +
      "max_edge 控制发送分辨率：粗看传小值（如 512）显著加速，精细看用默认。",
    inputSchema: {
      type: "object",
      properties: {
        source: sourceProperty,
        prompt: {
          type: "string",
          description:
            "对图片的提问或指令，省略则默认详细描述图片内容与其中文字。多图时用于描述对比/问答意图。" +
            "描述类提问建议开放式（避免「有没有 X」的引导式问法，会诱导模型确认）；" +
            "模型输出的颜色/尺寸/数量只是参考，像素级事实以本地工具（colors/image_diff）为准。" +
            "prompt 建议用英文写（视觉模型对英文指令遵循更稳），需要中文输出时在 prompt 末尾说明。",
        },
        region: regionProperty,
        max_edge: {
          type: "number",
          description:
            "发送给视觉模型的长边像素上限（64-4096，默认取 J_SEE_MAX_EDGE=1568）。" +
            "粗看/分类传小值（如 512）省一半以上时间；显式指定后超时不再自动降质。",
        },
        each: {
          type: "boolean",
          description:
            "true 时对 source 数组逐图独立识别（同一 prompt 应用于每张），" +
            "替代并行发多个单图调用。返回逐图编号结果；未处理的图附续调参数。",
        },
      },
      required: ["source"],
    },
  },
  schema: seeImageSchema,
  needsVision: true,
  async run(
    args: SeeImageArgs,
    config: AppConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const pool = deps.pool ?? getGlobalPool(config.J_SEE_MAX_CONCURRENT);

    // each 批量：逐图独立识别（含单图 —— 输出格式统一，续调剩 1 张时不突变）
    if (args.each) {
      return runEachBatch(
        {
          sources: args.source,
          prompt: args.prompt ?? DEFAULT_PROMPT,
          maxEdge: args.max_edge,
        },
        config,
        deps,
        pool,
      );
    }

    // 对比/单图模式：一次上游调用（占一个池槽位），J_SEE_TIMEOUT_MS 为总预算
    const deadline = Date.now() + config.J_SEE_TIMEOUT_MS;
    const limits = limitsOf(config);
    // source 经 schema transform 后必为数组，单值是长度 1 的特例；
    // 读取并行化（读的是原始字节，解码在 buildImages 内进行）
    const raws = await Promise.all(
      args.source.map((src) => readSource(src, deps.reader)),
    );
    const fullMaxEdge = args.max_edge ?? limits.maxEdge;
    const degradable = args.max_edge == null && fullMaxEdge > DEGRADE_EDGE;

    const buildImages = async (
      maxEdge: number,
    ): Promise<PreparedImages<void>> => {
      const scoped = { ...limits, maxEdge };
      const images = await Promise.all(
        raws.map((raw) =>
          args.region
            ? cropAndProcess(raw, args.region!, scoped)
            : processImage(raw, scoped),
        ),
      );
      return { images, meta: undefined };
    };

    const r = await runManagedVisionCall(
      {
        buildImages,
        prompt: args.prompt ?? DEFAULT_PROMPT,
        fullMaxEdge,
        degradable,
        deadline,
        label: "see_image",
        busyHint:
          "多张独立识图请改用 each: true 批量模式（一次调用自动排队），或稍后重试。",
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
    return r.text + degradeNotice(r.degraded);
  },
};
