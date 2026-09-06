# Three leagues, one blueprint

**Written 2026-08-28.** There was no cross-league breakdown before this file —
`espn_pigskin_playbook.md`, `cbs_draft_plan_worklist.md` and
`yahoo_fantasy_ingestion.md` each cover one league, and two more docs cover the
plumbing, but nothing compared the three or said how the analysis should relate.
That gap is why the same work kept getting rebuilt.

**The thesis:** the *rulebooks* must stay rigidly separate — they are different
games. The *method* should be identical everywhere. Today it is neither: CBS has
eighteen bespoke analysis scripts, ESPN has two, Yahoo has none, and the CBS
scripts are a general engine wearing one league's name.

---

## 1. The three leagues

| | **CBS — Greatness League** | **ESPN — 16th Pigskin Classic** | **Yahoo** |
|---|---|---|---|
| Key | `ffl.s2026.l.grffl` | `ffl.s2026.l.176898` | — |
| Teams | 12 | 12 | — |
| Draft | live, 8 Sep 2026, 18 rd | **OFFLINE** (manual), 16 rd | — |
| Keepers | **none** | **1 per team** | — |
| Starters | QB1 RB2 WR2 TE1 **FLEX1 K1 DST1** | QB1 RB2 WR2 TE1 **FLEX2 DST1** | — |
| Bench | 9 | 7 | — |
| Kicker | **yes** | **no** | — |
| Playoffs | week 15, 6 teams | week 14, 6 teams | — |
| Waivers | waivers | **FAAB $100** | — |

### Scoring — the reason a shared board is impossible

**CBS grffl's identity is per-position scoring.** Out-of-position touchdowns pay
**exactly double**, and it is the only league here that does anything like it:

| | QB | RB | WR | TE |
|---|---|---|---|---|
| Passing TD | 4 | **8** | **8** | **8** |
| Rushing TD | **12** | 6 | **12** | **12** |
| Receiving TD | **12** | **12** | 6 | 6 |
| Reception | 1.0 | 1.0 | 1.0 | **1.5** |

⚠️ The base `Recpt` row is **NULL**, not 0 — receptions exist only as
per-position overrides. Reading the base rate as zero silently un-PPRs the
league.

**ESPN Pigskin is flat full PPR**, no positional overrides:
passing TD 6, rush/rec TD 6, all yards 0.1, reception 1.0, INT −2.

| | CBS | ESPN |
|---|---|---|
| Passing yards | 0.04 (**hidden `per` divisor** — 0.1 per 2.5 yds) | **≈0.054, fitted** |
| Passing TD | 4 (6 under vote) | 6 |
| Sacks taken | — | **−1.0** (recovered, names id 64) |
| Per-position overrides | **yes, extensive** | none |

Two rules were never published and had to be **recovered from data**: CBS's
`per` divisor (found by fitting, then confirmed on the rules page) and ESPN's
passing-yards multiplier (fitted against ESPN's own published points, validated
on 1,371 non-passers whose residual is 0.000). See
`scripts/espn_solve_scoring.py`.

---

## 2. What actually exists

### Data in D1

| | CBS | ESPN | Yahoo |
|---|---|---|---|
| Standings history | **2003–2026 (24 seasons)** | 2025–2026 | — |
| Teams | 2003–2026 | 2025–2026 | — |
| Draft events | 2021–2025 (216/season) | — | — |
| Matchups | 2026 only (6) | 2025 (101), 2026 (84) | — |
| Transactions / waivers | **none** | 2025 (573) | — |
| Roster snapshots | **none** | 2025, 2026 | — |
| Weekly points | **none** | 2025, 2026 | — |
| League settings + scoring | 2026 | 2025, 2026 | — |

**The asymmetry is exactly inverted between the two live leagues.** CBS has two
decades of *outcomes* and almost no week-level detail. ESPN has two seasons of
rich week-level detail and almost no history.

⚠️ **Two provenance facts that matter for reproducing any of this:**

- CBS's 2003–2025 standings and its 2007–2025 draft history were written by
  `scripts/cbs_history_backfill.py` **scraping HTML**, not by the provider
  adapter — `CbsProvider.fetch_standings` and the current-season draft branch
  both raise. The pipeline cannot regenerate that data; the script can.
- `fantasy_player_week_stats` is **empty for every platform.** There is no
  per-stat breakdown anywhere in D1. Every scoring question is answered by
  joining out to `nfl_player_weekly`, which is why the ESPN passing-yards fit
  was possible at all.

### Analysis tooling — 18 / 2 / 0

CBS: board, projected board, round plan, draft list, ADP value, draft history,
owner head-to-head, rules scenario, TD-bonus measurement, undrafted-value
reconstruction, analyst reconciliation, verified-take extraction, history
backfill.
ESPN: keeper valuation, scoring solver.
Yahoo: nothing.

⚠️ **Most of the CBS scripts are not really CBS scripts.** "Rank players under
this league's own scoring", "plan a round given ADP and a roster shape", "value
a draft slot", "reconcile an analyst's list against a board" are league-agnostic
questions wearing a `cbs_` prefix and a hardcoded `LEAGUE_KEY`.

---

## 3. What must stay separate, and what must not

**Separate — always, no exceptions.** These are the league. Sharing any of them
produces a board that is confidently wrong:

- the scoring table, including per-position overrides
- roster shape: flex count, kicker, bench depth → **replacement level**
- keeper rules
- draft length and format
- playoff start week (changes which weeks a player is drafted *for*)

**Shared — should be, and mostly is not.** These are about football, not about
a league:

- **player projections** (raw stat lines — scored per league afterwards)
- **the analyst layer**: JJ / Barrett / Silva takes are about players. 111
  verified takes and a 250-player cheat sheet currently serve one league.
- **ADP ingestion**, though the *source* is a per-league choice (below)
- **the method**: VOR against a league-specific replacement, marginal value of
  not waiting, backing scored per analyst not per take
- **the discipline**: no fail-open, NULL ≠ 0, verify before attributing

⚠️ **ADP source is a per-league setting, not a global.** JJ reads FantasyPros;
the boards are cut on FantasyFootballCalculator; **27 of 41 verified round calls
land in a different round under the two**. An ESPN league drafting offline and a
CBS league drafting live are not pricing against the same market.

---

## 4. Recommendation

### Do not run three separate chats for the analysis

Separate chats are right for **draft night** — one league, one clock, no
cross-talk. They are wrong for everything else, and the evidence is this
session: work got rebuilt because it lived in a conversation instead of the
repo. Three chats triples that failure.

**The unit of separation should be a config row, not a conversation.**

### Build a league registry

One file — `docs/leagues.yaml` or a `fantasy_league_profile` table — carrying
per league: platform, key, ADP source, draft date and format, keeper rules,
roster shape, scoring source, and which analyst sources apply. Every script
takes `--league` and reads from it. Nothing hardcodes `grffl` again.

### Then generalise, in this order

1. **`cbs_projected_board.py` → `build_board.py --league`.** It already scores
   from a D1-loaded table; the CBS-ness is a constant and a `TD_BONUS` dict.
   Unlocks a real ESPN board immediately — the scoring blocker is gone.
2. **`cbs_round_plan.py` → `round_plan.py --league`.** Already takes slot,
   teams and rounds as arguments. Needs the roster target and windows moved
   into the registry.
3. **`cbs_draft_list.py` → `draft_list.py --league`.** The analyst layer it
   renders is already league-agnostic.
4. **Waiver analysis both ways.** ESPN's FAAB study is the better artifact and
   CBS has no transaction data at all; CBS's undrafted-by-subtraction trick is
   the better *method* and ESPN never needed it. Each league is missing the
   other's.

### In-season, the shared spine

The weekly questions are identical across leagues; only the scoring changes:

- **start/sit** — project, score under that league's table, rank against that
  league's flex count
- **waiver targets** — ESPN needs FAAB price context (that data exists);
  CBS needs transaction ingestion first (it does not exist)
- **the analyst layer refreshes once**, then reconciles three times

### Yahoo: it is not a to-do, it is blocked upstream

⚠️ **Correcting an earlier reading of my own.** "Approved but never run" implied
someone just needs to run it. That is wrong. Verified live 2026-08-12 **and
retested 2026-08-28 with the identical result, nine days after the agreement
went effective**:
`/oauth2/request_auth` with `scope=fspt-r` returns **`invalid_scope` before the
consent screen** because the app lacks approval at
`sports.yahoo.com/developer/access`. **No code change can fix this** — the
executed API agreement and the app-level scope grant are two different things,
and only the second one is missing.

The irony is sharp: **Yahoo is the most complete adapter of the three** — 13 of
14 ABC methods, the only one with full draft *and* transaction *and* per-stat
parsing, and the only one that derives its week bounds from league settings and
refuses when they are unknown rather than assuming `range(1,19)` the way ESPN
does. It is the best-built and the least usable.

So: **park it explicitly.** Chase the developer-access grant as a separate
errand with its own outcome, and stop counting Yahoo in any plan until the
scope is actually issued. One more thing worth knowing before it is —
`fetch_players` refuses by design (`OutsideApprovedUseCase`, Exhibit A §2.c.x):
compiling the league-wide player universe breaches the agreement, and the
docstring specifically forbids re-enabling it behind a page cap.

---

## 5. Immediate next steps

| # | do | why |
|---|---|---|
| 1 | League registry | Everything else depends on it |
| 2 | `build_board.py --league espn` | Scoring is solved; ESPN has no board |
| 3 | CBS transaction ingestion **via HTML** | Only league with no waiver data, draft is 8 Sep. ⚠️ Not an API job: every `/league/transaction*` spelling 404s, so this is the scraper path like the history backfill |
| 4 | Name the 11 remaining ESPN stat ids | 0.63 pt/wk residual on QBs; MFL `detailed?` has the TD lengths |
| 5 | Yahoo: file the developer-access request | Blocked upstream, not on us; park it until the scope is granted |
| 6 | ESPN `fetch_draft_results` | Raises today, so ESPN has no draft data at all — `mDraftDetail` exists and is expected to work |
