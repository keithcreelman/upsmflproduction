// Lineup matchup info (worker/src/lineup_matchups.js, GET /api/lineup-matchups), review
// #1249. The route used to carry its own copy of the old Pts Agst engine; it now runs
// worker/src/fpa_engine.js. These checks run the real handler on (a) every 2026 QB,
// Wks 1–5, read 2026-10-12 23:12 UTC with Monday night BUF @ LAR not yet played, and
// (b) a tiny hand-made league for what real data can't pin down.
//   node tests/lineup_matchups.test.mjs
import fs from "fs";
import assert from "assert";
import * as F from "../worker/src/fpa_engine.js";
import * as LM from "../worker/src/lineup_matchups.js";

const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/fpa_qb_2026_wk5_2026_10_12.json", import.meta.url), "utf8"));
let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };
const jsonOut = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });

// nflverse games.csv: the header, then rows as needed (only location matters here).
const CSV_HEAD = "game_id,season,game_type,week,gameday,weekday,gametime,away_team,away_score,home_team,home_score,location";
const csvRow = (yr, wk, away, home, loc) => [yr + "_" + String(wk).padStart(2, "0") + "_" + away + "_" + home, yr, "REG", wk, "", "", "", away, "", home, "", loc].join(",");
// MFL as a fixture saw it, per season. Past the league's last week MFL answers with that
// last week again (what it really does). Open-Meteo answers `weather` (or fails).
function mflFrom(bySeason, opts) {
  opts = opts || {};
  const calls = [];
  const fetchImpl = async (u, o) => {
    calls.push({ u, method: (o && o.method) || "GET" });
    const x = new URL(u);
    if (x.hostname === "raw.githubusercontent.com") {
      const csv = opts.csv === undefined ? CSV_HEAD + "\n" : opts.csv;
      return { ok: csv != null, text: async () => csv };
    }
    if (x.hostname.indexOf("open-meteo") >= 0) {
      const w = opts.weather === undefined ? null : opts.weather;
      return { ok: w != null, json: async () => w };
    }
    const Y = x.pathname.split("/")[1], fx = bySeason[Y];
    const T = x.searchParams.get("TYPE"), W = Number(x.searchParams.get("W"));
    const key = Y + ":" + T + W;
    let j;
    if (opts.over && opts.over[key] !== undefined) j = opts.over[key];
    else if (!fx) j = null;
    else if (T === "league") j = { league: { endWeek: String(fx.endWeek) } };
    else if (T === "players") j = { players: { player: fx.players } };
    else if (T === "nflSchedule") j = { nflSchedule: { week: String(W), matchup: fx.sched[W] || [] } };
    else if (T === "playerScores") j = W > fx.endWeek ? { playerScores: { week: String(fx.endWeek), playerScore: fx.scores[fx.endWeek] || [] } }
      : { playerScores: { week: String(W), playerScore: fx.scores[W] || { id: "", score: "", week: String(W) } } };
    else throw new Error("unexpected " + u);
    return { ok: j != null, json: async () => j };
  };
  return { fetchImpl, calls };
}
// D1 as the engine reads it: game-day team rows (season, rows[]), nothing else.
function dbFrom(teamRowsBySeason) {
  const queries = [];
  return { queries, UPS_MFL_DB: { prepare: (sql) => ({ bind: (...b) => ({ all: async () => {
    queries.push(sql);
    if (!/^\s*(WITH|SELECT)\b/i.test(sql)) throw new Error("non-SELECT " + sql);
    if (/WITH pw AS/.test(sql)) return { results: (teamRowsBySeason[b[0]] || []).map((r) => ({ m: r.m, t: r.t, lo: null, hi: null, wk: r.wk })) };
    return { results: [] };
  } }) }) } };
}
function fixRows(fx) {
  const out = [];
  for (const r of fx.weekly) for (const m of Object.keys(fx.ffIds)) if (fx.ffIds[m] === r.gsis_id) out.push({ m, wk: r.week, t: r.team });
  return out;
}
const run = async (q, bySeason, opts) => {
  opts = opts || {};
  const { fetchImpl, calls } = mflFrom(bySeason, opts);
  const env = opts.env || dbFrom(opts.rows || {});
  const r = await LM.handleLineupMatchups(new Request("https://w.test/api/lineup-matchups?" + q), env, null, { jsonOut, nowMs: opts.nowMs, lid: "74598", fetchImpl });
  return { status: r.status, json: await r.json(), calls };
};
const fpaRun = async (q, bySeason, opts) => {
  const { fetchImpl } = mflFrom(bySeason, opts);
  const r = await F.handleFpaRequest(new Request("https://w.test/api/fantasy-points-against?" + q), dbFrom(opts.rows || {}), null, { jsonOut, nowMs: opts.nowMs, lid: "74598", fetchImpl });
  return r.json();
};

console.log("1. real 2026 QBs, Wks 1–5, Monday 2026-10-12 before BUF @ LAR (lineup week 5)");
const REAL = { 2026: FIX };
const realOpts = { nowMs: FIX.nowMs, rows: { 2026: fixRows(FIX) } };
const R = await run("YEAR=2026&W=5", REAL, realOpts);
const P = await fpaRun("YEAR=2026&week_min=1", REAL, realOpts);
await check("200 ok, and the defense numbers come from the Pts Agst engine", () => {
  assert.strictEqual(R.status, 200); assert.strictEqual(R.json.ok, true); assert.strictEqual(R.json.engine, F.FPA_ENGINE_VERSION);
});
await check("every team's QB rank, of, ratio, games, Allowed and Usual equal the Pts Agst board (same window: full season through the latest completed game)", () => {
  let n = 0;
  for (const t in P.teams) {
    const c = P.teams[t].QB, d = R.json.defRatings[t] && R.json.defRatings[t].QB;
    assert.ok(d, t);
    assert.deepStrictEqual([d.rank, d.of, d.ratio, d.games, d.perGame, d.usual],
      [c.adj ? c.adj.rank : null, c.adj ? c.adj.of : null, c.adj ? c.adj.ratio : null, c.raw.games, c.raw.perGame, c.raw.oppNorm], t);
    n++;
  }
  assert.strictEqual(n, 32);
});
await check("BUF's unplayed Monday game is not counted: 4 games, 27.9 allowed per game, rank 6 of 32, ratio 1.29", () => {
  const c = R.json.defRatings.BUF.QB;
  assert.deepStrictEqual([c.rank, c.of, c.ratio, c.games, c.perGame, c.usual], [6, 32, 1.29, 4, 27.9, 21.7]);
});
await check("ppgRank (Keith 2026-10-13) = MFL points allowed per game, #1 the most: the board's Allowed column high to low, ties by the board's rank", () => {
  const rows = Object.keys(P.teams).map((t) => ({ t, v: P.teams[t].QB.raw.perGame, rk: P.teams[t].QB.adj ? P.teams[t].QB.adj.rank : 999 }))
    .sort((a, b) => (b.v - a.v) || (a.rk - b.rk) || (a.t < b.t ? -1 : 1));
  rows.forEach((r, i) => { assert.strictEqual(R.json.defRatings[r.t].QB.ppgRank, i + 1, r.t); assert.strictEqual(R.json.defRatings[r.t].QB.ppgOf, 32, r.t); });
  // BUF allowed the most per game here only if its 27.9 tops the list.
  assert.strictEqual(R.json.defRatings[rows[0].t].QB.ppgRank, 1);
});
await check("basis = Wks 1–5 (Week 5's final games), this season, not last season", () => {
  assert.deepStrictEqual(R.json.weeksUsed, [1, 2, 3, 4, 5]); assert.strictEqual(R.json.ratingsBasis, "Wks 1–5");
  assert.strictEqual(R.json.priorSeason, false); assert.strictEqual(R.json.ratingYear, "2026");
  assert.strictEqual(R.json.season.latestFinalWeek, 5); assert.strictEqual(R.json.season.lastCompleteWeek, 4);
});
await check("this week's game for BUF: @ LAR, not played yet; next three weeks listed", () => {
  const m = R.json.matchups.BUF;
  assert.strictEqual(m.opp, "LAR"); assert.strictEqual(m.isHome, false); assert.strictEqual(m.status, "scheduled");
  assert.deepStrictEqual(R.json.horizon.BUF.map((h) => h.wk), [6, 7, 8].filter((w) => (FIX.sched[w] || []).some((g) => g.team.some((t) => t.id === "BUF"))));
});
await check("a player's points per game count final games only, credited by game day (Josh Allen: 4 games, not 5)", () => {
  const allen = FIX.players.find((p) => /^Allen, Josh/.test(p.name));
  const pw = R.json.playerWindow[allen.id];
  const real = [1, 2, 3, 4].map((w) => Number((FIX.scores[w].find((s) => s.id === allen.id) || {}).score)).filter((v) => !isNaN(v));
  assert.strictEqual(pw.games, real.length);
  assert.strictEqual(pw.total, Math.round(real.reduce((a, b) => a + b, 0) * 10) / 10);
});
await check("reads: 1 league + 1 players + 17 schedules + 5 score weeks + 1 venue list + 1 weather = 26, all GET, under the Free plan's 50", () => {
  assert.strictEqual(R.calls.length, 26, R.calls.map((c) => c.u).join("\n"));
  assert.ok(R.calls.every((c) => c.method === "GET"));
});
await check("every MFL read carries the engine's tag, so Lineup and Pts Agst share one copy of each MFL reply", () => {
  assert.ok(R.calls.filter((c) => /myfantasyleague/.test(c.u)).every((c) => /&ups=fpa2\b/.test(c.u)));
});
await check("&last=3 = the last three weeks of that window (Wks 3–5), same engine", () => {
  return run("YEAR=2026&W=5&last=3", REAL, realOpts).then((r) => {
    assert.deepStrictEqual(r.json.weeksUsed, [3, 4, 5]); assert.strictEqual(r.json.ratingWindow.week_min, 3); assert.strictEqual(r.json.window, 3);
  });
});
await check("fields every reader uses are still there (mobile Lineup + Players picker, desktop Game Day)", () => {
  const j = R.json;
  for (const k of ["matchups", "defRatings", "playerWindow", "horizon", "weather", "weeksAvailable", "priorSeason", "ratingsBasis"]) assert.ok(k in j, k);
  for (const k of ["opp", "isHome", "kickoff", "spread"]) assert.ok(k in j.matchups.BUF, k);
  for (const k of ["rank", "of", "ratio"]) assert.ok(k in j.defRatings.BUF.QB, k);
  const any = Object.values(j.playerWindow)[0]; for (const k of ["total", "games", "avg"]) assert.ok(k in any, k);
  for (const k of ["wk", "opp", "isHome"]) assert.ok(k in j.horizon.BUF[0], k);
  assert.strictEqual(j.weeksAvailable, 5);
});

console.log("\n2. a tiny league for the cases real data can't pin");
// Teams AAA–DDD; 2026 Wk 1: AAA–BBB, CCC–DDD (final); Wk 2: AAA–CCC (final), BBB–DDD (later).
const NOW = Date.parse("2026-10-12T23:00:00Z"), pastKo = String(Math.floor(NOW / 1000) - 86400 * 3), soonKo = String(Math.floor(NOW / 1000) + 3600), farKo = String(Math.floor(NOW / 1000) + 86400 * 6);
const game = (a, b, ko, secs, spread) => ({ kickoff: ko, gameSecondsRemaining: secs, team: [{ id: a, isHome: "0", spread: spread || "" }, { id: b, isHome: "1", spread: spread ? String(-Number(spread)) : "" }] });
const QB = (id, team) => ({ id, name: "Qb, " + id, position: "QB", team });
const MINI = {
  endWeek: 3,
  players: [QB("1", "AAA"), QB("2", "BBB"), QB("3", "CCC"), QB("9", "DDD")],
  sched: { 1: [game("AAA", "BBB", pastKo, "0"), game("CCC", "DDD", pastKo, "0")], 2: [game("AAA", "CCC", pastKo, "0"), game("BBB", "DDD", soonKo, "3600", "3.5")], 3: [game("AAA", "DDD", farKo, "3600"), game("BBB", "CCC", farKo, "3600")] },
  // "9" played Wk 1 FOR CCC (vs DDD), then was traded to DDD.
  scores: { 1: [{ id: "1", score: "20" }, { id: "2", score: "10" }, { id: "9", score: "15" }], 2: [{ id: "1", score: "30" }, { id: "3", score: "12" }] },
};
const miniRows = { 2026: [{ m: "9", wk: 1, t: "CCC" }] };
await check("a traded player's points go to the team he FACED on game day (DDD), not his new team's opponent", async () => {
  const r = await run("YEAR=2026&W=2", { 2026: MINI }, { nowMs: NOW, rows: miniRows });
  assert.strictEqual(r.json.defRatings.DDD.QB.perGame, 15); assert.strictEqual(r.json.attribution.gameDay, 1);
  // CCC allowed only AAA's 30 in Wk 2 over its 2 games. The old route used the CURRENT
  // team for every week, so CCC would also have been charged his 15 (45 over 2 games).
  assert.deepStrictEqual([r.json.defRatings.CCC.QB.games, r.json.defRatings.CCC.QB.perGame], [2, 15]);
});
await check("a game not played yet counts for nothing (BBB and DDD: 1 game each)", async () => {
  const r = await run("YEAR=2026&W=2", { 2026: MINI }, { nowMs: NOW, rows: miniRows });
  assert.strictEqual(r.json.defRatings.BBB.QB.games, 1); assert.strictEqual(r.json.defRatings.DDD.QB.games, 1); assert.strictEqual(r.json.defRatings.AAA.QB.games, 2);
});
await check("the spread is MFL's number for that team; blank, 0, or the two sides not agreeing → null", async () => {
  const r = await run("YEAR=2026&W=2", { 2026: MINI }, { nowMs: NOW, rows: miniRows });
  assert.strictEqual(r.json.matchups.BBB.spread, 3.5); assert.strictEqual(r.json.matchups.DDD.spread, -3.5); assert.strictEqual(r.json.matchups.AAA.spread, null);
  const odd = { ...MINI, sched: { ...MINI.sched, 2: [{ ...game("AAA", "CCC", pastKo, "0"), team: [{ id: "AAA", isHome: "0", spread: "-7" }, { id: "CCC", isHome: "1", spread: "-5.5" }] }] } };
  const r2 = await run("YEAR=2026&W=2", { 2026: odd }, { nowMs: NOW, rows: miniRows });
  assert.strictEqual(r2.json.matchups.AAA.spread, null); assert.strictEqual(r2.json.matchups.CCC.spread, null);
});
await check("horizonWeeks = the weeks read for 'Next', so a bye week shows as a bye", async () => {
  const r = await run("YEAR=2026&W=1", { 2026: MINI }, { nowMs: NOW, rows: miniRows });
  assert.deepStrictEqual(r.json.horizonWeeks, [2, 3]);
});
await check("a failed MFL read → 502 ok:false naming the week (the old route quietly dropped it)", async () => {
  const r = await run("YEAR=2026&W=2", { 2026: MINI }, { nowMs: NOW, rows: miniRows, over: { "2026:playerScores1": null } });
  assert.strictEqual(r.status, 502); assert.strictEqual(r.json.ok, false); assert.deepStrictEqual(r.json.failedWeeks, [1]);
});
await check("MFL answering a week with another week's scores is refused (502), not counted twice", async () => {
  const r = await run("YEAR=2026&W=3", { 2026: MINI }, { nowMs: NOW, rows: miniRows, over: { "2026:playerScores2": { playerScores: { week: "1", playerScore: MINI.scores[1] } } } });
  assert.strictEqual(r.status, 502); assert.deepStrictEqual(r.json.failedWeeks, [2]);
});
await check("this week's schedule unreadable → 502", async () => {
  const r = await run("YEAR=2026&W=2", { 2026: MINI }, { nowMs: NOW, rows: miniRows, over: { "2026:nflSchedule2": null } });
  assert.strictEqual(r.status, 502);
});

console.log("\n3. Week 1: last season until one of this season's games is final");
// 2025: a finished 17-week season (endWeek 17); MFL answers "week 18" with week 17 again.
const S25 = { endWeek: 17, players: [QB("1", "AAA"), QB("2", "BBB"), QB("3", "CCC"), QB("4", "DDD"), QB("8", "BBB")], sched: {}, scores: {} };
const K25 = String(Math.floor(Date.parse("2025-11-01T17:00:00Z") / 1000));
for (let w = 1; w <= 17; w++) {
  S25.sched[w] = w % 2 ? [game("AAA", "BBB", K25, "0"), game("CCC", "DDD", K25, "0")] : [game("AAA", "CCC", K25, "0"), game("BBB", "DDD", K25, "0")];
  S25.scores[w] = [{ id: "1", score: "20" }, { id: "2", score: "10" }, { id: "3", score: "14" }, { id: "4", score: "16" }];
}
S25.scores[17] = S25.scores[17].concat([{ id: "8", score: "99" }]);   // a week-17 outlier: counted once, never twice
const N26 = Date.parse("2026-09-09T12:00:00Z");   // Wednesday before 2026 Week 1
const K26 = String(Math.floor(Date.parse("2026-09-10T00:20:00Z") / 1000));
const S26 = { endWeek: 17, players: [QB("1", "BBB"), QB("2", "AAA"), QB("3", "CCC"), QB("4", "DDD")], sched: { 1: [game("AAA", "BBB", K26, "3600"), game("CCC", "DDD", K26, "3600")], 2: [game("AAA", "CCC", K26, "3600")], 3: [], 4: [] }, scores: {} };
for (let w = 5; w <= 17; w++) S26.sched[w] = [];
const W1 = await run("YEAR=2026&W=1", { 2025: S25, 2026: S26 }, { nowMs: N26, rows: {} });
await check("before any 2026 game is final, the ratings are 2025's, labeled as such", () => {
  assert.strictEqual(W1.status, 200); assert.strictEqual(W1.json.priorSeason, true); assert.strictEqual(W1.json.ratingYear, "2025");
  assert.strictEqual(W1.json.ratingsBasis, "2025 season"); assert.strictEqual(W1.json.weeksAvailable, 0);
});
await check("2025 uses 2025's players (the old route read the NEW season's teams for last season's games)", () => {
  assert.ok(W1.calls.some((c) => /\/2025\/export\?TYPE=players/.test(c.u)));
  assert.ok(!W1.calls.some((c) => /\/2026\/export\?TYPE=players/.test(c.u)));
});
await check("2025's 'week 18' is never read (MFL answers it with week 17 again): 17 score weeks", () => {
  const sw = W1.calls.filter((c) => /\/2025\/export\?TYPE=playerScores/.test(c.u)).map((c) => Number(new URL(c.u).searchParams.get("W")));
  assert.deepStrictEqual(sw, Array.from({ length: 17 }, (_, i) => i + 1));
  assert.strictEqual(W1.json.defRatings.AAA.QB.games, 17);   // the old route counted week 17 twice (18 games)
});
await check("this week's games are 2026's (the 2026 schedule), whatever season the ratings describe", () => {
  assert.strictEqual(W1.json.matchups.AAA.opp, "BBB"); assert.strictEqual(W1.json.matchups.AAA.status, "scheduled");
});
await check("Week 1 reads stay under the Free plan's 50: 2026 Wk 1–4 schedules (4) + the 2025 board (2 + 17 + 17) + venue list = 41 (42 with a weather read)", () => {
  assert.strictEqual(W1.calls.length, 41, W1.calls.map((c) => c.u).join("\n"));
});
await check("once a 2026 game is final, the ratings are 2026's (that game only), like the Pts Agst board", async () => {
  const after = Date.parse("2026-09-10T05:00:00Z");
  const s = { ...S26, sched: { ...S26.sched, 1: [game("AAA", "BBB", K26, "0"), game("CCC", "DDD", String(Number(K26) + 86400 * 3), "3600")] }, scores: { 1: [{ id: "1", score: "18" }, { id: "2", score: "25" }] } };
  const r = await run("YEAR=2026&W=1", { 2025: S25, 2026: s }, { nowMs: after, rows: {} });
  assert.strictEqual(r.json.priorSeason, false); assert.strictEqual(r.json.ratingYear, "2026");
  assert.deepStrictEqual(r.json.weeksUsed, [1]); assert.strictEqual(r.json.defRatings.AAA.QB.games, 1);
  assert.ok(!r.json.defRatings.CCC, "CCC hasn't played: no rating");
});

console.log("\n4. weather, caching, safety");
await check("dome venues are flagged without a weather read; no forecast hour near kickoff → no weather line", async () => {
  const s = { ...MINI, sched: { ...MINI.sched, 2: [game("AAA", "IND", soonKo, "3600"), game("BBB", "BUF", farKo, "3600")] } };
  const wx = [{ hourly: { time: [Number(farKo) - 86400 * 5], temperature_2m: [50], wind_speed_10m: [5], precipitation: [0], weather_code: [0] } }];
  const r = await run("YEAR=2026&W=2", { 2026: s }, { nowMs: NOW, rows: miniRows, weather: wx });
  assert.deepStrictEqual(r.json.weather.IND, { dome: true }); assert.deepStrictEqual(r.json.weather.AAA, { dome: true });
  assert.strictEqual(r.json.weather.BUF, undefined); assert.strictEqual(r.json.weatherState, "unavailable");
});
await check("a neutral-site game (London, Munich, …) gets no forecast: MFL has no venue, and the home team's city would be wrong", async () => {
  const s = { ...MINI, sched: { ...MINI.sched, 2: [game("HOU", "JAC", soonKo, "3600"), game("BBB", "BUF", soonKo, "3600")] } };
  const wx = [{ hourly: { time: [Number(soonKo)], temperature_2m: [41], wind_speed_10m: [9], precipitation: [0], weather_code: [3] } }];
  const csv = CSV_HEAD + "\n" + csvRow(2026, 2, "HOU", "JAX", "Neutral") + "\n" + csvRow(2026, 2, "BBB", "BUF", "Home") + "\n";
  const r = await run("YEAR=2026&W=2", { 2026: s }, { nowMs: NOW, rows: miniRows, weather: wx, csv });
  assert.deepStrictEqual(r.json.weather.JAC, { neutral: true }); assert.deepStrictEqual(r.json.weather.HOU, { neutral: true });
  assert.strictEqual(r.json.weather.BUF.tempF, 41); assert.strictEqual(r.json.weatherState, "ok");
  const om = r.calls.filter((c) => /open-meteo/.test(c.u));
  assert.strictEqual(om.length, 1); assert.ok(!/30\.32/.test(om[0].u), "no Jacksonville forecast read");
});
await check("venue list unreadable → no weather at all (never a possibly wrong city), still 200", async () => {
  const s = { ...MINI, sched: { ...MINI.sched, 2: [game("AAA", "BUF", soonKo, "3600")] } };
  const r = await run("YEAR=2026&W=2", { 2026: s }, { nowMs: NOW, rows: miniRows, csv: null, weather: [{ hourly: { time: [Number(soonKo)], temperature_2m: [41], wind_speed_10m: [9], precipitation: [0], weather_code: [3] } }] });
  assert.strictEqual(r.status, 200); assert.deepStrictEqual(r.json.weather, {}); assert.strictEqual(r.json.weatherState, "unavailable");
});
await check("Open-Meteo down: still 200 with the matchups; weatherState says unavailable", async () => {
  const s = { ...MINI, sched: { ...MINI.sched, 2: [game("AAA", "BUF", soonKo, "3600")] } };
  const r = await run("YEAR=2026&W=2", { 2026: s }, { nowMs: NOW, rows: miniRows, weather: null });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.json.weatherState, "unavailable"); assert.strictEqual(r.json.matchups.AAA.opp, "BUF");
});
await check("the response cache sits on its own key host with the version, never caches a failure, and D1 sees SELECTs only", async () => {
  const puts = [], saved = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async (req) => { puts.push(req.url); } } };
  try {
    const env = dbFrom(miniRows);
    await run("YEAR=2026&W=2", { 2026: MINI }, { nowMs: NOW, env });
    await run("YEAR=2026&W=2&last=1", { 2026: MINI }, { nowMs: NOW, env, over: { "2026:playerScores1": null } });
    const lmu = puts.filter((u) => /upsmfl-lineup\.local/.test(u));
    assert.strictEqual(lmu.length, 1, puts.join("\n"));
    assert.ok(/\/api\/lineup-matchups\?YEAR=2026&W=2&v=lmu2-/.test(lmu[0]), lmu[0]);
    assert.ok(env.queries.length > 0 && env.queries.every((q) => /^\s*(WITH|SELECT)\b/i.test(q)));
  } finally { globalThis.caches = saved; }
});
await check("bad input is a 400 (YEAR not 4 digits, W missing)", async () => {
  assert.strictEqual((await run("YEAR=26&W=2", { 2026: MINI }, { nowMs: NOW })).status, 400);
  assert.strictEqual((await run("YEAR=2026", { 2026: MINI }, { nowMs: NOW })).status, 400);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
