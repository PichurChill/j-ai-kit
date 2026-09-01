/**
 * fake agy:按 MOCK_AGY_SCENARIO 场景模拟 Antigravity CLI 行为,
 * 由测试注入到 PATH 前部,用于覆盖执行器与协议层。
 */
import { chmodSync, writeFileSync } from "node:fs";
import path from "node:path";

export const MOCK_AGY_SCRIPT = `#!/usr/bin/env bash
# fake agy:按 MOCK_AGY_SCENARIO 场景模拟 Antigravity CLI,仅供测试
scenario="\${MOCK_AGY_SCENARIO:-success}"
case "$1" in
  models)
    printf 'gemini-3.7-flash-high\\tGemini 3.7 Flash (High)\\n'
    exit 0
    ;;
esac
case "$scenario" in
  success)
    echo '{"event":"init","conversation_id":"c-1","init":{"model":"gemini-3.7-flash-high"}}'
    echo '{"event":"step_update","step_update":{"step_index":1,"step_type":"agent_response","text_delta":"你好"}}'
    echo '{"event":"result","result":{"conversation_id":"c-1","status":"SUCCESS","response":"你好","duration_seconds":1.2,"num_turns":1,"usage":{"total_tokens":42}}}'
    ;;
  error-status)
    echo '{"event":"result","result":{"conversation_id":"c-2","status":"ERROR","error":"boom"}}'
    ;;
  exit-nonzero)
    echo "mock stderr noise" >&2
    exit 3
    ;;
  garbage)
    echo "this is not json"
    echo '{"event":"result","result":{"status":"SUCCESS","response":"fine"}}'
    ;;
  hang)
    # 忽略 SIGTERM(SIG_IGN 跨 exec 保留),用于验证升级 SIGKILL
    trap '' TERM
    exec sleep 30
    ;;
  *)
    echo "unknown scenario: $scenario" >&2
    exit 1
    ;;
esac
`;

/** 把 fake agy 安装到指定目录(命名为 agy 并赋予执行权限)。 */
export function installMockAgy(dir: string): string {
  const bin = path.join(dir, "agy");
  writeFileSync(bin, MOCK_AGY_SCRIPT, "utf-8");
  chmodSync(bin, 0o755);
  return bin;
}
