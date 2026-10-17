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
    if (u.pathname === "/api/standings" || u.pathname === "/api/historical-finishes") return workerFetch(callWorker, env)(u.href);
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
  // below the team above (vs_above), and -- when a tiebreak, not All-Play, put it ahead of the team below -- that too
  t.equal(why("0004"), "Seed 3: behind Gride on All-Play %. Ahead of CBP on head-to-head (same All-Play %, Overall record and season Points For).");
  t.equal(why("0007"), "Seed 5: behind CBP on All-Play %. Ahead of HammerTime on season Points For (same All-Play % and Overall record).");
  t.equal(why("0005"), "Seed 6: behind Sex Manther on season Points For (same All-Play % and Overall record).");
  t.match(why("0006"), /^Outside the top six — 6 AP wins back; behind CBP \(the last wild card\) on All-Play %\.$/);
  t.equal(out.byFranchise["0004"].whySeed.decidingCriterion, "all_play");
  t.equal(out.byFranchise["0004"].whySeed.aheadOf.step, "head_to_head");
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
    t.ok(j.weekly.filter((m) => m.w === 1).every((m) => m.po === null), "the worker passes the bad flag through as null (#1201), never 0");
    t.equal(j.standings_basis, "unavailable", "and seeds nobody from data it can't trust");
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

test("A2 projectedPlayoffGroups on the real response: games back come from the worker's rows; null weekly scores → unavailable (not 0.0); ties keep the worker's order", async () => {
  const RACE = raceModule();
  const okResp = await standings(makeLadderSeason());
  const ok = RACE.projectedPlayoffGroups(okResp.rows, okResp.weeklyScores);
  t.deepEqual(ok.byes.map((e) => e.franchise_id), ["0001", "0003"]);
  t.ok(ok.inTheHunt.every((e) => typeof e.apGB === "number"), "control: real games-back figures");
  // A failed weeklyScores query now means the worker seeds nobody (standings_basis 'unavailable')...
  const bad = await standings(makeLadderSeason({ failScores: true }));
  t.equal(bad.weeklyScores, null);
  t.equal(bad.standings_basis, "unavailable");
  t.ok(bad.rows.every((r) => r.playoff_seed === null));
  // ...and the client, handed seeded rows with null weekly scores, still never invents 0.0 games back.
  const g = RACE.projectedPlayoffGroups(okResp.rows, null);
  t.deepEqual(g.inTheHunt.map((e) => [e.franchise_id, e.apGB]), [["0006", 6], ["0008", 10]], "the worker's own ap_back, in the worker's ladder order (never a client 0.0)");
  t.ok(g.wildCards.every((e) => e.apGB === 0), "seeds 1-6 are 0 games back by definition");
  const rows = okResp.rows.slice(); const i6 = rows.findIndex((r) => r.franchise_id === "0006"), i8 = rows.findIndex((r) => r.franchise_id === "0008");
  [rows[i6], rows[i8]] = [rows[i8], rows[i6]];                 // pretend the worker ranked 0008 ahead
  t.deepEqual(RACE.projectedPlayoffGroups(rows, null).inTheHunt.map((e) => e.franchise_id), ["0008", "0006"]);
  // and the mobile Playoffs view hands the worker's weeklyScores over untouched
  // Mobile v3's Playoffs mode draws the projected BRACKET from the worker's bracket seeds (A2's chalk helper,
  // validated seeds; never re-seeded) and never coerces missing weekly scores to [].
  const LEAGUE = fs.readFileSync(new URL("../site/m/views/league.js", import.meta.url), "utf8");
  t.ok(/R\.projectChalkBracket\(seeds\)/.test(LEAGUE));
  t.ok(!/\.weeklyScores \|\| \[\]/.test(LEAGUE));
});

// ═══ the desktop page ═══
test("desktop: projected status chips, the league ladder note, and the worker's seed reason in each disclosure", async () => {
  const p = loadStandingsPage({ query: "view=overall&year=2026", fetch: workerFetch(callWorker, makeLadderSeason()) });
  await settle();
  const html = plain(p.html());
  t.match(html, /<span class="status-chip bye projected"[^>]*>BYE<small> proj\.<\/small><\/span>/);
  t.match(html, /Seeds: All-Play % → Overall → season Points For → head-to-head \(league rule §F\.1\)/);
  // v3: projected until the REGULAR season ends (race().seedsFinal), not the whole season
  t.match(html, /Seeds and BYE \/ DIV \/ WC are projected \(if the season ended today\) until the regular season ends\./);
  t.match(html, /Seed 3: behind Gride on All-Play %\. Ahead of CBP on head-to-head/);
  t.ok(!/Seeds derived AP % → Overall PCT → PF/.test(html), "the old stale note is gone");
  // v3 (Standings desktop): "Avg PF / Avg PA" were per-GAME averages in multi-game weeks; they are now PF per week and
  // PA per game, labeled, and the games-back figure is the worker's ap_back ("Back").
  t.match(html, /<th[^>]*>PF\/week<\/th>/, "PF per week, labeled");
  t.match(html, /<th[^>]*>PA\/game<\/th>/, "PA per game, labeled");
  t.ok(!/Avg PF|Avg PA/.test(html), "the per-game Avg PF / Avg PA labels are gone");
  t.match(html, /<th[^>]*title="All-Play wins behind the 6th seed"[^>]*>Back<\/th>/, "All-Play wins back beside it");
});
test("desktop: weekly results unreadable → race values '—' with a note; the Playoffs column '?' (#1201)", async () => {
  const p = loadStandingsPage({ query: "view=overall&year=2026", fetch: workerFetch(callWorker, makeLadderSeason({ failWeekly: true })) });
  await settle();
  const html = plain(p.html());
  t.match(html, /Expected wins and luck show —: the weekly results couldn’t be read\./);
  t.match(html, /Playoff records show <strong>\?<\/strong>: the weekly results couldn't be read\./);
  t.match(html, /Weekly results couldn’t be read\./, "the disclosure's week-by-week log says so — not 'No games played yet.'");
});
test("desktop: a recorded season says 'Seeds: the recorded final standings.' and each disclosure says recorded", async () => {
  const p = loadStandingsPage({ query: "view=overall&year=2026", fetch: workerFetch(callWorker, makeLadderSeason({ recorded: true })) });
  await settle();
  const html = plain(p.html());
  t.match(html, /Seeds: the recorded final standings\./);
  // v3: a finished season's /api/standings playoff_seed is a legacy recompute, so the disclosure states the RECORDED
  // finish (and the recorded seed when there is one) — never "Seed 1 — ..." from the legacy seed.
  t.match(html, /Finished 1st — from the recorded final standings\./);
  t.ok(!/Seed \d+ — from the recorded final standings/.test(html), "the legacy recompute is never shown as the seed");
  t.ok(!/league rule §F\.1/.test(html));
});

// ═══ the mobile view (Standings v3: Seeds / Divisions / Weekly / Playoffs) ═══
test("mobile Seeds: rows in the WORKER's seed order, chips marked projected, the cut line and the ladder explained", async () => {
  const html = await mobileStandings(makeLadderSeason());
  const order = [...html.matchAll(/<tr class="race-row[^"]*" data-fid="(\d{4})"/g)].map((m) => m[1]);
  t.deepEqual(order, ["0001", "0003", "0004", "0002", "0007", "0005", "0006", "0008"], "seed order (worker), not division winners → H2H% → PF");
  t.match(html, /aria-label="Projected playoff status: Bye">BYE<small>proj<\/small>/);
  t.match(html, /BYE \/ DIV \/ WC say where a team would be if the season ended today/);
  t.match(html, /<th class="num">AP%<\/th><th class="num">W-L<\/th><th class="num">Back<\/th>/);
  t.match(html, /Playoff line · 7-12 play the Hawktuah Bowl/);
  t.match(html, /<summary>How seeds work<\/summary>/);
  t.match(html, /Ladder: All-Play %, then record, then Points For, then head-to-head among the tied teams/);
  t.match(html, /<b>Tiebreaks:<\/b> .*Real|<b>Tiebreak/, "the summary names the tiebreaks that decided places");
});
test("mobile: weekly results unreadable → no team is ranked, and it says so (never 0-0, never a plausible table)", async () => {
  const html = await mobileStandings(makeLadderSeason({ failScores: true }));
  t.match(html, /Seeds unavailable\.<\/b> The weekly results couldn’t be verified, so no team is ranked\./);
  t.ok(!/ups-m-seeds-table/.test(html), "no seeds table");
});
test("mobile: a recorded season shows the recorded final standings, labeled, with no draft-order claim", async () => {
  const html = await mobileStandings(makeLadderSeason({ recorded: true }));
  t.match(html, /2026 · final standings/);
  t.match(html, /Recorded final standings\./);
  t.ok(!/draft order/i.test(html), "finish order is not draft order");
  t.ok(!/league rule|if the season ended today/.test(html));
});

await run("standings_race_worker_client");
mfl.restore();
restore();
