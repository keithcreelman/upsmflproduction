# UPS FA Auction — APW Value Engine (v12, rebuilt)

**Audience:** Commissioner (franchise 0008, Real Deal Creel) · **Status:** CANON · supersedes v11.
**What changed:** Keith's live review of v11 forced six fixes. The biggest was the **APW metric itself** — it was mis-defined. This rebuild replaces it and re-derives everything downstream (curves → market rate → verdicts → pricing → roster fit). Numbers validated inline against acceptance tests + a fresh adversarial pass.

---

## 1. APW, rebuilt — standardized all-play wins

The old APW (`win_chunks × β`) was a marginal, un-saturating, **started-only** score: centered on zero, could go **negative**, over-credited tail weeks, and ignored benched/playoff games. It wasn't "all-play wins."

The new metric is the player analog of the **team all-play standings** ("the #1 all-play team beats 11, work down"):

> **Each week, score the performance against the *field at its position* (every started player at that position). The fraction of the field it beats (ties = ½) is that week's all-play win, ∈ [0, 1] — it SATURATES (a monster week beats everyone = 1.0). Sum over the season.**

- **`apw_started`** = sum over weeks the player was started (what he delivered in lineups).
- **`apw_bestball`** = sum over **all** weeks he played, started or not, **including the fantasy playoffs** — the optimal start/sit ceiling. This finally credits e.g. **Kyle Pitts' 2025 Week 15 (55.7 pts, benched + playoff)**, which the old metric threw away entirely.

It's context-free (judged on the performance vs peers, not on how teammates/opponents played — "not his fault"), standardized 0→1 per week, and **year-over-year comparable**. Scale check (2024): top ≈ **12.6** (Lamar), a median full-time starter ≈ **8**, a dud season near 0. (A literal beat-everyone-every-week season caps at ~16.)

**APW is sticky.** Elite QBs correlate r≈0.65 year over year. So the projection blends the ADP-**slot** curve (good for unknowns) with the **player's own recency-weighted trailing APW** (0.5/0.3/0.2 over the last 3 years, weight = `min(yrs/3, 0.7)`). Josh Allen's slot p50 is 8.7, but his own track record (10.6 → 15.2 → 17.7 → 15.1... on the old scale; ~10–12 on the new) lifts his projection to **~10**, not the slot median. Rookies fall back to the slot.

---

## 2. The narrative FLIPPED — and it's the honest read

We dropped the old positional-leverage **β**. It was fit to the *broken* win_chunks metric and doesn't transfer; more importantly, the **market $/APW rate already encodes positional leverage empirically** — it's measured from real auction prices, so it carries the SF premium without a hand-set coefficient.

On the corrected metric, the SF market price of one all-play win is:

| Position | $ / all-play win (SF) |
|---|---|
| **TE** | **$4,400** ← cheapest |
| **WR** | **$6,200** |
| **QB** | **$7,700** |
| **RB** | **$8,200** ← most expensive |

> **This reverses v11's "QBs are the cheapest per APW."** Once APW saturates (an elite QB and an elite WR both win ~the same share of their position field), QBs no longer look like a per-win bargain — they command an **SF scarcity premium** (you start two, so the market pays up). The genuinely cheap all-play wins are at **WR and TE**.
>
> *(Knob, if you want it: re-introducing β would tilt $/APW back toward "QBs cheap." We left it out as the more defensible, fully data-driven default — say the word and it's one line to flip.)*

---

## 3. Pricing re-anchored to the contract market — Allen = $75K

v11 priced elites off the **FA-auction record** (QB record $66K → Allen $56K). But elites command the **contract/extension market**, not the block (Julio/AJ Green/Arian Foster extended mid-high $60s; Herbert FA $51K; an elite SF QB above all of them). Rank-1 anchors are now set to the contract ceiling and the monotonic ladder cascades everyone down:

**Josh Allen QB1 = $75K** · Bijan RB1 $68K · Chase WR1 $66K · Bowers TE1 $38K. **Zero inversions** across low/median/top10. At $75K Allen is **FAIR** (≈ correctly priced for ~10 all-play wins at the QB rate) — you pay up because you *need* a QB, not because he's a steal.

---

## 4. Your roster (0008) — quality, not volume

v11 called your RB a "SURPLUS." Wrong: you have **volume but no studs**. A stud bar (top-6 dynasty APW) was added, so the fit now reads quality first:

| Pos | Your top APW | Stud? | Label |
|---|---|---|---|
| **QB** | 1.25 (only Watson) | ✗ | **NEED-STUD** |
| **RB** | 7.1 (Henderson/Etienne) | ✗ | **DEPTH** (bodies, no difference-maker) |
| **WR** | 7.0 | ✗ | **DEPTH** |
| **TE** | 5.0 | ✓ | **SURPLUS** |

Your one true hole is a **stud QB** — which is also the position that costs the most per all-play win, so don't expect a bargain there; expect to pay the market (Hawks and L.A. Looks share the QB-stud need and have cap).

---

## 5. The boards (available FAs)

Mix: **318 FAIR · 90 VALUE · 7 SPLURGE · 3 DART · 3 OVERPAY.**

### Win-now VALUE — the aging-vet arbitrage
The best values are **productive veterans dynasty has written off** — their dynasty rank is low (age), but their sticky production stays high. A **win-now production floor** prices them at what their output is actually worth (`max(dynasty price, E[APW] × market $/APW × 0.5)`) — so they no longer dump into the $1K fodder band (*Kelce will never go for $1K*), but stay below young-stud money:

| Player | Dyn rank | proj APW | Price | Value | Fit |
|---|---|---|---|---|---|
| Travis Kelce | TE21 | 6.6 | **$14K** | 2.06× SPLURGE | SURPLUS (you're set at TE) |
| Joe Mixon | RB100 | 5.3 | **$22K** | 1.98× VALUE | DEPTH |
| Stefon Diggs | WR70 | 4.5 | **$14K** | 1.97× VALUE | DEPTH |
| Justin Fields | QB39 | 2.7 | **$11K** | 1.93× VALUE | **NEED-STUD** ← cheap QB for you |
| Aaron Rodgers | QB37 | 1.9 | **$7K** | 2.08× VALUE | **NEED-STUD** |

The signal is the same (productive vets go cheaper than young studs) but the magnitude is now realistic (~2×, not 28×). Young studs are unaffected — Allen's $75K dynasty price already exceeds his production floor.

### OVERPAY — pay a premium for production that isn't there
- **Joe Burrow** QB4 $66K → proj only 5.8 APW (injury-shortened recent years) = 0.68× — paying QB4 price for QB-mid output.
- **Malik Willis** QB24 $15K → 1.4 APW = 0.71×.

### Trade targets (rostered)
The board now also carries 106 **rostered** players tagged with their owner (toggle **Show → Trade targets**) so you can value other teams' players for trade asks — e.g. Ja'Marr Chase (WR1, HammerTime), Bijan (RB1, Cleon Ca$h), St. Brown (WR6, L.A. Looks).

---

## 6. 0008 bottom line — five moves

1. **Your one need is a stud QB** — and it's the priciest position per all-play win. Either pay the market for a real QB1 (Allen-tier ~$75K, FAIR) **or** stack the cheap QB darts (Fields/Cousins/Rodgers at $1K, each a startable-ceiling flier that fills your NEED-STUD at near-zero cost).
2. **Don't pay up at RB/WR** — you're DEPTH there (bodies, no stud), and the OVERPAY list skews to positions you don't need. If you add, add a *stud*, not more depth.
3. **Mine the aging-vet arbitrage** — Mixon/Diggs/Kelce-tier vets are cheap relative to their production. Win-now gold, but budget above the $1–3K floor.
4. **Buy all-play wins where they're cheap** — WR/TE deliver the same all-play wins for ~$4–6K each vs $8K at RB; let the market overpay for RB.
5. **Depth comes on waivers** — teams add ~3.3 players/team after the auction; don't spend cap on the 30th-best RB.

---

*Source artifacts:* `docs/auction/data/{apw_seasonal.csv, eapw_curves.json, market_rate.json, pricing.json, fa_value.json, fa_valuation.csv}` · raw: D1 `src_weekly`, archived `transactions_auction`/`transactions_adddrop`. Methodology notes: APW = positional all-play (saturating, started + best-ball); β dropped (market rate carries leverage); elite prices anchored to the contract ceiling; projection blends slot + sticky trailing APW.
