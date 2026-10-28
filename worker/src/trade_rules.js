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

// ── Trade ELIGIBILITY of one asset (Keith's rulings 2 and 3, 2026-10-28, on #1385) ─────────────────────────────────────
// ONE rule for the Front Office builder, the Trade War Room and every worker gate (preview, create, accept). Each caller reads
// its own authoritative inputs (MFL rosters / picks, D1 tag rows, the lineup-penalty forfeit list) and hands them here; this
// decides. A `code` is a stable machine code; `reason` is the short owner text shown BESIDE a disabled item.
//   canon §A6 (and Section 2 T1.7): 1+ years left; an expired ROOKIE only up to the rookie-extension deadline; expired veterans no;
//   round-6 picks no; future picks this year + 1 only. §C8: a tag locked early, or locked at the deadline, is final and tradeable;
//   a tag not yet locked (PROVISIONAL) is not (ruling 2). Once tagged, no team may extend him (§C8, §A6) → `extendable: false`.
//   §G3 (lineup_forfeits.js): a pick a lineup penalty has taken is not tradeable.
export const TRADE_REASONS = {
  pick_round_6: "6th-round picks can't be traded.",
  pick_beyond_next_year: "Only this year's and next year's picks can be traded.",
  pick_forfeited: "Forfeited — lineup penalty.",
  pick_unreadable: "This pick couldn't be identified.",
  pick_forfeit_unverified: "Forfeit check unavailable. The server rechecks before anything is sent.",
  tag_provisional: "Provisional tag: not locked yet, so it can't be traded.",
  tag_status_unavailable: "Tag status unavailable, so it can't be traded right now.",
  expired_veteran: "Expired veteran contract: can't be traded.",
  expired_rookie_deadline_passed: "Expired rookie: the extension deadline has passed.",
  rookie_deadline_unavailable: "Expired rookie: the extension deadline couldn't be read.",
  expired_rookie_window: "Expired rookie: tradeable until the extension deadline.",
  tag_locked_no_extension: "Locked tag: tradeable, but it can't be extended.",
};

// The tag / rookie-extension deadline (canon Section 3 "Tag Deadline + Rookie Draft"): midnight ET on the Thursday → Friday
// boundary before Memorial Day = 04:00 UTC on that Friday (late May is always EDT). Same instant as the worker's
// getTagDeadlineUtc(); "passed" means strictly after it. NaN for an unreadable season.
export function tagDeadlineUtcMs(season) {
  const year = Number(season);
  if (!Number.isFinite(year) || year < 2000) return NaN;
  const d = new Date(Date.UTC(year, 4, 31));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));   // last Monday in May
  return Date.UTC(year, 4, d.getUTCDate() - 3, 4, 0, 0, 0);
}

// Where a tag stands right now. `tagged` true / false, or null when the tag source could not be read. `lockedInAtMs` = when
// the owner locked it in early (ups_tag_submissions.locked_in_at), NaN/null if never. Returns
//   "none" | "provisional" (tagged, not locked) | "early_locked" | "deadline_locked" (the deadline has passed) | "unavailable".
export function tagTradeState({ tagged, lockedInAtMs, deadlineMs, nowMs } = {}) {
  if (tagged === false) return "none";
  if (tagged !== true) return "unavailable";
  const now = Number(nowMs), deadline = Number(deadlineMs);
  if (!Number.isFinite(now) || !Number.isFinite(deadline)) return "unavailable";
  if (now > deadline) return "deadline_locked";
  const lock = lockedInAtMs == null || lockedInAtMs === "" ? NaN : Number(lockedInAtMs);
  if (Number.isFinite(lock) && lock <= now) return "early_locked";
  return "provisional";
}

// A rookie contract for the expiry rule (MFL contractStatus "Rookie-…"; the War Room shows a taxi rookie as "Taxi").
export function isRookieContractStatus(status) {
  return /^(rookie|taxi)/i.test(String(status == null ? "" : status).trim());
}
// Years remaining from MFL's contractYear: a number, or null when MFL has none stamped (a blank contract is unresolved,
// never 0, so it is NOT read as expired; canon §A3 auto-drops an expired blank rookie at the deadline).
export function contractYearsLeft(years) {
  if (years == null || String(years).trim() === "") return null;
  const n = Number(years);
  return Number.isFinite(n) ? n : null;
}

//   asset = { kind: "pick", year, round, forfeit: true | false | null (null = the forfeit list could not be read), forfeit_label? }
//         | { kind: "player", years, contract_status, tag_state }   (tag_state from tagTradeState; absent on a tag contract = unavailable)
//   ctx   = { season, nowMs, rookieDeadlineMs }
// → { tradeable, code, reason, extendable (false = refused here, null = not decided here), extension_code, extension_reason,
//     warning_code, warning, expired_rookie }
export function tradeAssetEligibility(asset, ctx) {
  const a = asset || {}, c = ctx || {};
  const out = (tradeable, code, extra) => Object.assign({ tradeable, code: code || "", reason: code ? TRADE_REASONS[code] || "" : "", extendable: null, extension_code: "", extension_reason: "", warning_code: "", warning: "", expired_rookie: false }, extra || {});
  if (a.kind === "pick") {
    const year = Number(a.year), round = Number(a.round), season = Number(c.season);
    if (!Number.isFinite(year) || !Number.isFinite(round) || round < 1) return out(false, "pick_unreadable");
    if (round >= 6) return out(false, "pick_round_6");
    if (Number.isFinite(season) && year > season + 1) return out(false, "pick_beyond_next_year");
    if (a.forfeit === true) return out(false, "pick_forfeited", a.forfeit_label ? { reason: String(a.forfeit_label) } : null);
    if (a.forfeit !== false) return out(true, "", { warning_code: "pick_forfeit_unverified", warning: TRADE_REASONS.pick_forfeit_unverified });
    return out(true, "");
  }
  const status = String(a.contract_status == null ? "" : a.contract_status);
  const tag = a.tag_state || (/(^|[^a-z])tag(ged)?([^a-z]|$)/i.test(status) ? "unavailable" : "none");
  if (tag === "provisional") return out(false, "tag_provisional");
  if (tag !== "none" && tag !== "early_locked" && tag !== "deadline_locked") return out(false, "tag_status_unavailable");
  const locked = tag === "early_locked" || tag === "deadline_locked";
  const noExt = locked ? { extendable: false, extension_code: "tag_locked_no_extension", extension_reason: TRADE_REASONS.tag_locked_no_extension } : null;
  const years = contractYearsLeft(a.years);
  if (years == null || years >= 1) return out(true, "", noExt);
  if (!isRookieContractStatus(status)) return out(false, "expired_veteran");
  const deadline = Number(c.rookieDeadlineMs), now = Number(c.nowMs);
  if (!Number.isFinite(deadline) || !Number.isFinite(now)) return out(false, "rookie_deadline_unavailable");
  if (now > deadline) return out(false, "expired_rookie_deadline_passed");
  return out(true, "", Object.assign({ expired_rookie: true, warning_code: "expired_rookie_window", warning: TRADE_REASONS.expired_rookie_window }, noExt || {}));
}

// Ruling 3 (2026-10-28): the salary a traded player contributes to the §A6 50% cap-money limit. Normally his current salary
// (taxi = 0, unchanged). For an EXPIRED ROOKIE (no current-season salary yet): the NEW current-season salary when a
// pre-trade extension is included (`extensionYear1`), otherwise his PRIOR-season salary. null = that figure is unavailable
// (the caller fails closed: it counts nothing for him and the server re-verifies).
export function capMoneyBasisDollars(player, opts) {
  const p = player || {}, o = opts || {};
  if (p.taxi) return 0;
  const years = contractYearsLeft(p.years);
  if (years != null && years < 1 && isRookieContractStatus(p.contract_status)) {
    const pick = o.extensionYear1 != null ? o.extensionYear1 : o.priorSeasonSalary;
    const n = pick == null || pick === "" ? NaN : Number(pick);
    return Number.isFinite(n) && n >= 0 ? n : null;
  }
  return Number(p.salary) || 0;
}
