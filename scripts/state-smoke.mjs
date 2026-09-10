#!/usr/bin/env node
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const wrapper = join(root, "src", "codex-wrapper.mjs");
const catalog = join(homedir(), ".codex", "dscodex-models.json");
const temporaryHome = mkdtempSync(join(tmpdir(), "dscodex-state-smoke-"));
const bundledCodex = "/Applications/ChatGPT.app/Contents/Resources/codex";
const realCodex = process.env.DSCODEX_REAL_CODEX?.trim()
  || (existsSync(bundledCodex) ? bundledCodex : execFileSync("which", ["codex"], { encoding: "utf8" }).trim());

assert.ok(existsSync(catalog), "run dscodex install before the state smoke");
writeFileSync(join(temporaryHome, "config.toml"), [
  `model_catalog_json = ${JSON.stringify(catalog)}`,
  'model = "gpt-5.6-sol"',
  'model_reasoning_effort = "xhigh"',
  'service_tier = "priority"',
  "",
].join("\n"));

const child = spawn(wrapper, ["app-server", "--strict-config"], {
  env: { ...process.env, CODEX_HOME: temporaryHome, DSCODEX_REAL_CODEX: realCodex },
  stdio: ["pipe", "pipe", "pipe"],
});
let buffer = "";
let stderr = "";
let threadId = null;
let sawDeepSeek = false;
let finished = false;

function send(message) {
  child.stdin.write(`${JSON.stringify(message)}\n`);
}

function finish(error) {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  child.kill("SIGTERM");
  rmSync(temporaryHome, { recursive: true, force: true });
  if (error) {
    console.error(`${error.message}${stderr ? `\n${stderr.trim()}` : ""}`);
    process.exitCode = 1;
  }
}

const timer = setTimeout(() => finish(new Error("provider-state smoke timed out")), 12_000);
child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
child.stdout.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    try {
      const message = JSON.parse(line);
      if (message.id === 1) {
        send({ method: "initialized" });
        send({
          id: 2,
          method: "thread/start",
          params: {
            model: "gpt-5.6-sol",
            cwd: root,
            approvalPolicy: "never",
            sandbox: "danger-full-access",
            config: { model_reasoning_effort: "xhigh" },
            serviceTier: "priority",
            ephemeral: true,
          },
        });
      } else if (message.id === 2) {
        assert.equal(message.result?.reasoningEffort, "xhigh");
        assert.equal(message.result?.serviceTier, "priority");
        threadId = message.result?.thread?.id;
        assert.ok(threadId);
        send({
          id: 3,
          method: "thread/settings/update",
          params: { threadId, model: "deepseek/deepseek-flash", effort: "xhigh" },
        });
      } else if (message.method === "thread/settings/updated" && message.params?.threadId === threadId) {
        const settings = message.params.threadSettings;
        if (settings.model === "deepseek/deepseek-flash") {
          assert.equal(settings.effort, "max");
          assert.equal(settings.serviceTier, "default");
          if (!sawDeepSeek) {
            sawDeepSeek = true;
            send({
              id: 4,
              method: "thread/settings/update",
              params: { threadId, model: "gpt-5.6-sol", effort: "max" },
            });
          }
        } else if (sawDeepSeek && settings.model === "gpt-5.6-sol") {
          assert.equal(settings.effort, "xhigh");
          assert.equal(settings.serviceTier, "priority");
          console.log(JSON.stringify({
            deepseekEffort: "max",
            openaiEffort: "xhigh",
            openaiServiceTier: "priority",
            stockAppServer: true,
          }));
          finish();
        }
      }
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  }
});
child.once("error", (error) => finish(error));

send({
  method: "initialize",
  id: 1,
  params: {
    clientInfo: { name: "dscodex-state-smoke", title: "DSCodex state smoke", version: "0.2.0" },
    capabilities: { experimentalApi: true, requestAttestation: false },
  },
});
