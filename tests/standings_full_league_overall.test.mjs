// Desktop wide Full League Overall (#1388, Keith 2026-10-26/27): Seed | Team | H2H | Div W-L | Division GB | WC GB | AP | AP % |
// All-Time AP Rank | PF/Wk, and the Scoring view (PF, PF/Wk, offensive / defensive PF and PF/Wk, Potential PF). The REAL /api/standings route (worker harness) on the recorded 2026 season through Week 6 (the
// standings_wc_back recording) and on the recorded 2025 season → the REAL desktop page, with the history file served as GitHub
// Pages would. Every expected value is worked out HERE from the response's own rows / games or from the history file, never read
// back from the page: division W-L from the division-flagged games, GB from the H2H records, the wild-card gap from All-Play
// wins, the all-time rank from the history file's own season totals, Scoring from MFL's op / dp / pp.
//   node scripts/safe_tests/run.mjs --only standings_full_league_overall
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";
import { loadStandingsPage, workerFetch, settle, PAGE_SOURCE } from "./fixtures/standings_v2_page.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const json = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));
const REC = json("./fixtures/standings_2026_wk5.json");
const WK6 = json("./fixtures/standings_2026_wk6_week.json");
const S2025 = fs.readFileSync(new URL("./fixtures/standings_2025_recorded.json", import.meta.url), "utf8");
const HIST = json("../site/standings/allplay_history.json");
const SIM6 = json("./fixtures/wire_season_sim_2026_live_wk06.json");
const SIM5 = json("../site/wire/data/season_sim_2026_live_wk05.json");
const SCHED = fs.readFileSync(new URL("./fixtures/mfl_2026_schedule.json", import.meta.url), "utf8");
const WIRE_URL = "https://keithcreelman.github.io/upsmflproduction/wire/data/";
mfl.st.league = { standingsSort: REC.standingsSort };
const RACE = (() => { const w = {}; new Function("window", fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8"))(w); return w.UPS_STANDINGS_RACE; })();
const plain = (html) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html) => plain(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const HIST_URL = "https://keithcreelman.github.io/upsmflproduction/standings/allplay_history.json";

const season6 = () => { const s = recorded2026(REC); return { ...s, weeklyScores: s.weeklyScores.concat(WK6.weekly_scores), games: s.games.concat(WK6.games) }; };
const ENV6 = loadSeason(makeWorkerEnv({}), season6());
const RESP6 = (await callWorker(ENV6, "GET", "/api/standings?year=2026")).json;
// The harness D1 carries no owner or division names; these are the 2026 values of the production /api/standings read of 2026-10-22
// (the league's public standings): owner · division name per franchise.
const OWN = { "0009": ["Bear Dunn", "DOG POUND 4 LIFE"], "0005": ["Eric Martel", "Outlast PG Time"], "0010": ["Shawn Blake", "LEGION OF BOOM"], "0002": ["Derrick Whitman", "LEGION OF BOOM"], "0004": ["Brian Cutting", "Outlast PG Time"], "0008": ["Keith Creelman", "Maddie Mondays"], "0012": ["Chris Klingenberg", "DOG POUND 4 LIFE"], "0011": ["Eric Mannila", "DOG POUND 4 LIFE"], "0001": ["Ryan Bousquet", "Maddie Mondays"], "0006": ["Brian Cross", "Outlast PG Time"], "0003": ["Matt Gerardi", "LEGION OF BOOM"], "0007": ["Josh Martel", "Maddie Mondays"] };
const named = (j) => { j.rows.forEach((r) => { if (OWN[r.franchise_id] && r.owner_name == null) { r.owner_name = OWN[r.franchise_id][0]; r.division_name = OWN[r.franchise_id][1]; } }); return j; };
RESP6.rows.forEach((r) => { r.owner_name = OWN[r.franchise_id][0]; r.division_name = OWN[r.franchise_id][1]; });
const R = RESP6.rows;
const nameOf = Object.fromEntries(R.map((r) => [r.franchise_id, r.franchise_name]));
const seedOrder = R.map((r) => r.franchise_id);

// fetch = the real worker, with optional edits to /api/standings (edit(json, year)), a different history file, or a year → payload map
function mkFetch({ edit, hist = HIST, years = {}, wire = { "season_sim_2026_live_wk06.json": SIM6 }, schedule = "ok", reads } = {}) {
  const real = workerFetch(callWorker, ENV6);
  return async (url) => {
    if (url.startsWith(WIRE_URL)) { const name = url.slice(WIRE_URL.length); if (reads) reads.push(name); return wire[name] ? { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(wire[name])) } : { ok: false, status: 404, json: async () => ({}) }; }
    if (new URL(url).pathname === "/api/mfl-export" && new URL(url).searchParams.get("TYPE") === "schedule") {
      if (schedule === "fail") return { ok: false, status: 502, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => JSON.parse(SCHED) };
    }
    if (url === HIST_URL) return hist ? { ok: true, status: 200, json: async () => hist } : { ok: false, status: 404, json: async () => ({}) };
    const u = new URL(url);
    if (u.pathname === "/api/standings" && years[u.searchParams.get("year")]) return { ok: true, status: 200, json: async () => JSON.parse(years[u.searchParams.get("year")]) };
    if (u.pathname === "/api/historical-finishes") return { ok: true, status: 200, json: async () => ({ ok: true, rows: [] }) };
    const r = await real(url);
    if (u.pathname !== "/api/standings") return r;
    const j = await r.json();
    return { ...r, json: async () => (edit || ((x) => x))(named(JSON.parse(JSON.stringify(j)))) };
  };
}
async function league(query, opts = {}) {
  const p = loadStandingsPage({ query, fetch: opts.fetch || mkFetch(opts), pageSrc: opts.pageSrc });
  // magic: edit what the shared module's magicNumbers returns, to exercise the display states the Week 6 standings can't reach yet
  if (opts.magic) { const M = p.ctx.window.UPS_STANDINGS_RACE, orig = M.magicNumbers; M.magicNumbers = (a, b) => opts.magic(orig(a, b)); }
  await new Promise((r) => setTimeout(r, 300));
  await settle();
  const raw = p.html();
  return { raw, html: plain(raw), text: text(raw) };
}
function table(raw) {
  const tbl = /<table class="lg-table"><thead>([\s\S]*?)<\/thead><tbody>([\s\S]*?)<\/tbody><\/table>/.exec(raw);
  if (!tbl) return null;
  const heads = [...tbl[1].matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((m) => text(m[1]));
  const body = tbl[2].replace(/<tr class="disclosure-row"[\s\S]*?<\/tr>/g, "");
  const rows = [...body.matchAll(/<tr class="(?:you-row )?race-row"[^>]*data-fid="(\d{4})">([\s\S]*?)<\/tr>/g)]
    .map((m) => ({ fid: m[1], cells: [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => c[1]) }));
  const col = (label) => heads.indexOf(label);
  return { heads, rows, order: rows.map((r) => r.fid), cell: (fid, label) => text(rows.find((r) => r.fid === fid).cells[col(label)]), raw: (fid, label) => rows.find((r) => r.fid === fid).cells[col(label)] };
}
const sortedBy = (src, key, dir) => src.replace('overall: { sortKey: null, sortDir: "asc" }', 'overall: { sortKey: "' + key + '", sortDir: "' + dir + '" }');
const fmt1 = (n) => n.toFixed(1);

// ── independent expectations (Week 6) ──
const wins = (r) => r.regular_season.all_play.w + 0.5 * r.regular_season.all_play.t;
const inField = R.filter((r) => r.playoff_seed != null);
const lastWC = inField.filter((r) => r.playoff_status === "wild_card").sort((a, b) => b.playoff_seed - a.playoff_seed)[0];
const WCGB = Object.fromEntries(R.map((r) => [r.franchise_id, r.playoff_seed == null ? wins(lastWC) - wins(r) : null]));
const divGames = RESP6.weekly.filter((g) => g.po === 0 && g.div === 1);
const DIVWL = Object.fromEntries(R.map((r) => {
  const mine = divGames.filter((g) => g.fid === r.franchise_id);
  return [r.franchise_id, { w: mine.filter((g) => g.ts > g.os).length, l: mine.filter((g) => g.ts < g.os).length, t: mine.filter((g) => g.ts === g.os).length }];
}));
const leaderOf = {};
R.forEach((r) => { if (r.is_division_leader) leaderOf[r.division] = r; });
const DIVGB = Object.fromEntries(R.map((r) => { const l = leaderOf[r.division]; return [r.franchise_id, r.is_division_leader ? null : ((l.h2h_w - r.h2h_w) + (r.h2h_l - l.h2h_l)) / 2]; }));
// career by owner name, from the history file's own season totals
const norm = (n) => String(n || "").trim().replace(/\s+/g, " ").toLowerCase();
function career(owner, hist = HIST, year = 2026) {
  let w = 0, l = 0, tt = 0; const years = [];
  for (const [y, S] of Object.entries(hist.seasons)) {
    if (Number(y) >= year) continue;
    for (const x of Object.values(S.franchises)) if (norm(x.owner) === norm(owner)) { const a = x.ap[x.ap.length - 1]; w += a[0]; l += a[1]; tt += a[2]; years.push(Number(y)); }
  }
  const g = w + l + tt;
  return g ? { w, l, t: tt, pct: (w + 0.5 * tt) / g, years, review: years.some((y) => y <= 2017) } : null;
}

// ═══ the layout ═══
test("in season: exactly Seed | Team | H2H | Div W-L | Division GB | WC GB | Playoff % | AP | AP % | All-Time AP Rank | PF/Wk; Team = name, then 'Owner · Division'", async () => {
  const p = await league("view=league&year=2026");
  const L = table(p.raw);
  t.deepEqual(L.heads, ["Seed", "Team", "H2H", "Div W-L", "Division GB", "WC GB", "Playoff %", "AP", "AP %", "All-Time AP Rank", "PF/Wk"]);
  t.equal(L.rows.length, 12);
  t.deepEqual(L.order, seedOrder, "the worker's seed order, untouched");
  for (const r of R) {
    t.match(L.raw(r.franchise_id, "Team"), new RegExp('<span class="owner-sub">' + r.owner_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " · " + r.division_name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "</span>"), nameOf[r.franchise_id]);
    t.ok(!/sos-sub/.test(L.raw(r.franchise_id, "Team")), "no SoS line");
    t.equal(L.cell(r.franchise_id, "H2H"), r.h2h_w + "-" + r.h2h_l + (r.h2h_t ? "-" + r.h2h_t : ""));
  }
});
test("removed from this view: SoS, Luck Factor, Exp. W, cumulative PF, PA/game, Schedule, WC Back; their calculations still exist", async () => {
  const p = await league("view=league&year=2026");
  const L = table(p.raw);
  for (const gone of ["Schedule", "Luck Factor", "Luck", "Exp. W", "PF", "PA/game", "WC Back", "PF/week", "All-Play"]) t.ok(!L.heads.includes(gone), gone + " is not a Full League Overall column");
  t.ok(!/sos-sub|sos-note|SoS:/.test(p.raw), "no SoS anywhere in the view");
  t.ok(!/data-show="opponent"/.test(p.raw));
  // the calculations stay in the shared module for a later analytics page
  t.equal(RACE.scheduleStrength(RESP6).status, "ok");
  t.ok(Object.values(RACE.scoredFaced(RESP6).byFranchise).every((x) => x.overall.luck != null && x.overall.expectedWins != null && x.faced.paPerGame != null));
  // and Scoring still has its own PF / PF/Wk
  const scored = table((await league("view=league&year=2026&show=scored")).raw);
  t.deepEqual(scored.heads, ["Seed", "Team", "PF", "PF/Wk", "Offensive PF", "Offensive PF/Wk", "Defensive PF", "Defensive PF/Wk", "Potential PF"]);
  t.ok(!/ · /.test(text(scored.raw("0009", "Team"))), "Scoring's Team cell is unchanged (owner only)");
});

// ═══ Div W-L, Division GB, WC GB ═══
test("Div W-L = the H2H record against division rivals (from the division-flagged games, ties included)", async () => {
  const L = table((await league("view=league&year=2026")).raw);
  for (const r of R) {
    const d = DIVWL[r.franchise_id];
    t.equal(L.cell(r.franchise_id, "Div W-L"), d.w + "-" + d.l + (d.t ? "-" + d.t : ""), nameOf[r.franchise_id]);
    t.deepEqual([r.regular_season.division.w, r.regular_season.division.l, r.regular_season.division.t], [d.w, d.l, d.t], "the worker's own division record agrees");
  }
  t.equal(L.cell("0012", "Div W-L"), "0-4", "Hawks: 9-7 overall, 0-4 in the division");
});
test("Division GB = H2H games behind the division leader (existing worker figure): leader —, trailing teams one decimal; a non-leader level on record shows 0.0", async () => {
  const L = table((await league("view=league&year=2026")).raw);
  for (const r of R) {
    t.equal(L.cell(r.franchise_id, "Division GB"), DIVGB[r.franchise_id] == null ? "—" : fmt1(DIVGB[r.franchise_id]), nameOf[r.franchise_id]);
    t.equal(r.division_games_back, DIVGB[r.franchise_id] == null ? 0 : DIVGB[r.franchise_id], "the worker's figure = overall record gap to the leader");
  }
  t.equal(L.cell("0012", "Division GB"), "5.0"); t.equal(L.cell("0011", "Division GB"), "5.0");
  t.equal(L.cell("0005", "Division GB"), "—", "HammerTime leads division 00");
  // a team tied on record that the tiebreakers put second: GB 0 but not the leader → 0.0
  const tied = await league("view=league&year=2026", { edit: (j) => { const x = j.rows.find((r) => r.franchise_id === "0010"); x.division_games_back = 0; return j; } });
  t.equal(table(tied.raw).cell("0010", "Division GB"), "0.0");
});
test("WC GB = All-Play wins behind the last wild card (division winners protected): six teams outside show the gap, everyone holding a spot shows —; never negative", async () => {
  const L = table((await league("view=league&year=2026")).raw);
  t.equal(lastWC.franchise_id, "0004");
  for (const r of R) t.equal(L.cell(r.franchise_id, "WC GB"), WCGB[r.franchise_id] == null ? "—" : fmt1(WCGB[r.franchise_id]), nameOf[r.franchise_id]);
  t.deepEqual(Object.fromEntries(R.filter((r) => r.playoff_seed == null).map((r) => [r.franchise_id, L.cell(r.franchise_id, "WC GB")])), { "0012": "5.0", "0011": "10.0", "0001": "16.0", "0006": "18.0", "0003": "21.0", "0007": "28.0" });
  // a division winner is never the yardstick: Real Deal Creel (division winner, 6th seed) is not the cutoff
  t.equal(L.cell("0008", "WC GB"), "—");
  // an older worker's negative figure never shows as a number
  const neg = await league("view=league&year=2026", { edit: (j) => { j.rows.find((r) => r.franchise_id === "0012").ap_back = -1; return j; } });
  t.equal(table(neg.raw).cell("0012", "WC GB"), "—");
  // H2H is not the measure: Hawks and Cleon Ca$h (9-7, ahead of the 8-8 cutoff team on H2H) are still 5.0 and 10.0 back
  t.ok(R.find((r) => r.franchise_id === "0012").h2h_w > R.find((r) => r.franchise_id === "0004").h2h_w);
});

// ═══ sorting ═══
test("sorting: Div W-L by division win % (best first); Division GB ascending with leaders first; WC GB ascending among the teams outside, teams holding a spot last (— in both directions)", async () => {
  const pct = (id) => { const d = DIVWL[id]; return (d.w + 0.5 * d.t) / (d.w + d.l + d.t); };
  const stable = (key, cmp) => seedOrder.slice().sort((a, b) => cmp(a, b) || seedOrder.indexOf(a) - seedOrder.indexOf(b));
  const byDiv = await league("view=league&year=2026", { pageSrc: sortedBy(PAGE_SOURCE, "_divPct", "desc") });
  t.deepEqual(table(byDiv.raw).order, stable("_divPct", (a, b) => pct(b) - pct(a)));
  const gbKey = (id) => (DIVGB[id] == null ? -1 : DIVGB[id]);
  const byGB = await league("view=league&year=2026", { pageSrc: sortedBy(PAGE_SOURCE, "_divGBs", "asc") });
  t.deepEqual(table(byGB.raw).order, stable("_divGBs", (a, b) => gbKey(a) - gbKey(b)));
  const wcAsc = table((await league("view=league&year=2026", { pageSrc: sortedBy(PAGE_SOURCE, "_wcGB", "asc") })).raw).order;
  const chasers = seedOrder.filter((id) => WCGB[id] != null).sort((a, b) => WCGB[a] - WCGB[b]);
  t.deepEqual(wcAsc, chasers.concat(seedOrder.filter((id) => WCGB[id] == null)), "closest chaser first, then the six holding a spot in seed order");
  const wcDesc = table((await league("view=league&year=2026", { pageSrc: sortedBy(PAGE_SOURCE, "_wcGB", "desc") })).raw).order;
  t.deepEqual(wcDesc, chasers.slice().reverse().concat(seedOrder.filter((id) => WCGB[id] == null)), "descending: farthest first; the spots held still last");
  t.match(PAGE_SOURCE, /var ASC_FIRST = \{[^}]*_divGBs: 1, _wcGB: 1 \}/, "a first click on either GB header sorts ascending");
});

// ═══ All-Time AP Rank (the historical ranking restored, Keith 2026-10-27) ═══
function allTime(year = 2026, W = 6) {
  const pool = [];
  for (const [y, S] of Object.entries(HIST.seasons)) {
    if (Number(y) >= year || S.regularWeeks < W) continue;
    for (const x of Object.values(S.franchises)) { const a = x.ap[W - 1]; pool.push({ pct: (a[0] + 0.5 * a[2]) / (a[0] + a[1] + a[2]) }); }
  }
  const now = R.map((r) => { const ap = r.regular_season.all_play; return { fid: r.franchise_id, pct: (ap.w + 0.5 * ap.t) / (ap.w + ap.l + ap.t) }; });
  const all = pool.concat(now), key = (x) => Math.round(x.pct * 1e6);
  const out = {};
  for (const x of now) { let better = 0, same = 0; for (const y of all) { if (y === x) continue; if (key(y) > key(x)) better++; else if (key(y) === key(x)) same++; } out[x.fid] = { rank: better + 1, of: all.length, tied: same > 0 }; }
  return out;
}
const ord = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th");
test("All-Time AP Rank = this season's All-Play % ranked against every team-season since 2010 through the same week: '3rd of 204', ties T-; no percentile, no career %", async () => {
  const p = await league("view=league&year=2026");
  const L = table(p.raw);
  const want = allTime();
  for (const r of R) {
    const w = want[r.franchise_id];
    t.equal(L.cell(r.franchise_id, "All-Time AP Rank"), (w.tied ? "T-" : "") + ord(w.rank) + " of " + w.of, nameOf[r.franchise_id]);
  }
  t.equal(want["0009"].of, 204, "16 completed seasons x 12 teams + this season's 12");
  t.ok(!L.heads.includes("All-Time AP %"), "the header names a rank, not a percentage");
  t.ok(!/percentile|career All-Play|†/i.test(L.cell("0009", "All-Time AP Rank") + L.raw("0009", "All-Time AP Rank")), "no percentile and no career percentage in the cell");
  t.ok(!/percentile/i.test(p.text.replace(/<details[\s\S]*$/, "")), "no percentile wording on the page");
  // the owner-career calculation is kept for a later analytics page
  t.match(PAGE_SOURCE, /function ownerCareers\(resp, hist\)/);
  // sortable, best rank first
  const byRank = await league("view=league&year=2026", { pageSrc: sortedBy(PAGE_SOURCE, "_histRank", "asc") });
  t.deepEqual(table(byRank.raw).order, seedOrder.slice().sort((a, b) => want[a].rank - want[b].rank || seedOrder.indexOf(a) - seedOrder.indexOf(b)));
  // no history file → no column (never zeros)
  const none = await league("view=league&year=2026", { hist: null });
  t.ok(!table(none.raw).heads.includes("All-Time AP Rank"));
  t.match(p.text, /All-Time AP Rank = this season’s All-Play % against every team-season since 2010 through the same week; ties share a rank\./);
});

// ═══ Scoring (renamed from Scored): points production, total / offensive / defensive, and potential ═══
const ENV5 = loadSeason(makeWorkerEnv({}), recorded2026(REC));
const RESP5 = (await callWorker(ENV5, "GET", "/api/standings?year=2026")).json;
const MFLLS = json("./fixtures/mfl_2026_wk5_league_standings.json");
function mkFetch5({ ls = MFLLS, years = {} } = {}) {
  const real = workerFetch(callWorker, ENV5);
  return async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/mfl-export" && u.searchParams.get("TYPE") === "leagueStandings") {
      const y = u.searchParams.get("YEAR");
      return ls && (years[y] !== undefined ? years[y] : true) ? { ok: true, status: 200, json: async () => ls } : { ok: false, status: 404, json: async () => ({}) };
    }
    if (url === HIST_URL) return { ok: true, status: 200, json: async () => HIST };
    const r = await real(url);
    if (u.pathname !== "/api/standings") return r;
    const j = await r.json();
    // The harness D1 holds no potential points (src_standings.pp is NULL). In production pp is MFL's potential total, and it
    // equals the sum of the team's weekly optimal scores (checked on the 2026 Week 5 read: 1454.6 both ways), so the rows get it that way.
    j.rows.forEach((x) => { x.pp = Math.round(10 * j.weeklyScores.filter((w) => w.fid === x.franchise_id && w.po === 0).reduce((a, w) => a + w.opt, 0)) / 10; });
    return { ...r, json: async () => j };
  };
}
const weeks5 = new Set(RESP5.weeklyScores.filter((x) => x.po === 0).map((x) => x.w)).size;
const LS5 = Object.fromEntries(MFLLS.leagueStandings.franchise.map((f) => [f.id, f]));
test("Scoring: PF | PF/Wk | Offensive PF | Offensive PF/Wk | Defensive PF | Defensive PF/Wk | Potential PF; the Show control says Scoring; ?show=scored and ?show=scoring both open it", async () => {
  const p = await league("view=league&year=2026&show=scoring", { fetch: mkFetch5() });
  const L = table(p.raw);
  t.deepEqual(L.heads, ["Seed", "Team", "PF", "PF/Wk", "Offensive PF", "Offensive PF/Wk", "Defensive PF", "Defensive PF/Wk", "Potential PF"]);
  t.match(p.raw, /data-show="scored" aria-pressed="true">Scoring<\/button>/);
  t.ok(!/>Scored</.test(p.raw), "the old name is gone");
  t.deepEqual(table((await league("view=league&year=2026&show=scored", { fetch: mkFetch5() })).raw).heads, L.heads);
  t.equal(weeks5, 5);
  const num = (txt) => Number(txt.replace(/,/g, ""));
  for (const r of RESP5.rows) {
    const f = r.franchise_id, ls = LS5[f];
    t.ok(Math.abs(num(L.cell(f, "PF")) - r.pf_total) < 0.051, "PF " + f);
    t.ok(Math.abs(num(L.cell(f, "PF/Wk")) - r.pf_total / weeks5) < 0.051, "PF/Wk " + f);
    t.ok(Math.abs(num(L.cell(f, "Offensive PF")) - Number(ls.op)) < 0.051, "Offensive PF " + f);
    t.ok(Math.abs(num(L.cell(f, "Offensive PF/Wk")) - Number(ls.op) / weeks5) < 0.051, "Offensive PF/Wk " + f);
    t.ok(Math.abs(num(L.cell(f, "Defensive PF")) - Number(ls.dp)) < 0.051, "Defensive PF " + f);
    t.ok(Math.abs(num(L.cell(f, "Defensive PF/Wk")) - Number(ls.dp) / weeks5) < 0.051, "Defensive PF/Wk " + f);
    t.ok(Math.abs(num(L.cell(f, "Potential PF")) - RESP5.weeklyScores.filter((w) => w.fid === f && w.po === 0).reduce((a, w) => a + w.opt, 0)) < 0.051, "Potential PF " + f + " = the sum of the weekly optimal scores (MFL's potential points)");
    t.ok(Math.abs(Number(ls.op) + Number(ls.dp) - r.pf_total) < 0.15, "offense + defense add up to PF " + f);
  }
});
test("Scoring: removed rankings and trends (PF rank, average weekly rank, best / worst week, last 3 weeks) are not shown, and the calculations remain", async () => {
  const L = table((await league("view=league&year=2026&show=scored", { fetch: mkFetch5() })).raw);
  for (const gone of ["PF rank", "Avg wk rank", "Best week", "Worst week", "Last 3 avg rank", "PF/week"]) t.ok(!L.heads.includes(gone), gone);
  const sf = RACE.scoredFaced(RESP5).byFranchise["0009"].scored;
  t.ok(sf.pfRank != null && sf.avgWeeklyRank != null && sf.highWeek && sf.lowWeek && sf.last3, "scoredFaced still computes all five");
  t.ok(!/Offensive Potential|Defensive Potential/.test(L.raw("0009", "Potential PF")) && !L.heads.some((h) => /Potential/.test(h) && h !== "Potential PF"), "no offensive / defensive potential columns (they would need a new calculation)");
});
test("Scoring: offensive / defensive points show — and say why when MFL's two totals don't add up, aren't available, or the season predates 2017", async () => {
  const bad = JSON.parse(JSON.stringify(MFLLS)); bad.leagueStandings.franchise[0].op = String(Number(bad.leagueStandings.franchise[0].op) + 25);
  let p = await league("view=league&year=2026&show=scored", { fetch: mkFetch5({ ls: bad }) });
  let L = table(p.raw);
  for (const r of RESP5.rows) { t.equal(L.cell(r.franchise_id, "Offensive PF"), "—"); t.equal(L.cell(r.franchise_id, "Defensive PF/Wk"), "—"); t.ok(L.cell(r.franchise_id, "PF") !== "—" && L.cell(r.franchise_id, "Potential PF") !== "—"); }
  t.match(p.text, /Offensive and defensive points show — because MFL’s two totals don’t add up to the weekly scores\./);
  p = await league("view=league&year=2026&show=scored", { fetch: mkFetch5({ ls: null }) });
  t.match(p.text, /Offensive and defensive points show — because MFL’s split isn’t available for this season\./);
  t.equal(table(p.raw).cell("0009", "Offensive PF"), "—");
});
test("Scoring: Seed order is the worker's; sortable by every points column", async () => {
  const L = table((await league("view=league&year=2026&show=scored", { fetch: mkFetch5() })).raw);
  t.deepEqual(L.order, RESP5.rows.map((r) => r.franchise_id));
  const byOpf = await league("view=league&year=2026&show=scored", { fetch: mkFetch5(), pageSrc: sortedBy(PAGE_SOURCE, "_opf", "desc") });
  const ids = RESP5.rows.map((r) => r.franchise_id);
  t.deepEqual(table(byOpf.raw).order, ids.slice().sort((a, b) => Number(LS5[b].op) - Number(LS5[a].op) || ids.indexOf(a) - ids.indexOf(b)));
});

// ═══ Playoff % (Phase 1): the Forecast's odds, plus the existing X / Y clinch checks ═══
const odds = (p) => (p >= 0.995 ? ">99%" : p > 0 && p < 0.005 ? "<1%" : Math.round(p * 100) + "%");
const simBy = Object.fromEntries(SIM6.teams.map((x) => [x.franchiseId, x]));
const clinch = (byFid) => (m) => ({ ...m, byFid: { ...m.byFid, ...Object.fromEntries(Object.entries(byFid).map(([f, v]) => [f, { ...(m.byFid[f] || {}), ...v }])) } });
test("Playoff % = the Forecast tab's own odds for every team (playoff % with the bye % beneath); a rounded near-100% is '>99%', never a clinch", async () => {
  const p = await league("view=league&year=2026");
  const L = table(p.raw);
  t.equal(L.heads[L.heads.indexOf("WC GB") + 1], "Playoff %", "right after WC GB");
  for (const r of R) {
    const x = simBy[r.franchise_id], cell = L.raw(r.franchise_id, "Playoff %");
    t.equal(text(cell).split(" ")[0], odds(x.currentPlayoffOdds), nameOf[r.franchise_id] + " playoff %");
    t.equal(x.currentByeOdds > 0 ? plain(/po-sub">([^<]*)</.exec(cell)[1]) : null, x.currentByeOdds > 0 ? odds(x.currentByeOdds) + " Bye" : null, nameOf[r.franchise_id] + " bye %");
    t.ok(!/po-badge/.test(cell), "no designation without a mathematical clinch: " + nameOf[r.franchise_id]);
  }
  t.equal(L.cell("0009", "Playoff %"), ">99% 94% Bye", "C-Town: 99.8% is not 100% and not a clinch");
  t.equal(L.cell("0003", "Playoff %"), "2%", "no bye line when the bye odds are 0");
  // the very numbers the Forecast tab shows
  const fc = await league("view=forecast&year=2026");
  t.ok(fc.text.includes("Through Week 6") && SIM6.teams.length === 12);
  t.match(p.text, /Playoff % = the UPS Wire forecast’s chance of making the playoffs \(through Week 6, generated [^)]*\), with the chance of a first-round bye beneath\./);
});
test("real clinch logic at Week 6: nobody has clinched anything yet, so no X or Y shows", async () => {
  const L = table((await league("view=league&year=2026")).raw);
  for (const r of R) t.ok(!/po-badge/.test(L.raw(r.franchise_id, "Playoff %")), r.franchise_id);
  const m = RACE.magicNumbers(RESP6, JSON.parse(SCHED));
  t.equal(m.status, "ok");
  t.ok(Object.values(m.byFid).every((e) => !e.clinchedDivision && !e.clinchedSpot));
});
test("X and Y: the highest one shows (Y over X), with the bye % still beneath where it means something; the legend explains them and that Y is not a bye", async () => {
  const p = await league("view=league&year=2026", { magic: clinch({ "0009": { clinchedDivision: true, clinchedSpot: true }, "0004": { clinchedSpot: true }, "0010": { clinchedSpot: true } }) });
  const L = table(p.raw);
  t.match(L.raw("0009", "Playoff %"), /^<span class="po-badge po-y" title="Clinched the division\. The first-round byes go to the two best division winners by All-Play %, so a bye isn’t guaranteed yet\.">Y<\/span><span class="owner-sub po-sub">94% Bye<\/span>$/);
  t.match(L.raw("0004", "Playoff %"), /^<span class="po-badge po-x" title="Clinched a playoff spot\.">X<\/span><span class="owner-sub po-sub">31% Bye<\/span>$/);
  t.equal(L.cell("0005", "Playoff %"), "97% 49% Bye", "HammerTime, not clinched: still a percentage");
  t.ok(!/X|Y/.test(L.cell("0005", "Playoff %")));
  t.match(p.text, /X = clinched a playoff spot\. Y = clinched the division \(the byes go to the two best division winners by All-Play %, so a bye isn’t guaranteed\)\. A percentage is never a clinch\./);
  // sorting: Y first, then X, then the percentages
  const byPo = await league("view=league&year=2026", { magic: clinch({ "0009": { clinchedDivision: true }, "0004": { clinchedSpot: true } }), pageSrc: sortedBy(PAGE_SOURCE, "_poSort", "desc") });
  const order = table(byPo.raw).order;
  t.equal(order[0], "0009"); t.equal(order[1], "0004");
  const rest = seedOrder.filter((f) => f !== "0009" && f !== "0004").sort((a, b) => simBy[b].currentPlayoffOdds - simBy[a].currentPlayoffOdds || seedOrder.indexOf(a) - seedOrder.indexOf(b));
  t.deepEqual(order.slice(2), rest);
});
test("a stale or non-reconciling forecast shows NO percentage (—), while independently verified X / Y still show", async () => {
  const m = clinch({ "0009": { clinchedDivision: true, clinchedSpot: true } });
  const stale = await league("view=league&year=2026", { wire: { "season_sim_2026_live_wk05.json": SIM5 }, magic: m });
  let L = table(stale.raw);
  t.equal(L.cell("0009", "Playoff %"), "Y");
  t.equal(L.cell("0005", "Playoff %"), "—");
  for (const r of R) t.ok(!/%/.test(L.cell(r.franchise_id, "Playoff %")), "no percentage for " + r.franchise_id);
  t.match(stale.text, /Playoff % shows no percentage because the Week 6 forecast isn’t published yet \(the newest is Week 5\)\./);
  const g = RESP6.weekly.find((x) => x.w === 6 && x.po === 0 && x.ts !== x.os);
  const flip = JSON.parse(JSON.stringify(SIM6)); const A = flip.teams.find((x) => x.franchiseId === g.fid), Bt = flip.teams.find((x) => x.franchiseId === g.opp);
  [A.weekScore, Bt.weekScore] = [Bt.weekScore, A.weekScore];
  const bad = await league("view=league&year=2026", { wire: { "season_sim_2026_live_wk06.json": flip } });
  L = table(bad.raw);
  t.ok(!L || !L.heads.includes("Playoff %") || R.every((r) => !/%/.test(L.cell(r.franchise_id, "Playoff %"))), "no percentage from a forecast that doesn't start from these standings");
  t.match(bad.text, /the Week 6 forecast doesn’t start from these standings/);
  const none = await league("view=league&year=2026", { wire: {} });
  t.match(none.text, /no forecast has been published for 2026 yet/);
});
test("no schedule: Y isn't shown (and the note says so), nothing is claimed, and the forecast percentages still are", async () => {
  const p = await league("view=league&year=2026", { schedule: "fail" });
  const L = table(p.raw);
  t.equal(L.cell("0009", "Playoff %"), ">99% 94% Bye");
  t.match(p.text, /Y isn’t shown because the division race needs MFL’s schedule, which couldn’t be read\./);
  t.ok(!/po-badge/.test(p.raw), "and nothing is claimed without it");
});
test("Playoff % appears only for the season in progress: not in Scoring, a scoped view, a finished season or the preseason", async () => {
  for (const q of ["&show=scored", "&scope=regular", "&scope=playoffs"]) {
    const L = table((await league("view=league&year=2026" + q, { fetch: q === "&show=scored" ? mkFetch5() : undefined })).raw);
    t.ok(!L.heads.includes("Playoff %"), q);
  }
  const fin = await league("view=league&year=2025", { years: { "2025": S2025 } });
  t.ok(!table(fin.raw).heads.includes("Playoff %"));
});

// ═══ finished season, scope ═══
test("finished season: Fin kept; Div W-L and Division GB from the recorded rows (leader —, GB from the recorded records); no WC GB, no All-Time AP %; 2010 withheld and 2011–2013 flagged", async () => {
  const recorded = JSON.parse(S2025);
  const years = { "2025": S2025, "2010": S2025, "2012": S2025 };
  const p = await league("view=league&year=2025", { years });
  const L = table(p.raw);
  t.deepEqual(L.heads, ["Seed", "Fin", "Team", "H2H", "Div W-L", "Division GB", "AP", "AP %", "PF/Wk"]);
  const lead = {}; recorded.rows.forEach((r) => { if (r.is_division_leader) lead[r.division] = r; });
  for (const r of recorded.rows) {
    t.equal(L.cell(r.franchise_id, "Div W-L"), r.div_w + "-" + r.div_l, nameOf[r.franchise_id] || r.franchise_id);
    const l = lead[r.division];
    t.equal(L.cell(r.franchise_id, "Division GB"), r.is_division_leader ? "—" : fmt1(((l.h2h_w - r.h2h_w) + (r.h2h_l - l.h2h_l)) / 2), "GB " + r.franchise_id);
  }
  t.ok(!/Div W-L and Division GB (aren’t shown|for)/.test(p.text), "2025 carries no review flag");
  const y10 = await league("view=league&year=2010", { years });
  const L10 = table(y10.raw);
  for (const id of L10.order) { t.equal(L10.cell(id, "Div W-L"), "—"); t.equal(L10.cell(id, "Division GB"), "—"); }
  t.match(y10.text, /Div W-L and Division GB aren’t shown for 2010: its division standings are still under review \(#1329 C6\/C9, #1378\)\./);
  t.match((await league("view=league&year=2012", { years })).text, /Div W-L and Division GB for 2012 come from stored standings that an open correction \(#1329 C7\) still touches: unverified\./);
});
test("Regular Season / Playoffs / Custom scope: the season-level columns (Div W-L, GB, WC GB, All-Time AP %) are hidden; the others stay", async () => {
  for (const q of ["&scope=regular", "&scope=playoffs", "&scope=custom&cs=2&ce=4"]) {
    const L = table((await league("view=league&year=2026" + q)).raw);
    if (!L) continue;
    t.deepEqual(L.heads, ["Seed", "Team", "H2H", "AP", "AP %", "PF/Wk"], q);
  }
});
test("preseason: no division GB or WC GB invented", async () => {
  const pre = await league("view=league&year=2026", { edit: (j) => ({ ...j, preseason: true }) });
  const L = table(pre.raw);
  if (L) for (const id of L.order) { t.equal(L.cell(id, "Division GB"), "—"); t.equal(L.cell(id, "WC GB"), "—"); }
});

await run("standings_full_league_overall");
mfl.restore();
restore();
