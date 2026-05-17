# Audit Follow-up Trackers (post-§6 Keith review session, 2026-05-16)

**Source:** the 7-agent cross-codebase alignment audit (commit `de9c782`, PR #210) raised 16 open questions; Keith resolved them in the 2026-05-16 review session. Each row below is an **implementation item** or **investigation** to spin off as a separate PR/session. **This file is NOT for cap-penalty Stage B/C work** — that lives in `CURRENT_WORK_HANDOFF.md`.

**How to use:**
- Pick a tracker, read its row, open `docs/league_context_v1.md` to the canon section it cites, then plan the work.
- Mark a tracker **Done** with a link to the merge commit/PR once shipped.
- New trackers from later audit passes can be appended below.

**Status legend:** ⏳ Pending · 🚧 In progress · ✅ Done · 🟡 Parked

---

## Trackers

### Q2 — Ext2 FL/BL suffix auto-derivation ⏳

**Canon:** `docs/league_context_v1.md §C4.3` ("the extension submitter should **auto-derive** the `-FL` / `-BL` suffix from the per-year salary array").

**Gap:** Desktop's `playerExtensionOptions` (`site/rosters/roster_workbench.js`) leaves `contractStatus` as plain `EXT2` regardless of Y1/Y2 distribution. Mobile mirror has the same gap.

**Work:**
- Add a `deriveExtensionLoadingSuffix(years, year_salaries)` helper that returns `"-FL"` (Y1 > Y2), `"-BL"` (Y1 < Y2), or `""` (Y1 = Y2).
- Apply in:
  - Desktop: `site/rosters/roster_workbench.js submitExtensionUpdate`.
  - Mobile: `site/m/front_office_extend_submit.js`.
  - Any other extension submit path (search worker too in case it normalizes there).
- Worker should also normalize/validate the suffix on `/commish-contract-update` for `submission_kind=extension`.
- Test cases: `[10, 40]` → `-BL`; `[40, 10]` → `-FL`; `[25, 25]` → no suffix.

**Out of scope:** historical backfill of pre-fix EXT2 contracts (handle separately if needed).

---

### Q5 — IR 50% cap relief live verification ⏳

**Canon:** `docs/league_context_v1.md §B3` — "$20K salary → $10K cap hit while on IR." Live-trace deferred per Keith 2026-05-16 (no current UPS player on IR).

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

### Q8 — Standings tiebreaker follow-ups 🔵 (investigation + possible code-fix)

**Canon:** `docs/league_context_v1.md §F.2` (added 2026-05-16) separates the two concepts. See also §F.1.

**Sub-tasks:**

1. **Verify current MFL `standingsSort`** for the active season.
   - Pull `TYPE=league` from MFL API for the current `league_id`.
   - Capture the `standingsSort` string verbatim (e.g., `PCT,DIVPCT,H2H,PTS,ALL_PLAY_PCT,PWR`).
   - Add it to `league_context_v1.md §F.2` (or a season-by-season table if the value has drifted).

2. **Decide standings-page sort.** `worker/src/index.js:3339` uses `ORDER BY s.h2h_pct DESC, s.allplay_pct DESC, s.pf DESC` for the full league standings page. This is **neither** the division-leader logic (which uses `standingsSort`) **nor** the playoff-seeding logic (AP% → PF → H2H per §F.1).
   - Question for Keith: should the standings-page sort align with §F.1 (AP% → PF → H2H), with the year's MFL `standingsSort`, or remain as-is?
   - If alignment is wanted, file a code-fix PR.

**Out of scope:** the division-leader code path and the wild-card pool code path are both correct against canon as documented in §F.2.

---

### Q10 — Taxi call-up counter + auto-promotion (UPS-owned) ⏳

**Canon:** `docs/league_context_v1.md §B2` (UPDATED 2026-05-08, re-confirmed 2026-05-16). 3 total call-ups across the 3-year taxi-eligibility window (NOT per-season). 4th = permanent promotion.

**Work (UPS owns end-to-end; MFL does not enforce):**

1. **Schema:** new D1 table `ups_taxi_callups`:
   - `(franchise_id, player_id, season, nfl_week, called_up_at, demoted_at NULL, became_permanent INT DEFAULT 0)`.
   - Plus a `ups_taxi_callup_counts` materialized view or derived query for `(franchise_id, player_id) → total_callups_in_window`.

2. **Worker increment:** on `/api/promote-from-taxi` (or wherever the call-up submit lives), look up the player's draft_year + current season → compute 3-year-window bounds → query `ups_taxi_callups` for total_in_window → reject if already 3 AND the new call-up would be the 4th (and instead route as permanent promotion).

3. **Auto-promotion path:** the 4th activation auto-flips the player to permanently promoted. Update `players.permanent_promotion_at` (or equivalent) so the cap-free-cut path stops applying.

4. **Demote logic:** on demote-to-taxi before next week's lock, set `demoted_at` on the open row.

5. **UI:** taxi pane shows `Used N / 3` per player with a remaining-call-ups chip.

**Test cases:**
- Player called up 3 times in Year 1 → 4th call-up auto-promotes.
- Player called up 1× in Y1, 1× in Y2, 1× in Y3 → 4th call-up at any point auto-promotes (counter is cumulative).
- Player called up + demoted within same week → still counts 1 toward budget (per "active for the week" definition in B2).

---

### Q11 — Round 6 IDP-only worker block ⏳

**Canon:** `docs/league_context_v1.md §A1 Round 6` (updated 2026-05-16 with historical precedent).

**Work:**
- Find rookie-draft pick submit endpoint (likely `worker/src/index.js` — search for `/api/pick` or draft submit handler).
- Add: if `round === 6` AND `player.position` ∈ `{QB, RB, WR, TE, PK, PN}` → reject with a 400 + actionable error message.
- Mirror UI gate in:
  - Desktop rookie-draft UI (find via `site/draft/*` or similar).
  - Mobile rookie-draft UI (find via `site/m/*`).
- Add an integration test asserting rejection of a known-bad R6 pick.

**Historical precedent for the rejection message:** "Round 6 picks are IDP-only (2025+). Per league precedent, non-IDP R6 selections have been reversed AND the pick forfeited as a penalty."

---

### Q12 — Round 1 active-only lock (demote-to-taxi reject) ⏳

**Canon:** `docs/league_context_v1.md §A1 Round 1` (updated 2026-05-16).

**Work:**
- Find demote-to-taxi worker endpoint.
- Lookup: `player.draft_round === 1` AND `player.is_rookie_contract` (or equivalent) → reject demotion with 400.
- Mirror UI gate (desktop + mobile).
- Integration test for known-bad demotion.

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

### Q14 — Restructure D1 audit table ⏳

**Canon:** `docs/league_context_v1.md §C5` (updated 2026-05-16).

**Work:**
1. New migration `worker/migrations/00NN_ups_restructure_submissions.sql`:
   ```sql
   CREATE TABLE ups_restructure_submissions (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     league_id TEXT NOT NULL,
     season INTEGER NOT NULL,
     franchise_id TEXT NOT NULL,
     player_id TEXT NOT NULL,
     original_year_salaries TEXT NOT NULL,   -- JSON array
     restructured_year_salaries TEXT NOT NULL, -- JSON array
     tcv_usd INTEGER,
     source TEXT,                              -- 'desktop' | 'mobile' | 'commish'
     submitted_at TEXT NOT NULL DEFAULT (datetime('now')),
     submitted_by_fid TEXT
   );
   CREATE INDEX idx_restructure_franchise_season ON ups_restructure_submissions(franchise_id, season);
   CREATE INDEX idx_restructure_player_season ON ups_restructure_submissions(player_id, season);
   ```
2. Wire the existing `log-restructure-submission` event handler to INSERT a row.
3. Add a master table mirror if `ups_extension_history` / `ups_tag_history` follow that pattern.
4. Backfill question: is there a prior history of restructures to load from old event logs? Decide separately.

---

## Parking lot (no implementation tracker; canon already captures the deferral)

- **Q4 cap floor/ceiling tooling:** parked under auction-tooling discussion (`CROSS_CODEBASE_ALIGNMENT.md §4.1`).
- **Q7 27-active/30-max safeguards:** parked under auction tooling (§4.1).
- **Q15 Late dues + missed-nomination fines:** legacy; pending broader overhaul discussion with Keith.
- **Q16 Auction Room scope:** scope undecided; Keith will circle back.

---

## Done

(none yet — populate as trackers ship)
