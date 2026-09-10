import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { Jimp } from "jimp";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  CROP_TOOL,
  IMAGE_DIFF_TOOL,
  COLORS_TOOL,
} from "../src/tools/pixels.js";
import { segmentAxisProfile } from "../src/tools/color.js";
import { deriveDefaultOutput } from "../src/tools/output.js";
import { runLocal, makePng, readerFrom } from "./helpers.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jcs-pixels-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** 每行一种纯色（R 通道逐行给定，G=0xcc B=0xff），用于渐变/接缝剖面测试 */
async function rowsPng(width: number, rowR: number[]): Promise<Buffer> {
  const img = new Jimp({ width, height: rowR.length, color: 0xff0000ff });
  rowR.forEach((r, y) => {
    const c = (((r & 0xff) << 24) | (0xcc << 16) | (0xff << 8) | 0xff) >>> 0;
    for (let x = 0; x < width; x++) img.setPixelColor(c, x, y);
  });
  return img.getBuffer("image/png");
}

describe("deriveDefaultOutput", () => {
  it("~/x.png 默认输出展开到家目录（与读取侧对称）", () => {
    expect(deriveDefaultOutput("~/x.png", "_crop", ".png")).toBe(
      path.join(os.homedir(), "x_crop.png"),
    );
  });

  it("普通路径去扩展名拼后缀", () => {
    expect(deriveDefaultOutput("/tmp/a/b.png", "_crop", ".png")).toBe(
      "/tmp/a/b_crop.png",
    );
  });

  it("URL/clipboard/latest 拒绝默认输出", () => {
    expect(() =>
      deriveDefaultOutput("https://x.com/a.png", "_crop", ".png"),
    ).toThrow(/必须显式指定 output/);
    expect(() => deriveDefaultOutput("clipboard", "_fg", ".png")).toThrow(
      /必须显式指定 output/,
    );
    expect(() => deriveDefaultOutput("latest", "_fg", ".png")).toThrow(
      /必须显式指定 output/,
    );
  });
});

describe("CROP_TOOL", () => {
  it("按 region 裁剪并保存为 PNG", async () => {
    const src = path.join(tmpDir, "src.png");
    const out = path.join(tmpDir, "out.png");
    const png = await makePng(100, 80, 0xff0000ff);
    const text = await runLocal(
      CROP_TOOL,
      { source: src, region: "0,0,30,30", output: out },
      { reader: readerFrom({ [src]: png }) },
    );
    expect(text).toContain(out);
    expect(text).toContain("30×30");
    const saved = await Jimp.read(await fs.readFile(out));
    expect(saved.width).toBe(30);
    expect(saved.height).toBe(30);
  });

  it("region 越界自动 clamp 到图片边界（不再抛 jimp RangeError）", async () => {
    const src = path.join(tmpDir, "src.png");
    const out = path.join(tmpDir, "out.png");
    const png = await makePng(100, 100);
    const text = await runLocal(
      CROP_TOOL,
      { source: src, region: "0,0,500,500", output: out },
      { reader: readerFrom({ [src]: png }) },
    );
    expect(text).toContain("100×100");
    const saved = await Jimp.read(await fs.readFile(out));
    expect(saved.width).toBe(100);
    expect(saved.height).toBe(100);
  });

  it("本地文件 source 省略 output 时在源文件同目录生成 _crop.png", async () => {
    const src = path.join(tmpDir, "src2.png");
    const png = await makePng(50, 50);
    const text = await runLocal(
      CROP_TOOL,
      { source: src, region: "0,0,10,10" },
      { reader: readerFrom({ [src]: png }) },
    );
    const expected = path.join(tmpDir, "src2_crop.png");
    expect(text).toContain(expected);
    await expect(fs.access(expected)).resolves.toBeUndefined();
  });

  it("URL / clipboard / latest source 省略 output 时明确报错（不写非法路径/cwd）", async () => {
    const png = await makePng(50, 50);
    for (const src of ["https://example.com/a.png", "clipboard", "latest"]) {
      await expect(
        runLocal(
          CROP_TOOL,
          { source: src, region: "0,0,10,10" },
          { reader: readerFrom({ [src]: png }) },
        ),
      ).rejects.toThrow(/必须显式指定 output/);
    }
  });

  it("output 指向不存在的嵌套目录时自动创建并写入成功", async () => {
    const src = path.join(tmpDir, "src3.png");
    const png = await makePng(20, 20);
    const out = path.join(tmpDir, "no-such-dir", "nested", "x.png");
    const text = await runLocal(
      CROP_TOOL,
      { source: src, region: "0,0,10,10", output: out },
      { reader: readerFrom({ [src]: png }) },
    );
    expect(text).toContain(out);
    await expect(fs.access(out)).resolves.toBeUndefined();
  });

  it("scale 放大裁剪结果", async () => {
    const src = path.join(tmpDir, "src.png");
    const out = path.join(tmpDir, "out.png");
    const png = await makePng(100, 80);
    await runLocal(
      CROP_TOOL,
      { source: src, region: "0,0,10,10", output: out, scale: 4 },
      { reader: readerFrom({ [src]: png }) },
    );
    const saved = await Jimp.read(await fs.readFile(out));
    expect(saved.width).toBe(40);
    expect(saved.height).toBe(40);
  });

  it(".jpg 输出按扩展名编码为 JPEG（magic ffd8 而非 PNG 8950）", async () => {
    const src = path.join(tmpDir, "src.png");
    const out = path.join(tmpDir, "out.jpg");
    const png = await makePng(50, 50);
    await runLocal(
      CROP_TOOL,
      { source: src, region: "0,0,20,20", output: out },
      { reader: readerFrom({ [src]: png }) },
    );
    const bytes = await fs.readFile(out);
    expect(bytes[0]).toBe(0xff);
    expect(bytes[1]).toBe(0xd8);
  });

  it("非法 region 被 schema 拒绝（格式与 parseRegion 同一真值来源）", () => {
    expect(
      CROP_TOOL.schema.safeParse({ source: "x.png", region: "abc" }).success,
    ).toBe(false);
    expect(
      CROP_TOOL.schema.safeParse({ source: "x.png", region: "-1,2,3,4" })
        .success,
    ).toBe(false);
    expect(
      CROP_TOOL.schema.safeParse({ source: "x.png", region: "1,2,3,4" }).success,
    ).toBe(true);
  });
});

describe("IMAGE_DIFF_TOOL", () => {
  it("完全相同的图差异为 0%", async () => {
    const png = await makePng(60, 60, 0x00ff00ff);
    const text = await runLocal(
      IMAGE_DIFF_TOOL,
      { a: "a.png", b: "b.png" },
      { reader: readerFrom({ "a.png": png, "b.png": png }) },
    );
    expect(text).toContain("差异比例：0.00%");
    expect(text).toContain("无明显差异区域");
  });

  it("完全不同的图差异接近 100% 且给出网格块坐标", async () => {
    const a = await makePng(60, 60, 0x000000ff);
    const b = await makePng(60, 60, 0xffffffff);
    const text = await runLocal(
      IMAGE_DIFF_TOOL,
      { a: "a.png", b: "b.png" },
      { reader: readerFrom({ "a.png": a, "b.png": b }) },
    );
    expect(text).toMatch(/差异比例：(9\d|100)/);
    // 措辞须如实说明这是网格块而非精确包围盒
    expect(text).toContain("网格块");
    expect(text).toContain("非精确包围盒");
    expect(text).toMatch(/x1: \d+, y1: \d+, x2: \d+, y2: \d+/);
  });

  it("尺寸不同的图会先对齐再比较：以面积较小者为基准，坐标以基准图为准", async () => {
    const a = await makePng(40, 40, 0xff0000ff);
    const b = await makePng(80, 80, 0xff0000ff); // 颜色相同，对齐后应无差异
    const text = await runLocal(
      IMAGE_DIFF_TOOL,
      { a: "a.png", b: "b.png" },
      { reader: readerFrom({ "a.png": a, "b.png": b }) },
    );
    expect(text).toContain("差异比例：0.00%");
    expect(text).toContain("两图尺寸不同");
    expect(text).toContain("已按面积较小者（A）为基准对齐");
    expect(text).toContain("坐标以 A 为准");
  });

  it("参数顺序颠倒（A 大 B 小）：仍只缩不放，坐标以较小图 B 为准", async () => {
    const a = await makePng(80, 80, 0xff0000ff);
    const b = await makePng(40, 40, 0xff0000ff); // 颜色相同，对齐后应无差异
    const text = await runLocal(
      IMAGE_DIFF_TOOL,
      { a: "a.png", b: "b.png" },
      { reader: readerFrom({ "a.png": a, "b.png": b }) },
    );
    expect(text).toContain("差异比例：0.00%");
    expect(text).toContain("已按面积较小者（B）为基准对齐");
    expect(text).toContain("坐标以 B 为准");
  });

  it("双方全透明的像素视为相同（RGB 是未定义值，不该计入差异）", async () => {
    // 同为 alpha=0 但 RGB 迥异
    const a = await makePng(40, 40, 0xff000000);
    const b = await makePng(40, 40, 0x00ff0000);
    const text = await runLocal(
      IMAGE_DIFF_TOOL,
      { a: "a.png", b: "b.png" },
      { reader: readerFrom({ "a.png": a, "b.png": b }) },
    );
    expect(text).toContain("差异比例：0.00%");
  });

  it("透明度变化直接计为差异（RGB 相同也算变了）", async () => {
    const a = await makePng(40, 40, 0xff0000ff); // 不透明红
    const b = await makePng(40, 40, 0xff000000); // 全透明红：RGB 相同
    const text = await runLocal(
      IMAGE_DIFF_TOOL,
      { a: "a.png", b: "b.png" },
      { reader: readerFrom({ "a.png": a, "b.png": b }) },
    );
    expect(text).toContain("差异比例：100.00%");
  });
});

describe("COLORS_TOOL", () => {
  it("纯色图主色为真实色值（非量化值）且占比 100%", async () => {
    const png = await makePng(50, 50, 0xff0000ff); // 纯红
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png" },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("#ff0000"); // 真实均值色，不是量化后的 #f80000
    expect(text).not.toContain("#f80000");
    expect(text).toContain("100.0%");
  });

  it("非整齐色值同样返回真实均值（量化只作聚类键）", async () => {
    // #FEFEFE 量化后是 #F8F8F8，若直接输出量化值这里就会失败
    const png = await makePng(30, 30, 0xfefefeff);
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png" },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("#fefefe");
  });

  it("candidates 返回最接近的候选色", async () => {
    const png = await makePng(50, 50, 0xff0000ff);
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png", candidates: ["#00ff00", "#ff0000", "#0000ff"] },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("最接近候选色 #ff0000");
  });

  it("candidates 逐像素评分：给出覆盖率与加权证据（0.8.0 新增）", async () => {
    // 背景占 ~91%：像素评分胜出者是背景本身（多数即证据），
    // 覆盖率/加权数字是比旧「单一色差值」强的证据链
    const img = new Jimp({ width: 100, height: 100, color: 0x0b193cff });
    img.composite(new Jimp({ width: 30, height: 30, color: 0xff8800ff }), 35, 35);
    const png = await img.getBuffer("image/png");
    const text = await runLocal(
      COLORS_TOOL,
      {
        source: "x.png",
        candidates: ["#0b193c", "#ff8800"],
      },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("最接近候选色 #0b193c"); // 兼容行保留旧语义
    expect(text).toContain("候选逐像素评分");
    expect(text).toContain("覆盖 9"); // 橙色块 900/10000 = 9%
    expect(text).toMatch(/#0b193c 覆盖 9\d?\.\d%/); // 背景覆盖 ~91%
    expect(text).toContain("（胜出）");
  });

  it("candidates 含非法 hex 时抛 ImageError（不静默返回错误候选）", async () => {
    const png = await makePng(50, 50, 0xff0000ff);
    await expect(
      runLocal(
        COLORS_TOOL,
        { source: "x.png", candidates: ["#00ff00", "#xyz"] },
        { reader: readerFrom({ "x.png": png }) },
      ),
    ).rejects.toMatchObject({ name: "ImageError" });
  });

  it("全透明图返回无可分析提示", async () => {
    const png = await makePng(20, 20, 0xc8181800); // RGB 有值但 alpha=0
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png" },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("完全透明");
  });

  it("region 限定分析范围", async () => {
    // 左红右绿的图，region 限定左半，主色应为红
    const img = new Jimp({ width: 40, height: 20, color: 0xff0000ff });
    img.composite(new Jimp({ width: 20, height: 20, color: 0x00ff00ff }), 20, 0);
    const png = await img.getBuffer("image/png");
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png", region: "0,0,20,20" },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("#ff0000");
    expect(text).not.toContain("#00ff00");
    expect(text).toContain("原图 40×20，region 裁剪后 20×20"); // 尺寸回显，省掉 sips 一类取尺寸的调用
  });

  it("输出回显原图尺寸（无 region）", async () => {
    const png = await makePng(50, 50, 0xff0000ff);
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png" },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("原图 50×50");
  });

  it("相近簇（9≤Δ≤16）触发提示：可能存在细微色差或渐变", async () => {
    // 左右两半差 ΔR=11 —— 后合并只并 Δ≤8 的簇，9-16 的近邻保留两簇并提示
    const img = new Jimp({ width: 40, height: 20, color: 0x6cceffff });
    img.composite(new Jimp({ width: 20, height: 20, color: 0x61ccffff }), 20, 0);
    const png = await img.getBuffer("image/png");
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png" },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("相近簇");
    expect(text).toContain("Δ=11");
    expect(text).toContain("profile");
  });

  it("更近的簇（Δ≤8）被后合并为单簇，不再提示相近（0.8.0 行为变化）", async () => {
    // ΔR=6：旧版报「相近簇 Δ=6」，现按像素数加权均值并成一簇（渐变碎簇收敛）
    const img = new Jimp({ width: 40, height: 20, color: 0x6cceffff });
    img.composite(new Jimp({ width: 20, height: 20, color: 0x66ccffff }), 20, 0);
    const png = await img.getBuffer("image/png");
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png" },
      { reader: readerFrom({ "x.png": png }) },
    );
    // 单簇 100% + 均值落在 #69 附近（合成边界有 1 列抗锯齿，允许 ±1）
    expect(text).toContain("100.0%");
    expect(text).toMatch(/1\. #69c[de]f{1,2}\b/);
    expect(text).not.toContain("相近簇");
  });

  it("背景统治图（top1>60%）自动追加背景排除视图，内容色浮出", async () => {
    // 深背景 #0b193c 占 ~90% + 中央橙色块 #ff8800 —— 主色榜被背景淹没
    const img = new Jimp({ width: 100, height: 100, color: 0x0b193cff });
    img.composite(new Jimp({ width: 30, height: 30, color: 0xff8800ff }), 35, 35);
    const png = await img.getBuffer("image/png");
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png" },
      { reader: readerFrom({ "x.png": png }) },
    );
    // 主列表（含背景）保持原样 + 追加排除视图（只加段不动已有行）
    expect(text).toContain("#0b193c");
    expect(text).toContain("背景排除视图");
    expect(text).toContain("#ff8800");
  });

  it("exclude_background: true 时主列表即背景排除视图", async () => {
    const img = new Jimp({ width: 100, height: 100, color: 0x0b193cff });
    img.composite(new Jimp({ width: 30, height: 30, color: 0xff8800ff }), 35, 35);
    const png = await img.getBuffer("image/png");
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png", exclude_background: true },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("背景排除视图");
    // 排除视图首个列表行应是内容色（头部说明里的背景 hex 不算数）
    expect(text).toMatch(/背景排除视图（[^\n]+\n1\. #ff8800/);
  });

  it("纯色图不触发相近簇提示", async () => {
    const png = await makePng(50, 50, 0xff0000ff);
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png" },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).not.toContain("相近簇");
  });
});

describe("COLORS_TOOL profile 模式", () => {
  it("平铺渐变接缝：两段渐变 + 中间一处跳变（含位置与两侧色值）", async () => {
    // 复现真实案例：150px 渐变被上下平铺两份 —— 上半 R 100→119，下半又从 100 开始
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => 100 + i),
      ...Array.from({ length: 20 }, (_, i) => 100 + i),
    ];
    const png = await rowsPng(10, rows);
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png", profile: "y" },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("共 2 段、1 处跳变");
    expect(text).toContain("y=0~19");
    expect(text).toContain("y=20 跳变：#77ccff → #64ccff（最大通道差 19）");
    expect(text).toContain("渐变 ΔR=19");
  });

  it("平滑渐变：单段、无跳变", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => 100 + i); // 每行 +1，远低于跳变阈值
    const png = await rowsPng(10, rows);
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png", profile: "y" },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("共 1 段、0 处跳变");
    expect(text).toContain("渐变 ΔR=39");
  });

  it('profile:"x" 按列扫描，左右两个纯色块报一处跳变', async () => {
    const img = new Jimp({ width: 40, height: 10, color: 0xff0000ff });
    img.composite(new Jimp({ width: 20, height: 10, color: 0x0000ffff }), 20, 0);
    const png = await img.getBuffer("image/png");
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png", profile: "x" },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("x=0~19：#ff0000（纯色）");
    expect(text).toContain("x=20 跳变");
  });

  it("分段过多（纹理噪声）时收敛为 top 跳变 + 缩小 region 建议", async () => {
    // 红蓝逐行交替：每行都是跳变
    const rows = Array.from({ length: 30 }, (_, i) => (i % 2 ? 255 : 100));
    const png = await rowsPng(10, rows);
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png", profile: "y" },
      { reader: readerFrom({ "x.png": png }) },
    );
    expect(text).toContain("分段过多");
    expect(text).toContain("region");
  });
});

describe("segmentAxisProfile（纯函数）", () => {
  const blue = (r: number) => ({ r, g: 204, b: 255 });

  it("空洞两侧颜色一致时跨空洞并段（文字带不产生跳变）", () => {
    const lines = [
      { index: 0, rgb: blue(100) },
      { index: 1, rgb: blue(100) },
      // 2~4 为杂线（主簇覆盖不足）被跳过
      { index: 5, rgb: blue(101) },
      { index: 6, rgb: blue(101) },
    ];
    const { segments, jumps } = segmentAxisProfile(lines);
    expect(segments).toHaveLength(1);
    expect(segments[0]).toMatchObject({ from: 0, to: 6 });
    expect(jumps).toHaveLength(0);
  });

  it("相邻线色差超阈值切成两段并记录跳变", () => {
    const lines = [
      { index: 10, rgb: blue(100) },
      { index: 11, rgb: blue(119) },
    ];
    const { segments, jumps } = segmentAxisProfile(lines);
    expect(segments.map((s) => [s.from, s.to])).toEqual([
      [10, 10],
      [11, 11],
    ]);
    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toMatchObject({ at: 11, diff: 19 });
  });

  it("空输入返回空结果", () => {
    const { segments, jumps } = segmentAxisProfile([]);
    expect(segments).toEqual([]);
    expect(jumps).toEqual([]);
  });
});

describe("图表取色（0.8.0 目标场景：堆叠柱状图系列色）", () => {
  /** 合成堆叠柱图：深底 + 网格 + 3 根柱（上段蓝渐变 #6aa3f2→#3160a5，下段青渐变 #6fe2ff→#2e86ad） */
  async function stackedBarPng(): Promise<{ png: Buffer; barXs: [number, number] }> {
    const W = 100, H = 80;
    const img = new Jimp({ width: W, height: H, color: 0x0b193cff });
    const d = img.bitmap.data;
    const set = (x: number, y: number, r: number, g: number, b: number) => {
      const o = (y * W + x) * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    };
    // 网格线
    for (let y = 24; y <= 72; y += 24) for (let x = 0; x < W; x++) set(x, y, 0x16, 0x26, 0x4f);
    const upper: [number, number, number][] = [[0x6a, 0xa3, 0xf2], [0x31, 0x60, 0xa5]];
    const lower: [number, number, number][] = [[0x6f, 0xe2, 0xff], [0x2e, 0x86, 0xad]];
    const lerp = (a: [number, number, number], b: [number, number, number], t: number) =>
      a.map((v, i) => Math.round(v + (b[i] - v) * t)) as [number, number, number];
    const x0 = 20, bw = 16, lowerH = 20, upperH = 30, yBase = 76;
    for (let x = x0; x < x0 + bw; x++) {
      for (let k = 0; k < lowerH; k++) {
        const c = lerp(lower[0], lower[1], k / lowerH);
        set(x, yBase - 1 - k, c[0], c[1], c[2]);
      }
      for (let k = 0; k < upperH; k++) {
        const c = lerp(upper[0], upper[1], k / upperH);
        set(x, yBase - 1 - lowerH - k, c[0], c[1], c[2]);
      }
    }
    return { png: await img.getBuffer("image/png"), barXs: [x0 + 2, x0 + bw - 2] };
  }

  it("单柱窄条 profile:y 一次拿全两段渐变的起止 hex（那次手写 PIL 的确定性等价物）", async () => {
    const { png, barXs } = await stackedBarPng();
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png", region: `${barXs[0]},0,${barXs[1]},80`, profile: "y" },
      { reader: readerFrom({ "x.png": png }) },
    );
    // 上段渐变两端 + 下段渐变两端全部命中（Δ≤6）
    for (const gt of ["#6aa3f2", "#3160a5", "#6fe2ff", "#2e86ad"]) {
      const [gr, gg, gb] = [1, 3, 5].map((i) => parseInt(gt.slice(i, i + 2), 16));
      const hit = [...text.matchAll(/#[0-9a-f]{6}/gi)].some((m) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(m[0].slice(i, i + 2), 16));
        return Math.max(Math.abs(r - gr), Math.abs(g - gg), Math.abs(b - gb)) <= 6;
      });
      expect(hit, `应命中 ${gt}`).toBe(true);
    }
  });

  it("exclude_background 主列表被柱色占据（深底不再淹没）", async () => {
    const { png } = await stackedBarPng();
    const text = await runLocal(
      COLORS_TOOL,
      { source: "x.png", exclude_background: true },
      { reader: readerFrom({ "x.png": png }) },
    );
    const rows = text.split("\n").filter((l) => /^\d+\. #/.test(l)).slice(0, 3).join(" ");
    // 前 3 主色不应再是背景/网格色
    for (const bg of ["#0b193c", "#16264f"]) {
      const [br, bbg, bb] = [1, 3, 5].map((i) => parseInt(bg.slice(i, i + 2), 16));
      const hit = [...rows.matchAll(/#[0-9a-f]{6}/gi)].some((m) => {
        const [r, g, b] = [1, 3, 5].map((i) => parseInt(m[0].slice(i, i + 2), 16));
        return Math.max(Math.abs(r - br), Math.abs(g - bbg), Math.abs(b - bb)) <= 12;
      });
      expect(hit, `前 3 主色不应包含背景 ${bg}`).toBe(false);
    }
  });
});
