// /api/standings says WHY each current-season team is seeded where it is (seed_reason), from the worker's own ladder —
// All-Play % → Overall → season Points For → head-to-head (canon §F.1, Keith 2026-10-08) — so no page re-derives it
// (Keith 2026-10-09, Phase II port decision 1). Seasons with recorded final standings make no ladder claim (decision 2).
//   node tests/standings_seed_reason.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { makeLadderSeason as makeSeason } from "./fixtures/standings_d1.mjs";
import { seedLadder, seedLadderSteps, SEED_STEPS } from "../worker/src/seeding.js";
import { LADDER_TEAMS } from "./fixtures/standings_d1.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();

const standings = async (env) => { const r = await callWorker(env, "GET", "/api/standings?year=2026"); t.equal(r.status, 200, r.text.slice(0, 200)); return r.json; };
const byFid = (j) => Object.fromEntries(j.rows.map((r) => [r.franchise_id, r]));
const brief = (r) => [r.playoff_seed, r.seed_reason.pool, r.seed_reason.step, r.seed_reason.position, r.seed_reason.rival_franchise_id];

test("seedLadderSteps: the comparator is identical to seedLadder, and names the step that decided each pair", () => {
  const rows = LADDER_TEAMS.map(([fid, , ap, ov, pf]) => ({ franchise_id: fid, franchise_name: "Team " + fid, allplay_pct: ap, h2h_pct: ov, pf_total: pf }));
  const games = [{ franchise_id: "0004", opponent_franchise_id: "0002", team_score: 120, opponent_score: 100 }, { franchise_id: "0002", opponent_franchise_id: "0004", team_score: 100, opponent_score: 120 }];
  const L = seedLadderSteps(rows, games), old = seedLadder(rows, games);
  for (const a of rows) for (const b of rows) t.equal(Math.sign(L.cmp(a, b)), Math.sign(old(a, b)));
  const R = Object.fromEntries(rows.map((r) => [r.franchise_id, r]));
  t.equal(L.decidingStep(R["0001"], R["0003"]), "overall");
  t.equal(L.decidingStep(R["0004"], R["0002"]), "head_to_head");
  t.equal(L.decidingStep(R["0007"], R["0005"]), "points_for");
  t.equal(L.decidingStep(R["0002"], R["0007"]), "all_play");
  t.equal(L.decidingStep(R["0001"], R["0001"]), null);
  t.equal(L.decidingStep({ ...R["0006"], franchise_name: "A" }, { ...R["0008"], franchise_name: "B" }), "name", "the fallback is named as such");
  t.deepEqual(SEED_STEPS, ["all_play", "overall", "points_for", "head_to_head", "name", "franchise_id"]);
});

test("current season: every row carries the step that seeded it, through the real /api/standings route", async () => {
  const j = await standings(makeSeason());
  const R = byFid(j);
  t.deepEqual(brief(R["0001"]), [1, "bye", "overall", "ahead", "0003"]);
  t.deepEqual(brief(R["0003"]), [2, "bye", "overall", "behind", "0001"]);
  t.deepEqual(brief(R["0004"]), [3, "seeds3to6", "head_to_head", "ahead", "0002"]);
  t.deepEqual(brief(R["0002"]), [4, "seeds3to6", "all_play", "ahead", "0007"]);
  t.deepEqual(brief(R["0007"]), [5, "seeds3to6", "points_for", "ahead", "0005"]);
  t.deepEqual(brief(R["0005"]), [6, "seeds3to6", "points_for", "behind", "0007"]);
  t.deepEqual(brief(R["0006"]), [null, "outside", "all_play", "behind", "0002"], "outside: behind the last wild card");
  t.deepEqual(brief(R["0008"]), [null, "outside", "all_play", "behind", "0002"]);
  t.ok(j.rows.every((r) => r.seed_reason.basis === "ladder"));
  t.equal(R["0004"].seed_reason.rival_seed, 4);
});

test("the regular-season games can't be read: a tie that reached head-to-head says so — never 'name order'", async () => {
  const R = byFid(await standings(makeSeason({ failGames: true })));
  t.equal(R["0002"].seed_reason.step === "head_to_head_unavailable" || R["0004"].seed_reason.step === "head_to_head_unavailable", true);
  t.ok(!Object.values(R).some((r) => r.seed_reason.step === "name" || r.seed_reason.step === "head_to_head"));
  t.equal(R["0001"].seed_reason.step, "overall", "steps before head-to-head are unaffected");
});

test("a season with RECORDED final standings: basis 'recorded_final_standings', no ladder step claimed", async () => {
  const j = await standings(makeSeason({ recorded: true }));
  t.ok(j.rows.length === 8);
  t.ok(j.rows.every((r) => r.seed_reason && r.seed_reason.basis === "recorded_final_standings" && !("step" in r.seed_reason)));
});

await run("standings_seed_reason");
mfl.restore();
restore();
