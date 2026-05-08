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

<!-- No entries yet. The first entry will be added when the rule integrator
     runs against a passed rule (manually triggered for taxi-squad and
     salary-depreciation, then automatic for future passes). -->
