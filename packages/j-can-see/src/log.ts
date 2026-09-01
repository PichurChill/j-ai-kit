/**
 * stderr 结构化日志：stdio MCP server 的 stderr 会进入客户端日志文件，
 * 是唯一不污染协议流的输出通道。上游调用的每次尝试、池的降档/回升
 * 都在此留痕 —— 「上游一下好一下坏」必须可归因，而不是停留在体感。
 */
export function logLine(message: string): void {
  console.error(`[j-see] ${message}`);
}
