// Desktop wide Full League Overall (#1388, Keith 2026-10-26/27): Seed | Team | H2H | Div W-L | Division GB | WC GB | AP | AP % |
// All-Time AP % | PF/Wk. The REAL /api/standings route (worker harness) on the recorded 2026 season through Week 6 (the
// standings_wc_back recording) and on the recorded 2025 season → the REAL desktop page, with the history file served as GitHub
// Pages would. Every expected value is worked out HERE from the response's own rows / games or from the history file, never read
// back from the page: division W-L from the division-flagged games, GB from the H2H records, the wild-card gap from All-Play
// wins, the career percentage from the file's own season totals matched by owner name.
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
function mkFetch({ edit, hist = HIST, years = {} } = {}) {
  const real = workerFetch(callWorker, ENV6);
  return async (url) => {
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
test("in season: exactly Seed | Team | H2H | Div W-L | Division GB | WC GB | AP | AP % | All-Time AP % | PF/Wk; Team = name, then 'Owner · Division'", async () => {
  const p = await league("view=league&year=2026");
  const L = table(p.raw);
  t.deepEqual(L.heads, ["Seed", "Team", "H2H", "Div W-L", "Division GB", "WC GB", "AP", "AP %", "All-Time AP %", "PF/Wk"]);
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
  // and Scored still has its own PF / PF/week
  const scored = table((await league("view=league&year=2026&show=scored")).raw);
  t.deepEqual(scored.heads, ["Seed", "Team", "PF", "PF/week", "PF rank", "Avg wk rank", "Best week", "Worst week", "Last 3 avg rank"]);
  t.ok(!/ · /.test(text(scored.raw("0009", "Team"))), "Scored's Team cell is unchanged (owner only)");
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

// ═══ All-Time AP % = the current owner's career ═══
test("All-Time AP % = the owner's career All-Play over completed seasons (wins and games summed, matched by owner name), not the franchise slot's", async () => {
  const L = table((await league("view=league&year=2026")).raw);
  const seen = {};
  for (const r of R) {
    const c = career(r.owner_name);
    const want = c ? (c.pct * 100).toFixed(1) + "%" + (c.review ? " †" : "") : "—";
    t.equal(L.cell(r.franchise_id, "All-Time AP %"), want, r.owner_name + " (" + (c ? c.years.length : 0) + " seasons)");
    seen[r.owner_name] = want;
    if (c) {
      const tip = /title="([^"]*)"/.exec(L.raw(r.franchise_id, "All-Time AP %"))[1];
      t.match(plain(tip), new RegExp("Career All-Play, " + c.years.length + " season"), "tooltip carries the seasons count");
      t.match(plain(tip), new RegExp(c.w + "-" + c.l + (c.t ? "-" + c.t : "")), "and the career record");
      t.equal(/review|under review/.test(plain(tip)), c.review, "the review flag follows 2010-2017");
    }
  }
  // owners whose slot had other owners earlier are NOT credited with that history
  t.equal(seen["Eric Martel"], "61.5%", "Eric Martel: his own 3 seasons (slot 0005's all-time figure is 44.2%)");
  t.equal(seen["Brian Cross"], "39.0%", "Brian Cross: his one season");
  t.ok(/†/.test(seen["Bear Dunn"]) && !/†/.test(seen["Eric Martel"]) && !/†/.test(seen["Brian Cross"]), "† only where 2010–2017 seasons are included");
  t.match(text(L.raw("0009", "All-Time AP %")), /^\d\d\.\d% †$/);
});
test("career maths: wins and ties summed over all games (not an average of season percentages); the current season and unnamed owners are excluded", async () => {
  const mk = (owner, ap) => ({ team: "T", owner, ap });
  const hist = { schema: 1, seasons: {
    "2020": { regularWeeks: 1, teams: 2, franchises: { "0009": mk("Bear Dunn", [[1, 1, 0]]), "0001": mk("Other", [[0, 2, 0]]) } },
    "2021": { regularWeeks: 1, teams: 2, franchises: { "0009": mk("Bear Dunn", [[9, 1, 0]]) } },
    "2026": { regularWeeks: 1, teams: 2, franchises: { "0009": mk("Bear Dunn", [[11, 0, 0]]) } } } };
  const L = table((await league("view=league&year=2026", { hist })).raw);
  // (1 + 9) / (2 + 10) = 83.3%, not the mean of 50% and 90% (70%); the 2026 entry is ignored; later seasons only (no †: no 2010-2017)
  t.equal(L.cell("0009", "All-Time AP %"), "83.3%");
  t.match(plain(/title="([^"]*)"/.exec(L.raw("0009", "All-Time AP %"))[1]), /2 seasons \(2020–2021\): 10-2/);
  t.equal(L.cell("0012", "All-Time AP %"), "—", "an owner name with no completed season shows —, not a made-up history");
  t.match((await league("view=league&year=2026", { hist })).text, /— = no completed season found under that name/);
  const none = await league("view=league&year=2026", { hist: null });
  t.ok(!table(none.raw).heads.includes("All-Time AP %"), "no history file → no column (never zeros)");
  const byCareer = await league("view=league&year=2026", { pageSrc: sortedBy(PAGE_SOURCE, "_careerPct", "desc") });
  const want = seedOrder.slice().sort((a, b) => ((career(R.find((r) => r.franchise_id === b).owner_name) || { pct: -1 }).pct) - ((career(R.find((r) => r.franchise_id === a).owner_name) || { pct: -1 }).pct) || seedOrder.indexOf(a) - seedOrder.indexOf(b));
  t.deepEqual(table(byCareer.raw).order, want, "sortable by the career percentage");
});
test("the note says what † means and that owner identities are unverified", async () => {
  const p = await league("view=league&year=2026");
  t.match(p.text, /All-Time AP % = the current owner’s career All-Play % \(all wins ÷ all games\) over completed seasons since 2010, matched by owner name\. † = includes 2010–2017, where 2010 weekly scores and owner identities are still under review \(#1329\): not verified\./);
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
