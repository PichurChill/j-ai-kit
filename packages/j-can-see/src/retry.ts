/**
 * 视觉调用的容错编排层：预算、重试、降质、并发池接入。
 *
 * 分层契约：
 *  - vision.ts 的 callVision 保持纯净 —— 单次调用、失败带 kind 上抛
 *  - 本模块决定「失败之后怎么办」：是否重试 / 退避多久 / 是否降质 / 是否降档
 *  - 工具层只声明意图（degradable、预算、文案），不写任何重试逻辑
 *
 * 预算语义（J_SEE_TIMEOUT_MS = 单次工具调用总预算，含排队与预处理）：
 *  - 可降质调用的首发超时 = 剩余预算 − DEGRADE_RESERVE_MS（给降质后手留时间；
 *    没有后手的调用不提前掐，首发拿满剩余预算）
 *  - 排队后剩余预算不足以全质量首发（< SKIP_FULL_THRESHOLD_MS）时，
 *    跳过全质量、直接以降质图起手，用满剩余预算 —— 避免白烧一次必死的尝试
 *  - 任何新尝试都要求剩余预算 ≥ MIN_ATTEMPT_BUDGET_MS，双上限之一
 *
 * 时间常量为待校准项：默认值来自推算而非实测，stderr 日志记录每次尝试的
 * 实际耗时，跑出数据后校准的是常量、不是机制。
 */
import type { AppConfig } from "./config.js";
import {
  VisionError,
  VisionTimeoutError,
  type VisionErrorKind,
} from "./errors.js";
import { logLine } from "./log.js";
import type { VisionImage, FetchLike } from "./vision.js";
import { callVision } from "./vision.js";
import type { VisionPool, PoolCallContext } from "./pool.js";

/** 降质档长边：主流视觉模型在 1024px 仍有可用识别质量，耗时显著低于 1568 */
export const DEGRADE_EDGE = 1024;

/** 可降质调用首发预留的降质后手时间（待实测校准） */
export const DEGRADE_RESERVE_MS = 25_000;

/** 全质量首发超时低于此值时必死无疑，直接降质起手（待实测校准） */
export const SKIP_FULL_THRESHOLD_MS = 15_000;

/** 剩余预算低于此值不再发起新尝试（与 ocr 的 MIN_CHUNK_BUDGET_MS 同思路） */
export const MIN_ATTEMPT_BUDGET_MS = 10_000;

/** 生产写死、测试注入小值的时间参数（沿用 ocrWithBudget 的参数化先例） */
export interface RetryTuning {
  readonly degradeReserveMs: number;
  readonly skipFullThresholdMs: number;
  readonly minAttemptBudgetMs: number;
}

const DEFAULT_TUNING: RetryTuning = {
  degradeReserveMs: DEGRADE_RESERVE_MS,
  skipFullThresholdMs: SKIP_FULL_THRESHOLD_MS,
  minAttemptBudgetMs: MIN_ATTEMPT_BUDGET_MS,
};

export interface RetryDecision {
  readonly retry: boolean;
  readonly backoffMs: number;
  /** 本次重试是否切换到降质图 */
  readonly degrade: boolean;
  /** 该 kind 的重试次数上限（与总尝试上限构成双上限） */
  readonly maxRetries: number;
}

const NO_RETRY: RetryDecision = {
  retry: false,
  backoffMs: 0,
  degrade: false,
  maxRetries: 0,
};

/**
 * 失败分类 → 重试决策，纯函数。
 *
 * degradable 是输入而非注释：超时的唯一重试手段是降质，
 * 没有降质后手（显式 max_edge / 已降过质）的超时显式判为不可重试，
 * 而不是留一条永远走不到的分支。
 * 429/5xx/network 失败得快、预算仍在，对所有调用都照常可重试。
 */
export function retryDecision(
  kind: VisionErrorKind | undefined,
  opts: { readonly degradable: boolean; readonly retryAfterMs?: number },
): RetryDecision {
  switch (kind) {
    case "timeout":
      return opts.degradable
        ? { retry: true, backoffMs: 0, degrade: true, maxRetries: 1 }
        : NO_RETRY;
    case "rate_limit":
      return {
        retry: true,
        backoffMs: opts.retryAfterMs ?? 1000,
        degrade: false,
        maxRetries: 2,
      };
    case "server":
      return { retry: true, backoffMs: 1000, degrade: false, maxRetries: 2 };
    case "network":
      // 短退避、不降档 —— 本地网络问题与上游容量无关
      return { retry: true, backoffMs: 500, degrade: false, maxRetries: 2 };
    case "empty":
      // 空内容常见于上游拒答/转换层丢 content，重试大概率同样结果，只试一次
      return { retry: true, backoffMs: 0, degrade: false, maxRetries: 1 };
    default:
      // parse / client / busy / 非 VisionError：重试无意义，原样上报
      return NO_RETRY;
  }
}

/** 上游容量信号（超时/限流/5xx）才降档；本地与协议错误不动池 */
export function shouldDemote(kind: VisionErrorKind | undefined): boolean {
  return kind === "timeout" || kind === "rate_limit" || kind === "server";
}

/** 按长边上限编码后的发送图 + 工具自有元数据（locate/inspect 的 scale 等） */
export interface PreparedImages<M> {
  readonly images: ReadonlyArray<VisionImage>;
  readonly meta: M;
}

export type DegradeReason = false | "timeout" | "budget";

/** 降质结果的透明告知：结果可用但细节可信度打折，需要精确时全质量重看 */
export function degradeNotice(degraded: DegradeReason): string {
  switch (degraded) {
    case "timeout":
      return `\n（注：本图因超时已降质重试，长边 ${DEGRADE_EDGE}px，细节/坐标精度可能下降）`;
    case "budget":
      return `\n（注：排队后预算不足，本图直接以降质发起，长边 ${DEGRADE_EDGE}px，细节/坐标精度可能下降）`;
    default:
      return "";
  }
}

export interface ManagedCallInput<M> {
  /** 按长边上限构建实际发送的图；降质重试时以 DEGRADE_EDGE 重建 */
  readonly buildImages: (maxEdge: number) => Promise<PreparedImages<M>>;
  readonly prompt: string;
  readonly maxTokens?: number;
  /** 全质量长边（config.J_SEE_MAX_EDGE 或调用方显式 max_edge） */
  readonly fullMaxEdge: number;
  /** false = 显式 max_edge 或全局上限本就 ≤ 降质档：超时不降质 */
  readonly degradable: boolean;
  /** 本次工具调用的绝对预算终点（时间戳） */
  readonly deadline: number;
  /** 日志标识（工具名 + 可选图序，如 "see_image img=3/10"） */
  readonly label: string;
  /** 池在预算内等不到槽时的提示文案（按工具区分下一步建议） */
  readonly busyHint: string;
}

export interface ManagedCallDeps {
  readonly config: AppConfig;
  readonly pool: VisionPool;
  readonly ctx: PoolCallContext;
  readonly fetchImpl?: FetchLike;
  /** 退避 sleep；测试注入立即返回的实现 */
  readonly sleepImpl?: (ms: number) => Promise<void>;
  readonly tuning?: RetryTuning;
}

export interface ManagedResult<M> {
  readonly text: string;
  /** 与实际发送的那张图对应的元数据（降质后 scale 不同，必须配套返回） */
  readonly meta: M;
  readonly degraded: DegradeReason;
}

const realSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 受管视觉调用：池 + 预算 + 分类重试 + 超时降质。
 *
 * 失败处理顺序（定稿）：降档 →（释放槽位）→ 退避 → 重新取槽重试 ——
 * 重试不叠在刚才那波并发上。耗尽后上报最后一次真实错误。
 */
export async function runManagedVisionCall<M>(
  input: ManagedCallInput<M>,
  deps: ManagedCallDeps,
): Promise<ManagedResult<M>> {
  const { config, pool, ctx } = deps;
  const tuning = deps.tuning ?? DEFAULT_TUNING;
  const sleep = deps.sleepImpl ?? realSleep;
  const remaining = () => input.deadline - Date.now();

  let attempts = 0;
  const retriesUsed = new Map<VisionErrorKind, number>();
  let degraded: DegradeReason = false;
  let lastError: unknown;

  while (
    attempts < config.J_SEE_MAX_ATTEMPTS &&
    remaining() >= tuning.minAttemptBudgetMs
  ) {
    // 取槽：等待计入预算；只等到「还够发起一次调用」为止
    const got = await pool.acquire(
      input.deadline - tuning.minAttemptBudgetMs,
      ctx,
    );
    if (!got) {
      throw new VisionError(
        `上游繁忙：并发池在预算内未能获得调用槽位。${input.busyHint}`,
        { kind: "busy" },
      );
    }

    // 排队之后再评估预算：全质量发起已必死时直接降质起手，不白烧一次尝试
    //（不限首发 —— 429 重试轮排队后预算同样可能塌缩到全质量必死）
    if (input.degradable && !degraded) {
      if (remaining() - tuning.degradeReserveMs < tuning.skipFullThresholdMs) {
        degraded = "budget";
      }
    }
    const edge = degraded ? DEGRADE_EDGE : input.fullMaxEdge;
    attempts++;
    const started = Date.now();
    let kindLabel = "ok";
    try {
      const prepared = await input.buildImages(edge);
      // 可降质且尚未降质的尝试才预留后手时间；其余拿满剩余预算
      const reserve =
        input.degradable && !degraded ? tuning.degradeReserveMs : 0;
      const text = await callVision(
        { images: prepared.images, prompt: input.prompt, maxTokens: input.maxTokens },
        config,
        deps.fetchImpl,
        Math.max(1, remaining() - reserve),
      );
      pool.release();
      logLine(
        `${input.label} attempt=${attempts}/${config.J_SEE_MAX_ATTEMPTS} ` +
          `edge=${edge} ${Date.now() - started}ms ok pool=${pool.currentLimit}`,
      );
      return { text, meta: prepared.meta, degraded };
    } catch (e) {
      lastError = e;
      const kind = e instanceof VisionError ? e.kind : undefined;
      kindLabel = kind ?? (e instanceof Error ? e.name : "unknown");
      if (shouldDemote(kind)) pool.demote();
      pool.release();

      const decision = retryDecision(kind, {
        degradable: input.degradable && !degraded,
        retryAfterMs: e instanceof VisionError ? e.retryAfterMs : undefined,
      });
      const used = kind ? (retriesUsed.get(kind) ?? 0) : 0;
      const willRetry =
        decision.retry &&
        used < decision.maxRetries &&
        attempts < config.J_SEE_MAX_ATTEMPTS &&
        remaining() - decision.backoffMs >= tuning.minAttemptBudgetMs;
      logLine(
        `${input.label} attempt=${attempts}/${config.J_SEE_MAX_ATTEMPTS} ` +
          `edge=${edge} ${Date.now() - started}ms ${kindLabel} pool=${pool.currentLimit}` +
          (willRetry
            ? ` → retry${decision.degrade ? "(降质)" : ""} in ${decision.backoffMs}ms`
            : " → 放弃"),
      );
      if (!willRetry) break;
      retriesUsed.set(kind!, used + 1);
      if (decision.degrade) degraded = "timeout";
      if (decision.backoffMs > 0) await sleep(decision.backoffMs);
    }
  }

  throw (
    lastError ??
    new VisionError(
      `视觉调用预算耗尽（${config.J_SEE_TIMEOUT_MS}ms），未能发起任何尝试。${input.busyHint}`,
      { kind: "busy" },
    )
  );
}

/**
 * 轻量池化调用（ocr_long 的块专用）：只过池 + 失败降档，无重试无降质 ——
 * ocr 有自己的预算/部分结果机制，块内叠重试会吃掉其他块的预算。
 * 排队等不到槽抛 VisionTimeoutError：在 ocr 的分类里「超时 = 该块未完成」，
 * 落部分结果而非熔断，语义正确。
 */
export async function callVisionPooled(
  input: { images: ReadonlyArray<VisionImage>; prompt: string; maxTokens?: number },
  deadline: number,
  label: string,
  deps: {
    readonly config: AppConfig;
    readonly pool: VisionPool;
    readonly ctx: PoolCallContext;
    readonly fetchImpl?: FetchLike;
    readonly signal?: AbortSignal;
  },
): Promise<string> {
  const got = await deps.pool.acquire(deadline, deps.ctx);
  if (!got) {
    throw new VisionTimeoutError("排队等待并发槽超时（该块未完成）");
  }
  const started = Date.now();
  try {
    const text = await callVision(
      input,
      deps.config,
      deps.fetchImpl,
      Math.max(1, deadline - Date.now()),
      deps.signal,
    );
    logLine(
      `${label} ${Date.now() - started}ms ok pool=${deps.pool.currentLimit}`,
    );
    return text;
  } catch (e) {
    const kind = e instanceof VisionError ? e.kind : undefined;
    // 外部取消（ocr 真实故障熔断在途块）不是上游容量信号：跳过降档，
    // 否则一次故障最坏连降 N 档（N=在途块数），且假降档日志污染归因
    const externalCancel = e instanceof VisionTimeoutError && e.external;
    if (!externalCancel && shouldDemote(kind)) deps.pool.demote();
    logLine(
      `${label} ${Date.now() - started}ms ${
        externalCancel ? "cancelled" : (kind ?? "error")
      } pool=${deps.pool.currentLimit}`,
    );
    throw e;
  } finally {
    deps.pool.release();
  }
}
