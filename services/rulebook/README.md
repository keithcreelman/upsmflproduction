# UPS Rulebook Service

## Structure
- `rulebook_core.py`: clean-slate rulebook engine for fetch, build, validation, and payload loading.
- `api/rulebook_api.py`: API server for rule retrieval and feedback intake.
- `web/rulebook_embed.html`: embeddable front end.
- `data/rules.json`: owner-facing searchable payload.
- `data/rules_ai.json`: AI-ready chunk payload.
- `data/rulebook_bundle.json`: canonical bundle used for validation and downstream tooling.
- `data/rule_feedback.db`: runtime SQLite feedback store.
- `tools/fetch_mfl_rulebook_sources.py`: fetch current and historical MFL source snapshots.
- `tools/build_rulebook_json.py`: rebuild rulebook outputs from source material.
- `tools/validate_rulebook_bundle.py`: validate bundle structure and acceptance gates.
- `sources/rules/`: written rulebook, historical notes, examples, and confirmation overrides.
- `sources/generated/mfl/`: fetched MFL `league`, `rules`, and `allRules` snapshots.

## Run API
```bash
python3 services/rulebook/api/rulebook_api.py --host 0.0.0.0 --port 8787 --cors-origin "*"
```

## Endpoints
- `GET /health`
- `GET /api/rules`
- `GET /api/rules/ai`
- `POST /api/rule-feedback`

## Fetch + Rebuild
```bash
python3 services/rulebook/tools/fetch_mfl_rulebook_sources.py
python3 services/rulebook/tools/build_rulebook_json.py
python3 services/rulebook/tools/validate_rulebook_bundle.py
```

Optional environment override:
- `RULEBOOK_CURRENT_SEASON`
- `RULEBOOK_CURRENT_BASE_URL`
- `RULEBOOK_CURRENT_LEAGUE_ID`
- `RULEBOOK_FETCH_TIMEOUT`
- `RULEBOOK_RULES_PATH`
- `RULEBOOK_AI_PATH`
- `RULEBOOK_BUNDLE_PATH`

## Operations
Review latest feedback:
```bash
sqlite3 services/rulebook/data/rule_feedback.db "SELECT id, created_at_utc, rule_id, feedback_type, summary, status FROM rule_feedback ORDER BY id DESC LIMIT 50;"
```
