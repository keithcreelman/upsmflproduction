-- Phase 3 migration 0004: surface win_chunks on src_weekly.
--
-- Per-week win-chunks is the z-score–derived "chunks of winning" count
-- computed upstream by the scoring pipeline (see player_weeklyscoringresults.win_chunks
-- in the local mfl_database.db). We expose it for Worker-side aggregation
-- (e.g. career_summary.win_chunks = SUM(win_chunks) per season, then multiplied by
-- the positional leverage coefficient to produce Win Chunks Normalized).
--
-- Added here rather than in 0002 to avoid a full reload pre-migration — the
-- loader plan update that follows will re-insert this column on the next
-- weekly sync (~30 min).

ALTER TABLE src_weekly ADD COLUMN win_chunks REAL;
