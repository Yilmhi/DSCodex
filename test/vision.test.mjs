import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { once } from "node:events";
import { createProxyServer } from "../src/proxy.mjs";

const ROUTER_TOKEN = "A".repeat(43);
const IMAGE = "data:image/png;base64,iVBORw0KGgo=";

async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

for (const authorization of [undefined, "Bearer private-chatgpt-token"]) {
  test(`Flash forwards native message and tool images with OAuth ${Boolean(authorization)}`, async (t) => {
    const received = [];
    let gptCalls = 0;
    const upstream = http.createServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      received.push({ headers: request.headers, body: JSON.parse(Buffer.concat(chunks)) });
      response.setHeader("content-type", "application/json");
      response.end("{}");
    });
    const gpt = http.createServer((request, response) => {
      gptCalls += 1;
      response.writeHead(500).end();
    });
    const proxy = createProxyServer({
      deepSeekKey: "test-key", routerToken: ROUTER_TOKEN,
      deepSeekBaseUrl: await listen(upstream), chatGptBaseUrl: await listen(gpt),
      logger: { info() {}, error() {} },
    });
    const url = await listen(proxy);
    t.after(async () => { await close(proxy); await close(upstream); await close(gpt); });
    const input = [
      { type: "message", role: "user", content: [{ type: "input_image", image_url: IMAGE }] },
      { type: "function_call", call_id: "call_1", name: "view_image", arguments: "{}" },
      { type: "function_call_output", call_id: "call_1", output: [{ type: "input_image", image_url: IMAGE }] },
      { type: "custom_tool_call", call_id: "call_2", name: "image", input: "image" },
      { type: "custom_tool_call_output", call_id: "call_2", output: [{ type: "input_image", image_url: IMAGE }] },
    ];
    for (const model of ["deepseek/deepseek-flash", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-pro"]) {
      const response = await fetch(`${url}/${ROUTER_TOKEN}/v1/responses`, {
        method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
        body: JSON.stringify({ model, input }),
      });
      assert.equal(response.status, 200);
      await response.text();
      assert.equal(received.at(-1).body.model, "deepseek-flash");
      assert.deepEqual(received.at(-1).body.input, input);
      assert.equal(received.at(-1).headers.authorization, "Bearer test-key");
    }
    assert.equal(gptCalls, 0);
  });
}
