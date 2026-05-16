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

### 2.4 — §6G compliance is display-only, never blocks

- **Canonical**: §6G caps are HARD rules (max 5 loaded, max 6 three-year, max 4 MYM/season, max 3 restructure/season).
- **Desktop**: displays chips, doesn't block submission. Worker accepts over-cap submissions.
- **Mobile**: now displays chips (2026-05-16), doesn't block.
- **Worker**: no enforcement.
- **Required fix**: choose ONE — either worker-side enforcement (POST handlers count current usage and reject over-cap) OR client-side disabled-submit. The "warning chip + accept" pattern means real violations land silently. Live data already shows three franchises over the 3-year cap.

### 2.5 — Offseason restructure window (§C5.1.b)

- **Canonical**: restructures are OFFSEASON ONLY. Mid-season restructures BANNED.
- **All three codebases**: no enforcement, pure honor system.
- **Required fix**: worker route should reject restructure submissions if `now < season_end OR now > sept_contract_deadline`.

### 2.6 — In-season extension windows (§C4.7)

- **Canonical**: 4-week window for in-season trade-acquired final-year players; 14-28 day window for WW/FCFS pickups (days 1-14 are MYM-only, 15-28 are extension-only).
- **All three codebases**: no date enforcement. Extension submission accepted any time of year if `cy=1`.
- **Required fix**: add `acquisition_date` to extension preview records; client gates submit on `now ∈ window`; worker validates.

### 2.7 — Tag submission season filter

- **Canonical**: a tag is for a specific SEASON. Tags from prior seasons should not surface as currently active.
- **Worker**: writes `ups_tag_submissions` with explicit `season`. ✓
- **Desktop** (`activeTaggedPlayerForTeamSide`): uses `isStaleTagFromPriorSeason` via `tag_tracking.tag_prev_season=1`. ✓ partially correct
- **Mobile** (`trackedTaggedPlayerForFranchiseSide`): **FIXED 2026-05-16** to filter by `currentSeason`. Was missing the filter → Lamar Jackson's 2025 tag from Real Deal Creel surfaced as a 2026 tag.
- **Status**: mobile fixed; desktop has its own (different) filter. Acceptable.

### 2.8 — Lineup audit trail + DM-based notification (Keith 2026-05-16)

- **Current state**: lineup submissions are written to MFL but skip BOTH D1 audit and Discord (this used to be tracked as "parity by design"). The desktop site also skips them. Reason historically: weekly lineup churn would flood the contract-activity channel and bloat audit tables.
- **Keith's call (2026-05-16)**: this is the wrong shape. We should:
  1. Write every lineup submission to D1 for validation + cross-reference against MFL data. If MFL doesn't carry an authoritative copy, our D1 row IS the record of truth. Without it we can't catch missed lineups, late edits, or compliance issues.
  2. Replace the "broadcast to contract-activity" approach with **Discord DMs**:
     - Submitter gets an acknowledgement DM ("Your lineup for Week N is locked")
     - The submitter's **weekly opponent(s)** get a DM notification ("X has set their lineup")
     - NO channel post — keeps the contract-activity channel clean.
- **Why this works**: DMs scale linearly with active matchups (one to submitter, one to opponent), so the volume is bounded; meanwhile every action is traceable in D1.
- **Required work** (parked for later — explicit "save for later" from Keith):
  - **Worker**: add audit write in the `/api/submit-lineup` handler — new D1 table `ups_lineup_submissions` (or extend `salary_change_log` with a kind column) capturing `franchise_id`, `season`, `week`, `starters[]`, `submitted_at_utc`, `source` (`ups-mobile-*` vs `front-office-*`).
  - **Worker**: send DM via Discord bot to submitter's discord_id + each opponent's discord_id (lookup needs a `franchise_id → discord_user_id` map — verify what's stored where).
  - **Worker**: schedule-aware — only the most-relevant opponent per week (MFL's `schedule` export).
  - **Doc**: once shipped, update §7 below and remove the "parity by design" note from the lineup row.
- **Generalize**: while we're at it, audit every submission path. If any other action is currently NOT written to D1, fix it — the principle is "every submission is recorded for x-reference vs MFL." Lineup is the most obvious gap; others may exist.

## §3 — INTENTIONAL DIVERGENCES (mobile currently differs from desktop)

| Date | What | Why | When to re-converge |
|---|---|---|---|
| _(none currently — mobile is in lock-step with desktop)_ | | | |

### Lesson: the 6G.2 false-alarm (2026-05-16)

During the 2026-05-16 audit I (Claude) initially flagged the 3-year contract count as a desktop bug because the chip showed `0/6` for every team while my parse of `CL=3` from `contractInfo` showed 8/8/9 for some teams. I "fixed" mobile to count by `CL` length, called it an intentional divergence, and shipped.

**Keith corrected this:** the canonical rule is "max 6 active 3-year contracts" meaning **years remaining = 3** — i.e. freshly-signed 3-year MYACs that haven't played a year yet. A 3-year deal signed in 2025 has `years=2` heading into 2026 and stops counting. Pre-FA-auction in any given year the count is always 0 because no fresh 3-year deals exist yet. This is why Keith said "impossible currently."

The fix-that-wasn't-a-bug was reverted. Desktop's `safeInt(player.years, 0) === 3` IS canonical.

**Takeaway for future drift hunts:** when a rule produces a "surprising" count in the offseason, read the rule again before "fixing" it. Counts that look "wrong" often reflect the natural rollover of contracts as years tick down, which IS the intended throttle. Always confirm with Keith before declaring an intentional divergence.

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
- ~~**Taxi player salary display**~~ — **RESOLVED on mobile (2026-05-16)** via §A1.4 rookie-salary derivation. Direct parse of `drafted: "R.PP (YYYY)"` for franchise-drafted taxi (74% of live data), plus pid-keyed lookup against past 3 years of draftResults for trade-acquired taxi (25%). 100% coverage of all 85 current taxi players. See `app.js rookieSalaryForPick` + `deriveTaxiSalary`. **Cross-codebase note**: desktop's `roster_workbench.js` also shows $0 for taxi salaries — would benefit from the same derivation logic. Filed as a future desktop fix.
- ~~**Mobile as default landing page**~~ — **RESOLVED 2026-05-16**. `site/index.html` is the new Pages root: UA-detects phone/tablet and auto-redirects to `/m/` after a 2-second grace period; user can tap "Open Desktop Site" to override. The `footer_custom_v2.html` (loaded on every MFL desktop page) now ships a fixed-position "📱 Switch to App View" button that's hidden by default and shown via `@media (max-width: 768px)` — so it only appears when MFL is rendering on a mobile viewport. Button preserves `L=` + `YEAR=` from the current MFL URL when deep-linking to `/m/`.

When you have an answer, update this section and migrate the resolution into §2 or §3.

## §7 — Submit-path wiring (Keith 2026-05-16)

Confirmation table of every mobile-originating action and whether it hits all four canonical targets:

| Mobile action | MFL write | D1 audit | Discord post | Cap-penalty cron |
|---|---|---|---|---|
| Drop | ✓ `import?TYPE=taxi` (worker) | ✓ `salary_change_log` | ✓ via hourly cap-penalty cron | ✓ deduped by ledger_key |
| On the Block (add/remove/note) | ✓ `import?TYPE=tradeBait` | ✓ `ups_trade_bait_notes` | ✓ OTB war-room channel | n/a |
| Tag | ✓ `load_player` + `commish-contract-update` | ✓ `ups_tag_submissions` + `ups_tag_master` | ✓ contract-activity channel | n/a |
| Untag | ✓ `commish-contract-update` | ✓ tag tables | ✓ contract-activity channel | n/a |
| Extension | ✓ `import?TYPE=salaries` via `/offer-extension` | ✓ `ups_extension_submissions` + `ups_extension_master` | ✓ contract-activity channel | n/a |
| Restructure | ✓ `import?TYPE=salaries` via `/offer-restructure` | ✓ `salary_change_log` | ✓ contract-activity channel | n/a |
| Submit Lineup | ✓ `import?TYPE=lineup` (`/api/submit-lineup`) | ✗ no audit **(planned: add D1 audit — see §2.8)** | ✗ no announcement **(planned: replace with DMs to submitter + weekly opponent — see §2.8)** | n/a |
| Draft Pick | ✓ `import?TYPE=draftResults` | ✓ `draft_audit` | ✓ live/test draft channel | n/a |
| Trade Accept/Decline/Cancel | ✓ via `runDirectProposal` | ✓ trade audit tables | ✓ trade channel (live, fires on accept) | n/a (cap settlement separate) |

**Discriminator:** every mobile payload sends `source: "ups-mobile-*"` in the audit body. Desktop sends `source: "front-office-*"`. Worker handler reads either and routes identically — same MFL writes, same D1 rows, same Discord. The `source` field is purely forensic.

**Lineup currently skips audit + Discord** — historically rationalized as "parity by design" with desktop. **Keith retired that rationale on 2026-05-16**: every submission should be written to D1 for x-reference vs MFL, and lineup notifications should fan out as Discord DMs (submitter + weekly opponent) instead of channel posts. See §2.8 for the full migration plan. Currently parked; ship later.

## Pointer: when in doubt

- Rule unclear? Read `docs/league_context_v1.md`.
- Code unclear? `roster_workbench.js` is canonical CLIENT code; `worker/src/lib/cap_penalty.js` is canonical CAP code.
- Behavior unclear? Run the live worker against real data and observe.
- Drift between desktop/mobile? Open this doc. Add a row.
