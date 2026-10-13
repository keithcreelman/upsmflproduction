// Stats → Pts Agst finished-season store (worker/src/fpa_engine.js "Finished-season
// store", worker/fpa_store/, pipelines/etl/scripts/build_fpa_season_store.mjs).
// A past season answers from its stored copy instead of ~36 MFL reads and the D1
// context scan. These checks run the REAL handler both ways on the same inputs:
//   1. stored = live, on a hand-made finished season with every awkward row the
//      encoder drops or keeps (every list window, every drill), and on each committed
//      season file (Full season list, every drill);
//   2. an in-progress season is never stored and never served from storage;
//   3. a missing, unreadable or invalid stored copy falls back to the live path
//      (and a failed MFL read there is still a 502);
//   4. a different engine version's copy is ignored.
//   node tests/fpa_season_store.test.mjs
import fs from "fs";
import assert from "assert";
import * as F from "../worker/src/fpa_engine.js";
import { runBoth, replayFetch, replayD1, storeBinding, jsonOut, normalize, sweepPaths } from "../pipelines/etl/scripts/fpa_store_harness.mjs";
import { encodeSeason, serialize, seasonComplete, STORE_ROOT } from "../pipelines/etl/scripts/build_fpa_season_store.mjs";

let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.stack || e).toString().split("\n").slice(0, 3).join("\n         ")); } };
const LID = "74598";
const NOW = Date.parse("2026-10-13T16:00:00Z");

// ── a small FINISHED season (2019 in a 2026 clock): 4 teams, 3 weeks, every game final ──
// W1 AAA@BBB, CCC@DDD · W2 AAA@CCC, BBB@DDD · W3 AAA@DDD (BBB and CCC on bye).
const ko = (d) => String(Math.floor(Date.parse(d) / 1000));
const g = (a, b, k) => ({ kickoff: ko(k), gameSecondsRemaining: "0", team: [{ id: a, isHome: "0", score: "17" }, { id: b, isHome: "1", score: "20" }] });
function miniRaw() {
  const players = [
    { id: "1", name: "Aqb, Al", position: "QB", team: "AAA", status: "R" }, { id: "2", name: "Bqb, Bo", position: "QB", team: "BBB" },
    { id: "3", name: "Cqb, Cy", position: "QB", team: "CCC" }, { id: "4", name: "Dqb, Di", position: "QB", team: "DDD" },
    { id: "5", name: "Rb, Rex", position: "RB", team: "AAA" }, { id: "6", name: "Dl, Dan", position: "DE", team: "BBB" },
    { id: "7", name: "Kick, Kay", position: "PK", team: "CCC" }, { id: "8", name: "Moved, Mo", position: "WR", team: "DDD" },   // played W1 for CCC
    { id: "9", name: "Team, Def", position: "Def", team: "DDD" },                                                              // no group: kept for "scored" only
    { id: "10", name: "Never, Scored", position: "WR", team: "AAA" },                                                          // no numeric score: dropped
    { id: "5", name: "Rb, Rex (dup)", position: "RB", team: "AAA" },                                                           // repeated id: last one wins
  ];
  const sc = (w, rows) => ({ playerScores: { week: String(w), playerScore: rows.map(([id, score]) => ({ id, score, isAvailable: "0" })) } });
  return {
    league: { league: { endWeek: "3", name: "mini", franchises: { count: "12" } } },
    players: { players: { player: players } },
    sched: {
      1: { nflSchedule: { week: "1", matchup: [g("AAA", "BBB", "2019-09-08T17:00:00Z"), g("CCC", "DDD", "2019-09-08T20:25:00Z")] } },
      2: { nflSchedule: { week: "2", matchup: [g("AAA", "CCC", "2019-09-15T17:00:00Z"), g("BBB", "DDD", "2019-09-16T00:20:00Z")] } },
      3: { nflSchedule: { week: "3", matchup: [g("AAA", "DDD", "2019-09-22T17:00:00Z")] } },
    },
    scores: {
      1: sc(1, [["1", "20.5"], ["2", "10"], ["3", "15.25"], ["4", "8"], ["5", "12"], ["6", "3.5"], ["7", "9"], ["8", "14"], ["9", "6"], ["10", ""], ["999", "50"]]),
      2: sc(2, [["1", "30"], ["2", "0"], ["3", "12"], ["4", "-1.5"], ["5", "7"], ["6", "1"], ["7", "4"], ["8", "11"], ["10", "abc"]]),
      3: sc(3, [["1", "18"], ["4", "22"], ["5", "15"], ["8", "3"], ["9", "2"]]),
    },
  };
}
function miniRec() {
  return {
    teamRows: [
      { m: "1", t: "AAA", lo: 1, hi: 3, wk: null }, { m: "2", t: "BBB", lo: 1, hi: 2, wk: null }, { m: "4", t: "DDD", lo: 1, hi: 3, wk: null },
      { m: "6", t: "BBB", lo: 1, hi: 2, wk: null }, { m: "8", t: "CCC", lo: null, hi: null, wk: 1 }, { m: "8", t: "DDD", lo: null, hi: null, wk: 2 }, { m: "8", t: "DDD", lo: null, hi: null, wk: 3 },
    ],
    playRows: [{ week: 1, team: "AAA", plays: 61 }, { week: 1, team: "BBB", plays: 58 }, { week: 2, team: "CCC", plays: 70 }, { week: 3, team: "DDD", plays: 64 }],
    paceRows: [{ team: "AAA", off_plays_pg: 62.5, def_plays_pg: 60.1 }, { team: "BBB", off_plays_pg: 58, def_plays_pg: null }, { team: "CCC", off_plays_pg: 66, def_plays_pg: 63 }, { team: "DDD", off_plays_pg: 64, def_plays_pg: 61.5 }],
    idRows: [{ mfl_id: "1", pfr_id: "AqbxAl00" }, { mfl_id: "5", pfr_id: "RbxxRe00" }, { mfl_id: "6", pfr_id: "DlxxDa00" }, { mfl_id: "8", pfr_id: "NA" }, { mfl_id: "3", pfr_id: "" }, { mfl_id: "77", pfr_id: "ZzzzZz00" }],
    snapRows: [
      { pfr_id: "AqbxAl00", week: 1, off_snaps: 64, def_snaps: 0 }, { pfr_id: "AqbxAl00", week: 2, off_snaps: 70, def_snaps: null }, { pfr_id: "AqbxAl00", week: 3, off_snaps: 58, def_snaps: 0 },
      { pfr_id: "RbxxRe00", week: 1, off_snaps: 30, def_snaps: 0 }, { pfr_id: "RbxxRe00", week: 3, off_snaps: 41, def_snaps: 0 },
      { pfr_id: "DlxxDa00", week: 1, off_snaps: 0, def_snaps: 44 }, { pfr_id: "DlxxDa00", week: 2, off_snaps: 0, def_snaps: 39 },
      { pfr_id: "ZzzzZz00", week: 1, off_snaps: 9, def_snaps: 9 },
    ],
  };
}
async function seasonFrom(raw, rec, yr) {
  const mfl = await F.fpaLoadMfl({ yr, wMin: 1, wMax: 99, lid: LID, fetchJson: async (u) => (await (await replayFetch(raw)(u)).json()), nowMs: NOW, currentSeason: false });
  const ctx = await F.fpaLoadSeasonContext(async (sql, ...b) => (await replayD1(rec).prepare(sql).bind(...b).all()).results, yr);
  return { raw, rec, mfl, ctx };
}
const filesFor = (yr, text) => ({ [F.fpaStorePath(yr)]: text });

console.log("1. stored = live");
const S = await seasonFrom(miniRaw(), miniRec(), "2019");
const store = encodeSeason("2019", S, { nowMs: NOW, builtAtMs: NOW });
const text = serialize(store);
await check("the hand-made 2019 is complete by the engine's rule, so it may be stored", () => {
  assert.strictEqual(seasonComplete(S.mfl, S.ctx, NOW).ok, true);
});
await check("the file keeps only what the engine reads (no unknown id, no non-numeric score, no player who never scored)", () => {
  assert.deepStrictEqual(store.scores[1].map((r) => r[0]), ["1", "2", "3", "4", "5", "6", "7", "8", "9"]);
  assert.deepStrictEqual(store.scores[2].map((r) => r[0]), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.ok(!store.players.some((p) => p[0] === "10") && store.players.filter((p) => p[0] === "5").length === 2);
  assert.strictEqual(store.engine, F.FPA_ENGINE_VERSION); assert.strictEqual(store.state, "complete");
  assert.deepStrictEqual(store.snaps.ids, { 1: "AqbxAl00", 2: "", 3: "", 4: "", 5: "RbxxRe00", 6: "DlxxDa00", 8: "" });
});
await check("every list window and every drill (4 teams × 9 positions × 3 windows): stored answer = live answer, and the stored path read no MFL and no D1", async () => {
  F.fpaStoreForget();
  const { list, drill } = sweepPaths("2019", 3, ["AAA", "BBB", "CCC", "DDD"], { allDrillWindows: true });
  let n = 0;
  for (const p of [...list, ...drill]) {
    const r = await runBoth(p, { raw: S.raw, rec: S.rec, files: filesFor("2019", text), nowMs: NOW, lid: LID });
    assert.ok(r.same, p + "\n live   " + r.live.slice(0, 300) + "\n stored " + r.stored.slice(0, 300));
    assert.strictEqual(r.liveSource, "live", p); assert.strictEqual(r.storedSource, "stored", p);
    assert.strictEqual(r.mflReads, 0, p); assert.strictEqual(r.d1Reads, 0, p);
    n++;
  }
  assert.strictEqual(n, list.length + drill.length); assert.ok(n > 100, n);
});
await check("the numbers are real ones: the traded WR's Wk 1 goes to DDD (faced on game day); snaps come back from the file", async () => {
  F.fpaStoreForget();
  const r = await runBoth("/api/fpa-detail?YEAR=2019&team=AAA&pos=QB&week_min=1", { raw: S.raw, rec: S.rec, files: filesFor("2019", text), nowMs: NOW, lid: LID });
  const j = JSON.parse(r.stored);
  assert.strictEqual(j.context.snaps, "ok"); assert.strictEqual(j.gamesPlayed, 3);
  assert.deepStrictEqual(j.weeks.map((w) => w.total), [10, 12, 22]);
  const wr = JSON.parse((await runBoth("/api/fantasy-points-against?YEAR=2019&week_min=1&week_max=1", { raw: S.raw, rec: S.rec, files: filesFor("2019", text), nowMs: NOW, lid: LID })).stored);
  assert.strictEqual(wr.teams.DDD.WR.raw.total, 14);
});
await check("the answer only differs in as_of and mfl_read_at (mfl_read_at = when the build read MFL)", async () => {
  F.fpaStoreForget();
  const r = await runBoth("/api/fantasy-points-against?YEAR=2019&week_min=1", { raw: S.raw, rec: S.rec, files: filesFor("2019", text), nowMs: NOW + 5000, lid: LID });
  const a = JSON.parse(r.live), b = JSON.parse(r.stored);
  assert.notStrictEqual(r.live, r.stored);
  assert.strictEqual(b.mfl_read_at, new Date(NOW).toISOString()); assert.strictEqual(a.mfl_read_at, new Date(NOW + 5000).toISOString());
  assert.strictEqual(normalize(r.live), normalize(r.stored));
});

// Each committed season file: it opens, and the stored path answers the Full season
// list and every drill exactly as the live path does on the file's own inputs.
const dir = STORE_ROOT + "/" + F.FPA_ENGINE_VERSION;
const committed = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^\d{4}\.json$/.test(f)).sort() : [];
await check("the committed store is this engine's (worker/fpa_store/" + F.FPA_ENGINE_VERSION + "/, no other version folders); rebuild it after an engine change", () => {
  assert.ok(committed.length >= 1, "no stored seasons for " + F.FPA_ENGINE_VERSION + " — run: node pipelines/etl/scripts/build_fpa_season_store.mjs");
  assert.deepStrictEqual(fs.readdirSync(STORE_ROOT).filter((d) => fs.statSync(STORE_ROOT + "/" + d).isDirectory()), [F.FPA_ENGINE_VERSION]);
});
// The live side of a committed file: its own stored replies and rows, replayed.
function inputsFromFile(s) {
  const raw = { league: { league: { endWeek: String(s.endWeek) } }, players: { players: { player: s.players.map((p) => ({ id: p[0], name: p[1], position: p[2], team: p[3] })) } }, sched: {}, scores: {} };
  for (let w = 1; w <= s.endWeek; w++) {
    raw.sched[w] = { nflSchedule: { week: String(w), matchup: s.sched[w].map((m) => ({ kickoff: m[0], gameSecondsRemaining: m[1], team: m[2].map((t) => ({ id: t[0], isHome: t[1] })) })) } };
    raw.scores[w] = { playerScores: { week: String(w), playerScore: s.scores[w].map((r) => ({ id: r[0], score: r[1] })) } };
  }
  const c = s.ctx, teamRows = [], playRows = [], paceRows = [];
  for (const m in c.one) teamRows.push({ m, t: c.one[m][0], lo: c.one[m][1], hi: c.one[m][2], wk: null });
  for (const m in c.multi) for (const wk in c.multi[m]) teamRows.push({ m, t: c.multi[m][wk], lo: null, hi: null, wk: Number(wk) });
  for (const w in c.plays) for (const t in c.plays[w]) playRows.push({ week: Number(w), team: t, plays: c.plays[w][t] });
  for (const t in c.pace) paceRows.push({ team: t, off_plays_pg: c.pace[t].off, def_plays_pg: c.pace[t].def });
  const idRows = Object.keys(s.snaps.ids).map((m) => ({ mfl_id: m, pfr_id: s.snaps.ids[m] }));
  const snapRows = [];
  for (const p in s.snaps.wk) for (const w in s.snaps.wk[p]) snapRows.push({ pfr_id: p, week: Number(w), off_snaps: s.snaps.wk[p][w][0], def_snaps: s.snaps.wk[p][w][1] });
  return { raw, rec: { teamRows, playRows, paceRows, idRows, snapRows } };
}
// (The build already proved every window and every drill of each season against the
// MFL and D1 reads themselves; here: the Full season list, a Custom window and one
// drill per position for each file, and every drill for the latest season.)
for (const f of committed) {
  const yr = f.slice(0, 4), t = fs.readFileSync(dir + "/" + f, "utf8"), s = JSON.parse(t);
  const latest = f === committed[committed.length - 1];
  await check(`${yr}: the committed file is valid and complete; stored = live for the Full season list, weeks 3–9 and ${latest ? "EVERY drill" : "one drill per position"}`, async () => {
    assert.strictEqual(F.fpaStoreProblem(s, yr, LID), null);
    assert.ok(F.fpaStoreOpen(s, yr, LID, NOW), "does not open as a complete season");
    assert.ok(Number(yr) < F.fpaCurrentSeason(NOW));
    F.fpaStoreForget();
    const { raw, rec } = inputsFromFile(s);
    const teams = Array.from(new Set(Object.values(s.sched).flat().flatMap((m) => m[2].map((x) => x[0])))).sort();
    assert.strictEqual(teams.length, 32);
    const drills = latest ? sweepPaths(yr, s.endWeek, teams).drill
      : F.FPA_GROUPS.map((g, i) => `/api/fpa-detail?YEAR=${yr}&team=${teams[(i * 7 + Number(yr)) % 32]}&pos=${g}&week_min=1`);
    const paths = [`/api/fantasy-points-against?YEAR=${yr}&week_min=1`, `/api/fantasy-points-against?YEAR=${yr}&week_min=3&week_max=9`, ...drills];
    for (const p of paths) {
      const r = await runBoth(p, { raw, rec, files: filesFor(yr, t), nowMs: NOW, lid: LID });
      assert.ok(r.same && r.storedSource === "stored" && !r.mflReads && !r.d1Reads, p);
    }
  });
}

console.log("\n2. an in-progress season is never stored or served from storage");
const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/fpa_qb_2026_wk5_2026_10_12.json", import.meta.url), "utf8"));
function fixRaw() {
  const raw = { league: { league: { endWeek: String(FIX.endWeek) } }, players: { players: { player: FIX.players } }, sched: {}, scores: {} };
  for (let w = 1; w <= FIX.endWeek; w++) {
    raw.sched[w] = { nflSchedule: { week: String(w), matchup: FIX.sched[w] || [] } };
    raw.scores[w] = { playerScores: { week: String(w), playerScore: FIX.scores[w] || { id: "", score: "", week: String(w) } } };
  }
  return raw;
}
await check("the build refuses 2026 Wk 5 (BUF @ LAR not played): not complete", async () => {
  const mfl = await F.fpaLoadMfl({ yr: "2026", wMin: 1, wMax: 99, lid: LID, fetchJson: async (u) => (await (await replayFetch(fixRaw())(u)).json()), nowMs: FIX.nowMs, currentSeason: true });
  const d = seasonComplete(mfl, null, FIX.nowMs);
  assert.strictEqual(d.ok, false); assert.ok(/in_season/.test(d.why), d.why);
});
await check("a stored file for the CURRENT season is never read: the answer is live and the store is not even opened", async () => {
  F.fpaStoreForget();
  const fake = serialize({ ...store, season: "2026" });
  const log = [];
  const r = await F.handleFpaRequest(new Request("https://w.test/api/fantasy-points-against?YEAR=2026&week_min=1&week_max=5"), { FPA_STORE: storeBinding(filesFor("2026", fake), log) }, null,
    { jsonOut, nowMs: FIX.nowMs, lid: LID, fetchImpl: replayFetch(fixRaw()) });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get("X-UPS-FPA-Source"), "live"); assert.strictEqual(log.length, 0);
});
await check("a past season whose file claims 'complete' but has a game with no posted score is refused at open → live", async () => {
  F.fpaStoreForget();
  const bad = JSON.parse(text);
  bad.scores[3] = bad.scores[3].filter((r) => !["1", "4", "5", "8", "9"].includes(r[0]));   // W3 AAA@DDD: nobody scored
  bad.scores[3].push(["2", "1"]);                                                          // (keep the week non-empty: a BBB player)
  assert.strictEqual(F.fpaStoreProblem(bad, "2019", LID), null);
  assert.strictEqual(F.fpaStoreOpen(bad, "2019", LID, NOW), null);
  const r = await runBoth("/api/fantasy-points-against?YEAR=2019&week_min=1", { raw: S.raw, rec: S.rec, files: filesFor("2019", JSON.stringify(bad)), nowMs: NOW, lid: LID });
  assert.strictEqual(r.storedSource, "live"); assert.ok(r.same); assert.ok(r.mflReads > 0);
});

console.log("\n3. a missing or invalid stored copy falls back to the live path");
const cases = {
  "no FPA_STORE binding": null,
  "no file for the season (404)": {},
  "cut short (not JSON)": filesFor("2019", text.slice(0, Math.floor(text.length / 2))),
  "file for another season": filesFor("2019", serialize({ ...store, season: "2018" })),
  "file for another league": filesFor("2019", serialize({ ...store, lid: "25625" })),
  "state not complete": filesFor("2019", serialize({ ...store, state: "in_season" })),
  "a week's scores missing": filesFor("2019", JSON.stringify({ ...store, scores: { 1: store.scores[1], 2: store.scores[2] } })),
  "unknown file format": filesFor("2019", serialize({ ...store, format: 99 })),
  "a game's teams not a list (passes the shape check, fails to decode)": filesFor("2019", JSON.stringify({ ...store, sched: { ...store.sched, 2: [[store.sched[2][0][0], "0", 7]] } })),
};
for (const [name, files] of Object.entries(cases)) {
  await check(name + " → live, same answer", async () => {
    F.fpaStoreForget();
    const env = { UPS_MFL_DB: replayD1(S.rec) };
    if (files) env.FPA_STORE = storeBinding(files);
    const r = await F.handleFpaRequest(new Request("https://w.test/api/fpa-detail?YEAR=2019&team=DDD&pos=WR&week_min=1"), env, null, { jsonOut, nowMs: NOW, lid: LID, fetchImpl: replayFetch(S.raw) });
    const ref = await runBoth("/api/fpa-detail?YEAR=2019&team=DDD&pos=WR&week_min=1", { raw: S.raw, rec: S.rec, files: filesFor("2019", text), nowMs: NOW, lid: LID });
    assert.strictEqual(r.headers.get("X-UPS-FPA-Source"), "live");
    assert.strictEqual(normalize(await r.text()), normalize(ref.live));
  });
}
await check("the FPA_STORE binding throwing → live", async () => {
  F.fpaStoreForget();
  const r = await F.handleFpaRequest(new Request("https://w.test/api/fantasy-points-against?YEAR=2019&week_min=1"), { FPA_STORE: { fetch: async () => { throw new Error("assets down"); } }, UPS_MFL_DB: replayD1(S.rec) }, null,
    { jsonOut, nowMs: NOW, lid: LID, fetchImpl: replayFetch(S.raw) });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get("X-UPS-FPA-Source"), "live");
});
await check("no usable stored copy AND an MFL read fails → still 502 ok:false (fail closed, never made-up numbers)", async () => {
  F.fpaStoreForget();
  const raw = miniRaw(); raw.scores[2] = null;
  const r = await F.handleFpaRequest(new Request("https://w.test/api/fantasy-points-against?YEAR=2019&week_min=1"), { FPA_STORE: storeBinding({}), UPS_MFL_DB: replayD1(S.rec) }, null,
    { jsonOut, nowMs: NOW, lid: LID, fetchImpl: replayFetch(raw) });
  const j = await r.json();
  assert.strictEqual(r.status, 502); assert.strictEqual(j.ok, false); assert.deepStrictEqual(j.failedWeeks, [2]);
});
await check("a valid stored copy needs no MFL: the same failing MFL does not matter for a stored season", async () => {
  F.fpaStoreForget();
  const raw = miniRaw(); raw.scores[2] = null;
  const r = await F.handleFpaRequest(new Request("https://w.test/api/fantasy-points-against?YEAR=2019&week_min=1"), { FPA_STORE: storeBinding(filesFor("2019", text)) }, null,
    { jsonOut, nowMs: NOW, lid: LID, fetchImpl: replayFetch(raw) });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.headers.get("X-UPS-FPA-Source"), "stored");
});
await check("a drill player the build did not consider → that drill reads snaps from D1 as before", async () => {
  F.fpaStoreForget();
  const s2 = JSON.parse(text); delete s2.snaps.ids["5"];
  const d1 = [];
  const r = await F.handleFpaRequest(new Request("https://w.test/api/fpa-detail?YEAR=2019&team=BBB&pos=RB&week_min=1"), { FPA_STORE: storeBinding(filesFor("2019", JSON.stringify(s2))), UPS_MFL_DB: replayD1(S.rec, d1) }, null,
    { jsonOut, nowMs: NOW, lid: LID, fetchImpl: replayFetch(S.raw) });
  const ref = await runBoth("/api/fpa-detail?YEAR=2019&team=BBB&pos=RB&week_min=1", { raw: S.raw, rec: S.rec, files: filesFor("2019", text), nowMs: NOW, lid: LID });
  assert.strictEqual(r.headers.get("X-UPS-FPA-Source"), "stored"); assert.ok(d1.length > 0);
  assert.strictEqual(normalize(await r.text()), normalize(ref.live));
});

console.log("\n4. an engine-version change ignores old data");
await check("the file is looked up under the engine version (" + F.fpaStorePath("2019") + ")", () => {
  assert.strictEqual(F.fpaStorePath("2019"), "/" + F.FPA_ENGINE_VERSION + "/2019.json");
});
await check("a copy written by another engine version, even at this version's path, is ignored → live", async () => {
  F.fpaStoreForget();
  const old = serialize({ ...store, engine: "fpa1-2026-10-01" });
  assert.ok(/engine/.test(F.fpaStoreProblem(JSON.parse(old), "2019", LID)));
  const r = await runBoth("/api/fantasy-points-against?YEAR=2019&week_min=1", { raw: S.raw, rec: S.rec, files: { ...filesFor("2019", old), "/fpa1-2026-10-01/2019.json": old }, nowMs: NOW, lid: LID });
  assert.strictEqual(r.storedSource, "live"); assert.ok(r.same);
});
await check("the response cache key carries the engine version too (no cached answer crosses versions)", () => {
  const src = fs.readFileSync(new URL("../worker/src/fpa_engine.js", import.meta.url), "utf8");
  assert.ok(/cacheKey = FPA_CACHE_HOST \+ path \+ "\?" \+ sorted\.toString\(\) \+ "&v=" \+ FPA_ENGINE_VERSION/.test(src));
});

console.log("\n5. the deploy ships the store worker-only");
await check("wrangler.toml binds worker/fpa_store as FPA_STORE with run_worker_first (no public path, no route change)", () => {
  const t = fs.readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8");
  const m = /\n\[assets\]\n([\s\S]*?)\n\n/.exec(t);
  assert.ok(m, "no [assets] block");
  assert.ok(/directory = "\.\/fpa_store"/.test(m[1]) && /binding = "FPA_STORE"/.test(m[1]) && /run_worker_first = true/.test(m[1]), m[1]);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
