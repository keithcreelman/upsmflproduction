# Hayden Winks — Analytical Methodology Memo

*Compiled 2026-04-28 for the UPS MFL rookie hit-rate / extension-worthiness project. Focuses on methodology, not 2026 player takes. Sources at the bottom; quotes lifted from public Underdog/NBC/Twitter content.*

Hayden Winks (@HaydenWinks) is the lead NFL Draft / dynasty fantasy analyst at Underdog Fantasy and co-host of *Fantasy Football with Josh & Hayden* (with Josh Norris). He came up at Rotoworld / NBC Sports Edge through 2021 publishing position-specific draft models, then moved to Underdog where his work spans a free Top 100 NFL Draft Big Board, a post-draft rookie rankings article, and roughly weekly podcast appearances. He is on the same data-first axis as JJ Zachariason but lands the weights differently: Winks' model is *more* film/draft-capital weighted and *less* market-share weighted than JJ's ZAP. Where JJ's prior is "draft capital, deviated by college production share," Winks' prior is closer to "scouting grade, deviated by EPA/efficiency at the position."

---

## Core Principles

- **Three-input draft model — capital, production, athleticism — with position-specific weighting.** Winks publishes percentile scores ("100th percentile prospect," "95-97th percentile WR prospect") that come out of position-tuned models. The inputs are consistent across positions but the weights are not.
- **Percentiles benchmark to drafted players since 2005.** "All numbers are percentiles among drafted players since 2005, so 0.50 would mean average for drafted FCS quarterbacks." This is a different normalization from JJ's ZAP (which is z-scored against the same prospect *class*). Winks' 100th-percentile call is a *historical-class* statement, not a within-cohort statement.
- **Production is age- and team-adjusted, not raw.** Like JJ. But Winks names it differently — "Production" as a labeled input — and includes schedule strength explicitly as an adjustment, where JJ folds it into share metrics that already normalize.
- **Two-pass workflow: model first, film second.** Public quote: *"My rookie process is two-fold: first, I put all the players through my NFL Draft models to have an analytics anchor, and then I watch everyone to look for the context my models are missing and for the exact role each prospect fits at the next level."* This is the load-bearing methodological difference vs JJ — Winks publishes per-prospect tape notes alongside model output, JJ publishes the model output and a comp.
- **Adjusted SPARQ, not RAS.** Winks' athleticism input is Adjusted SPARQ (a composite that down-weights 40 time and weights explosion + agility more aggressively than RAS). The widespread JJ-stated read that Winks is "RAS-heavy" is *directionally right but technically wrong*: Winks weights athleticism more than JJ does, but his composite is SPARQ-derived, not RAS-derived. The practical implication is the same — combine performances move his prospects more than they move JJ's.

---

## Position-Specific Weights

| Position | Capital | Production | Athleticism | Notes |
|---|---|---|---|---|
| **QB** | High | Highest (EPA/play, age-adjusted) | Low (rushing only) | Production is "the foundation of the entire model"; schedule strength is explicit. |
| **RB** | Highest | Mid (team/age-adjusted) | Low ("just a minor role") | Most capital-deferential of the four positions — closest to JJ's RB read. |
| **WR** | Mid | Highest (share, age, schedule) | Mid (Adjusted SPARQ) | "Modeling receivers has had the best results." Closest position-fit to JJ's ZAP. |
| **TE** | High | High | Higher than WR | Size + athleticism matter more here than at WR. *Diverges from JJ's TE finding* that less-athletic TEs with capital outperform athletic TEs with capital. |

**Where this lands him vs JJ:**
- **WR:** Roughly converged with JJ. Both heavily value share + age + capital.
- **RB:** Slightly less capital-rigid than JJ. Winks will rank a Day-3 RB with elite athleticism+production into his rookie top-10 (e.g. Cam Skattebo 2025); JJ's ZAP almost never does.
- **TE:** Materially different. JJ's 2025 TE model finds athleticism *negatively* interacts with capital; Winks weights athleticism positively at TE. They will disagree on TEs drafted in the R2-R3 range with poor combine numbers.
- **QB:** Both rushing-equity believers, but Winks' model is more EPA/efficiency-driven and JJ is more "any rushing equity at all is undervalued." Practical effect: Winks will fade a high-rush college QB with poor passing efficiency (Jalen Milroe-type) more than JJ will.

---

## Hit Rate / Calibration

Winks does not publish a single "hit rate" number, but the percentile framework implies one:

- **100th-percentile RB** (his term, applied to Saquon, McCaffrey, Gurley, Bijan, Jeanty, and now Jeremiyah Love in 2026) is meant to read as "every prospect in this bucket has hit." The 2026 Love callout is a deliberate calibration anchor: he is putting Love into the same bucket as Saquon and McCaffrey, knowing the read.
- **95th-97th percentile WR** (Jordyn Tyson 2026, Tetairoa McMillan 2025) is the next tier — these are "very likely to hit" but not "every comp hit." This is also the band where his calls and JJ's tend to converge.
- He explicitly stratifies post-hoc: rookie classes get re-graded the following spring on his podcast ("watching all of the 2024 class as rookies for the podcast"), and he revises model weights in the offseason based on what missed.

The published-pricing implication: a 100th-percentile prospect at Winks' RB tier should be priced like a top-3 dynasty asset; a 95th-percentile WR like a top-12 dynasty asset. He does not publish an explicit asset-cost curve, but his rankings imply one.

---

## Where Winks Disagrees Most With JJ

Three repeated patterns from 2024-2026 cohorts:

1. **Athletic TE with R2-R3 capital.** Winks ranks higher; JJ ranks lower. Cleanest 2024 example: **Theo Johnson** and **Tip Reiman** — JJ's ZAP had Reiman at TE3 (counterintuitive, athleticism-deflated case) while Winks ranked Johnson higher. JJ's 2025 TE writeup explicitly says athleticism *negatively* interacts with capital; Winks' TE model says it interacts *positively*. This is the cleanest methodological disagreement in their public output.

2. **Day-3 athletic RB.** Winks ranks higher; JJ ranks lower. Cleanest 2025 example: **Cam Skattebo** — Winks had him as RB7 rookie / a top-10 dynasty pick; JJ's ZAP slotted him several tiers lower because of Day-3 capital and the RB-capital prior. Skattebo hit, which is one data point in Winks' favor for that disagreement type.

3. **Late-breakout / older WR with elite athleticism.** Winks ranks higher; JJ ranks lower. 2026 example: **De'Zhaun Stribling** — 23.5-year-old late breakout with NFL-ready athleticism, "87th percentile hands." Winks ranks WR69 overall (rookie WR7-8); JJ's age-adjusted production model penalizes him heavily for breakout age. JJ wins this disagreement type historically — late-breakout WRs hit at lower rates than the athletic profile suggests.

**One reverse case:** Winks is occasionally *lower* on a JJ darling when the tape disagrees with the share metrics. 2026 example: **Kenyon Sadiq** (TE) — Winks calls him "overrated" with mediocre 40-YPG production despite R1 capital; JJ's model is friendlier because the team-adjusted dominator is acceptable. This is the failure mode of Winks' two-pass workflow: tape can override model, and tape grades drift.

---

## Quotables

> *"My rookie process is two-fold: first, I put all the players through my NFL Draft models to have an analytics anchor, and then I watch everyone to look for the context my models are missing and for the exact role each prospect fits at the next level."* — Hayden Winks, Underdog 2024 rookie rankings intro

> *"All numbers are percentiles among drafted players since 2005, so 0.50 would mean average for drafted FCS quarterbacks."* — NBC Sports / Rotoworld 2021 draft model writeup, methodology footnote

> *"100th percentile prospect alongside Saquon Barkley, Ezekiel Elliott, Christian McCaffrey, Reggie Bush, Melvin Gordon, Ashton Jeanty, Darren McFadden, Bijan Robinson, Todd Gurley, Adrian Peterson, and Jonathan Taylor."* — Winks on Jeremiyah Love, 2026 post-draft rankings (calibration anchor: he names the 11 prior 100th-percentile RBs to make the bucket explicit)

> *"For wide receivers, modeling receivers has had the best results."* — 2021 model methodology

---

## Sources

- [2026 Fantasy Football Rankings — Hayden Winks (Underdog)](https://underdognetwork.com/football/fantasy-rankings/2026-fantasy-football-rankings)
- [Fantasy Football Rankings For The 2026 NFL Draft Class (Underdog)](https://underdognetwork.com/football/fantasy-rankings/fantasy-football-rankings-for-the-2026-nfl-draft-class)
- [2025 Fantasy Football Rankings After The NFL Draft (Underdog)](https://underdognetwork.com/football/fantasy-rankings/2025-fantasy-football-rankings-after-the-nfl-draft)
- [2025 NFL Draft Top 100 Prospects — Hayden Winks Final Rankings (Underdog)](https://underdognetwork.com/football/nfl-draft/2025-nfl-draft-top-100-prospects-hayden-winks-final-rankings)
- [2024 Fantasy Football Rankings - Final Update (Underdog)](https://underdognetwork.com/football/fantasy-rankings/2024-fantasy-football-rankings-final-update)
- [2024 NFL Draft Big Board — Hayden Winks' Top 100 (Underdog)](https://underdognetwork.com/football/nfl-draft/2024-nfl-draft-big-board-hayden-winks-top-100)
- [Winks' 2021 QB, RB, WR, TE Draft Models — NBC Sports (methodology footnote)](https://www.nbcsports.com/fantasy/football/news/article-fantasy-usage-model-winks-2021-qb-rb-wr-te-draft-models)
- [@HaydenWinks on X](https://x.com/HaydenWinks)
- [Top 36 Rookie Rankings — 2025 Dynasty (Fantasy Football with Josh & Hayden, Apr 28 2025)](https://podcasts.apple.com/us/podcast/top-36-rookie-rankings-for-dynasty-drafts/id1558961587?i=1000654176154)
- [Top 36 Rookie Rankings — 2026 Dynasty (YouTube)](https://www.youtube.com/watch?v=rMNA7u8hcy0)

---

## Methodology Caveats / Open Questions

- **2024 cohort coverage is partial.** Winks' "2024 Fantasy Football Rankings - Final Update" article integrates rookies into the overall fantasy ranking (rookie + vet) rather than publishing a stand-alone rookie-only ranking like JJ's ZAP CSV. Our `winks_2024.csv` reconstructs rookie-only ordering from his overall ranks. This is a faithful translation but means rookie #N for Winks isn't necessarily comparable to ZAP rookie #N — Winks' #1 RB is the rookie he ranks highest within his overall fantasy list, not within a rookie-class z-score normalization.
- **Tier labels are reconstructed.** Winks doesn't publish "Tier 1 / Tier 2" labels the way JJ does. We bucketed by his prose ("Generational" / "Elite" / "Tier1-4") for cross-source compatibility with the meta-model spec. Treat tier labels as our derivation, not as Winks' direct output.
- **Percentile vs rank normalization.** Where Winks gave an explicit percentile in prose ("95th percentile QB," "92nd percentile production profile"), we used that as model_score. Where he didn't, we converted rookie-only rank to a 100-point linear scale within the position cohort. The 2026 Tate-vs-Tyson case highlights why this matters: Tyson's percentile (96) is higher than Tate's (92) but Winks ranks Tate ahead of Tyson — situational/injury adjustments outside the model.
- **No public hit-rate ledger.** Unlike JJ's "4.4% vs 11.1%" RB/WR Round 4-5 league-winner finding, Winks does not publish historical model hit rates as a single number. The percentile-anchored claim ("100th percentile RBs all hit") is the closest he comes.
