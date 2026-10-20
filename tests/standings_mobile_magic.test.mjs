// Mobile magic numbers (#1329): the Seeds table's M# column, the Magic numbers drawer and the line under each division
// card. Runs the REAL mobile view (site/m/views/league.js) on the REAL /api/standings route for the recorded 2026
// season after Week 5, with MFL's own 2026 schedule export (tests/fixtures/mfl_2026_schedule.json) answering the
// worker's export proxy — and once with that read failing. Numbers worked by hand in standings_magic_numbers.test.mjs.
//   node scripts/safe_tests/run.mjs --only standings_mobile_magic
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";
import { settle } from "./fixtures/standings_v2_page.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
mfl.st.league = { standingsSort: REC.standingsSort };
const SCHED = fs.readFileSync(new URL("./fixtures/mfl_2026_schedule.json", import.meta.url), "utf8");
const RACE_SRC = fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8");
const APP_SRC = fs.readFileSync(new URL("../site/m/app.js", import.meta.url), "utf8");
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");
const utilSrc = ["safeStr", "safeInt", "pad4", "escapeHtml", "asArray"].map((name) => {
  const m = new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n|\\n  function ${name}\\([^)]*\\) \\{[^\\n]*\\}\\n`).exec(APP_SRC);
  if (!m) throw new Error("app.js: no " + name);
  return m[0];
}).join("");

async function boot({ scheduleFails } = {}) {
  const env = loadSeason(makeWorkerEnv({}), recorded2026(REC));
  const views = {};
  const mount = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
  const M = { state: { ctx: { year: 2026 }, viewerFranchiseId: "0008", franchises: [] }, api: { workerUrl: (p) => "https://w.test" + p }, data: {},
    route: { registerView: (n, fn) => (views[n] = fn), renderRoute: () => views.league(mount, ["standings"]), navigate() {} } };
  const fetched = [];
  const json = (j, status) => ({ ok: (status || 200) < 400, status: status || 200, json: async () => j });
  const fetch = async (url) => {
    const u = new URL(url, "https://keithcreelman.github.io");
    fetched.push(u.pathname + u.search);
    if (u.pathname === "/api/mfl-export" && u.searchParams.get("TYPE") === "schedule") return scheduleFails ? json({ error: "x" }, 502) : json(JSON.parse(SCHED));
    if (u.pathname === "/api/standings" || u.pathname === "/api/playoff-bracket") return json((await callWorker(env, "GET", u.pathname + u.search)).json);
    return json(null, 404);
  };
  const document = { getElementById: () => null, addEventListener() {}, body: { style: {} }, activeElement: null };
  const ctx = { window: { UPS_MOBILE: M }, document, fetch, console, setTimeout, clearTimeout, Promise, URL, Date, Math, JSON };
  vm.createContext(ctx);
  vm.runInContext(utilSrc + "window.UPS_MOBILE.util = { safeStr, safeInt, pad4, escapeHtml, asArray, fmtUsd: function (n) { return '$' + n; } };", ctx);
  vm.runInContext(RACE_SRC.replace("(typeof window !== 'undefined' ? window : this)", "(window)"), ctx);
  vm.runInContext(fs.readFileSync(new URL("../site/m/standings_sheets.js", import.meta.url), "utf8"), ctx);
  vm.runInContext(fs.readFileSync(new URL("../site/m/views/league.js", import.meta.url), "utf8"), ctx);
  const show = async (o) => { M.leagueView.setStandingsView(o); views.league(mount, ["standings"]); await settle(); M.route.renderRoute(); await settle(); M.route.renderRoute(); await settle(); return mount.innerHTML; };
  return { M, show, fetched };
}
const cell = (html, fid) => { const m = new RegExp(`data-fid="${fid}"[\\s\\S]*?<td class="num magic">([\\s\\S]*?)</td>`).exec(html); return m ? plain(m[1]).trim() : null; };

test("Seeds: an M# column with each seed's magic number (division for BYE/DIV rows, wild card for WC rows), blank for H1-H6", async () => {
  const b = await boot();
  const html = await b.show({ mode: "seeds", year: 2026 });
  t.match(html, /<th class="num">Back<\/th><th class="num magic" title="Magic number">M#<\/th>/);
  t.deepEqual(["0009", "0010", "0005", "0008", "0002", "0004"].map((f) => cell(html, f)), ["20", "23", "22", "22", "97", "98"]);
  t.equal(cell(html, "0012"), "", "H1 Hawks: no magic number");
  t.match(html, /data-info="magic"[^>]*>Magic numbers<\/button>/);
  t.equal(b.fetched.filter((u) => u.startsWith("/api/mfl-export?TYPE=schedule")).length, 1, "MFL's schedule is read once");
  t.ok(b.fetched.some((u) => u === "/api/mfl-export?TYPE=schedule&L=74598&YEAR=2026&JSON=1"));
});
test("The Magic numbers drawer names each race in words", async () => {
  const b = await boot();
  const html = await b.show({ mode: "seeds", year: 2026 });
  t.ok(html.length > 0);
  const resp = (await callWorker(loadSeason(makeWorkerEnv({}), recorded2026(REC)), "GET", "/api/standings?year=2026")).json;
  const d = plain(b.M.leagueView.standingsDrawers.magic(resp, JSON.parse(SCHED)));
  t.match(d, /Through Week 5 of 14 · 9 weeks left\./);
  t.match(d, /Division \(H2H\) C-Town Chivalry 20 ?: its H2H wins \+ Cleon Ca\$h H2H losses\./);
  t.match(d, /Blake Bombers 23 ?: its H2H wins \+ CBP H2H losses\./);
  t.match(d, /Wild card \(All-Play, vs the first team out\) CBP 97 ?: its All-Play wins \+ Hawks All-Play losses\. Pure Greatness 98/);
  t.match(d, /at 0 the rival can’t catch up\. Ties count half and never finish the job\. All-Play gives 11 results a week/);
  t.ok(!/✓/.test(d), "nothing is clinched after Week 5");
  const noSched = plain(b.M.leagueView.standingsDrawers.magic(resp, null));
  t.match(noSched, /Division \(H2H\) MFL’s schedule couldn’t be read, so the division numbers aren’t shown\./);
  t.match(noSched, /CBP 97/, "the wild-card numbers need no schedule");
});
test("Divisions: one magic-number line under each card", async () => {
  const b = await boot();
  const p = plain(await b.show({ mode: "divisions", year: 2026 }));
  t.match(p, /Magic number 20 ?: C-Town Chivalry H2H wins \+ Cleon Ca\$h H2H losses\./);
  t.match(p, /Magic number 23 ?: Blake Bombers H2H wins \+ CBP H2H losses\./);
  t.match(p, /Magic number 22 ?: HammerTime\S* H2H wins \+ Pure Greatness H2H losses\./);
  t.match(p, /Magic number 22 ?: Real Deal Creel H2H wins \+ L\.A\. Looks H2H losses\./);
});
test("MFL's schedule fails to load: division numbers say —, the cards say why, the wild cards still show", async () => {
  const b = await boot({ scheduleFails: true });
  const html = await b.show({ mode: "seeds", year: 2026 });
  t.deepEqual(["0009", "0010", "0005", "0008", "0002", "0004"].map((f) => cell(html, f)), ["—", "—", "—", "—", "97", "98"]);
  const p = plain(await b.show({ mode: "divisions", year: 2026 }));
  t.equal((p.match(/Magic number: MFL’s schedule couldn’t be read, so the division numbers aren’t shown\./g) || []).length, 4);
  t.ok(!/Magic number \d/.test(p), "no number without a schedule");
});
test("A finished season shows no magic numbers and never reads the schedule", async () => {
  const b = await boot();
  const resp = (await callWorker(loadSeason(makeWorkerEnv({}), recorded2026(REC)), "GET", "/api/standings?year=2026")).json;
  resp.regular_season.complete = true;
  const d = plain(b.M.leagueView.standingsDrawers.magic(resp, JSON.parse(SCHED)));
  t.match(d, /Magic numbers appear while the regular season is being played\./);
  t.equal(b.fetched.filter((u) => u.includes("TYPE=schedule")).length, 0);
});

await run();
restore();
