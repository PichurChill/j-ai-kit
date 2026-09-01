/**
 * 坐标解析与换算：locate/inspect 共用。
 *
 * 模型在「缩放后的图」上返回坐标，需换算回原图坐标：
 *   原图坐标 = 模型坐标 / scale
 * 其中 scale = 缩放图宽 / 原图宽（见 processImageWithScale）。
 */

export interface Box {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/**
 * 按标签 x1/y1/x2/y2 从文本提取坐标框。
 * 兼容 "x1: 100" / "x1:100" / "x1 100" / 中文冒号逗号等写法。
 * 标签带词边界（前面非字符、后面非数字）—— "x12: 5" / "box1: 20" 不会污染 x1。
 * 找不到任一标签则返回 null。
 */
export function extractBoxByLabel(text: string): Box | null {
  const pick = (key: string): string | undefined =>
    text.match(
      new RegExp(`(?:^|[^\\w])${key}(?!\\d)\\s*[:：,，]?\\s*(-?\\d+)`, "i"),
    )?.[1];
  const x1 = pick("x1");
  const y1 = pick("y1");
  const x2 = pick("x2");
  const y2 = pick("y2");
  if (x1 == null || y1 == null || x2 == null || y2 == null) return null;
  return {
    x1: Number(x1),
    y1: Number(y1),
    x2: Number(x2),
    y2: Number(y2),
  };
}

/**
 * 把缩放图坐标框换算为原图坐标框。
 * scale 来自 processImageWithScale（= 缩放后宽 / 原宽），恒为正数。
 */
export function toOriginal(box: Box, scale: number): Box {
  const factor = 1 / scale;
  return {
    x1: Math.round(box.x1 * factor),
    y1: Math.round(box.y1 * factor),
    x2: Math.round(box.x2 * factor),
    y2: Math.round(box.y2 * factor),
  };
}

/**
 * clamp 到图片边界（locate/inspect 的输出要能直接回喂 crop/see_image 的 region，
 * 而这两个的 region 格式不接受负数和越界值）。
 */
export function clampBox(box: Box, width: number, height: number): Box {
  const clamp = (v: number, min: number, max: number) =>
    Math.max(min, Math.min(v, max));
  return {
    x1: clamp(box.x1, 0, width),
    y1: clamp(box.y1, 0, height),
    x2: clamp(box.x2, 0, width),
    y2: clamp(box.y2, 0, height),
  };
}

export function formatBox(b: Box): string {
  return `x1: ${b.x1}, y1: ${b.y1}, x2: ${b.x2}, y2: ${b.y2}`;
}
