// Commissioner Desk: temporal scope, derived IN CODE from the question text. The model router is never the authority on
// "which date is this question about": a router that misses a date must not let today's data answer a past-date question.
//
//   extractTemporal(question, { today, currentSeason }) -> { dates, years, currentMentioned, relative, range }
//   deriveTemporal(question, { requestedAsOf, today, currentSeason }) -> {
//     source: "user" | "text" | "none",   asOf: ISO date | null,   comparison: boolean,   range: {...} | null,   needsDate: boolean, ... }
//
// Rules (docs/ai_desk, coordinator brief):
//  1. a date the caller passed as as_of wins;
//  2. a RANGE ("since 2011", "from 2011", "after 2011", "2011 onward", "2017 to 2025", "between 2017 and 2025", "the last five
//     seasons") is not one date: it is treated exactly like a multi-date comparison (below) and exposed as range = {from, to}
//     (to is null when the range runs to now; "the last N seasons" has from and to null and last_n/unit set);
//  3. else exactly one distinct explicit past (or future) date or year in the text -> that date (a bare year is YYYY-07-01;
//     "October 2025" is 2025-10-01); the current season's year is "now", not a past scope;
//  4. two or more distinct scopes (a comparison, including a past year next to the current season) -> no single date: the loop
//     refuses any tool call whose as_of is "current", and the validator rejects any used fact dated "current";
//  5. a relative past phrase ("last season", "yesterday", "two years ago") with no date to derive -> needsDate: the pipeline answers
//     with a code-built abstain card and makes no model call;
//  6. the router may only ADD precision (a date inside the same bare year, or a date when the text has no signal at all);
//  7. no signal -> "current".

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

// ── Ranges ────────────────────────────────────────────────────────────────────────────────────────
const TOKEN = "(\\d{4}-\\d{2}-\\d{2}|20[1-9]\\d)";
const BETWEEN_RE = new RegExp(`\\bbetween\\s+(?:the\\s+)?${TOKEN}\\s+(?:and|&)\\s+(?:the\\s+)?${TOKEN}(?![\\d-])`, "gi");
const SPAN_RE = new RegExp(`(?<![\\d-])(?:from\\s+)?${TOKEN}\\s*(?:to|through|thru|until|till|[-\\u2013\\u2014])\\s*${TOKEN}(?![\\d-])`, "gi");
const NUMBER_WORDS = { two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20 };
const LAST_N_RE = new RegExp(`\\b(?:the\\s+)?(?:last|past|previous|prior)\\s+(\\d{1,2}|${Object.keys(NUMBER_WORDS).join("|")})\\s+(seasons?|years?)\\b`, "gi");
// "since 2011", "from 2011", "after 2011" (directly before the date), "2011 onward", "2011 and later".
const OPEN_BEFORE = /\b(?:since|after|from)\s+(?:the\s+)?$/i;
const OPEN_AFTER = /^\s*(?:onwards?\b|forwards?\b|and\s+(?:later|after|beyond|on)\b)/i;
const tokenValue = (t) => (/^\d{4}$/.test(t) ? Number(t) : t);
const tokenKey = (t) => (/^\d{4}$/.test(t) ? `${t}-07-01` : t);

export function extractTemporal(question, { today, currentSeason } = {}) {
  const original = String(question || "");
  let text = original;
  let range = null;
  const setRange = (r) => { if (!range) range = r; };

  // 1. bounded ranges: "between 2017 and 2025", "2017 to 2025", "from 2017 through 2025", "2017-2025"
  const bounded = (m, a, b) => {
    const [x, y] = tokenKey(a) <= tokenKey(b) ? [a, b] : [b, a];
    setRange({ from: tokenValue(x), to: tokenValue(y) });
    return " ";
  };
  text = text.replace(BETWEEN_RE, (m, a, b) => bounded(m, a, b));
  text = text.replace(SPAN_RE, (m, a, b) => bounded(m, a, b));
  // 2. "the last N seasons / years" (N of one is the relative phrase "last season", handled below)
  text = text.replace(LAST_N_RE, (m, n, unit) => {
    const k = /^\d+$/.test(n) ? Number(n) : NUMBER_WORDS[n.toLowerCase()];
    if (!k || k < 2) return m;
    setRange({ from: null, to: null, last_n: k, unit: unit.toLowerCase().replace(/s$/, "") + "s" });
    return " ";
  });

  // 3. full dates (an open boundary makes the date the start of a range, not a single date)
  const dates = [];
  for (const { re, to } of DATE_PATTERNS) {
    text = text.replace(re, (...args) => {
      const m = args.slice(0, -2); // [match, ...captures]
      const offset = args[args.length - 2];
      const str = args[args.length - 1];
      const d = to(m);
      if (!d) return m[0];
      if (OPEN_BEFORE.test(str.slice(Math.max(0, offset - 14), offset)) || OPEN_AFTER.test(str.slice(offset + m[0].length, offset + m[0].length + 22))) setRange({ from: d, to: null });
      else dates.push(d);
      return " ";
    });
  }

  // 4. bare years
  const season = Number(currentSeason) || Number(String(today || new Date().toISOString()).slice(0, 4));
  const years = [];
  let currentMentioned = false;
  for (const m of text.matchAll(YEAR_RE)) {
    const y = Number(m[1]);
    if (OPEN_BEFORE.test(text.slice(Math.max(0, m.index - 14), m.index)) || OPEN_AFTER.test(text.slice(m.index + 4, m.index + 26))) { setRange({ from: y, to: null }); continue; }
    if (y === season) currentMentioned = true;
    else if (!years.includes(y)) years.push(y);
  }
  const relative = RELATIVE_RES.map((re) => (original.match(re) || [])[0]).filter(Boolean).map((s) => s.toLowerCase());
  return { dates: [...new Set(dates)], years: years.sort(), currentMentioned, relative, range };
}

export function deriveTemporal(question, { requestedAsOf = "current", today, currentSeason } = {}) {
  const t0 = today || new Date().toISOString().slice(0, 10);
  const base = { source: "none", asOf: null, comparison: false, range: null, needsDate: false, dates: [], years: [], relative: [], currentMentioned: false, bareYear: null };
  const ex = extractTemporal(question, { today: t0, currentSeason });
  Object.assign(base, { dates: ex.dates, years: ex.years, relative: ex.relative, currentMentioned: ex.currentMentioned, range: ex.range });
  if (requestedAsOf && requestedAsOf !== "current") return { ...base, source: "user", asOf: requestedAsOf };

  // A range is never one date: no override, "current" is forbidden to the loop and the validator, the model passes dates.
  if (ex.range) return { ...base, source: "text", comparison: true };

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
