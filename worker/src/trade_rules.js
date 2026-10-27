// trade_rules.js — trade arithmetic and asset-token parsing the worker and browsers share in ONE place
// (Trade Builder P1: only rules that were already identical on both sides). A future Front Office trade
// builder reads the same functions.
//
//   Browser twin: site/shared/trade_rules.js (window.UPS_TRADE_RULES / module.exports), generated from this file by
//   `node scripts/generate_shared_trade_rules.mjs`. tests/trade_rules.test.mjs fails if the two bodies differ by a byte.
//
// Arithmetic and three-team asset-token parsing are shared. Every caller still decides its own inputs exactly as before — which players count as
// non-taxi salary, which count as on IR, what a blank contract is. Those inputs differ between the worker and the War
// Room today; the differences are preserved and pinned in tests/trade_rules.test.mjs ("preserved — change only with
// Keith's approval").
//
// Pure functions: no fetch, no env, no DOM. Everything from the first `export` down is copied into the browser twin.

export const IR_RELIEF_RATE = 0.5;   // canon B3: a player on INJURED_RESERVE counts half his salary against the cap

// Canon §A6: cap money a side may attach ≤ 50% of the salary of the NON-TAXI players it trades away, in whole $K,
// rounded down → floor(dollars / 2000). $9,999 → 4 ($4K); $10,000 → 5. The caller sums the salary.
export function capMoneyMaxK(nonTaxiSalaryDollars) {
  return Math.floor(nonTaxiSalaryDollars / 2000);
}

// Canon B3: an IR player's cap hit = half his salary, rounded to the dollar (Math.round: a half rounds up).
// The caller decides whether the player is on IR.
export function irCapHit(salaryDollars) {
  return Math.round(salaryDollars * IR_RELIEF_RATE);
}

// The hard salary cap: over only when STRICTLY above it — landing exactly at the cap is allowed.
export function isOverCap(totalDollars, capDollars) {
  return totalDollars > capDollars;
}

// The existing three-team builder token grammar. Preserve its result shape and its treatment of malformed tokens;
// the Front Office builder will use the same parser rather than interpreting picks or cap money independently.
export function parseAssetToken(token) {
  const t = String(token == null ? "" : token).trim();
  let m;
  if ((m = /^P_(\d+)$/.exec(t))) return { token: t, kind: "player", player_id: m[1] };
  if (t.startsWith("FP_")) {
    const parts = t.slice(3).split("_").filter(Boolean);
    const year = parts.find((p) => /^20\d\d$/.test(p)) || "";
    const rest = parts.filter((p) => p !== year);
    const orig = rest.find((p) => p.length === 4) || rest[0] || "";
    const round = rest.find((p) => p !== orig) || "";
    if (year && /^\d{1,2}$/.test(round) && /^\d{4}$/.test(orig)) {
      return { token: t, kind: "pick", pick: { year: Number(year), round: Number(round), slot: null, original_fid: orig } };
    }
    return { token: t, kind: "unknown" };
  }
  if ((m = /^DP_(20\d\d)_(\d{1,2})_(\d{1,2})$/.exec(t))) {
    return { token: t, kind: "pick", pick: { year: Number(m[1]), round: Number(m[2]), slot: Number(m[3]), original_fid: "" } };
  }
  if ((m = /^BB_(\d+)$/.exec(t))) return { token: t, kind: "cap", cap_k: Math.round(Number(m[1]) / 1000) };
  return { token, kind: "unknown" };
}

// Existing two-team accept comparison: MFL may represent a player as P_<id> or a bare id, and may pad draft slots.
// This normalization compares an owner's claim with MFL's offer; it does not decide eligibility.
export function normalizeTradeToken(t) {
  let x = String(t == null ? "" : t).trim().toUpperCase();
  if (!x) return "";
  const bb = /^BB_(.+)$/.exec(x);
  if (bb) { const n = Number(bb[1].replace(/,/g, "")); return Number.isFinite(n) ? `BB_${n}` : x; }
  if (/^P_\d+$/.test(x)) x = x.slice(2);
  const dp = /^DP_(\d+)_(\d+)$/.exec(x);
  if (dp) return `DP_${Number(dp[1])}_${Number(dp[2])}`;
  return x;
}

export function tradeTokenSet(list) {
  const src = Array.isArray(list) ? list : String(list == null ? "" : list).trim().split(/\s*,\s*/);
  return [...new Set(src.map(normalizeTradeToken).filter(Boolean))].sort();
}
