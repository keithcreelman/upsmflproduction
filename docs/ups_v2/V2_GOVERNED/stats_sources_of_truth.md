# Stats Sources of Truth

**Status:** active (2026-04-22 — Keith's stat-source decisions after
"Advanced Stats Workbench" plan review).

This document is the one-stop reference for **where every stat on a
player profile comes from** and **why we chose that source**. The
popup Stats tab uses a Basic / Advanced toggle; the rules for what
goes into each view live here.

---

## The three stat views

Keith's refinement 2026-04-22: what was originally a two-way Basic /
Advanced toggle is a **three-way split** — "Basic" and "Advanced"
were both doing too much. Clear taxonomy:

| View label | What it is | Source tag |
|---|---|---|
| **Scoring (MFL)** | Fantasy-scored view — points, PPG, Elite%, APW | MFL |
| **Raw Stats** | On-field NFL counts — carries, targets, yards, TDs, plus yardline bands (GL I5 / RZ I20 / RZ/EZ targets) | nflverse box + PBP |
| **Advanced** | Derived metrics — weighted opportunity, xFP, FPOE, WOPR, ADOT, etc. | computed (TBD v2) |

### Scoring (MFL-scored fantasy view)

Everything that maps directly to how our league awards fantasy
points. This is the default view and always reflects MFL's own math
so numbers on the popup match numbers on the league site.

| Metric | Source | D1 table |
|---|---|---|
| Fantasy points by week | MFL `TYPE=weeklyResults` | `src_weekly` |
| Season totals (pts, PPG, games) | derived from `src_weekly` | `src_weekly` agg |
| Positional rank (Pts / PPG) | MFL `TYPE=playerRanks` / `player_pointssummary` mirror | `src_pointssummary` |
| Starter / nonstarter status | MFL `TYPE=weeklyResults` (`w.status`) | `src_weekly` |
| Win Chunks (z-derived) | computed in `build_metadata_positionalwinprofile.py` | `src_weekly.win_chunks` |
| Elite / Plus / Dud % | `src_weekly` × `src_baselines` | computed in Worker SQL |
| APW (Adj. All-Play Wins) | WC × positional leverage β | computed in Worker + UI |

Scoring view is **authoritative for our scoring** — never diverges from what MFL would show on the standings or scoreboard.

### Raw Stats (NFL box score + yardline bands)

Real NFL box-score and usage data. Serves the "what did this player
actually DO on the field" question, independent of fantasy points.

| Metric | Source | D1 table |
|---|---|---|
| Rushing att/yds/YPC/TDs | nflverse `load_player_stats()` | `nfl_player_weekly` |
| Receiving targets/recs/yds/TDs | nflverse `load_player_stats()` | `nfl_player_weekly` |
| Passing att/cmp/yds/TDs/INTs | nflverse `load_player_stats()` | `nfl_player_weekly` |
| IDP tackles/sacks/TFL/FF/INT | nflverse `load_player_stats()` | `nfl_player_weekly` |
| Kicker FG makes / att by distance | nflverse `load_player_stats()` | `nfl_player_weekly` |
| Offensive / defensive snaps | nflverse `load_snap_counts()` | `nfl_player_snaps` |
| Snap % of team | computed from snaps + team totals | `nfl_player_snaps` |
| Yardline bands (I20/I10/I5) | nflverse `load_pbp()` | `nfl_player_redzone` |
| End-Zone targets | nflverse `load_pbp()` (air_yards ≥ yardline_100) | `nfl_player_redzone.targets_ez` |
| Route participation / WOPR / ADOT | nflverse `load_nextgen_stats()` | `nfl_player_usage` (future) |
| Routes run / YPRR | **NOT YET SOURCED** | `nfl_player_weekly.routes_run` (NULL) |

**Known sourcing gap — Routes Run (2026-04-23).** The Raw Stats
skill-position template has "Routes" and "YPRR" columns, both
rendering "—" for every season. Rationale:

- nflverse `load_pfr_advstats(stat_type="rec")` currently returns:
  drops, drop %, broken tackles, QB rating when targeted. No routes.
- nflverse `load_nextgen_stats(stat_type="receiving")` returns air
  yards, ADOT, separation, cushion, WOPR-components — no routes.
- Accurate routes-run requires either (a) direct HTML scrape of
  pro-football-reference.com `/years/<YYYY>/receiving_advanced.htm`
  (the "Rt" column, 2018+), or (b) derivation from nflverse
  `load_participation()` at the play level.

Both are future work. The Routes / YPRR columns are kept in the UI
template on purpose — they communicate "this metric is known to
exist and will be surfaced when sourced" rather than silently
omitted. Do not remove them.

Raw Stats view is **authoritative for real-football usage** —
independent of MFL scoring. When the user wants "does this RB get
goal-line carries?", that's here, not in Scoring.

### Advanced (derived / calculated metrics — TBD v2)

Currently a **placeholder**. Will house metrics computed FROM the
raw stats once the foundation is stable:

- **Weighted opportunity** — a 1-yd carry is worth more than a 50-yd
  carry; this view sums per-touch expected-FP contributions.
- **xFP / FPOE** — expected fantasy points given usage vs. actual;
  separates volume from efficiency.
- **WOPR** — air-yards-weighted opportunity rating for WR/TE.
- **ADOT** — average depth of target.
- **Snap share** — player snaps / team snaps.
- **Route participation** — routes run / team dropbacks.

See `docs/nfl_advanced_stats_plan.md` §"Future enhancements — derived
advanced stats" for the full menu + calibration approach.

---

## Why NOT PFF

Keith's call 2026-04-22: **no league-funded PFF subscription.**
~$480/yr is out of scope, so every stat in the Advanced view must
come from nflverse (free, MIT / CC-BY) or MFL (free, authoritative
for our scoring). PFF-only charts (coverage grades, pass-rush win
rate, true pressure rate) are **permanently out of scope**. Use
nflverse proxies where possible:

- **Pressure rate** (DL) → proxy with `qb_hit` counts from PBP.
- **Coverage efficiency** (DB) → proxy with NGS `tgt_separation` when available, else raw targets/yds allowed.
- **Pass-rush win rate** → not derivable — **we simply don't surface this.**

---

## Why one tab, not two

Keith's call 2026-04-22: **one Stats tab with a Basic / Advanced
toggle**, not a separate "NFL" tab. Rationale:

1. Simpler tab strip (stays at 4 tabs, mobile-friendly).
2. Same metric might appear in both views with different numbers
   (e.g., "rushing TDs" from MFL weekly scoring vs. from nflverse
   PBP). The toggle forces the user to pick a frame rather than
   dragging both into visual proximity and inviting confusion.
3. Every stat in the Advanced view is annotated with its source in
   the column header tooltip — curious users can trace back.

---

## Historical depth

Target: **2011-present** where data exists. Earlier years exist in
our MFL mirror but NFL advanced data starts later:

| Data | Available from | Coverage note |
|---|---|---|
| MFL weekly scoring | 2011 | Full league history. Use for Basic. |
| nflverse box score | 1999 | Full coverage across positions. |
| nflverse snap counts | 2012 | **Gap:** 2011 has no snap data. |
| nflverse NGS | 2016 | **Gap:** 2011-2015 has no charting. |
| nflverse PBP (yardline bands) | 1999 | Full coverage. |
| nflverse weekly PFR scraping | ~2006 | Generally reliable. |

**Gap policy:** Advanced view renders what it has and shows "—" for
missing columns, with a small muted note "(data unavailable
pre-YYYY)" at the table foot. Don't hide entire rows — the raw box
score IS available back to 1999, even if snap% isn't.

---

## IDP scoring context

IDP advanced-stat relevance depends on OUR league's IDP scoring
weights, not a generic benchmark. Keith's call 2026-04-22: **read
the weights live from MFL's scoring settings** (`TYPE=rules` export)
rather than hard-coding a snapshot.

**How to use:** The Worker bundle's Advanced view for IDP players
includes a small "Your league scores" block pulled from
`TYPE=rules&L=<league>`:

```
LB scoring: 1.0 pt / tackle, 3.0 / sack, 4.0 / INT, 2.0 / FF
→ Highlight tackles (high weight) and sacks; coverage metrics
  shown but de-emphasized.
```

If the user's league weights sacks / INTs heavily, the column
template visually emphasizes those; if it's a tackle-heavy league,
tackles get top billing. The decision happens in UI, not in data.

**Fetch:** `https://api.myfantasyleague.com/<YEAR>/export?TYPE=rules&L=<league>&JSON=1` — cached in Worker for 1 hour (rules rarely change mid-season).

---

## Functionality vs. MFL's native reports

Keith's call 2026-04-22: **don't mirror MFL's reports UI — they're
unusable.** But capture the functional equivalents (and better):

| MFL report | Our equivalent |
|---|---|
| Player ranks by position | Pts Rk / PPG Rk / APW Rk columns on popup Stats tab (ALREADY SHIPPED) |
| Week-over-week game log | Game Log tab (ALREADY SHIPPED) + Advanced Stats Workbench per-player view |
| Season summary | popup Stats tab career row + Advanced Stats Workbench leaderboard |
| Starter % | Advanced view column (computed from `src_weekly.status`) |
| Top performers / week | Advanced Stats Workbench "Leaderboard" view with week selector |
| Consistency | Elite% + Plus% + Dud% columns (ALREADY SHIPPED) |

The **Advanced Stats Workbench** module (Phase 4) houses the
league-wide slicing functionality: pick a week OR a year, pick a
position, pick any metric, rank / filter / export. Basic and
Advanced metrics side-by-side.

---

## Cadence

- **Basic data:** refreshes with every MFL ETL run (currently
  nightly 03:45 launchd cron).
- **Advanced data:** weekly in-season (Tue AM after MNF) via the
  nflverse fetcher. Backfill 2011→present on first run. nflverse
  typically has finalized weekly data within 24h of game
  completion.
- **Crosswalk (MFL pid ↔ nflverse gsis_id):** rebuilt once per
  season start + incrementally whenever a new rookie hits the
  roster. Written to `player_id_crosswalk.csv` in the pipelines
  repo AND loaded into D1 via the standard loader.

---

## Promotion policy

This doc is authoritative as of 2026-04-22. If any new stat source
is introduced (paid API, different free provider, internal
calculation), add a row here in the same commit that adds the data.
Rule of thumb: every column on the popup must be traceable to a
source listed on this page.

**Cross-refs:** `docs/nfl_advanced_stats_plan.md` (the design plan
this governance doc enforces), `docs/ups_v2/V2_GOVERNED/rules/claude_canonical_rules.md` (the parent governance index).
