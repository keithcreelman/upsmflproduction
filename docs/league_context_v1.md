# UPS Salary Cap Dynasty — League Context (v16, RB PPR 2010 = 1.0 confirmed; settings-vs-intent caveat)

**Purpose:** Claude's working understanding of how the UPS league operates, written so Keith can correct it before we use it as the foundation for the 2026 auction bid sheet. Sections delivered iteratively.

---

## 🔖 Document Status & Versioning

This document is the **canonical source of truth** for UPS league rules. The Hall bot grounds every answer here. Other rule documents in the repo (HTML rulebook, JSON rulebook, canonical_rules.md) are **legacy artifacts** being migrated into this file — see the **League Rules Migration** appendix at the bottom.

**Section status legend:**
- ✅ **LOCKED** — signed off by Keith, no open questions.
- 🟡 **PROVISIONAL** — drafted, awaiting Keith review or pending one or two open clarifications.
- 🆕 **NEW (pending review)** — added recently, has not yet been signed off — bot may cite but should flag uncertainty if asked.
- 🟠 **AMBIGUOUS** — known open question logged in the ambiguity register; bot answers with "Open question:" prefix.

**How to interpret a section without an explicit tag:** treat as ✅ LOCKED if it appears in Sections 1–6 (those were rolled up through v15 review). The two appendices ("Bot Grounding Clarifications", "Divisional Co-tenancy History") were added 2026-05-04/05 and are 🆕 NEW (pending review).

**Version log highlights** (full list in §E STILL-OPEN and Appendix B):
- v1–v8 (2026-04-21 → 2026-04-27): Sections 1–3 + initial scoring eras
- v9–v12 (2026-04-28): Section 1+2 corrections (47-item review pass)
- v13–v16 (2026-04-30 → 2026-05-04): Section 4 League History + scoring eras through 2026
- 2026-05-04: 🆕 Divisional Co-tenancy History appendix (computed from MFL DB)
- 2026-05-05: 🆕 Bot Grounding Clarifications appendix (cap-free <$4K, multi-yr <$5K, rounding, taxi "active", NFL calendar reference, vote-change grace, pot-splitting)
- 2026-05-05: 🆕 League Rules Migration appendix (catalog of legacy docs + sunset plan)
- 2026-05-08: ✅ Three rules passed (May 2026 round, 7-0-0 each) and integrated:
  - **Taxi squad flexibility — temporary call-ups** (B2, T2.4, D2): owners can call up a taxi player for up to 3 weeks before the call-up becomes permanent
  - **Salary depreciation — true pro-rated** (D1, B section calendar checkpoints, Section 6 earning curve): per-week pro-rated earning replaces the calendar-month buckets and the 35% flat WW model
  - **Realignment — captain-based division draft** (Section 4 active changes, new Realignment section): top 4 by All-Play % become Division Captains and snake-draft the league into divisions every 3 years
  See `docs/league_context_changelog.md` for proposal text + vote tally + before/after snippets per rule.

**Provenance:** every line in this document should be traceable to either (a) Keith's verbatim instruction, (b) a Discord/Forumotion/MFL-API source citation, or (c) a marked computed-from-data fact (e.g. AP% leaders pulled from `mfl_database.db`). When the bot can't trace a fact, it must say so.

---

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
  - **Enforcement intent (Keith, 2026-05-16 review session):** the demote-to-taxi endpoint must **reject any R1 → taxi demotion request**. Tracker: see `AUDIT_FOLLOWUP_TRACKERS.md` (Q12 tracker).
  - **1st-Round Rookie Option** (effective 2025 draft+): a 4th option year tacked on.
    - **Option-year salary = original Year 3 salary + $5,000.** ($5K = half of the +$10K Schedule 1 extension cost.) Simple formula, not a multiplier.
    - **Decision deadline:** September contract deadline of the player's **final original-contract season** (same as a normal extension decision window). E.g., a 2025 1st-rounder's option must be decided by Sept 2027.
    - **If exercised:** player plays the option year. After the option year, owner can **extend again** (1 or 2 more years, normal AAV escalator off the option-year salary). Worked example from Keith: 1.01 at $15K → exercise option → year 4 = $20K → extend 2 more years → could become 15/15/15/20/40/40 across 6 years.
    - **If NOT exercised:** player is treated like any other expired rookie (extension deadline before the May Rookie Draft, otherwise → Expired Rookie Auction).
- **Rounds 2–5** — 3-year contract, **taxi-squad eligible for first 3 LEAGUE years** (NOT NFL service time — see B2). Can stay on active roster instead.
- **Round 6 (UPDATED 2025+)** — Must be used to select **IDP only**. **Kickers and Punters are NOT eligible** (the prior PK/PN expansion was reversed in 2025). Pick is **NOT tradeable** (forces every team to make at least one IDP selection per year). Player can be traded after the pick is made. 3-year contract. Random draft order.
  - **Historical precedent (Keith, 2026-05-16 review session):** a team **has previously violated this rule** by submitting a non-IDP R6 pick. The league response was: **commissioner reversed the pick AND the team lost the pick as a penalty** (no replacement selection awarded). Treat as binding precedent — owners are on notice.
  - **Enforcement intent:** worker-side hard block at `/api/pick` (or the equivalent rookie-draft submit endpoint) — reject any R6 submission whose `player.position` is in `{QB, RB, WR, TE, PK, PN}`. Tracker: see `AUDIT_FOLLOWUP_TRACKERS.md` (Q11 tracker).
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
- **Nominations:** **exactly 2 per window — a MINIMUM and a MAXIMUM** (Keith 2026-07-14). Mandatory league event.
  - **Window = an ET calendar day**, midnight → midnight `America/New_York`. **Anchored, not rolling**: every franchise resets at the same ET midnight, regardless of when it last nominated. (Code counted a rolling 24-hour window from "now" until 2026-07-14; that was never the rule.)
  - **Minimum — 2:** a franchise must nominate 2 per day until it can field a legal lineup. Missed nominations escalate fines — **§F RULE 2**, the schedule below. Once the roster requirement is met the floor is waived — continuing is optional. **A franchise sitting at 0/2 with a legal roster has done nothing wrong**; only `!roster_met && used < 2` is a miss.
  - **A day is judged only once it is CLOSED.** Compliance is an ET-calendar-day question, so "did they miss?" is unanswerable until midnight ET passes. The 9 AM ET report is the first moment the prior day's verdict is final; the 9 PM report can only WARN about the day in progress (Keith 2026-07-14).
  - **Maximum — 2:** a **3rd nomination in the same ET day is a rules violation** and is **blocked** by the app (`performAuctionAction` refuses it before submitting to MFL, counting live off MFL's `AUCTION_INIT` feed so nominations made natively on MFL count too). The ceiling is **unconditional** — it applies to every franchise every day, including one that has already met its roster requirement.
  - **Not blockable everywhere:** MFL has no nomination-limit setting, and our app is a proxy over MFL's own auction page (`O=43`), which owners can always reach directly. An over-cap nomination made there is **detected** (private commish alert from the 5-minute auction poll) but not prevented or reversed.
  - **Day 1 is clipped by the auction open**, and needs no special rule: anchoring on the ET calendar day handles it. When the auction goes live it opens **12 PM ET**, so Day 1 runs 12 PM → midnight — the quota is still 2, there is simply less of the day in which to spend it. (During pre-auction testing the open is 12 AM ET, so Day 1 is a full day.) The kickoff/Day-1 quota is **2**, same as any other window (Keith 2026-07-14).
  - **Contrast with ERA (§A3):** ERA is *at most* 1 per anchored 12-hour window and carries **no** mandatory-nomination obligation. FAA is the mandatory one. Do not apply one rule's cadence to the other.
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
  - **Machine-enforceable rule (Keith 2026-05-18):** block owner from nominating/bidding on player X when ALL of: `cut.season = current_season` AND `cut.prior_contract_years_remaining > 0` AND `cut.timestamp < FA_Auction_Cut_Deadline` AND `cut.prior_contract_type != 'Tag'`. Cuts after the Cut Deadline (pre-auction reset window) and Tag-contract cuts are exempt; cuts after auction close are moot (no live auction). Enforcement lives in `/api/auction/bid` and `/api/auction/nominate`.
- **Default contract:** **1 year** if no Multi-Year Auction Contract is submitted. Multi-Year option = 2-year or 3-year, Veteran or Loaded.
- **Bid increments:** **$1K** (always).
- **Naming note (decided 2026-04-27):** Keep "Veteran" contract type as-is. Rename idea parking-lotted.

### A3. Expired Rookie Auction (overlaps with Rookie Draft weekend)

- **Eligibility:** any player whose **rookie contract expired** and was **NOT extended** by the rookie extension deadline (Thu before Memorial Day weekend — see Section 3 for exact date). Operationally there are TWO MFL data shapes for an expired rookie:
  1. **Active roster, just rolled over:** `contractStatus='Rookie'` AND `contractYear=0` (cy=0 = expired, per MFL vocabulary).
  2. **Empty contract (Keith 2026-05-18):** `contractStatus=""` AND `contractYear=""` AND `salary=""`. MFL **wipes** the rookie contract fields on rollover from cy=1 → cy=0, so taxi rookies whose 3-league-year clock expired AND active-roster rookies promoted off taxi without an extension both surface with blank fields. The expiry signal in this case is the original draft year (from `TYPE=draftResults` join) being ≤ season-3. R1-option-declined and taxi-3-year-clock-expired players fall into this bucket by construction — no special-case logic.
- **Rookie salary on the auction bid sheet (Keith 2026-05-18):** Salary source depends on the origin of the rookie contract:
  - **Draft-slot rookies (UPS rookie draft):** When the contract expires (cy=1 → cy=0 rollover), MFL wipes the salary field. **Derive** salary from the §A1 schedule (Y1=Y2=Y3 flat): `1.01=$15K, 1.02=$14K, …, 1.10=$6K, 1.11+ and R2=$5K, R3-R5=$2K, R6=$1K`. The original slot is recoverable from `TYPE=draftResults` for the original draft year — even for trade-acquired players whose roster `drafted` field shows `Trade (YEAR)` instead of `R.PP (YEAR)`.
  - **MYM-Rookie (WW/FCFS rookie pickup later given MYM, per §C3):** Salary = the WW bid amount, NOT derivable from any draft slot (the player never went through the UPS rookie draft). MFL surfaces the salary on the rosters export directly — use it as-is.
  - **Dispersal-acquired rookies or other off-draft rookies** that never appear in `TYPE=draftResults`: fall back to MFL's live salary.
- **Timing (NEW PATTERN, 2025+):** ERA **starts on the Saturday before Memorial Day weekend** and runs **through the Rookie Draft on Memorial Day Sunday**. ERA and the Rookie Draft now overlap. Historical pattern (pre-2025) had ERA in early-to-mid May, separated from the draft.
- **Format:**
  - 2–3 day nomination window (overlapping with rookie draft active hours)
  - **Starting bid: $1K** (changed in 2025 — old "prior-year salary + $1K" rule is dead). Reason: under the old rule a $13K player needed a $14K opening nomination; nobody wanted that. $1K floor lets someone start the bidding.
  - **36-hour** lock window. Resets on new high bid.
- **Nomination cadence (Keith 2026-05-21):** each owner may submit **at most 1 new ERA nomination per 12-hour window**. Windows are **anchored to 6 AM ET and 6 PM ET** — not rolling from the franchise's last nomination. No concurrent-nomination cap — if other owners don't nominate, additional lots simply don't open. Intent: prevent any single owner from grabbing the opening bid on multiple headline players in the first hours of the auction.
- **Nomination window schedule (Keith 2026-05-27):** 6 discrete windows, opens **Memorial Day Monday 6 AM ET**, closes at the end of the **Wednesday 6 PM → Thursday 6 AM ET** window:

  | # | Window | Notes |
  |---|---|---|
  | 1 | Mon 6 AM → Mon 6 PM ET | Opening window (Memorial Day morning) |
  | 2 | Mon 6 PM → Tue 6 AM ET | |
  | 3 | Tue 6 AM → Tue 6 PM ET | |
  | 4 | Tue 6 PM → Wed 6 AM ET | |
  | 5 | Wed 6 AM → Wed 6 PM ET | |
  | 6 | Wed 6 PM → Thu 6 AM ET | **Final** nomination window |

  After Thursday 6 AM ET no new lots can be nominated. Existing lots continue bidding with their 36-hour lock windows until everything resolves. Enforcement: worker-side at `/api/auction/nomination-status` — an inline `eraWindow` computation in that route handler (there is no `getEraNominationWindowState()` function; the name appears in older notes but was never written) computes the current window from "now" and checks if each franchise has used it. It is ERA-specific: it steps by a fixed 12 hours from a fixed instant, which is only safe because ERA never crosses a DST boundary. **Do not reuse it for FAA** — §A2 windows are civil calendar days (23h/24h/25h long); that math lives in `worker/src/auction_windows.js`. UI surfaces "Nominate" CTAs only when `current_window` is open and `used_in_window === 0` for the viewing franchise.

  > **Prior rule (deprecated 2026-05-27):** opened Sat 6 PM ET / closed Tue 6 PM ET (6 windows shifted 60 hours earlier). Code + doc previously matched that; corrected upward after Keith confirmed the league actually started Memorial Day Monday 6 AM ET.
- **Missed-nomination policy:** **no fine for ERA.** Participation is optional — unlike FA Auction, ERA has no mandatory-nomination obligation. (Asymmetric on purpose: ERA pools are smaller and not every owner has a target.)
- **Contract on win:** 1, 2, or 3 years, same loading rules as FA Auction (front-load OR back-load, capped at **5 loaded contracts** on roster — see §C2 for enforcement timing). No "sign immediately" benefit — FA Auction submission deadline applies.
- **Default contract written at AUCTION_WON (Keith 2026-05-27):** the moment MFL ratifies the win, the worker (`finalizeEraContracts()` in `worker/src/index.js`, called from the 5-minute auction poll AND surfaceable via `POST /admin/auction/finalize-era-contracts`) writes a canonical 1-year contract back to MFL so Front Office and every downstream consumer reads the right state immediately:
  - `contractStatus = "Vet-ERA"` — distinct from `Veteran` / `Rookie` so the "1-year veteran under $5K → cap-free cut" path in Roster Workbench does NOT fire (would conflict with the forced-retention rule below).
  - `contractYear = 1` (years remaining; MYAC may extend to 2 or 3 by Sept contract deadline).
  - `salary = winning_bid` (already set by MFL; reinforced).
  - `contractInfo = "CL 1| TCV {bid}K| AAV {bid}K"`.
- **Pre-trade extension blocked during MYAC window (Keith 2026-05-27):** Vet-ERA winners are **not** eligible for the Trade War Room pre-trade extension flow (§E3) while their MYAC window is open (acquisition → Sept contract deadline). Reason: the MYAC mechanism is the canonical path for choosing 1/2/3-year length on a Vet-ERA contract; allowing a pre-trade extension during that same window would double-up the extension authority. After the Sept contract deadline closes, normal extension eligibility (1-year contract heading into a final year) applies. Trade War Room enforcement: gate on `contractStatus = "Vet-ERA" AND now < FA_Auction.contract_deadline` → no pre-trade extension.
- **AAV escalator basis (Keith 2026-05-18):** when an ERA winner converts to a multi-year contract, the AAV escalator is computed off the **winning bid**, not the prior Y3 rookie salary. (Necessary clarification after the 2025 switch to a flat $1K opening bid.)
- **MYAC window (note):** ERA wins occur in late May, so the MYAC submission window runs from acquisition → September contract deadline ≈ 4 months — longer than the ~2-month FA Auction MYAC window. Intentional; no change.
- **Forced retention:** players won in Expired Rookie Auction **cannot be cut until that summer's FA Auction CLOSES** (Keith 2026-05-18 — pinned to `FA_Auction.close_at` in the season calendar). Once auction closes, normal cut rules resume. Concept: no "get out of jail free" — you bid, you hold through auction.
- **ERA pool = the players cut at the deadline (Keith 2026-05-22).** When the midnight-ET tag/extension deadline passes, the worker (or commish via `/admin/auction/auto-drop-expired-rookies` if the cron times out) drops every rookie+cy=0 player AND every empty-contract player whose 3-year clock expired (per §B2). These dropped players are **snapshotted into `ups_era_pool`** (D1 table) and **become the canonical ERA pool**. The O=43 player picker should be filtered to ONLY this snapshot when ERA is active — owners should NOT be able to nominate non-pool players. The snapshot persists through the auction so it survives players being dropped to FA. Reading the pool: `GET /api/auction/era-eligible` returns from `ups_era_pool` if seeded; otherwise falls back to the legacy live-roster walk.

### A3.1 Data sources — what's MFL-native vs UPS-custom (Keith 2026-05-22)

Critical: most contract concepts in this canon are **UPS layer constructs** that live in our worker + D1, not in MFL. Mixing them up causes bugs (yesterday: stale `contractStatus="TAG"` data debt produced phantom "FA Contract" Discord posts because owner-side code treated MFL-stored `TAG` as a current-season fact).

| Field / concept | Source of truth | Notes |
|---|---|---|
| `salary` (raw dollar integer) | **MFL** `TYPE=salaries` | Authoritative. Worker writes via `TYPE=salaries` import (APPEND=1). |
| `contractStatus` raw value | **MFL** `TYPE=salaries` / rosters | Stored on MFL. **Free-form string** — UPS overloads it for our taxonomy. |
| `contractYear` (years remaining) | **MFL** | `cy=0` = expired. `cy=1` = LAST year. Per memory note. |
| `contractInfo` annotation | **MFL** (free-text) | UPS-authored. Notes are NOT authoritative — derive cap math from year_salaries + events. |
| Rookie draft slot (round.pick) | **MFL** `TYPE=draftResults` | Original slot. MFL's per-player `drafted` field (a.k.a. "Last Acquired") is overwritten on trade ("Trade (YEAR)") — recover original via `TYPE=draftResults` join for the original draft year. |
| Player's NFL Draft Status / NFL draft year | **MFL** `TYPE=players&DETAILS=1` (proxy `draft_year` field) | Use this when MFL's roster `drafted` field is trade-overwritten. |
| **Tag** (status, side, salary) | **UPS-CUSTOM** | NOT a native MFL concept. We encode it via `contractStatus="TAG"` + our D1 `ups_tag_master` table. The TAG carries our metadata (side, tier, formula). MFL has no understanding of "tag" as a contract type. |
| **MYM** (Multi-Year MYM events) | **UPS-CUSTOM** | D1 `ups_mym_history`. Triggers contract write to MFL via `/offer-mym`. |
| **Extension** events / history | **UPS-CUSTOM** | D1 `ups_extension_submissions` + `ups_extension_history`. |
| **Restructure** events / history | **UPS-CUSTOM** | D1 `ups_restructure_submissions`. |
| **ERA pool** (auction-eligible set) | **UPS-CUSTOM** | D1 `ups_era_pool`. Seeded at deadline-night auto-drop. Canonical for the O=43 picker filter. |
| **Cap penalty** events | **UPS-CUSTOM** | Computed from MFL transactions + D1; posted to MFL via `TYPE=salaryAdj` import. |
| **MYAC / Loading designations** (FL/BL/EXT1/EXT2/EXT3) | **UPS-CUSTOM** | Encoded into the MFL `contractStatus` string (e.g. "EXT2-BL") but the semantic taxonomy is ours. |
| **`Tag` / `MYM-Vet` / `MYM-Rookie` etc.** | **UPS-CUSTOM** vocabulary | See memory note "MFL contractStatus vocabulary". |

**Rule of thumb:** treat MFL as the salary ledger + transactions log. Treat D1 / worker as the authority on everything ABOUT the contract (kind, history, lineage, eligibility). When in doubt: salary numbers = MFL; everything else = us.

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

> **Cross-link — owner tenure & retroactive analytics (Keith 2026-05-14):** the Standings module's 3-Year Eras view enforces a **3-full-season tenure floor** before an owner can be named an era headliner or a retro Captain. Mid-cycle joiners (e.g. Brian Cross in 2025) and the post-Lima/Hammer/Whitman dispersal departures sit in the leaderboard tagged `partial` but are excluded from era naming so a small-sample AP % can't distort the pick. See [docs/standings_advanced_stats_proposals.md](standings_advanced_stats_proposals.md) §1A + Appendix A for the rule + the list of known partial-tenure cases.

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
- **Enforcement model (Keith, 2026-05-16 review session):**
  - **27-active minimum applies ONLY at end of auction**, AND the team must be able to **start a complete lineup** at that moment (per the lineup spec in §B/§S). Not continuously enforced through the season — owners can drop below 27 mid-season; the floor is only re-checked at auction close.
  - **30-active maximum (post-contract-deadline) is enforced via MFL settings** (Keith maintains in MFL config). No UPS worker-side enforcement — MFL blocks adds that would push a team over 30 once the deadline passes.
  - **UPS-side safeguarding** (auction-close compliance cron, complete-lineup pre-flight at auction close, 30-max display chips) is **parked** for the broader auction tooling discussion — see `CROSS_CODEBASE_ALIGNMENT.md §4.1` (Auction Room scope).

### B2. Taxi Squad (UPDATED 2026-05-08)
- **Size:** Max 10 players, min 1 IDP.
- **Eligibility:** Players selected in the **Rookie Draft, Round 2 or later**, for **first 3 LEAGUE years** (NOT NFL service time — eligibility resets when promoted *permanently*, otherwise auto-graduates after 3 league years on taxi). See "Promotion mechanic" below for what counts as a permanent promotion vs a temporary call-up.
- **Salary on taxi: does NOT count against the cap.**
- **Promotion mechanic (UPDATED 2026-05-08 — temporary call-ups):**
  - An owner can call a taxi player up to the active roster **temporarily** for a single NFL week.
  - Each temporary call-up burns **1 of 3** allowed weeks per player across that player's entire 3-year taxi-eligible window. Weeks are cumulative across seasons — consecutive or non-consecutive both count.
  - During an active week, the player **counts against the active roster limit AND the salary cap** for that week.
  - After the week, the owner can demote back to the taxi squad before rosters lock for the next NFL week. If they do, the call-up was temporary.
  - **On the 4th activation, the call-up becomes permanent.** From that point forward, the player is treated as fully promoted — taxi eligibility ends, normal cut penalties apply, and the player can never re-enter the taxi squad. (See T2.4 for the transactional details.)
  - "Active for the week" definition: the player was on the active roster (or on IR) at the time rosters and lineups locked for that NFL week, and appears in that week's weekly results. Putting a called-up player on IR does NOT avoid burning the week.
  - Every owner's call-up usage is tracked and visible — eligibility is auditable. Source of truth: roster snapshots; the bot can answer "how many weeks has [player] been activated?" any time.
  - **Counter scope (Keith, 2026-05-16 review session — re-confirmation):** the 3-call-up budget is a **TOTAL across the player's entire taxi-eligibility window** (the 3-year window from B2 above), **NOT per-season**. A player who burns 2 call-ups in Year 1 has only 1 left across the remainder of their taxi-eligible career; a 4th activation at any point triggers permanent promotion.
  - **Implementation ownership (UPS, not MFL):** this is a **self-imposed UPS rule**. MFL does not enforce the 3-week budget. UPS owns: (a) a persistent counter per `(player_id, franchise_id)` tracked across the 3-year window, (b) worker increment logic on each call-up submit, (c) auto-promotion blocking on the 4th activation, (d) UI display of remaining call-ups on the taxi pane. Implementation tracker: see `AUDIT_FOLLOWUP_TRACKERS.md` (Q10 tracker).
- **Cut economics:**
  - **Taxi-squad players never *permanently* promoted (≤3 temporary call-ups) can still be cut cap-free.** Temporary call-ups do NOT trigger the "permanently promoted" flag, so cap-free cut remains available between activations and after a player returns to taxi.
  - **Once permanently promoted (4th activation OR an MYAC/extension/restructure that explicitly promotes), normal cut penalties apply going forward.**
- **Demotion deadline:** contract deadline date. Mid-season trade-acquired rookies: planned automation will auto-demote (or owner-choice on trade).
- **3-year clock end:** when a player's 3 league years on taxi expire, they're treated like any other expired rookie. If extended → promoted to active. If not → Expired Rookie Auction. **League years, not NFL years.**
- **Tracking source of truth (Keith, 2026-05-16 review session):** **MFL natively handles taxi eligibility** — MFL knows which players are taxi-eligible based on their draft and contract metadata. UPS does NOT maintain a parallel D1 tracking table for the 3-year window itself.
  - **Derivation path when UPS needs to compute eligibility independently (e.g., for a UI gate or a synthetic warning):** pull `players.draft_year` from the MFL `TYPE=players` payload, compute `league_years_elapsed = current_league_year − draft_year`, and gate taxi-eligibility at `league_years_elapsed < 3` AND `draft_round >= 2`.
  - The taxi-eligible flag in MFL roster payloads is the authoritative source. The derivation above is only for UPS-side preview displays where the MFL flag isn't already in hand.

### B3. Injured Reserve (IR)
- **Eligibility:**
  - NFL Injured Reserve (or any IR designation MFL recognizes)
  - COVID-19 IR (legacy)
  - **Holdouts**
  - **Suspended players** (special handling, see below)
- **Cap relief:** **50%** of salary refunded while on IR. (E.g., a player at $20K salary becomes a $10K cap hit while on IR.) **Live verification deferred (Keith, 2026-05-16 review session):** no player is currently on IR, so the worker + client code paths haven't been live-traced against this rule. Follow-up tracker filed in `AUDIT_FOLLOWUP_TRACKERS.md` (Q5) — verify the next time a UPS player IRs.
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
  - **Enforcement timing (Keith 2026-05-18):** check is at **contract-load time** — system hard-blocks selecting Front-Load or Back-Load contract shape (on MYAC submit, ERA win, FA Auction win, restructure submit, or 2-year extension) if the owner already has 5 loaded contracts on roster. No "warn at 4/5" UI — hard reject at 6. Trading away or cutting a loaded player **reopens the slot** in real time; the next loaded contract submission becomes available immediately.
  - Total 3-year contracts: 6 max (excludes rookie 3-year deals).

### C3. Mid-Year Multi (MYM)
- **What it is:** Convert an existing 1-year contract into a multi-year deal at the SAME salary (no raise). Cannot be loaded.
- **Why no loading:** loading would "restructure" Year 1 of the contract, and in-season restructures are banned. So MYMs cannot be loaded.
- **Limit (UPDATED 2025): MAX 4 MYMs per season per team** (raised from 3).
- **Eligibility:**
  - Player acquired via FA Auction or pre-season waivers, NOT given a multi-year contract by Sept deadline → MYM available **before kickoff of NFL Week 3** (per Keith's recall — verify in event log).
  - In-season WW or FCFS pickup → **14-day MYM window** from acquisition. **The 14-day clock does NOT reset on trade.** Example: pickup 10/1 → MYM eligible until 10/14. If traded on 10/20 → no MYM possible (clock already expired). The acquiring team via trade does NOT inherit a fresh MYM window.
- **Type rule (decided 2026-04-27, refined 2026-05-18):** MYM is its **own** `contract_type` value — "MYM" — not collapsed into Veteran. Origin is captured by the `contract_type` history rather than by mutating the type at conversion. Recognized origin sub-types:
  - `Veteran-MYM` — MYM applied to an FA-Auction or pre-season-waiver Veteran pickup.
  - `WW-MYM` — MYM applied to an in-season WW/FCFS pickup that is NOT an NFL rookie.
  - **`MYM-Rookie`** — MYM applied to a WW/FCFS pickup that IS an NFL rookie (preserves ERA-eligibility on expiry per §A3). Examples: Emanuel Wilson, Konata Mumpfield. MFL surfaces these as plain `contractStatus='Rookie'` — UPS-side classification is `MYM-Rookie`. **Salary on these contracts is the WW bid amount (per §A4) — NOT derivable from the §A1 rookie draft slot schedule, because the player never went through a UPS rookie draft.** When such a player's contract expires (cy=0 rollover), MFL preserves the salary on the rosters export (not wiped like draft-slot rookies), so the ERA bid sheet uses MFL's live salary directly.
- **Length on MYM:** **owner's choice — 2 or 3 years.**

### C4. Extension (contract types `Ext1` / `Ext2`)
- **Eligibility:**
  - Player in **final year** of contract (`contract_year=1`).
  - **Expired rookies** also extension-eligible up to the rookie extension deadline (before Rookie Draft in May).
  - **In-season WW/FCFS pickup within 4-week window:** the 28-day post-pickup window is split — first 14 days are MYM-eligible (subject to 4/season cap), final 14 days are extension-eligible (NOT MYM-eligible at that point). I.e., a WW pickup at day 0 has: days 1-14 MYM, days 15-28 extension.
  - **In-season trade-acquired final-year player:** extend within 4 weeks of acquisition.
- **Length:** 1 or 2 years.
- **`contract_type`:** **Ext1** for 1-year extension, **Ext2** for 2-year extension. (Case-insensitive.)
- **FL / BL loading on extensions (Keith 2026-05-15):**
  - **1-year extension (`Ext1`): FL/BL NOT allowed.** One year of extension → no salary curve possible. The MFL `contractStatus` stays `EXT1` with no `-FL` / `-BL` suffix.
  - **2-year extension (`Ext2`): FL or BL allowed.** Status becomes `EXT2-FL` (Y1 > Y2) or `EXT2-BL` (Y1 < Y2). Flat distribution (Y1 = Y2) stays plain `EXT2` with no suffix.
  - Same TCV-preservation + 20%-of-TCV-minimum-Y1 rules as the C2 MYAC loading rules apply.
  - **Counts toward the 5-loaded-contracts roster cap** (combined with MYAC FL/BL deals + restructure FL/BL deals).
  - **Worked example (LaPorta 2026-05-15):** 2-year extension at $50K TCV / $25K AAV. Owner chose Y1-$10K / Y2-$40K (back-loaded; Y2 > Y1). Status posts as `EXT2-BL`. If they'd flipped to Y1-$40K / Y2-$10K it would be `EXT2-FL`. Flat $25K/$25K stays plain `EXT2`.
  - The extension submitter should **auto-derive** the `-FL` / `-BL` suffix from the per-year salary array — owners don't set it manually.
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
- **D1 audit trail intent (Keith, 2026-05-16 review session):** restructure submissions currently dispatch a `log-restructure-submission` event but lack a dedicated D1 audit table parallel to `ups_tag_history` and `ups_extension_history`. A new D1 table — suggested name `ups_restructure_submissions` (or `ups_restructure_history`) — should be added to capture every restructure submission's `franchise_id`, `player_id`, `original_year_salaries`, `restructured_year_salaries`, `source`, `submitted_at`. Wire the existing event handler to write into it. Tracker: see `AUDIT_FOLLOWUP_TRACKERS.md` (Q14 tracker).

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
- **Tag side assignment by position (Keith, 2026-05-16 review session):**
  - **OFFENSE tag side:** QB, RB, WR, TE.
  - **DEFENSE/ST tag side:** DL, LB, DB, **PK, PN**. PK (kicker) and PN (punter) belong on the **DEFENSE/ST** side — they count against the single Defense/ST tag, not Offense. Code grouping (anything outside QB/RB/WR/TE → DEFENSE) matches this rule.
- **Mechanics:** Live in the codebase — see `pipelines/etl/scripts/build_tag_tracking.py` and `build_tag_submissions_json.py`. **Read the code, not the rulebook**, for current tag behavior. Tier formulas open for review (Keith wants to revisit the math).
- **Eligibility window:** Tag candidates are players whose contract is set to expire heading into the upcoming season (i.e., 1 year remaining at end of prior season → 0 years remaining heading into next season). Eligibility is computed from the **prior-season ending roster**.
- **Tagged player constraints (CONFIRMED 2026-04-28):**
  - A player CAN be extended in a prior year and then tagged the following year — extension does NOT permanently block tag.
  - Cannot be **pre-extended by same owner** in the year they're tagged.
  - Cannot be **tagged by anyone else** in the current season.
  - **Once tagged, the player CANNOT be extended OR MYM'd by ANY team — period.** No 1-year tag → re-extension path. The tagged year is a 1-year contract; **the player MUST enter next summer's FA Auction**. The team that tagged them retains the player for that one season only (no extension option afterward).
  - **Exception:** if cut **before FA Auction starts**, normal rules resume — they're treated like any other free agent.
- **Tag salary fallback (unranked players):** `max(lowest-tier salary for the position, prior-season AAV × 1.10 rounded up to $1K)`.
- **WW players + tag salary — current behavior + proposed rule (Keith, 2026-05-16 review session):**
  - **NOT a confirmed rule yet.** A proposed rule of "treat prior WW salary as the lowest tier ($1K floor) when computing a tag's `prior AAV × 1.10` bump" exists but **must be formally proposed via the league's rule-proposal pipeline** before becoming canon. Do **not** modify tag salary calculations to enforce this until passage.
  - **Current behavior already partially implements the spirit of the proposal:** `pipelines/etl/scripts/build_tag_tracking.py:436-457` — `should_use_prior_aav()` **explicitly blocks** `WW`, `WAIVER`, `FA`, `FREE`, `BL` contracts from contributing to the `prior_aav_map` consumed by tag salary calc. A WW-rostered player therefore falls back to the tier-based base bid (or, no-tier fallback, `max(1000, salary_or_prior)`) without their WW salary acting as a `× 1.10` bump floor. This is documented here so future audits don't mistake the absence of a `prior AAV × 1.10` bump on WW players for a bug.
  - **After Keith's formal rule proposal lands** (vote + passage), update §C8 to incorporate the rule explicitly and reconcile the code (the existing `blocked` set may be sufficient, or a new `$1K floor` clamp may be needed depending on the proposal text).

---

## D. EXIT PATHS — how a player leaves a UPS roster

### D1. Cut / Release (cap penalty applies)  (UPDATED 2026-05-08 — true pro-rated earning)
- **Cap penalty formula:** `(TCV × 75%) − Salary Earned`
- **Earning schedule (per-week pro-rated, effective 2026-05-08):** Each completed NFL regular-season week earns one share of that year's salary. The denominator is the player's **eligible weeks remaining at acquisition**.
  - **Auction + Week-1 acquisitions:** 17 weeks total. After Week 1 → **1/17 earned**, Week 2 → 2/17, Week 3 → 3/17, … Week 17 → 17/17 = 100%.
  - **Mid-season pickups (Waiver Wire / FCFS / trade):** denominator = NFL weeks remaining at the time of acquisition (Weeks W through 17). Same earning math, different window.
    - Example A — picked up in Week 9 (9 weeks remaining: Weeks 9–17): Week 9 → 1/9, Week 10 → 2/9, … Week 17 → 9/9 = 100%.
    - Example B — picked up in Week 7 (11 weeks remaining: Weeks 7–17): Week 7 → 1/11, Week 8 → 2/11, … Week 17 → 11/11 = 100%.
  - **WW pickups under the new model are treated identically to auction contracts** — same 75% guarantee, same earning math, same cap-penalty timing. The only difference is the eligible-weeks window. The flat 35% WW rule is RETIRED.
  - **Once the season completes and rollover happens:** prior-year salary is 100% earned (sunk; no further penalty contribution).
  - Apply % to **the year's actual salary** (not AAV). See Section 6.B for the canonical formula and worked examples.
- **What does NOT change** *(carried forward unchanged from prior rule)*:
  - Total cap hit over a contract's life is unchanged — only the *timing* of when salary is earned is now pro-rated.
  - **WW pickups with salary ≤ $4K** remain cap-penalty-free if dropped (see D2 + Bot Grounding appendix). Equivalent to the worker's `< $5K` integer boundary in `worker/src/lib/cap_penalty.js`.
  - **Sub-$5K TCV rule (Keith 2026-05-22 — clarified canon):** for any contract with TCV ≤ $4K (multi-year or otherwise), the penalty rule is:
    - **`years_remaining ≥ 2` → fixed $1K** cap penalty.
    - **`years_remaining ≤ 1` (final year drop) → $0** — cap-free, regardless of what the standard `(TCV × 75%) − earned` formula would have produced.
    - This **overrides** the standard guaranteed-minus-earned formula entirely for sub-$5K-TCV deals. (Replaces prior reading where the $1K was a "floor" on top of the formula. Worked example: Tyler Higbee, CL 3 / TCV $3K / cy=1 dropped 2026-05-22 → final-year sub-5K → $0 penalty.)
    - Worker enforcement: `computeDropPenalty()` in `worker/src/index.js`. D1 audit: `ups_drop_events` table, `penalty_basis` field.
  - All cap penalties are **rounded based on the SUM of penalties accrued**, not per-penalty.
- **Penalty timing (3 buckets — unchanged):**
  - Penalty incurred **before Roster Lock Date** (i.e., offseason early) → applies to **current season** cap.
  - Penalty incurred **from auction start through end of season** → applies to **following season** cap.
  - Penalty incurred **after end of season but before next Roster Lock Date** → applies to **current season** cap (same as bucket 1).
- **Confirmed example (offseason cut — unchanged by the rule):** player on 3-year, $30K/yr Veteran contract (TCV $90K), cut March of Year 2 (offseason):
  - Year 1 fully earned at rollover → $30K earned, no penalty contribution from Y1.
  - Penalty = (TCV × 75%) - Earned = ($90K × 75%) - $30K = $67.5K - $30K = **$37.5K cap hit** to the current season.
- **In-season example under the new rule:** $25K UDFA WR picked up Week 5 via blind bid 2026, dropped after Week 9 (player has been "active" for Weeks 5–9 = 5 weeks; eligible-weeks window = Weeks 5–17 = 13 weeks).
  - Earned = (5/13) × $25K = **$9,615 earned**.
  - TCV = $25K (1-year WW). Penalty = ($25K × 75%) − $9,615 = $18,750 − $9,615 = **$9,135 cap hit** to the **following season** (in-season cut bucket).
  - Under the OLD rule (flat 35% WW), this would have been: 35% × $25K = $8,750 earned → ($25K × 75%) − $8,750 = $10,000. The new rule earns slightly more here because the player was active for 5/13 of the eligible window.

### D2. Cap-free cut categories (no penalty)
- **1-year original-length contracts under $5K (Veteran or WW):** 0% guarantee. Cap-free cut anytime. Note: this only applies to **1-year original** contracts — a 2-year veteran under $5K can still incur penalty depending on cut timing.
- **Taxi Squad (never *permanently* promoted):** 0% guarantee while on taxi. Cap-free cut. Temporary call-ups (≤3 weeks) do NOT trigger permanent promotion; the player can return to taxi and remain cap-free-cuttable. Permanent promotion (4th activation or explicit MYAC/extension/restructure) ends this — normal cut penalties apply going forward. See **B2** for the call-up budget rule.
- **WW $5K+ in-season (UPDATED 2026-05-08):** Same 75% guarantee + per-week pro-rated earning as auction contracts (the old flat 35% WW penalty is RETIRED). The eligible-weeks denominator is `18 − pickup_week`. See Section 6.B for the canonical formula and D1 for an in-season worked example.
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

### T2.4 Promote from Taxi (`TAXI` reverse)  (UPDATED 2026-05-08)
- **Source:** Same MFL TYPE; `import?TYPE=taxi_squad&PROMOTE=...`.
- **Initiator:** Owner.
- **Eligibility:** Player on taxi.
- **Cap effect (per active week):** Salary counts against the cap **for the NFL week the player is active**. If demoted back to taxi before the next week's roster lock, the cap impact ends with the week.
- **Two flavors of promotion (UPDATED 2026-05-08):**
  1. **Temporary call-up:** weeks 1–3 of activation across a player's taxi-eligible window. Player can be demoted back to taxi after the week and remains taxi-eligible. Each week burns 1 of 3 allowed activations per player.
  2. **Permanent promotion:** triggered automatically on the **4th activation week**, OR explicitly when the owner converts the contract via MYAC / extension / restructure during a call-up. **Once permanent, the player is NEVER re-eligible for taxi.** (Legacy behavior: MFL would auto-promote on trade, and UPS would manually re-demote — that workaround is GONE in the modern rules.) The trade module (planned) will need to enforce no-re-demotion explicitly.
- See **B2** for the full call-up budget mechanic + auditability rules.

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
- **Examples:** Late dues fines ($3K/week), drop penalties, missed-nomination fines (**§F RULE 2** — $3K → $7K → $15K, escalating; full schedule in §T4.3a below).

### T4.3a §F RULE 2 — Missed Nomination / Extra Nomination fines (Keith, 2026-07-14)

**Canon status:** §A2 had pointed at "see §F" for a schedule that was never written down — §F was headed "STILL-OPEN QUESTIONS". This is that schedule, in Keith's words, and it is now binding.

> Listen, I understand that life can sometimes get in the way of being 24/7 engaged but this is the friggin auction we're talking about here. Pretty much the best 2 weeks of the year. So asking an owner to log on one time in a 24 hour period is not asking too much especially in today's smart phone world, where you literally have the ability to log on from anywhere. Set a daily recurring reminder on your phone at 8 AM everyday if you need to remind yourself to make a nomination. Needless to say one of the biggest pet peeves over the years has been some owner's inattentiveness during the auction and going a day or days at a time missing nominations.

| Offense | Fine | Applied to |
|---|---|---|
| **1st** | **$3K** | current season **and** next season |
| **2nd** | **$7K** | current + next (**$10K total each year**, cumulative) |
| **3rd** | **$15K** | current + next (**$25K total each year**, cumulative) |
| **4th** | **no fine** | league-fit review — see below |

- **Cumulative, not replacing.** The totals in Keith's text (3 → 10 → 25) are running sums: the 2nd offense *adds* $7K on top of the 1st's $3K.
- **Both years, but not both now.** The current-season fine posts to MFL as a `salaryAdj` when armed. The **next-season fine is ledger-only and must NOT reach MFL until the rollover** — it shows in reporting immediately, crosses over next year (Keith 2026-07-14: *"store the 3K on the ledger for 2027... never pass to MFL until we roll forward next year"*).
- **4th offense is a conversation, not a transaction.** Keith's words: *"You should reconsider if your a good fit for the league."* The league posts that message to the owner and asks them to make their case; the league then decides. **Never automated.**
- **CAVEAT — immunity (load-bearing).** Keith: *"Obviously if there's some family emergency that prevents you from making a nomination, let us know and it won't be held against you. If you let a member of a CC. know ahead of time that you need to miss a day for whatever reason you will also be granted immunity."* The commish **voids the day**, which voids its penalties and removes it from the offense count. A penalty system without this will fine somebody who called ahead — worse than no system at all.
  - **The CC no longer exists (Keith 2026-07-15).** Read "a member of a CC" as **the league** — telling the league ahead of time is the standard. It is a heads-up, not an application: Keith's example is an owner mentioning he'll be in Yellowstone and may not have service. No form, no approval step; the commish voids the day.
- **Voiding is not deleting.** A voided day stays in `ups_faa_nom_days` as evidence the owner gave notice — that record is what protects them if it comes up again.
- **An excused day re-derives the ladder.** Offense numbers are recomputed from the surviving (un-voided) misses, oldest first, so excusing someone's 2nd miss makes their 3rd become the 2nd — $7K, not $15K. This follows directly from *"it won't be held against you"*: a day that silently pushes your next miss into a higher tier **is** being held against you. Without this the schedule is incoherent — an excused 2nd offense would leave the owner paying $3K + $15K, skipping the $7K tier that exists between them. Re-pricing can only move a fine **down**, or restore it to a number the owner was already told, because the amount is a pure function of how many misses survive.
- **A re-priced fine that already posted needs a human.** Voiding a row does not undo a `salaryAdj` already written to MFL, and neither does re-pricing one. Both surface as `needs_mfl_reversal` / `repriced_posted` so the commish can fix MFL by hand.
- **ERA is exempt** — no missed-nomination fine (§A3, and §A2's "Missed-nomination policy" note). FAA is the mandatory one.

**Implementation:** `worker/src/auction_compliance.js` (`RULE2_FINE_K_BY_OFFENSE = [3, 7, 15]`), ledger `ups_faa_nom_days` + `ups_faa_nom_penalties` (migration 0097). The MFL write is gated behind `AUCTION_FAA_PENALTIES_ENABLED`, **dark by default** so pre-auction test weeks can't manufacture fines.

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
    - **Exception — offseason drop *before* the FA Auction (Keith 2026-06-07):** dropping a tagged player in the **offseason, before that summer's FA Auction**, **DOES reset** their tag eligibility — the player re-enters the auction, and whoever wins them gets a fresh `Vet-FAA` contract, so they're tag-eligible again in a future cycle. The "mid-season drop does NOT reset this" rule above applies to **in-season and post-auction** drops only. Rationale: the auction itself is the contract reset. FO enforcement: the 2027 tag-VALUE projection excludes players still carrying a live `Tag` contract; a dropped-and-re-won player surfaces as `Vet-FAA` (type ≠ Tag) and is therefore included again automatically.
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

**Lock time (Keith 2026-05-21):** the tag/extension deadline is **midnight ET on the Thursday→Friday boundary** (i.e., submissions accepted through end-of-Thursday ET; first second of Friday ET = lock). In UTC during EDT (always — Memorial Day is late May), this is **04:00 UTC Friday**. Worker code: `getTagDeadlineUtc()` in `worker/src/index.js` returns this exact moment; `hasTagDeadlinePassed()` gates every downstream consumer (Discord routing flip, trade eligibility, `/commish-contract-update` hard-lock at line ~28766, midnight auto-drop cron). Prior canonical lock was 23:59:59 UTC Thursday (8 PM ET) — corrected upward by 4 hours to align with the natural "midnight" calendar boundary.

For 2026 (Memorial Day = Mon May 25):

| Date | Day | Event | Source |
|---|---|---|---|
| **2026-05-21** | **Thu** | **UPS Tag deadline** (offense + def/ST submissions) — locks at midnight ET (04:00 UTC May 22) | `ccc.js` `getTagDeadlineInfo` (memorial − 4) + worker `getTagDeadlineUtc()` |
| 2026-05-21 | Thu | UPS Rookie Extension deadline (same day as tag deadline — combined) | `event_window_matrix.csv` |
| 2026-05-22 | Fri | **04:05 UTC** — auto-drop of every non-extended expired rookie (hourly cron, idempotent via `ups_deadline_lock_log`) | worker `processTagDeadlineMidnightLock` |
| 2026-05-22 | Fri | **10:05 UTC (= 6 AM ET)** — commish DM with all locked tag contracts | worker `processTagDeadlineSixAmDm` |
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

**Earning curve (UPDATED 2026-05-08):** True pro-rated per completed NFL regular-season week. See **Section 6.B** for the canonical rule. The previous calendar-month bucket model (25% / 50% / 75% at end of Oct / Nov / Dec) is RETIRED.

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
- **(UPDATED 2026-05-08)** Earning is now per-completed-week (Section 6.B). The old "end of October = 25%" checkpoint is retired. By the start of Week 5, ~4/17 ≈ 24% of an auction salary is earned.

### November 2026 → Trade Deadline
- **2026-11-26 (Thu, Thanksgiving, Week 12 kickoff):** **UPS trade deadline.** No trades until next offseason after this kickoff.
- **(UPDATED 2026-05-08)** No discrete earning checkpoint — earning accrues per completed week (Section 6.B). By end of Week 12 (Thanksgiving week), ~12/17 ≈ 71% of an auction salary is earned.
- **Remaining league dues** ($100) due by trade deadline. Venmo to @Keith-Creelman → treasurer Josh Martel.

### December 2026 → Fantasy Playoffs
- **2026-12-17 (Thu, Week 15):** **UPS Playoffs Round 1 starts.** 3-week format.
- **2026-12-24 (Thu, Week 16):** Playoffs Round 2 / Toilet Bowl bracket continues.
- **2026-12-31 (Thu, Week 17):** **UPS bracket finals — championship name TBD (rename pending) + Hawktuah Bowl** (Toilet Bowl, named after viral girl + Hawks team perennial worst finisher).
- **(UPDATED 2026-05-08)** No discrete earning checkpoint — earning accrues per completed week (Section 6.B). By end of Week 17 (regular season end), 17/17 = 100% earned.

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
2. **Free Agent Auction** (last weekend of July) — must nominate exactly 2/day (ET calendar day; a minimum AND a maximum — see §A2), must be reachable
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

# Section 3.5 — Standings, Weekly Scoring, & Matchups

Added 2026-05-08. Companion to the Divisional Co-tenancy History appendix at the bottom of this document. Section 3.5 documents the **data model and rules** for weekly scoring, head-to-head matchups, and standings. The appendix documents **historical pair frequencies**.

## A. Schedule structure (current era, 2023-2025; 2026 alignment pending draft night)

The UPS regular-season schedule is built from two week types, both played by all teams in the league:

- **Divisional weeks** — every team plays every other team in their division.
- **Intra-divisional weeks** — every team plays opponents from outside their division.

All divisions share the **same weekly schedule type** — i.e., when one division has a divisional week, every division does. Some weeks are **multi-opponent** (double-headers or triple-headers), so a single (season, week, franchise) tuple can have **2 or 3 simultaneous H2H opponents**. The data model preserves all opponents and per-opponent results.

**Playoffs are always single-matchup** (one H2H opponent per round). The `is_playoff` flag on `src_schedule` distinguishes regular-season from post-season rows.

## B. Division alignment & realignment cadence

Divisions realign every 3 years. Cycles:

| Cycle | Seasons |
|-------|---------|
| 2011–2013 | 2011, 2012, 2013 |
| 2014–2016 | 2014, 2015, 2016 |
| 2017–2019 | 2017, 2018, 2019 |
| 2020–2022 | 2020, 2021, 2022 |
| 2023–2025 | 2023, 2024, 2025 |
| 2026–2028 | 2026, 2027, 2028 |

**2026 alignment is pending.** A rule vote (in progress 2026-05-08) approved that **divisions will be selected on draft night**. The 2026 division composition will be backfilled into `src_franchises` once MFL reflects the post-draft alignment. Until then, queries that group by 2026 division will return `NULL`.

Cross-link: full owner-by-owner pair history is in the **Appendix — Divisional Co-tenancy History (2011-2025)** at the bottom of this document.

## C. All-Play Winning Percentage

Each week, every franchise's score is compared against **every other franchise's score** in the league. Each pairwise comparison records a win, loss, or tie independent of who that franchise actually played head-to-head.

Why we track it:

- **Matchup-luck-neutral.** A team can score the league's 2nd-highest total, lose H2H, and still go 11-1 in all-play that week. All-play measures *how the team scored*, not *who they happened to draw*.
- **Feeds the (informal) 3-year-cycle AP% leaderboard** documented in the appendix — a Dynasty-Pot-style metric the league has discussed but never paid out.
- **Computed at ingest time, not query time.** `src_weekly_franchise_summary.allplay_wins/losses/ties` are pre-computed in the local source DB; D1 queries don't need to recompute pairwise comparisons.

## D. Bye-week semantics

A franchise may have **no H2H opponent** in a given week. When that happens:

- `src_schedule` will have **no row** for (season, week, franchise).
- `src_weekly_franchise_summary` will **still have a row** for (season, week, franchise) with the franchise's actual score and the week's all-play counts.

This separation means **all-play continues to count even when H2H doesn't**. Any consumer that wants "weeks with a real matchup only" should filter on `EXISTS (SELECT 1 FROM src_schedule …)`.

## D.1 All-play metrics (regular season / playoff / full)

All-play measures performance independent of head-to-head matchup luck: each week, every franchise's score is compared to every other franchise's score in that same week, accumulating wins / losses / ties. Tracked since 2010 (with caveats — see "lineup submission history" below).

### Four metrics (all in `src_standings`)

| Metric | Columns | Definition |
|---|---|---|
| **Regular season AP** | `allplay_regseason_w/l/t` | All-play across regular-season weeks only (W1-13 for 2010-2020, W1-14 for 2021+). |
| **Playoff AP** | `allplay_playoff_w/l/t` | All-play across playoff weeks only (W14-16 for 2010-2020, W15-17 for 2021+; 2012 had 4 playoff weeks). |
| **Full AP** | `allplay_full_w/l/t` | regseason + playoff. Matches MFL's `leagueStandings.all_play_wlt` for 2012-2025 (verified 168/168). |
| **Historical AP** | `allplay_historical_w/l/t` | **Hybrid league-canonical record:** regseason for 2010-2016, full for 2017+. Reflects how the league has actually tracked AP over its history (the convention switched in 2017 when weekly lineup submission became mandatory via the top-scorer prize). Use this column when you want a single AP record that matches league records as written. |

**Source of truth (current architecture):**

- **Primary path (going forward):** AP metrics derive nightly from `weeklyresults.team_score` via the live MFL API ingest. This is reliable for 2017+ where weekly lineup submission is enforced (verified 180/192 (season, franchise) keys match MFL exactly).
- **Historical correction (one-time, 2010):** For 2010 specifically, `weeklyresults.team_score` differs slightly from MFL's official record due to the lineup-gap era (some owners didn't submit lineups when out of contention; the weekly top-scorer prize was added later to enforce it). The 2010 row of `src_standings` was corrected once via a scrape of MFL's authoritative **O=101 (All-Play Standings)** endpoint on 2026-05-09.
- **Validation/backup table:** `src_mfl_o101_validation` stores the full O=101 scrape (16 seasons × 12 franchises × 2 cutoffs = 384 rows). Use it to diff against `src_standings` if you suspect drift, or as a re-seedable historical baseline. Re-scrape via `scripts/.tmp_scrape_o101_allplay.py` if needed (rare; not part of nightly cron).

Per-week per-franchise scores are stored in `src_franchise_weekly_score` (PK: season, week, franchise_id; with `is_playoff` flag and `team_score`/`team_opt_pts`). Per-season metadata is in `src_league_season_meta` (last_regular_season_week, total_weeks, league_id, mfl_server).

### Methodology cutover at 2017

Manual league records pre-2017 used **regular-season-only AP (W1-13)** as the canonical historical metric (143 games per franchise per year). Starting **2017** the league switched to tracking all-weeks AP including playoffs (~176 games/franchise/year for 2017-2020, ~187 games/franchise/year for 2021+ with the longer reg season). The new schema exposes both — `allplay_regseason_*` reproduces the pre-2017 historical convention; `allplay_full_*` matches the modern (and MFL's own) convention.

### Lineup submission history (matters for 2010 data quality)

In the early league era, owners who fell out of contention sometimes **stopped submitting lineups** for late-season weeks. Those non-submission weeks score very low (or zero) and inflate other franchises' AP wins for those weeks. The league later instituted the **weekly top-scorer prize** specifically to enforce lineup submission every week.

Practical impact:

- **2010** is the only year where all three available data sources disagree on AP totals (local `standings`, local `weeklyresults_summary`, and a fresh recompute from `weeklyresults.team_score` produce three different numbers per franchise). Lineup-gap weeks are likely the cause.
- **2011-2025**: all three data sources match exactly (180/192 (season, franchise) keys agree byte-for-byte). The 12 mismatches are all 2010.
- The new `allplay_*` columns in `src_standings` are derived from `weeklyresults.team_score` directly. For 2010, this can differ from the pre-existing `standings.allplay_w/l` by ±5-15 wins per franchise. **The new columns are canonical going forward.**

### Querying

```sql
-- Career regular-season AP% for active 12 (matches pre-2017 historical convention)
SELECT owner_name,
       SUM(allplay_regseason_w) AS w,
       SUM(allplay_regseason_l) AS l,
       1.0*SUM(allplay_regseason_w) / NULLIF(SUM(allplay_regseason_w)+SUM(allplay_regseason_l)+SUM(allplay_regseason_t),0) AS pct
FROM src_standings
WHERE owner_name IN (...)
GROUP BY owner_name ORDER BY pct DESC;

-- Playoff AP% only (small samples — most franchises have 30-300 playoff AP games depending on tenure)
SELECT owner_name, SUM(allplay_playoff_w) AS w, SUM(allplay_playoff_l) AS l ...

-- Full AP% (2017+ canonical, matches MFL leagueStandings)
SELECT owner_name, SUM(allplay_full_w) AS w, SUM(allplay_full_l) AS l ...
```

The legacy `allplay_w/l/t` columns (from migration 0029) remain in `src_standings` for backward compatibility but should be considered **deprecated** — they have a 2010 inconsistency relative to the new derived metrics. New analytics should use `allplay_regseason_*` / `allplay_playoff_*` / `allplay_full_*`.

## D.2 Mid-season / mid-auction takeover ownership rule

When a franchise changes ownership during a season, **the season's record belongs to whoever drafted the roster and managed it at season kickoff**. The rule:

- **Departing owner takes the year if they completed the auction/draft, even if they leave mid-season** (e.g., personal reasons, work). The replacement inherits a roster they didn't build.
- **Replacement owner does NOT get credit for the takeover year** — even if they take over before Week 1, if they didn't auction/draft the roster, the year doesn't count for them.
- A replacement owner's career record starts the **first season they completed an auction/draft as the franchise owner of record**.

### MFL API vs. our data: what to trust

MFL's public API does NOT encode this rule. Examples (verified 2026-05-09):

- **2017 F0002:** MFL API returns `team_name="New Franchise"`. Per our rule, **the year belongs to Derrick Whitman** (he completed the 2017 auction and left mid-year for personal reasons; AJ & Rico Balderelli took over but did not auction).
- **2022 F0002:** MFL API returns `team_name="DBCA"` (AJ's team name). The year **stays with AJ Balderelli** even though Whitman returned mid-2022 after AJ was ousted for collusion.
- **2022 F0005:** MFL API returns `team_name="HammerTime"` (Eric Martel's team name). The year **stays with Rico Balderelli** even though Eric Martel entered mid-2022 after Rico was ousted.
- **2024 F0006:** MFL API returns `team_name="The Long Haulers"` (Cross's team name). The year **stays with Josh Lima** — Cross took over pre-season but Lima had the franchise for the auction-of-record.

The **local `mfl_database.db` already encodes our rule** — the `franchises.owner_name` and `standings.owner_name` columns reflect the auction-of-record owner, not whoever happens to control the franchise at MFL pull-time. Downstream D1 tables (`src_franchises`, `src_standings`, `src_weekly_franchise_summary`) inherit this and **are the canonical source** for any owner-attributed query.

### Known transitions (currently-active owners)

| Year | Franchise | Auction-of-record (counts) | Replacement (does NOT count) | Reason |
|---|---|---|---|---|
| 2017 | 0002 | Derrick Whitman | AJ & Rico Balderelli | Whitman left mid-season; he had auctioned the roster |
| 2022 | 0002 | AJ Balderelli | Derrick Whitman (returning) | AJ ousted mid-season for collusion |
| 2022 | 0005 | Rico Balderelli | Eric Martel (entering) | Rico ousted mid-season for collusion |
| 2024 | 0006 | Josh Lima | Brian Cross (entering) | Lima ousted; Cross took over pre-season but did not auction |

### Implementation note

**No exclusion list is needed when querying `src_standings` for owner career aggregates.** The data is pre-rolled to the auction-of-record owner. A simple `GROUP BY owner_name` produces the correct record:

```sql
SELECT owner_name, SUM(allplay_w), SUM(allplay_l), COUNT(DISTINCT season) AS seasons
FROM src_standings
WHERE owner_name IN (...active owners...)
GROUP BY owner_name
ORDER BY 1.0 * SUM(allplay_w) / NULLIF(SUM(allplay_w)+SUM(allplay_l)+SUM(allplay_t), 0) DESC;
```

If a future ingest reads directly from MFL API and bypasses this rule, the `franchises` / `standings` ingestion step must apply the auction-of-record correction before writing to the local DB. The rule is **not** in the daily snapshot or the legacy fetcher today — it's baked in as a manual data correction in the local DB historically. Future port-of-fetcher (see `pipelines/etl/README.md` follow-up) must preserve this behavior.

## E. Source tables on D1 (migrations 0029 + 0030)

These `src_*` tables are the canonical cloud-side store for franchise-level fantasy results. Populated from the local `mfl_database.db` via `scripts/load_local_to_d1.py`. **Never mutate these directly** — apply data fixes via the `corrections` table per migration 0001's overlay model.

| Table | Grain | Migration | What it answers |
|-------|-------|---|-----------------|
| `src_franchises` | (season, franchise_id) | 0029 | Owner, team name, division for any season — the dim every other table joins to |
| `src_schedule` | (season, week, franchise_id, opponent_franchise_id) | 0029 | Each H2H matchup row: scores, W/L, `is_divisional`, `is_playoff`. Multi-opponent weeks produce 2-3 rows per franchise. Bye = no row. |
| `src_weekly_franchise_summary` | (season, week, franchise_id) | 0029 | Pre-computed per-week H2H + all-play summary (legacy view; for new work prefer `src_franchise_weekly_score`). |
| `src_franchise_weekly_score` | (season, week, franchise_id) | **0030** | **Canonical per-week franchise score** (`team_score`, `team_opt_pts`, `is_playoff`). Source of truth for the three new AP metrics. |
| `src_league_season_meta` | (season) | **0030** | Per-season league configuration: `last_regular_season_week`, `total_weeks`, `reg_weeks`, `playoff_weeks`, `league_id`, `mfl_server`. |
| `src_mfl_o101_validation` | (season, franchise_id, cutoff_label) | **0032** | **Backup/audit only.** MFL O=101 (All-Play Standings) scrape from 2026-05-09. 384 rows (16 seasons × 12 fr × 2 cutoffs). Diff against `src_standings.allplay_*` to catch drift. |
| `src_standings` | (season, franchise_id) | Season-aggregate H2H, division, all-play %, points-for, points-against, EFF |

`is_divisional` on `src_schedule` is computed at load-time via JOIN against `src_franchises` (cheaper to bake in once than to JOIN on every D1 read).

## F. Upstream automation (current state)

The local DB tables `franchises`, `schedule`, `weeklyresults`, `weeklyresults_summary`, `standings` are populated by a **fetcher that lives outside this repo** (legacy `~/Desktop/MFL_Scripts/`). `scripts/run_pipeline_live.sh` does **not** refresh these — only `scripts/sync_d1.sh` reads them and pushes to D1. A 24h staleness check in `sync_d1.sh` fails the nightly cron loudly if the external fetcher stops running.

Follow-up: port the legacy fetcher into `pipelines/etl/scripts/` so this repo becomes the single source of truth. See `pipelines/etl/README.md` "External fetchers (not yet ported)".

## F.1 Playoff seeding rule (added 2026-05-15)

**Seeding is by All-Play %, NOT by head-to-head wins or "regular-season record".**

- **4 division winners** receive automatic playoff bids.
- **Top 2 seeds (1, 2) are RESERVED for division winners** — a non-division-winner cannot earn a top-2 seed no matter how high their AP%.
- **Seeds 3–6 (or wherever the bracket ends)** rank by All-Play %, including the remaining 2 division winners alongside wild-card teams.
- A division winner can be the **6th seed** (or lowest playoff seed) if they have the worst AP% among the qualifiers.
- **Tiebreaker ladder (when AP% ties):** Overall → Points For → H2H (same ladder used for waivers, see §A4).

Implications for narrative / analytics code:

- **Never derive a seed from H2H W-L** ("overall_w/l" in standings JSON includes playoff games and is not a seed proxy).
- **Never describe a team's seed using regular-season wins.** Use `all_play_pct` from `src_standings` plus the "must win division for top 2" rule.
- For the "Who was the #N seed in season Y?" question: rank `src_standings` rows by (is_div_winner DESC for top 2, then all_play_pct DESC). Top 2 picks are the two division winners with the highest AP%; seeds 3..N then rank purely by AP% with division-winner status only ensuring playoff entry, not seed position.

## F.2 Division-champ tiebreaker vs UPS playoff-seeding tiebreaker — DO NOT CONFLATE (Keith, 2026-05-16 review session)

There are **three distinct ranking sites** in UPS standings code. Owner-facing narration and code review must keep them straight.

| Concept | Where the rule lives | What it ranks | Tiebreaker chain |
|---|---|---|---|
| **Division-champ tiebreaker** | **MFL setting** (`lg.standingsSort` from `TYPE=league` API) — changes year-to-year | Teams **within a division** — picks the division winner | Year-specific. Example: 2011 = `PCT,DIVPCT,PTS,H2H,PWR`; 2014+ = `PCT,DIVPCT,H2H,PTS,ALL_PLAY_PCT,PWR`. Authoritative source = current MFL settings, not this doc. |
| **UPS playoff-seeding tiebreaker** | **UPS canon** — §F.1 above | Wild-card pool + seeds 3–6 across the league | AP% → Overall → Points For → H2H (UPS-custom, stable across years) |
| **Standings-page visual sort** | **UPS canon** — same as playoff seeding (Keith 2026-05-17, Option A approved) | Full league standings page | AP% → Overall → Points For (pairwise H2H not computable here) |

**Code separation in the worker** (`worker/src/index.js`):
- Fetches `lg.standingsSort` from MFL `TYPE=league` and stores on the league record.
- `sortFnFromStandingsSort()` parses MFL `standingsSort` and applies it to **division-leader selection only**.
- Wild-card pool sort and the full standings-page `ORDER BY` both use canon §F.1: `AP% → Overall → PF`.

**Schema note — `h2h_pct` is the Overall record.** In `src_standings` the columns `h2h_w / h2h_l / h2h_pct` represent each team's overall regular-season record, NOT pairwise head-to-head. The "h2h" prefix predates the §F.1 Overall/H2H split. The pairwise H2H step in §F.1's chain isn't computable from `src_standings` alone (needs schedule data) and is dropped from in-memory comparators in favor of the franchise-name fallback.

**Bot guidance:** when asked "who wins division X tiebreaker", read MFL `standingsSort` for the year in question and apply that chain. When asked "who gets the #N seed" or "who's #N on the standings page", apply §F.1 (UPS canon).

## G. STILL-OPEN ITEMS for Section 3.5

1. **2026 division composition** — locks at draft night. Backfill `src_franchises` 2026 rows once MFL publishes.
2. **Weeks-per-regular-season transition** — schedule length changed when NFL went 16→17 (2021); document the per-era table of total reg-season weeks.
3. **Multi-opponent week scheduling rules** — when does the league use double- vs triple-headers? Document the calendar pattern so the bot can answer "is week 4 a triple-header?" without reading the schedule table.

---

## END Section 3.5 (NEW 2026-05-08)

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

> **CRITICAL caveat — settings vs. intent (Keith v16):** League rules and MFL settings can drift. A vote can be passed in the forum/Slack/Discord with intent for year N, but the actual MFL `TYPE=rules` settings may not be updated until year N+1 or later. The bid sheet MUST use **MFL `metadata_rawrules` as the authoritative source for what scoring actually applied in a given year**, NOT the forum/Slack vote dates. **Always check settings.** Where a forum vote and the MFL settings disagree, the MFL settings are what scored fantasy points that year. (Example: the 2021 first-downs vote may reflect intent that was already in the MFL settings since 2011 — the rule pre-existed in MFL, the league just didn't enforce/track it. The settings — not the vote — define what counted.)

## B. Rule changes by year (bid-sheet relevant)

> Each entry should record OLD value → NEW value with enough precision to normalize historical data. Where I have the old value, it's in this doc. Where I don't, **❓DETAIL NEEDED** flags it as a follow-up item for the chronicle work.

### 2010
- **FA Auction only — NO rookie draft.** Contracts maintained on Forumotion. Format was one-and-done by design.
- Auction values from 2010 are **NOT comparable** to modern dynasty data. Exclude entirely.

### 2011 — Founding dynasty Year 1
- **Also FA Auction only — NO rookie draft yet.** ONLY difference from 2010: 2011 league knew the format was permanent (dynasty), so contracts persisted forward into 2012.
- **Starting lineup: 1 RB mandatory** (1QB / **1RB** / 2WR / 1TE / 2Flex / DL / LB / DB / 3 DefFlex / K / P). The 1-RB minimum stayed in effect through ~2014 (see 2015).
- IDP added: split out DT/DE/LB/CB/S, added PN; RB=1-3, TE=1-3, WR=2-4 (starter MAXIMUMS, not minimums).
- **RB PPR: 1.0 → 0.75** (CONFIRMED via MFL `metadata_rawrules` 2010→2011 diff). 2010 had `RB CC 0-99=*1` (1.0 PPR for ALL positions including RB — redraft format). 2011 dynasty-Y1 reset extracted RB into its own group at `*.75` while other positions stayed at `*1`. **Keith was right** — there ARE two RB PPR transitions in MFL data: 1.0 (2010) → 0.75 (2011) → 0.80 (2018).

### 2012 — CONFIRMED via MFL `metadata_rawrules` (66 rule changes 2011→2012)
- **First rookie draft** (introduced this year — dynasty cap needed it once contracts persisted).
- **4-owner dispersal draft.** Original results in Forumotion.
- **MAJOR punter scoring overhaul:** **`PNY` (gross punt yards) entirely REMOVED.** Pre-2012 punters scored on `PNY 0-999 = .1/2` (0.1 pts per 2 yards of gross punting) — that's why they scored obscene amounts in 2011. 2012 onwards: PNY abolished; punters score on the new ANY/big-game tier + KY/UY return yards.
- **Big-game / ANY bonus added** for ALL positions: `ANY 60-100 = 5` (5 pts if any single-game position score reaches 60+).
- **Tackles added (TKL):** `TKL 0-25 = *1` for all positions — 1 pt per tackle, capped at 25.
- **Return-yardage scoring added:**
  - `KY -50 to 999 = .025/yd` (kickoff return yards: 1 pt per 40 yds)
  - `UY -50 to 999 = .05/yd` (punt return yards: 1 pt per 20 yds)
- **Pass interference DOUBLED:** `PI 0-20 = *2` → `PI 0-20 = *4`.
- **Taxi squad introduced at size 5.**

### 2013 — NO scoring changes (verified)
2012→2013 diff: zero rule changes.

### 2014 — NO scoring changes (verified)
2013→2014 diff: zero rule changes (lineup/contract rules were the 2014-02-11 forum votes — see above).

### 2013
- Rookie contracts: 2 years → **3 years** (by league vote).
- **Trade votes removed.** Commissioner-led trade processing replaced league veto poll. 5 collusion votes still trigger a veto poll.
- Contract dynamics for the bid sheet: extension + restructure data from Forumotion is the primary source for understanding how contracts behaved pre-2018.

### 2014 — multiple forum votes 2014-02-11 (CONFIRMED via Forumotion)
- **6×3-yr cap (excluding rookie 3-yr deals) REAFFIRMED** — vote tied, rule remained as-is. Forum thread `t65 Contract Length`, started 2013-06-09. Still active in 2026 (Keith v12).
- **Restructure-only-with-extension rule PASSED 7-5.** Rule text from thread `t92 Ability to restructure contracts` (started 2013-08-18): *"Any player given an extension, the owner may incorporate the cost of the extension into the current year. Restructure may be split evenly across all remaining years OR incorporate as front/back load."* Later overturned (year still TBD).
- **9-player taxi squad with tier limits PASSED 7-5.** Tiers: 5 with 3 yrs left / 3 with 2 yrs left / 1 with 1 yr left. Forum thread `t83 Taxi Squad thoughts`, started 2013-06-30.
- **Cap-free cuts for taxi-eligible rookies PASSED.** *"No player not on Active Roster who is cut incurs a cap charge. Any rookie drafted in R2+ cut prior to contract deadline = no cap hit if never demoted to taxi."* Forum thread `t91 Taxi-Squad Contracts Guaranteed?`, started 2013-08-18.

### 2015 — Lineup expansion (CONFIRMED via Forumotion)
- **RB starter MIN went 1 → 2.** Forum thread `t111 Added offensive Position` started 2014-02-27 by Blake Bombers. Keith's compromise: keep 1-RB minimum for 2014 (rosters/values already locked), implement 2-RB for 2015 to give owners full year to plan. Lineup became 1QB / **2RB** / 2WR / 1TE / 2Flex / IDP / K / P.
- RB starter MAX bumped from 1-3 → 2-4 (per memory `scoring_history_eras.md`).

### 2015-12-01 — 2016 Comp Committee agenda (Forumotion `t245`)
Inaugural Winter Meetings agenda. Several items here became 2016+ rules. Captured topics:
1. **Restrictions on Contract Restructures** (limit similar mid-season extensions to 2; extend to front/back load; cap at 2 each per season per team). **Precursor to the eventual in-season restructure ban.**
2. Toilet Bowl 1 & 2 seed bye (similar to Championship).
3. Grace Period for cut-then-rebid (X weeks).
4. **Kicker scoring overhaul** — proposed: 30yd FG = 3 pts; +0.1/yd deeper; -0.1/yd closer; misses 45+ exempt from minus, otherwise -0.1/yd. **Became the 2016 FG per-yard rule.**
5. Backup Player tiebreaker for all-play.
6. Taxi-squad practice-squad sniping (proposed; didn't pass).

### 2016 — CONFIRMED via MFL `metadata_rawrules` (22 rule changes)
- **FG scoring overhaul: per-yard.**
  - **OLD (2011-2015):** `FG 60-99 = 8` (flat 8 pts for ANY FG 60+; below 60 yds default 3 pts).
  - **NEW (2016+):** `FG 0-99 = .1/yd` (0.1 pts per yard — 30-yarder = 3 pts; 50-yarder = 5 pts).
- **Missed FG (MG) range narrowed:** `MG 30-99 = 0` → `MG 45-99 = 0` (penalty-free range pulled in from 30+ to 45+; misses 30-44 yds now incur penalty).

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

### 2017 — NO scoring changes (verified)
2016→2017 diff: zero rule changes.

### 2018 — MAJOR scoring rebalance + roster expansion (CONFIRMED via `metadata_rawrules`, 46 rule changes)

**Scoring rebalance:**
- **RB PPR: 0.75 → 0.80** (`RB CC 0-99=*.75` → `RB CC 0-99=*.8`). Second of TWO RB PPR transitions in MFL data (first was 1.0 → 0.75 in 2011 dynasty reset).
- **IDP tackles boosted:**
  - DB (CB, S): `AS 0.5 → 0.8`, `TK 1.0 → 1.3`, `TKL 1.0 → 1.5`
  - DL (DE, DT): `TK 1.0 → 1.5`, `TKL 1.0 → 1.5`
- **Pass defensed (PD) tripled** all positions: `PD 0.5 → 1.5`.
- **Forced/intercepted catches boosted:** `FC 3 → 4`, `IC 3 → 4`.

**Roster expansion (from `metadata_starters`):**
- Active roster: 26 → **30** (auction max 31 → 35).
- Taxi: 9 → **10** (min 1 IDP).
- IDP starter MIN: 1 → **2** for CB+S, DT+DE, LB (each went `1-3` → `2-3`). Total IDP starters: 5 → **7**.
- Total starters: 15 → **17**.

### 2018 or 2019 (verify in Forumotion)
- **In-season restructure BANNED.** Same vote also overturned the 2014 "restructure-only-with-extension" rule. Restructures are now offseason-only and standalone-allowed.

### 2019 — Cap-penalty system overhaul (CONFIRMED 2026-05-08 via `services/rulebook/sources/rules/archive/UPS Contract Rules.txt`)

**Effective the 2019 NFL Season** the league replaced the original flat 20% cap-penalty model with the 75% TCV guarantee + monthly earning curve + flat 35% WW model that was in effect through 2026-05-07 (when it was replaced again by the per-week pro-rated rule — see 2026 below).

**Pre-2019 rule (2010 → 2018 NFL season):**
- Penalty = **20% × total salary remaining** (no "earned" concept; penalty was simply 20% of value left).
- TCV < $5K → no penalty (the original buffer-zone rule from 2011).
- This was the only cap-penalty mechanic since the league founded.

**2019+ rule (2019 NFL season → 2026-05-07):**
- 75% TCV guarantee on Non-Waiver contracts.
- Earning curve: 0% before Oct 1, 25% Oct, 50% Nov, 75% Dec, 100% post-rollover.
- WW $5K+ in-season cuts: flat **35% × salary** penalty (separate WW-specific rule, not the 75% formula).
- Multi-year low-TCV rule (TCV < $5K with multiple years remaining): **fixed $1K penalty** if cut with > 1 year remaining.

**Grandfather clause (CONFIRMED 2026-05-08 via Keith):**
- Contracts that were **active at end of 2018 with 2+ years remaining** were "grandfathered" into the OLD 20% flat rule.
- Tagged with `GF` in the MFL `contract_info` field. The GF tag persisted for the contract's life — until the contract was "touched" (extension / restructure / release / natural expiration). Once touched, the contract joined the new system.
- 1-year-remaining contracts at end of 2018 were NOT grandfathered — they were expiring anyway and rolled into the new system on completion.
- Implication for backfill: a player drop in (say) 2020 could fall under EITHER rule depending on whether the contract was a `GF` salary_type at the moment of drop. The cap-penalty calculator must check the contract's `salary_type` flag, not just the drop date.

### 2019 — NO scoring changes (verified)
2018→2019 diff: zero rule changes.

### 2020 — Cosmetic notation only (CONFIRMED via `metadata_rawrules`)
- Yardage notation: `.1/1` → `*.1` (cosmetic — same scoring, different MFL formatting). Affects: 1C, FG, KY, TSY, UY for all positions.
- COVID-IR rule added (later removed in 2022).
- ⚠️ The rulebook archive's "2021 first downs added" claim is **WRONG per MFL data.** First-down scoring (`1C` abbreviation, `1-50 = .2/1`, all positions including QBs) has been in MFL continuously since 2011. The Slack 2021-07-04 vote about "rushing first downs" was likely a **clarification or rule reaffirmation**, not a new addition. (Or the league was tracking only receiving FDs in practice despite the MFL rule including all positions — verify in Slack archive.)

### 2021 — Cosmetic FD rename (CONFIRMED via `metadata_rawrules`)
- **`1C` abbreviation renamed to `FD`** (First Down). Same scoring (0.2 pts per FD), but **range expanded `1-50` → `1-999`** (now correctly handles drives with 50+ first downs, edge case).
- **Waiver runs day swap (2021-08-17 Slack vote, 9-0): Wed/Thu/Sat/Sun → Thu/Fri/Sat/Sun.** Full schedule replacement.
- **SF lead-up year had real cap math:** non-expiring rookie QBs got the new (10/20) extension cost immediately in 2021; expiring rookie QBs got the old (6/12) cost.

### 2022 — Superflex transition (CONCURRENT with rest of league rules going forward)
- **★ QB starter cap 1 → 1-2 (Superflex era begins, ONGOING).** All skill (RB/WR/TE) max +1.
- One-time **QB Keeper Selection event**: owners declared which QBs to keep; non-keepers dropped penalty-free. 2021 2nd-QB rookies (Mond/Mills/Fields/Lawrence) auto-eligible to be kept.
- **3-starting-QB cap** codified with FantasyPros depth-chart enforcement (later eased — see 2025).
- **League dues $125 → $200** (10-2 vote, 2022-02-20).
- **Payout overhaul** (2022-08-12): Champion $600→$900, 2nd $290→$450, 3rd $100→$150, Division winners $25→$50, Weekly HS $20→$30, new Toilet Bowl payouts.
- COVID-IR/Taxi rule removed (2022-08-12).
- **Trade window opened immediately after season end** (used to lock until March rollover).
- Tag Auction + ERA switched to FA-Auction-style proxy bid with 3-day window (2022-05-03). ❓Need: what was format BEFORE this change? When did ERA itself start? Are tag results captured anywhere?

### 2023 — NO scoring changes (verified)
2022→2023 diff: zero rule changes.

### 2024 — NO scoring changes (verified)
2023→2024 diff: zero rule changes.

### 2025 — TE Premium + ST/D TD range uniformity + cleanup year (CONFIRMED via `metadata_rawrules`, 87 rule changes)
- **★ TE Premium: TE got separate `CC = 0-99 = *1.5`** (1.5 PPR for TE only). Other positions kept `CC=*1` (note: range also tightened from 0-100 → 0-99 for cosmetic precision). Voted 2024 per Keith (verify).
- **ST/D TD ranges UNIFIED across all positions** (the league-wide uniformity change Keith mentioned):
  - `DR` (defensive return TD?): `85-110=7` → `50-110=7`
  - `IR` (interception return TD): `85-110=7` → `50-110=7`
  - `KO` (kickoff return TD): `91-110=7` → `50-110=7`
  - `PR` (punt return TD): `60-110=7` → `50-110=7`
  - All ST/D TD ranges normalized to `50-110=7`.
- **New rules added 2025:**
  - `D2` (defensive 2-point conversion): `0-10=*2` for all positions
  - `FR` (fumble recovery TD): `50-110=7` for all positions
  - `MF` (missed FG?): `50-110=7` for all positions
- **MYM cap raised 3 → 4.**
- **ERA opening bid: $1K floor** (was prior-yr-salary + $1K).
- **1st-Round Rookie Option** introduced (4th option year, salary = original Y3 + $5K; first exercise window 2027 for the 2025 R1 class). Voted 2024, implemented 2025.
- **Round 6 PK/PN eligibility REVERSED** — back to strict IDP-only. **History (Keith v13):** Round 6 was always IDP-intent from inception. One year an owner selected a PK/PN; league voted draft-night to allow. PK/PN informally allowed until 2025 reversion. ❓Year of the draft-night vote — review auction data for first PK/PN selection in Round 6.
- **3-starting-QB cap eased**: 3 starters at start of season; mid-season changes no longer enforced.
- **Bench-player tiebreaker removed**: ties stand in regular season; playoffs higher seed advances (manual).

### 2026 — Active changes
- **Division realignment year** (next: 2029, 2032). Cadence is every 3 years.
  - **(UPDATED 2026-05-08)** Realignment now uses **captain-based snake draft** (see "Division Realignment" section near the end of this doc for the full rule). Top 4 teams by All-Play % become Division Captains; Captains snake-draft their division mates in 2 rounds.
  - **For the 2026 realignment specifically:** Captain seeding uses **full historical All-Play %** (the standard 3-year rolling window doesn't apply for the first cycle under the new rule).
  - **Going forward (2029, 2032, …):** Captain seeding uses **rolling 3-year All-Play %** of the immediately prior 3 seasons.
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

## E. STILL-OPEN for Section 4 (post-v15)

✅ **CONFIRMED v15** via MFL `metadata_rawrules` year-over-year diff (PRIMARY SOURCE — every scoring change 2011-2025 is now in the doc with exact old → new values):
- 2012 punter overhaul: PNY (`0-999=.1/2`) entirely REMOVED
- 2012 tackles added: TKL (`0-25=*1`) for all positions
- 2012 return-yardage: KY (`.025/yd`), UY (`.05/yd`)
- 2012 PI doubled: `*2 → *4`
- 2012 ANY/big-game bonus added (60-100=5)
- 2016 FG per-yard: `60-99=8` → `0-99=*.1`
- 2016 missed FG range: `30-99=0` → `45-99=0`
- **RB PPR transitions: 1.0 (2010) → 0.75 (2011) → 0.80 (2018)** — confirmed via `metadata_rawrules` 2010, 2011, 2018 snapshots
- 2018 IDP tackles boosted: AS, TK, TKL, FC, IC, PD all up
- 2020 yardage notation cosmetic
- 2021 1C → FD rename + range expansion (FD scoring has been in continuously since 2011)
- 2022 FD notation cosmetic
- 2025 TE Premium (`TE CC=*1.5`)
- 2025 ST/D TD range uniformity (all → 50-110)
- 2025 added: D2 (def 2pt), FR (fumble recovery TD), MF (missed FG?)
- 2013, 2014, 2017, 2019, 2023, 2024: ZERO scoring rule changes (verified via diff)

✅ **CONFIRMED v14** via Forumotion:
- 2014-02-11 votes (4 simultaneous): restructure-with-extension (7-5), 9-player taxi tiered (7-5), cap-free taxi cuts (passed), 6×3-yr cap reaffirmed (tied)
- 2015 = first year of 2-RB minimum (proposed Feb 2014)
- 2016 FG per-yard scoring proposed 2015-12-01 Comp Committee agenda

⏳ **Still open** — none of these are scoring-related (already closed via metadata_rawrules):
1. **2012 dispersal draft results** — Forumotion `f11-new-owner-s-distribution-draft` not yet pulled.
2. **First Downs expansion narrative** — MFL data shows 1C/FD has been in continuously for ALL positions since 2011. The 2021 Slack vote about "rushing FDs" is contradicted by the data — was likely a clarification/reaffirmation, not new addition. Verify in Slack archive.
3. **In-season restructure ban year** (post-2017, slack/discord).
4. **"Restructure-only-with-extension" overturn year** (same as #3).
5. **6th-round PK/PN draft-night vote year** — review historical auction data for first PK/PN selection in Round 6.
6. **Tag Auction + ERA pre-2022 format** — what was the format before 2022-05-03 proxy-bid switch?
7. **Original ERA start year** — when did Expired Rookie Auction format itself start?
8. **TE Premium vote year** — Keith says 2024; verify in Discord.

Source notes:
- **MFL `metadata_rawrules`** (in `mfl_database.db`) — PRIMARY SOURCE for all scoring rule changes 2011-2025. Diff via `python3 /tmp/diff_rules.py`. Re-runnable; pulls full per-position scoring snapshots from `TYPE=rules` for every season.
- **Forumotion** — best for 2011-2017 rule discussions/votes. Last rule threads November 2017.
- **Slack** — May 2021 - Sep 2022 actual coverage (export window misleading).
- **Discord** — 2022+ rule discussions.

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
- **Enforcement model (Keith, 2026-05-16 review session):** the **$300K ceiling is enforced natively by MFL** at write-time — submissions that would push a team over cap fail at the MFL boundary. **UPS provides advisory warnings** on preview surfaces (Trade War Room, FA Auction tools, roster workbench cap chips) when a planned action would push a team over cap. **No UPS worker-side hard block** — the worker trusts the MFL ceiling enforcement.

### A2. Cap floor = $260,000

- **Soft floor.** Must be hit by **end of the FA Auction window OR by the Roster Contract Deadline (September contract deadline), whichever comes later** (Keith, 2026-05-16 review session). Touch-and-go during the auction also counts — once the floor is touched at any timestamp in the window, compliance is satisfied.
- Failing both = out of compliance → cap penalty.
- **Touch-and-go example (corrected v10):** team hits $270K mid-auction, then a $40K player goes IR. **IR refund = 50% × $40K = $20K**, so committed salary drops to **$250K** (still < $260K, but the team had touched $260K earlier so they're compliant for floor purposes).
- **Front-loading contracts OR restructuring** is the explicit tool to satisfy the floor when an owner is light on commitments.
- **Enforcement:** no UPS worker-side hard block today. Compliance is checked at end of the window via the cap-penalty audit path. Auction-tooling enhancements that would surface a floor warning earlier are parked (see Auction Room scope in `CROSS_CODEBASE_ALIGNMENT.md §4.1`).

### A3. Future direction (parked — Open Items A1.4 + A2.4)
Whether to keep, eliminate, or reform the auction roster lock + cap floor mechanic — Keith is reviewing.

---

## B. Earning curve — CANONICAL (UPDATED 2026-05-08 — true pro-rated by NFL week)

### B1. The rule (effective 2026-05-08, replaces calendar-month buckets)

A contract's salary "earns" **per completed NFL regular-season week**. The denominator is the player's **eligible weeks remaining at the time of acquisition** — i.e., the number of regular-season weeks from the player's acquisition through Week 17.

**Earning formula:**

```
Salary Earned (year's actual salary basis)
   = (completed_eligible_weeks / total_eligible_weeks) × year's actual salary
```

| Acquisition path | Total eligible weeks | Notes |
|---|---|---|
| FA Auction + pre-Week-1 pickups (BBID, FCFS, trade) | **17** | Full season available |
| Mid-season pickup in Week W (W ≥ 1) | **18 − W** | Weeks W through 17, inclusive |
| Pre-rolloover offseason cut | **N/A — 100% earned at rollover** | Prior year is sunk |

**Worked rates:**
- Auction acquisition, dropped after **Week 9** completes: 9/17 = ~53% of year's actual salary earned.
- WW pickup in **Week 9**, dropped after Week 13 completes (4 weeks active in a 9-week eligible window): 4/9 ≈ 44% earned.
- Auction acquisition, dropped at season end (Week 17 complete): 17/17 = 100%.
- Auction acquisition, dropped before Week 1 (preseason cut): 0/17 = 0%.

**Key clarifications:**
- Earning ticks up at the **end of each completed NFL regular-season week** (Tuesday after Monday Night Football kicks off the next NFL week, or per the league_events week-boundary convention — see Section 3.A and the NFL calendar reference in the Bot Grounding appendix).
- "Active for the week" follows the same definition as the taxi-squad rule: rosters and lineups locked, player appears in weekly results.
- This rule applies **uniformly** to Auction, WW, FCFS, and trade-acquired contracts. The flat 35% WW rule is RETIRED.

### B2. ⚠️ Code follow-up (transition note)

Reporting code that previously used calendar milestones `[Oct 1, Nov 1, Dec 1, season_end]` (and the older buggy `[Sep 30, Oct 31, Nov 30, season_end]`) needs to be repointed to **per-completed-week** anchored to `league_events.nfl_kickoff` for the season. Tracker: this is the canonical rule going forward; legacy code is being updated.

### B3. ✅ Resolved — pro-rated earning (was Open A1.1)

The league voted in May 2026 to adopt true pro-rated earning. The per-game/per-week model **replaces** the calendar-month bucket model both for auction contracts and for WW pickups (the old flat-35% WW rule is retired — same earning math now applies to all acquisition paths, just with a different denominator).

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

2. **"Salary Earned" is based on THE YEAR'S actual salary (not AAV).** Apply the per-week pro-rated curve to the year's actual dollar amount (UPDATED 2026-05-08 — see Section 6.B):
   - Front-loaded $40K Y1, cut after Week 5 (5 completed weeks of 17 eligible): 5/17 × **$40K** = $11,765 earned (NOT 5/17 × $30K AAV).
   - Same contract Y2 = $30K, cut after Week 5 of Y2: 5/17 × $30K = $8,824 earned.
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

### C3. WW $5K+ in-season special case (UPDATED 2026-05-08 — RETIRED, replaced by uniform per-week pro-rated)

The old flat 35% WW penalty rule has been **retired** as of the 2026-05-08 salary-depreciation rule. WW pickups with salary > $4K now use **the same 75% guarantee + per-week pro-rated earning** as auction contracts. The only difference between WW and auction is the eligible-weeks denominator (auction = 17, WW pickup in Week W = 18 − W).

**Penalty formula (now uniform across all acquisition paths):**
```
Penalty = (Salary × 75%) − Salary Earned
where Salary Earned = (completed_weeks_active / total_eligible_weeks) × salary
```

**WW $4K-and-under stays cap-free** (preserved by the 2026-05-08 rule — see Bot Grounding appendix).

**Worked WW examples under the new rule** (assumes player picked up Week W and dropped after Week W+N completes; eligible_weeks = 18 − W):

| Pickup | Drop after | Active weeks | Eligible weeks | Earned | Penalty |
|---|---|---|---|---|---|
| WW $25K, Week 5 pickup | Week 9 (4 weeks active) | 4 | 13 | (4/13) × $25K = $7.69K | ($25K × 75%) − $7.69K = **$11.06K** |
| WW $25K, Week 9 pickup | Week 12 (3 weeks active) | 3 | 9 | (3/9) × $25K = $8.33K | ($25K × 75%) − $8.33K = **$10.42K** |
| WW $50K, Week 1 pickup | Week 8 (7 weeks active) | 7 | 17 | (7/17) × $50K = $20.59K | ($50K × 75%) − $20.59K = **$16.91K** |
| WW any $, post-season cut | end of Week 17 | full | full | 100% × salary | $0 (full earning achieved) |
| WW under $4K, any time | any | n/a | n/a | n/a | **$0 (cap-free, preserved)** |

**Note for code maintainers:** any callers that hard-coded the old `35% × salary` formula need to be updated to the per-week pro-rated math. Tracker: included in the "Per-game prorated earning calculator" follow-up (Section 7.A4 #17).

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

**C4.7: WW $25K pickup picked up Oct 5, dropped Nov 5 (in-season WW — UPDATED 2026-05-08, per-week pro-rated)**
- Pickup week ≈ Week 5 (early Oct 2026; Week 1 Thursday is Sept 10). Eligible weeks = 18 − 5 = **13** (Weeks 5–17).
- Drop ~Nov 5 ≈ end of Week 8 / start of Week 9. Active weeks completed = **4** (Weeks 5, 6, 7, 8).
- Earned = (4 / 13) × $25K = **$7,692**.
- Penalty = (75% × $25K) − $7,692 = $18,750 − $7,692 = **$11,058**.
- Hits **following season cap** (in-season cut bucket).
- *Old rule (retired 2026-05-08): flat 35% × $25K = $8.75K. Retained here for audit-trail clarity; new rule above is canonical.*

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
| ❓ Late dues fine | − | $3K per week late — **legacy — pending overhaul discussion** (Keith, 2026-05-16). Cash-vs-cap treatment undecided pending broader framework overhaul. Do NOT implement either model until Keith reopens the discussion. |
| ❓ Missed nomination fine | − | Auction nomination missed (escalates from $3K) — **legacy — pending overhaul discussion** (Keith, 2026-05-16), same as Late dues fine. |

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
- **Enforcement (UPS-owned — Keith, 2026-05-16 review session):** this is NOT an MFL-enforced rule. UPS owns the enforcement. **The Trade War Room enforces it client-side today:**
  - Max calculation: `site/trades/trade_workbench.js:4220` — `getTradeSalaryMaxK(teamId)` returns `floor(selectedNonTaxiSalary / 2000)` (i.e., half the sum of selected non-taxi traded-away player salaries, in $K).
  - Validation: `site/trades/trade_workbench.js:5237-5238` — flags "Left/Right traded salary exceeds max" if either side's cap-money slider exceeds its computed max.
  - **Worker-side backstop is not yet implemented.** Future trade-submit endpoint should re-validate using the same formula to harden against client bypass.

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

1. ~~**Per-game prorated earning**~~ — **RESOLVED 2026-05-08** (Hall round May 2026, 7-0-0). See Section 6.B.
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

1. ~~**Earning checkpoints — switch to per-game prorated?**~~ — **RESOLVED 2026-05-08.** League voted YES (7-0-0) to true pro-rated per-week earning. Replaces the calendar Oct/Nov/Dec buckets and the flat 35% WW rule. See Section 6.B.
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
17. **Per-game prorated earning calculator** — A1 #1 was approved 2026-05-08 (true pro-rated). Calculator now needs to be built; consumes `league_events.nfl_kickoff` to determine completed weeks per acquisition path.
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

---

## Appendix — Divisional Co-tenancy History (2011-2025)

Source: `mfl_database.db.franchises`. Coverage: 2011-2025 (15 seasons across 5 realignment cycles: 2011–2013, 2014–2016, 2017–2019, 2020–2022, 2023–2025). Realignment cadence is every 3 years; next realignment 2026.

This appendix is grounding for the AI explainer when owners ask questions like *"how often have I been in the same division as X?"* — names + numbers are intentionally included here because the bot needs them to answer specifically.

### Aggregate (current 12 owners)

- **66** possible pairs among current owners
- **29** pairs have shared a division at least once
- **37** pairs have NEVER shared a division
- Pairs with the most seasons-of-overlap that have STILL never been paired: see the body of this appendix.

### Realignment cycles (for context)

Every 3 years the league realigns divisions. Owners only get the chance to be paired in a new way at each realignment boundary.

| Cycle | Seasons |
|-------|---------|
| 2011–2013 | 2011, 2012, 2013 |
| 2014–2016 | 2014, 2015, 2016 |
| 2017–2019 | 2017, 2018, 2019 |
| 2020–2022 | 2020, 2021, 2022 |
| 2023–2025 | 2023, 2024, 2025 |
| 2026–2028 | 2026, 2027, 2028 ← *first cycle under captain-draft rule (UPDATED 2026-05-08)* |
| 2029–2031 | 2029, 2030, 2031 |
| 2032–2034 | 2032, 2033, 2034 |

### Realignment mechanic — Captain-based snake draft (UPDATED 2026-05-08)

**Effective the 2026 realignment** (Hall round May 2026, passed 7-0-0). Replaces the prior formula-based assignment that grouped teams by 3-year All-Play %.

**Rule:**
- **Top 4 teams by All-Play %** become **Division Captains**.
- **Snake draft, 2 rounds:**
  - Round 1: Captains pick in order 1 → 2 → 3 → 4
  - Round 2: Captains pick in reverse, 4 → 3 → 2 → 1
- After both rounds, each Captain has 3 division mates (themselves + 2 picks = 3 per division). 4 Captains × 3 = 12 teams aligned across 4 divisions.
- Divisions are **no longer formula-generated**. The snake draft IS the realignment.

**When it happens:**
- The snake draft happens **at the Rookie Draft** every 3 years (when everyone is present in person/Discord).
- Per Keith's framing: yes, that means the last-picked dodgeball kid (the #1 pick — i.e., the team picked LAST, going into the worst Captain's division) gets ridiculed in person. Adds an extra layer of league entertainment.

**Captain seeding (which All-Play % is used to pick the Captains):**
- **2026 (this realignment, first cycle under the new rule):** **full historical All-Play %** across all seasons each owner has played. Provides a deeper data foundation for the inaugural Captain pool.
- **Going forward (2029, 2032, …):** **rolling 3-year All-Play %** of the immediately prior cycle (e.g., 2029 uses 2026–2028 AP%; 2032 uses 2029–2031 AP%).

**Captain eligibility:**
- An owner must have been in the league the **full 3-year prior window** to be eligible to be a Captain.
- For the 2026 realignment specifically (where seeding uses *full historical* AP%), eligibility is similarly full-historical — owners with insufficient tenure (e.g., joined mid-cycle) are not Captain-eligible but still get drafted into a division.

**Why this rule was adopted (from the proposal):**
- The prior formula-based realignment produced repeat clustering — same teams kept landing in the same divisions cycle after cycle.
- Of 66 possible current-owner pairings, only 29 have ever shared a division — **37 pairs have never been divisional opponents-of-record across the 5 realignment cycles since 2011**.
- Some pairs have shared 15 seasons of league time without ever once landing in the same division.
- Captain draft creates more variety in pairings AND moves the realignment moment from "spreadsheet output" to "live in-person event," which adds an entertainment layer.

**Bot guidance for "when's the next realignment?" queries:**
- Next: 2029 (post-2026/2027/2028 cycle), with seeding from rolling 3-year AP% across those seasons.
- Captain-draft mechanic is the same every 3 years going forward.

### Per-owner: division mates ever, mates still in league

| Owner | Cycles in league | Distinct mates ever | Mates still in league today | Current owners NEVER paired with |
|-------|-----------------:|--------------------:|----------------------------:|---------------------------------:|
| Bear Dunn | 5 | 10 | 7 | 4 |
| Brian Cross | 1 | 2 | 2 | 9 |
| Brian Cutting | 5 | 9 | 6 | 5 |
| Chris Klingenberg | 5 | 9 | 5 | 6 |
| Derrick Whitman | 4 | 9 | 7 | 4 |
| Eric Mannila | 5 | 5 | 5 | 6 |
| Eric Martel | 1 | 3 | 2 | 9 |
| Josh Martel | 5 | 8 | 6 | 5 |
| Keith Creelman | 5 | 5 | 5 | 6 |
| Matt Gerardi | 3 | 5 | 3 | 8 |
| Ryan Bousquet | 5 | 9 | 4 | 7 |
| Shawn Blake | 5 | 7 | 6 | 5 |

### Per-owner detail

For each current owner: their cycle-by-cycle division-mates among current owners, plus the current owners they've never shared a division with.

#### Bear Dunn
- **Active:** 2011-2025 (15 seasons, 5 cycles: 2011–2013, 2014–2016, 2017–2019, 2020–2022, 2023–2025)
- **Current owners paired with (years · cycles · seasons):**
    - Eric Mannila: **9** seasons across 3 cycle(s) — 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025
    - Ryan Bousquet: **6** seasons across 2 cycle(s) — 2014, 2015, 2016, 2023, 2024, 2025
    - Brian Cutting: **3** seasons across 1 cycle(s) — 2020, 2021, 2022
    - Chris Klingenberg: **3** seasons across 1 cycle(s) — 2011, 2012, 2013
    - Josh Martel: **3** seasons across 1 cycle(s) — 2014, 2015, 2016
    - Keith Creelman: **3** seasons across 1 cycle(s) — 2017, 2018, 2019
    - Derrick Whitman: **2** seasons across 1 cycle(s) — 2012, 2013
- **Current owners NEVER paired with:** Brian Cross, Eric Martel, Matt Gerardi, Shawn Blake

#### Brian Cross
- **Active:** 2025-2025 (1 seasons, 1 cycles: 2023–2025)
- **Current owners paired with (years · cycles · seasons):**
    - Derrick Whitman: **1** seasons across 1 cycle(s) — 2025
    - Eric Martel: **1** seasons across 1 cycle(s) — 2025
- **Current owners NEVER paired with:** Bear Dunn, Brian Cutting, Chris Klingenberg, Eric Mannila, Josh Martel, Keith Creelman, Matt Gerardi, Ryan Bousquet, Shawn Blake

#### Brian Cutting
- **Active:** 2011-2025 (15 seasons, 5 cycles: 2011–2013, 2014–2016, 2017–2019, 2020–2022, 2023–2025)
- **Current owners paired with (years · cycles · seasons):**
    - Eric Mannila: **6** seasons across 2 cycle(s) — 2014, 2015, 2016, 2020, 2021, 2022
    - Ryan Bousquet: **6** seasons across 2 cycle(s) — 2011, 2012, 2013, 2017, 2018, 2019
    - Josh Martel: **5** seasons across 2 cycle(s) — 2012, 2013, 2023, 2024, 2025
    - Bear Dunn: **3** seasons across 1 cycle(s) — 2020, 2021, 2022
    - Matt Gerardi: **3** seasons across 1 cycle(s) — 2023, 2024, 2025
    - Shawn Blake: **3** seasons across 1 cycle(s) — 2014, 2015, 2016
- **Current owners NEVER paired with:** Brian Cross, Chris Klingenberg, Derrick Whitman, Eric Martel, Keith Creelman

#### Chris Klingenberg
- **Active:** 2011-2025 (15 seasons, 5 cycles: 2011–2013, 2014–2016, 2017–2019, 2020–2022, 2023–2025)
- **Current owners paired with (years · cycles · seasons):**
    - Keith Creelman: **9** seasons across 3 cycle(s) — 2014, 2015, 2016, 2020, 2021, 2022, 2023, 2024, 2025
    - Shawn Blake: **6** seasons across 2 cycle(s) — 2020, 2021, 2022, 2023, 2024, 2025
    - Derrick Whitman: **5** seasons across 2 cycle(s) — 2012, 2013, 2014, 2015, 2016
    - Bear Dunn: **3** seasons across 1 cycle(s) — 2011, 2012, 2013
    - Matt Gerardi: **3** seasons across 1 cycle(s) — 2017, 2018, 2019
- **Current owners NEVER paired with:** Brian Cross, Brian Cutting, Eric Mannila, Eric Martel, Josh Martel, Ryan Bousquet

#### Derrick Whitman
- **Active:** 2012-2025 (9 seasons, 4 cycles: 2011–2013, 2014–2016, 2017–2019, 2023–2025)
- **Current owners paired with (years · cycles · seasons):**
    - Chris Klingenberg: **5** seasons across 2 cycle(s) — 2012, 2013, 2014, 2015, 2016
    - Eric Martel: **3** seasons across 1 cycle(s) — 2023, 2024, 2025
    - Keith Creelman: **3** seasons across 1 cycle(s) — 2014, 2015, 2016
    - Bear Dunn: **2** seasons across 1 cycle(s) — 2012, 2013
    - Brian Cross: **1** seasons across 1 cycle(s) — 2025
    - Josh Martel: **1** seasons across 1 cycle(s) — 2017
    - Shawn Blake: **1** seasons across 1 cycle(s) — 2017
- **Current owners NEVER paired with:** Brian Cutting, Eric Mannila, Matt Gerardi, Ryan Bousquet

#### Eric Mannila
- **Active:** 2011-2025 (15 seasons, 5 cycles: 2011–2013, 2014–2016, 2017–2019, 2020–2022, 2023–2025)
- **Current owners paired with (years · cycles · seasons):**
    - Bear Dunn: **9** seasons across 3 cycle(s) — 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025
    - Brian Cutting: **6** seasons across 2 cycle(s) — 2014, 2015, 2016, 2020, 2021, 2022
    - Keith Creelman: **6** seasons across 2 cycle(s) — 2011, 2012, 2013, 2017, 2018, 2019
    - Shawn Blake: **6** seasons across 2 cycle(s) — 2011, 2012, 2013, 2014, 2015, 2016
    - Ryan Bousquet: **3** seasons across 1 cycle(s) — 2023, 2024, 2025
- **Current owners NEVER paired with:** Brian Cross, Chris Klingenberg, Derrick Whitman, Eric Martel, Josh Martel, Matt Gerardi

#### Eric Martel
- **Active:** 2023-2025 (3 seasons, 1 cycles: 2023–2025)
- **Current owners paired with (years · cycles · seasons):**
    - Derrick Whitman: **3** seasons across 1 cycle(s) — 2023, 2024, 2025
    - Brian Cross: **1** seasons across 1 cycle(s) — 2025
- **Current owners NEVER paired with:** Bear Dunn, Brian Cutting, Chris Klingenberg, Eric Mannila, Josh Martel, Keith Creelman, Matt Gerardi, Ryan Bousquet, Shawn Blake

#### Josh Martel
- **Active:** 2012-2025 (14 seasons, 5 cycles: 2011–2013, 2014–2016, 2017–2019, 2020–2022, 2023–2025)
- **Current owners paired with (years · cycles · seasons):**
    - Matt Gerardi: **6** seasons across 2 cycle(s) — 2020, 2021, 2022, 2023, 2024, 2025
    - Brian Cutting: **5** seasons across 2 cycle(s) — 2012, 2013, 2023, 2024, 2025
    - Ryan Bousquet: **5** seasons across 2 cycle(s) — 2012, 2013, 2014, 2015, 2016
    - Bear Dunn: **3** seasons across 1 cycle(s) — 2014, 2015, 2016
    - Shawn Blake: **3** seasons across 1 cycle(s) — 2017, 2018, 2019
    - Derrick Whitman: **1** seasons across 1 cycle(s) — 2017
- **Current owners NEVER paired with:** Brian Cross, Chris Klingenberg, Eric Mannila, Eric Martel, Keith Creelman

#### Keith Creelman
- **Active:** 2011-2025 (15 seasons, 5 cycles: 2011–2013, 2014–2016, 2017–2019, 2020–2022, 2023–2025)
- **Current owners paired with (years · cycles · seasons):**
    - Chris Klingenberg: **9** seasons across 3 cycle(s) — 2014, 2015, 2016, 2020, 2021, 2022, 2023, 2024, 2025
    - Shawn Blake: **9** seasons across 3 cycle(s) — 2011, 2012, 2013, 2020, 2021, 2022, 2023, 2024, 2025
    - Eric Mannila: **6** seasons across 2 cycle(s) — 2011, 2012, 2013, 2017, 2018, 2019
    - Bear Dunn: **3** seasons across 1 cycle(s) — 2017, 2018, 2019
    - Derrick Whitman: **3** seasons across 1 cycle(s) — 2014, 2015, 2016
- **Current owners NEVER paired with:** Brian Cross, Brian Cutting, Eric Martel, Josh Martel, Matt Gerardi, Ryan Bousquet

#### Matt Gerardi
- **Active:** 2017-2025 (9 seasons, 3 cycles: 2017–2019, 2020–2022, 2023–2025)
- **Current owners paired with (years · cycles · seasons):**
    - Josh Martel: **6** seasons across 2 cycle(s) — 2020, 2021, 2022, 2023, 2024, 2025
    - Brian Cutting: **3** seasons across 1 cycle(s) — 2023, 2024, 2025
    - Chris Klingenberg: **3** seasons across 1 cycle(s) — 2017, 2018, 2019
- **Current owners NEVER paired with:** Bear Dunn, Brian Cross, Derrick Whitman, Eric Mannila, Eric Martel, Keith Creelman, Ryan Bousquet, Shawn Blake

#### Ryan Bousquet
- **Active:** 2011-2025 (15 seasons, 5 cycles: 2011–2013, 2014–2016, 2017–2019, 2020–2022, 2023–2025)
- **Current owners paired with (years · cycles · seasons):**
    - Bear Dunn: **6** seasons across 2 cycle(s) — 2014, 2015, 2016, 2023, 2024, 2025
    - Brian Cutting: **6** seasons across 2 cycle(s) — 2011, 2012, 2013, 2017, 2018, 2019
    - Josh Martel: **5** seasons across 2 cycle(s) — 2012, 2013, 2014, 2015, 2016
    - Eric Mannila: **3** seasons across 1 cycle(s) — 2023, 2024, 2025
- **Current owners NEVER paired with:** Brian Cross, Chris Klingenberg, Derrick Whitman, Eric Martel, Keith Creelman, Matt Gerardi, Shawn Blake

#### Shawn Blake
- **Active:** 2011-2025 (15 seasons, 5 cycles: 2011–2013, 2014–2016, 2017–2019, 2020–2022, 2023–2025)
- **Current owners paired with (years · cycles · seasons):**
    - Keith Creelman: **9** seasons across 3 cycle(s) — 2011, 2012, 2013, 2020, 2021, 2022, 2023, 2024, 2025
    - Chris Klingenberg: **6** seasons across 2 cycle(s) — 2020, 2021, 2022, 2023, 2024, 2025
    - Eric Mannila: **6** seasons across 2 cycle(s) — 2011, 2012, 2013, 2014, 2015, 2016
    - Brian Cutting: **3** seasons across 1 cycle(s) — 2014, 2015, 2016
    - Josh Martel: **3** seasons across 1 cycle(s) — 2017, 2018, 2019
    - Derrick Whitman: **1** seasons across 1 cycle(s) — 2017
- **Current owners NEVER paired with:** Bear Dunn, Brian Cross, Eric Martel, Matt Gerardi, Ryan Bousquet

### Historical 3-Year Cycle AP% Leaders (informal, never officially recognized)

Aggregate All-Play win% across each 3-year cycle, by owner. **Never paid out** — informal record only. Included here so the bot can answer 'who would have won the Dynasty Pot in cycle X?' if Dynasty Pot vote passes.

| Cycle | Leader | AP record | AP% | Runner-up | Runner-up AP% |
|-------|--------|-----------|----:|-----------|---------------:|
| 2011–2013 | **Derrick Whitman** | 237–99 | 70.5% | Jeff LaChapelle | 68.4% |
| 2014–2016 | **Ryan Bousquet** | 367–156 | 70.2% | Derrick Whitman | 67.1% |
| 2017–2019 | **Josh Martel** | 388–138 | 73.8% | Steve Bousquet | 67.1% |
| 2020–2022 | **Steve Bousquet** | 370–177 | 67.6% | Ryan Bousquet | 57.4% |
| 2023–2025 | **Ryan Bousquet** | 364–197 | 64.9% | Eric Martel | 62.9% |

---

## Appendix — Bot Grounding Clarifications (added 2026-05-05)

These are corrections + clarifications fed back from solo-test of the AI explainer. Bot must treat these as authoritative.

### Tag mechanics — applying a tag vs locking it

- **Applying a tag does NOT immediately "lock" the player as a tagged player.** The tag is provisional until the deadline.
- The player **auto-locks on tag deadline day** (current behavior; no early lock-in today).
- Per the proposed early-lock-in rule (May 2026 round): a "Lock in" button will appear in the contract command center once a tag is applied. Pressing it commits the tag early and makes the tag asset tradeable. Until either deadline-auto-lock or owner-clicked-lock, the tag is reversible.

### Cap-penalty-free pickups (preserved by 2026-05-08 salary-depreciation rule)

- **Players picked up via Waiver Wire (WW) with salary ≤ $4K are cap-penalty-free if dropped.** No cap penalty applies regardless of when in the season they're dropped.
- This carve-out is preserved under the new true-pro-rated earning model (effective 2026-05-08).
- **Boundary phrasing (Keith, 2026-05-16 review session):** the rule is **"WW salary ≤ $4K is cap-free"**. The worker implementation in `worker/src/lib/cap_penalty.js:49-54` uses `< $5K` — these are equivalent for the integer-dollar amounts UPS uses ($1K bid increments). Either phrasing is correct; prefer "≤ $4K" in owner-facing narration and `< $5K` in code reviews.

### Multi-year low-TCV penalty (preserved by 2026-05-08 salary-depreciation rule)

- **Multi-year contracts where TCV < $5K carry a fixed $1K penalty if dropped with more than 1 year remaining.**
- This rule is independent of the per-week earning curve.
- Continues unchanged under the new pro-rated model.

### Penalty rounding rule (current rule)

- **All cap penalties are rounded based on the SUM of penalties accrued, not per-penalty rounding.**
- Rounding is applied to the cumulative total, not to each individual drop penalty in isolation.

### Taxi squad — temporary call-up "active week" definition (effective 2026-05-08)

This clarifies the rule in **B2 / T2.4** for the bot.
- **"Active for the week"** = the player was on the active roster (OR on IR — same effect for this purpose) at the time rosters and lineups locked for that NFL week, and appears in that week's weekly results.
- Active = 1 toward the 3-week call-up budget; not active = 0.
- Putting a called-up player on IR does NOT avoid burning the week — it still counts. The owner's only way to not burn the week is to demote back to taxi BEFORE rosters lock.
- Counting is per-player and cumulative across seasons (consecutive or non-consecutive both count). On the 4th activation the call-up becomes permanent.

### NFL calendar reference (for the bot — derive, don't guess)

The NFL regular season has a fixed structure: 18 weeks (regular season) starting on the first Thursday after Labor Day. **Bot derives week-from-date and date-from-week from the anchor table below — never guesses.**

**Week 1 Thursday (kickoff) by season:**

| Season | Week 1 Thursday |
|--------|-----------------|
| 2023   | Sept 7  |
| 2024   | Sept 5  |
| 2025   | Sept 4  |
| 2026   | Sept 10 |
| 2027   | Sept 9  |

**Derivation rule:**
- Each NFL "week" runs Thursday through the following Wednesday (TNF kickoff to TNF kickoff).
- For a calendar date `D` in season `Y`: `week_number = floor((D − week1_thursday(Y)) / 7) + 1`.
- Worked example: **Nov 17, 2026** — Week 1 Thursday is Sept 10, 2026. Days elapsed = 68. floor(68/7) = 9. Week = 9 + 1 = **Week 10**. Nov 17 is a **Tuesday** (Week 1 Thursday + 68 days; 68 mod 7 = 5; Thursday + 5 = Tuesday).
- Thanksgiving = 4th Thursday of November. For 2026, Nov 26 = Thanksgiving = inside **Week 12** (verify with the formula).

**Bot guidance:**
- When asked "what week is [date]?" or "is [date] a Thursday?" — do the math from the anchor above. Show your work. Don't say "I don't have the calendar."
- If asked about a season not in the table, say so plainly and ask the owner to confirm Week 1 Thursday for that year.
- Weekday from any known Thursday: `weekday_offset = (D − reference_thursday) mod 7` where 0=Thu, 1=Fri, 2=Sat, 3=Sun, 4=Mon, 5=Tue, 6=Wed.

### Vote-change grace window after auto-close (Hall bot rule)

- When an item auto-closes (YES count hits the pass threshold, OR NO makes YES mathematically unreachable), owners can still change their vote for **6 hours** after the close timestamp.
- After the 6-hour grace window, the item is **locked** — further vote changes are rejected with a "this item is locked" message.
- Final tally is recomputed at `/rules close` from the latest active votes (not frozen at auto-close moment), so changes made within the grace window do count.

### Pot splitting — origin and current rule

- "Splitting the pot" = when two teams meeting in a championship pre-agree to split prize money regardless of outcome.
- **Historical context** (informal lore): Blake & Ryan's pre-game split-the-pot agreement before a Hawktuah Bowl (~2023) is the inflection point that pushed the league to codify a no-voluntary-split rule.
- **Codified going forward:** prize splitting is only recognized in the event of a tie. Voluntary splits outside a tie are not recognized by the league.

---

## Appendix — League Rules Migration (added 2026-05-05, updated 2026-05-08) 🆕

**Status:** Phases 1–4 partially complete (see checklist below). Goal: this file (`docs/league_context_v1.md`) is the **single canonical source**; everything else either (a) gets archived as historical artifact, (b) gets folded into this file, or (c) gets retired entirely.

### Inventory of rule documents currently in repo (updated 2026-05-08)

| Path | Format | Status | Migration disposition |
|------|--------|--------|------------------------|
| `docs/league_context_v1.md` | MD | **CANONICAL** | Keep. Source of truth. |
| `docs/league_context_changelog.md` | MD | **CANONICAL — history** | Keep. Append-only audit trail. |
| `services/rulebook/data/rules.json` | JSON | **ARCHIVED 2026-05-08** | Frozen at v2026.5. `_archived_note` header added. NOT regenerated, NOT bot-grounded, NOT authoritative. Kept as historical reference only. |
| `services/rulebook/sources/rules/archive/current_rulebook_struct.json` | JSON | **ARCHIVED 2026-05-08** | `_archived_note` header added. Kept as historical reference. |
| `services/rulebook/tools/build_rulebook_json.py` | Python | **DEPRECATED 2026-05-08** | Header comment marks DO NOT RUN — its source HTML was deleted. Kept for historical reference. |
| `docs/ups_v2/V2_GOVERNED/rules/claude_canonical_rules.md` | MD | LEGACY ARTIFACT | Reconcile any unique content into context file (next pass). Then archive. |
| `docs/ups_v2/V2_GOVERNED/rules/ups_v2_rulebook_v4.html` | HTML | LEGACY ARTIFACT | Slated for deletion in next cleanup pass. |
| `services/rulebook/web/rulebook_embed.html` | HTML | EMBED widget | Verify consumers (rules.json?). If yes, retire the widget. |
| `docs/rulebook_inbox.md` | MD | NOT-A-LEAGUE-RULE | Keep. Engineering notes (Claude operating rules), different concern. |
| `services/rulebook/sources/rules/archive/league_divisions.csv` | CSV | DATA SOURCE | Keep as archived input. MFL DB `franchises` table is the live equivalent. |

### Files DELETED 2026-05-08 (per Keith — "get rid of html")

| Path | Why deleted |
|------|-------------|
| `services/rulebook/sources/rules/UPS_Master_Rulebook.html` | Source for the now-archived `rules.json`. Out-of-date with current rules (taxi mechanics, salary depreciation, realignment). |
| `docs/ups_v2/V2_GOVERNED/rules/ups_v2_fantasy_rulebook_browser_comprehensive_draft.html` | Draft preview, not deployed. Out-of-date. |
| `site/rulebook/ups_v2_rulebook_mobile_preview.html` | Mobile preview. Was redirected to from `site/rulebook/index.html`. |
| `site/rulebook/index.html` | The page that used to redirect to the mobile preview. Deleted along with the rest of `site/rulebook/` per Keith — the directory was never actually trafficked by owners. |

### Migration plan (work-in-progress checklist)

**Phase 1 — Stop the bleeding (DONE 2026-05-04):**
- [x] Remove `rules.json` and `claude_canonical_rules.md` from Hall bot grounding
- [x] Hall bot uses **only** `league_context_v1.md`
- [x] Document the rule that this file is canonical (this appendix)

**Phase 2 — Audit downstream consumers (DONE 2026-05-08):**
- [x] Find every reader of `services/rulebook/data/rules.json` (grep `rules.json` across repo) — only `build_rulebook_json.py` (the generator) and the embed widget (TBD whether actively served)
- [x] Find every reader of `claude_canonical_rules.md` — only governance handoff docs reference it
- [x] For each consumer: rules.json is now archive-frozen (no readers depend on it being current); generator script marked DEPRECATED.

**Phase 3 — Reconcile unique content (TO DO):**
- [ ] Diff `claude_canonical_rules.md` against `league_context_v1.md` — what's only in canonical_rules?
- [ ] For each unique item: add to league_context (with status tag 🆕 pending review) and remove from origin file
- [ ] Owner: Keith review for each migrated rule

**Phase 4 — Retire legacy (DONE 2026-05-08 for HTML; data files archived in place):**
- [x] DELETE three HTML rulebook files (per Keith's directive 2026-05-08 — "get rid of html"):
  - `services/rulebook/sources/rules/UPS_Master_Rulebook.html`
  - `docs/ups_v2/V2_GOVERNED/rules/ups_v2_fantasy_rulebook_browser_comprehensive_draft.html`
  - `site/rulebook/ups_v2_rulebook_mobile_preview.html`
- [x] Archive headers added to `services/rulebook/data/rules.json` and `services/rulebook/sources/rules/archive/current_rulebook_struct.json` (frozen, not authoritative)
- [x] `services/rulebook/tools/build_rulebook_json.py` marked DEPRECATED (its source HTML was deleted)
- [x] DELETE the entire `site/rulebook/` directory (Keith confirmed 2026-05-08 the redirect page was never trafficked — no need to keep a "moved" placeholder)
- [ ] Move `claude_canonical_rules.md` to `docs/archive/` (next pass)
- [ ] Decide fate of remaining draft HTML: `ups_v2_rulebook_v4.html`, `services/rulebook/web/rulebook_embed.html` (next pass)

**Phase 5 — Owner-facing public surface (DEFERRED):**
Per Keith 2026-05-08: a future "all rules" public HTML site will be a separate dedicated build. For now, owners consult:
- The Discord bot (`/rules` + the *Questions? 🤖* button on each thread — bot grounds in `league_context_v1.md`)
- `docs/league_context_v1.md` directly on GitHub

### Rule-passage workflow (for bot-driven rules)

When a rule passes via the Hall bot (vote auto-closes + 10-min grace expires + summary thread posts):
1. Bot generates impact analysis in the rules-channel thread (already wired)
2. **Manual step (for now):** Keith reviews the impact analysis + adds the new rule to a "🆕 Recent Rule Changes" section here (status: 🆕 pending review until Keith confirms wording matches intent)
3. **Future automation:** the bot DMs Keith a markdown block formatted for direct paste into `league_context_v1.md`. Phase 6 work, not built yet.
4. **Source-of-truth invariant:** the league_context entry is what owners + bot consult going forward. If the public HTML rulebook hasn't caught up yet, league_context wins.

### What's "new" vs "approved" — the 🆕 vs ✅ distinction

| State | Tag | Meaning |
|-------|-----|---------|
| Drafted in proposal, not yet voted | (in proposal text only) | Bot can describe the proposal, but does NOT cite it as current rule |
| Vote PASSED, summary thread posted, not yet in this doc | (in Discord thread + summary table only) | Bot can answer "this rule passed on [date]" but should flag "not yet folded into canonical context" |
| Folded into this doc with 🆕 tag | 🆕 NEW (pending review) | Bot cites the new rule; flags "this is recent and pending Keith review" if asked |
| Reviewed and confirmed by Keith | ✅ LOCKED | Bot cites without caveat |
| Conflicting / ambiguous | 🟠 AMBIGUOUS | Bot answers with "Open question:" prefix and points at the ambiguity register |

Going forward, every passage of a Hall vote should trigger:
1. Auto: thread + impact analysis (current bot behavior)
2. Manual: Keith adds to this doc with 🆕 tag
3. Manual: Keith later promotes 🆕 → ✅ once the wording is confirmed

