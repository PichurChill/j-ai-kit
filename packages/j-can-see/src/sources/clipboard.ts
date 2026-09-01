/**
 * 剪贴板来源。
 *
 * 平台支持：
 *  - mac  : osascript 提取 PNGf 写临时文件
 *  - win  : PowerShell（必须 -STA，否则 Clipboard.GetImage 取不到值）
 *  - linux: 不支持，明确报错（能力边界声明，非降级）
 *
 * 剪贴板无图时，系统命令非零退出 / 临时文件为空 → 统一报"剪贴板中没有图片"。
 */
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promises as fs } from "node:fs";
import { SourceError } from "../errors.js";
import { runCommand } from "./util.js";

export function isClipboardSupported(): boolean {
  return process.platform === "darwin" || process.platform === "win32";
}

/** 只清理超过此时长的中转文件：并行的另一个实例可能正处于「写入→读取」窗口 */
const SWEEP_MIN_AGE_MS = 10 * 60 * 1000;

/**
 * 清扫 os.tmpdir() 下本工具遗留的剪贴板中转文件（j-can-see-clip-*.png）。
 *
 * 正常路径由 readClipboard 的 finally 删除；仅进程被强杀（kill -9）时残留。
 * 只碰自己命名空间（唯一前缀）且修改时间超过 SWEEP_MIN_AGE_MS 的文件 ——
 * 刚产生的可能是并行实例的在途文件，不能删。best-effort、静默失败。
 *
 * @param dir 扫描目录，默认 os.tmpdir()。测试注入独立临时目录，
 *   避免与并行测试进程 / 运行中的 server 启动清扫互相删文件。
 */
export async function sweepStaleClipboardTemp(
  dir: string = os.tmpdir(),
): Promise<number> {
  try {
    const names = (await fs.readdir(dir)).filter((n) =>
      /^j-can-see-clip-[0-9a-f-]+\.png$/.test(n),
    );
    let deleted = 0;
    await Promise.all(
      names.map(async (n) => {
        const fp = path.join(dir, n);
        try {
          const st = await fs.stat(fp);
          if (Date.now() - st.mtimeMs < SWEEP_MIN_AGE_MS) return;
          await fs.unlink(fp);
          deleted++;
        } catch {
          // 文件消失/权限问题：跳过
        }
      }),
    );
    return deleted;
  } catch {
    return 0;
  }
}

export async function readClipboard(): Promise<Buffer> {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "win32") {
    throw new SourceError(
      `当前平台 ${platform} 不支持读剪贴板，请改用文件路径或 URL`,
    );
  }

  const tmp = path.join(
    os.tmpdir(),
    `j-can-see-clip-${crypto.randomUUID()}.png`,
  );
  try {
    if (platform === "darwin") {
      await runClipboardMac(tmp);
    } else {
      await runClipboardWin(tmp);
    }

    let buf: Buffer;
    try {
      buf = await fs.readFile(tmp);
    } catch {
      throw new SourceError("剪贴板中没有图片");
    }
    if (buf.byteLength === 0) {
      throw new SourceError("剪贴板中没有图片");
    }
    return buf;
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

async function runClipboardMac(tmp: string): Promise<void> {
  // 把剪贴板中的 PNG 数据写入临时文件。
  // «class PNGf» 含特殊字符，脚本通过 stdin 传入，规避命令行转义。
  // 剪贴板无图时 `the clipboard as «class PNGf»` 抛错 → 非零退出。
  const script =
    `set pngData to the clipboard as «class PNGf»\n` +
    `set fp to open for access POSIX file "${tmp}" with write permission\n` +
    `write pngData to fp\n` +
    `close access fp`;
  const res = await runCommand("osascript", ["-"], { stdin: script });
  if (res.code !== 0) {
    throw new SourceError("剪贴板中没有图片");
  }
}

async function runClipboardWin(tmp: string): Promise<void> {
  // -STA 是关键：Clipboard API 在多线程单元（MTA）下取不到值。
  // 反斜杠转义给 PowerShell 字符串字面量用。
  const safeTmp = tmp.replace(/\\/g, "\\\\");
  const script =
    `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; ` +
    `$i=[System.Windows.Forms.Clipboard]::GetImage(); ` +
    `if(-not $i){exit 1}; ` +
    `$i.Save('${safeTmp}',[System.Drawing.Imaging.ImageFormat]::Png)`;
  const res = await runCommand("powershell", [
    "-NoProfile",
    "-NonInteractive",
    "-STA",
    "-Command",
    script,
  ]);
  if (res.code !== 0) {
    throw new SourceError("剪贴板中没有图片");
  }
}
