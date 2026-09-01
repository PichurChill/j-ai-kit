import { describe, it, expect, vi, afterEach } from "vitest";
import { VisionPool, newCallContext } from "../src/pool.js";

/** 静音 stderr 日志，避免测试输出噪声 */
const silence = () =>
  vi.spyOn(console, "error").mockImplementation(() => {});

afterEach(() => {
  vi.restoreAllMocks();
});

const far = () => Date.now() + 60_000;

describe("VisionPool", () => {
  it("上限内的 acquire 立即放行", async () => {
    silence();
    const pool = new VisionPool(3);
    const ctx = newCallContext();
    expect(await pool.acquire(far(), ctx)).toBe(true);
    expect(await pool.acquire(far(), ctx)).toBe(true);
    expect(await pool.acquire(far(), ctx)).toBe(true);
    expect(pool.activeCount).toBe(3);
  });

  it("超限排队，release 后按 FIFO 唤醒", async () => {
    silence();
    const pool = new VisionPool(1);
    const ctx = newCallContext();
    expect(await pool.acquire(far(), ctx)).toBe(true);

    let got = false;
    const waiting = pool.acquire(far(), ctx).then((ok) => {
      got = true;
      return ok;
    });
    await Promise.resolve();
    expect(got).toBe(false); // 仍在排队

    pool.release();
    expect(await waiting).toBe(true);
    expect(pool.activeCount).toBe(1);
  });

  it("deadline 前等不到槽返回 false，且从队列移除", async () => {
    silence();
    const pool = new VisionPool(1);
    const ctx = newCallContext();
    await pool.acquire(far(), ctx);

    const ok = await pool.acquire(Date.now() + 30, ctx);
    expect(ok).toBe(false);

    // 之后 release 不应唤醒已过期的等待者（其已被移除）
    pool.release();
    expect(pool.activeCount).toBe(0);
  });

  it("demote 降档 floor 1，且不撤销在途调用", async () => {
    silence();
    const pool = new VisionPool(2);
    const ctx = newCallContext();
    await pool.acquire(far(), ctx);
    await pool.acquire(far(), ctx);

    pool.demote();
    expect(pool.currentLimit).toBe(1);
    pool.demote();
    expect(pool.currentLimit).toBe(1); // floor 1
    expect(pool.activeCount).toBe(2); // 在途不撤

    // active(2) > limit(1)：release 一次后 active=1，仍不放新
    let resolved = false;
    const waiting = pool.acquire(far(), ctx).then((ok) => {
      resolved = true;
      return ok;
    });
    pool.release();
    await Promise.resolve();
    expect(resolved).toBe(false); // active=1 未低于 limit=1
    pool.release();
    expect(await waiting).toBe(true); // active=0 < 1，唤醒
  });

  it("试探权：每个 ctx 一次性 +1，不超过配置上限", async () => {
    silence();
    const pool = new VisionPool(3);
    const ctx1 = newCallContext();

    // 满档时试探不越上限
    await pool.acquire(far(), ctx1);
    expect(pool.currentLimit).toBe(3);

    pool.demote();
    pool.demote();
    expect(pool.currentLimit).toBe(1);

    // 同一 ctx 再 acquire：试探权已用，不回升
    pool.release();
    await pool.acquire(far(), ctx1);
    expect(pool.currentLimit).toBe(1);
    pool.release();

    // 新 ctx（新工具调用）：首次 acquire 行使试探权 +1
    const ctx2 = newCallContext();
    await pool.acquire(far(), ctx2);
    expect(pool.currentLimit).toBe(2);
    pool.release();
  });

  it("试探回升产生的空位会唤醒排队者", async () => {
    silence();
    const pool = new VisionPool(2);
    const ctx1 = newCallContext();
    pool.demote(); // limit 1
    await pool.acquire(far(), ctx1); // active 1

    // ctx1 的第二个 acquire 排队（试探权已用）
    const waiting = pool.acquire(far(), ctx1);

    // 新调用的试探 +1 → limit 2 → 排队者被唤醒
    const ctx2 = newCallContext();
    const second = pool.acquire(far(), ctx2);
    expect(await waiting).toBe(true);
    // 试探者自己排队等下一个空位
    pool.release();
    expect(await second).toBe(true);
  });
});
