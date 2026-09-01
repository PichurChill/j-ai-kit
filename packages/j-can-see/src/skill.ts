/**
 * Agent Skill 安装：把随包发布的 SKILL.md 复制到各客户端（Claude Code / ZCode / Codex）
 * 的用户级技能目录。skill 与 MCP 是两条独立通道——MCP 只保证工具描述进模型上下文，
 * 方法论（含 .j-can-see/ 落盘约定）只能经 skill 通道送达，所以只配 MCP 还不够。
 *
 * 目录约定：
 * - ~/.claude/skills —— Claude Code 专属
 * - ~/.codex/skills  —— Codex 专属
 * - ~/.agents/skills —— 跨工具共享目录（Claude/Codex/Cursor/ZCode 等都会读），ZCode 也读它
 * - ~/.zcode/skills  —— ZCode 专属（发现顺序在 ~/.agents/skills 之前）
 *
 * 触发点：server 每次启动 best-effort 安装（内容一致则跳过写盘），用户无需额外操作；
 * `--skill` CLI 复用同一实现做显式安装/更新。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

/** 各客户端用户级技能目录（<home>/<client>/skills/j-can-see） */
export function skillInstallDirs(home: string): string[] {
  return [
    path.join(home, ".claude", "skills", "j-can-see"), // Claude Code 专属
    path.join(home, ".codex", "skills", "j-can-see"), // Codex 专属
    path.join(home, ".agents", "skills", "j-can-see"), // 跨工具共享（Claude/Codex/Cursor/ZCode 等）
    path.join(home, ".zcode", "skills", "j-can-see"), // ZCode 专属
  ];
}

/** 定位随包发布的 SKILL.md（dist/../SKILL.md）；缺失返回 null */
export function bundledSkillPath(): string | null {
  const p = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
    "SKILL.md",
  );
  return fs.existsSync(p) ? p : null;
}

export interface SkillInstallResult {
  installed: string[];
  skipped: string[];
  error?: string;
}

/**
 * 安装 SKILL.md 到给定目录：目录不存在则创建；与当前包内内容一致则跳过
 * （避免每次启动都动 mtime）。任一目录失败不影响其余目录，错误经 error 返回。
 */
export function installSkill(
  dirs: readonly string[],
  content: Buffer,
): SkillInstallResult {
  const result: SkillInstallResult = { installed: [], skipped: [] };
  for (const dir of dirs) {
    const target = path.join(dir, "SKILL.md");
    try {
      if (fs.existsSync(target) && fs.readFileSync(target).equals(content)) {
        result.skipped.push(target);
        continue;
      }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(target, content);
      result.installed.push(target);
    } catch (e) {
      result.error ??= `${target}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  return result;
}

/** 启动期 best-effort 安装：不抛错，失败仅经 error 回报（供调用方提示） */
export function installSkillBestEffort(
  home: string = os.homedir(),
): SkillInstallResult | null {
  const skillPath = bundledSkillPath();
  if (!skillPath) return null;
  return installSkill(skillInstallDirs(home), fs.readFileSync(skillPath));
}
