// One bracket rule for Forecast, desktop and phone (#1370 gate 2): round 2 RE-SEEDS. The top seed meets the lowest
// seed left after round 1, seed 2 the other winner, on the UPS Championship and Hawk Tuah Bowl sides alike.
// tests/fixtures/bracket_reseed_vectors.json holds MFL's own archived brackets (every 6-team side 2014-2025) and a
// synthetic upset for each opening-round outcome. The same vectors drive season_sim.bracket in
// pipelines/etl/wire/test_season_sim_bracket_reseed.py, so the Wire's Forecast and these pages play one rule.
//   node scripts/safe_tests/run.mjs --only standings_bracket_reseed
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";

const V = JSON.parse(fs.readFileSync(new URL("./fixtures/bracket_reseed_vectors.json", import.meta.url), "utf8")).vectors;
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/playoff_brackets_recorded.json", import.meta.url), "utf8")).brackets;
const w = {}; new Function("window", fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8"))(w);
const R = w.UPS_STANDINGS_RACE;

// A vector's side as the shared module sees it: seeds 1-6 (champ) or 7-12 (hawk), a decider from the recorded games.
function resolve(v) {
  const base = v.side === "hawk" ? 6 : 0;
  const bySeedNum = {};
  v.seeds.forEach((fid, i) => { bySeedNum[base + i + 1] = { seed: base + i + 1, franchise_id: fid, franchise_name: fid }; });
  const winner = {};
  v.games.forEach((g) => { winner[[g.a, g.b].sort().join("|")] = g.winner; });
  return R.resolveBracketSide(bySeedNum, base, (a, b) => {
    const fid = winner[[a.franchise_id, b.franchise_id].sort().join("|")];
    return fid === a.franchise_id ? a : fid === b.franchise_id ? b : null;
  });
}
const pair = (g) => [g.a.franchise_id, g.b.franchise_id];

test("every recorded 6-team side 2014-2025: the shared resolver reproduces MFL's round 2, final and champion", () => {
  const rec = V.filter((v) => v.season != null);
  t.equal(rec.length, 22, "12 championship sides + 10 Hawk Tuah sides (2014-2015 toilet sides were 4-team brackets)");
  rec.forEach((v) => {
    const side = resolve(v);
    t.deepEqual(side.semis.map(pair), v.expected.round2, v.id + " round 2");
    t.deepEqual(pair(side.final).sort(), v.expected.final, v.id + " final");
    t.equal(side.final.winner.franchise_id, v.expected.champion, v.id + " champion");
    t.equal(side.final.loser.franchise_id, v.expected.runner_up, v.id + " runner-up");
  });
});

test("2016, 2017 and 2022 (a 6 seed won round 1) rule out the old fixed path; so do Hawk Tuah 2016 and 2021", () => {
  const differs = V.filter((v) => v.season != null && v.fixed_path_differs).map((v) => v.id);
  t.deepEqual(differs, ["2014-champ", "2016-champ", "2016-hawk", "2017-champ", "2021-hawk", "2022-champ"]);
  ["2016-champ", "2017-champ", "2022-champ"].forEach((id) => {
    const v = V.find((x) => x.id === id);
    const side = resolve(v);
    t.equal(side.semis[0].b.franchise_id, v.seeds[5], id + ": seed 1 met seed 6, the lowest seed left");
    t.notEqual(side.semis[0].b.franchise_id, v.fixed_path_round2[0][1], id + ": not the winner of 4 v 5");
  });
  ["2016-hawk", "2021-hawk"].forEach((id) => {
    const v = V.find((x) => x.id === id);
    t.equal(resolve(v).semis[0].b.franchise_id, v.seeds[5], id + ": H1 met H6");
  });
});

test("synthetic opening-round upsets, both sides: the top seed always gets the lowest surviving seed", () => {
  const syn = V.filter((v) => v.season == null);
  t.equal(syn.length, 8, "4 round-1 outcomes x 2 sides");
  syn.forEach((v) => {
    const side = resolve(v);
    t.deepEqual(side.semis.map(pair), v.expected.round2, v.id);
    const seedOf = (fid) => v.seeds.indexOf(fid) + 1;
    t.equal(seedOf(side.semis[0].b.franchise_id), Math.max(seedOf(side.r1[0].winner.franchise_id), seedOf(side.r1[1].winner.franchise_id)), v.id + ": lowest seed left");
  });
  const hawk = V.find((v) => v.id === "synthetic-hawk-r1-H6-H4");
  const side = resolve(hawk);
  t.equal(side.semis[0].a.seed, 7, "Hawk Tuah side uses seeds 7-12: H1 = seed 7");
  t.equal(side.semis[0].b.seed, 12, "H1 meets H6 (seed 12)");
});

test("undecided round 1: round 2 isn't guessed", () => {
  const v = V.find((x) => x.id === "synthetic-champ-r1-S6-S4");
  const bySeedNum = {};
  v.seeds.forEach((fid, i) => { bySeedNum[i + 1] = { seed: i + 1, franchise_id: fid }; });
  const side = R.resolveBracketSide(bySeedNum, 0, () => null);
  t.equal(side.semis[0].a.franchise_id, "S1");
  t.equal(side.semis[0].b, null, "seed 1's opponent is unknown until both round-1 games are decided");
  t.equal(side.final.a, null);
  t.equal(R.reseedRoundTwo(bySeedNum[1], bySeedNum[2], [bySeedNum[3], null]), null);
});

test("chalk projection is unchanged: 1 v 4 and 2 v 3, because chalk never upsets", () => {
  const seeds = Array.from({ length: 12 }, (_, i) => ({ seed: i + 1, franchise_id: String(i + 1).padStart(4, "0"), franchise_name: "T" + (i + 1) }));
  const p = R.projectChalkBracket(seeds);
  t.equal(p.status, "ok");
  t.deepEqual(p.champ.semis.map((g) => [g.a.seed, g.b.seed]), [[1, 4], [2, 3]]);
  t.deepEqual(p.hawk.semis.map((g) => [g.a.seed, g.b.seed]), [[7, 10], [8, 9]]);
  t.deepEqual(p.champ.r1.map((g) => [g.a.seed, g.b.seed]), [[3, 6], [4, 5]]);
  t.ok([p.champ, p.hawk].every((s) => [...s.r1, ...s.semis, s.placement, s.final, s.third].every((g) => g.winner && !g.pending && g.projected)));
  t.equal(p.picks["1.12"], "0001"); t.equal(p.picks["1.01"], "0007"); t.equal(p.picks["1.07"], "0005"); t.equal(p.picks["1.08"], "0006");
});

test("finished seasons on the recorded worker responses: real round 2 passes the re-seeding check; a fixed-path bracket would not", () => {
  ["2014", "2015", "2016", "2019", "2025"].forEach((y) => {
    const b = REC[y];
    const res = R.buildActualBracketResult(b.seeds, b.matchups, b.playoff_weeks);
    const top = (n) => b.seeds.find((s) => s.seed === n);
    const champ = R.reseedCheck(res.champ, top(1), top(2));
    t.deepEqual([champ.ok, champ.checked], [true, true], y + " championship side");
    if (y >= "2016") { const hk = R.reseedCheck(res.hawk, top(7), top(8)); t.deepEqual([hk.ok, hk.checked], [true, true], y + " Hawk Tuah side"); }
  });
  // 2016's real round 1: 6 beat 3, 4 beat 5. Rewrite round 2 the fixed way (1 v 4, 2 v 6) and the side is not drawn.
  const b = JSON.parse(JSON.stringify(REC["2016"]));
  const bySeed = Object.fromEntries(b.seeds.map((s) => [s.seed, s.franchise_id]));
  const wk2 = b.playoff_weeks.slice().sort((x, y) => x - y)[1];
  const swap = { [bySeed[6]]: bySeed[4], [bySeed[4]]: bySeed[6] };
  const wk2Score = Object.fromEntries(b.matchups.filter((m) => Number(m.week) === wk2).map((m) => [m.franchise_id, m.team_score]));
  b.matchups = b.matchups.map((m) => {
    if (Number(m.week) !== wk2) return m;
    const champSide = (f) => b.seeds.find((s) => s.franchise_id === f).seed <= 6;
    if (!champSide(m.franchise_id)) return m;
    const out = { ...m };
    if ([bySeed[1], bySeed[2]].includes(m.franchise_id)) out.opponent_franchise_id = swap[m.opponent_franchise_id] || m.opponent_franchise_id;
    else if (swap[m.franchise_id]) out.opponent_franchise_id = m.opponent_franchise_id === bySeed[1] ? bySeed[2] : bySeed[1];
    out.opponent_score = wk2Score[out.opponent_franchise_id];   // both sides of each rewritten game agree
    return out;
  });
  const res = R.buildActualBracketResult(b.seeds, b.matchups, b.playoff_weeks);
  const c = R.verifyActualSide(res, "champ", b.seeds, { season: 2016, hasConferences: b.has_conferences, matchups: b.matchups });
  t.deepEqual([c.draw, c.reason], [false, "path_mismatch"], "a round 2 that skips the re-seed is listed by week, never drawn as a bracket");
});

await run();
