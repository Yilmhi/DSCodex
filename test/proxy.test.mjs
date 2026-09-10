import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import test from "node:test";
import { once } from "node:events";
import { gzipSync, zstdCompressSync } from "node:zlib";
import { buildDeepSeekBody, createProxyServer } from "../src/proxy.mjs";

const ROUTER_TOKEN = "A".repeat(43);

function route(proxyUrl, path = "/v1/responses") {
  return `${proxyUrl}/${ROUTER_TOKEN}${path}`;
}

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  return `http://127.0.0.1:${address.port}`;
}

async function close(server) {
  server.close();
  await once(server, "close");
}

async function bodyOf(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

test("routes Flash and legacy task aliases to the current Flash model", async (t) => {
  const observed = [];
  const upstream = http.createServer(async (request, response) => {
    observed.push({
      path: request.url,
      authorization: request.headers.authorization,
      body: JSON.parse(await bodyOf(request)),
    });
    const stream = "event: response.output_text.delta\ndata: {\"delta\":\"ok\"}\n\n"
      + "event: response.completed\ndata: {\"type\":\"response.completed\"}\n\n";
    const compressed = gzipSync(stream);
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "content-encoding": "gzip",
      "content-length": compressed.length,
    });
    response.end(compressed);
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    chatGptBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  for (const [pickerModel, wireModel] of [
    ["deepseek/deepseek-flash", "deepseek-flash"],
    ["deepseek-flash", "deepseek-flash"],
    ["deepseek/deepseek-v4-flash", "deepseek-flash"],
    ["deepseek/deepseek-v4-pro", "deepseek-flash"],
    ["deepseek-v4-pro", "deepseek-flash"],
  ]) {
    const codexBody = zstdCompressSync(JSON.stringify({
      model: pickerModel,
      stream: true,
      metadata: { unsupported: true },
      previous_response_id: "unsupported",
      input: [
        { id: "msg_1", type: "agent_message", content: "prior answer" },
        { id: "call_1", type: "function_call_output", call_id: "call_7", output: "done" },
      ],
    }));
    const response = await fetch(route(proxyUrl), {
      method: "POST",
      headers: { "content-type": "application/json", "content-encoding": "zstd", authorization: "Bearer client-token" },
      body: codexBody,
    });

    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-encoding"), null);
    assert.match(await response.text(), /response\.completed/);
    const request = observed.at(-1);
    assert.equal(request.path, "/responses");
    assert.equal(request.authorization, "Bearer test-key");
    assert.equal(request.body.model, wireModel);
    assert.deepEqual(request.body.reasoning, { effort: "max" });
    assert.equal(request.body.store, false);
    assert.equal("previous_response_id" in request.body, false);
    assert.equal("metadata" in request.body, false);
    assert.deepEqual(request.body.input[0], { type: "message", role: "assistant", content: "prior answer" });
    assert.deepEqual(request.body.input[1], { type: "function_call_output", call_id: "call_7", output: "done" });
  }
});

test("adapts Codex remote compaction v2 to a DeepSeek summary and restores it on replay", async (t) => {
  const observed = [];
  const summary = "The user approved the router fix; tests and a restart are still pending.";
  const upstream = http.createServer(async (request, response) => {
    observed.push(JSON.parse(await bodyOf(request)));
    if (observed.length === 1) {
      const item = {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: summary }],
      };
      const stream = [
        `event: response.output_item.done\ndata: ${JSON.stringify({ type: "response.output_item.done", item })}\n\n`,
        `event: response.completed\ndata: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "resp_upstream",
            output: [item],
            usage: { input_tokens: 100, output_tokens: 20, total_tokens: 120 },
          },
        })}\n\n`,
      ].join("");
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(stream);
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    chatGptBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const compactResponse = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-pro",
      stream: true,
      tools: [{ type: "function", name: "shell" }],
      parallel_tool_calls: true,
      input: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Fix it" }] },
        { type: "compaction_trigger" },
      ],
    }),
  });
  assert.equal(compactResponse.status, 200);
  const compactStream = await compactResponse.text();
  const events = compactStream
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => JSON.parse(line.slice(5).trim()));
  const compactItem = events.find((event) => event.type === "response.output_item.done")?.item;
  const completed = events.find((event) => event.type === "response.completed")?.response;
  assert.equal(compactItem?.type, "compaction");
  assert.equal(completed?.model, "deepseek-flash");
  assert.match(compactItem.encrypted_content, /^dscodex-compaction-v1:/);
  assert.equal(compactItem.encrypted_content.includes(summary), false);
  assert.equal(observed[0].input.some((item) => item.type === "compaction_trigger"), false);
  assert.equal("tools" in observed[0], false);
  assert.equal("parallel_tool_calls" in observed[0], false);
  assert.equal(observed[0].model, "deepseek-flash");
  assert.match(observed[0].input.at(-1).content[0].text, /compact handoff summary/i);

  const replayResponse = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-pro",
      input: [
        compactItem,
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
      ],
    }),
  });
  assert.equal(replayResponse.status, 200);
  await replayResponse.text();
  assert.equal(observed[1].input.some((item) => item.type === "compaction"), false);
  const restored = observed[1].input.find((item) => item.role === "assistant");
  assert.match(restored.content[0].text, /Compacted prior context/);
  assert.match(restored.content[0].text, /tests and a restart are still pending/);
  const gptReplay = await fetch(route(proxyUrl), {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: [compactItem] }),
  });
  assert.equal(gptReplay.status, 200);
  await gptReplay.text();
  assert.deepEqual(observed[2].input, [{
    type: "message", role: "assistant",
    content: [{ type: "output_text", text: `[Compacted prior context]\n${summary}` }],
  }]);

});

test("drops compaction items that cannot be decrypted instead of forwarding them", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = JSON.parse(await bodyOf(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "deepseek/deepseek-v4-flash",
      input: [
        { type: "compaction", id: "cmp_gpt", encrypted_content: "gpt-sealed-blob" },
        { type: "compaction", id: "cmp_tampered", encrypted_content: "dscodex-compaction-v1:not-valid" },
        { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
      ],
    }),
  });
  assert.equal(response.status, 200);
  await response.text();
  assert.equal(observed.input.some((item) => item.type === "compaction"), false);
  assert.deepEqual(observed.input, [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Continue" }] },
  ]);
});

test("preserves explicit High reasoning", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = JSON.parse(await bodyOf(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-token" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", reasoning: { effort: "high", summary: "auto" } }),
  });
  assert.deepEqual(observed.reasoning, { effort: "high" });
});

test("maps stale lower Codex efforts onto DeepSeek High", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = JSON.parse(await bodyOf(request));
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer client-token" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", reasoning: { effort: "medium" } }),
  });
  assert.deepEqual(observed.reasoning, { effort: "high" });
});

test("forwards native GPT models to ChatGPT Codex with OAuth headers", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = {
      path: request.url,
      authorization: request.headers.authorization,
      account: request.headers["chatgpt-account-id"],
      fedramp: request.headers["x-openai-fedramp"],
      memgen: request.headers["x-openai-memgen-request"],
      residency: request.headers["x-openai-internal-codex-residency"],
      responsesLite: request.headers["x-openai-internal-codex-responses-lite"],
      version: request.headers.version,
      body: JSON.parse(await bodyOf(request)),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"ok":true}');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const original = { model: "gpt-5.6-sol", reasoning: { effort: "high" }, input: "hello" };
  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer oauth-token",
      "chatgpt-account-id": "acct-test",
      "x-openai-fedramp": "true",
      "x-openai-memgen-request": "true",
      "x-openai-internal-codex-residency": "us",
      "x-openai-internal-codex-responses-lite": "true",
      version: "0.test",
    },
    body: JSON.stringify(original),
  });
  assert.equal(response.status, 200);
  assert.equal(observed.path, "/backend-api/codex/responses");
  assert.equal(observed.authorization, "Bearer oauth-token");
  assert.equal(observed.account, "acct-test");
  assert.equal(observed.fedramp, "true");
  assert.equal(observed.memgen, "true");
  assert.equal(observed.residency, "us");
  assert.equal(observed.responsesLite, "true");
  assert.equal(observed.version, "0.test");
  assert.deepEqual(observed.body, original);
});

test("forwards Responses Lite to the remote compaction endpoint", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = {
      path: request.url,
      responsesLite: request.headers["x-openai-internal-codex-responses-lite"],
      body: JSON.parse(await bodyOf(request)),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"output":[{"type":"compaction_summary","encrypted_content":"opaque"}]}');
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    chatGptBaseUrl: `${upstreamUrl}/backend-api/codex`,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const original = { model: "gpt-5.6-sol", input: [{ role: "user", content: "compact me" }] };
  const response = await fetch(route(proxyUrl, "/v1/responses/compact"), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-openai-internal-codex-responses-lite": "true",
    },
    body: JSON.stringify(original),
  });

  assert.equal(response.status, 200);
  assert.equal(observed.path, "/backend-api/codex/responses/compact");
  assert.equal(observed.responsesLite, "true");
  assert.deepEqual(observed.body, original);
  assert.deepEqual(await response.json(), {
    output: [{ type: "compaction_summary", encrypted_content: "opaque" }],
  });
});

test("does not forward ChatGPT authentication metadata to DeepSeek", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    observed = { ...request.headers };
    await bodyOf(request);
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "deepseek-test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(route(proxyUrl), {
    method: "POST",
    headers: {
      authorization: "Bearer oauth-token",
      "chatgpt-account-id": "acct-test",
      session_id: "session-underscore-test",
      "session-id": "session-test",
      "thread-id": "thread-test",
      "user-agent": "codex-test",
      "x-oai-attestation": "attestation-test",
      "x-codex-turn-metadata": "metadata-test",
    },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", input: "hello" }),
  });

  assert.equal(response.status, 200);
  assert.equal(observed.authorization, "Bearer deepseek-test-key");
  assert.equal(observed["user-agent"], "codex-test");
  assert.equal(observed["chatgpt-account-id"], undefined);
  assert.equal(observed.session_id, undefined);
  assert.equal(observed["session-id"], undefined);
  assert.equal(observed["thread-id"], undefined);
  assert.equal(observed["x-oai-attestation"], undefined);
  assert.equal(observed["x-codex-turn-metadata"], undefined);
});

test("keeps pooled loopback connections alive past the Codex client idle timeout", async (t) => {
  const proxy = createProxyServer({ logger: { info() {}, error() {} }, routerToken: ROUTER_TOKEN });
  await listen(proxy);
  t.after(async () => { await close(proxy); });
  // The Codex HTTP client pools connections with a ~90s idle timeout; a shorter
  // server timeout makes the client reuse connections the server just closed.
  assert.ok(proxy.keepAliveTimeout > 90_000);
  assert.ok(proxy.headersTimeout > proxy.keepAliveTimeout);
});

test("requires a router token and rejects oversized compressed bodies", async (t) => {
  assert.throws(() => createProxyServer({ logger: { info() {}, error() {} } }), /routerToken is required/);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    routerToken: ROUTER_TOKEN,
    maxRequestBytes: 256,
    maxDecodedBytes: 32,
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); });

  const tooLarge = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "gpt-5.6-sol", input: "x".repeat(1_000) }),
  });
  assert.equal(tooLarge.status, 413);

  const compressed = gzipSync(JSON.stringify({ model: "gpt-5.6-sol", input: "x".repeat(1_000) }));
  const decompressionBomb = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json", "content-encoding": "gzip" },
    body: compressed,
  });
  assert.equal(decompressionBomb.status, 413);
});

test("shutdown requires the per-instance token", async (t) => {
  const shutdownToken = "B".repeat(43);
  let shutdownCalls = 0;
  const proxy = createProxyServer({
    routerToken: ROUTER_TOKEN,
    shutdownToken,
    onShutdown: () => { shutdownCalls += 1; },
    logger: { info() {}, error() {} },
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); });

  const rejected = await fetch(route(proxyUrl, "/_dscodex/shutdown"), {
    method: "POST",
    headers: { "x-dscodex-shutdown-token": "C".repeat(43) },
  });
  assert.equal(rejected.status, 401);
  const accepted = await fetch(route(proxyUrl, "/_dscodex/shutdown"), {
    method: "POST",
    headers: { "x-dscodex-shutdown-token": shutdownToken },
  });
  assert.equal(accepted.status, 202);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownCalls, 1);
});

test("returns an explicit error when a DeepSeek model is selected without a key", async (t) => {
  const proxy = createProxyServer({ deepSeekKey: "", logger: { info() {}, error() {} }, routerToken: ROUTER_TOKEN });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); });
  for (const model of ["deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"]) {
    const response = await fetch(route(proxyUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer client-token" },
      body: JSON.stringify({ model }),
    });
    assert.equal(response.status, 503);
    assert.match((await response.json()).error.message, /DEEPSEEK_API_KEY/);
  }
});

test("rejects requests without the router token, while OAuth remains optional", async (t) => {
  let upstreamHits = 0;
  const upstream = http.createServer(async (request, response) => {
    upstreamHits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
  });
  const upstreamUrl = await listen(upstream);
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    deepSeekBaseUrl: upstreamUrl,
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });

  const response = await fetch(`${proxyUrl}/v1/responses`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", input: "hello" }),
  });
  assert.equal(response.status, 404);
  assert.equal(upstreamHits, 0);
  assert.match((await response.json()).error.message, /not found/i);

  const authorized = await fetch(route(proxyUrl), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "deepseek/deepseek-v4-flash", input: "hello" }),
  });
  assert.equal(authorized.status, 200);
  assert.equal(upstreamHits, 1);
});

const shape = (items) =>
  items.map((item) =>
    item.type === "message" ? `${item.role}:${item.content[0].text}`
      : item.type === "reasoning" ? `reasoning:${item.content[0].text}`
        : `${item.type}:${item.call_id}`);

const say = (role, text) => ({ type: "message", role, content: [{ type: "input_text", text }] });
const think = (text) => ({ type: "reasoning", content: [{ type: "reasoning_text", text }] });

test("re-pairs a tool output with its call when hook context is interleaved", () => {
  const body = buildDeepSeekBody({
    model: "deepseek/deepseek-v4-flash",
    input: [
      say("user", "u1"),
      think("r1"),
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      say("developer", "GitNexus index is stale"),
      { type: "function_call_output", call_id: "c1", output: "ok" },
      { type: "custom_tool_call", call_id: "p1", name: "apply_patch", input: "*** Begin Patch" },
      say("developer", "hook again"),
      { type: "custom_tool_call_output", call_id: "p1", output: "done" },
    ],
  });

  assert.deepEqual(shape(body.input), [
    "user:u1",
    "reasoning:r1",
    "function_call:c1",
    "function_call_output:c1",
    "developer:GitNexus index is stale",
    "custom_tool_call:p1",
    "custom_tool_call_output:p1",
    "developer:hook again",
  ]);
});

test("leaves conversation order alone when a tool call has no output", () => {
  const input = [
    say("user", "u1"),
    think("r1"),
    { type: "function_call", call_id: "orphan", name: "shell", arguments: "{}" },
    say("user", "never mind, do this instead"),
    think("r2"),
    { type: "function_call", call_id: "c2", name: "shell", arguments: "{}" },
    { type: "function_call_output", call_id: "c2", output: "ok" },
    say("user", "u3"),
  ];

  const body = buildDeepSeekBody({ model: "deepseek/deepseek-v4-flash", input });
  assert.deepEqual(shape(body.input), shape(input));
});

test("gives each parallel tool call its own reasoning without leaking it into later turns", () => {
  const parallel = buildDeepSeekBody({
    model: "deepseek/deepseek-v4-flash",
    input: [
      say("user", "u1"),
      think("r1"),
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "a" },
      { type: "function_call_output", call_id: "c2", output: "b" },
    ],
  });
  assert.deepEqual(shape(parallel.input), [
    "user:u1",
    "reasoning:r1",
    "function_call:c1",
    "function_call_output:c1",
    "reasoning:r1",
    "function_call:c2",
    "function_call_output:c2",
  ]);
  assert.notEqual(parallel.input[1], parallel.input[4]);

  // Codex emits an assistant preamble between the reasoning and the calls; that
  // message is part of the same turn, so the extra call still needs a copy.
  const withPreamble = buildDeepSeekBody({
    model: "deepseek/deepseek-v4-flash",
    input: [
      say("user", "u1"),
      think("r1"),
      say("assistant", "Checking two things"),
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call", call_id: "c2", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "a" },
      { type: "function_call_output", call_id: "c2", output: "b" },
    ],
  });
  assert.deepEqual(shape(withPreamble.input), [
    "user:u1",
    "reasoning:r1",
    "assistant:Checking two things",
    "function_call:c1",
    "function_call_output:c1",
    "reasoning:r1",
    "function_call:c2",
    "function_call_output:c2",
  ]);

  // A second turn that carries no reasoning of its own must not inherit the first turn's.
  const sequential = buildDeepSeekBody({
    model: "deepseek/deepseek-v4-flash",
    input: [
      say("user", "u1"),
      think("r1"),
      { type: "function_call", call_id: "c1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c1", output: "a" },
      { type: "function_call", call_id: "c2", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "c2", output: "b" },
    ],
  });
  assert.equal(sequential.input.filter((item) => item.type === "reasoning").length, 1);
});

test("never asks DeepSeek for parallel tool calls", () => {
  const body = buildDeepSeekBody({
    model: "deepseek/deepseek-v4-flash",
    parallel_tool_calls: true,
    input: [say("user", "u1")],
  });
  assert.equal(body.parallel_tool_calls, false);
});

// Regression: the `upgrade` handler used to leave its detached socket without an
// error listener, so a client reset raised an unhandled 'error' event and took
// the whole router down — Codex then sat in "reconnecting" until a manual start.
test("survives a client reset on an upgrade attempt", async (t) => {
  const proxy = createProxyServer({
    deepSeekKey: "test-key",
    logger: { info() {}, error() {} },
    routerToken: ROUTER_TOKEN,
  });
  const proxyUrl = await listen(proxy);
  t.after(async () => { await close(proxy); });
  const { port } = proxy.address();

  const socket = net.connect(port, "127.0.0.1");
  await once(socket, "connect");
  socket.write(
    "GET /v1/models HTTP/1.1\r\nHost: 127.0.0.1\r\n"
    + "Connection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  socket.resetAndDestroy();
  await new Promise((resolve) => setTimeout(resolve, 100));

  // Still serving: an unhandled 'error' event would have killed this process.
  const response = await fetch(route(proxyUrl, "/v1/models"));
  assert.equal(response.status, 200);
});

for (const compressed of [false, true]) {
  test(`GPT replay strips only foreign reasoning and resets encoding: ${compressed}`, async (t) => {
    let observed;
    const upstream = http.createServer(async (request, response) => {
      observed = { headers: request.headers, body: JSON.parse(await bodyOf(request)) };
      response.end('{}');
    });
    const proxy = createProxyServer({ chatGptBaseUrl: await listen(upstream), routerToken: ROUTER_TOKEN, logger: { info() {}, error() {} } });
    const url = await listen(proxy);
    t.after(async () => { await close(proxy); await close(upstream); });
    const retained = [
      { type: "reasoning", encrypted_content: "gpt-sealed", content: [{ type: "reasoning_text", text: "native" }] },
      { type: "reasoning", summary: [{ type: "summary_text", text: "keep" }] },
      { type: "message", role: "user", content: "reasoning_text is literal user text" },
      { type: "compaction", encrypted_content: "gpt-compaction" },
      { type: "function_call", call_id: "call_1", name: "shell", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: "done" },
    ];
    const body = JSON.stringify({ model: "gpt-5.6-sol", input: [
      ...retained.slice(0, 3),
      { type: "reasoning", encrypted_content: null, content: [{ type: "reasoning_text", text: "foreign" }] },
      { type: "reasoning", content: [{ type: "reasoning_text", text: "foreign without encryption field" }] },
      { type: "compaction", encrypted_content: "dscodex-compaction-v1:rotated-or-invalid" },
      ...retained.slice(3),
    ] });
    const response = await fetch(route(url), { method: "POST", headers: {
      "content-type": "application/json", ...(compressed ? { "content-encoding": "gzip" } : {}),
    }, body: compressed ? gzipSync(body) : body });
    assert.equal(response.status, 200);
    await response.text();
    assert.deepEqual(observed.body.input, retained);
    assert.equal(observed.headers['content-encoding'], undefined);
  });
}

test("ordinary compressed GPT traffic preserves exact bytes", async (t) => {
  let observed;
  const upstream = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    observed = { headers: request.headers, raw: Buffer.concat(chunks) };
    response.end('{}');
  });
  const proxy = createProxyServer({ chatGptBaseUrl: await listen(upstream), routerToken: ROUTER_TOKEN, logger: { info() {}, error() {} } });
  const url = await listen(proxy);
  t.after(async () => { await close(proxy); await close(upstream); });
  const body = gzipSync('{ "model": "gpt-5.6-sol", "input": "hello" }');
  const response = await fetch(route(url), { method: "POST", headers: { "content-encoding": "gzip" }, body });
  await response.text();
  assert.equal(response.status, 200);
  assert.deepEqual(observed.raw, body);
  assert.equal(observed.headers['content-encoding'], 'gzip');
});
