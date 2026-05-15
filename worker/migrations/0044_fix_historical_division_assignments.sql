-- 0044 — Fix historical division assignments + recompute derived divisional stats.
--
-- Bug (discovered 2026-05-15 via direct MFL API diff vs D1):
--
--   The local mfl_database.db `franchises` table had wrong `division` values
--   for a handful of pre-2014 (season, franchise_id) rows. Those propagated to
--   D1 src_franchises via load_local_to_d1.py, which in turn made
--   src_schedule.is_divisional wrong for those games, which in turn made
--   src_standings.div_w / div_l / div_pct zero or off for all of 2011-2015.
--
-- Audit results (D1 vs MFL TYPE=league truth):
--   2011: fid 0002 had div=02 (D1), MFL says 03  → fix
--         fid 0003 had div=02 (D1), MFL says 03  → fix
--         fid 0006 had div=03 (D1), MFL says 02  → fix
--   2012: fid 0002 had div=02 (D1), MFL says 03  → fix
--   2013: fid 0002 had div=02 (D1), MFL says 03  → fix
--   2014, 2015, 2016+: all D1 rows match MFL — no row-level fixes needed,
--   but is_divisional / div_w / div_l were still all-zero for 2011-2015 due
--   to the original loader running before franchises had the divisions
--   populated. We recompute those derived fields below from MFL-correct
--   src_franchises rows.
--
-- This migration is idempotent: UPDATEs are no-ops if already applied.

-- ── Step 1 — fix the 5 known-wrong src_franchises rows ──
UPDATE src_franchises SET division = '03' WHERE season = 2011 AND franchise_id = '0002';
UPDATE src_franchises SET division = '03' WHERE season = 2011 AND franchise_id = '0003';
UPDATE src_franchises SET division = '02' WHERE season = 2011 AND franchise_id = '0006';
UPDATE src_franchises SET division = '03' WHERE season = 2012 AND franchise_id = '0002';
UPDATE src_franchises SET division = '03' WHERE season = 2013 AND franchise_id = '0002';

-- ── Step 2 — recompute is_divisional in src_schedule from corrected divisions ──
-- A schedule row is divisional iff both franchises belong to the same division
-- in src_franchises for that season. Recomputed for ALL seasons (cheap; one
-- pass; safe to re-run).
UPDATE src_schedule
   SET is_divisional = (
     SELECT CASE
              WHEN f1.division IS NOT NULL
               AND f2.division IS NOT NULL
               AND f1.division = f2.division
              THEN 1 ELSE 0
            END
       FROM src_franchises f1
       JOIN src_franchises f2
         ON f1.season = f2.season
      WHERE f1.season = src_schedule.season
        AND f1.franchise_id = src_schedule.franchise_id
        AND f2.franchise_id = src_schedule.opponent_franchise_id
   );

-- ── Step 3 — recompute div_w / div_l / div_pct in src_standings ──
-- Aggregate divisional wins/losses from corrected src_schedule (regular-season
-- only — playoff matchups can be against any division and don't count toward
-- divisional record).
UPDATE src_standings
   SET div_w   = COALESCE((SELECT SUM(CASE WHEN result = 'W' THEN 1 ELSE 0 END)
                             FROM src_schedule
                            WHERE season = src_standings.season
                              AND franchise_id = src_standings.franchise_id
                              AND is_divisional = 1
                              AND COALESCE(is_playoff, 0) = 0), 0),
       div_l   = COALESCE((SELECT SUM(CASE WHEN result = 'L' THEN 1 ELSE 0 END)
                             FROM src_schedule
                            WHERE season = src_standings.season
                              AND franchise_id = src_standings.franchise_id
                              AND is_divisional = 1
                              AND COALESCE(is_playoff, 0) = 0), 0),
       div_pct = COALESCE((SELECT
                             CAST(SUM(CASE WHEN result = 'W' THEN 1 ELSE 0 END) AS REAL)
                             / NULLIF(SUM(CASE WHEN result IN ('W','L','T') THEN 1 ELSE 0 END), 0)
                             FROM src_schedule
                            WHERE season = src_standings.season
                              AND franchise_id = src_standings.franchise_id
                              AND is_divisional = 1
                              AND COALESCE(is_playoff, 0) = 0), 0);
