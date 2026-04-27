# UPS Salary Cap Dynasty — League Context (v3, Section 1 LOCKED + Section 2 added)

**Purpose:** Claude's working understanding of how the UPS league operates, written so Keith can correct it before we use it as the foundation for the 2026 auction bid sheet. Sections delivered iteratively.

**v3 changes (2026-04-27):** Section 1 corrections from second review pass rolled in (rookie salary scale extracted, Calvin Johnson Rule fully documented, restructure limit = 3/season, Veteran naming kept, MYM treated as its own contract type). Section 2 (Transaction Catalog) added below. Memory updated:
- `league_history_timeline.md` — founding, dispersals, owner timeline, draft-order mechanics
- `league_rules_2026_corrections.md` — rules drift from rules.json (now also has rookie scale + Calvin Johnson Rule + restructure limit)
- `feedback_iterative_doc_corrections.md` — workflow guidance

**Section status:**
- [x] Section 1 — Player Lifecycle — **LOCKED** (v3)
- [x] Section 2 — Transaction Catalog (this v3)
- [ ] Section 3 — Annual Calendar
- [ ] Section 4 — Scoring & Roster Eras (timeline)
- [ ] Section 5 — Franchise History (joins, rebrands, dispersals) — partial draft in memory
- [ ] Section 6 — Cap mechanics (penalties, guarantees, floor/ceiling)

> **Source-of-truth ranking** (highest first):
> 1. The Discord channels (live discussions, deadlines, precedent)
> 2. The MFL **calendar/event log** for the current season (deadlines)
> 3. Code under `services/rulebook/` and `pipelines/etl/scripts/` (tag system, restructure logic, MYM mechanics) — **read code over rulebook for current behavior**
> 4. `services/rulebook/data/rules.json` v2026.5 — baseline, **but stale relative to 2026** for several material rules (MYM cap, loaded cap, tag system, ERA opening bid). See `league_rules_2026_corrections.md`.
> 5. Legacy rulebook source files under `services/rulebook/sources/rules/` — historical reference only, often superseded.

> **Open external sources to read still:**
> - **Calvin Johnson Rule Google Doc** (linked in PR review): https://docs.google.com/document/d/1pXPxnab9bfEOs0QcPVDNI8EkQYRHOefOtVwv2EHrq04/edit?usp=drivesdk — WebFetch couldn't extract body text (auth-required). Need Keith to share content or grant access.
> - **Discord channels** — owner has tokens; can request access if needed for forum precedent.
> - **MFL Draft War Room module** — has the rookie salary table per pick.
> - **MFL settings page** — verify max-roster, IR limit, and similar live settings before relying on them.

---

# Section 1 — Player Lifecycle (v2)

A UPS player passes through some combination of: **(A) Entry → (B) Roster state → (C) Contract events → (D) Exit**.

---

## A. ENTRY PATHS — how a player gets onto a UPS roster

There are **7 entry paths**. Each creates a different default contract and constrains future contract events.

### A1. Rookie Draft (Memorial Day Sunday, 6 rounds, 12 picks)

- **Eligibility:** any player MFL classifies as an NFL rookie that year.
- **Round 1** — must stay on **active roster**. NOT taxi-eligible. **3-year contract**.
  - **1st-Round Rookie Option** (effective 2025 draft+): a 4th option year tacked on.
    - **Option-year salary = original Year 3 salary + $5,000.** ($5K = half of the +$10K Schedule 1 extension cost.) Simple formula, not a multiplier.
    - **Decision deadline:** September contract deadline of the player's **final original-contract season** (same as a normal extension decision window). E.g., a 2025 1st-rounder's option must be decided by Sept 2027.
    - **If exercised:** player plays the option year. After the option year, owner can **extend again** (1 or 2 more years, normal AAV escalator off the option-year salary). Worked example from Keith: 1.01 at $15K → exercise option → year 4 = $20K → extend 2 more years → could become 15/15/15/20/40/40 across 6 years.
    - **If NOT exercised:** player is treated like any other expired rookie (extension deadline before the May Rookie Draft, otherwise → Expired Rookie Auction).
- **Rounds 2–5** — 3-year contract, **taxi-squad eligible for first 3 LEAGUE years** (NOT NFL service time — see B2). Can stay on active roster instead.
- **Round 6** — Must be used to select **IDP, Kicker, or Punter**. Pick is **NOT tradeable** (forces every team to make at least one IDP-class selection per year). Player can be traded after the pick is made. 3-year contract. Random draft order.
- **Salaries (extracted v3 — flat across all 3 contract years):**

| Slot | Y1 (=Y2=Y3) | 3yr TCV | Notes |
|---|---|---|---|
| 1.01 | $15K | $45K | Round 1 has 4th-year team option |
| 1.02 | $14K | $42K | Linear $1K/slot decrement |
| 1.03 | $13K | $39K | |
| 1.04 | $12K | $36K | |
| 1.05 | $11K | $33K | |
| 1.06 | $10K | $30K | |
| 1.07 | $9K | $27K | |
| 1.08 | $8K | $24K | |
| 1.09 | $7K | $21K | |
| 1.10 | $6K | $18K | |
| 1.11 | $5K | $15K | Floor at $5K |
| 1.12 | $5K | $15K | |
| 2.01 – 2.12 | $5K | $15K | |
| 3.01 – 5.12 | $2K | $6K | |
| 6.01 – 6.12 | $1K | $3K | IDP/K/P only, pick not tradeable |

  Note: the Draft War Room HTML labels the Round 1 option as a "5th-year team option" — that's borrowed NFL parlance. UPS rookie base is 3 years, so the option year is technically the 4th season (per Keith's worked example: 1.01 path 15/15/15/20/40/40).
- **Draft order (Rounds 1–5):** based on prior season's playoff bracket — see [memory: league_history_timeline.md](../../.claude/projects/-Users-keithcreelman-Code-upsmflproduction/memory/league_history_timeline.md) for the full mapping (1.1 = Toilet Bowl champ … 1.12 = UPS champ).
- **Roster impact:** drafted rookie counts toward roster max once placed on active. Taxi-demoted rookies don't count vs. active roster. Demotion deadline = contract deadline date. Mid-season trade-acquired rookies on taxi: code (future) will auto-demote OR offer the acquiring owner a choice.
- **Rookie contract length:** still default 3 years for 2025 draft class onward (with 1st-round option). 2025 was the first year option years existed.

### A2. Free Agent Auction (last weekend of July, ~1 week)

- **Format:** eBay proxy bidding. **24-hour** lock window for the FA Auction.
- **Nominations:** **2 per 24-hour window**. Day 1 starts at 12 PM with a 12-hour kickoff window. Missed nominations escalate fines. Mandatory league event.
- **Roster window during auction:**
  - Max roster: **35** during auction
  - Min roster: **27 at CLOSE of auction** (not during — roster floats during)
  - Cap floor: **$260K** committed at SOME point during the auction. Front-loading is an explicit tool to satisfy the floor. If a team hits $270K and then loses cap to an IR designation, they're still considered compliant.
  - Cap ceiling: **$300K** (system-enforced)
  - Owner is responsible for managing minimum-roster headroom — system doesn't enforce that.
- **Auction Roster Lock Date:** historically 3 days before auction. Existed so commissioner could compile cap penalties + cut lists. Keith's note: probably collapse this into "no cuts during auction" + auto-unlock at auction start via MFL API call.
- **Cut-then-rebid prohibition:** if you cut a player who was under contract during the offseason, you cannot nominate or bid on them in the FA Auction. Commissioner-enforced (NOT MFL-enforced). Mostly self-enforcing.
- **Default contract:** **1 year** if no Multi-Year Auction Contract is submitted. Multi-Year option = 2-year or 3-year, Veteran or Loaded.
- **Bid increments:** **$1K** (always).
- **Naming note (decided 2026-04-27):** Keep "Veteran" contract type as-is. Rename idea parking-lotted.

### A3. Expired Rookie Auction (before the Rookie Draft — date in event log)

- **Eligibility:** any player whose **rookie contract expired** and was **NOT extended** by the deadline (the deadline is "before the rookie draft" — event log is source of truth, NOT the legacy April 30 date).
- **Format:**
  - 2–3 day nomination window
  - **Starting bid: $1K** (changed in 2025 — old "prior-year salary + $1K" rule is dead). Reason: under the old rule a $13K player needed a $14K opening nomination; nobody wanted that. $1K floor lets someone start the bidding.
  - **36-hour** lock window. Resets on new high bid.
- **Contract on win:** 1, 2, or 3 years, same loading rules as FA Auction (front-load OR back-load, capped at 3 loaded contracts on roster). No "sign immediately" benefit — FA Auction submission deadline applies.
- **Forced retention:** players won in Expired Rookie Auction **cannot be cut until after that summer's FA Auction** (just through the auction window, not the entire season). Concept: no "get out of jail free" — you bid, you hold through auction.

### A4. Blind Bid Waivers (in-season — Thu/Fri/Sat/Sun 9 AM)

- **Mechanism:** Conditional blind bidding. Bid amount **becomes the player's salary for the current season**.
- **Contract type: always WW (Waiver Wire)** during the season — because blind bids start Week 1 Sunday (post-contract-deadline).
- **Conditional bidding format:** owners group bids; within each group, the highest-bid player is awarded; groups have NO priority over each other (they're placeholders, not priorities). Winners determined by bid amount across all groups.
- **Tiebreakers:** All-Play → Overall → Total Points → H2H. Pre-season + Week 1 use prior-season's final draft slot (reverse order — bad teams priority).
- **MFL doc reference:** the "How do I enter blind bid request?" MFL help page should be added to repo documentation for owner reference.

### A5. First-Come, First-Serve (FCFS) Free Agency (Sunday after waiver run → kickoff)

- **Trigger:** after the Sunday morning waiver run, FA opens FCFS until each player's NFL kickoff.
- **Salary:** $1K flat for current season.
- **Contract:** 1-year WW (always WW in-season). For pre-season pickups, see in-season MYM rules.

### A6. Trade Acquisition

- **Trade window:** offseason through **NFL Thanksgiving week kickoff** (the trade deadline). Then closed until next offseason.
- **Eligibility:**
  - Players with **1+ years remaining** on contract.
  - **Expired rookies** can be traded up to the extension deadline (date in event log). Other expired contracts cannot be traded.
  - **Round 6 picks: NOT tradeable** (the pick — the player can be traded once selected).
  - Future draft picks: current year + 1 year out only.
- **Cap money:** can be traded up to **50% of the salary of a traded-away player**. Cannot send only money + a draft pick — must include at least one player or pick from each side as the asset.
- **Asset requirement:** every trade must include at least one **non-salary asset**. Salary alone does not satisfy the asset requirement.
- **Inheritance:** contract transfers as-is. Acquiring team owns the cap consequences from that point forward.
- **In-season trade-and-extend window:** acquiring team has **4 weeks from acquisition** to extend a player in their final year. **No pre-agreement needed** — the right to extend is automatic for the acquiring team. Pre-agreement only matters if a tagged player is involved (tagged players are NOT extension-eligible by the acquiring team), or if the trading-away team is using their own extension on the player as part of the deal. Default behavior: the acquiring team extends.
- **Tagged players:** cannot be extended by the acquiring team after a trade (tag locks them out of extension that season).
- **Roster compliance:** trades must put both teams in compliance immediately or within 24 hours for contract limits. In-season: MFL system blocks invalid lineups, which carries its own penalty — that's the practical enforcement mechanism.
- **No vetoes.** Trades process immediately and stand unless there's blatant collusion or massive cap violation. Commissioner intervenes only in extreme cases.

### A7. Dispersal Draft (when a new owner joins)

- **Trigger:** new owner replaces an outgoing one.
- **Default behavior changed (post-Lima/Hammer/Whitman event):** anytime a new owner joins, the league opens it up to all teams to opt in. The outgoing owner's roster goes into the pool **by default**.
- **Mechanism:** opt-in teams throw their roster + future eligible picks (excluding 6th-rounders) into the pool. Random snake draft order. Conducted in Discord. Once committed, no withdrawal.
- **Inherited contracts:** dispersal-acquired players keep their **existing contract** (old contract carries forward). New owner doesn't get a fresh deal.
- **History:** see [memory: league_history_timeline.md](../../.claude/projects/-Users-keithcreelman-Code-upsmflproduction/memory/league_history_timeline.md) — 3 confirmed dispersal events.

---

## B. ROSTER STATES — where the player can sit

A rostered player is always in exactly one of three states.

### B1. Active Roster
- **Size:** 27 (min, at close of auction) – 30 (max, after contract deadline).
- **Auction window:** 27 (close min) – 35 (max).
- Player counts against active roster size, contributes salary fully toward cap, can start.

### B2. Taxi Squad
- **Size:** Max 10 players, min 1 IDP.
- **Eligibility:** Players selected in the **Rookie Draft, Round 2 or later**, for **first 3 LEAGUE years** (NOT NFL service time — eligibility resets when promoted, otherwise auto-graduates after 3 league years on taxi).
- **Salary on taxi: does NOT count against the cap.** This is a major correction from the v1 draft.
- **Cut economics:** Taxi-squad players never promoted to active can be cut **cap-free**. Once promoted to active, normal cut penalties apply going forward.
- **Demotion deadline:** contract deadline date. Mid-season trade-acquired rookies: planned automation will auto-demote (or owner-choice on trade).
- **3-year clock end:** when a player's 3 league years on taxi expire, they're treated like any other expired rookie. If extended → promoted to active. If not → Expired Rookie Auction. **League years, not NFL years.**

### B3. Injured Reserve (IR)
- **Eligibility:**
  - NFL Injured Reserve (or any IR designation MFL recognizes)
  - COVID-19 IR (legacy)
  - **Holdouts**
  - **Suspended players** (special handling, see below)
- **Cap relief:** **50%** of salary refunded while on IR.
- **Roster impact:** IR players do NOT count against active roster max.
- **No team-side IR limit.** MFL setting is set very high — effectively unlimited.
- **IR + guarantee earning:** confirmed — earning continues on Oct/Nov/Dec checkpoints while on IR.
- **Suspended player handling:**
  - **Off-season suspension** (season-long): owner can opt to NOT roll forward the contract → salary $0 that year, original salary resumes after suspension. Decision before contract deadline.
  - **In-season suspension:** "rest-of-season doesn't apply" — contract rolls forward normally. Precedent: Josh Gordon was given a 10-game suspension to start the season, then mid-suspension extended to full season; was NOT granted the $0 option.

---

## C. CONTRACT EVENTS — what happens to a player's contract while rostered

These are transactions you can do TO a player who's already on your roster. Defined `contract_type` values: **Auction, Extension, MYM, Restructure** (per `R-D-1` data standard).

### C1. Initial contract assignment (varies by entry path)

- Rookie Draft → 3-year rookie deal (Round 1: +Option Year if 2025+)
- FA Auction → 1, 2, or 3-year Veteran (or "Auction" — pending rename) or Loaded
- Expired Rookie Auction → 1, 2, or 3-year (same as FA Auction, no immediate-sign benefit)
- Blind Bid → 1-year WW
- FCFS → 1-year, $1K WW
- Trade → inherit existing contract
- Dispersal → inherit existing contract

### C2. Multi-Year Auction Contract (MYAC) submission
- **Window:** From acquisition (FA Auction or pre-deadline waivers) through the **September contract deadline date** (last Sunday before NFL Week 1).
- **Result:** Converts a 1-year default into 2-year or 3-year, Veteran or Loaded.
- **Loaded rules:**
  - **Front-loaded:** Year 1 salary > AAV. Total split must equal TCV.
  - **Back-loaded:** Year 1 salary < AAV. Min 20% of TCV in Year 1. **Same constraints as front-loaded** (TCV preserved, valid distribution).
  - **Loaded contracts cap (UPDATED 2025): MAX 3 LOADED CONTRACTS PER ROSTER.** Lowered from 5 mid-season alongside the in-season restructure ban — owners were exploiting WW + restructure to dump current-year salary into the pickup year.
  - Total 3-year contracts: 6 max (excludes rookie 3-year deals).

### C3. Mid-Year Multi (MYM)
- **What it is:** Convert an existing 1-year contract into a multi-year deal at the SAME salary (no raise). Cannot be loaded.
- **Limit (UPDATED 2025): MAX 4 MYMs per season per team** (raised from 3).
- **Eligibility:**
  - Player acquired via FA Auction or pre-season waivers, NOT given a multi-year contract by Sept deadline → MYM available **before kickoff of NFL Week 3** (per Keith's recall — verify in event log).
  - In-season WW pickup or post-trade for them → MYM available within 2 weeks of acquisition.
- **Type rule (decided 2026-04-27):** MYM is its **own** `contract_type` value — "MYM" — not collapsed into Veteran. Origin (Veteran-MYM vs WW-MYM) is captured by the `contract_type` history rather than by mutating the type at conversion.
- **Length on MYM:** **owner's choice — 2 or 3 years.**

### C4. Extension
- **Eligibility:** Player in **final year** of contract.
- **Length:** 1 or 2 years.
- **AAV escalator** (applied to the extension years only, not the current year):
  - **Schedule 1 (QB / RB / WR / TE):** +$10K (1yr) / +$20K (2yr)
  - **Schedule 2 (DL / LB / DB / K / P):** +$3K (1yr) / +$5K (2yr)
- **Effect:** Resets TCV and 75% guarantee against the new TCV. Forward-looking only.
- **Worked example (Schedule 1):** 1yr remaining at $17K AAV → extend 1yr → AAV for the extension year = $27K. **Current year stays at $17K.** New TCV = $17K + $27K = $44K. (Note: TCV is the SUM of remaining year salaries, not AAV × years — because the AAV bump only applies forward.)
- **Worked example, 2-year extension:** 1yr remaining at $30K AAV → extend 2yr Schedule 1 → AAV for both extension years = $50K each. Current year stays $30K. New TCV = $30K + $50K + $50K = $130K.
- **Deadlines:**
  - **Standard:** by September contract deadline.
  - **Rookie / preseason waiver pickups w/ no contract by Sept and no MYM by Week 2-ish:** extend by Week 4. (Edge case — also covered by in-season MYM/extension paths.)
  - **In-season trade-acquired in final year:** extend within **4 weeks of acquisition.**
  - **Expired rookies (no extension by deadline):** lose extension right → Expired Rookie Auction.

### C5. Restructure
- **Purpose:** Adjust salary distribution across remaining contract years (front-load or back-load) without extending.
- **Window: OFFSEASON ONLY.** Mid-season restructures are BANNED (changed in 2025 alongside the loaded-cap drop). Reason: WW pickups + restructure was being used to dump current-year salary into a 1-year-tail pickup.
- **Loading rules:** same as MYAC loading — front-load or back-load, with TCV preserved.
- **Counts toward 3-loaded-contracts roster cap.**
- **Standalone restructure allowed:** legacy 2014 rule (must accompany extension) is dead. Restructure on its own is fine in offseason.
- **Per-team annual limit (decided 2026-04-27): 3 restructures per season per team.**

### C6. 1st-Round Rookie Option (effective 2025+)
- See A1 for full mechanics. Reproducing key facts:
  - Salary = original Year-3 salary + $5K
  - Decision deadline = September of the player's final original-contract year
  - If not exercised → expired rookie path
  - If exercised → can be re-extended (normal AAV escalator) after the option year

### C7. Annual Roll-Forward (March 1–15)
- All contracts decrement by 1 year remaining; salaries advance to next-year value.
- Prior-year salary becomes 100% earned at rollover (sunk cost — no penalty thereafter).

### C8. Tags (UPDATED 2025) — STILL ACTIVE
- **Updated structure:** **1 Offense tag + 1 Defense/ST tag** per team per year (no longer the legacy Franchise/Transition naming).
- **Mechanics:** Live in the codebase — see `pipelines/etl/scripts/build_tag_tracking.py` and `build_tag_submissions_json.py`. **Read the code, not the rulebook**, for current tag behavior.
- **Tagged player constraints:**
  - Tagged players **cannot be extended by an acquiring team** in an in-season trade.
  - (Other tag mechanics — salary effect, eligibility, compensation, deadline — to be enumerated in Section 2 by reading the code.)

---

## D. EXIT PATHS — how a player leaves a UPS roster

### D1. Cut / Release (cap penalty applies)
- **Cap penalty formula:** `(TCV × 75%) − Salary Earned`
- **Earning schedule:**
  - 25% earned at end of October
  - 25% more earned at end of November
  - 25% more earned at end of December
  - 100% earned once the season completes and the new season has rolled forward (post-March rollover)
- **Penalty timing:**
  - Penalty incurred **before Roster Lock Date** → applies to **current season** cap.
  - Penalty incurred **from auction start onward** → applies to **following season** cap.
- **Confirmed example:** player on 3-year, $30K/yr Veteran contract (TCV $90K), cut March of Year 2 (offseason):
  - Year 1 fully earned at rollover → $30K earned, no penalty contribution from Y1.
  - Penalty = (TCV × 75%) - Earned = ($90K × 75%) - $30K = $67.5K - $30K = **$37.5K cap hit** to the **2026 (current) season**.

### D2. Cap-free cut categories (no penalty)
- **1-year original-length contracts under $5K (Veteran or WW):** 0% guarantee. Cap-free cut anytime. Note: this only applies to **1-year original** contracts — a 2-year veteran under $5K can still incur penalty depending on cut timing.
- **Taxi Squad (never promoted):** 0% guarantee while on taxi. Cap-free cut.
- **WW $5K+ in-season:** 65% earned → **35% penalty** if dropped during season. Off-season is academic since no drops allowed in offseason — those rosters just clean up at season end.
- **Jail Bird Rule:** vague rule. Aaron Hernandez was the canonical case, but "released by NFL team" is NOT sufficient — players are released all the time. Commissioner discretion required for what qualifies as a "career derailed by legal case."
- **Retired Players Rule:** retired = cap-free cut. Optional to keep on roster, but no relief if kept.
- **Tier-1 Retired (Calvin Johnson Rule):** Compensation pick awarded when a player retires meeting tier-1 criteria.
  - **Eligibility:** Player must be (1) under contract AND on a roster at retirement, (2) not PK or PN, (3) most recently completed season qualified as "Tier 1" at their position (tier breakdown in [separate Google Doc](https://docs.google.com/document/d/11e8RxzlTwryhMOornrmAqGIwYkgT8jZWFyj-zN_g7jk/)).
  - **What counts as "under contract":** Excludes expired Veteran contracts. **Includes** expired Rookie contracts (rookie just expired but player retires before re-signing → owner still gets comp).
  - **Compensation:**
    - Offensive Tier-1 retiree → comp pick **1.13** (extra Round 1 slot at position 13). **Not taxi-eligible.**
    - Defensive Tier-1 retiree → comp pick **3.13**. **IS taxi-eligible.**
  - **Awarded for the current season's rookie draft.** If the retirement happens AFTER that season's rookie draft, the comp pick is held over to next season's draft (MFL future-pick handling).
  - **Comp pick cannot be traded until following season.**
  - **Tiebreakers:** if multiple retirees on the same side (offense or defense) in the same year, random generator determines pick order.
- **Off-season suspension opt-out:** salary = $0 that year, no penalty (covered in B3).

### D3. Trade-away
- Contract transfers to acquiring team (covered in A6).
- No cap consequence to trading-away team beyond losing the asset.

### D4. Expired Contract → free agent OR Expired Rookie Auction
- **Rookie contract expired AND not extended by deadline** → Expired Rookie Auction (before the rookie draft).
- **Veteran contract expired AND not extended** → **full free agent unless tagged.** Available in FA Auction in late July. Tagged players are retained on the team that tagged them per the tag-system rules.

### D5. Retired
- Covered in D2. Cap-free cut available.

### D6. Suspended (offseason, contract paused)
- Covered in B3.

---

## E. END-TO-END LIFECYCLE EXAMPLES (corrected)

### Example 1: 1st-round rookie WR, drafted 2025 at 1.05
- May 2025: Drafted 1.05. 3-year rookie contract at the 1.05 salary (per draft war room table — TBD).
- Stays on active roster (Round 1 — taxi-ineligible).
- 2025/2026/2027: plays out original contract.
- **Sept 2027 contract deadline:** owner exercises 1st-Round Rookie Option for 2028 → 2028 salary = original Y3 salary + $5K.
- 2028: plays option year.
- **Sept 2028 contract deadline:** owner can extend again (1 or 2 years, Schedule 1 escalator off the option-year salary).
- If not extended → **expired rookie path** (same as 2nd-6th rounders): extension deadline before May 2029 rookie draft, otherwise → Expired Rookie Auction. **No "auto-extend via option" — option year just adds Y4.**

### Example 2: 4th-round rookie RB, drafted 2026 at 4.07
- May 2026: Drafted 4.07. 3-year rookie contract at the 4.07 salary.
- Demoted to taxi squad before Sept 2026 contract deadline. Doesn't count vs. active roster. **Salary doesn't count vs. cap.**
- 2026/2027: stays on taxi. Cap-free cut available at any time.
- 2028: 3-league-year clock runs out. Must be promoted, extended, or hit Expired Rookie Auction.
- If extended (Schedule 1, +$10K/$20K) → promoted to active. If not → Expired Rookie Auction May 2029.

### Example 3: $25K UDFA WR, picked up Week 5 via blind bid 2026
- Bid $25K, won. Salary = $25K for 2026. WW 1-year contract.
- Within 2 weeks (by Week 7): owner does MYM, converts to 2 or 3-year **Veteran/Auction** contract at $25K/yr (no raise). Cannot be loaded.
- Plays out 2026 + 2027 (assuming 2-year MYM).
- **Sept 2027 contract deadline:** extension eligible. Extends 2 years Schedule 1 → AAV for the 2 extension years = $45K each ($25K + $20K). Current 2027 year stays $25K. New TCV = $25K + $45K + $45K = $115K.

---

## F. STILL-OPEN QUESTIONS (post-v3, none blocking)

1. **In-season MYM exact deadline** — "before Week 3 kickoff" for pre-season pickups, "2 weeks after acquisition" for in-season pickups. Verify via MFL event log for 2026.
2. **Jail Bird Rule** — vague by design (commissioner discretion). No formal definition needed for code, but flag at decision time.

---

## END Section 1 (LOCKED v3)

---

# Section 2 — Transaction Catalog

This section enumerates every transaction type that affects a UPS roster, contract, or cap state. Where MFL has a native TYPE token (from the `transactions` API), it's listed. Where UPS layers a custom event on top of MFL data (extension, MYM, restructure, tag), the data source is the local DB tables populated by ETL or commissioner imports.

> **Transaction data sources** (referenced throughout):
> - `transactions_auction` — auction events (FA Auction + Expired Rookie Auction). Columns: `auction_type` ∈ {`FreeAgent`, `TagOrExpiredRookie`}, `bid_amount`, `finalbid_ind`, `date_et`, `unix_timestamp`.
> - `transactions_adddrop` — add/drop events. `move_type` ∈ {ADD, DROP}, `method` ∈ {BBID (waiver), FREE_AGENT (FCFS)}, `salary`.
> - `transactions_trades` — trade events. `asset_type` ∈ {PLAYER, DRAFT_PICK, FUTURE_PICK, BLIND_BID, SALARY}, `asset_role` ∈ {ACQUIRE, RELEASE}.
> - `draftresults_combined` — rookie draft selections. `draftpick_round`, `draftpick_overall`.
> - `salary_adjustments` (MFL `TYPE=salaryAdjustments`) — commissioner-applied cap adjustments (penalties, fines, credits).
> - `mym_submissions` (UPS-custom, dashboard-tracked) — MYM contract conversions.
> - `extension_submissions` (UPS-custom, dashboard-tracked) — extension events.
> - `restructure_submissions` (UPS-custom, dashboard-tracked) — restructure events.
> - `tag_submissions` (UPS-custom, dashboard-tracked) — tag events.

For each transaction below: **Source** (MFL TYPE / UPS table) · **Initiator** (Owner/Commissioner) · **Eligibility** · **Cap effect** · **Contract impact** · **Data type**.

---

## Group 1 — Acquisition transactions (player ON to roster)

### T1.1 Free Agent Auction — bid placed (`AUCTION_BID`)
- **Source:** MFL `TYPE=transactions&TRANS_TYPE=AUCTION_BID`. Stored in `transactions_auction` with `finalbid_ind=0` for in-flight bids.
- **Initiator:** Owner.
- **Eligibility:** Player is in the auction pool (free agents, not on any roster, not blocked by cut-then-rebid prohibition for the bidding owner).
- **Cap effect:** None until win.
- **Contract impact:** None until win.
- **Data type:** `bid_amount` (int $K), `franchise_id`, `player_id`, timestamp.

### T1.2 Free Agent Auction — bid won (`AUCTION_WON`)
- **Source:** MFL `TYPE=transactions&TRANS_TYPE=AUCTION_WON`. Stored in `transactions_auction` with `auction_type='FreeAgent'`, `finalbid_ind=1`.
- **Initiator:** System (24-hour proxy timer expires with high bid).
- **Eligibility:** N/A (system-driven).
- **Cap effect:** Winning bid amount becomes Year 1 salary; counts vs. cap immediately.
- **Contract impact:** Creates a new contract for the winning team.
  - **Default:** 1-year Veteran.
  - **If MYAC submitted by Sept contract deadline:** 2 or 3-year Veteran (even split) or Loaded.

### T1.3 Expired Rookie Auction — bid won (also `AUCTION_WON` with type `TagOrExpiredRookie`)
- **Source:** MFL — same `transactions_auction` table; `auction_type='TagOrExpiredRookie'`. The label is shared with tag transactions because MFL doesn't distinguish them; UPS infers type by date (May → ERA, July/Aug → Tag context, etc.).
- **Initiator:** System (36-hour proxy timer expires).
- **Eligibility:** Player whose rookie contract expired AND who was not extended by the May-deadline.
- **Cap effect:** Winning bid amount becomes Year 1 salary; counts vs. cap immediately.
- **Contract impact:** Creates new contract — 1, 2, or 3 years, Veteran or Loaded. Same rules as T1.2 except **forced retention through that summer's FA Auction** (cannot cut before then).

### T1.4 Blind Bid Waiver Award (`BBID_WAIVER`)
- **Source:** MFL `TYPE=transactions&TRANS_TYPE=BBID_WAIVER`. Stored in `transactions_adddrop` with `method='BBID'`, `move_type='ADD'`.
- **Initiator:** System (one of the four weekly waiver runs: Thu/Fri/Sat/Sun 9 AM in-season).
- **Eligibility:** Player on free-agent list. Tiebreakers: All-Play → Overall → Total Points → H2H. Pre-season + Week 1 use prior-season's final draft slot.
- **Cap effect:** Bid amount becomes Year 1 salary; counts vs. cap immediately.
- **Contract impact:** Creates **WW** 1-year contract (always WW since blind bid happens in-season, post-contract-deadline).
- **Notes:** Conditional bidding via groups; groups are placeholders, not priorities — winners determined purely by bid amount across all groups for a given owner.

### T1.5 Blind Bid Waiver Request (`BBID_WAIVER_REQUEST`)
- **Source:** MFL `TYPE=transactions&TRANS_TYPE=BBID_WAIVER_REQUEST` (pending-state).
- **Initiator:** Owner (submission, before the run).
- **Cap effect:** None (pending). System records the bid + drop pair.
- **Contract impact:** None until awarded → T1.4.

### T1.6 First-Come First-Serve (`FREE_AGENT`)
- **Source:** MFL `TYPE=transactions&TRANS_TYPE=FREE_AGENT`. Stored in `transactions_adddrop` with `method='FREE_AGENT'`, `move_type='ADD'`.
- **Initiator:** Owner (any time after the Sunday morning waiver run and before the player's NFL kickoff).
- **Eligibility:** Player on free-agent list, not waiver-locked, owner has roster headroom.
- **Cap effect:** **$1K flat** salary, counts immediately.
- **Contract impact:** Creates **WW** 1-year contract.

### T1.7 Trade (`TRADE`)
- **Source:** MFL `TYPE=transactions&TRANS_TYPE=TRADE`. Stored in `transactions_trades`. Each trade produces multiple rows (one per asset, with `asset_role` ∈ {ACQUIRE, RELEASE}).
- **Initiator:** Either owner can propose; both must accept.
- **Eligibility:**
  - Players with 1+ years remaining on contract (expired Vets ineligible; expired Rookies eligible up to extension deadline).
  - Round 6 picks: NOT tradeable (the pick — player is tradeable post-selection).
  - Future picks: current year + 1 year out only.
  - Cap money: max 50% of traded-away player's salary; cannot send money without a non-salary asset.
- **Cap effect:**
  - Salary moves with the player (acquiring team takes on salary, trading team sheds it).
  - Cap cash transferred (if any) — `transactions_trades` row with `asset_type='SALARY'`.
- **Contract impact:** Player's contract transfers as-is to acquiring team. Acquiring team gains:
  - 4-week extension window if player is in final year (automatic, no pre-agree).
  - Right to MYM if player is on a 1-year contract (subject to 4/season cap).
  - Cannot extend a tagged player.
- **Trade window:** offseason through NFL Thanksgiving week kickoff.

### T1.8 Rookie Draft Selection
- **Source:** MFL draft results (`TYPE=draftResults`). Stored in `draftresults_combined`.
- **Initiator:** Owner (during live draft on Memorial Day Sunday).
- **Eligibility:** Player MFL classifies as an NFL rookie that year. Round 6 must be IDP/K/P.
- **Cap effect:** Rookie scale salary (see Section 1 A1) becomes Year 1 salary; counts vs. cap if on active roster, **does NOT count vs. cap if demoted to taxi**.
- **Contract impact:** Creates **Rookie** 3-year contract at scale salary, flat across all 3 years. Round 1: 4th-year option attached.

### T1.9 Dispersal Draft Pick (UPS-custom, no native MFL TYPE)
- **Source:** No native MFL TYPE — recorded as commissioner-side `salary_adjustments` + `transactions_adddrop` series. Historical dispersals stored in repo as JSON / data files.
- **Initiator:** New owner (during snake draft, or auto-assigned if their roster goes into the pool by default).
- **Eligibility:** Players in the dispersal pool (opt-in teams' rosters + outgoing owner's full roster).
- **Cap effect:** Existing salary transfers as-is (old contract carries forward).
- **Contract impact:** Old contract preserved.

### T1.10 Calvin Johnson Rule Comp Pick Award
- **Source:** UPS-custom — recorded as commissioner-side adjustment, draft pick added to the receiving team's available picks.
- **Initiator:** Commissioner (when a Tier-1 player retires).
- **Eligibility:** See Section 1 D2 / Calvin Johnson Rule for full criteria.
- **Cap effect:** None directly (the pick is a future asset).
- **Contract impact:** Comp pick added to roster; cannot be traded until following season; if defensive, eligible for taxi.

---

## Group 2 — Roster state changes (no contract change)

### T2.1 Place on IR (`IR`)
- **Source:** MFL `TYPE=transactions&TRANS_TYPE=IR`. Or via `import?TYPE=ir`.
- **Initiator:** Owner.
- **Eligibility:** Player on NFL IR or league-recognized injury designations; holdouts; suspended players (with caveats).
- **Cap effect:** **50% salary refund** while on IR.
- **Contract impact:** Player removed from active roster count; contract continues to earn (Oct/Nov/Dec checkpoints accumulate). No team-side IR limit.

### T2.2 Activate from IR (`IR` reverse)
- **Source:** Same MFL TYPE; `import?TYPE=ir&ACTIVATE=...`.
- **Initiator:** Owner.
- **Eligibility:** Player no longer eligible for IR designation, OR owner choice to activate early.
- **Cap effect:** 50% salary refund ends; full salary resumes against cap.
- **Contract impact:** Roster count: player back on active roster.

### T2.3 Demote to Taxi (`TAXI`)
- **Source:** MFL `TYPE=transactions&TRANS_TYPE=TAXI`. Or via `import?TYPE=taxi_squad&DEMOTE=...`.
- **Initiator:** Owner.
- **Eligibility:** Player drafted in Round 2+ of Rookie Draft, within first 3 league years on team, never previously promoted (or re-eligible after specific paths — verify in code).
- **Cap effect:** **Salary leaves the cap** while on taxi.
- **Contract impact:** Roster status changes; contract still active but in suspended state. Cap-free cut available while on taxi (never-promoted clause).

### T2.4 Promote from Taxi (`TAXI` reverse)
- **Source:** Same MFL TYPE; `import?TYPE=taxi_squad&PROMOTE=...`.
- **Initiator:** Owner.
- **Eligibility:** Player on taxi.
- **Cap effect:** Salary returns to cap.
- **Contract impact:** Player on active roster. Once promoted, the cap-free-cut benefit is gone.

---

## Group 3 — Contract events (UPS-specific, layered on top of MFL)

These are NOT native MFL transaction TYPEs; they're tracked in UPS-side dashboards + JSON stores + the rulebook API.

### T3.1 Multi-Year Auction Contract Submission (MYAC)
- **Source:** UPS dashboard input → `extension_submissions` / contract history snapshot.
- **Initiator:** Owner.
- **Eligibility:** Player acquired via FA Auction, Expired Rookie Auction, or pre-deadline waivers, currently on 1-year default. Submitted by September contract deadline.
- **Cap effect:** Year 1 salary reset per loading rules; future-year salaries set per declaration. Total TCV = sum of declared per-year salaries.
- **Contract impact:** Contract length goes from 1 year to 2 or 3. Type: Veteran (even split) or Loaded.
- **Constraints:** 3-loaded cap, 6 3-year cap, front-load Year 1 ≥ AAV / back-load Year 1 ≥ 20% of TCV.

### T3.2 Mid-Year Multi (MYM)
- **Source:** UPS dashboard → `mym_submissions` table.
- **Initiator:** Owner.
- **Eligibility:**
  - FA-Auction or pre-season waiver pickup with no MYAC by Sept → MYM by NFL Week 3 kickoff (verify in event log).
  - In-season WW pickup OR post-trade-acquired 1-year player → MYM within 2 weeks of acquisition.
- **Cap effect:** Same salary across all years (no raise).
- **Contract impact:** Contract length goes from 1 year to 2 or 3 (owner choice). Type: **MYM** (its own contract type — distinct from Veteran/WW). Cannot be loaded.
- **Limit:** 4 MYMs per team per season.

### T3.3 Extension
- **Source:** UPS dashboard → `extension_submissions` table.
- **Initiator:** Owner.
- **Eligibility:** Player in final year of contract.
- **Cap effect:** Forward-looking AAV bump applied to extension years only:
  - Schedule 1 (QB/RB/WR/TE): +$10K (1yr) / +$20K (2yr) on AAV.
  - Schedule 2 (DL/LB/DB/K/P): +$3K (1yr) / +$5K (2yr) on AAV.
- **Contract impact:** TCV reset (current year + extension years summed). 75% guarantee applies to new TCV. Type: Extension (separate `contract_type`). Length: 1 or 2 years.
- **Deadlines:**
  - Standard: September contract deadline.
  - In-season trade-acquired final-year player: 4 weeks from acquisition.
  - Rookie/preseason-waiver no-contract path: by Week 4.

### T3.4 Restructure
- **Source:** UPS dashboard → `restructure_submissions` table.
- **Initiator:** Owner.
- **Window:** **OFFSEASON ONLY** (in-season banned 2025).
- **Eligibility:** Player on contract with 2+ years remaining (or current year + extension years pending).
- **Cap effect:** Year-by-year salary distribution changes; TCV preserved.
- **Contract impact:** Type updates to Restructure-flavored (front-load or back-load). Counts vs. 3-loaded-contract roster cap.
- **Limit:** 3 restructures per team per season.

### T3.5 Tag — Offense
- **Source:** UPS dashboard → `tag_submissions` table.
- **Initiator:** Owner.
- **Eligibility:** Player on 1-year contract (final/expiring year), positions QB/RB/WR/TE, NOT extension-eligible by current owner, NOT tagged in the prior season.
- **Cap effect:** Tag salary = `max(tier-formula bid, prior_AAV × 1.10 rounded up to $1K)`. Tier formulas:
  - QB: T1=avg top 1-5 AAV, T2=avg top 6-15, T3=avg top 16-24
  - RB: T1=avg top 1-4, T2=top 5-8, T3=top 9-31
  - WR: T1=top 1-6, T2=top 7-14, T3=top 15-40
  - TE: T1=top 1-3, T2=top 4-6, T3=top 7-13
- **Contract impact:** Creates 1-year tagged contract. **Tagged players cannot be extended by an acquiring team in trade.**
- **Limit:** 1 offensive tag per team per year.

### T3.6 Tag — Defense / ST
- **Source:** Same as T3.5.
- **Initiator:** Owner.
- **Eligibility:** Same general eligibility as T3.5 but for positions DL/LB/DB/PK.
- **Cap effect:** Tier-formula bid. DL/LB/DB use T1/T2 formulas (top 1-6 / top 7-12 AAV). PK (kicker/punter): prior salary + $1K. 10% salary floor still applies.
- **Contract impact:** Same as T3.5.
- **Limit:** 1 defense/ST tag per team per year.

### T3.7 1st-Round Rookie Option Exercise
- **Source:** UPS dashboard → `extension_submissions` table (treated as a special "extension" subtype, since the option is a contract extension).
- **Initiator:** Owner.
- **Eligibility:** 1st-round rookie (2025+ class) entering the final year of original 3-year deal.
- **Cap effect:** Year 4 salary = original Y3 salary + $5K.
- **Contract impact:** Adds Y4 to existing contract. After the option year, normal extension paths re-open.
- **Deadline:** September contract deadline of player's final original-contract season.

### T3.8 Annual Roll-Forward (March 1–15)
- **Source:** Commissioner-driven; UPS-custom batch operation.
- **Initiator:** Commissioner (manual + scripted).
- **Cap effect:** Prior-year salary becomes 100% earned (sunk). All contracts decrement years remaining. Salaries advance to next-year value.
- **Contract impact:** Years-remaining counter decreases; contracts entering final year flagged as extension/option-eligible.

---

## Group 4 — Cap adjustments (financial side)

These hit cap directly without involving a player transaction.

### T4.1 Drop Penalty (auto-derived from cut)
- **Source:** UPS-derived; logged in `salary_adjustments` (MFL `TYPE=salaryAdjustments`) with negative amount + explanation.
- **Initiator:** Commissioner (after a cut event, calculates `(TCV × 75%) − Salary Earned`).
- **Cap effect:** Negative cap adjustment.
- **Timing:**
  - Cut **before Roster Lock Date** → penalty hits **current season** cap.
  - Cut **from auction start onward** → penalty hits **following season** cap.

### T4.2 Salary Adjustment — credit (positive)
- **Source:** MFL `TYPE=salaryAdjustments`; commissioner-side `import?TYPE=salaryAdj`.
- **Initiator:** Commissioner.
- **Cap effect:** Positive amount = cap relief.
- **Examples:** IR cap relief (50% of salary), retroactive corrections, league-driven adjustments.

### T4.3 Salary Adjustment — debit (negative)
- **Source:** Same as T4.2.
- **Initiator:** Commissioner.
- **Cap effect:** Negative amount = cap penalty.
- **Examples:** Late dues fines ($3K/week), drop penalties, missed-nomination fines (escalating from $3K).

### T4.4 Late Dues Fine ($3K/week)
- **Source:** UPS-custom; tracked as `salary_adjustments`.
- **Initiator:** Commissioner.
- **Cap effect:** -$3K per week late.
- **Timing:**
  - Accrued before contract deadline → applied to current season.
  - Accrued after → applied to following season.

### T4.5 Logo Change Fee ($15)
- **Source:** UPS-custom; tracked in league financing notes.
- **Initiator:** Owner request → commissioner.
- **Cap effect:** None (cash, not cap).
- **Notes:** Not a cap-relevant transaction; documented for completeness.

---

## Group 5 — Player exit transactions

### T5.1 Drop / Release (`FREE_AGENT` reverse via `move_type=DROP`)
- **Source:** MFL `TYPE=transactions` with drop event. Stored in `transactions_adddrop` with `move_type='DROP'`.
- **Initiator:** Owner (via `import?TYPE=fcfsWaiver&DROP=...` or roster manipulation).
- **Eligibility:** Any player on roster.
- **Cap effect:** Triggers drop penalty calculation (T4.1) unless cap-free cut category applies.
- **Contract impact:** Player removed from roster. Goes to free agency / waivers.

### T5.2 Cap-Free Cut (subcategories)
- **Source:** Same as T5.1 but with commissioner override OR specific eligibility:
  - Veteran/WW 1-year original under $5K
  - Taxi player never promoted
  - Jail Bird (commissioner discretion)
  - Retired player (auto-eligible)
  - Off-season suspension opt-out (special handling — see B3)
- **Cap effect:** No penalty. Salary removed from cap immediately.
- **Contract impact:** Player removed; contract terminates without penalty.

### T5.3 Drop from Taxi (`TAXI` + `DROP`)
- **Source:** MFL `import?TYPE=taxi_squad&DROP=...`.
- **Initiator:** Owner.
- **Eligibility:** Taxi player never promoted.
- **Cap effect:** Cap-free.
- **Contract impact:** Player off roster.

### T5.4 Trade-Away (covered by T1.7)
- Listed here for completeness — no separate transaction; the contract leaves the trading-away team's books with the player.

### T5.5 Retirement (auto-handling)
- **Source:** MFL doesn't have a "retire" TYPE; player simply becomes inactive in MFL's player DB. UPS commissioner detects + applies cap-free cut.
- **Initiator:** Commissioner (after retirement announced).
- **Cap effect:** Cap-free cut available; if player meets Tier-1 criteria, comp pick awarded (T1.10).
- **Contract impact:** Player off roster.

### T5.6 Suspension Opt-Out (off-season only)
- **Source:** UPS-custom; tracked as a `salary_adjustments` row + contract metadata note.
- **Initiator:** Owner (must declare before contract deadline).
- **Eligibility:** Player on contract with off-season-announced season-long suspension.
- **Cap effect:** Salary $0 for the suspended season; original salary resumes after suspension.
- **Contract impact:** Contract effectively pauses for the suspended year.

### T5.7 Expiring Contract → Free Agent
- **Source:** Auto (no transaction TYPE); contract simply expires at March roll-forward.
- **Cap effect:** Salary leaves the cap.
- **Contract impact:**
  - Expired Rookie → Expired Rookie Auction (unless extended by deadline).
  - Expired Veteran → full free agent for next FA Auction (unless tagged).

---

## Group 6 — Out-of-scope (tracked but not cap-relevant)

### T6.1 Survivor Pick (`SURVIVOR_PICK`)
- MFL TYPE; not relevant to cap or roster. Documented for completeness.

### T6.2 Pool Pick (`POOL_PICK`)
- MFL TYPE; pickem-style league pool. Not cap-relevant.

### T6.3 Lineup Submission
- MFL `import?TYPE=lineup`. Not a transaction in the cap sense — informational only.

---

## G. CROSS-SECTION VALIDATION RULES

These are invariants that must hold across the data layer for any 2026 contract state to be consistent. The bid sheet's cap math depends on these.

1. **Sum of all rostered active salaries + tagged salaries − IR refunds + outstanding cap penalties ≤ $300K** for every team.
2. **Sum of all rostered active salaries + tagged salaries ≥ $260K** at SOME timestamp during the FA Auction window (auction-floor check).
3. **`contract_type` history is append-only** — every contract event creates a new row; old rows preserved for audit (`R-D-2`, `R-D-3` data standards).
4. **Loaded contracts on roster ≤ 3** at all times (combines front-load + back-load count).
5. **3-year contracts on roster ≤ 6** (excluding rookie 3-year deals).
6. **MYM events per team per season ≤ 4.**
7. **Restructure events per team per season ≤ 3.**
8. **Tag events per team per season ≤ 2** (1 offense + 1 defense/ST).
9. **A player can have at most ONE active contract at a time.** Trades transfer the contract; they don't create a new one.
10. **Round 6 picks are NOT in `transactions_trades` with `asset_type='DRAFT_PICK'` or `'FUTURE_PICK'`.** If they appear, the trade is invalid.
11. **For an extension event, the `contract_year=1` precondition must hold** at the time of submission.
12. **For a tag event, the player must NOT have a prior extension by current owner** (extension-eligibility supersedes tag-eligibility).
13. **For a comp-pick award, the retiring player must have been under contract** at retirement (excludes expired Veteran contracts; includes expired Rookie contracts).

---

## H. STILL-OPEN ITEMS for Section 2

1. **Tag salary 10% floor for fallback (unranked) cases** — code uses a "Fallback: salary baseline" path; verify Keith intends this to be the rule (rather than "no tag if unranked").
2. **MFL `TagOrExpiredRookie` auction type ambiguity** — UPS infers ERA vs Tag context by date. If the bid sheet ever needs to distinguish, document the rule (probably: month ≤ June → ERA; July-onward → Tag).
3. **In-season MYM exact deadline** (carries from Section 1).
4. **Comp-pick recipient when a TRADED future pick converts** — if owner A trades 2027 1st to owner B, and a Tier-1 retiree on owner A makes 1.13 a thing, does owner B get the comp pick or does owner A? My read: owner A retains the comp pick (it's an additive slot, not a slot that overlaps a traded pick). Confirm.

---

## END Section 2

Section 3 (Annual Calendar with exact deadlines) and Section 6 (Cap mechanics worked examples) are the next two priorities — they finalize the inputs needed for the bid sheet. Sections 4 + 5 (eras + franchise history) are reference material that doesn't block the sheet.

Reply with corrections inline. Once Section 2 is locked, I'll start Section 3.
