#!/usr/bin/env python3
"""J3 — Daily roster / transaction anomaly check (flag-only, never auto-fix).

Per docs/DATA_AUTHORITY_MAP.md drift hotspot #0 + docs/SCHEDULED_PIPELINE_AUDIT.md §4.

Diffs the two most recent MFL snapshots (data/mfl-snapshots/<date>/rosters.json)
and, for every roster-membership or salary/contract change, requires a matching
MFL transaction (transactions.json). Anything unexplained is flagged:

  * UNEXPLAINED MOVE  — a player was ADDED to a roster with no transaction
    referencing that player. Emitted as a GitHub `::error::` annotation and
    forces a non-zero exit so the scheduled run goes red.
  * ROSTER DROP — a player LEFT a franchise's roster and either no transaction
    explains it, or the only thing that explains it is a LOAD_ROSTERS bulk
    commissioner import. Hard `::error::` + non-zero exit. See below.
  * SILENT BULK ROSTER IMPORT, ALREADY REVERTED — a LOAD_ROSTERS dropped a
    player and he is back before the next snapshot, so the roster diff is blind
    to it. Read straight off the transaction log. `::warning::` — the roster
    survived, but the mutation happened and it should still be seen.
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

WHY ROSTER DROPS GET THEIR OWN CHECK (2026-08-06, learned the same way):
Will Levis (F0006), Tank Bigsby and Zach Charbonnet (F0001) silently vanished
from their rosters at 17:11:06 / 17:12:05 / 17:12:25 UTC via MFL LOAD_ROSTERS
transactions with `by_commish=1` and an EMPTY added side. Nothing in this repo
can write roster membership — every TYPE=rosters reference is an export — so
those came from MFL's own commissioner UI or MFL-side processing. This script
ran clean that morning and would never have caught it: the UNEXPLAINED MOVE
test above asks only "does ANY transaction anywhere mention this player", and
a LOAD_ROSTERS mentions them by construction (as would any auction bid). The
commissioner found it by eye, hours later.
So departures are now judged per (franchise, player) against the transactions
that can actually take a player OFF that franchise's roster, inside the window
since the previous snapshot — and a LOAD_ROSTERS-caused disappearance is
ALWAYS reported even though a transaction technically "explains" it, because a
silent bulk roster import is precisely the thing we were blind to.

MFL-API-native via the committed snapshots — no local DB. CI-runnable. The only
network call is a best-effort player-NAME lookup for already-flagged ids
(`--no-network` disables it); it never affects what is or isn't flagged.
"""
from __future__ import annotations
import argparse, json, os, re, sys, urllib.error, urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:  # ET is for human-readable alert timestamps only; never gates a finding.
    from zoneinfo import ZoneInfo
    ET_TZ = ZoneInfo("America/New_York")
except Exception:  # pragma: no cover - no tzdata on the runner
    ET_TZ = None

REPO_ROOT = Path(__file__).resolve().parents[3]
SNAP_DIR = REPO_ROOT / "data" / "mfl-snapshots"

PID_RE = re.compile(r"\b(\d{3,7})\b")

PLAYERS_URL = ("https://www48.myfantasyleague.com/{year}/export"
               "?TYPE=players&L={league}&PLAYERS={pids}&JSON=1")
USER_AGENT = "upsmflproduction-roster-anomaly-check"


class UnreadableInput(Exception):
    """An input we could not read.

    Canon (Keith, 2026-08-02): NO FAIL-OPEN GUARDS. An unreadable or missing
    input is never "empty" and never "no change". A rosters.json that fails to
    load must not be read as "every player was dropped", and must not be read
    as "nothing happened" either — it is an UNREADABLE INPUT and the run goes
    red on that fact alone.
    """

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


def read_json(path: Path, what: str):
    """json.load, but every failure mode is an UnreadableInput — never a default."""
    if not path.exists():
        raise UnreadableInput(f"{what} is MISSING ({path})")
    try:
        raw = path.read_text()
    except OSError as e:
        raise UnreadableInput(f"{what} could not be read ({path}): {e}") from e
    if not raw.strip():
        raise UnreadableInput(f"{what} is EMPTY ({path})")
    try:
        return json.loads(raw)
    except ValueError as e:
        raise UnreadableInput(f"{what} is not valid JSON ({path}): {e}") from e


def load_rosters(snap: Path):
    """-> {fid: {pid: {salary, contractStatus, contractInfo, contractYear, status}}}

    A rosters export with no franchises, or with franchises but no players at
    all, is a broken export — not a league where everybody got dropped.
    """
    label = f"{snap.name}/rosters.json"
    data = read_json(snap / "rosters.json", label)
    franchises = as_list(data.get("rosters", {}).get("franchise"))
    if not franchises:
        raise UnreadableInput(f"{label} parsed but contains 0 franchises")
    out = {}
    for fr in franchises:
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
    if not any(out.values()):
        raise UnreadableInput(
            f"{label} parsed but contains 0 players across {len(out)} franchise(s)")
    return out


def load_franchise_names(snap: Path) -> dict:
    """-> {fid: name}. Best-effort: this is alert LABELLING, not detection.

    A missing league.json degrades the alert text to a bare franchise id; it can
    never change whether a drop is flagged, so it is not an UnreadableInput.
    """
    try:
        data = read_json(snap / "league.json", f"{snap.name}/league.json")
    except UnreadableInput:
        return {}
    fr = as_list(data.get("league", {}).get("franchises", {}).get("franchise"))
    return {str(f.get("id")): str(f.get("name", "")) for f in fr}


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


def read_transactions(snap: Path) -> list:
    """-> the raw transaction list. A log we cannot parse is UNREADABLE, not empty."""
    label = f"{snap.name}/transactions.json"
    data = read_json(snap / "transactions.json", label)
    if "transactions" not in data:
        raise UnreadableInput(f"{label} has no `transactions` key — export is malformed")
    return as_list(data.get("transactions", {}).get("transaction"))


def load_transactions(snap: Path, txs: list | None = None):
    if txs is None:
        txs = read_transactions(snap)
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


# ── ROSTER DROP detection (2026-08-06 incident) ─────────────────────────────
# Types whose DROP side legitimately takes a player off a roster. Everything
# else that touches a roster row is deliberately absent:
#   TAXI / IR  — taxi and IR players are STILL in the rosters export (status
#                TAXI_SQUAD / INJURED_RESERVE), so neither can ever explain a
#                disappearance. Accepting them would reopen the 2026-08-06 hole.
#   AUCTION_*  — a franchise winning/bidding on a player says nothing about
#                another franchise losing one.
LEGIT_DEPARTURE_TYPES = ("FREE_AGENT", "WAIVER", "WAIVER_REQUEST")
# Technically a transaction, still always reported: a bulk commissioner roster
# import that silently removes players is the incident, not the explanation.
BULK_DEPARTURE_TYPES = ("LOAD_ROSTERS",)


def dropped_side(tx: dict) -> set[str]:
    """Player ids on the DROP side of an `addedCSV|droppedCSV` transaction field."""
    parts = str(tx.get("transaction", "")).split("|")
    return set(PID_RE.findall(parts[1])) if len(parts) > 1 else set()


def gave_up_side(tx: dict, key: str) -> set[str]:
    """Player ids one side of a trade gave up (skips DP_ picks and BB_ dollars)."""
    pids: set[str] = set()
    for tok in str(tx.get(key, "")).split(","):
        tok = tok.strip()
        if tok and not tok.startswith("DP_") and not tok.startswith("BB_"):
            pids |= set(PID_RE.findall(tok))
    return pids


def departure_index(txs: list, since_ts: int) -> dict:
    """-> {(fid, pid): [tx, ...]} — transactions that took `pid` OFF `fid`'s roster.

    Scoped to `since_ts` (see transaction_window): the log is the whole season,
    and a March free-agent drop must not excuse an August disappearance of a
    player who was demonstrably on the roster yesterday.
    """
    idx: dict[tuple[str, str], list] = {}
    for tx in txs:
        try:
            ts = int(tx.get("timestamp", 0))
        except (TypeError, ValueError):
            ts = 0
        if ts < since_ts:
            continue
        ty = str(tx.get("type", ""))
        fid = str(tx.get("franchise", ""))
        pairs: list[tuple[str, str]] = []
        if ty in LEGIT_DEPARTURE_TYPES or ty in BULK_DEPARTURE_TYPES:
            pairs += [(fid, pid) for pid in dropped_side(tx)]
        elif ty == "TRADE":
            pairs += [(fid, pid) for pid in gave_up_side(tx, "franchise1_gave_up")]
            f2 = str(tx.get("franchise2", ""))
            pairs += [(f2, pid) for pid in gave_up_side(tx, "franchise2_gave_up")]
        for key in pairs:
            if key[0]:
                idx.setdefault(key, []).append(tx)
    return idx


def transaction_window(prev_txs: list, curr_txs: list, prev_d: str, curr_d: str) -> int:
    """Floor timestamp for "happened since the baseline snapshot".

    Everything at or before the newest transaction in the PREVIOUS snapshot was
    already reflected in the previous rosters, so that is the natural floor.
    A log that has gone BACKWARDS in time is a stale or truncated export and is
    refused outright — silently widening or emptying the window would let real
    drops slip through as "explained" or bury them as noise.
    """
    def newest(txs):
        stamps = []
        for tx in txs:
            try:
                stamps.append(int(tx.get("timestamp", 0)))
            except (TypeError, ValueError):
                pass
        return max(stamps) if stamps else 0

    prev_max, curr_max = newest(prev_txs), newest(curr_txs)
    if curr_txs and not curr_max:
        raise UnreadableInput(f"{curr_d}/transactions.json has no usable timestamps")
    if not curr_txs and prev_txs:
        raise UnreadableInput(
            f"{curr_d}/transactions.json is an EMPTY log while {prev_d} had "
            f"{len(prev_txs)} — treating that as 'nothing happened' is exactly "
            "the fail-open this check refuses")
    if curr_max < prev_max:
        raise UnreadableInput(
            f"{curr_d}/transactions.json ends at {curr_max} but {prev_d} already "
            f"reached {prev_max} — the log went backwards in time (stale export)")
    return prev_max


def fmt_ts(ts: int) -> str:
    """'2026-08-06 17:11:06 UTC / 13:11:06 ET' — recovery needs both clocks."""
    utc = datetime.fromtimestamp(ts, timezone.utc)
    out = utc.strftime("%Y-%m-%d %H:%M:%S UTC")
    if ET_TZ is not None:
        out += datetime.fromtimestamp(ts, ET_TZ).strftime(" / %Y-%m-%d %H:%M:%S ET")
    else:
        out += " / ET unavailable (no tzdata on this host)"
    return out


def tx_summary(tx: dict) -> dict:
    try:
        ts = int(tx.get("timestamp", 0))
    except (TypeError, ValueError):
        ts = 0
    return {
        "type": str(tx.get("type", "")),
        "franchise": str(tx.get("franchise", "")),
        "by_commish": str(tx.get("by_commish", "")) == "1",
        "timestamp": ts,
        "when": fmt_ts(ts),
        "raw": str(tx.get("transaction", "")) or {k: tx.get(k) for k in
                                                  ("franchise1_gave_up", "franchise2_gave_up") if tx.get(k)},
    }


def roster_drops(prev: dict, curr: dict, dep_idx: dict, prev_d: str, curr_d: str) -> list:
    """Players who left a franchise's roster, with the transaction (if any) that did it.

    Raises UnreadableInput rather than reporting a whole franchise as dropped:
    a franchise that vanished from the export, or came back with an empty
    roster, is a broken export — no franchise legitimately empties overnight.
    """
    drops = []
    for fid in sorted(prev):
        pre = prev[fid]
        if fid not in curr:
            raise UnreadableInput(
                f"franchise {fid} is present in {prev_d}/rosters.json but ABSENT from "
                f"{curr_d} — refusing to report its {len(pre)} player(s) as dropped")
        cur = curr[fid]
        if pre and not cur:
            raise UnreadableInput(
                f"franchise {fid} went from {len(pre)} player(s) in {prev_d} to an EMPTY "
                f"roster in {curr_d} — that is a broken export, not {len(pre)} drops")
        for pid in sorted(set(pre) - set(cur)):
            txs = dep_idx.get((fid, pid), [])
            legit = [t for t in txs if str(t.get("type", "")) in LEGIT_DEPARTURE_TYPES]
            bulk = [t for t in txs if str(t.get("type", "")) in BULK_DEPARTURE_TYPES]
            traded = [t for t in txs if str(t.get("type", "")) == "TRADE"]
            explained = legit + traded
            # A real drop/trade is the operative event only if it is the LAST
            # word — a bulk import after it is still a silent bulk mutation.
            def newest_ts(lst):
                return max((int(t.get("timestamp", 0) or 0) for t in lst), default=-1)
            if explained and newest_ts(explained) >= newest_ts(bulk):
                continue
            tx = (bulk or explained)[-1] if (bulk or explained) else None
            # Where did he go? Cheap triage: a silent move shows up as an
            # unexplained drop here and an add on somebody else's roster.
            landed = next((f for f in curr if f != fid and pid in curr[f]), None)
            drops.append({
                "fid": fid, "pid": pid,
                "kind": "LOAD_ROSTERS" if bulk else "UNEXPLAINED",
                "last_known": dict(pre[pid]),
                "transaction": tx_summary(tx) if tx else None,
                "landed_on_fid": landed,
            })
    return drops


def reverted_bulk_drops(prev: dict, curr: dict, dep_idx: dict) -> list:
    """Bulk imports that dropped a player and put him back before the next snapshot.

    The snapshot diff is blind to these — and 2026-08-06 is the proof: the three
    players were removed at 17:11 UTC and restored at 00:30 UTC, both inside one
    nightly window, so tomorrow's roster diff shows nothing at all. The
    transaction log still remembers, so the log is asked directly. Advisory
    (`::warning::`): the roster survived, but a silent bulk mutation happened and
    the commissioner deserves to hear about it without the run going red.
    """
    out = []
    for (fid, pid), txs in sorted(dep_idx.items()):
        bulk = [t for t in txs if str(t.get("type", "")) in BULK_DEPARTURE_TYPES]
        if not bulk:
            continue
        if pid in prev.get(fid, {}) and pid in curr.get(fid, {}):
            out.append({"fid": fid, "pid": pid,
                        "transaction": tx_summary(sorted(
                            bulk, key=lambda t: int(t.get("timestamp", 0) or 0))[-1])})
    return out


def fetch_player_names(pids, year: str, league: str, enabled: bool = True) -> dict:
    """-> {pid: 'First Last'} for the flagged ids only. Best-effort by design.

    Names make an alert actionable, but they are not evidence: this runs AFTER
    detection and a failure here degrades the label to the bare id. It can
    never suppress or create a finding, which is why it may fail soft.
    """
    pids = sorted(set(pids))
    if not pids or not enabled:
        return {}
    url = PLAYERS_URL.format(year=year, league=league, pids=",".join(pids))
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=15) as r:
            data = json.loads(r.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError, OSError) as e:
        print(f"::warning::Player-name lookup failed ({e}) — alerts below use raw "
              "player ids. Detection is unaffected.")
        return {}
    out = {}
    for p in as_list(data.get("players", {}).get("player")):
        nm = str(p.get("name", ""))          # MFL gives "Last, First"
        if "," in nm:
            last, first = [s.strip() for s in nm.split(",", 1)]
            nm = f"{first} {last}"
        out[str(p.get("id"))] = nm
    return out


def snapshot_meta(snap: Path) -> tuple[str, str]:
    """-> (season_year, league_id) for the name lookup; defaults are harmless."""
    try:
        meta = read_json(snap / "_snapshot_meta.json", f"{snap.name}/_snapshot_meta.json")
    except UnreadableInput:
        return "2026", "74598"
    return str(meta.get("season_year", "2026")), str(meta.get("league_id", "74598"))


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
    ap.add_argument("--no-network", action="store_true",
                    help="skip the best-effort player-name lookup (detection is unaffected)")
    args = ap.parse_args()

    snap_dir = Path(args.snap_dir)
    if args.prev and args.curr:
        prev_d, curr_d = args.prev, args.curr
    else:
        pair = two_latest(snap_dir)
        if not pair:
            # NOT "nothing to compare, all clear": we were asked to verify the
            # rosters and could not. That is an unreadable input, not a pass.
            print(f"::error::UNREADABLE INPUT — fewer than two snapshot dirs under "
                  f"{snap_dir}; the roster check did NOT run and NOTHING has been verified.")
            return 2
        prev_d, curr_d = pair

    try:
        prev = load_rosters(snap_dir / prev_d)
        curr = load_rosters(snap_dir / curr_d)
        prev_txs = read_transactions(snap_dir / prev_d)
        curr_txs = read_transactions(snap_dir / curr_d)
        since_ts = transaction_window(prev_txs, curr_txs, prev_d, curr_d)
        dep_idx = departure_index(curr_txs, since_ts)
        drops = roster_drops(prev, curr, dep_idx, prev_d, curr_d)
        reverted = reverted_bulk_drops(prev, curr, dep_idx)
    except UnreadableInput as e:
        print(f"::error::UNREADABLE INPUT — {e}. The roster/contract check did NOT run; "
              "this is NOT a clean bill of health. Fix the snapshot and re-run.")
        return 2

    moved, moved_by_fid, n_tx = load_transactions(snap_dir / curr_d, curr_txs)
    print(f"Comparing {prev_d} -> {curr_d}  ({n_tx} transactions in log, "
          f"{len(dep_idx)} departure(s) since {fmt_ts(since_ts)})")

    names = fetch_player_names([d["pid"] for d in drops + reverted],
                               *snapshot_meta(snap_dir / curr_d),
                               enabled=not args.no_network)
    fnames = load_franchise_names(snap_dir / curr_d) or load_franchise_names(snap_dir / prev_d)

    unexplained, edits, regressions, marker_losses = [], [], [], []
    for fid in sorted(set(prev) | set(curr)):
        pre, cur = prev.get(fid, {}), curr.get(fid, {})
        for pid in sorted(set(cur) - set(pre)):           # added
            if pid not in moved:
                unexplained.append({"fid": fid, "pid": pid, "kind": "ADDED", "info": cur[pid]})
        # Removals are NOT handled here any more — roster_drops() above owns them.
        # This test ("does any transaction anywhere mention the player") is
        # strictly weaker: on 2026-08-06 the LOAD_ROSTERS that did the dropping
        # mentioned all three players, so it cleared every one of them.
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

    # Drops first: they are the loudest finding and the one a human has to act
    # on inside minutes. Everything the alert needs to RESTORE the player by
    # hand is on the line — franchise, salary, contractStatus, contractInfo.
    for d in drops:
        who = names.get(d["pid"], "name unavailable")
        fname = fnames.get(d["fid"], "name unavailable")
        lk = d["last_known"]
        if d["kind"] == "LOAD_ROSTERS":
            tx = d["transaction"]
            head = (f"ROSTER DROP BY BULK COMMISSIONER IMPORT — {who} ({d['pid']}) removed from "
                    f"F{d['fid']} {fname} by a LOAD_ROSTERS with an empty added side at "
                    f"{tx['when']}{' (by_commish)' if tx['by_commish'] else ''}. A LOAD_ROSTERS "
                    "technically 'explains' this, but it is a silent bulk roster import — it is "
                    "reported ALWAYS, because this is the exact signature of the 2026-08-06 "
                    "incident (Levis / Bigsby / Charbonnet).")
        else:
            head = (f"UNEXPLAINED ROSTER DROP — {who} ({d['pid']}) left F{d['fid']} {fname} with NO "
                    "FREE_AGENT / WAIVER / TRADE transaction from that franchise to explain it "
                    "(TAXI and IR cannot: those players stay in the rosters export).")
        if d["landed_on_fid"]:
            head += (f" He is now on F{d['landed_on_fid']} "
                     f"{fnames.get(d['landed_on_fid'], 'name unavailable')}.")
        print(f"::error::{head} LAST KNOWN — salary {lk.get('salary')}, "
              f"contractStatus {lk.get('contractStatus')!r}, contractYear {lk.get('contractYear')}, "
              f"roster status {lk.get('status')!r}, contractInfo {lk.get('contractInfo')!r}")
    for r in reverted:
        print(f"::warning::Silent bulk roster import (already reverted) — "
              f"{names.get(r['pid'], 'name unavailable')} ({r['pid']}) was removed from "
              f"F{r['fid']} {fnames.get(r['fid'], 'name unavailable')} by a LOAD_ROSTERS at "
              f"{r['transaction']['when']}"
              f"{' (by_commish)' if r['transaction']['by_commish'] else ''} and is back on the "
              "roster now. The roster diff cannot see this — the transaction log can. Confirm "
              "the contract came back byte-identical.")
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
        "departure_window_since": {"timestamp": since_ts, "when": fmt_ts(since_ts)},
        "roster_drops": [dict(d, player_name=names.get(d["pid"]),
                              franchise_name=fnames.get(d["fid"])) for d in drops],
        "reverted_bulk_drops": [dict(r, player_name=names.get(r["pid"]),
                                     franchise_name=fnames.get(r["fid"])) for r in reverted],
        "unexplained_moves": unexplained,
        "silent_contract_edits": edits,
        "contract_regressions": regressions,
        "contract_marker_losses": marker_losses,
    }
    if args.report:
        Path(args.report).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report).write_text(json.dumps(report, indent=2))
        print(f"Wrote report -> {args.report}")

    print(f"\nSummary: {len(drops)} roster drop(s), {len(reverted)} reverted bulk import(s), "
          f"{len(unexplained)} unexplained move(s), "
          f"{len(edits)} silent contract edit(s), {len(regressions)} contract regression(s), "
          f"{len(marker_losses)} marker loss(es).")
    # Roster drops, unexplained moves and contract regressions are hard flags
    # (red run); silent edits stay advisory. A drop means a player left a roster
    # with nobody able to say why, and a regression means owner-built contract
    # structure was destroyed — the two failures this whole check exists for.
    return 1 if (drops or unexplained or regressions) else 0


if __name__ == "__main__":
    sys.exit(main())
