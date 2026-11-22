# Data change-and-dependency log

One entry per data change, finding or decision that can affect other work. Newest first. Keep entries short; link the evidence. Agent entries are status, not Keith rulings. A Keith ruling is recorded only with a link to where he gave it.

Format: **date · type** (finding / change / decision / dependency) · what · why · evidence · work that may be affected · status.

---

**2026-11-22 · correction** · The #1399 bot comment reports 13 safe-suite failures on `main` `bc607887`. A clean local run at `52338bf9` (the same code plus docs) passed 275 with 0 failures. · The bot-cutover job likely runs in the stale, dirty Mac checkout (inferred). · Local run log. · The trade-bot valuation snapshot delivery that the cutover job gates. · Open; tied to P0-5.

**2026-11-21 · finding** · J3 roster anomaly check red on false positives since 11-19 (17 flags, sampled 4, all explained by `BBID_WAIVER` drops in the same snapshot). · Its departure-type list omits blind-bid waivers. · `pipelines/etl/scripts/check_roster_anomalies.py:314`; runs 44590405939, 44788768764, 44927399437. · Every consumer that trusts "J3 green" as proof of no silent roster/contract change (contract integrity, FO, mobile beta parity). · Open; fix proposed (P0-1).

**2026-11-21 · finding** · R2 daily snapshot can be partial or hold MFL error bodies yet be marked complete. · `_snapshot_meta.json` is written regardless of part failures and the hourly retry checks only that file. · `worker/src/index.js:494-559, 8655-8676`. · Drop-penalty pricing (`cap.penalty_quote`, drop tracker), waiver card. · Open (P1-7, needs go for a worker change).

**2026-11-21 · finding** · `player_contracts` and `player_contract_stints` are served on the player profile but have no writer or migration in the repo. · Provenance unrecorded; related reconstruction preserved inert in #1491. · `worker/src/index.js:15483-15497`; `site/shared/player_profile_master.js:540`; `docs/specs/contract_stints_integration.md`. · Mobile beta contract card and history, FO player panel, UPS 2.0 Release 5, contract authority decision. · Open; production audit needs Keith's go.

**2026-11-21 · finding** · `etl_runs` freshness stamps come from 2 sources only (nflverse refresh, Discord reconcile). · Other jobs never stamp it. · `rg etl_runs` over `pipelines/`, `.github/`, `scripts/`. · AI desk `data.freshness()`, Stats freshness chips, v8 Release 2 "as of" requirement. · Open (P1-6).

**2026-11-21 · finding** · Mac LaunchAgents write production D1 (`src_weekly`, standings) and run from the main checkout at `55ba66be`, 35 commits behind `origin/main`, 7 uncommitted files. · Checkout is not auto-updated. · `~/Library/LaunchAgents/com.upsmfl.live-season-sync.plist`; `git -C ~/Code/MFL/upsmflproduction`. · Standings, scores, Stats, AI history tools. · Open (P0-5, needs go).

**2026-11-21 · finding** · One-time 2026-09-07 deadline-drop LaunchAgent still loaded and running daily (aborts each time). · No completion file written because it never completed. · `com.keith.mfl.deadline-drop`. · League operations (roster writes). · Decision asked of Keith.

**2026-11-21 · finding** · D1 usage on UTC day 2026-11-21: 3,246,351 rows read (64.9% of Free), 28,072 written (28.1%). · Baseline for UPS 2.0 budget planning. · `python3 scripts/d1_usage.py 1d` at 01:18Z 11-22. · Any new D1 consumer (AI desk, League Record, mobile beta). · Recorded.

**2026-11-21 · correction** · A sub-agent reported the salary-adjustment ledger as stale (static file last 10-06). Rechecked: the route reads D1 `ups_drop_events` and uses the static report only for 2025-era details. · `worker/src/index.js:53003-53100`. · AI desk `cap.adjustments`. · Not a risk; recorded so it isn't re-raised.

**2026-11-21 · dependency** · `worker/wrangler.preview.toml` binds the production D1 database id. · Any preview deploy shares production data and budget. · `worker/wrangler.preview.toml:24-26`. · Mobile beta previews, AI desk previews, v8 test-environment decision. · Open question for v8.
