// Overview → Lineup strength (#1338): one table over the 12 teams' OWNED-roster lineups (Keith 2026-10-21: a
// replacement free agent fills a slot only when no available rostered player can play it) serves four views —
// above replacement vs the league median (default), PPG, Index (100 = league mean) and Rank — with Overall = all
// 18 required starting slots (weighted by points, never an average of rows) and K and P rows. The table reads the
// trade-fit model's own lineups (Keith 2026-10-21: the Trade finder uses the same calculation), so the Overview and
// the Trade finder show the same values; the old replacement-filled rule (lineupRule "replacement") is built only
// for the before/after comparison.
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
const model = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents });   // owned roster (default)
const oldModel = TF.buildLeague({ teams: FX.teams, values: FX.values, freeAgents: FX.freeAgents, lineupRule: "replacement" });
const table = LS.build(model);
const modelTable = LS.build(oldModel);                           // the old replacement-filled lineups (comparison)
const avail = (p) => TF.availableNow(p);
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
    t.ok(close(row.ALL.ppg, model.teams[fid].total), fid + ": Overall PPG = the owned lineup's total (the Trade finder's lineup)");
    t.ok(close(modelTable.teams[fid].ALL.ppg, oldModel.teams[fid].total), fid + ": the comparison population = the old replacement-filled lineup's total");
    t.ok(close(LS.POSITIONS.reduce((s, g) => s + row[g].ppg, 0), row.ALL.ppg), fid + ": position PPGs add up to Overall");
  }
});

test("one calculation: every position value equals the Trade finder's (trade_fit strength, vs-median and need)", () => {
  for (const [tb, m, who] of [[table, model, "owned"], [modelTable, oldModel, "old rule"]]) {
    for (const fid of tb.order) {
      for (const g of TF.GROUPS) {
        t.ok(close(tb.teams[fid][g].above, m.teams[fid].strength[g]), who + " " + fid + " " + g + " above replacement");
        t.equal(Math.round(tb.teams[fid][g].vsMedian * 10) / 10, m.teams[fid].vsMedian[g], who + " " + fid + " " + g + " vs median");
        t.equal(tb.teams[fid].need[g], m.teams[fid].need[g], who + " " + fid + " " + g + " need");
      }
    }
  }
  t.equal(table.population, "owned"); t.equal(modelTable.population, "replacement");
  for (const fid of table.order) {
    t.ok(close(table.teams[fid].ALL.above, LS.POSITIONS.reduce((s, g) => s + table.teams[fid][g].above, 0)), fid + ": Overall above replacement = sum of the rows");
  }
});

test("owned roster: a replacement fills a slot ONLY when no available rostered player could play it, and is listed", () => {
  const L = ctx.UPS_FRONT_OFFICE_LINEUP;
  let ownedRep = 0, modelRep = 0, displaced = 0;
  for (const fid of table.order) {
    const team = model.teams[fid].team;
    const lu = model.teams[fid].best;
    const startersIds = new Set(lu.starters.filter((s) => s.pid).map((s) => s.pid));
    const bench = team.players.filter((p) => avail(p) && L.posGroup(p.pos) !== "OTH" && !startersIds.has(p.pid));
    for (const s of lu.starters.filter((x) => x.rep)) {
      const accepts = L.LINEUP_SLOTS.find((x) => x.id === s.slot).accepts;
      t.ok(!bench.some((p) => accepts.includes(L.posGroup(p.pos))), fid + " " + s.slot + ": filled by a replacement only because no available rostered " + accepts.join("/") + " is left");
    }
    t.equal(table.teams[fid].replacementSlots.length, lu.starters.filter((x) => x.rep).length, fid + ": every replacement-filled slot is listed");
    const owned = new Set(team.players.filter((p) => avail(p)).map((p) => p.pid));
    t.ok(lu.starters.every((x) => x.rep || owned.has(x.pid)), fid + ": every starter is an available rostered player or a listed replacement");
    ownedRep += lu.starters.filter((x) => x.rep).length;
    modelRep += oldModel.teams[fid].best.starters.filter((x) => x.rep).length;
    // Under the old rule, count replacements that started although an available rostered player could have.
    const mIds = new Set(oldModel.teams[fid].best.starters.filter((s) => s.pid).map((s) => s.pid));
    const mBench = team.players.filter((p) => avail(p) && L.posGroup(p.pos) !== "OTH" && !mIds.has(p.pid));
    for (const s of oldModel.teams[fid].best.starters.filter((x) => x.rep)) {
      const accepts = L.LINEUP_SLOTS.find((x) => x.id === s.slot).accepts;
      if (mBench.some((p) => accepts.includes(L.posGroup(p.pos)))) displaced += 1;
    }
  }
  t.ok(ownedRep <= modelRep, "owned lineups use no more replacements than the model (" + ownedRep + " vs " + modelRep + ")");
  t.ok(displaced > 0, "the old rule really did start " + displaced + " replacements over available rostered players (what the ruling removes)");
  t.equal(ownedRep, 0, "this week every team fills all 18 slots from its own roster");
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

test("a slot the roster can't fill takes a replacement, and it is listed (team's only kicker ruled out)", () => {
  const teams = JSON.parse(JSON.stringify(FX.teams));
  const t8 = teams.find((t) => t.fid === "0008");
  const ks = t8.players.filter((p) => String(p.pos).toUpperCase() === "PK");
  t.ok(ks.length >= 1, "fixture team has a kicker");
  ks.forEach((p) => { p.chip = "OUT"; });
  const m2 = TF.buildLeague({ teams, values: FX.values, freeAgents: FX.freeAgents });
  const tb = LS.build(m2);
  const slots = tb.teams["0008"].replacementSlots;
  t.equal(JSON.stringify(slots.map((x) => x.slot)), JSON.stringify(["PK1"]), "only the K slot is filled by a replacement");
  t.equal(tb.teams["0008"].PK.replacementStarters, 1, "the K row carries it");
  t.equal(tb.teams["0008"].ALL.replacementStarters, 1, "and Overall");
  t.ok(close(tb.teams["0008"].PK.ppg, m2.repl.PK[0]), "at the replacement kicker's PPG (" + m2.repl.PK[0] + ")");
  t.equal(tb.teams["0008"].ALL.starters, 18, "still 18 starters");
});

await run("lineup_strength_views");
