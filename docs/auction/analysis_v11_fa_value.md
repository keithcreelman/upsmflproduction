# UPS FA Auction — APW Value Engine (v11)

**Audience:** Commissioner (franchise 0008, Real Deal Creel)
**Status:** CANON · methodology + findings
**Data window:** 2020–2025 regular seasons · FA auctions only (`auction_type = FreeAgent`)
**Verification:** Headline numbers independently re-derived from raw D1 `src_weekly` + archived `transactions_auction`/`transactions_adddrop`. Confirmed claims and honest caveats are folded in throughout (see §6).

---

## 1. The idea

Stop pricing free agents by name, position scarcity, or gut. Price them by the thing that actually wins UPS games: **all-play wins**.

**APW = Adjusted All-Play Wins.** Every regular-season week, a starter is implicitly "played" against every other team's score that week. The fraction of those matchups you'd win is a *win chunk* (in D1 `src_weekly.win_chunks`, starter weeks only, `is_reg=1`). Sum a player's win chunks across a season and you get how many all-play wins their *starts* contributed. We then multiply by a **positional leverage factor β** (how much a marginal win at that position moves your real all-play record), giving **APW per player-season**.

> β: QB **0.8825** · RB **0.8162** · WR **0.8168** · TE **0.6953**. QB/RB/WR start at high leverage; TE is discounted because the position is shallow and replaceable.

The engine then asks two questions for every free agent:

1. **What do you get?** Based on a player's ADP slot, what is the *expected* APW — and the realistic *range* of outcomes — that slot has historically delivered? (`E[APW | ADP rank]`)
2. **What does that cost?** Historically, what has the UPS market paid **per expected APW** at that position? (`$/E[APW]`)

A free agent is good value when the **rate you'd pay** beats the **market rate** for that position. That single comparison drives every verdict on the board.

---

## 2. Methodology — the five layers

### Layer 1 — Seasonal APW
For each player-season (2020–2025): `APW = (Σ reg-week win_chunks, starter weeks) × β[pos]`. All win chunks in the data were already starter-only, so the "starter weeks" filter is automatically satisfied.

**Re-derived & confirmed.** 2024 raw `SUM(win_chunks)` from D1: Lamar 21.796, Allen 20.086, Burrow 19.463, Chase 13.988, Barkley 13.309. After β:

| 2024 leader | Pos | APW |
|---|---|---|
| Lamar Jackson | QB | **19.2** |
| Josh Allen | QB | 17.7 |
| Joe Burrow | QB | 17.2 |
| Ja'Marr Chase (top WR) | WR | 11.4 |
| Saquon Barkley (top RB) | RB | 10.9 |

### Layer 2 — E[APW] by ADP rank, *with a real range of outcomes*
Per position, two ADP axes are blended: **redraft** (`adp_history.csv`, MFL id) and **dynasty-SF** (`dynasty_adp_history.csv` → FantasyPros id → MFL id). The fit is a log-linear **p50 backbone** with **isotonic-smoothed p25 / p50 / p90 bands** — so every slot carries a floor (p25), a median (p50), and a boom ceiling (p90), not a point estimate. Drafted players who never produced APW are counted as **0** (no survivorship bias). QB curves are fit **SF-only, 2022–2025** (the league's superflex era); RB/WR/TE use 2020–2025.

**Re-derived & confirmed.** All 8 curves (n=80 ranks each) are monotone-non-increasing in p50 and satisfy p25 ≤ p50 ≤ p90 at every rank, zero NaNs. Dynasty anchors:

| | p50 | p90 |
|---|---|---|
| QB1 | **10.6** | — |
| QB28 | 1.5 | **8.7** |
| RB1 | 4.9 | — |
| WR1 | 5.0 | — |
| TE1 | 0.7 | — |

The QB28-vs-QB1 spread (p50 1.5 but p90 8.7) is the engine's whole point: late QBs are cheap lottery tickets with a real top-end.

### Layer 3 — Market $/E[APW]
Every historical FA win (`finalbid_ind=1 AND auction_type=FreeAgent`) → winner-season dynasty-SF rank → that rank's E[APW] p50 → `$ paid / E[APW]`. Aggregated by position × era (**preSF = 2020–21**, **SF = 2022–25**). The league rate **R[pos] = SF median**.

| Pos | preSF median | **SF median (R)** | SF n | conf |
|---|---|---|---|---|
| QB | $1,204 | **$7,400** | 24 | high* |
| RB | ($29,101, n=2) | **$15,232** | 19 | high* |
| WR | $25,663 | **$19,048** | 11 | high* |
| TE | — | **$62,824** | 1 | **low** |

\* See caveats (§6). QB SF re-derived independently at **$7,527 (n=23)** — the headline $7,400 hinges on one ambiguous id-crosswalk match, well within sampling noise but not bit-exact. **RB ($15,232) and WR ($19,048) reproduce exactly.** WR rests on only 11 wins and RB on 19 — fine for a median but sensitive to a few high-priced outliers; treat "high" confidence as *adequate*, not *robust*. **The TE rate is a single observation in each era — effectively unsupported; any TE verdict is non-evidentiary.**

### Layer 4 — Verdict ladder
`value_ratio (vr) = R[pos] / (price_median / E[APW]_p50)`. Higher = better value.

- **SPLURGE** — vr ≥ 1.5 **and** p50 ≥ 4
- **VALUE** — vr 1.15–1.5
- **FAIR** — vr 0.85–1.15
- **OVERPAY** — vr < 0.85 **and** price > $4K
- **DART** — price ≤ $4K **and** p90 ≥ 4 **and** p50 < 2 (cheap, low floor, real ceiling)

**Re-derived & confirmed.** All 421 FA verdicts recompute from the band rules with **0 mismatches**. Median-price projections are monotone in rank (0 inversions across all positions), so no elite player is priced below a worse one. *(Minor band wiggles exist in the low/top-10 projection columns at non-elite ranks; they don't touch `value_ratio`.)*

### Layer 5 — League-wide roster fit (12 teams)
Each team's rostered players → E[APW] by position → top-N startable vs **baseline B[pos] = E[APW] at replacement rank** (QB24, RB31, WR31, TE14). Below baseline at a starting slot → **NEED**; above → **SURPLUS**. Per-FA **competition** = the needy teams most likely to bid (ranked by need × cap room).

> Baselines (re-derived): B[QB]=3.38, B[RB]=0.75, B[WR]=1.24, B[TE]=0.0.

### Estimates to keep in mind
- **QB curve is SF-era only** (correct for our format, but a narrower fit window).
- **Elite & projected prices** (the low/median/top-10 bands at the top of each board) are model projections, not observed FA sales — the most expensive players rarely hit waivers.
- **The TE market rate is an estimate** (n=1) — do not act on TE verdicts as if they were priced.

---

## 3. Headline findings

### (a) QBs were revalued ~6× — and they're *still* the cheapest position per APW
SF QB market rate is **$7,400/APW** vs preSF **$1,204** — a **6.1× revaluation** when the league went superflex (re-derived 6.3×). That's the obvious story. The non-obvious, more important story:

> **Even after the revaluation, QB is the cheapest position per all-play win.**
> **$7,400 (QB) < $15,232 (RB) < $19,048 (WR).**

RB costs **2.1×** and WR costs **2.6×** what a QB costs *per unit of the thing that wins games*. The market still under-pays QB relative to its leverage in a 2-SF-slot league. **This is the structural edge the whole engine exists to exploit.**

### (b) 0008 has a QB NEED and RB/WR SURPLUS
Re-derived from the live MFL roster (L=74598):

| Pos | starters_apw | baseline | need | surplus | label |
|---|---|---|---|---|---|
| **QB** | 0.0 (only 1 QB: Watson, below baseline) | 3.38 ×2 slots | **6.76** | 0 | **NEED** |
| RB | 7.08 (Henderson + Etienne) | 0.75 | 0 | 5.58 | **SURPLUS** |
| WR | 6.21 (McMillan + Harrison) | 1.24 | 0 | 3.81 | **SURPLUS** |
| TE | — | 0.0 | — | — | OK |

You start **two** SF-QB slots and roster **one** startable QB. That hole (need 6.76) is the single biggest item on your board — and it sits exactly on top of the position with the best $/APW. Your top QB competition is **Hawks (need 6.76, $134K)**, **L.A. Looks ($128K)**, **HammerTime ($83K)** — Hawks have an equally large hole and healthy cap, so expect them at the top of every QB you chase.

### (c) Depth gets filled on waivers — don't overpay for it at auction
Across 2020–2025, teams added **~3.3 players per team** between auction-end and Week 1 (re-derived per season: 1.3 / 3.2 / 3.7 / 4.7 / 3.5 / 3.2).

> The ~3.3 average is *dragged down* by 2020, whose auction ended very late (Aug-28) leaving little runway to the cutoff. The **2021–2025 mean is ~3.66/team.** Either way: **roughly 3–4 roster spots per team get filled cheaply on waivers after the auction.** Spending auction dollars on the 28th-best RB is paying a premium for something the market hands out for free a month later. Buy what waivers *can't* give you (a startable SF QB, a true ceiling), and let depth come to you.

---

## 4. The boards

> **Read these as "value at ADP slot," not the live waiver wire.** This valuation board prices *every* player at their dynasty-SF ADP, so elite names (Allen, Mahomes, Lamar) appear — they are the engine's illustration of *where the value lives*, not players literally sitting in your FA pool. Of the 421 FAs scored: **12 VALUE, 7 OVERPAY, 2 DART, 400 FAIR**, and **0 SPLURGE** (see §6). Prices in $K. Range = p25 · p50 · p90 expected APW.

### TOP VALUE — best APW per dollar (QBs fill 0008's need)
| Player | Pos | Rank | $K (med) | p25 · p50 · p90 | vr | Verdict | 0008 fit | Top competition |
|---|---|---|---|---|---|---|---|---|
| Jaylen Waddle | WR | WR20 | 25 | 0.76 · 2.33 · 5.01 | 1.78 | VALUE | SURPLUS | Long Haulers |
| **Matthew Stafford** | QB | QB25 | 14 | 0.58 · 3.25 · 9.61 | 1.72 | VALUE | **NEED** | Hawks, L.A. Looks, Hammer |
| **Malik Willis** | QB | QB24 | 15 | 0.58 · 3.38 · 9.96 | 1.67 | VALUE | **NEED** | Hawks, L.A. Looks, Hammer |
| DeVonta Smith | WR | WR19 | 27 | 0.89 · 2.36 · 5.01 | 1.66 | VALUE | SURPLUS | Long Haulers |
| **Daniel Jones** | QB | QB27 | 10 | 0.51 · 2.20 · 8.66 | 1.63 | VALUE | **NEED** | Hawks, L.A. Looks, Hammer |
| **Josh Allen** | QB | QB1 | 56 | 6.08 · 10.56 · 15.78 | 1.40 | VALUE | **NEED** | Hawks, L.A. Looks, Hammer |
| **Patrick Mahomes II** | QB | QB3 | 53 | 6.08 · 9.57 · 15.14 | 1.34 | VALUE | **NEED** | Hawks, L.A. Looks, Hammer |
| **Joe Burrow** | QB | QB4 | 52 | 5.86 · 9.28 · 15.10 | 1.32 | VALUE | **NEED** | Hawks, L.A. Looks, Hammer |
| **Lamar Jackson** | QB | QB2 | 55 | 6.08 · 9.57 · 15.17 | 1.29 | VALUE | **NEED** | Hawks, L.A. Looks, Hammer |
| Jameson Williams | WR | WR28 | 20 | 0.30 · 1.35 · 4.44 | 1.29 | VALUE | SURPLUS | Long Haulers |
| **Jared Goff** | QB | QB19 | 26 | 1.05 · 4.15 · 10.50 | 1.18 | VALUE | **NEED** | Hawks, L.A. Looks, Hammer |

**Eight of the 12 VALUE plays are QBs, and every one of them fills your NEED.** Allen (vr 1.40, p50 10.56) is the highest-floor option on the entire board; the mid-tier names (Stafford/Willis/Jones, vr 1.6–1.7 at $10–15K) are the best *raw value* — startable production at a fraction of the elite price. *(No FA clears the SPLURGE bar; even Allen, the best player available, lands at VALUE because his vr 1.40 < 1.5 cutoff — see §6.)*

### CHEAP DARTS — ≤$4K, low floor, real p90 boom
| Player | Pos | Rank | $K (low·med·top10) | p25 · p50 · p90 | Verdict | 0008 fit |
|---|---|---|---|---|---|---|
| **Aaron Rodgers** | QB | QB37 | 1 · 1 · 7 | 0.0 · 0.0 · **5.17** | DART | **NEED** |
| **Mac Jones** | QB | QB38 | 1 · 1 · 7 | 0.0 · 0.0 · **4.03** | DART | **NEED** |

Both are **$1K QBs with a p90 above 4** — essentially free swings at a startable-QB outcome. p50 is 0 (you should *expect* nothing), but the ceiling is real and the cost is a rounding error. For a team with a QB NEED, these are the definition of buy-the-ceiling-cheap. *(Their vr is undefined because p50=0; the ladder correctly routes a p50=0/divide-by-zero straight to DART.)*

### OVERPAY / AVOID — paying above market rate per APW
| Player | Pos | Rank | $K (med) | p25 · p50 · p90 | vr | 0008 fit |
|---|---|---|---|---|---|---|
| Parker Washington | WR | WR47 | 9 | 0.0 · 0.12 · 3.00 | 0.25 | SURPLUS |
| Jaylen Warren | RB | RB28 | 22 | 0.0 · 0.94 · 4.64 | 0.65 | SURPLUS |
| Rhamondre Stevenson | RB | RB31 | 17 | 0.0 · 0.75 · 4.43 | 0.67 | SURPLUS |
| Kyle Pitts Sr. | TE | TE8 | 15 | 0.0 · 0.17 · 2.91 | 0.71 | OK |
| Brandon Aiyuk | WR | WR38 | 17 | 0.0 · 0.70 · 4.44 | 0.78 | SURPLUS |
| Chuba Hubbard | RB | RB34 | 12 | 0.0 · 0.63 · 4.43 | 0.80 | SURPLUS |
| Isaiah Likely | TE | TE15 | 6 | 0.0 · 0.00 · 0.81 | — | OK |

Every OVERPAY here is an RB/WR/TE — exactly the positions where 0008 already has surplus. Paying $17–22K for an RB28–RB34 (vr 0.65–0.67) is the worst kind of spend: above-market rate, at a position you don't need, for production waivers will replace. *(Treat the two TE rows as soft — the TE market rate is a single-observation estimate.)*

---

## 5. 0008 bottom line — five moves

1. **Spend the room on QB.** It's your only NEED (6.76) *and* the structurally cheapest position per APW ($7,400 vs RB $15,232 / WR $19,048). Anchor on a high-floor QB — **Allen (vr 1.40, p50 10.56)** is the safest, or capture more raw value mid-tier with **Stafford / Willis / Daniel Jones (vr 1.6–1.7 at $10–15K)**. Assume **Hawks** push the price on every one of these.

2. **Weaponize the cut-free DART QBs.** **Rodgers (QB37, $1K, p90 5.17)** and **Mac Jones (QB38, $1K, p90 4.03)** are free ceiling. Stash one or both as $1K lottery tickets behind your starter — the downside is a roster spot, the upside is a startable SF-QB swing.

3. **Skip the RB/WR luxury.** You're SURPLUS at both (RB +5.58, WR +3.81). The OVERPAY list is *entirely* RB/WR/TE — don't pay above-market for Warren/Stevenson/Hubbard/Aiyuk. Any auction dollar spent here is a QB dollar you didn't spend.

4. **Let depth come via waivers.** Teams fill ~3.3 (and 2021–25, ~3.66) roster spots *per team* after the auction. Bench RB/WR depth is the cheapest thing in the league post-auction — don't burn cap on it now.

5. **Buy the ceiling, not the average.** Every slot carries a p25/p50/p90 range. At the top of your QB list, pay the median for the floor (Allen). At the bottom, pay $1K for the p90 (Rodgers/Mac). What you should *never* do is pay a median price for a slot whose ceiling you don't want — that's the OVERPAY trap.

---

## 6. Verifier caveats (folded in honestly)

- **No live SPLURGE exists.** The "Ja'Marr Chase WR1 → SPLURGE" example from earlier framings **could not be verified** — Chase is rostered (L=74598), not an available FA, and **zero** players on the 421-FA board are tagged SPLURGE. The SPLURGE rule is sound (a WR1 at p50 5.0 cheaply would clear it), but it is **unexercised on the current pool**. Treat any SPLURGE claim as illustrative, not a live engine output. The best *available* player, Allen, tops out at VALUE (vr 1.40 < 1.5).
- **QB SF rate ($7,400) is within noise, not bit-exact.** Independent re-derivation gave $7,527 (n=23) vs the artifact's $7,400 (n=24); the gap is one ambiguous fp_id→mfl_id crosswalk match. The *ordering* (QB cheapest) and the ~6× revaluation are robust.
- **Thin samples on WR (n=11) and RB (n=19).** Medians are stable but outlier-sensitive; "high" confidence means *adequate*, read it as *directional*.
- **TE rate is unsupported (n=1 each era).** Flagged `low`. TE verdicts (Pitts, Likely) are non-evidentiary — do not act on them as priced.
- **Post-auction fill (~3.3)** is faithfully what the artifact reports but is dragged down by the late-2020 auction window; the **2021–2025 figure is ~3.66/team.** The qualitative claim — depth is cheap on waivers — holds either way.
- **What *was* independently re-derived and matched exactly:** 2024 seasonal APW, all 8 E[APW] curves' monotonicity/bands/scale, the betas, RB/WR SF rates, the QB-cheapest ordering, all 421 verdicts from the band rules, price monotonicity, and 0008's NEED/SURPLUS fit + QB competition (Hawks/L.A. Looks/HammerTime).

---

*Source artifacts:* `docs/auction/data/{apw_seasonal.csv, eapw_curves.json, market_rate.json, fa_value.json, fa_valuation.csv, pricing.json}` · raw: D1 `src_weekly`, archived `transactions_auction` / `transactions_adddrop`.
