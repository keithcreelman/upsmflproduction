# 2026 Week 4 Elias correction: D1 repair (2026-10-08)

**Why.** Elias posted Week 4 stat changes Wed Oct 7 at 11:32:16 PM ET, and MFL applied them. D1 still held the Tue Oct 6 sync, so `/api/standings` and the standings pages showed Eric Martel at 35-9 and Shawn Blake at 31-13. MFL had 34-10 and 32-12. Root cause and fix: PR #1190.

**Scope.** Week 4 only. Weeks 1–3 were verified identical to MFL beforehand: 48/48 weekly team scores, and 0 player-score or rank mismatches in Weeks 1–3.

**Restore point.** D1 Time Travel bookmark `0000ec8b-0000066a-000050fe-fef5eab097005c3add02dc6461b2811d`, taken at 2026-10-08 13:13Z, before any write.

## Steps run

1. **No-write dry runs** of #1190's commands, with the D1 writer replaced by a recorder. Every row was diffed against D1.
   - `sync_live_season_from_mfl_to_d1.py --season 2026 --standings-only` computed rows that match MFL's `leagueStandings` for all 12 teams.
   - The diff showed:
     - `src_franchises`: 0 rows.
     - `src_schedule`: 14 rows, all Week 4.
     - `src_franchise_weekly_score`: 4 rows, all Week 4.
     - `src_standings`: All-Play changes for 0005 and 0010, and pf/pp changes for 0003, 0004, 0005 and 0012.
   - Its full write would ALSO have refreshed `src_standings.salary` for 9 teams. That column is a pass-through of MFL's current cap salary and moved with roster moves since Tuesday, so it is not part of a Week 4 repair.
2. **Standings repair.** `2026-10-08-wk4-elias-standings.sql` holds 23 guarded UPDATEs generated from that same computed output, applied with `wrangler d1 execute ups-mfl-db --remote --file`. Each UPDATE matches the old value, so a rerun changes nothing. Result: 23 queries, 23 rows written. Salary is untouched.
3. **Player scores.** `python3 pipelines/etl/scripts/sync_live_weekly_scores_to_d1.py --season 2026 --weeks 4`, an upsert of 1,201 Week 4 rows.
   - 11 scores changed: 4 rostered starters (Clark 7.6→8.9, Henley 6.0→5.5, Campbell 10.5→9.5, Bullard 6.9→6.1) and 7 free agents on Elias's list.
   - 532 rows changed rank only, because ranks are re-ordered by the corrected scores.
   - No other column changed, and the row set is identical.
4. **Derived data.** Dispatched `leaderboard-current-season-rebuild.yml` (run 37782932820).
   - All 5 aliases rebuilt at 13:15Z under a new score fingerprint. Campbell's season total is 30.0 and Clark's 43.2.
   - Not affected:
     - `ups_owner_career_stats` counts completed seasons only.
     - `player_season_wc_rank` counts starter games with a score above zero, plus win-chunks, which are empty for 2026. None of those inputs moved.

## Before and after

| Team | Week 4 score | Week 4 All-Play | Season All-Play | PF (season) |
|---|---|---|---|---|
| Eric Martel (0005) | 251.2 → **250.2** | 9-2 → **8-3** | 35-9 → **34-10** | 997.5 → 996.5 |
| Shawn Blake (0010) | 250.9 | 8-3 → **9-2** | 31-13 → **32-12** | 981.0 |
| Matt Gerardi (0003) | 207.0 → **208.3** | 3-8 | 16-28 | 799.5 → 800.8 |
| Brian Cutting (0004) | 212.1 → **211.6** | 4-7 | 22-22 | 883.1 → 882.6 |
| Chris Klingenberg (0012) | 224.7 → **223.9** | 7-4 | 25-19 | 841.5 → 840.7 |

Verified afterwards:
- **D1 vs MFL:** D1 matches MFL for all 12 teams (All-Play, H2H, PF, PP) and for all 48 weekly team scores.
- **`/api/standings`:** serves 34-10 and 32-12, and the corrected Week 4 scores.
- **Rendered standings page:** shows Martel 34-10 (77.3%) and Blake 32-12 (72.7%).
- **Consequence:** Bear Dunn and Martel are now tied at 34-10 with matching 8-2 records, and the site's seeding (All-Play %, then H2H, then PF) puts Bear first on points, 1016.8 to 996.5.
