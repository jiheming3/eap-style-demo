import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan } from "../lib/agents.ts";
import { completeModel } from "../lib/provider.ts";
import { createServer } from "node:http";
import { once } from "node:events";

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
