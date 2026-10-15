# Stats UI contract

The shared rules for UPS Stats screens. They come from the released mobile Stats work (#1238, #1246, #1257, #1270) and Keith's 2026-10-15 notes on the desktop Stats Workbench. Each screen applies them in its own layout: the phone app is built for 320–375px, the desktop page for the MFL frame and 1024 / 1280 / 1440px. Tests: `tests/stats_ui_contract.test.mjs` (desktop) and `tests/mobile_stats_players_review.test.mjs` (mobile).

## 1. Order on the screen
1. **Heading and one short sentence** on what the page shows.
2. **Primary controls, in this order:** Season, Window, Position, Stat group.
3. **Search and sort.**
4. **Source and freshness band:** the exact weeks each source covers, and when it was read.
5. **The player table.**
6. **Player detail:** a side drawer or panel. The table stays where it was.
7. **About:** definitions and sources.

Uncommon choices go behind **More filters**: fantasy team, adding a second season, custom columns, value filters, heat, scatter, compare and CSV.

## 2. Position and stat groups
- **Positions:** QB, RB, WR, TE, DL, LB, DB, PK, PN. The desktop page adds Flex (offense) and IDP Flex.
- **Stat groups:** a position shows one group at a time. Fantasy points comes first and is the default. The rest are, as the position has them: Usage, Passing, Rushing, Receiving, Red zone, Next Gen, Boom/Bust and consistency, IDP (tackles, pass rush, coverage), Kicking or Punting, and Schedule context (Sched Δ and Opp ±%). xFP comes later (#1283).
- **Switching** position or group keeps the season, window and search. Switching group keeps the position.

## 3. Columns
- **Limits:** a group has at most 8 numbers on desktop and 4 on mobile. Points per game appears only in Fantasy points, never repeated beside box-score groups.
- **Player column:** on desktop it is frozen. The page never scrolls sideways; a wide table scrolls inside its own region.
- **Every column has a one-line definition** (its header tooltip and an About entry). Short labels: Tgt, RecYd, Snap%.

## 4. Player identity and rows
- **Who he is:** the player's name, with his NFL team and his fantasy owner (or FA) beneath it. Flex tabs add his position.
- **Opening a player:** the whole row opens his detail, and the name is a real button (keyboard: Tab, then Enter). Closing returns focus to the row.
- **Owner unknown:** a player whose owner couldn't be confirmed says "owner unknown", never "FA".

## 5. Sorting
- **Every number column sorts:** high to low first, then low to high. "—" sorts last both ways.
- **Showing the sort:** the active column shows ▼ or ▲ and carries `aria-sort`, and a Sort control says the same thing in words.
- **Defaults:** each group has its own default. Changing group keeps a sort column that is still visible.

## 6. Source weeks and freshness
- **The band names every source the visible columns use,** with its exact weeks, for example "MFL scoring: Wks 1–5 final" or "nflverse box scores: through Wk 5".
- **The read time is stated.** Read times never appear in rows.
- **Another season is never substituted for the one asked for.** No data for a season shows "—" with the reason.

## 7. States, each said in words
| State | What the screen does |
|---|---|
| Loading | "Loading 2026 WR…" in the table area; no stale rows under it |
| Unavailable | The source and the reason; its cells read "—" with a tooltip |
| Stale | "May be behind: last refreshed …" for that source |
| Partial week | A week in progress is named as **in progress**, never shown as final |
| Small sample | Marked **small sample** on the cell or column, distinct from partial |
| Mixed seasons | The band says the seasons are **added together** and names each season's weeks |

## 8. Color
- **Color only where it encodes a stated scale,** explained in About (for example the optional heat map, or a rank tier).
- **Sched Δ and Opp ±% are never colored.** They describe a schedule. No easy/tough wording and no forecast wording, anywhere.
- **Minus signs** are real minus signs (−2.1).

## 9. Layout
- **Desktop:** built for the MFL frame (the page in MFL's iframe, about the window width minus 27px), 1024, 1280 and 1440+. A dense table and a compact control bar are fine; no phone-style cards.
- **Mobile:** 320 and 375px, with no sideways scroll and nothing clipped.

## 10. Accessibility
- **Controls** are native selects and buttons with visible labels. Toggle buttons use `aria-pressed`, and More filters uses `aria-expanded`.
- **Table:** headers are keyboard-sortable (Enter or Space) and announce `aria-sort`. Rows open from the keyboard.
- **The drawer is a dialog:** it takes focus on open, closes with Esc, and returns focus on close.
- **Contrast:** text contrast ≥ 4.5:1 in dark and light themes.

## 11. Words
- **Spelling:** American ("color", "defense", "labeled").
- **Missing values:** "—" with a reason; never 0 for missing.
- **About** holds the definitions. On-screen notes are one line plus up to three short sentences.
