// Front Office → Trade finder (#1338): discovery only — every swap link is the ONE War Room route with the swap in the
// hash (the War Room's own preload keys), nothing is sent, the framing says it isn't a fairness grade, and the
// current season is never used before MFL has scored a week. Its matrix is the Overview's Lineup strength on the same
// owned-roster lineups (Keith 2026-10-21): identical values, replacement-filled slots marked *.
//   node tests/front_office_trade_finder.test.mjs
//   FO_TRADES_JS=<path> node tests/front_office_trade_finder.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(process.env.FO_TRADES_JS || path.join(ROOT, "site/rosters/v2/fo_trades.js"), "utf8");

test("every swap opens the one War Room route with give/get preloaded; partner links preload the partner", () => {
  t.ok(/FO\.warRoomUrl\(\{ twb_left_team: me, twb_right_team: f, twb_give: x\.give, twb_get: x\.get \}\)/.test(SRC), "swap → War Room with twb_give / twb_get");
  t.ok(/FO\.warRoomUrl\(\{ twb_left_team: me, twb_right_team: f \}\)/.test(SRC), "partner → War Room with the partner");
  t.ok(!/window\.open\(|location\.href\s*=/.test(SRC), "plain links (target=_top), no scripted navigation");
});

test("discovery, not a verdict: framing, checks and what isn't scored are on screen", () => {
  t.ok(/Discovery, not a fairness grade/.test(SRC));
  t.ok(/improve <b>both<\/b> teams’ best legal lineups/.test(SRC) || /both best legal lineups gain/.test(SRC), "both lineups must gain");
  for (const flag of ["over the cap", "not on last 4 wks", "IDP only", "small sample"]) t.ok(SRC.includes(flag), "check shown: " + flag);
  t.ok(/Not scored: contract length, salary value, age, draft picks, dynasty value/.test(SRC), "what the model ignores is said");
});

test("never sends anything; never uses this season before MFL has scored a week", () => {
  t.ok(!/fetch\(|method:\s*"POST"|XMLHttpRequest/.test(SRC), "no network write path in the view");
  t.ok(/if \(!ss\.seasonWeeks\.length\) \{ el\.innerHTML = H\.banner\("The Trade finder starts once MFL has scored a week this season\./.test(SRC), "preseason: says it starts after Week 1");
});

test("the need marker is a team's top two needs, not every position an upgrade would touch", () => {
  t.ok(/TF\.teamSummary\(m, f\)\.needs\.slice\(0, 2\)/.test(SRC));
  t.ok(/topNeeds\.indexOf\(g\) !== -1/.test(SRC));
});

// Render the real view on the 2026 Week-6 league (MFL's own data) with a minimal hub, and read the matrix back.
function renderMatrix(teams) {
  const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/trade_fit_2026_wk6.json"), "utf8"));
  const listeners = {};
  const el = { innerHTML: "", addEventListener() {} };
  const ctx = vm.createContext({ document: { addEventListener(n, f) { (listeners[n] = listeners[n] || []).push(f); },
    getElementById: (id) => (id === "fo-trades-body" ? el : null), querySelector: () => null } });
  ctx.window = ctx;
  for (const f of ["site/m/front_office_lineup.js", "site/shared/trade_fit.js", "site/shared/lineup_strength.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
  const TF = ctx.UPS_TRADE_FIT, LS = ctx.UPS_LINEUP_STRENGTH;
  const T = teams || FX.teams;
  const model = TF.buildLeague({ teams: T, values: FX.values, freeAgents: FX.freeAgents });
  const esc = (x) => String(x == null ? "" : x).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const fmt1 = (v) => (Math.round(Number(v) * 10) / 10).toFixed(1);
  ctx.UPS_FO_HUB = { registerView() {}, registerAbout() {}, wireClicks() {}, loading() {}, banner: (m) => m, setFreshness() {}, clock: () => "",
    scoring: () => ({ seasonWeeks: [1, 2, 3, 4, 5, 6], finalKnown: false, fetchedAt: 1, rankMinimum: () => 3 }),
    leagueModel: (n) => (n ? null : model), lineupSlotsState: () => "ok", asArray: (x) => (x == null ? [] : Array.isArray(x) ? x : [x]), pad4: (x) => String(x).padStart(4, "0"),
    esc, fmt1, signed1: (v) => { const n = Math.round(Number(v) * 10) / 10; return (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n).toFixed(1); },
    money: (v) => "$" + v, teamName: (f) => (T.find((t) => t.fid === f) || {}).name || f, rosterIndex: () => ({}), seasonLine: () => null,
    playerButton: (pid, fid, label) => esc(label), injuryChip: () => "" };
  ctx.UPS_FO = { viewerFid: () => "0008", selectedTeam: () => "", teams: () => T, capFor: (f) => ({ capSpace: FX.capRoom[f] }), warRoomUrl: () => "#war-room" };
  ctx.UPS_FO_DATA = { get: (k) => (k === "scores" || k === "players" ? { state: "ok" } : null), load: () => ({ then() {} }) };
  vm.runInContext(SRC, ctx);
  (listeners["fo:ready"] || []).forEach((f) => f());
  (listeners["fo:tab"] || []).forEach((f) => f({ detail: { section: "trades" } }));
  const html = el.innerHTML;
  const matrix = html.slice(html.indexOf("fo-tf-matrix"), html.indexOf("</table>", html.indexOf("fo-tf-matrix")));
  const cells = {};
  for (const tr of matrix.split("<tr").slice(2)) {
    const m = tr.match(/data-tf-partner="(\d{4})"/); const fid = m ? m[1] : "0008";
    cells[fid] = {};
    for (const c of tr.matchAll(/data-tf-row="(\w+)"[^>]*>([\s\S]*?)<\/td>/g)) {
      cells[fid][c[1]] = { text: c[2].replace(/<span[\s\S]*?<\/span>/g, "").trim(), star: /fo-ov-rep/.test(c[2]) };
    }
  }
  return { cells, table: LS.build(model), LS, model, html };
}

test("the matrix shows exactly the Overview's Lineup strength (Above repl.) for all 12 teams, Overall + every position", () => {
  const { cells, table, LS } = renderMatrix();
  const rows = ["ALL", "QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"];
  t.equal(Object.keys(cells).length, 12, "12 teams in the matrix");
  let n = 0;
  for (const fid of table.order) {
    for (const r of rows) {
      t.equal(cells[fid][r].text, LS.cell(table, fid, r, "above").text, fid + " " + r);
      t.equal(cells[fid][r].star, table.teams[fid][r].replacementStarters > 0, fid + " " + r + " * only for a replacement-filled slot");
      n += 1;
    }
  }
  t.equal(n, 120, "120 cells compared");
});

test("a slot the roster can't fill is marked * in the matrix (0008's only kicker ruled out)", () => {
  const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/trade_fit_2026_wk6.json"), "utf8"));
  const teams = JSON.parse(JSON.stringify(FX.teams));
  teams.find((x) => x.fid === "0008").players.filter((p) => String(p.pos).toUpperCase() === "PK").forEach((p) => { p.chip = "OUT"; });
  const { cells, table } = renderMatrix(teams);
  t.equal(cells["0008"].PK.star, true, "K cell marked *");
  t.equal(cells["0008"].ALL.star, true, "Overall marked * (it includes the K slot)");
  t.equal(cells["0008"].RB.star, false, "RB not marked: 0008's own backs fill both RB slots");
  t.equal(table.teams["0008"].replacementSlots.length, 1, "exactly one replacement-filled slot");
});

test("swap gains carry * and the slot when the swap would leave a slot to a free agent", () => {
  t.ok(/repMark\(x\.repA\.length/.test(SRC) && /repMark\(x\.repB\.length/.test(SRC), "both gains can be marked");
  t.ok(/would need a replacement free agent at/.test(SRC), "the hover names the slot");
  t.ok(/A free agent never starts because he outscores someone on the roster/.test(SRC), "About states the owned-roster rule");
});

await run("front_office_trade_finder");
