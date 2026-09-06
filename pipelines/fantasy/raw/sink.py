"""Raw payload preservation — the layer that makes a reparse local.

WHY THIS EXISTS. Yahoo rate-limits per client_id with an undocumented budget and
answers throttling with HTTP 999 blocks that last minutes to hours. A full
historical backfill is thousands of requests. If a parser bug is found after the
fact — and it will be, because Yahoo's JSON shape is a minefield — re-requesting
fifteen seasons is hours of wall-clock and a real risk of getting the app
blocked. Preserving the payload turns that into a local reparse.

⚠️ THE PAYLOAD IS STORED BEFORE IT IS PARSED. That ordering is the whole design.
A payload written only after a successful parse is precisely the payload you
cannot reparse when the parse turns out to be wrong.

WHY THE BODY IS USUALLY NOT IN D1. D1 caps a single SQL statement at ~100KB and
escaping roughly doubles a wide statement — a build in this repo already died
with 'statement too long: SQLITE_TOOBIG' and landed ZERO rows. One week of
all-team rosters with stats clears that easily, and a full backfill is on the
order of 180MB. So the body goes to a sink and D1 holds the index:

    file  — gzipped under a local archive dir. Default for backfill: fast, free,
            no credentials, survives a crash, and the whole tree can be re-read.
    r2    — the existing ups-mfl-backups bucket, via `wrangler r2 object put`.
            Default for recurring CI sync, where local disk is ephemeral.
    d1    — inline in raw_yahoo_api_responses.payload. Small responses ONLY;
            anything past the threshold is refused rather than silently dropped.
    none  — index row only. For runs where the body genuinely is not wanted.

The index row is written in EVERY mode, so provenance never depends on the body
still existing.
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from ..redact import redact_text
from ..version import PARSER_VERSION

#: Inline-in-D1 ceiling. Deliberately far below the ~100KB statement cap because
#: SQL escaping roughly doubles the size of a text literal, and the row carries
#: other columns too. A payload over this is never silently truncated — the sink
#: refuses and says so.
D1_INLINE_MAX_BYTES = 40_000

DEFAULT_ARCHIVE_DIR = Path("data/yahoo-raw")


def canonical_request_key(resource: str, params: dict | None) -> str:
    """A stable identifier for "this exact request".

    Params are sorted so that dict ordering cannot produce two keys for one
    request — the entire point is that a re-fetch of the same resource collides
    with its previous row and upserts instead of duplicating.
    """
    blob = json.dumps(
        {"resource": resource, "params": params or {}},
        sort_keys=True, separators=(",", ":"), default=str,
    )
    return hashlib.sha256(blob.encode("utf-8")).hexdigest()


def payload_hash(body: str) -> str:
    """sha256 of the raw body. Content-addressed, so an unchanged re-fetch is a no-op."""
    return hashlib.sha256(body.encode("utf-8")).hexdigest()


@dataclass
class RawRecord:
    """One row destined for raw_yahoo_api_responses."""

    platform: str
    request_key: str
    resource: str
    endpoint_path: str
    request_params: str
    league_key: str | None
    team_key: str | None
    player_key: str | None
    season: int | None
    week: int | None
    retrieved_at_utc: str
    http_status: int
    content_type: str | None
    payload: str | None
    payload_bytes: int
    payload_sink: str
    payload_ref: str | None
    response_hash: str
    parser_version: str
    unmapped_fields: str | None
    run_id: str | None

    def as_row(self) -> dict:
        return dict(self.__dict__)


class RawSink:
    """Collects raw payloads and the index rows that describe them.

    Rows accumulate in memory and are handed to the loader in batches; the sink
    itself never writes to D1, which keeps it testable with no database.
    """

    def __init__(
        self,
        mode: str = "file",
        *,
        platform: str = "yahoo",
        archive_dir: Path | str = DEFAULT_ARCHIVE_DIR,
        r2_bucket: str = "ups-mfl-backups",
        r2_prefix: str = "yahoo-raw",
        worker_cwd: Path | str | None = None,
        run_id: str | None = None,
    ) -> None:
        if mode not in {"file", "r2", "d1", "none"}:
            raise ValueError(
                f"unknown raw sink mode {mode!r}; expected file|r2|d1|none"
            )
        self.mode = mode
        self.platform = platform
        self.archive_dir = Path(archive_dir)
        self.r2_bucket = r2_bucket
        self.r2_prefix = r2_prefix.strip("/")
        self.worker_cwd = Path(worker_cwd) if worker_cwd else None
        self.run_id = run_id
        self.records: list[RawRecord] = []
        self._seen_hashes: set[str] = set()
        self.bytes_written = 0
        self.skipped_duplicates = 0

    # ── the callable the HTTP client invokes ────────────────────────────────

    def __call__(
        self,
        *,
        resource: str,
        endpoint_path: str,
        request_params: dict | None,
        body: str,
        http_status: int,
        content_type: str | None = None,
        league_key: str | None = None,
        team_key: str | None = None,
        player_key: str | None = None,
        season: int | None = None,
        week: int | None = None,
        run_id: str | None = None,
        unmapped_fields: list[str] | None = None,
    ) -> str | None:
        req_key = canonical_request_key(resource, request_params)
        body_hash = payload_hash(body)
        dedup = f"{req_key}:{body_hash}"

        # Content-addressed dedup within a run. The UNIQUE index in D1 enforces
        # the same thing across runs; this just avoids the round trip.
        if dedup in self._seen_hashes:
            self.skipped_duplicates += 1
            return None
        self._seen_hashes.add(dedup)

        raw_bytes = body.encode("utf-8")
        sink, ref, inline = self._store(
            resource=resource, body=body, raw_bytes=raw_bytes,
            body_hash=body_hash, season=season, week=week, league_key=league_key,
        )

        self.records.append(RawRecord(
            platform=self.platform,
            request_key=req_key,
            resource=resource,
            endpoint_path=endpoint_path,
            request_params=json.dumps(request_params or {}, sort_keys=True, default=str),
            league_key=league_key,
            team_key=team_key,
            player_key=player_key,
            season=season,
            week=week,
            retrieved_at_utc=datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            http_status=http_status,
            content_type=content_type,
            payload=inline,
            payload_bytes=len(raw_bytes),
            payload_sink=sink,
            payload_ref=ref,
            response_hash=body_hash,
            parser_version=PARSER_VERSION,
            unmapped_fields=json.dumps(sorted(unmapped_fields)) if unmapped_fields else None,
            run_id=run_id or self.run_id,
        ))
        self.bytes_written += len(raw_bytes)
        return ref

    # ── storage backends ────────────────────────────────────────────────────

    def _store(
        self, *, resource: str, body: str, raw_bytes: bytes, body_hash: str,
        season: int | None, week: int | None, league_key: str | None,
    ) -> tuple[str, str | None, str | None]:
        if self.mode == "none":
            return "none", None, None

        if self.mode == "d1":
            if len(raw_bytes) > D1_INLINE_MAX_BYTES:
                # ⚠️ REFUSE rather than truncate. A silently clipped payload is
                # worse than no payload: it looks reparseable and is not.
                raise ValueError(
                    f"{resource}: payload is {len(raw_bytes)} bytes, over the "
                    f"{D1_INLINE_MAX_BYTES}-byte inline limit. D1 caps a single "
                    "statement at ~100KB and escaping roughly doubles it. Use "
                    "--raw-sink=file or --raw-sink=r2 for this run."
                )
            return "d1", None, body

        rel = self._object_path(resource=resource, season=season, week=week,
                                league_key=league_key, body_hash=body_hash)

        if self.mode == "file":
            dest = self.archive_dir / rel
            dest.parent.mkdir(parents=True, exist_ok=True)
            # gzip: these are highly compressible JSON payloads and the archive
            # is otherwise ~180MB for a full backfill.
            with gzip.open(dest, "wt", encoding="utf-8") as fh:
                fh.write(body)
            return "file", str(dest), None

        # r2
        tmp = self.archive_dir / ".tmp" / rel
        tmp.parent.mkdir(parents=True, exist_ok=True)
        with gzip.open(tmp, "wt", encoding="utf-8") as fh:
            fh.write(body)
        key = f"{self.r2_prefix}/{rel}"
        self._r2_put(tmp, key)
        tmp.unlink(missing_ok=True)
        return "r2", key, None

    def _object_path(
        self, *, resource: str, season: int | None, week: int | None,
        league_key: str | None, body_hash: str,
    ) -> str:
        """Deterministic, human-navigable, collision-free.

        Layout mirrors the existing data/mfl-snapshots/ convention (dated,
        readable directories) but is keyed by league-season rather than by pull
        date, because that is how a reparse wants to read it: "give me every
        payload for 2019".
        """
        parts = [self.platform]
        parts.append(str(season) if season is not None else "noseason")
        if league_key:
            parts.append(league_key.replace("/", "_"))
        safe_resource = resource.replace("/", ".").replace(" ", "_")
        name = safe_resource
        if week is not None:
            name += f".wk{int(week):02d}"
        # Short hash suffix keeps paginated pages of one resource distinct.
        name += f".{body_hash[:12]}.json.gz"
        parts.append(name)
        return "/".join(parts)

    def _r2_put(self, local_path: Path, key: str) -> None:
        if shutil.which("npx") is None:
            raise RuntimeError(
                "--raw-sink=r2 needs `npx` on PATH to shell out to wrangler. "
                "Use --raw-sink=file for local runs."
            )
        cmd = [
            "npx", "--yes", "wrangler@4", "r2", "object", "put",
            f"{self.r2_bucket}/{key}",
            "--file", str(local_path),
            "--content-type", "application/json",
            "--content-encoding", "gzip",
            "--remote",
        ]
        proc = subprocess.run(
            cmd, capture_output=True, text=True,
            cwd=str(self.worker_cwd) if self.worker_cwd else None,
        )
        if proc.returncode != 0:
            # ⚠️ Loud failure. A raw archive that silently stops receiving
            # payloads is indistinguishable from one that is working, right up
            # until the day you need to reparse.
            raise RuntimeError(
                f"R2 upload failed for {key} (exit {proc.returncode}): "
                f"{redact_text(proc.stderr)[:400]}"
            )

    # ── output ──────────────────────────────────────────────────────────────

    def drain(self) -> list[dict]:
        """Hand over the index rows and reset. Idempotent to call repeatedly."""
        rows = [r.as_row() for r in self.records]
        self.records = []
        return rows

    def summary(self) -> dict:
        return {
            "mode": self.mode,
            "records": len(self.records),
            "bytes": self.bytes_written,
            "skipped_duplicates": self.skipped_duplicates,
            "archive_dir": str(self.archive_dir) if self.mode == "file" else None,
        }


def read_archived(path: Path | str) -> str:
    """Read a gzipped archived payload back. The reparse entry point."""
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(
            f"archived payload missing: {p}. The raw_yahoo_api_responses index "
            "row survives independently of the body, so this means the archive "
            "was pruned or moved — not that the request never happened."
        )
    with gzip.open(p, "rt", encoding="utf-8") as fh:
        return fh.read()
