# UPS Salary Cap Dynasty — League Context (v13, Section 4 corrections from review)

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
- [x] Section 1 — Player Lifecycle — **LOCKED** (v8)
- [x] Section 2 — Transaction Catalog — **LOCKED** (v8)
- [x] Section 3 — Annual Calendar — **LOCKED** (v8)
- [x] Section 4 — Scoring & Roster Eras (timeline) — **LOCKED v12**
- [ ] Section 5 — Franchise History (joins, rebrands, dispersals) — deferred (skeleton in memory)
- [x] Section 6 — Cap mechanics (penalties, guarantees, floor/ceiling, worked examples) — **LOCKED v11**
- [ ] Section 7 — Bot Integration Spec (deferred to last; depends on all prior sections)
- [ ] Section 8 — Contract Activity & Player Lineage Tracking (added v13 — non-critical but Keith wants it)

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
- **Round 6 (UPDATED 2025+)** — Must be used to select **IDP only**. **Kickers and Punters are NOT eligible** (the prior PK/PN expansion was reversed in 2025). Pick is **NOT tradeable** (forces every team to make at least one IDP selection per year). Player can be traded after the pick is made. 3-year contract. Random draft order.
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
| 6.01 – 6.12 | $1K | $3K | IDP only (2025+; PK/PN reverted out), pick not tradeable |

  Note: the Draft War Room HTML labels the Round 1 option as a "5th-year team option" — that's borrowed NFL parlance. UPS rookie base is 3 years, so the option year is technically the 4th season (per Keith's worked example: 1.01 path 15/15/15/20/40/40).
- **Draft order (Rounds 1–5):** based on prior season's playoff bracket. Inverse: Toilet Bowl winner picks 1st (rewards being bad enough to win the toilet); UPS Champion picks 12th. Full bracket mapping:

  **Toilet Bowl side (picks 1.01–1.06):**
  - 1.01 = Toilet Bowl champion (won the Toilet)
  - 1.02 = Toilet Bowl runner-up (lost in Toilet championship)
  - 1.03 = Toilet Bowl semifinal winner
  - 1.04 = Toilet Bowl semifinal loser
  - 1.05 + 1.06 = decided by a Week 16 matchup between the two Week-15 first-round Toilet losers (winner gets 1.05, loser gets 1.06)

  **Championship side (picks 1.07–1.12):**
  - 1.07 + 1.08 = decided by a Week 16 matchup between the two Week-15 first-round championship losers (winner gets 1.07, loser gets 1.08)
  - 1.09 = championship semifinal loser
  - 1.10 = championship semifinal winner (consolation winner — gets later pick because they advanced + got money)
  - 1.11 = championship runner-up (lost in UPS championship)
  - 1.12 = UPS champion
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
- **Cut-then-rebid prohibition (with example, v10 rules):** if you cut a player who was **under contractual control** in the offseason, you **cannot nominate or bid on them in the FA Auction**. Commissioner-enforced (NOT MFL-enforced). Mostly self-enforcing because cut players are usually disappointments owners don't want back.
  - **Example:** Owner X has Player A on a 1-year, $2K contract entering the 2026 season. In April 2026 (offseason), Owner X cuts Player A. In the July 2026 FA Auction, Owner X **cannot nominate or bid on Player A** — locked out from re-acquiring him via auction.
  - **Tagged-player exception (Keith v10):** if the player you cut was on a **TAG**, the prohibition does NOT apply. You CAN bid on a tagged player you cut. (Tags effectively "open" the player back into the FA pool with no carryover restrictions.)
  - **Pre-auction drop reset (Keith 2026-04-27):** drops done within the pre-auction window (the few days immediately before auction start, prior to roster lock) "reset" the prohibition — the drop is fine and Owner X CAN bid on Player A. The cut-then-rebid lockout only applies to drops earlier in the offseason.
  - **Cutdown day (Keith v10, future direction):** a 2-day-before-auction "cutdown day" is being added — that day exists to verify everything is set up properly (testing) before auction goes live. Reconciles with the existing 3-day-prior Auction Roster Lock; final mechanism still being settled.
- **Default contract:** **1 year** if no Multi-Year Auction Contract is submitted. Multi-Year option = 2-year or 3-year, Veteran or Loaded.
- **Bid increments:** **$1K** (always).
- **Naming note (decided 2026-04-27):** Keep "Veteran" contract type as-is. Rename idea parking-lotted.

### A3. Expired Rookie Auction (overlaps with Rookie Draft weekend)

- **Eligibility:** any player whose **rookie contract expired** and was **NOT extended** by the rookie extension deadline (Thu before Memorial Day weekend — see Section 3 for exact date).
- **Timing (NEW PATTERN, 2025+):** ERA **starts on the Saturday before Memorial Day weekend** and runs **through the Rookie Draft on Memorial Day Sunday**. ERA and the Rookie Draft now overlap. Historical pattern (pre-2025) had ERA in early-to-mid May, separated from the draft.
- **Format:**
  - 2–3 day nomination window (overlapping with rookie draft active hours)
  - **Starting bid: $1K** (changed in 2025 — old "prior-year salary + $1K" rule is dead). Reason: under the old rule a $13K player needed a $14K opening nomination; nobody wanted that. $1K floor lets someone start the bidding.
  - **36-hour** lock window. Resets on new high bid.
- **Contract on win:** 1, 2, or 3 years, same loading rules as FA Auction (front-load OR back-load, capped at **5 loaded contracts** on roster). No "sign immediately" benefit — FA Auction submission deadline applies.
- **Forced retention:** players won in Expired Rookie Auction **cannot be cut until after that summer's FA Auction** (just through the auction window, not the entire season). Concept: no "get out of jail free" — you bid, you hold through auction.

### A4. Blind Bid Waivers (in-season — Thu/Fri/Sat/Sun 9 AM ET)

- **Mechanism:** Conditional blind bidding. Bid amount **becomes the player's salary for the current season**.
- **Contract type during season:** **WW** (Waiver Wire) for all in-season blind bid pickups, regardless of player NFL status. NFL rookies picked up via WW are still WW during the season — Keith **manually converts WW → Rookie status at year-end** for any rookies who survived the year, so they enter the next-year ERA path. Not a separate `contract_type`; it's a year-end data cleanup.
- **Conditional bidding format:** owners group bids; within each group, the highest-bid player is awarded; groups have NO priority over each other (they're placeholders, not priorities). Winners determined by bid amount across all groups.
- **Tiebreakers:** All-Play → Overall → Total Points → H2H. Pre-season + Week 1 use prior-season's final draft slot (reverse order — bad teams priority).
- **MFL doc reference:** the "How do I enter blind bid request?" MFL help page should be added to repo documentation for owner reference.

### A5. First-Come, First-Serve (FCFS) Free Agency (Sunday after waiver run → kickoff)

- **Trigger:** after the Sunday morning waiver run, FA opens FCFS until each player's NFL kickoff.
- **Salary:** $1K flat for current season.
- **Contract:** 1-year WW. NFL rookies picked up via FCFS are tagged WW during season; Keith manually converts WW → Rookie at year-end so they hit ERA path next May.

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
- **In-season trade-and-extend window:** acquiring team has **4 weeks from acquisition** to extend a player in their final year. The right to extend is automatic for the acquiring team.
- **Pre-trade extension (wired in the Trade War Room module):** if the trading-away team currently has extension eligibility on the player, they can apply that extension as their last action before the trade. The now-extended player goes to the acquiring team carrying the extended contract. (This is NOT a "pre-agreement" — it's the trading-away team using their own extension right before the trade closes.)
- **Tagged players: cannot be extended by the acquiring team** in trade. Tag overrides extension eligibility.
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
- **Eligibility window:** Tag candidates are players whose contract is set to expire heading into the upcoming season (i.e., 1 year remaining at end of prior season → 0 years remaining heading into next season). Eligibility is computed from the **prior-season ending roster**.
- **Tagged player constraints (CONFIRMED 2026-04-28):**
  - A player CAN be extended in a prior year and then tagged the following year — extension does NOT permanently block tag.
  - Cannot be **pre-extended by same owner** in the year they're tagged.
  - Cannot be **tagged by anyone else** in the current season.
  - **Once tagged, the player CANNOT be extended OR MYM'd by ANY team — period.** No 1-year tag → re-extension path. The tagged year is a 1-year contract; **the player MUST enter next summer's FA Auction**. The team that tagged them retains the player for that one season only (no extension option afterward).
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
  - **Eligibility:** Player must be (1) under contract AND on a roster at retirement, (2) not PK or PN, (3) most recently completed season qualified as **"Tier 1"** at their position. **"Tier 1" definitions align with the Tag Tier Calcs** (see C8 / T3.5):
    - QB Tier 1 = top 1–5 by AAV
    - RB Tier 1 = top 1–4
    - WR Tier 1 = top 1–6
    - TE Tier 1 = top 1–3
    - DL Tier 1 = top 1–6
    - LB Tier 1 = top 1–6
    - DB Tier 1 = top 1–6
    - PK / PN = excluded entirely from Calvin Johnson Rule
  - **What counts as "under contract":** Excludes expired Veteran contracts. **Includes** expired Rookie contracts (rookie just expired but player retires before re-signing → owner still gets comp).
  - **Compensation:**
    - Offensive Tier-1 retiree → comp pick **1.13** (extra Round 1 slot, sequential after pick 1.12). **Not taxi-eligible.**
    - Defensive Tier-1 retiree → comp pick **3.13**. **IS taxi-eligible.**
    - **Multiple retirees same side same year:** sequential slots — 1.13, 1.14, 1.15… (or 3.13, 3.14, 3.15…). Random generator determines order, but each gets their own pick (slots are not collapsed).
  - **Awarded for the current season's rookie draft.** If the retirement happens AFTER that season's rookie draft, the comp pick is held over to next season's draft (MFL future-pick handling).
  - **Comp pick cannot be traded until following season.**
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

## F. STILL-OPEN QUESTIONS (post-v8)

1. **Jail Bird Rule** — vague by design (commissioner discretion). No formal definition needed for code, but flag at decision time. (Aaron Hernandez was the canonical case; "released by NFL team" is NOT sufficient on its own.)

(MYM in-season deadline was resolved in v8 — see Section 3 for "Thursday Night Football kickoff" standard. Other prior open items resolved or moved to "Open Items Master List" appendix.)

---

## END Section 1 (LOCKED v8)

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
  - **Cap money: each side independently capped at 50% of THEIR OWN traded-away player's salary.** Multi-player trade: max = 50% of sum. Cannot send money without a non-salary asset (Keith v10 corrected).
- **Cap effect:**
  - Salary moves with the player (acquiring team takes on salary, trading team sheds it).
  - Cap cash transferred (if any) → reflected as paired **`salary_adjustment` rows**: NEGATIVE for the team shedding cap, POSITIVE for the team acquiring cap.
- **Contract impact:** Player's contract transfers as-is to acquiring team. Acquiring team gains:
  - 4-week extension window if player is in final year (automatic; "pre-agreement" verbiage is stale — see Trade War Room module pre-trade extension flow in Section 6.E3).
  - Right to MYM **only if** the player was a recent WW/FCFS pickup AND is still in the 14-day MYM window. The MYM clock continues — does not reset on trade. Trading does NOT automatically make a player MYM-eligible.
  - Cannot extend or MYM a tagged player.
- **Trade window:** offseason through NFL Thanksgiving week kickoff.

### T1.8 Rookie Draft Selection
- **Source:** MFL draft results (`TYPE=draftResults`). Stored in `draftresults_combined`. **Pre-2018** legacy data lives in the local MFL DB as a table.
- **Initiator:** Owner (during live draft on Memorial Day Sunday). **Important data-layer caveat:** MFL records the franchise that physically clicked the pick, but in UPS that's not always the true owner of the pick. Example: Eric Mannila clicked Blake Bortles in 2014 but the pick had been traded to Ryan Bousquet pre-draft — Bortles ended up on Bousquet's roster (commissioner manually corrected post-draft via trade). Data layer should track the TRUE owner of the pick at the moment of selection, not just the clicker. From 2018+ the convention is: pick shows clicker, then a trade row moves the player to the correct roster.
- **Eligibility:** Player MFL classifies as an NFL rookie that year. Round 6 must be IDP (2025+ rule; PK/PN no longer eligible).
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
12. **Tag eligibility:** player has 1 year remaining at end of prior season (= 0 years remaining heading into upcoming season). Cannot be pre-extended by same owner this year. Cannot be tagged by anyone else this year. **Once tagged, NEVER extend or MYM — period.** Tagged players MUST go to next summer's FA Auction (no path to re-extend). Mid-season drop does NOT reset this. Prior-year extensions DO NOT block tag eligibility.
13. **For a comp-pick award, the retiring player must have been under contract** at retirement (excludes expired Veteran contracts; includes expired Rookie contracts). Comp pick is **additive** — does not displace any existing pick. Multiple Tier-1 retirees on same side → sequential slots (1.13, 1.14, 1.15… or 3.13, 3.14, 3.15…), not collapsed. PK/PN excluded from comp.
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

## END Section 2 (LOCKED v8)

---

# Section 3 — Annual Calendar

The UPS league year is a 12-month cycle anchored to the NFL season. **Dates below are pulled from authoritative repo sources** — not estimated:

- **`docs/ups_v2/V2_GOVERNED/mfl/event_window_matrix.csv`** — governed UPS deadline seeds, approved 2026-03-17 / 2026-03-18 (`user_directive_2026-03-17` / `_2026-03-18`).
- **`site/ups_options_widget_schedule_2026.json`** — NFL Week kickoff timestamps for the 2026 fantasy season (used by the options widget).
- **Local `league_events` table** (mfl_database.db) — historical 2010-2025 event dates.

**Source-of-truth ranking when calendar dates conflict:**
1. MFL `TYPE=calendar&L=74598` live API for the active season
2. `event_window_matrix.csv` (governed seed dates with audit trail)
3. `ups_options_widget_schedule_2026.json` (NFL kickoff timestamps)
4. `league_events` SQLite table (historical reference)

---

## A. 2026 Confirmed Dates (from sources above)

### Pre-season UPS deadlines (from `event_window_matrix.csv`)

| Date | Day | Event | Source |
|---|---|---|---|
| 2026-03-11 | Wed | NFL league year starts | official_nfl_dates |
| 2026-04-23 | Thu | NFL Draft starts | official_nfl_dates |
| **2026-05-21** | **Thu** | **UPS rookie extension deadline** | `event_window_matrix.csv` |
| 2026-05-24 | Sun | UPS Rookie Draft (Memorial Day Sunday — inferred from rule) | rule + Memorial Day = May 25 |
| **2026-09-06** | **Sun** | **UPS contract deadline** (last Sun before NFL Week 1) | `event_window_matrix.csv` |
| **2026-09-10** | **Thu** | **NFL Week 1 kickoff** | `event_window_matrix.csv` |
| **2026-09-24** | **Thu** | **UPS preseason MYM deadline** (= Week 3 kickoff Thu) | `event_window_matrix.csv` |
| **2026-10-07** | **Wed** | **UPS preseason extension deadline** (day before Week 5 kickoff) | `event_window_matrix.csv` |
| **2026-11-26** | **Thu** | **UPS trade deadline** (Thanksgiving kickoff) | `event_window_matrix.csv` |

### NFL Week kickoffs (decoded from `ups_options_widget_schedule_2026.json`)

> **NOTE on times (Keith 2026-04-28):** the precise times below are PLACEHOLDER — they auto-update once the NFL releases the official 2026 schedule. The DAYS-OF-WEEK are correct (Thursdays); the precise kickoff times are not authoritative until NFL schedule release.

| Week | Day | Date |
|---|---|---|
| 1 | Thu | 2026-09-10 |
| 2 | Thu | 2026-09-17 |
| 3 | Thu | 2026-09-24 |
| 4 | Thu | 2026-10-01 |
| 5 | Thu | 2026-10-08 |
| 6 | Thu | 2026-10-15 |
| 7 | Thu | 2026-10-22 |
| 8 | Thu | 2026-10-29 |
| 9 | Thu | 2026-11-05 |
| 10 | Thu | 2026-11-12 |
| 11 | Thu | 2026-11-19 |
| 12 | Thu | **2026-11-26** (Thanksgiving — trade deadline) |
| 13 | Thu | 2026-12-03 |
| 14 | Thu | 2026-12-10 |
| 15 | Thu | **2026-12-17** (UPS Playoffs Round 1 starts) |
| 16 | Thu | **2026-12-24** (UPS Playoffs Round 2 / Toilet placement) |
| 17 | Thu | **2026-12-31** (UPS bracket finals — name TBD; Toilet = Hawktuah Bowl) |
| 18 | Sat | 2027-01-09 (last NFL regular-season week — NOT Wild Card weekend) |

> **Bracket name (open):** Keith wants to rename "UPS Championship" — flagging as parking lot. Toilet Bowl = Hawktuah Bowl is locked in.

### Tag Deadline + Rookie Draft (CONFIRMED via `site/ccc/ccc.js` formula)

The Contract Command Center widget code (`site/ccc/ccc.js`) defines two computed dates anchored to Memorial Day:
- **`tagDeadline = MemorialDay − 4 days` = Thursday before Memorial Day weekend**
- **`rookieDraft = MemorialDay − 1 day` = Sunday before Memorial Day**

For 2026 (Memorial Day = Mon May 25):

| Date | Day | Event | Source |
|---|---|---|---|
| **2026-05-21** | **Thu** | **UPS Tag deadline** (offense + def/ST submissions) | `ccc.js` `getTagDeadlineInfo` (memorial − 4) |
| 2026-05-21 | Thu | UPS Rookie Extension deadline (same day as tag deadline — combined) | `event_window_matrix.csv` |
| **2026-05-24** | **Sun** | **UPS Rookie Draft** | `ccc.js` `getTagDeadlineInfo` (memorial − 1) |
| 2026-05-25 | Mon | Memorial Day (NFL holiday) | calendar |

### ERA + FA Auction (inferred from historical `auction` table)

The local SQLite `auction` table (`mfl_database.db`) records every winning bid by `time_started` (epoch). Aggregating 2020–2024 reveals the ERA and FA Auction windows directly:

| Year | ERA window | FA Auction window |
|---|---|---|
| 2020 | May 16 – mid-May | Jul – Aug 27 |
| 2021 | (none in May; auction ran Jun 1 → Aug 10) | Jun – Aug 10 |
| 2022 | May 6 – May 11 | Aug 2 – Aug 7 |
| 2023 | May 12 – May 14 | Jul 29 – Aug 6 |
| 2024 | May 14 – May 19 | Jul 27 – Aug 6 |
| 2025 | May 26 – May 27 (post-draft tail) | Aug 7 – Aug 9 (per CSV reports) |

**Pattern:** ERA runs in mid-May (~5–10 days before Tag deadline + Rookie Draft); FA Auction runs late July through early-to-mid August (~10-day window).

### 2026 expected (need MFL `TYPE=calendar` confirmation; values below reflect the new pattern Keith confirmed)

**ERA + Rookie Draft overlap (NEW PATTERN, 2025+):** ERA now starts on the **Saturday before Memorial Day weekend** and runs through (overlapping) the Rookie Draft on Memorial Day Sunday.

- **ERA start:** ~**Sat 2026-05-23**
- **ERA active through:** Sun 2026-05-24 (Rookie Draft day; ERA continues during/around the draft)
- **Tag Deadline:** Thu 2026-05-21 (computed)
- **Rookie Draft:** Sun 2026-05-24 (computed)

> **2025 ERA precedent confirmed (Keith 2026-04-28):** "'25 ERA started before the rookie draft but it was the same weekend and this is **new pattern** and you will see overlap."

**FA Auction (2026 format LOCKED 2026-04-28):**
- **Format:** **Saturday start, 12-day window** (Keith confirmed). Auction completes the following Thursday (Sat + 12 days).
- **Window:** last week of July / first of August. Exact 2026 start date TBD via MFL calendar.
- **Auction Cut Deadline (Roster Lock):** still 3 days before auction start (Wed before the Saturday start). **Open: Keith plans to verify + validate this rule's future direction; not worth fixing right now.**
- **Auction Close:** Sat-start + 12 days = the following Thursday.
- **Waivers Begin:** **1st Thursday after FA Auction completes** (Keith confirmed).

**Earning checkpoints (current rule):** 25% / 50% / 75% at end of Oct / Nov / Dec.

> **Future direction (Keith 2026-04-28):** Consider switching to **per-game prorated earning** rather than calendar checkpoints (also for FA pickups — would more accurately represent the truth). Needs league review.

**MYM + extension deadline timing (new standard, confirmed 2026-04-28):** Use **kickoff of the FIRST Thursday Night game in the relevant week** as the consistent cutoff for both MYM and extension. If a Thursday slate has multiple games, the deadline is the kickoff of the FIRST game on that Thursday.

### 2025 reference dates (from `league_events` SQLite table — for cross-validation)

- 2025-05-25 (Sun): rookie extension deadline (Memorial Day Sunday — note: same day as draft for 2025; for 2026 it's a Thu before)
- 2025-08-31 (Sun): UPS contract deadline
- 2025-09-04 (Thu): NFL kickoff
- 2025-09-17 (Wed): preseason MYM deadline
- 2025-10-01 (Wed): preseason extension deadline
- 2025-12-29 (Mon): UPS season complete

---

## B. Annual Cycle by Month (with 2026 dates)

### January 2026 → Off-season
- **Fantasy playoffs end** late Dec 2025 / early Jan 2026 (variable — depends on when NFL final week ends; some years runs into early January).
- League standings settled. Toilet Bowl + Hawktuah Bowl results determined the 2026 rookie draft order.
- **No drops allowed** in offseason. **Trade window open.**

### February 2026 → Off-season
- Trade activity peaks as owners plan offseason moves.
- Tag eligibility lists firming up (players with 0 years remaining post-rollover from prior season's ending roster).

### March 2026 → Roll-Forward + League Year Start
- **2026-03-11 (Wed):** NFL league year starts.
- **March 1–15 window:** UPS Annual Roll-Forward.
  - All contracts decrement years remaining.
  - Salaries advance to next-year value.
  - Prior-year salary 100% earned (sunk; no further penalty contribution).
  - Players hitting 0 years remaining → tag/extension/free-agent paths.
- **Restructure window open** (March → September contract deadline).

### April 2026 → NFL Draft + Tag Period
- **2026-04-23 (Thu):** NFL Draft starts (real NFL, sets rookie pool).
- **Tag submissions** open (date TBD — pre-rookie-extension-deadline, in early May).

### May 2026 → Tag + Rookie Ext Deadline + ERA + Rookie Draft (overlapping cluster)
- **2026-05-21 (Thu):** **Tag deadline (offense + def/ST) AND Rookie extension deadline** — same day, combined.
- **~2026-05-23 (Sat):** **Expired Rookie Auction (ERA) starts.** ERA now overlaps with the rookie draft weekend (new pattern as of 2025).
- **2026-05-24 (Sun, Memorial Day Sunday):** **Annual Rookie Draft.** 6 rounds × 12 picks. Live, Discord. Mandatory. Typically starts 6:00–6:30 PM, runs ~4 hours.
- **ERA runs concurrent with / through** the Rookie Draft and into the days after (per Keith — new pattern, expect overlap).

### June 2026 → Quiet
- Trades continue. Owners prep for July FA Auction.

### July 2026 → FA Auction Begins (Last Weekend)
- **Auction Roster Lock Date 2026:** ~3 days before auction start (date TBD — Wed July 22 if auction starts Sat July 25).
- **FA Auction starts:** last weekend of July (date TBD; typically Sat).
  - 7-day minimum nomination window.
  - eBay proxy bidding, 24-hour lock.
  - 2 nominations per 24-hour window (Day 1 has 12-hour kickoff).
- **Mandatory league event.**

### August 2026 → FA Auction Close + Waivers Open
- **FA Auction completes** ~early-to-mid August (date TBD; depends on auction format option chosen).
- **Min roster check (27)** at close.
- **Waivers open: 1st Thursday after FA Auction completes** (Keith confirmed). BBID runs Thu/Fri/Sat/Sun 9 AM ET. FCFS opens immediately after each Sunday waiver run.
- **Half league dues** ($100 of $200) due by FA Auction start. Venmo to **@Keith-Creelman** for routing to treasurer **Josh Martel**.

### September 2026 → Contract Deadline + NFL Week 1
- **Tag confirmations are NOT here.** Tags are confirmed at the **FA Auction Cut Deadline** (the auction roster lock 3 days before auction start). That same date locks the **next-season tagging baseline** — data snapshot for next year's tag eligibility freezes there.
- **2026-09-06 (Sun):** **UPS contract deadline.** Last day for:
  - Multi-Year Auction Contract (MYAC) submissions
  - Standard extensions
  - Restructure window closes
  - Roster max drops from 35 → 30
- **Cap floor compliance check:** $260K must be hit by this date (or during FA Auction, whichever applies).
- **2026-09-10 (Thu):** **NFL Week 1 kickoff.** Fantasy season starts.
  - **Waivers run at 9 AM Eastern Thu/Fri/Sat/Sun.** FCFS opens immediately after each Sun waiver run, until each player's NFL kickoff.

### Late September 2026 → Pre-season MYM Deadline
- **2026-09-24 (Thu Night Football kickoff):** **UPS preseason MYM deadline.** Standardized to **kickoff of Thursday Night Football game** for consistency with extension deadline.

### Early October 2026 → Pre-season Extension Deadline
- **2026-10-07 (Wed) → updating to Thu Night Football kickoff** for consistency with MYM. Effective deadline: **kickoff of Week 5 Thursday Night game** (~Thu 2026-10-08).
- **End of October:** **First earning checkpoint** (25% of current-year salary earned). **Open: Keith wants to consider per-game prorated earning instead of calendar checkpoints — needs league review.**

### November 2026 → Trade Deadline
- **2026-11-26 (Thu, Thanksgiving, Week 12 kickoff):** **UPS trade deadline.** No trades until next offseason after this kickoff.
- **End of November:** **Second earning checkpoint** (50% earned). (Per-game prorated proposal pending — see October note.)
- **Remaining league dues** ($100) due by trade deadline. Venmo to @Keith-Creelman → treasurer Josh Martel.

### December 2026 → Fantasy Playoffs
- **2026-12-17 (Thu, Week 15):** **UPS Playoffs Round 1 starts.** 3-week format.
- **2026-12-24 (Thu, Week 16):** Playoffs Round 2 / Toilet Bowl bracket continues.
- **2026-12-31 (Thu, Week 17):** **UPS bracket finals — championship name TBD (rename pending) + Hawktuah Bowl** (Toilet Bowl, named after viral girl + Hawks team perennial worst finisher).
- **End of December:** **Third earning checkpoint** (75% earned). (Per-game prorated proposal pending.)

### January 2027 → Off-season Begins
- Cycle repeats. 100% earning hits at March 2027 roll-forward.

---

## B. Recurring In-Season Cadences

| Cadence | Event |
|---|---|
| **Thu / Fri / Sat / Sun 9 AM ET** | Blind Bid Waiver runs |
| **Immediately after each waiver run** | FCFS Free Agency opens (until each player's NFL kickoff) |
| **Daily during auction** | 2 nominations per owner per 24-hour window |

> **OPEN — waiver lock ambiguity (Keith 2026-04-28):** the precise rules on when a dropped player becomes available depend on drop timing relative to a waiver run.
>
> **Scenario A:** Player dropped at 9 AM Thursday DURING the waiver run.
> **Scenario B:** Player dropped at 10 PM Thursday (standalone drop after waiver run).
>
> These are treated differently by MFL, and confusion is widespread. **Action item:** research MFL's exact lock-duration behavior for both scenarios and document the rules + any edge cases that could cause issues.

---

## C. Calendar-Driven Cap Penalty Timing

The `(TCV × 75%) − Earned` cap penalty formula applies to the cap of one specific season, determined by WHEN the cut happens. There are 3 timing buckets:

| Cut Window | Hits Which Season's Cap |
|---|---|
| **Bucket 1:** After fantasy-season end (post-Dec/Jan) → through Roster Lock Date (Wed before FA Auction) | **Upcoming season** (the season starting that fall) |
| **Bucket 2:** FA Auction start → end of fantasy season | **Following season** (the one AFTER the active season) |
| **Bucket 3:** Same as Bucket 1, post-roll-forward | **Current/upcoming season** (the one starting that fall) |

**Worked examples:**
- Cut Player A (TCV $90K, $30K Y1 already 100% earned at March rollover) on **Mar 15, 2026** → penalty $37.5K hits **2026 cap** (bucket 1).
- Cut Player B mid-October 2026 → penalty hits **2027 cap** (bucket 2 — the auction-start trigger has already happened in late July 2026).
- Cut Player C on Jan 5, 2027 (post-Week 17, before March 2027 rollover) → penalty hits **2027 cap** (bucket 1/3 — the season starting that fall).

**The rule of thumb:** during the offseason between roll-forward and the next FA Auction, penalties hit the upcoming season. From auction start through season end, penalties roll into the next year.

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

1. **2026 ERA window + FA Auction start/close exact dates** — historical ranges documented above; live 2026 dates need MFL `TYPE=calendar&L=74598` confirmation OR addition to `event_window_matrix.csv` with audit trail.
2. **2025 ERA post-draft anomaly** — auction_date for 2025 ERA picks is 2025-05-26/27 (after rookie draft May 25). Either ERA was held post-draft in 2025 or the date represents something else. Worth confirming.
3. **MFL waiver lock duration** — exact hours from drop → waiver clear (verify in MFL settings).
4. **Earning checkpoints (25%/50%/75%)** — confirm convention is calendar month-end vs NFL week boundary.
5. **Roster Lock Date future** — Keith may eliminate this; consolidate into auction-start auto-unlock.

---

## END Section 3 (LOCKED v8)

---

# Section 4 — League History (Scoring & Roster Eras + Rule Change Timeline)

The 2026 bid sheet must understand that historical contract values, scoring data, and auction prices come from **different rule eras**. This section gives the year-by-year change log so models can correctly weight or filter prior data.

> Full year-by-year details with source citations are in [memory: `league_history_chronicle.md`](../../.claude/projects/-Users-keithcreelman-Code-upsmflproduction/memory/league_history_chronicle.md). Section 4 is the bid-sheet-relevant subset.

## A. Major eras at a glance (corrected v13)

Eras are NOT mutually exclusive — Superflex and TE Premium are concurrent (both ongoing in 2026).

| Era | Years | Status | Defining characteristic |
|---|---|---|---|
| **Pre-history** | 2010 | Closed | One-year **FA Auction only** (no rookie draft, no dynasty cap). Contracts maintained on Forumotion. **EXCLUDE from dynasty-comparable historical data.** |
| **Founding dynasty** | 2011 | Closed | First year of the current dynasty cap format. **Treat 2011 as Y1 for historical comparisons.** |
| **IDP / classic format** | 2011–2021 | Closed | Standard QB/RB/WR/TE flex with full IDP support. QB starter limit = 1. No SF, no TE Premium. |
| **Superflex era** | 2022–**ongoing** | Active | QB starter limit 1 → 1-2. All skill flex maxes +1. **3-starting-QB cap** (rule eased in 2025 — see below). QB market reprices upward. |
| **TE Premium era** | 2025–**ongoing** | Active | TE-only `CC=*1.5` (1.5 PPR for TE only). **Concurrent with Superflex era.** Voted year before (2024) per Keith — verify. |

> **Data lineage emphasis (Keith v13):** every stat/scoring change must be documented in enough detail to **convert old data to the modern era.** When this section says "scoring changed," the bid sheet needs to know the EXACT old → new formula to normalize historical points. Cross-reference rulebook archive + `metadata_rawrules` + Forumotion for primary sources.

## B. Rule changes by year (bid-sheet relevant)

> Each entry should record OLD value → NEW value with enough precision to normalize historical data. Where I have the old value, it's in this doc. Where I don't, **❓DETAIL NEEDED** flags it as a follow-up item for the chronicle work.

### 2010
- **FA Auction only — NO rookie draft.** Contracts maintained on Forumotion. Format was one-and-done by design.
- Auction values from 2010 are **NOT comparable** to modern dynasty data. Exclude entirely.

### 2011 — Founding dynasty Year 1
- **Also FA Auction only — NO rookie draft yet.** The ONLY difference from 2010: in 2011 the league knew the format was permanent (dynasty), so contracts persisted forward into 2012. In 2010 the format was acknowledged as one-and-done.
- **Starting lineup: 1 RB mandatory** (per rulebook archive — 1QB / **1RB** / 2WR / 1TE / 2Flex / DL / LB / DB / 3 DefFlex / K / P). The 1-RB minimum stayed in effect through ~2014 (see 2015 below).
- IDP added: split out DT/DE/LB/CB/S, added PN; RB=1-3, TE=1-3, WR=2-4 (these are starter MAXIMUMS, not minimums).

### 2012 — First rookie draft + Year-1 to Year-2 cleanup
- **First rookie draft** (rookie draft format introduced this year — dynasty cap needed it once contracts started persisting).
- **4-owner dispersal draft.** Original results in Forumotion (not yet ingested into repo). Capture for franchise-history work.
- **MAJOR punter scoring overhaul** (after Y1). Punters were scoring obscenely high in 2011 — scoring revamped to bring them in line. ❓DETAIL NEEDED: original formula → new formula. In Forumotion.
- Big-game bonus added (any-position pts at 45+/50+/60+).
- Tackles + KY (kickoff return yards) + PNY (punt yards) scoring overhaul. ❓DETAIL NEEDED: exact old → new values.
- **Taxi squad introduced at size 5** (Keith recalls 5 or 6; memory says 5). Verify in Forumotion.

### 2013
- Rookie contracts: 2 years → **3 years** (by league vote).
- **Trade votes removed.** Commissioner-led trade processing replaced league veto poll. 5 collusion votes still trigger a veto poll.
- Contract dynamics for the bid sheet: extension + restructure data from Forumotion is the primary source for understanding how contracts behaved pre-2018.

### 2014
- **Forum vote 2014-02-11 reaffirmed: 6 three-year contracts max per roster** (excluding rookie 3-yr deals). **STILL ACTIVE in 2026** (per Keith v12). ❓Verify if there was a 1-year wait period before implementation.
- Forum vote 2014-02-11 (7-5): Restructure-only-with-extension rule (later overturned — same year as in-season restructure ban; see below).
- Taxi: max 9 with contract-year tiers.

### 2015
- **RB starter MIN went from 1 → 2** (the change Keith pointed to — was a 2014 forum proposal effective 2015 per `services/rulebook/sources/rules/settings_changes.md`). Lineup became 1QB / **2RB** / 2WR / 1TE / 2Flex / etc.
- RB starter MAX bumped from 1-3 → 2-4 (per memory `scoring_history_eras.md`).

### 2016
- FG scoring overhaul: tier-based → per-yard (`FG=*.1`). ❓DETAIL NEEDED: original tiered formula values.

### RB PPR evolution (years TBD, multiple changes)
- Original: 1.0 PPR (catch counts as 1 point)
- Then changed to 0.75 (3/4 PPR)
- Then changed to 0.80 (current 4/5 PPR)
- ❓DETAIL NEEDED: years for each transition. Find in Forumotion or scoring_history_eras.md cross-reference.

### First Downs evolution (Keith v13)
- Initially: receiving FDs only (0.2)
- Then: rushing FDs added (0.2)
- Then: ALL 1st downs (incl. QBs)
- ❓DETAIL NEEDED: year breaks for each step. Memory has 2021 as initial; subsequent expansions need dates.

### 2018 — major roster expansion
- Active roster: 26 → **30** (auction max 31 → 35).
- Taxi: 9 → **10** (min 1 IDP).
- IDP starters: 5 → **7**.
- Total starters: 15 → **17**.
- DB split: CB/S separated from LB; PD/PI bumped to *1.5/4.

### 2018 or 2019 (verify in Forumotion)
- **In-season restructure BANNED.** Same vote also overturned the 2014 "restructure-only-with-extension" rule. Restructures are now offseason-only and standalone-allowed.

### 2020
- Yardage notation: `.1/1` → `*.1` (cosmetic — same scoring, different MFL notation).
- COVID-IR rule added (later removed in 2022).

### 2021
- First downs added — receiving FD = 0.2 (initial vote).
- Rushing first downs added (0.2) as follow-up vote 2021-07-04 (Josh Martel raised oversight).
- **Waiver runs day swap (2021-08-17, 9-0 vote): Wed/Thu/Sat/Sun → Thu/Fri/Sat/Sun.** Full schedule replacement, not just "Wed→Fri." Affects historical waiver-pickup date alignment.
- **SF lead-up year had real cap math:** non-expiring rookie QBs got the new (10/20) extension cost **immediately in 2021**; expiring rookie QBs got the old (6/12) cost. (Was a tied 5-13 vote broken by commissioner.)

### 2022 — Superflex transition (CONCURRENT with rest of league rules going forward)
- **★ QB starter cap 1 → 1-2 (Superflex era begins, ONGOING).** All skill (RB/WR/TE) max +1.
- One-time **QB Keeper Selection event**: owners declared which QBs to keep; non-keepers dropped penalty-free. 2021 2nd-QB rookies (Mond/Mills/Fields/Lawrence) auto-eligible to be kept.
- **3-starting-QB cap** codified with FantasyPros depth-chart enforcement (later eased — see 2025).
- **League dues $125 → $200** (10-2 vote, 2022-02-20).
- **Payout overhaul** (2022-08-12): Champion $600→$900, 2nd $290→$450, 3rd $100→$150, Division winners $25→$50, Weekly HS $20→$30, new Toilet Bowl payouts.
- COVID-IR/Taxi rule removed (2022-08-12).
- **Trade window opened immediately after season end** (used to lock until March rollover).
- Tag Auction + ERA switched to FA-Auction-style proxy bid with 3-day window (2022-05-03). ❓Need: what was format BEFORE this change? When did ERA itself start? Are tag results captured anywhere?

### 2025 — TE Premium + cleanup year (CONCURRENT with SF)
- **★ TE Premium: `CC=*1.5` for TE only** (1.5 PPR, TE only). Voted year before (2024) per Keith.
- **ST TD range tweaks** were a **league-wide uniformity** change (NOT TE-Premium specific) — all positions normalized for consistency. ❓DETAIL NEEDED: old ranges → new ranges.
- **MYM cap raised 3 → 4.**
- **ERA opening bid: $1K floor** (was prior-yr-salary + $1K).
- **1st-Round Rookie Option** introduced (4th option year, salary = original Y3 + $5K; first exercise window 2027 for the 2025 R1 class). Voted 2024, implemented 2025.
- **Round 6 PK/PN eligibility REVERSED** — back to strict IDP-only. **History (Keith v13):** Round 6 was ALWAYS IDP-intent from inception. One year an owner selected a PK or PN in Round 6. The league voted ON DRAFT NIGHT that it was OK they were included (no explicit rule against). PK/PN remained informally allowed in subsequent years until 2025, when the rule was tightened back to strict IDP-only. ❓Year of the draft-night vote — review auction data for first PK/PN selection in Round 6.
- **3-starting-QB cap eased**: rule changed in 2025 to **3 starters at start of season; mid-season changes don't matter.** Was getting too challenging to enforce mid-season depth-chart changes.
- **Bench-player tiebreaker removed.** New rule: tie = tie in regular season; in playoffs the higher seed advances (manual adjustment by commissioner, rare).

### 2026 — Active changes
- **Division realignment year** (next: 2029, 2032). Realignment uses prior 3-year all-play records to slot teams into divisions.
- **TE Premium year 2** (concurrent with SF). Year-2 TE pricing: open question — see Section C below.

## C. Implications for the 2026 bid sheet (corrected v13)

1. **Filter or weight historical auction data by era:**
   - **2010:** exclude (different format — FA Auction only)
   - **2011–2021:** pre-SF, pre-TE-Premium baseline
   - **2022–2024:** SF-only era (QB inflation, no TE premium)
   - **2025:** SF + TE Premium year 1 (concurrent eras)
   - **2026:** SF + TE Premium year 2 (concurrent eras)

2. **Don't conflate 2022 SF with TE Premium.** Some models (`build_auction_value_model_v2.py`) lump them as one era — that's wrong. They're 3 years apart. **`build_auction_value_model_v2.py` should be SUNSETTED** — Keith doesn't want multiple sources of truth floating around. We need a way to deprecate stale models cleanly.

3. ~~**2026 TE pricing should be ABOVE 2025 TE pricing** (year-2 market correction)~~ — **REMOVED v13.** Keith disagrees; not a correct assumption.

4. ~~**Owner-strategy signal: 2026 is a realignment year.**~~ — **REMOVED v13.** Keith says: realignment matters but FA market talent is low, so realignment doesn't drive significant auction shifts. Don't bake this into pricing models.

5. **Round 6 is strict IDP-only in 2026** (PK/PN reversed in 2025). Don't include kickers/punters in 6th-round bid models. **Also exclude PK/PN from 6th-round STARTERS BASELINES** (the historical baseline used to estimate Round 6 production must filter PK/PN out for 2026 going forward).

6. **Historical contract data pre-2018 has different roster math** (26 active vs 30, 15 starters vs 17, taxi 9 vs 10, etc.) — normalize before comparing.

7. **Data lineage for stat normalization:** every scoring change in Section 4.B that has a ❓DETAIL NEEDED flag must be filled in before we can confidently convert pre-change auction prices to current-era equivalents. Forumotion + scoring archive xlsx files are the primary sources. This is a prerequisite for any cross-era model.

## D. Source-data conflicts to resolve

- **`services/rulebook/sources/rules/settings_changes.md` says "rookie contract length removed pre-2025."** **THIS NEVER HAPPENED** (Keith confirmed 2026-04-28). Rookie contracts have been 3 years consistently since 2013. settings_changes.md is wrong on this point.
- **`settings_changes.md` says "rounds 3+ rookie salaries not in current rulebook."** They ARE in 2024.2 §4.5 (R3-5 = $2K, R6 = $1K). settings_changes.md is outdated.
- **2024 rulebook v1 (8/4) had wrong lineup spec** — only v2 (8/31) is correct. Don't trust v1 archive.

## E. STILL-OPEN for Section 4

Detail needed (Forumotion verification + scoring archive xlsx):
1. **Year 1 (2011) starting lineup details** — confirm 1 RB mandatory, find duration before 2-RB started.
2. **Punter scoring overhaul (post-Y1)** — original formula → new formula.
3. **2012 dispersal draft results** — capture from Forumotion.
4. **2012 taxi size at inception** — confirm 5 (or 6).
5. **2012 tackles + KY + PNY scoring overhaul** — exact old → new values.
6. **2016 FG scoring (tier-based → per-yard)** — original tier values.
7. **RB PPR transitions** — exact years for 1.0 → 0.75 → 0.80.
8. **First Downs expansion** — exact years for receiving → +rushing → all 1st D (incl QBs).
9. **In-season restructure ban year** (2018 or 2019).
10. **"Restructure-only-with-extension" overturn year** (same as #9).
11. **2014 6×3-yr cap** — was there a 1-year wait period before implementation?
12. **6th-round PK/PN draft-night vote year** — review auction data for first PK/PN selection in Round 6.
13. **Bench-player tiebreaker removal year** (pre-2025).
14. **2025 ST TD range tweaks** — old ranges → new ranges.
15. **Tag Auction + ERA pre-2022 format** — what was it before the proxy-bid switch on 2022-05-03?
16. **Original ERA start year** — when did the Expired Rookie Auction format itself start?
17. **TE Premium vote year** — Keith says agreed-upon year before; confirm if 2024 vote.

Source notes:
- **Pre-2021 slack data unavailable** — slack export labeled "May 2016 - Sep 2022" actually only contains messages from May 2021 onward.
- **Forumotion** (https://upsdynastycap.forumotion.com/forum) is the primary source for 2011-2020 era detail. Forum posts were clean; group texts (pre-Slack) were noise. From 2021 forward, Slack + Discord.

## F. Slack history note (Keith v13)

- **Slack era began ~2021.** Before Slack, the league used **group texts** (which is why Keith eventually moved to Slack — texts were unmanageable).
- Forum (Forumotion) was the original communication channel; Slack supplanted it ~2021; Discord supplanted Slack later.
- Implication for data-lineage: Forum posts are the cleanest historical source. Slack covers ~2021-2022 with high fidelity. Discord covers 2022-present.

---

## END Section 4 (LOCKED v13)

---

# Section 6 — Cap Mechanics

The bid sheet's math depends on getting cap mechanics right. This section enumerates: (A) hard cap rules + when each applies; (B) earning curve; (C) cut-penalty formula by contract type with worked examples; (D) cap adjustment subtypes; (E) cap movement in trades; (F) available-cap calculation per franchise; (G) cross-section invariants recap; (H) open items.

> **Section 4 (Scoring Eras) and Section 5 (Franchise History) are deferred** — they don't block the bid sheet. Section 4 content is mostly already in `scoring_history_eras.md` memory; Section 5 skeleton is in `league_history_timeline.md`.

---

## A. Cap floor + ceiling rules

### A1. Cap ceiling = $300,000

- **Hard ceiling** of $300K total committed salary.
- **Applies: FA Auction start → end of fantasy season ONLY.** (Corrected v10 per Keith.)
- **DOES NOT apply during the offseason** — both the offseason BEFORE FA Auction and the offseason AFTER fantasy season ends. Cap turns OFF at season end and stays off until next FA Auction. Trades after the fantasy season can be over cap — that's fine.
- **Tagged salaries count** as active roster salary against the ceiling. Tagged players ARE on the active roster — no separate accounting.
- **Taxi salaries do NOT count** — taxi is off-cap entirely.
- **IR cap relief reduces the count** — 50% of IR'd player's salary refunds against the ceiling.

### A2. Cap floor = $260,000

- **Soft floor.** Must be hit at SOME timestamp during the FA Auction window (touch-and-go counts) **OR** by the September contract deadline.
- Failing both = out of compliance → cap penalty.
- **Touch-and-go example (corrected v10):** team hits $270K mid-auction, then a $40K player goes IR. **IR refund = 50% × $40K = $20K**, so committed salary drops to **$250K** (still < $260K, but the team had touched $260K earlier so they're compliant for floor purposes).
- **Front-loading contracts OR restructuring** is the explicit tool to satisfy the floor when an owner is light on commitments.

### A3. Future direction (parked — Open Items A1.4 + A2.4)
Whether to keep, eliminate, or reform the auction roster lock + cap floor mechanic — Keith is reviewing.

---

## B. Earning curve — CANONICAL (Keith confirmed 2026-04-28)

### B1. The rule

A contract's salary "earns" by **calendar-month bucket**. Earning ticks UP at the start of each month (10/1, 11/1, 12/1) and concludes at season end. Once season ends, 100% is earned (no need to wait for March roll-forward — and offseason cuts aren't allowed anyway, so the distinction is academic).

| Cut Date Range | % earned |
|---|---|
| FA Auction start through 9/30 | **0%** |
| 10/1 – 10/31 (any day in October) | **25%** |
| 11/1 – 11/30 (any day in November) | **50%** |
| 12/1 – season end | **75%** |
| After season end | **100%** |

**Key clarification:** "all of October = 25%" — the moment 10/1 hits, you're in the 25% bucket for the entire month. Same for Nov (50%) and Dec (75%). The earning ticks UP at the START of each month, not the end.

### B2. ⚠️ Code bug (file follow-up)

The reporting code in `build_contract_history_snapshots.py` uses milestones `[Sep 30, Oct 31, Nov 30, season_end]` — which gives 25% earning at Sep 30 (too generous for preseason cuts). **The canonical rule above (B1) supersedes the code.** A code-fix follow-up is in Open Items (memory + Open Items A2).

The fix needed: change milestones from `[Sep 30, Oct 31, Nov 30, season_end]` to `[Oct 1, Nov 1, Dec 1, season_end]` (or equivalent: trigger at start of month, not end of prior month).

### B3. Future direction — per-game prorated earning (Open A1.1)

Keith wants the league to consider switching from calendar-month buckets to a **per-game prorated** earning model — also for FA pickups. Would more accurately represent the truth than arbitrary calendar dates. Pending league review.

---

## C. Cut/Drop Penalty — by contract type

### C1. Canonical formula

```
Penalty = (TCV × 0.75) − Salary Earned
```

Applied to the cap of the season determined by cut-timing buckets (see Section 3.C).

**Two key rules for evaluating this formula (Keith confirmed v11):**

1. **TCV is fixed at the time of contract creation OR extension and does NOT change over the contract's life.**
   - Front-loaded $40/$30/$20 contract → TCV = $90K, stays $90K throughout.
   - 1-yr $25K contract extended (Ext1, +$10K) → AAV $35K for ext year → **TCV = $25K + $35K = $60K, stays $60K** through the rest of the contract's life. Does NOT reset to $35K after rollover.

2. **"Salary Earned" is based on THE YEAR'S actual salary (not AAV).** Apply the earning curve % to the year's actual dollar amount:
   - Front-loaded $40K Y1 cut Oct 15 → 25% × **$40K** = $10K earned (NOT 25% × $30K AAV).
   - Same contract Y2 = $30K, cut Oct 15 of Y2 → 25% × $30K = $7.5K earned.
   - Earned accrues across years: prior years that played out fully count at 100% of THAT year's actual salary.

### C2. Special-case overrides (NO penalty regardless of formula)

| Case | Penalty |
|---|---|
| 1-yr Veteran/WW under $5K original | $0 (0% guarantee) |
| Taxi player never promoted | $0 |
| Tag cut BEFORE FA Auction starts | $0 (tag nullified) |
| Jail Bird (commissioner discretion) | $0 |
| Retired player | $0 (cap relief — may trigger Calvin Johnson Rule comp) |
| Off-season suspension opt-out | $0 (contract pause; salary $0 that year) |
| New owner, 1 cap-free cut within onboarding window | $0 |

### C3. WW $5K+ in-season special case

WW pickups with salary > $4K dropped during the season → **35% × salary** penalty (NOT the standard 75% formula).

Rationale: WW pickups have a different guarantee structure (65% earned vs 75% standard). Penalty applies only if drop happens DURING the season; post-season WW drops show $0 because contract reaches full earned at season end.

| In-season WW cut | Penalty |
|---|---|
| WW $5K, mid-season | 35% × $5K = $1.75K |
| WW $25K, mid-season | 35% × $25K = $8.75K |
| WW $50K, mid-season | 35% × $50K = $17.5K |
| WW any $, post-season (before next rollover) | $0 (counted as full year) |

### C4. Worked examples — standard contracts

**C4.1: 3-year Veteran flat $30K (TCV $90K), cut March (offseason, Y1 already 100% earned)**
- Earned through prior March rollover: $30K (Y1 fully sunk)
- Penalty = (75% × $90K) − $30K = $67.5K − $30K = **$37.5K**
- Hits **current season cap** (bucket 1 — offseason before FA Auction).

**C4.2: Same 3-yr $30K, cut Oct 15 (Y1 in-season)** — recomputed v10
- Earned through Oct 15: 25% × $30K = **$7.5K** (in 10/1–10/31 bucket)
- Penalty = (75% × $90K) − $7.5K = $67.5K − $7.5K = **$60K**
- Hits **following season cap** (bucket 2 — between FA Auction start and season end).

**C4.3: 3-year Front-Loaded ($40K Y1 / $30K Y2 / $20K Y3, TCV $90K), cut March of Y2 (offseason, Y1 sunk)** — LOCKED v11
- TCV = $90K (fixed at contract creation; doesn't change).
- Earned through Y1 (played out fully) = **actual Y1 salary = $40K** (NOT AAV $30K — earned tracks the year's actual amount per Keith).
- Penalty = (75% × $90K) − $40K = $67.5K − $40K = **$27.5K**
- Hits **current season cap**.

**C4.4: 1-yr Veteran $20K, cut December 5 (Week 14)** — recomputed v10
- Earned through Dec 5: 75% × $20K = **$15K** (in 12/1–season-end bucket)
- Penalty = (75% × $20K) − $15K = $15K − $15K = **$0**
- This is the case where 75% guarantee equals what's already been paid — no further charge.

**C4.5: 1.01 Rookie ($15K flat × 3yr = $45K TCV), cut October Y2 (Y1 sunk, mid-Y2)** — recomputed v10
- Earned: $15K (Y1 sunk) + 25% × $15K (Y2 in Oct bucket) = $15K + $3.75K = **$18.75K**
- Penalty = (75% × $45K) − $18.75K = $33.75K − $18.75K = **$15K**
- Hits **following season cap**.

**C4.6: 1-yr contract $25K extended Ext1 (+$10K → ext year AAV $35K). At time of extension: TCV = $25K + $35K = $60K. Cut March of extension year (offseason, original Y1 sunk).** — LOCKED v11
- TCV = $60K (fixed at extension submission; does NOT reset after rollover — Keith confirmed).
- Earned through original Y1 (played out fully) = **$25K** (actual Y1 salary).
- Earned through extension year (March = before any earning milestone) = **$0**.
- Total earned = $25K.
- Penalty = (75% × $60K) − $25K = $45K − $25K = **$20K**
- Hits **current season cap**.

**C4.7: WW $25K pickup picked up Oct 5, dropped Nov 5 (in-season WW special case)**
- Penalty = 35% × $25K = **$8.75K** (WW $5K+ rule applies regardless of timing within season)
- Hits **following season cap**.

**C4.8: WW $4K pickup Oct 5, dropped Nov 5 (under $5K threshold)**
- Penalty = **$0** (1-yr Veteran/WW under $5K cap-free)

**C4.9: Tagged player ($30K tag), cut May before FA Auction starts**
- Penalty = **$0** (tag-cut-pre-auction special case — tag nullified)
- **NOTE:** the team that cut the tagged player CAN bid on / nominate them in the FA Auction (tagged-player exception to cut-then-rebid prohibition).

**C4.10: Tagged player ($30K tag), cut October 15 in-season** — recomputed v10 (no week numbers; calendar month controls)
- Earned through Oct 15: 25% × $30K = $7.5K (10/1–10/31 bucket)
- Penalty = (75% × $30K) − $7.5K = $22.5K − $7.5K = **$15K**
- Hits **following season cap**.
- (Keith correction: don't reference "Week 8" — calendar month is what matters, not NFL week. A Week 8 in early Nov would yield a different penalty than Week 8 in late Oct.)

### C5. Worked examples — cap-free categories

| Scenario | Penalty | Why |
|---|---|---|
| Taxi rookie (R3+, never promoted) cut anytime | $0 | Taxi never-promoted = 0% guarantee |
| Promoted taxi rookie cut Week 6 | Standard formula | Once promoted, normal rules apply |
| Aaron Hernandez-style (jailed) | $0 | Commissioner discretion (Jail Bird Rule) |
| Player retires Week 8 | $0 | Cap-free + may trigger Calvin Johnson Rule comp |
| Off-season season-long suspension owner opt-out | $0 (salary $0 that year) | Contract pause; original salary resumes after suspension |
| New owner first cut (within onboarding window) | $0 | New-owner relief |

---

## D. Cap adjustment subtypes

The umbrella term is **cap adjustment** for things that move the cap. "Cap penalty" is one specific subtype.

> **Naming note (Keith v10):** "this was cap penalties" — the OG term was "cap penalties." The umbrella name "cap adjustment" is the more precise modern term, but historical references use "cap penalty" for what's now formalized as a subtype.

| Subtype | Sign | Source / Trigger |
|---|---|---|
| Drop penalty | − | Cut event (formula in C1) |
| Trade salary cash | ± | Trade event (paired adjustment — see E1) |
| IR cap relief | + | Player on IR (50% of salary refunded for duration on IR) |
| Manual commissioner adjustment | ± | One-off corrections |
| ❓ Late dues fine | − | $3K per week late — **flagged for review** (Keith v10): may be real-dollar fine, not cap impact |
| ❓ Missed nomination fine | − | Auction nomination missed (escalates from $3K) — **flagged for review** same as above |

> **Removed in v10:** Logo change fee — that was real dollars (and now $0 since AI). Not a cap adjustment.

All adjustments stored in MFL via `salary_adjustments` (commissioner import `TYPE=salaryAdj`) or auto-derived from transactions.

---

## E. Cap movement in trades

### E1. Cap money rule (corrected v10)
- **Each side's cap-money contribution is independently capped at 50% of THE SALARY OF THEIR OWN TRADED-AWAY PLAYER** (i.e., sender's outgoing player).
- **NOT pooled.** Owner A's max cash sent is based on Owner A's traded-away player. Owner B's max is based on Owner B's traded-away player.
- **Multi-player trade:** max cap-money sent = 50% of the SUM of all traded-away player salaries (Keith v10 confirmed).
- Cannot send only money — must include at least one non-salary asset (player or pick).
- Recorded as paired `salary_adjustment` rows: NEGATIVE for the team shedding cap, POSITIVE for the team acquiring cap.

### E2. Player contract transfer
- Contract goes with the player as-is. No re-negotiation at trade time.
- Acquiring team owns all future cap implications (year-by-year salaries, TCV, guarantee).

### E3. In-season trade-and-extend
- If the traded player is in their final year, the acquiring team gets **4 weeks from acquisition** to extend.
- **Pre-trade extension (wired in trade war room module):** in some cases, teams CAN ask for a pre-trade extension — IF the team currently holding the player has the eligibility. This is "the trading-away team's last action for that player" before sending. Example: Owner A's player is extension-eligible by Owner A. Owner A applies the extension as part of the trade negotiation, then trades the now-extended player to Owner B. Owner B inherits the extended contract.
- **Tagged players: cannot be extended after trade** (tag rule supersedes).

### E4. Worked example — trade with cap money (corrected v10)
- Owner A trades **Player X ($10K salary, 1 yr left)** + 2026 3rd-round pick to Owner B for **Player Y ($8K salary, 1 yr left)** + cap money.
- **Max cap money each side could send:**
  - Owner A could send up to 50% × $10K = **$5K** (based on Player X)
  - Owner B could send up to 50% × $8K = **$4K** (based on Player Y)
- So Owner B can send Owner A AT MOST **$4K** in cap money — NOT $5K.
- Final trade: Player X + 2026 3rd → Player Y + $4K cap money.
- Owner A: receives $4K cap relief (positive `salary_adjustment`). Acquires Player Y at $8K.
- Owner B: sends $4K cap money (negative `salary_adjustment`). Acquires Player X at $10K.
- Asset requirement satisfied (both sides send player + Owner A sends pick).

---

## F. Available-cap formula per franchise

For the bid sheet's expected-bid math, each franchise's available cap at a moment in time:

```
available_cap_remaining = $300,000
                        − sum(active_roster_salaries)        # tagged players included; taxi excluded
                        + sum(IR_refunds_50%)
                        + sum(positive_cap_adjustments_owed) # trade cap acquired, IR refunds
                        − sum(outstanding_cap_charges)       # drop penalties, traded-away cap
```

> **Tagged salaries are part of `active_roster_salaries`** — tagged players ARE active roster, no separate accounting needed (Keith v10 simplification).

Then for the FA Auction:
```
max_bid_remaining = available_cap_remaining
                  − ($1K × roster_slots_needed_to_reach_minimum_27)
```

**Caveat for offseason pre-FA-Auction:** the $300K ceiling does NOT apply — owners can be over $300K committed. Their `available_cap` can be NEGATIVE (representing how much they need to cut/restructure to get under by FA Auction start).

### F1. Worked example — single-position need
- Owner has 26 active players, $230K committed, $0 outstanding adjustments.
- Owner needs **1 more player to reach 27-min** (any position).
- `available_cap_remaining = $300K − $230K = $70K`
- `max_bid_remaining = $70K − ($1K × 1) = $69K`
- Owner can bid up to $69K on a single player while reserving $1K for the 27th-roster-spot minimum.

### F2. Worked example — multi-position need (Keith v10)
- Owner has 26 active players, but they only have 1 RB and the league requires they end the auction with enough RBs to fill 2 RB + 2 Flex starting slots → say minimum 3 RBs.
- They have a $50K cap-floor concern: they need 2 more RBs + 1 more flex-eligible player, so 3 more roster spots not just 1.
- `available_cap = $300K − $230K = $70K`
- `max_bid = $70K − ($1K × 3) = $67K` (reserve $3K for the other 2 mandatory pickups)
- Even though they only NEED 1 player to reach 27, they should reserve cash for the positional needs they still have to fill.
- **Practical bid sheet rule:** compute `roster_slots_needed = max(27 − active_count, sum(min_positional_gaps))` to avoid overbidding.

**For the bid sheet:** compute `available_cap` as of "auction start" — i.e., snapshot the rosters + commitments AT that moment, then run the auction simulation.

---

## G. Cross-section validation (recap from Section 2.G)

The 15 invariants in Section 2.G all apply to cap math. Bid sheet must enforce them:

- $300K ceiling (post-auction)
- $260K floor (touch-and-go during auction OR by Sept deadline)
- **5** loaded contracts max
- 6 3-year contracts max (excluding rookie 3-yr)
- 4 MYM/season
- 3 restructures/season
- 2 tags/team/year (1 offense + 1 def-ST)
- Tag eligibility constraints
- Round 6 picks not tradeable
- Comp picks additive sequential (1.13/1.14/1.15… or 3.13/3.14/3.15…)
- MYM 14-day clock doesn't reset on trade
- Once promoted from taxi, never re-eligible
- One active contract per player

---

## H. STILL-OPEN ITEMS for Section 6

1. **Per-game prorated earning** — league discussion (Open A1.1).
2. **Late dues fines + missed-nomination fines** — Keith flagged for review. May be real-dollar (cash) penalties, not cap adjustments. Confirm before bid sheet uses them as cap inputs.
3. **Auction Roster Lock future direction** (Open A1.4) — also: a 2-day-before-auction "cutdown day" is being added for testing purposes per Keith v10. Reconcile with the current 3-day-prior roster lock rule.

✅ **Resolved in v11 (closed):**
- C4.3 (front-loaded penalty math) — confirmed $27.5K. Earned tracks actual Y1 salary ($40K), not AAV.
- C4.6 (post-rollover extension penalty) — confirmed $20K. TCV stays at $60K post-extension; does NOT reset to ext-year salary.
- "Earned per year salary" rule formalized in C1.
- "TCV fixed at extension/creation time" rule formalized in C1.

✅ **Resolved in v10 (still closed):**
- Earning curve canonical = Keith's spec (10/1, 11/1, 12/1, season end). Code has a bug (file follow-up).
- Multi-player trade cap money = 50% of sum.
- 50% rule is per-traded-away-player (not pooled).

---

## END Section 6 (**LOCKED v11**)

---

# Section 8 — Contract Activity & Player Lineage Tracking (placeholder, added v13)

> Keith v13 (L1167): "let's use this as a means to start our tracking of contract activity. This can be section 8...not critical but I want it. Has to do with confirming the player's life cycle. We should be able to reconcile the data and supporting documentation. Forum was clean. Ever since it's not — you'll need to work through that. We'll start from beginning and work forward rather than backwards. I do believe there's a player lineage file(s) in repo already started — we should start there."

## A. Goal

Reconcile every player's contract lifecycle event-by-event — from initial acquisition to current state — against the supporting documentation (Forumotion posts, Slack messages, Discord threads, MFL transactions, contract-history snapshots). The end product is a per-player audit trail with provenance for every contract decision.

## B. Approach (per Keith)

- **Start from the beginning (2011) and work forward** — NOT backwards.
- Anchor on the existing player-lineage files in the repo (Keith mentions "I do believe there's a player lineage file(s) in repo already started").
- Forum era (2011 → ~2020): clean, well-organized data.
- Post-forum (2021+): scattered across Slack/Discord/MFL — needs work.
- Goal: every contract event has a documented source.

## C. Inputs to inventory

1. **Existing player-lineage files in repo** — locate and assess current state.
2. **Forumotion posts** (https://upsdynastycap.forumotion.com/forum) — Contract Central / Tag Central / Expired Rookies threads.
3. **Slack channels** (May 2021 - Sep 2022) — `4a-contract-central-station/`, `2a-league-transactions/`, `3a-expired-rookies/`, etc.
4. **Discord** — 2022-present league discussions.
5. **MFL `transactions` data** — already in `mfl_database.db`.
6. **`contract_history_*.csv` reports** — existing repo artifact.

## D. Open scope

- **Section 8 is NOT critical for the 2026 bid sheet** — the bid sheet uses Sections 1-6 as authoritative spec.
- This work is for ongoing data quality + future bot use.
- Defer detailed scoping until Sections 1-7 are locked + bid sheet is shipped.

---

## END Section 8 (placeholder, v13)

---

# Appendix — Open Items Master List

Consolidated parking lot for things flagged across Sections 1–3 + Section 6 that need follow-up. Three categories:

## A1. League discussion needed (bring to all owners)

1. **Earning checkpoints — switch to per-game prorated?** Currently calendar Oct/Nov/Dec end. Keith wants league to consider a prorated-per-game model (also for FA pickups) — more accurate representation.
2. **Tag tier formula math** — current tiers (avg top-N AAVs) are working but Keith wants a more dynamic / mathematically grounded calculation. Open for proposals.
3. **"UPS Championship" rename** — current name sounds weak. Need a better non-cheesy name. Toilet Bowl = Hawktuah Bowl already locked; Championship side rename pending.
4. **Auction Roster Lock Date future direction** — eliminate the 3-day-prior lock? Auto-unlock at auction start via MFL API? Or keep as-is? Keith says "verify + validate, not worth fixing right now" but it's worth a league-wide chat.

## A2. Keith decisions / Discord verification

5. **Suspension opt-out rule current state** — verify in Discord whether the OG "owner declares before contract deadline" rule still applies, or whether it was simplified to "drop player to suspended status, see 50% discount automatically." Possibly extend to "drop to taxi" since that auto-removes salary.
6. **Pre-2025 in-season restructure ban** — verify exact year via forum/Discord (Keith said "before 2025 — verify").
7. **MFL waiver lock duration + lock semantics** — research MFL behavior precisely. Specifically: 9 AM Thu drop during waiver run vs 10 PM Thu standalone drop have different lock durations. Document the rule + edge cases.
8. **Cut-then-rebid prohibition future** — Keith wants to consider eliminating; auto-unlock at auction start would handle the underlying compile-cut-list need.
9. **Comprehensive UPS site / homepage review** (Keith L3, L20) — go through every home-page message + every doc + every script to identify possible issues / inconsistencies. Schedule a dedicated session.
10. **Jail Bird Rule** — vague by design (commissioner discretion). Aaron Hernandez canonical case; "released by NFL" alone is not sufficient. No formal definition needed but flag at decision time.
11. **⚠️ Earning curve discrepancy (Section 6.B.3)** — rulebook says 0% / Oct / Nov / Dec / March (start at Oct 31); code says 0% / Sep30 / Oct / Nov / SeasonEnd (start at Sep 30). **CRITICAL — affects every cap penalty calc.** Decide which is canonical so bid sheet matches. Code is more lenient by 25%.
12. **Trade cap-money cap when multi-player trade** — is the 50% rule per traded-away player or 50% of total traded-away salary?
13. **Cut-then-rebid pre-auction reset window** — exact window length (3 days? 7 days? Roster Lock + after?) not pinned down.

## A3. Data-layer / automation work

11. **Backfill historical UPS event dates with verification flags** — sources scattered across forum (cleanest, oldest) → Google Forms → Slack → Discord → governed CSVs. Need a dedicated session to parse, cross-reference player lineage, identify anomalies, dedupe. Will be MESSY for transition years. Older forum data is relatively clean.
12. **Contract deadline historical drift** — currently Sunday before Week 1; used to be NFL Cut Date + extra day (~Wed before Week 1). Moved to Sunday in last ~5 years. Cleanup needed alongside #11.
13. **2026 actual ERA + FA Auction dates** — confirm via MFL `TYPE=calendar&L=74598` API call. Lock specific Saturday start date for FA Auction once announced.
14. **Pull MFL TYPE=calendar live** to verify 2026 specifics not yet in `event_window_matrix.csv`.

## A4. Future automation / bot integration ideas

15. **Daily NFL retirement search** — auto-flag players retiring (Schefter, Rapoport, credible source) → trigger Tier-1 / Calvin Johnson Rule check.
16. **Automated dues posting** to Josh Martel (treasurer) via Venmo. Allow owners to submit "I'll have it by X" responses. Reduce nag overhead.
17. **Per-game prorated earning calculator** (depends on A1 #1 league decision).
18. **Auction-time auto-unlock** via MFL API (depends on A2 #4 decision).
19. **Trade module enforcement** — once promoted from taxi, no re-demotion (currently MFL would auto-promote on trade; UPS workaround was manual re-demote, deprecated). Trade module should enforce.
20. **Auction nomination tracking + alerts** — daily notifications about who's nominated, who's behind, who's compliant.
21. **Logo AI generator** — already in use (replaces $15 logo fee). Codify in tooling.

---

## Appendix B — Resolved in v8 (no longer open)

For audit trail. These were open in earlier versions and are now closed:

- ✅ Loaded cap = 5 (NOT 3 — that was restructure limit). Resolved Sec 1+2 v4, fixed leftover line 137 in v8.
- ✅ Restructure limit = 3 (separate from loaded cap). Resolved v4.
- ✅ Extension types `Ext1` / `Ext2`. Resolved v4.
- ✅ WW pickup → 4-week window (days 1-14 MYM, 15-28 extension). Resolved v4.
- ✅ MYM 14-day clock does NOT reset on trade. Resolved v4.
- ✅ Tag eligibility = 0 yrs remaining post-rollover (from prior season ending roster). Resolved v4, wording clarified v8.
- ✅ Tagged players: NO extensions, NO MYM — must go to next FA Auction. Strict rule confirmed v8.
- ✅ WW-Rookie sub-type → not a separate type; Keith manually converts WW → Rookie at year-end for ERA path. Clarified v8.
- ✅ New owner onboarding: cap-penalty wipe + 1 cap-free cut. Resolved v4.
- ✅ Cap "penalties" → "cap adjustments" (subtypes including traded salary, drop penalty, late dues). Resolved v4.
- ✅ $300K ceiling does NOT apply offseason pre-FA-Auction. Resolved v4.
- ✅ $260K floor: by FA Auction completion OR contract deadline. Resolved v4.
- ✅ Survivor Pool / NFL Pool removed from catalog (UPS doesn't run them). Resolved v4.
- ✅ $15 logo fee retired (AI now). Resolved v4.
- ✅ Once promoted from taxi, NEVER re-eligible for taxi. Resolved v4.
- ✅ Pick provenance: track TRUE pick owner, not clicker (Bortles example). Resolved v4.
- ✅ Trade cap money = `salary_adjustment` row (positive/negative pair). Resolved v4.
- ✅ Tag fallback formula clarified. Resolved v4.
- ✅ Drop penalty timing 3 buckets — clarified with worked examples in v8.
- ✅ ERA conducted alongside Tag period (overlapping with Rookie Draft from 2025+). Resolved v6, propagated to Sec 1 in v8.
- ✅ Suspension opt-out flagged for Discord verification. (Open Item #5.)
- ✅ Restructure window: offseason until contract deadline. Resolved v4.
- ✅ Restructure eligibility: 2+ years remaining. Resolved v4.
- ✅ Calvin Johnson Rule fully documented + Tier 1 = Tag tier definitions. Resolved v8.
- ✅ Comp pick 1.13 / 3.13 — sequential slots if multiple retirees same side (1.13, 1.14, 1.15...). Resolved v8.
- ✅ FA Auction 2026 format: Saturday start, 12-day window. LOCKED v8.
- ✅ TNF kickoff = first Thursday game on the slate (start of TNF). Confirmed v8.
- ✅ Hawktuah Bowl naming (Toilet) confirmed; UPS Championship rename remains open (#3).
- ✅ Treasurer = Josh Martel. Resolved v7.

---

## END APPENDIX
