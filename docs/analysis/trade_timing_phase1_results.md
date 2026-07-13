# Trade-Timing Study — Phase 1 Results (2026-07-12)

Cohorts/buckets per the commish-approved design (see trade_timing_study_plan.md).
Associations, not causation. Phase 2 (valuation regressions -> relief_multiplier
constants for trade_grade_model_v2_spec.md) pending commish go.

---

All analysis complete. Compiling the deliverable.

# Q(a) BEHAVIOR CONTRASTS — Top-3 All-Play vs Control, 2020–2025

**Method notes (per approved design):** Buckets by MIN(unix_timestamp) of trade_group vs the ET anchors; all 477 trade groups landed inside B1–B5 (zero post-deadline; latest deadline-day trade 12:19 PM). **Salary basis:** `transactions_trades` has NO salary column, so each PLAYER asset was joined to `rosters_weekly` salary at the week nearest the trade (offseason trades → week 1 of the trade season; prior-season final week as fallback). Match rate: 2,120 direct / 34 prior-season fallback / 2 unmatched of 2,156 player assets. **Cap-cash:** SENDER rows carry the positive amount; `trade2025_35` (NULL pair, per design) excluded — and note a **second** NULL pair, `trade2025_60`, also excluded (both are `BB_` tokens in raw_json; recoverable amounts $3,000 0006→0010 on 2025-08-07 and $5,000 0006→0011 on 2025-10-16). All figures are **per franchise-season means** (zeros included; Top-3 n=18 fr-seasons, Control n=54).

Trade-group volume by bucket: B1 107 | B2 111 | B3 74 | B4 79 | B5 106.

### B1 — preRookieDraft
| Metric | Top-3 | Control |
|---|---:|---:|
| Trades participated | 3.28 | 2.87 |
| Players acq / shipped | 2.72 / 3.06 | 2.56 / 2.44 |
| Salary acq / shed ($) | 40,778 / 43,000 | 44,037 / 43,296 |
| Net salary ($) | −2,222 | +741 |
| Picks acq / given | 4.44 / 4.44 | 3.43 / 3.43 |
| Net picks (R1 / R2 / R3+) | 0.00 (+0.11 / +0.33 / −0.44) | 0.00 (−0.04 / −0.11 / +0.15) |
| Cap-cash sent / recv ($) | 1,111 / 389 | 4,185 / 4,426 |
| Net cap-cash ($) | −722 | +241 |

### B2 — preAuction (post rookie draft)
| Metric | Top-3 | Control |
|---|---:|---:|
| Trades participated | 3.67 | 2.89 |
| Players acq / shipped | 2.50 / 2.61 | 1.96 / 1.93 |
| Salary acq / shed ($) | 31,833 / 33,333 | 25,481 / 24,981 |
| Net salary ($) | −1,500 | +500 |
| Picks acq / given | 3.61 / 4.39 | 3.26 / 3.00 |
| Net picks (R1 / R2 / R3+) | **−0.78** (−0.22 / −0.11 / −0.44) | +0.26 (+0.07 / +0.04 / +0.15) |
| Cap-cash sent / recv ($) | 1,944 / 4,667 | 4,204 / 3,296 |
| Net cap-cash ($) | **+2,722** | −907 |

### B3 — auction → kickoff (the Sept contract-locking window)
| Metric | Top-3 | Control |
|---|---:|---:|
| Trades participated | 1.72 | 2.17 |
| Players acq / shipped | 2.00 / 1.72 | 3.19 / 3.28 |
| Salary acq / shed ($) | 19,833 / 13,611 | 23,278 / 25,352 |
| Net salary ($) | **+6,222** | −2,074 |
| Picks acq / given | 1.44 / 1.72 | 1.70 / 1.61 |
| Net picks (R1 / R2 / R3+) | −0.28 (0 / −0.28 / 0) | +0.09 (0 / +0.09 / 0) |
| Cap-cash sent / recv ($) | 1,389 / 3,389 | 3,315 / 2,648 |
| Net cap-cash ($) | +2,000 | −667 |

### B4 — weeks 1–6
| Metric | Top-3 | Control |
|---|---:|---:|
| Trades participated | 1.89 | 2.30 |
| Players acq / shipped | 2.39 / 3.06 | 3.30 / 3.07 |
| Salary acq / shed ($) | 32,333 / 30,389 | 33,056 / 33,704 |
| Net salary ($) | +1,944 | −648 |
| Picks acq / given | 1.44 / 2.17 | 1.89 / 1.65 |
| Net picks (R1 / R2 / R3+) | **−0.72** (**−0.39** / −0.06 / −0.28) | +0.24 (+0.13 / +0.02 / +0.09) |
| Cap-cash sent / recv ($) | 4,056 / 5,611 | 5,593 / 5,074 |
| Net cap-cash ($) | +1,556 | −519 |

### B5 — wk7 → deadline
| Metric | Top-3 | Control |
|---|---:|---:|
| Trades participated | 2.56 | 3.07 |
| Players acq / shipped | 3.28 / 4.22 | 4.67 / 4.35 |
| Salary acq / shed ($) | 51,333 / 30,833 | 44,037 / 50,870 |
| Net salary ($) | **+20,500** | −6,833 |
| Picks acq / given | 1.72 / 2.11 | 2.35 / 2.22 |
| Net picks (R1 / R2 / R3+) | −0.39 (**−0.33** / −0.17 / +0.11) | +0.13 (+0.11 / +0.06 / −0.04) |
| Cap-cash sent / recv ($) | 444 / **18,111** | 11,056 / 5,167 |
| Net cap-cash ($) | **+17,667** | −5,889 |

## Findings (associations, not causation)

1. **Top-3 front-load their trade volume, then go quiet.** They out-trade control pre-auction (B1 3.28 vs 2.87; B2 3.67 vs 2.89) and under-trade it in every in-season bucket (B3 1.72 vs 2.17; B4 1.89 vs 2.30; B5 2.56 vs 3.07). The eventual top teams do their roster construction early and make fewer, more-targeted in-season moves.
2. **(i) Pick-selling: total picks bleed in B2 and B4; premium (R1) picks specifically in-season.** Top-3 net picks: B1 0.00, B2 −0.78, B3 −0.28, B4 −0.72, B5 −0.39 per fr-season. R1 flow is starkest: over B4+B5 combined, Top-3 franchises relinquished 16 R1s and acquired only 3 (control: gave 21, acquired 34) — the classic "trade the future 1st for the win-now player" move, split roughly evenly between early-season (8 R1s) and deadline (8 R1s). B2 pick-selling is real but season-concentrated (driven by 2022/2023; only 4/6 seasons negative).
3. **(ii) Salary flows in-season, decisively — not pre-auction.** Pre-auction, Top-3 are actually slight net salary *shedders* (B1 −2,222; B2 −1,500) — they clear the books before the auction. The salary intake happens after kickoff and peaks at the deadline: B5 net **+$20,500** per Top-3 fr-season vs −$6,833 control, and the direction is **positive in 6/6 seasons** (season Top-3 means: +3K, +24.7K, +26K, +10K, +19.7K, +39.7K). B3 is the secondary intake window (+$6,222, positive 5/6 seasons).
4. **(iii) B3 cap-cash — money moves right after the auction, not right before the lock.** 23 B3 transfers totaling $204K over six seasons ($34K/season — the *smallest* bucket by $ volume: B1 $246K, B2 $262K, B3 $204K, B4 $375K, B5 $605K). Timing clusters 27–39 days before kickoff (early August, i.e., immediately post-FA-auction settle-ups); a thinner tail runs to 13 days out, and **nothing lands inside the final ~2 weeks before kickoff**. So the "moving money before locking contracts" behavior looks like post-auction cleanup, not a September-deadline scramble. Direction: of $204K, $143K (70%) is control↔control; $61K flows *to* Top-3 vs only $25K *from* them (and that lone $25K send is the 2025 Top-3→Top-3 0004→0007 transfer) — when eventual top teams touch B3 cash, they're the ones being paid.
5. **The deadline pattern is "subsidized buying": Top-3 take on salary AND get paid to do it.** At B5, Top-3 receive $18,111/fr-season in cap-cash while sending just $444, alongside +$20.5K net salary and −0.33 net R1 — sellers attach cash to move big contracts, and the picks go the other way. Net B5 cash to Top-3 is positive in **6/6 seasons**. Control shows the mirror: net cash −$5,889 and net salary −$6,833 (selling players, paying the subsidy, collecting picks).
6. **Pre-auction cash accumulation is a mild, inconsistent Top-3 lean.** B2 net cap-cash +$2,722 (Top-3) vs −$907 (control) — consistent with banking auction budget — but it's positive in only 3/6 seasons and mostly one 2022 spike (+$14K); treat as suggestive only.
7. **(iv) Control "mirrors" partly by arithmetic, but its gross behavior genuinely opposes.** All net metrics (picks, salary, cash) are zero-sum league-wide, so Control's per-fr-season net is mechanically −⅓ of Top-3's — the informative contrast is the gross/volume side, and there it's real: control teams trade *more* in-season, ship more salary at the deadline than they take in (50.9K shed vs 44.0K acq at B5), accumulate picks in every in-season bucket, and pay the cash subsidies. Control is heterogeneous (it contains ranks 4–12: mid-pack buyers AND full rebuilders), which dampens its averages.
8. **Hindsight caveat on B4/B5:** the cohort is end-of-season all-play top-3, so in-season buckets carry survivorship flavor — teams buy at the deadline partly *because* they're already winning. The B1/B2 contrasts (more trades, pick-shedding starts, salary-neutral book-clearing) are the cleaner "behavior of future winners" signals.

**Sample-size caveats:** 18 Top-3 vs 54 control franchise-seasons; B3 is the thinnest bucket (74 trade groups; only 23 cap transfers ever, 6 involving a Top-3 team); B2 pick and cash contrasts are driven by 1–2 seasons; per-bucket cap-cash means rest on 15–37 transfer pairs. Two NULL-amount CAP pairs excluded (trade2025_35 per design, plus trade2025_60 discovered — both BB_ raw tokens worth $3K/$5K, both sent by 0006; including them would not change any finding's direction). Salary values are rosters_weekly nearest-week snapshots, not contract-event-chain TCV — adequate for flow direction, not for exact cap accounting.

Scripts: `/private/tmp/claude-501/-Users-keithcreelman-Code-MFL-upsmflproduction--claude-worktrees-condescending-keller-4fc8cc/213c497b-3469-4324-a0e5-1b691a06f8a6/scratchpad/qa_behavior.py` and `qa_supp.py` (rerunnable against `/tmp/mfl_arch.db`).

---

All analysis validated. Composing the deliverable.

---

# Q(d) — KITTLE-ARCHETYPE CENSUS: B2/B3 vet-for-pick buys, 2020-2025

**Definition applied:** trade whose first timestamp falls in B2 (rookie-draft → auction) or B3 (auction → kickoff); one side acquires a vet with trade-time salary ≥ $15K (rookie-contract acquisitions excluded via `contract_status`); that side relinquishes ≥ 1 draft pick. **48 qualifying case-sides across 44 trades** (4 trades qualified on both sides).

**Verdict criterion:** `vetPAR` = vet's started points for the *acquirer*, weeks 1-17 of trade season, minus GS × replacement PPG. `pickPAR` = same PAR for the player each surrendered pick became, over that player's first two seasons (to date). VET if vetPAR−pickPAR > +15; PICK if < −15; else WASH. Pick identities resolved to draft slots via a per-year base-order solve validated against full trade chains (11/12 slots chain-perfect in audited rounds); ⚠ = one unrecorded final pick-hop, slot resolution still confirmed. Ages approximate (not in DB).

## Full case list

| # | Yr | Bkt | Date | Acquirer | Vet (pos/age/$/status) | Picks given → became (2-season PAR) | Cash | vetPAR (GS) | pickPAR | All-play Δ | Verdict |
|---|----|----|------|----------|------------------------|--------------------------------------|------|------------|---------|-----------|---------|
| 1 | 20 | B2 | 6/10 | Blake | L. Murray RB 30 $19K | 21-4.08 J.Jefferson (0) | — | +0 (0, flipped) | 0 | .614→.672 ↑ **T3** | WASH |
| 2 | 20 | B2 | 6/10 | AJ Bald. | Mixon RB 24 $33K ᴾ | 21-1.11 Bateman (−63) | — | +31 (6) | −63 | ↑ | **VET** |
| 3 | 20 | B2 | 8/15 | Ryan B. | A. Robinson WR 27 $39K ᴾ | 21-5.08 Rountree (0) | −1K | −0 (1, flipped) | 0 | ↑ | WASH |
| 4 | 20 | B2 | 8/15 | AJ Bald. | R. Anderson WR 27 $17K ᴾ | 21-3.06 Eskridge (0) | +1K | +0 (0, flipped) | 0 | ↑ | WASH |
| 5 | 20 | B2 | 8/16 | Keith | **D. Adams WR 27 $50K** ᴾ | 21-1.10 DeVonta Smith (−2) | — | **+199** (13) | −2 | ↑ | **VET** |
| 6 | 20 | B3 | 8/21 | Rico | Slayton WR 23 $26K ᴾ | 21-3.02 Hubbard (−3), 21-4.02 E.Mitchell (+18) | — | +0 (flipped same-day) | +15 | ↓ | PICK |
| 7 | 20 | B3 | 8/21 | Dunn | Slayton WR 23 $26K | 21-3.04 N.Collins (−11), 21-5.04 Atwell (0) | +8K | −25 (5) | −11 | ↓ **T3** | WASH |
| 8 | 20 | B3 | 9/1 | Blake | K. Hunt RB 25 $19K ᴾ | 21-2.01 Z.Wilson (−24), 21-3.09 K.Herbert (−34), 21-3.01 Freiermuth (−7), 21-3.06 Eskridge (0) | — | +17 (11) | −66 | ↑ **T3** | **VET** |
| 9 | 20 | B3 | 9/2 | Cutting | R. Anderson WR 27 $17K ᴾ | 3× 2021 5ths → nothing | — | +11 (3) | 0 | ↓ | WASH |
| 10 | 20 | B3 | 9/2 | AJ Bald. | Fournette RB 25 $31K ᴾ | 21-2.11 Gainwell (0), 21-3.03 J.Palmer (−4), 21-4.07 K.Hill (0) | — | −8 (1) | −4 | ↑ | WASH |
| 11 | 21 | B2 | 6/20 | Mannila | OBJ WR 28 $58K | 21-4.12 Moehrig (0) | +10K | −9 (6) | 0 | ↑ | WASH |
| 12 | 21 | B2 | 6/21 | Blake | Hopkins WR 29 $70K Tag | 22-2.03 **R.White (+77)**, 22-3.03 Tolbert (0) | +35K | +20 (10) | +77 | ↓ | **PICK** |
| 13 | 21 | B2 | 7/1 | Mannila | **Kupp WR 28 $22K** ᴾ | 22-2.09 B.Robinson (+28) ⚠ | — | **+216** (15) | +28 | ↑ | **VET** |
| 14 | 21 | B2 | 7/16 | Gerardi | Zeke RB 26 $58K BL | 22-1.09 J.Cook (−25), 22-2.06 Pierce (−20), 22-3.06 T.McBride (+37), 22-4.06 P.Strong (−9) | +10K | +74 (15) | −18 | ↓ | **VET** |
| 15 | 21 | B2 | 7/16 | Ryan B. | **D. Adams WR 28 $65K FL** ᴾ | 22-1.12 Dotson (−65), 22-2.12 Davis-Price (0), 22-4.12 J.Woods (0) | +35K | **+168** (15) | −65 | ↑ | **VET** |
| 16 | 21 | B3 | 8/3 | Josh M. | **Stafford QB 33 $15K FL** | 22-2.10 Ridder (−42), 22-5.10 Bellinger (0) | — | **+144** (14) | −42 | ↑ **T3** | **VET** |
| 17 | 21 | B3 | 8/4 | Keith | R. Anderson WR 28 $27K ᴾ | 22-4.05 Badie (0) | −25K | +0 (0, flipped) | 0 | ↓ | WASH |
| 18 | 21 | B3 | 8/4 | Blake | Watson QB 25 $50K FL ᴾ | 22-1.03 D.London (−69) | +25K | +0 (0, suspended) | −69 | ↓ | **VET** |
| 19 | 21 | B3 | 8/12 | Mannila | R. Anderson WR 28 $27K | 22-3.09 Hutchinson (+9) | — | −48 (8) | +9 | ↑ | **PICK** |
| 20 | 22 | B2 | 6/25 | Steve B. | Dak QB 28 $45K + Hollywood WR 25 $20K ᴾ | 22-1.11 Burks (−51), 22-3.11 J.Ross (0), 23-3.09 D.Vaughn (0) | +32K | +83 (9+7) | −51 | ↓ **T3** | **VET** |
| 21 | 22 | B2 | 6/25 | Keith | M. Sanders RB 25 $22K | 22-4.01 Thibodeaux (−4), 3× late (0/−6) | +5K | +12 (3, flipped) | −11 | ↑ | **VET** |
| 22 | 22 | B2 | 7/10 | Cutting | Metcalf WR 24 $25K ᴾ | 23-1.11 Zay Flowers (+9) | +10K | +20 (15) | +9 | ↑ **T3** | WASH |
| 23 | 22 | B2 | 7/10 | Mannila | K. Allen WR 30 $60K ᴾ | 23-2.01 **Achane (+134)** | +13K | −26 (4) | +134 | ↓ | **PICK** |
| 24 | 22 | B3 | 8/4 | Ryan B. | Boyd WR 27 $21K | 23-5.03 **PUKA NACUA (+142)** | +8K | +3 (6) | +142 | flat | **PICK** |
| 25 | 22 | B3 | 8/4 | Blake | Goff QB 27 $15K ᴾ | 23-3.03 Chase Brown (+79) | +7K | +74 (14) | +79 | ↓ | WASH |
| 26 | 22 | B3 | 8/18 | Rico | Winston QB 28 $33K + D.Harris RB 25 $15K (MEGA: gave 21 players + 6 picks) | incl. 23-1.05 **GIBBS (+232)** ⚠, 23-2.05 Spears (+10), 4 more (≈0) | — | −1 | +228 | ↓ | **PICK** |
| 27 | 22 | B3 | 8/28 | Cutting | D. Harris RB 25 $15K ᴾ | 23-2.11 DeW.McBride (0), 23-5.11 S.Tucker (0) | — | +0 (0) | 0 | ↑ **T3** | WASH |
| 28 | 23 | B2 | 5/28 | Whitman | Aiyuk WR 25 $15K ᴾ | 23-1.10 Levis (−49), 24-4.11 Bailey (0) | — | +64 (15) | −49 | .337→.717 ↑ **T3** | **VET** |
| 29 | 23 | B2 | 5/28 | Dunn | **Ertz TE 32 $23K** | 24-5.04 Cowing (0) | +10K | −6 (1) | 0 | ↓ | WASH |
| 30 | 23 | B2 | 5/28 | Blake | Chubb RB 27 $48K | 23-1.09 Addison (+28), 24-1.12 McConkey (+16) | — | +2 (2, injury) | +44 | ↑ **T3** | **PICK** |
| 31 | 23 | B2 | 5/28 | Keith | Pitts TE 22 $15K R/V ᴾ | 24-2.05 Penix (−11) | — | −10 (11) | −11 | ↓ | WASH |
| 32 | 23 | B2 | 5/28 | Gerardi | **KITTLE TE 29 $17K FL** ᴾ | 24-3.09 Ray Davis (0) | — | **+46** (15) | 0 | ↓ | **VET** |
| 33 | 23 | B2 | 6/8 | Blake | Deebo WR 27 $25K | 24-2.02 Burton (0), 24-2.05 Penix (−11), 24-3.12 JT Sanders (−42) | — | +64 (11) | −53 | ↑ **T3** | **VET** |
| 34 | 23 | B2 | 6/11 | Whitman | D. Cook RB 27 $30K FL ᴾ | 24-2.08 J.Wright (0), 24-4.07 Guerendo (+16) | −15K | +0 (0, never started) | +16 | ↑ **T3** | **PICK** |
| 35 | 23 | B2 | 7/23 | Keith | M. Williams WR 28 $16K | 24-1.09 J.Brooks (−12), 24-3.09 Ray Davis (0) | — | +14 (3) | −12 | ↓ | **VET** |
| 36 | 23 | B3 | 8/2 | Cutting | Conner RB 28 $40K BL ᴾ | 24-3.10 **BUCKY IRVING (+88)** ⚠ | — | +12 (4) | +88 | ↓ | **PICK** |
| 37 | 23 | B3 | 8/3 | Blake | DJ Moore WR 26 $61K FL | 24-1.09 J.Brooks (−12) | — | +80 (13) | −12 | ↑ **T3** | **VET** |
| 38 | 23 | B3 | 8/11 | Hammer | A. Jones RB 28 $41K Tag ᴾ | 24-3.02 Vidal (+15) | +20K | −4 (10) | +15 | ↑ | WASH |
| 39 | 23 | B3 | 8/12 | Josh M. | D. Cook RB 28 $30K | 24-3.12 JT Sanders (−42) | — | +0 (0) | −42 | ↑ | **VET** |
| 40 | 24 | B2 | 5/26 | Dunn | T. Lawrence QB 24 $47K | 24-2.11 Lloyd (0), 25-2.07 Tre Harris (0) ⚠ | — | +30 (7) | 0 | ↑ **T3** | **VET** |
| 41 | 24 | B2 | 5/27 | Keith | McLaurin WR 28 $32K ᴾ | 25-4.04 Tr.Etienne (0), 25-5.04 Mykel Williams (0) | +16K | +34 (12) | 0 | ↓ | **VET** |
| 42 | 24 | B2 | 7/24 | Cutting | Kirk WR 27 $19K | 25-3.02 Mason Taylor (−3) | — | −12 (1) | −3 | flat | WASH |
| 43 | 24 | B3 | 8/15 | Gerardi | Ekeler RB 29 $16K ᴾ | 25-3.05 Ferguson (0), 25-3.09 Abdul Carter (−1) | +4K | +12 (8) | −1 | ↓ | WASH |
| 44 | 25 | B2 | 6/9 | Mannila | Allgeier RB 25 $15K | 2026 3rd — TBD | — | +0 (6) | TBD | ↓ | TBD |
| 45 | 25 | B2 | 7/20 | Keith | D. Jones QB 28 $21K FL | 2026 5th — TBD | +3K | +0 (0, flipped) | TBD | ↓ | TBD |
| 46 | 25 | B2 | 7/20 | Cross | D. Jones QB 28 $21K FL ᴾ | 2026 5th — TBD | — | +53 (12) | TBD | ↑ | TBD (leans VET) |
| 47 | 25 | B3 | 8/4 | Mannila | Stevenson RB 27 $32K BL | 2026 4th + 5th — TBD | +16K | −14 (11) | TBD | ↓ | TBD (leans PICK) |
| 48 | 25 | B3 | 8/19 | Josh M. | **CMC RB 29 $56K** ᴾ (gave GIBBS; also *received* 3× 2026 1sts) | 2× 2026 5ths — TBD | +25K | **+233** (16) | TBD | ↑ **T3** | TBD (leans VET) |

ᴾ = package trade (players also given). Cash "+": seller paid the buyer to move the salary. "flipped" = acquirer re-traded the vet before/early in season.

## Aggregate profile (43 decided cases)

| Split | n | VET / WASH / PICK | Buyer improved | Made top-3 | Med vetPAR / pickPAR |
|---|---|---|---|---|---|
| **ALL** | 43 | **18 / 15 / 10** | 24/43 (56%) | 13/43 (30%) | +11 / 0 |
| Salary <$25K | 17 | 7 / 9 / 1 | 9/17 | 5/17 | +12 / 0 |
| **Salary $25-44K** | 15 | **4 / 5 / 6** | 9/15 | 4/15 | **0 / 0** |
| Salary ≥$45K | 11 | 7 / 1 / 3 | 6/11 | 4/11 | +30 / −2 |
| Age ≤26 | 14 | 8 / 5 / 1 | 9/14 | 7/14 | +14 / −11 |
| Age 27-28 | 22 | 8 / 7 / 7 | 13/22 | 4/22 | +3 / 0 |
| **Age 29+** | 7 | **2 / 3 / 2** | 2/7 | 2/7 | +12 / 0 |
| B2 pre-auction | 25 | 13 / 8 / 4 | 15/25 | 8/25 | +20 / 0 |
| B3 auction→kickoff | 18 | 5 / 7 / 6 | 9/18 | 5/18 | 0 / 0 |
| Gave a 1st | 12 | 9 / 1 / 2 | 7/12 | 5/12 | +48 / −15 |
| Clean (picks/cash only) | 17 | 8 / 5 / 4 | 11/17 | 7/17 | +3 / −3 |

## Findings (associations, not causation)

1. **The archetype mildly favors the vet-buyer: 42% VET / 35% WASH / 23% PICK.** Buyers' all-play improved 56% of the time and 30% made top-3 (vs 25% base). But it's an all-or-nothing bet: 19/43 vets delivered ≤ 0 PAR for their buyer (cut, flipped, or injured before contributing), while the wins are enormous (Adams +199/+168, Kupp +216, CMC +233, Stafford +144).
2. **The surrendered pick is usually a dud — median realized pickPAR is exactly 0** (only 10/43 packages exceeded +15). Of 16 future-2nd instances given away, 13 became nothing and 3 hit (R.White, Achane, B.Robinson). But the tail is where sellers get rich: **Gibbs (+232), Nacua from a 5th (+142), Achane (+134), Irving (+88)** — and every one of those landmines came out of a *mid-salary* ($15-41K) vet buy, never a $45K+ stud buy.
3. **Pay up or stay home.** The ≥$45K tier is the best-performing (7 VET / 1 WASH / 3 PICK, median vetPAR +30) — big salaries pre-kickoff have meant true difference-makers. The $25-44K middle tier is the *worst* (4/5/6, median vetPAR 0): teams paid mid-stud prices for non-studs. Giving a 1st correlates with winning (9/1/2) because owners only give 1sts for the real thing.
4. **Timing matters: B2 beats B3.** Pre-auction buys went 13/8/4 VET-led (median vetPAR +20); post-auction/pre-kickoff buys went 5/7/6 (median 0). Late-summer buys skew toward desperation fills (Slayton ×2, D.Cook ×2, D.Harris ×2 — all ~0 PAR).
5. **Age 29+ is the danger zone: only 2 of 7 buyers improved.** The two aged wins were Stafford-33 (all-time league heist: $15K QB, +144 PAR, top-3) and CMC-29 (pending). The nearest age/position comp to Kittle-2026 is **Ertz-2023: $23K age-32 TE + $10K cash for one future 5th → 1 GS, gone — a WASH only because the 5th also busted.**
6. **Cash flowing WITH the vet is standard, and Blake's $5K is light.** 17/48 cases had the seller paying the buyer (median subsidy ≈ $10K; Hopkins came with $35K, Dak $32K, CMC $25K). On a $29K salary, a $5K sweetener is below the historical subsidy-to-salary norm for this archetype.
7. **Where the Kittle trade sits:** B2 window (matching the stronger bucket), single future 2nd (historically ~80% dead weight), cash-in (typical), CLEAN structure (17 precedents, 8/5/4 VET-led) — all favorable. But $29K puts it in the worst salary tier, age 32 in the worst age tier, and TE ≥29 has one direct precedent each way (Kittle-2023 himself: +46 PAR, VET win for Gerardi; Ertz-2023: bust). Historically the trade's fate hinges almost entirely on whether the 2027 2nd becomes one of the ~1-in-5 hits — the vet side of these deals at this age/salary has averaged roughly replacement-level.
8. **Blake is the league's heaviest archetype user: 8 of the 43 decided cases (4 VET / 2 PICK / 2 WASH, improved 5/8, top-3 in 3).** The Kittle buy is in-character, and his prior wins (Hunt, Watson-flip, Deebo, DJ Moore) all came buying age ≤27 — his two PICK-side losses (Hopkins-29 for the pick that became R.White; Chubb-27 coming off nothing) are the cautionary comps.

Data notes: all 2025-season outcomes complete; 5 cases TBD pending the 2026 rookie draft. Pick slots resolved via solved per-year base draft orders (round-level chain audits 11/12 consistent); ⚠ rows have one unrecorded final pick-hop but confirmed slot identity. Scripts: `/private/tmp/claude-501/-Users-keithcreelman-Code-MFL-upsmflproduction--claude-worktrees-condescending-keller-4fc8cc/213c497b-3469-4324-a0e5-1b691a06f8a6/scratchpad/{outcomes2.py,solve_order.py,cases2.json}`.