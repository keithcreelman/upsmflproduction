// Front Office → Draft picks and Activity (#1338): who holds each pick (MFL futureDraftPicks), and MFL's transaction
// log read the right way round (IR deactivated = placed ON IR; taxi promoted = called up; waiver add|bid|drop).
//   node tests/front_office_picks_activity.test.mjs
//   FO_ACTIVITY_JS=<path> node tests/front_office_picks_activity.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(process.env.FO_ACTIVITY_JS || path.join(ROOT, "site/rosters/v2/fo_activity.js"), "utf8");
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/fo_picks_activity_2026.json"), "utf8"));
const ctx = vm.createContext({ document: { addEventListener() {} } });
ctx.window = ctx;
const names = { "15484": "Smith, A", "14842": "Jones, B", "16601": "Shipley, Will", "17586": "Taxi, Rookie", "17044": "One, Player", "17075": "Two, Player" };
ctx.UPS_FO_HUB = {
  pad4: (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? ("0000" + d).slice(-4) : ""; },
  asArray: (x) => (x == null ? [] : Array.isArray(x) ? x : [x]), esc: (s) => String(s), teamName: (f) => "T" + f,
  displayName: (n) => { const i = String(n).indexOf(","); return i > 0 ? n.slice(i + 1).trim() + " " + n.slice(0, i) : n; },
  playerIndex: () => Object.fromEntries(Object.entries(names).map(([k, v]) => [k, { name: v, pos: "WR", team: "X" }])),
  registerView() {}, dayLabel: () => "d",
};
vm.runInContext(SRC, ctx);
const A = ctx.UPS_FO_ACTIVITY;
vm.runInContext("UPS_FO_HUB_ref = window.UPS_FO_HUB", ctx);

test("pick holders: whose pick (original team) → who holds it now, exactly as MFL lists it", () => {
  const h = A.holders(FX.futureDraftPicks);
  t.equal(h["2027"]["0008"]["1"], "0006", "Real Deal Creel's 2027 R1 is held by The Long Haulers");
  t.equal(h["2027"]["0005"]["1"], "0008", "HammerTime's 2027 R1 is held by Real Deal Creel");
  t.equal(h["2027"]["0008"]["2"], "0008", "R2 still Real Deal Creel's own");
  let n = 0; for (const o of Object.values(h["2027"])) n += Object.keys(o).length;
  t.ok(n >= 55, n + " picks placed");
});

test("transactions read the right way round", () => {
  // the view needs H set at fo:ready; give it the stub directly for this pure helper
  ctx.window.UPS_FO = {}; ctx.window.UPS_FO_DATA = {};
  vm.runInContext("(function(){ var e = { detail: {} }; })()", ctx);
  const src = SRC.replace(/var H, FO, DATA;/, "var H = window.UPS_FO_HUB, FO, DATA;");
  const c2 = vm.createContext({ document: { addEventListener() {} } }); c2.window = c2; c2.UPS_FO_HUB = ctx.UPS_FO_HUB;
  vm.runInContext(src, c2);
  const lines = c2.UPS_FO_ACTIVITY.txLines(FX.transactions, "0008", 0, "league").map((l) => l.html);
  const ir = lines.find((l) => /14842|Jones/.test(l));
  t.ok(ir && /placed B Jones on IR/.test(ir), "deactivated = placed on IR: " + ir);
  const act = lines.find((l) => /A Smith/.test(l));
  t.ok(act && /activated A Smith from IR/.test(act), "activated = back from IR: " + act);
  const taxi = lines.find((l) => /Rookie Taxi/.test(l));
  t.ok(taxi && /promoted Rookie Taxi from the taxi squad/.test(taxi), taxi);
  const trade = lines.find((l) => /Trade/.test(l));
  t.ok(trade && /T0003 gave .*2027 R1/.test(trade) && /T0010 gave Player One, Player Two/.test(trade), trade);
  const bb = lines.find((l) => /on waivers/.test(l));
  t.ok(bb && /\(\$1,000\) on waivers; dropped/.test(bb), "waiver add with bid and drop: " + bb);
  const mine = c2.UPS_FO_ACTIVITY.txLines(FX.transactions, "0008", 0, "mine");
  t.ok(mine.length > 0 && mine.length < lines.length, "My team narrows the list");
});

test("Activity only reads; claims are checked against the waiver resolver and edited in the app", () => {
  t.ok(!/fetch\(|method:\s*"POST"/.test(SRC));
  t.ok(/MFL will refuse this claim at the next run/.test(SRC) && /BLOCKING\[st\.code\]/.test(SRC));
  t.ok(/Claims are edited in the phone app/.test(SRC));
  t.ok(/known !== true/.test(SRC), "an unknown read is never 'no claims'");
});

await run("front_office_picks_activity");
