import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDemoContext, commitDemoContext } from "../lib/demo-tools.ts";
import { demoExperts } from "../lib/demo-data.ts";

test("multi-agent app: scoped tools, mixed intent, history, isolation, failure and cancellation", { timeout: 90_000 }, async (t) => {
  let mode = "ok";
  const matchingDate = demoExperts()[0].slots[0].startsAt.slice(0, 10);
  const requests: { messages: { role: string; content: string }[]; stream: boolean; tools?: { function: { name: string } }[] }[] = [];
  const upstream = createServer(async (request, response) => {
    const pieces = []; for await (const chunk of request) pieces.push(chunk);
    const body = JSON.parse(Buffer.concat(pieces).toString()); requests.push(body);
    assert.equal(request.headers.authorization, "Bearer DISPOSABLE_TEST_KEY");
    if (mode === "unauthorized") { response.writeHead(401); response.end("DISPOSABLE_TEST_KEY"); return; }
    if (mode === "broken") { response.setHeader("Content-Type", "application/json"); response.end('{"choices":'); return; }
    const system = body.messages[0].content;
    let content = "连接成功。";
    if (system.includes("调度阶段")) content = JSON.stringify({ urgent: false, delegations: ["customer_service", "counselor_matching", "psychological_support"].map((agent) => ({ agent, task: "沿用上下文处理本领域需求" })) });
    else if (system.includes("你是客服智能体")) content = "客服部分已处理。";
    else if (system.includes("你是咨询师匹配智能体")) content = "已按工作压力、期望日期和线上咨询匹配咨询师。";
    else if (system.includes("你是预约智能体")) content = "预约部分已处理。";
    else if (system.includes("你是心理支持智能体")) content = "我们可以慢慢聊。";
    else if (system.includes("最终协调阶段")) content = "已按你的条件匹配咨询师。客服部分已处理，我们可以慢慢聊。";
    if (mode === "composefail" && system.includes("最终协调阶段")) { response.setHeader("Content-Type", "application/json"); response.end("{}"); return; }
    if (body.tools?.length && body.messages.at(-1).role !== "tool") {
      let calls;
      if (system.includes("你是客服智能体")) calls = mode === "composefail" ? [{ name: "request_duplicate_refund", arguments: '{"orderId":"ORD-1002"}' }] : [{ name: "get_my_profile", arguments: "{}" }, { name: "query_my_orders", arguments: "{}" }];
      else if (system.includes("你是咨询师匹配智能体")) calls = [{ name: "search_experts", arguments: JSON.stringify({ topic: "工作压力", date: matchingDate, timeStart: "18:00", timeEnd: "23:59", format: "线上咨询", gender: "女", maxPrice: 300 }) }];
      else calls = [{ name: "show_support_resource", arguments: '{"resourceId":"RES-101"}' }];
      response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [{ finish_reason: "tool_calls", message: { content: null, tool_calls: calls.map((fn, i) => ({ id: `call-${requests.length}-${i}`, type: "function", function: fn })) } }] })); return;
    }
    const finish = () => { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content, reasoning_content: "PRIVATE_REASONING" } }] })); };
    if (mode === "slow") { const timer = setTimeout(finish, 5000); response.on("close", () => clearTimeout(timer)); } else finish();
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  t.after(() => { upstream.closeAllConnections(); upstream.close(); });
  const address = upstream.address(); assert.ok(address && typeof address !== "string");
  const upstreamPort = address.port;
  const probe = createServer(); probe.listen(0, "127.0.0.1"); await once(probe, "listening");
  const appAddress = probe.address(); assert.ok(appAddress && typeof appAddress !== "string");
  const port = appAddress.port; await new Promise<void>((resolve) => probe.close(() => resolve()));
  const dataDir = await mkdtemp(path.join(tmpdir(), "eap-integration-"));
  function startApp() {
    const processHandle = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", String(port)], { windowsHide: true, env: { ...process.env, EAP_TEST_UPSTREAM: "1", EAP_DEMO_DATA_DIR: dataDir, QWEN_MODEL: "qwen3.8-max", QWEN_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`, QWEN_API_KEY: "DISPOSABLE_TEST_KEY", NEXT_TELEMETRY_DISABLED: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    processHandle.stdout.on("data", (d) => { logs = (logs + d).slice(-10000); }); processHandle.stderr.on("data", (d) => { logs = (logs + d).slice(-10000); });
    return processHandle;
  }
  let logs = "";
  let child = startApp();
  async function stopApp() { const exited = once(child, "exit"); child.kill(); await exited; }
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) await stopApp(); await rm(dataDir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${port}`;
  async function waitForApp() {
    for (let attempt = 0; attempt < 100; attempt++) { try { if ((await fetch(base + "/api/settings")).ok) return; } catch {} if (child.exitCode !== null) throw new Error(logs); await delay(150); }
    assert.fail(logs);
  }
  await waitForApp();
  const headers: Record<string, string> = { "Content-Type": "application/json", origin: base };
  async function call(url: string, method = "GET", body?: unknown) {
    const response = await fetch(base + url, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const cookie = response.headers.get("set-cookie"); if (cookie) { assert.match(cookie, /Max-Age=31536000/i); headers.cookie = cookie.split(";")[0]; } return response;
  }
  assert.ok(!(await (await call("/api/settings")).text()).includes("DISPOSABLE_TEST_KEY"));
  assert.equal((await call("/api/settings/check", "POST")).status, 200);
  const demo = await (await call("/api/demo")).json(); assert.ok(JSON.stringify(demo).includes("林晓"));
  const session = await (await call("/api/sessions", "POST", { scenarioId: "memory" })).json();
  const firstQuery = `我想找女咨询师，${matchingDate}晚上线上聊工作压力，预算300元以内。也看看我的订单，我还想聊聊。`;
  const first = await (await call("/api/chat", "POST", { sessionId: session.id, content: firstQuery })).text();
  assert.ok(first.includes('"type":"done"'), first); assert.ok(!first.includes("PRIVATE_REASONING"));
  const second = await (await call("/api/chat", "POST", { sessionId: session.id, content: "换成周六，预算不变。" })).text(); assert.ok(second.includes('"type":"done"'), second);
  const saved = await (await call(`/api/sessions/${session.id}`)).json(); assert.equal(saved.messages.length, 4);
  assert.ok(saved.messages[1].attachments.some((a: { kind: string }) => a.kind === "orders"));
  assert.ok(saved.messages[1].attachments.some((a: { kind: string }) => a.kind === "experts"));
  assert.ok(saved.messages[1].attachments.some((a: { kind: string }) => a.kind === "resource"));
  assert.deepEqual(saved.messages[1].trace.filter((r: { agent: string }) => r.agent !== "main").map((r: { agent: string }) => r.agent), ["customer_service", "counselor_matching", "psychological_support"]);
  const routerHistory = requests.filter((r) => r.messages[0].content.includes("调度阶段")).at(-1)!.messages;
  assert.equal(routerHistory[1].content, session.messages[0]?.content ?? firstQuery);
  assert.equal(routerHistory.at(-1)!.content, "换成周六，预算不变。");
  const specialistRequests = requests.filter((r) => r.tools?.length);
  const customerTools = specialistRequests.find((r) => r.messages[0].content.includes("你是客服智能体"))!.tools!.map((t) => t.function.name);
  const matchingTools = specialistRequests.find((r) => r.messages[0].content.includes("你是咨询师匹配智能体"))!.tools!.map((t) => t.function.name);
  assert.ok(customerTools.length && matchingTools.length); assert.ok(!customerTools.some((name) => matchingTools.includes(name)));
  const feedback = await (await call(`/api/sessions/${session.id}/feedback`, "POST", { messageId: saved.messages[1].id, rating: "good", note: "协作测试" })).json(); assert.equal(feedback.feedback[saved.messages[1].id].note, "协作测试");
  assert.equal((await fetch(base + `/api/sessions/${session.id}`)).status, 404);
  assert.equal((await fetch(base + "/api/settings", { method: "PUT", headers: { "Content-Type": "application/json", origin: "https://attacker.example" }, body: "{}" })).status, 403);
  for (mode of ["unauthorized", "broken", "composefail"]) {
    const failed = await (await call("/api/chat", "POST", { sessionId: session.id, content: "失败测试" })).text(); assert.ok(failed.includes('"type":"error"')); assert.ok(!failed.includes("DISPOSABLE_TEST_KEY"));
    assert.equal((await (await call(`/api/sessions/${session.id}`)).json()).messages.length, 4);
    const context = await createDemoContext(headers.cookie.split("=")[1], session.id, { storageRoot: dataDir });
    assert.equal(context.account.pendingActions[session.id], undefined, "failed synthesis must not persist proposed transaction");
  }
  mode = "slow";
  const abort = new AbortController();
  const canceled = await fetch(base + "/api/chat", { method: "POST", headers, body: JSON.stringify({ sessionId: session.id, content: "停止这一轮" }), signal: abort.signal });
  const reader = canceled.body!.getReader(); await reader.read(); abort.abort(); await reader.cancel().catch(() => {}); await delay(300);
  assert.equal((await (await call(`/api/sessions/${session.id}`)).json()).messages.length, 4);
  mode = "ok";
  const unoffered = demoExperts().at(-1)!;
  const rejectedBooking = await call("/api/appointments", "POST", { sessionId: session.id, expertId: unoffered.id, slotId: unoffered.slots[0].id });
  assert.equal(rejectedBooking.status, 409);
  const expertAttachment = saved.messages[1].attachments.find((item: { kind: string }) => item.kind === "experts");
  const selected = expertAttachment.experts[0];
  const selectedSlot = selected.slots[0];
  const bookedResponse = await call("/api/appointments", "POST", { sessionId: session.id, expertId: selected.id, slotId: selectedSlot.id });
  assert.equal(bookedResponse.status, 200);
  const booked = await bookedResponse.json();
  assert.equal(booked.booking.expertId, selected.id);
  assert.match(booked.session.messages.at(-1).content, /预约成功/);
  assert.equal(booked.session.messages.at(-1).trace[0].agent, "appointment");
  assert.equal(booked.session.messages.length, 5);
  const staleCard = await call("/api/appointments", "POST", { sessionId: session.id, expertId: selected.id, slotId: selectedSlot.id });
  assert.equal(staleCard.status, 409, "an old counselor card must not remain actionable after booking");
  const retry = await (await call("/api/chat", "POST", { sessionId: session.id, content: "重新发送" })).text(); assert.ok(retry.includes('"type":"done"'), retry);
  const beforeRestart = await (await call(`/api/sessions/${session.id}`)).json();
  const listBeforeRestart = await (await call("/api/sessions")).json();
  await stopApp();
  const persisted = await createDemoContext(headers.cookie.split("=")[1], session.id, { storageRoot: dataDir });
  const storedSession = persisted.account.sessions.find((item) => item.id === session.id)!;
  assert.deepEqual(storedSession, beforeRestart);
  storedSession.updatedAt = new Date(Date.now() - 48 * 3600_000).toISOString();
  persisted.dirty = true;
  await commitDemoContext(persisted);
  child = startApp(); await waitForApp();
  const restored = await (await call(`/api/sessions/${session.id}`)).json();
  assert.deepEqual(restored.messages, beforeRestart.messages);
  assert.deepEqual(restored.feedback, beforeRestart.feedback);
  assert.equal((await (await call("/api/sessions")).json()).sessions.length, listBeforeRestart.sessions.length);
  assert.equal((await fetch(base + `/api/sessions/${session.id}`)).status, 404, "restart must preserve account isolation");
  const resumed = await (await call("/api/chat", "POST", { sessionId: session.id, content: "接着上次聊，预算不变。" })).text();
  assert.ok(resumed.includes('"type":"done"'), resumed);
  const resumedHistory = requests.filter((r) => r.messages[0].content.includes("调度阶段")).at(-1)!.messages;
  assert.equal(resumedHistory[1].content, beforeRestart.messages[0].content);
  assert.equal((await (await call(`/api/sessions/${session.id}`)).json()).messages.length, beforeRestart.messages.length + 2);
});
