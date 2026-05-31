# Scheduled Data Pipeline — Audit & Cadence (§J)

**Created:** 2026-05-30. **Owner:** Keith. **Scope:** every recurring data job + every `pipelines/etl/scripts/*` that produces data a live feature reads. Answers "what runs when, from what source, and where does data silently drift?"

> Why this exists: the Standings V2 "divisions didn't update" bug was a *class* of bug — a builder that isn't scheduled, so MFL's updated data never re-renders. This audit fixes the class: it maps cadence, finds the drift gaps, and separates "schedulable now" from "blocked on the local-DB dependency."

---

## TL;DR — the three findings that matter

1. **The local-DB bottleneck.** ~20 builders read Keith's local `mfl_database.db` (Desktop). They **cannot run on GitHub-hosted runners** — they hard-code `/Users/keithcreelman/...` or gate on a `MFL_DB_PATH` secret that doesn't exist on `ubuntu-latest`. This is *why* they're unscheduled. The fix is porting each to MFL-API/D1 sources (the "move the fetcher" thread from `DATA_AUTHORITY_MAP.md`), not just adding a cron.
2. **`refresh-acquisition-hub.yml` runs hourly but silently skips.** It's local-DB-bound (`MFL_DB_PATH`), so on `ubuntu-latest` it prints "skipping" and no-ops every hour. The Acquisition Hub artifacts are **not** being auto-refreshed.
3. **`snapshot_franchise_assets.py` is MFL-API-native and was 20 days stale.** It feeds the live rookie hub (`franchise_assets_2026.json`); a manual run on 2026-05-30 produced 1,935 insert / 1,141 delete lines vs. the committed copy (last built 2026-05-10). It needs no local DB → **scheduled in `nightly-builders.yml` (this change).**

---

## §1 — Cadence table (what runs when)

| Workflow | Cron (UTC) | Runner | Source | Writes | Actually runs? |
|---|---|---|---|---|---|
| `mfl-daily-snapshot.yml` | `5 9 * * *` | ubuntu | MFL API | raw JSON → git (`data/mfl-snapshots/`) | ✅ yes |
| `nightly-config-sync.yml` | `30 9 * * *` | ubuntu | MFL API + cookie | D1 `src_franchises`, `src_league_season_meta` | ✅ yes |
| `refresh-mym-dashboard.yml` | `20 * * * *` | ubuntu | MFL API | MYM dashboard | ✅ yes (MFL-API native) |
| `refresh-acquisition-hub.yml` | `15 * * * *` | ubuntu | **local DB** | `site/acquisition/*` | ⚠️ **skips** (no local DB on runner) |
| `nightly-builders.yml` *(new)* | `45 9 * * *` | ubuntu | MFL API | `site/rookies/franchise_assets_2026.json` | ✅ yes |
| `log-*.yml` (×6) | event (`repository_dispatch`) | ubuntu | worker payload | D1 submissions | ✅ on submit |
| `deploy-worker` / `pages-deploy` / `purge-jsdelivr` | on push | ubuntu | — | deploys | ✅ on push |
| `post-deadline-reminders.yml` | manual only | ubuntu | — | Discord | cron retired (manual) |

**Daily window (UTC):** 09:05 snapshot → 09:30 config-sync → 09:45 builders. Hourly: mym :20, acquisition :15 (skips).

---

## §2 — Data-producing script classification

Legend: **Live** = a deployed feature (worker route or `site/` file the frontend fetches) reads the output. **CI?** = can run on a GitHub-hosted runner today (no local-DB dependency).

### A. MFL-API native — schedulable on GitHub CI
| Script | Output | Live? | Scheduled? | Note |
|---|---|---|---|---|
| `sync_config_to_d1.py` | D1 `src_franchises`, `src_league_season_meta` | ✅ | ✅ nightly | the model for this pattern |
| `refresh_mym_dashboard_from_mfl.py` | MYM dashboard | ✅ | ✅ hourly | |
| **`snapshot_franchise_assets.py`** | `site/rookies/franchise_assets_2026.json` | ✅ rookie hub | ✅ **new** | was 20 days stale |
| `build_standings_snapshot.py` | `site/standings/standings_74598_*.json` | ❌ **vestigial** | manual | standings now read **live** from the worker — retire or repurpose |
| `build_roster_acquisition_lookup.py` | analysis | ❌ | manual | not live |
| `sync_mfl_roster_membership.py` | local DB | ❌ | manual | writes local DB only |

### B. Local-DB-bound — blocked on GitHub CI (need porting to MFL/D1)
| Script | Output | Live? | Drift risk |
|---|---|---|---|
| `build_acquisition_hub_artifacts.py` | `site/acquisition/*` | ✅ | **high** — "scheduled" but skips |
| `build_player_id_crosswalk.py` | D1 `player_id_crosswalk` | ✅ worker reads | med (player adds) |
| `build_rookie_draft_hub.py` | `site/acquisition/rookie_draft_history.json` | ✅ rookie hub | med (draft season) |
| `build_stickiness_report.py` | D1 `metric_stickiness` | ✅ worker reads | low (analytics) |
| `build_roster_points_history_json.py` | D1 | partial | low |
| `build_early_projection*.py` | D1 `early_projection_*` | ❌ (no worker ref yet) | n/a until wired |
| ~15 analysis builders (`build_historical_records`, `build_player_scoring_report`, `build_salary_adjustments_report`, `refresh_prospects`, …) | local DB / docs | ❌ | n/a (analysis) |

### C. Event-driven — correct as-is (no cron needed)
`sync_contract_activity_to_db.py`, `sync_restructure_submissions_to_db.py`, and the `log_*.py` chain fire on `repository_dispatch` when an owner submits. D1 `contract_submissions` / `restructure_submissions` stay current by event, not schedule.

---

## §3 — Gaps & recommendations (priority)

1. **DONE (this change): schedule `snapshot_franchise_assets.py`** via `nightly-builders.yml` — fixes demonstrated 20-day staleness in the live rookie hub.
2. **Fix `refresh-acquisition-hub.yml`'s silent skip.** It can't work on `ubuntu-latest`. Options: (a) port `build_acquisition_hub_artifacts.py` to MFL-API/D1 and add to `nightly-builders.yml`; (b) move it to a self-hosted runner on Keith's machine; (c) if the hub is dormant, retire the cron. **Recommend (a)** — aligns with the data-authority direction.
3. **Retire / repurpose `build_standings_snapshot.py`.** Its `standings_74598_*.json` output has no live reader (worker serves standings live). Keep the script only as the scoped-standings algorithm reference (per `STANDINGS_SCOPE_BUILD.md`).
4. **Port the worker-read local-DB tables** (`player_id_crosswalk`, `metric_stickiness`) to an MFL-API/D1 builder so the worker never reads a table that only a Desktop run can refresh.
5. **Install the two drift safety nets (§4).**

---

## §4 — Drift safety nets (J3 / J4) — spec, next build

These never auto-overwrite; they **flag** so a human decides. Both are MFL-API native (CI-runnable).

**J3 — Roster/transaction anomaly check (daily).** Per `DATA_AUTHORITY_MAP.md` drift hotspot #0. Diff today's MFL `rosters` + `salaries` pull vs. yesterday's snapshot; for every roster/salary delta, require a matching MFL `transactions` row. Anything unexplained → flag to an ops channel/log. Catches silent roster or salary edits.

**J4 — Contract reconciliation-on-read (nightly).** Per `CONTRACT_AUTOMATION_PLAN.md`. Re-parse MFL `contractInfo` for every rostered player; compare to the D1 `ups_*` contract bookkeeping; list mismatches (salary, contract year, status). Flag only — the contract chain stays human-curated.

Both write a dated report (D1 table + optional Discord ops post). Build after this PR; they share the snapshot the daily job already pulls.

---

## §5 — `nightly-builders.yml` (this change)

Single workflow for **GitHub-CI-runnable** recurring builders, scheduled `45 9 * * *` (after config-sync at `:30`). Today it runs `snapshot_franchise_assets.py` and commits the refreshed JSON (same auto-commit pattern as `refresh-acquisition-hub.yml`). New MFL-API-native builders get added here as they're ported off the local DB — this file is the home for §3 items 2 & 4 once ported.
