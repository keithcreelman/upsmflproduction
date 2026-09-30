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
