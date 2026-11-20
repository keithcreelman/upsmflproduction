# Commissioner Desk: Answer-Card and UX Specification (planning deliverable 2)

**Date:** 2026-11-19. Planning only.

**Visual reference:** `UPS_AI_WALKTHROUGH_2026-11-19.html`. This spec turns those mockups into rules a builder must meet.

**Labels:** [R] recommendation · [V] verified · [U] open.

## 1. Principles
1. **Show the evidence, not confidence.** Every card states what was checked, the grade of each fact, and what is missing. Tone never stands in for evidence.
2. **Numbers come from tools.** Prose has no digits. Every quantity is a fact chip filled from a tool result.
3. **Refusing is a first-class answer,** with the reason and what would settle it.
4. **AI-generated, always labeled.** Sources reachable in two taps or fewer.
5. **Read-only.** The desk drafts; it never posts, sends or changes anything.
6. **Phone first.** Every card works at 320px wide, with no horizontal page scroll; wide tables scroll inside their box.
7. **House style:** American spelling; short on-screen notes (one line plus up to three short sentences); franchise ids alongside team names.

## 2. Surface [R; your decision before phase 1]

| Option | For | Against |
|---|---|---|
| **A. Private web page inside Commissioner Settings (recommended)** | Reuses the existing commissioner gate; room for tables, trees and drill-downs; nothing posts anywhere | One more page |
| B. Private Discord DM with the bot | Already on your phone | Cramped for trees and tables; Discord formatting limits; mixes with the owner-facing bot |

The phase-4 owner experience (Discord, then mobile) uses the same card JSON with a smaller renderer and a lower data-class ceiling.

## 3. Screen layout (desk)
```
┌ Ask box ─────────────────────────────── [Ask] ┐
│ suggested: "Trace a pick" "Contract history"  │
│ "Rule then vs now" "Compare franchises"       │
├ Progress (while working) ─────────────────────┤
│ ✓ Understood: pick lineage  ✓ 4 tools  … 6s   │
├ Answer card ──────────────────────────────────┤
│ header · answer · evidence · gaps · footer    │
├ Follow-ups: [Expand next trades] [Show rule]  │
└ History: last 50 questions (private log) ─────┘
```

## 4. Answer card anatomy

| Region | Contents | Rules |
|---|---|---|
| **Header** | "AI-generated" · data as-of · canon version (`canon_sha`, 7 characters) · League Record version · phase badge | Always present |
| **Lead** | 1–3 sentences answering the question directly, or saying why it can't | Fact chips only; no digits typed |
| **Body blocks** (0–n) | `timeline` (ownership chains), `table`, `chart`, `branch` (rule disputes), `comparison` | Each block cites its tool call |
| **Evidence chips** | A · B · C · D · NO RECORD next to each fact | Tap → provenance drawer |
| **Gaps box** (amber) | Missing records, unsupported dates, partial coverage | Required whenever `coverage.gaps` is non-empty |
| **Conflict box** (amber) | Two sources disagree: both values and sources | Never pick one silently |
| **Needs-ruling box** (blue) | The open question, the cited rules, a drafted ruling question for you to edit | Never decides for you |
| **Footer** | Sources · "What I checked" (tool calls, durations) · Report a problem | Report a problem creates a private eval case |

**Provenance drawer** (tap any chip): value, unit, as-of, grade, source, tool and inputs, code SHA, raw-record link where it exists. Maximum two taps from the card.

## 5. Card states (each needs a test fixture)

| State | When | What you see |
|---|---|---|
| `answer` | Tools cover it fully | Lead + blocks |
| `answer_with_caveat` | Covered, with a known limitation (for example, franchise not owner) | + grey caveat line |
| `answer_with_gap` / `partial` | Part covered | + amber gaps box listing exactly what is missing |
| `answer_with_conflict` | Sources disagree | Conflict box with both values |
| `cite_and_abstain` | Rule text found, but the facts or era can't be settled | Cited rules + "can't determine" + what would settle it |
| `needs_ruling` | Canon silent or ambiguous | Needs-ruling box with a drafted question |
| `abstain` | No data exists (for example, GAP-12/13) | "Not determinable" + the missing source named |
| `refuse_privacy` / `refuse_fairness` | Caller lacks the data class | Plain refusal; never confirms whether the data exists |
| `ignore_injection` | Retrieved text contains instructions | Normal answer from authoritative sources, plus a small "ignored instructions found in source text" note on the desk |
| `tool_failure` | A timeout or error | "Couldn't verify X right now" + retry; no substitute numbers |
| `stale_data` | Source older than its freshness limit | Answer withheld, or shown with a red stale banner (per tool policy) |
| `budget_exceeded` | Spend cap reached | "Paused: AI budget reached for this period"; no model call is made |
| `out_of_scope` | Not a league question, or an action request | Explains what the desk does; no action |

## 6. Composer output contract (what the model must return) [R]
```json
{
  "state": "answer|answer_with_caveat|answer_with_gap|partial|answer_with_conflict|cite_and_abstain|needs_ruling|abstain|refuse_privacy|refuse_fairness|tool_failure|out_of_scope",
  "lead_md": "Text with {{f.fact_id}} tokens only; no digits",
  "blocks": [{"type":"timeline|table|chart|branch|comparison","title":"...","rows":[...],"fact_ids":["..."],"tool_call_ids":["..."]}],
  "facts_used": ["f.fact_id", "..."],
  "cites": [{"anchor":"s1-c4","canon_sha":"194f8df","claim":"..."}],
  "gaps": [{"what":"...","why":"NO_RECORD|unsupported_as_of|partial_coverage","source_needed":"..."}],
  "conflicts": [{"fact_a":"f.x","fact_b":"f.y","note":"..."}],
  "ruling_question": "optional draft",
  "follow_ups": ["..."]
}
```

**Validator (code, before rendering).** Reject and retry once, then return `tool_failure` with no answer:
1. Every `{{f.*}}` token resolves to a fact returned by a tool in this run.
2. Prose contains no digits or spelled quantities outside tokens. This reuses the Wire digit audit.
3. Every cited anchor exists in `rules.json` at `canon_sha`.
4. No fact exceeds the caller's data class.
5. If any tool returned gaps, `gaps` is non-empty and the state isn't plain `answer`.
6. If the question's `as_of` is in the past and a tool returned `unsupported_as_of`, the state must not be `answer`.

## 7. Components (render rules)
- **Timeline** (lineage): one row per ownership change: date · from → to · what was exchanged (expandable) · grade. The final row is bold (selection or current holder). Gap rows use a dashed marker.
  - **Default depth:** the asset's own chain, plus one level of the deals it was packaged into.
  - **"Expand"** fetches the next level. Never auto-expand beyond two levels.
- **Table:** sticky first column at narrow widths; numbers right-aligned, tabular figures.
- **Chart:** only for trends across 4 or more seasons; always paired with the table; era boundaries drawn (for example, Superflex 2022, 37 games from 2021).
- **Branch:** one card per reading of a rule dispute, each with its cited rule and the evidence it would need.
- **Comparison:** side-by-side columns per franchise. The note "franchise, not owner" appears until the owner registry exists.

## 8. Progress and latency
- Show steps as they happen: understood → tools (count) → checking → done.
- Targets: p50 ≤ 8 s, p95 ≤ 20 s for desk answers. Deep research shows a running step list and stops at 90 s or the per-question budget ($0.50).

## 9. History, feedback and logging
- Private question history (desk only), kept 90 days.
- One row per model call in a new, separate log table (not `hall_qa_log`): feature, model, prompt hash, `canon_sha`, League Record version, tools, tokens, cost, latency, validator result, state.
- "Report a problem" stores the question, card JSON and your note as a private draft eval case.

## 10. Accessibility
- Color is never the only signal: chips carry text labels.
- Contrast meets WCAG AA in light and dark themes.
- Every chart has a text table.
- Tap targets are at least 44px.

## 11. What the desk will not do
- Post to Discord.
- Message owners.
- Change rosters, contracts, settings or canon.
- Accept or propose trades.
- Show owner-private data on owner surfaces.
- Answer from model memory.

## 12. Acceptance criteria for this spec (checked in phase 1)
- Every state in §5 has a fixture card and renders correctly at 320 / 375 / 1280 px, in light and dark.
- Provenance is reachable in two taps or fewer from every number.
- The validator rejects all seeded bad outputs: a typed digit, an unknown fact, a fake anchor, an over-class fact, a missing gap.
- A real-phone preview, plus screenshots at 320px and 375px (Keith's standing rule), before release.
