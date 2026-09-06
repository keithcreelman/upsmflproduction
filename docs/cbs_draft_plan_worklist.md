# CBS grffl draft plan — worklist

## RESUME HERE

**Pages (private artifacts, do not share):**
* Draft board — https://claude.ai/code/artifact/9ee90ce9-6a4f-41ef-a4e1-12e38c83be0a
* Round-by-round plan — https://claude.ai/code/artifact/e6b5d898-c5eb-4afb-8a9c-7577907015cd
* Full draft list by ADP round — https://claude.ai/code/artifact/ece3cc3c-356b-46c8-b037-48766da4d28b

### ✅ THE ROUND-BY-ROUND CONTENT EXISTS — I was wrong to say it didn't

JJ Zachariason runs a two-part segment (30 Jul, 6 Aug 2026) where a co-host
reads each round's **FantasyPros** ADP tier and JJ names his single favourite
pick in it. Scott Barrett does the inverse on Fantasy Points — one player he
refuses to draft in every round. Both stop at **round 10**: JJ's co-host says
on air that rounds 11–15 are dart throws behind the paid guide. Silva has no
such series.

**41 verified round-tied calls**, each re-fetched by a second reader who had to
find both the claim *and* the round tie. 7 corroborated by two independent
routes (omny.fm word-level JSON vs yt-dlp captions).

**Rounds 11+ come from the guide you own.** The co-host paywalls rounds 11-15
as "dart throws you can buy by purchasing the guide" — so the guide's
Late-Round Dart Throws chapter fills those bands: 31 entries placed by ADP, 24
of them in round 11 or later, each with JJ's own Confidence Level.
⚠️ It is a LIST, not a pick per round, and renders in its own block labelled as
placed. 7 of its entries are `avoid`/`neutral` — players he does NOT like — and
the verdict is carried, because reading the chapter as a recommendation list
would invert them.

**⚠️ 27 of the 41 land in a DIFFERENT round under FFC ADP than under
FantasyPros.** Jaxson Dart is JJ's round-6 pick and FFC has him in round 10.
The board and list are cut on FFC; the calls are filed under the analyst's own
round and flagged. Which market you draft against is a real open question.

### ⚠️ POSITIONAL RANK ONLY — never compare overall

An analyst's overall list encodes HIS scoring and HIS positional weighting. JJ
devalues QB against ADP and says so on the record, so "he has Maye 64th, this
board has him 52nd" compares two different questions. Both pages now compare
**within position** only; the scoring adjustment is already inside VOR.

This was not cosmetic. Under overall rank the disagreement list was dominated
by tight ends (Hockenson ▼83, Freiermuth ▼81, Ferguson ▼66) — pure artifact of
1.5-PPR TE receptions lifting every TE's *overall* slot. Positionally, **only 2
of 28 tight ends disagree by 8+ places** and the top eight are within three of
each other. The real disagreement is at receiver: **34 of 89**.

**Draft:** Tue 8 Sep 2026, 7:30 pm ET. 12 teams, snake, 18 rounds, no keepers.
**The slot is NOT drawn yet.** Both pages ship all 12 and let you pick one —
nothing needs rebuilding when the order comes out. Slot changes the plan more
than any other single input: from the turn you get two picks five apart, from
the ends two picks two apart and then a 22-pick wait.

### State — both in-flight tasks are DONE

* **Verify pass re-run** — 136 agents, 0 errors. **116 takes verified, 14
  rejected, 49 dead ends.** Up from 23 verified before the cap was raised.
* **Analyst layer folded into the board.** 209 players carry JJ's own rank;
  111 verified podcast takes attach to 82 of them; 3 more are position-level.

### How to rebuild

```
# the committed board — no analyst data, safe for git
python3 scripts/cbs_build_draft_board.py --out docs/cbs_draft_board_2026.html

# the overlay build — REFUSES to write anywhere git tracks
python3 scripts/cbs_extract_verified_takes.py --result <workflow-output.json> \
    --journal <run>/journal.jsonl
python3 scripts/cbs_build_draft_board.py \
    --payload-in data/analyst/board_payload.json \
    --analyst-dir data/analyst \
    --out data/analyst/draft_board_2026_analyst.html
```

`--payload-in` skips remote D1 entirely. Drop it (and add `--payload-out`) to
recompute projections from scratch.

### Data (all gitignored — paid-guide extracts, personal reference only)

| file | what |
|---|---|
| `data/analyst/jj_takes.json` | 627 takes, 263 players, JJ's 250-player cheat sheet |
| `data/analyst/pod_takes.json` | 184 candidate podcast takes with source URLs |
| `data/analyst/verified_takes.json` | the 116 that survived re-fetch, with attribution |
| `data/analyst/reconciled.json` | JJ rank vs grffl VOR, 209 joined |
| `data/analyst/board_payload.json` | the board at both rulebooks |
| `data/analyst/final_board.json` | full projection detail |

### What the verify pass established

* **Transcripts are machine-generated and mangle names.** "Lad Maki" is Ladd
  McConkey; "Ashen Genty" is Ashton Jeanty; "Taj Spears" is Tyjae Spears. The
  verifier refused to resolve those, so a few substantively-correct takes were
  rejected on the name alone. Rejected here means *unconfirmed*, not *false*.
* **The analyst searched for is not always the analyst speaking.** 11 verified
  takes carry an explicit speaker caveat — Rich Hribar guesting on JJ's show,
  Ryan Heath co-hosting with Barrett, Evan Silva rather than Adam Levitan. The
  board hedges those chips and shows the verifier's own sentence.
* **One name needed an explicit alias**: "Jackson Dart" → "Jaxson Dart",
  confirmed by reading the take (QB12 ADP, Nagy calling plays), not by string
  distance. `ALIASES` in `cbs_build_draft_board.py` — never make it fuzzy.
* **Two verified takes never joined**: Eli Stowers and Jake Tonges are outside
  ESPN's projected 215.

### Still open

* **Does CBS default to 6-point passing TDs?** JJ's 20 Aug 2026 episode treats
  it as a per-platform ADP driver. If true, grffl's 4 is the custom setting,
  the vote moves *toward* the default, and CBS-sourced ADP is already priced at
  6 while the FFC ADP on the board is not. **Unverified.**
* Task #37: ingest nflverse `sack_fumbles_lost` into `nfl_player_weekly_ext`.
* Task #38: build CBS `fetch_rosters` after the draft.


## ⏸️ RESUME HERE (state as of 2026-08-24, pre-compaction)

**Draft: Tue 8 Sep 2026, 19:30 ET. Keith picks 10th of 12, snake, 18 rounds.**

### The live board (published, private artifact)
https://claude.ai/code/artifact/9ee90ce9-6a4f-41ef-a4e1-12e38c83be0a
Rebuild with `python3 scripts/cbs_build_draft_board.py`; the page is a BUILD
OUTPUT from `scripts/_draft_board_template.html`. To update the SAME artifact
URL, republish `docs/cbs_draft_board_2026.html` — passing the url param if the
publishing conversation has changed.

### TWO THINGS WERE IN FLIGHT WHEN WE COMPACTED
1. **Re-run the analyst verify pass.** The script is already edited (cap raised
   40 -> 130, first 40 prompts byte-identical so they replay from cache):
   `Workflow({scriptPath: ".../workflows/scripts/analyst-podcast-sweep-wf_46c3587e-9af.js", resumeFromRunId: "wf_46c3587e-9af"})`
   Previous run: 29 verdicts, 23 supported, **6 REJECTED**, 11 killed by a
   session limit (Love, Jeanty, Tyson, Tate, Hall, Dart, Sadiq, Stafford,
   Willis, III, Nabers).
2. **Fold the verified analyst layer into the board page** — a per-player column
   for JJ's cheat-sheet rank + any VERIFIED analyst stance.

### Data on disk (⚠️ data/analyst/ is GITIGNORED — paid-guide extracts)
| file | what |
|---|---|
| `data/analyst/jj_takes.json` | 627 takes, 263 players, incl. JJ's FULL 250-player cheat sheet with Ovr/pos rank, tier, auction value |
| `data/analyst/pod_takes.json` | 184 podcast/article takes w/ source URLs (Silva 69, Barrett 75, JJ 40) |
| `data/analyst/final_board.json` | the grffl board at BOTH rulebooks (PaTD 4 and 6) |
| `data/analyst/reconciled.json` | JJ rank vs grffl VOR, 209 joined players |
| `data/analyst/verify_summary.json` | verify verdicts incl. the 6 rejections |

### Sources that actually work (all free, all fetched)
- **ListenNotes** serves FULL ASR transcripts inline (`id="transcript"`) for the
  Late-Round podcast. ⚠️ Some URLs serve a DIFFERENT episode than the slug says
  — that caused 3 of the 6 verify rejections. Always confirm `<title>`.
- **stackedfantasy.com** mirrors verbatim multi-hundred-segment transcripts of
  Barrett's RotoWire and Fantasy Points shows.
- **establishtherun.com/takes/** — FREE, continuously updated, 72 Silva-attributed
  episode summaries with timestamps (validated against YouTube chapter markers).
- ETR/Fantasy Points ARTICLES are paywalled after the first tier; the PODCASTS
  are free. Those are different problems — do not conflate them again.
- YouTube: WebFetch drops the description; `curl` + `ytInitialPlayerResponse.shortDescription` works.

### ⚠️ VERIFY EVERYTHING ATTRIBUTED TO A NAMED PERSON
A search summary claimed Barrett's Exodia was "Mike Evans and George Kittle."
The actual transcript: Exodia is FIVE must-drafts, the two revealed are **Mike
Evans and Parker Washington**, and Barrett says of Kittle *"He's not my Exodia
tight end on FFPC."* 6 of 29 verified claims failed re-fetch. Search snippets
are not sources.

### Verified analyst takes (quote-level)
FADE: Courtland Sutton, Matthew Stafford (7.7% TD rate; 12 of 13 comps averaged
18 ppg after), Tony Pollard, TreVeyon Henderson.
LIKE: Bhayshul Tuten (">ceiling than Henderson"), Parker Washington (Barrett
Exodia, "single most mispriced player"), Luther Burden III, Jaylen Waddle, Blake
Corum, Malik Willis, Kyler Murray, Jaxson Dart, Dalton Kincaid, McCaffrey.
⚠️ ~120 further takes are UNVERIFIED — plausible, sourced, unchecked.

### The reconciliation finding
**8 of the top 14 "grffl likes more than JJ" are TIGHT ENDS** (Hockenson +83,
Freiermuth +81, Ferguson +66, Goedert +51, Andrews +50, Kelce +47) — the 1.5/rec
premium. The other direction is almost all mid-round WRs (Downs -60, Diggs -51,
Godwin -51, Evans -50) because grffl's WR replacement is high (WR31 starts).
Elite WR early is right; WR DEPTH is not.

### Live collisions to resolve at the table
- **De'Von Achane**: Barrett calls the fade "embarrassing"; Silva has him on the
  Shy Away List. Board has him +130 at 2.03.
- **Matthew Stafford**: verified JJ fade, AND the biggest riser if PaTD -> 6.
- **Mike Evans**: Barrett Exodia must-draft, JJ ranks him 52, grffl VOR -14.

### ⚠️ CBS may already default to 6-point passing TDs
JJ's 2026-08-20 episode breaks down ADP per platform and names CBS's
6-pt-passing-TD setting as a pricing driver. If true, grffl's 4 is the CUSTOM
setting, the vote moves you TO the default, and CBS-sourced ADP is already
priced at 6 while the FFC ADP on the board is not. UNVERIFIED — check it.


Keith's CBS league drafts BEFORE his ESPN league. ESPN is already draft-ready;
CBS is not. This is the ordered work, with every hard-won fact needed to do it
without re-deriving anything.

## Access (all proven working — do not re-research)

- API base: `https://grffl.football.cbssports.com/api/<ep>?version=3.0&response_format=json`
- **`league_id` is the SUBDOMAIN STRING `grffl`**, never a number.
- API auth: `&access_token=<tok>` — Keychain `cbs_access_token` (128 chars).
- HTML auth: cookie **`pid` ALONE** is necessary and sufficient — Keychain
  `cbs_cookies`. The token does NOT authenticate HTML; `pid` does NOT
  authenticate the API. Two separate paths.
- Working API endpoints (200 with league_id+token): `league/details`,
  `league/teams`, `league/owners`, `league/rules`, `league/rosters`,
  `league/schedules`, `league/standings/overall`, `league/draft/order`,
  `league/draft/results`, `league/scoring/live`, `league/stats`.
- ⚠️ API is CURRENT-SEASON ONLY. `&season=` is ignored under every spelling.
- HTML history: `/draft/results/<YEAR>` (PATH form — the `?season=` form
  silently returns FEWER rows), `/standings/overall/<YEAR>`, `/rules/scoring`.
- Stats: **`/stats/stats-main/all:<POS>/<YEAR>`** — position filter FIRST and
  REQUIRED. JS-RENDERED for past seasons → must be fetched via browser.

## ⚠️ Traps found while executing Step 1 (2026-08-23)

- **`league/rosters` silently returns ONE team — yours — of twelve.** HTTP 200,
  no marker. `team_id=all` is required. Guarded by a count assertion.
- **`league/schedules` silently returns ONE period of seventeen.** Same shape.
  `period=all` required. Treat "CBS narrowed the collection" as the DEFAULT
  assumption for any CBS collection endpoint and prove the width every time.
- **An un-started draft returns 216 of 216 picks each with a POPULATED
  `player` object** whose id is the literal `UpcomingPick`. Truthiness is not
  the test; the sentinel is.
- **`/rules/scoring/<YEAR>` HAS NO HISTORY and does not say so.** 2013, 2019
  and 2026 parse to the SAME 48 rules. The year is echoed in `requestUri` and
  nowhere else. Historical scoring is recoverable ONLY via stats.py's fits.
- **CBS states scoring TWICE and the two disagree on purpose**: `categories`
  is the league default, `positions` is the per-position override. Reading
  either alone produces a scoring table that is wrong for most of the roster.
- **An unknown endpoint returns 95KB of HTML, never a JSON error.**

## Step 1 — ingest league state ✅ DONE 2026-08-23 (local + remote)

218 rows across 11 tables for `platform='cbs'`, season 2026:
`fantasy_league_seasons` 1, `fantasy_league_settings` 1, `fantasy_scoring_rules`
68 (28 league-default + 40 position overrides), `fantasy_scoring_bonuses` 70,
`fantasy_roster_positions` 10, `fantasy_divisions` 3, `fantasy_teams` 12,
`fantasy_managers` 12, `fantasy_team_managers` 12, `fantasy_schedule_periods`
17, `fantasy_team_season_state` 12.

Built: `providers/cbs/api.py`, `parse_api.py`, `adapter.py`; migration
**0134** (bonus bands: `target_max` / `is_stacking` / `applies_to_positions`);
CLI `--platform cbs`. Run it again with:
`python3 pipelines/fantasy/cli.py --platform cbs --target remote backfill --league-id grffl`

**2026 draft: snake, 18 rounds, Tue 8 Sep 2026 19:30 ET, 60s/pick.
Keith picks 10th of 12** — overall 10, 15, 34, 39, 58, 63, 82, 87, 106, 111,
130, 135, 154, 159, 178, 183, 202, 207. Roster: QB1 RB2 WR2 TE1 FLEX(RB/WR/TE)1
K1 DST1 = 9 starters + 9 bench. **No keepers.** Entry fee $64. 12 teams,
3 divisions, 14 regular weeks, playoffs W15-17 (6 teams, reseeded).

### Still open after Step 1

- `fantasy_roster_snapshots` and `fantasy_player_week_points` are still zero,
  and correctly so: **the draft has not happened**, so there are no rosters and
  no scored weeks. `fetch_rosters` confirms all 12 teams are present and empty
  rather than reporting a gap. Revisit after 8 Sep.
- The 48-rule HTML rulebook was NOT persisted, and should not be: the JSON API
  supersedes it with 68 rules + 70 explicit bonus bands for the same season,
  and the HTML page has no history to offer (see traps above).
- `fetch_transactions` / `fetch_standings` / `fetch_player_stats` deliberately
  RAISE `NotImplementedInThisPass`. CBS offers all three; they are unbuilt, and
  recording "unbuilt" as "not offered" is what stops them ever getting built.

### ⚠️ TWO TEAM-KEY SCHEMES NOW COEXIST — read before joining

API rows key on CBS's stable numeric id (`ffl.s2026.l.grffl.t.10`). History
rows key on a SLUG of the franchise name (`...t.raining-bullets`), because the
history pages expose no id at all — re-confirmed by grepping a live 2025 draft
page for every id-bearing pattern: zero matches. **A 2026 team_key does not
join to a 2025 team_key.** Bridging them is Step 4 work and must go through
`fantasy_managers` (the API's owner GUIDs are stable and are now in D1 for the
first time), never through the key or the franchise name alone.

## Step 2 — league-specific rankings ✅ DONE 2026-08-23

Built: `pipelines/fantasy/scoring.py` (league-agnostic engine, reads the rules
out of D1), `scripts/cbs_build_board.py`, `scripts/cbs_measure_td_bonus.py`.

```bash
python3 scripts/cbs_build_board.py --top 60 --json-out /tmp/cbs_board.json
```

**Engine validated against CBS's own published points: 57 player-seasons, 4
positions, 0 cases where it exceeded CBS's total.** That is the decisive test —
every bonus in this league ADDS, so scoring above the provider is proof of a bug.

### Two parser bugs this step exposed (both now fixed + tested)
1. **The `per` divisor was dropped.** `PaYd` and `ReYd` arrive as ranges
   identical but for one field: `per: "2.5"` vs `per: "1"`. Passing yards are
   **0.04/yd, not 0.1**. Caught by an empirical fit saying 0.05 where the parser
   claimed 0.1, and the HTML rules page saying it in words.
2. **`DSTPA` is a 7-tier lookup, not a rate**, and `ranges[0]` collapsed it to
   the shutout tier — scoring every defense as if it had pitched one.

### Findings
- **Generic ADP is wrong for QUARTERBACKS, and only marginally wrong elsewhere.**
  Median rank change vs standard PPR across the top 150 is just **4 spots**. The
  real movers are rushing QBs (Dart +56, Richardson +53, Lawrence +21, Hurts
  +17, Allen +9) and pocket passers falling (Stafford −23, Love −20, C. Williams
  −17). This CORRECTS the assumption written above that generic ADP is wholesale
  wrong here — it is not, and the edge is narrower and more specific than hoped.
- TD-distance bonuses are worth 5–10% of a scorer's season and are invisible in
  weekly stat lines, so they are MEASURED per TD type against CBS's own points:
  QB PaTD +1.16 / RuTD +0.70, RB RuTD +1.42 / ReTD +2.90, WR ReTD +2.14 /
  RuTD +6.63, TE ReTD +1.70. A single flat per-position rate OVERSTATED the
  rushing-QB premium (QB rushing TDs are goal-line, under the 10-yard threshold).
- Flex allocates from the data, not a guess: **WR 9 / RB 3**, so the league
  starts QB12 / RB27 / WR33 / TE12.

### ⚠️ Known gaps in the board — do not read it as complete
- **2026 rookies are absent entirely** (no NFL history to weight). Needs
  ADP-implied values → Step 3.
- **K and DST are not ranked.**
- **QB scores are slightly overstated**: this database has NO sack-fumble
  column anywhere, so strip-sack fumbles (−2 each) are missed. Bounded, named,
  and excused explicitly in the measurement script; tracked as its own task.
- **Small samples are not shrunk.** Skattebo (8g), Hampton (9g), Jeanty (16g)
  rank on partial seasons at full weight. Games played is printed on every row.
- **A missed season is not penalised**, by design of the standing rule
  (renormalise over seasons played). That rule was written for young players;
  Joe Mixon ranks #18 on 2024+2023 having missed 2025 entirely. Worth a
  decision from Keith rather than a silent fix.

### Original Step 2 note (kept — the scoring table below is confirmed correct)

⚠️ **GENERIC ADP IS ACTIVELY WRONG FOR THIS LEAGUE.** Scoring is
position-asymmetric — OUT-OF-POSITION TOUCHDOWNS PAY DOUBLE:

| | PaTD | ReTD | RuTD |
|---|---|---|---|
| QB | 4 | 12 | 12 |
| RB | 8 | **12** | **6** |
| WR | 8 | **6** | **12** |
| TE | 8 | 6 | 12 |

...all with STACKED distance bonuses (10-39 / 40-69 / 70-100 yds), so the
rulebook base UNDERSTATES a long TD. Derived effective values are already in
D1 (`stat_id LIKE 'fit:%'`, 72 coefficients, 2022-2025).

No public ranking models this. Score 2026 projections with THIS league's rules
to build a board, rather than borrowing anyone's ADP.

## Step 3 — ADP deviation analysis

Compare the league's ACTUAL draft behaviour (1,080 picks, 2021-2025, already in
`fantasy_draft_events` platform='cbs') against contemporaneous market ADP.
- CBS historical ADP: check `/stats/stats-main` category pulldown
  (`standard|scoring|advanced`) and any ADP view; if CBS has no historical ADP,
  fall back to FantasyPros or FFC for that season.
- FFC API works keylessly: `fantasyfootballcalculator.com/api/v1/adp/ppr?teams=12&year=<YR>`
- FantasyPros needs an API key (pages are JS-rendered; `pipelines/etl/scripts/
  fetch_fantasypros_adp.py` is STALE — its regex matches zero rows now).
- ⚠️ `fantasy_adp` is keyed by SOURCE precisely so two sources can disagree and
  both be stored. Do not blend.

**The question worth answering:** have Keith's leaguemates adapted to the
out-of-position premium, or are they still drafting off standard boards? If the
latter, that is a systematic, repeatable edge — quantify it as picks-of-value
left on the table per owner per season.

## ✅ LEAGUE HISTORY FOUND — /history/team-overview (2026-08-24)

```bash
python3 scripts/cbs_history_backfill.py --target remote
```

**23 seasons, 2003-2025, 22 franchises, 276 franchise-seasons** — records, PF/PA,
finish, and critically **a MANAGERS column naming the person who ran each
franchise each year.** Every other CBS surface names franchises and never
people, which is why owner continuity previously rested on testimony.

### What it settled
- All twelve 2021-2025 franchises had **exactly ONE manager each** — now read
  from data, not assumed.
- The franchise absent from 2026 is **history id 14 = Corey Smith** (Savage
  Beavers), verified by matching W-L against `/standings/overall` for all five
  seasons. The -129 previously parked under "(prior owner)" is his. Geoff
  Woods's 2026 franchise has an **empty** history table, confirming he is new.
- `RENAMES` / `CONTINUITY_SOURCE` are GONE from cbs_draft_history.py; owner
  attribution reads `fantasy_team_managers`.

### The join nobody could make before
History keys on a numeric franchise id and mostly omits the NAME; drafts key on
a slug of the name and never the id. `history.crosswalk()` binds them on the
season W-L-T record — the only field both surfaces carry — and **refuses on
ambiguity** (two teams can finish 8-8).

### Three parser traps
1. **Two header shapes** — some franchises render a `Team Name` column, some
   don't. One fixed pattern silently returns zero rows for half the league.
2. **Row patterns must LOOK AHEAD at the trailing delimiter.** Consuming it
   eats the pipe the next row needs, so `finditer` skips every other season.
   Latent on the live page (it emits an empty cell between rows) and exposed
   only by a whitespace-formatted fixture.
3. **Manager names are dirty and must NEVER be fuzzy-matched**: this league has
   both `Chuck Schoolcraft` and `chuck shcoolcraft` as DIFFERENT people running
   DIFFERENT franchises. Normalise case/spacing only. History uids reconcile to
   the API's real GUIDs where the name matches (11 of 28) and otherwise carry a
   `name:` prefix that announces their basis.

### Still not available
No league-wide **weekly** scores for any past season. `/schedule/<YEAR>` serves
only the authenticated user's own 17 games under every URL form and printer
variant; `/scoring/` pages are JS-rendered with scores absent from the HTML;
`api.cbssports.com` ignores `season` under all five spellings, same as the
league subdomain. **All-Play accumulates from 2026 week 1 and cannot reach back.**

## RULES SCENARIOS + the PaTD-6 board — 2026-08-23

```bash
python3 scripts/cbs_scenario.py                                    # A / B / A+B
python3 scripts/cbs_projected_board.py --pass-td 6 --json-out /tmp/b6.json
python3 scripts/cbs_adp_value.py --board /tmp/b6.json              # picks under the new rules
python3 scripts/cbs_owner_head_to_head.py                          # chuck vs Keith
```

**Keith expects the passing-TD rule (4 -> 6) to PASS.** Board rebuilt for it.
`ScoringTable.with_override()` moves the league default and the QB override
only — a RB/WR/TE passing TD stays 8, because that is the out-of-position
premium, not the base.

### What PaTD 6 actually does
- **Nearly VOR-neutral at the top**: Josh Allen 132 -> 138. It lifts every QB,
  so replacement rises 343 -> 390 and cancels most of it. Inflates scores, not value.
- **Transfers value from rushing QBs to pocket QBs**: rushing QBs mean **-2**,
  pocket QBs **+8**. Stafford +23, Burrow +20, Prescott +13; Dart -5, Jones -7,
  Shough -6.
- **Rushing premium falls 3.0x -> 2.0x.** Still an edge, still unexploited, smaller.
- Practical: do NOT draft QBs earlier. Elite rushing QB is still the best QB buy;
  late rushing-QB steals get less special and pocket passers become viable late.

### Scenario A (+WR3, +2nd flex)
Deepens everything: starters go WR31 -> WR43, RB28 -> RB36, TE13 -> TE17;
replacement drops (WR 207 -> 180, RB 206 -> 184). Pushes WRs up, QBs down.

### Keith's RB-heavy strategy — TESTED, and partly vindicated
His argument: RB injury -> you hold the backup -> massive hit; WR2 means you can
stay thin at receiver.
- **The mechanism is REAL.** Workload inheritance (quiet wk1-8, 2x PPG after)
  happens at **RB 4.9% vs WR 2.4%**.
- **And it cashes in the playoff window.** Among late darts quiet through wk8,
  RB beats WR at every upper percentile in weeks 15-17: P75 11.0 vs 7.7,
  P90 17.6 vs 11.5, >=15 PPG 15% vs 8%.
- **But the cost is real too**: late RB darts convert to startable 15.8% vs WR
  32.7%; EV 114 vs 143 pts. ~29 pts of EV per dart, traded for the tail.
- **Verdict: keep the handcuff bets, drop the filler.** He takes 34 RBs to
  chuck's 22; the extra dozen back up nobody and pay the EV cost without buying
  the tail.

### ⚠️ TWO BENCHMARK CORRECTIONS made while doing this
1. **CBS dropped the draft-page Fpts columns after 2023** (7 header cells -> 5),
   so 2024-25 outcome data was NULL and the owner table silently covered THREE
   seasons while claiming five. Recovered from the stats pages
   (`season_points_by_player` in providers/cbs/stats.py); top-100-per-position
   only, so deep picks stay unpriced and the count is reported.
2. **"vs slot" was POSITION-BLIND** — it compared a pick to the league median
   for that ROUND across all positions, and QBs simply score more raw points
   here, so QB-heavy drafters looked good and RB-heavy drafters looked bad by
   construction. Re-scored WITHIN position, Keith moves 12th -> **7th (-83/season)**.

## REAL 2026 PROJECTIONS — ✅ DONE 2026-08-23

```bash
python3 scripts/cbs_projected_board.py --json-out /tmp/cbs_proj_board.json
python3 scripts/cbs_adp_value.py --board /tmp/cbs_proj_board.json
```

**Source: ESPN `kona_player_info`, `statSourceId=1 / split=0 / season=2026`** —
real stat-level projections (366 skill players), reachable with the ESPN
cookies already in the Keychain. CBS's own projections are all zeros.

⚠️ **ESPN's stat ids are DERIVED, not remembered**: matched ESPN's own 2025
ACTUALS against D1's 2025 actuals player by player, accepting an id only at
>75% exact and n>=10. Regenerate with `--derive-map`.

### Four bugs this exposed (all fixed)
1. **Receptions were silently dropped.** ESPN uses id **53** in PROJECTIONS and
   **41** in actuals. The derivation (run on actuals) kept 41 only, removing
   ~100 points from every top receiver and making the board look RB-dominated.
   *Deriving a map on one payload does not prove coverage on another.*
2. **The fallback game-shape collapsed to 8 games** (took the MIN length across
   contributors), cramming a season into 8 and inventing milestone bonuses.
3. **Name suffixes** ("James Cook III") broke the historical shape lookup.
4. **The fallback counter cried wolf** — reported 356/366 because a receiver has
   no *passing* shape. Real number is 72 (rookies).

### The season-total problem, and how it is handled
A season total cannot be scored directly: this league pays PER-GAME milestones,
so points depend on a season's SHAPE. Dividing by 17 gives a flat line that
never reaches 100 yards and earns zero milestones. Each projection is therefore
distributed over 17 games using **that player's own historical game-to-game
shape**, rescaled to the projected total; rookies use a positional shape and are
flagged per row (`shape=fallback`).

### ⚠️ CORRECTION to Step 4: Geoff Woods is NEW in 2026
The earlier crosswalk treated `savage-beavers` → "The Champ is here" as a
RENAME and credited five seasons of picks to Geoff. **The franchise continued;
the owner did not.** CBS history pages carry franchise names and NO owner names,
so ownership changes cannot be detected from data — they must be asserted.
That history now sits under "(prior owner of Savage Beavers)". The other 11 are
owner-continuous **on Keith's testimony, not on evidence** — see
`CONTINUITY_SOURCE` in `scripts/cbs_draft_history.py`.

## Steps 3 & 4 — ✅ DONE 2026-08-23

```bash
python3 scripts/cbs_adp_value.py --write-adp     # ADP -> fantasy_adp + slot baselines
python3 scripts/cbs_draft_history.py             # owner tendencies + the payoff finding
```

### THE HEADLINE: the edge is real, and completely unexploited
- **The league drafts to market.** Rank correlation with FFC ADP is **0.90-0.94
  every season**, median |pick − ADP| 11-17 picks.
- **No owner drafts for the scoring system.** Scoring every drafted player's
  actual touchdowns under grffl vs generic PPR, the mean ratio is 1.125 and the
  spread across all twelve owners is **0.067** — noise, not strategy.
- The best drafter by outcome (chuck shcoolcraft, **+349 pts/season** vs slot)
  has one of the LOWEST ratios (1.098). His edge is player evaluation, not
  scoring arbitrage. Nobody is taking the free money.

### Owner table (2021-2025, 1,080 picks)
`vs slot` = season points above/below the league median from the same rounds.
Keith sits **−56**, 9th of 12. Best: chuck shcoolcraft +349, Brian Cutting
+224, Nate Trusten +208. Worst: Geoffrey Woods −171, Long Nguyen −136.

### Crosswalk (this was the gating task)
History `team_key`s are name-slugs; 2026 API keys are numeric — they do NOT
join. All 12 franchise names are STABLE 2021-2025, and the single 2026 rename
resolves one-to-one: **`savage-beavers` → "The Champ is here" (id 16, Geoffrey
Woods)**. Forced, not fuzzy-matched. Encoded as `RENAMES` in the script.

### Traps handled
- **`player_key_at_draft` is NULL on all 1,080 rows** — the backfill never
  populated it. Names come from `raw_pick_json.player_name`. The column is a
  real gap worth repairing.
- **Reach/value is only meaningful inside the market's own depth.** FFC lists
  157-249 players against a 216-pick draft, so past that depth only players
  whose ADP precedes the slot can match — which showed all twelve owners
  "getting value", arithmetically impossible in a zero-sum draft. Restricted to
  picks 1-157.
- `total_fantasy_points` in the raw payload is what the PLAYER scored, not what
  he scored FOR THAT TEAM — a player cut in week 3 carries his full season. So
  the outcome metric is draft-day judgment only.

### Still open
- The per-pick "best available" list is NOT usable advice: the board is
  backward-looking production, ADP is forward-looking, so its top "values" are
  players the market has correctly marked down (Conner, Kupp, Keenan Allen).
  Needs real 2026 projections.
- 2026 rookies remain unscored; K and DST unranked.

## Step 4 — original notes

1,080 picks × 12 franchises × 5 seasons. Owner tendencies: positional order,
reach vs ADP, whether behaviour changed after any scoring change.
⚠️ Franchise NAMES drift year to year and history `team_key` is a slug of the
name, so owner continuity must come from `fantasy_managers`, NOT from team_key.
The 12 owner GUIDs landed in D1 in Step 1 — that map is now buildable.
⚠️ "Whether behaviour changed after a scoring change" cannot be answered from a
rules archive (there is none). Use stats.py's derived fits, 2022-2025 only.

## Traps already paid for — do not rediscover

1. ESPN's `mDraftDetail` is a SYNTHETIC snake; trades invisible. (ESPN only.)
2. CBS un-started drafts render a FULL grid of empty slots — parse.py now
   raises when no pick names a player.
3. Old CBS seasons return a full 100-row table of ZEROS. Coverage is gated on
   the **TOP 20** rows, not the whole list — a whole-list test rejected QB 2022,
   a COMPLETE season, because deep QB lists are mostly zero-stat backups.
4. A high R² proves nothing: a misaligned column map scored 0.999 while
   claiming 5.15 pts per rushing yard. `implausible()` bounds are the guard.
5. Stats column layout is POSITION-DEPENDENT (QB has no receiving group; WR
   orders Receiving before Rushing) and each group carries a derived `Avg`
   that must be dropped. Map from the group banner's COLSPANs.
6. Usable stats seasons: **2022-2025 only** (2019 and earlier are too sparse).
