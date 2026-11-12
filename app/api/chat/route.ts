import { randomUUID } from "node:crypto";
import { markVerified, readConfig } from "@/lib/config";
import { AppError, errorResponse } from "@/lib/errors";
import { assertLocalRequest, readBody } from "@/lib/guard";
import { runAgents } from "@/lib/agents";
import { createDemoContext } from "@/lib/demo-tools";
import { requireSession, serialize, workspace, lockWorkspace, commitTurn } from "@/lib/store";
import type { ChatEvent, Message } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    assertLocalRequest(request);
    const body = await readBody(request);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!content || content.length > 6000) throw new AppError("请输入 1—6000 字的内容。");
    const owner = await workspace();
    const session = await requireSession(owner, body.sessionId);
    if (session.busy) throw new AppError("上一条回复还在生成，请稍候或先停止生成。", 409);
    if (session.messages.length >= 120 || session.messages.reduce((n, m) => n + m.content.length, content.length) > 100_000) throw new AppError("这段对话已经比较长了，请先导出记录，再开启新对话。", 413);
    const unlock = lockWorkspace(owner);
    const lock = randomUUID(); session.busy = lock;
    release = () => { if (session.busy === lock) session.busy = null; unlock(); };
    const config = await readConfig();
    if (!config.apiKey || !config.baseUrl) throw new AppError("先连接模型，就可以开始对话了。", 409);
    const abort = new AbortController();
    const signal = AbortSignal.any([request.signal, abort.signal, AbortSignal.timeout(240_000)]);
    const user: Message = { id: randomUUID(), role: "user", content, createdAt: new Date().toISOString() };
    const assistantId = randomUUID();
    const encoder = new TextEncoder();
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const emit = (event: ChatEvent) => { if (!canceled) controller.enqueue(encoder.encode(JSON.stringify(event) + "\n")); };
        try {
          emit({ type: "start", user, assistantId });
          const context = await createDemoContext(owner, session.id);
          context.latestUserContent = content;
          context.turnId = user.id;
          const result = await runAgents({ config, history: session.messages, content, context, signal, status: (agent, label) => emit({ type: "status", agent, label }) });
          signal.throwIfAborted();
          const assistant: Message = { id: assistantId, role: "assistant", content: result.answer, createdAt: new Date().toISOString(), model: config.model, attachments: result.attachments, trace: result.trace, ...("agentResponses" in result ? { agentResponses: result.agentResponses } : {}) };
          await commitTurn(session, user, assistant, context);
          markVerified(config);
          emit({ type: "delta", text: result.answer });
          emit({ type: "done", session: serialize(session) });
        } catch (error) {
          const message = signal.aborted ? "已停止或等待超时，未完成的本轮没有保存，可以重试。" : error instanceof AppError ? error.message : "本轮处理未完成，本轮变更尚未保存，可以重试。";
          emit({ type: "error", message });
        } finally {
          abort.abort(); release?.();
          if (!canceled) controller.close();
        }
      },
      cancel() { canceled = true; abort.abort(); },
    });
    return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store, no-transform", "X-Content-Type-Options": "nosniff" } });
  } catch (error) { release?.(); return errorResponse(error); }
}
