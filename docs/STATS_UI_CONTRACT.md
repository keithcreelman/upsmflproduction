# Stats UI contract

The shared rules for UPS Stats screens. They come from the released mobile Stats work (#1238, #1246, #1257, #1270), Keith's 2026-10-15 notes on the desktop Stats Workbench, and his first-principles review of the desktop page the same day (`docs/STATS_DESKTOP_REVIEW.md`). Each screen applies them in its own layout: the phone app is built for 320–375px, the desktop page for the MFL frame and 1024 / 1280 / 1440px. Mobile organizes the information; it is not the desktop's width template. Tests: `tests/stats_ui_contract.test.mjs` (desktop) and `tests/mobile_stats_players_review.test.mjs` (mobile).

## 1. Order on the desktop screen
1. **Title row:** "Player Stats", an **About these numbers** button beside it, and on the right Search players and the theme switch. No permanent explanation above the table.
2. **View tabs:** Player Stats · Pts Agst · ADP · Vegas · Pace · Schedule.
3. **Filter row:** Season, Window (week pair only for Custom weeks), Position (DE/DT and CB/S inside DL and DB), Fantasy team.
4. **View row:** Table · Heatmap · Scatter, then the chosen view's own control: stat groups (Table), the color legend (Heatmap) or the question (Scatter).
5. **Find row:** Find in this list, **More filters**, the "In use:" chips for anything set under More filters, and on the right the count, weeks, freshness and a small **Reset**.
6. **Status banner:** one line, only when something is limited or failed (§7).
7. **The view,** scrolling inside its own region.
8. **Player detail:** a side drawer. The view stays where it was.

**More filters** holds the uncommon choices: Add seasons, value filters, Choose columns (custom column sets), Compare and Download CSV. **Reset** clears everything except the position.

The phone keeps its own order (heading, controls, search and sort, band, table, detail, About).

## 2. Position and stat groups
- **Positions:** QB, RB, WR, TE, DL, LB, DB, PK, PN. The desktop page adds Flex (offense) and IDP Flex.
- **Stat groups (Table view):** one group at a time. **Scoring** comes first and is the default. The rest, as the position has them: Opportunity (snaps, share), the box-score groups as volume (Passing, Rushing, Receiving, IDP tackles / pass rush / coverage, Kicking, Punting), **Efficiency** (per-play rates and Next Gen), Red zone, Consistency, and **Schedule**.
- **Schedule** holds one schedule measure, **Opp. allowed** (the schedule already faced, not a forecast), beside MFL points and games. Sched Δ is not on the owner page; it stays in the API.
- **Switching** position, group or view keeps the season, window, fantasy team, search and More filters.

## 3. Views
All three views show the same rows: the same Season, Window, Position, Fantasy team, Find and More filters. **Switching view makes no request** and resets nothing; it redraws the rows already loaded.
- **Table:** the stat group's columns. Answers "who is best" and "how much did he play".
- **Heatmap:** one fixed profile per position (8 measures, e.g. WR: PPG, Snap%, Tgt%, Y/T, Catch%, aDOT, Boom%, Consist). Each cell is colored by fifth among the listed players with at least half the most games anyone listed has; players under that are shown uncolored and not ranked. Answers "how does he compare at his position".
- **Scatter:** one question per position from a preset (e.g. WR "Volume or efficiency? · Target share × Yards per target"), with custom axes available. Players under the same games floor aren't drawn and the note says how many. Dashed lines are the medians; the highest scorers are named where the name fits. Answers "is it sustainable or opportunity".

## 4. Columns
- **Limits:** a group has at most 8 numbers on desktop and 4 on mobile. Points per game appears only in Scoring, never beside box-score or schedule numbers.
- **Player column:** on desktop it is frozen. The page never scrolls sideways; a wide table scrolls inside its own region.
- **Every column has a one-line definition** (its header tooltip and an About entry). Short labels: Tgt, RecYd, Snap%.
- **Empty columns are hidden** in the Table view when a source has nothing for the selection; the status banner names them and why (§7).

## 5. Player identity and rows
- **Who he is:** the player's name, with his NFL team and his fantasy owner (or FA) beneath it. Flex tabs add his position.
- **Opening a player:** the whole row (or a scatter dot) opens his detail, and the name is a real button (keyboard: Tab, then Enter). Closing returns focus to the row.
- **Owner unknown:** a player whose owner couldn't be confirmed says "owner unknown", never "FA".

## 6. Sorting
- **Every number column sorts** from its header (click, Enter or Space): high to low first, then low to high. "—" sorts last both ways.
- **Showing the sort:** the active header shows ▼ or ▲ and carries `aria-sort`. The phone also has a Sort control in words; the desktop has no separate sort menu.
- **Defaults:** each group has its own default. Changing group keeps a sort column that is still visible.

## 7. Status banner (desktop)
One line under the controls, only when something is limited or failed, e.g. "Schedule stats unavailable — See why". **See why** opens the exact explanation: the cause, what it affects, and what to do. Causes are told apart and never substituted for one another:

| Cause | Detected by |
|---|---|
| Server and page versions differ | an answer in an older shape (e.g. the schedule answer without `by_mfl`) |
| The source hasn't published it | the season or window is outside what the source covers |
| Stored copy missing or invalid | `stored_board_unavailable` from a finished-season store |
| No players match the filters | rows loaded, the filters leave none |
| Left out by a source limit | the source says more rows exist than it sent |
| A request failed | HTTP or network error |

Never "the source hasn't published it" when the server is on an older version. Definitions, partial weeks, ownership and small samples are notes in the same banner, below any failure.

## 8. Source weeks and freshness
- **The Find row** states the count, the weeks and whether they're final or in progress, and the read time: "226 players · Wks 1–17 · final · read 9:06 PM ET". **About** names every source the visible columns use, with its weeks.
- **Read times never appear in rows.**
- **Another season is never substituted for the one asked for.** No data for a season shows "—" with the reason.

## 9. States, each said in words
| State | What the screen does |
|---|---|
| Loading | "Loading 2026 WR…" in the view area; no stale rows under it |
| Unavailable | The banner names the source and the cause; its cells read "—" |
| Stale | "May be behind: last refreshed …" for that source |
| Partial week | A week in progress is named as **in progress**, never shown as final |
| Small sample | Marked **small sample**, distinct from partial; the Heatmap and Scatter apply a stated games floor |
| Mixed seasons | Seasons are **added together**, shown as an "In use" chip, with each season's weeks in About |

## 10. Color
- **Color only where it encodes a stated scale:** the Heatmap's fifths (legend on screen, explained in About).
- **Opp. allowed is never colored.** It describes a schedule. No easy/tough wording and no forecast wording, anywhere.
- **Minus signs** are real minus signs (−2.1).

## 11. Layout
- **Desktop:** built for the MFL frame (the page in MFL's iframe, about the window width minus 27px), 1024, 1280 and 1440+. Compact rows of native controls, a dense table, no phone-style cards. At 1024 the filter row and view row each fit on one line.
- **Mobile:** 320 and 375px, with no sideways scroll and nothing clipped.

## 12. Accessibility
- **Controls** are native selects and buttons with visible labels. Toggle buttons use `aria-pressed`; More filters uses `aria-expanded`.
- **Table:** headers are keyboard-sortable (Enter or Space) and announce `aria-sort`. Rows open from the keyboard.
- **Dialogs:** the drawer and the About box take focus on open, keep it inside, close with Esc, and return focus on close.
- **Contrast:** text contrast ≥ 4.5:1 in dark and light themes.

## 13. Words
- **Spelling:** American ("color", "defense", "labeled").
- **Missing values:** "—" with a reason; never 0 for missing.
- **About** holds the definitions, sources, season and weeks, freshness, limitations, and whether the numbers are past or future (everything on Player Stats is past). On-screen notes are one line plus up to three short sentences.
