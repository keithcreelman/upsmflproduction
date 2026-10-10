// contract_deadline.js — THE September contract deadline, for every consumer (Keith 2026-10-08: "Make consumers use one
// resolver and make the 2026 fallback agree with the approved time … Do not silently invent a time for a future season").
//
// Consumers: the veteran-extension / MYAC lockout, the restructure window (restructure_cap.js), the contract ladder (both
// copies in index.js), the extension-eligibility facts, the eligibility announcement, the calendar-save gate, and the
// season windows of the trade gates (trade_season_window.js). Before this module they held THREE different instants for
// 2026: 21:00 ET (the pinned fallback), 23:59:00 ET (the calendar) and 23:59:59 ET (the league_events day).
//
// Sources, in order — the first that has THIS season wins:
//   1. the commissioner's league calendar (ups_settings auction_calendar, faa.contract_deadline_at "YYYY-MM-DDTHH:MM" ET),
//      when its season is this season — an EXACT instant;
//   2. PINNED_CONTRACT_DEADLINE_ET — the approved value, exact (2026 only: 2026-09-06 23:59 ET, Keith 2026-10-08);
//   3. the league_events row ups_contract_deadline — a DATE only. Used at DAY precision and never given a time: before
//      that day the deadline has not passed, after it it has, ON the day the answer is "unknown" (callers fail closed);
//   4. none — no deadline is known, and none is invented ("unknown" everywhere).
// An unreadable calendar or league_events row is an ERROR ("unknown"), never "not configured".
//
// ANOTHER SEASON'S VALUE IS NOT THIS SEASON'S (review 2026-10-09). The calendar row holds ONE season and the
// Commish Settings panel re-sends every field on Save, so changing its Season to 2027 while leaving the contract
// deadline at "2026-09-06T23:59" stores a 2026 instant under season 2027 — and a Push then writes league_events rows
// for 2027 dated 2026-09-06. Taken at face value that makes 2027's deadline "already passed" all 2027 offseason
// (veteran extensions / MYAC / restructures locked, the trade gates in-season). The September deadline is always in
// its own season's year, so a calendar value or league_events date in any other year is IGNORED (listed in
// `ignored`) and the next source is tried — never used as this season's deadline.
//
// The instant: a configured deadline is a wall-clock MINUTE; the window stays open THROUGH the end of that minute. So the
// deadline instant is HH:MM:59 ET, "before" means now <= that second, "after" means now > it. For 2026 that is 23:59:59 ET
// — the second the restructure window, the contract ladder and the Front Office already used.

import { getAuctionCalendar } from "./auction_calendar.js";

export const PINNED_CONTRACT_DEADLINE_ET = Object.freeze({ "2026": "2026-09-06T23:59" });

const s = (v) => String(v == null ? "" : v).trim();
const WALL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Offset of America/New_York from UTC (hours, negative) at a given UTC instant — DST-aware, no library. */
function etOffsetHours(utcMs) {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour12: false, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
    .formatToParts(new Date(utcMs)).reduce((o, p) => (o[p.type] = p.value, o), {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return Math.round((asUtc - utcMs) / 3600000);
}
/** "YYYY-MM-DDTHH:MM" in ET → unix seconds of HH:MM:00 ET; null if malformed. */
export function etWallToUnix(wall) {
  const m = WALL.exec(s(wall));
  if (!m) return null;
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let off = etOffsetHours(naive - 5 * 3600000);
  let ms = naive - off * 3600000;
  const off2 = etOffsetHours(ms);
  if (off2 !== off) ms = naive - off2 * 3600000;
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}
/** The ET calendar day as [00:00:00, 23:59:59] unix seconds; null if malformed. */
export function etDayBoundsUnix(day) {
  const d = s(day).slice(0, 10);
  if (!DAY.test(d)) return null;
  const start = etWallToUnix(`${d}T00:00`), endMinute = etWallToUnix(`${d}T23:59`);
  return start == null || endMinute == null ? null : { start, end: endMinute + 59 };
}

/**
 * @param a.season
 * @param a.calendar  getAuctionCalendar() result (with read_error when unreadable), or null when not read
 * @param a.eventDay  league_events ups_contract_deadline `date` for this season, or null; a.eventError = unreadable
 * @returns { season, source: "calendar"|"pinned"|"league_events_day"|"none"|"error", exact, deadline_unix, day, day_start_unix, day_end_unix, wall_et, error }
 */
export function resolveContractDeadline(a) {
  const season = s(a && a.season);
  const ignored = [];
  const base = { season, source: "none", exact: false, deadline_unix: null, day: "", day_start_unix: null, day_end_unix: null, wall_et: "", error: "", ignored };
  const cal = a && a.calendar;
  if (cal && cal.read_error) return { ...base, source: "error", error: `contract_calendar_unreadable: ${cal.read_error}` };
  const exactFrom = (wall, source) => {
    const start = etWallToUnix(wall);
    if (start == null) return { ...base, source: "error", error: `contract_deadline_at malformed: "${wall}"` };
    const b = etDayBoundsUnix(wall.slice(0, 10));
    return { ...base, source, exact: true, deadline_unix: start + 59, day: wall.slice(0, 10), day_start_unix: b.start, day_end_unix: b.end, wall_et: wall };
  };
  const wall = s(cal && cal.faa && cal.faa.contract_deadline_at);
  const calSeason = s(cal && cal.season);
  if (wall && (!calSeason || calSeason === season)) {
    if (!isOtherSeasonValue(wall, season)) return exactFrom(wall, "calendar");
    ignored.push(`calendar contract_deadline_at "${wall}" is not in season ${season}`);
  }
  if (PINNED_CONTRACT_DEADLINE_ET[season]) return exactFrom(PINNED_CONTRACT_DEADLINE_ET[season], "pinned");
  if (a && a.eventError) return { ...base, source: "error", error: `league_events_unreadable: ${a.eventError}` };
  const b = etDayBoundsUnix(a && a.eventDay);
  if (b && isOtherSeasonValue(a.eventDay, season)) { ignored.push(`league_events ups_contract_deadline ${s(a.eventDay).slice(0, 10)} is not in season ${season}`); return base; }
  if (b) return { ...base, source: "league_events_day", day: s(a.eventDay).slice(0, 10), day_start_unix: b.start, day_end_unix: b.end };
  return base;
}

/** A "YYYY-…" calendar value / league_events date whose year is not `season`'s (a leftover from another season). A season
 * that isn't a 4-digit year can't be checked, so nothing is called stale then. */
export function isOtherSeasonValue(value, season) {
  const yr = s(season), v = s(value);
  return /^\d{4}$/.test(yr) && /^\d{4}-/.test(v) && v.slice(0, 4) !== yr;
}

/** "before" (the deadline has not passed), "after", or "unknown" (no deadline / unreadable / on a date-only day). */
export function deadlineState(res, nowUnix) {
  const now = Number(nowUnix) || 0;
  if (!res || res.source === "error" || res.source === "none") return "unknown";
  if (res.exact) return now <= res.deadline_unix ? "before" : "after";
  if (now < res.day_start_unix) return "before";
  if (now > res.day_end_unix) return "after";
  return "unknown";
}

/** An instant that gives the RIGHT before/after answer for `now` — exact, or (date-only) the day's end when `now` is off
 * that day — or null when it can't be decided. For comparisons only; never displayed as the deadline's time. */
export function determinateDeadlineUnix(res, nowUnix) {
  const st = deadlineState(res, nowUnix);
  if (st === "unknown") return null;
  return res.exact ? res.deadline_unix : res.day_end_unix;
}

/** The contract ladder's MYAC rung ends AT the contract deadline. When that deadline is DATE-ONLY (no time on the league
 * calendar — e.g. 2027's seeded 2027-09-05), the rung's end is that DAY: `end_unix` null, `end_day` set,
 * `end_time_known` false — never the invented 23:59:59 ET that determinateDeadlineUnix uses for before/after comparisons
 * (Keith 2026-10-09: "do not infer a time from the date-only entry"). Exact deadlines and the kickoff rungs are unchanged. */
export function withDateOnlyLadderEnd(ladder, res) {
  if (!ladder || ladder.stage !== "myac" || !res || res.exact || !res.day) return ladder;
  return { ...ladder, end_unix: null, end_day: res.day, end_time_known: false };
}

/** The ONE loader. Read-only: no CREATE, no write of any kind. */
export async function loadContractDeadline(env, season) {
  if (!env || !env.UPS_MFL_DB) return resolveContractDeadline({ season, calendar: { read_error: "no_d1_binding" } });
  let calendar;
  try { calendar = await getAuctionCalendar(env, undefined, { readOnly: true }); }
  catch (e) { calendar = { read_error: s(e && e.message) || "threw" }; }
  let eventDay = null, eventError = "";
  try {
    const row = await env.UPS_MFL_DB.prepare("SELECT date FROM league_events WHERE nfl_season = ? AND event = 'ups_contract_deadline' LIMIT 1").bind(s(season)).first();
    eventDay = row && row.date ? s(row.date) : null;
  } catch (e) {
    if (!/no such table/i.test(s(e && e.message))) eventError = s(e && e.message) || "threw";
  }
  return resolveContractDeadline({ season, calendar, eventDay, eventError });
}
