#!/usr/bin/env node
/**
 * j-can-see MCP server 入口（stdio 传输）。
 *
 * 暴露一组视觉/像素工具（see_image / locate / inspect / ...）。
 * 视觉配置为懒校验：缺 J_SEE_* 时 server 照常启动、本地像素工具全部可用，
 * 仅在 stderr 留警告；视觉工具在调用时才完整校验并返回 ConfigError。
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { loadConfig, loadBaseConfig } from "./config.js";
import { sweepStaleClipboardTemp } from "./sources/clipboard.js";
import { bundledSkillPath, installSkillBestEffort, skillInstallDirs } from "./skill.js";
import { listTools, getTool } from "./tools/registry.js";
import { VERSION } from "./version.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import os from "node:os";
import path from "node:path";

// 辅助命令：导出 Claude Code PreToolUse hook 脚本，便于一行安装：
//   npx j-can-see --hook > ~/.claude/hooks/block-image-read.mjs
const argv = process.argv.slice(2);
if (argv.includes("--hook") || argv.includes("--print-hook")) {
  const hookPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "hooks",
    "block-image-read.mjs",
  );
  try {
    process.stdout.write(readFileSync(hookPath, "utf8"));
  } catch {
    process.stderr.write(
      "无法定位 hook 脚本，请从仓库获取 hooks/block-image-read.mjs\n",
    );
    process.exit(1);
  }
  process.exit(0);
}

// 辅助命令：手动安装/更新 Agent Skill。正常情况下无需执行——server 启动时
// 会自动 best-effort 安装（见 main()），这里提供显式入口：
//   npx j-can-see --skill        # 复制到各客户端 skills 目录（已存在则覆盖为当前版本）
//   npx j-can-see --print-skill  # 打印 SKILL.md 内容，自行放置
if (argv.includes("--print-skill")) {
  const skillPath = bundledSkillPath();
  if (!skillPath) {
    process.stderr.write("无法定位 SKILL.md，请从仓库获取\n");
    process.exit(1);
  }
  process.stdout.write(readFileSync(skillPath, "utf8"));
  process.exit(0);
}
if (argv.includes("--skill")) {
  const home = os.homedir();
  const result = installSkillBestEffort(home);
  if (!result) {
    process.stderr.write("无法定位 SKILL.md，请从仓库获取\n");
    process.exit(1);
  }
  if (result.error) process.stderr.write(`部分安装失败：${result.error}\n`);
  process.stdout.write(
    `已安装 Agent Skill（重启 agent 客户端后生效）：\n${skillInstallDirs(
      home,
    )
      .map((d) => `  ${path.join(d, "SKILL.md")}`)
      .join("\n")}\nskill 与 MCP server 相互独立，建议两者都配置。\n`,
  );
  process.exit(0);
}

function main(): void {
  // 清扫上次进程被强杀时可能残留的剪贴板中转文件（仅自身命名空间，best-effort）
  void sweepStaleClipboardTemp();

  // 启动期自动安装 Agent Skill：用户只需配置 MCP，方法论（SKILL.md）随 server 送达。
  // 内容与已装版本一致则跳过写盘；失败仅提示、不影响 server 启动。
  // 可用 J_SEE_SKILL_AUTO_INSTALL=0 关闭自动安装。
  if (process.env.J_SEE_SKILL_AUTO_INSTALL !== "0") {
    const skillResult = installSkillBestEffort();
    if (skillResult?.error) {
      console.error(
        `[j-can-see] 安装 Agent Skill 失败（可忽略，不影响工具使用）：${skillResult.error}`,
      );
    }
  }

  // 视觉配置懒校验：缺 J_SEE_* 时 server 仍启动（本地工具可用），
  // 仅在 stderr 留警告；视觉工具调用时才完整校验并返回 ConfigError
  try {
    loadConfig();
  } catch (e) {
    console.error(
      `[j-can-see] 视觉配置缺失，仅本地工具（crop/image_diff/colors/trace/extract_fg）可用：\n${
        e instanceof Error ? e.message : String(e)
      }`,
    );
  }

  // server instructions 进入每个会话的上下文，不依赖 skill 是否被触发 ——
  // 核心是把触发门控告诉多模态主模型：有原生视觉就别把视觉识别类工具当默认路径。
  const server = new Server(
    { name: "j-can-see", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions:
        "j-can-see 提供两类工具：视觉识别类（see_image / locate / inspect / ocr_long，调上游视觉模型）" +
        "与本地像素类（colors / image_diff / crop / trace / extract_fg，纯本地算法）。" +
        "【触发门控】若你（主模型）有原生多模态输入，默认用自己的眼睛读图，不要调用视觉识别类工具；" +
        "仅当用户明确要求用 j-can-see、或你的原生视觉失效（图片读不了/报错、内容不可用）、" +
        "或任务超出原生视觉可靠范围（如超长图逐字 OCR）时才使用。" +
        "本地像素类不受此限——精确 hex 色值、逐像素差异百分比这类真值任何模型的眼睛都给不出，需要时直接用。" +
        "【像素任务开场】精确取色（含图表/数据可视化系列色）、差异对比、色块定位这类任务，" +
        "开场直接用本地像素类（colors 的 region/profile、image_diff），不要先走视觉识别类绕一圈——" +
        "深背景会淹没 colors 主色榜，输出会自动附背景排除视图，或传 exclude_background: true。",
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: listTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const entry = getTool(name);
    if (!entry) {
      return {
        isError: true,
        content: [{ type: "text" as const, text: `未知工具：${name}` }],
      };
    }

    const parsed = entry.schema.safeParse(args);
    if (!parsed.success) {
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `参数错误：${parsed.error.issues
              .map((i) => i.message)
              .join("; ")}`,
          },
        ],
      };
    }

    try {
      // 判别联合按 needsVision 收窄：本地工具拿 BaseConfig（零视觉配置可用），
      // 视觉工具拿完整校验过的 AppConfig
      const text = entry.needsVision
        ? await entry.run(parsed.data, loadConfig())
        : await entry.run(parsed.data, loadBaseConfig());
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      // 运行期错误（来源/图片/视觉调用）以 isError 形式返回，
      // 让客户端看到清晰原因而非崩溃
      const message = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  });

  const transport = new StdioServerTransport();
  server.connect(transport).catch((e) => {
    console.error(
      "[j-can-see] 连接传输失败：",
      e instanceof Error ? e.message : String(e),
    );
    process.exit(1);
  });
}

try {
  main();
} catch (e) {
  // 启动期错误（主要是配置缺失）—— 打印清晰原因后退出
  console.error(`[j-can-see] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
