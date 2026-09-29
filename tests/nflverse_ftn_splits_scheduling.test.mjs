// nflverse_ftn / nflverse_splits joined the recurring refresh; PFR season-
// level advanced stats deliberately did NOT (2026-09-29).
//
// THE AUDIT (Keith's instruction: don't schedule just because a script
// exists -- show what current-season data it can actually provide):
//   fetch_nflverse_ftn.py     -> nflreadpy.load_ftn_charting(seasons=[2026])
//                                returned 8,065 rows through week 3 live on
//                                2026-09-29 -> 394 real (season,gsis) rows.
//                                Genuinely live source. SCHEDULED.
//   fetch_nflverse_splits.py  -> nflreadpy.load_pbp(seasons=[2026]) (same
//                                source nflverse_pbp already pulls) ->
//                                1,502 real (season,gsis,bucket) rows live
//                                on 2026-09-29. Genuinely live source.
//                                SCHEDULED.
//   fetch_pfr_season_advstats.py -> nflverse-data's pfr_advstats release
//                                CSVs (advstats_season_{pass,rec,rush,def})
//                                show 2025 as the newest season present, as
//                                of 2026-09-29 -- genuinely no 2026 data to
//                                fetch, confirmed by downloading the actual
//                                release files, not by re-reading old notes.
//                                NOT SCHEDULED.
//
//   node tests/nflverse_ftn_splits_scheduling.test.mjs
import fs from "fs";
import assert from "assert";

const WF = fs.readFileSync(".github/workflows/nflverse-stats-refresh.yml", "utf8");
const FTN_SRC = fs.readFileSync("pipelines/etl/scripts/fetch_nflverse_ftn.py", "utf8");
const SPLITS_SRC = fs.readFileSync("pipelines/etl/scripts/fetch_nflverse_splits.py", "utf8");
let fails = 0;
const check = (n, fn) => { try { fn(); console.log("  ok   " + n); }
  catch (e) { fails++; console.log("  FAIL " + n + "\n         " + e.message); } };

console.log("1. the two genuinely-live sources are now scheduled");
check("nflverse_ftn is run in the refresh workflow", () => {
  assert.match(WF, /run nflverse_ftn\s+"\$\{STATS_SEASONS\}"\s+python3 \.\.\/pipelines\/etl\/scripts\/fetch_nflverse_ftn\.py/);
});
check("nflverse_splits is run in the refresh workflow", () => {
  assert.match(WF, /run nflverse_splits\s+"\$\{STATS_SEASONS\}"\s+python3 \.\.\/pipelines\/etl\/scripts\/fetch_nflverse_splits\.py/);
});
check("both use --skip-local, matching every other current-season nflverse fetcher here", () => {
  const ftnLine = WF.match(/run nflverse_ftn[^\n]+/)[0];
  const splitsLine = WF.match(/run nflverse_splits[^\n]+/)[0];
  assert.ok(/--skip-local/.test(ftnLine));
  assert.ok(/--skip-local/.test(splitsLine));
});

console.log("\n2. pfr_advstats (weekly, already scheduled) is unaffected; the SEASON-level script stays out");
check("the existing weekly pfr_advstats run is untouched", () => {
  assert.match(WF, /run pfr_advstats\s+"\$\{STATS_SEASONS\}"\s+python3 \.\.\/pipelines\/etl\/scripts\/fetch_pfr_advstats\.py/);
});
check("fetch_pfr_season_advstats.py is NOT actually RUN anywhere in this workflow", () => {
  // The filename is expected to appear in the explanatory comment below
  // (documenting the decision) -- only an actual `run` invocation is banned.
  assert.ok(!/run \S+\s+"\$\{STATS_SEASONS\}"\s+python3 \.\.\/pipelines\/etl\/scripts\/fetch_pfr_season_advstats\.py/.test(WF),
    "scheduling this would be a guaranteed no-op all season -- nflverse's own release has no 2026 rows yet");
});
check("the exclusion is documented, not silently omitted (guards against someone reflexively adding it back)", () => {
  assert.match(WF, /DELIBERATELY NOT\s*\n?\s*# scheduled here/,
    "a future edit that adds this back should have to explain why the 2026-09-29 evidence no longer applies");
});

console.log("\n3. both newly-scheduled scripts fail closed correctly (exit 3, not a hard failure) when their source is genuinely empty");
check("fetch_nflverse_ftn.py exits 3 on zero rows, not a bare sys.exit(string) (=exit 1)", () => {
  assert.match(FTN_SRC, /if not rows:\s*\n(?:[^\n]*\n)*?\s*sys\.exit\(3\)/,
    "exit 1 here would fail the whole refresh job over one legitimately-empty source and block the leaderboard rebuild (gated on conclusion == success)");
  assert.ok(!/sys\.exit\("no rows"\)/.test(FTN_SRC), "the old exit-1 form must be gone, not just supplemented");
});
check("fetch_nflverse_splits.py exits 3 on zero rows, not a bare sys.exit(string) (=exit 1)", () => {
  assert.match(SPLITS_SRC, /if not rows:\s*\n(?:[^\n]*\n)*?\s*sys\.exit\(3\)/);
  assert.ok(!/sys\.exit\("no rows"\)/.test(SPLITS_SRC));
});

console.log("\n4. the refresh job's run() wrapper already treats exit 3 as ok, not FAILED (unchanged, re-asserted here for this pair)");
check("run() stamps not_published (not error) on exit code 3", () => {
  assert.match(WF, /elif \[ "\$\{rc\}" = "3" \]; then echo "\$\{src\}: not published yet"; stamp "\$\{src\}" not_published/);
});
check("exit 3 does not set FAILED=1", () => {
  const i = WF.indexOf('elif [ "${rc}" = "3" ]');
  const line = WF.slice(i, WF.indexOf("\n", i));
  assert.ok(!/FAILED=1/.test(line));
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
