# League Record S1: D1 historical-data design (proposal, decision 5 of 2026-11-21)

**Status: DESIGN ONLY.** Nothing here is built. No migration file, no Worker route, no ingestion, no production read or write, no deployment, no paid model call. The SQL below is a **proposal in a document**, not a migration. Production D1 is metered and shared (`docs/D1_QUERY_RULES.md`); the commissioner wants to return to the Free plan (5M rows read and 100k rows written per day), so every number here is sized against that limit. All volume and `rows_read` figures are **estimates**, marked as such, and must be measured on a local replica and a temporary D1 database before any production go.

## 1. What the storage layer must do

| Requirement (commissioner, 2026-11-21) | How the design meets it |
|---|---|
| Complete multi-asset trades, with cap-transfer direction | A trade is one row (`lr_trade`) with its parties, one row per moved asset (`lr_trade_leg`) and one row per cap movement with `from` and `to` franchise (`lr_trade_cap`). Nothing is credited to a single asset of a package. |
| Player and pick identity with individual transaction events | `lr_asset` holds identity (player, future pick = original franchise + year + round, slot pick = year + round + slot); every movement is an event row (`lr_trade_leg`, `lr_asset_event`). |
| Historical franchise possession periods | `lr_possession`: one row per asset, franchise and period, derived from events, with the weakest coverage state it rests on. |
| Source references and evidence quality | Every fact row carries `source_id` and `source_key`; `lr_source.authority` and `date_quality` carry quality. |
| Confirmed, calculated, inferred and unresolved links | `lr_link` with a `CHECK`-enforced class, the method and version that produced it, the blockers, and `lr_link_candidate` rows for every candidate of an unresolved link. |
| Draft selection versus forfeiture versus missing record | `lr_draft_slot.status` is one of `SELECTED`, `FORFEITED`, `UNRESOLVED`, `MISSING_SOURCE_RECORD`, with `CHECK`s that tie the status to the presence of a player and a selector. |
| Raw and normalized draft-slot values | `lr_draft_row` keeps the stored values; `lr_draft_slot` holds the normalized slot; `lr_correction` links them with the method and approval. |
| Explicit source-coverage intervals and known gaps | `lr_coverage` (per event class, state `VERIFIED_COMPLETE` / `UNVERIFIED` / `KNOWN_GAP`) and `lr_coverage_check`. |
| Historical contracts and scoring as future dependent slices | Reserved keys: `lr_possession_points` and `lr_possession_contract` attach to `possession_id` (section 3, last block). Not built. |
| Versioning, reproducibility, correction provenance | `lr_run`, `lr_release`, `valid_from_run` / `valid_to_run` on derived rows, `lr_correction`, `lr_method`. |
| Do not flatten uncertain relationships | No column anywhere says "this pick became this player". A pick's slot and a slot's player are separate rows with separate classes; a read returns the class beside the answer. |

## 2. Principles

1. **Facts, claims and links are separate layers.** Layer 0 sources and coverage; layer 1 facts exactly as recorded (trades, draft rows, events); layer 2 derived periods; layer 3 links with an evidence class. A higher layer is rebuildable from the lower ones.
2. **Append only; correct by adding.** A fact is never overwritten. A correction is a row in `lr_correction` that points at the stored value, so the original always survives.
3. **Versioned derivations.** Layers 2 and 3 carry `valid_from_run` and `valid_to_run`. The active release names one run; a read asks "as of run R", so an old release can be reproduced and a rollback is a pointer change.
4. **Write only what changed.** A rebuild inserts changed or new derived rows and closes the superseded ones; finished seasons are never rewritten (`D1_QUERY_RULES.md`, Writes).
5. **No private data.** Franchise ids and public league identifiers only: no owner name, e-mail, message text or credential. Free-text `comments` from MFL are not stored.
6. **Enumerations are enforced by the database** (`CHECK`), not by convention: statuses, classes, event classes, coverage states.

## 3. Proposed schema (all tables prefixed `lr_`; additive; integers are epoch seconds or counts; dates are Eastern ISO text)

```sql
-- ── versioning ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE lr_run (
  run_id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('build','correction','verification')),
  created_utc TEXT NOT NULL, code_sha TEXT NOT NULL, source_set_sha256 TEXT NOT NULL,
  parent_run_id INTEGER REFERENCES lr_run(run_id), note TEXT);
CREATE TABLE lr_release (                       -- the active release is the row with retired_utc IS NULL; rollback = retire it and re-activate an earlier run
  release_id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES lr_run(run_id),
  activated_utc TEXT NOT NULL, activated_by_ref TEXT NOT NULL, retired_utc TEXT);
CREATE TABLE lr_method (
  method_id TEXT NOT NULL, version INTEGER NOT NULL, description TEXT NOT NULL, approved_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('approved','diagnostic','retired')), PRIMARY KEY (method_id, version)) WITHOUT ROWID;

-- ── sources and coverage ──────────────────────────────────────────────────────────────────────
CREATE TABLE lr_source (
  source_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('archive_db','mfl_export','snapshot','commissioner_clarification','context')),
  authority TEXT NOT NULL CHECK (authority IN ('authoritative','derived','secondary','context')),
  league_id TEXT, season_year INTEGER, request_template TEXT,        -- the URL with the key replaced by REDACTED
  captured_utc TEXT, content_sha256 TEXT, raw_object_key TEXT,       -- raw payload lives in R2 under this key, never in D1
  note_ref TEXT);
CREATE TABLE lr_coverage (
  coverage_id INTEGER PRIMARY KEY, source_id TEXT REFERENCES lr_source(source_id),
  event_class TEXT NOT NULL CHECK (event_class IN ('pick_transfer','player_move')),
  from_date TEXT NOT NULL, to_date TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('VERIFIED_COMPLETE','UNVERIFIED','KNOWN_GAP')), basis TEXT NOT NULL,
  valid_from_run INTEGER NOT NULL REFERENCES lr_run(run_id), valid_to_run INTEGER REFERENCES lr_run(run_id));
CREATE TABLE lr_coverage_check (
  check_id INTEGER PRIMARY KEY, coverage_id INTEGER NOT NULL REFERENCES lr_coverage(coverage_id),
  check_kind TEXT NOT NULL CHECK (check_kind IN ('archive_comparison','chain_continuity','end_state_reconciliation')),
  passed INTEGER NOT NULL CHECK (passed IN (0,1)), detail TEXT);

-- ── identity ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE lr_asset (
  asset_key TEXT PRIMARY KEY,                    -- 'player:<id>' | 'fpick:<orig>:<year>:<round>' | 'spick:<year>:<round>:<slot>' (as in the extraction)
  asset_type TEXT NOT NULL CHECK (asset_type IN ('PLAYER','FUTURE_PICK','SLOT_PICK')),
  player_id TEXT, orig_franchise TEXT, pick_year INTEGER, pick_round INTEGER, pick_slot INTEGER,
  CHECK ((asset_type='PLAYER' AND player_id IS NOT NULL) OR (asset_type='FUTURE_PICK' AND orig_franchise IS NOT NULL AND pick_year IS NOT NULL AND pick_round IS NOT NULL AND pick_slot IS NULL)
      OR (asset_type='SLOT_PICK' AND pick_year IS NOT NULL AND pick_round IS NOT NULL AND pick_slot IS NOT NULL AND orig_franchise IS NULL)));

-- ── layer 1: facts exactly as recorded ───────────────────────────────────────────────────────
CREATE TABLE lr_trade (
  trade_id TEXT PRIMARY KEY, season INTEGER NOT NULL, ts INTEGER NOT NULL, date_et TEXT NOT NULL,
  date_quality TEXT NOT NULL CHECK (date_quality IN ('recorded','processing_time_likely')),
  source_id TEXT NOT NULL REFERENCES lr_source(source_id), source_key TEXT NOT NULL);
CREATE TABLE lr_trade_party (trade_id TEXT NOT NULL REFERENCES lr_trade(trade_id), franchise_id TEXT NOT NULL, PRIMARY KEY (trade_id, franchise_id)) WITHOUT ROWID;
CREATE TABLE lr_trade_leg (                      -- one row per moved asset; the package is the trade
  trade_id TEXT NOT NULL REFERENCES lr_trade(trade_id), leg_no INTEGER NOT NULL, asset_key TEXT NOT NULL REFERENCES lr_asset(asset_key),
  from_franchise TEXT NOT NULL, to_franchise TEXT, ts INTEGER NOT NULL,   -- ts repeated from the trade so a chain is read from one index
  PRIMARY KEY (trade_id, leg_no)) WITHOUT ROWID;
CREATE TABLE lr_trade_cap (                      -- cap-transfer direction: from sends cap room to
  trade_id TEXT NOT NULL REFERENCES lr_trade(trade_id), cap_no INTEGER NOT NULL, from_franchise TEXT NOT NULL, to_franchise TEXT NOT NULL,
  amount INTEGER NOT NULL, PRIMARY KEY (trade_id, cap_no)) WITHOUT ROWID;
CREATE TABLE lr_asset_event (                    -- non-trade events of traded players: draft selection, add, drop; and the forfeiture of a slot
  event_id INTEGER PRIMARY KEY, asset_key TEXT NOT NULL REFERENCES lr_asset(asset_key),
  kind TEXT NOT NULL CHECK (kind IN ('draft_selection','add','drop','forfeiture')), ts INTEGER NOT NULL, from_franchise TEXT, to_franchise TEXT,
  date_quality TEXT, source_id TEXT NOT NULL REFERENCES lr_source(source_id), source_key TEXT NOT NULL);

-- ── draft: raw rows, normalized slots, forfeitures, corrections ──────────────────────────────
CREATE TABLE lr_draft_row (                      -- the source rows as stored, including the stored slot and the raw text
  draft_row_id INTEGER PRIMARY KEY, season INTEGER NOT NULL, round INTEGER NOT NULL, slot_raw INTEGER NOT NULL, overall INTEGER NOT NULL,
  raw_pick_text TEXT, franchise_id TEXT,         -- NULL when the source row records no franchise id (selector not recorded)
  player_id TEXT NOT NULL, ts INTEGER, source_id TEXT NOT NULL REFERENCES lr_source(source_id), source_key TEXT NOT NULL);
CREATE TABLE lr_draft_slot (                     -- one row per SCHEDULED slot
  season INTEGER NOT NULL, round INTEGER NOT NULL, slot INTEGER NOT NULL, overall INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SELECTED','FORFEITED','UNRESOLVED','MISSING_SOURCE_RECORD')),
  draft_row_id INTEGER REFERENCES lr_draft_row(draft_row_id),
  valid_from_run INTEGER NOT NULL REFERENCES lr_run(run_id), valid_to_run INTEGER REFERENCES lr_run(run_id),
  PRIMARY KEY (season, round, slot, valid_from_run),
  CHECK ((status='SELECTED' AND draft_row_id IS NOT NULL) OR (status<>'SELECTED' AND draft_row_id IS NULL)));   -- a forfeited or missing slot never carries a player
CREATE TABLE lr_forfeiture (
  season INTEGER NOT NULL, round INTEGER NOT NULL, slot INTEGER NOT NULL, overall INTEGER NOT NULL, reason TEXT NOT NULL, provenance TEXT NOT NULL,
  clarification_recorded_on TEXT NOT NULL, not_recorded_json TEXT NOT NULL,    -- the things deliberately NOT recorded (violation, owner, ruling date, transaction)
  PRIMARY KEY (season, round, slot)) WITHOUT ROWID;
CREATE TABLE lr_correction (                     -- every correction keeps the original and says why it is allowed
  correction_id INTEGER PRIMARY KEY, target_table TEXT NOT NULL, target_key TEXT NOT NULL, field TEXT NOT NULL,
  original_value TEXT NOT NULL, corrected_value TEXT NOT NULL, method_id TEXT NOT NULL, defect_id TEXT NOT NULL,
  approved_ref TEXT NOT NULL, source_ref TEXT NOT NULL, run_id INTEGER NOT NULL REFERENCES lr_run(run_id));

-- ── layer 2: derived possession periods ───────────────────────────────────────────────────────
CREATE TABLE lr_possession (
  possession_id INTEGER PRIMARY KEY, asset_key TEXT NOT NULL REFERENCES lr_asset(asset_key), franchise_id TEXT NOT NULL,
  from_ts INTEGER, to_ts INTEGER,               -- NULL from_ts: asserted by the first record; NULL to_ts: open
  from_basis TEXT NOT NULL CHECK (from_basis IN ('event','asserted_by_first_record','draft_selection')),
  evidence_class TEXT NOT NULL CHECK (evidence_class IN ('CONFIRMED','CALCULATED','INFERRED','UNRESOLVED')),
  weakest_coverage TEXT NOT NULL CHECK (weakest_coverage IN ('VERIFIED_COMPLETE','UNVERIFIED','KNOWN_GAP')),
  valid_from_run INTEGER NOT NULL REFERENCES lr_run(run_id), valid_to_run INTEGER REFERENCES lr_run(run_id));

-- ── layer 3: links with a class, never a flattened outcome ───────────────────────────────────
CREATE TABLE lr_link (
  link_id INTEGER PRIMARY KEY, link_type TEXT NOT NULL CHECK (link_type IN ('FUTURE_PICK_TO_SLOT','SLOT_PICK_TO_SELECTION')),
  from_asset_key TEXT NOT NULL REFERENCES lr_asset(asset_key),
  to_season INTEGER, to_round INTEGER, to_slot INTEGER,        -- NULL while UNRESOLVED
  class TEXT NOT NULL CHECK (class IN ('CONFIRMED','CALCULATED','INFERRED','UNRESOLVED')),
  method_id TEXT NOT NULL, method_version INTEGER NOT NULL, blockers_json TEXT, evidence_json TEXT,
  valid_from_run INTEGER NOT NULL REFERENCES lr_run(run_id), valid_to_run INTEGER REFERENCES lr_run(run_id),
  FOREIGN KEY (method_id, method_version) REFERENCES lr_method(method_id, version),
  CHECK ((class='UNRESOLVED' AND to_slot IS NULL) OR (class<>'UNRESOLVED' AND to_slot IS NOT NULL)),
  CHECK (NOT (link_type='FUTURE_PICK_TO_SLOT' AND class='CONFIRMED')));    -- by rule a future pick is never CONFIRMED to a slot
CREATE TABLE lr_link_candidate (link_id INTEGER NOT NULL REFERENCES lr_link(link_id), season INTEGER NOT NULL, round INTEGER NOT NULL, slot INTEGER NOT NULL, via TEXT NOT NULL,
  PRIMARY KEY (link_id, season, round, slot)) WITHOUT ROWID;
CREATE TABLE lr_conflict (                       -- a recorded disagreement between sources: kept, never resolved by the model (for example 2014 pick 4.12)
  conflict_id INTEGER PRIMARY KEY, subject_key TEXT NOT NULL, kind TEXT NOT NULL, left_ref TEXT NOT NULL, right_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','resolved_by_source','resolved_by_ruling')), ruling_ref TEXT, run_id INTEGER NOT NULL REFERENCES lr_run(run_id));
CREATE TABLE lr_summary (run_id INTEGER NOT NULL REFERENCES lr_run(run_id), metric TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (run_id, metric)) WITHOUT ROWID;  -- funnel counts precomputed at load

-- ── reserved for the dependent slices (NOT built): keys fixed now, columns decided with each slice ──
-- lr_possession_points(possession_id, run_id, ...)    scoring for a franchise's period, from verified weekly rosters only
-- lr_possession_contract(possession_id, run_id, ...)  salary, years, status, from the contract event chain

-- indexes (each index entry counts as a row written, so only these):
CREATE INDEX lr_leg_asset      ON lr_trade_leg(asset_key, ts);
CREATE INDEX lr_event_asset    ON lr_asset_event(asset_key, ts);
CREATE INDEX lr_draftrow_slot  ON lr_draft_row(season, round, overall);
CREATE INDEX lr_poss_asset     ON lr_possession(asset_key, valid_from_run);
CREATE INDEX lr_poss_franchise ON lr_possession(franchise_id, from_ts);
CREATE INDEX lr_link_asset     ON lr_link(from_asset_key, valid_from_run);
CREATE INDEX lr_link_slot      ON lr_link(to_season, to_round, to_slot);
CREATE INDEX lr_trade_season   ON lr_trade(season, ts);
```

**Rules the constraints encode:** a `SELECTED` slot has a draft row, a `FORFEITED`, `UNRESOLVED` or `MISSING_SOURCE_RECORD` slot never has one (so a forfeiture cannot carry a fabricated player); an `UNRESOLVED` link has no slot; a future pick can never be `CONFIRMED` to a slot; every link names an approved or diagnostic method and its version. A selected draft row with no franchise id stays `SELECTED` (`franchise_id` is nullable): the selector is simply not recorded. The 2014 4.12 disagreement is an `lr_conflict` row beside a `SELECTED` slot, not a slot status.

## 4. Source mappings

| Target | Source today | Mapping | Notes |
|---|---|---|---|
| `lr_source` | archive database (dated 2026-06-05), committed 2026 snapshots, the commissioner clarification, later MFL exports | one row each; exports carry the redacted request, capture time and SHA-256 | the raw payload is stored in R2 by hash, referenced by `raw_object_key` |
| `lr_trade`, `lr_trade_party`, `lr_trade_leg`, `lr_trade_cap` | `transactions_trades` (8,744 rows; 1,036 trades) and 2026 snapshot trades | group by `trade_group_id`; pair the RELINQUISH and ACQUIRE rows into legs; the cap amount sits on the sender's row and pairs with the other franchise's CAP row; `date_quality = processing_time_likely` before 2024 | the production D1 mirror drops pick identity, so it is not a source |
| `lr_asset` | trade legs, draft rows | one row per distinct asset key | `DP_` tokens are zero-indexed (`DP_3_11` = 4.12) |
| `lr_asset_event` | `transactions_adddrop`, `transactions_auction` (traded players only), draft selections | add, drop, selection events | other players' events are not loaded |
| `lr_draft_row` | `draftresults_mfl` (575 rows, 2018 on) and `draftresults_legacy` (360 rows, 2012-2017) | one row per source row with the stored slot and the raw pick text | |
| `lr_draft_slot` | scheduled grid: teams x rounds per season with draft results | status from the rows and `lr_forfeiture` (936 slots: 935 SELECTED + 1 FORFEITED today) | |
| `lr_correction` | the 30 legacy rows (decision 1) | stored slot 1, corrected slot 10, method `legacy_tenth_pick_stored_as_slot_1`, source reference (table, season, round, overall, raw pick text) | applies only to the documented pattern |
| `lr_forfeiture` | `docs/league_record/known_forfeitures.json` | 1 row: 2018 4.12, "owner violation", "commissioner clarification"; `not_recorded_json` lists what is not recorded | |
| `lr_coverage`, `lr_coverage_check` | extraction coverage intervals; `docs/league_record/coverage_verifications.json` | 38 UNVERIFIED windows + 1 KNOWN_GAP today; verified records only through validated verification files | |
| `lr_possession`, `lr_link`, `lr_link_candidate`, `lr_conflict`, `lr_summary` | derived by the committed extraction code | the same functions that produce `extraction.json` | loaded, never computed in a request path |

## 5. Estimated volume and the write budget

Row estimates from the archive (counts in bold are exact; the rest are estimates with their basis; **measure before any go**):

| Table | Rows | Basis |
|---|---|---|
| `lr_source`, `lr_method`, `lr_run`, `lr_release` | about 60 | handful of sources and methods |
| `lr_coverage` (+ checks) | about 100 | **39** intervals today, more as verified |
| `lr_asset` | about 2,000 | 871 traded players + 597 future picks + 451 slot picks + 2026 picks |
| `lr_trade` / `_party` / `_leg` / `_cap` | **1,036** / about 2,200 / about 4,250 / **130** | 8,744 raw rows; each leg appears twice in the raw table |
| `lr_asset_event` | about 6,000 | adds, drops and auction wins of traded players (estimate) |
| `lr_draft_row` / `lr_draft_slot` / `lr_forfeiture` / `lr_correction` | **935** / **936** / **1** / **30** | |
| `lr_possession` | about 10,500 | one per leg or event stint |
| `lr_link` / `_candidate` | about 1,050 / about 1,500 | **451** slot picks + **597** future picks |
| `lr_conflict`, `lr_summary` | under 100 | |
| **Total** | **about 31,000 rows (range 22,000 to 45,000)** | |

**Rows written on a first load, counting index entries:** about 31,000 rows times about 2.3 entries per row (tables without a rowid alias count the primary-key index; the eight secondary indexes above add one each) is roughly **70,000 rows written** (range 50,000 to 100,000). That is under the Free limit of 100,000 per UTC day **only if nothing else writes that day** (the counter is account-wide and shared with the stats refresh). Plan: load in chunks of at most 25,000 written rows, one chunk per run, ideally over two UTC days, measuring with `wrangler d1 info` and `scripts/d1_usage.py` after each chunk; the loader writes only changed rows (the `D1Writer` pattern), so a repeated load writes 0.

**Steady state:** a rebuild after one new trade or one new verification writes tens of rows. Finished seasons are never rewritten. A new release is a `lr_run` row, a `lr_release` row and the changed derived rows.

## 6. Read and query design (estimated `rows_read`; to be measured with `EXPLAIN QUERY PLAN` and the local replica)

All reads take the active run once (`lr_release`, 1 row) and filter derived rows with `valid_from_run <= :run AND (valid_to_run IS NULL OR valid_to_run > :run)`.

| Query | Access path | Est. rows read |
|---|---|---|
| A pick's lineage: legs, possessions, link, candidates | `lr_leg_asset`, `lr_poss_asset`, `lr_link_asset` by `asset_key` | about 50 |
| One trade as a package: parties, legs, cap with direction | primary keys of the child tables | about 20-100 |
| A season's draft: slots and their rows and links | `lr_draft_slot` primary key prefix, `lr_draftrow_slot`, `lr_link_slot` | about 72 slots + 72 rows + up to 100 links |
| A franchise's possession history | `lr_poss_franchise` ordered by `from_ts`, paged 100 rows | 100 per page; whole history about 700-1,000 |
| Coverage intervals and gaps | `lr_coverage` (about 100 rows) | about 100 |
| Funnel and evidence counts | `lr_summary` for the active run | under 50 (never `COUNT(*)` over links) |

Each page is on the order of 100 to 1,000 rows against a 5,000,000-row daily read budget; 1,000 page views a day at 300 rows is 300,000 rows. **No query joins on an unindexed column, uses `OR` across columns, or sorts a whole table.** The `ORDER BY ... LIMIT` paths match their index order (`D1_QUERY_RULES.md`). Rows over about 100,000 per run would need a precompute; none is expected. TEXT `asset_key` is compared with TEXT only.

## 7. Alternatives and tradeoffs

| Option | What it is | For | Against |
|---|---|---|---|
| **A. Normalized tables in D1 (recommended core)** | The schema above | Enforced classes and statuses; ad hoc and cross-cutting reads (a franchise's history, a season's draft); small (about 31,000 rows); precise corrections and versioning | Most rows written (about 70,000 on first load); needs migrations, indexes and careful loaders |
| **B. One JSON document per subject in D1** | One row per trade, pick lineage or season, holding the whole derivation | Few rows (about 3,000), cheap writes, simple release switch | Nothing enforces a status or class; no cross-cutting query without scanning JSON; corrections rewrite whole documents |
| **C. Static bundles in R2 with a small D1 index and release pointer** | Versioned JSON files built offline; D1 holds only the index and active release | Cheapest on D1 (hundreds of rows); versioning is natural (object key = run); trivially inside the Free plan | No ad hoc queries; each page fetches and parses a bundle in the Worker; harder to join with live league data |
| **D. No storage layer** (committed bundle only) | What exists today | No production risk | No owner-facing product |

**Recommendation:** **A, built in slices, with raw payloads in R2 by hash.** Build only slice 1 (sources, coverage, trades, draft, links, conflicts) first; contracts and scoring attach later through `possession_id`. If the first owner-facing need is only a few pages, **C** reaches it with almost no D1 cost and can be replaced by A without changing the evidence model, because both use the same classes and methods. B is not recommended: it stores an uncertain relationship as a definitive document.

## 8. Migration and rollback plan (a plan; nothing is applied)

1. **Additive only.** One new numbered migration (the next free number after `0181` in `worker/migrations/`) creates the `lr_` tables. No existing table is altered, no existing index changed.
2. **Rehearse before production:** (a) a local SQLite/miniflare replica (`reference_d1_local_replica_rows_read`); (b) a **temporary D1 database** (created for the test, deleted after) to measure rows written and read exactly, as was done for the writer change on 2026-10-13. Production only with the commissioner's explicit go for that action.
3. **Apply with the tool, not by hand:** `wrangler d1 migrations apply`, because hand-applied migrations drift the tracker.
4. **Ship dark:** any Worker route reads behind a default-off flag; nothing user-visible changes until it is switched on.
5. **Load in chunks** by run id (section 5); a run that never gets a `lr_release` row is invisible to readers.
6. **Rollback, data:** retire the active `lr_release` row and re-activate the previous run: **no row is deleted**, nothing is rewritten, it takes one write.
7. **Rollback, schema:** a reverse-order `DROP TABLE` script, run only after the flag is off and no route reads the tables; the tables hold no data that exists nowhere else, because they are rebuilt from the committed extraction and the R2 payloads.
8. **Cleaning up a failed load:** drop the staging run's rows by run id in small batches (deletes count as writes), or, on the temporary database, drop the database.

## 9. Testing requirements (all offline by default; production access is an explicit opt-in that prints SKIPPED otherwise)

- **Schema tests:** every `CHECK` refuses its bad case (a forfeited slot with a player, an unresolved link with a slot, a future pick CONFIRMED to a slot, an unknown class or status, a leg with an unknown asset).
- **Oracle test:** load the staging database from the committed extraction and compare every count and sampled record with `extraction.json` and the pilot bundle; a second code path recomputes the counts with SQL on the archive.
- **Invariants:** 936 scheduled slots = 935 SELECTED + 1 FORFEITED + 0 UNRESOLVED + 0 MISSING; 30 corrections each with original, corrected value, method, approval and source reference; every trade leg has a from-franchise; cap direction preserved for all 130 transfers; possession periods of one asset never overlap; 597 future-pick links all UNRESOLVED until a method is approved; the 2014 4.12 conflict is a conflict row beside a SELECTED slot.
- **Reproducibility:** rebuilding from the same source set and code sha yields identical derived rows; an old run read "as of run R" equals the release that was active then.
- **Query plans:** `EXPLAIN QUERY PLAN` for every query in section 6 shows `SEARCH ... USING INDEX`, never a `SCAN` on a hot path; measured `rows_read` stays under the stated bound.
- **Write budget:** a dry load on the temporary database reports rows written including index entries, stays under the chunk limit, and a repeated load writes 0.
- **Rollback rehearsal:** flip the release pointer back and forth on the temporary database and confirm reads change and no row is deleted; run the schema rollback script and confirm no existing table is affected.
- **Privacy test:** no column holds an owner name, e-mail, MFL free-text comment or credential; sampled rows are scanned.
- **Standing rules:** no slot or order derived from standings, finishes or a projected order appears in any loader (the existing source scan covers the loader modules).

## 10. Open design decisions (for the commissioner and the architecture review)

1. **Which slice is first:** the recommendation is slice 1 only (sources, coverage, trades, draft, links, conflicts).
2. **A or C for the first owner-facing pages** (section 7).
3. **Where raw MFL payloads live:** R2 by hash (recommended) or not stored at all (only hashes and sanitized extracts).
4. **Free-plan load schedule:** one chunk a day for two days, or a one-off paid-plan window, if the account is still on Workers Paid when the load happens.
5. **Retention of superseded derived rows:** keep all runs (about 10,000 rows per full rebuild if changed rows only are written, small) or prune runs older than a stated horizon.
