-- 0147_ups_roast_owner_ammo.sql
--
-- D1 mirror of the personality-dossier fields the roast bot's clapback path
-- has never been able to see.
--
-- WHY THIS EXISTS (Keith 2026-09-02): pipelines/etl/data/bot/owner_profiles.json
-- is LOCAL-ONLY by design (gitignored -- it holds candid, sometimes
-- slur-adjacent-and-flagged-unusable material about real people, and the repo
-- is public). trade_roast_context.py reads it directly and renders it into
-- the trade-roast prompt via format_owner_dossier() -- that path works fine.
--
-- But worker/src/discord_roast_reply.js's buildReplierContext() -- the
-- "someone heckled the bot, build them a clap-back" path -- runs on
-- Cloudflare, which can only ever read a file that reached GitHub. It has
-- NEVER had access to owner_profiles.json at all, participant or not: within
-- an hour of the 2026-09-02 dossier rewrite going live, a heckle from a
-- non-participant produced a banned "sixteen years, nine playoff trips"
-- résumé recitation, because that path falls back to a bare
-- ups_owner_career_stats dump with zero personality material (see #1014).
--
-- This table is the fix: a one-way LOCAL -> D1 sync
-- (pipelines/etl/scripts/sync_owner_ammo_to_d1.py) of exactly the fields the
-- clapback path needs to render the SAME ammo block the Python trade-roast
-- path already gets. Run it by hand after editing owner_profiles.json --
-- there is no cron here, this mirrors "Keith hot-edits profiles between
-- trades."
--
-- Fields are stored as JSON-encoded TEXT (roast_angles, discord_receipts,
-- running_gags, sensitivities are all arrays in the source file) so the sync
-- script never has to reshape them -- it round-trips json.dumps(...) straight
-- from the loaded profile dict.

CREATE TABLE IF NOT EXISTS ups_roast_owner_ammo (
  franchise_id       TEXT PRIMARY KEY,   -- zero-padded 4-digit fid, matches discord_owners/ups_owner_career_stats
  owner_display      TEXT NOT NULL,
  team_name          TEXT,
  discord_handle     TEXT,
  voice              TEXT,               -- free text
  form               TEXT,               -- free text (assigned rhythm/shape)
  device             TEXT,               -- free text (signature device)
  best_counterpunch  TEXT,               -- free text (reference shape/length, never recited verbatim)
  roast_angles_json      TEXT,           -- JSON array of {text, source}
  discord_receipts_json  TEXT,           -- JSON array of {quote, date, why}
  running_gags_json      TEXT,           -- JSON array of strings
  sensitivities_json     TEXT,           -- JSON array of strings
  synced_at_utc      TEXT NOT NULL       -- ISO timestamp of the last sync, for staleness checks
);
