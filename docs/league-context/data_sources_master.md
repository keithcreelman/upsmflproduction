# UPS Data Sources — Master Reference (read this FIRST)

*Authoritative pointer to where league data actually lives. If a question is "what was on a roster in year X" or "who started week W in year X" — the answer is here, not rebuilt from contract_history. Updated 2026-04-30.*

---

## TL;DR — where to look

| Question | Source | Coverage |
|:---------|:-------|:---------|
| Who was on team T's **roster** in season S, week W? | `rosters_weekly` | 2010-2011, 2017-2025 |
| Who actually **started** for team T, season S, week W? | `weeklyresults.status='starter'` | **2010-2025 complete** |
| What was player P's **salary** in season S? | `rosters_weekly.salary` (per-week snapshot) | 2010-2011, 2017-2025 |
| What was a player's **contract year / status** that week? | `rosters_weekly.contract_year`, `contract_status`, `contract_info` | 2010-2011, 2017-2025 |
| Who **won** week W matchups? | `weeklyresults.result`, `team_score`, `is_home`, `is_playoff` | 2010-2025 |
| Player **weekly points**? | `weeklyresults.player_score` OR `player_weeklyscoringresults` | 2010-2025 |
| What did franchise F **call themselves** in season S? | `mfl_franchise_history` (D1) / `dim_franchise` (sqlite) | 2011+ |
| **Rookie draft** results? | `draftresults_combined` / `draftresults_mfl` / `draftresults_legacy` | full |
| **Auction** transactions? | `transactions_auction` | post-cap era |
| Season-long player totals? | `site/ccc/player_points_history.json` (built from `player_pointssummary`) | recent seasons |

---

## DB location (CRITICAL — the local file is empty)

The 0-byte file at `pipelines/etl/data/mfl_database.db` is **NOT** the live DB. The real DB lives in iCloud:

```
/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/Documents/New project/mfl_database.db
```

182 MB as of 2026-04-15. Set `MFL_DB_PATH` env var or pass it explicitly to scripts.

The repo also pushes to **Cloudflare D1** (see `worker/migrations/`) — D1 is the production read source for the live site. For analytical work, the iCloud sqlite is faster and complete.

---

## Key table schemas

### `rosters_weekly` — full YoY rosters with salary
```sql
season, week, franchise_id, team_name,
player_id, player_name, position, nfl_team,
status,           -- 'ROSTER' | 'INJURED_RESERVE' | 'TAXI_SQUAD'
salary, contract_year, contract_status, contract_info,
raw_json
PRIMARY KEY (season, week, franchise_id, player_id, status)
```
**Coverage:** 2010, 2011, 2017-2025. Gaps: 2012-2016 (use `weeklyresults` for that window).

### `weeklyresults` — actual starter / nonstarter + scores
```sql
season, week, franchise_id,
is_home,          -- 1 if home, 0 if away
result,           -- 'W' | 'L' | 'T'
team_score, team_opt_pts,
player_id, player_score,
status,           -- 'starter' | 'nonstarter'
should_start, is_playoff
PRIMARY KEY (season, week, franchise_id, player_id, status)
```
**Coverage:** 2010-2025 every season, all weeks. **This is the table that answers "who actually started" for any year.**

### `mfl_franchise_history` (D1 migration `0028`, also in sqlite as `dim_franchise` / similar)
```sql
season, franchise_id, team_name, owner_name, source, notes
PRIMARY KEY (season, franchise_id)
```
Use this to map (season, franchise_id) → owner. Teams rename across years; the current `franchises` MFL endpoint only gives current names.

---

## What this means in practice (for analytical work)

**DO NOT** rebuild rosters from `contract_history_*.csv` + a player-name → gsis crosswalk. That was the wrong approach. Reasons:
1. `contract_history_*.csv` is a derived contract-events report, not the per-week roster.
2. It only covers players whose contract changed; players on a flat rookie deal whose salary never moved may not appear cleanly.
3. We have a precise per-(season, week, franchise, player) snapshot already.

**DO** join `rosters_weekly` ⨝ `weeklyresults` on `(season, week, franchise_id, player_id)` to get:
- Was the player on the roster that week? (rosters_weekly)
- Did they actually start? (weeklyresults.status)
- What did they score? (weeklyresults.player_score)
- What were they getting paid? (rosters_weekly.salary)
- What's their contract status? (rosters_weekly.contract_status, contract_info)

That join is the source of truth for any "championship roster anatomy", "TE elite vs non-elite advantage", "QB anchor analysis", etc.

---

## For the championship-roster-reconstruction task specifically

To answer "what did the championship team look like in season S":

```sql
-- Find the champion (final playoff win)
WITH final AS (
  SELECT season, week, franchise_id, result, is_home, team_score
  FROM weeklyresults
  WHERE is_playoff = 1
  GROUP BY season, week, franchise_id
)
SELECT season, MAX(week) AS final_week, franchise_id
FROM final
WHERE result = 'W'
GROUP BY season;
```

Then for each (season, champion_franchise_id), pull:
- **Full roster**: `rosters_weekly` filtered to that franchise+season, all weeks → roster compositions changed week-to-week (trades, IR, taxi promotions).
- **Actual starters**: `weeklyresults` filtered to that franchise+season+`status='starter'`, regular season vs playoffs (`is_playoff` flag).
- **Win-share by player**: aggregate `player_score` by `(player_id, status='starter')` across the season.
- **Cap allocation**: `rosters_weekly.salary` weighted by weeks-rostered.

No external crosswalks needed. No nflverse joins needed (unless we want NFL-side bio data like draft round, which is a separate enrichment).

---

## Other useful tables (less critical but worth knowing)

- `transactions_auction` — auction prices by season (for "what did vet QB1s actually go for")
- `draftresults_combined` — rookie + supplemental + dispersal draft history
- `weeklyresults_summary` — pre-aggregated weekly team scores (faster than aggregating raw)
- `player_weeklyscoringresults` — official MFL weekly scoring by player (UPS scoring rules already applied)
- `View_LeagueHistory`, `View_LeagueHistory_OwnerTotals` — pre-built views for owner-level history
- `View_RookieDraft` — pre-built rookie draft view
- `metadata_starters` — starter-slot rules per season (1QB era vs SF era vs SF+TEP)
- `metadata_rosterlimits` — roster size limits per season

---

## API endpoints (when DB is stale and you need fresh data)

Per `docs/MFL_API.md` and `docs/API_GUIDE_FOR_CLAUDE.md`:

```
https://api.myfantasyleague.com/{YEAR}/export?TYPE={type}&L={league}&JSON=1
```

Relevant `TYPE` values:
- `rosters` — current rosters (one snapshot)
- `weeklyResults` — week-level results
- `playerScores` — player scores (week or season)
- `salaries` — current salaries
- `salaryAdjustments` — salary changes
- `liveScoring` — live week
- `players` — player metadata (name, NFL team, position)
- `nflSchedule` — NFL game schedule for the year
- `transactions` — all transactions

Default UPS league IDs (from runtime env):
- Production: configured via `MFL_LEAGUE_ID` (live UPS league)
- Tier-2 test (audit): `25625` on `www48.myfantasyleague.com`

---

## When in doubt

1. **First** check this doc (`data_sources_master.md`).
2. **Second** check `docs/league-context/ups_analytical_metrics.md` for analytical metric definitions.
3. **Third** check `docs/MFL_API.md` / `docs/API_GUIDE_FOR_CLAUDE.md` for endpoint specs.
4. **Last resort** rebuild from raw — and only then because the above genuinely don't have what you need. Document the gap when you do.

**Never silently rebuild data that already exists in the DB.** That's how we end up with a fresh crosswalk solving a problem that wasn't actually present.
