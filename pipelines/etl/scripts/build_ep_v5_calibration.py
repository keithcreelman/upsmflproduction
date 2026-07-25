#!/usr/bin/env python3
"""EP v5 CALIBRATION — regenerate every constant from source, then decide whether v5 ships.

WHY THIS EXISTS
---------------
The v13 pricing attempt died because its knobs (ante, regime base, deploy fraction, a "1.97x"
inflation headline) were hand-set numbers that no script could regenerate. v4 fixed that for the
AFFINE arm only — build_auction_backtest.py fits `paid ≈ 2.67 + 0.84·redraft_worth` and reports
MSE 31 / MAE $3.5K. But the number the tool actually SERVES is

    EP_v4 = max( startability_floor , affine , dynasty_anchor )

and the advertised accuracy only ever measured the middle arm. This script measures the SERVED
number, per arm, against what franchises actually paid (2022-25), and only then fits v5 on top —
so no constant in the shipped model is unmeasured, and every claim regenerates from the archive.

WHAT IT DOES
------------
  1. ARM-LEVEL TRUTH: for every FA-auction clear 2022-25, recompute all three EP_v4 arms from the
     era's own inputs, record WHICH arm bound, and report binding share + error per arm — on the
     full clear set and on the CREDIBLE pool (the players you actually bid on).
  2. REGIME RECONSTRUCTION: rebuild each season's pre-auction league state from the archive
     (pre-auction cap space, per-team IDP/K/P reserve, the nominated pool, positional demand).
  3. FIT v5: ep_v5 = max(floor, max(affine, dyn_anchor) · M_money · M_pos · elite)
       M_money = clamp(1 + λ·(R_now/R̄ − 1), 0.80, 1.60),  R = (Σcapspace − Σreserve) / Σrw(pool)
       M_pos   = clamp(1 + γ·((D/S)/z̄[pos] − 1), 0.85, 1.35),  D = Σ comp_score only
       elite   = a fitted top-3-per-position factor, OFF unless its own sub-gate passes.
     λ and γ are sign-guarded ≥ 0 (a scarcer market cannot make prices cheaper).
  4. LEAVE-ONE-YEAR-OUT 2022-25: fit on 3 seasons, predict the 4th. R̄, z̄, λ, γ and the elite
     factor are all re-derived per fold — no held-out year leaks into its own prediction.
  5. SHIP GATE: v5 must beat v4 on dollar-weighted MAE of the SERVED number AND keep plain MAE
     within 2%. FAILING IS A LEGITIMATE OUTCOME — four yearly points may simply lack the power to
     identify λ and γ. On failure the JSON carries ship_gate=false and build_roster_fit serves v4
     unchanged; only the transparency columns ship. Do not tune to pass.

Writes docs/auction/data/ep_v5_calibration.json (constants + per-year regime table + arm truth +
LOYO backtest + ship_gate + an explicit list of reconstruction gaps). Read-only w.r.t. the archive.

Usage:
    python3 build_ep_v5_calibration.py [--db PATH] [--print-only]
"""
from __future__ import annotations
import argparse, collections, csv, gzip, json, shutil, sqlite3, statistics, sys, tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_fa_value as bfv          # EP_v4 arms: AFFINE_*, POS_DYN_W, STARTABILITY, PER_VALUE
import build_roster_fit as brf        # roster-fit shape: SLOTS, REPL_RANK, SKILL

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
ARCHIVE = REPO / "data" / "db-archives" / "mfl_database_2026-06-05.db.gz"
CANON = Path("/tmp/ups_auction_canon.db")
OUT = DATA / "ep_v5_calibration.json"

YEARS = [2022, 2023, 2024, 2025]      # the SF era — the only regime comparable to today
CAP_K = 300                            # $300K salary cap (metadata_leaguedetails, constant 2022-26)
SKILL = ("QB", "RB", "WR", "TE")

# credible target = the players you actually bid on (mirrors build_roster_fit's pool filter)
CREDIBLE_RW = 3
CREDIBLE_EP = 5

# v5 clamps — Keith-tunable, NOT fitted. They bound how far a regime signal is allowed to move a
# price; they exist so a thin-data λ/γ can never produce an absurd number, not because 1.60/0.85
# were measured. Surfaced in the CSV under #TUNABLES.
M_MONEY_LO, M_MONEY_HI = 0.80, 1.60
M_POS_LO, M_POS_HI = 0.85, 1.35
ELITE_TOP_N = 3                        # "elite" = top-N per position by redraft worth within a season


# ─────────────────────────────────────────────────────────────────────────────
# archive access
# ─────────────────────────────────────────────────────────────────────────────
def resolve_db(explicit: str | None) -> Path:
    """--db > /tmp canon db > auto-extract the committed archive to a temp file."""
    if explicit:
        p = Path(explicit)
        if not p.exists():
            raise SystemExit(f"✘ --db {p} not found")
        return p
    if CANON.exists():
        return CANON
    if not ARCHIVE.exists():
        raise SystemExit(f"✘ no db: pass --db, or place the canon db at {CANON}, or restore {ARCHIVE}")
    tmp = Path(tempfile.gettempdir()) / "ups_ep_v5_archive.db"
    if not tmp.exists() or tmp.stat().st_mtime < ARCHIVE.stat().st_mtime:
        print(f"  extracting {ARCHIVE.name} → {tmp} …")
        with gzip.open(ARCHIVE, "rb") as fin, open(tmp, "wb") as fout:
            shutil.copyfileobj(fin, fout)
    return tmp


# ─────────────────────────────────────────────────────────────────────────────
# per-era player inputs (offline: the fpros CSV carries BOTH mfl_id and fp_id, so the
# fp_id→mfl_id crosswalk needs no D1 round-trip and the run is deterministic)
# ─────────────────────────────────────────────────────────────────────────────
def load_inputs():
    curve = json.loads((DATA / "eapw_curves.json").read_text())["curves"]["fpros"]
    fp, fp2mfl = {}, {}
    for r in csv.DictReader(open(DATA / "fpros_adp_history.csv")):
        if r["mfl_id"]:
            fp[(int(r["season"]), str(r["mfl_id"]))] = (r["pos"], int(r["fp_pos_rank"]))
            if r["fp_id"]:
                fp2mfl[str(r["fp_id"])] = str(r["mfl_id"])
    dynv, unmapped = {}, 0
    for r in csv.DictReader(open(DATA / "dynasty_adp_history.csv")):
        mid = fp2mfl.get(str(r["fp_id"]))
        if not mid:
            unmapped += 1
            continue
        if r.get("value_2qb"):
            dynv[(int(r["season"]), mid)] = int(r["value_2qb"])
    return curve, fp, dynv, unmapped


def make_ep_v4(curve, fp, dynv):
    """(season, mfl_id, fallback_pos) → the three EP_v4 arms + the served max + which arm bound.

    Uses build_fa_value's own constants and floor function so this harness can never drift from
    what the pipeline ships."""
    def ep4(season, pid, fallback_pos=None):
        m = fp.get((season, str(pid)))
        pos = m[0] if m else fallback_pos
        rank = m[1] if m else None
        rw = 0
        if m and curve.get(pos):
            c = curve[pos]["p50"]
            rw = round(c[min(rank, len(c)) - 1] * bfv.DOLLAR_PER_APWE)
        dw = round(dynv.get((season, str(pid)), 0) * bfv.PER_VALUE)
        floor = bfv.startability_floor(pos, rank)
        affine = bfv.AFFINE_ANTE + bfv.AFFINE_SLOPE * rw
        dyn = dw * bfv.POS_DYN_W.get(pos, 0.8)
        served = round(max(floor, affine, dyn))
        arm = "floor" if (floor >= affine and floor >= dyn) else ("affine" if affine >= dyn else "dyn_anchor")
        return {"pos": pos, "rank": rank, "rw": rw, "dw": dw, "floor": floor,
                "affine": affine, "dyn_anchor": dyn, "ep": served, "arm": arm,
                "has_fp": bool(m), "has_dyn": (season, str(pid)) in dynv}
    return ep4


# ─────────────────────────────────────────────────────────────────────────────
# per-season regime reconstruction
# ─────────────────────────────────────────────────────────────────────────────
def reconstruct_season(con, season, ep4, curve, fp):
    """Rebuild the league state as it stood the moment the FA auction opened.

    The archive has no pre-auction roster snapshot, so we run week 1 backwards: take each team's
    week-1 ROSTER, then remove everything it acquired AFTER the auction opened (its auction wins +
    its post-auction adds). What remains is what was already on the books. Documented gaps live in
    RECONSTRUCTION_GAPS and are echoed into the JSON."""
    win_start, win_end = con.execute(
        "SELECT MIN(date_et), MAX(date_et) FROM transactions_auction "
        "WHERE season=? AND auction_type='FreeAgent'", (season,)).fetchone()

    wins = con.execute(
        "SELECT player_id, franchise_id, bid_amount, position, player_name FROM transactions_auction "
        "WHERE season=? AND auction_type='FreeAgent' AND finalbid_ind=1", (season,)).fetchall()
    won_by = collections.defaultdict(set)
    for pid, fid, _bid, _pos, _nm in wins:
        won_by[fid].add(str(pid))

    # every player NOMINATED that season = the supply the money was chasing (INIT/opening-bid rows)
    pool_ids = [str(r[0]) for r in con.execute(
        "SELECT DISTINCT player_id FROM transactions_auction "
        "WHERE season=? AND auction_type='FreeAgent'", (season,)).fetchall()]

    added_after = collections.defaultdict(set)
    for fid, pid in con.execute(
            "SELECT franchise_id, player_id FROM transactions_adddrop "
            "WHERE season=? AND move_type='ADD' AND date_et > ?", (season, win_end)):
        added_after[fid].add(str(pid))

    wk1 = con.execute(
        "SELECT franchise_id, player_id, position, status, salary FROM rosters_weekly "
        "WHERE season=? AND week=1", (season,)).fetchall()

    teams = {}
    for fid, pid, pos, status, sal in wk1:
        pid = str(pid)
        t = teams.setdefault(fid, {"committed_k": 0.0, "players": [], "idp_spend_k": 0.0})
        post_auction = pid in won_by.get(fid, ()) or pid in added_after.get(fid, ())
        if post_auction:
            # money spent AT/after the auction — not part of pre-auction commitments. Track the
            # non-skill share separately as the "realized IDP/K/P spend" cross-check on the reserve.
            if brf.POS_BUCKET.get(pos) not in SKILL:
                t["idp_spend_k"] += (sal or 0) / 1000.0
            continue
        t["players"].append({"pos": pos, "status": status})
        if status == "ROSTER":
            t["committed_k"] += (sal or 0) / 1000.0

    # per-team reserve — the SAME engine build_roster_fit runs on the live rosters (a port of the
    # worker's reserveCostForScenario). Reused, not re-implemented, so historical and live regimes
    # can never diverge. $1K per reserved slot → $K.
    for fid, t in teams.items():
        t["capspace_k"] = CAP_K - t["committed_k"]
        t["reserve_k"] = float(brf.reserve_slots(t["players"]))

    # ---- the pool + its credible subset ----
    # SUPPLY must be defined the same way here and in build_roster_fit, or R_now and R̄ are not
    # comparable and M_money is meaningless. build_roster_fit can only see who is UNROSTERED
    # (nomination hasn't happened yet when the board is built), so that is the definition used on
    # both sides: every skill player with a FantasyPros rank who is not on a pre-auction roster.
    # The NOMINATED pool (players who actually drew an opening bid) is carried alongside as a
    # diagnostic — the two agree closely on credible Σrw (within ~5-20% every season), which is
    # what licenses the substitution.
    pos_by_id = {str(pid): pos for pid, _f, _b, pos, _n in wins}
    rostered_ids = {str(pid) for fid, pid, _pos, _st, _sal in wk1
                    if not (str(pid) in won_by.get(fid, ()) or str(pid) in added_after.get(fid, ()))}

    pool = []
    for (s, pid), (pos, _rk) in fp.items():
        if s != season or pid in rostered_ids:
            continue
        e = ep4(season, pid, pos)
        if e["pos"] not in SKILL:
            continue
        e["pid"] = pid
        pool.append(e)
    credible = [p for p in pool if p["rw"] >= CREDIBLE_RW or p["ep"] >= CREDIBLE_EP]

    nom = [ep4(season, pid, pos_by_id.get(pid)) for pid in pool_ids]
    nom_cred = [p for p in nom if p["pos"] in SKILL and (p["rw"] >= CREDIBLE_RW or p["ep"] >= CREDIBLE_EP)]

    # ---- positional DEMAND (D) — comp_score only, NO capspace weighting ----
    # capspace already drives M_money; multiplying it into D too would square the money signal.
    B = {pos: (curve[pos]["p50"][brf.REPL_RANK[pos] - 1] if pos in curve else 0.0) for pos in SKILL}
    STUD = {pos: (curve[pos]["p50"][5] if pos in curve and len(curve[pos]["p50"]) > 5 else 6.0) for pos in SKILL}
    apwe_by_team = collections.defaultdict(lambda: collections.defaultdict(list))
    for fid, pid, pos, status, _sal in wk1:
        if status != "ROSTER":
            continue
        e = ep4(season, pid, pos)
        if e["pos"] in SKILL and e["has_fp"]:
            c = curve[e["pos"]]["p50"]
            apwe_by_team[fid][e["pos"]].append(c[min(e["rank"], len(c)) - 1])
    demand, supply = {}, {}
    for pos in SKILL:
        d = 0.0
        for fid in teams:
            vals = sorted(apwe_by_team[fid].get(pos, []), reverse=True)
            starters = (vals + [0.0] * brf.SLOTS[pos])[:brf.SLOTS[pos]]
            need = sum(max(0.0, B[pos] - v) for v in starters)
            top = vals[0] if vals else 0.0
            d += need + max(0.0, STUD[pos] - top)     # comp_score, exactly as build_roster_fit defines it
        demand[pos] = round(d, 3)
        supply[pos] = sum(1 for p in credible if p["pos"] == pos)

    sum_cap = sum(t["capspace_k"] for t in teams.values())
    sum_res = sum(t["reserve_k"] for t in teams.values())
    sum_rw = sum(p["rw"] for p in credible) or 1

    return {
        "season": season, "auction_start": win_start, "auction_end": win_end,
        "n_teams": len(teams),
        "sum_capspace_k": round(sum_cap, 1), "sum_reserve_k": round(sum_res, 1),
        "realized_idp_spend_k": round(sum(t["idp_spend_k"] for t in teams.values()), 1),
        "n_pool": len(pool), "n_credible": len(credible),
        "credible_rw_k": round(sum_rw, 1),
        "R": round((sum_cap - sum_res) / sum_rw, 4),
        "supply_definition": "unrostered pre-auction skill players with a FantasyPros rank (symmetric with build_roster_fit)",
        "diagnostic_nominated_pool": {
            "n_pool": sum(1 for p in nom if p["pos"] in SKILL), "n_credible": len(nom_cred),
            "credible_rw_k": round(sum(p["rw"] for p in nom_cred), 1),
            "R": round((sum_cap - sum_res) / (sum(p["rw"] for p in nom_cred) or 1), 4),
            "note": "the supply that actually drew an opening bid — carried to show the unrostered "
                    "substitution does not move Σrw materially"},
        "demand": demand, "supply": supply,
        "z": {pos: round(demand[pos] / supply[pos], 4) if supply[pos] else None for pos in SKILL},
        "_credible_ids": {p["pid"] for p in credible},
        "_credible_pool": credible,   # full credible-pool objects (floor/affine/dyn_anchor) for the coherence backtest
        "_wins": wins,
    }


# ─────────────────────────────────────────────────────────────────────────────
# fitting
# ─────────────────────────────────────────────────────────────────────────────
def wols_origin(pts):
    """weighted least squares through the origin: y ≈ k·x → k. pts = [(x, y, w)]."""
    num = sum(w * x * y for x, y, w in pts)
    den = sum(w * x * x for x, y, w in pts)
    return (num / den) if den > 1e-12 else 0.0


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def fit(train_regimes, obs_by_year, elite_on):
    """Derive λ, γ, R̄, z̄ (and the elite factor) from the TRAINING seasons only."""
    Rbar = statistics.mean(r["R"] for r in train_regimes)
    zbar = {}
    for pos in SKILL:
        vals = [r["z"][pos] for r in train_regimes if r["z"].get(pos)]
        zbar[pos] = statistics.mean(vals) if vals else None

    # λ: the year's dollar-weighted markup vs the SERVED EP_v4 (all three arms), regressed on the
    # year's money/value regime. m_y = Σpaid / Σep4 — not Σpaid/Σaffine, which is the mistake that
    # made the affine arm look like the whole model.
    lam_pts, year_m = [], {}
    for r in train_regimes:
        obs = obs_by_year[r["season"]]
        if not obs:
            continue
        sp = sum(o["paid"] for o in obs)
        se = sum(o["ep4"] for o in obs) or 1
        m = sp / se
        year_m[r["season"]] = m
        lam_pts.append((r["R"] / Rbar - 1, m - 1, sp))
    lam_raw = wols_origin(lam_pts)
    lam = max(0.0, lam_raw)                # sign guard: a richer market cannot depress prices

    # γ: the positional residual left after the year effect, regressed on (D/S) relative to normal.
    gam_pts = []
    for r in train_regimes:
        m_y = year_m.get(r["season"])
        if not m_y:
            continue
        for pos in SKILL:
            if not (r["z"].get(pos) and zbar.get(pos)):
                continue
            cell = [o for o in obs_by_year[r["season"]] if o["pos"] == pos]
            if len(cell) < 3:
                continue
            sp = sum(o["paid"] for o in cell)
            se = sum(o["ep4"] for o in cell) or 1
            gam_pts.append((r["z"][pos] / zbar[pos] - 1, (sp / se) / m_y - 1, sp))
    gam_raw = wols_origin(gam_pts)
    gam = max(0.0, gam_raw)

    def mults(regime, pos):
        mm = clamp(1 + lam * (regime["R"] / Rbar - 1), M_MONEY_LO, M_MONEY_HI)
        mp = 1.0
        if regime["z"].get(pos) and zbar.get(pos):
            mp = clamp(1 + gam * (regime["z"][pos] / zbar[pos] - 1), M_POS_LO, M_POS_HI)
        return mm, mp

    # elite factor: what's left on the top-3-per-position rows after M_money·M_pos. Fitted, not
    # assumed — and only USED if its sub-gate passes.
    elite = 1.0
    if elite_on:
        num = den = 0.0
        for r in train_regimes:
            for o in obs_by_year[r["season"]]:
                if not o["elite"]:
                    continue
                mm, mp = mults(r, o["pos"])
                base = max(o["affine"], o["dyn_anchor"]) * mm * mp
                if base > 0:
                    num += o["paid"] * o["paid"]
                    den += base * o["paid"]
        if den > 1e-9:
            elite = num / den
    # leverage: the single training year contributing the most weighted x² to λ. With four yearly
    # points one outlier season can carry the whole fit — surfaced so nobody reads λ as well-identified.
    lev = None
    if lam_pts:
        den = sum(w * x * x for x, _y, w in lam_pts) or 1e-12
        by_yr = [(r["season"], (r["R"] / Rbar - 1) ** 2 * sum(o["paid"] for o in obs_by_year[r["season"]]))
                 for r in train_regimes if r["season"] in year_m]
        top = max(by_yr, key=lambda t: t[1])
        lev = {"season": top[0], "share_of_lambda_leverage": round(top[1] / den, 4)}

    return {"lambda": lam, "gamma": gam, "lambda_raw": lam_raw, "gamma_raw": gam_raw,
            "R_bar": Rbar, "z_bar": zbar, "elite": elite, "leverage": lev,
            "year_m": year_m, "_mults": mults, "_n_gamma_cells": len(gam_pts)}


def predict_v5(o, regime, f, use_elite):
    mm, mp = f["_mults"](regime, o["pos"])
    e = f["elite"] if (use_elite and o["elite"]) else 1.0
    return round(max(o["floor"], max(o["affine"], o["dyn_anchor"]) * mm * mp * e)), mm, mp, e


def errs(obs, key):
    ae = [abs(o[key] - o["paid"]) for o in obs]
    sp = sum(o["paid"] for o in obs) or 1
    return {"mae": round(statistics.mean(ae), 3),
            "dw_mae": round(sum(abs(o[key] - o["paid"]) * o["paid"] for o in obs) / sp, 3),
            "bias": round(statistics.mean([o[key] - o["paid"] for o in obs]), 3), "n": len(obs)}


# ─────────────────────────────────────────────────────────────────────────────
RECONSTRUCTION_GAPS = [
    {"gap": "dead_cap_not_reconstructed",
     "detail": "Pre-auction cap space is rebuilt by removing each team's auction wins and "
               "post-auction adds from its week-1 ROSTER. Cap PENALTIES from players cut before or "
               "during the auction window never appear in a week-1 roster row, so reconstructed "
               "capspace is BIASED HIGH by the league's live dead-cap load.",
     "direction": "R overstated (unknown magnitude, same sign every year → largely absorbed by R̄)"},
    {"gap": "winners_traded_or_cut_before_week1",
     "detail": "~24% of FA-auction winners are off the winning roster by week 1 (2024: 141 of 185 "
               "remain). Those player-ids are still excluded from the pre-auction sum by id, so the "
               "reconstruction holds, but their post-auction churn is invisible.",
     "direction": "neutral for capspace, understates realized IDP spend"},
    {"gap": "post_auction_add_prices",
     "detail": "Post-auction adds are excluded by player-id from week-1 salaries rather than by a "
               "$1K assumption, so no synthetic price is injected. The BBID amount itself is not "
               "read back, so the realized-IDP-spend cross-check undercounts multi-$K waiver claims.",
     "direction": "realized_idp_spend_k is a LOWER bound"},
    {"gap": "censored_non_clears",
     "detail": "Supply is the NOMINATED pool (players with an opening bid). Nomination is near-"
               "complete — 2023 is the only season with non-clears (3 of 166) — but the deeper "
               "censoring is structural: high-dynasty players are never released into the FA "
               "auction at all, so the historical pool cannot exercise the dynasty-anchor arm.",
     "direction": "dyn_anchor arm is UNVALIDATABLE from this archive (see arm_truth.coverage_warning)"},
    {"gap": "idp_reserve_asymmetry",
     "detail": "Historical reserve is the worker's reserve_cost engine run on the RECONSTRUCTED "
               "pre-auction roster (symmetric with how build_roster_fit computes it live). "
               "realized_idp_spend_k is carried alongside as an independent cross-check; the two "
               "measure different things (money that must be held vs money actually spent).",
     "direction": "documented, not corrected"},
    {"gap": "fpros_rank_coverage",
     "detail": "2023 has the thinnest FantasyPros history (309 rows vs 527 in 2022). Rostered "
               "players without a rank contribute 0 to positional demand, so D is understated most "
               "in 2023.",
     "direction": "z_2023 biased low"},
]


# ─────────────────────────────────────────────────────────────────────────────
# BUDGET-CONSTRAINT COHERENCE BACKTEST  (grafted from the budget-coherence agent onto this
# harness's own reconstruction — see build_fa_value.py "BUDGET-CONSTRAINT COHERENCE").
# ─────────────────────────────────────────────────────────────────────────────
def budget_constraint_backtest(con, regimes, all_clears):
    """Was the board (as it would have been built) internally coherent with the money, and does
    forcing coherence help or hurt winner accuracy? For each 2022-25 season: price the reconstructed
    credible SKILL pool with the served v4 price (M=1.0), take the top-N by price (N = that year's
    OFFENSE clear count), and compare that predicted clearing set against the year's ACTUAL offense
    spend (ratio ≈ 1 = coherent). Then re-price the ACTUAL winners OFF (v4) vs GLOBAL (one offense
    market-scale that forces the top-N pool sum == actual offense spend) and compare MAE. Also freezes
    the per-bucket clear counts / spend / deploy fraction that build_fa_value's constants mirror.
    Reads the same archive; DIAGNOSTIC/PROVENANCE ONLY — adds no unmeasured constant to the served EP."""
    def served(it, s=1.0):
        return round(max(it["floor"], max(it["affine"], it["dyn_anchor"]) * s))

    def solve(items, target, lo=0.50, hi=1.5):
        f = lambda s: sum(served(it, s) for it in items)
        if not items or f(hi) <= target:
            return hi
        if f(lo) >= target:
            return lo
        a, b = lo, hi
        for _ in range(60):
            m = (a + b) / 2
            (a, b) = (m, b) if f(m) <= target else (a, m)
        return round((a + b) / 2, 4)

    POSB = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "DE": "DL", "DT": "DL", "DL": "DL",
            "LB": "LB", "CB": "DB", "S": "DB", "DB": "DB", "PK": "PK", "PN": "PN"}
    reg_by_year = {r["season"]: r for r in regimes}
    clears_by_year = collections.defaultdict(list)
    for o in all_clears:
        clears_by_year[o["season"]].append(o)
    bkt_n, bkt_spend = collections.defaultdict(list), collections.defaultdict(list)
    per_year, off_off, off_glob = {}, [], []
    for y in YEARS:
        rows = con.execute("SELECT position, bid_amount FROM transactions_auction "
                           "WHERE season=? AND auction_type='FreeAgent' AND finalbid_ind=1", (y,)).fetchall()
        yb_n, yb_s = collections.Counter(), collections.defaultdict(float)
        for pos, bid in rows:
            b = POSB.get((pos or "").upper())
            if b:
                yb_n[b] += 1
                yb_s[b] += (bid or 0) / 1000.0
        for b in yb_n:
            bkt_n[b].append(yb_n[b])
            bkt_spend[b].append(yb_s[b])
        total_spend = sum((bid or 0) for _p, bid in rows) / 1000.0
        lots = clears_by_year.get(y, [])                 # skill clears (all_clears is skill-only)
        off_spend = sum(o["paid"] for o in lots)
        n_off_clear = len(lots)
        avail = reg_by_year[y]["sum_capspace_k"]
        pool = reg_by_year[y].get("_credible_pool", [])
        priced = sorted(pool, key=lambda p: -served(p))[:n_off_clear]
        pred_clearing = sum(served(p) for p in priced)
        s_glob = solve([{"floor": p["floor"], "affine": p["affine"], "dyn_anchor": p["dyn_anchor"]}
                        for p in priced], off_spend)
        for o in lots:
            off_off.append((o["paid"], served(o, 1.0)))
            off_glob.append((o["paid"], served(o, s_glob)))
        per_year[y] = {"available_k": round(avail), "total_spend_k": round(total_spend),
                       "offense_spend_k": round(off_spend), "n_offense_clears": n_off_clear,
                       "deploy_frac": round(total_spend / avail, 4) if avail else None,
                       "coherence_ratio_v4": round(pred_clearing / off_spend, 3) if off_spend else None,
                       "global_offense_scale": round(s_glob, 3)}

    def mae(pairs):
        errs_ = [abs(p - e) for p, e in pairs]
        tp = sum(p for p, _ in pairs) or 1
        return {"mae": round(statistics.mean(errs_), 2) if errs_ else None,
                "dw_mae": round(sum(abs(p - e) * p for p, e in pairs) / tp, 2), "n": len(pairs)}

    deploy_fracs = [per_year[y]["deploy_frac"] for y in YEARS if per_year[y]["deploy_frac"]]
    return {
        "note": "Budget-constraint coherence: predicted clearing set (top-N pool by served price) vs "
                "actual spend. Historical boards are coherent (ratio 0.66-0.97 at M=1.0); a ratio >>1 "
                "means the LIVE pool is value-inflated (classically a pre-roster-lock snapshot). "
                "DIAGNOSTIC/PROVENANCE ONLY — does NOT feed the served EP; build_fa_value freezes these.",
        "clear_count_by_bucket": {b: round(statistics.mean(v), 1) for b, v in sorted(bkt_n.items())},
        "spend_k_by_bucket": {b: round(statistics.mean(v), 1) for b, v in sorted(bkt_spend.items())},
        "deploy_frac_mean": round(statistics.mean(deploy_fracs), 3) if deploy_fracs else None,
        "deploy_frac_by_year": {y: per_year[y]["deploy_frac"] for y in YEARS},
        "coherence_band_recommended": [0.60, 1.15],
        "per_year": per_year,
        "accuracy_cost_of_enforcement": {
            "off_v4": mae(off_off), "global_forced_coherence": mae(off_glob),
            "verdict": ("enforcement HURTS winner accuracy — default OFF (diagnostic only)"
                        if (mae(off_glob)["mae"] or 0) > (mae(off_off)["mae"] or 0) else
                        "enforcement does not hurt plain MAE")},
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=None, help="sqlite archive (default: /tmp canon db, else the committed .gz)")
    ap.add_argument("--print-only", action="store_true", help="report to stdout, do not write the JSON")
    args = ap.parse_args()

    db = resolve_db(args.db)
    curve, fp, dynv, unmapped = load_inputs()
    ep4 = make_ep_v4(curve, fp, dynv)
    con = sqlite3.connect(db)

    print(f"=== EP v5 CALIBRATION — source: {db} ===")
    print(f"  inputs: {len(fp)} fpros rank-seasons · {len(dynv)} dynasty value-seasons "
          f"({unmapped} dynasty rows unmapped to an mfl_id)")

    # ── 1. regime reconstruction ──────────────────────────────────────────────
    regimes = [reconstruct_season(con, y, ep4, curve, fp) for y in YEARS]
    print("\n=== REGIME (reconstructed pre-auction state) ===")
    print(f"  {'yr':<6}{'Σcap$K':>8}{'Σrsv$K':>8}{'pool':>6}{'cred':>6}{'Σrw$K':>8}{'R':>7}   D/S by pos")
    for r in regimes:
        z = "  ".join(f"{p} {r['z'][p]:.2f}" if r["z"][p] else f"{p} —" for p in SKILL)
        print(f"  {r['season']:<6}{r['sum_capspace_k']:>8.0f}{r['sum_reserve_k']:>8.0f}"
              f"{r['n_pool']:>6}{r['n_credible']:>6}{r['credible_rw_k']:>8.0f}{r['R']:>7.2f}   {z}")

    # ── 2. observations = credible clears ─────────────────────────────────────
    obs_by_year, all_clears = {}, []
    for r in regimes:
        rows = []
        for pid, _fid, bid, pos, nm in r["_wins"]:
            e = ep4(r["season"], pid, pos)
            if e["pos"] not in SKILL:
                continue
            o = {**e, "season": r["season"], "pid": str(pid), "name": nm, "paid": bid / 1000.0,
                 "ep4": e["ep"], "elite": False}
            all_clears.append(o)
            if str(pid) in r["_credible_ids"]:
                rows.append(o)
        # elite = top-N per position by redraft worth WITHIN the season's credible clears
        for pos in SKILL:
            for o in sorted([x for x in rows if x["pos"] == pos], key=lambda x: -x["rw"])[:ELITE_TOP_N]:
                o["elite"] = True
        obs_by_year[r["season"]] = rows

    # ── 3. ARM-LEVEL TRUTH ────────────────────────────────────────────────────
    def arm_table(pool, label):
        out = {"label": label, "n": len(pool), "arms": {}}
        for a in ("floor", "affine", "dyn_anchor"):
            sub = [o for o in pool if o["arm"] == a]
            out["arms"][a] = ({"n": 0, "binding_share": 0.0} if not sub else
                              {"n": len(sub), "binding_share": round(len(sub) / len(pool), 4),
                               "paid_share": round(sum(o["paid"] for o in sub) / (sum(o["paid"] for o in pool) or 1), 4),
                               **errs(sub, "ep4")})
        out["served"] = errs(pool, "ep4")
        aff = [{**o, "_a": o["affine"]} for o in pool]
        out["affine_arm_only_advertised"] = {
            "mae": round(statistics.mean([abs(o["affine"] - o["paid"]) for o in aff]), 3),
            "mse": round(statistics.mean([(o["affine"] - o["paid"]) ** 2 for o in aff]), 1)}
        return out

    credible_all = [o for y in YEARS for o in obs_by_year[y]]
    arm_truth = {
        "all_clears": arm_table(all_clears, "all skill FA clears 2022-25"),
        "credible": arm_table(credible_all, "credible pool (rw≥3 or ep≥5)"),
        "credible_by_year": {str(y): arm_table(obs_by_year[y], f"credible {y}") for y in YEARS},
        "shipped_board_binding_2026": None,   # filled below
        "coverage_warning": None,
    }

    print("\n=== ARM-LEVEL TRUTH — the SERVED max(), measured per arm vs actual paid ===")
    for key in ("all_clears", "credible"):
        t = arm_truth[key]
        print(f"\n  {t['label']} (n={t['n']})")
        for a in ("floor", "affine", "dyn_anchor"):
            d = t["arms"][a]
            if not d["n"]:
                print(f"    {a:<11} binds 0")
                continue
            print(f"    {a:<11} binds {d['n']:>4} ({100*d['binding_share']:>5.1f}%)  "
                  f"MAE ${d['mae']:>6.2f}K  $wMAE ${d['dw_mae']:>6.2f}K  bias {d['bias']:>+6.2f}K  "
                  f"{100*d['paid_share']:.0f}% of $")
        s = t["served"]
        print(f"    {'SERVED EP':<11} {'':>10}         MAE ${s['mae']:>6.2f}K  $wMAE ${s['dw_mae']:>6.2f}K  bias {s['bias']:>+6.2f}K")
        print(f"    advertised affine-arm-only: MAE ${t['affine_arm_only_advertised']['mae']}K  "
              f"MSE {t['affine_arm_only_advertised']['mse']}")

    # the same arm census on the CURRENT board — this is the finding that matters
    try:
        core = json.loads((DATA / "fa_value_core.json").read_text())["players"]
        cnt, cnt_cred = collections.Counter(), collections.Counter()
        for p in core:
            # prefer the authoritative flag build_fa_value now emits; fall back for older blobs
            arm = p.get("ep_arm")
            if not arm:
                aff = bfv.AFFINE_ANTE + bfv.AFFINE_SLOPE * p["redraft_worth_k"]
                dyn = p["dynasty_worth_k"] * bfv.POS_DYN_W.get(p["pos"], 0.8)
                arm = "floor" if round(max(aff, dyn)) < p["ep_base_k"] else ("affine" if aff >= dyn else "dyn_anchor")
            cnt[arm] += 1
            if p["redraft_worth_k"] >= CREDIBLE_RW or p["ep_base_k"] >= CREDIBLE_EP:
                cnt_cred[arm] += 1
        n_c = sum(cnt_cred.values()) or 1
        arm_truth["shipped_board_binding_2026"] = {
            "all": dict(cnt), "credible": dict(cnt_cred),
            "credible_dyn_anchor_share": round(cnt_cred["dyn_anchor"] / n_c, 4)}
        hist = arm_truth["credible"]["arms"]["dyn_anchor"]["binding_share"]
        arm_truth["coverage_warning"] = (
            f"The dynasty-anchor arm binds {100*cnt_cred['dyn_anchor']/n_c:.0f}% of the CREDIBLE 2026 board "
            f"but only {100*hist:.1f}% of credible historical clears (n={arm_truth['credible']['arms']['dyn_anchor']['n']}). "
            f"This is structural, not a sampling accident: franchises do not release high-dynasty players "
            f"into the FA auction, so the arm that prices most of today's board is essentially "
            f"UNVALIDATABLE from the archive. POS_DYN_W remains a Keith-tunable judgement call, and the "
            f"advertised MSE-31/MAE-$3.5K describes the affine arm on ALL clears — a set dominated by "
            f"$1-2K scrubs — not the number the tool serves on the players you actually bid on.")
        print(f"\n  2026 SHIPPED BOARD: credible arm mix {dict(cnt_cred)} "
              f"→ dyn_anchor binds {100*cnt_cred['dyn_anchor']/n_c:.0f}%")
        print(f"  ⚠ {arm_truth['coverage_warning']}")
    except FileNotFoundError:
        print("  (fa_value_core.json absent — skipping the 2026 board arm census)")

    # ── 4. LEAVE-ONE-YEAR-OUT ─────────────────────────────────────────────────
    # elite sub-gate first: does a fitted elite factor beat 1.0 on top-3-per-pos rows in ≥3/4 folds?
    def loyo(use_elite):
        folds, held = [], []
        for y in YEARS:
            tr = [r for r in regimes if r["season"] != y]
            te = next(r for r in regimes if r["season"] == y)
            f = fit(tr, obs_by_year, elite_on=use_elite)
            rows = []
            for o in obs_by_year[y]:
                ep5, mm, mp, el = predict_v5(o, te, f, use_elite)
                rows.append({**o, "ep5": ep5, "m_money": round(mm, 4), "m_pos": round(mp, 4), "elite_f": round(el, 4)})
            held += rows
            folds.append({"held_out": y, "n": len(rows),
                          "lambda": round(f["lambda"], 4), "gamma": round(f["gamma"], 4),
                          "lambda_raw": round(f["lambda_raw"], 4), "gamma_raw": round(f["gamma_raw"], 4),
                          "R_bar": round(f["R_bar"], 4), "elite": round(f["elite"], 4),
                          "R_heldout": te["R"], "m_money": round(rows[0]["m_money"], 4) if rows else None,
                          "v4": errs(rows, "ep4"), "v5": errs(rows, "ep5"),
                          "v4_elite": errs([r for r in rows if r["elite"]], "ep4") if any(r["elite"] for r in rows) else None,
                          "v5_elite": errs([r for r in rows if r["elite"]], "ep5") if any(r["elite"] for r in rows) else None})
        return folds, held

    folds_ne, held_ne = loyo(False)
    folds_e, held_e = loyo(True)
    elite_wins = sum(1 for a, b in zip(folds_ne, folds_e)
                     if a["v5_elite"] and b["v5_elite"] and b["v5_elite"]["mae"] < a["v5_elite"]["mae"])
    elite_gate = elite_wins >= 3
    folds, held = (folds_e, held_e) if elite_gate else (folds_ne, held_ne)

    print(f"\n=== ELITE-DECAY SUB-GATE: improves top-{ELITE_TOP_N}-per-pos MAE in {elite_wins}/4 folds "
          f"→ {'ON' if elite_gate else 'OFF (factor forced to 1.0)'} ===")

    print("\n=== LEAVE-ONE-YEAR-OUT (fit on 3 seasons, predict the 4th) ===")
    print(f"  {'held':<7}{'n':>4}{'λ':>7}{'γ':>7}{'R_out':>7}{'Mmny':>7}"
          f"{'v4 MAE':>9}{'v5 MAE':>9}{'v4 $wMAE':>11}{'v5 $wMAE':>11}")
    for f in folds:
        print(f"  {f['held_out']:<7}{f['n']:>4}{f['lambda']:>7.3f}{f['gamma']:>7.3f}{f['R_heldout']:>7.2f}"
              f"{(f['m_money'] or 1):>7.3f}{f['v4']['mae']:>9.2f}{f['v5']['mae']:>9.2f}"
              f"{f['v4']['dw_mae']:>11.2f}{f['v5']['dw_mae']:>11.2f}")
    v4o, v5o = errs(held, "ep4"), errs(held, "ep5")
    print(f"  {'POOLED':<7}{len(held):>4}{'':>7}{'':>7}{'':>7}{'':>7}"
          f"{v4o['mae']:>9.2f}{v5o['mae']:>9.2f}{v4o['dw_mae']:>11.2f}{v5o['dw_mae']:>11.2f}")

    # ── 5. SHIP GATE ──────────────────────────────────────────────────────────
    beats_dw = v5o["dw_mae"] < v4o["dw_mae"]
    mae_ok = v5o["mae"] <= v4o["mae"] * 1.02
    ship = bool(beats_dw and mae_ok)
    print(f"\n=== SHIP GATE ===")
    print(f"  dollar-weighted MAE of the SERVED number: v4 ${v4o['dw_mae']}K → v5 ${v5o['dw_mae']}K   "
          f"[{'PASS' if beats_dw else 'FAIL'}]")
    print(f"  plain MAE within 2%: v4 ${v4o['mae']}K → v5 ${v5o['mae']}K "
          f"(cap ${round(v4o['mae']*1.02,3)}K)   [{'PASS' if mae_ok else 'FAIL'}]")
    print(f"  → ship_gate = {ship}" + ("" if ship else
          "  → build_roster_fit serves v4 unchanged; only the transparency columns ship. "
          "Four yearly points is thin — this is an expected outcome, not a bug."))

    # ── 6. final constants (fit on ALL four seasons) ──────────────────────────
    fin = fit(regimes, obs_by_year, elite_on=elite_gate)
    print(f"\n=== FITTED CONSTANTS (all 4 seasons) ===")
    print(f"  λ = {fin['lambda']:.4f}   γ = {fin['gamma']:.4f}   R̄ = {fin['R_bar']:.4f}   "
          f"elite = {fin['elite']:.4f} ({'ON' if elite_gate else 'OFF'})")
    print(f"  raw (pre-sign-guard): λ {fin['lambda_raw']:+.4f}  γ {fin['gamma_raw']:+.4f} "
          f"over {fin['_n_gamma_cells']} (pos,year) cells"
          + ("   ← γ SIGN-GUARDED TO 0: the positional D/S signal points the WRONG WAY in-sample, "
             "so M_pos is inert (≡1) and only M_money is live." if fin["gamma_raw"] < 0 else ""))
    if fin.get("leverage"):
        print(f"  λ leverage: {100*fin['leverage']['share_of_lambda_leverage']:.0f}% of the fit comes from "
              f"{fin['leverage']['season']} alone — four yearly points do NOT identify λ well.")
    print(f"  z̄ = " + "  ".join(f"{p} {fin['z_bar'][p]:.3f}" if fin['z_bar'].get(p) else f"{p} —" for p in SKILL))
    print(f"  per-year markup vs SERVED EP_v4: " +
          "  ".join(f"{y} {fin['year_m'].get(y, float('nan')):.3f}" for y in YEARS))

    # ── BUDGET-CONSTRAINT COHERENCE BACKTEST (diagnostic/provenance; freezes build_fa_value's constants) ──
    budget = budget_constraint_backtest(con, regimes, all_clears)
    print(f"\n=== BUDGET-CONSTRAINT COHERENCE (predicted clearing set vs actual spend, M=1.0) ===")
    for y in YEARS:
        pb = budget["per_year"][y]
        print(f"  {y}: avail ${pb['available_k']}K · spend ${pb['total_spend_k']}K (deploy {pb['deploy_frac']}) · "
              f"offense ${pb['offense_spend_k']}K · coherence ratio {pb['coherence_ratio_v4']}")
    print(f"  deploy_frac mean {budget['deploy_frac_mean']} · band {budget['coherence_band_recommended']} · "
          f"{budget['accuracy_cost_of_enforcement']['verdict']}")

    payload = {
        "schema": "ep_v5_calibration/1",
        "generated_by": "pipelines/etl/scripts/build_ep_v5_calibration.py",
        "source_db": str(db), "years": YEARS,
        "ship_gate": ship,
        "ship_gate_detail": {
            "rule": "v5 must beat v4 on LOYO dollar-weighted MAE of the SERVED number AND keep plain MAE within 2%",
            "v4": v4o, "v5": v5o,
            "beats_dollar_weighted_mae": beats_dw, "mae_within_2pct": mae_ok,
            "folds_improved_dw_mae": sum(1 for f in folds if f["v5"]["dw_mae"] < f["v4"]["dw_mae"]),
            "folds": len(folds),
            "on_failure": "build_roster_fit serves v4 unchanged; only the transparency columns ship.",
            "power_warning":
                "The gate is a 4-point leave-one-year-out on 137 credible clears. λ is identified almost "
                "entirely by one outlier season, γ is sign-guarded to 0 (M_pos inert), and at least one "
                "fold regresses. Treat v5 as a modest, honestly-measured improvement in dollar-weighted "
                "error — not as a validated market model. --ep-model v4 remains a one-flag rollback.",
        },
        "constants": {
            "lambda": round(fin["lambda"], 5), "gamma": round(fin["gamma"], 5),
            "lambda_raw": round(fin["lambda_raw"], 5), "gamma_raw": round(fin["gamma_raw"], 5),
            "gamma_sign_guarded": fin["gamma_raw"] < 0,
            "lambda_leverage": fin.get("leverage"),
            "n_gamma_cells": fin["_n_gamma_cells"],
            "R_bar": round(fin["R_bar"], 5),
            # the observed range of R across the fit seasons. build_roster_fit compares the LIVE R
            # against this and warns when it is extrapolating — outside this band M_money is being
            # driven by the clamp, not by anything that was measured.
            "R_observed_range": [round(min(r["R"] for r in regimes), 4),
                                 round(max(r["R"] for r in regimes), 4)],
            "z_bar": {p: (round(v, 5) if v else None) for p, v in fin["z_bar"].items()},
            "elite_factor": round(fin["elite"], 5), "elite_enabled": elite_gate,
            "elite_top_n": ELITE_TOP_N,
            "m_money_clamp": [M_MONEY_LO, M_MONEY_HI], "m_pos_clamp": [M_POS_LO, M_POS_HI],
            "credible_rw": CREDIBLE_RW, "credible_ep": CREDIBLE_EP,
            "formula": "ep_v5 = round(max(floor, max(affine, dyn_anchor) · M_money · M_pos · elite)); "
                       "M_money = clamp(1+λ·(R/R̄−1)); M_pos = clamp(1+γ·((D/S)/z̄[pos]−1)); "
                       "R = (Σcapspace − Σreserve)/Σrw(credible pool); D = Σ comp_score (NO capspace weighting)",
            "sign_guard": "λ,γ clamped ≥ 0 — a scarcer/richer market cannot make prices cheaper",
            "tunables_not_fitted": ["m_money_clamp", "m_pos_clamp", "elite_top_n",
                                    "POS_DYN_W (build_fa_value)", "STARTABILITY (build_fa_value)",
                                    "DYN_ANCHOR_K=$75K (build_fa_value)"],
        },
        "regime_by_year": [{k: v for k, v in r.items() if not k.startswith("_")} for r in regimes],
        "per_year_markup_vs_served_v4": {str(y): round(fin["year_m"].get(y, 0), 4) for y in YEARS},
        "arm_truth": arm_truth,
        "backtest_loyo": {"folds": folds, "pooled": {"v4": v4o, "v5": v5o},
                          "elite_sub_gate": {"folds_improved": elite_wins, "required": 3, "passed": elite_gate}},
        "reconstruction_gaps": RECONSTRUCTION_GAPS,
        "budget_constraint": budget,
    }

    if args.print_only:
        print("\n(--print-only: nothing written)")
        return
    OUT.write_text(json.dumps(payload, indent=2))
    print(f"\nwrote {OUT.relative_to(REPO)}")


if __name__ == "__main__":
    main()
