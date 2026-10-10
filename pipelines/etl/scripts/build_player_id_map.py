#!/usr/bin/env python3
"""MFL player id -> NFL (gsis) id, by IDENTIFIERS only, with the checks shown.

Writes D1 `player_id_map` (migration 0170): one row per MFL player in MFL's
current players export, whether it was accepted, and why.

WHY (2026-10-10 audit, mobile Stats -> Players). `player_id_crosswalk` is built
by build_player_id_crosswalk.py on a laptop, last on 2026-04-22 — before the
draft — so all 167 rookies with 2026 NFL games had no NFL id on their player
card (empty game log), and its 3 name-only `fuzzy_auto` rows were all wrong
(J'Mari Taylor -> J.J. Taylor). This map never uses a name.

Routes (each an ID join; a NAME never maps a player):
  a  nflverse ff_playerids: mfl_id -> gsis_id                      (DynastyProcess, "DP")
  b  MFL espn_id -> nflverse players.espn_id -> gsis_id            (nflverse master, "NFLV")
  e  MFL sportsdata_id -> ff_playerids.sportradar_id -> gsis_id    (DP row, MFL's own key)
  f  MFL espn_id -> ff_playerids.espn_id -> gsis_id                (DP row, MFL's own key)
Checks against the nflverse master for the chosen gsis: birthdate, draft
year/round, position family.

Status and acceptance:
  verified        2+ routes from 2 lineages (DP and NFLV) agree, checks pass     accepted
  verified_dp     2+ DP routes agree (no ESPN id in nflverse), checks pass       accepted
  single_route    one ID route, checks pass                                      accepted
  bio_flag        every ID route agrees; a birthdate/position field differs      accepted, flagged
  id_suspect      IDs agree but the draft/career era says another person         NOT accepted
  id_disagree     ID routes point at different players                           NOT accepted
  dup_claim       one gsis claimed by several MFL ids                            NOT accepted
  unmapped        no ID route                                                    NOT accepted
pipelines/etl/data/player_id_map_overrides.csv (reviewed by a person) can
accept a specific gsis for an MFL id or exclude one; it always wins.

Usage:
  python3 pipelines/etl/scripts/build_player_id_map.py --season 2026 [--skip-d1] [--out-json path]
"""
from __future__ import annotations

import argparse
import collections
import csv
import datetime as dt
import json
import sys
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.d1_io import D1Writer  # noqa: E402

REPO = Path(__file__).resolve().parents[3]
OVERRIDES = REPO / "pipelines" / "etl" / "data" / "player_id_map_overrides.csv"
TEAM_POS = {"TMWR", "TMRB", "TMDL", "TMLB", "TMDB", "TMTE", "Def", "ST", "Off", "TMQB", "TMPK", "TMPN", "Coach", "XX"}
FAM = {
    "QB": {"QB"}, "RB": {"RB", "FB", "HB"}, "WR": {"WR"}, "TE": {"TE"}, "PK": {"K", "PK"}, "PN": {"P", "PN"},
    "DE": {"DE", "DL", "OLB", "LB", "DT", "EDGE"}, "DT": {"DT", "DL", "NT", "DE"},
    "LB": {"LB", "ILB", "MLB", "OLB", "DE", "EDGE"},
    "CB": {"CB", "DB", "S", "SAF", "FS", "SS"}, "S": {"S", "SAF", "FS", "SS", "DB", "CB"},
}
ACCEPTED = {"verified", "verified_dp", "single_route", "bio_flag", "override_accept"}
COLS = ["mfl_id", "gsis_id", "pfr_id", "espn_id", "mfl_position", "status", "accepted", "routes", "checks", "note", "built_at"]


def gsis_ok(v) -> str | None:
    v = str(v).strip() if v is not None else ""
    return v if v.startswith("00-") else None          # DP writes the literal 'NA'


def mfl_players(season: int) -> list[dict]:
    url = f"https://api.myfantasyleague.com/{season}/export?TYPE=players&DETAILS=1&JSON=1"
    req = urllib.request.Request(url, headers={"User-Agent": "upsmflproduction-etl"})
    with urllib.request.urlopen(req, timeout=120) as r:
        return json.load(r)["players"]["player"]


def mfl_bdate(p: dict) -> str | None:
    b = p.get("birthdate")
    if not b or not str(b).lstrip("-").isdigit():
        return None
    return dt.datetime.fromtimestamp(int(b), dt.UTC).date().isoformat()


def load_overrides() -> dict[str, dict]:
    if not OVERRIDES.exists():
        return {}
    with open(OVERRIDES, newline="") as f:
        return {r["mfl_id"].strip(): r for r in csv.DictReader(f) if r.get("mfl_id", "").strip() and not r["mfl_id"].startswith("#")}


def build(players: list[dict], ff, nplayers, overrides: dict) -> list[dict]:
    """ff / nplayers: lists of dicts (nflverse ff_playerids / players)."""
    route_a, sr_dp, espn_dp = {}, collections.defaultdict(set), collections.defaultdict(set)
    for r in ff:
        g = gsis_ok(r.get("gsis_id"))
        if not g:
            continue
        if r.get("mfl_id") is not None:
            route_a[str(int(r["mfl_id"]))] = g
        if r.get("sportradar_id"):
            sr_dp[str(r["sportradar_id"]).strip().lower()].add(g)
        if r.get("espn_id") is not None:
            espn_dp[str(int(r["espn_id"]))].add(g)
    espn_nflv = collections.defaultdict(set)
    by_gsis = {}
    for r in nplayers:
        g = gsis_ok(r.get("gsis_id"))
        if not g:
            continue
        by_gsis[g] = r
        if r.get("espn_id") is not None and str(r["espn_id"]).strip():
            espn_nflv[str(r["espn_id"]).strip()].add(g)

    def checks(p, g):
        n = by_gsis.get(g)
        out, det = {"birthdate": "n/a", "draft": "n/a", "position": "n/a"}, {}
        if not n:
            return {"birthdate": "no_nflverse_row", "draft": "no_nflverse_row", "position": "no_nflverse_row"}, det
        mb, nb = mfl_bdate(p), n.get("birth_date")
        if mb and nb:
            d = abs((dt.date.fromisoformat(mb) - dt.date.fromisoformat(str(nb)[:10])).days)
            out["birthdate"] = "match" if d == 0 else ("off_by_1" if d == 1 else "MISMATCH")
            det["_bdays"] = d
        my, mr, ny, nr = p.get("draft_year"), p.get("draft_round"), n.get("draft_year"), n.get("draft_round")
        if my and ny is not None:
            out["draft"] = "match" if int(my) == int(ny) and (not mr or nr is None or int(mr) == int(nr)) else "MISMATCH"
        elif my and ny is None:
            rs = n.get("rookie_season")
            out["draft"] = "MISMATCH" if mr else ("year_differs" if rs is not None and int(my) != int(rs) else "match_udfa")
        mp, np_ = p.get("position"), str(n.get("position") or "").upper()
        if mp in FAM:
            out["position"] = "match" if (np_ == mp or (mp, np_) in {("PK", "K"), ("PN", "P")}) else ("compatible" if np_ in FAM[mp] else "MISMATCH")
        det["_rookie_season"] = n.get("rookie_season")
        return out, det

    rows, claims = [], collections.defaultdict(list)
    for p in players:
        if not str(p.get("id", "")).isdigit() or p.get("position") in TEAM_POS:
            continue
        pid = str(int(p["id"]))
        routes = {}
        if pid in route_a:
            routes["a_dp_mfl_id"] = route_a[pid]
        e = str(p.get("espn_id") or "").strip()
        if e and e in espn_nflv:
            gs = espn_nflv[e]; routes["b_nflv_espn"] = next(iter(gs)) if len(gs) == 1 else "AMBIGUOUS"
        sr = str(p.get("sportsdata_id") or "").strip().lower()
        if sr and sr in sr_dp:
            gs = sr_dp[sr]; routes["e_dp_sportradar"] = next(iter(gs)) if len(gs) == 1 else "AMBIGUOUS"
        if e and e in espn_dp:
            gs = espn_dp[e]; routes["f_dp_espn"] = next(iter(gs)) if len(gs) == 1 else "AMBIGUOUS"
        vals = set(routes.values())
        gsis, status, note, chk = None, "unmapped", [], {}
        if "AMBIGUOUS" in vals or len(vals) > 1:
            status = "id_disagree"; note.append("ID routes disagree: " + json.dumps(routes, sort_keys=True))
        elif len(vals) == 1:
            gsis = next(iter(vals))
            lineages = {"NFLV" if k.startswith("b_") else "DP" for k in routes}
            chk, det = checks(p, gsis)
            fails = [k for k, v in chk.items() if v == "MISMATCH"]
            era_gap = det.get("_rookie_season") is not None and p.get("draft_year") and abs(int(p["draft_year"]) - int(det["_rookie_season"])) >= 3
            if chk.get("draft") == "MISMATCH" or (fails and era_gap):
                status = "id_suspect"; note.append("the NFL id's draft/career era doesn't fit this MFL player")
            elif fails:
                status = "bio_flag"; note.append("ID routes agree; differs on " + ", ".join(fails))
            elif len(routes) >= 2 and len(lineages) >= 2:
                status = "verified"
            elif len(routes) >= 2:
                status = "verified_dp"
            else:
                status = "single_route"
        rows.append({"mfl_id": pid, "gsis_id": gsis, "espn_id": e or None, "mfl_position": p.get("position") or None, "status": status,
                     "routes": routes, "checks": chk, "note": "; ".join(note), "_name": p.get("name")})
        if gsis and status in ACCEPTED:
            claims[gsis].append(pid)
    for r in rows:                     # one NFL id, several MFL ids: accept none of them
        if r["gsis_id"] and r["status"] in ACCEPTED and len(claims[r["gsis_id"]]) > 1:
            r["status"] = "dup_claim"; r["note"] = (r["note"] + "; " if r["note"] else "") + "gsis also claimed by " + ",".join(claims[r["gsis_id"]])
    for r in rows:                     # a person reviewed it: always wins
        o = overrides.get(r["mfl_id"])
        if not o:
            continue
        act = (o.get("action") or "").strip().lower()
        if act == "exclude":
            r["status"] = "override_exclude"; r["note"] = "excluded by review: " + (o.get("reason") or "")
        elif act == "accept" and gsis_ok(o.get("gsis_id")):
            r["gsis_id"] = gsis_ok(o["gsis_id"]); r["status"] = "override_accept"
            r["note"] = "accepted by review: " + (o.get("reason") or "")
    now = dt.datetime.now(dt.UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    for r in rows:
        r["accepted"] = 1 if r["status"] in ACCEPTED else 0
        n = by_gsis.get(r["gsis_id"]) if r["gsis_id"] else None
        r["pfr_id"] = (str(n.get("pfr_id")).strip() if n and n.get("pfr_id") else None) if r["accepted"] else None
        r["built_at"] = now
    return rows


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--season", type=int, default=dt.date.today().year)
    ap.add_argument("--skip-d1", action="store_true")
    ap.add_argument("--out-json", default="")
    args = ap.parse_args()
    import nflreadpy as nfl
    ff = nfl.load_ff_playerids().to_dicts()
    npl = nfl.load_players().to_dicts()
    rows = build(mfl_players(args.season), ff, npl, load_overrides())
    c = collections.Counter(r["status"] for r in rows)
    print(f"player_id_map: {len(rows)} MFL players, accepted {sum(r['accepted'] for r in rows)}: {dict(c)}", file=sys.stderr)
    if args.out_json:
        json.dump(rows, open(args.out_json, "w"), indent=1)
    if not args.skip_d1:
        with D1Writer(table="player_id_map", cols=COLS, pk_cols=["mfl_id"]) as w:
            for r in rows:
                w.add((r["mfl_id"], r["gsis_id"], r["pfr_id"], r["espn_id"], r["mfl_position"], r["status"], r["accepted"],
                       json.dumps(r["routes"], sort_keys=True), json.dumps(r["checks"], sort_keys=True), r["note"], r["built_at"]))


if __name__ == "__main__":
    main()
