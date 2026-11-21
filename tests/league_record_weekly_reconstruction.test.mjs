// Local, read-only test of the historical weekly reconstruction (issue #1488). It needs a decompressed copy of the committed archive, named by LR_ARCHIVE_DB; without it the test prints SKIPPED
// (never PASSED), so a default run reads no database and makes no network call.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { test, run, t } from "./fixtures/mini_test.mjs";
import { reconstructWeekly, compareAllPlayFixture } from "../scripts/league_record/weekly/reconstruct_weekly.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dbPath = process.env.LR_ARCHIVE_DB;
if (!dbPath || !fs.existsSync(dbPath)) { console.log("league_record_weekly_reconstruction: SKIPPED (set LR_ARCHIVE_DB to a decompressed copy of data/db-archives/mfl_database_2026-06-05.db.gz)"); process.exit(0); }
const db = new DatabaseSync(dbPath, { readOnly: true });
const x = reconstructWeekly(db);
const fx = compareAllPlayFixture(db, JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "weekly_allplay_2010_2025.json"), "utf8")));
const S = (y) => x.seasons[y];

test("2012-2019: the original rows attribute every player-week to a franchise with starter/bench status, which the derived table lost", () => {
  for (const y of [2012, 2013, 2014, 2015, 2016, 2017, 2018, 2019]) {
    t.ok(S(y).player_rows > 4000, `${y} has per-player franchise rows`); t.ok(S(y).starter_rows > 2000 && S(y).bench_rows > 1500, `${y} has starters and bench`);
    t.equal(S(y).derived_rows_with_franchise, 0, `${y}: the derived table keeps no franchise (it writes 'FA')`);
  }
  for (const y of [2020, 2021, 2022, 2023, 2024, 2025]) t.ok(S(y).derived_rows_with_franchise > 5000, `${y}: the derived table is intact`);
});

test("reconciliation: starters add up to the team score, team scores equal the summary, player scores equal MFL, all-play equals the summary and the committed fixture", () => {
  for (const [y, s] of Object.entries(x.seasons)) {
    const yr = Number(y);
    t.ok(s.starter_sum_equals_team_score / s.franchise_weeks >= 0.96, `${y}: starter sums ${s.starter_sum_equals_team_score}/${s.franchise_weeks}`);
    if (yr !== 2010 && yr !== 2012 && yr !== 2025) t.equal(s.team_score_equals_summary, s.franchise_weeks_with_summary, `${y}: team score equals the summary`);
    if (yr >= 2011 && yr !== 2012 && yr !== 2025) t.equal(s.player_score_equals_mfl, s.player_rows_with_mfl_score, `${y}: every player score equals MFL's per-player score`);
    if (yr !== 2010) t.equal(s.allplay_recomputed_equals_summary, s.allplay_compared, `${y}: all-play recomputed from team scores equals the summary`);
    t.equal(fx[y].allplay_wins_equal, fx[y].compared, `${y}: all-play equals the committed fixture`);
  }
  // 2010: the summary table is itself contaminated in weeks 1-6, so it disagrees with the self-consistent rows (reported, not hidden)
  t.equal(S(2010).starter_sum_equals_team_score, 176); t.equal(S(2010).team_score_equals_summary, 168); t.equal(S(2010).allplay_recomputed_equals_summary, 126);
  // 2013-2016: the seasons the earlier analysis called unavailable
  t.equal([2013, 2014, 2015, 2016].reduce((a, y) => a + S(y).starter_sum_equals_team_score, 0), 734); t.equal([2013, 2014, 2015, 2016].reduce((a, y) => a + S(y).franchise_weeks, 0), 736);
});

test("defects in the original rows are found and reported, never repaired or zero-filled", () => {
  const kinds = (k) => x.defects.filter((d) => d.kind === k);
  // 2012: weeks 13 and 14 have no per-player rows (week 13 team totals exist in `schedule`), and week 15 is a copy of week 16
  t.deepEqual(S(2012).weeks_missing, [13, 14]); t.deepEqual(S(2012).duplicate_of_next_week, [15]);
  t.ok(kinds("week_missing_from_weekly_results").some((d) => d.season === 2012 && d.week === 13 && d.schedule_franchise_rows === 12));
  // 2010 weeks 1-6: franchise-weeks with a second team-score group; the group equal to the summary can be identified in every one
  const c = kinds("franchise_week_has_several_team_scores");
  t.equal(c.length, 24); t.ok(c.every((d) => d.season === 2010 && d.week <= 6 && d.self_consistent_group_identified), "every contaminated franchise-week has exactly one self-consistent group");
  t.equal(S(2010).contaminated_rows, 131, "131 stale rows (24 groups) are set aside by the self-consistency rule (matching the contaminated summary instead would discard the wrong group in 8 franchise-weeks)");
  t.ok(c.filter((d) => !d.summary_agrees_with_kept_group).length > 0, "the summary table disagrees with the self-consistent group in some of them, so it cannot arbitrate");
  // playoff weeks without the bye franchises (all seasons except 2019 and 2025); 2010's playoff weeks are not flagged
  t.ok(kinds("playoff_week_missing_franchises").every((d) => d.season !== 2019 && d.season !== 2025)); t.equal(kinds("playoff_week_not_flagged").filter((d) => d.season === 2010).length, 3);
  // regular-season opponents: named for 2012 and 2020-2025 only
  for (const y of [2010, 2011, 2013, 2014, 2015, 2016, 2017, 2018, 2019]) t.equal(S(y).regular_season_with_opponent, 0, `${y}: no regular-season opponent recorded`);
  for (const y of [2012, 2020, 2021, 2022, 2023, 2024, 2025]) t.equal(S(y).regular_season_with_opponent, S(y).regular_season_franchise_weeks, `${y}: every regular-season opponent recorded`);
  // nothing is synthesized: the reconstruction's row count equals the source table's
  for (const [y, s] of Object.entries(x.seasons)) t.equal(s.player_rows, db.prepare("select count(*) n from weeklyresults where season = ?").get(Number(y)).n, `${y}: rows are the source rows, no more`);
});

await run("league_record_weekly_reconstruction");
db.close();
