/**
 * 本地文件来源：展开 ~ → 校验存在/类型/扩展名 → 读取字节。
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { SourceError } from "../errors.js";

export const IMAGE_EXTENSIONS = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".bmp",
  ".tiff",
] as const;

const IMAGE_EXT_SET = new Set<string>(IMAGE_EXTENSIONS);

/** 展开 ~ 为家目录，并解析为绝对路径 */
export function expandPath(input: string): string {
  if (input === "~") return os.homedir();
  if (input.startsWith("~/")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return path.resolve(input);
}

export async function readFromFile(input: string): Promise<Buffer> {
  const p = expandPath(input);

  let stat;
  try {
    stat = await fs.stat(p);
  } catch {
    throw new SourceError(`文件不存在：${p}`);
  }
  if (!stat.isFile()) {
    throw new SourceError(`不是文件：${p}`);
  }

  const ext = path.extname(p).toLowerCase();
  if (!IMAGE_EXT_SET.has(ext)) {
    throw new SourceError(
      `不支持的图片格式 "${ext || "(无扩展名)"}"，支持：${IMAGE_EXTENSIONS.join("/")}`,
    );
  }

  return fs.readFile(p);
}
