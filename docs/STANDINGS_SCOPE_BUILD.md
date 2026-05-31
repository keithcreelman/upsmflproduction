# Standings — Scoped Standings Feature (build spec)

**Approved:** 2026-05-31 (Keith). **Status:** spec ready, not yet built.
**Goal:** the Scope dropdown on Standings V2 → **Full Season / Regular Season / Playoffs / Custom weeks**, recomputing W-L / PF / All-Play for the selected weeks. Eff / Power Rank stay Full-Season only (hidden in scoped views).

**Why a spec, not a rushed build:** it's a ~200-line computation port; there's **no 2026 game data until Week 1 in September**, so it must be verified against a *played* season (2025). Build it as one focused session and test on 2025.

---

## The reference: V1 already did this

`site/standings/mfl_hpm_standings.html` (the scrapped V1) has the **complete working implementation**. Reuse it.

| Piece | V1 location | What it does |
|---|---|---|
| Data shape | state `weeklyScores`/`weeklyMatchups`/`weeklyPotentialPoints` (~655-660) | `{ "week": { fid: score } }` per map |
| All-play (pairwise) | aggregation loop ~1032-1050 | each week, compare **every pair** of franchise scores → `bumpWlt(all_play, a, b)` for both |
| Per-opponent all-play | `computeAllPlayVsOpp(teamId, oppId, ws, startWeek, endWeek)` ~748 | all-play vs one opp over a range |
| Range → weeks | `rangeWeeks(range)` ~789 | `regular`→[start, lastRegWk]; `playoffs`→[regEnd+1, end]; `full`→[start,end]; custom→`clampWeek` |
| Reg-season end | `inferredRegularEndWeek()` ~769 | from `meta.last_regular_season_week` (14) |
| Range aggregation | `sumMapIntoRows()` ~1019 + h2h/div loops ~1052 | sum PF/potential; compute h2h + divisional over the range |

**Per-week data source** (`build_standings_snapshot.py` ~194-223): MFL `weeklyResults` → `franchise.score` + `franchise.opt_pts` per week. MFL serves these for played games.

---

## Build stages

### Stage 1 — per-week data into the worker
The worker must expose the per-week blocks (today it only returns precomputed full-season `src_standings`). Two options:
- **A (pipeline-aligned, preferred long-term):** extend the phase-2 sync to populate `src_franchise_weekly_score` (season, week, fid, team_score, team_opt_pts, is_playoff) + `src_schedule` (matchups) from MFL `weeklyResults`; `/api/standings` returns `weekly: { scores, potential, matchups }` read from D1.
- **B (fast, proven):** point V2 at the existing `standings_{leagueId}_{year}.json` snapshots (already carry the blocks) and compute client-side exactly like V1. Quickest to a working feature; swap to (A) later without changing the computation.

Recommend **B to ship, then migrate to A** when phase-2 RESULTS sync lands (keeps the data-authority direction without blocking the feature).

### Stage 2 — port the computation into V2
Bring V1's `computeAllPlayVsOpp`, `rangeWeeks`, `inferredRegularEndWeek`, and the pairwise all-play + h2h/div aggregation into V2's `renderOverall`/`renderDivisions`. On scope change, recompute rows from the weekly blocks for `[startWeek, endWeek]` and re-render.

### Stage 3 — wire the dropdown (shell already exists)
`#scopeSel` in V2 (currently `disabled`, options: All / Reg Season / Playoffs / Custom weeks…). Enable it:
- All→full, Reg Season→regular, Playoffs→playoffs, Custom→reveal a week multi-select (start/end or checklist), clamp via V1's `clampWeek`.
- **Hide Eff + Power Rank columns** when scope ≠ Full (they're season-only).
- Store scope in `state` + URL (`pushQs`) like the other controls.

---

## Verification
- Develop + test against **2025** (`?year=2025`), which has played-game data. Confirm Full Season matches the current numbers; Regular vs Playoffs split correctly; Custom weeks aggregate right.
- All-play sanity: a team's all-play games per week = (N teams − 1); over R weeks = R×(N−1).
- 2026 will show empty/0 scoped until games play — expected.

## Effort
~1 focused session. Stage 2 (the computation port) is the bulk; stages 1B + 3 are mechanical.
