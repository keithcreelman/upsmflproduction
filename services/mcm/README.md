# Man Crush Monday (MCM) Service

Standalone nomination + weekly voting app with a lightweight Python (stdlib-only) API and a single-page web UI.

## What This Is (And Is Not)
- This service does **not** scrape Instagram or automatically fetch photos.
- Nominees are represented by a name + public link + optional image URL (provided by the nominator).
- Intended for **adults only**. Nominations require an attestation that the nominee is 18+ and the submission is respectful.

## Structure
- `api/mcm_api.py`: HTTP API + static HTML hosting.
- `web/mcm.html`: single page UI (vote + nominate + results).
- `data/mcm_seed.json`: genres + initial recommended nominees.
- `data/mcm.db`: runtime SQLite store (created on first run).

## Run
```bash
python3 services/mcm/api/mcm_api.py --host 127.0.0.1 --port 8799 --cors-origin "*"
```

Open:
- `http://127.0.0.1:8799/`

## Environment
- `MCM_DB_PATH`: override SQLite DB location (default `services/mcm/data/mcm.db`)
- `MCM_SEED_PATH`: override seed JSON path (default `services/mcm/data/mcm_seed.json`)
- `MCM_ADMIN_TOKEN`: if set, enables admin endpoints guarded by `X-Admin-Token`

## Endpoints (Main)
- `GET /health`
- `GET /api/config`
- `GET /api/week`
- `GET /api/babe-of-the-day`
- `GET /api/ballot`
- `POST /api/nominations`
- `POST /api/vote`
- `GET /api/results`

## Endpoints (Admin)
- `GET /api/admin/nominations?status=pending`
- `POST /api/admin/nominations/<id>/approve`
- `POST /api/admin/nominations/<id>/reject`
