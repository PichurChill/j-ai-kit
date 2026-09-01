import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Jimp, intToRGBA } from "jimp";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { TRACE_TOOL, EXTRACT_FG_TOOL } from "../src/tools/vectorize.js";
import { runLocal, makePng, readerFrom } from "./helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jcs-vec-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** 左右两半不同色的图（用于验证像素内容确实进了 tracer） */
async function makeHalfPng(w: number, h: number): Promise<Buffer> {
  const img = new Jimp({ width: w, height: h, color: 0x000000ff });
  img.composite(new Jimp({ width: w / 2, height: h, color: 0xffffffff }), w / 2, 0);
  return img.getBuffer("image/png");
}

describe("TRACE_TOOL", () => {
  it("返回包含 <svg 的矢量内容", async () => {
    const png = await makePng(20, 20, 0x000000ff);
    const svg = await runLocal(
      TRACE_TOOL,
      { source: "x.png", colors: 2 },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("指定 output 写入 svg 文件", async () => {
    const png = await makePng(16, 16, 0xff0000ff);
    const out = path.join(tmpDir, "out.svg");
    const text = await runLocal(
      TRACE_TOOL,
      { source: "x.png", output: out, colors: 2 },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain(out);
    expect(await fs.readFile(out, "utf8")).toContain("<svg");
  });

  it("像素内容确实进入 tracer：对半图的 SVG 比同尺寸纯色图更复杂", async () => {
    // 若 bitmap 未正确递给库（如传了空/错位的 buffer），对半图会被 trace 成
    // 与纯色图相近的结果 —— 这条断言正是用来兜住那种静默退化
    const solid = await makePng(40, 40, 0x000000ff);
    const half = await makeHalfPng(40, 40);
    const reader = readerFrom({ "solid.png": solid, "half.png": half });
    const svgSolid = await runLocal(
      TRACE_TOOL,
      { source: "solid.png", colors: 2 },
      { reader },
    );
    const svgHalf = await runLocal(
      TRACE_TOOL,
      { source: "half.png", colors: 2 },
      { reader },
    );
    expect(svgHalf.length).toBeGreaterThan(svgSolid.length);
  });
});

describe("EXTRACT_FG_TOOL", () => {
  it("白底红方块：红色保留为前景，白色透明化", async () => {
    const img = new Jimp({ width: 40, height: 40, color: 0xffffffff });
    img.composite(new Jimp({ width: 20, height: 20, color: 0xff0000ff }), 10, 10);
    const png = await img.getBuffer("image/png");
    const out = path.join(tmpDir, "fg.png");
    const text = await runLocal(
      EXTRACT_FG_TOOL,
      { source: "x.png", background: "#ffffff", output: out },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain(out);
    expect(text).toContain("前景");

    const saved = await Jimp.read(await fs.readFile(out));
    expect(saved.width).toBe(40);
    expect(saved.hasAlpha()).toBe(true);
    expect(intToRGBA(saved.getPixelColor(0, 0)).a).toBe(0); // 原白底 → 透明
    expect(intToRGBA(saved.getPixelColor(20, 20)).a).toBe(255); // 原红块 → 保留
  });

  it("省略 background 时自动采样四角", async () => {
    const img = new Jimp({ width: 40, height: 40, color: 0x000000ff });
    img.composite(new Jimp({ width: 16, height: 16, color: 0x00ff00ff }), 12, 12);
    const png = await img.getBuffer("image/png");
    const out = path.join(tmpDir, "fg2.png");
    await runLocal(
      EXTRACT_FG_TOOL,
      { source: "x.png", output: out },
      { reader: readerFrom({ "x.png": png }) },
    );
    const saved = await Jimp.read(await fs.readFile(out));
    expect(intToRGBA(saved.getPixelColor(0, 0)).a).toBe(0);
  });

  it("自动采样返回真实均值色：非整齐背景 + 小阈值仍能正确抠图", async () => {
    // 背景 #FEFEFE 量化后是 #F8F8F8，色差 7。若把量化值当背景色返回，
    // threshold=4 时整张背景都会被判成前景（实测 1600/1600，等于原图原样输出）
    const img = new Jimp({ width: 40, height: 40, color: 0xfefefeff });
    img.composite(new Jimp({ width: 10, height: 10, color: 0xff0000ff }), 15, 15);
    const png = await img.getBuffer("image/png");
    const out = path.join(tmpDir, "fg-precise.png");
    const reader = readerFrom({ "x.png": png });

    const auto = await runLocal(
      EXTRACT_FG_TOOL,
      { source: "x.png", threshold: 4, output: out },
      { reader },
    );
    expect(auto).toContain("100/1600 像素为前景");

    // 自动采样应与显式指定真实背景色得到同样结果
    const explicit = await runLocal(
      EXTRACT_FG_TOOL,
      { source: "x.png", background: "#fefefe", threshold: 4, output: out },
      { reader },
    );
    expect(explicit).toContain("100/1600 像素为前景");
  });

  it("阈值方向：threshold 越小保留越多前景（线性色差语义）", async () => {
    // 白底 + 灰前景（#808080，与白线性色差 127）
    const img = new Jimp({ width: 40, height: 40, color: 0xffffffff });
    img.composite(new Jimp({ width: 20, height: 20, color: 0x808080ff }), 10, 10);
    const png = await img.getBuffer("image/png");
    const out = path.join(tmpDir, "fg3.png");
    const reader = readerFrom({ "x.png": png });

    // threshold=10：127 > 10 → 前景保留
    const keep = await runLocal(
      EXTRACT_FG_TOOL,
      { source: "x.png", background: "#ffffff", threshold: 10, output: out },
      { reader },
    );
    expect(keep).toContain("400/1600 像素为前景");

    // threshold=200：127 ≤ 200 → 全部视为背景，附零前景警告
    const erase = await runLocal(
      EXTRACT_FG_TOOL,
      { source: "x.png", background: "#ffffff", threshold: 200, output: out },
      { reader },
    );
    expect(erase).toContain("0/1600 像素为前景");
    expect(erase).toContain("警告");
  });

  it("非法 background hex 抛 ImageError（不静默产出全前景原图）", async () => {
    const png = await makePng(20, 20, 0xff0000ff);
    await expect(
      runLocal(
        EXTRACT_FG_TOOL,
        {
          source: "x.png",
          background: "#zzzzzz",
          output: path.join(tmpDir, "o.png"),
        },
        { reader: readerFrom({ "x.png": png }) },
      ),
    ).rejects.toMatchObject({ name: "ImageError" });
  });

  it("URL/clipboard/latest source 省略 output 时明确报错", async () => {
    const png = await makePng(20, 20, 0xff0000ff);
    for (const src of ["https://example.com/a.png", "clipboard", "latest"]) {
      await expect(
        runLocal(
          EXTRACT_FG_TOOL,
          { source: src },
          { reader: readerFrom({ [src]: png }) },
        ),
      ).rejects.toThrow(/必须显式指定 output/);
    }
  });
});
