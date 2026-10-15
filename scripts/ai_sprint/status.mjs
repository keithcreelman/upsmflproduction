#!/usr/bin/env node
// AI sprint status, read deterministically (docs/AI_SPRINT_PROTOCOL.md).
//
//   gh api repos/keithcreelman/upsmflproduction/issues/<n>/comments --paginate --slurp > comments.json
//   node scripts/ai_sprint/status.mjs comments.json
//
// Prints the current authenticated status line and Keith's rulings for an issue
// or PR, and lists every comment it ignored and why. It reads a file; it makes
// no network call and writes nothing.
//
// Rules it enforces (tests/ai_sprint_protocol.test.mjs proves each one):
//   * A status line counts only if its comment's author is on TRUSTED_AUTHORS,
//     matched by exact login AND numeric account id, and the comment was never
//     edited. Everyone else's status lines are ignored, however new they are.
//   * A ruling is a comment by Keith's exact identity whose first line is not a
//     status line. A comment merely lacking a status line is not a ruling.
//   * Severity depends only on the category and the concrete scenario, never on
//     the round in which a finding was noticed or whether the code changed.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PROTOCOL_VERSION = "v2";

// Keith's GitHub identity. Agents post status comments through his connection
// in Sprint 0, so this one identity covers both his rulings and agent status
// lines (told apart by the status line itself).
export const KEITH = Object.freeze({ login: "keithcreelman", id: 52132568 });

// Accounts whose AI-SPRINT status lines count. Sprint 1 adds the specific bot
// identity it creates (login + id) here, by Keith's ruling -- never a pattern
// such as "any [bot]".
export const TRUSTED_AUTHORS = Object.freeze([KEITH]);

export const STATES = ["BUILDING", "REVIEW-REQUESTED", "CHANGES", "CLEAN", "READY", "NEEDS-KEITH", "BLOCKED"];
export const NEXT = ["claude", "codex", "keith"];

// docs/AI_SPRINT_PROTOCOL.md §5. A finding is MATERIAL when it names a concrete
// scenario in one of these categories; 2, 3 and 6 need only a plausible path.
export const MATERIAL_CATEGORIES = Object.freeze({
  1: "wrong owner-facing result",
  2: "unauthorized side effect",
  3: "security or privacy",
  4: "fail-open guard",
  5: "D1 cost",
  6: "irreversible change without dry run and Keith's go",
  7: "false evidence or unmet definition of done",
  8: "rule change without a ruling",
});
const PLAUSIBLE_PATH_ENOUGH = new Set([2, 3, 6]);

// `AI-SPRINT v2 | issue #N | round R/2 | <agent> <role> | <STATE> | head <sha7> | tested <sha7|none> | next <who>`
const STATUS_RE = /^AI-SPRINT (v\d+) \| issue #(\d+) \| round (\d)\/(\d) \| (claude|codex) (builder|reviewer) \| ([A-Z-]+) \| head ([0-9a-f]{7,40}) \| tested ([0-9a-f]{7,40}|none) \| next (claude|codex|keith)$/;

export function firstLine(body) {
  return String(body ?? "").replace(/^﻿/, "").split(/\r?\n/, 1)[0].trim();
}

export function looksLikeStatus(body) {
  return firstLine(body).startsWith("AI-SPRINT");
}

export function parseStatusLine(line) {
  const m = STATUS_RE.exec(String(line).trim());
  if (!m) return null;
  const [, version, issue, round, max, agent, role, state, head, tested, next] = m;
  if (!STATES.includes(state)) return null;
  return { version, issue: Number(issue), round: Number(round), max: Number(max), agent, role, state, head, tested, next };
}

export function isTrusted(user, allow = TRUSTED_AUTHORS) {
  return Boolean(user) && allow.some((a) => a.login === user.login && a.id === user.id);
}

export function isKeith(user) {
  return Boolean(user) && user.login === KEITH.login && user.id === KEITH.id;
}

function edited(c) {
  return Boolean(c.updated_at && c.created_at && c.updated_at !== c.created_at);
}

const byCreated = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || (a.id ?? 0) - (b.id ?? 0);

// The newest valid status from a trusted author. Everything else that looks
// like a status line is reported in `ignored` with the reason.
export function currentStatus(comments, allow = TRUSTED_AUTHORS) {
  const ignored = [];
  let current = null;
  for (const c of [...comments].sort(byCreated)) {
    if (!looksLikeStatus(c.body)) continue;
    const who = c.user ? `${c.user.login}#${c.user.id}` : "unknown";
    if (!isTrusted(c.user, allow)) { ignored.push({ id: c.id, who, reason: "author is not on the trusted list" }); continue; }
    if (edited(c)) { ignored.push({ id: c.id, who, reason: "status comment was edited (status comments are append-only)" }); continue; }
    const version = (/^AI-SPRINT (v\d+)\b/.exec(firstLine(c.body)) || [])[1];
    if (version && version !== PROTOCOL_VERSION) { ignored.push({ id: c.id, who, reason: `superseded protocol version ${version}` }); continue; }
    const s = parseStatusLine(firstLine(c.body));
    if (!s) { ignored.push({ id: c.id, who, reason: "malformed status line" }); continue; }
    current = { ...s, comment: c.id, at: c.created_at, url: c.html_url };
  }
  return { current, ignored };
}

// Keith's rulings: his exact identity, and not an agent status comment.
export function keithRulings(comments) {
  return [...comments].sort(byCreated)
    .filter((c) => isKeith(c.user) && !looksLikeStatus(c.body))
    .map((c) => ({ id: c.id, at: c.created_at, url: c.html_url, edited: edited(c), text: String(c.body).trim() }));
}

// Severity from the finding's category and scenario only. `round`, `foundInRound`
// and `codeChangedSinceRound1` are accepted and deliberately ignored: narrowing
// round 2's review scope must never turn a real material problem into a minor one.
export function severity(finding) {
  const cat = Number(finding.category);
  if (!MATERIAL_CATEGORIES[cat]) return "MINOR";
  if (finding.scenario && String(finding.scenario).trim()) return "MATERIAL";
  if (PLAUSIBLE_PATH_ENOUGH.has(cat) && finding.plausiblePath && String(finding.plausiblePath).trim()) return "MATERIAL";
  return "MINOR";
}

// gh --paginate --slurp gives an array of pages; a plain call gives one array.
export function flattenComments(json) {
  const v = typeof json === "string" ? JSON.parse(json) : json;
  return Array.isArray(v) && v.every(Array.isArray) ? v.flat() : v;
}

function main(argv) {
  if (!argv[0]) {
    console.error("usage: node scripts/ai_sprint/status.mjs <comments.json>   (from gh api .../issues/<n>/comments --paginate --slurp)");
    return 2;
  }
  const comments = flattenComments(fs.readFileSync(argv[0], "utf8"));
  const { current, ignored } = currentStatus(comments);
  console.log(current
    ? `Current status (comment ${current.comment}, ${current.at}):\n  round ${current.round}/${current.max} · ${current.agent} ${current.role} · ${current.state} · head ${current.head} · tested ${current.tested} · next ${current.next}`
    : "No valid status line from a trusted author.");
  const rulings = keithRulings(comments);
  console.log(`\nKeith's comments (rulings only once recorded): ${rulings.length}`);
  for (const r of rulings) console.log(`  ${r.at}${r.edited ? " (edited)" : ""}: ${r.text.split("\n")[0].slice(0, 120)}`);
  if (ignored.length) {
    console.log(`\nIgnored status-like comments: ${ignored.length}`);
    for (const i of ignored) console.log(`  comment ${i.id} by ${i.who}: ${i.reason}`);
  }
  return 0;
}

// Compare real paths: invoked through a symlink (macOS /var -> /private/var, a
// symlinked checkout) a plain path comparison is false and the script would
// silently do nothing and exit 0 -- a pass that tested nothing.
const invokedDirectly = (() => {
  try { return Boolean(process.argv[1]) && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url)); }
  catch { return false; }
})();
if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
