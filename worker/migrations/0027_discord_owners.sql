-- 0027_discord_owners.sql
--
-- Canonical mapping of Discord users → MFL franchises. Mirrors the
-- `discord_accountdetails` table from the local mfl_database.db so the
-- worker can seed rounds and look up active owners without round-tripping
-- to the laptop.
--
-- `active_owner` follows the source-of-truth convention from the local
-- DB: 'Y' = currently plays in the league, 'N' = retired/replaced.
-- Round seeds should pull WHERE active_owner = 'Y'.
--
-- Re-running this migration is safe: the table uses CREATE IF NOT EXISTS
-- and inserts go through INSERT OR REPLACE in the data-loader script.

CREATE TABLE IF NOT EXISTS discord_owners (
  discord_user_id   TEXT PRIMARY KEY,
  discord_username  TEXT,
  franchise_id      TEXT,
  team_name         TEXT,
  owner_name        TEXT,
  active_owner      TEXT NOT NULL DEFAULT 'Y',
  updated_at_utc    TEXT
);

CREATE INDEX IF NOT EXISTS idx_discord_owners_active
  ON discord_owners(active_owner, franchise_id);

CREATE INDEX IF NOT EXISTS idx_discord_owners_franchise
  ON discord_owners(franchise_id);
