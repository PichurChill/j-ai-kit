/**
 * 视觉调用：把 base64 图片交给视觉模型，返回文本描述。
 *
 * 支持三种上游 API 规范（由 J_SEE_API_SPEC 选择）：
 *  - responses：OpenAI Responses（/v1/responses），GPT-5 / Codex 原生接口，
 *    与 cc switch / Codex 生态对齐（默认）
 *  - openai：OpenAI Chat Completions（/v1/chat/completions），兼容所有
 *    OpenAI 兼容代理（OpenRouter / LiteLLM / CLIProxyAPI / one-api 等）
 *  - anthropic：Anthropic Messages（/v1/messages），可直连 Claude 原生 API
 *
 * 实现要点（均来自实测，非猜测）：
 * 1. 强制 User-Agent —— CF bot 防护会对默认/空 UA 返回 403
 * 2. 超时短于 CF Tunnel 的 100s 上限，让客户端先于 524 给出清晰错误
 * 3. 单次调用不重试、不降级 —— 失败带 kind 分类原样上抛，
 *    重试/降质/并发编排统一在 retry.ts 的包装层，本模块保持纯净
 */
import { VisionError, VisionTimeoutError } from "./errors.js";
import type { AppConfig } from "./config.js";
import { VERSION } from "./version.js";

/** 单张图片的编码数据 */
export interface VisionImage {
  readonly base64: string;
  readonly mime: string;
}

/**
 * 视觉调用输入。images 支持多张（多图对比 / 多图问答），
 * 单图是其特例（长度为 1 的数组）。
 */
export interface VisionInput {
  readonly images: ReadonlyArray<VisionImage>;
  readonly prompt: string;
  /**
   * 输出 token 上限。省略时 openai/anthropic 用 2000、responses 不设。
   * 密集 inspect / 长 OCR 块应显式传大值（如 8192）避免截断。
   */
  readonly maxTokens?: number;
}

/** openai/anthropic 规范的默认输出上限 */
const DEFAULT_MAX_TOKENS = 2000;

/** 可注入的 fetch 类型，便于测试用 mock 替换 */
export type FetchLike = (
  url: string,
  init: RequestInit,
) => Promise<Response>;

/** 规范无关的请求描述：构造好后交给统一的 fetch / 错误处理流程 */
interface VisionRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** Anthropic Messages API 要求的版本头 */
const ANTHROPIC_VERSION = "2023-06-01";

/** 三种规范共用的 UA —— 版本号取自 package.json，不再写死 */
const USER_AGENT = `j-can-see/${VERSION} (mcp-vision-client)`;

/**
 * OpenAI Responses 请求（/v1/responses，GPT-5 / Codex 原生接口）。
 * content block 用 input_image / input_text；stream:false 让其返回完整 JSON。
 * 不传 reasoning —— 实测 CLIProxyAPI 转换层不会把 effort 真正透传给
 * grok，minimal/low 与默认的 reasoning tokens 基本相同，传了也无意义。
 */
function buildResponsesRequest(
  input: VisionInput,
  config: AppConfig,
): VisionRequest {
  return {
    url: `${config.J_SEE_BASE_URL}/v1/responses`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.J_SEE_TOKEN}`,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      model: config.J_SEE_MODEL,
      stream: false,
      // responses 默认不设输出上限（保持既有行为），显式传 maxTokens 时生效
      ...(input.maxTokens != null ? { max_output_tokens: input.maxTokens } : {}),
      input: [
        {
          role: "user",
          content: [
            ...input.images.map((img) => ({
              type: "input_image",
              image_url: `data:${img.mime};base64,${img.base64}`,
            })),
            { type: "input_text", text: input.prompt },
          ],
        },
      ],
    }),
  };
}

/** OpenAI Chat Completions 请求（含 reasoning_effort） */
function buildOpenAIRequest(
  input: VisionInput,
  config: AppConfig,
): VisionRequest {
  return {
    url: `${config.J_SEE_BASE_URL}/v1/chat/completions`,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${config.J_SEE_TOKEN}`,
      // CF bot 防护会拦截默认 UA（实测 urllib 的 Python-urllib 被 403）
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      model: config.J_SEE_MODEL,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      reasoning_effort: config.J_SEE_REASONING,
      messages: [
        {
          role: "user",
          content: [
            ...input.images.map((img) => ({
              type: "image_url",
              image_url: {
                url: `data:${img.mime};base64,${img.base64}`,
              },
            })),
            { type: "text", text: input.prompt },
          ],
        },
      ],
    }),
  };
}

/**
 * Anthropic Messages 请求。
 * 不传 reasoning_effort —— Anthropic 的 thinking（budget_tokens）语义/取值
 * 与 OpenAI 的 none|low|medium|high 不一一对应，不强行映射，保持默认（不开启 thinking）。
 */
function buildAnthropicRequest(
  input: VisionInput,
  config: AppConfig,
): VisionRequest {
  return {
    url: `${config.J_SEE_BASE_URL}/v1/messages`,
    headers: {
      "Content-Type": "application/json",
      "x-api-key": config.J_SEE_TOKEN,
      "anthropic-version": ANTHROPIC_VERSION,
      "User-Agent": USER_AGENT,
    },
    body: JSON.stringify({
      model: config.J_SEE_MODEL,
      max_tokens: input.maxTokens ?? DEFAULT_MAX_TOKENS,
      messages: [
        {
          role: "user",
          content: [
            ...input.images.map((img) => ({
              type: "image",
              source: {
                type: "base64",
                media_type: img.mime,
                data: img.base64,
              },
            })),
            { type: "text", text: input.prompt },
          ],
        },
      ],
    }),
  };
}

/** 按规范选择请求构造器 */
function buildRequest(
  input: VisionInput,
  config: AppConfig,
): VisionRequest {
  switch (config.J_SEE_API_SPEC) {
    // 与 loadConfig 的默认值保持一致：直接调用 callVision 且未显式配置时
    // 不应静默落到 openai 分支。
    case undefined:
    case "responses":
      return buildResponsesRequest(input, config);
    case "openai":
      return buildOpenAIRequest(input, config);
    case "anthropic":
      return buildAnthropicRequest(input, config);
    default:
      throw new VisionError(
        `不支持的 J_SEE_API_SPEC: ${JSON.stringify(config.J_SEE_API_SPEC)}，支持 responses / openai / anthropic`,
        { kind: "client" },
      );
  }
}

/** Responses 返回：output[] 找 type==="message"，拼接其 output_text block */
function parseResponsesContent(data: unknown): string {
  const output = (
    data as {
      output?: ReadonlyArray<{
        type?: string;
        content?: ReadonlyArray<{ type?: string; text?: unknown }>;
      }>;
    }
  )?.output;
  const msg = Array.isArray(output)
    ? output.find((o) => o?.type === "message")
    : undefined;
  const blocks = msg?.content;
  const text =
    Array.isArray(blocks) && blocks.length > 0
      ? blocks
          .filter((b) => b?.type === "output_text")
          .map((b) => String(b.text ?? ""))
          .join("")
      : "";
  if (text.length === 0) {
    throw new VisionError("视觉调用返回内容为空", { kind: "empty" });
  }
  return text;
}

/** OpenAI Chat Completions 返回取 choices[0].message.content */
function parseOpenAIContent(data: unknown): string {
  const content = (
    data as {
      choices?: ReadonlyArray<{ message?: { content?: unknown } }>;
    }
  )?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new VisionError("视觉调用返回内容为空", { kind: "empty" });
  }
  return content;
}

/** Anthropic 返回拼接所有 type==="text" 的 block */
function parseAnthropicContent(data: unknown): string {
  const blocks = (
    data as {
      content?: ReadonlyArray<{ type?: string; text?: unknown }>;
    }
  )?.content;
  const text =
    Array.isArray(blocks) && blocks.length > 0
      ? blocks
          .filter((b) => b?.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("")
      : "";
  if (text.length === 0) {
    throw new VisionError("视觉调用返回内容为空", { kind: "empty" });
  }
  return text;
}

/** 按规范选择响应解析器 */
function parseContent(data: unknown, config: AppConfig): string {
  switch (config.J_SEE_API_SPEC) {
    case undefined:
    case "responses":
      return parseResponsesContent(data);
    case "openai":
      return parseOpenAIContent(data);
    case "anthropic":
      return parseAnthropicContent(data);
    default:
      throw new VisionError(
        `不支持的 J_SEE_API_SPEC: ${JSON.stringify(config.J_SEE_API_SPEC)}，支持 responses / openai / anthropic`,
        { kind: "client" },
      );
  }
}

/**
 * 解析 429 响应的 Retry-After 头（秒数或 HTTP-date），转为毫秒。
 * 解析不出返回 undefined，由重试编排落到默认退避。
 */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000);
  const at = Date.parse(header);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

export async function callVision(
  input: VisionInput,
  config: AppConfig,
  fetchImpl: FetchLike = fetch,
  /**
   * 单次 HTTP 调用的超时（毫秒）。生产路径（retry.ts 编排 / ocr 分块）
   * 均按剩余预算显式传入；省略时以 J_SEE_TIMEOUT_MS 兜底 ——
   * 对无编排的直接调用者，「单次调用 = 整个调用」，拿总预算值仍是正确语义。
   */
  timeoutMs?: number,
  /**
   * 外部取消信号（如 ocr_long 某块真实失败时取消全部在途调用）。
   * 触发后与超时同型处理 —— 上层已记录真实错误，这里的结果不会被使用。
   */
  signal?: AbortSignal,
): Promise<string> {
  const req = buildRequest(input, config);

  const controller = new AbortController();
  const effectiveTimeout = timeoutMs ?? config.J_SEE_TIMEOUT_MS;
  const timer = setTimeout(
    () => controller.abort(),
    effectiveTimeout,
  );
  const onExternalAbort = () => controller.abort();
  if (signal?.aborted) {
    // 传入时已取消（如调用前恰有并行块失败）：监听器不会再触发，必须显式同步
    controller.abort();
  } else {
    signal?.addEventListener("abort", onExternalAbort);
  }

  let resp: Response;
  try {
    resp = await fetchImpl(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });
  } catch (e) {
    if (e instanceof Error && e.name === "AbortError") {
      // 外部 signal 已触发 = 上层主动取消（非上游容量信号），标记 external
      // 供池层跳过降档；与真超时同时发生时按外部取消算 —— 上层已记录真实
      // 错误，此块结果无用，更不该产生容量信号
      const external = signal?.aborted === true;
      throw new VisionTimeoutError(
        external
          ? "视觉调用被取消（上层已停止本批调用）"
          : `视觉调用超时（${effectiveTimeout}ms）`,
        external,
      );
    }
    throw new VisionError(
      `视觉调用网络错误：${e instanceof Error ? e.message : String(e)}`,
      { kind: "network" },
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onExternalAbort);
  }

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    // responses 是默认规范，404 多半是代理不支持 /v1/responses。
    // 不静默降级（保持"失败原样上报"原则），但给出可操作的下一步提示
    const hint =
      config.J_SEE_API_SPEC === "responses" && resp.status === 404
        ? "（你的代理可能不支持 /v1/responses，可设置 J_SEE_API_SPEC=openai 改用 Chat Completions 格式）"
        : "";
    throw new VisionError(
      `视觉调用失败：HTTP ${resp.status}${hint}${
        text ? ` ${text.slice(0, 300)}` : ""
      }`,
      {
        status: resp.status,
        // kind 由 status 自动推导（429→rate_limit / 5xx→server / 其余→client）
        retryAfterMs:
          resp.status === 429
            ? parseRetryAfterMs(resp.headers.get("retry-after"))
            : undefined,
      },
    );
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch (e) {
    throw new VisionError(
      `视觉调用返回非法 JSON：${e instanceof Error ? e.message : String(e)}`,
      { kind: "parse" },
    );
  }

  return parseContent(data, config);
}
