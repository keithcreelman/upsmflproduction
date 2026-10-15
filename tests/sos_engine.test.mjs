// Player Stats "Sched Δ" (#1271): /api/sos-adjusted-points on the Pts Agst engine
// (worker/src/fpa_engine.js handleSosRequest), run for real on MFL's own replies:
//   (a) UPS 2025 playoffs, Wks 15–17, every QB / TE / K MFL scored (fixture read 2026-10-15),
//   (b) 2020, Wks 12–16 (a 16-week season, playoffs 14–16; MFL repeats Wk 16 for Wk 17),
//   (c) the committed 2020 finished-season store file,
//   (d) tiny hand-made seasons for the cases real data can't pin down.
// Expected values are worked out here from the raw replies, never by the engine under test.
//   node tests/sos_engine.test.mjs
import fs from "fs";
import assert from "assert";
import * as F from "../worker/src/fpa_engine.js";

const FX25 = JSON.parse(fs.readFileSync(new URL("./fixtures/sos_2025_wk15_17_qb_te_pk.json", import.meta.url), "utf8"));
const FX20 = JSON.parse(fs.readFileSync(new URL("./fixtures/sos_2020_wk12_16_qb.json", import.meta.url), "utf8"));
const STORE_DIR = new URL("../worker/fpa_store/" + F.FPA_ENGINE_VERSION + "/", import.meta.url);
let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };

// ── stand-ins: MFL as the fixture saw it, and D1's game-day team rows ──
function mflFrom(fx, over) {
  over = over || {};
  const calls = [];
  const fetchJson = async (u) => {
    calls.push(u);
    const x = new URL(u), T = x.searchParams.get("TYPE"), W = Number(x.searchParams.get("W"));
    if (over[T + W] !== undefined) return typeof over[T + W] === "function" ? over[T + W]() : over[T + W];
    if (T === "league") return { league: { endWeek: String(fx.endWeek), lastRegularSeasonWeek: String(fx.lastRegularSeasonWeek) } };
    if (T === "players") return { players: { player: fx.players } };
    if (T === "nflSchedule") return { nflSchedule: { week: String(W), matchup: fx.sched[W] || [] } };
    if (T === "playerScores") {
      if (W > fx.endWeek) return { playerScores: { week: String(fx.endWeek), playerScore: fx.scores[fx.endWeek] || [] } };   // MFL repeats its last week
      if (!fx.scores[W]) throw new Error("fixture has no Week " + W + " scores: " + u);
      return { playerScores: { week: String(W), playerScore: fx.scores[W] } };
    }
    throw new Error("unexpected " + u);
  };
  return { fetchJson, calls };
}
// The three SELECTs fpaLoadSeasonContext runs, answered from the fixture's nflverse rows.
function fakeDb(fx) {
  const g2m = {};
  for (const m in fx.ffIds) (g2m[fx.ffIds[m]] = g2m[fx.ffIds[m]] || []).push(m);
  const per = {};
  for (const r of fx.weekly) for (const m of g2m[r.gsis_id] || []) (per[m] = per[m] || {})[r.week] = r.team;
  const teamRows = [];
  for (const m in per) {
    const wks = Object.keys(per[m]).map(Number), ts = new Set(Object.values(per[m]));
    if (ts.size === 1) teamRows.push({ m, t: [...ts][0], lo: Math.min(...wks), hi: Math.max(...wks), wk: null });
    else for (const w of wks) teamRows.push({ m, t: per[m][w], lo: null, hi: null, wk: w });
  }
  const queries = [];
  return {
    queries,
    prepare(sql) {
      if (!/^\s*(SELECT|WITH)\b/i.test(sql)) throw new Error("only SELECT: " + sql);
      queries.push(sql);
      const rows = /WITH pw AS/.test(sql) ? teamRows : [];
      const stmt = { bind: () => stmt, all: async () => ({ results: rows }) };
      return stmt;
    },
  };
}
const jsonOut = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
async function call(url, fx, { over, nowMs, env } = {}) {
  const { fetchJson, calls } = mflFrom(fx, over);
  const fetchImpl = async (u, o) => {
    if (o && o.method && o.method !== "GET") throw new Error("non-GET " + u);
    const j = await fetchJson(u);
    return { ok: j != null, status: j != null ? 200 : 500, json: async () => j };
  };
  F.fpaStoreForget();
  const r = await F.handleSosRequest(new Request("https://w.test" + url), env || { UPS_MFL_DB: fakeDb(fx) }, null, { jsonOut, nowMs: nowMs || fx.nowMs, fetchImpl });
  return { status: r.status, body: await r.json(), calls, headers: r.headers };
}

// ── the expected answer, worked out independently from the raw replies ──
const NFLV = { GB: "GBP", KC: "KCC", NE: "NEP", NO: "NOS", SF: "SFO", TB: "TBB", LV: "LVR", JAX: "JAC", LA: "LAR" };
const GRP = { QB: "QB", RB: "RB", FB: "RB", HB: "RB", WR: "WR", TE: "TE", PK: "PK", K: "PK", PN: "PN", P: "PN",
  DT: "DL", DE: "DL", NT: "DL", DL: "DL", LB: "LB", OLB: "LB", ILB: "LB", MLB: "LB", CB: "DB", S: "DB", FS: "DB", SS: "DB", DB: "DB" };
function expected({ players, sched, scores, teamOf, lo, hi, nowMs }) {
  const pos = {}, mflTeam = {};
  for (const p of players) { pos[p.id] = GRP[String(p.position).toUpperCase()] || ""; mflTeam[p.id] = String(p.team).toUpperCase(); }
  const games = [];   // player-games: { pid, w, pts, grp, def }
  for (let w = lo; w <= hi; w++) {
    const scored = new Set();
    for (const s of scores[w] || []) if (!isNaN(parseFloat(s.score)) && mflTeam[s.id]) scored.add(mflTeam[s.id]);
    const opp = {}, fin = {};
    for (const m of sched[w] || []) {
      const [a, b] = m.team.map((t) => String(t.id).toUpperCase());
      const over = String(m.gameSecondsRemaining) === "0" || Number(m.kickoff) * 1000 <= nowMs - 5 * 3600 * 1000;
      const done = Number(m.kickoff) * 1000 <= nowMs && over && (scored.has(a) || scored.has(b));
      opp[a] = b; opp[b] = a; fin[a] = done; fin[b] = done;
    }
    for (const s of scores[w] || []) {
      const pts = parseFloat(s.score); if (isNaN(pts) || !pos[s.id]) continue;
      let own = "";
      const nv = teamOf(s.id, w);
      if (nv && opp[NFLV[nv] || nv]) own = NFLV[nv] || nv;
      if (!own && opp[mflTeam[s.id]]) own = mflTeam[s.id];
      if (!own || !fin[own]) continue;
      games.push({ pid: s.id, w, pts, grp: pos[s.id], def: opp[own] });
    }
  }
  const usual = {};
  for (const g of games) (usual[g.pid] = usual[g.pid] || []).push(g.pts);
  for (const p in usual) usual[p] = usual[p].reduce((a, b) => a + b, 0) / usual[p].length;
  const out = {};
  for (const g of games) {
    const o = out[g.pid] || (out[g.pid] = { grp: g.grp, raw: 0, gp: 0, rated: 0, rsum: 0, others: 0 });
    o.raw += g.pts; o.gp++;
    const others = games.filter((x) => x.def === g.def && x.grp === g.grp && x.pid !== g.pid);
    const exp = others.reduce((a, x) => a + usual[x.pid], 0), pts = others.reduce((a, x) => a + x.pts, 0);
    if (!others.length || !(exp > 1e-9) || !(pts / exp > 0)) continue;
    o.rated++; o.rsum += pts / exp; o.others += others.length;
  }
  return { out, games };
}
function teamOfFixture(fx) {
  const g2m = {};
  for (const m in fx.ffIds) (g2m[fx.ffIds[m]] = g2m[fx.ffIds[m]] || []).push(m);
  const t = {};
  for (const r of fx.weekly) for (const m of g2m[r.gsis_id] || []) (t[m] = t[m] || {})[r.week] = r.team;
  // Pts Agst's game-day rule: one nflverse team all season → that team from his first to
  // his last nflverse week; otherwise week by week.
  return (pid, w) => {
    const x = t[pid]; if (!x) return "";
    const teams = new Set(Object.values(x)), wks = Object.keys(x).map(Number);
    if (teams.size === 1) return w >= Math.min(...wks) && w <= Math.max(...wks) ? [...teams][0] : "";
    return x[w] || "";
  };
}
const r1 = (v) => Math.round(v * 10) / 10;
function rowOf(o) {
  const opp = o.rated ? o.rsum / o.rated : null;
  const adj = opp ? o.raw / opp : null;
  return { pos: o.grp, raw: r1(o.raw), gp: o.gp, rated: o.rated, others: o.others, opp: opp == null ? null : Math.round(opp * 1000) / 1000, adj: adj == null ? null : r1(adj), delta: adj == null ? null : r1(adj - o.raw) };
}
function sameRows(got, exp, label) {
  const ek = Object.keys(exp).sort(), gk = Object.keys(got).sort();
  assert.deepStrictEqual(gk, ek, label + ": player set");
  for (const k of ek) {
    const e = rowOf(exp[k]), g = got[k];
    for (const f of ["pos", "gp", "rated", "others"]) assert.strictEqual(g[f], e[f], label + " " + k + " " + f);
    for (const f of ["raw", "adj", "delta"]) {
      if (e[f] == null) assert.strictEqual(g[f], null, label + " " + k + " " + f + " must be null, not " + g[f]);
      else assert.ok(Math.abs(g[f] - e[f]) <= 0.1 + 1e-9, label + " " + k + " " + f + " " + g[f] + " vs " + e[f]);
    }
    if (e.opp == null) assert.strictEqual(g.opp, null, label + " " + k + " opp must be null");
    else assert.ok(Math.abs(g.opp - e.opp) <= 0.0011, label + " " + k + " opp " + g.opp + " vs " + e.opp);
  }
}

console.log("1. UPS 2025 playoffs (Wks 15–17), every QB / TE / K MFL scored");
const P25 = await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=17", FX25);
const E25 = expected({ players: FX25.players, sched: FX25.sched, scores: FX25.scores, teamOf: teamOfFixture(FX25), lo: 15, hi: 17, nowMs: FX25.nowMs });
await check("200, engine + view stamps, the definition, and 2025 stated: complete, live, Wks 15–17 used", () => {
  assert.strictEqual(P25.status, 200, JSON.stringify(P25.body).slice(0, 300));
  assert.strictEqual(P25.body.ok, true); assert.strictEqual(P25.body.engine, F.FPA_ENGINE_VERSION); assert.strictEqual(P25.body.view, F.SOS_VERSION);
  assert.strictEqual(P25.body.definition, F.SOS_DEFINITION);
  const s = P25.body.per_season["2025"];
  assert.strictEqual(s.state, "complete"); assert.strictEqual(s.source, "live");
  assert.deepStrictEqual(s.weeksUsed, [15, 16, 17]); assert.deepStrictEqual(s.weeksInProgress, []); assert.deepStrictEqual(s.weeksNotPlayed, []);
  assert.deepStrictEqual(s.window, { week_min: 15, week_max: 17, requested_max: 17, clipped_to_end: false });
  assert.deepStrictEqual(s.playoffWeeks, [15, 16, 17]); assert.strictEqual(s.endWeek, 17);
});
await check("every player and every value equals the independent recomputation (" + Object.keys(E25.out).length + " players)", () => {
  sameRows(P25.body.by_mfl, E25.out, "2025 Wks 15–17");
  assert.ok(Object.keys(E25.out).length >= 190);
});
await check("players production src_weekly lacked for these weeks are all here, with values (free agents included)", () => {
  const inSrc = new Set(Object.values(FX25.srcWeekly).flat());
  const missing = Object.keys(E25.out).filter((p) => !inSrc.has(p));
  assert.ok(missing.length >= 90, "only " + missing.length + " players were missing from src_weekly");
  for (const p of missing) assert.ok(P25.body.by_mfl[p] && P25.body.by_mfl[p].gp > 0, p);
  const ratedMissing = missing.filter((p) => P25.body.by_mfl[p].delta != null).length;
  assert.ok(ratedMissing >= 80, "rated " + ratedMissing);
});
await check("game-day teams come from D1 (read-only SELECTs) and every player-game is attributed", () => {
  const a = P25.body.per_season["2025"].attribution;
  assert.strictEqual(a.context, "ok"); assert.strictEqual(a.unattributed, 0); assert.strictEqual(a.notFinal, 0);
  assert.strictEqual(a.gameDay + a.mflTeam, E25.games.length);
});
await check("reads: league + players + 17 schedules + exactly Wks 15–17 of scores, all GETs", () => {
  const ps = P25.calls.filter((u) => /TYPE=playerScores/.test(u)).map((u) => Number(new URL(u).searchParams.get("W")));
  assert.deepStrictEqual(ps.sort((a, b) => a - b), [15, 16, 17]);
  assert.strictEqual(P25.calls.filter((u) => /TYPE=nflSchedule/.test(u)).length, 17);
  assert.ok(P25.calls.every((u) => /L=74598/.test(u) || /TYPE=nflSchedule/.test(u)));
});

console.log("\n2. his own games never rate his opponents; no later week; final games only");
const qbs = Object.keys(E25.out).filter((p) => E25.out[p].grp === "QB" && E25.out[p].rated === 3);
const q = qbs[0];
await check("raising one QB's own points moves his raw and Δ, never his Opp", async () => {
  const bumped = JSON.parse(JSON.stringify(FX25.scores));
  for (const w of [15, 16, 17]) for (const s of bumped[w]) if (s.id === q) s.score = (parseFloat(s.score) + 20).toFixed(1);
  const r = await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=17", { ...FX25, scores: bumped });
  const a = P25.body.by_mfl[q], b = r.body.by_mfl[q];
  assert.strictEqual(b.opp, a.opp); assert.ok(Math.abs(b.raw - a.raw - 60) < 0.05); assert.notStrictEqual(b.delta, a.delta);
});
await check("raising the points of a QB who faced his Wk 15 opponent moves his Opp", async () => {
  const g = E25.games.find((x) => x.pid === q && x.w === 15);
  const other = E25.games.find((x) => x.def === g.def && x.grp === "QB" && x.pid !== q);
  assert.ok(other, "another QB faced " + g.def);
  const bumped = JSON.parse(JSON.stringify(FX25.scores));
  for (const s of bumped[other.w]) if (s.id === other.pid) s.score = (parseFloat(s.score) + 15).toFixed(1);
  const r = await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=17", { ...FX25, scores: bumped });
  assert.ok(r.body.by_mfl[q].opp > P25.body.by_mfl[q].opp, "opp " + r.body.by_mfl[q].opp + " vs " + P25.body.by_mfl[q].opp);
});
await check("Wks 15–16 never read Wk 17, and changing Wk 17 changes nothing in them", async () => {
  const a = await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=16", FX25);
  const junk = JSON.parse(JSON.stringify(FX25.scores));
  for (const s of junk[17]) s.score = "99.9";
  const b = await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=16", { ...FX25, scores: junk });
  assert.ok(!a.calls.some((u) => /TYPE=playerScores/.test(u) && /W=17\b/.test(u)));
  assert.deepStrictEqual(b.body.by_mfl, a.body.by_mfl);
  const e = expected({ players: FX25.players, sched: FX25.sched, scores: FX25.scores, teamOf: teamOfFixture(FX25), lo: 15, hi: 16, nowMs: FX25.nowMs });
  sameRows(a.body.by_mfl, e.out, "2025 Wks 15–16");
});
await check("mid-Week-17 (one game still being played): its players aren't counted; 17 is stated as in progress", async () => {
  const g = FX25.sched[17].slice().sort((x, y) => Number(y.kickoff) - Number(x.kickoff))[0];
  const now = Number(g.kickoff) * 1000 + 60 * 60 * 1000;   // an hour into the last game
  const sched = JSON.parse(JSON.stringify(FX25.sched));
  for (const m of sched[17]) if (m.kickoff === g.kickoff) m.gameSecondsRemaining = "1800";
  const fx = { ...FX25, sched, nowMs: now };
  // 2025 is the current season at that moment (late Dec / early Jan).
  const r25 = await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=17", fx, { nowMs: now });
  const s = r25.body.per_season["2025"];
  assert.strictEqual(s.state, "partial"); assert.deepStrictEqual(s.weeksInProgress, [17]); assert.deepStrictEqual(s.weeksNotPlayed, []); assert.deepStrictEqual(s.weeksUsed, [15, 16, 17]);
  const e = expected({ players: FX25.players, sched, scores: FX25.scores, teamOf: teamOfFixture(FX25), lo: 15, hi: 17, nowMs: now });
  sameRows(r25.body.by_mfl, e.out, "mid-Wk-17");
  const live = g.team.map((t) => t.id);
  assert.ok(e.games.length < E25.games.length);
  assert.ok(Object.keys(r25.body.by_mfl).length > 0);
  assert.ok(live.every((t) => !e.games.some((x) => x.w === 17 && (x.def === t))), "a player who faced a team still playing was counted");
});

await check("before Week 16 kicks off: Wk 15 counts, Wks 16–17 are stated as not played yet (never as in progress)", async () => {
  const k16 = Math.min(...FX25.sched[16].map((m) => Number(m.kickoff)));
  const now = k16 * 1000 - 3600 * 1000;
  const sched = JSON.parse(JSON.stringify(FX25.sched));
  for (const w of [16, 17]) for (const m of sched[w]) m.gameSecondsRemaining = "3600";
  const r = await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=17", { ...FX25, sched }, { nowMs: now });
  const s = r.body.per_season["2025"];
  assert.strictEqual(s.state, "partial"); assert.deepStrictEqual(s.weeksUsed, [15]);
  assert.deepStrictEqual(s.weeksInProgress, []); assert.deepStrictEqual(s.weeksNotPlayed, [16, 17]);
  assert.ok(!r.calls.some((u) => /TYPE=playerScores/.test(u) && /W=1[67]\b/.test(u)), "read scores for weeks not started");
  const e = expected({ players: FX25.players, sched, scores: FX25.scores, teamOf: teamOfFixture(FX25), lo: 15, hi: 15, nowMs: now });
  sameRows(r.body.by_mfl, e.out, "Wk 15 only");
});

console.log("\n3. a 16-week season (2020: playoffs 14–16; MFL answers Wk 17 with Wk 16 again)");
const P20 = await call("/api/sos-adjusted-points?seasons=2020&week_min=15&week_max=17", FX20, { nowMs: FX25.nowMs });
await check("'MFL Playoffs' 15–17 → Wks 15–16 only, stated as clipped to the season's end; Wk 17 never read", () => {
  assert.strictEqual(P20.status, 200, JSON.stringify(P20.body).slice(0, 300));
  const s = P20.body.per_season["2020"];
  assert.deepStrictEqual(s.window, { week_min: 15, week_max: 16, requested_max: 17, clipped_to_end: true });
  assert.deepStrictEqual(s.weeksUsed, [15, 16]); assert.strictEqual(s.endWeek, 16); assert.deepStrictEqual(s.playoffWeeks, [14, 15, 16]);
  assert.ok(!P20.calls.some((u) => /TYPE=playerScores/.test(u) && /W=17\b/.test(u)));
});
await check("2020's real UPS playoffs (Wks 14–16) equal the independent recomputation", async () => {
  const r = await call("/api/sos-adjusted-points?seasons=2020&week_min=14&week_max=16", FX20, { nowMs: FX25.nowMs });
  const e = expected({ players: FX20.players, sched: FX20.sched, scores: FX20.scores, teamOf: teamOfFixture(FX20), lo: 14, hi: 16, nowMs: FX25.nowMs });
  sameRows(r.body.by_mfl, e.out, "2020 Wks 14–16");
  assert.ok(Object.keys(e.out).length > 30, "players " + Object.keys(e.out).length);
  assert.deepStrictEqual(Object.keys(FX20.srcWeekly).map(Number).filter((w) => w >= 14), [], "production src_weekly has no 2020 playoff week");
});
await check("week_min past the season's last week → that season says 'outside_season' and adds no players", async () => {
  const r = await call("/api/sos-adjusted-points?seasons=2020&week_min=17&week_max=17", FX20, { nowMs: FX25.nowMs });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.per_season["2020"].state, "outside_season");
  assert.strictEqual(r.body.count, 0); assert.deepStrictEqual(r.body.by_mfl, {});
});
await check("2020 regular weeks 12–13: same answer as the recomputation (the old table had these)", async () => {
  const r = await call("/api/sos-adjusted-points?seasons=2020&week_min=12&week_max=13", FX20, { nowMs: FX25.nowMs });
  const e = expected({ players: FX20.players, sched: FX20.sched, scores: FX20.scores, teamOf: teamOfFixture(FX20), lo: 12, hi: 13, nowMs: FX25.nowMs });
  sameRows(r.body.by_mfl, e.out, "2020 Wks 12–13");
});

console.log("\n4. a stored finished season plus a live one, added together");
const store2020 = JSON.parse(fs.readFileSync(new URL("2020.json", STORE_DIR), "utf8"));
const storeEnv = (fx) => ({ UPS_MFL_DB: fakeDb(fx), FPA_STORE: { fetch: async (req) => {
  const m = new URL(req.url).pathname.match(/\/(\d{4})\.json$/);
  if (m && m[1] === "2020") return new Response(JSON.stringify(store2020), { status: 200 });
  return new Response("not found", { status: 404 });
} } });
await check("2020 answers from its stored copy (no MFL reads for it); 2025 live; per player: points and games summed, Opp = mean over all rated games", async () => {
  const r = await call("/api/sos-adjusted-points?seasons=2020,2025&week_min=15&week_max=17", FX25, { env: storeEnv(FX25) });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 300));
  assert.strictEqual(r.body.per_season["2020"].source, "stored"); assert.strictEqual(r.body.per_season["2025"].source, "live");
  assert.ok(!r.calls.some((u) => /\/2020\//.test(u)), "read MFL for a stored season");
  // 2020 from the store's raw contents, independently.
  const S = store2020;
  const players = S.players.map((p) => ({ id: String(p[0]), name: p[1], position: p[2], team: p[3] }));
  const sched = {}, scores = {};
  for (let w = 1; w <= S.endWeek; w++) {
    sched[w] = S.sched[w].map((m) => ({ kickoff: m[0], gameSecondsRemaining: m[1], team: m[2].map((t) => ({ id: t[0], isHome: t[1] })) }));
    scores[w] = S.scores[w].map((x) => ({ id: String(x[0]), score: x[1] }));
  }
  const teamOf = (pid, w) => { const mu = S.ctx.multi[pid]; if (mu) return mu[w] || ""; const o = S.ctx.one[pid]; return o && w >= o[1] && w <= o[2] ? o[0] : ""; };
  const e20 = expected({ players, sched, scores, teamOf, lo: 15, hi: 16, nowMs: FX25.nowMs }).out;
  const sum = {};
  for (const src of [e20, E25.out]) for (const p in src) {
    const a = sum[p] || (sum[p] = { grp: src[p].grp, raw: 0, gp: 0, rated: 0, rsum: 0, others: 0 });
    a.raw += src[p].raw; a.gp += src[p].gp; a.rated += src[p].rated; a.rsum += src[p].rsum; a.others += src[p].others;
  }
  sameRows(r.body.by_mfl, sum, "2020+2025");
  const both = Object.keys(e20).filter((p) => E25.out[p]);
  assert.ok(both.length >= 5, "players in both seasons: " + both.length);
});
await check("two seasons that each need a live MFL read → refused, named, nothing computed", async () => {
  const r = await call("/api/sos-adjusted-points?seasons=2020,2025&week_min=15&week_max=17", FX25);
  assert.strictEqual(r.status, 400); assert.strictEqual(r.body.error, "too_many_live_seasons");
  assert.deepStrictEqual(r.body.liveSeasons, ["2020", "2025"]); assert.strictEqual(r.calls.length, 0);
});

console.log("\n5. older league ids, a season not started, failures");
await check("2016 is read as UPS's 2016 league (27191) on MFL's api host, never 74598", async () => {
  const r = await call("/api/sos-adjusted-points?seasons=2016&week_min=15&week_max=16", FX20, { nowMs: FX25.nowMs });
  assert.strictEqual(r.status, 200);
  const own = r.calls.filter((u) => !/TYPE=nflSchedule/.test(u));
  assert.ok(own.length > 0 && own.every((u) => u.startsWith("https://api.myfantasyleague.com/2016/export?") && /[?&]L=27191&/.test(u)), own[0]);
  assert.ok(!r.calls.some((u) => /L=74598/.test(u)));
  assert.strictEqual(F.fpaLeagueId(2011), "40832"); assert.strictEqual(F.fpaLeagueId(2017), "74598"); assert.strictEqual(F.fpaLeagueId(2026), "74598");
});
await check("a season that hasn't started → stated per season, no MFL reads for it, never filled from another season", async () => {
  const r = await call("/api/sos-adjusted-points?seasons=2025,2027&week_min=15&week_max=17", FX25);
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.body.per_season["2027"], { state: "not_started", players: 0 });
  assert.ok(!r.calls.some((u) => /\/2027\//.test(u)));
  assert.deepStrictEqual(r.body.by_mfl, P25.body.by_mfl);
});
await check("a failed MFL read (Wk 16 scores) → 502 naming the season and week; no players, nothing partial", async () => {
  const r = await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=17", FX25, { over: { playerScores16: null } });
  assert.strictEqual(r.status, 502); assert.strictEqual(r.body.ok, false); assert.strictEqual(r.body.error, "mfl_unavailable");
  assert.strictEqual(r.body.season, "2025"); assert.deepStrictEqual(r.body.failedWeeks, [16]); assert.ok(!("by_mfl" in r.body));
});
await check("MFL answering Wk 16 with another week's scores → refused the same way", async () => {
  const r = await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=17", FX25, { over: { playerScores16: { playerScores: { week: "15", playerScore: FX25.scores[15] } } } });
  assert.strictEqual(r.status, 502); assert.deepStrictEqual(r.body.failedWeeks, [16]);
});
await check("no D1 (game-day teams unknown) → still answers from MFL's teams, says so, and isn't cached", async () => {
  const r = await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=17", FX25, { env: {} });
  assert.strictEqual(r.status, 200); assert.strictEqual(r.body.per_season["2025"].attribution.context, "none");
  assert.strictEqual(r.body.per_season["2025"].attribution.gameDay, 0);
});
await check("bad requests: no seasons, before 2011, week_max before week_min", async () => {
  for (const [u, e] of [["", "seasons required"], ["?seasons=2010", "no UPS scores before 2011"], ["?seasons=2025&week_min=10&week_max=9", "week_max is before week_min"]]) {
    const r = await call("/api/sos-adjusted-points" + u, FX25);
    assert.strictEqual(r.status, 400, u); assert.ok(String(r.body.error).startsWith(e), u + " → " + r.body.error); assert.strictEqual(r.calls.length, 0);
  }
});

await check("edge cache: a complete answer is stored (1 day for a finished season) under a key that names the engine and this view; an error, or an answer without game-day teams, never is", async () => {
  const puts = [];
  globalThis.caches = { default: { match: async () => null, put: async (req, res) => { if (/\/api\/sos-adjusted-points\?/.test(req.url)) puts.push({ key: req.url, cc: res.headers.get("Cache-Control") }); } } };
  try {
    await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=17&cb=123", FX25);
    assert.strictEqual(puts.length, 1);
    assert.ok(puts[0].key.startsWith("https://upsmfl-fpa.local/api/sos-adjusted-points?"), puts[0].key);
    assert.ok(puts[0].key.includes("&v=" + F.FPA_ENGINE_VERSION + "&s=" + F.SOS_VERSION) && !/cb=/.test(puts[0].key), puts[0].key);
    assert.strictEqual(puts[0].cc, "public, max-age=86400");
    await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=17", FX25, { over: { playerScores16: null } });
    await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=17", FX25, { env: {} });
    await call("/api/sos-adjusted-points?seasons=2020,2025&week_min=15&week_max=17", FX25);
    assert.strictEqual(puts.length, 1, "cached a failure, a refusal or an answer without game-day teams");
  } finally { delete globalThis.caches; }
});

console.log("\n6. never zero for unknown; the words");
await check("one-week window: a QB who was the only QB his opponent faced is unrated → Opp and Δ null, never 0", async () => {
  const r = await call("/api/sos-adjusted-points?seasons=2025&week_min=15&week_max=15", FX25);
  const qb = Object.values(r.body.by_mfl).filter((x) => x.pos === "QB");
  const unrated = qb.filter((x) => x.rated === 0);
  assert.ok(unrated.length >= 10, "unrated QBs " + unrated.length);
  for (const x of unrated) { assert.strictEqual(x.opp, null); assert.strictEqual(x.delta, null); assert.strictEqual(x.adj, null); assert.ok(x.raw != null); }
});
await check("the definition is descriptive: says it isn't a forecast; no easy / tough / inflated / understates", () => {
  assert.ok(/isn't a forecast/.test(F.SOS_DEFINITION));
  assert.ok(!/\beasy\b|\btough\b|inflat|understat|generous/i.test(F.SOS_DEFINITION));
});
await check("the worker routes /api/sos-adjusted-points to the engine; the src_weekly query and its 5-minute stat cache are gone", () => {
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  assert.ok(/import \{[^}]*\bhandleSosRequest\b[^}]*\} from "\.\/fpa_engine\.js"/.test(src));
  const i = src.indexOf('if (path === "/api/sos-adjusted-points" && request.method === "GET")');
  assert.ok(i > 0 && src.indexOf('if (path === "/api/sos-adjusted-points"', i + 10) < 0, "one handler");
  assert.ok(/return await handleSosRequest\(request, env, ctx, \{ jsonOut \}\)/.test(src.slice(i, i + 400)));
  assert.ok(!/w\.opponent AS def/.test(src), "the old generosity SQL is still there");
  const set = src.slice(src.indexOf("const STAT_CACHE_PATHS = new Set(["), src.indexOf("]);", src.indexOf("const STAT_CACHE_PATHS = new Set([")));
  assert.ok(!/sos-adjusted-points/.test(set));
});

console.log(fails ? "\n" + fails + " FAILED" : "\nall passed");
process.exit(fails ? 1 : 0);
