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
- playoff odds moved by at most 0.6 points;
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

