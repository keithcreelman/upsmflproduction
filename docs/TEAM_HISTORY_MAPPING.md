# Team history evidence (W1): mapping provenance and validation

`GET /api/lineup-matchups` (version `lmu4-2026-11-21`) adds eight `teamHistory*` fields. They say which NFL club a player was with in which weeks, for players whose club changed, and which players the Worker cannot cover. Everything else in the payload is unchanged (proved byte for byte by `tests/lineup_team_history.test.mjs`). This page records where the evidence comes from, what is and is not validated, and what risk remains. Tracker: #1494 (W1), #1497 (limitations register), #1475 (design record).

## What the fields mean

| Field | Meaning |
|---|---|
| `teamHistoryState` | `ok` or `unavailable` |
| `teamHistoryReason` | `null` when ok; else `past_season`, `context_failed`, `identity_unavailable`, `no_history`, `crosswalk_failed`, `crosswalk_suspect` or `history_error` |
| `teamHistoryThrough` | last week the history covers (the coverage week); `null` when unavailable |
| `teamHistory` | `{ mflId: { seg: [[club, firstWeek, lastWeek], …], cur? } }`, only for players with more than one club segment, or whose MFL club differs from the last record, or who are free agents (MFL club blank or FA) with a last record before the coverage week. `cur` is MFL's current club ("" for a free agent) and is never folded into `seg`. A one-club player's segment spans any gap between his first and last row; a multi-club player's segments split at gaps |
| `teamHistoryFirst` | `{ mflId: firstWeek }` for every other player (no club change seen) whose first weekly row is after Week 1. The weeks before it are unknown: the client must not count them as team games (2026 Week 10: 495 players, 69 on UPS rosters). Players with a first row in Week 1 are omitted |
| `teamHistoryMissing` | players with MFL scores and no weekly row at all: club history unknown |
| `teamHistoryConflict` | players whose mapping may be to the wrong person (score weeks, shared nflverse id, position family, name, missing identity row): nothing is shown for them |
| `teamHistoryConflictWhy` | `{ mflId: reason }` for every conflict (`score_weeks`, `shared_nfl_id`, `position_family`, `position_multi_family`, `name_mismatch`, `identity_missing`) |

Club identity, game opportunity and opponent identity are separate facts. This route supplies only the first, and only for weeks with a weekly row. It never supplies an opponent, a BYE or a "played" flag, and a recorded MFL score is never treated as club evidence. Weeks before a player's first record are unknown (the first segment starts at its first real week). The client decides what to show; where a player is missing, conflicted or beyond the coverage week, it withholds the club-dependent figure and never substitutes today's club.

## Provenance chain

1. **nflverse weekly player stats** (public release files) are loaded by `fetch_nflverse_weekly.py` (nflreadpy) into D1 `nfl_player_weekly`, one row per player-game with the player's NFL club for that game. Refresh cadence per `.github/workflows/nflverse-stats-refresh.yml` (Mon 05:00 and 13:00, Tue 05:00, 12:00 and 20:00, Wed 11:00 UTC).
2. **DynastyProcess `db_playerids.csv`** (a public community crosswalk) is loaded by `fetch_ff_playerids.py` into D1 `ff_player_ids`, upserted by `mfl_id`. This is the only link from an MFL player id to an nflverse (gsis) id. It is maintained by a third party and is not under UPS control.
3. `fpaLoadSeasonContext` (existing, `worker/src/fpa_engine.js`) joins `nfl_player_weekly` to `ff_player_ids` through gsis and returns per MFL id a club and first/last row week (one-club players) or a week-to-club map (players with more than one club). That context is cached for six hours.
4. `lmuTeamHistory` (new, `worker/src/lineup_matchups.js`) turns that context into the fields above. **No new database statement** and no new network call: the route still makes the same three SELECTs and the same GETs.

A wrong id in step 2 attaches one player's weekly rows to another player. The route's defense numbers already depend on this join; W1 does not make that dependence larger, but it is the reason every per-player result is checked against MFL's own score weeks (below) instead of being trusted.

## What validates an individual mapping

Per player, in the Worker, on every request. Each failure puts the player in `teamHistoryConflict` (with a reason in `teamHistoryConflictWhy`) and shows no segments; nothing is repaired or guessed:

- **Missing**: MFL has scores for the player but there is no weekly row. Listed in `teamHistoryMissing`; no club is assumed.
- **`shared_nfl_id`**: the crosswalk gives the same nflverse id to more than one MFL id, so the weekly rows cannot be attributed to one of them.
- **`position_family`**: the position nflverse recorded for the nflverse id (or the crosswalk's own position) is in a different family (offense, defense, special teams) than the position MFL has for the player. **`position_multi_family`**: nflverse records one id in two families. An unknown position on either side proves nothing and never flags.
- **`name_mismatch`**: the crosswalk's name for the MFL id differs from MFL's own name (case, punctuation, name order and Jr./Sr./II-V suffixes ignored).
- **`identity_missing`**: the weekly-row join produced the player but the identity statement has no row for him.
- **`score_weeks`**: a weekly row sits in a week for which MFL has no score row for that player. Real weekly rows imply an MFL score row, so a violation means the id is joined to someone else's rows. Checked for every week of a multi-club player and for the first and last row week of a one-club player (the context keeps only those two for one-club players).
- **No identity evidence, no answer.** If the identity statement fails or returns nothing, team history is `unavailable` (`identity_unavailable`); the route's other fields are unaffected.

Two aggregate gates exist and are **diagnostic only**; they do not validate any individual mapping and passing them is not evidence that mappings are right:

- coverage floor: at least 90% of players with MFL scores must have weekly rows (2026: 95.7%), else `crosswalk_failed`. Not applied below 200 scored players.
- changed-club ceiling: at most 120 players listed as changed (2026: 58), else `crosswalk_suspect`. Conflicts do not count toward it.

Both are tunable constants (`TEAM_HISTORY_COVERAGE_FLOOR`, `TEAM_HISTORY_CHANGED_CEILING`).

## Targeted identity validation (results)

Run by `tests/lineup_team_history.test.mjs` on the real 2026 data through Week 10 (fixture below).

- **Known defects, real data**: the replay lists five conflicts and the route withholds all five: the three `score_weeks` conflicts (Williams, Wydett; McClain, Malik; Waxter, Isas, none on a UPS roster) and two `position_family` conflicts (Hunter, Travis, a UPS-rostered two-way player nflverse lists as a cornerback; VanSumeren, Ben, MFL linebacker, nflverse running back). Withholding Hunter is deliberate: an uncertain identity is withheld, not guessed. The earlier audit also found 10 many-to-one crosswalk defects (one nflverse id mapped to several MFL ids); in the 2026 replay none of them is a scored player with weekly rows, so none is listed today, and the `shared_nfl_id` rule is proved by a test with a simulated shared id. The defects themselves stay open in #1497.
- **Seeded swaps** (the weekly rows and the position evidence of random pairs exchanged, which is what a crosswalk pointing an MFL id at someone else's nflverse id does): **cross-family pairs (3% of identities): 19 of 20 swapped ids withheld by the position check** (the one miss is a partner whose nflverse position is blank, which proves nothing). **Same-family pairs: 22 of 44 (3%) and 38 of 76 (5%), all by the score-week check alone: about half are still undetectable**, because two players of the same family who scored in the same weeks cannot be told apart by anything the Worker holds. At a 10% swap the changed-club count exceeds the ceiling and the whole answer becomes `crosswalk_suspect`.
- **Truncation**: dropping 60% of the weekly rows gives `crosswalk_failed`; dropping 4% stays available with the lost players listed as missing.
- **Real-data counts**: 58 listed players (46 club changers, which is what the Python reference finds, plus 12 free agents cut before Week 10), 71 with no history (the reference's 70 plus one unrostered free agent), 5 conflicts, 495 first-record weeks; of the UPS-rostered players, 10 listed, 8 missing, 1 conflicted (Hunter), 69 with a late first record. The lists cover every player MFL has scored this season, not just the window-limited `playerWindow` (an independent review found the window-limited version hid changed players when `&last=` was used).

## Residual risk (not resolved)

The aggregate gates catch broad failures only, and the identity checks narrow but do not close the gap. A wrong mapping between two players of the same position family who scored in the same weeks passes every check the Worker can make (about half of such swapped identities in the seeded test). Cross-family wrong mappings are now caught except where nflverse's position is blank. A pair of players whose DynastyProcess rows are both wrong in a way that keeps names, positions and score weeks consistent is undetectable here. The remaining guard is the client withholding figures it cannot support. The residual risk stays open in #1497; passing a threshold is not evidence that mappings are right.

## Added files and behavior (bounded expansion of W1, owner ruling of 2026-11-21)

- `worker/src/fpa_engine.js`: two new exported functions, `fpaLoadIdentity` (one SELECT) and `fpaIdentityCached` (6 h edge cache, key `/ident?season=&v=`). **Nothing existing was edited**: `fpaLoadSeasonContext`, `fpaSeasonContextCached` and every calculation that reads them are unchanged, and no other Worker module imports the new functions (tests pin this).
- `worker/src/lineup_matchups.js`: `lmuIdentityWhy`, `lmuNameKey`, the identity inputs of `lmuTeamHistory`, and the call, made only for the current season on the live (not stored, not past) context.
- The identity SELECT reads `nfl_player_weekly` joined to `ff_player_ids` once (the same access path the classic statement uses; its query plan shows one pass over the season's weekly rows by the `(season, pos_group)` index and one crosswalk lookup per row, against two passes for the classic statement). It writes nothing. **D1 cost: not measured with D1's own counter (a production capture is not authorized).** Local sqlite on the public files with the production indexes: 10.5k weekly rows and 1.57k result rows, about half the work of the classic statement. Expected order of magnitude: the weekly rows for the season (about 17k at season end) plus the crosswalk lookups, once per 6 hours per edge cache, under 100k rows per day; to be confirmed by the first measured run after any release.
- Tests: `tests/lineup_team_history.test.mjs` (identity rules, seeded swaps, known defects, a failing identity read, and four classic-preservation checks), `tests/fixtures/team_history_2026_wk10.json` (adds `identRows`), `tests/fixtures/fpa_classic_context_sql.json` (the classic loader's exact SQL and binds as pinned from origin/main), `tests/helpers/make_classic_sql_pin.mjs`.
- Behavior: new reason `identity_unavailable`; new response field `teamHistoryConflictWhy`; conflicts now include identity failures. **The classic app is unaffected**: the route's pre-existing fields are byte-identical on the replay (including with the identity read failing), and the engine's classic loader runs the same statements as on origin/main.

## Deviations from the earlier W1 specification (each deliberate)

1. **Conflict handling.** The earlier text said conflict = two clubs in one week or an ambiguous crosswalk; the Worker context cannot see either, so conflict is now the list above (score weeks, shared nflverse id, position, name, missing identity row).
2. **First-record weeks.** `teamHistoryFirst` was added so the client can leave the weeks before a no-change player's first weekly row unknown (amendment 1, ruling U2).
3. **Free-agent entries.** A free agent cut before the coverage week is listed with `cur: ""` so his silence is never read as a continuation with his old club.
4. **Lists cover every MFL-scored player**, not the window-limited `playerWindow`.
5. **Payload size.** The earlier bound was 8 KB for 100 changers. Measured on the 2026 replay: +8.4 KB raw (+2.9 KB gzipped; the whole response 114.7 KB raw, 20.8 KB gzipped): `teamHistory` 2.5 KB, `teamHistoryFirst` 5.0 KB (495 players), missing 0.6 KB, conflicts 0.2 KB. `teamHistoryFirst` is the large part and grows through the season.

## What the replay is, and is not

The fixture (`tests/fixtures/team_history_2026_wk10.json`) is the league as MFL and the weekly stat files had it on 2026-11-21 (Week 11 in progress, history through Week 10): every MFL read the route makes plus the rows the route's own SQL returns, rebuilt from public files with `form_audit` scripts. **It was not captured from production D1.** It is an emulation of the route's SELECTs (the three classic ones and the identity SELECT) from public data. Fidelity against the live route at the same time: all 1,635 `playerWindow` entries and all 288 `defRatings` cells identical, with the attribution counts off by one player-game. A capture from production would read roughly 98 thousand rows; it is **not authorized** (owner ruling 2026-11-21), none was made, and if one becomes necessary the specific unanswered question, expected cost and scope will be put to Keith first.

`tests/fixtures/team_history_2026_wk10_golden.json` is the response of the pre-change route (`lmu3-2026-10-14`, origin/main `7e91025b`) on that fixture; it is the baseline for the "nothing else changed" proof.

## Not in this change

Opponent, BYE and game-opportunity derivation (client side, P); the deployed route (a merge is a release and needs Keith's go); any D1 write; any change to an existing engine function or classic response.
