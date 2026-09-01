/**
 * 应用配置：从环境变量读取并校验。
 *
 * 分两层：
 *  - base：本地像素工具也需要的通用项，全部有默认值 —— 零配置即可用
 *  - vision：调视觉模型才必须的三项，缺失不阻止 server 启动（懒校验），
 *    视觉工具在调用时才做完整校验并返回 ConfigError
 *
 * 设计原则：校验失败 → 抛 ConfigError 并打印清晰原因，不带残缺配置进入运行时。
 */
import { z } from "zod";
import { ConfigError } from "./errors.js";

/**
 * 必填字符串：变量完全缺失（undefined）与传空串共用同一条可读提示。
 * 只写 .min(1, msg) 的话，undefined 会先触发 invalid_type，
 * 报出来的是 zod 默认英文文案（"Invalid input: expected string..."）。
 */
const required = (msg: string) => z.string({ error: msg }).min(1, msg);

/** 视觉三项：调视觉模型时才必须（懒校验，支持纯本地工具模式） */
const visionEnvSchema = z.object({
  // 识图通道专用 key（必须显式配置，不内嵌）
  J_SEE_TOKEN: required("J_SEE_TOKEN 未配置：需要视觉模型的 API key"),

  // CLIProxyAPI / 兼容端点的根地址（必须显式配置）
  // 末尾斜杠在此处统一去除，下游直接拼接路径
  J_SEE_BASE_URL: required("J_SEE_BASE_URL 未配置")
    .url("J_SEE_BASE_URL 不是合法 URL")
    .transform((s) => s.replace(/\/+$/, "")),

  // 视觉模型名（必须显式配置，不内嵌默认值，避免误用错误模型）
  J_SEE_MODEL: required("J_SEE_MODEL 未配置：需要视觉模型名"),
});

/** 本地工具也用到的通用项（全部有默认值） */
const baseEnvSchema = z.object({
  // 上游 API 规范：
  //  - responses = OpenAI Responses（/v1/responses），GPT-5 / Codex 原生接口，
  //    与 cc switch / Codex 生态对齐；默认选项
  //  - openai = OpenAI Chat Completions（/v1/chat/completions），兼容所有
  //    OpenAI 兼容代理（OpenRouter / LiteLLM / CLIProxyAPI / one-api 等）
  //  - anthropic = Anthropic Messages（/v1/messages），可直连 Claude 原生 API
  J_SEE_API_SPEC: z
    .enum(["responses", "openai", "anthropic"])
    .default("responses"),

  // 推理强度。实测 CLIProxyAPI 转换层不会把 none 真正关到 0，
  // 但 none 仍能比默认快约一倍、省约 28% token，且识别质量无损
  J_SEE_REASONING: z
    .enum(["none", "low", "medium", "high"])
    .default("none"),

  // 图片压缩目标：长边像素上限
  J_SEE_MAX_EDGE: z.coerce.number().int().positive().default(1568),

  // 源文件体积上限（字节），超出直接拒绝
  J_SEE_MAX_BYTES: z.coerce
    .number()
    .int()
    .positive()
    .default(50 * 1024 * 1024),

  // 解码后像素数上限。J_SEE_MAX_BYTES 管的是压缩后体积，拦不住高压缩比图 ——
  // 大面积纯色 PNG 能以极小体积解出巨大 bitmap（压缩比可达 100:1 以上），
  // 必须另设像素上限才真正防住解码爆内存。
  // 40M 像素 ≈ 160MB RGBA，覆盖 8K 截图（7680×4320 ≈ 33M）
  J_SEE_MAX_PIXELS: z.coerce
    .number()
    .int()
    .positive()
    .default(40_000_000),

  // 单次视觉工具调用的总预算（毫秒，含排队 / 预处理 / 重试）。
  // 需短于 CF Tunnel 的 100s 上限与客户端 MCP 工具超时，
  // 让服务端先于 524 / 客户端掐断给出清晰错误或降质结果
  J_SEE_TIMEOUT_MS: z.coerce.number().int().positive().default(90000),

  // ocr_long 的总时间预算（毫秒），默认 85s —— 低于常见客户端的
  // MCP 工具级超时（如 ZCode 100s）。多块 OCR 的总时长若无上限，
  // 会被客户端整单掐断、颗粒无收；预算耗尽时返回已完成的部分结果。
  J_SEE_OCR_TOTAL_TIMEOUT_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(85_000),

  // 全局视觉并发上限（进程级唯一 worker 池的初始档位）。
  // 上游 429/5xx/超时会自动降档（floor 1），新工具调用时 +1 试探回升。
  // 上限 8 是防呆而非性能推荐：个人代理扛不住更高的视觉并发，
  // 且 85s 任务预算内 8 并发的吞吐已超过典型任务规模
  J_SEE_MAX_CONCURRENT: z.coerce
    .number()
    .int()
    .min(1, "J_SEE_MAX_CONCURRENT 最小为 1")
    .max(8, "J_SEE_MAX_CONCURRENT 最大为 8")
    .default(3),

  // 单次视觉工具调用的总尝试上限（首发 + 重试）。
  // 与「剩余预算 ≥10s 才发起」构成双上限，两者任一触顶即停
  J_SEE_MAX_ATTEMPTS: z.coerce
    .number()
    .int()
    .min(1, "J_SEE_MAX_ATTEMPTS 最小为 1")
    .default(3),

  // 批量识图（see_image each 模式）的总时间预算（毫秒），默认 85s。
  // 与 OCR 预算语义不同（批量图彼此独立、单张失败跳过；OCR 块同属一图、
  // 真实故障熔断），刻意不共用一个配置项，避免调参互相影响
  J_SEE_TASK_BUDGET_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(85_000),
});

const envSchema = visionEnvSchema.merge(baseEnvSchema);

/** 本地像素工具所需配置（全部有默认值） */
export type BaseConfig = z.infer<typeof baseEnvSchema>;

/** 视觉调用专属配置 */
export type VisionConfig = z.infer<typeof visionEnvSchema>;

/**
 * 完整配置 = base + vision。
 * 定义为交叉类型而非独立推断，以明确 AppConfig 是 BaseConfig 的超集 ——
 * 视觉工具的 config 可以直接传给只要 BaseConfig 的图像处理函数。
 */
export type AppConfig = BaseConfig & VisionConfig;

function toConfigError(error: z.ZodError): ConfigError {
  const issues = error.issues
    .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("\n");
  return new ConfigError(`配置无效，请检查环境变量：\n${issues}`);
}

/**
 * 读取并校验完整配置（含视觉三项）。失败抛 ConfigError。
 * 视觉工具调用时使用。
 * @param env 可注入，便于测试；默认读 process.env
 */
export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) throw toConfigError(parsed.error);
  return parsed.data;
}

/**
 * 仅本地工具（crop/image_diff/colors/trace/extract_fg）需要的配置：
 * 不含视觉三项 —— 类型上就没有这些字段，本地工具误用会在编译期报错，
 * 不需要（也绝不用）空串之类的占位值伪造。
 * @param env 可注入，便于测试；默认读 process.env
 */
export function loadBaseConfig(
  env: Record<string, string | undefined> = process.env,
): BaseConfig {
  const parsed = baseEnvSchema.safeParse(env);
  if (!parsed.success) throw toConfigError(parsed.error);
  return parsed.data;
}
