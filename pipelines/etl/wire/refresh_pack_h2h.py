#!/usr/bin/env python3
"""Re-derive a built weekly pack's head-to-head series after a history correction.

A full `wire.py build` re-reads everything live -- rosters, projections,
injuries -- so rebuilding a pack to pick up a fix to OLD seasons would also
drag newer data past the preview's cutoff. This touches only the fields that
come from wire_data.HeadToHead, with the builder's own wording
(packs.weekly_recap.series_phrases):

  * f.pv.g<N>.h2h  -- value (regular-season margin) and fmt (desk text)
  * t.pv.games     -- the "series" column

Every other fact, table, source and the pack's generatedAtUtc are left as
built. Dry run by default; --write saves the pack and appends a warning line
saying what was re-derived and why.

    python pipelines/etl/wire/refresh_pack_h2h.py --pack 2026-wk03-recap \\
        --reason "2012 Week 13 playoff-flag correction (PR #1162)" [--write]
"""

import argparse
import datetime
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "packs"))
import wire_data as D  # noqa: E402
from weekly_recap import series_phrases  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.dirname(HERE)))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pack", required=True, help="pack id, e.g. 2026-wk03-recap")
    ap.add_argument("--reason", required=True, help="why the series changed; recorded in the pack's warnings")
    ap.add_argument("--write", action="store_true")
    args = ap.parse_args()

    season = int(args.pack.split("-")[0])
    path = os.path.join(REPO, "site", "wire", "packs", str(season), "%s.pack.json" % args.pack)
    raw = open(path, encoding="utf-8").read()
    pack = json.loads(raw)
    if json.dumps(pack, indent=2, ensure_ascii=False) + "\n" != raw:
        sys.exit("REFUSE: %s does not round-trip byte-identically; a rewrite would reformat it" % path)
    tables = {t["id"]: t for t in pack["tables"]}
    facts = {f["id"]: f for f in pack["facts"]}
    if "t.pv.games" not in tables:
        sys.exit("REFUSE: %s has no t.pv.games -- nothing to re-derive" % args.pack)

    # The builder counts games strictly before the previewed week.
    h2h = D.HeadToHead(season, int(pack["week"]) + 1)
    changes = []

    i = 1
    while "f.pv.g%d.h2h" % i in facts:
        f = facts["f.pv.g%d.h2h" % i]
        fav, dog = facts["f.pv.g%d.favorite" % i]["fmt"], facts["f.pv.g%d.underdog" % i]["fmt"]
        s = h2h.series(fav, dog)
        text, _ = series_phrases(s, fav, dog)
        value = s["reg"]["a"] - s["reg"]["b"]
        if (f["fmt"], f["value"]) != (text, value):
            changes.append(("fact %s" % f["id"], "%s | %s" % (f["value"], f["fmt"]), "%s | %s" % (value, text)))
            f["fmt"], f["value"] = text, value
        i += 1

    t = tables["t.pv.games"]
    col = [c["key"] for c in t["columns"]].index("series")
    for row in t["rows"]:
        fav, dog = row[0].split(" vs ")
        _, cell = series_phrases(h2h.series(fav, dog), fav, dog)
        if row[col] != cell:
            changes.append(("t.pv.games %s" % row[0], row[col], cell))
            row[col] = cell

    for where, before, after in changes:
        print("%s\n   before: %s\n   after:  %s" % (where, before, after))
    print("%d field(s) differ from the current D1 series" % len(changes))
    if not changes or not args.write:
        print("nothing written" if not changes else "dry run -- re-run with --write")
        return

    today = datetime.date.today().isoformat()
    pack["warnings"].append(
        "%s: head-to-head series re-derived from src_schedule after the %s (refresh_pack_h2h.py). "
        "Changed: %s. Nothing else was re-fetched; every other figure keeps this pack's original "
        "build (%s) and preview cutoff." % (today, args.reason, "; ".join(
            "%s %s -> %s" % (w, b, a) for w, b, a in changes), pack["generatedAtUtc"]))
    with open(path, "w", encoding="utf-8") as out:
        out.write(json.dumps(pack, indent=2, ensure_ascii=False) + "\n")
    print("wrote", os.path.relpath(path, REPO))


if __name__ == "__main__":
    main()
