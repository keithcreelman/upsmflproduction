// Desktop magic numbers (#1329): the seed cards, the Division leaders panel and the Divisions tab of the REAL desktop
// page (site/standings/mfl_hpm_standings_v2.html, tests/fixtures/standings_v2_page.mjs) on the REAL /api/standings route
// for the recorded 2026 season after Week 5, with MFL's own 2026 schedule export answering the worker's export proxy —
// and with that read failing or hanging. Numbers worked by hand in standings_magic_numbers.test.mjs.
//   node scripts/safe_tests/run.mjs --only standings_desktop_magic
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";
import { loadStandingsPage, workerFetch, settle } from "./fixtures/standings_v2_page.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
mfl.st.league = { standingsSort: REC.standingsSort };
const SCHED = fs.readFileSync(new URL("./fixtures/mfl_2026_schedule.json", import.meta.url), "utf8");
const ENV = loadSeason(makeWorkerEnv({}), recorded2026(REC));
const text = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");

function page(query, schedule, editStandings) {
  const base = workerFetch(callWorker, ENV);
  const worker = async (url) => {
    const r = await base(url);
    if (!editStandings || new URL(url).pathname !== "/api/standings") return r;
    const j = editStandings(await r.json());
    return { ...r, json: async () => j };
  };
  const reads = [];
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/mfl-export" && u.searchParams.get("TYPE") === "schedule") {
      reads.push(u.search);
      if (schedule === "fail") return { ok: false, status: 502, json: async () => ({ error: "x" }) };
      if (schedule === "hang") return new Promise(() => {});
      return { ok: true, status: 200, json: async () => JSON.parse(SCHED) };
    }
    return worker(url);
  };
  return { p: loadStandingsPage({ query, fetch }), reads };
}

test("Playoff Picture: every seed card 1-6 carries its magic number; each division in the Division leaders panel too", async () => {
  const { p, reads } = page("view=picture&year=2026");
  await settle();
  const h = text(p.html());
  t.match(h, /C-Town Chivalry .*? Division magic number 20 : its H2H wins \+ Cleon Ca\$h H2H losses\./);
  t.match(h, /Blake Bombers .*? Division magic number 23 : its H2H wins \+ CBP H2H losses\./);
  t.match(h, /Division magic number 22 : its H2H wins \+ Pure Greatness H2H losses\./, "HammerTime (3)");
  t.match(h, /Division magic number 22 : its H2H wins \+ L\.A\. Looks H2H losses\./, "Real Deal Creel (4)");
  t.match(h, /CBP .*? Wild-card magic number 97 : its All-Play wins \+ Hawks All-Play losses\./);
  t.match(h, /Pure Greatness .*? Wild-card magic number 98 : its All-Play wins \+ Hawks All-Play losses\./);
  t.equal((p.html().match(/class="seed-magic"/g) || []).length, 6, "seeds 1-6 only");
  t.equal((p.html().match(/class="magic-line"/g) || []).length, 4, "one per division");
  t.match(h, /Magic number 20 : C-Town Chivalry H2H wins \+ Cleon Ca\$h H2H losses\./);
  // decision 2: the definition moved off the page into About these numbers (on-screen notes stay short)
  t.match(h, /Magic number This team’s future wins plus the named rival’s future losses that put the rival out of reach/);
  t.match(h, /Magic numbers are explained under About these numbers\./);
  t.deepEqual(reads, ["?TYPE=schedule&L=74598&JSON=1&YEAR=2026"], "MFL's schedule read once, through the export proxy");
});
test("Divisions tab: a magic-number line under each division", async () => {
  const { p } = page("view=divisions&year=2026");
  await settle();
  const h = text(p.html());
  t.match(h, /Magic number 23 : Blake Bombers H2H wins \+ CBP H2H losses\./);
  t.match(h, /Magic number 22 : HammerTime H2H wins \+ Pure Greatness H2H losses\./);
  t.match(h, /Division: H2H, against the rival who can finish highest \(the rival named\)\./);
  t.match(h, /Magic numbers are explained under About these numbers\./);
});
test("MFL's schedule fails: division lines say why (no number); the wild-card numbers still show", async () => {
  const { p } = page("view=picture&year=2026", "fail");
  await settle();
  const h = text(p.html());
  t.equal((h.match(/Division magic number: MFL’s schedule couldn’t be read, so it isn’t shown\./g) || []).length, 4);
  t.ok(!/Division magic number \d/.test(h));
  t.match(h, /Wild-card magic number 97 /);
});
test("MFL's schedule hangs: the page draws after 2.5 s anyway and says the numbers come next time", async () => {
  const { p } = page("view=picture&year=2026", "hang");
  await settle();
  t.ok(!/seed-card/.test(p.html()), "still waiting, briefly");
  await new Promise((r) => setTimeout(r, 2600));
  await settle();
  const h = text(p.html());
  t.match(h, /Division magic number: MFL’s schedule hasn’t arrived yet; it shows the next time this view opens\./);
  t.match(h, /Wild-card magic number 98 /);
});
test("Regular season over (seeds set), or no games played yet: no magic numbers and no schedule read", async () => {
  const done = page("view=picture&year=2026", null, (j) => ({ ...j, regular_season: { ...j.regular_season, complete: true } }));
  await settle();
  t.match(done.p.html(), /seed-card/, "the seeds still draw");
  t.ok(!/magic number/i.test(done.p.html()));
  t.deepEqual(done.reads, []);
  const pre = page("view=picture&year=2025"); // this harness has no 2025 games: the worker answers preseason
  await settle();
  t.match(text(pre.p.html()), /2025 · no games played yet/);
  t.ok(!/magic number/i.test(pre.p.html()));
  t.deepEqual(pre.reads, []);
});

await run();
restore();
