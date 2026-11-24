# Methodology and provenance

**Scope:** a point-in-time model of weekly UPS punter points, built as a draft; nothing merged, deployed or written to MFL or production D1. Window: 2012–2026 (2010–2011 are burn-in history; 2011 UPS scoring differs). Training ≤2023, selection 2024, **locked test 2025 (run once)**, prospective 2026.

**Pipeline (all in `scripts/punter/`):** `extract_pn_rules.py` → `build_scoring_audit.py` (gate) → `build_pbp_slim.py` → `build_team_games.py` → `build_weekly_features.py` → `build_drive_dataset.py` → `build_punter_games.py` → `train_volume_model.py` / `run_hypotheses.py` / `run_backtest.py` / `run_rolling_cv.py` / `run_decision_validation.py` → `run_locked_test.py` (one-shot; refuses a second run) → `run_shadow_2026.py`, `report_stats.py`, `report_smoke_tests.py` → `run_weekly_projection.py` → `build_reports.py`.

**Model:** expected punts = team Poisson GLM (volume + opponent + Vegas + coaching + league drift); drives from a ridge model; drive count drawn around the forecast and punts as Binomial(drives, punt rate); inside-20 ~ Binomial with probability from a logistic GLM on a league line-of-scrimmage/weather curve + punter opportunity-adjusted skill + league drift; gross average from a ridge model on punter skill, field position, weather and league drift, with per-punt standard deviation 8.9 and a game-level shock; blocked punts at the punter's shrunk rate; exact UPS scoring applied to each simulated game; 10,000 games per punter for projections.

**Rules followed:** only earlier games feed any feature (tests include scrambling all 2025+ outcomes); byes are not games; punter skill follows the punter, team context follows his current team; 2025 was not used for any choice and the locked run is attributable to commit `e80b7070`; 2026 projections are archived with UTC cutoff, data-through date, code commit and input hashes.

**Departures and honest limits**
1. The "drive-level multinomial outcome model" was approximated: drive results were modeled as TD/FG/punt/turnover/downs counts in the team Poisson/binomial structure and the Monte Carlo, not as a separate drive-by-drive multinomial classifier. The decomposed drives × punt-rate comparison is included; a per-drive multinomial was not built.
2. Vegas: nflverse lines (close to closing) stand in for the Wednesday/Sunday number; weather is observed, not forecast. Both likely overstate the information available at a Tuesday lineup deadline.
3. Not available point-in-time in these sources: starting QB, injuries, depth chart, offensive-line injuries, hang time, coverage-unit effects, coach fourth-down aggressiveness over expected (only raw go rates). A punter's team is assumed from his previous game.
4. Hyperparameters (half-lives, shrinkage constants) were fixed a priori, not tuned.
5. Official 2011–2025 MFL scores came from the 2026-06-05 local archive rather than production D1 (to avoid metered reads); the archive's values were cross-checked against live MFL reads for 2012, 2013 (15 weeks), 2020 and 2025: all 1,919 matched player-weeks were identical.
6. 2026 Week 7 MFL scores were unposted at pull time; that week uses reconstructed points. The first 2026 shadow block printed by the locked-run log used those zeros and was replaced.
7. The proxy waiver pool is not true availability.
8. Touchbacks are not a UPS scoring event and are not forecast.
9. Dev-mode runs tuned nothing on 2025; after the lock, only descriptive statistics (`report_stats.py`) and the unposted-week fix (which cannot touch 2025) were added.
