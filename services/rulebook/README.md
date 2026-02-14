# UPS Rulebook Service

## Structure
- `api/rulebook_api.py`: API server for rule retrieval and feedback intake.
- `web/rulebook_embed.html`: embeddable front end.
- `data/rules.json`: canonical rules payload.
- `data/rule_feedback.db`: runtime SQLite feedback store.
- `tools/build_rulebook_json.py`: rebuild `data/rules.json` from archive sources.
- `sources/archive/`: source text files used by the rules builder.

## Run API
```bash
python3 services/rulebook/api/rulebook_api.py --host 0.0.0.0 --port 8787 --cors-origin "*"
```

## Endpoints
- `GET /health`
- `GET /api/rules`
- `POST /api/rule-feedback`

## Rebuild Rules JSON
```bash
python3 services/rulebook/tools/build_rulebook_json.py
```

Optional environment override:
- `RULEBOOK_ARCHIVE_DIR`: absolute path to archive source directory.

## Operations
Review latest feedback:
```bash
sqlite3 services/rulebook/data/rule_feedback.db "SELECT id, created_at_utc, rule_id, feedback_type, summary, status FROM rule_feedback ORDER BY id DESC LIMIT 50;"
```
