/**
 * 子进程执行辅助：薄封装 spawn，统一收集 stdout/stderr/退出码。
 *
 * clipboard 与 latest 都需要调用系统命令（osascript / PowerShell /
 * defaults），抽到这里避免重复，也便于上层聚焦业务。
 */
import { spawn } from "node:child_process";

export interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
}

export function runCommand(
  cmd: string,
  args: readonly string[],
  opts?: { readonly stdin?: string },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      resolve({ stdout, stderr, code: code ?? -1 }),
    );
    if (opts?.stdin !== undefined) {
      child.stdin?.end(opts.stdin);
    } else {
      child.stdin?.end();
    }
  });
}
