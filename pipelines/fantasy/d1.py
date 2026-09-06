"""D1 write path for the fantasy_* family.

Reuses the pure SQL builders from pipelines/etl/lib/d1_io.py (sql_escape,
build_insert) — those are well-tested and there is no reason to have two
implementations of SQL escaping in one repo. What is NOT reused is
`wrangler_execute`, for one specific reason: it hardcodes `--remote`, and this
pipeline must be runnable against a local D1 for testing without any chance of
touching production. Here the target is a required, explicit argument.

⚠️ WHY THE TARGET IS NEVER DEFAULTED. This database holds every live UPS
contract and cap ledger. A loader that defaults to remote is one forgotten flag
away from writing test rows into it. `--target local` is the default at the CLI
and `remote` must be typed out.

⚠️ NEVER `wrangler d1 migrations apply` ON THIS DATABASE. The migration tracker
is ~47 entries behind reality; applying would replay historical DML over live
contract data. Schema changes go through `d1 execute --file` on a single file.

CHUNKING. D1 caps a single SQL statement at ~100KB and escaping roughly doubles
a wide statement — a build in this repo already died with 'statement too long:
SQLITE_TOOBIG' and landed ZERO rows. Chunk sizes here are deliberately smaller
than they need to be; a slightly chattier load is free, a failed load is not.
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Iterable, Sequence

# The shared builders. Imported by path because pipelines/ is not a package —
# this is the established idiom in every ETL script here.
_REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(_REPO_ROOT / "pipelines" / "etl"))
from lib.d1_io import build_insert, sql_escape  # noqa: E402

DEFAULT_DB = "ups-mfl-db"

#: Wide-table upserts roughly double in size from the ON CONFLICT SET clause.
CHUNK_WIDE = 60
CHUNK_NARROW = 150

#: Composite primary keys, mirroring migrations 0132-0139 exactly. Getting one
#: wrong here means the upsert silently inserts duplicates instead of updating,
#: which is the failure mode idempotency tests exist to catch.
PRIMARY_KEYS: dict[str, list[str]] = {
    "fantasy_sync_runs": ["run_id"],
    "fantasy_data_completeness": ["platform", "league_key", "season", "resource"],
    "fantasy_league_seasons": ["platform", "league_key"],
    "fantasy_leagues": ["platform", "league_uid"],
    # ⚠️ NOT platform-keyed — ADP is external market data about NFL players,
    # true for every provider at once. Keyed by SOURCE so two sources can
    # disagree and both survive rather than one silently overwriting the other.
    "fantasy_adp": ["source", "season", "scoring", "teams", "player_key"],
    "fantasy_league_settings": ["platform", "league_key", "season"],
    "fantasy_scoring_rules": ["platform", "league_key", "season", "stat_id"],
    "fantasy_scoring_bonuses": ["platform", "league_key", "season", "bonus_id"],
    "fantasy_roster_positions": ["platform", "league_key", "season", "position"],
    "fantasy_divisions": ["platform", "league_key", "season", "division_id"],
    "fantasy_schedule_periods": ["platform", "league_key", "season", "week"],
    "fantasy_teams": ["platform", "team_key"],
    "fantasy_managers": ["platform", "manager_uid"],
    "fantasy_team_managers": ["platform", "team_key", "manager_uid"],
    "fantasy_team_season_state": ["platform", "team_key"],
    "fantasy_players": ["platform", "player_uid"],
    "fantasy_player_identifiers": ["platform", "player_uid", "id_type", "id_scope"],
    "fantasy_player_eligibility": ["platform", "player_uid", "season", "position"],
    "fantasy_player_status_snapshots": ["platform", "league_key", "season", "week", "player_uid"],
    "fantasy_drafts": ["platform", "league_key", "season"],
    "fantasy_draft_events": ["platform", "league_key", "season", "pick_number"],
    "fantasy_draft_player_metadata": ["platform", "player_uid", "captured_for_season"],
    "fantasy_transactions": ["platform", "transaction_key"],
    "fantasy_transaction_assets": ["platform", "transaction_key", "leg_index"],
    "fantasy_waiver_state_snapshots": ["platform", "league_key", "season", "team_key", "observed_at_utc"],
    "fantasy_roster_snapshots": ["platform", "league_key", "season", "week", "team_key", "player_uid"],
    "fantasy_player_week_stats": ["platform", "league_key", "season", "week", "player_uid", "stat_id"],
    "fantasy_player_week_points": ["platform", "league_key", "season", "week", "player_uid"],
    "fantasy_team_week_scores": ["platform", "league_key", "season", "week", "team_key"],
    "fantasy_matchups": ["platform", "league_key", "season", "week", "matchup_key"],
    "fantasy_standings_snapshots": ["platform", "league_key", "season", "as_of_week", "team_key"],
    "fantasy_player_crosswalk": ["platform", "player_uid"],
    # raw_yahoo_api_responses uses an AUTOINCREMENT id plus a UNIQUE natural
    # key, so its conflict target is the unique index, not the primary key.
    "raw_yahoo_api_responses": ["request_key", "response_hash"],
    "fantasy_api_errors": [],  # append-only ledger; no upsert
}

#: Columns that record a FIRST sighting and must never be overwritten by a later
#: run. Excluded from every ON CONFLICT SET clause. Without this, re-running a
#: backfill silently rewrites "when did we first see this player" to today.
FIRST_SIGHTING_COLS = {
    "created_at_utc", "first_seen_at_utc", "added_at_utc", "first_season",
    "first_season_seen", "obtained_at_utc",
}

#: Per-table columns that a LATER write must never change, on top of the
#: first-sighting set.
#:
#: ⚠️ WHY fantasy_sync_runs NEEDS THIS. A run writes twice: once at start (mode,
#: league_key, season, started_at_utc) and once at finish (status, counts,
#: finished_at_utc). Both are upserts on run_id. Two things bite here and they
#: pull in opposite directions:
#:   1. `mode` is NOT NULL, and SQLite evaluates the INSERT arm of an upsert
#:      before the conflict is detected — so the finish row MUST supply it or
#:      the whole statement fails with SQLITE_CONSTRAINT_NOTNULL.
#:   2. But if it supplies it and it lands in the SET clause, the finish write
#:      overwrites the real mode and the ledger forgets what the run was.
#: The resolution is to send the column and exclude it from SET. Found by an
#: end-to-end test, not by reading the code — the first attempt at a fix
#: (omitting the column) traded a silent corruption for a hard crash.
IMMUTABLE_COLS: dict[str, set[str]] = {
    "fantasy_sync_runs": {"mode", "league_key", "season", "week",
                          "requested_scope", "started_at_utc", "runner_host"},
}


def _protected_cols(table: str) -> set[str]:
    return FIRST_SIGHTING_COLS | IMMUTABLE_COLS.get(table, set())


class D1Error(RuntimeError):
    """A D1 write failed. Never swallowed — a failed write is not an empty one."""


def _serialize(value: Any) -> Any:
    """Coerce a Python value into something sql_escape can render.

    Lists and dicts become compact JSON with sorted keys, so the same logical
    value always produces the same literal and an unchanged re-run is a true
    no-op rather than a spurious update.
    """
    if value is None:
        return None
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (list, dict)):
        return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)
    return value


class D1Loader:
    """Batched, idempotent writes to D1 via the wrangler CLI.

    `target` is 'local' or 'remote' and is REQUIRED — see the module docstring.
    `dry_run` writes the SQL to disk and reports what it would have done,
    which is how every writer in this repo is expected to be testable.
    """

    def __init__(
        self,
        *,
        target: str,
        db: str = DEFAULT_DB,
        worker_cwd: Path | None = None,
        dry_run: bool = False,
        max_attempts: int = 4,
        sql_out_dir: Path | None = None,
        verbose: bool = True,
    ) -> None:
        if target not in {"local", "remote"}:
            raise ValueError(
                f"target must be 'local' or 'remote', got {target!r}. It is not "
                "defaulted on purpose: this database holds live UPS contract data."
            )
        self.target = target
        self.db = db
        self.worker_cwd = Path(worker_cwd) if worker_cwd else (_REPO_ROOT / "worker")
        self.dry_run = dry_run
        self.max_attempts = max_attempts
        self.sql_out_dir = Path(sql_out_dir) if sql_out_dir else (self.worker_cwd / ".tmp" / "fantasy_load")
        self.verbose = verbose
        self.stats = {"statements": 0, "rows": 0, "tables": {}}

    # ── public ──────────────────────────────────────────────────────────────

    def write_rows(self, table: str, rows: Sequence[dict]) -> int:
        """Upsert `rows` into `table`. Returns the row count written.

        Rows may have heterogeneous keys (different payloads populate different
        optional columns). They are grouped by their exact column set so every
        emitted statement has a consistent shape — mixing shapes in one INSERT
        is a syntax error, and padding every row to a union of all columns would
        overwrite real values with NULL.
        """
        rows = [r for r in rows if r]
        if not rows:
            return 0
        if table not in PRIMARY_KEYS:
            raise D1Error(
                f"unknown table {table!r}. Add it to PRIMARY_KEYS with its exact "
                "composite key from migrations 0132-0139, or the upsert will "
                "insert duplicates instead of updating."
            )
        pk = PRIMARY_KEYS[table]

        groups: dict[tuple, list[dict]] = {}
        for row in rows:
            clean = {k: v for k, v in row.items() if not k.startswith("_")}
            groups.setdefault(tuple(sorted(clean.keys())), []).append(clean)

        written = 0
        for cols_tuple, group in groups.items():
            cols = list(cols_tuple)
            missing = [c for c in pk if c not in cols]
            if missing:
                raise D1Error(
                    f"{table}: rows are missing primary-key column(s) {missing}. "
                    "Writing them would create rows that can never be updated."
                )
            written += self._write_group(table, cols, group, pk)

        self.stats["tables"][table] = self.stats["tables"].get(table, 0) + written
        self.stats["rows"] += written
        return written

    def query(self, sql: str) -> list[dict]:
        """Run a read-only statement and return its rows.

        Used for read-back verification. A clean wrangler exit means the
        statement ran, NOT that rows landed — so every writer in this pipeline
        reads back what it wrote before claiming success.
        """
        out = self._run(["--command", sql, "--json"])
        return _rows_from_wrangler(out)

    def table_count(self, table: str, where: str | None = None) -> int:
        sql = f"SELECT COUNT(*) AS n FROM {table}"
        if where:
            sql += f" WHERE {where}"
        rows = self.query(sql + ";")
        if not rows:
            # ⚠️ No rows from a COUNT(*) is UNREADABLE, not zero. A COUNT always
            # returns exactly one row; getting none means the response could not
            # be parsed, and reporting that as 0 would be a fail-open.
            raise D1Error(
                f"COUNT(*) on {table} returned no rows — the response was "
                "unreadable. This is NOT a count of zero."
            )
        return int(rows[0].get("n") or 0)

    # ── internals ───────────────────────────────────────────────────────────

    def _write_group(self, table: str, cols: list[str], rows: list[dict], pk: list[str]) -> int:
        chunk = CHUNK_WIDE if len(cols) > 20 else CHUNK_NARROW
        upsert_pk = [c for c in pk if c] or None
        total = 0
        for i in range(0, len(rows), chunk):
            batch = rows[i:i + chunk]
            tuples = [tuple(_serialize(r.get(c)) for c in cols) for r in batch]
            total += self._write_tuples(table, cols, tuples, upsert_pk, label_prefix=f"{table}_{i:05d}")
        return total

    def _write_tuples(
        self, table: str, cols: list[str], tuples: list[tuple], upsert_pk: list[str] | None,
        *, label_prefix: str,
    ) -> int:
        """Write `tuples` as one statement, splitting in half and recursing if
        the BUILT SQL — not just the row count — would exceed D1's cap.

        ⚠️ WHY THIS EXISTS ON TOP OF CHUNK_WIDE/CHUNK_NARROW. Those constants
        assume row byte-size is roughly proportional to column COUNT, which
        holds for every table until one carries a variable-size blob column
        (fantasy_transactions.raw_transaction_json, added 2026-08-12 for
        ESPN). A live ESPN backfill hit exactly this: 150 rows (CHUNK_NARROW,
        correct for 17 narrow columns) produced a 148KB statement because
        each row's raw JSON blob pushed the true size far past what the
        column count predicted. Splitting on the ACTUAL built statement size
        (via build_insert, the same builder that produces the real SQL) fixes
        this generically for any future wide-payload column, rather than
        hand-tuning CHUNK_NARROW down for one table and leaving the same
        class of bug latent for the next one.
        """
        if not tuples:
            return 0
        sql = build_insert(table, cols, tuples, pk_cols=upsert_pk)
        if upsert_pk:
            sql = _exclude_protected(sql, cols, upsert_pk, _protected_cols(table))
        if len(sql.encode("utf-8")) > 90_000 and len(tuples) > 1:
            mid = len(tuples) // 2
            return (self._write_tuples(table, cols, tuples[:mid], upsert_pk, label_prefix=f"{label_prefix}a")
                    + self._write_tuples(table, cols, tuples[mid:], upsert_pk, label_prefix=f"{label_prefix}b"))
        self._execute_sql(sql, label=label_prefix)
        return len(tuples)

    def _execute_sql(self, sql: str, *, label: str) -> None:
        self.sql_out_dir.mkdir(parents=True, exist_ok=True)
        path = self.sql_out_dir / f"{label}.sql"
        path.write_text(sql, encoding="utf-8")
        self.stats["statements"] += 1
        if self.dry_run:
            if self.verbose:
                print(f"  [dry-run] {label}: {len(sql)} bytes SQL → {path}")
            return
        if len(sql.encode("utf-8")) > 95_000:
            raise D1Error(
                f"{label}: generated statement is {len(sql)} bytes, past D1's "
                "~100KB single-statement cap. Lower the chunk size; a statement "
                "this large fails and lands ZERO rows."
            )
        self._run(["--file", str(path)])

    def _run(self, extra: list[str]) -> str:
        # `--remote` is composed rather than written literally so the isolation
        # checker can assert that no file under pipelines/fantasy/ hardcodes a
        # production target.
        target_flag = "--" + self.target
        cmd = ["npx", "--yes", "wrangler@4", "d1", "execute", self.db, target_flag, *extra]
        last = ""
        for attempt in range(1, self.max_attempts + 1):
            proc = subprocess.run(cmd, cwd=str(self.worker_cwd),
                                  capture_output=True, text=True)
            if proc.returncode == 0:
                return proc.stdout
            last = (proc.stderr or "") + (proc.stdout or "")
            # D1 returns transient 5xx under load; those clear in seconds.
            if attempt < self.max_attempts and _looks_transient(last):
                time.sleep(2 * attempt)
                continue
            break
        raise D1Error(
            f"wrangler d1 execute failed after {self.max_attempts} attempt(s): "
            f"{last[:1500]}"
        )


def _exclude_protected(
    sql: str, cols: list[str], pk: list[str], protected: set[str]
) -> str:
    """Drop protected columns from an ON CONFLICT SET clause.

    build_insert sets EVERY non-PK column, which would rewrite created_at_utc
    and first_season on every re-run — and, for fantasy_sync_runs, would let the
    finish write clobber what the run actually was. The column still appears in
    the INSERT arm (it may be NOT NULL); it just never reaches the UPDATE arm.

    Rebuilding the clause here is simpler and safer than forking build_insert,
    and it keeps the shared SQL builder shared with the rest of the repo.
    """
    marker = "ON CONFLICT ("
    idx = sql.find(marker)
    if idx == -1:
        return sql
    do_idx = sql.find(") DO UPDATE SET ", idx)
    if do_idx == -1:
        return sql
    keep = [c for c in cols if c not in pk and c not in protected]
    if not keep:
        # Nothing left worth updating; degrade to a no-op insert rather than
        # emitting an empty SET clause (which is a syntax error).
        head = sql[:idx].rstrip()
        if head.endswith(";"):
            head = head[:-1]
        return head.replace("INSERT INTO", "INSERT OR IGNORE INTO", 1) + ";\n"
    set_clause = ", ".join(f"{c} = excluded.{c}" for c in keep)
    return sql[:do_idx] + ") DO UPDATE SET " + set_clause + ";\n"


def _looks_transient(text: str) -> bool:
    lowered = text.lower()
    return any(t in lowered for t in (
        "internal error", "503", "502", "temporarily", "timeout", "econnreset",
        "network", "socket hang up",
    ))


def _rows_from_wrangler(stdout: str) -> list[dict]:
    """Extract the result rows from wrangler's --json output.

    ⚠️ wrangler prints a banner before the JSON and its ANSI escapes contain
    '[', so seeking the first '[' naively grabs an escape sequence. Every
    candidate offset is tried until one actually decodes — the same defence the
    existing ingest_projections.py uses.
    """
    for i, ch in enumerate(stdout):
        if ch not in "[{":
            continue
        try:
            parsed = json.loads(stdout[i:])
        except json.JSONDecodeError:
            continue
        if isinstance(parsed, list):
            for entry in parsed:
                if isinstance(entry, dict) and "results" in entry:
                    return entry["results"] or []
            return []
        if isinstance(parsed, dict):
            return parsed.get("results") or []
    # No JSON at all. Unreadable, not empty.
    raise D1Error(
        f"could not parse wrangler JSON output ({len(stdout)} bytes). This is "
        "an unreadable response, NOT an empty result set."
    )


def write_tagged_rows(loader: D1Loader, rows: Iterable[dict]) -> dict[str, int]:
    """Route rows tagged with `_table` to their destinations.

    Adapters return heterogeneous rows because one payload legitimately produces
    rows for several tables (settings also yields scoring rules, roster slots
    and divisions).
    """
    buckets: dict[str, list[dict]] = {}
    for row in rows:
        table = row.get("_table")
        if not table:
            raise D1Error(
                "row has no _table tag; the adapter must say where each row goes"
            )
        buckets.setdefault(table, []).append(row)
    return {t: loader.write_rows(t, rs) for t, rs in buckets.items()}
