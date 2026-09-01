/**
 * 工具注册表：聚合所有工具入口，供 index.ts 统一分发。
 * 新增工具时只需在 ENTRIES 中加入一项。
 */
import type { ToolDecl, ToolEntry } from "./types.js";
import { SEE_IMAGE_TOOL } from "./see.js";
import { LOCATE_TOOL } from "./locate.js";
import { INSPECT_TOOL } from "./inspect.js";
import { CROP_TOOL, IMAGE_DIFF_TOOL, COLORS_TOOL } from "./pixels.js";
import { TRACE_TOOL, EXTRACT_FG_TOOL } from "./vectorize.js";
import { OCR_LONG_TOOL } from "./ocr.js";

const ENTRIES: readonly ToolEntry[] = [
  SEE_IMAGE_TOOL,
  LOCATE_TOOL,
  INSPECT_TOOL,
  OCR_LONG_TOOL,
  CROP_TOOL,
  IMAGE_DIFF_TOOL,
  COLORS_TOOL,
  TRACE_TOOL,
  EXTRACT_FG_TOOL,
];

const BY_NAME: ReadonlyMap<string, ToolEntry> = new Map(
  ENTRIES.map((e) => [e.tool.name, e]),
);

/** 所有工具声明，用于 ListTools 响应 */
export function listTools(): ToolDecl[] {
  return ENTRIES.map((e) => e.tool);
}

/** 按名查工具入口，未注册返回 undefined */
export function getTool(name: string): ToolEntry | undefined {
  return BY_NAME.get(name);
}
