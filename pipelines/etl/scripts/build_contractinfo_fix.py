#!/usr/bin/env python3
"""Normalize contractInfo to ONE consistent full format (Keith: nothing inconsistent).

For every active contract whose structure is DERIVABLE, rebuild contractInfo as:
  CL n| TCV xK| AAV yK| Y1-yK, ..., Yn-yK[, Y(n+1)-(y+5)K Option]| GTD: zK[| Ext: ...][| restructure: YYYY]
where the Y-schedule is the (flat) per-year salary, the 4th-year option is added
only for 1st-round 2025+ rookies (= Y3+$5K per §A1), and GTD = 75% of TCV (§6).

Only touches contracts that are currently missing the schedule/GTD/option AND are
flat (TCV == CL*AAV) or terse "Option Eligible". Loaded/restructured contracts
whose year split isn't derivable (TCV != CL*AAV) are LEFT for the event chain.
Default is a dry-run preview; --write emits dry_run=false. MFL-API-native.
"""
import argparse, json, re, sys, urllib.request

LEAGUE, SERVER, YEAR = "74598", "https://www48.myfantasyleague.com", "2026"


def fetch(u):
    return json.load(urllib.request.urlopen(urllib.request.Request(u, headers={"User-Agent": "Mozilla/5.0"}), timeout=30))


def as_list(x):
    return [] if x is None else (x if isinstance(x, list) else [x])


def num(s):
    try:
        return float(s)
    except Exception:
        return None


def fmtk(v):
    v = round(v, 1)
    return f"{int(v)}K" if v == int(v) else f"{v}K"


def parse_ci(ci):
    ci = ci or ""
    return dict(
        cl=(lambda m: int(m.group(1)) if m else None)(re.search(r"CL\s*(\d+)", ci)),
        tcv=(lambda m: num(m.group(1)) if m else None)(re.search(r"TCV\s*([\d.]+)\s*K", ci)),
        aav=(lambda m: num(m.group(1)) if m else None)(re.search(r"AAV\s*([\d.]+)", ci)),
        ysched=re.findall(r"Y\d+\s*-", ci),
        ext=(lambda m: m.group(0).strip() if m else None)(re.search(r"Ext\s*:[^|]*", ci)),
        restruct=(lambda m: m.group(0).strip() if m else None)(re.search(r"restructure\s*:\s*\d+", ci, re.I)),
        opt_elig=bool(re.search(r"Option\s*Eligible", ci, re.I)),
    )


def draft_round(d):
    m = re.match(r"^(\d+)\.", (d or "").strip())
    return int(m.group(1)) if m else None


def draft_year(d):
    m = re.search(r"\((\d{4})\)", d or "")
    return int(m.group(1)) if m else None


def build_full_ci(c, status, drafted):
    cl, tcv, aav = c["cl"], c["tcv"], c["aav"]
    parts = [f"CL {cl}", f"TCV {fmtk(tcv)}", f"AAV {fmtk(aav)}"]
    ys = [f"Y{i}-{fmtk(aav)}" for i in range(1, cl + 1)]
    # Option year for 1st-round 2025+ rookies (§A1) — OR any contract currently
    # marked "Option Eligible" (preserves it even when drafted is "Trade", so a
    # traded 1st-rounder's option isn't dropped).
    if "Rookie" in status and (c["opt_elig"] or (draft_round(drafted) == 1 and (draft_year(drafted) or 0) >= 2025)):
        ys.append(f"Y{cl + 1}-{fmtk(aav + 5)} Option")
    parts.append(", ".join(ys))
    parts.append(f"GTD: {fmtk(tcv * 0.75)}")
    if c["ext"]:
        parts.append(c["ext"])
    if c["restruct"]:
        parts.append(c["restruct"])
    return "| ".join(parts)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--payload", default="/tmp/ci_fix_payload.json")
    a = ap.parse_args()

    players = {p["id"]: p for p in fetch(f"{SERVER}/{YEAR}/export?TYPE=players&L={LEAGUE}&DETAILS=0&JSON=1")["players"]["player"]}
    rows, preview, skipped = [], [], []
    for f in as_list(fetch(f"{SERVER}/{YEAR}/export?TYPE=rosters&L={LEAGUE}&JSON=1")["rosters"]["franchise"]):
        for p in as_list(f.get("player")):
            pid = str(p["id"])
            name = players.get(pid, {}).get("name", pid)
            status = str(p.get("contractStatus", "") or "")
            ci = str(p.get("contractInfo", "") or "")
            drafted = str(p.get("drafted", "") or "")
            c = parse_ci(ci)
            needs = (not c["ysched"]) or c["opt_elig"]
            if not (needs and c["cl"] and c["cl"] >= 2 and c["tcv"] and c["aav"]):
                continue
            if abs(c["tcv"] - c["cl"] * c["aav"]) > 1.0:  # non-flat → can't derive year split
                skipped.append(f"{name}: TCV {c['tcv']}K != CL*AAV ({c['cl']}*{c['aav']}) — needs event chain")
                continue
            new_ci = build_full_ci(c, status, drafted)
            if new_ci == ci:
                continue
            rows.append({"id": pid, "salary": str(p.get("salary", "") or ""), "contractStatus": status,
                         "contractYear": str(p.get("contractYear", "") or ""), "contractInfo": new_ci})
            preview.append(f"- {name[:20]:20} {ci!r}\n      -> {new_ci!r}")

    rows = [r for r in rows if r["salary"] and r["contractInfo"]]
    payload = {"season": YEAR, "league_id": LEAGUE, "dry_run": (not a.write), "rows": rows}
    open(a.payload, "w").write(json.dumps(payload, indent=2))
    print(f"contractInfo normalization: {len(rows)} contracts would change · {len(skipped)} skipped (non-derivable)")
    print(f"dry_run={payload['dry_run']} · payload={a.payload}\n")
    for line in preview[:25]:
        print(line)
    if skipped:
        print(f"\nSKIPPED (need event chain / review): {len(skipped)}")
        for s in skipped:
            print("  -", s)


if __name__ == "__main__":
    main()
