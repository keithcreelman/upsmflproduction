# UPS FA Auction — Construction, Value & Win-Now (v8)

**For:** Commissioner / franchise 0008 (Keith)
**Date:** 2026-06-23 · **Status:** CANON
**Sources:** `transactions_auction` (per-bid, FA-only `auction_type='FreeAgent'`), `rosters_weekly`, `pricing.json` bands, `segments.json`, `auction_intel.json`. Adversarially verified — flagged claims below are corrected or carry an explicit caveat. **Read [`docs/league_context_v1.md`](docs/league_context_v1.md) as the rule SSOT before acting on any cap/contract item here.**

> **Format reminder:** Superflex (2 QB-eligible starting slots). This single fact drives every conclusion in this doc — QB is both the scarcest start requirement and the cheapest place to find win-now points.

---

## 0. The one-paragraph thesis

Top-2 all-play teams are not built by winning the auction's trophy lots. They are built by **owning at least one true top-tier dynasty SF QB at some price** (usually acquired *outside* the auction) and then surrounding it with **several cheap positional top-12 finishers** while **fully deploying the cap**. Your 2025 collapse (77–110 all-play, 10th of 12) was not a QB-acquisition failure — you *had* an elite SF QB1 and dealt him mid-season — it was a **cap-under-deployment** failure: you carry the most unused room in the league ($195K) and ran the league's lightest active roster. The auction fix is to spend the room on the cheap-stud tier, anchor your SF slots with $1–9K bridge QBs (the only position where cheap money reliably scores), and refuse the lone-survivor scarcity tax.

---

## 1. What wins — top-team roster construction

### 1.1 QB is bought at MARKET, not at a premium

Contenders almost never bought their **elite** SF QB1 in a big auction. The true top-6 dynasty arms came as cheap dynasty holds, rookie picks, or trades:

| Team / Year | Elite SF QB (acquisition) | Cost |
|---|---|---|
| C-Town 2024 | Josh Allen (QB1, hold) | $28K |
| C-Town 2024 | Jayden Daniels (QB5/12, rookie) | $12K |
| Pure Greatness 2025 | Drake Maye (QB15, rookie) | $8K |
| C-Town 2025 | Jaxon Smith-Njigba (WR1, hold) | $14K |

The QBs contenders *win in the auction* are **mid bridge arms**, not franchise cornerstones: Carr ~$38K, Goff/Mayfield/Mariota ~$15K, **Dak $45K (PureG 2024)**, **Purdy $28K**, **Stafford $18K (2025)**. The rule is not "spend big on QB" — it is **own a top-tier SF QB at *some* price, then buy bridges and depth.**

### 1.2 Contenders run DEEP QB rooms

Top teams stockpile startable arms rather than betting on one. *Caveat: depth figures are method-dependent — "7 QBs" is a season-cumulative peak (C-Town's week-1 snapshot was 5), and the 2025 week-1 league average was 3.42, not the cumulative ~4.3–4.7. The directional claim is solid:* contenders carry deeper QB rooms; your 2025 room was thin.

### 1.3 QB *scoring share* does not separate winners — QB *quality* does

QB share of regular-season points clusters at **~16–21%** for nearly every contender (C-Town 18–21%, Ulterior 20.3%, CBP 20.0%) — and your own teams matched it (15.5 / 16.1 / 21.8%). So the share is not the differentiator. **Whether the QB1 is a true top-6 dynasty SF arm is.**

### 1.4 Cap commitment to QB is bimodal — both shapes win

| Shape | Example | QB cap | Notes |
|---|---|---|---|
| Pay up | C-Town 2024 (Tua $86K + Allen $28K) | 40.2% | |
| Pay up | C-Town 2025 (Allen $46K + Lamar $46K) | 36.3% | |
| Pay up | CBP 2023 | 32.2% | |
| Stay cheap | Pure Greatness 2025 (Mayfield $36K + Maye $8K) | 16.7% | spends elsewhere |

There is **no single "spend big on QB" rule.** Own the arm; the price is negotiable.

### 1.5 The winning engine: several cheap positional top-12 finishers

Top teams roster multiple **pos_rank ≤ 12 at ≤ $15K**: 2024 C-Town had 6, 2023 Blake 5, 2025 Pure Greatness 4. Examples: **Brock Bowers TE1 $9K, JSN WR1 $14K, Jahmyr Gibbs RB4 $11K.** These cheap top-12 finishers *fund* the 1–2 marquee anchors.

### 1.6 You already executed the blueprint — the gap was the rest of the roster

You rostered the elite QB the league wins with — **Lamar Jackson 2022–2024** (295.9 / 402.9 / 523.5 pts at just $17K / $37K / $37K) — and still didn't break top-2. The QB was never your problem.

### 1.7 The 2025 cautionary tale (corrected)

> **Verifier correction.** The earlier framing ("your 2025 QB room collapsed — you had none") was a **false premise.** `rosters_weekly` shows you **started 2025 with Lamar Jackson at $46K (elite SF QB1) plus Kyler Murray at $8K.** Lamar was then **traded away mid-season** (by wk17 the room was Cousins/Winston/Willis/Rivers/Flacco). So the failure was a **mid-season trade decision**, not an inability to acquire a top-tier arm. Your QB points share did fall to a league-low-ish **12.1%**, and you finished **10th of 12** in all-play (77–110) — *not last; 0002 and 0003 were below you.*

### 1.8 The single biggest 2025 red flag: cap under-deployment

> **Verifier caveat on specific figures.** The exact active-salary snapshot ($152K vs $287–361K) could not be reproduced from queryable tables — `rosters_weekly` puts your 2025 active roster in the **$127K–$223K** range and contenders at **~$251K–$313K**. Treat those specific dollar figures as a derived snapshot, not hard data.

**The core claim is fully supported:** you hold the **most cap room in the league — $195K** (`segments.json league_room_now`; next 0002 $150K), against a $300K ceiling. Whatever the exact active-salary line, you ran light and **left roughly $100K+ of buying power unused** while every contender ran a heavier roster. In this format your problem is **under-investment, not over-paying.**

---

## 2. Where the value is — cheap $1–9K wins that scored

### 2.1 QB is the value engine, full stop

Of cheap ($1–9K) FA QB wins (2011–2025), roughly **31–34%** hit a 15+ reg-ppg / 10+ game starter line.

> **Verifier correction.** The headline "39%" was **inflated** (it required a 123-win denominator that could not be reproduced). On the full FA-only cheap-QB set the denominator is ~156 (142 matched to points) → **30.8–33.8%.** The *relative* gap is real and stark:

| Position | Cheap-win starter hit rate |
|---|---|
| **QB** | **~31–34%** |
| WR | 4.1% |
| RB | 2.2% |
| TE | 1.9% |

No other position is close. In Superflex a $1–9K QB that posts 17–24 ppg is a **structural roster-builder**, not a flier.

### 2.2 The $1K nomination-floor tier (cut-free) has produced league-winners

A $1K QB risks **nothing** (cut-free at ≤$4K) and the upside is a QB1: Alex Smith ($1K → 22.8 ppg, Cutting 2017), Ryan Fitzpatrick ($1K → 21.6, K. Creelman 2015), and **your own** Alex Smith ($1K → 18.2, 2015) and Jared Goff ($1K → 17.7, 2020).

### 2.3 Best raw value in the dataset

| Player / Year | Owner | Cost | Production | Pts/$1K |
|---|---|---|---|---|
| Ryan Tannehill 2020 | Blake | $2K | 370.8 / 24.7 ppg / QB7 | 185 |
| Carson Palmer 2015 | R. Bousquet | $3K | 366.9 / 24.5 / QB3 | 122 |

Top-5 QB seasons bought for cut-free money.

### 2.4 The modern well still flows — cheaper than ever

Hit rate dipped (15% QB1-ish 2022–25 vs 34% 2018–21), but the **average cheap-QB bid dropped to $2.6K (modern) vs $3.8K (early)** — the format prices these *cheaper* now. Recent hits: Sam Darnold 2024 $7K → 24.2 QB7; Geno Smith 2022 $5K → 22.5 QB6; Baker Mayfield 2023 $5K → 21.8; **your Garoppolo 2022 $5K → 19.4 QB-startable.**

### 2.5 Skill-position cheap hits are rare and profile-bound

Only two repeatable profiles:
- **Aging-vet WR target hogs:** Thielen $4K → 15.3; Patterson $1K → 17.2; Meyers $4K → 14.7; Jeudy $3K → 15.7.
- **RB handcuffs one injury from a workload:** Hubbard $6K → 16.9; Dowdle $4K → 14.5; Dobbins $9K → 15.6.

Do **not** spend $5K+ at WR/RB hoping for a breakout — the cheap-skill hit rate is 3–5%.

### 2.6 TE is a dart; IDP / K / P "value" is illusory for win-now

Occasional TE top-5 (Jonnu Smith $1K → 13.7 TE4; Goedert $7K → 15.1 TE6) at a ~2% hit rate. For IDP/K/P, **zero** cheap wins ever cleared a 15-ppg starter bar — the position ceiling is simply low.

> **Verifier note (counts corrected, conclusion intact).** The zero-hits conclusion is **confirmed** (LB/S/DE/PK all 0 hits). The earlier per-position counts were off — actual: **S=239, LB=399, DE=224, PK=167.** These are roster-fillers, not difference-makers.

### 2.7 You already run this playbook well

Your cheap QB wins include Garoppolo ($5K → 19.4, 2022), Goff ($1K → 17.7, 2020), Alex Smith ($1K → 18.2, 2015), Flacco ($2K → 19.0, 2014), Dalton ($3K → 22.1, 2015), Rivers ($8K → 21.7, 2018).

> **Verifier note.** Your cheap (1–9K) QB FA wins number **19**, not 15. Your misses were small-sample punts (Mike White $2K/0.2/6g; Brissett $3K/5.3/8g) — cheap enough to cut clean. The league's other cheap-QB hunters: Cutting, Bear Dunn (Dalton/Heinicke/Mariota all $1K hits), Ryan Bousquet.

---

## 3. Scarcity — the lone-marquee premium, and how to use it

> **Verifier caveat on the statistics in this section.** The derived analytics below (Pearson −0.265, "16-percentile flooding discount," "46% of top-quartile are last-survivors," `rivals_open`/`nearWin`) are **not stored in any data file** and require the build pipeline's nomination-time concurrency computation — they are **unconfirmed**. Henry's underlying *timeline* (closed last, after every 2023 cohort marquee) **is verified.** Treat the percentages as directional, the mechanism as sound.

### 3.1 Henry $94K (2023) — the cleanest case in league history

Single largest FA-auction win all-time (**franchise 0008, Keith**; next AB $79K 2019, Foster $77K 2012). He bought a dynasty SF **RB17** sitting in the RB 11-20 band — whose median win is **$34K** and whose p90/max is **$94K**. Henry **is** that ceiling, **+$60K (2.8×) over the band median.**

> **Sample-size caveat.** The RB 11-20 SF-era band is **n=3, and Henry is one of the three** — so he partly *defines* his own p90/max. The +$60K premium is real in magnitude but the band comparison is partly circular.

### 3.2 It's a LAST-STUD-STANDING effect, not isolation

Henry **opened** 2023-07-29 alongside 6 other $18K+ lots (Rodgers $50K, Mixon $41K, M. Brown $37K, Godwin $27K, Allen $28K, Goedert $22K) but **closed last** on 08-04 14:55 — every other marquee had resolved by 08-03 12:56. At his winning bid: **0 open marquee rivals.** Nominating a stud onto an *empty* board does **not** raise its price (concurrency *at nomination* trends negative). The premium appears only when a lot **outlasts its cohort** and becomes the lone magnet displaced bidders pile onto.

### 3.3 Flooding the board suppresses prices

Within-season normalized, lots nominated with **8+ marquees already open** finish near the **0.46** price percentile vs **0.62** for lots with only 1–3 open — a **~16-point crowding discount** (directional). Last-survivor lots are heavily over-represented at the top of the price distribution.

### 3.4 The worst overpays are *replacement-level* players dragged up by scarcity

Not elite players — **"last QB/RB left" reaches**: Stafford QB29 $18K (18× band median), Diggs WR55 $20K (10×), Mostert RB43 $20K (6.7×). Same survivor dynamic, applied to scrubs.

### 3.5 Position matters for the survivor tax

| Band | Median → p90 |
|---|---|
| RB 11-20 | $34K → $94K (widest blowout) |
| QB 17-28 | $18K → $50K |
| WR 31-50 | $16K → $32K (flattest) |

**RB and QB are where bidding wars blow out. WR scarcity is structurally cheaper.**

### 3.6 Your marquee profile

You are the all-time marquee-**win** leader **by count** — 30 wins of $18K+ totaling **$872,996** (Mannila spent more, $1,064K on 29; Cutting $880,009 on 26). You repeatedly win studs that opened onto an **empty board** (Henry $94K, McFadden 2011 $41K, MJD 2012 $35K, Brady 2013 $33K) — i.e. you are the one who nominates the lone stud and then pays the survivor tax.

---

## 4. Dynasty vs redraft — the win-now framework

### 4.1 Henry 2023 was a textbook redraft-over-dynasty overpay

$94K bought a dynasty SF **RB17** (age 29.6, dyn value 1,970) who was redraft **RB7** (ovr ADP 21). It was structured as a multi-year **"Veteran"** contract — carried at $94K all of 2023, then traded to 0003 and **restructured down to $18K "BL" by 2024.** A one-season rental that became a multi-year commitment risk.

**It UNDERdelivered the redraft thesis:** 15.0 reg ppg / 240 pts / **RB8** in 2023 (RB-mid, not RB7-elite) — then bounced to 20.97 ppg / 335.5 pts in 2024 on Baltimore *after* you sold. Paying RB7 price bought RB-mid production: the core risk of single-season win-now bets.

### 4.2 Marquee win-now buys are a coin flip — age + injury is the tail

| Buy | Cost | Result |
|---|---|---|
| Herbert 2025 | $51K | 22.1 ppg ✅ |
| McCaffrey 2025 | $56K | 25.97 ppg ✅ |
| Ekeler 2022 | $57K | 22.8 ppg ✅ |
| Brady 2022 | $66K | 22.2 ppg ✅ |
| **Rodgers 2023 (age 39)** | **$50K** | **week-1 Achilles, −1.0 pts ❌ total bust** |

### 4.3 You are a re-tooler, not a contender — pay dynasty price

| Year | All-play | PF |
|---|---|---|
| 2022 | 112–75 | 3,064.9 |
| 2023 | 105–82 | 3,046.5 |
| 2024 | 96–91 | 3,027.6 |
| 2025 | **77–110 (10th/12)** | **2,912** |

You sit **~293 PF below the 2025 top-2 bar** (C-Town 3,218.6 / Pure Greatness 3,197.6; the ~3,205 benchmark). A win-now overpay is hardest to justify for a team this far out.

### 4.4 A big chunk of the gap is lineup leakage, not talent

Your 2025 **potential points 3,217 vs points-for 2,912 = a ~305-pt efficiency gap** — bigger than most rivals'. That's ~19 ppg left on the bench. **Closing even half of it gains more toward the bar than a single $94K veteran would, at zero cap cost.**

### 4.5 The contract tiers that change the bet

- **$1K nomination floor / ≤$4K cap-free:** a true **no-penalty one-year dart.** This is your win-now sandbox.
- **$5K+:** converts the bet into a **multi-year cap commitment** you must trade or eat (exactly what the Henry rental became).

> **Verifier correction — $4K-tier leadership claim was FALSE.** The earlier claim ("you lead the league in $4K wins, 15 times, ahead of Ryan/Cutting at 13") is **wrong** and is dropped. Actual `transactions_auction` (FA-only, bid=4000): **you have 18 wins, ranking 7th-tied.** Leaders are **Josh Martel 27, Brian Cutting 26, Ryan Bousquet 25** (not 13). The league-wide total at exactly $4K is **265 wins**, not 117. You are a *frequent* user of the cap-free tier — not the leader — and that's still the right tier for win-now darts.

### 4.6 Spend is concentrating at the top

2025: **52% of FA wins at the $1K floor** but **8.8% at $18K+** — the highest big-ticket share since 2019. The middle hollows out; the overpay battles are at the very top of the board.

---

## 5. 0008 bottom line — five concrete moves

You hold the **most cap room in the league ($195K** of ~$1,033K active, ~19%; next 0002 $150K) against a $300K ceiling. Room is not your constraint — **contention timeline is.** Build the dynasty, deploy the room into assets, and refuse the trophy-lot tax.

**1. Spend the cap — deploy the room into the $5K+ multi-year tier on young assets.**
Sitting on $195K is the opposite of every top-2 roster's shape and correlates directly with your last-place-ish 2025 all-play. Convert room into multi-year talent **under ~26** whose dynasty *and* redraft ranks both justify the price. Your problem is under-investment.

**2. Anchor your two SF slots with $1–9K bridge QBs — the only cheap position that scores.**
QB hits a starter line **~31–34%** of the time cheap vs **2–4%** everywhere else. Nominate every veteran QB with a clear starting job at the **$1K floor**, let it ride to **~$5K max** (modern winners average $2.6K), and cut clean if it busts. Target the repeatable profile: a competent vet walking into a new/secure job (Darnold '24, Geno '22, your Garoppolo '22). De-prioritize dual-threat lottery tickets in tiny samples (your Brissett/White misses).

**3. Re-acquire and KEEP a top-tier dynasty SF QB.**
Every top-2 team owned a true SF QB1–6. You had Lamar in 2025 and **traded him away** — the failure was the deal, not the draft. Lock one young ascending SF arm (rookie-draft or buy-and-extend) and **don't sell it mid-season for a non-contending return.** Build a 5+ deep room behind it with $1–2K backup arms — in a 2-SF-slot league, a backup that posts QB20 weeks is a real lineup edge.

**4. Buy cheap positional top-12 finishers, not names — and refuse the survivor tax.**
The winning rosters carried 4–6 players who finished pos_rank ≤ 12 on sub-$15K deals (Bowers $9K, JSN $14K, Gibbs $11K). Weight $$ toward several mid-priced ascending starters over one or two trophy buys. **Never be the last stud on the board** — Henry $94K (your biggest overpay) happened because you let him outlast the whole cohort. Pre-commit a band ceiling (a dynasty RB11-20 is a ~$34K player; p90 $94K is the war price you must refuse), and when you *do* want a marquee, **flood the position** with 2–3 comparable nominations first to split the room's money. If you must win a lone survivor, pivot to **WR**, where the tax is structurally smaller (p90 $32K vs RB $94K).

**5. Bank the room as a war chest, not a July splurge — and fix the lineup leak first.**
Use the **$4K cap-free tier as your only win-now sandbox** (zero-downside one-year darts at high-redraft/low-dynasty vets — RB handcuffs, post-hype WRs). Reserve real cap for $5K+ multi-year deals only on the young-and-dual-positive profile. Close the **~305-pt PP-vs-PF efficiency gap** before spending on talent — half of it beats a $94K veteran toward the bar at no cap cost. Deploy the marquee swing only when you're within **~100 PF of the bar**, on dynasty-AND-redraft-positive assets — not a one-year rental that leaves at a discount.

---

*Verifier confidence: **high**. Corrections folded in: the $4K-leadership claim (false — dropped), the 2025 "no QB" framing (false premise — corrected to a mid-season trade), the 39% cheap-QB hit rate (inflated → 31–34%), the active-salary snapshot and scarcity correlations (unverifiable → flagged as derived/directional), the "finished last" line (→ 10th of 12), and the RB 11-20 band (n=3 small-sample caveat). All CONFIRMED facts — Henry $94K, the all-play/PF decline, the $195K room, the named cheap-QB hits, the marquee outlier overpays — carried through unchanged.*
