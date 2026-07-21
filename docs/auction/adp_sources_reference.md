# ADP / Dynasty-Value Source Reference

**Why this doc exists:** on 2026-07-13, our site's multi-source ADP consensus showed
Parker Washington as WR91 when he was legitimately a top-40 redraft player. Two
successive fixes (#683, #684) were needed before the number was right, because the
*first* diagnosis (missing data) was wrong — the *real* bug was that we were averaging
raw dollar values across sources whose scales aren't comparable. This doc is the
permanent record of what every source actually measures, so a future change never
repeats that mistake. Read this before touching `fetch_adp_board()`
(`pipelines/etl/scripts/trade_grader.py`) or any of its 3 JS mirrors
(`site/stats_workbench/stats_workbench.html`, `site/m/views/stats.js`,
`site/auction/auction_hub.js`).

---

## 1. The core distinction: dynasty vs. redraft, and the trap inside it

- **Redraft** = value for THIS season only, no forward-looking keeper/dynasty premium.
- **Dynasty** = long-term keeper value across multiple future seasons — age, contract
  situation (in our league specifically), and long-term role all matter more than a
  1-year outlook.

**The trap we fell into:** some dynasty-value calculators expose a "redraft value"
field that is NOT a standalone redraft board — it's "what this player's redraft
worth looks like, computed FROM WITHIN a dynasty valuation model." That's a
meaningfully different, more conservative number for short-term-only assets (aging
vets, rental-type players with no long-term outlook) than a genuine 1-year-league
consensus. **This is a documented, intentional industry pattern, not an accident** —
FantasyCalc's own API exposes a field, `redraftDynastyValueDifference`, that exists
specifically to quantify this gap. Any pipeline blending "dynasty site A's redraft
field" with "genuinely standalone redraft site B" is implicitly mixing two different
philosophies unless it accounts for this.

---

## 2. Source-by-source reference

### FantasyCalc — `api.fantasycalc.com/values/current`
- **Access:** free, keyless REST API. Params: `isDynasty` (bool) × `numQbs` (1 or 2) ×
  `numTeams` × `ppr`.
- **Type:** VALUE (dollar-like number, roughly 0–~10,000 at the top of the board).
- **Coverage:** both dynasty and redraft, but see the trap above — the `redraftValue`
  field returned under `isDynasty=true` is the dynasty-context-derived number, not
  identical to the standalone `isDynasty=false` board (confirmed empirically: they
  match for MOST players but diverge for short-term-relevant ones).
- **QB format matters independently of dynasty/redraft:** `numQbs=1` vs `numQbs=2`
  (Superflex) shifts QB values substantially — always match our league's SF format.
- **We use:** `isDynasty=true&numQbs=2` (SF) for both `dsf` (dynasty) and `rsf`
  (dynasty-context redraft). This is the most complete single source we have — it's
  the reference scale our rank-consensus maps everything else onto.

### KeepTradeCut — `keeptradecut.com/dynasty-rankings`, `/fantasy-rankings`
- **Access:** scrape only — no public API or CSV export exists. Their ToS has a
  broad scraping-prohibition clause ("web scraping, data mining, bots/crawlers,
  systematic or automated data collection"). **Decision (Keith, 2026-07-13): keep
  scraping.** That clause is aimed at commercial competitors building a rival
  product off their data, not a private, non-monetized, single-league tool making
  one cached request per ~12h TTL with no redistribution or resale of their data.
  Revisit only if usage pattern or intent changes (e.g. scraping frequency
  increases materially, or the data ever gets exposed/repackaged beyond this
  league's own tools).
- **Type:** VALUE. Methodology is genuinely different from FantasyCalc's — KTC is
  crowdsourced ELO from pairwise Keep/Trade/Cut votes, not a trade-transaction
  optimization model. That independence is valuable (see §4), which is exactly why
  removing it isn't a free decision either.
- **The scale-mismatch bug:** KTC's redraft (`rsf`) field, where present, is **not on
  a comparable dollar scale to FantasyCalc's**. Confirmed: a KTC `rsf` of ~4,700–4,800
  corresponded to only KTC's *own* ~104th–110th-best redraft player, while
  FantasyCalc's redraft dollar scale decays much faster for mid-tier players. KTC's
  `rsf` is ALSO frequently absent entirely for mid/deep-tier players. **Never average
  KTC's raw `rsf`/`dsf` value against another source's raw value — rank first.**
- **Dynasty (`dsf`) values ARE reasonably cross-comparable with FantasyCalc's at the
  top of the board** (both ~9,700–9,985 for a true WR1) — the scale mismatch is
  specifically a redraft-axis problem, not (as far as verified) a dynasty one.

### DynastyProcess — `raw.githubusercontent.com/dynastyprocess/data`
- **Access:** free CSV, no auth.
- **Type:** VALUE (dynasty only — no redraft field at all in what we ingest).
- **⚠️ Not an independent source.** It's a deterministic transform of FantasyPros'
  Dynasty ECR: `Value = 10,500 × e^(ECR × −0.0235)`. The `value_2qb` column is a LOESS
  regression off the 1QB ECR, not a separately-computed SF value. **Treat this as "a
  reformatted view of FantasyPros' dynasty consensus," not a 3rd independent vote** —
  our current blend implicitly treats fc/ktc/dp as 3 equal independent dynasty
  opinions, but it's closer to 2 (FantasyCalc's trade-model + KTC's ELO-vote model),
  with DP riding along as a FantasyPros proxy.

### FantasyFootballCalculator — `fantasyfootballcalculator.com/api/v1/adp/ppr`
- **Access:** free, keyless REST API (personal AND commercial use permitted).
- **Type:** ADP — a pick-NUMBER (average draft position), not a dollar value.
  Pick-number sources are inherently more cross-source-comparable than value sources
  (they're already on the same "1 to ~200" scale everywhere) — no rank-conversion
  needed before averaging with other pick-number sources.
- **Methodology:** rolling window of RECENT live mock drafts (313 mocks over a
  7-day window observed 2026-07-13), explicitly filters out bot/autopick selections.
  This recency is a real strength — it reflects current news/role changes fast.
- **Coverage:** redraft only, no dynasty equivalent.

### MFL native AAV — `api.myfantasyleague.com/{year}/export?TYPE=aav` — **BACK, but REFERENCE-ONLY (2026-07-21)**
- **Access:** free, no auth. `PERIOD=ALL` widens the window.
- **Type:** REAL AUCTION DOLLARS — `averageValue` / `maxValue` / `minValue` per
  player, plus `auctionSelPct` (sample size). The only source in the whole stack
  quoting actual money rather than an abstract value index.
- **It came back.** It returned zero players for 2026 earlier in the offseason.
  Re-checked live 2026-07-21: **749 players / 137 auctions** on the default
  period, **800 auctions** on `PERIOD=ALL`. 300 match onto our board. Parsed and
  exposed per row as `mflAav`.
- **⚠️ NOT in the consensus, on purpose.** Look at what those auctions actually
  are. The top six players by average value are all 2026 rookies:

  | | player | avg $ |
  |---|---|---|
  | 1 | Jeremiyah Love (R) | $57.39 |
  | 2 | Carnell Tate (R) | $37.82 |
  | 3 | Fernando Mendoza (R) | $35.35 |
  | 4 | Jordyn Tyson (R) | $34.12 |
  | 5 | Jadarian Price (R) | $31.89 |
  | 6 | Makai Lemon (R) | $30.49 |
  | 7 | Ja'Marr Chase | $26.25 |
  | 10 | Josh Allen | $22.01 |

  In July the auctions MFL tracks are overwhelmingly **dynasty rookie auctions**,
  not redraft ones. So this is a rookie-draft ordering wearing a redraft label, and
  feeding it to the redraft axis would push the incoming class to the top of a
  board meant to answer "who helps most *this season*". Note that ranking rather
  than averaging — the fix for every other scale problem in this doc — does **not**
  rescue it: the contamination is in the ordering itself, not the scale. Declared
  `role: "reference", weight: 0` in `ADP_SOURCES`, with the rank map built and one
  uncomment away in each mirror. Re-evaluate closer to the season, once redraft
  auctions dominate the pool.
- Thin-sample rows (`auctionSelPct < 10`) are dropped worker-side
  (`MIN_AAV_SEL_PCT`) — the Parker-Washington lesson from the entry below.
- `averageValue` also mixes auctions with different budgets, so the dollar figure
  is only meaningful relatively.

### MFL native ADP — `api.myfantasyleague.com/{year}/export?TYPE=adp`
- **Access:** free, no auth, part of the same MFL API we already use extensively.
  Already called elsewhere in this repo (`analyze_auction_tiers.py`,
  `build_rookie_draft_hub.py`, `yoy_signals.py`) — just never wired into the ADP
  consensus. Params include `IS_KEEPER` (0/N filters to pure-redraft-format drafts)
  and `IS_MOCK`.
- **Type:** ADP — pick number (`averagePick`, `rank`), plus `draftSelPct` /
  `draftsSelectedIn` (what fraction of tracked drafts included this player at all —
  a genuine SAMPLE-SIZE / confidence signal most other sources don't expose).
- **⚠️ Can disagree meaningfully with FFC/FantasyData for thin-sample players** —
  confirmed empirically: Parker Washington showed rank 213 overall here (vs. WR39 on
  FantasyData, pick ~72 on FFC) with only 6% `draftSelPct` (91 of 1,405 tracked
  drafts). This is real signal, not necessarily an error — MFL's drafter pool likely
  skews toward dynasty-adjacent power users running nominally-redraft satellite
  leagues, and `PERIOD=ALL` may span a wide, less-recent time window than FFC's
  rolling 7-day window. **Use `draftSelPct` as a confidence weight if this source is
  added** — don't treat a 6%-sample number with the same trust as a 98%-sample one.

### FantasyPros — `fantasypros.com/nfl/adp/*.php`, `/nfl/rankings/dynasty-idp.php`
- **Access:** a real API exists (`fantasypros.com/api-data/`) covering both Redraft
  and Dynasty types, but **production API keys require a paid Premium tier — the free
  tier is sandbox/sample data only.** The public web pages are JS-rendered and
  paywalled past the top 5 rows without a logged-in account.
- **Methodology (ECR):** rank-to-Rank-Points-and-SUM aggregation across 130+ expert
  rankers — explicitly NOT a raw average-of-ranks. This is deliberate: summing
  points avoids the exact distortion we found in KTC's sparse redraft field, where
  forcing an unranked player into an arbitrary low rank (or excluding them) skews a
  naive average.
- **Early-season thinness is real and current:** as of 2026-07-13 the public redraft
  ADP page shows "Consensus of 1 Source: Underdog Fantasy" — too thin to trust this
  early in the offseason cycle regardless of paywall status.
- **Separate dynasty-IDP page exists** (`dynasty-idp.php`) — the only IDP-specific
  dynasty consensus we've found; distinct from the skill-position dynasty and
  redraft-ADP products.

### FantasyData — `fantasydata.com/nfl/adp/{pos}?season=2026`
- **Access:** free, server-rendered HTML (not JS-locked, not paywalled). Reliable
  scrape target. No confirmed public API.
- **Type:** ADP — pick number + explicit position rank (e.g. "WR39").
- **This was the most immediately useful independent cross-check on 2026-07-13** —
  clean, unpaywalled, matched what a real user found by eye on the live site.

### Sleeper — `api.sleeper.app/v1/players/nfl`, `search_rank` field
- **Access:** free, keyless.
- **⚠️ Data-quality issue, not yet resolved:** `search_rank` produces suspicious
  round-number values (many unrelated players sharing an identical `999`) — looks
  like a sentinel/placeholder for "no real rank," not a precise number. **Currently
  excluded from the redraft consensus for this reason** — do not re-add without
  first confirming what `999` (and any other round numbers) actually mean.

### CBS Sports — `cbssports.com/fantasy/football/draft/averages/ppr/both/h2h/all/`
- **Access:** confirmed accessible via server-rendered HTML fetch (verified
  2026-07-13 — page loads, contains real player rows).
- **Type:** ADP — "Avg Pos" pick number, plus Hi/Lo range and Pct-drafted. Not yet
  integrated; a plausible additional pick-number source.
- **Confidence: medium** — this entry rests on lighter verification than the others
  above; confirm the exact HTML structure before wiring it in.

### Other confirmed-accessible redraft ADP sources (not yet evaluated in depth)
Per the open-source `ffanalytics` R package (186 stars, actively maintained,
proves each of these has a working scrape/API function): **RTSports, Yahoo, NFL.com,
ESPN** all have redraft ADP that's programmatically reachable. **FantasyNerds**
(`api.fantasynerds.com`) offers a dedicated ADP endpoint segmented by league size AND
scoring format, including a true superflex/2QB variant, architecturally separate from
its dynasty product — worth a look if we ever want a paid, cleanly-documented API
instead of scraping.

---

## 3. The blending rule (what actually prevents recurrence)

Production fantasy-analytics tools use **two different blending paradigms depending
on data type** — this isn't us improvising, it's the established pattern (confirmed
via `ffanalytics`' actual production code and FantasyPros' documented ECR
methodology):

| Data type | Native scale | Correct blend |
|---|---|---|
| **Pick-number ADP** (FFC, MFL native, CBS avg-pos, FantasyData) | Already comparable (1 to ~200 everywhere) | Simple unweighted mean across sources — no conversion needed. |
| **Dollar/points VALUE** (FantasyCalc, KTC) | Each source's own arbitrary scale | **Rank each source against only its own reporting population FIRST, then average the ranks.** Never average raw values across sources — a scale or coverage mismatch (KTC's sparse/inflated-mid-tier `rsf`) will silently distort the result, exactly as it did on 2026-07-13. |

Our current implementation (`_rank_map` / `_rank_to_fc_value_curve` /
`_value_at_rank` in `trade_grader.py`, mirrored in the 3 JS files) already follows
this rule for the redraft axis: `fc.rsf`, `ktc.rsf` and `ffcAdp` are each ranked
against their own population, averaged, then mapped back onto FantasyCalc's dollar
scale so the result still plugs into the existing 65/35 dynasty/redraft blend.

### 3a. The DYNASTY axis had the same bug (fixed 2026-07-21)

The 2026-07-13 fix was applied to the redraft axis only. The dynasty axis kept
averaging raw `dsf` across `fc` / `ktc` / `dp` — the identical mistake, one field
over. Measured live 2026-07-21, the fraction of each source's own top value still
retained at its own rank 100:

| source | r25 | r50 | **r100** | r200 |
|---|---|---|---|---|
| KeepTradeCut | 64.1% | 53.0% | **35.5%** | 24.6% |
| FantasyCalc | 55.5% | 37.8% | **24.1%** | 12.8% |
| DynastyProcess | 53.6% | 32.0% | **7.7%** | 0.7% |

KTC's tail is ~4.6x flatter than DynastyProcess's, so outside the top tier KTC's
raw number simply outweighed the other two in the sum.

**How we now prove it was actually happening** (this is the part worth keeping —
the obvious test does not work). You cannot diagnose this with "is
rho(consensus, KTC) above some threshold." Every source pair already correlates
0.960–0.979 with every other, so a three-source centroid correlates ~0.99 with
each of them *by construction*. A high rho is normal and means nothing.

The diagnostic that does work is the **ordering** of those correlations. A real
centroid must sit closest to the source that is closest to the others. Compute
each source's mean pairwise agreement with the rest; the source that scores
highest is the `expected_leader`. Then compute rho(consensus, each source); the
highest is the `leader`. **They must match.**

| | rho vs consensus | mean pairwise w/ others | |
|---|---|---|---|
| FantasyCalc | 0.9785 | **0.9742** ← least outlying | |
| DynastyProcess | 0.9796 | 0.9715 | |
| KeepTradeCut | **0.9847** ← leader | 0.9679 ← most outlying | ✗ |

The shipped board's consensus was closest to the source that agreed *least* with
everything else — an inverted centroid. That is the degeneracy, and it is now
measured and returned in the `degeneracy` block of every `/api/adp-board`
response, checked by `adp_regression_check.py`, and written into
`docs/auction/data/adp_board_meta.json` by `fetch_adp_board.py` (which exits
non-zero when inverted).

**The fix — rank-space blend.** Rank each source inside its own reporting
population, convert to a **percentile** `q = (i + 0.5) / n`, average the
percentiles, and map the mean percentile back onto FantasyCalc's cardinal curve.
Percentile rather than raw rank because coverage differs (fc 462, ktc 379, dp 359
today) — averaging raw rank 300 across a 359-row and a 462-row population is the
same class of bug in rank clothing, and the pre-existing `_rank_map` has exactly
that flaw. Only each source's *ordering* is treated as its opinion; its arbitrary
decay curve is not. Verified: the ordering is invariant to which source's curve
serves as the reference (FC-ref and a neutral geometric-mean-ref give identical
rho to 4 d.p.), so the reference choice cannot smuggle in a bias.

After: leader `fc` = expected `fc`, spread 0.0045, not inverted. All three
externally-verified benchmarks (Kittle, Pitts, Parker Washington) stayed in
tolerance through the change.

The worker emits the per-source **normalised** value as `ndsf`, so any subset of
sources the UI toggles on can be plainly averaged and stay correct. The four
mirrors read `ndsf` and therefore cannot reintroduce the raw-average bug.

### 3b. TE-premium (fixed 2026-07-21)

KTC is the only source that publishes a TE-premium board at all. The worker was
parsing it into `ktc.dtep` and then never reading that field — the consensus used
`ktc.dsf`. In a TE 1.5 PPR league every TE was valued off the wrong board.

**Which KTC level.** From KTC's own "How TE Premium Works" modal (read
2026-07-21): `tep` = TE+ = "Start 1 TE. A mild/moderate bonus (+.5PPR/.75PPR, or
~1.5–2x the PPR that WRs receive)"; `tepp` = TE++ = "Start 2 TEs, OR >1PPR boost";
`teppp` = TE+++ = "Start 2 TEs AND additional bonuses." UPS scores TE 1.5 vs WR
1.0 and starts 1 TE ⇒ exactly 1.5x WR ⇒ **`tep`**. The old code had picked `tepp`,
which overshoots this league by roughly 10 points of premium. `KTC_TEP_LEVEL` at
the top of the endpoint is the one place to change it.

**Bridging the other two sources.** FantasyCalc and DynastyProcess have no
TE-premium board, so letting KTC's TE opinion be diluted to 1/3 would undo most of
the fix. Instead the premium is learned as a multiplier curve from KTC's own
paired boards — its `tep` value over its standard value for the same player,
indexed by TE positional rank (live: 1.107 at TE1 rising to 1.160 by TE24; the
premium *grows* down the position) — and applied to the other two sources' TEs
before ranking. Same bridge technique as the 1QB↔SF transforms.

Effect: 63 of 65 TEs gained overall board rank, median **+25 slots**. Bowers
19→16, McBride 25→20, Kittle 127→113.

### 3c. Tiers

Derived per position by 1-D k-means on `log(consensus value)` (equivalently Jenks
natural breaks — 1-D k-means minimises the same within-class deviation), with `k`
the smallest value reaching a goodness-of-variance-fit of 0.99. Not fixed buckets:
a position with a smooth curve gets few tiers, a cliffy one gets many. Log space
because the meaningful question is proportional ("how much cheaper"), and a
500-point gap is a tier break at the bottom of a position and noise at the top.

Cross-checked against KTC's own published `positionalTier`, which we now parse:
QB 9/9 boundaries land within one slot of a KTC boundary, RB 11/12, TE 8/9,
WR 11/16. Reported per position in the `tier_check` block of the response.

**If more pick-number sources are added** (MFL native, CBS), the correct design per
the table above is: average them together directly (they're natively comparable, no
rank-conversion needed) to form one smoothed "consensus pick number," THEN feed that
single number into the existing rank-consensus alongside the value-scale sources'
ranks — don't rank-convert a pick-number source unnecessarily; that's the FFC-only
special case in the current code, worth generalizing when a second pick-number
source is added.

**Weight by sample size where it's available.** MFL native ADP exposes
`draftSelPct`/`draftsSelectedIn` — a genuine confidence signal most sources don't
provide. A thin-sample number (Parker Washington's 6%/91-draft MFL figure) shouldn't
carry equal weight to a well-populated one.

---

## 4. Decided

- **KeepTradeCut scraping vs. its ToS — RESOLVED, keep scraping (Keith,
  2026-07-13).** Non-commercial, single-league, ~one request per 12h cache TTL, no
  redistribution of their data — not the kind of use their scraping clause is
  written to stop. Don't re-flag this unless the usage pattern changes materially.

- **Sleeper carries no valuation weight, and now says so in config.** Its
  `search_rank` measures search traffic, not value, and emits 999 sentinels. It was
  already excluded from both consensus axes; as of 2026-07-21 it is declared
  `role: "popularity", weight: 0` in `ADP_SOURCES` so the exclusion is explicit
  rather than incidental, and it is still displayed as `sleeperRank`.
- **Three independent panels, not five.** `ADP_SOURCES` marks DynastyProcess
  `independent: false` with the reason inline. Every board row now carries
  `nPanels` alongside `nSources`, so the UI can stop implying a 3-source row is
  three independent opinions.

## 5. Open decisions (not mine to make unilaterally)

1. **DynastyProcess's non-independence.** It is flagged in config
   (`independent: false`) and counted as one panel, but it still carries `weight: 1`
   in the dynasty blend — the three panels are equally weighted. Down-weighting it
   is a judgement call about how much a fixed exponential over expert ECR deserves
   next to a crowd-vote and a trade model; change `weight` in `ADP_SOURCES` if you
   want a different answer. Note the blend now *is* sensitive to this: FantasyCalc
   and DynastyProcess agree with each other (rho 0.978) more than either agrees
   with KTC (0.964 / 0.960), so an equal-weight centroid naturally lands nearer
   the FC/DP side. The old raw-value average was accidentally offsetting that with
   KTC's flat tail — two errors partially cancelling, which is not a design.
2. ~~Whether to add MFL native ADP + CBS.~~ **MFL native AAV re-checked 2026-07-21**
   — it is back for 2026 and quotes real auction dollars, but its current pool is
   rookie-auction-dominated, so it is parsed and displayed at weight 0 rather than
   blended (see its entry in §2). Worth revisiting closer to the season. CBS still
   unwired.
3. **Whether FantasyPros Premium is worth purchasing** — it's the single richest,
   most-defensible source (130+ expert consensus, real dynasty+redraft coverage,
   proper Borda-style aggregation) but is a real recurring cost. Given (1) it's a
   real $$ decision, and (2) this whole exercise isn't a commercial operation, the
   free-source stack above is very likely sufficient — only worth revisiting if the
   free sources prove insufficient in practice.

---

## 6. Regression protection

`pipelines/etl/scripts/adp_regression_check.py` re-runs `fetch_adp_board()` and
checks a small set of hand-verified benchmarks (cross-checked against real external
sites, not just internal self-consistency) every time the ADP formula changes. Run it
before merging any change to `fetch_adp_board()` or its JS mirrors.

It also runs the **degeneracy gate** described in §3a — the check that the
consensus is closest to the least-outlying source rather than the most-outlying
one. That gate would have caught the dynasty-axis bug on the day it shipped, which
the benchmark players alone did not (all three stayed in tolerance across the
broken and fixed blends — they are top-of-board TEs and a WR whose sources already
agreed, exactly where the scale mismatch is smallest). **Benchmarks alone are not
sufficient coverage for a blending change; the gate is the real test.**

`UPS_WORKER_BASE=http://localhost:8799` runs both the regression check and
`fetch_adp_board.py` against `wrangler dev`, so a blend change can be verified
before it deploys.

**Two things a fetcher must never do**, both learned here on 2026-07-21:
1. **Silently return nothing.** `fetch_external_adp.py` filtered DynastyProcess
   rookies on `draft_year == "2026"`. That column holds the year a player *was*
   drafted, so the incoming class — which has not been drafted — sits in an `NA`
   bucket and the filter had been matching **zero rows** indefinitely. The
   discriminator is now `draft_year == CURRENT_YEAR or (draft_year is NA and age
   is NA)`, which recovers all 251, and the function prints a loud warning with
   the observed `draft_year` buckets if it ever matches nothing again.
2. **Overwrite history with a failed scrape.** `fetch_fantasypros_adp.py` wrote its
   output unconditionally. FantasyPros' ADP pages are now JS-rendered/paywalled and
   its row regex matches nothing, so a routine re-run replaced 2,000 rows of
   calibration history with a bare header. It now refuses to shrink the file by
   more than 50% without `--force`. **That scrape is still broken** — the guard
   stops the damage, it does not restore the source.
