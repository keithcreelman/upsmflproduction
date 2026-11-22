> Evidence appendix to `docs/data_governance/BASELINE_2026-11-21.md`. Produced 2026-11-21 by a read-only inventory pass (code at `bc607887`; GitHub run history read about 01:00Z 2026-11-22). No production D1, MFL, R2 or Discord call was made. V = verified from code, file or run log; I = inferred. Line numbers drift as code changes: recheck before acting.

# Non-D1 data assets and their consumers

- **Repo:** worktree `musing-cohen-6b2731`, branch `claude/data-infra-review-c3d85c`, HEAD `bc607887`.
- **Date:** 2026-11-21. The work was read-only: no network calls, no wrangler `--remote`, no repo edits.
- **Labels:**
  - **V** means I read the file or line, or ran a local count on it.
  - **V(agent)** means a read-only sub-agent read the line and I spot-checked some of them (marked "spot-checked").
  - **I** means inferred. The reasoning is given each time.
- **Privacy:** values and message text are never quoted. Possible private-data files are named by path and field only.

---

## 1. Committed data files

### 1A. data/**

| Family | Pattern / count / size | Dates (last commit) | Producer | Readers | Grain / keys | Private? |
|---|---|---|---|---|---|---|
| MFL daily snapshots | `data/mfl-snapshots/YYYY-MM-DD/{salaries,transactions,rosters,injuries,league,freeAgents,draftResults,weeklyResults,schedule,leagueStandings}.json` + `_snapshot_meta.json`. 213 day folders, 2,271 files, 271 MB | 2026-04-21 → 2026-11-21 (last commit 2026-11-21 16:43Z). Missing days: 2026-05-26 and 2026-06-13. weeklyResults, schedule and leagueStandings start 2026-05-15 (189 folders) [V] | `.github/workflows/mfl-daily-snapshot.yml` (cron `5 9 * * *`, public MFL exports, pretty-printed with sort_keys, pushed to main) [V] | Python only [V]: `pipelines/etl/wire/wire_data.py:39`, `ingest_mfl_snapshot_contracts.py:59`, `rebuild_valuation_snapshot.py:45` (valuation-snapshot-rebuild.yml), `extract_valuation_inputs.py:90`, `check_roster_anomalies.py:81` (roster-anomaly-check.yml), `sync_config_to_d1.py` (nightly-config-sync.yml), league-record S1 `sources.mjs:185` (other branch). The worker and site only mention it in comments (`index.js:6441`, `:43695`; `players.js:1211`) | One file per export type per UTC day, MFL export shape | Yes: may hold private data; details are kept in the private register only |
| Data-quality gap in snapshots | `injuries.json` | 115 folders (through 2026-08-15) have 0 injury rows [V count]. Root cause is documented in the workflow (sending L= gets an error envelope) [V `mfl-daily-snapshot.yml` comment] | n/a | Anything replaying injury history before 08-15 | n/a | n/a |
| DB archive | `data/db-archives/mfl_database_2026-06-05.db.gz` (44.4 MB, about 191 MB raw, 101 tables) | 2026-06-05 (`#465`) | Manual upload [V README] | `pipelines/etl/scripts/build_{auction_intel,draft_intel,ep_v5_calibration,faa_report}.py` [V grep]; league-record S1 `archive.mjs` (other branch, V(agent)) | Local SQLite copy | Yes: may hold private data; details are kept in the private register only |
| Discord export | `data/discord-archives/discord_export_2026-08-05.tar.gz` (2.3 MB, about 17 MB raw) | 2026-08-05 | Manual `dump_guild.py` with the bot token [V README] | The README says nothing reads it [V]. I found no code reference [V grep] | Message records (`author`, `author_id`, `content`, `embeds`), plus `members.json`, `roles.json` | Yes: may hold private data; details are kept in the private register only |
| Valuation snapshot | `data/valuation/trade_valuation_snapshot.json` (94 KB) | 2026-11-18 (through week 10) | `valuation-snapshot-rebuild.yml` (cron `35 */3 * * *`) → `rebuild_valuation_snapshot.py` [V] | Local Mac trade bot: `trade_grader.py`, `trade_roast_bot.py`, `pick_valuation.py`; delivered by `bot_snapshot_cutover.py` under launchd [V] | Player and pick values with `basis_text` | No |
| One-off repairs | `data/contract_repairs/aav_restore_2026.json`; `data/recovery/2026-08-2x_*.json` (5 files) | 2026-08-05 and 2026-08-25 | Hand-made | `aav-restore-2026.yml`; `restore-salaries.yml` (only `salaries_restore`). The other 4 recovery files have no code reader [V grep] | Per-player repair rows | No |
| Reviews / misc | `data/reviews/**` (CSV plus py scripts), `data/misc_data/contract_audit_2026-07-24.csv`, `data/misc_data/PFF_SeparationScore_2025.xlsx` | 2026-07-22, 2026-07-23 | Hand-made | Only PFF is read, by `build_pff_separation.py` → `site/stats_workbench/pff_separation_2025.json` [V grep]. The rest are orphaned reference files | n/a | PFF is licensed third-party data, re-published under the public site/ [I, licensing not checked] |

### 1B. site/** data files (239 json/csv; full list with size and last commit in a local file list (not committed))

The Pages root is `site/`, so `github.io/upsmflproduction/<path-inside-site>` (`pages-deploy.yml:14`, `:54`) [V].

| Family | Last commit | Producer | Readers | Notes |
|---|---|---|---|---|
| `site/trades/extension_previews_2026.json` (146 KB) | 2026-11-21 (bot) | `refresh-extension-previews.yml` (cron `20 * * * *`) → `refresh_extension_previews_json.py` [V] | Mobile `front_office_extend_submit.js:453` (github.io) V(agent); desktop `roster_workbench.js`, `v2/front_office.js`, `trade_workbench.js`; worker `index.js:25302-25309` (github.io, falls back to the `/trades/` path) [V]. `/roster-workbench` re-prices live (`recomputeExtPreviewsLive`, `index.js:48740`) V(agent) | Hourly. See the Pages-lag gap in §6 |
| `site/rookies/franchise_assets_2026.json` (185 KB) | 2026-11-21 (bot) | `nightly-builders.yml` (cron `45 9 * * *`) → `snapshot_franchise_assets.py` [V] | `rookie_draft_hub.js`, `extract_valuation_inputs.py` [V] | n/a |
| `site/rosters/contract_submissions/contract_activity_2026.json` (164 KB) | 2026-11-11 (bot) | `log-contract-activity.yml` (repository_dispatch from worker `index.js:62344`) [V] | `v2/front_office.js`, wire packs, `wire_data.py`, `sync_contract_activity_to_db.py` [V grep] | Event-driven |
| `site/rosters/contract_submissions/deadline_reminders_2026.json` | 2026-11-18 | Worker GitHub write (`index.js:28720`) [V] | `v2/front_office.js`, worker [V grep] | n/a |
| Other `contract_submissions/*` (backfill, repair, manual, phantom, test) | 2026-06-05 → 2026-09-10 | Hand-made | `*-backfill-d1.yml` / `restructure-*` workflows; `contract_log_test_2026` read by mobile `contracts.js:749` (`../contract_submissions/`, the copy in **site/contract_submissions/**, 2026-06-10); `contract_log_phantom` only by `wire_data.py` [V] | Two `contract_log_test_2026.json` copies exist (site/ and site/rosters/) [V] |
| `site/rosters/player_acquisition_lookup_2026.json` (281 rows) | **2026-03-10, newest `acquisition_date` 2025-12-28** [V] | **No producer in the repo** (grep of pipelines/scripts finds nothing) [V] | Mobile `app.js:804` (MYAC / WW gating); desktop `v2/front_office.js:181`, `:1405`; `roster_workbench.js:2820-2826`; `trade_workbench.js:1515`; `shared/player_actions_native.js:195` [V] | **Stale and orphaned.** Mobile overlays MFL transactions (`app.js:826-845`; `front_office_actions.js:325-335`; `front_office_mym_submit.js:72-80`) [V], and v2 has a similar note (`:1355`, `:2273`). For `roster_workbench.js`, `trade_workbench.js` and `player_actions_native.js` I did not verify a mitigation [I] |
| `site/ccc/tag_tracking.json` (765 KB) | 2026-03-09 | Local `build_tag_tracking.py` via `scripts/build_tag_tracking_live.sh` / `run_pipeline_live.sh` (hand run) [V grep] | Mobile `app.js:601`; `front_office_tag_submit.js`; `player_sheet.js`; desktop roster workbench; worker `/admin/health-summary` (`TAG_TRACKING_FALLBACK_URL`, `index.js:30430`) [V] | Hand-refreshed. Correct for the 2026 tag window; 2027 needs a rebuild [I] |
| `site/ccc/tag_submissions.json` | 2026-02-16 | `build_tag_submissions_json.py` (local) [V grep] | Mobile `app.js:1172`, `views/tagging.js`, `player_sheet.js`; `roster_workbench.js` [V] | Hand-refreshed. Tag submissions now also go to D1 (`tag-backfill-d1.yml`) [I] |
| `site/reports/salary_adjustments/salary_adjustments_YYYY.json` (2012, 2017–2026) + manifest + 2025 mismatch csv/json | 2026 file 2026-10-06; others 2026-03-17 | `build_salary_adjustments_report.py` (local, `run_pipeline_live.sh`) [V grep] | Mobile `app.js:1159` (fetched but left out of the total, `front_office_cap.js:126-128`) V(agent); desktop roster workbench / front office / trade workbench; worker `/api/salary-adjustments/ledger` `index.js:53084` (github.io, `cacheTtl` 300, for 2025-era adddrop ids) and `/admin/import-drop-penalties` `index.js:55637` [V] | Hand-refreshed. The 2026 file is about 6 weeks old [V date] |
| `site/rosters/player_points_history.json` (962 KB) | 2026-03-27 | `build_player_points_history_json.py` (local) [V grep] | `roster_workbench.js`; worker ERA pool via **jsDelivr** `@UPS_RELEASE_SHA` (`index.js:55057`, `cacheTtl` 600; on failure, PPG is null) [V]; `yoy_signals.py` | Hand-refreshed, no 2026 season data [I from date]. My memory notes say jsDelivr 403s this repo [I, not network-verified] |
| `site/auction/curated_gifs.json` | 2026-07-14 | Hand-made | Worker via jsDelivr (`index.js:6641`, `:11455`, 60 s memo) [V] | Same jsDelivr risk [I] |
| `site/mcm/mcm_{seed,votes,nominations}.json` | 2026-02-16 | `log-mcm-*.yml` → `log_mcm_*.py` [V] | Worker `index.js:9538-9540` fetches `github.io/upsmflproduction/**site/**mcm/...`. That `site/` prefix is wrong for a Pages root of site/ [V path], so it would 404 and `fetchJson` returns the fallback [I]. Also read by `services/mcm/api/mcm_api.py` | Probable broken URL |
| Acquisition Hub artifacts (`rookie_draft_history.json`, `free_agent_auction_history.json`, `expired_rookie_history.json`, `waiver_history.json`, `manifest.json`) | Moved to `site/_archived/2026-05-12/acquisition/` (`02d3fde5`, 2026-05-13); **`site/acquisition/` no longer exists** [V] | `refresh-acquisition-hub.yml` (cron `15 * * * *`) needs secret `MFL_DB_PATH` on the runner and otherwise exits 0 [V] | Worker `fetchArtifactJson` (`index.js:25719-25775`) tries `github.io/.../acquisition`, `raw.githubusercontent/.../site/acquisition` and `.../site/acquisition`, all paths that no longer exist [V paths]. Callers: `buildRookieDraftLivePayload` `:27300`, rookie contract plan `:27896` (falls back to `{}`), `/acquisition-hub/rookie-draft/history` `:42832` (returns 502), `:27948`, `:42875` [V]. Mobile `auction.js:349` calls `/acquisition-hub/<kind>/live` V(agent) | **Orphaned reader.** The hourly job is a no-op [I] |
| Rookie hub (`site/rookies/*`) | 2026-04-20 → 2026-07-21 | `build_rookie_draft_hub.py`, `fetch_external_adp.py`, `refresh_prospects.py` (local) [V grep] | `rookie_draft_hub.js`; mobile `app.js:677` and `views/draft.js` (prospects); worker `index.js:14718` (`github.io/.../rookies/rookie_draft_history.json`, `cacheTtl` 86400, correct path) [V] | `rookie_draft_day_trades.json` has 13 non-empty trade `comments` [V count] |
| Standings (`site/standings/standings_<lid>_<yr>.json` ×21, `h2h_history.json`, `allplay_history.json`) | Per-season files 2026-02-17/24. `standings_74598_2026.json` meta `generated_at_utc` 2026-02-24 [V]. h2h 2026-10-17 (`through_season` 2025, built from D1 `src_schedule`) [V]. allplay 2026-10-26 | `build_standings_snapshot.py`, `build_h2h_history_json.py`, `scripts/build_allplay_history.py` [V grep] | `standings/mfl_hpm_standings.html:1139` (V1; v2 is embedded via `header_custom_v2.html:4129`); mobile `league.js:638` + `shared/standings_race.js` (h2h); `mfl_hpm_standings_v2.html` (allplay) [V] | The 2026 per-season file is a pre-season snapshot. Only V1 reads it [I: I did not confirm V1 is still linked] |
| `site/champions_panels.json` | 2026-02-16 | `build_champion_panels_json.py` [V] | Mobile `league.js:485`, header [V] | Annual, fine |
| `site/m/data/rules.json` + `rules_data.js` | 2026-10-23 | `scripts/build_rulebook_data.py` via `rulebook-build.yml` [V] | Mobile `views/rules.js:24` V(agent); AI desk `data/rules_data.js` (other branch) | See §5 |
| `site/reports/player_scoring/player_scoring_{2024,2025}.json` (5.6 MB each) | 2026-03-09 | `build_player_scoring_report.py` | `player_scoring.js`, worker reference, `extract_valuation_inputs.py` [V grep] | Finished seasons, fine |
| `site/stats_workbench/*` | 2026-06-30 / 07-02 | `build_nfl_xfp.py`, `build_pff_separation.py`, `build_prospect_profile.py` | `stats_workbench.html` [V grep] | PFF licensing [I] |
| `site/reports/contract_history_qb*.csv`, `qb_*`, `contract_review_2025_vs_2026_current.csv` | 2026-02-16 / 03-07 | No producer found | **No reader found** [V grep] | Orphaned |
| `site/trades/trade_offers_<lid>_<yr>.json` (25625, 74598, 2099), `trade_outbox_*.json` | 74598_2026 offers 2026-11-16; outbox 2026-05-24 | Worker GitHub contents writes (`index.js:28224`, `:28367`); paused by `TRADE_OFFERS_PUBLIC_WRITES_ENABLED="0"` (`wrangler.toml:53`) [V]. The outbox moved to D1 `twb_trade_outbox` [V comment, `wrangler.toml`] | Worker [V], tests | Yes: may hold private data; details are kept in the private register only |
| `site/reports/bug_reports_74598_2026.json` (7 reports) | 2026-03-15 | Worker GitHub write (`index.js:28503`); paused by `BUG_REPORT_PUBLIC_WRITES_ENABLED="0"` (`wrangler.toml:49`) [V] | Worker | Yes: may hold private data; details are kept in the private register only |
| Wire (`site/wire/data/*` 71 files, 4.3 MB; `site/wire/packs/**` 55 files, 6.1 MB; `site/wire/index.json`) | data 2026-09-11 → 11-19; packs through wk10 (11-19) | `pipelines/etl/wire/*` (local, `ups_center_auto.py`) V(agent) | Pipelines (`elias.py`, `weekly_recap.py`, ...). Articles are baked static HTML; `site/wire/*` fetches only `index.json` at runtime [V] | `discord_quotes_2026_preseason.json` (`text`, `author`, `messageId`), `*.quotes.json`, `chat_exclusions.json`; `docs/wire/2026-wk0{6,7}/build/chat_quotes.json`, `docs/wire/2026-wk03-coffee-shop-receipts.json` (`message`, `owner`, `permalink`) [V field names]. These are published by design but are Discord content [flag] |
| `site/_archived/2026-05-12/**` | 2026-05-13 | Retired | `ccc/mym_dashboard.json` and `mym_submissions.json` are still targets of `refresh-mym-dashboard.yml` (hourly) and `log-mym-submission.yml`, which write **`site/ccc/`**, not the archive [V] | See §6 |

### 1C. Worker-bundled data
- **`worker/fpa_store/fpa2-2026-10-13/{2017..2025}.json`** (5.8 MB): bound as `[assets] binding="FPA_STORE"` with `run_worker_first` (`wrangler.toml:274-282`) [V]. Built once by `build_fpa_season_store.mjs`. Read by `fpa_engine.js:714` and `lineup_matchups.js:258` [V]. Version pinned to `FPA_ENGINE_VERSION` (`fpa_engine.js:22`).
- **`docs/league_context_v1.md`:** bundled as Text (`wrangler.toml:307-314`) V(agent).

---

## 2. R2
**Binding:** `UPS_MFL_BACKUPS` → bucket `ups-mfl-backups` (`worker/wrangler.toml:270-272`) [V]. `wrangler.preview.toml:19` also declares an R2 bucket [V].

**Key patterns:**

| Key pattern | Writer (file:line) | Reader | Notes |
|---|---|---|---|
| `snapshots/YYYY-MM-DD/{salaries,transactions,rosters,injuries,league,freeAgents,draftResults}.json` | `snapshotMflToR2` `index.js:494-559` (`bucket.put` `:529`). Scheduled at 09 UTC or later, self-healing hourly when `_snapshot_meta.json` is missing (`:8662-8668`, HEAD `:8665`). Manual route `/admin/snapshot-mfl-now` `:9427-9440` (commish key) [V] | **Only `rosters.json` is read:** `_preDropContractReader` `:638-668` (`bucket.get` `snapshots/${dateStr}/rosters.json`) [V] | No reader for the other 6 exports [V grep]. Transactions are stored with trade comments (no strip; R2 is private) [V] |
| `snapshots/YYYY-MM-DD/_snapshot_meta.json` | `index.js:550` [V] | HEAD existence check `:8665` [V] | n/a |
| `snapshots/hourly/YYYY-MM-DD/HH.json` (rosters export) | `snapshotRostersHourlyToR2` `:570-584` (put `:579`, delete 10 days back `:583`) [V] | `_hourlyPreDropContract` `:590-620` [V] | Kept 10 days |
| `db-backups/YYYY/MM/DD/mfl_database.<stamp>.sqlite.gz` | Local `scripts/backup_mfl_db.sh:79` (S3-compatible, credentials from `~/.config/r2/...`) [V] | No reader in the repo [V grep] | n/a |

Who uses `_preDropContractReader` [V]:
- The drop ledger `/admin/drops/scan-and-record` (`index.js:54255`, reader `:54325`).
- The waiver-run card `/admin/adds/post-discord` (`index.js:47157`).
- Downstream: drop penalties, the `ups_drop_events` D1 table, and Discord drop cards.

---

## 3. Mobile app (site/m/**; apps/** holds only the `apps/mfl_site` desktop skin loader) — V(agent) unless marked

**Reads by module:**
- **Base:** worker `https://upsmflproduction.keith-creelman.workers.dev` (`app.js:15-22`). All MFL exports go through `/api/mfl-export?TYPE=...` (`app.js:489-503`).
- **app.js (boot):**
  - Worker routes: `/api/active-season`, `/api/me`, `/api/cap-penalty/preview` (batch, `:983`), `/api/league-events`, `/api/taxi-callups`, `/api/trade-bait-notes`, `/api/trades/proposals`, `/api/current-lineup-week`, `/api/waivers/{state,availability,pending}`, `/api/hot-cold`, `/api/advanced-stats-leaderboard`.
  - MFL exports: league, rosters, salaries, salaryAdjustments, players, tradeBait, playerScores, draftResults (4 years), transactions, injuries.
  - Static files: `ccc/tag_tracking.json` `:601`, `rookies/rookie_prospects_<y>` `:677`, `rosters/player_acquisition_lookup_<y>` `:804`, `reports/salary_adjustments/salary_adjustments_<y>` `:1159`, `ccc/tag_submissions` `:1172`, `version.json`.
- **Views:**
  - **lineup:** `/api/current-lineup-week`, `/api/lineup-matchups`, `/api/lineup`; projectedScores, nflSchedule, nflByeWeeks.
  - **scores:** `/api/mfl-detailed`, `/api/league-years`; liveScoring, weeklyResults, schedule, projectedScores, injuries.
  - **league:** `/api/standings`, `/api/historical-finishes`, `/api/playoff-bracket`; MFL leagueStandings and schedule; `champions_panels.json`, `standings/h2h_history.json`.
  - **stats:** about 11 `/api/*` stat routes.
  - **trade:** `/api/trades/*`, `/api/franchise-assets`.
  - **auction:** `/acquisition-hub/<kind>/live`, `/api/auction/*`, `/api/adp`, freeAgents.
  - **contracts:** GET `/admin/contract-submissions`, `/api/cap-adjustments/*`, `contract_log_test_<y>.json`.
  - **player_sheet:** `/api/player-{weekly-box,status,bundle,news}`.
  - **extend_submit:** github.io `extension_previews_<y>.json` `:453`.
  - **rules:** `./data/rules_data.js`.

**Caching:**
- **Worker `/api/mfl-export`** (`index.js:19560`): upstream `cf.cacheTtl: 60, cacheEverything` (`:19688`), keyed on the full upstream URL. A client `&_=` busts it. Mobile adds `_=` for 20 s after a move on move-sensitive types (`app.js:483-502`).
- **Worker's own `mflExportJson`** always cache-busts (`index.js:24652`, `:24675`). So worker penalty math reads live rosters, while mobile cap math can read rosters up to 60 s old.
- **Client in-memory TTLs:** 20 s – 5 min.
- **Service worker:** never caches the worker, MFL or `version.json` (`sw.js:40`, `:60`).
- **localStorage:** ids and preferences only.

**Owner-facing numbers computed in the browser:**
1. **Cap used / room / adjustments:** `front_office_cap.js:191-244`, from MFL rosters, salaries and salaryAdjustments exports. It differs from worker `cap_math.js:77-117` (`/roster-workbench`):
   - It rounds adjustments to $1K (`front_office_cap.js:229` [V spot-checked]).
   - The roster salary wins over the salaries export (`:170`).
   - Expired means `cy === 0` only (`:200` [V spot-checked]); the worker uses ≤ 0.
   - A blank salary counts as $0; the worker marks it unresolved.

   Shown on Home, Contracts, League, Players and the player sheet.
2. **"Cap room after drop":** `players.js:1151`, `:1447` = `capRoom + salary − penalty` [V spot-checked]. It adds back full salary for IR (charged 50%) and taxi (charged 0%) players, so it overstates room [I].
3. **Drop penalty:** from the worker batch (`/api/cap-penalty/preview`, `_computeDropPenalty` `index.js:3801`). The local fallback `front_office_penalty.js:452-543` uses calendar-quarter "earned" (`:258-274`), while the worker uses per-week math (`lib/cap_penalty.js:89`, `:142`). The fallback is labeled "est." (`players.js:1153`).
4. **Extension AAV/TCV:** the static github.io snapshot on mobile vs the live `priceExtension` (`extension_pricing.js:160`) on desktop `/roster-workbench`.
5. **Smaller items:**
   - Trade cap-money limit: matches the worker.
   - Season and last-N points: sums of MFL `playerScores` in the browser.
   - Projected lineup total: browser.
   - Win probability: σ = 49 (`scores.js:28`).
   - Bracket and race projections: `shared/standings_race.js`.
   - Offense/IDP points come straight from MFL leagueStandings, not `/api/standings`.

**Write routes (listed only, none called):**
- `/roster-workbench/action`
- `/api/submit-trade-bait`
- `/api/waivers/{bbid-plan,fcfs}`
- `/api/submit-lineup`
- `/api/pick`
- `/api/auction/<action>`
- `/api/trades/{proposals,proposals/action,2way,3way,3way/recheck,3way/ack-cap,3way/cancel}`
- `/commish-contract-update`
- `/offer-mym`
- `/offer-restructure`

---

## 4. AI / research consumers — V(agent)

**`anthropic_explain.js`** (Haiku 4.5)
- **Reads:** bundled canon (`:11`) plus proposal text.
- **Labels:** no confidence or citation fields. The answer is stored in `hall_qa_log` (`source` column) and posted as "Bot's take".
- **Stale comment:** canon is described as about 127 KB (`:18`); the file is now 307 KB.

**`rule_draft_agent.js`** (`claude-sonnet-5`)
- **Reads:** canon plus **any D1 table** through `run_sql`, behind a read-only guard (`guardSql` `:59`).
- **Writes:** `hall_draft_*` and `hall_qa_log` (`source='tab'`).
- **Labels:** none structured.

**`rule_integrator.js`** (Haiku, despite the constant name `SONNET_MODEL` `:39`)
- **Reads:** canon via the GitHub API, plus `hall_proposals` and `discord_round_items`.
- **Output:** opens a PR. Text is marked advisory; confidence appears only in free text.

**Discord bots:**
- **`discord_roast_reply.js`, `discord_wire_reply.js`, `discord_therapy.js`** (opus-4-8 / sonnet-5 / sonnet-4-6) read D1 `ups_roast_*`, `ups_wire_threads`, `discord_owners`, `ups_owner_career_stats`, `ups_therapy_*`, `ups_bad_beats`, `ups_trade_outcomes`. Posted text has no source or confidence labels. Therapy's "verified facts" are built in code.
- **`hall.js`, `discord_bot.js`, `discord_deepcut_suggest.js`:** no LLM calls.

**AI Commissioner Desk** (`origin/claude/ai-commish-desk` @44805bec, not on this branch)
- **Models:** Haiku 5.5 router, Sonnet 5.5 loop and composer, with its own key and a D1 budget log (`ai_call_log`, `ai_budget_totals`, `ai_desk_questions`).
- **Tools:** GET-only calls to the worker's own routes (`/api/league-events`, `/api/salary-adjustments/ledger`, `/api/cap-penalty/preview`, `/roster-workbench`, `/api/data-freshness`, `/api/historical-finishes`, `/api/hall-of-champions`, `/api/player-transactions`, `/api/player-bundle`, `/api/standings`, `/api/playoff-bracket`), plus in-memory `rules_data.js`.
- **Labels (strongest in the repo):**
  - Evidence grades A/B/C/D/NO_RECORD.
  - Facts carry `{as_of, source, grade}`.
  - `provenance`, `freshness`, `coverage.gaps`.
  - Cites carry `{anchor, canon_sha}`; card header has `ai_generated` and `canon_sha`.
- **Inherited staleness:**
  - `/api/salary-adjustments/ledger` reads the hand-refreshed `salary_adjustments_<y>.json`.
  - `/roster-workbench` extension pricing reads the extension previews.

**Wire / UPS Center** (`pipelines/etl/wire`)
- **Model:** only `wire_write.py` calls one (`claude-opus-5`).
- **Inputs:**
  - D1 (read-only `wrangler --remote`, `wire_data.py:72-87`).
  - Worker `/api/mfl-export` and `/api/standings`.
  - MFL rosters directly.
  - `data/mfl-snapshots`.
  - Tracked files from `origin/main`.
- **Labels:** packs carry `sources[{name,asof,rows}]`, `coverage`, `warnings` and `facts[{id,source,asof}]`. The model may only use fact tokens, and a pack with no sources is rejected. The UPS Center Ledger records claims as `{value,shown,source}`. Output is one draft PR, with no Discord write.

**Other pipelines:**
- `content_engine.py` (proxy mode targets `/api/anthropic-proxy`, which **does not exist** in `index.js`).
- `trade_grader_prompt.py` and `roast_bot_fire_ab.py` (sonnet-4-6 / opus-4-8) read `data/valuation/trade_valuation_snapshot.json`.

**League record S1** (`origin/claude/league-record-s1-pilot` @b7103ee7)
- **Docs:** 12 `S1_*.md` files plus archive, coverage, forfeitures and pilot JSON.
- **Scripts:** `scripts/league_record/s1/*.mjs`, no LLM use.
- **Inputs:** `data/db-archives/mfl_database_2026-06-05.db.gz` (allow-listed tables), `data/mfl-snapshots/2026-11-19/*`, `known_forfeitures.json`, `coverage_verifications.json`, and A1–A4 MFL exports that Keith runs locally into a private folder.
- **Labels:** CONFIRMED / CALCULATED / INFERRED / UNRESOLVED / MISSING, plus a `source` reference on every record.

---

## 5. Rulebook data — V(agent), workflow paths V

- **Canon:** `docs/league_context_v1.md`, bundled into the worker as Text and imported by `anthropic_explain.js`, `rule_draft_agent.js` and the desk. `rule_integrator.js` fetches it live from GitHub. No rule text is in R2 or D1, apart from rulings in `hall_qa_log`.
- **Topics file:** `docs/rulebook_topics.json` is hand-curated (2026-10-23) with 13 topics. It is read by `scripts/build_rulebook_data.py:45`, `:568` (canon-drift check `:584`).
- **Build outputs:** `site/m/data/rules.json` and `rules_data.js`, carrying `canon_sha`, `canon_digest` and `canon_date`.
- **Gap:** `rulebook-build.yml` path filters (`:17-26`) do not include `docs/rulebook_topics.json`, so a topics-only edit triggers neither the rebuild nor the PR check [V].
- **Legacy:** `services/rulebook/data/rules.json` (2026-05-08) comes from `tools/build_rulebook_json.py` and is served only by `services/rulebook/api/rulebook_api.py` and `web/rulebook_embed.html`. The worker deliberately does not read it.

---

## 6. Cross-cutting gaps

1. **Bot commits may not redeploy Pages [I].** Workflows that push with the default `GITHUB_TOKEN` do not trigger other workflows. Affected: `refresh-extension-previews` (hourly), `nightly-builders`, `log-contract-activity`, `rulebook-build`. `pages-deploy.yml` triggers only on push or workflow_dispatch (`:21-29`) [V]. So the github.io copies read by mobile, desktop and the worker likely update only on the next human push that touches site/. The lag is bounded by how often Keith pushes; run history was not checked.
2. **Hourly no-op jobs [I].**
   - `refresh-acquisition-hub.yml` needs `MFL_DB_PATH` on the runner, otherwise exits 0.
   - `refresh-mym-dashboard.yml` writes the untracked `site/ccc/mym_dashboard.json`. Its `git diff --quiet` check ignores untracked files, so it never commits [V logic].
   - `log-mym-submission.yml` and `log-restructure-submission.yml` target `site/ccc/*` files that were archived.
3. **Broken readers:**
   - The worker's acquisition artifact URLs point at the removed `site/acquisition/` (§1B) [V paths; 404 is I].
   - The MCM URLs carry an extra `/site/` prefix [V path; 404 is I].
   - The jsDelivr reads (curated GIFs, player_points_history) [I].
4. **Orphaned files:** QB contract-history CSVs; `data/reviews`; 4 of 5 `data/recovery` files; `contract_audit_2026-07-24.csv`; the other 6 R2 daily exports; R2 `db-backups/`.
