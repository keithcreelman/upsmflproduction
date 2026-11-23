# Design note: play-by-play load record (#1503 D2)

**Status:** proposal for review (2026-11-23). Nothing is built, migrated or deployed. A migration needs Keith's go. The reader side is coordinated with Mobile Build (#1515) and is not settled until that session agrees.

## Problem
`pipelines/etl/scripts/fetch_nflverse_pbp.py` loads a season's nflverse play-by-play (`nflreadpy.load_pbp`) and writes per-player-week red-zone rows (`nfl_player_redzone`) and per-team-week rows (`nfl_team_weekly`). Nothing records which **games** that run contained.

A player-week with no red-zone row can therefore mean either of two things:
- **a true zero:** the game was loaded and the player had no red-zone plays; or
- **unknown:** the game was not in the file yet, or the run failed partway.

Today, #1515 infers coverage from `nfl_team_weekly.rz_pass_att` being present for the team-week. That works for Weeks 1–10 of 2026: Mobile Build checked 300 team markers and 2,923 player rows (#1503 comment 7099742471). But it is a side effect of another table, not a record of the load.

## Proposal: one row per team-week a run loaded

```sql
CREATE TABLE IF NOT EXISTS nfl_pbp_load_team_weeks (
  season        INTEGER NOT NULL,
  week          INTEGER NOT NULL,
  team          TEXT    NOT NULL,   -- same team codes as nfl_team_weekly
  game_id       TEXT    NOT NULL,   -- nflverse game_id
  plays_loaded  INTEGER NOT NULL,   -- play rows for this game in the loaded file
  game_final    INTEGER NOT NULL,   -- 1 when the file shows the game finished (see "To verify")
  loaded_at_utc TEXT    NOT NULL,   -- run time; ignored for change detection
  PRIMARY KEY (season, week, team)
);
```

- **Writer:** `fetch_nflverse_pbp.py`, in the same run, after its red-zone and team-weekly writes succeed. It uses `D1Writer` with `pk_cols=(season, week, team)` and `change_ignore_cols=["loaded_at_utc"]`, so an unchanged team-week writes 0 rows.
- **No write on failure:** a run that fails before this step writes no load row. That is the point: a missing load row means **unknown**.
- **Reader rule (the zero-row test):** for a player-week whose team is known from `nfl_player_weekly.team`:
  - load row present, `game_final = 1`, no red-zone row → **0, verified**;
  - load row present, `game_final = 0` → **in progress, not final**;
  - no load row → **unknown, not zero**.
- **Why team-week, not game:** the reader already has (season, week, team), so the lookup is one primary-key read. It needs no game join and no extra index. A bye week simply has no row.

## Cost (Free plan)
- **Writes:** about 32 team-week rows per week of games. With changed-only, a re-run writes only rows that changed (new games, a game becoming final, a corrected play count). Roughly 30–60 rows written per week of the season.
- **Reads, writer side:** one primary-key probe per row sent, about 32 per week loaded. A full-season reload sends about 550 rows (17 or 18 weeks × about 32).
- **Reads, reader side:** one primary-key read per team-week shown. Measured `rows_read` must be added to the PR before shipping (`docs/D1_QUERY_RULES.md`).
- **Backfill:** 2026 Weeks 1–10 (about 300 rows), from one local reload. This is a production write and needs Keith's go. Earlier seasons stay unknown unless Keith asks for them.

## To verify before building
- **Detecting a finished game:** which column in the nflverse play-by-play file reliably marks a finished game (candidate: a non-null final score on the last play). Check it against a game in progress at load time.
- **Team codes:** that the codes in the play-by-play file match `nfl_player_weekly.team` and `nfl_team_weekly.team` for every 2026 team, including relocated teams.
- **Ordering:** that the existing writes happen before this one, so a partial run cannot leave a load row without the data behind it.

## Migration path for #1515
- **Until the table exists:** #1515 keeps its current marker (`nfl_team_weekly.rz_pass_att`) and labels coverage "inferred".
- **After merge and backfill:** #1515 reads `nfl_pbp_load_team_weeks` by primary key and labels coverage "verified". The old marker stays as a fallback for seasons with no load rows, still labeled "inferred".

## Decisions needed (Keith, one at a time, later)
1. Approve the migration and writer change as a draft PR.
2. Approve the 2026 Weeks 1–10 backfill, a production write of about 300 rows.
