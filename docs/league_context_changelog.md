# League Rules Changelog

Audit trail of every rule change to the league since 2026, in **reverse chronological order** (newest at the top).

This file is **append-only**. Entries are committed automatically by the worker when a rule passes its Discord vote. Manual edits are reserved for backfills (e.g., recording older rule changes that pre-date the bot).

The single source of truth for **current** rules is [`docs/league_context_v1.md`](league_context_v1.md). This file is the **history** — you should never need to read this to understand what's currently true; only to understand how we got here.

---

## Entry format

Each entry follows this structure:

```markdown
## YYYY-MM-DD — <Proposal title> (PASSED|REJECTED <yes>-<no>-<abstain>)

**Round:** <round_id> · **Threshold reached:** <UTC timestamp> · **Locked:** <UTC timestamp>
**Discord thread:** <permalink>
**Integration PR:** #NN

### Proposal body
> <full proposal body markdown, blockquoted>

### Sections affected
- `B2 Taxi Squad` (line ~222) — replaced activation mechanic
- `D1 Cut/Release` (line ~343) — cross-reference updated
- ...

### Before → After
**`B2 Taxi Squad` (before merge):**
> <original text>

**`B2 Taxi Squad` (after merge):**
> <new text>

(repeat per affected section)

---
```

---

<!-- AUTO_APPEND_BELOW — worker appends new entries directly under this marker.
     Do not remove this marker; the rule integrator uses it as the insertion
     point. New entries push older ones further down so reverse-chronological
     order is preserved. -->

## 2026-05-08 — Realignment — captain-based division draft (PASSED 7-0-0)

**Round:** May2026 · **Locked:** 2026-05-08 (post-vote, locked at threshold + 5 min grace)
**Discord thread:** https://discord.com/channels/<DISCORD_GUILD_ID>/1501643152971272322
**Integration:** manual edit by commissioner (no PR — fine-grained PAT auth issue at integration time; bot researcher path was bypassed for this batch)

### Proposal body
> **The change**
>
> All-Play % no longer picks divisions — it picks **Division Captains** only. Captains snake-draft their division mates.
>
> **Format**
> - **Top 4 teams by All-Play %** become Division Captains
> - **Snake draft, 2 rounds:** Round 1 picks 1→4, Round 2 picks 4→1
> - Divisions are no longer formula-generated
> - **The snake draft happens at the Rookie Draft every 3 years** — when everyone is present. Yes, that means the last-picked dodgeball kid (the #1 pick) gets ridiculed in person. Adds an excellent layer of league entertainment.
>
> **Seeding**
> - **2026 (this realignment):** full historical All-Play %
> - **Going forward (every 3 years):** rolling 3-year All-Play %
> - **Captain eligibility:** owners must have been in the league the full 3-year prior window to be eligible for Captain
>
> **Why**
> - Current formula produces repeat clustering — same teams keep landing in the same divisions cycle after cycle
> - **Of 66 possible current-owner pairings, only 29 have ever shared a division — 37 pairs have never been divisional opponents-of-record across the 5 realignment cycles since 2011**
> - Some pairs have shared 15 seasons of league time without ever once landing in the same division
> - Captain draft creates more variety — and more fun

### Sections affected
- `Section 4. 2026 — Active changes` (line ~1248) — replaced "formula uses prior 3-year all-play records" with new captain-draft mechanic
- `Appendix — Divisional Co-tenancy History` → "Realignment cycles (for context)" (line ~1811) — added 2026–2028, 2029–2031, 2032–2034 cycles to the table; added new "Realignment mechanic — Captain-based snake draft" subsection with full rule + seeding + eligibility + bot guidance

### Before
> **Section 4 — 2026 Active changes:**
> - Division realignment year (next: 2029, 2032). Realignment uses prior 3-year all-play records to slot teams into divisions.

### After
> **Section 4 — 2026 Active changes:**
> - Division realignment year (next: 2029, 2032). Cadence is every 3 years.
>   - **(UPDATED 2026-05-08)** Realignment now uses **captain-based snake draft**. Top 4 teams by All-Play % become Division Captains; Captains snake-draft their division mates in 2 rounds.
>   - For the 2026 realignment specifically: Captain seeding uses **full historical All-Play %**.
>   - Going forward (2029, 2032, …): Captain seeding uses **rolling 3-year All-Play %**.

---

## 2026-05-08 — Salary depreciation — true pro-rated (PASSED 7-0-0)

**Round:** May2026 · **Locked:** 2026-05-08T09:49:35Z
**Discord thread:** https://discord.com/channels/<DISCORD_GUILD_ID>/1501643166686646464
**Integration:** manual edit by commissioner

### Proposal body
> **Current model**
> - *Non-WW Players:* 25% earned by end of Oct · 50% by end of Nov · 75% by end of Dec · 100% by season end
> - *Waiver wire (WW):* flat 35% regardless of pickup date
>
> **Proposed — true pro-rated**
>
> *Non-WW Players (Auction + Week-1 acquisitions):* earned per completed week.
> - After Week 1 → 1/17 earned · Week 2 → 2/17 · Week 3 → 3/17 · …through full season
>
> *Mid-season pickups:* pro-rated over remaining eligible weeks.
> - Example A — picked up in Week 9 (**9 weeks remaining**: Weeks 9–17): Week 9 → 1/9 · Week 10 → 2/9 · …
> - Example B — picked up in Week 7 (**11 weeks remaining**: Weeks 7–17): Week 7 → 1/11 · Week 8 → 2/11 · …
>
> *WW pickups under this model* — treated identically to auction contracts: same **75% guarantee**, same earning math, same cap-penalty timing. The only difference is the window — WW pickups have fewer weeks remaining to earn.
>
> **Why now**
> - Available data makes this easy to track and maintain
> - Better reflects how real contracts accrue value over time
> - Can be applied immediately — offseason timing allows a clean transition across all teams
>
> **What changes for owners**
> - Total cap hit over a contract's life is **unchanged**
> - Only the *timing* of when salary is earned changes
>
> **What does NOT change** *(current rules carry forward)*
> - WW pickups **under $4K** remain cap-penalty-free if dropped
> - Multi-year contracts where TCV < $5K still carry the **fixed $1K penalty** if dropped with more than 1 year remaining
> - All cap penalties are **rounded based on the SUM of penalties accrued**, not per-penalty

### Sections affected
- `D1. Cut / Release` (line ~341) — replaced calendar-month earning schedule with per-week pro-rated math; added in-season worked example; preserved unchanged carry-forward rules (cap-free <$4K, multi-year <$5K, rounding)
- `Section 6.B — Earning curve CANONICAL` (line ~1395) — full rewrite from monthly-bucket table to per-week formula with eligible-weeks denominator; renamed B3 from "Future direction" to "Resolved"
- `Section 3 — Annual Calendar` calendar-checkpoint mentions (lines ~917, ~999, ~1003, ~1010) — removed Oct/Nov/Dec 25/50/75 % checkpoints; replaced with per-week note pointing at Section 6.B
- `Appendix — Bot Grounding Clarifications` (lines ~1953, ~1958) — relabeled "NOT changed by salary depreciation proposal" sub-rules to "preserved by 2026-05-08 salary-depreciation rule"
- `Section 7 — STILL OPEN A1.1` (line ~1719) — struck through and marked RESOLVED 2026-05-08
- `Section 6.H — STILL OPEN` (line ~1655) — struck through #1 (per-game prorated)
- `Section 7 — A4 Future automation #17` (line ~1747) — calculator-build task is now active (was blocked on this league decision)
- `Document Status & Versioning` version log (line ~26) — added 2026-05-08 entry covering all 3 May 2026 passed rules

### Before (excerpt — Section 6.B)
> A contract's salary "earns" by **calendar-month bucket**. Earning ticks UP at the start of each month (10/1, 11/1, 12/1) and concludes at season end.
>
> | Cut Date Range | % earned |
> | FA Auction start through 9/30 | 0% |
> | 10/1 – 10/31 | 25% |
> | 11/1 – 11/30 | 50% |
> | 12/1 – season end | 75% |
> | After season end | 100% |

### After (excerpt — Section 6.B)
> A contract's salary "earns" **per completed NFL regular-season week**. The denominator is the player's **eligible weeks remaining at the time of acquisition**.
>
> ```
> Salary Earned = (completed_eligible_weeks / total_eligible_weeks) × year's actual salary
> ```
>
> | Acquisition path | Total eligible weeks |
> | FA Auction + pre-Week-1 pickups | 17 |
> | Mid-season pickup in Week W | 18 − W |
> | Pre-rollover offseason cut | N/A — 100% earned at rollover |

---

## 2026-05-08 — Taxi squad flexibility — temporary call-ups (PASSED 7-0-0)

**Round:** May2026 · **Locked:** 2026-05-08T09:49:04Z
**Discord thread:** https://discord.com/channels/<DISCORD_GUILD_ID>/1501643162567966903
**Integration:** manual edit by commissioner

### Proposal body
> **The change**
>
> Owners can call up a taxi player to the active roster temporarily — up to **3 weeks total per player** across their taxi-eligible window (their first 3 years in the league). After that, the call-up becomes permanent. All standard taxi eligibility rules still apply.
>
> **How it works**
> - Each call-up is a one-week commitment. Player counts against active roster limits **and** salary cap for that NFL week.
> - After the week, the owner can return the player to the taxi squad.
> - Each active week counts as **1** toward the player's 3-week limit. Weeks are cumulative across seasons — consecutive or non-consecutive both count.
> - On the **4th week** of activation, the call-up becomes **permanent**.
>
> **Why**
> - We now have the tracking in place to manage this with minimal manual work
> - Lets owners use taxi players in short-term roles without permanently committing
> - Removes the current "one-week activation = permanent loss" trap
> - Mirrors how NFL teams use practice squad elevations
> - Introduces strategy while keeping accountability — every activation burns a finite allowance
>
> *Behind the scenes: every owner's call-up usage will be tracked and visible so eligibility is auditable.*

### Sections affected
- `B2. Taxi Squad` (line ~227) — added "Promotion mechanic (UPDATED 2026-05-08 — temporary call-ups)" subsection with the 3-week budget, "active for the week" definition, and 4th-activation-becomes-permanent rule; updated "Cut economics" to distinguish never-permanently-promoted from permanently-promoted
- `T2.4. Promote from Taxi` (line ~574) — split promotion into Temporary call-up (weeks 1–3) and Permanent promotion (4th activation OR explicit MYAC/extension/restructure)
- `D2. Cap-free cut categories` (line ~358) — clarified "Taxi Squad (never *permanently* promoted)" to include temp call-ups still being cap-free-cuttable
- `Appendix — Bot Grounding Clarifications: Taxi squad — "active for the week" definition` (line ~1976) — updated framing from "anticipating proposal" to "effective 2026-05-08"

### Before (excerpt — B2 Cut economics)
> - **Cut economics:** Taxi-squad players never promoted to active can be cut **cap-free**. Once promoted to active, normal cut penalties apply going forward.

### After (excerpt — B2 Cut economics)
> - **Cut economics:**
>   - **Taxi-squad players never *permanently* promoted (≤3 temporary call-ups) can still be cut cap-free.** Temporary call-ups do NOT trigger the "permanently promoted" flag, so cap-free cut remains available between activations and after a player returns to taxi.
>   - **Once permanently promoted (4th activation OR an MYAC/extension/restructure that explicitly promotes), normal cut penalties apply going forward.**

---
