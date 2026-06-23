# UPS FA Auction — Contract-League Corrections (v9)

**For:** Keith / Real Deal Creel (0008). **Supersedes the dynasty-lens errors in v8.** A league review (full read of `docs/league_context_v1.md`) + a data re-check corrected three things the v8 brief got wrong. UPS is a **contract** league, not straight dynasty — that changes the auction calculus.

## 1. The Henry $94K play — v8 was factually wrong (it expired clean; you DO flip well)

v8 told a single story: "$94K → multi-year Veteran → restructured to $18K BL → you sold before his bounce-back." **That stitched together two unrelated Henry contracts.** Verified (`transactions_auction`, `transactions_trades`, `rosters_weekly`):

- The **2023 $94K win was a 1-year Veteran deal (`CL 1`)** that **expired** at the March-2024 roll-forward. You owed **zero** afterward — no penalty, no forward cap, no dynasty tail. You did **not** trade him in 2023. This is a textbook **1-year win-now rental** — the league-correct structure.
- The **$18K back-loaded deal was a *different* contract** — Henry re-entered the **2024 auction, won by Gerardi (0003) for $34K**, who built the 2-yr `[Y1-18 Y2-50]`. You only later acquired *that* Henry via a mid-season 2024 trade, then **flipped him in March 2025 for the 1.05 pick** (`trade2025_8`). So the "sold before his bounce-back" critique is doubly wrong — the $94K deal had already expired, and the Henry you *did* sell returned a 1st-round pick.

**Net:** you understand win-now-then-flip. The only fair critique of the $94K is *production variance* (Henry posted 15.0 ppg / RB-mid in 2023) — a bounded one-season bet, not a dynasty liability.

## 2. Dynasty vs redraft, corrected for a contract league

The cap/contract rules **decouple price-paid from long-term cost**:
- **Ceiling is OFF in the offseason** ($300K applies only auction-start → season-end; §6.A1). "$195K of room" is a constraint only *during* the auction window — not a year-round war chest.
- **1-year deals ≤ $5K are cut-free** (0% guarantee, §D2/§6.C2) — pure redraft darts with zero downside.
- **Trading sheds a contract with NO penalty** — the cut formula `(TCV×0.75 − earned)` doesn't fire on a trade (§D3/§6.E2); players with 1+ yr left are tradeable through Thanksgiving (§A6).

→ **Paying a redraft/win-now price is rational here when** the deal is (a) 1-year (expires clean), (b) in the $1-4K cut-free tier, or (c) something you can flip for assets mid-season. It only becomes a dynasty liability if you **MYAC/MYM/extend** the rental into multi-year (then `TCV×0.75 − earned` exit costs apply).

**So v8's "you're a re-tooler → pay dynasty price" was wrong.** A re-tooler should **weaponize** short/cut-free/tradeable deals — rent production for a push *or* arbitrage value and flip — exactly what you did with the 2025 Henry-for-1.05 trade.

## 3. The QB read, corrected for Superflex

v8's "QB is the $1-9K value engine; never pay up" leaned on **pre-SF data**. SF-era only (2022-2025): cheap ($1-9K) QB wins hit a 15+ ppg / 10+ game starter line **20% of the time** (8 of 40) — still real (Darnold $7K→24.2, Geno $5K→22.5, Mayfield $5K→21.8, your Garoppolo $5K→19.4), but **lower** than the inflated 39%.

The SF nuance v8 missed: **you start two QB-eligible slots**, so cheap QBs fill the **second** slot — they do **not** replace a genuine QB1. The difference-making QBs (top-6 dynasty SF arms) come via rookies/trades, but in a 2-QB-start format you still need **two startable arms**, and a cheap streamer for slot-2 is value, not a substitute for quality up top. Buy cheap QBs for **depth/slot-2**; secure a real QB1 separately.

## 4. Lineup efficiency — you're NOT leaking; you lack talent

v8 said "fix the 305-pt lineup leak." Measured correctly as **PF ÷ potential-points** (reg season, 2022-2025):

| Rank | Team | PF/PP efficiency |
|---|---|---|
| 1 | Hawks | 90.9% |
| **2** | **★ Real Deal Creel (you)** | **90.7%** |
| 3 | C-Town (contender) | 90.2% |
| … | Pure Greatness / CBP (contenders) | 88.3% |
| 12 | Blake (contender) | 87.5% |

**You are the 2nd-most-efficient lineup-setter in the league — above all three contenders.** The absolute "305-pt gap" just reflects that contenders carry more bench talent (higher PP), so they have bigger absolute gaps at the *same or worse* efficiency. **Your shortfall is raw talent (a lower PP ceiling), not management.** Fixing lineups won't close the ~293-PF gap to the 3,205 bar — **adding scoring talent will.**

## 5. 0008 bottom line (contract-league corrected)

1. **The under-deployment point still stands** — you carry the lightest active roster (~$105K) and the most room. But deploy it **during the auction window** (the ceiling's off in the offseason), into **scoring talent** that raises your PP ceiling — that's your real gap, not lineup management.
2. **Keep using 1-year + cut-free + tradeable deals as your win-now engine.** You already flip well (Henry→1.05). A $50K 1-yr rental you can flip at the deadline is a *bounded* bet here, not a dynasty trap — don't let the dynasty lens scare you off a win-now buy if you can keep it short or tradeable.
3. **Don't MYAC/extend a win-now rental** unless you're truly contending — that's the only move that converts a clean rental into a real `TCV×0.75 − earned` liability.
4. **Secure two startable SF QBs**, not just cheap depth. Cheap QBs (≈20% hit) fill slot-2; the QB1 is a real investment (or a rookie/trade target).
5. **Hunt scoring talent (PP), not lineup tweaks.** You set lineups better than the contenders already; the way to the bar is more points on the roster.
