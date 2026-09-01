/**
 * "latest" 来源：定位截图目录，取 mtime 最新的图片。
 *
 * 截图目录定位：
 *  - mac  : `defaults read com.apple.screencapture location`，读不到回落桌面
 *  - win  : %USERPROFILE%\Pictures\Screenshots
 *  - 其他 : 桌面（兜底，不静默成功）
 *
 * 存在意义：mac 的 Cmd+Shift+4 默认存文件而非剪贴板，
 * "latest" 让"截图完直接问"这条路径可用。
 */
import os from "node:os";
import path from "node:path";
import { promises as fs, type Dirent } from "node:fs";
import { SourceError } from "../errors.js";
import { runCommand } from "./util.js";
import { expandPath } from "./file.js";

const SCREENSHOT_EXTS = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"];

async function macScreenshotDir(): Promise<string> {
  try {
    const res = await runCommand("defaults", [
      "read",
      "com.apple.screencapture",
      "location",
    ]);
    const loc = res.stdout.trim();
    if (loc) return expandPath(loc);
  } catch {
    // 读不到用户自定义配置 → 回落桌面默认值
  }
  return path.join(os.homedir(), "Desktop");
}

function winScreenshotDir(): string {
  return path.join(
    process.env.USERPROFILE || os.homedir(),
    "Pictures",
    "Screenshots",
  );
}

export async function getScreenshotDir(): Promise<string> {
  if (process.platform === "darwin") return macScreenshotDir();
  if (process.platform === "win32") return winScreenshotDir();
  return path.join(os.homedir(), "Desktop");
}

export async function readLatestScreenshot(): Promise<Buffer> {
  const dir = await getScreenshotDir();

  let entries: Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    throw new SourceError(`无法读取截图目录：${dir}`);
  }

  const extSet = new Set(SCREENSHOT_EXTS);
  const imagePaths = entries
    .filter((e) => e.isFile() && extSet.has(path.extname(e.name).toLowerCase()))
    .map((e) => path.join(dir, e.name));

  if (imagePaths.length === 0) {
    throw new SourceError(`截图目录中没有图片：${dir}`);
  }

  // 并行 stat，不可变 reduce 找 mtime 最新
  const withStats = await Promise.all(
    imagePaths.map(async (p) => {
      const s = await fs.stat(p).catch(() => null);
      return { path: p, mtime: s?.mtimeMs ?? 0 };
    }),
  );
  const latest = withStats.reduce((a, b) => (b.mtime > a.mtime ? b : a));

  return fs.readFile(latest.path);
}
