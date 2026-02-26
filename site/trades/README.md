# Trade Workbench (MVP)

Static custom trade UI for UPS salary-cap trades.

## Files
- `trade_workbench.html` — page shell
- `trade_workbench.css` — UI styles (desktop + mobile)
- `trade_workbench.js` — state, filters, trade logic, payload preview
- `trade_workbench_sample.json` — sample data payload for local/demo use

## What It Does (MVP)
- Two-team trade builder (players + draft picks)
- Columns: Player/Asset, Salary, Years, Contract Info
- Global filters: search, positions, contract types, min/max years, taxi toggle, picks toggle
- Trade salary adjustment per side in `$1K` units
- Max trade salary = half of selected outgoing **non-Taxi** player salary (rounded down)
- Extension checkbox/option for eligible outgoing players; extension applies to the acquiring team
- JSON payload preview for future DB/XML integration

## Data Contract (input JSON)
The app loads data from:
1. `window.UPS_TRADE_WORKBENCH_DATA` (if present)
2. `?data=<url>` query param
3. `trade_workbench_sample.json` fallback

Preferred shape:

```json
{
  "league_id": "74598",
  "season": 2026,
  "generated_at": "2026-02-26T18:05:00Z",
  "teams": [
    {
      "franchise_id": "0008",
      "franchise_name": "Real Deal Creel",
      "franchise_abbrev": "RDC",
      "is_default": true,
      "assets": [
        {
          "type": "PLAYER",
          "player_id": "15711",
          "player_name": "Walker III, Kenneth",
          "nfl_team": "SEA",
          "position": "RB",
          "salary": 32000,
          "years": 1,
          "contract_type": "Veteran",
          "contract_info": "CL 3| TCV 76K| AAV 32K| ...",
          "taxi": false
        },
        {
          "type": "PICK",
          "asset_id": "pick:2026-1-04",
          "description": "Year 2026 Draft Pick 1.04"
        }
      ]
    }
  ],
  "extension_previews": []
}
```

## `extension_previews` Integration
The UI can infer extension eligibility from raw `extension_previews` rows.

Minimum columns used:
- `franchise_id`
- `player_id`
- `success` (must be `1`)
- `extension_term` (`1YR` / `2YR`)
- `loaded_indicator` (`NONE` / `FL` / `BL`)
- `preview_ts` (latest option wins)

Optional columns shown in option labels/payload:
- `id` (preview id)
- `new_contract_status`
- `preview_contract_info_string`
- `new_aav_future`
- `new_TCV`

## Next Wiring Step (recommended)
Create one endpoint (worker/API) that returns a normalized payload:
- rosters + picks by franchise
- extension preview rows from `extension_previews`
- franchise metadata (name/abbrev/icon)

Then open the page with:
- `trade_workbench.html?data=https://<your-api>/trade-workbench?L=74598&YEAR=2026`
