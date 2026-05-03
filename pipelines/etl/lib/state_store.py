"""In-memory snapshot of live MFL state for the 2026 auction bid sheet (Layer 1).

This is the JSON contract that Layer 7 (UI) consumes and that downstream
layers (cap math, expected-bid priors, simulator) read from. Each snapshot
captures the 8 MFL endpoints listed in the brief at a single timestamp.
"""
from __future__ import annotations

import json
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


def now_iso_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass
class StateSnapshot:
    league_id: str
    season: int
    server: str
    timestamp_utc: str
    mode: str  # "auction" | "idle"

    rosters: dict[str, Any] = field(default_factory=dict)
    salaries: dict[str, Any] = field(default_factory=dict)
    salary_adjustments: dict[str, Any] = field(default_factory=dict)
    transactions: dict[str, Any] = field(default_factory=dict)
    free_agents: dict[str, Any] = field(default_factory=dict)
    future_draft_picks: dict[str, Any] = field(default_factory=dict)
    league_meta: dict[str, Any] = field(default_factory=dict)
    rules: dict[str, Any] = field(default_factory=dict)

    fetch_errors: list[str] = field(default_factory=list)

    ENDPOINT_FIELDS = (
        "rosters", "salaries", "salary_adjustments", "transactions",
        "free_agents", "future_draft_picks", "league_meta", "rules",
    )

    def to_dict(self) -> dict:
        return asdict(self)

    def populated_endpoints(self) -> list[str]:
        return [k for k in self.ENDPOINT_FIELDS if getattr(self, k)]

    def save(self, output_dir: Path) -> Path:
        """Write a timestamped snapshot AND update `state_snapshot_latest.json`.

        Returns the timestamped path.
        """
        output_dir = Path(output_dir)
        output_dir.mkdir(parents=True, exist_ok=True)
        ts = self.timestamp_utc.replace(":", "").replace("-", "")
        ts_path = output_dir / f"state_snapshot_{self.league_id}_{ts}.json"
        latest_path = output_dir / f"state_snapshot_{self.league_id}_latest.json"
        payload = json.dumps(self.to_dict(), indent=2, default=str)
        ts_path.write_text(payload)
        latest_path.write_text(payload)
        return ts_path

    @classmethod
    def load(cls, path: Path) -> "StateSnapshot":
        data = json.loads(Path(path).read_text())
        return cls(**data)
