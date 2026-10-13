# Pts Agst default window: walk-forward backtest (locked)

**Question.** Which amount of recent history best predicts how a defense will do against a position in its *next* game? Should Stats → Pts Agst default to Last 3, Last 8, Full season, or something else?

**Answer (locked 2026-10-13).** Default = **Full season, through the latest completed game**, for every position.
- No shorter window ordered next-game matchups materially better.
- Only **QB, TE, DL and DB** show any next-game signal above a coin flip, and it is weak (52–55 correct orderings in 100).
- RB, WR, LB, K and P show none.

The full tables are in [REPORT.md](REPORT.md).

## What was tested

Every **target game** in 2019–2025 is one NFL defense, one position, and that defense's next final game. The test only uses games already completed before it: for every target, the defense has at least one completed game this season and a previous season exists.

Each target is scored on three things:
- **Points:** the UPS/MFL points that position scored against the defense.
- **Schedule-adjusted:** those points ÷ the players' **usual entering the game**. Usual = each player's average over his earlier games this season (else last season).
- **No leakage:** the target game never enters any predictor, any usual, the league average or the league ratio.
  - A past game's usual excludes that game.
  - Recency is the defense's last *N* completed **games**, so a bye is not an observation.

The windows compared:
- Last 1, 2, 3, 4, 5, 6 and 8 completed games
- Season to date (= Full season)
- Previous full season
- Season to date blended with the previous season (c = 0.05–1)
- Exponentially weighted form (half-lives 1, 2, 3, 4, 6 and 8 games)

Each window is scored both unshrunk and shrunk toward the league, with k chosen leave-one-season-out. Every method is compared with:
- the league average;
- season to date;
- the players' usual with no defensive adjustment.

All comparisons run on one **common sample** per position.

The metrics:
- **Rank accuracy:** pairwise ordering within each week's slate. This is the main metric, because the board is a ranking.
- MAE and RMSE, scored in points.
- Pearson and Spearman correlation.
- Top-minus-bottom-quartile lift.
- Direction accuracy.
- Each by season and by point in the season.
- Paired cluster-bootstrap intervals, resampling season-weeks.

## Rules, written before the holdout was scored

1. **Selection (`phase1.py`, 2019–2024 only).**
   - Per position, the window with the best rank accuracy wins.
   - It replaces Full season only if its 95% interval of the gain is above 0 and it is better in at least 4 of the 6 seasons.
   - The output is `locked/selection.json`, sha256 `af5a2637…`.
2. **Holdout (`phase2.py`, 2025).** Re-scores only that frozen choice. A replacement must still beat Full season on 2025, or Full season stays. Output: `locked/results_2025.json` and `locked/final_defaults.json`.
3. **Product (`make_product.py`).**
   - A window becomes a position's default only if the gain is **material**: at least 2 points of rank accuracy in both periods, with both intervals above 0.
   - "Signal" means the default's rank accuracy is above a coin flip in both periods.
   - Output: `locked/pts_agst_default_window.json`. The mobile app's `FPA_DEFAULT_WINDOW` and `FPA_EVIDENCE` must equal this file (`tests/pts_agst_default_window.test.mjs`).

## Reproduce

All inputs are read-only: MFL GETs and D1 SELECTs.

```
python3 fetch_inputs.py /tmp/pts_inputs      # MFL exports 2018–2026 + nflverse game-day teams (wrangler, from worker/)
python3 build_dataset.py /tmp/pts_inputs     # → dataset.json  (sha256 ab51b646… for the 2026-10-13 run)
python3 phase1.py                            # → selection.json; must equal locked/selection.json
python3 phase2.py af5a2637709829b4f5aff1ff8328367c4d09417ba6b12b42235ac7226bbc9cc9
python3 make_product.py && python3 report.py
python3 leak_test_synthetic.py               # also run by tests/pts_agst_window_no_leakage.test.mjs
```

## Known limits

- **Positions** are MFL's season-end positions.
- **Raiders, 2018–19:** 54 Raiders player-games are credited to the season-end team.
- **Cancelled game:** the 2022 Wk 17 BUF–CIN game counts as played.
- **Fixed usual:** the predictive test uses each player's usual *entering* the game. The board's descriptive Usual includes the game itself, by design.
