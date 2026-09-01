import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { listTools, getTool } from "../src/tools/registry.js";
import { loadBaseConfig } from "../src/config.js";
import type { ToolEntry } from "../src/tools/types.js";
import type { FetchLike } from "../src/vision.js";
import { makePng, readerOf } from "./helpers.js";

const entries = (): ToolEntry[] =>
  listTools().map((t) => {
    const e = getTool(t.name);
    if (!e) throw new Error(`registry 缺少 ${t.name}`);
    return e;
  });

let tmpDir: string;
beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "jcs-reg-"));
});
afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("工具注册表", () => {
  it("工具名唯一", () => {
    const names = listTools().map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("getTool 能取回每个已注册工具；未知名返回 undefined", () => {
    for (const t of listTools()) expect(getTool(t.name)).toBeDefined();
    expect(getTool("no_such_tool")).toBeUndefined();
  });

  it("每个工具的 required 字段都在 properties 中声明", () => {
    for (const t of listTools()) {
      const props = Object.keys(t.inputSchema.properties);
      for (const key of t.inputSchema.required ?? []) {
        expect(props).toContain(key);
      }
    }
  });

  it("每个工具都有非空描述（AI 靠它选工具）", () => {
    for (const t of listTools()) {
      expect(t.description.length).toBeGreaterThan(0);
    }
  });
});

/** 各本地工具的一组合法参数；新增本地工具必须在此补一项（见下方守卫测试） */
const LOCAL_CASES: Record<string, (tmp: string) => unknown> = {
  crop: (tmp) => ({
    source: "x.png",
    region: "0,0,10,10",
    output: path.join(tmp, "c.png"),
  }),
  image_diff: () => ({ a: "x.png", b: "x.png" }),
  colors: () => ({ source: "x.png" }),
  trace: () => ({ source: "x.png", colors: 2 }),
  extract_fg: (tmp) => ({ source: "x.png", output: path.join(tmp, "f.png") }),
};

/** 一被调用就抛：本地工具绝不该发起视觉调用 */
const forbiddenFetch = (() => {
  throw new Error("本地工具不应发起视觉调用");
}) as unknown as FetchLike;

describe("needsVision 标记", () => {
  it("视觉工具集合与预期一致（标反会导致空配置打到上游）", () => {
    const vision = entries()
      .filter((e) => e.needsVision)
      .map((e) => e.tool.name)
      .sort();
    expect(vision).toEqual(["inspect", "locate", "ocr_long", "see_image"]);
  });

  it("本地工具集合与预期一致", () => {
    const local = entries()
      .filter((e) => !e.needsVision)
      .map((e) => e.tool.name)
      .sort();
    expect(local).toEqual([
      "colors",
      "crop",
      "extract_fg",
      "image_diff",
      "trace",
    ]);
  });

  it("每个本地工具都有测试用例（新增工具必须补）", () => {
    const local = entries()
      .filter((e) => !e.needsVision)
      .map((e) => e.tool.name)
      .sort();
    expect(Object.keys(LOCAL_CASES).sort()).toEqual(local);
  });

  it("本地工具在零视觉配置下全部可用，且不触网", async () => {
    // 完全空的环境：没有任何 J_SEE_* 变量
    const config = loadBaseConfig({});
    const reader = readerOf(await makePng(40, 40, 0xff0000ff));

    for (const entry of entries()) {
      if (entry.needsVision) continue;
      const raw = LOCAL_CASES[entry.tool.name](tmpDir);
      const args = entry.schema.parse(raw);
      const out = await entry.run(args, config, {
        reader,
        fetchImpl: forbiddenFetch,
      });
      expect(typeof out).toBe("string");
      expect(out.length).toBeGreaterThan(0);
    }
  });
});
