/**
 * see_image 的 each 批量模式：逐图独立识别（同一 prompt 应用于每张）。
 *
 * 任务收敛机制（服务端三承诺）：
 *  1. 必有产出 —— 总预算（J_SEE_TASK_BUDGET_MS）内做完几张是几张，
 *     先于客户端工具超时返回，永不整单失败
 *  2. 必有归因 —— 单张失败跳过并记录原因（图彼此独立，与 ocr_long 的
 *     同图熔断语义刻意不同）；连续失败达阈值判定上游不可用、停止派发
 *  3. 剩余工作必表达清楚 —— 未处理清单 + 可直接复制的续调参数，
 *     agent 续调到清空即任务完成（续调本身就是跨调用的重试）
 *
 * worker 取图时才读取+解码 —— 避免 N 张 bitmap 同时驻留内存。
 * 实际上游并发由全局池控制，worker 数只是上界。
 */
import type { AppConfig } from "../config.js";
import { VisionError } from "../errors.js";
import { readSource } from "../sources/index.js";
import { processImage } from "../image.js";
import {
  runManagedVisionCall,
  degradeNotice,
  DEGRADE_EDGE,
  MIN_ATTEMPT_BUDGET_MS,
  type DegradeReason,
} from "../retry.js";
import { newCallContext, type VisionPool } from "../pool.js";
import { limitsOf, type ToolDeps } from "./types.js";

/**
 * 完成序连续失败达此值判定上游不可用，停止派发 ——
 * 不把 N 张 × 重试全烧完才认输。独立于池档位计数：parse 这类
 * 不降档的 kind 连续失败同样是「上游真不能用了」的形态。
 */
export const EARLY_STOP_CONSECUTIVE = 3;

export interface EachBatchArgs {
  readonly sources: ReadonlyArray<string>;
  readonly prompt: string;
  /** 调用方显式 max_edge（存在则不降质） */
  readonly maxEdge?: number;
}

interface EachOutcome {
  readonly status: "ok" | "fail";
  readonly text: string;
  readonly degraded: DegradeReason;
}

/** 生成可直接复制的续调参数（原 prompt / max_edge 原样带上） */
function resumeCall(
  unprocessed: ReadonlyArray<string>,
  args: EachBatchArgs,
): string {
  const params: Record<string, unknown> = {
    source: unprocessed,
    each: true,
    prompt: args.prompt,
  };
  if (args.maxEdge != null) params.max_edge = args.maxEdge;
  return `see_image(${JSON.stringify(params)})`;
}

export async function runEachBatch(
  args: EachBatchArgs,
  config: AppConfig,
  deps: ToolDeps,
  pool: VisionPool,
): Promise<string> {
  const deadline = Date.now() + config.J_SEE_TASK_BUDGET_MS;
  const remaining = () => deadline - Date.now();
  const minBudget = deps.tuning?.minAttemptBudgetMs ?? MIN_ATTEMPT_BUDGET_MS;
  // 整个批量调用共享一枚试探权（首次 acquire 时行使）
  const ctx = newCallContext();
  const limits = limitsOf(config);
  const fullMaxEdge = args.maxEdge ?? limits.maxEdge;
  const degradable = args.maxEdge == null && fullMaxEdge > DEGRADE_EDGE;

  const total = args.sources.length;
  // fill 消除稀疏槽 —— new Array(n) 的 empty slot 会被 forEach 静默跳过，
  // 未处理图的输出行正是靠遍历 undefined 产生的
  const outcomes: (EachOutcome | undefined)[] = new Array(total).fill(
    undefined,
  );
  let nextIndex = 0;
  // 完成序计数：谁先返回谁先计，成功清零 —— 并发下派发序无意义
  let consecutiveFails = 0;
  let earlyStopped = false;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (earlyStopped || remaining() < minBudget) return;
      const i = nextIndex++;
      if (i >= total) return;
      try {
        const raw = await readSource(args.sources[i], deps.reader);
        // 单张预算 = min(剩余任务预算, 单调用预算)，内部同单图规则
        const perImageDeadline = Math.min(
          deadline,
          Date.now() + config.J_SEE_TIMEOUT_MS,
        );
        const r = await runManagedVisionCall(
          {
            buildImages: async (maxEdge) => ({
              images: [await processImage(raw, { ...limits, maxEdge })],
              meta: undefined,
            }),
            prompt: args.prompt,
            fullMaxEdge,
            degradable,
            deadline: perImageDeadline,
            label: `see_image img=${i + 1}/${total}`,
            busyHint: "",
          },
          {
            config,
            pool,
            ctx,
            fetchImpl: deps.fetchImpl,
            sleepImpl: deps.sleepImpl,
            tuning: deps.tuning,
          },
        );
        outcomes[i] = { status: "ok", text: r.text, degraded: r.degraded };
        consecutiveFails = 0;
      } catch (e) {
        // busy = 预算内等不到槽：该图记未处理（续调覆盖），本 worker 停 ——
        // 预算已尽，继续取图只会产生更多同样的 busy
        if (e instanceof VisionError && e.kind === "busy") return;
        outcomes[i] = {
          status: "fail",
          text: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
          degraded: false,
        };
        consecutiveFails++;
        if (consecutiveFails >= EARLY_STOP_CONSECUTIVE) {
          earlyStopped = true;
          return;
        }
      }
    }
  };

  await Promise.all(
    Array.from(
      { length: Math.min(config.J_SEE_MAX_CONCURRENT, total) },
      worker,
    ),
  );

  const done = outcomes.filter((o) => o?.status === "ok").length;
  const failed = outcomes.filter((o) => o?.status === "fail").length;
  const unprocessed = args.sources.filter((_, i) => outcomes[i] == null);

  const parts: string[] = [
    `逐图识别（共 ${total} 张：完成 ${done}，失败 ${failed}，未处理 ${unprocessed.length}）`,
  ];
  outcomes.forEach((o, i) => {
    const head = `[${i + 1}] ${args.sources[i]}`;
    if (o == null) {
      parts.push(`${head}\n（未处理：总预算耗尽）`);
    } else if (o.status === "ok") {
      parts.push(`${head}\n${o.text}${degradeNotice(o.degraded)}`);
    } else {
      parts.push(`${head}\n识别失败：${o.text}`);
    }
  });

  if (earlyStopped) {
    parts.push(
      `⚠️ 完成序连续 ${EARLY_STOP_CONSECUTIVE} 张失败，判定上游当前不可用，已停止派发。` +
        `可稍后续调，或检查上游服务状态（J_SEE_BASE_URL / J_SEE_MODEL）。`,
    );
  }
  if (unprocessed.length > 0) {
    parts.push(
      `继续处理剩余 ${unprocessed.length} 张，请再次调用：\n${resumeCall(unprocessed, args)}`,
    );
  }
  return parts.join("\n\n");
}
