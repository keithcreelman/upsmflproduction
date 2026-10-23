// Trade rules — the trade arithmetic the worker and the desktop Trade War Room share (worker/src/trade_rules.js, browser
// twin site/shared/trade_rules.js, Trade Builder P1 slice 1). Checks:
//   1. the twin is the worker module, byte for byte (regenerate: node scripts/generate_shared_trade_rules.mjs);
//   2. the rules themselves (§A6 cap-money maximum, B3 IR cap hit, the hard cap's "exactly at the cap is allowed");
//   3. every caller was switched over and none keeps its own copy of the arithmetic;
//   4. GOLDEN: nothing changed. tests/fixtures/trade_rules_golden.json was recorded on the tree BEFORE the move
//      (origin/main 7b243a64): evaluateTradeCompliance for every distinct call cap_parity / trade_cap_gate /
//      trade_loaded_contracts make, currentCapHit, movementCapMaxK, capMoneyViolations and the War Room's own cap helpers.
//      Today's output must be byte-identical — never regenerate the fixture to make this pass;
//   5. the known worker ↔ War Room differences, pinned as they are TODAY ("preserved — change only with Keith's approval").
//   node tests/trade_rules.test.mjs
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const { capMoneyMaxK, irCapHit, isOverCap, IR_RELIEF_RATE } = await import("../worker/src/trade_rules.js");
const { currentCapHit, IR_RELIEF_RATE: CAP_MATH_IR_RATE } = await import("../worker/src/cap_math.js");
const { movementCapMaxK } = await import("../worker/src/trade_3way.js");
const { capMoneyViolations } = await import("../worker/src/trade_accept_integrity.js");
const { evaluateTradeCompliance } = await import("../worker/src/trade_cap_authority.js");
const { warRoomSnapshot, WAR_ROOM_FIXTURE } = await import("./fixtures/war_room_cap_harness.mjs");
const { render, sharedBody } = await import("../scripts/generate_shared_trade_rules.mjs");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const TWIN = createRequire(import.meta.url)("../site/shared/trade_rules.js");
const GOLDEN = JSON.parse(read("tests/fixtures/trade_rules_golden.json"));
const RULES_SRC = read("site/shared/trade_rules.js");
const code = (src) => src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");   // comments dropped: only code is checked

// ───────────────────────────── 1. the twin ─────────────────────────────
test("the browser twin is the worker module, byte for byte (same check as tests/taxi_rule.test.mjs)", () => {
  const w = read("worker/src/trade_rules.js"), s = RULES_SRC;
  const body = w.slice(w.search(/^export /m)).replace(/export const /g, "const ").replace(/export function /g, "function ");
  const twin = s.slice(s.indexOf("---- body: generated")).split("\n").slice(1).join("\n");
  const twinBody = twin.slice(0, twin.indexOf("  // ---- end body ----")).split("\n").map((l) => l.replace(/^  /, "")).join("\n");
  t.equal(twinBody.trim(), body.trim(), "regenerate site/shared/trade_rules.js: node scripts/generate_shared_trade_rules.mjs");
  t.equal(sharedBody(w), body.trimEnd(), "the generator and this test strip the same way");
  t.equal(s, render(w), "the whole twin file is exactly what the generator writes");
  t.deepEqual(Object.keys(TWIN).sort(), ["IR_RELIEF_RATE", "capMoneyMaxK", "irCapHit", "isOverCap"], "the twin exposes every export");
  t.ok(/root\.UPS_TRADE_RULES = api;/.test(s) && /module\.exports = api/.test(s), "window.UPS_TRADE_RULES + module.exports");
  t.doesNotMatch(code(w), /\bfetch\(|\benv\b|document\.|window\./, "the worker module is pure: no fetch, env or DOM");
  t.doesNotMatch(w, /^import /m, "and imports nothing (the twin can't)");
});

test("the twin computes the same as the worker module on a grid", () => {
  const xs = [-3, -1, -0.5, 0, 0.5, 1, 2.5, 999, 1000, 1001, 1999, 2000, 2001, 7001, 9000, 9999, 10000, 21000, 300000, 300001];
  for (const x of xs) {
    t.equal(Object.is(TWIN.capMoneyMaxK(x), capMoneyMaxK(x)), true, `capMoneyMaxK(${x})`);
    t.equal(Object.is(TWIN.irCapHit(x), irCapHit(x)), true, `irCapHit(${x})`);
    for (const c of [0, 1000, 300000]) t.equal(TWIN.isOverCap(x, c), isOverCap(x, c));
  }
  t.equal(TWIN.IR_RELIEF_RATE, IR_RELIEF_RATE);
});

// ───────────────────────────── 2. the rules ─────────────────────────────
test("§A6 cap-money maximum: floor(non-taxi salary sent / 2000), in $K", () => {
  for (const [dollars, k] of [[0, 0], [1999, 0], [2000, 1], [9000, 4], [9999, 4], [10000, 5], [21000, 10], [31000, 15]]) t.equal(capMoneyMaxK(dollars), k, `$${dollars} → $${k}K`);
});

test("B3 IR cap hit: half the salary, rounded to the dollar (a half rounds up)", () => {
  t.equal(IR_RELIEF_RATE, 0.5); t.equal(CAP_MATH_IR_RATE, 0.5, "cap_math re-exports the same constant");
  for (const [salary, hit] of [[0, 0], [1, 1], [2, 1], [3, 2], [999, 500], [1001, 501], [7001, 3501], [10000, 5000], [21000, 10500]]) t.equal(irCapHit(salary), hit, `$${salary} → $${hit}`);
});

test("hard cap: exactly at the cap is allowed; $1 over is over", () => {
  t.equal(isOverCap(300000, 300000), false, "at the cap");
  t.equal(isOverCap(300001, 300000), true, "cap + 1");
  t.equal(isOverCap(299999, 300000), false, "under");
});

// ───────────────────────────── 3. the callers ─────────────────────────────
test("every caller uses the shared rule and keeps no copy of the arithmetic", () => {
  const cm = read("worker/src/cap_math.js"), m3 = read("worker/src/trade_3way.js"), ai = read("worker/src/trade_accept_integrity.js"), ca = read("worker/src/trade_cap_authority.js");
  t.match(cm, /import \{ IR_RELIEF_RATE, irCapHit \} from "\.\/trade_rules\.js";/); t.match(cm, /if \(p\.ir\) return irCapHit\(amt\);/);
  t.match(m3, /import \{ capMoneyMaxK \} from "\.\/trade_rules\.js";/); t.match(m3, /return capMoneyMaxK\(sum\);/);
  t.match(ai, /import \{ capMoneyMaxK \} from "\.\/trade_rules\.js";/); t.match(ai, /const maxDollars = capMoneyMaxK\(nonTaxi\) \* 1000;/);
  t.match(ca, /import \{ isOverCap \} from "\.\/trade_rules\.js";/); t.match(ca, /if \(isOverCap\(st\.after, L\.cap\)\) violations\.push\(/);
  for (const [f, src] of [["trade_3way.js", m3], ["trade_accept_integrity.js", ai], ["cap_math.js", cm]]) t.doesNotMatch(code(src), /\/ 2000\)|\* 0\.5\b|\* IR_RELIEF_RATE/, f);
  const desk = read("site/trades/trade_workbench.js");
  t.doesNotMatch(code(desk), /\/ 2000\)|salary \* 0\.5/, "the War Room keeps no copy");
  t.equal((desk.match(/tradeRules\(\)\.capMoneyMaxK\(/g) || []).length, 2, "2-team getTradeSalaryMaxK + 3-team tw3MovementMaxCapK");
  t.equal((desk.match(/tradeRules\(\)\.irCapHit\(salary\)/g) || []).length, 1, "getAssetCurrentCapHitDollars");
  t.equal((desk.match(/tradeRules\(\)\.isOverCap\(-(left|right)AvailableAfter, 0\)/g) || []).length, 2, "the reconciliation's over-cap flags");
  t.equal((desk.match(/window\.UPS_TRADE_RULES\./g) || []).length, 0, "read only through the lazy tradeRules() accessor, never captured at load");
  t.equal((desk.match(/tradeRules\(\)\./g) || []).length, 5);
  // every send path refuses while the rules are missing (fail closed)
  for (const f of ["submitOfferToQueue", "submitStagedOfferToQueue", "tw3Submit"]) {
    const at = desk.indexOf(`async function ${f}() {`);
    t.match(desk.slice(at, at + 200), /\n    if \(!tradeRulesReadyToSend\(\)\) return;\n/, `${f} checks the rules first`);
  }
  t.match(desk, /if \(!state\.data\.teams\.length\) throw new Error\("No teams in data payload\."\);\n      await waitForTradeRules\(8000\);/, "boot waits (bounded) for a requested copy");
  const html = read("site/trades/trade_workbench.html");
  const at = (s) => html.indexOf(s);
  t.ok(at("../shared/trade_rules.js?v=") > 0 && at("../shared/trade_rules.js?v=") < at("./trade_workbench.js?v="), "the page loads the shared rules before trade_workbench.js");
  t.equal((html.match(/trade_rules\.js\?v=(\w+)/) || [])[1], (html.match(/trade_workbench\.js\?v=(\w+)/) || [])[1], "same ?v= stamp as the workbench");
  t.doesNotMatch(html, /trade_rules\.js[^"]*"\s+defer/, "loaded synchronously, like trade_3way_view.js, so it is there before the deferred workbench runs");
});

// ───────────────────────────── 4. golden: no behavior change ─────────────────────────────
test("GOLDEN evaluateTradeCompliance: every recorded call returns byte-identical output", () => {
  const G = GOLDEN.evaluate_trade_compliance;
  t.ok(G.cases.length >= 250, `${G.cases.length} recorded calls`);
  const srcs = new Set(G.cases.map((c) => c.src));
  for (const s of ["cap_parity", "trade_cap_gate", "trade_loaded_contracts"]) t.ok(srcs.has(s), `includes ${s}'s fixtures`);
  let over = 0, atOrUnder = 0;
  for (const [i, c] of G.cases.entries()) {
    const args = {}; for (const k of Object.keys(c.args)) args[k] = JSON.parse(JSON.stringify(G.pool[c.args[k]]));
    const got = JSON.stringify(evaluateTradeCompliance(args)), want = G.outputs[c.out];
    if (crypto.createHash("sha256").update(got).digest("hex") !== want.sha256) {
      t.deepEqual(JSON.parse(got).cap, want.cap, `case ${i} (${c.src}): cap block`);
      t.equal(got.length, want.length, `case ${i} (${c.src}): output length`);
      t.ok(false, `case ${i} (${c.src}): output differs from the pre-change snapshot`);
    } else t.ok(true);
    for (const v of (want.cap && want.cap.violations) || []) if (v.amount_over > 0) over += 1;
    for (const r of (want.cap && want.cap.rows) || []) if (r.over_by === 0) atOrUnder += 1;
  }
  t.ok(over > 0 && atOrUnder > 0, "the snapshot covers both over-cap and within-cap franchises");
});

test("GOLDEN currentCapHit / movementCapMaxK / capMoneyViolations: identical to the pre-change outputs", () => {
  // compared as JSON, as recorded (Math.round(-0.5) is -0 before and after; JSON writes both as 0)
  for (const [p, want] of GOLDEN.current_cap_hit) t.equal(JSON.stringify(currentCapHit(p)), JSON.stringify(want), JSON.stringify(p));
  const M = GOLDEN.movement_cap_max_k;
  for (const [m, want] of M.cases) t.equal(movementCapMaxK(m, M.salaryByFp, M.taxiByFp), want, JSON.stringify(m.asset_tokens));
  const V = GOLDEN.cap_money_violations;
  for (const [byFranchise, want] of V.cases) t.deepEqual(capMoneyViolations({ byFranchise, rosters: V.rosters }), want, JSON.stringify(byFranchise));
  t.ok(GOLDEN.current_cap_hit.length > 300 && M.cases.length > 10 && V.cases.length > 10);
});

const WR = warRoomSnapshot({ rulesSrc: RULES_SRC });
test("GOLDEN War Room: getTradeSalaryMaxK, tw3 max, cap hits and the full salary reconciliation are identical to the pre-change snapshot", () => {
  t.equal(JSON.stringify(WR), JSON.stringify(GOLDEN.war_room), "byte-identical snapshot");
  t.deepEqual(WR.scenarios.map((s) => s.max_k), [[15, 15], [10, 3], [0, 1], [0, 10], [0, 0], [0, 3], [0, 4], [0, 2], [0, 2]], "2-team cap-money max ($K) per scenario");
  const last2 = WR.scenarios.slice(-2).map((s) => [s.reconciliation.left.new_salary_dollars, s.reconciliation.left.over_cap_dollars]);
  t.deepEqual(last2, [[300000, 0], [300001, 1]], "exactly at the cap: not over; $1 past it: over by $1");
});

const UNAVAILABLE = "The trade rules didn't load. Reload the page to continue; no offer can be sent until then.";
test("the War Room without the shared script fails closed (no silent second copy)", () => {
  let err = null;
  try { warRoomSnapshot({ rulesSrc: null }); } catch (e) { err = e; }
  t.ok(err, "a rule lookup throws instead of guessing");
  t.equal(err && err.message, UNAVAILABLE);
});

test("the War Room's rules arriving LATE (an older cached page; the copy it requested comes in): refused before, golden after", () => {
  const late = warRoomSnapshot({ lateRulesSrc: RULES_SRC });
  t.deepEqual(late.before, { maxKError: UNAVAILABLE, irHitError: UNAVAILABLE }, "before it arrives: no cap-money max, no IR cap hit — not a substitute value");
  t.equal(JSON.stringify(late.snapshot), JSON.stringify(GOLDEN.war_room), "after it arrives: byte-identical to the pre-change snapshot");
});

// ───────────────────────────── 5. preserved differences ─────────────────────────────
// Each is TODAY's behavior on each side. Preserved — change only with Keith's approval.
const asset = (id) => WAR_ROOM_FIXTURE.teams.flatMap((tm) => tm.assets).find((a) => a.player_id === id);
test("PRESERVED: a player whose contract years are blank counts $0 in the War Room; the worker counts his full salary", () => {
  t.equal(asset("1004").years, null);
  t.deepEqual(WR.assets["1004"], [0, 0, 0, 0], "War Room: $0 trade basis, $0 cap hit, $0 sent, $0 arriving");
  t.equal(currentCapHit({ salary: 8000, years: 0, taxi: false, ir: false, unknown: true }), 8000, "worker: an unknown contract still counts its salary");
});

test("PRESERVED: a blank-years player unlocks no cap money in the 2-team War Room builder but does in the 3-team one", () => {
  const s = WR.scenarios[2];   // 0001 sends only the blank-years $8K player
  t.equal(s.max_k[0], 0, "2-team: getTradeSalaryMaxK = 0");
  t.equal(s.tw3_max_k[0], 4, "3-team: tw3MovementMaxCapK = floor(8000 / 2000) = 4");
});

test("PRESERVED: an IR player arriving by trade stays at 50% in the War Room preview; the worker lands him active at full salary", () => {
  t.deepEqual(WR.assets["1002"], [10000, 5000, 5000, 5000], "War Room: arrival cap = 50% of $10K");
  t.deepEqual(WR.assets["2002"], [7001, 3501, 3501, 3501], "War Room: arrival cap = 50% of $7,001, rounded up");
  t.equal(currentCapHit({ salary: 10000, years: 1, taxi: false, ir: false, unknown: false }), 10000, "worker: lands with ir:false → full salary");
  t.equal(currentCapHit({ salary: 10000, years: 1, taxi: false, ir: true, unknown: false }), 5000, "worker: while still on the sender's IR → 50%");
});

test("PRESERVED: IR detection differs — the War Room reads roster_status/injury text; the worker reads MFL's INJURED_RESERVE status", () => {
  const desk = read("site/trades/trade_workbench.js");
  t.match(desk, /return status\.indexOf\("INJURED"\) !== -1 \|\| status\.indexOf\("_IR"\) !== -1 \|\| status === "IR";/);
  t.match(read("worker/src/cap_math.js"), /ir: /);
});

test("PRESERVED: cap-money direction is not shared yet (the worker charges the sender and credits the receiver per movement; the 2-team War Room nets the two $K inputs)", () => {
  t.match(read("worker/src/trade_cap_authority.js"), /if \(capDollars > 0\) \{ state\[m\.from\]\.after \+= capDollars; state\[m\.from\]\.capOut \+= capDollars; state\[m\.to\]\.after -= capDollars; state\[m\.to\]\.capIn \+= capDollars; \}/);
  t.match(read("site/trades/trade_workbench.js"), /var leftSalaryTradeAdjustmentDollars = \(leftTradeK - rightTradeK\) \* 1000;/);
});

await run("trade_rules");
