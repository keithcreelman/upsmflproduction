// Commissioner Desk tool 10: calendar.events
// The league calendar for a season (deadlines, windows, the trade lock, the first NFL kickoff), from GET /api/league-events, which already
// resolves each date from its authority (MFL's nflSchedule, MFL's own calendar through worker/src/trade_deadline.js, or the commissioner's
// stored row, each marked with its date_source).
//
// CANON CONTRADICTS ITSELF on two points, and this tool does NOT pick between the readings:
//   1. the trade deadline: "Thanksgiving week kickoff" vs "Thanksgiving Thursday" vs MFL's enforced instant (Tue Nov 24, 12:00 PM ET in 2026);
//   2. the 2026 NFL Week 1 date: Wed Sept 9 vs Thu Sept 10.
// The MFL-derived value is returned as a grade A fact; the stored or canon readings are returned alongside, and each contradiction is a
// coverage gap with reason conflict_in_canon that names both readings and where they sit (file and line, no long quotes).
import { defineTool } from "../registry.js";
import { safeToken, safeText } from "./shared_text.js";
import { etParts } from "../../trade_deadline.js";

const ROUTE = "/api/league-events";
const SRC_EVENTS = "/api/league-events";
const CANON_FILE = "docs/league_context_v1.md";
const FIRST_SEASON = 2011;

// Where canon states each reading (line numbers as read 2026-11-19; a later edit to the file can move them: re-grep before citing).
const CANON_TRADE = [
  { lines: "265, 899, 1425, 1522", reading: "trade deadline = the kickoff of NFL Thanksgiving week" },
  { lines: "1303", reading: "Week 12 listed as Thu 2026-11-26, Thanksgiving, trade deadline" },
  { lines: "1284, 1454", reading: "MFL stops accepting trades Tue 2026-11-24, 12:00 PM ET (MFL's calendar)" },
];
const CANON_WEEK1 = [
  { lines: "1281, 1292, 1443", reading: "2026 Week 1 kickoff is Wed 2026-09-09" },
  { lines: "2247, 3014, 3020", reading: "2026 Week 1 Thursday is Sept 10" },
];

const str = (v) => String(v == null ? "" : v);
const isoDate = (v) => { const x = str(v).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(x) ? x : null; };
const SAFE_KEY = (e) => String(e).toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 52);

export default defineTool({
  id: "calendar.events",
  version: "1.0.0",
  description:
    "The league calendar for one season (as_of 'current' = this season; a date picks that date's season): contract and tag deadlines, the FA Auction rows, MFL's trade lock and the first NFL kickoff, each with where its date came from. " +
    "Canon contradicts itself on the trade-deadline wording and on the 2026 Week 1 date (Sept 9 or Sept 10): this tool returns MFL's value as the fact and states both canon readings as a conflict, it does not choose. " +
    "Covers 2011 to now. It reports the season's events, not a past 'what was open on that day' state.",
  phase: "P1",
  dataClass: "P0",
  readOnly: true,
  inputSchema: { type: "object", properties: {}, required: [] },
  asOf: { supports: "season", from: FIRST_SEASON },
  allowlist: { routes: [{ path: ROUTE, params: ["L", "season", "from", "limit", "kickoffs"] }], modules: ["trade_deadline.js"], tables: [] },
  output: {
    allow: [
      "season", "events[].event", "events[].date", "events[].date_source", "events[].time_et", "events[].label", "events[].stored_date", "events[].nfl_week",
      "week1_kickoff.unix", "week1_kickoff.date_et", "week1_kickoff.time_et", "week1_kickoff.source",
      "trade_lock.state", "trade_lock.date_et", "trade_lock.time_et", "trade_lock.label", "trade_lock.reason", "trade_lock.source",
      "conflicts[].topic", "conflicts[].mfl_value", "conflicts[].stored_value", "conflicts[].canon_readings[].file", "conflicts[].canon_readings[].lines", "conflicts[].canon_readings[].reading",
    ],
  },

  async run({ asOf, routeGet, knowledge }) {
    if (!knowledge || !knowledge.leagueId || !knowledge.currentSeason) {
      return { status: "error", error: { code: "missing_knowledge", message: "knowledge.leagueId and knowledge.currentSeason are required" } };
    }
    const season = asOf === "current" ? Number(knowledge.currentSeason) : Number(String(asOf).slice(0, 4));
    const prov = { route: ROUTE, season: String(season), module: "trade_deadline.js" };

    const res = await routeGet(ROUTE, { L: knowledge.leagueId, season: String(season), from: "all", limit: "50", kickoffs: "1" });
    const body = res.json;
    if (!res.ok || !body || body.ok !== true || !Array.isArray(body.events)) {
      return { status: "error", error: { code: "route_failed", message: `/api/league-events answered ${res.status}` } };
    }

    // Route text reaches data, facts and gaps only through the shared screen. An event's own description (commissioner-typed) is never passed on:
    // the event token, its date and where the date came from answer the question.
    const events = body.events.map((e) => ({
      event: safeToken(e.event), date: isoDate(e.date), date_source: safeToken(e.date_source),
      time_et: safeToken(e.time_et) || null, label: safeText(e.label, 60) || null, stored_date: isoDate(e.stored_date),
      nfl_week: Number.isFinite(Number(e.nfl_week)) && e.nfl_week != null ? Number(e.nfl_week) : null,
    })).filter((e) => e.event);   // an event whose name fails the screen is dropped
    const lock = body.trade_lock && typeof body.trade_lock === "object" ? body.trade_lock : {};
    const tradeLock = { state: safeToken(lock.state), date_et: isoDate(lock.date_et), time_et: safeToken(lock.time_et) || null, label: safeText(lock.label, 60) || null, reason: safeToken(lock.reason), source: safeToken(lock.source) };

    const wk1Unix = body.week_kickoffs && Number(body.week_kickoffs["1"]) > 0 ? Number(body.week_kickoffs["1"]) : null;
    const wk1 = wk1Unix ? { unix: wk1Unix, ...(({ date_et, time_et }) => ({ date_et, time_et }))(etParts(wk1Unix)), source: safeToken(body.week_kickoffs_source) } : null;

    const asFact = String(asOf);
    const f = (key, label, value, unit, grade, source) => ({ key, label, value, unit, as_of: asFact, source, grade });
    const facts = [];
    const gaps = [];
    const conflicts = [];

    if (wk1) facts.push(f("week1_kickoff_et", `NFL Week 1 first kickoff, ET date, ${season} (from MFL's nflSchedule)`, wk1.date_et, "date", "A", SRC_EVENTS));
    if (tradeLock.date_et && (tradeLock.state === "upcoming" || tradeLock.state === "closed")) {
      facts.push(f("trade_lock_et", `MFL stops accepting trades, ET date, ${season} (the earliest 'No Trades Allowed' event on MFL's calendar)`, tradeLock.date_et, "date", "A", "MFL calendar via /api/league-events trade_lock"));
      if (tradeLock.label) facts.push(f("trade_lock_label", `MFL stops accepting trades, ET date and time, ${season}`, tradeLock.label, "text", "A", "MFL calendar via /api/league-events trade_lock"));
    } else {
      gaps.push({ what: `MFL's trade lock for ${season} is not resolved (${tradeLock.reason || tradeLock.state || "unknown"})`, why: "partial_coverage", source_needed: "a readable 'No Trades Allowed' event on MFL's league calendar" });
    }

    const seen = new Set();
    for (const e of events) {
      if (!e.event) continue;
      if (!e.date) {
        gaps.push({ what: `${e.event} has no resolvable date for ${season}`, why: "partial_coverage", source_needed: "a stored or MFL-derived date for that event" });
        continue;
      }
      // MFL- or schedule-derived dates are records (A); the commissioner's stored row is a league document (B).
      const grade = /^(nfl_schedule_first_kickoff|mfl_calendar)$/.test(e.date_source) ? "A" : "B";
      const key = `ev_${SAFE_KEY(e.event)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      facts.push(f(key, `${e.event} date, ${season} (${e.date_source || "source unknown"})`.slice(0, 118), e.date, "date", grade, `${SRC_EVENTS} (${e.date_source || "unknown"})`));
      if (e.date_source === "stored_row_stale_fallback") {
        gaps.push({ what: `${e.event} is the commissioner's stored date because the NFL schedule could not be read`, why: "stale", source_needed: "MFL's nflSchedule for that week" });
      }
    }

    // Contradiction 1: the trade deadline. Always stated: the wording itself differs inside canon.
    const tdEvent = events.find((e) => e.event === "ups_trade_deadline");
    const storedTd = tdEvent && tdEvent.stored_date ? tdEvent.stored_date : null;
    if (storedTd) facts.push(f("trade_deadline_stored", `Trade deadline as the commissioner's stored calendar row has it, ${season} (a typed date, not MFL's enforcement time)`, storedTd, "date", "B", `${SRC_EVENTS} league_events row`));
    conflicts.push({ topic: "trade_deadline", mfl_value: tradeLock.label || tradeLock.date_et || null, stored_value: storedTd, canon_readings: CANON_TRADE.map((c) => ({ file: CANON_FILE, ...c })) });
    gaps.push({
      what: `canon states the trade deadline three ways (${CANON_FILE} lines ${CANON_TRADE.map((c) => c.lines).join(" | ")}): Thanksgiving-week kickoff, Thanksgiving Thursday, and MFL's enforced calendar time; the fact shown is MFL's value`,
      why: "conflict_in_canon", source_needed: "a Keith ruling that edits canon to one reading",
    });

    // Contradiction 2: the 2026 Week 1 date.
    if (season === 2026) {
      const storedKick = events.find((e) => e.event === "nfl_kickoff");
      conflicts.push({ topic: "week1_2026", mfl_value: wk1 ? wk1.date_et : null, stored_value: storedKick && storedKick.date ? storedKick.date : null, canon_readings: CANON_WEEK1.map((c) => ({ file: CANON_FILE, ...c })) });
      gaps.push({
        what: `canon states the 2026 Week 1 date two ways (${CANON_FILE} lines ${CANON_WEEK1.map((c) => c.lines).join(" | ")}): Wed Sept 9 and Thu Sept 10; the fact shown is MFL's schedule value`,
        why: "conflict_in_canon", source_needed: "a Keith ruling that edits canon to one date",
      });
    }

    return {
      status: "ok",
      data: { season, events, week1_kickoff: wk1, trade_lock: tradeLock, conflicts },
      facts,
      coverage: { supported: true, gaps },
      provenance: {
        ...prov, canon_file: CANON_FILE, canon_sha_note: "line numbers cite docs/league_context_v1.md as read 2026-11-19",
        canon_refs: [
          ...CANON_TRADE.map((c) => ({ topic: "trade_deadline", file: CANON_FILE, lines: c.lines, reading: c.reading })),
          ...(season === 2026 ? CANON_WEEK1.map((c) => ({ topic: "week1_2026", file: CANON_FILE, lines: c.lines, reading: c.reading })) : []),
        ],
        date_authority: "nfl_schedule_first_kickoff and mfl_calendar are MFL-derived (grade A); stored_row is the commissioner's typed row (grade B)",
        conflict_policy: "both canon readings are reported; neither is chosen",
      },
      freshness: lock.verified_at_utc ? { trade_lock_verified_at_utc: safeToken(lock.verified_at_utc) } : null,
    };
  },
});
