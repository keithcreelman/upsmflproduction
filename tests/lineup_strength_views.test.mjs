// Overview → Lineup strength (#1338): one table from the trade-fit model's 12 best lineups serves four views —
// the original above-replacement-vs-median chart (unchanged), PPG, Index (100 = league average) and Rank — with
// Overall = all 18 required starting slots (weighted by points, never an average of rows) and K and P rows.
//   node tests/lineup_strength_views.test.mjs
//   LINEUP_STRENGTH_JS=<path> node tests/lineup_strength_views.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ctx = vm.createContext({}); ctx.window = ctx;
for (const f of ["site/m/front_office_lineup.js", "site/shared/trade_fit.js"]) vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx);
vm.runInContext(fs.readFileSync(process.env.LINEUP_STRENGTH_JS || path.join(ROOT, "site/shared/lineup_strength.js"), "utf8"), ctx);
const TF = ctx.UPS_TRADE_FIT, LS = ctx.UPS_LINEUP_STRENGTH, L = ctx.UPS_FRONT_OFFICE_LINEUP;
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/trade_fit_2026_wk6.json"), "utf8"));
const model = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents });
const table = LS.build(model);
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test("Overall is every required starting slot: 18 starters, its PPG = the whole best lineup", () => {
  t.equal(L.LINEUP_SLOTS.length, 18, "the league's 18 slots");
  t.equal(table.order.length, 12, "all 12 teams");
  for (const fid of table.order) {
    const row = table.teams[fid];
    t.equal(row.ALL.starters, 18, fid + ": 18 starters in Overall");
    const posStarters = LS.POSITIONS.reduce((s, g) => s + row[g].starters, 0);
    t.equal(posStarters, 18, fid + ": every starter sits in exactly one position row (Flex, SuperFlex, D-Flex by the player's position)");
    t.equal(row.PK.starters, 1, fid + ": one kicker"); t.equal(row.PN.starters, 1, fid + ": one punter");
    t.ok(close(row.ALL.ppg, model.teams[fid].total), fid + ": Overall PPG = the best lineup's total");
    t.ok(close(LS.POSITIONS.reduce((s, g) => s + row[g].ppg, 0), row.ALL.ppg), fid + ": position PPGs add up to Overall");
  }
});

test("the original chart is unchanged: above replacement and vs-median equal trade_fit's strength / vsMedian", () => {
  for (const fid of table.order) {
    for (const g of TF.GROUPS) {
      t.ok(close(table.teams[fid][g].above, model.teams[fid].strength[g]), fid + " " + g + " above replacement");
      t.equal(Math.round(table.teams[fid][g].vsMedian * 10) / 10, model.teams[fid].vsMedian[g], fid + " " + g + " vs median");
    }
    t.ok(close(table.teams[fid].ALL.above, TF.GROUPS.reduce((s, g) => s + model.teams[fid].strength[g], 0)), fid + ": Overall above replacement = sum of the rows");
  }
});

test("Index: 100 = the 12-team mean of the same row; Overall is weighted by points, not an average of indexes", () => {
  let differs = 0;
  for (const r of LS.ROWS) {
    const idx = table.order.map((fid) => table.teams[fid][r].index);
    t.ok(close(idx.reduce((a, b) => a + b, 0) / idx.length, 100, 1e-9), r + ": the mean index is exactly 100");
  }
  for (const fid of table.order) {
    const row = table.teams[fid];
    t.ok(close(row.ALL.index, row.ALL.ppg / LS.mean(table.order.map((f) => table.teams[f].ALL.ppg)) * 100), fid + ": Overall index from Overall PPG");
    const avgOfRows = LS.POSITIONS.reduce((s, g) => s + row[g].index, 0) / LS.POSITIONS.length;
    if (Math.abs(avgOfRows - row.ALL.index) > 1) differs += 1;
  }
  t.ok(differs > 0, differs + " of 12 teams: a plain average of the position indexes would have given a different Overall");
});

test("Rank: 1st–12th by the same PPG; every view reads one population", () => {
  for (const r of LS.ROWS) {
    const sorted = table.order.slice().sort((a, b) => table.teams[b][r].ppg - table.teams[a][r].ppg);
    t.equal(table.teams[sorted[0]][r].rank, 1, r + ": best PPG is 1st");
    for (let i = 1; i < sorted.length; i++) {
      const a = table.teams[sorted[i - 1]][r], b = table.teams[sorted[i]][r];
      t.ok(b.rank >= a.rank && (b.ppg < a.ppg - 1e-9 ? b.rank === i + 1 : b.rank === a.rank), r + ": rank follows PPG (ties share)");
    }
    for (const fid of table.order) {
      for (const v of LS.VIEWS) {
        const c = LS.cell(table, fid, r, v);
        t.ok(c && c.frac >= -1 && c.frac <= 1 && c.text.length > 0, fid + " " + r + " " + v + " renders");
      }
    }
  }
  t.equal(LS.ordinal(1) + LS.ordinal(2) + LS.ordinal(3) + LS.ordinal(11) + LS.ordinal(12), "1st2nd3rd11th12th");
});

await run("lineup_strength_views");
