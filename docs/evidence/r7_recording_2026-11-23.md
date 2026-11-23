# R7 recorded preview: added captures (2026-11-23 UTC)

Authorized by Keith's R7 decisions ("Recorded preview preparation AUTHORIZED"): read-only captures to bundle sanitized game stats, league-wide season totals for stat ranks, and projections. This does **not** authorize publishing the preview, merging, a Worker release, a migration or xFP.

Everything here was read-only. No credentials were sent. Nothing was written to D1 (`rows_written` = 0 on every query) or anywhere else.

## What the recording now holds

| Part | Routes | Captured (UTC) | Captured (ET) | Source |
|---|---|---|---|---|
| League data (base, unchanged) | 34 | 2026-11-22 15:22:25 to 15:22:50 | Sun Nov 22, 10:22 AM | Public read-only routes of the deployed UPS Worker |
| Game stats | 117 | 2026-11-23 03:13:39 to 03:14:27 | Sun Nov 22, 10:13 to 10:14 PM | Deployed `/api/player-weekly-box` (GET) |
| Position season totals | 9 | 2026-11-23 03:11:41 to 03:11:46 | Sun Nov 22, 10:11 PM | Draft #1515 SQL, run read-only |
| Week 11 projections | 7 | 2026-11-23 03:11:47 to 03:11:52 | Sun Nov 22, 10:11 PM | Draft #1515 SQL, run read-only |

`apps/mobile2027/recording_manifest.json` lists every route with its key, path, status, bytes, `retrieved_at` and `origin`. The `origin` is `worker-get` or `draft-sql`. A `draft-sql` item also records its source label and the full draft commit. `r7_additions` holds the plan, rows_read, refresh stamps, Worker version and draft commit for each query. `meta.parts` in `src/recorded_data.js` repeats the four parts with their times. The marker still names the base time (10:22 AM ET), as before.

### Source versions
- **Deployed Worker:** version `93960454-f9c8-429a-a15d-755e0621159d`, deployed 2026-11-16 20:42:38 UTC (Mon Nov 16, 3:42 PM ET). Source commit `658531013f20b778dd8eb8a4a816de5041fc95b1` (merge of #1457), per the GitHub `deploy-worker.yml` record and `wrangler deployments list`. The Worker has no version route, so this was not probed live.
- **Draft routes:** PR #1515, commit `6ff03c8f1008b04a91e3480ced9d4cd69a8c7030`. Modules: `worker/src/position_season_stats.js` (SQL, `buildGroups`) and `worker/src/player_projections.js` (SQL, `parseIds`, `readProjections`). These routes are **not deployed**. Each answer was assembled in node by the draft module's own code, applied to the rows its SQL returned. Each is labeled "draft #1515 SQL run read-only on <time>".
- **nflverse refresh stamps** (`etl_runs`): weekly 2026-11-18T19:14:51Z, snaps 19:14:57Z, pbp 19:15:10Z, pfr_advstats 19:15:35Z. All weekly-box answers have `box_through_week` 10.

## 1. Game stats (`/api/player-weekly-box`, deployed)
- The 117 players are every rostered player of franchises 0010 (the default team, first in the roster read), 0009 and 0008, plus these representative cases: Smith-Njigba 16185, Love 14782, Gibbs 16162, Bowers 16641, Reese 17556, Williams 16719, Watt 13214, Sanders 13832, Mann 14985, Cousins 10700, Hooker 14182 and Tuimoloau 17149.
- Each request used the loader's exact address, `?season=2026&mfl_id=<id>&L=74598`. Requests were bare GETs at least 300 ms apart, with no credentials and a generic user agent. All 117 answered 200, 1,957,605 bytes raw. Each was logged with URL, UTC time, status and bytes.
- The earlier verification-pass answers for 16185, 14782, 10700 and 17149 are byte-identical to the new captures. All bundled answers come from this capture.
- **Coverage by position:**

| Position | Players | With game stats | Weeks with a box row |
|---|---|---|---|
| QB | 14 | 11 | 82 |
| RB | 25 | 24 | 172 |
| WR | 23 | 21 | 172 |
| TE | 10 | 10 | 81 |
| K | 4 | 4 | 38 |
| P | 4 | 4 | 35 |
| DL | 11 | 11 | 93 |
| LB | 14 | 14 | 111 |
| DB | 12 | 12 | 96 |

- Six players have a verified id match but no 2026 box row: Pearsall 16622 (WR), Simpson 17463 (QB), Flacco 9064 (QB), Milroe 17033 (QB), Benson 16594 (RB) and Stribling 17514 (WR). Their answers are `weeks: []`.
- Three players matched through accepted but not-`verified` map rows: Conner 16295 (`verified_dp`), Tuten 17052 (`bio_flag`) and Davis 16603 (`bio_flag`).
- All 12 representative cases have game stats, with 8 to 10 weeks each.
- **Trimming:** the generator keeps the fields `lib/boxlog.js` reads (`BOX_NUM`, `RZ_NUM`, `SNAP_NUM`, plus clubs and position), cut to the player's own MFL position. The position comes from MFL's player list in the same recording:
  - QB: passing, rushing and receiving.
  - RB, WR and TE: rushing and receiving.
  - IDP: defense.
  - K: kicking.
  - P: punting.
  - Red zone is cut to the position's rows.
  - Every other field (PFR advanced columns, longest-punt and net-punt fields, `pos_group`, `source`, and so on) is dropped.
- **Proof that the trimming changes nothing on screen:** for all 117 players, `parseBox`, `rows`, `rollup`, every view's columns, every game detail and participation give identical output on the raw and the trimmed answers (0 differences). A test also checks that the generator's lists still equal `boxlog.js`'s.

## 2. League-wide season totals (draft `/api/position-season-stats`, through Week 10)
Week 10 is the recording's settled week. Each SQL statement was EXPLAINed first (rows_read 0), then run once with `npx wrangler d1 execute ups-mfl-db --remote --json` from the draft worktree.

| Query | Plan | Rows | rows_read |
|---|---|---|---|
| box `nfl_player_weekly` | SEARCH autoindex (season=? AND week>? AND week<?) | 10,589 | 10,589 |
| ext `nfl_player_weekly_ext` | SEARCH autoindex (season, week range) | 6,903 | 6,903 |
| red zone `nfl_player_redzone` | SEARCH autoindex (season, week range) | 2,923 | 2,923 |
| snaps `nfl_player_snaps` | SEARCH autoindex (season, week range) | 14,004 | 14,004 |
| `player_id_map WHERE accepted = 1` | SCAN player_id_map | 2,274 | 2,295 |
| `etl_runs` stamps (version label only) | SEARCH autoindex (source=?) | 4 | 8 |
| **One fill in total** | | | **36,722** |

- r6b estimated one fill at 30 to 45k rows. The measured cost is 36,714 rows (36,722 with the stamps). This is the cost of one **uncached** fill. It is not the deployed cost, because the route is not deployed.
- **Pools:**

| Group | Players |
|---|---|
| QB | 70 |
| RB | 150 |
| WR | 233 |
| TE | 128 |
| PK | 38 |
| PN | 34 |
| DL | 360 |
| LB | 197 |
| DB | 364 |

- `data_max_week` is 10 for every group. `unmapped_box_players` is 242: box players with no accepted map row, never guessed. `ambiguous_ids` is 0.
- **Trimming:** each answer keeps the season sums its group's Breakdown shows, plus the denominators for its rates and shares:
  - QB: passing, rushing, fumbles lost, QB red zone, and offensive and team offensive snaps.
  - RB, WR and TE: rushing, receiving, team targets, carries, receptions and receiving air yards, skill red zone, and offensive and team offensive snaps.
  - IDP: defense, defensive and team defensive snaps, and special-teams snaps.
  - K: kicking.
  - P: punts, punt yards and inside 20.
  - Dropped: first downs, with-assist tackles and targets (ext), times pressured, completions and yards allowed, made-FG distance sum, punt net, touchback and inside-5 to 15 sums, and each player's gsis id.
  - `fields` is filtered to the same list. `cov` is kept for the kept fields.

## 3. Week 11 projections (draft `/api/player-projections`)
- The ids are every rostered player in the base roster read: 486 ids, ascending, in 7 groups of at most 80 (the route's `MAX_IDS`). Each group is one primary-key search: `SEARCH ups_player_projections USING INDEX sqlite_autoindex_ups_player_projections_1 (season=? AND week=? AND player_id=?)`.
- rows_read was 141, 144, 136, 133, 128, 137 and 9, for **828** in total. That is more than the 342 rows returned, because each id is an index probe. 342 ids have a stored row; 144 are `null` (no stored row, shown as Not available, never 0).
- The answers keep the route's body as is: `projected_score`, `captured_at`, `first_projected`, `first_captured_at` and `capture_count`, with provider "MFL projectedScores (captured)". Nothing was trimmed.
- **Kickoff check against the recorded schedule:** the generator now keeps each game's `kickoff` and each club's `isHome` from the same 2026-11-22 schedule read. All 13 Week 11 games have a kickoff. Using the player's current MFL club (the only club known for an unplayed week), all 342 stored rows have `captured_at` before his club's kickoff. None needed `first_captured_at`, and none was captured after kickoff.
- The app's projection display, and its pregame rule (`captured_at` < kickoff, else `first_captured_at`, else Not Available), belong to the Performance work. This capture only supplies the data.

## Budgets
- **D1:** 37,550 rows read in total: one fill of 36,722 plus 828 for projections. The budget was 120,000. 0 rows written.
- **Bundle:** `src/recorded_data.js` grew from 1,585,729 to 2,704,458 bytes, **+1,118,729 bytes (1.07 MB)**. The budget was 1.5 MB. The growth is made up of:

| Part | Size |
|---|---|
| Game stats | 399.5 KB (1,911.9 KB raw) |
| Season totals | 611.8 KB (1,072.1 KB raw) |
| Projections | 56.0 KB |
| Schedule kickoff and home flags on the base routes | the rest |

  The test size cap (3 MB) still holds.

## How the app serves it
- `lib/recorded.js` answers by canonical route, with no network fallback. A projection request for any set of **recorded** ids of the same season and week is answered with exactly those ids' recorded entries. If any requested id was not recorded, the whole read is a counted 404-like miss. The recording never claims "no projection" for a player it did not record.
- `lib/data.js`:
  - `loadWeeklyBox` reads the recording in recorded mode. A player who was not recorded is a counted miss, which the loader reports as `absent`.
  - The new loaders are `projections(season, week, ids)` and `positionSeasonStats(season, through, group)`.
  - Live, the two draft routes answer 404 until #1515 is deployed. The loader reports that as `absent`, keeps it for the freshness window (5 and 60 minutes), and never retries it in a loop.
- Tests (`tests/mobile2027_recorded.test.mjs`):
  - Zero network while every screen is tapped, including a profile's Breakdown, every view and a game detail.
  - xFP PPG and Over Expectations read Not Available on every card.
  - The manifest matches the bundle, and the trimming tests pass.
  - The loaders read only the recording.
  - An unrecorded player is a counted miss.
  - Live 404s are not retried in a loop.

## Not verified
- The real deployed cost of the two draft routes (they are not deployed).
- Authenticated owner behavior, and real Safari.
- The game detail's "read <time>" line shows when the recording was served, not when it was captured. That line belongs to the Breakdown, not to this capture.
