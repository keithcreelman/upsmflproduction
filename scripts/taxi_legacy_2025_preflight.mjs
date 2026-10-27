// READ-ONLY preflight for the 2025 taxi legacy rule (#1364, Keith 2026-10-21) — run before merging, and again after
// deploying if in doubt. It runs the worker's OWN reader (taxiLegacy2025Pids, cut out of worker/src/index.js by its
// text) against MFL's public exports, with a database stub that holds no cache and REFUSES every write, then checks it:
//   - all three drafts (2023–2025) and all seventeen 2025 weekly rosters (W=1–17) answer, each with franchises;
//   - the worker's set equals an independent recomputation from the same responses (Round 2+ picks of those drafts,
//     listed ROSTER or INJURED_RESERVE in any week);
//   - optionally (--expect N) the set has exactly N players.
// --fail-week N makes MFL's week-N roster export unreadable (the request is answered 503 locally, never sent) and
// checks the reader FAILS CLOSED: no set, nothing stored — and what that means for a player it could decide (the
// shared rule: "Eligibility could not be confirmed", no Demote, the cut held rather than priced at $0).
// No production D1, no worker route, no MFL write: only GETs of public MFL exports.
//   node scripts/taxi_legacy_2025_preflight.mjs [--expect 70] [--fail-week 12] [--json out.json]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { taxiEligibility, taxiCutVerdict, TAXI_LEGACY_SEASON } from "../worker/src/taxi_rule.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : null; };
const expect = arg("--expect") != null ? Number(arg("--expect")) : null;
const failWeek = arg("--fail-week") != null ? Number(arg("--fail-week")) : null;
const jsonOut = arg("--json");
const i = SRC.indexOf("const TAXI_LEGACY_2025_CACHE_KEY ="), j = SRC.indexOf("// The 2025 legacy answer for one player", i);
if (i < 0 || j < 0) throw new Error("taxiLegacy2025Pids not found in worker/src/index.js");

const seen = [];   // every export the reader asked for: { type, year, week, status, franchises, picks }
const realFetch = globalThis.fetch;
const fetchLogged = async (url, init) => {
  const u = new URL(url);
  const type = u.searchParams.get("TYPE"), week = u.searchParams.get("W"), year = u.pathname.split("/")[1];
  const rec = { type, year, week: week ? Number(week) : null, status: 0, franchises: 0, picks: 0, body: null };
  seen.push(rec);
  if (init && init.method && init.method !== "GET") throw new Error("preflight: only GETs are allowed");
  if (failWeek != null && type === "rosters" && Number(week) === failWeek) {
    rec.status = 503; rec.simulated = true;
    return new Response("simulated: MFL did not answer", { status: 503 });
  }
  const r = await realFetch(url, init);
  rec.status = r.status;
  const text = await r.text();
  try {
    const j2 = JSON.parse(text); rec.body = j2;
    const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
    if (type === "rosters") rec.franchises = arr(j2 && j2.rosters && j2.rosters.franchise).length;
    if (type === "draftResults") rec.picks = arr(j2 && j2.draftResults && j2.draftResults.draftUnit).flatMap((u2) => arr(u2 && u2.draftPick)).filter((p) => p && p.player).length;
  } catch (_) { /* not JSON: the reader treats it as unreadable */ }
  return new Response(text, { status: r.status, headers: { "content-type": "application/json" } });
};
const writes = [];
const db = { prepare: (sql) => ({ bind: (...a) => ({
  first: async () => null,                                                        // no stored answer: read MFL
  run: async () => { writes.push({ sql, a }); throw new Error("preflight: database writes are refused"); },
}) }) };
const reader = new Function("fetch", "TAXI_LEGACY_SEASON", SRC.slice(i, j) + "\nreturn taxiLegacy2025Pids;")(fetchLogged, TAXI_LEGACY_SEASON);

const set = await reader({ UPS_MFL_DB: db }, "74598");
const rosters = seen.filter((x) => x.type === "rosters"), drafts = seen.filter((x) => x.type === "draftResults");
const problems = [];
const report = { ran_at: new Date().toISOString(), fail_week: failWeek, drafts: drafts.map(({ year, status, picks }) => ({ year, status, picks })),
  weeks: rosters.map(({ week, status, franchises, simulated }) => ({ week, status, franchises, simulated: !!simulated })), writes_attempted: writes.length };

if (failWeek == null) {
  if (drafts.length !== 3 || drafts.some((d) => d.status !== 200 || !d.picks)) problems.push("a draft export didn't answer with picks");
  if (rosters.length !== 17 || rosters.some((w) => w.status !== 200 || !w.franchises)) problems.push("not all seventeen 2025 weekly roster exports answered with franchises");
  if (!set) problems.push("the reader returned no set (unreadable)");
  // Independent recomputation from the same responses.
  const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const r2 = new Set(drafts.flatMap((d) => arr(d.body.draftResults.draftUnit).flatMap((u2) => arr(u2.draftPick)))
    .filter((p) => p && p.player && Number(p.round) >= 2).map((p) => String(p.player)));
  const indep = new Set();
  const weeksOf = {};
  for (const w of rosters) for (const fr of arr(w.body && w.body.rosters && w.body.rosters.franchise)) for (const p of arr(fr.player)) {
    if (r2.has(String(p.id)) && /^(ROSTER|INJURED_RESERVE)$/.test(String(p.status))) { indep.add(String(p.id)); (weeksOf[p.id] = weeksOf[p.id] || []).push(w.week + (p.status === "INJURED_RESERVE" ? "IR" : "")); }
  }
  const a = [...(set || [])].sort(), b = [...indep].sort();
  if (JSON.stringify(a) !== JSON.stringify(b)) problems.push("the worker's set differs from the independent recomputation");
  if (expect != null && a.length !== expect) problems.push(`expected ${expect} players, got ${a.length}`);
  if (writes.length !== 1) problems.push("the reader should try to store its frozen answer exactly once (refused here)");
  report.legacy_count = a.length;
  report.legacy = a.map((pid) => ({ pid, weeks: weeksOf[pid] }));
} else {
  if (set !== null) problems.push(`week ${failWeek} unreadable, but the reader returned a set`);
  if (writes.length) problems.push("an unreadable read tried to store an answer");
  // What a null answer means for a player it could decide (a 2025 Round 2 pick, never called up, on the active roster).
  const cut = { season: 2026, upsRound: 2, upsYear: 2025, draftKnown: true, used: 0, pending: 0, permanent: false, legacy2025: set === null ? null : false };
  const v = taxiEligibility({ ...cut, contractStatus: "Rookie-Draft", isTaxi: false, isIr: false });
  report.consequence = { eligible: v.eligible, text: v.text, detail: v.detail, can_demote: v.can_demote,
    cut_verdict_from_active: taxiCutVerdict(cut, "Rookie-Draft", false), cut_verdict_from_taxi: taxiCutVerdict(cut, "Rookie-Draft", true) };
  if (v.eligible !== null || v.can_demote !== false || report.consequence.cut_verdict_from_active !== null || report.consequence.cut_verdict_from_taxi !== null) {
    problems.push("an unreadable 2025 record did not fail closed");
  }
  const later = rosters.filter((w) => w.week > failWeek).length;
  report.stopped_at_week = failWeek; report.weeks_read_after_failure = later;
}
report.ok = problems.length === 0; report.problems = problems;
const slim = { ...report };
if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(slim, null, 1));
console.log(JSON.stringify({ ...slim, legacy: slim.legacy ? `${slim.legacy.length} players (see --json)` : undefined }, null, 1));
process.exit(report.ok ? 0 : 1);
