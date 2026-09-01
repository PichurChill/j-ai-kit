/**
 * 测试辅助：统一的 fixture 与「经 schema 解析后再调 run」的入口。
 *
 * 为什么必须过 schema：生产路径（index.ts）一定先校验再调 run。
 * 测试若把裸对象直接递给 run，就绕过了 schema 的 transform
 *（如 see_image 的 source 单值 → 数组），会逼生产代码为测试写防御分支。
 */
import { vi } from "vitest";
import { Jimp } from "jimp";
import type { AppConfig, BaseConfig } from "../src/config.js";
import type { SourceReader } from "../src/sources/index.js";
import type { FetchLike } from "../src/vision.js";
import type {
  LocalToolEntry,
  VisionToolEntry,
  ToolDeps,
} from "../src/tools/types.js";

/** 本地工具用配置（无视觉三项 —— 类型上就没有） */
export const TEST_BASE_CONFIG: BaseConfig = {
  J_SEE_API_SPEC: "openai",
  J_SEE_REASONING: "none",
  J_SEE_MAX_EDGE: 1568,
  J_SEE_MAX_BYTES: 50 * 1024 * 1024,
  J_SEE_MAX_PIXELS: 40_000_000,
  J_SEE_TIMEOUT_MS: 90000,
  J_SEE_OCR_TOTAL_TIMEOUT_MS: 85_000,
  J_SEE_MAX_CONCURRENT: 3,
  J_SEE_MAX_ATTEMPTS: 3,
  J_SEE_TASK_BUDGET_MS: 85_000,
};

/** 视觉工具用配置 */
export const TEST_CONFIG: AppConfig = {
  ...TEST_BASE_CONFIG,
  J_SEE_TOKEN: "tok",
  J_SEE_BASE_URL: "https://example.com",
  J_SEE_MODEL: "m",
};

/** 本地工具：raw 参数先过 schema，再调 run */
export function runLocal<A>(
  entry: LocalToolEntry<A>,
  raw: unknown,
  deps?: ToolDeps,
  config: BaseConfig = TEST_BASE_CONFIG,
): Promise<string> {
  return entry.run(entry.schema.parse(raw) as A, config, deps);
}

/** 视觉工具：raw 参数先过 schema，再调 run */
export function runVision<A>(
  entry: VisionToolEntry<A>,
  raw: unknown,
  deps?: ToolDeps,
  config: AppConfig = TEST_CONFIG,
): Promise<string> {
  return entry.run(entry.schema.parse(raw) as A, config, deps);
}

/** 构造一张指定尺寸/颜色的 PNG */
export function makePng(
  w: number,
  h: number,
  color = 0xff0000ff,
): Promise<Buffer> {
  return new Jimp({ width: w, height: h, color }).getBuffer("image/png");
}

/**
 * 按 source 字符串查表的 reader。
 * readSource 按来源分发：文件/URL 以原始字符串为键，
 * clipboard/latest 以固定字面量为键。
 */
export function readerFrom(map: Record<string, Buffer>): SourceReader {
  const lookup = async (key: string): Promise<Buffer> => {
    const buf = map[key];
    if (!buf) throw new Error(`mock 缺少 ${key}`);
    return buf;
  };
  return {
    readFromFile: vi.fn((input: string) => lookup(input)),
    readFromUrl: vi.fn((url: string) => lookup(url)),
    readClipboard: vi.fn(() => lookup("clipboard")),
    readLatestScreenshot: vi.fn(() => lookup("latest")),
  } as unknown as SourceReader;
}

/** 任何 source 都返回同一张图的 reader */
export function readerOf(png: Buffer): SourceReader {
  return {
    readFromFile: vi.fn(async () => png),
    readFromUrl: vi.fn(async () => png),
    readClipboard: vi.fn(async () => png),
    readLatestScreenshot: vi.fn(async () => png),
  } as unknown as SourceReader;
}

export type RecordingFetch = FetchLike & {
  readonly calls: [string, RequestInit][];
  count(): number;
};

/** openai 规范的成功响应体 */
const openaiBody = (content: string) =>
  JSON.stringify({ choices: [{ message: { content } }] });

/** 每次调用都返回同一段内容，并记录请求 */
export function mockFetch(content: string): RecordingFetch {
  return mockFetchSeq([content]);
}

/**
 * 按调用次数依次返回不同内容（用尽后重复最后一段），并记录请求。
 * 仅适用于串行调用的工具 —— 并发场景下「第 i 次调用」对不上「第 i 项输入」，
 * 那类逻辑请直接测纯函数（如 ocr 的 mergeTwo / buildAudit）。
 */
export function mockFetchSeq(contents: string[]): RecordingFetch {
  const calls: [string, RequestInit][] = [];
  let i = 0;
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    const content = contents[Math.min(i, contents.length - 1)] ?? "";
    i++;
    return new Response(openaiBody(content), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as RecordingFetch;
  Object.defineProperty(fn, "calls", { get: () => calls });
  Object.defineProperty(fn, "count", { value: () => i });
  return fn;
}
