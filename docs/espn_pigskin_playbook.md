# ESPN Pigskin Classic — league playbook

**League:** 16th Annual Pigskin Classic (2026) · ESPN league `176898` ·
D1 key `ffl.s2026.l.176898` · 12 teams
**Keith's team:** Creelman
**Status:** data connected; QB scoring recovered by fitting (§3), board buildable

> This file exists because the work kept getting rebuilt. The league data has
> been in D1 since August, the waiver analysis has been an artifact since the
> 12th, and the loose SQL export has been sitting in a home-directory folder —
> but nothing was in the repo, so each new session started from zero and one of
> them re-derived a rulebook that was already on file. Everything known about
> this league goes here.

---

## 1. Where things live

| what | where | notes |
|---|---|---|
| League data | D1 `ups-mfl-db`, `fantasy_*` tables | **source of truth**, 2025 + 2026 |
| Provider code | `pipelines/fantasy/providers/espn/` | adapter, parser, auth |
| Keeper valuation | `scripts/espn_keeper_value.py` | reads D1, prices keepers |
| Waiver market 2025 | artifact `35484ddb-39ed-4764-8e41-d1b7e613ae97` | "ESPN FAAB Waiver Market — 2025" |
| Loose SQL export | `~/espn-d1-analysis-20260812-130429/` | 28 files, ~3.6 MB, dated 12 Aug |

⚠️ **The loose export is NOT committed, deliberately.** It is a point-in-time
dump of tables that already live in D1, and D1 is the single source of truth for
this project. Committing 3.6 MB of duplicated league rows would create a second
copy that silently goes stale the moment anyone syncs. Re-export from D1 when a
snapshot is needed; the folder can be deleted.

---

## 2. The rulebook — read from D1, not assumed

⚠️ **THIS IS NOT grffl.** The two leagues must never share a scoring table or a
board. Scoring one with the other's rulebook is worse than useless.

| | Pigskin Classic (ESPN) | grffl (CBS) |
|---|---|---|
| Receptions | **1.0 — full PPR** | 1.0, **TE 1.5** |
| Passing TD | **6** | 4 (vote pending on 6) |
| Rush / rec yards | 0.1 | 0.1 |
| Passing yards | **not stated — fitted at ≈0.054, see §3** | 0.04 (a hidden `per` divisor) |
| Interception | −2 | — |
| Out-of-position TD | normal | **DOUBLE** |
| Keepers | **1 per team** | none |
| Roster | QB1 RB2 WR2 TE1 FLEX2 DST1 + 7 bench = 16 | 18 rounds |
| Kicker | **none** | K + DST |
| Draft | `OFFLINE` (manual) | live |

---

## 3. ⚠️ WAS A BLOCKER — passing yards recovered by fitting

ESPN's own settings payload returns **41 scoring items and none of them is
passing yards** (stat id 3) or fumbles lost (72). Verified against the raw JSON
in `fantasy_league_settings.raw_settings_json`, so this is ESPN's shape, not a
lossy read. Twelve offensive stat ids cannot be confidently named; the provider
stores `stat_name` as NULL rather than guessing, per the same no-fail-open rule
used everywhere else here.

Ids present but unnamed: `8 12 17 18 19 26 37 38 44 56 57 64`.
The pattern — three pairs at 5 and 10 points, three at 2 — *looks* like
distance touchdown bonuses and two-point conversions. **Looks-like is not
knows.** A wrong label would be believed.

### Recovered, not guessed

ESPN will not state the multiplier, but it publishes its own points for every
player-week (`fantasy_player_week_points.points_provider`), and real stat lines
live in `nfl_player_weekly`. Regressing one against the other recovers it.
`scripts/espn_solve_scoring.py`.

| term | value | how |
|---|---|---|
| **passing yards** | **≈0.054 pts/yd** (1 per ~18.5) | fitted |
| **sacks taken** | **−1.0** | fitted — **identifies unnamed id 64** |

**The fit validates itself, which is the only reason to trust it.** The seven
stated rules are subtracted from the points first rather than estimated, and
the control is the 1,371 fitted player-weeks from players who never threw a
pass: after the stated rules alone their median leftover is **0.000 points**.
The stated rulebook is therefore exactly right, so whatever is left over on a
passing week is genuinely passing. Median residual on the 51 passing weeks:
**0.63 pts**.

⚠️ Four wrong turns are recorded in the script because each one *looked* like it
worked:

1. Hardcoding the 2026 league key while querying 2025 returned **zero rows** —
   the key is season-scoped. Only a row-count guard stopped that reading as
   "no data".
2. Omitting the unnamed terms did not remove their effect, it **redistributed
   it**: distance TD bonuses were charged to the yardage rate, returning
   `rush_yds` 0.113 against a stated 0.100.
3. Filtering on `rush_long`/`rec_long`/`pass_long` did nothing — those columns
   are **NULL for all 19,707 rows of 2025**, and `COALESCE(...,0) < 40` turned
   every missing measurement into "no long play", so the filter matched
   everything while appearing to work.
4. Fitting receptions *and* receiving yards together returned 0.82/0.100 —
   collinear terms trading off, with the sum right and the split meaningless.
   Both are already stated; estimating them was the error.

⚠️ **The overall residual is a vanity metric here.** 1,371 of 1,423 fitted rows
are non-passers whose residual is zero by construction, so the overall median of
0.000 says nothing. Only the passing-week residual measures the answer.

**Still unnamed:** ids `8 12 17 18 19 26 37 38 44 56 57` — the 5/10 pairs are
almost certainly distance TD bonuses and the three 2s are two-point
conversions, but that is inference and they stay unnamed. Their absence is why
the passing residual is 0.63 rather than ~0.

---

## 3b. The bonus structure — solved, and it decides how to draft QBs

⚠️ **My earlier guess was wrong.** I read the 5/10 pairs as distance-touchdown
bonuses. They are **yardage milestones**, and the data says so exactly — these
are medians across hundreds of player-weeks, landing on the integer:

| bonus | stat id | value | n | median leftover |
|---|---|---|---|---|
| 100-yd rushing game | 37 | **+5** | 73 | **+5.000** |
| 200-yd rushing game | 38 | **+10** | 4 | **+10.000** |
| 100-yd receiving game | 56 | **+5** | 126 | **+5.000** |
| 200-yd receiving game | 57 | **+10** | 1 | **+10.000** |
| 300-yd passing game | 17 | **+5** | 48 | +5.4 |
| 400-yd passing game | 18 | **+10** | 4 | +11.1 |
| sack taken | 64 | **−1** | — | fitted −1.01 |

⚠️ **The bands are EXCLUSIVE, not cumulative.** 200+ rushing pays 10, not 15.
Stacking them would overpay every big game — this is the same trap the CBS
engine hit, where three bonus shapes cannot share a code path.

Passing yards re-fit below every milestone: **0.0542 pts/yd (1 per ~18.5)**,
stable across every yardage band from 100 up, so there is no hidden threshold
under 300. Full QB model now reproduces real weeks to a **median 0.46 pts**.

### ⚠️ The 100-yard rushing bonus is worthless to a quarterback

Keith asked whether a rushing bonus is a live route for a QB. **It is not, and
the margin is not close.** In 2025, across **561 QB starts**:

- **300+ passing yards: 68 times** (12.1% of starts)
- **100+ rushing yards: ZERO times** — not once
- The single best QB rushing week all season was **81 yards** (Josh Allen)

Verified against a populated column, not an empty one: Allen ran for 579 yards
on the season, Herbert 498, Dart 487. The yardage is real; nobody reaches 100
in a game. **Do not pay up for a rushing quarterback expecting bonus points in
this league** — the volume bonus is a passing bonus.

### ⚠️ And sacks dwarf every bonus a QB can earn

At **−1 per sack**, the sack line is the largest QB scoring differential here,
larger than the milestone bonuses it is competing with:

| QB | starts | 300+ | sacks | bonus | net |
|---|---|---|---|---|---|
| Dak Prescott | 17 | 6 | 31 | +30 | **−1** |
| Bo Nix | 17 | 4 | 22 | +20 | **−2** |
| Trevor Lawrence | 17 | 1 | 41 | +5 | **−36** |
| Lamar Jackson | 13 | 0 | 36 | 0 | **−36** |
| Drake Maye | 17 | 1 | 47 | +5 | **−42** |
| Geno Smith | 15 | 1 | 55 | +5 | **−50** |
| Cam Ward | 16 | 0 | 55 | 0 | **−55** |

**Net bonus-minus-sacks is negative for almost every quarterback in the
league.** The archetype that wins here is a high-volume passer on a team that
protects him — Prescott's six 300-yard games barely cover his 31 sacks, and
Ward gives back 3.4 points a week before anything else happens.

⚠️ Three ESPN ids remain unnamed: `8` (1.25), `12` (1.0) and the three 2-point
conversion candidates `19 / 26 / 44`. The 0.46 residual is their footprint.

---

## 3c. What a winning roster actually looked like (2025)

⚠️ **The champion is NOT recoverable from this data and I will not guess one.**
All twelve teams play every week through week 17, `is_playoffs` is unset on
every matchup row, and `rank` / `is_final` are NULL in standings. The bracket
was never ingested. What IS clean is All-Play, computed from real weekly scores
— every team against every other team, every week, regular season.

| rank | team | all-play | pts for |
|---|---|---|---|
| 1 | Delete the Deleted | 86-57 (60.1%) | 1834.7 |
| 2 | Men Of Maye-Hem | 84-59 (58.7%) | 1881.7 |
| 3 | The Replacement | 83-60 (58.0%) | 1861.4 |
| 4 | Tua Turndaballova | 82-61 (57.3%) | **1941.6** |
| 12 | Chism on maye boutte | 55-88 (38.5%) | 1674.5 |

**Share of starter points by position:**

| team | RB | WR | QB | D/ST | TE |
|---|---|---|---|---|---|
| **#1 Delete the Deleted** | **34%** | 27% | 17% | 14% | 8% |
| **#2 Men Of Maye-Hem** | 27% | **34%** | 18% | 11% | 9% |
| #4 Tua (most points) | 27% | 37% | 17% | 14% | 5% |
| #12 Chism | **21%** | 37% | 18% | 12% | 12% |

Four things this says:

1. **D/ST is 11–14% of starter scoring on every team — more than TE, everywhere.**
   With a required D/ST slot and no kicker, defense is a genuine scoring
   position, not an afterthought. The waiver study agrees: the single
   most-contested claim of 2025 was the **Seahawks D/ST**, drawn by 7 of 12
   teams, and three of the eight most-contested claims were defenses.
2. **QB is a dead heat: 17–18% for all twelve.** Nobody gained an edge at
   quarterback. Combined with the sack finding, this is not where the league is
   won — it is where it can be lost.
3. **RB and WR are interchangeable at the top; the total is what matters.**
   The two best All-Play teams inverted their RB/WR split (34/27 vs 27/34) and
   finished 1-2. Both put ~61% of starter points into RB+WR.
4. **Under-investing at RB is the failure mode.** The worst All-Play team had
   the lowest RB share (21%) and the highest TE share (12%).

**And points do not equal wins.** Tua Turndaballova led the league in scoring by
60 points and finished 4th in All-Play — the points arrived in the wrong weeks.

---

## 4. 2026 keepers — declared 25 Aug, one per team

Surplus is **what you gain**: cost round minus market round. Projections are
ESPN full-PPR on confirmed rules only.

| owner | keeper | cost | ADP | mkt rd | gain | proj | rank |
|---|---|---|---|---|---|---|---|
| Rob | Harold Fannin Jr. | R14 | 78.9 | 7 | **+7** | 188 | TE6 |
| Gary | Colston Loveland | R11 | 57.0 | 5 | **+6** | 206 | TE4 |
| Brett | Trevor Lawrence | R14 | 91.2 | 8 | **+6** | — | QB |
| Stevie | Drake Maye | R10 | 51.8 | 5 | +5 | — | QB |
| **Creelman** | **Luther Burden III** | **R9** | **58.3** | **5** | **+4** | **206** | **WR27** |
| Devan | Bhayshul Tuten | R9 | 52.2 | 5 | +4 | 207 | RB23 |
| Evans | Jaxson Dart | R14 | 116.4 | 10 | +4 | — | QB |
| Jay | Travis Etienne Jr. | R7 | 39.1 | 4 | +3 | 247 | RB17 |
| Gerardi | Rashee Rice | R5 | 14.8 | 2 | +3 | 272 | WR7 |
| Travis | Kyle Monangai | R9 | 108.7 | 9 | 0 | 176 | RB33 |
| Derek | Kenneth Gainwell | R14 | — | — | ? | — | no projection |
| Cox | **undeclared** | — | — | — | — | — | — |

**Picks forfeited by round** (a keeper costs that round's pick):
R5 ×1 · R7 ×1 · **R9 ×3** · R10 ×1 · R11 ×1 · **R14 ×4**

Keith picks in every round except R9. **R14 is the soft round** — four teams sit
it out.

⚠️ Kenneth Gainwell has no ADP and no projection: a data gap, not a verdict.
⚠️ Cox is listed blank, which is not the same as keeping nobody — it changes the
pool.

---

## 5. Strategy — from JJ's guide, which is already in this repo

⚠️ The Late-Round Draft Guide 2026 is extracted at
`pipelines/etl/data/lrdg_2026/` (11 files, 22k lines, since 13 Jul). **Read it
there.** Do not re-extract it from the PDF or hunt for it online; a previous
session did both and rebuilt what was already on disk.
`05_draftplan.txt` is the strategy chapter, organised as round-banded value
pockets.

- **"Round 3-to-5 Wide Receivers" — his money zone**, named verbatim: Zay
  Flowers, Tetairoa McMillan, Emeka Egbuka, **Luther Burden**, Terry McLaurin,
  Jaylen Waddle, Ladd McConkey, plus Christian Watson and Rome Odunze.
  **Keith's keeper is one of these nine, at a round-9 price, and the other
  eight are all still in the pool.** JJ's advice is to get "a couple" from that
  range — one is already free, so R3–R5 picks can take a second and third.
- **"Brock Bowers or Bust"** — of McBride / Loveland / Warren he says take them
  "only when they fall a little past ADP". Loveland at R11 and Fannin at R14
  are correct keeps by that rule, and both are now off the board.
- **"The Late-Round Quarterback Rebound"** — *"Last season, there was
  absolutely no correlation between where you drafted a top-12 quarterback and
  how that quarterback finished."* Three teams have already locked a QB, so QB
  demand in the draft is thin. **Be the last team to take one.**

---

## 6. 2025 waiver market — how this league actually behaves

From the artifact. 507 distinct waiver decisions across 17 weeks; $100
season-long FAAB; leaguewide claim win rate **54.6%** (277 of 507).

- **Biggest single winning bid: $61 — Devin Neal, RB, Week 13.**
- **Volume is not accuracy.** "The Replacement" placed 129 bids, more than the
  next two teams combined, and converted **35.7%** — second worst — while
  walking back 30 claims before processing.
- **Selectivity wins.** "Who Gives A Bucky?" and "Chism on maye boutte" won
  **85.7%** and **84.0%** of claims while spending under a quarter of the cap.
- **Four teams ran the budget to $0**: Tua Turndaballova, The Replacement,
  Multiple Scoregasms, Is This For Real?
- **Streamers start wars.** The most-contested claim of the season was the
  **Seahawks D/ST** — bids from 7 of 12 teams. Three of the eight most-contested
  claims were defenses. With a required DST slot and no kicker, defense
  streaming is a real budget line in this league.

⚠️ 66 of 573 raw records are duplicate origin copies ESPN links via
`relatedTransactionId` and are excluded. 2023 and 2024 are not reachable for
this league.

---

## 7. Open

1. Name the remaining 11 stat ids (§3) — the passing residual of 0.63 pts is
   their footprint. MFL's `detailed?` report carries per-touchdown lengths,
   which is the source that would settle the distance bands.
2. Backfill the 2026 season (task #28).
3. Chase Cox's keeper and Gainwell's projection gap before the draft.
