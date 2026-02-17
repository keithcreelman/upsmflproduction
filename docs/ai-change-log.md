# AI Change Log

This file tracks all changes made by AI systems (Claude, Codex) to maintain synchronization across sessions.

Each entry should include:
- **Timestamp** (UTC)
- **AI System** (Claude / Codex)
- **Change Type** (feature, fix, refactor, config, schema, docs)
- **Files Modified**
- **Summary**

---

## 2026-02-16T22:00:00Z | Claude | refactor

**Summary**: Repository consolidation - eliminated all duplicate code, established single source of truth.

**Changes**:
- Deleted redundant directories: `.build_clean/`, `MFLUPS_Prod/`, `etl/`, `mfl/`, `rulebook/`, `MFLUPS_Dev/legacy_snapshot/`
- Promoted `MFLUPS_Dev/` contents to repo root
- Migrated Cloudflare Worker from `ups-league-data/` to `worker/`
- Migrated GitHub Pages assets to `site/`
- Migrated GitHub Actions workflows to `.github/workflows/`
- Migrated unique ETL scripts to `pipelines/etl/scripts/`
- Deleted `ups-league-data/` directory (deprecated)
- Updated all hardcoded URLs from `ups-league-data` to `upsmflproduction`
- Updated GitHub Actions workflow paths to match new structure
- Fixed script references in `smoke_test_operational.sh`
- Added `worker/` to validation scan in `validate_release.sh`
- Created root `.gitignore`
- Created `README.md`
- Created `docs/ai-change-log.md`

**Files Modified**:
- `worker/src/index.js` (URL updates)
- `worker/wrangler.toml` (name update)
- `site/ccc/ccc.js` (Worker URL updates)
- `site/mcm_embed_loader.js` (Worker URL update)
- `site/ups_options_widget_embed_loader.js` (GitHub Pages URL updates)
- `site/ups_options_widget.js` (GitHub Pages URL update)
- `site/ups_options_widget.html` (GitHub Pages URL updates)
- `apps/mfl_site/contract_command_center_loader_patch.html` (GitHub Pages URL updates)
- `pipelines/etl/scripts/refresh_mym_dashboard_from_mfl.py` (User-Agent update)
- `.github/workflows/*.yml` (all 5 workflows - path updates)
- `scripts/validate_release.sh` (added worker/ to scan)
- `scripts/smoke_test_operational.sh` (fixed script filenames)
- `.gitignore` (new)
- `README.md` (new)

---

## 2026-02-16T23:03:00Z | Codex | fix

**Summary**: Contract Command Center eligibility and tags table UX cleanup.

**What this does**:
- Prevents restructure options for players already at the $1,000 floor.
- Prevents tagged players from appearing in Expired Rookie Draft candidates.
- Reorders and tightens the Tags table so the most important controls and identity fields appear first.

**Files Modified**:
- `site/ccc/ccc.js`

---

## 2026-02-16T23:19:00Z | Codex | feature

**Summary**: Replaced the old chaotic headline ticker with a structured UPS marquee.

**What this does**:
- Disables legacy third-party marquee behavior and injects a custom 4-lane marquee.
- Adds lanes for:
  - First 24 rookie draft picks
  - Champions Ring of Honor (2010-2026 chronology)
  - Highest scoring expiring rookie
  - Submitted tagged players
- Uses existing UPS data feeds (champions JSON + CCC JSON) and MFL draft results API with graceful fallback.

**Files Modified**:
- `apps/mfl_site/header_custom_v2.html`
