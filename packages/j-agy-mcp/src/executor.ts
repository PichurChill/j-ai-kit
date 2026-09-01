/**
 * agy 进程执行器:spawn Antigravity CLI,按行解析 stream-json 输出,
 * 收集 result 事件并通过 onEvent 把中间事件(step_update 等)透传给调用方。
 *
 * 超时策略:先 SIGTERM,2 秒后仍存活则升级 SIGKILL,避免进程残留;
 * 同时给 CLI 传 --print-timeout(略大于进程级超时),保证先超时的是我们、
 * 而不是 CLI 自己放弃导致拿不到任何结果。
 */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export const DEFAULT_MODEL = "Gemini 3.7 Flash (High)";
export const DEFAULT_EFFORT = "high";
export const DEFAULT_TIMEOUT_SECONDS = 300;
/** 超时后等待进程响应 SIGTERM 的宽限期,超时升级 SIGKILL。 */
const TERM_GRACE_MS = 2000;
/** 错误信息里携带的 stderr 尾部长度上限。 */
const STDERR_TAIL_LIMIT = 2000;

export interface AgyUsage {
  input_tokens?: number;
  output_tokens?: number;
  thinking_tokens?: number;
  cache_read_tokens?: number;
  total_tokens?: number;
}

/** agy stream-json 的 result 事件载荷。字段按防御式读取,不做强假设。 */
export interface AgyResult {
  conversation_id?: string;
  status?: string;
  response?: string;
  error?: string;
  duration_seconds?: number;
  num_turns?: number;
  usage?: AgyUsage;
}

export interface AgyEvent {
  event: string;
  [key: string]: unknown;
}

export interface ExecuteAgyOptions {
  prompt: string;
  cwd?: string;
  addDirs?: string[];
  mode?: "accept-edits" | "plan";
  model?: string;
  effort?: "low" | "medium" | "high";
  conversationId?: string;
  /** 自动批准所有权限请求(--dangerously-skip-permissions),默认开启。 */
  skipPermissions?: boolean;
  /** 终端沙箱(--sandbox),默认开启。 */
  sandbox?: boolean;
  timeoutSeconds?: number;
  onEvent?: (event: AgyEvent) => void;
}

/** agy 可执行文件不存在或无法启动时抛出。 */
export class AgyLaunchError extends Error {}

/** agy 可执行文件路径:默认走 PATH,GUI 环境启动 MCP server 时 PATH 可能缺 ~/.local/bin,用 AGY_BIN 显式指定。 */
function agyBin(): string {
  return process.env.AGY_BIN || "agy";
}

/**
 * 组装模型参数。agy 的模型名自带强度后缀(如 "Gemini 3.7 Flash (High)")且与
 * --effort 一一对应,名字里已含强度时不再传 --effort,避免重复指定产生冲突;
 * 只有名字不带强度时,才用原生 --effort 表达(默认 high)。
 */
export function resolveModelArgs(model?: string, effort?: string): string[] {
  const target = model ?? DEFAULT_MODEL;
  const args = ["--model", target];
  const nameHasEffort = /\((high|medium|low)\)\s*$/i.test(target) || /-(high|medium|low)$/i.test(target);
  if (!nameHasEffort) {
    args.push("--effort", (effort ?? DEFAULT_EFFORT).toLowerCase());
  }
  return args;
}

export function buildAgyArgs(options: ExecuteAgyOptions): string[] {
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  const args: string[] = [
    "--print",
    options.prompt,
    "--output-format",
    "stream-json",
    // CLI 内部超时必须晚于进程级超时
    "--print-timeout",
    `${timeoutSeconds + 30}s`,
    ...resolveModelArgs(options.model, options.effort),
  ];
  if (options.conversationId) {
    args.push("--conversation", options.conversationId);
  }
  for (const dir of options.addDirs ?? []) {
    args.push("--add-dir", dir);
  }
  if (options.mode) {
    args.push("--mode", options.mode);
  }
  if (options.skipPermissions !== false) {
    args.push("--dangerously-skip-permissions");
  }
  if (options.sandbox !== false) {
    args.push("--sandbox");
  }
  return args;
}

function stderrTail(chunks: string[]): string {
  const joined = chunks.join("");
  return joined.length > STDERR_TAIL_LIMIT ? `…${joined.slice(-STDERR_TAIL_LIMIT)}` : joined;
}

function isAlive(child: ReturnType<typeof spawn>): boolean {
  return child.exitCode === null && child.signalCode === null;
}

export async function executeAgy(options: ExecuteAgyOptions): Promise<AgyResult> {
  const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
  return new Promise<AgyResult>((resolve, reject) => {
    const child = spawn(agyBin(), buildAgyArgs(options), {
      cwd: options.cwd ?? process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let result: AgyResult | undefined;
    let timedOut = false;
    const stderrChunks: string[] = [];

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (isAlive(child)) child.kill("SIGKILL");
      }, TERM_GRACE_MS).unref();
    }, timeoutSeconds * 1000);

    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let event: AgyEvent;
      try {
        event = JSON.parse(trimmed) as AgyEvent;
      } catch {
        // 非 JSON 行不静默丢弃,写 stderr 留痕
        process.stderr.write(`[j-agy-mcp] agy 输出了无法解析的行: ${trimmed.slice(0, 200)}\n`);
        return;
      }
      if (event.event === "result" && event.result && typeof event.result === "object") {
        result = event.result as AgyResult;
      }
      try {
        options.onEvent?.(event);
      } catch (err) {
        process.stderr.write(`[j-agy-mcp] 事件回调失败: ${err instanceof Error ? err.message : String(err)}\n`);
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrChunks.push(chunk.toString());
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new AgyLaunchError(`agy 进程启动失败: ${err.message}。若 agy 不在 PATH 中,请设置环境变量 AGY_BIN 指向可执行文件。`));
    });

    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (result) {
        resolve(result);
        return;
      }
      const tail = stderrTail(stderrChunks);
      const detail = tail ? `\nstderr 尾部:\n${tail}` : "";
      if (timedOut) {
        reject(new Error(`agy 执行超时(${timeoutSeconds}s),已终止进程。${detail}`));
      } else {
        reject(new Error(`agy 进程退出(code=${code}, signal=${signal})但未返回结果。${detail}`));
      }
    });

    // 超时路径:timer 回调 kill 后由 close 事件统一 reject(timedOut 分支),
    // close 与 error 的 reject 均为一次性,重复调用是 no-op
  });
}

/** 查询 agy 可用模型列表(透传 `agy models` 的 stdout)。 */
export async function listAgyModels(timeoutSeconds = 15): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(agyBin(), ["models"], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => {
        if (isAlive(child)) child.kill("SIGKILL");
      }, TERM_GRACE_MS).unref();
    }, timeoutSeconds * 1000);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(new AgyLaunchError(`agy 进程启动失败: ${err.message}。若 agy 不在 PATH 中,请设置环境变量 AGY_BIN 指向可执行文件。`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`agy models 退出(code=${code})。${stderr ? `stderr: ${stderr}` : ""}`));
      }
    });
  });
}
