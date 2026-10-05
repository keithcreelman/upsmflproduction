# DATA AUTHORITY MAP — UPS MFL Production

**Generated:** 2026-05-29
**Purpose:** The single answer to "who owns this fact?" for every piece of data in the platform. This is the SSOT for source-of-truth decisions.
**Why it exists:** The recurring "fix one thing, break another" pain is, at root, an *authority* problem. When two systems both believe they own the same fact (e.g. MFL's division setup vs. a stale UPS standings snapshot — the V2 division bug), they drift, and a fix on one side silently breaks the other. This doc removes that ambiguity.

**Relationship to existing docs:** This operationalizes and extends `docs/ups_v2/V2_GOVERNED/data/source_of_truth_matrix.csv` (the V2 governance registry of 25 entities) and `docs/ups_v2/V2_GOVERNED/stats_sources_of_truth.md` (stats authority). Those remain the formal registry; this is the working map. Keep them consistent.

---

## The principle (one rule that resolves everything)

> **MFL is authoritative for every fact it exposes via API. UPS owns ONLY what MFL cannot model: league-invented rules, derived contract structure, and audit trails. On any conflict over an MFL-owned field, MFL wins — and UPS flags the disagreement rather than silently trusting its own copy.**

Concretely:
1. If MFL has an API for it → **pull it live, never keep a competing source.** A local copy is allowed only as a read-through cache or a parsed mirror, never as an independent authority.
2. If MFL has no API for it (cap rules, TCV/earned/guarantee, tag/MYM/restructure history, advanced stats) → **UPS owns it.**
3. When UPS-derived data references an MFL-owned field, UPS **reconciles on read**: compare to MFL; if they disagree, surface a flag. Never let the stale copy win quietly.

**Backup ≠ authority.** Keeping a historical record is allowed and encouraged — it's how we flag anomalies and validate transactions. The rule (Keith 2026-05-29): **pull rosters daily and store the daily *delta*, not a fresh full copy each day.** The diff is the backup + the anomaly detector — an unexpected roster/salary/contract change that doesn't match a known transaction gets flagged. The delta store is a *backup/audit*, never the authority MFL reads are served from. (`mfl-daily-snapshot.yml` already commits daily snapshots with git delta-compression; the missing piece is the anomaly/transaction-validation pass on top — see Drift hotspots + `FOLLOWUP_TASKS_2026-05-26.md`.)

---

## Authority table

### A. MFL-authoritative — pull live, never compete

| Fact | MFL API (`TYPE=`) | UPS store today | Conflict rule |
|---|---|---|---|
| Player ownership / roster composition | `rosters` | live pull | MFL wins |
| Current salary, years-remaining, status label | `salaries` (`salary`, `contractYear`, `contractStatus`) | `src_contracts` (mirror) | **MFL wins; flag drift** |
| Structured contract (`contractInfo` free text) | `salaries` (`contractInfo`) | `src_contracts` + audit tables | **MFL wins; flag drift** (see §Contracts) |
| Transactions (add/drop/trade/waiver) | `transactions` | `src_adddrop`, `src_trades` (mirror) | MFL wins |
| Draft results / future picks | `draftResults`, `futureDraftPicks` | `src_draft_picks` (mirror) | MFL wins |
| **Divisions, franchise names/icons, roster & cap limits, league settings** | `league` | ⚠️ snapshotted | **MFL wins — currently snapshotted, this is the V2 bug. Make read-through.** |
| Raw standings (W/L/PF/PA) | `leagueStandings`, `weeklyResults` | recomputed in `src_final_standings`, `src_franchise_weekly_score` | MFL wins on raw results; UPS owns the ranking layer (below) |
| Injuries | `injuries` | live pull | MFL wins — designate as the **SSOT for injury status** (lineup-compliance DM + injury module + player modal) |
| Free agents | `freeAgents` | live pull | MFL wins |
| Pending trades | `pendingTrades` | live pull | MFL wins |
| Calendar / event dates | `calendar` | live pull | MFL wins (deadlines also cross-checked vs. Discord) |
| Scoring rules | `rules` | pulled for IDP weighting | MFL wins |
| User → franchise identity | `myleagues`, `myfranchise` | live pull | MFL wins |
| Player master / profile / scores | `players`, `playerProfile`, `playerScores` | mirror for analytics | MFL wins |

### B. UPS-authoritative — MFL has no API for these (legitimately ours)

| Fact | Why MFL can't hold it | UPS store |
|---|---|---|
| League rules (cap math, eras, FL/BL, MYM/restructure/tag/ERA mechanics) | League-invented, not a fantasy-platform concept | `docs/league_context_v1.md` (canonical) |
| Contract **structure derivation** (TCV, AAV, year schedule, earned-to-date, guarantee, cap-hit-on-cut) | MFL stores only salary + cy + free-text; no structured model | `player_acquisition_cycles`, parsed from `contractInfo` (see §Contracts) |
| Cap penalties / salary adjustments (per-era curves, `(TCV×75%)−Earned`) | Formula is UPS-specific | `player_acquisition_cycles`, `cap_penalty_rule_eras` — **but the computed adjustment is written BACK to MFL** as `salaryAdjustments` (via the drops flow AND via BB/blind-bidding traded-salary moves). So UPS owns the *math*; MFL stores the *result*. Once written, MFL's `salaryAdjustments` is the authority for the dollar value. |
| Tag / MYM / Restructure / Extension **audit trails** (who did what, when, before→after) | MFL keeps current state only, no history | `ups_tag_submissions/master`, `ups_extension_submissions/master` |
| Standings **ranking layer** (All-Play %, playoff seeding, division power rankings, tiebreakers) | UPS-specific tiebreak/seeding logic | standings builders + worker endpoints |
| ERA eligibility classification | UPS rule | `ups_era_pool` |
| Cap penalty / drop ledger + Discord state | UPS process | drop-events tables, Discord tables |
| League governance (Hall proposals/votes) | UPS process | `hall_proposals`, `hall_responses` |

### C. External-authoritative — neither MFL nor UPS-invented

| Fact | Source | UPS store |
|---|---|---|
| Advanced stats (EPA, snaps, routes, redzone, YOE) | nflverse / PFR | `nfl_player_*` tables |
| ADP | external ranking feed | auction value model inputs |
| Player news | RSS (Yahoo/PFT/PFR/CBS/Reddit) | news warmer cache |
| Keith's Yahoo fantasy league (drafts, transactions, weekly rosters, matchups, standings) | Yahoo Fantasy Sports API (read-only, OAuth `fspt-r`) — **gated, not yet approved** | `fantasy_*` tables (35, migrations 0127-0132) + `raw_yahoo_api_responses`. **Yahoo wins on every field it exposes; a value we reconstruct is flagged `is_inferred`/`*_derived` and never overwrites a provider column.** ⚠️ A different league on a different platform — it must never read or write `ups_*`/`src_*`/`mfl_*`/`nfl_*` (sole crossing point: the read-only identity crosswalk in 0132). See `docs/yahoo_fantasy_ingestion.md`. |

---

## Contracts — the field that makes MFL authoritative after all

MFL's `salaries` export gives four per-player fields: `salary`, `contractYear` (years remaining), `contractStatus` (label), and **`contractInfo` (free text, 256 chars)**.

The key fact, confirmed with Keith 2026-05-29: **the UPS submission flow writes the full structured contract into `contractInfo`** (e.g. `CL 4| TCV 100K| AAV 25K| Y1-30K| Y2-35K| Y3-20K| Y4-15K`). That means **MFL holds the authoritative contract structure** as text. The architecture is therefore:

- **MFL = authoritative store.** The structured `contractInfo` on MFL is the canonical contract.
- **D1 = parsed mirror + audit.** `src_contracts` parses the Y-tokens; `ups_extension_submissions`/`ups_tag_*` record the before→after history MFL doesn't keep.
- **UPS forms = the single capture point.** Owner submits once; UPS writes MFL + D1. No hand-entry.

**Conflict rule for contracts:** MFL's `salary` + `contractYear` + `contractInfo` win. D1 is never the authority — it's a convenience mirror. A reconciliation job (see Contract Automation Plan) re-parses MFL `contractInfo` and flags any row where D1's derived structure disagrees, so drift is caught, not trusted.

This is why contracts are NOT actually an exception to the principle: MFL *does* hold the data, in `contractInfo`. The only genuinely-UPS-owned part is the *derivation math* (earned, guarantee, cap-hit) and the *audit history* — neither of which MFL models.

---

## The three drift hotspots to fix (these cause regressions today)

0. **No daily roster anomaly/transaction-validation pass.**
   `mfl-daily-snapshot.yml` commits the daily delta, but nothing *reads* the diff to flag anomalies (a salary/contract/roster change with no matching transaction). **Fix:** add a daily job that diffs today's roster/salary pull vs. yesterday and flags any change not explained by a known MFL transaction. This is both the backup and the early-warning system. → `FOLLOWUP_TASKS_2026-05-26.md` §J.

1. **League settings / divisions are snapshotted, not read-through.**
   The V2 standings page reads a stale divisions snapshot, so your division update didn't appear. **Fix:** standings (and any consumer of franchise/division/limit data) must read `TYPE=league` live (or via a short-TTL cache that re-pulls), never a hand-refreshed snapshot. → tracked in `FOLLOWUP_TASKS_2026-05-26.md` §J (schedule audit) + the standings module.

2. **Standings recomputed from raw results without a clean authority boundary.**
   Keep the boundary explicit: MFL owns raw W/L/PF/PA + divisions; UPS computes ONLY the ranking/seeding layer on top. The UPS layer must take raw results + divisions live from MFL each run.

3. **`src_contracts` mirror can drift from MFL `contractInfo`.**
   Acceptable as a mirror, dangerous as an authority. The reconciliation-on-read flag (Contract Automation Plan) closes this.

---

## How to use this map

- **Before adding a feature that reads data:** look it up here. If it's MFL-authoritative, wire it to a live pull (or read-through cache), not a stored copy.
- **Before adding a feature that stores data:** confirm it's in section B or C. If MFL already serves it (section A), do NOT create a parallel store — consume MFL.
- **When a number looks wrong on a page:** check whether the page reads live MFL or a snapshot. Stale snapshot of an MFL-owned fact is the #1 cause.
- **Keep `source_of_truth_matrix.csv` in sync** when authority decisions change.
