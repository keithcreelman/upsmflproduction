# Front Office Trade Finder: method and evidence

Model: `site/shared/trade_fit.js` (pure). Tests: `tests/trade_fit_model.test.mjs`. Backtest: `pipelines/etl/scripts/trade_fit_signal_backtest.py`. Umbrella: #1338.

**Framing:** trade-fit *discovery*. It says where each team is strong or short and which swaps would improve **both** lineups. It never says a trade is fair, never proposes, submits or messages anything. Inputs are public MFL data only (rosters, MFL scores, byes, injuries, trade bait, picks); nothing from the commissioner-only draft-guide or auction-value models.

### The unit: points a week in this league's real lineup
1. **Player value** = season-to-date points per MFL-scored week (the released phone definition). Recent form and last season are shown beside it, not mixed in (evidence below).
2. **Best legal lineup** for each team from **its own** active, available players, in the slots **MFL's league settings** define (`deriveSlots`, from `export TYPE=league` → `starters`; Keith 2026-10-21). Each position's minimum is a fixed slot; the remaining starters are Flex slots open to the positions with room under their maximum (a Flex open to QB is Superflex; on defense, IDP Flex). For 74598 that is exactly the released 18-slot model (`site/m/front_office_lineup.js`: QB, 2 RB, 2 WR, TE, 2 Flex, Superflex, K, P, 2 DL, 2 LB, 2 DB, IDP Flex), filled the same way (fixed slots first, then Flex, narrowest first; `tests/lineup_breakdowns.test.mjs` checks slot by slot). If MFL's settings can't be read, the Overview card and the Finder say so; they never fall back to assumed slots. IR, taxi and players ruled Out are not available now. **Owned roster (Keith 2026-10-21):** a free agent fills a slot **only** when no available rostered player can play it, at **replacement level** (the 3rd-best free agent at QB/RB/WR/TE, 6th at K/P, 12th at DL/LB/DB; the Wire forecast's tested setting, `season_sim.py`), and the screens mark that slot `*`. A free agent never starts because he outscores someone on the roster. (Before 2026-10-21 replacement bodies competed for every slot; in Week 6 that credited 32 unowned starters across the league, three of them Real Deal Creel's at RB, K and P. `lineupRule: "replacement"` rebuilds that model for comparison only.)
3. **Strength** at a position = the team's starters there (flex included) in points a week above replacement, **raw**: Σ(starter PPG − replacement-level PPG), 0 = replacement level (Keith 2026-10-21; before that the screens showed it minus the league median). The Overview's Lineup strength (`site/shared/lineup_strength.js`) reads these same lineups, so the Overview's By Position · Above Replacement view and the Finder's matrix show the same values (`tests/front_office_trade_finder.test.mjs` compares all 120 cells).

### Overview: Lineup strength vs the league (Keith 2026-10-21)
Measures, in this order: **PPG** (default; modeled starters' points a week), **Rank** (1st–12th by that PPG), **Above Replacement** (raw: Σ(starter PPG − the applicable replacement-level PPG); never centered on the median, since Rank and Index are the league-relative measures), **Index** (PPG ÷ the league mean × 100).

Breakdowns of the **same** modeled lineup:
- **By Position**: each starter at his natural position (a TE in Flex is TE). Overall, QB, RB, WR, TE, DL, LB, DB, K, P. These are the Finder's numbers.
- **By Lineup Slot**: each starter at the slot he fills: Overall, QB, RB, WR, TE, Flex, Superflex, DL, LB, DB, IDP Flex, K, P (the rows MFL's settings have). It reads the model's own slot assignment; it never builds another lineup. A second TE who starts is Flex; a second QB is Superflex. A slot's replacement baseline is the best replacement-level free agent the slot accepts (Flex: RB/WR/TE; Superflex: QB/RB/WR/TE; `slotBaseline`), so the Overall *above replacement* can differ from By Position's when a Flex or Superflex starter's slot baseline differs from his position's. Overall PPG, Rank and Index are identical in both.
- Raw Above Replacement by slot (`slotBase`): fixed slot = starter PPG − his position's replacement PPG (the 3rd-best free agent at QB/RB/WR/TE, 6th at K/P, 12th at DL/LB/DB); Flex = starter PPG − max(RB, WR, TE replacement PPG); Superflex = starter PPG − max(QB, RB, WR, TE replacement PPG); IDP Flex = starter PPG − max(DL, LB, DB replacement PPG). By Position every starter uses his own position's replacement PPG.
- Each breakdown's rows hold every starter once and add up to Overall. **Biggest need** stays by natural position (the trade to look for).
- **Starter Mix** (`site/shared/starter_mix.js`) is **actual**, not modeled: starters per week by natural position from the lineups submitted to MFL (`weeklyResults&W=YTD`, one read) in completed weeks, plus the Flex, Superflex and IDP Flex composition. MFL's weekly record lists who started, not which slot (`weeklyResults` has `starters` and per-player `status`/`score` only), and points never assign a slot (Keith 2026-10-21). A position's starters beyond its fixed slots are attributed to a Flex row only when exactly one kind of Flex slot accepts that position: a second QB = Superflex (Flex can't take a QB), an extra DL/LB/DB = IDP Flex. Extra RB/WR/TE could be in Flex or Superflex, so they are pooled as **Flexible slots** (Flex + Superflex when not a QB); Superflex shows only its QB share. Any slot assignment by points is a model and is labeled Modeled, never Actual. A week that doesn't fill every slot exactly ("17 of 18 starters", "3 QB — more than the lineup allows", "no lineup", a position MFL doesn't list) is named and left out of the averages, and the card shows "N of M weeks counted".
4. **Need** at a position = how many points a week the team's best lineup gains if it adds the league's median starter at that position. This handles Flex and SuperFlex without special cases.
5. **Surplus** = a healthy player outside the team's best lineup who would start for at least one other team (gain > 0 there).
6. **Fit** for teams A and B: a 1-for-1 swap where A's best lineup and B's best lineup **both** get better, ranked by the smaller of the two gains. A gain is marked `*` when the swap would leave that team a slot no rostered player can fill (`repA` / `repB` name the slot and the replacement's points). Shown with each side's gain, cap room after the swap (MFL formula; over the cap is flagged because the app refuses it), roster count, years left, age, bye overlap, injury chip and trade-bait listing.
7. **Uncertainty:** every fit says whether it still holds on last-4-weeks values; small samples (fewer than half the final weeks) are marked. Kickers and punters are shown but never drive a fit (they don't predict, below).

No weights were chosen by hand: the only settings are the signal (picked by the backtest) and replacement depth (reused, already tested).

### Evidence: which signal identifies current strength? (offline backtest)
Seasons 2022–2025, cut at Weeks 4, 6, 8 and 10 (16 cells per row). Target: each player's rest-of-season points per MFL week (Weeks t+1–17). MFL's own league scores; point-in-time rosters (`rosters&W=t`). "Proj" = RotoWire weekly projections scored with UPS rules (`ev_projections.py`), offense only. Spearman rank correlation, higher is better; best in-app signal in **bold**.

**Players** (the top 2× starter demand at each position):
| Pos | Season PPG | Last 4 | Last 3 | Last season | Proj (RotoWire) | Season + Proj | Season + last season |
|---|---|---|---|---|---|---|---|
| QB | **.58** | .53 | .50 | .32 | .63 | .65 | .53 |
| RB | **.68** | .66 | .64 | .58 | .72 | .75 | .69 |
| WR | **.64** | .58 | .53 | .65 | .67 | .72 | .70 |
| TE | **.48** | .41 | .37 | .54 | .60 | .60 | .58 |
| DL | **.39** | .27 | .24 | .48 | — | — | .52 |
| LB | **.31** | .27 | .21 | .23 | — | — | .31 |
| DB | **.28** | .18 | .13 | .26 | — | — | .31 |
| K | .17 | .15 | .14 | .01 | — | — | .13 |
| P | .20 | .24 | .23 | .13 | — | — | .18 |

**Teams** (each team's starters at the position, predicted vs realized rest of season; 12 teams):
| | QB | RB | WR | TE | DL | LB | DB | K | P | Whole lineup |
|---|---|---|---|---|---|---|---|---|---|---|
| Season PPG | **.62** | .81 | .77 | .60 | .62 | .61 | .74 | .21 | .22 | **.70** |
| Last 4 weeks | .60 | .77 | .75 | .61 | .58 | .63 | .65 | .20 | .21 | .62 |
| Season + last season | .55 | .80 | .81 | .62 | .70 | .65 | .78 | .26 | .15 | .68 |
| Proj (offense only) | .58 | .85 | .83 | .74 | — | — | — | — | — | — |

**Reading it:**
- **Recent form doesn't beat the season.** For players, last 3–4 weeks lose to season PPG at every position except punter; for teams they lose overall (.62 vs .70) and tie within .02 only at TE and LB. Hot streaks are shown as context only.
- **Season PPG is the best signal the app has today** for whole-lineup strength (.70) and the simplest to explain.
- **RotoWire projections are better for offense** (season + projection is best at every offensive position), but the app doesn't serve them yet (they live in the Wire pipeline). Serving them is a follow-up, not part of this build.
- **Last season helps WR/TE/DL early**, hurts QB. Shown in the player panel, not blended.
- **Kickers and punters are close to noise** (.2): never a reason to trade.
- **IDP is the least predictable** (.3–.4 per player, .6–.7 per team): IDP strength is shown, but IDP-only fits are marked lower confidence.

Script: `pipelines/etl/scripts/trade_fit_signal_backtest.py` (public reads cached under `$TMPDIR`; rerun is offline). Matching RotoWire players to MFL is by unique name + position (no D1 crosswalk), so offense projection coverage is partial; that biases the projection rows down, not up.

### Limits, stated on screen
- A fit is "both lineups get better by points a week", not "fair". Contract length, salary, age and picks are shown, not scored.
- Picks are listed (owned, traded, forfeited) but not valued (draft #1337 changes how the grader values them; that is Keith's call).
- Rest-of-season only; dynasty value is out of scope.
- Before Week 1, current-season numbers are never used (standing rule): the Finder says "starts after Week 1" until MFL has posted a week.

## API (window.UPS_TRADE_FIT)
| Function | Returns |
|---|---|
| `deriveSlots(mflStartersNode)` | the league's slots `[{id, label, row, accepts, flex}]` from MFL's settings, or `null` when they can't be expressed |
| `buildLeague({teams, values, freeAgents, slots?, lineup?, lineupRule?})` | `slots` (from `deriveSlots`; the engine's own when omitted, `slotSource` says which), `slotBase` (each slot's replacement baseline); per team: best owned-roster lineup (`replacementSlots` lists slots filled by a free agent), `strength` and `vsMedian` by group (points a week above replacement), `need` by group (points a week from the league's median starter), `surplus` (bench players that would start elsewhere, with each team they help); league `repl`, `typical`, `medians`, `lineupRule` (`"owned"`; `"replacement"` = the old rule, comparison only) |
| `pairFits(model, fidA, fidB, {alt?, capRoom?, limit?, minGain?})` | 1-for-1 swaps where both lineups gain: `gainA`, `gainB`, `mutual`, `repA` / `repB` (slots the swap leaves to a free agent), cap room after each side (`overCap` flag), `idpOnly`, `holdsOnAlt` |
| `teamSummary(model, fid)` | strong groups, needs, top surplus, replacement starts and slots |

`teams[].players[]`: `{pid, pos, status (ROSTER / TAXI_SQUAD / INJURED_RESERVE), chip (released injury chip), salary}`. `values`: `{pid: points per MFL-scored week}`. Players with no MFL week count as 0 and are marked by the screen.
