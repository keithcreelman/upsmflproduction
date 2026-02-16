# UPS MFL Production

Dynasty salary cap fantasy football league management platform for the UPS League, built on MyFantasyLeague (MFL).

## Directory Structure

```
upsmflproduction/
├── apps/mfl_site/         # MFL website customizations (header, footer, bridge JS)
├── pipelines/etl/         # Python ETL scripts for contract ingestion & projections
│   ├── scripts/           # All Python scripts
│   ├── config/            # Runtime config, overrides, ADP data
│   ├── inputs/            # Runtime input files (gitignored)
│   ├── data/              # SQLite DB (gitignored)
│   └── artifacts/         # Generated CSVs (gitignored)
├── services/
│   ├── rulebook/          # Rulebook API server + frontend + rule builder
│   └── mcm/               # Man Crush Monday voting system
├── site/                  # GitHub Pages deployed assets
│   ├── ccc/               # Contract Command Center (JS app)
│   ├── mcm/               # MCM data (seed, votes, nominations)
│   ├── standings/         # Standings snapshots
│   └── *.html/js/css      # Widgets, loaders, options
├── worker/                # Cloudflare Worker (serverless API)
│   └── src/index.js       # MYM submissions, restructures, MCM voting
├── scripts/               # Shell scripts (validation, setup, smoke tests)
│   └── scheduler/         # macOS launchd plists for automation
├── docs/                  # Documentation
└── .github/workflows/     # GitHub Actions (MYM refresh, submission logging)
```

## Quick Start

1. **Setup inputs**: `bash scripts/setup_live_inputs.sh`
2. **Validate**: `bash scripts/validate_release.sh`
3. **Run ETL**: `python3 pipelines/etl/scripts/<script>.py`
4. **Start Rulebook API**: `bash scripts/start_rulebook_api.sh`
5. **Deploy Worker**: `cd worker && wrangler deploy`

## Deployment

- **GitHub Pages**: Serves `site/` directory at `keithcreelman.github.io/upsmflproduction/`
- **Cloudflare Worker**: Deployed from `worker/` via `wrangler deploy`
- **GitHub Actions**: 5 automated workflows for data logging and dashboard refresh

## Git Workflow

- `main` = production (stable, deployable)
- `dev` = development (active work)
- Feature branches for new work, PRs to promote dev -> main
- Git tags for release versions (e.g., `v2026.5`)
