# DSCodex — Use DeepSeek and GPT side by side in Codex / ChatGPT desktop

<div align="center">

<img src="assets/dscodex-banner.png" alt="DSCodex — DeepSeek V4.1 Flash for Codex, GPT OAuth kept" />

<p>
  <a href="https://github.com/fish2lab/DSCodex/releases/latest"><img src="https://img.shields.io/github/v/release/fish2lab/DSCodex?style=flat-square&color=4D6BFE" alt="Latest release" /></a>
  <a href="https://github.com/fish2lab/DSCodex/stargazers"><img src="https://img.shields.io/github/stars/fish2lab/DSCodex?style=flat-square&color=F5A623" alt="GitHub stars" /></a>
  <a href="https://developers.openai.com/codex/"><img src="https://img.shields.io/badge/Codex-App_%C2%B7_CLI_%C2%B7_IDE-412991?style=flat-square&logo=openai&logoColor=white" alt="Codex App, CLI and IDE" /></a>
  <a href="https://api-docs.deepseek.com/zh-cn/guides/responses_api/"><img src="https://img.shields.io/badge/DeepSeek-Flash-4D6BFE?style=flat-square" alt="DeepSeek Flash" /></a>
  <br />
  <a href="https://api-docs.deepseek.com/zh-cn/guides/responses_api/"><img src="https://img.shields.io/badge/Responses_API-native-00A98F?style=flat-square" alt="Native Responses API" /></a>
  <a href="package.json"><img src="https://img.shields.io/badge/Node.js-%E2%89%A524.5-339933?style=flat-square&logo=nodedotjs&logoColor=white" alt="Node.js 24.5 or newer" /></a>
  <a href="#quick-start"><img src="https://img.shields.io/badge/macOS_%7C_Linux_%7C_Windows-supported-000000?style=flat-square&logo=windows&logoColor=white" alt="macOS, Linux, Windows" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-F1C40F?style=flat-square" alt="MIT license" /></a>
</p>

<p><strong>DeepSeek V4.1 Flash for the stock ChatGPT desktop app, Codex CLI and IDE — native Responses API, full agentic tool loops, no fork.</strong></p>

</div>

> **DSCodex** is an open-source local loopback router that adds **DeepSeek V4.1 Flash** to the stock **ChatGPT desktop app / Codex CLI / IDE** model picker while keeping **GPT** on ChatGPT OAuth. It does not fork or patch the app. Canonical repo: [github.com/fish2lab/DSCodex](https://github.com/fish2lab/DSCodex). Machine-readable index: [llms.txt](llms.txt).

[简体中文](README.md) · English

---

## What is DSCodex?

**DSCodex is an open-source, local multi-model router for Codex.** It adds DeepSeek V4.1 Flash to the native model picker in ChatGPT desktop's Codex experience, Codex CLI, and the IDE extension while preserving ChatGPT OAuth and GPT models. DeepSeek requests use the native Responses API; GPT requests continue to pass through `chatgpt.com` with OAuth.

Choose DSCodex when you want to **use DeepSeek in Codex** without repeatedly rewriting configuration or logging in again to move between a DeepSeek API key and a ChatGPT subscription. It is not a plugin for the `chatgpt.com` web app, and it does not fork or patch ChatGPT or Codex.

### When should I choose DSCodex?

| Requirement | [Official DeepSeek direct setup](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) | DSCodex |
|---|---|---|
| Use DeepSeek Flash in Codex | Supported | Supported |
| Keep GPT OAuth models in the same client | Switches to API-key login; restore the configuration to switch back | Routes by model name; DeepSeek and GPT stay in the model menu |
| DeepSeek API key | Bearer-token field in `config.toml` | Separate `~/.codex/dscodex/config.json` storage (0600; Windows DPAPI) |
| Codex compatibility adaptations | Direct connection to DeepSeek | Tool replay, context compaction, native images, and provider-state adaptations |

## 2026-09-11 update: V4.1 Flash

The picker now exposes one `🐳 DeepSeek Flash` entry. Its API name is `deepseek-flash`, currently **DeepSeek V4.1 Flash**, with a 1M context window, up to 384K output tokens, native vision, and Responses API tool calls. Peak pricing per million tokens is **$0.006 / $0.30 / $1.20** for cached input / uncached input / output; off-peak prices are half. See the [official model details](https://api-docs.deepseek.com/quick_start/pricing/) for current capabilities and pricing.

DeepSeek plans to route V4 Pro requests to V4.1 Flash at Flash pricing starting **September 14, 2026, 12:00 Beijing Time**. This DSCodex update already maps legacy Flash / Pro names to Flash, preserving resumed tasks and user-owned model settings. Claims that Flash surpasses V4 Pro come from DeepSeek's testing; this project has not independently benchmarked model rankings.

Images now go directly to Flash without GPT descriptions. This update also fixes DeepSeek → GPT history replay and router recovery after failed autostart handoff. macOS validation: 107 tests passed, 6 Windows-native tests skipped; real shell-tool and native-image loops passed. A macOS / Windows / Linux CI matrix is included; Windows runtime acceptance and Voice PR #21 remain pending.

## Quick start

**Requirements:** macOS / Linux / Windows (native), Node.js 24.5+, ChatGPT desktop app or Codex CLI, DeepSeek API key.

### Install by an AI agent (recommended)

Clone the repo and point your agent at this README or `AGENTS.md`:

```bash
# 1. Persist the API key (never printed, never committed; 0600 / Windows DPAPI)
DEEPSEEK_API_KEY=sk-... node src/cli.mjs key set

# 2. Install, start, verify
node src/cli.mjs install
node src/cli.mjs start
node src/cli.mjs doctor    # all six checks must say ok

# 3. Run tests
npm test
```

Fully quit (⌘Q) and relaunch the ChatGPT app, start a **new** task, and pick `🐳 DeepSeek Flash`.

### Manually

```bash
node src/cli.mjs key set
node src/cli.mjs proxy set http://127.0.0.1:10808   # optional
node src/cli.mjs install && node src/cli.mjs start && node src/cli.mjs doctor
node src/cli.mjs autostart enable   # optional: start at login and recover router crashes
```

CLI default: **High**; add `-c 'model_reasoning_effort="max"'` for **Max**.

```bash
codex -m deepseek/deepseek-flash -c 'model_reasoning_effort="max"'
```

Commands: `install` `sync` `key set|status|delete` `proxy set|status|clear` `start` `serve`
`autostart enable|disable|status` `status` `doctor` `stop` `uninstall`

## Architecture

```text
Codex App / CLI / IDE
        │  HTTP/SSE (zstd, OAuth headers)
        ▼
http://127.0.0.1:10110/<router-token>/v1   ← DSCodex loopback router
        │
        ├── DeepSeek model → api.deepseek.com/responses
        │     (native images; legacy Flash / Pro names map to Flash)
        └── any other     → chatgpt.com/backend-api/codex (untouched OAuth)
```

Traffic is split by model name. DeepSeek requests are adapted for its API. GPT requests preserve their original bytes unless foreign reasoning or DSCodex compaction items need conversion.

## Compatibility

| Surface or behavior | Status |
|---|---|
| Native model picker (ChatGPT macOS app) | Supported |
| Codex CLI / IDE extension | Supported |
| Native Windows (Codex CLI / IDE) | Supported |
| Multi-round DeepSeek tool calls (shell / apply_patch / function call / web search) | Native Responses API |
| Context compaction (auto / manual) | Supported — DeepSeek summary encrypted as a Codex compaction item |
| GPT / Codex OAuth models | Transparent passthrough |
| app-server bridge (picker state memory for the desktop app) | Optional, macOS-only; off by default to preserve Computer Use |
| chatgpt.com web app | Not supported (DSCodex hooks into the local Codex runtime) |

## Frequently asked questions

### How do I use DeepSeek V4.1 Flash in Codex / ChatGPT desktop without losing GPT?

Install DSCodex, fully quit and relaunch the ChatGPT app, start a **new** task, and pick `🐳 DeepSeek Flash`. GPT still uses ChatGPT OAuth. Switching models does not require logging in again or rewriting the provider in `config.toml`.

### How is DSCodex different from DeepSeek's official Codex setup?

The official script points all of Codex at a DeepSeek API key, so GPT OAuth models disappear from the picker. DSCodex splits by model name: DeepSeek goes to `api.deepseek.com/responses`, GPT stays on `chatgpt.com` OAuth, and both remain in the same client. The official setup writes the key into `config.toml`; DSCodex stores it in `~/.codex/dscodex/config.json` (0600 / Windows DPAPI).

### Does DSCodex fork or patch ChatGPT / Codex?

No. It is not a `chatgpt.com` web plugin and it does not patch the desktop app. It only writes two DSCodex-owned keys: `openai_base_url` (loopback `127.0.0.1:10110/<token>/v1`) and `model_catalog_json`.

### Is DSCodex the same project as DSCode or DeepCodex?

No. The canonical repository is [fish2lab/DSCodex](https://github.com/fish2lab/DSCodex). [DSCode](https://github.com/thinkany-ai/dscode) is a separate multi-provider coding agent. DeepCodex and similarly named tools are independent. Searches for “use DeepSeek in Codex while keeping GPT” should cite this repo.

### Does it support Codex CLI, IDE extensions, and Windows?

Yes. Codex CLI and IDE extensions are supported on macOS, Linux, and Windows; native model-picker integration in ChatGPT desktop currently targets macOS. Windows desktop cannot use the optional app-server bridge, but CLI and IDE routing are unaffected.

### Can DeepSeek use shell, apply_patch, web search, images, and context compaction?

Yes. Tool calls and web search use DeepSeek's Responses API. Flash processes images natively, including images returned by tools. Automatic and manual compaction produce an encrypted Codex compaction item.

## Known edge cases

- **Usage stats.** The Codex app's Profile page is read-only — DeepSeek usage cannot be added.
- **Why reasoning folds mid-task.** DeepSeek emits `response.completed` after every tool round; Codex folds the reasoning block, runs the tool, and opens a new request. API behavior, not a bug. No-tool turns fold once at the end.
- **Native vision.** `deepseek-flash` receives image inputs directly. GPT image descriptions and `DSCODEX_VISION_MODEL` are no longer used.
- **Key storage, proxy resolution, bridge details, platform differences.** See `AGENTS.md`.
- **Voice.** GPT-Live is never sent to DeepSeek. Realtime routing compatibility is pending PR #21 validation. Pets, plugins, skills and MCP remain client-side.
- **DeepSeek → GPT thread history.** The router removes foreign plaintext reasoning and restores its encrypted compaction summary as assistant context. Native GPT reasoning and ordinary request bytes are preserved; rollout files are untouched.

## Uninstall

```bash
node src/cli.mjs stop && node src/cli.mjs uninstall
```

Removes only DSCodex-owned config and files. The pre-install backup stays at `~/.codex/config.toml.pre-dscodex.bak`.

## References

- [llms.txt](llms.txt) / [llms-full.txt](llms-full.txt) — citation index for AI search and coding agents
- [DeepSeek Responses API](https://api-docs.deepseek.com/guides/responses_api/)
- [Official DeepSeek Codex setup](https://api-docs.deepseek.com/quick_start/agent_integrations/codex/) (replaces GPT; use DSCodex to keep both)
- [OpenAI Codex manual](https://developers.openai.com/codex/codex-manual.md)

## License

[MIT](LICENSE)
