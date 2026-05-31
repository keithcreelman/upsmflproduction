# Contract Unification — Current vs. Proposed Type (proposal, READ-ONLY)

**Date:** 2026-05-30 snapshot · **339 active rostered contracts** · **for review before any write pass.**

Maps every active contract's messy MFL `contractStatus` to the canonical vocabulary locked in [`CONTRACT_AUTOMATION_PLAN.md`](CONTRACT_AUTOMATION_PLAN.md). **Nothing is written to MFL or D1** — this is the proposal Keith reviews first. Full per-player table: [`contract_unification_2026-05-30.csv`](contract_unification_2026-05-30.csv) (columns: franchise · player · pos · current_type · proposed_type · confidence · current_contractInfo · proposed_contractInfo_note · mapping_note).

Generator: `pipelines/etl/scripts/build_contract_unification_proposal.py` (MFL-API-native; re-runnable). The CSV carries both `current_contractInfo` and a normalized/restored **`proposed_contractInfo`** column.

> **Corrections applied 2026-05-31 (Keith):**
> 1. **Blank-status players = data error** (contractInfo wiped). Verified all **65 against 2025** — every one was `Rookie` with intact contractInfo (62 taxi-squad + 3 activated). Restored: classified **`Rookie-Draft`**, 2025 contract rolled forward (the deal shape is unchanged; taxi years tick the year counter, not the structure). Moved them low → **high** confidence (**low fell 82 → 17**).
> 2. **Rookie-option contractInfo** folded into the schedule: `… Y3-6K\|GTD: 13.5K\|Keep Option as Y4Option =11K` → `… Y3-6K, Y4-11K Option\|GTD: 13.5K` (24 contracts).
> 3. **Draft picks** shown 2-digit: `1.1` → `1.10`.

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
| 65 | `(blank)` | `Rookie-Draft` | high (**restored from 2025** — was the data error) |
| 56 | `Rookie` | `Rookie-Draft` | high |
| 25 | `Veteran` | `Vet-FAA` | high |
| 20 | `Veteran` | `Vet-Ext2` | med (has `Ext:` token, was mislabeled) |
| 16 | `Veteran` | `Vet-WW` | high |
| 14 | `Veteran` | `Vet-FAA?` | **low — traded vet** |
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

**Confidence: 272 high (80%) · 50 med (15%) · 17 low (5%).** *(was 207 / 50 / 82 before the 2026-05-31 blank-restoration.)*

- **High** = unambiguous relabel or restored-from-2025 (e.g. `TAG`→`Tag`, `EXT2`→`Vet-Ext2`, the 65 blank rookies → `Rookie-Draft`). Safe to apply.
- **Med** = strong signal, light judgment (e.g. a `Veteran` carrying an `Ext:` token → `Vet-Ext2`; a `BL` with a back-loaded schedule + `Ext:` → `Vet-Ext2-BL`).
- **Low (17) = your call** — all **traded vets** where origin predates the trade and can't be proven from the snapshot (e.g. *Davante Adams*, *Rashid Shaheed*, *Will Anderson*). Defaulted to `Vet-FAA?`; origin (FAA vs WW vs ERA) needs the AUCTION_WON / draft event. This is the irreducible set — one event-chain pass resolves it.

---

## Representative rows

**Clean relabels (high/med — apply):**

| Player | Current | → Proposed | contractInfo |
|---|---|---|---|
| Hockenson, T.J. | `MYM - Vet` | `Vet-MYM` | CL 3 \| TCV 33K \| Y1-11K,Y2-11K,Y3-11K |
| Pickens, George | `TAG` | `Tag` | CL 1 \| TCV 51K \| Tag \| Tier 1 |
| Cook, James | `Veteran` | `Vet-Ext2` | CL 3 \| Y1-7,Y2-27,Y3-27 \| **Ext: CBP** |
| Hall, Breece | `Veteran` | `Vet-Ext2` | CL 2 \| TCV 70K \| **Ext: Blake** |
| Ferguson, Terrance | `(blank)` | `Rookie-Draft` | **restored** → CL 3\| TCV 6K\| AAV 2K (from 2025) |
| Boston, Denzel | `R` (option) | `Rookie-Draft` | option folded → `…Y3-6K, Y4-11K Option\|GTD 13.5K` |

**Needs your review — the 17 low (all traded vets):**

| Player | Current | → Proposed | Why flagged |
|---|---|---|---|
| Adams, Davante | `FL` | `Vet-FAA-FL?` | acquired via trade — origin predates it |
| Shaheed, Rashid | `Veteran` | `Vet-FAA?` | traded — origin (FAA/WW/ERA) needs event chain |
| Will Anderson | `Veteran` | `Vet-FAA?` | cheap CL3 reads rookie-ish; origin needs event chain |

---

## Separate from type: `contractInfo` number backfill

Some `contractInfo` is still incomplete (multi-year missing TCV / Y-schedule). That's the **number backfill**, a *different* pass from this type unification (`CONTRACT_AUTOMATION_PLAN.md` normalization step 2–3) — derive from the event chain where possible, flag where not. The 65 restored rookies carry their 2025 shape (`CL 3\| TCV 6K\| AAV 2K`); their flat rookie Y-schedule is trivially derivable (Y1=Y2=Y3=AAV). Not changed here.

---

## Recommended sequencing

1. **Apply the 272 high-confidence relabels + restorations** (Tag/TAG merge, EXT→Vet-Ext, MYM→Vet-MYM, FL/BL→loaded suffix, the 65 restored blank rookies → Rookie-Draft with 2025 rolled forward). Zero/low judgment.
2. **Confirm the 50 med** (Veteran-with-Ext: → Vet-Ext2, etc.) — quick eyeball.
3. **Resolve the 17 low** — all traded vets; one event-chain origin lookup (same engine as the historical backfill) settles them.
4. **Then** the write pass (per the plan: *after* branch cleanup, MFL `contractStatus` rewrite + D1 parsed-column cache + the contractInfo normalizations above), and **then** the J4 reconciler enforces parity going forward.
