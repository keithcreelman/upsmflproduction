// Desktop Player Stats: "Sched Δ" and "Opp ±%" (#1271), side-loaded from
// /api/sos-adjusted-points (the Pts Agst engine) and joined by MFL id. The columns are
// descriptive (uncolored, no easy/tough wording), "—" never 0 for a missing value, and
// a failed or refused answer is said on screen instead of leaving blank cells unexplained.
//   node tests/desktop_sched_delta.test.mjs
import fs from "fs";
import vm from "vm";
import assert from "assert";

const SRC = fs.readFileSync("site/stats_workbench/stats_workbench.html", "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };
function extractFn(name) {
  const start = SRC.indexOf("function " + name + "(");
  if (start < 0) throw new Error(name + " not found");
  let depth = 0, i = SRC.indexOf("{", start);
  for (; i < SRC.length; i++) { if (SRC[i] === "{") depth++; else if (SRC[i] === "}") { depth--; if (depth === 0) break; } }
  return SRC.slice(start, i + 1);
}
function extractCol(key) {
  const start = SRC.indexOf("    " + key + ":");
  if (start < 0) throw new Error(key + " not found");
  let depth = 0, i = SRC.indexOf("{", start);
  for (; i < SRC.length; i++) { if (SRC[i] === "{") depth++; else if (SRC[i] === "}") { depth--; if (depth === 0) break; } }
  return SRC.slice(SRC.indexOf("{", start), i + 1);
}
const helpers = SRC.slice(SRC.indexOf("  function sosKey(id)"), SRC.indexOf("\n", SRC.indexOf("  function sosRowFor(r)"))) + "\n" + extractFn("sosCellTitle");
function cols(byMfl) {
  const ctx = vm.createContext({ sosByMfl: byMfl });
  vm.runInContext(helpers + "\nvar C = { sos: " + extractCol("mfl_points_sos") + ", opp: " + extractCol("mfl_sched_opp") + " };", ctx);
  return ctx.C;
}
const fmt = (v, f) => { const ctx = vm.createContext({}); vm.runInContext(extractFn("fmtCell") + "\nvar out = fmtCell(" + JSON.stringify(v) + ", " + JSON.stringify(f) + ");", ctx); return ctx.out; };
const note = (sos, c) => { const ctx = vm.createContext({}); vm.runInContext(extractFn("sosNoteText") + "\nvar out = sosNoteText(" + JSON.stringify(sos) + ", " + JSON.stringify(c) + ");", ctx); return ctx.out; };

console.log("1. the two columns");
const BY = { "9431": { pos: "QB", raw: 86.1, gp: 3, rated: 2, others: 6, opp: 1.083, adj: 79.5, delta: -6.6 }, "15237": { pos: "QB", raw: 30, gp: 1, rated: 0, others: 0, opp: null, adj: null, delta: null } };
check("labels Sched Δ / Opp ±%, uncolored formats", () => {
  const C = cols(BY);
  assert.strictEqual(C.sos.label, "Sched Δ"); assert.strictEqual(C.opp.label, "Opp ±%");
  assert.strictEqual(C.sos.fmt, "sdelta"); assert.strictEqual(C.opp.fmt, "spct");
});
check("joined by MFL id (a number on the leaderboard row, with or without leading zeros)", () => {
  const C = cols(BY);
  assert.strictEqual(C.sos.compute({ mfl_pid: 9431, gsis_id: "x" }), -6.6);
  assert.strictEqual(C.sos.compute({ mfl_pid: "09431" }), -6.6);
  assert.strictEqual(C.opp.compute({ mfl_pid: 9431 }), 8);
});
check("unrated, unknown or missing → null (shows —), never 0", () => {
  const C = cols(BY);
  assert.strictEqual(C.sos.compute({ mfl_pid: 15237 }), null); assert.strictEqual(C.opp.compute({ mfl_pid: 15237 }), null);
  assert.strictEqual(C.sos.compute({ mfl_pid: 1 }), null); assert.strictEqual(C.sos.compute({}), null);
  assert.strictEqual(fmt(null, "sdelta"), "—"); assert.strictEqual(fmt(null, "spct"), "—");
});
check("cells are signed text with no good/bad color and a real minus sign, as Pts Agst writes them: +3.4, −2.1, 0.0, +8%, −5%", () => {
  assert.strictEqual(fmt(3.4, "sdelta"), "+3.4"); assert.strictEqual(fmt(-2.1, "sdelta"), "−2.1"); assert.strictEqual(fmt(0, "sdelta"), "0.0");
  assert.strictEqual(fmt(8, "spct"), "+8%"); assert.strictEqual(fmt(-5, "spct"), "−5%"); assert.strictEqual(fmt(0, "spct"), "0%");
  assert.ok(!/asw-trend|up|dn/.test(fmt(3.4, "sdelta") + fmt(-5, "spct")));
});
check("each cell's hover says what it rests on, or why it's blank", () => {
  const C = cols(BY);
  assert.strictEqual(C.sos.titleFn({ mfl_pid: 9431 }), "86.1 MFL pts in 3 final games; opponents rated on 2 of them, from 6 other player-games (Opp +8%).", "rated (2), not games (3); Opp written as in its cell");
  assert.strictEqual(C.opp.titleFn({ mfl_pid: 9431 }), C.sos.titleFn({ mfl_pid: 9431 }));
  assert.match(C.sos.titleFn({ mfl_pid: 15237 }), /^1 game; no other player at his position with 2\+ games in these weeks faced those teams/);
  assert.strictEqual(C.sos.titleFn({ mfl_pid: 1 }), "No final games for him in these weeks.");
  const C2 = cols({ "9431": { pos: "QB", raw: 86.1, gp: 3, rated: 3, opp: 1.083, adj: 79.5, delta: -6.6 } });
  assert.strictEqual(C.sos.titleFn({ mfl_pid: null, gsis_id: "00-1" }), "No MFL id for this player, so no schedule numbers.", "a leaderboard row with no MFL id says so");
  assert.strictEqual(C2.sos.titleFn({ mfl_pid: 9431 }), "86.1 MFL pts in 3 final games; opponents rated on 3 of them (Opp +8%).", "an answer without the count never prints undefined");
});
check("tooltips describe; no easy / tough / inflated / understates; say it isn't a forecast", () => {
  const C = cols(BY);
  for (const t of [C.sos.title, C.opp.title]) assert.ok(!/\beasy\b|\btough\b|inflat|understat|generous|hard schedule/i.test(t), t);
  assert.ok(/isn’t a forecast/.test(C.sos.title));
  assert.ok(/MFL’s own scores/.test(C.sos.title) && /differ from MFL Pts/.test(C.sos.title), "says its points can differ from the MFL Pts column");
  assert.ok(/his own games left out/.test(C.opp.title));
});
check("every tab's MFL Details group carries both columns (11 tabs)", () => {
  const n = (SRC.match(/cols:\["mfl_points","mfl_ppg","mfl_points_sos","mfl_sched_opp"\]/g) || []).length;
  assert.strictEqual(n, 11);
  assert.ok(!/cols:\["mfl_points","mfl_ppg","mfl_points_sos"\]/.test(SRC));
});

console.log("\n2. the note: which weeks, or why the cells read —");
const SHOW = ["mfl_points", "mfl_points_sos", "mfl_sched_opp"];
check("hidden when neither column shows, and while loading", () => {
  assert.strictEqual(note({ status: "ok", perSeason: { 2025: { state: "complete", weeksUsed: [15, 16, 17] } } }, ["mfl_points"]), "");
  assert.strictEqual(note({ status: "loading" }, SHOW), "");
});
check("complete season: the definition and the weeks used", () => {
  const t = note({ status: "ok", perSeason: { 2025: { state: "complete", weeksUsed: [15, 16, 17], weeksInProgress: [], weeksNotPlayed: [], window: { clipped_to_end: false } } } }, SHOW);
  assert.match(t, /^Sched Δ \/ Opp ±%: what the teams he faced allowed his position vs usual \(Pts Agst, final games, MFL’s own scores — not always MFL Pts in playoff weeks\)\. Describes his schedule; not a forecast\./);
  assert.match(t, /2025: Wks 15–17\. Few weeks/);
});
check("short windows (under 6 weeks used) add one sentence on small samples; full seasons don't", () => {
  const few = note({ status: "ok", perSeason: { 2025: { state: "complete", weeksUsed: [15, 16, 17], window: {} } } }, SHOW);
  assert.match(few, / Few weeks: each opponent is rated on a handful of games, so values swing widely\.$/);
  const full = note({ status: "ok", perSeason: { 2025: { state: "complete", weeksUsed: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14], window: {} } } }, SHOW);
  assert.ok(!/Few weeks/.test(full));
});
check("the Few-weeks sentence: only when EVERY season used fewer than 6 weeks; one week says nothing can be compared", () => {
  const wk = (n) => ({ state: "complete", weeksUsed: Array.from({ length: n }, (_, i) => i + 1), window: {} });
  assert.match(note({ status: "ok", perSeason: { 2025: wk(5) } }, SHOW), /Few weeks/);
  assert.doesNotMatch(note({ status: "ok", perSeason: { 2025: wk(6) } }, SHOW), /Few weeks|One week/);
  assert.doesNotMatch(note({ status: "ok", perSeason: { 2024: wk(3), 2025: wk(14) } }, SHOW), /Few weeks/, "a full second season isn't a small sample");
  assert.match(note({ status: "ok", perSeason: { 2025: wk(1) } }, SHOW), /2025: Wks 1\. One week: each player’s usual would be that game, so there’s nothing to compare; both show “—”\.$/);
});
check("in-season: a week in progress and the weeks not played yet are named", () => {
  const t = note({ status: "ok", perSeason: { 2026: { state: "partial", weeksUsed: [1, 2, 3, 4, 5, 6], weeksInProgress: [6], weeksNotPlayed: [7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17], window: {} } } }, SHOW);
  assert.match(t, /2026: Wks 1–6; Wk 6 in progress, only its finished games count; Wks 7–17 not played yet\./);
  const u = note({ status: "ok", perSeason: { 2026: { state: "partial", weeksUsed: [1, 2, 3, 4, 5], weeksInProgress: [], weeksNotPlayed: [6, 7], window: {} } } }, SHOW);
  assert.match(u, /2026: Wks 1–5; Wks 6–7 not played yet\./);
});
check("2020 'MFL Playoffs' (15–17): says the season ended at Wk 16, its playoffs were 14–16, and Wk 14 isn't in the range", () => {
  const t = note({ status: "ok", perSeason: { 2020: { state: "complete", weeksUsed: [15, 16], weeksInProgress: [], weeksNotPlayed: [], endWeek: 16, playoffWeeks: [14, 15, 16], window: { week_min: 15, week_max: 16, clipped_to_end: true } } } }, SHOW);
  assert.match(t, /2020: Wks 15–16 \(season ended at Wk 16; its playoffs were Wks 14–16, Wk 14 not in this range\)\./);
});
check("a season not started, or with no weeks in range, is said, not filled in", () => {
  const t = note({ status: "ok", perSeason: { 2027: { state: "not_started" }, 2020: { state: "outside_season", endWeek: 16 } } }, SHOW);
  assert.match(t, /2020 has no weeks in this range \(its season ended at Wk 16\) · 2027 hasn't started\./);
});
check("failures say why both columns read —, and that nothing is filled in", () => {
  assert.match(note({ status: "error", error: "mfl_unavailable", season: "2025", detail: "MFL read failed: player scores (weeks 16)" }, SHOW),
    /Both show “—”: MFL couldn't be read for 2025 \(MFL read failed: player scores \(weeks 16\)\)\. Nothing is filled in from another season\./);
  assert.match(note({ status: "error", error: "too_many_live_seasons", detail: "Seasons 2015, 2016 each need a live MFL read; choose at most 1 of them at a time." }, SHOW),
    /Both show “—”: Seasons 2015, 2016 each need a live MFL read; choose at most 1 of them at a time\. Nothing is filled in/);
  assert.ok(!/\.\./.test(note({ status: "error", error: "too_many_live_seasons", detail: "Seasons 2015, 2016 each need a live MFL read; choose at most 1 of them at a time." }, SHOW)), "no double period");
  assert.match(note({ status: "error", error: "HTTP 500" }, SHOW), /Both show “—”: the answer didn't load \(HTTP 500\)\./);
  assert.match(note({ status: "error", error: "unreachable", detail: "" }, SHOW), /Both show “—”: the answer didn't load \(unreachable\)\./, "the server can't be reached: said too");
  assert.match(note({ status: "error", error: "old_server" }, SHOW), /Both show “—”: the server is still on the previous version; reload in a minute\./);
});

console.log("\n3. wiring");
check("the fetch keeps a failed or refused answer (state.sos error) instead of silently emptying it", () => {
  const i = SRC.indexOf("var sosFetch = fetch(API_BASE + \"/api/sos-adjusted-points?seasons=\"");
  const block = SRC.slice(i, SRC.indexOf("var consistFetch", i));
  assert.ok(/getScopeQueryParams\(\)/.test(block), "same week window as the board");
  assert.ok(/state\.sos = \{ status: "error"/.test(block) && /x\.j\.error/.test(block) && /x\.j\.detail/.test(block));
  assert.ok(/\.catch\(function\(\)\{ sosByMfl = \{\}; state\.sos = \{ status: "error", error: "unreachable", detail: "" \}; \}\)/.test(block), "a network failure is kept as 'unreachable', not dropped");
  assert.ok(/x\.ok && x\.j && x\.j\.ok && x\.j\.by_mfl\)/.test(block) && /sosByMfl = x\.j\.by_mfl;/.test(block), "an old answer without by_mfl is not taken as data");
  assert.ok(/\(x\.j && x\.j\.ok\) \? "old_server"/.test(block));
  assert.ok(!/by_gsis/.test(block) && !/sosByGsis/.test(SRC));
});
check("the note is drawn into the definitions slot on every render", () => {
  assert.match(extractFn("renderSosNote"), /var sosLine = sosNoteText\(state\.sos, cols\);/);
  assert.match(SRC, /renderSourceFreshnessNote\(cols\);\s*\n\s*renderDefinitionNote\(cols\);\s*\n\s*renderSosNote\(cols\);/);
  assert.ok(!/sosNoteText/.test(extractFn("renderDefinitionNote")), "the EPA / red-zone note stays on its own");
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
