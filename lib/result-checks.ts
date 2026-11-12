import { AppError } from "./errors.ts";
import type { AgentId, DemoAttachment } from "./demo-types.ts";

export function checkTurnResult(answer: string, results: { agent: AgentId; taskId: string; reply: string; attachments: DemoAttachment[]; facts: unknown[]; pendingConfirmation: boolean }[], turnId: string) {
  if (!answer.trim()) throw new AppError("本轮回复不完整，请重试。", 502);
  const attachments = results.flatMap((result) => result.attachments.map((attachment) => {
    const scope = attachment.scope;
    if (!scope || scope.turnId !== turnId || scope.taskId !== result.taskId || scope.agent !== result.agent || scope.status !== "current") throw new AppError("本轮卡片的任务归属异常，未保存本轮修改，请重试。", 502);
    return attachment;
  }));
  const pending = results.some((result) => result.pendingConfirmation);
  const falseCompletion = pending && /预约成功|改约完成|预约已取消|退款已到账|退款成功|退款申请已提交/.test(answer);
  const evidence = JSON.stringify(results.map((result) => result.facts));
  const timeTokens = answer.match(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g) ?? [];
  const unsupportedTime = timeTokens.some((time) => !evidence.includes(time) && !results.some((result) => result.reply.includes(time)));
  return { answer: falseCompletion || unsupportedTime ? results.map((result) => result.reply).join("\n\n") : answer, attachments };
}
