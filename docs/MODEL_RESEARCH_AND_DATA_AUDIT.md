# UPS Predictive Projection System — Data Audit & Modeling Research

**League:** UPS Salary Cap Dynasty (MFL `L=74598`) · Superflex · IDP-heavy · TE-premium
**Date:** 2026-08-04
**Status:** ☑ Audit complete · ☐ No production changes made · **4 P0 blockers found**
**Author:** Claude (Opus 5), on branch `claude/ups-fantasy-projections-890cd2`

> **Read this section first.** The audit found four blockers that must be cleared
> before *any* model is trained. Three of them are invisible from the API layer and
> would have produced a model that looked calibrated in backtest and was wrong in
> production. Every claim below is backed by a query against remote D1
> (`ups-mfl-db`, `8cfe1ddd…`) run on 2026-08-04; the query is shown so it can be
> re-run.

---

## 0. Executive summary

| # | Blocker | Severity | Blocks | Status |
|---|---|---|---|---|
| **B1** | `nfl_player_routes` is **player-season aggregate only**. No week column. | P0 — leakage | WR/TE pilot (step 5), all route features | ✅ **CLOSED 2026-08-04** — `nfl_player_routes_weekly` (migration `0115`), 55,086 rows, 2016–2025, gate passed 30/30 |
| **B2** | `nfl_player_weekly.routes_run` is **100% NULL across all 15 seasons** | P0 — leakage | the only other route path | ✅ **CLOSED** — superseded by B1 |
| **B3** | **First downs do not exist anywhere in D1.** UPS pays 0.2/FD, all positions, since 2011. | P0 — scoring | FDPRR + exact UPS scoring reproduction | ✅ **CLOSED** — migration `0114`, backfilled 2011–2025; WR exact reconstructions 15% → 68% |
| **B4** | IDP tackle counts wrong — **root cause was an ETL mis-binding, not upstream data** (see §1.4) | P0 — correctness | all IDP modeling (7 of 17 UPS starters) | ✅ **CLOSED** — backfilled 2011–2025; gate 23/24 cohorts, 2025 exact 97–99% |
| B5 | No historical external projection snapshots exist (zero) | P1 — evaluation | external benchmarking §9 of spec | open — archive-forward only |
| B6 | Injury data is **season-aggregate**; no weekly practice/designation history | P1 | the injury model | open |
| B7 | `src_weekly` has **only weeks 1–13 before 2021** | P1 | "through Week 17" backtests pre-2021 | open — scope decision |
| **B8** | **`player_id_crosswalk` covers only 6–81% of `src_weekly` before 2023, and its missingness is survivorship-biased.** `ff_player_ids` covers 99.6–100% from 2014. | P0 — silently caps the backtest | every feature→target join | ✅ identified + gate script switched; §1.5 |

**Recommendation:** Keith's instinct in the spec (§4) was correct and is now confirmed
with data. Do **not** proceed to step 5 (WR/TE pilot). Run **Phase 0 (data
remediation, B1–B4)** first. Phase 0 is ~1 week and is the difference between a
model that backtests honestly and one that doesn't.

---

# PART 1 — DATA AUDIT

## 1.1 The route-data audit (spec §4) — **CONFIRMED: season-level only**

### Verdict

`nfl_player_routes` contains **completed player-season aggregates**. Not weekly.
Not cumulative as-of-week snapshots. Keith's hypothesis in the spec was right.

Schema (`worker/migrations/0089_nfl_player_routes.sql`) — note the primary key:

```sql
CREATE TABLE nfl_player_routes (
  season INTEGER NOT NULL, gsis_id TEXT NOT NULL,
  routes INTEGER, team_dropbacks INTEGER, routes_tgt INTEGER, routes_rec_yds INTEGER,
  PRIMARY KEY (season, gsis_id)      -- ← no week
);
```

Row counts and magnitudes confirm full-season totals:

| season | rows | players | total routes | max routes | team_dropbacks |
|---|---|---|---|---|---|
| 2016 | 497 | 497 | 99,125 | 673 | 203,574 |
| 2020 | 545 | 545 | 100,000 | 645 | 213,409 |
| 2022 | 543 | 543 | 101,225 | 694 | 214,589 |
| 2024 | 527 | 527 | 100,813 | 718 | 210,549 |
| **2025** | **523** | **523** | 98,506 | 705 | 206,150 |

`rows == players` in every season (one row per player), and `max routes` of
633–718 is a *full season* of pass snaps for a every-down WR. The 523 records the
spec noticed in the 2025 API response is the whole table for that season.

### Why this is a hard leakage ban

A Week 5 2024 prediction that reads `nfl_player_routes` for season 2024 receives
route totals that **include Weeks 6–18**. For a breakout-detection system this is
the single most damaging possible leak: the model would be told, at Week 5, the
season-end route volume of exactly the players whose roles were about to expand.
Backtest lead-time metrics (spec §10) would be fabricated.

**Rule for the feature store:** `nfl_player_routes` is permitted **only** as a
`season <= (target_season - 1)` prior. It is banned as a same-season feature at
any week. This must be enforced in code, not by convention — see §4.4.

### The second route path is also unusable

`nfl_player_weekly.routes_run` (added by migration `0008`) is the only weekly
route column in the schema. It is **empty**:

| season | rows | `routes_run` non-null | SUM(`routes_run`) |
|---|---|---|---|
| 2011–2025 (all 15) | 269,933 | **0** | NULL |

The migration comment anticipated this — *"until a dedicated PFR fetcher ships,
column stays NULL"* — and it never shipped. So **there is currently zero weekly
route data in the database by either path.**

### Route coverage by season × position (spec §4 deliverable)

Positions resolved through `player_id_crosswalk`:

| season | WR | RB | TE | CB | unmapped | unmapped routes |
|---|---|---|---|---|---|---|
| 2023 | 212 | 135 | 115 | 1 | **50** | 2,086 |
| 2024 | 244 | 146 | 132 | 1 | 5 | 91 |
| 2025 | 237 | 144 | 137 | 1 | 4 | 19 |

2024–25 identity coverage is effectively complete. **2023 has a 50-player
crosswalk hole** (2,086 routes unattributed) that must be repaired before 2023 is
used as a training season.

### The fix (B1/B2) is small and well-understood

`pipelines/etl/scripts/fetch_nflverse_routes.py` already does per-game work — it
joins the nflverse participation feed to PBP on `(nflverse_game_id, play_id)`,
filters `qb_dropback == 1`, and tracks `games_seen` as a set of `(game_id, team)`
tuples for the Route% denominator. **`week` is already present in the joined
frame**; it is simply dropped at aggregation time. Building
`nfl_player_routes_weekly` means adding `week` to the group key and to the
`PRIMARY KEY`. The same pass can emit receiving first downs (B3) from the PBP
`first_down_pass` column, which is on the plays already being scanned.

Constraint: the participation feed **starts in 2016**, so weekly routes cannot
predate 2016. This is fine — it still covers the whole proposed 2022–2025
backtest window with 2016–2021 available for priors.

---

## 1.2 First downs — **absent from the database entirely** (B3)

UPS scoring, from `mfl_scoring_rules` (season 2025):

```
FD | 1-999 | *0.2 | QB|RB|WR|TE|PK|PN|DT|DE|LB|CB|S
```

0.2 points per first down, **every position**, and per
`docs/league_context_v1.md` this has been continuous since 2011 (the `1C` → `FD`
rename in 2021 was cosmetic; only the range widened from `1-50` to `1-999`).

There is **no first-down column in any D1 table.** `nfl_player_weekly` has 97
columns; none of them is a first down. Confirmed:

```
$ grep -rl "first_down" worker/migrations/    → (no matches)
$ pragma_table_info('nfl_player_weekly')      → no *_first_down* column
```

This blocks two separate things:

1. **FDPRR** (`fdprr = receiving_first_downs / routes`), which the spec names as a
   core pre-breakout signal — arguably the best one, because first downs capture
   *sustained* target quality without the touchdown noise the spec explicitly
   wants filtered out (§2, item 3).
2. **Exact UPS scoring reproduction** (implementation step 3), which is a hard
   prerequisite for Model C.

### A definitional note the implementation must not get wrong

These are two different fields and both are needed:

| Use | Field | Why |
|---|---|---|
| **FDPRR** (efficiency feature) | receiving first downs **only** | It is a per-route metric. Rushing FDs have no route in the denominator. The spec is explicit: *"Do not combine rushing and receiving first downs."* |
| **UPS `FD` scoring** (Model C) | **all** first downs — pass + rush + receiving | The MFL rule applies to every position with no split. A scrambling QB's rushing FDs score. |

Storing only one of these will silently break the other.

---

## 1.3 UPS scoring reproduction test — quantified per position

I tested whether the current database can reproduce `src_weekly.score` (the
realized UPS points MFL actually awarded) from `nfl_player_weekly` components,
using the exact 2025 `mfl_scoring_rules`. 2025 season, joined on
`gsis_id` via the crosswalk.

| pos | n | actual avg | reconstructed avg | **gap** | MAE | exact (<0.05) |
|---|---|---|---|---|---|---|
| **PK** | 456 | 8.900 | 8.873 | **+0.027** | 0.126 | **384 (84%)** |
| DL | 3,357 | 4.319 | 3.618 | +0.701 | 0.703 | 969 (29%) |
| WR | 2,137 | 8.141 | 7.175 | +0.965 | 0.977 | 321 (15%) |
| DB | 3,310 | 5.492 | 4.330 | +1.162 | 1.167 | 1,008 (30%) |
| LB | 1,808 | 4.794 | 3.538 | +1.256 | 1.256 | 336 (19%) |
| PN | 448 | 7.027 | 5.714 | +1.313 | 1.378 | 140 (31%) |

Two things stand out:

- **PK is essentially solved.** Gap 0.027 pts/game, 84% of weeks reproduced
  exactly. The `fg_distance_sum_made` column (added for the per-yard `FG *.1`
  rule) does its job. Residual MAE is the `MG 0-44` missed-FG penalty and blocked
  kicks. This is the proof that the scoring-engine approach works when the
  components are present.
- **Every other position is biased in one direction.** `MAE ≈ |gap|` throughout
  means the error is almost purely a systematic shortfall, not noise — we are
  missing *additive, non-negative* scoring events, not mismeasuring existing ones.

### Decomposing the WR gap

Gap by reception count reveals two separate components:

| receptions | n | avg gap |
|---|---|---|
| 0 | 512 | **1.236** |
| 1 | 396 | 0.791 |
| 2 | 337 | 0.692 |
| 4 | 225 | 0.875 |
| 6 | 101 | 1.170 |
| 8 | 41 | 1.363 |

The **slope** from 1→8 receptions is ≈ +0.13 per reception. At `FD *0.2`, that
implies a receiving-first-down rate of ~0.65 per reception — which is the correct
real-world number. That is the missing-FD component, cleanly identified.

The **intercept** — 1.24 points for WRs with *zero* receptions — is a different
problem. Inspecting the actual rows:

| week | player | UPS | tgt | rec | rec_yds | rush | rush_yds |
|---|---|---|---|---|---|---|---|
| 9 | Charlie Jones | **12.1** | 0 | 0 | 0 | 0 | 0 |
| 12 | Gunner Olszewski | **9.5** | 0 | 0 | 0 | 0 | 0 |
| 11 | Myles Price | **6.3** | 0 | 0 | 0 | 0 | 0 |
| 2 | Jaylin Noel | **5.4** | 0 | 0 | 0 | 0 | 0 |

These are **return specialists**. Their entire UPS score comes from `KY *0.025`
(kick return yards), `UY *0.05` (punt return yards), and return touchdowns
(`KO`/`PR`, 6 or 7 pts) — **none of which exist in `nfl_player_weekly`**.

A worked example that pins down a third missing piece — Jordan Addison, Week 17:
UPS awarded 13.7 on 1 rush for 65 yards and no receptions. That decomposes as
`65 × 0.1 = 6.5` + `7.0` (rushing TD of **50+ yards** → `RS 50-100 = 7`, not 6)
+ `0.2` (the first down) = **13.7 exactly**. We store `rush_tds` as a count only,
so we cannot tell a 50-yard TD from a 2-yard TD, and we lose 1 point every time.

### Complete list of UPS scoring events not currently derivable

| Code | Rule | Status |
|---|---|---|
| `FD` | 0.2 × all first downs | **absent** (B3) |
| `KY` / `UY` | 0.025 / 0.05 per return yard | **absent** |
| `KO` / `PR` / `IR` / `DR` / `FR` / `MF` | return TDs, 6 or 7 by distance | **absent** |
| `RS` / `RC` / `PS` ≥50 yd | TD scores 7 not 6 | **absent** (only counts stored) |
| `SF` | safety, ×2 | absent |
| `BLF`/`BLP`/`BLE`/`#BF`/`#BP` | blocked kicks | absent |
| `D2` | defensive 2-pt, ×2 | absent |
| `MG` | missed FG 0–44, −0.1/yd | absent (distance needed) |
| `TK`/`AS` | tackles | **present but wrong** — see B4 |

All of the first four are recoverable from `nflfastR` PBP, which is already being
loaded by `fetch_nflverse_pbp.py`.

### Post-fix measurement — first downs land (2026-08-04)

WR reconstruction, 2024, identity resolved through `ff_player_ids` (n=2,075):

| | mean gap | MAE | exact (<0.05) |
|---|---|---|---|
| without first downs | 0.792 | 0.814 | — |
| **with first downs** | **0.445** | **0.471** | **1,420 / 2,075 = 68.4%** |

First downs close **44%** of the offensive gap on their own, and exact
reconstructions rise from ~15% to 68%. The residual 0.445 is the return game
(`KY`/`UY`/`KO`/`PR`) and the ≥50-yard TD bonus — Appendix C items C9 and C10,
both of which require PBP rather than the box-score feed.

---

## 1.4 IDP tackle data is materially wrong (B4) — **the most serious finding**

This one is not a missing feature. It is **incorrect data currently in the
database**, in the position group that makes up the largest share of UPS scoring.

### Evidence 1 — assists have collapsed

League-wide season sums from `nfl_player_weekly`:

| season | Σ solo | Σ assist | Σ total | assist/solo |
|---|---|---|---|---|
| 2020 | 21,447 | 1,664 | 23,111 | 7.8% |
| 2021 | 21,049 | 3,145 | 24,194 | 14.9% |
| 2022 | 20,771 | 3,531 | 24,302 | 17.0% |
| 2023 | 20,419 | 3,725 | 24,144 | 18.2% |
| 2024 | 20,223 | 2,572 | 22,795 | 12.7% |
| **2025** | 20,683 | **702** | 21,385 | **3.4%** |

Real NFL assist rates run ~35–50% of solo tackles. **2025 is at 3.4% and
falling** — the assist feed is effectively dead in the current season, the one
that matters most for the live model.

### Evidence 2 — the scoring gap on pure-tackle weeks

Isolating **pure-tackle weeks** (zero sacks, TFL, QB hits, PD, INT, FR, FF, def
TD — so tackles are the *only* thing that can score) and applying the exact UPS
per-position rates (`DL TK 1.5/AS 0.5`, `DB TK 1.3/AS 0.8`, `LB TK 1.0/AS 0.5`):

| pos | n | actual UPS | tackle-implied | gap |
|---|---|---|---|---|
| DB | 1,966 | 3.402 | 2.449 | 1.079 |
| LB | 1,098 | 2.615 | 1.728 | 0.945 |
| DL | 1,574 | 1.701 | 1.187 | 0.635 |

On weeks where tackles are provably the only scoring input, the stored tackles
account for barely half the points MFL awarded.

### Evidence 3 — against known ground truth

2023 season leaders as stored, versus official NFL totals:

| player | D1 solo | D1 ast | D1 total | **official combined** | ratio |
|---|---|---|---|---|---|
| Foyesade Oluokun | 91 | 20 | 111 | **173** | 64% |
| Zaire Franklin | 87 | 20 | 107 | **179** | 60% |
| Bobby Wagner | 77 | 19 | 96 | **183** | 52% |

(Official 2023 totals verified against Pro-Football-Reference / StatMuse — these
were the NFL's top three tacklers that season.)

### Root cause — **RESOLVED 2026-08-04**

> ⚠️ **This section originally attributed the defect to incomplete
> PBP-attributed tackle data in nflverse, and prescribed re-sourcing from
> `tackles_solo` / `tackles_with_assist`. Both were wrong.** nflverse's data was
> complete all along; the ETL was discarding two-thirds of it. Worse, the
> prescribed fix would have made the database *worse than the bug*. Corrected
> below. The original text is preserved in git history.

The NFL gamebook records **three disjoint tackle credits**, and nflverse parses
each into its own column. Verified at PBP level: across all 702
`tackle_with_assist` plays in 2025, the twa player appears as `solo_tackle_N`
zero times and as `assist_tackle_N` zero times — no overlap in either direction.

| gamebook notation | nflverse column | UPS scores it as |
|---|---|---|
| `(A)` — unassisted | `def_tackles_solo` | **TK** |
| `(A, B)` comma — A made it with help | `def_tackles_with_assist` | **TK** |
| `(A, B)` B, and `(A; B)` both | `def_tackle_assists` | **AS** |

So:

```
MFL TK = def_tackles_solo + def_tackles_with_assist
MFL AS = def_tackle_assists
official combined (== PFR `comb`) = all three
```

Bobby Wagner 2023: **77 solo + 19 twa + 87 assists = 183**, exactly PFR's
number. Solo + assists alone reaches only 0.917–0.992 of official in any season,
which is what produced the illusion of an upstream undercount.

**The actual defect** was in `fetch_nflverse_weekly.py`. `def_tackles_ast` was
bound to an alias list whose first entry, `def_tackles_with_assist`, is a
*tackle* count — while the real assist column `def_tackle_assists` was absent
from the list entirely, so `pick()` could never reach it. Three of the four
aliases have never existed in any season 1999–2025, and the fourth
(`tackles_for_loss_assist`) is a different stat altogether.

**Why it went unnoticed for two years — and the trap it set.** The derived
`def_tackles_total = solo + ast` was *accidentally correct*: because `ast` held
`twa`, the total equalled `solo + twa`, which is exactly the MFL TK count. The
two errors cancelled. Fixing the alias **alone** breaks that cancellation and is
strictly worse than the original bug:

| | 2025 IDP MAE vs realized UPS | league IDP points |
|---|---|---|
| as stored (the bug) | 0.811 | 33,639 (−18.8%) |
| **alias-only "fix"** | **1.626** | **56,426 (+36.2%)** |
| full fix | **0.029** | 41,034 (−0.94%) |
| *realized* | — | *41,426* |

A 2025-only validation hides this, because `def_tackles_with_assist` collapsed
to 702 that season from 3,725 in 2023. The alias-only fix looks ~95% effective
in 2025 and closes only 54–69% of the gap in 2023–24.

**Verified fix** (shipped 2026-08-04, migration `0114`):

1. `def_tackles_ast` → `["def_tackle_assists"]`, single alias.
2. New column `def_tackles_with_assist`, persisted in
   **`nfl_player_weekly_ext`** — `nfl_player_weekly` is at D1's hard 100-column
   cap and `ALTER TABLE` on it now fails outright.
3. `def_tackles_total` → `solo + twa + ast` (official combined). **Not a scoring
   input** — TK and AS are separate expressions.
4. `backfill_pass_sacks.py` no longer writes `def_tackles_total`. It derived it
   from the same wrong alias and, because `D1Writer` overwrites unconditionally,
   would have silently reverted the fix on its next run.
5. Full 2011–2025 backfill — the mis-binding affects every season, and
   `twa/solo` varies 3.4%–18.2% year to year, so a 2025-only fix would bake a
   fake ~+80% assist step at the 2024/25 boundary that a projection model would
   learn as real signal.

**Ground truth confirms nflverse is sufficient.** Against MFL's own `detailed?`
report for 2025 (n=54 IDP player-weeks, deliberately weighted toward `twa ≥ 2`
rows — the cases that discriminate between the competing hypotheses): tackles
**54/54 exact**, assists **54/54 exact**, mean |Δ| = 0.000. MFL `detailed?`
stays a sampled spot-audit tool, not the source of record — it is keyless for
the *current season only* (2024 and earlier return "Missing User ID") and is one
HTTP request per player-week.

### Why this matters more in UPS than elsewhere

From `src_weekly` (2025), **IDP is the largest block of the player pool**:

| pos_group | player-weeks | players |
|---|---|---|
| DB | 3,876 | 399 |
| DL | 3,794 | 399 |
| WR | 2,391 | 237 |
| LB | 2,164 | 213 |

IDP is **7 of 17 starting slots**, and UPS pays a DL premium (`TK *1.5` for
DT/DE vs `*1.0` for LB).

### Method note

The original diagnosis in this section was produced from aggregate column sums
and a single season. It was overturned by a four-stream parallel investigation
plus three adversarial verification lenses, all of which independently reached
the three-credit model via different routes (MFL `detailed?` line items, PFR
combined-tackle parity, `src_weekly` points reconstruction, and raw PBP
notation). **Aggregate sums were sufficient to detect the defect and
insufficient to diagnose it.** Points-level reconstruction against `src_weekly`
is the check that would have caught the bad fix; it is now the acceptance gate
for every Phase 0 item.

---

## 1.5 Full table inventory

### Present and usable

| table | grain | seasons | rows | notes |
|---|---|---|---|---|
| `nfl_player_weekly` | season/week/gsis | 2011–2025 | 269,933 | 97 cols; PFR advstats 2018+; **tackles suspect (B4)** |
| `nfl_player_snaps` | season/week/**`pfr_id`** | **2013**–2025 | 324,608 | off/def/ST snaps + pct. **Not 2012 as migration 0006 claims — and not keyed by `gsis_id` either, despite that migration's comment.** Join via `ff_player_ids.pfr_id`, guarding both ids against the literal `"NA"`. (Corrected 2026-08-04; this row originally said gsis.) |
| `nfl_player_redzone` | **season/week**/gsis | 2011–2025 | 81,039 | i20/i10/i5 rush & targets, `targets_ez` — genuinely weekly, excellent |
| `nfl_team_vegas_weekly` | season/week/team | 2011–2025 | 8,192 | spread, total, implied total |
| `nfl_team_coaching_history` | season/team | 2011–2025 | 480 | HC/OC/DC + `*_change_flag` + tenure year |
| `nfl_team_weekly` | season/week/team | — | — | 4th-down tendency, stall punts |
| `nfl_team_pace` | season/team | 2014–2025 | 384 | |
| `nfl_player_epa` | season/gsis | 2014–2025 | 7,215 | **season grain — same leakage class as routes** |
| `nfl_player_ngs` | season/gsis | 2016–2025 | 3,383 | **season grain** — separation, cushion, RYOE |
| `nfl_player_ftn` | season/gsis | 2022–2025 | 2,301 | **season grain** |
| `nfl_player_splits` | season/gsis | 2016–2025 | 25,931 | **season grain** |
| `mfl_scoring_rules` | season/pos-group | 2010–2025 | 1,099 | exact MFL rules, all eras |
| `src_weekly` | season/week/mfl_id | 2010–2025 | 231,154 | **realized UPS points — the training target** |
| `player_id_crosswalk` | mfl_id | — | 2,859 | 2,320 with gsis |
| `nfl_player_injuries_season` | **season**/gsis | 2014–2025 | 16,444 | aggregate only (B6) |

### Grain warning

`nfl_player_epa`, `nfl_player_ngs`, `nfl_player_ftn`, `nfl_player_splits` are
**all season-grain**, exactly like `nfl_player_routes`. They carry the same
leakage risk and need the same prior-season-only rule. This is a systemic pattern
in the advanced-stats layer, not a one-off — which is why §4.4 proposes enforcing
it structurally rather than by review.

### Identity coverage — **use `ff_player_ids`, not `player_id_crosswalk`** (B8)

> ⚠️ **This section originally read "coverage is effectively complete" based on a
> 2025-only check. That was wrong and would have silently capped the backtest.**
> Corrected 2026-08-04.

`gsis_id` is the right join key, as the spec requires. But **which table you
resolve it through changes the usable history by nine seasons.**

`player_id_crosswalk` is built from MFL's *current* player list, so historical
players who have since dropped off it were never given a row. Coverage of
`src_weekly` — the training target — decays badly going back:

| season | `player_id_crosswalk` | **`ff_player_ids`** |
|---|---|---|
| 2014 | 6.3% | **99.7%** |
| 2016 | 15.2% | **99.6%** |
| 2018 | 33.8% | **100%** |
| 2020 | 53.5% | **100%** |
| 2022 | 80.6% | **99.9%** |
| 2023 | 92.8% | **99.9%** |
| 2025 | 99.7% | **99.9%** |

Two consequences, both severe:

1. **The crosswalk caps the honest backtest at 2023–2025.** In 2022, 19.4% of UPS
   player-weeks (8,619 realized points) cannot be joined to any NFL stat.
2. **Worse, the missingness is not random.** A player is in the crosswalk because
   MFL still lists him — i.e. because he had a long career. Training on
   crosswalk-joined 2014–2022 data means training on survivors, which biases
   exactly the breakout labels this system exists to predict.

Switching the identity join to `ff_player_ids` (12,468 rows, no duplicate
`mfl_id`) takes every season 2014–2025 to 99.6–100%, with 0–150 unmapped points
per season out of ~80,000.

**Measured impact on the acceptance gate.** Re-running the 2018 IDP
reconstruction with the corrected join roughly tripled the cohorts and *improved*
the fit — consistent with the survivorship story:

| | n | gap |
|---|---|---|
| via `player_id_crosswalk` | 477 | 0.182 |
| via `ff_player_ids` | 1,620 | **0.119** |

### ⚠️ `ff_player_ids.gsis_id` stores missing as the literal string `"NA"`

**4,740 of 12,468 rows** are not well-formed gsis ids — most are the string
`"NA"` (R's missing-value idiom serialised as text), the rest college/PFR-style
short ids like `MEN516487` for draft prospects.

`"NA"` passes `IS NOT NULL` **and** passes `!= ''`. An unguarded join therefore
reports **100% coverage while matching garbage** — this is a live fail-open in
the data, and it fooled the first version of this measurement. Every join must
require the format:

```sql
COALESCE(f.gsis_id,'') LIKE '00-%'
```

Related trap, hit in the same session: `NOT (a LIKE '..' OR b LIKE '..')`
evaluates to `NULL` when both are NULL, and `CASE WHEN NULL THEN 1 ELSE 0 END`
scores it **0** — so a "count the unmapped" query silently reports zero. Count
the positive case and subtract, or `COALESCE` every operand.

### `src_weekly` structural limit (B7)

| season | week range | is_reg rows | total rows |
|---|---|---|---|
| 2019 | **1–13** | 14,090 | 14,090 |
| 2021 | 1–17 | 15,830 | 16,861 |
| 2025 | 1–17 | 15,720 | 16,791 |

Before 2021, `src_weekly` holds **weeks 1–13 only** with no playoff rows. The
spec's "at least two top-12 weeks through Week 17" target is therefore only
computable for **2021–2025**. This is adequate — it covers the proposed 2022–2025
walk-forward — but pre-2021 seasons can only be used for priors, not for
elite-week label construction.

---

## 1.6 Leakage register

Every vector found, with the enforcement rule:

| # | Vector | Rule |
|---|---|---|
| L1 | `nfl_player_routes` season totals used in-season | Prior seasons only, ever |
| L2 | `nfl_player_epa` / `ngs` / `ftn` / `splits` season totals | Prior seasons only, ever |
| L3 | `nfl_player_injuries_season` (aggregates a completed season) | Prior seasons only |
| L4 | Current depth charts / current MFL roster state applied to historical rows | Snapshot with effective date or exclude |
| L5 | `nfl_team_coaching_history` change flags | Known preseason — safe, but the *tendency prior* must be built from prior seasons only |
| L6 | `nfl_team_vegas_weekly.actual_score` | Never a feature. `spread`/`total_line` are pregame and safe |
| L7 | Role events backfilled from hindsight | `model_player_role_events` requires `source_url` + `effective_date`; no row without provenance |
| L8 | Accuracy-weighted external consensus using same-season accuracy | Weights from strictly prior seasons (spec §4 already flags this) |
| L9 | `player_id_crosswalk` built from end-state rosters | Low risk (identity, not performance) — accept, document |

---

# PART 2 — EXTERNAL BENCHMARK AUDIT

*This is the separate deliverable the spec asks for before external consensus is
integrated. The answer is blunt.*

## 2.1 Historical snapshot inventory: **empty**

| source | historical pregame snapshots in repo/D1? |
|---|---|
| FantasyPros consensus (yearly/weekly/ROS) | **none** |
| ESPN / Mike Clay | **none** |
| FTN / Jeff Ratcliffe | **none** |
| PFF fantasy projections | **none** |
| DraftSharks IDP | **none** |
| CBS | **none** |
| **MFL's own projections** (`ups_player_projections`) | **2026 week 1 only — 1,347 rows, 1 capture, first captured 2026-07-31** |

```sql
SELECT season, COUNT(*), COUNT(DISTINCT week), AVG(capture_count) FROM ups_player_projections GROUP BY season;
-- 2026 | 1347 | 1 | 1.0
```

The table has exactly the right shape for this purpose — it carries
`first_projected`, `first_captured_at`, `updated_at`, `capture_count`, so it
preserves the *first* projection and counts revisions. It just has no history yet.

**Conclusion: the spec's §9 ("Backtest UPS against each source") is not
executable today, for any source, at any horizon.** Stating this plainly is the
required deliverable; it is not a reason to stall the rest of the build.

## 2.2 What does exist is market data, not projections

| file / table | content | seasons |
|---|---|---|
| `docs/auction/data/fpros_adp_history.csv` | FantasyPros positional ADP rank | 2022–2026 |
| `docs/auction/data/dynasty_adp_history.csv` | dynasty ADP | — |
| `docs/auction/data/adp_history.csv` | FantasyFootballCalculator ADP | — |
| `ups_auction_history`, `ups_auction_bids` | **UPS realized auction prices** | multi-year |
| `player_contracts`, `src_contracts` | MFL salary | full history |

The spec is right to separate these (§1 "Market benchmarks"). ADP is a market
signal — it encodes contingency value and roster-construction convention, not a
point estimate of production. It cannot substitute for a projection benchmark.

⚠️ Per prior findings recorded for this project, `adp_history.csv` is **early
best-ball FFC data and inflates rookies** (a known case had Gadsden shown TE12
against a real TE41). Use `fpros_adp_history.csv` for 2022+ and treat the FFC
file as suspect.

## 2.3 Licensing

FantasyPros, PFF, FTN and ESPN projections are all behind terms that permit
personal use but prohibit redistribution. That is compatible with what is needed
here — snapshots stored privately in D1 for personal backtesting, never exposed
through a public Worker endpoint. `model_external_player_projections` must
therefore sit behind the same commish-only gate already used for LRDG-derived
analytics.

## 2.4 Punters — the spec's instinct is correct and the reason is quantifiable

UPS punter scoring is genuinely unlike any public fantasy punter format:

```
PI  | 0-20        | *4      ← 4 points per punt inside the 20
ANY | 45.00-49.99 | 1
ANY | 50.00-59.99 | 3
ANY | 60.00-100.00| 5
HBP | 0-10        | *-2
```

At 4 points per inside-20 punt, a punter with 4 such punts scores 16 — more than
most starting RB weeks. No external punter projection models this. The spec's
direction (benchmark punters internally against historical UPS distributions,
punt volume, and team drive-failure rate) is the only defensible approach.
Encouragingly, the components are already present: `punt_inside20`,
`punt_inside20_pbp`, `punt_net_yds_sum`, `punt_spot_sum`, plus
`nfl_team_weekly.stall_punts`.

## 2.5 Recommendation

1. **Start archiving now**, weekly, into `model_external_projection_snapshots`.
   Even one season of honest snapshots makes 2027 benchmarking possible; zero
   snapshots makes it permanently impossible.
2. **Do not attempt to reconstruct historical projections.** Re-downloading a
   2023 projection page in 2026 returns a post-hoc revised artifact. The spec
   already forbids this (§2) and it must stay forbidden.
3. **Ship UPS without external blending.** The spec's own gate — *"Only blend
   external projections into production if the ensemble beats UPS alone in true
   walk-forward testing"* — cannot be satisfied, so the honest action is to not
   blend.
4. The **internal** baselines (§12) are all computable today from `src_weekly`
   and are the real acceptance bar for v1.

---

# PART 3 — MODELING RESEARCH

Assessed against what this dataset can actually support, not generic
fantasy-football claims.

## 3.1 Empirical-Bayes / partial-pooling shrinkage

**How:** estimate a position-level prior for each rate (TPRR, YPRR, FDPRR, TD
rate, tackle rate), then shrink each player toward it by
`w = n / (n + k)`, with `k` fitted from the between-player vs within-player
variance ratio.

**Advantages.** Directly implements the spec's route-sample bands (<100 heavy
shrink / 100–199 preliminary / 200+ established) with a principled `k` instead of
hand-set thresholds. It is the only method here that behaves correctly on the
40-route YPRR leader the spec calls out. It naturally produces the spec's
differential update speeds (§3 of the second brief: routes fast, TPRR moderate,
YPRR slow, TD rate very slow) — those are just different `k` per metric,
estimable from data rather than asserted.

**Limitations.** Not a full model on its own; it is a stabilizer feeding Model B.
Assumes exchangeability within a position, which is violated for role-changing
players — exactly the population we care about. Mitigation: condition the prior
on role tier, not just position.

**Data:** available today for everything except FDPRR (B3) and IDP rates (B4).

**Verdict: adopt as the efficiency layer.** Low risk, high value, and it is the
mechanism that makes the preseason→in-season blend of the second brief work.

## 3.2 Component simulation (opportunity × efficiency → UPS)

**How:** the spec's Models A+B+C. Simulate opportunity, then efficiency, then
score each draw with the exact UPS rules, then take empirical quantiles.

**Advantages.** The only approach that gives a *causally* interpretable answer to
"why did this projection change" — a requirement in §9 and §11 of the second
brief, not a nice-to-have. Handles UPS's unusual scoring exactly (TE 1.5 PPR, DL
tackle premium, punter PI ×4) rather than approximating it. Scenario mixtures
(60/25/15 role outcomes) fall out naturally and prevent the failure mode the spec
names — projecting a player at his best-case role. Rare events (TD, INT, FR,
blocks) can be given fat-tailed treatment so they move P90 far more than P50,
which is precisely what the spec asks.

**Limitations.** Error compounds across stages. Correlation structure must be
modeled explicitly or season aggregates will be badly under-dispersed — this is
the classic failure and it is where the second brief's warning ("do not calculate
annual P90 by adding weekly P90 values") bites. Computationally the heaviest
option.

**Data:** requires weekly routes (B1), first downs (B3), correct tackles (B4).
**Blocked until Phase 0 completes.**

**Verdict: this is the champion**, as the spec proposes. It is the only design
that satisfies the explainability and role-scenario requirements.

## 3.3 Gradient-boosted quantile regression (direct challenger)

**How:** `HistGradientBoostingRegressor(loss="quantile", quantile=q)` or XGBoost
with pinball objective, at q ∈ {0.50, 0.75, 0.90}, on the as-of feature store.

**Advantages.** Strong baseline, cheap to train, handles nonlinearity and
interactions without feature engineering, and gives an honest external check on
whether the simulation's structure is earning its complexity. Directly optimizes
the metric being reported (pinball loss).

**Limitations.** Independent quantile fits **cross** — P90 < P75 happens in
sparse regions. Must be enforced by fitting monotonically or post-hoc sorting;
the spec correctly requires `P90 >= P75 >= P50`. Cannot express role scenarios or
answer "why did this change" beyond SHAP attribution. Extrapolates poorly to
role changes with no historical analogue — which is the pre-breakout population.

**Data:** trainable today on non-route features; much stronger after Phase 0.

**Verdict: build as the challenger,** exactly as the spec frames it. Expect it to
win on aggregate pinball loss for stable veterans and lose on role-change cases.
That split is itself the useful finding.

## 3.4 Conformalized quantile regression (CQR)

**How:** fit quantile models, then calibrate interval width on a held-out set so
coverage is guaranteed in finite samples.

**Advantages.** Gives *distribution-free* coverage guarantees — the cleanest path
to the spec's hard requirement that "approximately 90% of comparable actual
outcomes finish at or below P90." Cheap: a wrapper over 3.3. Can be conditioned
by position and projected-score bucket, giving the spec's per-bucket coverage
tables directly.

**Limitations.** Guarantees *marginal* coverage; conditional coverage on small
strata (e.g. PN, or "just promoted") can still be off. Needs a genuine held-out
calibration split, which competes with training data in a dataset this size.
Requires exchangeability — violated across seasons with rule changes (the 2018
IDP rebalance and 2025 TE premium are real regime breaks).

**Verdict: adopt as the calibration layer over whichever model wins.** This is
the most under-rated item in the spec — it converts "our P90 looks about right"
into a testable guarantee, and it applies to the simulation output just as well
as to the GBM.

## 3.5 Direct elite-week classification

**How:** binary classifier for P(top-12 positional week), separate from the
regression.

**Advantages.** Elite weeks are rare and driven by different mechanics
(touchdowns, return scores, defensive TDs) than median production. A dedicated
classifier optimized on log-loss/Brier usually beats thresholding a quantile
model. Multi-week questions ("≥1 in next four", "≥2 through Week 17") are then
computed by simulation over weekly probabilities, never by summing — as the spec
requires.

**Limitations.** Class imbalance (~12/200 per position-week). Requires the
top-12 threshold to be recomputed weekly from realized `src_weekly` ranks, and
that threshold is itself noisy. Needs the correlation structure to answer
multi-week questions, so it does not remove the need for simulation.

**Verdict: adopt (Model E),** with calibration curves reported per position.

## 3.6 Position-specific vs pooled models

**Recommendation: hybrid, and this is forced by UPS's scoring, not by taste.**

- **Pooled with position as a feature** for *opportunity* — snap-share dynamics,
  depth-chart promotion, injury vacancy all behave similarly across positions,
  and pooling buys sample for the rare-event tails.
- **Position-specific for efficiency and scoring** — non-negotiable. `TE CC 1.5`
  vs `RB CC 0.8`, `DT/DE TK 1.5` vs `LB TK 1.0` vs `CB/S TK 1.3`, and `PN PI 4.0`
  mean a pooled efficiency model would learn a blend that is wrong everywhere.
- **PK and PN get their own small models.** PK already reproduces at
  MAE 0.126 — a simulation over FG distance bands will beat any learned model
  and should not be replaced by one.

## 3.7 Summary

| method | role | blocked by Phase 0? |
|---|---|---|
| Empirical-Bayes shrinkage | efficiency stabilizer (Model B) | partly (B3, B4) |
| **Component simulation** | **champion** (Models A+B+C) | **yes** |
| GBM quantile regression | challenger (Model D) | no |
| Conformalized QR | calibration layer over the winner | no |
| Direct elite classification | Model E | no |
| Hybrid pooling | applies to all | no |

---

# PART 4 — SYSTEM DESIGN

## 4.1 Architecture

Per the spec: **no training in D1 or the Worker.** Python owns feature
generation, training, backtesting and inference; D1 is a read store; the Worker
serves it.

```
nflverse ─┐
MFL API  ─┼→ Python ETL ─→ model_player_week_features (as-of)
D1 src_* ─┘                        │
                                   ├→ Model A opportunity
                                   ├→ Model B efficiency (EB-shrunk)
                                   ├→ Model C UPS simulation  ── champion
                                   ├→ Model D GBM quantile     ── challenger
                                   ├→ Model E elite classifier
                                   └→ CQR calibration
                                          │
                                          ↓
                          D1 model_* tables (write-once snapshots)
                                          ↓
                          Worker read-only endpoints → reports
```

## 4.2 Table set

Prediction//output tables, all **append-only** (the spec requires prior snapshots
never be overwritten):

| table | grain |
|---|---|
| `model_player_week_features` | season, week, gsis_id, as_of_ts |
| `model_team_context_weekly` | season, week, team, as_of_ts |
| `model_player_role_events` | event_id |
| `model_player_week_predictions` | season, week, player, model_version, as_of_ts |
| `model_player_preseason_predictions` | season, player, model_version, as_of_ts |
| `model_player_ros_predictions` | season, week, player, model_version, as_of_ts |
| `model_player_season_finish_predictions` | season, week, player, model_version, as_of_ts |
| `model_projection_change_log` | change_id |
| `model_backtest_predictions` | backtest_id, season, week, player |
| `model_calibration_summary` | model_version, position, bucket |
| `model_recommendation_history` | rec_id |
| `model_versions` | model_version |
| `model_external_projection_sources` / `_snapshots` / `_player_projections` / `_consensus` | per §11 of brief 3 |
| `model_projection_variances` / `_variance_explanations` / `model_external_source_accuracy` | per §11 |

**None of these collide with existing production tables.** Every name is new; no
existing table or report is modified. This satisfies the spec's step 14.

## 4.3 The as-of contract

Every feature row carries `as_of_ts` and every source column carries a known
effective date. The invariant:

> A row keyed `(season=S, week=W, as_of_ts=T)` may contain **only** facts whose
> effective date is `< T`, and `T` must be before kickoff of that game.

## 4.4 Enforcing leakage structurally

Convention will not hold across a system this size — §1.5 shows four separate
season-grain tables that all look weekly at the API layer. Proposal:

1. **Every feature declares a grain and a max-season offset in a manifest.**
   Season-grain sources are declared `max_season_offset = -1`; the builder
   refuses to emit a same-season value for them. A missing declaration is a hard
   error, never a default.
2. **A leakage unit test** asserts that rebuilding features for
   `(season=2024, week=5)` produces byte-identical output whether or not weeks
   6–18 are present in the source tables. This catches the whole class in one
   assertion and is the single highest-value test in the system.

This follows the project's existing no-fail-open-guards rule: an unreadable or
undeclared input must refuse, not silently proceed.

## 4.5 Correlation — the second brief's key constraint

Season P90 must be the 90th percentile of **simulated season totals**, never a
sum of weekly P90s. To make season totals correctly dispersed, simulation draws
must be correlated within a player-season:

- **Role persistence** — a Markov chain over role states (starter / rotational /
  reserve), not an independent weekly draw. Winning a job persists.
- **Injury persistence** — a multi-week absence process with a return-week
  distribution and an elevated re-injury hazard, not an independent weekly coin
  flip.
- **Player-season efficiency draw** — sample each player's true rates *once per
  simulation*, then draw weekly outcomes conditional on them. This is what
  produces realistic season-total spread; independent weekly rates would collapse
  the variance.
- **Team-level shocks** — QB change, coordinator change, and pace shifts drawn at
  team level and applied to all affected players simultaneously, so teammate
  outcomes correlate as the spec requires.

## 4.6 Terminology

Per the spec, **P90 is the conditional 90th percentile** — ~90% of comparable
actual outcomes at or below it, ~10% above. It is not a ceiling and must not be
labeled one in any table, endpoint, or report. This will be enforced in column
naming (`ups_p90`, never `ups_ceiling`).

---

# PART 5 — REVISED IMPLEMENTATION PLAN

The spec's 14-step order is sound. The audit inserts a **Phase 0** ahead of it.

## Phase 0 — Data remediation (blocks everything) · ~1 week

| # | Task | Gate | Status |
|---|---|---|---|
| 0.1 | Build `nfl_player_routes_weekly` from participation × PBP | Σ weekly routes == existing season totals, per player, 2016–2025 | ✅ **PASSED** — see below |
| 0.2 | Add receiving / rushing / passing first downs | WR reception-slope gap (§1.3) closes to ~0 | 🔨 shipped (`0114`), backfilling |
| 0.3 | Add return yards, return TDs, TD distance bands, safeties, blocked kicks | WR zero-reception intercept closes | ✅ return game (`0117`, C9), TD distance tiers + kickoff-return TDs + 2-pt conversions (`0119`, C10/C12). Remaining: safeties (C12), blocked kicks (C13 — blocker only named in the PBP description) |
| 0.4 | **Correct IDP tackle semantics** (was: "re-source from official stats" — the data was never the problem) | pure-tackle-week gap < 0.10 for DL/LB/DB | 🔨 shipped + `backfill_pass_sacks.py` second writer disarmed; backfilling 2011–2025 |
| 0.5 | Repair the 2023 crosswalk hole (50 route players) | unmapped routes < 100 | open |
| 0.6 | Ship the leakage manifest + week-truncation test | test green | ✅ **DONE** — `lib/asof.py` + `test_asof_leakage.py`, green on 2024 W3/W6/W10/W17 |

**Tooling added:** `pipelines/etl/scripts/validate_ups_idp_reconstruction.py` is the
standing acceptance gate for 0.4 — it reads **only D1** (the existing
`validate_scoring_alignment.py` reads nflverse directly and therefore cannot
detect a regression in the stored table), applies era-correct UPS rates, and
**refuses to report a pass on cohorts below a sample floor** rather than
fail-open. `backfill_tackle_semantics.py` does the targeted column backfill.

> **Gate revised from < 0.05 to < 0.10.** A small negative residual survives in
> every season from return yardage, distance-scaled defensive TDs, blocked kicks
> credited to the blocker, and MFL's 1-decimal rounding — none of which are
> modelled yet. Demanding < 0.05 before 0.3 lands would force either dishonest
> tuning or an indefinite block.

### Phase 0 FINAL — UPS scoring is now reproducible from D1

With C10/C12 landed (`0119`), the offensive scoring engine reconstructs realized
UPS points almost exactly. 2025, identity via `ff_player_ids`:

| pos | n | actual avg | gap | MAE | **exact (<0.05)** |
|---|---|---|---|---|---|
| **TE** | 1,094 | 7.500 | −0.005 | 0.010 | **99.5%** |
| **RB** | 1,418 | 8.585 | +0.023 | 0.034 | **98.0%** |
| **WR** | 2,137 | 8.141 | −0.006 | 0.038 | **94.5%** |

Against the original audit baseline of **WR gap 0.965, 15% exact**. The residual
gap is now within rounding in both directions.

The path there, and what each piece was worth on WR:

| stage | gap | exact |
|---|---|---|
| box score only (audit baseline) | 0.965 | 15% |
| + first downs (`0114`) | 0.649 | — |
| + return game (`0117`) | 0.217 | 79% |
| + special-teams tackles *(already in D1 — the formula was incomplete, not the data)* | 0.074 | 92% |
| **+ TD distance tiers, kickoff-return TDs, 2-pt conversions (`0119`)** | **−0.006** | **94.5%** |

> **Method note worth keeping.** Before building the PBP pipeline for C10 I
> plotted the residual distribution rather than assuming what was in it. It
> showed two clean ladders — **+0.5 increments** and **−0.2 increments**. The
> −0.2 ladder was first downs; the +0.5/+1.0 ladder turned out to be `AS *0.5` /
> `TK *1.0`, i.e. **UPS pays skill players for special-teams tackles**, and my
> reconstruction had simply omitted a term. That alone was worth 0.217 → 0.074
> and needed no new data at all. Only the genuinely irreducible remainder — 51
> player-weeks at +1.0 (the 50+ yard tier), 51 at +2.0 (two-point conversions)
> and 15 at +7.0 (kickoff return TDs) — justified the PBP build. Measuring the
> residual first turned a large speculative pipeline into a small targeted one.

### Task 0.3/0.4 — gate 24/24 PASSED after the return game landed

Adding the return game (migration `0117`) closed the last cohort. The gate now
reconstructs every scoring input D1 holds, so returns no longer leak into the
"pure-tackle" cohort as unexplained points:

| | before returns | after returns |
|---|---|---|
| **2018 DB** (the sole miss) | 0.119 **FAIL**, 93.2% exact | **0.040 PASS, 97.7% exact** |
| 2025 DL / DB / LB | 0.018 / 0.063 / 0.007 | **0.018 / 0.026 / 0.006** |
| 2025 exact% | 99.3 / 97.2 / 99.5 | **99.3 / 99.0 / 99.7** |
| verdict | 23 / 24 | **24 / 24 PASSED** |

**Offensive reconstruction (2025 WR, n=2,137)** — the full progression:

| stage | mean gap | exact (<0.05) |
|---|---|---|
| box score only | 0.965 | 321 (15%) |
| + first downs | 0.649 | — |
| **+ return game** | **0.217** | **1,689 (79%)** |

**78% of the offensive gap closed**, exact reconstructions 15% → 79%.

Most tellingly, both *structural signatures* identified in §1.3 are gone:

| WR receptions | gap before | gap after |
|---|---|---|
| 0 | **1.236** | **0.273** |
| 1 | 0.791 | 0.239 |
| 2 | 0.692 | 0.143 |
| 4 | 0.875 | 0.254 |
| 8 | 1.363 | — |

The **intercept** (return specialists scoring from nothing) collapsed, and the
**slope** (+0.13/reception, the missing first downs) is now flat. What remains is
a uniform ~0.25 residual — the ≥50-yard TD tier, kickoff-return TDs and blocked
kicks, all of which need PBP (C10–C13).

### Task 0.4 interim — IDP tackles, gate 23/24 (before returns)

`validate_ups_idp_reconstruction.py`, pure-tackle weeks, identity via
`ff_player_ids`, era-correct UPS rates. Backfill wrote 269,274 main rows and
87,417 ext rows across 2011–2025.

| season | DL gap | DB gap | LB gap | exact% (DL/DB/LB) |
|---|---|---|---|---|
| 2018 | 0.038 | **0.119 FAIL** | 0.026 | 97.7 / 93.2 / 97.8 |
| 2019 | 0.055 | 0.095 | 0.026 | 96.8 / 94.2 / 97.6 |
| 2020 | 0.054 | 0.077 | 0.032 | 96.4 / 95.3 / 97.1 |
| 2021 | 0.060 | 0.077 | 0.049 | 96.2 / 94.9 / 96.5 |
| 2022 | 0.082 | 0.086 | 0.063 | 95.1 / 94.8 / 94.5 |
| 2023 | 0.088 | 0.069 | 0.065 | 94.3 / 95.5 / 94.2 |
| 2024 | 0.019 | 0.050 | 0.018 | 98.7 / 96.7 / 98.7 |
| **2025** | **0.018** | **0.063** | **0.007** | **99.3 / 97.2 / 99.5** |

Against the pre-fix baseline (2025): DL **0.635 → 0.018**, LB **0.945 → 0.007**,
DB **1.079 → 0.063** — 97%, 99% and 94% of the gap closed, with 97–99% of
player-weeks now reproduced exactly.

**The one miss** is 2018 DB at 0.119 against a 0.10 gate. It is not mysterious:
DB carries the return-game residual (C9), which is unmodelled until return yards
and return TDs land, and 2018 is the oldest season in range. Every other cohort,
including all of 2019–2025, clears.

### Task 0.1 result — weekly routes, gate PASSED (2026-08-04)

`validate_routes_weekly.py`, all 10 seasons, 30/30 checks:

| check | result |
|---|---|
| **Rollup identity** — per **player**, Σ weekly == season, on all four sum columns | **0 mismatches**, every season 2016–2025 (497–564 players each) |
| **Grain sanity** — a weekly row must not carry season-scale routes | max weekly routes **59–69** (vs 633–718 season-scale) — game-plausible |
| **Week coverage** | exactly 1–17 through 2020, 1–18 from 2021 |

55,086 player-week rows replace 5,247 player-season rows. The season table is
now **derived** from weekly by summation, so the two grains cannot drift; the
rollup is checked per player rather than in aggregate, because offsetting
per-player errors cancel in a league total.

Both existing consumers of the season table — `/api/player-routes`
(`worker/src/index.js:14512`) and `build_draft_intel.py:341` — read the same
columns with unchanged semantics and see identical values.

**FDPRR now computes as-of-week**, which was structurally impossible before.
Verified on 2018 weeks 1–8 only (`nfl_player_routes_weekly` ⋈
`nfl_player_weekly_ext`, ≥150 routes):

| player | routes | tgt | rec FD | TPRR | YPRR | **FDPRR** |
|---|---|---|---|---|---|---|
| Julio Jones | 260 | 81 | 38 | 0.312 | 3.12 | **0.146** |
| Michael Thomas | 247 | 64 | 35 | 0.259 | 2.71 | **0.142** |
| Calvin Ridley | 152 | 33 | 21 | 0.217 | 2.58 | **0.138** |
| Adam Thielen | 369 | 96 | 49 | 0.260 | 2.51 | **0.133** |

**Phase 0 exit criterion:** the §1.3 reconstruction table shows gap < 0.10 and
MAE < 0.30 for **every** position group, matching what PK already achieves.
Until that holds, Model C cannot be trusted, because its scoring engine cannot
reproduce the target it is being trained against.

## Phases 1–8

| phase | content | depends on |
|---|---|---|
| 1 | As-of feature store + `model_team_context_weekly` | Phase 0 |
| 2 | Baselines (STD PPG, L3, L4 opportunity, prior season, replacement level, existing rule-based score) | Phase 1 |
| 3 | **WR/TE pilot** — routes, TPRR, YPRR, FDPRR; Models A/B/C; GBM challenger; CQR | Phase 2 |
| 4 | RB + QB opportunity models | Phase 3 |
| 5 | IDP (DL/LB/DB) | Phase 3 + 0.4 |
| 6 | PK + PN | Phase 3 |
| 7 | Role events + injury model + teammate redistribution | Phase 4–6 |
| 8 | Yearly horizons (preseason / ROS / season-finish), backtest 2022–2025, calibration, D1 writes, Worker endpoints, reports | all |

External benchmarking runs **in parallel from day one as archive-only**, and its
evaluation phase is deferred to 2027 when a season of honest snapshots exists.

## Acceptance gates

The system does not go to production until:

- P50 coverage ≈ 50% and P90 coverage ≈ 90%, **by position** and by
  projected-score bucket — with the spec's anti-gaming check: a P90 that achieves
  coverage by being uninformative (huge P50→P90 gap) is rejected. Report mean
  gap alongside coverage.
- `P90 >= P75 >= P50` holds for 100% of rows.
- The model beats **all** §12 baselines out of sample on pinball loss.
- Elite-week probabilities are calibrated (Brier, log-loss, calibration curves);
  accuracy is explicitly not the primary metric.
- Lead-time measurement is reported honestly: flagged 1 week before / 2–4 weeks
  before / only after / never / false positive.
- Macro reconciliation passes — player targets sum to team targets, route shares
  cannot exceed team routes, goal-line shares cannot collectively exceed team
  goal-line opportunity.
- Unexplained material variances raise `UNEXPLAINED VARIANCE — MODEL REVIEW
  REQUIRED` rather than being silently smoothed.

---

## Appendix D — Phase 0.6 + Phase 1: the as-of feature store (2026-08-04)

### The guard — `pipelines/etl/lib/asof.py`

Leakage is prevented **by construction**, not by review. Every read goes through
`AsOfContext`, which applies the as-of predicate for you and **refuses** an
undeclared table. Three grains:

| grain | predicate | rationale |
|---|---|---|
| `WEEK` | `season < S OR (season = S AND week < W)` | strictly before the target game |
| `WEEK_PREGAME` | `season < S OR (season = S AND week <= W)` | betting lines, weather, inactives — **published before kickoff**, so week = W is the whole point |
| `SEASON` | `season <= S + max_season_offset` (−1) | completed-season aggregates: **prior seasons only** |

Refusals: `UndeclaredSource` (unknown table), `BannedColumn`
(`nfl_team_vegas_weekly.actual_score` — the outcome of the game being
predicted), and a `LeakageError` if a `JOIN` brings in a table that was not
declared in `join_tables`, since an unchecked JOIN would otherwise be a trivial
way to smuggle a season-grain source past the gate.

`WEEK_PREGAME` exists because the test caught me hand-writing raw SQL for the
Vegas line. Those lines genuinely *are* pregame — but the exception now has a
name, a predicate and a review surface, instead of being an undocumented
special case in one builder.

### The test — `test_asof_leakage.py`

Three independent checks, green on 2024 W3 / W6 / W10 / W17:

| check | what it catches |
|---|---|
| **A. structural** | Captures every SQL the builder issues; asserts each carries the as-of predicate for its grain, references no future week literal, and touches no undeclared table. Catches a query that bypasses the guard entirely — which it did, on first run. |
| **B. independent recompute** | Recomputes features straight from source with explicit `week BETWEEN lo AND hi` bounds via a code path sharing nothing with the builder, and requires exact equality. 25 players/week, 0 mismatches. |
| **C. future-only players** | Any player debuting at/after W must carry no history. **Currently vacuous** and reported as such — the builder's universe comes from sources already filtered to weeks < W, so such players have no row to fire on. Zero findings over zero subjects is the shape of a fail-open, so the test says "VACUOUS", never "passed". |

> **What check C taught me.** Its first version defined "first appearance" using
> only `nfl_player_weekly` and flagged 8 players as leaks. They weren't. Player
> `00-0036165` carried `routes_l1=11` at W6 because he genuinely ran 11 routes
> in W5 and recorded **zero** box-score stats, so nflverse's `player_stats` had
> no row for him that week. **The participation universe is strictly broader
> than the box-score universe** — a fact that matters well beyond this test, and
> is now encoded in the check (first appearance is computed across all
> week-grain sources).

### Two schema facts the audit had wrong

- **`nfl_player_snaps` is keyed by `pfr_id`, not `gsis_id`.** Migration 0006's
  comment claims `gsis_id`, and §1.5 of this document inherited that error.
  Joins must go through `ff_player_ids.pfr_id`, guarding *both* ids against the
  literal string `"NA"`.
- `wrangler --json` output cannot be parsed with `stdout.find("[")` — the
  coloured banner contains ANSI escapes, which literally include `[`. The scan
  lands mid-escape and `json.loads` reports "Extra data". `lib/asof.py` walks
  every `[` and takes the first that `raw_decode`s into the expected shape.

### The store — `model_player_week_features` (migration `0120`)

One row per `(season, week, gsis_id)`, ~60 columns: identity (MFL position, not
nflverse), availability, opportunity (routes / route% / targets / target share /
snaps / carries / red zone / goal line) at L1/L3/L4/STD windows, efficiency
(TPRR / YPRR / **FDPRR** / catch rate / YPT / YPC), lagged realized UPS points,
pregame Vegas, and **role-change deltas** (`d_route_pct_l3`, `d_tgt_share_l3`,
`d_routes_l3`, `d_snap_pct_l3`) — recent window minus the window before it,
which is the pre-breakout signal promoted to a first-class column rather than
left for the model to re-derive.

Two deliberate choices:

- **Rates are stored RAW, unshrunk.** Empirical-Bayes shrinkage belongs in the
  model layer where the prior can be refit per training fold; baking it into the
  feature store would leak each fold's own distribution into its inputs.
  `routes_std` is carried so the model can apply the §3.1 sample bands.
- **A zero denominator yields NULL, never 0.** "Ran no routes" is not "a TPRR of
  zero", and collapsing the two would hand the model a fabricated efficiency for
  every player who did not play. Likewise a delta is NULL unless *both* windows
  exist — a missing prior window is not a zero-change signal.

---

## Appendix E — Baselines: the bar to beat (2026-08-04)

`evaluate_baselines.py`, season 2024, weeks 5–17, next-week UPS points. Every
baseline is as-of clean (predictions for week W use only weeks < W) and computed
**directly from `src_weekly`, not from the feature store** — a baseline that
depends on the model's own pipeline is not an independent bar, because a bug
would move both together and flatter the model.

| pos | best baseline | n | **MAE** | pinball@0.5 | bias |
|---|---|---|---|---|---|
| QB | season-to-date PPG | 441 | **8.376** | 4.188 | +1.86 |
| RB | season-to-date PPG | 1,104 | **4.483** | 2.242 | −0.09 |
| WR | season-to-date PPG | 1,646 | **4.801** | 2.400 | +0.42 |
| TE | season-to-date PPG | 976 | **3.210** | 1.605 | +0.67 |
| PK | **replacement level** | 327 | **4.077** | 2.039 | +0.08 |
| PN | **replacement level** | 325 | **4.050** | 2.025 | +0.10 |
| DL | season-to-date PPG | 2,623 | **3.002** | 1.501 | +0.04 |
| LB | season-to-date PPG | 1,505 | **2.242** | 1.121 | +0.10 |
| DB | season-to-date PPG | 2,688 | **2.762** | 1.381 | +0.13 |

Two results that should shape the modelling effort:

**1. Season-to-date mean beats every recency window, at every position except
kicker and punter.** `l3_ppg` and `l4_ppg` lose to `std_ppg` everywhere, and
`last` (the most recent single game) is the *worst* baseline at every position —
WR 6.387 vs 4.801. Recency is noise at this granularity. Any model that leans on
short windows has to earn it against a longer mean, and the spec's emphasis on
L3/L4 opportunity windows is better justified for the **opportunity** side
(role changes) than for direct point prediction.

**2. For PK and PN, the position average beats the player's own history.**
Replacement level wins outright — an individual kicker's prior scoring carries
*no* usable signal beyond "he is a kicker." This is worth knowing before
investing in PK/PN player-level models: the honest bar is the position mean, and
it is hard to beat. It also supports the spec's instinct (§2.4) that punters
need internal benchmarking rather than an external projection source.

Bias columns are near zero for the winning baseline at most positions, so the
opportunity is in **precision, not calibration of the mean** — except QB
(+1.86), where season-to-date systematically over-predicts, likely a
survivorship effect from benched starters.

---

## Appendix F — WR/TE pilot: first out-of-sample result (2026-08-04)

`train_wr_te_pilot.py` — Model D (direct GBM quantile regression, the
*challenger*). Strict walk-forward: train 2024, test 2025, never shuffled.

| | MAE | pinball@.5 | P50 cov | P90 cov |
|---|---|---|---|---|
| baseline `std_ppg` | 4.543 | 2.271 | 58.6% | — |
| **pilot GBM** | **4.465** | **2.232** | **51.8%** | 83.6% |

**Beats the baseline by 1.7%. That is marginal, and should not be oversold.**
On point accuracy alone this would not justify building the component
simulation.

### Where the value actually is

**Calibration.** The baseline's P50 coverage is **58.6%** — season-to-date mean
sits systematically *above* the median outcome, so it is not a median at all.
The pilot lands 51.8% against a 50% target. For a system whose deliverable is a
distribution (P50/P75/P90, top-12 probability), a calibrated median matters more
than 1.7% MAE — and the baseline cannot produce a distribution at any price.

**P90 is under-covered** at 83.6% against a 90% target (P75 70.9% vs 75%).
Reported rather than tuned away; this is exactly what conformalized quantile
regression (§3.4) exists to fix. Mean P50 6.19, P90 12.90, gap 6.71 — recorded
alongside coverage because a P90 that reaches 90% by being enormous is
uninformative and the spec rejects it.

159 quantile crossings were repaired by per-row sorting (a projection onto the
monotone cone, which cannot worsen pinball loss).

### A hypothesis that was tested and REJECTED

TE reception scoring changed in 2025 (`CC` 1.0 → **1.5** premium) while WR did
not, so a 2024-train/2025-test split has a *shifted target* for TE. That looked
like a plausible explanation for the small gain. It is not:

| cohort | train n | baseline MAE | pilot MAE | gain |
|---|---|---|---|---|
| WR + TE | 2,557 | 4.543 | 4.465 | 1.7% |
| **WR only** (stable scoring) | 1,611 | 4.818 | 4.742 | **1.6%** |

Removing the era confound changes nothing. **The marginal gain is real, not an
artifact.** Worth recording as a negative result so it is not re-litigated.

### It was data starvation — confirmed

Backfilling 2021–2023 and re-running the same walk-forward (test 2025 throughout,
so the numbers are directly comparable):

| train seasons | rows | MAE | **gain vs baseline** | P50 cov | P90 cov | crossings |
|---|---|---|---|---|---|---|
| 2024 | 2,557 | 4.465 | 1.7% | 51.8% | 83.6% | 159 |
| 2021 + 2024 | 5,074 | 4.401 | 3.1% | 51.0% | 85.0% | — |
| **2021–2024** | **10,154** | **4.365** | **3.9%** | **49.2%** | **87.7%** | **2** |

Every metric improves monotonically with data, and none has plateaued:

- **Gain more than doubles**, 1.7% → 3.9%.
- **P50 coverage reaches 49.2%** against a 50% target — essentially exact
  calibration, versus the baseline's 58.6%.
- **P90 coverage climbs to 87.7%**, closing on 90% without the interval being
  inflated to get there (mean P50→P90 gap 8.13).
- **Quantile crossings collapse from 159 to 2.** The three quantile fits are now
  internally consistent almost everywhere, which is a direct readout of estimator
  stability rather than a metric that was targeted.

**The first result was a data-starvation artifact, not a ceiling.**
`nfl_player_routes_weekly` reaches back to **2016**, so five further seasons
(2016–2020) remain available at the cost of a backfill. The trend says they are
worth taking before any conclusion about this feature set — and certainly before
concluding anything about the champion simulation, which has not been built.

The remaining P90 shortfall (87.7% vs 90%) is what conformalized quantile
regression (§3.4) is for: a finite-sample coverage guarantee layered over
whichever model wins, rather than tuning the point estimator until the number
looks right.

⚠️ **Still a single walk-forward fold** (one test season). Directionally strong,
not conclusive — the spec's full 2022→2025 rolling backtest is still owed.

### Champion vs challenger — the spec's assumption did not hold

Both models, identical fold (train 2021–2024, test 2025, WR+TE):

| model | MAE | pinball@.5 | P50 cov | P75 cov | P90 cov |
|---|---|---|---|---|---|
| baseline `std_ppg` | 4.543 | 2.271 | 58.6% | — | — |
| **GBM challenger** | **4.365** | **2.183** | 49.2% | 72.0% | 87.7% |
| component simulation | 4.505 | 2.253 | 50.7% | 73.3% | 87.5% |

**The direct GBM beats the component simulation on accuracy, and calibration is
a wash.** This contradicts §3.2's working assumption that the simulation would
be the champion. Recorded as-is: the spec's own rule is that the decision rests
on out-of-sample UPS results, not on which architecture sounded better going in.

**What the simulation still uniquely provides** — a native explanation (expected
routes, expected targets, per-rate shrinkage and exact scoring are separately
inspectable), exact era-correct UPS scoring on every draw, and touchdowns as
Bernoulli draws so they move P90 far more than P50.

**Why it is probably handicapped rather than beaten:**

1. **It only simulates receiving.** No rushing, return game, or special-teams
   tackles — all of which §1.3 proved are real for WR/TE.
2. **Model A is the bottleneck**: expected routes carries an out-of-sample MAE
   of **6.50 routes** against a typical volume of 25–30. Everything downstream
   inherits that noise.
3. TPRR is read unshrunk from the feature store rather than modelled.

Diagnostics are healthy, so the comparison is trustworthy as far as it goes:
Model B matched real history for **2,498/2,563** player-weeks (97.5%), and the
script warns loudly below 80% — a silent fallback to league priors would make
Model B decorative while still producing plausible output. The fitted shrinkage
constants reproduce the spec's required ordering **unprompted**: TD rate slowest
(k=15), then yards/reception (12), catch rate (11), first-down rate (8).

---

## Appendix C — Defect backlog from the ETL alias sweep (2026-08-04)

Investigating B4 triggered a full sweep of all 47 `PLAYERSTATS_MAP` entries in
`fetch_nflverse_weekly.py` against the live nflverse schema for 2019/2023/2025
(identical 145-column schema in all three, so every binding defect is
season-invariant). The findings below are **not yet fixed**; B3/B4 are.

### The pattern bit me too — `pt_return_tds` (2026-08-04)

Worth recording, because it is the same failure mode as B4 and it happened
*while fixing B4*.

Migration `0117` mapped `punt_return_tds` from nflverse `pt_return_tds`. That is
wrong. The `pt_*` block is the **punter's** stat line — `pt_att`, `pt_yards`,
`pt_net_yards`, `pt_returned`, `pt_return_tds` — so that column counts TDs the
punter **allowed**. It appears on position `P` rows and nowhere else. Since UPS
`PR` pays 6–7 points, the binding would have *rewarded punters for surrendering
return touchdowns*.

What made it plausible: `punt_returns` (861) and `pt_returned` (861) have
**identical league totals**, because every returned punt is counted once from
each side. Two columns agreeing to the unit looks like confirmation and is not —
the returner-side columns (`punt_returns`, `punt_return_yards`) were correctly
mapped; only the TD column crossed sides.

Caught before it affected any published figure — skill and IDP rows carry NULL
there, so it contributed 0 to every reconstruction reported here — but the
stored values were wrong. `0119` clears them and `backfill_td_distance.py` now
owns the column, credited to the **returner** from PBP.

**The generalisable lesson:** matching league totals is not evidence that two
columns mean the same thing. Check *which population* carries the value — a
one-line `GROUP BY position` would have caught this instantly, and is now the
first check for any new column binding.

### The systemic pattern

`pick()` returns the **first alias present** in the dataframe. When nflverse adds
or renames a column, the map can silently bind to a *wrong-but-present* column
and produce plausible-looking garbage. This has now happened at least three
times (`def_fr`, `receiving_air_yards`, and `def_tackles_ast`). A silent
WRONG-VALUE is strictly worse than a silent NULL, because it looks like data.

**Recommended structural fix, in keeping with the repo's no-fail-open rule:**
assert exactly one alias matches, and fail loudly when two or more are present
simultaneously — that condition *is* the signal that they are not synonyms.
(Both `def_tackles_with_assist` and `def_tackle_assists` were in the same
payload.) Note also that `str(row[c]) != ""` is `True` for float `NaN`, so
`pick()` can return `NaN` from `alias[0]` and never fall through — latent today,
but it defeats the entire fallback mechanism on the next upstream rename.

### P1 — correctness, should land before the feature store

| # | Defect | Impact |
|---|---|---|
| C1 | ⚠️ **NOT FIXABLE AT THIS LAYER — handled by rule.** `pos_group` is nflverse's positional view and genuinely disagrees with MFL's: 830 of 8,276 2025 IDP weeks are MFL `DE` vs nflverse `LB` (Brian Burns, Byron Young, Jonathon Cooper, Micah Parsons…). | UPS pays DL tackles 1.5 and LB 1.0. Injecting MFL classification into a generic NFL-stats table is a layering violation, so instead: **all UPS scoring MUST key off `src_weekly.pos_group` (MFL), never `nfl_player_weekly.pos_group`** — now stated at both code sites and in migration `0116`. Verified no current consumer computes UPS rates from it; the Worker uses it for filtering only. |
| C2 | ✅ **FIXED 2026-08-04** (migration `0116`, 59,814 rows). `pos_group_of()` now maps `SAF`→`DB`, `P`→`PN`, and terminates in `OTHER`. | `DB` 2,716 → **4,261** (safeties were 36% of all DBs and invisible to the Worker's own `idp` filter). `PK` 1,125 → **PK 569 / PN 556** (UPS scores punters on `PI *4`, nothing like kickers). 977 O-line rows collapsed to `OTHER`. Worker punter filter widened to `['PN','PK']` so it works before, during and after. 308 NULL `pos_group` rows deliberately left NULL — unknown ≠ other. |
| C3 | **`pass_sack_yds` stores negative values while `def_sack_yds` stores positive.** | UPS `TSY 0-100 *-.1`: a literal consumer awards a QB **+33.4 instead of −33.4**; a range-checking consumer scores 0 because a negative falls outside `0-100`. |
| C4 | **Punter columns are not "intentionally empty" — that premise is stale.** nflverse now ships `pt_att`, `pt_yards`, `pt_net_yards`, `pt_inside_20`, `pt_blocked`, `pt_returned` etc. The diagnostic at line ~226 searches for the substring `"punt"`, which does **not** match `pt_att`, so it prints "WARNING: no punt columns" on every run and permanently re-confirms the wrong conclusion. | A self-validating blind spot. UPS pays `PI *4` and `HBP *-2`; D1 currently gets punts on only ~550 rows/season via a fragile PBP path. |
| C5 | **Postseason rows are ingested unfiltered with no `season_type` column to filter them** — 447/833/890 rows at `week>=19` for 2019/2023/2025. | `nfl_player_weekly` cannot distinguish REG from POST, so any `(season, week)` join silently trains on playoff games `src_weekly` never scored. |
| C6 | `sack_fumbles` / `sack_fumbles_lost` unmapped — QB sack fumbles (154–196/season) invisible to UPS `FL *-2`. | Blocks exact offensive reconstruction. |
| C7 | ✅ **FIXED 2026-08-04.** `/api/mfl-detailed` was 502ing because the upstream fetch sent no `Referer` and MFL now 403s `detailed?` without one. | Isolated by experiment: same URL, same worker UA → **403 without `Referer`, 200 with**. The UA is not the gate. Verified end-to-end by running the *shipped* parser against the live response — Derwin James 2025 W3 parsed to 5 lines summing to 24.1 == subtotal 24.1 (which independently re-confirms the DB rates `TK 1.3 / AS 0.8 / TKL 1.5` used in the IDP gate). |
| C8 | ✅ **FIXED 2026-08-04.** `detailed?` is keyless for the **current season only** — the route's own comment claimed "works for ANY historical week". | Verified: 2025 → 200 with Subtotal; 2024/2023 → **HTTP 200** whose body is `Missing User ID`. Because that arrives as a *200*, the route previously returned an empty `lines:[]` that read as "this player scored nothing". Now detected explicitly and returned as a 403 **with no `lines` key**, since both clients validate on `Array.isArray(d.lines)` — so they render the error state, not the empty state. Historical validation must go through `src_weekly` points. |

### P2 — data completeness for the scoring engine

| # | Defect |
|---|---|
| C9 | ✅ **FIXED 2026-08-04** (migration `0117`). Return game was entirely unmapped — `KY *.025`, `UY *.05`, `KO`/`PR` return TDs had no data source at all, so a pure return specialist scored from nothing as far as D1 was concerned (Charlie Jones 12.1 UPS pts, 2025 wk9, zero offensive stats). Six columns added to `nfl_player_weekly_ext`, stored verbatim. ⚠️ `special_teams_tds` is a **mixed bucket**, not "return TDs" — 2025 is WR 16 / RB 4 / CB 3 / DE 3 / DT 1 / SAF 1, and the defensive entries are blocked-kick and muffed-punt recoveries that UPS scores under `BLF`/`BLP`/`FR`. Captured for reconciliation only. nflverse has **no** `kickoff_return_tds` column, so kickoff-return TDs (and all return-TD distances) remain C10. |
| C10 | ✅ **FIXED 2026-08-04** (migration `0119`, `backfill_td_distance.py`). UPS pays 7 not 6 for TDs of 50+ yards on every code, and the box-score feed has only TD counts. **The distance field is not uniform** — offensive TDs use `pbp.yards_gained`, but return TDs must use `pbp.return_yards`, because `yards_gained` is **0** on kickoff-return plays. An initial `yards_gained >= 50` check therefore reported *zero* 50+ return TDs, which is obviously wrong for a play type that is ~100 yards by construction. 2025: 38 pass / 25 rush / 38 rec 50+ TDs, plus 6 kickoff and 15 punt return TDs (all 6 kickoff returns 50+, at 90/95/97/98/99/100 yds). Also resolves the **missing kickoff-return TDs** — nflverse has no such column, so these were previously scored as zero. This is what Charlie Jones's 12.1 points on zero offensive stats (§1.3) actually was: a 98-yard kickoff return TD. |
| C12 | ✅ **FIXED 2026-08-04** (migration `0119`). `pass_2pt` was mapped; `rushing_2pt_conversions` (17/season) and `receiving_2pt_conversions` (43/season) never were. `R2`/`C2` pay ×2, and 51 of 2025's skill player-weeks carried a +2.0 residual. Native nflverse columns — no PBP needed. |
| C11 | Native kicking columns now exist (`fg_made_distance`, `fg_missed_distance`, per-band made/missed, `fg_blocked`, `pat_missed`) — the PBP-bucket workaround is obsolete. |
| C12 | `def_safeties` (`SF *2`), rushing/receiving 2-pt conversions (`R2`/`C2 *2`), `receiving_yards_after_catch` all unmapped. |
| C13 | **Blocked kicks are unrecoverable from the box score** — `fg_blocked`/`pat_blocked` sit on the *kicker's* row. The blocker is named in the PBP description in 47/47 2025 cases. This is the entire final residual after the B4 fix (~0.01 pts/wk). Optional. |
| C14 | `rush_long` / `rec_long` / `pass_long` are dead map entries that resolve in no season and **write NULL on every run**, guaranteeing any future PBP backfill is silently wiped. Delete them from the map. |
| C15 | `SNAP_MAP` has `"pfr_id": ["pfr_player_id", "player_id"]` — a fallback that would land gsis ids in a column the Worker joins on `crosswalk.pfr_id`. Silent, error-free join corruption on the next rename. Remove the fallback. |
| C16 | **The UPSERT never deletes** — D1 holds 19,707 rows for 2025 vs 19,421 in today's nflverse payload (~300 orphans from earlier revisions), plus 308 rows with NULL `pos_group`. |
| C17 | `nflverse` has **no TFL data for 2011** (`def_tackles_for_loss` all-zero). Store NULL, not 0, so downstream can distinguish "no data" from "zero TFLs" — and exclude 2011 from TFL-dependent features. |
| C18 | `player_id_crosswalk` gaps null out otherwise-recoverable player-weeks (4 active 2025 IDP players, 45–58 weeks). `confidence='exact'` is stamped even on NULL-`gsis_id` rows, so confidence cannot screen them. Add an assertion: any player with nonzero `src_weekly` season points must have a non-NULL `gsis_id`. |
| C19 | **Merging on a nullable `gsis_id` silently fabricates rows** — pandas `NaN` matches `NaN`. An unfiltered join produced 45 fabricated rows mid-investigation and nearly doubled a measured residual before it was caught. Every script must filter null join keys and assert post-join rowcount ≤ pre-join rowcount. |
| C20 | **`src_weekly.pos_group` labels drift between seasons** — 2023 uses `CB+S`/`DT+DE`, 2024+ uses `DB`/`DL`. `WHERE pos_group IN ('DL','LB','DB')` silently returns LB-only rows for 2023. This exact failure produced a plausible but 60%-incomplete result set during the investigation. |

### Open questions requiring a rules check, not a code change

- Whether UPS `FC` credits **own**-fumble recoveries (opp-only was exact for every
  defender sampled, but no own-recovery week appeared).
- `PI`, `UY`, `HBP`, `DR`, `MF` event codes are inferred from magnitude and
  context, not documentation. Arithmetically validated and solid: `TK`, `AS`,
  `TKL`, `SK`, `QH`, `PD`, `IC`, `FC`, `FF`, `FD`, `CC`, `CY`, `RY`, `PY`,
  `PS`/`RS`/`RC`, `IN`, `FL`, `TSY`, `P2`/`R2`/`C2`.

### Known-unresolved from the B4 work

- **Pre-2018 DL and DB rate handling is untested.** `src_weekly` carries only
  `pos_group='LB'` before 2024 (UPS ran a single IDP slot), so 2011–2023 fits are
  LB-only. DL/DB multipliers for those seasons are assumed, not validated.
- A persistent small **negative** residual survives the fix in every season
  (−0.08 to −0.37 pts/player-week on the clean-week method). Mostly return
  yardage, distance-scaled TDs, blocked kicks and MFL's 1-decimal rounding — but
  not fully decomposed. **Do not set the acceptance gate at 100%.**
- Pre-2021 nflfastR tackle parsing is known to be weaker, and one diagnostic
  stream disagreed with two others on 2019 quality. Re-validate per season before
  any pre-2021 IDP feature ships.

---

## Appendix A — Reproducing the audit

All queries run read-only against remote D1 on 2026-08-04:

```bash
cd worker && npx wrangler d1 execute ups-mfl-db --remote --json --command "<SQL>"
```

Key queries: route grain (§1.1), `routes_run` nullity (§1.1), scoring
reconstruction by position (§1.3), reception-slope decomposition (§1.3),
pure-tackle-week isolation (§1.4), assist collapse (§1.4), snapshot inventory
(§2.1).

⚠️ Never run `wrangler d1 migrations apply` against this database — the migration
tracker is ~47 entries behind and applying will corrupt contract data. New model
tables must be created with `d1 execute --file`.

## Appendix B — UPS scoring quick reference (2025)

Reception `CC`: **TE 1.5 · WR 1.0 · RB 0.8**. First down `FD` **0.2 all
positions**. Pass yd 0.04 (+1/2/3 at 300/375/425). Rush & rec yd 0.1 (+ tiers).
TD 6, **7 if ≥50 yards**. Tackle `TK`: **DT/DE 1.5 · CB/S 1.3 · LB 1.0**.
Assist `AS`: CB/S 0.8 · others 0.5. TFL 1.5 (DL/DB) / 1.0 (LB). Sack 3 ·
QB hit 0.5 · PD 1.5 · INT 4 · FR 4 · FF 2. FG 0.1/yd, missed FG 0–44 −0.1/yd.
**Punt inside 20: 4.0 each.** Net punt avg 45/50/60 → 1/3/5.
