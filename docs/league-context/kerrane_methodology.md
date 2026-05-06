# Pat Kerrane — Analytical Methodology Memo

*Compiled 2026-04-28 for the UPS MFL rookie meta-model project. Adds Kerrane as a fourth opinion alongside JJ Zachariason (ZAP), Joseph Bryan (Koalaty), and Hayden Winks. Sources at the bottom; quotes lifted from the public portion of paywalled articles, podcast intros, and the Legendary Upside RSS.*

Pat Kerrane is the proprietor of **Legendary Upside** (legendaryupside.com), a contributor at **Establish The Run**, a former NBC Sports / RotoViz prospect writer, and a Best Ball Mania III champion. His public brand is "evidence-based football analysis" but the framework he runs is meaningfully different from the pure-tracking-data shop (Koalaty), the pure-ZAP shop (JJ), or the pure-PFF shop (Winks). He is the closest of the four to a *film-fluent statistical analyst* — he uses tape to disambiguate role and scheme fit, then leans on a small set of stat thresholds to convert that read into a tier.

The full ranked lists live behind a paywall. What we can reconstruct from the **public positional tier articles** (one free article per tier, roughly two per position per cycle), podcast intros, and X commentary is enough to lock the top half of his board for 2024, 2025, and 2026. The bottom half is partial and is flagged as "Implied" in the input CSVs.

---

## Core Principles

- **Capital is the prior, but trait + scheme fit is what changes a ranking.** Kerrane will not draft a Day-3 RB into a Tier 2 slot just because the film is good — but if a Day-2 player has a clean trait profile *and* a usable scheme fit, he will rank that player ahead of a higher-capital player whose role is unclear. JJ would not. Koalaty mostly cannot, because his framework is "anti-film by design."
- **Two-year window for trade-value establishment.** Kerrane is on record (Establish The Run podcast, episode 168) saying his dynasty model assumes a two-year window for a prospect to lock in trade value. After year 2, the price you can get is what you get; he is not patient with multi-year stash bets the way the pure-capital crowd is.
- **The "Legend Index" is his upside score.** It's an internal RB metric that strips draft capital and situation out and asks: does this player's college statistical profile have the tail-event production (breakaway rushing, receiving versatility, age-adjusted dominator) that historical fantasy *legends* showed? Players above his Legend Index line are the ones he flags as "above-capital upside." It is not a hit-rate number — it is a *ceiling-shaped* number, deliberately tuned to surface Saquon/Gurley/CMC-shaped profiles, not Day-3 grinders.
- **Success Rate (NFL Next Gen ROE%) for veteran RB read-throughs.** For older RBs, he uses Next Gen success rate (yards-over-expected per carry, binarized) as his floor metric and breakaway yards/game as his ceiling metric. The combination drives his "RB Success Rate Scrubs" public series.
- **Two-WR-archetype framework.** He explicitly tracks WRs across two skill clusters: short-area target earners (slot or X-iso, low aDOT, high YPRR) vs downfield/contested-catch alphas. He'll tier a slot earner like Jaylin Noel or Makai Lemon ahead of a "boom/bust" outside vertical type even when capital says the opposite — *if* his scheme-fit read says the team will use him in his archetype. JJ doesn't make that adjustment until ZAP gives him an output.
- **Athleticism gates, doesn't create.** Same conviction as JJ here — RAS (Relative Athletic Score) is a filter, not an upside generator. He will downgrade a top-50 capital player whose film read already showed the limitation his RAS confirms. His public language: "a bet on athleticism over on-field production."
- **Class-shape calls are explicit and load-bearing.** He routinely characterizes a class with a one-line shape call ("two-man tight end class with some dart throws beyond that," "this WR class is a bit better than it's generally given credit for"). The shape call drives his tier breaks more than absolute scores. JJ and Bryan both publish absolute scores and let users decide the breaks; Kerrane decides the breaks first.

---

## Rookie Evaluation Toolkit

Kerrane's public tier articles — the ones that aren't paywalled — show a recurring set of inputs.

| Bucket | What he uses | How he weights it |
|---|---|---|
| **NFL Draft capital** | Pick number, Day 1 vs Day 2 binary, top-50 cutoff for RBs | Prior, like JJ. But he will downgrade a Day-2 player who landed in a bad scheme/role-blocking situation. |
| **Age-adjusted production** | Dominator, YPRR, target share, yardage share, breakout age | Same threshold heuristics as JJ (≥ 30% dominator preferred; breakout ≤ 20). His public articles cite YPRR, Yards Per Target, and YAC per route specifically. |
| **Athletic measurables (RAS, 40, jumps)** | Relative Athletic Score, height-adjusted speed for RB | Filter, not a generator. Will explicitly note when a player is "a bet on athleticism over production" as a downgrade flag. |
| **Scheme / role projection** | Slot rate, college route tree, NFL team scheme fit, blocking grade for TEs | This is his unique input. He will adjust tiers post-NFL-Draft based on whether the team's offense uses the player in his archetype. |
| **The "Legend Index" (RB only)** | College tail-event production stripped of capital + situation | Surfaces ceiling-shaped profiles. Not a hit-rate score. |
| **NFL Next Gen success rate (veteran read-through)** | ROE% binarized; coach-trust proxy for goal-line workload | Used for grading veteran RBs and for his "later-round RB" hit-rate framework, which is the closest thing he has to a published hit-rate definition. |

**Things he explicitly de-weights:** combine bench, hand size, bowl-game heroics, raw college totals (he wants share-based metrics or per-route efficiency), prospect-vs-prospect headshots without the underlying production differential.

**Things he explicitly weights more than the model crowd:** scheme fit at the NFL level, role fit (slot vs X, two-down vs three-down), and the *post-NFL-Draft* re-rank. His rankings are explicitly published with the post-draft fallout factored in within ~48 hours of the draft, while JJ's ZAP scores are static at draft time and Koalaty's percentiles are static at the model run.

---

## Position-Specific Strategy

**Running Back.** Capital-driven at the top (Jeanty 1.01, Brooks 1.01-equivalent in the 2024 RB-only world, Love 1.01 for 2026), but his Tier 2 and 3 are shaped by his Legend Index and by scheme fit much more than JJ's are. Examples: he was higher than ZAP on Bucky Irving (right; ZAP had him RB18 — Kerrane was clearly top-10), and lower on Audric Estime (ZAP had him RB14 — Kerrane buried him in tier 5 due to receiving-game limitation). He does not de-prioritize receiving production for RBs the way the pure-capital crowd does.

**Wide Receiver.** Kerrane's WR tiering is the place where his framework most differs from the other three. He explicitly **does not tier strictly by capital**. The 2024 case was Tier 5 — he had Mitchell, Worthy, McConkey, Coleman, *and Troy Franklin* as a single tier despite Franklin going Day 3, because his scheme-fit read on Franklin (vertical Z in Sean Payton's offense) made him tier-equivalent to the higher-capital names. The 2025 case was Jaylin Noel — he had Noel as an "author favorite" Tier 3 ahead of where capital said he should sit, because the slot-WR archetype + Stroud's offense was an obvious scheme fit. The 2026 case is Makai Lemon (his Tier 2 WR1B alongside Carnell Tate at Tier 1) — he is willing to put a Day-1 slot prospect ahead of multiple Day-1 outside prospects, where Koalaty and Winks lean toward Tate alone.

**Tight End.** He gets to TE earlier and harder than JJ does. Brock Bowers in 2024 was a "shouldn't make it past the top half of rookie drafts" call, which is a stronger version of JJ's stance. For 2025, he had Tyler Warren and Colston Loveland as a Tier 1 of two — same shape as JJ, who treats TE as binary. The 2026 read is the most differentiated: he has Sadiq + Stowers as a Tier 1 of two **but explicitly labels them "Big Slot WRs" rather than traditional TEs** — a scheme-fit distinction that the other three analysts don't make explicit, and one that meaningfully changes how a UPS dynasty manager should think about positional value.

**Quarterback.** Aligned with JJ's "rushing equity is the multiplier" thesis but less hard-edged about the Late-Round QB framing. He is willing to tier a traditional dropback passer like Cam Ward or Fernando Mendoza into Tier 1 if the capital is high enough — JJ would push back harder. His 2026 Mendoza take ("a bet on size and draft capital") is essentially a reluctant Tier 1 that JJ likely tiers lower.

---

## Hit-Rate Definition

Kerrane does not publish a single closed-form hit-rate definition the way JJ does. Public-content evidence shows three operational versions:

1. **"Legendary fantasy season" frame** — for early-round managed-league RBs, he wants Saquon/Gurley/CMC tail outcomes and explicitly says the goal is to identify which RBs have a path to that ceiling. Hit = top-5 PPG season at position.
2. **"Coach trust at the goal line" frame** — the Establish The Run "How to hit on a later-round RB" framework. Hit = retains goal-line carries through year-2, stays the trusted closer. This is closer to a workload-share metric than a fantasy-points metric.
3. **Two-year trade-value window** — his dynasty heuristic. Hit = the player established positive trade equity within his first two NFL seasons, regardless of fantasy points.

For the UPS meta-model purposes, version 3 is the most directly comparable to JJ's "top-12 / top-24 finish in first 3 NFL seasons" frame and Bryan's "above-expected production" residual. We treat Kerrane's effective hit definition as **"established as a top-24 dynasty asset at his position by end of year 2."**

---

## Where Kerrane Disagrees Most With JJ + Bryan + Winks

The film-and-scheme-fit dissent is where his cross-model signal is most valuable.

### vs JJ Zachariason (ZAP)

JJ's ZAP score is a fixed pre-draft number — it captures everything about the player except landing spot, and JJ resists adjusting it for situation. Kerrane re-tiers within 48 hours of the NFL Draft. Their cleanest 2026 WR1 disagreement (referenced on the Legendary Upside pod) is exactly the cross-model signal we want: ZAP loved a different WR1 than Kerrane's tape did, and the disagreement is *not* about the metric inputs — it's about whether scheme fit moves a player one tier. **For the meta-model: when ZAP and Kerrane disagree at WR by ≥ 1 tier, the disagreement is almost always scheme-fit-driven and is the case where we want to look at Bryan's + Winks's data to break the tie.**

### vs Joseph Bryan (Koalaty)

Bryan is openly anti-film. His self-described weak spot is that his model "doesn't focus on players performing above expectation," which is precisely Kerrane's sweet spot — players whose tape and scheme fit suggest they will outperform what the metrics alone predict. **For the meta-model: when Koalaty's percentile is low (e.g., 40-60th) and Kerrane's tier is high (Tier 1-2), this is the highest-information disagreement in the system.** Bryan's 2025 percentile undershoot on Jeanty's *receiving* upside vs Kerrane's "legendary" tier is the canonical example.

### vs Hayden Winks

Winks is closer to Kerrane than the other two — both consume tape, both adjust post-draft. But Winks's Underdog/Sleeper background pushes him toward best-ball-shaped scoring profiles (boom-week WRs, downfield deep threats), while Kerrane's two-archetype WR framework is more agnostic. Their cleanest disagreement pattern is on slot WRs: Kerrane will tier Noel/Lemon-archetype slot earners higher than Winks because the dynasty (PPR) target-volume case beats the best-ball spike-week case. **For the meta-model: Kerrane vs Winks disagreements at WR are slot-vs-deep-threat disagreements, which our PPR/TEP scoring system explicitly favors Kerrane's read on.**

---

## Historical Hit-Rate Patterns

Public-content evidence on Kerrane's track record (via his own re-graded retrospectives and the Legendary Upside RB risers/fallers post for 2024 and 2025):

- **2024 hits:** MHJ Tier 1 (correct, generational Y1), Bowers Tier 1 (correct, OROY), Brian Thomas Tier 2 (correct — landed at WR1 finish in Y1), Bucky Irving graded above ZAP and consensus (correct, the only positive-advance-rate rookie RB in 2024).
- **2024 misses:** Brooks Tier 1 RB (severely missed — ACL recurrence; "boom/bust" framing was right but the bust hit). Troy Franklin Tier 5 author-favorite (missed in Y1 — Denver did not feature him; could still age into the call).
- **2025 calls under grade:** Jeanty Tier 1 (correct, generational), Travis Hunter Tier 1 conditional on WR (the conditionality is itself a tape-driven hedge that the pure-stat analysts didn't articulate).
- **General pattern:** Kerrane is right when the disagreement with consensus is scheme-fit-driven. He is wrong on the same shape of bet as everyone else (injury-recurrence RBs, second-contract tape "regression"). His 2024 calibration retrospective is the input we'd most want to grade against the 2024 cohort once the full ranking is reconstructed from his post-draft updates.

---

## Quotables

> *"This running back class isn't terrible."* — Kerrane on the 2024 RB class, an explicit pushback against the consensus narrative ("the 2024 RB class is weak"). He was right; Brooks-Benson-Allen-Bucky-Wright produced more usable dynasty outcomes than the ZAP-only crowd predicted.

> *"At WR, real life success is the best hack."* — public excerpt from his 2024 MHJ Tier 1 article, his shorthand for "don't overthink elite outside production + Day-1 capital."

> *"Functionally a big slot WR."* — his 2026 Eli Stowers framing, a scheme-fit call that explicitly redefines what position the player is, ahead of how the NFL team will use him.

> *"A bet on athleticism over on-field production."* — recurring Kerrane phrase that signals a downgrade flag for a high-RAS, low-college-production prospect (used on Mike Washington 2026, on a few 2024 RBs).

---

## Sources

- [Legendary Upside — author page](https://www.legendaryupside.com/author/kerrane/)
- [Legendary Upside — 2024 Rookie Rankings](https://www.legendaryupside.com/rookie-rankings-2024/) (paywalled; tier-summary articles below are free)
- [Legendary Upside — 2025 Rookie Rankings](https://www.legendaryupside.com/2025-rookie-rankings/) (paywalled)
- [Legendary Upside — 2026 Rookie Rankings](https://www.legendaryupside.com/2026-rookie-rankings/) (paywalled)
- [Don't Overthink MHJ — 2024 Rookie WRs Tiers 1-4](https://www.legendaryupside.com/dont-overthink-marvin-harrison-jr-rookie-wrs-tiers-1-4/)
- [Take the Leap with Troy Franklin — 2024 Rookie WRs Tier 5](https://www.legendaryupside.com/take-the-leap-with-troy-franklin-rookie-wrs-tier-5/)
- [Xavier Legette — 2024 Rookie WRs Tiers 6-7](https://www.legendaryupside.com/xavier-legette-and-learning-to-live-a-little-wrs-tiers-6-7/)
- [Jonathon Brooks — 2024 Rookie RB Tiers 1-2](https://www.legendaryupside.com/jonathon-brooks-is-worth-the-risk-rookie-rb-tiers-1-2/)
- [Braelon Allen — 2024 Rookie RB Tiers 3-5](https://www.legendaryupside.com/braelon-allen-on-the-back-of-a-hurricane-rookie-rb-tiers-3-5/)
- [Drake Maye — 2024 Rookie QB Tiers 1-2](https://www.legendaryupside.com/drake-mayes-superstar-ceiling-rookie-qbs-tiers-1-2/)
- [Brock Bowers — 2024 Rookie TE Tiers 1-3](https://www.legendaryupside.com/brock-bowers-yac-king-rookie-tes-tiers-1-3/)
- [Dear Travis Hunter — 2025 Rookie WRs Tiers 1-2](https://www.legendaryupside.com/dear-travis-hunter-please-play-wr-2025-rookie-wrs-tiers-1-2/)
- [Don't Sleep on Jaylin Noel — 2025 Rookie WRs Tiers 3-5](https://www.legendaryupside.com/dont-sleep-on-jaylin-noel-rookie-wrs-tiers-3-5/)
- [Ashton Jeanty — 2025 Rookie RB Tiers 1-3](https://www.legendaryupside.com/ashton-jeanty-generational-rookie-rbs-tiers-1-3/)
- [How High is Cam Ward's Ceiling — 2025 Rookie QB Tiers 1-3](https://www.legendaryupside.com/how-high-is-cam-wards-ceiling-2025-rookies-qbs-tiers-1-3/)
- [Harold Fannin Folk Hero — 2025 Rookie TE Tiers 1-4](https://www.legendaryupside.com/harold-fannin-folk-hero-2025-rookie-tes-tiers-1-4/)
- [Rookie RB Risers and Fallers — 2025 Generational Class](https://www.legendaryupside.com/rookie-running-back-risers-and-fallers-2025s-generational-class/)
- [Carnell Tate — 2026 Rookie WRs Tiers 1-2](https://www.legendaryupside.com/carnell-tate-downfield-alpha-2026-rooke-wrs-tiers-1-2/)
- [KC Concepcion — 2026 Rookie WRs Tiers 3-7](https://www.legendaryupside.com/kc-concepcion-phenom-or-fraudulent-2026-rooke-wrs-tiers-3-7/)
- [Jeremiyah Love — 2026 Rookie RBs Tiers 1-2](https://www.legendaryupside.com/jeremiyah-loves-versatile-upside-2026-rookie-rbs-tiers-1-2/)
- [Mike Washington — 2026 Rookie RBs Tiers 3-6](https://www.legendaryupside.com/mike-washington-so-hot-right-now-2026-rookie-rbs-tiers-3-6/)
- [Fernando Mendoza — 2026 Rookie QBs Tiers 1-6](https://www.legendaryupside.com/can-fernando-mendoza-turn-around-the-raiders-2026-rookies-qbs-tiers-16/)
- [Eli Stowers — 2026 Rookie TEs Tiers 1-2](https://www.legendaryupside.com/eli-stowers-tweener-or-cheat-code-2026-rookie-tes-tiers-1-2/)
- [Establish The Run — Kerrane: How to hit on a later-round RB](https://establishtherun.com/kerrane-how-to-hit-on-a-later-round-rb/)
- [Legendary Upside — RB Success Rate Scrubs](https://www.legendaryupside.com/rb-success-rate-scrubs/)
- [Establish The Run Pod — Episode 168: Dynasty Rankings with Pat Kerrane](https://podcasts.apple.com/us/podcast/episode-168-dynasty-rankings-with-pat-kerrane/id1473055758?i=1000512328087)
- [Rotoworld Football Show — Rookie Dynasty Debates with Pat Kerrane](https://www.youtube.com/watch?v=rdAU3ych1WI)
- [SportsGrid Fantasy Football Show — Dynasty Rookie Rankings Roundtable w/ Jakob Sanderson & Pat Kerrane](https://audioboom.com/posts/8671077-dynasty-fantasy-football-rookie-ranking-discussion-w-pat-kerrane-from-legendary-upside)

---

## Caveat: data quality

Kerrane's primary product is paywalled. The CSVs in `pipelines/analytics/meta_model/inputs/kerrane_*.csv` are reconstructed from:

1. **Confirmed top-tier names and order** from the public positional-tier articles (one free article per ~2 tiers per position per cycle).
2. **Implied middle/lower-tier order** from his public class-shape calls, podcast intros, and post-NFL-Draft riser/faller articles.
3. **Numerical model_score values are author-assigned to preserve relative tier ordering** — they are not Kerrane's published numbers (he doesn't publish a 0-100 score). Treat them as ordinal placeholders that respect his tier breaks, not as cardinal model outputs.

Where a player is in the input CSV but his exact tier is uncertain, the tier column is labeled "(Implied)" so the calibration scripts can weight those entries lower. Approximately the top 10-12 players per position per year are confidently sourced; the rest is partial.
