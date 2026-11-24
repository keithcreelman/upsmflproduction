// The desktop Trade War Room's REAL cap helpers, extracted by name from site/trades/trade_workbench.js and run in a
// small vm context (same extraction as tests/trade_taxi_arrival_preview_client.test.mjs), over one fixed fixture.
// warRoomSnapshot() returns every number the War Room derives from it: per-asset cap hits, team totals, the §A6
// cap-money maxima (2-team and 3-team), and the full salary reconciliation. tests/trade_rules.test.mjs compares
// it with the snapshot recorded BEFORE the arithmetic moved into site/shared/trade_rules.js (Trade Builder P1).
import fs from "node:fs";
import vm from "node:vm";

const read = (rel) => fs.readFileSync(new URL("../../" + rel, import.meta.url), "utf8");

function extractor(SRC) {
  return function fn(name) {
    const start = SRC.indexOf(`function ${name}(`);
    if (start < 0) throw new Error(`${name} not found in trade_workbench.js`);
    let i = SRC.indexOf("{", start), depth = 0;
    for (; i < SRC.length; i += 1) { if (SRC[i] === "{") depth += 1; else if (SRC[i] === "}" && --depth === 0) break; }
    return SRC.slice(start, i + 1);
  };
}

const FUNCS = [
  "safeStr", "safeInt", "pad4", "isForfeitedPick", "isUntradeableSixthRoundPick", "isTaggedTradeIneligibleAsset", "isTradeEligibleAsset",
  "getTeamById", "getOtherTeamId", "ensureSelectionMaps",
  "assetHasActiveCurrentContract", "assetCountsAsCurrentIr", "getAssetTradeSalaryBasisDollars", "getAssetCurrentCapHitDollars",
  "getAssetCapSalaryDollars", "arrivingAsActive", "getAssetArrivalCapSalaryDollars", "getTeamTotals", "getTradeSalaryMaxK", "getNetTradeSalaryK",
  "sumTeamCommittedSalary", "resolveTeamAvailableSalaryDollars", "resolveTeamSalaryAdjustmentTotalDollars", "buildSalaryReconciliation",
  "tw3PickToken", "tw3IsTradeable", "tw3TeamAssets", "tw3MovementMaxCapK",
];
// The lazy shared-rules accessor (added with the move; absent from the pre-change source the golden was recorded on).
const RULES_ACCESSOR = ["tradeRulesScriptUrl", "settleTradeRulesWaiters", "requestTradeRulesIfMissing", "tradeRules"];
const RULES_VARS = [/^  var TRADE_RULES_UNAVAILABLE = .*;$/m, /^  var tradeRulesLoad = .*;$/m];

const P = (id, salary, years, extra) => ({ type: "PLAYER", asset_id: "player:" + id, player_id: id, salary, years, taxi: false, ...(extra || {}) });

// Team 0001: WR $21K (2 yrs), RB $10K (1 yr, on IR), a $5K taxi player, and an $8K player whose years are blank.
// Team 0002: QB $30K, an IR LB at an odd $7,001 (rounding), $2K / $4K / $4,001 players in their final year.
// Team 0003: $296K committed — receiving lands it exactly at, or $1 over, the $300K cap.
export const WAR_ROOM_FIXTURE = {
  meta: { salary_cap_dollars: 300000, pick_restrictions_verified: true },
  teams: [
    { franchise_id: "0001", franchise_name: "Team One", salary_adjustment_total_dollars: 4000, assets: [
      P("1001", 21000, 2), P("1002", 10000, 1, { roster_status: "INJURED_RESERVE" }), P("1003", 5000, 2, { taxi: true }), P("1004", 8000, null) ] },
    { franchise_id: "0002", franchise_name: "Team Two", salary_adjustment_total_dollars: null, assets: [
      P("2001", 30000, 3), P("2002", 7001, 2, { roster_status: "INJURED_RESERVE" }), P("2003", 2000, 1), P("2004", 4000, 1), P("2005", 4001, 1) ] },
    { franchise_id: "0003", franchise_name: "Team Three", salary_adjustment_total_dollars: 0, assets: [ P("3001", 296000, 1), P("3002", 1000, 0) ] },
  ],
};

// [left, right, left selections, right selections, left $K, right $K]
export const WAR_ROOM_SCENARIOS = [
  ["0001", "0002", ["1001", "1002", "1003", "1004"], ["2001"], 5, 0],
  ["0001", "0002", ["1001", "1003"], ["2002"], 0, 3],
  ["0001", "0002", ["1004"], ["2003"], 0, 0],
  ["0003", "0001", [], ["1001"], 0, 0],
  ["0003", "0001", [], ["1004", "1003"], 0, 0],
  ["0003", "0002", [], ["2002"], 0, 0],
  ["0003", "0002", ["3002"], ["2003", "2002"], 0, 1],
  ["0003", "0002", [], ["2004"], 0, 0],   // lands EXACTLY at the cap: allowed
  ["0003", "0002", [], ["2005"], 0, 0],   // $1 over
];

/**
 * @param rulesSrc      site/shared/trade_rules.js source to load first (null = none: the page didn't load it).
 * @param lateRulesSrc  load it only AFTER a first rule lookup (an older cached page; the copy the War Room requests arrives
 *                      later). Returns { before: what that first lookup did, snapshot } instead of the snapshot.
 */
export function warRoomSnapshot({ workbenchSrc = read("site/trades/trade_workbench.js"), rulesSrc = null, lateRulesSrc = null } = {}) {
  const fn = extractor(workbenchSrc);
  const ctx = { Object, Math, String, JSON, Array, isFinite, parseInt };
  ctx.window = ctx;
  vm.createContext(ctx);
  if (rulesSrc) vm.runInContext(rulesSrc, ctx, { filename: "site/shared/trade_rules.js" });
  vm.runInContext([
    "function hasTradeTagDeadlinePassed(){ return false; }",
    "function resolvePickMeta(a){ return { round: a.pick_round, year: a.pick_season, token: '' }; }",
    "var state = { data: null, selections: {}, extensions: {}, collapsed: {}, tradeSalaryK: {}, leftTeamId: '', rightTeamId: '' };",
    "var tw3 = { give: {}, cap: {} };",
    ...RULES_VARS.map((re) => (workbenchSrc.match(re) || [""])[0]),
    ...RULES_ACCESSOR.filter((n) => workbenchSrc.includes(`function ${n}(`)).map(fn),
    ...FUNCS.map(fn),
  ].join("\n"), ctx);
  const run = (code) => vm.runInContext(code, ctx);
  let before = null;
  if (lateRulesSrc) {
    run("state.data = " + JSON.stringify(WAR_ROOM_FIXTURE) + "; state.leftTeamId = '0001'; state.rightTeamId = '0002'; state.selections = { '0001': { 'player:1002': true } };");
    before = {};
    try { before.maxK = run("getTradeSalaryMaxK('0001')"); } catch (e) { before.maxKError = String(e && e.message); }
    try { before.irHit = run(`getAssetCurrentCapHitDollars(${JSON.stringify(WAR_ROOM_FIXTURE.teams[0].assets[1])})`); } catch (e) { before.irHitError = String(e && e.message); }
    vm.runInContext(lateRulesSrc, ctx, { filename: "site/shared/trade_rules.js (arrived late)" });
    run("state.selections = {};");
  }
  const out = { assets: {}, scenarios: [] };
  run("state.data = " + JSON.stringify(WAR_ROOM_FIXTURE) + ";");
  for (const team of WAR_ROOM_FIXTURE.teams) for (const a of team.assets) {
    const j = JSON.stringify(a);
    out.assets[a.player_id] = run(`[getAssetTradeSalaryBasisDollars(${j}), getAssetCurrentCapHitDollars(${j}), getAssetCapSalaryDollars(${j}), getAssetArrivalCapSalaryDollars(${j})]`);
  }
  for (const [l, r, ls, rs, lk, rk] of WAR_ROOM_SCENARIOS) {
    const sel = (ids) => JSON.stringify(Object.fromEntries(ids.map((id) => ["player:" + id, true])));
    run(`state.leftTeamId = ${JSON.stringify(l)}; state.rightTeamId = ${JSON.stringify(r)};
         state.selections = {}; state.selections[${JSON.stringify(l)}] = ${sel(ls)}; state.selections[${JSON.stringify(r)}] = ${sel(rs)};
         state.tradeSalaryK = {}; state.tradeSalaryK[${JSON.stringify(l)}] = ${lk}; state.tradeSalaryK[${JSON.stringify(r)}] = ${rk};
         tw3.give = {}; tw3.give[${JSON.stringify(l)}] = {}; tw3.give[${JSON.stringify(r)}] = {};
         ${ls.map((id) => `tw3.give[${JSON.stringify(l)}]["player:${id}"] = ${JSON.stringify(r)};`).join(" ")}
         ${rs.map((id) => `tw3.give[${JSON.stringify(r)}]["player:${id}"] = ${JSON.stringify(l)};`).join(" ")}`);
    const snap = run(`(function () {
      var lt = getTeamTotals(state.leftTeamId), rt = getTeamTotals(state.rightTeamId);
      return {
        totals: [lt, rt],
        max_k: [getTradeSalaryMaxK(state.leftTeamId), getTradeSalaryMaxK(state.rightTeamId)],
        net_k: [getNetTradeSalaryK(state.leftTeamId), getNetTradeSalaryK(state.rightTeamId)],
        tw3_max_k: [tw3MovementMaxCapK(state.leftTeamId, state.rightTeamId), tw3MovementMaxCapK(state.rightTeamId, state.leftTeamId)],
        reconciliation: buildSalaryReconciliation(getTeamById(state.leftTeamId), getTeamById(state.rightTeamId), lt, rt,
          state.tradeSalaryK[state.leftTeamId], state.tradeSalaryK[state.rightTeamId])
      };
    })()`);
    out.scenarios.push(JSON.parse(JSON.stringify(snap)));
  }
  const snapshot = JSON.parse(JSON.stringify(out));
  return lateRulesSrc ? { before, snapshot } : snapshot;
}
