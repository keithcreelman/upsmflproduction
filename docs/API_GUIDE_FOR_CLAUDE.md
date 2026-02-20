# UPS Fantasy League API Guide (for Claude)

This guide is the practical API/data contract for this repo.
Use it as the source of truth for extraction, submission, and generated artifacts.

## 1) System Map

- Primary repo: `upsmflproduction` (this workspace).
- Frontend static assets:
  - `/Users/keithcreelman/Documents/New project/site`
  - `/Users/keithcreelman/Documents/New project/apps/mfl_site`
- ETL + data shaping:
  - `/Users/keithcreelman/Documents/New project/pipelines/etl`
- HTTP services:
  - Cloudflare Worker: `/Users/keithcreelman/Documents/New project/worker/src/index.js`
  - Rulebook API: `/Users/keithcreelman/Documents/New project/services/rulebook/api/rulebook_api.py`
  - MCM API: `/Users/keithcreelman/Documents/New project/services/mcm/api/mcm_api.py`

## 2) External Data Source (MFL)

Base:
- `https://api.myfantasyleague.com/{YEAR}/export?...`
- Some legacy helpers also resolve `https://www{server}.myfantasyleague.com/{YEAR}/export?...`

Common query params:
- `TYPE` (dataset)
- `L` (league id)
- `JSON=1` for JSON
- Optional `APIKEY` for selected export calls

Main `TYPE` values used by this repo:
- `league`
- `myfranchise`
- `players`
- `rosters`
- `salaries`
- `schedule`
- `leagueStandings`
- `playerScores`
- `transactions`
- `nflSchedule`
- `adp`
- `salaryAdjustments` (via configured URL)

## 3) Cloudflare Worker API

Code:
- `/Users/keithcreelman/Documents/New project/worker/src/index.js`

### 3.1 Admin/Session Check

- Path: any non-matched route with `?L=...`
- Method: `GET`
- Returns JSON:
  - `isAdmin`
  - `reason`
  - `emailCount`
  - `commishFranchiseId`
  - session flags (`sessionKnown`, `sessionMatch`, etc.)

### 3.2 MYM Dashboard Refresh Queue

- `POST /refresh-mym-json?L={leagueId}&YEAR={year}`
- Requires commish/admin validation via MFL cookie/API key check.
- Dispatches GitHub `repository_dispatch` event:
  - `event_type: refresh-mym-json`

### 3.3 Contract Submission Endpoints

- `POST /offer-mym`
- `POST /offer-restructure`
- `POST /commish-contract-update`

Accepted body:
- JSON or form-url-encoded.
- Core fields:
  - `L`/`leagueId`, `YEAR`/`year`
  - `player_id`, `salary`, `contract_year`
  - Optional: `player_name`, `position`, `franchise_id`, `franchise_name`, `contract_info`, `contract_status`

Behavior:
- Writes to MFL `TYPE=salaries` import endpoint.
- Verifies by reading back MFL salaries export.
- For non-manual updates, dispatches GitHub log events:
  - `log-mym-submission`
  - `log-restructure-submission`

### 3.4 MCM Endpoints (Worker-backed JSON mode)

- `GET /mcm/config`
- `GET /mcm/week`
- `GET /mcm/botd`
- `GET /mcm/ballot`
- `GET /mcm/results`
- `POST /mcm/nominate`
- `POST /mcm/vote`

Data sources (GitHub static JSON):
- `/site/mcm/mcm_seed.json`
- `/site/mcm/mcm_nominations.json`
- `/site/mcm/mcm_votes.json`

Worker dispatches:
- `log-mcm-nomination`
- `log-mcm-vote`

## 4) Rulebook API (Local/Service)

Code:
- `/Users/keithcreelman/Documents/New project/services/rulebook/api/rulebook_api.py`

Endpoints:
- `GET /health`
- `GET /api/rules`
- `POST /api/rule-feedback`

Validation highlights:
- `feedback_type`: `thought|change`
- Priority: `low|normal|high`
- Dedupe hash enforced (`sha256` of canonical payload)
- Rate limit by IP (simple in-memory window)

Storage:
- Rules JSON: `services/rulebook/data/rules.json`
- Feedback SQLite: `services/rulebook/data/rule_feedback.db`

## 5) MCM API (Local/Service)

Code:
- `/Users/keithcreelman/Documents/New project/services/mcm/api/mcm_api.py`

Endpoints:
- `GET /health`
- `GET /api/config`
- `GET /api/week`
- `GET /api/babe-of-the-day`
- `GET /api/ballot`
- `GET /api/results`
- `POST /api/nominations`
- `POST /api/vote`
- `GET /api/admin/nominations`
- `POST /api/admin/nominations/{id}/approve`
- `POST /api/admin/nominations/{id}/reject`

Storage:
- Seed JSON: `services/mcm/data/mcm_seed.json`
- DB: `services/mcm/data/mcm.db`

## 6) GitHub Dispatch Workflows

Workflow files:
- `/Users/keithcreelman/Documents/New project/.github/workflows/refresh-mym-dashboard.yml`
- `/Users/keithcreelman/Documents/New project/.github/workflows/log-mym-submission.yml`
- `/Users/keithcreelman/Documents/New project/.github/workflows/log-restructure-submission.yml`
- `/Users/keithcreelman/Documents/New project/.github/workflows/log-mcm-nomination.yml`
- `/Users/keithcreelman/Documents/New project/.github/workflows/log-mcm-vote.yml`

Event types consumed:
- `refresh-mym-json`
- `log-mym-submission`
- `log-restructure-submission`
- `log-mcm-nomination`
- `log-mcm-vote`

Primary JSON outputs updated by workflows:
- `site/ccc/mym_dashboard.json`
- `site/ccc/mym_submissions.json`
- `site/ccc/restructure_submissions.json`
- `site/mcm/mcm_nominations.json`
- `site/mcm/mcm_votes.json`

## 7) ETL Commands and Output Contracts

Orchestrator:
- `/Users/keithcreelman/Documents/New project/scripts/run_pipeline_live.sh`

Core generated artifacts:
- Roll-forward CSV:
  - `pipelines/etl/artifacts/rosters_rollforward_2026_full.csv`
  - `pipelines/etl/artifacts/mfl_roster_import_2026.csv`
- MFL import XML:
  - `pipelines/etl/artifacts/mfl_roster_import_2026_salaries.xml`
  - `pipelines/etl/artifacts/mfl_roster_overlay_2026.xml`
- CCC/standings JSON:
  - `site/ccc/player_points_history.json`
  - `site/ccc/tag_submissions.json`
  - `site/ccc/restructure_submissions.json`
  - `site/standings/standings_25625_2025.json`
  - `site/standings/standings_25625_2026.json`
  - `site/standings/standings_74598_2025.json`
  - `site/standings/standings_74598_2026.json`

Useful scripts:
- `scripts/setup_live_inputs.sh`
- `scripts/build_tag_tracking_live.sh`
- `scripts/smoke_test_operational.sh`

## 8) Environment Variables and Secrets

Runtime examples:
- `/Users/keithcreelman/Documents/New project/pipelines/etl/config/runtime.env.example`
- `/Users/keithcreelman/Documents/New project/pipelines/etl/config/mfl_config.example.json`

Common env vars:
- `MFL_COOKIE`
- `MFL_LEAGUE_ID`
- `MFL_YEAR`
- `MFL_APIKEY`
- `MFL_DB_PATH`
- `MFL_ETL_ARTIFACT_DIR`
- `MFL_TAG_TRACKING_JSON`
- `MFL_TAG_EXCLUSIONS_JSON`
- `MFL_SALARY_ADJUSTMENTS_URL`

Worker secrets:
- `MFL_COOKIE`
- `COMMISH_API_KEY`
- `MFL_APIKEY`
- `GITHUB_PAT`
- `GITHUB_REPO_OWNER`
- `GITHUB_REPO_NAME`
- `MCM_SALT`

Rule: never commit cookies, API keys, PATs, or full signed URLs.

## 9) Frontend Embed and Caching Notes

Loaders:
- Global partial loader: `/Users/keithcreelman/Documents/New project/site/loader.js`
- CCC embed loader: `/Users/keithcreelman/Documents/New project/site/ccc/mfl_hpm_embed_loader.js`
- Standings embed loader: `/Users/keithcreelman/Documents/New project/site/standings/mfl_hpm_embed_loader.js`

Known gotchas:
- If a script URL serves wrong MIME/path, you can see raw code text on page.
- Keep script references on a pinned ref/tag and bump `?v=` when needed.
- `rawcdn.githack.com` is used for pinned immutable-style references; keep refs aligned with deployed commits/tags.

## 10) Claude Execution Rules (Recommended)

When Claude modifies this system:
- Prefer changing data generators over hand-editing generated JSON.
- Validate endpoint contracts before editing frontend consumers.
- Keep leading-zero franchise ids (`0001` format).
- Preserve player ids as strings.
- For submissions, validate downstream workflow event payload compatibility.
- After API/data changes, run:
  - `bash scripts/validate_release.sh`
  - targeted ETL scripts
  - smoke checks (`scripts/smoke_test_operational.sh`)

## 11) Quick Start Checklist for Claude

1. Read this file and `docs/LINEAGE.md`.
2. Identify whether task is:
   - extraction (MFL -> DB/artifact),
   - submission (worker -> dispatch -> JSON log),
   - presentation (site consumers).
3. Confirm impacted API contracts.
4. Make minimal edits.
5. Regenerate affected artifacts.
6. Record changes in:
   - `/Users/keithcreelman/Documents/New project/docs/ai-change-log.md`

