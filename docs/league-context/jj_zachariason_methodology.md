# JJ Zachariason — Analytical Methodology Memo

*Compiled 2026-04-28 for the UPS MFL rookie hit-rate / extension-worthiness project. Focuses on methodology, not 2026 player takes. Sources at the bottom; quotes lifted from public Twitter/podcast appearances.*

JJ Zachariason (@LateRoundQB) is the host of *The Late-Round Fantasy Football Podcast* and the proprietor of Late-Round Fantasy Football (lateround.com), which he launched in January 2022 after a long run as Editor-in-Chief at FanDuel/numberFire. He popularized the "Late-Round QB" strategy in 2012 and has spent 13+ years building data-first prospect models. He is unusually transparent about *what he weights* and *why*, even if the exact coefficients live behind the $19.99 Prospect Guide paywall.

---

## Core Principles

- **Draft capital is the baseline, not just an input.** JJ's strongest repeated claim: NFL draft capital is the single most predictive variable for fantasy success, especially at RB. His ZAP Model is explicitly framed as *"telling you when you should deviate from draft capital,"* meaning capital is the prior and the model only earns its keep when it argues against the market.
- **Process > outcome, range > point estimate.** He talks about projections as distributions, not numbers, and consistently chooses upside (variance) over floor in formats that reward ceiling. He has a whole "Why I Choose Upside Over Safety" framework on YouTube.
- **Market share over raw production.** College box-score stats are noise without context — different offenses, paces, schedules. He converts everything to share-of-team metrics (target share, dominator rating, yards share) before comparing players.
- **Age is a feature, not a footnote.** Production at 19 means something fundamentally different than the same production at 22. Breakout age and age-adjusted dominator are non-negotiable inputs.
- **Comp-based reasoning beats narrative.** His models output statistical comparables (current prospect → historical players with similar profiles), and he reasons forward from base rates of those comps rather than scouting adjectives.

---

## Rookie Evaluation Toolkit

JJ's public model inputs cluster into four buckets. He weights them differently by position, but all four show up.

| Bucket | What he uses | Threshold heuristics |
|---|---|---|
| **Draft capital** | NFL draft pick number; Day 1 vs Day 2 vs Day 3 binary | Day 1 (R1) is its own tier for RBs especially. Day-3 RBs almost never hit. |
| **College production share** | Dominator rating (% of team yards + TDs), target share (WR), yards-from-scrimmage share (RB), YPRR for WRs | **Breakout age ≤ 19** = excellent; ≤ 20 is the cutoff he uses for "young breakout." Dominator ≥ 20% is the breakout threshold. |
| **Athletic profile** | Height-Adjusted Speed Score (RB/TE), 40 time, weight-adjusted explosion (broad/vert) | Athleticism gates the upside but doesn't create it. For TEs his recent model finds athleticism interacts *non-linearly* with capital — i.e., he prefers a TE drafted *in spite of* athleticism over one drafted because of it (with R2 capital). |
| **Final composite (ZAP)** | Z-score Adjusted Prospect Model — RB/WR/TE versions; outputs 0–100 | Score >99 is generational (Gurley, Saquon, Gibbs, CMC; Jeanty projected 99.2). |

**Things he explicitly de-weights:** combine bench press, hand size, college team strength of schedule (he prefers share-based metrics that already normalize for it), film-based "vibes" without statistical backing.

**Year-2 / Sophomore Model:** He has a separate "Year 2 Model" for RB and WR that re-projects players using rookie-year NFL usage signals (route share, snap share, target share, RZ touches) plus the original ZAP score. The point: don't overreact to rookie-year fantasy points — overreact to *opportunity*.

---

## Position-Specific Strategy

**Running Back.** Draft-capital-first more aggressively than any other position. Day-3 RBs are a near-zero hit rate cohort. He's a documented "RB Dead Zone" believer: research he frequently cites shows ~4.4% league-winner rate from RBs taken in redraft rounds 4–5 vs ~11.1% for WRs in the same range. Translation for dynasty: pay up for elite RBs at the top of rookie drafts (1.01–1.04 range when warranted), then *avoid* the middle of rookie Round 1 RB grabs unless ZAP loves them.

**Wide Receiver.** This is where his model has the most edge over consensus. Breakout age + final-season dominator + draft capital + early declared (junior) is the four-factor sweet spot. He's more willing to take a Day-2 WR with elite age-adjusted production than a Day-2 RB with the same capital — because the WR hit-rate base rate is higher.

**Tight End.** Treats TE as a near-binary: R1/early-R2 capital + a real college receiving profile (not a converted blocker), or pass. His newer TE model finds a counterintuitive result that *less* athletic TEs with strong capital outperform combine freaks with the same capital — likely because teams only draft "unathletic" TEs early when the receiving production is undeniable.

**Quarterback (Late-Round QB).** The thesis he's been refining for 14 years: rushing equity is the multiplier. He explicitly says **the rushing upside of early-drafted QBs is overstated** while later-round QBs with mobility offer the same ceiling at a fraction of the cost. In superflex/TEP this softens — you still need two starters — but the underlying "rushing yards predict fantasy ceiling more than passing yards" finding holds.

---

## Extension / Trade Decisions

JJ does not publish a closed-form "extend or trade" matrix, but his repeated dynasty heuristics imply one:

1. **RB age cliff at ~27.** Sell window opens around age 26 for productive starters; do not pay for the second contract on RBs unless the role is locked and the cap implication is small. Move them while the buyer still believes the prime year is ahead.
2. **WR peak window 25–27, slow decline through 29.** Elite WRs are extendable through age 28–29 because the decline curve is gentle. He explicitly pushes back on "WRs fall off at 30" as overstated by the dynasty market — which means *buy* aging WRs at a discount, *don't* panic-sell.
3. **TE hold window is the longest.** Once a TE breaks out and locks the role, he treats them as multi-year holds.
4. **Process check on every extension:** Would I draft this player at this asset cost in a startup *today*? If no, don't extend.

---

## Hit Rate Definitions

JJ doesn't use one universal "hit" definition — he tunes it by position and format. The recurring shapes:

- **Top-12 / top-24 finish at position** within first 3 NFL seasons (the implicit ZAP target window).
- **"League winner" rate** — being a top-3 finisher at position in a given season — for redraft hit-rate work; this is the metric behind the 4.4% vs 11.1% RB/WR Round 4–5 finding.
- He **stratifies cohorts by NFL draft round**, not by ADP, because draft capital is his prior. So "R1 RB hit rate" is a real number to him; "RB1 in dynasty rookie drafts hit rate" is a downstream consequence.

---

## Quotables

> *"The easiest way to describe the ZAP Model is that it tells you when you should deviate from draft capital when making fantasy football decisions. Because that capital is the baseline."* — [@LateRoundQB, Feb 2025](https://x.com/LateRoundQB/status/1891583202810118235)

> *"There are only four players in the running back ZAP Model with a score above 99: Todd Gurley, Saquon Barkley, Jahmyr Gibbs, Christian McCaffrey. Ashton Jeanty's current projected score: 99.2."* — [@LateRoundQB, Feb 2025](https://x.com/LateRoundQB/status/1894417297869058133) *(use case: he's willing to publicly tier prospects against historical hits, not against same-class peers.)*

> *"Conditional upon early round 2 draft capital, we should prefer a [tight end] who is drafted in spite of their athleticism rather than because of it."* — JJ's 2025 TE model writeup, paraphrased in podcast appearances

> *"The rushing upside of early-drafted quarterbacks is overstated."* — Late-Round QB thesis, restated on the [Fantasy Points Pod, 2025](https://www.fantasypoints.com/media/podcasts/episode/elite-vs-late-round-qbs-who-actually-wins-in-2025-w-jj-zachariason)

> *"My rookie model examines how fantasy football studs performed in college, then looks at the current group … to see if any of them performed similarly."* — methodology summary across multiple podcast intros

---

## Sources

- [Late-Round Fantasy Football homepage](https://lateround.com/)
- [@LateRoundQB on X (formerly Twitter)](https://x.com/lateroundqb)
- [JJ Zachariason on His ZAP Model and Running Back Prospects — NFL Fantasy Football Podcast](https://www.iheart.com/podcast/1157-nfl-fantasy-football-podc-29699073/episode/jj-zachariason-on-his-zap-model-272251766/)
- [ZAP Model deviation-from-capital tweet (Feb 17, 2025)](https://x.com/LateRoundQB/status/1891583202810118235)
- [ZAP Model RB top-4 + Jeanty tweet (Feb 24, 2025)](https://x.com/LateRoundQB/status/1894417297869058133)
- [Elite vs. Late-Round QBs — Fantasy Points Podcast w/ JJ Zachariason](https://www.fantasypoints.com/media/podcasts/episode/elite-vs-late-round-qbs-who-actually-wins-in-2025-w-jj-zachariason)
- [Year 2-3 Breakout Candidates with JJ Zachariason — Footballguys](https://www.footballguys.com/podcast/year-2-3-breakout-candidates-with-jj-zachariason-fantasy-football-2025)
- [Late-Round Draft Guide on Matt Waldman's RSP Cast](https://mattwaldmanrsp.com/2024/07/12/jj-zacahariason-and-the-late-round-draft-guide-on-matt-waldmans-rsp-cast/)
- [Why JJ Zachariason Chooses Upside Over Safety (YouTube)](https://www.youtube.com/watch?v=-KPLg5swf-Y)
- [RB Tiers for 2025: Diamonds or Dead Zone w/ JJ Zachariason (YouTube)](https://www.youtube.com/watch?v=mGhu9w7mnV4)
- [Modeling the 2025 Rookie Class w/ JJ Zachariason (YouTube)](https://www.youtube.com/watch?v=gmsv4eULc7o)
- [JJ Zachariason articles archive — Muck Rack](https://muckrack.com/jj-zachariason/articles)
- Background context on dominator/breakout-age conventions: [Analytics of Dynasty: WR Breakout Age Matrix](https://analyticsofdynasty.com/2021/04/12/widereceiverbreakoutagematrix/), [PFF on dominator/PFF grade for WR breakouts](https://www.pff.com/news/fantasy-football-predicting-breakout-rookie-wide-receivers-using-pff-grades-and-dominator-rating)

---

*Caveat: JJ's actual ZAP coefficients, the exact rookie-model weightings, and his Year-2 model logic live in his paid Prospect Guide and Patreon. The framework above is reconstructed from his public podcast statements, tweets, and interviews — directionally correct but not the file you'd buy from him for $19.99.*

---

## Deep dive: analytical reasoning patterns

This section catalogs the *moves* JJ makes — not the takes. The aim is to surface the small, transferable maneuvers that distinguish his analysis from the pundit baseline. Each example is sourced from public podcast appearances, newsletters, or X threads.

### 1. Reframings — re-asking the question

**"Don't ask if a prospect is good. Ask if the market is mispricing them relative to NFL capital."** This is the load-bearing reframe behind the entire ZAP Model. JJ's [Feb 2025 description](https://x.com/LateRoundQB/status/1891583202810118235) — "ZAP tells you when you should deviate from draft capital" — is a Bayesian frame: capital is the prior, and the model is only doing useful work when it disagrees with the prior. The repeatable lesson: *don't build models that re-derive the consensus; build models that quantify when to override it.* Most prospect models implicitly fight the market; JJ's explicitly anchors to it and earns its keep on the deltas.

**"Don't ask if a QB is good. Ask if he can score fantasy points without having to be good."** The Late-Round QB thesis is fundamentally a reframe of "QB value" from passing efficiency to total fantasy production, with rushing as the variance-inflating component that breaks the link between "good QB" and "fantasy QB1." On the [Fantasy Points pod](https://www.fantasypoints.com/media/podcasts/episode/elite-vs-late-round-qbs-who-actually-wins-in-2025-w-jj-zachariason), JJ has refined this to: *the bar for a fantasy QB1 isn't "play well" — it's "rush for 400+ yards or play in a top-5 passing offense."* The reframe lets him short-circuit endless QB-talent debates: rushing yards are sticky, passing TDs aren't, so rushing equity is the dominant signal.

**"Don't ask 'is the dominator high?' Ask 'is it high *for this player's age*?'"** JJ converts production from a level metric into a residual against an age curve. A 30% dominator at age 19 lives in a different distribution than a 30% dominator at age 22, because the older breakout has a thinner population of remaining future-NFL talent above them. Repeatable move: *whenever a metric correlates with age, model the age effect explicitly and reason about residuals, not levels.*

### 2. Metric selection trade-offs

**Full-season totals beat per-game rates for college production.** Multiple analysts (e.g. [Jakob Sanderson](https://jakobsanderson.substack.com/p/analyzing-the-2025-running-back-class)) note that JJ's ZAP uses full-season production rather than per-game, despite per-game being "fairer." His reasoning: durability and workload are part of the signal you want to capture. A back who racked up 1,800 yards on 280 touches is a different prospect than one who got 1,200 on 180 touches at the same per-game rate, because NFL teams price *how much you can carry*. The lesson: pick the denominator that matches the question. If the question is "can this guy be a workhorse," per-game is the wrong denominator.

**Dropped rushing metrics from the RB ZAP entirely.** JJ has publicly stated the running back ZAP no longer contains rushing-specific inputs — instead it weights *total scrimmage production share* and pass-catching usage. The reasoning: rushing efficiency at the college level is heavily contaminated by OL quality, scheme, and box counts, while receiving production is a cleaner signal of skill the NFL values. Repeatable: *if a metric's signal is dominated by environmental noise rather than the player, drop it even if it's the headline stat at the position.*

**Athleticism as a gate, not a generator.** For RBs and WRs, JJ treats athletic testing as a knockout filter (below a threshold = downgrade) rather than a continuous predictor. For TEs, his updated 2025 model goes further: *conditional on R2 capital, less-athletic TEs outperform combine freaks* — because teams only spend R2 capital on a non-athlete if his receiving production is undeniable. This is a textbook conditional inference: the same testing number means opposite things at different capital levels because of the selection process that produced the draft pick.

**Touchdowns regress; opportunity sticks.** From the [Ringer 2019 piece](https://www.theringer.com/nfl-preview/2019/8/15/20806716/fantasy-football-sticky-stats): *"Anything touchdown related, you can generally look at it and say, this is going to regress."* The repeatable move is splitting every box-score stat into a stable component (volume, route share, snap share, target share, carries) and an unstable component (TDs, YPC, yards per target). Project off the stable parts; treat the unstable parts as variance.

### 3. Specific heuristics — "if X then Y" rules

- **Day-3 RB = near-zero hit rate.** Don't take Day-3 RBs in rookie drafts as anything but a dart throw. The cohort has a hit-rate floor that no individual scouting profile can overcome at scale.
- **TE binary: R1 / early-R2 + receiving profile, or pass.** No middle ground. A college blocker drafted Day 2 is a blocker; he is not a fantasy TE waiting to emerge.
- **ZAP > 99 = generational tier.** Used as a tripwire: if a prospect crosses 99, JJ is willing to publicly compare him to historical hits (Gurley, CMC, Saquon, Gibbs).
- **Rushing equity is the QB multiplier.** A QB rushing 400+ yards has a fantasy ceiling no pure pocket passer can replicate at the same ADP.
- **"Would I redraft this player at this asset cost today?"** The extension/hold gut-check.
- **Process check on regression candidates: did volume change or did efficiency change?** If volume held and efficiency cratered, buy. If volume dropped, the efficiency may be path-dependent on a role that's gone — sell.
- **"Draft capital delta"** (from his June 2024 newsletter): rank rookies by the gap between *NFL draft capital* and *consensus rookie-draft ADP*. The largest positive deltas (NFL bet harder than the dynasty market) are the systematically mispriced longs.

### 4. Pushback against consensus

**The "elite QB tier" critique.** JJ's most-repeated contrarian claim, refined since 2012: drafting a top-3 QB at ADP is paying full price for variance you can replicate cheaper. His diagnostic: *show me the ADP-vs-finish slope for QB1s — the early-round QBs don't beat the late-round mobile QBs by enough to justify the cost.* He concedes the era of unicorns (Allen, Hurts, Daniels) has narrowed the edge but argues the *underlying logic is unchanged*; the mobile QB at QB10 ADP is still mathematically equivalent to the QB3, and you can prove it by looking at FP/DB rather than total points.

**The "RB Dead Zone."** JJ helped popularize the finding that RBs taken in redraft rounds 4–5 have a ~4.4% league-winner rate vs ~11.1% for WRs in the same range. The diagnostic: the cohort is constructed by ADP, which is itself a function of perceived role security; the RBs in this range are systematically the "old workhorse with declining role" or "young committee back with no clear path" — both of which have lower variance ceilings than WRs at the same ADP, who are more often the "young breakout candidate with target share upside."

**Pushback on age-30-WR-cliff narrative.** JJ has repeatedly argued the dynasty market overdiscounts WRs entering age 28–30, citing actually-observed decline curves that are gentler than the market prices. The buy-side implication is concrete: *fade the dynasty consensus on aging elite WRs.*

### 5. Process-vs-outcome reasoning

**Defending Travis Etienne post-injury.** When Etienne tore his Lisfranc as a rookie and the dynasty market panic-sold, JJ argued the *process* (R1 capital + elite college dominator + receiving usage profile) was unchanged — only one outcome data point had been added (an injury, which is high-variance noise relative to the 4 years of college signal). He held. Etienne's Y2-Y3 production validated the frame. Repeatable lesson: *one bad outcome shouldn't update your prior more than one bad outcome's worth of information* — and an injury is closer to weather than to skill evidence.

**Attacking "right outcome wrong process" hits.** JJ is consistent in calling out late-round RB hits (Phillip Lindsay, Boston Scott, James Robinson early years) as outcome-driven without process backing. The discipline: *if a hit happened in a cohort with a 5% base rate, your model wasn't wrong for missing it; pricing the cohort at 50% next year because of it is the actual error.* He refuses to let outcomes retroactively validate processes.

### 6. Comp-based reasoning

**Statistical comps from feature-vector distance, not narrative similarity.** JJ's prospect comps are not "this guy reminds me of X." They're built by computing each prospect's vector across model inputs (age-adjusted dominator, breakout age, athletic score, draft capital) and finding nearest historical neighbors in that feature space. The comps then carry forward base rates: *this prospect's 5 nearest neighbors hit 40% of the time, here's the distribution of outcomes.* Repeatable: *when comping, decide your feature set first, then find neighbors — don't let visual similarity drive feature selection.*

**The "Jeanty hits 99.2" frame.** Rather than ranking Jeanty against his 2025 class peers (which has only 30 data points), JJ ranks him against the *all-time historical RB ZAP distribution*. This re-baselines the comparison: a 99 in 2025 means the same thing as a 99 in 2015. Repeatable: *if your sample is small, expand to the historical distribution rather than overclocking within the noisy current cohort.*

### 7. Calibration and post-mortems

JJ's calibration discipline is implicit rather than published — he doesn't release a formal scorecard — but two patterns recur. First, when a prospect his model loved misses (e.g. several Day-2 WRs from the 2020 class), he traces the miss to a specific input (often landing-spot variance the model can't see) rather than to model failure broadly. Second, when his model whiffs on a hit (a "miss-low") more than a miss (a "miss-high"), he treats that asymmetry as evidence the model is *correctly calibrated to ignore the long tail*, since long-tail hits are noise the model shouldn't try to predict. This is a defensible position but it's also un-falsifiable, which is itself a methodological gap (see below).

### 8. Methodological self-critiques

JJ has publicly acknowledged: (a) the model can't see landing spot until after the NFL draft, so pre-draft rankings are deliberately "naive" and require post-draft revision; (b) TE sample sizes are too small to support stable coefficients, which is why his TE model is closer to a heuristic than a regression; (c) Year-2 reprojection inputs (route share, RZ touches) are heavily path-dependent on rookie-year coaching choices the model can't predict.

### 9. The Year-2 / Year-3 model logic

For RBs and WRs, the Year-2 model takes the *original ZAP score* and updates it with *NFL opportunity signals* observed in the rookie season: route participation, snap share, target share, RZ touches, and aDOT (for WRs). The implication for second-contract reasoning: *don't reprice the player on rookie-year fantasy points* — reprice on rookie-year *opportunity*. A WR who ran 75% of routes but caught 35 balls is a different bet than a WR who ran 40% of routes but caught 60 balls; the first has the role for a Y2 leap, the second was getting fed in a small role that may not scale. Repeatable: *separate the role grant from the role conversion when projecting Y2; the role grant is the leading indicator.*

### 10. Triangulation against peers

JJ vs **Hayden Winks** (Underdog): Winks weights athletic testing (RAS) more heavily; JJ has dropped most testing inputs except as gates. The disagreement surfaces most on borderline RB/WR athletes where Winks's "freaky athlete" tag elevates them and JJ's "weak production share" tag downgrades. JJ's position: *combine numbers without college production are noise.*

JJ vs **Pat Kerrane** (Establish The Run / Legendary Upside): Kerrane is more film-and-scheme-fit-driven; JJ is more model-output-driven. Their public 2026 WR1 disagreement (referenced on the Legendary Upside pod) is a clean example — JJ's model loved a different player than Kerrane's eye on tape did.

JJ vs **Rich Hribar** (Sharp Football): Hribar lives at the redraft / weekly DFS layer; JJ at the dynasty / prospect layer. Their methodologies barely overlap, but where they do — usage stickiness, TD regression — they almost completely agree. That convergence on the high-confidence claims is itself signal.

JJ vs **Establish The Run** (Adam Levitan / Evan Silva): ETR weights draft capital similarly heavily but combines it with a more aggressive landing-spot adjustment post-draft. JJ is more conservative on the post-draft landing-spot revision because he believes Year-1 coaching/scheme assignments are themselves noisy.

---

## Methodological gaps in his framework

These are *statistical* gaps — limitations in JJ's analytical approach independent of any specific league format.

**1. Selection effect in the "Day-3 RBs almost never hit" claim.** Day-3 RBs are a self-selected cohort: a player who is both (a) talented enough to be drafted and (b) un-talented enough to fall to Day 3 is, by construction, near the median of NFL evaluation. The capital and the production share are both noisy proxies for the *same* underlying scout judgment, so the model is partly double-counting one signal. The hit rate isn't "low because Day-3 RBs are bad"; it's low because the cohort is constructed by NFL teams already having priced in everything JJ's model can see. Implication: *the model's edge over capital is smaller than it looks because the residual variance is mostly true noise.*

**2. Survivor bias in NFL historical comps.** ZAP comps are built from *players who reached the NFL.* Every player in the comp pool is already past one massive selection screen (drafted at all). When you compare a current prospect to "his historical comps," the base rate of those comps is conditional on having been drafted with similar capital — which means the implied "if X then 40% hit rate" is "40% of prospects who had this profile *and* reached the NFL with this capital." That's not a population base rate; it's a conditional on a screen the current prospect has not yet passed. The model's outputs subtly flatter the prospect because losers got filtered out of the comp pool.

**3. Multiple testing / out-of-sample validation is opaque.** JJ has tried many model specs (he's said the RB ZAP no longer has rushing inputs — implying iteration). With ~10 years of NFL data per position and ~30 prospects per class, the effective sample for fitting and validating is small. A model that has been re-fit as new data arrived risks p-hacking even unintentionally. Without a held-out test set published with the model, we can't distinguish "the model captured a real signal" from "the model is overfit to the training years 2012–2022 and will degrade on 2023–2027."

**4. Era effects on inputs.** NFL game environment has shifted: passing rate is up, RB workshares are down, RPOs have changed pass-catcher role definitions (his own newsletter notes this). A dominator threshold that meant something in 2015 means something different in 2025. JJ does not (publicly) era-adjust his college-production thresholds, even though the optimal threshold drifts with the college game's own evolution (spread offenses, transfer portal moving older breakouts down to younger schools, NIL keeping seniors longer).

**5. Additive model in a multiplicative world.** JJ treats inputs as approximately additive (capital + age + production share + athleticism → ZAP score). But interactions matter: an elite athlete with poor production isn't half-good and half-bad; he's mostly just bad (the production should have been there if the athleticism was real). His TE model finally captures one such interaction (capital × athleticism), but the WR/RB models likely understate interaction effects more broadly. Repeatable lesson for any modeler: *if the same metric means opposite things at different levels of another metric, you need an interaction term, not a coefficient.*

**6. No published confidence intervals.** ZAP outputs a 0–100 number. There is no published uncertainty band. A 92 vs 88 might be statistically indistinguishable given sample size, but the model presents them as ordinally meaningful. This forces consumers (including JJ) to reason with false precision. The fix is straightforward in principle (bootstrap the historical fit, report ±X) and conspicuously absent in practice.

**7. Inconsistent hit-rate definitions across content.** JJ uses "top-12 in first 3 NFL years" in dynasty contexts and "top-3 redraft finish" (league-winner rate) in redraft contexts, sometimes within the same episode. The numbers don't reconcile: a 25% top-12 hit rate and a 5% league-winner rate are the same model performing on two different definitions, but they sound like different model qualities to a casual listener. A unified framework — say, "P(top-12 in any of first 3 years) and P(top-3 in any of first 3 years), both reported" — would be more honest about what the model actually predicts.

**8. Path dependence on Year-1 coaching/scheme luck.** The Year-2 model takes rookie-year route share / target share as inputs. But these are themselves outcomes of decisions (a rookie HC, a midseason OC change, an injury to a teammate ahead of the player on the depth chart). The model has no way to back out "what would route share have been under league-average usage decisions." When a coach gets fired in Y2 and the new staff redefines the role, the Y2 input is suddenly stale and the model has no error bar reflecting that risk.

**9. The "I held the prospect through bad outcomes" frame is un-falsifiable.** JJ's process-over-outcome discipline is good practice, but in its strongest form it makes the model unaccountable: every hit confirms the process, every miss is "outcome variance." Without a pre-registered list of which prospects he's high on at what confidence, retrospective grading is post-hoc rationalization. A useful discipline would be publishing each year's predicted hit-rate distribution and grading the realized distribution against it — Brier-score style — rather than narrating individual cases.

**10. The model does not engage with second-contract performance at all.** JJ's framework is rookie-evaluation + rookie-year-update. By Year 3, the model has nothing to say. But Year 3 onward is where dynasty league value mostly lives. Quantitative reasoning about age curves, decline rates by position, and re-projection from veteran usage signals (target share at age 27 vs 30, carries-per-game decay rates) is conspicuously missing from the public framework. He gestures at "RB cliff at 27" and "WR peak 25–27" but these are folk wisdom, not modeled.

**11. (In-season) The QB framework's two thresholds (FP/DB ≥ 0.55, rush yards ≥ 20/game) are conjunction-tested but never published with their joint base rate.** A QB who clears both gates is rare; one who clears one but not the other is the actually interesting case for executable decisions, and the historical conditional-finish distribution (P(top-6 finish | clears one gate but not the other)) is not available. Without the joint table, the framework reduces to two solo filters that can disagree. The fix is straightforward (publish the 2x2) and absent.

**12. (In-season) Route-share-as-leading-indicator implicitly assumes target conversion is stable across coaches.** Route share is sticky week-to-week within a regime, but route-share *to target-share conversion* is not — a coach who throws to RBs at 25% will convert WR routes to targets at a different rate than a coach who throws to RBs at 12%. JJ's in-season buy calls based on "route share is high, targets will follow" silently assume a league-average conversion rate that doesn't apply uniformly. The miss case: a WR running 80% of routes in a CMC-style RB-targeting offense is not a buy at the same rate as a WR running 80% of routes in an Air Raid.

**13. (In-season) "Coaching change resets all rate metrics" is binary when it should be graded.** A new HC is a bigger reset than a mid-season OC promotion; an OC fired *and* replaced by an outsider is a bigger reset than promoting the QB coach from the same staff. JJ's public framing ("wait 2-3 games") doesn't differentiate, which is a strict-superset call: it correctly flags the regime change but discards information about its likely magnitude.

**14. (Format-dependence) The variance-over-floor framework lacks a payoff-curvature taxonomy.** The format map (redraft / best ball / guillotine / dynasty contender / dynasty rebuild) is verbal. There is no published mapping from format → payoff curvature → optimal variance level. A formal taxonomy would let listeners parameterize their *own* league correctly; the current framing requires JJ to pre-classify each league type, which doesn't generalize to hybrid formats (e.g. a guillotine with weekly cash payouts; a redraft with playoff-only payout).

**15. (Trade timing) The "sell RBs by mid-October" heuristic confuses two distinct effects.** Effect A is the *price decay* (contender premium peaks in November and falls into January). Effect B is the *injury hazard* (RBs accumulate injury risk every week they're held). The "sell by mid-October" rule conflates these into one timing call, but they suggest different optimal sell windows: A says hold until late November (sell at peak); B says sell ASAP (every week of holding is a tail risk). The right answer is a Bellman trade-off the heuristic doesn't make explicit.

---

## In-season & strategic reasoning patterns (beyond the rookie model)

The prior section catalogs the moves JJ makes when *evaluating prospects* — pre-draft, pre-NFL. This section catalogs the moves he makes everywhere else: weekly process, in-season buy/sell calls, the Late-Round QB strategy *as executed*, lineup construction, dynasty trade timing, and his meta-thinking on how to consume fantasy content. Sources are podcast appearances, public X threads, the legacy lateroundqb.com archive, and his guest spots on Fantasy Points / 4for4 / Establish The Run / Matt Waldman. As before — the moves matter more than the takes.

### A. The Late-Round QB strategy *in execution* — three executable thresholds

JJ's QB framework is now far more mechanical than the 2012 e-book. Public guest spots in 2024–2025 (Fantasy Points, 4for4, ETR) make three numerical thresholds explicit:

1. **Fantasy points per dropback ≥ 0.55** is the "elite next-year" gate. A QB above 0.55 the prior season has historical hit rates "connected to massive fantasy seasons the next year"; below 0.45 is the explicit fade tier ([4for4 / ETR summarization of his framework](https://www.4for4.com/2024/preseason/most-predictable-quarterback-stats)). This is the metric he says is *"the most predictive — and overlooked — stat in all of fantasy football."*
2. **Rushing yards ≥ 20/game** is the second filter. Under 10 rushing yards/game caps the ceiling. The pairing matters more than either solo: a QB above 0.55 FP/DB *and* 20+ rush yards/game has empirically dominated the position next year.
3. **Passing TD rate > 6%** is the regression flag. JJ explicitly fades QBs whose prior-year fantasy production was driven by an unsustainable TD rate, because TD rate is the most regression-prone QB stat and is what makes pure-pocket QB1 finishes one-year wonders ([cited in Draft Sharks summary](https://www.draftsharks.com/article/nfl-coaching-changes)).

The strategy *as executed* is therefore not "always wait" — it's "**wait unless a QB clears 0.55 FP/DB *and* 20+ rush yards/game**, in which case the predictability of that profile makes the early pick worth the opportunity cost." On a [2025 superflex podcast](https://www.draftsharks.com/kb/best-superflex-draft-strategy) appearance he framed this as a "fill out your starters first" pivot: if Allen/Hurts/Daniels are still on the board late in their tier and the WR pool *behind* them is unusually deep (so the opportunity cost is small), draft the elite QB; if WR has a flat slope, wait. **The pivot signal is opportunity-cost flatness, not QB conviction.** This is a cleaner execution rule than "always go late" and it's where JJ has updated most visibly since the 2018-era streaming narrative collapsed.

The streaming layer of the strategy he has *partially* abandoned. The 2018 FantasyLabs analysis showing pure streaming "provided borderline starting QB production at best and QB16+ downside at worst" is something JJ now folds in: he prefers **"a mid-tier QB drafted in double-digit rounds"** (his ETR-era framing) over week-to-week churn, because waiver QBs rarely clear his FP/DB threshold and are mispriced *down* by the market less consistently than the pre-mobile-QB era allowed.

### B. In-season process: regression discipline and sample-size hygiene

Every Monday morning JJ posts a "**Week N data dump**" thread on X with the explicit framing *"as a reminder, these are not takes. This is just data. More context is always important"* ([Week 10 example](https://x.com/i/status/1987849314354311537), [Week 14 on Gibbs target share](https://x.com/LateRoundQB/status/1987849314354311537)). The framing is itself a methodological move — a public commitment device that separates *signal collection* from *opinion formation*. The threads are dense with route share, target share, snap share, and route participation rates; they are deliberately not framed as buy/sell calls. This separation is the in-season mirror of his prospect-eval discipline: collect base-rate inputs first, narrate after.

His weekly buy/sell logic, when it does fire, runs through a few specific filters that refine the prior memo's "did volume change or did efficiency change?" gut-check:

- **Route participation rate is his preferred WR opportunity metric** because it cannot be faked by a one-week target spike. Examples from his X feed: Bucky Irving's 62% route rate at Atlanta is flagged because *"he reached that high of a rate just once last season"* ([tweet](https://x.com/LateRoundQB/status/1965033704465875439)); Pat Bryant's 77% route share is flagged because it's a *season-high* with corroborating target share movement ([tweet](https://x.com/LateRoundQB/status/1995496844919799825)). The repeatable move: **prefer rate metrics with high week-over-week stickiness (route share, snap share) over rate metrics with low stickiness (yards-per-route, target rate per route) when forming an in-season opinion.**
- **Target-share-allowed-vs-expectation by position** ([Oct 2021 thread](https://x.com/lateroundqb/status/1448280108595359744)). He adjusts opposing defenses' target share allowed *to RB / WR / TE separately, against expectation*, because raw target share allowed is a denominator artifact of pace. This is a cleaner matchup tool than aggregate "fantasy points allowed to position" rankings, and he uses it for sit/start tiebreakers.
- **One-week samples are explicitly filed under "weather."** When asked for a take after a single-game outlier, his repeated framing is *"that's one game"* — and his data threads always cumulate season-to-date rather than presenting weekly ranks. The implicit sample-size rule: **don't update on fewer than 3-4 games of opportunity data unless the change is structural (HC fired, OC change, depth-chart vacancy from injury).**

### C. The format-dependence map (variance ≠ universal)

The "Why I Choose Upside Over Safety" thesis from the prior memo is *format-conditional*, and JJ is more careful about this than the YouTube headline suggests. His public format map:

- **Redraft season-long, 12-team standard:** chase upside (variance) — there is no points-for-floor consolation prize, only the playoff bit.
- **Best Ball / large-field tournaments:** chase ceiling harder — correlated outcomes (stacks) and tail outcomes drive equity. Stacking is implicit, not explicit, in his late-round-QB-with-his-WR construction.
- **Guillotine leagues:** invert. *"In guillotine leagues, consistency is king."* He is a documented two-time guillotine champion (cited on the [CHOP Guillotine podcast](https://creators.spotify.com/pod/profile/guillotineleagues/episodes/Draft-Strategies-with-JJ-Zachariason-e1j13g2)) and openly switches to floor-first because elimination formats reweight payoff to weekly survival.
- **Dynasty contender (this year is the title window):** floor-first short-term, upside on the back of the roster.
- **Dynasty rebuild:** the canonical chase-the-tail mode — every win-now veteran is fungible against rookie-pick ceiling.

Repeatable lesson: **the variance-vs-floor choice is *derived from the league's payoff structure*, not from a personality trait.** Treat the format as a parameter, not as a constant. This is one of the cleanest pieces of his meta-framework and is conspicuously absent from most "take more risk!" content.

### D. Trade evaluation and dynasty timing

JJ's public trade framework is asymmetric on time:

- **RB sell window opens at age 26 for productive starters; *list them by mid-October if the team isn't contending*.** The repeated heuristic on the [Footballguys Year-2/3 pod](https://www.footballguys.com/podcast/year-2-3-breakout-candidates-with-jj-zachariason-fantasy-football-2025) and the November-trade-deadline guest spots: contender-priced premiums for veteran RBs *peak in November*, decay through December, and crash in January. Selling earlier than the market thinks is mandatory because the holding cost on RBs compounds *quarterly*, not annually.
- **WR hold window through age 28-29.** He has consistently pushed back on the "WR cliff at 30" narrative; the dynasty market discounts WRs entering 28+ harder than the actual decline curve, which makes those WRs *systematically buy targets, not sell candidates*. This is a textbook market-mispricing argument and one of his most-restated contrarian calls.
- **Process check: "Would I redraft this player at this asset cost in a startup *today*?"** (Restated from prior memo, but the in-season application is materially different: the question is asked weekly, not annually, because injury news / depth-chart events shift the answer.)
- **Multi-piece trades — anchor on the best asset, not the package.** When fielding "should I trade A for B+C+D?" questions, his repeated reframe is to ignore the throw-ins and ask whether A is materially better than B alone. The throw-ins are usually noise (low-ceiling roster filler) added by the side that wants to win the optics.

### E. Waiver-wire philosophy: opportunity over outcomes, structurally

JJ's waiver framework prioritizes **opportunity grants** (route share, snap share, vacated target share from an injury or depth-chart change) over **production hits** (last week's box score). The pattern, restated across every in-season FanDuel waiver pod and his Patreon livestreams: *"don't chase last week's points; chase next week's role."* He explicitly down-weights the post-injury "next man up" RB unless route participation came with the carries — a pure thumper without passing-game work has a much lower league-winner ceiling than the box score suggests. On FAAB, his repeated refrain is to spend aggressively when a clear *role* opens (a starting WR ruled out for the season, a backup RB inheriting a 3-down workload), and to pass on speculative bids when the role is still ambiguous.

### F. Mid-season buy-low / sell-high signals (beyond volume × efficiency)

The prior memo captured "did volume change or did efficiency change?" The in-season *additions* to that gut-check:

- **Route participation surge with target-share lag** = buy. Route share is the leading indicator; target share follows. A WR running 75% of routes with a 12% target share is mispriced *up* on opportunity.
- **Snap share collapse with point-total maintained** = sell. The points came in a smaller snap window, meaning the underlying TD rate or YPRR was unsustainable.
- **Coaching-change events** (HC fired mid-season, OC change) reset all rate metrics. He treats prior-regime route share as *stale* under a new staff and waits for 2-3 games of new data. The 2025 example: Gibbs's target share jumped from 12.9% to 20.7% the moment Dan Campbell took over play-calling ([Week 14 dump](https://threadreaderapp.com/user/LateRoundQB)). The *event* is the signal; the new sample is the confirmation.
- **TD-rate-driven QB1 finishes are sells.** A QB scoring 24+ FPG on a 7%+ TD rate gets sold in dynasty *before* the regression year hits; the public market lags by a season because last-season-TDs are sticky in dynasty rankings even after the underlying regression.

### G. Meta-thinking on fantasy media consumption

The legacy lateroundqb.com archive is the most explicit JJ has been on debiasing your own decision-making, and the framing has carried into the modern podcast intros:

- **Recency effect** ([article](https://www.lateroundqb.com/recency-effect-the-fight-against-what-done-lately/)): forming opinions from "what have you done for me lately" rather than from the underlying baseline. His proposed counter-question: *"What has changed recently and how does that affect this player's value?"* — i.e., separate **structural change** (new role, new team, new contract, new HC) from **recency noise** (one bad game, one good game).
- **Groupthink in fantasy** ([article](https://www.lateroundqb.com/survey-says-family-feud-fantasy-football-groupthink/)): *"How many people do you know that make decisions based on what Expert A and Expert B say?"* His diagnostic: if you can name three analysts you agree with on a player, that player is consensus-priced; the actual edge is in disagreeing with all three for a structural reason. The repeatable move is **not "ignore experts" but "reverse-engineer where the experts agree, and ask whether the agreement is structural or social."**
- **"Data, not takes."** His Monday-thread framing institutionalizes the separation between data delivery and opinion delivery. Most pundits collapse the two; JJ deliberately decouples them so the audience can form their own posterior.
- **Bite-sized 15-minute episodes by design.** This is a methodological choice — short episodes force one-thesis-per-episode discipline. Long roundtable shows blur takes; tight episodes force a single executable claim.

### H. The "upside over safety" thesis — when it does *not* apply

The prior memo treated upside-over-safety as a default. The fuller version: it's a **conditional** default, true in most redraft and dynasty rebuild contexts, *not* true in guillotine, *not* true in dynasty contenders' starting lineup, *not* true in cash-game DFS (where he flips to chalk). The argument's mechanism: in rank-payoff formats (top 1-2 finishes own the prize money), variance is undervalued by the market because most players are loss-averse. In linear-payoff formats (every win matters equally) or elimination formats (a single weekly bottom-finish kills you), variance is *correctly* priced or even *over*-priced, and floor wins. The lesson: **identify the payoff curvature first, then choose variance.**

### I. Calibration and being wrong in public

JJ does not publish a formal scorecard, but his Twitter feed and podcast have a recurring discipline: when a model-loved prospect misses (he's named several Day-2 WRs from 2020 publicly), he traces the miss to a *specific input the model couldn't see* (landing spot, OC change, in-game injury) rather than declaring the model broken. This is a defensible epistemic move *and* the un-falsifiability gap from the prior memo. He is more accountable on in-season buy calls than on the prospect model: when his "buy this guy" tweet ages badly, he has been documented retweeting his own prior call with a "I was wrong on this" frame, particularly on QB calls. The calibration discipline is asymmetric — better on weekly takes, worse on the model output, because the model's outputs are deliberately framed as distributions ("range of outcomes") that resist a single retrospective grade.

### J. The weekly process ritual (reconstructed)

From his content cadence and Patreon descriptions, his weekly in-season process appears to run:

1. **Monday AM** — data dump thread (route share, target share, snap share, route participation, season-to-date rate metrics).
2. **Monday PM / Tuesday** — podcast episode on the week's signal-vs-noise calls; one-thesis-per-episode discipline.
3. **Wednesday-Thursday** — waiver wire / FAAB livestream for Patreon, with FAAB-bid recommendations grounded in route-share-grant size, not last-week production.
4. **Friday-Saturday** — sit/start Q&A livestream; tier-based (not ranking-based) framing on the Tier 2 / Tier 3 borderline calls he gets asked about.
5. **Sunday** — observation only; no in-game updates.
6. **Loop.**

The discipline embedded in the cadence: **separate observation from opinion in time as well as in framing.** The Monday data thread comes before the Monday podcast; the podcast comes before the waiver bid; the waiver bid comes before the sit/start. This is a process firewall that resists letting the day's news write the week's takes.

### K. Triangulation against peers (in-season layer)

The prior memo triangulated JJ's *prospect-eval* peers. The in-season peer map is partly different:

- **JJ vs Rich Hribar (Sharp Football):** Hribar lives at the weekly-DFS / matchup layer; JJ at the season-long-process layer. They converge on *target share allowed by position* and *route participation* as the cleanest weekly metrics.
- **JJ vs Hayden Winks (Underdog):** Winks weights ADP-based market signals more heavily in-season; JJ weights opportunity-grant signals more heavily. Disagreement surfaces when a player's ADP has moved sharply but route share has not (Winks: trust the market; JJ: trust the role).
- **JJ vs Pat Kerrane (ETR / Legendary Upside):** Kerrane integrates film and tape-based read of a role change faster than JJ's metrics-based approach; JJ waits for 2-3 games of route-share data; Kerrane will buy on a Week 1 tape read. The disagreement is about how much you should trust a single-game film signal.
- **JJ vs Ben Gretch (Stealing Signals):** the closest methodological neighbor — both prioritize opportunity signals and process discipline. They differ mostly in scope (Gretch broader / more philosophical, JJ tighter / more numerical).

---

## Longitudinal model evolution (2017–2026)

Compiled from direct read of JJ's `Late-Round Prospect Guide` archive: 2022 V2/V3 (140 pp), 2024 PostDraft V2 (~165 pp), 2026 PreDraft (172 pp), and 2026 PostDraft (177 pp). The 2024 guide explicitly frames itself as *"the Z-Prospect Model isn't gone — it's just improved … you can think of the ZAP Model … as a V2. Like Charmander turning into Charmeleon. We're not quite to Charizard yet, but we're getting there."* That's the most useful single line in the archive: he treats the model as a continuously refit organism, not a finished product.

### The lineage in dated terms

| Year | Model name | Status | Notable change |
|---|---|---|---|
| 2017 | First mathematical model | Self-described "trash" | Got "lucky" hits on Aaron Jones, Kareem Hunt, Kenny Golladay — but no real foundation |
| 2019 | Second iteration | The "Rookie Rankings Failure" — fixated on Mecole Hardman over the model's own signal, model loved Andy Isabella | Catalyst for the rebuild |
| 2020 | **Z-Prospect Model** built | First model that beat draft capital *and* rookie ADP at predicting B2S | Foundational framing established |
| 2022 | Z-Prospect (refined) | RB + WR only, no TE, no QB | Added Conference Factor + Teammate Score; Breakout Age binary threshold (20% Dominator); training sample 2006+ |
| 2024 | **ZAP Model 1.0** (rename) | RB + WR + TE; first year of TE coverage | **Breakout Age → Breakout Score** (binary → continuous, age + SOS adjusted); Fantasy Points Score added to WR; training sample narrowed to 2011+ |
| 2026 | **ZAP Model 2.0** | 5th iteration; TE model rebuilt with Brandon Gdula | Best-season adjusted FPpG added to WR; age + schedule-adjusted total yards per team play added to RB; RB blend of 83/17 actual + projected draft capital; **TE model adds explicit capital × athleticism interaction**; new tier-named scoring scale (Legendary Performer, etc.); Year 2 Model expanded from Y2 of Y1-3 to **B2S of Y2-Y4** |

### What stayed constant across all four guides

These are the load-bearing principles, repeated almost verbatim across 2022–2026:

- **B2S target metric.** Every guide predicts the same outcome variable: average of a player's two best PPR-ppg seasons in his first three NFL years. The 2026 guide added an 8-game minimum (raised from 6 in 2024) and explicitly excludes Week 18, but the core target is unchanged.
- **Draft capital is the single most important input.** The exact line *"Draft capital is the single most important piece of the puzzle"* appears in 2022, 2024, and 2026.
- **Validation hurdle: "beat draft capital, then beat ADP."** This two-step validation is in every guide. If the model isn't more predictive than draft capital alone, it isn't worth using; if it isn't more predictive than rookie ADP, it isn't worth a leaguemate's edge.
- **The model is the baseline, not the answer.** Every guide ends with the same "Adding Subjectivity" message: *"You don't need to follow the ZAP Model blindly. In fact, I don't want you to."* Subjectivity is allowed for documented reasons (Waddle 2021 injury context, Antonio Gibson 2020 talent + role uncertainty); not allowed when it's just a vibe override.
- **Process > outcome.** Every guide invokes the discipline. The 2024 guide names *"the Rookie Rankings Failure"* of 2019 explicitly — a public outcome attribution to a specific process error (overrode his own model on Hardman because he liked the landing spot).

### What changed — and what the change reveals

**1. Binary thresholds gave way to continuous scores.** The single biggest methodological evolution from 2022 → 2024.

The 2022 guide used **Breakout Age** — a binary "did the player hit 20% Dominator before his Junior year" cutoff. The 2024 guide replaced it with **Breakout Score**, which uses receiving yards per team pass attempt across a player's whole college career, prorated for missed time, age-adjusted, and SOS-adjusted via Sports Reference team-level data. JJ's 2026 explanation: *"a player either clears the threshold or he doesn't. There's no room for nuance. A wide receiver can fall just short of the breakout mark and be treated the exact same way as someone who barely contributed at all."*

The repeatable lesson is general: **whenever you find yourself using a binary cutoff in a model that has small sample, ask whether the threshold itself is doing real work, or whether it's just compressing a continuous signal into noise.** Almost every binary in fantasy modeling (breakout age, athletic gates, dominator thresholds) has this flaw. JJ's iteration here is what mature analytical practice looks like.

**2. New positions arrived, slowly, and only when the data supported them.**

- 2022: TE model attempted, abandoned. The guide says directly *"I've also started the creation of quarterback and tight end models, too. It just hasn't worked out. Yet."* He refused to ship until the model beat draft capital — the same hurdle he applies elsewhere.
- 2024: TE model shipped. R² wasn't published, but the guide notes the results were *"solid."*
- 2026: TE model rebuilt entirely with help from Brandon Gdula. R² published: 0.558. Key finding (a non-linear interaction, not an additive coefficient) about athleticism × capital that the 2024 model couldn't capture.
- 2017–2026: QB model still has not shipped. The guide each year says some version of *"finding the right things to hone in on has been challenging."* He has held the line for nine consecutive years on not publishing a QB model that doesn't beat the bar. That self-discipline is rare.

**3. Era-narrowing of the training sample.** The 2022 guide trained on players drafted or invited to the NFL Combine since 2006. The 2024 and 2026 guides narrowed the window to 2011+. This is a quiet but meaningful era-adjustment — the spread offense / RPO / NFL passing-rate shift that started around 2010–2012 makes pre-2011 college and NFL data structurally different. By dropping the older years, JJ implicitly era-adjusted without ever publishing the "era-adjustment" framing that Koalaty (Bryan) does explicitly.

**4. Interaction effects entered the framework.** The 2022 and 2024 ZAP models are essentially additive — capital + age + production + athleticism, weighted and summed. The 2026 TE model is the first place where JJ explicitly endorses an *interaction*: the value of capital depends on athleticism, and the value of athleticism depends on capital. *"Through a lot of research, Brandon found that draft capital doesn't operate in isolation at this position. Its signal shifts depending on the athlete."*

This is methodologically significant because most public fantasy models — including JJ's own RB/WR ZAP — assume additive structure. The TE finding is the kind of thing that emerges only when you let the model breathe on a small position with weird archetypes, and it suggests the same exercise is probably worth running on RB and WR. The 2026 RB model partially does this with *"production metrics weighted depending on where a player is selected in the NFL Draft"* — late-round picks are evaluated more on yards per team play, early-round picks more on reception share — but it's not framed as a formal interaction.

**5. Presentation moved from raw percentile → 0–100 ZAP score → tier-named buckets.**

- 2022: Z-Prospect score reported as a percentile (60–100 banding).
- 2024: ZAP score reported as a 0–100 number with hit-rate tables organized by 5-percentile bins.
- 2026: ZAP 2.0 with named tiers — **Legendary Performer (90–100), Elite Producer (75–90), Weekly Starter (60–75), Flex Play (40–60), Benchwarmer (30–40), Waiver Wire Add (20–30), Dart Throw (0–20)** — and a published conversion chart showing how to map ZAP 1.0 → ZAP 2.0 because the new scaling spreads players differently.

The presentation evolution mirrors a real analytical insight he keeps refining: **ranks are noise; tiers are signal.** A 91 vs 90 ZAP score is below the noise floor of the model, and presenting them as ordered ranks creates false precision. The named-tier framing is a public commitment device that prevents the over-confident reading of small score gaps. The 2026 PostDraft rookie-rankings notes section makes this even more explicit: *"a difference of 5, 10, or even 15 points in the model isn't the biggest deal in the world."*

**6. Year 2 Model expanded its prediction window.** Through 2024, the Year 2 Model predicted a player's Year 2–3 best season. The 2026 version expanded to Y2–Y4 *"because it gives us a larger, more stable sample to work with. Expanding the window allows the model to better capture delayed breakouts, injury interruptions, and uneven early-career development — all things that can distort shorter evaluations."*

This is exactly the **best-2-of-3 fix we landed on** for our extension-followthrough analysis (catching Saquon's Y3 ACL season), generalized: when small-sample noise pollutes a metric, expand the window before you start adjusting weights.

**7. Hit-rate retrospectives are baked in, but un-Brier-scored.** Every guide includes hit-rate tables showing realized B2S percentages by tier — the 2026 RB table shows that 100% of "Legendary Performer" RBs (n is small) hit 10+ ppg B2S, 87.5% hit 14+, 75% hit 18+, while "Dart Throws" hit 10+ at only 3.7%. The retrospective discipline is real. What's missing across all four guides is a **calibration plot** — the question "do the predicted percentiles match the realized hit rates?" is implied by the table but not formally tested. A reader can construct it from the data; JJ doesn't publish it.

### What the evolution tells us about how he thinks

Five meta-observations from reading the guides longitudinally:

**(a) He removes inputs more often than he adds them.** The 2026 guide explicitly notes the RB ZAP model dropped all rushing-specific stats (a major change from earlier versions) and has now partially re-added them (yards per team play, with weighting that interacts with NFL round). The default move when a metric isn't earning its keep is to remove it, not to keep it for legacy reasons.

**(b) He hires when the work scales beyond him.** Brandon Gdula joining for the 2026 TE rebuild is a tell: he doesn't pretend to have the bandwidth to rebuild every model every off-season. The model gets *better* when fresh eyes touch a position he was weakest at.

**(c) He admits whiffs in print, in the next year's guide.** The 2024 guide names Mecole Hardman as the cause of the "Rookie Rankings Failure." The 2022 guide names Andy Isabella as the model's earlier love that flopped. The 2026 guide treats Puka Nacua as a Day-3 outlier whose hit doesn't validate Day-3 RB betting. These are all retrospective miss-attributions tied to specific process errors. The discipline is unusual for paid fantasy content.

**(d) He resists pressure to publish a QB model.** Every year's guide gets the same paragraph about why QB isn't ready. The fan/customer pressure to ship is presumably enormous (paid product, listeners ask weekly). Holding the line for nine years on "the model doesn't beat the bar yet" is a process-discipline signal worth more than anything else in the guides.

**(e) The principles are stable; the implementation is volatile.** B2S, draft capital prior, beat-ADP validation, process-over-outcome, range-over-point — these don't move across four guides. What does move: which inputs are in, which thresholds are used, which positions are covered, how the score is presented. **Adopt the principles aggressively; treat any specific implementation as a snapshot likely to be re-fit next off-season.**

### Direct lessons for our own work

Pulling forward from the longitudinal read:

1. **Calibration plot is missing from his framework.** We can build one from his published hit-rate tables. Plot tier-predicted hit rate vs. tier-realized hit rate over 2014–2022 cohorts. If it's diagonal, the model is calibrated; if it bows, we know which tiers over- or under-predict. JJ doesn't publish this. We can.
2. **Era-narrowing is real and worth applying to our cohort work.** He silently dropped pre-2011 from his sample. We've been pooling 2012–2022 for hit rates. Consider re-running headline numbers on 2017+ only (post-spread/RPO era stable) and reporting both.
3. **Interaction effects are under-modeled in the additive ZAP.** When we build any combined meta-model, ask explicitly whether each pair of inputs interacts. The TE example (capital × athleticism) is a template; expect more in the data.
4. **Tier-compression discipline is non-negotiable.** Whenever we report ranked outputs, present them as tiers with explicit "below the noise floor" warnings. A 91 vs 90 isn't actionable; a Legendary Performer vs Elite Producer cut is.
5. **Year 2 Model's expanded Y2–Y4 window confirms our best-2-of-3 instinct.** Both moves are versions of the same principle: when small-sample noise pollutes an estimate, expand the window before you start re-weighting features.
6. **He doesn't engage with auction / cap mechanics, multi-year contract structure, or in-season starter-tier pricing.** Those are still our terrain. The framework above gives us better *rookie-evaluation inputs*; the value-creation layer remains converting those into UPS-specific cap-dollar EV.

### One unresolved question

**Why doesn't he publish per-prospect confidence intervals?** ZAP outputs a point number (96.2, 88.3, etc.). The hit-rate tables effectively give an empirical CI but it's tier-level, not per-player. Bootstrapping the historical model fit and reporting ±X per prospect is straightforward in principle. The 2026 PostDraft notes acknowledges *"a difference of 5, 10, or even 15 points in the model isn't the biggest deal in the world"* — which is a tier-compression statement, not a per-prospect uncertainty statement.

The implementation gap suggests he hasn't formalized prospect-level prediction intervals, even though his messaging consistently invokes the concept of range. When we build any model that consumes ZAP scores as inputs, we should attach our own bootstrap CI to those scores — the model itself doesn't publish them.

---

## Model-evolution discussions (podcast / YouTube / X)

The longitudinal section above documents *what* changed across the 2017–2026 ZAP iterations from a direct read of the Prospect Guide archive. This section captures the *why* — the testing rationale, validation findings, and decision context — pulled from his podcast back catalog, guest spots, and X feed. Where a specific change has a public trail, the source is cited. Where the change appears to have been made behind the scenes with no public explanation, that absence is noted explicitly: it's information about which decisions JJ surfaces to the audience and which he keeps inside the Prospect Guide.

### Dropping rushing inputs from the RB model — *and the testing logic that drove it*

This is the model evolution with the cleanest public trail. On the [NFL Fantasy Football Podcast appearance (April 2025)](https://www.iheart.com/podcast/1157-nfl-fantasy-football-podc-29699073/episode/jj-zachariason-on-his-zap-model-272251766/) and corroborated on [The Football Analytics Show with Ed Feng (Apr 2025)](https://thepowerrank.com/2025/04/19/podcast-jj-zachariason-on-predicting-2025-nfl-prospects/), JJ walks through the actual A/B test that produced the change.

The 2024 RB ZAP used **age- and program-adjusted total yards per team play** — total yards (rushing + receiving) divided by team plays. For 2025/2026, JJ tested replacing that combined metric with **age-adjusted receiving yards per team pass attempt** in isolation — the exact same metric the WR model had used "for a long time," but applied at the RB position. The test rationale, in his own framing: *"we as fantasy managers should and we do, care a lot more about pass catching than the NFL does."* Fantasy scoring weights receptions and receiving yards heavily; rushing efficiency at the college level is contaminated by OL quality, scheme, and box counts; and draft capital already prices in a team's belief in a back's rushing competence. Stripping rushing out of the explicit input list and letting capital absorb the rushing signal cleaned up the noise.

The validation he describes is retrospective — applying the new spec to historical classes and watching specific players move. The named example: **Kenneth Walker's strong receiving-efficiency-per-pass-attempt score wasn't captured by reception share alone** (Walker had a small reception share, but when targeted he was extremely efficient per team pass attempt). The new metric flagged him; the old one didn't. This is an example of what JJ describes as the metric "getting more signal" — it correctly priced a known hit the prior spec missed.

**The 2026 partial re-add isn't on a podcast trail.** The 2026 Prospect Guide reintroduces *"age- and schedule-adjusted total yards per team play"* as a draft-round-weighted input (heavier for late-round picks, lighter for early-round picks). I could not find a podcast or Twitter explanation of this re-add. The most likely rationale, inferred from JJ's repeated framing on the [Sean McVay tweet](https://x.com/LateRoundQB/status/1917220110273822875) about Jarquez Hunter — *"Reception Share … Breakout Score … Career explosive run rate"* — is that for late-round picks, draft capital is so flat (every Day 3 RB has near-identical capital) that the model needs *some* on-field rushing signal to differentiate, and total-yards-per-team-play is the cleanest schedule-adjusted version. **This is one of the changes the guides advertise but the podcast does not explain.**

### Breakout Age → Breakout Score (2024)

The 2024 swap from a binary "did the player breakout before age 20" cutoff to a continuous schedule- and age-adjusted score is **discussed thematically but not with the specific R² delta** the question asks about. On the [NFL Fantasy Football pod](https://www.iheart.com/podcast/1157-nfl-fantasy-football-podc-29699073/episode/jj-zachariason-on-his-zap-model-272251766/) JJ frames the change as a generic precision improvement — the binary was throwing away signal at the threshold edge — without naming a specific R² number. The Prospect Guide quote he uses elsewhere (*"a player either clears the threshold or he doesn't. There's no room for nuance"*) is the public articulation; the podcast version is functionally the same.

What *is* on the podcast trail is the **construction of the new metric**: the [Hunter / Jarquez Hunter tweet](https://x.com/LateRoundQB/status/1917220110273822875) explicitly defines Breakout Score as *"Schedule- and age-adjusted receiving yards per team pass attempt."* The Twitter thread context shows him using it not just as a continuous scalar but as a **player-discrimination tool**: Jarquez Hunter beat Kyren Williams and Blake Corum on Breakout Score *despite a similar McVay-archetype profile* because his per-pass-attempt receiving efficiency at a young age was a positive outlier. The repeatable testing pattern: when a binary input fails to discriminate among players who all "passed the threshold," replace it with the continuous version of the underlying signal.

**The R² he never published.** No podcast appearance I found cites a specific R² delta from binary → continuous. He references the model "getting more signal" in qualitative terms only. This is consistent with his broader pattern of refusing to publish per-input R² contributions in either the Guide or the podcast — the validation discipline is "does the model beat draft capital, then does it beat ADP," not "does this input have R² > X."

### The TE model finally shipping — and the Brandon Gdula story

The 2024 TE model ship date and the Brandon Gdula collaboration are **partially traceable**. Gdula's earliest public TE-model work appears in his own Late-Round newsletter dated **March 22-23, 2023** ([Newsletter Archive](https://lateround.com/newsletter-archive/), titles "*I Might Have a Tight End Model?*" → "*I Might Have a Tight End Model!*" → "*Tight End Model Results*" on May 1, 2023). The escalation of the title (the question mark in the first edition becoming an exclamation in the second) is itself a process artifact — Gdula was iterating in public, and the V2 newsletter is presumably where he convinced himself the model cleared the "beat draft capital" hurdle JJ has consistently set as the publish threshold.

On the [recent Late-Round "Biggest Prospect Movers" episode](https://www.iheart.com/podcast/1119-the-late-round-fantasy-fo-29699178/episode/the-show-biggest-prospect-movers-rookie-328855177/), JJ explicitly attributes the 2026 TE work: *"I think a lot of that is is Brandon's edition with with the tight end work."* The division of labor described: Gdula did *all* the TE write-ups for the 2026 Prospect Guide. JJ functions as model owner / framework architect; Gdula owns the TE position-specific build. This is consistent with JJ's stated discipline of not shipping a position model that doesn't beat the bar — when his bandwidth couldn't clear it on TE, he hired in rather than ship a worse model.

**What's missing from the public trail:** I could not find a podcast where JJ explains *what changed between the 2022 "it just hasn't worked out yet" model and the 2024 ship version.* The most likely answer (inferred from the timing of Gdula's 2023 newsletters and the 2024 Guide ship date) is that **Gdula's Mar/May 2023 work *was* the testing — the 2024 ship was 12 months of iteration on Gdula's published spec.** But JJ has not, on a public source I could find, said this in those words.

### The capital × athleticism interaction at TE

The most analytically novel piece of the 2026 model has **the most podcast coverage but the least specific testing detail.** The interaction shows up in the 2026 Guide as an explicit non-linear effect: conditional on early-R2 capital, *less*-athletic TEs outperform combine-freak TEs. JJ's published quote (*"Through a lot of research, Brandon found that draft capital doesn't operate in isolation at this position. Its signal shifts depending on the athlete"*) attributes the discovery to Gdula but doesn't describe the test.

The clearest podcast articulation comes from the [Biggest Prospect Movers episode](https://www.iheart.com/podcast/1119-the-late-round-fantasy-fo-29699178/episode/the-show-biggest-prospect-movers-rookie-328855177/) where JJ uses Eli Stowers vs Kenyan Sadik as a working example: Stowers had *superior* pass-catching metrics than Sadik but lower projected capital, and JJ riffs that Sadik *"goes down this path as a pro like that he's just an athlete and not it doesn't really translate that well."* The framing of the interaction is the **selection-effect story** — when an NFL team spends real capital on a non-athletic TE, the team is signaling that the receiving production *had* to be undeniable to overcome the athletic profile. It's a Bayesian inference about NFL team beliefs.

The Hunter Henry vs Michael Mayer comparison from the 2026 Guide (Henry preferred *because* of weaker athleticism at similar capital) is the textbook case of this logic. **What's not on a podcast:** the specific functional form of the interaction — is it multiplicative, log-linear, or a thresholded step function? — and whether Gdula tested alternative interaction terms before settling on this one. The selection-effect story is the *intuition*; the specific spec is in the Guide and not on the air.

The interesting open question JJ has *not* publicly addressed: are they hunting for similar interactions at WR and RB? The 2026 RB model's "production weighted by draft round" is closer to a piecewise-linear interaction than a true multiplicative term, but JJ has not framed it as the same kind of finding as the TE interaction.

### The 83/17 actual + projected draft capital blend (RB, 2026)

This is **a new 2026 input with no podcast or Twitter trail I can find.** The Prospect Guide describes blending 83% actual draft capital with 17% projected draft capital for the RB model. The most likely test rationale — inferable from JJ's general framework but not stated by him — is that for *late*-round actual picks, the "actual capital" signal is so flat (Day 3 picks compress into a narrow band) that adding a small projected-capital weight breaks ties and reflects the pre-draft consensus among NFL evaluators that the capital floor obscures. The 83/17 split itself is presumably the result of an empirical fit — but JJ has not publicly walked through the cross-validation that produced those weights.

This is the kind of change that would be interesting to grill him on but appears to have been shipped silently in the Guide. **One of the model's most concrete numerical decisions, with the least public explanation.**

### Year 2 Model expansion to Y2-Y4

The 2026 expansion of the Year 2 prediction window from "Y2-Y3 best season" to "Y2-Y4 best season" has **partial podcast coverage** via the [Footballguys "Year 2-3 Breakout Candidates" episode](https://www.footballguys.com/podcast/year-2-3-breakout-candidates-with-jj-zachariason-fantasy-football-2025) and the related [9 Breakout Players article](https://www.footballguys.com/article/2025-9-dynasty-breakout-players-to-target-right-now). The expansion isn't framed as a model change in those appearances — JJ talks Year 2-3 candidates the way he always has — but the *Guide explanation* (*"a larger, more stable sample to work with … delayed breakouts, injury interruptions, and uneven early-career development"*) is consistent with his broader sample-size hygiene patterns.

The repeatable lesson he doesn't quite articulate but consistently practices: **when a target metric is small-sample-noisy, expand the prediction window before re-weighting features.** This is the same move we made independently with our best-2-of-3 framing for the extension follow-through analysis. Note he made the change quietly — no big "model update" episode announced it.

### The 2019 "Rookie Rankings Failure" / Mecole Hardman post-mortem

The 2024 Prospect Guide names Mecole Hardman as the trigger for rebuilding the model after JJ overrode his model's preference for Andy Isabella. The **podcast post-mortem I expected to find does not exist publicly** — at least not under a searchable title. What does exist:

- The [original 2019 numberFire post-draft rookie rankings](https://www.numberfire.com/nfl/news/25789/fantasy-football-zachariason-s-post-draft-rookie-rankings) where the takes were originally documented — useful as the *primary source of the bad ranks* but not as a post-mortem.
- A [numberFire piece](https://www.numberfire.com/nfl/news/24774/zachariason-8-players-my-rookie-model-likes-more-than-the-consensus) where the model identified Isabella as its #3 WR — the model's love that Hardman's narrative led JJ to override.
- No dedicated podcast episode I can find titled around the 2019 retrospective.

The post-mortem appears to live in the **Guide's intro material rather than on the air.** This is a tell about JJ's content strategy: in-print self-criticism (he names the whiff specifically in 2024 and 2026 Guides), but he doesn't market the failure on the podcast. The customer-facing version of the lesson is "this is why I built ZAP." The audience-facing version on the pod is "trust the model" without dwelling on the catalyst.

### Combine athleticism exclusion at WR

JJ's exclusion of RAS-style athletic testing from the WR model is **stated repeatedly but never with the testing trail.** On the [NFL Fantasy Football pod](https://www.iheart.com/podcast/1157-nfl-fantasy-football-podc-29699073/episode/jj-zachariason-on-his-zap-model-272251766/) and [Power Rank pod](https://thepowerrank.com/2025/04/19/podcast-jj-zachariason-on-predicting-2025-nfl-prospects/), he frames the WR model's inputs as production-share-driven and treats athleticism as a TE-only first-class input. He does not, on either appearance, walk through the test that ruled out 40-time / SS / explosion at WR.

The implicit logic, recoverable from his broader framing: **at WR, college production already absorbs the athleticism signal** (a 4.3 guy who can't separate doesn't put up a 40% dominator; a 4.55 guy who runs routes does). At TE, college production is too weak a signal because of the role-divergence problem (blocking TEs vs receiving TEs play different sports), so athleticism has to enter as its own input. This is consistent reasoning — but he doesn't ground it in published correlation tables. **This is one of the model's most defensible exclusions and one of the least publicly defended.**

### NIL / early-declare rate decline

The 2026 Guide notes early-declare rate dropped from ~26% (pre-2023) to ~15% (2023-2025). I could find **no podcast or Twitter discussion** of whether this changes the predictive value of early-declare status as a binary input. Given that "declared early as a junior" historically correlated with eventual NFL hit-rate, a structural shift in *who* declares early (smaller cohort, more selected) should change the conditional probability — and JJ has not, in any public forum I can find, addressed this explicitly. The Guide notes the trend; the podcast does not engage with the model implications.

This is methodologically the most under-discussed of the recent changes — a real era effect on a real input, with no validation update I could trace.

### What the "no public trail" patterns reveal

Five themes emerge from where podcast coverage *isn't*:

1. **Specific functional forms are private.** JJ talks about *what* an input is and *why* it's in the model, but not the *form* (linear, log, multiplicative, thresholded). The 83/17 RB blend, the TE interaction's exact spec, the Year 2 model's update mechanism — all in the Guide, none on the air.
2. **He talks about adds, not removes.** The drop of rushing inputs got a full episode. The 2024 narrowing of the training sample to 2011+ got nothing. Removals are quieter than additions, even when the removal is methodologically more interesting.
3. **Validation is qualitative on the air.** "Beat draft capital, beat ADP" is the framework; specific R² deltas, specific player-level reranks beyond Walker, specific cross-validation folds — all absent from the podcast. The Guide implies more rigor than the podcast does.
4. **Public retrospectives are tied to *content*, not to *model updates*.** The Hardman whiff is named when JJ is writing a new Guide (selling it requires a "this is why I rebuilt"); it's not named when a 2025 rookie's ranking is being defended on a podcast.
5. **Brandon Gdula is the publicly visible counter-pattern.** Gdula's TE-model newsletters are the **only** part of the 2026 model that has a fully public iterative trail (Mar 22 → Mar 23 → May 1, 2023 newsletters, with the headline punctuation evolving as confidence grew). JJ's own model changes are not iterated in newsletters this transparently. The hire raised the team's public-iteration discipline, not just the model coverage.

The takeaway for our work: when reading JJ's public output, **assume the Guide is the canonical source on functional form and the podcast is the canonical source on intent**. The two are complementary, not redundant. The interesting questions for any future grilling — exact interaction specs, exact blend weights, exact era-narrowing rationale — live in neither, suggesting they're either trade-secret-protected or genuinely informally chosen.
