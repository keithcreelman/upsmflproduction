#!/usr/bin/env python3
"""Contract-info consistency audit (READ-ONLY) — verify every active contract's
contractInfo is internally consistent + uses one format. Per docs/league_context
§A1/§6: GTD = 75% of TCV; 1st-round (2025+) rookies get a 4th-year option =
Year-3 + $5K; multi-year deals carry a Y-schedule that sums to TCV.

Flags per player:
  - OPTION_FORMAT : a rookie option shown terse ("Option Eligible") instead of the
    full Y-schedule + "Y4-<n>K Option" + GTD.
  - OPTION_MISSING: a 1st-round 2025+ rookie with no option year.
  - OPTION_UNEXPECTED: a non-1st-round rookie carrying an option.
  - GTD_OFF/MISSING/UNEXPECTED : GTD must follow canon — 75%xTCV for TCV>=$5K,
    fixed $1K (CL2) / $2K (CL3+) for TCV<=$4K, none for 1-yr-under-$5K (CL1 sub-$5K).
  - SCHED_MISSING : CL>=2 (multi-year) with no Y-schedule.
  - SCHED_SUM     : Y-schedule present but sum != TCV.
MFL-API-native; no writes.
"""
import argparse, json, re, sys, urllib.request

LEAGUE, SERVER = "74598", "https://www48.myfantasyleague.com"


def fetch(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))


def as_list(x):
    return [] if x is None else (x if isinstance(x, list) else [x])


def num(s):
    try:
        return float(s)
    except Exception:
        return None


def round_half_up(v, dp=1):
    import decimal
    return float(decimal.Decimal(str(v)).quantize(decimal.Decimal(1).scaleb(-dp), rounding=decimal.ROUND_HALF_UP))


def gtd_value(tcv, cl):
    """Canon GTD rule (docs/league_context_v1.md §6 + §D1, Keith 2026-06-01):
    TCV>=$5K -> 75%xTCV (half-up); TCV<=$4K -> $1K if CL2 / $2K if CL3+;
    CL1 sub-$5K -> None (1-year-under-$5K = 0% guarantee). Returns $K or None."""
    if tcv is None or cl is None:
        return None
    if tcv >= 5:
        return round_half_up(tcv * 0.75, 1)
    if cl <= 1:
        return None
    return 1.0 if cl == 2 else 2.0


def parse_ci(ci):
    ci = ci or ""
    cl = (lambda m: int(m.group(1)) if m else None)(re.search(r"CL\s*(\d+)", ci))
    tcv = (lambda m: num(m.group(1)) if m else None)(re.search(r"TCV\s*([\d.]+)\s*K", ci))
    aav = (lambda m: num(m.group(1)) if m else None)(re.search(r"AAV\s*([\d.]+)", ci))
    gtd = (lambda m: num(m.group(1)) if m else None)(re.search(r"GTD\s*:?\s*([\d.]+)\s*K", ci))
    ysched = [(int(a), num(b)) for a, b in re.findall(r"Y(\d+)\s*-\s*([\d.]+)", ci)]
    opt_amt = (lambda m: num(m.group(1)) if m else None)(re.search(r"Y\d+\s*-\s*([\d.]+)\s*K?\s*Option", ci, re.I))
    opt_elig = bool(re.search(r"Option\s*Eligible", ci, re.I))
    return dict(cl=cl, tcv=tcv, aav=aav, gtd=gtd, ysched=ysched, opt_amt=opt_amt, opt_elig=opt_elig)


def draft_round(drafted):
    m = re.match(r"^(\d+)\.", (drafted or "").strip())
    return int(m.group(1)) if m else None


def draft_year(drafted):
    m = re.search(r"\((\d{4})\)", drafted or "")
    return int(m.group(1)) if m else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", default="2026")
    ap.add_argument("--report")
    a = ap.parse_args()
    players = {p["id"]: p.get("name", p["id"]) for p in fetch(f"{SERVER}/{a.year}/export?TYPE=players&L={LEAGUE}&DETAILS=0&JSON=1")["players"]["player"]}

    issues = []
    n = 0
    for f in as_list(fetch(f"{SERVER}/{a.year}/export?TYPE=rosters&L={LEAGUE}&JSON=1")["rosters"]["franchise"]):
        for p in as_list(f.get("player")):
            n += 1
            name = players.get(str(p["id"]), p["id"])
            status = str(p.get("contractStatus", "") or "")
            ci = str(p.get("contractInfo", "") or "")
            drafted = str(p.get("drafted", "") or "")
            c = parse_ci(ci)
            rnd = draft_round(drafted)
            dyr = draft_year(drafted)
            pi = []

            # rookie option format / correctness (option exists for 1st round, 2025+ draft only)
            is_rookie = "Rookie" in status
            opt_eligible = is_rookie and rnd == 1 and (dyr or 0) >= 2025
            if c["opt_elig"] and not c["ysched"]:
                pi.append(("OPTION_FORMAT", "terse 'Option Eligible' — expand to Y-schedule + Y4 option + GTD"))
            if opt_eligible and not (c["opt_amt"] or c["opt_elig"]):
                pi.append(("OPTION_MISSING", f"1st-round 2025+ rookie (drafted {drafted}) has no option year"))
            if is_rookie and rnd and rnd >= 2 and (c["opt_amt"] or c["opt_elig"]):
                pi.append(("OPTION_UNEXPECTED", f"round-{rnd} rookie carries an option (only round 1 gets one)"))
            if c["opt_amt"] and c["ysched"]:
                y3 = next((amt for yr, amt in c["ysched"] if yr == 3), None) or (c["ysched"][-1][1] if c["ysched"] else None)
                if y3 is not None and abs(c["opt_amt"] - (y3 + 5)) > 0.6:
                    pi.append(("OPTION_PRICE", f"option {c['opt_amt']}K != Y3+5 ({y3}+5={y3+5}K)"))

            # GTD per canon rule (75% of TCV >=$5K; $1K/$2K sub-$5K; none for CL1 sub-$5K)
            want_gtd = gtd_value(c["tcv"], c["cl"])
            if c["gtd"] is not None and want_gtd is None:
                pi.append(("GTD_UNEXPECTED", f"GTD {c['gtd']}K but rule says no GTD (CL{c['cl']} sub-$5K)"))
            elif want_gtd is not None and c["gtd"] is None:
                pi.append(("GTD_MISSING", f"no GTD but rule wants {want_gtd}K"))
            elif c["gtd"] is not None and abs(c["gtd"] - want_gtd) > 0.05:
                pi.append(("GTD_OFF", f"GTD {c['gtd']}K != rule {want_gtd}K"))

            # multi-year schedule presence + sum (ignore the option year)
            if c["cl"] and c["cl"] >= 2 and c["tcv"]:
                if not c["ysched"]:
                    pi.append(("SCHED_MISSING", f"CL {c['cl']} but no Y-schedule"))
                else:
                    base = sum(amt for yr, amt in c["ysched"] if not (c["opt_amt"] and amt == c["opt_amt"] and yr == max(y for y, _ in c["ysched"])))
                    if abs(base - c["tcv"]) > 1.0:
                        pi.append(("SCHED_SUM", f"Y-schedule sums {base}K != TCV {c['tcv']}K"))

            for code, why in pi:
                issues.append({"player": name, "status": status, "code": code, "why": why, "ci": ci})

    from collections import Counter
    by_code = Counter(i["code"] for i in issues)
    print(f"Contract-info audit {a.year}: {n} contracts · {len(issues)} issue(s) across {len(set(i['player'] for i in issues))} players")
    for code, ct in by_code.most_common():
        print(f"  {code}: {ct}")
    print()
    for i in sorted(issues, key=lambda i: (i["code"], i["player"])):
        print(f"  [{i['code']}] {i['player'][:20]:20} {i['why']}")
    if a.report:
        open(a.report, "w").write(json.dumps(issues, indent=2))
    return 1 if issues else 0


if __name__ == "__main__":
    sys.exit(main())
