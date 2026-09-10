// Proxy resolution for the loopback router.
//
// Node's global fetch (undici) ignores HTTP_PROXY / HTTPS_PROXY by default, so
// on networks where chatgpt.com is only reachable through a proxy the router
// would otherwise fail every GPT passthrough with ECONNRESET while DeepSeek
// (a directly reachable host) keeps working. The router therefore resolves a
// proxy explicitly and re-execs itself with --use-env-proxy so both the GPT
// passthrough uses it, while NO_PROXY keeps
// loopback and api.deepseek.com direct.

const DIRECT_NO_PROXY = ["127.0.0.1", "localhost", "::1", "api.deepseek.com"];

const PROXY_ENV_NAMES = [
  "DSCODEX_HTTPS_PROXY",
  "DSCODEX_HTTP_PROXY",
  "dscodex_https_proxy",
  "dscodex_http_proxy",
  "https_proxy",
  "HTTPS_PROXY",
  "http_proxy",
  "HTTP_PROXY",
];

function valueFromEnv(env, name) {
  const value = env?.[name];
  return typeof value === "string" ? value.trim() : "";
}

export function resolveProxy(env = process.env, stored = "") {
  for (const name of PROXY_ENV_NAMES) {
    const candidate = valueFromEnv(env, name);
    if (candidate) return candidate;
  }
  return typeof stored === "string" ? stored.trim() : "";
}

export function proxySource(env = process.env, stored = "") {
  if (PROXY_ENV_NAMES.slice(0, 4).some((name) => valueFromEnv(env, name))) {
    return "DSCODEX_*_PROXY env";
  }
  if (PROXY_ENV_NAMES.slice(4).some((name) => valueFromEnv(env, name))) {
    return "HTTP(S)_PROXY env";
  }
  return typeof stored === "string" && stored.trim() ? "stored in config.json" : "";
}

// --use-env-proxy landed in Node 24.5.0. Keep the gate conservative: older
// runtimes get a clear error instead of an unknown-option crash at startup.
export function envProxySupported(version = process.version) {
  const match = /^v(\d+)\.(\d+)\./.exec(String(version));
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > 24 || (major === 24 && minor >= 5);
}

export function usesEnvProxy(env = process.env) {
  return /(^|\s)--use-env-proxy(\s|$)/.test(env.NODE_OPTIONS ?? "")
    || String(env.NODE_USE_ENV_PROXY ?? "") === "1";
}

export function proxyEnvFor(proxyUrl, env = process.env) {
  const validated = validateProxyUrl(proxyUrl);
  const noProxy = mergeNoProxy(`${env.NO_PROXY ?? ""},${env.no_proxy ?? ""}`);
  return {
    HTTP_PROXY: validated,
    HTTPS_PROXY: validated,
    http_proxy: validated,
    https_proxy: validated,
    NO_PROXY: noProxy,
    no_proxy: noProxy,
    NODE_OPTIONS: appendEnvProxyFlag(env.NODE_OPTIONS),
  };
}

export function validateProxyUrl(value) {
  const trimmed = String(value ?? "").trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error("Invalid proxy URL (expected http:// or https:// with a hostname)");
  }
  if (!/^https?:$/.test(parsed.protocol) || !parsed.hostname) {
    throw new Error("Invalid proxy URL (expected http:// or https:// with a hostname)");
  }
  return trimmed;
}

export function redactProxyUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value));
  } catch {
    return "<invalid proxy URL>";
  }
  if (parsed.username || parsed.password) {
    if (parsed.username) parsed.username = "redacted";
    if (parsed.password) parsed.password = "redacted";
  }
  if (parsed.search) parsed.search = "?redacted";
  if (parsed.hash) parsed.hash = "#redacted";
  return parsed.toString();
}

function appendEnvProxyFlag(nodeOptions = "") {
  const trimmed = String(nodeOptions).trim();
  if (usesEnvProxy({ NODE_OPTIONS: trimmed })) return trimmed;
  return trimmed ? `${trimmed} --use-env-proxy` : "--use-env-proxy";
}

function mergeNoProxy(existing = "") {
  const parts = String(existing)
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const seen = new Set(parts.map((part) => part.toLowerCase()));
  for (const value of DIRECT_NO_PROXY) {
    if (!seen.has(value.toLowerCase())) {
      parts.push(value);
      seen.add(value.toLowerCase());
    }
  }
  return parts.join(",");
}
