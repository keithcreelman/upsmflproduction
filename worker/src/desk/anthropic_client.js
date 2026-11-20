// Commissioner Desk: the real Anthropic client. Nothing here runs at import time and nothing here can be reached without the budget gate:
// the desk calls it only through budget.guardedCall, which refuses unless the live switch, the desk key and a nonzero budget all exist.
//
// Key handling: the desk has its OWN key variable. The shared key other features use is never read here, so a leak or a spend spike in
// one feature cannot touch the other. `desiredKeyName` is the single place the name is written.
//
// No retries on purpose: a retry is a second paid call. A failure is surfaced as a typed DeskModelError that carries a short code and,
// at most, the HTTP status and the provider's short error type. The key and the response body are never echoed.

import { validateUsage } from "./prices.js";

export const desiredKeyName = "ANTHROPIC_API_KEY_DESK";
export const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
export const ANTHROPIC_VERSION = "2023-06-01";
export const DEFAULT_TIMEOUT_MS = 60000;

export class DeskModelError extends Error {
  // code: no_key | timeout | network | http_error | bad_response | bad_usage
  // bad_usage: the provider answered 2xx (so the call was billed) but the usage block cannot be trusted. The parsed answer is attached as
  // a NON-enumerable `response` so the budget gate can still hand it back while charging the worst-case reservation; it never serializes.
  constructor(code, { status = null, providerType = null } = {}) {
    super(`desk model call failed: ${code}${status ? ` (http ${status})` : ""}${providerType ? ` ${providerType}` : ""}`);
    this.name = "DeskModelError";
    this.code = code;
    this.status = status;
    this.providerType = providerType;
  }
}

// Only these request fields are sent. Anything else a caller adds is dropped, so a stray field can never widen what is transmitted.
const REQUEST_FIELDS = ["model", "max_tokens", "system", "messages", "tools", "tool_choice", "temperature"];

export function buildBody(request) {
  const body = {};
  for (const k of REQUEST_FIELDS) if (request[k] !== undefined) body[k] = request[k];
  return body;
}

// A provider error type is a short snake_case word ("rate_limit_error"). Anything else is dropped rather than echoed.
function safeProviderType(parsed) {
  const t = parsed && parsed.error && typeof parsed.error.type === "string" ? parsed.error.type : null;
  return t && /^[a-z_]{1,40}$/.test(t) ? t : null;
}

export function createAnthropicClient({ apiKey, fetch: fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) throw new DeskModelError("no_key");
  const doFetch = fetchImpl || (typeof globalThis.fetch === "function" ? globalThis.fetch.bind(globalThis) : null);
  if (!doFetch) throw new DeskModelError("network");

  return {
    mode: "live",
    async complete(request) {
      if (!request || typeof request !== "object") throw new DeskModelError("bad_response");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let res;
      try {
        res = await doFetch(ANTHROPIC_URL, {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION, "content-type": "application/json" },
          body: JSON.stringify(buildBody(request)),
          signal: controller.signal,
        });
      } catch (e) {
        clearTimeout(timer);
        throw new DeskModelError(e && e.name === "AbortError" ? "timeout" : "network");
      }
      try {
        let parsed = null;
        let text = "";
        try { text = await res.text(); } catch (e) { if (e && e.name === "AbortError") throw new DeskModelError("timeout"); text = ""; }
        try { parsed = text ? JSON.parse(text) : null; } catch (_) { parsed = null; }
        if (!res.ok) throw new DeskModelError("http_error", { status: Number(res.status) || 0, providerType: safeProviderType(parsed) });
        if (!parsed || !Array.isArray(parsed.content)) throw new DeskModelError("bad_response", { status: Number(res.status) || 0 });
        const out = { content: parsed.content, stop_reason: parsed.stop_reason == null ? null : String(parsed.stop_reason), usage: parsed.usage, model: typeof parsed.model === "string" ? parsed.model : request.model };
        if (!validateUsage(parsed.usage).ok) {
          const err = new DeskModelError("bad_usage", { status: Number(res.status) || 0 });
          Object.defineProperty(err, "response", { value: out, enumerable: false });
          throw err;
        }
        return out;
      } catch (e) {
        if (e instanceof DeskModelError) throw e;
        throw new DeskModelError(e && e.name === "AbortError" ? "timeout" : "bad_response");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

// Returns null (never throws) when the desk key is absent or blank. Reads exactly one env property: the desk key.
export function createLiveClientFromEnv(env, fetchImpl) {
  const v = env ? env[desiredKeyName] : undefined;
  if (typeof v !== "string" || !v.trim()) return null;
  return createAnthropicClient({ apiKey: v, fetch: fetchImpl });
}
