# Franchise Tag Suspect Issues

- `site/ccc/tag_tracking.json` looks stale for current 2026 usage. It was generated on `2026-03-07` but still carries `season=2025`, `tracking_for_season=2025`, and `exclude_tagged_season=2024`.
- `pipelines/etl/scripts/build_tag_tracking.py` and `site/ccc/ccc.js` do not use the same salary-floor inputs. The browser can render a different tag cost than the JSON payload.
- Confirmed mismatch example: Joe Mixon stores `21,000` in `tag_tracking.json`, but the UI path can compute `32,000` because it reads parsed `contract_info` values.
- The script header comment says ranking uses `player_pointssummary.pos_rank`, but the implementation actually ranks from `player_weeklyscoringresults`.
- The current module is a franchise-tag tier engine, not the legacy rulebook's `Top 5` / `Top 10` tag process. Transition tags are missing from the current implementation.
- Expiring rookies are now included in the tag pool, which differs from older notes that described non-rookie expiring contracts.
- Unranked players can now get fallback tag salaries. That is a behavioral change from the recovered February baseline and should be explicitly approved/documented.
- Extension-lineage exclusion is now part of eligibility. That did not exist in the recovered February baseline and can silently block a tag.
- Kyler Murray / Calamari exclusion is hard-coded in the UI layer rather than modeled cleanly in the ETL output.
- `PK` calc breakdown rows store source players but not one shared base bid, so the report can look incomplete unless the per-player rule is explained.
- The current Cost Calc view is better than the original hidden backend state, but it is still tab/deep-link driven and not strong enough as a durable audit report.
