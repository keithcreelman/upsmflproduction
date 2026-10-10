// /api/standings never guesses a playoff flag (Keith 2026-10-09: "If it converts malformed input to regular season before
// F3 sees it, F3 is not effective end to end"). The standings race module fails closed on an unrecognized `po`, so the
// worker must send one through as null instead of collapsing it to 0, and must send a failed weekly query as null + an
// error instead of an empty array (an empty array reads as "nothing played yet").
//   node tests/standings_playoff_flag.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { makeEnv } from "./fixtures/standings_d1.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();

const standings = async (env) => {
  const r = await callWorker(env, "GET", "/api/standings?year=2026");
  t.equal(r.status, 200, r.text.slice(0, 200));
  return r.json;
};
const poByWeek = (arr) => { const o = {}; for (const x of arr) (o[x.w] = o[x.w] || new Set()).add(x.po === null ? "null" : x.po); return Object.fromEntries(Object.entries(o).map(([w, s]) => [w, [...s]])); };

test("explicit flags pass through exactly: 0 -> po 0, 1 -> po 1 (the live 2026 shape is unchanged)", async () => {
  const j = await standings(makeEnv({ 1: 0, 2: 0, 15: 1 }));
  t.deepEqual(poByWeek(j.weekly), { 1: [0], 2: [0], 15: [1] });
  t.deepEqual(poByWeek(j.weeklyScores), { 1: [0], 2: [0], 15: [1] });
  t.ok(j.weekly.every((x) => typeof x.po === "number") && j.weeklyScores.every((x) => typeof x.po === "number"), "valid flags stay numbers");
  t.equal(j.weekly_errors, undefined, "no error key when both queries succeed");
});

test("an unrecognized flag is sent as null, never collapsed to 0 (regular season)", async () => {
  // NULL is possible only in src_schedule (nullable); a stray value is possible in both tables (INTEGER affinity keeps "x" as text).
  const j = await standings(makeEnv({ 1: 0, 2: null, 3: 2, 4: "x", 5: 1 }));
  t.deepEqual(poByWeek(j.weekly), { 1: [0], 2: ["null"], 3: ["null"], 4: ["null"], 5: [1] });
  t.deepEqual(poByWeek(j.weeklyScores), { 1: [0], 3: ["null"], 4: ["null"], 5: [1] });
  t.equal(j.weekly.filter((x) => x.po === 0).length, 4, "only week 1's four rows are regular season — weeks 2-4 are NOT");
});

test("a failed weekly query is null + an error, not an empty array; the rest of the response still loads", async () => {
  for (const [needle, key, other] of [["FROM src_schedule WHERE season = ? AND COALESCE(team_score, 0) > 0 ORDER BY week", "weekly", "weeklyScores"],
                                      ["FROM src_franchise_weekly_score WHERE season = ?", "weeklyScores", "weekly"]]) {
    const env = makeEnv({ 1: 0, 2: 0 });
    const prep = env.UPS_MFL_DB.prepare.bind(env.UPS_MFL_DB);
    env.UPS_MFL_DB.prepare = (sql) => { if (sql.includes(needle)) throw new Error("D1_ERROR: simulated " + key + " failure"); return prep(sql); };
    const j = await standings(env);
    t.equal(j[key], null, key + " must be null, not []");
    t.match(j.weekly_errors[key], /simulated/);
    t.ok(Array.isArray(j[other]) && j[other].length > 0, other + " is unaffected");
    t.equal(j.rows.length, 4, "rows still load");
  }
});

test("a genuinely empty season is still an empty array (no error)", async () => {
  const j = await standings(makeEnv({}));
  t.deepEqual(j.weekly, []); t.deepEqual(j.weeklyScores, []);
  t.equal(j.weekly_errors, undefined);
});

await run("standings_playoff_flag");
mfl.restore();
restore();
