# DB archives

Compressed point-in-time copies of the local MFL analysis database
(`mfl_database.db`) so they aren't lost. These are **reference snapshots**,
not live data — the live source of truth is D1 (`ups-mfl-db`) per
`rule_d1_is_single_source_of_truth`.

## Contents
- `mfl_database_2026-06-05.db.gz` — Keith's Downloads copy (Jun 2026, ~191MB
  uncompressed). Richer than the iCloud snapshot: holds the forum contract
  exports (`contract_forum_export_v3_*`, 2012–2025) used to backfill historical
  contracts into D1, plus `contract_forum_export_v3_flagged_all` (30 low-confidence
  player matches still needing manual review — see the parking-lot note).

## Restore
```bash
gunzip -k mfl_database_2026-06-05.db.gz       # -> mfl_database_2026-06-05.db
sqlite3 mfl_database_2026-06-05.db ".tables"
```
