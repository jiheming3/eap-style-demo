import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { isCapabilityIntroductionQuery, parsePlan, runAgents } from "../lib/agents.ts";
import { completeModel } from "../lib/provider.ts";
import { createServer } from "node:http";
import { once } from "node:events";
import { seedDemoAccount, demoExperts } from "../lib/demo-data.ts";
import { executeDemoTool } from "../lib/demo-tools.ts";
import { slotTime } from "../lib/appointment-time.ts";
import type { AgentId, DemoContext } from "../lib/demo-types.ts";
import type { Message } from "../lib/types.ts";

type RequestBody = { messages: { role: string; content: string }[]; tools?: unknown[] };
async function mockModel(t: TestContext, respond: (body: RequestBody) => object) {
  process.env.EAP_TEST_UPSTREAM = "1";
  const requests: RequestBody[] = [];
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ choices: [respond(body)] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { delete process.env.EAP_TEST_UPSTREAM; server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return { config: { apiKey: "TEST_ONLY", model: "test", baseUrl: `http://127.0.0.1:${address.port}/v1` }, requests };
}
const reply = (content: string) => ({ finish_reason: "stop", message: { content } });
const route = (agents: AgentId[]) => reply(JSON.stringify({ urgent: false, delegations: agents.map((agent) => ({ agent, task: "处理本轮明确需求" })) }));
const toolCalls = (calls: { name: string; args: object }[]) => ({ finish_reason: "tool_calls", message: { content: null, tool_calls: calls.map(({ name, args }, index) => ({ id: `call-${index}`, type: "function", function: { name, arguments: JSON.stringify(args) } })) } });
function contextFor(content: string): DemoContext {
  const account = seedDemoAccount();
  return { owner: "unit-test", sessionId: "session-a", latestUserContent: content, turnId: "turn-a", account, exerciseStates: account.exercises, baseVersion: 0, dirty: false, storageRoot: "" };
}
function run(config: Awaited<ReturnType<typeof mockModel>>["config"], content: string, context = contextFor(content), history: Message[] = []) {
  return runAgents({ config, content, context, history, signal: new AbortController().signal, status: () => {} });
}

test("capability introduction bypasses all models, specialists and cards without swallowing service or risk requests", async (t) => {
  const { config, requests } = await mockModel(t, () => { throw new Error("capability introduction must make zero requests"); });
  for (const query of ["你现在能帮我做什么呢？", "你能做些什么？", "你有什么功能？", "介绍一下你的服务", "怎么使用？"]) {
    assert.equal(isCapabilityIntroductionQuery(query), true, query);
    const result = await run(config, query);
    assert.deepEqual(result.attachments, []);
    assert.ok(result.trace.every((trace) => trace.agent === "main"));
    assert.match(result.answer, /情绪.*咨询师.*预约.*权益/);
  }
  for (const query of ["你能帮我预约咨询师吗？", "你能做什么？另外查下我的订单", "我想自杀，你能帮我做什么？", "你能帮我取消预约吗？"]) assert.equal(isCapabilityIntroductionQuery(query), false, query);
  assert.equal(requests.length, 0);
});

test("single specialist replies directly; multiple specialists invoke Composer exactly once", async (t) => {
  let agents: AgentId[] = ["psychological_support"];
  const { config, requests } = await mockModel(t, (body) => {
    const system = body.messages[0].content;
    if (system.includes("调度阶段")) return route(agents);
    if (system.includes("最终协调阶段")) return reply("合并后的回复");
    return reply(system.includes("你是客服智能体") ? "客服原文" : "心理支持原文");
  });
  const single = await run(config, "最近有些压力，想聊聊");
  assert.equal(single.answer, "心理支持原文");
  assert.equal(requests.length, 2);
  assert.equal(requests.filter((request) => request.messages[0].content.includes("最终协调阶段")).length, 0);
  agents = ["psychological_support", "customer_service"];
  const mixed = await run(config, "想聊聊压力，另外查一下权益");
  assert.equal(mixed.answer, "合并后的回复");
  assert.equal(requests.length, 6);
  assert.equal(requests.filter((request) => request.messages[0].content.includes("最终协调阶段")).length, 1);
});

test("semantic capability routing uses only the router for less common phrasing", async (t) => {
  const { config, requests } = await mockModel(t, () => reply(JSON.stringify({ urgent: false, general: true, delegations: [] })));
  const result = await run(config, "说说看，你都能帮我哪些忙呀");
  assert.equal(requests.length, 1);
  assert.deepEqual(result.attachments, []);
  assert.ok(result.trace.every((record) => record.agent === "main"));
  assert.match(result.answer, /情绪.*咨询师.*预约/);
  assert.throws(() => parsePlan(JSON.stringify({ urgent: true, general: true, delegations: [] })));
  assert.throws(() => parsePlan(JSON.stringify({ urgent: false, general: "true", delegations: [{ agent: "appointment", task: "预约" }] })));
});

test("selected counselor keeps the confirmed slots and suppresses unrelated canceled booking cards", async (t) => {
  const query = "我要约陈知宁这位咨询师";
  const context = contextFor(query);
  context.account.bookings[0].status = "cancelled";
  const criteria = { topic: "工作压力", date: demoExperts()[0].slots[0].startsAt.slice(0, 10), timeStart: "18:00", timeEnd: "18:59", format: "线上咨询", gender: "女", maxPrice: 200 };
  const found = await executeDemoTool(context, "counselor_matching", "search_experts", criteria);
  const history: Message[] = [{ id: "previous", role: "assistant", content: "找到陈知宁", createdAt: new Date().toISOString(), attachments: found.attachments }];
  const { config } = await mockModel(t, (body) => {
    if (body.messages[0].content.includes("调度阶段")) return route(["appointment"]);
    if (body.messages.at(-1)?.role === "tool") return reply("已找到上午08:00的时段");
    return toolCalls([{ name: "get_expert_slots", args: { expertId: "EXP-101" } }, { name: "list_my_bookings", args: { includeCancelled: true } }]);
  });
  const result = await run(config, query, context, history);
  assert.equal(result.attachments.length, 1);
  const selected = result.attachments[0]; assert.equal(selected.kind, "experts");
  if (selected.kind !== "experts") return;
  assert.deepEqual(selected.experts.map((expert) => expert.id), ["EXP-101"]);
  assert.deepEqual(selected.criteria, criteria);
  assert.ok(!result.answer.includes("08:00"));
  for (const slot of selected.experts[0].slots) assert.ok(result.answer.includes(slotTime(slot)));
});

test("target cancellation supersedes broad booking lookups, including a later lookup in the same turn", async (t) => {
  const query = "确认取消预约 APT-2001";
  const { config } = await mockModel(t, (body) => {
    if (body.messages[0].content.includes("调度阶段")) return route(["appointment"]);
    if (body.messages.at(-1)?.role === "tool") return reply("预约已取消");
    return toolCalls([{ name: "list_my_bookings", args: {} }, { name: "cancel_appointment", args: { bookingId: "APT-2001" } }, { name: "list_my_bookings", args: {} }]);
  });
  const result = await run(config, query);
  assert.equal(result.attachments.length, 1);
  const attachment = result.attachments[0]; assert.equal(attachment.kind, "bookings");
  if (attachment.kind === "bookings") {
    assert.deepEqual(attachment.bookings.map((booking) => booking.id), ["APT-2001"]);
    assert.equal(attachment.bookings[0].status, "cancelled");
  }
});

test("an explicit order target filters broad tool results", async (t) => {
  const { config } = await mockModel(t, (body) => {
    if (body.messages[0].content.includes("调度阶段")) return route(["customer_service"]);
    return body.messages.at(-1)?.role === "tool" ? reply("订单信息如下") : toolCalls([{ name: "query_my_orders", args: {} }]);
  });
  const result = await run(config, "查一下 ORD-1002 的扣款");
  assert.equal(result.attachments[0].kind, "orders");
  if (result.attachments[0].kind === "orders") assert.deepEqual(result.attachments[0].orders.map((order) => order.id), ["ORD-1002"]);
});

test("booking proposals use the exact tool slot and never claim completion from specialist prose", async (t) => {
  const expert = demoExperts()[1], slot = expert.slots[0];
  const { config } = await mockModel(t, (body) => {
    if (body.messages[0].content.includes("调度阶段")) return route(["appointment"]);
    return body.messages.at(-1)?.role === "tool" ? reply("已预约明早08:00") : toolCalls([{ name: "book_appointment", args: { expertId: expert.id, slotId: slot.id } }]);
  });
  const context = contextFor(`想约${expert.name}`);
  const result = await run(config, context.latestUserContent, context);
  assert.ok(result.answer.includes(slotTime(slot)));
  assert.match(result.answer, /请确认/);
  assert.ok(!result.answer.includes("08:00"));
  assert.equal(context.account.bookings.length, 1);
  const attachment = result.attachments[0]; assert.equal(attachment.kind, "experts");
  if (attachment.kind === "experts") assert.deepEqual(attachment.experts[0].slots, [slot]);
});

test("no availability stops further tool execution and replaces follow-up questions with a change-of-time prompt", async (t) => {
  const date = demoExperts()[0].slots[0].startsAt.slice(0, 10);
  const { config, requests } = await mockModel(t, (body) => {
    if (body.messages[0].content.includes("调度阶段")) return route(["counselor_matching"]);
    return toolCalls([
      { name: "check_consultation_availability", args: { date, timeStart: "08:00", timeEnd: "12:00" } },
      { name: "search_experts", args: { topic: "工作压力", date, timeStart: "18:00", timeEnd: "23:59", format: "线上咨询" } },
    ]);
  });
  const result = await run(config, "我只有明天上午有时间，想找咨询师");
  assert.equal(requests.length, 2);
  assert.deepEqual(result.attachments, []);
  assert.match(result.answer, /没有可约.*换个日期或时间/);
  assert.deepEqual(result.trace.find((record) => record.agent === "counselor_matching")?.tools, ["check_consultation_availability"]);
});

test("router validates specialist IDs, duplicates and empty plans; urgent route prioritizes safety", () => {
  for (const content of ["not json", "{}", '{"urgent":false,"delegations":[]}', '{"urgent":false,"delegations":[{"agent":"unknown","task":"test"}]}', '{"urgent":false,"delegations":[{"agent":"appointment","task":"x"},{"agent":"appointment","task":"y"}]}']) assert.throws(() => parsePlan(content));
  const plan = parsePlan(JSON.stringify({ urgent: true, delegations: [{ agent: "appointment", task: "预约" }] }));
  assert.deepEqual(plan.delegations.map((d) => d.agent), ["psychological_support"]);
});

test("native tool completions keep only public content, validate truncation and malformed tool calls", async (t) => {
  process.env.EAP_TEST_UPSTREAM = "1";
  let choice: unknown = { finish_reason: "tool_calls", message: { reasoning_content: "DO_NOT_EXPOSE", content: null, tool_calls: [{ id: "call1", type: "function", function: { name: "lookup", arguments: "{}" } }] } };
  const server = createServer(async (request, response) => {
    for await (const _ of request) { /* Drain payload. */ }
    response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [choice] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { delete process.env.EAP_TEST_UPSTREAM; server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const config = { apiKey: "TEST_ONLY", model: "test", baseUrl: `http://127.0.0.1:${address.port}/v1` };
  const completion = await completeModel(config, [{ role: "user", content: "test" }], {}, new AbortController().signal);
  assert.equal(completion.toolCalls[0].function.name, "lookup"); assert.ok(!JSON.stringify(completion).includes("DO_NOT_EXPOSE"));
  choice = { finish_reason: "length", message: { content: "partial" } };
  await assert.rejects(() => completeModel(config, [], {}, new AbortController().signal));
  choice = { finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "lookup" } }] } };
  await assert.rejects(() => completeModel(config, [], {}, new AbortController().signal));
});
