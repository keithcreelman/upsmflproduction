// UPS 2027 beta: roster/lineup coherence. Phone-review defect (2026-11-21): a team showed "Active 1 of 30" next to an 18-man lineup, generic
// "Player <id>" names, unknown positions and 18 "Starter fits no lineup slot" warnings.
//   node tests/mobile2027_roster_coherence.test.mjs
//
// Cause (reproduced below from the recorded data): the roster read for that team held 1 active player while MFL's submitted Week 11 lineup named
// 18 starters, so every starter resolved to a placeholder and was then judged as if the roster were complete. In the recorded-data artifact 10 of 12
// teams are like that (the recorded roster fixture is a trimmed copy). The same code ran in the real build, so a partial roster read there would draw
// the same false warnings: the defect was in the build, not only in the artifact.
// Fix: incomplete roster/lineup data draws one explicit data-unavailable state, and no lineup judgment; a genuine lineup problem on a coherent team
// (one or two starters dropped after the lineup was set, an empty slot, an injury) keeps its normal warning.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src", "lib");
const require = createRequire(import.meta.url);
const M = require(path.join(SRC, "model.js")), R = require(path.join(SRC, "roster.js")), V = require(path.join(SRC, "views.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const model = () => M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026);
const state = (over) => ({
  model: model(), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, teamId: "0010", tab: "team", sub: "roster", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, intel: { mu: {}, wk: {}, scores: {} },
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}),
});
const BAD = ["0008", "0006", "0004", "0012", "0007"]; // recorded teams whose roster read is a few players against a full lineup
const GOOD = ["0010", "0009"];

test("reproduction: the recorded teams resolve their lineup to placeholders (the cause), the coherent ones do not", () => {
  const m = model();
  BAD.forEach((id) => {
    const tm = m.teams.find((x) => x.id === id), coh = R.lineupCoherence({ model: m }, tm);
    t.ok(coh.checked && !coh.ok, id + ": incoherent"); t.ok(coh.unresolved >= coh.total - 2, id + ": nearly every starter is unresolved (" + coh.unresolved + " of " + coh.total + ")");
    t.ok(tm.counts.active < coh.total, id + ": fewer active players (" + tm.counts.active + ") than starters (" + coh.total + "), which no real roster can have");
    const lu = R.lineupFor({ model: m, teamId: id, wk: null, intel: { mu: {}, wk: {} } }, tm, 11);
    t.ok(lu.extra.length >= coh.total - 2 && lu.extra.every((p) => p.status === "gone" || p.name), id + ": the starters fall through as 'fits no slot' placeholders without the guard");
  });
  GOOD.forEach((id) => { const coh = R.lineupCoherence({ model: model() }, model().teams.find((x) => x.id === id)); t.ok(coh.checked && coh.ok && coh.unresolved === 0, id + ": coherent"); });
});

test("an incoherent team shows one data-unavailable state on every Team screen: no placeholder names, no 'fits no lineup slot', no starters, no bench, no contracts total", () => {
  BAD.forEach((id) => [["roster", "lineup"], ["roster", "byes"], ["contracts", "lineup"], ["performance", "lineup"]].forEach(([sub, view]) => {
    const html = V.app(state({ teamId: id, sub, view })), tx = text(html);
    t.match(tx, /Roster and lineup data don’t match/, id + " " + sub + "/" + view);
    t.match(tx, /MFL’s Week 11 lineup lists \d+ starters, but \d+ of them are not on this team’s roster/);
    t.doesNotMatch(tx, /Starter fits no lineup slot/); t.doesNotMatch(tx, /Player \d+/); t.doesNotMatch(tx, /need attention|needs attention/);
    t.doesNotMatch(tx, /starters ·|Bench ·|Injured reserve ·|Recorded salary, not cap space/);
    t.match(html, /role="alert"/); t.match(html, /data-act="retry"/);
    t.doesNotMatch(html, /class="rx/, "no player row is drawn from incomplete data");
  }));
  // the picker and the counts line still say whose team it is and what the roster read held
  t.match(text(V.app(state({ teamId: "0008" }))), /Real Deal Creel[\s\S]*Active 1 of 30/);
});

test("a coherent team keeps everything, including genuine lineup warnings", () => {
  GOOD.forEach((id) => {
    const html = V.app(state({ teamId: id })), tx = text(html);
    t.doesNotMatch(tx, /Roster and lineup data don’t match/); t.match(tx, /Week 11 starters/); t.match(html, /class="rx/);
  });
  // a genuine empty slot is still reported (team 0010 has 17 of 18 starters)
  t.match(text(V.app(state({ teamId: "0010" }))), /17 of 18 starters · 1 needs attention/); t.match(text(V.app(state({ teamId: "0010" }))), /DF · Empty/);
  // Contracts and Performance for a coherent team are drawn
  t.match(text(V.app(state({ teamId: "0010", sub: "contracts" }))), /Recorded salary, not cap space/);
});

test("the line between a real problem and a data problem: one or two starters dropped after the lineup was set keep their warnings; three, or a quarter of the lineup, is a data problem", () => {
  const withMissing = (n) => { const m = model(), tm = m.teams.find((x) => x.id === "0009"); for (let i = 0; i < n; i++) tm.lineup.ids[i] = "9999990" + i; return m; };
  [0, 1, 2].forEach((n) => {
    const m = withMissing(n), tm = m.teams.find((x) => x.id === "0009"), coh = R.lineupCoherence({ model: m }, tm);
    t.ok(coh.ok, n + " unresolved of " + coh.total + " is a real lineup case"); t.equal(coh.unresolved, n);
    const tx = text(V.app(state({ model: m, teamId: "0009" })));
    t.doesNotMatch(tx, /Roster and lineup data don’t match/);
    if (n) t.equal((tx.match(/Starter fits no lineup slot/g) || []).length, n, "each genuinely unresolved starter still draws its warning");
  });
  const m3 = withMissing(3), tm3 = m3.teams.find((x) => x.id === "0009");
  t.ok(!R.lineupCoherence({ model: m3 }, tm3).ok, "three unresolved is a data problem"); t.match(text(V.app(state({ model: m3, teamId: "0009" }))), /Roster and lineup data don’t match/);
  // a short lineup (12 starters): two unresolved is already a quarter
  const ms = model(), ts = ms.teams.find((x) => x.id === "0009"); ts.lineup.ids = ts.lineup.ids.slice(0, 8); ts.lineup.ids[0] = "9999990"; ts.lineup.ids[1] = "9999991";
  t.ok(!R.lineupCoherence({ model: ms }, ts).ok, "two of eight is a data problem");
});

test("a starter now on another franchise counts as unresolved, a missing or failed lineup read is not judged, and the guard never throws on odd input", () => {
  const m = model(), tm = m.teams.find((x) => x.id === "0009"), other = m.teams.find((x) => x.id === "0010").players[0].id;
  tm.lineup.ids[0] = other; t.equal(R.lineupCoherence({ model: m }, tm).unresolved, 1);
  const noLineup = model(); noLineup.teams.find((x) => x.id === "0008").lineup = { state: "unavailable" };
  const c = R.lineupCoherence({ model: noLineup }, noLineup.teams.find((x) => x.id === "0008")); t.ok(!c.checked && c.ok, "no lineup read: nothing to compare, so no data-unavailable claim");
  t.ok(R.lineupCoherence({ model: null }, null).ok); t.ok(R.lineupCoherence({ model: model() }, undefined).ok);
});

await run("mobile2027_roster_coherence");
