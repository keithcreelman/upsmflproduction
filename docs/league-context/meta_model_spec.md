# Meta-Model Architecture Spec — JJ + Koalaty Rookie Synthesis

*Architectural spec, not implementation. Review and approve before code lands.*

## What we're building

A **single deliverable**: a synthesized rookie evaluation framework that consumes JJ Zachariason's ZAP scores and Joseph Bryan's (Koalaty) model percentiles as inputs, calibrates the blend against the 2024 cohort (which now has Y1 NFL data), and produces a 2026 rookie buy list with cross-model agreement flags, bootstrap CIs, and UPS-slot mispricing context.

**The 2024 guide is the calibration key.** 2024 rookies completed their first NFL season in 2024. We can grade both analysts' 2024 prospect scores against actual Y1 production *right now*, find the empirically optimal blend weights, then apply that calibrated synthesis to the 2026 class for forward-looking buy decisions.

## What this is NOT

- **Not a veteran extend/trade tool.** Rookie draft only.
- **Not an auction $/pt model.** That's a separate veteran-pricing problem.
- **Not a from-scratch prospect model.** The whole point is using their published outputs as inputs.
- **Not a QB model.** Neither analyst has shipped one.
- **Not film-based.** Numbers + capital + production residuals only.
- **Not a multi-year DP.** Annual refit at most.
- **Not a retroactive recompute of our 2017–2022 cohort.** That work is done.

## Three deliverables (all rookie-draft-scoped)

### 1. **Calibration retrospective on the 2024 class**

Lookback: pull JJ's 2024 PostDraft ZAP scores, Koalaty's 2024 model percentiles, and actual 2024 NFL Y1 fantasy production. Grade both, compute calibration plot per tier, derive the empirical blend weight that minimizes prediction error, and document where each model whiffed and why.

Output: `docs/league-context/2024_calibration_retrospective.md` — calibration plots, tier-realized hit rates, named misses (per model), final blend weights for the 2026 build.

### 2. **2026 Rookie Buy List**

The May 24 deliverable. Per prospect (RB / WR / TE):
- Consensus tier (Legendary Performer / Elite Producer / Weekly Starter / Flex Play / Benchwarmer / Waiver Wire Add / Dart Throw — JJ's ZAP 2.0 naming)
- **Cross-model agreement flag** — when JJ and Koalaty agree on tier, signal is high; when they disagree by 2+ tiers, that's the actually-decision-relevant case worth investigating
- **NFL Draft Capital Delta** (low / neutral / high risk) per JJ's framing
- **Bootstrap confidence interval** on the consensus E[B2S] estimate (neither analyst publishes per-prospect CIs)
- **UPS-slot mispricing**: at the prospect's expected UPS rookie-draft slot, is the consensus estimate above or below the slot's historical hit-rate from `rookie_hit_rate_matrix.json`?

Output: `docs/league-context/2026_rookie_buy_list.md` and `site/rookies/2026_meta_prospects.json`.

### 3. **2026 pre-registration for future calibration**

Before NFL Week 1 2026, lock the predicted outcome distribution at confidence levels (e.g., "Tier A: 5 names at 70% confidence; Tier B: 8 names at 50%"). Adopt JJ's miss-attribution discipline: when 2026 cohort matures, grade the realized distribution against the pre-registration and document what whiffed, why, and the methodology fix.

Output: `docs/league-context/2026_predictions_locked.md` (write-once, grade later).

## Inputs and sources

| Input | Source | Effort |
|---|---|---|
| **JJ 2024 ZAP scores + tiers + DCD** | `LateRoundProspectGuide24_PostDraftV2 2.pdf` (have) | Manual parse — I read specific pages and extract to CSV. ~30 min. |
| **JJ 2026 ZAP scores + tiers + DCD** | `LateRoundProspectGuide26_PostDraft.pdf` (have) — page 176 has the consolidated rankings table | Manual parse. ~30 min. |
| **Koalaty 2024 model percentiles** | His "2024 NFL Draft" series of Substack posts (subscriber, you have access) — RB/WR/TE separately | Manual paste of rankings tables into CSV. ~30 min. |
| **Koalaty 2026 model percentiles** | His "2026 Post-Draft Rookie Rankings" Substack post | Same. ~15 min. |
| **2024 NFL Y1 fantasy points** | `pipelines/etl/data_cache_nflverse_season_totals_2014_2025.csv` (have) — 2024 row per gsis_id | Already cached. |
| **NFL Draft Capital 2024 + 2026** | `nflreadpy.load_draft_picks(seasons=[2024, 2026])` | Auto-fetch, ~30 lines. 15 min. |
| **MFL→gsis crosswalk for new players** | Existing crosswalk extends with new fuzzy match | Extension of `pipelines/etl/data_cache_mfl_to_gsis_crosswalk.json`. ~15 min. |
| **UPS rookie draft order 2026** | `site/rookies/rookie_draft_hub_2026.json` | Already in repo. |
| **UPS slot hit-rate priors** | `site/rookies/rookie_hit_rate_matrix.json` | Already in repo. |

## Architecture (data flow)

```
        ┌─ JJ 2024 ZAP (csv)              ─┐
        ├─ Koalaty 2024 %ile (csv)        ─┤
        ├─ 2024 NFL Y1 fantasy pts (cache)─┤
        ├─ NFL draft capital 2024 (csv)   ─┤
        └──────────────────────────────────┘
                       │
                       ▼
   ┌────────────────────────────────────────────┐
   │ calibration_2024.py                        │
   │   1. join inputs on player_name + position │
   │   2. compute Y1 fantasy ppg per prospect   │
   │   3. grade JJ tier vs Y1 ppg               │
   │   4. grade Koalaty tier vs Y1 ppg          │
   │   5. fit calibration curve per model       │
   │   6. derive optimal blend weight (search)  │
   │   7. document named misses per model       │
   └─────────────────────┬──────────────────────┘
                         │
                         ▼
                blend_weights.json
                docs/league-context/2024_calibration_retrospective.md

        ┌─ JJ 2026 ZAP (csv)              ─┐
        ├─ Koalaty 2026 %ile (csv)        ─┤
        ├─ NFL draft capital 2026 (csv)   ─┤
        ├─ blend_weights.json (from above)─┤
        ├─ UPS rookie draft hub (existing)─┤
        └─ rookie_hit_rate_matrix (exist) ─┘
                       │
                       ▼
   ┌────────────────────────────────────────────┐
   │ rookie_meta_model_2026.py                  │
   │   1. join inputs on player_name + position │
   │   2. z-normalize JJ + Koalaty scores       │
   │   3. apply calibrated blend weights        │
   │   4. compute consensus tier                │
   │   5. flag tier disagreement (>=2 tiers)    │
   │   6. compute Draft Capital Delta vs NFL    │
   │   7. bootstrap CI on consensus score       │
   │   8. compute E[B2S] from tier              │
   │   9. compute UPS-slot mispricing           │
   │  10. output buy list + JSON                │
   └─────────────────────┬──────────────────────┘
                         ▼
            site/rookies/2026_meta_prospects.json
            docs/league-context/2026_rookie_buy_list.md

                  ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─

   ┌─ 2026_meta_prospects.json (above) ─┐
                       │
                       ▼
   ┌────────────────────────────────────────────┐
   │ pre_register_2026.py                       │
   │   write-once: locks predicted outcomes     │
   │   at confidence levels                     │
   │   for future Brier-score grading           │
   └─────────────────────┬──────────────────────┘
                         ▼
            docs/league-context/2026_predictions_locked.md
```

## File layout

```
pipelines/analytics/
└── meta_model/
    ├── __init__.py
    ├── calibration_2024.py             # deliverable 1
    ├── rookie_meta_model_2026.py       # deliverable 2
    ├── pre_register_2026.py            # deliverable 3
    ├── tier_compression.py             # shared: ZAP-tier bands + agreement detection
    ├── confidence_intervals.py         # shared: Wilson + bootstrap helpers
    └── inputs/
        ├── jj_zap_2024.csv             # manual parse from PDF; one-time
        ├── jj_zap_2026.csv             # manual parse from PDF; one-time
        ├── koalaty_model_2024.csv      # manual parse from Substack; one-time
        ├── koalaty_model_2026.csv      # manual parse from Substack; one-time
        ├── nfl_draft_picks_2024.csv    # nflverse fetch
        └── nfl_draft_picks_2026.csv    # nflverse fetch

docs/league-context/
├── meta_model_spec.md                  # this file
├── 2024_calibration_retrospective.md   # deliverable 1
├── 2026_rookie_buy_list.md             # deliverable 2
└── 2026_predictions_locked.md          # deliverable 3 (write-once)

site/rookies/
└── 2026_meta_prospects.json            # JSON output of deliverable 2
```

## Build order with time estimates

### Day 1 (~3-4 hours): Calibration retrospective on 2024

1. Parse JJ 2024 ZAP scores + tiers (manual PDF read, RB/WR/TE — TE was just added in 2024). 30 min.
2. Parse Koalaty 2024 model %iles (manual Substack copy/paste). 30 min.
3. NFL draft capital fetcher for 2024 + 2026 (one script). 20 min.
4. `calibration_2024.py`: join, grade against Y1 ppg from existing cache, fit blend weights. ~120 lines. 90 min.
5. Write `2024_calibration_retrospective.md` with calibration plots (text-based or simple), tier-realized hit rates, named misses. 30 min.

**Output Day 1**: empirical blend weights for the 2026 model + a published audit of where JJ and Koalaty whiffed in 2024.

### Day 2 (~3-4 hours): 2026 buy list

6. Parse JJ 2026 ZAP scores + tiers (manual PDF read). 30 min.
7. Parse Koalaty 2026 post-draft model (manual Substack copy/paste). 30 min.
8. `rookie_meta_model_2026.py`: applies calibrated blend, tier compression, agreement flag, CIs, UPS-slot mispricing. ~150 lines. 90 min.
9. `tier_compression.py` + `confidence_intervals.py` (shared utilities). ~80 lines. 45 min.
10. Write `2026_rookie_buy_list.md` (human-readable per-prospect analysis, UPS-slot recommendations). 60 min.

**Output Day 2**: the actual May 24 deliverable — a 2026 buy list with cross-model agreement flags and CIs.

### Day 3 (~1 hour, before NFL Week 1): Pre-registration

11. `pre_register_2026.py`: write-once script that locks the prediction distribution at confidence levels. 30 min.
12. Locked file `2026_predictions_locked.md`. 30 min.

**Total: ~7-9 hours of focused work to ship all three deliverables.** May 24 is realistic for deliverables 1 + 2.

## Key design choices

- **2024 calibration is the data anchor.** Without it, the blend weights are guesses. With it, they're empirical. This is the single most important methodological move in the build.
- **Year-1 grading on 2024 is imperfect** — only one season of data, true B2S is 3 years out. But Y1 strongly correlates with B2S for hits, less so for slow developers. We accept the imperfection and grade both Y1-direct *and* Y1-tier-vs-realized.
- **Tier compression on both** — present results as tiers, not ranks. Both analysts converge on this discipline.
- **Cross-model disagreement at 2+ tiers** is the high-leverage signal. Default threshold; revise if too noisy.
- **Bootstrap CI per prospect** — neither analyst publishes per-prospect uncertainty. We can compute via resampling the historical ZAP-tier-to-B2S mapping in JJ's published tables (page 27-28 of the 2026 guide).
- **UPS-slot mispricing** ties the consensus estimate back to our existing `rookie_hit_rate_matrix.json`. If the meta-model's E[V] for a prospect at his expected UPS slot exceeds the slot's historical hit rate, it's a buy at that slot. Below, fade.
- **No auction $ conversion.** Out of scope per the rookie-only mandate. Can be added later as a rookie-pick-cost evaluator if you want.

## Open questions before code

1. **Output format preference**: human markdown buy list, JSON, or both? (My default: both — markdown for reading, JSON for any downstream tooling.)
2. **Cross-model disagreement threshold**: 2 tiers (loose, more flags) or 3 tiers (strict, fewer)? My default: 2 — disagreement is the high-leverage signal.
3. **Calibration weights — fit per position or single blend?** My default: per position, since their relative model strength differs by position (Koalaty's TE model is newer; JJ's WR model has the longest history).
4. **For the 2024 retrospective, do you want me to grade RB/WR/TE separately or combined?** My default: separately — TE has only 1 cohort year of post-2024-model data and should be flagged as low-confidence.
5. **For the 2026 buy list, do you want UPS-slot context per prospect (i.e., "at UPS pick 1.04, buy/fade")** or the broader Day-1/Day-2/Day-3 context? My default: UPS-slot — it's the actually decisionable framing for May 24.

## Success criteria

- **2024 retrospective surfaces empirical blend weights** that aren't 50/50, with a documented rationale (e.g., "Koalaty's WR model graded at higher Y1 hit rate; weight 0.6 / JJ 0.4 for WR").
- **2026 buy list ships before May 24** with the four columns that justify the build: consensus tier, agreement flag, bootstrap CI, UPS-slot mispricing.
- **Pre-registration locked before NFL Week 1** for future-cohort grading.
- **The framework is additive over JJ + Koalaty alone.** If the 2024 retrospective just rediscovers what each analyst already said about their own misses, we built the wrong thing.

---

*Decision points: the five open questions above. Defaults are flagged for each. Once approved, Day 1 starts.*
