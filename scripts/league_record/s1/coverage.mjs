// League Record S1: the source-coverage model (decision of 2026-11-21). DIAGNOSTIC ONLY: it classifies intervals and answers "would custody be observed?", and it is NOT wired into the
// resolution rules (lineage.mjs is unchanged). Nothing here relaxes a rule: with no verification record every interval stays UNVERIFIED or a KNOWN_GAP, which is exactly as strict as today.
//
// Four things are kept apart:
//   recorded activity     the transaction events the sources hold, with their timestamps (events, never an interval state)
//   VERIFIED_COMPLETE     an authoritative, complete source covers the interval AND the completeness checks below passed, whether or not any transaction occurred in it
//   UNVERIFIED            a source exists but its completeness for the event class is not established
//   KNOWN_GAP             no adequate source covers the interval
// A quiet period (no recorded activity) is NOT a coverage state: inside a VERIFIED_COMPLETE interval it does not invalidate custody, and outside one it does not prove it.
import fs from "node:fs";
import path from "node:path";
import { dayNumber } from "./sources.mjs";

export const COVERAGE_STATE = Object.freeze({ VERIFIED_COMPLETE: "VERIFIED_COMPLETE", UNVERIFIED: "UNVERIFIED", KNOWN_GAP: "KNOWN_GAP" });
export const EVENT_CLASSES = Object.freeze(["pick_transfer", "player_move"]);          // coverage is per event class: verified add/drop coverage says nothing about trades
export const VERIFICATION_FILE = path.join("docs", "league_record", "coverage_verifications.json");
const CHECKS = Object.freeze({ archive_comparison: "every archive record of the class in the interval appears in the export and the export holds no other, with zero unexplained differences",
  chain_continuity: "no break in any pick or player chain across the interval", end_state_reconciliation: "a dated end-state export (holders of every traded pick) equals the holder the chains give" });
const ISO = /^\d{4}-\d{2}-\d{2}$/;

// A verification record is accepted only when every condition holds; the problems are returned, never thrown, so a bad record can never verify anything.
export function validateVerification(v) {
  const problems = [];
  if (!v || typeof v !== "object") return { ok: false, problems: ["not an object"] };
  if (!v.id) problems.push("no id");
  if (!EVENT_CLASSES.includes(v.event_class)) problems.push("event_class must be one of " + EVENT_CLASSES.join(", "));
  if (!ISO.test(v.from || "") || !ISO.test(v.to || "") || v.from > v.to) problems.push("from and to must be ISO dates with from <= to");
  const s = v.source || {};
  if (s.kind !== "mfl_export") problems.push("the source must be an authoritative MFL export (source.kind = mfl_export)");
  if (s.truncated !== false) problems.push("the response must be shown to be untruncated (source.truncated = false)");
  if (/(^|&)(COUNT|DAYS)=/i.test(String(s.params || ""))) problems.push("COUNT and DAYS truncate the response and are not accepted");
  if (!ISO.test(s.captured_on || "") || (ISO.test(v.to || "") && s.captured_on <= v.to)) problems.push("the export must be captured after the interval ends");
  const checks = Array.isArray(v.checks) ? v.checks : [];
  if (checks.some((c) => !CHECKS[c.kind])) problems.push("unknown check kind");
  if (checks.some((c) => c.passed !== true)) problems.push("a failed check voids the verification");
  const passed = new Set(checks.filter((c) => c.passed === true && CHECKS[c.kind]).map((c) => c.kind));
  if (!passed.has("archive_comparison")) problems.push("the comparison with the archive is required");
  if (!passed.has("chain_continuity") && !passed.has("end_state_reconciliation")) problems.push("at least one independent corroboration (chain_continuity or end_state_reconciliation) is required");
  return { ok: problems.length === 0, problems };
}

export function loadVerifications(root) {
  const p = path.join(root, VERIFICATION_FILE);
  if (!fs.existsSync(p)) return [];
  const j = JSON.parse(fs.readFileSync(p, "utf8"));
  if (!Array.isArray(j.verifications)) throw new Error(`${VERIFICATION_FILE}: "verifications" must be an array`);
  return j.verifications;
}

// Intervals: the quiet windows (kind quiet_window) and the named gap (kind named_gap). Each gets exactly one state. The named gap is a KNOWN_GAP unless valid verifications cover all of it; a quiet
// window is UNVERIFIED unless valid verifications cover all of it. A partly covered interval keeps its weaker state.
export function classifyIntervals({ windows, namedGap, verifications = [], eventClass = "pick_transfer" }) {
  const valid = verifications.filter((v) => v && v.event_class === eventClass && validateVerification(v).ok);
  const covered = (from, to) => { let d = from; const spans = valid.map((v) => [v.from, v.to]).sort(); for (const [a, b] of spans) { if (a > d) break; if (b >= d) d = nextDay(b); if (d > to) return true; } return d > to; };
  const one = (w, kind, weak) => {
    const hit = valid.filter((v) => !(v.to < w.from || v.from > w.to));
    const ok = covered(w.from, w.to);
    return { from: w.from, to: w.to, days: w.days != null ? w.days : dayNumber(w.to) - dayNumber(w.from) + 1, kind, state: ok ? COVERAGE_STATE.VERIFIED_COMPLETE : weak, verification: ok ? hit.map((v) => v.id) : [] };
  };
  const out = windows.map((w) => one(w, "quiet_window", COVERAGE_STATE.UNVERIFIED));
  if (namedGap) out.push(one(namedGap, "named_gap", COVERAGE_STATE.KNOWN_GAP));
  return out;
}
function nextDay(iso) { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); }

// Would custody of an asset be observed between two dates? Only when no interval that touches [from, to] is anything but VERIFIED_COMPLETE.
export function custodyObserved(intervals, from, to) {
  const blockers = intervals.filter((i) => !(i.to < from || i.from > to) && i.state !== COVERAGE_STATE.VERIFIED_COMPLETE);
  return { observed: blockers.length === 0, blockers };
}

export function coverageSummary(intervals) {
  const by = { VERIFIED_COMPLETE: 0, UNVERIFIED: 0, KNOWN_GAP: 0 }, days = { VERIFIED_COMPLETE: 0, UNVERIFIED: 0, KNOWN_GAP: 0 };
  for (const i of intervals) { by[i.state] += 1; days[i.state] += i.days; }
  return { intervals: intervals.length, by_state: by, days_by_state: days };
}
