// Front Office → Trade finder (#1338): discovery only — every swap link is the ONE War Room route with the swap in the
// hash (the War Room's own preload keys), nothing is sent, the framing says it isn't a fairness grade, and the
// current season is never used before MFL has scored a week.
//   node tests/front_office_trade_finder.test.mjs
//   FO_TRADES_JS=<path> node tests/front_office_trade_finder.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(process.env.FO_TRADES_JS || path.join(ROOT, "site/rosters/v2/fo_trades.js"), "utf8");

test("every swap opens the one War Room route with give/get preloaded; partner links preload the partner", () => {
  t.ok(/FO\.warRoomUrl\(\{ twb_left_team: me, twb_right_team: f, twb_give: x\.give, twb_get: x\.get \}\)/.test(SRC), "swap → War Room with twb_give / twb_get");
  t.ok(/FO\.warRoomUrl\(\{ twb_left_team: me, twb_right_team: f \}\)/.test(SRC), "partner → War Room with the partner");
  t.ok(!/window\.open\(|location\.href\s*=/.test(SRC), "plain links (target=_top), no scripted navigation");
});

test("discovery, not a verdict: framing, checks and what isn't scored are on screen", () => {
  t.ok(/Discovery, not a fairness grade/.test(SRC));
  t.ok(/improve <b>both<\/b> teams’ best legal lineups/.test(SRC) || /both best legal lineups gain/.test(SRC), "both lineups must gain");
  for (const flag of ["over the cap", "not on last 4 wks", "IDP only", "small sample"]) t.ok(SRC.includes(flag), "check shown: " + flag);
  t.ok(/Not scored: contract length, salary value, age, draft picks, dynasty value/.test(SRC), "what the model ignores is said");
});

test("never sends anything; never uses this season before MFL has scored a week", () => {
  t.ok(!/fetch\(|method:\s*"POST"|XMLHttpRequest/.test(SRC), "no network write path in the view");
  t.ok(/if \(!ss\.seasonWeeks\.length\) \{ el\.innerHTML = H\.banner\("The Trade finder starts once MFL has scored a week this season\./.test(SRC), "preseason: says it starts after Week 1");
});

test("the need marker is a team's top two needs, not every position an upgrade would touch", () => {
  t.ok(/TF\.teamSummary\(m, f\)\.needs\.slice\(0, 2\)/.test(SRC));
  t.ok(/topNeeds\.indexOf\(g\) !== -1/.test(SRC));
});

await run("front_office_trade_finder");
