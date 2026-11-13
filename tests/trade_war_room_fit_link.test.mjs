// Trade War Room preload link (#1338): Front Office opens the SAME War Room with a partner and the assets each side
// gives (twb_right_team, twb_give, twb_get); only trade-eligible assets are selected; the params are scrubbed; the
// loader forwards the new keys from the MFL page's query or hash.
//   node tests/trade_war_room_fit_link.test.mjs
//   TWB_JS=<path> node tests/trade_war_room_fit_link.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TWB = fs.readFileSync(process.env.TWB_JS || path.join(ROOT, "site/trades/trade_workbench.js"), "utf8");
const LDR = fs.readFileSync(path.join(ROOT, "site/trades/mfl_hpm_embed_loader.js"), "utf8");

function sliceFn(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("not found: " + sig);
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error("unbalanced: " + sig);
}

function harness(url) {
  const teams = {
    "0008": { franchise_id: "0008", assets: [
      { asset_id: "p:15000", type: "PLAYER", player_id: "15000" }, { asset_id: "p:15001", type: "PLAYER", player_id: "15001", tagged: true },
      { asset_id: "pick:FP_0008_2027_1", type: "PICK", pick_key: "FP_0008_2027_1" }] },
    "0004": { franchise_id: "0004", assets: [
      { asset_id: "p:16598", type: "PLAYER", player_id: "16598" }, { asset_id: "pick:FP_0004_2027_6", type: "PICK", pick_key: "FP_0004_2027_6", sixth: true }] },
  };
  const c = vm.createContext({ URL, document: { title: "" }, window: { location: { href: url }, history: { replaceState(_, __, u) { c.window.location.href = u; } } } });
  c.state = { leftTeamId: "0001", rightTeamId: "", selections: {}, mobileTab: "your" };
  c.getTeamById = (id) => teams[id] || null;
  c.setActiveFranchiseId = (id) => { c.state.leftTeamId = id; };
  c.ensureSelectionMaps = (id) => { c.state.selections[id] = c.state.selections[id] || {}; };
  c.clampTradeSalaryForTeam = () => {};
  c.isTradeEligibleAsset = (a) => !a.tagged && !a.sixth;      // the board's own rule is tested in trade_forfeited_pick_view
  c.synthesizePickAssetForTeam = () => null;
  vm.runInContext([sliceFn(TWB, "function safeStr("), sliceFn(TWB, "function pad4("), sliceFn(TWB, "function getUrlParam("),
    sliceFn(TWB, "function normalizePickKey("), sliceFn(TWB, "function findTeamAssetByTradeToken("),
    sliceFn(TWB, "function clearRosterDeepLinkParams("), sliceFn(TWB, "function applyFitDeepLink(")].join("\n"), c);
  return c;
}
const sel = (c, fid) => Object.keys(c.state.selections[fid] || {}).sort().join(",");

test("a fit link preloads partner + both sides, skips untradeable assets, and scrubs itself from the URL", () => {
  const c = harness("https://keithcreelman.github.io/upsmflproduction/trades/trade_workbench.html?L=74598&twb_left_team=0008&twb_right_team=0004&twb_give=15000,15001,FP_0008_2027_1&twb_get=16598,FP_0004_2027_6&embed=1");
  t.equal(vm.runInContext("applyFitDeepLink()", c), true);
  t.equal(c.state.leftTeamId, "0008"); t.equal(c.state.rightTeamId, "0004");
  t.equal(sel(c, "0008"), "p:15000,pick:FP_0008_2027_1", "your player and pick; the tagged player is skipped");
  t.equal(sel(c, "0004"), "p:16598", "their player; the 6th-round pick is skipped");
  t.equal(c.state.mobileTab, "partner");
  t.ok(!/twb_(give|get|left_team|right_team)/.test(c.window.location.href) && /embed=1/.test(c.window.location.href), "params removed, others kept");
});

test("a partner alone sets the partner; no keys at all changes nothing", () => {
  const c = harness("https://x.test/tw.html?twb_right_team=0004");
  t.equal(vm.runInContext("applyFitDeepLink()", c), true);
  t.equal(c.state.rightTeamId, "0004"); t.equal(sel(c, "0004"), "");
  const d = harness("https://x.test/tw.html?L=74598");
  t.equal(vm.runInContext("applyFitDeepLink()", d), false);
  t.equal(d.state.rightTeamId, "");
});

test("wiring: the one-player link still works first; the new keys are forwarded by the loader and scrubbed", () => {
  t.ok(/if \(!playerId\) return applyFitDeepLink\(\);/.test(sliceFn(TWB, "function applyRosterDeepLinkSelection(")), "fit link handled when no single player is named");
  t.ok(/"twb_give", "twb_get"/.test(sliceFn(TWB, "function clearRosterDeepLinkParams(")));
  t.ok(/"twb_side",\s*"twb_give",\s*"twb_get"/.test(LDR), "the loader forwards twb_give / twb_get from the MFL page");
  t.ok(!/fetch\(/.test(sliceFn(TWB, "function applyFitDeepLink(")), "preloading sends nothing");
});

await run("trade_war_room_fit_link");
