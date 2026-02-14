# Data Lineage

## ETL Lineage
1. Source files from `pipelines/etl/inputs` and MyFantasyLeague API feeds are ingested by ETL scripts.
2. Contract ingestion scripts normalize records into `contract_forum_export_v3_all` in SQLite.
3. Projection and auction scripts read SQLite tables and produce CSV outputs into `pipelines/etl/artifacts`.
4. Migration scripts backfill legacy XML payload and guarantee semantics for historical consistency.

## Rulebook Lineage
1. Source rule text files in `services/rulebook/sources/archive` are transformed by `tools/build_rulebook_json.py`.
2. Canonical output `services/rulebook/data/rules.json` is served by `api/rulebook_api.py`.
3. Owner feedback is stored in `services/rulebook/data/rule_feedback.db` with dedupe and schema validation.

## Traceability Controls
- Every ETL script emits deterministic, named outputs.
- Contract ingestion preserves `source_section` and `source_raw_line` fields for audits.
- Rulebook feedback payloads include canonical hashes for duplicate suppression.
