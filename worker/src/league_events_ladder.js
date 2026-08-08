// worker/src/league_events_ladder.js
// ─────────────────────────────────────────────────────────────────────────────
// The pre-season contract ladder's two moving boundaries, resolved for
// GET /api/league-events.
//
// WHY THIS FILE EXISTS
// The D1 `league_events` table carries hand-seeded `preseason_mymdeadline` and
// `preseason_extensiondeadline` rows (migration 0026). They were seeded from the
// WEDNESDAY before each Thursday kickoff, so five of the six rows across
// 2024-2026 are exactly one day early:
//
//   season  event                        seeded       real first kickoff
//   2024    preseason_mymdeadline        2024-09-18   Thu 2024-09-19 8:15 PM ET
//   2024    preseason_extensiondeadline  2024-10-02   Thu 2024-10-03 8:15 PM ET
//   2025    preseason_mymdeadline        2025-09-17   Thu 2025-09-18 8:15 PM ET
//   2025    preseason_extensiondeadline  2025-10-01   Thu 2025-10-02 8:15 PM ET
//   2026    preseason_mymdeadline        2026-09-24   Thu 2026-09-24 8:15 PM ET  (matches, by luck)
//   2026    preseason_extensiondeadline  2026-10-07   Thu 2026-10-08 8:15 PM ET
//
// Canon (league_context_v1.md ~1211 / ~1214) ties both rungs to an NFL WEEK
// KICKOFF — MYM closes at Week 3, Extension at Week 5 — and Keith ruled
// 2026-08-07 that the boundary is the week's FIRST game, not necessarily
// Thursday (2026 Week 1 opens on a WEDNESDAY). A hand-typed calendar row is
// therefore a copy of a fact that MFL already publishes, and copies drift.
//
// Mobile and the Discord waiver post were already switched onto
// nflWeekFirstKickoffUnix(). This module puts /api/league-events on the same
// function so EVERY consumer (team_operations, Front Office, mobile, native
// player actions) reads one number, and so a future season needs no seeding.
//
// NO FAIL-OPEN. The precedence is:
//   1. schedule answers      → that date, date_source "nfl_schedule_first_kickoff"
//   2. schedule unreadable,
//      stored row present    → the stored date, date_source
//                              "stored_row_stale_fallback" (visibly second-best)
//   3. neither               → date: null, date_source "unresolved"
// Case 3 returns the EVENT WITH NO DATE. It never invents one and never
// silently drops the row, because a consumer must be able to tell "unknown"
// from a real deadline — a guessed deadline is what owners would plan against.
//
// The as-recorded table value always rides along as `stored_date`, so nothing
// is hidden and a consumer that genuinely wants the historical row can have it.
// ─────────────────────────────────────────────────────────────────────────────

import { etDayKey } from "./auction_windows.js";

// event token → the NFL week whose FIRST kickoff is that deadline.
export const PRESEASON_LADDER = [
  { event: "preseason_mymdeadline", week: 3, label: "MYM window closes at the first kickoff of NFL Week 3" },
  { event: "preseason_extensiondeadline", week: 5, label: "Extension window closes at the first kickoff of NFL Week 5" },
];

export const DATE_SOURCE = {
  SCHEDULE: "nfl_schedule_first_kickoff",
  STORED: "stored_row",
  STORED_STALE: "stored_row_stale_fallback",
  UNRESOLVED: "unresolved",
};

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;
const isoOf = (v) => {
  const s = String(v == null ? "" : v).trim().slice(0, 10);
  return ISO_RE.test(s) ? s : "";
};
const utcTodayIso = () => new Date().toISOString().slice(0, 10);

// Sort: date ASC, then event name. Undated rows sort LAST — they are unknown,
// not ancient, and must not lead a list of upcoming deadlines.
function byDateThenEvent(a, b) {
  const ad = a.date || "";
  const bd = b.date || "";
  if (!ad && bd) return 1;
  if (ad && !bd) return -1;
  if (ad !== bd) return ad < bd ? -1 : 1;
  return String(a.event) < String(b.event) ? -1 : 1;
}

/**
 * Merge the stored calendar rows for one season with the schedule-derived
 * pre-season ladder, then apply the `from` filter and `limit`.
 *
 * @param {object}   o
 * @param {object[]} o.rows        stored league_events rows for the season
 *                                 (event, date, nfl_season, description)
 * @param {string}   o.season      4-digit season
 * @param {string}   o.from        'all' | ISO date | anything else (= today)
 * @param {number}   o.limit       max rows out (1..50)
 * @param {Function} o.kickoffFor  async (season, week) => unix seconds, 0 when
 *                                 unreadable. Pass nflWeekFirstKickoffUnix —
 *                                 the SAME helper Discord + mobile call. It is
 *                                 injected rather than imported so there stays
 *                                 exactly one implementation of "when does the
 *                                 week start" and so this is testable offline.
 * @param {string}  [o.todayIso]   override for the from=today cutoff (tests)
 * @returns {Promise<{events: object[], ladder: object}>}
 */
export async function buildLeagueEvents({ rows, season, from, limit, kickoffFor, todayIso }) {
  const yr = String(season == null ? "" : season).replace(/\D/g, "");
  const lim = Math.min(50, Math.max(1, parseInt(limit, 10) || 10));
  const stored = Array.isArray(rows) ? rows.filter((r) => r && r.event != null) : [];

  const storedByEvent = new Map();
  for (const r of stored) storedByEvent.set(String(r.event), r);

  // ── Resolve the two moving boundaries ──────────────────────────────────────
  const ladder = {};
  const resolved = new Map();
  for (const spec of PRESEASON_LADDER) {
    let ko = 0;
    try {
      ko = Number(await kickoffFor(yr, spec.week)) || 0;
    } catch (_) {
      ko = 0; // unreadable schedule → fall through to the stored row, never to a guess
    }
    if (!(ko > 0)) ko = 0;
    const row = storedByEvent.get(spec.event) || null;
    const storedDate = row ? isoOf(row.date) : "";
    const derived = ko > 0 ? isoOf(etDayKey(ko)) : "";

    let date = null;
    let source = DATE_SOURCE.UNRESOLVED;
    if (derived) {
      date = derived;
      source = DATE_SOURCE.SCHEDULE;
    } else if (storedDate) {
      date = storedDate;
      source = DATE_SOURCE.STORED_STALE;
    }

    const out = {
      event: spec.event,
      date,                                   // null = UNKNOWN, never a guess
      nfl_season: yr,
      description: (row && row.description) || spec.label,
      date_source: source,
      nfl_week: spec.week,
      kickoff_unix: ko > 0 ? ko : null,
      stored_date: storedDate || null,        // the as-recorded table value
    };
    resolved.set(spec.event, out);
    ladder[spec.event] = {
      date: out.date,
      date_source: out.date_source,
      nfl_week: out.nfl_week,
      kickoff_unix: out.kickoff_unix,
      stored_date: out.stored_date,
    };
  }

  // ── Merge: ladder rows replace their stored twin; everything else is the
  // stored row verbatim (the September ups_contract_deadline is COMMISH-OWNED
  // and is never touched here).
  const merged = [];
  for (const r of stored) {
    const key = String(r.event);
    if (resolved.has(key)) continue;
    merged.push({
      event: key,
      date: isoOf(r.date) || null,
      nfl_season: String(r.nfl_season == null ? yr : r.nfl_season),
      description: r.description == null ? null : r.description,
      date_source: DATE_SOURCE.STORED,
    });
  }
  // A season that was never seeded still gets its ladder, so no future season
  // needs a seeding migration.
  for (const spec of PRESEASON_LADDER) merged.push(resolved.get(spec.event));

  // ── from / limit, applied AFTER resolution ────────────────────────────────
  // The filter has to run on the RESOLVED date. Doing it in SQL against the
  // stored date is what would hide a boundary that moved across the edge: on
  // 2026-10-08, `date >= date('now')` drops the stored 2026-10-07 row even
  // though the Extension window is open until that evening's 8:15 PM kickoff.
  const fromRaw = String(from == null ? "today" : from).trim().toLowerCase();
  let cutoff = "";
  if (fromRaw === "all") cutoff = "";
  else if (ISO_RE.test(fromRaw)) cutoff = fromRaw;
  else cutoff = isoOf(todayIso) || utcTodayIso();

  const events = merged
    .filter((e) => !cutoff || !e.date || e.date >= cutoff) // undated = unknown, always surfaced
    .sort(byDateThenEvent)
    .slice(0, lim);

  return { events, ladder };
}
