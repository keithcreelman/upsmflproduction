"""snapshot_franchise_assets.py — Pull MFL rosters + future picks for every
franchise in the league and dump to a static JSON the hub can read in local
preview when the Cloudflare worker isn't reachable.

Output: site/rookies/franchise_assets_2026.json
  {
    "meta": { "generated_at_utc": "...", "league_id": "74598" },
    "by_fid": {
      "0001": {
        "players": [{ "asset_id": "P_15123", "display": "Brock Bowers",
                      "player_id": "15123", "position": "TE", "salary": 12000 }, ...],
        "future_picks": [...],
        "current_picks": [...]
      },
      ...
    }
  }

Run: python3 pipelines/etl/scripts/snapshot_franchise_assets.py
"""

from __future__ import annotations
import json
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

LEAGUE_ID = "74598"
YEAR = "2026"
UA = "upsmflproduction/1.0 (franchise-assets snapshot)"
TIMEOUT = 20

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
OUT_FILE = REPO_ROOT / "site" / "rookies" / "franchise_assets_2026.json"


def _http_get_json(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
        return json.loads(r.read())


def _arr(x):
    if x is None: return []
    return x if isinstance(x, list) else [x]


def _pad_fid(v) -> str:
    s = "".join(c for c in str(v or "") if c.isdigit())
    return s.zfill(4)[-4:] if s else ""


# Cache MFL player names / positions for nice display strings.
def fetch_player_index() -> dict:
    print(f"  Fetching MFL player index…")
    data = _http_get_json(
        f"https://api.myfantasyleague.com/{YEAR}/export?TYPE=players&JSON=1"
    )
    out = {}
    for p in _arr(data.get("players", {}).get("player")):
        pid = str(p.get("id"))
        name = p.get("name") or ""
        # "Last, First" → "First Last"
        if "," in name:
            name = " ".join(part.strip() for part in name.split(",")[::-1])
        out[pid] = {
            "name": name,
            "position": (p.get("position") or "").upper(),
            "team": p.get("team") or "",
        }
    print(f"    indexed {len(out)} players")
    return out


def fetch_franchise_names() -> dict:
    """Map franchise_id → team name (and owner name when available).

    Team name comes from MFL league info (authoritative). Owner name comes
    from the rookie_draft_team_tendencies.json artifact when present —
    that's where we cache the (franchise_id → owner_name) lookup that
    powers the rest of the hub.
    """
    print(f"  Fetching franchise names for league {LEAGUE_ID}…")
    out = {}
    try:
        data = _http_get_json(
            f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=league&L={LEAGUE_ID}&JSON=1"
        )
        for f in _arr(data.get("league", {}).get("franchises", {}).get("franchise")):
            fid = _pad_fid(f.get("id"))
            if fid:
                out[fid] = {"team_name": f.get("name") or "", "owner_name": ""}
    except Exception as e:
        print(f"    league fetch failed: {e}")
    # Overlay owner names from tendencies. NOTE: that file is keyed by
    # OWNER NAME (not franchise_id) and a single fid can have multiple
    # historical owners — pick the active one (is_active=true), falling back
    # to the most-recent franchise_name when active flag isn't set.
    tendencies_file = REPO_ROOT / "site" / "rookies" / "rookie_draft_team_tendencies.json"
    if tendencies_file.exists():
        try:
            tdata = json.loads(tendencies_file.read_text())
            owner_by_fid: dict = {}
            for owner_name, t in (tdata.get("teams") or {}).items():
                pid = _pad_fid(t.get("franchise_id"))
                if not pid:
                    continue
                # Prefer an active owner; otherwise overwrite only if we
                # haven't seen one for this fid yet.
                if t.get("is_active") or pid not in owner_by_fid:
                    owner_by_fid[pid] = {
                        "owner_name": owner_name,
                        "team_name": t.get("current_team_name") or "",
                    }
            for pid, info in owner_by_fid.items():
                if pid not in out:
                    out[pid] = {"team_name": "", "owner_name": ""}
                if info["owner_name"]:
                    out[pid]["owner_name"] = info["owner_name"]
                if info["team_name"] and not out[pid]["team_name"]:
                    out[pid]["team_name"] = info["team_name"]
        except Exception as e:
            print(f"    tendencies overlay failed: {e}")
    print(f"    resolved {len(out)} franchise names")
    return out


def _fid_label(fid: str, names: dict) -> str:
    """Render '<team> (<owner>)', falling back gracefully when info is missing."""
    info = names.get(fid) or {}
    team = info.get("team_name") or ""
    owner = info.get("owner_name") or ""
    if team and owner:
        return f"{team} · {owner}"
    return team or owner or fid


def main() -> int:
    print(f"Snapshotting franchise assets to {OUT_FILE}")
    player_idx = fetch_player_index()
    franchise_names = fetch_franchise_names()

    # Rosters — TYPE=rosters returns every franchise's roster
    print(f"  Fetching rosters for league {LEAGUE_ID}…")
    rosters = _http_get_json(
        f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=rosters&L={LEAGUE_ID}&JSON=1"
    )
    franchises = _arr(rosters.get("rosters", {}).get("franchise"))

    # Future draft picks — same shape, indexed by current owner
    print(f"  Fetching future draft picks…")
    fdp = _http_get_json(
        f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=futureDraftPicks&L={LEAGUE_ID}&JSON=1"
    )
    fdp_franchises = _arr(fdp.get("futureDraftPicks", {}).get("franchise"))
    fdp_by_fid = {_pad_fid(f.get("id")): _arr(f.get("futureDraftPick")) for f in fdp_franchises}

    # Current-year unmade picks — TYPE=draftResults
    print(f"  Fetching current-year draft picks…")
    dr = _http_get_json(
        f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=draftResults&L={LEAGUE_ID}&JSON=1"
    )
    dr_units = _arr(dr.get("draftResults", {}).get("draftUnit"))
    current_by_fid: dict[str, list] = {}
    for u in dr_units:
        for dp in _arr(u.get("draftPick") or u.get("pick")):
            if dp.get("player"): continue  # already made
            owner = _pad_fid(dp.get("franchise") or dp.get("currentOwner"))
            if not owner: continue
            current_by_fid.setdefault(owner, []).append({
                "asset_id": f"DP_{YEAR}_{dp.get('round')}_{dp.get('pick')}",
                "display": f"{YEAR} {dp.get('round')}.{str(dp.get('pick')).zfill(2)}",
                "round": dp.get("round"),
                "slot": dp.get("pick"),
            })

    by_fid: dict[str, dict] = {}
    for f in franchises:
        fid = _pad_fid(f.get("id"))
        if not fid: continue
        # Players
        players = []
        for p in _arr(f.get("player")):
            pid = str(p.get("id"))
            info = player_idx.get(pid, {})
            display = info.get("name") or f"Player #{pid}"
            # Taxi flag — universal site convention. Surfaced wherever the
            # player is rendered (My Team, trade modal, profile card, etc.).
            roster_status = str(p.get("status") or p.get("rosterStatus") or "").upper()
            contract_status = p.get("contractStatus") or ""
            is_taxi = ("TAXI" in roster_status) or (str(contract_status).upper() == "TAXI")
            players.append({
                "asset_id": f"P_{pid}",
                "display": display,
                "player_id": pid,
                "position": info.get("position") or "",
                "nfl_team": info.get("team") or "",
                "salary": int(float(p.get("salary") or 0)),
                "contract_year": int(p.get("contractYear") or 0),
                "contract_status": contract_status,
                "roster_status": roster_status,
                "taxi": is_taxi,
            })
        # Sort: non-taxi first by salary desc, then taxi at the bottom (also
        # by salary desc within group). Keeps cap-relevant guys at the top
        # while taxi stay visible without dominating the active list.
        players.sort(key=lambda p: (1 if p["taxi"] else 0, -(p["salary"] or 0), p["display"]))

        # Future picks — display "via <Team Name> · <Owner>" when traded.
        future_picks = []
        for fp in fdp_by_fid.get(fid, []):
            yr = str(fp.get("year"))
            rd = str(fp.get("round"))
            orig = _pad_fid(fp.get("originalPickFor") or fp.get("originalOwner") or fid)
            via = ""
            if orig and orig != fid:
                via = f"  (via {_fid_label(orig, franchise_names)})"
            future_picks.append({
                "asset_id": f"FP_{yr}_{rd}_{orig}",
                "display": f"{yr} R{rd}{via}",
                "year": yr, "round": rd, "original_fid": orig,
                "original_team_name": franchise_names.get(orig, {}).get("team_name") or "",
                "original_owner_name": franchise_names.get(orig, {}).get("owner_name") or "",
            })
        future_picks.sort(key=lambda fp: (fp["year"], fp["round"]))

        by_fid[fid] = {
            "players": players,
            "future_picks": future_picks,
            "current_picks": current_by_fid.get(fid, []),
        }

    out = {
        "meta": {
            "generated_at_utc": datetime.now(timezone.utc).isoformat(),
            "league_id": LEAGUE_ID,
            "year": YEAR,
            "n_franchises": len(by_fid),
        },
        "by_fid": by_fid,
    }
    OUT_FILE.parent.mkdir(parents=True, exist_ok=True)
    OUT_FILE.write_text(json.dumps(out, indent=2))
    total_players = sum(len(v["players"]) for v in by_fid.values())
    print(f"Wrote {len(by_fid)} franchises · {total_players} players · "
          f"{sum(len(v['future_picks']) for v in by_fid.values())} future picks")
    return 0


if __name__ == "__main__":
    sys.exit(main())
