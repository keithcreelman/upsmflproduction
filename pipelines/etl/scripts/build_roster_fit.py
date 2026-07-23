#!/usr/bin/env python3
"""Phase E — league-wide roster fit + the v5 regime multipliers + finalize the FA value blob.

1. Pull all 12 live rosters → each team's production strength by position
   (rostered players' E[APWE]) vs a startable baseline B[pos] → per-team NEED / SURPLUS,
   plus each team's per-team IDP/K/P RESERVE (the worker's reserve_cost engine, ported).
2. EXPECTED PRICE. build_fa_value emits three arms (startability floor ∨ affine clearing line ∨
   position-weighted dynasty anchor) and the arm that bound. This phase optionally applies the
   v5 REGIME MULTIPLIERS on top:
       ep_v5 = max(floor, max(affine, dyn_anchor) · M_money · M_pos · elite)
       M_money = clamp(1 + λ·(R_now/R̄ − 1), 0.80, 1.60)   R = (Σcapspace − Σreserve) / Σrw(pool)
       M_pos   = clamp(1 + γ·((D/S)/z̄[pos] − 1), 0.85, 1.35)   D = Σ comp_score ONLY
   λ, γ, R̄, z̄ and the elite factor are FITTED, never hand-set — build_ep_v5_calibration.py
   regenerates them from the archive, runs leave-one-year-out on 2022-25, and writes
   ep_v5_calibration.json with a ship_gate boolean. v5 applies ONLY when that gate passed.
   `--ep-model v4` forces the unmodified v4 max() (bit-identical to the pre-v5 pipeline);
   `--ep-model v5` demands v5 and fails loudly if the gate did not pass. Default: gate decides.
   NOTE: capspace influences price ONLY through M_money. It is deliberately absent from D —
   weighting demand by cap space too would square the money signal.
3. Filter to AVAILABLE FAs (unrostered) + rostered TRADE TARGETS (own=fid).
4. Per FA: 0008's fit + a COMPETITION forecast (teams with a NEED there × cap space).
5. Write fa_value.json (lean, FAs only) + fa_valuation.csv; --push-d1 upserts the blob.
"""
from __future__ import annotations
import argparse, csv, json, re, sqlite3, subprocess, time, urllib.request, collections
from pathlib import Path
import build_fa_value as bfv   # reuse the EP constants (POS_DYN_W, STARTABILITY, AFFINE_*, $/APWE) so the
                              # client recompute-kernel shipped in meta.model can't drift from the pipeline

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
WORKER = REPO / "worker"
DB = "/tmp/ups_auction_canon.db"
LEAGUE = "74598"; YEAR = 2026; CAP = 300000
SKILL = ["QB", "RB", "WR", "TE"]
MODEL_CURVE_MAXRANK = 40   # client recompute-kernel curves capped here (covers every startable override; saves blob bytes).
                           # 48 → 40 on 2026-07-23: the v5 meta grew the lean blob past D1's 100KB SQL-statement cap
                           # (101.8KB); ADP-override repricing never reaches rank 40+ at any position.
SLOTS = {"QB": 2, "RB": 2, "WR": 2, "TE": 1}          # SF starting demand per team
REPL_RANK = {"QB": 24, "RB": 31, "WR": 31, "TE": 14}  # replacement (marginal-starter) rank
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")

CALIBRATION = DATA / "ep_v5_calibration.json"   # written by build_ep_v5_calibration.py
DEPLOY_FRAC = 0.76     # descriptive only: ~76% of ceiling headroom historically becomes real bids.
                       # Reported in the market-context block; it does NOT enter any price.

# ── PER-TEAM IDP/K/P RESERVE (a straight port of the worker's reserveCostForScenario /
# computeLineupNeeds, worker/src/index.js ~19243-19302) ──
# Mandatory starters (K, P, DL×2, LB×2, DB×2) are entirely unpriced by the worth model, but every
# team must still hold money back to fill them. That reserve is PER-TEAM — a team already carrying
# its kicker holds back less — so it must never be a flat league constant. build_ep_v5_calibration
# imports these to reconstruct historical regimes with exactly the same engine.
MIN_ROSTER = 27        # the reserve engine's target roster count (worker: scenario_27)
POS_BUCKET = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "PK": "PK", "PN": "PN",
              "DE": "DL", "DT": "DL", "DL": "DL", "LB": "LB", "S": "DB", "CB": "DB", "DB": "DB"}


def reserve_slots(players):
    """players = [{pos, status}] → number of $1K slots the team must hold in reserve."""
    counts = collections.Counter()
    roster_count = 0
    for p in players:
        st = (p.get("status") or "").upper()
        taxi, ir = "TAXI" in st, ("IR" in st or "INJURED" in st)
        if not taxi:
            roster_count += 1
        if taxi or ir:
            continue
        b = POS_BUCKET.get(p.get("pos"))
        if b:
            counts[b] += 1
    base = {"QB": max(0, 1 - counts["QB"]), "RB": max(0, 2 - counts["RB"]),
            "WR": max(0, 2 - counts["WR"]), "TE": max(0, 1 - counts["TE"]),
            "PK": max(0, 1 - counts["PK"]), "PN": max(0, 1 - counts["PN"]),
            "DL": max(0, 2 - counts["DL"]), "LB": max(0, 2 - counts["LB"]),
            "DB": max(0, 2 - counts["DB"])}
    flex_pool = max(0, counts["RB"] - 2) + max(0, counts["WR"] - 2) + max(0, counts["TE"] - 1)
    flex = max(0, 2 - flex_pool)
    sflex = max(0, 1 - (max(0, counts["QB"] - 1) + max(0, flex_pool - 2)))
    dflex = max(0, 1 - (max(0, counts["DL"] - 2) + max(0, counts["LB"] - 2) + max(0, counts["DB"] - 2)))
    deficit = sum(base.values()) + flex + sflex + dflex
    return max(max(0, MIN_ROSTER - roster_count), deficit)


def jget(u):
    return json.loads(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "ups", "Accept": "*/*"}), timeout=30).read())


def nkey(s):
    s = (s or "").strip().lower()
    if "," in s: a, b = s.split(",", 1); s = b.strip() + " " + a.strip()
    s = s.replace(".", "").replace("'", "").replace("-", " ")
    return re.sub(r"\s+", " ", SUFFIX.sub("", s)).strip()


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


_CRX = {"aav": re.compile(r"AAV\s*([\d.]+)K", re.I), "tcv": re.compile(r"TCV\s*([\d.]+)K", re.I),
        "cl": re.compile(r"CL\s*(\d+)", re.I)}


def parse_contract(info, sal):
    """MFL contractInfo → {sal_k, aav_k, tcv_k, cl}. TWO angles for a trade target (Keith): what you
    pay THIS YEAR (sal_k = the current cap hit) vs the TRUE AAV = TCV ÷ contract-length (the smoothed
    annual cost over the deal). MFL's own 'AAV' token is just the current year (e.g. JSN 'AAV 1K' is
    his $1K Y2 of a back-loaded $70K/3yr = real AAV $23K), so we compute AAV from TCV/CL, not that token."""
    out = {"sal_k": round((sal or 0) / 1000.0)}
    for k in ("tcv", "cl"):
        m = _CRX[k].search(info or "")
        if m:
            out[k + ("_k" if k == "tcv" else "")] = (int(m.group(1)) if k == "cl" else round(float(m.group(1))))
    tcv, cl = out.get("tcv_k"), out.get("cl")
    out["aav_k"] = round(tcv / cl) if (tcv and cl) else out["sal_k"]   # TRUE AAV = TCV/CL, not the current-yr cap hit
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--push-d1", action="store_true")
    ap.add_argument("--ep-model", choices=["auto", "v4", "v5"], default="auto",
                    help="auto = ep_v5_calibration.json's ship_gate decides (default); "
                         "v4 = force the unmodified v4 max() (KILL SWITCH, bit-identical to pre-v5); "
                         "v5 = demand v5 and fail if the gate did not pass")
    ap.add_argument("--live-reprice", action="store_true",
                    help="Emit meta.live_reprice (the per-position LIVE-competition repricer). Off by "
                         "default: the blob is unchanged and the client applies no live multiplier. When "
                         "on, the client scales each position's market price by how many rival franchises "
                         "can STILL afford AND still need that position, read live from the auction board "
                         "(fails OPEN to the static price whenever the live budget/lots feed is absent).")
    args = ap.parse_args()

    # ---- v5 calibration (fitted constants + the ship gate) ----
    cal = json.loads(CALIBRATION.read_text()) if CALIBRATION.exists() else None
    if args.ep_model == "v5":
        if not cal:
            raise SystemExit(f"  ✘ --ep-model v5 but {CALIBRATION.name} is missing. "
                             f"Run: python3 build_ep_v5_calibration.py")
        if not cal.get("ship_gate"):
            raise SystemExit(f"  ✘ --ep-model v5 but ship_gate=false in {CALIBRATION.name}. "
                             f"v5 did NOT beat v4 on the leave-one-year-out gate; re-run the "
                             f"calibration or serve v4. Refusing to ship an unearned model.")
    use_v5 = bool(cal and cal.get("ship_gate")) if args.ep_model == "auto" else (args.ep_model == "v5")

    core = json.loads((DATA / "fa_value_core.json").read_text())["players"]
    by_name = {nkey(p["player"]): p for p in core}
    curve = json.loads((DATA / "eapw_curves.json").read_text())["curves"]["fpros"]   # redraft E[APWE] by rank
    B = {pos: (curve[pos]["p50"][REPL_RANK[pos] - 1] if pos in curve else 0.0) for pos in SKILL}
    STUD = {pos: (curve[pos]["p50"][5] if pos in curve and len(curve[pos]["p50"]) > 5 else 6.0) for pos in SKILL}

    # ---- live league state ----
    rosters = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=rosters&L={LEAGUE}&JSON=1")["rosters"]["franchise"]
    players = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=players&L={LEAGUE}&JSON=1")["players"]["player"]
    id2name = {str(p["id"]): p.get("name") for p in players}
    id2pos = {str(p["id"]): p.get("position") for p in players}   # raw MFL pos (PK/PN/DE/S/…) for the reserve engine
    lg = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=league&L={LEAGUE}&JSON=1")["league"]
    fid2team = {f["id"]: f.get("name", f["id"]) for f in lg["franchises"]["franchise"]}

    rostered_by_name, team, contract_by_name = {}, {}, {}
    surplus_k = 0.0     # Σ rostered (worth − contract), positive only = locked-cheap value
    for fr in rosters:
        fid = fr["id"]
        pls = fr.get("player", [])
        if isinstance(pls, dict): pls = [pls]
        active_sal = 0; apwe_by_pos = collections.defaultdict(list); slots = []
        for p in pls:
            nm = id2name.get(str(p.get("id")))
            slots.append({"pos": id2pos.get(str(p.get("id"))), "status": p.get("status")})
            if nm:
                rostered_by_name[nkey(nm)] = fid
            sal = int(p.get("salary") or 0)
            if nm and p.get("status") == "ROSTER":
                cinf = parse_contract(p.get("contractInfo") or "", sal)
                cinf["cy"] = int(p.get("contractYear") or 0)   # years remaining (cy=1 = last year)
                contract_by_name[nkey(nm)] = cinf
            if p.get("status") == "ROSTER":
                active_sal += sal
            c = by_name.get(nkey(nm or ""))
            if c and c["pos"] in SKILL and c.get("e_apwe_p50") is not None:
                apwe_by_pos[c["pos"]].append(c["e_apwe_p50"])
            if c and p.get("status") == "ROSTER" and (c.get("worth_k") or 0) > sal / 1000.0:
                surplus_k += (c["worth_k"] - sal / 1000.0)
        fit = {}
        for pos in SKILL:
            vals = sorted(apwe_by_pos.get(pos, []), reverse=True)
            starters = (vals + [0.0] * SLOTS[pos])[:SLOTS[pos]]
            need = round(sum(max(0.0, B[pos] - v) for v in starters), 2)
            surplus = round(sum(max(0.0, v - B[pos]) for v in vals), 2)
            top = vals[0] if vals else 0.0
            fit[pos] = {"need": need, "surplus": surplus, "top_apw": round(top, 2),
                        "has_stud": top >= STUD[pos], "starters_apw": round(sum(vals[:SLOTS[pos]]), 2)}
        team[fid] = {"team": fid2team.get(fid, fid), "capspace": CAP - active_sal,
                     "active_salary": active_sal, "fit": fit,
                     # money this team MUST hold back for its mandatory K/P/DL/LB/DB starters +
                     # open roster slots. Per-team by construction — never a flat league constant.
                     "reserve_k": float(reserve_slots(slots))}

    # ---- MARKET CONTEXT ----
    ceiling_headroom_k = sum(t["capspace"] for t in team.values()) / 1000.0
    biddable_money_k = round(DEPLOY_FRAC * ceiling_headroom_k)   # descriptive only — feeds no price
    reserve_total_k = sum(t["reserve_k"] for t in team.values())
    CRED_RW = (cal or {}).get("constants", {}).get("credible_rw", 3)
    CRED_EP = (cal or {}).get("constants", {}).get("credible_ep", 5)
    credible = [p for p in core if not rostered_by_name.get(nkey(p["player"]))
                and ((p.get("redraft_worth_k") or 0) >= CRED_RW or (p.get("ep_base_k") or 0) >= CRED_EP)]
    credible_rworth_k = round(sum(p.get("redraft_worth_k") or 0 for p in credible)) or 1

    # ── BUDGET-CONSTRAINT COHERENCE (offense) — the accounting identity behind the shopping board ──
    # biddable_money above is a total-dollar CONTEXT number that was only ever displayed. Here we
    # actually CHECK the board against it: is the OFFENSE predicted clearing set (top-N per bucket by
    # price) within the money that will be spent? IDP/K/P are priced off the realized ladder elsewhere
    # (already coherent), so this offense check is the one the EP model can violate.
    committed_k = CAP * len(team) / 1000.0 - ceiling_headroom_k
    projected_spend_k, spend_parts = bfv.project_auction_spend(ceiling_headroom_k, committed_k)
    off_vals = collections.defaultdict(list)
    for p in core:
        if not rostered_by_name.get(nkey(p["player"])) and p.get("pos") in SKILL:
            off_vals[p["pos"]].append(p.get("ep_base_k") or 0)
    off_target_k = projected_spend_k * (sum(bfv.AUCTION_BUCKET_SPEND_K[b] for b in SKILL)
                                        / sum(bfv.AUCTION_BUCKET_SPEND_K.values()))
    coherence = bfv.coherence_check(off_vals, off_target_k)
    # budget_scale ships to the client kernels so a normalized board's OVERRIDE recompute stays
    # consistent. Default = 1.0 (off): the served EP is per-player and the check above is a diagnostic.
    budget_scale = 1.0

    def re_verdict(ep_k, worth_k, p90):
        vr = round(worth_k / ep_k, 2) if ep_k > 0 else None
        if vr is None: return ("—", None)
        if vr >= 1.5 and worth_k >= 15: return ("SPLURGE", vr)   # real edge, well under price
        if vr >= 1.2: return ("VALUE", vr)
        if vr >= 0.8: return ("FAIR", vr)
        if ep_k <= 4: return ("DART" if (p90 or 0) >= 5 else "FAIR", vr)
        if ep_k < 15: return ("FAIR", vr)                        # cheap startable = market slot-rent, not an overpay
        return ("OVERPAY", vr) if vr < 0.6 else ("FAIR", vr)     # real overpay only on a non-trivial price

    def need_label(fid, pos):
        f = team[fid]["fit"][pos]; b = B[pos] or 0.01
        thin = f["need"] > 0.4 * b
        deep = f["surplus"] > 0.8 * b
        if not f["has_stud"]:
            return "NEED-STUD" if thin else "DEPTH"
        if thin: return "NEED"
        if deep: return "SURPLUS"
        return "OK"

    def comp_score(t, pos):
        f = t["fit"][pos]
        return f["need"] + max(0.0, STUD[pos] - f["top_apw"])

    def competition(pos):
        cands = []
        for fid, t in team.items():
            if fid == "0008": continue
            f = t["fit"][pos]
            cs = comp_score(t, pos)
            # Keith 2026-07-23: quality, not just quantity. A room full of cheap
            # sub-stud starters (e.g. QB12 + QB18 on $1-4K deals) does NOT take a
            # team out of the market for a top FA at that position — expect them
            # in on the studs. So a no-stud room ALWAYS qualifies as competition
            # (capspace weighting still ranks who can actually pay); the score
            # gate only screens teams that genuinely have the position covered.
            if cs > 0.3 * (B[pos] or 0.01) or not f["has_stud"]:
                cands.append((cs * max(0.05, t["capspace"] / CAP), fid, t["team"], round(cs, 2), t["capspace"]))
        cands.sort(reverse=True)
        return [{"fid": fid, "team": tm, "need": nd, "capspace": cs} for _, fid, tm, nd, cs in cands[:3]]

    # ---- LIVE REGIME (the v5 inputs; computed and REPORTED whether or not v5 is applied) ----
    # R = biddable value ÷ available value. Money is Σcapspace MINUS the per-team mandatory-starter
    # reserve — the cash that genuinely cannot chase a skill player. Value is Σ redraft worth of the
    # credible pool. Both halves are reconstructed identically for 2022-25 by build_ep_v5_calibration.
    R_now = round((ceiling_headroom_k - reserve_total_k) / credible_rworth_k, 4)
    # D = Σ comp_score ONLY. Cap space is deliberately absent: it already drives M_money, and
    # weighting demand by it as well would square the money signal (the double-count fix).
    demand = {pos: round(sum(comp_score(t, pos) for t in team.values()), 3) for pos in SKILL}
    supply = {pos: sum(1 for p in credible if p["pos"] == pos) for pos in SKILL}
    z_now = {pos: (round(demand[pos] / supply[pos], 4) if supply[pos] else None) for pos in SKILL}

    K = (cal or {}).get("constants", {})
    lam, gam = K.get("lambda", 0.0), K.get("gamma", 0.0)
    Rbar, zbar = K.get("R_bar"), K.get("z_bar", {}) or {}
    mm_lo, mm_hi = K.get("m_money_clamp", [0.80, 1.60])
    mp_lo, mp_hi = K.get("m_pos_clamp", [0.85, 1.35])
    elite_f = K.get("elite_factor", 1.0) if K.get("elite_enabled") else 1.0
    elite_n = K.get("elite_top_n", 3)

    m_money_raw = (1 + lam * (R_now / Rbar - 1)) if Rbar else 1.0
    m_money = clamp(m_money_raw, mm_lo, mm_hi) if (use_v5 and Rbar) else 1.0
    # EXTRAPOLATION GUARD. λ was fitted over a narrow band of R; outside it the multiplier is being
    # set by the clamp, not by anything measured. Say so loudly rather than serve a confident number.
    R_range = K.get("R_observed_range")
    extrapolating = bool(R_range and not (R_range[0] <= R_now <= R_range[1]))
    clamped = bool(use_v5 and abs(m_money - m_money_raw) > 1e-9)
    m_pos = {pos: (clamp(1 + gam * (z_now[pos] / zbar[pos] - 1), mp_lo, mp_hi)
                   if (use_v5 and z_now.get(pos) and zbar.get(pos)) else 1.0) for pos in SKILL}
    elite_names, elite_display = set(), []
    if use_v5 and K.get("elite_enabled"):
        for pos in SKILL:
            for p in sorted([x for x in credible if x["pos"] == pos],
                            key=lambda x: -(x.get("redraft_worth_k") or 0))[:elite_n]:
                elite_names.add(nkey(p["player"]))
                elite_display.append(p["player"])   # DISPLAY names for the client kernels — the
                                                    # blob must not require a JS port of nkey()

    # ---- EXPECTED PRICE ----
    # v4: EP is FINAL from build_fa_value — max(startability floor ∨ affine ∨ dynasty anchor).
    # v5: the two MARKET arms are scaled by the regime; the startability floor is NOT (a slot's rent
    #     is a rule of the roster, not a market opinion), which is why the floor sits outside.
    for p in core:
        fl = p.get("ep_arm_floor_k", 0)
        mkt = max(p.get("ep_arm_affine_k", 0), p.get("ep_arm_dyn_anchor_k", 0))
        mp_p = m_pos.get(p["pos"], 1.0)
        el = elite_f if nkey(p["player"]) in elite_names else 1.0
        ep = round(max(fl, mkt * m_money * mp_p * el)) if use_v5 else p["ep_base_k"]
        p["ep_v4_k"] = p["ep_base_k"]
        p["ep_v5_k"] = round(max(fl, mkt * m_money * mp_p * el))
        p["m_money"] = round(m_money, 4); p["m_pos"] = round(mp_p, 4); p["m_elite"] = round(el, 4)
        p["ep_k"] = ep; p["median_k"] = ep
        p["low_k"] = round(ep * 0.78); p["top10_k"] = round(ep * 1.3)
        p["gap_k"] = ep - p["worth_k"]
        p["per_apwe"] = round(ep / p["e_apwe_p50"], 1) if (p.get("e_apwe_p50") or 0) > 0 else None
        v, vr = re_verdict(ep, p["worth_k"], p["e_apwe_p90"])
        p["verdict"] = v; p["value_ratio"] = vr

    # how far the credible board is priced over intrinsic redraft worth (descriptive only)
    markup = round(sum(p["ep_k"] for p in credible) / credible_rworth_k, 2) if credible_rworth_k else 1.0
    gate = (cal or {}).get("ship_gate_detail", {})
    arms = collections.Counter(p.get("ep_arm") for p in credible)
    market = {   # key stays "inflation" in meta for View back-compat; nothing here is a hand-set knob
        "model": ("v5-regime" if use_v5 else "v4-affine"), "ep_model_flag": args.ep_model,
        "ante": bfv.AFFINE_ANTE, "slope": bfv.AFFINE_SLOPE, "deploy_frac": DEPLOY_FRAC,
        "ceiling_headroom_k": round(ceiling_headroom_k), "biddable_money_k": biddable_money_k,
        "reserve_total_k": round(reserve_total_k), "credible_value_k": credible_rworth_k,
        "n_credible": len(credible), "surplus_k": round(surplus_k), "board_markup": markup,
        "binding_arm_mix_credible": dict(arms),
        "coherence": {**coherence, "projected_spend_parts": spend_parts, "budget_scale": budget_scale,
                      "note": "OFFENSE predicted-clearing-set (top-N per bucket by price) vs projected offense "
                              "spend. status=FAIL usually means a value-inflated FA pool (pre-roster-lock snapshot); "
                              "2022-25 boards sit 0.66-0.97. Enforcement hurts winner MAE, so budget_scale defaults 1.0."},
        "regime": {"R_now": R_now, "R_bar": Rbar, "R_observed_range": R_range,
                   "demand": demand, "supply": supply, "z_now": z_now, "z_bar": zbar,
                   "m_money": round(m_money, 4), "m_money_raw": round(m_money_raw, 4),
                   "m_money_clamped": clamped, "extrapolating": extrapolating,
                   "m_pos": {k: round(v, 4) for k, v in m_pos.items()},
                   "elite_factor": elite_f, "n_elite": len(elite_names),
                   "lambda": lam, "gamma": gam,
                   "warning": (None if not (extrapolating or clamped) else
                               f"LIVE R {R_now} is outside the fitted range {R_range}. M_money "
                               f"{'is pinned to its clamp' if clamped else 'is extrapolated'} "
                               f"(raw {round(m_money_raw,3)} → served {round(m_money,3)}): the board-wide "
                               f"markdown is being set by a Keith-tunable bound, NOT by a measured "
                               f"relationship. 2026 carries far more unrostered credible worth "
                               f"(${credible_rworth_k}K) than any fitted season, so the money/value "
                               f"regime is genuinely off the end of the training data. Sanity-check the "
                               f"board against v4 (--ep-model v4) before trusting the level.")},
        "calibration": None if not cal else {
            "ship_gate": cal.get("ship_gate"), "applied": use_v5,
            "loyo": gate.get("v4") and {"v4": gate["v4"], "v5": gate["v5"]},
            "power_warning": gate.get("power_warning"),
            "gamma_sign_guarded": K.get("gamma_sign_guarded"),
            "arm_truth_credible": (cal.get("arm_truth", {}).get("credible", {}) or {}).get("arms"),
            "coverage_warning": cal.get("arm_truth", {}).get("coverage_warning"),
        },
        "note": (f"EP = max(startability floor, affine {bfv.AFFINE_ANTE}+{bfv.AFFINE_SLOPE}·redraft_worth, "
                 f"position-weighted dynasty anchor)"
                 + (f", with the two MARKET arms scaled by M_money {round(m_money,3)} × M_pos "
                    f"{ {k: round(v,2) for k, v in m_pos.items()} } (v5, fitted by "
                    f"build_ep_v5_calibration.py and past its leave-one-year-out ship gate)."
                    if use_v5 else " (v4 — v5 regime multipliers NOT applied).")
                 + f" Board prices ~{markup}× intrinsic redraft worth; ${round(surplus_k)}K of locked "
                   f"rostered surplus, ${round(reserve_total_k)}K held league-wide for mandatory "
                   f"K/P/IDP starters. Credible-pool binding arms: {dict(arms)}."),
    }
    inflation = market   # legacy alias — the View reads meta.inflation

    # ---- the board: available FAs (own=None) + rostered trade targets (own=fid) ----
    TRADE_FLOOR = 2.0   # only rostered players actually worth trading FOR
    fas = []
    for p in core:
        pos = p["pos"]
        nm = nkey(p["player"])
        owner = rostered_by_name.get(nm)
        if owner and (p.get("worth_k") or 0) < TRADE_FLOOR:
            continue
        comp = competition(pos) if (pos in SKILL and not owner) else []
        ctr = contract_by_name.get(nm) if owner else None
        rec = {**p, "own": owner, "contract": ctr,
               "fit_0008": need_label("0008", pos) if pos in SKILL else "—",
               "competition": comp}
        # a trade target isn't in the auction → its "price" is its contract AAV, not the auction EP.
        if owner and ctr:
            rec["aav_k"] = ctr.get("aav_k"); rec["sal_k"] = ctr.get("sal_k")
            rec["trade_gap_k"] = (ctr.get("aav_k") or 0) - (p.get("worth_k") or 0)   # vs TRUE AAV; neg = worth > AAV = surplus
        fas.append(rec)
    fas.sort(key=lambda x: -(x.get("worth_k") or 0))

    # ── LIVE-REPRICE BASELINE (the per-position competition census, frozen at build time) ──
    # Keith's scenario: "if a bunch of teams have 2 QBs you might not have much competition for a
    # lower-priced QB3." The auction almost never SELLS 24 QBs (teams walk in already holding their
    # starters on dynasty contracts), so the demand that collapses is a ROSTER + AFFORDABILITY fact,
    # not an auction-clear fact — see docs/auction/live_reprice.md for the backtest that establishes this.
    # We freeze WHO the credible rivals are per position now (same membership test as competition():
    # comp_score > 0.3·B[pos], excluding 0008). The client counts how many of them are STILL live
    # (haven't filled the slot via a win AND can still afford the floor rent) and marks the position's
    # price down toward that surviving-competition ratio. Purely a census here — no price effect until
    # the client sees --live-reprice AND a live board.
    base_comp_fids = {pos: sorted([fid for fid, t in team.items()
                                   if fid != "0008" and comp_score(t, pos) > 0.3 * (B[pos] or 0.01)])
                      for pos in SKILL}
    live_reprice = {
        "enabled": bool(args.live_reprice),
        "base_comp_fids": base_comp_fids,                 # rival franchises credibly in the market per pos (build-time)
        "base_comp": {pos: len(v) for pos, v in base_comp_fids.items()},
        "slots": SLOTS,                                    # SF starting demand per team (QB/RB/WR 2, TE 1)
        # tunables (NOT fitted — this is a forward-looking demand census, not a price regression):
        "elast": 0.5,         # M = (surviving/base)^elast; 0.5 = sqrt → gentle, a halving → ~0.71×
        "floor_k": 3,         # a rival with < $3K max-bid at the pos can no longer credibly contest it
        "shrink": 1,          # Laplace k on the ratio so small rival counts don't swing violently
        "lo": 0.70, "hi": 1.15,   # demand can collapse (0.70) more than it can spike (1.15) mid-auction
        "note": "client: for each pos, surviving = #base rivals that (a) have won 0 at pos AND "
                "(b) still afford ≥ floor_k (from the live budget rows). M_live = clamp(((surviving+k)/"
                "(base+k))^elast, lo, hi). Applied to the MARKET arms only (never the startability floor), "
                "on top of the static m_money·m_pos. Missing budgets/lots → M_live = 1 (static price).",
    }

    # ---- POSITIONAL TIERS — the worth-vs-price dropoff ("do I need mid RBs, or is the cliff steep?") ----
    # Per position, the AVAILABLE pool sorted by worth → named tiers → avg redraft/dynasty worth + price.
    # The View blends rw/dw on the slider and shows the tier-over-tier worth dropoff vs the price dropoff
    # (a shallow worth drop + steep price drop = the efficiency sweet spot).
    TIER_DEFS = {
        "QB": [("Elite", 1, 3), ("High", 4, 8), ("Mid", 9, 16), ("Streamer", 17, 30)],
        "RB": [("Elite", 1, 4), ("High", 5, 12), ("Mid", 13, 24), ("Depth", 25, 42)],
        "WR": [("Elite", 1, 6), ("High", 7, 16), ("Mid", 17, 30), ("Depth", 31, 50)],
        "TE": [("Elite", 1, 3), ("High", 4, 8), ("Mid", 9, 14), ("Streamer", 15, 26)],
    }
    tiers = {}
    for pos in SKILL:
        pool = sorted([p for p in fas if not p.get("own") and p["pos"] == pos], key=lambda x: -(x.get("worth_k") or 0))
        rows = []
        for label, lo, hi in TIER_DEFS[pos]:
            grp = pool[lo - 1:hi]
            if not grp:
                continue
            n = len(grp)
            rows.append({"label": label, "lo": lo, "hi": min(hi, lo + n - 1), "n": n,
                         "rw": round(sum(p["redraft_worth_k"] for p in grp) / n),
                         "dw": round(sum(p["dynasty_worth_k"] for p in grp) / n),
                         "ep": round(sum(p["ep_k"] for p in grp) / n),
                         "top": grp[0]["player"]})
        if rows:
            tiers[pos] = rows

    # ---- post-auction fill context ----
    c = sqlite3.connect(DB)
    fill = []
    for s in range(2020, 2026):
        end = c.execute("SELECT MAX(date_et) FROM transactions_auction WHERE season=? AND auction_type='FreeAgent'", (s,)).fetchone()[0]
        wins = c.execute("SELECT COUNT(*) FROM transactions_auction WHERE season=? AND auction_type='FreeAgent' AND finalbid_ind=1", (s,)).fetchone()[0]
        adds = c.execute("SELECT COUNT(*) FROM transactions_adddrop WHERE season=? AND move_type='ADD' AND date_et > ? AND date_et <= ?",
                         (s, end or f"{s}-08-01", f"{s}-09-08")).fetchone()[0]
        fill.append({"season": s, "auction_end": end, "wins_per_team": round(wins / 12, 1), "post_auction_adds_per_team": round(adds / 12, 1)})
    fill_avg = round(sum(f["post_auction_adds_per_team"] for f in fill) / len(fill), 1)

    payload = {
        "meta": {
            "generated": "build_roster_fit.py", "n_fas": len(fas),
            "worth_model": {"dollar_per_apwe": 6.5, "default_dyn_weight": 0.5,
                            "note": "WORTH=blend(redraft E[APWE]×$6.5, dynasty cardinal value×$/val); slider blends live"},
            # ── client recompute KERNEL (ADP override): everything the View needs to re-derive a player's
            # E[APWE]/worth/expected-price at a DIFFERENT redraft positional rank, reproducing build_fa_value
            # EXACTLY. EP = round(max( startability(pos,rank), ante+slope·round(p50[rank]·$/APWE),
            # dynasty_worth·pos_dyn_w[pos] )). Only the redraft axis + startability floor + affine move with
            # rank; dynasty_worth (the KTC asset value) does NOT. Curves are fpros E[APWE] by 1-based rank.
            "model": {
                "dollar_per_apwe": bfv.DOLLAR_PER_APWE, "affine_ante": bfv.AFFINE_ANTE, "affine_slope": bfv.AFFINE_SLOPE,
                "pos_dyn_w": bfv.POS_DYN_W, "startability": bfv.STARTABILITY, "curve_max_rank": MODEL_CURVE_MAXRANK,
                # budget_scale: OPTIONAL per-position (or scalar) market-arm multiplier for a budget-normalized
                # board. Default 1.0 = identity (no change). The client kernels multiply the market arm by it so
                # an ADP-override recompute matches a normalized board. Absent/1.0 → kernels behave exactly as before.
                "budget_scale": budget_scale,
                # curves capped at MODEL_CURVE_MAXRANK (every startable override lives well inside this; the client
                # clamps a higher rank to the last entry). p50 stays at FULL 2-decimal precision — the pipeline
                # computes redraft_worth = round(p50·$/APWE) off the 2dp value, so the client MUST use 2dp to
                # reproduce EP exactly. p90 is display/ceiling only (never feeds EP) → integer is plenty.
                "curves": {pos: {"p50": [round(v, 2) for v in curve[pos]["p50"][:MODEL_CURVE_MAXRANK]],
                                 "p90": [round(v) for v in curve[pos]["p90"][:MODEL_CURVE_MAXRANK]]} for pos in curve},
                # v5 regime factors. ALL DEFAULT TO 1 — a client reading an older blob (or a blob built
                # with --ep-model v4) computes exactly the v4 number, so the kernels are back-compatible
                # by construction. m_pos is per-position; m_elite applies to the named elite set only.
                "m_money": round(m_money, 4),
                "m_pos": {k: round(v, 4) for k, v in m_pos.items()},
                "m_elite": elite_f, "elite_players": sorted(elite_display),
                "note": "ep=round(max(startability(pos,rank), (affine_ante+affine_slope*round(p50[r]*$apwe)) "
                        "∨ dyn_worth*pos_dyn_w[pos] scaled by m_money*m_pos[pos]*m_elite)); r=min(rank,len)-1; "
                        "the startability floor is NOT scaled (slot rent is a roster rule, not a market opinion)",
            },
            "inflation": inflation,
            "tiers": tiers,
            "baseline_apw": {pos: round(B[pos], 2) for pos in SKILL},
            "stud_bar": {pos: round(STUD[pos], 2) for pos in SKILL},
            "replacement_rank": REPL_RANK, "starter_slots": SLOTS,
            "live_reprice": live_reprice,
            "fill": {"by_season": fill, "avg_post_auction_adds_per_team": fill_avg,
                     "note": "adds between auction-end and ~Week 1; high = teams lock in fewer at auction and fill via waivers"},
            "verdict_legend": "SPLURGE/VALUE/FAIR/OVERPAY/DART by value_ratio=worth/EP; EP=expected clearing price, WORTH=blended value",
        },
        "teams": {fid: {"team": t["team"], "capspace": t["capspace"], "fit": t["fit"]} for fid, t in team.items()},
        "fas": [{
            "player": p["player"], "pos": p["pos"], "age": p["age"], "own": p.get("own"),
            "owner_team": (team.get(p["own"], {}).get("team") if p.get("own") else None),
            "contract": p.get("contract"), "aav_k": p.get("aav_k"), "trade_gap_k": p.get("trade_gap_k"),
            "dyn_sf_rank": p["dyn_sf_rank"], "redraft_rank": p["redraft_rank"], "fp_rank": p.get("fp_rank"),
            "dyn_value": p.get("dyn_value"),
            "win_now": p["win_now"], "asset": p["asset"], "deal_type": p["deal_type"],
            "redraft_worth_k": p["redraft_worth_k"], "dynasty_worth_k": p["dynasty_worth_k"],
            "worth_k": p["worth_k"], "ep_base_k": p["ep_base_k"], "ep_k": p["ep_k"],
            "ep_v4_k": p["ep_v4_k"], "ep_v5_k": p["ep_v5_k"],
            "ep_arm": p.get("ep_arm"), "ep_arm_floor_k": p.get("ep_arm_floor_k"),
            "ep_arm_affine_k": p.get("ep_arm_affine_k"), "ep_arm_dyn_anchor_k": p.get("ep_arm_dyn_anchor_k"),
            "m_money": p["m_money"], "m_pos": p["m_pos"], "m_elite": p["m_elite"],
            "low_k": p["low_k"], "median_k": p["median_k"], "top10_k": p["top10_k"], "gap_k": p["gap_k"],
            "e_apwe_p25": p["e_apwe_p25"], "e_apwe_p50": p["e_apwe_p50"], "e_apwe_p90": p["e_apwe_p90"],
            "per_apwe": p["per_apwe"], "value_ratio": p["value_ratio"], "verdict": p["verdict"],
            "fit_0008": p["fit_0008"], "competition": p["competition"],
        } for p in fas],
    }
    (DATA / "fa_value.json").write_text(json.dumps(payload, indent=2))
    blob_len = len(json.dumps(payload))
    print(f"wrote {(DATA / 'fa_value.json').relative_to(REPO)} ({len(fas)} FAs, blob {blob_len/1024:.1f}KB)")

    # ---- CSV (the audit trail: every number on one line is reconstructable by hand) ----
    cols = ["player", "pos", "status", "owner", "dyn_sf_rank", "fp_rank",
            "redraft_worth_k", "dynasty_worth_k", "worth_k",
            "ep_arm_floor_k", "ep_arm_affine_k", "ep_arm_dyn_anchor_k", "ep_arm",
            "m_money", "m_pos", "m_elite", "ep_v4_k", "ep_v5_k", "ep_k", "gap_k",
            "e_apwe_p50", "e_apwe_p90", "per_apwe", "value_ratio", "verdict", "fit_0008", "deal_type", "top_competitors"]
    with open(DATA / "fa_valuation.csv", "w", newline="") as f:
        f.write(f"# EP_MODEL,{market['model']},flag={args.ep_model},ship_gate={(cal or {}).get('ship_gate')}\n")
        f.write(f"# ARMS,ep=max(floor, affine, dyn_anchor); v5 scales max(affine,dyn_anchor) by "
                f"m_money*m_pos*m_elite (floor never scaled)\n")
        f.write(f"# REGIME,R_now={R_now},R_bar={Rbar},lambda={lam},gamma={gam},"
                f"m_money={round(m_money,4)},m_pos={ {k: round(v,3) for k, v in m_pos.items()} }\n")
        f.write(f"# TUNABLES (NOT fitted),m_money_clamp={[mm_lo, mm_hi]},m_pos_clamp={[mp_lo, mp_hi]},"
                f"POS_DYN_W={bfv.POS_DYN_W},dyn_anchor_$75K,startability_floor_table\n")
        f.write(f"# BACKTEST (LOYO 2022-25, credible clears),v4={gate.get('v4')},v5={gate.get('v5')}\n")
        f.write(f"# ARM_TRUTH (credible historical clears),"
                f"{(cal or {}).get('arm_truth', {}).get('credible', {}).get('arms')}\n")
        f.write(f"# WARNING,{(cal or {}).get('arm_truth', {}).get('coverage_warning', '')}\n")
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        for p in fas:
            w.writerow({**p, "status": "rostered" if p.get("own") else "FA",
                        "owner": team.get(p["own"], {}).get("team", "") if p.get("own") else "",
                        "top_competitors": "; ".join(x["team"] for x in p["competition"])})
    print(f"wrote {(DATA / 'fa_valuation.csv').relative_to(REPO)}")
    n_avail = sum(1 for p in fas if not p.get("own")); n_rost = len(fas) - n_avail
    print(f"  ({n_avail} available FAs + {n_rost} rostered trade targets)")

    # ---- summaries ----
    print(f"\n=== MARKET CONTEXT ({market['model']}, --ep-model {args.ep_model}) ===")
    print(f"  Σ ceiling headroom ${market['ceiling_headroom_k']}K · ${round(reserve_total_k)}K held for "
          f"mandatory K/P/IDP starters → biddable ${biddable_money_k}K (deploy ×{DEPLOY_FRAC}, descriptive)")
    print(f"  credible redraft-worth ${credible_rworth_k}K ({len(credible)} targets) → board prices ~{market['board_markup']}× over intrinsic worth")
    print(f"  locked rostered surplus (worth−cost, positive): ${market['surplus_k']}K")
    print(f"  BUDGET COHERENCE (offense): predicted clearing ${coherence['predicted_clearing_k']}K / "
          f"projected offense spend ${coherence['projected_spend_k']}K = ratio {coherence['ratio']} "
          f"[band {coherence['band'][0]}-{coherence['band'][1]}] status={coherence['status']}"
          + (f"  *** {coherence['n_contract_star_fa']} FA >= ${coherence['contract_star_threshold_k']}K — check for a pre-roster-lock pool ***"
             if coherence['status'] == 'FAIL' else ""))
    print(f"  credible-pool binding arms: {dict(arms)}")
    if cal:
        print(f"  regime: R_now {R_now} vs R̄ {Rbar} → M_money {round(m_money,3)} · "
              f"M_pos {{{', '.join(f'{k} {v:.2f}' for k, v in m_pos.items())}}} "
              f"(λ {lam}, γ {gam}{' [sign-guarded to 0]' if K.get('gamma_sign_guarded') else ''})")
        print(f"  ship_gate {cal.get('ship_gate')} → v5 {'APPLIED' if use_v5 else 'NOT applied'}"
              f" | LOYO $wMAE v4 ${(gate.get('v4') or {}).get('dw_mae')}K → v5 ${(gate.get('v5') or {}).get('dw_mae')}K")
        if market["regime"]["warning"]:
            print(f"  ⚠ EXTRAPOLATION: {market['regime']['warning']}")
    else:
        print(f"  ⚠ {CALIBRATION.name} missing — serving v4. Run build_ep_v5_calibration.py.")
    print(f"\n=== EP by arm (v4 → served) ===")
    for nm in ["Joe Mixon", "Stefon Diggs", "Aaron Rodgers", "Sam Darnold", "Travis Kelce", "Ja'Marr Chase"]:
        p = next((r for r in core if r["player"].startswith(nm)), None)
        if p: print(f"  {p['player'][:20]:<21}{str(p.get('fp_rank') or '-'):>6}  worth ${p['worth_k']:>3}  "
                    f"floor ${p['ep_arm_floor_k']:>3} aff ${p['ep_arm_affine_k']:>6.1f} dyn ${p['ep_arm_dyn_anchor_k']:>6.1f} "
                    f"[{p['ep_arm']:<10}]  v4 ${p['ep_v4_k']:>3} → ${p['ep_k']:>3}  gap {('+' if p['gap_k']>=0 else '')}{p['gap_k']}  {p['verdict']}")
    print(f"\n=== 0008 roster fit ===")
    for pos in SKILL:
        ff = team["0008"]["fit"][pos]
        print(f"  {pos}: need {ff['need']:.1f}  surplus {ff['surplus']:.1f}  → {need_label('0008', pos)}")
    print(f"\n=== top FA targets (by worth, expected clearing price) ===")
    print(f"  {'player':<20}{'fpRk':>6}{'worth':>6}{'EP':>5}{'gap':>6}  {'verdict':<8}{'fit':<10}competition")
    for p in [x for x in fas if not x.get("own")][:14]:
        print(f"  {p['player'][:19]:<20}{str(p.get('fp_rank') or '-'):>6}{p['worth_k']:>6}{p['ep_k']:>5}"
              f"{(('+' if p['gap_k']>=0 else '')+str(p['gap_k'])):>6}  {p['verdict']:<8}{p['fit_0008']:<10}{', '.join(x['team'] for x in p['competition'][:2])}")

    if args.push_d1:
        # The View RE-DERIVES worth/gap/value_ratio/verdict from (rw, dw, e) + the live blend
        # slider, so the blob only carries the two worth components + the served expected price.
        def r1(v): return round(v, 1) if isinstance(v, (int, float)) else v
        DT = {"cut-free dart": "d", "1-yr rental / flip": "r", "multi-year build": "m",
              "anchor": "a", "1-yr / situational": "s"}
        FT = {"NEED-STUD": "NS", "DEPTH": "D", "NEED": "N", "SURPLUS": "S", "OK": "-", "—": "-"}
        lean = {
            "meta": payload["meta"],
            "key": {"n": "player", "p": "pos", "dr": "dyn_sf_rank", "fr": "fp_rank",
                    "rw": "redraft_worth_k", "dw": "dynasty_worth_k", "e": "ep_k (served expected clearing price; FA)",
                    "av": "aav_k = TRUE AAV = TCV/CL (the smoothed annual = trade-target price; owned only)",
                    "sl": "sal_k = current-year cap hit (what you pay THIS year; owned only)", "tcv": "tcv_k", "cl": "contract_len", "cy": "years_remaining",
                    "a50": "e_apwe_p50", "a90": "e_apwe_p90", "dt": "deal_type",
                    "f": "fit_0008", "c": "competition_fids", "o": "owner_fid (null=available FA)",
                    "derived": "worth=blend(rw,dw,dynW); FA gap=e−worth; trade-target gap=av−worth; verdict from worth/price",
                    "_dt": {v: k for k, v in DT.items()},
                    "_f": {"NS": "NEED-STUD", "D": "DEPTH", "N": "NEED", "S": "SURPLUS", "-": "OK"}},
            "teams": {fid: {"team": t["team"], "capspace": t["capspace"],
                            "fit": {pos: {"need": t["fit"][pos]["need"], "surplus": t["fit"][pos]["surplus"],
                                          "stud": t["fit"][pos]["has_stud"]} for pos in SKILL}}
                      for fid, t in team.items()},
            "fas": [
                ({"n": p["player"], "p": p["pos"], "dr": p["dyn_sf_rank"], "o": p["own"],
                  "rw": p["redraft_worth_k"], "dw": p["dynasty_worth_k"], "e": p["ep_k"],
                  "av": (p.get("contract") or {}).get("aav_k"), "sl": (p.get("contract") or {}).get("sal_k"),
                  "tcv": (p.get("contract") or {}).get("tcv_k"),
                  "cl": (p.get("contract") or {}).get("cl"), "cy": (p.get("contract") or {}).get("cy"),
                  "a50": r1(p["e_apwe_p50"]), "a90": r1(p["e_apwe_p90"])}
                 if p.get("own") else
                 {"n": p["player"], "p": p["pos"], "dr": p["dyn_sf_rank"], "fr": p.get("fp_rank"),
                  "dt": DT.get(p["deal_type"], "s"),
                  "rw": p["redraft_worth_k"], "dw": p["dynasty_worth_k"], "e": p["ep_k"],
                  "a50": r1(p["e_apwe_p50"]), "a90": r1(p["e_apwe_p90"]),
                  "f": FT.get(p["fit_0008"], "-"), "c": [x["fid"] for x in p["competition"][:3]]})
                for p in fas],
        }
        blob = json.dumps(lean, separators=(",", ":")).replace("'", "''")
        print(f"\n  (lean D1 blob {len(blob)/1024:.1f}KB)")
        ts = int(time.time())
        tmp = WORKER / ".tmp"; tmp.mkdir(parents=True, exist_ok=True)
        sql_path = tmp / "fa_value_upsert.sql"
        # D1 rejects a single SQL statement over 100,000 bytes (SQLITE_TOOBIG), and the v5
        # meta pushed the single-INSERT form past it (2026-07-23). Write the blob as an
        # INSERT of the first chunk + string-append UPDATEs for the rest — every statement
        # stays well under the cap, the table/worker/View stay unchanged (still one row,
        # one payload), and this scales however large the blob grows. NOTE: chunk on the
        # ESCAPED string; never split between the two quotes of an escaped '' pair.
        CHUNK = 90_000
        chunks = []
        i = 0
        while i < len(blob):
            end = min(i + CHUNK, len(blob))
            if end < len(blob) and blob[end - 1] == "'" and blob[end] == "'":
                end -= 1                       # don't split an escaped quote pair
            chunks.append(blob[i:end]); i = end
        stmts = [f"INSERT OR REPLACE INTO ups_auction_fa_value (id, payload, updated_at) VALUES (1, '{chunks[0]}', {ts});\n"]
        for c in chunks[1:]:
            stmts.append(f"UPDATE ups_auction_fa_value SET payload = payload || '{c}' WHERE id = 1;\n")
        sql_path.write_text("".join(stmts))
        print(f"  pushing fa_value blob to D1 ({len(blob)} bytes, {len(chunks)} chunk{'s' if len(chunks) > 1 else ''}) …")
        subprocess.run(["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db", "--remote", "--file", str(sql_path)], cwd=str(WORKER), check=True)
        print("  pushed ups_auction_fa_value")


if __name__ == "__main__":
    main()
