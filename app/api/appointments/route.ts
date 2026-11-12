import { randomUUID } from "node:crypto";
import { AppError, errorResponse } from "@/lib/errors";
import { assertLocalRequest, readBody } from "@/lib/guard";
import { createDemoContext, executeDemoTool } from "@/lib/demo-tools";
import { commitAssistantEvent, lockWorkspace, requireSession, serialize, workspace } from "@/lib/store";
import type { DemoBooking } from "@/lib/demo-types";
import type { Message } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bookingTime(value: string) {
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    assertLocalRequest(request);
    const body = await readBody(request);
    const expertId = typeof body.expertId === "string" ? body.expertId.trim() : "";
    const slotId = typeof body.slotId === "string" ? body.slotId.trim() : "";
    if (!/^EXP-[\w-]+$/.test(expertId) || !/^EXP-[\w-]+-\d{4}-\d{2}-\d{2}-\d{1,2}-(?:online|offline)$/.test(slotId)) throw new AppError("预约选项无效，请重新选择咨询师和时间。");
    const owner = await workspace();
    const session = await requireSession(owner, body.sessionId);
    if (session.busy) throw new AppError("上一条回复还在生成，请稍候再预约。", 409);
    const latestAssistant = session.messages.findLast((message) => message.role === "assistant");
    const offered = latestAssistant?.attachments?.find((attachment) => attachment.kind === "experts" && attachment.experts.some((expert) => expert.id === expertId && expert.slots.some((slot) => slot.id === slotId)));
    if (!offered) throw new AppError("这项预约不在当前咨询师卡片中，请重新匹配后选择。", 409);
    release = lockWorkspace(owner);
    const context = await createDemoContext(owner, session.id);
    context.latestUserContent = `从咨询师卡片确认预约 ${expertId} ${slotId}`;
    context.turnId = randomUUID();
    context.approvedAction = { action: "book", targetId: expertId, slotId };
    const executed = await executeDemoTool(context, "appointment", "book_appointment", { expertId, slotId });
    const booking = (executed.result as { booking?: DemoBooking }).booking;
    if (!booking) throw new AppError("预约没有完成，请重新选择时间。", 409);
    const assistant: Message = {
      id: randomUUID(),
      role: "assistant",
      content: `预约成功。已为你预约${booking.expertName}，${bookingTime(booking.startsAt)}，${booking.format}。你可以在下方预约卡片中查看。`,
      createdAt: new Date().toISOString(),
      model: "deterministic-card-action",
      attachments: executed.attachments,
      trace: [{ agent: "appointment", label: "预约智能体 · 卡片预约", status: "done", tools: ["book_appointment"] }],
    };
    await commitAssistantEvent(session, assistant, context);
    return Response.json({ session: serialize(session), booking });
  } catch (error) {
    return errorResponse(error);
  } finally {
    release?.();
  }
}
