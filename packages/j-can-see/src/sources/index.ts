/**
 * 来源编排：根据 source 字符串判定类型并读取字节。
 *
 * 判定顺序：
 *  - "clipboard"  → 系统剪贴板（mac/win）
 *  - "latest"     → 截图目录中最新图片
 *  - http(s) URL  → 下载
 *  - 其他         → 本地文件路径（支持 ~）
 *
 * reader 可注入：判定逻辑（本文件的核心）可用 fake reader 纯单测，
 * 真实 IO 实现各自独立测试。
 */
import { SourceError } from "../errors.js";
import { readFromFile } from "./file.js";
import { readFromUrl } from "./url.js";
import { readClipboard } from "./clipboard.js";
import { readLatestScreenshot } from "./latest.js";

export interface SourceReader {
  readonly readFromFile: (input: string) => Promise<Buffer>;
  readonly readFromUrl: (url: string) => Promise<Buffer>;
  readonly readClipboard: () => Promise<Buffer>;
  readonly readLatestScreenshot: () => Promise<Buffer>;
}

export const defaultReader: SourceReader = {
  readFromFile,
  readFromUrl,
  readClipboard,
  readLatestScreenshot,
};

/** source 字符串对应的来源类型 */
export type SourceKind = "clipboard" | "latest" | "url" | "file";

/**
 * 判定 source 的来源类型。
 *
 * readSource 与需要按来源分支的工具（crop/extract_fg 推导默认输出路径时
 * 必须区分「有本地路径可依」与「没有」）共用这一处判定 ——
 * 两份独立实现会随新增来源类型而漂移。
 */
export function classifySource(source: string): SourceKind {
  const s = source.trim();
  if (!s) throw new SourceError("source 为空");
  if (s === "clipboard") return "clipboard";
  if (s === "latest") return "latest";
  if (/^https?:\/\//i.test(s)) return "url";
  return "file";
}

export async function readSource(
  source: string,
  reader: SourceReader = defaultReader,
): Promise<Buffer> {
  const s = source.trim();
  switch (classifySource(s)) {
    case "clipboard":
      return reader.readClipboard();
    case "latest":
      return reader.readLatestScreenshot();
    case "url":
      return reader.readFromUrl(s);
    case "file":
      return reader.readFromFile(s);
  }
}
