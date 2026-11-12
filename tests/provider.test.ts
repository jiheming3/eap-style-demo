import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { sseData } from "../lib/stream.ts";
import { validateEndpoint } from "../lib/config.ts";
import { callModel } from "../lib/provider.ts";
import { assertLocalRequest } from "../lib/guard.ts";
import { AppError } from "../lib/errors.ts";

test("SSE preserves Chinese text across individual UTF-8 bytes and split CRLFs", async () => {
  const text = ': keepalive\r\n\r\ndata: {"choices":[{"delta":{"content":"你已经说过预算了。"}}]}\r\n\r\ndata: [DONE]\r\n\r\n';
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } });
  const chunks = [];
  for await (const data of sseData(body)) chunks.push(data);
  assert.equal(chunks.length, 2);
  assert.equal(JSON.parse(chunks[0]).choices[0].delta.content, "你已经说过预算了。");
  assert.equal(chunks[1], "[DONE]");
});

test("SSE accepts trailing events and multiple data lines", async () => {
  const body = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode("data: first\ndata: second\n\ndata: [DONE]")); controller.close(); } });
  const chunks = [];
  for await (const data of sseData(body)) chunks.push(data);
  assert.deepEqual(chunks, ["first\nsecond", "[DONE]"]);
});

test("model settings reject credential-bearing URLs, lookalike hosts and non-official endpoints", () => {
  for (const value of ["https://user:secret@dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com.attacker.example/v1", "http://dashscope.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/compatible-mode/v1?key=secret", "https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions"]) {
    assert.throws(() => validateEndpoint(value), AppError);
  }
  assert.equal(validateEndpoint("https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/"), "https://workspace.cn-beijing.maas.aliyuncs.com/compatible-mode/v1");
});

test("local API rejects cross-origin writes and nonlocal hosts", () => {
  assert.throws(() => assertLocalRequest(new Request("http://127.0.0.1:3000/api/settings", { headers: { origin: "https://attacker.example" } })), AppError);
  assert.throws(() => assertLocalRequest(new Request("http://attacker.example/api/settings")), AppError);
  assert.doesNotThrow(() => assertLocalRequest(new Request("http://127.0.0.1:3000/api/settings", { headers: { origin: "http://127.0.0.1:3000" } })));
  assert.doesNotThrow(() => assertLocalRequest(new Request("http://localhost:3000/api/settings", { headers: { origin: "http://127.0.0.1:3000" } })));
  assert.throws(() => assertLocalRequest(new Request("http://localhost:3000/api/settings", { headers: { origin: "http://localhost:3001" } })), AppError);
  assert.throws(() => assertLocalRequest(new Request("http://localhost:3000/api/settings", { headers: { origin: "null" } })), AppError);
});

test("provider sends complete history and redacts upstream error content", async (t) => {
  process.env.EAP_TEST_UPSTREAM = "1";
  let received: { messages: { role: string; content: string }[]; model: string; stream: boolean } | null = null;
  let fail = false;
  const server = createServer(async (request, response) => {
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer LOCAL_TEST_SECRET");
    const parts = [];
    for await (const chunk of request) parts.push(chunk);
    received = JSON.parse(Buffer.concat(parts).toString());
    if (fail) { response.writeHead(401); response.end(JSON.stringify({ error: { message: "exposed LOCAL_TEST_SECRET" } })); return; }
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.end('data: {"choices":[{"delta":{"content":"记得。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => { delete process.env.EAP_TEST_UPSTREAM; server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const config = { model: "qwen3.8-max", baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: "LOCAL_TEST_SECRET" };
  const history = [{ role: "user" as const, content: "预算300元以内，周五晚上。" }, { role: "assistant" as const, content: "好，记下了。" }, { role: "user" as const, content: "改成周六，预算不变。" }];
  const response = await callModel(config, history, true);
  await response.text();
  assert.ok(received);
  const payload = received as { messages: { role: string; content: string }[]; model: string; stream: boolean };
  assert.equal(payload.model, "qwen3.8-max"); assert.equal(payload.stream, true);
  assert.equal(payload.messages[0].role, "system");
  assert.deepEqual(payload.messages.slice(1), history);
  fail = true;
  await assert.rejects(() => callModel(config, history, true), (error: unknown) => error instanceof AppError && error.code === "authentication_failed" && !error.message.includes("LOCAL_TEST_SECRET"));
});
