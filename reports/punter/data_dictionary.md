# Data dictionary (punter model)

All point-in-time columns use only games played **strictly before** the game being projected (test: `tests/punter/test_point_in_time_features.py`, which scrambles every 2025+ outcome and requires every 2012–2024 feature to be unchanged).

## Sources
| Source | What | Pulled | Notes |
|---|---|---|---|
| MFL `TYPE=rules`, `allRules` | scoring rules, event dictionary | 2026-10-29 | public export, league 74598 and its pre-2017 ids |
| MFL `playerScores` (PN) | official weekly punter points | 2011–2025 from local archive `mfl_database_2026-06-05.db` (not re-read from production D1); 2026 direct from MFL | MFL had not posted 2026 Week 7 |
| nflverse play-by-play (`nflreadpy.load_pbp`) | every punt, drive, EPA | 2010–2026 | 2026 through Week 7 |
| nflverse schedules | spread, total, roof, temp, wind, coaches, stadium | 2010–2026 | see Vegas/weather caveats |
| nflverse `load_ff_playerids` | MFL id ↔ gsis id crosswalk | 2026-10-29 | stable player identity |

## Files (git-ignored parquet, rebuilt by scripts)
| File | Grain | Built by |
|---|---|---|
| `pbp_slim.parquet`, `schedules.parquet`, `ff_playerids.parquet` | play / game / player | `build_pbp_slim.py` |
| `team_games.parquet` | team-game outcomes (post-game facts) incl. scheduled-but-unplayed rows | `build_team_games.py` |
| `team_features.parquet` | team-game **pre-game** features | `build_weekly_features.py` |
| `punts.parquet`, `los_curve_coef.npy` | one row per non-blocked punt; expected inside-20 from the LOS curve | `build_drive_dataset.py` |
| `punter_games_pbp.parquet`, `scoring_audit_all_rows.csv` | punter-game box from play-by-play; audit | `build_scoring_audit.py` |
| `punter_games.parquet`, `punter_state_current.parquet` | punter-game table with point-in-time punter skill; state after last game | `build_punter_games.py` |

## Team features (`o_*` = team offense, `d_*` = defense allowed, `opp_*` = the same for the opponent)
Each is an exponentially weighted mean over the team's **prior games** (half-life 6 games, ×0.65 weight for games from an earlier season, shrunk toward the league mean as of that date with 2 pseudo-games). Byes are not games, so they are never zeros.

| Column | Meaning |
|---|---|
| `o_epa`, `o_sr`, `o_early_epa` | EPA/play, success rate, 1st–2nd down EPA (run + pass plays, regular season) |
| `o_pass_rate`, `o_sack_rate`, `o_third_rate`, `o_third_ytg` | pass rate; sacks per dropback; third-down conversion; avg third-down distance |
| `o_to_rate`, `o_tod_rate`, `o_fg_rate`, `o_td_rate`, `o_tno_rate`, `o_punt_rate` | per-drive rates: turnover, turnover on downs, field goal attempt, touchdown, three-and-out, punt |
| `o_ppd`, `o_ypd`, `o_start_yl`, `o_drives`, `o_plays` | points/drive, yards/drive, avg starting yard line, drives/game, plays/game |
| `o_go_rate` | fourth-down attempts ÷ (go + punt + field goal decisions) |
| `o_punt_los` | average distance to the opponent goal line at the team's punts |
| `spread`, `total_line`, `implied` | pregame spread (+ = this team favored), game total, team implied total = (total ± spread)/2 |
| `home`, `dome`, `wind`, `temp`, `altitude` | home team; dome/closed roof; mph; °F (NaN→0 / 68 when closed); Denver home = 5,280 ft |
| `coach` | head coach name (used by the hierarchical model only) |
| `lg_punt_rate`, `lg_i20_rate`, `lg_gross` | league-wide punts/drive, inside-20 rate and gross average over the previous 6 played weeks (captures year-to-year drift) |

## Punter state (`pk_*`; the punter's own earlier games on any team)
| Column | Meaning |
|---|---|
| `pk_gross` | gross yards/punt, game-decayed (half-life 24 games), shrunk to the league mean with 80 pseudo-punts |
| `pk_i20_resid` | (inside-20 − expected inside-20 from the league LOS/weather curve) per punt, shrunk with 100 pseudo-punts |
| `pk_tb_resid`, `pk_blk`, `pk_ppg` | end-zone punt residual, blocked-punt rate (shrunk), punts per appearance |
| `pk_ups_last4`, `pk_ups_std`, `pk_ups_prev`, `pk_ups_ew` | prior UPS points: last 4 games, season-to-date, prior season, weighted |
| `pk_n_games`, `pk_n_punts` | his earlier games and punts (0 = no history) |

## Caveats that matter
- **Vegas:** nflverse stores one spread/total per game (close to the closing line), so "pregame Vegas" is a proxy for what was knowable at the projection cutoff; for upcoming games the posted line is used and games with no posted line use a no-Vegas model.
- **Weather:** observed game-time weather stands in for the forecast historically; for upcoming games no forecast is stored and outdoor weather is set to neutral (8 mph, 58°F).
- **Starting QB, injuries, depth charts and offensive-line injuries are not used** (not available point-in-time in the sources). A team's punter is the punter from its previous game.
- **Net average, hang time, directional and fair-catch rates** exist only as descriptive statistics (H6); hang time is not in the sources.
