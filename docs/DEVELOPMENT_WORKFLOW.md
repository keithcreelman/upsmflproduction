# Development Workflow

## Branching Intent
- Use this tree for all iterative changes and data repairs.
- Keep production untouched until validation passes.

## Change Process
1. Edit code in `pipelines`, `services`, or `apps`.
2. Run `bash scripts/validate_release.sh`.
3. Run targeted ETL jobs or API checks.
4. Update `docs/RENAME_MAP.csv` and lineage docs if structure changes.
5. Copy validated release candidate to production.

## Legacy Comparison
- Use `legacy_snapshot/*_original` to compare old vs new behavior.
- Preserve old source file names only in snapshot directories.
