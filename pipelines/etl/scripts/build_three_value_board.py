#!/usr/bin/env python3
"""THREE-VALUE BOARD — one row per player, three separately-defensible numbers.

Keith asked for three values. They are NOT three slices of one number and they do NOT sum:

  1. current_season_value_k  — worth for 2026 ONLY (redraft basis).
       OFFENSE: E[APWE] at the player's FantasyPros redraft slot × $/APWE. This is the
       all-play wins his production earns you in THIS league's scoring, converted to $K.
       IDP/K/P: the UPS auction order-statistic ladder at his within-position rank (see §IDP).

  2. ultimate_value_k        — long-term ASSET value INCLUDING contract surplus.
       ultimate = dynasty_value_raw + contract_surplus
       dynasty_value_raw = the multi-panel dynasty consensus × $/value-unit (the asset).
       contract_surplus  = Σ over REMAINING contract years of (what he'd cost on the open
                           market that year − what his contract actually pays), decayed for
                           age and discounted for time:
             surplus = Σ_{t=1..cy} DISC^(t-1) · ( ep_equiv_k · DECAY[pos]^(t-1) − aav_k )
       An UNDERPAID player is worth MORE than his raw asset value; an OVERPAID one is worth
       LESS. A free agent has no contract yet — his surplus is 0 by construction, because an
       auction win becomes a 1-year Vet-FAA at exactly the price paid (§league_context B/FAA).
       ** ultimate is NOT a triple sum, and option value is NOT folded in — see option_band. **

  3. fa_value_k              — expected AUCTION PRICE, auction-eligible (unrostered) rows only.
       OFFENSE: the served EP model (v5) = round(max(floor, max(affine, dyn_anchor)·M_money)).
       IDP/K/P: the UPS auction order-statistic ladder (this league's own realized clears).
       Blank for rostered players — they are not in the auction.

OPTIONS ARE A BAND, NOT A SCALAR (option_band column). Extension strikes are +$10K/1yr and
+$20K/2yr on Schedule 1 (QB/RB/WR/TE) and +$3K/1yr, +$5K/2yr on Schedule 2 (DL/LB/DB/PK/PN);
the tag strike is max(positional tier salary, 1.10 × prior AAV). Folding an option premium into
ultimate_value would double-count the surplus already priced into contract_surplus_k, so it is
shown as a LABEL and never added to any scalar.

§IDP — THE HONEST CAVEAT ────────────────────────────────────────────────────────────────────
IDP, K and P are MANDATORY STARTERS here (7 of 18 starting slots are defense; 1 K + 1 P more),
but they are NOT on the offense value scale and they never have been:
  • Offense is priced from THREE independent cardinal panels (FantasyCalc, KeepTradeCut,
    DynastyProcess) whose dynasty values carry real tiering.
  • IDP has exactly ONE source (FantasyPros dynasty-IDP ECR) run through a hand-made LINEAR
    ramp, `idpVal = 10000 − rank·45` (worker/src/index.js). Converted at the same $/value-unit
    the offense board uses, that ramp claims the IDP1 is worth ~$74K and a rank-100 IDP ~$41K.
    THE UPS LEAGUE HAS NEVER PAID MORE THAN $15K FOR ANY IDP IN THE SF ERA, and the median
    IDP clear is $1-2K. The ramp is not merely mis-scaled, it is off by 10-40× in the middle.
  • K and P have NO dynasty source at all — none, anywhere in the pipeline.

So this board does NOT use the ramp. For IDP/K/P it prices off THIS LEAGUE'S OWN AUCTION
ARCHIVE: for each position bucket, the k-th most expensive clear in a season, averaged across
2022-25, gives an order-statistic ladder ("the 3rd-best LB in a given auction goes for $X").
The player's rank within his position (FantasyPros dynasty-IDP ECR where it exists, MFL
league-scoring projections otherwise, and always for K/P) picks his rung.

CONSEQUENCE, STATED PLAINLY: for IDP/K/P the VALUE axis and the PRICE axis are the SAME
measurement — both come from the ladder. There is no independent value signal, so a
value-vs-price surplus verdict on an IDP/K/P row is meaningless. Those rows carry
scale_trust=idp-linear-1source / none and the raw ramp number is echoed in idp_ramp_value_k so
the distortion stays visible instead of being laundered into a confident dollar figure.

Regenerate (e.g. Thursday after the roster lock):
    python3 pipelines/etl/scripts/build_three_value_board.py --refresh
"""
from __future__ import annotations
import argparse, collections, csv, datetime, itertools, json, re, sqlite3, statistics, subprocess, sys, time, urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_fa_value as bfv          # EP arms: AFFINE_*, POS_DYN_W, STARTABILITY, PER_VALUE, $/APWE

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
WORKER_DIR = REPO / "worker"                 # wrangler cwd for the --push-d1 D1 upsert
OUT = DATA / "three_value_board.csv"
OUT_SHOP = DATA / "three_value_shopping_list.csv"
CANON = Path("/tmp/ups_auction_canon.db")
CACHE = Path("/tmp/ups_three_value_cache")

LEAGUE, YEAR, CAP_K = "74598", 2026, 300
ME = "0008"                            # Real Deal Creel
MFL = f"https://www48.myfantasyleague.com/{YEAR}/export"
WORKER = "https://upsmflproduction.keith-creelman.workers.dev"
SKILL = ("QB", "RB", "WR", "TE")
ARCHIVE_YEARS = (2022, 2023, 2024, 2025)     # the SF era — the only regime comparable to today

# ── TUNABLES (every one is a judgement call; all echoed into the CSV header) ──────────────────
DISC = 0.90                 # per-year discount on future contract surplus (time value + churn risk)
AGE_DECAY = {"QB": 0.95, "RB": 0.80, "WR": 0.93, "TE": 0.93,
             "DL": 0.92, "LB": 0.92, "DB": 0.92, "PK": 0.97, "PN": 0.97}
MIN_ROSTER = 27             # Keith 2026-07-21: roster minimum (max 35 to the Sep 6 deadline, 30 after)
TIER_GAP_REL = 0.20         # a new tier opens on a drop >=20% of the player above …
TIER_GAP_ABS = 1.0          # … AND >=$1K absolute (both guards required; see assign_tiers)
SHOP_DEPTH = {"DL": 24, "LB": 24, "DB": 24, "PK": 12, "PN": 12}   # rows per bucket on the shopping list
IDP_AGE_PIVOT = 27.0        # IDP/K/P dynasty tilt pivots here …
IDP_AGE_SLOPE = 0.03        # … ±3% of value per year either side, capped ±30%
SCHED1 = {"QB", "RB", "WR", "TE"}                       # extension Schedule 1
EXT_BUMP = {True: (10, 20), False: (3, 5)}              # sched1 → (+$K for 1yr, +$K for 2yr)
TAG_MULT = 1.10                                         # tag = max(positional tier, 1.10 × prior AAV)

POS_BUCKET = {"QB": "QB", "RB": "RB", "WR": "WR", "TE": "TE", "PK": "PK", "PN": "PN",
              "DE": "DL", "DT": "DL", "DL": "DL", "LB": "LB", "S": "DB", "CB": "DB", "DB": "DB"}
NONSKILL = ("DL", "LB", "DB", "PK", "PN")
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")
_CRX = {"tcv": re.compile(r"TCV\s*([\d.]+)K", re.I), "cl": re.compile(r"CL\s*(\d+)", re.I)}


# ── plumbing ─────────────────────────────────────────────────────────────────────────────────
def nkey(s):
    s = (s or "").strip().lower()
    if "," in s:
        a, b = s.split(",", 1)
        s = b.strip() + " " + a.strip()
    s = s.replace(".", "").replace("'", "").replace("-", " ")
    return re.sub(r"\s+", " ", SUFFIX.sub("", s)).strip()


def clamp(v, lo, hi):
    return max(lo, min(hi, v))


def display_name(s):
    """MFL ships 'Last, First'; fa_value_core ships 'First Last'. Normalise so one board does not
    carry two naming conventions."""
    s = (s or "").strip()
    if "," in s:
        a, b = s.split(",", 1)
        return f"{b.strip()} {a.strip()}".strip()
    return s


def fetch(url, refresh, ttl=3600):
    """GET → parsed JSON, with an on-disk cache so a re-run (or a failed source) is cheap."""
    CACHE.mkdir(parents=True, exist_ok=True)
    key = CACHE / (re.sub(r"[^a-zA-Z0-9]+", "_", url)[:120] + ".json")
    if key.exists() and not refresh and (time.time() - key.stat().st_mtime) < ttl:
        return json.loads(key.read_text())
    raw = urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": "ups-three-value", "Accept": "*/*"}),
        timeout=90).read()
    key.write_bytes(raw)
    return json.loads(raw)


def parse_contract(info, salary):
    """MFL contractInfo → salary / TCV / contract length / TRUE AAV.

    MFL's own 'AAV' token is just the CURRENT year's cap hit, so a back-loaded deal reports a
    nonsense AAV. The true annual cost is TCV ÷ CL; fall back to this year's salary when the
    contract carries no TCV/CL (WW, rookie, empty)."""
    out = {"sal_k": round((salary or 0) / 1000.0)}
    m = _CRX["tcv"].search(info or "")
    out["tcv_k"] = round(float(m.group(1))) if m else None
    m = _CRX["cl"].search(info or "")
    out["cl"] = int(m.group(1)) if m else None
    out["aav_k"] = (round(out["tcv_k"] / out["cl"])
                    if (out["tcv_k"] and out["cl"]) else out["sal_k"])
    return out


def reserve_slots(players):
    """[{pos,status}] → the number of $1K slots a team must hold back to legally fill a lineup.

    Mirrors the worker's reserveCostForScenario so the live regime R matches how the rest of the
    pipeline measures it. Taxi players don't count toward the roster floor; taxi/IR don't fill a
    starting slot."""
    counts, roster_count = collections.Counter(), 0
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


# ── EP arms (offense) ────────────────────────────────────────────────────────────────────────
def ep_arms(pos, fp_rank, redraft_worth_k, dynasty_worth_k):
    """The three EP arms, recomputed from build_fa_value's OWN constants so this board can never
    drift from what the auction tool serves. Returns (floor, affine, dyn_anchor)."""
    floor = bfv.startability_floor(pos, fp_rank)
    affine = bfv.AFFINE_ANTE + bfv.AFFINE_SLOPE * redraft_worth_k
    dyn = dynasty_worth_k * bfv.POS_DYN_W.get(pos, 0.8)
    return float(floor), float(affine), float(dyn)


def serve_ep(floor, affine, dyn, m_money):
    """v5 served price. M_pos and the elite factor are inert in the shipped calibration
    (gamma sign-guarded to 0, elite sub-gate failed), so only M_money scales the market arms.
    The startability FLOOR is deliberately NOT scaled — a starting slot's rent does not fall
    because the league is poor this year."""
    mkt = max(affine, dyn)
    ep = round(max(floor, mkt * m_money))
    if floor >= mkt * m_money:
        arm = "floor"
    else:
        arm = "affine" if affine >= dyn else "dyn_anchor"
    return ep, arm


# ── IDP / K / P: the UPS auction order-statistic ladder ──────────────────────────────────────
def idp_price_ladder(con):
    """Per position bucket, an empirical rank→price ladder from THIS league's own FA auctions.

    For each season, take every final winning bid at the bucket, sort descending, and record the
    k-th order statistic. Average each k across 2022-25. Reading: ladder['LB'][2] = "the 3rd most
    expensive LB bought in a typical UPS auction went for $X K".

    This replaces the `10000 − rank·45` ramp entirely for these positions. It is a realized-price
    measurement in the only market that matters (ours), not a rank transform borrowed from a
    different scale."""
    per = collections.defaultdict(lambda: collections.defaultdict(list))
    raw = collections.defaultdict(list)
    for season, pos, amt in con.execute(
            "SELECT season, position, bid_amount FROM transactions_auction "
            "WHERE auction_type='FreeAgent' AND finalbid_ind=1 AND season>=? AND season<=?",
            (min(ARCHIVE_YEARS), max(ARCHIVE_YEARS))):
        b = POS_BUCKET.get((pos or "").upper())
        if b in NONSKILL:
            per[b][season].append(amt / 1000.0)
            raw[b].append(amt / 1000.0)
    ladder, meta = {}, {}
    for b, byseason in per.items():
        cols = collections.defaultdict(list)
        for season, vals in byseason.items():
            for k, v in enumerate(sorted(vals, reverse=True)):
                cols[k].append(v)
        depth = max(cols) + 1 if cols else 0
        ladder[b] = [round(statistics.mean(cols[k]), 2) for k in range(depth)]
        allv = raw[b]
        meta[b] = {"n_clears": len(allv), "seasons": sorted(byseason),
                   "median_k": round(statistics.median(allv), 2), "max_k": round(max(allv), 2),
                   "per_season_n": {str(s): len(v) for s, v in sorted(byseason.items())}}
    return ladder, meta


def ladder_price(ladder, bucket, rank):
    """Price the rank-th available player at this bucket off the empirical ladder.
    Past the ladder's depth every position bottoms out at the $1K minimum bid."""
    lad = ladder.get(bucket)
    if not lad:
        return 1.0
    i = max(0, int(rank) - 1)
    return max(1.0, lad[i] if i < len(lad) else 1.0)


# ── tiering ──────────────────────────────────────────────────────────────────────────────────
def assign_tiers(rows, key):
    """Positional tiers cut at CLIFFS in the value distribution, not at fixed rank boundaries.

    A new tier opens where the drop from the player above is BOTH >= TIER_GAP_REL of his value
    (a real proportional cliff) AND >= TIER_GAP_ABS in absolute $K. Both guards are needed and
    they fail in opposite directions:
      • relative alone splits the $1-2K fodder on rounding noise,
      • absolute alone enumerates the top of the board — at QB the gaps between the best few are
        $9-16K, so a flat $1K cut gives every elite his own private tier, which tells you nothing.

    Tiers are cut WITHIN status: the FA ladder answers "if I lose him, what is the next BUYABLE
    body worth?", which is the auction question. Mixing rostered players into that ladder would
    insert players Keith cannot buy between the rungs."""
    keyf = lambda r: (r["_bucket"], r["status"])
    for (bucket, _st), grp in itertools.groupby(
            sorted(rows, key=lambda r: (r["_bucket"], r["status"], -(r[key] or 0))), key=keyf):
        grp = list(grp)
        vals = [(r[key] or 0) for r in grp]
        t = 1
        for i, r in enumerate(grp):
            if i > 0:
                prev, cur = vals[i - 1], vals[i]
                drop = prev - cur
                if drop >= TIER_GAP_ABS and prev > 0 and (drop / prev) >= TIER_GAP_REL:
                    t += 1
            r["tier"] = f"{bucket}-T{t}"


# ── main ─────────────────────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--refresh", action="store_true", help="bypass the HTTP cache (use before the auction)")
    ap.add_argument("--ep-model", choices=["v4", "v5"], default="v5",
                    help="v4 = no regime multiplier (M_money forced to 1.0); v5 = the served model")
    ap.add_argument("--db", default=str(CANON), help="UPS auction archive sqlite")
    ap.add_argument("--out", default=str(OUT))
    ap.add_argument("--shopping-out", default=str(OUT_SHOP))
    ap.add_argument("--budget-normalize", choices=["off", "global"], default="off",
                    help="off (default, safe): price each FA independently — the coherence check is a "
                         "DIAGNOSTIC only. global: additionally pull the OFFENSE clearing set down to the "
                         "projected spend with one floor-preserving market-arm scale (never marks up).")
    ap.add_argument("--strict", action="store_true",
                    help="exit nonzero if the coherence ratio lands OUTSIDE the band (for CI / a guarded regen).")
    ap.add_argument("--push-d1", action="store_true",
                    help="part-keyed upsert of the board + shopping list to D1 ups_auction_three_value "
                         "(served commish-gated by GET /api/auction/three-value).")
    ap.add_argument("--push-d1-local", action="store_true",
                    help="same as --push-d1 but writes the LOCAL wrangler D1 (miniflare) instead of --remote; "
                         "for local verification without touching prod.")
    args = ap.parse_args()

    gen_ts = datetime.datetime.now().astimezone().isoformat(timespec="seconds")
    core = json.loads((DATA / "fa_value_core.json").read_text())["players"]
    calib_path = DATA / "ep_v5_calibration.json"
    calib = json.loads(calib_path.read_text()) if calib_path.exists() else None
    K = (calib or {}).get("constants", {})

    # ---- live league state ----
    rosters = fetch(f"{MFL}?TYPE=rosters&L={LEAGUE}&JSON=1", args.refresh)["rosters"]["franchise"]
    players = fetch(f"{MFL}?TYPE=players&L={LEAGUE}&JSON=1&DETAILS=1", args.refresh, ttl=86400)["players"]["player"]
    lg = fetch(f"{MFL}?TYPE=league&L={LEAGUE}&JSON=1", args.refresh)["league"]
    proj = fetch(f"{MFL}?TYPE=projectedScores&L={LEAGUE}&W=1&JSON=1", args.refresh)
    board = fetch(f"{WORKER}/api/adp-board", args.refresh)          # multi-panel dynasty values + IDP ECR

    fid2team = {f["id"]: f.get("name", f["id"]) for f in lg["franchises"]["franchise"]}
    pl_by_id = {str(p["id"]): p for p in players}
    proj_by_id = {str(r["id"]): float(r["score"])
                  for r in proj.get("projectedScores", {}).get("playerScore", []) if r.get("score")}

    def age_of(p):
        bd = p.get("birthdate")
        if not bd:
            return None
        try:
            return round((time.time() - int(bd)) / 31557600.0, 1)
        except (TypeError, ValueError):
            return None

    # rostered map + contracts + per-team state
    rostered, contracts, status_by_id, team_state = {}, {}, {}, {}
    for fr in rosters:
        fid = fr["id"]
        pls = fr.get("player", [])
        if isinstance(pls, dict):
            pls = [pls]
        committed_k, shape = 0.0, []
        for p in pls:
            pid = str(p.get("id"))
            meta = pl_by_id.get(pid, {})
            st = (p.get("status") or "").upper()
            rostered[pid] = fid
            status_by_id[pid] = st
            shape.append({"pos": meta.get("position"), "status": st})
            if st == "ROSTER":
                committed_k += int(p.get("salary") or 0) / 1000.0
                c = parse_contract(p.get("contractInfo") or "", int(p.get("salary") or 0))
                c["cy"] = int(p.get("contractYear") or 0)            # years REMAINING (cy=1 = final year)
                c["ctype"] = p.get("contractStatus") or ""
                contracts[pid] = c
        team_state[fid] = {"team": fid2team.get(fid, fid), "capspace_k": CAP_K - committed_k,
                           "reserve_k": float(reserve_slots(shape))}

    # ---- multi-panel dynasty sources → source_count + dispersion ----
    panels, idp_ecr = {}, {}
    for r in board.get("board", []):
        pid = str(r.get("pid") or "")
        if not pid:
            continue
        vals = [v for v in ((r.get("fc") or {}).get("dsf"), (r.get("ktc") or {}).get("dsf"),
                            (r.get("dp") or {}).get("dsf")) if v]
        if vals:
            panels[pid] = vals
            panels.setdefault("_byname", {})[nkey(r.get("name"))] = vals
        if r.get("isIdp") and r.get("fpEcr"):
            idp_ecr[pid] = float(r["fpEcr"])
    panels_byname = panels.pop("_byname", {})

    # ---- the UPS auction ladder for IDP/K/P ----
    con = sqlite3.connect(args.db)
    ladder, ladder_meta = idp_price_ladder(con)

    # ─────────────────────────────────────────────────────────────────────────────────────────
    # PASS 1 — offense rows off the served EP model
    # ─────────────────────────────────────────────────────────────────────────────────────────
    name2id = {}
    for pid, p in pl_by_id.items():
        name2id.setdefault(nkey(p.get("name")), pid)

    rows, credible_rw = [], 0.0
    for p in core:
        pos = p["pos"]
        if pos not in SKILL:
            continue
        nk = nkey(p["player"])
        pid = name2id.get(nk)
        owner = rostered.get(pid) if pid else None
        fp_rank = int(re.sub(r"\D", "", p.get("fp_rank") or "") or 0) or None
        rw = p.get("redraft_worth_k") or 0
        dw = p.get("dynasty_worth_k") or 0
        floor, affine, dyn = ep_arms(pos, fp_rank, rw, dw)
        # credible pool = the players you actually bid on; drives the live money/value regime R
        if not owner and (rw >= K.get("credible_rw", 3)
                          or round(max(floor, affine, dyn)) >= K.get("credible_ep", 5)):
            credible_rw += rw
        rows.append({"_pid": pid, "_nk": nk, "player": p["player"], "pos": pos, "_bucket": pos,
                     "age": p.get("age"), "owner_fid": owner,
                     "_rw": rw, "_dw": dw, "_floor": floor, "_affine": affine, "_dyn": dyn,
                     "_fp_rank": fp_rank, "_dyn_value": p.get("dyn_value") or 0,
                     "scale_trust": "cardinal-3panel", "_idp_ramp": ""})

    # ---- no rostered player may vanish ----
    # A rostered SKILL player who is absent from fa_value_core (deep enough that FantasyPros
    # never ranked him) would otherwise be silently dropped from the board. Carry him as an
    # UNPRICED row so a roster read is complete and the omission is visible instead of invisible.
    seen_pids = {r["_pid"] for r in rows if r["_pid"]}
    unpriced = 0
    for pid, fid in rostered.items():
        if pid in seen_pids:
            continue
        meta = pl_by_id.get(pid, {})
        b = POS_BUCKET.get((meta.get("position") or "").upper())
        if b is None or b in NONSKILL:
            continue                      # non-skill rostered players are already covered in PASS 2
        unpriced += 1
        rows.append({"_pid": pid, "_nk": nkey(meta.get("name")), "player": display_name(meta.get("name")),
                     "pos": (meta.get("position") or "").upper(), "_bucket": b, "age": age_of(meta),
                     "owner_fid": fid, "_rw": 0, "_dw": 0, "_floor": 0.0, "_affine": 0.0,
                     "_dyn": 0.0, "_fp_rank": None, "_dyn_value": 0, "_ep": 0.0,
                     "ep_arm_bound": "unpriced", "dyn_anchor_hit": "FALSE",
                     "current_season_value_k": "", "dynasty_value_raw_k": 0.0,
                     "scale_trust": "unpriced-no-source", "_idp_ramp": ""})

    # ---- live regime → M_money (the ONLY live multiplier; M_pos and elite are inert) ----
    sum_cap = sum(t["capspace_k"] for t in team_state.values())
    sum_res = sum(t["reserve_k"] for t in team_state.values())
    R_now = (sum_cap - sum_res) / (credible_rw or 1)
    lam, Rbar = K.get("lambda", 0.0), K.get("R_bar") or 0
    mm_lo, mm_hi = K.get("m_money_clamp", [0.80, 1.60])
    m_raw = (1 + lam * (R_now / Rbar - 1)) if Rbar else 1.0
    use_v5 = (args.ep_model == "v5") and bool(calib) and bool(calib.get("ship_gate")) and bool(Rbar)
    m_money = clamp(m_raw, mm_lo, mm_hi) if use_v5 else 1.0
    m_clamped = bool(use_v5 and abs(m_money - m_raw) > 1e-9)
    R_range = K.get("R_observed_range") or [None, None]
    extrapolating = bool(use_v5 and R_range[0] is not None and not (R_range[0] <= R_now <= R_range[1]))

    for r in rows:
        if r.get("ep_arm_bound") == "unpriced":   # no source ranked him — do not invent a price
            continue
        ep, arm = serve_ep(r["_floor"], r["_affine"], r["_dyn"], m_money)
        r["_ep"], r["ep_arm_bound"] = ep, arm
        r["dyn_anchor_hit"] = "TRUE" if arm == "dyn_anchor" else "FALSE"
        r["current_season_value_k"] = r["_rw"]
        r["dynasty_value_raw_k"] = r["_dw"]

    # ─────────────────────────────────────────────────────────────────────────────────────────
    # PASS 2 — IDP / K / P off the UPS auction ladder
    # ─────────────────────────────────────────────────────────────────────────────────────────
    # Candidate set: every rostered non-skill player (Keith must see the market he is bidding
    # into) + every unrostered non-skill player who is on an NFL roster AND carries either a
    # FantasyPros dynasty-IDP rank or an MFL league-scoring projection.
    cands = []
    for pid, p in pl_by_id.items():
        b = POS_BUCKET.get((p.get("position") or "").upper())
        if b not in NONSKILL:
            continue
        owner = rostered.get(pid)
        on_nfl = (p.get("team") or "") not in ("", "FA")
        ecr, pr = idp_ecr.get(pid), proj_by_id.get(pid)
        if not owner and not (on_nfl and (ecr or pr)):
            continue
        cands.append({"pid": pid, "p": p, "b": b, "owner": owner, "ecr": ecr, "pr": pr})

    # ORDER within bucket. TWO independent orderings exist for IDP and they disagree materially:
    #   PRIMARY  — FantasyPros dynasty-IDP ECR (expert consensus, but ONE source, and it is an
    #              OVERALL IDP list, so tackle-volume LBs crowd out pure pass rushers).
    #   ALT      — MFL's own week-1 projection under THIS LEAGUE'S scoring (league-accurate, but a
    #              single week and MFL's projections are crude).
    # Neither dominates: ECR has Micah Parsons ~9th among DL, MFL scoring has him top-3. Rather
    # than pick a winner, both are priced and the DOLLAR gap between them becomes the dispersion
    # (confidence) signal — which is the only such signal these positions have.
    # K/P have no ECR at all, so ALT is the only ordering and dispersion is blank.
    for b in NONSKILL:
        grp = [c for c in cands if c["b"] == b]
        grp.sort(key=lambda c: (0 if c["ecr"] else 1, c["ecr"] or 0, -(c["pr"] or 0),
                                (c["p"].get("name") or "")))
        for i, c in enumerate(grp, 1):
            c["pos_rank"] = i
        # the auction rung is set by rank among AVAILABLE players — a rostered stud is not on the block
        avail = [c for c in grp if not c["owner"]]
        for i, c in enumerate(avail, 1):
            c["avail_rank"] = i
        # parallel ranking on the league-scoring projection alone
        alt = sorted(grp, key=lambda c: (-(c["pr"] or 0), (c["p"].get("name") or "")))
        for i, c in enumerate(alt, 1):
            c["alt_pos_rank"] = i
        for i, c in enumerate([c for c in alt if not c["owner"]], 1):
            c["alt_avail_rank"] = i

    for c in cands:
        p, b, pid = c["p"], c["b"], c["pid"]
        ecr = c["ecr"]
        # price/value rung. Rostered players are valued at their overall positional rank; FAs at
        # their rank among what is actually purchasable.
        rung = c.get("avail_rank") or c["pos_rank"]
        val = ladder_price(ladder, b, rung)
        age = age_of(p)
        # dynasty tilt: the ONLY thing separating asset value from this-year value for these
        # positions, and it is a small explicit age adjustment — not an independent panel.
        tilt = 1.0
        if age:
            tilt = clamp(1 + IDP_AGE_SLOPE * (IDP_AGE_PIVOT - age), 0.70, 1.30)
        ramp = round((10000 - ecr * 45) * bfv.PER_VALUE, 1) if ecr else ""
        # how far apart the two orderings price him, in $K — the IDP confidence signal
        alt_rung = c.get("alt_avail_rank") or c.get("alt_pos_rank") or rung
        n_src = (1 if ecr else 0) + (1 if c["pr"] else 0)
        alt_disp = (round(abs(val - ladder_price(ladder, b, alt_rung)), 1) if n_src > 1 else "")
        rows.append({
            "_pid": pid, "_nk": nkey(p.get("name")), "player": display_name(p.get("name")),
            "pos": (p.get("position") or "").upper(), "_bucket": b, "age": age,
            "owner_fid": c["owner"], "_rw": val, "_dw": round(val * tilt, 1),
            "_floor": val, "_affine": val, "_dyn": val, "_fp_rank": c["pos_rank"],
            "_dyn_value": 0, "_ep": round(val, 1),
            "ep_arm_bound": "ups-auction-ladder", "dyn_anchor_hit": "FALSE",
            "current_season_value_k": round(val, 1), "dynasty_value_raw_k": round(val * tilt, 1),
            "scale_trust": ("none" if b in ("PK", "PN") else "idp-linear-1source"),
            "_idp_ramp": ramp, "_n_src": n_src, "_alt_disp": alt_disp,
        })

    # ─────────────────────────────────────────────────────────────────────────────────────────
    # PASS 3 — contract surplus, ultimate value, option band, tiers
    # ─────────────────────────────────────────────────────────────────────────────────────────
    for r in rows:
        pid = r["_pid"]
        owner = r["owner_fid"]
        c = contracts.get(pid) if owner else None
        r["status"] = "rostered" if owner else "FA"
        r["owner"] = team_state.get(owner, {}).get("team", "") if owner else ""
        r["nfl_team"] = (pl_by_id.get(pid, {}) or {}).get("team", "") if pid else ""
        r["salary_k"] = c["sal_k"] if c else ""
        r["years_remaining"] = c["cy"] if c else ""
        r["contract_type"] = c["ctype"] if c else ""
        r["aav_k"] = c["aav_k"] if c else ""
        r["tcv_k"] = (c["tcv_k"] if c and c["tcv_k"] else "") if c else ""
        r["ep_equiv_k"] = round(r["_ep"], 1)
        # current_season_value_k lives on the $6.50/APWE scale, which the backtest says runs
        # ~1.6-1.9x hot vs realized auction dollars. The fitted clearing line IS the translation
        # between the two, so this column restates THE SAME 2026-only value in the dollars Keith
        # would actually pay. No new constant: it is the affine arm, scaled by the same M_money.
        r["current_season_market_k"] = (round(r["_affine"] * m_money, 1) if r["_bucket"] in SKILL
                                        else round(r["_ep"], 1))

        # ---- contract surplus: what the CONTRACT itself is worth, over its remaining years ----
        if c and (c["cy"] or 0) > 0:
            decay = AGE_DECAY.get(r["_bucket"], 0.92)
            surplus = sum((DISC ** t) * (r["_ep"] * (decay ** t) - c["aav_k"])
                          for t in range(0, int(c["cy"])))
            r["contract_surplus_k"] = round(surplus, 1)
        else:
            # a free agent's auction win becomes a 1-yr Vet-FAA at exactly the price paid →
            # zero surplus at the moment of purchase, by construction
            r["contract_surplus_k"] = 0.0
        r["ultimate_value_k"] = round(r["dynasty_value_raw_k"] + r["contract_surplus_k"], 1)

        # ---- fa_value: auction-eligible rows only ----
        r["fa_value_k"] = round(r["_ep"], 1) if not owner else ""

        # ---- option band: a LABEL, never added to a scalar ----
        y1, y2 = EXT_BUMP[r["_bucket"] in SCHED1]
        if not owner:
            r["option_band"] = "n/a - auction win = 1yr Vet-FAA at price paid"
        elif (c and (c["cy"] or 0) == 1):
            r["option_band"] = f"+{y1}-{y2}K ext / tag {TAG_MULT:.2f}xAAV"          # extension-eligible now
        elif (c and (c["cy"] or 0) > 1):
            r["option_band"] = f"+{y1}-{y2}K ext (yr {c['cy']}) / tag {TAG_MULT:.2f}xAAV"
        else:
            r["option_band"] = f"expired - tag {TAG_MULT:.2f}xAAV or auction"

        # ---- panel agreement ----
        # Offense: how many of the three cardinal dynasty panels (FantasyCalc / KeepTradeCut /
        # DynastyProcess) actually carry this player, and how far apart they are in $K.
        # IDP: exactly ONE source by construction (FantasyPros dynasty-IDP ECR) — there is
        # nothing to disperse against, which is the whole point of the scale_trust flag.
        # K/P: zero sources anywhere in the pipeline.
        if r["_bucket"] in SKILL:
            vals = panels.get(pid) or panels_byname.get(r["_nk"]) or []
            r["source_count"] = len(vals)
            r["dispersion"] = (round((max(vals) - min(vals)) * bfv.PER_VALUE, 1)
                               if len(vals) > 1 else ("" if not vals else 0.0))
        else:
            # NOT cardinal panels — these are independent ORDERINGS (FantasyPros dynasty-IDP ECR
            # and MFL league-scoring projection). dispersion is the $K gap between the price each
            # ordering implies, so a big number means "these two disagree about who this man is".
            r["source_count"] = r.get("_n_src", 0)
            r["dispersion"] = r.get("_alt_disp", "")
        r["idp_ramp_value_k"] = r["_idp_ramp"]

        # an unpriced row carries NO dollar figures at all — blank beats a confident zero
        if r["scale_trust"] == "unpriced-no-source":
            for k in ("current_season_value_k", "current_season_market_k", "ultimate_value_k",
                      "contract_surplus_k", "dynasty_value_raw_k", "fa_value_k", "ep_equiv_k"):
                r[k] = ""

    assign_tiers(rows, "ultimate_value_k")

    # ─────────────────────────────────────────────────────────────────────────────────────────
    # BUDGET-CONSTRAINT COHERENCE — the accounting identity the per-player model cannot see
    # ─────────────────────────────────────────────────────────────────────────────────────────
    # The 12 teams can only SPEND what they collectively HAVE. Project that spend from the live cap
    # state, then check the board's PREDICTED CLEARING SET (top-N per bucket by price, N = this
    # league's historical mean clears) against it. A board that prices its top-N above the money that
    # will be spent is internally incoherent no matter how well each single price is calibrated.
    #   available = Σ capspace (headroom);  committed = 12·cap − available.
    committed_k = CAP_K * len(team_state) - sum_cap
    projected_spend_k, spend_parts = bfv.project_auction_spend(sum_cap, committed_k)

    def _fa_vals_by_bucket():
        d = collections.defaultdict(list)
        for r in rows:
            if r["status"] == "FA" and isinstance(r.get("fa_value_k"), (int, float)):
                d[r["_bucket"]].append(r["fa_value_k"])
        return d

    coh_before = bfv.coherence_check(_fa_vals_by_bucket(), projected_spend_k)
    budget_scale = 1.0
    if args.budget_normalize == "global":
        # Fix WHERE it is: the IDP/K/P ladder already clears at realized dollars (ratio ≈ 1.0), so
        # normalize the OFFENSE market arms ONLY. One global scale respects the model's relative
        # allocation (which encodes the live pool's composition) instead of imposing historical shares.
        off_target = projected_spend_k * (sum(bfv.AUCTION_BUCKET_SPEND_K[b] for b in SKILL)
                                          / sum(bfv.AUCTION_BUCKET_SPEND_K.values()))
        items = []
        for b in SKILL:
            grp = sorted((r for r in rows if r["status"] == "FA" and r["_bucket"] == b
                          and isinstance(r.get("fa_value_k"), (int, float))),
                         key=lambda r: -(r["fa_value_k"]))
            for r in grp[:int(round(bfv.AUCTION_CLEAR_COUNT[b]))]:
                items.append({"floor": r["_floor"], "market": max(r["_affine"], r["_dyn"]) * m_money})
        budget_scale = bfv.budget_scale_factor(items, off_target)
        if budget_scale < 1.0:                       # re-price OFFENSE FA only (auction-price column)
            for r in rows:
                if r["status"] == "FA" and r["_bucket"] in SKILL and isinstance(r.get("fa_value_k"), (int, float)):
                    new_ep = round(max(r["_floor"], max(r["_affine"], r["_dyn"]) * m_money * budget_scale))
                    r["fa_value_k"] = new_ep
                    r["ep_equiv_k"] = round(float(new_ep), 1)
    coh = bfv.coherence_check(_fa_vals_by_bucket(), projected_spend_k)

    # ---- sort: FA by fa_value desc, then rostered by ultimate_value desc ----
    def _num(v):
        return float(v) if isinstance(v, (int, float)) or (isinstance(v, str) and v.strip()) else 0.0
    rows.sort(key=lambda r: (0 if r["status"] == "FA" else 1,
                             -_num(r["fa_value_k"] if r["status"] == "FA" else r["ultimate_value_k"]),
                             r["player"] or ""))

    # ---- arm binding census (the rw>=3 branch — the ep>=5 branch is polluted, see header) ----
    off_fa = [r for r in rows if r["status"] == "FA" and r["_bucket"] in SKILL]
    cred_rw = [r for r in off_fa if r["_rw"] >= 3]
    cred_ep = [r for r in off_fa if r["_rw"] < 3 and round(max(r["_floor"], r["_affine"], r["_dyn"])) >= 5]
    arms_rw = collections.Counter(r["ep_arm_bound"] for r in cred_rw)
    arms_ep = collections.Counter(r["ep_arm_bound"] for r in cred_ep)

    # ─────────────────────────────────────────────────────────────────────────────────────────
    # WRITE
    # ─────────────────────────────────────────────────────────────────────────────────────────
    COLS = ["player", "pos", "nfl_team", "age", "status", "owner",
            "salary_k", "years_remaining", "contract_type", "aav_k", "tcv_k",
            "current_season_value_k", "ultimate_value_k", "fa_value_k",
            "dynasty_value_raw_k", "contract_surplus_k", "option_band",
            "ep_arm_bound", "dyn_anchor_hit", "tier", "source_count", "dispersion",
            "scale_trust", "current_season_market_k", "ep_equiv_k", "idp_ramp_value_k"]

    def header_block():
        L = []
        A = L.append
        A("# UPS THREE-VALUE BOARD — every line beginning with '#' is metadata; skip them to parse the CSV.")
        A(f"# generated: {gen_ts}   league: L={LEAGUE} {YEAR}   cap: ${CAP_K}K   viewer: {ME} (Real Deal Creel)")
        A(f"# rows: {len(rows)}  (FA {sum(1 for r in rows if r['status']=='FA')} / rostered {sum(1 for r in rows if r['status']=='rostered')})")
        A("#")
        A("# ── THE THREE VALUES (they do NOT sum; each answers a different question) ──")
        A("# current_season_value_k = worth for 2026 only. Offense: E[APWE] at the FantasyPros redraft")
        A(f"#     slot x ${bfv.DOLLAR_PER_APWE}/APWE. IDP/K/P: the UPS auction order-statistic ladder (see IDP CAVEAT).")
        A("# ultimate_value_k = dynasty_value_raw_k + contract_surplus_k. NOT a triple sum; option value is")
        A("#     NOT folded in (see option_band) because it would double-count the surplus already priced.")
        A(f"#     contract_surplus = SUM over t=0..cy-1 of {DISC}^t * (ep_equiv_k * DECAY[pos]^t - aav_k)")
        A(f"#     DECAY = {AGE_DECAY}")
        A("#     A free agent's surplus is 0 by construction: an auction win becomes a 1-yr Vet-FAA at the")
        A("#     price paid, so there is no contract edge at the moment of purchase.")
        A("# fa_value_k = expected auction price, auction-eligible (unrostered) rows ONLY; blank if rostered.")
        A("#")
        A("# ── !! THE TWO VALUE COLUMNS ARE ON DIFFERENT DOLLAR SCALES — READ THIS BEFORE COMPARING !! ──")
        A(f"# current_season_value_k is denominated at ${bfv.DOLLAR_PER_APWE}/APWE, which the backtest says runs ~1.6-1.9x")
        A("# HOT vs realized auction dollars. fa_value_k is in realized auction dollars. Comparing them")
        A("# directly makes every player look like a bargain. THAT COMPARISON IS INVALID.")
        A("# current_season_market_k restates the SAME 2026-only value in realized auction dollars, using the")
        A(f"#   fitted clearing line ({bfv.AFFINE_ANTE} + {bfv.AFFINE_SLOPE}*redraft_worth) x M_money. No new constant.")
        A("#   >>> To ask 'is this 2026 price fair?', compare fa_value_k against current_season_market_k. <<<")
        A("#   >>> current_season_value_k is the production measure; it is NOT a dollar you would bid. <<<")
        A("#")
        A("# ── EP MODEL SERVED ──")
        A(f"# model: {'v5' if use_v5 else 'v4 (M_money forced to 1.0)'}"
          f"   ep = round(max(floor, max(affine, dyn_anchor) * M_money))")
        A(f"# calibration: {'ep_v5_calibration.json ship_gate=' + str(calib.get('ship_gate')) if calib else 'ABSENT - served v4'}"
          f"   lambda={K.get('lambda')}  R_bar={K.get('R_bar')}")
        A(f"# gamma={K.get('gamma')} (sign-guarded={K.get('gamma_sign_guarded')}) -> M_pos is INERT (identically 1.0).")
        A(f"# elite factor {K.get('elite_factor')} enabled={K.get('elite_enabled')} -> inert.")
        A(f"# LIVE REGIME: R_now = (sum capspace ${sum_cap:.0f}K - sum reserve ${sum_res:.0f}K) / credible redraft-worth "
          f"${credible_rw:.0f}K = {R_now:.4f}")
        A(f"# M_money raw = {m_raw:.4f}  ->  SERVED {m_money:.4f}")
        if m_clamped:
            A(f"# *** M_money IS PINNED TO ITS CLAMP FLOOR {mm_lo}. THE {round((1-m_money)*100)}% MARKDOWN IS A CHOSEN")
            A(f"# *** FLOOR, NOT A MEASURED QUANTITY. The fitted model wanted {m_raw:.4f}; the clamp overrode it.")
            A(f"# *** The clamp [{mm_lo}, {mm_hi}] is a Keith-tunable guardrail, never fitted to data.")
        if extrapolating:
            A(f"# *** R_now {R_now:.3f} is OUTSIDE the fitted range {R_range}. M_money is an extrapolation.")
        A("#")
        A("# ── BUDGET-CONSTRAINT COHERENCE (the accounting identity, checked at BUILD time) ──")
        A(f"# PROJECTED SPEND = clamp(deploy_frac {spend_parts['deploy_frac']} x available ${spend_parts['available_k']}K,"
          f"  mandatory floor ${spend_parts['mandatory_floor_k']}K,  available) = ${spend_parts['projected_spend_k']}K.")
        A(f"#   deploy_frac is the SF-era mean (spend / pre-auction available; 2022-25 = 0.75/0.64/0.75/0.72).")
        A(f"#   mandatory floor = 12 x $260K committed (league_context_v1.md:161) - ${spend_parts['committed_k']}K committed today.")
        A(f"# PREDICTED CLEARING SET = sum of fa_value over the top-N per bucket (N = this league's historical")
        A(f"#   mean clears: QB16 RB30 WR28 TE13 | DL20 LB24 DB23 PK12 PN11, total ~176). NOT sum-of-all-rows.")
        A(f"# CONSTRAINT: predicted clearing set  ==  projected spend.")
        A(f"#   predicted ${coh['predicted_clearing_k']}K  /  projected ${coh['projected_spend_k']}K  =  RATIO {coh['ratio']}"
          f"   [band {coh['band'][0]}-{coh['band'][1]}]   status={coh['status']}")
        A(f"#   per-bucket predicted-clearing $K: " +
          "  ".join(f"{b}:{coh['per_bucket_pred_k'].get(b,0):.0f}" for b in
                    ("QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN")))
        if coh["status"] == "FAIL":
            A(f"# *** COHERENCE FAIL — the board's top-N is priced at {coh['ratio']}x the money that will be spent.")
            A(f"# *** {coh['n_contract_star_fa']} FA are priced >= ${coh['contract_star_threshold_k']}K. In a dynasty league")
            A(f"# *** that is the FINGERPRINT OF A PRE-ROSTER-LOCK SNAPSHOT: contract-caliber players (Josh Allen,")
            A(f"# *** Mahomes, CMC ...) transiently coded as FREE AGENTS inflate both the board top AND R_now.")
            A(f"# *** ACTION: regenerate AFTER Thursday's roster lock. The 2022-25 boards all land 0.66-0.97 here;")
            A(f"# *** removing ~12 mis-coded stars from this pool drops the ratio from ~1.5x back into the band.")
            A(f"# *** This is a DATA-STATE artifact, not a pricing defect — see build_ep_v5_calibration budget_constraint.")
        if args.budget_normalize == "global":
            if budget_scale < 1.0:
                A(f"# BUDGET NORMALIZE = global: offense market arms x {budget_scale} (before {coh_before['ratio']} -> after {coh['ratio']}).")
                A(f"#   Applied to OFFENSE FA prices only; IDP/K/P ladder already clears at realized $ (untouched). Floor")
                A(f"#   preserved (nothing below startability), ordering preserved. NOTE: the 2022-25 backtest shows hard")
                A(f"#   normalization RAISES winner MAE ($3.61K->$4.02K) — coherence here costs accuracy. Prefer a roster-lock regen.")
            else:
                A(f"# BUDGET NORMALIZE = global requested but board already <= offense target — no scale-down applied.")
        else:
            A(f"# BUDGET NORMALIZE = off (default). Prices are per-player; the check above is a diagnostic. Enable with")
            A(f"#   --budget-normalize global to force offense coherence (backtest: it costs ~$0.4K winner MAE).")
        A("#")
        A("# ── PER-ARM BINDING COUNTS (FA offense rows) ──")
        A(f"# credible branch rw>=3 (n={len(cred_rw)}): " +
          "  ".join(f"{a}={arms_rw.get(a,0)}" for a in ("floor", "affine", "dyn_anchor")))
        A(f"# ep>=5-only branch (n={len(cred_ep)}): " +
          "  ".join(f"{a}={arms_ep.get(a,0)}" for a in ("floor", "affine", "dyn_anchor")))
        A("# The ep>=5-only branch is POLLUTED for 2026: dynasty_adp_history.csv has no 2026 rows, so it")
        A("# falls back to a KTC board carrying only the top ~396 players. Trust the rw>=3 branch.")
        A(f"# Union of both branches = {len(cred_rw) + len(cred_ep)} credible rows, of which "
          f"{arms_rw.get('dyn_anchor',0) + arms_ep.get('dyn_anchor',0)} bind on the dynasty anchor.")
        A("# NOTE ON ATTRIBUTION: the arm is recorded AFTER M_money scales the two market arms, so a row")
        A("#   whose scaled market arm drops below the startability floor is credited to 'floor' here even")
        A("#   though it would read 'dyn_anchor' pre-scaling. That accounts for ~2 rows of drift vs a")
        A("#   pre-scaling census. M_money never reorders affine vs dyn_anchor (it scales both equally).")
        A(f"# dyn_anchor_hit=TRUE on {sum(1 for r in rows if r['dyn_anchor_hit']=='TRUE')} rows: the ${bfv.DYN_ANCHOR_K}K top-asset anchor is a HAND-PIN")
        A(f"#   and sits ABOVE 3 of the last 4 season maxima ($66K/$94K/$61K/$56K). Every TRUE row is a judgement call.")
        A("#")
        A("# ── IDP / K / P CAVEAT (READ THIS) ──")
        A("# IDP, K and P are MANDATORY STARTERS (2 DL, 2 LB, 2 DB, 1 D-Flex, 1 K, 1 P) and are NOT on the")
        A("# offense scale. Offense = 3 independent cardinal panels. IDP = ONE source (FantasyPros dynasty-IDP")
        A("# ECR) through a hand-made LINEAR ramp idpVal = 10000 - rank*45. At the offense $/value-unit that")
        A(f"# ramp claims IDP1 ~= ${round(9955*bfv.PER_VALUE)}K and rank-100 ~= ${round(5500*bfv.PER_VALUE)}K. THE UPS LEAGUE HAS NEVER PAID")
        A(f"# MORE THAN $15K FOR AN IDP and the median clear is $1-2K. The ramp is off by 10-40x mid-board.")
        A("# THIS BOARD DOES NOT USE THE RAMP. IDP/K/P price off the UPS auction order-statistic ladder:")
        A("# for each bucket, the k-th most expensive clear per season, averaged 2022-25. The raw ramp value")
        A("# is echoed in idp_ramp_value_k so the distortion stays visible.")
        A("# *** For IDP/K/P the VALUE axis and the PRICE axis are THE SAME MEASUREMENT. There is no")
        A("# *** independent value signal, so do NOT read a value-vs-price surplus verdict off those rows.")
        A("# IDP source_count/dispersion mean something DIFFERENT than on offense: they count independent")
        A("#   ORDERINGS (FantasyPros dynasty-IDP ECR vs MFL week-1 league-scoring projection), not cardinal")
        A("#   panels, and dispersion is the $K gap between the price each ordering implies. The two disagree")
        A("#   hard on pass rushers - ECR is an OVERALL IDP list where tackle-volume LBs crowd out DL, so it")
        A("#   ranks Micah Parsons ~9th among DL while MFL scoring has him top-3. A large dispersion here")
        A("#   means the RANKING is contested, not that the dollar is volatile. Order matters more than")
        A("#   price on this shopping list: every rung past ~6 is $1-2K anyway.")
        A("# K and P have NO dynasty source anywhere in the pipeline -> scale_trust=none. In 2024 every")
        A("# single K and P cleared at exactly $1K. Budget $1-2K each and buy them last.")
        for b in NONSKILL:
            m = ladder_meta.get(b)
            if m:
                A(f"#   ladder[{b}]: n={m['n_clears']} clears  median ${m['median_k']}K  max ${m['max_k']}K  "
                  f"top rungs {[round(x,1) for x in ladder.get(b, [])[:6]]}")
        A("#")
        A("# ── OTHER MODEL CAVEATS ──")
        A(f"# $/APWE = ${bfv.DOLLAR_PER_APWE} is ~1.6-1.9x hot vs the realized market. It CANCELS out of the price ratio")
        A("#   but it BIASES any value-vs-price verdict, so no verdict column is shipped here.")
        A("# e_apwe_p90 is OMITTED: a p50 tail adjustment in build_eapw_curves.py:92 inflates p50 above p90 on")
        A("#   126 rows, which would be an impossible ceiling. Rather than ship it wrong, it is not shipped.")
        A("# option_band is a LABEL. Extension strikes: Schedule 1 (QB/RB/WR/TE) +$10K/1yr, +$20K/2yr;")
        A("#   Schedule 2 (DL/LB/DB/PK/PN) +$3K/1yr, +$5K/2yr. Tag = max(positional tier, 1.10 x prior AAV).")
        A("#")
        A("# ── TIERS ──")
        A(f"# Cut where the drop from the player above is >={int(TIER_GAP_REL*100)}% of his value AND >=${TIER_GAP_ABS}K absolute.")
        A("# Computed separately for FA and rostered, so the FA ladder answers 'what is the next BUYABLE body")
        A("# worth?'. Both guards are required: relative-only splits the $1-2K fodder on rounding noise;")
        A("# absolute-only gives every elite QB his own private tier (the gaps up there are $9-16K).")
        A(f"# unpriced rows: {unpriced} rostered skill player(s) carry no source ranking at all and ship with")
        A("#   every dollar column BLANK (scale_trust=unpriced-no-source) rather than a confident zero.")
        A("#")
        A("# ── TUNABLES (judgement calls, not fits) ──")
        A(f"# DISC={DISC}  MIN_ROSTER={MIN_ROSTER}  TIER_GAP_REL={TIER_GAP_REL}  TIER_GAP_ABS={TIER_GAP_ABS}")
        A(f"# IDP_AGE_PIVOT={IDP_AGE_PIVOT}  IDP_AGE_SLOPE={IDP_AGE_SLOPE}  TAG_MULT={TAG_MULT}")
        A(f"# m_money_clamp={K.get('m_money_clamp')}  m_pos_clamp={K.get('m_pos_clamp')}  (both Keith-tunable guardrails)")
        A(f"# DYN_ANCHOR_K=${bfv.DYN_ANCHOR_K}K  POS_DYN_W={bfv.POS_DYN_W}  AFFINE={bfv.AFFINE_ANTE}+{bfv.AFFINE_SLOPE}*rw")
        A("#")
        return L

    def write(path, data, extra=None):
        with open(path, "w", newline="") as f:
            for line in header_block():
                f.write(line + "\n")
            for line in (extra or []):
                f.write(line + "\n")
            w = csv.DictWriter(f, fieldnames=COLS, extrasaction="ignore")
            w.writeheader()
            for r in data:
                w.writerow(r)

    write(args.out, rows)
    print(f"wrote {args.out}  ({len(rows)} rows)")

    # ---- companion: Saturday shopping list — the positions Keith MUST fill ----
    mine = collections.Counter(POS_BUCKET.get((pl_by_id.get(pid, {}) or {}).get("position", "").upper())
                               for pid, fid in rostered.items() if fid == ME)
    shop_note = [
        "# ── SHOPPING LIST — the positions 0008 MUST fill Saturday ──",
        f"# 0008 currently rosters: " + "  ".join(f"{b}={mine.get(b,0)}" for b in
                                                  ("QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN")),
        "# Starting requirement: 2 DL, 2 LB, 2 DB, 1 D-Flex, 1 K, 1 P (7 defense + K + P of 18 starters).",
        "# FA rows only, positions DL/LB/DB/PK/PN, sorted by fa_value_k desc within position.",
        "# Read fa_value_k as the expected clearing price from THIS league's own archive, not a projection.",
        f"# Truncated to the top {SHOP_DEPTH} per bucket: past those rungs the ladder is flat at the $1K",
        "# minimum bid, so deeper rows carry no information. The full pool is in three_value_board.csv.",
        "#",
    ]
    shop = []
    for b in NONSKILL:
        grp = sorted([r for r in rows if r["status"] == "FA" and r["_bucket"] == b],
                     key=lambda r: (-(r["fa_value_k"] or 0), r["_fp_rank"] or 999))
        shop += grp[:SHOP_DEPTH.get(b, 20)]
    write(args.shopping_out, shop, extra=shop_note)
    print(f"wrote {args.shopping_out}  ({len(shop)} rows)")

    # ─────────────────────────────────────────────────────────────────────────────────────────
    # D1 PUSH — the War Room reads this blob at GET /api/auction/three-value (commish-gated).
    # Mirrors build_faa_report.py / build_draft_intel.py: a lean JSON string, part-keyed (<90KB
    # chunks) into ups_auction_three_value because the full board (~1,470 rows) blows past D1's
    # 100KB single-statement cap. The view re-derives nothing — every dollar column is served.
    # ─────────────────────────────────────────────────────────────────────────────────────────
    if args.push_d1 or args.push_d1_local:
        def nz(v):
            if v is None or v == "":
                return None
            if isinstance(v, str):
                try:
                    return int(v) if float(v).is_integer() else float(v)
                except ValueError:
                    return v
            return v

        def proj(r):
            o = {"n": r["player"], "p": r["pos"], "tm": r.get("nfl_team") or None,
                 "ag": nz(r.get("age")), "s": ("F" if r["status"] == "FA" else "r")}
            if r["status"] != "FA":
                o["o"] = r.get("owner") or None
            for src, k in (("salary_k", "sl"), ("years_remaining", "yr"), ("contract_type", "ct"),
                           ("aav_k", "av"), ("tcv_k", "tcv"),
                           ("current_season_value_k", "csv"), ("ultimate_value_k", "uv"),
                           ("fa_value_k", "fv"), ("dynasty_value_raw_k", "dvr"),
                           ("contract_surplus_k", "surp"), ("option_band", "ob"),
                           ("ep_arm_bound", "arm"), ("tier", "tr"), ("scale_trust", "st"),
                           ("current_season_market_k", "csm"), ("ep_equiv_k", "ee"),
                           ("idp_ramp_value_k", "ir")):
                val = nz(r.get(src))
                if val is not None:
                    o[k] = val
            return o

        lean = {
            "meta": {
                "generated": gen_ts, "league": LEAGUE, "year": YEAR, "cap_k": CAP_K, "viewer": ME,
                "model": "v5" if use_v5 else "v4",
                "regime": {
                    "R_now": round(R_now, 4), "R_range": list(R_range) if R_range else None,
                    "m_money_raw": round(m_raw, 4), "m_money": round(m_money, 4),
                    "m_clamped": bool(m_clamped), "m_money_clamp": [mm_lo, mm_hi],
                    "extrapolating": bool(extrapolating),
                    "lambda": K.get("lambda"), "R_bar": K.get("R_bar"),
                    "gamma_sign_guarded": K.get("gamma_sign_guarded"),
                    "m_pos_inert": True, "elite_inert": True,
                    "ship_gate": (calib.get("ship_gate") if calib else None),
                },
                "coherence": {
                    "projected_spend_k": coh["projected_spend_k"],
                    "predicted_clearing_k": coh["predicted_clearing_k"],
                    "ratio": coh["ratio"], "band": list(coh["band"]), "status": coh["status"],
                    "n_contract_star_fa": coh.get("n_contract_star_fa"),
                },
                "arms": {"rw3": dict(arms_rw), "ep5": dict(arms_ep)},
                "counts": {"total": len(rows),
                           "fa": sum(1 for r in rows if r["status"] == "FA"),
                           "rostered": sum(1 for r in rows if r["status"] == "rostered"),
                           "shopping": len(shop)},
                "dollar_per_apwe": bfv.DOLLAR_PER_APWE,
                "key": {"n": "player", "p": "pos", "tm": "nfl_team", "ag": "age",
                        "s": "status (F=free agent / r=rostered)", "o": "owner_fid (rostered only)",
                        "sl": "salary_k (this-year cap hit; rostered)", "yr": "years_remaining",
                        "ct": "contract_type", "av": "aav_k (TCV/CL; rostered)", "tcv": "tcv_k",
                        "csv": "current_season_value_k (2026-only worth, PRODUCTION $/APWE scale — NOT a bid)",
                        "uv": "ultimate_value_k = dynasty_value_raw_k + contract_surplus_k",
                        "fv": "fa_value_k (expected auction price; FA rows only)",
                        "dvr": "dynasty_value_raw_k", "surp": "contract_surplus_k",
                        "ob": "option_band (extension/tag label)", "arm": "ep_arm_bound (floor/affine/dyn_anchor)",
                        "tr": "tier", "st": "scale_trust",
                        "csm": "current_season_market_k (2026 worth restated in REALIZED auction $ — compare fv to THIS)",
                        "ee": "ep_equiv_k", "ir": "idp_ramp_value_k (echo of the retired 10000-rank*45 ramp)"},
            },
            "board": [proj(r) for r in rows],
            "shopping": [proj(r) for r in shop],
        }
        blob = json.dumps(lean, separators=(",", ":"))
        remote = not args.push_d1_local
        ts = int(time.time()); CHUNK = 85000
        tmp = WORKER_DIR / ".tmp"; tmp.mkdir(parents=True, exist_ok=True)
        parts = [blob[i:i + CHUNK] for i in range(0, len(blob), CHUNK)]
        sql = ["DELETE FROM ups_auction_three_value;"]
        for i, ch in enumerate(parts):
            stmt = (f"INSERT INTO ups_auction_three_value (part, payload, updated_at) "
                    f"VALUES ({i}, '{ch.replace(chr(39), chr(39) * 2)}', {ts});")
            if len(stmt) > 99500:
                raise SystemExit(f"  ✘ part {i} statement {len(stmt)} bytes > 99.5KB — lower CHUNK.")
            sql.append(stmt)
        sql_path = tmp / "three_value_upsert.sql"; sql_path.write_text("\n".join(sql) + "\n")
        print(f"\n  pushing three_value blob to D1 ({'remote' if remote else 'LOCAL'}, "
              f"{len(parts)} parts, {len(blob)/1024:.1f}KB total) …")
        cmd = ["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db",
               ("--remote" if remote else "--local"), "--file", str(sql_path)]
        subprocess.run(cmd, cwd=str(WORKER_DIR), check=True)
        print(f"  pushed ups_auction_three_value ({len(parts)} parts)")

    # ---- console summary ----
    print(f"\n=== REGIME ===  R_now {R_now:.4f}  (fitted range {R_range})   M_money raw {m_raw:.4f} → served {m_money:.4f}"
          + ("   *** PINNED TO CLAMP FLOOR — chosen, not measured ***" if m_clamped else ""))
    print(f"=== ARMS (FA offense) === rw>=3 branch n={len(cred_rw)}: {dict(arms_rw)}    ep>=5-only n={len(cred_ep)}: {dict(arms_ep)}")
    print(f"=== dyn_anchor_hit TRUE on {sum(1 for r in rows if r['dyn_anchor_hit']=='TRUE')} rows ===")
    for b in NONSKILL:
        m = ladder_meta.get(b)
        if m:
            print(f"  ladder[{b}] n={m['n_clears']} median ${m['median_k']}K max ${m['max_k']}K "
                  f"rungs {[round(x,1) for x in ladder.get(b,[])[:6]]}")

    # ---- BUDGET-CONSTRAINT COHERENCE (first-class; fails LOUD out-of-band) ----
    print(f"\n=== BUDGET COHERENCE ===  projected spend ${coh['projected_spend_k']}K "
          f"(deploy {spend_parts['deploy_frac']}x avail ${spend_parts['available_k']}K, mandatory floor ${spend_parts['mandatory_floor_k']}K)")
    print(f"  predicted clearing set ${coh['predicted_clearing_k']}K  →  RATIO {coh['ratio']}  "
          f"[band {coh['band'][0]}-{coh['band'][1]}]  status={coh['status']}"
          + (f"  (normalize global x{budget_scale})" if args.budget_normalize == "global" and budget_scale < 1.0 else ""))
    print("  per-bucket predicted $K: " + "  ".join(f"{b}:{coh['per_bucket_pred_k'].get(b,0):.0f}"
          for b in ("QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN")))
    if coh["status"] == "FAIL":
        banner = ("\n" + "!" * 92 + "\n"
                  f"  *** COHERENCE FAIL: board top-N = {coh['ratio']}x the money that will be spent "
                  f"(${coh['predicted_clearing_k']}K vs ${coh['projected_spend_k']}K).\n"
                  f"  *** {coh['n_contract_star_fa']} FA priced >= ${coh['contract_star_threshold_k']}K — the fingerprint of a "
                  f"PRE-ROSTER-LOCK snapshot (contract stars coded FA).\n"
                  f"  *** Historical boards sit 0.66-0.97. REGENERATE AFTER THE ROSTER LOCK; this is a data-state "
                  f"artifact, not a pricing defect.\n"
                  + "!" * 92)
        print(banner, file=sys.stderr)
    if args.strict and coh["status"] == "FAIL":
        sys.exit(2)


if __name__ == "__main__":
    main()
