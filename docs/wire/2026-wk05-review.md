# UPS Center Week 5: the analytical rebuild (review record)

**Status:** the draft for Keith's review on PR #1244.
- **Not merged, published or announced.**
- **No Discord post.** Nothing in this work posts anywhere.
- **No production writes.** D1 was read only, about 7.2k rows in total.

**Brief:** `UPS_Wire_Week5_Remote_Session_Brief.md` (Keith, 2026-10-13).

**Built:** 2026-10-13 to 10-14 from data pulled about 01:55–01:57 UTC on Oct 14 (Tue Oct 13, ~9:55 PM ET). Week 5 is final, Monday night included.

---

## 1. Audit

### 1.1 The automated eight-section format

The automated draft is fact-safe: 176 claims, every one checked against its source. But it reads as a recap of one week:
- **Equal weight everywhere.** Every game and every recurring segment gets the same weight, whatever matters most.
- **No season-level thesis.** It opens on the week's high score.
- **No playoff odds,** and nothing marks them as missing.
- **Single-week players only.** A player appears only as a high scorer or a projection bust or bargain:
  - Nacua's 24 targets and Gibbs' 40.9 show up without context;
  - Bowers and Smith-Njigba could vanish in a quiet week;
  - Warren's role change has no "why" and no "what next".
- **The standings table** shows order, not direction: who is rising, cooling, unlucky or concentrated.

### 1.2 Why Week 4 had no playoff odds

Four things combined. None was missing source data.

1. **A stale manual job.** `season_sim.py --through-week N` and `week_preview.py` are run by hand; Keith chose no cron on 2026-09-15.
   - The only committed live snapshots are `season_sim_2026_live_wk01.json` and `..._wk02.json`, generated 09-23.
   - Week 3's published odds came from `week_preview_2026_wk04.json` (through Week 3), a by-product of the hand-run Week 4 preview.
2. **A silent fallback in the pack builder.** `weekly_recap.load_live_forecast()` searches backward for the newest snapshot and adds no staleness warning. The Week 3, 4 and 5 packs all cite "season_sim.py --through-week 2".
3. **A publishing decision.** The Week 4 issue was a catch-up finished on Thu Oct 8, the day Week 5 kicked off. No new forecast was run, and the issue said so in one line ("No playoff odds and no Week 5 preview in this issue") rather than print the Week 2 numbers.
4. **A builder omission.** The scheduled builder (`ups_center_issue.py`) has no forecast segment, so the automated Week 5 draft had no odds and no editor box saying so.

Week 5 fixes the content. The permanent safeguard is proposed separately (§6).

### 1.3 Week 5 table of contents (as built)

| # | Segment | Job |
|---|---|---|
| 1 | The Big Story | Thesis: a third of the season is gone and the league has split into three groups |
| 2 | Playoff Picture | Current odds; the four biggest moves since Week 3, with reasons; Week 6 stakes; how the odds are made |
| 3 | Heat Check | Full season vs Weeks 3–5; trend labels; lineups and luck |
| 4 | Who Is Winning Weeks? | Edge over replacement, matchup swings, concentration |
| 5 | Player Stories | Four deep dives |
| 6 | The Survival Line | What a Week 5 position has meant, 2017–2025 |
| 7 | Week 5 in Brief | Boomer, every game (division desk), plays of the week: the automated draft's validated segments |
| 8 | Above and below expectations | The automated list, trimmed to three a side |
| 9 | Coffee Shop Talk | Kenny, with verbatim, linked quotes |
| 10 | Elias changes | EDITOR REVIEW until Elias posts |

Words: about 4,060. Roughly 53% season arc, 24% player stories, 23% recap, personality and recurring segments; the brief asked for about 50/30/20.

### 1.4 Player-story scan: candidates, ranked

**Method.** Every player on a UPS roster in Weeks 1–5 (446) was joined to nflverse usage. The 446 map to nflverse with no misses, through the ff ids MFL→gsis/pfr.

**Measures:**
- edge over replacement (started points minus the average of the six rostered players just outside the league's starting pool at that position that week);
- matchup swings;
- share of the team's points;
- snap, carry and target changes between Weeks 1–2 and 3–5;
- inactive weeks and returns;
- single-game extremes;
- injury reports.

**Ranking criteria:** impact on a UPS team, size of the role change, persistence, history, what happens next, and evidence.

| Rank | Candidate | UPS team(s) | Evidence | Used |
|---|---|---|---|---|
| 1 | Warren / Dowdle (PIT) | Bousquet; Blake | Warren's snaps went from 37%/71% to 90/97/87% and his share of RB carries from 21 of 38 to 49 of 54. Dowdle: toe, Out Weeks 3–4, Questionable and inactive Week 5. Two matchup swings for Bousquet. Return unsettled. | Story 1 |
| 2 | Gibbs and Cutting's lineups | Cutting | League-top edge (+125.0). 161.7 through 5 team games, 3rd of 3,149 RB starts since 1999. Cutting is 6–7 but 28.7% for the title, leaves 54.0 a week on his bench, and has 5 losses his best lineup wins. DET bye in Week 6. | Story 2 |
| 3 | Smith-Njigba and Bowers | Bear | JSN: 156.5 (154.5 box), 2nd of 4,682 WR starts. Bowers: 90.6 in 3 games back, best TE run of 2026, 29th of 2,685 TE seasons. Bear is 42–2 against the field since Week 1. | Story 3 |
| 4 | Nacua's 24 targets (and Lamb 21, Nabers 20) | Creelman; Mannila | 2nd-most targets in a regular-season game, in seasons with target data. Next game averaged 9.3 targets (39 cases). | Story 4 |
| 5 | Josh Martel's collapse: Achane ACL (IR), Caleb Williams out 3 games, Lamar Jackson traded | J. Martel | Odds 12.4% → 2.0%; 3–19 against the field in Weeks 4–5 | In Playoff Picture + Survival Line |
| 6 | Henry trade to Blake (Oct 6) | Blake; Cross | 22.6 in his first game; Blake +21.2 | In Playoff Picture |
| 7 | Jaxson Dart, IR (meniscus) | Mannila | Out for the regular season per MFL; biggest modeled absence for Mannila | Not used: no new role story yet |
| 8 | Ollie Gordon II after Achane's injury | Cross | MIA RB snaps 7/19 → 84/56/65% | Not used: low UPS stakes (2.5%) |
| 9 | Braelon Allen | Bousquet | NYJ snaps 40/31/52% → 94/86%, 24 carries in Week 5 | Not used: 2 weeks, benched until Week 4 |
| 10 | George Kittle | Blake | Snaps 46/48% → 85/91/92% | Not used: production flat |
| 11 | Christian Watson, 4 matchup swings | Creelman | Tied for most in the league | In Who Is Winning Weeks |
| 12 | Tetairoa McMillan, 49.8 and 16 targets in Week 4 | Bear | One week | Not used |
| 13 | Drake Maye, 51.8 | Cutting | One week | In Week 5 in Brief |

### 1.5 Supportable analyses

- **Heat Check:** all inputs from MFL `weeklyResults`. The derived standings equal MFL `leagueStandings` for every team (asserted).
- **Survival Line:**
  - Seasons rebuilt from D1 `src_franchise_weekly_score` / `src_schedule` through Week 5 only.
  - Playoff field from `/api/playoff-bracket` (path ≠ HAWK, six teams a season).
  - The comparable era is 2017–2025, today's four-division-plus-two-wild-card format.
  - Thirteen head-to-head games by Week 5 only from 2021 on.
- **Historical player comparisons:** 2026 UPS rules applied to nflverse box scores, 1999–2026. The scorer reproduces MFL's 2026 scores exactly in 81% of 952 player-games and within 1 point in 91%. Box scores omit the 50-yard TD bonus and return yards. Target data is missing for 2003–2008.

### 1.6 Unsupported or ambiguous: left as editor items or stated limits

- **Elias:** official Week 5 changes not posted yet. EDITOR REVIEW in the issue.
- **Dowdle's Week 6 status and the post-return split:** not knowable before Wednesday–Friday practice reports. The issue states the uncertainty and the markers to watch.
- **Route participation:** not available for 2026 in our sources (nflverse participation stops at 2025; D1 `nfl_player_routes_weekly` has no 2026 rows). Role changes use snaps, carries and targets.
- **Single-game win chances** have not been backtested; labeled rough.
- **Projection source:** published odds use RotoWire offense (backtested better; `docs/wire/dynamic_forecast_model.md`). On MFL offense, four teams' playoff odds move 10+ points. Stated in the method box.
- **Coffee Shop:** Kenny's lines are editorial. Five quotes, verbatim, all passing `chat_exclusions`. Needs Keith's read.
- **The automated "landscape:preview-audit" item is moot.** No Week 5 preview was published, so the segment that graded it is gone.

### 1.7 Opening (as built)

> Thirteen games into a 37-game season, Rich, the league has split into three groups. At the top, Bear Dunn. He lost eight of eleven all-play games in Week 1. Since then he is 42–2 against the field, and our forecast gives him a 99.5% chance at the playoffs and 83.1% at a first-round bye.

---

## 2. The forecast used

`season_sim.py --through-week 5`, the official refresh-only model, `site/wire/data/season_sim_2026_live_wk05.json`:
- 10,000 runs, seed 20260911, k = 0.7;
- inputs fetched 2026-10-14 01:56:56Z, shared with `week_preview.py --week 6` (8,000 runs). The two agree within 0.4 points on every team.

The change baseline is the odds published in the Week 3 issue (`week_preview_2026_wk04.json`, cutoff Wed Sep 30 8:22 AM ET).

---

## 3. Reconciliation (Phase 3)

**Builder ledger.** 533 claims registered.
- A number on a new segment that is not in the ledger fails the build.
- Reused segments (desk, plays, above/below, Elias, the post table, Boomer's lines) are checked against the automated draft's 176 validated claims.
- Superlatives are asserted in code: best three weeks, most bench points, largest swings, most-concentrated teams, closest game, lowest score.

**Independent verifier:** 60 checks, 0 failed. It shares no code with the builder.

| Area | Checks |
|---|---|
| Status | Draft in the article and in `index.json` |
| Standings | 12 All-Play records and the 3–10 teams, from MFL `leagueStandings` |
| Odds | 12 playoff odds and changes, read straight from the forecast files; run size and cutoff |
| History | Re-derived from the D1 rows and the bracket API with separate code: AP rank 1–2 → 18 of 18; 11–12 → 3 of 17; ≤3 wins → 0 of 8; 2017 Bear 11–44 made it |
| Players | Warren's carries via `play_type=run`; only Brandon Marshall's 28 above 24 targets; the 2026 20-target games; Dowdle's report trail and Week 5 inactive; the DET Week 6 bye; MFL IR records (Achane, Reed) |
| Ownership at the time | Henry: Cross Weeks 1–4, Blake Week 5. Bowers: benched Week 3, started Weeks 4–5. |
| Quotes | 5 quotes verbatim against the archived message, channel matches, none excluded. Ruled-out message ids absent. No never-material or private terms in the reader-visible text (the only pattern hit is "ACL" from Achane's IR record). |
| Highlights | Links identical to the automated draft's verified ones |
| Code paths | `season_sim.py`, `week_preview.py`, `ev_projections.py` contain no INSERT/UPDATE/DELETE/POST |

**Layout** (Playwright, file render):
- No horizontal page scroll at 320px or 375px (WebKit, iPhone user agent) or at 1280px desktop.
- Every new table fits at 320px. The automated draft's two tables scrolled sideways; they now fit too.
- The PDF is 21 pages, with headings kept with their text and short tables kept whole.

---

## 4. Open editor items

1. **Elias Week 5:** due Thursday. The scheduled job treats this branch as editor-owned now and will comment the changed claims instead of rebuilding. Apply them by rerunning the build.
2. **Coffee Shop:** Kenny's five lines and quotes need Keith's approval.
3. **Dowdle:** if Wednesday–Friday reports settle his status before publication, update the Pittsburgh story's last two lines.
4. **Thursday-night game.** Week 6 starts Thu Oct 15 8:15 PM ET (SEA at DEN). Odds are as of Tue 9:56 PM ET; publishing after kickoff would make the "Week 6 stakes" list partly stale.

---

## 5. Changes from the automated draft (#1244, f7afdd52)

- **New:**
  - The Big Story (season thesis);
  - Playoff Picture (current odds, moves since Week 3 with reasons, Week 6 stakes, method box);
  - Heat Check (two views, labels, lineups and luck);
  - Who Is Winning Weeks (edges, swings, concentration);
  - Player Stories (four);
  - The Survival Line (history with samples).
- **Kept, shortened:**
  - Boomer (three lines);
  - the division desk game deck;
  - plays of the week (same verified links);
  - above/below expectations (three a side, same capture-time note);
  - the Coffee Shop post table.
- **Replaced:** the opening desk (thesis instead of the high score) and the league landscape table (folded into Heat Check and Playoff Picture).
- **Filled:** the Coffee Shop now has Kenny's lines with five verbatim quotes. The automated draft left it as an editor box.
- **Data added to the branch:** `site/wire/data/season_sim_2026_live_wk05.json` and `site/wire/data/week_preview_2026_wk06.json`.

---

## 6. Proposed permanent builder change (separate; not in this PR)

### A. Playoff odds can never silently disappear

1. **Run the forecast in the job.** `ups_center_auto.run_week` runs `season_sim.py --through-week N` and `week_preview.py --week N+1` after the D1 == MFL gate, and commits both files to the draft branch.
2. **Add a forecast segment to `ups_center_issue.py`.** It shows playoff, division, bye and title odds, the change since the last published odds, and the model and cutoff box.
3. **Add a freshness gate.** If the forecast is missing, or `throughWeek` ≠ N, or it was generated before the week's final game:
   - render the blocker `EDITOR REVIEW — CURRENT PLAYOFF PROBABILITIES UNAVAILABLE`;
   - mark the draft not publishable.
   `ups_center_validate` fails a draft with no odds segment and no blocker.
4. **Stop the silent fallback.** `weekly_recap.load_live_forecast()` returns staleness and writes a pack warning instead of falling back silently.
5. **Tests:** missing forecast blocks; stale forecast blocks; a fresh forecast renders with its cutoff; changes are computed against the last published issue.

### B. Dynamic story discovery

1. **`ups_center_stories.py`.** It runs the §1.4 scan on one cached dataset (MFL `weeklyResults`, nflverse stats, snaps, injuries and pbp; no D1 per player):
   - edge over replacement and matchup swings;
   - role changes;
   - returns and teammate absences;
   - usage outliers;
   - concentration.
   It ranks candidates by the six criteria and writes them into the draft as an EDITOR REVIEW candidate list with evidence, not prose.
2. **History helpers.** First-N-team-game comparisons under the current UPS rules, with the scorer validated against MFL every run, plus the regression rates.
3. **Deterministic Heat Check and Survival Line segments** in the automated builder.

---

## 7. Reproducing this build

The scripts are in `docs/wire/2026-wk05/build/`. Data caches are not committed; `pull.py` re-pulls them in about 1 minute and reads about 7.2k D1 rows.

1. `pull.py`, then the nflverse pulls (nflreadpy) as noted in `facts.py`.
2. `teams.py`, `survival.py`, `players.py`, `scan.py`, `hist_players.py`
3. `facts.py`, then `facts_hist.py`
4. `build_wk05.py`
5. `verify_wk05.py`

The Coffee Shop quote check reads the local sources snapshot in `~/Library/Caches/upsmfl-ups-center-auto/`; raw chat stays off the repo.

---

## 8. Revision 2 (Keith's writing review, 2026-10-14)

Keith's verdict: "The new analysis is much better, but the writing quality and host chemistry are not ready." It stays a draft.

### 8.1 Division probabilities: investigated, one real bug fixed, tests added

**The totals.** Every simulated season assigns exactly one division winner (`dws` takes one team per division). So each division's raw title odds sum to exactly 1, which `test_season_sim_divisions.py` checks on the published file. The trio Keith summed (Bousquet, Creelman, Eric Martel) spans two divisions:
- **Maddie Mondays:** Creelman 82.2 + Bousquet 16.2 + Josh Martel 1.6 = 100.0.
- **Outlast PG Time:** Eric Martel 51.5 + Cutting 48.3 + Cross 0.2 = 100.0.
- The old table showed "E. Martel" and "J. Martel" without divisions. The new table groups by division and prints each total.

**The bug.** The division tiebreak skipped head-to-head. MFL's 2026 order is `PCT, DIVPCT, H2H, PTS, ALL_PLAY_PCT`, but `_div_winner_key` went from division record straight to points.
- **Fixed:** `season_sim.division_winner()` applies MFL's order, with head-to-head among the teams still tied.
- **Invariant:** `simulate()` now raises if any season crowns other than one winner per division.
- **One rule in one place:** `week_preview`'s hook receives `simulate()`'s own winners instead of re-deriving them with the old rule.

**Rerun on the identical cached inputs** (fetched 2026-10-14 01:56:56Z):
- division odds moved by at most 1.4 points (Eric Martel 50.2 → 51.5, Cutting 49.6 → 48.2, Creelman 83.0 → 82.2, Bousquet 15.5 → 16.2);
- playoff odds moved by at most 0.67 points (Bousquet 19.2 → 19.8), shown as 0.7 in the article (the division figures above are raw values);
- the forecast and the preview now run the same 10,000 seasons, so the table and the Week 6 scenarios are the same simulated seasons.

**Display rule.** `season_sim.display_percentages()` uses largest-remainder rounding: round every value down, then give the leftover tenths to the largest remainders, ties by key. It applies to division and title odds, so every division shows exactly 100.0% and the league's title odds total exactly 100.0%. It is never used to hide a raw sum that is not 1.

**Tests (`pipelines/etl/wire/test_season_sim_divisions.py`, 20 checks, in `check-wire.yml`):**
- the tiebreak order, rule by rule;
- 5,000 random tie-heavy states, each with exactly one winner;
- every one of 3,000 simulated seasons crowning exactly one champion per division;
- a scripted season where points-first and MFL's order disagree, and MFL's wins;
- the published Week 5 totals;
- the rounding rule.

### 8.2 Bowers' Week 3 lineup: verified from MFL, claim kept

Source: MFL `export?TYPE=weeklyResults&L=74598&W=3&JSON=1`, re-fetched 2026-10-14, franchise 0009 (Bear Dunn).
- **Week 3:** in all three Week 3 matchups (vs 0003, 0002, 0010), Bowers (16641) is `status: nonstarter`, 36.0, with `shouldStart: 1`. He is not among the 18 starters. Sam LaPorta started at tight end and scored 9.1; Mike Gesicki (14.4) was also on the bench. Bear won all three games.
- **Weeks 4 and 5:** Bowers is a starter.
- **"Better run"** means each tight-end season's best three straight games played, scored by 2026 UPS rules from box scores, 1999–2026.

### 8.3 Historical statements rewritten

- **Bottom three by All-Play:** "Since 2017, only 4 of the 24 teams ranked 10th through 12th in All-Play after Week 5 went on to make the playoffs."
- **The paired comparison** was redone as same-season pairs: every 2020–2025 playoff team against every non-playoff team from the same season, 216 pairs, standings after Week 5, ties counting half.
  - All-Play 88%, points 86%, record 85%.
  - The earlier version pooled across seasons (88/87/85).
- **Whitman's Week 6 numbers** are a scenario, stated as one: 39.8% today, 32.1% in the simulated seasons where he loses to Cutting, 51.3% where he wins.

### 8.4 Coffee Shop attribution

The quote "Forced to start this week. Bryce and Mahomes on bye" was posted by **Shawn Blake** (message 1558921157116305433), explaining Matt Gerardi's situation. It was not posted by Gerardi. The issue attributes it to Blake.

### 8.5 Verification after the rewrite

- **Builder:** 571 claims registered; every visible number is registered or comes from a reused validated segment. About 5,141 words on the page.
- **Independent verifier:** 75 of 75 pass. New checks:
  - the division totals as printed;
  - the forecast and preview agreeing to 4 decimals;
  - the Whitman scenario;
  - Bousquet 4–9 with a replacement back;
  - Pittsburgh early-down splits;
  - no Steelers back with a carry inside the 5;
  - the same-season pair rates;
  - Klingenberg's zero posts;
  - Blake's two-quarterback roster.

### 8.6 Independent editorial pass and layout

**Editorial pass.** One agent read only for clarity, chemistry, humor, transitions and whether each section says why its information matters. Applied:
- the handoffs now carry the story forward;
- a repeated "sturdy" line was cut;
- quote punctuation was fixed;
- the opening now names each contender's exposure;
- "close to a record" became "almost never happens" (one game since 1999 beats it).

Not applied: one inference about Dowdle's role that the play-by-play does not support.

**Layout.** Playwright at 320 px and 375 px (WebKit) and 1280 px (Chromium):
- no page-level horizontal scroll;
- every table fits its box.

The heat table's "Reading" label now sits under each team name, and the full-season All-Play record is in parentheses, so the table fits at 320 px.

## 9. Revision 3 (Keith, 2026-10-14): Coffee Shop folded in, signature calls, Week 6 as record plus score

### 9.1 The Coffee Shop segment is gone; its five receipts sit in their stories

Each receipt follows the same sequence:
1. the situation;
2. the quote, verbatim and linked;
3. a host reaction;
4. what happened next and why it matters.

All five are read by Kenny.

| Receipt | Now in | Story |
|---|---|---|
| Blake, "First week was a fluke…" | Playoff Picture | Bear's 99.5%: "Shawn got there in one sentence. The computer needed 10,000 seasons." |
| Eric Martel, "🙏 for a pick or fumble 6" | Heat Check | Martel's slide and Monday night |
| Blake on Gerardi, "Forced to start…" | Heat Check | Gride's collapse |
| Josh Martel, "Not sure I have an all play win…" | Survival Line | why his season is nearly over |
| Bear, "Rebuild or become Hawks in perpetuity." | Survival Line | Josh vs the Hawks in Week 6 |

**Correction to the brief's framing (Eric Martel).** Monday night had one game, Bills at Rams. Eric had no starters in it, so HammerTime led the Hawks **190.7 to 137.4** going in.
- Klingenberg still had Stafford (39.3), Kyren Williams (19.4) and Dalton Kincaid (4.2).
- At 11:31 PM ET, when Eric posted, the game was tied in overtime.
- Stafford went 40 of 54 for 383 yards and three touchdowns, with no interceptions and no lost fumbles.
- The Hawks won by 9.6.

So Stafford finished **Klingenberg's comeback**; he did not end Eric's. The article tells it that way.

The masthead now reads "Kenny Mayne with receipts from the league chat". The Survival Line moved to the end and closes with a sign-off, so the closing segment is a real segment. The post-count table is gone.

### 9.2 Signature calls (restraint rule)

| Host | Phrase | Where it lands |
|---|---|---|
| Stuart | "He must be the bus driver, because he is taking this league to school." | Bear's 42–2 since Week 1 |
| Stuart | "As cool as the other side of the pillow" | Stafford's 40-of-54, no-turnover night that beat HammerTime |
| Stuart | "Boo-yah." | Nacua's 24 targets and 41.7 points |
| Boomer | "Look at him go!" | Gibbs: 151 rushing yards on 25 carries, 2 TD |
| Boomer | "He could… go… all… the… way!" | Warren's 80-yard catch-and-run touchdown |

The rest of the restraint rule:
- **Rich** has no catchphrases: clarity and dry reactions.
- **Kenny** has none: receipts and understated punchlines.
- **No phrase repeats.** Every line still makes sense with the phrase deleted.
- **"Rumblin', bumblin', stumblin'" is not used.** nflverse play-by-play does not record broken tackles, so no run in the data earns it.

The verifier enforces the budget: at most one use of each phrase, by its own host; two or three phrases per host; none from Rich or Kenny.

### 9.3 Week 6 as two numbers: head-to-head record and league scoring rank

**Rules confirmed against canon §F.1 and MFL standingsSort 2026:**
- division titles go by record (PCT, DIVPCT, H2H, PTS, All-Play);
- the two wild cards and seeds 3–6 go by All-Play %, then overall record, then points;
- the top two seeds are division winners.

So which number matters depends on the team's path.

**The simulator supports it.** `week_preview.py` now records, inside the same 10,000 seasons as the published odds, each team's Week 6 head-to-head wins and its league scoring rank (1–12), with playoff, division and bye counts (`weekScenarios`).
- The cells reproduce every team's published odds exactly. Asserted in the builder and in the verifier.
- Re-running on the same cached inputs and seed left every forecast number byte-identical. Two diagnostic lists change tie order between runs, as they always have.

**Comparison rule:**
- a rate is printed only on at least 100 simulated seasons;
- a comparison is stated only when the gap exceeds two standard errors;
- "about the same" is stated only when it is within two.

**What the data supports:**

| Team | Division share of playoff seasons | 3–0, middle-six score | 2–1, top-three score |
|---|---|---|---|
| Klingenberg | 5% | 57.6% | 74.8% |
| Whitman | 35% | 45.3% | 54.1% |
| Bousquet | 82% | 33.3% | 35.4% (same within noise) |
| Mannila | 10% | 11.2% | 22.1% |
| Gerardi | 31% | 10.6% | 18.3% |

- **Josh Martel:** 80% of his playoff seasons come from the division.
  - By record: 3–0 is 6.7%; 0–3 is 0.8%.
  - By score at 3–0: a top-three score is 7.9%; a middle-six score is 3.7%.
  - The full grid is in the article.
- **Not supported:** the brief's example comparison, a 1–2 week with a top-three score against a 3–0 week with a bottom-five score. For Josh those weeks occur in 28 and 4 of 10,000 seasons, too few to price; the table says "rare" and gives the count. Both are structurally rare: a top-three score loses only to the other two top-three teams, and a bottom-five score sweeping needs three lower opponents. Pricing them would need a larger dedicated run, which is a possible model enhancement.
- **Why a big week helps beyond All-Play:** in the model each simulated season carries a season-long strength shock. A top-three week is partly evidence of a stronger team, so the weeks after it go better too. The article says this in one line.

**Single-game splits that remain:**
- the Whitman–Cutting split Keith approved in revision 2, now followed by Whitman's whole-week framing;
- the opening's "three of the six Week 6 games most likely to reshape the field".

Every Week 6 outlook now names all three opponents and uses record plus score:
- Klingenberg;
- Bousquet;
- Whitman;
- Keith Creelman (sweep 92.9%, swept 74.5%);
- Josh.

### 9.4 Verification
- **Builder:** 673 claims registered; the numeric audit passes. New asserts cover:
  - Monday-night lineups by NFL team;
  - the overtime timing;
  - Stafford's box score;
  - Gerardi's two busts from the validated projection segment;
  - Gibbs' rushing line;
  - Warren's 80-yard catch;
  - the Week 6 opener;
  - every scenario comparison.
- **Independent verifier:** 108 of 108 pass, 33 of them new. The new checks cover:
  - receipt placement;
  - the masthead;
  - the catchphrase budget;
  - the Monday-night lead from raw MFL;
  - the Stafford line;
  - the 11:31 PM overtime tie;
  - Gerardi's 17.6;
  - Gibbs;
  - scenario cells that partition the published seasons;
  - every printed scenario rate and the Josh grid, recomputed from the raw cells.
- **Layout:** no overflow at 320, 375 or 1280 px.

**Host-voice pass (editorial checklist):**
- Stuart carries energy and the turns.
- Rich explains and asks nothing he does not answer.
- Boomer's four lines are connected highlight stories.
- Kenny only reads receipts and closes with understated lines.
- No host speaks another's catchphrase.

## 10. Final editorial review (Keith, 2026-10-14)

### Sound

Keith's ruling: Week 5 stays silent.
- He wanted only the two exact clips: no generic or generated music, no separate YouTube play buttons, no ads, and no change to the MFL security sandbox.
- No embedding, downloading, extracting or rehosting of the clips.
- Draft #1295 is closed, with its findings in `docs/wire/broadcast-mode.md` on its branch.
- The future enhancement, which needs licensed local files for the two transitions, is #1297.

### Edits in the final pass
- **Kenny's Monday-night line** now says "11:31 PM".
- **The 20-target history** now names its span: "From 1999 through 2025, in the 39 games that followed a 20-target game, players averaged 9.3 targets." It covers only games before this season; Lamb's 2026 follow-up is cited separately.
- **The Elias segment and the method panel are now reader-facing.** They say "Not yet Elias-final", replacing the draft-only editor box, since Elias is a post-publication update under the standing rule.

### Sourcing audit
- **Every printed number is labeled.** All 673 numbers are in `claims_wk05.json`, each with a named source. The build now fails if any claim lacks one; 363 earlier registrations had relied on the default and are now labeled by key family.
- **Probabilities:**
  - forecast numbers trace to `season_sim_2026_live_wk05.json`;
  - scenario rates trace to `week_preview_2026_wk06.json`, the same 10,000 seasons;
  - division and title odds use the documented largest-remainder rounding.
- **Independent verifier: 111 of 111 pass.** Every playoff, division, scenario and Week 6 rate is recomputed independently. Three history checks were added in this pass:
  - since 2017, 4 of the 24 teams ranked 10th–12th in All-Play made the playoffs;
  - Bear 2017 was a division winner, the 6th seed, and finished 3rd;
  - 1999–2025: 39 follow-up games averaged 9.3 targets.
- **Not independently recomputed, but sourced and disclosed:** the claims that need box scores rescored with 2026 UPS rules. The method panel discloses the scorer's validation against MFL (81% exact, 91% within a point). These claims are:
  - the running back and receiver five-game history (Holmes 176.9, McCaffrey 166.0, Welker 170.7);
  - the retention rates (about 80% and 74%);
  - Bowers' run ranking against 2,685 tight-end seasons.

### Division-title probabilities
Raw simulated totals are exactly 1.0 in every division, and the displayed values total exactly 100.0%:

| Division | Displayed values |
|---|---|
| DOG POUND 4 LIFE | 95.7 / 2.9 / 1.4 |
| LEGION OF BOOM | 84.5 / 13.9 / 1.6 |
| Maddie Mondays | 82.2 / 16.2 / 1.6 |
| Outlast PG Time | 51.5 / 48.3 / 0.2 |

`test_season_sim_divisions.py` passes all 20 checks.

### Bowers, Weeks 3–5
Re-fetched live from MFL `weeklyResults` on 2026-10-14 (franchise 0009, player 16641):

| Week | Games | Bowers | Bear's results |
|---|---|---|---|
| 3 | 3 | Nonstarter (bench) with 36.0 in all three; LaPorta started at TE (9.1), Gesicki also on the bench (14.4) | Won all three |
| 4 | 2 | Started both, 24.6 | |
| 5 | 3 | Started all three, 30.0 | |

### Publication checklist
1. **Keith's explicit approval** of this final issue. Nothing merges or publishes before it.
2. **Before publishing, check Dowdle's Wednesday–Friday practice reports.** Change the Pittsburgh lines only if his status materially changes (ruled out or IR). "Our forecast already counts Dowdle as available" stays true otherwise.
3. **Deadline: Thursday about 12:15 PM ET.** That is 8 hours before Week 6's first kickoff (Seattle at Denver, 8:15 PM ET), when `ups_center_due` starts flagging the issue as overdue; the 12:30 PM alert is expected if the issue is not live. If publication slips past the first kickoff, refresh the Week 6 forecast and preview, rebuild, and re-verify before going live.
4. **Pre-publish runs:**
   - `ups_center_due.py preflight --season 2026 --week 5 --candidate`;
   - the builder;
   - `verify_wk05.py` (111);
   - `wire.py restyle`, `index` and `verify`;
   - `check_inline_js.mjs`;
   - both UPS Center suites and the division tests;
   - the layout check at 320 and 375 px.
5. **Publish commit (wire-meta only):** `status: live`, `publishedAt: <UTC now>`, `featured: yes`; then `wire.py index` and `verify`.
6. **Squash-merge #1244 with Keith's go.** Pages deploys automatically.
7. **After the merge:**
   - confirm the live page and the live index show Week 5 as live;
   - run `preflight --stage announce`, which must say live and not yet announced.
8. **Announcement:** a separate go from Keith, plus the wording.
   - One post in #league-announcements, with the card, the "Challenge this" button and a thread.
   - Record the `ups_wire_threads` row, and confirm the duplicate guard blocks a second post.
9. **Elias** (post-publication, pre-authorized):
   - when the Week 5 changes post, run `elias.py check`;
   - apply any moved score to the live article and merge;
   - message the league only if an All-Play record changes.
10. **Untouched:** #1189, the MFL loader, league data, and any production write beyond the publish merge.

---

## 11. Elias correction (Thu Oct 15, post-publication, pre-authorized)

**Plain English.** Elias posted 13 official Week 5 stat changes on Wed Oct 14 at 11:12 PM ET. Two of them moved UPS scores:
- **Bear Dunn:** 280.0 → 280.5 (Alex Singleton, assists 2 → 3).
- **Keith Creelman:** 271.5 → 272.5 (Zach Allen, QB hits 1 → 3).

No result flipped and no All-Play record moved, so no league message is due. The live article now shows the corrected scores, and its Elias note says what changed.

**What changed on the page:**
- the six Week 5 result rows for those teams, with their margins:
  - Bear vs Martel: 89.3 → 89.8;
  - Bear vs Cross: 56.1 → 56.6;
  - Bear vs Cutting: 11.6 → 12.1;
  - Keith vs Gerardi: 110.4 → 111.4;
  - Keith vs Whitman: 60.1 → 61.1;
  - Keith vs Blake: 10.0 → 11.0;
- Boomer's top score (280.5);
- Stuart's Weeks 3–5 average for Bear (274.9 → 275.1);
- Rich's "beat by 89.8";
- the Elias segment and the method status (now Elias-final).

**What did not change:**
- **Bench points:** each team's best possible lineup rose by the same amount.
- **Rankings, All-Play, and the Heat Check and Survival Line tables:** unchanged.
- **The playoff odds and Week 6 scenarios:** still Tuesday's simulation. The note says so.

**Technical.**
- `elias.py check --season 2026 --week 5` found 13 changes: 2 player scores, 2 team scores, 0 results flipped, All-Play unchanged.
- MFL's corrected `weeklyResults` W5 and standings differ from the recorded ones only for 0008 and 0009 (score, best possible lineup, points for).
- `build/elias_correct_wk05.py` applied 11 replacements, each asserted to match once.
- `build/check_elias_wk05.py` re-derives every Week 5 result row (18), the top score, Bear's three-week average, the margin and the note from MFL's corrected results.
  - The corrected article passes.
  - The pre-correction article fails exactly the 12 changed items.
- Every number on the page that changed is one of the intended ones (number-by-number diff). `wire.py verify` passes.
