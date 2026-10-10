// trade_season_window.js — WHICH roster limits a War Room trade is held to RIGHT NOW (Keith 2026-10-08).
// Pure; the loader at the bottom reads the league calendar + league_events (read-only). The NFL schedule is passed in.
//
// From canon (docs/league_context_v1.md):
//   offseason   — before the FA Auction starts, and after the fantasy season ends: "there is no cap ceiling and no roster
//                 limit at all" (§G4). No roster maximum, no five-QB trade limit.
//   auction     — from the FA Auction start to the September contract deadline: maximum 35 (§B1 "35 until the September
//                 contract deadline"; "Auction window: 27 – 35"). No five-QB trade limit (that rule is in-season).
//   in_season   — from the September contract deadline to the end of NFL Week 17: maximum 30, five-active-QB trade limit.
// Boundaries — the LEAGUE CALENDAR, never MFL's own roster/position settings:
//   FA Auction start   calendar faa_open_at (exact; limits apply from that minute), else the league_events
//                      ups_fa_auction_start DATE at day precision; nothing is invented.
//   contract deadline  the ONE resolver, contract_deadline.js (2026: 23:59 ET, open through 23:59:59).
//   season end         the last NFL Week-17 kickoff + SEASON_END_GAME_SEC.
// When a boundary can't be established, `phase` is "unknown" and `candidates` lists every phase still possible. The gates
// then fail CLOSED only where it matters: a trade that fits every candidate's limit is fine; one that would break a
// candidate's limit is refused ("unavailable") until the calendar answers. Nothing is ever more permissive than the rule.

// A calendar value or league_events date from ANOTHER season (the one-season calendar re-saved with a new Season but an
// old date) is ignored, exactly as contract_deadline.js does — the FA Auction is always in its own season's July.

import { getAuctionCalendar } from "./auction_calendar.js";
import { etWallToUnix, etDayBoundsUnix, deadlineState, isOtherSeasonValue } from "./contract_deadline.js";

export const AUCTION_ROSTER_MAX = 35;
export const IN_SEASON_ROSTER_MAX = 30;
export const SEASON_END_GAME_SEC = 4 * 3600;
export const PHASES = Object.freeze({
  offseason: Object.freeze({ roster_max: null, qb_limit: false, label: "offseason (no roster limit)" }),
  auction: Object.freeze({ roster_max: AUCTION_ROSTER_MAX, qb_limit: false, label: "FA Auction → contract deadline (maximum 35)" }),
  in_season: Object.freeze({ roster_max: IN_SEASON_ROSTER_MAX, qb_limit: true, label: "in-season (maximum 30, five active QBs)" }),
});

const s = (v) => String(v == null ? "" : v).trim();

/** The FA Auction start for `season`: { source: "calendar"|"league_events_day"|"none"|"error", exact, start_unix, day, day_start_unix, day_end_unix, error }. */
export function resolveAuctionStart({ season, calendar, eventDay, eventError }) {
  const ignored = [];
  const base = { season: s(season), source: "none", exact: false, start_unix: null, day: "", day_start_unix: null, day_end_unix: null, error: "", ignored };
  if (calendar && calendar.read_error) return { ...base, source: "error", error: `calendar_unreadable: ${calendar.read_error}` };
  const wall = s(calendar && calendar.faa && calendar.faa.faa_open_at), calSeason = s(calendar && calendar.season);
  if (wall && (!calSeason || calSeason === s(season))) {
    if (!isOtherSeasonValue(wall, season)) {
      const start = etWallToUnix(wall);
      if (start == null) return { ...base, source: "error", error: `faa_open_at malformed: "${wall}"` };
      return { ...base, source: "calendar", exact: true, start_unix: start, day: wall.slice(0, 10) };
    }
    ignored.push(`calendar faa_open_at "${wall}" is not in season ${s(season)}`);
  }
  if (eventError) return { ...base, source: "error", error: `league_events_unreadable: ${eventError}` };
  const b = etDayBoundsUnix(eventDay);
  if (b && isOtherSeasonValue(eventDay, season)) { ignored.push(`league_events ups_fa_auction_start ${s(eventDay).slice(0, 10)} is not in season ${s(season)}`); return base; }
  return b ? { ...base, source: "league_events_day", day: s(eventDay).slice(0, 10), day_start_unix: b.start, day_end_unix: b.end } : base;
}
/** Has the FA Auction started? "after" | "before" | "unknown". */
export function auctionState(res, nowUnix) {
  const now = Number(nowUnix) || 0;
  if (!res || res.source === "error" || res.source === "none") return "unknown";
  if (res.exact) return now >= res.start_unix ? "after" : "before";
  if (now < res.day_start_unix) return "before";
  if (now > res.day_end_unix) return "after";
  return "unknown";
}
export function seasonEndFromWeek17(week17Kickoffs) {
  const ks = Object.values(week17Kickoffs || {}).map(Number).filter((k) => k > 0);
  return ks.length ? Math.max(...ks) + SEASON_END_GAME_SEC : null;
}

/**
 * @param a.nowUnix · a.auctionStart (resolveAuctionStart) · a.contractDeadline (contract_deadline.js) · a.week17Kickoffs
 * @returns { phase: "offseason"|"auction"|"in_season"|"unknown", candidates: [...], roster_max, qb_limit, boundaries, reason }
 */
export function tradeSeasonWindow(a) {
  const now = Number(a && a.nowUnix) || 0;
  const cd = deadlineState(a && a.contractDeadline, now);
  const au = auctionState(a && a.auctionStart, now);
  const end = seasonEndFromWeek17(a && a.week17Kickoffs);
  const cdRes = (a && a.contractDeadline) || {}, auRes = (a && a.auctionStart) || {};
  const plausibleEnd = end != null && (!cdRes.day_end_unix || end > cdRes.day_end_unix + 60 * 86400) ? end : null;   // a "Week 17" a day after the deadline isn't the real schedule
  let candidates;
  if (plausibleEnd != null && now >= plausibleEnd) candidates = ["offseason"];
  else if (cd === "after") candidates = plausibleEnd != null ? ["in_season"] : ["in_season", "offseason"];
  else if (cd === "before") candidates = au === "after" ? ["auction"] : au === "before" ? ["offseason"] : ["offseason", "auction"];
  else candidates = au === "before" ? ["offseason"] : au === "after" ? (plausibleEnd != null ? ["auction", "in_season"] : ["auction", "in_season", "offseason"]) : ["offseason", "auction", "in_season"];
  const phase = candidates.length === 1 ? candidates[0] : "unknown";
  const missing = [];
  const notSet = (res, prefix) => res.source === "error" ? `${prefix}_unreadable` : res.source === "league_events_day" ? `${prefix}_time_not_set`
    : (Array.isArray(res.ignored) && res.ignored.length) ? `${prefix}_other_season` : `${prefix}_not_set`;
  if (cd === "unknown") missing.push(notSet(cdRes, "contract_deadline"));
  if (au === "unknown" && candidates.includes("offseason") && candidates.includes("auction")) missing.push(notSet(auRes, "auction_start"));
  if (plausibleEnd == null && candidates.includes("in_season") && candidates.includes("offseason")) missing.push(end == null ? "week17_schedule_unreadable" : "week17_schedule_implausible");
  const season = s(cdRes.season || auRes.season);
  return {
    phase, candidates,
    roster_max: phase === "unknown" ? null : PHASES[phase].roster_max,
    qb_limit: phase === "unknown" ? null : PHASES[phase].qb_limit,
    boundaries: {
      auction_start_unix: auRes.exact ? auRes.start_unix : null, auction_start_day: auRes.day || "", auction_start_source: auRes.source || "none",
      contract_deadline_unix: cdRes.exact ? cdRes.deadline_unix : null, contract_deadline_day: cdRes.day || "", contract_deadline_source: cdRes.source || "none",
      season_end_unix: plausibleEnd,
      ignored: [...(Array.isArray(auRes.ignored) ? auRes.ignored : []), ...(Array.isArray(cdRes.ignored) ? cdRes.ignored : [])],
    },
    reason: phase === "unknown" ? missing.join(",") : "",
    // What an owner / the commissioner reads (2026-10-09): which input is missing, in words — and whether it is one the
    // commissioner enters on the league calendar (Commish Settings → Update League Calendar), so it never reads as "try again".
    reason_text: phase === "unknown" ? windowReasonText(missing, season) : "",
    calendar_input_missing: phase === "unknown" && missing.some((m) => CALENDAR_INPUT.test(m)),
  };
}

const CALENDAR_INPUT = /_(not_set|time_not_set|other_season)$/;
const REASON_TEXT = {
  contract_deadline_unreadable: (y) => `the ${y} contract deadline couldn't be read`,
  contract_deadline_time_not_set: (y) => `only the date of the ${y} contract deadline is on file, not its time`,
  contract_deadline_not_set: (y) => `the ${y} contract deadline isn't on the league calendar`,
  contract_deadline_other_season: (y) => `the league calendar's contract deadline is from another season, not ${y}`,
  auction_start_unreadable: (y) => `the ${y} FA Auction start couldn't be read`,
  auction_start_time_not_set: (y) => `only the date of the ${y} FA Auction start is on file, not its time`,
  auction_start_not_set: (y) => `the ${y} FA Auction start isn't on the league calendar`,
  auction_start_other_season: (y) => `the league calendar's FA Auction start is from another season, not ${y}`,
  week17_schedule_unreadable: (y) => `MFL's ${y} NFL Week 17 schedule couldn't be read`,
  week17_schedule_implausible: (y) => `MFL's ${y} NFL Week 17 schedule doesn't look like the real one`,
  window_load_failed: () => "the league calendar couldn't be read",
};
/** The `reason` codes as one plain sentence fragment ("the 2027 FA Auction start isn't on the league calendar; …"). */
export function windowReasonText(codes, season) {
  const y = s(season) || "this season's";
  const list = (Array.isArray(codes) ? codes : s(codes).split(",")).map(s).filter(Boolean);
  return list.map((c) => (REASON_TEXT[c] ? REASON_TEXT[c](y) : c.replace(/_/g, " "))).join("; ");
}
/** The sentence the gates append when the missing piece is a league-calendar input the commissioner enters. */
export const CALENDAR_FIX_TEXT = "The commissioner sets it in Commish Settings → Update League Calendar; until then a trade that depends on it can't be accepted.";

/** The limit a gate must apply when the phase is unknown: the STRICTEST and the most LENIENT maximum across the candidates
 * (null = no limit). A trade under `strict` is fine whatever the phase; one over `lenient` is over whatever the phase. */
export function candidateRosterMaxes(win) {
  // No (or no recognisable) candidate is "nothing is known", never "no limit": every phase stays possible (fail closed).
  const listed = (win && Array.isArray(win.candidates) ? win.candidates : []).filter((p) => PHASES[p]);
  const maxes = (listed.length ? listed : Object.keys(PHASES)).map((p) => PHASES[p].roster_max);
  const limited = maxes.filter((m) => m != null);
  return { strict: limited.length ? Math.min(...limited) : null, lenient: maxes.some((m) => m == null) ? null : (limited.length ? Math.max(...limited) : null) };
}

/** Read-only loader for the FA Auction start (no CREATE, no write). */
export async function loadAuctionStart(env, season) {
  if (!env || !env.UPS_MFL_DB) return resolveAuctionStart({ season, calendar: { read_error: "no_d1_binding" } });
  let calendar;
  try { calendar = await getAuctionCalendar(env, undefined, { readOnly: true }); } catch (e) { calendar = { read_error: s(e && e.message) || "threw" }; }
  let eventDay = null, eventError = "";
  try {
    const row = await env.UPS_MFL_DB.prepare("SELECT date FROM league_events WHERE nfl_season = ? AND event = 'ups_fa_auction_start' LIMIT 1").bind(s(season)).first();
    eventDay = row && row.date ? s(row.date) : null;
  } catch (e) { if (!/no such table/i.test(s(e && e.message))) eventError = s(e && e.message) || "threw"; }
  return resolveAuctionStart({ season, calendar, eventDay, eventError });
}
