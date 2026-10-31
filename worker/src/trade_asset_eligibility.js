// trade_asset_eligibility.js — the SERVER side of trade asset eligibility for players (Keith's rulings 2 and 3, 2026-10-28, #1385).
//
// The rule itself is ONE pure function shared with the Front Office builder and the Trade War Room (trade_rules.js
// tradeAssetEligibility). This module only loads its authoritative inputs and reports a stable refusal:
//   contract   MFL rosters export: contractYear (years remaining) + contractStatus — canon §A6: 1+ years left; an expired ROOKIE only
//              until the rookie-extension deadline; an expired veteran never. A blank contractYear is unstamped (not "expired").
//   tag        D1 ups_tag_master (+ MFL contractStatus "Tag") for WHO is tagged; D1 ups_tag_submissions.locked_in_at for an EARLY lock-in
//              (§C8); the tag deadline (trade_rules.js tagDeadlineUtcMs, = the worker's getTagDeadlineUtc) for the deadline lock.
//              A PROVISIONAL tag (tagged, not locked, before the deadline) can't be traded. After the deadline every tag is locked, so
//              tradeability no longer depends on the tag rows and nothing is read from D1 at all.
//   picks      round 6 / beyond next year: trade_accept_integrity.js pickEligibilityViolations (the same shared rule); lineup-penalty
//              forfeits: lineup_forfeits.js checkForfeitedPicks. Neither changes here.
// FAIL CLOSED: before the deadline, a tag source that can't be read refuses every player (503 trade_eligibility_unavailable),
// never "not tagged". A missing locked_in_at column or submissions table means no early lock was ever recorded: the tag stays
// PROVISIONAL (stricter), never unlocked.
//
// Codes (stable):  409 player_not_tradeable          violations[].reason = tag_provisional | expired_veteran | expired_rookie_deadline_passed
//                  503 trade_eligibility_unavailable violations[].reason = tag_status_unavailable | rookie_deadline_unavailable
import { tradeAssetEligibility, tagTradeState, tagDeadlineUtcMs } from "./trade_rules.js";

const s = (v) => String(v == null ? "" : v).trim();
const digits = (v) => s(v).replace(/\D/g, "");

export const PLAYER_NOT_TRADEABLE_MSG = "A player in this trade can't be traded right now (a tag that isn't locked yet, or an expired contract). Remove him and try again.";
export const ELIGIBILITY_UNAVAILABLE_MSG = "We couldn't confirm the players in this trade are tradeable right now. Try again in a moment.";
const UNAVAILABLE_REASONS = ["tag_status_unavailable", "rookie_deadline_unavailable"];

// D1 timestamps are "YYYY-MM-DD HH:MM:SS" (UTC) or ISO; a bare date is that day at 00:00 UTC.
export function parseUtcMs(v) {
  const t = s(v);
  if (!t) return NaN;
  const iso = t.replace(" ", "T");
  return Date.parse(/Z$|[+-]\d\d:?\d\d$/.test(iso) || !/T/.test(iso) ? iso : iso + "Z");
}

/**
 * Tag facts for one league/season, as of `nowMs`. `pids` (optional) limits the reads to those players (index: season, player_id).
 * { ok, afterDeadline, deadlineMs, tagged: Set|null, lockedInAt: Map pid→ms }.  tagged === null ⇒ unreadable (fail closed).
 */
export async function loadTagFacts(db, { leagueId, season, nowMs, pids } = {}) {
  const deadlineMs = tagDeadlineUtcMs(season);
  const lockedInAt = new Map();
  if (!Number.isFinite(deadlineMs) || !Number.isFinite(Number(nowMs))) return { ok: false, afterDeadline: false, deadlineMs, tagged: null, lockedInAt };
  if (Number(nowMs) > deadlineMs) return { ok: true, afterDeadline: true, deadlineMs, tagged: null, lockedInAt };
  if (!db) return { ok: false, afterDeadline: false, deadlineMs, tagged: null, lockedInAt };
  const ids = Array.isArray(pids) ? [...new Set(pids.map(digits).filter(Boolean))] : null;
  if (ids && !ids.length) return { ok: true, afterDeadline: false, deadlineMs, tagged: new Set(), lockedInAt };
  const inList = ids && ids.length <= 90 ? ` AND player_id IN (${ids.map(() => "?").join(",")})` : "";
  const binds = inList ? ids : [];
  let tagged;
  try {
    const q = await db.prepare(`SELECT player_id FROM ups_tag_master WHERE season = ? AND league_id = ?${inList}`).bind(s(season), s(leagueId), ...binds).all();
    tagged = new Set((q && q.results || []).map((r) => digits(r && r.player_id)).filter(Boolean));
  } catch (_) {
    return { ok: false, afterDeadline: false, deadlineMs, tagged: null, lockedInAt };
  }
  if (tagged.size) {
    try {
      const q = await db.prepare(
        `SELECT player_id, locked_in_at FROM ups_tag_submissions WHERE season = ? AND league_id = ? AND action = 'tag' AND COALESCE(dry_run, 0) = 0 AND locked_in_at IS NOT NULL${inList}`
      ).bind(s(season), s(leagueId), ...binds).all();
      for (const r of (q && q.results) || []) {
        const pid = digits(r && r.player_id), ms = parseUtcMs(r && r.locked_in_at);
        if (pid && Number.isFinite(ms) && (!lockedInAt.has(pid) || ms < lockedInAt.get(pid))) lockedInAt.set(pid, ms);
      }
    } catch (e) {
      // Never recorded ⇒ no early lock (the tag stays provisional — stricter). Any other failure: unreadable.
      if (!/no such (column: locked_in_at|table: ups_tag_submissions)/i.test(s(e && e.message))) return { ok: false, afterDeadline: false, deadlineMs, tagged: null, lockedInAt };
    }
  }
  return { ok: true, afterDeadline: false, deadlineMs, tagged, lockedInAt };
}

/** The tag state of one player from the facts above and his MFL contractStatus. */
export function playerTagState(facts, pid, contractStatus, nowMs) {
  const byStatus = /(^|[^a-z])tag(ged)?([^a-z]|$)/i.test(s(contractStatus));
  const f = facts || {};
  const tagged = f.afterDeadline ? byStatus : f.tagged ? (f.tagged.has(digits(pid)) || byStatus) : null;
  return tagTradeState({ tagged, lockedInAtMs: f.lockedInAt ? f.lockedInAt.get(digits(pid)) : null, deadlineMs: f.deadlineMs, nowMs });
}

/** The shared rule's answer for one rostered player. `contract` = { years, status } from MFL rosters. */
export function playerEligibility({ facts, pid, contract, season, nowMs }) {
  const c = contract || {};
  return tradeAssetEligibility(
    { kind: "player", years: c.years, contract_status: c.status, tag_state: playerTagState(facts, pid, c.status, nowMs) },
    { season, nowMs, rookieDeadlineMs: facts && facts.deadlineMs });
}

/** Pure: every player token (bare MFL id) in `byFranchise` that the shared rule refuses. Players not on a roster are the ownership check's job. */
export function playerEligibilityViolations({ byFranchise, contracts, facts, season, nowMs }) {
  const bad = [];
  for (const [fid, tokens] of Object.entries(byFranchise || {})) {
    for (const tok of tokens || []) {
      if (!/^\d+$/.test(s(tok))) continue;
      const c = contracts && contracts[tok];
      if (!c) continue;
      const e = playerEligibility({ facts, pid: tok, contract: c, season, nowMs });
      if (!e.tradeable) bad.push({ token: tok, sender: fid, reason: e.code, message: e.reason });
    }
  }
  return bad;
}

/** Refusal shape for a list of violations: { ok:true } | { ok:false, http, code, message, violations }. */
export function eligibilityVerdict(violations) {
  if (!violations || !violations.length) return { ok: true };
  if (violations.some((v) => UNAVAILABLE_REASONS.includes(v.reason))) return { ok: false, http: 503, code: "trade_eligibility_unavailable", message: ELIGIBILITY_UNAVAILABLE_MSG, violations };
  return { ok: false, http: 409, code: "player_not_tradeable", message: PLAYER_NOT_TRADEABLE_MSG, violations };
}

/**
 * THE gate the preview, every create and every accept call. `rosters` = trade_accept_integrity.js indexRosters(...) (its `contract` map).
 * Reads D1 only when a player is in the trade AND the tag deadline has not passed.
 */
export async function playerEligibilityGate({ db, leagueId, season, nowMs, byFranchise, rosters }) {
  const pids = Object.values(byFranchise || {}).flat().filter((t) => /^\d+$/.test(s(t)));
  if (!pids.length) return { ok: true };
  const facts = await loadTagFacts(db, { leagueId, season, nowMs, pids });
  return eligibilityVerdict(playerEligibilityViolations({ byFranchise, contracts: (rosters && rosters.contract) || {}, facts, season, nowMs }));
}

// Ruling 3 helpers: the inputs of an expired rookie's cap-money basis.
// Year-1 salary (dollars) of a STORED extension request: its contract info "Y1-14K" (the canonical price; the accept/create re-price
// refuses any request whose stored terms differ), else new_aav_current. null when neither is readable.
export function extensionYear1Dollars(req) {
  const m = /\bY1-\$?([\d.,]+)\s*(K)?/i.exec(s(req && (req.preview_contract_info_string || req.new_contract_info)));
  if (m) { const n = Number(m[1].replace(/,/g, "")); if (Number.isFinite(n)) return Math.round(m[2] || n < 1000 ? n * 1000 : n); }
  const a = Number(req && req.new_aav_current);
  return Number.isFinite(a) && a > 0 ? Math.round(a < 1000 ? a * 1000 : a) : null;
}
/** {pid → year-1 dollars} for the extension requests a trade carries (unreadable rows are left out ⇒ that player's basis is unavailable). */
export function extensionYear1ByPlayer(extensionRequests) {
  const out = {};
  for (const r of Array.isArray(extensionRequests) ? extensionRequests : []) {
    const pid = digits(r && r.player_id);
    if (!pid) continue;
    const y = extensionYear1Dollars(r);
    out[pid] = y;   // null ⇒ requested but unreadable: the basis is unavailable, never the prior salary
  }
  return out;
}
/** MFL salaries export of the PRIOR season → {pid → salary dollars} (blank salary left out). */
export function priorSalariesFromExport(data) {
  const raw = data && data.salaries && data.salaries.leagueUnit && data.salaries.leagueUnit.player;
  const out = {};
  for (const p of Array.isArray(raw) ? raw : raw ? [raw] : []) {
    const pid = digits(p && p.id), sal = s(p && p.salary);
    if (pid && sal !== "" && Number.isFinite(Number(sal))) out[pid] = Number(sal);
  }
  return out;
}
