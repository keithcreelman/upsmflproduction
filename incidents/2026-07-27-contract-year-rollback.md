# Contract-year rollback — 3 players reset to Year 1 — 2026-07-27

## Problem

Jaxon Smith-Njigba, Jerry Jeudy, and Roquan Smith were each charged for the
**wrong contract year** on MFL — silently, for 4 days, mid-auction — after an
AI agent session's "fix the AAV placeholder" write also overwrote `salary`
and `contractYear` back to each contract's **Year 1 / full original length**,
undoing the March roll-forward.

| Player | Franchise | Charged | Should be | Overcharge | Term also moved |
|---|---|---|---|---|---|
| Jaxon Smith-Njigba (16185) | C-Town Chivalry (0009) | $14,000 / cy 3 | $1,000 / cy 2 | **+$13,000** | expiry 2027 → 2028 |
| Jerry Jeudy (14833) | Cleon Ca$h (0011) | $7,000 / cy 3 | $1,000 / cy 1 | **+$6,000** | expiry 2026 → 2028 |
| Roquan Smith (13696) | Cleon Ca$h (0011) | $8,000 / cy 3 | $1,000 / cy 1 | **+$7,000** | expiry 2026 → 2028 |

**Total: $26,000 phantom cap charge**, discovered live during the 2026 FA
Auction. Cleon Ca$h was showing $34,000 of cap space when they actually had
$47,000 — 38% more real buying power than the UI told them, while actively
bidding.

## Root cause

At `2026-07-23T17:44:12Z` (dry run) and `17:44:35Z` (live commit), a Claude
Code agent session ran a **hand-typed `curl` heredoc** against
`POST /admin/import-salaries` with 8 player rows composed inline in the shell
command — not a committed script. The goal was narrow: repair a stale
`AAV 1K` placeholder token in `contractInfo` for players whose true AAV
should reflect `TCV / CL`.

Five of the eight rows correctly restated the player's live `salary` and
`contractYear`. **For the three players whose live salary happened to be the
`$1,000` placeholder, the agent instead reconstructed `salary` and
`contractYear` from the contract's year-list string** (`salary := Y1`,
`contractYear := CL`) rather than preserving the live values — it treated
those specific rows as fully untrustworthy and rebuilt them from scratch. For
JSN, the substituted values were a literal copy of his 2025 season's roster
row, pulled by the same session three tool calls earlier.

**Why the dry-run/verification didn't catch it:** the agent's own
before/after check only ever parsed the `AAV` token out of `contractInfo`
(`contractInfo.split('AAV')[1]`) — never compared `salary` or `contractYear`.
It reported "All 8 clean, AAV-only changes" and "All 8 live and verified,"
which was true for the field it checked and false for two it never looked
at. `data/misc_data/contract_audit_2026-07-24.csv` then recorded all three
rows as `DONE / AAV_FIXED / "validator passes clean" / APPROVED` — the CSV
has no `salary` or `contract_year` column, so the paper trail structurally
cannot see this class of damage. It stood approved and un-flagged for 4 days.

**A proposed single-row invariant does NOT catch this class of bug.** The
obvious fix — assert `salary == Y[CL − contractYear + 1]` — was checked
against all 3 corrupted rows and **flags zero of them**: `salary := Y1` and
`contractYear := CL` were changed *together*, so the row is internally
self-consistent (a Year-1 reset just looks like a valid brand-new Year-1
contract). The check that actually catches it is **cross-season
monotonicity**: for a player under the same contract as last season,
`contractYear(this year)` must equal `contractYear(last year) − 1`, unless a
recorded extension/MYAC/restructure event also changed `CL` or the year-list.
All three violate this (`cy 1→3`, `1→3`, `2→3` with an unchanged contract
string) — see the cleanup backlog for the concrete fix.

## Fix applied 2026-07-27

Verified via full 354-player roster diff (2025 vs. live 2026) plus an
all-time scan of `salary_change_log` for any `/admin/import-salaries` write
where `contractYear` increased — confirms the blast radius is **exactly
these 3 players**, nowhere else on the roster.

Independently re-derived from canon (`docs/league_context_v1.md` §1.C7 roll-forward
+ §1.C4/§1.C5 extension/restructure math) by 3 parallel audit agents with no
shared context — all 3 landed on identical numbers with high confidence, and
a 4th synthesis agent re-derived independently from raw MFL snapshot files
and confirmed again. The AAV correction from the original 7/23 write was
**correct and preserved** — only `salary` and `contractYear` were rolled
back to the pre-corruption values (sourced from `salary_change_log`'s own
`before_*` columns, the literal state one second before the bad write).

Dry-run, then live, via `POST /commish-contract-update` (`silence_discord=1`
— this is a bug-fix revert, not a real roster event) for each player:

```
16185  salary 14000→1000  contractYear 3→2  (Vet-Ext2-FL, contractInfo unchanged)
14833  salary  7000→1000  contractYear 3→1  (Vet-FAA-FL,  contractInfo unchanged)
13696  salary  8000→1000  contractYear 3→1  (Vet-FAA-FL,  contractInfo unchanged)
```

Verified live via `postCheck` on each write, then a fresh rosters re-fetch:
C-Town Chivalry roster-salary total $182,000 → $169,000; Cleon Ca$h
$266,000 → $253,000. Cap space restored to correct values mid-auction.

## Files NOT changed

- Nothing in the codebase — this was a data-only revert via the existing
  `/commish-contract-update` route. No code shipped as part of the fix
  itself (the structural fixes are tracked separately, see below).

## Still open / uncertain

- **D1's own contract tables were not confirmed either way.**
  `/admin/import-salaries` writes only to MFL + `salary_change_log`, not any
  `ups_*` D1 table — so D1 likely never saw the corruption, meaning FO/D1 and
  MFL may have silently disagreed on these 3 players for 4 days. Not
  re-checked after the fix landed.
- Whether the same hand-typed-write pattern corrupted any **other** player in
  an earlier session is unresolved — only the cross-season `cy` check would
  catch it, and that check doesn't exist yet anywhere in the codebase.

## Follow-up (tracked)

See [docs/CLEANUP_BACKLOG_2026_OFFSEASON.md](../docs/CLEANUP_BACKLOG_2026_OFFSEASON.md)
— item 1.
