// Trade War Room "Salary Reconciliation" prices cap room on MFL's LIVE salary adjustments, never a static file,
// and a failed read stays "unknown" (—), never $0.
//   node tests/trade_war_room_live_adjustments.test.mjs
//   TWB_JS=<path> node tests/trade_war_room_live_adjustments.test.mjs   (defect check against another copy)
//
// #1338 (checked 2026-10-20): the page replaced each team's live total with
// site/reports/salary_adjustments/salary_adjustments_2026.json (32 rows of 2025 drop-penalty CANDIDATES, last
// committed 10-06). MFL's live totals that day vs the file: C-Town Chivalry $35,000 vs $1,000, Blake Bombers
// −$27,000 vs $6,250, Sex Manther $41,000 vs $8,250 — "Available after trade" off by up to $34,000 a team.
// The worker sends salary_adjustment_total_dollars = null when it can't read MFL; normalizeData turned that into 0.
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TWB = fs.readFileSync(process.env.TWB_JS || path.join(ROOT, "site/trades/trade_workbench.js"), "utf8");

function sliceFn(src, sig, from = 0) {
  const at = src.indexOf(sig, from);
  if (at < 0) throw new Error("not found: " + sig);
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced: " + sig);
}
// The `salary_adjustment_total_dollars: safeMoneyInt(…)` expression of a normalizer, as source.
function adjustmentExprs() {
  const out = [];
  const key = "salary_adjustment_total_dollars: safeMoneyInt(";
  let at = TWB.indexOf(key);
  while (at >= 0) {
    let i = at + key.length - 1, depth = 0;
    for (; i < TWB.length; i++) { if (TWB[i] === "(") depth++; else if (TWB[i] === ")" && --depth === 0) break; }
    out.push(TWB.slice(at + "salary_adjustment_total_dollars: ".length, i + 1));
    at = TWB.indexOf(key, i);
  }
  return out;
}

const ctx = vm.createContext({});
vm.runInContext(sliceFn(TWB, "function safeStr(") + "\n" + sliceFn(TWB, "function safeMoneyInt("), ctx);

test("a team the worker could not price stays unknown (null), a priced one keeps MFL's number", () => {
  const exprs = adjustmentExprs();
  t.equal(exprs.length, 2, "both team normalizers found");
  for (const expr of exprs) {
    const v = expr.includes("rt.") ? "rt" : "rf";
    const evalWith = (team) => vm.runInContext("(function(" + v + "){ return " + expr + "; })(" + JSON.stringify(team) + ")", ctx);
    t.equal(evalWith({ salary_adjustment_total_dollars: null }), null, v + ": worker null → null (not $0)");
    t.equal(evalWith({ summary: {} }), null, v + ": missing → null");
    t.equal(evalWith({ salary_adjustment_total_dollars: 35000 }), 35000, v + ": C-Town's live $35,000 kept");
    t.equal(evalWith({ salary_adjustment_total_dollars: -27000 }), -27000, v + ": Blake Bombers' live −$27,000 kept");
  }
});

test("nothing replaces the live totals with the static candidates file", () => {
  const norm = sliceFn(TWB, "async function normalizeDataWithFallbacks(");
  t.ok(!/SalaryAdjustmentLedger/.test(norm), "normalizeDataWithFallbacks applies no salary-adjustment ledger");
  t.ok(!/reports\/salary_adjustments\/salary_adjustments_/.test(TWB.replace(/\/\/[^\n]*/g, "")), "the page never fetches the static file");
  t.ok(!/function applySalaryAdjustmentLedgerToTradeData\s*\(/.test(TWB), "the override helper is gone");
});

test("downstream: a null adjustment suppresses the cap figures instead of pricing $0", () => {
  const fn = sliceFn(TWB, "function buildSalaryReconciliation(");
  t.ok(/leftAdjustmentTotal == null \? null/.test(fn) && /rightAdjustmentTotal == null \? null/.test(fn), "before/after room is null when the adjustment is unknown");
  const fmt = sliceFn(TWB, "function formatDollarsPlainLabel(");
  t.ok(/dollars == null\) return "—"/.test(fmt), "unknown renders as —");
});

await run("trade_war_room_live_adjustments");
