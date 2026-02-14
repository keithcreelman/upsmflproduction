UPS Salary Cap Dynasty League Rulebook Embed Package

Files
- ccc_rulebook_embed.html: embeddable front-end rulebook + guarded feedback form.
- rulebook_api.py: lightweight API server with SQLite logging.
- rules.json: structured rule catalog used by front-end/API.
- build_ups_rulebook_json.py: regenerates rules.json from archived UPS source documents.
- ccc_rulebook.db: created automatically after first feedback submission.

Run API
python3 rulebook_api.py --host 0.0.0.0 --port 8787 --cors-origin "*"

Endpoints
- GET /health
- GET /api/rules
- POST /api/rule-feedback

Embed options
1) Iframe (fastest)
<iframe src="/path/to/ccc_rulebook_embed.html" style="width:100%;min-height:920px;border:0;"></iframe>

2) Direct page include
- Host ccc_rulebook_embed.html as a standalone page route in your site.

Required front-end config
In ccc_rulebook_embed.html, set:
window.CCC_RULEBOOK_CONFIG = { apiBaseUrl: 'https://your-api-host' };

Runtime loading behavior
- Rules load from API first (`/api/rules`), then local `rules.json` paths.
- Optional override via URL: `?apiBaseUrl=https://your-api-host`.
- If all fetches fail, embedded fallback rules still render so page is never blank.

Regenerating from UPS source files
- Source path expected: `/Users/keithcreelman/Documents/mfl_app_codex/rules/archive`.
- Command: `python3 build_ups_rulebook_json.py`

Feedback storage schema
Table: rule_feedback
Key guardrails:
- Valid rule_id required.
- feedback_type: thought|change.
- proposed_text required only for change.
- summary/rationale length constraints.
- duplicate hash protection.
- per-IP rate limiting.

Operational notes
- To review submissions:
  sqlite3 ccc_rulebook.db "SELECT id, created_at_utc, rule_id, feedback_type, summary, status FROM rule_feedback ORDER BY id DESC;"
