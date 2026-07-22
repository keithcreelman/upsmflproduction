# Live in-auction repricing (the "market changes as players go off the board" engine)

**Status:** built, flag-gated, OFF by default. Turn on for the 2026 FA auction by rebuilding the blob
with `--live-reprice` (see below). LRDG/commish-only surface — never public.

## The question this answers

Keith: *"Will the values change as players go off the board… if a bunch of teams have 2 QBs you might
not have much competition for a lower-priced QB3. The market needs to change."*

Before this: **no.** The pipeline blob is built once, offline. The only intra-auction correction shipped
was a single **global** scalar `live.factor = median(actual ÷ model EP)` over cleared lots — it multiplied
*every* remaining player by the same number and only after ≥3 clears. It could not make QB3 specifically
cheaper because QB rivals filled their slots. Positional supply/demand could not move a price at all
(`M_pos` is inert — `gamma` is sign-guarded to 0; see below).

## What actually happens in this league (the backtest, before building anything)

Two backtests over the SF-era auctions (2022–2025, `/tmp/ups_auction_canon.db`,
`scratchpad/backtest_exhaustion.py`):

1. **Within-auction positional exhaustion is not measurable in realized prices.** Regressing
   `log(price) ~ log(worth) + board_progress + positional_fill` gives `POS_FILL` a coefficient of +0.49
   (t=0.70) — insignificant, wrong sign. But the test is **underpowered**: with 102 credible clears its
   minimum detectable effect is a ~55–86% price collapse. A realistic 15–25% discount is invisible to it.
   *Null result, but uninformative — not evidence of absence.*

2. **The auction never fills the starting slots for QB/RB/WR.** 12 teams × 2 SF QB slots = 24, yet the
   auction sells only 12–21 QBs a season and just 2–13 are *credible* (rw ≥ $3K). Teams walk in already
   holding their starters on multi-year dynasty contracts. **So the demand that collapses is a ROSTER +
   AFFORDABILITY fact, not an auction-clear fact.** TE is the only position that saturates its 12 slots,
   and even there the price/quality ratio does fall late (0.80× → 0.67× → 0.33× as slots fill) but n is
   tiny.

3. **`gamma` (the between-season positional scarcity term) is genuinely noise.** Fitted `gamma_raw =
   −0.239` — *negative*, i.e. "more demand per unit supply → cheaper," which is backwards. It is
   sign-guarded to 0 for a reason. **Unlocking gamma would be wrong**; the backtest confirms the guard.

**Conclusion:** don't fit a price multiplier to sparse historical clears (that's what v5's between-season
`gamma`/`lambda` tried, and it barely cleared its ship gate). Instead compute a **structural, live,
forward-looking competition count** — the same causal object the model's own `competition()` forecast uses
— and turn it into a gentle, bounded price scalar. That is defensible without a price regression.

## The mechanism

At build time, `build_roster_fit.py` freezes a per-position **competitor census**: which rival franchises
(excl. 0008) are credibly in the market for each position (`comp_score > 0.3·B[pos]`, the same test
`competition()` uses). Stored in the blob as `meta.live_reprice.base_comp_fids[pos]`.

The client (both `commish_settings.html` and `site/m/views/auction.js`, same math) recomputes each poll
from the **live board**:

```
for each position pos with a census:
  surviving = # of base rivals that BOTH
     (a) have won 0 players at pos live      ← "he got his QB → he's out on QB3"   (from /api/auction/lots)
     (b) can still afford the floor rent      ← max_bid_by_position[pos].scenario_27 ≥ floor_k
                                                 (from the live team_budget_rows; reserve-aware, so it
                                                  already nets out each team's $260K-floor / 27-man
                                                  mandatory-IDP/K/P holdback)
  M_live[pos] = clamp( ((surviving + k) / (base + k))^elast , lo , hi )
```

`M_live` multiplies the **market arms only** (affine clearing line ∨ dynasty anchor), exactly like the
static `m_money`/`m_pos`/`m_elite` factors — it flows through the shared `epFactors()` seam, so the served
board **and** an ADP-override recompute both reflect it. The **startability floor is never scaled** (a
startable player's slot rent is a roster rule, not a market opinion) — the live price is recomputed via
`epRecompute()` at the player's own rank, so `max(floor, scaled_market_arm)` protects the rent. *This also
fixes the pre-existing bug where `r.e × factor` could push a floor-bound streamer below his slot rent.*

Defaults (tunables, NOT fitted — a demand census, not a regression): `elast 0.5` (sqrt → gentle),
`floor_k $3K`, `shrink k=1` (Laplace, so small rival counts don't swing), `lo 0.70`, `hi 1.15` (demand can
collapse further than it can spike mid-auction).

### Measured effect (replay of the shipped kernel, `scratchpad/sim_live2.js`)

As base-competitor QB teams fill their SF QB slots (all still cap-rich, so this isolates the slot-fill
channel):

| QBs won by rivals | surviving | M_QB | Mahomes $37 | Stafford $27 | Murray $23 | Goff $23 |
|---:|---:|---:|---:|---:|---:|---:|
| 0 | 10 | 1.00 | $37 | $27 | $23 | $23 |
| 3 | 7 | 0.85 | $31 (−6) | $23 (−4) | $20 (−3) | $20 (−3) |
| 6 | 4 | 0.70 | $26 (−11) | $19 (−8) | $16 (−7) | $18 (−5) |

The affordability channel (rivals tapping out of cap instead of winning) produces the identical curve —
both "money in the room" and "who can still bid" flow through the same surviving-count. Floor-bound
streamers (e.g. a QB whose $12 is pure slot rent) correctly **do not** drop below rent. 57 of 60 available
QBs, and ~95% of the whole board, are market-arm-bound and therefore do reprice.

## Turning it on / off

- **On:** rebuild + push the blob with the flag:
  `python3 pipelines/etl/scripts/build_roster_fit.py --live-reprice --push-d1`
  Then the client applies `M_live` whenever the auction is live and the budget/lots feeds are present.
- **Off (default):** build without the flag → `meta.live_reprice.enabled = false` → client applies nothing
  → **byte-identical to the current v5 board.** Verified: `epRecompute` at a player's own rank reproduces
  the served EP exactly for all 158 ranked FAs when `M_live` is empty.
- **Client kill-switch (no rebuild):** `localStorage.setItem('ups_live_reprice_off','1')` forces it off in
  a browser regardless of the blob flag.
- **Fail-open (hard requirement — auction is live, don't fail closed):** any missing input leaves that
  position at `M_live = 1.0` (the static price): no census → skip; budgets feed down → treat every rival as
  "still in" (never invent a discount from missing data); not live / no open lots → the whole overlay is
  1.0.

## What this deliberately does NOT do

- It does **not** unlock `gamma` (backtest says it's noise, negative-signed).
- It does **not** soften the **startability floor** even in extreme collapse — a startable player never
  prices below historically-observed slot rent. If Keith wants QB3 *rents themselves* to soften when a
  position is truly exhausted, that's a follow-up toggle (scale the floor by `M_live` too), intentionally
  left off as the riskier choice four days from auction.
- It does **not** touch any MFL write path, contract/cap logic, or the public board.
