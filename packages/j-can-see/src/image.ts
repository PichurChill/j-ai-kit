/**
 * 图片预处理：解码 → 校验体积/像素 →（可选裁剪）→ 等比缩放 → JPEG base64。
 *
 * 为什么压缩：1568px 是主流视觉模型的有效分辨率上限，再大也会被服务端
 * 降采样，识别效果不变但带宽与 token 明显下降。JPEG q90 对含文字截图
 * 足够（避免高压缩振铃影响 OCR），且体积远小于 PNG。
 *
 * 本模块只依赖 ImageLimits 这一抽象，不认识 J_SEE_* 配置命名
 *（映射由 tools/types.ts 的 limitsOf 负责）。
 */
import { Jimp } from "jimp";
import { imageSize } from "image-size";
import { ImageError } from "./errors.js";

export interface ProcessedImage {
  readonly base64: string;
  readonly mime: string;
}

/** 带缩放比例的预处理结果，供 locate/inspect 把模型坐标换算回原图坐标 */
export interface ProcessedImageWithScale extends ProcessedImage {
  /** 缩放图宽 / 原图宽（等比缩放，宽高一致）；未缩放则为 1 */
  readonly scale: number;
  /** 原图尺寸，供换算后的坐标 clamp 到图界 */
  readonly originalWidth: number;
  readonly originalHeight: number;
}

/** 区域裁剪框（x/y 为左上角，w/h 为宽高） */
export interface RegionBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** 解码与缩放的约束 */
export interface ImageLimits {
  /** 长边像素上限（缩放目标） */
  readonly maxEdge: number;
  /** 源文件体积上限（字节） */
  readonly maxBytes: number;
  /** 解码后像素数上限（宽 × 高） */
  readonly maxPixels: number;
}

/** region 字符串格式："x1,y1,x2,y2"，四段无符号整数，允许两侧及逗号旁空白 */
export const REGION_PATTERN = /^\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*\d+\s*$/;

/** 解码原始字节为 Jimp 实例；失败统一转 ImageError */
async function decodeImage(raw: Buffer) {
  try {
    return await Jimp.read(raw);
  } catch (e) {
    throw new ImageError(
      `无法解码图片（格式不支持或已损坏）：${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
}

/** 已解码的 Jimp 实例 */
export type DecodedImage = Awaited<ReturnType<typeof decodeImage>>;

/**
 * 从图片 header 读尺寸，不解码像素。
 * 尺寸无效时必须抛错而非放行 —— NaN 参与的 `w*h > maxPixels` 恒为 false，
 * 放行等于静默绕过整道防护。
 */
function readDimensions(raw: Buffer): { width: number; height: number } {
  let width: number;
  let height: number;
  try {
    ({ width, height } = imageSize(raw));
  } catch (e) {
    throw new ImageError(
      `无法从图片 header 读取尺寸（格式不支持或已损坏）：${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }
  if (
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    throw new ImageError(`图片 header 中的尺寸无效：${width}×${height}`);
  }
  return { width, height };
}

/**
 * 解码并校验体积与像素数。供视觉流程与本地像素工具复用。
 *
 * 两道闸门缺一不可：
 *  - maxBytes 拦压缩后体积
 *  - maxPixels 在**解码前**从 header 读尺寸拦解码后的内存占用 ——
 *    大面积纯色 PNG 压缩比可达 100:1 以上，体积极小却能解出巨大 bitmap，
 *    只查体积拦不住
 */
export async function decodeJimp(
  raw: Buffer,
  limits: ImageLimits,
): Promise<DecodedImage> {
  if (raw.byteLength > limits.maxBytes) {
    throw new ImageError(
      `源文件 ${(raw.byteLength / 1024 / 1024).toFixed(1)}MB 超过上限 ${(
        limits.maxBytes /
        1024 /
        1024
      ).toFixed(0)}MB`,
    );
  }

  const { width, height } = readDimensions(raw);
  const pixels = width * height;
  if (pixels > limits.maxPixels) {
    throw new ImageError(
      `图片 ${width}×${height}（${(pixels / 1e6).toFixed(
        1,
      )}M 像素）超过上限 ${(limits.maxPixels / 1e6).toFixed(
        0,
      )}M 像素，解码需约 ${((pixels * 4) / 1024 / 1024).toFixed(
        0,
      )}MB 内存。可先用 crop 取局部，或调高 J_SEE_MAX_PIXELS`,
    );
  }

  return decodeImage(raw);
}

/**
 * 解析 region 字符串 "x1,y1,x2,y2"（原图像素坐标）为裁剪框。
 * 自动处理 x1>x2 / y1>y2 的反向坐标。格式由 REGION_PATTERN 单一定义。
 */
export function parseRegion(region: string): RegionBox {
  if (!REGION_PATTERN.test(region)) {
    throw new ImageError(`region 格式非法（应为 "x1,y1,x2,y2"）：${region}`);
  }
  const [x1, y1, x2, y2] = region
    .split(",")
    .map((s) => Number.parseInt(s.trim(), 10));
  const x = Math.min(x1, x2);
  const y = Math.min(y1, y2);
  const w = Math.abs(x2 - x1);
  const h = Math.abs(y2 - y1);
  if (w <= 0 || h <= 0) {
    throw new ImageError(`region 面积为 0：${region}`);
  }
  return { x, y, w, h };
}

/**
 * 解析 region 并 clamp 到图片边界。
 * locate/inspect 返回的坐标可能略微越界（如 x2 超出宽 1px），
 * 直接裁会触发 jimp 裸 RangeError —— 这里收进边界保证链路可回喂。
 * 完全越界（起点在图外）抛带图像尺寸的 ImageError。
 */
export function resolveRegion(
  region: string,
  width: number,
  height: number,
): RegionBox {
  // REGION_PATTERN 只接受无符号整数，故 box.x/y 必定非负，无需再夹下界
  const box = parseRegion(region);
  if (box.x >= width || box.y >= height) {
    throw new ImageError(
      `region 完全超出图片边界（图片 ${width}×${height}）：${region}`,
    );
  }
  return {
    x: box.x,
    y: box.y,
    w: Math.min(box.w, width - box.x),
    h: Math.min(box.h, height - box.y),
  };
}

/**
 * 对已解码的图做等比缩放（仅超限时）并编码为 JPEG base64。
 * 缩放是原地操作，调用方可在返回后读 image.width/height 得到缩放后尺寸。
 */
export async function encodeProcessed(
  image: DecodedImage,
  maxEdge: number,
): Promise<ProcessedImage> {
  // 仅当超出上限时才缩放，避免无谓重编码放大体积
  if (image.width > maxEdge || image.height > maxEdge) {
    image.scaleToFit({ w: maxEdge, h: maxEdge });
  }
  const buf = await image.getBuffer("image/jpeg", { quality: 90 });
  return { base64: buf.toString("base64"), mime: "image/jpeg" };
}

/** 解码 → 等比缩放至长边上限 → JPEG base64 */
export async function processImage(
  raw: Buffer,
  limits: ImageLimits,
): Promise<ProcessedImage> {
  const image = await decodeJimp(raw, limits);
  return encodeProcessed(image, limits.maxEdge);
}

/**
 * 同 processImage，但额外返回缩放比例。
 * locate/inspect 用它把「模型在缩放图上返回的坐标」换算回原图坐标：
 *   原图坐标 = 模型坐标 / scale
 */
export async function processImageWithScale(
  raw: Buffer,
  limits: ImageLimits,
): Promise<ProcessedImageWithScale> {
  const image = await decodeJimp(raw, limits);
  // 缩放前保存真实原始尺寸 —— 不能用「缩放后尺寸 / scale」反推：
  // scaleToFit 会取整，宽高比不整除时反推出小数（如 3137×1568 → 1568.5），
  // 会导致 locate/inspect 的坐标 clamp 后输出小数、无法回喂 region
  const originalWidth = image.width;
  const originalHeight = image.height;

  const processed = await encodeProcessed(image, limits.maxEdge);
  return {
    ...processed,
    scale: image.width / originalWidth,
    originalWidth,
    originalHeight,
  };
}

/**
 * 先按 region（原图坐标）裁剪，再等比缩放至长边上限，编码为 JPEG base64。
 * 裁剪发生在缩放前 —— 保证 locate/inspect 返回的原图坐标可直接复用。
 */
export async function cropAndProcess(
  raw: Buffer,
  region: string,
  limits: ImageLimits,
): Promise<ProcessedImage> {
  const image = await decodeJimp(raw, limits);
  const box = resolveRegion(region, image.width, image.height);
  image.crop({ x: box.x, y: box.y, w: box.w, h: box.h });
  return encodeProcessed(image, limits.maxEdge);
}
