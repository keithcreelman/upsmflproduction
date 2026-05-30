# CONTRACT AUTOMATION PLAN — eliminate manual contract entry

**Generated:** 2026-05-29
**Goal (Keith):** Every contract event is submitted once via a UPS form → UPS auto-writes the full structured contract to MFL **and** records a D1 audit row. **Zero hand-entry.** Historically everything was by hand; this finishes the migration.

**Read first:** [`docs/DATA_AUTHORITY_MAP.md`](DATA_AUTHORITY_MAP.md) — establishes that MFL's `contractInfo` free-text field is the authoritative contract store, D1 is a parsed mirror + audit, and UPS forms are the single capture point.

---

## Canonical contract model (locked 2026-05-29)

For MFL to be the definitive contract store, two things must be true of every contract: the `contractInfo` numbers must be **complete**, and the `contractStatus` label must be **uniform**. Today neither is (audit below). This section locks the canonical model both must conform to.

### The two MFL fields, cleanly separated

- **`contractStatus`** = the **lifecycle-state label** (one of the 15 canonical values below). It is a *current-state* machine: each contract is in exactly one state, and a later state supersedes the earlier (an extension replaces the origin label). Origin history is **not lost** — it lives in the event chain (`player_acquisition_cycles` / `transactions`), so the label only needs to describe the cap-relevant present.
- **`contractInfo`** = the **numbers**: `CL n| TCV xK| AAV yK| Y1-..| Y2-..| ...` (length, total value, average, year-by-year schedule).

### Canonical `contractStatus` vocabulary

The label has two parts: a **base state** (mutually exclusive — origin OR extension) and an optional **loaded suffix** (`-FL` / `-BL`). Loaded is NEVER standalone — origin/lifecycle is always retained, so the label always says where the contract came from. This future-proofs for loadable rookies.

**Base states (mutually exclusive):**

| Group | States | Implies |
|---|---|---|
| Rookie origin | `Rookie-Draft`, `Rookie-FAA`, `Rookie-WW`, `Rookie-MYM` | standard, unextended |
| Vet origin | `Vet-FAA`, `Vet-ERA`, `Vet-WW`, `Vet-MYM` | standard, unextended |
| Special | `Tag` | — |
| Standard extension | `Vet-Ext1` (1yr), `Vet-Ext2` (2yr) | extended; supersedes origin |

**Loaded suffix — append `-FL` or `-BL` to any base the rules permit loading:**

| Loaded where | Example labels |
|---|---|
| Vet auction win (loaded) | `Vet-FAA-FL`, `Vet-FAA-BL`, `Vet-ERA-FL`, `Vet-ERA-BL` |
| Loaded 2-yr extension | `Vet-Ext2-FL`, `Vet-Ext2-BL` |
| Future (if rookies become loadable) | `Rookie-Draft-FL`, … |

Notes:
- `Ext1`/`Ext2` are extension **lengths** (1yr / 2yr), not counts. No loaded `Ext1` — you can't load a 1-year extension.
- An **extension supersedes origin** in the base (a `Vet-FAA` who extends 2yr becomes `Vet-Ext2`, origin preserved in the event chain). But a **loaded auction win keeps its origin** (`Vet-FAA-FL`) because it hasn't been extended — origin still matters.
- **Loaded-contract cap counting** (FA Contract Options, Gap 1) = count labels containing `-FL` or `-BL`. Reliable — every loaded contract carries the suffix; no bare `FL`/`BL` to miss.
- Separator standardized to `-` throughout (`Vet-Ext2-FL`); the exact string is cosmetic since D1 caches the parse — flag if you want a different separator.

### D1 caches the parse (so code never string-matches the label)

The MFL label is canonical, but the submission flow ALSO writes parsed columns to D1 on every contract touch, so downstream queries are trivial and never depend on parsing `"Vet-Ext2FL"`:
- `origin` (Rookie-Draft / Vet-FAA / … — also independently in the event chain)
- `is_loaded` (bool), `loaded_shape` (FL/BL/null)
- `ext_length` (0 / 1 / 2)
- `cl`, `tcv`, `aav`, `year_schedule` (parsed from `contractInfo`)

### Current state — audit of the 490 active contracts (snapshot 2026-05-15)

| Field | Present | Notes |
|---|---|---|
| `CL` | 401 (82%) | |
| `TCV` | 243 (50%) | much of the gap is legit — 1-yr deals don't need it (salary = total) |
| `AAV` | 241 (49%) | same |
| **Year schedule (Y-tokens)** | **106 (22%)** | the real backfill target — but only matters for multi-year |
| `contractInfo` blank | 86 (18%) | |

`contractStatus` today: 11 inconsistent values incl. `Tag` **and** `TAG` (case dup), 86 blanks, and a mix of origin / structure / event crammed into one field. The canonical vocabulary above replaces all of it.

### Normalization approach (scope it — don't blind-rewrite)

1. **Scope: active multi-year contracts first.** A 1-year deal needs no TCV/AAV/schedule (salary = total) — leave it. Target = currently-rostered contracts with `CL ≥ 2` missing TCV or year schedule. That's a small, bounded set.
2. **Derive from the event chain**, same engine as the historical backfill (`backfill_cap_penalty_cycles.py`, `lib/cap_penalty.py`). Where the structure is recoverable from AUCTION_WON price + Ext/MYM/Restructure events, fill it.
3. **Flag, don't fake** (`feedback_no_fake_amounts_in_blind_fields`): where the structure genuinely can't be derived, surface it for manual review — do NOT invent TCV/schedule.
4. **Map every active contract to one canonical `contractStatus`.** Tag/TAG → `Tag`; blanks + ambiguous → derive origin from event chain; FL/BL/Ext → map to the canonical loaded/extension states.
5. **Sequencing:** the audit + canonical-vocabulary design are read-only (done here). The *write* pass (rewriting MFL `contractStatus` + completing `contractInfo`) must wait until **after worktree/branch cleanup** so it doesn't collide with the 200+ open branches touching contract logic.
6. **History (pre-automation seasons):** do NOT rewrite MFL's past — its historical roster snapshots are retro-stamped (`mfl_pre2020_roster_snapshots_not_pointintime`). Reconstructed history lives in D1; MFL stays as-is for closed seasons. The reconciler enforces parity only on ACTIVE contracts.

This normalization is the **prerequisite** for: the reconciler (can't reconcile against dirty data), FA Contract Options (needs reliable loaded-counts), and the FO→Team Ops transition (inherits these contracts).

---

## The model (already correct — just incomplete)

```
   Owner action (extend / restructure / tag / MYM / auction win / rookie pick / option / cut)
                                  │
                          ONE UPS form
                  (Roster Workbench / Team Ops / Auction Hub)
                                  │
                 ┌────────────────┴────────────────┐
                 ▼                                  ▼
   MFL  import?TYPE=salaries              D1 audit row
   contractInfo = "CL n| TCV xK|          (ups_extension_submissions,
   AAV yK| Y1-..| Y2-.."  ← AUTHORITATIVE  ups_tag_*, player_acquisition_cycles)
                 │
                 └──> every downstream consumer reads MFL → correct state immediately
```

The model is right. The gap is that **not every event type routes through it yet.**

---

## Current state — 9 contract events (verified 2026-05-29)

| Event | Auto-writes MFL? | Structured `contractInfo`? | D1 audit | Status |
|---|---|---|---|---|
| Extension (Ext1/Ext2) | ✅ `/commish-contract-update` (`index.js:25019`) via `importContractUpdateAcq()` (`:8812`) | ✅ full Y-tokens + TCV/AAV/CL + `Ext:` token | `ups_extension_submissions` | **DONE** |
| Restructure (offseason) | ✅ same endpoint | ✅ full | `ups_extension_submissions` | **DONE** |
| MYM (1yr→multi) | ✅ same endpoint | ✅ full | `ups_extension_submissions` | **DONE** |
| Tag | ✅ same endpoint | ✅ `contractStatus=TAG` + salary | `ups_tag_submissions` + `ups_tag_master` | **DONE** |
| 1st-round rookie option (Y4 = Y3+$5K) | ✅ `submitRookieOptionUpdate()` (`:10916`) | ✅ salary + option note | `ups_extension_submissions` | **DONE** |
| Trade (cap/salary adjust) | ✅ `/api/trade/process` (`:6043`) → `TYPE=salaryAdj` | n/a — trade doesn't change contract terms, only ownership (MFL handles) + salary adj | MFL-side ledger | **DONE** |
| Drop / cut (cap penalty) | ✅ 5-min drop tracker → `TYPE=salaryAdj` + rich Discord | n/a — penalty, not contract | `ups_drop_events` | **DONE** |
| **ERA auction win → contract** | ✅ `finalizeEraContracts()` (`index.js`, #270, landed 2026-05-28) on 5-min poll + `POST /admin/auction/finalize-era-contracts` | ✅ `CL 1\| TCV {bid}K\| AAV {bid}K` | `ups_era_pool` join | **DONE (new)** |
| **FA auction win → contract** | ❌ no writeback yet — folds into Auction Hub w/ owner-selected Contract Options (see Gap 1) | ❌ | — | **GAP** |
| **Rookie draft signing** | ⚠️ pick auto via `/api/pick`; contract applied **async** via `/acquisition-hub/rookie-draft/reconcile-contracts` (`:21546`) + `applyRookieContractForDraftPickAcq()` (`:9457`) | ✅ full when it runs | not in a contract table | **PARTIAL** |

**Fully automated: 8 of 10 paths.** Two gaps remain.

---

## Gap 1 — FA auction win → contract (folds into Auction Hub)

**Decision (Keith 2026-05-29):** **Kill the Acquisition Hub.** The live **Auction Hub** (`site/auction/`, v0.6.0) already owns ERA; **FA Auction folds into the same hub** as a second auction type. The old `/acquisition-hub/*` routes + archived UI are dead — verified the live hub calls only `/api/auction/*` (era-eligible, lots, bid-stats, compliance, cut-rebid-blocks, nomination-status, bid-history), never `/acquisition-hub/*`. See MODULE_INVENTORY for the kill list.

**What's missing:** when the July FA Auction ratifies a win, no contract is written back to MFL. Owners hand-key it afterward. Seasonal — bites in July.

**Fix — mirror the ERA `finalizeEraContracts()` pattern (#270), but FA wins are NOT a fixed 1-year.** Unlike ERA (always `CL 1`), an FA win presents the winner with **Contract Options** at finalize time:

- **Options offered:** FA Contract **2Y or 3Y**, each either **Standard or Loaded**.
- **Loaded gating:** Loaded is only offered if the team is **under the loaded-contract cap** (loaded cap = 5 per `league_context_v1.md` §v4). A team already holding 5 loaded contracts gets **no Loaded option** — only Standard.
- **3-year gating:** apply the **3-year contract threshold** too (confirm the exact cap/count in `league_context_v1.md` §6 / §A) — if the team is at the 3-yr limit, don't offer 3Y.
- The owner picks a valid option in the Auction Hub at/after win; the worker then writes `contractInfo = "CL n| TCV xK| AAV yK| Y1-..| Y2-..|..."` (FL/BL shape if Loaded) back to MFL.

**Build:** `finalizeFaAuctionContracts()` alongside `finalizeEraContracts()`:
- Trigger: 5-min auction poll after FA `AUCTION_WON` surfaces the win → owner is prompted with the valid Contract Options in the hub; on selection, finalize writes to MFL. Manual `POST /admin/auction/finalize-fa-contracts` fallback for commish.
- **Option-validity computation:** before presenting options, count the team's current Loaded contracts and 3-yr contracts (from MFL `salaries` / `src_contracts`) and filter the menu accordingly. This is the new logic vs. ERA.
- Idempotency: same "already finalized — compare current `contractInfo`, skip if equal" guard.
- Discord: post FA wins the same way ERA wins post (auction narrator → Transactions thread per lot).
- D1 audit row (extend `ups_extension_submissions` or new `ups_auction_contracts`).

**Effort:** ~2 days — the writeback is a clone of proven ERA code; the new work is the contract-options menu + cap-gating logic + the hub UI to present and capture the owner's choice.

---

## Gap 2 — Rookie draft signing (make it synchronous, add D1 audit)

**What's missing:** the pick goes live immediately, but the 3-year rookie contract is applied by a **separate async reconcile step** (`/acquisition-hub/rookie-draft/reconcile-contracts`). If reconcile lags or isn't triggered, contracts trail the picks — `index.js:8874` literally reports "Some confirmed rookie draft picks still need contracts applied." And the result isn't recorded in a D1 contract/audit table.

**Fix:**
- Apply the rookie contract **inline at pick time** (call `applyRookieContractForDraftPickAcq()` synchronously from `/api/pick`), keeping the reconcile endpoint only as a repair/catch-up tool, not the primary path.
- Use the Schedule-1 salary table from `league_context_v1.md` §A1 (1.01=$15K flat ×3yr … 1.12=$5K) — already encoded; write full `contractInfo`.
- Record a D1 audit row so rookie signings have the same trail as extensions.

**Effort:** ~0.5 day.

---

## History backfill — the other half of "everything used to be by hand"

Going-forward automation only fixes new contracts. The historical contracts entered by hand (pre-automation) still need structured reconstruction so reports, cap math, and the FO transition audit have clean inputs.

**Status (per repo memory `project_2011_2025_cap_backfill_state`):**
- 2011 — done ($0 penalty validated)
- 2012 — partial (≈30 rows shape-NULL)
- 2013–2025 — untouched

**Method (already proven):** event-chain reconstruction — `AUCTION_WON` price → MYAC/MYM/Ext/Restructure events → trades → cuts — rebuilds TCV, year schedule, earned, guarantee per cycle. Scripts: `backfill_cap_penalty_cycles.py`, `backfill_cycles_pass2.py`, `lib/cap_penalty.py`.

**Important guardrails from memory:**
- Don't fill blind $ fields with inferred values — NULL the shape (`feedback_no_fake_amounts_in_blind_fields`).
- `Underpay N` token is load-bearing for pre-2021 FL/BL (`mfl_underpay_token_load_bearing`).
- 2011 EOS rollover anomaly — contractYear off by one (`mfl_2011_eos_rollover_anomaly`).

**Effort:** the remaining 2013–2025 backfill is the large item — schedule as a dedicated multi-session effort, one season-block at a time, validating against MFL transactions.

---

## Reconciliation-on-read — catch drift instead of trusting D1

Per the authority map's conflict rule: **MFL `contractInfo` wins; D1 is a mirror.** To enforce it, add a reconciliation check rather than letting the stale copy win silently:

- A scheduled job (fits the `FOLLOWUP_TASKS_2026-05-26.md` §J schedule audit / `nightly-builders.yml`) that:
  1. Pulls live MFL `salaries` (`salary` + `contractYear` + `contractInfo`).
  2. Re-parses `contractInfo` Y-tokens.
  3. Compares against D1's derived structure (`src_contracts`, `player_acquisition_cycles`).
  4. **Flags** any mismatch (player, field, MFL value, D1 value) to a report + optionally a commish Discord ping — does NOT auto-overwrite.
- On the read path in Front Office / Team Ops, when displaying a contract, prefer MFL; if D1 disagrees, show a small "out of sync" flag rather than the D1 number.

**Effort:** ~1 day for the nightly reconciler; the UI flag is incremental.

---

## Priority order

1. **Reconciliation-on-read nightly job** — cheap, and it's your safety net that catches every future drift. Do first.
2. **FA auction → Auction Hub + Contract Options writeback** — before July. Kill Acquisition Hub, fold FA into Auction Hub, build the options menu + cap-gating + `finalizeFaAuctionContracts()`.
3. **Rookie signing → synchronous + D1 audit** — before next rookie draft (have time per Keith; draft just happened).
4. **2013–2025 history backfill** — large, dedicated effort, season-block at a time.

---

## What this unblocks

- **FO → Team Ops transition** (`FOLLOWUP_TASKS_2026-05-26.md` §A): the data-alignment audit there depends on contracts being clean + reconciled. This plan provides that.
- **Cap reports / salary adjustments report**: clean structured inputs.
- **The "fix one thing, break another" class**: removing parallel hand-entry + adding drift-flagging removes a whole category of silent contract regressions.
