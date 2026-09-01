# Changelog

## 1.1.0 - 2026-09-01

- 新增后台任务模式:`agy_prompt` / `agy_conversation` 支持 `background: true`,调用立即返回 `task_id`(毫秒级);新增 `agy_status` 工具轮询任务状态——running 附增量输出尾部,done 返回完整结果,error 返回错误详情与日志路径。用于绕开 ZCode 等客户端对单次工具调用的 30s 硬超时(AGY 真实任务常需数分钟)

## 1.0.1 - 2026-09-01

- `agy_models` 超时由 15s 放宽到 30s(实测 agy 启动含认证连网约 7s,原余量不足)

## 1.0.0 - 2026-09-01

- 首次发布:`agy_prompt` / `agy_conversation` / `agy_models` 三个工具,把 Antigravity CLI(agy)包装为 MCP 工具
