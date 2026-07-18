-- 0104_ups_app_views.sql
-- Per-owner APP-VIEW tracking (Keith 2026-07-18).
--
-- WHY: the ups_*_submissions tables tell us which owners took an ACTION through
-- the custom app, but nothing recorded who merely OPENED it (browsed Lite Mode,
-- the Front Office, or the mobile app without submitting anything). This table
-- is the passive "who's actually using the app" signal — a lightweight beacon on
-- page load upserts one row per (franchise, surface, day).
--
-- GRAIN: one row per franchise per surface per UTC day, with a hit counter. That
-- keeps it compact (≤ 12 owners × few surfaces × days) while still answering
-- "who opened it, on which surface, how often, and how recently". We deliberately
-- do NOT store the MFL_USER_ID cookie (it's an auth token) — only the resolved
-- franchise id, which the page already exposes as window.FRANCHISE_ID.
--
-- franchise_id '0000' / '' = an unattributed view (a commish page that runs as
-- franchise 0000, or a logged-out/again-unresolved visitor). Still counted, just
-- not tied to an owner.
CREATE TABLE IF NOT EXISTS ups_app_views (
  league_id      TEXT NOT NULL,
  season         TEXT NOT NULL,
  franchise_id   TEXT NOT NULL,        -- 4-char zero-padded; '0000' = unattributed
  surface        TEXT NOT NULL,        -- 'lite-mode' | 'mfl-custom' | 'desktop-fo' | 'mobile'
  day            TEXT NOT NULL,        -- 'YYYY-MM-DD' (UTC) — daily dedup bucket
  hits           INTEGER NOT NULL DEFAULT 1,
  first_seen_utc TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_utc  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (league_id, season, franchise_id, surface, day)
);

CREATE INDEX IF NOT EXISTS idx_app_views_fid  ON ups_app_views(franchise_id, last_seen_utc);
CREATE INDEX IF NOT EXISTS idx_app_views_last ON ups_app_views(last_seen_utc);
CREATE INDEX IF NOT EXISTS idx_app_views_surf ON ups_app_views(surface, last_seen_utc);
