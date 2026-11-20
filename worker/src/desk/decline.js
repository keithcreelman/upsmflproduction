// Commissioner Desk: the deterministic "no record" decline (Phase 1 closeout, R4 DEV-UNA-08).
//
// When the only evidence a run gathered is a coverage.check answer saying the desk has NO record for the season the run is about, there is nothing for a model to
// compose: every word of the answer is already known (what is missing, why, and which League Record slice would close it). The model's attempts at such cards
// failed in R4 for reasons unrelated to quality (a fact token on an abstain card, a pronoun the number rule rejected) and cost a composer call and a retry each.
// This module decides, in code, whether a run qualifies; the pipeline then builds the card with composer.noRecordCard. No model text can reach it.
//
// A run qualifies only when ALL of these hold (each one closes a way for a wrong decline to hide an answerable question):
//  1. the run is not a multi-date comparison;
//  2. every real (non-noise) tool result is a coverage.check answer for ONE named domain (never "all");
//  3. each of them says level "none" with reason NO_RECORD or unsupported_as_of (never "stale", never "partial");
//  4. each checked the season the CODE derived for this run (the model chooses the coverage call's season; a wrong choice must not produce a decline),
//     and the season is the one in effect: the as_of year, or the current season when the run is "current";
//  5. at least one gap names the source that would close it.
// Anything else goes to the composer exactly as before. The authorization, input and budget gates ran before this point and are unchanged.
import { collectToolGaps } from "./validator.js";

const DECLINE_REASONS = new Set(["NO_RECORD", "unsupported_as_of"]);
const MAX_NOTE = 200;

function isNoise(env) {
  const code = env && env.error && env.error.code;
  return (env.status === "forbidden" && code === "unknown_tool") || (env.status === "error" && (code === "bad_arguments" || code === "as_of_required"));
}

// The season the run is about, from code: the year of the run's binding as_of, or the current season for "current".
export function runSeason(effAsOf, currentSeason) {
  if (effAsOf === "current") return Number.isInteger(currentSeason) ? currentSeason : null;
  const y = Number(String(effAsOf || "").slice(0, 4));
  return Number.isInteger(y) && y > 1000 ? y : null;
}

// -> null (compose as usual) | { gaps, toolGaps, note, domains }
export function findNoRecordDecline(envelopes, { effAsOf, currentSeason, forbidCurrent = false } = {}) {
  if (forbidCurrent) return null;
  const season = runSeason(effAsOf, currentSeason);
  if (season == null) return null;
  const real = (envelopes || []).filter((e) => e && !isNoise(e));
  if (!real.length) return null;
  const notes = [];
  for (const e of real) {
    const d = e.data;
    if (e.tool !== "coverage.check" || e.status !== "ok" || !d || typeof d !== "object") return null;
    if (typeof d.domain !== "string" || !d.domain || d.domain === "all") return null;
    if (d.level !== "none" || !DECLINE_REASONS.has(d.reason)) return null;
    if (d.season !== season) return null;
    if (typeof d.note === "string" && d.note.trim() && d.note.length <= MAX_NOTE && !/[<>{}\[\]]|https?:/i.test(d.note) && !notes.includes(d.note.trim())) notes.push(d.note.trim());
  }
  const toolGaps = collectToolGaps(real);
  if (!toolGaps.length || !toolGaps.some((g) => g.source_needed)) return null;
  return {
    gaps: toolGaps.map(({ what, why, source_needed }) => ({ what, why, source_needed })),
    toolGaps,
    note: notes[0] || "",
    domains: real.map((e) => e.data.domain),
  };
}
