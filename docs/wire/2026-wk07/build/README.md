# UPS Center Week 7: editor build

The automated draft (`wire/auto/2026-wk07-ups-center`, #1405) rewritten by the editor on 2026-10-27 in Week 6's show format (Keith: route 1). Not published.

- **Windows:** Weeks 1-7 = season baseline for every team; Weeks 5-7 = recent form; any streak is labeled.
- **Injuries (Keith's standing rule):** an injury is in the report only when it is new or newly relevant and changes a team's outlook. This week: DeVonta Smith (Blake), with one line on Gerardi's two. Older injuries are not repeated.
- **Plays:** Burrow has no verified NFL highlight link, so none is shown. McBride's is NFL.com-verified (from the draft).

| File | What |
|---|---|
| `rewrite_facts.py` | every number the prose uses, computed from the committed inputs and registered with its source |
| `rewrite_wk07.py` | the narrative; writes the article and `narrative_claims.json` |
| `verify_wk07.py` | whole-page check: no placeholders, balanced sections, every narrative number a registered claim, quotes verbatim and not excluded |
| `injury_wk08.py` / `injury_wk08.json` | injury impact from 2026 points per game (Weeks 1-7), as in Week 6 |
| `verify_injuries.py` | independent recomputation of the injury numbers (different lineup algorithm) |
| inputs | MFL weeklyResults W1-7, leagueStandings (W7 and W6), league, rosters, players, byes, injuries, playerScores W1-7; nflverse games played and official reports; `elias_2026_wk06.json` (the Week 6 Elias check, 2026-10-27 12:21 PM ET); `sim6.json` (the committed Week 6 forecast) |

Run: `python3 injury_wk08.py && python3 verify_injuries.py && python3 rewrite_wk07.py <article.html> && python3 verify_wk07.py <article.html>`.
Chat receipts in `chat_quotes.json` are verbatim by Discord message id from the draft's local review copy, checked against `site/wire/data/chat_exclusions.json`.
