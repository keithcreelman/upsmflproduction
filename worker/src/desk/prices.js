// Commissioner Desk: the model price table and the cost arithmetic. Pure functions, no I/O, no env.
//
// THESE PRICES ARE NOT VERIFIED AGAINST KEITH'S ACCOUNT. They come from a cached pricing table (PRICES_AS_OF). The budget gate
// treats them as an estimate; before the first live call a human must compare them with the account's real rates and flip
// PRICES_VERIFIED. The gate does not need that flag to stay safe: caps are in dollars, and the worst-case estimate is pessimistic.
//
// Units: US dollars per MILLION tokens.
export const PRICES_AS_OF = "2026-11-03";
export const PRICES_VERIFIED = false;
export const PRICE_TABLE_VERSION = "2026-11-03.1";

// cacheRead / cacheWrite: where the source table gave none (haiku, opus) the pessimistic choice is used: a cache read is priced at the
// full input rate and a cache write at 1.25x input, so the estimate can never be LOW because of an assumed cache discount.
export const PRICES = Object.freeze({
  "claude-haiku-5-5": Object.freeze({ input: 0.10, output: 0.50, cacheRead: 0.10, cacheWrite: 0.125 }),
  "claude-sonnet-5-5": Object.freeze({ input: 2, output: 10, cacheRead: 0.10, cacheWrite: 2.5 }),
  "claude-opus-5-5": Object.freeze({ input: 4, output: 20, cacheRead: 4, cacheWrite: 5 }),
});

export class DeskPriceError extends Error {
  constructor(code, message) { super(message || code); this.name = "DeskPriceError"; this.code = code; }
}

export function priceFor(model) {
  return typeof model === "string" && Object.prototype.hasOwnProperty.call(PRICES, model) ? PRICES[model] : null;
}

export function isPricedModel(model) { return priceFor(model) !== null; }

// ── Input-token upper bound ─────────────────────────────────────────────────────────────────────
// The reservation must be a HARD upper bound, so it cannot rest on a chars-per-token guess (CJK text, base64, long digit strings and emoji
// all run close to one token per character or worse). A byte-level tokenizer can never emit more tokens than the UTF-8 BYTES it is given, so
// the bound is: UTF-8 byte length of the serialized request body, plus a fixed overhead for the provider's own wrapping (tool and system
// scaffolding added server-side, message framing). Real English text is about 4 bytes per token, so this over-reserves by 3 to 4 times on
// ordinary prompts; that is the price of a bound that cannot be wrong. Actual cost is charged from the response's usage block.
export const INPUT_OVERHEAD_TOKENS = 1000;

const ENCODER = new TextEncoder();
export function utf8Bytes(text) { return ENCODER.encode(String(text)).length; }

export function estimateInputTokensFromBytes(bytes) {
  const n = Number(bytes);
  return (Number.isFinite(n) && n > 0 ? Math.ceil(n) : 0) + INPUT_OVERHEAD_TOKENS;
}

// A usage block is trusted only if the two required counts are non-negative integers and any cache counts present are too.
const isCount = (v) => Number.isSafeInteger(v) && v >= 0;
export function validateUsage(usage) {
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return { ok: false, reason: "usage not an object" };
  if (!isCount(usage.input_tokens)) return { ok: false, reason: "input_tokens" };
  if (!isCount(usage.output_tokens)) return { ok: false, reason: "output_tokens" };
  for (const k of ["cache_read_input_tokens", "cache_creation_input_tokens"]) {
    if (usage[k] != null && !isCount(usage[k])) return { ok: false, reason: k };
  }
  return { ok: true };
}

function tokenCount(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

// Actual cost of a response from its usage block. Throws DeskPriceError('unknown_model') for an unpriced model and
// DeskPriceError('bad_usage') for any usage block that fails validateUsage: it never prices a malformed block as zero.
export function costUsd(model, usage) {
  const p = priceFor(model);
  if (!p) throw new DeskPriceError("unknown_model", `no price for model "${String(model).slice(0, 60)}"`);
  const v = validateUsage(usage);
  if (!v.ok) throw new DeskPriceError("bad_usage", `usage invalid: ${v.reason}`);
  return (usage.input_tokens * p.input + usage.output_tokens * p.output
    + (usage.cache_read_input_tokens || 0) * p.cacheRead + (usage.cache_creation_input_tokens || 0) * p.cacheWrite) / 1e6;
}

// Upper bound for a call before it is made: EVERY input token at the full input rate (or the cache-write rate when the request uses
// prompt caching, which can be higher) plus EVERY allowed output token. Throws DeskPriceError('unknown_model') for an unpriced model.
export function estimateWorstCaseUsd({ model, inputTokensEstimate, maxOutputTokens, usesCache } = {}) {
  const p = priceFor(model);
  if (!p) throw new DeskPriceError("unknown_model", `no price for model "${String(model).slice(0, 60)}"`);
  const inRate = usesCache ? Math.max(p.input, p.cacheWrite, p.cacheRead) : p.input;
  return (tokenCount(inputTokensEstimate) * inRate + tokenCount(maxOutputTokens) * p.output) / 1e6;
}
