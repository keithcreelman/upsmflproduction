#!/usr/bin/env python3
"""Repair non-canonical contractStatus casing — dry-run by default.

The nightly reconcile fails on Sam Darnold: contractStatus 'VET-EXT1' where
canon is 'Vet-Ext1'. 43 of 44 extension contracts are already canonical, so
this is a single-row casing defect, not a systemic one. The CONTRACT is
intact (CL 2, TCV 46K, dual AAV 18K→28K, and it does carry the 'Ext:' token)
— only the label is wrong, so no money moves.

WHY A FULL-ROW WRITE: MFL's salaries import BLANKS every attribute you omit
(see mfl_salaries_import_blanks_omitted_attributes — a contractInfo-only row
wiped 3 live contracts). So the row is re-read fresh here and ALL FOUR
attributes are echoed back with only the casing changed.

Refuses rather than guesses:
  - player not found in the salaries export        -> refuse
  - status already canonical                       -> no-op (re-runs safe)
  - casing-insensitive match is not the expected   -> refuse (something other
    than casing changed; a human should look)
  - salary / contractYear / contractInfo missing   -> refuse (a blank one of
    those is exactly what the import would wipe)
"""
import json
import re
import sys
import urllib.request

LEAGUE = "74598"
CANON = re.compile(r"^(Rookie-(Draft|FAA|WW|MYM)|Vet-(FAA|ERA|WW|MYM|Ext1|Ext2))(-FL|-BL)?$|^Tag$")
# Canonical spellings, keyed by their uppercase form.
KNOWN = {}
for base in ["Rookie-Draft", "Rookie-FAA", "Rookie-WW", "Rookie-MYM",
             "Vet-FAA", "Vet-ERA", "Vet-WW", "Vet-MYM", "Vet-Ext1", "Vet-Ext2", "Tag"]:
    for suf in ["", "-FL", "-BL"]:
        v = base + suf if base != "Tag" else base
        KNOWN[v.upper()] = v


def esc(v):
    return (str(v).replace("&", "&amp;").replace('"', "&quot;")
            .replace("<", "&lt;").replace(">", "&gt;"))


def main(season, pid):
    url = f"https://www48.myfantasyleague.com/{season}/export?TYPE=salaries&L={LEAGUE}&JSON=1"
    players = json.load(urllib.request.urlopen(url, timeout=60))["salaries"]["leagueUnit"]["player"]
    row = next((p for p in players if str(p.get("id")) == str(pid)), None)
    if not row:
        print(f"REFUSE: player {pid} not in the salaries export."); return 2

    cur = str(row.get("contractStatus", "") or "")
    print(f"CURRENT (fresh read from MFL salaries):")
    for k in ("id", "contractStatus", "salary", "contractYear", "contractInfo"):
        print(f"    {k:15} {row.get(k)!r}")

    if CANON.match(cur):
        print(f"\nNO-OP: {cur!r} is already canonical. Nothing to write."); return 0

    want = KNOWN.get(cur.upper())
    if not want:
        print(f"\nREFUSE: {cur!r} has no canonical counterpart — not a casing fix."); return 2
    if cur.upper() != want.upper():
        print(f"\nREFUSE: {cur!r} differs from {want!r} by more than casing."); return 2

    # Every attribute the import will carry must be present, or the write blanks it.
    missing = [k for k in ("salary", "contractYear", "contractInfo")
               if str(row.get(k, "")).strip() == ""]
    if missing:
        print(f"\nREFUSE: {missing} empty on this row — a full-row import would blank them.")
        return 2

    xml = (
        "<salaries>\n"
        '  <leagueUnit unit="LEAGUE">\n'
        f'    <player id="{esc(pid)}" salary="{esc(row["salary"])}" '
        f'contractStatus="{esc(want)}" contractYear="{esc(row["contractYear"])}" '
        f'contractInfo="{esc(row["contractInfo"])}" />\n'
        "  </leagueUnit>\n"
        "</salaries>"
    )
    print(f"\nCHANGE: contractStatus {cur!r} -> {want!r}")
    print("        (salary, contractYear, contractInfo all echoed back UNCHANGED)")
    print(f"\nEXACT XML TO POST:\n{xml}")
    open("/tmp/vocab_fix.xml", "w").write(xml)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "2026",
                  sys.argv[2] if len(sys.argv) > 2 else "13592"))
