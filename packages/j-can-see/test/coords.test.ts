import { describe, it, expect } from "vitest";
import {
  extractBoxByLabel,
  toOriginal,
  clampBox,
  formatBox,
} from "../src/tools/coords.js";

describe("extractBoxByLabel", () => {
  it("标准格式 x1: 100, y1: 200...", () => {
    expect(extractBoxByLabel("x1: 100, y1: 200, x2: 150, y2: 230")).toEqual({
      x1: 100,
      y1: 200,
      x2: 150,
      y2: 230,
    });
  });

  it("无空格 x1:100", () => {
    expect(extractBoxByLabel("x1:100,y1:200,x2:150,y2:230")).toEqual({
      x1: 100,
      y1: 200,
      x2: 150,
      y2: 230,
    });
  });

  it("中文冒号/逗号兼容", () => {
    expect(extractBoxByLabel("x1：100，y1：200，x2：150，y2：230")).toEqual({
      x1: 100,
      y1: 200,
      x2: 150,
      y2: 230,
    });
  });

  it("夹杂序号与文字仍能按标签提取", () => {
    expect(
      extractBoxByLabel("1. 发送按钮 x1: 100, y1: 200, x2: 150, y2: 230"),
    ).toEqual({ x1: 100, y1: 200, x2: 150, y2: 230 });
  });

  it("缺少任一标签返回 null", () => {
    expect(extractBoxByLabel("100,200,150,230")).toBeNull();
    expect(extractBoxByLabel("x1: 100, y1: 200")).toBeNull();
  });

  it("x12 不污染 x1（词边界）", () => {
    // "x12: 5" 是 x12 标签，不是 x1
    expect(extractBoxByLabel("x12: 5, y1: 6, x2: 7, y2: 8")).toBeNull();
  });

  it("box1: 20 不污染 x1（前置词边界）", () => {
    expect(extractBoxByLabel("box1: 20, y1: 6, x2: 7, y2: 8")).toBeNull();
  });

  it("紧跟文本的 x1: 100 仍可解析", () => {
    expect(
      extractBoxByLabel("发送按钮位于 x1: 100 处，y1: 200, x2: 150, y2: 230"),
    ).toEqual({ x1: 100, y1: 200, x2: 150, y2: 230 });
  });
});

describe("toOriginal", () => {
  it("scale=1 坐标不变", () => {
    expect(toOriginal({ x1: 100, y1: 200, x2: 150, y2: 230 }, 1)).toEqual({
      x1: 100,
      y1: 200,
      x2: 150,
      y2: 230,
    });
  });

  it("scale=0.5 换算回 2 倍原图坐标", () => {
    expect(toOriginal({ x1: 50, y1: 100, x2: 75, y2: 115 }, 0.5)).toEqual({
      x1: 100,
      y1: 200,
      x2: 150,
      y2: 230,
    });
  });
});

describe("formatBox", () => {
  it("格式化输出", () => {
    expect(formatBox({ x1: 1, y1: 2, x2: 3, y2: 4 })).toBe(
      "x1: 1, y1: 2, x2: 3, y2: 4",
    );
  });
});

describe("clampBox", () => {
  it("界内坐标不变", () => {
    expect(clampBox({ x1: 10, y1: 20, x2: 30, y2: 40 }, 100, 80)).toEqual({
      x1: 10,
      y1: 20,
      x2: 30,
      y2: 40,
    });
  });

  it("越界/负数 clamp 到边界", () => {
    expect(clampBox({ x1: -10, y1: 75, x2: 105, y2: 85 }, 100, 80)).toEqual({
      x1: 0,
      y1: 75,
      x2: 100,
      y2: 80,
    });
  });
});
