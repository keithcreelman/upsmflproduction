# UPS MFL Production — Repository Consolidation Plan

## Problem Statement
The repo currently has **5+ copies of the same code** spread across 7 top-level directories. The same ETL scripts, MFL site files, and rulebook code exist in `.build_clean/`, `MFLUPS_Dev/`, `MFLUPS_Prod/`, `etl/`, `mfl/`, and `rulebook/`. This makes it confusing to know which version is current, impossible to maintain, and bloated (~15MB when it should be ~3MB).

---

## Phase 1: Clean Target Structure

Promote `MFLUPS_Dev/` contents to the repo root and delete all duplicates. Final structure:

```
upsmflproduction/
├── .github/
│   └── workflows/              # GitHub Actions (from ups-league-data)
├── apps/
│   └── mfl_site/               # MFL header, footer, bridge JS, loader patch
├── pipelines/
│   └── etl/
│       ├── scripts/            # All 16 Python ETL scripts (consolidated)
│       ├── config/             # runtime.env.example, overrides JSON, ADP data
│       ├── inputs/             # Runtime input files (gitignored)
│       ├── data/               # SQLite DB location (gitignored)
│       └── artifacts/          # Generated CSVs (gitignored)
├── services/
│   ├── rulebook/
│   │   ├── api/                # rulebook_api.py
│   │   ├── data/               # rules.json, feedback.db (gitignored)
│   │   ├── tools/              # build_rulebook_json.py
│   │   ├── web/                # rulebook_embed.html
│   │   └── sources/archive/    # Source rulebook docs
│   └── mcm/                    # MCM seed, config
├── site/                       # GitHub Pages deployed assets
│   ├── ccc.js                  # Contract Command Center
│   ├── ccc.css
│   ├── ccc.html
│   ├── ccc_latest.json
│   ├── mfl_hpm_embed_loader.js
│   ├── ups_options_widget.*    # Options widget files
│   ├── mcm_seed.json
│   ├── mcm_votes.json
│   ├── mcm_nominations.json
│   ├── mym_dashboard.json
│   ├── mym_submissions.json
│   ├── restructure_submissions.json
│   ├── tag_tracking.json
│   └── reports/                # CSV reports
├── worker/
│   └── src/
│       └── index.js            # Cloudflare Worker
│   └── wrangler.toml
├── scripts/
│   ├── validate_release.sh
│   ├── setup_live_inputs.sh    # (paths fixed)
│   ├── smoke_test_operational.sh
│   └── scheduler/              # macOS launchd plists
├── docs/
│   ├── LINEAGE.md
│   ├── OPERATIONS_RUNBOOK.md
│   ├── RELEASE_CHECKLIST.md
│   ├── REVIEW_FINDINGS.md
│   ├── RENAME_MAP.csv
│   ├── ai-change-log.md        # NEW: AI coordination log
│   └── PROJECT_OVERVIEW.md     # NEW: comprehensive README
├── .gitignore                  # NEW: comprehensive root gitignore
├── README.md                   # NEW: project README
└── wrangler.toml               # Symlink or copy for Cloudflare deploy
```

---

## Phase 2: Step-by-Step Execution

### Step 1: Create root .gitignore
```
# macOS
.DS_Store
._*

# Runtime data (never commit)
pipelines/etl/data/
pipelines/etl/inputs/*.xlsx
pipelines/etl/inputs/*.csv
pipelines/etl/artifacts/
services/rulebook/data/feedback.db
*.db

# Python
__pycache__/
*.pyc
*.pyo
.env

# IDE
.vscode/
.idea/

# Logs
scripts/scheduler/logs/
*.log
```

### Step 2: Delete redundant directories
These are ALL superseded by `MFLUPS_Dev/`:
- `.build_clean/` — older snapshot of the same refactored code
- `MFLUPS_Prod/` — manual copy of Dev (use git branches instead)
- `etl/` — standalone pre-refactor ETL scripts
- `mfl/` — standalone pre-refactor MFL site files
- `rulebook/` — standalone pre-refactor rulebook system
- `MFLUPS_Dev/legacy_snapshot/` — 3.2MB of old code kept for comparison, no longer needed

### Step 3: Promote MFLUPS_Dev to root
Move all contents of `MFLUPS_Dev/` up one level to the repo root:
- `MFLUPS_Dev/apps/` → `apps/`
- `MFLUPS_Dev/pipelines/` → `pipelines/`
- `MFLUPS_Dev/services/` → `services/`
- `MFLUPS_Dev/site/` → `site/`
- `MFLUPS_Dev/scripts/` → `scripts/`
- `MFLUPS_Dev/docs/` → `docs/`

Then delete the now-empty `MFLUPS_Dev/` directory.

### Step 4: Merge unique ups-league-data assets
The `ups-league-data/` directory has files NOT in MFLUPS_Dev that need preserving:

**Move to `site/`:**
- All JSON data files (mcm_*, mym_*, tag_tracking, restructure_submissions)
- CCC files (ccc.js, ccc.css, ccc.html, etc.) — if newer versions than what's in MFLUPS_Dev/site/
- Widget files (ups_options_widget.*)
- reports/ directory

**Move to `worker/`:**
- `ups-league-data/src/index.js` → `worker/src/index.js`
- `ups-league-data/wrangler.toml` → `worker/wrangler.toml`

**Move to `.github/workflows/`:**
- All 5 workflow YAML files

**Move to `pipelines/etl/scripts/`:**
- Any unique ETL scripts from `ups-league-data/etl/mfl_etl_full/` not already in `pipelines/etl/scripts/`
- Roster loaders: `loadrosterscurrent`, `loadrostersweekly`
- Loggers: `log_mym_submission.py`, `log_restructure_submission.py`, `log_mcm_vote.py`, `log_mcm_nomination.py`
- `refresh_mym_dashboard_from_mfl.py`, `build_tag_tracking.py`
- `mfl_config.py`, `db_utils.py`, `mfl_api.py`

**Move to `scripts/scheduler/`:**
- `ups-league-data/etl/scheduler/` plist files

**Move to `services/rulebook/sources/`:**
- `ups-league-data/rules/` (if newer than existing)

Then delete `ups-league-data/`.

### Step 5: Fix hardcoded paths in scripts
- Update `scripts/setup_live_inputs.sh` — fix references to old directory names
- Update `scripts/smoke_test_operational.sh` — fix references to old filenames
- Update `scripts/validate_release.sh` — verify patterns still match new structure
- Update GitHub Actions workflow paths to match new structure

### Step 6: Update GitHub Actions workflows
All 5 workflows reference scripts at `etl/mfl_etl_full/`. Update to `pipelines/etl/scripts/`.

### Step 7: Create new documentation
- `README.md` — project overview, setup instructions, directory guide
- `docs/ai-change-log.md` — AI coordination log (per project spec)
- `docs/PROJECT_OVERVIEW.md` — detailed architecture doc

### Step 8: Handle GitHub Pages deployment
Since `ups-league-data` is currently deployed via GitHub Pages at `keithcreelman.github.io/ups-league-data/`, the CCC and widget files need to remain accessible. Options:
- **Option A**: Configure GitHub Pages to serve from `site/` directory
- **Option B**: Keep `ups-league-data` as a separate repo (submodule) for Pages deployment
- **Option C**: Deploy from this repo's `site/` folder using a custom GitHub Pages config

### Step 9: Initial commit
Stage everything, create clean initial commit on `main` branch.

---

## Phase 3: Enhancements (Post-Consolidation)

### Priority 1 — Immediate Value
1. **Automated test suite** — Currently zero tests; add pytest for ETL scripts
2. **Environment variable consolidation** — Single `.env.example` at root instead of scattered configs
3. **GitHub Pages deployment config** — Proper `gh-pages` branch or `/docs` publishing
4. **CI/CD pipeline** — GitHub Action for linting, syntax checks, and validation on PR
5. **API key rotation** — `mfl_api.py` still has a hardcoded fallback API key (`aRBv1sCXvuWqx0CmP13EaDoeFbox`)

### Priority 2 — Developer Experience
6. **Python dependency management** — Add `requirements.txt` or `pyproject.toml` (pandas, etc.)
7. **Script CLI improvements** — Unified entry point (`python -m pipelines.etl run <script>`)
8. **Database migrations** — Version-controlled schema changes instead of ad-hoc table creation
9. **Docker containerization** — Dockerfile for reproducible ETL environment
10. **Pre-commit hooks** — Auto-run `validate_release.sh` and linting on commit

### Priority 3 — Architecture
11. **Separate repos consideration** — Worker (Cloudflare) could be its own repo with `wrangler deploy`
12. **Configuration management** — Move from env vars + JSON to a unified config system
13. **Logging framework** — Replace print() statements with proper Python logging
14. **Error monitoring** — Add Sentry or similar for Worker and ETL errors
15. **Backup automation** — Automated SQLite DB backups to cloud storage

### Priority 4 — Feature Enhancements (from project spec)
16. **Standings application overhaul** — Divisional views, head-to-head, percentage toggle
17. **Points relativity mode** — Performance vs league average metrics
18. **Playoff preview system** — Dynamic seeding projections with path-to-playoffs
19. **All-Play analysis tab** — Week range filtering, trends, mobile responsive
20. **UPS Widget enhancements** — Remove theme toggle (inherit global), add Owner Activity mode
21. **MCM system improvements** — Admin dashboard, nomination review UI, historical stats

### Priority 5 — Data & Analytics
22. **Historical analytics dashboard** — Multi-season trends, dynasty value tracking
23. **Contract value projections** — ML-based salary predictions using historical data
24. **Trade analyzer** — Dynasty trade value calculator using league-specific data
25. **Draft board** — Auction draft companion tool with real-time salary tracking

---

## What Gets Deleted (Safe to Remove)

| Directory | Size | Reason |
|-----------|------|--------|
| `.build_clean/` | 2.3MB | Older snapshot, superseded by MFLUPS_Dev |
| `MFLUPS_Prod/` | 415KB | Manual copy of Dev, use git tags/branches |
| `etl/` | 2MB+ | Pre-refactor originals, superseded |
| `mfl/` | 50KB | Pre-refactor originals, superseded |
| `rulebook/` | 200KB | Pre-refactor originals, superseded |
| `MFLUPS_Dev/legacy_snapshot/` | 3.2MB | Archive of old code, no longer needed |
| `.DS_Store` files | ~10KB each | macOS artifacts, never commit |

**Total removed: ~8MB+ of duplicate/obsolete code**

---

## What Gets Preserved (Nothing Lost)

Every unique file from every directory is accounted for:
- All 16 ETL scripts from MFLUPS_Dev → `pipelines/etl/scripts/`
- All unique ETL scripts from ups-league-data → `pipelines/etl/scripts/`
- Cloudflare Worker → `worker/`
- CCC + widgets + data JSONs → `site/`
- GitHub Actions → `.github/workflows/`
- Rulebook system → `services/rulebook/`
- MFL site customizations → `apps/mfl_site/`
- All documentation → `docs/`
- All shell scripts → `scripts/`

---

## Dev/Prod Workflow (Replaces Duplicate Directories)

Instead of `MFLUPS_Dev/` and `MFLUPS_Prod/`:
- **`main` branch** = production (stable, deployable)
- **`dev` branch** = development (active work)
- **Feature branches** = `feature/standings-overhaul`, `feature/playoff-preview`, etc.
- **Git tags** = release versions (`v2026.5`, `v2026.6`, etc.)
- **PRs** = Dev → Main for promotion

This is standard git workflow and eliminates the need for parallel directory copies.
