// The whole path, worker → desktop standings page, for a failed or unflagged weekly query (Keith 2026-10-09: "Make a failed
// weekly or weeklyScores query return incomplete, never preseason, all the way from #1201's worker response"). The REAL
// /api/standings route (worker harness + the production D1 schemas) feeds the REAL site/standings/mfl_hpm_standings_v2.html
// script. A scoped table or a playoff record built from a failed query used to read as a confident 0-0 / "—".
//   node tests/standings_weekly_fail_closed_client.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { makeEnv } from "./fixtures/standings_d1.mjs";
import { loadStandingsPage, workerFetch, settle } from "./fixtures/standings_v2_page.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();

const SCHEDULE_SQL = "FROM src_schedule WHERE season = ? AND COALESCE(team_score, 0) > 0 ORDER BY week";
const SCORES_SQL = "FROM src_franchise_weekly_score WHERE season = ?";
function failing(env, needle) {
  const prep = env.UPS_MFL_DB.prepare.bind(env.UPS_MFL_DB);
  env.UPS_MFL_DB.prepare = (sql) => { if (sql.includes(needle)) throw new Error("D1_ERROR: simulated failure"); return prep(sql); };
  return env;
}
async function page(env, query) {
  const p = loadStandingsPage({ query, fetch: workerFetch(callWorker, env) });
  await settle();
  return p.html().replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&");   // read it as the owner does
}
// the Playoffs column cell of each rendered row (9th <td>: #, Seed, Team, Owner, Division, W-L-T, PCT, Div, Playoffs)
const playoffCells = (html) => [...html.matchAll(/<tr>((?:<td[^>]*>[\s\S]*?<\/td>){9})/g)].map((m) => [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][8][1]);

test("control: a readable season renders the Regular Season table and real playoff records", async () => {
  const html = await page(makeEnv({ 1: 0, 2: 0, 15: 1 }), "view=overall&year=2026&scope=regular");
  t.ok(/<table>/.test(html), "the scoped table renders");
  t.ok(!/can't be computed/.test(html));
  const full = await page(makeEnv({ 1: 0, 2: 0, 15: 1 }), "view=overall&year=2026");
  t.deepEqual(playoffCells(full).sort(), ["0-1", "0-1", "1-0", "1-0"], "week 15's games are each team's playoff record");
});

test("weekly query FAILS: the scoped views refuse (no 0-0 table); Full Season still renders with playoff records '?'", async () => {
  for (const [needle, label] of [[SCHEDULE_SQL, "weekly"], [SCORES_SQL, "weeklyScores"]]) {
    for (const scope of ["regular", "playoffs", "custom"]) {
      const html = await page(failing(makeEnv({ 1: 0, 2: 0, 15: 1 }), needle), "view=overall&year=2026&scope=" + scope);
      t.match(html, /standings for 2026 can't be computed: the weekly results couldn't be read\. Full Season is unaffected\./, label + " / " + scope);
      t.ok(!/<table>/.test(html), label + " / " + scope + ": no table built from nothing");
    }
    const full = await page(failing(makeEnv({ 1: 0, 2: 0, 15: 1 }), needle), "view=overall&year=2026");
    t.ok(/<table>/.test(full), label + ": Full Season renders from the standings rows");
    t.deepEqual([...new Set(playoffCells(full).map((c) => c.replace(/<[^>]+>/g, "")))], ["?"], label + ": every playoff record is ? — not — (0-0)");
    t.match(full, /Playoff records show <strong>\?<\/strong>: the weekly results couldn't be read\./);
    const div = await page(failing(makeEnv({ 1: 0, 2: 0, 15: 1 }), needle), "view=divisions&year=2026&scope=regular");
    t.match(div, /Regular Season division standings for 2026 can't be computed/, label + ": divisions refuse too");
  }
});

test("UNFLAGGED weeks (po null from the worker): scoped views refuse; playoff records '?'", async () => {
  const env = makeEnv({ 1: 0, 2: null, 3: "x", 15: 1 });
  const html = await page(env, "view=overall&year=2026&scope=regular");
  t.match(html, /can't be computed: some weekly results aren't marked regular season or playoff/);
  const full = await page(makeEnv({ 1: 0, 2: null, 3: "x", 15: 1 }), "view=overall&year=2026");
  t.deepEqual([...new Set(playoffCells(full).map((c) => c.replace(/<[^>]+>/g, "")))], ["?"]);
});

test("a genuinely EMPTY season ([] / [], no error) is trusted: the scoped table renders — that IS 0-0", async () => {
  const html = await page(makeEnv({}), "view=overall&year=2026&scope=regular");
  t.ok(/<table>/.test(html)); t.ok(!/can't be computed/.test(html));
});

await run("standings_weekly_fail_closed_client");
mfl.restore();
restore();
