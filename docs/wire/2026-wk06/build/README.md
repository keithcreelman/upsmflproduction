# UPS Center Week 6: editor build (injury report)

The automated draft (`wire/auto/2026-wk06-ups-center`) plus one editor segment, **Injury Report** (segment 8), added 2026-10-21 under Keith's rules.

- **Starter-caliber:** the player is in the franchise's best legal lineup by 2026 points per game with everyone healthy.
- **Per injury:** the card shows the player's rank, points per game, Weeks 4–6, slot, replacement, the lineup's points and league rank with and without him, a depth verdict (with the best free agent if one beats the replacement), and Week 7–9 bye or injury pressure.
- **McLaurin:** the deep dive covers Blake's roster, healthy versus without, the Week 7 lineup, and a counterfactual on playoff odds. `cf_sim.json` is the same simulation, same inputs and seed, with McLaurin removed from the injury feed.

| File | What |
|---|---|
| `injury_wk07.py` | the analysis → `injury_wk07.json` |
| `injury_segment.py` | renders the segment; every number goes to `injury_claims.json` with its source |
| `verify_injuries.py` | **independent** recomputation (different lineup algorithm) plus the no-unregistered-number check → `verify_injuries.json` (174/174) |
| inputs | MFL `playerScores` W1–6, injuries (feed updated Wed Oct 21, 8:01 AM ET), rosters (IDs and status only), players (ID, name, position, team), byes; nflverse games played and official reports. Fetch times are in `fetched_at.json` and `nflverse.json`. |

Run from this folder: `python3 injury_wk07.py && python3 injury_segment.py <season_sim_2026_live_wk06.json> cf_sim.json && python3 verify_injuries.py <article>`.
