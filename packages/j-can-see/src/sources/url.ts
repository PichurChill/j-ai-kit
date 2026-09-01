/**
 * URL 来源：下载图片字节。
 *
 * 校验 content-type 以避免把 HTML 错误页当图片喂给模型。
 * 显式 User-Agent —— 部分图床/CDN 同样有 bot 防护。
 */
import { SourceError } from "../errors.js";
import { VERSION } from "../version.js";

export async function readFromUrl(url: string): Promise<Buffer> {
  let resp: Response;
  try {
    resp = await fetch(url, {
      redirect: "follow",
      headers: { "User-Agent": `j-can-see/${VERSION} (mcp-vision-client)` },
    });
  } catch (e) {
    throw new SourceError(
      `下载失败：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (!resp.ok) {
    throw new SourceError(`下载失败：HTTP ${resp.status}`);
  }

  const ct = resp.headers.get("content-type") ?? "";
  if (!ct.toLowerCase().startsWith("image/")) {
    throw new SourceError(`URL 返回非图片内容类型：${ct || "(未知)"}`);
  }

  return Buffer.from(await resp.arrayBuffer());
}
