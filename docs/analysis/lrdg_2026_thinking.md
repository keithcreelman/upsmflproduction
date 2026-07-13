# The Late-Round Playbook — how the LRDG 2026 thinks, and how UPS builds on it

**What this is:** our own-words distillation of the reasoning framework, metrics, and
decision rules in JJ Zachariason's Late Round Draft Guide 2026 (July 10 update), plus
explicit translation to UPS (12-team superflex + TE-premium DYNASTY salary-cap league)
and a build-on roadmap for our analytics (auction values, targets-vs-ADP).

**What this is NOT:** a copy of the guide. The guide is a licensed product owned by the
commissioner; its full text and player-level data stay OFF this public repo (local
reference: pipelines/etl/data/lrdg_2026/, gitignored). This document contains our
analysis ABOUT the guide's methodology — treat the guide's specific 2026 player calls
as read-locally, not republished here.

**Don't treat as gospel (commissioner's directive):** each section ends with critiques.
The value is the THINKING — market-vs-model divergence, tiers as value curvature,
distributions over medians — which we adapt to our formats, not adopt blind.

---

# LRDG 2026 — Philosophy + Draft Plan (Sections: Setup / Your Draft Plan)

## 1. THE AUTHOR'S LOGIC (the reasoning framework)

Zachariason's entire system reduces to one optimization target: **maximize expected value per unit of acquisition cost, evaluated at the roster level, against flawed human opponents**. Everything else in the guide is machinery serving that target. The framework decomposes into six load-bearing ideas:

**a) Process over results.** He opens with the go-for-two-down-eight analogy: the aggressive path creates more win paths even though the failures are more *visible*, and humans judge decisions by visible failures instead of by ex-ante win equity. The lesson he wants internalized: a decision is graded by its expected value at the time it was made, not by outcome. Bad process wins sometimes; good process loses sometimes; edges only cash over large samples. Regression to the mean is his enforcement mechanism — extreme outcomes (Greg from accounting winning) drift back toward baseline.

**b) Every pick is a cost/output trade.** Draft cost (pick or dollars) maps to historical hit rates; players map to output distributions. Skill is refusing to pay early-round prices for late-round-shaped probability, and vice versa. This is explicitly the two-point-conversion math transplanted: lower success rate is fine if the payoff scales more than proportionally.

**c) Projections are medians; players are distributions.** Rankings built from projections encode only the modal outcome. His Blake Corum illustration: if a backup's median projection equals his ADP, he looks "fairly priced" — but if the upside branch (starter's injury → huge role) dwarfs the downside branch (already priced near zero), the *distribution* is mispriced even when the *median* isn't. Uncertainty is symmetric in ignorance but often asymmetric in payoff, which is why rookies and ambiguous-backfield players can be systematically cheap. The follow-on rule: floor matters early (those picks anchor lineups and already carry ceiling), and by the middle/late rounds floor is nearly worthless because floor-only players are waiver-replaceable. His self-check question: does this player have a realistic 90th–95th percentile season that would hurt to watch on someone else's roster? If not, pass.

**d) Rankings are linear; value is lumpy.** The gap between consecutive ranks is sometimes huge and sometimes zero (his restaurant-ratings analogy). A ranking hands you an ordering with no information about where the real cliffs are. That's the entire case for tiers — they encode the *second derivative* of value that a list throws away.

**e) The market (ADP) is the opponent AND the map.** You're beating humans subject to social proof, not an algorithm. ADP is simultaneously (1) genuinely predictive of production, (2) the price sheet telling you what you must pay, and (3) the base rate that disciplines your own takes. So the correct posture is *tethered contrarianism*: hold strong opinions, but express them as timing (waiting to buy your guy near his market price) rather than as reaches, because reaching burns the value spread and, per (c), your guy was never a lock anyway. Supply and demand — starter requirements relative to league size — is what shapes the ADP-to-production curves by position (RB/WR expectation decays fast; QB/TE stays flat because replacement level is cheap), which is why lineup requirements matter more than scoring settings, and why opportunity cost (what you *don't* draft) is the real price of any pick.

**f) Reactivity beats precision.** The draft plan is a prepared map of value pockets and tier cliffs, not a scripted sequence. He is explicit that named strategies (Zero RB, Hero RB) are outputs of conditions, not commitments. As he puts it, efficient drafting means "identifying the right pocket of the draft to attack" (Zachariason, LRDG 2026) — the room's behavior determines which pocket that is. In a superflex room, seven QBs might go in Round 1 or two might; the correct plan is contingent on that, so no static ranking can contain it.

**What he deliberately ignores:** perfect player evaluation (he assumes he'll be wrong a lot and builds the system to survive it), rigid VORP formulas ("too rigid," and readers lack projection databases), half-vs-full PPR distinctions, forced stacking in head-to-head, and machine-precision in-draft optimization. **The causal chains he trusts:** starter requirements → scarcity → price curves; NFL draft capital → prospect success (ZAP); market consensus → production (ADP is predictive); volume concentration trends → positional predictability.

**Market Score is the framework operationalized.** It's the ZAP-model idea ported to season-long: NFL draft capital ≈ ADP as the market-information backbone; the model's job is not to replace the market but to flag *when to pivot away from it*. Feed in ADP plus predictive inputs (prior-season production, current-year team environment, etc.), output 0–100, then exploit the score's numeric nature: hit rates by score bucket, expected PPG by score, and historical comps matched on ADP + positional rank + age + score. The philosophical claim underneath: edges live precisely where market expectation and player probability diverge, and nowhere else.

## 2. METRICS & DEFINITIONS

- **Expected value / hit rates**: cost tier (round/dollars) carries a historical probability of "hitting"; EV = probability-weighted output vs. cost.
- **Regression to the mean**: extreme performances revert toward player/league baselines; used to discount outlier seasons and outlier luck.
- **Variance / range of outcomes**: dispersion around the median projection; projections estimate the most likely outcome only.
- **ADP expectation curves**: per-position trendlines of PPR points-per-game vs. overall ADP, fit on 2014–2025 FantasyData ADP; qualification = ≥8 games played; final (irrelevant) week of each season excluded — a filter applied to *all* analysis in the guide. Shapes: RB falls steeply then flattens; QB nearly flat across long stretches. Used as "what production should this pick buy me?"
- **Replacement level**: two competing definitions he acknowledges — worst hypothetical starter (12-team, 2 WR → WR24; 1QB → QB12) or best readily available waiver player. No universal answer; league size, bench size, waiver behavior all move it.
- **VORP / Value Based Drafting** (credited to Joe Bryant, Footballguys): player PPG minus replacement-level PPG at the same position; enables cross-position comparison. His "loose VORP": use the ADP expectation curves instead of projections — e.g., WR at pick 50 expects ~14 PPG, WR at pick 100 ~10.5, so the pick-50 WR ≈ +3.5/game over a pick-100 replacement.
- **Opportunity cost**: value of the best alternative forgone; a Round-1 QB's true cost includes the RB/WR not taken.
- **ZAP Model**: his rookie-prospect model, 0–100, anchored on NFL draft capital plus college production and age; the template for Market Score.
- **Market Score**: 0–100 score from ADP + predictive inputs (previous-season production stats, current-year team environment, more undisclosed); sortable vs. ADP to find pivots; supports bucketed hit rates, expected PPG per score, and comps (match on ADP, positional rank, age, score). **Coverage limits**: RB/WR only inside top-120 ADP (10 rounds of a 12-teamer); QB/TE inside top-180 (15 rounds) — beyond that, late-round outcomes are ceiling-only and too random, so the model abstains. Dynamic: recomputed as ADP moves; players fall in/out of range.
- **Tiers**: groups of effectively interchangeable players; boxes drawn around ranking clusters where projected output is similar.
- **Scoring-format rank stability** (since 2011): ~32% of top-24 RBs hold the exact same PPG positional rank moving half→full PPR and another ~32% move one spot; ~90% of top-12 RB/WR move ≤2 spots between formats; projection-based (rather than realized) movement is smaller still (≤3 spots).
- **Flex baselines by format**: full-PPR WR66 ≈ 7.9 PPG; RB36 is 2+ PPG better — player quality trumps the "lean WR in PPR" default.
- **Predictability trend (R² of ADP vs. actual points)**: RB rising fairly steadily since 2014; WR sporadic/weakening; top-12 QB in 2025 ≈ zero correlation (min 7 games; Daniels/Burrow excluded by the filter), rivaled only by 2017; top-18 QB R² has shrunk each of the last four years from a 2021 peak.
- **QB ceiling compression**: 2018–2024 typically saw 5–6 top-12 QBs at ≥20 standard PPG; 2025 had 3; only 2 of the top-12 by ADP hit ≥21.
- **"RB2 Rebirth"** (Brandon Gdula): league-wide targets-per-rush at RB is declining, but the lost receiving work is concentrating *onto* the workhorses — early-round backs (including RB2-priced ones) now bundle ground volume + targets, while the late-round satellite/PPR-specialist archetype (Cohen/Riddick types) is dying.

## 3. HEURISTICS & RULES

1. **Never reach meaningfully ahead of ADP in premium capital.** You sacrifice the value spread, you can likely still get him later, and (variance) losing him isn't catastrophic. Occasional "get your guy" is fine; habitual reaching is a long-run loser.
2. **Floor early, ceiling late.** Early picks anchor lineups (safety, ceilings included); from the middle rounds on, only draft players whose realistic ceiling clears their cost — if a Round-11 WR60's ceiling is WR50, he's waiver-replaceable, skip.
3. **The burn test:** target only players whose 90th–95th percentile season would genuinely hurt to miss.
4. **Diagnose your league's economy before drafting:** ignore half-vs-full PPR hand-wringing for intra-position ranking; instead, compute historical multi-season VORP using baselines = (starters required × teams). This is research to re-weight positions, not a list to draft from.
5. **Tiers over ranks.** Take the last member of a top tier at a needed position when tier-mates at other positions will survive to your next pick. Never hinge a plan on one specific later-round name — plan in clusters.
6. **Be reactive, not the aggressor,** especially in nonstandard formats where the positional economy varies room to room.
7. **League depth gates risk:** shallow league / strong waivers → early onesies (elite QB/TE) and aggressive mid-round gambles are fine (the wire is your bumper rail); deep league → scarcity at RB/WR dominates, misses are unrecoverable, be conservative with onesies.
8. **First-onesie risk:** don't be the manager who pays a premium for the first QB/TE off the board that nobody else was going to pay; gauge room sharpness (casual → QBs go early; sharp → they slide).
9. **Don't force stacks in season-long H2H** — each week is one 50/50 matchup, not a 50,000-entry tournament; consider volatility-seeking (incl. via waivers) only late-season vs. superior opponents.
10. **Auction corollaries:** same principles, denominated in dollars. Tier-based max prices; when early sales run above your tier price, re-mark the whole tier and adjust; large tiers are exploitable because you can buy *multiple* members — impossible in a snake.
11. **Market Score arbitration:** when ADP-expectation trends dislike a player but Market Score likes him, downgrade conviction to neutral rather than fading hard.

## 4. 2026 CALLS (brief)

- **Early RBs are real but slightly overhyped — buy anyway.** RB predictiveness is up, mid-round RBs are unusually uninspiring (Jaylen Warren a rare exception), and the RB2 Rebirth means workhorse-adjacent backs bundle the receiving work. Leave with ≥1 early RB; double-tap is fine from the back of Round 1; if you open WR, secure a Round-2-tier back (Chase Brown type). Do not contrarian yourself out of this: "keep zigging while everyone else is zigging."
- **Rounds 3–5 are a WR money zone** (Flowers, McMillan, Egbuka, McConkey et al.) — grab two, or three-to-four in an auction where the tier's size is exploitable.
- **Brock Bowers or bust at TE.** Elite Market Score; top-10 comps imply ~16.4 PPR PPG. Worth it in the back half of Round 2 (not over the early-R2 RB gold mine); bigger priority in shallow leagues. McBride/Loveland/Warren only at a discount to ADP.
- **Late-round QB rebounds (1QB).** 2025 top-12 QB ADP had ~zero predictive power; QB ceilings compressed by a run-heavier NFL; dual-threat depth (Daniels, Williams, Maye, Lawrence) approaches a full 12-team supply of rushing QBs. Don't spend Round 2 on Allen in a 12-teamer; if paying up for a onesie, pay at TE.

## 5. UPS TRANSLATION (12-team SF, TE-premium 1.5/RB 0.8, dynasty salary cap, July slow auction)

**What transfers cleanly:**

- **The lineup-requirements-first doctrine is his single most portable idea, and it's an instruction to distrust his own numbers.** UPS starts ~18 slots including IDP, 2 QBs effectively (SF), and prices TE receptions at 1.5×. His method: rebuild VORP baselines from *our* starter counts using *our* scoring over multiple historical seasons. We're uniquely positioned — D1 has full weekly UPS-scored history. Concrete build: a `ups-vorp` job computing per-position replacement baselines (QB24-ish, TE12-plus-flex-pressure, RB/WR per our flex usage) and points-above-replacement curves in UPS scoring. This becomes the cross-position exchange rate our auction values hang on.
- **ADP expectation curves → auction price expectation curves.** His pick→PPG curves have a direct UPS analog we can fit ourselves: archived `transactions_auction` winning bids (FA-only) vs. subsequent UPS PPG, per position. That yields (1) an expected-PPG-per-dollar curve, (2) a dollars-per-VORP-point conversion → principled auction values under the $300K cap, and (3) his "loose VORP without projections" trick — value a target as curve(his expected price) − curve(replacement price). This slots straight into the Auction War Room next to the existing per-owner intel.
- **Market Score's *architecture* → a UPS divergence score.** We can't see his inputs, but the recipe is reproducible from parts we already own: multi-source consensus ADP board (market) + prior-3-season weighted PPG (our mandated data basis) + xFP/EPA/consistency suite (player probability) + team environment → a 0–100 "pivot-from-market" score, with divergence = our value − market value. The comps idea (match on ADP, pos rank, age, score) is cheap to add to the ADP board and is genuinely useful for dynasty aging curves. Key: use the **SF + TEP columns** of our board as the market baseline, never 1QB ADP.
- **Tiers + reactive pricing → slow-auction cockpit.** His $40-tier/$50-realized example is *exactly* the telemetry a slow auction rewards: a Live Board panel tracking, per tier, members remaining, average realized price vs. our pre-set price, and implied re-mark of unsold tier members. His "buy multiple from a big tier" is stronger for us than for him — a July slow auction with a large tier lets us stagger nominations and pick off the cheapest members late. Pair with our pouncer/lurker owner profiles.
- **First-onesie risk → price-setting risk.** Don't be the bidder who establishes a position's price level before comparables have sold; let the room's economy reveal itself early in the slow auction (his "you don't have to be the aggressor").
- **Deep-league risk gating.** 18 starters + IDP + 12 teams = his 16-team warning case: our waiver "bumpers" are down, so zero-floor lottery bids deserve less budget — *except* taxi squads partially restore the bumper for rookies, which argues for shifting lottery-ticket risk toward taxi-eligible players specifically.

**What must be translated, not copied:**

- **Late-round QB is his founding thesis and it inverts in SF — he concedes this himself** (supply/demand is the whole argument; SF doubles QB demand). But the *2026 QB findings* still transfer in modified form: compressed QB ceilings + growing dual-threat depth mean the **top-of-market SF QB premium is softening at the margin** — the QB6–QB18 band converges toward the elites, so overpaying for a name-brand QB1 salary is worse EV than rostering two band QBs. In dynasty terms: don't chase the Allen-tier salary; the "enough rushing QBs for 12 teams" trend is a depth subsidy.
- **"Pay up at TE, not QB" gets amplified by TEP** — 1.5 PPR widens elite-TE VORP — but our dynasty market already knows it's a TEP league; check whether our league's realized TE prices already exceed the TEP-adjusted consensus before treating Bowers-tier TEs as buys.
- **RB2 Rebirth interacts with our 0.8 RB PPR twice:** satellite/PPR-merchant backs were already discounted in UPS scoring (their archetype's decline costs us less), while the target-concentration-onto-workhorses trend *adds* value to early RBs even at 0.8/reception. Net: his early-RB call likely survives translation, but re-derive it from UPS-scored history, not his PPR curves.
- **His scoring-stability finding cuts in our favor with a caveat:** TEP and 0.8-RB barely reorder players *within* a position (everyone at the position gets the same multiplier), so consensus intra-position ranks remain usable — but they materially shift *cross-position* value, which is exactly the part rankings don't carry. So: borrow intra-position order from the consensus board; own the cross-position exchange rates via UPS-VORP.
- **Redraft ranges-of-outcomes → contract option value.** In dynasty with bid=salary and 1–3+ year terms, "will this player burn me" is a multi-season question. A wide-range player on a cheap multi-year deal is a call option; a bust is not a lost pick but **dead cap** (cut cost = TCV×75% − Earned), which fattens the left tail relative to redraft. Auction values should therefore price (expected surplus over contract years) − (expected dead-cap cost × bust probability) — his framework, with a penalty term he never needs.
- **Market Score's abstention zone** (no scores beyond ADP 120/180 because late rounds are ceiling-only chaos) translates to: don't pretend our models can rank the $1K-bid tier of the FA pool; treat that tier as pure ceiling lottery governed by the burn test + taxi eligibility, not by scores.
- **Not applicable:** stacking guidance (already moot for H2H, doubly so with IDP), snake pick-position mechanics, and his 1QB curves/values wholesale.

**Concrete backlog candidates:** (1) UPS auction price→production curves + $/VORP from `transactions_auction` history; (2) tier-price tracker in the War Room Live Board (realized vs. planned, tier re-marking); (3) a UPS Market/Divergence Score column on the ADP board (SF+TEP baseline, prior-3-yr weighted PPG basis); (4) historical comps on the ADP board; (5) dead-cap-adjusted max-bid calculator per contract length.

## 6. CRITIQUES (don't treat as gospel)

- **Market Score is a black box with no published validation.** Inputs are "a variety," weights undisclosed, and this section shows no out-of-sample hit rates or calibration. The Bowers comp stat (top-10 comps average 16.4 PPG) is persuasive but unverifiable — comp selection has huge researcher degrees of freedom. Use the *architecture*, trust none of the specific scores without our own backtest.
- **Survivorship bias in the expectation curves.** The ≥8-game filter removes injury-wrecked seasons, so the curves overstate the expected PPG a draft slot actually delivers — most severely for late rounds and for RB. Our version should model games-missed explicitly or fit on all seasons.
- **Stationarity contradiction.** He pools 2014–2025 into one set of curves while simultaneously arguing the game has structurally changed (RB predictiveness rising, QB ceilings compressing, RB2 Rebirth). Both can't be fully true; recent-weighted or regime-split curves would be more honest. Our own fits should weight recent seasons.
- **Small-sample trend inference.** The QB-unpredictability case leans on one season of ~10 qualifying QBs, with a min-games filter that happened to exclude Daniels and Burrow — the two data points most likely to change the story. The RB R² "trend" is annual correlations over ~30-player samples; he hedges ("maybe it's variance") and then builds the 2026 plan on it anyway.
- **"Zig while everyone zigs" is in tension with his own value-extraction logic.** If the whole market pushes early RBs, RB prices inflate and the EV spread he preaches shrinks; his rebuttal (mid-round RBs are barren) is asserted from player takes, not quantified against the inflated early-RB cost.
- **Rank-stability ≠ value-stability.** The half-vs-full-PPR tables measure ordinal movement; in a salary-cap H2H league, point *margins* (and therefore dollars) can shift even when ranks don't. Fine for his conclusion, but don't extend it to "scoring tweaks never matter for pricing."
- **Process-over-results is partially unfalsifiable armor.** Any failed call can be retro-classified as variance. The discipline that makes it falsifiable — which he doesn't supply — is a measurable process metric. Ours can be: realized value-vs-market at time of purchase (did our buys close above our price?), tracked season over season, the betting-market "closing line value" analog.
- **The burn test is regret-minimization, not EV.** It usefully filters dead-end floors, but taken literally it overweights narrative-friendly ceilings (the players everyone would "feel devastated" about are precisely the ones the market has already hyped). Pair it with a price check or it becomes a FOMO engine.

---

# LRDG 2026 — Section: Quarterback Evaluation (JJ Zachariason + Market Score sidebar by Brandon Gdula)

## 1. THE AUTHOR'S LOGIC

The chapter is built on one causal spine: **rushing production is both disproportionately valuable in fantasy scoring and far more repeatable year-over-year than passing production**, so the correct way to project QBs is to anchor on the stable component (legs) and treat the volatile component (passing TDs) as a regression candidate, not a projection input.

The reasoning chain:

1. **Scoring asymmetry.** Rushing yards/TDs pay more per unit than passing (a 60-yd/1-TD rushing line beats a 190-yd/1-TD passing line in standard scoring). This has been true since the "Konami Code" era (he credits Rich Hribar, 2013) — what changed is that today's runners also pass well, making the archetype stronger.
2. **Stability asymmetry.** Rushing fantasy PPG correlates year-over-year more than twice as strongly as passing fantasy PPG (qualified QBs since 2011). Passing production is TD-driven, TDs are near-random events (the 80-yd catch to the 1 is worth less than the 1-yd TD toss), so passing lines swing.
3. **Predictability shift.** Because the market now prices rushing in (he dates the break to Lamar Jackson's 2019 MVP), QB ADP has become dramatically more predictive of outcomes. QB scoring itself hasn't grown — the top-12 average was actually low in 2025 — what grew is our ability to know in advance who scores.
4. **Consequence for strategy.** His own signature Late-Round QB thesis is *weakened, not dead*: streaming still yields a low-end QB1 in 1QB leagues, but the free pool is shrinking and the difference-makers get drafted. Early-QB is now "worth having the conversation about" — but **only for mobile QBs**. He explicitly refuses to do cross-position opportunity-cost analysis in this section.
5. **Objective function.** He optimizes for **ceiling relative to cost** (beating ADP expectation), not floor and not raw points — because in 1QB formats replacement-level production is nearly free via waivers, "quarterback is one where chasing upside should almost always be the priority" (Zachariason). He explicitly flags that this flips in superflex/deep leagues (see §5).

What he ignores: passing yardage (weak explanatory power vs TDs), opportunity cost vs other positions, in-season matchup play (Gdula notes it separately), and — importantly for us — aging, since this is a redraft guide.

## 2. METRICS & DEFINITIONS

All under **standard QB scoring: 1 pt / 25 pass yds, 4 / pass TD, −2 / INT**; qualification is generally ≥8 games played.

| Metric | Definition | Key facts as used |
|---|---|---|
| **ADP-vs-scoring R²** | R² of preseason ADP rank vs actual FPPG, by era | Top-24 QBs: **9.2% (2014–19) → ~35% (2020–25)**; same jump in top-18/12/6 buckets. His evidence that the market "solved" QB. |
| **Rushing fantasy PPG (N-1)** | Prior-season rushing fantasy points per game | Buckets **<2 / 2–4 / 4+**. Among top-6-by-ADP QBs since 2014 (n = 23/20/23): the 4+ bucket hit **22 FPPG 48%** of the time; the <2 bucket just **9%**. |
| **Mobile archetype split** | Top-6 finisher seasons since 2011 split at **5 rushing PPG** | Immobile top-6 seasons: 79% needed 30+ pass TDs, 59% needed TD rate >6%, 89% had 3,500+ yds. Mobile: only 21% / 17%, but **100% had 3+ rush TDs**. Immobile = narrow, outlier-dependent path. |
| **TD rate** | Pass TDs ÷ attempts | League avg 4–5%; >5% above average; >6% excellent; >7% elite/outlier. |
| **TD-rate regression table** | Top-24 ADP QBs, ≥300 N-1 attempts, ≥8 games year N, bucketed by N-1 TD rate (<4 / 4–5 / 5–6 / 6+) — measured **vs ADP expectation**, not raw points | Monotonic: the higher the prior TD rate, the worse the return vs cost. Explicitly *not* claiming a 3.5% QB outscores a 6.5% QB — claiming he's the better bet **once cost is included**. Cross-cut: low-rushing QBs only beat expectation from the *very low* TD-rate bucket (bounce-back archetype). |
| **TD vs yards explanatory power** | R² with single-game fantasy points, 20+ att games, last 15 yrs | Pass TDs ≈ **62%**, pass yards ≈ **41%**. |
| **Career Year** | Seasons of experience; top-24 ADP since 2014 | **Year-2 QBs are the best bucket** at beating ADP expectation by both +2 and +4 FPPG — ambiguity keeps cost down. But high variance both ways (Maye/Caleb Williams vs JJ McCarthy). |
| **Fantasy points per dropback (FP/DB)** | Total fantasy points ÷ dropbacks — **rushing points are in the numerator**, so it blends passing efficiency + rushing contribution | For QB18–30 ADP darts (≥200 N-1 att): N-1 FP/DB **≥0.45 → 30% hit 18 FPPG** (fringe QB1); **<0.35 → 11%**. His 2025 Trevor Lawrence call (QB20 ADP, 0.46). |
| **QB VORP** | (avg FPPG of QB1+QB2) − (avg FPPG of QB11+QB12), per season since 2014 | The elite-QB edge over a baseline starter has grown modestly in recent seasons (2020/22/24 > 2015). |
| **Market Score** (Gdula) | Proprietary 0–100 per-position score layering profile stats on ADP; 0 ≈ replacement (~pick 180); 100+ stats backtested | QB inputs: TD rate, rushing production, passing volume, downfield passing, rookie/sophomore adjustments. Claim: beat ADP-alone in 11 of 12 seasons since 2014. 90+ = strong signal; usable value persists in the 60s–70s, cliff below. |
| **Stafford comp set** | ≥200 att, ≥8 games, TD rate >7% AND <2 rushing FPPG since 2011 | Only 5 prior cases (Brees ×2, Manning '13, Romo '14, Ryan '16): **avg −5.4 PPG next season, all ≥ −2.9**. |

## 3. HEURISTICS & RULES

1. **First gate: is he mobile?** Mobile = multiple paths to top-6; immobile = needs an outlier TD-rate season. Ask this before anything else.
2. **Never pay early-round price for a pocket passer.** <2 N-1 rushing PPG + top-6 ADP → 9% chance at 22 FPPG. He calls this the pocket-passer trap.
3. **Mid-round mobile > early immobile.** QB7–18 ADP with 4+ N-1 rushing PPG delivered *better* ceilings (28% vs 17% at 21 FPPG) than early-round pocket passers at a fraction of the cost. Same story late: QB7–18 pocket passers hit 22 FPPG at 3% vs 11% for mobile.
4. **Fade prior-season TD rate ≥6%** unless the QB has a strong rushing base to cushion regression (or a demonstrated history of sustaining efficiency — he part-exempts Lamar/Burrow/Purdy).
5. **Target low-TD-rate (<4%) bounce-backs**, especially the pocket passers — the one bucket where immobile QBs beat cost.
6. **Year-2 QBs are the premium ceiling dart** — but with matching bust risk; the floor concern binds only where streaming can't bail you out (his own SF caveat).
7. **Last-round darts (QB18–30): sort by N-1 FP/DB.** ≥0.45 roughly triples the odds of a usable starter vs <0.35.
8. **Chase ceiling, not floor, at QB** — *in 1QB formats* — because replacement is free.

## 4. 2026 CALLS (brief)

- **Red flags / fades:** **Matthew Stafford** is the archetype's worst case — 7.7% TD rate (career high by ~1 pt, only 5 historical comps, all cratered) with essentially zero rushing. **Joe Burrow** next; softer flags on Goff, Purdy, Drake Maye, and even Lamar (regression risk, though he historically beats it). Malik Willis's 8.6% is unsustainable but his rushing cushions the fall.
- **Targets the data likes:** **Bo Nix** (rushing + improved weapons), **Kyler Murray** (low TD rate + new environment), **Tyler Shough** and **Cam Ward** (Year-2 + low TD rate), **Daniel Jones** (8th in FP/DB in the ADP pool, rushing component, injury-discounted price). **Jordan Love** screens well on FP/DB (~0.48) but the missing rushing caps the ceiling case.
- **Market Score:** Josh Allen = 100 (rushing base + *stable* 5.0–6.3% TD rate six straight years = no regression exposure, plus untapped passing-TD upside). Stafford-type profiles will always grade near the bottom.

## 5. UPS TRANSLATION (12-team SF, TE-prem, dynasty, $300K cap, July slow auction)

**The big inversion — his safety net doesn't exist here.** The entire "chase ceiling, floor is free" stance rests on 1QB streaming. In our SF league up to 24 QB slots start weekly across 12 teams; the FA pool is a wasteland and there's no weekly waiver churn — replacement QB value is *massively* negative-scarce. He concedes this himself (superflex is his named exception). So for UPS:
- **Late-Round QB is dead as a roster-construction strategy** — but note his *own data* now supports paying up: rising ADP-R² (35%) + growing QB1/QB2 VORP means expensive QBs are the *safest* big auction outlays on the board. In SF that VORP should be recomputed against QB24–30 replacement, not QB11–12, which inflates elite-QB value further.
- **Floor matters again.** Year-2 QB darts and TD-rate bounce-backs are great as *QB3/taxi* speculation, not as your QB2. A busted starting QB2 can't be streamed over.

**What survives intact (player-evaluation layer, format-agnostic):**
- Mobility-first screening, the 2/4 rushing-PPG buckets, TD-rate regression, FP/DB, and Year-2 upside are all *pricing* signals — they tell you which QB is mispriced at a given cost, which is exactly the auction problem.
- **Dynasty amplifier:** rushing stickiness compounds over a multi-year contract — a 3-yr deal on a Konami QB is buying the stable component three times. **But** the guide has no aging model: rushing erodes with age/injury (the one dimension redraft can ignore and we can't). Contract length and salary should discount rushing-dependent value by age.
- **TE-premium/0.8-RB scoring doesn't touch QB directly**, but our decoded scoring (4-pt pass TD? sack-yardage −0.1, first downs, etc. — see `docs` scoring-rules alignment) means **every threshold (22 FPPG, 0.45 FP/DB, 5-rushing-PPG) must be recomputed in UPS scoring**, not copied. His cuts are standard-scoring artifacts.

**Concrete builds for our stack:**
1. **Konami columns in the Stats workbench (QB tab):** N-1 rushing fantasy PPG (with <2 / 2–4 / 4+ badge), N-1 TD rate with a regression flag (≥6% fade / <4% bounce-back), and FP/DB — all computable from `src_weekly` + our decoded MFL scoring; dropbacks from the nflverse EPA table (`nfl_player_epa` has dropback-denominated data).
2. **xTD-vs-actual as the regression signal:** we have an xFP suite — replace his raw TD-rate heuristic with actual-vs-expected passing TDs (his own Stafford analysis leans on "42 expected TDs"). Strictly better than the raw rate.
3. **Auction value engine:** SF-adjusted QB VORP (replacement ≈ QB24–28 in our league) → $ share of the $300K cap, then apply a mobility multiplier and a TD-rate/xTD regression haircut, plus an age-decay curve on the rushing component for multi-year bids.
4. **Targets-vs-ADP overlay:** our multi-source ADP board already has SF format chips — score every QB on a Market-Score-style composite (rushing PPG + FP/DB + xTD delta + career-year bump) and surface QBs whose composite rank beats their SF consensus ADP rank. That's precisely his "beat consensus by layering profile on price" idea, rebuilt on our data instead of his black box.
5. **Taxi/dynasty timing:** the Year-2 finding says acquire QBs *between* Year 1 and Year 2, when ambiguity suppresses price — in dynasty terms, bid on post-rookie-year QBs in the July auction before the breakout, and stash Year-1 QBs on taxi.

## 6. CRITIQUES

- **Non-independent samples.** The bucket hit rates (n = 17–23) count the *same players across multiple seasons* — Allen/Lamar/Hurts each contribute several "hits" to the 4+ rushing bucket. He waves this off as "that's the point," but it means the 48%-vs-9% canyon is closer to "a handful of great players kept being great" than a validated rule.
- **The R² era story is confounded.** ADP predicting scoring better since 2020 could reflect the market learning rushing (his claim), or simply a more stable QB landscape, fewer mid-tier turnovers, or partial circularity: once ADP prices rushing and rushing is sticky, correlation rises mechanically. He offers no decomposition.
- **Double-counting risk on TD-rate fades.** "Worse vs expectation" only works if ADP *hasn't* priced the regression — and he admits the market "understands this to some degree" (the Stafford comps were all drafted top-80; Stafford isn't). The edge may already be partially arbitraged.
- **Round-number thresholds, untested sensitivity.** 2/4 rushing PPG, 0.35/0.45 FP/DB, 6% TD rate — all post-hoc cutpoints with no robustness shown. FP/DB is also mildly circular (last year's fantasy efficiency predicting fantasy points) and its star exhibit is one anecdote (Lawrence) with narrative layered on.
- **Market Score is unfalsifiable from the text.** Proprietary, "100+ stats tested" (a textbook overfitting setup), and the 11-of-12 record is an in-sample retrofit ("had it been around since 2014"). Treat it as a plausible composite, not evidence — which is exactly why rebuilding our own transparent version (§5.4) is the right move.
- **2025 contradicts the early-QB pitch** ("pretty ugly for early-round quarterback drafters") and he shrugs it off as maybe-noise — the thesis absorbs both outcomes.
- **No aging or injury model at all** — acceptable in redraft, a real hole for our dynasty pricing, especially since his whole edifice rests on the component (rushing) that ages worst.

Source file: /private/tmp/claude-501/-Users-keithcreelman-Code-MFL-upsmflproduction--claude-worktrees-condescending-keller-4fc8cc/213c497b-3469-4324-a0e5-1b691a06f8a6/scratchpad/lrdg/01_qb.txt

---

# LRDG 2026 — Running Back Section: Comprehension Report

## 1. THE AUTHOR'S LOGIC (own words)

Zachariason's RB framework rests on three pillars, each argued from 2011–2025 historical hit rates rather than film or projection models:

**Pillar 1 — Elite RBs are the biggest positional edge.** He measures per-position VORP as (avg PPG of the top group) minus (avg PPG of a baseline group at the same position) — e.g., RB1–6 vs RB19–24. Most seasons, RBs win this comparison, meaning the elite tier separates from its own position's replacement level more than any other position does.

**Pillar 2 — Elite RBs are more predictable than reputation suggests.** He runs R² between ADP and eventual PPG within ADP tranches. Top-48 RBs show the strongest ADP→scoring relationship of any position over the last decade, and critically, the signal comes disproportionately from the top: strip out the top-12 and RB R² falls from ~39% to ~19%. His conclusion: early-round RBs are among the highest-probability difference-makers a draft offers, and the last two seasons the market has priced them almost perfectly (22 of 24 top-12 PPG finishers came from the top-18 ADP backs, vs a historical norm of ~9/season).

**Pillar 3 — The NFL environment is reinforcing this.** Offenses are countering two-high, lighter defenses with heavier 12/13 personnel; pass rates are falling; TE target share is at a 15-year high; WR share of RB/WR/TE fantasy points hit its lowest mark since 2011 — his coined phrase, "The Death of the WR2." Elite WRs survive; the WR middle class thins; so once the few obvious WR difference-makers are gone, RBs become the rational early pick. He explicitly bets that defensive adaptation is slow (multi-year), so the trend persists into 2026.

He then acknowledges the counterweight (the surviving core of Zero RB): elite RBs miss slightly more games than elite WRs (12.8 vs 13.5 games/season for the top-12), and RB injuries redistribute value more democratically — a backup RB is *handed* workload, while a replacement WR must *earn* targets. So an early RB's downside partially accrues to your opponents via waivers.

The dominant causal chain he trusts throughout: **receiving production is a proxy for talent and coaching trust** → it predicts over/under-performance vs ADP even though it's nominally public information → the market persistently underweights it. Secondary chains: good offenses manufacture TDs and snaps (environment caps or lifts outcomes); prior market belief (last year's ADP) encodes real information; and uncertainty that suppresses cost (ambiguous backfields) is the correct kind of risk to buy in the middle rounds.

What he largely **ignores**: offensive line quality, explicit age curves (career-year buckets are his only aging lens), NFL contract situations, per-carry rushing efficiency for early/middle backs, and any classic "RB dead zone" argument — he implicitly rejects the dead zone, treating RB19–42 as one of the most exploitable segments if you pick the right archetypes.

## 2. METRICS & DEFINITIONS

| Metric | Definition / computation | How it's used |
|---|---|---|
| **Positional VORP** | Avg PPG of top group (RB1–6, WR1–6, QB1–3, TE1–3) minus avg PPG of a same-position baseline group (e.g., RB19–24), per season, 2011–2025 | Shows RBs create the most top-tier separation most years |
| **Positional Predictability (R²)** | R² of ADP vs eventual fantasy PPG within an ADP tranche; min 8 games played to qualify; 2014–2025 | RB top-48 highest of all positions; top-12-only is noisy (1.9% one recent year); RB13–48 alone ≈19% |
| **Early / Middle / Late tranches** | Early = RB1–18 ADP; Middle = RB19–42 (~Rd 4–10); Late = RB43–60 (Rd 10+) | Different metrics apply per tranche; RB18 is his (admittedly fuzzy) drop-off line |
| **ADP expectation** | Expected PPG implied by a player's ADP; "hit/bust" = actual minus expected, with ±2 and ±4 PPG bands | The outcome variable for every hit-rate table |
| **N-1 Receiving PPG** | Prior-season receiving fantasy points per game (PPR) | Early: <4 = danger, ≥8 = elite signal. Middle (Yr-2 backs excluded): <4 = danger, ≥4 = good |
| **N-1 Yards Per Route Run (YPRR)** | Prior-season receiving yards ÷ routes run; middle-round study requires ≥8 games and ≥100 routes | Early: <1.0 dull, ~1.4 inflection, >1.8 special. Middle: <0.7 terrible, >1.7 excellent |
| **Combo receiving profile** | Early: ≥8 rec PPG AND ≥1.4 YPRR. Middle: "Good" = ≥4.0 rec PPG AND ≥1.5 YPRR; "Bad" = <4.0 AND <0.7 (Yr-2 excluded) | Strongest single screen in the chapter (early combo: 41% beat ADP by ≥4 PPG, 7% bust) |
| **N-1 ADP** | Prior-season positional ADP (top-24 = fantasy starter) | Prior RB1/RB2s outperform; Yr-2 backs with top-24 rookie ADP +1.4 PPG vs expectation, outside top-24 −0.8 |
| **Career Year** | Yr 1 / Yr 2 / Yr 3 / veteran buckets | Yr 2 dominates middle rounds; rookies have ugly floors; Yr 3 fallers are suspect; vets = floor without ceiling |
| **Team TD/G (descriptive)** | Same-season team offensive TDs per game | <2 TD/G: 0% of backs beat expectation by ≥4 PPG; ≥3 TD/G: 30% did. Explicitly NOT predictive — context only |
| **Team Environment Score (TES)** | Gdula's preseason offense-friendliness estimate built from expected fantasy PPG at all four positions; opaque scale (a <75 reading is "bad") | Predictive but weaker: <75 → ~25% big-bust rate; top tier → 7% |
| **Teammate Expected Points** | Sum of ADP-implied expected PPG of a back's RB teammates drafted inside the top 180 overall picks | Backfield-ambiguity gauge; middle bucket ("ambiguous backfield") is the sweet spot |
| **Elite RB1 trait profile** | Recent top-12 RBs: 91% ≥50% of team RB rushes, 74% ≥60%; 74% ≥10% target share (57% ≥12%); 67% ≥10 total TDs; 61% ≥20 carries inside the 10; 43% in Yr ≤3 | The workload/receiving/TD archetype an elite pick must plausibly reach |
| **Late-round "hit"** | RB43–60 ADP back who logs ≥6 top-24 weekly finishes (n=50 since 2014) | Replaces ADP-expectation framing where baselines are too low to matter |
| **10-plus-yard run rate** | % of prior-season carries gaining ≥10 yards (min 50 carries) | Late-round hits were more explosive at every threshold; receiving is *inversely* useful in this tranche (specialists ≠ breakouts) |
| **Market Score (Gdula)** | Proprietary 0–100 composite for top-120-overall-ADP backs: ADP + receiving metrics + NFL experience + "Passing Game Score" (team's expected FP ratio of RB vs other positions) | Backs on pass-friendly offenses overperform; run-focused-offense backs underperform. 2026 90+: Gibbs, Bijan |

## 3. HEURISTICS & RULES

**Structural**
- Secure at least one early-round (top-18 ADP) RB; that tranche has produced nearly all recent top-12 finishers.
- Don't over-fear elite-RB injury risk, but understand it: your loss becomes the league's waiver opportunity.
- Different tranches demand different bets: early = stability screens, middle = paid-for uncertainty, late = explosiveness + open opportunity.

**Early rounds (RB1–18 ADP)**
- Fade early backs with N-1 receiving PPG < 4 unless they're a generational pure rusher (Henry/Taylor are the entire exception class).
- Prefer N-1 YPRR ≥ 1.4; treat ≥1.8 as near-auto-buy (no busts in the sample); treat <1.0 as ceiling-capped.
- The double screen (≥8 rec PPG + ≥1.4 YPRR) is the strongest buy signal in the chapter.
- Prefer backs who were already RB1/RB2 by ADP last year; discount Year-2 backs who were rookie-ADP afterthoughts and now cost a premium.
- Downgrade backs projected into bad offenses (TES); upgrade when multiple signals stack.

**Middle rounds (RB19–42)**
- Draft Year-2 backs aggressively — best ceiling (36% beat expectation by ≥4 PPG) and best floor (9% bust) of any bucket, amplified further in ambiguous backfields (+2.4 PPG avg).
- For non-Year-2 backs, apply the receiving screens: never take a "Bad Receiving" back (<4 rec PPG and <0.7 YPRR — 0% ever smashed).
- Target ambiguous backfields: moderate teammate expected points. Avoid both extremes — a solo-drafted back signals a bad situation; a top-18-ADP teammate signals a ceiling cap. His rule, verbatim: "Competition is fine. Elite competition is not."
- Be wary of rookies here (ugly floors, coaches slow-play them when competition exists) and of Year-3 backs who *fell* into the range rather than climbed.
- Veterans = floor plays only; don't expect league-winners.

**Late rounds (RB43–60)**
- Don't draft handcuffs (pure injury-contingent backups): dead roster spot, mid-season injury timing, and you may misidentify the beneficiary anyway.
- Career year alone is noise here; rookie hit rates only spike (24%→56%) when backfield competition is light.
- Weight *rushing* explosiveness (N-1 10+ yard run rate), not receiving — cheap receiving specialists are role-capped.
- Chase ambiguity and open paths, not insurance.

## 4. 2026 CALLS (brief)

- **Clean elite tier:** Gibbs, Bijan Robinson, McCaffrey — the only backs passing the rec-PPG + YPRR double screen; Gibbs and Bijan are the only 90+ Market Scores (Bijan dinged slightly for environment). Jeanty rates Tier-2 on Year-2 + targets + pedigree despite low YPRR.
- **Early-round concern list:** Javonte Williams (fails nearly every screen), Kenneth Walker, Kyren Williams, De'Von Achane (great profile, worst projected environment of the early backs), Travis Etienne. Henry fails the receiving screens but is the sanctioned exception.
- **Middle-round buys:** Jaylen Warren (best receiving profile in the range), the Year-2 cluster (Judkins, Henderson, Tuten, Skattebo, RJ Harvey, Monangai), Jadarian Price (rookie with a backfield to himself).
- **Middle-round fades:** JK Dobbins, Jordan Mason, Tony Pollard, Blake Corum (all "Bad Receiving" bucket), plus Croskey-Merritt and Montgomery.
- **Late-round darts:** Keaton Mitchell (elite explosiveness + McDaniel offense), Nick Singleton, Kaytron Allen, Tyjae Spears; avoid clear handcuffs (Pacheco, Mike Washington).
- **Macro:** expects even more 12/13 personnel in 2026; pass-catching-specialist RBs are vanishing (7 fifty-catch backs in 2025, six of them top-24 picks) — the dual-threat bell cow is the league-altering asset.

## 5. UPS TRANSLATION (12-team SF, TE-prem 1.5, RB 0.8 PPR, dynasty, $300K cap auction)

**What breaks outright:**
- **"Early rounds = RB vs WR" premise.** In superflex, QB replacement value collapses the way his own VORP math would show if run with QB1–24 as startable. Recompute his VORP table with 2-QB baselines (QB13–24) before accepting "elite RBs are the biggest edge" — in SF it's almost certainly QB first, RB second. His QB-section logic and RB-section logic must be re-ranked jointly for us.
- **His PPR scoring.** At 0.8 RB PPR (and 1.5 TE), every receiving-denominated threshold is inflated for us. His "8 receiving PPG" elite line and "4 PPG" danger lines are PPR points; the same usage scores ~15–20% less in our league. Two consequences: (a) the raw thresholds must be re-derived on **our** scoring, or better, replaced with scoring-neutral inputs (YPRR, targets/game, route participation) — YPRR needs no translation at all; (b) the *payoff* of the receiving-back archetype shrinks for us while the Henry/pure-rusher archetype is relatively less penalized. His receiving screens remain valid as **talent/role predictors** but the value gap between Gibbs-types and Henry-types narrows in UPS scoring.
- **Single-season lens.** Everything is year-N hit rates vs year-N ADP. Dynasty contracts (1–3+ yrs) need aging curves and multi-year decay he never supplies. His "veterans = floor, no ceiling" bucket is the closest he comes to an age cliff — insufficient for a 3-year salary commitment.
- **Handcuff rule weakens.** With 18 starters, taxi squads, and deep rosters, a handcuff behind *your own* elite RB has real portfolio-insurance and trade value that his 15-round-redraft bench-economics argument ignores. His underlying point survives in a different form: RB injuries redistribute value through *our July/in-season FA auction*, where everyone bids — so owning the elite RB means budgeting FAAB/cap headroom for the backup market, which is a UPS-specific planning input.

**What transfers cleanly:**
- **Receiving-as-talent-proxy screens (YPRR especially), Year-2 breakout rule, ambiguous-backfield logic, prior-ADP persistence, environment gating, late-round explosiveness.** All are input-side signals independent of scoring format, and the Year-2 rule is arguably *stronger* in dynasty: it says the optimal buy window is the offseason after a back's rookie year, before the market reprices — exactly when our slow auction and trade market operate.
- **TE-renaissance personnel trend** is amplified for us by 1.5 TE PPR — his 12/13-personnel data is a tailwind argument for TE spend that our league's scoring doubles down on (relevant to cross-positional budget allocation at auction).

**Concrete ideas for our analytics stack:**
1. **Auction value translation:** map his tranches to dollar tiers using our multi-source ADP board's consensus rank → our board's ADP-implied PPG (the same math the roast bot uses). "Early-round RB" ≈ top-18 consensus RB; compute expected-PPG-per-$ curves so his hit-rate deltas (±4 PPG bands) convert into bid ceilings/floors.
2. **Screen columns in the Stats workbench / Auction War Room My Board:** N-1 receiving PPG *in UPS scoring* (from `src_weekly`), N-1 YPRR (routes are in our nflverse pipeline scope), N-1 10+ yard run rate (PBP-derivable, like the pace ETL), career-year flag, prior-season consensus-ADP-rank flag.
3. **Homegrown Team Environment Score:** we already have the ingredients — Vegas implied team totals (Vegas sub-tab), `nfl_team_pace`, and `nfl_player_epa` team aggregates. A composite of implied points + pace + offensive EPA is a transparent, auditable TES substitute (his is a black box).
4. **Ambiguous-backfield score:** sum ADP-implied expected PPG of same-team RBs from our consensus board (his top-180-pick cutoff → a consensus-rank cutoff). Flag "solo," "ambiguous," and "elite-teammate" states on auction targets. This is cheap to compute and directly prices which mid-tier RBs deserve 1-yr flyer bids vs none.
5. **Contract-length overlay (our addition, not his):** because winning bid = salary for the contract's life, environment and backfield states *change* over a 3-yr deal while salary doesn't. Rule of thumb from his framework: multi-year money only for backs passing the receiving double-screen at age/Yr ≤4; ambiguous-backfield and explosiveness darts get 1-yr deals; his "veteran floor" bucket never gets year 3.
6. **Targets-vs-ADP report:** score every auction-eligible RB on (screens passed − red flags) and plot against consensus ADP / expected price — his entire chapter is literally a residual-vs-market exercise, which is the exact shape of our planned targets-vs-ADP tooling.

## 6. CRITIQUES (not gospel)

- **Researcher degrees of freedom everywhere.** Henry and Taylor are removed *after* seeing they rescue the low-receiving bucket; Year-2 backs are excluded from the middle-round receiving study *because* including them "weakens the signal"; bucket boundaries (4/8 rec PPG, 0.7/1.4/1.5/1.7/1.8 YPRR, TES 75) are tuned in-sample with no out-of-sample test. Each exclusion has a plausible story, but the stories arrive after the data.
- **Tiny samples behind the boldest claims.** The >1.8 YPRR "never busted" group is 11 players; the early combo screen is 27; ambiguous-backfield Year-2 backs are 24; late-round "hits" are 50 selected *post hoc* by an outcome definition (≥6 top-24 weeks). One or two 2026 counterexamples would materially move these rates.
- **ADP endogeneity / restriction of range.** Receiving production is public and partially priced into ADP already; measuring residuals within ADP tranches invites regression-to-mean and boundary artifacts. He admits the R² tranche boundaries are "somewhat arbitrary" — to his credit — but still leans on cross-position R² comparisons that depend heavily on how strong each position's tranche interiors happen to be.
- **"Market got good at RBs" rests on n=2 seasons** (22/24 top-12 finishers from the top-18). That's as consistent with variance as with a regime change, yet it anchors the pay-up-for-RBs conclusion.
- **The personnel-trend thesis is an unfalsifiable timing bet.** "Defenses will adapt eventually, but not yet" can absorb any 2026 outcome. Directionally reasonable, but it's an argument, not evidence.
- **Descriptive vs predictive slippage.** He is honest that the TD/G table is same-season, but the rhetorical weight of that table (0% smash rate under 2 TD/G) far exceeds what the actually-predictive TES version supports.
- **Market Score is a black box** ("you don't need to worry about what that number means") — we cannot audit its inputs, weights, or overfitting, so we should re-derive the transparent pieces (receiving, experience, pass-friendliness) ourselves rather than import its verdicts.
- **Hedged calls are unfalsifiable:** flagged players are "not auto-fades, but concerns," so any outcome confirms the framework. Fine for a guide; for our models, we should force each screen into a scored, testable prediction against our own historical D1 data before trusting the thresholds.
- **Missing for our purposes:** no O-line inputs, no true age curves, no dead-zone pricing analysis, no dynasty decay — all gaps our own multi-year data (2011–2025 league history + nflverse) can fill.

---

# LRDG 2026 — Wide Receiver Section: Comprehension Brief

## 1. THE AUTHOR'S LOGIC (own words)

The chapter is built on one meta-framework applied three times: **bucket WRs by positional ADP (early = top-18, middle = WR19–42, late = WR43–60), then ask which prior-season (N-1) traits predicted beating ADP-implied expectation in season N, 2014–2025.** He is not ranking players by projected points; he is hunting for *systematic market mispricings* — traits the ADP market underweights or overweights at each price tier.

The causal chains he trusts:

- **Target-earning is the skill; everything downstream is derivative.** A route run is a competition for a target; metrics that bake in the route denominator (YPRR, first downs per route run) capture both "did he win the target battle" and "did he do something with it." Per-target and per-catch stats start the clock *after* the battle is won, so he discounts them.
- **Elite WRs are self-sustaining; everyone else is environment-dependent.** This single premise drives the chapter's most interesting structural result: the *same* environment variable (Pass-Catcher Score) is a **positive** signal for early-round WRs and a **negative** signal for middle/late-round WRs. Studs earn targets anywhere, so a market-endorsed passing game only adds ceiling; non-studs need ambiguity — open target trees and climbable depth charts — to outrun their price.
- **Established production persists and the market still underprices it.** Prior-year 20+ PPG scorers, prior-year top-18 ADP holders, and high prior-year target-share earners all keep beating expectation *despite already carrying elevated prices*. His summary attitude, quoted: "You don't need to get overly cute with your early-round wide receiver selections."
- **A macro regime shift frames 2026:** 2025 saw the lowest NFL pass rate in 15+ years and heavy 12/13 personnel, gutting WR depth ("the death of the WR2") while leaving the elite tier intact — which *widened* the elite WRs' VORP edge rather than arguing for a fade. Conclusion: pay for the very top or hunt ambiguity below; the WR2 middle class is structurally squeezed.

What he deliberately ignores: film/athleticism traits, per-target efficiency, catch rate, and (at the late tier) even YPRR itself — he's explicit that knowing what *not* to weight is part of the method.

## 2. METRICS & DEFINITIONS

| Metric | Definition / computation | How he uses it |
|---|---|---|
| **Expectation vs ADP** | Season-N PPR PPG measured against what a player's ADP slot historically implies; "hit" tables show beat rate and beat-by-4+-PPG (ceiling) rate | The universal outcome variable for every table |
| **N-1 PPR PPG** | Prior-season PPR points per game, min 8 games | ≥20 = elite persistence tier; <15 = red flag at a top-18 price |
| **Career Year** | Seasons of NFL experience entering season N | Year-2 vs Year-5 vs Year-6 splits |
| **N-1 ADP** | Prior-season positional ADP | Was he already top-18 last year? |
| **YPRR** | Receiving yards ÷ routes run, min 200 routes | Hybrid volume+efficiency; thresholds 2.0 (good season), 2.25 / 2.50 (early-round tiers), ~1.70 (late-round low bucket, where it turns out not to matter) |
| **First Downs Per Route Run (FD/RR)** | Receiving first downs ÷ routes run, min 200 routes | Same logic as YPRR, arguably stronger; 12%+ elite, <8% (early) / <6.5% (middle) toxic |
| **Target share** | % of team targets | 25%+ elite; middle-round bands 20/25%; late-round bands 18% (good) / 13% (frightening floor) |
| **Red-zone targets / deep-ball targets / TDs** | Counting stats in the WR1 profile: 78% of historical WR1s had ≥15 RZ targets, 68% had ≥30 deep targets, 37% ≥10 TDs | Descriptive profile of what a top-12 season looks like (~80th-percentile marks) |
| **aDOT** | Average depth of target | Late-round only: higher = chunk-play/TD paths when volume isn't guaranteed; preferred over counting big plays because it reflects weekly *deployment* |
| **Team Environment Score** | Gdula's teammate-ADP-derived expected-fantasy-points aggregate (introduced in the RB chapter) | Mild positive signal for early WRs |
| **Passing Game Score** | % of a team's ADP-implied expected fantasy points coming from QB+WR+TE (RBs excluded) | Positive for early WRs, sharply negative for late WRs (>75% score → only 4% big-beat rate) |
| **Pass-Catcher Score** | Same idea, WR+TE only — QB deliberately excluded because QB ADP is inflated by rushing value that doesn't feed his receivers | Positive early, negative middle/late; the cleanest "market's opinion of the passing attack" proxy |
| **ZAP Score** | His proprietary prospect model (from the Prospect Guide) | Middle-round *rookies* with elite ZAP smash; tiny sample, offered as tiebreaker |
| **Market Score** (Gdula) | Proprietary 0–100 blend of ADP + predictive peripherals; WR inputs: YPRR (crucial), YAC, experience, Passing Game Score, TE-specific competition, and **downfield target rate (15+ air yards)** — explicitly *not* aDOT | 90+ (2.6% of WRs; n=12 since 2014) beat expectation by +2.5 PPG with only TD-variance misses (Lamb '24, Julio '16/'17); 80+ = high floor |

Descriptive WR1 profile (top-12 by PPG, last 15 yrs): 67% had ≥25% target share, 43% ≥28%, 84% had YPRR >2.0. Worst-ever WR1 target share: Mike Evans 2021 at 16.4% — rescued by 14 TDs, i.e., the exception proves the volume rule.

## 3. HEURISTICS & RULES

**Early round (top-18 positional ADP):**
1. If N-1 PPG ≥20 (8+ games), pay up — 61% beat expectation, avg +1.2 PPG. If N-1 PPG <15 at a top-18 price, expect underperformance *unless* there's a concrete, external excuse (QB injury, not "he's talented").
2. Year-2 WRs priced top-18 are merely fine vs expectation — fade the sophomore-hype premium, especially with no situation change (McMillan) vs with one (Egbuka, post-Evans).
3. Year-5 WRs have smashed (70% of 33 beat cost) — age ~25–26 prime meets a market that hasn't repriced; by Year 6 the price catches up.
4. YPRR <2.25 without an explanation = ceiling concern; ≥2.50 = best bucket. Grant excuses only for identified causes (Higgins 1.62 with backups → 2.29 with Burrow; Jefferson's 1.88 vs a career never before under 2.50).
5. FD/RR ≥12% = best floors *and* ceilings; treat thresholds as organizing bins, not cliffs (11.8% ≠ doomed).
6. Do **not** downgrade a team's WR2 — since 2014 team-WR2s beat cost slightly *more* often than team-WR1s because they're ~15 overall picks cheaper.
7. Prefer high Passing Game / Pass-Catcher Scores — a market-believed passing attack amplifies a stud.

**Middle round (WR19–42):**
8. Chase ceiling, not floor — you haven't paid enough to care about floor.
9. High N-1 YPRR → best ceilings; FD/RR <6.5% is near-disqualifying (21 priors, one hit — JSN 2024).
10. **Flip the environment rule:** want *low* Pass-Catcher Scores and ambiguity. Sweet spot for teammates = other *middle-round* pass-catchers (no alpha above, but the offense isn't a wasteland). Early-round teammate = 6% big-beat rate.
11. N-1 target share ≥25% best across the board; <20% is a real demerit (Year-2s get partial forgiveness).
12. Rookies: only draft the ones with elite prospect scores — "don't draft rookie wide receivers simply because they're rookies."
13. Border players (WR17–19) get blended treatment — the buckets are analytic conveniences, hence Market Score as the continuous replacement.

**Late round (WR43–60):**
14. Competition is now purely bad: high Passing Game or Pass-Catcher Score → ~4% big-beat rate.
15. But target-earning history still matters (not inverted): N-1 target share ≥18% = best floor+ceiling; <13% = near-dead (4% big-beat; the 16 non-rookie late hits averaged >19% prior TS).
16. Ignore N-1 YPRR here — the low bucket actually did *better* (selection effect: volume+efficiency guys aren't priced this late).
17. Prefer high N-1 aDOT — downfield deployment = chunk/TD paths when volume is only hoped for.

## 4. 2026 CALLS (brief)

- **Elite tier:** Puka Nacua and Jaxon Smith-Njigba check nearly every player-level box (20+ PPG, 2.5+ YPRR, 12%+ FD/RR, top-8 downfield targets, 90+ Market Scores). The honest wrinkle: JSN's *environment* scores are the worst among early WRs — player elite, situation not. Chase is liked but graded good-not-elite underneath (2.26 YPRR, 13th; career-low 8.5 aDOT, lagging downfield rate).
- **Buy signals:** George Pickens (boxes + Dallas environment + Year 5), Drake London/Chris Olave (Year 5, though both carry peripheral or environment dings), Zay Flowers (2.53 YPRR + new staff, capped by Baltimore's pass volume). Fringe-18/middle: **Jaylen Waddle** (best overall mid profile + Year 6) and **Terry McLaurin** (cleared 12% FD/RR, near-25% TS) are the chapter's clearest values.
- **Fade/caution:** Year-2 prices on McMillan (1.84 YPRR, unchanged environment) and Egbuka; DJ Moore has the worst mid-round profile (1.22 YPRR / 5.7% FD/RR / 16% TS); Ladd McConkey's 6.2% FD/RR is the scariest single number at his price; Jameson Williams and Jordan Addison fail the teammate/environment screens; Makai Lemon (77 ZAP + alpha teammate) vs Jordyn Tyson (elite ZAP, softer blocker in Olave) is his rookie discrimination case.
- **Late darts:** Jerry Jeudy, Michael Pittman, Wan'Dale Robinson (volume history + open trees); aDOT darts Romeo Doubs, Ricky Pearsall, Jalen Nailor. Caution: Khalil Shakir (low aDOT + DJ Moore arriving), Matthew Golden/Jayden Higgins (sub-13% rookie TS), Isaac TeSlaa.
- **Macro:** don't assume the WR2 collapse reverses; it made the elite tier *more* valuable (top-6 WR VORP tied the 2011+ best).

## 5. UPS TRANSLATION (12-team SF, TE-premium 1.5, RB 0.8 PPR, dynasty, $300K cap July auction)

**What ports directly:**

- **His entire framework IS a "performance vs market price" engine — which is exactly our auction problem.** Replace "ADP-implied expectation" with "salary-implied expectation." We already compute ADP-implied PPG for the roast bot using the site's exact board math; the identical curve, fit to auction salaries (winning bid = salary), gives us **$/PPG expectation lines per position**, and every one of his hit-rate tables becomes a template: *given a WR's N-1 peripherals, what's the probability he outperforms a $X salary?* That's the FA-value engine's missing prior.
- **Metric mapping onto our stack:**
  - **YPRR** — we track it. Adopt his tiering: 2.5+/2.25/2.0 bands with a 200-route qualifier (mirrors our existing EPA qualified-sample gates, WR/TE ≥20 tgt).
  - **TPRR** — he doesn't name it, but his "earning the target is the battle" argument is literally TPRR's thesis. Use TPRR as the *earning* component and YPRR as earning×efficiency; when they diverge (high TPRR, low YPRR), that's his "explainable slump" archetype (bad QB play depresses yards, not targets — the Higgins case).
  - **FD/RR** — we do NOT surface this. It's cheaply computable: nflverse `receiving_first_downs` ÷ the routes we already use for TPRR/YPRR. **Concrete add: an FD/RR column in the Player Stats workbench + a 12%/8% band flag.** His claim that it beats YPRR is testable on our own data.
  - **WOPR** — his target share + downfield-target-rate pairing is the WOPR decomposition (1.5×TS + 0.7×air-yards share). Note Market Score uses **downfield target rate (15+ air yd)**, not aDOT — worth adding both; aDOT only for the cheap tier per his own usage.
  - **Separation** — no analog in his framework; it's our extra orthogonal input.
  - **Environment scores** — buildable from our multi-source ADP board: consensus ADP → implied xFP → team-level Passing Game Score (QB+WR+TE share) and Pass-Catcher Score (WR+TE). **Critical SF translation:** his reason for excluding QB ADP (rushing inflates it) is *doubled* in SuperFlex, where QB ADP is inflated by positional scarcity too — Pass-Catcher Score is the only one of the three that survives our format cleanly.
- **The tier-dependent environment flip is auction gold:** pay premium salaries only for WRs who are either (a) proven 20-PPG/2.5-YPRR self-sustainers, or (b) cheap enough that ambiguity is the asset. The squeezed middle — WR2-priced players in market-endorsed offenses — is exactly where auction overpays happen.

**What breaks and must be re-derived:**

- **All PPG thresholds are 1.0-PPR/1QB-scaled.** Our TE 1.5 / RB 0.8 scoring shifts positional baselines: re-fit the 20/15 PPG and 14-PPG-hit lines on OUR scoring history (src_weekly has it). RB 0.8 also tilts his "WR vs RB early is a coin flip" verdict further toward WR for us; SF then pushes QBs ahead of both — his cross-positional VORP conclusions don't transfer at all.
- **TE-premium changes the *fantasy* meaning of TE competition, not the on-field meaning.** A LaPorta still eats real targets from a Jameson Williams (his point stands), but in TEP the *asset-allocation* takeaway differs: heavy TE competition that suppresses a WR is often signal to buy the TE instead.
- **Dynasty vs redraft repricing:** his Year-5 edge exists because *redraft* ADP lags a prime-age breakout. Dynasty markets over-discount age even earlier — so the same finding becomes a **contender's buy window: age 25–26 WRs are at peak production while their dynasty/KTC value is already declining.** Conversely his Year-2 fade collides with dynasty's biggest premium (sophomore hype is where dynasty prices peak) — his data says that premium buys "fine, not great" production; in our auction, let someone else pay it, or pay it only on short contracts.
- **Contracts add a dimension he never models.** His one-season hit rates price a 1-year deal. For 2–3+ year contracts, chain his findings: elite persistence (20-PPG repeats) justifies multi-year at full freight for the 25-and-under stud; the Year-5 group is a *short-contract* buy (production now, cliff risk later); ambiguity darts are 1-year flyers.
- **"N-1 season" needs our data-basis rule:** our pre-season standard is prior-3-season weighted PPG + multi-source ADP (already DATA-LAYER enforced). His single-N-1-season lens is noisier; use his metrics *within* our 3-year weighting, with his own "context excuse" logic (QB injury seasons down-weighted) made explicit rather than discretionary.

**Concrete build ideas (in priority order):**

1. **FD/RR + downfield-target-rate columns** in the Stats workbench (data already in house).
2. **Team-level Pass-Catcher Score** from the ADP board's consensus, shown on the ADP tab and in Auction War Room scouting — flags which FA WRs are stud-amplified vs ambiguity plays at their expected price.
3. **A "UPS Market Score" clone:** blend our auction-value expectation (salary→PPG curve) with the peripheral stack (YPRR/TPRR/FD-RR/WOPR/separation + Pass-Catcher Score + age-curve term) into one 0–100 targets-vs-price number for the July auction board. Unlike Gdula's, ours is transparent and backtestable on our own league history.
4. **Backtest his buckets on OUR outcomes** (2014–2025 src_weekly + archived ADP sources) before trusting any threshold — especially whether FD/RR really dominates YPRR under TEP scoring.

## 6. CRITIQUES (don't treat as gospel)

- **Threshold and variable mining.** Dozens of "Metrics to Watch" × hand-picked buckets (2.25/2.50 YPRR, 12%/8% FD/RR, 18%/13% TS, 20/15 PPG) with no multiplicity control. He concedes the buckets "organize the data," then narrates them as signals anyway. The Year-5 spike (n=33) beside a Year-6 collapse is the classic overfit signature — he flags the noise possibility himself, then leads 2026 calls with it.
- **Survivorship conditioning.** The flagship persistence stat (61% of 20-PPG WRs beat expectation) is computed *after* filtering to players who played 8+ games in season N. Injury risk — the main reason paying up fails — is silently removed from the numerator of the sales pitch.
- **Circularity.** Environment scores are derived from ADP, and success is measured against ADP. The market is grading its own homework; "high-ADP players beat ADP expectations" depends entirely on the shape of the ADP→expected-points baseline curve, which is never shown. A too-flat baseline would manufacture exactly these results.
- **Discretionary excuse-granting.** Jefferson's 1.88 YPRR is excused (QB upgrade, track record); McMillan's 1.84 is not (no change). The reasoning is plausible but ad hoc — there's no rule for when context overrides the metric, which makes individual calls unfalsifiable.
- **Post-hoc rationalization of contradictions.** Late-round YPRR *inverting* is explained away as selection effect after the fact; had it confirmed, it would have been signal. Same with Year-2 forgiveness on target share ("history is more forgiving") applied selectively to players he likes (Burden) after the same cohort was faded up top.
- **Black-box dependencies.** ZAP and Market Score are proprietary; inputs are named, weights aren't, and the headline Market Score bucket is n=12. We can adopt the *architecture* (price + peripherals) without adopting the unverifiable numbers.
- **Regime extrapolation from one season.** The "death of the WR2" rests heavily on 2025; he hedges ("yes and no") but the strategic advice (elite-or-ambiguity barbell) assumes partial persistence of a one-year personnel trend. Our pace/pass-rate tracking can monitor whether it actually holds into 2026 rather than assuming it.

Source read: `/private/tmp/claude-501/-Users-keithcreelman-Code-MFL-upsmflproduction--claude-worktrees-condescending-keller-4fc8cc/213c497b-3469-4324-a0e5-1b691a06f8a6/scratchpad/lrdg/03_wr.txt` (1,727 lines, full chapter incl. the Gdula Market Score sidebar).

---

# LRDG 2026 — Tight End Section: Comprehension Report

## 1. THE AUTHOR'S LOGIC (own words)

Zachariason's TE framework rests on a two-truths tension he insists can coexist: elite tight ends are genuinely valuable, AND tight end is the easiest position in fantasy to replace. His decade of tracked waiver-wire TE streaming picks (with cohost Denny Carter) has averaged roughly TE9–TE10 PPR production without ever drafting the position — his proof that the *middle and bottom* of the position is free. But he's explicit that streaming cannot replicate *elite* seasons.

The load-bearing empirical claim: predictability at TE lives entirely in the top tier. Among the top-18 drafted TEs, positional ADP correlates meaningfully with points-per-game (R² near 47% in his 2020 example) — but isolate TE7–TE18 and the R² collapses to roughly zero. As he puts it, "The correlation isn't coming from the middle of the position." The market can price TE1–TE6; it has essentially no idea about everyone else.

From there the decision logic is pure opportunity cost, which he frames as a supply/demand problem: TE (like QB) is a "onesie" position, so its VORP lags RB/WR, and — the key wrinkle — replacement-level TEs are drafted far later than replacement-level RB/WRs (TE12 goes in double-digit rounds; RB24 goes Round 4–5). The VORP you buy with an early TE pick is stretched over many more rounds of forgone RB/WR value. So the question is never "are elite TEs good?" but "are they worth what you give up?" — and in redraft his default answer is usually no, unless the price is right.

He then splits the position into two regimes with different evaluation toolkits: elite (TE1–TE6 by ADP — a cutoff justified by the R² data and a recurring ADP cliff after six) are judged on *prior-season individual dominance*; non-elite (TE7–TE18) are judged on *opportunity and role*, because they can't command targets on talent alone — volume has to find them. What he ignores: film, athleticism scores, coaching quotes, and (mostly) age — his engine is prior-season per-route usage plus team-context target competition, with touchdown rates treated as a regression signal rather than a skill signal (with a nuance at the low end for non-elites).

## 2. METRICS & DEFINITIONS

All "N-1" metrics are the player's *previous* season. "Outperform/underperform expectation" means beating or missing the PPR points-per-game implied by draft-day ADP, with ±4 PPG as his big-hit / big-miss line (±2 PPG appears as a softer threshold). Sample window: 2014–present.

**Structural findings:**
- **Elite-season concentration:** 72 TE seasons of ≥12 PPR PPG since 2014 (min 8 games): 52 came from top-10 positional ADP, 40 from top-5. At ≥14 PPG: 36 seasons, only 7 from outside the top-10 ADP, 25 from the top five. (12 PPG ≈ last year's TE7.)
- **R² split:** top-18 TEs, ADP vs. PPG = real signal; TE7–TE18 only = ~zero most years.
- **Elite-TE historical archetype** (traits of past elite seasons): 69% had ≥20% target share; 94% had ≥10 red-zone targets; 90% had ≥5 end-zone targets; 60% had ≥15 deep-ball targets; 61% ran ≥40% of routes from the slot.

**Early-round (TE1–6 ADP) predictors, all N-1:**
- **PPR PPG:** entering off <12 PPG → 14 such TEs since 2014, zero beat expectation by 4+, ~60% underperformed.
- **Year-1/Year-2 penalty:** only five Yr-1/Yr-2 TEs drafted top-6 since 2014 (Kyle Pitts the lone rookie); all five underperformed, averaging −3.2 PPG vs. expectation.
- **Yards per route run (YPRR), min 200 routes:** of 59 qualified top-6 TEs, more than half entered off ≥2.0 YPRR; that's the healthy mark (1.80 a weaker secondary line).
- **Targets per route run (TPRR):** <22% → bad (25% of them missed by 4+ PPG); ≥26% → zero missed by 4+. He calls it every bit as predictive as YPRR.
- **First downs per route run (FD/RR):** <9% → only 6% beat expectation by 2+, none by 4+.
- **Touchdowns per game:** monotonic negative gradient — ≥0.60 TD/gm → never beat expectation by 4+; <0.40 → strongest bets; 0.40–0.60 → ugly floor outcomes.

**Non-early-round (TE7–TE18 ADP, ~Rounds 6–14) predictors:**
- **Pass-Catcher Score** (guide-wide team metric of pass-catching competition, largely ADP/market-derived): >45 → ceiling "almost completely disappears"; lower = better. Corroborated by a **Wide Receiver Score** view (market-expected WR points on the TE's team — high WR expectation → TE underperforms).
- **FD/RR:** <6% (min 200 routes) → no one has beaten expectation by 4+ PPG in the sample.
- **Slot rate:** >55% (min 200 routes) → 23 TEs, *zero* missed by 4+, and 22% beat by 4+ — his best non-elite bucket. He concedes 55% is "admittedly random" as a cutline.
- **aDOT** (min 50 targets): higher-aDOT group beat expectation by 4+ PPG four times as often as the low group. Causal story: depth → chunk plays → points, plus deep targets signal a receiver-role deployment.
- **TD/gm, three buckets:** <0.25 / 0.25–0.45 / >0.45. Middle bucket best, low second, high worst. Rationale: for non-elites, very low TD rates may reveal a lack of scoring role (TDs aren't fully random), while >0.45 ≈ an unrepeatable 8–9-TD pace the market never discounts enough.

**Market Score (Brandon Gdula's proprietary model), TE inputs:** YPRR but *nonlinearly* — it matters at the extremes (≥2.5 great, ≤1.2 bad); FD/RR; EPA per target; archetype flags (route-runners skew positive; downfield target-earners can be *over*valued; very low aDOT lacks ceiling); and team environment as a direct WR-competition input. Claimed to be trait-seeking rather than production-chasing; claimed R² gap between Market Score and ADP is larger at TE than any position; only five TE seasons ever scored 90+ (they averaged 16.5 PPG). Also runs statistical comps (Bowers 2026's top comp = McBride's 2025).

## 3. HEURISTICS & RULES

1. **Default: don't draft a TE early; stream or go late.** Waiver-level TEs return ~TE9–10 PPG; the middle of the market (TE7–18) is unpriced noise, so paying mid-round prices there buys nothing.
2. **If paying elite prices, demand the full prior-season checklist:** ≥12 PPR PPG AND ~2.0+ YPRR AND ≥22% (ideally 26%+) TPRR AND ≥9% FD/RR — misses on these have historically capped upside.
3. **Fade elite TEs coming off ≥0.60 TD/gm; prefer <0.40.** A TD-driven ADP is the least stable foundation; a talent-driven ADP (priced up without a TD spike) is the most stable.
4. **Don't pay top-6 prices for Year-1/Year-2 TEs** — 5-for-5 underperformance historically — though he grants a partial subjective pass because rookie TEs structurally can't post elite N-1 numbers.
5. **In the TE7–18 dead zone, buy role and vacuum, not last year's box score:** low team Pass-Catcher Score (weak WR competition), slot rate >55%, higher aDOT, FD/RR ≥6%, and a TD/gm between 0.25 and 0.45 (a scoring role, but not an unrepeatable one).
6. **Hard floor screens:** FD/RR <6% (non-elite) or <9% (elite) = no historical 4+ PPG overperformers — treat as near-disqualifying.
7. **Tie-breaking:** when the trend checklist is ambiguous, defer to Market Score, which is framed as a trait-and-environment model; at TE, "hitting enough checkboxes to stave off underperformance" matters more than finding one dominant trait.

## 4. 2026 CALLS (brief)

- **This year's elite tier (Bowers, McBride, Loveland, Warren) is historically weak on paper** — all four missed the 2.0 YPRR bar, none cleared 26% TPRR, and only Loveland even topped 1.80 YPRR. More uncertainty than the market has priced.
- **Bowers > McBride** at similar ADPs: Bowers checks more boxes (young, pure pass-catcher, minimal WR competition, downfield + red-zone usage; Market Score's favorite, with McBride-2025 as his comp), though his 0.40–0.60 TD bucket is a mild floor concern.
- **McBride is the flagged fade at cost:** 0.65 TD/gm (11 TDs vs. 16 combined across four college years plus his first three NFL seasons) and 32 red-zone targets — a position-high since 2016; the six prior TEs with 24+ RZ targets averaged ~14.8 the next year and none hit 20 again. Not an avoid, but a weaker profile at a late-2nd price.
- **Loveland/Warren:** miss the N-1 production screens but get a partial rookie-year pass; their ADP is talent-driven rather than TD-driven, which he prefers.
- **Mid-tier greens:** Mark Andrews, Kyle Pitts, Travis Kelce, Dalton Kincaid, Juwan Johnson (deeper: Harold Fannin, Kenyon Sadiq, Greg Dulcich, Isaiah Likely on some screens). **Mid-tier reds** (mostly WR-competition and TD-regression driven): Tucker Kraft, Sam LaPorta, George Kittle, Jake Ferguson, Dallas Goedert, Oronde Gadsden. **Late-round warnings:** Likely and Chig Okonkwo both sat below the 6% FD/RR line; Okonkwo and Ferguson have chunk-play-killing ~5.0 aDOTs.

## 5. UPS TRANSLATION (12-team SF, 1.5 PPR TE / 0.8 PPR RB, dynasty, $300K cap auction)

**The headline: his "don't pay up for TE" conclusion is the single least transferable claim in this section — but his *reason* for it transfers perfectly and actually inverts the conclusion in our league.** His anti-elite-TE stance rests on three redraft premises that all break for us:

1. **TEP re-prices every reception.** At 1.5 PPR, a 90-catch elite TE gains ~45 pts/season over standard scoring; a 40-catch streamer gains ~20. The elite-vs-replacement gap *widens* by roughly 1.5+ PPG — and simultaneously our 0.8 RB scoring shrinks the RB alternative he says you should buy instead. His own VORP logic, re-run with our scoring, points toward paying for elite TEs, not away.
2. **Our replacement level is far worse than his.** His streaming floor (TE9–10 off waivers) assumes a redraft wire. In a 12-team dynasty league with deep rosters and taxi squads, the July-auction leftovers and in-season wire are not TE9-quality. Concrete action: compute OUR empirical TE replacement level from our own historical weeklyResults (D1, back to 2010) — best freely-available TE PPG by week — and use that, not his, in any VORP math.
3. **Dynasty flips his Year-1/Year-2 penalty into a buy signal.** His 5-for-5 underperformance finding is a *one-year price* statement. In dynasty, the classic TE path is a Year-2/Year-3 leap — the moment a Loveland/Warren type finally checks his boxes is exactly when they become unaffordable. His screens tell us *when the checklist flips*, i.e., what to monitor on players we already roster cheap.

**What transfers directly, and concrete builds for our stack:**

- **The predictability asymmetry is his most valuable structural insight for an auction:** the market prices TE1–6 with real signal and TE7–18 with none. Auction implication: at the top you're paying near-fair value for forecastable production (fine in TEP, where that production is inflated); in the middle, dollar-per-point edge is available to whoever has a better model than ADP — which is precisely where our trait screens should be aimed. Our multi-source ADP board already has TEP chips; add a "market-informativeness" annotation: TE ranks 7–18 should carry wide uncertainty bands, not point estimates.
- **Elite-TE checklist as a Stats-workbench column group:** N-1 PPG, YPRR, TPRR, FD/RR, slot rate, aDOT, TD/gm buckets, target share, RZ/end-zone/deep targets. We already have receptions/targets/first downs and EPA-per-target-adjacent data via the nflverse pipeline (`nfl_player_epa`, weekly stats); routes-run is the gap — nflverse participation data covers it partially, otherwise approximate routes ≈ pass-play snaps and flag the proxy. This slots naturally next to the existing Consistency and EPA groups.
- **TD-regression flag for the FA-value engine:** trivially computable, and *amplified* in our league — TEP inflates receptions, not TDs, so a TD-dependent TE (McBride archetype) is relatively even weaker in our scoring than in his. Bucket every TE by his thresholds (elite ≥0.60 fade / non-elite 0.25–0.45 sweet spot) and surface it on auction cards.
- **Pass-Catcher Score analog:** we can approximate WR-competition per team from our own ADP board — sum the ADP-implied value of each team's WRs (we already do ADP-implied PPG for the roast bot) — and flag TEs on WR-heavy vs. WR-thin offenses. Direct input for July-auction target selection in the War Room / My Board.
- **Auction-dollar mapping:** replace his round-based opportunity-cost with explicit cap math — TEP-adjusted VORP per position (our scoring, our replacement levels) → dollars proportional to VORP share of the cap. Expect the output to say elite TE $ should sit well above his redraft guidance but still below SF QB money; the *real* UPS-specific caveat is contract structure — a 3-year deal on an elite TE is a bet his checklist stays green for 3 years, so his N-1-only framework should shade toward shorter deals on TD-spike profiles and longer deals on target-share/slot-role profiles.
- **For the live "pay up for elite TE" league debate:** the framework's honest answer is *yes in general, but be selective this year* — TEP + shallow replacement + dynasty all favor paying, while his 2026-specific finding (weakest elite-tier checklist in years; McBride a near-lock for red-zone regression) argues against paying the absolute top of market for the *wrong* elite TE this summer.

## 6. CRITIQUES

- **The elite archetype is P(trait | elite), not P(elite | trait).** "94% of elites had 10+ RZ targets" says nothing without the base rate of non-elite TEs hitting the same marks. No control group is shown; these percentages can't be used as a screener the way the prose implies.
- **Tiny samples wearing confident conclusions:** 14 sub-12-PPG elite TEs, 5 Year-1/2 TEs, 23 high-slot TEs, five 90+ Market Scores. He flags the small samples, then leans on them anyway. Several "0-for-N" claims (nobody ever beat by 4+) would flip on one counterexample.
- **Threshold mining on a single window:** cutlines like 55% slot (his own words: "admittedly random"), 22%/26% TPRR, 6%/9% FD/RR, and the TD buckets are all fit and evaluated on the same 2014–2025 data with no out-of-sample test. Multiple correlated metrics (YPRR/TPRR/FD-RR overlap, which he admits) get presented as independent confirmations.
- **Interpretive flexibility on touchdowns:** high TD rate = regression fade for elites, but low TD rate = "maybe he's just bad at scoring" for non-elites — the same statistic gets opposite causal stories depending on which bucket happened to perform. That's post-hoc narration, not a model.
- **The TE7–18 R²≈0 result is partly a range-restriction artifact:** truncating to a narrow ADP band mechanically depresses R² even if ADP carries some signal. The middle is probably *less* efficient, not perfectly uninformative.
- **"Expectation" is ADP-circular:** ADP embeds last season's stats, so "players with bad N-1 stats underperform ADP" partly measures the market's own over-anchoring — useful for finding mispricing, but not a clean talent model.
- **Streaming results are self-graded** and the "graduation" rule (drop a pick from the experiment once widely rostered) trims the record in a flattering direction.
- **Market Score is a black box with a sales incentive:** unverifiable inputs, unquantified claims (the "R² gap largest at TE" line ships without numbers), and a contributor grading his own model. Treat it as one opinion, not evidence.

Source file: /private/tmp/claude-501/-Users-keithcreelman-Code-MFL-upsmflproduction--claude-worktrees-condescending-keller-4fc8cc/213c497b-3469-4324-a0e5-1b691a06f8a6/scratchpad/lrdg/04_te.txt

---

# LRDG 2026 — Part Four: Player Selection (Targets / Avoids / Darts / Cheat Sheets)

## 1. THE AUTHOR'S LOGIC

Zachariason is explicit that this section is not a talent-ranking exercise — it's a **mispricing report**. Every recommendation is a delta between his projection process and the market's ADP, so a player's status as target or avoid is a function of price, not quality ("almost anyone can become a value" if the market lets him fall). He calls the section "the cotton candy" of the guide — the fun output, not the substance — and warns readers not to judge the guide by whether individual takes hit, because variance dominates single-player outcomes.

The reasoning framework underneath every blurb is the same four-step chain:

1. **Establish the market price** (aggregate ADP, with per-platform callouts because there is no single consensus — a player can be a target on ESPN and fairly priced on Sleeper).
2. **Check the underlying opportunity/efficiency signals** — route share, target share, yards per route run (YPRR), RB rush share — which he trusts far more than box-score points, because points are contaminated by touchdown luck and offense-wide volume.
3. **Run the historical cohort** — find every player since ~2011/2014 who matched the same statistical fingerprint at the same ADP range, and see whether that cohort beat or missed ADP expectation. This is his signature move: he never argues a player take from scouting alone; he argues "players who looked like this at this price historically returned X."
4. **Cross-check against Market Score** (his comps-based model) and stated coaching/scheme changes, then assign a 1–10 Confidence Level based on how many of those independent signals agree.

What he optimizes for shifts by draft stage — an explicit risk gradient: early rounds balance floor and ceiling; middle rounds tilt to ceiling ("I'm not drafting to finish fourth. I'm drafting to win my league"); late rounds are pure fence-swings where "we don't care about floor anymore" because a bust costs only a bench spot. What he ignores: raw yards-per-carry and season point totals without context, offseason hype, coach-speak (unless it converges with depth-chart math), and the temptation to fade cheap players (he refuses to write avoids for late-rounders — the investment is too small to matter).

The causal chains he trusts most: workload → Year-2 RB success (not efficiency); per-route efficiency + route-share growth → WR breakout; team pass-volume regression to the mean → WR volume; touchdown-rate regression → QB/RB decline; rushing production → QB floor; coaching-scheme tendencies (motion rate, RB target share, TE target funneling, plays per game) → positional opportunity.

## 2. METRICS & DEFINITIONS

- **Confidence Level (1–10)** — new this year; a per-blurb conviction score. 10 = rankings, Market Score, and his own draft behavior all agree; ~1 = "keep an eye on him." Not a projection — a measure of signal convergence.
- **Market Score** — his single-number model output distilling "dozens of inputs" into roughly a projection, anchored to historical player comparables ("comps") with similarity scores. Used both as a projection (top-10 comps' average PPG) and as a ceiling/floor illustrator (individual comp seasons). Explicitly ADP-sensitive — it moves as ADP moves, and he acknowledges it misses context like injuries (Mahomes) and range-of-outcomes width (Watson).
- **ZAP Model / ZAP score** — his prospect model. Draft capital is "the most important input"; college inputs cited include adjusted receiving yards per team pass attempt, best-season reception share, avoided tackles per attempt, adjusted total yards per team play (all expressed as percentiles). **Draft Capital Delta** — a ZAP output flagging when the model rated a prospect better than his actual draft slot ("low-risk" = model liked him more than the NFL did).
- **ADP expectation** — the historical average PPG produced by players drafted at a given positional ADP slot (e.g., RB35–45 has averaged ~9.1 PPR PPG; WR50 ~9.3). Over/under-performance is always measured against this baseline, not against raw points.
- **Yards per route run (YPRR)** — his core WR/TE/RB-receiving efficiency stat. Working thresholds that recur: ≥2.0 = genuinely efficient WR; <1.5 = red flag for a mid-priced WR; <0.80 (RB) = pass-game nonentity; <0.50 (RB) = near-disqualifying (only 2 of 10 such top-50 RBs beat ADP).
- **Targets per route run (TPRR)** — target on >24% of routes ≈ elite-receiver territory.
- **Route share** — % of team dropbacks on which a player ran a route; his playing-time denominator (slot-only usage suppresses it; ~80% = full-time).
- **Target share** — 25%+ two years running = elite target earner even at a cheap ADP; <20% + <1.5 YPRR = the toxic combo for mid-round WRs.
- **RB rush share** — % of team RB carries; 80%+ as a rookie is near-unique (Jeanty/Barkley); ~65% still feature-back territory.
- **Rushing fantasy points per game (QBs)** — the floor metric; ≥5.0 = elite floor (Hurts), <2.0 = fully dependent on passing TDs.
- **Touchdown rate (QB)** — TD% of attempts; ≥6% without rushing = regression flag; ≥7% without rushing = near-automatic fade.
- **Expected touchdowns / xTD** — TD total vs. opportunity-based expectation (Taylor +3–4 over; Irving's xTD of 2; McBride's 11 vs 12 expected = "earned").
- **Pass rate over expectation (PROE)** — team pass-heaviness vs. situation-neutral expectation; used to characterize offense-level volume ceilings (Ravens < −7%; Canales −6.1%/−2.2%).
- **Team Environment Score** — team-quality composite; the RB-specific threshold is <75 = danger zone for top-10 ADP RBs.
- **End-zone targets (TE)** — ≥15 in a season is historically rare (12 TE seasons since 2011); McBride's 19 = unsustainable usage.
- **Supporting cast**: NGS pressure rate, rush yards over expected (RYOE), EPA per rush/play, success rate, yards before/after contact, 10+ yard run rate, 20+ mph runs, aDOT, slot rate, fantasy points per route run, plays per game, pre-snap motion rate.
- **Auction values (cheat sheet)** — purely formulaic, derived from the historical-ADP-curve charts earlier in the guide; calibrated to $200 budget, 1QB/2RB/3WR/1TE/1FLX + 6 bench; tier-mates get similar dollars; explicitly "just estimates."

## 3. HEURISTICS & RULES

**QB rules**
- Target rushing floors: a QB who has never averaged <4.7–5.0 rushing FP/G has a floor no pocket passer can match; price dips after a down year are buying windows (Hurts, Murray).
- Fade TD-rate-dependent pocket QBs: since 2014, top-10-ADP QBs coming off <2 rushing FP/G + ≥6% TD rate — only 4 of 12 beat ADP, averaging ~2 standard FP/G below expectation (Burrow). The extreme version (≥7% TD rate + <5 rushing FP/G): all 13 went top-10 ADP next year, then averaged just 18.0 FP/G — "streamer territory" (Stafford).
- A one-year rushing-points spike from a non-runner, especially post-injury, is a sell (Mahomes).

**RB rules**
- Year-2 RBs: workload predicts, efficiency doesn't. Bad YPC behind a bottom-tier line is noise (Jeanty, Tuten); rush share + target share are the signal. Sophomore RBs drafted as RB1s: 24 since 2011 averaged 17.2 PPR PPG; the 7 with Market Score >80 averaged 19.9.
- Pass-catching is the RB differentiator outside round 1: RBs earn fantasy money via TDs + receptions, so target share ≥13–14% and strong YPRR make the target (Brown, Skattebo, White, Warren); YPRR <0.80 trending down (Pollard) or <0.50 (Dobbins) makes the avoid regardless of rush volume.
- Ambiguous backfields are opportunities, not warnings, when your guy has the receiving edge — bet the most route-efficient back in the committee (Warren over Dowdle; White over Croskey-Merritt/Allen).
- RB35–45 ADP is a dead zone (~9.1 PPR PPG historical) — so swing for fences there; a zero costs you nothing (Brooks).
- Injury-discount arithmetic: ask "where would he go healthy?" — if ≥1 round higher, the discount is the edge (Skattebo).
- Top-10 ADP RB + Team Environment Score <75: only 3 of 14 beat ADP since 2014, ~2 PPG under (Achane).
- Goal-line role stripped + last in RYOE + new receiving competition = fade even when per-route numbers are good (Irving).
- Late-round RB darts need: ambiguity + explosive-play ability (10+yd run rate, 20mph runs) and ideally a receiving profile (Mason, Mitchell, Coleman); Day-3 rookies hit only when the depth chart is less settled than assumed (Singleton).

**WR rules**
- The efficiency-without-volume screen (his best pattern): WR19–42 ADP coming off <12 PPR PPG but ≥2.0 YPRR on 200+ routes → 7 qualifying follow-ups averaged +1.2 PPG vs ADP (Washington, McLaurin, Burden all qualify this year).
- The inverse screen: WR13–36 ADP coming off <1.5 YPRR AND <20% target share → 18 such players underperformed by ~2 PPG; only 3 beat by >1 (Moore, and effectively Sutton/Metcalf).
- Elite rookie WRs at mid-round prices: WR19–42 rookies with ZAP >90 since 2014 — 9 players, 14.2 PPR PPG, only two ADP misses (Tyson).
- Team pass-volume mean-reversion: every team since 2011 that finished under 27 attempts/game threw more the next year (+5.5 avg) — buy the efficient WR trapped in it (Flowers).
- Slot-only deployment caps route share, which caps fantasy output even for efficient players — target only when the price assumes the old role AND a plausible role-expansion path exists (Reed, Downs); cheap target-earners are underdrafted: 25%+ target share + ≥1.75 YPRR at WR40+ ADP historically beat by ~1 PPG (Robinson).
- "Perception outpaced production": a WR drafted top-20 every year who has never hit 2.0 YPRR or beaten expected PPG is a persistent avoid (Wilson); breakouts built on a backup-QB/teammate-injury window don't project forward (Michael Wilson, the "Jerry Jeudy pattern").
- In a crowded good offense, buy the cheapest pass-catcher with the elite per-route rookie season rather than the ones priced for the outcome (Burden vs Odunze/Loveland).

**TE rules**
- Pay up for a TE only in shallow leagues (opportunity cost shrinks) or for a genuinely separating target share ceiling (Bowers + a Kubiak scheme that funnels TE targets).
- Decompose an elite TE season into per-route efficiency × route volume before paying for it — McBride's edge was ~120 extra routes (~3 PPG) from a league-leading pass-volume offense plus 19 end-zone targets; both are unsustainable inputs.
- Non-elite TE darts: open depth chart + slot rate >40% (better >55%) + prior YPRR flashes (Okonkwo, Likely); micro-cohort — TEs outside top-12 ADP off ≥2.0 YPRR on 100–300 routes: 3 of 5 beat ADP by ≥3.9 PPG (Dulcich).

**Meta-rules**
- Cost is always the argument: a "target" is a price, so a target can become an avoid by August purely via ADP movement — the sections update weekly.
- Never fade cheap: no avoids are written past the middle rounds.
- Confidence Level = signal convergence, not conviction theater; blurb context (which platform, which price) is load-bearing.

## 4. 2026 CALLS (brief)

- **QB**: buy the rushing-floor bounce-backs at depressed prices — Hurts (Patullo gone, ~5 rushing FP/G floor, market QB7 vs model QB2-3), Herbert (McDaniel scheme + healthy O-line, ESPN QB14), Murray as the premium dart (O'Connell TD-rate lift + Jefferson). Fade the TD-rate pocket passers: Stafford (7.7% TD rate, no legs — his highest-confidence avoid at 8), Burrow (QB4 price for a floor play in a dual-threat-rich year), Mahomes (rushing spike + injury).
- **RB**: Jeanty as a Market Score RB4 workload bet; Warren (CL 7) as the efficiency-monster half of an ambiguous backfield under a checkdown-heavy Rodgers; Brooks as the RB40 fence-swing. Fade Achane's environment at RB5-6, Irving's vaporized goal-line role (CL 7), Pollard's eroding receiving work (CL 7), Dobbins's 0.32 YPRR (CL 7). Taylor is a tier-drop, not a fade (TD + team-quality regression, no receiving cushion).
- **WR**: Flowers is the flagship call (CL 9 — elite YPRR/TPRR trapped in a historically low-volume Ravens pass offense that history says must throw more); McLaurin (CL 8, career-best per-route year at 30 + a "get Terry 10 targets" staff); Waddle in Denver, Burden as the Round-4 ceiling pick. Fades: Sutton (CL 9 — max routes, mediocre YPRR, ninth season, Waddle arrives), Metcalf (CL 8 — never a volume earner, Rodgers's shrinking aDOT), Michael Wilson (CL 8 — injury-window mirage).
- **TE**: Bowers over McBride — the market prices them as interchangeable; he sees a full gap (McBride's route-volume + end-zone-target inputs regress; Bowers gets a Kubiak TE funnel). Kincaid as the cheap efficiency bet (2.79 YPRR, top since-2011 company, priced at his floor).
- **Darts**: Willis is the CL-10 "easiest click" (pure rushing + ambiguity bet at QB20+); Shough (Kellen Moore pace + Tyson arrival); Mason/Mitchell/Coleman as explosive-run RB stashes; Robinson and Coker as proven target-earners at WR45+ prices; Dulcich as the free-square TE.

## 5. UPS TRANSLATION

**What transfers directly**
- **The core stance — every take is price-relative — IS our auction problem.** His "target = underpriced vs ADP" maps 1:1 to "bid above our fair-value number when our signals disagree with the market's." The July slow FA auction is literally an ADP-vs-value exercise where the winning bid becomes the salary — his framework is more native to our format than to snake drafts.
- **The cohort-screen method is directly reproducible on our stack.** We have D1 + the xFP suite + `src_weekly` + `nfl_player_epa` + consistency/boom-bust + the multi-source ADP board. Concrete build: a "cohort screener" that, for any FA-auction candidate, computes his statistical fingerprint (YPRR proxy, target share, rush share, TD-over-expected, age/season-N) and returns the historical hit rate of same-fingerprint players at the same market price. That's his entire method, automated. Several of his screens are computable today: TD-rate regression (we have TD and attempt data), target share and route-share proxies (weekly usage), xTD vs actual (xFP suite), team pass-volume mean reversion (games.csv + PROE from our pace/PBP ETL).
- **Confidence Level = signal-convergence scoring.** Adopt it for the Auction War Room My Board: a target's conviction score should be a count of independent agreeing signals (our value model, ADP-consensus gap, cohort hit rate, role trend), not a gut number.
- **Per-platform ADP divergence ≈ our per-source divergence.** His "great on ESPN, fair on Sleeper" logic maps onto our FantasyCalc/KTC/DynastyProcess/Sleeper/FantasyPros spread: a wide inter-source spread is itself a signal of an unsettled price — those are exactly the players where a prepared bidder has edge in a slow auction (and where our board's consensus should be trusted least).
- **The risk gradient by draft stage → risk gradient by salary tier.** Early rounds = our $40K+ bids (floor matters, opportunity cost real); middle rounds = $10–35K (buy ceiling); late rounds = $1–5K flyers (pure fence-swings, "an open bench spot" ≈ a cuttable $1K contract or taxi stash). His "never fade cheap players" translates to: don't burn analysis or bid discipline on sub-$5K contracts — the cut penalty math ((TCV×75%)−Earned) at those sizes is trivial.

**What must be translated, not copied**
- **1QB → Superflex inverts the QB sections.** His QB avoids are avoids at 1QB prices. In SF, QB scarcity means Burrow at "QB4 price" is a completely different proposition — the floor he dismisses as "streamer territory" (18 FP/G) is a startable SF asset. Keep the *mechanism* (rushing floor > TD-rate dependence, TD-rate regression is real) but re-price everything: rushing-floor QBs are even MORE valuable in SF (two QB slots amplify the floor edge), and his QB darts (Willis, Shough, Murray) are far more valuable to us than to him. The Stafford/Burrow fades become "pay for them like regression is coming," not "don't roster."
- **TE-premium (1.5 PPR) re-weights the TE logic.** His "opportunity cost of paying up for a TE" argument weakens for us: TEP compresses the gap cost and widens the elite-TE edge. His TE decomposition (per-route efficiency × route volume × end-zone usage) is the transferable part — run it with our 1.5-PPR scoring, where Kincaid-style per-route monsters gain more from a role expansion than in his format. Conversely 0.8 RB PPR *dampens* his single biggest RB signal (pass-catching as the differentiator) — RB receiving still matters for us but ~20% less than his PPR cohorts imply; re-fit his RB-receiving thresholds against our scoring before adopting them.
- **Redraft horizon → dynasty horizon.** His entire frame is one-season ADP-beating. For us: (a) age cliffs and Year-N breakout windows (his "Year 6 WR breakout," "Year 2 RB") become *contract-length* questions — a Year-2 RB workload bet justifies a 3-year deal; a 29-year-old Pollard-type fade justifies at most 1 year; (b) "avoid" rarely means avoid in dynasty — it means shorten the contract and cap the bid; (c) his rookie screens (ZAP>90 mid-round WRs, Draft Capital Delta) are *more* valuable in dynasty than redraft and mesh with our existing rookie-ADP-implied-PPG machinery.
- **His auction-values appendix is nearly useless to us as numbers** ($200/1QB/half-PPR/6-bench vs our $300K/SF/TEP/18-starter/IDP world) but the *method* is the right one and matches what we already believe: derive dollar values from the historical price-vs-return curve of our own league (we have 14 years of archived auction transactions in `ups_auction_intel` / `transactions_auction`), not from projections alone. Concrete idea: fit our own "ADP-slot expectation curve" (PPG by historical UPS auction price bucket, by position) — that's his "ADP expectation" baseline rebuilt for our economy, and it becomes the yardstick for "targets vs ADP" on the My Board.
- **Weekly ADP re-check.** His sections update every Friday because price is the argument. Our slow auction runs for weeks in July — the same discipline applies: a target at $8K asking is an avoid at $20K of bidding. The War Room target planner should re-evaluate value-vs-current-high-bid continuously, not freeze a pre-auction board.
- **IDP is out of scope** — nothing here covers our 5 IDP starters; his framework (role/opportunity screens over box-score points) would translate (snap share, pass-rush win rates) but we'd be building it from scratch.

**Concrete backlog candidates for our analytics**
1. Cohort screener API: fingerprint → historical same-profile-at-same-price hit rate (uses `src_weekly`, xFP, ADP board history).
2. UPS price-expectation curve: PPG-by-auction-price-bucket from our archived auctions → the baseline for over/under-performance and for formulaic opening bid values.
3. Signal-convergence "Confidence" column on the War Room My Board (value-model gap + ADP-source spread + cohort hit rate + role trend).
4. TD-over-expected and team-PROE regression flags surfaced on the Stats workbench (both computable from existing ETLs) — his two most falsifiable, most mechanical screens.
5. ADP-source-spread alert: flag players where our 5+ sources disagree most; those are the auction's exploitable prices.

## 6. CRITIQUES

- **Tiny, survivorship-prone cohorts stated with false precision.** Many screens rest on n=5–14 ("3 of 5 TEs beat ADP by 3.9+ PPG," "13 QBs since 2014," "9 ZAP>90 rookies"). With samples that small, one player flips the conclusion, and the thresholds (2.0 YPRR, 6% TD rate, 200 routes, WR19–42) look suspiciously tuned to make this year's names qualify. There's no out-of-sample testing and no multiplicity control — he runs dozens of screens and reports the ones that produced clean stories. Treat every cohort stat as a hypothesis, not a base rate; re-derive on full data before trusting a threshold.
- **Selective invocation of his own model.** Market Score is authoritative when it agrees (Jeanty, Flowers, Stafford) and hand-waved when it doesn't ("Market Score isn't as bullish as I am... sometimes it's OK to keep things simple" — McLaurin; "what the score doesn't capture is range of outcomes" — Watson; "it doesn't have the injury context" — Mahomes). That's an unfalsifiable pattern: the model is evidence only when convenient. His Confidence Level partially self-polices this, but the override criteria are never specified.
- **Comp-based ceiling arguments cherry-pick the numerator.** "Half of his top-10 comps scored 20+ PPG" and "his comp is Tee Higgins' 19 PPG in relevant weeks" quietly drop the other comps and lean on "relevant games" filtering (excluding bad weeks post hoc inflates every comp's PPG). The comp machinery is never shown, so similarity is unauditable.
- **Coaching-change narratives are asymmetric.** New OC = upside for targets (Kubiak→Bowers, Doyle→Flowers, McDaniel→everything Chargers) but risk for avoids (McDaniel leaving→Achane) — the same event class is read in whichever direction supports the take. Coach-tendency stats (motion rate, TE target share) have real signal but n=2–4 seasons per coach.
- **Hedged fades are unfalsifiable.** Several avoids come pre-excused ("this isn't a full fade," "there are leagues where I will draft him," Confidence 1–3). Combined with weekly updates, almost any outcome can be reconciled after the fact. The honest defense — it's a price take, so ADP movement legitimately changes the call — is also what makes the takes hard to score.
- **He half-admits the biggest one himself**: last year's lead target (Hurts) missed, and he opens by saying don't judge the guide on these picks. Correct epistemics — but it means the transferable value is the *screens and the pricing discipline*, not the names. For UPS use: adopt the method, re-fit every threshold on our own data and scoring, and score his 2026 calls next spring as a calibration exercise before weighting his future guides.