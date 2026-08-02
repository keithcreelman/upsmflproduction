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
  * CONTRACT REGRESSION — a player's contract STRUCTURE was destroyed: the
    contract length or TCV shrank with no `Restructured` stamp to justify it.
    Hard `::error::` + non-zero exit, and deliberately NOT excused by a
    transaction (see below).
  * CONTRACT MARKER LOST — a Restructured / Ext: / -FL|-BL annotation vanished
    while the money survived. `::warning::` only: real drift worth surfacing,
    but the cap is intact, and keeping it out of the red bucket is what makes a
    red run mean something.

Validated against 100 historical snapshot pairs: catches 18/18 of the
2026-08-02 flatten, and the only other hard hits are genuine (a known test-only
restructure, an unexplained CL 2->1, and a real restructure that failed to stamp
its marker) — i.e. no known false positives.

WHY REGRESSIONS IGNORE THE TRANSACTION LOG (2026-08-02, learned the hard way):
The SILENT CONTRACT EDIT check above only fires when NO transaction references
the player for that franchise. On 2026-08-02 an automated sweep reverted 18
owner-built multi-year contracts to 1-year defaults across 8 franchises — and
this script reported ZERO findings, because every one of those players was an
auction winner and therefore carried AUCTION_WON / AUCTION_BID transactions.
A transaction merely MENTIONING a player was treated as authorising ANY change
to their contract. It is not: an auction bid does not authorise rewriting a
3-year deal to 1 year. Structural destruction has no legitimate silent cause,
so it is judged on its own terms regardless of the transaction log.

MFL-API-native via the committed snapshots — no local DB. CI-runnable.
"""
from __future__ import annotations
import argparse, json, os, re, sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SNAP_DIR = REPO_ROOT / "data" / "mfl-snapshots"

PID_RE = re.compile(r"\b(\d{3,7})\b")

# ── Contract-structure parsing (canon §C5 / §C2 token grammar) ──────────────
# contractInfo looks like:
#   "CL 3| TCV 144K| AAV 48K| Y1-28K, Y2-58K, Y3-58K| GTD: 108K| Restructured 2026"
CL_RE = re.compile(r"\bCL\s*(\d+)", re.I)
TCV_RE = re.compile(r"\bTCV\s*([\d.]+)\s*K", re.I)
RESTRUCTURED_RE = re.compile(r"restructur", re.I)
EXT_RE = re.compile(r"\bExt:", re.I)
LOADED_RE = re.compile(r"-(FL|BL)\b", re.I)


def contract_shape(rec: dict) -> dict:
    """The structural facts worth protecting, extracted from one snapshot row."""
    info = str(rec.get("contractInfo", "") or "")
    status = str(rec.get("contractStatus", "") or "")
    cl = CL_RE.search(info)
    tcv = TCV_RE.search(info)
    return {
        "cl": int(cl.group(1)) if cl else None,
        "tcv_k": float(tcv.group(1)) if tcv else None,
        "restructured": bool(RESTRUCTURED_RE.search(info)),
        "extended": bool(EXT_RE.search(info)),
        "loaded": bool(LOADED_RE.search(status)),
    }


def contract_regressions(before: dict, after: dict) -> dict:
    """Ways a contract's STRUCTURE can only have been destroyed, never earned.

    Returns {"severe": [...], "advisory": [...]} — severe fails the run.

    Each rule is written so that a LEGITIMATE change does not trip it:
      * A real restructure re-bases TCV/CL to the remaining years (so both may
        legitimately shrink) but always stamps a `Restructured <year>` token —
        so a shrink is only a regression when that token was NOT gained.
      * The annual roll-forward decrements contractYear (years remaining), not
        CL (contract length), so CL shrinking is never routine.
      * Losing a Restructured / Ext: / -FL|-BL marker means recorded history was
        erased. Nothing legitimate erases it.
    """
    a, b = contract_shape(before), contract_shape(after)

    # LIFECYCLE TRANSITION, not destruction: a rookie deal ENDING and being
    # replaced by a veteran contract is the designed path (§B2 rookie -> ERA /
    # FAA re-auction). Those legitimately collapse a 3-year rookie deal to a
    # 1-year auction contract, and they land in a cluster every year right
    # after the rookie draft — 9 of them on 2026-05-29 alone. Judging them as
    # regressions would make this check cry wolf on its busiest week, and a
    # check that is red on ordinary days is a check nobody reads.
    # The 2026-08-02 destruction was Vet-FAA-BL -> Vet-FAA: already a veteran
    # contract, which is what makes it categorically different.
    was_rookie = "rookie" in str(before.get("contractStatus", "")).lower()
    now_rookie = "rookie" in str(after.get("contractStatus", "")).lower()
    if was_rookie and not now_rookie:
        return {"severe": [], "advisory": []}

    gained_restructure = b["restructured"] and not a["restructured"]

    # SEVERE — years or money were destroyed. This is the shape of the
    # 2026-08-02 incident (all 18 collapsed CL and TCV together) and there is no
    # benign cause once the rookie transition above is excluded. Hard failure.
    severe = []
    if a["cl"] is not None and b["cl"] is not None and b["cl"] < a["cl"] and not gained_restructure:
        severe.append(f"contract length {a['cl']}y -> {b['cl']}y")
    if a["tcv_k"] is not None and b["tcv_k"] is not None and b["tcv_k"] < a["tcv_k"] and not gained_restructure:
        severe.append(f"TCV {a['tcv_k']:g}K -> {b['tcv_k']:g}K")

    # ADVISORY — annotation lost while the money survived. Real drift worth
    # seeing (canon says a restructure must PRESERVE the -FL/-BL suffix, and
    # these are exactly the fingerprints of the suffix bug fixed 2026-08-01),
    # but the cap is intact and several are historical. Warned, not failed:
    # a check that goes red on ordinary days stops being read, and the severe
    # bucket is what has to stay believable.
    advisory = []
    if a["restructured"] and not b["restructured"]:
        advisory.append("lost its Restructured marker")
    if a["extended"] and not b["extended"]:
        advisory.append("lost its Ext: marker")
    if a["loaded"] and not b["loaded"]:
        advisory.append("lost its -FL/-BL loading suffix")
    return {"severe": severe, "advisory": advisory}


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

    unexplained, edits, regressions, marker_losses = [], [], [], []
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
            # Structural destruction is judged on its own terms — NOT excused by
            # a transaction. See the module docstring: on 2026-08-02 every one of
            # the 18 destroyed contracts belonged to an auction winner, so the
            # `pid not in moved_by_fid` test above silently cleared all of them.
            if diffs:
                why = contract_regressions(a, b)
                if why["severe"] or why["advisory"]:
                    rec = {
                        "fid": fid, "pid": pid,
                        "reasons": why["severe"] + why["advisory"],
                        "severe_reasons": why["severe"],
                        "advisory_reasons": why["advisory"],
                        "before": {"contractStatus": a["contractStatus"], "contractInfo": a["contractInfo"], "salary": a["salary"]},
                        "after": {"contractStatus": b["contractStatus"], "contractInfo": b["contractInfo"], "salary": b["salary"]},
                        "referenced_by_transaction": pid in moved_by_fid.get(fid, set()),
                    }
                    (regressions if why["severe"] else marker_losses).append(rec)

    for u in unexplained:
        print(f"::error::Unexplained roster move — F{u['fid']} player {u['pid']} {u['kind']} "
              f"(salary {u['info'].get('salary')}, {u['info'].get('contractStatus')}) — no MFL transaction references this player.")
    for e in edits:
        ds = "; ".join(f"{k}: {v[0]!r}->{v[1]!r}" for k, v in e["diffs"].items())
        print(f"::warning::Silent contract edit — F{e['fid']} player {e['pid']}: {ds} (no transaction).")
    for r in regressions:
        seen = " (a transaction references this player, but that does not authorise this)" if r["referenced_by_transaction"] else ""
        print(f"::error::CONTRACT REGRESSION — F{r['fid']} player {r['pid']}: "
              f"{'; '.join(r['reasons'])}{seen}. "
              f"before={r['before']['contractInfo']!r} after={r['after']['contractInfo']!r}")
    for m in marker_losses:
        print(f"::warning::Contract marker lost — F{m['fid']} player {m['pid']}: "
              f"{'; '.join(m['advisory_reasons'])} (money unchanged). "
              f"before status={m['before']['contractStatus']!r} after status={m['after']['contractStatus']!r}")

    report = {
        "compared": {"prev": prev_d, "curr": curr_d},
        "transactions_in_window": n_tx,
        "unexplained_moves": unexplained,
        "silent_contract_edits": edits,
        "contract_regressions": regressions,
        "contract_marker_losses": marker_losses,
    }
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(report, indent=2))
        print(f"Wrote report -> {args.report}")

    print(f"\nSummary: {len(unexplained)} unexplained move(s), {len(edits)} silent contract edit(s), "
          f"{len(regressions)} contract regression(s), {len(marker_losses)} marker loss(es).")
    # Unexplained moves and contract regressions are hard flags (red run);
    # silent edits stay advisory. A regression means owner-built contract
    # structure was destroyed — the single failure this whole check exists for.
    return 1 if (unexplained or regressions) else 0


if __name__ == "__main__":
    sys.exit(main())
