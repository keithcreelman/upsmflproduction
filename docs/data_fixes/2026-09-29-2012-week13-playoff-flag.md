# 2012 Week 13 playoff flag correction (September 29, 2026)

**What was wrong.** 2012 Week 13 was the last regular-season week. MFL's 2012 league
(`L=37227`, www45) has `lastRegularSeasonWeek = 13`, and every 2012 playoff bracket starts
in Week 14. The local `mfl_database.db` flagged all 301 `weeklyresults` rows for 2012 Week 13
as `is_playoff = 1`, and `scripts/load_local_to_d1.py` copied that flag into D1. No other
season or week disagrees (checked every season 2010–2026 against MFL's `playoffBrackets`).

**What was changed** (`scripts/fix_2012_week13_playoff_flag.py --apply`, run 2026-09-30T01:54:28+00:00):

1. Local: a verified sqlite backup (`mfl_database.pre_2012wk13_playoff_fix_20260929_215428.db`, same row count, `quick_check` ok), then one
   transaction that had to touch exactly 301 rows or roll back.
2. D1: Time Travel restore point `0000e083-00000024-000050f6-3a9afd34187a39be18b157fc0782be25`, then one multi-statement command.
   D1 runs that atomically (probed first: a failing second statement rolled back the first).
3. Both sides re-read and verified; the full record is in
   `2026-09-29-2012-week13-playoff-flag.record.json`.

**Future loads cannot restore it.** The local source rows are fixed, and `load_local_to_d1.py`
now carries a `FIRST_POSTSEASON_WEEK` table (from MFL's brackets) and refuses to load
`schedule`, `franchise_weekly_score` or `league_season_meta` if any local week disagrees.
Against the corrected DB the guard passes and the loader's own SQL yields exactly the
corrected D1 values; against the old state it refused, naming only (2012, 13).

## Before / after

### `src_league_season_meta` (2012)

| Field | Before | After |
|---|---:|---:|
| `last_regular_season_week` | 12 | 13 |
| `reg_weeks` | 12 | 13 |
| `playoff_weeks` | 4 | 3 |
| `total_weeks` | 16 | 16 |

### `src_franchise_weekly_score` (2012 Week 13, 12 rows)

| Franchise | Score | `is_playoff` before | after |
|---|---:|---:|---:|
| 0001 | 109.6 | 1 | 0 |
| 0002 | 211.4 | 1 | 0 |
| 0003 | 169.5 | 1 | 0 |
| 0004 | 173.9 | 1 | 0 |
| 0005 | 158.1 | 1 | 0 |
| 0006 | 156.1 | 1 | 0 |
| 0007 | 197.1 | 1 | 0 |
| 0008 | 156.3 | 1 | 0 |
| 0009 | 165.5 | 1 | 0 |
| 0010 | 169.9 | 1 | 0 |
| 0011 | 166.2 | 1 | 0 |
| 0012 | 131.7 | 1 | 0 |

### `src_schedule` (2012 Week 13, 24 rows = 12 games, one row per side)

| Franchise | Opponent | Result | Score | `is_playoff` before | after |
|---|---|---|---|---:|---:|
| 0001 | 0003 | L | 109.6–169.5 | 1 | 0 |
| 0001 | 0007 | L | 109.6–197.1 | 1 | 0 |
| 0002 | 0006 | W | 211.4–156.1 | 1 | 0 |
| 0002 | 0011 | W | 211.4–166.2 | 1 | 0 |
| 0003 | 0001 | W | 169.5–109.6 | 1 | 0 |
| 0003 | 0005 | W | 169.5–158.1 | 1 | 0 |
| 0004 | 0010 | W | 173.9–169.9 | 1 | 0 |
| 0004 | 0012 | W | 173.9–131.7 | 1 | 0 |
| 0005 | 0003 | L | 158.1–169.5 | 1 | 0 |
| 0005 | 0010 | L | 158.1–169.9 | 1 | 0 |
| 0006 | 0002 | L | 156.1–211.4 | 1 | 0 |
| 0006 | 0008 | L | 156.1–156.3 | 1 | 0 |
| 0007 | 0001 | W | 197.1–109.6 | 1 | 0 |
| 0007 | 0009 | W | 197.1–165.5 | 1 | 0 |
| 0008 | 0006 | W | 156.3–156.1 | 1 | 0 |
| 0008 | 0011 | L | 156.3–166.2 | 1 | 0 |
| 0009 | 0007 | L | 165.5–197.1 | 1 | 0 |
| 0009 | 0012 | W | 165.5–131.7 | 1 | 0 |
| 0010 | 0004 | L | 169.9–173.9 | 1 | 0 |
| 0010 | 0005 | W | 169.9–158.1 | 1 | 0 |
| 0011 | 0002 | L | 166.2–211.4 | 1 | 0 |
| 0011 | 0008 | W | 166.2–156.3 | 1 | 0 |
| 0012 | 0004 | L | 131.7–173.9 | 1 | 0 |
| 0012 | 0009 | L | 131.7–165.5 | 1 | 0 |

Local `weeklyresults` 2012 Week 13: before `[[1, 301]]`, after `[[0, 301]]` (as [is_playoff, rows]).

## What else changed on the site

Live worker responses were captured before and after and diffed.

| Surface | Change |
|---|---|
| `/api/playoff-bracket?year=2012` | `playoff_weeks` `[13,14,15,16]` → `[14,15,16]`; the 24 Week 13 regular-season rows no longer show as playoff games. Everything else identical. |
| `/api/standings?year=2012` | `meta` 12/12/4 → 13/13/3; 36 weekly rows' `po` flag 1 → 0 (24 schedule + 12 score). Official rows (`src_standings`) identical. The page's Regular scope now matches MFL's official 2012 head-to-head record for all 12 teams (it was two games short for each). |
| `/api/hall-of-champions`, `/api/historical-finishes`, `/api/eras`, `/api/division-power-rankings` | No change. |
| `/api/standings?year=2013` (control) | No change. |
| Wire `HeadToHead.series()` | Bear Dunn v Chris Klingenberg 16–5 → **17–5** (postseason 1–2 → 0–2); Ryan Bousquet v Josh Martel 11–10 → **11–11** (2–2 → 2–1); Keith Creelman v Ryan Bousquet unchanged (4–16 / 3–1 from Keith's side). |
| Wire record book (top-10 regular-season single and combined scores) | No change. |
| `ups_owner_career_stats` | Not affected: career records come from `src_standings`. |

## Rollback

- Local: restore the backup file above over `mfl_database.db`.
- D1: `npx wrangler d1 time-travel restore ups-mfl-db --bookmark 0000e083-00000024-000050f6-3a9afd34187a39be18b157fc0782be25` (restores the whole DB to
  that point), or set the three values back with the inverse UPDATEs.

## Follow-ups not done here

- The nightly D1 job is not installed (no `com.upsmfl.d1-sync` LaunchAgent). The installed copy
  `~/Library/Scripts/upsmfl-load-local-to-d1.py` predates this guard and the nflverse guard. It
  would still load the corrected flag (it reads the fixed DB), but only the repo copy refuses a
  restored old backup. After merge, `scripts/install_d1_sync_cron.sh` refreshes the copy — and
  also installs the launchd job, so run it only if that is wanted.
- Older local backups (`mfl_database.pre_*.db`, including the one made here) still carry the bad
  flag; the guard refuses them.
- Week 3 article PR #1161 already shows the corrected series; its pack's `t.pv.games` still holds
  the two stale cells until that pack is rebuilt.
