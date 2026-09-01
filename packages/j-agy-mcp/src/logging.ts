/**
 * 执行日志:每次 agy 调用写独立日志文件(并发任务互不覆盖),
 * latest.log 软链始终指向最近一次执行,便于 `tail -f` 追踪。
 * 所有文件操作均为 best-effort:失败写 stderr 留痕,绝不影响任务执行本身。
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

export const LOG_DIR = path.join(tmpdir(), "j-agy-mcp");
const LATEST_LINK = path.join(LOG_DIR, "latest.log");
const LOG_RETENTION_DAYS = 7;

export function logLine(message: string): void {
  process.stderr.write(`[j-agy-mcp] ${message}\n`);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface ExecutionSession {
  executionId: string;
  /** 本任务的专属日志文件路径,始终随工具结果返回,不依赖 latest 软链。 */
  logFile: string;
  appendDelta: (text: string) => void;
}

export function createExecutionSession(kind: "prompt" | "conv"): ExecutionSession {
  const executionId = `${kind}-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const logFile = path.join(LOG_DIR, `${executionId}.log`);
  try {
    mkdirSync(LOG_DIR, { recursive: true });
    writeFileSync(logFile, `[${new Date().toISOString()}] [${executionId}] j-agy-mcp 执行开始\n`, "utf-8");
    // latest 软链仅服务于「随手 tail 最新任务」;并发更新时可能被其他任务抢先,
    // 失败可接受——精确追踪走返回值里的 logFile
    try {
      unlinkSync(LATEST_LINK);
    } catch {
      // 首次运行时软链不存在,属正常
    }
    symlinkSync(logFile, LATEST_LINK);
  } catch (err) {
    logLine(`日志初始化失败(不影响执行): ${errorMessage(err)}`);
  }
  return {
    executionId,
    logFile,
    appendDelta(text: string) {
      if (!text) return;
      try {
        appendFileSync(logFile, text, "utf-8");
      } catch {
        // 日志写失败不重试、不刷屏
      }
    },
  };
}

/** 启动时清扫超过保留期的旧日志(best-effort,single 文件失败跳过)。 */
export function sweepOldLogs(): void {
  let entries: string[];
  try {
    entries = readdirSync(LOG_DIR);
  } catch {
    return;
  }
  const cutoff = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (entry === "latest.log" || !entry.endsWith(".log")) continue;
    const full = path.join(LOG_DIR, entry);
    try {
      if (statSync(full).mtimeMs < cutoff) rmSync(full);
    } catch {
      // 单个文件清扫失败不处理
    }
  }
}
