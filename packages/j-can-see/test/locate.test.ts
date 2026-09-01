import { describe, it, expect } from "vitest";
import { LOCATE_TOOL } from "../src/tools/locate.js";
import { runVision, makePng, readerOf, mockFetch } from "./helpers.js";

const png80 = () => makePng(100, 80);

describe("LOCATE_TOOL", () => {
  it("成功定位，返回原图坐标（小图 scale=1）", async () => {
    const f = mockFetch("x1: 10, y1: 20, x2: 30, y2: 40");
    const text = await runVision(
      LOCATE_TOOL,
      { source: "x.png", target: "发送按钮" },
      { reader: readerOf(await png80()), fetchImpl: f },
    );
    expect(text).toContain("找到");
    expect(text).toContain("x1: 10, y1: 20, x2: 30, y2: 40");

    // prompt 含 target 描述
    const body = JSON.parse(f.calls[0][1].body as string);
    expect(body.messages[0].content.at(-1).text).toContain("发送按钮");
  });

  it("大图坐标按缩放比例换算回原图", async () => {
    // 3136x1568 → 等比缩放到长边 1568 → scale 恰为 0.5；模型返回 50,100,75,115 → 原图 100,200,150,230
    const text = await runVision(
      LOCATE_TOOL,
      { source: "x.png", target: "按钮" },
      {
        reader: readerOf(await makePng(3136, 1568)),
        fetchImpl: mockFetch("x1: 50, y1: 100, x2: 75, y2: 115"),
      },
    );
    expect(text).toContain("x1: 100, y1: 200, x2: 150, y2: 230");
  });

  it("NOT_FOUND 返回未找到，并附可操作建议（crop 分段 / inspect 枚举 / 背景区块改用 colors）", async () => {
    const text = await runVision(
      LOCATE_TOOL,
      { source: "x.png", target: "按钮" },
      { reader: readerOf(await png80()), fetchImpl: mockFetch("NOT_FOUND") },
    );
    expect(text).toContain("未找到");
    expect(text).toContain("crop");
    expect(text).toContain("inspect");
    expect(text).toContain("1568"); // 提示压缩上限，解释长图上找不到的原因
    expect(text).toContain("colors"); // 背景区块不是 grounding 认得的元素，指向像素探测
  });

  it("越界坐标 clamp 到图片边界，输出可直接回喂 region", async () => {
    // 100x80 图，模型返回 x2/y2 各超界 5px
    const text = await runVision(
      LOCATE_TOOL,
      { source: "x.png", target: "按钮" },
      {
        reader: readerOf(await png80()),
        fetchImpl: mockFetch("x1: 95, y1: 75, x2: 105, y2: 85"),
      },
    );
    expect(text).toContain("x1: 95, y1: 75, x2: 100, y2: 80");
  });

  it("负坐标 clamp 到 0（region 格式不接受负数）", async () => {
    const text = await runVision(
      LOCATE_TOOL,
      { source: "x.png", target: "按钮" },
      {
        reader: readerOf(await png80()),
        fetchImpl: mockFetch("x1: -10, y1: 20, x2: 30, y2: 40"),
      },
    );
    expect(text).toContain("x1: 0, y1: 20, x2: 30, y2: 40");
  });

  it("schema 拒绝数组 source（locate 只支持单图）", () => {
    expect(
      LOCATE_TOOL.schema.safeParse({
        source: ["a.png", "b.png"],
        target: "按钮",
      }).success,
    ).toBe(false);
  });

  it("序列化数组字符串给明确参数错误（而非落进文件解析报「文件不存在」）", () => {
    const parsed = LOCATE_TOOL.schema.safeParse({
      source: '["a.png", "b.png"]',
      target: "按钮",
    });
    expect(parsed.success).toBe(false);
    expect(parsed.error?.issues[0]?.message).toContain("仅支持单张图片");
    expect(parsed.error?.issues[0]?.message).toContain("see_image");
  });

  it("无法解析坐标时返回模型原文", async () => {
    const text = await runVision(
      LOCATE_TOOL,
      { source: "x.png", target: "按钮" },
      {
        reader: readerOf(await png80()),
        fetchImpl: mockFetch("图片很模糊我看不清"),
      },
    );
    expect(text).toContain("无法解析");
    expect(text).toContain("图片很模糊我看不清");
  });

  it("非整除缩放比 + 越界坐标：输出全为整数（可直接回喂 region）", async () => {
    // 3137×1568 缩放到 1568 宽，宽高比不整除（原 bug：clamp 边界 1568.5 产出小数）
    const text = await runVision(
      LOCATE_TOOL,
      { source: "x.png", target: "右下角按钮" },
      {
        reader: readerOf(await makePng(3137, 1568)),
        fetchImpl: mockFetch("x1: 1400, y1: 1500, x2: 3200, y2: 3200"),
      },
    );
    expect(text).not.toMatch(/\d+\.\d/); // 无小数
    expect(text).toMatch(/y[12]: 1568/); // clamp 到真实原图高（1568 而非 1568.5）
  });

  it("模型返回多个匹配时全部列出并提示细化 target", async () => {
    const text = await runVision(
      LOCATE_TOOL,
      { source: "x.png", target: "按钮" },
      {
        reader: readerOf(await png80()),
        fetchImpl: mockFetch(
          "x1: 10, y1: 20, x2: 30, y2: 40\nx1: 50, y1: 60, x2: 70, y2: 80",
        ),
      },
    );
    expect(text).toContain("2 个");
    expect(text).toContain("过于宽泛");
    expect(text).toContain("x1: 10, y1: 20, x2: 30, y2: 40");
    expect(text).toContain("x1: 50, y1: 60, x2: 70, y2: 80");
  });
});
