# Contract Unification — Current vs. Proposed Type (proposal, READ-ONLY)

**Date:** 2026-05-30 snapshot · **339 active rostered contracts** · **for review before any write pass.**

Maps every active contract's messy MFL `contractStatus` to the canonical vocabulary locked in [`CONTRACT_AUTOMATION_PLAN.md`](CONTRACT_AUTOMATION_PLAN.md). **Nothing is written to MFL or D1** — this is the proposal Keith reviews first. Full per-player table: [`contract_unification_2026-05-30.csv`](contract_unification_2026-05-30.csv) (columns: franchise · player · pos · current_type · proposed_type · confidence · current_contractInfo · proposed_contractInfo_note · mapping_note).

Generator: `pipelines/etl/scripts/build_contract_unification_proposal.py` (MFL-API-native; re-runnable).

---

## Canonical target vocabulary

- **Rookie origin:** `Rookie-Draft`, `Rookie-FAA`, `Rookie-WW`, `Rookie-MYM`
- **Vet origin:** `Vet-FAA`, `Vet-ERA`, `Vet-WW`, `Vet-MYM`
- **Extension (supersedes origin):** `Vet-Ext1` (1yr), `Vet-Ext2` (2yr)
- **Special:** `Tag`
- **Loaded suffix** (auction wins + 2yr extensions only): append `-FL` / `-BL` → e.g. `Vet-FAA-FL`, `Vet-Ext2-BL`

## How the proposed type is derived

| Signal | Source | Maps to |
|---|---|---|
| `TAG` / `Tag` | status | `Tag` (case-merge) |
| `R` / `Rookie` | status + `drafted` | `Rookie-Draft` (pick) / `Rookie-FAA` (auction) / `Rookie-WW` (blind-bid) |
| `MYM - Rookie` / `MYM - Vet` | status | `Rookie-MYM` / `Vet-MYM` |
| `EXT1` / `EXT2` / `Ext:` token | status + contractInfo | `Vet-Ext1` / `Vet-Ext2` (length from explicit EXT, else CL) |
| `Vet-ERA` | status | `Vet-ERA` |
| `Veteran` / blank | `drafted` | `Vet-FAA` (auction) / `Vet-WW` (blind-bid) / `Rookie-Draft?` (rookie pick) |
| `FL` / `BL`, or front/back-loaded Y-schedule | status + contractInfo | append `-FL` / `-BL` |
| acquired via **Trade** | — | origin predates the trade → **flagged low-confidence**, not guessed |

A trailing **`?`** on a proposed type = best guess that **needs event-chain confirmation** (origin not recoverable from the snapshot alone). No salary/structure numbers are invented (`feedback_no_fake_amounts_in_blind_fields`).

---

## Current → proposed transitions (all 339)

| # | Current type | → Proposed | Confidence |
|---:|---|---|---|
| 72 | `R` | `Rookie-Draft` | high |
| 56 | `Rookie` | `Rookie-Draft` | high |
| 51 | `(blank)` | `Rookie-Draft?` | **low — review** |
| 25 | `Veteran` | `Vet-FAA` | high |
| 20 | `Veteran` | `Vet-Ext2` | med (has `Ext:` token, was mislabeled) |
| 16 | `Veteran` | `Vet-WW` | high |
| 14 | `Veteran` | `Vet-FAA?` | **low — traded vet** |
| 14 | `(blank)` | `Vet-FAA?` | **low — traded vet** |
| 14 | `Vet-ERA` | `Vet-ERA` | high (already canonical) |
| 10 | `TAG` | `Tag` | high (case-merge) |
| 10 | `BL` | `Vet-Ext2-BL` | med |
| 6 | `EXT1` | `Vet-Ext1` | high |
| 5 | `FL` | `Vet-FAA-FL` | high |
| 5 | `MYM - Vet` | `Vet-MYM` | high |
| 4 | `EXT2` | `Vet-Ext2` | high |
| 4 | `FL` | `Vet-Ext2-FL` | high |
| 3 | `Rookie` | `Rookie-WW` | high |
| 3 | `MYM - Rookie` | `Rookie-MYM` | high |
| 1 each | `EXT2-BL`→`Vet-Ext2-BL`, `Rookie`→`Rookie-FAA`, `BL`→`Vet-WW-BL`, `FL`/`BL`→`…?` | | mixed |

**Confidence: 207 high (61%) · 50 med (15%) · 82 low (24%).**

- **High** = unambiguous relabel (e.g. `TAG`→`Tag`, `EXT2`→`Vet-Ext2`, `MYM - Vet`→`Vet-MYM`). Safe to apply.
- **Med** = strong signal, light judgment (e.g. a `Veteran` carrying an `Ext:` token → `Vet-Ext2`; a `BL` with a back-loaded schedule + `Ext:` → `Vet-Ext2-BL`).
- **Low (82) = your call** — origin can't be proven from the snapshot. Two clusters:
  - **51 blank 2025 rookies** (blank contractInfo, drafted via pick) → almost certainly `Rookie-Draft`; just need their rookie contract written.
  - **~28 traded vets** (e.g. *Will Anderson* `Veteran CL3 TCV3K` — reads rookie-ish; *Rashid Shaheed*) → origin (FAA vs WW vs ERA vs rookie) needs the AUCTION_WON / draft event.

---

## Representative rows

**Clean relabels (high/med — apply):**

| Player | Current | → Proposed | contractInfo |
|---|---|---|---|
| Hockenson, T.J. | `MYM - Vet` | `Vet-MYM` | CL 3 \| TCV 33K \| Y1-11K,Y2-11K,Y3-11K |
| Pickens, George | `TAG` | `Tag` | CL 1 \| TCV 51K \| Tag \| Tier 1 |
| Cook, James | `Veteran` | `Vet-Ext2` | CL 3 \| Y1-7,Y2-27,Y3-27 \| **Ext: CBP** |
| London, Drake | `BL` | `Vet-Ext2-BL` | CL 2 \| **Y1-14, Y2-52** \| Ext: PG |
| Hall, Breece | `Veteran` | `Vet-Ext2` | CL 2 \| TCV 70K \| **Ext: Blake** |

**Needs your review (low):**

| Player | Current | → Proposed | Why flagged |
|---|---|---|---|
| Ferguson, Terrance | `(blank)` | `Rookie-Draft?` | 2025 rookie, contract not written yet |
| Will Anderson | `Veteran` | `Vet-FAA?` | cheap CL3 reads rookie-ish; origin needs event chain |
| Shaheed, Rashid | `Veteran` | `Vet-FAA?` | acquired via trade — origin predates it |

---

## Separate from type: `contractInfo` number backfill

**158 of 339 (47%)** have an incomplete `contractInfo` (blank, or multi-year missing TCV / Y-schedule). That's the **number backfill**, a *different* pass from this type unification (`CONTRACT_AUTOMATION_PLAN.md` normalization step 2–3) — derive from the event chain where possible, flag where not. Most overlap with the 51 blank rookies. Not changed here.

---

## Recommended sequencing

1. **Apply the 207 high-confidence relabels** (pure label cleanup — Tag/TAG merge, EXT→Vet-Ext, MYM→Vet-MYM, FL/BL→loaded suffix). Zero judgment.
2. **Confirm the 50 med** (Veteran-with-Ext: → Vet-Ext2, etc.) — quick eyeball.
3. **Resolve the 82 low together** — the 51 blank rookies just need their rookie contracts written; the ~28 traded vets need an event-chain origin lookup (same engine as the historical backfill).
4. **Then** the write pass (per the plan: *after* branch cleanup, MFL `contractStatus` rewrite + D1 parsed-column cache), and **then** the J4 reconciler enforces parity going forward.
