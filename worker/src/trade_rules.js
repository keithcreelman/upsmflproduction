// trade_rules.js — trade arithmetic the worker and the desktop Trade War Room must agree on, kept in ONE place
// (Trade Builder P1, slice 1: only rules that were already identical on both sides). A future Front Office trade
// builder reads the same functions.
//
//   Browser twin: site/shared/trade_rules.js (window.UPS_TRADE_RULES / module.exports), generated from this file by
//   `node scripts/generate_shared_trade_rules.mjs`. tests/trade_rules.test.mjs fails if the two bodies differ by a byte.
//
// Only the ARITHMETIC is shared. Every caller still decides its own inputs exactly as before — which players count as
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
