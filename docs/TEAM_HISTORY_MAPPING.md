# Team history evidence (W1): mapping provenance and validation

`GET /api/lineup-matchups` (version `lmu4-2026-11-22`) adds six `teamHistory*` fields. They say which NFL club a player was with in which weeks, for players whose club changed, and which players the Worker cannot cover. Everything else in the payload is unchanged (proved byte for byte by `tests/lineup_team_history.test.mjs`). This page records where the evidence comes from, what is and is not validated, and what risk remains. Tracker: #1494 (W1), #1497 (limitations register), #1475 (design record).

## What the fields mean

| Field | Meaning |
|---|---|
| `teamHistoryState` | `ok` or `unavailable` |
| `teamHistoryReason` | `null` when ok; else `past_season`, `context_failed`, `no_history`, `crosswalk_failed` or `crosswalk_suspect` |
| `teamHistoryThrough` | last week the history covers (the coverage week); `null` when unavailable |
| `teamHistory` | `{ mflId: { seg: [[club, firstWeek, lastWeek], …], cur? } }`, only for players with more than one club segment or whose MFL club differs from the last record. `cur` is MFL's current club and is never folded into `seg` |
| `teamHistoryFirst` | `{ mflId: firstWeek }` for every other player (no club change seen) whose first weekly row is after Week 1. The weeks before it are unknown: the client must not count them as team games (2026 Week 10: 503 players, 69 on UPS rosters). Players with a first row in Week 1 are omitted |
| `teamHistoryMissing` | players with MFL scores and no weekly row at all: club history unknown |
| `teamHistoryConflict` | players whose weekly rows contradict MFL's score weeks: the identity join is wrong for this id, so nothing is shown |

Club identity, game opportunity and opponent identity are separate facts. This route supplies only the first, and only for weeks with a weekly row. It never supplies an opponent, a BYE or a "played" flag, and a recorded MFL score is never treated as club evidence. Weeks before a player's first record are unknown (the first segment starts at its first real week). The client decides what to show; where a player is missing, conflicted or beyond the coverage week, it withholds the club-dependent figure and never substitutes today's club.

## Provenance chain

1. **nflverse weekly player stats** (public release files) are loaded by `fetch_nflverse_weekly.py` (nflreadpy) into D1 `nfl_player_weekly`, one row per player-game with the player's NFL club for that game. Refresh cadence per `.github/workflows/nflverse-stats-refresh.yml` (Mon 05:00 and 13:00, Tue 05:00, 12:00 and 20:00, Wed 11:00 UTC).
2. **DynastyProcess `db_playerids.csv`** (a public community crosswalk) is loaded by `fetch_ff_playerids.py` into D1 `ff_player_ids`, upserted by `mfl_id`. This is the only link from an MFL player id to an nflverse (gsis) id. It is maintained by a third party and is not under UPS control.
3. `fpaLoadSeasonContext` (existing, `worker/src/fpa_engine.js`) joins `nfl_player_weekly` to `ff_player_ids` through gsis and returns per MFL id a club and first/last row week (one-club players) or a week-to-club map (players with more than one club). That context is cached for six hours.
4. `lmuTeamHistory` (new, `worker/src/lineup_matchups.js`) turns that context into the fields above. **No new database statement** and no new network call: the route still makes the same three SELECTs and the same GETs.

A wrong id in step 2 attaches one player's weekly rows to another player. The route's defense numbers already depend on this join; W1 does not make that dependence larger, but it is the reason every per-player result is checked against MFL's own score weeks (below) instead of being trusted.

## What validates an individual mapping

Per player, in the Worker, on every request:

- **Missing**: MFL has scores for the player but there is no weekly row. Listed in `teamHistoryMissing`; no club is assumed.
- **Conflict**: a weekly row sits in a week for which MFL has no score row for that player. Real weekly rows imply an MFL score row, so a violation means the id is joined to someone else's rows. Checked for every week of a multi-club player and for the first and last row week of a one-club player (the context keeps only those two for one-club players). Listed in `teamHistoryConflict` with no segments.

Two aggregate gates exist and are **diagnostic only**; they do not validate any individual mapping and passing them is not evidence that mappings are right:

- coverage floor: at least 90% of players with MFL scores must have weekly rows (2026: 95.7%), else `crosswalk_failed`. Not applied below 200 scored players.
- changed-club ceiling: at most 120 players listed as changed (2026: 46), else `crosswalk_suspect`.

Both are tunable constants (`TEAM_HISTORY_COVERAGE_FLOOR`, `TEAM_HISTORY_CHANGED_CEILING`).

## Targeted identity validation (results)

Run by `tests/lineup_team_history.test.mjs` on the real 2026 data through Week 10 (fixture below).

- **Known defects, real data**: the replay lists exactly three conflicts (Williams, Wydett; McClain, Malik; Waxter, Isas), none of them on a UPS roster, and the route withholds all three. The earlier audit also found 10 many-to-one crosswalk defects (one nflverse id mapped to several MFL ids); those are tracked in #1497 and are not closed by this change.
- **Duplicate id** (two players' rows under one id): flagged as a conflict when the rows do not fit one player's score weeks (test).
- **Seeded swaps** (the weekly rows of random same-position-family pairs exchanged, which is what a wrong crosswalk does): the per-player check flagged 5 of 12 swapped ids (1%), 22 of 44 (3%) and 38 of 76 (5%). **About half of swapped players are not detectable by the per-player check**, because two players scored in the same weeks cannot be told apart by score weeks alone. At a 10% swap the changed-club count exceeds the ceiling and the whole answer becomes `crosswalk_suspect`.
- **Truncation**: dropping 60% of the weekly rows gives `crosswalk_failed`; dropping 4% stays available with the lost players listed as missing.
- **Real-data counts**: 46 players with a club change, 70 with no history, 3 conflicts; of the UPS-rostered players, 10 changed, 8 missing, 0 conflicted.

## Residual risk (not resolved)

The aggregate gates catch broad failures only. A small number of wrong individual mappings, such as a pair swapped between two players on the same score weeks, passes both gates and is flagged by the per-player check only about half the time in the seeded test. The Worker cannot do better without more context: the season context carries neither nflverse position nor gsis id, so a position-family check and gsis-level one-to-many detection need changes to `fpa_engine.js`, which is out of scope for W1 (recorded in #1494 and #1497). Until those exist, the guard against a wrong individual mapping is the per-player score-week check, the three known conflicts, and the client withholding figures it cannot support. The residual risk stays open in #1497.

## What the replay is, and is not

The fixture (`tests/fixtures/team_history_2026_wk10.json`) is the league as MFL and the weekly stat files had it on 2026-11-21 (Week 11 in progress, history through Week 10): every MFL read the route makes plus the rows the route's own SQL returns, rebuilt from public files with `form_audit` scripts. **It was not captured from production D1.** It is an emulation of the three SELECTs from public data. Fidelity against the live route at the same time: all 1,635 `playerWindow` entries and all 288 `defRatings` cells identical, with the attribution counts off by one player-game. A capture of the three SELECTs from production would read roughly 98 thousand rows and needs Keith's explicit opt-in; none was made.

`tests/fixtures/team_history_2026_wk10_golden.json` is the response of the pre-change route (`lmu3-2026-10-14`, origin/main `7e91025b`) on that fixture; it is the baseline for the "nothing else changed" proof.

## Not in this change

Opponent, BYE and game-opportunity derivation (client side, P); the deployed route (a merge is a release and needs Keith's go); any D1 write; any change to `fpa_engine.js`.
