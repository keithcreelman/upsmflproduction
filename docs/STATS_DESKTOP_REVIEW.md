# Desktop Player Stats — first-principles review (Keith, 2026-10-15)

The goal is an easy, uncluttered desktop page, not keeping every feature. This review covers the
page as #1312 left it (on top of #1305) and proposes what an owner sees instead. It is a DRAFT for
review: nothing merges or deploys from it.

## The owner's questions (what the page is for)
1. Who has performed best?
2. How much has he played?
3. Is it sustainable or driven by opportunity?
4. How does he compare with others at his position?
5. What schedule has he already faced?
6. What changed over the selected weeks?
7. Should I open his detailed view?

Each question gets ONE place to answer it — a view, a stat group, or the player drawer — never all
seven as simultaneous columns.

| Question | Where it is answered |
|---|---|
| 1 Best performers | Table · **Scoring** (the default) |
| 2 How much he played | Table · **Opportunity** |
| 3 Sustainable or opportunity? | **Scatter** (volume × efficiency) · Table · **Efficiency** · **Consistency** |
| 4 Compared with his position | **Heatmap** (percentile profile) · PPG Rk |
| 5 Schedule faced | Table · **Schedule** (one measure) |
| 6 What changed in these weeks | **Window** (presets / custom weeks) · drawer **By week** |
| 7 Open the detail | Click the row → **player drawer** (By week · By season · Full profile) |

## 1. Inventory of the current page (#1312) and what happens to each item

Classification: **Keep** (primary) · **View** (dedicated view) · **More** (More filters) ·
**Drawer** · **Combine** · **Remove**.

### Header and navigation
| Item | Now | Decision | Why |
|---|---|---|---|
| "UPS · Advanced Stats" eyebrow + large title | top | **Combine** → one compact title row | the hero title costs ~90 px above every table |
| Standfirst paragraph ("Every NFL player at a position…") | under title | **Remove** (into About) | permanent text an owner reads once |
| Search players (whole league, `/`) | top right | **Keep** | finds anyone, incl. players not in this list |
| Light/dark toggle | top right | **Keep** (small) | the MFL frame is dark; some owners print light |
| View tabs: Player Stats · Fantasy Points Against · ADP · Vegas · Pace · Schedule | below title | **Keep** (label "Pts Agst") | separate boards; out of scope here |
| About these numbers | **bottom of the page** (`<details>`) | **Keep → top**, a button beside the title opening a compact modal | Keith item 1 |

### Primary controls
| Item | Now | Decision | Why |
|---|---|---|---|
| Season (single; "2024 + 2025" when seasons are added) | row 1 | **Keep** | Q1–Q6 |
| Window (MFL Reg · Playoffs · Total · Full + NFL playoffs · Custom weeks…) | row 1 | **Keep**; custom week pair inline only when Custom | Q6 |
| Position (QB RB WR TE Flex · DL LB DB IDP Flex · PK PN) | row 1 | **Keep** | every question is per position |
| DE/DT and CB/S sub-tabs | inside DL/DB | **Keep**, unchanged: they appear only inside the chosen DL or DB button | no extra row; IDP owners do split edge from interior |
| Fantasy team (multi-select, ⌘-click) | More filters | **Keep → primary**, a single select: All players · Rostered · Free agents · each team | owners ask "best free agents?" constantly; multi-team ⌘-click is unusable |
| Stat group chips (8–10 per position) | row 2 | **Keep, fewer and renamed** (below) | Table only |
| View switch Table · Heatmap · Scatter | — (Scatter/Heat hidden in More → Tools) | **New, primary** | Keith item 2 |
| Find in this list | row 3 | **Keep** (start of row 3) | |
| Sort by select + High/low button | row 3 | **Remove** | headers already sort (click / Enter), with the arrow showing |
| Player count ("226 players") | row 3 right | **Keep** (row 3 right, with the window and freshness) | |
| Reset | inside More filters | **Keep → small text button** at the end of row 3 | Sched pattern: available, not loud |

### More filters panel
| Item | Decision | Why |
|---|---|---|
| Add seasons (multi-select) | **More** (as "Add seasons") | multi-season totals are niche |
| Value filters (per-column min/max) | **More** | power use; shown as "Filters in use" chips |
| Column sets (Standard · Advanced · Analytics · Custom) + saved sets + the 41-group custom picker | **More**, one entry "Choose columns…" | keeps every column reachable without 4 presets competing with stat groups |
| Select players to compare (checkbox column + compare bar + compare drawer) | **More** | occasional |
| Scatter, Heat buttons | **Remove from here → View switch** | Keith item 2 |
| Download CSV | **More** | |

### Notes, warnings and the band
| Item | Decision | Why |
|---|---|---|
| Context line "WR · 2025 · MFL Total · Sources: … · read 8:45 PM" | **Combine** → muted "Wks 1–17 · final · read 8:45 PM" at the end of the filters line; sources → About | |
| "No data reported for these columns…" | **Remove** → status banner (cause-specific) + empty columns hidden | Keith item 3 |
| "Sample too small for…" | **Combine** → banner ("small sample") + ·small n on the header | |
| "The list is the stats source's top 500 …" | **Remove** → banner only when the worker says the list was cut (`next_offset`), cause "source limit" | stored boards (#1314) aren't cut at all |
| "No stats for 2019 … pick an earlier one" | **Remove** → banner with the real cause (no players match / not published / request failed / stored copy unusable) | it was shown for failures that weren't "no stats" |
| Sched Δ / Opp ±% explanation paragraph | **Remove** → About (Schedule group) + banner only if unavailable | |
| Ownership note ("Couldn't read all of MFL's rosters…") | **Combine** → banner, cause "request failure (MFL rosters)" | |
| Source-freshness note | **Combine** → banner when stale / partial; otherwise the muted freshness text | |
| EPA mixed-definition / RZ mixed notes | **Combine** → banner cause "source definitions differ" | |

### Table
| Item | Decision |
|---|---|
| Frozen # and Player (name + "TEAM · Owner") | **Keep** |
| Group header row, heat classes on cells | **Remove** from Table (Heatmap view does color) |
| Header sort, aria-sort | **Keep** |
| Contained scrolling (table scrolls inside its box, header row sticky) | **Keep** |
| Columns with no data for the selection | **Hide** and say so in the banner |
| Compare checkbox column | **More** (only while compare is on) |
| Sparkline (cons_spark) | **Drawer** (weekly chart already there) |

### Stat groups (Table view)
| Now | Decision |
|---|---|
| Fantasy points (PPG Rk, Pts, PPG, G) | **Keep** as **Scoring** (default) |
| Usage | **Keep** as **Opportunity** (snaps %, carries/targets, shares) |
| Passing / Rushing / Receiving | **Keep** as box-score volume only |
| Next Gen | **Combine** with the per-play columns → **Efficiency** (Y/A, Y/Tgt, Catch %, aDOT, separation, RYOE…) |
| Red zone | **Keep** |
| IDP / Kicking / Punting | **Keep** |
| Boom/Bust | **Keep** as **Consistency** (floor, ceiling, boom %, bust %, recent vs window) |
| Schedule context (Pts, Sched Δ, Opp ±%, G) | **Replace** with **Schedule** (MFL Pts, G, one measure — see §5) |
| Custom columns | **More** → "Choose columns…" |
| xFP (2025 only), PFF separation (2025 only), market, dynasty profile, FTN charting | **More** (custom columns) — not in any default group |

### Views and tools
| Item | Decision |
|---|---|
| Scatter (usage × efficiency, axis pickers) | **View** — "Scatter" with a per-position question preset; custom axes in the view |
| Heat (percentile cell color) | **View** — "Heatmap": a fixed per-position profile (8 measures), not color on every column |
| Compare drawer | **More** |
| CSV | **More** |

### Player drawer
| Item | Decision |
|---|---|
| Row/name click → drawer (By week · By season · Full profile ↗) | **Keep** |
| By season (all years) | **Keep, but fix cost first** (#1315: ~1.8M D1 rows per tap today) |
| Weekly chart | **Keep** |

## 2. Recommended page structure (top → bottom)
1. **Title row:** "Player Stats" · [ⓘ About these numbers] · … · [⌕ Search players /] [◐]
2. **View tabs:** Player Stats · Pts Agst · ADP · Vegas · Pace · Schedule
3. **Filter row (one line at 1024+):** Season · Window (+ weeks when Custom) · Position (DE/DT · CB/S inside DL/DB) · Fantasy team
4. **View row:** [Table | Heatmap | Scatter] · then, for the chosen view only: Table → stat group chips · Heatmap → color legend · Scatter → question
5. **Find row:** Find in this list · [More filters · n] · "In use:" chips (only when More filters are set) · … · "226 players · Wks 1–17 · final · read 9:06 PM ET" · Reset
6. **Status banner** (only when something is limited or failed): one line, "See why"
7. **The view** (table box / heatmap box / scatter box), scrolling inside itself
8. **Drawer** on row/dot click

Switching Table ↔ Heatmap ↔ Scatter re-renders the rows already loaded: no request, no reset.

## 3. The status banner — real causes only
| Cause | Detected by | Example text |
|---|---|---|
| Server/client version mismatch | an answer in the older shape (`ok` but no `by_mfl`) or a missing field the page needs | "Schedule stats unavailable — the stats server is older than this page" |
| Source hasn't published it | the column's source has no row for this season/window (season before coverage, or not yet published) | "Next Gen isn't published for 2015 (starts 2016)" |
| Stored copy missing or invalid | `stored_board_unavailable` (#1314) | "The stored 2019 board couldn't be read (checksum mismatch)" |
| Filters legitimately return no players | rows loaded, filters leave 0 | "No players match Free agents + min 8 games" |
| Player omitted by a source limit | the worker says more exists (`next_offset`) | "List stops at 500 players (source limit)" |
| Request failure | HTTP / network error | "Couldn't load Consistency (HTTP 503) — Retry" |
"See why" opens: cause · what it affects · what it is NOT · what to do. Never "not published" for a
version mismatch.

## 4. Wireframes
See `wire_table.png`, `wire_heatmap.png`, `wire_scatter.png` (1280 px) in the review page.

## 5. Sched Δ and Opp ±%
| | **Opp ±%** | **Sched Δ** |
|---|---|---|
| Owner question | "Did the defenses he faced give up more or less than usual to his position?" | "How many points would he have scored against an average schedule?" |
| Calculation (#1305 engine) | For each of his final games, the opponent is rated by what it allowed to the OTHER players at his position ÷ those players' usual (his games left out); Opp = mean rating. +5% = allowed 5% more than usual | Sched Δ = his points ÷ Opp − his points |
| Difference | The schedule itself, independent of the player | The same number restated in his points: same sign meaning reversed (Pickens 2025: Opp −5%, Sched Δ +17.1) |
| Understood without a note? | Mostly, with one sentence | No — needs the division explained, and the sign confuses |
| Changes a real comparison? (2025, starters, Wks 1–17) | Small over a full season: 80% of starters within about −4% to +4%; median 0.1–0.7 PPG; median 1 rank place; flips 10–27% of near-ties (within 1.0 PPG) | identical information |
| Over short windows (Wks 1–6 / 7–12 / 13–17) | Meaningful: QB/TE 80% band ±9–25%; median 0.4–2.9 PPG | identical information |
| Availability | Every season 2011–2025 (stored Pts Agst inputs) and the current season (live); any window. Older playoff weeks are thin (#1307) | same |
| Cost | Finished seasons: 0 D1 (stored); current season: one ~60k-row answer per season/window | same answer |

**Recommendation (built in the preview):** remove both from the general table. Keep ONE measure —
**"Opp. allowed"** (header; its definition reads "Opponents allowed vs usual", i.e. Opp ±% with a plain
name) — in the **Schedule** stat group with MFL Pts and G, described as the schedule already faced,
not a forecast. It appears nowhere else, including Custom columns. Remove Sched Δ from the owner page (keep it in the API for
research). It earns its place mainly for short windows; over a full season it rarely moves a
comparison, and the About text says so.

## 6. Data and cost dependencies
- **No new data, no migration** for this redesign; every column exists today.
- View switching and stat groups use the rows already loaded (one leaderboard answer + side answers per Season/Window/Position).
- Finished seasons: #1314 (stored boards, 0 D1) is assumed; without it each finished-season view is a ~0.3M-row live query (after #1313).
- Heatmap needs the Consistency side answer (~26k rows per season/window, 5-minute cache today; #1315 proposes 30 days for finished seasons).
- Schedule group: #1305's `/api/sos-adjusted-points` (stored for finished seasons; ~60k rows live for the current season).
- Drawer: **#1315 must land first** (84k rows per open; ~1.8M for By season).

## 7. Changes to #1305 and #1312
**#1305 (Sched Δ data):** keep the engine, the stored 2011–2025 inputs and `/api/sos-adjusted-points`
unchanged. Its page changes are replaced: no Sched Δ column on the owner page; Opp ±% appears only in
the Schedule group as "Opp. allowed"; the Sched explanation paragraph goes to About.

**#1312 (desktop redesign):** superseded by this branch (`claude/stats-desktop-v2`, stacked on it):
About moves to a top modal; the filter row gains Fantasy team (single select); Find, More filters and a small Reset share one row; a Table ·
Heatmap · Scatter switch; the Sort-by select goes (headers sort); More filters keeps Add
seasons, value filters, Choose columns…, Compare, CSV; the band's paragraphs become one cause-specific
status banner; empty columns are hidden; stat groups become Scoring · Opportunity · [box score] ·
Efficiency · Red zone · Consistency · Schedule; `docs/STATS_UI_CONTRACT.md` is rewritten to match.
#1312's MFL frame fix (the full-height pane) is kept as is.
