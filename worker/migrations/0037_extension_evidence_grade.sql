-- 0037_extension_evidence_grade.sql
-- Adds provenance columns to ups_extension_master so the historical
-- backfill can mark each row's confidence level + source. The user
-- walks the "derived" + "parking_lot" rows post-backfill, upgrading
-- them to "evidenced" as forum / Discord / manual evidence is
-- located.
--
-- Grades:
--   • 'evidenced'   — high-confidence source (worker audit log,
--                     dispatch payload, Discord announcement,
--                     forum thread, manual entry)
--   • 'derived'     — reconstructed via event-chain logic
--                     (player_acquisition_cycles with
--                     contract_type_at_acquisition='extension')
--   • 'parking_lot' — MFL salary export shows an EXT-flavored
--                     status but no audit trail exists; needs
--                     human review before being trusted
--
-- Same columns added to ups_tag_master for parity (tags will
-- benefit from the same grading when we backfill those too).

ALTER TABLE ups_extension_master ADD COLUMN evidence_grade  TEXT;
ALTER TABLE ups_extension_master ADD COLUMN evidence_source TEXT;

ALTER TABLE ups_tag_master       ADD COLUMN evidence_grade  TEXT;
ALTER TABLE ups_tag_master       ADD COLUMN evidence_source TEXT;

-- Query helper: parking-lot review pulls every uncertain row in one shot.
CREATE INDEX IF NOT EXISTS idx_ext_master_grade ON ups_extension_master(evidence_grade, season);
CREATE INDEX IF NOT EXISTS idx_tag_master_grade ON ups_tag_master(evidence_grade, season);
