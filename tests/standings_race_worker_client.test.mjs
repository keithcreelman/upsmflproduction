// Phase II-A1 end to end: the REAL /api/standings route (worker harness, production D1 schemas) → the REAL
// site/shared/standings_race.js → the REAL desktop page (site/standings/mfl_hpm_standings_v2.html) and mobile view
// (site/m/views/league.js). Keith 2026-10-09:
//   - a failed weekly / weeklyScores query is "incomplete", never preseason, all the way to the screen;
//   - seeds are explained in the worker's own words (seed_reason), never by a client ladder;
//   - recorded seasons are labelled as recorded; in-season BYE / DIV / WC chips say "projected".
//   node tests/standings_race_worker_client.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { makeLadderSeason } from "./fixtures/standings_d1.mjs";
import { loadStandingsPage, workerFetch, settle } from "./fixtures/standings_v2_page.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();

const RACE_SRC = fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8");
function raceModule() { const w = {}; new Function("window", RACE_SRC)(w); return w.UPS_STANDINGS_RACE; }
const standings = async (env) => (await callWorker(env, "GET", "/api/standings?year=2026")).json;
const plain = (html) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

// ── the mobile league view, run for real (util helpers sliced from app.js) ──
const APP_SRC = fs.readFileSync(new URL("../site/m/app.js", import.meta.url), "utf8");
const utilSrc = ["safeStr", "safeInt", "pad4", "escapeHtml", "asArray"].map((name) => {
  const m = new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n|\\n  function ${name}\\([^)]*\\) \\{[^\\n]*\\}\\n`).exec(APP_SRC);
  if (!m) throw new Error("app.js: no " + name);
  return m[0];
}).join("");
async function mobileStandings(env) {
  const views = {};
  const mount = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
  const M = {
    state: { ctx: { year: 2026 }, viewerFranchiseId: "0001", franchises: [] },
    api: { workerUrl: (p) => "https://w.test" + p }, data: {},
    route: { registerView: (n, fn) => (views[n] = fn), renderRoute: () => views.league(mount, ["standings"]), navigate() {} },
  };
  const fetch = async (url) => {
    const u = new URL(url, "https://keithcreelman.github.io");
    if (u.pathname === "/api/standings") return workerFetch(callWorker, env)(u.href);
    return { ok: false, status: 404, json: async () => null };   // champions panels, historical finishes: none
  };
  const ctx = { window: { UPS_MOBILE: M }, document: { getElementById: () => null, addEventListener() {}, body: { style: {} } },
    fetch, console, setTimeout, clearTimeout, Promise, URL, Date, Math, JSON };
  vm.createContext(ctx);
  vm.runInContext(utilSrc + "window.UPS_MOBILE.util = { safeStr, safeInt, pad4, escapeHtml, asArray, fmtUsd: function (n) { return '$' + n; } };", ctx);
  vm.runInContext(RACE_SRC.replace("(typeof window !== 'undefined' ? window : this)", "(window)"), ctx);
  vm.runInContext(fs.readFileSync(new URL("../site/m/views/league.js", import.meta.url), "utf8"), ctx);
  views.league(mount, ["standings"]);
  await settle();
  M.route.renderRoute();
  await settle();
  return plain(mount.innerHTML);
}

// ═══ the race module on the real worker response ═══
test("race(): seed explanations are the worker's seed_reason, word for word — no client ladder", async () => {
  const RACE = raceModule();
  const j = await standings(makeLadderSeason());
  const out = RACE.race(j);
  t.equal(out.weeklyUnreadable, false);
  t.equal(out.projected, true, "season_complete is false");
  const why = (fid) => out.byFranchise[fid].whySeed.text;
  t.equal(why("0001"), "Seed 1: in the bye pool (the two best division winners); ranked ahead of Gride on Overall record.");
  t.equal(why("0004"), "Seed 3: in the seeds 3–6 pool; ranked ahead of CBP on head-to-head.");
  t.equal(why("0007"), "Seed 5: in the seeds 3–6 pool; ranked ahead of HammerTime on season Points For.");
  t.match(why("0006"), /^Outside the top six — .* behind CBP \(the last wild card\) on All-Play %\.$/);
  t.equal(out.byFranchise["0004"].whySeed.decidingCriterion, "head_to_head");
});
test("race(): a FAILED weekly or weeklyScores query (worker sends null + weekly_errors) is unavailable — never preseason zeros", async () => {
  const RACE = raceModule();
  for (const opt of [{ failWeekly: true }, { failScores: true }]) {
    const j = await standings(makeLadderSeason(opt));
    t.ok(j.weekly_errors, "the worker reports the failure");
    const out = RACE.race(j);
    t.equal(out.weeklyUnreadable, true);
    const r = out.byFranchise["0006"];
    t.equal(r.luck, null, "luck is unavailable, not 0");
    t.equal(r.expectedWins, null);
    if (opt.failScores) t.equal(r.apGB, null, "AP games back unavailable, not a preseason 0");
    if (opt.failWeekly) { t.equal(r.form5, null); t.equal(r.gameLog, null); }
    t.equal(out.preseason, false, "and nobody calls it preseason");
  }
});
test("race(): a RECORDED season is labelled recorded — no ladder step claimed", async () => {
  const out = raceModule().race(await standings(makeLadderSeason({ recorded: true })));
  t.ok(Object.values(out.byFranchise).every((r) => /from the recorded final standings\.$/.test(r.whySeed.text) && r.whySeed.decidingCriterion === null));
});

test("race() F3 through the real route: a MALFORMED playoff flag in D1 (sent as po: null) makes BOTH regular-season tables incomplete", async () => {
  const RACE = raceModule();
  // "x" reaches both tables (AP via weeklyScores, Overall via weekly); NULL can only be in src_schedule (Overall)
  for (const [po, apIncomplete] of [["x", true], [null, false]]) {
    const j = await standings(makeLadderSeason({ po }));
    t.ok(j.weekly.every((m) => m.po === null), "the worker passes the bad flag through as null (#1201), never 0");
    const fids = j.rows.map((r) => r.franchise_id);
    t.equal(RACE.deriveRegSeasonOverallTable(j.weekly, fids).status, "incomplete", "Overall: " + po);
    t.equal(RACE.deriveRegSeasonApTable(j.weeklyScores, fids).status, apIncomplete ? "incomplete" : "ok", "AP: " + po);
    const out = RACE.race(j);
    t.equal(out.byFranchise["0006"].luck, null, "luck needs both tables — unavailable, never a guess");
    if (apIncomplete) t.equal(out.byFranchise["0006"].apGB, null, "AP games back unavailable");
    t.equal(out.weeklyUnreadable, false, "readable but untrustworthy — not the same as a failed query");
  }
  const ok = RACE.race(await standings(makeLadderSeason()));
  t.notEqual(ok.byFranchise["0006"].apGB, null, "control: clean flags give a real AP games back");
});

test("A2 projectedPlayoffGroups on the real response: failed weeklyScores → games back unavailable (not 0.0); outside teams in the worker's order", async () => {
  const RACE = raceModule();
  const ok = RACE.projectedPlayoffGroups((await standings(makeLadderSeason())).rows, (await standings(makeLadderSeason())).weeklyScores);
  t.deepEqual(ok.byes.map((e) => e.franchise_id), ["0001", "0003"]);
  t.ok(ok.inTheHunt.every((e) => typeof e.apGB === "number"), "control: real games-back figures");
  const bad = await standings(makeLadderSeason({ failScores: true }));
  t.equal(bad.weeklyScores, null);
  const g = RACE.projectedPlayoffGroups(bad.rows, bad.weeklyScores);
  t.deepEqual(g.inTheHunt.map((e) => [e.franchise_id, e.apGB]), [["0006", null], ["0008", null]], "unavailable, and in the worker's ladder order");
  t.ok(g.wildCards.every((e) => e.apGB === 0), "seeds 1-6 are 0 games back by definition");
  // equal games back → the WORKER's order (its ladder), not franchise-id order
  const rows = bad.rows.slice(); const i6 = rows.findIndex((r) => r.franchise_id === "0006"), i8 = rows.findIndex((r) => r.franchise_id === "0008");
  [rows[i6], rows[i8]] = [rows[i8], rows[i6]];                 // pretend the worker ranked 0008 ahead
  t.deepEqual(RACE.projectedPlayoffGroups(rows, bad.weeklyScores).inTheHunt.map((e) => e.franchise_id), ["0008", "0006"]);
  // and the mobile Playoffs view hands the worker's weeklyScores over untouched
  const LEAGUE = fs.readFileSync(new URL("../site/m/views/league.js", import.meta.url), "utf8");
  t.ok(/projectedPlayoffGroups\(stdResp\.rows \|\| \[\], stdResp\.weeklyScores\)/.test(LEAGUE));
  t.ok(!/stdResp\.weeklyScores \|\| \[\]/.test(LEAGUE));
});

// ═══ the desktop page ═══
test("desktop: projected status chips, the league ladder note, and the worker's seed reason in each disclosure", async () => {
  const p = loadStandingsPage({ query: "view=overall&year=2026", fetch: workerFetch(callWorker, makeLadderSeason()) });
  await settle();
  const html = plain(p.html());
  t.match(html, /<span class="status-chip bye projected"[^>]*>BYE<small> proj\.<\/small><\/span>/);
  t.match(html, /Seeds: All-Play % → Overall → season Points For → head-to-head \(league rule §F\.1\)/);
  t.match(html, /Seeds and BYE \/ DIV \/ WC are projected until the season ends\./);
  t.match(html, /Seed 3: in the seeds 3–6 pool; ranked ahead of CBP on head-to-head\./);
  t.ok(!/Seeds derived AP % → Overall PCT → PF/.test(html), "the old stale note is gone");
  t.match(html, /<th[^>]*>.*Avg PF/, "main's Avg PF label kept (decision 4)");
  t.match(html, /AP GB/, "AP GB added beside it");
});
test("desktop: weekly results unreadable → race values '—' with a note; the Playoffs column '?' (#1201)", async () => {
  const p = loadStandingsPage({ query: "view=overall&year=2026", fetch: workerFetch(callWorker, makeLadderSeason({ failWeekly: true })) });
  await settle();
  const html = plain(p.html());
  t.match(html, /AP GB, Luck, Form and the AP-rank trend show — : the weekly results couldn’t be read\./);
  t.match(html, /Playoff records show <strong>\?<\/strong>: the weekly results couldn't be read\./);
  t.match(html, /Weekly results couldn’t be read\./, "the disclosure's week-by-week log says so — not 'No games played yet.'");
});
test("desktop: a recorded season says 'Seeds: the recorded final standings.' and each disclosure says recorded", async () => {
  const p = loadStandingsPage({ query: "view=overall&year=2026", fetch: workerFetch(callWorker, makeLadderSeason({ recorded: true })) });
  await settle();
  const html = plain(p.html());
  t.match(html, /Seeds: the recorded final standings\./);
  t.match(html, /Seed 1 — from the recorded final standings\./);
  t.ok(!/league rule §F\.1/.test(html));
});

// ═══ the mobile view ═══
test("mobile: rows in the WORKER's seed order, chips marked projected, the league ladder named", async () => {
  const html = await mobileStandings(makeLadderSeason());
  const order = [...html.matchAll(/data-fid="(\d{4})"/g)].map((m) => m[1]);
  t.deepEqual(order, ["0001", "0003", "0004", "0002", "0007", "0005", "0006", "0008"], "seed order (worker), not division winners → H2H% → PF");
  t.match(html, /aria-label="Projected playoff status: Bye">BYE<small>proj<\/small>/);
  t.match(html, /Ordered by playoff seed — All-Play % → Overall → season PF → head-to-head \(league rule\)\./);
  t.match(html, /<th>GB<\/th><th>PF<\/th>/, "main's PF label kept, GB added (decision 4)");
});
test("mobile: weekly results unreadable → said in the legend; GB '—'; never 0-0", async () => {
  const html = await mobileStandings(makeLadderSeason({ failScores: true }));
  t.match(html, /Weekly results couldn’t be read — GB, form and luck show —\./);
  const gb = [...html.matchAll(/<tr class="[^"]*race-row"[\s\S]*?<\/tr>/g)].map((m) => [...m[0].matchAll(/<td class="num">([^<]*)<\/td>/g)].map((x) => x[1]));
  t.ok(gb.length === 8 && gb.every((cells) => cells.includes("0.0") || cells.includes("—")), "seeded teams 0.0 by definition; the rest —");
  t.ok(gb.some((cells) => cells.includes("—")));
});
test("mobile: a recorded season is ordered and labelled as recorded", async () => {
  const html = await mobileStandings(makeLadderSeason({ recorded: true }));
  t.match(html, /Ordered by the recorded final standings\./);
  t.ok(!/league rule/.test(html));
});

await run("standings_race_worker_client");
mfl.restore();
restore();
