# Site Inventory — Cross-Cutting Summary

**Generated:** 2026-04-28
**Branch:** `docs/site-audit-v1`
**Scope:** Phase 2 of the comprehensive UPS site / HPM / Worker / ETL audit.

This is the index for the three Phase 2 sub-inventories. Each sub-inventory has its own schema (the surfaces don't share columns cleanly), so a single "master" CSV would lose information. Treat the three sub-CSVs as the authoritative artifact catalogues; treat this document as the cross-cutting view.

---

## Sub-inventories

| Surface | CSV | Summary | Row count | Notes |
|---|---|---|---|---|
| Static site (`site/`) | [`_inventory_site.csv`](_inventory_site.csv) | [`_inventory_site_summary.md`](_inventory_site_summary.md) | 174 artifacts | HTML, JS, CSS, JSON, embed loaders, per-feature subdirs |
| Cloudflare Worker | [`_inventory_worker.csv`](_inventory_worker.csv) | [`_inventory_worker_summary.md`](_inventory_worker_summary.md) | 59 routes | 28 GET + 31 POST; D1 + R2 bindings; one cron handler |
| ETL pipelines | [`_inventory_etl.csv`](_inventory_etl.csv) | [`_inventory_etl_summary.md`](_inventory_etl_summary.md) | 84 scripts | Python ETL + analytics; mostly manual, 2 hourly cron, 6 GHA-on-push |
| Live MFL HPM config | [`_raw/_live_appearance_74598.json`](_raw/_live_appearance_74598.json) | (see below) | 1 file (sparse) | `TYPE=appearance` returned only 4 module slots — needs follow-up |

---

## Aggregate stats

- **Total artifacts catalogued:** 317 (174 site + 59 worker + 84 ETL).
- **Active HPM modules per Phase 1 inventory:** at least 8 (`MESSAGE2`, `MESSAGE5`, `MESSAGE9`, `MESSAGE12`, `MESSAGE13`, `MESSAGE15`, `MESSAGE16`, `MESSAGE17`).
- **Active GitHub Actions workflows:** 11 (`.github/workflows/*.yml` — log-* dispatchers, refresh-* schedulers, daily-snapshot, deadline reminders).
- **D1 tables referenced by worker:** 16 across 24 migrations (`worker/migrations/0001 → 0024`).
- **Cron-driven entry points:** worker `[triggers] crons = ["5 * * * *"]` (hourly), GHA `refresh-acquisition-hub` and `refresh-mym-dashboard`.

---

## Cross-cutting concerns flagged in Phase 2

These were surfaced by the inventory pass and feed downstream phases:

1. **Hardcoded release SHAs** in HPM wrappers (`hpm-widget.html`, `hpm-standings.html`, `ups_issue_report.html`) — manual SHA bumps required for any update; no auto-versioning. (Phase 5 register: `DUP-002` family.)
2. **CCC submission JSON files stale ~71 days** — `mym_dashboard.json`, `tag_tracking.json`, etc. last touched 2026-02-16. Theory: live state lives in the Worker / D1, not git; the JSONs in repo are stale snapshots. Confirmed by Phase 4 freshness audit (`mym_dashboard.json` is 52 days stale relative to the hourly cron that should refresh it).
3. **Duplicate `rookie_draft_history.json`** at `site/acquisition/...` (1.3 MB) and `site/rookies/...` (2.5 MB) — different sizes suggest schema drift. Phase 5 register: `DUP-001`.
4. **Massive client-side payloads** — `player_scoring_2024.json` and `_2025.json` are 5.4 MB each; ships uncompressed to every HPM consumer. Worth lazy-loading or moving server-side. (Enhancement `E-LOW-08` in `site_enhancement_proposals.md`.)
5. **Public-write worker routes with no auth or rate limit** — `/mcm/nominate`, `/mcm/vote`, `/bug-report`, `/extension-assistant`. Phase 3b classified the first three as Low (non-league-functional) and the assistant as Low too.
6. **Duplicate trade-submission paths** — `POST /trade-offers` and `POST /api/trades/proposals` resolve to the same handler at `worker/src/index.js:14491`. Drift risk if maintenance only updates one. Phase 5 register: `DUP-003`.
7. **53 of 59 worker routes have no confirmed `site/` consumer** — orphan candidates. Need a comprehensive `fetch()` grep across `site/` to either map each route or deprecate.
8. **84 ETL scripts; 44 stale (>30d untouched).** 14 are flagged as deprecated (backward-compat wrappers, one-offs, or test scripts).
9. **4 ETL outputs with multiple writers** — `D1:contract_forum_export_v3_all` (3 writers), `D1:player_id_crosswalk` (2), `site/rookies/rookie_draft_history.json` (2), `site/trade-value/trade_value_model_2026.json` (2). Race-condition risk; Phase 5 register: `DUP-005`, `DUP-008`, `DUP-001`, `DUP-006`.

---

## Phase 2D — Live HPM config (sparse)

The MFL `TYPE=appearance` export returned only:

```json
{"appearance":{"tab":{"module":[{"name":"COLUMN=65"},{"name":"MESSAGE4=W"},{"name":"COLUMN=35"},{"name":"MESSAGE5=N"}],"name":"Main","id":"0"},"skin":"0"}}
```

A single "Main" tab with two MESSAGE references (`MESSAGE4`, `MESSAGE5`). Phase 1's documented inventory shows the league actively uses at least 8 message slots. Two possibilities:

- `TYPE=appearance` returns only positioning info (column widths + module mounts) and does not return HPM body content.
- The league has additional tabs whose modules aren't in this response (the response only contains tab `id="0"`).

**Recommendation:** treat `TYPE=appearance` as "structural metadata" only. To inventory actual HPM body content (the HTML/JS pasted into MFL), Keith should manually export each HPM body via MFL admin UI and drop the resulting bodies into `docs/site_audit/_raw/hpm_bodies/`. That's a one-time manual capture; subsequent updates are tracked via the repo's HPM source files.

---

## Pointers

- Phase 3 / 3b findings: `site_audit_findings.md`, `site_audit_findings_v2.md`
- Phase 4 freshness: `site_data_freshness.csv` + `site_data_freshness_findings.md`
- Phase 5 duplicate sources: `site_duplicate_sources_register.csv` + `site_duplicate_sources_findings.md`
- Phase 6 release governance: `release_workflow.md`, `release_checklist.md`, `rollback_runbook.md`
- Phase 7 enhancement parking lot: `site_enhancement_proposals.md`
- Phase 8 executive summary: `site_audit_summary_2026.md`
- Verification report (the F-CRIT-003 retraction trail): `_phase3_verification.md`
- MFL platform constraints reference: `mfl_platform_constraints.md`
