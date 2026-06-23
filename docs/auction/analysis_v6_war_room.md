# UPS FA Auction — War Room Scouting (v6, commish-only)

**For:** Keith / Real Deal Creel (franchise **0008**). **Scope:** the **FA Auction only** (`auction_type='FreeAgent'`, late July / early Aug) — the spring ERA/tag auctions are excluded. **Window:** 2014–2025, **strong emphasis on the Superflex era (2022–2025)**. **Source:** per-bid `transactions_auction` → `build_auction_intel.py` → `auction_intel.json` (10,024 FA bids, 2,273 lots). Per-owner narratives were written by a 12-agent scout fan-out; the head-to-head, benchmark, and these numbers were verified deterministically against the raw bids (the agent verifier/synth pass was cut short by a session limit, so the commish did that pass directly — every stat below is re-derived from the data).

---

## The brutal truth: you lose the head-to-head to everyone

In SF-era lots where **both you and an opponent actually bid**, here is who won the lot:

| Opponent | Keith's record | Read |
|---|---|---|
| **Hammer (0005)** | **2–11** | Gets out-muscled worst of all. He simply outlasts you. |
| Cleon (0011) | 1–6 | QB lurker who beats you when you both want a passer. |
| Dunn / C-Town (0009) | 0–3 | Small sample but a clean sweep — dawn RB hoarder. |
| Cutting / Pure Greatness (0004) | 3–7 | The whale outspends you. |
| Kling / Hawks (0012) | 3–7 | Cheap WR scrounger steals the bin. |
| Whitman / CBP (0002) | 5–10 | Late morning sniper. |
| **Blake (0010)** | **8–12** | Most-contested rival (20 shared lots); your marquee-RB nemesis. |
| Gerardi / Gride (0003) | 5–7 | Late lurker who jacks your price. |
| Cross / Long Haulers (0006) | 5–7 | Quiet bin-muscler. |
| Josh / Sex Manther (0007) | 5–6 | Barbell bidder, ambushes one star a year. |
| Ryan / L.A. Looks (0001) | 10–11 | Closest to even — he pushes price but rarely closes. |

You were the **runner-up 69 times** in the SF era — the league's perennial bridesmaid. The two ways you lose are exactly your two stated fears, and they have names below.

---

## Danger board (ranked by threat to 0008)

| # | Owner | Threat | Why |
|---|---|---|---|
| 1 | **Hammer (0005)** | 🔴 high | 2–11 vs you. Highest **post-win pounce 0.705** — winning a lot just launches him at the next one. Morning shift (5am/8am ET). RB/QB bully. |
| 2 | **Blake (0010)** | 🔴 high | Most shared lots with you (20) and most lurking of anyone (**runner-up 53×**) — he sits behind you on marquee RBs and bumps. Pounce 0.578, 2.27 follow-ups. Dawn (6–7am). |
| 3 | **Cutting / Pure Greatness (0004)** | 🔴 high | The whale: **$430K** SF spend, 7 marquee, max **$56K**. Pounce **0.672 / 2.64 follow-ups** — relentless after a win. Dawn patrol (6–7am). Outspends you on RB/QB. |
| 4 | **Josh / Sex Manther (0007)** | 🔴 high | Barbell: floods cap-free, then detonates **one** star (max **$66K** Brady). Overtakes you on marquee. Midday (2–3pm). Bids latest of the high group (46.8% under 8h). |
| 5 | **Gerardi / Gride (0003)** | 🔴 high | The latest lurker in the league — **52.2%** of his bids land with <8h on the clock — overtakes often and has personally jacked your price up. Midday/afternoon. |
| 6 | Ryan / L.A. Looks (0001) | 🟡 med | **Price-pusher, not a thief.** Runner-up 37×, pounce 0.65 / 2.47 follow-ups, but only converts cheap; max $38K. Night owl (10pm–midnight). |
| 7 | Cleon / Cleon Ca$h (0011) | 🟡 med | QB specialist — lurks the underbidder on marquee QBs/WRs, pounces a second target. Late (48% under 8h). Early (5am) + noon. |
| 8 | Dunn / C-Town (0009) | 🟡 med | 0–3 vs you (small) but a chronic bridesmaid (runner-up 32) who bumps early. Dawn RB hoarder (5–7am). The model contender (see benchmark). |
| 9 | Whitman / CBP (0002) | 🟡 med | Mostly nibbles, but lurches awake to snipe a marquee WR/RB near lock — bumped you on **Kamara $27K (2024)**. Morning (8–9am). |
| 10 | Cross / Long Haulers (0006) | 🟡 med | Bottom-of-board grinder, lurks late (46% under 8h), quietly muscles you on filler. Night/early. |
| 11 | Kling / Hawks (0012) | 🟡 med | Late-night WR scrounger, cap-free, occasional $24K spike. Night owl (10pm–midnight). |

---

## Your two fears, by the numbers

**Fear #1 — the post-win POUNCER** (wins a player, then immediately swings at *any* other open lot, especially with <8h left). Share of their wins followed by a bid on another lot within 8h:

| Owner | Pounce share | Avg follow-ups |
|---|---|---|
| Hammer (0005) | **0.705** | 1.4 |
| Cutting (0004) | **0.672** | **2.6** |
| Ryan (0001) | 0.65 | **2.5** |
| Blake (0010) | 0.578 | **2.3** |
| Josh (0007) | 0.571 | 1.0 |
| Cleon (0011) | 0.569 | 1.3 |

→ After **you** win something, assume Hammer, Cutting, Ryan, and Blake are already working the rest of the board. **Lock your must-haves early — don't leave them in the late pool while you're busy winning elsewhere.**

**Fear #2 — the late LURKER / underbidder** (sits second, pushes you up, then bumps near the 24h lock). Two signals: how often they're the underbidder (runner-up count) and how late they bid:

| Owner | Runner-up (SF) | % bids <8h to lock |
|---|---|---|
| Blake (0010) | **53** | 31% |
| Ryan (0001) | 37 | 35% |
| Dunn (0009) | 32 | 41% |
| Cutting (0004) | 24 | 24% |
| Gerardi (0003) | 18 | **52%** |
| Cross (0006) | 22 | 46% |
| Cleon (0011) | 12 | 48% |
| Josh (0007) | 12 | 47% |

→ **Blake** sits behind you more than anyone; **Gerardi, Cleon, Josh, Cross** strike latest. On a lot you genuinely want, expect a late bump from these — see the playbook.

---

## Time-of-day map (when each owner is live, ET)

| Window | Owners camped there | Implication |
|---|---|---|
| **Dawn 5–9am** | Hammer, Cutting, Dunn, Blake, Whitman, Cleon | A cheap RB/QB left sitting overnight gets hunted at sunrise. This is the most dangerous window for your run-game targets. |
| **Midday 12–4pm** | Gerardi, Josh, + a broad noon pulse | Marquee ambushes (Josh, Gerardi) tend to fire here. |
| **Late night 10pm–midnight** | Ryan, Kling, Cross | Price-pushing volume while the league sleeps. A WR parked cheap into the night gets bid up. |

You (0008) peak at **midnight, noon, 5am** — you're around at the dangerous dawn and late windows, which is good; use it.

---

## Contender roster benchmark (what you're building toward)

Top-2 **all-play** teams since Superflex and their points-for:

| Season | #1 all-play | #2 all-play |
|---|---|---|
| 2025 | Pure Greatness — 3198 PF | C-Town — 3219 PF |
| 2024 | C-Town — 3261 PF | Ulterior Warrior — 3190 PF |
| 2023 | CBP — 3277 PF | Blake Bombers — 3165 PF |
| 2022 | C-Town — 3084 PF | Pure Greatness — 3251 PF |

**The bar: ≈3,205 points-for** (range 3,084–3,277), ~70% all-play. That's ≈**188 PPG** across a 17-game season. **C-Town Chivalry (0009)** is the model — #1 all-play in 2022 & 2024 — and notably a dawn-patrol RB hoarder in this auction. Translation for your FA budget: the contenders win on **week-to-week scoring depth**, not one marquee splash — which argues for winning your share of the **mid-tier ($10–17K) bets** the field mostly skips, rather than only fighting (and losing) the cap-free scrums and the marquee wars.

---

## Tactical playbook for 0008

1. **Stop being the bridesmaid.** 69 runner-up finishes = a lot of price-pushing that just disciplined rivals' budgets and left you empty. On any lot: **bid to win or stay out.** Don't nibble a guy up unless you'll take him.
2. **Proxy your true max, once.** The 24h-reset lock rewards a single honest proxy ceiling over incremental nibbling — nibbling is what invites Blake/Gerardi/Cleon to bump you at the buzzer. Set your real number and let it ride.
3. **Pouncer guard.** Right after you win, Hammer/Cutting/Ryan/Blake are pouncing elsewhere. **Sequence your nominations so your must-haves close early**, not while you're tied up winning something else.
4. **Lurker guard on your marquee RBs.** Blake is your single most-contested rival and sits behind you on big backs (he's 12–8 vs you). If you open an RB you love, expect his late bump — open it at a price that already deters him, or be ready to go past his ~$38K ceiling.
5. **Mind the windows.** Don't leave a run-game target cheap into **dawn** (Hammer/Cutting/Dunn/Blake) or a WR cheap into **late night** (Ryan/Kling/Cleon). Nominate those into *their* dead hours if you want them cheap.
6. **Pick 1–2 marquee fights, max.** The whales (Cutting $56K, Josh $66K, Cleon $51K) will beat you on stars unless you commit early and high. Don't spread thin across many marquee names — you'll lose all of them as the underbidder.
7. **Own the mid-tier the field avoids.** League mid-commit ($10–17K) is only ~10% of lots; contenders are built on scoring depth, not splashes. That zone is where you can win uncontested value instead of feeding the cap-free scrum (where you go 2–11 vs Hammer et al.).
