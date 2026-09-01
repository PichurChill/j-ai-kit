import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  installSkill,
  installSkillBestEffort,
  skillInstallDirs,
} from "../src/skill.js";

describe("Agent Skill 安装", () => {
  let root: string;
  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "jcs-skill-"));
  });
  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  const content = Buffer.from("# j-can-see\nfrontmatter: yes\n");

  it("创建目录并写入 SKILL.md", async () => {
    const dirs = [path.join(root, ".claude", "skills", "j-can-see")];
    const res = installSkill(dirs, content);
    expect(res.installed).toHaveLength(1);
    expect(res.skipped).toHaveLength(0);
    expect(res.error).toBeUndefined();
    await expect(
      fs.readFile(path.join(dirs[0], "SKILL.md")),
    ).resolves.toEqual(content);
  });

  it("内容一致时跳过写盘（skipped 而非 installed）", async () => {
    const dir = path.join(root, ".claude", "skills", "j-can-see");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), content);
    const res = installSkill([dir], content);
    expect(res.installed).toHaveLength(0);
    expect(res.skipped).toEqual([path.join(dir, "SKILL.md")]);
  });

  it("内容不同时覆盖更新", async () => {
    const dir = path.join(root, ".claude", "skills", "j-can-see");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "SKILL.md"), "old version");
    installSkill([dir], content);
    await expect(
      fs.readFile(path.join(dir, "SKILL.md")),
    ).resolves.toEqual(content);
  });

  it("单个目录失败不影响其余目录，错误经 error 回报", async () => {
    // 用普通文件占位，使其下任何路径都无法创建目录
    await fs.writeFile(path.join(root, "block"), "file");
    const dirs = [
      path.join(root, "block", "skills", "j-can-see"),
      path.join(root, "ok"),
    ];
    const res = installSkill(dirs, content);
    expect(res.error).toBeDefined();
    expect(res.installed).toEqual([path.join(root, "ok", "SKILL.md")]);
  });

  it("best-effort 安装到全部客户端目录，重复调用幂等", () => {
    const first = installSkillBestEffort(root);
    expect(first).not.toBeNull();
    expect(first!.installed).toHaveLength(skillInstallDirs(root).length);
    expect(first!.error).toBeUndefined();

    const second = installSkillBestEffort(root);
    expect(second!.installed).toHaveLength(0);
    expect(second!.skipped).toHaveLength(skillInstallDirs(root).length);
  });
});
