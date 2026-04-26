# UPS Salary Cap Dynasty — League Context (v1, working draft)

**Purpose:** This is Claude's working understanding of how the UPS league operates, written so Keith can correct it before we use it as the foundation for the 2026 auction bid sheet. Each section is delivered iteratively. **Anywhere I'm uncertain I've flagged with ❓Q — please answer or correct.**

**Section status:**
- [x] Section 1 — Player Lifecycle (this draft)
- [ ] Section 2 — Transaction Catalog
- [ ] Section 3 — Annual Calendar
- [ ] Section 4 — Scoring & Roster Eras (timeline)
- [ ] Section 5 — Franchise History (joins, rebrands, dispersals)
- [ ] Section 6 — Cap mechanics (penalties, guarantees, floor/ceiling)

> **Source material I've read so far:**
> - `services/rulebook/data/rules.json` (rule version 2026.5, last_updated 2026-02-14)
> - `services/rulebook/sources/rules/settings_changes.md` (consolidated change history)
> - Memory: `scoring_history_eras.md` (auth'd timeline of scoring changes)
> - Memory: `data_quality_findings_20260425.md`, `direct_to_d1_etl_plan.md` (data infra context)
> - `docs/MFL_API.md`, `docs/MFL_IMPORT_EXPORT_DETAILED.md` (MFL endpoints)
>
> **Source material I have NOT yet read:**
> - The raw `.docx` rulebooks under `services/rulebook/sources/rules/` (Master Rulebook HTML was the consolidated input — going to spot-check the raw docs as Keith pushes back)
> - Live MFL API for current rosters/salaries/league settings
> - `services/rulebook/sources/rules/mfl_message_boards/` (forum precedent)

---

# Section 1 — Player Lifecycle

A UPS player passes through some combination of: **(A) Entry → (B) Roster state → (C) Contract events → (D) Exit**. The path determines what kind of contract the player is on, what loading is permitted, what extension schedule applies, and how (and how expensively) they can be cut.

---

## A. ENTRY PATHS — how a player ends up on a UPS roster

There are **7 distinct entry paths** in the current rulebook. Each one creates a different default contract and constrains future contract events.

### A1. Rookie Draft (Memorial Day Sunday, 6 rounds, 12 picks)

- **Eligibility:** any player MFL classifies as an NFL rookie that year.
- **Round 1** — must stay on **active roster**. NOT taxi-eligible. **3-year contract**.
  - **1st-Round Rookie Option** (effective 2025 draft+): a 4th "option year" attached. Must be exercised before the **contract deadline date of the player's final original rookie season** (so for a 2025 1st-rounder, that's late-season 2027 — the original 3-year deal covers 2025/2026/2027).
  - ❓**Q1.** What's the option-year salary? The rulebook says "full details in Contract Transactions section" but I don't see the formula in the rules I've read. Is it AAV + a fixed escalator (like the extension schedule)? A multiplier on Year 3 salary? A new-flat-amount? Something else?
  - ❓**Q2.** What happens if the option is *not* exercised — does the player become an Expired Rookie next May like a non-1st-rounder, or is there a different mechanism?
- **Rounds 2–5** — 3-year contract, **taxi-squad eligible for first 3 NFL years**, can stay on active roster instead.
- **Round 6** — Must be used to select **IDP, Kicker, or Punter**. **Cannot be traded.** 3-year contract. Draft order is **random** for round 6 (not based on prior playoff finish like Rounds 1–5). Taxi-eligible.
- **Salaries:** Rookie salaries are fixed by round. The current rulebook references a salary table I haven't fully transcribed.
  - ❓**Q3.** Confirm 2026 rookie salary scale by round (1.01–1.12, 2.01–2.12, etc.). The settings-history doc says: *"Current rulebook does not specify rookie salaries for rounds 3+; confirm whether legacy $2K/$1K rules still apply."* So my best guess is Rounds 1–2 have explicit per-pick salaries and Rounds 3–6 default to $2K or $1K. **Please give me the actual number per pick.**
- **Draft order (Rounds 1–5):** determined by **prior season's playoff results** — higher playoff finishers pick later, lower finishers pick earlier.
- **Roster impact:** A drafted rookie counts toward roster max once placed on active. Taxi-demoted rookies do **not** count against the active roster. Demotion deadline = contract deadline date (last Sunday before NFL Week 1). For mid-season trade-acquired rookies: demote prior to that player's NFL kickoff that week (with leniency on day-of-kickoff trades — moves to following week).
- **Contract length removed pre-2025?** The settings-history file says: *"Rookie contract length was 2 years in 2012, moved to 3 years starting 2013 by league vote, then **removed prior to the 2025 season by commissioner ruling for ease of management**."* That contradicts the current rulebook which still says rookies are 3-year contracts. ❓**Q4.** Is the 3-year rookie contract still the default, or was it actually relaxed? If relaxed, what's the new rule (variable length? owner choice?)?

### A2. Free Agent Auction (last weekend of July, ~1 week duration)

- **Format:** "eBay proxy style" — bid must remain highest for **24 hours** to win the player. ❓**Q5.** Earlier in the rulebook it says 36 hours for FA Auction lock; later it says 24 hours and Expired Rookie Auction is 36 hours. Which is correct for the **regular FA Auction**? My best read: FA Auction = 24hr, Expired Rookie Auction = 36hr.
- **Nominations:** Owners must nominate within 24 hours. Missing a nomination = escalating fines (start $3K, increases each offense). Mandatory league event.
- **Roster window during auction:**
  - Max roster: **35** (during auction)
  - Min roster: **27** (must hit by completion of auction)
  - Must be able to submit a valid starting lineup by completion
  - Cap floor: **$260K** committed by auction completion or contract deadline
  - Cap ceiling: **$300K** (system-enforced; system does NOT enforce minimum-roster-flexibility — owner's responsibility)
- **Auction Roster Lock Date:** 3 days before auction start. Last chance to cut before auction; rosters are then locked until auction completes.
- **Default contract:** **1 year** if no Multi-Year Auction Contract is submitted. Multi-Year option = 2 or 3 years, Veteran (even split) or Loaded (front/back). Submission deadline = contract deadline date.
- **Salary:** Whatever the winning bid is (in $1K increments — ❓**Q6** confirm $1K is still the bid increment? legacy says $1K min/$1K increments; not explicit in current rulebook).

### A3. Expired Rookie Auction (first week of May)

- **Eligibility:** any player whose **rookie contract expired** and was **NOT extended** by April 30 deadline.
- **Format:**
  - 2–3 day nomination window
  - Starting bid = prior year's salary + $1K
  - **36-hour** lock (vs. 24hr in regular FA Auction — see Q5). Timer resets on new high bid.
- **Contract on win:** 1 to 3 years (same options as regular FA Auction). Multi-year deals must be submitted by September contract deadline.
- **Cut restriction:** players won in this auction **cannot be cut by any team prior to the next FA Auction** (forced retention through the season).
- ❓**Q7.** Does a player won in Expired Rookie Auction get loaded contracts? Same rules as FA Auction (front-load OR back-load, capped at 5 loaded contracts on roster)?
- ❓**Q8.** If a 1st-rounder's option year is NOT exercised, do they hit Expired Rookie Auction the May after their final original-contract year? Or some other path?

### A4. Blind Bid Waivers (in-season, Thu/Fri/Sat/Sun 9 AM)

- **Mechanism:** Conditional blind bidding. Bid amount **becomes the player's salary for the current season**.
- **Default contract:** 1 year (Veteran-style if pre-contract-deadline; **WW (Waiver Wire)** type if post-contract-deadline).
- **Tiebreakers** (when two teams bid identical amount on same player):
  1. All-Play record
  2. Overall record
  3. Total points
  4. Head-to-Head record
  - **Pre-season + Week 1:** custom order based on **prior season's final draft slot finish** (i.e., reverse of draft order — bad teams get priority).
- **Bid Processing:** Top-down within each group; first valid bid accepted, rest in that group ignored. Groups processed without priority over each other.
- ❓**Q9.** "Conditional blind bidding" — confirm format: e.g., a chain like *(want player A for $5, dropping B; if not, want player C for $3 dropping D)*. MFL supports this via `blindBidWaiverRequest` import. Yes?

### A5. First-Come, First-Serve (FCFS) Free Agency (Sunday after waiver run → kickoff)

- **Trigger:** After the Sunday morning waiver run completes, free agency opens FCFS until each player's NFL kickoff.
- **Salary:** **$1K** flat for current season.
- **Contract:** 1-year default. WW-type if post-contract-deadline.
- **Purpose stated:** ensures teams can always field a starting lineup.

### A6. Trade Acquisition

- **Trade window:** offseason through **NFL Thanksgiving week kickoff** (the trade deadline). After deadline → no trades until next offseason.
- **Eligibility:**
  - Players with **1+ years remaining** on contract.
  - **Expired rookies** can be traded up to the extension deadline (April 30); other expired contracts cannot be traded.
  - **Round 6 picks: NOT tradeable.**
  - Future draft picks: current year + 1 year out only.
  - Salary can be traded as part of deal (with rules — see Cap Adjustments / Section 6).
- **Asset requirement:** every trade must include at least one **non-salary asset** (no pure salary dumps).
- **Inheritance:** the contract transfers as-is. Acquiring team owns the cap consequences from that point forward.
- **Special rules:**
  - **Trade-and-extend:** if traded player is in final year, acquiring team can pre-agree to apply an extension as part of the trade (must be in trade comments OR proof of discussion).
  - **In-season trade for player in final year:** acquiring team has **4 weeks from acquisition** to extend.
  - **Roster compliance:** if a trade puts either team out of compliance (roster size, contract limits), they have **24 hours** to fix.
- **Review:** Trades process **immediately** but are subject to commissioner review (and reversal if egregious). Currently no veto poll mechanism.
- ❓**Q10.** Can salary AND a draft pick BOTH be sent (i.e., team A sends $5K + 2026 3rd to team B for player X)? I assume yes, but want to confirm the asset-requirement is satisfied as long as ONE non-salary asset is in the package.

### A7. Dispersal Draft (when a new owner joins)

- **Trigger:** new owner replaces an outgoing one (or there's no outgoing owner — TBD).
- **Mechanism:** Existing teams may **opt in** by throwing their roster + future-eligible picks (excluding 6th rounders) into a pool with the new owner's assets. Random snake draft order is generated. Draft conducted in Discord.
- **Once a team commits, they cannot withdraw.**
- ❓**Q11.** Has the dispersal draft actually been used? When? With what frequency? (This goes more in Section 5: Franchise History, but it's relevant to entry paths.)
- ❓**Q12.** What happens to a player whose existing team didn't opt-in but who was on the **outgoing** owner's roster? Does the new owner inherit them straight up, or does that roster go into the pool by default?

---

## B. ROSTER STATES — where the player can sit on a UPS roster

A rostered player is always in exactly one of three states.

### B1. Active Roster
- **Size:** 27 (min) – 30 (max) **after the contract deadline date**.
- **Auction window:** 27 (min) – 35 (max).
- Player counts against active roster size, contributes salary fully toward cap, can start.

### B2. Taxi Squad
- **Size:** **Max 10 players, min 1 IDP.**
- **Eligibility:** Players selected in the **Rookie Draft, Round 2 or later**, for **first 3 NFL years only**. (1st-rounders cannot be on taxi.)
- **Salary on taxi:** ❓**Q13.** Does taxi squad get any cap relief? Settings-history mentions legacy "no cap charge if cut while on taxi (never promoted)" but doesn't say their salary is reduced while ON taxi. I think the answer is "full salary still counts" — but want to confirm.
- **Cut economics:** Taxi-squad players who have **never been promoted** can be cut **cap-free**. Once promoted to active, normal cut penalties apply going forward.
- **Demotion deadline:** Contract deadline date (last Sunday before Week 1). For mid-season trade-acquired rookies, demote before next NFL kickoff for that player.
- ❓**Q14.** Does a player auto-graduate off taxi after 3 NFL years, or does their eligibility expire and they have to be promoted (or cut)? What if they were drafted as a rookie but are 3 years into the league with no NFL games played — does the clock run on NFL years or league years?

### B3. Injured Reserve (IR)
- **Eligibility:**
  - NFL Injured Reserve (or any IR designation MFL recognizes)
  - COVID-19 IR (legacy, may not be relevant 2026)
  - **Holdouts** — i.e., players holding out from their NFL team
  - **Suspended players** — special treatment (see below)
- **Cap relief:** **50%** of salary refunded while on IR.
- **Roster impact:** IR players do NOT count against active roster max.
- **Suspended player special handling:**
  - **Off-season suspension** (season-long or rest-of-season): owner's choice — contract can be set NOT to roll forward (salary = $0 that year, original salary resumes after suspension ends). Decision must be made before contract deadline.
  - **In-season suspension:** contract rolls forward normally.
- ❓**Q15.** Does a player on IR still earn guarantee credit (i.e., do the Oct/Nov/Dec 25%-each-month earning checkpoints accrue while on IR)? My read: yes, because the contract is still active. But want to confirm.
- ❓**Q16.** Are there limits on how many players can be on IR simultaneously? Legacy 2014 says "no limit"; current rulebook doesn't say.

---

## C. CONTRACT EVENTS — what happens to a player's contract while rostered

These are the **transactions you can do TO** a player who's already on your roster. Each one is a defined `contract_type` in the data model: **Auction, Extension, MYM, Restructure** (per `R-D-1` data standard).

### C1. Initial contract assignment (varies by entry path)

Per Section A above:
- Rookie Draft → 3-year rookie deal (Round 1: +Option Year)
- FA Auction → 1, 2, or 3-year Veteran or Loaded
- Expired Rookie Auction → 1, 2, or 3-year (same as FA Auction)
- Blind Bid → 1-year (Veteran or WW based on timing)
- FCFS → 1-year, $1K (Veteran or WW based on timing)
- Trade → inherit existing contract
- Dispersal → ❓**Q17.** Does a dispersal-acquired player keep their old contract, or does the new owner get a fresh deal? Probably old contract carries — confirm.

### C2. Multi-Year Auction Contract (MYAC) submission
- **Window:** From acquisition (FA Auction or pre-deadline waivers) through the **September contract deadline date** (last Sunday before NFL Week 1).
- **Result:** Converts a 1-year default into 2-year or 3-year, Veteran or Loaded.
- **Loaded rules:**
  - **Front-loaded:** Year 1 salary > AAV. Allowed only on FA-acquired or Expired Rookie Auction or offseason restructures. Total split must equal TCV.
  - **Back-loaded:** Year 1 salary < AAV. Min 20% of TCV in Year 1.
  - Roster cap: **5 Loaded contracts max** (front + back combined).
  - Total 3-year contracts: **6 max** (excludes rookie 3-year deals).

### C3. Mid-Year Multi (MYM)
- **What it is:** Convert an existing 1-year contract into a multi-year deal at the SAME salary (no raise). Cannot be loaded.
- **Limit:** **Max 3 MYMs per season per team.**
- **Eligibility:**
  - Player acquired via FA Auction or pre-season waivers, NOT given a multi-year contract by Sept deadline → MYM available **through end of NFL Week 2**.
  - Player acquired via in-season waivers (own pickup or post-trade for them) → MYM available **within 2 weeks of acquisition**.
- **Type rule:** WW contracts MYM'd → become Veteran contracts.
- ❓**Q18.** Is the MYM converted contract a 2-year or 3-year deal (or owner's choice)? I'd assume owner's choice between 2 and 3 just like MYAC, but want to confirm.

### C4. Extension
- **Eligibility:** Player in **final year** of contract.
- **Length:** 1 or 2 years.
- **AAV escalator** (the new contract's AAV is computed from the OLD AAV plus a position-based bump):
  - **Schedule 1 (QB / RB / WR / TE):** +$10K (1yr) / +$20K (2yr)
  - **Schedule 2 (DL / LB / DB / K / P):** +$3K (1yr) / +$5K (2yr)
- **Effect:** Resets TCV and guarantees from scratch.
- **Mechanics example (Schedule 1):** 1-yr left, $17K AAV → extend 1yr → new AAV = $27K → new TCV = $27K × 2 = $54K? Wait, the rulebook example says new AAV = $27K → TCV = **$44K**. That's $17K (current year) + $27K (extended year) — i.e., the **current year stays at original salary** and only the new extension years get the bumped AAV. Let me re-read… Yes, that matches. So extension is a *forward-looking* AAV change, not a retroactive one.
- ❓**Q19.** Does the bumped AAV apply only to the extension years, or does it apply to ALL remaining years (including the current final year)? My read of the example: only extension years. Confirm.
- **Deadlines (multiple flavors):**
  - **Standard:** by contract deadline date.
  - **Rookie / preseason waiver pickups w/ no contract by Sept and no MYM by Week 2:** extend by **end of Week 4**.
  - **In-season trade-acquired in final year:** extend within **4 weeks of acquisition**.
  - **Expired rookies (no extension by April 30):** lose extension right → Expired Rookie Auction.

### C5. Restructure
- **Purpose:** Adjust salary distribution across remaining contract years (front-load or back-load) without extending.
- **Window:** Offseason only. Specifically called out as a way to meet the $260K cap floor.
- **Loading rules:** same as MYAC loading — front-load or back-load, with TCV preserved.
- **Counts toward 5-loaded-contracts cap.**
- **Legacy 2014 rule (settings_changes.md):** Restructures historically only allowed *with* an extension. ❓**Q20.** Is restructure now a STANDALONE transaction (without extension required), or still must accompany an extension? The current rulebook lists restructure independently in cap-floor context, suggesting standalone — but I want to confirm.
- ❓**Q21.** Per-team annual restructure limit? Legacy was 2/season; current rulebook doesn't say.

### C6. 1st-Round Rookie Option (Effective 2025+)
- Already covered in A1. Reproducing here as a contract event:
  - Applies to 2025 1st-round picks onward.
  - Must be exercised before contract deadline of the player's **final original-contract season**.
  - Adds 1 option year onto the 3-year rookie deal.
  - ❓**Q1 again** — what's the salary mechanic?

### C7. Annual Roll-Forward (March 1–15)
- **What:** All contracts decrement by 1 year remaining; salaries advance to next-year value.
- **Timing:** Goal March 1, can extend to March 15.
- **Effect on guarantees:** prior-year salary becomes 100% earned at rollover.

### C8. Tag (Franchise / Transition) — LEGACY ❓**Q22**
- Settings-history doc says: *"Legacy docs include franchise/transition tag systems with compensation rules; current rulebook does not mention tags."*
- BUT the codebase has `build_tag_tracking.py`, `build_tag_submissions_json.py`, and Discord-style tag references. ❓**Q22.** Is the tag system still active? If yes, what are the current mechanics (window, salary effect, compensation rules)? If no, when was it removed?

---

## D. EXIT PATHS — how a player leaves a UPS roster

### D1. Cut / Release (cap penalty applies)
- **Cap penalty formula:** `(TCV × 75%) − Salary Earned`
- **Earning schedule (the "75% guarantee earning curve"):**
  - 25% earned at end of October
  - 25% more earned at end of November
  - 25% more earned at end of December
  - **100% earned once the season completes and the new season has rolled forward** (i.e., after March 1–15 rollover, the prior-year salary is fully sunk and no longer subject to penalty)
- **Penalty timing:**
  - Penalty incurred **before Roster Lock Date (3 days before auction)** → applies to **current season** cap.
  - Penalty incurred **from auction start onward** → applies to **following season** cap.
- ❓**Q23.** Walk me through a worked example: player on a 3-year, $30K/yr Veteran contract (TCV $90K), entering Year 2 in March. If cut in March of Year 2, what's the cap hit and to which season? My math: Year 1 was fully earned (no penalty from Year 1). Year 2+3 remaining = $60K. Guarantee = $90K × 75% = $67.5K. Earned = $30K (Year 1 was fully earned by rollover). Penalty = $67.5K − $30K = $37.5K. But this happened in offseason before Roster Lock so it hits THIS season's cap. Right?

### D2. Cap-free cut categories (no penalty)
- **Veteran/WW 1-year contracts under $5K:** 0% guarantee. Cut anytime, no penalty.
- **Taxi Squad (never promoted):** 0% guarantee while on taxi. Cut cap-free.
- **WW $5K+ specifically:** 65% earned (35% penalty if dropped before season rollover).
- **Jail Bird Rule:** Player whose career is derailed by legal issue → released by NFL team → cap-free cut for UPS owner.
- **Retired Players Rule:** Retired = cap-free cut. (Optional — can keep on roster but contract stays as-is, no cap relief.)
- **Tier-1 Retired (Calvin Johnson Rule):** ❓**Q24.** What's the actual compensation structure here? Rulebook says "specific compensation rules apply" but doesn't enumerate.
- **Off-season suspension opt-out:** salary = $0 that year, no penalty (already covered in B3).

### D3. Trade-away
- Contract transfers to acquiring team (covered in A6).
- No cap consequence to the trading-away team beyond losing the asset.

### D4. Expired Contract → free agent OR Expired Rookie Auction
- **Rookie contract expired AND not extended by April 30** → goes to **Expired Rookie Auction** (first week of May).
- **Veteran contract expired AND not extended** → ❓**Q25.** Where does this player go? My assumption: full free agent, available in FA Auction in late July (since they're no longer rookie-eligible). Confirm.

### D5. Retired
- Already covered in D2. Cap-free cut available.

### D6. Suspended (offseason, contract paused)
- Already covered in B3.

---

## E. END-TO-END LIFECYCLE EXAMPLES

To stress-test my understanding, here are 3 hypothetical players. **Tell me which steps I have wrong.**

### Example 1: 1st-round rookie WR, drafted 2025
- May 2025: Drafted 1.05. 3-year contract at the rookie 1.05 salary (❓whatever that is).
- Stays on active roster (Round 1 — taxi-ineligible).
- 2025/2026/2027: plays out original contract. Original AAV = rookie 1.05 salary.
- Pre–Sept 2027 contract deadline: owner exercises **1st-Round Rookie Option** (a 4th year).
- 2028: plays year 4 at the option year salary (❓formula).
- Assuming no extension: contract expires after 2028 → enters Expired Rookie Auction May 2029. ❓**Q26.** Or does the option year change this — does an exercised option count as "extended" so they bypass Expired Rookie Auction?

### Example 2: 4th-round rookie RB, drafted 2026
- May 2026: Drafted 4.07. 3-year contract at rookie 4.07 salary (❓).
- Demoted to taxi squad before Sept 2026 contract deadline. Doesn't count toward active roster.
- 2026/2027: stays on taxi. Cap-free cut available at any time.
- 2028: promoted to active roster mid-season (taxi clock about to run out — 3 NFL years).
- Pre-Sept 2028 contract deadline: extension window opens. Owner extends 2 years → +$10K/yr AAV for 2 years (Schedule 1 RB).
- 2029/2030: plays extension years.

### Example 3: $25K UDFA WR, picked up Week 5 via blind bid 2026
- Bid $25K, won. Salary = $25K for 2026. WW 1-year contract.
- Within 2 weeks of acquisition (Week 7 cutoff): owner does MYM, converts to 2-year Veteran contract at $25K/yr.
- Plays out 2026 + 2027.
- Pre-Sept 2027 contract deadline: extension eligible (final year of 2-yr deal). Extends 1 year → AAV $35K (Schedule 1 WR, +$10K). New TCV: $25K (current year remains?) + $35K (extended year) = $60K.
- ❓**Q27.** Or does the AAV reset apply across BOTH years? Can't tell from the example in the rulebook.

---

## F. THINGS I'M MOST UNCERTAIN ABOUT

Top 5 things to confirm before we use this for the bid sheet:

1. **Q3** — Rookie salaries by pick (need explicit table).
2. **Q4** — Is the 3-year rookie default still in force, or was it relaxed for 2025+?
3. **Q5** — FA Auction lock window: 24hr or 36hr?
4. **Q19** — Extension AAV: does the bump apply to extension years only, or all remaining years?
5. **Q22** — Are franchise/transition tags still in the rulebook?

These all materially affect cap math for the bid sheet.

---

## END Section 1

Reply with corrections inline (PR comments) or in a Discord/chat reply that references Q-numbers. Once Section 1 is solid, I'll start Section 2 (Transaction Catalog — every MFL transaction TYPE, who can initiate, eligibility, downstream cap effect).
