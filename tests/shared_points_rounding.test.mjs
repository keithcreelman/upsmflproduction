// One rounding rule for fantasy points and PPG on the phone and desktop (Keith 2026-10-21): standard decimal
// half-up to one place through ONE shared formatter, site/m/season_scoring.js fmt1 / round1.
// Jacoby Brissett 2026: 116.1 over 6 MFL weeks = 19.35 → "19.4" (Math.round(v * 10) / 10 printed 19.3).
//   node tests/shared_points_rounding.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const ctx = {}; ctx.window = ctx; vm.createContext(ctx);
vm.runInContext(read("site/m/season_scoring.js"), ctx);
const SS = ctx.UPS_MOBILE_SEASON_SCORING;

test("decimal half-up, binary noise removed", () => {
  t.equal(SS.fmt1(116.1 / 6), "19.4"); t.equal(SS.fmt1(19.35), "19.4"); t.equal(SS.fmt1(22.45), "22.5");
  t.equal(SS.fmt1(246.9 / 11), "22.4"); t.equal(SS.fmt1(141.4 / 6), "23.6"); t.equal(SS.fmt1(0.05), "0.1");
  t.equal(SS.fmt1(-2.25), "-2.3"); t.equal(SS.fmt1(-0.04), "0.0"); t.equal(SS.fmt1(0), "0.0"); t.equal(SS.fmt1(null), "0.0");
  t.equal(SS.fmt1(2878.7), "2878.7"); t.equal(SS.round1(116.10000000000001), 116.1); t.equal(SS.round1(19.35), 19.4);
  // Exhaustive: every total −30.0…800.0 over 1–18 weeks matches exact decimal half-up (integer arithmetic).
  let bad = 0;
  for (let tenths = -300; tenths <= 8000; tenths++) for (let g = 1; g <= 18; g++) {
    const want = Math.floor((Math.abs(tenths) * 2 + g) / (2 * g));   // |tenths ÷ g| rounded half-up, exact integers
    const s = (tenths < 0 && want > 0 ? "-" : "") + Math.floor(want / 10) + "." + (want % 10);
    if (SS.fmt1(tenths / 10 / g) !== s) bad++;
  }
  t.equal(bad, 0, "exhaustive check");
});

test("a Brissett-shaped season through season_scoring reads 19.4", () => {
  const weeks = [22.1, 7.9, 33.0, 10.9, 32.3, 9.9];
  const ss = SS.build({ playerScoresAllWeeks: { year: "2026", playerScores: weeks.map((s, i) => ({ week: String(i + 1), playerScore: [{ id: "12616", score: String(s) }] })) } }, { completedWeek: 6, season: "2026" });
  t.equal(ss.byPid["12616"].pts, 116.1); t.equal(SS.fmt1(ss.byPid["12616"].ppg), "19.4");
});

test("every phone and desktop points/PPG surface on main uses the shared formatter", () => {
  const surfaces = {
    "site/m/player_sheet.js": /sp\.ppg != null \? window\.UPS_MOBILE_SEASON_SCORING\.fmt1\(sp\.ppg\)/,
    "site/m/player_search.js": /UPS_MOBILE_SEASON_SCORING\.fmt1\(p\.ppg\)/,
    "site/m/views/players.js": /function fmt1\(v\) \{ var S = window\.UPS_MOBILE_SEASON_SCORING; return S \? S\.fmt1/,
    "site/m/views/stats.js": /c\.f === "dec1"\) return window\.UPS_MOBILE_SEASON_SCORING \? window\.UPS_MOBILE_SEASON_SCORING\.fmt1\(v\)/,
    "site/m/views/lineup.js": /function fmtAvg\(v\) \{ var S = window\.UPS_MOBILE_SEASON_SCORING; return v == null \? "—" : S \? S\.fmt1\(v\)/,
    "site/stats_workbench/stats_workbench.html": /fmt === "dec1"\) return window\.UPS_MOBILE_SEASON_SCORING \? window\.UPS_MOBILE_SEASON_SCORING\.fmt1\(v\)/,
  };
  for (const [f, re] of Object.entries(surfaces)) t.ok(re.test(read(f)), f);
  const sheet = read("site/m/player_sheet.js");
  t.ok(!/\(Math\.round\((pts|ppg|sp\.pts|sp\.ppg|pts\[w\]) \* 10\) \/ 10\)\.toFixed\(1\)/.test(sheet), "no private points/PPG rounding left in the sheet");
  t.ok(/m\/season_scoring\.js\?v=/.test(read("site/stats_workbench/stats_workbench.html")), "the stats workbench loads the shared formatter");
  const idx = read("site/m/index.html");
  t.ok(idx.indexOf("./season_scoring.js") < idx.indexOf("./player_sheet.js"), "the phone loads it before the sheet");
});

await run("shared_points_rounding");
