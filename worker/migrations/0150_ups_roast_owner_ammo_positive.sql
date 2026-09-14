-- 0150_ups_roast_owner_ammo_positive.sql
--
-- Optional positive counterpart to ups_roast_owner_ammo's discord_receipts_json
-- (migration 0147). That column is curated for ROASTING -- embarrassing,
-- roastable moments -- and must never be reused as a source of positivity (the
-- Therapy Bot's whole point is the opposite of the clap-back's).
--
-- positive_receipts_json is the same shape ([{quote, date, why}]) so
-- sync_owner_ammo_to_d1.py's existing round-trip needs no reshaping, but it
-- reads from a NEW "positive_receipts" array in owner_profiles.json (local,
-- gitignored, hand-curated by Keith) that starts empty for every owner. There
-- is no auto-mining here on purpose: an automated positive/negative sentiment
-- pass on real Discord history risks surfacing something backhanded or just
-- wrong, and this is a "make someone feel good" feature -- it only ever ships
-- what Keith hand-picked, exactly like discord_receipts_json already does for
-- roasting. Safe when absent: the therapy pipeline falls back to
-- ups_owner_career_stats alone (real, structured, already covers all 12
-- owners with something genuinely positive).

ALTER TABLE ups_roast_owner_ammo ADD COLUMN positive_receipts_json TEXT;
