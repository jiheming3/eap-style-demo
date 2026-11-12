import { randomUUID } from "node:crypto";
import { AppError } from "./errors.ts";
import type { AgentId, AgentTask, DemoAttachment, DemoContext, TaskLedger } from "./demo-types.ts";
import type { Message } from "./types.ts";

export type ToolEvent = { tool: string; args: Record<string, unknown>; result: unknown; attachments: DemoAttachment[] };
export type Delegation = { agent: AgentId; task: string; taskId?: string; mode?: "new" | "continue" };
export const isOpenTask = (task: AgentTask) => task.status !== "completed" && task.status !== "cancelled";

export function loadLedger(context: DemoContext, history: Message[]): TaskLedger {
  const saved = context.account.sessions.find((session) => session.id === context.sessionId)?.ledger;
  if (saved) {
    if (saved.schemaVersion !== 1 || !Array.isArray(saved.tasks) || !Array.isArray(saved.lastAgents) || saved.tasks.some((task) => !task.id || !Array.isArray(task.messageIds) || !task.localState)) throw new AppError("本地任务状态格式异常，请检查账户文件。", 500);
    return structuredClone(saved);
  }
  const ledger: TaskLedger = { schemaVersion: 1, tasks: [], lastAgents: [] };
  // Old sessions gain task indexes from their recorded tool traces; original messages stay intact.
  for (let index = 0; index < history.length; index++) {
    const message = history[index];
    if (message.role !== "assistant") continue;
    const agents = [...new Set((message.trace ?? []).map((trace) => trace.agent).filter((agent): agent is AgentId => agent !== "main"))];
    if (!agents.length && message.attachments?.some((item) => item.kind === "experts" || item.kind === "availability")) agents.push("counselor_matching");
    for (const agent of agents) {
      let task = ledger.tasks.findLast((item) => item.agent === agent && isOpenTask(item));
      if (!task) { task = newTask(agent, "根据本任务的原始消息继续处理", message.createdAt); ledger.tasks.push(task); }
      task.messageIds.push(...(history[index - 1]?.role === "user" ? [history[index - 1].id] : []), message.id);
      task.updatedAt = message.createdAt;
      const attachments = message.attachments?.filter((item) => belongsToAgent(item, agent)) ?? [];
      for (const attachment of attachments) applyAttachment(task, attachment);
    }
    if (agents.length) ledger.lastAgents = agents;
  }
  return ledger;
}

function belongsToAgent(attachment: DemoAttachment, agent: AgentId) {
  if (attachment.scope) return attachment.scope.agent === agent;
  return agent === "counselor_matching" && ["experts", "availability"].includes(attachment.kind) || agent === "appointment" && attachment.kind === "bookings" || agent === "customer_service" && attachment.kind === "orders" || agent === "psychological_support" && ["resource", "exercise"].includes(attachment.kind);
}

function newTask(agent: AgentId, instruction: string, now = new Date().toISOString()): AgentTask {
  return { id: randomUUID(), agent, instruction, status: "active", createdAt: now, updatedAt: now, messageIds: [], localState: {} };
}

export function prepareTasks(ledger: TaskLedger, delegations: Delegation[], turnId: string) {
  const tasks = delegations.map((delegation) => {
    const referenced = delegation.taskId ? ledger.tasks.find((task) => task.id === delegation.taskId && task.agent === delegation.agent && task.status !== "cancelled") : undefined;
    if (delegation.taskId && !referenced) throw new AppError("本轮引用了无效任务，请重试。", 502);
    let task = delegation.mode === "new" ? undefined : referenced ?? ledger.tasks.findLast((task) => task.agent === delegation.agent && isOpenTask(task));
    if (!task) { task = newTask(delegation.agent, delegation.task); ledger.tasks.push(task); }
    task.instruction = delegation.task;
    task.status = "active";
    task.updatedAt = new Date().toISOString();
    task.messageIds = [...new Set([...task.messageIds, turnId])];
    return task;
  });
  for (const task of ledger.tasks) if (isOpenTask(task) && !tasks.includes(task)) task.status = "paused";
  ledger.lastAgents = tasks.map((task) => task.agent);
  ledger.lastTurnId = turnId;
  return tasks;
}

export function applyTaskControls(context: DemoContext, ledger: TaskLedger, content: string) {
  if (/不约了|不找咨询师了|取消匹配|放弃预约/.test(content)) {
    for (const task of ledger.tasks) if (["counselor_matching", "appointment"].includes(task.agent) && isOpenTask(task)) { task.status = "cancelled"; if (task.localState.matching) task.localState.matching.status = "closed"; }
    if (["book", "move"].includes(context.initialPendingAction?.action ?? "")) {
      delete context.account.pendingActions[context.sessionId]; context.initialPendingAction = undefined; context.dirty = true;
    }
  }
}

export function taskCard(task: AgentTask | undefined, history: Message[]) {
  const id = task?.localState.matching?.attachmentId;
  if (!id) return undefined;
  return history.flatMap((message) => message.attachments ?? []).find((attachment) => attachment.id === id && attachment.kind === "experts") as Extract<DemoAttachment, { kind: "experts" }> | undefined;
}

export function scopeAttachments(attachments: DemoAttachment[], context: DemoContext, agent: AgentId, purpose: string) {
  if (!context.turnId || !context.taskId) return attachments;
  return attachments.map((attachment) => ({ ...attachment, scope: { turnId: context.turnId!, taskId: context.taskId!, agent, purpose, status: "current" as const } }));
}

function applyAttachment(task: AgentTask, attachment: DemoAttachment) {
  if (attachment.kind === "experts" || attachment.kind === "availability") {
    const prior = task.localState.matching;
    task.localState.matching = { criteria: { ...prior?.criteria, ...attachment.criteria }, batch: attachment.kind === "experts" ? attachment.batch ?? 0 : 0, status: attachment.kind === "experts" ? "presented" : "collecting", expertIds: attachment.kind === "experts" ? attachment.experts.map((expert) => expert.id) : [], attachmentId: attachment.kind === "experts" ? attachment.id : undefined };
    task.status = "waiting_input";
  }
  if (attachment.kind === "bookings") {
    const booking = attachment.bookings[0];
    task.localState.appointment = { ...(booking ? { expertId: booking.expertId, slotId: booking.slotId, bookingId: booking.id } : {}), status: "completed" };
    task.status = "completed";
  }
  if (attachment.kind === "orders") { task.localState.customerService = { orderId: attachment.orders.length === 1 ? attachment.orders[0].id : undefined }; task.status = "completed"; }
  if (attachment.kind === "exercise") task.status = attachment.exercise.status === "active" ? "active" : "completed";
}

export function updateTask(task: AgentTask, events: ToolEvent[], content: string) {
  task.status = task.agent === "psychological_support" ? /先这样|再见|不聊了|今天到这/.test(content) ? "completed" : "active" : "waiting_input";
  for (const event of events) {
    const result = event.result as Record<string, unknown>;
    if (result.error) continue;
    for (const attachment of event.attachments) applyAttachment(task, attachment);
    if (["check_consultation_availability", "search_experts"].includes(event.tool)) {
      const prior = task.localState.matching;
      task.localState.matching = { criteria: structuredClone((result.criteria ?? prior?.criteria ?? {}) as NonNullable<typeof prior>["criteria"]), batch: typeof result.batch === "number" ? result.batch : prior?.batch ?? 0, status: event.tool === "search_experts" && result.found !== 0 ? "presented" : "collecting", expertIds: prior?.expertIds ?? [], ...(prior?.attachmentId && result.available !== false && result.found !== 0 ? { attachmentId: prior.attachmentId } : {}) };
      if (result.available === false || result.found === 0) task.localState.matching.expertIds = [];
      task.status = "waiting_input";
    }
    if (event.tool === "get_expert_slots") task.localState.appointment = { expertId: event.args.expertId as string, status: "selecting" };
    if (result.confirmationRequired) {
      task.status = "waiting_confirmation";
      if (task.agent === "appointment") task.localState.appointment = { ...task.localState.appointment, expertId: event.args.expertId as string | undefined ?? task.localState.appointment?.expertId, slotId: event.args.slotId as string | undefined, bookingId: event.args.bookingId as string | undefined, status: "waiting_confirmation" };
      if (task.agent === "customer_service") task.localState.customerService = { orderId: event.args.orderId as string, waitingConfirmation: true };
    }
    if (event.tool === "get_my_profile") task.status = "completed";
  }
  task.updatedAt = new Date().toISOString();
}

export function finishLedgerTurn(context: DemoContext, assistant: Message) {
  const session = context.account.sessions.find((item) => item.id === context.sessionId);
  const ledger = context.ledger ?? loadLedger(context, session?.messages ?? []);
  if (!context.ledger && assistant.attachments?.length) {
    const agent = assistant.trace?.find((trace) => trace.agent !== "main")?.agent;
    if (agent && agent !== "main") {
      const task = prepareTasks(ledger, [{ agent, task: "处理当前卡片操作" }], context.turnId ?? assistant.id)[0];
      assistant.attachments = scopeAttachments(assistant.attachments, { ...context, taskId: task.id }, agent, "card_action");
      for (const attachment of assistant.attachments) applyAttachment(task, attachment);
      if (agent === "appointment") {
        const offered = session?.messages.findLast((message) => message.role === "assistant")?.attachments?.find((attachment) => attachment.kind === "experts");
        const prior = ledger.tasks.findLast((item) => item.agent === "counselor_matching" && (offered?.scope ? item.id === offered.scope.taskId : item.localState.matching?.attachmentId === offered?.id));
        if (prior) { prior.status = "completed"; if (prior.localState.matching) prior.localState.matching.status = "closed"; }
      }
    }
  }
  for (const task of ledger.tasks) if (ledger.lastTurnId === context.turnId && task.messageIds.includes(ledger.lastTurnId ?? "")) task.messageIds = [...new Set([...task.messageIds, assistant.id])];
  return ledger;
}
