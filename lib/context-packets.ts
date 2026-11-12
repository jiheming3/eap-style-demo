import type { AgentId, AgentTask, DemoContext, TaskLedger } from "./demo-types.ts";
import type { AgentTrace, Message } from "./types.ts";

export const CONTEXT_CHARACTER_LIMIT = 16_000;
const REFERENCE = /这个|那个|这位|那位|刚才|刚刚|之前|上次|回到|继续|换一批|换成|改成|改到|不变|沿用|原来|还是|依然|更严重|其余|其他条件|第一位|第二位|最后一位|再说|稍后|先聊/;
const RISK = /自杀|自伤|伤害自己|轻生|割腕|跳楼|吞药|结束生命|不想活|急救/;
export function needsConversationContext(content: string) {
  if (REFERENCE.test(content)) return true;
  if (/^(?:好|好的|嗯|可以|确认|同意|继续|就这个|谢谢)[。！!？?]*$/.test(content.trim())) return true;
  return !/咨询师|预约|订单|退款|权益|冥想|音频|练习|焦虑|压力|睡眠|睡不着|情绪/.test(content)
    && /周[一二三四五六日天末]|星期|明天|后天|上午|下午|晚上|预算|以内|线上|线下|\d{1,2}[:：点]|\d{4}-\d{2}-\d{2}/.test(content);
}

export function safetyContext(history: Message[]) {
  const risk = history.findLast((message) => message.role === "user" && RISK.test(message.content));
  return risk ? { messageId: risk.id, createdAt: risk.createdAt, content: risk.content.slice(0, 1500), note: "历史表达，仅供本轮风险判断，不等于当前结论；以最新消息为准。" } : undefined;
}

function terms(content: string) {
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  return new Set([...segmenter.segment(content)].filter((part) => part.isWordLike && part.segment.length > 1).map((part) => part.segment));
}

function digest(message: Message | undefined) {
  return message?.attachments?.map((attachment) => {
    if (attachment.kind === "experts") return { kind: attachment.kind, id: attachment.id, criteria: attachment.criteria, batch: attachment.batch, experts: attachment.experts.map((expert) => ({ id: expert.id, name: expert.name, slots: expert.slots })) };
    if (attachment.kind === "availability") return attachment;
    if (attachment.kind === "bookings") return { kind: attachment.kind, bookings: attachment.bookings.map(({ id, expertId, expertName, startsAt, format, status }) => ({ id, expertId, expertName, startsAt, format, status })) };
    if (attachment.kind === "orders") return { kind: attachment.kind, orderIds: attachment.orders.map((order) => order.id) };
    if (attachment.kind === "exercise") return attachment;
    return { kind: attachment.kind, resourceId: attachment.resource.id, title: attachment.resource.title };
  });
}

export type ContextPacket = {
  messages: Message[]; state: Record<string, unknown>;
  diagnostics: NonNullable<AgentTrace["context"]>;
};

function packet(candidates: Message[], state: Record<string, unknown>, level: number, reason: string, query: string, budget = CONTEXT_CHARACTER_LIMIT): ContextPacket {
  const queryTerms = terms(query);
  let length = JSON.stringify(state).length;
  const scored = candidates.map((message, index) => ({ message, index, score: [...terms(message.content)].filter((term) => queryTerms.has(term)).length + (/别再|不要再|不是|不对|不想|停止|纠正/.test(message.content) ? 1 : 0) }));
  const selected: typeof scored = [];
  for (const candidate of scored.sort((a, b) => b.score - a.score || b.index - a.index)) {
    if (length + candidate.message.content.length > budget) continue;
    selected.push(candidate); length += candidate.message.content.length;
  }
  const messages = selected.sort((a, b) => a.index - b.index).map(({ message }) => message);
  return { messages, state, diagnostics: { level, reason, messageIds: messages.map((message) => message.id), estimatedTokens: Math.ceil(length / 1.5), truncated: messages.length < candidates.length } };
}

export function routingPacket(history: Message[], ledger: TaskLedger, query: string, level: number, context: DemoContext, agents?: AgentId[]): ContextPacket {
  const safety = safetyContext(history);
  if (level === 0) return packet([], safety ? { safety } : {}, 0, "当前问题可独立判断", query);
  const tasks = [] as AgentTask[];
  let stateSize = 0;
  for (const task of [...ledger.tasks].reverse()) {
    if (agents?.length ? !agents.includes(task.agent) : task.status === "completed" || task.status === "cancelled") continue;
    const size = JSON.stringify(task.localState).length + Math.min(task.instruction.length, 500) + 200;
    if (stateSize + size > 4000) continue;
    tasks.unshift(task); stateSize += size;
  }
  const state = { tasks: tasks.map(({ id, agent, instruction, status, localState }) => ({ id, agent, instruction: instruction.slice(0, 500), status, localState })), lastAgents: ledger.lastAgents, pendingAction: context.initialPendingAction, latestCards: digest(history.findLast((message) => message.role === "assistant")), safety };
  if (level === 1) {
    const lastAssistant = history.findLastIndex((message) => message.role === "assistant");
    return packet(lastAssistant < 0 ? [] : history.slice(Math.max(0, lastAssistant - 1), lastAssistant + 1), state, level, "指代、省略或任务延续", query, 6_000);
  }
  const ids = new Set(tasks.flatMap((task) => task.messageIds));
  const queryTerms = terms(query);
  const relevant = history.filter((message) => ids.has(message.id) || [...terms(message.content)].some((term) => queryTerms.has(term)));
  return packet(relevant, state, level, "路由请求补充相关任务原文", query);
}

export function executionPacket(history: Message[], task: AgentTask, query: string, context: DemoContext, relatedMatching?: AgentTask): ContextPacket {
  const state: Record<string, unknown> = { taskId: task.id, taskStatus: task.status, localState: task.localState };
  if (task.agent === "appointment") {
    state.pendingAction = context.initialPendingAction?.action !== "refund" ? context.initialPendingAction : undefined;
    state.matching = context.currentExperts ? relatedMatching?.localState.matching : undefined;
    state.selectedCandidates = context.currentExperts ? { criteria: context.currentExperts.criteria, experts: context.currentExperts.experts.map(({ id, name, slots }) => ({ id, name, slots })) } : undefined;
    state.selectedExpertId = context.selectedExpertId;
  }
  if (task.agent === "customer_service" && context.initialPendingAction?.action === "refund") state.pendingAction = context.initialPendingAction;
  if (task.agent === "counselor_matching") state.currentCriteria = task.localState.matching?.criteria;
  if (task.agent === "psychological_support") {
    state.safety = safetyContext(history);
    state.exercise = context.account.exercises[context.sessionId];
  }
  const ids = new Set(task.messageIds);
  const candidates = history.filter((message) => ids.has(message.id)).flatMap((message) => {
    if (message.role === "user") return [message];
    const own = message.agentResponses?.find((response) => response.agent === task.agent);
    if (own) return [{ ...message, content: own.content }];
    const agents = new Set(message.trace?.filter((trace) => trace.agent !== "main").map((trace) => trace.agent));
    return agents.size <= 1 ? [message] : [];
  });
  return packet(candidates, state, candidates.length ? 2 : 0, candidates.length ? "仅本任务的相关消息和局部状态" : "当前问题与本任务状态已足够", query, task.agent === "psychological_support" ? CONTEXT_CHARACTER_LIMIT : 10_000);
}
