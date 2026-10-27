// Magic numbers (site/shared/standings_race.js magicNumbers): the division race (H2H) and the wild-card race
// (All-Play), on REAL data — the real /api/standings route on the recorded 2026 season after Week 5 and MFL's own
// schedule export (tests/fixtures/mfl_2026_schedule.json: TYPE=schedule&L=74598&YEAR=2026, fetched 2026-10-20) —
// plus synthetic late-season races for the clinch rules. The Week 5 numbers were worked by hand from the records
// (MFL's own Week 1-5 results in the schedule export match every H2H record on the route):
//   magic = rival's games − rival's losses − team's wins + 1 (no ties), 37 H2H games and 154 All-Play results each.
//   node scripts/safe_tests/run.mjs --only standings_magic_numbers
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
mfl.st.league = { standingsSort: REC.standingsSort };
const SCHED = JSON.parse(fs.readFileSync(new URL("./fixtures/mfl_2026_schedule.json", import.meta.url), "utf8"));
const w = {}; new Function("window", fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8"))(w);
const R = w.UPS_STANDINGS_RACE;
const clone = (x) => JSON.parse(JSON.stringify(x));
let RESP = null;
async function resp() {
  if (!RESP) RESP = (await callWorker(loadSeason(makeWorkerEnv({}), recorded2026(REC)), "GET", "/api/standings?year=2026")).json;
  return clone(RESP);
}

test("Week 5: one division magic number per leader, against the rival who can finish highest", async () => {
  const m = R.magicNumbers(await resp(), clone(SCHED));
  t.equal(m.status, "ok"); t.equal(m.throughWeek, 5); t.equal(m.lastRegularWeek, 14); t.equal(m.apGamesLeft, 99);
  t.equal(m.division.status, "ok");
  t.deepEqual(m.division.byDivision, {
    "00": { leader: "0005", vs: "0004", magic: 22, clinched: false }, // HammerTime 9-4 vs Pure Greatness 6-7
    "01": { leader: "0010", vs: "0002", magic: 23, clinched: false }, // Blake Bombers 9-4 vs CBP 7-6
    "02": { leader: "0008", vs: "0001", magic: 22, clinched: false }, // Real Deal Creel 9-4 vs L.A. Looks 6-7
    "03": { leader: "0009", vs: "0011", magic: 20, clinched: false }, // C-Town Chivalry 11-2 vs Cleon Ca$h 6-7 (Hawks also 6-7; the better division rank is named)
  });
});
test("Week 5: wild-card magic numbers against the first team out (Hawks 29-26 All-Play)", async () => {
  const m = R.magicNumbers(await resp(), clone(SCHED));
  t.equal(m.wildCard.status, "ok"); t.equal(m.wildCard.vs, "0012");
  t.deepEqual(m.wildCard.teams, [
    { franchise_id: "0002", magic: 97, reachedZero: false, clinched: false }, // CBP 32-23
    { franchise_id: "0004", magic: 98, reachedZero: false, clinched: false }, // Pure Greatness 31-24
  ]);
  t.deepEqual(Object.keys(m.byFid).sort(), ["0002", "0004", "0005", "0008", "0009", "0010"], "seeds 1-6 only");
  t.deepEqual(m.byFid["0009"], { kind: "division", magic: 20, vs: "0011", clinched: false, clinchedDivision: false, clinchedSpot: false });
  t.deepEqual(m.byFid["0004"], { kind: "wild_card", magic: 98, vs: "0012", clinched: false, clinchedDivision: false, clinchedSpot: false });
});
test("The rival's own number of games counts: a future game taken off the schedule changes only the numbers against that team", async () => {
  const s = clone(SCHED);
  const wk9 = s.schedule.weeklySchedule.find((x) => x.week === "9");
  const i = wk9.matchup.findIndex((g) => g.franchise.some((f) => f.id === "0002") && !g.franchise.some((f) => f.id === "0010"));
  wk9.matchup.splice(i, 1); // CBP now has 36 games
  const m = R.magicNumbers(await resp(), s);
  t.equal(m.division.status, "ok");
  t.equal(m.division.byDivision["01"].magic, 22, "Blake Bombers vs CBP: 36 − 6 − 9 + 1");
  t.equal(m.division.byDivision["00"].magic, 22);
});
test("Fails closed: no schedule, a schedule that disagrees with the games played, or an unknown team → no division numbers (wild card unaffected)", async () => {
  const a = R.magicNumbers(await resp(), null);
  t.equal(a.division.status, "unavailable"); t.equal(a.division.reason, "schedule_unavailable"); t.deepEqual(a.division.byDivision, {});
  t.equal(a.wildCard.status, "ok", "All-Play needs no schedule");
  t.deepEqual(a.byFid["0009"], { kind: "division", magic: null, vs: null, clinched: false, clinchedDivision: false, clinchedSpot: false });
  const s1 = clone(SCHED);
  s1.schedule.weeklySchedule.find((x) => x.week === "3").matchup.pop();
  t.equal(R.magicNumbers(await resp(), s1).division.reason, "schedule_mismatch", "a played week short a game");
  const s2 = clone(SCHED);
  s2.schedule.weeklySchedule.find((x) => x.week === "10").matchup[0].franchise[0].id = "0099";
  t.equal(R.magicNumbers(await resp(), s2).division.reason, "schedule_unreadable");
  const s3 = clone(SCHED);
  s3.schedule.weeklySchedule = s3.schedule.weeklySchedule.filter((x) => x.week !== "12");
  t.equal(R.magicNumbers(await resp(), s3).division.reason, "schedule_incomplete", "a regular-season week missing");
});
test("Nothing to clinch, or nothing safe to count: preseason, a finished or recorded season, unverified weeks, bad records", async () => {
  const p = await resp();
  t.equal(R.magicNumbers({ ...clone(p), preseason: true, standings_basis: "preseason" }, SCHED).status, "preseason");
  const done = clone(p); done.regular_season.complete = true;
  t.equal(R.magicNumbers(done, SCHED).status, "final");
  const rec = clone(p); rec.standings_basis = "recorded_final_standings";
  t.equal(R.magicNumbers(rec, SCHED).status, "final");
  const inc = clone(p); inc.regular_season.status = "incomplete";
  t.deepEqual([R.magicNumbers(inc, SCHED).status, R.magicNumbers(inc, SCHED).reason], ["unavailable", "regular_season_unverified"]);
  const bad = clone(p); bad.rows[3].regular_season.all_play.w -= 1; // no longer 11 results a week
  const b = R.magicNumbers(bad, SCHED);
  t.deepEqual([b.status, b.reason, b.division.status, b.wildCard.status, Object.keys(b.byFid).length], ["unavailable", "records_unreadable", "unavailable", "unavailable", 0]);
  t.equal(R.magicNumbers(null, SCHED).status, "unavailable");
});

// ── Synthetic late-season races: 12 teams, 4 divisions of 3, one H2H game a week, through Week 13 of 14 ──
const TEAMS = [
  // fid, division, leader, rank, seed, status, H2H w-l, All-Play w-l (11 a week × 13 = 143)
  ["0001", "00", true, 1, 1, "bye", 12, 1, 120, 23],
  ["0002", "00", false, 2, 4, "wild_card", 8, 5, 100, 43],
  ["0003", "00", false, 3, null, "non_playoff", 6, 7, 80, 63],
  ["0004", "01", true, 1, 3, "division_winner", 9, 4, 110, 33],
  ["0005", "01", false, 2, null, "non_playoff", 9, 4, 50, 93],
  ["0006", "01", false, 3, null, "non_playoff", 2, 11, 30, 113],
  ["0007", "02", true, 1, 2, "bye", 11, 2, 115, 28],
  ["0008", "02", false, 2, 5, "wild_card", 7, 6, 98, 45],
  ["0009", "02", false, 3, null, "non_playoff", 4, 9, 60, 83],
  ["0010", "03", true, 1, 6, "division_winner", 10, 3, 90, 53],
  ["0011", "03", false, 2, null, "non_playoff", 7, 6, 70, 73],
  ["0012", "03", false, 3, null, "non_playoff", 3, 10, 40, 103],
];
function synth(edit) {
  const rows = TEAMS.map(([fid, div, leader, rank, seed, status, hw, hl, aw, al]) => ({
    franchise_id: fid, franchise_name: "Team " + fid, division: div, is_division_leader: leader, division_rank: rank,
    playoff_seed: seed, playoff_status: status, seed_reason: { basis: "regular_season_ladder" },
    regular_season: { record: { w: hw, l: hl, t: 0 }, all_play: { w: aw, l: al, t: 0 }, games: hw + hl, weeks: 13 },
  }));
  if (edit) edit(rows);
  return { standings_basis: "regular_season_ladder", preseason: false,
    regular_season: { status: "ok", through_week: 13, last_regular_season_week: 14, complete: false, next_out: "0003" }, rows };
}
// One game a week for everyone (a rotation); only the counts matter to magicNumbers.
const SYN_SCHED = { schedule: { weeklySchedule: Array.from({ length: 17 }, (_, i) => ({
  week: String(i + 1),
  matchup: i < 14 ? Array.from({ length: 6 }, (_, j) => ({ franchise: [{ id: String(j + 1).padStart(4, "0") }, { id: String(((j + i) % 6) + 7).padStart(4, "0") }] })) : [],
})) } };

test("A division is clinched when no rival can even tie; a tied race is not", () => {
  const m = R.magicNumbers(synth(), SYN_SCHED);
  t.equal(m.division.status, "ok");
  t.deepEqual(m.division.byDivision["00"], { leader: "0001", vs: "0002", magic: 0, clinched: true }, "12-1 vs 8-5 with one game left");
  t.deepEqual(m.division.byDivision["01"], { leader: "0004", vs: "0005", magic: 2, clinched: false }, "9-4 vs 9-4: 14 − 4 − 9 + 1");
  t.equal(m.byFid["0001"].clinchedDivision, true); t.equal(m.byFid["0004"].clinchedDivision, false);
});
test("A wild-card magic number of 0 is not a clinch while a division race can drop a leader into the wild-card race", () => {
  const m = R.magicNumbers(synth(), SYN_SCHED);
  t.deepEqual(m.wildCard.teams.map((x) => [x.franchise_id, x.magic, x.reachedZero, x.clinched]), [["0002", 0, true, false], ["0008", 0, true, false]]);
  // Team 0004 can lose its division to 0005 (both 9-4) and drop into the wild-card race with more All-Play wins than 0002.
  t.equal(m.byFid["0004"].clinchedSpot, true, "0004 itself is in either way: only 0002 could finish above it among non-winners");
});
test("Once that division race is settled, both wild cards have clinched a playoff spot", () => {
  const m = R.magicNumbers(synth((rows) => { rows[3].regular_season.record = { w: 11, l: 2, t: 0 }; rows[4].regular_season.record = { w: 7, l: 6, t: 0 }; }), SYN_SCHED);
  t.equal(m.division.byDivision["01"].clinched, true);
  t.deepEqual(m.wildCard.teams.map((x) => [x.franchise_id, x.clinched]), [["0002", true], ["0008", true]]);
  t.deepEqual(m.byFid["0002"], { kind: "wild_card", magic: 0, vs: "0003", clinched: true, clinchedDivision: false, clinchedSpot: true });
});
test("Without a schedule, nobody is assumed out of a division race (the cautious side): no wild-card clinch", () => {
  const m = R.magicNumbers(synth((rows) => { rows[3].regular_season.record = { w: 11, l: 2, t: 0 }; rows[4].regular_season.record = { w: 7, l: 6, t: 0 }; }), null);
  t.equal(m.division.status, "unavailable");
  t.deepEqual(m.wildCard.teams.map((x) => [x.franchise_id, x.magic, x.clinched]), [["0002", 0, false], ["0008", 0, false]]);
});
test("Ties count half and are never enough: a tie with the rival still needs one more", () => {
  const m = R.magicNumbers(synth((rows) => { rows[0].regular_season.record = { w: 9, l: 3, t: 1 }; rows[1].regular_season.record = { w: 8, l: 4, t: 1 }; }), SYN_SCHED);
  // 0002 can reach 8 + 0.5 + 1 = 9.5; 0001 has 9.5 now: one more 0001 win or 0002 loss clinches outright.
  t.deepEqual(m.division.byDivision["00"], { leader: "0001", vs: "0002", magic: 1, clinched: false });
});

await run();
restore();
