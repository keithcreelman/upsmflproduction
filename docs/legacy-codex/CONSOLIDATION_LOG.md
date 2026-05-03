# MFL Repository Consolidation Log

**Date:** 2026-05-03
**Performed during:** Mac-to-Mac migration
**Branch:** `consolidation/merge-codex`

## Summary

The `ups-league-data` codex repository was consolidated into `upsmflproduction`. Going forward, **`upsmflproduction` is the single source of truth** for all MFL/UPS league code, data, rules, and tooling. The codex repo should be archived on GitHub (Settings → Archive) but kept as a historical reference.

## Source Repository

- **Name:** `ups-league-data` (locally known as `mfl_app_codex`)
- **GitHub URL:** https://github.com/keithcreelman/ups-league-data
- **Final commit at consolidation:** `ec8962a` ("Auto-refresh MYM dashboard JSON from MFL")
- **Old local path:** `~/Code/mfl_app_codex`

## Background

Over time, `upsmflproduction` grew to contain newer, fully-developed versions of nearly everything in the codex repo. The codex was originally the data/widget/rules home, but production absorbed almost all of its content with updated copies. This consolidation moves the **remaining unique content** into production and retires the codex.

## Migration Scope: Already Duplicated (NOT migrated)

The following codex content was already present in `upsmflproduction` with identical or newer versions, so it was **not migrated** — production's copy is authoritative:

| Codex Path | Already in Production At | Notes |
|---|---|---|
| `rules/UPS *.docx, *.pdf, UPS_Master_Rulebook.html` (all 8 rule docs) | `services/rulebook/sources/rules/` | Identical files — verified via `diff -q` |
| `rules/archive/` | `services/rulebook/sources/rules/archive/` | Same content |
| `rules/mfl_message_boards/` | `services/rulebook/sources/rules/mfl_message_boards/` | Same content |
| `mcm_nominations.json`, `mcm_seed.json`, `mcm_votes.json` | `site/mcm/` | Identical files — verified via `diff -q` |
| `ccc.js`, `ccc.css`, `ccc_contracts.svg`, `ccc_latest.*` | `site/ccc/` | Production has updated versions |
| `mfl_hpm16_contractcommandcenter.html`, `mfl_hpm_embed_loader.js` | `site/ccc/` | Production has updated versions |
| `mym_dashboard.json`, `mym_submissions.json`, `restructure_submissions.json`, `tag_tracking.json` | `site/ccc/` | Production has updated versions |
| `ups_options_widget*` (all variants) | `site/` and `site/options/` | Production has updated versions |
| `reports/*.csv` | `site/reports/` | Production has updated versions |
| `.github/workflows/log-mcm-*.yml`, `log-mym-*.yml`, `log-restructure-*.yml`, `refresh-mym-dashboard.yml` | `.github/workflows/` | Production has its own (different/updated) versions; codex versions archived under `docs/legacy-codex/github-actions/` for reference |

## Migration Scope: Migrated to Production

The following codex content was unique and has been **moved into production**:

| Codex Path | Destination in Production | Reason |
|---|---|---|
| `scripts/fetch_mfl_messageboards.py` | `scripts/messageboards/` | Active script, no production equivalent |
| `scripts/parse_mfl_messageboards.py` | `scripts/messageboards/` | Active script, no production equivalent |
| `scripts/parse_manual_messageboards.py` | `scripts/messageboards/` | Active script, no production equivalent |
| `scripts/fetch_mfl_api_info.py` | `scripts/messageboards/` | Active script, no production equivalent |
| `etl/logs/`, `etl/mfl_etl_full/`, `etl/scheduler/` | `docs/legacy-codex/etl/` | Archived for reference (production's `pipelines/etl/` supersedes this) |
| `.github/workflows/*` (all 5) | `docs/legacy-codex/github-actions/` | Archived (production's workflows are newer/different) |
| `src/index.js` | `docs/legacy-codex/worker/index.js` | Archived (production's `worker/` directory supersedes) |
| `wrangler.toml` | `docs/legacy-codex/worker/wrangler.toml` | Archived (production has its own) |
| `README.md` | `docs/legacy-codex/CODEX_README.md` | Documentation reference |

## Post-Consolidation Checklist

- [x] Unique scripts copied to `scripts/messageboards/`
- [x] Legacy ETL archived to `docs/legacy-codex/etl/`
- [x] Legacy workflows archived to `docs/legacy-codex/github-actions/`
- [x] Legacy worker files archived to `docs/legacy-codex/worker/`
- [x] Codex README archived
- [x] CONSOLIDATION_LOG.md (this file) created
- [ ] **TODO:** Archive `keithcreelman/ups-league-data` on GitHub (Settings → Archive). Do NOT delete — keep as historical reference.
- [ ] **TODO:** Once consolidation branch is merged to main, delete local clone of `mfl_app_codex` from old Mac (it lives only in GitHub history at this point).

## Verification

To verify the consolidation captured everything unique:
```bash
# All these should already exist in production
diff -rq ~/Code/mfl_app_codex/rules/ services/rulebook/sources/rules/ | head
diff -q ~/Code/mfl_app_codex/mcm_nominations.json site/mcm/mcm_nominations.json
diff -q ~/Code/mfl_app_codex/mcm_seed.json site/mcm/mcm_seed.json
diff -q ~/Code/mfl_app_codex/mcm_votes.json site/mcm/mcm_votes.json

# These should now exist in production after consolidation
ls scripts/messageboards/
ls docs/legacy-codex/
```
