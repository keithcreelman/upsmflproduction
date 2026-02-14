# MFL Production Package

This is the cleaned production-ready project structure for UPS MFL operations.

## Top-Level Layout
- `apps/mfl_site`: MFL header/footer and command-center bridge assets.
- `pipelines/etl`: ETL scripts, configs, runtime inputs, and generated artifacts.
- `services/rulebook`: rulebook API, embed UI, and rule dataset.
- `docs`: lineage, runbooks, and release controls.
- `scripts`: validation helpers for release checks.

## Quick Start
1. Set environment variables from `pipelines/etl/config/runtime.env.example`.
2. Place ETL input files in `pipelines/etl/inputs`.
3. Run ETL scripts from `pipelines/etl/scripts`.
4. Start the rulebook API with:
   - `python3 services/rulebook/api/rulebook_api.py --host 0.0.0.0 --port 8787 --cors-origin "*"`

## Release Safety
- Read `docs/OPERATIONS_RUNBOOK.md` before deployment.
- Run `scripts/validate_release.sh` before promoting a build.
- Keep runtime databases and output artifacts out of source control.
