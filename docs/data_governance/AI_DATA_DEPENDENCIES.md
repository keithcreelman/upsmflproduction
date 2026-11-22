# AI data dependencies (2026-11-22)

What each UPS AI feature reads, transforms, assumes and produces, with lineage, confidence, freshness and the quality controls behind each input. Maintained by the data-infrastructure session; the AI session owns AI behavior, prompts and evaluation. Conflicts between the two sessions are listed in §4 and stay open until both acknowledge and Keith rules where needed.

**Evidence base:**
- Commissioner Desk code on draft PR #1478, branch `claude/ai-commish-desk` at `44805bec` (2026-11-20).
- League Record S1 on draft PR #1484.
- `main` at `bc607887`.
- The AI session's planning catalog (2026-11-19). The held-out evaluation set was not read.

**Labels:** V verified in code · R reported by another session, not re-checked · U unknown.

## 1. Commissioner Desk (PR #1478, dark: `DESK_ENABLED` off)

Every tool is read-only and returns facts with `as_of`, `source` and a grade (A = MFL record, B = league document, C = derived by code). Grades are set in each tool file (V).

| Tool | Reads (lineage) | Transforms | Grade produced | Freshness of the input | Input quality controls today | Known limits and assumptions |
|---|---|---|---|---|---|---|
| `rules.search`, `rules.get` | `worker/src/desk/data/rules_data.js` ← `site/m/data/rules.json` ← canon `docs/league_context_v1.md` (`rulebook-build.yml`) | Keyword search; exact anchor text | B | Each canon push; carries `canon_sha` | Canon-drift check in the build. Gap: a topics-only edit (`docs/rulebook_topics.json`) skips the build | Current canon only; dated rule history is a later slice (S4) |
| `glossary.lookup` | `desk/data/glossary.js` (static) | Lookup | B | Hand-maintained | Desk tests | Can drift from canon; the planned CI drift check is not confirmed |
| `coverage.check` | `desk/data/coverage_matrix.js`, a **hand-written static matrix** built from the catalog and backlog | Lookup by domain and season | C | Fixed at write time; `COVERAGE_LAST_SEASON = 2026` | A test forbids "full" for lineage, pre-2026 contracts, owners and dated rules | Not generated from the gap trackers (#1386, #1486, #1497); see conflict C3 |
| `roster.current` | `/roster-workbench` ← live MFL rosters and salaries (60 s cache) | Shapes the response | A | Live | None on the MFL response shape (baseline §2a) | Raw MFL, not the FO repaired view (v8 open decision) |
| `cap.position` | `/roster-workbench` + worker `cap_math.js` | Cap used and room | C | Live | `cap_parity` tests code only; no reconciliation against MFL totals (baseline P1-9) | Current and next season only |
| `cap.penalty_quote` | `/api/cap-penalty/preview` → `_computeDropPenalty` with live MFL salary; `/roster-workbench`; `/api/league-events` | The worker's charged calculator | C | Live | Worker penalty tests | Quotes current rules only. The R2 pre-drop snapshot is **not** used here; it affects posted drop charges (baseline §4 #2) |
| `cap.adjustments` | `/api/salary-adjustments/ledger` ← D1 `ups_drop_events` (+ static report for 2025-era detail) | Groups the ledger | A/C | Live D1 | Drop-pricing audit trigger (0166) | 31 of 41 posted 2026 cut charges carry no player id in MFL (#1502, R); earlier seasons partial |
| `extension.price` | `extension_pricing.js` + `/roster-workbench` | Price under current rules | C | Live | Extension pricing tests | Current rules only |
| `calendar.events` | `/api/league-events` ← D1 `league_events` | Filters by season | A/B | Worker-maintained | — | 2011-2026 per catalog (R) |
| `standings.get` | `/api/standings`, `/api/playoff-bracket` ← D1 `src_standings`, `src_schedule`, `src_franchise_weekly_score`, `src_final_standings` | Labels seeds and results | A/C | **Current season written only by the Mac `live-season-sync` job**; final standings only by the Mac loader | `standings_truth.js` fail-closed guard (V, controls appendix) | No "as of" from the route; history is Mac-loaded (conflict C4) |
| `history.finishes` | `/api/historical-finishes`, `/api/hall-of-champions` ← `src_final_standings` (V: never reads `/api/eras`) | Finish label map: 7 = Toilet Bowl champion; anomalies refused | A/C | **Manual Mac load**; 2026 finals need one | Label map tested | 2010 disputed; franchise level, not owner level |
| `player.transactions` | `/api/player-transactions`, `/api/player-bundle` (profile, `trade_history`) ← D1 `src_trades`, `src_adddrop` + MFL playerProfile | Lists trades and moves | **A** for trade rows (V) | `src_trades`/`src_adddrop` current season by the Mac job (delete and re-insert); history by the Mac loader | None on completeness | Parsed tables drop pick slots and miss multi-player moves (GAP-09/15); see conflict C1. The bundle also returns `contracts` and `contract_stints` from unwritten tables; the desk does not read them (V), and must not until audited |
| `data.freshness` | `/api/data-freshness` ← D1 `etl_runs` | Judges age against 192 h default | C | — | Says "not tracked" for missing sources (V) | Only 2 sources stamp `etl_runs`; see conflict C2 |

**Desk outputs:** answers to the commissioner, built only from tool facts and checked by the desk validator. A store table records calls (migrations 0180/0181, not applied).

## 2. League Record S1 (PR #1484, local only)

- **Reads:**
  - the local archive `data/db-archives/mfl_database_2026-06-05.db.gz` (allow-listed tables);
  - the committed snapshot `data/mfl-snapshots/2026-11-19/`;
  - `known_forfeitures.json` and `coverage_verifications.json`;
  - the A1–A4 MFL exports, which only Keith runs, with sanitized output.
- **Transforms:** trade-token and pick lineage replay. Classes are CONFIRMED / INFERRED / UNRESOLVED / CONFLICT, and every possession period carries a grade.
- **Assumptions recorded there:**
  - MFL "pick traded from" notes are corroboration only.
  - Pick slots never come from standings.
  - Ownership comes from events, not weekly rosters.
  - Missing scoring is unknown, never zero.
- **Outputs:** local reports only. No D1 writer exists. Any D1 design must pass the consumer gate in the baseline §5.
- **Controls:**
  - SQL guards (tokenizer, banned list, name allowlist).
  - The pre-live register #1486, where LR-01..LR-12 are release gates.
- **Data-infra notes:**
  - The archive is a single frozen copy, with no checksum recorded in the repo (U).
  - The 2025-11-28..2026-03-07 trade gap is a source-coverage gap. It is not a pipeline defect.

## 3. Other AI features (on `main`)

| Feature | Reads | Labels on output | Data-infra concern |
|---|---|---|---|
| `anthropic_explain.js`, `rule_integrator.js` | Bundled canon; `rule_integrator` fetches canon from GitHub at run time | None | Run-time canon fetch can differ from the bundled copy |
| `rule_draft_agent.js` | Canon + any D1 table through a read-only SQL guard | None | Unbounded D1 reads against the Free budget; Project A findings are parked |
| Discord roast / wire-reply / therapy bots | D1 `ups_roast_*`, `ups_owner_career_stats`, `ups_therapy_*`; owner dossier synced to D1 by hand | None | `owner_ammo` D1 sync is manual and can go stale |
| Wire / UPS Center (`pipelines/etl/wire/*`) | D1, worker routes, MFL, snapshots, `ups_discord_messages` | Fact tokens with `sources`/`asof`; a pack with no sources is rejected | Best-labeled; `ups_discord_messages` has no migration; projection table re-stamp bug (BL-I13) |
| `content_engine.py` proxy mode | `/api/anthropic-proxy` | — | The route does not exist in the worker (R, assets appendix) |

## 4. Conflicts to resolve with the AI session (open)

| # | Conflict | AI-session position (evidence) | Data-infra position | Needs |
|---|---|---|---|---|
| C1 | Trade rows from `src_trades` graded **A** (MFL record) | `player_transactions.js` sets grade A with source "src_trades via /api/player-bundle" (V) | The AI catalog itself says parsed tables are "convenience only (they drop pick slots)". `src_trades` is a Mac-written delete-and-reinsert copy, not the MFL record. Recommend grade C ("parsed mirror of MFL"), or reading raw MFL for A | AI-session acknowledgement; Keith only if grades are a policy question |
| C2 | Freshness targets | `data.freshness` applies a 192 h default to every source, with no per-source targets (V) | One freshness registry, with per-asset targets owned in `docs/data_governance` and stamped by every job (baseline P1-6); the desk consumes it rather than defining its own | Agreement on who owns the targets |
| C3 | Two coverage records | Desk: hand-written `coverage_matrix.js` (V) | Gaps live in #1386, #1486, #1497 and evidence registers. One generated coverage file, consumed by both the desk and Stats (baseline P2-13), avoids drift | Agreement on the single source |
| C4 | History freshness is manual | Desk treats `src_final_standings` as an A/C record with no freshness caveat | That table and the current-season standings are written only from the Mac. Freshness must be stated, or the writer must be ported first | AI-session acknowledgement |
| C5 | Contract history in the player bundle | Desk does not read `contracts`/`contract_stints` (V) | Keep it that way until the production audit of those tables (baseline §4 #5) | Note only |

## 5. Before any AI tool goes live

Apply the consumer gate in `BASELINE_2026-11-21.md` §5 to every input above. As of this date:
- No desk input has an alerting quality check.
- Three inputs depend on the Mac: standings, history and trades.
- Freshness is tracked for none of the desk's MFL-derived inputs.
