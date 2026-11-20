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

// Deliberately pessimistic: one token per 3 characters (real English text is nearer 4; JSON and numbers are denser).
export function estimateTokens(chars) {
  const n = Number(chars);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.ceil(n / 3);
}

function tokenCount(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; }

// Actual cost of a response from its usage block. Throws DeskPriceError('unknown_model') for an unpriced model and
// DeskPriceError('bad_usage') when usage is not an object. Never returns NaN.
export function costUsd(model, usage) {
  const p = priceFor(model);
  if (!p) throw new DeskPriceError("unknown_model", `no price for model "${String(model).slice(0, 60)}"`);
  if (!usage || typeof usage !== "object") throw new DeskPriceError("bad_usage", "usage block missing");
  const inTok = tokenCount(usage.input_tokens), outTok = tokenCount(usage.output_tokens);
  const crTok = tokenCount(usage.cache_read_input_tokens), cwTok = tokenCount(usage.cache_creation_input_tokens);
  return (inTok * p.input + outTok * p.output + crTok * p.cacheRead + cwTok * p.cacheWrite) / 1e6;
}

// Upper bound for a call before it is made: EVERY input token at the full input rate (or the cache-write rate when the request uses
// prompt caching, which can be higher) plus EVERY allowed output token. Throws DeskPriceError('unknown_model') for an unpriced model.
export function estimateWorstCaseUsd({ model, inputTokensEstimate, maxOutputTokens, usesCache } = {}) {
  const p = priceFor(model);
  if (!p) throw new DeskPriceError("unknown_model", `no price for model "${String(model).slice(0, 60)}"`);
  const inRate = usesCache ? Math.max(p.input, p.cacheWrite, p.cacheRead) : p.input;
  return (tokenCount(inputTokensEstimate) * inRate + tokenCount(maxOutputTokens) * p.output) / 1e6;
}
