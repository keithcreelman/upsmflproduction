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
const SIM6 = json("./fixtures/wire_season_sim_2026_live_wk06.json");
const SIM5 = json("../site/wire/data/season_sim_2026_live_wk05.json");
const DET6 = json("../site/wire/data/standings_forecast_2026_wk06.json");
const plain = (html) => html.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const text = (html) => plain(html.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");
const pct = (p) => (p >= 1 ? "100%" : p >= 0.995 ? ">99%" : p <= 0 ? "0%" : p < 0.005 ? "<1%" : Math.round(p * 100) + "%");

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
async function page(query, files = PUBLISHED) {
  const fetch = fetchWith(files);
  const p = loadStandingsPage({ query, fetch });
  await new Promise((r) => setTimeout(r, 2700));   // in-season magic numbers wait up to 2.5 s for MFL's schedule
  await settle();
  return { h: plain(p.html()), reads: fetch.reads };
}
const teams6 = Object.fromEntries(SIM6.teams.map((x) => [x.franchiseId, x]));
const prev5 = Object.fromEntries(SIM5.teams.map((x) => [x.franchiseId, x]));
const D = DET6.standingsForecast.teams;

// ═══ navigation ═══
test("tabs: Full League, Divisions, Playoff Picture, Forecast, Weekly, Trends, History — and Full League is the default", async () => {
  const { h } = await page("year=2026");
  const tabs = [...h.matchAll(/<button type="button" class="view-btn" role="tab" data-view="(\w+)" aria-selected="(true|false)"[^>]*>([^<]*)<\/button>/g)];
  t.deepEqual(tabs.map((m) => m[3]), ["Full League", "Divisions", "Playoff Picture", "Forecast", "Weekly", "Trends", "History"]);
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
