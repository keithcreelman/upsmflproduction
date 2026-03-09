# Trade Workbench (MVP)

Static custom trade UI for UPS salary-cap trades.

## Files
- `trade_workbench.html` — page shell
- `trade_workbench.css` — UI styles (desktop + mobile)
- `trade_workbench.js` — state, filters, trade logic, payload preview
- `trade_workbench_sample.json` — sample data payload for local/demo use
- `extension_previews_2026.json` — exported extension preview rows (success-only) for worker/API merge

## What It Does (MVP)
- Two-team trade builder (players + draft picks)
- Columns: Player/Asset, Salary, Years, Contract Info
- Global filters: search plus asset-view toggles for players and picks
- Trade salary adjustment per side in `$1K` units
- Max trade salary = half of selected outgoing **non-Taxi** player salary (rounded down)
- Extension checkbox/option for eligible outgoing players; extension applies to the acquiring team
- JSON payload preview for future DB/XML integration

## Data Contract (input JSON)
The app loads data from:
1. `window.UPS_TRADE_WORKBENCH_DATA` (if present)
2. `?data=<url>` query param
3. `?api=<worker-url>` query param (auto-forwards `L`, `YEAR`, `F`)
4. `trade_workbench_sample.json` fallback

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

## Worker/API (implemented)
Worker route:
- `GET /trade-workbench?L=<leagueId>&YEAR=<season>[&F=<franchiseId>]`
- `POST /trade-offers` with `direct_mfl=true` to submit a live `tradeProposal` import to MFL
- `POST /trade-offers/action` with `direct_mfl=true` and `trade_id` to run `tradeResponse`
  - on `action=ACCEPT`, if `payload` is included it also runs:
    - `salaryAdj` import for traded salary settlement
    - `salaries` import for selected extension requests
    - `taxi_squad` import to demote incoming traded Taxi players back onto Taxi automatically

It returns a normalized payload for this UI by combining:
- MFL `league` export (franchise metadata)
- MFL `rosters` export (players/contracts/salaries)
- MFL `assets` export (draft picks; requires worker `MFL_COOKIE`)
- static `extension_previews_<season>.json`

Open the page with either pattern:
- `trade_workbench.html?api=https://<your-worker>/trade-workbench&L=74598&YEAR=2026`
- `trade_workbench.html?data=https://<your-worker>/trade-workbench?L=74598&YEAR=2026`
