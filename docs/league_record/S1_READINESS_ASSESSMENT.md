# League Record S1: readiness assessment before any D1 implementation (2026-11-21)

**Verdict: NOT ready for D1 implementation. The design is accepted as the basis for architecture review; the evidence and data-quality gates below are open.** Nothing here authorizes a migration, a Worker route, an ingestion, an export beyond A1-A4, a merge or a deployment. PR #1484 and #1483 stay draft and unmerged. The central register is issue #1486; item ids below are its ids.

## 1. The answer contract (the final requirement)

Every historical answer the system gives must separate four things, never blend them, and never drop an unresolved item:

| Part | Meaning | Source of the label |
|---|---|---|
| **Known** | An authoritative record states it directly (a trade record, a draft result, a forfeiture clarification), with its source and date quality. | evidence class CONFIRMED |
| **Calculated** | Deterministic from recorded numbers (a normalized draft slot, a cap total, a possession period derived from recorded events), with the method and the source of each input. | CALCULATED |
| **Inferred** | A conclusion from a stated method with disclosed assumptions, never promoted to known. | INFERRED |
| **Needs research** | UNRESOLVED, with the candidates, the evidence on file, what is missing, the register item and who decides. | UNRESOLVED + `lr_evidence_need` |

Example, a traded 2018 future pick today: *Known:* it is franchise A's 2018 round-2 pick, and its recorded transfers. *Calculated:* its recorded holder at the draft. *Inferred:* nothing. *Needs research:* which slot it became (LR-03/LR-14), with the evidence needed. Example, 2014 pick 4.12: *Known:* the draft row names franchise 0006 and the trade record leaves the slot token with 0004. *Needs research:* which is right (LR-01: CONFLICT, no winner chosen).

## 2. Does CONFIRMED possession require verified source coverage? (open Opus question; recommendation, revised after its review)

**Recommendation: separate two claims, and be strict about what an end observation proves.**

- An **end-state claim** (this slot was held by franchise F when the selection was made; this pick belongs to original franchise O) is **CONFIRMED when an authoritative observation at that end agrees with the recorded chain**. The draft result is such an observation of the holder at a date, so an unrecorded transfer earlier cannot change what it says at that date. This is why the 439 CONFIRMED slot-pick links (97.3% of 451) do not need verified coverage of every day before the draft. **It confirms the end state only, not the path:** a link that cites a route ("it came via trade X") does **not** inherit CONFIRMED for the intermediate legs, which stay recorded and unverified.
- **The observation must itself be authoritative about who held the slot.** Before 2018 a draft row can name whoever clicked rather than the owner, and rows noted "made by Commissioner" (2019 to 2025: 369 of 504 rows, plus 2 in 2014) have a franchise id that is probably, but not verifiably, the owner. That caveat travels with every link that rests on such a row.
- A **continuous-possession claim** (franchise F held the asset from t1 to t2 without interruption, which attributing points or salary to a period needs) is **not CALCULATED over unverified days**: "calculated" means arithmetic over confirmed inputs, and continuity across days with no source rests on the *absence* of a record, which is an assumption. Such a period is **INFERRED** (method: no unrecorded transfer, assumption disclosed, coverage state shown). It may be **CONFIRMED or CALCULATED only when its whole interval is VERIFIED_COMPLETE**, and the schema enforces it (`CHECK (evidence_class NOT IN ('CONFIRMED','CALCULATED') OR weakest_coverage = 'VERIFIED_COMPLETE')`).

So link confirmation is not gated on interval coverage, but any output that sums or attributes over a period (points, salary, trade value) must cite the weakest coverage of its periods, label the result inferred unless verified, and may not call it complete. The owner-visible wording is the answer contract above. Needs your ruling to close LR-12.

## 3. The six D1 prerequisites you set

| Prerequisite | Status | What exists | What is missing |
|---|---|---|---|
| **Final schema review incorporating known forfeitures and corrections** | In design, tested | `lr_forfeiture`, `lr_correction` (original, corrected value, method, approval, source), draft-slot status with enforcing triggers; a cap-amount source column (`amount_source`); the SQL block is executed against in-memory SQLite by tests. | The review itself: an independent pass on the revised schema (the architecture review covered the previous revision). |
| **An explicit method for recording unresolved historical evidence** | Designed this round | `lr_evidence_need` (subject, need code, register item, status, accepted-by reference) plus a release gate: **no UNRESOLVED link and no open conflict can be released without a recorded evidence need**; a limitation is accepted only with a cited decision; needs are closed, never edited. | Populating it from the register; wording for owners. |
| **Measured local database costs and a production-budget plan** | **Row counts measured offline; D1 costs NOT measured** | Exact counts from the committed ledger (below). Estimated 72,000 rows written on a first load (three chunks over two UTC days), hot reads 100 to 1,000 rows. | A local replica loader and `EXPLAIN`/rows-read measurement, then a temporary D1 database for exact written/read counts. Not started: it needs a throwaway loader and your go for the temporary database. |
| **A migration and rollback approach** | Designed | Additive migration, ship dark, chunked load, pointer-flip rollback, `rollback` run for continuing after a rollback, schema rollback script, update-proof triggers (design section 8). | A rehearsal on a temporary database. |
| **Distinction between package consideration and attributable trade value** | Designed this round | Design section 5a: consideration is the recorded package (legs, cap with direction); attributable value is a separate derived, method-named, approved claim that no fact table stores; production per possession period, never per trade. | The valuation slice itself (not started; not needed for the history layer). |
| **A strategy for updating history when missing records are recovered** | Designed this round | Design section 5b: append facts in a new run, rebuild only affected derived rows, close superseded ones, difference report, reviewed release, old runs readable "as of", register updated; a recovered record never closes an item by itself. | A rehearsal (the "a trade added later is invisible to an earlier run" test exists for the schema). |

**Exact local row counts** (computed offline from the committed ledger for the archive years 2010-2025; no database was touched): trades 1,036; trade parties 2,072; trade legs 4,242; cap transfers 130; traded assets 2,046 (894 players, 678 future picks, 474 slot picks); draft rows 935; draft slots 936; possession periods 9,991; non-trade events of traded players 6,973; links 597 future-pick plus 474 slot-pick; link candidates 899. About **30,500 rows**, about **41,300 index entries** from the design's indexes, about **72,000 rows written** on a first load. These match the earlier estimate (31,000 and 72,000). The real D1 cost, including how D1 bills index entries and batch inserts, is the measurement still owed.

**Production-budget plan (not executed):** load only on a temporary database first; production in chunks of at most 25,000 written rows, at most two chunks per UTC day, stopping if `scripts/d1_usage.py` shows more than 70% of the daily write budget used by anything; changed-rows-only writes; no rewrite of finished seasons; reads measured with `EXPLAIN QUERY PLAN` and `rows_read` before any route.

## 4. Release gates and register: where each stands

| Item | Level | Status | Note |
|---|---|---|---|
| LR-01 2014 pick 4.12 | R | OPEN, CONFLICT kept | N1-N3 recorded as the next research action; not authorized. |
| LR-02 the 2025-11-28 to 2026-03-07 gap | R | INVESTIGATING | A1-A4 approved for your local run; package ready for your review. |
| LR-03 / LR-14 / LR-15 future picks | R | OPEN | Evidence-first proposal written (`S1_FUTURE_PICK_EVIDENCE_PROPOSAL.md`); 0 links changed. |
| LR-04 selector not recorded | R | OPEN | Kept distinct; 20 legacy rows. |
| LR-05 cap tokens | B | **FIXED_PENDING_VERIFICATION** | Parser corrected, 2025 aggregate 282,000, all seasons 1,700,000; verification against MFL pending (`S1_CAP_TOKEN_CORRECTION.md`). |
| LR-06 / LR-18 date semantics, administrative rows | R | OPEN | 68 February-2017 auction rows and 2,546 administrative rows still count as activity in the quiet-window proxy. |
| LR-07, LR-08 legacy slots, 2018 forfeiture | V | FIXED_PENDING_VERIFICATION | Regression tests in place. |
| LR-09, LR-10, LR-11 | R/B | OPEN | Chain breaks; partial scoring never zero; package membership first-class. |
| LR-12 / LR-13 / LR-16 / LR-20 coverage | R | INVESTIGATING | Section 2 above; E3 for past dates remains the blocking limit. |
| LR-17 export handling | V | **Ready for your review** | Runner, sanitizer, runbook and tests (`S1_EXPORT_LOCAL_RUNBOOK.md`); two independent review rounds fixed credential-leak paths. |
| LR-19 update strategy | V | Designed | Section 3 above. |
| GO-01 D1 gate, GO-07 | B/V | **OPEN** | Nothing may be built until the prerequisites above are closed and you approve the step. |
| GO-02, GO-03, GO-06 | B/V | OPEN | Privacy boundary for live routes, tests on real approved records, final go/no-go list. |
| GO-04 CI/review on the final head | V | per commit | Re-checked at each head. |
| GO-08 answer contract | V | defined (section 1) | To be enforced in every tool that answers. |

## 5. What would make us ready, in order

1. You review and run A1-A4; I reconcile the sanitized results (LR-02, LR-16).
2. You rule on the possession-wording question (section 2) and on the evidence proposal's stage 2 (go-forward captures) and stage 3 (ask MFL).
3. An independent review of the revised schema (forfeitures, corrections, evidence needs, cap source, package versus value, update strategy).
4. Local replica measurement, then a temporary-D1 measurement, with your go for the temporary database.
5. Verification of the cap correction against the A1 export; decision on the 68 dated rows.
6. Only then: a separate request for the first D1 slice (sources, coverage, trades, draft, links, conflicts, evidence needs), with its measured budget, migration and rollback rehearsal.

## 6. What is solid today

The strict classes (nothing is CONFIRMED to a slot for a future pick, 0 inferred, 597 unresolved), the draft-slot statuses (936 = 935 selected + 1 forfeited), the legacy slot correction (30 rows, provenance kept), the source-coverage model and its tests, the cap correction, the sanitizing export package, and a register that records what is not known.
