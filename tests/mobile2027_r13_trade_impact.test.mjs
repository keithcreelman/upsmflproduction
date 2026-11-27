// UPS 2027 Trades: Lineup impact (Keith 2026-11-26: "the points changing hands … improvement/decrease in projected starting lineup points week
// over week and in total … top of class"). lib/tradeimpact.js against the recorded league and made-up projections.
//   node tests/mobile2027_r13_trade_impact.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const M = require(path.join(SRC, "lib/model.js")), D = require(path.join(SRC, "lib/data.js")), RC = require(path.join(SRC, "lib/recorded.js"));
const V = require(path.join(SRC, "lib/views.js")), T = require(path.join(SRC, "lib/trades.js")), I = require(path.join(SRC, "lib/tradeimpact.js")), R = require(path.join(SRC, "lib/roster.js"));
const ld = (f) => { const c = vm.createContext({}); c.window = c; vm.runInContext(fs.readFileSync(path.join(SRC, f), "utf8"), c); return JSON.parse(JSON.stringify(c.UPS2027_RECORDED || c.UPS2027_CONFIG)); };
const BUNDLE = ld("recorded_data.js"), CFG = ld("config.js");
const text = (h) => h.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

async function fresh(me) {
  const L = D.createLoader(CFG, RC.createFetch(BUNDLE)); const core = await L.loadCore();
  const model = M.build(core.roster.data, core.league.data, core.weekly.data, core.week, 2026);
  const S = { model, load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: me, tab: "league", sub: "roster", view: "lineup", open: {}, flags: {}, profile: null, sheet: null,
    skin: "system", vib: "1", build: "test", requestLog: [], wk: null, live: null, pf: { s: "pos", open: {}, res: {}, q: "", pos: "all", xt: false, xpos: "all", note: null },
    ct: { f: "all", l: "all", s: "exp", y: 0, d: 1, open: {}, hist: {}, bd: false, cat: {}, ns: false }, requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, sample: { on: false },
    plans: {}, submitMode: true, me: { signedIn: true, fid: me }, intel: { status: null, mu: {}, wk: {}, scores: {}, sched: {}, players: null, cal: null, proj: {}, reread: {} } };
  S.tradesUi = T; S.tr = Object.assign(T.fresh(), { league: "25625", season: "2026" });
  S.tr.lock = { state: "ok", data: { state: "upcoming", start_unix: Date.now() / 1000 + 86400 * 7, label: "Thu" } };
  return S;
}
const team = (S, f) => S.model.teams.find((x) => x.id === f);
const active = (S, f) => team(S, f).players.filter((p) => p.status === "active");

test("best(): fixed slots take the best at their position, flex by exact search (SFX may take a QB, OFX may not)", () => {
  const pool = [{ id: "q1", pos: "QB", v: 25 }, { id: "q2", pos: "QB", v: 22 }, { id: "r1", pos: "RB", v: 15 }, { id: "r2", pos: "RB", v: 14 }, { id: "r3", pos: "RB", v: 13 },
    { id: "w1", pos: "WR", v: 16 }, { id: "w2", pos: "WR", v: 12 }, { id: "w3", pos: "WR", v: 11 }, { id: "t1", pos: "TE", v: 9 }, { id: "t2", pos: "TE", v: 8 }];
  const b = I.best(pool);
  t.ok(b.ids.includes("q2"), "the second QB goes to Superflex"); t.ok(b.ids.includes("r3") && b.ids.includes("w3"), "the two offensive flex spots take the next best RB/WR/TE");
  t.ok(!b.ids.includes("t2")); t.equal(Math.round(b.total * 10) / 10, 25 + 22 + 15 + 14 + 16 + 12 + 9 + 13 + 11);
  t.equal(R.SLOTS.length, 18);
});

test("compute(): each team's best projected starters before vs after, week by week and in total; players changing hands with season, PPG, next and projected", async () => {
  const S = await fresh("0006"), me = "0006", other = "0002";
  const W = I.weeks(S); t.equal(W[0], parseInt(S.model.week, 10)); t.equal(W[W.length - 1], 17);
  const mine = active(S, me), theirs = active(S, other);
  const give = mine.find((p) => p.pos === "WR"), get = theirs.find((p) => p.pos === "WR");
  const proj = {}; W.forEach((w, i) => { proj[w] = {}; mine.concat(theirs).forEach((p) => { proj[w][p.id] = 5; }); proj[w][get.id] = 30; proj[w][give.id] = i === 0 ? 40 : 1; });
  const X = I.compute(S, [me, other], [{ pid: String(get.id), from: other, to: me }, { pid: String(give.id), from: me, to: other }], { proj, ytd: { [get.id]: 120.5 }, avg: { [get.id]: 12.05 } });
  const A = X.teams[me], B = X.teams[other];
  t.equal(A.rows.length, W.length); t.equal(A.weeksKnown, W.length);
  t.ok(A.rows[0].delta < 0, "week 1: my outgoing WR (40) was worth more than the incoming one (30)"); t.ok(A.rows[1].delta > 0, "later weeks: the incoming WR helps");
  t.equal(Math.round(A.rows[1].delta * 10) / 10, 25, "30 replaces a 5-point starter");
  t.equal(Math.round(A.delta * 10) / 10, Math.round(A.rows.reduce((n, r) => n + r.delta, 0) * 10) / 10, "the total is the sum of the weeks");
  t.equal(Math.round((A.delta + B.delta) * 10) / 10, Math.round((A.after - A.before + B.after - B.before) * 10) / 10);
  t.ok(A.lineup.some((x) => x.pid === String(get.id) && x.inn === W.length), "the incoming WR starts every week");
  const P = X.players.find((p) => p.pid === String(get.id));
  t.equal(P.ytd, 120.5); t.equal(P.avg, 12.05); t.equal(P.next, 30); t.equal(P.ros, 30 * W.length); t.equal(X.players[0].pid, String(get.id), "sorted by projected points");
  const partial = I.compute(S, [me], [], { proj: { [W[0]]: proj[W[0]] } });
  t.equal(partial.complete, false); t.equal(partial.teams[me].weeksKnown, 1); t.equal(partial.teams[me].rows[1].delta, null, "a week with no projections is shown as —, never 0");
});

test("Review: a Lineup impact summary per team (per week and total); tap → the drill-down with team chips, week-by-week bars, lineup changes and the points table", async () => {
  const S = await fresh("0006"), me = "0006", other = "0002";
  const W = I.weeks(S), get = active(S, other).find((p) => p.pos === "RB"), give = active(S, me).find((p) => p.pos === "RB");
  const proj = {}; W.forEach((w) => { proj[w] = { [get.id]: 22, [give.id]: 6 }; });
  S.tr.pts = { state: "ok", proj, ytd: {}, avg: {} };
  const o = { trade_id: "9", from_franchise_id: other, to_franchise_id: me, will_give_up: String(get.id), will_receive: String(give.id) };
  S.tr.offers = { state: "ok", inc: [o], out: [] }; S.tr.view = "review"; S.tr.rv = { tid: "9", offer: o, state: "loading" };
  let h = V.app(S);
  t.match(h, /data-act="trimpact" data-v="0006"/); t.match(text(h), /Lineup impact Details › You \+[0-9.]+\/wk \+[0-9.]+ in [0-9]+ wks?/); t.match(h, /class="impv up"/);
  S.tr.view = "impact"; S.tr.impFrom = "review"; S.tr.impTeam = me; h = V.app(S);
  t.match(h, /data-act="trimpback">‹ Review/); t.match(h, /class="impbig up"/); t.match(text(h), /Week by week/); t.equal((h.match(/class="iwk"/g) || []).length, W.length);
  t.match(h, /class="ifill up w10"/, "the biggest week fills its half"); t.match(text(h), /Lineup changes/); t.match(text(h), /Points changing hands/);
  t.match(h, /data-act="trimpteam" data-v="0002"/); S.tr.impTeam = other; t.match(V.app(S), /class="impbig dn"/, "the other side of the same trade goes down");
  S.tr.pts = { state: "loading" }; S.tr.view = "review"; t.match(text(V.app(S)), /Lineup impact Loading projections…/);
  S.tr.pts = { state: "error" }; t.match(V.app(S), /data-act="trpts"/);
});

test("3-team: the impact covers all three teams from the worker's movements", async () => {
  const S = await fresh("0006"), [a, b, c] = ["0006", "0002", "0003"];
  const pb = active(S, b)[0], pc = active(S, c)[0];
  const tr = { id: "t", status: "collecting", participants: [{ fid: a, slot: "initiator" }, { fid: b, slot: "team_b", state: "pending" }, { fid: c, slot: "team_c", state: "pending" }],
    movements: [{ from: { fid: b }, to: { fid: a }, assets: [{ kind: "player", player_id: String(pb.id), token: "P_" + pb.id }] }, { from: { fid: c }, to: { fid: b }, assets: [{ kind: "player", player_id: String(pc.id) }, { kind: "pick", pick: { year: 2027, round: 1, original_fid: c } }] }] };
  const mv = T.movesOf3(tr);
  t.deepEqual(mv.fids, [a, b, c]); t.deepEqual(mv.moves, [{ pid: String(pb.id), from: b, to: a }, { pid: String(pc.id), from: c, to: b }]);
  const W = I.weeks(S), proj = {}; W.forEach((w) => { proj[w] = { [pb.id]: 20, [pc.id]: 20 }; });
  const X = I.compute(S, mv.fids, mv.moves, { proj });
  t.deepEqual(Object.keys(X.teams).sort(), [a, b, c].sort());
});

await run("mobile2027_r13_trade_impact");
