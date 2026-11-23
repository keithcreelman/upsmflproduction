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
  // R7b final: no qualifier minimum, no distance-band accuracy ranks
  t.equal(SR.RATE_BARS.minQualifiers, undefined);
  ["fg_pct_0_39", "fg_pct_40_49", "fg_pct_50_59", "fg_pct_60plus"].forEach((id) => { t.equal(SR.RATE_BARS.bars[id], undefined, id + ": no accuracy bar"); t.equal(SR.METRICS[id], undefined, id + ": no accuracy rank"); });
  ["fg_att_0_39", "fg_att_40_49", "fg_att_50_59", "fg_att_60plus"].forEach((id) => t.equal(SR.METRICS[id].kind, "count", id + ": bands rank on attempts"));
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

test("direction (R8): a lower INT rate ranks higher, only among QBs over the attempts bar; the INT count has no rank; more yards rank higher", () => {
  const j = pool("QB", [E(1, { pass_ints: 2, pass_att: 200, pass_yds: 1500 }), E(2, { pass_ints: 5, pass_att: 300, pass_yds: 2500 }), E(3, { pass_ints: 0, pass_att: 50, pass_yds: 300 }),
    E(4, { pass_ints: 3, pass_att: 300, pass_yds: 2000 }), E(5, { pass_ints: 6, pass_att: 200, pass_yds: 1400 }), E(6, { pass_ints: 0, pass_att: 0, pass_yds: 0 })]);
  t.equal(rank(j, 1, "int_rate").text, "QB1"); t.equal(rank(j, 4, "int_rate").text, "QB1", "2/200 and 3/300 are the same rate (compared exactly): tied");
  t.equal(rank(j, 2, "int_rate").text, "QB3"); t.equal(rank(j, 5, "int_rate").text, "QB4", "fewer per attempt is better, not fewer in total");
  const r3 = rank(j, 3, "int_rate"); t.equal(r3.text, "—"); t.ok(/135 pass attempts or more; he has 50/.test(r3.why), "below the bar (15 x 9 team games): no rank, and 0 INT in 50 attempts never outranks the qualifiers: " + r3.why);
  t.equal(rank(j, 6, "int_rate").text, "—"); t.equal(rank(j, 6, "int_rate").why, "No attempts, so no rate.");
  t.equal(rank(j, 1, "int_rate", { raw: 2 / 200 }).text, "QB1", "his figure matches the season table's");
  t.equal(rank(j, 1, "pass_ints").text, "—", "the INT count itself is not ranked"); t.equal(SR.METRICS.pass_ints, undefined);
  t.deepEqual(SR.RATE_BARS.bars.int_rate, { den: "pass attempts", perGame: { QB: 15 } }, "proposed: the pass-attempt bar Completion % uses"); t.equal(SR.barOf("int_rate", "QB", 9), 135);
  t.equal(SR.RATE_BARS.bars.fl, undefined); t.equal(SR.RATE_BARS.bars.fl_qb, undefined); t.equal(SR.METRICS.fl, undefined, "R8: no fumbles-lost metric"); t.doesNotMatch(SR.helpText(), /fumble/i);
  t.equal(rank(j, 2, "pass_att").text, "QB1", "attempts rank as a count");
  t.equal(rank(j, 2, "pass_yds").text, "QB1"); t.equal(rank(j, 3, "pass_yds").text, "QB5");
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
  // overall FG rate keeps its own sample minimum (1 attempt per team game -> 9)
  const k = pool("PK", [E(1, { fg_made: 7, fg_att: 8 }), E(2, { fg_made: 9, fg_att: 12 })]);
  t.equal(rank(k, 2, "fg_pct").text, "K1"); const k1 = rank(k, 1, "fg_pct"); t.equal(k1.text, "—"); t.ok(/Ranked at 9 field goal attempts or more; he has 8/.test(k1.why), k1.why);
  // floors: the bar is max(per game x G, floor); only WR/TE yards per carry have one
  t.equal(SR.barOf("ypc", "WR", 9), 8); t.equal(SR.barOf("ypc", "TE", 9), 5); t.equal(SR.barOf("ypc", "RB", 9), 45); t.equal(SR.barOf("ypc", "WR", 20), 10, "per game wins when larger");
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
  const z = pool("PK", [E(1, { xp_made: 0, xp_att: 0 })]);
  t.equal(rank(z, 1, "xp_pct").text, "—");
  // ties at 100% for the whole qualifying pool: still ranked, all K1
  const all = pool("PK", [1, 2, 3, 4, 5].map((i) => E(i, { xp_made: 20 + i, xp_att: 20 + i })));
  [1, 2, 3, 4, 5].forEach((i) => t.equal(rank(all, i, "xp_pct").text, "K1"));
});

test("R7b final: a counting stat is exact or —; rates may show a narrow range; missing is never zero", () => {
  // targets (more is better): #2 partial BELOW him -> could catch up; #3 partial ABOVE -> already ahead; #4 missing -> unknown
  const j = pool("WR", [E(1, { targets: 80 }), E(2, { targets: 60 }, { cov: { targets: 7 } }), E(3, { targets: 90 }, { cov: { targets: 8 } }), E(4, {}), E(5, { targets: 70 })]);
  const r = rank(j, 1, "targets"); t.equal(r.text, "—", "no range for a total"); t.equal(r.lo, 2); t.equal(r.hi, 4); t.equal(r.coverage, true);
  t.ok(/2 players' figures are incomplete, so he could rank anywhere from WR2 to WR4/.test(r.why), r.why);
  t.equal(rank(pool("WR", [E(1, { targets: 80 }), E(3, { targets: 90 }, { cov: { targets: 8 } })]), 1, "targets").text, "WR2", "a partial total already ahead is ahead: exact");
  // complete data: exact, with ties
  t.equal(rank(pool("WR", [E(1, { targets: 80 }), E(2, { targets: 80 }), E(3, { targets: 90 })]), 1, "targets").text, "WR2");
  // a wide gap: still "—", never a range like "WR6–88"
  const wide = pool("WR", [E(1, { targets_i20: 8 }), ...[2, 3, 4, 8, 10, 11].map((i) => E(i, {})), E(5, { targets_i20: 9 }), E(6, { targets_i20: 1 })]);
  const rw = rank(wide, 1, "targets_i20"); t.equal(rw.text, "—"); t.equal(rw.lo, 2); t.equal(rw.hi, 8);
  // kicking distance bands rank on attempts (a count), not accuracy; no minimum
  const kb = pool("PK", [E(1, { fg_made_50_59: 4, fg_att_50_59: 6 }), E(2, { fg_made_50_59: 3, fg_att_50_59: 3 }), E(3, { fg_made_50_59: 1, fg_att_50_59: 6 })]);
  t.equal(rank(kb, 1, "fg_att_50_59").text, "K1"); t.equal(rank(kb, 3, "fg_att_50_59").text, "K1"); t.equal(rank(kb, 2, "fg_att_50_59").text, "K3", "3/3 is not ranked on accuracy");
  // fewer-is-better total: a partial count already above his stays behind; one below could catch up -> narrow range kept
  const f = pool("QB", [E(1, { pass_sacks: 10, pass_att: 300 }),
    E(2, { pass_sacks: 30, pass_att: 300 }, { cov: { pass_sacks: 8 } }),
    E(3, { pass_sacks: 5, pass_att: 300 }, { cov: { pass_sacks: 8 } })]);
  const rf = rank(f, 1, "sacks_taken"); t.equal(rf.text, "—", "no range for a fewer-is-better total either"); t.equal(rf.lo, 1); t.equal(rf.hi, 2); t.deepEqual(rf.cause, { missing: 0, partial: 1, eligibility: 0 });
  // rates: no range either (the four-place rule is retired); the cause says whether the doubt is a competitor's eligibility
  const c = pool("WR", [E(1, { receptions: 30, targets: 40 }), E(2, { receptions: 20, targets: 20 }, { cov: { targets: 6, receptions: 6 } }), E(3, { receptions: 20, targets: 20 })]);
  const rc = rank(c, 1, "catch_rate"); t.equal(rc.text, "—"); t.deepEqual(rc.cause, { missing: 0, partial: 0, eligibility: 1 });
  t.ok(/For 1 of them it is also unknown whether they reach the minimum/.test(rc.why), rc.why);
  t.equal(SR.RATE_BARS.maxSpan, undefined, "no range-display rule remains");
  // exact rate with complete data is unchanged
  t.equal(rank(pool("WR", [E(1, { receptions: 30, targets: 40 }), E(3, { receptions: 20, targets: 30 })]), 1, "catch_rate").text, "WR1");
  // his own figure incomplete: no rank
  const o = rank(pool("WR", [E(1, { targets: 80 }, { cov: { targets: 9 } })]), 1, "targets"); t.equal(o.text, "—"); t.ok(/missing some games/.test(o.why));
});

test("R7b final: no qualifier minimum; WR/TE carries rank on totals, only yards per carry needs carries", () => {
  // four WRs over the 8-carry floor: ranked (a small group alone never withholds)
  const w4 = [E(1, { rush_yds: 156, rush_att: 12, rush_tds: 1 }), E(2, { rush_yds: 43, rush_att: 11, rush_tds: 0 }), E(3, { rush_yds: 38, rush_att: 9, rush_tds: 0 }), E(4, { rush_yds: 44, rush_att: 8, rush_tds: 0 }), E(5, { rush_yds: 51, rush_att: 6, rush_tds: 2 })];
  t.equal(rank(pool("WR", w4), 1, "ypc").text, "WR1");
  const u = rank(pool("WR", w4), 5, "ypc"); t.equal(u.text, "—", "6 carries is under 8"); t.ok(/Ranked at 8 carries or more; he has 6/.test(u.why));
  // carries, yards and TD rank on raw totals with no minimum
  t.equal(rank(pool("WR", w4), 5, "rush_att").text, "WR5"); t.equal(rank(pool("WR", w4), 5, "rush_yds").text, "WR2"); t.equal(rank(pool("WR", w4), 5, "rush_tds").text, "WR1");
  // one qualifier: still ranked
  t.equal(rank(pool("PK", [E(1, { fg_made: 10, fg_att: 12 }), E(2, { fg_made: 3, fg_att: 3 })]), 1, "fg_pct").text, "K1");
});

test("R7b: the Breakdown lists each withheld rank's reason once under Rank details", () => {
  const html = BD.rollupHtml({ to: 10, games: 9, sections: [{ h: "Receiving", items: [{ label: "Targets", value: "50", key: "targets" }, { label: "Targets inside 20", value: "8", key: "targets_i20" }, { label: "Rec. inside 20", value: "5", key: "rec_i20" }] }] }, [],
    (it) => it.key === "targets" ? { text: "WR3" } : { text: "—", why: "3 players' figures are incomplete, so he could rank anywhere from WR2 to WR5." }, "");
  t.ok(/<details class="bdwhy"><summary>Rank details<\/summary>/.test(html), "a Details block");
  t.ok(/<b>Targets inside 20, Rec\. inside 20:<\/b> 3 players/.test(html), "one reason, both stats");
  const none = BD.rollupHtml({ to: 10, games: 9, sections: [{ h: "Receiving", items: [{ label: "Targets", value: "50", key: "targets" }] }] }, [], () => ({ text: "WR3" }), "");
  t.ok(!/Rank details/.test(none), "no withheld rank, no Details block");
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
