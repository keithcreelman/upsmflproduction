# UPS FA Auction — Contract-Aware Value & Strategy Model (v10)

**For:** Keith / 0008. Re-runs the value model (`pricing.json`) with the **contract mechanics** baked in (per the v9 league review). Output: `docs/auction/data/strategy.json` (`build_auction_strategy.py`). The premise: **in this league a high price is not dead money if the deal is short or tradeable** — so each player is scored on *two* lenses and tagged with a deal type + its true forward cost.

## What each player gets

- **Expected price** — low (p25) / median (p50) / top-10% (p90) in $K, from the SF-era winning-bid bands by dynasty-SF rank.
- **Win-now grade** (redraft rank, FantasyCalc SF) — production *this* season.
- **Asset grade** (dynasty-SF rank) — long-term value + flip/trade value.
- **Price confidence** — `model` (the player's dynasty-rank band has real auction samples) or **`projected`** (elite ranks — QB1-6, RB1-4, WR1-6, TE1-3 — that *never hit the auction*, so there's no band data; they're priced **up a monotonic ladder toward the position's record win**, not off the fodder blend). The projected price is a defensible estimate; expect real bid variance if one surfaces. 53 current players are `projected`.

  > **Monotonicity guarantee (fixes the v10.0 Josh-Allen artifact).** The price is a non-increasing function of dynasty-SF rank, so a *better*-ranked player can never be cheaper than a worse one. The rank-1 marquee median is anchored at **0.85× the position's SF-era record win** (or 1.35× the richest reliable band, whichever is higher), with the top-10% reaching the record. Result: Josh Allen (QB1) = **$56K** median (not $4K) and the clear top QB, above Dak (QB15, $35K) and Kyler (QB17, $30K); Bijan (RB1) = $80K ≈ 0.85× Henry's $94K record.
- **Deal type + true cost** (the contract layer):

| Deal type | Who | True forward cost |
|---|---|---|
| **Cut-free dart** | price ≤ $4K, 1-yr | **$0 downside** — cut anytime (1-yr ≤$4K, §D2). Pure win-now flier. |
| **1-yr rental / flip** | older (≥28), redraft ≫ dynasty | Expires clean at roll-forward, **or trade penalty-free** (§D3). A bounded one-season bet — rent the production or flip for assets. |
| **Multi-year build** | young (≤26), dynasty-strong | Worth a MYAC; the asset holds value and flips for picks later. |
| **Anchor** | elite in BOTH lenses | Pay up and build around it. |
| **1-yr / situational** | everyone else | Keep it 1-year; a redraft bet with trade optionality. |

Mix of the current board: **607 cut-free darts, 63 situational 1-yr, 9 rental/flips, 5 multi-year builds.** Most of the auction is genuinely zero-downside.

## How this reframes your bids (contract-correct)

- **A $38K dynasty-QB11-16 on a 1-year deal is a bounded rental**, not a dynasty commitment — if he busts you owe nothing next year; if he hits you can flip him. Don't let the sticker scare you off.
- **The "war price" is still the p90** (e.g. RB11-20 = $94K) — but the reason to refuse it isn't dynasty risk, it's that you're overpaying for *one season* of a tradeable asset you could get for the median.
- **Cut-free darts ($1-4K) are free options.** With 607 of them, depth is cheap — spend the cap on the few `model`-priced mid-tier players who raise your PP ceiling.
- **Only MYAC/extend a rental if you're truly contending** — that's the single move that converts a clean 1-year bet into a real `TCV×0.75 − earned` liability.
- **Projected elites** (the top QB/RB/WR/TE) are now priced where they'd actually land — up the ladder toward the position record — so the board no longer hides a $56K Josh Allen behind a $4K artifact. Treat any such appearance as a max-tier event and budget for the top-10% (record) number.

## Examples (current board)

- **Dak / Lawrence / Nix** — dynasty QB11-15, redraft B, **$38K median**, 1-yr/situational: bounded SF QB1/2 rentals.
- **C.J. Stroud** — dynasty QB16 but redraft QB24, age-23 → **multi-year build** (young asset, weak redraft = own him, don't rent him).
- **George Kittle** — dynasty TE6, redraft A, age-31 → **1-yr rental / flip** ($9K model): rent the production, flip or let it expire.
- **Trey McBride / Brock Bowers** (TE1-2) — `projected` ~$25K (TE1 record-anchored): no TE1-3 has ever hit the block, so this is a ladder estimate, but it's now in the right ballpark instead of a meaningless $2K.

The model is **directly reliable** (`model`) for the tiers that actually hit the auction (QB9+, RB11+, WR16+, TE6+) and **`projected`** (record-anchored, monotonic) for the elite tiers with no auction history — so the whole board sorts correctly by expected price.
