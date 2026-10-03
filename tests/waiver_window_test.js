#!/usr/bin/env node
/**
 * Regression test for _wvWaiverWindow (GET /api/waivers/state, POST
 * /api/waivers/fcfs) — the function that decides window.mode: "bbid" |
 * "fcfs" | "blackout" | "closed".
 *
 * Extracted VERBATIM out of worker/src/index.js (never re-implemented) and
 * run against real calendar_events pulled live from /api/waivers/state on
 * 2026-08-13, the day this bug shipped.
 *
 * Three live incidents have now come from this function:
 *   - 2026-08-09: app showed FCFS live when the calendar said locked
 *     (order-dependence on which of a same-instant LOCK/BBID row MFL's
 *     export listed first).
 *   - 2026-08-10: fixed by making LOCK win same-instant ties deterministically.
 *   - 2026-08-13: MFL's export omitted the paired LOCK row for a Thursday
 *     run entirely (no tie to break), and every WAIVER_BBID event was still
 *     treated as opening FCFS regardless of weekday — so FCFS opened on a
 *     plain Thursday. Fixed by deciding per-event, from the event's own
 *     day-of-week + NFL Week 1 status, instead of from whether a second
 *     calendar row happened to also come back.
 *
 * Run: node tests/waiver_window_test.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");

// `openAt`, when given, is the index (within startMarker) of the marker's
// OWN opening brace to start depth-counting from -- required for
// _wvWaiverWindow, whose signature contains an earlier, unrelated brace pair
// (`opts = {}`) that a naive "first { after the marker" search would match
// instead of the function body's real opening brace.
function extract(startMarker, openAt) {
  const i = SRC.indexOf(startMarker);
  if (i === -1) throw new Error("could not find " + startMarker + " — did it get renamed?");
  const open = openAt != null ? i + openAt : SRC.indexOf("{", i);
  if (SRC[open] !== "{") throw new Error("openAt for " + startMarker + " does not point at a brace");
  let depth = 0;
  for (let k = open; k < SRC.length; k += 1) {
    if (SRC[k] === "{") depth += 1;
    else if (SRC[k] === "}") {
      depth -= 1;
      if (depth === 0) return SRC.slice(i, k + 1);
    }
  }
  throw new Error("unbalanced braces extracting " + startMarker);
}

// Minimal stand-ins for the worker helpers _wvWaiverWindow calls.
const safeStr = (v) => (v == null ? "" : String(v));
const _wvEtLabel = (unixSec) => {
  const n = Number(unixSec) || 0;
  if (!n) return "";
  try {
    const s = new Date(n * 1000).toLocaleString("en-US", {
      timeZone: "America/New_York",
      weekday: "short", month: "short", day: "numeric",
      hour: "numeric", minute: "2-digit", hour12: true,
    });
    return `${s.replace(/^(\w{3}),\s*/, "$1 ")} ET`;
  } catch (_) { return ""; }
};

const WV_WINDOW_MARKER = "const _wvWaiverWindow = (calendarRows, nowUnix, opts = {}) => {";
// The league-schedule helpers (_WV_LEAGUE_BBID_WEEKDAYS … _wvLeagueScheduleRuns),
// sliced verbatim as one block.
const SCHED_START = "const _WV_LEAGUE_BBID_WEEKDAYS";
const SCHED_END = "// Bid floor / step / round cap read LIVE from MFL.";
if (SRC.indexOf(SCHED_START) === -1 || SRC.indexOf(SCHED_END) === -1) throw new Error("league schedule helpers not found");
const SCHED_SRC = SRC.slice(SRC.indexOf(SCHED_START), SRC.indexOf(SCHED_END));
const body =
  extract("const _wvIsSundayEt = (unixSec) => {") + ";\n" +
  SCHED_SRC + "\n" +
  extract(WV_WINDOW_MARKER, WV_WINDOW_MARKER.length - 1) + ";\n" +
  "return { _wvIsSundayEt, _wvWaiverWindow, _wvLeagueScheduleRuns };";
// eslint-disable-next-line no-new-func
const { _wvWaiverWindow } = new Function("safeStr", "_wvEtLabel", body)(safeStr, _wvEtLabel);

let ok = true;
function check(name, cond, detail) {
  console.log((cond ? "PASS" : "FAIL") + " — " + name + (detail ? "  (" + detail + ")" : ""));
  if (!cond) ok = false;
}

// Real calendar_events from the live /api/waivers/state pull on 2026-08-13
// 09:19 ET — the exact payload that triggered this bug report.
const REAL_EVENTS = [
  { event_type: "WAIVER_NONE", start_unix: 1784779200, end_unix: 1785902400 },
  { event_type: "WAIVER_LOCK", start_unix: 1785902400, end_unix: null },
  { event_type: "WAIVER_LOCK", start_unix: 1786021200, end_unix: null },
  { event_type: "WAIVER_LOCK", start_unix: 1786107600, end_unix: null },
  { event_type: "WAIVER_BBID", start_unix: 1786107600, end_unix: null },
  { event_type: "WAIVER_LOCK", start_unix: 1786194000, end_unix: null },
  { event_type: "WAIVER_BBID", start_unix: 1786194000, end_unix: null },
  { event_type: "WAIVER_LOCK", start_unix: 1786280400, end_unix: null },
  { event_type: "WAIVER_BBID", start_unix: 1786280400, end_unix: null },
  // Thu Aug 13 09:00 ET -- the run with NO paired lock row in MFL's export.
  { event_type: "WAIVER_BBID", start_unix: 1786626000, end_unix: null },
  { event_type: "WAIVER_LOCK", start_unix: 1789434000, end_unix: null },
  { event_type: "WAIVER_NONE", start_unix: 1799114400, end_unix: null },
];

// 2026 Week 1 opens Wed 2026-09-09 (worker's own nflWeekFirstKickoffUnix
// header comment). Exact hour doesn't matter for these test instants.
const WEEK1_KICKOFF_UNIX = Math.floor(Date.parse("2026-09-09T20:20:00-04:00") / 1000);

function win(events, nowUnix, week1 = WEEK1_KICKOFF_UNIX) {
  return _wvWaiverWindow(events, nowUnix, { calendar_unavailable: false, waiver_type: "BBID_FCFS", week1_kickoff_unix: week1 });
}

// ── the live bug moment ──────────────────────────────────────────────────
{
  const w = win(REAL_EVENTS, 1786627153); // Thu Aug 13, 9:19 AM ET
  check("Thu Aug 13 09:19 ET (the live bug moment) -> bbid", w.mode === "bbid", w.mode + " / " + w.mode_reason);
}

// ── regression: paired lock+bbid on Fri/Sat still locks ─────────────────
{
  const w = win(REAL_EVENTS, 1786107600 + 14 * 60); // Fri Aug 7
  check("Fri Aug 7 09:14 ET (paired lock+bbid) -> bbid", w.mode === "bbid", w.mode);
}

// ── pre-season Sunday (paired lock present) still locks -- no FCFS pre-Wk1 ──
{
  const w = win(REAL_EVENTS, 1786280400 + 14 * 60); // Sun Aug 9
  check("Sun Aug 9 09:14 ET (pre-season Sunday) -> bbid, not fcfs", w.mode === "bbid", w.mode);
}

// ── real post-Week-1 Sunday, NO paired lock at all -> genuinely opens fcfs ──
{
  const postWk1Sun = Math.floor(Date.parse("2026-09-13T09:00:00-04:00") / 1000);
  const events = REAL_EVENTS.concat([{ event_type: "WAIVER_BBID", start_unix: postWk1Sun, end_unix: null }]);
  const w = win(events, postWk1Sun + 14 * 60);
  check("Sun Sep 13 09:14 ET (post-Wk1 Sunday, no paired lock) -> fcfs", w.mode === "fcfs", w.mode + " / " + w.mode_reason);
}

// ── same instant, but a LOCK also fires -- LOCK wins the tie (conservative) ──
{
  const postWk1Sun = Math.floor(Date.parse("2026-09-13T09:00:00-04:00") / 1000);
  const events = REAL_EVENTS.concat([
    { event_type: "WAIVER_BBID", start_unix: postWk1Sun, end_unix: null },
    { event_type: "WAIVER_LOCK", start_unix: postWk1Sun, end_unix: null },
  ]);
  const w = win(events, postWk1Sun + 14 * 60);
  check("post-Wk1 Sunday WITH a same-instant LOCK -> bbid (LOCK wins tie)", w.mode === "bbid", w.mode);
}

// ── week1_kickoff_unix unresolved (0) -- never guess "open" ─────────────────
{
  const postWk1Sun = Math.floor(Date.parse("2026-09-13T09:00:00-04:00") / 1000);
  const events = REAL_EVENTS.concat([{ event_type: "WAIVER_BBID", start_unix: postWk1Sun, end_unix: null }]);
  const w = win(events, postWk1Sun + 14 * 60, 0);
  check("week1_kickoff_unix unresolved (0) on a real Sunday run -> bbid, not a guess", w.mode === "bbid", w.mode);
}

// ── explicit WAIVER_UNLOCK is trusted unconditionally, any weekday ──────────
{
  const thuUnlock = 1786626000; // same instant as the Thu Aug 13 run, hypothetically an UNLOCK instead
  const events = [{ event_type: "WAIVER_UNLOCK", start_unix: thuUnlock, end_unix: null }];
  const w = win(events, thuUnlock + 60);
  check("WAIVER_UNLOCK on a Thursday -> fcfs unconditionally", w.mode === "fcfs", w.mode);
}

// ══ RUN TIMES: the league schedule fills what MFL's calendar export omits ══
// Keith 2026-10-03: a withdrawal staged before Saturday's 9 AM run was still on
// the Claims screen after it. Live /api/waivers/state that morning reported
// last_run = Thu Aug 13 and next_bbid_run_unix = null — the calendar export
// (REAL_EVENTS, unchanged since August) lists no in-season runs at all, so the
// mobile run-based clear never had a run to compare against.
const et = (iso) => Math.floor(Date.parse(iso) / 1000);

// MFL's own BBID_WAIVER award instants for L=74598, 2026 (transactions export,
// read 2026-10-03). Every one must be a run the window knows about.
const AWARDS_2026 = [1786107600, 1786194000, 1786280400, 1786626000, 1786712400, 1786798800,
  1787230800, 1787317200, 1787403600, 1787490000, 1787835600, 1787922000, 1788008400,
  1788094800, 1788440400, 1788699600, 1789045200, 1789218000, 1789304400, 1789650000,
  1789736400, 1789822800, 1790254800, 1790341200, 1790427600, 1790514000, 1790859600,
  1790946000, 1791032400];

{
  const now = et("2026-10-03T09:52:27-04:00");   // the morning of the report, 52 min after Saturday's run
  const w = win(REAL_EVENTS, now);
  check("Sat Oct 3 (live): last run = Sat Oct 3 9:00 AM ET, not Aug 13",
    w.last_bbid_run_unix === et("2026-10-03T09:00:00-04:00"), w.last_bbid_run_label + " / " + w.last_bbid_run_source);
  check("…sourced from the league schedule", w.last_bbid_run_source === "league_schedule", w.last_bbid_run_source);
  check("Sat Oct 3 (live): next run = Sun Oct 4 9:00 AM ET (was null)",
    w.next_bbid_run_unix === et("2026-10-04T09:00:00-04:00"), w.next_bbid_run_label);
  check("…upcoming = Sun Oct 4, Thu Oct 8, Fri Oct 9, Sat Oct 10",
    JSON.stringify(w.bbid_runs_upcoming) === JSON.stringify(["2026-10-04", "2026-10-08", "2026-10-09", "2026-10-10"].map((d) => et(d + "T09:00:00-04:00"))),
    JSON.stringify(w.bbid_runs_upcoming));
  check("…window.mode untouched: still bbid / after_waiver_lock, exactly what the live API said",
    w.mode === "bbid" && w.mode_reason === "after_waiver_lock", w.mode + " / " + w.mode_reason);
}

{
  let missing = [];
  for (const a of AWARDS_2026) {
    const at = win(REAL_EVENTS, a + 60);
    const before = win(REAL_EVENTS, a - 60);
    if (at.last_bbid_run_unix !== a || !(before.last_bbid_run_unix < a)) missing.push(a);
  }
  check("every 2026 MFL award instant (29 runs, Aug 7 → Oct 3) is a run the window knows", missing.length === 0,
    missing.length ? "missing " + missing.join(",") : AWARDS_2026.length + " of " + AWARDS_2026.length);
}

{
  // 2025: waivers opened Thu Aug 14; DST ended Sun Nov 2. MFL's real award
  // instants on either side: Sat Nov 1 = 13:00Z (EDT), Thu Nov 6 = 14:00Z (EST).
  const ev2025 = [{ event_type: "WAIVER_BBID", start_unix: et("2025-08-14T09:00:00-04:00"), end_unix: null }];
  const sat = win(ev2025, 1762002000 + 60), thu = win(ev2025, 1762437600 + 60);
  check("2025 Sat Nov 1 run = 13:00 UTC (9:00 EDT), MFL award 1762002000", sat.last_bbid_run_unix === 1762002000, String(sat.last_bbid_run_unix));
  check("2025 Thu Nov 6 run = 14:00 UTC (9:00 EST), MFL award 1762437600", thu.last_bbid_run_unix === 1762437600, String(thu.last_bbid_run_unix));
  check("…and the Sun Nov 2 run in between is 9:00 EST", sat.next_bbid_run_unix === et("2025-11-02T09:00:00-05:00"), sat.next_bbid_run_label);
}

{
  const w = win(REAL_EVENTS, et("2026-08-05T12:00:00-04:00"));   // before waivers open (first run Fri Aug 7)
  check("before waivers open: no last run invented", w.last_bbid_run_unix === null, String(w.last_bbid_run_unix));
  check("…next run = the calendar's own first run, Fri Aug 7", w.next_bbid_run_unix === 1786107600 && w.next_bbid_run_source === "calendar", w.next_bbid_run_label);
}

{
  const events = REAL_EVENTS.concat([{ event_type: "WAIVER_NONE", start_unix: et("2026-10-07T00:00:00-04:00"), end_unix: et("2026-10-11T00:00:00-04:00") }]);
  const w = win(events, et("2026-10-05T12:00:00-04:00"));
  check("a WAIVER_NONE blackout span removes its runs: next after Sun Oct 4 is Sun Oct 11",
    w.next_bbid_run_unix === et("2026-10-11T09:00:00-04:00"), w.next_bbid_run_label);
}

{
  // REAL_EVENTS ends with an open-ended WAIVER_NONE at 1799114400 (Mon Jan 4 2027, 8 PM ET): the season shut-off.
  const w = win(REAL_EVENTS, 1799114400 + 2 * 86400);
  check("season shut-off: last run = Sun Jan 3 2027 9:00 AM EST, none after",
    w.last_bbid_run_unix === et("2027-01-03T09:00:00-05:00") && w.next_bbid_run_unix === null,
    w.last_bbid_run_label + " / next " + w.next_bbid_run_unix);
}

{
  const w = win([], et("2026-10-03T09:52:27-04:00"));
  check("no calendar events at all: no run times invented", w.last_bbid_run_unix === null && w.next_bbid_run_unix === null, JSON.stringify([w.last_bbid_run_unix, w.next_bbid_run_unix]));
}

{
  // The schedule must not open FCFS: Sunday Oct 4 after the run, the calendar
  // has no Sunday event, so the mode stays whatever MFL's own events say.
  const w = win(REAL_EVENTS, et("2026-10-04T09:14:00-04:00"));
  check("schedule runs never change window.mode (Sun Oct 4 09:14 ET stays bbid / after_waiver_lock)",
    w.mode === "bbid" && w.mode_reason === "after_waiver_lock" && w.last_bbid_run_unix === et("2026-10-04T09:00:00-04:00"),
    w.mode + " / " + w.mode_reason);
}

console.log(ok ? "\nALL PASS" : "\nSOME FAILED");
process.exit(ok ? 0 : 1);
