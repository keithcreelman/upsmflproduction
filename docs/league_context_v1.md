# UPS Salary Cap Dynasty — League Context (v2, post-67-comment correction)

**Purpose:** Claude's working understanding of how the UPS league operates, written so Keith can correct it before we use it as the foundation for the 2026 auction bid sheet. Sections delivered iteratively.

**v2 changes (2026-04-26):** Rolled in all 67 PR comments from Section 1 review. Substantive deltas now also persisted in memory:
- `league_history_timeline.md` (founding, dispersals, owner timeline, draft-order mechanics)
- `league_rules_2026_corrections.md` (rules that drift from rules.json)

**Section status:**
- [x] Section 1 — Player Lifecycle (this v2)
- [ ] Section 2 — Transaction Catalog
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
- **Salaries:** rookie salary table by pick lives in the **MFL Draft War Room module** — Keith pointed there as the source of truth. **Action item:** Claude needs to extract the per-pick salary table and persist it in repo data. (Not blocking the rest of this doc but blocks the bid sheet.)
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
- **Naming note:** Keith is considering renaming "Veteran" contracts → "Auction" contracts to better reflect the contract's genesis. Not yet final. Current data uses "Veteran."

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
- **Type rule:** WW contracts that get MYM'd → become Veteran/Auction contracts. Open question: how does a WW MYM read as an "Auction" contract? Possibly the data layer keeps it as "WW-MYM" or similar — TBD on naming.
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
- **Per-team annual limit?** Not specified in current rulebook. Effectively gated by the 3-loaded-contracts roster cap. Verify in Discord/event log if a soft limit exists.

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
- **Tier-1 Retired (Calvin Johnson Rule):** Lives in a Google Doc — link in PR review. Need to read for full mechanics. Not yet integrated into Claude's understanding.
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

## F. STILL-OPEN QUESTIONS (post-v2)

The 67-comment review resolved most of v1's open Qs. These remain:

1. **Rookie salary table by pick** — extract from MFL Draft War Room module and persist to repo data. Blocks bid sheet calibration.
2. **In-season MYM exact deadline** — "before Week 3 kickoff" for pre-season pickups, "2 weeks after acquisition" for in-season pickups. Verify via MFL event log for 2026.
3. **Tag system mechanics** — Section 2 will enumerate by reading code under `pipelines/etl/scripts/build_tag_*.py`. What's the tag salary effect? Eligibility window? Compensation rules to other team if applicable?
4. **Calvin Johnson Rule** — read the linked Google Doc once accessible.
5. **Per-team annual restructure limit** — likely none (gated by 3-loaded-contracts cap), but confirm.
6. **Naming convention** — "Veteran" vs. "Auction" contract type — pending Keith's decision. Data layer impact TBD.
7. **WW MYM type renaming** — when a WW gets MYM'd, what does it become? "Veteran" today; if the rename happens, "Auction" feels wrong. Possibly "WW-MYM" sub-type. Open.

These do NOT block the bid sheet (cap math, valuation curves) — they're cleanup for Section 2.

---

## END Section 1 v2

Reply with corrections inline (PR comments) or push edits directly. Once Section 1 is locked, Section 2 (Transaction Catalog) will enumerate every MFL `transactions` TYPE (WAIVER, BBID_WAIVER, FREE_AGENT, TRADE, IR, TAXI, AUCTION_INIT, AUCTION_BID, AUCTION_WON, etc.) with eligibility, who can initiate, and downstream cap effect — pulled from both MFL API and the live UPS rule customizations.
