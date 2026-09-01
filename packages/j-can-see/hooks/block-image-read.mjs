#!/usr/bin/env node
/**
 * Claude Code PreToolUse hook：
 * 拦截 Read 工具读取图片，引导改用 see_image。
 *
 * 背景：当主模型无多模态输入能力时，Read 一张图会让 API 直接 400，
 * 整个 turn 崩溃。此 hook 在请求发出前拦截，fail fast 并引导到 see_image。
 *
 * 配置见 README。Codex 无 PreToolUse 机制，仅靠 AGENTS.md 约定。
 */
const IMAGE_EXT = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "bmp",
  "tiff",
]);

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return 0; // 无法解析的输入，放行（不阻塞正常流程）
  }

  if (payload?.tool_name !== "Read") return 0;

  const filePath = payload?.tool_input?.file_path ?? "";
  const ext = (filePath.split(".").pop() ?? "").toLowerCase();

  if (IMAGE_EXT.has(ext)) {
    process.stderr.write(
      [
        `此模型没有多模态输入能力，直接 Read 图片会导致请求 400。`,
        `请改用 see_image 工具读取图片：`,
        `  see_image({ source: "${filePath}" })`,
        `来源支持：本地路径（含 ~ 展开）、http(s) URL、"clipboard"、"latest"。`,
        ``,
      ].join("\n"),
    );
    return 2; // exit 2 = 阻止执行，stderr 反馈给模型
  }

  return 0;
}

main().then((code) => process.exit(code));
