import { describe, it, expect } from "vitest";
import { INSPECT_TOOL } from "../src/tools/inspect.js";
import { runVision, makePng, readerOf, mockFetch } from "./helpers.js";

const png80 = () => makePng(100, 80);

describe("INSPECT_TOOL", () => {
  it("解析多行元素列表（含文字与无文字）", async () => {
    const f = mockFetch(
      "1. 发送按钮 x1: 10, y1: 20, x2: 30, y2: 40\n" +
        "2. (no text) x1: 50, y1: 60, x2: 70, y2: 80",
    );
    const text = await runVision(
      INSPECT_TOOL,
      { source: "x.png", kind: "buttons" },
      { reader: readerOf(await png80()), fetchImpl: f },
    );
    expect(text).toContain("1. 发送按钮 x1: 10, y1: 20, x2: 30, y2: 40");
    expect(text).toContain("2. (no text) x1: 50, y1: 60, x2: 70, y2: 80");

    // prompt 含 kind
    const body = JSON.parse(f.calls[0][1].body as string);
    expect(body.messages[0].content.at(-1).text).toContain("buttons");
  });

  it("未传 kind 时用默认 UI 元素描述（英文，与英文 prompt 同语）", async () => {
    const f = mockFetch("1. 标题 x1: 0, y1: 0, x2: 50, y2: 20");
    await runVision(
      INSPECT_TOOL,
      { source: "x.png" },
      { reader: readerOf(await png80()), fetchImpl: f },
    );
    const body = JSON.parse(f.calls[0][1].body as string);
    expect(body.messages[0].content.at(-1).text).toContain("UI elements");
  });

  it("模型返回无可解析行时回退原文", async () => {
    const text = await runVision(
      INSPECT_TOOL,
      { source: "x.png", kind: "buttons" },
      {
        reader: readerOf(await png80()),
        fetchImpl: mockFetch("图片中没有任何按钮"),
      },
    );
    expect(text).toContain("未检测到");
    expect(text).toContain("图片中没有任何按钮");
  });

  it("正文中的 1920x1080 不会被坐标剥离正则吃掉", async () => {
    const text = await runVision(
      INSPECT_TOOL,
      { source: "x.png", kind: "labels" },
      {
        reader: readerOf(await png80()),
        fetchImpl: mockFetch("1. 1920x1080 分辨率 x1: 0, y1: 0, x2: 50, y2: 20"),
      },
    );
    expect(text).toContain("1920x1080 分辨率");
  });

  it("box1: 20 这类正文不会被坐标清理误吃（前置词边界）", async () => {
    const text = await runVision(
      INSPECT_TOOL,
      { source: "x.png", kind: "labels" },
      {
        reader: readerOf(await png80()),
        fetchImpl: mockFetch("1. box1: 20 分辨率 x1: 0, y1: 0, x2: 50, y2: 20"),
      },
    );
    expect(text).toContain("box1: 20 分辨率");
    expect(text).not.toContain("bo 分辨率");
  });

  it("markdown 列表符号被剥掉，不产生双重编号", async () => {
    const text = await runVision(
      INSPECT_TOOL,
      { source: "x.png", kind: "buttons" },
      {
        reader: readerOf(await png80()),
        fetchImpl: mockFetch("- 1. 发送按钮 x1: 10, y1: 20, x2: 30, y2: 40"),
      },
    );
    expect(text).toContain("1. 发送按钮 x1: 10, y1: 20, x2: 30, y2: 40");
    expect(text).not.toContain("- 1.");
  });

  it("schema 拒绝数组 source（inspect 只支持单图）", () => {
    expect(
      INSPECT_TOOL.schema.safeParse({ source: ["a.png", "b.png"] }).success,
    ).toBe(false);
  });
});
