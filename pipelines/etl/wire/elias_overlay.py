#!/usr/bin/env python3
"""Source-boundary Elias correction overlay.

elias.py's Thursday check writes site/wire/data/elias_<season>_wk<NN>.json --
the frozen, already-confirmed diff between what MFL originally published for
that week and the corrected official result. weekly_recap.py's own Elias
integration (add_elias()) only ADDS a documentary section to the pack; it
never corrects the standings/game/record/player facts the SAME build
computes from D1's src_franchise_weekly_score / src_schedule / src_weekly,
which D1 keeps at the original (pre-correction) values.

This module patches those three tables' rows -- IN MEMORY, on the way out of
wire_data.d1() -- to the corrected values, before any pack-building code
derives games, records, AP records, standings, division leaders, offense/IDP
splits, grading or captions from them. D1 itself is never written to:
wire_data.d1() remains a plain read-only SELECT; only the Python
list-of-dicts it is about to return is corrected.

Corrections are keyed by season + week + franchise_id + player_id + stat
category ONLY (never by owner name, never hardcoded team names, never a
manually-typed corrected fantasy total) and are refused (fail closed) if a
franchise_id OR player_id named in an elias report cannot be resolved,
uniquely, against that season/week's own src_franchises / src_weekly rows.
"""
import glob
import json
import os
import re
import subprocess

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
WORKER_DIR = os.path.join(os.path.dirname(__file__), "wt-wire-wk02", "worker") \
    if os.path.isdir(os.path.join(os.path.dirname(__file__), "wt-wire-wk02", "worker")) \
    else os.path.join(REPO, "worker")

IDP_GROUPS = ("DL", "LB", "DB")
OFFENSE_GROUPS = ("QB", "RB", "WR", "TE")
KICKING_GROUPS = ("PK", "PN")


class OverlayError(RuntimeError):
    pass


_valid_fids_cache = {}
_player_row_cache = {}
_overlay_cache = {}


def _d1_readonly(sql):
    """Independent, read-only wrangler call -- deliberately not routed through
    wire_data.d1() to avoid re-entering the function this module patches the
    output of."""
    cmd = ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--json", "--command", sql]
    proc = subprocess.run(cmd, cwd=WORKER_DIR, capture_output=True, text=True)
    if proc.returncode != 0 or not proc.stdout.strip():
        raise OverlayError("elias overlay: read-only lookup failed: %s\nSQL: %s"
                            % ((proc.stderr or "")[:300], sql[:200]))
    payload = json.loads(proc.stdout.strip())
    return payload[0]["results"]


def _franchise_ids_for_season(season):
    if season in _valid_fids_cache:
        return _valid_fids_cache[season]
    rows = _d1_readonly("SELECT franchise_id FROM src_franchises WHERE season=%d" % season)
    fids = set(r["franchise_id"] for r in rows)
    _valid_fids_cache[season] = fids
    return fids


def _player_row(season, week, pid):
    """The unique src_weekly row for (season, week, player_id), or raises
    (fail closed) if it does not resolve to exactly one row."""
    key = (season, week, pid)
    if key in _player_row_cache:
        return _player_row_cache[key]
    rows = _d1_readonly(
        "SELECT roster_franchise_id AS fid, pos_group, status, score FROM src_weekly "
        "WHERE season=%d AND week=%d AND player_id='%s'" % (season, week, pid))
    if len(rows) != 1:
        raise OverlayError("elias overlay: player id %r (season %d wk %d) resolves to %d src_weekly "
                            "rows, not exactly 1 -- refusing to apply an unresolved player correction"
                            % (pid, season, week, len(rows)))
    _player_row_cache[key] = rows[0]
    return rows[0]


def _elias_files_for_season(season):
    return sorted(glob.glob(os.path.join(REPO, "site", "wire", "data", "elias_%d_wk*.json" % season)))


def _bucket_for(pos_group):
    if pos_group in IDP_GROUPS:
        return "idp"
    if pos_group in OFFENSE_GROUPS:
        return "off"
    if pos_group in KICKING_GROUPS:
        return "kp"
    return None


def load_overlay(season):
    """{(week, fid): {"score": corrected_team_score,
                       "flipVs": {opp_fid: (result, own_score, opp_score)},
                       "allplay": {"w":, "l":, "t":},
                       "players": {pid: {"delta":, "after":, "bucket":}},
                       "bucketDelta": {"off":, "idp":, "kp":}}}

    allplay is CUMULATIVE through that week, matching elias.py's own
    comparison window -- only valid to apply when a caller's through_week
    equals this week exactly. bucketDelta is the per-franchise sum of its
    players' deltas, split by offense/IDP/kicking bucket, for patching the
    SQL-side SUM(...) aggregate the offense/IDP split query computes.

    Raises OverlayError (fail closed) if any franchise_id or player_id an
    elias report names cannot be resolved uniquely against that
    season/week's own src_franchises / src_weekly rows.
    """
    if season in _overlay_cache:
        return _overlay_cache[season]
    valid_fids = _franchise_ids_for_season(season)
    overlay = {}
    for path in _elias_files_for_season(season):
        m = re.search(r"_wk(\d+)\.json$", path)
        if not m:
            continue
        week = int(m.group(1))
        rep = json.load(open(path, encoding="utf-8"))

        def _check_fid(fid):
            if fid not in valid_fids:
                raise OverlayError("elias overlay: franchise id %r in %s does not resolve uniquely "
                                    "against src_franchises for season %d -- refusing to apply an "
                                    "unresolved correction" % (fid, os.path.basename(path), season))

        for t in rep.get("teams", []):
            _check_fid(t["fid"])
            overlay.setdefault((week, t["fid"]), {})["score"] = t["after"]
        for g in rep.get("games", []):
            a, b = g["a"], g["b"]
            _check_fid(a)
            _check_fid(b)
            if not g.get("flipped"):
                continue
            sa, sb = g["after"]
            ra = "W" if sa > sb else ("L" if sa < sb else "T")
            rb = "W" if sb > sa else ("L" if sb < sa else "T")
            overlay.setdefault((week, a), {}).setdefault("flipVs", {})[b] = (ra, sa, sb)
            overlay.setdefault((week, b), {}).setdefault("flipVs", {})[a] = (rb, sb, sa)
        for a in rep.get("allplayChanges", []):
            _check_fid(a["fid"])
            overlay.setdefault((week, a["fid"]), {})["allplay"] = dict(a["after"])

        for p in rep.get("players", []):
            fid, pid = p.get("fid"), p.get("pid")
            if not fid or not pid:
                raise OverlayError("elias overlay: malformed player correction in %s (missing fid/pid): %r"
                                    % (os.path.basename(path), p))
            _check_fid(fid)
            row = _player_row(season, week, pid)          # raises if unresolved/ambiguous
            if str(row.get("fid")) != str(fid):
                raise OverlayError("elias overlay: player %r in %s is on src_weekly franchise %r, not "
                                    "the reported %r -- refusing an unresolved player correction"
                                    % (pid, os.path.basename(path), row.get("fid"), fid))
            pos_group = row.get("pos_group")
            bucket = _bucket_for(pos_group)
            if bucket is None:
                raise OverlayError("elias overlay: player %r in %s has unmapped position group %r"
                                    % (pid, os.path.basename(path), pos_group))
            delta = float(p["after"]) - float(p["before"])
            entry = overlay.setdefault((week, fid), {})
            entry.setdefault("players", {})[pid] = {"delta": delta, "after": float(p["after"]), "bucket": bucket}
            # Keyed by the player's EXACT pos_group (not the coarser off/idp/kp
            # bucket) -- a franchise can have several starters spread across
            # different pos_groups that all map to the same bucket (e.g. DB,
            # DL and LB all count as "idp"), and starter_points_by_group()
            # GROUPs BY pos_group, one row per exact pos_group. Keying on the
            # coarse bucket would apply the same delta to every one of those
            # rows instead of just the one the corrected player is actually in.
            pgd = entry.setdefault("posGroupDelta", {})
            pgd[pos_group] = round(pgd.get(pos_group, 0.0) + delta, 4)

    _overlay_cache[season] = overlay
    return overlay


_SEASON_RE = re.compile(r"season\s*=\s*(\d+)", re.I)
_WEEK_EXACT_RE = re.compile(r"\bweek\s*=\s*(\d+)", re.I)
_WEEK_LE_RE = re.compile(r"\bweek\s*<=\s*(\d+)", re.I)
_TABLE_RE = re.compile(r"\bsrc_(franchise_weekly_score|schedule|weekly)\b", re.I)
_ALLPLAY_SELFJOIN_RE = re.compile(r"JOIN\s+s\s+b\s+ON\s+a\.week\s*=\s*b\.week", re.I)
_BUCKET_AGG_RE = re.compile(r"GROUP\s+BY\s+w\.roster_franchise_id\s*,\s*w\.pos_group", re.I)


def apply(sql, rows):
    """Patch `rows` (already fetched, read-only) toward the Elias-corrected
    values, if `sql` reads a table this overlay knows about for an exact
    season+week it has a correction for. A pass-through in every other case:
    no season match, no week match, no overlay entry for that
    season/week/franchise/player, or a table this overlay doesn't
    understand -- rows are returned byte-equivalent, unchanged."""
    if not rows or not _TABLE_RE.search(sql):
        return rows

    # Multi-season/all-time queries (e.g. record_book()'s league-history top
    # 10, which has no `season =`/`week =` literal at all -- it spans every
    # season) carry season/week/franchise_id AS ROW VALUES instead. Patch by
    # those row-level values directly rather than requiring a literal in the
    # SQL text, so a stale pre-correction score can't sit unpatched inside an
    # all-time/cross-season ranking. Every known elias season is tried since
    # such a query is never scoped to one season by its WHERE clause.
    if "season" in rows[0] and "week" in rows[0] and "franchise_id" in rows[0] and "team_score" in rows[0]:
        out = []
        for row in rows:
            row = dict(row)
            try:
                rs, rwk = int(row["season"]), int(row["week"])
            except (TypeError, ValueError):
                out.append(row)
                continue
            if _elias_files_for_season(rs):
                ov = load_overlay(rs)
                entry = ov.get((rwk, row.get("franchise_id")))
                if entry and "score" in entry:
                    row["team_score"] = entry["score"]
                opp_fid = row.get("opponent_franchise_id")
                if opp_fid:
                    opp_entry = ov.get((rwk, opp_fid))
                    if opp_entry and "score" in opp_entry and "opponent_score" in row:
                        row["opponent_score"] = opp_entry["score"]
                # `combined` (team_score + opponent_score) was computed INSIDE
                # the SQL from the pre-correction values -- recompute it here
                # too, or a corrected team_score/opponent_score would sit next
                # to a stale combined total.
                if "combined" in row and "team_score" in row and "opponent_score" in row:
                    row["combined"] = row["team_score"] + row["opponent_score"]
            out.append(row)
        return out

    season_m = _SEASON_RE.search(sql)
    if not season_m:
        return rows
    season = int(season_m.group(1))
    if not _elias_files_for_season(season):
        return rows
    overlay = load_overlay(season)

    # allplay_table()'s self-join computes w/l/t ENTIRELY in SQL -- there is no
    # per-row team_score left to patch after the fact. Recompute those two
    # aggregate columns directly from elias's own cumulative allplayChanges,
    # but ONLY when the query's through_week matches exactly the week that
    # correction is cumulative through (elias's allplayChanges are already
    # "through this week", not a delta for one week in isolation).
    if _ALLPLAY_SELFJOIN_RE.search(sql) and "w" in rows[0] and "l" in rows[0] and "t" in rows[0] \
            and "franchise_id" in rows[0]:
        le_m = _WEEK_LE_RE.search(sql)
        if not le_m:
            return rows
        week = int(le_m.group(1))
        out = []
        for row in rows:
            row = dict(row)
            entry = overlay.get((week, row.get("franchise_id")))
            if entry and "allplay" in entry:
                row["w"], row["l"], row["t"] = entry["allplay"]["w"], entry["allplay"]["l"], entry["allplay"]["t"]
            out.append(row)
        return out

    # starter_points_by_group()'s offense/IDP split computes SUM(score) per
    # (franchise, pos_group) ENTIRELY in SQL -- no individual player row
    # survives to patch. Add each affected franchise's per-EXACT-pos_group
    # delta (summed at load_overlay() time from the same player corrections)
    # onto the one matching row. Keyed by exact pos_group, not the coarser
    # off/idp/kp bucket: a franchise can have several rows that all map to
    # "idp" (its DB row, its DL row, its LB row, ...), and applying a
    # bucket-wide delta to every one of them would multiply-count it.
    if _BUCKET_AGG_RE.search(sql) and "fid" in rows[0] and "pos_group" in rows[0] and "pts" in rows[0]:
        week_m = _WEEK_EXACT_RE.search(sql)
        if not week_m:
            return rows
        week = int(week_m.group(1))
        out = []
        for row in rows:
            row = dict(row)
            entry = overlay.get((week, row.get("fid")))
            pg_delta = entry.get("posGroupDelta", {}).get(row.get("pos_group")) if entry else None
            # Additive (not a set-to-absolute-value), unlike every other patch
            # in this module -- guard against double-application (e.g. apply()
            # called twice on its own output) with a private marker key.
            if pg_delta and not row.get("_elias_patched"):
                row["pts"] = round(float(row["pts"] or 0) + pg_delta, 2)
                row["_elias_patched"] = True
            out.append(row)
        return out

    week_m = _WEEK_EXACT_RE.search(sql)
    if not week_m:
        return rows
    week = int(week_m.group(1))

    out = []
    for row in rows:
        row = dict(row)

        # Individual player-level src_weekly rows (any shape that carries
        # player_id + score, whatever else is also selected).
        pid = row.get("player_id")
        if pid is not None and "score" in row:
            fid_for_pid = row.get("roster_franchise_id") or row.get("fid") or row.get("franchise_id")
            entry = overlay.get((week, fid_for_pid)) if fid_for_pid else None
            if entry is None:
                # fid column not present/aliased on this query -- search this
                # week's entries for the one owning this pid instead.
                for (wk2, fid2), e2 in overlay.items():
                    if wk2 == week and pid in e2.get("players", {}):
                        entry = e2
                        break
            if entry and pid in entry.get("players", {}):
                row["score"] = entry["players"][pid]["after"]

        fid = row.get("franchise_id")
        entry = overlay.get((week, fid)) if fid else None
        if entry and "score" in entry and "team_score" in row:
            row["team_score"] = entry["score"]
        opp_fid = row.get("opponent_franchise_id")
        if opp_fid:
            opp_entry = overlay.get((week, opp_fid))
            if opp_entry and "score" in opp_entry and "opponent_score" in row:
                row["opponent_score"] = opp_entry["score"]
        if entry and "flipVs" in entry and opp_fid in entry["flipVs"] and "result" in row:
            new_result, new_own, new_opp = entry["flipVs"][opp_fid]
            row["result"] = new_result
            if "team_score" in row:
                row["team_score"] = new_own
            if "opponent_score" in row:
                row["opponent_score"] = new_opp
        out.append(row)
    return out
