import { describe, it, expect } from "vitest";
import {
  processImage,
  processImageWithScale,
  parseRegion,
  resolveRegion,
  cropAndProcess,
  type ImageLimits,
} from "../src/image.js";
import { Jimp } from "jimp";
import { makePng } from "./helpers.js";

const LIMITS: ImageLimits = {
  maxEdge: 1568,
  maxBytes: 50 * 1024 * 1024,
  maxPixels: 40_000_000,
};

describe("processImage", () => {
  it("小图不缩放，输出合法 JPEG base64", async () => {
    const out = await processImage(await makePng(100, 50), LIMITS);
    expect(out.mime).toBe("image/jpeg");
    expect(out.base64.length).toBeGreaterThan(0);
    const buf = Buffer.from(out.base64, "base64");
    // JPEG SOI magic bytes
    expect(buf[0]).toBe(0xff);
    expect(buf[1]).toBe(0xd8);
  });

  it("大图等比缩放到长边上限，保持宽高比", async () => {
    const out = await processImage(await makePng(3000, 1500), LIMITS);
    const img = await Jimp.read(Buffer.from(out.base64, "base64"));
    expect(img.width).toBeLessThanOrEqual(1568);
    expect(img.height).toBeLessThanOrEqual(1568);
    // 原图 2:1，缩放后仍应约 2:1
    expect(Math.round(img.width / img.height)).toBe(2);
  });

  it("高度为长边时也正确缩放", async () => {
    const out = await processImage(await makePng(1000, 3000), LIMITS);
    const img = await Jimp.read(Buffer.from(out.base64, "base64"));
    expect(img.height).toBeLessThanOrEqual(1568);
  });

  it("超体积上限抛 ImageError", async () => {
    await expect(
      processImage(Buffer.alloc(100), { ...LIMITS, maxBytes: 50 }),
    ).rejects.toMatchObject({ name: "ImageError" });
  });

  it("无法解码的字节抛 ImageError", async () => {
    await expect(
      processImage(Buffer.from("not an image"), LIMITS),
    ).rejects.toMatchObject({ name: "ImageError" });
  });

  it("超像素上限在解码前被拒（体积很小也拦得住）", async () => {
    // 2000×2000 纯色 PNG 压缩后仅几 KB，远低于 maxBytes，
    // 但解码需 16MB bitmap —— 只查体积拦不住，必须靠 header 尺寸
    const raw = await makePng(2000, 2000, 0xffffffff);
    expect(raw.byteLength).toBeLessThan(1024 * 1024);
    await expect(
      processImage(raw, { ...LIMITS, maxPixels: 1_000_000 }),
    ).rejects.toThrow(/超过上限.*M 像素/);
  });

  it("像素数在上限内正常通过", async () => {
    const raw = await makePng(500, 500);
    const out = await processImage(raw, { ...LIMITS, maxPixels: 1_000_000 });
    expect(out.mime).toBe("image/jpeg");
  });
});

describe("parseRegion", () => {
  it("标准与反向坐标", () => {
    expect(parseRegion("10,20,30,40")).toEqual({ x: 10, y: 20, w: 20, h: 20 });
    // x1>x2 / y1>y2 自动反转
    expect(parseRegion("30,40,10,20")).toEqual({ x: 10, y: 20, w: 20, h: 20 });
  });

  it("允许逗号两侧空白", () => {
    expect(parseRegion(" 10 , 20 , 30 , 40 ")).toEqual({
      x: 10,
      y: 20,
      w: 20,
      h: 20,
    });
  });

  it("段数不对 / 非数字 / 尾随垃圾 / 负数都拒绝", () => {
    expect(() => parseRegion("1,2,3")).toThrow(/格式非法/);
    expect(() => parseRegion("1,2,3,4abc")).toThrow(/格式非法/);
    expect(() => parseRegion("1,2,3,4.5")).toThrow(/格式非法/);
    expect(() => parseRegion("-1,2,3,4")).toThrow(/格式非法/);
  });

  it("面积为 0 拒绝", () => {
    expect(() => parseRegion("10,10,10,10")).toThrow(/面积为 0/);
  });
});

describe("resolveRegion", () => {
  it("部分越界 clamp 到图片边界", () => {
    expect(resolveRegion("80,80,200,200", 100, 100)).toEqual({
      x: 80,
      y: 80,
      w: 20,
      h: 20,
    });
    expect(resolveRegion("0,0,500,500", 100, 100)).toEqual({
      x: 0,
      y: 0,
      w: 100,
      h: 100,
    });
  });

  it("完全越界抛带图片尺寸的 ImageError", () => {
    expect(() => resolveRegion("200,200,300,300", 100, 100)).toThrow(
      /完全超出图片边界（图片 100×100）/,
    );
  });
});

describe("processImageWithScale", () => {
  it("非整除缩放比下 originalWidth/Height 仍为缩放前真实整数", async () => {
    // 3137×1568 → scaleToFit 后高被取整，若用除法反推 originalHeight 会得 1568.5
    const r = await processImageWithScale(await makePng(3137, 1568), LIMITS);
    expect(r.originalWidth).toBe(3137);
    expect(r.originalHeight).toBe(1568);
    expect(Number.isInteger(r.originalWidth)).toBe(true);
    expect(Number.isInteger(r.originalHeight)).toBe(true);
  });

  it("不缩放时 scale=1 且尺寸不变", async () => {
    const r = await processImageWithScale(await makePng(100, 80), LIMITS);
    expect(r.scale).toBe(1);
    expect(r.originalWidth).toBe(100);
    expect(r.originalHeight).toBe(80);
  });
});

describe("cropAndProcess", () => {
  it("按 region 裁剪（越界自动收进边界）", async () => {
    const out = await cropAndProcess(
      await makePng(100, 80),
      "80,70,150,150",
      LIMITS,
    );
    const img = await Jimp.read(Buffer.from(out.base64, "base64"));
    expect(img.width).toBe(20);
    expect(img.height).toBe(10);
  });
});
