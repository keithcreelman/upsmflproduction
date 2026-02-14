# Release Checklist

- [ ] `bash scripts/validate_release.sh` completes without errors.
- [ ] Environment variables are set for DB path and external feeds.
- [ ] Required ETL inputs are present in `pipelines/etl/inputs`.
- [ ] Rulebook API responds at `/health` and `/api/rules`.
- [ ] Rulebook feedback insert tested with one valid payload.
- [ ] ETL artifact directory is writable in target runtime.
- [ ] Rollback backup of SQLite DB has been created.
