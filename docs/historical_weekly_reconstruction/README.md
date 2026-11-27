# Historical weekly reconstruction (local, read-only)

Issues: #1488 (weekly results), #1486 (register). **Draft. Nothing here is loaded into D1, deployed or merged.** It is an evidence tool: it reads a decompressed copy of the committed league archive, reconciles it, and writes a summary outside the repository.

> **Plain English.** MFL's original weekly results still say, for every season 2010–2025, which franchise each player was on and whether he started. The site's derived tables lost that for 2012–2019 and show those players as free agents. Rebuilt straight from the original rows, the scores match MFL's own scores almost perfectly. This change measures that, and records exactly where the original rows are wrong, duplicated or incomplete. It never repairs, fills or zero-fills a row.

## 1. Which original records carry franchise attribution and starter/bench status

`weeklyresults` in `data/db-archives/mfl_database_2026-06-05.db.gz` is MFL's own weekly-results export: **one row per player, franchise and week**.

| Column | Meaning |
|---|---|
| `season`, `week`, `franchise_id`, `player_id` | whose player, which week |
| `status` | `starter` or `nonstarter` (bench) |
| `player_score`, `team_score` | the player's points; the franchise's team total that week |
| `team_opt_pts`, `should_start` | MFL's optimal-lineup points and whether the player belonged in the optimal lineup |
| `result`, `is_home`, `is_playoff` | `W`/`L`/`T`, or `BYE` (see §6), home side, playoff flag |

Rows per season: 2010 3,083 · 2011 4,198 · 2012 4,054 · 2013 4,657 · 2014 4,681 · 2015 4,720 · 2016 4,708 · 2017 4,696 · 2018 5,414 · 2019 5,693 · 2020 5,469 · 2021–2025 5,809 / 5,809 / 5,834 / 5,808 / 6,073.

## 2. How the existing ETL lost it (INFERRED, not confirmed)

The derived tables `player_weeklyscoringresults`, `weekly_player_scores` and `player_pointssummary` take the franchise (`roster_franchise_id`) and status from `rosters_weekly`, not from `weeklyresults`.

- `rosters_weekly` has **no rows for 2012–2016**. For 2017–2019 it has rows, but the derived table still writes the literal `FA` for every player-week: **0 derived rows carry a franchise for any season 2012–2019** (2010, 2011 and 2020–2025 are intact). The data is consistent with a build that ran before the 2017–2019 snapshots existed and was never re-run.
- **No builder for these tables exists in any branch** I could search, so the cause cannot be confirmed from code, and the table cannot be simply re-run. Status: **INFERRED.**
- Pre-2020 `rosters_weekly` looks unreliable as an attribution source anyway: an earlier review measured 2017 week 1 at only 104 of 180 starters on the franchise `weeklyresults` names (**not re-derived in this change**).

**Consumers that inherit the gap** (they read the derived table; whether each uses the franchise column is not verified here): `scripts/load_local_to_d1.py:403` (D1 `src_weekly`) and `:439` (`src_pointssummary`), `pipelines/etl/scripts/build_roster_points_history_json.py`, `build_rookie_draft_hub.py`, `rookie_draft_bridge.py`, `build_acquisition_hub_artifacts.py`, `rank_pending_1307.py`, `build_faa_report.py`, `build_tag_tracking.py`, `build_player_scoring_report.py`, and the generated `site/rosters/player_points_history.json`.

**Separate latent defect:** `scripts/load_local_to_d1.py:747-753` loads `SELECT DISTINCT season, week, franchise_id, team_score, …` from `weeklyresults`. Where a franchise-week has two score groups (2010 weeks 1–6, §5) both rows are loaded and the last one wins.

## 3. Why rebuild from `weeklyresults` rather than repair or extend the derived tables

1. **The derived tables have no builder**, so a repair would mean writing one anyway, and its attribution input (`rosters_weekly`) is missing or unreliable for 2012–2019.
2. **`weeklyresults` is the original export** with attribution, status and totals in one row, and it can be checked against three independent tables (§4).
3. **A repaired derived table would be a copy of the same data**, and a test passing against it would not be evidence. Reading the original rows keeps provenance and lets defects stay visible.
4. **Nothing is destroyed.** The tool changes no table. A later, separately approved load would replace the feed at `load_local_to_d1.py:403/439` and fix `:747-753`.

## 4. Reconciliation (all from the committed archive; each check uses an independent table)

(a) starters' scores sum to the team score of the same rows · (b) that team score equals `weeklyresults_summary` · (c) each player score equals MFL's `playerscores_weekly` · (d) all-play recomputed from team scores equals the summary and the committed fixture.

| Season | Rows | (a) | (b) | (c) | (d) all-play | Notes |
|---|---|---|---|---|---|---|
| 2010 | 3,083 | 176/176 | **168/176** | 2,314/2,400 | **126/156** | stale groups, summary contaminated (§5) |
| 2011 | 4,198 | 184/184 | 184/184 | 3,650/3,650 | 156/156 | |
| 2012 | 4,054 | 160/160 | **152/160** | **3,324/3,502** | 144/144 | weeks 13–14 absent, week 15 = copy of 16 (§6) |
| 2013–2015 | 14,058 | 552/552 | 552/552 | 11,968/11,968 | 468/468 | |
| 2016 | 4,708 | 182/184 | 184/184 | 4,037/4,037 | 156/156 | 2 rounding steps (§7) |
| 2017 | 4,696 | 184/184 | 184/184 | 4,075/4,075 | 156/156 | |
| 2018 | 5,414 | 178/184 | 184/184 | 4,685/4,685 | 156/156 | 6 rounding steps |
| 2019 | 5,693 | 190/192 | 192/192 | 4,861/4,861 | 156/156 | 2 rounding steps |
| 2020 | 5,469 | 184/184 | 184/184 | 4,765/4,765 | 156/156 | |
| 2021 | 5,809 | 192/196 | 196/196 | 5,015/5,015 | 168/168 | 4 rounding steps |
| 2022–2023 | 11,643 | 392/392 | 392/392 | 10,028/10,028 | 336/336 | |
| 2024 | 5,808 | 194/196 | 196/196 | 5,055/5,055 | 168/168 | 2 rounding steps |
| 2025 | 6,073 | 204/204 | **201/204** | **5,295/5,299** | 168/168 | 3 franchise-weeks and 4 player rows differ (§7) |

Seasons 2013–2016 were previously called unavailable for franchise attribution: they reconcile at 734/736 starter sums (the two exceptions are rounding), and 100% of team and player scores.

## 5. The stale 2010 scoring groups (weeks 1–6)

24 franchise-weeks carry **two** team-score groups in `weeklyresults` (131 rows in the stale groups), in weeks 1–6 only. **Rule used: keep the group whose starters add up to its own team score.** It identifies exactly one group in all 24. The `weeklyresults_summary` table cannot arbitrate: it is itself contaminated in 8 of these franchise-weeks (picking by the summary would discard the wrong group there). That is why 2010 shows (b) 168/176 and (d) 126/156 against the summary.

Independent corroboration (the rule used starter sums only): in the raw rows 42 players appear on two franchises in the same 2010 week; **after setting the stale groups aside, 0 do.** Every other season has none. The rows set aside stay in the archive; they are reported, not deleted.

## 6. 2012 weeks 13–15, playoff byes, duplicates and incomplete weeks

| Item | Evidence | Status |
|---|---|---|
| 2012 weeks 13 and 14 have **no per-player rows** in the archive | the archive's `schedule` has team totals for week 13 (12 franchises) and week 14 (8) | **UNRESOLVED in the archive** |
| 2012 week 15 rows are **identical to week 16's** | row-signature comparison; 8 franchise-weeks disagree with the second source | defect, reported |
| A newer local ETL database copy has 2012 weeks 13–15 for all 12 franchises | every franchise-week is self-consistent (12/12 each), and its team scores equal the archive's own `schedule` totals in every franchise-week (12/12, 8/8, 12/12) | **PROBABLE.** Independent corroboration, but the copy's provenance (how and when it was fetched) is not recorded. A load needs Keith's approval and a recorded hash. |
| **Playoff byes:** the archive lacks bye franchises in playoff weeks of every season except 2019 and 2025 | the same newer copy carries those franchises with MFL's own `result = BYE`, their lineups and scores. From 2011 on (apart from 2012 weeks 13–15, where the archive itself has no or duplicated rows), **every franchise-week only the newer copy has is marked BYE by MFL** (not inferred from standings), and in every overlapping franchise-week its team scores equal the archive's (0 differences) | **PROBABLE** for the identities, same provenance caveat |
| **The newer copy is not reliable everywhere:** its 2010 playoff weeks 14–16 disagree with the archive in every overlapping franchise-week and equal the archive's `schedule` in none (the archive equals it in all) | per-week comparison in the summary | the copy **cannot be adopted wholesale**; each week must be validated |
| Regular-season **opponent pairings** exist only for 2012 and 2020–2025 | `weeklyresults_summary` and `schedule` | **UNRESOLVED** 2010–2011, 2013–2019 (repo docs say MFL never exported them; unverified) |
| 2010 playoff weeks are not flagged `is_playoff` | 3 weeks | reported |

## 7. Remaining attribution exceptions (all itemized in the tool's output)

- **16 franchise-weeks (of 2,988) where starters differ from the team score**, all by exactly ±0.1 (2016, 2018, 2019, 2021, 2024). The summary table agrees with the team score every time, so these are rounding in MFL's per-player scores, not misattribution.
- **2025:** 3 franchise-weeks differ between `weeklyresults` and the summary, and `schedule` week 17 differs in 3 franchise-weeks; both databases agree on the `weeklyresults` values (0 differences), so the source of the difference is **UNRESOLVED** (a later stat correction is a hypothesis, not a finding).
- **2012 player rows:** 178 of 3,502 per-player scores differ from MFL's `playerscores_weekly`; they sit in the duplicated week 15.
- Rows where MFL's per-player table has no row and the player score is 0 are counted, not treated as errors (MFL's table leaves out zero-point rows).

## 8. Evidence status

| Statement | Status |
|---|---|
| Original rows carry franchise and starter/bench for every season 2010–2025 | **CONFIRMED** (direct rows; reconciled with `weeklyresults_summary`, `playerscores_weekly` and `schedule`, none of which is derived from the same copy) |
| 2013–2016 attribution is available | **CONFIRMED** (734/736 starter sums, 100% team and player scores) |
| The derived tables lost attribution because they were built without the 2012–2019 snapshots | **INFERRED** (no builder to read) |
| 2010 weeks 1–6 keep-rule | **PROBABLE** (self-consistent in 24/24, corroborated by 42 → 0 two-franchise players; no independent 2010 source yet) |
| 2012 weeks 13–15 and bye identities from the newer copy | **PROBABLE** (see §6) |
| Opponent pairings 2010–2011, 2013–2019 | **UNRESOLVED** |

Nothing is promoted to CONFIRMED because a test passes against a derived copy of the same data.

## 9. Tests and safeguards against touching unrelated work

- `tests/league_record_weekly_reconstruction.test.mjs`: needs a local archive copy (`LR_ARCHIVE_DB`); prints **SKIPPED**, never PASSED, without it. 169 assertions on the figures above. An optional block (`LR_SECOND_DB`) covers the second source.
- `tests/league_record_weekly_safeguards.test.mjs` runs in the default safe suite with no database: the weekly code mentions **no transaction, draft-pick or contract table**, issues **no write statement**, opens every database **read-only**, refuses an output folder inside the repository, and has no network, process or secret access. The change is limited to `scripts/league_record/weekly/`, two test files and this folder; it edits no existing file.
- This work is **independent of draft-pick lineage (#1484) and transaction work**: pick slots come only from MFL draft results, never from standings or weekly results, and nothing here feeds them.

## 10. Run it (local, read-only)

```bash
gunzip -k -c data/db-archives/mfl_database_2026-06-05.db.gz > /path/outside/repo/archive.db
node scripts/league_record/weekly/run_reconstruct_weekly.mjs --db /path/outside/repo/archive.db [--second-db /path/to/newer_local.db]
LR_ARCHIVE_DB=/path/outside/repo/archive.db node tests/league_record_weekly_reconstruction.test.mjs
```

The summary (`weekly_reconstruction_summary.json`, with the sha256 of each database) is written beside the archive copy.

## 11. Not in this change

Any load into D1, replacement of `load_local_to_d1.py:403/439` or `:747-753`, a regenerated all-play fixture (the committed fixture copies the summary, so it inherits the 2010 contamination and lacks 2012 week 13), a rebuilt derived layer, and any use of the newer database beyond the report. Each needs separate approval.
