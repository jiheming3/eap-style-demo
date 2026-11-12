import { AppError } from "./errors.ts";

export function assertLocalRequest(request: Request) {
  const url = new URL(request.url);
  const loopback = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (!loopback.has(url.hostname)) {
    throw new AppError("当前服务仅支持在本机访问。", 403);
  }
  const origin = request.headers.get("origin");
  if (origin) {
    let source: URL;
    try { source = new URL(origin); } catch { throw new AppError("请从当前页面操作。", 403); }
    // Next may normalize 127.0.0.1 to localhost; treat loopback aliases on
    // the same protocol and port as this local app, without allowing other sites.
    if (!loopback.has(source.hostname) || source.protocol !== url.protocol || source.port !== url.port) {
      throw new AppError("请从当前页面操作。", 403);
    }
  }
  if (!origin && request.headers.get("sec-fetch-site") === "cross-site") throw new AppError("请从当前页面操作。", 403);
}

export async function readBody(request: Request): Promise<Record<string, unknown>> {
  if (Number(request.headers.get("content-length")) > 32_768) throw new AppError("本次内容过长，请精简后重试。", 413);
  const text = await request.text();
  if (Buffer.byteLength(text) > 32_768) throw new AppError("本次内容过长，请精简后重试。", 413);
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new AppError("提交内容格式不正确，请重试。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new AppError("提交内容格式不正确，请重试。");
  return parsed as Record<string, unknown>;
}
