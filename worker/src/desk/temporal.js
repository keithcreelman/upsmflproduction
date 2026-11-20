// Commissioner Desk: temporal scope, derived IN CODE from the question text. The model router is never the authority on
// "which date is this question about": a router that misses a date must not let today's data answer a past-date question.
//
//   extractTemporal(question, { today, currentSeason }) -> { dates, years, currentMentioned, relative }
//   deriveTemporal(question, { requestedAsOf, today, currentSeason }) -> {
//     source: "user" | "text" | "none",   asOf: ISO date | null,   comparison: boolean,   needsDate: boolean, ... }
//
// Rules (docs/ai_desk, coordinator brief):
//  1. a date the caller passed as as_of wins;
//  2. else exactly one distinct explicit past (or future) date or year in the text -> that date (a bare year is YYYY-07-01;
//     "October 2025" is 2025-10-01); the current season's year is "now", not a past scope;
//  3. two or more distinct scopes (a comparison, including a past year next to the current season) -> no single date: the loop
//     refuses any tool call whose as_of is "current", and the validator rejects any used fact dated "current";
//  4. a relative past phrase ("last season", "yesterday", "two years ago") with no date to derive -> needsDate: the pipeline answers
//     with a code-built abstain card and makes no model call;
//  5. the router may only ADD precision (a date inside the same bare year, or a date when the text has no signal at all);
//  6. no signal -> "current".

import { isAsOf } from "./contract.js";

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthNum = (name) => MONTHS[String(name).toLowerCase().slice(0, name.toLowerCase().startsWith("sept") ? 4 : 3)];
const pad = (n) => String(n).padStart(2, "0");
function iso(y, m, d) { const s = `${String(y).padStart(4, "0")}-${pad(m)}-${pad(d)}`; return isAsOf(s) ? s : null; }

// Each pattern yields an ISO date (or null for an impossible one, which is left in the text so its year is still seen).
const DATE_PATTERNS = [
  { re: /(?<![\d-])(\d{4})-(\d{2})-(\d{2})(?![\d-])/g, to: (m) => iso(m[1], m[2], m[3]) },
  { re: new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,\\s*|\\s+)(\\d{4})\\b`, "gi"), to: (m) => iso(m[3], monthNum(m[1]), m[2]) },
  { re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, "gi"), to: (m) => iso(m[3], monthNum(m[2]), m[1]) },
  { re: /(?<![\d/])(\d{1,2})\/(\d{1,2})\/(\d{4}|\d{2})(?![\d/])/g, to: (m) => iso(m[3].length === 2 ? `20${m[3]}` : m[3], m[1], m[2]) },
  { re: new RegExp(`\\b${MONTH_RE}\\.?,?\\s+(\\d{4})\\b`, "gi"), to: (m) => iso(m[2], monthNum(m[1]), 1) },
];
const YEAR_RE = /(?<![\d$,.\/])(20[1-9]\d)(?![\d,%\/]|\.\d|[kK]\b)/g;
const RELATIVE_RES = [
  /\b(?:last|previous|prior|past)\s+(?:season|seasons|year|years|week|weeks|month|months|offseason|draft|deadline|summer|fall|spring|winter|night)\b/i,
  /\byesterday\b/i,
  /\b(?:years?|seasons?|weeks?|months?|days?)\s+ago\b/i,
  /\bearlier\s+(?:this\s+)?(?:season|year)\b/i,
];

export function extractTemporal(question, { today, currentSeason } = {}) {
  let text = String(question || "");
  const dates = [];
  for (const { re, to } of DATE_PATTERNS) {
    text = text.replace(re, (...args) => {
      const d = to(args.slice(0, -2)); // [match, ...captures]
      if (!d) return args[0];
      dates.push(d);
      return " ";
    });
  }
  const season = Number(currentSeason) || Number(String(today || new Date().toISOString()).slice(0, 4));
  const years = [];
  let currentMentioned = false;
  for (const m of text.matchAll(YEAR_RE)) {
    const y = Number(m[1]);
    if (y === season) currentMentioned = true;
    else if (!years.includes(y)) years.push(y);
  }
  const relative = RELATIVE_RES.map((re) => (String(question || "").match(re) || [])[0]).filter(Boolean).map((s) => s.toLowerCase());
  return { dates: [...new Set(dates)], years: years.sort(), currentMentioned, relative };
}

export function deriveTemporal(question, { requestedAsOf = "current", today, currentSeason } = {}) {
  const t0 = today || new Date().toISOString().slice(0, 10);
  const base = { source: "none", asOf: null, comparison: false, needsDate: false, dates: [], years: [], relative: [], currentMentioned: false, bareYear: null };
  const ex = extractTemporal(question, { today: t0, currentSeason });
  Object.assign(base, { dates: ex.dates, years: ex.years, relative: ex.relative, currentMentioned: ex.currentMentioned });
  if (requestedAsOf && requestedAsOf !== "current") return { ...base, source: "user", asOf: requestedAsOf };

  // Distinct scopes. A date equal to today is "now"; a year that a full date already covers is not counted again.
  const scopes = new Map(); // key -> ISO date
  const season = Number(currentSeason) || Number(t0.slice(0, 4));
  const covered = new Set(ex.dates.map((d) => Number(d.slice(0, 4))));
  let nowMentioned = ex.currentMentioned && !covered.has(season);
  for (const d of ex.dates) { if (d === t0) nowMentioned = true; else scopes.set(d, d); }
  for (const y of ex.years) if (!covered.has(y)) scopes.set(String(y), `${y}-07-01`);

  const n = scopes.size + (nowMentioned && scopes.size ? 1 : 0);
  if (n >= 2) return { ...base, source: "text", comparison: true };
  if (scopes.size === 1) {
    const [key, date] = [...scopes.entries()][0];
    return { ...base, source: "text", asOf: date, bareYear: /^\d{4}$/.test(key) ? Number(key) : null };
  }
  if (ex.relative.length) return { ...base, needsDate: true };
  return base;
}
