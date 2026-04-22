# Rulebook Inbox

Proposed entries for `docs/ups_v2/V2_GOVERNED/rules/claude_canonical_rules.md`. Keith reviews each entry and promotes to the canonical file with a dedicated commit (so the rule edit is auditable in git history). Nothing in this file is authoritative — it's a staging area.

Claude may append proposals here at any time but MUST NOT edit `claude_canonical_rules.md` directly. When promoting, move the block from here into the canonical file and delete it here in the same commit.

---

## Proposed: RULE-DEADLINE-001 — Three distinct deadline flavors, not one

**Category:** RULE-DEADLINE (new category — contract-action timing)
**Status:** proposed
**Raised:** 2026-04-22 — Puka Nacua's Front Office popup displayed
"Deadline: Sep 6, 2026 to extend." That's wrong; Puka is on an expired
rookie contract with 1 year remaining, so the governing deadline is
the **following May** (pre-auction), not September.

**Rule.** The league has three separate contract-action deadlines that
consumers often conflate. Every UI that surfaces a "deadline to X"
date must first classify the player and pick the matching deadline —
do not display one global "contract deadline."

1. **Non-rookie contract extension deadline = September**
   (the auction kickoff date — e.g. 2026-09-06 for the 2026 season).
   Applies to: players under an active, non-rookie contract with 1
   year remaining at the time of the upcoming auction.

2. **Expired rookie extension deadline = the following May**
   (pre-auction for the NEXT season — i.e. May 2027 for a rookie
   whose deal expires end-of-2026). Applies to: rookie-contract
   players in their final rookie year who are not option-exercised.
   Puka Nacua (2023 rookie, now Year 3) falls here.

3. **Rookie option-exercise deadline = September**
   (the same auction-kickoff date as #1). Applies to: 1st-round
   rookies with an eligible 5th-year option — starting with the 2025
   rookie class and forward (prior classes had no option). The
   option-exercise decision locks in before the upcoming auction; if
   not exercised, the player hits regular expired-rookie rules.

**How to apply.** The Front Office (`roster_workbench.js`) computes
extension eligibility via `playerExtensionOptions`/`rosterContractEligibility`.
Those helpers must expose the deadline *kind* (not just the date) so
the modal copy can say the right thing — "Sep 6 (auction kickoff)",
"May 2027 (pre-next-auction rookie deadline)", or "Sep 6 (5th-year
option)".

**Cross-refs.** RULE-CAP-001 (auction kickoff date is the canonical
"before the auction" snapshot), RULE-EXT-002 (+$10K × extension_years
formula — independent of deadline).

**Bug follow-up.** The Nacua display bug is a separate fix from this
rule doc — the rule describes how the system SHOULD behave; the fix
will adjust whichever deadline-label function in roster_workbench.js
is wired to the popup.

---

## Proposed: RULE-DATA-004 — Starter detection uses weeklyresults, never rosters_weekly presence

**Category:** RULE-DATA
**Status:** proposed
**Raised:** 2026-04-21 — debugging why 2012-2019 had no tier classifications on the Draft Hub player-profile modal.

**Rule.** When computing anything that depends on "was this player a starter in week X of season Y" — positional baselines, week-tier classification, starter counts, E+P rates — the authoritative signal is `weeklyresults.status IN ('starter', 'nonstarter')`. Do NOT gate on presence in `rosters_weekly` first.

**Why.** `rosters_weekly` only has data from 2017 onward. For older seasons (2010-2016), players are absent from that table entirely. Any builder that does `WHERE rw.player_id IS NOT NULL` before checking `weeklyresults.status` silently drops every starter row for those years — producing empty baselines, 0% tier classifications, and effectively invisible career data from a league-history POV.

**How to apply.** Logic order in the `combined` CTE of
`pipelines/etl/scripts/build_metadata_positionalwinprofile.py` (and any
similar transform):

```sql
CASE
  WHEN LOWER(wr.status) IN ('starter', 'nonstarter') THEN LOWER(wr.status)
  WHEN rw.player_id IS NOT NULL THEN 'nonstarter'
  ELSE 'fa'
END
```

Weeklyresults is the primary source; rosters_weekly is a fallback signal only when weeklyresults is silent. The reverse ordering (pre-2026-04-21) gave us the 2012-2019 baseline gap.

**Worked example.** Michael Thomas WR NOS 2018-2019 showed tier=NULL in the player-profile modal before the fix because baselines were missing. After the rule-correct ordering: 2019 = 58.3% Elite / 91.7% E+P / 0% Dud (his historic stud year). See commit context of the build_metadata_positionalwinprofile.py restoration for details.

**Enforcement.** `build_metadata_positionalwinprofile.py` is the canonical source of positional baselines and now lives in-repo. Any future builder that introduces a similar "is this player rostered" check should mirror this ordering.

---

## Proposed: RULE-DATA-003 — Historical draft attribution corrections must update all four layers

**Category:** RULE-DATA
**Status:** proposed (not yet promoted)
**Raised:** 2026-04-21 (session with Keith)
**Worked examples:** 2014 4.06 Bortles reassignment (`07e46cf`), 2016 1.06 Michael Thomas DB→WR NOS (`e16f0b9`).

**Rule.** When correcting a historical rookie-draft pick (wrong `player_id`, wrong franchise, or a mis-attributed draft-day trade), update every one of these layers in the same commit (or back-to-back commits). Skipping any layer causes the fix to silently regress the next time `build_rookie_draft_hub.py` runs.

1. **Source-of-truth table in `mfl_database.db`**
   - `draftresults_legacy` (pre-MFL-API seasons): update `player_id`, `player_name`, `franchise_id`, `franchise_name` as appropriate.
   - `draftresults_mfl` (seasons MFL has the native export): usually self-heals from MFL on next ETL — edit only if MFL's own data is wrong.

2. **Published JSON artifact**
   - `site/rookies/rookie_draft_history.json`: update identity fields on the pick row. If `player_id` changed, null out player-specific performance stats (points, ranks, tier, expected-vs-actual, draft_rating) so the UI shows "—" instead of the previous player's numbers. Next ETL rerun will refill.

3. **Draft-day trade record (if applicable)**
   - `site/rookies/rookie_draft_day_trades.json` under `trades_by_season[<year>]`. Schema: `trade_group_id`, `unix_timestamp`, `datetime_et`, `comments`, `hours_from_first_pick`, `sides[<fid>]` with `gave_up` and `received` arrays. Both sides must be recorded.

4. **Derived aggregates — do NOT hand-patch**
   - `rookie_draft_tiers.json`, `rookie_draft_team_tendencies.json`, `rookie_ap_vs_ep.json` regenerate from the above on the next ETL run. Hand-edits here are wasted work.

**Why.** `build_rookie_draft_hub.py` reads the source DB and regenerates artifacts. If the source DB still has the wrong `player_id`/franchise, any JSON-only fix gets overwritten. If the DB is fixed but the JSON isn't synced, users see stale data until the next ETL run — which may be days.

**Cross-refs.** RULE-DATA-001 (UW = L.A. Looks), RULE-DATA-002 (MFL corruption during trade+extension).

**Operator note.** Reference doc at `docs/ups_v2/V2_GOVERNED/rules/claude_canonical_rules.md` — also tracked in memory at `reference_draft_attribution_fix_layers.md`.

---

## Proposed: Review ledger entries (2026-04-21)

Append to Appendix B of `claude_canonical_rules.md`:

| Review Date | Team / Subject | Status | Notes |
|---|---|---|---|
| 2026-04-21 | 2014 R4 — Ulterior Warrior / The Baster draft-day trade | ✓ corrected | Bortles 4.06 reassigned Eric → Ryan; draft-day trade logged with Ryan giving 2014 4.10 + 2015 R5, Eric giving Bortles. Rationale: Ryan instructed Eric to make the pick due to draft-day tech issues; trade formalized immediately. Commits: `07e46cf`. |
| 2026-04-21 | 2016 R1 1.06 — Good in Da Hood Michael Thomas identity | ✓ corrected | Pick was recorded under pid 11613 (Miami S, Michael Thomas). Actual pick was pid 12652 (NOS WR Michael Thomas — Saints stud). Identity fields updated in `rookie_draft_history.json` and `draftresults_legacy`; performance stats nulled pending ETL rerun. Commits: `e16f0b9`. |

---

## Proposed: RULE-SECRETS-001 — No long-lived secrets in source code

**Category:** RULE-SECRETS (new category)
**Status:** proposed
**Raised:** 2026-04-21 — push of `trade_roast_bot.py` to `upsmflproduction` was blocked by GitHub push-protection because a Discord bot token was hardcoded at line 46. Rotated and scrubbed before push (commit `2e29441`).

**Rule.** Any credential (API key, bot token, database password, signed URL, MFL user cookie, etc.) must be supplied at runtime via environment variable or a `.env` file that is gitignored. Scripts that need a secret must:

1. Read from `os.environ` (Python) or `process.env` / Worker secret binding (JS).
2. Exit with a clear error if the env var is missing. Never fall back to a hardcoded literal.
3. Never log the secret.

**Enforcement.** GitHub push-protection is the backstop — it will block a commit that contains a known secret format. But we don't rely on it; scrub before committing. If a secret was ever in a commit (even reverted), **treat it as compromised and rotate**.

**Cross-ref.** `pipelines/etl/config/runtime.env.example` shows the expected env-var shape.
