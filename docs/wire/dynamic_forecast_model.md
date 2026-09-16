# UPS Wire — Dynamic Forecast (Phase 1)

**Status:** built and verified against real 2026 Week 1 data, uncommitted.

## UPDATE (2026-09-15, same day) — the permanent-shock model is no longer the published number

You flagged that the correction felt like too strong a market reaction for one week. That was correct, and the mechanism is exactly what §6(b) below already named: the shock was being applied **permanently**, to all 13 remaining weeks, with no decay. Fixed the same day, before any backtest — this didn't need one to see:

- **Official / published number, as of this fix:** `run_live()` now runs the simulation **without** the permanent per-team shock. Played weeks are still banked as real results; every future week uses this run's live rosters and MFL projections (already "refreshed," not stale preseason data) — but a team's own season-long quality error is still drawn from the shared, un-updated prior, same as a fresh preseason run. This is Model C from your Phase 2 brief ("projection refresh only, no residual") — your own recommended interim production model, and it turns out to already be one line to build, because `run_live()` was refetching live data every time regardless.
- **Shadow / internal only:** the Bayesian posterior-shock model (what this whole document originally described as the headline result) still runs, in parallel, every time — its numbers now live under each team's `shadowShock` key in the output JSON. It is not read by any Wire prose or table. It exists so the two can be compared, and so it's ready to score once a real backtest exists.
- **Regenerated:** `site/wire/data/season_sim_2026_live_wk01.json` and the `2026-wk01-recap` pack/article. HammerTime's *published* number moved from 11.6% preseason to **16.0%** title odds (**+4.3 points**, labeled "Prior confirmed") — not 33.7%. The 33.7% figure below is now historical: it's what the shadow model would have said, kept for comparison, never printed on the page.

The rest of this document describes the shadow model's mechanics — still accurate, just re-scoped to "the thing running in the background for later validation" rather than "the thing on the page." A companion tier-1 empirical check (real 2015-2025 scores, no projection archive needed) is in `pipelines/etl/wire/persistence_study.py` / `site/wire/data/persistence_study_2015_2025.json`.

**Files touched:** `pipelines/etl/wire/season_sim.py` (extended), `pipelines/etl/wire/wire_data.py` (`offense_repeatability`, new), `pipelines/etl/wire/packs/weekly_recap.py` (`load_live_forecast`, `forecast_signal`, the `t.preseason` table), `pipelines/etl/wire/persistence_study.py` (new). Data files: `site/wire/data/season_sim_2026_live_wk01.json`, `site/wire/data/persistence_study_2015_2025.json`.

---

## 1. What this replaces / extends

Two systems already existed, built independently, that never talked to each other:

| | `season_sim.py` (preseason) | `wire_data.playoff_odds()` (in-season) |
|---|---|---|
| Input | Today's roster + today's MFL weekly projections for all 17 weeks | Each team's actual scoring mean/SD through the current week |
| Output | `pTitle`, `pPlayoffs`, `pDivision`, `pBye`, `expAllPlayPct`, power rank | Playoff-make odds, division odds only |
| Knows about in-season results? | No — one-shot, overwrites its own output file on every rerun | N/A — it only ever looks at results, never the preseason forecast |

Phase 1 adds a third mode to `season_sim.py` — `run_live()` / `--through-week N` — that produces the missing thing: **title/playoff odds that blend the preseason forecast with actual results**, using the exact same calibrated bracket simulation `season_sim.py` already runs and already backtested, instead of a new empirical model.

## 2. The model, mechanically

`simulate()` (`season_sim.py:346-`) already worked like this for the preseason case:

```
score[team][week] = wp[team][week] + shock[team] + noise[week]

shock[team]  ~ N(0, sigma_s²)   -- drawn ONCE per simulated season: this team's
                                    constant quality error the projection missed
noise[week]  ~ N(0, sigma_w²)   -- drawn fresh every simulated week
```

`wp` is the MFL weekly projection after the already-backtested regression dial (`k=0.7`, `season_sim.py:296-328`). `sigma_w` and `sigma_s` are not guessed — they're fit so the simulated variance matches **real 2021-2025 UPS history**:

- `sigma_w` (week-to-week noise): fit so within-team season variance of weekly score = **943.2** (measured on real data, `season_sim.py:94`)
- `sigma_s` (season-long team-quality error): grid-searched so the spread of season all-play % across the 12 teams = **0.0238** (also measured on real data, `season_sim.py:95`)

**This week's actual calibrated values** (from `site/wire/data/season_sim_2026_live_wk01.json`):

```
sigma_w = 29.94
sigma_s = 13.95
```

### 2.1 What's new: fixing known weeks + updating the shock

Two additions to `simulate()` (`season_sim.py:346-354`, params `actual=None, posterior=None`):

1. **Played weeks are fixed, not simulated.** For week ≤ `through_week`, `score[week]` is the real recorded score, not `wp + shock + noise`. What happened isn't a random variable.
2. **The shock is no longer drawn from the shared prior — it's drawn from each team's own posterior**, computed once before simulating:

```
posterior_shock(wp, actual, sigma_w, sigma_s, fids)   -- season_sim.py:485-514
```

This is a standard normal-normal conjugate Bayesian update. For a team with `n` played weeks and average deviation from its own projection `d̄ = mean(actual[week] − wp[week])`:

```
prior precision      = 1 / sigma_s²
likelihood precision = n / sigma_w²
posterior precision  = prior precision + likelihood precision
posterior mean        = (likelihood precision × d̄) / posterior precision
posterior SD          = sqrt(1 / posterior precision)
```

At `n=0` this returns `(0, sigma_s)` — identical to the preseason prior, so a live run before week 1 reproduces the old preseason output exactly.

**Why this instead of your spec's `posterior_ap_pct = weighted avg of prior% and actual%` formula:** that formula needed a guessed "prior = 3 to 4 equivalent weeks" parameter. This one doesn't need a guess — the crossover point is *derived* from the two calibrated numbers above:

```
n* (equivalent weeks) = sigma_w² / sigma_s² = 29.94² / 13.95² = 4.61 weeks
```

That's close to your own 3–4 week guess, but it comes out of the same backtest that already validated `k=0.7`, not a new unvalidated knob. At `n=1` week, the weight on new evidence is `1/(1+4.61) = 17.8%` — i.e., a team's estimated true quality moves only about a fifth of the way toward what one week implied. Everything downstream (title odds, playoff odds, projected-ending all-play) falls out of running the *same* bracket simulation forward with this updated shock, on the real 37-game schedule.

## 3. Worked example: HammerTime (Eric Martel) — shadow model, not the published number

Exact numbers from the committed snapshot (shadow model — see the update at the top; the number actually on the page is 16.0%, +4.3 points):

| Quantity | Value | Where it comes from |
|---|---|---|
| Preseason season-average projected weekly score (`wp`, regressed) | 206.1 | `season_sim_2026.json`, `projWeeklyRegressed` |
| Week 1 actual score | 312.8 | MFL `weeklyResults` |
| **Deviation used by the update** (week-1-specific `wp`, not the season average shown above — see caveat below) | ≈ 118.3 | back-solved from the stored result |
| Posterior shock mean | **+21.09** | `season_sim_2026_live_wk01.json`, `posteriorShockMean` |
| Posterior shock SD | 12.65 (down from prior 13.95) | same file |
| Preseason title odds | 11.6% | `season_sim_2026.json`, `pTitle` |
| **Current title odds** | **33.7%** | this week's simulation |
| Title odds change | **+22.1 points** | |

**Caveat on the table above:** `projWeeklyRegressed` (206.1) is the *season-average* projected score, not week 1's own projection specifically — weekly projections vary game to game (matchups, byes elsewhere in the league). The code uses the exact week-1 value (`wp[fid][1]`); I back-solved the ≈118.3 figure from `posterior mean ÷ 0.178`. If you want the literal week-1 number logged for a full audit trail, that's a one-line addition to `run_live()`'s output — flag it and I'll add it.

**Sanity-check the weight:** `21.09 ÷ 118.3 = 17.8%` — matches the derived `n*=4.61` weeks formula above exactly. The math is doing what it's supposed to: taking one huge outlier (118 points over projection — about 4 standard deviations of single-week noise) and shrinking the season-long belief-update down to about a fifth of that, not taking it at face value.

## 4. The repeatability index (offense only)

`wire_data.offense_repeatability()` (new) splits each team's starting-offense points into touchdown/turnover-driven ("volatile") vs. everything else ("repeatable" — yardage tiers, receptions, first downs: all volume-driven). The point values are **not assumed** — pulled live from this league's actual MFL `TYPE=rules` export on 2026-09-15: every offensive touchdown (rush, reception, or pass) scores **6** in this league, every turnover (INT thrown, fumble lost) scores **-2**.

```
volatile_pts    = 6 × (rush_tds + rec_tds + pass_tds) − 2 × (interceptions + fumbles_lost)
repeatable_index = 1 − (volatile_pts / total_offensive_points)
```

HammerTime's week 1: **63.8% repeatable** — meaning roughly 36% of their 193.2 offensive points came from touchdown/turnover swings rather than sustained volume. This is currently used **only for the "Signal" label** (see below) — it does **not** feed back into the Bayesian update itself. That's the biggest structural gap; see §6.

IDP is deliberately not split this way — there's no pressure-rate or tackle-opportunity data in D1 to build a real defensive repeatability metric (only snap-share as a rough proxy), so per your instruction, IDP just keeps using MFL's own weekly projections as the signal (via the existing boom/bust-vs-projection facts), not a fabricated usage score.

## 4.5. Naming the cause: injury attribution (added 2026-09-15, same day)

Tracing why The Long Haulers (Brian Cross) cratered relative to a much worse week from L.A. Looks led to A.J. Brown -- on IR, out 6 weeks, hurt in the Week 1 opener itself (2026-09-09) but not caught by MFL's own injury feed until after the preseason snapshot had already run (2026-09-12). That's not a one-off: checking the whole league turned up 6 of 12 teams currently carrying an absence large enough to matter, none of which the preseason forecast could see (it never applies injury logic at all, by design).

`season_sim.py`'s new `biggest_absences(prep, cache_dir, min_points=8.0)` finds, per team, the single largest real, sourced absence. **First version was wrong** -- it used the absent player's own raw value as "points lost," which assumes the roster slot goes empty. Keith, 2026-09-16: "keep in mind players lost especially those on IR we will find a replacement on WW. Plus we have replacement on our bench." Fixed to a NET calculation: rerun the same lineup optimization the model already applies, with the player's typical value restored for his absent weeks, and diff against the current (already-without-him) optimum -- so the number reflects what the team actually loses after the best available bench/wire body fills the slot, not the player's full value. That fix mattered a lot: A.J. Brown's raw value was ~12.6/wk; his NET cost to Cross is ~1.4/wk, because Cross's other receivers already sit in the same tier. Only Cross/Brown clears the (now much smaller) bar leaguewide once every other flagged absence is netted properly -- IDP replacement level in this league is notoriously flat, so most defensive IR losses cost close to nothing once you credit the bench.

`run_live()`'s output carries this as `biggestAbsence` per team; `weekly_recap.py`'s `injury_phrase()` renders it ("no A.J. Brown for 6 weeks (ankle)") and appends it to that team's Signal cell. This is the "Injury downgrade" attribution Phase 1 had explicitly deferred (see the original text of section 5 below) -- it needed real per-player absence data, not a bigger guess, and that data was already sitting in `absences()`.

### 4.5.1. A second, distinct cause: a still-rostered player whose own projection genuinely fell

Netting Brown's absence properly revealed the real question was still open: Keith, "can't you compare current projections vs what you had?" `season_sim.py` doesn't archive projections, but a separate table does -- `ups_player_projections` (D1), capturing every player's own week-1 MFL projection repeatedly since 2026-08-02, independent of and unrelated to `season_sim.py`'s own live fetches. Pulling Cross's full offensive roster against it found the real explanation: **Quentin Johnston** (traded for in July) had his week-1 projection captured at 13.7 back in August, now sitting at 7.7. Netted the same way as an absence (restore his old value, re-optimize, diff), that's **~5.5-5.6 pts/week, ~88-89 points over the remaining season** -- unlike Brown, nothing in Cross's WR room sits where Johnston used to, so the team absorbs almost the full decline.

New `biggest_decliners(prep, cache_dir, min_points=8.0)` generalizes this leaguewide. **First version had a real bug**, caught before shipping: it extrapolated the observed week-1 decline onto weeks 2+ by a MULTIPLICATIVE ratio (`current_avg * first/now`), which explodes when `now` is small -- it "restored" a backup TE (Kenyon Sadiq, projected 3.1) to 24 points/week, and a healthy RB (Chuba Hubbard) to 25, because their CURRENT week-2+ averages were already close to their ORIGINAL week-1 number -- the week-1 dip was a one-week matchup wobble, not a real decline, and extrapolating it fabricated a number. Fixed with a consistency gate: only trust the decline as durable if the player's current week-1 number is close to his own current week-2+ average (within 25%, or 2 points, whichever is larger) -- i.e., his current LEVEL is stable, not a one-off. Restoration itself switched from a ratio to a flat point offset (`cur_avg + (first - now)`), immune to the small-denominator blowup even as a backstop.

**Second bug, caught by Keith directly** ("is this 16.1 for Godwin his original weekly average for the season? That's elite numbers and feels like it might've been just Week 1 projection?"). He was right, and not just about Godwin: checking all 5 first-pass decliners against their own CURRENT full-season weekly range found 3 of 5 -- Chris Godwin (16.1), Michael Penix Jr. (14.6), Jake Tonges (13.4) -- had a `first_projected` value the model has never shown that player again, in ANY week, even a good matchup (Godwin's whole current range is 7.0-9.2). `first_projected` is captured as early as 2026-08-02, deep offseason, before camp battles and roles settle -- these three were unreliable first captures, not real levels the player fell away from. Only Quentin Johnston (hits 14.4 in week 8) and Rome Odunze (hits 16.8 twice) had a credible original number. Added a third, PLAUSIBILITY gate: `first <= max(current weeks 2+) * 1.15` -- the claimed old level must be something the model still sometimes produces for that player today. After this fix: 3 of 12 teams have a real, named decliner (Johnston/Cross ~89 pts, Odunze/Josh Martel ~114 pts, and a smaller, newly-surfaced Quinshon Judkins/Blake Bombers ~45 pts, 10.5->7.5, comfortably inside his own current range). Godwin, Penix, Tonges, Hubbard, Rice and Sadiq all correctly dropped out.

`weekly_recap.py`'s `best_cause_note()` picks whichever of `biggestAbsence`/`biggestDecline` nets the larger point swing per team and renders it in the Signal cell -- one named, real cause, whichever actually explains more of the movement.

## 5. The Signal label

`forecast_signal()` (`packs/weekly_recap.py`) — pure threshold rules on `(title_odds_change, repeatable_index, weeks_played, is_biggest_mover)`:

```
|change| < 2pp                          -> Neutral
|change| < 5pp                          -> Prior confirmed
change > 0, repeatable_index < 60%      -> Variance-assisted
  (...and it's the week's single biggest riser, week 1 only) -> Early overreaction risk
|change| >= 15pp                        -> Strong upgrade / Strong downgrade
else                                     -> Moderate upgrade / Moderate downgrade
```

**Deliberately not implemented:** "Injury downgrade" and "Schedule-assisted." Both would require tracing a specific team's move to a specific absence or opponent strength, not just the move's size — I didn't want to fake that attribution. Every downgrade currently reads as Strong/Moderate/Neutral regardless of cause. The pack emits a warning saying this every time the table is built, so it can't ship silently.

## 6. Why this might feel like a strong correction — and what to actually check

Three real mechanisms, roughly in order of how much I'd suspect each:

**(a) The repeatability index isn't fed into the update math — only the label.** HammerTime's 118-point outlier is treated as equally informative regardless of whether it came from sustained volume or a few touchdown swings, even though we *know* (from §4) that ~36% of it was TD/turnover-driven. A more conservative design would discount `d̄` by the repeatable share before running it through the Bayesian update — i.e., a lucky week moves the season-long rating less than an identically-sized volume-driven week. This is the single most defensible lever to pull if 33.7% feels too high, and it's a natural extension of infrastructure that already exists (§4) rather than new work.

**(b) The shock compounds across every remaining week, with no decay.** `shock[team]` is added to *every one* of the ~13 remaining weeks in each simulated trajectory — it's modeled as a permanent re-rating of the team's quality, not a one-time bump. A +21 point/week shock, sustained for 13 more weeks, is a real season-level claim from one data point (properly shrunk to 17.8% weight, but still permanent). An alternative: let the shock decay toward zero over the remaining schedule, or cap its magnitude, so one extreme week can't single-handedly re-rate a team for the whole season.

**(c) Title odds are a nonlinear statistic — a modest scoring-strength shift produces a large odds swing.** With 12 teams and one champion, moving a team from "middle of the pack" to "clearly above average" moves title odds more, in relative terms, than the same absolute shift does near the extremes. An ~10% increase in expected weekly score (206 → 227) producing a ~3x relative jump in title odds (11.6% → 33.7%) isn't inherently a bug — it's how any well-specified title-odds model behaves — but it's worth knowing this amplification exists before eyeballing the percentage-point number.

## 7. Open question — the actual answer, not a guess

**Whether this magnitude of correction is right or excessive is an empirical question, and I haven't answered it yet.** `season_sim.py` backtests the *preseason* regression dial (`k=0.7`) against 2021-2025 real outcomes — that's the only validated piece. Nothing has yet checked whether *this specific blending approach*, replayed on those same five seasons' actual week-by-week results, produces well-calibrated in-season odds (a team that gets bumped to 33.7% should win the title about 33.7% of the time, across many such situations) or systematically overreacts.

That backtest — replay `run_live()` week-by-week on 2021-2025 real results, score the same way `season_sim.py`'s existing backtest does (Brier score, calibration by bucket) — is exactly what Phase 2 was already scoped to include, and it's the direct, data-driven way to settle "does this feel too strong" instead of debating priors. It's blocked on real data, though: it needs archived point-in-time weekly projections, and MFL has never stored those — the earliest honest snapshot is this week's (`ups_player_projections`, started 2026-09-15). A multi-season answer to this exact question is a multi-season wait, collected prospectively from here forward.

**What is buildable today without that archive:** `persistence_study.py` regresses real 2015-2025 team scores (no projections at all) — early-weeks average vs. remaining-weeks average, season-demeaned, pooled across every team-season — and compares the empirical slope to the model's derived weight `w(n) = n/(n+n*)`. It's a cruder, different quantity (raw-score persistence, not projection-surprise persistence — see the script's docstring for why), but it's real evidence, available now, on the general question of "how much should N weeks of hot scoring move a season-long belief."

**Result (2026-09-15, 120 real team-seasons, 2015-2025 excluding 2011-2014/2016 which MFL's API won't serve for this league):**

| Early weeks | Team-seasons | Empirical slope (95% CI) | Model's w(n) @ n\*=4.61 |
|---|---|---|---|
| 1 | 120 | 0.188 [0.101, 0.274] | 0.178 |
| 2 | 120 | 0.342 [0.226, 0.458] | 0.303 |
| 3 | 120 | 0.441 [0.310, 0.572] | 0.394 |
| 4 | 120 | 0.523 [0.381, 0.665] | 0.465 |

The model's derived weight sits inside the empirical 95% CI at every horizon tested, and is slightly below the point estimate at each one — i.e., real history says the shrinkage math is if anything a little conservative, not aggressive. This rules out "the weighting fraction itself is too aggressive" as the explanation for the correction feeling strong. The actual cause was mechanism (b) above (permanent, non-decaying application across all remaining weeks), which the interim fix already removes. Full output: `site/wire/data/persistence_study_2015_2025.json`.

Standing caveat (see the script's docstring): this is raw-score persistence, not projection-surprise persistence — it mixes in "this team drafted well and was always going to score above average," which the preseason projection already knew and isn't new week-1 information. Read it as a sanity check on the shrinkage math's general shape, not a full validation of the live-update model end to end.
