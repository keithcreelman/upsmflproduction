// Stats → Pts Agst default window comes from the LOCKED walk-forward backtest, not from opinion.
//   pipelines/analysis/pts_agst_window/locked/
//     selection.json            2019–2024 choice (frozen before 2025 was scored)
//     results_2025.json          the locked 2025 holdout, scored against that frozen choice
//     final_defaults.json        statistical defaults after the holdout check
//     pts_agst_default_window.json  the product rule applied (make_product.py)
// This test (1) proves the locked files weren't edited after the fact (hashes chain together),
// (2) re-derives the product defaults in JS from the locked numbers, (3) requires the mobile
// app's FPA_DEFAULT_WINDOW and color shrink FPA_COLOR_K to be exactly that, and (4) re-derives
// from the matchup follow-up (matchup_results.json) that a defense's record adds nothing material
// to the offense's own average at any position, which is why Pts Agst has no prediction field.
//   node tests/pts_agst_default_window.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import crypto from "node:crypto";
import assert from "node:assert";
const root = new URL("..", import.meta.url).pathname;
const L = root + "pipelines/analysis/pts_agst_window/locked/";
const raw = (f) => fs.readFileSync(L + f);
const J = (f) => JSON.parse(raw(f).toString("utf8"));
const sha = (f) => crypto.createHash("sha256").update(raw(f)).digest("hex");
const sel = J("selection.json"), fin = J("final_defaults.json"), r24 = J("results_2019_2024.json"), r25 = J("results_2025.json"), prod = J("pts_agst_default_window.json");
const GROUPS = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"];
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

console.log("1. the locked files chain together (nothing edited after the holdout)");
check("selection.json is the exact file the 2025 holdout was scored against", () => {
  assert.strictEqual(sha("selection.json"), "af5a2637709829b4f5aff1ff8328367c4d09417ba6b12b42235ac7226bbc9cc9");
  assert.strictEqual(r25.frozen_selection_sha256, sha("selection.json"));
  assert.strictEqual(fin.selection_sha256, sha("selection.json"));
  assert.strictEqual(prod.selection_sha256, sha("selection.json"));
});
check("final_defaults.json is the exact file the product rule read", () => {
  assert.strictEqual(prod.final_defaults_sha256, sha("final_defaults.json"));
});
check("the selection was made on 2019–2024 only (no 2025 number inside it)", () => {
  assert.deepStrictEqual(sel.train, [2019, 2020, 2021, 2022, 2023, 2024]);
  assert.ok(!/"2025"/.test(raw("selection.json").toString()), "selection.json mentions 2025");
});

console.log("\n2. the product rule, re-derived here from the locked numbers");
const MATERIAL = prod.material_gain;
check("material gain threshold is 2 points of rank accuracy", () => assert.strictEqual(MATERIAL, 0.02));
for (const g of GROUPS) {
  check(`${g}: default and evidence follow from the locked results`, () => {
    const s = sel.positions[g], d = r25.positions[g].decision, p = prod.positions[g];
    const tr = s.winner_vs_full_season, ho = d.winner_vs_full_2025;
    const material = s.winner_by_rank_acc !== "Season to date" && tr.diff >= MATERIAL && tr.ci95[0] > 0 && ho.diff >= MATERIAL && ho.ci95[0] > 0;
    const def = material ? s.winner_by_rank_acc : "Season to date";
    assert.strictEqual(p.product_default, def === "Season to date" ? "full" : def);
    assert.strictEqual(p.material, material);
    assert.strictEqual(p.statistical_default, fin.positions[g].default);
    const ci24 = (def === "Season to date" ? s.full_season_vs_coinflip : s.winner_vs_coinflip).ci95;
    const ci25 = fin.positions[g].default === def ? d.default_vs_coinflip_2025.ci95 : null;
    assert.strictEqual(p.signal, !!(ci24[0] > 0 && ci25 && ci25[0] > 0));
    const a24 = r24.positions[g].adj[def], a25 = r25.positions[g].adj[def];
    assert.strictEqual(p.pct, Math.round(100 * (a24.rank_acc * a24.pairs + a25.rank_acc * a25.pairs) / (a24.pairs + a25.pairs)));
    assert.strictEqual(p.k, p.signal ? r24.positions[g].adj["Season to date"].shrunk_loso.k_all_train : null);
  });
}

console.log("\n3. the mobile app ships exactly that");
const ctx = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, Date, Math, JSON });
ctx.window = ctx; ctx.document = { getElementById: () => null, addEventListener() {}, querySelector: () => null };
ctx.UPS_MOBILE = { util: { safeStr: (v) => (v == null ? "" : String(v)), escapeHtml: (v) => String(v) }, api: { workerUrl: (p) => p }, data: {}, state: {}, route: { registerView() {}, renderRoute() {} } };
vm.runInContext(fs.readFileSync(root + "site/m/views/stats.js", "utf8"), ctx);
const shipped = ctx.UPS_MOBILE.statsView.ptsAgstDefaults;
const M = JSON.parse(fs.readFileSync(root + "pipelines/analysis/pts_agst_window/matchup_results.json", "utf8"));
for (const g of GROUPS) {
  check(`${g}: FPA_DEFAULT_WINDOW = the locked product file; FPA_COLOR_K = the player-level Full-season k in both tests`, () => {
    const p = prod.positions[g];
    assert.strictEqual(shipped.window[g], p.product_default);
    const k24 = r24.positions[g].adj["Season to date"].shrunk_loso.k_all_train;
    assert.strictEqual(M.positions[g].k_defense_all_train["Combined player-level|Full season"], k24);
    assert.strictEqual(shipped.colorK[g], k24);
  });
}

console.log("\n4. the matchup follow-up: the defense adds nothing material to the offense baseline (so no prediction field)");
for (const g of GROUPS) {
  check(`${g}: offense baseline + defense effect (shrunk) misses the bar in 2019–2024 or 2025`, () => {
    const per = ["2019-2024 (LOSO)", "2025 holdout"].map((k) => {
      const R = M.positions[g][k], v = R._incremental_vs_offense_baseline["Combined ratio [Full season] shrunk"], base = R["Offense baseline"].MAE;
      return { mae: v.dMAE / base <= -MATERIAL && v.dMAE_ci[1] < 0, rank: v.dRank >= MATERIAL && v.dRank_ci[0] > 0 };
    });
    const material = (per[0].mae && per[1].mae) || (per[0].rank && per[1].rank);
    assert.strictEqual(material, false);
  });
}
check("raw Allowed is a worse points forecast than the league average at every position, both periods", () => {
  for (const g of GROUPS) for (const k of ["2019-2024 (LOSO)", "2025 holdout"]) {
    const R = M.positions[g][k];
    assert.ok(R["Raw Allowed [Full season]"].MAE > R["League average"].MAE, g + " " + k);
  }
});
console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
