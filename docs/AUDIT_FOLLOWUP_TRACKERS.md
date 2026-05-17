# Audit Follow-up Trackers (post-§6 Keith review session, 2026-05-16)

**Source:** the 7-agent cross-codebase alignment audit (commit `de9c782`, PR #210) raised 16 open questions; Keith resolved them in the 2026-05-16 review session. Each row below is an **implementation item** or **investigation** to spin off as a separate PR/session. **This file is NOT for cap-penalty Stage B/C work** — that lives in `CURRENT_WORK_HANDOFF.md`.

**How to use:**
- Pick a tracker, read its row, open `docs/league_context_v1.md` to the canon section it cites, then plan the work.
- Mark a tracker **Done** with a link to the merge commit/PR once shipped.
- New trackers from later audit passes can be appended below.

**Status legend:** ⏳ Pending · 🚧 In progress · ✅ Done · 🟡 Parked

---

## Trackers

### Q2 — Ext2 FL/BL suffix auto-derivation ✅ (PR #217, merged 2026-05-17)

**Canon:** `docs/league_context_v1.md §C4.3` ("the extension submitter should **auto-derive** the `-FL` / `-BL` suffix from the per-year salary array").

**Shipped:** desktop `deriveExtensionLoadingSuffix` + `applyExtensionLoadingSuffix` helpers in `site/rosters/roster_workbench.js` wired into `submitExtensionUpdate`; worker `/commish-contract-update` has defense-in-depth normalization. Algorithm: 2-yr extension → compare `yMap[cy-1]` vs `yMap[cy]` (the extension years); Y1>Y2 → `-FL`, Y1<Y2 → `-BL`, flat → plain `EXT2`. Mobile has no extension submitter today; when it lands, it should call the same helpers.

**Open:** historical backfill of pre-fix EXT2 contracts (not addressed; handle separately if a count-by-loading audit surfaces missed BL contracts).

---

### Q5 — IR 50% cap relief live verification 🟡 (Deferred — no eligible player, PR #219)

**Canon:** `docs/league_context_v1.md §B3` — "$20K salary → $10K cap hit while on IR." Live-trace deferred per Keith 2026-05-16 (no current UPS player on IR).

**Status:** doc-only deferral note in [docs/Q5_IR_50_PERCENT_RELIEF_DEFERRED.md](Q5_IR_50_PERCENT_RELIEF_DEFERRED.md). Reopen the moment a UPS player IRs.

**Work (do the next time a UPS player IRs):**
1. Note the player's salary pre-IR.
2. Capture the team's `available_cap` pre-IR.
3. Submit the IR designation (or wait for MFL ingest).
4. Capture `available_cap` post-IR.
5. Confirm the delta = exactly 50% × salary.
6. Trace which code path produced the delta — `worker/src/lib/...` cap math, `site/team_operations/team_operations.js renderCaps`, `site/m/front_office_cap.js`. Cite file:line in `MOBILE_DRIFT_PREVENTION.md` or audit doc.

**Done when:** one verified IR event has been traced and reported; if a drift surfaces, file a fix PR.

---

### Q6 — Trade cap-money 50% rule: worker-side backstop ✅ (PR #225)

**Canon:** `docs/league_context_v1.md §6.E1`. UPS-owned (NOT MFL-enforced).

**Shipped:**
- PR #225 — adds the `floor(sumNonTaxiSalary / 2000)` enforcement to `worker/src/index.js` `/api/trades/proposals` POST. Resolves live non-taxi salaries from the rosters export (can't trust client-supplied values; the offer-token rebuild path posts salary=0). Rejects with HTTP 400 `TRADE_CAP_MONEY_50PCT` when violated. Fails open on rosters-fetch crash to avoid breaking legitimate submits.

---

### Q8 — Standings tiebreaker follow-ups ✅ (corrected — playoff-seed sort, PR #223)

**Canon:** `docs/league_context_v1.md §F.2` (added 2026-05-16, updated 2026-05-17). See also §F.1.

**Decision history:**
- 2026-05-17 morning — Option A approved (AP%-only ORDER BY). Shipped as PR #220.
- 2026-05-17 afternoon — Keith corrected: standings page should mirror the playoff bracket. "During the season it should be sorted by who is in the playoffs vs who is not regardless of AP; a div winner would get in over a higher AP team but seeding is AP." Option A reverted; replaced with playoff-seed-based post-sort.

**Shipped:**
- PR #216 — recommendation doc.
- PR #220 — Option A code fix (superseded).
- PR #223 — corrected: drops the SQL `ORDER BY` and adds a JS post-sort that ranks playoff teams (top-2 DW seeds 1-2 + remaining-2-DW + top-2 WC at seeds 3-6) ahead of non-playoff teams. Each row now carries `playoff_seed` / `playoff_status` / `is_wild_card` fields.

**Open sub-task:** verify current MFL `standingsSort` and capture it season-by-season if drift surfaces. Not blocking.

---

### Q10 — Taxi call-up counter + auto-promotion (UPS-owned) ✅ (PRs #218 + #221, merged 2026-05-17)

**Canon:** `docs/league_context_v1.md §B2` (UPDATED 2026-05-08, re-confirmed 2026-05-16). 3 total call-ups across the 3-year taxi-eligibility window (NOT per-season). 4th = permanent promotion.

**Shipped:**
- **PR #218** — migration `0048_taxi_callups.sql` + worker increment on `/roster-workbench/action` `promote_taxi` + `/roster-workbench` GET payload exposing `taxi_callups_used / taxi_callups_max / taxi_permanent_promotion` per player + desktop UI ("Taxi · N/3" chip, "Promoted" tag once permanent).
- **PR #221** — demote-side `became_permanent` guard (rejects demote_taxi with `TAXI_PERMANENTLY_PROMOTED`); `demoted_at` close-out on successful demote; new `GET /api/taxi-callups` endpoint; mobile UI for the counter (`site/m/views/contracts.js` + `M.data.taxiCallupsFor`).

**Test cases:** see PR descriptions. Live-test path: click "Promote From Taxi" on a desktop player row → row flips to "Taxi · 1/3" after refresh. 4th promote on the same player → "Promoted" badge + future `demote_taxi` rejected.

---

### Q11 — Round 6 IDP-only worker block ✅ (PR #213, merged 2026-05-17)

**Canon:** `docs/league_context_v1.md §A1 Round 6` (updated 2026-05-16 with historical precedent).

**Shipped:** worker `/api/pick` rejects R6 selections whose `player.position` ∈ `{QB, RB, WR, TE, PK, PN}` with HTTP 400 `R6_IDP_ONLY`. Error message surfaces the historical-precedent penalty (commissioner reverses + team forfeits the pick). Applies before both sim and live MFL write paths.

**Open:** live-test once the 2026 rookie draft happens (Memorial Day Sunday 2026-05-24). No UI gate added — the desktop/mobile draft UI submits through `/api/pick`; worker block is the binding gate.

---

### Q12 — Round 1 active-only lock (demote-to-taxi reject) ✅ (PR #214, merged 2026-05-17)

**Canon:** `docs/league_context_v1.md §A1 Round 1` (updated 2026-05-16).

**Shipped:** new `demote_taxi` action added to `/roster-workbench/action` (sibling of `promote_taxi` / `activate_ir` / `drop_player`), gated by `_checkR1RookieDemoteGate` helper. Helper does rosters + draftResults lookups across last 4 seasons; rejects with HTTP 400 `R1_ACTIVE_ONLY` on positive R1 + Rookie-contract match. Fail-open if either lookup misses so transient MFL hiccups don't break legitimate non-R1 demotes.

**Open:** no UI gate added — desktop/mobile UI currently exposes no demote button; worker block is the future-proof backstop.

---

### Q13 — Tag WW players → $1K floor (rule proposal) 🟡

**Canon:** `docs/league_context_v1.md §C8` (added 2026-05-16) documents current behavior + parked status.

**Work (Keith owns the rule-proposal pipeline; coding waits on passage):**
1. Keith drafts the formal rule proposal: "When a player's prior contract was WW, treat prior AAV as $1K for the `prior AAV × 1.10` tag bump." (Or whatever final text reads.)
2. Submit via the league's rule-proposal/vote pipeline.
3. On passage:
   - Update `league_context_v1.md §C8` to incorporate the rule explicitly (replace the "proposed rule" paragraph with the canonical text).
   - Reconcile `pipelines/etl/scripts/build_tag_tracking.py` — the existing `blocked` set at lines 436-457 may already satisfy the rule, or a new `$1K floor` clamp may be needed depending on final wording.
   - Add a worker-side validation if tag salary calc moves server-side.

**Current implementation reference (don't modify until passage):** `build_tag_tracking.py:436-457` — `should_use_prior_aav()` blocks `WW`, `WAIVER`, `FA`, `FREE`, `BL` from `prior_aav_map`.

---

### Q14 — Restructure D1 audit table ✅ (PR #215, merged 2026-05-17)

**Canon:** `docs/league_context_v1.md §C5` (updated 2026-05-16).

**Shipped:** migration `0047_restructure_submissions.sql` (mirrors `ups_extension_submissions` shape, with restructure-specific JSON-array per-year salary columns + TCV/AAV). Worker `/commish-contract-update` + `/offer-restructure` INSERTs a row when `isRestructure && looksOk && anyChanged`. No master table on this side — restructures don't change contract identity the way an extension does; current-state mirror remains the rosters/salaries payload.

**Open:** historical restructure backfill from old event logs (PR description flagged this as a separate decision — needs Keith's call).

---

### Q17 — Ext2 Front-load / Back-load UI (front-end wiring) ⏳ (new 2026-05-17)

**Canon:** `docs/league_context_v1.md §C4.3`. Q2's auto-derive logic (PR #217) is in place but is currently a **no-op in production** because the front-end can't actually submit a non-flat extension.

**Current state:**
- `site/rosters/roster_workbench.js synthesizeExtensionOption` (lines 1298-1355) emits a **flat** Y-array (Y1=current_salary, Y2..N=future_aav). No FL/BL option exposed.
- `pipelines/etl/scripts/export_extension_previews_json.py:155-204` — upstream preview pipeline also emits flat. The `loaded_indicator` column in `extension_previews` is always `NONE`.
- Q2's worker normalization at `worker/src/index.js` `/commish-contract-update` is correct but never fires (every Ext2 contract that reaches the worker is flat).

**Work:**
1. Desktop UI — add a "Flat / Front-load / Back-load" toggle (or three explicit options) to the extension submit modal. When the owner picks FL/BL, optionally let them customize Y1/Y2 amounts (or use a canonical 80/20 split).
2. `synthesizeExtensionOption(player, yearsToAdd, loadingChoice)` — accept the third arg and emit the correct Y-array.
3. Worker (`/commish-contract-update`) — already handles the suffix derivation; no change needed.
4. Mobile — extension submit doesn't exist yet (see Q19 below) — bundle the FL/BL UI when that lands.
5. Test the LaPorta example end-to-end: Y1-\$10K / Y2-\$40K → `EXT2-BL` lands in MFL.

**Out of scope:** historical backfill of pre-fix flat EXT2 contracts.

---

### Q18 — Mobile promote-from-taxi (UI not wired) ⏳ (new 2026-05-17)

**Canon:** `docs/league_context_v1.md §B2`. Companion to Q10.

**Current state:**
- Worker has `/roster-workbench/action` `action=promote_taxi` (+ `demote_taxi` from Q12) wired.
- Desktop has the **Promote From Taxi** button at `site/rosters/roster_workbench.js:11732` (`data-action="promote-taxi-player"`).
- Mobile has **no promote/demote button** in the taxi pane.

**Work:**
- Mobile player sheet (`site/m/player_sheet.js`) — add Promote button when player isTaxi && ownsPlayer; wire to `/roster-workbench/action` `action=promote_taxi`.
- Mobile player sheet — add Demote button when player !isTaxi && taxi-eligible && ownsPlayer; wire to `/roster-workbench/action` `action=demote_taxi`.
- Surface the same counter chip ("Used N/3") on the mobile taxi card.

---

### Q19 — Promote-from-taxi MFL write not landing (bug) ⏳ (new 2026-05-17)

**Canon:** `docs/league_context_v1.md §B2`. Reported by Keith 2026-05-17.

**Symptom:** clicking **Promote From Taxi** on a desktop player row returns a success response from `/roster-workbench/action`, but the player **does not actually get promoted on MFL** (still shows as TAXI_SQUAD on subsequent rosters fetch).

**Hypothesis:**
- The MFL `TYPE=taxi_squad&PROMOTE=<pid>` import call may need additional fields (FRANCHISE_ID, etc.) that aren't being sent.
- Or the verification step (`verifyRes.ok && status === 'ROSTER'`) is reading a stale rosters cache.
- Or MFL is silently rejecting the import for a reason that doesn't show in the worker's request_ok check.

**Work:**
1. Reproduce: pick a taxi player (e.g., one of the December 2025 promotes — Kyle Williams or James Pearce), click Promote, check tail logs.
2. Capture the worker's `importRes` (request_ok, status, upstreamPreview, targetImportUrl, form_fields) and the post-import rosters payload.
3. Compare against a successful MFL UI promotion (manually trigger one, capture the network call from MFL's own form).
4. Patch the worker call to match.

**Test cases (historical, from Keith 2026-05-17):** Sex Manther / Williams, Kyle (NEP WR, Dec 27 2025); Real Deal Creel / Pearce, James (ATL DE, Dec 26 2025).

---

### Q20 — Taxi call-up counter increment semantics (active-for-a-week) ⏳ (new 2026-05-17)

**Canon:** `docs/league_context_v1.md §B2` — "Active for the week" definition: the player was on the active roster (or on IR) at the time rosters and lineups locked for that NFL week, and appears in that week's weekly results.

**Current implementation (Q10 PR #218):** Worker increments `ups_taxi_callups` on every `promote_taxi` action.

**Bug (Keith 2026-05-17):** A click-through promote that's reversed before NFL rosters lock should NOT burn a call-up. The counter should only increment after the player is "active for a week" — i.e., after MFL weeklyresults shows them on the active lineup for a locked week.

**Work:**
1. New worker cron / scheduled job — after each NFL week's results land, walk MFL `TYPE=weeklyresults` for all rostered players. For each promoted-from-taxi player who was on active roster AND appears in weeklyresults: increment their `ups_taxi_callups` counter for that week.
2. Remove (or repurpose) the per-action increment in `/roster-workbench/action promote_taxi` — it can still log the intent but should NOT set `callup_index`. Maybe a `pending=1` flag until weeklyresults confirms.
3. Backfill from 2025 weeklyresults (test cases: Kyle Williams, James Pearce).

**Companion:** demote-before-lock should NOT burn a call-up either. The cron approach handles this naturally — only weeklyresults presence counts.

---

### Q21 — Tre Harris / Isaac TeSlaa expired-rookie bug (taxi contract metadata fallback) ✅ (PR #224)

**Canon:** `docs/league_context_v1.md §A1`. Mirror of `site/rosters/roster_workbench.js repairTaxiContractFallbacks`.

**Bug:** MFL's API suppresses `contractYear`, `contractStatus`, `contractInfo` for TAXI-squad players → UPS worker reads empty → coerces to 0 → surfaces as "expired". Affected all 22 taxi players in the snapshot, including Tre Harris (PID 17072) and Isaac TeSlaa (PID 17157).

**Shipped:**
- PR #224 — worker `/roster-workbench` payload + `parsePlayersExport` capture `draft_year`; per-player object infers years remaining from `3 - (currentSeason - draftYear)` when MFL is silent. Synthesizes `CL N|TCV M|AAV K|Y1-K,...` contractInfo when salary is known. Mobile `site/m/app.js repairTaxiContractsInPlace` walks `state.rosters` after the fetch and applies the same mutation.

---

### Q22 — Player headshots: high-res ESPN + add to mobile ✅ (PR #226)

**Reported (Keith 2026-05-17):** desktop modal headshots are pixelated (110×110 MFL `_thumb.jpg` upscaled on retina). Mobile player sheet has no headshot.

**Shipped:**
- PR #226 — worker payload includes `espn_id`; desktop modal builds a photo chain (ESPN → MFL thumb → placeholder); mobile sheet adds a 56×56 circle in the head row with the same chain.

---

## Parking lot (no implementation tracker; canon already captures the deferral)

- **Q4 cap floor/ceiling tooling:** parked under auction-tooling discussion (`CROSS_CODEBASE_ALIGNMENT.md §4.1`).
- **Q7 27-active/30-max safeguards:** parked under auction tooling (§4.1).
- **Q15 Late dues + missed-nomination fines:** legacy; pending broader overhaul discussion with Keith.
- **Q16 Auction Room scope:** scope undecided; Keith will circle back.

---

## Done

| Tracker | PR(s) | Merge date |
|---|---|---|
| Q2 — Ext2 FL/BL suffix auto-derivation | [#217](https://github.com/keithcreelman/upsmflproduction/pull/217) | 2026-05-17 |
| Q6 — Trade cap-money 50% worker backstop | [#225](https://github.com/keithcreelman/upsmflproduction/pull/225) | 2026-05-17 |
| Q8 — Standings sort (corrected: playoff seed) | [#223](https://github.com/keithcreelman/upsmflproduction/pull/223) | 2026-05-17 (supersedes #220) |
| Q10 — Taxi call-up counter | [#218](https://github.com/keithcreelman/upsmflproduction/pull/218), [#221](https://github.com/keithcreelman/upsmflproduction/pull/221) | 2026-05-17 |
| Q11 — R6 IDP-only worker block | [#213](https://github.com/keithcreelman/upsmflproduction/pull/213) | 2026-05-17 |
| Q12 — R1 active-only demote rejection | [#214](https://github.com/keithcreelman/upsmflproduction/pull/214) | 2026-05-17 |
| Q14 — Restructure D1 audit table | [#215](https://github.com/keithcreelman/upsmflproduction/pull/215) | 2026-05-17 |
| Q21 — Tre Harris / TeSlaa expired-rookie fix | [#224](https://github.com/keithcreelman/upsmflproduction/pull/224) | 2026-05-17 |
| Q22 — High-res headshots + mobile sheet | [#226](https://github.com/keithcreelman/upsmflproduction/pull/226) | 2026-05-17 |

**Open work:** Q17 (Ext2 FL/BL UI), Q18 (mobile promote-from-taxi UI), Q19 (promote MFL-write bug), Q20 (counter semantics — active-for-a-week).

**Deferred:** Q5 IR 50% relief — see [docs/Q5_IR_50_PERCENT_RELIEF_DEFERRED.md](Q5_IR_50_PERCENT_RELIEF_DEFERRED.md).
