#!/usr/bin/env python3
"""Phase E — league-wide roster fit + INFLATION + finalize the FA value blob.

1. Pull all 12 live rosters → each team's production strength by position
   (rostered players' E[APWE]) vs a startable baseline B[pos] → per-team NEED / SURPLUS.
2. AUCTION INFLATION (back-tested on SF-era 2022-2025): cheap rostered contracts lock
   value below worth, leaving leftover cap that chases a small FA pool → prices clear
   ABOVE intrinsic worth. The clearing line is REGRESSIVE: clear ≈ α + β·worth (a flat
   ~$7K ante that lifts cheap/mid targets most; studs clear near worth — NOT a flat 1.9×).
   α scales with the live money/value REGIME (biddable_money ÷ available_value), so the
   factor tracks as players come off the board.  EP_inflated = max(EP_base, α·regime + β·worth).
3. Filter to AVAILABLE FAs (unrostered) + rostered TRADE TARGETS (own=fid).
4. Per FA: 0008's fit + a COMPETITION forecast (teams with a NEED there × cap space).
5. Write fa_value.json (lean, FAs only) + fa_valuation.csv; --push-d1 upserts the blob.
"""
from __future__ import annotations
import argparse, csv, json, re, sqlite3, subprocess, time, urllib.request, collections
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "docs" / "auction" / "data"
WORKER = REPO / "worker"
DB = "/tmp/ups_auction_canon.db"
LEAGUE = "74598"; YEAR = 2026; CAP = 300000
SKILL = ["QB", "RB", "WR", "TE"]
SLOTS = {"QB": 2, "RB": 2, "WR": 2, "TE": 1}          # SF starting demand per team
REPL_RANK = {"QB": 24, "RB": 31, "WR": 31, "TE": 14}  # replacement (marginal-starter) rank
SUFFIX = re.compile(r"\b(jr|sr|ii|iii|iv|v)\b")

# ── INFLATION (affine clearing line, back-tested SF-era 2022-2025 + adversarially verified) ──
# Realized FA prices fit paid$K ≈ ANTE + SLOPE·redraft_worth$K (OLS n≈88, R-fit on WORTH not
# EP). A flat scarcity ANTE on every credible target + a sub-1 slope → cheap/mid inflate most,
# studs clear near worth. Applied ADDITIVELY OVER the dynasty/startability anchor:
#     EP_inflated = max(EP_base, ANTE_live + SLOPE·redraft_worth)
# so the dynasty anchor (Allen $75K) is never deflated and never double-inflated (the verifier's
# fix — don't multiply a worth-calibrated factor onto the 1.88×-larger EP_base), while the ante
# lifts the mid/cheap pool. ANTE scales with the live money÷value regime → it dampens in a deep
# (stud-heavy) pool and CLIMBS as studs clear (late-board inflation). Mean realized 1.97×;
# per-year 1.57/1.81/1.89/2.61×; position spread emerges from the worth distribution (TE lowest
# worth → biggest multiplier, QB highest → smallest).
INFL_ANTE = 7.0        # SF-era flat scarcity ante $K on a credible target
INFL_SLOPE = 0.72      # worth pass-through (OLS paid~redraft_worth slope; <1 = stud compression)
DEPLOY_FRAC = 0.76     # biddable money = 0.76 × Σ(ceiling headroom)  [calibrated SF-era deploy fraction]
REGIME_BASE = 1.9      # SF-era biddable ÷ credible-redraft-worth (the norm at which ante = $7K)
CREDIBLE_WORTH = 2     # credible target: redraft worth ≥ $2K …
CREDIBLE_EP = 5        # … or EP_base ≥ $5K (startable). True scrubs hold the $1K floor (no ante).


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
    """MFL contractInfo → {aav_k, tcv_k, cl}. AAV (current annual cost) is the TRADE-TARGET price —
    they're not in the auction, so what you compare to worth is what their contract costs you."""
    out = {"aav_k": round((sal or 0) / 1000.0)}
    for k, rx in _CRX.items():
        m = rx.search(info or "")
        if m:
            out[k + ("_k" if k != "cl" else "")] = (int(m.group(1)) if k == "cl" else round(float(m.group(1))))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--push-d1", action="store_true")
    args = ap.parse_args()

    core = json.loads((DATA / "fa_value_core.json").read_text())["players"]
    by_name = {nkey(p["player"]): p for p in core}
    curve = json.loads((DATA / "eapw_curves.json").read_text())["curves"]["fpros"]   # redraft E[APWE] by rank
    B = {pos: (curve[pos]["p50"][REPL_RANK[pos] - 1] if pos in curve else 0.0) for pos in SKILL}
    STUD = {pos: (curve[pos]["p50"][5] if pos in curve and len(curve[pos]["p50"]) > 5 else 6.0) for pos in SKILL}

    # ---- live league state ----
    rosters = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=rosters&L={LEAGUE}&JSON=1")["rosters"]["franchise"]
    players = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=players&L={LEAGUE}&JSON=1")["players"]["player"]
    id2name = {str(p["id"]): p.get("name") for p in players}
    lg = jget(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=league&L={LEAGUE}&JSON=1")["league"]
    fid2team = {f["id"]: f.get("name", f["id"]) for f in lg["franchises"]["franchise"]}

    rostered_by_name, team, contract_by_name = {}, {}, {}
    surplus_k = 0.0     # Σ rostered (worth − contract), positive only = locked-cheap value
    for fr in rosters:
        fid = fr["id"]
        pls = fr.get("player", [])
        if isinstance(pls, dict): pls = [pls]
        active_sal = 0; apwe_by_pos = collections.defaultdict(list)
        for p in pls:
            nm = id2name.get(str(p.get("id")))
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
                     "active_salary": active_sal, "fit": fit}

    # ---- v4 MARKET CONTEXT (the affine clearing line is baked into EP in build_fa_value;
    #      no separate regime/ante machinery — the audit flagged those as unvalidated knobs) ----
    DEPLOY_FRAC = 0.76      # ~76% of ceiling headroom becomes real bids (calibrated SF-era)
    ceiling_headroom_k = sum(t["capspace"] for t in team.values()) / 1000.0
    biddable_money_k = round(DEPLOY_FRAC * ceiling_headroom_k)
    credible = [p for p in core if not rostered_by_name.get(nkey(p["player"]))
                and ((p.get("redraft_worth_k") or 0) >= 3 or (p.get("ep_base_k") or 0) >= 5)]
    credible_rworth_k = round(sum(p.get("redraft_worth_k") or 0 for p in credible)) or 1

    def re_verdict(ep_k, worth_k, p90):
        vr = round(worth_k / ep_k, 2) if ep_k > 0 else None
        if vr is None: return ("—", None)
        if vr >= 1.5 and worth_k >= 15: return ("SPLURGE", vr)   # real edge, well under price
        if vr >= 1.2: return ("VALUE", vr)
        if vr >= 0.8: return ("FAIR", vr)
        if ep_k <= 4: return ("DART" if (p90 or 0) >= 5 else "FAIR", vr)
        if ep_k < 15: return ("FAIR", vr)                        # cheap startable = market slot-rent, not an overpay
        return ("OVERPAY", vr) if vr < 0.6 else ("FAIR", vr)     # real overpay only on a non-trivial price

    # EP is FINAL from build_fa_value (max of affine clearing line ∨ startability floor ∨
    # position-weighted dynasty anchor). Pass it through + derive gap/verdict.
    for p in core:
        ep = p["ep_base_k"]
        p["ep_k"] = ep; p["median_k"] = ep
        p["low_k"] = round(ep * 0.78); p["top10_k"] = round(ep * 1.3)
        p["gap_k"] = ep - p["worth_k"]
        p["per_apwe"] = round(ep / p["e_apwe_p50"], 1) if (p.get("e_apwe_p50") or 0) > 0 else None
        v, vr = re_verdict(ep, p["worth_k"], p["e_apwe_p90"])
        p["verdict"] = v; p["value_ratio"] = vr

    # how far the credible board is priced over intrinsic redraft worth (descriptive only)
    markup = round(sum(p["ep_k"] for p in credible) / credible_rworth_k, 2) if credible_rworth_k else 1.0
    inflation = {   # kept key name for View compatibility; v4 = the affine clearing line, not a regime factor
        "model": "v4-affine", "ante": 2.67, "slope": 0.84, "deploy_frac": DEPLOY_FRAC,
        "ceiling_headroom_k": round(ceiling_headroom_k), "biddable_money_k": biddable_money_k,
        "credible_value_k": credible_rworth_k, "n_credible": len(credible),
        "surplus_k": round(surplus_k), "board_markup": markup,
        "backtest": {"clearing_line": "paid$K ≈ 2.67 + 0.84·redraft_worth (all clears, MSE 31, n=346)",
                     "dollar_weighted_inflation": 1.53,
                     "per_year": {"2022": 1.57, "2023": 1.98, "2024": 1.30, "2025": 1.46}},
        "note": f"v4 EP = max(startability floor, 2.67 + 0.84·redraft_worth [the harness-fit clearing line], "
                f"position-weighted dynasty anchor). RB clears win-now (dynasty ×0.55); QB/WR/TE command dynasty. "
                f"Board prices ~{markup}× intrinsic redraft worth; ${round(surplus_k)}K of locked rostered surplus + "
                f"${biddable_money_k}K biddable money is the market context. Historical $-weighted markup 1.53×.",
    }

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
            cs = comp_score(t, pos)
            if cs > 0.3 * (B[pos] or 0.01):
                cands.append((cs * max(0.05, t["capspace"] / CAP), fid, t["team"], round(cs, 2), t["capspace"]))
        cands.sort(reverse=True)
        return [{"fid": fid, "team": tm, "need": nd, "capspace": cs} for _, fid, tm, nd, cs in cands[:3]]

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
        # a trade target isn't in the auction → its "price" is its contract AAV, not the inflated EP.
        if owner and ctr:
            rec["aav_k"] = ctr.get("aav_k")
            rec["trade_gap_k"] = (ctr.get("aav_k") or 0) - (p.get("worth_k") or 0)   # neg = worth > cost = surplus
        fas.append(rec)
    fas.sort(key=lambda x: -(x.get("worth_k") or 0))

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
            "inflation": inflation,
            "tiers": tiers,
            "baseline_apw": {pos: round(B[pos], 2) for pos in SKILL},
            "stud_bar": {pos: round(STUD[pos], 2) for pos in SKILL},
            "replacement_rank": REPL_RANK, "starter_slots": SLOTS,
            "fill": {"by_season": fill, "avg_post_auction_adds_per_team": fill_avg,
                     "note": "adds between auction-end and ~Week 1; high = teams lock in fewer at auction and fill via waivers"},
            "verdict_legend": "SPLURGE/VALUE/FAIR/OVERPAY/DART by value_ratio=worth/EP_inflated; EP=expected (inflated) price, WORTH=blended value",
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
            "low_k": p["low_k"], "median_k": p["median_k"], "top10_k": p["top10_k"], "gap_k": p["gap_k"],
            "e_apwe_p25": p["e_apwe_p25"], "e_apwe_p50": p["e_apwe_p50"], "e_apwe_p90": p["e_apwe_p90"],
            "per_apwe": p["per_apwe"], "value_ratio": p["value_ratio"], "verdict": p["verdict"],
            "fit_0008": p["fit_0008"], "competition": p["competition"],
        } for p in fas],
    }
    (DATA / "fa_value.json").write_text(json.dumps(payload, indent=2))
    blob_len = len(json.dumps(payload))
    print(f"wrote {(DATA / 'fa_value.json').relative_to(REPO)} ({len(fas)} FAs, blob {blob_len/1024:.1f}KB)")

    # ---- CSV ----
    cols = ["player", "pos", "status", "owner", "dyn_sf_rank", "fp_rank",
            "redraft_worth_k", "dynasty_worth_k", "worth_k", "ep_k", "gap_k",
            "e_apwe_p50", "e_apwe_p90", "per_apwe", "value_ratio", "verdict", "fit_0008", "deal_type", "top_competitors"]
    with open(DATA / "fa_valuation.csv", "w", newline="") as f:
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
    print(f"\n=== v4 MARKET CONTEXT (affine clearing line baked into EP) ===")
    print(f"  Σ ceiling headroom ${inflation['ceiling_headroom_k']}K → biddable ${biddable_money_k}K (×{DEPLOY_FRAC})")
    print(f"  credible redraft-worth ${credible_rworth_k}K ({len(credible)} targets) → board prices ~{inflation['board_markup']}× over intrinsic worth")
    print(f"  locked rostered surplus (worth−cost, positive): ${inflation['surplus_k']}K")
    print(f"  clearing line: {inflation['backtest']['clearing_line']}")
    print(f"\n=== a few inflated prices (EP_base → EP_inflated) ===")
    for nm in ["Joe Mixon", "Stefon Diggs", "Aaron Rodgers", "Sam Darnold", "Travis Kelce", "Ja'Marr Chase"]:
        p = next((r for r in core if r["player"].startswith(nm)), None)
        if p: print(f"  {p['player'][:20]:<21}{str(p.get('fp_rank') or '-'):>6}  worth ${p['worth_k']:>3}  EP ${p['ep_base_k']:>3} → ${p['ep_k']:>3}  gap {('+' if p['gap_k']>=0 else '')}{p['gap_k']}  {p['verdict']}")
    print(f"\n=== 0008 roster fit ===")
    for pos in SKILL:
        ff = team["0008"]["fit"][pos]
        print(f"  {pos}: need {ff['need']:.1f}  surplus {ff['surplus']:.1f}  → {need_label('0008', pos)}")
    print(f"\n=== top FA targets (by worth, inflated price) ===")
    print(f"  {'player':<20}{'fpRk':>6}{'worth':>6}{'EP':>5}{'gap':>6}  {'verdict':<8}{'fit':<10}competition")
    for p in [x for x in fas if not x.get("own")][:14]:
        print(f"  {p['player'][:19]:<20}{str(p.get('fp_rank') or '-'):>6}{p['worth_k']:>6}{p['ep_k']:>5}"
              f"{(('+' if p['gap_k']>=0 else '')+str(p['gap_k'])):>6}  {p['verdict']:<8}{p['fit_0008']:<10}{', '.join(x['team'] for x in p['competition'][:2])}")

    if args.push_d1:
        # The View RE-DERIVES worth/gap/value_ratio/verdict from (rw, dw, e) + the live blend
        # slider, so the blob only carries the two worth components + the (fixed) inflated price.
        def r1(v): return round(v, 1) if isinstance(v, (int, float)) else v
        DT = {"cut-free dart": "d", "1-yr rental / flip": "r", "multi-year build": "m",
              "anchor": "a", "1-yr / situational": "s"}
        FT = {"NEED-STUD": "NS", "DEPTH": "D", "NEED": "N", "SURPLUS": "S", "OK": "-", "—": "-"}
        lean = {
            "meta": payload["meta"],
            "key": {"n": "player", "p": "pos", "dr": "dyn_sf_rank", "fr": "fp_rank",
                    "rw": "redraft_worth_k", "dw": "dynasty_worth_k", "e": "ep_k (inflated expected price; FA)",
                    "av": "aav_k (trade target's contract cost = its price; owned only)", "tcv": "tcv_k", "cl": "contract_len", "cy": "years_remaining",
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
                  "av": (p.get("contract") or {}).get("aav_k"), "tcv": (p.get("contract") or {}).get("tcv_k"),
                  "cl": (p.get("contract") or {}).get("cl"), "cy": (p.get("contract") or {}).get("cy"),
                  "a50": r1(p["e_apwe_p50"]), "a90": r1(p["e_apwe_p90"])}
                 if p.get("own") else
                 {"n": p["player"], "p": p["pos"], "dr": p["dyn_sf_rank"], "fr": p.get("fp_rank"),
                  "dt": DT.get(p["deal_type"], "s"),
                  "rw": p["redraft_worth_k"], "dw": p["dynasty_worth_k"], "e": p["ep_k"],
                  "a50": r1(p["e_apwe_p50"]), "a90": r1(p["e_apwe_p90"]),
                  "f": FT.get(p["fit_0008"], "-"), "c": [x["fid"] for x in p["competition"][:2]]})
                for p in fas],
        }
        blob = json.dumps(lean, separators=(",", ":")).replace("'", "''")
        print(f"\n  (lean D1 blob {len(blob)/1024:.1f}KB)")
        ts = int(time.time())
        tmp = WORKER / ".tmp"; tmp.mkdir(parents=True, exist_ok=True)
        sql_path = tmp / "fa_value_upsert.sql"
        sql_path.write_text(f"INSERT OR REPLACE INTO ups_auction_fa_value (id, payload, updated_at) VALUES (1, '{blob}', {ts});\n")
        print(f"  pushing fa_value blob to D1 ({len(blob)} bytes) …")
        subprocess.run(["npx", "--yes", "wrangler@latest", "d1", "execute", "ups-mfl-db", "--remote", "--file", str(sql_path)], cwd=str(WORKER), check=True)
        print("  pushed ups_auction_fa_value")


if __name__ == "__main__":
    main()
