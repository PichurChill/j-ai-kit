# AGENTS.md — j-ai-kit 仓库工作准则

面向在本仓库工作的 AI 编码代理。完整的个人开发规则在本地 `DEV_RULES.MD`(未入库,不随仓库分发),本文件与其冲突时以 `DEV_RULES.MD` 为准。

## 仓库形态

- npm workspaces monorepo:`packages/*` 下每个目录是一个**独立的 npm 包**(独立版本、独立 CHANGELOG、独立发布);`skills/` 存放不发布 npm 的 skill。
- 根 `package.json` 是 `private` 的,不发布;`npm publish` 只在具体包目录内执行。

## 开发流程

- 只修改目标包目录内的文件;跨包变更(根配置、workspaces)属于结构性变更,先说明理由再动手。
- 验证:改哪个包就在该包目录跑 `npm test`;结构性变更在根目录跑 `npm test --workspaces` 全量回归。
- 外部事实(CLI 参数、上游 API、包版本)以实测或官方文档为准,不凭记忆假设。

## 发布

- 发包前在包目录 `npm pack --dry-run` 复核清单;`prepublishOnly` 钩子自动 build + typecheck。
- workspace 内不读取包目录的 `.npmrc`(npm 10+ 安全策略):凭据用仓库根 `.npmrc`(已 ignore)或全局登录态,发包前 `npm whoami` 验证。
- 已发布版本不可变:发版前想清 semver,并同步该包 `CHANGELOG.md`。

## 提交与敏感信息

- **AI 代理不得自行执行 git commit / git push**,流程见 `DEV_RULES.MD`。
- 凭据只放 `.npmrc` / 环境变量(均已被 ignore);文档与代码示例一律用占位符(`sk-ant-...`、`/Users/you/...`)。
- 提交前核对 `git status --short`,确认无预期外的文件被暂存。
