#!/usr/bin/env python3
"""Contract unification proposal (READ-ONLY) — current vs. proposed contract type.

Maps every ACTIVE rostered contract's messy MFL `contractStatus` to the canonical
vocabulary locked in docs/CONTRACT_AUTOMATION_PLAN.md, for Keith to review BEFORE
any write pass. Produces:
  - docs/contract_unification_<date>.csv   (full per-player table)
  - docs/CONTRACT_UNIFICATION_PROPOSAL_<date>.md (rules + counts + sample)

Canonical bases: Rookie-{Draft,FAA,WW,MYM}, Vet-{FAA,ERA,WW,MYM}, Tag,
Vet-Ext1, Vet-Ext2; optional loaded suffix -FL/-BL (auction wins + 2yr ext only).

Honest-not-fake: a player acquired via TRADE hides its contract origin (it
predates the trade), so vet origin there is marked low-confidence "needs
event-chain" rather than guessed. No numbers are invented.

MFL-API-native (snapshot + TYPE=players + TYPE=league). No local DB.
"""
from __future__ import annotations
import csv, json, re, sys, urllib.request
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
SNAP = REPO / "data" / "mfl-snapshots"
LEAGUE_ID = "74598"
SERVER = "https://www48.myfantasyleague.com"
YEAR = "2026"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 ups-contract-unify"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)


def as_list(x):
    return [] if x is None else (x if isinstance(x, list) else [x])


def latest_snapshot():
    ds = sorted([p for p in SNAP.iterdir() if p.is_dir() and re.match(r"\d{4}-\d{2}-\d{2}", p.name)])
    return ds[-1]


def parse_cl(ci):
    m = re.search(r"CL\s*(\d+)", ci or "")
    return int(m.group(1)) if m else None


def parse_year_schedule(ci):
    return [int(x) for x in re.findall(r"Y\d+\s*-\s*(\d+)", ci or "")]


def loaded_shape(status, ci):
    s = status.upper()
    if "FL" in s:
        return "FL"
    if "BL" in s:
        return "BL"
    # infer from a multi-year schedule shape (front/back loaded)
    ys = parse_year_schedule(ci)
    if len(ys) >= 2:
        first, rest = ys[0], sum(ys[1:]) / (len(ys) - 1)
        if rest and first >= 1.5 * rest:
            return "FL?"
        if rest and first <= 0.67 * rest:
            return "BL?"
    return None


def drafted_origin(drafted):
    d = (drafted or "").strip()
    if re.match(r"^\d+\.\d", d):
        return "Draft"
    if d.startswith("Auction"):
        return "FAA"
    if d.startswith("BB"):
        return "WW"            # blind-bid = waiver/WW path
    if d.startswith("FCFS"):
        return "FAA"           # first-come free agent
    if d.startswith("Trade"):
        return "Trade"         # origin predates the trade — unknown here
    return "?"


def propose(status, drafted, ci, contract_year):
    """-> (proposed_type, confidence, note)"""
    st = (status or "").strip()
    stu = st.upper()
    cl = parse_cl(ci)
    origin = drafted_origin(drafted)
    extended = stu in ("EXT1", "EXT2", "EXT2-BL", "EXT2-FL") or bool(re.search(r"Ext\s*:", ci or ""))
    shape = loaded_shape(st, ci)
    suffix = ""
    if shape in ("FL", "BL"):
        suffix = "-" + shape
    note = ""

    # 1) Tag
    if stu in ("TAG", "TAG ", "TAG"):
        return "Tag", "high", "Tag/TAG case-merge."
    if st in ("Tag",):
        return "Tag", "high", ""

    # 2) Rookie bases (origin standard, unextended)
    if stu in ("R", "ROOKIE") or st.startswith("MYM - Rookie"):
        if st.startswith("MYM - Rookie"):
            return "Rookie-MYM", "high", ""
        omap = {"Draft": "Rookie-Draft", "FAA": "Rookie-FAA", "WW": "Rookie-WW"}
        if origin in omap:
            return omap[origin], "high", ""
        if origin == "Trade":
            return "Rookie-Draft", "med", "Traded rookie — origin assumed Draft; confirm via event chain."
        return "Rookie-Draft", "low", "Rookie origin unclear; defaulted to Draft."

    # 3) Extensions supersede origin (trust an explicit EXT length over CL)
    if extended:
        if stu.startswith("EXT2"):
            ext_len = 2
        elif stu.startswith("EXT1"):
            ext_len = 1
        else:
            ext_len = 2 if (cl and cl >= 2) else 1
        base = f"Vet-Ext{ext_len}"
        if ext_len == 2 and suffix:
            base += suffix
        conf = "high" if stu.startswith("EXT") else "med"
        if not stu.startswith("EXT"):
            note = "Has Ext: token but non-EXT status — reclassify as extension."
        return base, conf, note

    # 4) Vet origin, unextended
    if st == "Vet-ERA":
        return "Vet-ERA" + suffix, "high", ""
    if st.startswith("MYM - Vet"):
        return "Vet-MYM" + suffix, "high", ""
    omap = {"FAA": "Vet-FAA", "WW": "Vet-WW"}
    if origin in omap:
        return omap[origin] + suffix, "high" if st in ("FL", "BL", "Veteran") else "med", note
    if origin == "Draft":
        # Drafted via a rookie pick but status not labeled R/Rookie — most likely
        # still on (or re-signed from) a rookie deal; flag vs a vet re-sign.
        return "Rookie-Draft?", "low", "Drafted via rookie pick, status unlabeled — confirm rookie deal vs vet re-sign."
    if origin == "Trade":
        return "Vet-FAA" + suffix + "?", "low", "Traded vet — origin (FAA/WW/ERA) needs event chain; defaulted FAA."
    # blank/unknown vet
    return "Vet-FAA" + suffix + "?", "low", "Vet origin unresolved from snapshot; needs event chain."


def completeness_note(ci, cl):
    ci = ci or ""
    if not ci.strip():
        return "BACKFILL: contractInfo blank"
    if cl and cl >= 2 and not parse_year_schedule(ci):
        return "BACKFILL: multi-year missing Y-schedule"
    if cl and cl >= 2 and "TCV" not in ci:
        return "BACKFILL: multi-year missing TCV"
    return ""


PICK_RE = re.compile(r"\b(\d+)\.(\d)\b")


def pad_pick(drafted):
    """Draft picks are 2-digit in MFL ('1.10'); restore a trailing zero a float
    coercion may have dropped ('1.1' -> '1.10'). Keith 2026-05-31."""
    return PICK_RE.sub(lambda m: f"{m.group(1)}.{m.group(2)}0", drafted or "")


def normalize_contract_info(ci):
    """Fold a rookie 'Keep Option as Y4Option =11K' tail into the year schedule as
    'Y4-11K Option' (Keith 2026-05-31)."""
    ci = ci or ""
    m = re.search(r"\|?\s*Keep Option as Y(\d+)Option\s*=?\s*([\d.]+ ?K?)", ci, re.I)
    if not m:
        return ci
    yr, amt = m.group(1), m.group(2).replace(" ", "").strip()
    ci2 = (ci[:m.start()] + ci[m.end():]).rstrip().rstrip("|").rstrip()
    yts = list(re.finditer(r"Y\d+\s*-\s*[\d.]+ ?K?", ci2))
    if yts:
        pos = yts[-1].end()
        ci2 = ci2[:pos] + f", Y{yr}-{amt} Option" + ci2[pos:]
    return ci2


OVERRIDES_FILE = REPO / "docs" / "contract_unification_overrides.csv"

# Whole-cluster confirmations (Keith "all ok" on a current→proposed pair). A row
# whose (current_type, proposed_type) is here — and isn't individually overridden
# — is marked "confirmed" without needing a per-player override row.
CONFIRMED_CLUSTERS = {
    ("MYM - Rookie", "Rookie-MYM"),
    ("MYM - Vet", "Vet-MYM"),
    ("TAG", "Tag"), ("Tag", "Tag"),
    ("Vet-ERA", "Vet-ERA"),
    ("Veteran", "Vet-FAA"),     # high-conf only; traded vets stay "Vet-FAA?" (distinct)
    ("Veteran", "Vet-Ext2"),    # the 11 ok (the 9 Ext1 corrections are per-player overrides)
    ("Veteran", "Vet-WW"),      # pre-deadline WW (post-deadline → Vet-MYM via override)
    ("R", "Rookie-Draft"),
    ("Rookie", "Rookie-Draft"),
    ("(blank)", "Rookie-Draft"),  # restored 2025 rookies
    ("Rookie", "Rookie-FAA"), ("Rookie", "Rookie-WW"),
    ("R", "Rookie-FAA"), ("R", "Rookie-WW"),  # "all other rookies ok"
}


def load_overrides():
    """Keith-reviewed final types (docs/contract_unification_overrides.csv) — these
    win over the derived proposal so the manual review persists across regenerations."""
    out = {}
    if OVERRIDES_FILE.exists():
        for row in csv.DictReader(open(OVERRIDES_FILE)):
            out.setdefault(row["player"].strip(), []).append(
                (row.get("pos", "").strip(), row["final_type"].strip(), row.get("note", "").strip(), row.get("restructure_year", "").strip())
            )
    return out


def main():
    snap = latest_snapshot()
    date = snap.name
    rosters = json.load(open(snap / "rosters.json"))["rosters"]["franchise"]
    players = {p["id"]: p for p in fetch(f"{SERVER}/{YEAR}/export?TYPE=players&L={LEAGUE_ID}&DETAILS=0&JSON=1")["players"]["player"]}
    lg = fetch(f"{SERVER}/{YEAR}/export?TYPE=league&L={LEAGUE_ID}&JSON=1")["league"]
    fids = {f["id"]: f.get("name", f["id"]) for f in as_list(lg["franchises"]["franchise"])}
    # Prior-season contracts — restore blank-status players whose 2026 contractInfo
    # was wiped (data error): roll their last-season deal forward. Keith 2026-05-31.
    prev_year = str(int(YEAR) - 1)
    rest = {}
    try:
        r_prev = fetch(f"{SERVER}/{prev_year}/export?TYPE=rosters&L={LEAGUE_ID}&JSON=1")["rosters"]["franchise"]
        for f in as_list(r_prev):
            for p in as_list(f.get("player")):
                rest[str(p["id"])] = (str(p.get("contractStatus", "")), p.get("contractInfo", "") or "")
    except Exception as e:
        print(f"warn: could not fetch {prev_year} rosters for restore: {e}")
    overrides = load_overrides()

    rows = []
    for fr in rosters:
        fid = fr["id"]
        for p in as_list(fr.get("player")):
            pid = str(p["id"])
            meta = players.get(pid, {})
            ci = p.get("contractInfo", "") or ""
            cl = parse_cl(ci)
            cur_type = (p.get("contractStatus", "") or "").strip() or "(blank)"
            drafted = pad_pick(p.get("drafted", ""))
            prop, conf, note = propose(p.get("contractStatus", ""), drafted, ci, p.get("contractYear", ""))
            proposed_ci = normalize_contract_info(ci)
            # Blank-status = wiped contractInfo (data error). If the player held a
            # Rookie deal last season, restore it (roll forward) + classify Rookie-Draft.
            if cur_type == "(blank)" and rest.get(pid, ("", ""))[0] == "Rookie":
                prop, conf = "Rookie-Draft", "high"
                note = f"Restored from {prev_year} (2026 contractInfo wiped); roll contractYear forward."
                proposed_ci = normalize_contract_info(rest[pid][1])
            # Keith-reviewed overrides win (the manual cluster review). An optional
            # pos disambiguates duplicate player names (e.g. two Justin Jeffersons).
            for opos, otype, onote, orestr in overrides.get(meta.get("name", "").strip(), []):
                if not opos or opos == meta.get("position", ""):
                    prop, conf, note = otype, "confirmed", onote
                    # restructure annotation (drops if/when the contract changes again)
                    if orestr and "restructure:" not in proposed_ci.lower():
                        proposed_ci = (proposed_ci.rstrip() + f"| restructure: {orestr}") if proposed_ci.strip() else f"restructure: {orestr}"
                    break
            else:
                if (cur_type, prop) in CONFIRMED_CLUSTERS:
                    conf, note = "confirmed", note or "confirmed (cluster review 2026-05-31)"
            ci_note = completeness_note(proposed_ci, parse_cl(proposed_ci)) or "(numbers unchanged — type only)"
            rows.append({
                "franchise": fids.get(fid, fid),
                "player": meta.get("name", f"#{pid}"),
                "pos": meta.get("position", ""),
                "current_type": cur_type,
                "proposed_type": prop,
                "confidence": conf,
                "current_contractInfo": ci,
                "proposed_contractInfo": proposed_ci,
                "proposed_contractInfo_note": ci_note,
                "mapping_note": note,
                "drafted": drafted,
            })

    rows.sort(key=lambda r: (r["franchise"], r["player"]))
    out_csv = REPO / "docs" / f"contract_unification_{date}.csv"
    with open(out_csv, "w", newline="") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader()
        w.writerows(rows)

    # summary
    from collections import Counter
    cur_ct = Counter(r["current_type"] for r in rows)
    prop_ct = Counter(r["proposed_type"] for r in rows)
    conf_ct = Counter(r["confidence"] for r in rows)
    transitions = Counter((r["current_type"], r["proposed_type"]) for r in rows)
    backfill = [r for r in rows if r["proposed_contractInfo_note"].startswith("BACKFILL")]

    print(f"=== Contract unification proposal ({date}) — {len(rows)} active contracts ===")
    print(f"CSV: {out_csv}")
    print(f"\nConfidence: {dict(conf_ct)}")
    print(f"contractInfo needing backfill: {len(backfill)}")
    print("\nCurrent type -> proposed type (top transitions):")
    for (a, b), c in transitions.most_common(25):
        print(f"  {c:3d}  {a:14} -> {b}")
    return out_csv, date, rows, transitions, conf_ct, backfill


if __name__ == "__main__":
    main()
