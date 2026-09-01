/**
 * 错误类型定义。
 *
 * 按来源区分，便于上层（tool 编排 / MCP 响应）精确呈现原因，
 * 而不是用一个泛型 Error 模糊归因。
 */

/** 配置错误：环境变量缺失或非法，启动期即可暴露 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

/** 来源错误：图片获取阶段失败（文件不存在、剪贴板无图、下载失败等） */
export class SourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SourceError";
  }
}

/** 图片处理错误：解码失败、格式不支持、体积超限等 */
export class ImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImageError";
  }
}

/**
 * 视觉调用失败的分类。重试编排（retry.ts）据此决定是否重试/退避/降档：
 *  - timeout：单次调用超时（可降质重试）
 *  - rate_limit：HTTP 429（按 Retry-After 退避 + 降档）
 *  - server：HTTP 5xx（退避 + 降档）
 *  - network：fetch 网络层失败（短退避，不降档 —— 本地网络与上游容量无关）
 *  - parse：返回非法 JSON（不重试 —— 重试大概率同样结果）
 *  - empty：返回内容为空（重试一次）
 *  - client：其他 4xx / 配置类错误（不重试）
 *  - busy：本地并发池在预算内等不到槽（不重试，提示调用方改批量或稍后）
 */
export type VisionErrorKind =
  | "timeout"
  | "rate_limit"
  | "server"
  | "network"
  | "parse"
  | "empty"
  | "client"
  | "busy";

export interface VisionErrorOptions {
  readonly status?: number;
  readonly kind?: VisionErrorKind;
  /** 429 响应携带的 Retry-After（毫秒），供重试编排精确退避 */
  readonly retryAfterMs?: number;
}

/** kind 未显式指定时从 HTTP status 推导，保证两者永不矛盾 */
function kindFromStatus(status?: number): VisionErrorKind | undefined {
  if (status == null) return undefined;
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "client";
}

/** 视觉调用错误：HTTP 401/429/5xx/超时等。携带 status 与 kind 便于分类处理 */
export class VisionError extends Error {
  readonly status?: number;
  readonly kind?: VisionErrorKind;
  readonly retryAfterMs?: number;

  constructor(message: string, opts: VisionErrorOptions = {}) {
    super(message);
    this.name = "VisionError";
    this.status = opts.status;
    this.kind = opts.kind ?? kindFromStatus(opts.status);
    this.retryAfterMs = opts.retryAfterMs;
  }
}

/**
 * 视觉调用超时（含被外部 signal 取消），kind 恒为 "timeout"。
 * 子类存在的意义：ocr_long 靠 instanceof 把「超时 = 该块未完成」与
 * 「其他错误 = 真实故障 fail fast」区分开 —— 文案可以随意改，类型契约不会断。
 */
export class VisionTimeoutError extends VisionError {
  /**
   * true = 被外部 signal 取消（上层编排主动停止，如 ocr 真实故障熔断在途块）。
   * 这不是上游容量信号 —— 池降档必须跳过，否则一次故障连降 N 档且污染归因日志。
   */
  readonly external: boolean;

  constructor(message: string, external = false) {
    super(message, { kind: "timeout" });
    this.name = "VisionTimeoutError";
    this.external = external;
  }
}
