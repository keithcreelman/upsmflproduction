# Plain `Vet-Ext1` and the loaded-contract count — investigation (no fix applied)

**Status: investigation and recommendation only. No production code changed.** Per Keith's
instruction (2026-09-29): *"Before changing enforcement, investigate the one-year `Vet-Ext1`
classification across the league... Show the contract terms and consequences for Hammer and
L.A. Looks, plus tests for both possible interpretations; recommend the rule supported by canon,
but do not silently change production counts."* This document is that investigation. Nothing in
`worker/src/contract_classification.js` (or any other production file) has been edited. A
recommendation is given at §7, for Keith's decision — it is not applied.

**Methodology:** all 12 franchises' live 2026 rosters, salaries, league, and salary-adjustment
exports were fetched fresh (the same public host/path `mflExportJson` itself uses,
`worker/src/index.js:23536-23537`) and every player run through the real, unmodified classifier
chain the trade-compliance gate uses: `readSalaryOverlay → derivePlayerCapFields →
resolveLoadedStatus` (`contract_classification.js`). Cross-checked against the live gate itself:
`evaluateTradeCompliance` on an empty 0005↔0001 trade returns `loaded_before: 8` (L.A. Looks) and
`loaded_before: 7` (HammerTime) — matching this investigation's own count exactly. 483 players
scanned; zero unresolved contracts.

---

## 1. What canon actually says

### 1.1 Extension length and the FL/BL suffix rule

- `docs/league_context_v1.md:430` — "**Loaded is a modifier, not a type.** Any 2- or 3-year
  contract can be front-loaded (`FL`) or back-loaded (`BL`)... It attaches to Auction, Extension,
  and MYAC deals; it can never attach to a 1-year deal, a MYM, or a taxi contract."
- `:476-477` — "**Length:** 1 or 2 years." / "**`contract_type`:** **Ext1** for 1-year extension,
  **Ext2** for 2-year extension."
- `:479` — "**1-year extension (`Ext1`): FL/BL NOT allowed.** One year of extension → no salary
  curve possible. The MFL `contractStatus` stays `EXT1` with no `-FL` / `-BL` suffix."
- `:480` — "**2-year extension (`Ext2`): FL or BL allowed.** Status becomes `EXT2-FL` (Y1 > Y2) or
  `EXT2-BL` (Y1 < Y2). Flat distribution (Y1 = Y2) stays plain `EXT2` with no suffix."
- `:484` — "The extension submitter should **auto-derive** the `-FL` / `-BL` suffix from the
  per-year salary array — owners don't set it manually."
- `:489` — worked Ext1 example: "1yr remaining at $17K AAV → extend 1yr (Ext1) → AAV for the
  extension year = $27K. Current year stays at $17K. New TCV = $17K + $27K = $44K."

**The tension, stated plainly:** `:484` says the suffix is *auto-derived from the actual salary
array* — implying it tracks the real schedule. `:479` says Ext1 *never* gets a suffix, no
exception — not "derive it and it happens to always come out flat," but a flat rule regardless of
the array. Canon's own worked example (`:489`) produces a genuinely uneven schedule (a frozen
current year below the new extension year) and still calls it un-suffixed. This is the crux of
the question: is `:479` describing a structural impossibility (an Ext1's shape can never actually
qualify as loaded), or a deliberate exception (it CAN be uneven, but the rule says don't call it
that)? §5 below gives direct evidence for the first reading.

### 1.2 How "loaded" is defined or detected — and what canon does NOT say

- `:448-449` — "**Front-loaded:** Year 1 salary > AAV... **Back-loaded:** Year 1 salary < AAV. Min
  20% of TCV in Year 1. Same constraints as front-loaded (TCV preserved, valid distribution)."
- `:450` — "**Loaded contracts cap: MAX 5 LOADED CONTRACTS PER ROSTER**"
- `:452` — enforcement is at **contract-load time** — "on MYAC submit, ERA win, FA Auction win,
  restructure submit, or 2-year extension" — this list names 2-year extensions specifically for
  load-time enforcement; it does not name 1-year extensions, consistent with `:479`'s "FL/BL NOT
  allowed" for Ext1.
- `:521-522` — "**AAV tokens in live MFL are unreliable**... Preserve the token as-is; do not
  'correct' a suffix or a load decision off a suspect AAV value."
- `:523-526` — "**The `-FL`/`-BL` suffix follows the DIRECTION THE MONEY MOVED**... compare the
  new current-year salary against the PRE-restructure current-year salary... This is **not** a
  'Y1 vs AAV' test and **not** a test on the shape of the resulting curve. Both of those break on
  escalated dual-AAV contracts, where Y1 can exceed the current AAV tier by construction and still
  be a back-load." (This is about *restructures* specifically, but it is direct, explicit canon
  language warning that a bare Year-1-vs-AAV/average test is known to give wrong answers for at
  least one real contract shape.)
- `:1202` — "4. **Loaded contracts on roster ≤ 5** at all times (front + back combined)."

**Canon never states how an ALREADY-ROSTERED contract should be classified for this count** —
only how the suffix is assigned *at creation* (`:484`, `:523-526` at restructure). There is no
passage describing a detection rule ("count it as loaded if X") independent of the suffix the
contract was given when it was made. This gap is exactly what `resolveLoadedStatus` fills today,
by re-deriving loaded/flat from the schedule every time, regardless of the stored suffix — a
reasonable design in general (the suffix can't always be trusted, `:521-522`), but one canon never
explicitly sanctions for the Ext1 case specifically, where `:479` says the suffix is supposed to
be authoritative and constant.

### 1.3 Ext2, for contrast, and Ext1 after a restructure

- `:483` — worked Ext2 example (LaPorta): "Owner chose Y1-$10K / Y2-$40K (back-loaded; Y2 > Y1).
  Status posts as `EXT2-BL`... Flat $25K/$25K stays plain `EXT2`." Live data confirms this is real
  behavior: 6 `Vet-Ext2-FL`, 8 `Vet-Ext2-BL`, and 8 plain `Vet-Ext2` contracts exist today — the
  suffix genuinely does track owner-chosen uneven Ext2 splits, supporting the general principle
  that the suffix is meant to mean something real.
- `:531-533` — after a restructure, "the extension status is kept, not replaced: the correct
  result reads `Vet-Ext1-BL`, `Vet-Ext2-BL`, `Vet-FAA-BL`" — confirming an Ext1 **can** carry a
  suffix once it's been restructured (a separate, later event from the extension itself). Live
  data has exactly this shape: Kenneth Walker III (`Vet-Ext1-BL`, restructured 2026) and Sam
  Darnold (`Vet-Ext1-FL`, restructured 2026) — both correctly excluded from "plain Ext1" in this
  investigation, since their suffix is real, canon-sanctioned, and post-restructure.

---

## 2. HammerTime (0005) — the full loaded table, 7 contracts today

| Player | Pos | Roster | contractStatus | Schedule | Now | Y1 vs TCV÷CL | Plain Ext1? |
|---|---|---|---|---|---|---|---|
| McBride, Trey (15794) | TE | ROSTER | `Vet-Ext2-BL` | Y1 $9K, Y2 $35K | Y2/2, $35K | 9 < 22 | no |
| Smith, Geno (11150) | QB | ROSTER | `Vet-FAA-BL` | Y1 $9K, Y2 $1K, Y3 $35K | Y2/3, $1K | 9 < 15 | no |
| **Addison, Jordan (16186)** | WR | ROSTER | **`Vet-Ext1`** | Y1 $7K, Y2 $17K | Y2/2, $17K | 7 < 12 | **YES** |
| Chase, Ja'Marr (15281) | WR | ROSTER | `Vet-Ext2-BL` | Y1 $26K, Y2 $103K | Y1/2, $26K | 26 < 64.5 | no |
| Walker III, Kenneth (15711) | RB | ROSTER | `Vet-Ext1-BL` | Y1 $15K, Y2 $59K | Y1/2, $15K | 15 < 37 | no — real suffix, restructured 2026 |
| **Montgomery, David (14071)** | RB | ROSTER | **`Vet-Ext1`** | Y1 $12K, Y2 $30K | Y1/2, $12K | 12 < 21 | **YES** |
| Jacobs, Josh (14073) | RB | **IR** | `Vet-FAA-BL` | Y1 $18K, Y2 $36K, Y3 $36K | Y1/3, $18K | 18 < 30 | no |

- **Addison** (`CL 2\|TCV 24K\|AAV 17K\|Y1-7K, Y2-17K\|GTD: 18K\|Ext: LH`): Y2−Y1 = exactly the
  +$10K Schedule-1 one-year raise canon's own formula (§1.1) produces. The below-average year
  (2025) has already been played — the player is now IN the "extension" year at $17K.
- **Montgomery** (`CL 2\|TCV 42K\|AAV 20K, 30K\|Y1-12K, Y2-30K\|Ext: Hammer\|GTD: 31.5K`): Y2 $30K
  is exactly the $20K AAV value + the $10K raise. Y1 $12K is his real pre-extension salary.
- HammerTime's other Ext1, C.J. Stroud (`Vet-Ext1`, `CL 1\|TCV 22K\|AAV 22K\|Y1-22K`), is a
  genuine 1-year contract (not an extension of a longer deal) and is flat under either
  interpretation — not counted in either total.

## 3. L.A. Looks (0001) — the full loaded table, 8 contracts today

| Player | Pos | Roster | contractStatus | Schedule | Now | Y1 vs TCV÷CL | Plain Ext1? |
|---|---|---|---|---|---|---|---|
| Brown, Chase (16181) | RB | ROSTER | `Vet-Ext2-FL` | Y1 $32K, Y2 $12K | Y1/2, $32K | 32 > 22 | no |
| **Ferguson, Jake (15799)** | TE | ROSTER | **`Vet-Ext1`** | Y1 $11K, Y2 $21K | Y2/2, $21K | 11 < 16 | **YES** |
| **Jennings, Jauan (14860)** | WR | ROSTER | **`Vet-Ext1`** | Y1 $11K, Y2 $21K | Y2/2, $21K | 11 < 16 | **YES** |
| Bond, Isaiah (17076) | WR | ROSTER | `Vet-WW-BL` | Y1 $5K, Y2 $5K, Y3 $14K | Y2/3, $5K | 5 < 8 | no |
| Darnold, Sam (13592) | QB | ROSTER | `Vet-Ext1-FL` | Y1 $30K, Y2 $16K | Y1/2, $30K | 30 > 23 | no — real suffix, restructured 2026 |
| **Coker, Jalen (16809)** | WR | ROSTER | **`Vet-Ext1`** | Y1 $1K, Y2 $11K | Y1/2, $1K | 1 < 6 | **YES** |
| Likely, Isaiah (15798) | TE | ROSTER | `Vet-FAA-FL` | Y1 $12K, Y2 $1K, Y3 $8K | Y1/3, $12K | 12 > 7 | no |
| **Pierce, Alec (15768)** | WR | **IR** | **`Vet-Ext1`** | Y1 $2K, Y2 $12K | Y1/2, $2K | 2 < 7 | **YES** |

- All four plain Ext1s (Ferguson, Jennings, Coker, Pierce) show Y2−Y1 of exactly +$10K, the same
  Schedule-1 one-year raise, and none carries a restructure marker.
- L.A. Looks' other Ext1, Courtland Sutton (`Vet-Ext1`, pays $15K/$15K), is flat either way.

## 4. The consequence, precisely, for both named franchises

| Franchise | A: shipped today | Plain Ext1s counted under A | B: plain Ext1 → flat | Δ | Limit status, A → B |
|---|---|---|---|---|---|
| **HammerTime (0005)** | **7** | 2 (Addison, Montgomery) | **5** | −2 | 2 over → **at the limit, zero headroom** |
| **L.A. Looks (0001)** | **8** | 4 (Ferguson, Jennings, Coker, Pierce) | **4** | −4 | 3 over → **1 UNDER the limit** |

For both franchises, Interpretation B lands on exactly the same number as simply counting
`-FL`/`-BL` **suffixes** instead of re-deriving from the schedule — every loaded contract either
team has *without* a suffix is a plain Ext1.

## 5. League-wide — every franchise, all 12, live data

20 plain `Vet-Ext1` contracts exist league-wide; 6 more Ext1s carry a real, restructure-earned
suffix (excluded from "plain" here, same as Walker III/Darnold above). Of the 20 plain ones, 14
classify loaded today (12 back-loaded, 2 front-loaded — Derrick Henry and A.J. Brown, both
0006) and 6 classify flat (Sutton and Tee Higgins, both genuinely flat schedules with their own
2025 restructure markers; plus four true 1-year, non-extension contracts).

| Franchise | A (shipped) | B (plain Ext1 flat) | Limit status, A → B |
|---|---|---|---|
| 0001 L.A. Looks | 8 | 4 | 3 over → 1 under |
| 0004 Pure Greatness | 8 | 7 | 3 over → 2 over |
| 0005 HammerTime | 7 | 5 | 2 over → at the limit |
| 0006 Long Haulers | 5 | 2 | at the limit → 3 under |
| 0010 Blake Bombers | 7 | 4 | 2 over → 1 under |
| 0011 Cleon Ca$h | 7 | 6 | 2 over → 1 over |
| 0002 / 0003 / 0007 / 0008 / 0009 / 0012 | 4 / 1 / 3 / 2 / 5 / 1 | unchanged | — |

**League total: 58 loaded contracts under A, 44 under B. Franchises over the limit: 5 under A, 2
under B.** For reference, canon (`:451`) recorded "34 loaded contracts league-wide" as of
2026-08-01 — rosters have moved since, and that note doesn't say how it counted, so it isn't a
clean cross-check either way, only noted here for completeness.

A related pattern, found but **not part of either interpretation above** (neither Hammer nor L.A.
Looks has one): four plain `Vet-Ext2` **3-year** contracts (Gibbs and Flowers on 0004, Lamb on
0011, Kincaid on 0012) classify back-loaded purely because a frozen first year sits below the
3-year average, while their two actual extension years are perfectly flat relative to each other
— structurally the same "frozen-year-drags-the-average-down" pattern as the Ext1 case, just on a
longer contract. Flagged for awareness; out of scope for this specific ruling, which Keith scoped
to Ext1.

---

## 6. The direct evidence: the codebase already disagrees with itself on this exact shape

This is the strongest evidence bearing on which interpretation canon actually supports, found by
comparing what the worker's OWN code does in two different places for the identical contract
shape:

1. **Canon's own Ext1 example, run through the real extension pricer, produces exactly this
   shape** (`worker/src/extension_pricing.js`'s `priceExtension`, the function that prices a NEW
   extension request before it's submitted): `priceExtension` for a 1-year extension explicitly
   labels its result `loaded: "NONE"` — its own file header states plainly (`extension_pricing.js`
   line ~13, paraphrased in the file): *"a pre-trade extension is never loaded (FL/BL): the
   extension years are flat."* This is not a guess about what SHOULD happen; it's what the
   pricer, used today to build the exact contract string later written to MFL, actually decides.
2. **`resolveExtensionLoadedStatus`'s own docblock** (`contract_classification.js`, the JSDoc
   around lines 437-465) explains *why*: comparing Year 1 to the whole-contract average "would
   misclassify almost every extension," and specifically: *"A single future year (a 2-year
   extension: Y1 frozen + one new year) has no shape to compare and is flat."* — this is a direct,
   literal description of the Ext1-on-a-final-year shape (the frozen current year, plus exactly
   one new year), stated as a reason the naive average-comparison test is wrong for it.
3. **But `resolveLoadedStatus` — the function that classifies an EXISTING roster contract, used
   everywhere the loaded-contract COUNT is computed — does not apply this reasoning.** It runs the
   generic Year-1-vs-TCV÷CL test unconditionally, with no carve-out for a contract whose real
   shape is "one frozen year plus one new year." The result: **the identical Addison/Montgomery
   contract shape is classified FLAT by the code that prices it, and LOADED by the code that
   counts it once it's on the roster.** This is not a difference of opinion between two
   reasonable readings of ambiguous data — it is the same codebase reaching two different answers
   about the same fact, depending only on which of its own functions is asked.
4. **A separate, corroborating signal:** canon's own back-load floor (`:449`/`:481`, Year 1 ≥ 20%
   of TCV) is a requirement for a contract that was actually SUBMITTED as back-loaded. Four of the
   plain-Ext1 contracts found here fall below that floor if treated as genuinely back-loaded —
   Coker (8.3% of TCV), Pierce (14.3%), and, league-wide, AJ Barner and Rico Dowdle (8.3% each).
   These contracts could never have been legally *created* as back-loaded deals under canon's own
   rule — which is exactly what you'd expect if they were never submitted as back-loaded deals at
   all, only mechanically re-labeled that way by a schedule test applied after the fact to a shape
   it wasn't designed for.

## 7. Recommendation (for Keith's decision — not applied)

**The evidence supports Interpretation B: a plain (`-FL`/`-BL`-free) `Vet-Ext1`/`Rookie-Ext1`
contract should not count toward the 5-loaded-contract limit, regardless of what its schedule
looks like.** The strongest reason is §6.3 — the codebase's own extension-pricing logic already
treats this exact shape as flat, for a reason (frozen-year-plus-one-new-year "has no shape to
compare") that applies identically whether the contract is being priced for the first time or
re-evaluated later as an existing roster entry. Canon's `:479` ("FL/BL NOT allowed" for Ext1, no
exception) reads most consistently with this: not as an arbitrary labeling convention layered on
top of a genuinely-loaded schedule, but as canon's own recognition that a one-year raise doesn't
produce the kind of negotiated, multi-year curve the loaded-contract concept was built to count.
Restructured Ext1s (Walker III, Darnold) are unaffected either way — they earn a real,
canon-sanctioned suffix at restructure time and are correctly counted as loaded today regardless
of this ruling.

This recommendation is not applied to any production file. If Keith confirms it, the change is
narrow and identifiable: `resolveLoadedStatus` (or its caller) needs a carve-out for a contract
whose `contractStatus` matches the plain-`ExtN`-no-suffix pattern with a schedule shaped as
"prior-contract-year(s) frozen, exactly one new year added" — mirroring `resolveExtensionLoadedStatus`'s
own existing, already-correct logic for the *pricing* path, extended to the *roster-classification*
path. That is a scoped follow-up, not part of this investigation.

## 8. The IR-count ruling — presented separately, for Keith's decision

This is a genuinely distinct question from §7 (which contracts count) — this one is about which
*roster statuses* count at all, and it applies regardless of how §7 is decided:

- Canon states the 5-loaded-contract maximum three times (`:450`/`:1202`, and `:C2`/`:C1`/`§6.G`
  as cited elsewhere in this codebase) without ever mentioning IR.
- Canon explicitly excludes IR from two OTHER, different limits — the active-roster maximum and
  the 27-player minimum (`§B3`) — but never states or implies the same exclusion for the
  loaded-contract count specifically.
- Canon explicitly guarantees a taxi contract can never BE loaded at all (`:430`, quoted above) —
  which is why taxi needs no roster-status carve-out in the count (there's nothing to carve out).
  That specific reasoning does not extend to IR: HammerTime's Jacobs (§2 above) is a real, live,
  loaded contract sitting on IR today, proving IR contracts CAN be loaded, unlike taxi ones.
- **The shipped code counts IR players toward the 5** — confirmed in `trade_cap_authority.js`:
  every rostered player is classified and counted before the taxi-skip runs; the IR flag is read
  only for the *active-count* and *cap-charge* calculations, never for this one. This is not a
  deliberate decision anyone made about the loaded-contract count specifically — it's what happens
  when nothing filters IR out, and it predates this session's work entirely (present in the
  original PR #1135 merge).

**The decision for Keith:** should IR-status players count toward the 5-loaded-contract limit?
Two positions, both defensible from canon's silence:
- **Yes (current behavior):** the limit is stated as an absolute "on roster ≤ 5," and IR is still
  "on roster" in the sense that matters for cap/contract purposes (unlike being dropped) — the
  other two IR exclusions (active max, 27-minimum) are about *roster construction*, a different
  concern from *contract-count bookkeeping*, so there's no reason to assume the same exclusion
  carries over.
- **No (a change from current behavior):** IR is functionally a "not competing this season" state
  for that specific asset, and the two existing IR exclusions establish a pattern of treating IR
  as outside the ordinary roster-limit machinery; extending that pattern to loaded contracts would
  be consistent with the league's general IR philosophy even though canon never says so directly
  for this specific rule.

This document takes no position on IR — unlike §7, where the codebase's own internal
inconsistency gives a genuine, evidence-based lean, there is no equivalent signal anywhere in the
code or canon pointing either way on IR. It is presented here purely as a clean decision for
Keith, separate from §7, as requested.
