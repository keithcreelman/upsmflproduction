// The desktop Trade War Room's own cap preview counts a player arriving from the other team's taxi
// squad at his FULL salary (he lands on the active roster), never $0.
//   node tests/trade_taxi_arrival_preview_client.test.mjs
//
// 2026-10-07, MFL #1249: Matthew Golden ($5,000, on Blake Bombers' taxi squad) was previewed at $0 for Gride
// and arrived on Gride's active roster. The sender still saves nothing — his salary was never on its cap.
// Runs the REAL helper functions, extracted by name from site/trades/trade_workbench.js.
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";

const SRC = fs.readFileSync(new URL("../site/trades/trade_workbench.js", import.meta.url), "utf8");
function fn(name) {
  const start = SRC.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in trade_workbench.js`);
  let i = SRC.indexOf("{", start), depth = 0;
  for (; i < SRC.length; i += 1) { if (SRC[i] === "{") depth += 1; else if (SRC[i] === "}" && --depth === 0) break; }
  return SRC.slice(start, i + 1);
}
const ctx = { Object, Math, String };
vm.createContext(ctx);
vm.runInContext([
  "function safeStr(v){ return String(v == null ? '' : v).trim(); }",
  "function safeInt(v, d){ var n = parseInt(v, 10); return isFinite(n) ? n : (d || 0); }",
  ...["assetHasActiveCurrentContract", "assetCountsAsCurrentIr", "getAssetCurrentCapHitDollars", "getAssetCapSalaryDollars", "arrivingAsActive", "getAssetArrivalCapSalaryDollars"].map(fn),
].join("\n"), ctx);

const golden = { type: "PLAYER", player_id: "17075", salary: 5000, years: 2, taxi: true };
const hampton = { type: "PLAYER", player_id: "17044", salary: 13000, years: 2, taxi: false };

test("a taxi player costs the SENDER nothing but the RECEIVER his full salary", () => {
  t.equal(ctx.getAssetCapSalaryDollars(golden), 0, "off the sender's cap (taxi) — unchanged");
  t.equal(ctx.getAssetArrivalCapSalaryDollars(golden), 5000, "on the receiver's cap: he arrives active");
  t.equal(golden.taxi, true, "the asset itself is not mutated");
});

test("an ordinary player costs the same on both sides", () => {
  t.equal(ctx.getAssetCapSalaryDollars(hampton), 13000);
  t.equal(ctx.getAssetArrivalCapSalaryDollars(hampton), 13000);
});

test("the reconciliation and the multi-year table use the ARRIVAL cost for incoming players", () => {
  const recon = fn("buildSalaryReconciliation");
  t.match(recon, /var leftIncoming = safeInt\(rightTotals\.selectedArrivalCapSalary, 0\);/);
  t.match(recon, /var rightIncoming = safeInt\(leftTotals\.selectedArrivalCapSalary, 0\);/);
  t.match(fn("getTeamTotals"), /out\.selectedArrivalCapSalary \+= getAssetArrivalCapSalaryDollars\(a\);/);
  t.match(fn("sumAssetListSeasonSalary"), /resolveAssetSeasonSalaryDollars\(toTeamId \? arrivingAsActive\(asset\) : asset,/);
});

test("the desktop page loads the changed script under a new stamp", () => {
  const html = fs.readFileSync(new URL("../site/trades/trade_workbench.html", import.meta.url), "utf8");
  t.match(html, /\.\/trade_workbench\.js\?v=2026100[7-9][a-z]|\.\/trade_workbench\.js\?v=202610[1-3]\d[a-z]/);
});

await run("trade_taxi_arrival_preview_client");
