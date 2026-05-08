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

## 2026-05-08 — Taxi squad flexibility — temporary call-ups before permanent move (PASSED 7-0-0)

**Round:** May2026 · **Locked:** 2026-05-08T09:49:04.784Z
**Discord thread:** https://discord.com/channels/1057655884475531324/1501643162567966903
**Integration PR:** _pending_

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
> **The vote**
> - ✅ **YES** — adopt temporary call-ups with the 3-week limit per player
> - ❌ **NO** — keep the current taxi rule (permanent call-up only)
> - ➖ **ABSTAIN** — recorded but doesn't decide
> 
> *Behind the scenes: every owner's call-up usage will be tracked and visible so eligibility is auditable.*

### Sections affected
_To be filled in by the commissioner during PR review (see PR description for the impact-analysis checklist)._

### Before → After
_To be filled in by the commissioner during PR review._

---

<!-- No entries yet. The first entry will be added when the rule integrator
     runs against a passed rule (manually triggered for taxi-squad and
     salary-depreciation, then automatic for future passes). -->
