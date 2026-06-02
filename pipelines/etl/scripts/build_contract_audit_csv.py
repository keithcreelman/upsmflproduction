#!/usr/bin/env python3
"""Audit CSV: every current-roster player's contract/transaction events + confidence.

Sweeps /api/player-transactions for all contracted 2026 players and flattens each
event to a row so Keith can review contract data + HIGH/LOW confidence across the
whole league in one sheet. Writes docs/contract_audit_all_players.csv.
"""
import csv
import json
import subprocess
from concurrent.futures import ThreadPoolExecutor

WORKER = "https://upsmflproduction.keith-creelman.workers.dev"


def fetch(url):
    out = subprocess.run(["curl", "-s", url], capture_output=True, text=True).stdout
    try:
        return json.loads(out)
    except Exception:
        return None


def main():
    sal = fetch(f"{WORKER}/api/mfl-export?TYPE=salaries&L=74598&YEAR=2026&JSON=1") or {}
    players = sal.get("salaries", {}).get("leagueUnit", {}).get("player", [])
    pids = [p["id"] for p in players if p.get("contractStatus")]
    pl = fetch(f"{WORKER}/api/mfl-export?TYPE=players&L=74598&YEAR=2026&JSON=1") or {}
    names = {p["id"]: p.get("name", "") for p in pl.get("players", {}).get("player", [])}

    def player_rows(pid):
        d = fetch(f"{WORKER}/api/player-transactions?pid={pid}&L=74598&YEAR=2026")
        rows = []
        for e in (d.get("events", []) if d else []):
            c = e.get("contract") or {}
            conf = e.get("confidence") or ("low" if c.get("confidence") in ("derived", "low") else "high")
            rows.append({
                "player_id": pid, "player": names.get(pid, ""),
                "season": e.get("season"), "date": e.get("date"),
                "kind": e.get("kind"), "event": e.get("label") or e.get("kind"),
                "franchise": e.get("franchise_name") or e.get("franchise_id"),
                "type": c.get("canonical_type", ""), "cl": c.get("cl", ""),
                "tcv": c.get("tcv", ""), "aav": c.get("aav", ""),
                "years": "/".join(str(y) for y in c.get("years", [])),
                "confidence": conf,
                "source": (e.get("source") or e.get("evidence") or "")[:240],
            })
        return rows

    all_rows = []
    with ThreadPoolExecutor(max_workers=12) as ex:
        for rows in ex.map(player_rows, pids):
            all_rows.extend(rows)

    cols = ["player_id", "player", "season", "date", "kind", "event", "franchise",
            "type", "cl", "tcv", "aav", "years", "confidence", "source"]
    out_path = "docs/contract_audit_all_players.csv"
    with open(out_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols)
        w.writeheader()
        def _sk(x):
            try:
                yr = int(x.get("season") or 0)
            except (TypeError, ValueError):
                yr = 0
            return (str(x.get("player") or ""), yr)
        for r in sorted(all_rows, key=_sk):
            w.writerow(r)
    low = sum(1 for r in all_rows if r["confidence"] == "low")
    print(f"Wrote {out_path}: {len(all_rows)} rows / {len(pids)} players ({low} low-confidence)")


if __name__ == "__main__":
    main()
