import { AppError, upstreamError } from "./errors.ts";
import { validateEndpoint, type ModelConfig } from "./config.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import type { Message } from "./types.ts";

export type ToolDefinition = { type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type ModelMessage = { role: "system" | "user" | "assistant" | "tool"; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string };
type ModelOptions = { system?: string; tools?: ToolDefinition[]; json?: boolean };

export async function callModel(config: ModelConfig, messages: (Pick<Message, "role" | "content"> | ModelMessage)[], stream: boolean, signal?: AbortSignal, check = false, options: ModelOptions = {}) {
  if (!config.apiKey || !config.baseUrl || !config.model) throw new AppError("先连接模型，就可以开始这段对话了。", 409, "not_configured");
  const baseUrl = validateEndpoint(config.baseUrl);
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({ model: config.model, messages: check ? [{ role: "user", content: "请回复：连接成功。" }] : [{ role: "system", content: options.system ?? SYSTEM_PROMPT }, ...messages], stream, max_tokens: check ? 64 : 1800, ...(options.tools?.length ? { tools: options.tools, tool_choice: "auto" } : {}), ...(options.json ? { response_format: { type: "json_object" } } : {}) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(30_000),
      redirect: "error",
      cache: "no-store",
    });
  } catch (error) {
    if (signal?.aborted) throw new AppError("已停止本次生成，内容尚未保存。", 499, "aborted");
    if ((error as Error).name === "TimeoutError") throw new AppError("等待模型响应超时，请稍后重试。", 504, "timeout");
    throw new AppError("暂时连不上模型服务，请检查接口地址和网络后重试。", 502, "network_error");
  }
  if (!response.ok) { await response.body?.cancel(); throw upstreamError(response.status); }
  return response;
}

export async function completeModel(config: ModelConfig, messages: ModelMessage[], options: ModelOptions, signal: AbortSignal): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const response = await callModel(config, messages, false, signal, false, options);
  let data;
  try { data = await response.json(); } catch { throw new AppError("模型返回格式异常，请重试。", 502); }
  const choice = data.choices?.[0];
  if (!choice || !["stop", "tool_calls"].includes(choice.finish_reason)) throw new AppError("模型回复未完整返回，请重试。", 502);
  const content = choice.message?.content ?? "";
  const toolCalls = choice.message?.tool_calls ?? [];
  if (typeof content !== "string" || content.length > 30_000 || !Array.isArray(toolCalls) || toolCalls.length > 8) throw new AppError("模型返回格式异常，请重试。", 502);
  for (const tool of toolCalls) {
    if (tool.type !== "function" || typeof tool.id !== "string" || typeof tool.function?.name !== "string" || typeof tool.function?.arguments !== "string" || tool.function.arguments.length > 12_000) throw new AppError("模型工具请求格式异常，请重试。", 502);
  }
  if (!content.trim() && !toolCalls.length) throw new AppError("模型未返回回复，请重试。", 502);
  return { content, toolCalls };
}
