// After a move, the phone app reads the roster FRESH from MFL — not the worker's 60-second copy (Keith 2026-10-16).
//   node tests/mobile_fresh_reads_after_move.test.mjs
//
// Will Shipley was placed on IR and the app still showed him on the active roster. The IR call succeeded; the reload that
// followed read /api/mfl-export, which keeps each MFL answer for 60 seconds (cf cacheTtl), and got the pre-move roster.
// Every move's reload (IR, taxi, drop, claim, trade, tag, draft) and pull-to-refresh go through reloadData().
// The functions below are the REAL ones from site/m/app.js, cut out by their text (never re-typed).
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP = fs.readFileSync(path.join(ROOT, "site/m/app.js"), "utf8");
const WORKER = fs.readFileSync(path.join(ROOT, "worker/src/index.js"), "utf8");
const cut = (src, start, end) => {
  const i = src.indexOf(start); if (i < 0) throw new Error("not found: " + start);
  const j = src.indexOf(end, i); if (j < 0) throw new Error("end not found: " + end);
  return src.slice(i, j);
};
const sliceFn = (src, sig) => {
  const at = src.indexOf(sig); if (at < 0) throw new Error("not found: " + sig);
  let i = src.indexOf("{", at), depth = 0;
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1); }
  throw new Error("unbalanced: " + sig);
};
const FRESH_BLOCK = cut(APP, "  var FRESH_READ_MS =", "  function mflExportUrl(type, extra) {");

function load() {
  const clock = { now: 1792170000000 };
  const ctx = vm.createContext({ encodeURIComponent, Object, console });
  ctx.Date = { now: () => clock.now };
  ctx.window = {};
  ctx.state = { ctx: { leagueId: "74598", year: "2026" } };
  ctx.workerUrl = (p) => "https://w.test" + p;
  ctx.loads = 0;
  ctx.loadAllData = () => { ctx.loads++; return "loaded"; };
  vm.runInContext(FRESH_BLOCK + "\n" + sliceFn(APP, "function mflExportUrl(") + "\n" + sliceFn(APP, "function mflExportUrlForYear(") + "\n" +
    sliceFn(APP, "function reloadData(") + "\nthis.api = { mflExportUrl, reloadData };", ctx);
  return { ...ctx.api, clock, ctx };
}
const busted = (url) => /[?&]_=\d+$/.test(url);
const MOVE_TYPES = ["rosters", "salaries", "salaryAdjustments", "tradeBait", "transactions", "pendingTrades", "draftResults", "freeAgents"];
const CACHED_TYPES = ["league", "players", "playerScores", "liveScoring", "injuries", "nflSchedule", "weeklyResults", "projectedScores"];

test("on a normal load nothing is fresh: every read keeps the shared 60-second cache", () => {
  const a = load();
  for (const ty of MOVE_TYPES.concat(CACHED_TYPES)) t.ok(!busted(a.mflExportUrl(ty)), ty);
  t.equal(a.mflExportUrl("rosters"), "https://w.test/api/mfl-export?TYPE=rosters&L=74598&YEAR=2026&JSON=1");
});

test("after a move (reloadData): the roster-level reads are fresh; everything else stays cached", () => {
  const a = load();
  t.equal(a.reloadData(), "loaded", "reloadData still reloads everything");
  t.equal(a.ctx.loads, 1);
  for (const ty of MOVE_TYPES) t.ok(busted(a.mflExportUrl(ty)), ty + " is read fresh");
  for (const ty of CACHED_TYPES) t.ok(!busted(a.mflExportUrl(ty)), ty + " keeps the cache");
  t.equal(a.mflExportUrl("tradeBait", { INCLUDE_DRAFT_PICKS: 1 }),
    "https://w.test/api/mfl-export?TYPE=tradeBait&L=74598&YEAR=2026&JSON=1&INCLUDE_DRAFT_PICKS=1&_=1792170000000", "after the caller's own params");
});

test("each fresh read gets its own key, and the window closes after 20 seconds", () => {
  const a = load();
  a.reloadData();
  const first = a.mflExportUrl("rosters");
  a.clock.now += 1;
  t.ok(a.mflExportUrl("rosters") !== first, "a second reload a moment later is not served the first one's copy");
  a.clock.now += 19998;
  t.ok(busted(a.mflExportUrl("rosters")), "still fresh just inside 20 s");
  a.clock.now += 2;
  t.ok(!busted(a.mflExportUrl("rosters")), "back to the cache after 20 s");
  a.reloadData();
  t.ok(busted(a.mflExportUrl("rosters")), "the next move opens a new window");
});

test("every move's reload goes through reloadData: IR / taxi / drop / claim / trade / tag / draft and pull-to-refresh", () => {
  t.match(APP, /reloadData: reloadData/, "UPS_MOBILE.actions.reloadData is this function");
  const sheet = fs.readFileSync(path.join(ROOT, "site/m/player_sheet.js"), "utf8");
  t.match(sheet, /\(placing \? "Placed on IR" : "Activated from IR"\), "ok"\);\s*\n\s*return window\.UPS_MOBILE\.actions\.reloadData\(\)/, "the IR move reloads through it");
  t.match(sliceFn(APP, "function installPullToRefresh("), /reloadData\(\)\.then/, "pull-to-refresh reloads through it");
});

test("the worker passes `_` through to MFL, so a fresh read is a distinct 60-second cache key", () => {
  const route = cut(WORKER, 'if (path === "/api/mfl-export" && request.method === "GET") {', 'if (path === "/api/mfl-detailed"');
  t.match(route, /if \(\["TYPE", "L", "YEAR", "JSON", "SERVER"\]\.includes\(k\)\) return;\s*\n\s*extra\.set\(k, v\);/, "every other param is forwarded");
  t.match(route, /\$\{extraStr \? "&" \+ extraStr : ""\}`;/, "…into the upstream URL");
  t.match(route, /cf: \{ cacheTtl: 60, cacheEverything: true \}/, "the 60-second edge cache this works around");
});

await run("mobile_fresh_reads_after_move");
