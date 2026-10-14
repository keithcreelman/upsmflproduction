// Stats → Sched on the shared Pts Agst engine (#1270): /api/fantasy-sos, run for real
// through handleFpaRequest on (a) every 2026 QB with the real 2026 schedule (Wks 1–17,
// read 2026-10-12 23:12 UTC, Monday night BUF @ LAR not yet played) and (b) a tiny
// 2017–2020-style league (16 weeks, playoffs 14–16). Expected values are worked out here
// from the raw MFL schedule, never by the engine under test.
//   node tests/sched_engine.test.mjs
import fs from "fs";
import assert from "assert";
import * as F from "../worker/src/fpa_engine.js";

const FIX = JSON.parse(fs.readFileSync(new URL("./fixtures/fpa_qb_2026_wk5_2026_10_12.json", import.meta.url), "utf8"));
let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };

// MFL as the fixture saw it (same stand-in as tests/fpa_engine.test.mjs). `league` lets a
// test give MFL's lastRegularSeasonWeek; Week 18 answers as Week 17, as MFL does.
function mflFrom(fx, over, league) {
  over = over || {};
  const calls = [];
  const fetchJson = async (u) => {
    calls.push(u);
    const x = new URL(u), T = x.searchParams.get("TYPE"), W = Number(x.searchParams.get("W"));
    if (over[T + W] !== undefined) return over[T + W];
    if (T === "league") return { league: { endWeek: String(fx.endWeek), ...(league || {}) } };
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
const jsonOut = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
async function call(url, fx, over, league) {
  const { fetchJson, calls } = mflFrom(fx, over, league);
  const fetchImpl = async (u, o) => { const j = await fetchJson(u); return { ok: j != null, status: j != null ? 200 : 500, method: (o && o.method) || "GET", json: async () => j }; };
  const r = await F.handleFpaRequest(new Request("https://w.test" + url), {}, null, { jsonOut, nowMs: fx.nowMs, lid: "74598", fetchImpl });
  return { status: r.status, body: await r.json(), calls };
}

// The schedule straight from MFL's raw replies: team → week → {opp, home} (absent = bye).
function rawSchedule(fx) {
  const out = {};
  for (let w = 1; w <= fx.endWeek; w++) for (const m of fx.sched[w] || []) {
    const [a, b] = m.team.map((t) => t.id);
    (out[a] = out[a] || {})[w] = { opp: b, home: m.team[0].isHome === "1" };
    (out[b] = out[b] || {})[w] = { opp: a, home: m.team[1].isHome === "1" };
  }
  return out;
}

console.log("1. the 2026 schedule (real MFL replies, 32 teams, Wks 1–17)");
const v2 = await call("/api/fantasy-sos?season=2026&v=2", FIX);
const RAW = rawSchedule(FIX);
await check("one answer: ok, view 'schedule', all 9 positions, engine stamp", () => {
  assert.strictEqual(v2.status, 200); assert.strictEqual(v2.body.ok, true); assert.strictEqual(v2.body.view, "schedule");
  assert.deepStrictEqual(v2.body.groups, F.FPA_GROUPS); assert.strictEqual(v2.body.engine, F.FPA_ENGINE_VERSION);
});
await check("every team, every league week 1–17 (never NFL Week 18): opponent and home/away as MFL lists them, byes marked", () => {
  const S = v2.body.schedule;
  assert.deepStrictEqual(Object.keys(S).sort(), Object.keys(RAW).sort());
  assert.strictEqual(Object.keys(S).length, 32);
  let byes = 0;
  for (const t in S) {
    assert.deepStrictEqual(S[t].map((x) => x.wk), Array.from({ length: 17 }, (_, i) => i + 1), t);
    for (const x of S[t]) {
      const r = RAW[t][x.wk];
      if (!r) { assert.strictEqual(x.bye, true, t + " wk " + x.wk); byes++; continue; }
      assert.strictEqual(x.opp, r.opp, t + " wk " + x.wk); assert.strictEqual(x.home, r.home, t + " wk " + x.wk);
    }
  }
  assert.strictEqual(byes, 32, "each team has exactly one bye in Wks 1–17 of 2026");
});
await check("game state: Wks 1–4 final; BUF @ LAR (Wk 5, Monday night) not played; Wk 6 scheduled", () => {
  const S = v2.body.schedule;
  assert.ok(S.KCC.slice(0, 4).every((x) => x.bye || x.status === "final"));
  assert.strictEqual(S.BUF[4].opp, "LAR"); assert.notStrictEqual(S.BUF[4].status, "final");
  assert.ok(S.BUF.slice(5).every((x) => x.bye || x.status === "scheduled"));
});
await check("playoff weeks come from MFL's setting (lastRegularSeasonWeek 14 → 15–17), and default to the last 3 weeks", async () => {
  const withSetting = await call("/api/fantasy-sos?season=2026&v=2", FIX, null, { lastRegularSeasonWeek: "14" });
  assert.deepStrictEqual(withSetting.body.playoffWeeks, [15, 16, 17]);
  assert.deepStrictEqual(v2.body.playoffWeeks, [15, 16, 17]);
});
await check("the ratings are exactly the Pts Agst list's (same engine, same window: through the latest completed game)", async () => {
  const pa = await call("/api/fantasy-points-against?YEAR=2026", FIX);
  assert.deepStrictEqual(v2.body.teams, pa.body.teams); assert.deepStrictEqual(v2.body.teamGames, pa.body.teamGames);
  assert.deepStrictEqual(v2.body.weeksUsed, pa.body.weeksUsed);
});
await check("league points per team-game per position = all defenses' points ÷ their final games", () => {
  let pts = 0, n = 0;
  for (const t in v2.body.teams) { const c = v2.body.teams[t].QB; if (c) { pts += c.raw.total; n += c.raw.games; } }
  assert.strictEqual(v2.body.league.perGame.QB, Math.round((pts / n) * 10) / 10);
});
await check("reads: 1 league + 1 players + 17 schedules + the weeks played so far (never W18)", () => {
  assert.ok(!v2.calls.some((u) => /W=18\b/.test(u)), "Week 18 read");
  assert.strictEqual(v2.calls.filter((u) => /TYPE=nflSchedule/.test(u)).length, 17);
});

console.log("\n2. the older (season, pos) shape for app builds that haven't updated");
const old = await call("/api/fantasy-sos?season=2026&pos=QB", FIX);
await check("same fields as before: ok, season, pos, projected false, ratingSeason, defsRated, 32 team rows", () => {
  assert.strictEqual(old.status, 200);
  assert.deepStrictEqual(Object.keys(old.body).sort(), ["defsRated", "ok", "pos", "projected", "ratingSeason", "season", "teams"]);
  assert.strictEqual(old.body.projected, false); assert.strictEqual(old.body.teams.length, 32);
});
await check("each cell is the opponent's Pts Agst vs-usual ratio and rank, in nflverse codes (LAR→LA, KCC→KC)", () => {
  const nfl = { GBP: "GB", KCC: "KC", NEP: "NE", NOS: "NO", SFO: "SF", TBB: "TB", LVR: "LV", JAC: "JAX", LAR: "LA" };
  const kc = old.body.teams.find((t) => t.team === "KC");
  for (const x of kc.weeks) {
    const r = RAW.KCC[x.wk];
    if (!r) { assert.deepStrictEqual([x.opp, x.ratio, x.rank], [null, null, null]); continue; }
    assert.strictEqual(x.opp, nfl[r.opp] || r.opp);
    const a = v2.body.teams[r.opp].QB.adj;
    assert.strictEqual(x.ratio, a ? a.ratio : null); assert.strictEqual(x.rank, a ? a.rank : null);
  }
});
await check("season average = mean over the 16 game weeks of 1–17 (no Week 18, no bye); playoff average over Wks 15–17; 3 decimals", () => {
  for (const t of old.body.teams) {
    const vals = t.weeks.filter((x) => x.ratio != null).map((x) => x.ratio);
    const pv = t.weeks.filter((x) => x.wk >= 15 && x.ratio != null).map((x) => x.ratio);
    const m = (v) => v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 1000) / 1000 : null;
    assert.strictEqual(t.weeks.length, 17); assert.strictEqual(t.seasonAvg, m(vals), t.team); assert.strictEqual(t.playoffAvg, m(pv), t.team);
  }
});

console.log("\n3. a 2017–2020-style league: 16 weeks, playoffs 14–16, MFL repeats Week 16 for later weeks");
const NOW = Date.parse("2020-12-30T12:00:00Z"), ko = (w) => String(Math.floor(Date.parse("2020-09-10T00:00:00Z") / 1000) + (w - 1) * 7 * 86400);
const g = (a, b, w) => ({ kickoff: ko(w), gameSecondsRemaining: "0", team: [{ id: a, isHome: "0" }, { id: b, isHome: "1" }] });
const OLD = { nowMs: NOW, endWeek: 16, players: [{ id: "1", name: "A, Qb", position: "QB", team: "AAA" }, { id: "2", name: "B, Qb", position: "QB", team: "BBB" }],
  sched: {}, scores: {} };
for (let w = 1; w <= 16; w++) { OLD.sched[w] = w === 8 ? [] : [g(w % 2 ? "AAA" : "BBB", w % 2 ? "BBB" : "AAA", w)]; OLD.scores[w] = w === 8 ? [] : [{ id: "1", score: "10" }, { id: "2", score: "20" }]; }
await check("16 league weeks only, playoffs 14–16 from lastRegularSeasonWeek 13, Wk 8 a bye", async () => {
  const r = await call("/api/fantasy-sos?season=2020&v=2", OLD, null, { lastRegularSeasonWeek: "13" });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body).slice(0, 200));
  assert.deepStrictEqual(r.body.playoffWeeks, [14, 15, 16]);
  assert.strictEqual(r.body.schedule.AAA.length, 16); assert.strictEqual(r.body.schedule.AAA[7].bye, true);
  assert.ok(!r.calls.some((u) => /W=1[78]\b/.test(u)), "read past Week 16");
});
await check("without MFL's setting, a stored 16-week season still gets playoffs 14–16 (the last 3 weeks)", async () => {
  const r = await call("/api/fantasy-sos?season=2020&v=2", OLD);
  assert.deepStrictEqual(r.body.playoffWeeks, [14, 15, 16]);
});

console.log("\n4. failures and bad input");
await check("one schedule week fails → 502 naming it (never a smaller grid or another season)", async () => {
  const r = await call("/api/fantasy-sos?season=2026&v=2", FIX, { nflSchedule7: null });
  assert.strictEqual(r.status, 502); assert.strictEqual(r.body.ok, false); assert.deepStrictEqual(r.body.failedWeeks, [7]);
});
await check("the older shape fails the same way (no silent 'projected' last season)", async () => {
  const r = await call("/api/fantasy-sos?season=2026&pos=QB", FIX, { players0: null });
  assert.strictEqual(r.status, 502);
});
await check("a bad position or season is a 400, with no MFL read", async () => {
  const a = await call("/api/fantasy-sos?season=2026&pos=XX", FIX), b = await call("/api/fantasy-sos?season=20x6&v=2", FIX);
  assert.strictEqual(a.status, 400); assert.strictEqual(b.status, 400); assert.strictEqual(a.calls.length + b.calls.length, 0);
});
await check("a season that hasn't started answers plainly, with no MFL read", async () => {
  const a = await call("/api/fantasy-sos?season=2027&v=2", FIX), b = await call("/api/fantasy-sos?season=2027&pos=RB", FIX);
  assert.strictEqual(a.body.season.state, "not_started"); assert.deepStrictEqual(a.body.schedule, {});
  assert.deepStrictEqual(b.body.teams, []); assert.strictEqual(a.calls.length + b.calls.length, 0);
});
await check("every outbound call is a GET", async () => {
  const methods = [];
  const { fetchJson } = mflFrom(FIX);
  const fetchImpl = async (u, o) => { methods.push((o && o.method) || "GET"); const j = await fetchJson(u); return { ok: true, json: async () => j }; };
  await F.handleFpaRequest(new Request("https://w.test/api/fantasy-sos?season=2026&v=2"), {}, null, { jsonOut, nowMs: FIX.nowMs, lid: "74598", fetchImpl });
  assert.ok(methods.length > 0 && methods.every((m) => m === "GET"), methods.join());
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
