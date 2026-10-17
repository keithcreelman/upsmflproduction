// The phone team sheet (site/m/team_sheet.js) rendered for real: the REAL /api/standings route on the recorded
// 2026 season after Week 5 → the REAL site/shared/standings_race.js → the sheet. Checks the numbers an owner reads
// and that points faced are presented as schedule, never as "defense" (in UPS, MFL's Defense = IDP points).
//   node scripts/safe_tests/run.mjs --only standings_mobile_team_sheet
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { loadSeason, recorded2026 } from "./fixtures/standings_d1.mjs";

const restore = quiet();
const mfl = makeMfl();
mfl.install();
const REC = JSON.parse(fs.readFileSync(new URL("./fixtures/standings_2026_wk5.json", import.meta.url), "utf8"));
mfl.st.league = { standingsSort: REC.standingsSort };
const RACE_SRC = fs.readFileSync(new URL("../site/shared/standings_race.js", import.meta.url), "utf8");
const SHEET_SRC = fs.readFileSync(new URL("../site/m/team_sheet.js", import.meta.url), "utf8");
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ");

async function openSheet(fid) {
  const resp = (await callWorker(loadSeason(makeWorkerEnv({}), recorded2026(REC)), "GET", "/api/standings?year=2026")).json;
  const w = {}; new Function("window", RACE_SRC)(w); const R = w.UPS_STANDINGS_RACE;
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: "", firstChild: null, classList: { add() {}, remove() {}, contains: () => false }, addEventListener() {}, focus() {} });
  const mount = el("ups-m-team-sheet-mount");
  Object.defineProperty(mount, "innerHTML", { set(v) { this._h = v; this.firstChild = v ? {} : null; }, get() { return this._h || ""; } });
  const document = { getElementById: (id) => el(id), addEventListener() {}, body: { style: {} }, activeElement: null };
  const U = {
    escapeHtml: (v) => String(v == null ? "" : v).trim().replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;"),
  };
  const M = { util: U, route: { navigate() {} } };
  const ctx = { window: { UPS_MOBILE: M }, document, console };
  vm.createContext(ctx);
  vm.runInContext(SHEET_SRC, ctx);
  const sf = R.scoredFaced(resp), hist = R.teamWeeklyHistory(resp, fid), race = R.race(resp);
  t.equal(sf.status, "ok"); t.equal(hist.status, "ok");
  M.teamSheet.open(fid, {
    row: resp.rows.find((r) => r.franchise_id === fid), raceRow: race.byFranchise[fid],
    scoredFaced: sf.byFranchise[fid], scoredFacedStatus: sf.status, history: hist, year: 2026, seasonState: "in_season",
  });
  return { body: plain(els["ups-m-team-sheet-body"].innerHTML), head: plain(els["ups-m-team-sheet-head"].innerHTML) };
}

test("Real Deal Creel's sheet: seed sentence, Scored, Faced (schedule, not skill), luck and week by week", async () => {
  const { body, head } = await openSheet("0008");
  t.match(head, /Real Deal Creel/);
  t.match(body, /Seed 4: behind HammerTime.* on All-Play %\. Ahead of CBP on Overall record \(same All-Play %\)\./);
  t.match(body, /Record 9-4 \(\.692\)/);
  t.match(body, /All-Play 32-23 \(\.582\)/);
  t.match(body, /Points For 1145\.8 5th/);                 // 5th of 12: C-Town, Blake, HammerTime, Pure Greatness ahead
  t.match(body, /Per week 229\.2/);
  t.match(body, /Faced · schedule, not skill/);
  t.match(body, /Opponents per game 211\.1 11th most/);
  t.match(body, /Schedule luck \+1\.2 wins/);
  t.match(body, /expected wins \(7\.8/);
  t.match(body, /5 272\.5 2 10-1 WWW 4/, "Week 5 row: score, rank, weekly All-Play, results, seed after the week");
  t.ok(!/defen[cs]e/i.test(body), "points faced are never called defense");
});

test("an outside team: the seed row in Week by week shows its place in parentheses, not a seed", async () => {
  const { body } = await openSheet("0012");   // Hawks: 7th after Week 5
  t.match(body, /Outside the top six — 2 AP wins back; behind Pure Greatness \(the last wild card\) on All-Play %\./);
  t.match(body, /5 200\.3 8 4-7 \S+ \(7\)/);
});

await run("standings_mobile_team_sheet");
mfl.restore();
restore();
