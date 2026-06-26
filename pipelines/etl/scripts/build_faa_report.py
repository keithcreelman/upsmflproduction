#!/usr/bin/env python3
"""FAA REPORT — every Free-Agent-Auction win since 2020, x-referenced to the contract it became.

One row per FAA win (player, win-season, winning franchise). For each we reconstruct the CONTRACT
LINEAGE from the event chain (auction win → MYAC/extension → trades → cut/expiry/active), following
the player across teams until the next re-auction or until he leaves a roster, and compute:

  • AUCTION VALUE  — the winning bid (= Year-1 salary).
  • CONTRACT in REAL dollars — realized_k = Σ the actual cap salary paid each season across the lineage
    (Henry: $94K '23 + $18K '24 + $50K '25 + $44K '26 committed = $206K across 4 teams). vs TCV-now.
  • PRODUCTION — PPG + games played (this league's MFL scoring) and games-as-%-of-contract-length.
  • TENURE — length under contract in MFL/NFL league WEEKS and in raw calendar DAYS.
  • #teams associated, #extensions, still-active?, end reason.
  • LEAGUE SETTINGS that year (Superflex from 2022, TE-Premium 2025, the 2021 pre-SF QB-bump flag) —
    so a 2020 win reads in context — plus a cross-year-normalized VALUE INDEX (vidx) that neutralizes
    the SF/TEP price inflation by judging each win against its own position×season cohort.

Everything is read from the archived per-bid SQLite (transactions_auction, player_weeklyscoringresults,
rosters_weekly, rosters_current, transactions_adddrop) — no live D1 read needed. --push-d1 upserts a
COLUMNAR lean blob (parallel arrays, no repeated keys → fits the ~100KB single-statement cap) into
ups_faa_report, served commish-gated by GET /api/auction/faa-report.
"""
from __future__ import annotations
import argparse, gzip, json, re, shutil, sqlite3, statistics, subprocess, sys, tempfile, time
from datetime import date, datetime
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
WORKER = REPO / "worker"
ARCHIVE_GZ = REPO / "data" / "db-archives" / "mfl_database_2026-06-05.db.gz"
WINDOW_START = 2020
LAST_PLAYED_SEASON = 2025          # seasons with weekly scores; 2026 is the upcoming (committed) season
CURRENT_SEASON = 2026

# ── per-season league settings (the context Keith stressed; cross-validated vs metadata_starters) ──
# SF from 2022; TE-Premium (TE 1.5 PPR) from 2025; 2021 = the pre-SF QB front-run year (Dak $45K = 5× '19).
SETTINGS = {
    2020: {"sf": 0, "tep": 0, "qb": "1",   "starters": 17, "weeks": 16},
    2021: {"sf": 0, "tep": 0, "qb": "1",   "starters": 17, "weeks": 17, "qbbump": 1},
    2022: {"sf": 1, "tep": 0, "qb": "1-2", "starters": 18, "weeks": 17},
    2023: {"sf": 1, "tep": 0, "qb": "1-2", "starters": 18, "weeks": 17},
    2024: {"sf": 1, "tep": 0, "qb": "1-2", "starters": 18, "weeks": 17},
    2025: {"sf": 1, "tep": 1, "qb": "1-2", "starters": 18, "weeks": 17},
    2026: {"sf": 1, "tep": 1, "qb": "1-2", "starters": 18, "weeks": 17},
}
SEASON_WEEKS = {y: SETTINGS[y]["weeks"] for y in SETTINGS}

TCV_RX = re.compile(r"TCV\s+(\d+)\s*K", re.I)
CL_RX = re.compile(r"CL\s+(\d+)", re.I)
EXT_RX = re.compile(r"Ext[.:]\s*([A-Za-z0-9]+)", re.I)   # 'Ext:' (2021+) or 'Ext.' (pre-2021)


def pad4(v) -> str:
    s = str(v if v is not None else "").strip()
    return s.zfill(4) if s.isdigit() else s


def resolve_db(arg_db):
    if arg_db:
        return arg_db
    for cand in ("ups_faa_report.db", "ups_auction_canon.db"):
        p = Path(tempfile.gettempdir()) / cand
        if p.exists():
            return str(p)
    if not ARCHIVE_GZ.exists():
        sys.exit(f"FATAL: no --db and archive missing at {ARCHIVE_GZ}")
    out = Path(tempfile.gettempdir()) / "ups_faa_report.db"
    print(f"decompressing {ARCHIVE_GZ.name} → {out} …", file=sys.stderr)
    with gzip.open(ARCHIVE_GZ, "rb") as fi, open(out, "wb") as fo:
        shutil.copyfileobj(fi, fo)
    return str(out)


def med(xs):
    xs = [x for x in xs if x is not None]
    return round(statistics.median(xs), 2) if xs else 0.0


def parse_dt(s):
    s = str(s or "")[:10]
    try:
        return datetime.strptime(s, "%Y-%m-%d").date()
    except ValueError:
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db")
    ap.add_argument("--push-d1", action="store_true")
    ap.add_argument("--limit", type=int, default=0, help="debug: only first N wins")
    args = ap.parse_args()
    conn = sqlite3.connect(resolve_db(args.db))
    conn.row_factory = sqlite3.Row

    # ---- 1. FAA wins (all years, to bound lineages; report only 2020+) ----
    wins = [dict(r) for r in conn.execute("""
        SELECT season, player_id, player_name, position, nfl_team, franchise_id,
               owner_name, bid_amount, forced_bid_ind, unix_timestamp, date_et
        FROM transactions_auction
        WHERE finalbid_ind = 1 AND auction_type = 'FreeAgent'
        ORDER BY season, player_id
    """)]
    win_seasons = {}                                  # pid -> sorted [FreeAgent win seasons] (these become rows)
    for w in wins:
        win_seasons.setdefault(str(w["player_id"]), []).append(int(w["season"]))
    for pid in win_seasons:
        win_seasons[pid] = sorted(set(win_seasons[pid]))

    # ANY auction win (FreeAgent + Tag + ExpiredRookie + …) ends a prior contract — a re-auction/tag is a
    # NEW deal. Used to bound a lineage so e.g. Ekeler's '22 FA deal doesn't bleed into his '23 TAG.
    boundary_seasons = {}                             # pid -> sorted [all auction win seasons]
    for r in conn.execute("SELECT DISTINCT player_id, season FROM transactions_auction WHERE finalbid_ind = 1"):
        boundary_seasons.setdefault(str(r["player_id"]), []).append(int(r["season"]))
    for pid in boundary_seasons:
        boundary_seasons[pid] = sorted(set(boundary_seasons[pid]))

    # ---- 2. per-(pid,season) production + ownership + salary (player_weeklyscoringresults) ----
    season_agg = {}                                  # (pid,season) -> {sal, teams:set, gp, pts, reg_pts, reg_gp, wks:set}
    for r in conn.execute("""
        SELECT player_id, season, week, score, is_reg, salary, roster_franchise_id, roster_status
        FROM player_weeklyscoringresults
        WHERE season BETWEEN ? AND ? AND score IS NOT NULL
    """, (WINDOW_START, LAST_PLAYED_SEASON)):
        k = (str(r["player_id"]), int(r["season"]))
        a = season_agg.setdefault(k, {"rostered_by": set(), "sal_by_fid": {}, "gp": 0, "pts": 0.0, "reg_pts": 0.0, "reg_gp": 0, "wks": set()})
        sc = float(r["score"]); a["gp"] += 1; a["pts"] += sc; a["wks"].add(int(r["week"]))
        if int(r["is_reg"] or 0) == 1:
            a["reg_pts"] += sc; a["reg_gp"] += 1
        # franchises that actually ROSTERED him (ROSTER/IR/TAXI) — NOT free-agent weeks; used to follow the
        # contract lineage AND to read the salary THIS lineage carried (a global MAX would wrongly pick up a
        # different franchise's contract for the same player in the same year — e.g. Stidham won $1 by 0007
        # but shown on 0011's $38K deal).
        fid = pad4(r["roster_franchise_id"]) if r["roster_franchise_id"] else ""
        if fid and fid != "FA" and str(r["roster_status"] or "") != "FA":
            a["rostered_by"].add(fid)
            if r["salary"] is not None:
                a["sal_by_fid"][fid] = max(a["sal_by_fid"].get(fid, 0), int(r["salary"]))

    # ---- 3. wk1 contract_info per (pid,season) for TCV/CL/Ext shape (the lineage's owning team) ----
    ci_map = {}                                      # (pid,season) -> {tcv, cl, ext_token, sal}
    for r in conn.execute("""
        SELECT player_id, season, salary, contract_year, contract_info
        FROM rosters_weekly WHERE week = 1 AND season BETWEEN ? AND ?
    """, (WINDOW_START, LAST_PLAYED_SEASON)):
        info = str(r["contract_info"] or "")
        tm, cm, em = TCV_RX.search(info), CL_RX.search(info), EXT_RX.search(info)
        ci_map[(str(r["player_id"]), int(r["season"]))] = {
            "tcv": int(tm.group(1)) if tm else None,
            "cl": int(cm.group(1)) if cm else None,
            "ext": em.group(1) if em else None,
            "sal": int(r["salary"]) if r["salary"] is not None else None,
            "cy": int(r["contract_year"]) if r["contract_year"] not in (None, "") and str(r["contract_year"]).lstrip("-").isdigit() else None,
        }

    # ---- 4. rosters_current → the CURRENT (2026 upcoming) roster only. rosters_current holds BOTH a
    # 2025-wk17 end-of-season snapshot AND the real 2026-wk1 roster; filtering to season=2026 is what makes
    # "still active" correct (a player only in the 2025 snapshot expired after 2025, he is NOT on a 2026 roster).
    current = {}                                     # pid -> {fid, sal, tcv_k, cl, ext_flag}
    for r in conn.execute("SELECT player_id, franchise_id, salary, contract_length, tcv, extension_flag FROM rosters_current WHERE season = ?", (CURRENT_SEASON,)):
        pid = str(r["player_id"])
        current[pid] = {
            "fid": pad4(r["franchise_id"]),
            "sal": int(r["salary"]) if r["salary"] is not None else 0,
            "tcv_k": round(int(r["tcv"]) / 1000) if r["tcv"] not in (None, "") and str(r["tcv"]).isdigit() else None,
            "cl": int(r["contract_length"]) if r["contract_length"] not in (None, "") and str(r["contract_length"]).isdigit() else None,
            "ext": 1 if str(r["extension_flag"] or "").strip() not in ("", "0", "None") else 0,
        }

    # ---- 5. drops (cut detection) — carry the dropping franchise so we can require it belongs to the lineage ----
    drops = {}                                       # pid -> [(season, date, fid)]
    for r in conn.execute("SELECT player_id, season, date_et, franchise_id, move_type FROM transactions_adddrop WHERE move_type='DROP'"):
        drops.setdefault(str(r["player_id"]), []).append((int(r["season"]), str(r["date_et"] or ""), pad4(r["franchise_id"])))

    # ---- 5b. trades (clean "teams associated under this contract" = won team + trade RECEIVERS in window) ----
    trades = {}                                      # pid -> [(date 'YYYY-MM-DD', receiver_fid)]
    for r in conn.execute("SELECT player_id, franchise_id, date_et FROM transactions_trades WHERE asset_type='PLAYER' AND asset_role='ACQUIRE'"):
        trades.setdefault(str(r["player_id"]), []).append((str(r["date_et"] or "")[:10], pad4(r["franchise_id"])))

    # ---- team name map (latest team_name per franchise) ----
    teams = {}
    for r in conn.execute("SELECT franchise_id, team_name, season FROM transactions_auction ORDER BY season"):
        teams[pad4(r["franchise_id"])] = r["team_name"]

    today = date.today()
    rows = []
    for w in wins:
        ws = int(w["season"])
        if ws < WINDOW_START:
            continue
        pid = str(w["player_id"]); wfid = pad4(w["franchise_id"])
        won_d = parse_dt(w["date_et"]) or date(ws, 8, 1)
        won_iso = won_d.isoformat()
        nexts = [s for s in boundary_seasons.get(pid, []) if s > ws]
        next_win = min(nexts) if nexts else 9999      # next re-auction/tag of ANY type = hard contract boundary

        # ---- lineage = follow the CONTRACT (win franchise + trades), bounded by its LENGTH. The deal runs
        # cy_win years (the win-year contract_year). An EXTENSION resets the remaining years UP (contract_year
        # stops decrementing / jumps), continuing the SAME deal. Once the years are spent with no extension the
        # contract expired — a later roster spot is a NEW deal (re-sign/tag), not this one. Keeps legit
        # multi-year runs (Love CL-3 + ext) while stopping 1-yr deals (CMC, Ekeler) from bleeding into the next. ----
        owners = {wfid} | {to for (dt, to) in trades.get(pid, []) if dt and dt >= won_iso}
        cy_win = (ci_map.get((pid, ws), {}) or {}).get("cy")
        if not cy_win:                                 # win-year sometimes a shell → infer the length from next season
            nxt = (ci_map.get((pid, ws + 1), {}) or {})
            cy_win = (nxt.get("cy", 0) + 1) if (nxt.get("cy") and (ws + 1) < next_win) else 1
        lineage = []
        remaining = cy_win
        s = ws
        while s < next_win and s <= CURRENT_SEASON:
            if s == CURRENT_SEASON:
                held = pid in current and current[pid]["fid"] in owners
            else:
                rb = season_agg.get((pid, s), {}).get("rostered_by", set())
                held = (s == ws) or bool(rb & owners)
            if not held:
                break
            if s > ws:
                if remaining <= 0:
                    break                              # prior season was the last contracted year → expired
                cy_s = (ci_map.get((pid, s), {}) or {}).get("cy")
                if cy_s and cy_s > remaining:
                    remaining = cy_s                   # mid-contract extension → the deal got longer
            lineage.append(s)
            remaining -= 1
            s += 1
        if not lineage:
            lineage = [ws]

        played = [s for s in lineage if s <= LAST_PLAYED_SEASON]
        # PAID = real cap charged for seasons already PLAYED. COMMITTED = + future committed years (e.g. the
        # 2026 salary of an active multi-year deal — owed but not yet played, so it must NOT depress $-per-point).
        paid = committed = 0; gp = tot = reg_pts = 0.0; gp = 0; reg_gp = 0
        ext_tokens = set(); tcv_seq = []
        for s in lineage:
            if s == CURRENT_SEASON and pid in current:
                committed += current[pid]["sal"]       # 2026 = committed, not yet played → excluded from PAID
                if current[pid]["tcv_k"]: tcv_seq.append((s, current[pid]["tcv_k"]))
                if current[pid]["ext"]: ext_tokens.add("cur")
                continue
            a = season_agg.get((pid, s))
            ci = ci_map.get((pid, s))
            # salary the LINEAGE owners actually carried that season (per-franchise, not a polluted global MAX)
            sal_s = max([(a.get("sal_by_fid", {}) if a else {}).get(f, 0) for f in owners], default=0)
            if s == ws and not sal_s:                 # winner not in the scoring table → the bid is the cap charge
                sal_s = int(w["bid_amount"] or 0)
            # win year of a SINGLE-year deal: floor at the bid (archive sometimes stores a $1K placeholder).
            # Only for 1-season lineages — a multi-year deal can back-load Y1 below the bid.
            if s == ws and len(lineage) == 1:
                sal_s = max(sal_s, int(w["bid_amount"] or 0))
            paid += sal_s; committed += sal_s
            if a:
                gp += a["gp"]; tot += a["pts"]; reg_pts += a["reg_pts"]; reg_gp += a["reg_gp"]
            if ci:
                if ci["ext"]: ext_tokens.add(ci["ext"])
                if ci["tcv"]: tcv_seq.append((s, ci["tcv"]))

        bid_k = round(int(w["bid_amount"] or 0) / 1000)
        realized_k = round(paid / 1000)               # headline "real $" = actually PAID (played seasons only)
        committed_k = round(committed / 1000)         # + future committed (active multi-year deals)
        # TCV-now: structured current tcv if active else last parsed tcv else bid
        tcv_now_k = tcv_seq[-1][1] if tcv_seq else bid_k
        cl = (current[pid]["cl"] if pid in current and current[pid].get("cl") else
              (ci_map.get((pid, lineage[-1] if lineage[-1] <= LAST_PLAYED_SEASON else lineage[-1]-1), {}) or {}).get("cl")) or len(lineage)
        # extensions: distinct Ext: tokens + count of TCV step-ups across the lineage
        tcv_steps = sum(1 for i in range(1, len(tcv_seq)) if tcv_seq[i][1] > tcv_seq[i - 1][1])
        n_ext = max(len([t for t in ext_tokens if t != "cur"]), tcv_steps)
        if pid in current and current[pid]["ext"] and n_ext == 0:
            n_ext = 1

        # production
        ppg = round(tot / gp, 1) if gp else 0.0
        ppg_reg = round(reg_pts / reg_gp, 1) if reg_gp else 0.0
        cgames = sum(SEASON_WEEKS.get(s, 17) for s in played)
        gpct = round(gp / cgames, 3) if cgames else 0.0

        # still active = the contract LINEAGE itself reached the current season (a lineage-owning team
        # still rosters him). NOT "latest win + on any roster" — a cut player re-acquired later under a
        # different deal would falsely read active.
        active = 1 if CURRENT_SEASON in lineage else 0
        if active:
            end_reason, end_dt = "active", today.isoformat()
        elif next_win != 9999:
            end_reason = "expired"                     # became FA → re-auctioned
            nd = next((parse_dt(x["date_et"]) for x in wins if str(x["player_id"]) == pid and int(x["season"]) == next_win), None)
            end_dt = (nd or date(next_win, 8, 1)).isoformat()
        else:
            # a real cut = a DROP that is (a) after the auction win and (b) by a franchise in the lineage —
            # NOT a stale same-year pre-auction drop by some other team (that produced "cut, days=0" rows).
            cand = []
            for (ds, dd, dfid) in drops.get(pid, []):
                pdd = parse_dt(dd)
                if ds >= lineage[-1] and pdd and pdd > won_d:
                    cand.append((pdd, dfid))
            cand.sort()
            own_cut = [c for c in cand if c[1] in owners]
            pick = (own_cut or cand)[0] if (own_cut or cand) else None
            if pick:
                end_reason = "cut"; end_dt = pick[0].isoformat()
            else:
                end_reason = "expired"; end_dt = date(min(lineage[-1] + 1, CURRENT_SEASON), 2, 1).isoformat()

        end_d = parse_dt(end_dt) or today
        days = max((end_d - won_d).days, 0)
        # teams associated = winning franchise + every franchise that ACQUIRED him via trade during this
        # contract's window [won, end] (the trade chain — NOT waiver re-adds, which would be a new contract)
        recv = {rc for (dt, rc) in trades.get(pid, []) if dt and won_iso <= dt <= end_dt}
        n_teams = len({wfid} | recv)
        # league weeks under contract = full weeks of each PLAYED lineage season (offseason 2026 adds 0)
        lweeks = sum(SEASON_WEEKS.get(s, 17) for s in played)

        st = SETTINGS.get(ws, SETTINGS[2025])
        rows.append({
            "n": w["player_name"], "pid": pid, "pos": w["position"], "nfl": w["nfl_team"],
            "ws": ws, "wfid": wfid, "own": w["owner_name"],
            "sf": st["sf"], "tep": st["tep"], "qbbump": st.get("qbbump", 0), "qb": st["qb"],
            "bid_k": bid_k, "forced": int(w["forced_bid_ind"] or 0), "won_dt": won_d.isoformat(),
            "tcv_k": tcv_now_k, "cl": cl, "realized_k": realized_k, "committed_k": committed_k,
            "n_ext": n_ext, "n_teams": n_teams, "active": active, "end_reason": end_reason, "end_dt": end_dt,
            "gp": gp, "ppg": ppg, "ppg_reg": ppg_reg, "cgames": cgames, "gpct": gpct,
            "lweeks": lweeks, "days": days, "tot": round(tot, 1),
        })
        if args.limit and len(rows) >= args.limit:
            break

    # ---- cohort medians for the cross-year-normalized value index ----
    # Production is measured as a RATE (PPG), not career total — so a multi-year keep doesn't auto-out-value
    # a 1-year rental (which made Love's 4-season total dwarf the mostly-1-year QB cohort). Cheap-but-
    # productive still ranks high; longevity no longer inflates it.
    base_bid, base_ppg = {}, {}
    by_cohort = {}
    for r in rows:
        by_cohort.setdefault((r["pos"], r["ws"]), []).append(r)
    for (pos, season), rs in by_cohort.items():
        base_bid.setdefault(pos, {})[season] = med([x["bid_k"] for x in rs])
        base_ppg.setdefault(pos, {})[season] = med([x["ppg"] for x in rs if x["gp"] > 0])
    for r in rows:
        bb = base_bid.get(r["pos"], {}).get(r["ws"], 0) or 0
        bp = base_ppg.get(r["pos"], {}).get(r["ws"], 0) or 0
        # price vs that year's positional median, FLOORED at 0.15 so sub-$2 lottery wins (49% of rows pay $1K)
        # don't explode vidx via a near-zero divisor and swamp the "best value" ranking — a genuine elite like
        # Love still tops on production; a 1-week $1 streamer no longer outranks a $5 multi-year star on price alone.
        pvm = max(r["bid_k"] / bb, 0.15) if bb else None
        pidx = (r["ppg"] / bp) if bp else None                      # production RATE (PPG) vs that year's positional median
        r["prod_idx"] = round(pidx, 2) if pidx is not None else None  # RAW production vs cohort — PRICE-INDEPENDENT
        r["ptier"] = ("ELITE" if pidx and pidx >= 1.6 else "GOOD" if pidx and pidx >= 1.05
                      else "AVG" if pidx and pidx >= 0.7 else "LOW")
        r["ppr_real"] = round(r["tot"] / r["realized_k"], 2) if r["realized_k"] else 0.0
        r["ppr_bid"] = round(r["tot"] / r["bid_k"], 2) if r["bid_k"] else 0.0
        r["vidx"] = round(pidx / pvm, 2) if (pvm and pidx is not None and pvm > 0) else None
        # verdict combines PRODUCTION and VALUE so an elite-but-expensive stud (CMC: 26 PPG, premium price)
        # reads "PRICEY", not "BUST". BUST is reserved for who actually FLOPPED (low production).
        pi, v = pidx, r["vidx"]
        if pi is None or v is None:
            r["vlab"] = "—"
        elif pi < 0.7:
            r["vlab"] = "BUST"                                       # didn't produce — a real flop, regardless of price
        elif v >= 1.5:
            r["vlab"] = "STEAL"
        elif v >= 1.15:
            r["vlab"] = "VALUE"
        elif v >= 0.75:
            r["vlab"] = "FAIR"
        else:
            r["vlab"] = "PRICEY"                                     # produced, but you paid a premium (low surplus)

    rows.sort(key=lambda r: (r["vidx"] is None, -(r["vidx"] or 0)))
    print(f"built {len(rows)} FAA contract rows ({WINDOW_START}-{LAST_PLAYED_SEASON})")

    # ---- COLUMNAR lean blob (parallel arrays — no repeated keys → fits the 100KB statement cap) ----
    COLS = ["n", "pos", "nfl", "ws", "wfid", "own", "sf", "tep", "qbbump", "qb",
            "bid_k", "forced", "won_dt", "tcv_k", "cl", "realized_k", "committed_k", "n_ext", "n_teams",
            "active", "end_reason", "end_dt", "gp", "ppg", "ppg_reg", "cgames", "gpct",
            "lweeks", "days", "tot", "prod_idx", "ptier", "ppr_real", "ppr_bid", "vidx", "vlab"]
    blob = {
        "meta": {
            "built": int(time.time()), "asof": str(today), "window": f"{WINDOW_START}-{LAST_PLAYED_SEASON}",
            "n": len(rows), "settings": SETTINGS, "base_bid": base_bid, "base_ppg": base_ppg, "teams": teams,
            "note": "One row per FAA win. The contract LINEAGE is bounded by its length (contract_year) — a "
                    "1-yr deal is 1 season (CMC, Ekeler); a multi-yr deal + extensions runs its full span (Love, "
                    "Henry). realized_k = cap $ actually PAID for seasons already PLAYED; committed_k adds future "
                    "committed years (e.g. an active deal's 2026) so an unplayed year doesn't depress $-per-point. "
                    "prod_idx = RAW production (PPG) vs the position×season cohort, PRICE-INDEPENDENT (ptier ELITE/"
                    "GOOD/AVG/LOW). vidx = prod_idx ÷ price-vs-cohort (the $-value). vlab: BUST=flopped (low prod), "
                    "PRICEY=produced but premium price, STEAL/VALUE/FAIR otherwise. TCV/ext are event-chain-derived.",
            "key": {"n": "player", "ws": "win_season", "wfid": "winning_franchise", "bid_k": "auction winning bid $K",
                    "tcv_k": "current/last contract TCV $K", "realized_k": "real cap $K PAID (played seasons)",
                    "committed_k": "+ future committed years $K", "n_ext": "extensions (derived)",
                    "n_teams": "franchises that held him under this contract", "ppg": "MFL points/game",
                    "prod_idx": "raw production vs cohort (price-independent)", "ptier": "ELITE/GOOD/AVG/LOW production",
                    "gpct": "games / (played seasons × league weeks)", "lweeks": "league weeks under contract",
                    "days": "calendar days under contract", "ppr_real": "pts per real $K", "ppr_bid": "pts per bid $K",
                    "vidx": "$-value index (SF/TEP-neutral)", "vlab": "STEAL/VALUE/FAIR/PRICEY/BUST"},
        },
        "cols": COLS,
        "data": [[r.get(c) for c in COLS] for r in rows],
    }
    out = REPO / "docs" / "auction" / "data" / "faa_report.json"
    out.write_text(json.dumps(blob, indent=2))
    lean = json.dumps(blob, separators=(",", ":"))
    print(f"wrote {out.relative_to(REPO)}  (lean {len(lean)/1024:.1f}KB)")

    # quick spot-check table
    print("\n=== top values (vidx) ===")
    print(f"  {'player':<20}{'yr':>5}{'pos':>4}{'bid':>5}{'tcvN':>5}{'real':>6}{'ppg':>6}{'gp%':>6}{'tms':>4}{'ext':>4}{'act':>4}{'vidx':>6}")
    for r in rows[:12]:
        print(f"  {str(r['n'])[:19]:<20}{r['ws']:>5}{r['pos']:>4}{r['bid_k']:>5}{r['tcv_k']:>5}{r['realized_k']:>6}"
              f"{r['ppg']:>6}{int(r['gpct']*100):>5}%{r['n_teams']:>4}{r['n_ext']:>4}{('Y' if r['active'] else 'n'):>4}{str(r['vidx']):>6}")

    if args.push_d1:
        # PART-KEYED push: the blob (~184KB) exceeds D1's 100KB single-statement cap, so we split the lean
        # JSON STRING into <90KB chunks (one INSERT each, all < the cap) and the worker concatenates them
        # ORDER BY part → JSON.parse. DELETE first so a shrinking part-count can't leave stale tail rows.
        ts = int(time.time()); CHUNK = 85000
        tmp = WORKER / ".tmp"; tmp.mkdir(parents=True, exist_ok=True)
        parts = [lean[i:i + CHUNK] for i in range(0, len(lean), CHUNK)]
        sql = ["DELETE FROM ups_faa_report;"]
        for i, ch in enumerate(parts):
            stmt = f"INSERT INTO ups_faa_report (part, payload, updated_at) VALUES ({i}, '{ch.replace(chr(39), chr(39) * 2)}', {ts});"
            if len(stmt) > 99500:
                raise SystemExit(f"  ✘ part {i} statement {len(stmt)} bytes > 99.5KB — lower CHUNK.")
            sql.append(stmt)
        sql_path = tmp / "faa_report_upsert.sql"; sql_path.write_text("\n".join(sql) + "\n")
        print(f"\n  pushing faa_report blob to D1 ({len(parts)} parts, {len(lean)/1024:.1f}KB total) …")
        subprocess.run(["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db", "--remote", "--file", str(sql_path)],
                       cwd=str(WORKER), check=True)
        print(f"  pushed ups_faa_report ({len(parts)} parts)")


if __name__ == "__main__":
    main()
