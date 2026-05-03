# Koalaty Stats (Joseph Bryan) — Analytical Methodology Memo

*Compiled 2026-04-28 for the UPS MFL rookie hit-rate / extension-worthiness project. Companion piece to `jj_zachariason_methodology.md`. Focuses on methodology, not 2026 player takes. Quotes lifted from public Substack posts, X (Twitter), JMP community posts, and PFF article archives.*

Joseph Bryan (@KoalatyStats) is the operator of [KoalatyStats on Substack](https://koalatystats.substack.com/) and [koalatystats.com](https://koalatystats.com), the Patreon ($3/mo) and the upcoming paid SaaS product [koalatystatistics.com](https://www.koalatystatistics.com/). He is a B.S. in Statistics from the University of Georgia who originally enrolled in mechanical engineering and switched after a stats professor taught the material through football examples. He started building Bayesian fantasy models in JMP in 2018, has had a long-running relationship with PFF (he writes their "Coach, I Was Open" and "Route-Based Heroes" weekly columns), and lives inside PFF Ultimate / Premium Stats — which is the most important *positioning* fact about him: of the major public analysts, he has the deepest and most native fluency with PFF's play-level grading data, and almost everything in his toolkit is built on top of it.

He turned the Substack into a paid subscription on Oct 28, 2025 ($15/mo or $50/yr), with a stated ambition to build it into "a legitimate career." He calls his approach "evidence backed NFL analysis." His brand identifier is the "Koalaty Stamp of Approval" and his sign-off is "Go Dawgs."

---

## How he is positioned vs the other public analysts

- **vs JJ Zachariason (LateRoundQB / ZAP):** JJ is a Bayesian-flavored prior-and-deviation thinker — capital is the prior, the model exists to override it. Bryan is more directly a **machine-learning regressionist** — he fits an Elastic Net to PFF + production + athleticism and trusts the cross-validated R² over any prior. JJ frames model output as "deviation from capital"; Bryan frames model output as a percentile against historically drafted prospects, period. Bryan also leans far more on **PFF grades and PFF Wins Above Average (WAA)** than JJ does, and is much more willing to publish R² targets and explicit holdout sets.
- **vs Hayden Winks (Underdog):** Winks weights athleticism (RAS) heavily; Bryan considers RAS "the single most predictive *publicly available* metric" but mostly because RAS is a proxy for draft capital — he downweights it once he has both. Bryan adds Game Athleticism Score (GAS, from PFF) and his own **Predicted RAS** (built from tracking data) as alternatives that capture different signal.
- **vs Pat Kerrane (ETR):** Kerrane is film-and-scheme-fit; Bryan is openly anti-film. He says directly, *"I am not a film dude. I don't really care about it at all tbh. I think we have good enough data nowadays to capture most of the nuance in film analysis."* His tradeoff is intentional — he refuses to consume other analysts' content while building, to keep his model unbiased.
- **vs Rich Hribar (Sharp):** Hribar is the matchup/redraft DFS layer; Bryan also does DFS (his Patreon was originally a DFS optimizer) and they overlap on weekly opportunity metrics. Bryan goes deeper at the route level (PWOPR, CIWO) than Hribar's team-level matchup work.
- **vs Ben Gretch (Stealing Signals):** closest peer in *spirit* (opportunity-first, philosophical) but Bryan is much more numerical and less narrative.
- **vs Scott Barrett:** Bryan respects him ("the great Scott Barrett") and explicitly went looking at a Barrett-favored player when a name kept appearing in his feed — a rare admission that someone else's flag will trigger his own due diligence. He concedes the unbiasing is imperfect.
- **vs his named "process people":** he calls out [Marvin Elequin](https://twitter.com/marvelequin) ("uses data from 2010-2024 and actually has a training and testing process") and "Peter is also my dynasty hero who has great process" as the two analysts whose *methodology* he endorses. The fact that he calls these out explicitly tells you what he values: **train/test discipline** above all else.

---

## Core principles

- **R² is the ground truth, period.** If you're publishing a prospect model and you can't quote a cross-validated R² on a held-out test year, you're "sus" content. He repeats this so often it's a brand value: *"do not trust models without R²s."*
- **Production must be conditioned on age, conference strength, and teammate quality, simultaneously.** Raw college counting stats are nearly useless. He builds three independent custom adjustments — coverage strength of schedule (decomposing each conference into average heights/weights/recent draft scores), teammate quality (weighted PFF grades of receiving teammates), and age — and runs a PCA over them before any model touches the input.
- **Compare prospects to *drafted players only*, via ECDF.** This is one of the moves that most distinguishes him. Career PFF grade percentiles are computed against the empirical distribution of *drafted* players, not all college players, because "narrowing the peer group to NFL-caliber talent" makes the percentile interpretable as "how does this prospect rank against the population that actually got NFL opportunity."
- **Tiers, not ranks, are the unit of inference.** He explicitly disclaims his own ordering: *"If player X has a 91 and player y has a 90, the order doesn't really matter (hit rates are identical when that close). Both players are in the same tier."* This is humility about model precision — the inverse of JJ's "ZAP 99.2" headline numbers.
- **Upside over floor, almost always.** *"Upside is what i care about more than anything in both IRL and dynasty."* This is identical to JJ's variance-over-floor stance, but Bryan applies it to the *prospect-evaluation* level (he consciously chases explosiveness rather than safety in his model weights), not just to format strategy.
- **Athleticism is necessary but not sufficient for RB; Athletic + explosive is the bucket that hits.** *"sometimes you see players who are hyper athletes but not super explosive… i LOVE seeing players with [Player]'s level of athleticism AND a 94th percentile explosiveness score."* Athletic-but-not-explosive is the systematic miss case.
- **Route share / route participation is more predictive than target share.** This is the foundational insight behind his entire weekly toolkit (PWOPR/CIWO/RBH). Targets follow routes; routes lead targets.

---

## The Toolkit

Bryan has more named tools than JJ and they each have specific use cases. Cataloged from his Nov 2024 ["General Recap of my Statistics/Tables"](https://koalatystats.substack.com/p/general-recap-of-my-statisticstables) post, with extensions from later content.

| Tool | What it does | Underlying technique | Use case |
|---|---|---|---|
| **BOSS Models** | Predicts how well a player *should have* performed given realized + situational opportunity (targets, air yards, field position, down, redzone). | Regression on opportunity inputs vs actual FP. | Weekly DFS regression candidates; split into "High Cost BOSS" (DK ≥ $6K), "Low Cost BOSS" (≤ $6K), and "Keep an eye on." |
| **xTD (with Tan Ho)** | Probability of TD on every play, aggregated to player level. | Play-by-play classifier. | Weekly TD regression: most expected vs actual TDs over rolling 3 weeks. |
| **Single Coverage Monsters (SCM)** | Players whose target share spikes in single coverage, intersected with defenses that allow the most single-coverage situations. | PFF Ultimate route-level data. | Weekly start/sit edge cases. |
| **First Read Beasts (FRB)** | Same construction as SCM but on "first read" status instead of single coverage. | PFF Ultimate. | Weekly. |
| **Coach, I Was Open (CIWO)** | Predicts who *should have been targeted* on each play given route-level data, then compares to who was. | XGBoost over route depth, PFF route grade, openness, route group, etc. | Weekly buy-low identification. PFF column. |
| **Predicted WOPR (PWOPR)** | `(1.5 × Share of Predicted Targets) + (0.7 × Share of Predicted Air Yards)` — a WOPR that's been replaced with predicted-target/air-yard shares from CIWO. | Built on top of CIWO. | The flagship metric. R² to next-week FPpG = .346, week-to-week stability = .66 R². |
| **BOOM Percentile** | "Players who need more YARDS to match their PWOPR" — extension of PWOPR onto yards instead of targets. | Residual ranking. | Weekly. |
| **Route-Based Heroes (RBH)** | Regression-to-mean model on FP given PWOPR. | Linear model on residuals. | Weekly PFF column. |
| **Quantile Regression Forest Probability Models** | Simulates "game environments" by predicting 0th-100th percentiles for variables of interest. | QRF. | DFS edge vs Vegas; identifies asymmetric opportunities. |
| **Pre-draft prospect models (RB/WR/TE)** | Predicts average FPpG over a player's first 3 NFL seasons. | Tuned Elastic Net regression on PFF grades + RAS + PCA-derived custom production scores. | Annual rookie evaluation. R² .47 (WR 2025), .608 (RB 2026), .558 (TE 2026). |
| **Predicted RAS** | Predicts each combine drill (except bench press) from PFF tracking data — speed, acceleration, change-of-direction. | Predictive model on tracking data. | Fills in incomplete combine results; new athleticism axis. |
| **Custom Production Score** | Per-season PCA over yards-per-team-pass-attempt, seasonal dominator, novel custom metrics; weighted exponentially by age and conference strength. | PCA → custom weighting. | The production input to the prospect models. |
| **Custom RYOE** | Rushing Yards Over Expectation that includes off/def formation, OL PFF grade, opponent run-defense PFF grade, opponent conference strength, conference mismatch. | Elastic Net over standard yard/down/distance + custom comp variables. | The RB production input. |
| **Junk Yards / BEAST Yards / Little Bro stat / Route Versatility Index (RVI)** | Custom WR production primitives. Junk = yards before contact on <5-aDOT throws (schemed). BEAST = yards on 5+ aDOT passes where receiver gained >5 yards after contact (uncoachable). Little Bro = deep contested catch yards (his high-school-WR brother's "explosiveness" definition). RVI = single-number summary of how good a WR is at every route type vs how all WRs run that route. | Bespoke metric construction. | Inputs to the WR PCA. |

**Things he explicitly doesn't use:** film-based scouting, raw counting stats, raw RAS as a continuous predictor, opponent strength of schedule from college rankings (replaced with his PFF-grade-based custom SOS), per-game rates without route-share normalization.

---

## The pre-draft prospect model — architecture

This is his closest analogue to JJ's ZAP, and the differences are revealing.

**Algorithm:** Tuned Elastic Net regression. Elastic Net is a deliberate choice — it combines L1 (LASSO, drops uninformative features) and L2 (Ridge, shrinks correlated features together) regularization, which is the standard tool when you have many correlated predictors and a small training sample. It is *less* powerful than random forests / gradient boosting but more interpretable and less prone to overfit on ~10 years of class data.

**Target variable:** Average fantasy points per game over the player's first 3 NFL seasons. He's explicit about this — *not* "did he hit top-12" or "did he have one breakout season"; the continuous 3-year-FPpG average. This is a different choice than JJ's binary hit-rate framing.

**Sample selection:** Any player who took an NFL snap or was drafted is "NFL-caliber." His acknowledged filter and a methodological vulnerability — he's modeling *conditional on having received any NFL opportunity*, which is a major selection effect (see gaps section).

**Cross-validation:** He explicitly states the holdout year choice. For the 2026 RB model: *"I chose 2020 as it seemed like a fair choice to not tank or rapidly improve the training R^2 and validation wasn't a big dropoff. because the sample sizes are so small, the validation/holdout can vary by a lot. For instance, if i move my holdout to 2022, the R^2 is like a .62 and it didn't feel fair to advertise that as it would seem suspiciously high imo."* This is unusually honest — he's flagging the variance of his own validation R² as a function of holdout choice.

**Feature engineering pipeline:**
1. Build per-season production primitives (Junk Yards, BEAST Yards, Little Bro / Deep Contested Catch Yards, RVI, etc.).
2. Build custom adjusters: SOS via PFF coverage grades + conference decomposition; Teammate Quality via weighted PFF grades of receivers on the same team.
3. Compute a per-season raw score via PCA over the production primitives.
4. Weight per-season scores by age and conference, sum to a career score.
5. Compute career PFF grade percentile against *drafted players only*, via ECDF.
6. Compute athleticism via three buckets: Official RAS, Predicted RAS (from tracking), GAS (PFF Game Athleticism Score, only since 2019).
7. Feed all of the above (plus Wins Above Average) into the Elastic Net.
8. Refit *the entire model* post-NFL-draft using actual draft capital — he doesn't add a "draft pick multiplier." This is methodologically cleaner than JJ's pre/post-draft revision because the variable interactions get re-estimated; for example, a player whose pre-draft model relied on projected capital that didn't materialize gets correctly punished, while a player who jumped expectations gets correctly elevated.

**Outputs:**
- A point estimate (raw 3-year FPpG prediction).
- A model percentile (where the player falls in the historical drafted-prospect distribution).
- Mathematical comps (nearest neighbors in feature space via Euclidean distance over the PCA-reduced features).
- He publishes the data table with selected columns. Does not publish the trained coefficients.

---

## Position-specific approach

### Running Back

The RB model (R² = 0.608, the highest of his three, on 2026 data) is built around **explosiveness + receiving + RYOE**, in that order, and treats raw rushing volume as a near-noise input.

His most distinctive RB move: **custom RYOE that bakes competition into the expectation**. *"What really makes this RYOE different is its emphasis on competition. For example, when Ashton Jeanty dominates a top tier Power 4 team like Oregon while playing for Boise State, we should heavily reward him. Conversely, if a Power 4 RB struggles to gain yards against a team from the MAC, how can we expect him to succeed at the NFL level?"*

**Where he disagrees with JJ:** JJ has dropped rushing inputs from his RB ZAP entirely; Bryan keeps RYOE *because* of his comp-aware expectation construction. He's not measuring "rushing efficiency in a vacuum" (which is contaminated by OL and scheme) — he's measuring *yards over a context-aware expectation*. This is a defensible methodological argument that they're solving the same problem differently.

**RB hit-rate prior:** *"This class is as bad as they say and honestly, maybe worse. ... if you cant get [the elite tier], or a later [tier-2 RB] (or much later [sleeper]), i would avoid this position."* In a weak class, his prior collapses to "wait until next year." This is contrarian to consensus dynasty content that always feels obligated to manufacture excitement about every class.

### Wide Receiver

WR is his most-developed and best-publicized model (R² .47 on 2025 / .50+ projected on 2026 — exact 2026 number not stated). The flagship feature is his **production-versus-expectation framing**. He builds a "YPRR over expectation" metric that conditions on age, conference, teammate quality, and competition; a positive residual is the breakout signal he weights most.

He explicitly flags **the screen problem**: low-aDOT screens inflate raw production, so he separates "Junk Yards" (yards before contact on sub-5 aDOT throws) from BEAST Yards (5+ aDOT, 5+ YAC) and uses both. Most public WR models use simple per-target or per-route rates that get gamed by screen-heavy schemes; his decomposition is genuinely original.

The **"Group of 5 penalty"** is something he added after a 2024 model miss — *"One thing I think I did poorly in my 2024 model was not accounting for Power 5 or Group 5 enough. This year, I gave a heavy penalty to Group 5 production to omit the 'Josh Cephus' problem."* This is a real public post-mortem (rare in the space) where he names a model failure and the specific feature he added to address it.

### Tight End

The TE model (R² = 0.558) uses receiving-only inputs — *"the tight end production score focuses on receiving ability and does not take any run blocking into account"* — which is a defensible but format-aware choice (receiving correlates with fantasy production, run blocking correlates with NFL viability but not fantasy).

**Where Bryan disagrees with JJ:** JJ's TE model finds a *non-linear* athleticism × capital interaction (less athletic TE + R2 capital outperforms athletic R2 TE because the production must have been undeniable to overcome the athletic deficit). Bryan instead leans on athleticism *strongly* at TE: *"Athleticism is super important for the TE position (more than others)."* This is a real disagreement — JJ would say the athletic TE in R2 is a fade, Bryan would say the athletic + productive TE in R2 is the buy. Two different empirical claims about what TE archetype hits at scale; neither analyst has shown enough data to settle it.

### Quarterback

He is conspicuously thin on QB. He has CIWO/PWOPR/PRESSURE-PREDICTION tools that touch the QB position obliquely, but he has not published a prospect model for QBs. This is a methodological gap relative to JJ, who has made QB framework-building his signature.

---

## Hit-rate definition

Bryan uses **continuous 3-year FPpG average**, predicted directly. He does not stratify by "top-12 finish in years 1-3" or "league-winner rate" the way JJ does. His advantage is that the continuous variable preserves more information; his disadvantage is that "did the model predict the breakout *year*" is invisible — he predicts the average, not the peak.

Cohort definition is "drafted + played a snap in the NFL." When he reports percentiles ("Tyson is in the 95th percentile"), he means against this drafted-NFL-caliber population. This is more honest than comping against "all college receivers" but still a survivorship-biased pool (see gaps).

---

## Quotables

> *"do not trust models without R^2's"* — [2025 NFL Draft Wide Receiver Model](https://koalatystats.substack.com/p/2025-nfl-draft-wide-receiver-model). The thesis statement of his entire brand.

> *"PWOPR is the most stable and predictive receiving metric that i know of"* — [@KoalatyStats, Sep 30 2025](https://x.com/KoalatyStats/status/1973073554167013671)

> *"For the nerds: PWOPR has a .346 R^2 to week N+1 fantasy points. That is VERY VERY good. Stability is .66 R^2 week to week. Insanely good for something so predictive."* — [@KoalatyStats, Sep 30 2025](https://x.com/KoalatyStats/status/1973073556582850908)

> *"If player X has a 91 and player y has a 90, the order doesn't really matter (hit rates are identical when that close). Both players are in the same tier."* — [2026 Post-Draft Rookie Rankings](https://koalatystats.substack.com/p/2026-post-draft-rookie-rankings-model)

> *"I am not a film dude. I don't really care about it at all tbh. I think we have good enough data nowadays to capture most of the nuance in film analysis, but film should be like 20% of the process and I don't have time for that."* — [2025 NFL Draft Wide Receiver Model](https://koalatystats.substack.com/p/2025-nfl-draft-wide-receiver-model)

> *"if you cant produce against a future insurance claims analyst, you probably aren't going to produce against an NFL CB."* — [2026 Dynasty Rookie Sleepers](https://koalatystats.substack.com/p/2026-dynasty-rookie-sleepers-rbwrte). The Group-of-5 problem in one line.

> *"hopefully you find this helpful in the future! you may have noticed one of the things my models really care about is 'how well SHOULD you be performing relative to some metric' I dont focus too much on players who are performing above expectation. This is a weak spot of mine."* — [General Recap of my Statistics/Tables](https://koalatystats.substack.com/p/general-recap-of-my-statisticstables). Self-acknowledged methodological limit, in his own words.

---

## Sources

- [KoalatyStats Substack home](https://koalatystats.substack.com/)
- [koalatystats.com (free tools)](https://koalatystats.com/)
- [koalatystatistics.com (paid SaaS)](https://www.koalatystatistics.com/)
- [@KoalatyStats on X](https://x.com/KoalatyStats)
- [KoalatyStats Patreon](https://www.patreon.com/KoalatyStats)
- [JMP community profile / "Statistics as a superpower"](https://community.jmp.com/t5/JMP-Blog/Statistics-as-a-superpower-for-making-fantasy-football/ba-p/219543)
- [General Recap of my Statistics/Tables (Nov 2024)](https://koalatystats.substack.com/p/general-recap-of-my-statisticstables)
- [2025 NFL Draft Wide Receiver Model (Apr 2025)](https://koalatystats.substack.com/p/2025-nfl-draft-wide-receiver-model)
- [2026 Dynasty Wide Receiver Pre-Draft Model](https://koalatystats.substack.com/p/2026-dynasty-wide-receiver-pre-draft)
- [2026 Dynasty Tight End Pre-Draft Model](https://koalatystats.substack.com/p/2026-dynasty-tight-end-pre-draft)
- [2026 Dynasty Running Back Pre-Draft Model](https://koalatystats.substack.com/p/2026-dynasty-running-back-pre-draft)
- [2026 Dynasty Rookie Sleepers](https://koalatystats.substack.com/p/2026-dynasty-rookie-sleepers-rbwrte)
- [2026 Post-Draft Rookie Rankings](https://koalatystats.substack.com/p/2026-post-draft-rookie-rankings-model)
- [The Mid-Season PWOPR Report (Nov 5, 2025)](https://koalatystats.substack.com/p/the-mid-season-pwopr-report-1152025)
- [NFL 2025 - Breakout Wide Receivers / Route-Based Heroes intro](https://koalatystats.substack.com/p/season-long-route-based-heroes-2025)
- [Future Plans with KoalatyStats (paid Substack launch)](https://koalatystats.substack.com/p/future-plans-with-koalatystats)
- PFF Route-Based Heroes columns ([Week 14 example](https://www.pff.com/news/fantasy-football-route-based-heroes-identifying-players-who-could-break-out-in-fantasy-and-dfs-in-week-14), [Week 16](https://www.pff.com/news/fantasy-football-route-based-heroes-breakout-players-fantasy-dfs-week-16-2024))

---

## Deep dive: analytical reasoning patterns

This section catalogs the *moves* Bryan makes — not the takes — with the intent of surfacing transferable maneuvers that distinguish his analysis. Each example is sourced.

### 1. Reframings — re-asking the question

**"Don't ask if a prospect produced. Ask if his production exceeded what we'd expect for his age, conference, teammates, and SOS."** This is the load-bearing reframe behind every Bryan production score. JJ does this informally with "age-adjusted dominator"; Bryan does it formally — he builds a *predicted* production for each player given context, then computes the residual. Look at how he describes it: *"I created a 'YPRR over expectation' metric based on players age, conference, teammate quality, competition etc."* The transferable lesson: **whenever you're using a level metric, ask what an expected level would look like given the player's environment, and analyze the residual instead.**

**"Don't ask 'what's a player's WOPR?' Ask 'what's a player's *predicted* WOPR given the routes he ran?'"** This is the entire PWOPR thesis. Actual WOPR is contaminated by what the QB chose to do; PWOPR is contaminated only by what the route caller and depth chart allowed. The route is the leading indicator; the target is the lagging indicator. *"On a weekly basis, PWOPR outperforms WOPR (The best single non-model metric for receiving opportunity)."* Repeatable: **build the leading-indicator version of any lagging-indicator metric you care about.**

**"Don't compare a prospect to all college receivers. Compare him to drafted players via ECDF."** ECDF (Empirical Cumulative Distribution Function) is a real statistical move — it gives you a continuous percentile rank without parametric assumptions. By restricting the reference population to drafted prospects, the percentile becomes interpretable as "where does this kid stand vs the population that actually got NFL opportunity." *"By narrowing the peer group to NFL-caliber talent, we can more accurately identify which 2026 receivers are tracking toward elite historical archetypes."* This is what JJ should be doing but isn't (publicly), and it sharpens every comparison.

### 2. Metric-selection trade-offs

**Splitting yards into Junk Yards (schemed) and BEAST Yards (uncoachable).** This is one of the cleanest decompositions in public fantasy analysis. Junk = yards before contact on <5-aDOT throws = "the play was schemed for him to be open and catch a quick pass"; BEAST = yards on 5+ aDOT passes where the receiver also gained 5+ YAC = "he was contested, he won, and he made something happen after the catch." Repeatable lesson: **separate the volume that the scheme manufactured from the volume the player created.** Most analysts conflate these.

**Predicted RAS as a backup for missed combines.** Players opt out of agility drills; their RAS is incomplete. Bryan trains a model that predicts each drill (except bench press) from PFF tracking data — speed, acceleration, change-of-direction. This solves a real problem (missing data) without dropping the player from the model. Repeatable: **when an input is missing structurally rather than randomly, build an imputation model rather than dropping the row.**

**GAS (Game Athleticism Score) as the on-field complement to RAS.** RAS measures combine athleticism in shorts; GAS measures athleticism in pads, in-game, against contact. Bryan keeps both because they capture different signals. The classic example he uses: *"Malachi Fields earned the lowest official RAS in the top 100 PFF big board, but earned the highest GAS percentile among the same group. This is likely due to the differences in how GAS and RAS account for size."* Lesson: **hold two metrics that nominally measure the same thing but are computed differently — when they diverge, you've found a player who's mispriced by whichever metric the consensus is using.**

**RAS gates draft capital, not production.** Bryan acknowledges *"Athleticism by itself is not very predictive. Relative Athletic Score (RAS) is the most predictive single metric that is publicly available, and it is difficult to parse out whether RAS is inherently predictive or simply predictive because it affects draft capital."* He's directly grappling with what JJ ducks — RAS is a confounded variable. His response is to keep RAS but pair it with GAS and Predicted RAS to triangulate which component (testing fitness, on-field application, perceived fitness) is doing the work.

**Custom RYOE with comp-aware expectation.** Standard RYOE is dominated by box counts and OL. Bryan's RYOE conditions on offensive formation, defensive formation, OL PFF grade, opponent's run-defense PFF grade, opponent conference strength, and a custom conference-mismatch term. The expectation is calibrated to context, so the residual measures the player. *"Mike Washington Jr. ranks 51 in RYOE per attempt from that group. Only three of the 52 have a negative RYOE: Ray Davis (-0.01), Mike Washington Jr. (-0.10), and David Montgomery (-0.18)."* Lesson: **when an environment-dominated metric doesn't predict outcomes, don't drop it — re-engineer the environment out of it.**

### 3. Specific heuristics — "if X then Y"

- **Athletic + Explosive (top quartile in both) = the prospect bucket I want.** Athletic-but-not-explosive players are the systematic miss case. Athletic + Explosive + young + productive against power competition = "the only truly elite profile in the class."
- **Production at 18-20 against SEC ≫ Production at 22-23 in MAC.** He weights age and conference *exponentially* in his career-score aggregation. The same season looks 90th-percentile-elite or 30th-percentile-mid depending on these two adjustments.
- **PFF career grade percentile against drafted players >75% with R1/R2 capital → buy regardless of athletic score.** He uses this rule to elevate "complete profile" prospects over "freaky athlete" prospects.
- **PFF career grade <40th percentile + good RAS → "hyper athlete with no production" → fade.** *"Profiles like this tend to fail, but the upside argument can't be ignored."* He's open about the upside argument but his model says fade.
- **Rookie WR with EDP < 100 + 90th-percentile RVI + 70th-percentile PFF career grade = sleeper bucket.** The "Good PFF Rank + Elite RVI" intersection is his unofficial sleeper criterion.
- **TE class with ≥4 TEs above 90th-percentile GAS in the same draft = unusually strong class.** He used this in 2026 to flag a deep TE class that was otherwise being underdiscussed.
- **PFF Big Board > 150 + EDP < 200 + above-50th-percentile model score = stash candidate.** Late-round upside hunting framework.
- **Tier compression rule: |Δ percentile| < 5 = same tier.** Hit rates are statistically indistinguishable inside that band.
- **Refit the entire model post-draft.** Do not add a draft-capital multiplier; let the variable interactions re-estimate.

### 4. Pushback against consensus

**"Consensus WR1 is not always model WR1, and that's fine."** In 2025 his model had Luther Burden III as WR1 and Tetairoa McMillan as WR2 — directly against industry consensus. *"Putting him as WR1B felt like a cop out though."* He rejected the safe-tie option. In 2026 he had Jordyn Tyson as WR1 and Carnell Tate (the consensus #1) as WR4. He explicitly addresses why: *"When I first ran the model and saw Tate's ranking, I was like 'People aren't gonna be happy about this' but I never want to manipulate my findings or anything to mesh with the consensus."* Repeatable lesson: **when your model disagrees with consensus, publish the disagreement and the reasons — don't fudge.**

**The "process people" callout.** He explicitly names which other analysts have legitimate process (Marvin, Peter) and warns about the rest as "sus." This is unusual public-square behavior — most analysts won't risk burning bridges by naming whose work they trust and whose they don't.

**The Group-of-5 penalty.** He directly named a 2024 model miss case ("the Josh Cephus problem") and engineered a corrective input. This is the only public post-mortem in his archive that names a specific failure and the specific fix. Lesson: **when you whiff, name the player, name the input that whiffed, and name the fix you added.**

**The Eli Stowers vs Kenyon Sadiq disagreement.** Sadiq is consensus TE1 in 2026 (PFF Big Board #14); Bryan's model has Stowers as TE1 (PFF Big Board #53). He stakes his reputation on it: *"I am actively trying to trade in my pre-draft leagues for two specific players. One of which, I am very confident in."* He is forecasting TE1 from R2 capital — which JJ's model would categorically rule out. Whether he's right or wrong, the public commitment is real.

### 5. Process-vs-outcome reasoning

**"Process over Results"** is a recurring frame: *"Keep this in mind before i type it 'Process over Results' Tre Harris is a little bit like a more explosive, slightly older Elijah Moore. Moore had a phenomenal profile coming out of college and was my models' WR3 that year."* Moore had a great profile and didn't pan out; Bryan refuses to update his profile-evaluation framework based on a single outcome — but he acknowledges the result, names the comp, and explains why he's still betting the profile.

**"Injuries aren't predictable."** Used as a defense for keeping a model-loved injured prospect (Jordyn Tyson) at the top of his rankings rather than discounting for injury risk. Same epistemic move as JJ defending Etienne post-Lisfranc — one bad outcome shouldn't discount four years of college signal. Repeatable: **when a single outcome (injury, bad game) creates a discount that exceeds the information content, fade the discount.**

### 6. Comp-based reasoning

**Mathematical comps from Euclidean distance over PCA-reduced features, not narrative.** *"I don't really 'believe' in player comps, but if i ever did, they would be based on math and either using PCAs or some kind of smart clustering. The player comps above are based on simple Euclidean distance scores based on the variables you see."* Same architectural principle as JJ's comps, executed differently. Bryan's sample of comps tends to be small (5-10 nearest neighbors); he uses them as sanity checks rather than as standalone predictions.

**Burden = "poor man's Nabers or Chase."** *"Burden has the profile of a potential future star akin to poor mans' Nabers or Chase. However, he lacks in true explosiveness which will hold him back from being at the Nabers or Chase level. via my Season Score metric — Burden's sophomore season was the 21st best season out of all players since 2016."* Notice the move: he places the prospect within a tier of historical hits (Nabers/Chase), then immediately marks down where he falls short of the apex. He's neither inflating to the comp nor fleeing from it.

**Rejecting bias in his own comps.** *"BIAS ALERT BIAS ALERT — Zachariah Branch: I watched every snap of him at UGA. He looks like an NFL player, but his data is not kind to him."* He flags his own bias when it appears, even when he can't shake it. Lesson: **publicly mark which of your beliefs are model-backed vs gut-backed; let the reader weight them appropriately.**

### 7. Calibration and post-mortems

**Public R² tracking.** Every major model post quotes a CV R². 2025 WR R² = 0.47. 2026 RB R² = 0.608. 2026 TE R² = 0.558. He compares model versions explicitly: *"The 2026 model is a good improvement and tbh idk if i will ever beat it."*

**Naming the holdout-year sensitivity.** Published statement that moving the 2026 RB model holdout from 2020 to 2022 jumps the R² to .62 — and his refusal to advertise the higher number because the validation is too noisy. This is *very* clean methodological hygiene.

**Past-class retrospectives.** In the 2025 WR post he published "All Time (Sorted by Model %)" and "All Time (Sorted by FPpG)" tables showing his model's historical predictions vs realized FPpG. This is the closest public Brier-score-style validation of any rookie model in the space. *"Sad Skyy Moore never did a thing"* — direct acknowledgment of a prior whiff.

### 8. Self-acknowledged methodological limits

This list is unusually frank by the standards of public fantasy analysis:

- *"my models really care about 'how well SHOULD you be performing relative to some metric' I dont focus too much on players who are performing above expectation. This is a weak spot of mine."* — confession that his framework systematically underrates "above-expected" players (which is roughly the JJ/Pat Kerrane sweet spot).
- *"the sample sizes are so small, the validation/holdout can vary by a lot."* — small-sample R² volatility.
- *"This probably needs an entire substack of its own to explain"* — multiple QRF-derived game-environment models that he hasn't fully written up, which means consumers can't audit them.
- *"sometimes i do see some things"* — admission that his "I don't read other analysts" stance is imperfect.

### 9. Year-2 / veteran reprojection — the gap

Bryan does not have a published "Year 2 Model" the way JJ does. His weekly tools (PWOPR/CIWO/RBH) function as in-season reprojection but they update on weekly data, not on a structured "rookie year route share → Year 2 expected production" framework. This is a meaningful methodological gap (see below).

### 10. Triangulation against peers

**vs JJ:** They agree on opportunity > production, age-adjustment, comp-based reasoning, upside-over-floor, and "process over outcome." They disagree on (a) how much to weight draft capital — Bryan trusts the model's verdict more, JJ trusts the market's verdict more; (b) athletic-vs-production at TE — JJ's interaction term says R2 productive-and-unathletic TE wins, Bryan says athletic-and-productive TE wins; (c) RB rushing inputs — JJ dropped them, Bryan kept a comp-aware version; (d) hit-rate framing — JJ uses ordinal rank (top-12 / league-winner), Bryan predicts continuous FPpG.

**vs Hayden Winks:** Both lean PFF-data; Winks weights athleticism more aggressively as a continuous predictor, Bryan uses athleticism gates and conditional interactions.

**vs Pat Kerrane:** Bryan is openly anti-film, Kerrane is film-and-scheme-fit. Bryan's stance is essentially "tracking + grade data has subsumed most of what film captured"; Kerrane's stance is the inverse.

**vs Rich Hribar:** Bryan goes deeper at the route level (PWOPR/CIWO); Hribar covers the team-matchup level. They are largely complementary — Hribar tells you a defense is bad against TEs, Bryan tells you which TE on that team is positioned to exploit it.

**vs Ben Gretch (Stealing Signals):** Gretch is more philosophical/narrative; Bryan is more numerical. They share "opportunity is the leading indicator" and "process-over-outcome" framings.

**vs Marvin Elequin:** Bryan publicly endorses Marvin's process. Marvin's models also use 2010-2024 data with explicit train/test splits. Whether their predictions correlate is unstudied (would be a useful exercise).

---

## Methodological gaps in his framework

These are *statistical* gaps in Bryan's analytical approach independent of league format.

**1. Selection bias in the "drafted + played a snap" cohort.** His training universe is "anyone who took an NFL snap or was drafted." That cohort is conditional on having survived two screening processes — NFL drafting and roster-keeping — which both heavily correlate with the same features his model is trying to use. The implied "X% of prospects with this profile hit" is really "X% of prospects with this profile *who reached the NFL with sufficient draft capital to get a snap* hit." This is the same flaw as JJ's model and is structurally hard to fix without college → NFL transition data.

**2. The ECDF-against-drafted-players move is the *strength* and the *weakness* of the model simultaneously.** Comparing prospects to drafted players gives meaningful percentiles but obscures the shape of the un-drafted distribution. A prospect at the 95th percentile of drafted players might be at the 99.9th percentile of all college receivers — or only at the 92nd percentile if you re-include the un-drafted tail. The model has nothing to say about Tier 1 (un-drafted breakouts).

**3. Continuous 3-year FPpG is the wrong target for several real questions.** It's correct for "what's the expected fantasy production"; it's wrong for "did this prospect have a usable peak season" (a high-variance late-bloomer scores low on the average) and for "does the prospect have league-winning weeks" (top-3 finishes are the variable that wins championships, and FPpG averaging hides them). His model thus systematically underrates high-variance prospects with league-winning ceilings and a couple of zero seasons — the exact archetype dynasty managers should value most.

**4. Elastic Net is a *linear* model with regularization.** It cannot capture interaction effects unless he hand-engineers them as features. He has flagged some non-linearities (Group-of-5 penalty, athletic × explosive bucket) but the framework cannot discover novel interactions on its own. JJ's TE model finding (capital × athleticism interaction) is exactly the kind of thing that would emerge from a tree-based model and would be invisible to Elastic Net unless he pre-specifies the interaction term.

**5. PCA destroys interpretability and may discard relevant signal.** When he runs PCA over 5+ production primitives and keeps PC1, he's keeping the largest-variance direction — which is not necessarily the most predictive direction for FPpG. This is a known issue with PCA-as-feature-engineering. Supervised dimension reduction (PLS, target-encoded reductions) would be more appropriate for prediction.

**6. R² as a model-quality metric overweights stability over calibration.** A model with R² = 0.47 that systematically under-predicts the top quartile and over-predicts the middle is performing worse for his actual use case (identifying breakouts) than a lower-R² model with calibrated tails. He doesn't publish calibration plots or per-percentile residuals, so we can't audit this.

**7. No published confidence intervals or prediction intervals.** Same gap as JJ. A 91 vs 90 might be statistically indistinguishable, and he says as much in the tier disclaimer — but the model still publishes them as ordinal ranks. Bootstrap CIs would be straightforward to add and conspicuously missing.

**8. The custom production score is opaque.** He says it's a PCA over multiple custom metrics, weighted exponentially by age and conference, summed across seasons. The exact weights are unpublished. A reader cannot replicate the score or understand which components are doing the heavy lifting.

**9. Survivorship bias in the comps pool.** When a prospect's nearest neighbors are 5 historical players, those neighbors are filtered to "drafted + played a snap." If 3 of the 5 hit, the implied hit rate is 60% — but that 60% is conditional on the comps having reached the NFL, which the current prospect has not yet done.

**10. No second-contract or age-curve framework whatsoever.** Like JJ, his framework is rookie-evaluation + weekly-update. The dynasty trade-and-extend layer is unaddressed in the model. He has light commentary ("Adam Randall, give him cheeseburgers Eddie Lacy style") but nothing systematic on RB age cliff, WR aging curve, or QB longevity.

**11. Self-acknowledged miss: he doesn't model "performing above expectation" players.** This is his largest stated gap and he's clear about it. The implication: his framework is structurally biased *against* the JJ ZAP-style upside lottery tickets that consensus tends to overrate. A model that over-corrects for over-performers will systematically miss outlier hits whose breakout came because of an un-modeled trait (gravity, RAC ability, scheme fit).

**12. The "I don't consume other content" stance is methodologically defensible but limits triangulation.** It removes a confounding source of bias but also removes the information content of competing models. The right move is probably "consume other models, weight them in, but flag what's yours vs what's borrowed" — which is more work but more accurate.

**13. PWOPR's R² of 0.346 for next-week FPpG is good but is *not* what most consumers think it is.** A 0.346 R² means PWOPR explains ~35% of the variance in next-week fantasy points. He says *"that is VERY VERY good"* — and it is, by NFL prediction standards, but it also means 65% of the variance is unaccounted for. Casual readers see "the most predictive metric" and read it as "the metric that reliably predicts next week," which it is not. The framing creates false precision.

**14. Refitting the entire model post-draft is methodologically clean but creates a temporal-leakage concern.** When he says "Tyson moved up 5 points and Tate didn't move," that delta is partially the result of new data (actual capital) and partially the result of the model re-estimating *all coefficients* on the new data — which means a player can move up not because his profile got better but because the model re-weighted features on the post-draft sample. Without publishing the coefficients, we can't tell which is which.

**15. The PWOPR for RBs caveat is buried.** He notes in the Mid-Season PWOPR Report that *"RB PWOPR is much more of a measure of how many routes you are running… typically against zone coverage."* This is a critical caveat — RB PWOPR is measuring something fundamentally different (route participation in pass-game contexts) than WR/TE PWOPR (target-share-leading-indicator). A consumer reading the same column for RB and WR may not realize the metric isn't comparable across positions.

---

## Where Koalaty agrees with JJ vs disagrees

### Agreement (the high-confidence consensus zone)

- **Opportunity > production** at every level (route share leads target share leads receptions leads fantasy points).
- **Age-adjustment matters**, and the same production at 19 is structurally better than at 22.
- **Conference and SOS matter**; raw counting stats are meaningless without context.
- **Comp-based reasoning beats narrative.**
- **Process > outcome.** Don't update your evaluation framework based on a single hit or miss.
- **Upside > floor in formats where rank payoff matters.**
- **Athletic testing is a gate, not a generator** for RB/WR (TE is where they disagree).
- **Touchdowns regress; volume sticks.**

### Disagreement (the actual edge zones)

- **Draft capital weighting.** JJ: capital is the prior and the model should override it only at the margin. Bryan: the model's verdict on profile holds independent of capital, and post-draft refitting lets capital interact with profile rather than trump it.
- **TE archetype.** JJ says less athletic + more productive + R2 capital; Bryan says athletic + productive at TE. Real empirical disagreement.
- **Hit-rate target.** JJ: top-12 in 3 years (binary) and league-winner rate. Bryan: continuous 3-year FPpG average.
- **RB rushing inputs.** JJ: dropped. Bryan: kept, but only as comp-aware RYOE residuals.
- **Film.** JJ uses film occasionally as a tiebreaker. Bryan rejects film almost categorically.
- **R² publishing norms.** JJ: doesn't publish a holdout R² for ZAP. Bryan: makes R² central to the brand.
- **Modeling for above-expectation players.** JJ's framework is centered on identifying these. Bryan acknowledges his framework systematically misses them.

### Distinctively Koalaty's contribution that JJ doesn't have

1. **Route-level play-by-play data fluency.** PWOPR, CIWO, BEAST/Junk yards, RVI — these are entirely Bryan's, built on PFF Ultimate route-tagged data that JJ doesn't reach.
2. **Predicted RAS via tracking data.** Solves the missing-combine-data problem at scale.
3. **GAS as an on-field complement to combine RAS.** Triangulates "athleticism in shorts vs in pads vs as predicted from games."
4. **ECDF percentile against drafted-only population** — a clean methodological move JJ doesn't (publicly) do.
5. **Refit-the-whole-model post-draft** — methodologically cleaner than additive draft-capital adjustments.
6. **Custom comp-aware RYOE** — closes a real gap that the rest of the public space leaves open.
7. **Junk Yards / BEAST Yards split** — original and genuinely useful primitive.
8. **Public R² targeting and named holdout-year sensitivity** — sets a higher epistemic bar than the rest of the rookie-model space.

### What's distinctively JJ that Bryan doesn't have

1. The format-dependence taxonomy (variance ≠ universal).
2. The Late-Round QB framework (FP/DB threshold, rushing-yards gate, TD-rate flag).
3. The Year-2 model with structured rookie-year opportunity update.
4. The trade-timing heuristics (RB age cliff, mid-October sell window, WR cliff pushback).
5. The format-classification → variance-vs-floor mapping.
6. The 14-year refined position on QB strategy.
7. The "would I redraft this player at this asset cost today" gut-check framing.

---

*Caveat: Bryan's actual Elastic Net coefficients, exact PCA loadings, and the trained CIWO XGBoost model live behind his Substack paywall and Patreon. The methodology above is reconstructed from his public posts, the JMP community profile, his X feed, and the shared data tables — directionally accurate but not the exact spec a competitor would need to replicate the model.*

---

## Paid-content extensions (Substack + Patreon)

*Added 2026-04-28 from a logged-in pull of the paid Substack archive. Patreon was blocked at the safety layer of the browser MCP, so this section reflects Substack-only paid content. Sources cited inline.*

### What changed pre→post-draft on the 2026 rookie model

The biggest single artifact behind the paywall is the **post-draft refit** of all three rookie models. The pre-draft posts laid out the architecture; the post-draft post (Apr 27, 2026) shows the *behavior* of that architecture under new information.

- **Mechanism is a full refit, not a draft-capital adjustment.** Bryan is explicit: *"i refit my entire model post draft. I don't just add a draft pick multiplier or something. So the way the entire model and all of the variables interact with each prospect is different post draft than pre draft."* Two consequences fall out of this that matter for our model-of-his-model: (a) a player can move *down* even if his draft slot was on-script, because the variable-interaction estimates re-fit on the new sample; (b) the pre-draft and post-draft model percentiles are not directly comparable — they're outputs of two different fitted models on overlapping but not identical training distributions.
- **Worked examples of the refit's behavior.** *"Jordyn Tyson moved up 5 model percentage points and Carnell Tate didn't move. The reason for this is interactions between variables. Tyson has an elite production profile AND got top 10 draft capital. Carnell Tate was being carried in his pre-draft model by his projected draft capital. His projected draft capital came to fruition so nothing changed. Had he fallen in the draft, his model score would have taken a massive hit. Omar Cooper is another good example of a player who went up 3 points as he is very explosive and has good career PFF grades AND he's now a first round pick. Historically, players with that kind of profile are successful."* The interaction logic he's describing is **profile × capital × prior-class-survival** — the post-draft model is asking "given the joint distribution of profile-quality and capital among historical 3-year hits, where does this prospect land?" rather than "where does his profile land, multiplied by his capital."
- **Post-draft R² values are not published.** Pre-draft R² (RB 0.608, WR ~0.50, TE 0.558) is in the brand DNA, but the post-draft post conspicuously omits cross-validated R² for any of the three refits. Best inference: the post-draft refit is a smaller-sample exercise (only adds the most recent class to the training set) and Bryan is uncomfortable advertising R² that he flagged as holdout-sensitive in the pre-draft post. **This is a methodological gap relative to his own brand standard** — readers don't get a CV R² to tell them how seriously to take the post-draft order, and he doesn't say which holdout he's using.
- **Specific archetypes that moved.** Tyson up 5pts (elite production + top-10 capital interaction). Cooper Jr up 3pts (explosive + PFF grade + first-round capital interaction). Tate flat (capital landed exactly as priced in). Day-3 fallers: Stribling went *up* from 36% pre-draft to 49.9% post-draft purely because Round 2 capital pulled the model output higher than profile alone — a case where capital arguably *over*-rescues profile. Caleb Douglas (PFF Big Board #156, drafted #75) is flagged as a model-vs-capital divergence Bryan has no explanation for. **Repeatable lesson:** in his framework, the post-draft delta is a *diagnostic of profile-capital fit* — large positive delta = profile and capital both endorsed; large negative delta = capital didn't show up; near-zero delta = capital landed exactly where the profile predicted.
- **The "1.06 is a mistake" framing.** *"Price is in contention for the worst 1st round RB profile in my fantasy lifetime."* The post-draft post is more pointed than the pre-draft posts — Bryan is willing to use the post-draft information to *rule out* picks at consensus dynasty cost, not just rank prospects. The transferable move: **post-draft refits should generate sell calls, not just buy calls.**

### Mid-Season PWOPR Report internals

The Nov 5, 2025 PWOPR Report is the first full subscriber-only artifact of the paid era and is structurally important because it shows what Bryan thinks the *ongoing* PWOPR product looks like for paid subs.

- **Structure.** The report has six parts in order: (1) most-recent-3-weeks PWOPR leaderboard, (2) season-long Top-20 WR PWOPR leaders with a "purple-gradient" heatmap, (3) Top-20 TE PWOPR leaders, (4) Top-20 RB PWOPR leaders, (5) **WOPR–PWOPR residual leaderboard** (the ones being underused — labelled "getting open more often than they have been targeted"), and (6) per-team writeups for all 32 teams with three bullet-point notes each. The residual table is the buy-low engine; it's the highest-leverage section.
- **PWOPR rule of thumb published explicitly.** *".50 PWOPR is roughly a WR1 level PWOPR."* This is a thresholding heuristic he hadn't published in free content. It implies a calibration: he treats PWOPR as a *team-relative* WR-tier classifier, not as a continuous predictor of fantasy points (the latter is what RBH residuals do).
- **Position-relative PWOPR caveat — RB is a different metric.** Confirmed: *"RB PWOPR is much more of a measure of how many routes you are running… typically against zone coverage with some exceptions. CMC, Bijan, and Achane all act as slot receivers for their team every now and then."* TE PWOPRs are also structurally lower because routes are shorter (less air-yard share). **This means Bryan's published PWOPR leaderboards are not cross-position-comparable** — a 0.50 RB PWOPR is elite, a 0.50 WR PWOPR is the floor of WR1. A consumer using PWOPR-by-position needs to know the implicit reference distribution differs.
- **Filtered-input note.** *"My data will look different than any routes you look at elsewhere as i filter out certain routes and plays for the PWOPR calc (DPIs, plays with only 2 routes or less, stuff like that)."* Bryan filters DPI plays and very-low-route-count plays before computing predicted-target probability. **This is a methodological choice worth flagging:** filtering DPIs removes a subset of high-leverage plays where the receiver clearly won, which arguably under-credits separation-creators who draw flags.
- **The "Iosivas/Nailor/Washington/Moore" archetype.** A new repeatable pattern across the report: Bryan groups players who are *good at getting open but trapped under elite gravity teammates* — Iosivas under Chase/Higgins, Nailor under Jefferson, Washington under Hill/Waddle, Chris Moore on Washington Commanders. He uses this archetype as a "wait for injury or trade" sleeper bucket. Useful taxonomy for our extension-worthiness work: **a high-PWOPR low-WOPR profile is structurally hard to monetize unless ahead-of-them gravity falters.**
- **The Higgins/Adams "open when not open" exception.** *"Tee Higgins is a GREAT example of why PWOPR isn't perfect by any means. A player like Higgins is open when hes not open. Just throw it up and see what happens."* Same disclaimer applies to Davante Adams and Puka Nacua. Bryan flags this as a known PWOPR limit: contested-catch alpha-targets are *under*-rated by a model that defines openness via tracking-derived separation.
- **Stafford-class quarterback effect.** *"PWOPR isnt everything, sometimes you are Puka Nacua with the Kingmaker Matthew Stafford."* He acknowledges that elite QBs convert non-open targets into completions at a rate the model can't capture. Implication: PWOPR systematically under-rates WRs paired with elite passers and over-rates WRs paired with checkdown-prone QBs (his Daniel Jones / Sam Darnold takes throughout the report turn on this exact mechanism, framed as backhanded compliments).

### Patreon access (blocked)

The browser MCP refused navigation to `patreon.com/KoalatyStats` with a safety-layer block. Substack remains the canonical home for his methodology writeups regardless; the Patreon was originally a $3/mo DFS optimizer and based on his February 2026 paid-Substack pricing ($4.17/mo via annual) the methodology center of gravity has clearly moved to Substack. **Verdict: no methodology gap created by the Patreon block.** Anything Patreon-only would either be DFS lineup outputs (not methodology) or duplicates of the Substack writeups. If a follow-up run wants to confirm, the user would need to pull Patreon manually.

### Year-2 / sophomore reprojection — gap confirmed and characterized

**Bryan does not have a year-2 reprojection model.** This was a gap in the previous research run and the paid archive confirms it. What he *does* have is the "2026 Potential Breakout Wide Receivers" post (Feb 20, 2026), which is the closest he gets to year-N+1 reprojection — but it is not a model. It is a per-player table with three custom metrics (PWOPR, PTPRR, BEAST YPRR) plus five PFF stable metrics (Receiving Grade, Receiving Grade vs Single Coverage, Separation Percentage, YPRR, YAC per Reception), each as percentile ranks, and analyst commentary that compares price-on-FantasyCalc to the percentile profile.

Three implications for our work:
- **He has solved the *features* for a year-2 model but not the *target.*** PWOPR/PTPRR/BEAST YPRR are exactly the leading-indicator inputs you'd want; he just hasn't fit a regression that takes year-N PWOPR and predicts year-N+1 FPpG. Doing this in our pipeline (using nflverse weekly data) is a small lift and would directly fill a gap his framework leaves open.
- **He uses FantasyCalc/KTC dynasty rank as the implicit reprojection target.** When he writes "Zay Flowers is the WR25 in dynasty on Fantasy Calc and his profile says he should be higher" — that's the year-2 reprojection in narrative form. The price-vs-profile delta is the bet. **Repeatable move: use a market-rank residual as the target variable when your modeling target is fuzzy.**
- **PFF WAR appears for the first time as a feature.** *"WAR is something NFL teams definitely pay some amount of attention towards and can be helpful in identifying players that may get more snaps next season."* This is novel — WAR isn't in his prospect models because the underlying PFF WAR computation is for NFL snaps only. He's flagging it as a year-2 leading-indicator (NFL teams reward it with snaps), which is a different theory of action than the prospect-model framework.

### Past-class retrospectives — what's actually published

The paid archive has *less* rigorous calibration analysis than the previous research speculated.

- **No published Brier score, no calibration plot, no per-percentile residual table for past rookie classes.** The 2025 WR post had an "All Time (Sorted by Model %)" and "All Time (Sorted by FPpG)" table, which is the closest thing to a public calibration audit, but it's two sortable lists, not a calibration curve. The *Skyy Moore acknowledgment* and *Group-of-5 penalty / Josh Cephus* references remain the only named-miss post-mortems.
- **The 2026 post-draft post does NOT publish a 2025-class hit-rate retrospective.** Bryan was a paid sub launch on Oct 28, 2025 — i.e., the 2025 rookie class was his FIRST cohort to grade behind a paywall, and the natural "here's how my 2025 model performed" retrospective for paying subscribers does not yet exist. **This is a real gap and one we should flag explicitly:** the calibration audit that would justify his paid pricing tier hasn't been written.
- **What exists instead are *current-season* retrospectives via PWOPR.** *"For those that may not remember, early in 2025, my models had him as a potential breakout. He then recorded like 40+ FP and was THE WR1 on the week."* (Tre Tucker callback in the Feb 20, 2026 breakout post.) These are confirmation-bias-friendly highlights, not systematic calibration. He cherry-picks the wins but doesn't (publicly) tabulate the losses.
- **The 2026 RB Production Score post (Feb 27, 2026) does publish a partial-model R²** — *"This variable has a standalone, not super impressive .15 R^2 to 3-year NFL FPpG. BUT and what i really care about: Draft Pick has a standalone .33. When combining Career Score and Draft Pick the new Adjusted R^2 is .38."* This is the only published *incremental-R²* statistic in his archive: the Career Score adds 5% explained variance over draft pick alone. **Useful number to remember: Bryan's college-production-score-only signal is worth ~5 percentage points of R² beyond capital.** That's the upper bound on how much non-capital production signal his framework captures.

### The weekly column architecture (paywalled methodology)

The weekly Advanced Stats / Predictions posts (Week 9 through Wildcard Round) all share a consistent six-piece structure that's worth cataloguing because it shows how he stitches his tools together for actionable output:

1. **Score Model output** — straight-up game prediction with ML, spread, and total. Computed offline; he reports the result, not the inputs. Clear from his writing this is a Vegas-line-residual model (he says when his model disagrees with the line).
2. **EPA capture rate** — *"Drake Maye has been THE highest EPA capture rate player in my entire dataset (going back to 2019)."* This is his single QB-quality metric. EPA capture rate = realized EPA / opportunity-adjusted EPA expectation. Custom and not the same thing as nflverse EPA per play.
3. **Coverage shell breakdown — MOFO / MOFC / Zone / Man.** Per-team weekly trends (e.g., *"SEA Defense has been playing WAY more man coverage lately… they rank 15th, but they still play zone 71% of the time"*). He publishes pressure rate, quick pressure rate, season zone rate, playoff zone rate, and zone rate since week 14 — five rolling-window cuts on coverage tendency.
4. **Quarterback-vs-shell PFF grade splits.** *"Drake Maye PFF Grade against Zone Coverage = 88.1 — against man coverage = 63.5"* and *"82.7 PFF grade against MOFO (74.9 vs MOFC)."* This is where he gets actionable QB-by-shell signal that pure EPA hides.
5. **Per-receiver TPRR-by-shell splits.** *"Stefon Diggs has a team-leading 22.9% TPRR in MOFO situations… DeVonta Smith has a team-leading 31% TPRR vs MOFO (+6.3) vs 24% baseline."* TPRR-by-shell is the leading-indicator he uses to project receiver targets for the upcoming game. The (+6.3) is the player's MOFO-vs-baseline delta — his explicit residual scoring.
6. **Sicko Mode SGP** — the betting story constructed from steps 1-5. The story-and-bet format is the deliverable; the story is causal ("better QB wins, better QB targets shell-favored receiver, those receivers score") and the bet is parlay'd at +3000-+12000 odds.

**The transferable structural insight:** Bryan's weekly workflow is a **shell-to-target-share-to-fantasy-points pipeline** that is fundamentally different from typical DFS workflows that go matchup-to-projection. He's making the coverage shell the *primary* inference axis and routing player projections through it. **This is original and underused.** Most public DFS columns lead with player projection and mention coverage as flavor. Bryan leads with coverage shell and derives player projection.

### New methodological gaps surfaced from paid content

These extend (and in some cases sharpen) the gaps section above:

**16. The post-draft model R² is unpublished.** Bryan's brand insists on R² but the post-draft refit doesn't quote one. Holdout-year sensitivity (which he flagged for pre-draft) presumably gets *worse* post-draft because the training set adds the draft-class-immediately-prior, which is methodologically the riskiest data point. Readers can't audit this.

**17. Pre-draft and post-draft model percentiles are not directly comparable.** Same prospect, two different fitted models, two different training sets. Bryan reports both as "model %" with no caveat. A reader interpreting "Tyson moved 5 points" as "Tyson got 5 points better" is misreading — Tyson got 5 points better *under a re-estimated model*. This would be invisible to an audit unless the coefficients were published.

**18. The PWOPR DPI filter under-credits separation-creators.** Filtering DPI-drawing plays from the predicted-target probability calculation is a defensible choice for stability, but it systematically under-credits receivers whose openness shows up as flags more than as catches. Mike Evans and DK Metcalf-type players are likely under-rated.

**19. PWOPR is not cross-position-comparable.** RB PWOPR measures route participation against zone, WR PWOPR measures target-share-leading-indicator, TE PWOPR is structurally lower than WR PWOPR because of route-tree shape. Bryan flags this in the Mid-Season Report but his single-position weekly columns and PFF columns don't restate the caveat — a reader pivoting between the columns can mis-compare.

**20. No published 2025-class retrospective despite that being the natural paid-launch deliverable.** This is the most defensible-to-write missing piece in his archive: he started charging Oct 28, 2025, and the 2025 rookie class is the first paid-era cohort he should be grading. A "here's how I did" post would justify the price; its absence is conspicuous. Plausible explanation: a class-1 retrospective is methodologically embarrassing if the model whiffs visibly, and he may be waiting for the second NFL season to lengthen the tail.

**21. EPA capture rate is undocumented.** It's the single most-cited QB metric in his weekly columns — *"highest EPA capture rate player in my entire dataset"* is a brand claim — but the formula is not published. Consumers can't replicate or audit; competitors can't compare.

**22. The Score Model is undocumented.** He uses it weekly to take a market position ("STRAIGHT UP upset") but doesn't expose the inputs, the training set, or the historical accuracy vs Vegas. This is the largest opaque tool in the kit.

**23. The TPRR-by-shell methodology is implicit.** He publishes raw TPRR splits (e.g., +6.3 over baseline in MOFO) without quoting how many routes are required for the split to be reliable. A 78-route MOFO sample (Samaje Perine in the cited Week 17 example) is meaningful but borderline — no published threshold.

### Insights and reasoning patterns new to the paid archive

These are *moves* not in the previous memo's "analytical reasoning patterns" catalogue.

**A. Profile-capital interaction as the post-draft inference unit.** "Tyson up because elite profile *plus* top-10 capital is a historically successful combo; Tate flat because his profile was the capital bet" is a different reasoning move than additive draft-capital adjustment. The interaction is the inference. *Repeatable:* **when you refit post-information, look at which players moved on the interaction term, not on the additive term — those are the model's strongest non-trivial predictions.**

**B. Coverage shell as the leading axis.** Most analysts treat coverage as a sub-bullet under matchup; Bryan uses it as the *primary* inference axis and derives player-level projections from it. *Repeatable:* **invert your weekly workflow — start with the team-level coverage shell and route your player projections through it, not the other way around.**

**C. Market-rank residual as a fuzzy-target replacement.** Where he doesn't have a year-2 model, he uses FantasyCalc/KTC rank as the target and reasons about the profile-vs-rank delta. *Repeatable:* **when you don't have a clean target variable, use a market consensus as a proxy and bet on residuals.**

**D. The "Iosivas archetype" as a structurally-pinned sleeper bucket.** A new taxonomy: high-PWOPR + low-WOPR + dominant-teammate-gravity = "wait for injury or scheme change." Names a previously-unnamed player type. *Repeatable:* **stratify your sleepers by *why* they're stuck — dominant teammate, bad QB, scheme misfit — because the unlock condition for each is different.**

**E. Capital-as-rescue vs capital-as-confirmation diagnostic.** When post-draft delta is large positive and pre-draft model was lukewarm, capital is *rescuing* a profile (Stribling). When delta is near-zero and both are high, capital is *confirming* (Tate). When delta is large positive and both are high, profile and capital *interact* (Tyson, Cooper). Three different bets with different risk profiles. *Repeatable:* **decompose post-information moves into rescue / confirmation / interaction categories — they have different forward hit rates.**

**F. PWOPR threshold publishing.** *"a .50 PWOPR is roughly a WR1 level PWOPR"* is a tier-threshold publication move — taking a continuous metric and quoting the integer-tier crossover so consumers can use it without the model. *Repeatable:* **for any continuous metric you publish, also publish the tier thresholds (WR1/WR2/WR3 cutoffs); consumers will use it more.**

**G. The "everybody eats" rebuttal.** Used for Buffalo Bills in the Mid-Season Report — "no Bill clears a .4 PWOPR; this is the first team-level *no-WR1* signal in the league." A team that fails to concentrate target share is a team where no individual receiver is rosterable for fantasy. *Repeatable:* **a flat PWOPR distribution at the team level is itself a fade signal — concentration is what makes individual receivers cash.**

---

*This section sourced from a logged-in Substack browser pull on 2026-04-28 covering: [2026 Post-Draft Rookie Rankings / Model](https://koalatystats.substack.com/p/2026-post-draft-rookie-rankings-model), [The Mid-Season PWOPR Report (11/5/2025)](https://koalatystats.substack.com/p/the-mid-season-pwopr-report-1152025), [2026 Potential Breakout Wide Receivers](https://koalatystats.substack.com/p/2026-potential-breakout-wide-receivers), [2026 Dynasty RBs College PRODUCTION SCORES](https://koalatystats.substack.com/p/2026-dynasty-rbs-college-production), [Week 17 Advanced Stats, Predictions, and Hidden Value](https://koalatystats.substack.com/p/week-17-advanced-stats-predictions), and [NFL Super Bowl 60: Advanced Stats](https://koalatystats.substack.com/p/nfl-super-bowl-60-advanced-stats). Patreon was blocked at the browser-MCP safety layer.*

---

## Subscriber comments and methodology Q&A (2026 cycle)

*Sourced from a logged-in Substack browser pull on 2026-04-28. Comment threads pulled from four 2026 prospect posts. Total captured: 53 comments (26 + 5 + 11 + 11). Generic "great post!" reactions excluded — only analytically-loaded exchanges below.*

### A. Post-Draft Rookie Rankings / Model — 26 comments
URL: https://koalatystats.substack.com/p/2026-post-draft-rookie-rankings-model

**Pre-draft vs. post-draft refit — career score stability (Owen ↔ Bryan).** Owen asked: "Does refitting the model post-draft instead of entering in DC pre-draft help with model accuracy? And how much can that affect individual metrics i.e. Malachi Fields' Career Score going from very poor to good from pre to post?" Bryan replied that **the interactions don't affect the career score** — Fields' jump was a data correction, not a refit artifact: *"There was an issue with Fields birthday in the pre-draft data that was making him much older than he should have been! Post-draft model resolved the issue."* Owen confirmed: *"Birthday tracking has been super wonky recently."* This is a methodology nuance not in the post body — the **career-score component is invariant to the post-draft DC interaction term**; large pre→post moves on career score are data-quality fixes, not modeling decisions. Implication: when reproducing the model, lock career-score upstream of the DC interaction.

**Bryan's own draft picks (Nick ↔ Bryan) — analyst-as-practitioner.** Asked who he took with his own first-rounders, Bryan disclosed: 1.08 Omar Cooper, 1.10 Denzel Boston, 1.11 Ty Simpson. *"I was not happy about taking Ty Simpson (Go Dawgs!) but had a good feeling about him going top 16 thanks to Mike Renner. Funny enough, I didn't even know Dan Orlovsky was high on Simpson until the NFL draft."* He also flagged regret over Michael Trigg at 2.11 and missing Stribling at 4.11 ("RIP me and lost value"). The Tuten-for-Stowers debate (Cobra striking baby) drew a strong methodological prior: Bryan would trade Tuten for Stowers in a tank scenario because *"Stowers just turned 23, is an elite receiving TE prospect... Stowers long term upside is better than Tuten's imo."* This validates the **age-adjusted long-term-upside framing** the model already encodes; Bryan is consistent in applying it to his own roster.

**Kingsley Suamataia / Tyson injury concern (Michael Marrujo ↔ Bryan) — most informative methodology nuance of the cycle.** Marrujo pushed back on the Bhayshul Tyson optimism: *"I know you said injuries aren't predictable, but does a pattern of injuries along with documented sub optimal movement patterns concern you. Tyson seems to make cuts that leave him more prone to injury."* Bryan's reply is the cycle's clearest **non-published prior**: *"Tbh, I am unsure enough data exists for us to know. I'd love to see historical data with an R² on sub optimal movement patterns, but I doubt such a thing exists. If future injuries were a legitimate concern, you'd think Tyson would have fallen more (see Jermod McCoy). The biggest information advantages the NFL has on the public are injuries and interviews."* Two methodology insights here that aren't in any post body: (1) **NFL-team draft slotting is treated as a partial information channel for injury risk** — a player who *didn't* fall is implicitly cleared by team doctors; (2) Bryan explicitly **ignores injury-pattern noise until predictive R² is demonstrated** — *"there might be signal SOMEWHERE, but until we have real sample sizes... I tend to try and ignore injury noise."* This is a hard prior, not a soft one.

**Joseph Bryan corrections / housekeeping.** Bryan posted two "table updated" comments: confirmed updated rookie sheet links would drop same day (*"Will get that out today!"* → *"Link in the post now!"*). Underground76's market-timing observation — *"the rookies will likely be ranked too high [in redraft] and I will skip them all"* — went unchallenged, suggesting Bryan agrees redraft markets overprice rookies in this class.

### B. RB Pre-Draft Model — 5 comments
URL: https://koalatystats.substack.com/p/2026-dynasty-running-back-pre-draft

Thinnest thread of the four. Notable exchange: Mike d asked *"Player comps!?!? Is that going to be a 'just for fun' sort of thing, or did you find a way to make it predictive or helpful?"* Bryan: *"for now, just for fun!"* — comps are explicitly **non-predictive flavor** in the RB model. Mike Rocks pushed back that comps are useful for film cross-check / roster-construction subjective layer. Ted Moke listed 2025 RB-with-path hits (Kaleb Johnson, RJ Harvey, Tuten, Monangai, Brashard Smith, Woody Marks, JCM, Jordan James); Bryan acknowledged he should publish 2025 results: *"I should have probably shared the 2025 results... When I get to my computer I will."* Open follow-through item.

### C. WR Pre-Draft Model — 11 comments
URL: https://koalatystats.substack.com/p/2026-dynasty-wide-receiver-pre-draft

**Eli Heidenreich modeling decision (Owen ↔ Bryan).** Owen asked whether Heidenreich (PFF FB-listed, positionless) would be modeled. Bryan initially considered TE-bucket via manual wrangling like the Travis Hunter case, then settled: *"Gonna actually put him with the RBs (just so you know lol)"*. **Positionless-prospect bucket assignment is a manual override, not algorithmic** — and the default for tweener bodies is RB, not TE.

**YPRR OE methodology question (Fusue ↔ Bryan).** Fusue: *"YPRR OE is based on defender coverage grade and SOS, but does it account for 'openness' as well?"* Bryan: *"Great question! YPRR does not include 'openness' but that could be a great thing to add in the future."* Confirms YPRR OE = coverage grade + SOS, **no separation/openness component**. Future-feature flag.

**Comps-as-prediction debunk (Mike d ↔ Bryan).** When Mike d asked for player comps for Tate — *"he just seems to be 'mid' at most things"* — Bryan delivered the most explicit anti-comp statement on file: *"Tough part is 'comps' do a truly awful job at predicting. For example, if you mathematically cluster similar college prospects and then use that to predict NFL success. It does a TERRIBLE job (I've tried extensively). I could def make mathematical comps but the reason I don't is that they are kinda misleading. True film buff comps might be more predictive but I doubt it."* This is **a direct methodology disclosure**: clustered college-prospect comps were tested and rejected.

### D. TE Pre-Draft Model — 11 comments
URL: https://koalatystats.substack.com/p/2026-dynasty-tight-end-pre-draft

**Carsen Ryan model output explained (Three ↔ Bryan).** Three asked why Ryan grades poorly. Bryan: *"The model does not love Carsen Ryan almost certainly due to the fact PFF big board and consensus mocks have him in the 300+ range (high % chance of going undrafted). That +++ the fact he has a pretty bad career score and is coming out as a RS Senior isn't helping him. He's a fun late round sleeper IRL imo."* Three corrected the class year: *"He is a true senior though, not a redshirt!"* Bryan: *"Ahh PFF has him listed as a RS Senior."* **Methodology nuance: PFF class-year tagging is the upstream source of age penalties — when PFF mislabels RS vs. true senior, the model inherits the bias.** Worth flagging when reproducing scores.

**Will Kacmarek correction (Three ↔ Bryan).** Three flagged Kacmarek (Ohio State TE) as missing from the data sheet. Bryan added a Kacmarek table same day: *"added a Kacmarek table! he didn't score super well (PFF hates him which drags him down hard)"* — confirms **PFF grade is a load-bearing input that can single-handedly suppress a TE score** even when other components are average.

**Stowers TEP-league framing (Michael Kramer ↔ Bryan).** Kramer: *"In a TEP league stock up. If Stowers gets a good landing spot he probably leaps Cooper and Concepcion."* Bryan: *"completely agree. A good landing spot where he can immediately compete for targets at WR or TE puts him firmly into the mid 1st imo."* Useful: Bryan explicitly **endorses a non-model overlay (TEP scoring + landing-spot conditional)** that pushes Stowers above his model rank in TEP formats. Kramer also volunteered a Cleveland/Monken 12-personnel fit thesis for Oscar Delp; Bryan engaged but didn't endorse the specific landing-spot bet. Kramer pointed to Max Toscano's writeup on Wright (Ole Miss) — peer-analyst pointer, not Bryan-disagreement.

### Cross-cutting takeaways (not in any post body)

1. **Career score is data-quality-sensitive but interaction-invariant** — pre→post moves on career score reflect upstream data fixes, not model refits.
2. **Injury concerns are explicitly de-weighted** until predictive R² exists; team-doctor-implied-by-draft-slot is the partial proxy.
3. **Mathematical comps were tested and rejected** as predictive; published comps are flavor only.
4. **PFF class-year and PFF grade are load-bearing inputs** — mislabels and single-source negative grades can dominate score outputs.
5. **YPRR OE = coverage grade + SOS, no openness/separation component** (future-work flag).
6. **Positionless tweeners default to RB bucket** unless manually re-bucketed (Heidenreich precedent).
7. **TEP-league overlay is endorsed informally** for receiving-TE prospects with good landing spots — not in the published model output but consistently applied in Bryan's reply guidance.

## Verification: Koziol UDFA anomaly

Verified 2026-04-28 against Koalaty's published Substack data (post-draft rankings post + linked Google Sheet `1_YGutjpyUGUIh8rcCBk-a2xYMt6s1LmMadRmGLNEvG8`, and the pre-draft TE sheet `1xR2zjnhwy1vjOGm8MqJ-6ScUhD-ncOFATIeMPSVSA2k`).

**Koziol post-draft score:** Model_Percentile = `0.76` (76th pct), Ensemble_Pred raw FPpG = `5.36`. The 75.6 figure in our local CSV is consistent with the 0.76 percentile (rounding/scaling artifact). Tier label per Bryan's writeup: **C Tier**, with the explicit caveat: *"As much as I want to put Koziol in B tier, I can't with that draft capital. I do think Koziol provides FAR better fantasy upside than Boerkircher, but its hard to see a world where he sees the field anytime soon. Deep league stash."* Bryan also adds in the model-results commentary: *"The model really believes in Koziol lol… his receiving profile is awesome I am unsure he will ever get the chance to show it."*

**Draft pick value:** Koziol went UNDRAFTED in the 2026 NFL draft. The post-draft sheet does not expose a draft-capital column for any TE — the only feature columns are size, athleticism, career production, YPRR OE, SOS, explosive score, beast YPRR, RVI, WAA, and athleticism percentile. There is no `draft_pick` or `draft_capital` field in the published TE output.

**Pre→post movement (Koziol):** Pre-draft Model_Percentile `0.77` / Raw `5.62` → Post-draft `0.76` / `5.36`. **Net move: −1 percentile point, −0.26 raw FPpG.** Effectively flat. For comparison, all top-5 2026 TEs barely moved post-draft: Stowers 0.97→0.96 (−0.31 raw), Joly 0.86→0.85 (−0.39), Sadiq 0.83→0.84 (+0.06), Klare 0.81→0.81 (−0.18). Even Trigg (UDFA, undrafted) is dropped from the post-draft sheet entirely while Koziol (also UDFA) is retained — suggesting inclusion is curatorial, not capital-gated.

**UDFA handling — methodology gap:** Koziol's −1pt drop is identical in magnitude to the noise on drafted TEs. There is no visible draft-capital penalty applied to him. Compare to other 2026 UDFA TEs in the same post-draft sheet: **Sam Roush** 0.58 (D Tier, "good draft capital" — Bryan misclassifies; Roush was 7th-round per public boards), **Matthew Hibner** 0.46. Roush's pre-draft score was not yet pulled, but his +0.96 athleticism percentile alone keeps him at 58th pct without capital pulldown. Bryan's writeup acknowledges the disconnect explicitly for Koziol — he hand-tiers him to C while the model output keeps him at 76th — meaning the *tier* is qualitatively penalized but the *score* is not.

**Is post-draft a true refit?** Bryan claims yes: *"i refit my entire model post draft. I don't just add a draft pick multiplier or something. So the way the entire model and all of the variables interact with each prospect is different post draft than pre draft."* He cites Tyson +5pts and Cooper +3pts as evidence of variable interaction, and notes Tate "didn't move" because his projected capital came true. **However, for the TE class specifically, the deltas are uniformly tiny (<1 percentile point on the high-end, with Koziol moving −1)** — consistent with either (a) a refit that happens to produce minimal TE-class movement because draft capital was already approximated pre-draft, or (b) draft-capital not being a meaningful TE-class feature. The published TE sheet does not contain a draft-capital column, supporting interpretation (b): **the post-draft TE refit appears to operate without an explicit draft-capital input feature, leaving UDFAs like Koziol effectively unpenalized at the model layer.** Bryan handles the gap manually via tier assignment in the writeup, not via the model. This is a methodology gap for our consumption: any downstream system ingesting Koalaty's 76 for Koziol will overrate UDFA TEs unless we apply our own draft-capital floor.

---

## Marvin Elequin + Peter Howard methodology

Two more analysts JJ Zachariason has publicly endorsed for their analytical process — both come from the "draft capital plus production with a historical-comp prior" school, but they differ meaningfully from JJ/Bryan/Winks/Kerrane in *how* they translate that into rankings. Captured here so the meta-model can reason about each input's distinct signal.

### Marvin Elequin (@FF_MarvinE) — Fantasy Footballers, Yahoo, Dynasty Nerds

**Core framework: "Range of Outcomes" historical-comp engine.** Elequin runs a separate position model (RB / WR / TE / QB) trained on drafted prospects since 2013. The four anchor inputs are: (1) **draft capital** — flagged as the single most predictive feature; (2) **career production**, controlled within draft-capital bucket; (3) **position-specific production rate** — Receiving Yards per Team Pass Attempt for WRs, Scrimmage Yards per Team Play for RBs, Receiving Yards per Team Pass Attempt for TEs; (4) **early-declare flag** — non-early-declares and 5th-year seniors get heavy fades because hit rates collapse to the 8–16% range. Players are then placed on a 0–99 percentile band tied to their model score, and historical comps are surfaced from the same draft-capital × production cell (e.g., Hampton "100% hit rate" group: Gurley, McCaffrey, Barkley, Elliott).

**Train/test discipline.** This is the part JJ has explicitly called out. Elequin builds his model on a fixed historical window (drafted prospects 2013→prior season), then holds out the current rookie class and reports out-of-sample hit-rate priors at each draft-capital × production bucket — *e.g.*, "Day-2 RBs with positive experience-adjusted production hit at 75%; Day-3 RBs hit at 13.6%." Those priors are publicly cited in every Range of Outcomes piece, which means the model is auditable: you can backtest the priors he posts against the realized cohort. JJ's endorsement is specifically about that auditability — Elequin doesn't bury the calibration.

**What he weights heavier than consensus:** early-career production share (true-freshman / sophomore breakouts), draft capital × production interaction (he genuinely refuses to take a Day-3 prospect over a mediocre Day-2 prospect even when the Day-3 college profile is better), and *experience-adjusted* production — i.e., a 5th-year senior with 30% dominator gets penalized vs. a true junior with 25%.

**What he weights lighter than consensus:** athleticism / RAS (he uses it as a tiebreaker, not an input), film/scouting noise, post-NFL-draft narrative shifts. His pre-draft model output for Darius Taylor 2026 ("most productive true freshman season since 2013") was effectively unchanged when Taylor returned to school — he doesn't react to news, he updates the cohort window.

**How he differs from JJ/Bryan/Winks/Kerrane.**
- **vs. JJ Zachariason (Late-Round):** JJ leans on draft capital + age + ADP-discount more than production share; Elequin leans on production share within draft-capital bucket. They agree at the top of every class but diverge in tiers 3–5, where Elequin will rank a positive-production Day-2 RB above a Day-1-capital RB with a weak production profile (Trey Benson > Blake Corum was the 2024 disagreement).
- **vs. Bryan (Koalaty Stats):** Bryan's Ensemble_Pred is a feature-engineered raw-FPpG projection; Elequin's output is a percentile band tied to historical hit-rate. Bryan publishes a single number; Elequin publishes a *range* with explicit comps. Bryan is more bullish on athletic outliers (PFF grades, athleticism percentile); Elequin is more bullish on early-career market share.
- **vs. Winks (Underdog):** Winks ranks for 1QB with a draft-capital-dominated linear model; Elequin's adds the experience-adjusted production layer that explicitly fades older/transfer prospects. Winks 2025 had Skattebo and Ayomanor higher than Elequin (Elequin's age fade hits both).
- **vs. Kerrane (Legendary Upside):** Kerrane's tiers are narrative-first ("Day 1 Starter," "Boom/Bust," "Premium Dart Throw"); Elequin's tiers are percentile-first. Kerrane will tier up an "author favorite" (Jaylin Noel, Troy Franklin); Elequin won't move a player off his model output without a corresponding cohort-level reason.

### Peter Howard (@pahowdy / "Pahowdy") — Dynasty League Football, Patreon, Twitch

**Core framework: age curve + breakout-age + WhipperSnapper.** Howard's signature metric is **WhipperSnapper** — production accumulated *before age 20*, expressed as a mini-college-dominator. His finding (publicly documented since 2018): the difference between full-career College Dominator and WhipperSnapper ("Whipper Diff") is a stronger predictor of NFL breakout than draft capital, athleticism, or measurables, *for skill positions*. Players who did most of their damage young get tiered up; players who broke out late at age 21–22 get tiered down even with strong final-season production. This is the methodological prior that distinguishes Howard from every other analyst on this list.

**Secondary inputs:** breakout age (the season a player owns ≥20% of team rec yards + TDs), draft capital (used but not dominant), and a separate adjustment for position-of-production (slot vs. X, primary vs. tertiary back). Howard maintains his own historical prospect database (publicly: 2003–2021, expanded since on Patreon) which serves as the comp pool.

**Train/test discipline.** Howard publishes the year-over-year hit/miss audit on his Patreon and Twitch streams — he posts comps from his database showing which historical players each current prospect resembles by Whipper Diff bucket, then tracks the realized NFL outcome of each comp group. The "test set" is implicitly every season's prior cohort scored against his pre-draft rankings. Less publicly automated than Elequin's percentile output, but the WhipperSnapper paper itself was a backtest, and he has continued to publish year-over-year accuracy posts.

**Critical caveat: Howard's actual numerical rankings are paywalled.** They live behind DLF Premium (subscription) and his Patreon ($5+ tier). The CSVs in this repo (`howard_2024.csv`, `howard_2025.csv`, `howard_2026.csv`) use directional consensus + Howard's *known methodological priors* to approximate where he sits — flagged in the `notes` column with `PAYWALL: directional only`. We do not have his exact rank-ordered list. Players whose profile maps cleanly to his methodology (early breakout = lean above consensus; late breakout / older = lean below) are marked with explicit lean flags. Treat Howard CSV scores as **±10 noise** vs. his actual published numbers.

**What he weights heavier than consensus:** WhipperSnapper (early breakout), breakout age, true-freshman/sophomore production market share, dominator-rating trajectory. His pinned-tweet examples year over year always include young early-breakout WRs the consensus underrates (Burden, Egbuka, Tyson, Lemon).

**What he weights lighter than consensus:** late-breakout production (5th-year seniors, transfer-portal final-year explosions), pure athleticism without production support, draft-capital "reaches" (he was famously low on Worthy's KC fit pre-draft despite the capital, and famously high on Bucky Irving despite the Day-3 capital).

**How he differs from JJ/Bryan/Winks/Kerrane/Elequin.**
- **vs. Elequin:** Both use draft-capital × production as a backbone, but Howard's WhipperSnapper layer fades older breakouts that Elequin's experience-adjustment also fades — *but* Howard's penalty is steeper. Howard would rank a Day-3 early-breakout RB (like Bucky 2024 vintage) above a Day-2 late-breakout RB with the same college dominator; Elequin's draft-capital weight typically wins that tie for the Day-2 player.
- **vs. JJ:** JJ uses age as a tiebreaker; Howard uses age (via WhipperSnapper) as a primary input. JJ on the Late-Round podcast has cited Howard's framework approvingly while noting it sometimes overweights early-career production for receivers in NFL systems they won't replicate.
- **vs. Bryan:** Bryan's model is feature-rich but doesn't expose a WhipperSnapper-equivalent — Koalaty's `career production` input is full-college, not split by pre/post-20. This is why Howard and Bryan often disagree on transfer-portal late-breakout WRs (Bryan's model rewards the final-year explosion; Howard fades it).
- **vs. Winks:** Winks does not publish an age-curve adjustment; Howard's age curve is the entire thesis. Expect divergence on any prospect with breakout-age >21.
- **vs. Kerrane:** Kerrane's tiers are landing-spot and narrative-driven; Howard's are college-process-driven. They tend to agree on Tier 1 elite prospects and diverge on Tier 3–5 specifically because Howard's age fade kills off prospects Kerrane tiers up for "Day 1 Starter" landing-spot reasons.

### Implication for the meta-model blend

If the existing blend already weights JJ, Koalaty, Winks, and Kerrane, adding Elequin gives the blend a stronger *historical-cohort hit-rate* prior (cleaner backtest discipline than any current input). Adding Howard gives the blend a *breakout-age / WhipperSnapper* prior the current inputs don't capture — but only directionally, because his published rankings are paywalled. Practical recommendation: blend Elequin at full weight (his model output is publicly auditable per article), and blend Howard at half weight (or as a directional override for early-breakout vs. late-breakout disagreements only) until we ingest his Patreon-tier rankings or build our own WhipperSnapper feature. The data-quality flag `PAYWALL: directional only` in `howard_*.csv` should propagate as a confidence-discount in the meta-model weighting.

