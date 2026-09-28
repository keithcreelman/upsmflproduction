// Stats Workbench — season default + freshness display.
//   node tests/stats_workbench_season_default.test.mjs
//
// THE DEFECT (reported 2026-09-28): a fresh visit to Stats Workbench defaulted
// to THIS_YEAR-1 (2025) unconditionally — hardcoded since the page's creation
// on 2026-04-23, true preseason, when "last completed season" was the only
// sane default. Never revisited once 2026 kicked off, so the page never even
// looked at the current season unless a user manually changed the dropdown.
// Source-text assertions, matching the convention in
// tests/ladder_single_implementation.test.mjs — this file is a large
// DOM-bound page script, not something to load whole in Node.
import fs from "fs";
import assert from "assert";

const HTML = fs.readFileSync("site/stats_workbench/stats_workbench.html", "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

console.log("season default");
check("defaultSeason is THIS_YEAR, not THIS_YEAR - 1", () => {
  const i = HTML.indexOf("Seasons multi-select");
  assert.ok(i > 0, "the Seasons multi-select block must exist");
  const block = HTML.slice(i, i + 900);
  assert.match(block, /var defaultSeason = THIS_YEAR;/,
    "a fresh visit must default to the current season, not last year's");
  assert.ok(!/var defaultSeason = THIS_YEAR - 1;/.test(block),
    "the hardcoded THIS_YEAR-1 default must be gone");
});
check("no season value is persisted to localStorage/sessionStorage (a stale saved value could hold a fresh visit on 2025 forever)", () => {
  const i = HTML.indexOf("Seasons multi-select");
  const j = HTML.indexOf("Live MFL ownership", i);
  const block = HTML.slice(i, j > i ? j : i + 2000);
  assert.ok(!/localStorage|sessionStorage/.test(block),
    "the season selector must not read/write browser storage — see feedback_no_default_substitution");
});
check("an explicit URL season selection still overrides the default (readStateFromUrl)", () => {
  assert.match(HTML, /function readStateFromUrl\(/, "URL-state restore must still exist");
});

console.log("\nfreshness display (data-through week)");
check("the leaderboard fetch stashes built_for_week / authoritative_week / stale from the API response", () => {
  assert.match(HTML, /state\.lastBuiltForWeek\s*=/);
  assert.match(HTML, /state\.lastAuthoritativeWeek\s*=/);
  assert.match(HTML, /state\.lastStale\s*=/);
});
check("the meta line surfaces \"finalized through Week N\" for the current season", () => {
  assert.match(HTML, /finalized through Week/);
});
check("static/offseason coverage messages are untouched (this is additive, not a replacement)", () => {
  assert.match(HTML, /hasn.t started — showing no rows yet/);
  assert.match(HTML, /top 500 by yardage/);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
