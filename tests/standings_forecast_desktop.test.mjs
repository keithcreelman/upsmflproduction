// Standings Forecast (Keith 2026-10-21): "Make Full League the default and first Standings view ... Build Forecast from
// the same simulation and calculation used by UPS Wire. Do not create a second forecasting model ... The Forecast must
// reconcile with Full League, Divisions and Playoff Picture for the same simulation."
// The REAL /api/standings route (worker harness) on the recorded 2026 season through Week 6 → the REAL desktop page,
// with the Wire's own published files served as GitHub Pages would: season_sim_2026_live_wk05.json (site/wire/data),
// the Week 6 Wire forecast (tests/fixtures/wire_season_sim_2026_live_wk06.json = draft #1367's file) and its place /
// runner-up / Hawk Tuah counts (site/wire/data/standings_forecast_2026_wk06.json). Every expected value is worked out
// here from those files, never read back from the page's own arithmetic.
//   node scripts/safe_tests/run.mjs --only standings_forecast_desktop
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";
import { loadStandingsPage, workerFetch, settle } from "./fixtures/standings_v2_page.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const json = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), "utf8"));
const REC = json("./fixtures/standings_2026_wk5.json");
const WK6 = json("./fixtures/standings_2026_wk6_week.json");
mfl.st.league = { standingsSort: REC.standingsSort };
// The published Week 5/6 forecasts were simulated before the playoff-ladder correction (canon §F.1, Keith 2026-11-25) and
// the page refuses them as published (model.seedingRule missing). These tests check the page's handling of a forecast, so
// they serve the files marked as a corrected run, with the rule string from the simulator itself; the refusal is tested too.
const SEEDING_RULE = fs.readFileSync(new URL("../pipelines/etl/wire/season_sim.py", import.meta.url), "utf8").match(/^SEEDING_RULE = "(.*)"$/m)[1];
const asCorrectedRun = (sim) => ({ ...sim, model: { ...(sim.model || {}), seedingRule: SEEDING_RULE } });
const SIM6_AS_PUBLISHED = json("./fixtures/wire_season_sim_2026_live_wk06.json"), SIM6 = asCorrectedRun(SIM6_AS_PUBLISHED);
const SIM5 = asCorrectedRun(json("../site/wire/data/season_sim_2026_live_wk05.json"));
const DET6 = json("../site/wire/data/standings_forecast_2026_wk06.json");
const plain = (html) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html) => plain(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
// the shared policy with no verified outcome (site/shared/odds_display.js): never 100% or 0%
const pct = (p) => (p > 0.99 ? ">99%" : p < 0.01 ? "<1%" : Math.round(p * 100) + "%");

const season6 = () => { const s = recorded2026(REC); return { ...s, weeklyScores: s.weeklyScores.concat(WK6.weekly_scores), games: s.games.concat(WK6.games) }; };
const ENV6 = loadSeason(makeWorkerEnv({}), season6());
const RESP6 = (await callWorker(ENV6, "GET", "/api/standings?year=2026")).json;
const nameOf = Object.fromEntries(RESP6.rows.map((r) => [r.franchise_id, r.franchise_name]));
const WIRE = "https://keithcreelman.github.io/upsmflproduction/wire/data/";

// files: { name: object | undefined } served at WIRE + name (404 when absent); everything else goes to the real worker.
function fetchWith(files) {
  const worker = workerFetch(callWorker, ENV6);
  const reads = [];
  const f = async (url) => {
    if (url.startsWith(WIRE)) {
      const name = url.slice(WIRE.length); reads.push(name);
      const body = files[name];
      return body ? { ok: true, status: 200, json: async () => JSON.parse(JSON.stringify(body)) } : { ok: false, status: 404, json: async () => ({}) };
    }
    return worker(url);
  };
  f.reads = reads;
  return f;
}
const PUBLISHED = { "season_sim_2026_live_wk05.json": SIM5, "season_sim_2026_live_wk06.json": SIM6, "standings_forecast_2026_wk06.json": DET6 };
async function page(query, files = PUBLISHED, opts = {}) {
  const fetch = fetchWith(files);
  const p = loadStandingsPage({ query, fetch });
  // clinch: edit what the validated engine returns, to reach states the Week 6 standings can't yet
  if (opts.clinch) { const C = p.ctx.window.UPS_STANDINGS_CLINCH, orig = C.analyze; C.analyze = (i) => opts.clinch(orig(i)); }
  await new Promise((r) => setTimeout(r, 2700));   // in-season magic numbers wait up to 2.5 s for MFL's schedule
  await settle();
  return { h: plain(p.html()), reads: fetch.reads };
}
const teams6 = Object.fromEntries(SIM6.teams.map((x) => [x.franchiseId, x]));
const prev5 = Object.fromEntries(SIM5.teams.map((x) => [x.franchiseId, x]));
const D = DET6.standingsForecast.teams;

// ═══ navigation ═══
test("tabs: Full League, Divisions, Playoff Picture, Forecast, Weekly, Trends (no History tab) — and Full League is the default", async () => {
  const { h } = await page("year=2026");
  const tabs = [...h.matchAll(/<button type="button" class="view-btn" role="tab" data-view="(\w+)" aria-selected="(true|false)"[^>]*>([^<]*)<\/button>/g)];
  t.deepEqual(tabs.map((m) => m[3]), ["Full League", "Divisions", "Playoff Picture", "Forecast", "Weekly", "Trends"]);
  t.deepEqual(tabs.filter((m) => m[2] === "true").map((m) => m[1]), ["league"], "Full League selected with no ?view=");
  t.match(h, /<table class="lg-table"><thead>/, "and the Full League table is drawn");
  const pic = await page("view=picture&year=2026");
  t.match(pic.h, /data-view="picture" aria-selected="true"/, "old links with ?view=picture still open the Playoff Picture");
});

// ═══ the forecast is the Wire's own run ═══
test("the Week 6 forecast reconciles with the standings: every team's Week 6 score and All-Play W-L-T", () => {
  const ws = RESP6.weeklyScores.filter((s) => s.po === 0 && s.w <= 6);
  for (const r of RESP6.rows) {
    const f = r.franchise_id, sim = teams6[f];
    const mine = ws.filter((s) => s.fid === f);
    let w = 0, l = 0, tt = 0;
    for (const s of mine) for (const o of ws.filter((x) => x.w === s.w && x.fid !== f)) { if (s.ts > o.ts) w++; else if (s.ts < o.ts) l++; else tt++; }
    t.deepEqual([w, l, tt], [sim.currentApWins, sim.currentApLosses, sim.currentApTies], nameOf[f] + " All-Play");
    t.deepEqual([w, l, tt], [r.allplay_w, r.allplay_l, r.allplay_t], nameOf[f] + " = Full League");
    t.ok(Math.abs(mine.find((s) => s.w === 6).ts - sim.weekScore) < 0.051, nameOf[f] + " Week 6 score");
  }
  t.equal(DET6.wire.generatedAtUtc, SIM6.generatedAtUtc, "the place counts belong to this exact Wire run");
  for (const x of SIM6.teams) t.deepEqual(DET6.wire.teams[x.franchiseId], [x.currentPlayoffOdds, x.currentByeOdds, x.currentDivisionOdds, x.currentTitleOdds]);
});
test("Outlook: the summary leads (champion, Hawk Tuah Bowl, byes, division winners), then the projected order with Week 5 movement", async () => {
  const { h, reads } = await page("view=forecast&year=2026");
  t.deepEqual(reads, ["season_sim_2026_live_wk06.json", "season_sim_2026_live_wk05.json", "standings_forecast_2026_wk06.json"], "three static reads, newest first");
  t.match(text(h), /Through Week 6 · 10,000 simulated seasons · run Oct 21, 10:06 AM ET/);
  const by = (k) => Object.keys(D).sort((a, b) => D[b][k] - D[a][k] || a.localeCompare(b));
  const champ = SIM6.teams.slice().sort((a, b) => b.currentTitleOdds - a.currentTitleOdds)[0];
  const tiles = /<div class="fc-tiles">([\s\S]*?)<h3 class="sec-h">/.exec(h)[1];
  t.match(text(tiles), new RegExp("UPS Championship " + nameOf[champ.franchiseId] + " " + pct(champ.currentTitleOdds)));
  const hawk = by("hawkTitleOdds")[0];
  t.match(text(tiles), new RegExp("Hawk Tuah Bowl " + nameOf[hawk].replace(/\$/g, "\\$") + " " + pct(D[hawk].hawkTitleOdds)));
  const byes = SIM6.teams.slice().sort((a, b) => b.currentByeOdds - a.currentByeOdds).slice(0, 2);
  for (const b of byes) t.ok(text(tiles).includes(nameOf[b.franchiseId]) && text(tiles).includes(pct(b.currentByeOdds)), "bye: " + nameOf[b.franchiseId]);
  for (const d of new Set(RESP6.rows.map((r) => r.division))) {
    const fav = SIM6.teams.filter((x) => x.division === d).sort((a, b) => b.currentDivisionOdds - a.currentDivisionOdds)[0];
    t.ok(text(tiles).includes(nameOf[fav.franchiseId] + " " + pct(fav.currentDivisionOdds)), "division " + d + ": " + nameOf[fav.franchiseId]);
  }
  t.ok(h.indexOf("fc-tiles") < h.indexOf("Projected final standings"), "summary first");
  t.ok(!/<details class="about" open/.test(h), "the method stays behind How the forecast works");
  // the table: order of average finish, playoff odds and the change since the Week 5 forecast
  const order = Object.keys(D).sort((a, b) => D[a].expectedPlace - D[b].expectedPlace || teams6[b].projectedEndingApPct - teams6[a].projectedEndingApPct);
  const rows = [...h.matchAll(/<tr(?: class="[^"]*")? data-fid="(\d{4})">([\s\S]*?)<\/tr>/g)];
  t.deepEqual(rows.map((m) => m[1]), order);
  rows.forEach((m) => {
    const f = m[1], cells = [...m[2].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => text(c[1]).trim());
    const mode = D[f].place.indexOf(Math.max(...D[f].place));
    t.equal(cells[2], (mode < 6 ? "Seed " + (mode + 1) : "H" + (mode - 5)) + " " + pct(D[f].place[mode]), nameOf[f] + " most likely");
    t.equal(cells[3], pct(teams6[f].currentPlayoffOdds));
    t.equal(cells[6], pct(teams6[f].currentTitleOdds));
    const d = Math.round((teams6[f].currentPlayoffOdds - prev5[f].currentPlayoffOdds) * 100);
    t.equal(cells[7], d ? (d > 0 ? "▲" : "▼") + Math.abs(d) : "0", nameOf[f] + " Δ since Week 5");
  });
  t.match(h, /Starts from the Week 6 standings: all 12 teams’ scores and All-Play match the Weekly and Full League views\./);
});
// #1370 gates 3 and 4: three separate answers per bracket, the final only from the simulation's pair counts; freshness up front.
const esc = (x) => x.replace(/[$()]/g, "\\$&");
function matchups(side) {
  const by = {};
  for (const [c, r, p] of DET6.standingsForecast.finalPairs[side]) {
    const k = [c, r].sort().join("|");
    by[k] = by[k] || { k, p: 0, wins: {} };
    by[k].p += p; by[k].wins[c] = (by[k].wins[c] || 0) + p;
  }
  return Object.values(by).sort((a, b) => b.p - a.p || a.k.localeCompare(b.k));
}
test("summary: most likely champion, runner-up and final are separate answers; the final is the most common counted pairing", async () => {
  const { h } = await page("view=forecast&year=2026");
  const tiles = text(/<div class="fc-tiles">([\s\S]*?)<h3 class="sec-h">/.exec(h)[1]);
  for (const [side, ck, rk, title] of [["ups", "titleOdds", "runnerUpOdds", "UPS Championship"], ["hawk", "hawkTitleOdds", "hawkRunnerUpOdds", "Hawk Tuah Bowl"]]) {
    const top = (k) => Object.keys(D).sort((a, b) => D[b][k] - D[a][k] || a.localeCompare(b))[0];
    const champ = side === "ups" ? SIM6.teams.slice().sort((a, b) => b.currentTitleOdds - a.currentTitleOdds)[0].franchiseId : top(ck);
    const runner = top(rk), m = matchups(side)[0];
    const [a, b] = m.k.split("|"), first = (m.wins[a] || 0) >= (m.wins[b] || 0) ? a : b, second = first === a ? b : a;
    t.match(tiles, new RegExp(title + " " + esc(nameOf[champ]) + " " + pct(side === "ups" ? teams6[champ].currentTitleOdds : D[champ][ck]) + " most likely"), title + " champion");
    t.match(tiles, new RegExp("Most likely runner-up: " + esc(nameOf[runner]) + " " + pct(D[runner][rk])), title + " runner-up = the highest runner-up odds");
    t.match(tiles, new RegExp("Most likely final: " + esc(nameOf[first]) + " v " + esc(nameOf[second]) + " " + pct(m.p) + " of simulated seasons; " + esc(nameOf[first]) + " wins it " + pct(m.wins[first] / m.p)), title + " final = a counted pairing");
  }
  // Week 6's real numbers: the most likely UPS runner-up is the most likely champion too, so the two best single odds
  // (C-Town and Pure Greatness) are NOT what the page calls the final; the counted C-Town v Pure Greatness pairing is.
  t.equal(nameOf[Object.keys(D).sort((a, b) => D[b].runnerUpOdds - D[a].runnerUpOdds)[0]], "C-Town Chivalry");
  t.match(tiles, /Most likely final: Pure Greatness v C-Town Chivalry 26%/);
  t.ok(!/Projected final:|Finalist:/.test(tiles), "no final built from single-team odds");
  // freshness: through which week, when it ran, which forecast the movement compares with
  t.match(text(h), /Forecast through Week 6 Generated Oct 21, 10:06 AM ET · 10,000 simulated seasons Movement vs the Week 5 forecast \(generated Oct 1\d, [^)]+ ET\)/);
  t.ok(h.indexOf("fc-fresh") < h.indexOf("fc-tiles"), "freshness above the summary");
  const fin = text((await page("view=forecast&year=2026&fc=finals")).h);
  for (const [side, title] of [["ups", "Most likely UPS finals"], ["hawk", "Most likely Hawk Tuah finals"]]) {
    const rows = matchups(side).slice(0, 5).map((m) => {
      const [a, b] = m.k.split("|"), first = (m.wins[a] || 0) >= (m.wins[b] || 0) ? a : b, second = first === a ? b : a;
      return esc(nameOf[first]) + " v " + esc(nameOf[second]) + " " + esc(nameOf[first]) + " wins " + pct(m.wins[first] / m.p) + " " + pct(m.p);
    });
    t.match(fin, new RegExp(title + " Final Odds " + rows.join(" ")), title + ": the five most common pairings");
  }
  t.match(fin, /A matchup’s odds count both teams meeting in the final, either way\./);
  const mv = text((await page("view=forecast&year=2026&fc=movement")).h);
  t.match(mv, /The Week 5 forecast didn’t record finish places, runners-up or the Hawk Tuah Bowl, so those have no movement yet\./);
  t.match(mv, /Forecast through Week 6/, "freshness on every Forecast view");
});
const NO_PAIRS = JSON.parse(JSON.stringify(DET6)); delete NO_PAIRS.standingsForecast.finalPairs;
test("a forecast without pair counts names no final matchup; pairs that don't add up are never used", async () => {
  let { h } = await page("view=forecast&year=2026", { ...PUBLISHED, "standings_forecast_2026_wk06.json": NO_PAIRS });
  let tiles = text(/<div class="fc-tiles">([\s\S]*?)<h3 class="sec-h">/.exec(h)[1]);
  t.ok(!/Most likely final:/.test(tiles));
  t.match(tiles, /Final matchup odds weren’t recorded for this forecast\./);
  const bad = JSON.parse(JSON.stringify(DET6)); bad.standingsForecast.finalPairs.ups[0][2] += 0.2;
  ({ h } = await page("view=forecast&year=2026", { ...PUBLISHED, "standings_forecast_2026_wk06.json": bad }));
  tiles = text(/<div class="fc-tiles">([\s\S]*?)<h3 class="sec-h">/.exec(h)[1]);
  t.ok(/UPS Championship[\s\S]*Final matchup odds weren’t recorded/.test(tiles) && /Most likely final: Cleon/.test(tiles), "UPS pairs refused, Hawk Tuah pairs still shown");
});
test("Every place: 12 × 12 cells from the place counts; Finals: UPS and Hawk Tuah champion / runner-up / final", async () => {
  const { h } = await page("view=forecast&year=2026&fc=places");
  const rows = [...h.matchAll(/<div class="fp-row" role="row"><span class="fp-name" role="rowheader">([^<]*)<\/span>([\s\S]*?)<\/div>/g)];
  t.equal(rows.length, 12);
  for (const [, name, cells] of rows) {
    const f = Object.keys(nameOf).find((k) => nameOf[k] === name);
    const shown = [...cells.matchAll(/aria-label="([^"]*)"/g)].map((m) => m[1]);
    t.deepEqual(shown, D[f].place.map((p, i) => (i < 6 ? "Seed " + (i + 1) : "H" + (i - 5)) + ": " + pct(p)), name);
  }
  const fin = (await page("view=forecast&year=2026&fc=finals")).h;
  const hawkPanel = /<h3>Hawk Tuah Bowl<\/h3>([\s\S]*?)<\/section>/.exec(fin)[1];
  const top = Object.keys(D).sort((a, b) => D[b].hawkTitleOdds - D[a].hawkTitleOdds || D[b].hawkRunnerUpOdds - D[a].hawkRunnerUpOdds || a.localeCompare(b))[0];
  const first = [...hawkPanel.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].slice(0, 4).map((c) => text(c[1]).trim());
  t.deepEqual(first, [nameOf[top], pct(D[top].hawkTitleOdds), pct(D[top].hawkRunnerUpOdds), pct(D[top].hawkTitleOdds + D[top].hawkRunnerUpOdds)]);
});

// ═══ the certainty rule (Keith 2026-11-24): 100% / 0% only for an outcome the clinch rules verify ═══
const flags = (byFid) => (res) => {
  if (!res) return res;
  const out = { ...res, byFid: { ...res.byFid } };
  for (const [fid, v] of Object.entries(byFid)) {
    const d = { x: false, y: false, z: false, e: false, lock: null, divOut: false, byeOut: false, ...v };
    if (d.lock) d.x = true;
    d.label = d.lock ? String(d.lock) : d.z ? "Z" : d.y ? "Y" : d.x ? "X" : d.e ? "E" : null;
    out.byFid[fid] = d;
  }
  return out;
};
const ids = SIM6.teams.map((x) => x.franchiseId);
const [A, B, C, Dd, E, G, H] = ids;
// the simulation answers certainty for A (1.000 everywhere) and B (0.000 everywhere); nothing is verified
const EXTREME = JSON.parse(JSON.stringify(SIM6));
for (const x of EXTREME.teams) {
  if (x.franchiseId === A) Object.assign(x, { currentPlayoffOdds: 1, currentByeOdds: 1, currentDivisionOdds: 1 });
  if (x.franchiseId === B) Object.assign(x, { currentPlayoffOdds: 0, currentByeOdds: 0, currentDivisionOdds: 0, currentTitleOdds: 0 });
  if (x.franchiseId === G) Object.assign(x, { currentPlayoffOdds: 0.9949, currentByeOdds: 0.0099, currentDivisionOdds: 0.005 });
  if (x.franchiseId === H) Object.assign(x, { currentPlayoffOdds: 0.99, currentByeOdds: 0.01, currentDivisionOdds: 0.9901 });
}
const EXTREME_FILES = { ...PUBLISHED, "season_sim_2026_live_wk06.json": EXTREME };
const outlookCells = (h, fid) => {
  const m = new RegExp('<tr[^>]*data-fid="' + fid + '"[^>]*>([\\s\\S]*?)</tr>').exec(h);
  return [...m[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) => tx(c[1]));
};
// text that only strips real tags: the Forecast tab writes "<1%" as is (a browser shows it as text), which text() would eat
const tx = (html) => plain(html.replace(/<\/?[a-z][^>]*>/gi, " ")).replace(/\s+/g, " ").trim();
// Outlook columns without place counts: Proj, Team, Playoffs, Bye, Div, Title, Δ (EXTREME's odds don't match the Week 6
// place-count file, so its place counts are refused and the Outlook falls back to these columns)
const OUT = (h, fid) => { const c = outlookCells(h, fid); return { po: c[2], bye: c[3], div: c[4], title: c[5] }; };
const CERTAIN = /(^|[^\d.>])(100|0)%/;
test("a simulated 1.000 or 0.000 is >99% / <1% until the clinch rules verify it, in every outcome; rounding boundaries hold", async () => {
  const { h } = await page("view=forecast&year=2026", EXTREME_FILES);
  t.deepEqual(OUT(h, A), { po: ">99%", bye: ">99%", div: ">99%", title: pct(teams6[A].currentTitleOdds) }, "unclinched team whose simulation returns 100%");
  t.deepEqual(OUT(h, B), { po: "<1%", bye: "<1%", div: "<1%", title: "<1%" }, "non-eliminated team whose simulation returns 0%");
  t.deepEqual(OUT(h, G), { po: ">99%", bye: "<1%", div: "<1%", title: pct(teams6[G].currentTitleOdds) }, "0.9949 → >99%, 0.0099 → <1%, 0.005 → <1%");
  t.deepEqual(OUT(h, H), { po: "99%", bye: "1%", div: ">99%", title: pct(teams6[H].currentTitleOdds) }, "exactly 0.99 → 99%, exactly 0.01 → 1%, 0.9901 → >99%");
  const body = tx(h.slice(h.indexOf('<div class="fc-tiles">')));
  t.ok(!CERTAIN.test(body), "no 100% or 0% anywhere on the Forecast tab");
  const L = (await page("view=league&year=2026", EXTREME_FILES)).h;
  const cellsPo = [...L.matchAll(/<td[^>]*>((?:<span class="po-badge[^>]*>[^<]*<\/span>)?[^<]*(?:<span class="owner-sub po-sub">[^<]*<\/span>)?)<\/td>/g)]
    .map((m) => tx(m[1])).filter((x) => /%|^[XYZE#]/.test(x));
  t.ok(cellsPo.length >= 12, "Playoff % cells found: " + cellsPo.length);
  t.ok(cellsPo.every((x) => !CERTAIN.test(x)), "nor in Full League's Playoff %: " + cellsPo.join(" | "));
});
test("verified outcomes show 100% / 0%, and playoffs, division and bye are each verified on their own", async () => {
  const cl = flags({ [A]: { x: true }, [B]: { e: true }, [C]: { x: true, y: true }, [Dd]: { lock: 1, z: true, y: true }, [E]: { divOut: true }, [G]: { byeOut: true } });
  const { h } = await page("view=forecast&year=2026", EXTREME_FILES, { clinch: cl });
  t.deepEqual(OUT(h, A), { po: "100%", bye: ">99%", div: ">99%", title: pct(teams6[A].currentTitleOdds) }, "a playoff clinch alone: the bye and division stay unverified");
  t.deepEqual(OUT(h, B), { po: "0%", bye: "0%", div: "0%", title: "<1%" }, "eliminated: every path closed; the title has no verdict of its own and the simulation's 0 is still <1%");
  const c = OUT(h, C);
  t.equal(c.po, "100%"); t.equal(c.div, "100%"); t.equal(c.bye, pct(teams6[C].currentByeOdds), "a division title is not a bye");
  const d = OUT(h, Dd);
  t.equal(d.po, "100%"); t.equal(d.div, "100%"); t.equal(d.bye, "100%");
  const e = OUT(h, E);
  t.equal(e.div, "0%"); t.equal(e.bye, "0%", "no division, no bye");
  t.equal(e.po, pct(teams6[E].currentPlayoffOdds), "out of the division race but alive for a wild card: its playoff % is never 0% from that");
  const g = OUT(h, G);
  t.equal(g.bye, "0%"); t.equal(g.po, ">99%"); t.equal(g.div, "<1%");
  const mv = (await page("view=forecast&year=2026&fc=movement", EXTREME_FILES, { clinch: cl })).h;
  t.match(tx(mv), new RegExp(nameOf[B].replace(/[$]/g, "\\$") + " 0% "), "Movement uses the same verdicts");
});
test("verdicts from newer standings are never laid over an older forecast", async () => {
  const cl = flags({ [A]: { x: true }, [B]: { e: true } });
  const { h } = await page("view=forecast&year=2026", { "season_sim_2026_live_wk05.json": SIM5 }, { clinch: cl });
  t.match(text(h), /This is the Week 5 forecast; Week 6 is final\./);
  const five = Object.fromEntries(SIM5.teams.map((x) => [x.franchiseId, x]));
  t.equal(OUT(h, A).po, pct(five[A].currentPlayoffOdds), "the Week 5 forecast's own number, not a Week 6 verdict");
  t.ok(!CERTAIN.test(tx(h.slice(h.indexOf("Projected final standings")))), "no 100% or 0% on a stale forecast");
});
test("Every place: cells follow the shared policy (no 100 or 0; <1 and >99 at the ends), labels and legend agree", async () => {
  const { h } = await page("view=forecast&year=2026&fc=places");
  // each cell: its spoken label's percentage and its shown text (split on the cell tag: labels may hold "<" or ">")
  const full = h.split('<span class="fp-cell').slice(1).map((piece) => {
    const a = piece.indexOf('aria-label="') + 12, label = piece.slice(a, piece.indexOf('"', a)).split(": ")[1];
    const seg = piece.slice(0, piece.indexOf("</span>")), shown = seg.slice(seg.lastIndexOf(">") + 1);
    return [label, plain(shown)];
  });
  t.equal(full.length, 144);
  const cells = full.map((x) => x[1]);
  t.ok(cells.every((x) => /^(<1|>99|[1-9]\d?)$/.test(x)), "cells: " + [...new Set(cells)].join(" "));
  t.ok(cells.includes("<1"), "the grid has cells under 1%");
  const off = full.filter(([label, shown]) => shown + "%" !== label);
  t.equal(off.length, 0, "every cell's text is its label's percentage without the % sign: " + JSON.stringify(off.slice(0, 5)));
  t.match(tx(h), /<1 = under 1%, including never in the simulation; >99 = over 99%/);
});
test("the About text states the simulation's actual seeding rules", async () => {
  const { h } = await page("view=forecast&year=2026");
  t.match(text(h), /Division winners by MFL’s division tiebreaks \(win %, division win %, head-to-head, points, All-Play %\)\. The two best division winners by All-Play % get the byes; the two wild cards and seeds 3–6 go by All-Play %, then overall record, then Points For\./);
});

// ═══ before the Week 6 Wire forecast is published (#1367 not merged) ═══
test("no Week 6 Wire file yet: the Week 5 forecast, labeled stale; its pre-correction scores are listed, not hidden; no place counts", async () => {
  const { h } = await page("view=forecast&year=2026", { "season_sim_2026_live_wk05.json": SIM5, "season_sim_2026_live_wk02.json": json("../site/wire/data/season_sim_2026_live_wk02.json") });
  t.match(text(h), /This is the Week 5 forecast; Week 6 is final\./);
  t.match(text(h), /Finish places, runners-up and the Hawk Tuah Bowl aren’t available for this forecast/);
  t.match(text(h), /Δ = playoff odds since the Week 2 forecast\./, "movement against the newest earlier file");
  // the Week 5 Wire run predates Week 5's stat corrections: name each changed score, and only because no result changed
  const ws = RESP6.weeklyScores.filter((s) => s.w === 5 && s.po === 0);
  const changed = SIM5.teams.filter((x) => Math.abs(ws.find((s) => s.fid === x.franchiseId).ts - x.weekScore) > 0.051);
  t.ok(changed.length > 0, "the fixture carries the real correction");
  for (const x of changed) t.ok(text(h).includes(nameOf[x.franchiseId] + " Week 5: " + x.weekScore.toFixed(1) + " → " + ws.find((s) => s.fid === x.franchiseId).ts.toFixed(1)), nameOf[x.franchiseId]);
  t.match(text(h), /no win, loss or All-Play result changed/);
});

// ═══ fails closed ═══
test("refuses a forecast simulated under the earlier seeding rules: the Week 6 file as published (no model.seedingRule)", async () => {
  t.equal((SIM6_AS_PUBLISHED.model || {}).seedingRule, undefined, "the published file predates the correction");
  const { h } = await page("view=forecast&year=2026", { ...PUBLISHED, "season_sim_2026_live_wk06.json": SIM6_AS_PUBLISHED });
  t.match(text(h), /The Week 6 forecast was simulated under the earlier seeding rules, so it isn’t shown\. The next forecast uses the corrected rules\./);
  t.ok(!/fc-tiles|Projected final standings/.test(h), "no odds at all");
  const wrong = { ...SIM6, model: { ...SIM6.model, seedingRule: "AP > Overall > PF" } };
  t.match(text((await page("view=forecast&year=2026", { ...PUBLISHED, "season_sim_2026_live_wk06.json": wrong })).h), /earlier seeding rules/, "any other rule string is refused too");
  const html = fs.readFileSync(new URL("../site/standings/mfl_hpm_standings_v2.html", import.meta.url), "utf8");
  t.equal(html.match(/var SEEDING_RULE = "([^"]*)"/)[1], SEEDING_RULE, "the page and the simulator name the same rule");
});
test("refuses a forecast whose All-Play differs from the standings, or whose Week 6 scores flip an H2H result", async () => {
  const ap = JSON.parse(JSON.stringify(SIM6)); ap.teams[0].currentApWins += 1;
  let { h } = await page("view=forecast&year=2026", { ...PUBLISHED, "season_sim_2026_live_wk06.json": ap });
  t.match(text(h), /The Week 6 forecast doesn’t start from these standings, so it isn’t shown\./);
  t.ok(!/fc-tiles|Projected final standings/.test(h), "no odds at all");
  // swap the scores of one Week 6 H2H game in the forecast, All-Play totals untouched: only that game's result flips
  const g = RESP6.weekly.find((x) => x.w === 6 && x.po === 0 && x.ts !== x.os);
  const flip = JSON.parse(JSON.stringify(SIM6));
  const A = flip.teams.find((x) => x.franchiseId === g.fid), B = flip.teams.find((x) => x.franchiseId === g.opp);
  [A.weekScore, B.weekScore] = [B.weekScore, A.weekScore];
  ({ h } = await page("view=forecast&year=2026", { ...PUBLISHED, "season_sim_2026_live_wk06.json": flip }));
  t.match(text(h), /isn’t shown/);
  t.match(text(h), /the result differs/);
});
test("place counts from a different run of the Week 6 forecast are never used", async () => {
  const other = JSON.parse(JSON.stringify(DET6)); other.wire.generatedAtUtc = "2026-10-21T15:00:00Z";
  const { h } = await page("view=forecast&year=2026&fc=places", { ...PUBLISHED, "standings_forecast_2026_wk06.json": other });
  t.match(text(h), /because their file belongs to a different run of this forecast/);
  t.ok(!/fp-row/.test(h), "Every place falls back to the Outlook");
  t.match(h, /Projected final standings/);
});
test("a finished season has nothing to forecast", async () => {
  const fin = { ...RESP6, season_complete: true, standings_basis: "recorded_final_standings" };
  const fetch = async (url) => (new URL(url).pathname === "/api/standings" ? { ok: true, status: 200, json: async () => fin } : { ok: false, status: 404, json: async () => ({}) });
  const p = loadStandingsPage({ query: "view=forecast&year=2026", fetch });
  await settle();
  t.match(text(plain(p.html())), /The 2026 season is finished, so there’s nothing left to forecast\./);
});

await run("standings_forecast_desktop");
mfl.restore();
restore();
