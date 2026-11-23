// UPS 2027 beta, R7: positional season stat ranks in the Breakdown (lib/statranks.js and its use in lib/boxlog.js / lib/breakdown.js).
//   node tests/mobile2027_r7_statranks.test.mjs
//
// Offline. Pools are built in the DOCUMENTED /api/position-season-stats shape (worker/src/position_season_stats.js on claude/perf-data-backend, #1515):
// small synthetic pools for the rules, and one pool whose JSN entry is summed from his captured PUBLIC /api/player-weekly-box answer
// (tests/fixtures/mobile2027/r6_box.json) the way the route sums the same rows. No Worker answer of that route has been captured.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const SR = require(path.join(SRC, "lib/statranks.js")), BL = require(path.join(SRC, "lib/boxlog.js")), BD = require(path.join(SRC, "lib/breakdown.js"));
const FXB = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r6_box.json"), "utf8"));
const CAL = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/calendar_2026.json"), "utf8"));
const SCHED_DAYS = (() => { const out = {}; FXB.schedule.fullNflSchedule.nflSchedule.forEach((e) => { out[e.week] = e.matchup.map((m) => ({ kickoff: m.kickoff, secs: m.gameSecondsRemaining, teams: m.team.map((x) => ({ id: x.id, isHome: x.isHome, score: x.score })) })); }); return out; })();
const BYE = Object.fromEntries(CAL.byes.nflByeWeeks.team.map((x) => [x.id, Number(x.bye_week)]));

const pool = (group, players, over) => Object.assign({ ok: true, season: 2026, through: 10, group, data_max_week: 10, unmapped_box_players: 0, ambiguous_ids: 0, fields: [], players }, over || {});
const E = (id, s, extra) => Object.assign({ mfl_id: String(id), gsis_id: "00-" + id, games: 9, snap_games: 9, s }, extra || {});
const rank = (j, id, key, ctx) => SR.rankOf(SR.checkPool(j, 2026, 10, j.group), id, key, Object.assign({ group: j.group, G: 9 }, ctx || {}));

test("the threshold table is ONE config object, marked proposed, and every bar names its denominator", () => {
  t.equal(SR.RATE_BARS.status, "proposed, pending Keith's approval");
  Object.keys(SR.RATE_BARS.bars).forEach((id) => {
    const b = SR.RATE_BARS.bars[id];
    if (b.withheld) { t.equal(b.den, null, id + ": withheld has no denominator"); return; }
    t.ok(typeof b.den === "string" && b.den.length > 3, id + ": denominator named");
    t.ok(SR.METRICS[id] && SR.METRICS[id].kind !== "count", id + ": a rate or fewer-is-better metric");
  });
  // every rate / fewer-is-better metric has a bar (no rank without an approved-shape minimum)
  Object.keys(SR.METRICS).forEach((id) => { if (SR.METRICS[id].kind !== "count") t.ok(SR.RATE_BARS.bars[id], id + " has a bar"); });
  t.ok(/pass-rush snap/.test(SR.RATE_BARS.bars.pressure_rate.withheld), "IDP pressure rate withheld with its reason");
});

test("ties share a rank (1 + strictly better): kickers at 100% are all K1, the next one is K3", () => {
  const j = pool("PK", [E(1, { xp_made: 20, xp_att: 20 }), E(2, { xp_made: 25, xp_att: 25 }), E(3, { xp_made: 19, xp_att: 20 }), E(4, { xp_made: 18, xp_att: 20 })]);
  t.equal(rank(j, 1, "xp_pct").text, "K1"); t.equal(rank(j, 2, "xp_pct").text, "K1"); t.equal(rank(j, 3, "xp_pct").text, "K3"); t.equal(rank(j, 4, "xp_pct").text, "K4");
  // exact comparison of sums (no float drift): 1/3 and 2/6 tie
  const k = pool("PK", [E(1, { fg_made: 10, fg_att: 30 }), E(2, { fg_made: 20, fg_att: 60 })]);
  t.equal(rank(k, 1, "fg_pct").text, "K1"); t.equal(rank(k, 2, "fg_pct").text, "K1");
  // totals tie too
  const w = pool("WR", [E(1, { targets: 50 }), E(2, { targets: 50 }), E(3, { targets: 60 })]);
  t.equal(rank(w, 1, "targets").text, "WR2"); t.equal(rank(w, 2, "targets").text, "WR2"); t.equal(rank(w, 3, "targets").text, "WR1");
});

test("direction: fewer interceptions rank higher, only among QBs over the attempts bar; more yards rank higher", () => {
  const j = pool("QB", [E(1, { pass_ints: 2, pass_att: 200, pass_yds: 1500 }), E(2, { pass_ints: 5, pass_att: 300, pass_yds: 2500 }), E(3, { pass_ints: 0, pass_att: 50, pass_yds: 300 })]);
  t.equal(rank(j, 1, "pass_ints").text, "QB1"); t.equal(rank(j, 2, "pass_ints").text, "QB2");
  const r3 = rank(j, 3, "pass_ints"); t.equal(r3.text, "—"); t.ok(/135 pass attempts or more; he has 50/.test(r3.why), r3.why);
  t.equal(rank(j, 2, "pass_yds").text, "QB1"); t.equal(rank(j, 3, "pass_yds").text, "QB3");
  // sacks taken: fewer is better on pass attempts + sacks (17 per team game)
  const s = pool("QB", [E(1, { pass_sacks: 10, pass_att: 150, pass_sack_yds: -70 }), E(2, { pass_sacks: 20, pass_att: 300, pass_sack_yds: -130 })]);
  t.equal(rank(s, 1, "sacks_taken").text, "QB1"); t.equal(rank(s, 1, "sack_yds").text, "QB1"); t.equal(rank(s, 2, "sack_yds").text, "QB2");
});

test("thresholds: metric-specific denominators, scaled by the fewest team games through W*", () => {
  // WR catch rate: 3 targets per team game, G = 9 -> 27 targets. Y/R: 2 receptions per game -> 18 receptions.
  const j = pool("WR", [E(1, { receptions: 20, targets: 26, rec_yds: 300 }), E(2, { receptions: 17, targets: 27, rec_yds: 250 }), E(3, { receptions: 18, targets: 40, rec_yds: 200 })]);
  t.equal(rank(j, 1, "catch_rate").text, "—", "26 targets is under 27");
  t.equal(rank(j, 2, "catch_rate").text, "WR1", "17/27 = 63%"); t.equal(rank(j, 3, "catch_rate").text, "WR2", "18/40 = 45%");
  t.equal(rank(j, 1, "y_rec").text, "WR1", "Y/R qualifies on receptions (20 >= 18), not on targets");
  t.equal(rank(j, 2, "y_rec").text, "—", "17 receptions is under 18");
  // the same pool at G = 10 moves the bar to 30 targets
  t.equal(rank(j, 2, "catch_rate", { G: 10 }).text, "—");
  // K bands: attempts in THAT band
  const k = pool("PK", [E(1, { fg_made_50_59: 2, fg_att_50_59: 3, fg_made: 10, fg_att: 12 }), E(2, { fg_made_50_59: 1, fg_att_50_59: 2, fg_made: 15, fg_att: 15 })]);
  t.equal(rank(k, 1, "fg_pct_50_59").text, "K1"); t.equal(rank(k, 2, "fg_pct_50_59").text, "—", "2 attempts is under 0.3 x 9 = 2.7");
  // team games: from the schedule (fewest games any club played through W*), else from byes
  const G10 = SR.teamGames(SCHED_DAYS, null, 10), Gb = SR.teamGames(null, BYE, 10);
  t.equal(G10, 9, "a club with its bye by Week 10 has played 9"); t.equal(Gb, 9);
  t.equal(SR.teamGames(SCHED_DAYS, null, 4), Math.min(...Object.values(BYE).map((b) => 4 - (b <= 4 ? 1 : 0))));
  t.equal(SR.teamGames(null, null, 10), null);
  const r = rank(j, 3, "catch_rate", { G: null }); t.equal(r.text, "—"); t.ok(/Team games/.test(r.why));
  t.equal(rank(j, 3, "targets", { G: null }).text, "WR1", "totals do not need team games");
});

test("missing denominators withhold the rate rank; ties never do; pressure rate is withheld with its reason", () => {
  const j = pool("WR", [E(1, { off_snaps: 500, team_off_snaps: 600 }), E(2, {}, { snap_games: 0 }), E(3, { off_snaps: 550, team_off_snaps: 600 })]);
  t.equal(rank(j, 1, "snap_share").text, "WR2"); t.equal(rank(j, 3, "snap_share").text, "WR1");
  t.equal(rank(j, 2, "snap_share").text, "—", "no snap row: no share");
  const d = pool("DL", [E(1, { def_snaps: 300, team_def_snaps: 600, def_tackles_total: 20 })]);
  const pr = rank(d, 1, "pressure_rate"); t.equal(pr.text, "—"); t.ok(/pass-rush snap/.test(pr.why));
  // his own denominator incomplete and under the bar: withheld for that reason, not "below the bar"
  const q = pool("QB", [E(1, { pass_cmp: 80, pass_att: 120 }, { cov: { pass_att: 8, pass_cmp: 8 } }), E(2, { pass_cmp: 100, pass_att: 160 })]);
  const r1 = rank(q, 1, "cmp_pct"); t.equal(r1.text, "—"); t.ok(/missing some games/.test(r1.why), r1.why);
  // a rate with zero attempts is no rate (not 0%)
  const z = pool("PK", [E(1, { fg_made_60plus: 0, fg_att_60plus: 0 })]);
  t.equal(rank(z, 1, "fg_pct_60plus").text, "—");
  // ties at 100% for the whole qualifying pool: still ranked, all K1
  const all = pool("PK", [1, 2, 3, 4, 5].map((i) => E(i, { xp_made: 20 + i, xp_att: 20 + i })));
  [1, 2, 3, 4, 5].forEach((i) => t.equal(rank(all, i, "xp_pct").text, "K1"));
});

test("unplaced competitors make a range only where they could be ahead", () => {
  // targets (more is better): #2 has a partial total BELOW him -> unplaced; #3 partial ABOVE -> already ahead; #4 missing -> unplaced
  const j = pool("WR", [E(1, { targets: 80 }), E(2, { targets: 60 }, { cov: { targets: 7 } }), E(3, { targets: 90 }, { cov: { targets: 8 } }), E(4, {}), E(5, { targets: 70 })]);
  const r = rank(j, 1, "targets"); t.equal(r.text, "WR2–4"); t.equal(r.lo, 2); t.equal(r.hi, 4);
  t.equal(rank(pool("WR", [E(1, { targets: 80 }), E(3, { targets: 90 }, { cov: { targets: 8 } })]), 1, "targets").text, "WR2", "a partial total already ahead is ahead, no range");
  // fewer-is-better: a partial count already above his stays behind; one below could catch up -> unplaced
  const f = pool("RB", [E(1, { rush_fumbles_lost: 1, rec_fumbles_lost: 0, rush_att: 100, receptions: 20 }),
    E(2, { rush_fumbles_lost: 3, rec_fumbles_lost: 0, rush_att: 100, receptions: 20 }, { cov: { rush_fumbles_lost: 8 } }),
    E(3, { rush_fumbles_lost: 0, rec_fumbles_lost: 0, rush_att: 100, receptions: 20 }, { cov: { rush_fumbles_lost: 8 } })]);
  t.equal(rank(f, 1, "fl").text, "RB1–2");
  // rates: a competitor with a partial denominator under the bar might reach it -> unplaced; a full one under the bar is out
  const c = pool("WR", [E(1, { receptions: 30, targets: 40 }), E(2, { receptions: 20, targets: 20 }, { cov: { targets: 6, receptions: 6 } }), E(3, { receptions: 20, targets: 20 })]);
  t.equal(rank(c, 1, "catch_rate").text, "WR1–2");
  // his own figure incomplete: no rank
  const o = rank(pool("WR", [E(1, { targets: 80 }, { cov: { targets: 9 } })]), 1, "targets"); t.equal(o.text, "—"); t.ok(/missing some games/.test(o.why));
});

test("the pool must be the right answer; his figure must match the season table", () => {
  const good = pool("WR", [E(1, { targets: 10 })]);
  t.equal(SR.checkPool(good, 2026, 10, "WR").ok, true);
  t.equal(SR.checkPool(good, 2026, 9, "WR").ok, false, "other week");
  t.equal(SR.checkPool(good, 2025, 10, "WR").ok, false, "other season");
  t.equal(SR.checkPool(good, 2026, 10, "TE").ok, false, "other group");
  t.equal(SR.checkPool(pool("WR", [E(1, {}), E(1, {})]), 2026, 10, "WR").ok, false, "a player twice");
  t.equal(SR.checkPool({ ok: false }, 2026, 10, "WR").ok, false);
  const r = rank(good, 1, "targets", { raw: 11 }); t.equal(r.text, "—"); t.ok(/disagree/.test(r.why));
  t.equal(rank(good, 1, "targets", { raw: 10 }).text, "WR1");
  t.equal(rank(good, 99, "targets").text, "—", "not in the pool");
  t.equal(SR.groupOf("DE"), "DL"); t.equal(SR.groupOf("S"), "DB"); t.equal(SR.groupOf("PK"), "PK"); t.equal(SR.prefix("PK"), "K"); t.equal(SR.prefix("PN"), "P");
});

// ---- the Breakdown: JSN's season table with ranks from a pool in the route's shape ----
// His pool entry is summed from his captured weekly-box answer through Week 10 (box, red zone, snaps), as the route sums the same rows.
function entryFromBox(a, through) {
  const s = {}, cov = {}, n = {}; let games = 0, snapGames = 0;
  const addv = (k, v) => { if (v == null || !Number.isFinite(Number(v))) return; s[k] = (s[k] || 0) + Number(v); n[k] = (n[k] || 0) + 1; };
  a.weeks.filter((w) => w.week <= through).forEach((w) => {
    if (w.box) { games++; Object.keys(w.box).forEach((k) => { if (typeof w.box[k] === "number") addv(k, w.box[k]); }); }
    if (w.redzone) Object.keys(w.redzone).forEach((k) => addv(k, w.redzone[k]));
    if (w.snaps) { snapGames++; addv("off_snaps", w.snaps.off); addv("def_snaps", w.snaps.def); addv("st_snaps", w.snaps.st); addv("team_off_snaps", w.snaps.team_off); addv("team_def_snaps", w.snaps.team_def); }
  });
  return { mfl_id: String(a.mfl_id), gsis_id: a.gsis_id, games, snap_games: snapGames, s };
}
function jsnState(pss) {
  const box = BL.parseBox(FXB.box["16185"], "16185", 2026);
  return { model: { season: 2026, week: 11 }, intel: { box: { 16185: { state: "ok", data: box } }, cal: { state: "ok", data: { days: SCHED_DAYS, byeOf: BYE } }, pss } };
}
test("Breakdown: JSN's season rows carry WR ranks from the pool; rates qualify on their own denominators; loading and absent states", () => {
  const me = entryFromBox(FXB.box["16185"], 10);
  // competitors (synthetic): one ahead on targets, one behind; one ahead on catch rate but under the 27-target bar
  const j = pool("WR", [me, E(2, { targets: me.s.targets + 5, receptions: 10, rec_yds: 100, rec_tds: 0 }), E(3, { targets: 5, receptions: 5, rec_yds: 40, rec_tds: 0 })]);
  const inp = { pos: "WR", season: 2026, cutoff: 10, lineupWeek: 11, currentClub: "SEA", box: BL.parseBox(FXB.box["16185"], "16185", 2026), scores: {}, scoreState: {}, games: BL.gameIndex(SCHED_DAYS, 2026), byeOf: BYE, weekRank: null };
  const R = BL.rollup(inp, BL.rows(inp));
  const S = jsnState({ "2026|10|WR": { state: "ok", data: j } });
  const rk = BD.statRanker(S, { id: "16185", pos: "WR" }, { state: "ok", week: 10 }, R);
  const it = (label) => { for (const s of R.sections) for (const i of s.items) if (i.label === label) return i; return null; };
  t.equal(it("Targets").key, "targets"); t.equal(it("Catch rate").key, "catch_rate"); t.equal(it("Snap share").key, "snap_share");
  t.equal(rk(it("Targets")).text, "WR2");
  t.equal(rk(it("Receiving yards")).text, "WR1");
  t.equal(rk(it("Catch rate")).text, "WR1", "#3 (100% on 5 targets) is under the bar");
  t.equal(rk(it("Routes")), null, "no key, no rank");
  // the rendered panel would need the whole state; the ranker is what the season table reads. Loading / absent / failed reads:
  t.equal(BD.statRanker(jsnState({ "2026|10|WR": { state: "loading" } }), { id: "16185", pos: "WR" }, { state: "ok", week: 10 }, R)(it("Targets")).text, "…");
  t.equal(BD.statRanker(jsnState({ "2026|10|WR": { state: "absent" } }), { id: "16185", pos: "WR" }, { state: "ok", week: 10 }, R)(it("Targets")).text, "—");
  t.equal(BD.statRanker(jsnState({ "2026|10|WR": { state: "error" } }), { id: "16185", pos: "WR" }, { state: "ok", week: 10 }, R)(it("Targets")).text, "—");
  t.equal(BD.statRanker(jsnState({}), { id: "16185", pos: "WR" }, { state: "ok", week: 10 }, R)(it("Targets")), null, "not asked for: no rank");
  // a pool for another week is refused (no ranks)
  t.equal(BD.statRanker(jsnState({ "2026|10|WR": { state: "ok", data: pool("WR", [me], { through: 9 }) } }), { id: "16185", pos: "WR" }, { state: "ok", week: 10 }, R)(it("Targets")).text, "—");
  t.equal(BD.statKey({ model: { season: 2026 } }, { week: 10 }, "WR"), "2026|10|WR");
});

await run("mobile2027_r7_statranks");
