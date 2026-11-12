import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import { AppError } from "./errors.ts";
import type { ModelStatus } from "./types.ts";

export type ModelConfig = { model: string; baseUrl: string; apiKey: string };
type Runtime = { fingerprint: string; checkedAt: string | null; saving: boolean };
const globalConfig = globalThis as typeof globalThis & { eapConfigRuntime?: Runtime };
const runtime = globalConfig.eapConfigRuntime ??= { fingerprint: "", checkedAt: null, saving: false };
const configPath = path.join(process.cwd(), ".env.local");
function readEnv(source: string) {
  const values: Record<string, string> = {};
  for (const line of source.split(/\r?\n/)) {
    const match = line.match(/^\s*(QWEN_MODEL|QWEN_BASE_URL|QWEN_API_KEY)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    let value = match[2];
    if (value.startsWith('"')) { try { value = JSON.parse(value); } catch { value = value.slice(1, -1); } }
    else if (value.startsWith("'")) value = value.slice(1, -1);
    values[match[1]] = value;
  }
  return values;
}

export async function readConfig(): Promise<ModelConfig> {
  let values: Record<string, string> = {};
  try { if (process.env.EAP_TEST_UPSTREAM !== "1") values = readEnv(await readFile(configPath, "utf8")); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new AppError("无法读取本地模型配置，请检查文件权限。", 500);
  }
  return {
    model: (values.QWEN_MODEL ?? process.env.QWEN_MODEL ?? "qwen3.8-max").trim(),
    baseUrl: (values.QWEN_BASE_URL ?? process.env.QWEN_BASE_URL ?? "").trim().replace(/\/+$/, ""),
    apiKey: (values.QWEN_API_KEY ?? process.env.QWEN_API_KEY ?? "").trim(),
  };
}

export function validateEndpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new AppError("请填写千问控制台提供的完整接口地址。"); }
  const official = url.hostname.endsWith(".aliyuncs.com") && url.protocol === "https:";
  const testLocal = process.env.EAP_TEST_UPSTREAM === "1" && ["127.0.0.1", "localhost"].includes(url.hostname) && url.protocol === "http:";
  if ((!official && !testLocal) || url.username || url.password || url.search || url.hash || (official && url.port && url.port !== "443")) {
    throw new AppError("请使用千问官方 HTTPS 接口地址，不要填写代理地址或包含 Key 的链接。");
  }
  if (/[{}<>\s]/.test(value)) throw new AppError("请把接口地址里的工作空间占位文字替换为你的实际信息。");
  if (!url.pathname.replace(/\/+$/, "").endsWith("/v1")) throw new AppError("接口地址应以 /v1 结尾，不需要附加 /chat/completions。");
  return url.toString().replace(/\/+$/, "");
}

function fingerprint(config: ModelConfig) {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export function markVerified(config: ModelConfig) {
  runtime.fingerprint = fingerprint(config);
  runtime.checkedAt = new Date().toISOString();
}

export async function publicStatus(): Promise<ModelStatus> {
  const config = await readConfig();
  const verified = runtime.fingerprint === fingerprint(config) && Boolean(runtime.checkedAt);
  return { model: config.model, baseUrl: config.baseUrl, hasKey: Boolean(config.apiKey), configured: Boolean(config.model && config.baseUrl && config.apiKey), verified, checkedAt: verified ? runtime.checkedAt : null };
}

export async function saveConfig(input: Record<string, unknown>) {
  if (runtime.saving) throw new AppError("正在保存配置，请稍候。", 409);
  const previous = await readConfig();
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!/^[a-zA-Z0-9][\w.\-/]{0,119}$/.test(model)) throw new AppError("请填写正确的模型名称。");
  const baseUrl = validateEndpoint(typeof input.baseUrl === "string" ? input.baseUrl.trim() : "");
  const apiKey = typeof input.apiKey === "string" && input.apiKey.trim() ? input.apiKey.trim() : previous.apiKey;
  if (!apiKey || apiKey.length > 2048 || /[\r\n\s]/.test(apiKey)) throw new AppError("请填写有效的 API Key，内容不能包含空格或换行。");
  runtime.saving = true;
  try {
    let oldSource = "";
    try { oldSource = await readFile(configPath, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const others = oldSource.split(/\r?\n/).filter((line) => !/^\s*(QWEN_MODEL|QWEN_BASE_URL|QWEN_API_KEY)\s*=/.test(line)).join("\n").trim();
    const content = `${others ? others + "\n\n" : ""}QWEN_MODEL=${JSON.stringify(model)}\nQWEN_BASE_URL=${JSON.stringify(baseUrl)}\nQWEN_API_KEY=${JSON.stringify(apiKey)}\n`;
    const temporary = `${configPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, configPath);
    runtime.checkedAt = null;
    runtime.fingerprint = "";
  } finally { runtime.saving = false; }
  return publicStatus();
}
