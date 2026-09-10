/**
 * 本地像素工具（不调视觉模型）：crop / image_diff / colors。
 * 纯 jimp 操作，像素级精确，无需视觉配置。
 *
 * 核心原则：像素级事实（颜色/差异/尺寸）不信任视觉模型的文字描述，
 * 用这些本地工具取真值。
 */
import { z } from "zod";
import { ResizeStrategy } from "jimp";
import type { BaseConfig } from "../config.js";
import { decodeJimp, resolveRegion } from "../image.js";
import { readSource } from "../sources/index.js";
import { expandPath } from "../sources/file.js";
import {
  createColorClusters,
  mergeClusters,
  sampleBackgroundCorners,
  hexToRgb,
  rgbToHex,
  linearColorDiff,
  scanAxisProfile,
  segmentAxisProfile,
  type ProfileSegment,
  type ProfileJump,
  type Rgb,
} from "./color.js";
import { writeOutput, deriveDefaultOutput, encodeForOutput, OUTPUT_PATH_CONVENTION } from "./output.js";
import {
  limitsOf,
  regionSchema,
  regionRequiredSchema,
  regionProperty,
  singleSourceSchema,
  type ToolDeps,
  type LocalToolEntry,
} from "./types.js";

// ---------- crop ----------

export const cropSchema = z.object({
  source: singleSourceSchema,
  region: regionRequiredSchema,
  output: z.string().optional(),
  scale: z.number().positive().optional(),
});
export type CropArgs = z.infer<typeof cropSchema>;

export const CROP_TOOL: LocalToolEntry<CropArgs> = {
  tool: {
    name: "crop",
    description:
      "按坐标从图片裁剪区域并保存为文件（本地像素操作，不调视觉模型）。" +
      "常用于保存 locate/inspect 定位的区域供后续复用，或放大局部以便看清。" +
      "坐标用原图像素（轻微越界会自动收进图片边界），与 locate/inspect 输出直接对应。" +
      "省略 output 时要求 source 为本地文件路径（在源文件同目录生成 _crop.png）；URL/clipboard/latest 必须传 output。",
    inputSchema: {
      type: "object",
      properties: {
        source: {
          type: "string",
          description: "图片来源（本地路径 / URL / latest / clipboard）",
        },
        region: regionProperty,
        output: {
          type: "string",
          description:
            "输出文件路径（支持 ~ 展开；按扩展名编码：.png → PNG，.jpg/.jpeg → JPEG）。URL/clipboard/latest 来源时必填。" +
            OUTPUT_PATH_CONVENTION,
        },
        scale: {
          type: "number",
          description:
            "缩放倍数（BICUBIC）：≤2-3 倍用于看清结构（放大不增加信息，超倍会出现插值伪影，" +
            "模型可能在数伪影而不是原图内容）；要精确颜色/纹理不要放大 —— 用 colors + region 在原图上取，" +
            "色值不经过压缩编码影响。>1 放大（如 2 = 2 倍），<1 缩小（如 0.5，可用于把图对齐到目标尺寸）",
        },
      },
      required: ["source", "region"],
    },
  },
  schema: cropSchema,
  needsVision: false,
  async run(
    args: CropArgs,
    config: BaseConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    // 输出路径决策放在读取之前：非文件 source 缺 output 时直接报错，
    // 不白做一次下载/剪贴板读取
    const outPath = args.output
      ? expandPath(args.output)
      : deriveDefaultOutput(args.source, "_crop", ".png");
    const raw = await readSource(args.source, deps.reader);
    const image = await decodeJimp(raw, limitsOf(config));
    const box = resolveRegion(args.region, image.width, image.height);
    image.crop({ x: box.x, y: box.y, w: box.w, h: box.h });
    if (args.scale) {
      image.scale({ f: args.scale, mode: ResizeStrategy.BICUBIC });
    }
    await writeOutput(outPath, await encodeForOutput(image, outPath));
    return `已裁剪并保存到 ${outPath}（${image.width}×${image.height}）`;
  },
};

// ---------- image_diff ----------

export const diffSchema = z.object({
  a: z.string().min(1, "a 不能为空"),
  b: z.string().min(1, "b 不能为空"),
  threshold: z.number().min(0).max(765).optional(),
});
export type DiffArgs = z.infer<typeof diffSchema>;

/** 默认像素差异阈值：三通道绝对差之和超过此值视为不同（黑白差=765） */
const DEFAULT_DIFF_THRESHOLD = 48;

/** 透明度容差：低于此值的 alpha 差异视为编码噪声 */
const ALPHA_TOLERANCE = 8;

/** 网格等分数（差异定位的粒度） */
const DIFF_GRID = 12;

interface DiffRegion {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
  readonly rate: number;
}

/**
 * 把 diff 像素按固定网格分块，返回 diff 密度最高的若干块。
 *
 * 注意这是**网格块**而非精确包围盒：相邻块不合并，一处横跨网格线的改动
 * 会报成 2-4 个块。用于粗定位「去哪儿看」，够用且可预期。
 */
function clusterDiffRegions(
  diffMap: Uint8Array,
  w: number,
  h: number,
  gridSize = DIFF_GRID,
): DiffRegion[] {
  const cellW = Math.max(1, Math.ceil(w / gridSize));
  const cellH = Math.max(1, Math.ceil(h / gridSize));
  const regions: DiffRegion[] = [];
  for (let cy = 0; cy < gridSize; cy++) {
    for (let cx = 0; cx < gridSize; cx++) {
      const x0 = cx * cellW;
      const y0 = cy * cellH;
      const x1m = Math.min(x0 + cellW, w);
      const y1m = Math.min(y0 + cellH, h);
      let diff = 0;
      let total = 0;
      for (let y = y0; y < y1m; y++) {
        for (let x = x0; x < x1m; x++) {
          total++;
          if (diffMap[y * w + x]) diff++;
        }
      }
      const rate = total > 0 ? diff / total : 0;
      if (rate > 0.1) {
        regions.push({ x1: x0, y1: y0, x2: x1m, y2: y1m, rate });
      }
    }
  }
  return regions.sort((p, q) => q.rate - p.rate).slice(0, 5);
}

export const IMAGE_DIFF_TOOL: LocalToolEntry<DiffArgs> = {
  tool: {
    name: "image_diff",
    description:
      "逐像素比较两张图片，返回总差异比例 + 差异密度最高的网格块坐标（本地操作，不调视觉模型）。" +
      "用于「写代码→截图→对比」循环定位变化，或对比设计稿与实现。返回的块坐标可喂给 see_image 的 region 查看具体变化。" +
      "两图尺寸不同时自动以面积较小者为基准对齐（坐标以基准图为准；宽高比不同会拉伸，差异会计入结果）。" +
      "含透明像素时：双方全透明的像素视为相同，透明度变化直接计为差异。",
    inputSchema: {
      type: "object",
      properties: {
        a: { type: "string", description: "第一张图片来源" },
        b: { type: "string", description: "第二张图片来源" },
        threshold: {
          type: "number",
          description:
            "像素差异阈值（三通道绝对差之和，0-765，默认 48）。越小越敏感",
        },
      },
      required: ["a", "b"],
    },
  },
  schema: diffSchema,
  needsVision: false,
  async run(
    args: DiffArgs,
    config: BaseConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const threshold = args.threshold ?? DEFAULT_DIFF_THRESHOLD;
    const limits = limitsOf(config);
    const [bufA, bufB] = await Promise.all([
      readSource(args.a, deps.reader),
      readSource(args.b, deps.reader),
    ]);
    const imgA = await decodeJimp(bufA, limits);
    const imgB = await decodeJimp(bufB, limits);

    // 尺寸不一则以面积较小者为基准对齐（另一图 resize 到基准尺寸）。
    // 面积基准使结果不受参数顺序影响；实现截图通常是两者中较小者，
    // 坐标以基准图（ref）为准，region 回喂目标明确。
    // 宽高比一致时对齐是纯缩小（不引入放大模糊）；宽高比不同则是拉伸，
    // 差异会计入结果并在输出中披露
    const aSize = `${imgA.width}×${imgA.height}`;
    const bSize = `${imgB.width}×${imgB.height}`;
    const sizeMismatch =
      imgA.width !== imgB.width || imgA.height !== imgB.height;
    const refIsA = imgA.width * imgA.height <= imgB.width * imgB.height;
    if (sizeMismatch) {
      const ref = refIsA ? imgA : imgB;
      (refIsA ? imgB : imgA).resize({ w: ref.width, h: ref.height });
    }
    const refName = refIsA ? "A" : "B";

    const dataA = imgA.bitmap.data;
    const dataB = imgB.bitmap.data;
    const total = imgA.width * imgA.height;
    const diffMap = new Uint8Array(total);
    let diffPixels = 0;
    for (let i = 0; i < total; i++) {
      const alphaA = dataA[i * 4 + 3];
      const alphaB = dataB[i * 4 + 3];
      // 双方全透明：RGB 通道是未定义值，视觉上相同
      if (alphaA === 0 && alphaB === 0) continue;
      // 透明度变化即视觉变化，与 RGB 阈值无关
      if (Math.abs(alphaA - alphaB) > ALPHA_TOLERANCE) {
        diffMap[i] = 1;
        diffPixels++;
        continue;
      }
      const d =
        Math.abs(dataA[i * 4] - dataB[i * 4]) +
        Math.abs(dataA[i * 4 + 1] - dataB[i * 4 + 1]) +
        Math.abs(dataA[i * 4 + 2] - dataB[i * 4 + 2]);
      if (d > threshold) {
        diffMap[i] = 1;
        diffPixels++;
      }
    }
    const pct = (diffPixels / total) * 100;
    const regions = clusterDiffRegions(diffMap, imgA.width, imgA.height);

    let out = `${
      sizeMismatch
        ? `注意：两图尺寸不同（A ${aSize}，B ${bSize}），已按面积较小者（${refName}）为基准对齐后比较，坐标以 ${refName} 为准；宽高比差异会计入差异。\n`
        : ""
    }差异比例：${pct.toFixed(2)}%（${diffPixels}/${total} 像素）`;
    if (regions.length > 0) {
      out +=
        `\n差异密度最高的网格块（${DIFF_GRID}×${DIFF_GRID} 等分，非精确包围盒；可喂给 see_image 的 region）：\n` +
        regions
          .map(
            (r, i) =>
              `${i + 1}. x1: ${r.x1}, y1: ${r.y1}, x2: ${r.x2}, y2: ${r.y2}（块内 ${(
                r.rate * 100
              ).toFixed(0)}% 不同）`,
          )
          .join("\n");
    } else {
      out += "\n无明显差异区域。";
    }
    return out;
  },
};

// ---------- colors ----------

export const colorsSchema = z.object({
  source: singleSourceSchema,
  region: regionSchema,
  top: z.number().int().positive().max(32).optional(),
  candidates: z.array(z.string()).min(1).optional(),
  profile: z.enum(["x", "y"]).optional(),
  exclude_background: z.boolean().optional(),
});
export type ColorsArgs = z.infer<typeof colorsSchema>;

/** 相近簇提示的判定阈值：两个主色的最大通道差 ≤ 此值且 >0 时提示（实测细微色差 Δ=6，量化跨桶 ≤8） */
const NEAR_CLUSTER_DIFF = 16;

/** profile 噪声护栏：超过此分段/跳变数视为纹理噪声，不再逐段罗列 */
const PROFILE_MAX_SEGMENTS = 24;
const PROFILE_MAX_JUMPS = 16;

/** 段起点终点各通道差均 ≤ 此值时判定为纯色（否则按渐变报告 Δ） */
const FLAT_SEGMENT_DIFF = 2;

/** 背景排除：与四角采样背景色的最大通道差 ≤ 此值的像素视为背景 */
const BG_EXCLUDE_DIFF = 24;

/** 主色占比超过此值视为「背景统治」形态，自动追加背景排除视图 */
const BG_DOMINANT_TRIGGER_PCT = 60;

/** 候选色逐像素评分的容差：色差 ≤ 此值计入覆盖，越近权重越高 */
const CANDIDATE_TOL = 16;

function formatRgbDelta(a: Rgb, b: Rgb): string {
  const parts: string[] = [];
  const channels: Array<[string, number, number]> = [
    ["R", a.r, b.r],
    ["G", a.g, b.g],
    ["B", a.b, b.b],
  ];
  for (const [name, va, vb] of channels) {
    const d = Math.round(Math.abs(va - vb));
    if (d > 0) parts.push(`Δ${name}=${d}`);
  }
  return parts.join(", ");
}

function formatSegment(seg: ProfileSegment, axis: "x" | "y"): string {
  const color = `${rgbToHex(seg.start.r, seg.start.g, seg.start.b)}`;
  const delta = formatRgbDelta(seg.start, seg.end);
  const range = `${axis}=${seg.from}~${seg.to}`;
  if (!delta || linearColorDiff(seg.start, seg.end) <= FLAT_SEGMENT_DIFF) {
    return `${range}：${color}（纯色）`;
  }
  return `${range}：${color} → ${rgbToHex(seg.end.r, seg.end.g, seg.end.b)}（渐变 ${delta}）`;
}

function formatProfile(
  segments: ProfileSegment[],
  jumps: ProfileJump[],
  axis: "x" | "y",
): string {
  if (segments.length > PROFILE_MAX_SEGMENTS || jumps.length > PROFILE_MAX_JUMPS) {
    const top = [...jumps].sort((p, q) => q.diff - p.diff).slice(0, 5);
    return (
      `分段过多（${segments.length} 段 / ${jumps.length} 处跳变），多为纹理噪声 —— ` +
      `profile 适合大面积纯色/渐变区域，可先用 region 缩小范围。变化最大的位置：\n` +
      (top.length > 0
        ? top
            .map(
              (j, i) =>
                `${i + 1}. ${axis}=${j.at}：${rgbToHex(j.from.r, j.from.g, j.from.b)} → ${rgbToHex(j.to.r, j.to.g, j.to.b)}（最大通道差 ${Math.round(j.diff)}）`,
            )
            .join("\n")
        : "无跳变（仅分段碎）")
    );
  }
  let out = `共 ${segments.length} 段、${jumps.length} 处跳变：`;
  // 跳变的 at 恒等于下一段的 from（segmentAxisProfile 的构造保证），
  // 因此把跳变行缀在前一段末尾，读作「这一段结束时发生跳变」
  let jumpIdx = 0;
  for (let i = 0; i < segments.length; i++) {
    out += `\n${i + 1}. ${formatSegment(segments[i], axis)}`;
    const next = segments[i + 1];
    if (next && jumpIdx < jumps.length && jumps[jumpIdx].at === next.from) {
      const j = jumps[jumpIdx++];
      out +=
        `\n   ↳ ${axis}=${j.at} 跳变：${rgbToHex(j.from.r, j.from.g, j.from.b)} → ${rgbToHex(j.to.r, j.to.g, j.to.b)}（最大通道差 ${Math.round(j.diff)}）`;
    }
  }
  return out;
}

/** 单个候选色的逐像素评分结果 */
interface CandidateScore {
  readonly hex: string;
  readonly rgb: Rgb;
  /** 区域内与该候选色差 ≤ CANDIDATE_TOL 的像素占比 */
  readonly sharePct: number;
  /** 平均色差（0-255，越低越近） */
  readonly meanDist: number;
  /** 加权分：Σ max(0, tol - diff) —— 精确落色优先于近邻 */
  readonly weighted: number;
}

/**
 * 候选色逐像素评分：每个候选对区域内全部不透明像素计算线性色差，
 * 覆盖率 + 加权软匹配（avt dominant_colors 同源算法）。
 * 旧实现只与 top1 主色比 —— 背景占多数时会把背景当答案；逐像素评分
 * 让「覆盖了多少真实像素」说话，背景淹没场景下才选得出正确的候选。
 */
function scoreCandidates(
  data: Uint8Array | Buffer,
  total: number,
  candidates: readonly string[],
): CandidateScore[] {
  return candidates.map((hex) => {
    const rgb = hexToRgb(hex);
    let hard = 0;
    let distSum = 0;
    let weighted = 0;
    for (let i = 0; i < total; i++) {
      if (data[i * 4 + 3] === 0) continue;
      const d = linearColorDiff(
        { r: data[i * 4], g: data[i * 4 + 1], b: data[i * 4 + 2] },
        rgb,
      );
      if (d <= CANDIDATE_TOL) hard++;
      distSum += d;
      if (d < CANDIDATE_TOL) weighted += CANDIDATE_TOL - d;
    }
    return {
      hex,
      rgb,
      sharePct: (hard / total) * 100,
      meanDist: distSum / total,
      weighted,
    };
  });
}

function formatCandidateRows(rows: readonly CandidateScore[]): string {
  const maxW = Math.max(...rows.map((r) => r.weighted), 1);
  const winner = [...rows].sort(
    (p, q) => q.weighted - p.weighted || q.sharePct - p.sharePct,
  )[0];
  return rows
    .map(
      (r) =>
        `${r.hex === winner.hex ? "*" : " "} ${r.hex} 覆盖 ${r.sharePct.toFixed(1)}% ` +
        `加权 ${((r.weighted / maxW) * 100).toFixed(0)}%` +
        `${r.hex === winner.hex ? "（胜出）" : ""}`,
    )
    .join("\n");
}

export const COLORS_TOOL: LocalToolEntry<ColorsArgs> = {
  tool: {
    name: "colors",
    description:
      "分析图片主色，返回 top N 颜色（真实均值 hex + 占比，跳过完全透明像素）（本地操作，不调视觉模型）。" +
      "可传 candidates 候选色列表：对区域内全部像素逐个评分（容差覆盖% + 加权），返回像素证据支持的胜出候选 —— 颜色名/色值判断永远以本工具为准，不要信视觉描述。" +
      "传 profile 则改为返回颜色沿纵/横轴的剖面：均匀段（纯色/渐变 + 起止色）与跳变点（位置 + 两侧 hex + Δ），用于检测细微色差、接缝、渐变断层。" +
      "【图表/深背景取色】深色仪表盘等大背景会占据主色榜（top1 占比 >60% 时输出会自动附「背景排除视图」，也可传 exclude_background: true 直接以排除视图为主）。" +
      "柱状图/折线图取系列色：先取 20-40px 宽的窄条做 profile:\"y\"（扫描方向须垂直于颜色变化方向 —— 柱色纵向渐变就沿 y 扫），非背景渐变段即命中；再对单柱 region 取该段起止 hex。" +
      "聚类按 5 位量化分桶 + 近邻簇后合并：UI 纯色精确，渐变会合并为少量渐变簇（占比供参考）。",
    inputSchema: {
      type: "object",
      properties: {
        source: { type: "string", description: "图片来源" },
        region: regionProperty,
        top: {
          type: "number",
          description: "返回的主色数量（1-32，默认 5）",
        },
        candidates: {
          type: "array",
          items: { type: "string" },
          description:
            '候选色 hex 列表，如 ["#F9FAFA","#F5F5F5"]。对区域内全部像素逐个评分返回胜出候选（像素级证据，非只比主色）',
        },
        profile: {
          type: "string",
          enum: ["x", "y"],
          description:
            '剖面模式："y" 按行扫描（检测上下变化 / 水平接缝），"x" 按列扫描（检测左右变化 / 垂直接缝）。' +
            "每行/列取主色后输出渐变段与跳变点，不返回 top N 主色",
        },
        exclude_background: {
          type: "boolean",
          description:
            "true 时主列表即「背景排除视图」：与四角采样背景色（Δ≤24）相近的像素剔除后再聚类 —— 深色仪表盘/大背景图取实际内容色用",
        },
      },
      required: ["source"],
    },
  },
  schema: colorsSchema,
  needsVision: false,
  async run(
    args: ColorsArgs,
    config: BaseConfig,
    deps: ToolDeps = {},
  ): Promise<string> {
    const raw = await readSource(args.source, deps.reader);
    const image = await decodeJimp(raw, limitsOf(config));
    const originalSize = `${image.width}×${image.height}`;
    if (args.region) {
      const box = resolveRegion(args.region, image.width, image.height);
      image.crop({ x: box.x, y: box.y, w: box.w, h: box.h });
    }
    const header =
      `原图 ${originalSize}` +
      (args.region
        ? `，region 裁剪后 ${image.width}×${image.height}`
        : "");

    if (args.profile) {
      const lines = scanAxisProfile(
        image.bitmap.data,
        image.width,
        image.height,
        args.profile,
      );
      if (lines.length === 0) {
        return `${header}\n没有可分析的线（全透明，或每条线的主簇覆盖都不足 50%）。`;
      }
      const { segments, jumps } = segmentAxisProfile(lines);
      return `${header}\n沿 ${args.profile} 轴颜色剖面：\n${formatProfile(segments, jumps, args.profile)}`;
    }

    const data = image.bitmap.data;
    const total = image.width * image.height;
    // 量化值仅作聚类键，输出取簇内真实颜色均值（见 createColorClusters）；
    // 后合并把量化打散的近邻簇并回（Δ≤8），渐变不再碎成一地小簇
    const clusters = createColorClusters();
    let opaque = 0;
    for (let i = 0; i < total; i++) {
      if (data[i * 4 + 3] === 0) continue;
      opaque++;
      clusters.add(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
    }
    if (opaque === 0) {
      return "图片完全透明，没有不透明像素可分析。";
    }

    const topN = args.top ?? 5;
    const bg = sampleBackgroundCorners(data, image.width, image.height);
    const bgHex = rgbToHex(bg.r, bg.g, bg.b);

    /** 背景排除视图：剔除与四角采样背景相近（Δ≤BG_EXCLUDE_DIFF）的像素后聚类 */
    const excludedView = (): {
      out: string;
      kept: number;
      primary?: Rgb;
    } => {
      const ex = createColorClusters();
      let kept = 0;
      for (let i = 0; i < total; i++) {
        if (data[i * 4 + 3] === 0) continue;
        if (
          linearColorDiff(
            { r: data[i * 4], g: data[i * 4 + 1], b: data[i * 4 + 2] },
            bg,
          ) <= BG_EXCLUDE_DIFF
        )
          continue;
        kept++;
        ex.add(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
      }
      if (kept === 0) {
        return {
          out: `背景排除视图（背景=${bgHex}）：剔除后没有剩余像素 —— 整图都是背景色。`,
          kept: 0,
        };
      }
      const merged = mergeClusters(ex.result());
      const rows = merged
        .slice(0, topN)
        .map((c) => ({ ...c.rgb, pct: (c.count / kept) * 100 }));
      return {
        out:
          `背景排除视图（背景=四角采样 ${bgHex}，Δ≤${BG_EXCLUDE_DIFF} 已剔除，` +
          `占比按剩余 ${kept} 像素计；若四角不是背景可忽略本段）：\n` +
          rows
            .map(
              (c, i) => `${i + 1}. ${rgbToHex(c.r, c.g, c.b)}（${c.pct.toFixed(1)}%）`,
            )
            .join("\n"),
        kept,
        primary: merged[0]?.rgb,
      };
    };

    let out: string;
    let domRgb: Rgb | undefined;
    if (args.exclude_background) {
      const view = excludedView();
      domRgb = view.primary;
      out = `${header}\n${view.out}`;
    } else {
      const merged = mergeClusters(clusters.result());
      domRgb = merged[0]?.rgb;
      const topColors = merged
        .slice(0, topN)
        .map((c) => ({ ...c.rgb, pct: (c.count / opaque) * 100 }));
      out =
        header +
        "\n" +
        topColors
          .map(
            (c, i) => `${i + 1}. ${rgbToHex(c.r, c.g, c.b)}（${c.pct.toFixed(1)}%）`,
          )
          .join("\n");

      // 近邻簇提示：多个主色彼此只差几个点，往往是细微色差/渐变的第一个信号
      //（视觉模型对此系统性失明），也可能是量化跨桶 —— 提示交给调用方判断
      const nearPairs: string[] = [];
      for (let i = 0; i < topColors.length; i++) {
        for (let j = i + 1; j < topColors.length; j++) {
          const d = linearColorDiff(topColors[i], topColors[j]);
          if (d > 0 && d <= NEAR_CLUSTER_DIFF) {
            nearPairs.push(`第${i + 1}/${j + 1}号色 Δ=${Math.round(d)}`);
          }
        }
      }
      if (nearPairs.length > 0) {
        out +=
          `\n⚠ 相近簇：${nearPairs.join("；")} —— 可能存在细微色差或渐变（也可能是量化跨桶）。` +
          `可用 region 分区对比，或 profile:"y"/"x" 查看颜色结构`;
      }

      // 背景统治形态自救：top1 占比过高时主色榜几乎全是背景，
      // 自动追加背景排除视图（只加段不动已有行，追加式披露）
      if (topColors[0] && topColors[0].pct > BG_DOMINANT_TRIGGER_PCT) {
        const view = excludedView();
        if (view.kept > 0) {
          out += `\n\n${view.out}`;
        }
      }
    }

    if (args.candidates?.length && domRgb) {
      // 兼容行：主色（或背景排除后的主色）与候选的最近距离 —— 保留旧语义
      let best = args.candidates[0];
      let bestDiff = Infinity;
      for (const cand of args.candidates) {
        // hexToRgb 校验失败抛 ImageError，绝不静默产出 NaN
        const rgb = hexToRgb(cand);
        const diff = linearColorDiff(domRgb, rgb);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = cand;
        }
      }
      out += `\n主色 ${rgbToHex(domRgb.r, domRgb.g, domRgb.b)} 最接近候选色 ${best}（色差 ${bestDiff.toFixed(0)}/255）`;

      // 逐像素评分：像素证据选出的胜出者可能与「最接近主色」不同 ——
      // 背景淹没场景（主色=背景）下两者分歧正是旧算法的病灶，两个都给出交给调用方
      const rows = scoreCandidates(data, total, args.candidates);
      const winner = [...rows].sort(
        (p, q) => q.weighted - p.weighted || q.sharePct - p.sharePct,
      )[0];
      out +=
        `\n候选逐像素评分（容差 ${CANDIDATE_TOL}；覆盖% = 区域内色差≤${CANDIDATE_TOL} 的像素占比，加权优先精确落色）：\n` +
        formatCandidateRows(rows);
      if (winner.hex.toLowerCase() !== best.toLowerCase()) {
        out +=
          `\n注意：像素评分胜出者 ${winner.hex} 与「最接近主色」${best} 不同 —— ` +
          `主色可能是背景，优先采信覆盖/加权更高的 ${winner.hex}`;
      }
    }
    return out;
  },
};
