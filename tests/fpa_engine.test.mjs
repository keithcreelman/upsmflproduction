// Stats → Pts Agst engine (worker/src/fpa_engine.js): the arithmetic the list and its
// drill share, run for real on (a) every 2026 QB, Wks 1–5, read 2026-10-12 23:12 UTC
// with Monday night BUF @ LAR not yet played, and (b) a tiny hand-made league for the
// cases real data can't pin down (a traded player, MFL's repeated last week, a failed read).
//   node tests/fpa_engine.test.mjs
// Replaces fpa_games_played_denominator.test.mjs, which regex-matched the old route.
import fs from "fs";
import assert from "assert";
import * as F from "../worker/src/fpa_engine.js";

const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/fpa_qb_2026_wk5_2026_10_12.json", import.meta.url), "utf8"));
let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };

// MFL as the fixture saw it. Weeks past 5 answer with MFL's real placeholder; week 18
// answers as week 17 (what MFL does past the league's last week).
function mflFrom(fx, over) {
  over = over || {};
  const calls = [];
  const fetchJson = async (u) => {
    calls.push(u);
    const x = new URL(u), T = x.searchParams.get("TYPE"), W = Number(x.searchParams.get("W"));
    if (over[T + W] !== undefined) return over[T + W];
    if (T === "league") return { league: { endWeek: String(fx.endWeek) } };
    if (T === "players") return { players: { player: fx.players } };
    if (T === "nflSchedule") return { nflSchedule: { week: String(W), matchup: fx.sched[W] || [] } };
    if (T === "playerScores") {
      if (W > fx.endWeek) return { playerScores: { week: String(fx.endWeek), playerScore: [] } };
      return { playerScores: { week: String(W), playerScore: fx.scores[W] || { id: "", score: "", week: String(W) } } };
    }
    throw new Error("unexpected " + u);
  };
  return { fetchJson, calls };
}
function ctxFrom(fx) {
  // The shape fpaLoadSeasonContext builds from D1 (one team all season, or per week).
  const per = {};
  for (const r of fx.weekly) for (const m of Object.keys(fx.ffIds)) if (fx.ffIds[m] === r.gsis_id) (per[m] = per[m] || {})[r.week] = r.team;
  const one = {}, multi = {};
  for (const m in per) {
    const teams = new Set(Object.values(per[m])), wks = Object.keys(per[m]).map(Number);
    if (teams.size === 1) one[m] = [[...teams][0], Math.min(...wks), Math.max(...wks)]; else multi[m] = per[m];
  }
  return { season: "2026", one, multi, plays: {}, pace: {}, through: 5 };
}
const load = async (fx, wMax, over) => {
  const { fetchJson, calls } = mflFrom(fx, over);
  const mfl = await F.fpaLoadMfl({ yr: "2026", wMin: 1, wMax, lid: "74598", fetchJson, nowMs: fx.nowMs, currentSeason: true });
  return { mfl, calls };
};

console.log("1. games are counted per TEAM, from final games only (real 2026 QBs, Wks 1–5)");
const { mfl, calls } = await load(FIX, 5);
const ctx = ctxFrom(FIX);
const E5 = F.fpaCompute(mfl, ctx, { wMin: 1, wMax: 5, nowMs: FIX.nowMs, baseline: F.FPA_BASELINE });
const A5 = F.fpaAggregate(E5, ["QB"]);
await check("BUF has played 4 games (Monday night at LAR not yet played) → 111.7 / 4 = 27.9 per game", () => {
  assert.deepStrictEqual(A5.BUF.QB.raw, { total: 111.7, perGame: 27.9, oppNorm: 21.7, games: 4 });
});
await check("BUF's rank and ratio are unchanged by the fix (both sides shared the wrong denominator)", () => {
  assert.deepStrictEqual(A5.BUF.QB.adj, { rank: 6, of: 32, ratio: 1.29 });
});
await check("LAR is 4 games too; KCC and CAR (bye) are 4; a team that played Sunday is 5", () => {
  assert.strictEqual(E5.games.LAR, 4); assert.strictEqual(E5.games.KCC, 4); assert.strictEqual(E5.games.CAR, 4); assert.strictEqual(E5.games.ATL, 5);
});
await check("Allowed ÷ Usual is exactly the ratio the list ranks by", () => {
  for (const t in A5) { const c = A5[t].QB; if (!c || !c.adj) continue; assert.ok(Math.abs(c.raw.perGame / c.raw.oppNorm - c.adj.ratio) < 0.02, t); }
});
await check("season facts: Wks 1–4 final, Wk 5 in progress with BUF @ LAR left; BUF's next game is that one", () => {
  const f = F.fpaSeasonFacts(E5);
  assert.deepStrictEqual(f.weeksFinal, [1, 2, 3, 4]); assert.deepStrictEqual(f.weeksPartial, [5]);
  assert.deepStrictEqual(f.pending.map((g) => g.away + "@" + g.home), ["BUF@LAR"]);
  assert.strictEqual(f.teamGames.BUF.next.opp, "LAR"); assert.deepStrictEqual(f.teamGames.KCC.bye, [5]);
});
await check("week states from the schedule: last complete week = 4", () => {
  const ws = F.fpaWeekStates(mfl, FIX.nowMs);
  assert.strictEqual(ws.lastComplete, 4); assert.strictEqual(ws.weekState[5], "partial"); assert.strictEqual(ws.weekState[6], "scheduled");
});
await check("only weeks that have kicked off are read (1 league + 1 players + 17 schedules + 5 score weeks)", () => {
  assert.strictEqual(calls.length, 24, calls.length);
});

console.log("\n2. the drill is the same computation as the list");
const D = F.fpaDetail(E5, ctx, A5, "BUF", "QB", null);
await check("BUF QB drill: 4 games, 111.7 total, 27.9 per game, same usual and rank as the list row", () => {
  assert.strictEqual(D.gamesPlayed, 4); assert.strictEqual(D.total, 111.7); assert.strictEqual(D.perGame, 27.9);
  assert.strictEqual(D.usualPerGame, A5.BUF.QB.raw.oppNorm); assert.strictEqual(D.rank, 6);
});
await check("every week in range is a row: 1–4 final, 5 not played yet (vs LAR, Monday)", () => {
  assert.deepStrictEqual(D.schedule.map((s) => s.wk + ":" + s.state), ["1:final", "2:final", "3:final", "4:final", "5:scheduled"]);
  assert.strictEqual(D.schedule[4].opp, "LAR");
});
await check("week usual totals add up to the list's Usual × games", () => {
  const sumU = D.weeks.reduce((a, w) => a + w.usualTotal, 0);
  assert.ok(Math.abs(sumU / D.gamesPlayed - A5.BUF.QB.raw.oppNorm) < 0.06, sumU / D.gamesPlayed);
});
await check("Goff, Wk 2: 38.8; usual = his average over Wks 1–5 (this game included); avgVsOthers (desktop) leaves it out", () => {
  const g = D.weeks[1].players[0];
  assert.strictEqual(g.name, "Goff, Jared"); assert.strictEqual(g.pts, 38.8);
  assert.strictEqual(g.avgVsOthers, 27.4); assert.strictEqual(g.otherGames, 4);
  assert.ok(g.usual > g.avgVsOthers && Math.abs(g.diff - (g.pts - g.usual)) < 0.06);
});
await check("K and P get no snaps line; QB gets offensive snaps; DL gets DEFENSIVE snaps", () => {
  const snaps = { byPfr: { p1: { 1: { off: 0, def: 41 }, 2: { off: 0, def: 30 } } }, pfrByMfl: {}, state: "ok" };
  const fake = { ...E5, pg: [{ pid: "x", wk: 1, pts: 3, def: "BUF", own: "MIA", grp: "DL" }], gamesOf: () => [{ pid: "x", wk: 1, pts: 3, def: "BUF" }, { pid: "x", wk: 2, pts: 1, def: "NEP" }], usualFor: () => ({ avg: 2, n: 2 }) };
  snaps.pfrByMfl.x = "p1";
  const d = F.fpaDetail(fake, null, {}, "BUF", "DL", snaps);
  const p = d.weeks[0].players[0];
  assert.strictEqual(p.snapKind, "def"); assert.strictEqual(p.snaps, 41); assert.strictEqual(p.snapNorm, 30);
  assert.strictEqual(F.fpaDetail(fake, null, {}, "BUF", "PK", snaps).context.snaps, "not_applicable");
});

console.log("\n3. a tiny league for the cases real data can't pin");
// Teams AAA–DDD. Wk 1: AAA–BBB, CCC–DDD (final). Wk 2: AAA–CCC (final), BBB–DDD (not played).
const NOW = Date.parse("2026-10-12T23:00:00Z"), past = String(Math.floor(NOW / 1000) - 86400 * 3), soon = String(Math.floor(NOW / 1000) + 3600);
const game = (a, b, ko, secs) => ({ kickoff: ko, gameSecondsRemaining: secs, team: [{ id: a, isHome: "0" }, { id: b, isHome: "1" }] });
const MINI = {
  nowMs: NOW, endWeek: 2,
  players: [{ id: "1", name: "A, Qb", position: "QB", team: "AAA" }, { id: "2", name: "B, Qb", position: "QB", team: "BBB" },
    { id: "3", name: "C, Qb", position: "QB", team: "CCC" }, { id: "9", name: "Moved, Guy", position: "QB", team: "DDD" }],
  sched: { 1: [game("AAA", "BBB", past, "0"), game("CCC", "DDD", past, "0")], 2: [game("AAA", "CCC", past, "0"), game("BBB", "DDD", soon, "3600")] },
  // "9" played Wk 1 FOR CCC (vs DDD), then was traded to DDD. "3" played Wk 2 for CCC.
  scores: { 1: [{ id: "1", score: "20" }, { id: "2", score: "10" }, { id: "9", score: "15" }], 2: [{ id: "1", score: "30" }, { id: "3", score: "12" }] },
};
const miniCtx = { one: {}, multi: { 9: { 1: "CCC" } }, plays: {}, pace: {}, through: 1 };
const mini = await (async () => { const { fetchJson } = mflFrom(MINI); return F.fpaLoadMfl({ yr: "2026", wMin: 1, wMax: 2, lid: "74598", fetchJson, nowMs: NOW, currentSeason: true }); })();
await check("a traded player's points go to the team he FACED on game day (DDD), not his new team's opponent", () => {
  const E = F.fpaCompute(mini, miniCtx, { wMin: 1, wMax: 2, nowMs: NOW, baseline: F.FPA_BASELINE });
  const A = F.fpaAggregate(E, ["QB"]);
  assert.strictEqual(A.DDD.QB.raw.total, 15); assert.strictEqual(E.attribution.gameDay, 1);
  // Without the game-day team he'd be credited to his NEW team's Wk 1 opponent (CCC) — the old bug.
  const Eold = F.fpaCompute(mini, null, { wMin: 1, wMax: 2, nowMs: NOW, baseline: F.FPA_BASELINE });
  assert.strictEqual(F.fpaAggregate(Eold, ["QB"]).CCC.QB.raw.total, 15 + 30);
});
await check("a game not played yet counts for nothing: BBB and DDD have 1 game each", () => {
  const E = F.fpaCompute(mini, miniCtx, { wMin: 1, wMax: 2, nowMs: NOW, baseline: F.FPA_BASELINE });
  assert.strictEqual(E.games.BBB, 1); assert.strictEqual(E.games.DDD, 1); assert.strictEqual(E.games.AAA, 2);
});
await check("include-self usual: AAA allowed 10 (B) + 12 (C) = 22 over 2 games; usual = 10 + 12 → ratio 1.00", () => {
  const E = F.fpaCompute(mini, miniCtx, { wMin: 1, wMax: 2, nowMs: NOW, baseline: "include_self" });
  const c = F.fpaAggregate(E, ["QB"]).AAA.QB;
  assert.deepStrictEqual([c.raw.total, c.raw.games, c.raw.perGame, c.adj.ratio], [22, 2, 11, 1]);
});
await check("MFL answering Wk 2 with Wk 1's scores is refused, not counted twice", async () => {
  const { fetchJson } = mflFrom(MINI, { playerScores2: { playerScores: { week: "1", playerScore: MINI.scores[1] } } });
  await assert.rejects(F.fpaLoadMfl({ yr: "2026", wMin: 1, wMax: 2, lid: "74598", fetchJson, nowMs: NOW, currentSeason: true }),
    (e) => e instanceof F.FpaUpstreamError && e.weeks.join() === "2");
});
await check("a failed MFL read fails the whole answer (no quietly smaller board)", async () => {
  const { fetchJson } = mflFrom(MINI, { playerScores1: null });
  await assert.rejects(F.fpaLoadMfl({ yr: "2026", wMin: 1, wMax: 2, lid: "74598", fetchJson, nowMs: NOW, currentSeason: true }),
    (e) => e instanceof F.FpaUpstreamError && /player scores/.test(e.message));
});
await check("weeks past the league's last week (2017–2020: 16; 2021+: 17) are never read", async () => {
  const { fetchJson, calls: c2 } = mflFrom({ ...MINI, endWeek: 2 });
  await F.fpaLoadMfl({ yr: "2026", wMin: 1, wMax: 18, lid: "74598", fetchJson, nowMs: NOW, currentSeason: true });
  assert.ok(!c2.some((u) => /W=(3|1[0-8])\b/.test(u)), c2.join("\n"));
});

await check("over on the schedule but no score posted yet → 'awaiting', not counted (MFL posts scores on its own timetable)", () => {
  const sched = { 1: MINI.sched[1], 2: [game("AAA", "CCC", past, "0"), game("BBB", "DDD", past, "0")] };   // BBB–DDD 'final' on the schedule…
  const m = { ...mini, schedByWeek: sched, __scored: undefined, pInfo: undefined };                     // …but week 2 has no BBB/DDD score
  const E = F.fpaCompute(m, miniCtx, { wMin: 1, wMax: 2, nowMs: NOW, baseline: F.FPA_BASELINE });
  assert.strictEqual(E.gameOf.BBB[2].status, "awaiting"); assert.strictEqual(E.games.BBB, 1); assert.strictEqual(E.weekState[2], "partial");
});
await check("the schedule clock lagging (still 60:00 five hours after kickoff) with scores posted → final", () => {
  const old = String(Math.floor(NOW / 1000) - 6 * 3600);
  const st = F.fpaGameStatus(game("AAA", "BBB", old, "3600"), NOW, new Set(["AAA"]));
  assert.strictEqual(st, "final");
  assert.strictEqual(F.fpaGameStatus(game("AAA", "BBB", String(Math.floor(NOW / 1000) - 1800), "3600"), NOW, new Set(["AAA"])), "live");
});

console.log("\n4. the HTTP handler");
const jsonOut = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
const handle = async (url, fx, over) => {
  const { fetchJson } = mflFrom(fx, over);
  const fetchImpl = async (u) => { const j = await fetchJson(u); return { ok: j != null, json: async () => j }; };
  const r = await F.handleFpaRequest(new Request("https://w.test" + url), {}, null, { jsonOut, nowMs: fx.nowMs, lid: "74598", fetchImpl });
  return { status: r.status, json: await r.json() };
};
await check("a season that hasn't started answers not_started without reading MFL", async () => {
  let n = 0;
  const r = await F.handleFpaRequest(new Request("https://w.test/api/fantasy-points-against?YEAR=2027"), {}, null, { jsonOut, nowMs: FIX.nowMs, fetchImpl: async () => { n++; return null; } });
  const j = await r.json();
  assert.strictEqual(j.season.state, "not_started"); assert.strictEqual(n, 0);
});
await check("no week_max = through the last complete week (4); response keeps every field the desktop workbench reads", async () => {
  const r = await handle("/api/fantasy-points-against?YEAR=2026&week_min=1", FIX);
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.window.week_max, 4); assert.strictEqual(r.json.window.auto, true);
  assert.deepStrictEqual(r.json.weeksUsed, [1, 2, 3, 4]);
  const c = r.json.teams.BUF.QB;
  for (const k of ["total", "perGame", "oppNorm", "games"]) assert.ok(k in c.raw, k);
  for (const k of ["rank", "of", "ratio"]) assert.ok(k in c.adj, k);
  assert.strictEqual(r.json.attribution.context, "none");   // no D1 bound in this test
});
await check("a failed MFL read → 502 ok:false naming the week (never ok:true)", async () => {
  const r = await handle("/api/fantasy-points-against?YEAR=2026&week_min=1&week_max=5", FIX, { playerScores3: null });
  assert.strictEqual(r.status, 502); assert.strictEqual(r.json.ok, false); assert.deepStrictEqual(r.json.failedWeeks, [3]);
});
await check("fpa-detail needs team and pos; an unknown team is a 400", async () => {
  assert.strictEqual((await handle("/api/fpa-detail?YEAR=2026&pos=QB", FIX)).status, 400);
  assert.strictEqual((await handle("/api/fpa-detail?YEAR=2026&team=XXX&pos=QB&week_max=5", FIX)).status, 400);
});
await check("the handler only ever issues GETs", async () => {
  const methods = [];
  const fetchImpl = async (u, o) => { methods.push((o && o.method) || "GET"); const j = await mflFrom(FIX).fetchJson(u); return { ok: true, json: async () => j }; };
  await F.handleFpaRequest(new Request("https://w.test/api/fpa-detail?YEAR=2026&team=BUF&pos=QB&week_max=5"), {}, null, { jsonOut, nowMs: FIX.nowMs, fetchImpl });
  assert.ok(methods.length > 0 && methods.every((m) => m === "GET"), methods.join());
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
