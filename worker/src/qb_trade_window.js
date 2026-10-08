// qb_trade_window.js — WHEN the five-active-QB trade limit applies (Keith 2026-10-08: "in-season only, consistent
// with the league rule … Do not make its applicability depend solely on whether someone toggled MFL's setting").
// Pure: the caller reads the league's contract-deadline calendar and the NFL schedule and passes them in.
//
// The boundaries, from canon (docs/league_context_v1.md):
//   START — the September contract deadline. §B1: the 5-QB active-roster maximum is "measured as of the September
//           contract deadline"; §C2 defines that day as "the last Sunday before NFL Week 1"; the season calendar
//           (2026: Sun 2026-09-06) calls it the "last day" for MYAC / extensions / restructures and the day the roster
//           max drops 35 → 30. The INSTANT is the league's configured deadline — the one the extension/MYAC lockout
//           already enforces (resolveContractDeadlineUtc; 2026: the commissioner's calendar holds 2026-09-06T23:59 ET).
//           With nothing configured it is derived from the rule itself: 23:59 ET (the end of that last day) on the
//           last Sunday before the season's first Week-1 kickoff.
//   END   — the end of the fantasy season = the end of NFL Week 17. Calendar (December → Fantasy Playoffs): "By end of
//           Week 17 (regular season end)"; §A1: limits "turn OFF at season end"; history: the "trade window opened
//           immediately after season end". The instant is the LAST Week-17 kickoff + SEASON_END_GAME_SEC.
// In between, the trade deadline (Thanksgiving kickoff) closes trading until the offseason, so in practice the
// limit binds War Room trades from the contract deadline to the trade deadline. Before the deadline (offseason,
// FA Auction, preseason) and after Week 17 there is no five-QB trade limit.
// FAILS CLOSED: a boundary that can't be established (and matters for `now`) is `unknown` — the gate reports
// "unavailable", which refuses an accept (never a send) exactly like every other unreadable gate input.

export const CONTRACT_DEADLINE_TIME_ET = "23:59";
export const SEASON_END_GAME_SEC = 4 * 3600;

const DAY = 86400;

/** 23:59 ET on the last Sunday before the earliest Week-1 kickoff (September is always EDT, UTC-4). */
export function contractDeadlineFromWeek1(week1Kickoffs) {
  const ks = Object.values(week1Kickoffs || {}).map(Number).filter((k) => k > 0);
  if (!ks.length) return null;
  const first = Math.min(...ks);
  const etDay = new Date((first - 4 * 3600) * 1000);           // the kickoff's calendar day in ET
  let back = etDay.getUTCDay() === 0 ? 7 : etDay.getUTCDay();   // strictly BEFORE: a Sunday kickoff steps back a week
  const sunday = new Date(Date.UTC(etDay.getUTCFullYear(), etDay.getUTCMonth(), etDay.getUTCDate() - back));
  const [hh, mm] = CONTRACT_DEADLINE_TIME_ET.split(":").map(Number);
  return Math.floor(sunday.getTime() / 1000) + (hh + 4) * 3600 + mm * 60;
}

/** The fantasy season's end: the last NFL Week-17 kickoff plus the time it takes to finish that game. */
export function seasonEndFromWeek17(week17Kickoffs) {
  const ks = Object.values(week17Kickoffs || {}).map(Number).filter((k) => k > 0);
  return ks.length ? Math.max(...ks) + SEASON_END_GAME_SEC : null;
}

/**
 * @param a.nowUnix
 * @param a.contractDeadlineUnix  the league's configured deadline, or null if none is configured
 * @param a.calendarError         true when the league calendar could not be READ (≠ not configured)
 * @param a.week1Kickoffs / a.week17Kickoffs  { NFL team -> kickoff unix }, or null/{} when unreadable
 * @returns { state: "before_season"|"in_season"|"after_season"|"unknown", applies: boolean|null, start_unix, end_unix, start_source, reason }
 */
export function qbTradeLimitWindow(a) {
  const now = Number(a && a.nowUnix) || 0;
  if (a && a.calendarError) return { state: "unknown", applies: null, start_unix: null, end_unix: null, start_source: "error", reason: "contract_calendar_unreadable" };
  let start = Number(a && a.contractDeadlineUnix) > 0 ? Number(a.contractDeadlineUnix) : null;
  const source = start ? "league_calendar" : "derived_last_sunday_before_week1";
  if (!start) start = contractDeadlineFromWeek1(a && a.week1Kickoffs);
  if (!start) return { state: "unknown", applies: null, start_unix: null, end_unix: null, start_source: "none", reason: "contract_deadline_unknown" };
  if (now < start) return { state: "before_season", applies: false, start_unix: start, end_unix: null, start_source: source, reason: "" };
  const end = seasonEndFromWeek17(a && a.week17Kickoffs);
  if (!end) return { state: "unknown", applies: null, start_unix: start, end_unix: null, start_source: source, reason: "week17_schedule_unreadable" };
  if (end <= start + 60 * DAY) return { state: "unknown", applies: null, start_unix: start, end_unix: end, start_source: source, reason: "season_end_implausible" };
  return now < end
    ? { state: "in_season", applies: true, start_unix: start, end_unix: end, start_source: source, reason: "" }
    : { state: "after_season", applies: false, start_unix: start, end_unix: end, start_source: source, reason: "" };
}
