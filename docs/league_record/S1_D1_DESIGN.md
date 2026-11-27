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
2. **Facts are append-only; correct by adding.** A fact row is never changed. A correction is a row in `lr_correction` that points at the stored value, so the original always survives. The only update the design ever makes is closing a derived row (`valid_to_run`).
3. **Versioned, linear runs.** Layer-1 facts carry `loaded_run`; layers 2 and 3 carry `valid_from_run` and `valid_to_run`. The active release names one run R; a read sees facts with `loaded_run <= R` and derived rows with `valid_from_run <= R < valid_to_run`, excluding any run listed in `lr_run_excluded` (a derived row whose `valid_to_run` is an excluded run counts as still open, so rows closed by an abandoned run are visible again). So a release can be reproduced exactly as it was (a fact added later, such as a trade found in the gap, is invisible to an earlier run), and going back to an earlier run is a pointer change. Runs are strictly linear; the rule for continuing after a rollback is in section 8.
4. **Write only what changed.** A rebuild inserts changed or new derived rows and closes the superseded ones; finished seasons are never rewritten (`D1_QUERY_RULES.md`, Writes).
5. **No private data.** Franchise ids and public league identifiers only: no owner name, e-mail, message text or credential. Free-text `comments` from MFL are not stored.
6. **Enumerations are enforced by the database** (`CHECK`), not by convention: statuses, classes, event classes, coverage states.

## 3. Proposed schema (all tables prefixed `lr_`; additive; integers are epoch seconds or counts; dates are Eastern ISO text)

```sql
-- ── versioning ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE lr_run (
  run_id INTEGER PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('build','correction','verification','rollback')),
  created_utc TEXT NOT NULL, code_sha TEXT NOT NULL, source_set_sha256 TEXT NOT NULL,
  parent_run_id INTEGER REFERENCES lr_run(run_id), note TEXT);
CREATE TABLE lr_release (                       -- the active release is the row with retired_utc IS NULL; rollback = retire it and re-activate an earlier run
  release_id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES lr_run(run_id),
  activated_utc TEXT NOT NULL, activated_by_ref TEXT NOT NULL, retired_utc TEXT);
CREATE TABLE lr_run_excluded (                  -- a run abandoned after a rollback: its rows are invisible to every later run
  run_id INTEGER PRIMARY KEY REFERENCES lr_run(run_id), excluded_by_run INTEGER NOT NULL REFERENCES lr_run(run_id), CHECK (excluded_by_run > run_id));
CREATE TABLE lr_method (
  method_id TEXT NOT NULL, version INTEGER NOT NULL, description TEXT NOT NULL, approved_ref TEXT,
  status TEXT NOT NULL CHECK (status IN ('approved','diagnostic','retired')), PRIMARY KEY (method_id, version)) WITHOUT ROWID;

-- ── sources and coverage ──────────────────────────────────────────────────────────────────────
CREATE TABLE lr_source (
  source_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK (kind IN ('archive_db','mfl_export','snapshot','commissioner_clarification','context')),
  authority TEXT NOT NULL CHECK (authority IN ('authoritative','derived','secondary','context')),
  league_id TEXT, season_year INTEGER, request_template TEXT,        -- the URL with the key replaced by REDACTED
  captured_utc TEXT, content_sha256 TEXT,                            -- only the hash of a raw payload is kept: no raw response, no MFL comments, no pending offers are stored anywhere
  note_ref TEXT, loaded_run INTEGER NOT NULL REFERENCES lr_run(run_id));
CREATE TABLE lr_coverage (
  coverage_id INTEGER PRIMARY KEY, source_id TEXT REFERENCES lr_source(source_id),
  event_class TEXT NOT NULL CHECK (event_class IN ('pick_transfer','player_move')),
  from_date TEXT NOT NULL, to_date TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('VERIFIED_COMPLETE','UNVERIFIED','KNOWN_GAP')), basis TEXT NOT NULL,
  valid_from_run INTEGER NOT NULL REFERENCES lr_run(run_id), valid_to_run INTEGER REFERENCES lr_run(run_id),
  CHECK (valid_to_run IS NULL OR valid_to_run > valid_from_run),
  CHECK (state <> 'VERIFIED_COMPLETE' OR source_id IS NOT NULL));      -- a verified interval names its source; its checks are enforced at release time (trigger below)
CREATE TABLE lr_coverage_check (
  check_id INTEGER PRIMARY KEY, coverage_id INTEGER NOT NULL REFERENCES lr_coverage(coverage_id),
  check_kind TEXT NOT NULL CHECK (check_kind IN ('archive_comparison','chain_continuity','end_state_reconciliation')),
  passed INTEGER NOT NULL CHECK (passed IN (0,1)), detail TEXT);

-- ── identity ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE lr_asset (
  asset_key TEXT PRIMARY KEY,                    -- 'player:<id>' | 'fpick:<orig>:<year>:<round>' | 'spick:<year>:<round>:<slot>' (as in the extraction)
  loaded_run INTEGER NOT NULL REFERENCES lr_run(run_id),
  asset_type TEXT NOT NULL CHECK (asset_type IN ('PLAYER','FUTURE_PICK','SLOT_PICK')),
  player_id TEXT, orig_franchise TEXT, pick_year INTEGER, pick_round INTEGER, pick_slot INTEGER,
  CHECK ((asset_type='PLAYER' AND player_id IS NOT NULL) OR (asset_type='FUTURE_PICK' AND orig_franchise IS NOT NULL AND pick_year IS NOT NULL AND pick_round IS NOT NULL AND pick_slot IS NULL)
      OR (asset_type='SLOT_PICK' AND pick_year IS NOT NULL AND pick_round IS NOT NULL AND pick_slot IS NOT NULL AND orig_franchise IS NULL)));

-- ── layer 1: facts exactly as recorded ───────────────────────────────────────────────────────
CREATE TABLE lr_trade (
  trade_id TEXT PRIMARY KEY, loaded_run INTEGER NOT NULL REFERENCES lr_run(run_id),     -- children (party, leg, cap) are visible with their trade
  season INTEGER NOT NULL, ts INTEGER NOT NULL, date_et TEXT NOT NULL,
  date_quality TEXT NOT NULL CHECK (date_quality IN ('recorded','processing_time_likely')),
  source_id TEXT NOT NULL REFERENCES lr_source(source_id), source_key TEXT NOT NULL);
CREATE TABLE lr_trade_party (trade_id TEXT NOT NULL REFERENCES lr_trade(trade_id), franchise_id TEXT NOT NULL, PRIMARY KEY (trade_id, franchise_id)) WITHOUT ROWID;
CREATE TABLE lr_trade_leg (                      -- one row per moved asset; the package is the trade
  trade_id TEXT NOT NULL REFERENCES lr_trade(trade_id), leg_no INTEGER NOT NULL, asset_key TEXT NOT NULL REFERENCES lr_asset(asset_key),
  from_franchise TEXT NOT NULL, to_franchise TEXT, ts INTEGER NOT NULL,   -- ts repeated from the trade so a chain is read from one index
  raw_ids TEXT NOT NULL,                                                  -- the source transaction ids of the two rows (relinquish and acquire) that make the leg
  PRIMARY KEY (trade_id, leg_no)) WITHOUT ROWID;
CREATE TABLE lr_trade_cap (                      -- cap-transfer direction: from sends cap room to
  trade_id TEXT NOT NULL REFERENCES lr_trade(trade_id), cap_no INTEGER NOT NULL, from_franchise TEXT NOT NULL, to_franchise TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (typeof(amount) = 'integer' AND amount > 0),    -- a missing, zero or fractional amount is refused, never stored as 0 or rounded (see the known discrepancy, section 5)
  amount_source TEXT NOT NULL CHECK (amount_source IN ('archive_column','raw_token')),   -- where the number came from (S1_CAP_TOKEN_CORRECTION.md); an unrecoverable amount is not loaded
  token TEXT,                                                                   -- the raw token an amount was read from
  CHECK (amount_source <> 'raw_token' OR length(ifnull(token, '')) > 0),
  PRIMARY KEY (trade_id, cap_no)) WITHOUT ROWID;
CREATE TABLE lr_asset_event (                    -- non-trade events of traded players: draft selection, add, drop; and the forfeiture of a slot
  event_id INTEGER PRIMARY KEY, loaded_run INTEGER NOT NULL REFERENCES lr_run(run_id), asset_key TEXT NOT NULL REFERENCES lr_asset(asset_key),
  kind TEXT NOT NULL CHECK (kind IN ('draft_selection','add','drop','forfeiture')), ts INTEGER NOT NULL, from_franchise TEXT, to_franchise TEXT,
  date_quality TEXT, source_id TEXT NOT NULL REFERENCES lr_source(source_id), source_key TEXT NOT NULL);

-- ── draft: raw rows, normalized slots, forfeitures, corrections ──────────────────────────────
CREATE TABLE lr_draft_row (                      -- the source rows as stored, including the stored slot and the raw text
  draft_row_id INTEGER PRIMARY KEY, loaded_run INTEGER NOT NULL REFERENCES lr_run(run_id), season INTEGER NOT NULL, round INTEGER NOT NULL, slot_raw INTEGER NOT NULL, overall INTEGER NOT NULL,
  raw_pick_text TEXT, franchise_id TEXT,         -- NULL when the source row records no franchise id (selector not recorded)
  player_id TEXT NOT NULL, ts INTEGER, source_id TEXT NOT NULL REFERENCES lr_source(source_id), source_key TEXT NOT NULL);
CREATE TABLE lr_draft_slot (                     -- one row per SCHEDULED slot
  season INTEGER NOT NULL, round INTEGER NOT NULL, slot INTEGER NOT NULL, overall INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('SELECTED','FORFEITED','UNRESOLVED','MISSING_SOURCE_RECORD')),
  draft_row_id INTEGER REFERENCES lr_draft_row(draft_row_id),
  valid_from_run INTEGER NOT NULL REFERENCES lr_run(run_id), valid_to_run INTEGER REFERENCES lr_run(run_id),
  PRIMARY KEY (season, round, slot, valid_from_run),
  CHECK (valid_to_run IS NULL OR valid_to_run > valid_from_run),
  CHECK ((status='SELECTED' AND draft_row_id IS NOT NULL) OR (status<>'SELECTED' AND draft_row_id IS NULL)));   -- a forfeited or missing slot never carries a player
CREATE TABLE lr_forfeiture (
  season INTEGER NOT NULL, round INTEGER NOT NULL, slot INTEGER NOT NULL, overall INTEGER NOT NULL, reason TEXT NOT NULL, provenance TEXT NOT NULL,
  clarification_recorded_on TEXT NOT NULL, not_recorded_json TEXT NOT NULL,    -- the things deliberately NOT recorded (violation, owner, ruling date, transaction)
  loaded_run INTEGER NOT NULL REFERENCES lr_run(run_id), PRIMARY KEY (season, round, slot)) WITHOUT ROWID;
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
  valid_from_run INTEGER NOT NULL REFERENCES lr_run(run_id), valid_to_run INTEGER REFERENCES lr_run(run_id),
  CHECK (valid_to_run IS NULL OR valid_to_run > valid_from_run),
  CHECK (evidence_class NOT IN ('CONFIRMED','CALCULATED') OR weakest_coverage = 'VERIFIED_COMPLETE'));   -- continuity over unverified days is INFERRED (it rests on the absence of a record), never CONFIRMED or CALCULATED

-- ── layer 3: links with a class, never a flattened outcome ───────────────────────────────────
CREATE TABLE lr_link (
  link_id INTEGER PRIMARY KEY, link_type TEXT NOT NULL CHECK (link_type IN ('FUTURE_PICK_TO_SLOT','SLOT_PICK_TO_SELECTION')),
  from_asset_key TEXT NOT NULL REFERENCES lr_asset(asset_key),
  to_season INTEGER, to_round INTEGER, to_slot INTEGER,        -- NULL while UNRESOLVED
  class TEXT NOT NULL CHECK (class IN ('CONFIRMED','CALCULATED','INFERRED','UNRESOLVED')),
  method_id TEXT NOT NULL, method_version INTEGER NOT NULL, blockers_json TEXT, evidence_json TEXT,
  valid_from_run INTEGER NOT NULL REFERENCES lr_run(run_id), valid_to_run INTEGER REFERENCES lr_run(run_id),
  FOREIGN KEY (method_id, method_version) REFERENCES lr_method(method_id, version),
  CHECK (valid_to_run IS NULL OR valid_to_run > valid_from_run),
  CHECK ((class='UNRESOLVED' AND to_season IS NULL AND to_round IS NULL AND to_slot IS NULL) OR (class<>'UNRESOLVED' AND to_season IS NOT NULL AND to_round IS NOT NULL AND to_slot IS NOT NULL AND evidence_json IS NOT NULL)),
  CHECK (NOT (link_type='FUTURE_PICK_TO_SLOT' AND class IN ('CONFIRMED','CALCULATED'))));    -- by rule a future pick is only ever INFERRED to a slot or UNRESOLVED; count netting cannot be stored as CALCULATED
CREATE TABLE lr_link_candidate (link_id INTEGER NOT NULL REFERENCES lr_link(link_id), season INTEGER NOT NULL, round INTEGER NOT NULL, slot INTEGER NOT NULL, via TEXT NOT NULL,
  PRIMARY KEY (link_id, season, round, slot)) WITHOUT ROWID;
CREATE TABLE lr_conflict (                       -- a recorded disagreement between sources: kept, never resolved by the model (for example 2014 pick 4.12)
  conflict_id INTEGER PRIMARY KEY, subject_key TEXT NOT NULL, kind TEXT NOT NULL, left_ref TEXT NOT NULL, right_ref TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('open','resolved_by_source','resolved_by_ruling')), ruling_ref TEXT, run_id INTEGER NOT NULL REFERENCES lr_run(run_id),
  valid_to_run INTEGER REFERENCES lr_run(run_id),                                -- a resolution is a NEW row; the open row is closed
  CHECK (valid_to_run IS NULL OR valid_to_run > run_id),
  CHECK (status = 'open' OR length(ifnull(ruling_ref, '')) > 0));               -- a resolved conflict cites the source or ruling that resolved it
CREATE TABLE lr_evidence_need (                 -- the explicit record of unresolved historical evidence: what is missing, which register item tracks it, and whether the limitation was accepted
  need_id INTEGER PRIMARY KEY, subject_type TEXT NOT NULL CHECK (subject_type IN ('LINK','CONFLICT','COVERAGE','CORRECTION')), subject_id INTEGER NOT NULL,
  need_code TEXT NOT NULL, register_ref TEXT NOT NULL,                  -- the item on the pre-live register (issue #1486), for example 'LR-03'
  description TEXT NOT NULL, status TEXT NOT NULL CHECK (status IN ('OPEN','INVESTIGATING','ACCEPTED_LIMITATION','RESOLVED')), accepted_by_ref TEXT,
  valid_from_run INTEGER NOT NULL REFERENCES lr_run(run_id), valid_to_run INTEGER REFERENCES lr_run(run_id),
  CHECK (valid_to_run IS NULL OR valid_to_run > valid_from_run),
  CHECK (status <> 'ACCEPTED_LIMITATION' OR length(ifnull(accepted_by_ref, '')) > 0));      -- a limitation is accepted by a cited decision, never silently
CREATE TABLE lr_summary (run_id INTEGER NOT NULL REFERENCES lr_run(run_id), metric TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY (run_id, metric)) WITHOUT ROWID;  -- funnel counts precomputed at load

-- ── reserved for the dependent slices (NOT built): keys fixed now, columns decided with each slice ──
-- lr_possession_points(possession_id, run_id, ...)    scoring for a franchise's period, from verified weekly rosters only
-- lr_possession_contract(possession_id, run_id, ...)  salary, years, status, from the contract event chain

-- indexes (each index entry counts as a row written, so only these):
CREATE INDEX lr_leg_asset      ON lr_trade_leg(asset_key, ts);
CREATE INDEX lr_event_asset    ON lr_asset_event(asset_key, ts);
CREATE INDEX lr_draftrow_slot  ON lr_draft_row(season, round, overall);
CREATE INDEX lr_poss_asset     ON lr_possession(asset_key, valid_from_run);
CREATE INDEX lr_poss_franchise ON lr_possession(franchise_id, from_ts, valid_from_run);
CREATE INDEX lr_link_asset     ON lr_link(from_asset_key, valid_from_run);
CREATE INDEX lr_link_slot      ON lr_link(to_season, to_round, to_slot, valid_from_run);
CREATE INDEX lr_trade_season   ON lr_trade(season, ts);
CREATE UNIQUE INDEX lr_one_active_release ON lr_release((1)) WHERE retired_utc IS NULL;                          -- exactly one active release
CREATE UNIQUE INDEX lr_one_open_link      ON lr_link(from_asset_key, link_type) WHERE valid_to_run IS NULL;      -- one open link per pick and type: no two readings of one pick at once
CREATE UNIQUE INDEX lr_one_open_slot      ON lr_draft_slot(season, round, slot) WHERE valid_to_run IS NULL;      -- a slot is never open as both FORFEITED and SELECTED

-- integrity rules a column check cannot express (each aborts the statement):
CREATE TRIGGER lr_forfeited_needs_record BEFORE INSERT ON lr_draft_slot WHEN NEW.status = 'FORFEITED'
  AND NOT EXISTS (SELECT 1 FROM lr_forfeiture f WHERE f.season = NEW.season AND f.round = NEW.round AND f.slot = NEW.slot)
  BEGIN SELECT RAISE(ABORT, 'a forfeited slot needs a forfeiture record with its provenance'); END;
CREATE TRIGGER lr_selected_matches_row BEFORE INSERT ON lr_draft_slot WHEN NEW.status = 'SELECTED'
  AND NOT EXISTS (SELECT 1 FROM lr_draft_row r WHERE r.draft_row_id = NEW.draft_row_id AND r.season = NEW.season AND r.round = NEW.round AND r.overall = NEW.overall
       AND (r.slot_raw = NEW.slot OR EXISTS (SELECT 1 FROM lr_correction c WHERE c.target_table = 'lr_draft_row' AND c.target_key = CAST(r.draft_row_id AS TEXT) AND c.field = 'slot' AND c.corrected_value = CAST(NEW.slot AS TEXT))))
  BEGIN SELECT RAISE(ABORT, 'a selected slot must match its draft row (season, round, overall); a slot that differs from the stored slot needs a correction record'); END;
CREATE TRIGGER lr_link_asset_type BEFORE INSERT ON lr_link
  WHEN NOT EXISTS (SELECT 1 FROM lr_asset a WHERE a.asset_key = NEW.from_asset_key AND a.asset_type = CASE NEW.link_type WHEN 'FUTURE_PICK_TO_SLOT' THEN 'FUTURE_PICK' ELSE 'SLOT_PICK' END)
  BEGIN SELECT RAISE(ABORT, 'a link starts from an asset of the matching type'); END;
CREATE TRIGGER lr_link_target_year BEFORE INSERT ON lr_link WHEN NEW.link_type = 'FUTURE_PICK_TO_SLOT' AND NEW.class <> 'UNRESOLVED'
  AND NOT EXISTS (SELECT 1 FROM lr_asset a WHERE a.asset_key = NEW.from_asset_key AND a.pick_year = NEW.to_season AND a.pick_round = NEW.to_round)
  BEGIN SELECT RAISE(ABORT, 'a future pick resolves only to a slot of its own year and round'); END;
CREATE TRIGGER lr_link_needs_approved_method BEFORE INSERT ON lr_link WHEN NEW.class <> 'UNRESOLVED'
  AND NOT EXISTS (SELECT 1 FROM lr_method m WHERE m.method_id = NEW.method_id AND m.version = NEW.method_version AND m.status = 'approved')
  BEGIN SELECT RAISE(ABORT, 'a link above UNRESOLVED needs an approved method; a diagnostic method can only leave a pick UNRESOLVED'); END;
CREATE TRIGGER lr_candidates_only_unresolved BEFORE INSERT ON lr_link_candidate
  WHEN NOT EXISTS (SELECT 1 FROM lr_link l WHERE l.link_id = NEW.link_id AND l.class = 'UNRESOLVED')
  BEGIN SELECT RAISE(ABORT, 'candidates belong to an UNRESOLVED link only'); END;
CREATE TRIGGER lr_no_failed_check_on_verified BEFORE INSERT ON lr_coverage_check WHEN NEW.passed = 0
  AND EXISTS (SELECT 1 FROM lr_coverage c WHERE c.coverage_id = NEW.coverage_id AND c.state = 'VERIFIED_COMPLETE')
  BEGIN SELECT RAISE(ABORT, 'a failed check voids a verified interval'); END;
CREATE TRIGGER lr_release_gate BEFORE INSERT ON lr_release              -- a release cannot activate while a verified interval lacks its two required passing checks, or has any failed one
  WHEN EXISTS (SELECT 1 FROM lr_coverage c WHERE c.state = 'VERIFIED_COMPLETE' AND c.valid_from_run <= NEW.run_id AND c.valid_from_run NOT IN (SELECT run_id FROM lr_run_excluded) AND (c.valid_to_run IS NULL OR c.valid_to_run > NEW.run_id OR c.valid_to_run IN (SELECT run_id FROM lr_run_excluded))
       AND (NOT EXISTS (SELECT 1 FROM lr_coverage_check k WHERE k.coverage_id = c.coverage_id AND k.check_kind = 'archive_comparison' AND k.passed = 1)
         OR NOT EXISTS (SELECT 1 FROM lr_coverage_check k WHERE k.coverage_id = c.coverage_id AND k.check_kind = 'end_state_reconciliation' AND k.passed = 1)
         OR EXISTS (SELECT 1 FROM lr_coverage_check k WHERE k.coverage_id = c.coverage_id AND k.passed = 0)))
  BEGIN SELECT RAISE(ABORT, 'a verified interval needs a passing archive comparison, a passing end-state reconciliation and no failed check'); END;
CREATE TRIGGER lr_release_retire_only BEFORE UPDATE ON lr_release          -- a release row can only be retired once; its run and activation never change, so the insert-time gates cannot be walked around
  WHEN NEW.release_id IS NOT OLD.release_id OR NEW.run_id IS NOT OLD.run_id OR NEW.activated_utc IS NOT OLD.activated_utc OR NEW.activated_by_ref IS NOT OLD.activated_by_ref OR (OLD.retired_utc IS NOT NULL AND NEW.retired_utc IS NOT OLD.retired_utc)
  BEGIN SELECT RAISE(ABORT, 'a release can only be retired'); END;
CREATE TRIGGER lr_release_needs_recorded_evidence BEFORE INSERT ON lr_release           -- nothing unresolved may be released without its recorded evidence need or its recorded resolution
  WHEN EXISTS (SELECT 1 FROM lr_link l WHERE l.class = 'UNRESOLVED' AND l.valid_from_run <= NEW.run_id AND l.valid_from_run NOT IN (SELECT run_id FROM lr_run_excluded) AND (l.valid_to_run IS NULL OR l.valid_to_run > NEW.run_id OR l.valid_to_run IN (SELECT run_id FROM lr_run_excluded))
        AND NOT EXISTS (SELECT 1 FROM lr_evidence_need n WHERE n.subject_type = 'LINK' AND n.subject_id = l.link_id AND n.status IN ('OPEN','INVESTIGATING','ACCEPTED_LIMITATION') AND n.valid_from_run <= NEW.run_id AND n.valid_from_run NOT IN (SELECT run_id FROM lr_run_excluded) AND (n.valid_to_run IS NULL OR n.valid_to_run > NEW.run_id OR n.valid_to_run IN (SELECT run_id FROM lr_run_excluded))))   -- the need must apply to the run being released
    OR EXISTS (SELECT 1 FROM lr_conflict c WHERE c.status = 'open' AND c.run_id <= NEW.run_id AND c.run_id NOT IN (SELECT run_id FROM lr_run_excluded) AND (c.valid_to_run IS NULL OR c.valid_to_run > NEW.run_id OR c.valid_to_run IN (SELECT run_id FROM lr_run_excluded))
        AND NOT EXISTS (SELECT 1 FROM lr_evidence_need n WHERE n.subject_type = 'CONFLICT' AND n.subject_id = c.conflict_id AND n.status IN ('OPEN','INVESTIGATING','ACCEPTED_LIMITATION') AND n.valid_from_run <= NEW.run_id AND n.valid_from_run NOT IN (SELECT run_id FROM lr_run_excluded) AND (n.valid_to_run IS NULL OR n.valid_to_run > NEW.run_id OR n.valid_to_run IN (SELECT run_id FROM lr_run_excluded))))
    OR EXISTS (SELECT 1 FROM lr_conflict c WHERE c.status = 'open' AND c.run_id <= NEW.run_id AND c.run_id NOT IN (SELECT run_id FROM lr_run_excluded)                                                   -- an open conflict that has been CLOSED must still have the live resolution begun in its closing run
        AND c.valid_to_run IS NOT NULL AND c.valid_to_run <= NEW.run_id AND c.valid_to_run NOT IN (SELECT run_id FROM lr_run_excluded)
        AND NOT EXISTS (SELECT 1 FROM lr_conflict r WHERE r.subject_key = c.subject_key AND r.status <> 'open' AND r.run_id = c.valid_to_run AND r.run_id <= NEW.run_id AND r.run_id NOT IN (SELECT run_id FROM lr_run_excluded) AND (r.valid_to_run IS NULL OR r.valid_to_run > NEW.run_id OR r.valid_to_run IN (SELECT run_id FROM lr_run_excluded))))
  BEGIN SELECT RAISE(ABORT, 'every unresolved link and open conflict needs a recorded evidence need, and every closed conflict a recorded resolution, before a release'); END;
CREATE TRIGGER lr_evidence_need_close_only BEFORE UPDATE ON lr_evidence_need
  WHEN NEW.need_id IS NOT OLD.need_id OR NEW.subject_type IS NOT OLD.subject_type OR NEW.subject_id IS NOT OLD.subject_id OR NEW.need_code IS NOT OLD.need_code OR NEW.register_ref IS NOT OLD.register_ref
    OR NEW.description IS NOT OLD.description OR NEW.status IS NOT OLD.status OR NEW.accepted_by_ref IS NOT OLD.accepted_by_ref OR NEW.valid_from_run IS NOT OLD.valid_from_run OR (OLD.valid_to_run IS NOT NULL AND NEW.valid_to_run IS NOT OLD.valid_to_run)
  BEGIN SELECT RAISE(ABORT, 'an evidence need can only be closed; a changed status is a new row'); END;
CREATE TRIGGER lr_evidence_need_subject_exists BEFORE INSERT ON lr_evidence_need
  WHEN NOT CASE NEW.subject_type
    WHEN 'LINK' THEN EXISTS (SELECT 1 FROM lr_link WHERE link_id = NEW.subject_id)
    WHEN 'CONFLICT' THEN EXISTS (SELECT 1 FROM lr_conflict WHERE conflict_id = NEW.subject_id)
    WHEN 'COVERAGE' THEN EXISTS (SELECT 1 FROM lr_coverage WHERE coverage_id = NEW.subject_id)
    ELSE EXISTS (SELECT 1 FROM lr_correction WHERE correction_id = NEW.subject_id) END
  BEGIN SELECT RAISE(ABORT, 'an evidence need must point at an existing link, conflict, coverage interval or correction'); END;
CREATE TRIGGER lr_conflict_close_only BEFORE UPDATE ON lr_conflict
  WHEN NEW.conflict_id IS NOT OLD.conflict_id OR NEW.subject_key IS NOT OLD.subject_key OR NEW.kind IS NOT OLD.kind OR NEW.left_ref IS NOT OLD.left_ref OR NEW.right_ref IS NOT OLD.right_ref
    OR NEW.status IS NOT OLD.status OR NEW.ruling_ref IS NOT OLD.ruling_ref OR NEW.run_id IS NOT OLD.run_id OR (OLD.valid_to_run IS NOT NULL AND NEW.valid_to_run IS NOT OLD.valid_to_run)
  BEGIN SELECT RAISE(ABORT, 'a conflict can only be closed; its resolution is a new row that cites the source or ruling'); END;
CREATE TRIGGER lr_conflict_close_needs_resolution BEFORE UPDATE OF valid_to_run ON lr_conflict   -- closing an OPEN conflict hides it from the release gate, so it is allowed only together with its resolution row
  WHEN OLD.status = 'open' AND NEW.valid_to_run IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM lr_conflict r WHERE r.subject_key = OLD.subject_key AND r.status <> 'open' AND r.run_id = NEW.valid_to_run AND r.valid_to_run IS NULL)
  BEGIN SELECT RAISE(ABORT, 'an open conflict can be closed only by a resolution row (with its source or ruling) begun in the closing run'); END;
CREATE TRIGGER lr_exclusion_permanent_u BEFORE UPDATE ON lr_run_excluded BEGIN SELECT RAISE(ABORT, 'an exclusion is permanent'); END;
CREATE TRIGGER lr_exclusion_permanent_d BEFORE DELETE ON lr_run_excluded BEGIN SELECT RAISE(ABORT, 'an exclusion is permanent'); END;
CREATE TRIGGER lr_release_history_d BEFORE DELETE ON lr_release BEGIN SELECT RAISE(ABORT, 'release history is never deleted'); END;
CREATE TRIGGER lr_release_not_excluded BEFORE INSERT ON lr_release WHEN EXISTS (SELECT 1 FROM lr_run_excluded e WHERE e.run_id = NEW.run_id)
  BEGIN SELECT RAISE(ABORT, 'an excluded (abandoned) run can never be released'); END;

-- updates: facts never change; a derived row may only be CLOSED (valid_to_run set once, never reopened), so an UPDATE cannot walk around the insert rules above
CREATE TRIGGER lr_facts_immutable_trade   BEFORE UPDATE ON lr_trade        BEGIN SELECT RAISE(ABORT, 'facts are append-only'); END;
CREATE TRIGGER lr_facts_immutable_party   BEFORE UPDATE ON lr_trade_party  BEGIN SELECT RAISE(ABORT, 'facts are append-only'); END;
CREATE TRIGGER lr_facts_immutable_leg     BEFORE UPDATE ON lr_trade_leg    BEGIN SELECT RAISE(ABORT, 'facts are append-only'); END;
CREATE TRIGGER lr_facts_immutable_cap     BEFORE UPDATE ON lr_trade_cap    BEGIN SELECT RAISE(ABORT, 'facts are append-only'); END;
CREATE TRIGGER lr_facts_immutable_event   BEFORE UPDATE ON lr_asset_event  BEGIN SELECT RAISE(ABORT, 'facts are append-only'); END;
CREATE TRIGGER lr_facts_immutable_row     BEFORE UPDATE ON lr_draft_row    BEGIN SELECT RAISE(ABORT, 'facts are append-only'); END;
CREATE TRIGGER lr_facts_immutable_forfeit BEFORE UPDATE ON lr_forfeiture   BEGIN SELECT RAISE(ABORT, 'facts are append-only'); END;
CREATE TRIGGER lr_facts_immutable_corr    BEFORE UPDATE ON lr_correction   BEGIN SELECT RAISE(ABORT, 'corrections are append-only'); END;
CREATE TRIGGER lr_facts_immutable_check   BEFORE UPDATE ON lr_coverage_check BEGIN SELECT RAISE(ABORT, 'checks are append-only'); END;
CREATE TRIGGER lr_link_close_only BEFORE UPDATE ON lr_link
  WHEN NEW.link_id IS NOT OLD.link_id OR NEW.link_type IS NOT OLD.link_type OR NEW.from_asset_key IS NOT OLD.from_asset_key OR NEW.to_season IS NOT OLD.to_season OR NEW.to_round IS NOT OLD.to_round OR NEW.to_slot IS NOT OLD.to_slot
    OR NEW.class IS NOT OLD.class OR NEW.method_id IS NOT OLD.method_id OR NEW.method_version IS NOT OLD.method_version OR NEW.blockers_json IS NOT OLD.blockers_json OR NEW.evidence_json IS NOT OLD.evidence_json OR NEW.valid_from_run IS NOT OLD.valid_from_run
    OR (OLD.valid_to_run IS NOT NULL AND NEW.valid_to_run IS NOT OLD.valid_to_run)
  BEGIN SELECT RAISE(ABORT, 'a link can only be closed; a changed reading is a new link row'); END;
CREATE TRIGGER lr_slot_close_only BEFORE UPDATE ON lr_draft_slot
  WHEN NEW.season IS NOT OLD.season OR NEW.round IS NOT OLD.round OR NEW.slot IS NOT OLD.slot OR NEW.overall IS NOT OLD.overall OR NEW.status IS NOT OLD.status OR NEW.draft_row_id IS NOT OLD.draft_row_id OR NEW.valid_from_run IS NOT OLD.valid_from_run OR (OLD.valid_to_run IS NOT NULL AND NEW.valid_to_run IS NOT OLD.valid_to_run)
  BEGIN SELECT RAISE(ABORT, 'a slot row can only be closed; a changed status is a new row'); END;
CREATE TRIGGER lr_coverage_close_only BEFORE UPDATE ON lr_coverage
  WHEN NEW.coverage_id IS NOT OLD.coverage_id OR NEW.source_id IS NOT OLD.source_id OR NEW.event_class IS NOT OLD.event_class OR NEW.from_date IS NOT OLD.from_date OR NEW.to_date IS NOT OLD.to_date OR NEW.state IS NOT OLD.state OR NEW.basis IS NOT OLD.basis OR NEW.valid_from_run IS NOT OLD.valid_from_run OR (OLD.valid_to_run IS NOT NULL AND NEW.valid_to_run IS NOT OLD.valid_to_run)
  BEGIN SELECT RAISE(ABORT, 'a coverage row can only be closed; a changed state is a new row'); END;
CREATE TRIGGER lr_possession_close_only BEFORE UPDATE ON lr_possession
  WHEN NEW.possession_id IS NOT OLD.possession_id OR NEW.asset_key IS NOT OLD.asset_key OR NEW.franchise_id IS NOT OLD.franchise_id OR NEW.from_ts IS NOT OLD.from_ts OR NEW.to_ts IS NOT OLD.to_ts OR NEW.from_basis IS NOT OLD.from_basis
    OR NEW.evidence_class IS NOT OLD.evidence_class OR NEW.weakest_coverage IS NOT OLD.weakest_coverage OR NEW.valid_from_run IS NOT OLD.valid_from_run OR (OLD.valid_to_run IS NOT NULL AND NEW.valid_to_run IS NOT OLD.valid_to_run)
  BEGIN SELECT RAISE(ABORT, 'a possession row can only be closed'); END;

-- deletes: a row of a released run is never deleted (a never-released, failed load may be dropped); otherwise a check could be deleted to pass the release gate
CREATE TRIGGER lr_nodelete_trade BEFORE DELETE ON lr_trade WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.loaded_run) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_asset BEFORE DELETE ON lr_asset WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.loaded_run) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_asset_event BEFORE DELETE ON lr_asset_event WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.loaded_run) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_draft_row BEFORE DELETE ON lr_draft_row WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.loaded_run) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_forfeiture BEFORE DELETE ON lr_forfeiture WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.loaded_run) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_source BEFORE DELETE ON lr_source WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.loaded_run) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_correction BEFORE DELETE ON lr_correction WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.run_id) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_coverage BEFORE DELETE ON lr_coverage WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.valid_from_run) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_possession BEFORE DELETE ON lr_possession WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.valid_from_run) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_link BEFORE DELETE ON lr_link WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.valid_from_run) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_draft_slot BEFORE DELETE ON lr_draft_slot WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.valid_from_run) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_evidence_need BEFORE DELETE ON lr_evidence_need WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.valid_from_run) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_conflict BEFORE DELETE ON lr_conflict WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.run_id) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_run BEFORE DELETE ON lr_run WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= OLD.run_id) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_trade_party BEFORE DELETE ON lr_trade_party WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= (SELECT loaded_run FROM lr_trade t WHERE t.trade_id = OLD.trade_id)) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_trade_leg BEFORE DELETE ON lr_trade_leg WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= (SELECT loaded_run FROM lr_trade t WHERE t.trade_id = OLD.trade_id)) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_trade_cap BEFORE DELETE ON lr_trade_cap WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= (SELECT loaded_run FROM lr_trade t WHERE t.trade_id = OLD.trade_id)) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_link_candidate BEFORE DELETE ON lr_link_candidate WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= (SELECT valid_from_run FROM lr_link l WHERE l.link_id = OLD.link_id)) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
CREATE TRIGGER lr_nodelete_coverage_check BEFORE DELETE ON lr_coverage_check WHEN EXISTS (SELECT 1 FROM lr_release r WHERE r.run_id >= (SELECT valid_from_run FROM lr_coverage c WHERE c.coverage_id = OLD.coverage_id)) BEGIN SELECT RAISE(ABORT, 'rows of a released run are never deleted'); END;
```

**Possession and coverage (the open Opus question, resolved in the design pending the commissioner's ruling on LR-12):** a **link** (an end-state claim confirmed by an authoritative observation such as a draft result) is not gated on interval coverage, but a **possession period** (a continuity claim) is INFERRED over unverified days, and the schema allows CONFIRMED or CALCULATED only when its weakest coverage is `VERIFIED_COMPLETE` (a `CHECK`). Facts are append-only (updates are refused), derived rows can only be closed, rows of a released run are never deleted, a conflict is resolved by a new row that cites its source or ruling, and every release gate reads the exclusion rule (`lr_run_excluded`) and the validity window of the rows it checks. See `S1_READINESS_ASSESSMENT.md` section 2.

**Rules the constraints encode:** a `SELECTED` slot has a draft row, a `FORFEITED`, `UNRESOLVED` or `MISSING_SOURCE_RECORD` slot never has one (so a forfeiture cannot carry a fabricated player); an `UNRESOLVED` link has no slot; a future pick can never be `CONFIRMED` to a slot; every link names an approved or diagnostic method and its version. A selected draft row with no franchise id stays `SELECTED` (`franchise_id` is nullable): the selector is simply not recorded. The 2014 4.12 disagreement is an `lr_conflict` row beside a `SELECTED` slot, not a slot status.

## 4. Source mappings

| Target | Source today | Mapping | Notes |
|---|---|---|---|
| `lr_source` | archive database (dated 2026-06-05), committed 2026 snapshots, the commissioner clarification, later MFL exports | one row each; exports carry the redacted request, capture time and SHA-256 | **only the hash** of a raw payload is kept; no raw response, MFL comment or pending offer is stored in D1 or R2 |
| `lr_trade`, `lr_trade_party`, `lr_trade_leg`, `lr_trade_cap` | `transactions_trades` (8,744 rows; 1,036 trades) and 2026 snapshot trades | group by `trade_group_id`; pair the RELINQUISH and ACQUIRE rows into legs; the cap amount sits on the sender's row and pairs with the other franchise's CAP row; `date_quality = processing_time_likely` before 2024 | the production D1 mirror drops pick identity, so it is not a source |
| `lr_asset` | trade legs, draft rows | one row per distinct asset key | `DP_` tokens are zero-indexed (`DP_3_11` = 4.12). The `draftcompensation_*` columns of the archive's slot-pick rows equal the sending franchise in every row the architecture review checked; they are **never** read as an original-franchise claim. |
| `lr_asset_event` | `transactions_adddrop`, `transactions_auction` (traded players only), draft selections | add, drop, selection events | other players' events are not loaded |
| `lr_draft_row` | `draftresults_mfl` (575 rows, 2018 on) and `draftresults_legacy` (360 rows, 2012-2017) | one row per source row with the stored slot and the raw pick text | |
| `lr_draft_slot` | scheduled grid: teams x rounds per season with draft results | status from the rows and `lr_forfeiture` (936 slots: 935 SELECTED + 1 FORFEITED today) | |
| `lr_correction` | the 30 legacy rows (decision 1) | stored slot 1, corrected slot 10, method `legacy_tenth_pick_stored_as_slot_1`, source reference (table, season, round, overall, raw pick text) | applies only to the documented pattern |
| `lr_forfeiture` | `docs/league_record/known_forfeitures.json` | 1 row: 2018 4.12, "owner violation", "commissioner clarification"; `not_recorded_json` lists what is not recorded | |
| `lr_coverage`, `lr_coverage_check` | extraction coverage intervals; `docs/league_record/coverage_verifications.json` | 38 UNVERIFIED windows + 1 KNOWN_GAP today; verified records only through validated verification files | |
| `lr_possession`, `lr_link`, `lr_link_candidate`, `lr_conflict`, `lr_summary` | derived by the committed extraction code | the same functions that produce `extraction.json` | loaded, never computed in a request path |

## 5. Estimated volume and the write budget

Row counts below were **computed offline from the committed ledger** (exact for the archive years 2010-2025; no database was touched). They match the earlier estimates; the cost of writing them to a real D1 is **still unmeasured** and must be measured on a local replica and a temporary D1 database before any go (`S1_READINESS_ASSESSMENT.md`, section 3):

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

**Rows written on a first load, counting index entries:** about 31,000 rows times about 2.3 entries per row (tables without a rowid alias count the primary-key index; the eight secondary indexes above add one each) is roughly **72,000 rows written** (range 50,000 to 100,000; the three partial unique indexes add about 2,000). That is under the Free limit of 100,000 per UTC day **only if nothing else writes that day** (the counter is account-wide and shared with the stats refresh). Plan: **three** chunks of at most 25,000 written rows, one chunk per run and at most two chunks per UTC day (so two days, never more than about 50,000 written on one day), measuring with `wrangler d1 info` and `scripts/d1_usage.py` after each chunk; the loader writes only changed rows (the `D1Writer` pattern), so a repeated load writes 0.

**Known data discrepancy (corrected in the extraction, documented in `S1_CAP_TOKEN_CORRECTION.md`):** two 2025 trades, `trade2025_35` and `trade2025_60`, carry decimal cap tokens (`BB_3000.00`, `BB_5000.00`) whose archive amount is blank. The extraction now reads the amount from the sender's raw token (tagged `raw_token`, 8,000 in total) and the 2025 aggregate is 282,000. The design's `CHECK (amount > 0)` still refuses to store a missing amount as 0, and the loader must carry `amount_source` (a new column on `lr_trade_cap`, to be added in the final schema review) so a reader can see where each amount came from. What "from sends cap room to" means for a `BB_` token is not tied to the league canon here and is unverified.

**Steady state:** a rebuild after one new trade or one new verification writes tens of rows. Finished seasons are never rewritten. A new release is a `lr_run` row, a `lr_release` row and the changed derived rows. (A rebuild in which every derived row changed would add about 12,000 rows; that is the bound used for retention in section 10.)

## 5a. Package consideration versus attributable trade value

A trade is one package (`lr_trade`): its **consideration** is what each party gave and received in full (`lr_trade_leg` plus `lr_trade_cap` with direction). That is a recorded fact. **Attributable value** (how much of what happened afterward is due to one asset of the package) is a different, derived, method-dependent claim, and **no column of any fact table holds it**. A leg never carries a value, a score or a "credit". If a later slice computes attributable value, it writes rows to its own table keyed by `(trade_id, party, method_id, method_version)` with the allocation method named and approved, evidence class `INFERRED` or `UNRESOLVED` unless the trade has one asset on each side, and no double counting (the existing `packages.mjs` rule "nothing is credited to a single asset of a multi-asset package" is the default). Production earned by a player while rostered is stored per possession period (the dependent scoring slice), never per trade.

## 5b. Updating history when a previously missing record is recovered

1. The new source is recorded (`lr_source`, hash, request, capture time) and the evidence need it answers is named (`lr_evidence_need`, register item).
2. The recovered record is **appended** as a fact in a new run (`loaded_run`); no existing row is edited.
3. Derived rows (possession, links) are rebuilt for the affected assets only: unchanged rows are not rewritten, superseded rows are **closed** (`valid_to_run`) and replaced by new rows.
4. A **difference report** (what changed in each affected pick, slot and period, with the old and the new class) is produced and reviewed; a class may change only through an approved method.
5. The release moves to the new run only after the review; earlier runs stay readable "as of" so any answer given earlier can be reproduced, and the correction provenance (`lr_correction`, the source, the approving reference) explains the change.
6. The register item is updated in the same step (status, evidence). A recovered record never closes an item by itself.

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

**Recommendation:** **A, built in slices, keeping only hashes of raw payloads (no raw response is stored).** Build only slice 1 (sources, coverage, trades, draft, links, conflicts) first; contracts and scoring attach later through `possession_id`. If the first owner-facing need is only a few pages, **C** reaches it with almost no D1 cost and can be replaced by A without changing the evidence model, because both use the same classes and methods. B is not recommended: it stores an uncertain relationship as a definitive document.

## 8. Migration and rollback plan (a plan; nothing is applied)

1. **Additive only.** One new numbered migration (the next free number after `0181` in `worker/migrations/`) creates the `lr_` tables. No existing table is altered, no existing index changed.
2. **Rehearse before production:** (a) a local SQLite/miniflare replica (`reference_d1_local_replica_rows_read`); (b) a **temporary D1 database** (created for the test, deleted after) to measure rows written and read exactly, as was done for the writer change on 2026-10-13. Production only with the commissioner's explicit go for that action.
3. **Apply with the tool, not by hand:** `wrangler d1 migrations apply`, because hand-applied migrations drift the tracker.
4. **Ship dark:** any Worker route reads behind a default-off flag; nothing user-visible changes until it is switched on.
5. **Load in chunks** by run id (section 5); a run that never gets a `lr_release` row is invisible to readers.
6. **Rollback, data:** (a) *Reading an earlier release*: retire the active `lr_release` row and activate the earlier run: one write, no row deleted. (b) *Continuing after a rollback*: runs are linear, so before a new run is built the abandoned runs are recorded in `lr_run_excluded` by a `rollback` run, which also closes their open derived rows (bounded updates, counted as writes). Without that step the abandoned run's rows would stay visible to the next run. A load that failed before any release is simply never released and is dropped (item 8).
7. **Rollback, schema:** a reverse-order `DROP TABLE` script, run only after the flag is off and no route reads the tables; the tables hold no data that exists nowhere else, because they are rebuilt from the committed extraction and the sanitized extracts.
8. **Cleaning up a failed load:** drop the staging run's rows by run id in small batches (deletes count as writes), or, on the temporary database, drop the database.

## 9. Testing requirements (all offline by default; production access is an explicit opt-in that prints SKIPPED otherwise)

- **Schema tests:** every `CHECK` refuses its bad case (a forfeited slot with a player, an unresolved link with a slot, a future pick CONFIRMED to a slot, an unknown class or status, a leg with an unknown asset).
- **Oracle test:** load the staging database from the committed extraction and compare every count and sampled record with `extraction.json` and the pilot bundle; a second code path recomputes the counts with SQL on the archive.
- **Invariants:** 936 scheduled slots = 935 SELECTED + 1 FORFEITED + 0 UNRESOLVED + 0 MISSING; 30 corrections each with original, corrected value, method, approval and source reference; every trade leg has a from-franchise; cap direction preserved for all 130 transfers; possession periods of one asset never overlap; 597 future-pick links all UNRESOLVED until a method is approved; the 2014 4.12 conflict is a conflict row beside a SELECTED slot.
- **Reproducibility:** rebuilding from the same source set and code sha yields identical derived rows; an old run read "as of run R" equals the release that was active then.
- **Query plans:** `EXPLAIN QUERY PLAN` for every query in section 6 shows `SEARCH ... USING INDEX`, never a `SCAN` on a hot path; measured `rows_read` stays under the stated bound.
- **Write budget:** a dry load on the temporary database reports rows written including index entries, stays under the chunk limit, and a repeated load writes 0.
- **Rollback rehearsal:** flip the release pointer back and forth on the temporary database and confirm reads change and no row is deleted; build run 3, release run 4, roll back to 3, build run 5 and confirm run 5 sees nothing of run 4; run the schema rollback script and confirm no existing table is affected.
- **As-of reproducibility:** add a trade in run 4 and confirm a read as of run 3 does not see it.
- **Privacy test:** no column holds an owner name, e-mail, MFL free-text comment or credential; sampled rows are scanned.
- **Standing rules:** no slot or order derived from standings, finishes or a projected order appears in any loader (the existing source scan covers the loader modules).

## 10. Open design decisions (for the commissioner and the architecture review)

1. **Which slice is first:** the recommendation is slice 1 only (sources, coverage, trades, draft, links, conflicts).
2. **A or C for the first owner-facing pages** (section 7).
3. **Raw MFL payloads:** only their hashes and the sanitized extracts are kept (decided in this revision, because a raw payload holds free-text comments and pending offers); revisit only if a later need is shown.
4. **Free-plan load schedule:** three chunks of at most 25,000 written rows, at most two per UTC day (so two days), or a one-off paid-plan window, if the account is still on Workers Paid when the load happens.
5. **Retention of superseded derived rows:** keep all runs (a rebuild that changed every derived row adds about 12,000 rows; one new trade adds tens) or prune runs older than a stated horizon.
