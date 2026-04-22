# Advanced Data Sourcing — Design Plan (all positions)

**Status:** draft — for Keith's review
**Raised:** 2026-04-22 — after shipping player-profile 4-tab refactor + APW rank.
**Scope expansion 2026-04-22 (Keith):** not just RB/WR. Every scoring
position — QB, RB, WR, TE, PK (kickers), and the three IDP groups
(DL, LB, DB) — needs real usage-level NFL data alongside the
MFL-scored fantasy view. The deliverables scale accordingly: this
isn't "fantasy NFL advanced stats for skill players," it's
**comprehensive data sourcing across every roster slot** so the
player-profile popup AND a broader reporting surface both have the
same facts to draw from.

Two distinct audiences:

1. **Player profile popup** — a new "NFL" tab per player type, showing
   the usage slice relevant to that player (rushing/receiving for
   skill, passing for QB, tackles/sacks for IDP, FG attempts by
   distance + XP + kickoff/punt data for PK). Current season + career.

2. **Reporting mechanism — Usage Workbench** — a standalone module
   lets Keith slice across the league on any axis: redzone usage,
   snap share, route participation, pressure rate (IDP), goal-line
   carries, kicker accuracy by distance, pace-of-play team effects,
   weighted opportunity rankings.

One ETL pipeline → one D1 mirror → both surfaces.

---

## Sources (tiered by cost and confidence)

### Tier 1 — MFL itself (primary / free / authoritative for scoring)

MFL is the source of truth for our fantasy scoring, so whenever a
stat maps directly to what our league scores, MFL must be the
starting point — any other source might use a slightly different
scoring methodology.

**Live scoring + box-score weekly:** `TYPE=weeklyResults` export
(what pipelines/etl already ingests). Gives fantasy points by week
for all players + detailed stat breakdowns MFL chose to surface.

**MFL "All Reports" page** — `https://www48.myfantasyleague.com/<YEAR>/all_reports?L=74598`
— every internal report MFL generates. These are gold:

- **Player ranks by position** — exactly the rank columns we just
  added, straight from MFL's own math.
- **Starting percentage** — how often a player was started by any
  team in the league (league-specific usage signal).
- **Top performers** — weekly / seasonal.
- **Consistency** — week-to-week variance.
- **Power rankings** — schedule-adjusted team strength.
- **Week-by-week scoring breakdown** per player (the page that
  shows "3 rushing TDs, 18 carries for 76 yards" etc. — MFL's
  PARSED version of the NFL box score).

These reports are HTML, not JSON — we'd scrape them with the same
authenticated session our pipelines/etl already uses. The scraper
pays a page hit per week per report but results are cacheable.

**MFL Options / Advanced Search** —
`https://www48.myfantasyleague.com/<YEAR>/options?L=74598&O=08&SEARCHTYPE=ADVANCED`
— exposes filters on stat categories MFL tracks: rushing yards,
targets, receptions, tackles, sacks, etc. The drop-down list of
stat categories on that page IS effectively MFL's data dictionary —
anything in there is available via an `export?TYPE=playerScores`
query with the matching stat parameter.

**Live-scoring API** —
`https://api.myfantasyleague.com/<YEAR>/export?TYPE=liveScoring&L=74598&W=<week>&JSON=1`
— in-game stats updated every minute. Good for current week, no
history.

**Player stats export (the important one)** —
`TYPE=playerScores` with MFL's stat-category codes. These codes are
listed (unhelpfully) on MFL's stat-dictionary page but accept every
category MFL tracks, including IDP and kicking. `&CATEGORY=<code>`
returns a specific stat (pass attempts, rushing TDs, tackles, FG
makes by distance, etc.) per player. Build a small stat-code
dictionary once, then iterate to pull whatever we need.

### Tier 2 — nflverse (free, rich, advanced)

`nflreadr` / `nflreadpy` — https://nflreadr.nflverse.com — the
open-data NFL ecosystem (MIT/CC-BY, nflfastR successor). Ships:

- `load_pbp()` — play-by-play 1999+. This is where we get yardline
  bands (carries inside 5/10/20), third-and-short flags, 2-minute
  drills, etc. THE source for advanced usage.
- `load_player_stats()` — weekly box score 1999+, all positions
  including IDP.
- `load_snap_counts()` — offensive + defensive snap counts per
  player per game, 2012+.
- `load_nextgen_stats()` — NGS charting 2016+: ADOT, air yards,
  separation, time-to-throw, speed/distance — mostly skill-position.
- `load_ff_opportunity()` — pre-computed expected fantasy points
  (xFP) per week, standard PPR scoring.
- `load_rosters_weekly()` — NFL roster state + IDs.
- `load_teams()` — team-level context (pace, plays/game, etc.).
- `load_players()` / `load_ff_playerids()` — crosswalk table
  including MFL IDs where available (~60-70% coverage for active
  starters).

Coverage summary: box score 1999+, snaps 2012+, NGS 2016+, PBP
1999+, charting weekly ~2017+. Matches our MFL history window
(2011+) comfortably.

### Tier 3 — Pro Football Focus (paid, premium charting)

PFF is the gold standard for manual-charted usage:

- **Grades** per player per game (0-100 scale).
- **Pass-rush grades** for DL/LB — true pressure rate, QB hits,
  hurries, pass-rush win rate. Nothing in nflverse matches this.
- **Coverage grades** for DB/LB with targets-allowed, yards-allowed,
  QB rating when targeted.
- **Run-blocking / pass-blocking grades** for OL (useful context
  for RB/QB upside).
- **Route participation** (more complete than nflverse's NGS-derived
  version).
- **Player-comparison elo models.**

**Cost:** PFF Fantasy ~$40/mo ($480/yr) for the premium tier that
includes the per-player stat drill-downs and history. Split 12 ways
= $40/owner/season, well within league-dues territory. Could be a
**league-funded subscription** — commissioner owns the account, ETL
pulls via an authenticated browser session or their fantasy API.
PFF has an unofficial API (`premium.pff.com/api/...`) but formal
API access requires their enterprise tier ($$$). For our volume we
can scrape the fantasy pages once a week.

**If we go PFF:** confirm with the league first — it's a shared
cost and a data-rights question (PFF TOS prohibits redistribution,
so the data can power OUR internal views but not be re-published).

### Tier 4 — FantasyPros / Rotowire / ESPN (free, mostly redundant with nflverse)

ESPN's stats API is fine for box score but their IDP tracking is
thin, and they don't surface advanced charting. FantasyPros
aggregates ECR projections — useful for UI ("consensus rank this
week") but not for historical data. Skip for v1; revisit if a
specific gap appears.

---

## Data we want — by player type

### Skill offense (QB/RB/WR/TE)

**Rushing** (QB + RB + the occasional WR):
- Attempts, yards, YPC, TDs, longest, fumbles, fumbles lost.
- **Yardline bands** — carries inside 5 / inside 10 / inside 20.
- First-down rushing (3rd-and-short conversions, goal-to-go).
- Red-zone rushing share (% of team RZ carries).

**Receiving:**
- Targets, receptions, receiving yards, YPR, YAC, TDs, longest.
- **Target bands** — targets inside 5 / inside 10 / inside 20.
- Route participation (routes run / team dropbacks).
- Air yards, ADOT, target share, WOPR.
- Red-zone target share, end-zone targets.
- Drops, contested catches, YAC over expected (nflverse NGS).

**Passing (QB):**
- Attempts, completions, yards, TDs, INTs, sacks, sack yards.
- Pressure rate faced, time-to-throw (NGS).
- Yards-per-attempt, adjusted YPA.
- Red-zone pass attempts, goal-to-go passing.
- Rushing attempts / yards / TDs (QB scrambles — these score).
- CPOE (completion % over expected), EPA per dropback.

### IDP (DL / LB / DB)

**Shared:**
- Solo + assist tackles, total tackles, TFLs, QB hits, sacks,
  forced fumbles, fumble recoveries.
- Defensive snap count + snap % — IDP scoring is HIGHLY
  opportunity-driven, and snap share is the #1 predictor.
- Starting percentage (MFL report column — league-specific usage).

**DL-specific:**
- Pressures, pass-rush win rate (PFF / NGS).
- Run-stop rate.
- Alignment (edge vs. interior — changes scoring context).

**LB-specific:**
- Coverage targets allowed, yards allowed in coverage.
- Blitz rate, pressure rate when blitzing.
- Pass-rush grade (PFF).

**DB-specific:**
- Targets allowed, completions allowed, yards allowed, TDs allowed.
- Passer rating when targeted (PFF).
- Pass deflections, interceptions, INT returns.
- Slot vs. outside snap split.

### Kicker / Punter (PK — MFL groups them)

**Kicking:**
- FG attempts / makes by distance bucket (0-29, 30-39, 40-49, 50+).
- FG% overall + by distance.
- XP attempts / makes / XP%.
- Kickoffs, kickoff touchbacks, KO touchback %.
- Longest FG.

**Punting** (if MFL scores — depends on roster spot):
- Punts, punt yards, gross avg, net avg.
- Inside-20 punts.
- Touchbacks.
- Punt blocks allowed.

### Team context (everyone benefits)

Every skill / IDP player's individual stats are meaningless without
team denominators:

- **Team offensive snaps** — snap-share math denominator.
- **Team defensive snaps** — same for IDP.
- **Team plays per game** (pace of play) — fast-paced offenses
  inflate every skill-player counting stat.
- **Team pass / rush ratio** — target-share vs. carry-share
  context.
- **Team red-zone trips** — RZ-share denominators.
- **Team points scored / allowed** — baseline scoring environment.
- **Team time-of-possession** — pace cross-check.

Pace-of-play is a sleeper factor Keith specifically called out —
and rightly so. A WR with 6 targets on SF (60 plays/game) is a
different animal from 6 targets on PHI (72 plays/game).

---

## Architecture

### Pipeline

```
pipelines/etl/scripts/
├── fetch_mfl_reports.py           NEW — scrape MFL all_reports per week
├── fetch_mfl_playerscores.py      NEW — iterate stat categories via API
├── fetch_nflverse_weekly.py       NEW — nflreadpy box + snaps + PBP
├── fetch_nflverse_pbp.py          NEW — PBP subset for yardline bands
├── fetch_pff_weekly.py            OPTIONAL (if we subscribe)
└── build_player_id_crosswalk.py   NEW — MFL↔GSIS↔PFR↔PFF IDs

→ local mfl_database.db (new tables alongside src_*):
   mfl_report_<name>            one table per MFL report type we capture
   nfl_player_weekly            box-score weekly (all positions)
   nfl_player_usage             snaps, routes, air yards, WOPR
   nfl_player_redzone           yardline-banded carries/targets
   nfl_player_defense           IDP-specific (tackles, sacks, coverage)
   nfl_player_kicking           FG by distance, XPs, kickoffs
   nfl_player_punting           punts, net avg, inside-20
   nfl_team_context             team pass/rush/plays/pace totals
   nfl_player_pff               grades + pass-rush/coverage metrics
   nfl_player_xfp               xFP + FPOE per week (derived)
   player_id_crosswalk          MFL ↔ GSIS ↔ PFR ↔ PFF IDs

→ scripts/load_local_to_d1.py (new plan entries)

→ D1: parallel nfl_* tables

→ Worker /api/player-bundle:
     existing career_summary + weekly join now with
     nfl_* LEFT JOINs keyed on player_id_crosswalk.gsis_id
     (Worker side stays one round-trip — promise.all)

→ UI:
   - Player popup gets an "NFL" tab keyed to pos_group
     (different template per pos_group: skill vs QB vs IDP vs PK)
   - New Usage Workbench module — leaderboards / comparison /
     team trends
```

### Player-ID crosswalk (the hard blocker)

MFL → GSIS matching is Phase 0. Without it nothing downstream
works. Strategy:

1. **Exact match** on (normalized_name, DOB, NFL team, position) —
   nflreadpy's `load_ff_playerids()` already has `mfl_id` for many
   players (DLF / FFPC datasets). Free ~60-70% coverage.
2. **Fuzzy match** for the rest: jaro-winkler on name within same
   (season, team, pos); auto-accept ≥ 0.95, manual queue 0.85-0.95.
3. **Manual overrides** for common-name collisions (Michael Thomas
   WR NOS vs Michael Thomas S MIA — we hit this in 2016 rookie
   draft fix). One-time, tracked in crosswalk CSV with
   `confidence='manual'`.
4. **Coverage manifest** — refuse to publish if active-roster
   coverage drops below 95% for any position.

Phase 0 effort: ~1 week. Gating event for everything else.

---

## UI — player-profile "NFL" tab

Template varies by pos_group (what makes sense to show):

### Skill (RB / WR / TE) — most content

```
┌────────────────────── 2025 ─────────────────────────┐
│ Snaps 512 (78% of team)   Routes 410 (81%)          │
│ Targets 128   WOPR 0.64   ADOT 9.8                  │
│ Carries 14   Carries I10: 3   Carries I5: 1         │
│ Targets I10: 8   Targets I5: 2                      │
│ Rushing: 58 yds 1 TD                                │
│ Receiving: 94-1210-11, 14.7 YPR, 5.2 YAC            │
│ xFP 268.4   FPOE +22.1  (top 15% hit-rate)          │
└──────────────────────────────────────────────────────┘

Season log table: rush att / yds / TD / tgts / recs / yds / TDs
                  / snaps% / WOPR / xFP / FPOE
```

### QB

```
┌────────────────────── 2025 ─────────────────────────┐
│ Dropbacks 520 (98% of team)                         │
│ Att 482  Cmp 318  Yds 4012  TD 28  INT 8            │
│ CPOE +2.4   EPA/DB +0.18   Sacks 27                 │
│ Rush: 62-320-3   Scramble rate 8%                   │
│ Red-zone: 45-att, 72% cmp, 18 TDs                   │
│ Pressured rate 31%   Time-to-throw 2.8s             │
└──────────────────────────────────────────────────────┘
```

### IDP (DL / LB / DB)

```
┌────────────────────── 2025 ─────────────────────────┐
│ Def snaps 982 (94% of team)                         │
│ Tackles 88 (56 solo + 32 ast)  TFLs 12              │
│ Sacks 7.5  QB Hits 18  FF 2                         │
│ (LB/DB extras) coverage tgts 42, 28 rec, 312 yds    │
│ (DL extras) pass-rush WR 14.2%, pressures 44        │
│ MFL started % this season: 88%   PFF grade 82.3     │
└──────────────────────────────────────────────────────┘
```

### Kicker / Punter

```
┌────────────────────── 2025 ─────────────────────────┐
│ FG 28/32 (87.5%)                                    │
│   0-39: 12/12   40-49: 10/12   50+: 6/8             │
│   Long 58                                           │
│ XP 44/45                                            │
│ KO TB 58/72 (80.6%)                                 │
│ (if also punting) Punts 42 avg 46.1 net 42.3 i20 15 │
└──────────────────────────────────────────────────────┘
```

**Implementation:** one React-ish switch on `bundle.pos_group` →
renders the right template. All four templates share the same
container styling (matches the existing Bio/Stats/Game Log/News
tab chrome).

---

## UI — Usage Workbench (standalone module)

New MFL message slot (same jsDelivr pattern as Draft Hub).
**Three views:**

1. **Leaderboard** — filter pos_group + season + week-range +
   metric. Columns: player, team, GP, snaps%, touches/tgt share,
   WOPR, carries-I10, tgts-I10, xFP, FPOE (skill); OR tackles,
   sacks, pressures, TFL, FF (IDP); OR FG% by band, FG makes,
   XP% (PK). Sort / filter / export CSV.
2. **Player comparison** — 2-4 players side-by-side over a week
   range. Bar-graph deltas. Usefully feeds trade evals.
3. **Team trends** — which offenses concentrate targets? Which
   defenses let up the most FP to opposing WRs? Team-level
   rollups from `nfl_team_context`.

---

## Phased rollout (revised)

### Phase 0 — ID crosswalk (≈ 1 week)

Build `player_id_crosswalk` covering MFL ↔ GSIS ↔ PFR ↔ PFF IDs.
≥ 95% active-roster coverage gate. Nothing else starts before this.

### Phase 1 — MFL report + options scrape (≈ 1 week)

- Scrape the MFL all_reports page categories (player ranks, start%,
  top performers, week-by-week breakdown).
- Iterate `TYPE=playerScores` by stat category.
- Land in `mfl_report_*` tables.
- Expose in popup: season rank rows already land from MFL directly
  (authoritative for our scoring).

This is "the data MFL already has" — quickest win, no crosswalk
dependency for most of it since it's already keyed on MFL pid.

### Phase 2 — nflverse box + snaps, all positions (≈ 1 week)

- Fetch `nflverse.load_player_stats()` for every pos_group + snap
  counts.
- Land in `nfl_player_weekly`, `nfl_player_defense`,
  `nfl_player_kicking`, `nfl_player_punting`.
- Add the "NFL" tab to player profile popup with basic templates
  per pos_group.
- Gate: ID crosswalk coverage satisfied.

### Phase 3 — Advanced usage: PBP + NGS + team context (≈ 2 weeks)

- Fetch nflverse PBP → derive yardline bands, first-down flags,
  team pace.
- Fetch NGS → air yards, ADOT, WOPR, CPOE, time-to-throw.
- Land in `nfl_player_usage`, `nfl_player_redzone`,
  `nfl_team_context`.
- Expand the "NFL" tab templates.
- Ship xFP / FPOE derivation in Worker (start with
  nflverse.load_ff_opportunity(), later calibrate to MFL scoring).

### Phase 4 — Usage Workbench module (≈ 1 week)

- Leaderboard / Comparison / Team Trends views.
- jsDelivr delivery, MFL message-slot embed.

### Phase 5 — PFF integration (IF approved by league) (≈ 1 week)

- League subscribes to PFF (commissioner-owned).
- Browser-session scraper pulls per-player grades + pass-rush /
  coverage metrics weekly.
- Enrich IDP templates with coverage yards / pass-rush WR.
- Enrich skill templates with separation / route-grade.

Total runway end-to-end: **~5-7 weeks** depending on PFF decision.

---

## Non-goals for v1

- **Live in-game updates.** Weekly refresh after the slate is enough.
- **Snap-level formation tagging** (11 personnel, shotgun, pistol).
  PFF + PBP both have it; not prioritized.
- **Injury / practice participation** — separate news-feed track.
- **Contract / cap data** (Spotrac / OverTheCap) — separate project.
- **Machine-learning projections.** We already leverage ZAP / KTC
  / our own model; this is about OBSERVED usage, not predictions.

---

## Open questions for Keith

1. **PFF decision.** Is a league-funded PFF subscription on the
   table? Answer changes Phase 5 from scope-in to drop.
2. **NFL tab vs. Stats sub-toggle.** Separate 5th tab or fold into
   Stats with a "MFL view / NFL view" selector? Separate tab is
   more discoverable; sub-toggle keeps the strip tidy on mobile.
3. **Historical depth.** Backfill all the way to 2011 (matches our
   MFL history) or start at 2017+ (when the modern charting data
   is reliable)? Box score goes back further than advanced stats.
4. **MFL report priority.** Of the all_reports page categories,
   which TWO or THREE are most valuable to Keith? That frontloads
   Phase 1 effort on the highest-leverage ones.
5. **IDP scoring audit.** Our IDP scoring rules are the
   denominator for every IDP advanced stat we surface. Want to
   confirm the scoring settings + make sure the column templates
   render metrics our league actually cares about (e.g. if our
   LB scoring weights sacks heavily, pressure rate is MORE
   relevant; if it's tackle-heavy, coverage metrics matter less).

---

## Risks

- **Crosswalk** (Phase 0) stalls everything. 95% coverage is
  demanding for older seasons.
- **MFL scraping is fragile.** HTML changes break scrapers. Write
  tolerance: retry on parse-fail, snapshot the HTML so we can
  replay.
- **PFF TOS.** Data is for internal use only — no public sharing.
  Usage Workbench would be league-members-only (it already is via
  MFL auth).
- **D1 size.** All-position weekly × 2500 players × 280 weeks ×
  ~8 tables ≈ 5-6M rows. D1 handles that fine but index planning
  matters. Compose the crosswalk indexes carefully.
- **nflverse schema drift.** They rename columns (2023
  receptions→rec). Pin the nflreadpy version; write column-name
  aliases in the fetcher so an upstream rename doesn't break the
  load.

---

*Plan, not a spec. Next step: you mark up the open questions,
answer PFF yes/no, pick top MFL report categories, and then we
start Phase 0.*
