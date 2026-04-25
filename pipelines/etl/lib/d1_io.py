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
import shutil
import subprocess
import sys
import time
from pathlib import Path

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
) -> str:
    """Build an INSERT (or UPSERT) statement for a batch of rows.

    With `pk_cols`: emits `INSERT … ON CONFLICT (pk) DO UPDATE SET …`
    Without:       emits `INSERT OR IGNORE`.
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
            set_clause = ", ".join(f"{c} = excluded.{c}" for c in update_cols)
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
    without aborting a 30+ minute load run.
    """
    cmd = [
        "npx", "--yes", "wrangler@latest", "d1", "execute", db,
        "--remote", "--file", str(sql_path),
    ]
    if wrangler_config is not None:
        cmd.extend(["--config", str(wrangler_config)])

    cwd = str(worker_cwd) if worker_cwd else None

    for attempt in range(1, max_attempts + 1):
        res = subprocess.run(
            cmd, cwd=cwd, env={**os.environ},
            capture_output=True, text=True,
        )
        if res.returncode == 0:
            if attempt > 1:
                sys.stderr.write(
                    f"[d1 execute] recovered on attempt {attempt} for {sql_path.name}\n"
                )
            return
        if attempt < max_attempts:
            sys.stderr.write(
                f"[d1 execute] transient fail on {sql_path.name} "
                f"(attempt {attempt}/{max_attempts}), retrying...\n"
            )
            time.sleep(2 * attempt)
            continue
        sys.stderr.write(
            f"[d1 execute FAILED after {max_attempts} attempts] {sql_path.name}\n"
            f"STDERR:\n{res.stderr[:2000]}\nSTDOUT:\n{res.stdout[:500]}\n"
        )
        raise SystemExit(res.returncode)


# ---------------------------------------------------------------
# Streaming writer — buffers rows, flushes chunks
# ---------------------------------------------------------------

class D1Writer:
    """Streaming UPSERT writer. Add rows; chunks flush automatically.

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
    """

    # Wide-table UPSERTs roughly double in size due to ON CONFLICT
    # SET clause; D1 caps a single statement at ~100KB. 80 rows is
    # safe for ~80-col tables; insert mode tolerates ~200.
    DEFAULT_CHUNK_SIZE = 80

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
    ):
        self.table = table
        self.cols = cols
        self.pk_cols = pk_cols
        self.db = db
        self.chunk_size = chunk_size or self.DEFAULT_CHUNK_SIZE
        self.tmp_dir = Path(tmp_dir) if tmp_dir else self._default_tmp_dir()
        self.wrangler_config = wrangler_config
        self.worker_cwd = worker_cwd or self._default_worker_cwd()
        self.enabled = enabled
        self.verbose = verbose

        self._buffer: list[tuple] = []
        self._chunk_idx = 0
        self._total = 0

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
        # idempotency).
        try:
            self._flush()
        except Exception as e:
            sys.stderr.write(f"[D1Writer {self.table}] flush failed on exit: {e}\n")
        if self.enabled and self.verbose:
            sys.stderr.write(
                f"[D1Writer {self.table}] DONE: {self._total} rows in "
                f"{self._chunk_idx} chunk{'s' if self._chunk_idx != 1 else ''}\n"
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

    def _flush(self) -> None:
        if not self._buffer or not self.enabled:
            self._buffer = []
            return
        self._chunk_idx += 1
        sql = build_insert(self.table, self.cols, self._buffer, pk_cols=self.pk_cols)
        path = self.tmp_dir / f"{self.table}__{self._chunk_idx:04d}.sql"
        path.write_text(sql)
        wrangler_execute(
            path, db=self.db,
            wrangler_config=self.wrangler_config,
            worker_cwd=self.worker_cwd,
        )
        self._total += len(self._buffer)
        if self.verbose:
            sys.stderr.write(
                f"[D1Writer {self.table}] chunk {self._chunk_idx}: "
                f"+{len(self._buffer)} (total {self._total})\n"
            )
        self._buffer = []
