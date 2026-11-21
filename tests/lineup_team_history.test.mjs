// W1: historical NFL club evidence in GET /api/lineup-matchups (worker/src/lineup_matchups.js, lmuTeamHistory).
// Replays the real handler on a real-data fixture (the league as of 2026-11-21, Week 11 in progress, history through
// Week 10) and checks: nothing that existed before changed; the new fields say what the Worker can know and no more;
// known mapping defects stay unavailable; seeded identity swaps are caught (and what is NOT caught is counted, not hidden).
// The fixture comes from public files with no production database read (see docs/TEAM_HISTORY_MAPPING.md).
//   node tests/lineup_team_history.test.mjs
import fs from "fs";
import assert from "assert";
import * as LM from "../worker/src/lineup_matchups.js";
import { loadFixture, runHandler } from "./helpers/team_history_fixture.mjs";

let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };

const fx = loadFixture();
const GOLD = JSON.parse(fs.readFileSync(new URL("./fixtures/team_history_2026_wk10_golden.json", import.meta.url), "utf8"));
const NEW_FIELDS = ["teamHistoryState", "teamHistoryReason", "teamHistoryThrough", "teamHistory", "teamHistoryMissing", "teamHistoryConflict", "teamHistoryFirst"];
const idOf = (name) => { const p = fx.players.find((q) => q[1] === name); assert.ok(p, "fixture has " + name); return p[0]; };
const pos = Object.fromEntries(fx.players.map((p) => [p[0], p[2]]));
const FAM = { QB: "O", RB: "O", FB: "O", WR: "O", TE: "O", PK: "S", PN: "S", DT: "D", DE: "D", LB: "D", CB: "D", S: "D" };
const rng = (seed) => () => { seed |= 0; seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const base = await runHandler(LM, fx, {});
const B = base.json;

// ── 1. Nothing that existed before changes ──────────────────────────────────────────────────────────────────────
console.log("W1 replay: unchanged behavior");
await check("the route still answers 200 and the version moves to lmu4", () => { assert.strictEqual(base.status, 200); assert.strictEqual(B.version, "lmu4-2026-11-22"); assert.strictEqual(LM.LINEUP_MU_VERSION, B.version); });
await check("every pre-existing field is byte-for-byte what the pre-change route returned for the same data", () => {
  const rest = { ...B }; for (const k of NEW_FIELDS) delete rest[k]; delete rest.version;
  const g = { ...GOLD.payload }; delete g.version;
  assert.strictEqual(JSON.stringify(rest), JSON.stringify(g));
  assert.strictEqual(Object.keys(B.playerWindow).length, 1635); assert.strictEqual(Object.keys(g.playerWindow).length, 1635);
});
await check("the only new top-level keys are the six teamHistory* fields", () => {
  const added = Object.keys(B).filter((k) => !(k in GOLD.payload)).sort();
  assert.deepStrictEqual(added, NEW_FIELDS.slice().sort());
});
await check("no new database statement and no new network call: same 3 SELECTs and the same GETs as before", () => {
  assert.strictEqual(base.env.queries.length, GOLD.queries); assert.strictEqual(GOLD.queries, 3);
  assert.strictEqual(base.calls.length, GOLD.calls);
  assert.ok(base.calls.every((c) => c.method === "GET")); assert.ok(base.env.queries.every((q) => /^\s*(WITH|SELECT)\b/i.test(q)));
});
await check("the payload grows by under 9 KB (46 changed players, 503 first-record weeks, the two lists)", () => { const d = JSON.stringify(B).length - JSON.stringify(GOLD.payload).length; assert.ok(d > 0 && d < 9000, "grew by " + d); });

// ── 2. The replay oracle: real counts and named players ─────────────────────────────────────────────────────────
console.log("W1 replay: real 2026 data through Week 10");
await check("state ok, history through Week 10", () => { assert.strictEqual(B.teamHistoryState, "ok"); assert.strictEqual(B.teamHistoryReason, null); assert.strictEqual(B.teamHistoryThrough, 10); });
await check("46 players with a club change, 70 with no history, 3 conflicts (the counts the Python reference produces)", () => {
  assert.strictEqual(Object.keys(B.teamHistory).length, 46); assert.strictEqual(B.teamHistoryMissing.length, 70); assert.strictEqual(B.teamHistoryConflict.length, 3);
});
await check("a player is in at most one of changed / missing / conflict", () => {
  const seen = new Set();
  for (const id of [...Object.keys(B.teamHistory), ...B.teamHistoryMissing, ...B.teamHistoryConflict]) { assert.ok(!seen.has(id), "duplicate " + id); seen.add(id); }
});
await check("changed players: Simmons traded TEN to CHI, Hooker leaves and returns (gap kept), Allen has a gap, Buckner moves", () => {
  assert.deepStrictEqual(B.teamHistory[idOf("Simmons, Jeffery")], { seg: [["TEN", 1, 7], ["CHI", 8, 9]] });
  assert.deepStrictEqual(B.teamHistory[idOf("Hooker, Amani")], { seg: [["TEN", 1, 4], ["TEN", 6, 8], ["BUF", 10, 10]] });
  assert.deepStrictEqual(B.teamHistory[idOf("Allen, Kaytron")], { seg: [["WAS", 1, 2], ["WAS", 4, 4], ["MIA", 8, 10]] });
  assert.deepStrictEqual(B.teamHistory[idOf("Buckner, DeForest")], { seg: [["IND", 1, 7], ["SFO", 9, 10]] });
});
await check("a one-club player whose MFL club now differs carries cur, and his segment is NOT extended to it (Bates)", () => {
  assert.deepStrictEqual(B.teamHistory[idOf("Bates, Jessie")], { seg: [["ATL", 1, 9]], cur: "JAC" });
});
await check("unchanged players are not listed, and every listed segment lies inside the coverage window", () => {
  for (const id of Object.keys(B.teamHistory)) for (const [, lo, hi] of B.teamHistory[id].seg) assert.ok(lo >= 1 && hi >= lo && hi <= B.teamHistoryThrough);
  const entry = B.teamHistory[idOf("Simmons, Jeffery")]; assert.ok(!("cur" in entry), "no cur when MFL's club equals the last record");
});
await check("first-record weeks: every no-change player whose first weekly row is after Week 1 (503; 69 on UPS rosters, as the reference finds); the three named count-only players start in Week 8", () => {
  const f = B.teamHistoryFirst;
  assert.strictEqual(Object.keys(f).length, 503); assert.strictEqual(Object.keys(f).filter((i) => fx.rostered[i]).length, 69);
  for (const n of ["Giddens, DJ", "Richardson, Anthony", "Charbonnet, Zach"]) assert.strictEqual(f[idOf(n)], 8, n);
  for (const [id, w] of Object.entries(f)) { assert.ok(Number.isInteger(w) && w >= 2 && w <= B.teamHistoryThrough, id + " first week " + w); assert.ok(!(id in B.teamHistory) && !B.teamHistoryMissing.includes(id) && !B.teamHistoryConflict.includes(id), id + " is in exactly one list"); }
});
await check("the 10 rostered changed players and 8 rostered missing players are the ones the client must treat conservatively", () => {
  const r = (ids) => ids.filter((i) => fx.rostered[i]).length;
  assert.strictEqual(r(Object.keys(B.teamHistory)), 10); assert.strictEqual(r(B.teamHistoryMissing), 8); assert.strictEqual(r(B.teamHistoryConflict), 0);
});
await check("known mapping conflicts stay unavailable: the three conflicted ids carry no segments", () => {
  const names = B.teamHistoryConflict.map((i) => fx.players.find((p) => p[0] === i)[1]).sort();
  assert.deepStrictEqual(names, ["McClain, Malik", "Waxter, Isas", "Williams, Wydett"]);
  for (const i of B.teamHistoryConflict) assert.ok(!(i in B.teamHistory) && !B.teamHistoryMissing.includes(i));
});
await check("history is weeks of evidence only: no opponent, no BYE and no game-opportunity field anywhere in the new payload", () => {
  const s = JSON.stringify(NEW_FIELDS.map((k) => B[k]));
  assert.ok(!/opp|bye|opportunity|played/i.test(s));
});

// ── 3. The rules, one at a time (pure function) ─────────────────────────────────────────────────────────────────
console.log("W1 rules (lmuTeamHistory)");
const H = (o) => LM.lmuTeamHistory({ ctxState: "ok", priorSeason: false, scoredIds: Object.keys(o.scored), scoredWeeks: new Map(Object.entries(o.scored).map(([k, v]) => [k, new Set(v)])),
  clubOf: (id) => (o.cur || {})[id] || "", ctx: o.ctx });
const wks = (a, b) => { const r = []; for (let i = a; i <= b; i++) r.push(i); return r; };
await check("one club all season and MFL agrees: not listed, not missing", () => {
  const r = H({ ctx: { through: 9, one: { a: ["TEN", 1, 9] }, multi: {} }, scored: { a: wks(1, 9) }, cur: { a: "TEN" } });
  assert.strictEqual(r.teamHistoryState, "ok"); assert.deepStrictEqual(r.teamHistory, {}); assert.deepStrictEqual(r.teamHistoryMissing, []);
});
await check("two clubs: segments in week order, adjacent weeks of one club merge, a gap splits", () => {
  const r = H({ ctx: { through: 9, one: {}, multi: { a: { 1: "TEN", 2: "TEN", 3: "TEN", 5: "TEN", 6: "CHI", 7: "CHI" } } }, scored: { a: [1, 2, 3, 5, 6, 7] }, cur: { a: "CHI" } });
  assert.deepStrictEqual(r.teamHistory.a, { seg: [["TEN", 1, 3], ["TEN", 5, 5], ["CHI", 6, 7]] });
});
await check("weeks before the first record are NOT given the first club: the first segment starts at its first real week", () => {
  const r = H({ ctx: { through: 9, one: {}, multi: { a: { 4: "TEN", 5: "CHI" } } }, scored: { a: [4, 5] }, cur: { a: "CHI" } });
  assert.strictEqual(r.teamHistory.a.seg[0][1], 4);
});
await check("a one-club player whose first weekly row is after Week 1 is listed in teamHistoryFirst; Week 1 starters and changed players are not", () => {
  const r = H({ ctx: { through: 9, one: { a: ["TEN", 4, 9], b: ["TEN", 1, 9], c: ["TEN", 3, 9] }, multi: { d: { 2: "TEN", 3: "CHI" } } }, scored: { a: wks(4, 9), b: wks(1, 9), c: wks(3, 9), d: [2, 3] }, cur: { a: "TEN", b: "TEN", c: "CHI", d: "CHI" } });
  assert.deepStrictEqual(r.teamHistoryFirst, { a: 4 }, "c moved (listed with segments) and d changed clubs: neither is here");
  assert.deepStrictEqual(Object.keys(r.teamHistory).sort(), ["c", "d"]);
  const u = LM.lmuTeamHistory({ ctx: null, ctxState: "failed", priorSeason: false, scoredIds: ["a"], scoredWeeks: new Map(), clubOf: () => "" });
  assert.ok(!("teamHistoryFirst" in u), "an unavailable answer carries no list");
});
await check("a player with MFL scores and no weekly row is MISSING, never assumed to be on his current club", () => {
  const r = H({ ctx: { through: 9, one: {}, multi: {} }, scored: { a: wks(1, 9) }, cur: { a: "TEN" } });
  assert.deepStrictEqual(r.teamHistoryMissing, ["a"]); assert.deepStrictEqual(r.teamHistory, {});
});
await check("a weekly row in a week MFL has no score for makes the id a CONFLICT (the crosswalk joined someone else's rows)", () => {
  const r = H({ ctx: { through: 9, one: { a: ["TEN", 1, 9] }, multi: {} }, scored: { a: wks(1, 8) }, cur: { a: "TEN" } });
  assert.deepStrictEqual(r.teamHistoryConflict, ["a"]); assert.deepStrictEqual(r.teamHistory, {});
  const m = H({ ctx: { through: 9, one: {}, multi: { a: { 1: "TEN", 2: "CHI" } } }, scored: { a: [1] }, cur: { a: "CHI" } });
  assert.deepStrictEqual(m.teamHistoryConflict, ["a"]);
});
await check("a free agent (MFL club FA or blank) is not flagged as moved, and his last real club is kept", () => {
  for (const cur of ["FA", ""]) { const r = H({ ctx: { through: 9, one: { a: ["TEN", 1, 6] }, multi: {} }, scored: { a: wks(1, 6) }, cur: { a: cur } }); assert.deepStrictEqual(r.teamHistory, {}); }
});
await check("rows past the coverage week are ignored, not extended or counted", () => {
  const r = H({ ctx: { through: 5, one: {}, multi: { a: { 1: "TEN", 2: "TEN", 6: "CHI" } } }, scored: { a: [1, 2, 6] }, cur: { a: "CHI" } });
  assert.deepStrictEqual(r.teamHistory.a.seg, [["TEN", 1, 2]]); assert.strictEqual(r.teamHistory.a.cur, "CHI");
});
await check("nflverse club codes are translated to MFL's (LA -> LAR, JAX -> JAC)", () => {
  const r = H({ ctx: { through: 4, one: {}, multi: { a: { 1: "LA", 2: "JAX", 3: "JAX", 4: "JAX" } } }, scored: { a: [1, 2, 3, 4] }, cur: { a: "JAC" } });
  assert.deepStrictEqual(r.teamHistory.a.seg, [["LAR", 1, 1], ["JAC", 2, 4]]);
});
await check("malformed context data is unavailable, never a guess: bad ranges, missing maps, non-object context", () => {
  assert.deepStrictEqual(H({ ctx: { through: 9, one: { a: ["TEN", 0, 9] }, multi: {} }, scored: { a: wks(1, 9) } }).teamHistoryMissing, ["a"]);
  assert.deepStrictEqual(H({ ctx: { through: 9, one: { a: ["TEN", 5, 3] }, multi: {} }, scored: { a: wks(1, 9) } }).teamHistoryMissing, ["a"]);
  assert.deepStrictEqual(H({ ctx: { through: 9, one: {}, multi: { a: {} } }, scored: { a: wks(1, 9) } }).teamHistoryMissing, ["a"]);
  for (const ctx of [null, undefined, {}, { through: 9 }, { through: 9, one: null, multi: {} }, { through: 9, one: {}, multi: "x" }]) {
    const r = H({ ctx, scored: { a: [1] } }); assert.strictEqual(r.teamHistoryState, "unavailable"); assert.strictEqual(r.teamHistoryReason, "context_failed");
  }
});
await check("states: past season, failed context, no history yet", () => {
  const ok = { through: 9, one: {}, multi: {} }, sc = { scoredIds: ["a"], scoredWeeks: new Map([["a", new Set([1])]]), clubOf: () => "" };
  const one = (o) => LM.lmuTeamHistory({ ctx: ok, ctxState: "ok", priorSeason: false, ...sc, ...o });
  assert.strictEqual(one({ priorSeason: true }).teamHistoryReason, "past_season");
  assert.strictEqual(one({ ctxState: "failed" }).teamHistoryReason, "context_failed");
  assert.strictEqual(one({ ctx: { through: 0, one: {}, multi: {} } }).teamHistoryReason, "no_history");
  assert.strictEqual(one({ scoredIds: [] }).teamHistoryReason, "no_history");
  for (const r of [one({ priorSeason: true }), one({ ctxState: "failed" })]) { assert.strictEqual(r.teamHistoryState, "unavailable"); assert.ok(!("teamHistory" in r)); }
});
await check("exposed thresholds are the documented ones", () => {
  assert.strictEqual(LM.TEAM_HISTORY_COVERAGE_FLOOR, 0.90); assert.strictEqual(LM.TEAM_HISTORY_CHANGED_CEILING, 120); assert.strictEqual(LM.TEAM_HISTORY_MIN_SCORED, 200);
});

// ── 4. Aggregate gates (diagnostic only) ────────────────────────────────────────────────────────────────────────
console.log("W1 aggregate gates");
await check("losing 60% of the weekly rows (a broken crosswalk) makes the answer unavailable: crosswalk_failed", async () => {
  const R = rng(5); const ids = [...new Set(fx.teamRows.map((r) => r[0]))]; const drop = new Set(ids.filter(() => R() < 0.6));
  const j = (await runHandler(LM, fx, { teamRows: fx.teamRows.filter((r) => !drop.has(r[0])) })).json;
  assert.strictEqual(j.teamHistoryState, "unavailable"); assert.strictEqual(j.teamHistoryReason, "crosswalk_failed"); assert.ok(!("teamHistory" in j) && !("teamHistoryMissing" in j));
  assert.strictEqual(JSON.stringify({ ...j, ...Object.fromEntries(NEW_FIELDS.map((k) => [k, 0])), version: 0 }).length > 100000, true, "the rest of the payload is still served");
});
await check("losing 4% of the rows stays available (the floor is 90%); the lost players are listed as missing", async () => {
  const R = rng(9); const ids = [...new Set(fx.teamRows.map((r) => r[0]))]; const drop = new Set(ids.filter(() => R() < 0.04));
  const j = (await runHandler(LM, fx, { teamRows: fx.teamRows.filter((r) => !drop.has(r[0])) })).json;
  assert.strictEqual(j.teamHistoryState, "ok"); assert.ok(j.teamHistoryMissing.length > B.teamHistoryMissing.length);
});
await check("a 10% identity swap pushes the changed-club count over 120 and makes the answer unavailable: crosswalk_suspect", async () => {
  const j = (await runHandler(LM, fx, { teamRows: swapRows(0.10, 11).rows })).json;
  assert.strictEqual(j.teamHistoryState, "unavailable"); assert.strictEqual(j.teamHistoryReason, "crosswalk_suspect");
});

// ── 5. Targeted identity validation: seeded swaps ────────────────────────────────────────────────────────────────
// Swap the weekly rows of random same-family player pairs (what a wrong crosswalk does). The per-player check must flag them;
// the check cannot flag a swap between two players who were scored in the same weeks, so the undetected remainder is measured and printed.
function swapRows(pct, seed) {
  const R = rng(seed), rowIds = [...new Set(fx.teamRows.map((r) => r[0]))].filter((m) => FAM[pos[m]]), pool = rowIds.slice(), sample = [];
  const n = Math.floor(rowIds.length * pct / 2) * 2;
  while (sample.length < n) sample.push(pool.splice(Math.floor(R() * pool.length), 1)[0]);
  const fam = {}; for (const m of sample) (fam[FAM[pos[m]]] = fam[FAM[pos[m]]] || []).push(m);
  const swap = {};
  for (const f in fam) { const l = fam[f]; for (let i = 0; i + 1 < l.length; i += 2) { swap[l[i]] = l[i + 1]; swap[l[i + 1]] = l[i]; } }
  return { swap, rows: fx.teamRows.map((r) => (swap[r[0]] ? [swap[r[0]], ...r.slice(1)] : r)) };
}
console.log("W1 targeted identity validation (seeded swaps)");
const baseFlag = new Set(B.teamHistoryConflict);
const results = [];
for (const pct of [0.01, 0.03, 0.05]) {
  await check("swap " + (pct * 100) + "% of identities swapped: state stays ok and the per-player check flags at least 35% of them (the rest are measured below)", async () => {
    const { swap, rows } = swapRows(pct, 11);
    const j = (await runHandler(LM, fx, { teamRows: rows })).json;
    assert.strictEqual(j.teamHistoryState, "ok");
    const swapped = Object.keys(swap), flagged = swapped.filter((i) => j.teamHistoryConflict.includes(i) && !baseFlag.has(i));
    const unflagged = swapped.length - flagged.length;
    results.push({ pct, swapped: swapped.length, flagged: flagged.length, unflagged });
    assert.ok(flagged.length >= swapped.length * 0.35, "flagged " + flagged.length + " of " + swapped.length);
    for (const i of flagged) assert.ok(!(i in j.teamHistory), "a flagged id carries no segments");
  });
}
console.log("         measured: " + results.map((r) => r.pct * 100 + "% swap -> " + r.flagged + "/" + r.swapped + " flagged, " + r.unflagged + " not detectable by the per-player check").join(" | "));
await check("a duplicate id (two players' rows under one id) is a conflict for the id: the rows no longer match one player's scored weeks", () => {
  const r = H({ ctx: { through: 9, one: {}, multi: { a: { 1: "TEN", 2: "TEN", 3: "TEN", 5: "CHI" } } }, scored: { a: [1, 2, 3, 4] }, cur: { a: "CHI" } });
  assert.deepStrictEqual(r.teamHistoryConflict, ["a"]);
});

// ── 6. Failure of the context path ──────────────────────────────────────────────────────────────────────────────
console.log("W1 context failure");
await check("when the context cannot be loaded the route still answers and says unavailable: context_failed", async () => {
  const env = { UPS_MFL_DB: { prepare: () => ({ bind: () => ({ all: async () => { throw new Error("D1 down"); } }) }) } };
  const r = await runHandler(LM, fx, { env, q: "&nocache=1" });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.teamHistoryState, "unavailable");
  assert.ok(r.json.teamHistoryReason === "context_failed" || r.json.teamHistoryReason === "no_history");
  assert.ok(!("teamHistory" in r.json)); assert.ok(Object.keys(r.json.playerWindow).length > 1500, "the route still serves its scoring windows (its own fallback, unchanged by W1)");
});

console.log(fails ? "\n" + fails + " FAILED" : "\nall W1 team-history checks passed");
process.exit(fails ? 1 : 0);
