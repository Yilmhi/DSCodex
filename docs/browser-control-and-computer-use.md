# 浏览器控制与 Computer Use：现状与替代方案

> **English TL;DR.** On the stock ChatGPT / Codex desktop app, Browser Use needs a
> ChatGPT-authenticated *browser route*. When the app cannot reach the ChatGPT backend (or the account
> runs on an API key instead of ChatGPT OAuth) it fails with `No ChatGPT browser route is available`
> — or `unsupported Codex auth method: apikey` in the API-key case. Native Computer Use refuses to
> touch **browser windows** (`could not determine the current browser URL on Windows with enough
> confidence to enforce policy`). Two paths do work: native Windows apps through `@oai/sky`, and
> browser automation through the `chrome-devtools` MCP server. The rest of this page is in Chinese.

DSCodex 只接管**模型路由**；浏览器控制与 Computer Use 仍由客户端自己实现（见 README「已知边界」）。
本文记录 2026-09-19 在一台 Windows 10 22H2 + 桌面端 26.908 实机上逐项验证的结果。

## 一张表看懂

| 能力 | 状态 | 现象 / 证据 |
| --- | --- | --- |
| 内置 Browser Use（Chrome / Edge 扩展、应用内浏览器） | ❌ 失效 | 调用返回 `No ChatGPT browser route is available` |
| 原生 Computer Use 操作**普通应用** | ✅ 可用 | `@oai/sky`：枚举 40 个应用、截图、无障碍树、输入注入全部验证通过 |
| 原生 Computer Use 操作**浏览器窗口** | ⛔ 被拦截 | `Computer Use has been stopped … could not determine the current browser URL … to enforce policy` |
| 浏览器自动化（`chrome-devtools` MCP） | ✅ 可用 | 连用户自己的 Chrome（书签 / 同步 / 登录态都在），导航、表单、截图、JS、网络日志均可用 |

## 1. 内置 Browser Use 为什么会失效

两层原因，先判断是哪一层。

**（a）认证层。** 浏览器控制只接受 **ChatGPT 登录态**。如果客户端跑在 API key 模式（`~/.codex/auth.json`
的 `auth_mode` 为 `apikey`），会直接报 `unsupported Codex auth method: apikey`，整条链路不可用。
检查 `auth_mode` 即可，**不要打印 auth.json 里的任何 token**。

**（b）网络层。** 即使是 ChatGPT 登录态，浏览器控制还需要一条"ChatGPT 浏览器路由"；应用连不上
ChatGPT 后端时这条路由建不起来。桌面端日志
（`%LOCALAPPDATA%\Codex\Logs\<年>\<月>\<日>\codex-desktop-*.log`）会先出现：

```
sa_server_request_failed attachAuth=true attachIntegrityState=true errorMessage=net::ERR_NETWORK_CHANGED
sa_server_request_failed attachAuth=true attachIntegrityState=true errorMessage=net::ERR_CONNECTION_CLOSE
```

随后每次浏览器调用都失败：

```
[browser-use-iab-api] iab backend info request failed conversationId=…
  errorMessage="No ChatGPT browser route is available for browser session …"
```

常见诱因：代理只覆盖浏览器、不覆盖应用自身；会话中途切换代理节点；系统代理 / TUN 来回切。
处理：让应用能稳定访问 ChatGPT 后端（例如代理客户端开 TUN 模式，或保持节点稳定），再重启应用。

> 这条路不用反复折腾扩展、重启浏览器、重开对话或换 `--remote-debugging-port`——这些都验证过，
> 与该故障无关。扩展侧只需要确认「已安装且已启用」：用客户端自带脚本
> `check-extension-installed.js --browser chrome --json`（位于
> `~/.codex/plugins/cache/openai-bundled/chrome/<版本>/scripts/`，用 node 运行）检查，
> `exitCode=0` 即正常。

## 2. 可用的替代方案：chrome-devtools MCP

既然内置通道依赖 ChatGPT 后端，绕开它最省事：挂 **`chrome-devtools-mcp`**，用 CDP 直接驱动浏览器。
在 `~/.codex/config.toml` 里加：

```toml
[mcp_servers.chrome-devtools]
command = 'cmd'
args = ['/c', 'npx', '-y', 'chrome-devtools-mcp@latest', '--autoConnect']
startup_timeout_sec = 120
```

（Windows 下 `npx` 是 `.cmd`，因此用 `cmd /c` 包一层。）

`--autoConnect` 会连上**你正在运行的那个 Chrome**，使用的是真实配置目录——书签、Google 同步、
登录态都在。前置条件：

1. Chrome 保持运行；
2. 在 `chrome://inspect/#remote-debugging` 勾选 *Allow remote debugging for this browser instance*
   （持久设置，勾一次即可）。

可用工具：`list_pages`、`new_page`、`navigate_page`、`take_snapshot`、`fill` / `fill_form` /
`type_text`、`click`、`hover`、`drag`、`press_key`、`upload_file`、`evaluate_script`、
`take_screenshot`、`wait_for`、`list_network_requests`、`list_console_messages`、`performance_*`。

排障：

- 不要改写成写死 `--browserUrl=http://127.0.0.1:9222`：该实例级调试服务**只开 WebSocket**
  （`/json/*` 一律 404），且 `/devtools/browser/<uuid>` 的 uuid **每次重启 Chrome 都会变**，
  所以要靠 `--autoConnect` 自己发现。
- `list_pages` 若返回 `about:blank` 或空列表，说明连到的不是你正在用的实例：检查开关是否仍勾选、
  Chrome 是否刚重启过。
- 该 MCP 的文件写入受其工作区限制，导出快照一类请写到 `%TEMP%`。

## 3. 原生 Computer Use（应用自动化）

普通 Windows 应用可以自动化：先 `list_apps()` 拿**它返回的** window 对象，再 `get_window_state()`
观测，动一步刷一次状态。**但浏览器窗口一律会被 URL 安全闸门拦下**，所以"用 Computer Use 点网页"
这条不要走——浏览器任务交给上一节的 MCP。

## 4. 症状 → 处理速查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| `unsupported Codex auth method: apikey` | 客户端不是 ChatGPT 登录态 | 用 ChatGPT 账号登录，或改走 MCP |
| `No ChatGPT browser route is available` | 应用连不上 ChatGPT 后端，路由未建立 | 让应用稳定出网（TUN 模式 / 别中途切节点）后重启；急用则改走 MCP |
| `could not determine the current browser URL …` | 原生 Computer Use 对浏览器窗口的安全校验 | 不要用 Computer Use 操作浏览器，改用 MCP |
| 扩展已安装但控制不生效 | 与上述故障无关 | 先用 `check-extension-installed.js --browser chrome --json` 确认 `exitCode=0`，再按上面两条排查 |

## 5. 验证记录

- 环境：Windows 10 22H2（19045）、桌面端 `26.908.40834`、Chrome `151.0.7922.173`。
- 原生应用自动化：启动记事本 → 截图（1217×920）→ 无障碍树 → 输入文本；状态栏列号由 `第 1 行, 第 1 列`
  变为 `第 1 行, 第 44 列`。
- 内置 Browser Use：连续 8 种用户侧操作（关闭空白对话、关闭并重开侧边栏、重启应用、重启浏览器、
  重装并启用扩展、配置代理环境变量、启用 CDP 调试端口、新开分支对话）均复现同一错误。
- MCP 通道：`list_pages` 列出用户真实标签页 → 导航成功 → 通过 Gmail 发出一封测试邮件完成端到端验证。
