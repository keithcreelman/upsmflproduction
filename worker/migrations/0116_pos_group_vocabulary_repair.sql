-- ⚠️ THE "NEVER RUN migrations apply" WARNING BELOW IS OBSOLETE (2026-08-17).
--    The tracker was reconciled; `wrangler d1 migrations apply` is now correct.
--    See migrations/README.md. The old text is left intact below on purpose —
--    it was true when written.

-- 0116_pos_group_vocabulary_repair.sql
-- Claude 2026-08-04 — repairs nfl_player_weekly.pos_group to match the fixed
-- pos_group_of() in pipelines/etl/scripts/fetch_nflverse_weekly.py.
-- See docs/MODEL_RESEARCH_AND_DATA_AUDIT.md Appendix C (C1, C2).
--
-- ⚠️ APPLY WITH `wrangler d1 execute ups-mfl-db --remote --file=<this>`.
--    NEVER `wrangler d1 migrations apply` — the tracker is ~47 behind and
--    applying it corrupts contract data.
--
-- DATA-ONLY migration (no schema change). It rewrites an existing column, so
-- it is deliberately expressed as three narrow, independently-verifiable
-- UPDATEs rather than a full ETL re-run: the wide re-run would rewrite ~55
-- columns x 270k rows to change one.
--
-- ── 1. SAF → DB ───────────────────────────────────────────────────────────
-- nflverse spells safety "SAF", which was missing from the DB set in
-- pos_group_of(), so those rows fell through its terminal `return p` and were
-- stored as pos_group='SAF'. 6,772 rows league-wide; 1,545 in 2025 alone,
-- against 2,716 rows already labelled 'DB' — meaning any consumer filtering
-- pos_group='DB' silently lost 36% of all defensive backs. That includes the
-- Worker's own IDP filter (worker/src/index.js: pos === "idp" →
-- ['DL','LB','DB']), so Antoine Winfield, Kamren Curl, Grant Delpit, Camryn
-- Bynum, Malaki Starks et al were invisible to it.
UPDATE nfl_player_weekly SET pos_group = 'DB' WHERE pos_group = 'SAF';

-- ── 2. punters: PK → PN ───────────────────────────────────────────────────
-- pos_group_of() mapped position 'P' to 'PK', collapsing punters into kickers.
-- UPS scores them on completely different rules — PN pays PI *4 (four points
-- per punt inside the 20) plus an ANY net-average tier, PK pays FG *.1/yard
-- plus XP — so the two must be separable. src_weekly already carries PK and PN
-- as distinct groups; only this table conflated them.
-- The split is unambiguous: position='K' → 8,227 rows, position='P' → 8,120.
-- The Worker's punter filter was widened to ['PN','PK'] in the same commit, so
-- it works before, during and after this statement.
UPDATE nfl_player_weekly SET pos_group = 'PN' WHERE position = 'P';

-- ── 3. offensive line → OTHER ─────────────────────────────────────────────
-- The old terminal `return p` leaked raw nflverse labels into pos_group:
-- 15,015 rows of OT/G/C/LS/OL. The column looked like a controlled vocabulary
-- and was not. No consumer filters on these values (the Worker's alias map
-- accepts only skill/qb/idp/kicker/punter), so this is safe.
UPDATE nfl_player_weekly SET pos_group = 'OTHER'
 WHERE pos_group IN ('OT', 'G', 'C', 'LS', 'OL');

-- NOT TOUCHED, on purpose: ~308 rows whose pos_group is NULL/empty because
-- nflverse handed back no position at all. "Unknown" is not "other" — leaving
-- them NULL keeps the distinction legible downstream instead of burying an
-- absent input inside a real category.
--
-- ALSO NOT ADDRESSED HERE — and it cannot be, at this layer: pos_group is
-- NFLVERSE's positional view and does not always agree with MFL's. MFL calls
-- edge rushers DE where nflverse calls them LB (Brian Burns, Byron Young,
-- Jonathon Cooper, Micah Parsons — 830 player-weeks in 2025). UPS pays DL
-- tackles 1.5 and LB tackles 1.0, so any UPS scoring MUST key off the MFL
-- position (src_weekly.pos_group), never off this column.
