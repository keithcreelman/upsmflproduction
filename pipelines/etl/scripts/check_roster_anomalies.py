#!/usr/bin/env python3
"""J3 — Daily roster / transaction anomaly check (flag-only, never auto-fix).

Per docs/DATA_AUTHORITY_MAP.md drift hotspot #0 + docs/SCHEDULED_PIPELINE_AUDIT.md §4.

Diffs the two most recent MFL snapshots (data/mfl-snapshots/<date>/rosters.json)
and, for every roster-membership or salary/contract change, requires a matching
MFL transaction (transactions.json). Anything unexplained is flagged:

  * UNEXPLAINED MOVE  — a player was added to / removed from a roster with no
    transaction referencing that player. Emitted as a GitHub `::error::`
    annotation and forces a non-zero exit so the scheduled run goes red.
  * SILENT CONTRACT EDIT — a player stayed on the same roster but their salary /
    contractInfo / contractStatus / contractYear changed with no transaction.
    Emitted as a `::warning::` (contracts are edited directly in MFL and often
    carry no transaction, so this is advisory, not a hard failure).

MFL-API-native via the committed snapshots — no local DB. CI-runnable.
"""
from __future__ import annotations
import argparse, json, os, re, sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SNAP_DIR = REPO_ROOT / "data" / "mfl-snapshots"

PID_RE = re.compile(r"\b(\d{3,7})\b")


def as_list(x):
    if x is None:
        return []
    return x if isinstance(x, list) else [x]


def load_rosters(snap: Path):
    """-> {fid: {pid: {salary, contractStatus, contractInfo, contractYear, status}}}"""
    data = json.load(open(snap / "rosters.json"))
    out = {}
    for fr in as_list(data.get("rosters", {}).get("franchise")):
        fid = str(fr.get("id"))
        players = {}
        for p in as_list(fr.get("player")):
            pid = str(p.get("id"))
            players[pid] = {
                "salary": str(p.get("salary", "")),
                "contractStatus": str(p.get("contractStatus", "")),
                "contractInfo": str(p.get("contractInfo", "")),
                "contractYear": str(p.get("contractYear", "")),
                "status": str(p.get("status", "")),
            }
        out[fid] = players
    return out


def transaction_players(tx: dict) -> set[str]:
    """Player IDs referenced by a transaction, parsed per type (skips prices + DP picks)."""
    ty = str(tx.get("type", ""))
    pids: set[str] = set()
    field = str(tx.get("transaction", ""))
    if ty in ("AUCTION_WON", "AUCTION_INIT", "AUCTION_BID"):
        # "pid|price|comment" — only the first segment is a player
        head = field.split("|", 1)[0]
        pids |= set(PID_RE.findall(head))
    elif ty in ("FREE_AGENT", "LOAD_ROSTERS", "WAIVER", "WAIVER_REQUEST"):
        # "addedCSV|droppedCSV" — both sides are players
        for seg in field.split("|"):
            pids |= set(PID_RE.findall(seg))
    elif ty in ("TAXI",):
        pids |= set(PID_RE.findall(str(tx.get("promoted", ""))))
        pids |= set(PID_RE.findall(str(tx.get("demoted", ""))))
    elif ty in ("IR",):
        pids |= set(PID_RE.findall(str(tx.get("activated", ""))))
        pids |= set(PID_RE.findall(str(tx.get("deactivated", ""))))
    elif ty == "TRADE":
        for k in ("franchise1_gave_up", "franchise2_gave_up"):
            for tok in str(tx.get(k, "")).split(","):
                tok = tok.strip()
                if tok and not tok.startswith("DP_") and not tok.startswith("BB_"):
                    pids |= set(PID_RE.findall(tok))
    else:
        pids |= set(PID_RE.findall(field))
    return pids


def load_transactions(snap: Path):
    data = json.load(open(snap / "transactions.json"))
    txs = as_list(data.get("transactions", {}).get("transaction"))
    moved: set[str] = set()           # any player referenced by any transaction
    moved_by_fid: dict[str, set] = {}
    for tx in txs:
        pids = transaction_players(tx)
        moved |= pids
        fid = str(tx.get("franchise", ""))
        if fid:
            moved_by_fid.setdefault(fid, set()).update(pids)
        # trades touch a second franchise
        f2 = str(tx.get("franchise2", ""))
        if f2:
            moved_by_fid.setdefault(f2, set()).update(pids)
    return moved, moved_by_fid, len(txs)


def two_latest(snap_dir: Path):
    dates = sorted([p.name for p in snap_dir.iterdir() if p.is_dir() and re.match(r"\d{4}-\d{2}-\d{2}", p.name)])
    if len(dates) < 2:
        return None
    return dates[-2], dates[-1]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--prev")
    ap.add_argument("--curr")
    ap.add_argument("--snap-dir", default=str(SNAP_DIR))
    ap.add_argument("--report", default=None)
    args = ap.parse_args()

    snap_dir = Path(args.snap_dir)
    if args.prev and args.curr:
        prev_d, curr_d = args.prev, args.curr
    else:
        pair = two_latest(snap_dir)
        if not pair:
            print("Need at least two snapshot dirs; nothing to compare.")
            return 0
        prev_d, curr_d = pair

    prev = load_rosters(snap_dir / prev_d)
    curr = load_rosters(snap_dir / curr_d)
    moved, moved_by_fid, n_tx = load_transactions(snap_dir / curr_d)
    print(f"Comparing {prev_d} -> {curr_d}  ({n_tx} transactions in window)")

    unexplained, edits = [], []
    for fid in sorted(set(prev) | set(curr)):
        pre, cur = prev.get(fid, {}), curr.get(fid, {})
        for pid in sorted(set(cur) - set(pre)):           # added
            if pid not in moved:
                unexplained.append({"fid": fid, "pid": pid, "kind": "ADDED", "info": cur[pid]})
        for pid in sorted(set(pre) - set(cur)):           # removed
            if pid not in moved:
                unexplained.append({"fid": fid, "pid": pid, "kind": "REMOVED", "info": pre[pid]})
        for pid in sorted(set(pre) & set(cur)):           # contract changed
            a, b = pre[pid], cur[pid]
            diffs = {k: (a[k], b[k]) for k in a if a[k] != b[k]}
            if diffs and pid not in moved_by_fid.get(fid, set()):
                edits.append({"fid": fid, "pid": pid, "diffs": diffs})

    for u in unexplained:
        print(f"::error::Unexplained roster move — F{u['fid']} player {u['pid']} {u['kind']} "
              f"(salary {u['info'].get('salary')}, {u['info'].get('contractStatus')}) — no MFL transaction references this player.")
    for e in edits:
        ds = "; ".join(f"{k}: {v[0]!r}->{v[1]!r}" for k, v in e["diffs"].items())
        print(f"::warning::Silent contract edit — F{e['fid']} player {e['pid']}: {ds} (no transaction).")

    report = {
        "compared": {"prev": prev_d, "curr": curr_d},
        "transactions_in_window": n_tx,
        "unexplained_moves": unexplained,
        "silent_contract_edits": edits,
    }
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(report, indent=2))
        print(f"Wrote report -> {args.report}")

    print(f"\nSummary: {len(unexplained)} unexplained move(s), {len(edits)} silent contract edit(s).")
    # Unexplained moves are a hard flag (red run); silent edits are advisory only.
    return 1 if unexplained else 0


if __name__ == "__main__":
    sys.exit(main())
