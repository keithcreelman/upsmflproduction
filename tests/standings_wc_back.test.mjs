// WC Back (#1329, Keith 2026-10-20): a team outside the playoff field is chasing the LAST WILD CARD, never a division
// winner. The four division winners are protected, so measuring "Back" against the 6th seed was wrong whenever the 6th
// seed was a division winner: after 2026 Week 6 Real Deal Creel (division winner, All-Play 33-33) is the 6th seed, and
// Hawks (34-32, a BETTER All-Play record) sat outside showing Back −1.
// The REAL /api/standings route (worker harness, production D1 schemas) on the recorded 2026 season through Week 6
// (tests/fixtures/standings_2026_wk5.json + standings_2026_wk6_week.json, MFL's public exports) → the REAL shared module →
// the REAL desktop page and the REAL mobile view. Every expected value is worked out here from the response's own
// All-Play records and statuses, never read back from the figure under test.
//   node scripts/safe_tests/run.mjs --only standings_wc_back
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";
import { loadStandingsPage, workerFetch, settle } from "./fixtures/standings_v2_page.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
const WK6 = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk6_week.json", import.meta.url), "utf8"));
mfl.st.league = { standingsSort: REC.standingsSort };
const RACE_SRC = fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8");
const RACE = (() => { const w = {}; new Function("window", RACE_SRC)(w); return w.UPS_STANDINGS_RACE; })();
const plain = (html) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html) => plain(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

const season6 = () => { const s = recorded2026(REC); return { ...s, weeklyScores: s.weeklyScores.concat(WK6.weekly_scores), games: s.games.concat(WK6.games) }; };
const ENV6 = loadSeason(makeWorkerEnv({}), season6());
const RESP6 = (await callWorker(ENV6, "GET", "/api/standings?year=2026")).json;
const by = Object.fromEntries(RESP6.rows.map((r) => [r.franchise_id, r]));
const apWins = (r) => r.regular_season.all_play.w + 0.5 * r.regular_season.all_play.t;
const inField = RESP6.rows.filter((r) => r.playoff_seed != null);
const outside = RESP6.rows.filter((r) => r.playoff_seed == null);
const lastWC = inField.filter((r) => r.playoff_status === "wild_card").sort((a, b) => b.playoff_seed - a.playoff_seed)[0];
const divWinners = inField.filter((r) => r.playoff_status === "division_winner" || r.playoff_status === "bye");
const BEFORE = { "0012": -1, "0011": 4, "0001": 10, "0006": 12, "0003": 15, "0007": 22 };   // the released worker, measured against the 6th seed

// ═══ the worker ═══
test("Week 6 is the regression case: Hawks has a better All-Play record than the protected division-winner 6th seed and is still outside", () => {
  t.equal(RESP6.regular_season.through_week, 6);
  for (const r of RESP6.rows) t.deepEqual([r.regular_season.record.w, r.regular_season.record.l], WK6.mfl_h2h_after_week6[r.franchise_id], r.franchise_id + " H2H = MFL's leagueStandings after Week 6");
  const rdc = by["0008"], hawks = by["0012"];
  t.equal(rdc.playoff_seed, 6); t.equal(rdc.playoff_status, "division_winner");
  t.equal(hawks.playoff_seed, null);
  t.ok(apWins(hawks) > apWins(rdc), "Hawks 34-32 All-Play beats Real Deal Creel 33-33 ...");
  t.equal(RESP6.regular_season.next_out, "0012", "... yet Hawks is the first team out: a better All-Play record never takes a division winner's place");
  t.equal(lastWC.franchise_id, "0004", "the last wild card is Pure Greatness (seed 5)");
  t.equal(lastWC.playoff_seed, 5);
});
test("worker ap_back = All-Play wins behind the LAST WILD CARD for all six teams outside; null for seeds 1-6; never negative", () => {
  for (const r of inField) t.equal(r.ap_back, null, r.franchise_id + " is in the field: no WC Back");
  for (const r of outside) {
    t.equal(r.ap_back, apWins(lastWC) - apWins(r), r.franchise_name + " vs " + lastWC.franchise_name);
    t.ok(r.ap_back >= 0, r.franchise_name + " never negative");
  }
  t.deepEqual(Object.fromEntries(outside.map((r) => [r.franchise_id, r.ap_back])), { "0012": 5, "0011": 10, "0001": 16, "0006": 18, "0003": 21, "0007": 28 });
  t.deepEqual(Object.fromEntries(outside.map((r) => [r.franchise_id, apWins(by["0008"]) - apWins(r)])), BEFORE, "control: the old yardstick (the 6th seed) gives the released values, Hawks −1");
});
test("a division winner is never the comparator: no team's WC Back matches the gap to any division winner that isn't the last wild card", () => {
  for (const r of outside) for (const d of divWinners) {
    if (apWins(d) === apWins(lastWC)) continue;   // the same number either way: nothing to tell apart
    t.notEqual(r.ap_back, apWins(d) - apWins(r), r.franchise_name + " is not measured against " + d.franchise_name);
  }
});

// ═══ the shared module ═══
test("shared module: the worker's figure passes through; the fallback (no ap_back) measures against the last wild card; a negative reads as unavailable", () => {
  const gb = RACE.apGamesBack(RESP6.rows, RESP6.weeklyScores);
  for (const r of outside) t.equal(gb[r.franchise_id], r.ap_back);
  const noWorker = RESP6.rows.map((r) => { const c = JSON.parse(JSON.stringify(r)); delete c.ap_back; delete c.regular_season; return c; });
  const fb = RACE.apGamesBack(noWorker, RESP6.weeklyScores);
  for (const r of outside) t.equal(fb[r.franchise_id], apWins(lastWC) - apWins(r), "fallback " + r.franchise_name);
  t.equal(fb["0012"], 5, "never max(0, RDC − Hawks) = 0");
  const old = RESP6.rows.map((r) => (r.franchise_id === "0012" ? { ...r, ap_back: -1 } : r));   // a worker older than this rule
  t.equal(RACE.apGamesBack(old, RESP6.weeklyScores)["0012"], null, "a negative figure is unavailable, never shown");
  const why = RACE.whySeedForRow(by["0012"], RESP6.rows, RESP6.weeklyScores).text;
  t.match(why, /^Outside the top six — 5 AP wins back; behind Pure Greatness \(the last wild card\) on All-Play %\./);
  t.ok(!/ahead of the sixth seed/.test(why));
  t.equal(RACE.whySeedForRow(old[RESP6.rows.findIndex((r) => r.franchise_id === "0012")], old, RESP6.weeklyScores).text.split(";")[0], "Outside the top six — AP games back unavailable");
});

// ═══ the desktop page ═══
async function desktop(query, fetchOverride) {
  const p = loadStandingsPage({ query, fetch: fetchOverride || workerFetch(callWorker, ENV6) });
  await new Promise((r) => setTimeout(r, 2700));   // the in-season magic numbers wait up to 2.5 s for MFL's schedule
  await settle();
  return plain(p.html());
}
test("desktop Playoff Picture, Week 6: In the hunt 'WC Back' 5 / 10 / 16 / 18 / 21 / 28; Next out names the last wild card, not the division winner", async () => {
  const h = await desktop("view=picture&year=2026");
  t.match(h, /<th class="num" scope="col" title="All-Play wins behind the last wild card \(division winners are protected\)">WC Back<\/th>/);
  const hunt = [...h.matchAll(/<tr class="hunt-row[^"]*"[^>]*data-toggle="(\d{4})">([\s\S]*?)<\/tr>/g)].map((m) => [m[1], text([...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]).pop()).trim()]);
  t.deepEqual(hunt, outside.map((r) => [r.franchise_id, String(apWins(lastWC) - apWins(r))]));
  t.match(h, /<b>Next out:<\/b> Hawks, 5 All-Play wins behind Pure Greatness \(the last wild card\)\./);
  t.ok(!/ahead of Real Deal Creel|\(6th\)|behind the 6th seed/.test(h), "no division-winner yardstick anywhere");
  t.match(h, /· WC Back 5<\/div>/, "the Next team out panel");
});
test("desktop Full League, Week 6: the 'WC Back' column is signed for every team (Keith 2026-10-22)", async () => {
  const h = await desktop("view=league&year=2026");
  const tbl = /<table class="lg-table"><thead>([\s\S]*?)<\/thead><tbody>([\s\S]*?)<\/tbody><\/table>/.exec(h);
  const heads = [...tbl[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]).trim());
  t.ok(heads.includes("WC Back") && !heads.includes("Back"), heads.join(", "));
  const col = heads.indexOf("WC Back");
  const rows = [...tbl[2].matchAll(/<tr class="(?:you-row )?race-row"[^>]*data-fid="(\d{4})">([\s\S]*?)<\/tr>/g)].map((m) => [m[1], text([...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)][col][1]).trim()]);
  // Keith 2026-10-22: signed, for every team, as if it had to earn a wild card. Recomputed here from the rows alone:
  // the pool = every non-division-winner plus the team; two wild cards by the ladder (All-Play %, H2H %, PF).
  const nonDw = RESP6.rows.filter((r) => !r.is_division_leader);
  const lad = (a, b) => (b.regular_season.all_play.pct - a.regular_season.all_play.pct) || (b.regular_season.record.pct - a.regular_season.record.pct) || (b.regular_season.points_for - a.regular_season.points_for);
  const signed = (r) => {
    const pool = nonDw.filter((x) => x.franchise_id !== r.franchise_id).concat([r]).sort(lad);
    const i = pool.indexOf(r), m = i < 2 ? apWins(pool[2]) - apWins(r) : apWins(pool[1]) - apWins(r);
    return m > 0 ? "+" + m : m < 0 ? "−" + Math.abs(m) : "0";
  };
  t.deepEqual(rows, RESP6.rows.map((r) => [r.franchise_id, signed(r)]));
  // The six outside: the same gap as before, now with a +; the old figure is the worker's ap_back.
  RESP6.rows.filter((r) => r.playoff_seed == null).forEach((r) => t.equal(rows.find((x) => x[0] === r.franchise_id)[1], "+" + (apWins(lastWC) - apWins(r))));
});
test("desktop: a negative figure from an older worker is never shown (— instead), and Next out then gives no number", async () => {
  const real = workerFetch(callWorker, ENV6);
  const fetch = async (url) => {
    const r = await real(url);
    if (new URL(url).pathname !== "/api/standings") return r;
    const j = await r.json();
    return { ...r, json: async () => ({ ...j, rows: j.rows.map((x) => (x.franchise_id === "0012" ? { ...x, ap_back: -1 } : x)) }) };
  };
  const h = await desktop("view=picture&year=2026", fetch);
  t.ok(!/>-1<|>−1</.test(h), "no negative cell");
  t.match(h, /<b>Next out:<\/b> Hawks\./);
  const hawks = /<tr class="hunt-row[^"]*"[^>]*data-toggle="0012">([\s\S]*?)<\/tr>/.exec(h)[1];
  t.equal(text([...hawks.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].pop()[1]).trim(), "—");
});

// ═══ the mobile view (same worker figure; its copy named the 6th seed) ═══
const APP_SRC = fs.readFileSync(new URL("../site/m/app.js", import.meta.url), "utf8");
const utilSrc = ["safeStr", "safeInt", "pad4", "escapeHtml", "asArray"].map((name) => {
  const m = new RegExp(`\\n  function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n  \\}\\n|\\n  function ${name}\\([^)]*\\) \\{[^\\n]*\\}\\n`).exec(APP_SRC);
  if (!m) throw new Error("app.js: no " + name);
  return m[0];
}).join("");
async function mobile() {
  const views = {};
  const mount = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
  const M = {
    state: { ctx: { year: 2026 }, viewerFranchiseId: "0008", franchises: [] },
    api: { workerUrl: (p) => "https://w.test" + p }, data: {},
    route: { registerView: (n, fn) => (views[n] = fn), renderRoute: () => views.league(mount, ["standings"]), navigate() {} },
  };
  const fetch = async (url) => {
    const u = new URL(url, "https://keithcreelman.github.io");
    if (u.pathname === "/api/standings" || u.pathname === "/api/historical-finishes") return workerFetch(callWorker, ENV6)(u.href);
    return { ok: false, status: 404, json: async () => null };
  };
  const ctx = { window: { UPS_MOBILE: M }, document: { getElementById: () => null, addEventListener() {}, body: { style: {} } },
    fetch, console, setTimeout, clearTimeout, Promise, URL, Date, Math, JSON };
  vm.createContext(ctx);
  vm.runInContext(utilSrc + "window.UPS_MOBILE.util = { safeStr, safeInt, pad4, escapeHtml, asArray, fmtUsd: function (n) { return '$' + n; } };", ctx);
  vm.runInContext(RACE_SRC.replace("(typeof window !== 'undefined' ? window : this)", "(window)"), ctx);
  vm.runInContext(fs.readFileSync(new URL("../site/m/views/league.js", import.meta.url), "utf8"), ctx);
  views.league(mount, ["standings"]);
  await new Promise((r) => setTimeout(r, 2700));
  await settle();
  M.route.renderRoute();
  await new Promise((r) => setTimeout(r, 2700));
  await settle();
  return { html: plain(mount.innerHTML), drawers: M.leagueView.standingsDrawers };
}
test("mobile, Week 6: the Back column (the same worker figure) reads 5 / 10 / 16 / 18 / 21 / 28, and 'Next out' names the last wild card", async () => {
  const m = await mobile();
  const back = [...m.html.matchAll(/<tr class="race-row[^"]*" data-fid="(\d{4})"[^>]*>([\s\S]*?)<\/tr>/g)]
    .map((x) => [x[1], [...x[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]).trim())]);
  const backCol = (cells) => cells[4];   // Seed · Team · AP% · H2H · Back
  t.deepEqual(back.map(([fid, cells]) => [fid, backCol(cells)]), RESP6.rows.map((r) => [r.franchise_id, r.playoff_seed == null ? String(apWins(lastWC) - apWins(r)) : "—"]));
  t.match(m.html, /<b>Next out:<\/b> Hawks, 5 AP wins back/);
  const why = plain(m.drawers.why(RESP6));
  t.match(why, /<b>Next out:<\/b> Hawks, 5 All-Play wins behind Pure Greatness \(the last wild card\)\./);
  t.ok(!/\(6th\)/.test(why), "the 6th seed is never named as the yardstick");
  t.match(plain(m.drawers.about(false)), /All-Play wins behind the last wild card \(ties count half\)\. Division winners are protected, so it is never measured against one\./);
});

await run("standings_wc_back");
mfl.restore();
restore();
