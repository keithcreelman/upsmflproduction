-- 0031_allplay_historical_hybrid.sql
-- Adds a 4th AP-metric triplet: "historical" (hybrid).
--
-- Definition (Keith 2026-05-09):
--   - Seasons 2010-2016: historical = regseason only (W1-13). This was the
--     league's manually-recorded AP convention in those years.
--   - Seasons 2017+: historical = full (regseason + playoff). This is when
--     the league switched conventions (also when weekly top-scorer prize
--     enforced lineup submission).
--
-- This column lets analytics query the league-canonical AP record across
-- the full historical span without rebranding the rule mid-query.
--
-- All AP-metric values (regseason, playoff, full, historical) for ALL
-- years are populated from MFL's authoritative O=101 (Power Rankings /
-- All-Play Standings) endpoint, NOT from local weeklyresults.team_score.
-- This corrects 2010 specifically, where our local weeklyresults differs
-- from MFL due to lineup-submission gap weeks.

ALTER TABLE src_standings ADD COLUMN allplay_historical_w INTEGER;
ALTER TABLE src_standings ADD COLUMN allplay_historical_l INTEGER;
ALTER TABLE src_standings ADD COLUMN allplay_historical_t INTEGER;
