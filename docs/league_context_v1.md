# UPS Salary Cap Dynasty — League Context (v4, Sections 1+2 LOCKED + Section 3 added)

**Purpose:** Claude's working understanding of how the UPS league operates, written so Keith can correct it before we use it as the foundation for the 2026 auction bid sheet. Sections delivered iteratively.

**v4 changes (2026-04-27):** Section 1+2 corrections from third review pass rolled in (47 substantive comments across both sections). Section 3 (Annual Calendar) added. Section 7 (Bot Integration Spec) added to scope, deferred to last.

Material v4 corrections (full list in `league_rules_2026_corrections.md`):
- **Loaded contract cap = 5** (corrected from earlier "3" — that was restructure limit conflated with loaded cap)
- **Restructure limit = 3** (separate)
- **Extension types = Ext1 / Ext2** (own contract_type values)
- **WW pickup gets a 4-week window:** first 2 weeks MYM-eligible, final 2 weeks extension-eligible
- **MYM 14-day clock does NOT reset on trade**
- **Tag eligibility = 0 years remaining** (post-roll-forward, from prior season ending roster)
- **Tagged player block:** can't be extended/MYM'd by anyone until they enter FA Auction (mid-season drop doesn't reset)
- **WW-Rookie contract sub-type** for rookies picked up via in-season waivers (preserves ERA eligibility)
- **New owner onboarding:** cap-penalty wipe + 1 cap-free cut
- **Cap "penalties" → "cap adjustments"** (subtypes: drop penalty, traded salary, late dues, etc.)
- **$300K ceiling does NOT apply offseason pre-FA-Auction**
- **$260K floor: by FA Auction completion OR contract deadline date**
- Survivor Pool / NFL Pool — UPS doesn't run them, removed from catalog
- $15 logo fee gone (we use AI now)

Memory updated:
- `league_history_timeline.md` — founding, dispersals, owner timeline, draft-order mechanics
- `league_rules_2026_corrections.md` — comprehensive rules-drift catalog (now ~6KB)
- `feedback_iterative_doc_corrections.md` — workflow guidance

**Section status:**
- [x] Section 1 — Player Lifecycle — **LOCKED** (v4)
- [x] Section 2 — Transaction Catalog — **LOCKED** (v4)
- [x] Section 3 — Annual Calendar (this v4)
- [ ] Section 4 — Scoring & Roster Eras (timeline)
- [ ] Section 5 — Franchise History (joins, rebrands, dispersals) — partial draft in memory
- [ ] Section 6 — Cap mechanics (penalties, guarantees, floor/ceiling, worked examples)
- [ ] Section 7 — Bot Integration Spec (deferred to last; depends on all prior sections)

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
- **Contract type during season:** **WW** (Waiver Wire) for non-rookies; **WW-Rookie** for NFL rookies (preserves Expired Rookie Auction eligibility when contract expires).
- **Conditional bidding format:** owners group bids; within each group, the highest-bid player is awarded; groups have NO priority over each other (they're placeholders, not priorities). Winners determined by bid amount across all groups.
- **Tiebreakers:** All-Play → Overall → Total Points → H2H. Pre-season + Week 1 use prior-season's final draft slot (reverse order — bad teams priority).
- **MFL doc reference:** the "How do I enter blind bid request?" MFL help page should be added to repo documentation for owner reference.

### A5. First-Come, First-Serve (FCFS) Free Agency (Sunday after waiver run → kickoff)

- **Trigger:** after the Sunday morning waiver run, FA opens FCFS until each player's NFL kickoff.
- **Salary:** $1K flat for current season.
- **Contract:** 1-year WW for non-rookies; **WW-Rookie** for NFL rookies. For pre-season pickups, see in-season MYM rules.

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
- **Default behavior changed (post-Lima/Hammer/Whitman event):** anytime a new owner joins, the league opens it up to all teams to opt in. The outgoing owner's **rosters and all other assets (draft picks)** go into the pool by default.
- **Mechanism:** opt-in teams throw their **roster + draft picks** (excluding 6th-rounders) into the pool. Random snake draft order. Conducted in Discord. Once committed, no withdrawal.
- **Inherited contracts:** dispersal-acquired players keep their **existing contract** (old contract carries forward). New owner doesn't get a fresh deal.
- **Tracking (legacy):** historically captured in forum threads (upsforumotion → Slack → Discord). Player movement to correct rosters happened via post-draft trades. Modern approach: log dispersal events explicitly in commissioner-side records.
- **History:** see [memory: league_history_timeline.md](../../.claude/projects/-Users-keithcreelman-Code-upsmflproduction/memory/league_history_timeline.md) — 3 confirmed dispersal events. Year-by-year mechanics weren't always consistent — would need forum reconstruction to fully document.

### A7b. New Owner Onboarding (separate from dispersal)
- **Cap-penalty wipe:** new owner is relieved of all future cap penalties (drop penalties, fines) accumulated by the prior owner. Cap is clean from acquisition forward.
- **1 cap-free cut:** new owner is allowed ONE cap-free cut within an "acceptable period" of joining (commissioner discretion on timing — gives the new owner time to assess roster + understand rules).
- This applies regardless of whether dispersal was opted into.

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
  - **Loaded contracts cap: MAX 5 LOADED CONTRACTS PER ROSTER** (combined front-loaded + back-loaded). Earlier "3" was a confusion with the restructure limit — the LOADED cap is 5.
  - Total 3-year contracts: 6 max (excludes rookie 3-year deals).

### C3. Mid-Year Multi (MYM)
- **What it is:** Convert an existing 1-year contract into a multi-year deal at the SAME salary (no raise). Cannot be loaded.
- **Why no loading:** loading would "restructure" Year 1 of the contract, and in-season restructures are banned. So MYMs cannot be loaded.
- **Limit (UPDATED 2025): MAX 4 MYMs per season per team** (raised from 3).
- **Eligibility:**
  - Player acquired via FA Auction or pre-season waivers, NOT given a multi-year contract by Sept deadline → MYM available **before kickoff of NFL Week 3** (per Keith's recall — verify in event log).
  - In-season WW or FCFS pickup → **14-day MYM window** from acquisition. **The 14-day clock does NOT reset on trade.** Example: pickup 10/1 → MYM eligible until 10/14. If traded on 10/20 → no MYM possible (clock already expired). The acquiring team via trade does NOT inherit a fresh MYM window.
- **Type rule (decided 2026-04-27):** MYM is its **own** `contract_type` value — "MYM" — not collapsed into Veteran. Origin (Veteran-MYM vs WW-MYM vs WW-Rookie-MYM) is captured by the `contract_type` history rather than by mutating the type at conversion.
- **Length on MYM:** **owner's choice — 2 or 3 years.**

### C4. Extension (contract types `Ext1` / `Ext2`)
- **Eligibility:**
  - Player in **final year** of contract (`contract_year=1`).
  - **Expired rookies** also extension-eligible up to the rookie extension deadline (before Rookie Draft in May).
  - **In-season WW/FCFS pickup within 4-week window:** the 28-day post-pickup window is split — first 14 days are MYM-eligible (subject to 4/season cap), final 14 days are extension-eligible (NOT MYM-eligible at that point). I.e., a WW pickup at day 0 has: days 1-14 MYM, days 15-28 extension.
  - **In-season trade-acquired final-year player:** extend within 4 weeks of acquisition.
- **Length:** 1 or 2 years.
- **`contract_type`:** **Ext1** for 1-year extension, **Ext2** for 2-year extension. (Case-insensitive.)
- **AAV escalator** (applied to the extension years only, not the current year):
  - **Schedule 1 (QB / RB / WR / TE):** +$10K (1yr) / +$20K (2yr)
  - **Schedule 2 (DL / LB / DB / K / P):** +$3K (1yr) / +$5K (2yr)
- **Effect:** Resets TCV and 75% guarantee against the new TCV. Forward-looking only.
- **Worked example (Schedule 1):** 1yr remaining at $17K AAV → extend 1yr (Ext1) → AAV for the extension year = $27K. **Current year stays at $17K.** New TCV = $17K + $27K = $44K. (Note: TCV is the SUM of remaining year salaries, not AAV × years — because the AAV bump only applies forward.)
- **Worked example, 2-year extension:** 1yr remaining at $30K AAV → extend 2yr Schedule 1 (Ext2) → AAV for both extension years = $50K each. Current year stays $30K. New TCV = $30K + $50K + $50K = $130K.
- **Deadlines:**
  - **Standard:** by September contract deadline.
  - **Rookie / preseason waiver pickups w/ no contract by Sept and no MYM by Week 2-ish:** extend by Week 4. (Edge case.)
  - **In-season trade-acquired in final year:** extend within **4 weeks of acquisition.**
  - **In-season WW/FCFS pickup:** see eligibility — extension window is days 15-28 of the post-pickup window.
  - **Expired rookies (no extension by deadline):** lose extension right → Expired Rookie Auction.

### C5. Restructure
- **Purpose:** Adjust salary distribution across remaining contract years (front-load or back-load) without extending.
- **Window: OFFSEASON UNTIL CONTRACT DEADLINE.** Mid-season restructures are BANNED (banned pre-2025 — verify exact year in forum/Discord). The window opens at season's end (or roll-forward) and closes at the September contract deadline.
- **Eligibility:** Player must have **2+ years remaining** on contract (so newly-extended single-year contracts at $1+ year remaining → no, but extension-bumped contracts at 2+ years remaining → yes).
- **Loading rules:** same as MYAC loading — front-load or back-load, with TCV preserved.
- **Counts toward 5-loaded-contracts roster cap.**
- **Standalone restructure allowed:** legacy 2014 rule (must accompany extension) is dead. Restructure on its own is fine.
- **Per-team annual limit: 3 restructures per season per team.** (Distinct from the 5-loaded-contract roster cap.)

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
- **Mechanics:** Live in the codebase — see `pipelines/etl/scripts/build_tag_tracking.py` and `build_tag_submissions_json.py`. **Read the code, not the rulebook**, for current tag behavior. Tier formulas open for review (Keith wants to revisit the math).
- **Eligibility window:** Tag candidates are players with **0 years remaining** post-roll-forward (i.e., on the prior season's ending roster with 1 year left, now expired). Tag eligibility is determined from the prior-season ending roster.
- **Tagged player constraints (corrected):**
  - A player CAN be extended in a prior year and then tagged the following year — extension does NOT permanently block tag.
  - Cannot be **pre-extended by same owner** in the year they're tagged.
  - Cannot be **tagged by anyone else** until they enter the FA Auction.
  - Once tagged, **cannot be extended OR MYM'd by ANY team** until they enter the FA Auction. This applies even if dropped mid-season.
  - **Exception:** if cut **before FA Auction starts**, normal rules resume — they're treated like any other free agent.
- **Tag salary fallback (unranked players):** `max(lowest-tier salary for the position, prior-season AAV × 1.10 rounded up to $1K)`.

---

## D. EXIT PATHS — how a player leaves a UPS roster

### D1. Cut / Release (cap penalty applies)
- **Cap penalty formula:** `(TCV × 75%) − Salary Earned`
- **Earning schedule:**
  - 25% earned at end of October
  - 25% more earned at end of November
  - 25% more earned at end of December
  - 100% earned once the season completes and the new season has rolled forward (post-March rollover)
- **Penalty timing (3 buckets):**
  - Penalty incurred **before Roster Lock Date** (i.e., offseason early) → applies to **current season** cap.
  - Penalty incurred **from auction start through end of season** → applies to **following season** cap.
  - Penalty incurred **after end of season but before next Roster Lock Date** → applies to **current season** cap (same as bucket 1).
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
- **Initiator:** Either owner can propose; the other must accept (proposing IS technically an offer of acceptance from the proposer's side).
- **Eligibility:**
  - Players with 1+ years remaining on contract (expired Vets ineligible; expired Rookies eligible up to extension deadline).
  - Round 6 picks: NOT tradeable (the pick — player is tradeable post-selection).
  - Future picks: current year + 1 year out only.
  - Cap money: max 50% of traded-away player's salary; cannot send money without a non-salary asset.
- **Cap effect:**
  - Salary moves with the player (acquiring team takes on salary, trading team sheds it).
  - Cap cash transferred (if any) → reflected as a **`salary_adjustment` row** (same data path as cap penalties): NEGATIVE for the team shedding salary, POSITIVE for the team acquiring salary.
- **Contract impact:** Player's contract transfers as-is to acquiring team. Acquiring team gains:
  - 4-week extension window if player is in final year (automatic, no pre-agree).
  - Right to MYM **only if** the player was a recent WW/FCFS pickup AND is still in the 14-day MYM window. The MYM clock continues — does not reset on trade. Trading does NOT automatically make a player MYM-eligible.
  - Cannot extend or MYM a tagged player (until they enter FA Auction).
- **Trade window:** offseason through NFL Thanksgiving week kickoff.

### T1.8 Rookie Draft Selection
- **Source:** MFL draft results (`TYPE=draftResults`). Stored in `draftresults_combined`. **Pre-2018** legacy data lives in the local MFL DB as a table.
- **Initiator:** Owner (during live draft on Memorial Day Sunday). **Important data-layer caveat:** MFL records the franchise that physically clicked the pick, but in UPS that's not always the true owner of the pick. Example: Eric Mannila clicked Blake Bortles in 2014 but the pick had been traded to Ryan Bousquet pre-draft — Bortles ended up on Bousquet's roster (commissioner manually corrected post-draft via trade). Data layer should track the TRUE owner of the pick at the moment of selection, not just the clicker. From 2018+ the convention is: pick shows clicker, then a trade row moves the player to the correct roster.
- **Eligibility:** Player MFL classifies as an NFL rookie that year. Round 6 must be IDP/K/P.
- **Cap effect:** Rookie scale salary (see Section 1 A1) becomes Year 1 salary; counts vs. cap if on active roster, **does NOT count vs. cap if demoted to taxi**.
- **Contract impact:** Creates **Rookie** 3-year contract at scale salary, flat across all 3 years. Round 1: 4th-year option attached.

### T1.9 Dispersal Draft Pick (UPS-custom, no native MFL TYPE)
- **Source:** No native MFL TYPE — historically tracked via forum threads (upsforumotion → Slack → Discord). Player movement to correct rosters happened via post-draft trades. Modern approach: log dispersal events explicitly in commissioner-side records (`salary_adjustments` + a series of trade rows that move the player to the new owner).
- **Initiator:** Commissioner runs the draft; opt-in owners + new owner make selections.
- **Eligibility:** **Whole rosters AND draft picks** (excluding 6th-round picks per existing rule) of opt-in teams + outgoing owner's roster + outgoing owner's draft picks. NOT just players — picks too.
- **Cap effect:** Existing salary transfers as-is (old contract carries forward).
- **Contract impact:** Old contract preserved (no new deal). Receiving team takes on the salary + remaining contract years.
- **Tracking gaps:** year-by-year mechanics weren't always consistent — would need forum reconstruction to fully document. The current method is what's documented here.

### T1.10 Calvin Johnson Rule Comp Pick Award
- **Source:** UPS-custom — recorded as commissioner-side adjustment, draft pick added to the receiving team's available picks.
- **Initiator:** Commissioner (when a Tier-1 player retires).
- **Eligibility:** See Section 1 D2 / Calvin Johnson Rule for full criteria.
- **Cap effect:** None directly (the pick is a future asset).
- **Contract impact:** Comp pick is **additive** — added on top of existing picks at slot 1.13 (offense) or 3.13 (defense). Original picks at those slots still belong to whoever owns them.
- **Timing nuances:**
  - Awarded for the **current season's rookie draft** by default.
  - If retirement happens AFTER the current rookie draft → comp pick is held for **next season's draft** (MFL future-pick handling limitation).
  - **Cannot be traded until the following season** (regardless of when it was awarded).

---

## Group 2 — Roster state changes (no contract change)

### T2.1 Place on IR (`IR`)
- **Source:** MFL `TYPE=transactions&TRANS_TYPE=IR` (the audit trail). Note: IR is also a **roster STATUS** in MFL (alongside ROSTER, TAXI) — the status field is what gates the cap-relief mechanic; the transaction is just the event that put them there.
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
- **Contract impact:** Player on active roster. **Once promoted, the player is NEVER re-eligible for taxi.** (Legacy behavior: MFL would auto-promote on trade, and UPS would manually re-demote — that workaround is GONE in the modern rules.) The trade module (planned) will need to enforce no-re-demotion explicitly.

---

## Group 3 — Contract events (UPS-specific, layered on top of MFL)

These are NOT native MFL transaction TYPEs; they're tracked in UPS-side dashboards + JSON stores + the rulebook API.

> **Logging requirement (applies to ALL contract transactions in this group):** Contract events MUST be logged at all times. Data must be consistent across all applications on the site. When implementing or modifying anything contract-related, validate against existing sources of truth first. Document inconsistencies and either fix or validate the new behavior.

### T3.1 Multi-Year Auction Contract Submission (MYAC)
- **Source:** UPS dashboard input → `extension_submissions` / contract history snapshot.
- **Initiator:** Owner.
- **Eligibility:** Player acquired via FA Auction, Expired Rookie Auction, or pre-deadline waivers, currently on 1-year default. Submitted by September contract deadline.
- **Cap effect:** Year 1 salary reset per loading rules; future-year salaries set per declaration. Total TCV = sum of declared per-year salaries.
- **Contract impact:** Contract length goes from 1 year to 2 or 3. Type: Veteran (even split) or Loaded.
- **Constraints:** **5-loaded cap** (front + back combined), 6 3-year cap, front-load Year 1 ≥ AAV / back-load Year 1 ≥ 20% of TCV.

### T3.2 Mid-Year Multi (MYM)
- **Source:** UPS dashboard → `mym_submissions` table.
- **Initiator:** Owner.
- **Eligibility:**
  - FA-Auction or pre-season waiver pickup with no MYAC by Sept → MYM by NFL Week 3 kickoff (verify in event log).
  - **In-season WW or FCFS pickup → MYM within 14 days of acquisition.** The 14-day clock does NOT reset if the player is traded. Trade alone does NOT make a player MYM-eligible — only the original 14-day window from pickup applies.
  - Also: expired rookies up to the rookie extension deadline.
- **Cap effect:** Same salary across all years (no raise).
- **Contract impact:** Contract length goes from 1 year to 2 or 3 (owner choice). Type: **MYM** (its own contract type — distinct from Veteran/WW). **Cannot be loaded** — loading would constitute a Y1 restructure, which is banned in-season.
- **Limit:** 4 MYMs per team per season.

### T3.3 Extension (`Ext1` / `Ext2`)
- **Source:** UPS dashboard → `extension_submissions` table.
- **Initiator:** Owner.
- **Eligibility:**
  - Player in final year of contract.
  - **Expired rookies until rookie extension deadline.**
  - **In-season WW pickup days 15-28 of post-pickup window** (after MYM window expires, still within 4 weeks of pickup).
  - In-season trade-acquired final-year player: 4 weeks from acquisition.
- **Cap effect:** Forward-looking AAV bump applied to extension years only:
  - Schedule 1 (QB/RB/WR/TE): +$10K (1yr) / +$20K (2yr) on AAV.
  - Schedule 2 (DL/LB/DB/K/P): +$3K (1yr) / +$5K (2yr) on AAV.
- **Contract impact:** TCV reset (current year + extension years summed). 75% guarantee applies to new TCV. **`contract_type`: `Ext1` (1-year ext) or `Ext2` (2-year ext)** — case-insensitive.
- **Length:** 1 or 2 years (corresponds to Ext1 / Ext2).
- **Deadlines:**
  - Standard: September contract deadline.
  - In-season trade-acquired final-year player: 4 weeks from acquisition.
  - Rookie/preseason-waiver no-contract path: by Week 4.
  - In-season WW pickup: days 15-28 of pickup window (NOT MYM-eligible at this point).

### T3.4 Restructure
- **Source:** UPS dashboard → `restructure_submissions` table.
- **Initiator:** Owner.
- **Window:** **OFFSEASON UNTIL CONTRACT DEADLINE.** Mid-season restructures BANNED (banned pre-2025 — exact year TBD via forum). Window opens at season's end / roll-forward, closes at September contract deadline.
- **Eligibility:** Player on contract with **2+ years remaining**. (A newly-extended contract that brings remaining years to 2+ qualifies.)
- **Cap effect:** Year-by-year salary distribution changes; TCV preserved.
- **Contract impact:** Type updates to Restructure-flavored (front-load or back-load). Counts vs. **5-loaded-contract roster cap.**
- **Limit:** **3 restructures per team per season** (separate from the 5-loaded roster cap — these are different cards).

### T3.5 Tag — Offense
- **Source:** UPS dashboard → `tag_submissions` table.
- **Initiator:** Owner.
- **Eligibility:**
  - Player has **0 years remaining** post-roll-forward (i.e., on prior season's ending roster with 1 year left, now expired).
  - Positions: QB / RB / WR / TE.
  - NOT pre-extended by **same owner** in the year they're tagged. (Prior-year extensions don't block — a player can be extended one year and tagged the next.)
  - NOT tagged in the prior season.
- **Cap effect:** Tag salary = `max(tier-formula bid, prior_AAV × 1.10 rounded up to $1K)`. Tier formulas (open for review — Keith wants to revisit the math):
  - QB: T1=avg top 1-5 AAV, T2=avg top 6-15, T3=avg top 16-24
  - RB: T1=avg top 1-4, T2=top 5-8, T3=top 9-31
  - WR: T1=top 1-6, T2=top 7-14, T3=top 15-40
  - TE: T1=top 1-3, T2=top 4-6, T3=top 7-13
- **Tag fallback (unranked players):** `max(lowest-tier salary for position, prior-AAV × 1.10 rounded up to $1K)`.
- **Contract impact:** Creates 1-year tagged contract. **Tagged players cannot be extended OR MYM'd by ANY team until they enter FA Auction.** Mid-season drop does NOT reset this. Exception: if cut **before FA Auction starts**, normal rules resume.
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

### T4.5 Logo Change Fee — RETIRED
- Previously $15 cash fee for logo changes. UPS now uses AI for logos and **does not charge** for changes. Removed from active fee list.

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
  - 1-year original-length Veteran or WW under $5K
  - Taxi player never promoted (this is the "taxi-drop" mechanism in MFL — works for any taxi-eligible player, not just literal taxi-squad members at the moment of drop; legacy use was as a multi-drop tool)
  - Jail Bird (commissioner discretion)
  - Retired player (auto-eligible)
  - Off-season suspension opt-out (special handling — see B3)
  - **New owner: 1 cap-free cut** within acceptable period of joining (commissioner discretion)
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

### T5.5 Retirement (manual today, automation candidate)
- **Source:** MFL doesn't have a "retire" TYPE. Currently MANUAL: commissioner sees a news brief (Schefter / Rapoport / credible report) and adjusts. Future automation: daily search for credible-source retirement reports + auto-flag.
- **Initiator:** Commissioner.
- **Eligibility for cap-free:** Doesn't strictly require official retirement announcement — credible reporter (Schefter, Rapoport, etc.) suffices.
- **Cap effect:** Cap-free cut available; if player meets Tier-1 criteria, comp pick awarded (T1.10).
- **Contract impact:** Player off roster.

### T5.6 Suspension Opt-Out (off-season only) — RULE UNDER REVIEW
- **Source:** UPS-custom; tracked as a `salary_adjustments` row + contract metadata note.
- **Status:** This rule may have been simplified — Keith suspects we may have moved to "drop player to suspended status, get 50% discount automatically" (i.e., treat like IR). Need to verify in Discord. Also under consideration: allow drop to taxi for suspended players since that auto-removes salary entirely. **Treat the rule below as the OG documented version; may be stale.**
- **Initiator (OG):** Owner (must declare before contract deadline).
- **Eligibility (OG):** Player on contract with off-season-announced season-long suspension.
- **Cap effect (OG):** Salary $0 for the suspended season; original salary resumes after suspension.
- **Contract impact (OG):** Contract effectively pauses for the suspended year.

### T5.7 Expiring Contract → Free Agent
- **Source:** Auto (no transaction TYPE); contract simply expires at March roll-forward.
- **Cap effect:** Salary leaves the cap.
- **Contract impact:**
  - Expired Rookie → Expired Rookie Auction (unless extended by deadline).
  - Expired Veteran → full free agent for next FA Auction (unless tagged).

---

## Group 6 — Out-of-scope

### T6.1 Lineup Submission
- MFL `import?TYPE=lineup`. Not a transaction in the cap sense — informational only.

> **Survivor Pool / NFL Pool — UPS does NOT run these.** Removed from the catalog.

---

## G. CROSS-SECTION VALIDATION RULES

These are invariants that must hold across the data layer for any 2026 contract state to be consistent. The bid sheet's cap math depends on these.

> **Naming:** "cap penalty" is one *type* of cap adjustment. The general term is **cap adjustment**, with subtypes including: drop penalty, traded salary (positive/negative), late dues fine, missed-nomination fine, IR cap relief (positive), and more. Below uses "cap adjustments" as the umbrella.

1. **Sum of all rostered active salaries + tagged salaries − IR refunds + outstanding cap adjustments ≤ $300K** for every team — **applies from FA Auction completion onward.** Does NOT apply during offseason before FA Auction starts (no upper cap then).
2. **Sum of all rostered active salaries + tagged salaries ≥ $260K** must be true at SOME timestamp during the FA Auction OR by the September contract deadline. Failing both → out of compliance.
3. **`contract_type` history is append-only** — every contract event creates a new row; old rows preserved for audit (`R-D-2`, `R-D-3` data standards).
4. **Loaded contracts on roster ≤ 5** at all times (front + back combined).
5. **3-year contracts on roster ≤ 6** (excluding rookie 3-year deals).
6. **MYM events per team per season ≤ 4.**
7. **Restructure events per team per season ≤ 3.**
8. **Tag events per team per season ≤ 2** (1 offense + 1 defense/ST).
9. **A player can have at most ONE active contract at a time.** Trades transfer the contract; they don't create a new one.
10. **Round 6 picks are NOT in `transactions_trades` with `asset_type='DRAFT_PICK'` or `'FUTURE_PICK'`.** If they appear, the trade is invalid.
11. **For an extension event, the player must be in the final year (`contract_year=1`) OR be in an in-season WW pickup window days 15-28 OR an expired rookie pre-deadline.**
12. **Tag eligibility:** player has 0 years remaining post-roll-forward (from prior season ending roster). Cannot be pre-extended by same owner this year. Cannot be tagged by anyone else until after they enter FA Auction. Mid-season drop does NOT reset this. (Prior-year extensions DO NOT block tag eligibility.)
13. **For a comp-pick award, the retiring player must have been under contract** at retirement (excludes expired Veteran contracts; includes expired Rookie contracts). Comp pick is **additive** — does not displace any existing pick.
14. **Once promoted from taxi, a player is never re-eligible for taxi.**
15. **MYM 14-day clock from acquisition does not reset on trade.** Trade alone does not make a player MYM-eligible.

---

## H. STILL-OPEN ITEMS for Section 2

1. **MFL waiver lock duration** — verify in MFL settings how long a player is on waivers / locked when added.
2. **MFL `TagOrExpiredRookie` auction type ambiguity** — UPS infers ERA vs Tag context by date. ERA + Tag are typically run together (Apr-May), separate from FA Auction (Jul-Aug).
3. **In-season MYM exact deadline** (carries from Section 1).
4. **Suspension opt-out rule** — verify in Discord whether the OG rule still applies or has been simplified to "drop to suspended status, auto 50%."
5. **Pre-2025 in-season restructure ban** — verify exact year via forum.
6. **Tag tier formulas** — Keith wants to revisit the math; current formulas remain authoritative until changed.

---

## END Section 2 (LOCKED v4)

---

# Section 3 — Annual Calendar

The UPS league year operates on a 12-month cycle anchored to the NFL season. This section enumerates **every recurring deadline + event** with exact 2026 dates where known. The MFL **calendar/event log** is the source of truth for any specific deadline — dates here should be cross-checked against it before relying on them for the bid sheet.

> **2026 anchor dates (NFL):** Memorial Day = Mon May 25, 2026 → Rookie Draft Sunday = May 24. NFL Week 1 likely Sept 10 (Thu kickoff). Thanksgiving = Thu Nov 26, 2026.
> **Action item:** pull the current 2026 MFL calendar via `TYPE=calendar&L=74598` and lock these dates in.

---

## A. Annual Cycle by Month

### January
- **Off-season after fantasy playoffs.**
- League standings are settled; Toilet Bowl + Hawktuah Bowl results determine the start of next year's draft order (1.1–1.6 toilet side, 1.7–1.12 championship side).
- **No transactions allowed** — drops not permitted in offseason. Trade window is open (offseason).

### February
- **Off-season continues.**
- Tag eligibility lists begin to firm up (using prior season's ending roster — players with 1 year remaining at season end become 0-year-remaining post-roll-forward → tag candidates).
- Trade activity heats up as owners plan offseason moves.

### March (1–15)
- **Annual Roll-Forward.**
  - Goal date: March 1; can extend to March 15 depending on commissioner preparation.
  - All contracts decrement by 1 year remaining; salaries advance to next-year value (per-year salary table from each contract).
  - Prior-year salary becomes 100% earned at this moment (sunk cost — no future cap penalty contribution from that year).
  - Players with 0 years remaining become candidates for tag, extension (if rookie), or expiry to free agency.
- **Trade window** continues throughout offseason.
- **Restructure window opens** (offseason restructure runs from rollover through September contract deadline).

### April / Early May
- **Tag deadline + Expired Rookie Auction (combined cluster).**
  - **Tag submissions** (offense tag + defense/ST tag per team) — exact date in MFL event log.
  - **Rookie extension deadline** — extensions for expired rookie contracts must be submitted before this. Exact date is in the event log; legacy "April 30" is no longer authoritative.
  - **Expired Rookie Auction (ERA)** — runs after rookie extension deadline. Format:
    - Starting bid: $1K (changed from prior-yr+$1K rule in 2025)
    - 36-hour proxy lock
    - 2-3 day nomination window
    - Forced retention through next FA Auction
  - **Note:** ERA is typically conducted alongside the Tag period (Apr-May). They're not the same event but share the calendar slot.

### Late May (Memorial Day Sunday) — May 24, 2026
- **Annual Rookie Draft.**
  - Sunday of Memorial Day weekend.
  - 6 rounds × 12 picks. Live, broadcast on Discord.
  - Mandatory league event. Typically starts 6:00–6:30 PM, runs ~4 hours, expect 10-15 trades during the event.
  - Round 1 picks: Active roster (no taxi). 1st-round option year applies (2025+).
  - Rounds 2-5: Taxi-eligible.
  - Round 6: IDP/K/P only, pick not tradeable, random draft order.

### June
- **Quiet month.** Trade activity continues. Owners begin preparing for FA Auction (rosters, cuts, cap analysis).

### July (Last Weekend)
- **Auction Roster Lock Date** (3 days before auction start) — last chance to cut players before auction. Locked until auction completes.
  - **Note:** Keith may consolidate this into "no cuts during auction" + auto-unlock via MFL API in a future rule revision.
  - Cut-then-rebid prohibition: any player you cut during offseason is off-limits for nomination/bidding in the auction.
- **Free Agent Auction begins (last weekend of July).**
  - 7-day minimum nomination window.
  - eBay proxy bidding, 24-hour lock.
  - 2 nominations per 24-hour window (Day 1 has 12-hour kickoff).
  - Mandatory league event.
  - Roster floats up to 35 players during auction.
  - $260K cap floor must be hit at SOME point during auction (can be satisfied via front-loading post-auction).

### August
- **Auction completes (~early August).**
- **Min roster check (27 players)** at close of auction.
- **Waivers open** at completion of auction. First Blind Bid waiver run typically the first Wednesday-or-Thursday after auction (verify in MFL settings).
- **Payment milestone:** half of $200 league dues owed by FA Auction start (some flexibility on completion).

### September (Last Sunday before NFL Week 1) — likely Sun Sept 6, 2026
- **Contract Finalization Deadline** (a.k.a. September contract deadline).
  - Last day to submit Multi-Year Auction Contracts (MYAC) for FA-Auction or pre-deadline waiver pickups.
  - Last day for standard extensions.
  - Restructure window closes.
  - Tag confirmations finalized.
  - Roster max drops from 35 → 30 after this date.
- **Cap floor compliance check:** must be at $260K committed by this date if not already during auction.

### NFL Week 1 (likely Sept 10–14, 2026)
- **Fantasy season starts.**
- Lineup submissions due before each player's NFL kickoff (system auto-locks).
- Blind Bid Waivers begin: Thu/Fri/Sat/Sun 9 AM. FCFS opens after Sunday morning waiver run, runs until each player's kickoff.

### NFL Week 2 (mid-Sept 2026)
- **MYM deadline for FA-Auction / pre-season waiver pickups** without a contract by Sept deadline. Verify in event log — Keith recalls "before Week 3 kickoff" (i.e., end of Week 2).

### NFL Week 4 (early Oct 2026)
- **Extension deadline for rookie / preseason-waiver no-contract path** (players who weren't given a contract at Sept deadline AND didn't get a MYM by Week 2).

### October 31 (or end of NFL October)
- **First earning checkpoint:** 25% of current-year salary earned. Cuts after this point have less penalty exposure.

### November 26, 2026 (Thanksgiving) — Trade Deadline
- **Trade deadline:** kickoff of Thanksgiving Day game(s). After kickoff, no trades until next offseason.
- **Second earning checkpoint:** 50% earned (end of November).
- **Payment milestone:** remaining $100 league dues owed by trade deadline.

### December 14, 2026 (NFL Week 15) — Playoffs Begin
- **Fantasy Playoffs start (Week 15)**, 3-week format running through NFL Week 17.
- **Third earning checkpoint:** 75% earned (end of December).
- Toilet Bowl runs in parallel with the championship bracket.

### NFL Week 17 (early Jan 2027)
- **Fantasy Playoffs end.** Champion crowned. Toilet Bowl champion crowned (Hawktuah Bowl).
- Rookie draft order finalized based on bracket results (see [memory: league_history_timeline.md](../../.claude/projects/-Users-keithcreelman-Code-upsmflproduction/memory/league_history_timeline.md)).

### Post-Season Roll-Forward (back to March)
- After fantasy playoffs end → off-season → cycle repeats.
- 100% earning checkpoint hits at March 1–15 roll-forward.

---

## B. Recurring In-Season Cadences

| Cadence | Event |
|---|---|
| **Mon-Wed** | Players dropped Mon 9 PM hit waivers; locked until Thu 9 AM. (Verify exact lock duration in MFL settings.) |
| **Thu / Fri / Sat / Sun 9 AM** | Blind Bid Waiver runs |
| **Sun morning post-waivers → Sun kickoff** | FCFS Free Agency open until each player's NFL kickoff |
| **Tue / Wed offseason** | Trade deadline check + general league business |
| **Daily during auction** | 2 nominations per owner per 24-hour window |

---

## C. Calendar-Driven Cap Penalty Timing

The same `(TCV × 75%) − Earned` cap penalty formula has 3 different timing buckets based on when the cut occurs:

| Cut Window | Hits Which Season's Cap |
|---|---|
| Offseason → Roster Lock Date (3 days before FA Auction) | **Current season** |
| FA Auction start → end of fantasy season | **Following season** |
| Post-fantasy-season → next year's Roster Lock Date | **Current season** (same as bucket 1, treats it as offseason of upcoming year) |

The "current season" in bucket 3 means the season that just rolled over.

---

## D. Mandatory Events (compliance flags)

These are MANDATORY league events. Skipping or failing to engage = penalty risk.

1. **Rookie Draft** (Memorial Day Sunday) — must participate or have proxy
2. **Free Agent Auction** (last weekend of July) — must nominate 2/day, must be reachable
3. **Lineup submissions** every fantasy week
4. **League dues payment** (split: half by FA Auction, half by Thanksgiving)

Late dues fines accrue at $3K/week.

---

## E. STILL-OPEN ITEMS for Section 3

1. **2026 actual dates** — pull from MFL `TYPE=calendar&L=74598` and lock the exact day-of-week for: Auction Roster Lock, Auction Start, Auction Close, Sept Contract Deadline, Week 2/3/4 boundaries.
2. **MFL waiver lock duration** — exact hours from drop → waiver clear.
3. **In-season MYM precise deadline** — verify "before Week 3 kickoff" via event log.
4. **Roster Lock Date future** — Keith may eliminate this; consolidate into auction-start auto-unlock.

---

## END Section 3
