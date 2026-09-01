/**
 * 版本号单一来源：运行时从 package.json 读取，
 * 供 MCP Server 元信息与 HTTP User-Agent 共用，
 * 避免版本号散落多处导致不一致。
 */
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

export const VERSION: string = pkg.version;
