"""Shared D1 I/O helpers — INSERT/UPSERT chunking + wrangler execution.

Used by both:
  - scripts/load_local_to_d1.py  (legacy: SQLite → D1 mirror)
  - fetchers in pipelines/etl/scripts/  (dual-write: nflverse → D1 directly)

The dual-write transition (Keith 2026-04-25) keeps the local SQLite
path working unchanged. Fetchers ALSO push their data through a
D1Writer so D1 stays current even if `load_local_to_d1.py` never
runs. Once the direct path is verified, the local writes can be
removed fetcher-by-fetcher.

Public API:
  sql_escape(v)            scalar → SQL literal
  build_insert(...)        build INSERT or UPSERT SQL string
  wrangler_execute(...)    run a SQL file via `wrangler d1 execute`
  D1Writer                 streaming chunker; .add(row) → .close()
"""
from __future__ import annotations

import os
import shlex
import shutil
import subprocess
import sys
import time
from pathlib import Path

# D1 rejects any single statement over 100,000 bytes (SQLITE_TOOBIG). Leave
# headroom and measure UTF-8 bytes, not characters: player names aren't ASCII.
STATEMENT_BYTE_LIMIT = 95_000

# Deterministic failures: retrying resends the same bytes and fails the same
# way, so give up immediately instead of burning ~55s of backoff.
_NON_RETRYABLE = (
    "SQLITE_TOOBIG", "statement too long", "constraint failed", "no such table",
    "no such column", "has no column named", "syntax error",
)
# The database was reset mid-import. The import rolls back, so the same
# statements are safe to resend in smaller files.
_CPU_RESET = ("exceeded its CPU time limit", "D1_RESET_DO", "reset before execute completed")

# ---------------------------------------------------------------
# SQL building
# ---------------------------------------------------------------

def sql_escape(v) -> str:
    """Convert a Python scalar to a SQL literal."""
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        # NaN guard — float('nan') != float('nan')
        if isinstance(v, float) and v != v:
            return "NULL"
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def build_insert(
    table: str,
    cols: list[str],
    rows: list[tuple],
    pk_cols: list[str] | None = None,
    coalesce_cols: list[str] | None = None,
) -> str:
    """Build an INSERT (or UPSERT) statement for a batch of rows.

    With `pk_cols`: emits `INSERT … ON CONFLICT (pk) DO UPDATE SET …`
    Without:       emits `INSERT OR IGNORE`.
    `coalesce_cols` update as `c = COALESCE(excluded.c, c)`, so a NULL in
    this batch keeps the existing value instead of erasing it.
    """
    col_list = ", ".join(cols)
    value_tuples = []
    for row in rows:
        vals = ", ".join(sql_escape(v) for v in row)
        value_tuples.append(f"({vals})")
    values_sql = ",\n".join(value_tuples)

    if pk_cols:
        update_cols = [c for c in cols if c not in pk_cols]
        if update_cols:
            keep = set(coalesce_cols or ())
            unknown = keep - set(update_cols)
            if unknown:
                raise ValueError(f"build_insert {table}: coalesce_cols not in update columns: {sorted(unknown)}")
            set_clause = ", ".join(
                f"{c} = COALESCE(excluded.{c}, {c})" if c in keep else f"{c} = excluded.{c}"
                for c in update_cols
            )
            pk_list = ", ".join(pk_cols)
            return (
                f"INSERT INTO {table} ({col_list}) VALUES\n{values_sql}\n"
                f"ON CONFLICT ({pk_list}) DO UPDATE SET {set_clause};\n"
            )
        return f"INSERT OR IGNORE INTO {table} ({col_list}) VALUES\n{values_sql};\n"

    return f"INSERT OR IGNORE INTO {table} ({col_list}) VALUES\n{values_sql};\n"


# ---------------------------------------------------------------
# Wrangler shell-out with retry
# ---------------------------------------------------------------

def _wrangler_cmd(sql_path: Path, db: str, wrangler_config: Path | None) -> list[str]:
    # D1_WRANGLER lets CI call one pinned, pre-installed wrangler (~1s/call)
    # instead of `npx --yes wrangler@latest` (npm version check every call,
    # and a surprise upgrade mid-run). Local runs keep the old default.
    # D1_EXECUTE_LOCAL=1 targets the local Miniflare D1 for tests.
    prefix = shlex.split(os.environ.get("D1_WRANGLER") or "npx --yes wrangler@latest")
    target = "--local" if os.environ.get("D1_EXECUTE_LOCAL") == "1" else "--remote"
    cmd = prefix + ["d1", "execute", db, target, "--file", str(sql_path)]
    if wrangler_config is not None:
        cmd.extend(["--config", str(wrangler_config)])
    return cmd


def _execute_with_retries(
    sql_path: Path,
    db: str,
    max_attempts: int,
    wrangler_config: Path | None,
    worker_cwd: Path | None,
) -> tuple[bool, str]:
    """(ok, error_text). Retries transient failures only."""
    cmd = _wrangler_cmd(sql_path, db, wrangler_config)
    cwd = str(worker_cwd) if worker_cwd else None
    env = {**os.environ, "WRANGLER_SEND_METRICS": "false"}
    err = ""
    for attempt in range(1, max_attempts + 1):
        res = subprocess.run(cmd, cwd=cwd, env=env, capture_output=True, text=True)
        if res.returncode == 0:
            if attempt > 1:
                sys.stderr.write(f"[d1 execute] recovered on attempt {attempt} for {sql_path.name}\n")
            return True, ""
        err = f"STDERR:\n{res.stderr[-2000:]}\nSTDOUT:\n{res.stdout[-1000:]}"
        blob = res.stderr + res.stdout
        if any(s in blob for s in _NON_RETRYABLE) or any(s in blob for s in _CPU_RESET):
            break
        if attempt < max_attempts:
            sys.stderr.write(
                f"[d1 execute] transient fail on {sql_path.name} "
                f"(attempt {attempt}/{max_attempts}), retrying...\n"
            )
            time.sleep(2 * attempt)
    return False, err


def wrangler_execute(
    sql_path: Path,
    db: str = "ups-mfl-db",
    max_attempts: int = 4,
    wrangler_config: Path | None = None,
    worker_cwd: Path | None = None,
) -> None:
    """Run `wrangler d1 execute --remote --file=<sql_path>` with retry.

    D1 returns transient 5xx / network errors under load — typically
    clears within seconds. Retries with linear backoff absorb those
    without aborting a 30+ minute load run. Deterministic errors
    (statement too long, missing column, …) fail on the first attempt.
    Raises SystemExit on failure.
    """
    ok, err = _execute_with_retries(sql_path, db, max_attempts, wrangler_config, worker_cwd)
    if not ok:
        sys.stderr.write(f"[d1 execute FAILED] {sql_path.name}\n{err}\n")
        raise SystemExit(1)


# ---------------------------------------------------------------
# Streaming writer — buffers rows, flushes chunks
# ---------------------------------------------------------------

class D1Writer:
    """Streaming UPSERT writer. Add rows; statements flush automatically.

    Example:
        with D1Writer(
            table="nfl_player_advstats_season",
            cols=["season", "gsis_id", "rec_adot", ...],
            pk_cols=["season", "gsis_id"],
        ) as w:
            for row_tuple in iter_rows():
                w.add(row_tuple)
        # exits flush remaining + prints summary

    Set `enabled=False` to no-op (useful for fetchers with --skip-d1).

    `chunk_size` rows go into each INSERT statement. Statements are then
    packed into SQL files of up to `max_file_bytes` / `max_rows_per_file`,
    one `wrangler d1 execute` per file. Each wrangler call costs ~2.8s
    regardless of size, so one statement per call spent ~39 of 41 minutes
    of the Sep 9 2026 nflverse refresh starting processes. An import file
    rolls back as a unit if it fails, and every statement is an idempotent
    upsert, so resending a file is safe. D1WRITER_MAX_FILE_BYTES=0 restores
    one statement per file.
    """

    # Wide-table UPSERTs roughly double in size due to ON CONFLICT
    # SET clause; D1 caps a single statement at ~100KB. 80 rows is
    # safe for ~80-col tables; insert mode tolerates ~200. Oversized
    # statements are split automatically (see STATEMENT_BYTE_LIMIT).
    DEFAULT_CHUNK_SIZE = 80
    DEFAULT_MAX_FILE_BYTES = 1_000_000
    DEFAULT_MAX_ROWS_PER_FILE = 5_000

    def __init__(
        self,
        table: str,
        cols: list[str],
        pk_cols: list[str] | None = None,
        db: str = "ups-mfl-db",
        chunk_size: int | None = None,
        tmp_dir: Path | None = None,
        wrangler_config: Path | None = None,
        worker_cwd: Path | None = None,
        enabled: bool = True,
        verbose: bool = True,
        *,
        max_file_bytes: int | None = None,
        max_rows_per_file: int | None = None,
        coalesce_cols: list[str] | None = None,
    ):
        self.table = table
        self.cols = cols
        self.pk_cols = pk_cols
        self.coalesce_cols = coalesce_cols
        self.db = db
        self.chunk_size = chunk_size or self.DEFAULT_CHUNK_SIZE
        self.tmp_dir = Path(tmp_dir) if tmp_dir else self._default_tmp_dir()
        self.wrangler_config = wrangler_config
        self.worker_cwd = worker_cwd or self._default_worker_cwd()
        self.enabled = enabled
        self.verbose = verbose

        env_bytes = os.environ.get("D1WRITER_MAX_FILE_BYTES")
        if max_file_bytes is None:
            max_file_bytes = int(env_bytes) if env_bytes not in (None, "") else self.DEFAULT_MAX_FILE_BYTES
        self.max_file_bytes = max_file_bytes  # 0 = one statement per file
        self.max_rows_per_file = max_rows_per_file or self.DEFAULT_MAX_ROWS_PER_FILE

        self._buffer: list[tuple] = []
        self._stmts: list[tuple[str, int, int]] = []  # (sql, rows, utf-8 bytes)
        self._file_bytes = 0
        self._file_rows = 0
        self._chunk_idx = 0   # statements built
        self._file_idx = 0    # wrangler calls made
        self._total = 0       # rows confirmed written

    @staticmethod
    def _repo_root() -> Path:
        # pipelines/etl/lib/d1_io.py → repo root is parents[3]
        return Path(__file__).resolve().parents[3]

    def _default_tmp_dir(self) -> Path:
        return self._repo_root() / "worker" / ".tmp" / "d1_load"

    def _default_worker_cwd(self) -> Path:
        return self._repo_root() / "worker"

    def __enter__(self):
        if self.enabled:
            self.tmp_dir.mkdir(parents=True, exist_ok=True)
        return self

    def __exit__(self, exc_type, exc, tb):
        # Always flush remaining (best-effort — even on exceptions, the
        # partial data is more useful than nothing thanks to UPSERT
        # idempotency). On a clean exit a flush failure must propagate:
        # swallowing it would let the fetcher exit 0 with rows missing.
        try:
            self.close()
        except Exception as e:
            if exc_type is None:
                raise
            sys.stderr.write(f"[D1Writer {self.table}] flush failed on exit: {e}\n")

    def close(self) -> None:
        self._flush()
        self._flush_file()
        if self.enabled and self.verbose:
            sys.stderr.write(
                f"[D1Writer {self.table}] DONE: {self._total} rows in "
                f"{self._chunk_idx} statement{'s' if self._chunk_idx != 1 else ''}, "
                f"{self._file_idx} file{'s' if self._file_idx != 1 else ''}\n"
            )

    def add(self, row: tuple) -> None:
        if not self.enabled:
            return
        if len(row) != len(self.cols):
            raise ValueError(
                f"D1Writer {self.table}: row has {len(row)} values, "
                f"expected {len(self.cols)} ({self.cols})"
            )
        self._buffer.append(tuple(row))
        if len(self._buffer) >= self.chunk_size:
            self._flush()

    def add_many(self, rows) -> None:
        for r in rows:
            self.add(r)

    def _build_statements(self, rows: list[tuple]) -> list[tuple[str, int, int]]:
        sql = build_insert(self.table, self.cols, rows, pk_cols=self.pk_cols, coalesce_cols=self.coalesce_cols)
        size = len(sql.encode("utf-8"))
        if size < STATEMENT_BYTE_LIMIT:
            return [(sql, len(rows), size)]
        if len(rows) == 1:
            raise ValueError(
                f"D1Writer {self.table}: a single row builds a {size}-byte statement, "
                f"over D1's limit (~{STATEMENT_BYTE_LIMIT} bytes)"
            )
        mid = len(rows) // 2
        if self.verbose:
            sys.stderr.write(
                f"[D1Writer {self.table}] {len(rows)}-row statement is {size} bytes; splitting\n"
            )
        return self._build_statements(rows[:mid]) + self._build_statements(rows[mid:])

    def _flush(self) -> None:
        """Turn buffered rows into statement(s) and queue them for a file."""
        if not self._buffer or not self.enabled:
            self._buffer = []
            return
        rows, self._buffer = self._buffer, []
        for sql, n, size in self._build_statements(rows):
            self._chunk_idx += 1
            if self._stmts and (
                self.max_file_bytes <= 0
                or self._file_bytes + size > self.max_file_bytes
                or self._file_rows + n > self.max_rows_per_file
            ):
                self._flush_file()
            self._stmts.append((sql, n, size))
            self._file_bytes += size
            self._file_rows += n
            if self.max_file_bytes <= 0:
                self._flush_file()

    def _flush_file(self) -> None:
        if not self._stmts or not self.enabled:
            self._stmts, self._file_bytes, self._file_rows = [], 0, 0
            return
        stmts = self._stmts
        self._stmts, self._file_bytes, self._file_rows = [], 0, 0
        self._send(stmts)

    def _send(self, stmts: list[tuple[str, int, int]]) -> None:
        self._file_idx += 1
        path = self.tmp_dir / f"{self.table}__{self._file_idx:04d}.sql"
        path.write_text("".join(s for s, _, _ in stmts), encoding="utf-8")
        ok, err = _execute_with_retries(path, self.db, 4, self.wrangler_config, self.worker_cwd)
        rows = sum(n for _, n, _ in stmts)
        if not ok:
            if any(s in err for s in _CPU_RESET) and len(stmts) > 1:
                mid = len(stmts) // 2
                sys.stderr.write(
                    f"[D1Writer {self.table}] file {self._file_idx} ({len(stmts)} statements) "
                    f"hit D1's CPU limit and rolled back; resending as two smaller files\n"
                )
                self._send(stmts[:mid])
                self._send(stmts[mid:])
                return
            sys.stderr.write(f"[D1Writer {self.table}] file {self._file_idx} FAILED ({rows} rows)\n{err}\n")
            raise SystemExit(1)
        self._total += rows
        if self.verbose:
            size = sum(b for _, _, b in stmts)
            sys.stderr.write(
                f"[D1Writer {self.table}] file {self._file_idx}: {len(stmts)} statement"
                f"{'s' if len(stmts) != 1 else ''}, {size // 1024} KB, +{rows} (total {self._total})\n"
            )
