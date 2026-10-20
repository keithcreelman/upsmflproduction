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
let lastMobile = null;   // the mobile app object of the latest mobileStandings() run (drawer content lives there)
async function mobileStandings(env) {
  const views = {};
  const mount = { innerHTML: "", querySelectorAll: () => [], querySelector: () => null, addEventListener() {} };
  const M = {
    state: { ctx: { year: 2026 }, viewerFranchiseId: "0001", franchises: [] },
    api: { workerUrl: (p) => "https://w.test" + p }, data: {},
    route: { registerView: (n, fn) => (views[n] = fn), renderRoute: () => views.league(mount, ["standings"]), navigate() {} },
  };
  lastMobile = M;
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
  t.equal(why("0001"), "Seed 1: in the bye pool (the two best division winners); ranked ahead of Gride on H2H record.");
  // below the team above (vs_above), and -- when a tiebreak, not All-Play, put it ahead of the team below -- that too
  t.equal(why("0004"), "Seed 3: behind Gride on All-Play %. Ahead of CBP on the H2H games between them (same All-Play %, H2H record and season Points For).");
  t.equal(why("0007"), "Seed 5: behind CBP on All-Play %. Ahead of HammerTime on season Points For (same All-Play % and H2H record).");
  t.equal(why("0005"), "Seed 6: behind Sex Manther on season Points For (same All-Play % and H2H record).");
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
  t.ok(Object.values(out.byFranchise).every((r) => /^From the recorded final standings \(see the finish and the recorded seed\)\.$/.test(r.whySeed.text) && r.whySeed.decidingCriterion === null));
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
  t.match(html, /Seeds and BYE \/ DIV \/ WC are projected until the season ends\./);
  t.match(html, /Seed 3: behind Gride on All-Play %\. Ahead of CBP on the H2H games between them/);
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
  t.match(html, /From the recorded final standings \(see the finish and the recorded seed\)\./);
  t.ok(!/Seed 1 — from the recorded/.test(html), "no seed number from the recompute (#1329)");
  t.ok(!/league rule §F\.1/.test(html));
});

// ═══ the mobile view (Standings v3: Seeds / Divisions / Weekly / Playoffs) ═══
test("mobile Seeds: rows in the WORKER's seed order, chips marked projected, the cut line and the ladder explained", async () => {
  const html = await mobileStandings(makeLadderSeason());
  const order = [...html.matchAll(/<tr class="race-row[^"]*" data-fid="(\d{4})"/g)].map((m) => m[1]);
  t.deepEqual(order, ["0001", "0003", "0004", "0002", "0007", "0005", "0006", "0008"], "seed order (worker), not division winners → H2H% → PF");
  t.match(html, /aria-label="Projected playoff status: Bye">BYE<small>proj<\/small>/);
  t.match(html, /<th class="num">AP%<\/th><th class="num">H2H<\/th><th class="num">Back<\/th>/, "H2H, not W-L or Games");
  t.match(html, /Playoff line · H1–H6 play the Hawk Tuah Bowl/);
  // v3.1 (#1329 review): the Hawk Tuah Bowl seeds show on the first page (7th and 8th of this 8-team fixture = H1, H2)
  t.match(html, /<td class="rank">H1<\/td><td class="team"><span class="name-text">[^<]+<\/span>/);
  t.match(html, /data-jump-side="hawk">Hawk Tuah Bowl<\/button>/, "a Hawk Tuah Bowl button beside the seeds");
  // explanations are behind three compact buttons, not on the page
  t.match(html, /data-info="how"[^>]*>How seeding works<\/button><button[^>]*data-info="why"[^>]*>Why this order<\/button><button[^>]*data-info="magic"[^>]*>Magic numbers<\/button><button[^>]*data-info="about"[^>]*>About<\/button>/);
  // Magic numbers (#1329): an M# column for seeds 1-6. This fixture has no MFL schedule, so the division rows say —
  // (never a guessed number) while the wild-card rows, which need no schedule, show theirs.
  t.match(html, /<th class="num">Back<\/th><th class="num magic" title="Magic number">M#<\/th>/);
  t.match(html, /data-fid="0001"[\s\S]*?<td class="num magic">—<\/td>/, "a division row without a schedule: —");
  t.match(html, /data-fid="0004"[\s\S]*?<td class="num magic"><span class="ups-m-magic">\d+<\/span><\/td>/, "a wild-card row: its number");
  t.ok(!/Ladder: All-Play %|say where a team would be/.test(html), "no explanatory paragraphs on the page itself");
  const D = lastMobile.leagueView.standingsDrawers;
  t.match(plain(D.how()), /Ladder: All-Play %, then H2H record, then Points For, then the H2H games between the tied teams\. Only regular-season weeks count\./);
  t.match(plain(D.how()), /Hawk Tuah Bowl champion \(7th\) 1\.01 .* 5th-place game winner \(5th\) 1\.07 · its loser \(6th\) 1\.08/);
  t.match(plain(D.about(false)), /“proj” = where a team would be if the season ended today\./);
  const why = plain(D.why(await standings(makeLadderSeason())));
  t.match(why, /Decided by a tiebreak:<\/b>.*<li>L\.A\. Looks over Gride: same All-Play, a better H2H record \(4-0 vs 3-1\)\.<\/li><li>Pure Greatness over CBP: same All-Play, the H2H games between them\.<\/li>/, "the drawer names the tiebreaks that decided places");
  t.match(why, /<b>Next out:<\/b> Team 0006, 6 All-Play wins behind HammerTime \(6th\)\./);
  const all = html + D.how() + D.about(false) + D.weekly();
  t.ok(!/\bGames\b/.test(all), "no 'Games' label");
  t.ok(!/\bprize\b/i.test(all), "a top score is never called a prize (the rules aren't settled)");
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
