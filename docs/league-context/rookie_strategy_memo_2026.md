# 2026 UPS Rookie Draft — Strategy Memo

**Draft date:** Memorial Day Sunday, May 24, 2026.
**Cohort behind these numbers:** UPS rookies drafted **2014–2022** (n=413). This is the slice where both signals are observable — `rookie_draft_history.json` tracks production back to 2012 (n=719) and the matrix JSON includes that broader sample, but the per-round tables in this memo restrict to 2014+ so the production and extension columns share a denominator. Era-tagged but pooled — see `rookie_hit_rate_matrix.json` for the era-stratified cut.

## TL;DR

| Round | Recommended pick | Y4-Y5 plan | Why |
|------:|:-----------------|:-----------|:----|
| **R1** | **RB** | **Extend if worthy@Y3 — trade if not** | Highest Y1–Y3 hit rate at R1 (50% production) and the league's second-largest starter-vs-replacement spread (95%). RB R1 expected value beats WR R1 by ~17 fantasy points/season. Worthy RBs hold value: 56% of worthy RB extensions paid off in Y4–Y5 (CMC, Cook, JT, Kamara, Fournette), basically tied with WRs (58%). |
| **R2** | **QB if available, else WR** | Extend QB aggressively | QB R2 carries 33% hit rate × QB-spread (116%) — biggest E[V] of any R2 cell. 82% of worthy QB extensions paid off in Y4–Y5; SF-era QB extensions are essentially auto-pilot +EV. |
| **R3** | **QB if available, else TE/WR** | — | Same logic — QB scarcity dominates expected value. RB R3 hit rate collapses to 6%, the worst position-round cell in the table. |
| **R4-R5** | **QB > WR > TE > RB** | — | Hit rates are <10% across the board; the only differentiator is starter-tier upside per position. Don't reach for RBs. |

**The over-extension trap (most actionable finding):** owners extended **22 RBs and 16 WRs whose Y1–Y3 production was *below* position threshold** — pure sunk-cost decisions. Almost all of those underperformed in Y4–Y5. The signal is not "trade vs extend" — it's "**don't extend players who didn't earn it by Y3**" regardless of position. If a player's Y1–Y3 avg ppg is below 15 (RB) / 13.5 (WR) / 12.5 (TE) / 18 (QB), don't extend.

## How to read this

`E[value] = P(hit) × starter-tier-avg + (1 − P(hit)) × replacement-tier-avg`

Hit rates by position × round (production_hit = Smash/Hit tier in `rookie_draft_history.json`):

| Round | RB hit% | WR hit% | TE hit% | QB hit% | n_RB | n_WR | n_TE | n_QB |
|------:|--------:|--------:|--------:|--------:|-----:|-----:|-----:|-----:|
| R1    | 50.0%   | 38.2%   | 57.1%   | —       |  42  |  55  |   7  |   —  |
| R2    | 14.6%   | 21.4%   | 12.5%   | 33.3%   |  41  |  42  |   8  |  12  |
| R3    |  5.9%   | 12.2%   | 28.6%   | 30.0%   |  34  |  41  |   7  |  10  |
| R4    |  3.2%   |  0.0%   |  0.0%   | 22.2%   |  31  |  28  |   9  |   9  |
| R5    |  5.3%   |  0.0%   | (n<5)   | (n<5)   |  19  |  30  |  16  |  15  |

Position starter / replacement averages from 2024–2025 (SF + TE Premium era):

| Position | Starter avg | Replacement avg | Spread | Spread % |
|---------:|------------:|----------------:|-------:|---------:|
| QB       | 326.7       | 151.1           | 175.7  | 116%     |
| RB       | 260.6       | 133.5           | 127.1  |  95%     |
| WR       | 235.2       | 147.1           |  88.2  |  60%     |
| TE       | 215.9       | 137.9           |  78.0  |  57%     |

E[V] per round-position:

| Round | RB E[V] | WR E[V] | TE E[V] | QB E[V] | Winner |
|------:|--------:|--------:|--------:|--------:|:-------|
| R1    | **197.1** | 180.7   | 182.4   | —       | RB     |
| R2    | 152.1     | 165.9   | 147.6   | **209.5** | QB     |
| R3    | 141.0     | 157.8   | 160.2   | **203.7** | QB     |
| R4    | 137.6     | 147.1   | 137.9   | **190.0** | QB     |
| R5    | 140.2     | **147.1** | (n<5) | (n<5)   | WR     |

## Why R1 RB still wins despite WR's deeper pool

The R1 cell is the only place where RB hit rate (50%) materially exceeds WR hit rate (38%). Combine that with RB's 95% scarcity premium and the math comes out RB by ~17 points/season. **This is the empirical answer to the original question:** at R1.01–R1.06, an RB is the right pick even if WR/TE prospects in the 2026 class look stronger on paper. Below R1, the hit-rate gap reverses and the deeper WR pool wins.

The TE R1 hit rate (57%, n=7) edges out RB but the sample is so small the Wilson 95% CI runs from 25% to 84% — not actionable on one cohort.

## Why QB dominates R2–R4 in expected value

Two structural reasons:

1. **Spread.** SF era turns 24 starting QBs into ~24 startable QBs out of a pool of 68 — replacement-level QBs score ~150 pts vs. starter avg 326. That's a 175-point gap, the largest of any position.
2. **Hit definition fits QBs naturally.** A QB who lands a starting job and holds it is automatically a Smash/Hit (the production threshold is easier to hit because of the volume floor). The cohort's QB R2-R4 hit rates (33% / 30% / 22%) reflect that.

**Caveat:** the QB cells run 9–12 rookies each. We're drawing strong conclusions from small samples. The SF era only began in 2022 in this league and only one cohort (2022) is fully observable. Treat the QB recommendation as "directionally strong, but watch the 2025–2026 cohorts confirm or refute."

## Extension follow-through — what the Y4-Y5 data actually says

The original framing asked whether RBs cliff harder in Y4-Y5 than WRs. Pulling NFL season totals from nflverse for 2017-2025 (every player who actually scored, no roster-survival filter), the answer is **no — RBs and WRs hold value at almost identical rates among players who earned the extension at Y3.**

| Position | Worthy@Y3 paid off Y4-Y5 | Worthy → Cliffed | Median Y4-5 / Y1-3 retention |
|---------:|-------------------------:|-----------------:|-----------------------------:|
| QB       | **9 of 11 (82%)**         | 18%              | 75%                          |
| RB       | 5 of 9 (56%)              | 44%              | **89%**                      |
| WR       | 11 of 19 (58%)            | 42%              | 83%                          |
| TE       | 1 of 2 (50%)              | 50% (n=2, weak)  | 87%                          |

**Worthy RBs hold up.** McCaffrey, Cook, Jonathan Taylor, Kamara, and Fournette all paid off their extensions at the position starter-tier threshold (16.1 PPR ppg). Saquon and Nick Chubb landed just under threshold — borderline calls more than true cliffs (Saquon Y4-Y5 = 14.66, Chubb = 15.97 vs 16.1 cutoff). The clear cliffs were Kareem Hunt and Travis Etienne — both context-specific (off-field issues, committee usage).

**The age-curve cliff thesis is overstated for fantasy purposes once you filter to RBs who *earned* the extension at Y3.** Median RB Y4-Y5 retention (89%) is actually higher than WR (83%) — RBs who hit the worthy threshold tend to maintain or improve their per-game scoring; WRs have higher dispersion (some Calvin Ridley-style suspensions, some genuine route evolution into the second contract).

**Where extensions actually go wrong: over-extending unworthy players.** In the 2017–2021 cohort, owners extended:
- 22 RBs whose Y1–Y3 ppg was below the worthy threshold (74% of all RB extensions)
- 16 WRs same (46% of all WR extensions)
- 10 TEs same (83% of TE extensions — TE is the worst-discipline position)
- 4 QBs same (most of these still paid off because of SF scarcity dynamics)

The "they showed flashes" extension on a player who never crossed the production line in 3 years is the actual league-wide value leak — not RB-specific cliffs.

**Decision rule, position-agnostic:** if Y1–Y3 avg ppg is below the worthy threshold (RB 15.0 / WR 13.5 / TE 12.5 / QB 18.0 in UPS scoring), *don't extend regardless of position*. Trade or let walk. If they cross the threshold, extend with reasonable confidence — the data doesn't support a categorical "trade RBs, extend WRs" rule.

See `docs/league-context/extension_followthrough_tables.md` for the full per-player roll-call (paid-off vs cliffed) by position.

## RB extension premium — confirmed at R1, not elsewhere

The original sub-question: do RBs earn extensions more often than WRs at matched draft slots?

| Round | RB ext% | WR ext% | Δ (RB−WR) | p (two-prop z) |
|------:|--------:|--------:|----------:|---------------:|
| R1    | 59.5%   | 54.5%   |  +5.0pp   | 0.624 |
| R2    | 31.7%   | 33.3%   |  −1.6pp   | 0.874 |
| R3    | 14.7%   | 22.0%   |  −7.2pp   | 0.423 |
| R4    |  3.2%   | 10.7%   |  −7.5pp   | 0.253 |
| R5    |  5.3%   |  6.7%   |  −1.4pp   | 0.842 |

**RB extension rate beats WR's only at R1**, and even there the gap isn't statistically significant (p=0.62). At R2+ the gap reverses — the league actually extends WRs more often than RBs at matched slots, consistent with WR career arcs being kinder than RB age curves once a hit lands.

This means the RB-extension premium isn't a mechanical advantage that survives outside R1. The R1 RB recommendation rests on production hit rate and VOR, not on extension stickiness.

## Methodological refinements layered in (best-2-of-3 + JJ Zachariason framework)

Two upgrades since the first draft of this memo:

### Best-2-of-3 worthiness (Y3-injury fix)

Y3 injuries (Saquon's 2020 ACL, role demotions, etc.) drag the avg-of-3 ppg below threshold and mis-label genuine starter-tier players as "unworthy." Switching to **best-2-of-3** (drop the worst of Y1/Y2/Y3) catches **15 flip players** in the 2017–2021 cohort: Aaron Jones, TJ Hockenson, Joe Mixon, Nico Collins, Najee Harris, James Conner, David Montgomery, D'Andre Swift, Marquise Brown, DJ Chark, Michael Pittman, Hunter Renfrow, Michael Gallup, Baker Mayfield, Mitchell Trubisky.

**The cliff signal got *stronger* using best-2-of-3** — both RB (53%) and WR (52%) cliff rates among worthy players go up vs avg-of-3 (44% / 42%). Reason: best-2-of-3 catches high-ceiling players whose Y3 was injured (Saquon Y1=24, Y2=18.6, Y3=7.4 ACL → best-2 = 21.4 ppg, clearly worthy), and those high-ceiling guys cliff harder than the avg-of-3 mid-tier players. Use **best-2-of-3 as the primary worthiness signal** going forward — see `extension_followthrough_tables.md` for full per-player roll-call.

### JJ Zachariason — analytical practices to absorb

Full methodology memo at [jj_zachariason_methodology.md](jj_zachariason_methodology.md). His value is the reasoning *method*, not the takes. The seven moves worth adopting across all our fantasy analytical work — they generalize beyond rookie drafts and beyond UPS:

1. **Anchor to the prior; only argue when you can quantify the deviation.** JJ frames his ZAP Model as *"telling you when to deviate from draft capital"* — capital is the Bayesian prior, the model earns its keep only when it disagrees. Don't build models that re-derive consensus; build models that quantify *when* to override it.

2. **Reframe the question before answering.** "Is this QB good?" → "Can he score fantasy points without being good?" "Is the dominator high?" → "Is it high *for this player's age*?" The reframe is where the analytical edge actually lives; the metric is downstream of the question.

3. **Pick the denominator that matches the question.** Per-game vs full-season, share vs raw, conditional vs unconditional. Most metric debates are denominator debates in disguise. JJ uses full-season totals (not per-game) for college RB production because durability is part of the signal he wants — a 1,800-yard back on 280 touches is a different prospect than a 1,200-yard back on 180.

4. **Split every stat into stable and unstable components.** Project off the stable parts (volume, route share, snap share, target share, carries); treat the unstable parts (TDs, YPC, yards per target) as variance. The TD-regression discipline generalized — applies to rookies, veterans, projections, retrospective grading, everything.

5. **Comp by feature-vector distance, not visual similarity.** Decide your features first, then find nearest historical neighbors in that space. Visual comps smuggle the conclusion into feature selection. JJ also expands the comp pool to *all-time historical distribution* (not just same-class peers) when the current cohort sample is thin.

6. **Conditional inference matters; selection effects make raw correlations lie.** "Day-3 RBs almost never hit" is conditional on having been drafted Day 3 — itself an NFL-team judgment. The same testing number means *opposite* things at different capital tiers because of the selection process that produced the draft pick (the TE example: less-athletic TEs outperform combine freaks at R2 capital because teams only spend R2 on a non-athlete when his production is undeniable). Anywhere selection is present, raw correlations lie.

7. **Separate role grant from role conversion.** When projecting Y2, the role being granted (route share, snaps) is the *leading* indicator; the conversion to production (catches, TDs) is the *lagging* one. A WR who ran 75% of routes but caught 35 balls is a different bet than a WR who ran 40% of routes but caught 60 balls — the first has the role for a Y2 leap.

Two more from the deep-dive memo worth holding onto: **process > outcome in retrospective evaluation** (a hit on a bad profile didn't validate the bad profile; one bad outcome shouldn't update your prior more than one outcome's worth of information), and **quantify trade-offs explicitly** ("11.1% vs 4.4% league-winner rate" beats "WRs are better").

The methodology memo also catalogs **statistical gaps in JJ's own framework** — selection effects in his cohort definitions, survivor bias in NFL historical comps (every comp is conditional on having reached the NFL), opaque out-of-sample validation, era effects on college metrics (pre-spread vs post-spread, NIL keeping seniors), additive-where-it-should-be-multiplicative model structure, no published confidence intervals on ZAP outputs, inconsistent hit-rate definitions across his content, path dependence on Y1 coaching/scheme luck, and an un-falsifiable "process held" frame for retrospective grading. These are general analytical reasoning issues to watch for in *anyone's* work, including our own.

**Direct applications to this analysis (in priority order):**
1. **NFL draft capital is a *forward-looking* prospect-eval input, not a retro-cohort overlay.** Once a rookie has 3 NFL seasons, the production data dominates the prior — re-stratifying our 2017-2021 cohort by NFL round adds noise, not signal. The right place to apply "capital is the prior" is a **2026 prospect evaluator** (NFL capital + dynasty rookie ADP + share-based college metrics) for rookies who haven't taken a snap yet. That's a different artifact from the cohort hit-rate matrix.
2. **Surface confidence intervals.** We have Wilson CIs in `rookie_hit_rate_matrix.json` already; the strategy memo's per-round table should show them, not just point hit rates.
3. **Build a stable/unstable production split for veteran evaluation.** Separate volume / role-grant signal (snap share, route share, carries) from efficiency / role-conversion signal (YPC, YPT, TD rate). Project the volume forward; treat the efficiency as variance. Apply this to the worthy/cliff analysis — a Y4 collapse driven by efficiency regression is a different bet than one driven by lost snap share.
4. **Re-evaluate "extend vs trade" using role-grant inputs**, not fantasy-point output. A 27-year-old RB whose snap share dropped 15pp in Y4 is a different bet than one whose snap share held but YPC fell — the first lost the role, the second is regression-prone but recoverable. Pull route share / snap share / target share / carries from nflverse for our cohort and re-classify.
5. **Comp 2026 prospects against the all-time historical distribution**, not just the 2026 peers. When sample is thin (any single rookie class), expand the reference pool to historical comps with similar profiles and use their realized base rate as the prior.

### JJ's in-season / strategic process disciplines (general, not just rookies)

These came out of the podcast / non-rookie research and are worth importing into how we approach *every* analytical question, not just the rookie draft. Full detail in [jj_zachariason_methodology.md](jj_zachariason_methodology.md) sections A–K.

**Executable QB-evaluation thresholds (numerical, not vibes).** Late-Round QB has gone mechanical:
- **FP per dropback ≥ 0.55** — the "elite next-year" gate; below 0.45 is the explicit fade.
- **Rushing yards ≥ 20 / game** — the second filter; below 10 caps the ceiling.
- **Passing TD rate > 6%** — regression flag; QB1 finishes built on TD rate are sells.
- The pivot from "wait" to "draft an elite QB early" isn't QB conviction — it's **opportunity-cost flatness behind the QB tier**, i.e. a deep enough WR pool that taking Allen/Hurts late in their tier costs you a small marginal WR. Apply this to UPS auction QB pricing too: the right time to spend up is when the WR/RB market is unusually flat, not when the QB tier looks loaded.

**Separate observation from opinion in time AND framing.** JJ's Monday "data dump, not takes" X thread is a public commitment device — signal collection precedes opinion formation. The weekly cadence (Monday data → Tuesday take → Wednesday waiver → Friday sit/start) is a process firewall. **Adopt:** when we run a new analysis, write the data findings as a separate artifact from the recommendations. Don't let the recommendation-writing rewrite the data interpretation.

**Route share leads; target share follows.** Route participation rate is the leading indicator — sticky week-to-week, can't be faked by a one-week target spike. Target share is the lagging indicator. **Buy on route-share surges target hasn't caught up to**; **sell on snap-share collapse despite point-totals holding** (the underlying TD rate or YPRR was unsustainable). This is the in-season generalization of the "stable vs unstable component" split.

**Variance-vs-floor is conditional on payoff curvature, not a personality trait.**
- Redraft season-long, dynasty rebuild → **chase upside** (ceiling owns prize money).
- Best ball / large-field tournaments → chase ceiling harder; correlation/stacking matters.
- Guillotine, dynasty contender starting lineup, cash-game DFS → **chase floor** (a single bad week kills you, or every win matters equally).
- **Identify the payoff curvature first; pick variance second.** Most "take more risk!" content skips this step; most cautious content over-applies it. UPS rookie draft = upside-chase mode; UPS in-season starting lineup at a contender = floor mode. Same league, different decision contexts.

**Aging-asset timing is asymmetric — RB sells, WR buys.**
- **RB sell window** opens at age 26 for productive starters; **list by mid-October** if not contending. Contender premiums peak in November and crash by January. The holding cost on RBs compounds *quarterly*, not annually.
- **WR hold window** runs through age 28-29; the market over-discounts WRs entering 28+, so those are systematic *buy* targets, not sells. JJ's most-restated contrarian call.
- **TE hold window** is the longest once the role is locked.
- (Caveat: this assumes a buyer market with normal contender premiums — works less well in a flat market.)

**Coaching changes reset all rate metrics — wait 2-3 games.** A new HC / OC promotion / play-caller change makes prior-regime route share, target share, and snap share *stale*. The event is the signal; the new sample is the confirmation. Don't update on first-week post-change data alone.

**Process check on every dynasty trade: "Would I redraft this player at this asset cost in a startup *today*?"** In-season, this question gets re-asked weekly, not annually, because injury news and depth-chart events shift the answer.

**Multi-piece trades: anchor on the best asset, not the package.** If someone offers A for B+C+D, ignore C and D. Ask whether A is materially better than B alone. The throw-ins are usually noise added to win the optics.

**Meta-process disciplines (apply to our own analytical work):**
- **Recency-effect counter-question:** "What has changed *structurally* and how does that affect value?" Forces separation of structural change (new role, new team, new HC) from recency noise (one good/bad game).
- **Reverse-engineer expert agreement.** If three analysts agree on a player, that's consensus pricing — the edge isn't in disagreeing reflexively, it's in asking whether the agreement is *structural* (real signal, take it) or *social* (everyone's quoting each other, fade it).
- **One-thesis-per-episode discipline.** JJ's tight 15-minute episodes force a single executable claim. **Adopt:** every analysis we ship should have one headline claim, not a buffet. Long roundtable formats blur takes; tight artifacts force a clean call.

**New methodological gaps in his framework (in-season layer):**
- His QB conjunction (FP/DB ≥ 0.55 AND rush ≥ 20/g) is never published as a 2x2 with conditional finish distributions for the "clears one gate but not the other" case — which is the actually decision-relevant case.
- "Coaching change resets all rate metrics" is binary when it should be graded — a new HC is bigger than a mid-season OC promotion is bigger than a play-caller swap within the same staff.
- "Sell RBs by mid-October" conflates two distinct effects (contender-premium price decay vs week-by-week injury hazard accrual) into one timing call. The optimal sell window is a Bellman trade-off the heuristic doesn't make explicit.

### Koalaty Stats (Joseph Bryan) — the route-level / PFF-data layer JJ doesn't reach

Full methodology memo at [koalaty_stats_methodology.md](koalaty_stats_methodology.md). Bryan operates a different stack than JJ — Elastic Net regressionist, PFF Ultimate / Premium Stats native, openly anti-film, builds custom production primitives at the route level. Where JJ uses college dominator and breakout age, Bryan reaches one layer deeper into the play-by-play. The pieces worth absorbing:

**Build a leading-indicator version of every lagging-indicator metric.** PWOPR is his flagship: a *predicted* WOPR built from route-level XGBoost, where the input is "what routes did he run" (sticky, can't be faked) and the output is "what should his target share have been." PWOPR's week-to-week stability is R² 0.66; its predictive R² for next-week fantasy points is 0.346 — both numbers he publishes openly. **Generalizable lesson:** for any lagging metric, build the leading version that uses inputs the player can't fake. For our work: route share *predicts* target share; snap share *predicts* carries; first-read frequency *predicts* depth-chart trust.

**ECDF against the drafted-only population, not all college players.** Empirical Cumulative Distribution Function gives a continuous percentile rank without parametric assumptions. By restricting the reference pool to *drafted prospects only*, the percentile becomes interpretable as "where does this kid stand vs the population that actually got NFL opportunity." For our cohort work: when reporting hit rates, anchor to the drafted-only pool. When evaluating 2026 prospects, percentile them against historical drafted prospects, not against their 2026 peers.

**Decompose volume into schemed vs un-coachable.** Junk Yards = yards before contact on sub-5-aDOT throws (the play was schemed; the receiver caught a quick pass). BEAST Yards = yards on 5+ aDOT passes where the receiver also gained 5+ YAC (he was contested, won, made something happen). **Most analysts conflate these into one production number.** Bryan splits them and the WR hit-rate signal materially improves. For our work: when evaluating veteran production for extension/trade decisions, separate the volume the *scheme* manufactured (screens, manufactured touches) from the volume the *player* created. A WR whose Y3 was 1,200 yards on screens is a different bet than 1,200 yards on contested down-field catches.

**Refit the entire model post-draft — don't bolt on a capital multiplier.** When NFL capital arrives, Bryan re-estimates *all coefficients* on the post-draft sample rather than adding a draft-pick adjustment on top of the pre-draft model. This lets variable interactions re-estimate against the actual capital. A pre-draft-loved prospect who fell to Day 3 doesn't just get a "Day-3 penalty" — his whole profile gets re-weighted given that the NFL undervalued him. Methodologically cleaner than additive adjustment.

**Publish your R² and your holdout-year sensitivity.** Bryan's brand-defining position is *"do not trust models without R²s."* He publishes the cross-validated R² for every model (2025 WR = 0.47, 2026 RB = 0.608, 2026 TE = 0.558) AND publishes the holdout-year sensitivity — frankly stating that moving the 2026 RB holdout from 2020 to 2022 spikes R² to .62, and refusing to advertise the higher number because validation is too noisy at small sample. **Adopt:** every model we ship gets a published R² and a holdout-year sensitivity note. Refuse to advertise inflated numbers from cherry-picked validation.

**Tier compression rule:** *"If player X has a 91 and player Y has a 90, the order doesn't really matter (hit rates are identical when that close). Both players are in the same tier."* Adopt for any ranking we produce — when the gap between two players is below the noise floor of the model, present them as a tier, not as ordered ranks.

**Predicted RAS as an imputation move.** When a player skips combine drills, instead of dropping the row, build a predictor that fills in the missing drill from PFF tracking data. **Generalizable:** when an input is missing *structurally* (a player opted out, a system-of-record didn't capture it), imputation beats deletion. Don't drop the row.

**Comp-aware RYOE.** Standard RYOE is contaminated by OL grade, scheme, box counts. Bryan's RYOE conditions on opponent run-defense PFF grade, opponent conference strength, OL grade, and a custom conference-mismatch term. The expectation is calibrated to context, so the residual measures the *player*. Lesson: when an environment-dominated metric doesn't predict outcomes, don't drop it — re-engineer the environment out of it. Same move applies to YPC, target rate, YPRR.

**Where Bryan disagrees with JJ (and where the disagreement matters):**
- **TE archetype.** JJ: less athletic + more productive + R2 capital wins (the non-athlete only gets R2 if production is undeniable). Bryan: athletic + productive at TE wins (athleticism is super important for TE). Real empirical disagreement; neither has shown enough data to settle.
- **Draft capital weighting.** JJ: capital is the prior, model overrides at the margin. Bryan: model's verdict holds independent of capital; post-draft refit lets them interact rather than capital trumping.
- **RB rushing inputs.** JJ dropped them. Bryan kept them, but only as comp-aware RYOE residuals.
- **Hit-rate target.** JJ: binary top-12 / league-winner. Bryan: continuous 3-year FPpG average. Different choices about what the model is predicting.
- **R² publishing norms.** JJ doesn't publish a holdout R² for ZAP. Bryan makes R² central to his brand.

**Where Bryan is weaker than JJ:**
- **Elastic Net is linear.** Can't discover interaction effects unless he hand-engineers them (the Group-of-5 penalty, the athletic × explosive bucket). JJ's TE finding (capital × athleticism interaction) is invisible to an Elastic Net unless pre-specified.
- **Self-acknowledged: doesn't model "performing above expectation" players.** His framework is built around residuals against expected — which means it systematically misses the JJ ZAP-style upside lottery tickets whose breakout came from an un-modeled trait. He's clear about this in his own words. **Implication: combining frameworks is strictly better than either alone** — Bryan catches the structural under-performers, JJ catches the breakouts.
- **No format-dependence taxonomy.** Upside-over-floor stance is unconditional; he doesn't have JJ's payoff-curvature framing.
- **No second-contract / age-curve work.** Same gap as JJ.
- **PCA over production primitives** discards interpretability and may discard signal. Supervised reduction (PLS, target-encoded) would be more appropriate for prediction.

**The combined JJ + Koalaty framework — what we want:**
- JJ for: the prior (NFL capital), the format-dependence (variance vs floor by payoff curvature), the in-season process discipline (Monday data thread, opportunity-grant signals), the QB framework, the upside-bias for finding breakouts above expectation, the second-contract intuitions (which we should test against our data, not adopt wholesale).
- Bryan for: the route-level primitives (PWOPR, BEAST/Junk Yards, RVI), the ECDF-against-drafted-only percentile, the comp-aware expectation construction (RYOE, YPRR over expected), the refit-post-draft methodology, the published R² + holdout-year discipline, the tier-compression rule.
- Both for: opportunity > production, age-adjustment, comp-based reasoning, process > outcome, touchdowns regress / volume sticks.
- Neither addresses: salary-cap mechanics, auction valuation, multi-year contract structure, cap-format-specific positional re-weighting. Those are our terrain.

## Limitations

1. **Y4-Y5 production uses nflverse PPR; Y1-Y3 uses UPS scoring.** Each threshold is calibrated to its own scoring system's 2024-2025 starter-tier average so the worthy-vs-paid-off comparison is fair within position, but the cross-system "% retention" ratios (median Y4-Y5/Y1-Y3) are approximate. To eliminate the mismatch, apply UPS scoring rules to the nflverse raw stats. ~80 lines of work; not material to the conclusions.
2. **MYM signal is intentionally excluded from extension determination.** MYM signings are a separate decision class — typically cheap lotto-ticket commitments, not real-cap multi-year extensions. The extension-worthy / cliff analysis is scoped to actual extension events only. MYM evaluation is its own analysis with its own decision rules.
3. **Fantasy-point analysis is lagging-indicator.** Y1-Y3 ppg captures *what happened* but not *why*. Splitting into role-grant (route share, snap share, carries — leading) vs role-conversion (TD rate, YPC, YPRR — lagging) would let us distinguish "lost the role" from "got unlucky with efficiency." Pulling these metrics from nflverse for the cohort is the highest-leverage refinement still open.
4. **2026 lineup demand is assumed unchanged.** TIERS in `positional_scarcity.py` reflect 1QB+SF / 2RB / 2WR+1FLEX / 1TE-Premium. If 2026 rules change starter counts, the spread % values shift.
5. **VOR is 2024–2025 only.** Two-season SF / SF + TE Premium sample. Trend lines aren't built yet.
6. **No 2026 prospect evaluator yet.** Our analysis is retrospective — what happened to 2017-2021 rookies. A forward-looking 2026 prospect tool combining NFL draft capital (now available — NFL draft happened April 2026) + dynasty rookie ADP + share-based college metrics is a separate artifact we haven't built. That's the right place to apply JJ's "capital is the prior" framework.

## Files

- `site/rookies/rookie_cohort_outcomes.csv` — per-pick production_hit and extension_worthy flags.
- `site/rookies/rookie_hit_rate_matrix.json` — full matrix with Wilson CIs and era-stratified cut.
- `site/rookies/rookie_extension_followthrough.csv` — per-pick Y1-Y3 vs Y4-Y5 ppg with worthy/cliff flags.
- `docs/league-context/extension_rate_tables.md` — extension-rate tables (raw).
- `docs/league-context/extension_followthrough_tables.md` — Y4-Y5 follow-through tables (full + clean cohorts).
- `docs/league-context/positional_scarcity_2026.md` — VOR per position from 2024–2025.
- `pipelines/analytics/rookie_hit_rate_build.py` — Phase A+B+C builder.
- `pipelines/analytics/positional_scarcity.py` — Phase D builder.
- `pipelines/analytics/rookie_extension_followthrough.py` — extension worthiness + Y4-Y5 follow-through.
