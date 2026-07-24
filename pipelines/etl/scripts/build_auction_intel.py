#!/usr/bin/env python3
"""Build commish Auction War Room intel from the per-bid auction history.

Scope: the **FA Auction only** (`auction_type='FreeAgent'`, late July / early Aug).
The spring `TagOrExpiredRookie` auctions (Apr-Jun) are a different event and are
excluded — the War Room is about the July/Aug free-agent auction.

Reads the per-bid `transactions_auction` table (every FA AUCTION bid event,
2014-2025, ET timestamps + proxy forcing/leader IDs) and produces two CANON files:

  docs/auction/data/bids_enriched.csv   one row per bid + derived fields
  docs/auction/data/auction_intel.json  per-owner behavioural profiles per era
                                        + league summary + position thresholds

MFL proxy-auction semantics (verified against real lots):
  - Each lot is a sequence of bid events ordered by `bid_sequence`.
  - A "forced" event (forced_bid_ind=1) is recorded under the *leader* whose
    displayed price was auto-walked up; `franchise_forcing_id` is the UNDERBIDDER
    who submitted the proxy that forced it. So the true ACTOR (who acted, and
    when) at a forced event is the forcing franchise, not owner_name.
  - `franchise_currentbid_id` = who holds the high bid AFTER the event (the leader).
  - An OVERTAKE/bump = a non-forced event where the leader changes franchise.
  - The 24h lock resets on every bid; time-remaining at a bid ≈ 24h − seconds_since_prev_bid
    (a large gap = the lot was idle and nearly locked = a late snipe).

Usage:
  python3 pipelines/etl/scripts/build_auction_intel.py
  python3 pipelines/etl/scripts/build_auction_intel.py --db /path/to/mfl_database.db
"""
from __future__ import annotations
import argparse
import gzip
import json
import os
import shutil
import sqlite3
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
ARCHIVE_GZ = REPO / "data" / "db-archives" / "mfl_database_2026-06-05.db.gz"
OUT_DIR = REPO / "docs" / "auction" / "data"

LOCK_WINDOW_H = 24.0          # FA Auction proxy lock window (§A2)
POST_WIN_WINDOW_H = 8.0       # "after they win, they pounce within N hours"
LATE_THRESHOLDS_H = [8.0, 6.0, 2.0]   # time-remaining buckets Keith flagged (<8, <6, <2)

# Commitment zones (win $K) — map to the cap-free rule §D2 (reuse v5 framing).
def zone_of(k: float) -> str:
    if k <= 4: return "capfree"
    if k <= 9: return "low"
    if k <= 17: return "mid"
    return "marquee"

ERAS = {"sf": (2022, 2025), "l5": (2021, 2025), "all": (2014, 2025)}


def pad4(v) -> str:
    s = str(v if v is not None else "").strip()
    return s.zfill(4) if s.isdigit() else s


def fnum(v) -> float:
    try: return float(v)
    except (TypeError, ValueError): return 0.0


def resolve_db(arg_db: str | None) -> tuple[str, bool]:
    """Return (path, is_temp). Prefer an explicit --db, then a decompressed
    archive in /tmp, else decompress the in-repo gz to a temp file."""
    if arg_db:
        return arg_db, False
    cached = Path(tempfile.gettempdir()) / "ups_auction_canon.db"
    if cached.exists():
        return str(cached), False
    if not ARCHIVE_GZ.exists():
        sys.exit(f"FATAL: no --db and archive missing at {ARCHIVE_GZ}")
    print(f"decompressing {ARCHIVE_GZ.name} → {cached} …", file=sys.stderr)
    with gzip.open(ARCHIVE_GZ, "rb") as fi, open(cached, "wb") as fo:
        shutil.copyfileobj(fi, fo)
    return str(cached), False


def hour_et(time_et, datetime_et) -> int | None:
    for v in (time_et, datetime_et):
        s = str(v or "")
        if ":" in s:
            part = s.split(" ")[-1] if " " in s else s
            try: return int(part.split(":")[0]) % 24
            except (ValueError, IndexError): pass
    return None


def load_lots(conn: sqlite3.Connection):
    """Yield (season, player_id, [event dicts ordered by bid_sequence])."""
    cur = conn.execute("""
        SELECT season, player_id, player_name, position, nfl_team,
               franchise_id, owner_name, team_name, bid_amount, bid_sequence,
               initialbid_ind, finalbid_ind, forced_bid_ind,
               franchise_currentbid_id, franchise_forcing_id,
               unix_timestamp, datetime_et, time_et, seconds_since_prev_bid
        FROM transactions_auction
        WHERE season >= 2014 AND auction_type = 'FreeAgent'
        ORDER BY season, player_id, bid_sequence
    """)
    cols = [d[0] for d in cur.description]
    cur_key, batch = None, []
    for row in cur:
        r = dict(zip(cols, row))
        key = (r["season"], r["player_id"])
        if cur_key is not None and key != cur_key:
            yield cur_key[0], cur_key[1], batch
            batch = []
        cur_key, _ = key, batch.append(r)
    if batch:
        yield cur_key[0], cur_key[1], batch


def push_d1(intel: dict) -> None:
    """Build a LEAN served payload (D1 has a per-statement size cap, SQLITE_TOOBIG):
    sf-era only per owner, verdicts trimmed to fid/confidence/flags, + the v6 doc.
    Upserts the single ups_auction_intel blob via wrangler."""
    import subprocess, time
    payload = {"meta": intel["meta"], "league": intel["league"], "owners": {}}
    for fid, o in intel["owners"].items():
        payload["owners"][fid] = {"franchise_id": o["franchise_id"], "owner_name": o["owner_name"],
                                  "team_name": o["team_name"], "by_era": {"sf": o["by_era"]["sf"]}}
    scout_path = OUT_DIR / "auction_scouting.json"
    if scout_path.exists():
        try:
            s = json.loads(scout_path.read_text())
            payload["scouting"] = {
                "cards": s.get("cards"),
                "verdicts": [{"fid": v.get("fid"), "confidence": v.get("confidence"), "flags": v.get("flags", [])}
                             for v in (s.get("verdicts") or [])],
                "verification": s.get("verification"),
            }
        except Exception as e:
            print(f"  (scouting load failed: {e})", file=sys.stderr)
    doc_path = REPO / "docs" / "auction" / "analysis_v6_war_room.md"
    if doc_path.exists():
        payload["doc_md"] = doc_path.read_text()
    blob = json.dumps(payload).replace("'", "''")
    ts = int(time.time())
    worker_dir = REPO / "worker"
    tmp = worker_dir / ".tmp"; tmp.mkdir(parents=True, exist_ok=True)
    sql_path = tmp / "auction_intel_upsert.sql"
    sql_path.write_text(
        f"INSERT OR REPLACE INTO ups_auction_intel (id, payload, updated_at) VALUES (1, '{blob}', {ts});\n")
    print(f"  pushing intel blob to D1 ({len(blob)} bytes) …", file=sys.stderr)
    subprocess.run(["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
                    "--remote", "--file", str(sql_path)], cwd=str(worker_dir), check=True)
    print("  pushed ups_auction_intel", file=sys.stderr)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--db", default=None, help="SQLite with transactions_auction (default: in-repo archive)")
    ap.add_argument("--push-d1", action="store_true", help="upsert the combined intel blob to D1 ups_auction_intel")
    args = ap.parse_args()

    db_path, _ = resolve_db(args.db)
    conn = sqlite3.connect(db_path)

    enriched: list[dict] = []          # per-bid rows for the CSV
    lots: list[dict] = []              # per-lot summary
    # per-franchise action timeline (ts, season, player_id, took_lead) for post-win snipe
    actions_by_fid: dict[str, list] = defaultdict(list)
    wins_by_fid: dict[str, list] = defaultdict(list)
    names: dict[str, dict] = {}        # fid -> {owner, team} (latest seen)

    for season, pid, evs in load_lots(conn):
        close_ts = max((e["unix_timestamp"] or 0) for e in evs)
        opener = next((e for e in evs if e["initialbid_ind"]), evs[0])
        winner_ev = next((e for e in evs if e["finalbid_ind"]), evs[-1])
        win_k = fnum(winner_ev["bid_amount"]) / 1000.0
        winner_fid = pad4(winner_ev["franchise_id"])
        leader = None
        runner_up_fid = None           # last forcing fid before the final = pushed winner highest
        winner_first_ts = None
        distinct_bidders = set()

        for e in evs:
            fid = pad4(e["franchise_id"])
            forcing = pad4(e["franchise_forcing_id"]) if e["franchise_forcing_id"] else ""
            actor = forcing if (e["forced_bid_ind"] and forcing) else fid
            if e["owner_name"]:
                names[fid] = {"owner": e["owner_name"], "team": e["team_name"]}
            if forcing and e["franchise_forcing_id"]:
                names.setdefault(forcing, {"owner": None, "team": None})
            distinct_bidders.add(actor)
            ts = e["unix_timestamp"] or 0
            ssp = e["seconds_since_prev_bid"]
            t_rem = None if (e["initialbid_ind"] or ssp is None) else max(0.0, LOCK_WINDOW_H - fnum(ssp) / 3600.0)
            t_to_close = (close_ts - ts) / 3600.0 if close_ts else None
            leader_after = pad4(e["franchise_currentbid_id"]) if e["franchise_currentbid_id"] else leader
            is_overtake = bool((not e["forced_bid_ind"]) and (not e["initialbid_ind"])
                               and leader and leader_after and leader_after != leader)
            victim = leader if is_overtake else ""
            if actor == winner_fid and winner_first_ts is None:
                winner_first_ts = ts
            if e["forced_bid_ind"] and forcing:
                runner_up_fid = forcing
            enriched.append({
                "season": season, "player_id": pid, "player": e["player_name"],
                "pos": (e["position"] or "").upper(), "actor_fid": actor,
                "owner": names.get(actor, {}).get("owner") or e["owner_name"],
                "bid_k": round(fnum(e["bid_amount"]) / 1000.0, 1), "seq": e["bid_sequence"],
                "hour_et": hour_et(e["time_et"], e["datetime_et"]),
                "t_remaining_h": None if t_rem is None else round(t_rem, 2),
                "t_to_close_h": None if t_to_close is None else round(t_to_close, 2),
                "forced": int(bool(e["forced_bid_ind"])), "is_overtake": int(is_overtake),
                "victim_fid": victim, "is_final": int(bool(e["finalbid_ind"])),
            })
            # action timeline (real proxy submissions; skip the opener)
            if not e["initialbid_ind"]:
                actions_by_fid[actor].append({"ts": ts, "season": season, "pid": pid,
                                              "took_lead": is_overtake or actor == winner_fid,
                                              "t_rem": t_rem})
            leader = leader_after

        # winner "entered late" = their first action on the lot was within 8h of close
        winner_late = (winner_first_ts is not None and close_ts
                       and (close_ts - winner_first_ts) / 3600.0 <= 8.0)
        if runner_up_fid is None:
            others = [b for b in distinct_bidders if b and b != winner_fid]
            runner_up_fid = others[-1] if others else ""
        wins_by_fid[winner_fid].append({"ts": close_ts, "season": season, "pid": pid, "win_k": win_k})
        lots.append({
            "season": season, "player_id": pid, "player": winner_ev["player_name"],
            "pos": (winner_ev["position"] or "").upper(), "nfl": winner_ev["nfl_team"],
            "win_k": win_k, "winner_fid": winner_fid, "nominator_fid": pad4(opener["franchise_id"]),
            "runner_up_fid": runner_up_fid, "n_bids": len(evs),
            "n_bidders": len([b for b in distinct_bidders if b]),
            "winner_late": winner_late, "close_ts": close_ts,
        })

    # ---------- per-owner profiles per era ----------
    def in_era(season, era): lo, hi = ERAS[era]; return lo <= season <= hi
    fids = sorted(set(l["winner_fid"] for l in lots) | set(actions_by_fid) | set(wins_by_fid))
    owners = {}
    for fid in fids:
        if not fid: continue
        prof = {"franchise_id": fid, "owner_name": names.get(fid, {}).get("owner"),
                "team_name": names.get(fid, {}).get("team"), "by_era": {}}
        for era in ("sf", "l5"):
            ebids = [b for b in enriched if b["actor_fid"] == fid and in_era(b["season"], era)]
            ewins = [l for l in lots if l["winner_fid"] == fid and in_era(l["season"], era)]
            erunner = [l for l in lots if l["runner_up_fid"] == fid and l["winner_fid"] != fid and in_era(l["season"], era)]
            n_bids = len(ebids)
            hours = [0] * 24
            for b in ebids:
                if b["hour_et"] is not None: hours[b["hour_et"]] += 1
            late = {}
            timed = [b for b in ebids if b["t_remaining_h"] is not None]
            for th in LATE_THRESHOLDS_H:
                late[f"under{int(th)}h"] = round(
                    sum(1 for b in timed if b["t_remaining_h"] <= th) / len(timed), 3) if timed else 0.0
            overtakes = [b for b in ebids if b["is_overtake"]]
            # PRESSURE / aggression. Forced-bid events are attributed to the FORCER
            # (enriched actor_fid = franchise_forcing_id on forced rows, line ~188),
            # so a franchise's ebids already contain every bid it forced someone up on.
            # overtake_rate below counts ONLY successful manual lead-changes and
            # silently drops these force attempts, understating heavy forcers who
            # bump opponents but rarely take the lead themselves (a lurker reads as
            # "passive" on overtake_rate). pressure_rate = forces per lot entered
            # surfaces that. A forcing-only participation still counts the lot, since
            # the forced row itself is the forcer's participation record.
            forces = [b for b in ebids if b["forced"]]
            elots = set((b["season"], b["player_id"]) for b in ebids)
            # post-win snipe: after each win, an action on ANOTHER lot within the window
            acts = sorted(actions_by_fid.get(fid, []), key=lambda a: a["ts"])
            pounced, followups = 0, 0
            for w in ewins:
                wt = w["close_ts"]
                hits = [a for a in acts if a["ts"] and wt and wt < a["ts"] <= wt + POST_WIN_WINDOW_H * 3600
                        and not (a["season"] == w["season"] and a["pid"] == w["player_id"])]
                if hits: pounced += 1
                followups += len(hits)
            # zone + position lean of their wins
            zones = {"capfree": 0, "low": 0, "mid": 0, "marquee": 0}
            pos_spend = defaultdict(float)
            for w in ewins:
                zones[zone_of(w["win_k"])] += 1
                pos_spend[w["pos"]] += w["win_k"]
            nz = len(ewins) or 1
            prof["by_era"][era] = {
                "n_bids": n_bids, "n_wins": len(ewins),
                "total_k": round(sum(w["win_k"] for w in ewins), 1),
                "hour_hist": hours,
                "peak_hours_et": [h for h, _ in sorted(enumerate(hours), key=lambda x: -x[1])[:3] if _ > 0] if n_bids else [],
                "late_bid_share": late,
                "overtake_rate": round(len(overtakes) / n_bids, 3) if n_bids else 0.0,
                "late_overtake_n": sum(1 for b in overtakes if b["t_remaining_h"] is not None and b["t_remaining_h"] <= 8.0),
                "lots_entered": len(elots),
                "force_attempts": len(forces),
                "pressure_rate": round(len(forces) / len(elots), 3) if elots else 0.0,
                "late_force_n": sum(1 for b in forces if b["t_remaining_h"] is not None and b["t_remaining_h"] <= 8.0),
                "runner_up_n": len(erunner),
                "lurk_win_n": sum(1 for w in ewins if w["winner_late"]),
                "post_win_pounce_share": round(pounced / len(ewins), 3) if ewins else 0.0,
                "post_win_avg_followups": round(followups / len(ewins), 2) if ewins else 0.0,
                "zone_mix": {z: round(zones[z] / nz, 3) for z in zones},
                "pos_spend_k": {p: round(v, 1) for p, v in sorted(pos_spend.items(), key=lambda x: -x[1])},
                "marquee_wins": sum(1 for w in ewins if w["win_k"] >= 18),
                "max_win_k": round(max((w["win_k"] for w in ewins), default=0.0), 1),
            }
        owners[fid] = prof

    # ---------- head-to-head vs the commish (0008), SF era ----------
    # Of lots where BOTH 0008 and an opponent bid (actor), who won?
    COMMISH = "0008"
    bidders = defaultdict(set)
    for b in enriched:
        if in_era(b["season"], "sf"):
            bidders[(b["season"], b["player_id"])].add(b["actor_fid"])
    winner_of = {(l["season"], l["player_id"]): l["winner_fid"] for l in lots}
    h2h = {}
    for fid in fids:
        if not fid or fid == COMMISH: continue
        kw = ow = 0
        for key, bs in bidders.items():
            if COMMISH in bs and fid in bs:
                w = winner_of.get(key)
                if w == COMMISH: kw += 1
                elif w == fid: ow += 1
        if kw or ow:
            h2h[fid] = {"commish_w": kw, "opp_w": ow, "shared": kw + ow}

    # ---------- contender roster benchmark (top-2 all-play per season, SF era) ----------
    bench_rows = []
    try:
        for season in range(2022, 2026):
            top = conn.execute(
                "SELECT franchise_name, owner_name, allplay_w, allplay_l, allplay_pct, pf "
                "FROM standings WHERE season=? ORDER BY allplay_pct DESC LIMIT 2", (season,)).fetchall()
            for i, r in enumerate(top):
                bench_rows.append({"season": season, "rank": i + 1, "team": r[0], "owner": r[1],
                                   "allplay_w": r[2], "allplay_l": r[3], "allplay_pct": r[4],
                                   "pf": round(float(r[5]), 1) if r[5] is not None else None})
    except Exception as e:
        print(f"  (benchmark query skipped: {e})", file=sys.stderr)
    pfs = [r["pf"] for r in bench_rows if r["pf"]]
    benchmark = {"top2_by_season": bench_rows,
                 "pf_bar": round(sum(pfs) / len(pfs), 0) if pfs else None,
                 "pf_min": round(min(pfs), 0) if pfs else None, "pf_max": round(max(pfs), 0) if pfs else None}

    # ---------- league summary + position thresholds (SF era, contested ≥2 bids, $1K excl) ----------
    def pctile(vals, p):
        if not vals: return None
        s = sorted(vals); i = min(len(s) - 1, max(0, round(p / 100 * (len(s) - 1))))
        return round(s[i], 1)
    sf_wins = [l for l in lots if in_era(l["season"], "sf") and l["n_bids"] >= 2 and l["win_k"] >= 2]
    pos_thr = {}
    by_pos = defaultdict(list)
    for l in sf_wins: by_pos[l["pos"]].append(l["win_k"])
    for pos, vals in by_pos.items():
        pos_thr[pos] = {"n": len(vals), "p50": pctile(vals, 50), "p75": pctile(vals, 75),
                        "p90": pctile(vals, 90), "p95": pctile(vals, 95), "max": round(max(vals), 1)}
    top_wins = sorted([l for l in lots if in_era(l["season"], "l5")], key=lambda l: -l["win_k"])[:20]
    league = {
        "position_thresholds_sf": pos_thr,
        "zones_sf": {z: round(sum(1 for l in sf_wins if zone_of(l["win_k"]) == z) / (len(sf_wins) or 1), 3)
                     for z in ("capfree", "low", "mid", "marquee")},
        "median_win_k_sf": pctile([l["win_k"] for l in sf_wins], 50),
        "n_contested_sf": len(sf_wins),
        "top_wins_l5": [{"season": l["season"], "player": l["player"], "pos": l["pos"], "win_k": l["win_k"],
                         "winner_fid": l["winner_fid"], "nominator_fid": l["nominator_fid"],
                         "runner_up_fid": l["runner_up_fid"], "n_bids": l["n_bids"]} for l in top_wins],
        "h2h_vs_commish": h2h,
        "contender_benchmark": benchmark,
    }

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    # CSV
    import csv
    csv_path = OUT_DIR / "bids_enriched.csv"
    with open(csv_path, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(enriched[0].keys()))
        w.writeheader(); w.writerows(enriched)
    # JSON
    intel = {
        "meta": {"source_db": Path(db_path).name, "lock_window_h": LOCK_WINDOW_H,
                 "post_win_window_h": POST_WIN_WINDOW_H, "eras": ERAS,
                 "n_bids": len(enriched), "n_lots": len(lots),
                 "seasons": sorted(set(l["season"] for l in lots))},
        "league": league, "owners": owners,
    }
    json_path = OUT_DIR / "auction_intel.json"
    with open(json_path, "w") as f:
        json.dump(intel, f, indent=2)

    print(f"wrote {csv_path.relative_to(REPO)} ({len(enriched)} bids)", file=sys.stderr)
    print(f"wrote {json_path.relative_to(REPO)} ({len(owners)} owners, {len(lots)} lots)", file=sys.stderr)

    if args.push_d1:
        push_d1(intel)


if __name__ == "__main__":
    main()
