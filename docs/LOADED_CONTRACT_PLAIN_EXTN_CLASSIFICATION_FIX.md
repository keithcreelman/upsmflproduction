# Plain-ExtN loaded-contract classification — the fix, FO parity evidence, before/after

**Status: implemented, tested, NOT merged.** This is the "scoped follow-up... a narrow,
identifiable change" that `docs/LOADED_CONTRACT_EXT1_CLASSIFICATION_INVESTIGATION.md` (§7)
recommended and explicitly declined to apply. This document presents that follow-up for
Keith's review, per the same contract-change discipline used throughout this workstream:
canon citation → dry-run comparison → this write-up → Keith's confirmation → merge.

## What changed

`worker/src/contract_classification.js`'s `resolveLoadedStatus` — the function the live
Trade War Room loaded-contract gate (`evaluateTradeCompliance`, shipped in #1135) calls for
every roster contract — gained a new "priority 0," checked before the schedule is ever
read: **a plain (no `-FL`/`-BL` suffix) `Vet-ExtN`/`Rookie-ExtN` contractStatus is flat by
definition**, regardless of what its payment schedule looks like. A contractStatus that
*does* carry a real suffix (earned via restructure) is untouched — it still resolves via
the schedule exactly as before.

## Why this exact fix, and why it's narrow

Three independent lines of evidence, not one reading of ambiguous canon:

1. **Canon itself** (`docs/league_context_v1.md:479`): "1-year extension (`Ext1`): FL/BL
   **NOT allowed**. One year of extension → no salary curve possible." No exception. The
   same codebase's own extension-*pricing* logic (`extension_pricing.js`, and
   `resolveExtensionLoadedStatus`'s own docblock: "a single future year... has no shape to
   compare and is flat") already treats this exact shape as flat — but the
   roster-*classification* function (`resolveLoadedStatus`) applied no such carve-out and
   called the identical contract shape loaded. Full citations in the original investigation.
2. **Front Office already fixed this exact bug, independently, four months ago.**
   `site/rosters/v2/front_office.js`'s `isLoadedRow` (line 3701) has classified loaded
   status by **literal suffix presence only** since commit `e1f2cb7f` (2026-06-02, PR
   #398): *"isLoadedRow now detects an EXPLICIT loaded contract (the -FL/-BL suffix on the
   canonical contractStatus), not merely non-flat year salaries. LH was showing 6/8
   'loaded' from default-escalated deals; the actual loaded count is 3."* This was a real,
   reviewed, shipped production fix for the identical failure mode, on a different
   codepath, before this investigation ever started.
3. **A live, all-12-franchise, player-by-player sweep found zero unexpected
   disagreements.** Comparing the worker's pre-fix `resolveLoadedStatus` against FO's
   `isLoadedRow` for all 483 rostered/taxi/IR players in the league (live MFL data,
   2026-09-29) found **exactly 18 disagreements, all of the same shape, and none
   anywhere else** — no taxi contract disagreed (canon's "taxi can never be loaded" rule
   holds cleanly in both), no restructured contract disagreed (a real suffix already
   agrees with its schedule in every observed case), and no other contract family
   (Auction, MYAC, WW, FAA, ERA) disagreed anywhere in the league. This is what makes the
   fix *narrow*: it is scoped to exactly the shape the evidence identifies, not a broader
   rewrite of a schedule-derivation system that is correctly handling every other case.

## The 18 affected players

| Franchise | Player | Status | IR? |
|---|---|---|---|
| 0001 L.A. Looks | Jake Ferguson | Vet-Ext1 | |
| 0001 L.A. Looks | Jauan Jennings | Vet-Ext1 | |
| 0001 L.A. Looks | Jalen Coker | Vet-Ext1 | |
| 0001 L.A. Looks | Alec Pierce | Vet-Ext1 | **IR** |
| 0004 Pure Greatness | Tykee Smith | Vet-Ext1 | |
| 0004 Pure Greatness | Jahmyr Gibbs | Vet-Ext2 (3yr) | |
| 0004 Pure Greatness | Zay Flowers | Vet-Ext2 (3yr) | |
| 0005 HammerTime | Jordan Addison | Vet-Ext1 | |
| 0005 HammerTime | David Montgomery | Vet-Ext1 | |
| 0006 Long Haulers | Derrick Henry | Vet-Ext1 | |
| 0006 Long Haulers | Josh Downs | Vet-Ext1 | |
| 0006 Long Haulers | A.J. Brown | Vet-Ext1 | **IR** |
| 0010 Blake Bombers | Will Anderson | Vet-Ext1 | |
| 0010 Blake Bombers | AJ Barner | Vet-Ext1 | |
| 0010 Blake Bombers | Rico Dowdle | Vet-Ext1 | |
| 0011 Cleon Ca$h | Wan'Dale Robinson | Vet-Ext1 | |
| 0011 Cleon Ca$h | CeeDee Lamb | Vet-Ext2 (3yr) | |
| 0012 (franchise) | Dalton Kincaid | Vet-Ext2 (3yr) | |

12 plain Ext1 + 4 flagged plain Ext2 (3-year) + 2 of the above also on IR (Pierce, Brown —
counted once each, in the Ext1 rows above, not double-counted).

Every one of these is a plain `Vet-Ext1`/`Vet-Ext2` contractStatus with **no** suffix,
where a frozen prior-contract year (the season before the extension) sits below the
whole-contract average and was mechanically read as "back-loaded" (or, for Henry and A.J.
Brown, "front-loaded") by the old schedule-only test — exactly the shape canon's own Ext1
rule and FO's own suffix-only test both say is not a real curve at all.

Restructured Ext1s that carry a **real** suffix (Kenneth Walker III `Vet-Ext1-BL`, Sam
Darnold `Vet-Ext1-FL` — both 2026 restructures) are unaffected, correctly stay loaded, and
were confirmed to already agree with FO before this fix.

## League-wide before/after (all 12 franchises, live 2026-09-29 data)

| Franchise | Before (shipped) | After (this fix) | Δ | Over-5 before → after |
|---|---|---|---|---|
| 0001 L.A. Looks | 8 | 4 | −4 | over → **under** |
| 0002 | 4 | 4 | 0 | — |
| 0003 | 1 | 1 | 0 | — |
| 0004 Pure Greatness | 8 | 5 | −3 | over → **at limit** |
| 0005 HammerTime | 7 | 5 | −2 | over → **at limit** |
| 0006 Long Haulers | 5 | 2 | −3 | — |
| 0007 | 3 | 3 | 0 | — |
| 0008 | 2 | 2 | 0 | — |
| 0009 | 5 | 5 | 0 | — |
| 0010 Blake Bombers | 7 | 4 | −3 | over → **under** |
| 0011 Cleon Ca$h | 7 | 5 | −2 | over → **at limit** |
| 0012 | 1 | 0 | −1 | — |
| **League total** | **58** | **40** | **−18** | **5 franchises over → 0 over** |

**The headline result: under the corrected classification, every franchise in the league
is at or under the 5-loaded-contract limit.** Today's shipped count shows 5 franchises
(0001, 0004, 0005, 0010, 0011) in active violation; none of them actually are. This
directly bears on the urgency and framing of PR #1149's own enforcement feature, which was
motivated in part by these apparent violations — worth Keith's attention independent of
whether/when #1149 itself ships.

## Verification

- `tests/loaded_contract_plain_extn_classification.test.mjs` — 30 checks: the priority-0
  carve-out in isolation, all 18 real live-fixture players (verified flat), 5 regression
  controls (Walker III, Darnold, McBride, Geno Smith, a genuine 1-year Ext1 — all
  unaffected), and the league-wide before/after counts.
- Defect-sensitivity confirmed directly: reverting to the pre-fix source (isolated
  file-swap, not git stash) fails 22 of the 30 checks with the exact real-world numbers
  (e.g. Jordan Addison `'BL' !== ''`); restoring the fix passes all 30 again.
- `tests/trade_loaded_contracts.test.mjs` (the existing 81-test/250-assertion suite
  covering every other contract shape this module handles) — **81/81 still pass**, zero
  regressions.
- Full repo suite (`node --test tests/**/*.test.mjs`): same 4 pre-existing, unrelated
  failures (leaderboard/lineup precompute tests) already documented throughout this
  workstream — no new failures.
- `node --check worker/src/contract_classification.js` and `npx eslint@9 src/` (from
  `worker/`) both clean.

## What this does NOT touch

- `resolveExtensionLoadedStatus` (the extension-*pricing* path) — already correct,
  unchanged.
- Any OTHER contract family's schedule-based derivation (Auction, MYAC, Restructure, WW,
  FAA, ERA) — the live sweep found zero disagreement there; this fix does not touch that
  code path at all.
- The IR-count question (`docs/LOADED_CONTRACT_EXT1_CLASSIFICATION_INVESTIGATION.md` §8) —
  a genuinely separate, still-open decision. This fix does not change whether IR players
  count toward the 5; it only changes whether a plain-ExtN IR player's contract is itself
  classified loaded or flat. Pierce and Brown above are affected by THIS fix regardless of
  how the IR question is eventually decided.
- Migration 0163, PR #1149, or any part of the conditional-drop feature — this fix stands
  on its own and improves the accuracy of the trade-compliance gate that has been live
  since #1135, independent of whether/when #1149 ships.

No trade or drop was created or executed while producing this fix or its evidence.
