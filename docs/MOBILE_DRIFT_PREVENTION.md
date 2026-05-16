# Mobile / Desktop Drift Prevention

**Last updated:** 2026-05-16
**Owner:** Keith Creelman
**Status:** Living document — update whenever a cross-codebase rule changes.

## Purpose

The mobile site at `site/m/` is a **verbatim mirror** of desktop's contract / cap / lineup logic (`site/rosters/roster_workbench.js`, `site/team_operations/team_operations.js`). Mirrors drift naturally over time — desktop gets a fix, mobile doesn't; or vice versa. The 2026-05-16 audit surfaced ~12 such drift points. This doc is how we keep that from happening again.

## The non-negotiable principles

1. **One source of truth per rule.** Each canonical rule from `docs/league_context_v1.md` has exactly one implementation. Mobile copies are byte-for-byte mirrors with file:line citations in their headers.

2. **Worker is the enforcement boundary.** Both client codebases (desktop, mobile) are PREVIEW only. The worker (`worker/src/lib/cap_penalty.js`, etc.) is what actually charges cap, writes audit rows, and posts to Discord. When client/worker drift on math, the worker wins.

3. **Mobile never diverges from desktop alone.** If you fix a bug on mobile, you fix it on desktop in the same PR (or surface the migration here for cross-codebase coordination). Mobile-only fixes create exactly the drift this doc exists to prevent.

4. **Verbatim mirror = literal copy.** Mirror files (`site/m/front_office_*.js`) reproduce desktop logic line-for-line. Header comments cite the source range (`site/rosters/roster_workbench.js:1168-1288`). Spot-checks should yield byte equality on the function bodies.

5. **When you DELIBERATELY diverge, document it.** Some divergences are intentional (e.g. mobile fixes a desktop bug because waiting on cross-codebase work would block users). Mark these with `INTENTIONAL DIVERGENCE FROM DESKTOP (yyyy-mm-dd)` comments and add a row to §3 below.

## §1 — Files under the mirror discipline

| Mobile file | Desktop source | Scope |
|---|---|---|
| `site/m/front_office_penalty.js` | `site/rosters/roster_workbench.js` lines 1604-1927 | Drop penalty + earning |
| `site/m/front_office_cap.js` | `site/team_operations/team_operations.js` lines 660-708 | Cap math |
| `site/m/front_office_lineup.js` | `site/team_operations/team_operations.js` lines 829-883 | Lineup validation |
| `site/m/front_office_actions.js` | `site/rosters/roster_workbench.js` lines 558-1288 | Contract eligibility + extension blocks + tag plumbing |
| `site/m/front_office_tag_submit.js` | `site/rosters/roster_workbench.js` lines 11075-11330 | Tag/untag payload + submit |
| `site/m/front_office_extend_submit.js` | `site/rosters/roster_workbench.js` lines 10839-10910 + preview reshape | Extension payload + options reshape |
| `site/m/front_office_restructure_submit.js` | `site/rosters/roster_workbench.js` lines 7285-11041 | Restructure calc + payload |

Whenever you edit ANY of the desktop ranges above, you MUST update the corresponding mobile mirror in the same PR. The PR description should call out both files.

## §2 — Active divergences (cross-codebase work needed)

These are known drifts where mobile, desktop, and worker disagree. Every entry here is a future PR.

### 2.1 — WW 35% legacy rate (drop penalty)

- **Canonical** (`docs/league_context_v1.md` §D1.4, effective 2026-05-08): WW $5K+ uses same 75%-guarantee + per-week pro-rated earning as auction.
- **Worker** (`worker/src/lib/cap_penalty.js`): canonical ✓
- **Desktop** (`site/rosters/roster_workbench.js:1896-1908`): legacy 35% flat ✗
- **Mobile** (`site/m/front_office_penalty.js:370-381`): legacy 35% flat ✗ (mirrors desktop)
- **Memory**: `project_ww_penalty_prorate_migration.md` — tabled by Keith 2026-05-15.
- **Drift impact**: −10% to −26% undercharge on WW mid-season cuts vs. what worker actually applies.
- **Required fix**: replace flat 35% with `(salary × 0.75) − earnedPerWeek(...)` on BOTH desktop and mobile. Adopt the worker's `earnedPerWeek(weeks_active, total_eligible_weeks)` directly.

### 2.2 — Calendar-quarter drop earning

- **Canonical** (`docs/league_context_v1.md` §6B, effective 2026-05-08): per-NFL-week pro-rated, denominator = eligible weeks at acquisition.
- **Worker**: canonical ✓
- **Desktop** (`site/rosters/roster_workbench.js:1777-1793` `proratedEarnedForDrop`): 4 calendar milestones (Sep 30, Oct 31, Nov 30, season-end) ✗
- **Mobile** (`site/m/front_office_penalty.js:proratedEarnedForDrop`): same legacy code as desktop ✗
- **Drift impact**: $1-3K overcharge in early season; $1-3K undercharge in late November.
- **Required fix**: Port `worker/src/lib/cap_penalty.js earnedPerWeek` into BOTH client codebases. Add `acquisition_week` to player record so the eligible-weeks denominator is correct.

### 2.3 — Multi-year TCV<$5K → $1K fixed penalty (§D2.4)

- **Canonical** (`docs/league_context_v1.md` §D2.4): if 2+ years remain AND TCV < $5K, penalty is a fixed $1K (overrides standard formula).
- **Worker** (`worker/src/lib/cap_penalty.js multi_year_low_tcv_penalty`): wired ✓
- **Desktop** (`dropPenaltyEstimate`): no check, falls through to standard formula ✗
- **Mobile** (`dropPenaltyEstimate`): same — no check ✗
- **Drift impact**: standard formula can produce $0 or sub-$1K when canonical demands $1K floor.
- **Required fix**: copy `multi_year_low_tcv_penalty` gate from worker into BOTH client codebases as a pre-formula short-circuit.

### 2.4 — 6G.2 three-year contract count uses wrong field

- **Canonical** (`docs/league_context_v1.md` §6G.2): max 6 three-year CONTRACTS per roster (excludes rookies). A "3-year contract" means CL=3 — the contract's full length, regardless of which year a player is currently in.
- **Desktop** (`roster_workbench.js:814-830` `contractLimitSummaryForPlayers`): counts `player.years === 3` (years REMAINING) ✗
- **Mobile** (`site/m/app.js contractLimitsFor`): **FIXED 2026-05-16** to parse `CL N` token from `contractInfo`. INTENTIONAL DIVERGENCE — mobile is correct, desktop still wrong.
- **Drift impact**: desktop's chip currently shows `3Y 0/6` for every team in offseason because no contract has cy=3 right now; mobile correctly shows the 8/8/9 violations for franchises 0006/0009/0012.
- **Required fix**: replace `player.years === 3` with `contractLengthForPlayer(player) === 3` on desktop to converge. The helper already exists in desktop at `roster_workbench.js:1631`.

### 2.5 — §6G compliance is display-only, never blocks

- **Canonical**: §6G caps are HARD rules (max 5 loaded, max 6 three-year, max 4 MYM/season, max 3 restructure/season).
- **Desktop**: displays chips, doesn't block submission. Worker accepts over-cap submissions.
- **Mobile**: now displays chips (2026-05-16), doesn't block.
- **Worker**: no enforcement.
- **Required fix**: choose ONE — either worker-side enforcement (POST handlers count current usage and reject over-cap) OR client-side disabled-submit. The "warning chip + accept" pattern means real violations land silently. Live data already shows three franchises over the 3-year cap.

### 2.6 — Offseason restructure window (§C5.1.b)

- **Canonical**: restructures are OFFSEASON ONLY. Mid-season restructures BANNED.
- **All three codebases**: no enforcement, pure honor system.
- **Required fix**: worker route should reject restructure submissions if `now < season_end OR now > sept_contract_deadline`.

### 2.7 — In-season extension windows (§C4.7)

- **Canonical**: 4-week window for in-season trade-acquired final-year players; 14-28 day window for WW/FCFS pickups (days 1-14 are MYM-only, 15-28 are extension-only).
- **All three codebases**: no date enforcement. Extension submission accepted any time of year if `cy=1`.
- **Required fix**: add `acquisition_date` to extension preview records; client gates submit on `now ∈ window`; worker validates.

### 2.8 — Tag submission season filter

- **Canonical**: a tag is for a specific SEASON. Tags from prior seasons should not surface as currently active.
- **Worker**: writes `ups_tag_submissions` with explicit `season`. ✓
- **Desktop** (`activeTaggedPlayerForTeamSide`): uses `isStaleTagFromPriorSeason` via `tag_tracking.tag_prev_season=1`. ✓ partially correct
- **Mobile** (`trackedTaggedPlayerForFranchiseSide`): **FIXED 2026-05-16** to filter by `currentSeason`. Was missing the filter → Lamar Jackson's 2025 tag from Real Deal Creel surfaced as a 2026 tag.
- **Status**: mobile fixed; desktop has its own (different) filter. Acceptable.

## §3 — INTENTIONAL DIVERGENCES (mobile currently differs from desktop)

| Date | What | Why | When to re-converge |
|---|---|---|---|
| 2026-05-16 | `contractLimitsFor` parses CL from `contractInfo` instead of using `player.years` | Desktop bug returns 0 for every team in offseason; mobile shows real violations | When §2.4 desktop fix lands |

## §4 — Process: how to add a new feature without creating drift

### Step 1 — Read the rule

Before touching code, open `docs/league_context_v1.md` and find the canonical §. Read it FULLY. The rule book is the source of truth, not your memory of how things worked.

### Step 2 — Map to the three implementations

For any rule:

```
Canonical (league_context_v1.md §X)
       ↓
Worker (worker/src/lib/ or worker/src/index.js handler)
       ↓
Desktop client (site/rosters/roster_workbench.js OR site/team_operations/team_operations.js)
       ↓
Mobile client (site/m/front_office_*.js)
```

When you change rule logic, you change ALL FOUR locations in lockstep:
- Update the rule in `league_context_v1.md` if the canonical interpretation is changing
- Update the worker enforcement
- Update the desktop client display + preview
- Update the mobile client mirror

If the change touches just one of these, you're creating drift. Document it in §3 above with a re-converge plan.

### Step 3 — Write the code with a header citation

Every mobile mirror function carries a header comment citing the desktop source:

```javascript
// Verbatim mirror of roster_workbench.js:1168-1288. The "Ext:" token in
// contractInfo holds the UPS FRANCHISE that previously extended the
// player...
```

If your mirror diverges from the cited source, add the `INTENTIONAL DIVERGENCE` comment block and update §3.

### Step 4 — Verify with real data

Mobile bugs are caught by running against real league 74598 data:

```bash
curl -s "https://upsmflproduction.keith-creelman.workers.dev/api/mfl-export?TYPE=salaries&L=74598&YEAR=2026&JSON=1" > /tmp/sal.json
curl -s "https://upsmflproduction.keith-creelman.workers.dev/api/mfl-export?TYPE=rosters&L=74598&YEAR=2026&JSON=1" > /tmp/rosters.json
curl -s "https://upsmflproduction.keith-creelman.workers.dev/api/mfl-export?TYPE=league&L=74598&YEAR=2026&JSON=1" > /tmp/league.json
curl -s "https://keithcreelman.github.io/upsmflproduction/ccc/tag_tracking.json" > /tmp/tag_tracking.json
curl -s "https://keithcreelman.github.io/upsmflproduction/ccc/tag_submissions.json" > /tmp/tag_submissions.json
```

Run your logic against these in Node and compare against what the worker would charge. If you can't write the verification, you're not done.

### Step 5 — Add the rule to this doc

If you found a NEW drift point (not in §2), add it. If you fixed one, move it to §3 (intentional divergence) or remove it (cross-codebase converged).

## §5 — Audit cadence

Run a full 7-agent audit (the one from 2026-05-16) before any major release:

```
Agent A: docs/league_context_v1.md rules catalog
Agent B: Tag (§C8) rules vs code vs real data
Agent C: Extension (§C4) rules vs code vs real data
Agent D: Restructure (§C5)
Agent E: Drop penalty (§D1/§D2/§6B)
Agent F: Cap (§6A/§6B/§6C/§6E)
Agent G: §6G cross-section caps + lineup + MYM + rookie option + trade
```

Each agent fetches real data (worker URLs above), compares against canonical rules, reports drift. The audit takes ~15 minutes and surfaces every drift before users hit it.

## §6 — Open questions / known unknowns

- **MYM 4-per-season enforcement**: nowhere in code. Honor system. Should it be worker-enforced?
- **Calvin Johnson comp pick** automation: §D2.6 awards comp picks for tier-1 retired players. Currently 100% commissioner-side. Should the worker compute eligibility automatically?
- **Pre-2019 contract era handling**: drop penalty formula differs (see `mfl_pre2019_no_low_tcv_1k_rule.md`). Worker handles via era branch; clients don't. Affects HISTORICAL display only, not new submissions.
- **Trade cap-money 50% rule**: confirmed enforced on desktop trade workbench. Mobile defers to desktop (no offer creation). Worker enforcement?

When you have an answer, update this section and migrate the resolution into §2 or §3.

## Pointer: when in doubt

- Rule unclear? Read `docs/league_context_v1.md`.
- Code unclear? `roster_workbench.js` is canonical CLIENT code; `worker/src/lib/cap_penalty.js` is canonical CAP code.
- Behavior unclear? Run the live worker against real data and observe.
- Drift between desktop/mobile? Open this doc. Add a row.
