/**
 * MCP 工具注册:agy_prompt / agy_conversation / agy_status / agy_models。
 * agy_conversation 与 agy_prompt 拥有一致的执行参数(工作目录、模式、模型等),
 * 续聊时不会丢失对执行环境的控制。
 * background 模式:调用立即返回 task_id,配合 agy_status 轮询直至完成——
 * 用于绕开 ZCode 等客户端对单次工具调用的硬超时(如 30s)。
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  DEFAULT_TIMEOUT_SECONDS,
  executeAgy,
  getAgyTask,
  listAgyModels,
  startAgyTask,
  type AgyEvent,
  type AgyResult,
  type ExecuteAgyOptions,
} from "./executor.js";
import { createExecutionSession, type ExecutionSession } from "./logging.js";

/** 将 agy 的 result 渲染为 MCP 工具结果。字段全部防御式读取,agy 返回结构变化时降级显示而非抛错。 */
export function formatResult(result: AgyResult, logFile: string): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  if (result.status && result.status !== "SUCCESS") {
    return {
      content: [{ type: "text", text: `错误: ${result.error ?? result.response ?? "agy 返回未知错误"}` }],
      isError: true,
    };
  }
  const meta = [
    `conversation_id: ${result.conversation_id ?? "未知"}`,
    `duration: ${typeof result.duration_seconds === "number" ? `${result.duration_seconds.toFixed(1)}s` : "未知"}`,
    `turns: ${result.num_turns ?? "未知"}`,
    `tokens: ${result.usage?.total_tokens ?? "未知"}`,
    `log: ${logFile}`,
  ].join(" | ");
  return {
    content: [
      { type: "text", text: result.response ?? "" },
      { type: "text", text: `---\n${meta}` },
    ],
  };
}

const timeoutSchema = z
  .number()
  .int()
  .min(1)
  .max(3600)
  .optional()
  .describe(`超时秒数,默认 ${DEFAULT_TIMEOUT_SECONDS}`);

const backgroundSchema = z.boolean().optional().describe(
  "后台执行:true 时立即返回 task_id(毫秒级),用 agy_status 轮询进度与结果。" +
    "适用于客户端对单次工具调用有硬超时的场景(如 ZCode 的 30s 限制)——AGY 真实任务常需数分钟",
);

const executionSchema = {
  cwd: z.string().optional().describe("任务执行的工作目录(绝对路径),默认 MCP server 启动目录"),
  add_dirs: z.array(z.string()).optional().describe("额外加入工作区的目录列表(绝对路径)"),
  mode: z.enum(["accept-edits", "plan"]).optional().describe(
    "执行模式:accept-edits(自动应用文件修改)或 plan(仅规划不执行),默认 accept-edits",
  ),
  model: z.string().optional().describe(`模型名称,默认 "${DEFAULT_MODEL}"。用 agy_models 查询可用模型`),
  effort: z.enum(["low", "medium", "high"]).optional().describe(
    `推理强度,默认 ${DEFAULT_EFFORT};模型名已含强度后缀时忽略此参数`,
  ),
  skip_permissions: z.boolean().optional().describe(
    "自动批准所有权限请求(--dangerously-skip-permissions),默认 true",
  ),
  sandbox: z.boolean().optional().describe("启用终端沙箱(--sandbox),默认 true"),
} as const;

function toExecuteOptions(
  params: {
    cwd?: string;
    add_dirs?: string[];
    mode?: "accept-edits" | "plan";
    model?: string;
    effort?: "low" | "medium" | "high";
    skip_permissions?: boolean;
    sandbox?: boolean;
    timeout_seconds?: number;
  },
): Omit<ExecuteAgyOptions, "prompt"> {
  return {
    cwd: params.cwd,
    addDirs: params.add_dirs,
    mode: params.mode,
    model: params.model,
    effort: params.effort,
    skipPermissions: params.skip_permissions,
    sandbox: params.sandbox,
    timeoutSeconds: params.timeout_seconds,
  };
}

/** 从 step_update 事件提取增量文本;无增量返回 undefined。 */
export function stepDelta(event: AgyEvent): string | undefined {
  if (event.event !== "step_update") return undefined;
  const update = event.step_update;
  if (!update || typeof update !== "object") return undefined;
  const delta = (update as { text_delta?: unknown }).text_delta;
  return typeof delta === "string" && delta.length > 0 ? delta : undefined;
}

/** MCP 调用上下文中本工具用到的最小结构(结构化类型,兼容 SDK 的 ctx)。 */
interface StreamContext {
  mcpReq: {
    _meta?: { progressToken?: unknown };
    notify: (notification: { method: string; params: Record<string, unknown> }) => Promise<void>;
  };
}

/**
 * 构建流式事件处理器:增量写 stderr(带短 ID 前缀)、写任务日志,
 * 客户端提供 progressToken 时转发 MCP 进度通知。
 */
function makeStreamHandler(
  session: ExecutionSession,
  ctx: StreamContext,
): (event: AgyEvent) => Promise<void> {
  const progressToken = ctx.mcpReq._meta?.progressToken;
  let stepCount = 0;
  return async (event: AgyEvent) => {
    const delta = stepDelta(event);
    if (!delta) return;
    // 流式透传到 stderr,并发任务用短 ID 区分
    process.stderr.write(`[agy:${session.executionId.slice(-6)}] ${delta}`);
    session.appendDelta(delta);
    if (progressToken !== undefined) {
      stepCount += 1;
      await ctx.mcpReq.notify({
        method: "notifications/progress",
        params: { progressToken, progress: stepCount, message: delta },
      });
    }
  };
}

/** 后台任务登记表:taskId → 任务对象与其专属日志路径。随 MCP server 进程存续。 */
const backgroundTasks = new Map<string, { task: ReturnType<typeof startAgyTask>; logFile: string }>();

function startBackgroundTask(
  kind: "prompt" | "conv",
  session: ExecutionSession,
  options: ExecuteAgyOptions,
): string {
  // 流式处理经 options.onEvent 传入:startAgyTask 内部提取增量维护 partialText,
  // 并透传 onEvent 完成日志写入与进度通知
  const task = startAgyTask(options, kind);
  backgroundTasks.set(task.id, { task, logFile: session.logFile });
  return task.id;
}

function backgroundStartedText(taskId: string, logFile: string): string {
  return (
    `AGY 任务已在后台启动。\ntask_id: ${taskId}\nstatus: running\nlog: ${logFile}\n` +
    `用 agy_status 工具(传此 task_id)轮询:running 返回增量输出,done 返回完整结果。`
  );
}

export function registerTools(server: McpServer): void {
  server.registerTool(
    "agy_prompt",
    {
      description:
        "向 Antigravity CLI(agy)派发一个自包含任务并等待最终结果。AGY 是完整的编码代理,可读写文件、" +
        "执行终端命令、搜索代码库与网页,适合作为主代理的外部子代理承担探索、检索或编码执行。" +
        "AGY 的上下文与主代理独立,任务描述必须自包含(目标、涉及目录、验收方式)。" +
        "返回结果包含 conversation_id,可用 agy_conversation 续聊;每次执行的完整过程日志见返回中的 log 路径。" +
        "真实任务常需数分钟,客户端对单次调用有硬超时(如 ZCode 的 30s)时传 background: true 并用 agy_status 轮询。",
      inputSchema: z.object({
        prompt: z.string().min(1).describe("发给 Antigravity 的任务描述"),
        ...executionSchema,
        background: backgroundSchema,
        timeout_seconds: timeoutSchema,
      }),
    },
    async (params, ctx) => {
      const session = createExecutionSession("prompt");
      const onEvent = makeStreamHandler(session, ctx);
      if (params.background === true) {
        const taskId = startBackgroundTask(
          "prompt",
          session,
          { ...toExecuteOptions(params), prompt: params.prompt, onEvent },
        );
        return { content: [{ type: "text", text: backgroundStartedText(taskId, session.logFile) }] };
      }
      const result = await executeAgy({ ...toExecuteOptions(params), prompt: params.prompt, onEvent });
      return formatResult(result, session.logFile);
    },
  );

  server.registerTool(
    "agy_conversation",
    {
      description:
        "在已有 AGY 对话上继续追问或迭代(传 agy_prompt / agy_conversation 返回的 conversation_id)。" +
        "执行参数与 agy_prompt 一致,续聊不会丢失对工作目录、模式与模型的控制。" +
        "客户端有硬超时限制时同样可传 background: true 并用 agy_status 轮询。",
      inputSchema: z.object({
        conversation_id: z.string().min(1).describe("要延续的对话 ID(由 agy_prompt 返回)"),
        prompt: z.string().min(1).describe("追加的指令或反馈"),
        ...executionSchema,
        background: backgroundSchema,
        timeout_seconds: timeoutSchema,
      }),
    },
    async (params, ctx) => {
      const session = createExecutionSession("conv");
      const onEvent = makeStreamHandler(session, ctx);
      if (params.background === true) {
        const taskId = startBackgroundTask(
          "conv",
          session,
          { ...toExecuteOptions(params), prompt: params.prompt, conversationId: params.conversation_id, onEvent },
        );
        return { content: [{ type: "text", text: backgroundStartedText(taskId, session.logFile) }] };
      }
      const result = await executeAgy({
        ...toExecuteOptions(params),
        prompt: params.prompt,
        conversationId: params.conversation_id,
        onEvent,
      });
      return formatResult(result, session.logFile);
    },
  );

  server.registerTool(
    "agy_status",
    {
      description:
        "查询后台 AGY 任务的状态与结果。配合 agy_prompt / agy_conversation 的 background: true 使用:" +
        "返回 running(附增量输出尾部)时稍后再次轮询,done 返回完整结果,error 返回错误详情与日志路径。",
      inputSchema: z.object({
        task_id: z.string().min(1).describe("后台启动时返回的任务 ID"),
      }),
    },
    async (params) => {
      const task = getAgyTask(params.task_id);
      const entry = backgroundTasks.get(params.task_id);
      if (!task || !entry) {
        return {
          content: [{
            type: "text",
            text: `错误: 未知任务 ID ${params.task_id}(任务记录随 MCP server 进程存续,server 重启后丢失;可改用日志文件或 agy_conversation 续聊)`,
          }],
          isError: true,
        };
      }
      if (task.status === "running") {
        const elapsed = ((Date.now() - new Date(task.startedAt).getTime()) / 1000).toFixed(0);
        const tail = task.partialText.slice(-600);
        return {
          content: [{
            type: "text",
            text: `status: running(已运行 ${elapsed}s)\nlog: ${entry.logFile}\n--- 增量输出尾部 ---\n${tail || "(暂无输出)"}`,
          }],
        };
      }
      if (task.status === "error") {
        return {
          content: [{ type: "text", text: `status: error\ntask_id: ${task.id}\n${task.error ?? "未知错误"}\nlog: ${entry.logFile}` }],
          isError: true,
        };
      }
      const formatted = formatResult(task.result ?? {}, entry.logFile);
      return {
        content: [{ type: "text", text: `status: done\ntask_id: ${task.id}` }, ...formatted.content],
        isError: formatted.isError,
      };
    },
  );

  server.registerTool(
    "agy_models",
    {
      description: "查询当前环境 agy 可用的模型列表。",
      inputSchema: z.object({}),
    },
    async () => {
      const output = await listAgyModels();
      return { content: [{ type: "text", text: output }] };
    },
  );
}
