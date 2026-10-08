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

import { getAuctionCalendar } from "./auction_calendar.js";
import { etWallToUnix, etDayBoundsUnix, deadlineState } from "./contract_deadline.js";

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
  const base = { season: s(season), source: "none", exact: false, start_unix: null, day: "", day_start_unix: null, day_end_unix: null, error: "" };
  if (calendar && calendar.read_error) return { ...base, source: "error", error: `calendar_unreadable: ${calendar.read_error}` };
  const wall = s(calendar && calendar.faa && calendar.faa.faa_open_at), calSeason = s(calendar && calendar.season);
  if (wall && (!calSeason || calSeason === s(season))) {
    const start = etWallToUnix(wall);
    if (start == null) return { ...base, source: "error", error: `faa_open_at malformed: "${wall}"` };
    return { ...base, source: "calendar", exact: true, start_unix: start, day: wall.slice(0, 10) };
  }
  if (eventError) return { ...base, source: "error", error: `league_events_unreadable: ${eventError}` };
  const b = etDayBoundsUnix(eventDay);
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
  if (cd === "unknown") missing.push(cdRes.source === "error" ? "contract_deadline_unreadable" : cdRes.source === "league_events_day" ? "contract_deadline_time_not_set" : "contract_deadline_not_set");
  if (au === "unknown" && candidates.includes("offseason") && candidates.includes("auction")) missing.push(auRes.source === "error" ? "auction_start_unreadable" : auRes.source === "league_events_day" ? "auction_start_time_not_set" : "auction_start_not_set");
  if (plausibleEnd == null && candidates.includes("in_season") && candidates.includes("offseason")) missing.push(end == null ? "week17_schedule_unreadable" : "week17_schedule_implausible");
  return {
    phase, candidates,
    roster_max: phase === "unknown" ? null : PHASES[phase].roster_max,
    qb_limit: phase === "unknown" ? null : PHASES[phase].qb_limit,
    boundaries: {
      auction_start_unix: auRes.exact ? auRes.start_unix : null, auction_start_day: auRes.day || "", auction_start_source: auRes.source || "none",
      contract_deadline_unix: cdRes.exact ? cdRes.deadline_unix : null, contract_deadline_day: cdRes.day || "", contract_deadline_source: cdRes.source || "none",
      season_end_unix: plausibleEnd,
    },
    reason: phase === "unknown" ? missing.join(",") : "",
  };
}

/** The limit a gate must apply when the phase is unknown: the STRICTEST and the most LENIENT maximum across the candidates
 * (null = no limit). A trade under `strict` is fine whatever the phase; one over `lenient` is over whatever the phase. */
export function candidateRosterMaxes(win) {
  const maxes = (win && win.candidates ? win.candidates : []).map((p) => PHASES[p].roster_max);
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
