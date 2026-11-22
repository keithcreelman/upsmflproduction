// UPS 2027 beta (PR A): an unresolved starter is a data gap, never a lineup error.
//   node tests/mobile2027_roster_unresolved.test.mjs
// Rule (owner ruling 2026-11-21): the mismatch threshold only chooses the screen-level message. A starter MFL names who is not in the roster read
// is listed apart ("Not in this roster read", "Can’t check"); no check that needs his position, slot, bye or injury is run for him; slot-fit and
// empty-slot checks still run for everyone else; a failed read is an error, never an empty lineup; a valid empty lineup still warns.
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
const state = (m, over) => ({ model: m, load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, teamId: "0009", tab: "team", sub: "roster", view: "lineup", open: {}, flags: {}, profile: null, sheet: null,
  skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, intel: { mu: {}, wk: {}, scores: {} }, requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });
const fresh = () => M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026);
const team = (m) => m.teams.find((x) => x.id === "0009");
const withIds = (ids) => { const m = fresh(), tm = team(m); tm.lineup = { state: "ok", count: ids.length, ids }; return m; };
const baseIds = () => team(fresh()).lineup.ids.slice();
const GHOST = ["99999001", "99999002", "99999003", "99999004"];

test("the coherent recorded team: none unresolved, every named starter placed, no data note", () => {
  const m = fresh(), tm = team(m), lu = R.lineupFor(state(m), tm, 11), coh = R.lineupCoherence(state(m), tm);
  t.ok(baseIds().length >= 15); t.ok(coh.ok); t.equal(coh.unresolved, 0); t.equal(lu.unresolved.length, 0); t.equal(lu.filled + lu.extra.length, baseIds().length);
  const tx = text(V.app(state(m))); t.doesNotMatch(tx, /Not in this roster read|couldn’t be matched|Can’t check/);
});

test("one unresolved starter: listed apart; never 'fits no lineup slot'; no placeholder name; no banner; the rest is still checked", () => {
  const ids = baseIds(); ids[3] = GHOST[0];
  const m = withIds(ids), tm = team(m), s = state(m), lu = R.lineupFor(s, tm, 11), coh = R.lineupCoherence(s, tm);
  t.ok(coh.ok, "one of eighteen does not trip the screen-level message"); t.equal(coh.unresolved, 1);
  const N = baseIds().length, emptyGrid = lu.slots.filter((x) => !x.player).length;
  t.deepEqual(lu.unresolved, [GHOST[0]]); t.equal(lu.extra.length, 0, "an unresolved starter is not an extra"); t.equal(lu.count, N); t.equal(lu.filled, N - 1);
  const a = R.attention(s, lu, 11); t.equal(a.unresolved.length, 1); t.equal(a.extras.length, 0); t.equal(a.empties.length, 0, "no slot is named empty: the unresolved starter may fill it"); t.equal(a.emptyCount, Math.max(0, emptyGrid - 1));
  const tx = text(V.app(s));
  t.match(tx, /Not in this roster read/); t.match(tx, /Player ID 99999001/); t.match(tx, /Can’t check/); t.match(tx, /1 starter couldn’t be matched to this roster read/);
  t.doesNotMatch(tx, /Starter fits no lineup slot/); t.doesNotMatch(tx, /Player 99999001/); t.doesNotMatch(tx, /Roster and lineup data don’t match/);
  t.match(tx, /1 can’t be checked/, "the summary does not claim an all-clear");
});

test("two unresolved starters: both listed apart, neither judged; the banner appears only if the threshold says so", () => {
  const ids = baseIds(); ids[3] = GHOST[0]; ids[9] = GHOST[1];
  const m = withIds(ids), tm = team(m), s = state(m), lu = R.lineupFor(s, tm, 11);
  t.ok(R.lineupCoherence(s, tm).ok, "2 of 18 is under a quarter"); t.deepEqual(lu.unresolved, [GHOST[0], GHOST[1]]); t.equal(lu.extra.length, 0);
  const tx = text(V.app(s)); t.match(tx, /2 starters couldn’t be matched to this roster read/); t.doesNotMatch(tx, /Starter fits no lineup slot/);
  // the same two among eight starters is a quarter: the threshold withholds the screen, and the rows are not judged either way
  const small = baseIds().slice(0, 6).concat([GHOST[0], GHOST[1]]), m2 = withIds(small), s2 = state(m2);
  t.equal(R.lineupCoherence(s2, team(m2)).ok, false); const tx2 = text(V.app(s2));
  t.match(tx2, /Roster and lineup data don’t match/); t.doesNotMatch(tx2, /Starter fits no lineup slot|Not in this roster read|Can’t check/);
});

test("the threshold chooses the message only: the unresolved starter is never a lineup error under it, and a genuine misfit still warns", () => {
  const base = baseIds(), qb = Object.values(fresh().byId).filter((p) => p.pos === "QB" && base.indexOf(p.id) < 0).slice(0, 3).map((p) => p.id);
  t.ok(qb.length === 3, "the recorded league has quarterbacks to use");
  const ids = base.concat(qb, [GHOST[0]]); // three more quarterbacks than the two QB-eligible slots can take, plus one unresolved starter
  const m = withIds(ids), tm = team(m), s = state(m), lu = R.lineupFor(s, tm, 11);
  t.ok(lu.extra.length >= 2, "extra quarterbacks genuinely fit no slot"); t.ok(lu.extra.every((p) => p.pos === "QB" && p.name), "each is a known player with a name");
  t.deepEqual(lu.unresolved, [GHOST[0]]); const tx = text(V.app(s));
  t.match(tx, /Starter fits no lineup slot/); t.doesNotMatch(tx, /99999001[^.]*fits no lineup slot|Player 99999001/);
});

test("widespread mismatch: the whole screen is the data-unavailable card; no row-level warning of any kind", () => {
  const ids = baseIds(); ids[1] = GHOST[0]; ids[2] = GHOST[1]; ids[3] = GHOST[2];
  const m = withIds(ids), s = state(m); t.equal(R.lineupCoherence(s, team(m)).ok, false);
  [["roster", "lineup"], ["roster", "byes"], ["contracts", "lineup"], ["performance", "lineup"]].forEach(([sub, view]) => {
    const tx = text(V.app(state(m, { sub, view }))); t.match(tx, /Roster and lineup data don’t match/); t.doesNotMatch(tx, /Starter fits no lineup slot|Not in this roster read|Can’t check|Empty/);
  });
});

test("a failed lineup read is an error state, never an empty lineup: no empty-slot claim, the roster still shows", () => {
  const m = fresh(), tm = team(m); tm.lineup = { state: "unavailable" };
  const s = state(m), tx = text(V.app(s));
  t.match(tx, /Lineup not available/); t.match(tx, /This is not an empty lineup/); t.doesNotMatch(tx, /Empty|fits no lineup slot|starters ·/);
  t.ok(R.lineupCoherence(s, tm).ok && !R.lineupCoherence(s, tm).checked, "no lineup, so no coherence judgment");
  t.match(tx, /Bench/, "the roster itself still draws");
  const noRead = M.build(FX.roster_workbench, FX.league, null, 11, 2026); t.equal(team(noRead).lineup.state, "unavailable", "a failed weekly read builds an unavailable lineup, not an empty one");
});

test("a valid empty lineup (read succeeded, team entry present, zero starters) is not a data gap: every slot is empty and warns", () => {
  const m = withIds([]), tm = team(m), s = state(m), lu = R.lineupFor(s, tm, 11), a = R.attention(s, lu, 11);
  t.ok(R.lineupCoherence(s, tm).ok); t.equal(lu.count, 0); t.equal(lu.unresolved.length, 0); t.equal(a.empties.length, 18); t.equal(a.n, 18);
  const tx = text(V.app(s)); t.match(tx, /0 of 18 starters/); t.match(tx, /QB1 · Empty/); t.doesNotMatch(tx, /Not in this roster read/);
  // a team that is absent from a successful lineup read is unknown, not empty
  const wr = JSON.parse(JSON.stringify(FX.weekly_results)); const mm = M.build(FX.roster_workbench, FX.league, wr, 11, 2026);
  t.ok(team(mm).lineup.state === "ok");
});

test("empty slots are counted, not named, while an unmatched starter may fill one", () => {
  const ids = baseIds().slice(0, 15).concat([GHOST[0]]); // 16 named, 15 resolved: two slots empty in the grid
  const m = withIds(ids), s = state(m), lu = R.lineupFor(s, team(m), 11), a = R.attention(s, lu, 11);
  t.equal(lu.slots.filter((x) => !x.player).length, 3); t.equal(a.empties.length, 0); t.equal(a.emptyCount, 2, "3 empty slots, one may be the unmatched starter's");
  const tx = text(V.app(s)); t.match(tx, /2 slots have no starter/); t.doesNotMatch(tx, /· Empty/);
});

test("stale or out-of-order: the lineup read is used only for the week it was read for", () => {
  const m = fresh(), tm = team(m), s = state(m);
  t.equal(R.lineupFor(s, tm, 12).state, "loading", "another week has no read yet: nothing is borrowed from the current lineup");
  t.equal(R.lineupFor(s, tm, 10).state, "loading");
  const s2 = state(m, { intel: { mu: {}, wk: { 10: { state: "error", error: "x" } }, scores: {} } }); t.equal(R.lineupFor(s2, tm, 10).state, "error");
  const older = M.build(FX.roster_workbench, FX.league, FX.weekly_results, 10, 2026), tmo = team(older);
  t.equal(R.lineupFor(state(older), tmo, 11).state, "loading", "a lineup read for Week 10 is not shown as Week 11");
});

run("mobile2027_roster_unresolved");
