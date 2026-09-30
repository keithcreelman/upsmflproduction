# Week 3 UPS Center editorial audit (draft, September 29, 2026)

The revised article is `site/wire/articles/2026/2026-wk03-ups-center.html`.
It remains `status: draft`. This audit describes the evidence available at the
Tuesday cutoff; Thursday's Elias check remains outstanding.

## Corrections

- **Discord quotes:** Direct read-only queries to `ups_discord_messages`
  confirmed that Shawn Blake wrote `q6` in `#the-coffee-shop` on September 26
  at 20:32 UTC (message `1553504579205865564`). It refers to a waiver claim
  ending on injured reserve three days later. Replies by Josh Martel (“Hate
  to see it”) and Eric Martel (“Sad story”) never name the player; the MFL
  transaction snapshot does not resolve the subject. Ryan Bousquet wrote
  `q7` in the same channel on September 27 at 17:18 UTC (message
  `1553818040917823590`). It refers to [Josh Allen catching his own tipped
  pass for a one-yard gain](https://www.nfl.com/videos/josh-allen-catches-his-own-pass-and-manages-to-pick-up-positive-yardage);
  Allen was on Blake's Week 3 roster. The archive has no reply linkage or
  surrounding exchange establishing why that joke belongs in the recap, so
  both quotes were removed. Four other contextless chat cards were removed
  for the same reason.
- **Player ownership:** MFL player `16162` (Jahmyr Gibbs) belongs to franchise
  `0004` (Brian Cutting / Pure Greatness) in every daily roster snapshot from
  September 23 through 29. The old Eric Martel desk line borrowed the pack's
  pot-wide “best player” fact; that fact was explicitly labeled *for Brian
  Cutting*. The revised line credits Cutting. All 54 player–owner rows in the
  pack's performance, bust/bargain, XFP and pickup tables were checked against
  the September 27 roster and the MFL player export: 54 matched, none failed.
- **Division results:** Brian Cutting went 2–1; Eric Martel went 3–0; Ryan
  Bousquet went 1–2. Ryan beat Brian Cross by 3.9 and lost to Cutting by 3.8
  and Eric by 16.2. `f.game.01`, `.06`, and `.08` rank first through third in
  margin, but belong to Bear Dunn, Chris Klingenberg, and Eric Mannila beating
  Matt Gerardi, respectively. Bear's own three win margins rank first, sixth
  and thirteenth. The new script names the right winners and opponents.
- **Keith–Cutting game:** Keith won 218.9–212.4. Cutting led offense
  142.3–132.3 and K/P 24.8–18.0; Keith led IDP 68.6–45.3. The IDP advantage
  overcame the other gaps. The article no longer says “defense alone.”
- **Expectations:** Brock Purdy scored 43.3 against a 16.8 pre-kickoff MFL
  projection and 21.7 XFP; Shawn Blake still lost to Bear by 9.4. Drake Maye
  scored 5.3 on 24.1 XFP (18.8 below opportunity); Cutting lost to Keith by
  6.5. Jahmyr Gibbs scored 42.2 on 31.6 XFP for Cutting. Juwan Johnson scored
  31.3 against a 10.7 MFL projection and 19.5 XFP for Eric Martel, whose
  closest win was by 5.9. Jaylen Waddle scored 6.8 against a 14.2 MFL
  projection and 12.4 XFP for Josh Martel. XFP comes from
  `site/wire/data/xfp_2026_wk03.json`; the MFL projections and actual points
  are in the Week 3 pack. XFP estimates opportunity, not an alternate final.
- **Odds:** The old landscape table took “current” odds from the
  through-Week-2 `season_sim_2026_live_wk02.json`, while the adjacent dialogue
  used the through-Week-3 `week_preview_2026_wk04.json`. The revised table and
  dialogue use the latter artifact only (8,000 simulations, September 29
  20:47:39 UTC cutoff), with Weeks 1–3 fixed. The preview's `afterWeekPlayoff`
  values are null: it cannot split a team's *preseason-to-now* odds change into
  banked results versus revised strength. That does not prevent a targeted
  same-cutoff trade counterfactual, described below.

  The named teams in the odds dialogue were checked against completed results
  and the preview's current `switchWhy.lineupPerWeekNow` input:

  | Team | Week 3 | Current lineup input | Supported interpretation |
  |---|---:|---:|---|
  | Bear Dunn | 3–0 | 235.2 | Sweep banked; no isolated result effect |
  | Brian Cutting | 2–1 | 244.3 | Post-trade roster and highest lineup input; trade effect tested below |
  | Eric Martel | 3–0 | 228.7 | Sweep banked; no isolated result effect |
  | Keith Creelman | 2–1 | 218.7 | Two wins banked; no isolated result effect |
  | Josh Martel | 0–3 | 193.7 | Losses banked and post-trade roster included; trade effect tested below |
  | Brian Cross | 1–2 | 200.8 | One win banked; no isolated result effect |

  The trade was recorded at September 29 10:59:28 UTC, before the forecast's
  20:47:39 UTC cutoff. Every `afterWeekPlayoff` field is null.

## Same-cutoff trade test

The original Week 4 model-input cache was retained locally. A compact copy of
its prepared, non-personal simulation inputs is committed as
`site/wire/data/week_preview_2026_wk04_inputs.json`. Running the published
model with those inputs, its original seed (`20260911`) and 8,000 simulations
reproduces **all twelve playoff and title odds exactly**. The same model was
then rerun with only the six traded players returned to their September 28
teams. Weeks 1–3 results, all other rosters, projections, injuries, schedule
and seed were unchanged. The executable reproduction is
`pipelines/etl/wire/trade_counterfactual.py`; the output is
`site/wire/data/trade_counterfactual_2026_wk04.json`.

```sh
python pipelines/etl/wire/trade_counterfactual.py \
  --inputs site/wire/data/week_preview_2026_wk04_inputs.json \
  --preview site/wire/data/week_preview_2026_wk04.json \
  --transactions data/mfl-snapshots/2026-09-29/transactions.json \
  --trade-timestamp 1790679568 \
  --out /tmp/wk04-trade-check.json
```

The September 29 MFL trade sent Lamar Jackson, Andrew Van Ginkel and Tyler
Huntley from Josh Martel to Brian Cutting; Baker Mayfield, Brian Thomas Jr.
and Jonathan Allen went the other way. September 28 and 29 roster snapshots
confirm all six owners and active statuses. Future draft picks also changed
hands, but the season simulator does not price picks.

| Team | No-trade playoff | With trade | Full-rerun effect | No-trade title | With trade | Title effect |
|---|---:|---:|---:|---:|---:|---:|
| Brian Cutting | 84.38% | 93.46% | +9.09 points | 21.80% | 31.96% | +10.16 points |
| Josh Martel | 22.76% | 10.84% | −11.92 points | 1.69% | 0.46% | −1.23 points |

At 40,000 simulations the playoff effects are +8.94 and −11.49 points,
respectively. Holding the *post-trade calibrated noise* fixed instead of
refitting it produces +7.11 and −10.48 points. The article uses the full
official-model rerun, rounded to about +9 and −12 points; the sensitivity
checks show why these should be read as model estimates, not exact causal
effects on an observed day-to-day odds series. It says nothing about whether
the exchange of future picks was favorable.
- **Visual play cards:** The pack's Brock Purdy and Jahmyr Gibbs play cards
  now render with player headshots and correct franchise crests. The highlight
  links point to the [official Purdy video](https://www.nfl.com/videos/brock-purdy-s-best-plays-from-4-td-game-vs-cardinals-week-3)
  and [official Gibbs video](https://www.nfl.com/videos/jahmyr-gibbs-best-plays-from-3-td-game-week-3).
  The [Lions' Week 3 report](https://www.detroitlions.com/news/detroit-lions-gibbs-scores-3-tds-in-win-over-new-york-jets-goff-clark)
  documents the cutback on Gibbs's first touchdown that the Boomer line calls.
  Boomer's spoken section is 388 words; the score calls were checked against
  the same matchup, projection and XFP sources listed above.

## Source and validation limits

The primary internal sources are the committed Week 3 pack, the Week 3 XFP
file, the published Week 3 scores, September 23–29 MFL roster and transaction
snapshots, and the Week 4 preview JSON. The MFL `players` export was queried
read-only on September 29 to map player names to MFL IDs; no downloaded export
is committed. The compact prepared-input snapshot and trade-test results are
committed so the new odds attribution can be reproduced without live feeds.
The Week 4 injury-watch owners were also checked against the
September 29 roster (12 of 12 matched). The article's preview remains
provisional until the Thursday Elias/stat and injury refresh.

The complete article check also reconciled all twelve odds-table rows (owner,
record, playoff odds and title odds) to the current preview, all twenty
projection-versus-actual player rows to the pack, all twelve Week 4 game rows,
and all twelve injury rows. No pack quote appears in the revised article. The
generic prose file was updated too, and its in-memory render passes without
reintroducing those quotes. The hand-built UPS Center HTML is the review copy.

## Independent re-audit (September 29, evening)

A second pass re-derived the Week 4 head-to-head history and the trade test
from primary sources instead of reusing the figures above.

### Keith Creelman v Ryan Bousquet head-to-head

Pulled from `src_schedule` joined to season-specific `src_franchises`
(Keith: 0007 in 2010, 0008 since; Ryan: 0006 in 2010, 0001 since — no
takeovers or shared seasons), then re-derived independently from MFL's own
`TYPE=schedule` export for every season with its real league id. All 24
completed meetings match score for score. `src_schedule` holds one row per
side per game (primary key season/week/franchise/opponent); every pair
mirrors, and `HeadToHead.series()` reads one side only, so nothing is
double-counted. Every regular-season meeting was one game of a multi-game
week; every postseason meeting was the only game that week.

| # | Season | Week | Keith (fid) | Ryan (fid) | Score (K–R) | Winner | Games that week |
|---:|---:|---:|---|---|---|---|---:|
| 1 | 2012 | 2 | 0008 | 0001 | 127.0–191.3 | Ryan | 2 |
| 2 | 2012 | 9 | 0008 | 0001 | 148.3–151.0 | Ryan | 2 |
| 3 | 2020 | 4 | 0008 | 0001 | 216.4–191.7 | Keith | 2 |
| 4 | 2020 | 7 | 0008 | 0001 | 202.9–214.5 | Ryan | 2 |
| 5 | 2021 | 3 | 0008 | 0001 | 189.7–256.4 | Ryan | 3 |
| 6 | 2021 | 7 | 0008 | 0001 | 190.3–209.7 | Ryan | 3 |
| 7 | 2021 | 12 | 0008 | 0001 | 138.2–247.9 | Ryan | 3 |
| 8 | 2022 | 3 | 0008 | 0001 | 205.6–233.7 | Ryan | 3 |
| 9 | 2022 | 7 | 0008 | 0001 | 238.2–218.6 | Keith | 3 |
| 10 | 2022 | 12 | 0008 | 0001 | 204.1–238.0 | Ryan | 3 |
| 11 | 2023 | 2 | 0008 | 0001 | 217.3–247.4 | Ryan | 3 |
| 12 | 2023 | 6 | 0008 | 0001 | 202.3–226.6 | Ryan | 3 |
| 13 | 2023 | 10 | 0008 | 0001 | 153.8–258.2 | Ryan | 3 |
| 14 | 2024 | 2 | 0008 | 0001 | 237.3–257.2 | Ryan | 3 |
| 15 | 2024 | 6 | 0008 | 0001 | 195.9–214.2 | Ryan | 3 |
| 16 | 2024 | 10 | 0008 | 0001 | 260.5–230.1 | Keith | 3 |
| 17 | 2025 | 2 | 0008 | 0001 | 184.8–256.1 | Ryan | 3 |
| 18 | 2025 | 6 | 0008 | 0001 | 159.2–197.5 | Ryan | 3 |
| 19 | 2025 | 10 | 0008 | 0001 | 210.7–214.6 | Ryan | 3 |
| 20 | 2026 | 1 | 0008 | 0001 | 246.9–166.6 | Keith | 2 |

Regular season: **Ryan 16, Keith 4**. The 2026 Week 1 game appears once; the
Week 4 game being previewed is excluded (the preview counts games before
Week 4). Regular-season head-to-head exists only in 2012 and 2020–26; 2010–11
and 2013–19 were all-play seasons, and all-play comparisons are not counted.

Postseason weeks (MFL `playoffBracket` export for each season):

| Season | Week | Bracket | Score (K–R) | Winner |
|---:|---:|---|---|---|
| 2012 | 15 | Toilet Bowl Semi-Finals (consolation) | 158.9–128.6 | Keith |
| 2015 | 14 | UPS Championship, first round (Keith 6 seed at Ryan 3) | 179.1–199.7 | Ryan |
| 2020 | 14 | UPS Championship, first round (Keith 3 seed v Ryan 6) | 197.5–176.6 | Keith |
| 2022 | 16 | 7/8 Game (placement) | 207.1–187.2 | Keith |

Keith is 3–1 in postseason weeks: 1–1 in the championship bracket, 2–0 in
consolation and placement games. The article now says so.

**Other series in the Week 4 table.** All twelve cells were re-derived from
MFL the same way. Ten matched. Two did not, from one ETL classification
error: `src_schedule` and `src_franchise_weekly_score` flag **2012 Week 13**
as a playoff week (`is_playoff = 1`, 24 and 12 rows), and
`src_league_season_meta` records 2012's last regular-season week as 12. MFL's
2012 league settings say `lastRegularSeasonWeek = 13`, and every 2012 bracket
starts in Week 14 or later. The flag comes from the local
`mfl_database.db` `weeklyresults.is_playoff`, which `load_local_to_d1.py`
copies into `src_schedule`. Corrected in the article from the MFL ledger:
Bear Dunn leads Chris Klingenberg **17–5** (not 16–5), and Ryan Bousquet and
Josh Martel are **tied 11–11** (not 11–10). Keith–Ryan is unaffected (their
2012 meetings were Weeks 2, 9 and 15). The D1/local data fix is prepared but
**not applied**: it changes 2012 regular-season records wherever the site
reads those tables, and a D1-only fix would be undone by the next
`load_local_to_d1.py` upsert unless the local row is fixed first. The pack's
`t.pv.games` still carries the two stale cells until the data is corrected and
the pack rebuilt. (2010 also looks mismatched against MFL's settings, which say
`lastRegularSeasonWeek = 16`, but 2010's brackets start in Week 14; that is a
2010 settings artifact, and D1's flags are right.)

### Trade test

- **Transaction.** Snapshot and live MFL `TYPE=transactions` agree: TRADE at
  1790679568 (September 29, 10:59:28 UTC). Josh Martel (0007) gave 13593
  Lamar Jackson (QB), 14249 Andrew Van Ginkel (DE), 14789 Tyler Huntley (QB)
  and his own 2027 4th; Brian Cutting (0004) gave 13590 Baker Mayfield (QB),
  16618 Brian Thomas Jr. (WR), 13208 Jonathan Allen (DT), his own 2027 1st and
  2nd, and 0003's (Matt Gerardi's) 2027 2nd. Names resolved via MFL's
  `TYPE=players` export.
- **Rosters.** The saved inputs match the September 29 roster snapshot for
  all 12 teams (taxi players excluded by design; IR players kept, with
  `absences()` zeroing the weeks they miss). September 28 → 29, the two teams
  changed by exactly the six players plus two other moves: Josh placed De'Von
  Achane on IR at 10:46:32 UTC (before the trade), and Cutting dropped Tommy
  DeVito at 11:09:39 UTC (after it). No other 0004/0007 transaction through
  22:34 UTC. Both moves are held as they happened; restoring DeVito to
  Cutting's no-trade roster leaves his lineup (235.11 a week) and every
  probability unchanged.
- **Reproduction.** The saved inputs reproduce all 36 published playoff,
  division and title probabilities to four decimals. The script now checks
  division too.
- **Counterfactual.** Rerun independently: Cutting 84.38% without / 93.46%
  with (+9.09); Josh 22.76% / 10.84% (−11.92); titles 21.80% / 31.96% and
  1.69% / 0.46%. 40,000 runs: +8.94 / −11.49. All as published.
- **Noise.** `season_sim.fit()` sizes the season-long shock (`sigma_s`) so the
  simulated league's spread of ending all-play % hits a fixed historical
  target. The trade widens the projected strength gap, so the refit shrinks
  `sigma_s` from 12.23 (no trade) to 10.83 (with trade). Holding the published
  noise fixed gives +7.11 / −10.48 (40,000 runs: +7.19 / −10.11). The refit
  also moves uninvolved teams one to two points (Brian Cross −1.7, Eric
  Mannila −1.7, Matt Gerardi −1.7, Eric Martel +1.6); holding noise fixed keeps
  them within about half a point, except Josh's division rivals Keith Creelman
  (+3.4) and Ryan Bousquet (+1.1). So the direction and story hold, but about
  two points of Cutting's nine are the refit, not the rosters. The article
  now gives the range (about 7–9 for Cutting, about 10–12 for Josh).
- **Seeds.** Five extra seeds at 8,000 runs (`seedCheck` in the result JSON):
  Cutting +8.5 to +9.4 (full) and +7.0 to +7.6 (fixed); Josh −11.0 to −12.0
  and −9.5 to −10.9.
- **Language.** "Was 84.4% without the trade", "rises", and "falls … after
  the deal" read as observed movement; rewritten as a same-cutoff comparison
  ("with the trade … without it"), stated as a model comparison and not an
  observed odds move. The picks are now named, with the note that the
  simulator gives them no value.
