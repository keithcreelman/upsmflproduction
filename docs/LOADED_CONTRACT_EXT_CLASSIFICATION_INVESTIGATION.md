# Plain `Vet-Ext1`/`Vet-Ext2` loaded-contract classification — fix, findings, verification

**Status: fix implemented and tested, on its own branch, NOT merged.** Separate from PR #1149
(the loaded-contract conditional-drops feature) and its migration, per Keith's explicit
instruction (2026-09-29): "Keep that PR separate from universal staging and #1149's migration."

## 1. The ruling this fix implements

Keith, 2026-09-29, after reviewing an earlier investigation into HammerTime's and L.A. Looks'
loaded-contract counts:

> Plain Ext1: An unsuffixed `Vet-Ext1` or `Rookie-Ext1` created by a one-year extension does
> not count toward the five-loaded-contract limit merely because its frozen prior year
> differs from its new extension year. A genuinely restructured Ext1 with a valid `-FL` or
> `-BL` suffix still counts. I agree with the investigation's recommended interpretation.
>
> Please prioritize a separate, narrow classification correction because the current
> production gate appears to overcount Hammer and L.A. Looks. Before opening it, investigate
> the four plain Ext2 contracts you identified (Gibbs, Flowers, Lamb, Kincaid): determine
> whether their frozen prior year creates the same false loaded classification when the
> actual extension years are flat. Apply one coherent rule based on the contract's genuine
> loaded structure, not a blanket suffix shortcut that could hide malformed data. Show the
> league-wide before/after counts, defect-sensitive tests, and cap/roster parity.
>
> IR: A loaded contract on IR does count toward the five. Add this ruling explicitly to
> canon and tests.
>
> The Trade War Room loaded-contract calculation must align with Front Office... Show the
> player-level count for Hammer and L.A. Looks, including plain Ext1, plain Ext2,
> restructured extensions, and IR. If Front Office and Trade War Room disagree, identify the
> first differing rule or input. Implement the approved canon interpretation consistently on
> both surfaces and the worker's enforcement path, with a parity test using real contract
> shapes. Do not make Trade War Room display one count while Front Office displays another.

## 2. What canon already says (this fix applies it, it does not invent it)

`docs/league_context_v1.md` §C4 (Extension), unchanged by this PR, already defines Ext2's
loaded status as a comparison between the extension's own two new years — not the whole
contract:

> **1-year extension (`Ext1`): FL/BL NOT allowed.** One year of extension → no salary curve
> possible. The MFL `contractStatus` stays `EXT1` with no `-FL`/`-BL` suffix.
>
> **2-year extension (`Ext2`): FL or BL allowed.** Status becomes `EXT2-FL` (Y1 > Y2) or
> `EXT2-BL` (Y1 < Y2). Flat distribution (Y1 = Y2) stays plain `EXT2` with no suffix.

"Y1"/"Y2" there are the extension's own two new years (canon's own worked LaPorta example:
"2-year extension at $50K TCV... Owner chose Y1-$10K / Y2-$40K... Status posts as `EXT2-BL`"
— the extension's Y1/Y2, with the frozen prior year never entering the comparison at all).

`resolveLoadedStatus` — the function that classifies an *existing roster* contract for the
5-loaded gate — never implemented this. It ran every contract, extensions included, through
one generic test: compare the contract's overall Year 1 to its blended AAV. For a fresh
Auction/MYAC/restructure contract, Year 1 *is* a real, freshly negotiated salary, so that
test is correct. For an extension, Year 1 is the *frozen, carried-forward* salary from the
player's prior, unrelated contract — comparing it to a blended AAV proves nothing about the
new money's shape, and reliably manufactures a false BL/FL verdict whenever the frozen year
happens to sit below/above the blend (which it usually does, since it predates the raise).

The codebase already knew this, just in the wrong function: `resolveExtensionLoadedStatus`
(used only to *price a new* extension, never to classify one already on the roster) already
excludes the frozen Year 1 and compares only the future years — "a single future year...
has no shape to compare and is flat." This fix reuses that exact function, and that exact
reasoning, for the roster-classification case, instead of running a second, inconsistent
test against the identical contract shape.

## 3. The fix, precisely

In `worker/src/contract_classification.js`'s `resolveLoadedStatus`, when a schedule is
present and authoritative for the whole contract: if the contractStatus (suffix stripped) is
exactly `Vet-Ext1`/`Rookie-Ext1`/`Vet-Ext2`/`Rookie-Ext2`, carries **no** `-FL`/`-BL` suffix,
and the schedule has at least 2 years — delegate to `resolveExtensionLoadedStatus` (excludes
the frozen first year, classifies the remaining extension year(s) on their own terms) instead
of the generic whole-contract test. Every other contract shape — suffixed Ext-family
(restructured, or Ext2's own native FL/BL), non-extension contracts, `Ext3`+ (canon:
"legacy data, not a live option") — is completely unaffected, unchanged from before this fix.

**Why this isn't a suffix shortcut, and can't hide malformed data:** the new branch still
runs the real schedule through the real math. A plain Ext2 whose two extension years are
genuinely uneven — a mislabeled, truly loaded contract missing its suffix — still resolves
`FL`/`BL` here exactly as before; only a plain Ext-family contract that is *actually* flat by
its own numbers reclassifies. Confirmed directly: `tests/loaded_contract_ext_classification
.test.mjs`'s synthetic case constructs exactly this (`Y1-10K, Y2-10K, Y3-40K`, no suffix) and
it still classifies loaded.

## 4. The four Ext2 candidates — investigated, not assumed

Gibbs (Jahmyr, pid 16162, Pure Greatness), Flowers (Zay, pid 16190, Pure Greatness), Kincaid
(Dalton, pid 16213, Hawks), Lamb (CeeDee, pid 14832, Cleon Ca$h) — every one's real, live
2026 contractInfo has its two extension years **exactly equal**:

| Player | contractInfo | Extension years |
|---|---|---|
| Gibbs | `CL 3\| TCV 73K\| AAV 31K\| Y1-11K, Y2-31K, Y3-31K\| GTD: 54.8K\| Ext: Sex` | Y2=31K, Y3=31K — equal |
| Flowers | `CL 3\| TCV 55K\| AAV 25K\| Y1-5, Y2-25, Y3-25\| GTD: 41.3K\| Ext: GRide` | Y2=25K, Y3=25K — equal |
| Kincaid | `CL 3\| TCV 67K\| AAV 29K\| Y1-9K, Y2-29K, Y3-29K\| GTD: 50.3K\| Ext: PG` | Y2=29K, Y3=29K — equal |
| Lamb | `CL 3\| TCV 172K\| AAV 64K\| Y1-44K, Y2-64K, Y3-64K\| GTD: 129K\| Ext: L.A. Looks, Cleon` | Y2=64K, Y3=64K — equal |

None is a genuinely uneven, mislabeled contract — the fix correctly reclassifies all four to
flat, and this was verified against the real numbers, not assumed from the missing suffix.

## 5. Player-level count for HammerTime and L.A. Looks (Keith's explicit request)

Live 2026 rosters, both franchises, every player affecting the loaded count:

**HammerTime (0005) — was 7, now 5:**

| pid | status | roster | before | after | why |
|---|---|---|---|---|---|
| 15794 | `Vet-Ext2-BL` | ROSTER | loaded | loaded | suffixed — unaffected |
| 11150 | `Vet-FAA-BL` | ROSTER | loaded | loaded | non-extension — unaffected |
| 16186 | `Vet-Ext1` | ROSTER | loaded | **flat** | plain Ext1 — this fix |
| 15281 | `Vet-Ext2-BL` (restructured) | ROSTER | loaded | loaded | suffixed — unaffected |
| 15711 | `Vet-Ext1-BL` (restructured) | ROSTER | loaded | loaded | suffixed — unaffected |
| 14071 | `Vet-Ext1` (Montgomery) | ROSTER | loaded | **flat** | plain Ext1 — this fix |
| 14073 | `Vet-FAA-BL` | **INJURED_RESERVE** | loaded | loaded | non-extension; IR still counts (§6 below) |

**L.A. Looks (0001) — was 8, now 4:**

| pid | status | roster | before | after | why |
|---|---|---|---|---|---|
| 16181 | `Vet-Ext2-FL` (restructured) | ROSTER | loaded | loaded | suffixed — unaffected |
| 15799 | `Vet-Ext1` | ROSTER | loaded | **flat** | plain Ext1 — this fix |
| 14860 | `Vet-Ext1` | ROSTER | loaded | **flat** | plain Ext1 — this fix |
| 17076 | `Vet-WW-BL` | ROSTER | loaded | loaded | non-extension — unaffected |
| 13592 | `Vet-Ext1-FL` (restructured) | ROSTER | loaded | loaded | suffixed — unaffected |
| 16809 | `Vet-Ext1` | ROSTER | loaded | **flat** | plain Ext1 — this fix |
| 15798 | `Vet-FAA-FL` | ROSTER | loaded | loaded | non-extension — unaffected |
| 15768 | `Vet-Ext1` | **INJURED_RESERVE** | loaded | **flat** | plain Ext1 — this fix; IR is irrelevant to *which* rule applies, only to whether the result counts |

Both franchises land at or under the 5 limit for the first time under the corrected rule —
HammerTime exactly at 5, L.A. Looks one under at 4.

## 6. IR ruling (Keith, 2026-09-29 — presented separately, no code change)

> IR: A loaded contract on IR does count toward the five. IR changes active-roster and cap
> treatment; it does not erase the contract.

Unchanged behavior — the classifier has no concept of roster status at all, and the caller
(`trade_cap_authority.js`) never filtered IR out. This ruling is now recorded explicitly in
canon (`docs/league_context_v1.md`, §C2) and pinned down by an explicit test
(`tests/loaded_contract_ext_classification.test.mjs`'s "IR RULING" case), since previously
it was true only by omission, not by a written rule anyone could point to.

## 7. Front Office alignment (Keith's explicit requirement)

Front Office (`site/rosters/roster_workbench.js`) computed "loaded" independently, with a
much simpler rule: does the raw `contractStatus` string end in `-FL`/`-BL`? On every one of
the league's 483 live 2026 contracts this happened to agree with the Trade War Room's richer,
schedule-verifying logic — but nothing *guaranteed* that agreement, and Front Office's own
`site/shared/cap_math.js` header documents the exact failure mode this created before, for a
different calculation ("Issue #244... used to live as four separate copies... They drifted,
which is how the Coleman bug shipped").

Front Office now delegates to `site/shared/loaded_contract_classification.js`, a faithful,
tested port of `worker/src/contract_classification.js` for the browser (the same reason
`site/shared/cap_math.js` exists as its own file rather than an import — a plain browser
script with no bundler can't `import` the worker's ES module). `tests/
loaded_contract_classification_parity.test.mjs` runs both copies against 207 distinct real
contract shapes (every one seen on a live 2026 roster) plus 19 synthetic edge cases and
fails the build the moment they diverge — the ongoing guarantee, not a one-time check.

**No disagreement was found between the two surfaces on any of the 483 live contracts
league-wide, before or after this fix** — the divergence risk was real but had not yet
manifested; this fix closes it structurally rather than leaving it to luck.

## 8. League-wide before/after (all 12 franchises)

Live 2026 rosters, 483 players, snapshotted 2026-09-29:

| Franchise | Before | After | Front Office (unmodified, before this PR) |
|---|---|---|---|
| L.A. Looks (0001) | 8 | 4 | 4 |
| CBP (0002) | 4 | 4 | 4 |
| Gride (0003) | 1 | 1 | 1 |
| Pure Greatness (0004) | 8 | 5 | 5 |
| HammerTime (0005) | 7 | 5 | 5 |
| The Long Haulers (0006) | 5 | 2 | 2 |
| Sex Manther (0007) | 3 | 3 | 3 |
| Real Deal Creel (0008) | 2 | 2 | 2 |
| C-Town Chivalry (0009) | 5 | 5 | 5 |
| Blake Bombers (0010) | 7 | 4 | 4 |
| Cleon Ca$h (0011) | 7 | 5 | 5 |
| Hawks (0012) | 1 | 0 | 0 |
| **TOTAL** | **58** | **40** | **40** |
| **Franchises over the 5 limit** | **5** | **0** | **0** |

Front Office's own (unmodified, pre-existing) count already matched the fix's new numbers
exactly, on every franchise — confirming this is the correct interpretation, not merely a
plausible one.

## 9. Cap/roster parity

This fix changes only the tri-state loaded/flat classification used to count toward the
5-loaded limit. It reads no salary amount and writes nothing to cap or roster math, which
are computed independently by `cap_math.js` from the same rosters. `tests/
loaded_contract_ext_classification.test.mjs`'s "CAP/ROSTER PARITY" test confirms the cap
block still resolves normally on the exact same real rosters this fix reclassifies.

## 10. Tests

- `tests/loaded_contract_ext_classification.test.mjs` — 13 tests, 29 assertions: the fix in
  isolation (real Hammer/Looks/Ext2-candidate fixtures), two regression controls (a
  restructured/suffixed Ext1, a genuinely-uneven plain Ext2 that must stay loaded), the
  CL-1-already-in-last-year edge case, an end-to-end run through the real
  `evaluateTradeCompliance` on both franchises' full, real, live 42-player rosters, the IR
  ruling, and cap/roster parity.
- `tests/loaded_contract_classification_parity.test.mjs` — 3 tests, 249 assertions: the
  worker's classifier and Front Office's ported copy agree on all 207 distinct real
  contract shapes plus 19 synthetic edge cases.
- `tests/trade_loaded_contracts.test.mjs` (pre-existing, unmodified) — 81/81 still pass,
  zero regressions.
- Full repo sweep (83 test files): zero new failures. The same 4 pre-existing, unrelated
  failures (`leaderboard_cache_ttl`, `leaderboard_precompute`, `lineup_compliance`,
  `lineup_wiring`) are unchanged by this branch.

## 11. What this PR does NOT do

- Does not touch PR #1149 (loaded-contract conditional drops) or its migration.
- Does not change the `Ext3` classification (canon: legacy, not a live option) — left exactly
  as before.
- Does not change cap accounting, roster limits, or lineup feasibility.
- No merge, no deploy, no real MFL write of any kind.
