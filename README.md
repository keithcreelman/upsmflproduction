# MFL Development Package

This is the active development workspace aligned to the production structure.

## What Is Included
- Same clean layout as production (`apps`, `pipelines`, `services`, `docs`, `scripts`).
- `legacy_snapshot/` with original pre-clean project copies:
  - `legacy_snapshot/etl_original`
  - `legacy_snapshot/mfl_original`
  - `legacy_snapshot/rulebook_original`

## Development Workflow
1. Build and test changes in this folder.
2. Run `scripts/validate_release.sh`.
3. Promote only validated files into production.

## Purpose
- `Development` is for iteration, migration, and backfills.
- `Production` is for stable, deployable code and controlled runtime data.
