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
const body =
  extract("const _wvIsSundayEt = (unixSec) => {") + ";\n" +
  extract(WV_WINDOW_MARKER, WV_WINDOW_MARKER.length - 1) + ";\n" +
  "return { _wvIsSundayEt, _wvWaiverWindow };";
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

console.log(ok ? "\nALL PASS" : "\nSOME FAILED");
process.exit(ok ? 0 : 1);
