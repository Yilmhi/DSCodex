import { deepSeekModelFor } from "./constants.mjs";

const MAX_QUEUED_FRAMES = 64;
const FORBIDDEN_CLOSE_CODES = new Set([1004, 1005, 1006, 1015]);

function upstreamPath(pathname) {
  return pathname.startsWith("/v1/") ? pathname.slice(3) : pathname;
}

export function rejectUpgrade(socket, statusLine = "426 Upgrade Required") {
  socket.on("error", () => {});
  socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\n\r\n`);
}

// The Codex client sends `x-codex-routing-hint: model=<slug>;tier=<tier>` on the
// WebSocket handshake (ChatGPT-auth sessions). Rejecting a DeepSeek upgrade with
// HTTP 426 makes the client fall back to HTTP immediately via
// `WebsocketStreamOutcome::FallbackToHttp`, with no reconnect retries — instead
// of accepting the socket and closing on the first frame, which costs 5 backoff
// retries (~10-15s) per thread.
export function routingHintModel(request) {
  const raw = request?.headers?.["x-codex-routing-hint"];
  if (typeof raw !== "string") return "";
  const match = /(?:^|;)\s*model=([^;]+)/.exec(raw);
  return match ? match[1].trim() : "";
}

export function websocketTarget(baseUrl, pathname, search = "") {
  const httpUrl = new URL(`${String(baseUrl).replace(/\/$/, "")}${upstreamPath(pathname)}${search}`);
  httpUrl.protocol = httpUrl.protocol === "https:" ? "wss:" : "ws:";
  return httpUrl.toString();
}

export function chatgptWebSocketHeaders(request, allowedNames = new Set()) {
  const headers = {};
  for (const [name, value] of Object.entries(request.headers ?? {})) {
    if (value === undefined) continue;
    if (name !== "sec-websocket-protocol" && !allowedNames.has(name)) continue;
    headers[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return headers;
}

export function requestModel(parsed) {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
  if (typeof parsed.model === "string") return parsed.model;
  if (typeof parsed.payload?.model === "string") return parsed.payload.model;
  if (typeof parsed.response?.model === "string") return parsed.response.model;
  return undefined;
}

export function safeCloseCode(code) {
  const numeric = Number(code);
  if (!Number.isInteger(numeric)) return 1000;
  if (numeric === 1000 || (numeric >= 3000 && numeric <= 4999)) return numeric;
  if (numeric >= 1001 && numeric <= 1014 && !FORBIDDEN_CLOSE_CODES.has(numeric)) return numeric;
  return 1000;
}

function payloadToUpstream(data, isBinary) {
  if (isBinary) return data;
  return typeof data === "string" ? data : data.toString();
}

function payloadToClient(data) {
  if (typeof data === "string" || Buffer.isBuffer(data) || data instanceof ArrayBuffer) return data;
  if (ArrayBuffer.isView(data)) return data;
  return String(data);
}

function routeText(text, rewriteBody) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { text };
  }
  if (deepSeekModelFor(requestModel(parsed))) return { deepseek: true };
  const rewritten = typeof rewriteBody === "function" ? rewriteBody(parsed) : null;
  return { text: rewritten ? JSON.stringify(rewritten) : text };
}

function closeSocket(socket, code, reason) {
  const safe = safeCloseCode(code);
  try {
    socket.close(safe, reason ?? "");
  } catch {
    try { socket.terminate?.(); } catch { /* already gone */ }
  }
}

export function proxyChatGptSocket(client, {
  pathname,
  search = "",
  chatGptBaseUrl,
  requestHeaders,
  rewriteBody,
  logger,
  openWebSocket = (url, options) => new WebSocket(url, options),
} = {}) {
  const startedAt = Date.now();
  let upstream;
  let mode = "peek";
  const queue = [];
  let closed = false;

  const closeBoth = (code, reason) => {
    if (closed) return;
    closed = true;
    closeSocket(client, code, reason);
    if (upstream) closeSocket(upstream, code, reason);
  };

  const enqueue = (data, isBinary) => {
    if (queue.length >= MAX_QUEUED_FRAMES) {
      closeBoth(1013, "Queue overflow");
      return false;
    }
    queue.push([data, isBinary]);
    return true;
  };

  const connect = (firstMessage) => {
    if (mode !== "peek") return;
    mode = "connecting";
    const target = websocketTarget(chatGptBaseUrl, pathname, search);
    let ws;
    try {
      ws = openWebSocket(target, { headers: requestHeaders });
    } catch (error) {
      logger?.error?.(`chatgpt websocket connect failed: ${error instanceof Error ? error.message : String(error)}`);
      closeBoth(1011, "Upstream connect failed");
      return;
    }
    ws.binaryType = "arraybuffer";
    upstream = ws;
    ws.addEventListener("open", () => {
      if (closed) {
        closeSocket(ws, 1000);
        return;
      }
      mode = "proxy";
      logger?.info?.(`chatgpt websocket ${pathname} open ${Date.now() - startedAt}ms`);
      if (firstMessage !== undefined) ws.send(firstMessage);
      for (const [data, isBinary] of queue) ws.send(payloadToUpstream(data, isBinary));
      queue.length = 0;
    });
    ws.addEventListener("message", (event) => {
      if (closed || client.readyState !== client.OPEN) return;
      try { client.send(payloadToClient(event.data)); } catch { closeBoth(); }
    });
    ws.addEventListener("error", (event) => {
      if (closed) return;
      const detail = event?.message || event?.error?.message || "error";
      logger?.error?.(`chatgpt websocket error: ${detail}`);
      closeBoth(1011, "Upstream error");
    });
    ws.addEventListener("close", (event) => {
      logger?.info?.(`chatgpt websocket ${pathname} close ${event?.code ?? ""} ${event?.reason ?? ""}`.trim());
      if (closed) return;
      closeBoth(event?.code, event?.reason);
    });
  };

  client.on("error", () => closeBoth());
  client.on("close", () => {
    closed = true;
    if (upstream) closeSocket(upstream);
  });
  client.on("message", (data, isBinary) => {
    if (closed) return;
    if (isBinary) {
      if (mode === "proxy") {
        try { upstream.send(data); } catch { closeBoth(); }
        return;
      }
      if (mode === "connecting") {
        enqueue(data, true);
        return;
      }
      enqueue(data, true);
      connect();
      return;
    }
    const text = typeof data === "string" ? data : data.toString();
    const routed = routeText(text, rewriteBody);
    if (routed.deepseek) {
      logger?.info?.(`deepseek websocket rejected ${pathname}`);
      closeBoth(1008, "DeepSeek uses HTTP");
      return;
    }
    const outgoing = routed.text;
    if (mode === "proxy") {
      try { upstream.send(outgoing); } catch { closeBoth(); }
      return;
    }
    if (mode === "connecting") {
      enqueue(outgoing, false);
      return;
    }
    connect(outgoing);
  });

  // Codex prewarms an idle websocket at thread start. Connect upstream on
  // accept so the first turn does not pay TLS+WS again; DeepSeek is still
  // rejected on the first text frame and never forwarded.
  connect();
}

export function handleResponsesUpgrade({
  wss,
  request,
  socket,
  head,
  pathname,
  search = "",
  chatGptBaseUrl,
  requestHeaders,
  rewriteBody,
  logger,
  openWebSocket,
}) {
  if (pathname !== "/responses" && pathname !== "/v1/responses") {
    rejectUpgrade(socket);
    return;
  }
  const hintedModel = routingHintModel(request);
  if (deepSeekModelFor(hintedModel)) {
    // 426 triggers the client's direct FallbackToHttp path (no retries).
    logger?.info?.(`deepseek websocket upgrade rejected with 426 ${pathname} (hint model=${hintedModel})`);
    rejectUpgrade(socket);
    return;
  }
  wss.handleUpgrade(request, socket, head, (client) => {
    proxyChatGptSocket(client, {
      pathname,
      search,
      chatGptBaseUrl,
      requestHeaders,
      rewriteBody,
      logger,
      openWebSocket,
    });
  });
}
