#!/usr/bin/env python3
"""Normalize contractInfo so EVERY active contract carries a correct GTD and a
full Y-schedule (Keith: "everything in unison, nothing inconsistent").

GTD value rule (canon §6 + Keith 2026-06-01, applies to ALL contract types):
  - TCV >= $5K            -> GTD = 75% x TCV, half-up to 1 decimal (33.75 -> 33.8K)
  - TCV <= $4K, CL == 2   -> GTD = $1K
  - TCV <= $4K, CL >= 3   -> GTD = $2K
  - TCV <= $4K, CL == 1   -> no GTD (1-year-under-$5K = 0% guarantee, cap-free)
The sub-$5K override (fixed $1K/$2K) replaces 75% entirely for TCV <= $4K
(docs/league_context_v1.md §D1, "Sub-$5K TCV rule").

Schedule: per-year salary. Flat (TCV == CL*AAV) is generated; the four known
step-ups are taken from EXPLICIT_SCHEDULES; an already-present schedule (incl.
non-flat: Collins, Hill, restructures) is preserved verbatim. The 4th-year option
(Y3+$5K, §A1) is added only for rookies that are 1st-round 2025+ or "Option Eligible".

AAV is NEVER touched. canon §C5 (locked): "AAV is PRESERVED VERBATIM. Never
recompute it… including a dual AAV (e.g. AAV 33K, 43K) set forward-looking at the
extension. AAV changes only at an extension, never from structure alone." This
script changes structure (GTD + schedule), so it has no business rewriting AAV.
(Until 2026-08-05 it set AAV = current-year salary, which flattened dual-AAV
escalators and is what roster_workbench.js's normalizeContractInfoForDisplay had
to keep undoing at read time.)

GTD is inserted right after the schedule (before Ext/restructure); existing GTDs
are value-corrected in place. Default dry-run; --write emits dry_run=false.
"""
import argparse, decimal, json, re, urllib.request

LEAGUE, SERVER, YEAR = "74598", "https://www48.myfantasyleague.com", "2026"

# Hand-verified step-up schedules (Keith). Y1 = last cheap year; remaining years
# = the stepped-up salary. Sums are checked against MFL TCV before use.
EXPLICIT_SCHEDULES = {
    "Addison, Jordan": [7, 17],
    "Dowdle, Rico": [1, 11],
    "Kincaid, Dalton": [9, 29, 29],
    "Achane, De'Von": [5, 25, 25],
}


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
    q = decimal.Decimal(1).scaleb(-dp)
    return float(decimal.Decimal(str(v)).quantize(q, rounding=decimal.ROUND_HALF_UP))


def fmtk(v):
    v = round(v, 1)
    return f"{int(v)}K" if v == int(v) else f"{v}K"


def gtd_value(tcv, cl):
    """Canon GTD rule. Returns the guaranteed $K, or None when no GTD applies."""
    if tcv is None or cl is None:
        return None
    if tcv >= 5:
        return round_half_up(tcv * 0.75, 1)
    if cl <= 1:            # 1-year original under $5K -> 0% guarantee
        return None
    return 1.0 if cl == 2 else 2.0  # sub-$5K: CL2 -> $1K, CL3+ -> $2K


def parse_ci(ci):
    ci = ci or ""
    return dict(
        cl=(lambda m: int(m.group(1)) if m else None)(re.search(r"CL\s*(\d+)", ci)),
        tcv=(lambda m: num(m.group(1)) if m else None)(re.search(r"TCV\s*([\d.]+)\s*K", ci)),
        # `aav` = the CURRENT tier only, used for arithmetic (flat schedule,
        # option year). `aav_raw` = the token VERBATIM, including a dual AAV's
        # second tier ("33K, 43K"), which is what gets re-emitted — canon §C5
        # requires the token survive untouched.
        aav=(lambda m: num(m.group(1)) if m else None)(re.search(r"AAV\s*([\d.]+)", ci)),
        aav_raw=(lambda m: m.group(1).strip() if m else None)(re.search(r"AAV\s+([^|]+)", ci)),
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


def build_full_ci(c, status, drafted, sched):
    """Build a contract that is MISSING its schedule (flat or explicit step-up)."""
    cl, tcv, aav = c["cl"], c["tcv"], c["aav"]
    # Re-emit the AAV token EXACTLY as MFL had it. Reformatting it through
    # fmtk() collapsed a dual AAV ("33K, 43K") to its first tier, silently
    # destroying the forward-looking escalator (canon §C5).
    parts = [f"CL {cl}", f"TCV {fmtk(tcv)}", f"AAV {c['aav_raw'] or fmtk(aav)}"]
    ys = [f"Y{i+1}-{fmtk(sched[i])}" for i in range(len(sched))] if sched else [f"Y{i}-{fmtk(aav)}" for i in range(1, cl + 1)]
    if "Rookie" in status and (c["opt_elig"] or (draft_round(drafted) == 1 and (draft_year(drafted) or 0) >= 2025)):
        ys.append(f"Y{cl + 1}-{fmtk(aav + 5)} Option")
    parts.append(", ".join(ys))
    g = gtd_value(tcv, cl)
    if g is not None:
        parts.append(f"GTD: {fmtk(g)}")
    if c["ext"]:
        parts.append(c["ext"])
    if c["restruct"]:
        parts.append(c["restruct"])
    return "| ".join(parts)


# set_aav() REMOVED 2026-08-05 — it violated a locked canon rule.
#
# It rewrote every contract's AAV token to that year's salary, and its own
# docstring noted it "handles stray multi-value forms like 'AAV 32K, 42K'" —
# i.e. it collapsed genuine dual-AAV escalators to a single number.
#
# league_context_v1.md §C5 (locked): "AAV is PRESERVED VERBATIM. Never
# recompute it… including a dual AAV (e.g. AAV 33K, 43K) set forward-looking at
# the extension. AAV changes only at an extension, never from structure alone."
# And: "AAV tokens in live MFL are unreliable (some hold the Y1 salary…).
# Preserve the token as-is."
#
# The script justified itself as "mirroring roster_workbench.js (AAV =
# currentSalary)", but roster_workbench does the OPPOSITE — its
# normalizeContractInfoForDisplay() RESTORES the prior season's AAV. That read-
# time repair existed solely to undo this write, on 7 contracts (Tagovailoa,
# Jefferson, Higgins, Olave, McBride, G. Wilson, Sutton) where MFL then held
# the salary instead of the real AAV. Flat contracts were unaffected because
# AAV == salary there by definition, which is why this hid for so long.
#
# Nothing replaces it: a contract's AAV is set at signing/extension and is
# never derived from structure.


def strip_gtd(ci):
    return "| ".join(seg for seg in re.split(r"\s*\|\s*", ci) if seg.strip() and not re.match(r"GTD\b", seg.strip()))


def insert_gtd(ci, token):
    """Insert `token` after the Y-schedule (or after AAV when there's no schedule)."""
    last = None
    for mm in re.finditer(r"Y\d+\s*-\s*[\d.]+\s*K?(?:\s*Option)?", ci):
        last = mm
    if not last:
        last = re.search(r"AAV\s*[\d.]+\s*K?", ci)
    if not last:
        return ci.rstrip().rstrip("|").rstrip() + f"| {token}"
    head, tail = ci[:last.end()], ci[last.end():].lstrip()
    if tail.startswith("|"):
        tail = tail[1:].lstrip()
    return f"{head.rstrip()}| {token}" + (f"| {tail}" if tail else "")


def with_gtd(ci, tcv, cl):
    """Ensure an already-scheduled contract has a correct GTD (add / correct / strip)."""
    want = gtd_value(tcv, cl)
    has = re.search(r"GTD\s*:?\s*([\d.]+)\s*K", ci)
    if want is None:
        return strip_gtd(ci) if has else ci
    if has:
        if abs(float(has.group(1)) - want) < 0.05 and re.search(r"GTD:\s", ci):
            return ci
        return re.sub(r"GTD\s*:?\s*[\d.]+\s*K", f"GTD: {fmtk(want)}", ci)
    return insert_gtd(ci, f"GTD: {fmtk(want)}")


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
            if not (c["cl"] and c["tcv"] is not None):
                continue
            needs_schedule = (not c["ysched"] or c["opt_elig"]) and c["cl"] >= 2 and c["aav"] is not None
            if needs_schedule:
                sched = EXPLICIT_SCHEDULES.get(name)
                if sched and abs(sum(sched) - c["tcv"]) > 1.0:
                    skipped.append(f"{name}: explicit {sched} sums {sum(sched)} != TCV {c['tcv']} — RECHECK")
                    continue
                if not sched and abs(c["tcv"] - c["cl"] * c["aav"]) > 1.0:
                    skipped.append(f"{name}: TCV {c['tcv']} != CL*AAV and no explicit schedule — needs event chain")
                    continue
                new_ci = build_full_ci(c, status, drafted, sched)
            else:
                new_ci = with_gtd(ci, c["tcv"], c["cl"])
            # (No AAV rewrite. This script normalizes GTD and the Y-schedule
            # only — the AAV token is carried through untouched per canon §C5.)
            if new_ci == ci:
                continue
            rows.append({"id": pid, "salary": str(p.get("salary", "") or ""), "contractStatus": status,
                         "contractYear": str(p.get("contractYear", "") or ""), "contractInfo": new_ci})
            preview.append(f"- {name[:20]:20} [{status}]\n      {ci!r}\n   -> {new_ci!r}")

    rows = [r for r in rows if r["salary"] and r["contractInfo"]]
    payload = {"season": YEAR, "league_id": LEAGUE, "dry_run": (not a.write), "rows": rows}
    open(a.payload, "w").write(json.dumps(payload, indent=2))
    rk = sum(1 for r in rows if "Rookie" in r["contractStatus"])
    print(f"contractInfo normalization: {len(rows)} contracts would change ({rk} rookie, {len(rows)-rk} vet/tag) · {len(skipped)} skipped")
    print(f"dry_run={payload['dry_run']} · payload={a.payload}\n")
    for line in preview:
        print(line)
    if skipped:
        print(f"\nSKIPPED (need event chain / review): {len(skipped)}")
        for s in skipped:
            print("  -", s)


if __name__ == "__main__":
    main()
