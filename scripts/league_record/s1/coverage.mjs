// League Record S1: the source-coverage model (decision of 2026-11-21). DIAGNOSTIC ONLY: it classifies intervals and answers "would custody be observed?", and it is NOT wired into the
// resolution rules (lineage.mjs is unchanged). Nothing here relaxes a rule: with no verification record every interval stays UNVERIFIED or a KNOWN_GAP, which is exactly as strict as today.
//
// Four things are kept apart:
//   recorded activity     the transaction events the sources hold, with their timestamps (events, never an interval state)
//   VERIFIED_COMPLETE     an authoritative, complete source covers the interval AND the completeness checks below passed, whether or not any transaction occurred in it
//   UNVERIFIED            a source exists but its completeness for the event class is not established
//   KNOWN_GAP             no adequate source covers the interval
// A quiet period (no recorded activity) is NOT a coverage state: inside a VERIFIED_COMPLETE interval it does not invalidate custody, and outside one it does not prove it.
// EVERY day, not only the quiet windows, is UNVERIFIED unless a valid verification covers it (the windows and the named gap are labels for reporting). Custody is observed only when the WHOLE span lies
// inside valid verifications, so a day nobody verified blocks even when it sits between two busy days.
import fs from "node:fs";
import path from "node:path";
import { dayNumber } from "./sources.mjs";

export const COVERAGE_STATE = Object.freeze({ VERIFIED_COMPLETE: "VERIFIED_COMPLETE", UNVERIFIED: "UNVERIFIED", KNOWN_GAP: "KNOWN_GAP" });
export const EVENT_CLASSES = Object.freeze(["pick_transfer", "player_move"]);          // coverage is per event class: verified add/drop coverage says nothing about trades
export const VERIFICATION_FILE = path.join("docs", "league_record", "coverage_verifications.json");
const CHECKS = Object.freeze({ archive_comparison: "every archive record of the class in the interval appears in the export and the export holds no other, with zero unexplained differences (detects loss in the copy; it cannot detect a record MFL itself never logged, because the archive is a copy of MFL's own log)",
  chain_continuity: "no break in any pick or player chain across the interval (computed from the same log, so it is supporting evidence only)", end_state_reconciliation: "a dated end-state export (holders of every traded pick) equals the holder the chains give (the one check that does not come from the transaction log)" });
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// A verification record is accepted only when every condition holds; the problems are returned, never thrown, so a bad record can never verify anything.
const isDate = (d) => typeof d === "string" && ISO.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;     // a real calendar date, never 2020-02-30

export function validateVerification(v) {
  const problems = [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, problems: ["not an object"] };
  if (typeof v.id !== "string" || !v.id) problems.push("no id");
  if (!EVENT_CLASSES.includes(v.event_class)) problems.push("event_class must be one of " + EVENT_CLASSES.join(", "));
  if (!isDate(v.from) || !isDate(v.to) || v.from > v.to) problems.push("from and to must be real ISO dates with from <= to");
  const s = v.source && typeof v.source === "object" && !Array.isArray(v.source) ? v.source : {};
  if (s.kind !== "mfl_export") problems.push("the source must be an authoritative MFL export (source.kind = mfl_export)");
  if (s.truncated !== false) problems.push("the response must be shown to be untruncated (source.truncated = false)");
  if (typeof s.params !== "string" || !s.params) problems.push("the request parameters must be recorded (source.params)");
  else if (/(^|[?&])(COUNT|DAYS)=/i.test(s.params)) problems.push("COUNT and DAYS truncate the response and are not accepted");
  if (!isDate(s.captured_on) || (isDate(v.to) && s.captured_on <= v.to)) problems.push("the export must be captured (a real date) after the interval ends");
  if (typeof s.league_id !== "string" || !s.league_id) problems.push("the league id of the instance must be recorded (it differs by year before 2017)");
  if (!Number.isInteger(s.year)) problems.push("the instance year must be recorded (source.year)");
  else if (isDate(v.from) && isDate(v.to) && (v.from < `${s.year}-01-01` || v.to > `${s.year + 1}-12-31`)) problems.push("the interval must lie inside the instance year and the year after (a record covers one league instance)");
  if (!Array.isArray(v.checks)) problems.push("checks must be an array");
  const checks = Array.isArray(v.checks) ? v.checks : [];
  if (checks.some((c) => !c || typeof c !== "object" || !CHECKS[c.kind])) problems.push("unknown check kind");
  if (new Set(checks.map((c) => c && c.kind)).size !== checks.length) problems.push("a check kind may appear only once");
  if (checks.some((c) => !c || c.passed !== true)) problems.push("a failed check voids the verification");
  if (checks.some((c) => !c || typeof c.ref !== "string" || !c.ref)) problems.push("every check must cite its evidence (ref)");
  const passed = new Set(checks.filter((c) => c && c.passed === true && CHECKS[c.kind]).map((c) => c.kind));
  if (!passed.has("archive_comparison")) problems.push("the comparison with the archive is required");
  if (!passed.has("end_state_reconciliation")) problems.push("the end-state reconciliation is required: the archive and the export both come from MFL's transaction log, so only a source outside that log can corroborate it");
  return { ok: problems.length === 0, problems };
}

export function loadVerifications(root) {
  const p = path.join(root, VERIFICATION_FILE);
  if (!fs.existsSync(p)) return [];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(j.verifications)) throw new Error(`${VERIFICATION_FILE}: "verifications" must be an array`);
  return j.verifications;
}

// Intervals (for reporting): the quiet windows (kind quiet_window) and the named gap (kind named_gap). Each gets one state. The named gap is a KNOWN_GAP unless valid verifications cover all of it; a
// quiet window is UNVERIFIED unless valid verifications cover all of it. A partly covered interval keeps its weaker state.
const validFor = (verifications, eventClass) => verifications.filter((v) => v && v.event_class === eventClass && validateVerification(v).ok);
function nextDay(iso) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }
const coveredBy = (spans, from, to) => { let d = from; for (const [a, b] of [...spans].sort()) { if (a > d) break; if (b >= d) d = nextDay(b); if (d > to) return true; } return d > to; };

export function classifyIntervals({ windows, namedGap, verifications = [], eventClass = "pick_transfer" }) {
  const valid = validFor(verifications, eventClass);
  const spans = valid.map((v) => [v.from, v.to]);
  const one = (w, kind, weak) => {
    const hit = valid.filter((v) => !(v.to < w.from || v.from > w.to));
    const ok = coveredBy(spans, w.from, w.to);
    return { from: w.from, to: w.to, days: w.days != null ? w.days : dayNumber(w.to) - dayNumber(w.from) + 1, kind, state: ok ? COVERAGE_STATE.VERIFIED_COMPLETE : weak, verification: ok ? hit.map((v) => v.id) : [] };
  };
  const out = windows.map((w) => one(w, "quiet_window", COVERAGE_STATE.UNVERIFIED));
  if (namedGap) out.push(one(namedGap, "named_gap", COVERAGE_STATE.KNOWN_GAP));
  return out;
}

// The model: the labelled intervals plus the spans that valid verifications cover.
export function buildCoverageModel({ windows, namedGap, verifications = [], eventClass = "pick_transfer" }) {
  return { event_class: eventClass, intervals: classifyIntervals({ windows, namedGap, verifications, eventClass }), spans: validFor(verifications, eventClass).map((v) => [v.from, v.to]) };
}

// Would custody of an asset be observed between two dates (inclusive)? Only when EVERY day of the span lies inside valid verifications. A day outside any verification is unverified, whether or not it
// falls in a quiet window. The blockers list the labelled intervals that touch the span and are not verified, for the reader; `uncovered` says whether any day is unverified.
export function custodyObserved(model, from, to) {
  const uncovered = !coveredBy(model.spans, from, to);
  const blockers = model.intervals.filter((i) => !(i.to < from || i.from > to) && i.state !== COVERAGE_STATE.VERIFIED_COMPLETE);
  return { observed: !uncovered, uncovered, blockers };
}

export function coverageSummary(intervals) {
  const by = { VERIFIED_COMPLETE: 0, UNVERIFIED: 0, KNOWN_GAP: 0 }, days = { VERIFIED_COMPLETE: 0, UNVERIFIED: 0, KNOWN_GAP: 0 };
  for (const i of intervals) { by[i.state] += 1; days[i.state] += i.days; }
  return { intervals: intervals.length, by_state: by, days_by_state: days };
}
