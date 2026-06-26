# Auction FA Value v13 — Worth vs Expected Price, the dynasty/redraft blend, and back-tested inflation

**Status: CANON (2026-06-24). Supersedes v11/v12 for the FA-value engine.** Branch `auction-fa-value-v2`, commit `3354178`. Desktop ships at `UPS_RELEASE_SHA=3354178`; mobile build `2026.06.24.0`.

This is the model behind the War Room **💎 FA Value** view (desktop `site/commish/commish_settings.html`) and the mobile **Auction → 💎 Value** sub-tab. It answers Keith's three asks: (1) show **value AND expected price** as separate numbers, (2) blend **dynasty + redraft** on a live slider, and (3) **track inflation** as players come off the board.

---

## 1. The three numbers

For every player we surface **WORTH**, **EXPECTED PRICE (EP)**, and the **GAP** between them.

### WORTH — a live blend of two cardinal $ axes
- **Redraft worth** = `E[APWE | FantasyPros redraft rank] × $6.5K`. APWE = *all-play wins earned* = points-above-replacement × the all-play slope (0.088 wins/team-point). It is points-based, positional-scarcity-aware (replacement differs by position), and **non-saturating** (an elite QB ≫ an elite TE, unlike the old all-play fraction). This is the **win-now / production** value, grounded in our league's own scoring + all-play history. No individual 2026 prediction — the redraft ADP slot is a market proxy and we apply *historical* APWE realized at that slot.
- **Dynasty worth** = `dynasty SF consensus value × $/value`, anchored so the top asset (Josh Allen, consensus 10136) = $75K. The consensus is the **multi-source, KTC-led cardinal value** from the Stats-workbench `/api/adp-board` (FantasyCalc + KeepTradeCut + DynastyProcess). **Cardinal, not ordinal** — the *value gap* (10136 vs 8272) says how much more QB1 is worth than QB2, which a bare rank throws away (Keith's KTC-tiering point). This replaced a single-source DynastyProcess scrape that was an outlier (it had Mahomes dynasty QB3; the consensus has him **QB8** → his price dropped from a stale $69K to $46K).
- **Blended worth** = `(1 − w)·redraft + w·dynasty`, with `w` = the **redraft↔dynasty slider** (default 50/50). The slider re-derives worth, gap, and verdict client-side on both surfaces.

### EXPECTED PRICE (EP) — what it clears for
`EP_base = max(dynasty cardinal $, startability floor)`, then inflation-adjusted (§2).
- The **dynasty cardinal $** prices the studs (Allen $75K).
- The **startability floor** is the slot-rent a startable NFL player commands regardless of production (FantasyPros redraft rank → $K). Calibrated to Keith's anchors: any starting QB ≥ **$12K** (Rodgers QB28), Darnold QB23 → $13K, Flacco QB40 → $6K, Mixon RB90 → $2K, Diggs WR56 → $5–9K, Kelce TE10 → $14K.

### GAP = EP − WORTH
Positive = you pay a premium over production (the positional/slot tax — pay it if you *need* the spot). Negative = worth exceeds price (a value). Recomputed live with the slider.

**Verdict ladder** (on `value_ratio = worth ÷ EP`): SPLURGE ≥1.5 (worth ≥$15K) · VALUE ≥1.2 · FAIR ≥0.8 · cheap startables (<$15K) stay FAIR (market slot-rent, not an overpay) · OVERPAY only when `EP ≥ $15K and ratio < 0.6` · ≤$4K cut-free flier with a real ceiling = DART.

---

## 2. Inflation — the affine clearing line (back-tested + adversarially verified)

**Why it exists:** rostered players sit on **below-worth multi-year contracts** (Chase worth ~$77K on a $26K deal, Bijan ~$64K on $35K). That locks value up cheaply, leaving a large leftover cap chasing a smaller remaining-FA-value pool → prices clear **above** intrinsic worth. League-wide locked surplus right now ≈ **$1.4M**.

**The shape is NOT a stud multiplier.** Back-testing every SF-era FA auction (2022–25, n≈88 worthy wins) the realized clearing line is **affine**:

> `paid$K ≈ $7.3K + 0.72 · redraft_worth$K`  (OLS, MSE 89 — beats a floor-preserving uniform multiplier MSE 139 and a positional multiplier MSE 117)

A flat per-credible-target **ante** plus a **sub-1 slope**. Proven studs clear *at/below* worth (McLaurin 0.50×, Mayfield 0.53×, Purdy 0.61×); the premium is the flat ante landing on the cheap/mid tier — which is exactly why **TE inflates most** (lowest worth → biggest multiplier) and **QB least**, with no need for a separate positional ante.

**How we apply it** (the verifier's fix — don't multiply a worth-calibrated factor onto the ~1.9× larger dynasty `EP_base`):

> `EP_inflated = max(EP_base, ANTE_live + 0.72 · redraft_worth)`

Additive **over** the dynasty/startability anchor → a stud is never deflated and never double-inflated; the ante only lifts mid/cheap targets the anchor didn't already cover. The ante **ramps in** over `worth ∈ [0, $2K]` so a 1-rank ADP wobble isn't a price cliff; true scrubs hold the $1K floor.

`ANTE_live = $7K × clamp(regime ÷ 1.9, 0.4, 1.6)`, where `regime = biddable_money ÷ credible-redraft-worth`. So the ante **dampens in a deep pool** and **climbs live** as studs clear (their high worth leaves the denominator faster than the money leaves the numerator → regime rises → ante rises → remaining depth inflates). `biddable_money = 0.76 × Σ(ceiling headroom)` (only ~76% of ceiling room becomes real bids).

### Back-test (realized FA spend ÷ intrinsic redraft worth, SF era)
| Year | Realized | QB | RB | WR | TE |
|---|---|---|---|---|---|
| 2022 | 1.89× | 1.35 | 1.90 | 1.47 | 4.49 |
| 2023 | 2.61× | 1.63 | 1.97 | 2.22 | 1.97 |
| 2024 | 1.57× | 1.02 | 1.40 | 1.02 | 2.89 |
| 2025 | 1.81× | 1.03 | 1.84 | 1.44 | 2.12 |
| **mean** | **1.97×** | 1.22 | 1.73 | 1.40 | 2.45 |

### The 2026 read: a deep, stud-heavy pool
Because expiring contracts dump **Allen, Lamar, Burrow, *and* Mahomes** back into the FA auction, biddable money ($785K) ≈ credible pool worth ($782K) → **regime ≈ 1.0**, ante dampened to **$3.7K** (norm $7K). So **no blanket inflation pre-auction** — the studs go near value. But the **$1.4M locked surplus is the fuel**: the inflation gauge climbs live as the studs clear, inflating the remaining depth. This is surfaced as a live inflation panel (factor, ante, biddable vs pool, surplus) on both surfaces.

---

## 3. Positional tiers — the worth-vs-price dropoff

Per position, the available pool sorted by worth into named tiers (Elite / High / Mid / Depth), showing avg blended worth and avg price. A **shallow worth drop next to a steep price drop = the efficiency tier** (flagged 💡). 2026 example (50/50 blend):
- **QB**: Elite (1–3) $68 → High (4–8) $34 → Mid (9–16) $8 → Streamer $1. Value concentrated in the top 8; SF mid-QBs are nearly free this year (deep pool).
- **RB**: Elite (1–4) $33 → High (5–12) $7 (**−79% cliff**) → Mid $2. The "do I need mid RBs?" answer: **no** — the value is all at the top; mid/depth RBs are ~free.
- **WR**: Elite (1–6) $22 → High $4 → Mid $2. **TE**: Elite (1–3) $12 → High $6 → Mid $3.

---

## 4. Caveats (carry forward)
- **Worth is a redraft proxy in the back-test** (historical dynasty values aren't available), which over-values aging vets — so the 1.97× is conditioned on that proxy; the true dynasty-worth premium is milder and concentrates later. The *current* model uses the live dynasty cardinal value, which is correct.
- **Biddable money is fragile** — `rosters_weekly` wk1 salaries are EOS-stamped (post-auction); we use the ceiling-headroom × 0.76 deploy fraction, recomputed each July.
- **Positional ante is thin-sample** (TE n≈17/4yr, spiked 4.49× in 2022) → we use a single league ante, not per-position, until ≥8 SF seasons accrue. The TE/RB-inflate-more signal emerges from the worth distribution anyway.
- **The 2026 FA pool only fully materializes in July** when teams cut/release; the current snapshot already includes expiring-contract studs, which is correct for this auction.

---

## 5. Pipeline & surfaces
Run order (all in `pipelines/etl/scripts/`):
`fetch_fantasypros_adp.py` (SF redraft rank) · `fetch_adp_board.py` (workbench dynasty consensus cache) → `build_apw_seasonal.py` (PAR → APWE) → `build_eapw_curves.py` (E[APWE] by rank, fpros/dynasty axes) → `build_fa_value.py` (worth components + EP_base + verdict) → `build_roster_fit.py --push-d1` (inflation + tiers + fit + competition + the lean D1 blob).

- **Worker**: `GET /api/auction/fa-value` (commish-gated passthrough of the `ups_auction_fa_value` blob, ~85KB). Unchanged this version.
- **Desktop**: War Room 💎 FA Value — inflation panel + worth-blend slider + worth/price/gap table + 📊 Tiers toggle. Ships at the `UPS_RELEASE_SHA` bump + jsDelivr warm.
- **Mobile**: Auction → 💎 Value (commish-only) — inflation strip + blend slider + pos filter + tappable cards. Auto-updates via `version.json`.

The blob carries only the two worth components (`rw`, `dw`) + the inflated price (`e`) + APWE range; the View **re-derives** worth/gap/value_ratio/verdict so the slider blends instantly.
