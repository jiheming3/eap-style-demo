import { AppError, errorResponse } from "@/lib/errors";
import { assertLocalRequest, readBody } from "@/lib/guard";
import { requireSession, serialize, workspace, saveFeedback } from "@/lib/store";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    assertLocalRequest(request);
    const body = await readBody(request);
    const session = await requireSession(await workspace(), (await context.params).id);
    if (body.rating !== "good" && body.rating !== "adjust") throw new AppError("请选择反馈类型。");
    if (typeof body.messageId !== "string" || !session.messages.some((message) => message.id === body.messageId && message.role === "assistant")) throw new AppError("没有找到这条模型回复。", 404);
    const note = typeof body.note === "string" ? body.note.trim() : "";
    if (note.length > 2000) throw new AppError("反馈内容请控制在 2000 字以内。");
    await saveFeedback(session, body.messageId, { rating: body.rating, note, updatedAt: new Date().toISOString() });
    return Response.json(serialize(session));
  } catch (error) { return errorResponse(error); }
}
