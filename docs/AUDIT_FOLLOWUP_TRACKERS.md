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

### Q6 — Trade cap-money 50% rule: worker-side backstop ⏳

**Canon:** `docs/league_context_v1.md §6.E1`. UPS-owned (NOT MFL-enforced).

**Current state:** client-side only — `site/trades/trade_workbench.js:4220` (max calc) + `:5237-5238` (validation).

**Work:**
- Identify the worker trade-submit endpoint (likely under `worker/src/index.js` — search for `trade` + `salary_adjustment`).
- Re-implement the same `floor(sumNonTaxiSalary / 2000)` rule at the worker boundary; reject submissions exceeding the per-side max.
- Add an integration test that sends a known-overcap trade payload and asserts rejection.

**Out of scope:** rewriting the client max calc; it's correct.

---

### Q8 — Standings tiebreaker follow-ups 🚧 (Option A approved, PR #220 in flight)

**Canon:** `docs/league_context_v1.md §F.2` (added 2026-05-16, updated 2026-05-17 to record Option A as canon). See also §F.1.

**Decision (Keith 2026-05-17):** Option A approved — standings-page sort matches §F.1 playoff-seeding ladder.

**Shipped (pending #220 merge):**
- Recommendation doc: PR #216 → [docs/Q8_STANDINGS_SORT_RECOMMENDATION.md](Q8_STANDINGS_SORT_RECOMMENDATION.md).
- Code fix: PR #220 — `worker/src/index.js:3410` `ORDER BY s.allplay_pct DESC, s.h2h_pct DESC, s.pf DESC`; wild-card pool sort at `:3635` aligned to AP% → Overall → PF; canon §F.2 updated with the standings-page-sort row + a load-bearing schema note (`s.h2h_pct` is the overall record despite the column name).

**Open sub-task:** verify current MFL `standingsSort` and capture it season-by-season if drift surfaces. Not blocking the main fix.

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
| Q10 — Taxi call-up counter | [#218](https://github.com/keithcreelman/upsmflproduction/pull/218), [#221](https://github.com/keithcreelman/upsmflproduction/pull/221) | 2026-05-17 |
| Q11 — R6 IDP-only worker block | [#213](https://github.com/keithcreelman/upsmflproduction/pull/213) | 2026-05-17 |
| Q12 — R1 active-only demote rejection | [#214](https://github.com/keithcreelman/upsmflproduction/pull/214) | 2026-05-17 |
| Q14 — Restructure D1 audit table | [#215](https://github.com/keithcreelman/upsmflproduction/pull/215) | 2026-05-17 |

**In flight:** Q8 standings sort code fix — [#220](https://github.com/keithcreelman/upsmflproduction/pull/220) (Option A approved by Keith 2026-05-17; pending merge).

**Deferred:** Q5 IR 50% relief — see [docs/Q5_IR_50_PERCENT_RELIEF_DEFERRED.md](Q5_IR_50_PERCENT_RELIEF_DEFERRED.md).
