import { describe, it, expect, vi } from "vitest";
import { callVision, type FetchLike } from "../src/vision.js";
import { VisionTimeoutError } from "../src/errors.js";
import type { AppConfig } from "../src/config.js";
import { TEST_CONFIG } from "./helpers.js";

const config: AppConfig = { ...TEST_CONFIG, J_SEE_MODEL: "grok-4.5" };

function mockFetch(opts: {
  ok: boolean;
  status?: number;
  body?: unknown;
  jsonError?: boolean;
}): FetchLike & { calls: [string, RequestInit][] } {
  const calls: [string, RequestInit][] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push([url, init]);
    return new Response(
      opts.jsonError ? "not-json" : JSON.stringify(opts.body ?? {}),
      {
        status: opts.ok ? 200 : (opts.status ?? 500),
        headers: { "Content-Type": "application/json" },
      },
    );
  }) as unknown as FetchLike & { calls: [string, RequestInit][] };
  fn.calls = calls;
  return fn;
}

const INPUT = {
  images: [{ base64: "AAA", mime: "image/jpeg" }],
  prompt: "描述",
};

describe("callVision", () => {
  it("成功返回文本，请求带 UA + token + 正确 URL", async () => {
    const f = mockFetch({
      ok: true,
      body: { choices: [{ message: { content: "红色方块" } }] },
    });
    const text = await callVision(INPUT, config, f);
    expect(text).toBe("红色方块");

    const [url, init] = f.calls[0];
    expect(url).toBe("https://example.com/v1/chat/completions");
    const headers = init.headers as Record<string, string>;
    expect(headers["User-Agent"]).toMatch(/j-can-see/);
    expect(headers["Authorization"]).toBe("Bearer tok");
    expect(headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("grok-4.5");
    expect(body.reasoning_effort).toBe("none");
    expect(body.messages[0].content[0].type).toBe("image_url");
    expect(body.messages[0].content[1].text).toBe("描述");
  });

  it("401 抛 VisionError 且携带 status", async () => {
    const f = mockFetch({ ok: false, status: 401, body: { error: "bad key" } });
    await expect(callVision(INPUT, config, f)).rejects.toMatchObject({
      name: "VisionError",
      status: 401,
    });
  });

  it("429 抛 VisionError 且携带 status", async () => {
    const f = mockFetch({ ok: false, status: 429 });
    await expect(callVision(INPUT, config, f)).rejects.toMatchObject({
      status: 429,
    });
  });

  it("404 错误信息不含降级提示（提示仅限 responses 默认规范）", async () => {
    const f = mockFetch({ ok: false, status: 404 });
    const p = callVision(INPUT, config, f);
    await expect(p).rejects.toThrow(/HTTP 404/);
    await expect(p).rejects.not.toThrow(/J_SEE_API_SPEC=openai/);
  });

  it("返回空 content 抛错", async () => {
    const f = mockFetch({
      ok: true,
      body: { choices: [{ message: { content: "" } }] },
    });
    await expect(callVision(INPUT, config, f)).rejects.toThrow(/为空/);
  });

  it("content 缺失抛错", async () => {
    const f = mockFetch({ ok: true, body: { choices: [{}] } });
    await expect(callVision(INPUT, config, f)).rejects.toThrow(/为空/);
  });

  it("非 JSON 响应抛错", async () => {
    const f = mockFetch({ ok: true, jsonError: true });
    await expect(callVision(INPUT, config, f)).rejects.toThrow();
  });

  it("网络错误抛 VisionError", async () => {
    const f = (vi.fn(async () => {
      throw new TypeError("fetch failed");
    }) as unknown) as FetchLike;
    await expect(callVision(INPUT, config, f)).rejects.toMatchObject({
      name: "VisionError",
    });
  });

  it("多图：每张图生成独立 image block，prompt 在最后", async () => {
    const f = mockFetch({
      ok: true,
      body: { choices: [{ message: { content: "对比结果" } }] },
    });
    const multi = {
      images: [
        { base64: "AAA", mime: "image/jpeg" },
        { base64: "BBB", mime: "image/png" },
      ],
      prompt: "两张图有什么不同",
    };
    await callVision(multi, config, f);
    const body = JSON.parse(f.calls[0][1].body as string);
    const content = body.messages[0].content;
    expect(content).toHaveLength(3);
    expect(content[0].type).toBe("image_url");
    expect(content[0].image_url.url).toMatch(/^data:image\/jpeg;base64,AAA$/);
    expect(content[1].type).toBe("image_url");
    expect(content[1].image_url.url).toMatch(/^data:image\/png;base64,BBB$/);
    expect(content[2].type).toBe("text");
    expect(content[2].text).toBe("两张图有什么不同");
  });

  it("maxTokens 覆盖输出上限（openai 规范）", async () => {
    const f = mockFetch({
      ok: true,
      body: { choices: [{ message: { content: "ok" } }] },
    });
    await callVision(
      { ...INPUT, maxTokens: 8192 },
      config,
      f,
    );
    const body = JSON.parse(f.calls[0][1].body as string);
    expect(body.max_tokens).toBe(8192);
  });

  it("省略 maxTokens 时 openai 默认 2000", async () => {
    const f = mockFetch({
      ok: true,
      body: { choices: [{ message: { content: "ok" } }] },
    });
    await callVision(INPUT, config, f);
    const body = JSON.parse(f.calls[0][1].body as string);
    expect(body.max_tokens).toBe(2000);
  });

  describe("anthropic 规范", () => {
    const anthropicConfig: AppConfig = {
      ...config,
      J_SEE_API_SPEC: "anthropic",
      J_SEE_MODEL: "claude-sonnet-4-5-20250929",
    };

    it("成功返回文本，请求走 /v1/messages + x-api-key", async () => {
      const f = mockFetch({
        ok: true,
        body: { content: [{ type: "text", text: "蓝色圆形" }] },
      });
      const text = await callVision(INPUT, anthropicConfig, f);
      expect(text).toBe("蓝色圆形");

      const [url, init] = f.calls[0];
      expect(url).toBe("https://example.com/v1/messages");
      const headers = init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("tok");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["Authorization"]).toBeUndefined();
      expect(headers["User-Agent"]).toMatch(/j-can-see/);

      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("claude-sonnet-4-5-20250929");
      expect(body.reasoning_effort).toBeUndefined();
      expect(body.messages[0].content[0].type).toBe("image");
      expect(body.messages[0].content[0].source.type).toBe("base64");
      expect(body.messages[0].content[0].source.media_type).toBe("image/jpeg");
      expect(body.messages[0].content[1].text).toBe("描述");
    });

    it("401 抛 VisionError 且携带 status", async () => {
      const f = mockFetch({
        ok: false,
        status: 401,
        body: { error: "bad key" },
      });
      await expect(
        callVision(INPUT, anthropicConfig, f),
      ).rejects.toMatchObject({ name: "VisionError", status: 401 });
    });

    it("content 为空数组抛错", async () => {
      const f = mockFetch({ ok: true, body: { content: [] } });
      await expect(callVision(INPUT, anthropicConfig, f)).rejects.toThrow(
        /为空/,
      );
    });

    it("content 仅含非 text block 视为空", async () => {
      const f = mockFetch({
        ok: true,
        body: { content: [{ type: "tool_use", id: "x" }] },
      });
      await expect(callVision(INPUT, anthropicConfig, f)).rejects.toThrow(
        /为空/,
      );
    });
  });

  describe("responses 规范", () => {
    const responsesConfig: AppConfig = {
      ...config,
      J_SEE_API_SPEC: "responses",
    };

    it("成功返回文本，请求走 /v1/responses + input_image", async () => {
      const f = mockFetch({
        ok: true,
        body: {
          output: [
            { type: "reasoning", summary: [] },
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "绿色三角" }],
            },
          ],
        },
      });
      const text = await callVision(INPUT, responsesConfig, f);
      expect(text).toBe("绿色三角");

      const [url, init] = f.calls[0];
      expect(url).toBe("https://example.com/v1/responses");
      const headers = init.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer tok");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(init.body as string);
      expect(body.model).toBe("grok-4.5");
      expect(body.stream).toBe(false);
      expect(body.reasoning).toBeUndefined();
      expect(body.input[0].content[0].type).toBe("input_image");
      expect(body.input[0].content[0].image_url).toMatch(
        /^data:image\/jpeg;base64,/,
      );
      expect(body.input[0].content[1].type).toBe("input_text");
      expect(body.input[0].content[1].text).toBe("描述");
    });

    it("未显式指定 API_SPEC 时默认走 /v1/responses，而非 openai", async () => {
      const f = mockFetch({
        ok: true,
        body: {
          output: [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: "默认 responses" }],
            },
          ],
        },
      });
      const { J_SEE_API_SPEC: _omit, ...missingSpecConfig } = responsesConfig;
      const text = await callVision(
        INPUT,
        missingSpecConfig as AppConfig,
        f,
      );
      expect(text).toBe("默认 responses");
      expect(f.calls[0][0]).toBe("https://example.com/v1/responses");
    });

    it("未知 API_SPEC 直接抛错，不静默降级", async () => {
      const f = mockFetch({ ok: true, body: {} });
      await expect(
        callVision(
          INPUT,
          { ...config, J_SEE_API_SPEC: "gemini" as never },
          f,
        ),
      ).rejects.toThrow(/不支持的 J_SEE_API_SPEC/);
    });

    it("401 抛 VisionError 且携带 status", async () => {
      const f = mockFetch({
        ok: false,
        status: 401,
        body: { error: { message: "bad key" } },
      });
      await expect(
        callVision(INPUT, responsesConfig, f),
      ).rejects.toMatchObject({ name: "VisionError", status: 401 });
    });

    it("output 无 message block 视为空", async () => {
      const f = mockFetch({
        ok: true,
        body: { output: [{ type: "reasoning", summary: [] }] },
      });
      await expect(callVision(INPUT, responsesConfig, f)).rejects.toThrow(
        /为空/,
      );
    });

    it("message content 仅含非 output_text block 视为空", async () => {
      const f = mockFetch({
        ok: true,
        body: {
          output: [
            {
              type: "message",
              content: [{ type: "tool_call", name: "x" }],
            },
          ],
        },
      });
      await expect(callVision(INPUT, responsesConfig, f)).rejects.toThrow(
        /为空/,
      );
    });

    it("404 时错误信息提示改用 openai", async () => {
      const f = mockFetch({ ok: false, status: 404 });
      await expect(callVision(INPUT, responsesConfig, f)).rejects.toThrow(
        /J_SEE_API_SPEC=openai/,
      );
    });

    it("404 时仍携带 status 且不静默降级", async () => {
      const f = mockFetch({ ok: false, status: 404 });
      await expect(callVision(INPUT, responsesConfig, f)).rejects.toMatchObject(
        { name: "VisionError", status: 404 },
      );
    });

    it("maxTokens 映射为 max_output_tokens；省略时不设", async () => {
      const ok = {
        output: [
          {
            type: "message",
            content: [{ type: "output_text", text: "ok" }],
          },
        ],
      };
      const withLimit = mockFetch({ ok: true, body: ok });
      await callVision({ ...INPUT, maxTokens: 8192 }, responsesConfig, withLimit);
      let body = JSON.parse(withLimit.calls[0][1].body as string);
      expect(body.max_output_tokens).toBe(8192);

      const noLimit = mockFetch({ ok: true, body: ok });
      await callVision(INPUT, responsesConfig, noLimit);
      body = JSON.parse(noLimit.calls[0][1].body as string);
      expect(body.max_output_tokens).toBeUndefined();
    });
  });

  it("timeoutMs 覆盖单次超时：短超时快速中断并体现在错误信息", async () => {
    // 模拟尊重 abort signal 的慢上游（300ms），覆盖 30ms → 主动掐断
    const slow: FetchLike = async (_url: string, init: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 300);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
      return new Response(JSON.stringify({ choices: [{ message: { content: "x" } }] }), {
        status: 200,
      });
    };
    await expect(callVision(INPUT, config, slow, 30)).rejects.toThrow(
      /视觉调用超时（30ms）/,
    );
    await expect(callVision(INPUT, config, slow, 30)).rejects.toBeInstanceOf(
      VisionTimeoutError,
    );
  });

  it("传入时已 aborted 的 signal 立即生效（addEventListener 不会补发事件）", async () => {
    // 模拟：并行块失败发生在本块 encodeProcessed 期间，signal 已是 aborted 状态
    let fetchCalled = false;
    const slow: FetchLike = async (_url: string, init: RequestInit) => {
      fetchCalled = true;
      if (init.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 5000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
      return new Response("{}", { status: 200 });
    };
    const external = new AbortController();
    external.abort(); // 调用前就已取消
    const t0 = Date.now();
    await expect(
      callVision(INPUT, config, slow, 60_000, external.signal),
    ).rejects.toMatchObject({ name: "VisionTimeoutError" });
    expect(Date.now() - t0).toBeLessThan(100); // 未等任何超时
    // 契约：实现仍会带着 aborted signal 调 fetch（不跳过调用），
    // 快速退出依赖 fetch 规范对 aborted signal 的立即拒绝
    expect(fetchCalled).toBe(true);
  });

  it("外部 signal 触发时立即中断在途调用（标记 external，供池层跳过降档）", async () => {
    const slow: FetchLike = async (_url: string, init: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 5000); // 远超测试时长，只能被 signal 掐断
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
      return new Response("{}", { status: 200 });
    };
    const external = new AbortController();
    setTimeout(() => external.abort(), 20);
    const t0 = Date.now();
    await expect(
      callVision(INPUT, config, slow, 60_000, external.signal),
    ).rejects.toMatchObject({
      name: "VisionTimeoutError",
      external: true,
      message: expect.stringContaining("视觉调用被取消"),
    });
    expect(Date.now() - t0).toBeLessThan(300); // 20ms 触发，而非等 60s 超时
  });

  it("timeoutMs 省略时用 config 的 J_SEE_TIMEOUT_MS（真实走默认超时路径）", async () => {
    // 慢上游尊重 abort signal；单次超时调小到 40ms，不传 timeoutMs → 用配置值掐断
    const slow: FetchLike = async (_url: string, init: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, 300);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(t);
          reject(new DOMException("Aborted", "AbortError"));
        });
      });
      return new Response("{}", { status: 200 });
    };
    await expect(
      callVision(INPUT, { ...config, J_SEE_TIMEOUT_MS: 40 }, slow),
    ).rejects.toThrow(/视觉调用超时（40ms）/);
  });
});
