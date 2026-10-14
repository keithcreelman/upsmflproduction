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

**Revision 2 (Keith's writing review, 2026-10-14):** `build_wk05_v2.py` replaces `build_wk05.py` as the builder; `build_wk05.py` stays for the record. Run it after step 4 plus `facts_v2.py`.

**Revision 2 run order:**
1. Steps 1–4 above.
2. `python3 ../wt5/pipelines/etl/wire/season_sim.py` and `week_preview.py`, with the cached inputs, after the division tiebreak fix.
3. Recover the pre-fix forecast. The "Since Wk 3" caption reports how far the fix moved playoff odds, so the builder reads it: `mkdir -p prefix && git -C ../wt5 show 2feb7061:site/wire/data/season_sim_2026_live_wk05.json > prefix/season_sim_2026_live_wk05.json`
4. `facts_v2.py`, then `build_wk05_v2.py`.
5. `wire.py restyle`, `wire.py index` and `wire.py verify`.
6. `verify_wk05.py` (75 checks), `test_season_sim_divisions.py`, then `shots.js`.

**What the committed outputs hold:**
- `../claims_wk05.json`: every number the article prints that is not reused from validated automated claims, with its source.
- `../verify_wk05.json`: the independent checks (75 in revision 2).

The quote check reads the local sources snapshot in `~/Library/Caches/upsmfl-ups-center-auto/`; raw chat never enters the repo.

**Publication (2026-10-14, Keith's go):**
- `../mfl_injuries_pub.json` plus `.fetched` is MFL's injury feed, fetched just before publishing. It is the source of the timestamped "Dowdle at publication" line. The builder reads it from the data folder.
- The publish commit sets `status: live`, `publishedAt` and `featured: yes` in the wire-meta.
- Run `verify_wk05.py` with `WK05_STAGE=live`.

