/**
 * 全局视觉并发池：进程级唯一，所有上游视觉调用（单图、批量每张、OCR 每块）
 * 统一过池 —— 杜绝多套并发上限叠加打爆上游。
 *
 * 槽位按「上游调用」计：多图对比一次上游调用 N 张图 = 1 个槽位。
 *
 * 自适应规则（刻意没有时间状态机）：
 *  - 降档：上游容量信号（429 / 5xx / 超时）→ 档位 -1，floor 1
 *  - 回升：每个工具调用携带一枚一次性试探权，在它首次 acquire 前行使 +1
 *    （ceil 配置上限）。试探的载荷就是这次调用本身 —— 试探与验证同一发。
 *    行使后本调用内不再回升（批量内某张又触发降档时，后续张不得抵消），
 *    直到下一次工具调用（agent 续调）带来新试探权。
 *
 * 排队语义：等待时间计入调用方预算；deadline 前等不到槽返回 false，
 * 由调用方决定语义（单图 → busy 错误；批量 → 记入未处理清单）。
 * 排队永不暴露给客户端的工具级超时。
 */
import { logLine } from "./log.js";

/** 每个工具调用一枚：跨该调用内所有 acquire 共享，试探权一次性 */
export interface PoolCallContext {
  probeUsed: boolean;
}

export function newCallContext(): PoolCallContext {
  return { probeUsed: false };
}

interface Waiter {
  readonly resolve: (ok: boolean) => void;
  readonly timer: NodeJS.Timeout;
}

export class VisionPool {
  /** 当前档位（≤ max，降档/试探动态调整） */
  private limit: number;
  /** 配置上限（J_SEE_MAX_CONCURRENT，创建后不变） */
  private readonly max: number;
  private active = 0;
  private readonly waiters: Waiter[] = [];

  constructor(maxConcurrent: number) {
    this.max = maxConcurrent;
    this.limit = maxConcurrent;
  }

  /** 当前档位（测试与日志用） */
  get currentLimit(): number {
    return this.limit;
  }

  /** 在途上游调用数（测试用） */
  get activeCount(): number {
    return this.active;
  }

  /**
   * 获取一个上游调用槽位；deadline（绝对时间戳）前拿不到返回 false。
   * ctx 的试探权在此行使（首次 acquire 前 +1），保证试探载荷就是本次调用。
   */
  acquire(deadline: number, ctx: PoolCallContext): Promise<boolean> {
    if (!ctx.probeUsed) {
      ctx.probeUsed = true;
      if (this.limit < this.max) {
        this.limit++;
        logLine(`pool 试探回升 → ${this.limit}/${this.max}`);
        this.wake();
      }
    }
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve(true);
    }
    const waitMs = deadline - Date.now();
    if (waitMs <= 0) return Promise.resolve(false);
    return new Promise((resolve) => {
      const waiter: Waiter = {
        resolve,
        timer: setTimeout(() => {
          const i = this.waiters.indexOf(waiter);
          if (i >= 0) this.waiters.splice(i, 1);
          resolve(false);
        }, waitMs),
      };
      this.waiters.push(waiter);
    });
  }

  /** 释放槽位并按档位唤醒等待者（FIFO） */
  release(): void {
    this.active = Math.max(0, this.active - 1);
    this.wake();
  }

  /**
   * 上游容量信号触发降档。已在途的调用不撤销 ——
   * active > limit 时靠 release 自然收敛（收敛前不放新调用）。
   */
  demote(): void {
    if (this.limit > 1) {
      this.limit--;
      logLine(`pool 降档 → ${this.limit}/${this.max}`);
    }
  }

  private wake(): void {
    while (this.active < this.limit && this.waiters.length > 0) {
      const w = this.waiters.shift()!;
      clearTimeout(w.timer);
      this.active++;
      w.resolve(true);
    }
  }
}

/**
 * 进程级单例：首次视觉调用时以当时配置创建，此后 max 固定
 *（环境变量不会中途变化）。测试用 new VisionPool 独立实例注入。
 */
let globalPool: VisionPool | undefined;

export function getGlobalPool(maxConcurrent: number): VisionPool {
  globalPool ??= new VisionPool(maxConcurrent);
  return globalPool;
}
