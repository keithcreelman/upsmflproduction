// Desktop Standings cleanup (Keith 2026-10-27, urgent follow-up to #1388), on the REAL worker route + REAL desktop page, Week 6 2026:
//  1. Divisions: a card is never narrower than its table, so the table never needs its own scrollbar (the two-column grid starts at 580 px).
//  2. Playoff Picture: exactly ONE bracket (today's seeds); no projected-bracket switch. The Forecast tab and the draft outlook still use the Forecast.
//  3. Full League: Overall first and the default, then Scoring.
//  4. Weekly: Season Leaders, One Week, Team by Week, Heat Map; Season Leaders is the default; explicit links still open their view.
//  5. No History tab and no "historical data is being reviewed" notice, in any view or season; the History code and old links remain.
//   node scripts/safe_tests/run.mjs --only standings_desktop_cleanup
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";
import { loadStandingsPage, workerFetch, settle } from "./fixtures/standings_v2_page.mjs";

quiet();
const mfl = makeMfl(); mfl.install();
const json = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));
const REC = json("./fixtures/standings_2026_wk5.json"), WK6 = json("./fixtures/standings_2026_wk6_week.json");
mfl.st.league = { standingsSort: REC.standingsSort };
const SIM6 = json("./fixtures/wire_season_sim_2026_live_wk06.json"), DET6 = json("../site/wire/data/standings_forecast_2026_wk06.json");
const SRC = fs.readFileSync(new URL("../site/standings/mfl_hpm_standings_v2.html", import.meta.url), "utf8");
const plain = (html) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const season6 = () => { const s = recorded2026(REC); return { ...s, weeklyScores: s.weeklyScores.concat(WK6.weekly_scores), games: s.games.concat(WK6.games) }; };
const ENV6 = loadSeason(makeWorkerEnv({}), season6());
const WIRE = "https://keithcreelman.github.io/upsmflproduction/wire/data/";
const FILES = { "season_sim_2026_live_wk06.json": SIM6, "standings_forecast_2026_wk06.json": DET6 };
async function page(query) {
  const worker = workerFetch(callWorker, ENV6), reads = [];
  const fetch = async (url) => {
    if (url.startsWith(WIRE)) { const n = url.slice(WIRE.length); reads.push(n); return FILES[n] ? { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(FILES[n])) } : { ok: false, status: 404, json: async () => ({}) }; }
    return worker(url);
  };
  const p = loadStandingsPage({ query, fetch });
  await new Promise((r) => setTimeout(r, 2700));
  await settle();
  return { raw: p.html(), h: plain(p.html()), reads };
}
const tabs = (h) => [...h.matchAll(/<button type="button" class="view-btn" role="tab" data-view="(\w+)" aria-selected="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((m) => m[3]);
const seg = (h, label) => { const m = new RegExp('aria-label="' + label + '"><span class="seg-label">Show:</span>([\\s\\S]*?)</div>').exec(h); return m ? [...m[1].matchAll(/<button[^>]*aria-pressed="(true|false)"[^>]*>([^<]*)<\/button>/g)].map((b) => [b[2], b[1] === "true"]) : null; };

test("Divisions: a division card is never narrower than its table (so no scrollbar inside the card), and the four cards still render", async () => {
  const css = /\.div-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\((\d+)px, 100%\), 1fr\)\);/.exec(SRC);
  t.ok(css, "the grid rule");
  t.ok(Number(css[1]) >= 560, "a card needs at least the table's width (the widest table + card padding is about 550 px); was 480");
  t.match(SRC, /\.div-grid > \.div-card \{ min-width: 0; \}/);
  const p = await page("view=divisions&year=2026");
  t.equal((p.h.match(/class="div-card"/g) || []).length, 4, "four divisions");
});
test("Playoff Picture: exactly one bracket (today's seeds), no Projected switch; the draft outlook still reads the Forecast", async () => {
  const p = await page("view=picture&year=2026");
  t.equal((p.h.match(/class="pp-side"/g) || []).length, 2, "one UPS bracket and one Hawk Tuah Bowl bracket, nothing else");
  t.ok(!/pp-side proj/.test(p.h) && !/data-pp=/.test(p.h) && !/Which bracket/.test(p.h) && !/Projected · Week/.test(p.h) && !/Projected · not final/.test(p.h), "no projected bracket or switch");
  t.match(p.h, /If the season ended today<\/span> Seeds from the standings through Week 6/);
  t.match(p.h, /UPS Championship · seeds 1–6/);
  t.ok(p.reads.includes("season_sim_2026_live_wk06.json"), "the Forecast is still read (draft outlook)");
  t.match(p.raw, /id="ppDraft"/, "the draft-outlook slot is still there");
  t.match(SRC, /drawDraftOutlook\(dslot, resp, fc\)/, "and still fed by the Forecast");
  // the seeds are still the worker's: seed 1 in the bracket is the worker's seed 1
  const resp = (await callWorker(ENV6, "GET", "/api/standings?year=2026")).json;
  const s1 = resp.rows.find((r) => r.playoff_seed === 1);
  t.ok(p.h.includes('<span class="pp-seed">1</span><span class="pp-name">' + s1.franchise_name + "</span>"));
});
test("Forecast tab is unchanged: its own projections, probabilities and bracket tiles", async () => {
  const p = await page("view=forecast&year=2026");
  t.match(p.h, /Through Week 6/);
  t.match(p.h, /Most likely/);
  t.match(p.h, /Hawk Tuah/);
});
test("Full League: Overall first and the default, then Scoring", async () => {
  const p = await page("view=league&year=2026");
  t.deepEqual(seg(p.raw, "Columns"), [["Overall", true], ["Scoring", false]]);
  const q = await page("year=2026");
  t.deepEqual(seg(q.raw, "Columns"), [["Overall", true], ["Scoring", false]], "no ?view= and no ?show=");
  const s = await page("view=league&year=2026&show=scoring");
  t.deepEqual(seg(s.raw, "Columns"), [["Overall", false], ["Scoring", true]], "an explicit Scoring link still opens Scoring");
});
test("Weekly: Season Leaders, One Week, Team by Week, Heat Map, with Season Leaders the default; explicit links keep their view", async () => {
  const d = await page("view=weekly&year=2026");
  t.deepEqual(seg(d.raw, "Weekly view"), [["Season Leaders", true], ["One Week", false], ["Team by Week", false], ["Heat Map", false]]);
  t.match(d.h, /leaders-table/);
  const w = await page("view=weekly&year=2026&week=5");
  t.deepEqual(seg(w.raw, "Weekly view"), [["Season Leaders", false], ["One Week", true], ["Team by Week", false], ["Heat Map", false]], "a ?week= link opens that week");
  const tm = await page("view=weekly&year=2026&wv=team&team=0008");
  t.deepEqual(seg(tm.raw, "Weekly view").filter((x) => x[1]).map((x) => x[0]), ["Team by Week"]);
  const hm = await page("view=weekly&year=2026&wv=heat");
  t.deepEqual(seg(hm.raw, "Weekly view").filter((x) => x[1]).map((x) => x[0]), ["Heat Map"]);
  const one = await page("view=weekly&year=2026&wv=week");
  t.deepEqual(seg(one.raw, "Weekly view").filter((x) => x[1]).map((x) => x[0]), ["One Week"]);
});
test("History: no tab, and no 'historical data is being reviewed' notice, in any view or season; old links and the data stay", async () => {
  for (const q of ["year=2026", "view=divisions&year=2026", "view=picture&year=2026", "view=weekly&year=2026", "view=trends&year=2026", "view=eras&year=2026", "view=history&sub=hallOfChamps&year=2026", "year=2025"]) {
    const p = await page(q);
    t.deepEqual(tabs(p.h), ["Full League", "Divisions", "Playoff Picture", "Forecast", "Weekly", "Trends"], q + ": tabs");
    t.ok(!/Heads up|historical data is still being reviewed|may not be fully correct/i.test(p.h), q + ": no warning");
    t.ok(!/league history/i.test(p.h.replace(/<script[\s\S]*?<\/script>/g, "")) || /year=2025/.test(q), q + ": no History in the header");
  }
  t.ok(!/id="histWarn"/.test(SRC) && !/Heads up:/.test(SRC), "the notice's markup is gone from the page");
  t.ok(/HISTORY_VIEWS = \[/.test(SRC), "the History views' code is kept for the History pass");
  const old = await page("view=eras&year=2026");
  t.match(old.h, /3-Year Eras|Era/i, "an old ?view=eras link still opens its view");
});

await run("standings_desktop_cleanup");
