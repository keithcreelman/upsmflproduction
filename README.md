# UPS MFL Production

Dynasty salary cap fantasy football league management platform for the UPS League, built on MyFantasyLeague (MFL).

## Directory Structure

```
upsmflproduction/
├── apps/mfl_site/         # Contract Command Center bridge JS + loader patch
├── header_custom_v2.html  # MFL header (every MFL page; pasted into MFL by hand)
├── footer_custom_v2.html  # MFL footer (every MFL page; pasted into MFL by hand)
├── pipelines/etl/         # Python ETL scripts for contract ingestion & projections
│   ├── scripts/           # ETL jobs, contract/repair builders
│   ├── lib/               # Shared Python modules (cap penalty, MFL transactions)
│   ├── wire/              # The Wire authoring toolchain
│   ├── config/            # Runtime config, overrides, ADP data
│   ├── inputs/            # Runtime input files (gitignored)
│   ├── data/              # SQLite DB (gitignored)
│   └── artifacts/         # Generated CSVs (gitignored)
├── services/
│   ├── rulebook/          # Rulebook API server + frontend + rule builder
│   └── mcm/               # Man Crush Monday voting system
├── site/                  # GitHub Pages deployed assets
│   ├── m/                 # Mobile app (PWA)
│   ├── rosters/ trades/ rookies/ commish/ ...  # Desktop hubs and workbenches
│   ├── ccc/               # Tag submission + tracking JSON
│   ├── mcm/               # MCM data (seed, votes, nominations)
│   ├── standings/         # Standings snapshots
│   └── *.html/js/css      # HPM pages, widgets, loaders, options
├── worker/                # Cloudflare Worker (serverless API + crons, D1, R2)
│   ├── src/index.js       # All HTTP routes + scheduled handler; modules alongside in src/
│   └── migrations/        # D1 schema migrations
├── scripts/               # Repo checks, CI helpers, cron/launchd installers, repair scripts
│   └── scheduler/         # macOS launchd plists for automation
├── tests/                 # Plain-Node test files (node tests/<name>.test.mjs)
├── data/                  # Committed MFL snapshots, repair evidence, archives
├── incidents/             # Incident post-mortems
├── docs/                  # Documentation
└── .github/workflows/     # GitHub Actions (deploys, PR checks, scheduled jobs, manual repairs)
```

## Quick Start

1. **Setup inputs**: `bash scripts/setup_live_inputs.sh`
2. **Test**: `node tests/<name>.test.mjs` (full sweep and static checks: see `CLAUDE.md`)
3. **Run ETL**: `python3 pipelines/etl/scripts/<script>.py`
4. **Start Rulebook API**: `bash scripts/start_rulebook_api.sh`
5. **Deploy**: merge to `main`; CI deploys the worker and the site (see Deployment)

## Deployment

- **GitHub Pages**: Serves `site/` (plus the root header/footer) at `keithcreelman.github.io/upsmflproduction/`, deployed by `.github/workflows/pages-deploy.yml` on push to `main`
- **Cloudflare Worker**: Auto-deployed by `.github/workflows/deploy-worker.yml` on push to `main` touching `worker/**` or `docs/league_context_v1.md` (eslint gate, then `wrangler deploy`)
- **GitHub Actions**: 82 workflow files: 17 on a schedule, deploys and PR checks on push/PR, and many manual-dispatch repairs and diagnostics

## Git Workflow

- `main` = production (stable, deployable); merging to `main` deploys
- Feature branches cut from `main`, PRs into `main` (naming: `docs/CHANGE_PLAYBOOK.md` §3)
- The `dev` branch is no longer used (last commit 2026-03-01)
- Release tags are not in use (latest release tag: `v1.02`, 2026-02-17)
