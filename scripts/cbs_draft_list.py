#!/usr/bin/env python3
"""The full draft pool, grouped by the round ADP says a player goes.

WHY THIS IS NOT THE BOARD OR THE PLAN. The board ranks everyone by value; the
plan names one target per pick. Neither answers "who is worth taking in round
6" — for that you need the pool cut at the rounds the market actually drafts
in, with the expert signal attached to each slice.

⚠️ "BEST PICK OF ROUND N" IS THIS PAGE'S CONSTRUCTION, NOT A QUOTE. A hunt
across JJ Zachariason's, Scott Barrett's and Evan Silva's 2026 output found
their published work organised by TIER and positional band (WR19-WR42) or as
target/avoid lists — not round by round. So the highlight here is defined and
labelled: the most expert support inside the band, scored from stances that
were each re-fetched and confirmed. Presenting a derived pick as an analyst's
own "best of round 1" would be putting words in a real person's mouth.

Rounds come from ADP, not from your own picks: round 1 is ADP 1-12, round 2 is
13-24, and so on. A player with no ADP at all gets his own section rather than
being dropped — outside FFC's universe means undrafted in most rooms, which is
information, not absence.
"""
from __future__ import annotations

import argparse
import collections
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))
sys.path.insert(0, str(REPO / "scripts"))

import importlib.util                                            # noqa: E402


def _load(name, path):
    spec = importlib.util.spec_from_file_location(name, str(path))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


bdb = _load("bdb", REPO / "scripts" / "cbs_build_draft_board.py")
rpl = _load("rpl", REPO / "scripts" / "cbs_round_plan.py")

from fantasy import adp as adpmod                                # noqa: E402

TEMPLATE = REPO / "scripts" / "_draft_list_template.html"
TEAMS, ROUNDS = 12, 18

#: ⚠️ SCORE PER ANALYST, NOT PER TAKE. Summing takes let one person vote
#: repeatedly: Ashton Jeanty came out at -4 because Scott Barrett faded him on
#: two different shows, and Chase Brown got +2 twice because JJ's guide verdict
#: and JJ's podcast appearance were counted as separate voices. Three people
#: have opinions here, so the scale is three people wide.
#: FADES SUBTRACT. A player two analysts like and one fades is not the same as
#: one nobody argues about, and averaging the sign away hides exactly the
#: disagreement that makes him worth a second look.
W = {"like": 2.0, "fade": -2.0, "neutral": 0.0,
     "target": 2.0, "avoid": -2.0, "dart": 1.0}
#: JJ's written guide and JJ's podcast appearances are the same person.
GUIDE_AUTHOR = "JJ Zachariason"


def round_of(adp: float | None) -> int | None:
    if not adp or adp <= 0:
        return None
    return min(ROUNDS, int((adp - 1) // TEAMS) + 1)


def build(rows):
    for r in rows:
        who = [{"a": t["a"], "s": t["s"], "t": t["t"], "u": t["u"], "q": t["q"]}
               for t in r["st"]]
        # One net stance per analyst, then sum across analysts.
        by_analyst: dict[str, list[float]] = collections.defaultdict(list)
        for t in r["st"]:
            by_analyst[t["a"]].append(W.get(t["s"], 0.0))
        v = r.get("jjverdict")
        if v:
            by_analyst[GUIDE_AUTHOR].append(W.get(v, 0.0))
        sup, voices = 0.0, {}
        for a, vals in by_analyst.items():
            net = sum(vals)
            # Clamp to one analyst's worth of signal in whichever direction
            # they lean; a person who repeats himself is still one person.
            one = max(-2.0, min(2.0, net))
            sup += one
            voices[a] = one
        r["sup"] = round(sup, 1)
        r["voices"] = voices
        r["nvoice"] = len([a for a, x in voices.items() if x != 0.0])
        r["who"] = who
    return rows


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload-in", default=str(REPO / "data/analyst/board_payload.json"))
    ap.add_argument("--analyst-dir", default=str(REPO / "data/analyst"))
    ap.add_argument("--out", default=str(REPO / "data/analyst/draft_list_2026.html"))
    a = ap.parse_args()

    rel = Path(a.out).resolve()
    try:
        top = rel.relative_to(REPO).parts[0]
    except ValueError:
        top = None
    if top in bdb.TRACKED:
        raise SystemExit(f"refusing to write to {a.out} - {top}/ is tracked by "
                         f"git and this page carries paid-guide ranks.")

    pay = json.loads(Path(a.payload_in).read_text())
    root = Path(a.analyst_dir)
    jj = rpl.jj_positional(root / "jj_takes.json")
    st = rpl.stances(root / "verified_takes.json")
    ffc = {adpmod.player_key(r["player_name"]): r
           for r in adpmod.fetch_ffc(2026, scoring="ppr", teams=12).rows}

    people, books = {}, {}
    for book in ("p4", "p6"):
        rows = rpl.enrich(pay[book], ffc, jj, st)
        for r in rows:
            k = bdb.akey(r["nm"])
            r["jjverdict"] = (jj.get(k) or {}).get("verdict")
        rows = build(rows)
        order = []
        for r in sorted(rows, key=lambda r: (r["adp"] or 9e9, -r["vor"])):
            rec = people.setdefault(r["nm"], {
                "nm": r["nm"], "pos": r["pos"], "team": r["team"], "bye": r["bye"],
                "adp": r["adp"], "sd": r["sd"], "lo": r["lo"], "hi": r["hi"],
                "flag": r["flag"], "unproven": r["unproven"],
                "jjpr": r["jjpr"], "jjtier": r["jjtier"], "jjaav": r["jjaav"],
                "jjpos": r["jjpos"], "jjnote": r["jjnote"], "jjv": r["jjverdict"],
                "sup": r["sup"], "who": r["who"],
                "voices": r["voices"], "nvoice": r["nvoice"],
                # ⚠️ per-rulebook: these two move, the rest do not.
                "v": {}, "r": {},
            })
            rec["v"][book] = r["vor"]
            rec["r"][book] = r["pr"]
            order.append(r["nm"])
        books[book] = order

    # ── group by the round ADP puts them in ──────────────────────────────────
    groups = {}
    for book, order in books.items():
        g = collections.defaultdict(list)
        for nm in order:
            g[str(round_of(people[nm]["adp"]) or 0)].append(nm)
        groups[book] = dict(g)

    # ── the analysts' own round-by-round calls, if they have been extracted ──
    rp = root / "round_picks.json"
    named: dict = {}
    if rp.exists():
        d = json.loads(rp.read_text())
        by_key = {}
        for nm in people:
            by_key.setdefault(bdb.akey(nm), nm)
        for k in d["picks"]:
            nm = by_key.get(bdb.akey(k["player"]))
            if nm is None:
                continue
            # ⚠️ HIS ROUND, NOT THIS PAGE'S. JJ reads FantasyPros ADP tiers and
            # this list is cut on FFC ADP, so the same player can sit in
            # different rounds. Store what he said and carry the FFC round
            # alongside it, so a disagreement shows rather than resolving into
            # whichever number happened to be written last.
            named.setdefault(str(k["round"]), []).append({
                "nm": nm, "a": k["analyst"], "s": k["stance"], "t": k["take"],
                "u": k["url"], "q": k["quoted"],
                "ffc": round_of(people[nm]["adp"]),
            })
        print(f"  round-by-round: {sum(len(v) for v in named.values())} verified "
              f"calls across {len(named)} rounds; {len(d.get('refused_rounds') or [])} "
              f"refused for a non-round round field")
    else:
        print("  note: no round_picks.json - the analysts' own round calls are "
              "absent from this build, and the page will say so")

    payload = {"teams": TEAMS, "rounds": ROUNDS, "players": people,
               "groups": groups, "named": named}
    tpl = TEMPLATE.read_text(encoding="utf-8")
    if "__LIST__" not in tpl:
        raise SystemExit(f"{TEMPLATE} has no __LIST__ placeholder.")
    Path(a.out).write_text(
        tpl.replace("__LIST__", json.dumps(payload, separators=(",", ":"))),
        encoding="utf-8")

    # ⚠️ EVERY PLAYER MUST LAND SOMEWHERE. A grouping that silently drops rows
    # reads as a complete list while being anything but.
    for book, g in groups.items():
        n = sum(len(v) for v in g.values())
        if n != len(pay[book]):
            raise SystemExit(f"{book}: grouped {n} players but the board has "
                             f"{len(pay[book])}. Rows went missing.")

    print(f"wrote {a.out}  ({len(people)} players)")
    g4 = groups["p4"]
    for rd in range(1, ROUNDS + 1):
        names = g4.get(str(rd), [])
        if not names:
            continue
        best = max(names, key=lambda n: (people[n]["sup"], people[n]["v"]["p4"]))
        vor = max(names, key=lambda n: people[n]["v"]["p4"])
        tag = "" if best == vor else f"   (board's best: {vor})"
        print(f"  R{rd:>2} {len(names):>3} players | most expert support: "
              f"{best} ({people[best]['sup']:+.0f}){tag}")
    un = g4.get("0", [])
    print(f"  no ADP: {len(un)} players")
    return 0


if __name__ == "__main__":
    sys.exit(main())
