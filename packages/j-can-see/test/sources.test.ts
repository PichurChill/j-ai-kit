import { describe, it, expect } from "vitest";
import { readSource, type SourceReader } from "../src/sources/index.js";
import { sweepStaleClipboardTemp } from "../src/sources/clipboard.js";

interface FakeReader extends SourceReader {
  calls: string[];
}

function fakeReader(): FakeReader {
  const calls: string[] = [];
  const mk = (tag: string) => async (arg?: string) => {
    calls.push(`${tag}:${arg ?? ""}`);
    return Buffer.from(`${tag}:${arg ?? ""}`);
  };
  return {
    readFromFile: mk("file") as SourceReader["readFromFile"],
    readFromUrl: mk("url") as SourceReader["readFromUrl"],
    readClipboard: mk("clip") as SourceReader["readClipboard"],
    readLatestScreenshot: mk("latest") as SourceReader["readLatestScreenshot"],
    calls,
  };
}

describe("readSource 来源判定", () => {
  it("clipboard → 读剪贴板", async () => {
    const r = fakeReader();
    await readSource("clipboard", r);
    expect(r.calls).toEqual(["clip:"]);
  });

  it("latest → 读最近截图", async () => {
    const r = fakeReader();
    await readSource("latest", r);
    expect(r.calls).toEqual(["latest:"]);
  });

  it("http URL → 下载", async () => {
    const r = fakeReader();
    await readSource("http://x.com/a.png", r);
    expect(r.calls).toEqual(["url:http://x.com/a.png"]);
  });

  it("https URL → 下载", async () => {
    const r = fakeReader();
    await readSource("https://x.com/a.png", r);
    expect(r.calls).toEqual(["url:https://x.com/a.png"]);
  });

  it("本地路径 → 读文件（保留 ~ 原样传给 reader）", async () => {
    const r = fakeReader();
    await readSource("~/Desktop/x.png", r);
    expect(r.calls).toEqual(["file:~/Desktop/x.png"]);
  });

  it("trim 空白后判定", async () => {
    const r = fakeReader();
    await readSource("  clipboard  ", r);
    expect(r.calls).toEqual(["clip:"]);
  });

  it("空 source 抛 SourceError", async () => {
    await expect(readSource("   ", fakeReader())).rejects.toThrow(/为空/);
  });

  it("大写 URL 仍识别", async () => {
    const r = fakeReader();
    await readSource("HTTPS://x.com/a.png", r);
    expect(r.calls).toEqual(["url:HTTPS://x.com/a.png"]);
  });
});

describe("sweepStaleClipboardTemp", () => {
  it("只清理自身命名空间且足够老的残留；新文件（可能是并行实例在途）与无关文件不碰", async () => {
    const os = await import("node:os");
    const path = await import("node:path");
    const fs = (await import("node:fs/promises"));
    // 独立临时目录：sweep 扫描真实 os.tmpdir() 时，并行测试进程或运行中的
    // server 启动清扫会先删掉本测试的 stale 文件（曾因此偶发 n=0）
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "j-can-see-sweep-test-"));
    const stale = path.join(dir, `j-can-see-clip-${crypto.randomUUID()}.png`);
    const fresh = path.join(dir, `j-can-see-clip-${crypto.randomUUID()}.png`);
    const other = path.join(dir, `j-can-see-sweep-other-${Date.now()}.png`);
    await fs.writeFile(stale, "x");
    await fs.writeFile(fresh, "x");
    await fs.writeFile(other, "x");
    // stale 的 mtime 拨回 1 小时前，fresh 保持当前时间
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await fs.utimes(stale, old, old);
    try {
      const n = await sweepStaleClipboardTemp(dir);
      await expect(fs.access(stale)).rejects.toThrow(); // 老残留被清
      await expect(fs.access(fresh)).resolves.toBeUndefined(); // 新文件保留
      await expect(fs.access(other)).resolves.toBeUndefined(); // 无关文件保留
      expect(n).toBeGreaterThanOrEqual(1);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
