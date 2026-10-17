// Standings v3 — the DESKTOP page (site/standings/mfl_hpm_standings_v2.html), run for real (tests/fixtures/
// standings_v2_page.mjs) against REAL worker responses: the /api/standings, /api/playoff-bracket,
// /api/historical-finishes and /api/eras routes of worker/src/index.js on the harness D1 (production schemas).
//   - the recorded 2026 season after Week 5 (tests/fixtures/standings_2026_wk5.json);
//   - a small finished 12-team season (one regular week + a full playoff bracket, recorded finishes);
//   - a multi-season history with an ownership change (Historical Finishes / 3-Year Eras).
// Every expected value is read independently (the worker's own response, or the fixture rows), never from the page.
// Each review fix (#7 a-g) is checked, and where practical the check is shown to FAIL on a copy of the page with that
// one fix reverted (mutant pages, as tests/standings_race_weekly.test.mjs does for the shared module).
//   node scripts/safe_tests/run.mjs --only standings_desktop_v3
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { SCHEMA, loadSeason, recorded2026, weeklySeason } from "./fixtures/standings_d1.mjs";
import { loadStandingsPage, workerFetch, settle, PAGE_SOURCE } from "./fixtures/standings_v2_page.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
mfl.st.league = { standingsSort: REC.standingsSort };

const plain = (html) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html) => plain(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const pad4 = (v) => String(v).padStart(4, "0");
const noAbout = (h) => h.replace(/<details class="about">[\s\S]*?<\/details>/g, "");   // the definitions list

// ── the seasons ──
const ENV_2026 = loadSeason(makeWorkerEnv({}), recorded2026(REC));
const RESP_2026 = (await callWorker(ENV_2026, "GET", "/api/standings?year=2026")).json;
// A malformed playoff flag in D1 (games row 7): the worker seeds nobody (standings_basis "unavailable").
const ENV_BAD = (() => { const s = recorded2026(REC); return loadSeason(makeWorkerEnv({}), { ...s, games: s.games.map((g, i) => (i === 7 ? { ...g, is_playoff: "x" } : g)) }); })();
// Nothing played: no src_standings rows, so the worker synthesizes 0-0 rows from MFL (preseason).
const ENV_PRE = (() => { const env = makeWorkerEnv({}); env.UPS_MFL_DB.raw.exec(SCHEMA); env.UPS_MFL_DB.raw.prepare("INSERT INTO src_league_season_meta (season, league_id, mfl_server, last_regular_season_week, playoff_weeks) VALUES (2026, '74598', 'www48', 14, 3)").run(); return env; })();

// A finished 2025: 12 teams (fid n = recorded seed n), one regular week (Week 1), playoffs Weeks 2-4.
//   Round 1 (Wk 2): 6 beats 3, 4 beats 5 · Toilet: 9 beats 12, 11 beats 10
//   Wk 3: semis 4 beats 1, 2 beats 6; placement 5 beats 3 (finish 5 → 1.07, 3 → finish 6 → 1.08)
//         Toilet semis 7 beats 11, 9 beats 8; Toilet placement 10 beats 12
//   Wk 4: final 2 beats 4; 3rd place 6 beats 1 (finish 3 → 1.10); Hawk Tuah Bowl 9 beats 7 (finish 7 → 1.01);
//         Toilet 3rd place 8 beats 11
const F = (n) => pad4(n);
const DIVS = { "00": [1, 5, 9], "01": [2, 6, 10], "02": [3, 7, 11], "03": [4, 8, 12] };
const divOf = Object.fromEntries(Object.entries(DIVS).flatMap(([d, ns]) => ns.map((n) => [F(n), d])));
function playWeek(week, po, results) {   // results: [[winner, loser], ...]; everyone else scores 90 (a bye)
  const scores = {};
  for (let n = 1; n <= 12; n++) scores[F(n)] = 90 + n / 10;
  results.forEach(([w, l], i) => { scores[F(w)] = 150 + i; scores[F(l)] = 120 + i; });
  return { week, po, scores, games: results.map(([w, l]) => [F(w), F(l)]) };
}
const BRACKET_WEEKS = [
  // Week 1 (regular): the higher fid scores more, so the season totals rank the teams roughly in reverse of their
  // recorded seeds — a legacy recompute from them would not be the recorded seed order.
  { week: 1, po: 0, scores: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [F(i + 1), 100 + 10 * (i + 1)])), games: [[F(1), F(2)], [F(3), F(4)], [F(5), F(6)], [F(7), F(8)], [F(9), F(10)], [F(11), F(12)]] },
  playWeek(2, 1, [[6, 3], [4, 5], [9, 12], [11, 10]]),
  playWeek(3, 1, [[4, 1], [2, 6], [5, 3], [7, 11], [9, 8], [10, 12]]),
  playWeek(4, 1, [[2, 4], [6, 1], [9, 7], [8, 11]]),
];
const FINISH_2025 = { 2: 1, 4: 2, 6: 3, 1: 4, 5: 5, 3: 6, 9: 7, 7: 8, 8: 9, 11: 10, 10: 11, 12: 12 };
function finishedEnv({ throughWeek = 4, finishes = true } = {}) {
  const s = weeklySeason({ weeks: BRACKET_WEEKS.filter((w) => w.week <= throughWeek), divisions: divOf, lastRegularSeasonWeek: 1, season: 2025 });
  const env = loadSeason(makeWorkerEnv({}), s);
  const db = env.UPS_MFL_DB.raw;
  for (let n = 1; n <= 12; n++) db.prepare("INSERT INTO src_final_standings (season, franchise_id, final_finish, regular_season_finish, division) VALUES (2025, ?, ?, ?, ?)").run(F(n), finishes ? FINISH_2025[n] : null, n, divOf[F(n)]);
  return env;
}
const ENV_2025 = finishedEnv();
const ENV_2025_WK3 = finishedEnv({ throughWeek: 3, finishes: false });   // the bracket in progress: no Week 4 yet

// History: franchise slot 0005 changes hands — Kyle Creelman (BTNH) 2018-2021, Eric Martel (HammerTime) 2022-2024,
// Eric's 2024 title. 0001 (Shawn Blake) wins the 2015 Hawk Tuah Bowl (finish 7) and finishes 12th in 2017; a 2010
// finish 7 (the loser-advances toilet bracket) is not a Hawktuah title.
const HIST = [];
for (let y = 2010; y <= 2024; y++) {
  HIST.push({ season: y, fid: "0001", owner: "Shawn Blake", team: "Blake Bombers", fin: y === 2015 || y === 2010 ? 7 : (y === 2017 ? 12 : 4) });
  if (y >= 2018) HIST.push({ season: y, fid: "0005", owner: y <= 2021 ? "Kyle Creelman" : "Eric Martel", team: y <= 2021 ? "BTNH" : "HammerTime", fin: y === 2024 ? 1 : (y === 2019 ? 2 : 6) });
}
const ENV_HIST = (() => {
  const env = makeWorkerEnv({});
  const db = env.UPS_MFL_DB.raw;
  db.exec(SCHEMA);
  for (const h of HIST) {
    db.prepare("INSERT INTO src_franchises (season, franchise_id, owner_name, team_name, division) VALUES (?, ?, ?, ?, '00')").run(h.season, h.fid, h.owner, h.team);
    db.prepare("INSERT INTO src_final_standings (season, franchise_id, final_finish, regular_season_finish, division) VALUES (?, ?, ?, ?, '00')").run(h.season, h.fid, h.fin, h.fin);
    db.prepare("INSERT INTO src_standings (season, franchise_id, h2h_w, h2h_l, h2h_t, allplay_w, allplay_l, allplay_t, pf) VALUES (?, ?, 7, 7, 0, 70, 70, 0, 1800)").run(h.season, h.fid);
  }
  return env;
})();

// ── the page ──
// opts: { env, fetch (overrides env), query, src (a mutant page), parent, contentHeight }
async function page(query, opts = {}) {
  const urls = [];
  const base = opts.fetch || workerFetch(callWorker, opts.env || ENV_2026);
  const fetch = async (url) => { urls.push(new URL(url).pathname + new URL(url).search); return base(url); };
  const p = loadStandingsPage({ query, fetch, pageSrc: opts.src, parent: opts.parent, contentHeight: opts.contentHeight });
  await settle(80);
  const raw = p.html();
  return { raw, html: plain(raw), text: text(raw), urls, messages: p.messages };
}
// A copy of the page with ONE fix reverted (the anchor must occur exactly once).
function mutant(find, replace) {
  const n = PAGE_SOURCE.split(find).length - 1;
  if (n !== 1) throw new Error("mutation anchor found " + n + " times: " + find.slice(0, 80));
  return PAGE_SOURCE.replace(find, () => replace);
}
// The check passes on the real page and FAILS (an assertion, not a crash) on the reverted one.
async function catches(label, find, replace, check) {
  await check(undefined);
  let err = null;
  try { await check(mutant(find, replace)); } catch (e) { err = e; }
  t.ok(err && err.code === "ERR_ASSERTION", label + ": the reverted fix must fail this check" + (err && err.code !== "ERR_ASSERTION" ? " (it crashed instead: " + err.message + ")" : ""));
}
// <li class="seed-card..." data-fid> order on the Playoff Picture
const seedCards = (raw) => [...raw.matchAll(/<li class="seed-card[^"]*" data-fid="(\d{4})"/g)].map((m) => m[1]);
// the Full League table: header labels and each team row's cells (disclosure rows dropped)
function leagueTable(raw) {
  const tbl = /<table><thead>([\s\S]*?)<\/thead><tbody>([\s\S]*?)<\/tbody><\/table><\/div><div class="note">/.exec(raw);
  if (!tbl) return null;
  const heads = [...tbl[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]).trim());
  const body = tbl[2].replace(/<tr class="disclosure-row"[\s\S]*?(?=<tr class="(?:you-row )?race-row"|<tr class="seed-divider|$)/g, "");
  const rows = [...body.matchAll(/<tr class="(?:you-row )?race-row"([^>]*)>([\s\S]*?)<\/tr>/g)]
    .map((m) => ({ fid: (/data-fid="(\d{4})"/.exec(m[1]) || [])[1] || null, cells: [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]).trim()) }));
  const col = (label) => heads.indexOf(label);
  return { heads, rows, col, cell: (fid, label) => (rows.find((r) => r.fid === fid) || { cells: [] }).cells[col(label)] };
}

// ═══ Playoff Picture ═══
test("Playoff Picture is the default tab, and its seeds are the worker's: 0009, 0010, 0005, 0008, 0002, 0004, then 0012 next out", async () => {
  const p = await page("year=2026");
  t.match(p.raw, /<button type="button" class="view-btn" role="tab" data-view="picture" aria-selected="true"/);
  t.equal((p.raw.match(/aria-selected="true"/g) || []).length, 1, "one selected tab");
  const workerSeeds = RESP_2026.rows.filter((r) => r.playoff_seed != null).map((r) => r.franchise_id);
  t.deepEqual(workerSeeds, ["0009", "0010", "0005", "0008", "0002", "0004"], "the fixture's worker seeds (independent read)");
  t.deepEqual(seedCards(p.raw), workerSeeds, "seed cards in the worker's order");
  t.equal(RESP_2026.regular_season.next_out, "0012");
  t.match(p.html, /<b>Next out:<\/b> Hawks, 2 All-Play wins behind Pure Greatness \(6th\)\./);
  t.match(p.text, /Next team out Hawks/);
  t.match(p.html, /<b>If the season ended today, byes:<\/b> C-Town Chivalry and Blake Bombers\./);
  t.match(p.html, /<b>Tiebreak:<\/b> Real Deal Creel over CBP: same All-Play, a better H2H record \(9-4 vs 7-6\)\./);
  // in the hunt: positions 7-12 in the worker's order, each with its Back (ap_back) and ▲▼ (order_change)
  const hunt = [...p.raw.matchAll(/<tr class="hunt-row[^"]*"[^>]*data-toggle="(\d{4})">([\s\S]*?)<\/tr>/g)].map((m) => [m[1], [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]).trim())]);
  const outside = RESP_2026.rows.filter((r) => r.playoff_seed == null);
  t.deepEqual(hunt.map((h) => h[0]), outside.map((r) => r.franchise_id));
  hunt.forEach(([fid, cells], i) => {
    const r = outside[i];
    t.equal(cells[0], String(7 + i));
    t.equal(cells[5], String(r.ap_back), fid + " Back");
    if (r.order_change) t.match(cells[1], new RegExp((r.order_change > 0 ? "▲" : "▼") + Math.abs(r.order_change)));
  });
  t.match(p.raw, /aria-label="down 2 since last week"/, "arrows carry words, not just a color");
});
test("Picture: projected chips, the bye line after seed 2 and the playoff line after seed 6; one-line reasons from race().whySeed", async () => {
  const p = await page("year=2026");
  const order = [...p.raw.matchAll(/data-fid="(\d{4})"|(First-round byes above)<\/li>|(Playoff line · 7–12 play the Hawk Tuah Bowl)<\/li>/g)].map((m) => m[1] || m[2] || m[3]);
  const cards = order.filter((x) => /^\d{4}$/.test(x) || /First|Playoff/.test(x));
  t.deepEqual(cards.slice(0, 8), ["0009", "0010", "First-round byes above", "0005", "0008", "0002", "0004", "Playoff line · 7–12 play the Hawk Tuah Bowl"]);
  t.match(p.html, /<span class="status-chip bye projected"[^>]*aria-label="Projected playoff status: Bye">BYE<small> proj\.<\/small><\/span>/);
  t.match(p.html, /Seeds <span class="h-sub">· if the season ended today<\/span>/);
  const card8 = /<li class="seed-card[^"]*" data-fid="0008">([\s\S]*?)<div class="seed-detail"/.exec(p.html)[1];
  const why = /<div class="seed-why">([^<]*)<\/div>/.exec(card8)[1];
  t.match(why, /CBP/, "Real Deal Creel's reason names CBP");
  t.match(why, /H2H record/, "...and the H2H-record tiebreak (canon's Overall step)");
  t.equal(why, "Seed 4: behind HammerTime on All-Play %. Ahead of CBP on H2H record (same All-Play %).");
  t.match(card8, /9-4 · All-Play 32-23 \(58\.2%\)/, "record and All-Play from the worker's regular_season");
  t.match(p.text, /Through Week 5 of 14 · final scores/, "freshness: through which week");
  t.match(p.html, /<section class="panel"><h3>Bracket <span class="h-sub">· projected<\/span><\/h3>/, "the bracket link is labeled projected");
  t.match(p.html, /data-goto="bracket">See the projected bracket →<\/button>/);
  t.match(p.html, /<summary>About these numbers<\/summary>/);
});
test("Picture: division leaders in the worker's division order, with GB and the reason when a tie wasn't decided on record", async () => {
  const p = await page("year=2026");
  const panel = /<section class="panel"><h3>Division leaders<\/h3>([\s\S]*?)<\/section>/.exec(p.html)[1];
  const div03 = /Division 03<\/div>([\s\S]*?)<\/table>([\s\S]*?)(?=<div class="div-mini">|<div class="sub")/.exec(panel);
  const names = [...div03[1].matchAll(/<tr[^>]*><td>([^<]+)/g)].map((m) => m[1]);
  const worker = RESP_2026.rows.filter((r) => r.division === "03").sort((a, b) => a.division_rank - b.division_rank).map((r) => r.franchise_name);
  t.deepEqual(names, worker, "the worker's division_rank order");
  t.deepEqual(names, ["C-Town Chivalry", "Cleon Ca$h", "Hawks"]);
  t.match(div03[2], /Cleon Ca\$h over Hawks: same H2H record, a better division record \(4-0 vs 0-4\)\./);
  t.ok(!/same H2H record, a better H2H record/.test(panel), "no reason line when the H2H record (PCT) decided it");
});
test("Picture: 'Seeds unavailable: <reason>' when the worker seeds nobody; preseason says so; a failed fetch offers a retry", async () => {
  const bad = await page("year=2026", { env: ENV_BAD });
  t.match(bad.html, /<b>Seeds unavailable: [^<]+\.<\/b> No team is ranked until the weekly results can be verified\./);
  t.equal(seedCards(bad.raw).length, 0, "no seed cards");
  t.ok(!/hunt-table/.test(bad.raw), "and no hunt table");
  const pre = await page("year=2026", { env: ENV_PRE });
  t.match(pre.html, /No games played yet\. Seeds start after Week 1\./);
  t.equal(seedCards(pre.raw).length, 0);
  const down = await page("year=2026", { fetch: async () => ({ ok: false, status: 500, json: async () => ({}) }) });
  t.match(down.html, /Couldn’t load the 2026 standings\. <button type="button" class="retry-btn" data-retry="1">Try again<\/button>/);
});
test("Picture, finished season: the recorded final standings (finish, recorded seed, champions, division winners), never a draft-order claim", async () => {
  const p = await page("year=2025", { env: ENV_2025 });
  t.match(p.html, /Recorded final standings\./);
  const rows = [...p.raw.matchAll(/<tr(?: class="you-row")?><td class="num"><strong>(\d+)<\/strong><\/td><td>([\s\S]*?)<\/td><td class="num">([^<]*)<\/td>/g)]
    .map((m) => ({ fin: Number(m[1]), team: text(m[2]).trim(), seed: m[3] }));
  t.deepEqual(rows.map((r) => r.fin), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "recorded finish order");
  const legacy = (await callWorker(ENV_2025, "GET", "/api/standings?year=2025")).json;
  const nm = (fid) => legacy.rows.find((r) => r.franchise_id === fid).franchise_name;   // the season's MFL names
  t.ok(rows[0].team.startsWith("🏆 " + nm("0002")), "finish 1 = the UPS champion: " + rows[0].team);
  t.equal(rows[0].seed, "2", "the RECORDED seed (regular_season_finish), not /api/standings' legacy recompute");
  t.notEqual(legacy.rows.find((r) => r.franchise_id === "0002").playoff_seed, 2, "control: the legacy recompute disagrees here");
  t.ok(rows[6].team.startsWith("🚽 " + nm("0009")), "finish 7 = the Hawk Tuah Bowl champion: " + rows[6].team);
  t.match(p.html, new RegExp("<b>UPS champion:<\\/b> " + nm("0002").replace(/[$()]/g, "\\$&")));
  t.match(p.html, new RegExp("<b>Hawk Tuah Bowl champion:<\\/b> " + nm("0009").replace(/[$()]/g, "\\$&")));
  t.match(p.html, /<b>Division winners:<\/b> /);
  t.ok(!/draft order|\bpicks?\b/i.test(p.text), "finish order is not draft order");
  t.ok(!/if the season ended today|proj\./.test(noAbout(p.html)), "nothing projected about a finished season");
});

// ═══ Full League ═══
test("Full League: the worker's seed order by default, ONE Seed column (from /api/standings), PF per week and PA per game", async () => {
  const p = await page("view=league&year=2026");
  const L = leagueTable(p.raw);
  t.ok(L, "the table renders");
  t.deepEqual(L.rows.map((r) => r.fid), RESP_2026.rows.map((r) => r.franchise_id), "default order = the worker's");
  t.equal(L.heads.filter((h) => h === "Seed").length, 1, "one Seed column");
  for (const r of RESP_2026.rows) t.equal(L.cell(r.franchise_id, "Seed"), r.playoff_seed == null ? "—" : String(r.playoff_seed));
  t.ok(L.heads.includes("PF/week") && L.heads.includes("PA/game"), "labeled per week / per game");
  t.ok(!/Avg PF|Avg PA/.test(p.html));
  const c = RESP_2026.rows.find((r) => r.franchise_id === "0009").regular_season;
  t.equal(L.cell("0009", "PF/week"), c.pf_per_week.toFixed(1));
  t.equal(L.cell("0009", "PA/game"), c.pa_per_game.toFixed(1));
  t.equal(L.cell("0012", "Back"), "2");
  t.deepEqual(["Seed", "Status", "Team", "H2H", "Div", "Playoffs", "All-Play", "AP %", "Back", "PF", "PF/week", "PA/game", "Exp. W", "Luck"], L.heads, "the Overall column set");
  t.match(p.html, /<div class="seg" role="group" aria-label="Columns"><span class="seg-label">Show:<\/span><button[^>]*data-show="scored"[^>]*>Scored<\/button><button[^>]*data-show="faced"[^>]*>Faced<\/button><button[^>]*data-show="overall" aria-pressed="true">Overall<\/button>/);
  t.match(p.html, /<tr class="seed-divider hawk-divider"><td colspan="14">Playoff line · Hawk Tuah Bowl · seeds 7–12<\/td><\/tr>/);
  t.ok(p.urls.every((u) => !u.startsWith("/api/playoff-bracket")), "the current season's seeds never come from /api/playoff-bracket");
});
test("Full League Scored / Faced: the shared module's scoredFaced numbers; Faced is 'schedule, not skill' and never 'Defense'", async () => {
  const RACE = (() => { const w = {}; new Function("window", fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8"))(w); return w.UPS_STANDINGS_RACE; })();
  const sf = RACE.scoredFaced(RESP_2026);
  t.equal(sf.status, "ok");
  const scored = await page("view=league&year=2026&show=scored");
  const S = leagueTable(scored.raw);
  t.deepEqual(S.heads, ["Seed", "Status", "Team", "PF", "PF/week", "PF rank", "Avg wk rank", "Best week", "Worst week", "Last 3 avg rank"]);
  const s9 = sf.byFranchise["0009"].scored;
  t.equal(S.cell("0009", "PF rank"), "1st");
  t.equal(S.cell("0009", "Best week"), "W" + s9.highWeek.week + " " + s9.highWeek.score.toFixed(1));
  t.match(scored.html, /<strong>Scored<\/strong> — what each lineup put up in the regular season\. Descriptive/);
  const faced = await page("view=league&year=2026&show=faced");
  const Fc = leagueTable(faced.raw);
  t.deepEqual(Fc.heads, ["Seed", "Status", "Team", "Opp. pts/game", "Rank", "Opp. vs usual", "Close H2H games"]);
  for (const r of RESP_2026.rows) {
    const f = sf.byFranchise[r.franchise_id].faced;
    t.equal(Fc.cell(r.franchise_id, "Opp. pts/game"), f.paPerGame.toFixed(1));
    t.match(Fc.cell(r.franchise_id, "Rank"), new RegExp("^" + f.paRank + "(st|nd|rd|th)$"));
  }
  t.match(faced.html, /<strong>Faced: schedule, not skill\.<\/strong>/);
  for (const v of [faced, scored, await page("view=league&year=2026"), await page("year=2026")]) t.ok(!/defen[cs]e/i.test(v.html), "never 'Defense' (in UPS, MFL's Defense = your IDP players' points)");
});
test("Full League: the Scope control still works for historical use (Regular Season) and is not the default", async () => {
  const def = await page("view=league&year=2026");
  t.match(PAGE_SOURCE, /<option value="full">Full Season<\/option>\s*<option value="regular">Regular Season<\/option>\s*<option value="playoffs">Playoffs<\/option>\s*<option value="custom">Custom weeks…<\/option>/);
  t.ok(/Regular season: weeks 1–14 \(2026\)\./.test(def.html), "Full scope by default");
  const reg = await page("view=league&year=2026&scope=regular");
  const L = leagueTable(reg.raw);
  t.ok(L && L.rows.length === 12);
  t.match(reg.html, /<strong>Regular Season<\/strong> — weeks 1–14/);
  t.ok(!L.heads.includes("Exp. W") && !L.heads.includes("Back"), "full-season-only columns hidden when scoped");
});
test("Full League, finished season: Seed = the recorded seed, Fin = the recorded finish (default order), disclosures say recorded", async () => {
  const p = await page("view=league&year=2025", { env: ENV_2025 });
  const L = leagueTable(p.raw);
  t.deepEqual(L.rows.map((r) => Number(L.cell(r.fid, "Fin"))), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], "recorded finish order");
  for (let n = 1; n <= 12; n++) t.equal(L.cell(F(n), "Seed"), String(n), "recorded seed " + n);
  t.ok(!L.heads.includes("Status") && !L.heads.includes("Back"), "no in-season status or games-back for a finished season");
  t.match(p.html, /Seeds: the recorded final standings\./);
  t.match(p.html, /Recorded seed 2 · finished 1st — from the recorded final standings\./);
  t.ok(!/Seed \d+ — from the recorded final standings/.test(p.html), "the legacy recompute is never shown as a seed");
});

// ═══ Divisions ═══
test("Divisions: the worker's division order (division_rank), GB, the non-record tie reason; no client re-sort", async () => {
  const p = await page("view=divisions&year=2026");
  for (const d of ["00", "01", "02", "03"]) {
    const card = new RegExp('<div class="div-card-name">Division ' + d + '<\\/div>[\\s\\S]*?<tbody>([\\s\\S]*?)<\\/tbody>').exec(p.html);
    const names = [...card[1].matchAll(/<tr[^>]*><td>([^<]+)/g)].map((m) => m[1]);
    t.deepEqual(names, RESP_2026.rows.filter((r) => r.division === d).sort((a, b) => a.division_rank - b.division_rank).map((r) => r.franchise_name), "division " + d);
  }
  t.match(p.html, /<div class="reason">Cleon Ca\$h over Hawks: same H2H record, a better division record \(4-0 vs 0-4\)\.<\/div>/);
  t.match(p.html, /Order = record, then division record, then head-to-head \(MFL’s rule\)\./);
});

// ═══ Weekly ═══
test("Weekly Week 5: top score C-Town Chivalry 280.5, +8.0 over Real Deal Creel; the week table in score order with head-to-head results", async () => {
  const p = await page("view=weekly&year=2026&week=5");
  t.match(p.html, /<b>Week 5 top score:<\/b> C-Town Chivalry 280\.5, \+8\.0 over Real Deal Creel\./);
  const w5 = REC.weekly_scores.filter((r) => r.week === 5).sort((a, b) => b.team_score - a.team_score);
  const low = w5[w5.length - 1];
  t.match(p.html, new RegExp("<b>Low:<\\/b> " + RESP_2026.rows.find((r) => r.franchise_id === low.franchise_id).franchise_name + " " + low.team_score.toFixed(1)));
  const rows = [...p.raw.matchAll(/<tr(?: class="you-row")?><td class="num"><strong>(\d+)<\/strong><\/td><td>([^<]+)<\/td><td class="num">([\d.]+)<\/td><td class="num">([\d-]+)<\/td><td>([\s\S]*?)<\/td><td class="num">([\s\S]*?)<\/td><\/tr>/g)];
  t.equal(rows.length, 12);
  t.deepEqual(rows.map((m) => Number(m[3])), w5.map((r) => r.team_score), "score order");
  t.equal(rows[0][4], "11-0", "the top score beat all 11 others that week");
  const games = REC.games.filter((g) => g.week === 5 && g.franchise_id === "0009");
  t.equal((plain(rows[0][5]).match(/class="h2h"/g) || []).length, games.length, "every head-to-head game that week");
  t.match(text(rows[0][5]), /W 280\.5–/);
  t.match(text(rows[1][6]), /4th ▲2/, "season All-Play rank and its change");
  // the picker: completed regular-season weeks, and the Season view
  t.match(p.html, /<span class="wp-label">Regular season<\/span><button[^>]*data-week="1"[^>]*>1<\/button>[\s\S]*data-week="5" aria-pressed="true"/);
  t.ok(!/data-week="6"/.test(p.html), "only completed weeks");
});
test("Weekly Season: top-score weeks per team, each week's top score, and a team × week heat map whose every cell is the rank (with a table toggle)", async () => {
  const p = await page("view=weekly&year=2026&week=season");
  const weeks = [1, 2, 3, 4, 5];
  const rank = (w, f) => 1 + REC.weekly_scores.filter((r) => r.week === w && r.team_score > REC.weekly_scores.find((x) => x.week === w && x.franchise_id === f).team_score).length;
  const heat = /<table class="heat">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(p.raw);
  t.ok(heat, "the heat map renders");
  const rows = [...heat[1].matchAll(/<tr><td class="hteam">([^<]+)<\/td>([\s\S]*?)<\/tr>/g)];
  t.equal(rows.length, 12);
  for (const m of rows) {
    const fid = RESP_2026.rows.find((r) => r.franchise_name === plain(m[1])).franchise_id;
    const cells = [...m[2].matchAll(/<td class="hc" style="background:[^"]+" title="([^"]+)">(\d+)<\/td>/g)];
    t.equal(cells.length, 5, "a number in every cell");
    t.deepEqual(cells.map((c) => Number(c[2])), weeks.map((w) => rank(w, fid)), plain(m[1]) + " weekly ranks");
    t.ok(cells.every((c) => /: \d+(st|nd|rd|th) \(/.test(plain(c[1]))), "each cell's title says the rank and score in words");
  }
  t.match(p.html, /<button type="button" class="mode-btn" data-hm="heat" aria-pressed="true">Heat map<\/button><button type="button" class="mode-btn" data-hm="table" aria-pressed="false">Table<\/button>/);
  const tbl = await page("view=weekly&year=2026&week=season&hm=table");
  t.ok(!/<table class="heat">/.test(tbl.raw) && /<td class="num">\d+ <span class="dim">\([\d.]+\)<\/span><\/td>/.test(tbl.raw), "the table view: rank (score), no color");
  t.match(p.html, /<li><span class="wk">W5<\/span><span>C-Town Chivalry<\/span><span>280\.5 <span class="dim">\(\+8\.0\)<\/span><\/span><\/li>/, "each week's top score");
  const lead = /<table class="data-table leaders-table">[\s\S]*?<tbody><tr[^>]*><td>([^<]+)<\/td><td class="num">(\d+)<\/td>/.exec(p.html);
  t.equal(lead[1], "C-Town Chivalry");
  t.equal(lead[2], String(weeks.filter((w) => rank(w, "0009") === 1).length), "top-score weeks");
});
test("Weekly: playoff weeks are labeled separately from the regular season", async () => {
  const p = await page("view=weekly&year=2025", { env: ENV_2025 });
  t.match(p.html, /<span class="wp-label">Regular season<\/span><button[^>]*data-week="1"[^>]*>1<\/button><span class="wp-label">Playoffs<\/span><button[^>]*data-week="2" aria-pressed="false" aria-label="Playoff week 2">P2<\/button>/);
  const po = await page("view=weekly&year=2025&week=3", { env: ENV_2025 });
  t.match(po.html, /<b>Playoff week 3 top score:<\/b>/);
  t.match(po.html, /playoff week: not part of the regular-season All-Play/);
});

// ═══ Trends ═══
test("Trends: three inline-SVG charts (seed order by week, All-Play vs record, PF vs points faced), each with axes, a caption and a table", async () => {
  const p = await page("view=trends&year=2026");
  const figs = [...p.raw.matchAll(/<figure class="chart">([\s\S]*?)<\/figure>/g)].map((m) => m[1]);
  t.equal(figs.length, 3);
  for (const f of figs) {
    t.match(f, /<svg viewBox="[^"]+" role="img" aria-label="[^"]+"/, "an accessible SVG");
    t.match(f, /<details class="chart-table"><summary>Show table<\/summary>/, "a table equivalent behind a toggle");
    t.match(f, /<div class="cc">[^<]+<\/div>/, "a one-line caption");
  }
  t.match(figs[0], />Week<\/text>/); t.match(figs[0], />Place \(1 = top seed\)<\/text>/);
  t.match(figs[0], /class="cut"[^>]*\/><text[^>]*>Playoff line<\/text>/, "the playoff line at 6.5");
  // the seed path table is the worker's seed_by_week
  const sbw = RESP_2026.regular_season.seed_by_week;
  const hawks = /<tr><td>Hawks<\/td>((?:<td class="num">[^<]*<\/td>)+)<\/tr>/.exec(figs[0])[1];
  t.deepEqual([...hawks.matchAll(/>([^<]*)</g)].map((m) => m[1]).filter(Boolean), [1, 2, 3, 4, 5].map((w) => { const i = sbw[w].indexOf("0012"); return i < 6 ? String(i + 1) : "(" + (i + 1) + ")"; }));
  t.match(figs[0], /<text class="lbl" x="[^"]+" y="[^"]+">1  C-Town Chivalry<\/text>/, "end labels name the team");
  t.match(figs[1], /Above the line = record better than scoring \(schedule luck\)\./);
  t.match(figs[1], />All-Play %<\/text>/); t.match(figs[1], />Record %<\/text>/); t.match(figs[1], /record = All-Play<\/text>/);
  t.match(figs[2], />Points For per week<\/text>/); t.match(figs[2], />Points faced per game<\/text>/);
  // status by shape and words, not color alone
  t.match(figs[1], /<circle class="dot out"/); t.match(figs[1], /<circle class="dot in"/);
  t.match(figs[1], /Outside the field<\/span>/);
  t.match(figs[1], /<td>Hawks <span class="dim">\(outside\)<\/span><\/td>/);
});
test("Trends: an unseeded season says so instead of drawing an order; preseason says no games", async () => {
  const bad = await page("view=trends&year=2026", { env: ENV_BAD });
  t.match(bad.html, /<b>Seeds unavailable<\/b> — the weekly results couldn’t be verified, so no order is drawn\./);
  const pre = await page("view=trends&year=2026", { env: ENV_PRE });
  t.match(pre.html, /No games played yet\./);
  t.ok(!/<figure class="chart">/.test(pre.raw));
});

// ═══ the review fixes ═══
test("fix (a): the embed loader's ?YEAR= opens that season (the page used to read only ?year=)", async () => {
  const check = async (src) => {
    const p = await page("YEAR=2019&L=74598&SOURCE_L=74598", { src });
    t.ok(p.urls.includes("/api/standings?year=2019"), "asked for 2019, got " + p.urls.join(", "));
    t.match(p.raw, /<option value="2019" selected>/);
  };
  await catches("fix (a)", 'parseInt(qs.get("year") || qs.get("YEAR"), 10)', 'parseInt(qs.get("year"), 10)', check);
  // and the loader sends both
  const loader = fs.readFileSync(new URL("../site/standings/mfl_hpm_embed_loader.js", import.meta.url), "utf8");
  t.match(loader, /src\.searchParams\.set\("YEAR", YEAR\);\s*src\.searchParams\.set\("year", YEAR\);/);
});
test("fix (b): the page posts ups-standings-height after rendering, and the loader sizes ITS iframe from it", async () => {
  const check = async (src) => {
    const p = await page("year=2026", { src, parent: true, contentHeight: 1480 });
    const m = p.messages.map((x) => x.msg).filter((x) => x && x.type === "ups-standings-height");
    t.ok(m.length >= 1, "a height message");
    t.equal(m[m.length - 1].height, 1482);
  };
  await catches("fix (b)", 'parent.postMessage({ type: "ups-standings-height", height: h + 2 }, "*");', "void parent;", check);
  const noParent = await page("year=2026", { contentHeight: 1480 });
  t.equal(noParent.messages.length, 0, "opened directly (no parent frame): nothing is posted");
  // the loader, run for real with a tiny DOM: the iframe URL carries both year spellings; a height message from the
  // iframe resizes it (min 400px); a message from any other window is ignored.
  const listeners = {};
  const iframeWin = {};
  const iframe = { style: {}, setAttribute() {}, contentWindow: iframeWin };
  const mount = { innerHTML: "", appendChild(c) { this.child = c; } };
  const script = { src: "https://keithcreelman.github.io/upsmflproduction/standings/mfl_hpm_embed_loader.js?v=7", getAttribute: (k) => ({ "data-standings-target-id": "upsStandingsMount", "data-standings-source-league-id": "74598" })[k] || null };
  const ctx = {
    document: { currentScript: script, getElementById: (id) => (id === "upsStandingsMount" ? mount : null), createElement: () => iframe, body: { appendChild() {} } },
    window: { location: { href: "https://www48.myfantasyleague.com/2026/home/74598?MODULE=MESSAGE1", pathname: "/2026/home/74598" }, addEventListener: (type, fn) => { listeners[type] = fn; } },
    URL,
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(new URL("../site/standings/mfl_hpm_embed_loader.js", import.meta.url), "utf8"), ctx);
  const u = new URL(iframe.src);
  t.equal(u.searchParams.get("YEAR"), "2026"); t.equal(u.searchParams.get("year"), "2026"); t.equal(u.searchParams.get("L"), "74598");
  listeners.message({ source: iframeWin, data: { type: "ups-standings-height", height: 1482 } });
  t.equal(iframe.style.height, "1482px");
  listeners.message({ source: {}, data: { type: "ups-standings-height", height: 99 } });
  t.equal(iframe.style.height, "1482px", "another window's message is ignored");
  listeners.message({ source: iframeWin, data: { type: "ups-standings-height", height: 120 } });
  t.equal(iframe.style.height, "400px", "never below 400px");
});
test("fix (c): Draft Order uses the shared finish → pick mapping only: finish 5 → 1.07, 6 → 1.08, and no team at two picks", async () => {
  const picks = (raw) => Object.fromEntries([...raw.matchAll(/<td class="num" style="font-weight:800;color:var\(--gold\);font-size:13px">(1\.\d\d)<\/td><td>[\s\S]*?<\/td><td>([\s\S]*?)<\/td>/g)].map((m) => [m[1], text(m[2]).trim()]));
  const done = picks((await page("view=draftOrder&year=2025", { env: ENV_2025 })).raw);
  const want = { "1.01": 9, "1.02": 7, "1.03": 8, "1.04": 11, "1.05": 10, "1.06": 12, "1.07": 5, "1.08": 3, "1.09": 1, "1.10": 6, "1.11": 4, "1.12": 2 };
  for (const [pick, n] of Object.entries(want)) t.equal(done[pick], "Team " + F(n), pick);
  // the bracket in progress (no Week 4 yet): the placement game is decided, the 3rd-place game isn't
  const check = async (src) => {
    const live = picks((await page("view=draftOrder&year=2025", { env: ENV_2025_WK3, src })).raw);
    t.equal(live["1.07"], "Team 0005", "the placement winner picks 1.07");
    t.equal(live["1.08"], "Team 0003");
    t.equal(live["1.10"], "pending", "1.10 waits for the 3rd-place game");
    const teams = Object.values(live).filter((v) => v !== "pending");
    t.equal(new Set(teams).size, teams.length, "no team appears at two picks");
  };
  // revert: the old inline mapping's leftover line that gave the placement winner 1.10 as well
  await catches("fix (c)", "renderDraftOrderTable(host, seeds, actual.picks, playoffWeeks, { projected: false })",
    'renderDraftOrderTable(host, seeds, Object.assign({}, actual.picks, actual.champ.placement && actual.champ.placement.winner ? { "1.10": actual.champ.placement.winner.franchise_id } : {}), playoffWeeks, { projected: false })', check);
});
test("fix (d): Historical Finishes labels every cell with THAT season's owner and team; rows by owner (default) or by franchise slot", async () => {
  const cellsOf = (raw, rowLabel) => {
    const m = new RegExp('<tr><th class="hist-team" scope="row"[^>]*><span class="owner">' + rowLabel.replace(/[$()]/g, "\\$&") + '<\\/span>[\\s\\S]*?<\\/th>([\\s\\S]*?)<\\/tr>').exec(raw);
    return m ? [...m[1].matchAll(/<td class="([^"]+)"(?: title="([^"]*)")?[^>]*>([\s\S]*?)<\/td>/g)].map((c) => ({ cls: c[1], title: plain(c[2] || ""), text: text(c[3]).trim() })) : null;
  };
  const check = async (src) => {
    const p = await page("view=historical&year=2026", { env: ENV_HIST, src });
    const seasons = [...p.raw.matchAll(/<th scope="col">(\d{4})<\/th>/g)].map((m) => Number(m[1]));
    const eric = cellsOf(p.raw, "Eric Martel");
    t.ok(eric, "an Eric Martel row");
    const e24 = eric[seasons.indexOf(2024)];
    t.match(e24.cls, /\bchamp\b/); t.equal(e24.text, "1 HammerTime");
    t.match(e24.title, /^2024 · Eric Martel · HammerTime · Final 1/);
    const kyle = cellsOf(p.raw, "Kyle Creelman");
    t.equal(kyle[seasons.indexOf(2024)].text, "—", "Eric's 2024 title is not under Kyle Creelman");
    t.equal(kyle[seasons.indexOf(2019)].text, "2 BTNH");
  };
  await catches("fix (d)", 'var key = bySlot ? fid : (r.owner_name || ("Franchise " + fid + " (owner not recorded)"));', "var key = fid;", check);
  const slot = await page("view=historical&year=2026&group=slot", { env: ENV_HIST });
  const s5 = cellsOf(slot.raw, "Franchise 0005");
  const seasons = [...slot.raw.matchAll(/<th scope="col">(\d{4})<\/th>/g)].map((m) => Number(m[1]));
  t.equal(s5[seasons.indexOf(2024)].text, "1 Eric Martel", "by slot: the cell names that season's owner");
  t.equal(s5[seasons.indexOf(2019)].text, "2 Kyle Creelman");
  t.match(slot.html, /data-group="slot" aria-pressed="true">By franchise slot<\/button>/);
  // the legend: 7 is the Hawk Tuah Bowl champion (from 2011), 12 is last place
  t.match(slot.html, /7 = Hawk Tuah Bowl champion \(from 2011; 2010’s toilet bracket had the loser advance\) · 12 = last place/);
  t.ok(!/12 = Hawk Tuah/.test(slot.html));
  const shawn = cellsOf((await page("view=historical&year=2026", { env: ENV_HIST })).raw, "Shawn Blake");
  t.match(shawn[seasons.indexOf(2015)].cls, /hawktuah/, "2015 finish 7 = a Hawktuah title");
  t.ok(!/hawktuah/.test(shawn[seasons.indexOf(2017)].cls), "2017 finish 12 is not");
  t.ok(!/hawktuah/.test(shawn[seasons.indexOf(2010)].cls), "2010 finish 7 is not (loser-advances bracket)");
});
test("fix (e): 3-Year Eras counts 'Hawktuah titles' = finish 7 (2011 on), not finish 12", async () => {
  const check = async (src) => {
    const p = await page("view=eras&year=2026", { env: ENV_HIST, src });
    t.match(p.html, /data-era-sort="hawktuah_titles">🚽 Hawk Tuah Bowl titles<\/th>/);
    const row = (era, owner) => { const m = new RegExp("<tr[^>]*><td>Era \\d \\(" + era + "–\\d{4}\\)<\\/td><td>" + owner + "[\\s\\S]*?<\\/tr>").exec(p.html); return m ? [...m[0].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]).trim()) : null; };
    const r1416 = row(2014, "Shawn Blake");
    t.ok(r1416, "Shawn Blake 2014-16 row");
    t.equal(r1416[8], "1", "one Hawktuah title (2015 finish 7)");
    t.equal(row(2017, "Shawn Blake")[8], "0", "2017's finish 12 is last place, not a title");
    t.equal(row(2011, "Shawn Blake")[8], "0");
  };
  await catches("fix (e)", "function isHawktuahTitle(season, finish) { return Number(season) >= 2011 && Number(finish) === 7; }",
    "function isHawktuahTitle(season, finish) { return Number(season) >= 2011 && Number(finish) === 12; }", check);
  const worker = (await callWorker(ENV_HIST, "GET", "/api/eras")).json;
  const sb = worker.eras.find((e) => e.era_start === 2017).rows.find((r) => r.owner_name === "Shawn Blake");
  t.equal(sb.hawktuah_wins, 1, "control: the worker's hawktuah_wins counts finish 12 (2017) — the page doesn't use it");
});
test("fix (f): the division race in a team's drilldown keeps the worker's order (no re-sort by All-Play games back)", async () => {
  const check = async (src) => {
    const p = await page("view=league&year=2026", { src });
    const dis = /<tr class="disclosure-row" hidden data-for="0009">([\s\S]*?)<\/td><\/tr>(?=<tr class)/.exec(p.raw)[1];
    const race = /<h4>Division race<\/h4><table class="mini">[\s\S]*?<tbody>([\s\S]*?)<\/tbody>/.exec(dis)[1];
    const names = [...race.matchAll(/<tr><td>(?:<span[^>]*>👑<\/span> )?([^<]+)<\/td>/g)].map((m) => plain(m[1]));
    t.deepEqual(names, ["C-Town Chivalry", "Cleon Ca$h", "Hawks"], "division_rank order (Cleon Ca$h wins the tie on division record)");
  };
  await catches("fix (f)", "var trs = dr.map(function (d) {",
    "var trs = dr.slice().sort(function (a, b) { return (a.ap_gb == null ? 99 : a.ap_gb) - (b.ap_gb == null ? 99 : b.ap_gb); }).map(function (d) {", check);
});
test("fix (g): the Full League seed comes from /api/standings for the current season, even when /api/playoff-bracket disagrees", async () => {
  // a bracket response whose seeds are reversed — the page must not read it for the current season
  const real = workerFetch(callWorker, ENV_2026);
  const fetch = async (url) => {
    const r = await real(url);
    if (!new URL(url).pathname.startsWith("/api/playoff-bracket")) return r;
    const j = await r.json();
    const seeds = j.seeds.slice().reverse().map((s, i) => ({ ...s, seed: i + 1 }));
    return { ok: true, status: 200, json: async () => ({ ...j, seeds }) };
  };
  const p = await page("view=overall&year=2026", { fetch });
  const L = leagueTable(p.raw);
  for (const r of RESP_2026.rows) t.equal(L.cell(r.franchise_id, "Seed"), r.playoff_seed == null ? "—" : String(r.playoff_seed), r.franchise_id);
  t.ok(!p.urls.some((u) => u.startsWith("/api/playoff-bracket")), "no second seed source is even requested");
  t.match(p.raw, /data-view="league" aria-selected="true"/, "the old ?view=overall link opens Full League");
});

// ═══ History sub-tabs ═══
test("History groups the older views as sub-tabs; old ?view= links still land on them", async () => {
  const p = await page("view=eras&year=2026", { env: ENV_HIST });
  t.match(p.raw, /data-view="history" aria-selected="true"/);
  for (const s of ["bracket", "draftOrder", "hallOfChamps", "historical", "eras", "divPower"]) t.match(p.raw, new RegExp('data-sub="' + s + '"'));
  t.match(p.raw, /data-sub="eras" aria-pressed="true"/);
  const b = await page("view=history&sub=bracket&year=2026");
  t.match(b.html, /PROJECTED · through Week 5 — chalk/, "the projected bracket banner (it used to throw on an undefined helper)");
  t.ok(!/Fetch failed|Something went wrong/.test(b.html));
  const pic = await page("year=2026");
  t.ok(!/data-sub=/.test(pic.raw), "no History sub-tabs outside History");
});

await run("standings_desktop_v3");
mfl.restore();
restore();
