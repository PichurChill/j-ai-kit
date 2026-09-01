/**
 * MCP 工具注册:agy_prompt / agy_conversation / agy_models。
 * agy_conversation 与 agy_prompt 拥有一致的执行参数(工作目录、模式、模型等),
 * 续聊时不会丢失对执行环境的控制。
 */
import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import {
  DEFAULT_MODEL,
  DEFAULT_EFFORT,
  DEFAULT_TIMEOUT_SECONDS,
  executeAgy,
  listAgyModels,
  type AgyEvent,
  type AgyResult,
  type ExecuteAgyOptions,
} from "./executor.js";
import { createExecutionSession } from "./logging.js";

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

export function registerTools(server: McpServer): void {
  server.registerTool(
    "agy_prompt",
    {
      description:
        "向 Antigravity CLI(agy)派发一个自包含任务并等待最终结果。AGY 是完整的编码代理,可读写文件、" +
        "执行终端命令、搜索代码库与网页,适合作为主代理的外部子代理承担探索、检索或编码执行。" +
        "AGY 的上下文与主代理独立,任务描述必须自包含(目标、涉及目录、验收方式)。" +
        "返回结果包含 conversation_id,可用 agy_conversation 续聊;每次执行的完整过程日志见返回中的 log 路径。",
      inputSchema: z.object({
        prompt: z.string().min(1).describe("发给 Antigravity 的任务描述"),
        ...executionSchema,
        timeout_seconds: timeoutSchema,
      }),
    },
    async (params, ctx) => {
      const session = createExecutionSession("prompt");
      const progressToken = ctx.mcpReq._meta?.progressToken;
      let stepCount = 0;
      const onEvent = async (event: AgyEvent) => {
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
      const result = await executeAgy({ ...toExecuteOptions(params), prompt: params.prompt, onEvent });
      return formatResult(result, session.logFile);
    },
  );

  server.registerTool(
    "agy_conversation",
    {
      description:
        "在已有 AGY 对话上继续追问或迭代(传 agy_prompt / agy_conversation 返回的 conversation_id)。" +
        "执行参数与 agy_prompt 一致,续聊不会丢失对工作目录、模式与模型的控制。",
      inputSchema: z.object({
        conversation_id: z.string().min(1).describe("要延续的对话 ID(由 agy_prompt 返回)"),
        prompt: z.string().min(1).describe("追加的指令或反馈"),
        ...executionSchema,
        timeout_seconds: timeoutSchema,
      }),
    },
    async (params, ctx) => {
      const session = createExecutionSession("conv");
      const progressToken = ctx.mcpReq._meta?.progressToken;
      let stepCount = 0;
      const onEvent = async (event: AgyEvent) => {
        const delta = stepDelta(event);
        if (!delta) return;
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
