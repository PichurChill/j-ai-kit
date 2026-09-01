/**
 * 颜色工具共享函数：hex 解析（严格校验）、格式化、主色聚类。
 * 非法输入抛 ImageError —— 绝不静默产出 NaN（会导致下游色差比较全部失真）。
 */
import { ImageError } from "../errors.js";

const HEX_RE = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

export interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** 解析 "#rgb" / "#rrggbb" / "rrggbb"；非法值抛 ImageError */
export function hexToRgb(hex: string): Rgb {
  const m = HEX_RE.exec(hex.trim());
  if (!m) {
    throw new ImageError(
      `非法颜色值 "${hex}"（应为 #rgb 或 #rrggbb 格式的 hex）`,
    );
  }
  let h = m[1];
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  return {
    r: Number.parseInt(h.slice(0, 2), 16),
    g: Number.parseInt(h.slice(2, 4), 16),
    b: Number.parseInt(h.slice(4, 6), 16),
  };
}

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/**
 * 线性色差：三通道绝对差的最大值（0-255）。
 * 语义直观（"任一通道最多差多少"），与 jimp colorDiff 的平方归一化不同，
 * 后者会把小差值压得更小、大差值放大，不适合做"保留多少前景"的阈值。
 */
export function linearColorDiff(a: Rgb, b: Rgb): number {
  return Math.max(
    Math.abs(a.r - b.r),
    Math.abs(a.g - b.g),
    Math.abs(a.b - b.b),
  );
}

/** 颜色簇：簇内真实颜色均值 + 像素数 */
export interface ColorCluster {
  readonly rgb: Rgb;
  readonly count: number;
}

export interface ColorClusterAccumulator {
  add(r: number, g: number, b: number): void;
  /** 按像素数降序的簇 */
  result(): ColorCluster[];
}

/** 量化掩码：保留高 5 位，桶宽 8 */
const QUANT_MASK = 0xf8;

/**
 * 主色聚类累加器。colors 与 extract_fg 的背景采样共用。
 *
 * 关键约定：**量化值只作聚类键，输出一律是簇内真实颜色均值**。
 * 把量化值当颜色返回会引入最多 7/通道的误差 —— 对 colors 是色值不准，
 * 对 extract_fg 则是功能失效：背景 #FEFEFE 量化成 #F8F8F8 后色差为 7，
 * 任何 threshold < 7 的精确抠图都会把整张背景判成前景。
 * 这个累加器不提供任何拿到量化值的出口，从结构上杜绝该误用。
 *
 * 局限：固定网格分桶不是真聚类 —— 跨桶边界的相邻色（#F7F7F7 与 #F8F8F8）
 * 会落入不同簇。对 UI 纯色足够；渐变/照片的主色会被打散成多个小簇。
 */
export function createColorClusters(): ColorClusterAccumulator {
  const buckets = new Map<
    number,
    { rSum: number; gSum: number; bSum: number; n: number }
  >();
  return {
    add(r, g, b) {
      const key =
        ((r & QUANT_MASK) << 16) | ((g & QUANT_MASK) << 8) | (b & QUANT_MASK);
      const e = buckets.get(key);
      if (e) {
        e.rSum += r;
        e.gSum += g;
        e.bSum += b;
        e.n++;
      } else {
        buckets.set(key, { rSum: r, gSum: g, bSum: b, n: 1 });
      }
    },
    result() {
      return [...buckets.values()]
        .sort((p, q) => q.n - p.n)
        .map((c) => ({
          rgb: { r: c.rSum / c.n, g: c.gSum / c.n, b: c.bSum / c.n },
          count: c.n,
        }));
    },
  };
}

// ---------- 颜色剖面（colors 的 profile 模式） ----------

/** 剖面每条线（行/列）的最大采样数：主色统计是抽样统计，不需要全量像素 */
const PROFILE_MAX_SAMPLES_PER_LINE = 512;

/**
 * 相邻两线主色的最大通道差超过此值视为跳变。
 * 刻意取 5：平滑渐变每行变化 <1、编码噪声 ≤2、真实接缝/断层 ≥6（实测平铺渐变
 * 接缝 ΔR=11），5 恰好在噪声之上、语义断层之下。
 */
export const PROFILE_JUMP_THRESHOLD = 5;

/** 主簇覆盖低于此比例的线视为杂线（文字/多元素混排），不参与分段 */
const PROFILE_LINE_COVERAGE = 0.5;

/** 一条线的扫描结果：index 为 y（axis="y"）或 x（axis="x"），rgb 为该线主色 */
export interface ProfileLine {
  readonly index: number;
  readonly rgb: Rgb;
}

/**
 * 沿 x 或 y 轴逐线取主色。每条线用与 colors 相同的量化聚类取最大簇 ——
 * 线上的少数内容（文字/图标）不会污染主色；透明线与主簇不过半的杂线直接跳过。
 */
export function scanAxisProfile(
  data: Uint8Array | Buffer,
  width: number,
  height: number,
  axis: "x" | "y",
): ProfileLine[] {
  const along = axis === "y" ? height : width;
  const across = axis === "y" ? width : height;
  const step = Math.max(1, Math.ceil(across / PROFILE_MAX_SAMPLES_PER_LINE));
  const lines: ProfileLine[] = [];
  for (let i = 0; i < along; i++) {
    const clusters = createColorClusters();
    let opaque = 0;
    for (let j = 0; j < across; j += step) {
      const o = axis === "y" ? (i * width + j) * 4 : (j * width + i) * 4;
      if (data[o + 3] === 0) continue;
      opaque++;
      clusters.add(data[o], data[o + 1], data[o + 2]);
    }
    if (opaque === 0) continue;
    const top = clusters.result()[0];
    if (top.count / opaque < PROFILE_LINE_COVERAGE) continue;
    lines.push({ index: i, rgb: top.rgb });
  }
  return lines;
}

export interface ProfileSegment {
  readonly from: number;
  readonly to: number;
  readonly start: Rgb;
  readonly end: Rgb;
}

export interface ProfileJump {
  /** 跳变后第一条线的 index（即跳变发生处） */
  readonly at: number;
  readonly from: Rgb;
  readonly to: Rgb;
  readonly diff: number;
}

/**
 * 把逐线主色切成「均匀段 + 跳变点」。相邻有效线（含因杂线/透明产生的空洞）
 * 主色差 ≤ 阈值即同段 —— 段内的平滑变化是渐变，超阈值的突变是接缝/断层；
 * 空洞两侧颜色一致时跨空洞并段，不会把文字带误判成跳变。
 */
export function segmentAxisProfile(
  lines: readonly ProfileLine[],
  jumpThreshold = PROFILE_JUMP_THRESHOLD,
): { segments: ProfileSegment[]; jumps: ProfileJump[] } {
  const segments: ProfileSegment[] = [];
  const jumps: ProfileJump[] = [];
  let segStart: ProfileLine | null = null;
  let prev: ProfileLine | null = null;
  const close = (end: ProfileLine) => {
    if (segStart) {
      segments.push({
        from: segStart.index,
        to: end.index,
        start: segStart.rgb,
        end: end.rgb,
      });
    }
  };
  for (const line of lines) {
    if (prev) {
      const diff = linearColorDiff(prev.rgb, line.rgb);
      if (diff > jumpThreshold) {
        close(prev);
        jumps.push({ at: line.index, from: prev.rgb, to: line.rgb, diff });
        segStart = line;
      }
    } else {
      segStart = line;
    }
    prev = line;
  }
  if (prev) close(prev);
  return { segments, jumps };
}
