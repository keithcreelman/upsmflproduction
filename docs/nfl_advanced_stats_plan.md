# NFL Advanced Stats Integration — Design Plan

**Status:** draft — for Keith's review
**Raised:** 2026-04-22 — after shipping player-profile 4-tab refactor + WC-β rank.
**Scope:** bring real NFL play-level data into the app so we can answer
"what is this player *actually* doing on the field" questions alongside the
MFL-scored fantasy view we already have.

---

## Goals

Two distinct audiences:

1. **Player profile popup** — a compact "NFL Usage" card next to the existing
   Stats tab: attempts/yards/YPC/TDs/targets/receptions/receiving yards for
   the current season + career totals. Fits in the existing 4-tab layout as
   a new "NFL" tab or folded into Stats behind a sub-toggle.

2. **Reporting mechanism** — a new, standalone tool (call it **Usage
   Workbench** for now) that lets Keith slice player usage across the
   league. Goal-line share, redzone opportunity, weighted-opportunity
   rankings, route-participation gaps, etc. — the stuff that separates
   "this RB touched the ball 18 times" from "this RB touched the ball 18
   times but only 1 was inside the 10."

The same ETL pipeline and D1 mirror serves both — one source of truth.

---

## The data we want

### Tier 1 — box-score (table stakes)

Weekly per-player per-game, both sides of the ball where relevant:

- **Rushing** — attempts, yards, YPC, rushing TDs, fumbles, fumbles lost
- **Receiving** — targets, receptions, receiving yards, receiving TDs,
  YPR, YAC (if source has it), drops, contested catches
- **Passing** — attempts, completions, yards, TDs, INTs, sacks, sack
  yards, rushing attempts (QB scrambles), rushing yards, rushing TDs
- **Team context** — team pass attempts, team rush attempts, team plays
  (denominator for share metrics). This is crucial — "10 targets" is
  very different on a 25-attempt team vs a 45-attempt team.

### Tier 2 — usage / opportunity

- **Carries by yardline band** — carries inside 5 / inside 10 / inside 20
  (redzone). This is the "carries inside 5" question you asked.
- **Targets by yardline band** — same concept, targets inside 5/10/20.
- **Snap counts** — offensive snaps + % of team snaps.
- **Route participation** — routes run + % of team dropbacks (needs
  charting data — nflverse has this).
- **Air yards** — ADOT (avg depth of target), total air yards, target
  share, WOPR (air-yard-weighted target share). WOPR is close to what
  you're calling "weighted opportunity" for WRs.
- **First-down opportunities** — 3rd-down rushes, 3rd-and-short rushes,
  2-minute-drill targets.

### Tier 3 — expected/efficiency (derived)

- **Expected fantasy points (xFP)** — the big one. Opportunity-weighted
  fantasy-point expectation, independent of how the play turned out.
  Our own scoring weights (MFL PPR + bonuses) applied to expected
  outcome per play.
- **Fantasy points over expected (FPOE)** = actual − xFP. Separates
  volume players (high xFP, can regress) from efficiency spikes
  (positive FPOE, may not last).
- **Weighted opportunity** for RBs = α·carries + β·targets, with α/β
  calibrated against the MFL scoring we use (roughly 0.6 per carry +
  2.0 per target in standard PPR lit, but we'll fit our own).
- **RZ share / GL share** (touches inside 20 / inside 5) as a fraction
  of team totals.

---

## Source

**nflverse / nflreadr / nflreadpy** — https://nflreadr.nflverse.com — is
the right primary source. It's the open-data successor to nflfastR, it
ships play-by-play + PFR-scraped weekly stats + snap counts + charting
data (routes/air yards from ngs), and it's Python-callable via
`nflreadpy`. Licensed MIT/CC-BY, safe to redistribute.

Key datasets we'd pull:

| Dataset | Granularity | Tier | Via |
|---|---|---|---|
| `load_pbp()` | play-by-play | 1/2 | nflreadpy — needed for yardline bands + first-down flags |
| `load_player_stats()` | weekly | 1 | nflreadpy — box-score weekly |
| `load_snap_counts()` | weekly | 2 | nflreadpy |
| `load_nextgen_stats()` | weekly | 2/3 | nflreadpy — air yards, YAC |
| `load_ff_opportunity()` | weekly | 3 | nflreadpy — pre-computed xFP |
| `load_rosters_weekly()` | weekly | — | nflreadpy — NFL GSIS→MFL pid crosswalk |

nflverse refreshes within 24h of game completion. Seasonal stats
backfilled to 1999; PBP to 1999; NGS to 2016; snaps to 2012; charting
weekly to ~2017. Matches our MFL history window (2011+).

**Alternative sources (rejected for v1):**
- PFR direct scrape — nflverse already does this for us.
- ESPN API — no usage-level data, brittle.
- Sportsradar / paid APIs — overkill for our volume, not worth the cost.
- NFL GSIS raw — nflverse already parses it.

---

## Player-ID join — the hard part

MFL uses its own `player_id`. nflverse uses `gsis_id` (primary) and
`pfr_id`. Both publish a crosswalk in the player lookup table
(`load_players()` / `load_ff_playerids()`) — gsis_id ↔ pfr_id ↔
sleeper_id ↔ mfl_id ↔ espn_id etc.

**Build an id mapping table in the ETL pipeline**, not at runtime:

```
pipelines/etl/data/player_id_crosswalk.csv
 mfl_player_id, nfl_gsis_id, nfl_pfr_id, full_name, first_name,
 last_name, position, nfl_team, birth_date, confidence
```

Confidence field lets us mark exact-match (DOB + name + team aligned)
vs. fuzzy-match (name similarity ≥ 0.9, manual review pending).

**MFL → GSIS mapping strategy:**
1. Exact match on (normalized_name, dob, pos) — nflreadpy's
   `load_ff_playerids()` has `mfl_id` when players are in DLF/FFPC
   datasets. Cover maybe 60-70% for free.
2. For the rest: fuzzy name match within same (season, team,
   position), rank by jaro_winkler similarity, auto-accept ≥ 0.95,
   queue the 0.85-0.95 band for manual review, reject below.
3. Track mapping coverage in manifest table (`idmap_coverage`) —
   refuse to publish anything if coverage drops below 95%.

One-time build, then incremental on new rookies each year.

---

## Proposed architecture

### Pipeline

```
nflverse API ──► pipelines/etl/scripts/fetch_nfl_weekly.py (Python + nflreadpy)
                │
                ├──► nfl_player_weekly    (box-score weekly)
                ├──► nfl_player_usage     (snaps, routes, air yards)
                ├──► nfl_player_redzone   (yardline-banded carries/targets)
                ├──► nfl_team_context     (team pass/rush/plays totals)
                └──► nfl_player_xfp       (computed xFP + FPOE per week)
                │
                │ (all keyed by gsis_id + season + week)
                ▼
                local mfl_database.db (adds new tables alongside src_*)
                │
                ▼
                scripts/load_local_to_d1.py (existing loader, new plan entries)
                │
                ▼
                D1 (nfl_* tables parallel to existing src_* tables)
                │
                ▼
                Worker /api/player-bundle — LEFT JOIN on id_crosswalk + nfl_*
                │
                ▼
                Rookie Hub / Front Office popups + new Usage Workbench
```

**Cadence:** weekly in-season (Tue AM, after MNF). Backfill all history
once at bootstrap. Reuse the existing launchd pattern.

### New D1 tables (rough sketch)

```sql
CREATE TABLE nfl_player_weekly (
  season INTEGER, week INTEGER, gsis_id TEXT,
  team TEXT, position TEXT, opponent TEXT,
  rush_att INTEGER, rush_yds INTEGER, rush_tds INTEGER,
  targets INTEGER, receptions INTEGER, rec_yds INTEGER, rec_tds INTEGER,
  pass_att INTEGER, pass_cmp INTEGER, pass_yds INTEGER,
  pass_tds INTEGER, pass_ints INTEGER, sacks INTEGER,
  fumbles INTEGER, fumbles_lost INTEGER,
  fp_std REAL, fp_ppr REAL,  -- standard and 1-PPR for reference
  PRIMARY KEY (season, week, gsis_id)
);

CREATE TABLE nfl_player_usage (
  season INTEGER, week INTEGER, gsis_id TEXT,
  off_snaps INTEGER, team_off_snaps INTEGER, snap_pct REAL,
  routes_run INTEGER, team_dropbacks INTEGER, route_pct REAL,
  air_yards REAL, adot REAL,
  target_share REAL, wopr REAL,
  PRIMARY KEY (season, week, gsis_id)
);

CREATE TABLE nfl_player_redzone (
  season INTEGER, week INTEGER, gsis_id TEXT,
  carries_i20 INTEGER, carries_i10 INTEGER, carries_i5 INTEGER,
  rz_tds INTEGER,
  targets_i20 INTEGER, targets_i10 INTEGER, targets_i5 INTEGER,
  recs_i20 INTEGER, recs_i10 INTEGER, recs_i5 INTEGER,
  PRIMARY KEY (season, week, gsis_id)
);

CREATE TABLE nfl_team_context (
  season INTEGER, week INTEGER, team TEXT,
  team_plays INTEGER, team_pass_att INTEGER, team_rush_att INTEGER,
  team_dropbacks INTEGER, team_rz_plays INTEGER,
  PRIMARY KEY (season, week, team)
);

CREATE TABLE player_id_crosswalk (
  mfl_player_id INTEGER PRIMARY KEY,
  gsis_id TEXT,
  pfr_id TEXT,
  full_name TEXT,
  confidence TEXT,  -- 'exact' | 'fuzzy_auto' | 'manual'
  updated_at TEXT
);
```

xFP/FPOE computed client-side OR materialized as a 6th table — TBD.

---

## UI changes

### Player profile popup — new "NFL" tab (or fold into Stats)

Minimal — a season-level table + a current-season usage card:

```
Brock Purdy · QB · SF
──────────────────────────────────────
Season   GP    Att   Cmp   Yds   TD  Int   Sacks   Rush   RushY  RushTD
2024     17    500   340   4200  28  10    35      60     220    4
2025     14    420   290   3500  22  8     28      48     180    3
──────────────────────────────────────
2025 Usage: 96% snaps · 6.1 ADOT on deep shots · 8.2 sacks/gm
```

For RB/WR the card emphasizes redzone share:

```
Christian McCaffrey · RB · SF
──────────────────────────────────────
Season   Car   Yds   YPC   TDs   Tgts   Rec   RecY   Carries-I5   Tgts-I5
2024     245   1200  4.9   14    110    85    750    22           4
──────────────────────────────────────
2025 share: 72% snaps · 78% redzone carries · 18% target share
```

No rewrite of the 4-tab structure — insert "NFL" as tab 3 or add a
sub-toggle on Stats tab.

### New module — Usage Workbench

Standalone page (new MFL message slot). Three views:

1. **Leaderboard** — filter by position, season, week range. Rank by
   any metric. Mirror the Rookie Hub's filter/table pattern.
   Columns: player, team, GP, snap%, route%, target%, WOPR,
   carries-I10, targets-I10, xFP, FPOE.

2. **Player comparison** — pick 2-4 players, show side-by-side usage
   over selected weeks. Useful for trade evals.

3. **Team trends** — which offenses concentrate volume? Which WRs have
   air-yards monopolies? Team-level rollups from nfl_team_context.

This is the "comprehensive reporting mechanism" you asked for — built
on the same D1 backing but with its own UI surface so the popup stays
lightweight.

---

## Rollout phases

### Phase 1 — ID crosswalk + box-score (≈ 1 week)

- Build `player_id_crosswalk` table — MFL ↔ GSIS.
- Fetch nflverse box-score weekly → `nfl_player_weekly` only.
- Load into D1 via existing loader.
- Add "NFL" tab to player profile popup with the box-score table.
- **Gate:** crosswalk ≥ 95% coverage for active 2020-2025 rosters.

### Phase 2 — usage + redzone (≈ 1 week)

- Add `nfl_player_usage` + `nfl_player_redzone` + `nfl_team_context`.
- Extend the popup "NFL" tab with the usage card.
- Start computing WOPR / carries-I5 etc. in the Worker bundle.

### Phase 3 — xFP + FPOE + Usage Workbench (≈ 2 weeks)

- Build our own xFP calculator calibrated to MFL PPR scoring — we
  have the per-week fantasy scores already, so we can regress.
- Ship the Usage Workbench module (new MFL message slot, jsDelivr).
- Weekly FPOE rankings → drives the "who's been lucky / unlucky"
  content for the Rookie Hub and trade roasts.

### Phase 4 — advanced (future)

- Play-level lookup for specific questions ("every Purdy 3rd-and-long
  target share").
- Hook xFP into the trade-value model.
- Tier classifier built on xFP instead of (or alongside) MFL score.

---

## Explicit non-goals (for v1)

- **No real-time / in-game data.** nflverse refreshes post-game; that
  matches our MFL refresh cadence and is plenty.
- **No coverage-quality / scheme tagging.** Play-type tags (shotgun,
  pistol, 11-personnel) are in PBP but we're not slicing that deep.
- **No injury reports / practice participation.** Separate source
  (FantasyPros / RotoWire); deferred to news-tab v2.
- **No contract / salary data.** Spotrac/OverTheCap; separate project.

---

## Open questions for Keith

1. **NFL tab vs. sub-toggle on Stats tab** — which feels cleaner? A
   5th tab ("NFL") is honest labeling but crowds the tab strip on
   mobile. A Stats-tab toggle ("MFL view / NFL view") keeps the tab
   count at 4 but is less discoverable.

2. **Historical depth** — backfill all the way to 2011 (matches our
   MFL history) or just 2017+ (when the modern usage data is
   reliable)? Backfill bloat vs. historical completeness.

3. **Usage Workbench as MFL message slot or as a standalone site
   page?** The current modules are all Message-slot HPMs; Usage
   Workbench could follow the same pattern for consistency, or it
   could live at `/usage` on the site domain and skip the iframe
   overhead.

4. **Priority order** — if you want something sooner than the ~4
   weeks end-to-end, which tier matters most? My read: Tier 2
   (usage / redzone) has the most "oh, that's new!" factor relative
   to what we have; Tier 1 is table-stakes but most users can get it
   from MFL's built-in stats page anyway.

5. **xFP calibration approach** — use nflverse's
   `load_ff_opportunity()` pre-computed xFP (fast, standard PPR), or
   fit our own model against our MFL scoring (slower, more accurate
   for us)? I lean toward using theirs as Phase 3 MVP and swapping
   ours in later.

---

## Risk / scope callouts

- **Crosswalk coverage is the dealbreaker.** If we can't reliably
  match MFL→GSIS for ~95%+ of starters 2017+, nothing downstream
  works. Phase 1 is almost entirely this problem.
- **D1 size.** Box-score + usage weekly for 2011-2025 is ~2500
  players × 280 weeks × ~5 tables ≈ 3.5M rows. D1 handles that fine
  (src_weekly already holds 226k), but indexes matter — plan for
  (gsis_id, season) indexes up front.
- **nflverse schema drift.** They change column names occasionally
  (e.g. 2023 receptions → rec; total_yards → yards). Pin the
  nflreadpy version and write column-name aliases in the fetcher so
  an upstream rename doesn't break the ETL.

---

*This is a plan, not a spec. Expect to revise after Keith's review
and before any code ships.*
