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
rich week-level detail and almost no history. Yahoo has nothing at all — the
agreement went effective 2026-08-21 and **no live Yahoo call has ever been
made**.

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

### Yahoo: decide it, do not drift

Yahoo is approved but empty, and an empty league silently absorbs attention.
Either run the first live OAuth and backfill it, or write it down as dormant.
The half-state is the expensive one.

---

## 5. Immediate next steps

| # | do | why |
|---|---|---|
| 1 | League registry | Everything else depends on it |
| 2 | `build_board.py --league espn` | Scoring is solved; ESPN has no board |
| 3 | CBS transaction ingestion | Only league with no waiver data, and its draft is 8 Sep |
| 4 | Name the 11 remaining ESPN stat ids | 0.63 pt/wk residual on QBs; MFL `detailed?` has the TD lengths |
| 5 | Yahoo: run it or park it | Stop paying attention to a maybe |
