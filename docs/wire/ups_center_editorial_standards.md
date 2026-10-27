# UPS Center editorial standards

Keith's rulings of 2026-10-27, applied to every edition from Week 8. The generator enforces the mechanical ones; the rest are for whoever edits an issue. Tests: `pipelines/etl/wire/test_ups_center_standards.py`.

## Probabilities
- **100% only when clinched, 0% only when eliminated.** "Clinched" and "eliminated" come from the league's deterministic engine, `site/shared/standings_clinch.js` (the standings page's X / Y / Z / E letters), run through node by `ups_center_prob.compute_clinch`. They never come from a simulation that rounds to 1.0 or 0.0.
- Everything else prints with its honest precision: `99.96%`, `0.04%`, `<0.01%`. One decimal in the middle (0.1% to 99.9%), two near the ends. `ups_center_prob.text` is the one formatter.
- The ledger keeps the simulation's own precision (`raw`, four decimals) beside the printed text.
- **Fails closed.** If node, the schedule or the standings cannot be read, there are no flags and nothing prints as 100% or 0%.
- Applies to the Playoff Picture, the Survival Line, any commentary, and the weekly recap pack's odds facts. The validator refuses any page that prints `100.0%` or `0.0%`, and the post-build check re-derives every printed probability from the committed forecast and the recorded clinch flags.

## Lineup decisions
- **Hindsight is not a decision.** A bench player outscoring a starter is a fact. It is not a mistake unless what the manager could see said so.
- A swap is judged by MFL's **pregame** projections for both players (`ups_center_lineup.judge`). A projection counts only if it was captured **before that player's own NFL kickoff** (`wire_data.pregame_projections`); a capture after kickoff is not what the manager saw and is never shown as pregame evidence.
  - Bench player projected more than one point above the starter: **miss** ("that call went against the projections").
  - Otherwise: **reasonable**, and the gap is scoring variance, not a decision.
  - No pregame projection for either player: **unknown**. The report says so and does not judge.
- A hindsight lineup is always called hindsight. The validator refuses "would have won" without it.
- The Heat Check bench columns are labeled hindsight. They are not a measure of decisions.

## Voice
- Grounded in the data. No hindsight-driven criticism, no exaggerated certainty, no unnecessary editorial language.
- Say what is not known. If a number is missing, the page says it is missing; nothing is inferred or invented.

## Known limits
- An editor-owned draft is not re-checked for these rules automatically; the editor applies them (see `docs/wire/2026-wk07/build/` for how Week 7 did).
- The Week 7 recorded fixture has no kickoff-strict projections for the 1 PM games (the only capture came at 2:04 PM ET on Sunday), so its four hindsight sentences all say the report does not judge. That is the rule working, not a gap.
