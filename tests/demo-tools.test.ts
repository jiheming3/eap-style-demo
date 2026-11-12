import assert from "node:assert/strict";
import { after, test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createDemoContext, commitDemoContext, demoOverview, executeDemoTool, toolsForAgent } from "../lib/demo-tools.ts";
import { demoExperts, demoResources, seedDemoAccount } from "../lib/demo-data.ts";
import type { AgentId, DemoContext } from "../lib/demo-types.ts";

const roots: string[] = [];
after(async () => { await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true }))); });
async function setup(owner = "owner-a", session = "session-a") {
  const storageRoot = await mkdtemp(join(tmpdir(), "eap-demo-test-"));
  roots.push(storageRoot);
  return createDemoContext(owner, session, { storageRoot });
}
const call = (context: DemoContext, agent: AgentId, name: string, args: Record<string, unknown> = {}) => executeDemoTool(context, agent, name, args);
async function reload(context: DemoContext, text: string, turnId = text) {
  const next = await createDemoContext(context.owner, context.sessionId, { storageRoot: context.storageRoot });
  next.latestUserContent = text;
  next.turnId = turnId;
  return next;
}

test("seed account has concrete payment records, EAP, experts and future booking", () => {
  const now = new Date("2026-11-12T09:00:00Z");
  const account = seedDemoAccount(now);
  assert.equal(account.profile.name, "林晓");
  assert.equal(account.profile.eap.remainingSessions, 4);
  assert.equal(account.orders.length, 3);
  const duplicate = account.orders.find((order) => order.id === "ORD-1002")!;
  assert.equal(duplicate.payments.reduce((sum, payment) => sum + payment.amount, 0), 600);
  assert.equal(duplicate.refund, null);
  assert.equal(account.bookings[0].id, "APT-2001");
  assert.ok(Date.parse(account.bookings[0].startsAt) > now.getTime());
  const experts = demoExperts(now);
  assert.deepEqual(experts.map((expert) => expert.price), [180, 260, 300, 420, 220, 320, 280, 360]);
  assert.ok(experts.every((expert) => expert.slots[0].startsAt.startsWith("2026-11-13")));
  assert.ok(experts.every((expert) => expert.slots.some((slot) => slot.format === "线上咨询") && expert.slots.some((slot) => slot.format === "线下咨询")));
});

test("account ownership is isolated and staged mutations do not leak before commit", async () => {
  const context = await setup();
  context.latestUserContent = "确认退款ORD-1002";
  await call(context, "customer_service", "request_duplicate_refund", { orderId: "ORD-1002" });
  assert.equal(context.account.orders[1].refund?.status, "processing");
  assert.equal((await reload(context, "查看")).account.orders[1].refund, null);
  await commitDemoContext(context);
  assert.equal((await reload(context, "查看")).account.orders[1].refund?.amount, 300);
  const other = await createDemoContext("owner-b", "session-a", { storageRoot: context.storageRoot });
  assert.equal(other.account.orders[1].refund, null);
  assert.equal(other.account.profile.id, context.account.profile.id);
  await assert.rejects(call(context, "customer_service", "query_my_orders", { userId: "owner-b" }), /不受支持/);
  await assert.rejects(call(context, "customer_service", "book_appointment", {}), /不能调用/);
});

test("refund requires a prior concrete proposal, not a model confirmation parameter or same-turn loop", async () => {
  let context = await setup();
  context.latestUserContent = "确认";
  const proposal = await call(context, "customer_service", "request_duplicate_refund", { orderId: "ORD-1002" });
  assert.equal((proposal.result as { confirmationRequired: boolean }).confirmationRequired, true);
  const repeated = await call(context, "customer_service", "request_duplicate_refund", { orderId: "ORD-1002" });
  assert.equal((repeated.result as { confirmationRequired: boolean }).confirmationRequired, true);
  await assert.rejects(call(context, "customer_service", "request_duplicate_refund", { orderId: "ORD-1002", confirmed: true }), /不受支持/);
  assert.equal(context.account.orders[1].refund, null);
  await commitDemoContext(context);
  context = await reload(context, "帮我查一下退款");
  await call(context, "customer_service", "request_duplicate_refund", { orderId: "ORD-1002" });
  assert.equal(context.account.orders[1].refund, null);
  context = await reload(context, "不要确认退款");
  await call(context, "customer_service", "request_duplicate_refund", { orderId: "ORD-1002" });
  assert.equal(context.account.orders[1].refund, null);
  context = await reload(context, "确认退款");
  await call(context, "customer_service", "request_duplicate_refund", { orderId: "ORD-1002" });
  await commitDemoContext(context);
  const retry = await call(context, "customer_service", "request_duplicate_refund", { orderId: "ORD-1002" });
  assert.equal((retry.result as { alreadyRequested: boolean }).alreadyRequested, true);
  assert.equal(context.account.orders[1].refund?.amount, 300);
});

test("counselor matching returns at most three per batch and keeps appointment tools isolated", async () => {
  const context = await setup();
  const date = demoExperts()[0].slots[0].startsAt.slice(0, 10);
  const result = await call(context, "counselor_matching", "search_experts", { topic: "情绪", date, format: "线上咨询", batch: 0 });
  assert.equal(result.attachments[0].kind, "experts");
  if (result.attachments[0].kind !== "experts") return;
  const experts = result.attachments[0].experts;
  assert.equal(experts.length, 3);
  assert.equal(result.attachments[0].batch, 0);
  assert.equal(result.attachments[0].hasMore, true);
  assert.ok(experts.every((expert) => expert.slots[0].format === "线上咨询" && expert.slots[0].startsAt.startsWith(date)));
  const booked = context.account.bookings[0];
  assert.ok(experts.every((expert) => expert.slots.every((slot) => slot.startsAt !== booked.startsAt)));
  const next = await call(context, "counselor_matching", "search_experts", { topic: "情绪", date, format: "线上咨询", batch: 1 });
  assert.equal(next.attachments[0].kind, "experts");
  if (next.attachments[0].kind !== "experts") return;
  assert.ok(next.attachments[0].experts.length > 0 && next.attachments[0].experts.length <= 3);
  assert.ok(next.attachments[0].experts.every((expert) => !experts.some((first) => first.id === expert.id)));
  await assert.rejects(call(context, "appointment", "search_experts", { topic: "情绪", date, format: "线上咨询" }), /不能调用/);
  await assert.rejects(call(context, "counselor_matching", "search_experts", { topic: "情绪", date, format: "线上咨询", maxPrice: -1 }), /预算/);
});

test("booking confirmation binds exact expert and slot, and retry does not consume another entitlement", async () => {
  let context = await setup();
  const expert = demoExperts()[1], slot = expert.slots[0];
  const args = { expertId: expert.id, slotId: slot.id };
  context.latestUserContent = "帮我约一位咨询师";
  const proposal = await call(context, "appointment", "book_appointment", args);
  assert.equal((proposal.result as { confirmationRequired: boolean }).confirmationRequired, true);
  assert.equal(context.account.bookings.length, 1);
  await commitDemoContext(context);
  context = await reload(context, "请看看这个预约");
  await call(context, "appointment", "book_appointment", args);
  assert.equal(context.account.bookings.length, 1);
  context = await reload(context, "确认预约EXP-103");
  await call(context, "appointment", "book_appointment", args);
  assert.equal(context.account.bookings.length, 1);
  context = await reload(context, "确认预约");
  const wrong = await call(context, "appointment", "book_appointment", { expertId: expert.id, slotId: expert.slots[1].id });
  assert.equal((wrong.result as { confirmationRequired: boolean }).confirmationRequired, true);
  assert.equal(context.account.bookings.length, 1);
  context = await reload(context, "确认预约");
  await call(context, "appointment", "book_appointment", args);
  assert.equal(context.account.bookings.length, 2);
  assert.equal(context.account.profile.eap.remainingSessions, 3);
  await call(context, "appointment", "book_appointment", args);
  assert.equal(context.account.bookings.length, 2);
  assert.equal(context.account.profile.eap.remainingSessions, 3);
  await commitDemoContext(context);
  assert.equal((await reload(context, "查预约")).account.bookings.length, 2);
});

test("overlap is rejected and cancellation only restores entitlement once", async () => {
  let context = await setup();
  const clash = demoExperts()[1].slots.find((slot) => slot.startsAt === context.account.bookings[0].startsAt)!;
  assert.ok(clash);
  context.latestUserContent = `确认预约EXP-102 ${clash.id}`;
  await assert.rejects(call(context, "appointment", "book_appointment", { expertId: "EXP-102", slotId: clash.id }), /冲突/);
  context.latestUserContent = "取消APT-2001";
  await call(context, "appointment", "cancel_appointment", { bookingId: "APT-2001" });
  assert.equal(context.account.profile.eap.remainingSessions, 5);
  await call(context, "appointment", "cancel_appointment", { bookingId: "APT-2001" });
  assert.equal(context.account.profile.eap.remainingSessions, 5);
  await commitDemoContext(context);
  context = await reload(context, "查看");
  assert.equal(context.account.bookings[0].status, "cancelled");
});

test("stale concurrent snapshots cannot overwrite already committed mutations", async () => {
  const first = await setup();
  const stale = await reload(first, "取消APT-2001");
  first.latestUserContent = "确认退款ORD-1002";
  await call(first, "customer_service", "request_duplicate_refund", { orderId: "ORD-1002" });
  await call(stale, "appointment", "cancel_appointment", { bookingId: "APT-2001" });
  await commitDemoContext(first);
  await assert.rejects(commitDemoContext(stale), /另一轮对话更新/);
  const loaded = await reload(first, "查看");
  assert.equal(loaded.account.orders[1].refund?.status, "processing");
  assert.equal(loaded.account.bookings[0].status, "confirmed");
});

test("exercise is opt-in, session-specific, advances once per turn and stops on refusal", async () => {
  let context = await setup();
  context.latestUserContent = "不做练习";
  await call(context, "psychological_support", "start_support_exercise", { resourceId: "RES-103" });
  assert.equal(context.account.exercises[context.sessionId], undefined);
  context.latestUserContent = "可以，开始练习吧";
  context.turnId = "turn-start";
  await call(context, "psychological_support", "start_support_exercise", { resourceId: "RES-103" });
  await call(context, "psychological_support", "advance_support_exercise", { action: "next" });
  assert.equal(context.account.exercises[context.sessionId].stepIndex, 0);
  await commitDemoContext(context);
  context = await reload(context, "我看见了桌子、杯子、窗户", "turn-next");
  await call(context, "psychological_support", "advance_support_exercise", { action: "next" });
  await call(context, "psychological_support", "advance_support_exercise", { action: "next" });
  assert.equal(context.account.exercises[context.sessionId].stepIndex, 1);
  await commitDemoContext(context);
  const otherSession = await createDemoContext(context.owner, "different-session", { storageRoot: context.storageRoot });
  assert.equal(otherSession.account.exercises[otherSession.sessionId], undefined);
  context = await reload(context, "我不想继续了", "turn-stop");
  await call(context, "psychological_support", "advance_support_exercise", { action: "next" });
  assert.equal(context.account.exercises[context.sessionId].status, "stopped");
});

test("local resource files are playable non-empty PCM WAVs matching advertised duration", async () => {
  for (const resource of demoResources.filter((item) => item.audioUrl)) {
    const bytes = await readFile(resolve("public", resource.audioUrl!.slice(1)));
    assert.equal(bytes.toString("ascii", 0, 4), "RIFF");
    assert.equal(bytes.toString("ascii", 8, 12), "WAVE");
    assert.equal(bytes.readUInt16LE(20), 1);
    const duration = bytes.readUInt32LE(40) / bytes.readUInt32LE(28);
    assert.equal(duration, resource.durationSeconds);
    assert.ok(bytes.subarray(44).some((byte) => byte !== 0));
  }
});

test("catalog and native function schemas contain no configurable user selector or secret", async () => {
  const context = await setup();
  const catalog = demoOverview(context);
  assert.equal(catalog.isDemo, true);
  assert.ok(catalog.sampleQueries.some((query) => query.includes("ORD-1002")));
  for (const agent of ["customer_service", "counselor_matching", "appointment", "psychological_support"] as const) {
    const tools = toolsForAgent(agent);
    assert.ok(tools.length > 0);
    for (const tool of tools) {
      assert.equal(tool.type, "function");
      assert.equal(tool.function.parameters.additionalProperties, false);
      assert.ok(!JSON.stringify(tool).includes("userId"));
    }
  }
  assert.ok(!JSON.stringify(catalog).includes("apiKey"));
});
