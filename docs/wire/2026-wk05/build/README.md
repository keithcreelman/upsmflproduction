# Week 5 build scripts

These are the one-off scripts behind `site/wire/articles/2026/2026-wk05-ups-center.html`. The permanent builder proposal is §6 of `../../2026-wk05-review.md`.

**Layout they expect:**
- a data folder holding these scripts;
- the PR worktree next to it as `../wt5`.

**Caches are not committed.** `pull.py` re-pulls MFL and the small D1 history tables, about 7.2k rows read. The nflverse files come from nflreadpy, as `facts.py`'s docstring lists.

**Run order:**
1. `pull.py`
2. The nflverse pulls.
3. `teams.py`, `survival.py`, `players.py`, `scan.py`, `hist_players.py`
4. `facts.py`, then `facts_hist.py`
5. `build_wk05.py`
6. `wire.py index` and `wire.py verify`
7. `verify_wk05.py`, then `shots.js` (Playwright layout check)

**What the committed outputs hold:**
- `../claims_wk05.json`: every number the new segments print, with its source.
- `../verify_wk05.json`: the 60 independent checks.

The quote check reads the local sources snapshot in `~/Library/Caches/upsmfl-ups-center-auto/`; raw chat never enters the repo.
