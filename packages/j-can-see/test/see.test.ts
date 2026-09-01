import { describe, it, expect } from "vitest";
import { Jimp } from "jimp";
import { SEE_IMAGE_TOOL } from "../src/tools/see.js";
import {
  runVision,
  makePng,
  readerFrom,
  mockFetch,
  type RecordingFetch,
} from "./helpers.js";

/** 从 mock fetch 的请求体里取出第 n 张图的解码尺寸 */
async function imageDimsAt(
  f: RecordingFetch,
  n: number,
): Promise<{ w: number; h: number }> {
  const body = JSON.parse(f.calls[0][1].body as string);
  const url: string = body.messages[0].content[n].image_url.url;
  const img = await Jimp.read(Buffer.from(url.split(",")[1], "base64"));
  return { w: img.width, h: img.height };
}

describe("SEE_IMAGE_TOOL", () => {
  it("单图向后兼容：source 字符串 + prompt，返回模型文本", async () => {
    const png = await makePng(100, 80);
    const f = mockFetch("一张红色矩形图");
    const text = await runVision(
      SEE_IMAGE_TOOL,
      { source: "x.png", prompt: "描述" },
      { reader: readerFrom({ "x.png": png }), fetchImpl: f },
    );
    expect(text).toBe("一张红色矩形图");
    const body = JSON.parse(f.calls[0][1].body as string);
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content[1].text).toBe("描述");
  });

  it("省略 prompt 用默认描述指令（英文，含反推测约束）", async () => {
    const png = await makePng(50, 50);
    const f = mockFetch("ok");
    await runVision(
      SEE_IMAGE_TOOL,
      { source: "x.png" },
      { reader: readerFrom({ "x.png": png }), fetchImpl: f },
    );
    const body = JSON.parse(f.calls[0][1].body as string);
    const text = body.messages[0].content[1].text as string;
    expect(text).toContain("Describe this image in detail");
    expect(text).toContain("cannot confirm");
  });

  it("region 先裁后看：请求体里的图就是裁剪后的尺寸", async () => {
    const png = await makePng(100, 80);
    const f = mockFetch("左上角区域");
    await runVision(
      SEE_IMAGE_TOOL,
      { source: "x.png", region: "10,20,40,60", prompt: "这块是什么" },
      { reader: readerFrom({ "x.png": png }), fetchImpl: f },
    );
    expect(await imageDimsAt(f, 0)).toEqual({ w: 30, h: 40 });
  });

  it("region 轻微越界自动收进边界（回环链路不再 RangeError）", async () => {
    const png = await makePng(100, 80);
    const f = mockFetch("ok");
    await runVision(
      SEE_IMAGE_TOOL,
      { source: "x.png", region: "90,70,110,90" },
      { reader: readerFrom({ "x.png": png }), fetchImpl: f },
    );
    expect(await imageDimsAt(f, 0)).toEqual({ w: 10, h: 10 });
  });

  it("多图对比：请求体含多个 image block", async () => {
    const a = await makePng(60, 60, 0xff0000ff);
    const b = await makePng(60, 60, 0x00ff00ff);
    const f = mockFetch("两张图颜色不同");
    const text = await runVision(
      SEE_IMAGE_TOOL,
      { source: ["a.png", "b.png"], prompt: "有什么不同" },
      { reader: readerFrom({ "a.png": a, "b.png": b }), fetchImpl: f },
    );
    expect(text).toBe("两张图颜色不同");
    const body = JSON.parse(f.calls[0][1].body as string);
    expect(body.messages[0].content).toHaveLength(3);
    expect(body.messages[0].content[0].type).toBe("image_url");
    expect(body.messages[0].content[1].type).toBe("image_url");
    expect(body.messages[0].content[2].text).toBe("有什么不同");
  });

  it("region + 多图被 schema 拒绝（参数错误而非运行期异常）", () => {
    const parsed = SEE_IMAGE_TOOL.schema.safeParse({
      source: ["a.png", "b.png"],
      region: "0,0,10,10",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("region 仅支持单图");
  });

  it("source 传序列化数组字符串（调用方模型实测误用）也能多图对比", async () => {
    const a = await makePng(60, 60, 0xff0000ff);
    const b = await makePng(60, 60, 0x00ff00ff);
    const f = mockFetch("两张图颜色不同");
    const text = await runVision(
      SEE_IMAGE_TOOL,
      { source: '["a.png", "b.png"]', prompt: "有什么不同" },
      { reader: readerFrom({ "a.png": a, "b.png": b }), fetchImpl: f },
    );
    expect(text).toBe("两张图颜色不同");
    const body = JSON.parse(f.calls[0][1].body as string);
    expect(body.messages[0].content).toHaveLength(3);
    expect(body.messages[0].content.filter((c: { type: string }) => c.type === "image_url")).toHaveLength(2);
  });

  it("数组样子的非法 JSON 字符串仍按普通路径处理（不误伤合法文件名）", () => {
    const parsed = SEE_IMAGE_TOOL.schema.parse({
      source: "[broken.png",
    }) as { source: string[] };
    expect(parsed.source).toEqual(["[broken.png"]);
  });

  it("空字符串 source 被 schema 拒绝", () => {
    expect(SEE_IMAGE_TOOL.schema.safeParse({ source: "" }).success).toBe(false);
  });

  it("schema 把单值 source 归一为数组（run 因此无需做防御归一）", () => {
    const parsed = SEE_IMAGE_TOOL.schema.parse({ source: "x.png" }) as {
      source: string[];
    };
    expect(parsed.source).toEqual(["x.png"]);
  });
});
