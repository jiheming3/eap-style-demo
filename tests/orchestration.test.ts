import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgents } from "../lib/agents.ts";
import { checkTurnResult } from "../lib/result-checks.ts";
import { executionPacket, routingPacket, needsConversationContext, CONTEXT_CHARACTER_LIMIT } from "../lib/context-packets.ts";
import { finishLedgerTurn, loadLedger, prepareTasks, updateTask, scopeAttachments } from "../lib/task-ledger.ts";
import { demoExperts, seedDemoAccount } from "../lib/demo-data.ts";
import { executeDemoTool } from "../lib/demo-tools.ts";
import type { DemoContext, TaskLedger } from "../lib/demo-types.ts";
import type { Message } from "../lib/types.ts";
import { createServer } from "node:http";
import { once } from "node:events";

const now = new Date().toISOString();
const message = (id: string, role: Message["role"], content: string, extra: Partial<Message> = {}): Message => ({ id, role, content, createdAt: now, ...extra });
function context(): DemoContext {
  const account = seedDemoAccount();
  return { owner: "unit", sessionId: "session", turnId: "new-turn", account, exerciseStates: account.exercises, latestUserContent: "", baseVersion: 0, dirty: false, storageRoot: "" };
}
function ledger(): TaskLedger { return { schemaVersion: 1, tasks: [], lastAgents: [] }; }

test("routing is current-only for independent requests and expands from task references without a fixed turn count", () => {
  const ctx = context(), state = ledger();
  const task = prepareTasks(state, [{ agent: "counselor_matching", task: "找预算200以内的咨询师" }], "u1")[0];
  const history = [message("u1", "user", "工作压力，预算200以内"), message("a1", "assistant", "哪天方便？"), message("private", "user", "UNRELATED_ORDER_SECRET"), message("private-reply", "assistant", "UNRELATED_ORDER_SECRET_REPLY")];
  task.messageIds.push("a1");
  const fast = routingPacket(history, state, "查一下ORD-1002的扣款", 0, ctx);
  assert.deepEqual(fast.messages, []);
  assert.ok(!JSON.stringify(fast.state).includes("UNRELATED"));
  assert.equal(needsConversationContext("换一批，预算不变"), true);
  assert.equal(needsConversationContext("周六吧"), true);
  const expanded = routingPacket(history, state, "沿用预算找工作压力咨询师", 2, ctx, ["counselor_matching"]);
  assert.ok(expanded.messages.some((item) => item.id === "u1"));
  assert.ok(!expanded.messages.some((item) => item.id === "private"));
});

test("specialists receive only their task messages, and original specialist replies replace mixed Composer history", () => {
  const ctx = context(), state = ledger();
  const [matching, customer] = prepareTasks(state, [{ agent: "counselor_matching", task: "匹配" }, { agent: "customer_service", task: "查订单" }], "u1");
  const history = [message("u1", "user", "想找咨询师"), message("a1", "assistant", "SHARED_FINANCIAL_DETAILS", { agentResponses: [{ agent: "counselor_matching", taskId: matching.id, content: "你希望哪天咨询？" }, { agent: "customer_service", taskId: customer.id, content: "PRIVATE_PAYMENT_DETAILS" }] }), message("u2", "user", "PRIVATE_OTHER_TOPIC")];
  matching.messageIds.push("a1"); customer.messageIds.push("u2");
  const packet = executionPacket(history, matching, "周六", ctx);
  assert.ok(JSON.stringify(packet.messages).includes("你希望哪天咨询"));
  assert.ok(!packet.messages.some((item) => item.id === "u2"));
  assert.ok(!packet.messages.some((item) => item.content.includes("PRIVATE_PAYMENT")));
  const longHistory = Array.from({ length: 30 }, (_, index) => message(`long-${index}`, "user", `主题${index} ${"文字".repeat(500)}`));
  matching.messageIds = longHistory.map((item) => item.id);
  const bounded = executionPacket(longHistory, matching, "主题20", ctx);
  assert.ok(bounded.diagnostics.truncated);
  assert.ok(bounded.messages.reduce((size, item) => size + item.content.length, 0) < CONTEXT_CHARACTER_LIMIT);
});

test("task ledger pauses other work, restores a referenced task and commits assistant links without mutating the saved snapshot", () => {
  const ctx = context(), state = ledger();
  const matching = prepareTasks(state, [{ agent: "counselor_matching", task: "匹配咨询师" }], "u1")[0];
  matching.localState.matching = { criteria: { topic: "工作压力", gender: "女", maxPrice: 200 }, batch: 0, status: "collecting", expertIds: [] };
  prepareTasks(state, [{ agent: "psychological_support", task: "先聊聊" }], "u2");
  assert.equal(matching.status, "paused");
  const [resumed] = prepareTasks(state, [{ agent: "counselor_matching", task: "回到匹配", taskId: matching.id, mode: "continue" }], ctx.turnId!);
  assert.equal(resumed.id, matching.id); assert.equal(resumed.localState.matching?.criteria.maxPrice, 200);
  ctx.account.sessions = [{ id: ctx.sessionId, title: "测试", scenarioId: null, createdAt: now, updatedAt: now, messages: [], feedback: {}, ledger: structuredClone(state) }];
  const staged = loadLedger(ctx, []); staged.tasks[0].status = "completed";
  assert.equal(ctx.account.sessions[0].ledger!.tasks[0].status, "active");
  ctx.ledger = staged;
  const finished = finishLedgerTurn(ctx, message("assistant-new", "assistant", "完成"));
  assert.ok(finished.tasks[0].messageIds.includes("assistant-new"));
  assert.throws(() => prepareTasks(state, [{ agent: "appointment", task: "错误引用", taskId: matching.id }], "bad"), /无效任务/);
});

test("matching tools inherit unmodified preferences from local state while honoring a new period", async () => {
  const ctx = context();
  const date = demoExperts()[0].slots[2].startsAt.slice(0, 10);
  ctx.matchingCriteria = { topic: "工作压力", date, timeStart: "18:00", timeEnd: "23:59", format: "线上咨询", gender: "女", maxPrice: 200 };
  const executed = await executeDemoTool(ctx, "counselor_matching", "search_experts", { timeStart: "12:00", timeEnd: "18:00" });
  const attachment = executed.attachments[0]; assert.equal(attachment.kind, "experts");
  if (attachment.kind !== "experts") return;
  assert.equal(attachment.criteria?.maxPrice, 200); assert.equal(attachment.criteria?.gender, "女");
  assert.equal(attachment.criteria?.timeStart, "12:00");
  assert.deepEqual(attachment.experts.map((expert) => expert.id), ["EXP-101"]);
});

test("card scope and result checks reject foreign tasks and preserve exact confirmation or tool times", () => {
  const ctx = context(); ctx.taskId = "task-a";
  const attachment = scopeAttachments([{ id: "attachment", kind: "orders", orders: [] }], ctx, "customer_service", "query_my_orders")[0];
  const result = { agent: "customer_service" as const, taskId: "task-a", reply: "请确认退款申请。", attachments: [attachment], facts: [], pendingConfirmation: true };
  assert.equal(checkTurnResult("退款申请已提交", [result], ctx.turnId!).answer, result.reply);
  assert.equal(checkTurnResult("19:30可约", [{ ...result, pendingConfirmation: false }], ctx.turnId!).answer, result.reply);
  assert.throws(() => checkTurnResult("完成", [{ ...result, taskId: "foreign" }], ctx.turnId!), /归属/);
});

test("runAgents expands context only on demand, resumes saved matching state and scopes every card", async (t) => {
  process.env.EAP_TEST_UPSTREAM = "1";
  const ctx = context(), state = ledger();
  const task = prepareTasks(state, [{ agent: "counselor_matching", task: "匹配工作压力咨询师" }], "original")[0];
  const date = demoExperts()[0].slots[2].startsAt.slice(0, 10);
  task.localState.matching = { criteria: { topic: "工作压力", date, timeStart: "18:00", timeEnd: "23:59", format: "线上咨询", gender: "女", maxPrice: 200 }, status: "collecting", expertIds: [], batch: 0 };
  const history = [message("original", "user", "工作压力，预算200以内，女咨询师，线上"), message("reply", "assistant", "希望哪天？"), message("other", "user", "UNRELATED_SECRET"), message("other-reply", "assistant", "UNRELATED_SECRET_REPLY")];
  task.messageIds.push("reply");
  ctx.account.sessions = [{ id: ctx.sessionId, title: "继续匹配", scenarioId: null, createdAt: now, updatedAt: now, messages: history, feedback: {}, ledger: state }];
  const requests: { messages: { role: string; content: string }[] }[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    const system = body.messages[0].content;
    let content = "处理完成";
    let choice;
    if (system.includes("调度阶段")) {
      content = system.includes("级别L2") ? JSON.stringify({ urgent: false, delegations: [{ agent: "counselor_matching", task: "改成下午", taskId: task.id, mode: "continue" }] }) : JSON.stringify({ urgent: false, needsContext: true, contextAgents: ["counselor_matching"], delegations: [] });
    } else if (body.messages.at(-1).role !== "tool") choice = { finish_reason: "tool_calls", message: { content: null, tool_calls: [{ id: "call1", type: "function", function: { name: "search_experts", arguments: JSON.stringify({ date, timeStart: "12:00", timeEnd: "18:00" }) } }] } };
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [choice ?? { finish_reason: "stop", message: { content } }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { delete process.env.EAP_TEST_UPSTREAM; server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  ctx.latestUserContent = "接着办理";
  const result = await runAgents({ config: { model: "test", apiKey: "DISPOSABLE", baseUrl: `http://127.0.0.1:${address.port}/v1` }, context: ctx, history, content: ctx.latestUserContent, signal: new AbortController().signal, status: () => {} });
  assert.equal(requests[0].messages.length, 2);
  assert.equal(result.trace[0].context?.level, 2);
  const specialist = requests.find((item) => item.messages[0].content.includes("你是咨询师匹配智能体"))!;
  assert.ok(!JSON.stringify(specialist).includes("UNRELATED_SECRET"));
  assert.ok(result.attachments.every((attachment) => attachment.scope?.taskId === task.id && attachment.scope?.turnId === ctx.turnId));
  assert.equal(ctx.ledger!.tasks.find((item) => item.id === task.id)!.localState.matching?.criteria.maxPrice, 200);
});
