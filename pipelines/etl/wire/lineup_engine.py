"""Legal starting lineup construction, ported from site/m/front_office_lineup.js.

Direct port -- same slot ids, same eligibility, same fixed-slots-first-then-flex
fill order. That fill order is not a shortcut: LINEUP_SLOTS' eligibility sets are
laminar (each fixed slot's eligible set is a strict subset of the flex slot that
can also take it, which is itself a strict subset of the slot above it -- {QB} is
inside SuperFlex-eligible {QB,RB,WR,TE}; {RB} is inside Flex-eligible {RB,WR,TE}
which is inside SuperFlex-eligible too; {DL}/{LB}/{DB} are each inside
DFlex-eligible {DL,LB,DB}). For a laminar/nested eligibility family, filling the
most-specific (smallest-eligible-set) open slots first with the best remaining
eligible player is a textbook matroid greedy and is exchange-argument-optimal --
not an approximation. Do not "fix" this into per-player-first processing; it is
already correct.
"""

QB, RB, WR, TE, PK, PN, DL, LB, DB, OTH = "QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB", "OTH"

_POS_MAP = {
    "QB": QB,
    "RB": RB, "FB": RB, "HB": RB,
    "WR": WR,
    "TE": TE,
    "PK": PK, "K": PK,
    "PN": PN, "P": PN,
    "DT": DL, "DE": DL, "NT": DL, "DL": DL,
    "LB": LB, "OLB": LB, "ILB": LB, "MLB": LB,
    "CB": DB, "S": DB, "FS": DB, "SS": DB, "DB": DB,
}


def pos_group(pos):
    return _POS_MAP.get(str(pos or "").strip().upper(), OTH)


LINEUP_SLOTS = [
    {"id": "QB1", "label": "QB", "side": "O", "accepts": [QB]},
    {"id": "RB1", "label": "RB", "side": "O", "accepts": [RB]},
    {"id": "RB2", "label": "RB", "side": "O", "accepts": [RB]},
    {"id": "WR1", "label": "WR", "side": "O", "accepts": [WR]},
    {"id": "WR2", "label": "WR", "side": "O", "accepts": [WR]},
    {"id": "TE1", "label": "TE", "side": "O", "accepts": [TE]},
    {"id": "OF1", "label": "Flex", "side": "O", "accepts": [RB, WR, TE], "flex": True},
    {"id": "OF2", "label": "Flex", "side": "O", "accepts": [RB, WR, TE], "flex": True},
    {"id": "SF1", "label": "SuperFlex", "side": "O", "accepts": [QB, RB, WR, TE], "flex": True},
    {"id": "PK1", "label": "K", "side": "O", "accepts": [PK]},
    {"id": "PN1", "label": "P", "side": "O", "accepts": [PN]},
    {"id": "DL1", "label": "DL", "side": "D", "accepts": [DL]},
    {"id": "DL2", "label": "DL", "side": "D", "accepts": [DL]},
    {"id": "LB1", "label": "LB", "side": "D", "accepts": [LB]},
    {"id": "LB2", "label": "LB", "side": "D", "accepts": [LB]},
    {"id": "DB1", "label": "DB", "side": "D", "accepts": [DB]},
    {"id": "DB2", "label": "DB", "side": "D", "accepts": [DB]},
    {"id": "DF1", "label": "Flex", "side": "D", "accepts": [DL, LB, DB], "flex": True},
]


def lineup_eligible(row):
    """row: {pid, pos, is_taxi, is_ir, is_expired}. Excludes taxi/IR/expired
    and anything that doesn't resolve to a real lineup position group."""
    if not row:
        return False
    if row.get("is_taxi") or row.get("is_ir") or row.get("is_expired"):
        return False
    return pos_group(row.get("pos")) != OTH


def fill_slots(rows, score_fn):
    """rows: list of eligible-checked dicts with 'pid'/'pos'. score_fn(row)->float.
    Returns {slot_id: pid or None}."""
    by_group = {}
    for r in rows:
        if not lineup_eligible(r):
            continue
        by_group.setdefault(pos_group(r["pos"]), []).append(r)
    for g in by_group:
        by_group[g].sort(key=lambda r: score_fn(r), reverse=True)

    used = set()
    draft = {}

    def take(accepts):
        best = None
        for g in accepts:
            for r in by_group.get(g, []):
                if r["pid"] in used:
                    continue
                if best is None or score_fn(r) > score_fn(best):
                    best = r
        if best is not None:
            used.add(best["pid"])
            return best["pid"]
        return None

    for s in LINEUP_SLOTS:
        if not s.get("flex"):
            draft[s["id"]] = take(s["accepts"])
    for s in LINEUP_SLOTS:
        if s.get("flex"):
            draft[s["id"]] = take(s["accepts"])
    return draft


def build_legal_lineup(roster_rows, offense_score_fn, other_score_fn):
    """roster_rows: list of {pid, pos, is_taxi, is_ir, is_expired}.
    Offense (QB/RB/WR/TE/PK/PN) is scored by offense_score_fn (ADP rsf);
    defense (DL/LB/DB) is scored by other_score_fn (salary -- ADP doesn't
    cover IDP). Two independent fill_slots() passes over the same eligible
    pool, since offense and defense slots never compete for the same player.
    Returns {"slots": {...}, "starter_pids": set, "bench": [rows not starting]}.
    """
    def score(r):
        # ADP covers QB/RB/WR/TE only -- K/P/DL/LB/DB are salary-scored, same
        # as the existing pipeline's IDP treatment (never priced, only ranked
        # against each other by what the owner paid).
        return offense_score_fn(r) if pos_group(r["pos"]) in (QB, RB, WR, TE) else other_score_fn(r)

    slots = fill_slots(roster_rows, score)
    starter_pids = {pid for pid in slots.values() if pid}
    bench = [r for r in roster_rows if lineup_eligible(r) and r["pid"] not in starter_pids]
    return {"slots": slots, "starter_pids": starter_pids, "bench": bench}
