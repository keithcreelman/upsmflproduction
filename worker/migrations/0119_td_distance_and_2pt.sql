-- ⚠️ THE "NEVER RUN migrations apply" WARNING BELOW IS OBSOLETE (2026-08-17).
--    The tracker was reconciled; `wrangler d1 migrations apply` is now correct.
--    See migrations/README.md. The old text is left intact below on purpose —
--    it was true when written.

-- 0119_td_distance_and_2pt.sql
-- Claude 2026-08-04 — Phase 0, Appendix C items C10 and C12.
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — tracker ~47 behind, corrupts contracts.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- C10 — TOUCHDOWN DISTANCE TIERS
-- ═══════════════════════════════════════════════════════════════════════════
-- UPS pays 7 points instead of 6 for a touchdown of 50+ yards, on EVERY TD
-- code: PS (pass), RS (rush), RC (reception), PR (punt return), KO (kickoff
-- return), IR (interception return), FR (fumble return), DR, MF. The weekly
-- box-score feed carries only TD COUNTS, so the bonus was invisible.
--
-- Worked example that pinned it: Jordan Addison, 2025 wk17 — UPS awarded 13.7
-- on one rush for 65 yards and no receptions. 65*0.1 = 6.5, plus 7.0 (the TD
-- was 65 yards, so the 50-110 tier), plus 0.2 (first down) = 13.7 exactly.
-- Crediting it at 6 loses a point every time.
--
-- Measured scale on 2025 skill positions: 51 player-weeks carry a +1.0 residual
-- (38 receiving + 25 rushing TDs of 50+ yards).
--
-- DISTANCE FIELD — this is the subtle part. For offensive TDs the distance is
-- pbp.yards_gained. For RETURN TDs it is pbp.return_yards; yards_gained is 0 on
-- kickoff returns, which is why an initial `yards_gained >= 50` check reported
-- ZERO 50+ return TDs. Verified: all 6 kickoff return TDs in 2025 REG are 50+
-- (90/95/97/98/99/100 yds), as are 14 of 15 punt return TDs.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- KICKOFF RETURN TDs — and a correction to migration 0117
-- ═══════════════════════════════════════════════════════════════════════════
-- nflverse has NO kickoff_return_tds column. Only `special_teams_tds`, which is
-- a mixed bucket (2025: WR 16 / RB 4 / CB 3 / DE 3 / DT 1 / SAF 1 — the
-- defensive entries are blocked-kick and muffed-punt recoveries UPS scores
-- under BLF/BLP/FR). PBP is the only source.
--
-- ⚠️ CORRECTION: migration 0117 mapped `punt_return_tds` from nflverse
-- `pt_return_tds`. That was WRONG. The `pt_*` block is the PUNTER's stat line
-- (pt_att / pt_yards / pt_net_yards / pt_returned / pt_return_tds), so
-- pt_return_tds is TDs the punter ALLOWED — it appears on position 'P' rows and
-- nowhere else. Crediting it as a return TD would have paid punters 6-7 points
-- for giving up a return touchdown. No published figure was affected (skill and
-- IDP rows carry NULL there, so it contributed 0 to every reconstruction run),
-- but the stored values are wrong.
--
-- Fix: `punt_return_tds` becomes PBP-OWNED and RETURNER-credited. The bad
-- values are cleared below and the alias is removed from PLAYERSTATS_MAP.
-- Note that `punt_returns` / `punt_return_yards` were NOT affected — those are
-- genuinely the returner's columns (2025: WR 774, CB 47, RB 33 …), and their
-- league totals coincide with the punter-side `pt_returned` / `pt_return_yards`
-- only because every returned punt is counted once from each side.
ALTER TABLE nfl_player_weekly_ext ADD COLUMN pass_tds_50plus     INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN rush_tds_50plus     INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN rec_tds_50plus      INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN punt_ret_tds_50plus INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN kick_ret_tds        INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN kick_ret_tds_50plus INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN def_ret_tds_50plus  INTEGER;

-- Clear the mis-sourced punter-allowed values so the PBP backfill can own the
-- column. Left NULL rather than 0: nothing has been measured yet, and an
-- unmeasured input must not read as a measured zero.
UPDATE nfl_player_weekly_ext SET punt_return_tds = NULL;

-- ═══════════════════════════════════════════════════════════════════════════
-- C12 — RUSHING / RECEIVING TWO-POINT CONVERSIONS (R2 / C2 = *2)
-- ═══════════════════════════════════════════════════════════════════════════
-- pass_2pt was already mapped; the rushing and receiving sides never were.
-- Measured scale on 2025 skill positions: 51 player-weeks carry a +2.0
-- residual. Both columns exist natively in nflverse load_player_stats
-- (rushing_2pt_conversions ~17/season, receiving_2pt_conversions ~43/season),
-- so unlike C10 this needs no PBP scan.
ALTER TABLE nfl_player_weekly_ext ADD COLUMN rush_2pt INTEGER;
ALTER TABLE nfl_player_weekly_ext ADD COLUMN rec_2pt  INTEGER;
