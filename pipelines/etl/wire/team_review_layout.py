#!/usr/bin/env python3
"""Lay out a team review: the key-number strip, the index card, and which pack
tables each section shows. Run after `write`, before `render`:

    python pipelines/etl/wire/team_review_layout.py --pack 2026-team-0008
    python pipelines/etl/wire/team_review_layout.py --all 2026

WHY THIS EXISTS. The first twelve published team reviews were 1,700 words of
unbroken prose each: every pack carried twelve tables and none was ever placed,
because placement was left to the writer and the writer never did it. Layout is
not a writing decision, so it is made here, deterministically, from the pack:

  * kicker  -> "<team> · <owner>", the label a reader scans the index for
  * strip   -> five key numbers under the dek, straight from pack facts
  * card    -> the index badge (league rank) and the front-page lead (rank 1)
  * place / placeAt / views -> one table per section, trimmed to what a reader
    needs (see wire_render.table_view), placed beside the prose about it
  * rank tokens -> {{..._rank|ord}} ("7th"), except where the sentence already
    says the rank in words

Idempotent: running it on laid-out prose changes nothing. Every value still
comes from the pack, and every string added here passes the render audit.

Stdlib only, invoked by path, like wire.py.
"""

import argparse
import glob
import io
import json
import os
import re
import sys

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
PACKS = os.path.join(REPO, "site", "wire", "packs")

TOK = re.compile(r'\{\{\s*[a-zA-Z0-9._-]+\s*(?:\|\s*ord\s*)?\}\}')
RANK = re.compile(r'\{\{\s*(f\.team\.\d{4}\.[a-z_]*_rank)\s*\}\}')
# A rank already restated in words right after the token ("ranks 1, first in
# the league", "12, dead last", "3 of 12 from the bottom") stays a cardinal.
RESTATED = re.compile(r'\b(first|second|third|fourth|fifth|sixth|last|bottom)\b', re.I)
# Ranks where 1 is the SMALLEST, not the best. As an ordinal they read
# backwards: "the largest defensive share of any owner, ranking 12th of 12"
# published in a draft of this pass. Never ordinalised; prose should say
# "largest"/"smallest" in words instead of quoting the rank at all.
NO_ORD = ("idp_auction_share_rank",)


def ordify(s):
    out, pos = [], 0
    ranks = list(RANK.finditer(s))
    for n, m in enumerate(ranks):
        # Look only as far as the NEXT rank token: "ranks 11, points per started
        # defender ranks 12 -- last" restates the second rank, not the first.
        stop = ranks[n + 1].start() if n + 1 < len(ranks) else m.end() + 160
        tail = TOK.sub("N", s[m.end():min(stop, m.end() + 160)])
        tail = re.split(r'(?<=[a-z0-9])\.\s', tail)[0][:80]
        keep = bool(RESTATED.search(tail)) or m.group(1).endswith(NO_ORD)
        out.append(s[pos:m.start()])
        out.append(m.group(0) if keep else "{{%s|ord}}" % m.group(1))
        pos = m.end()
    out.append(s[pos:])
    return "".join(out)


def _first(paras, pred, start=0, default=0):
    for i, x in enumerate(paras):
        if i >= start and pred(x):
            return i
    return default


def apply_layout(prose, pack):
    fid = pack["packId"].split("-")[-1]
    facts = dict((f["id"], f) for f in pack["facts"])
    tables = dict((t["id"].split(".")[-1], t) for t in pack["tables"])
    tid = lambda k: "t.%s.%s" % (fid, k)
    F = lambda k: "f.team.%s.%s" % (fid, k)
    for need in ("composite_rank", "studs_today", "holes_today", "auction_spend", "cap_current_room"):
        if F(need) not in facts:
            raise SystemExit("%s: pack has no fact %s" % (pack["packId"], F(need)))
    ents = pack.get("entities") or {}
    team = (ents.get("franchises") or [{}])[0].get("name")
    owner = (ents.get("owners") or [{}])[0].get("display")
    if not team or not owner:
        raise SystemExit("%s: pack entities lack a team or owner name" % pack["packId"])
    secs = dict((s["id"], s) for s in prose["sections"])
    if sorted(secs) != ["s1", "s2", "s3", "s4", "s5"]:
        raise SystemExit("%s: expected sections s1-s5, got %s" % (pack["packId"], sorted(secs)))

    prose["kicker"] = "%s · %s" % (team, owner)
    for k in ("dek", "title"):
        prose[k] = ordify(prose.get(k) or "")
    for s in prose["sections"]:
        s["paragraphs"] = [ordify(x) for x in s.get("paragraphs") or []]
        if s.get("lead"):
            s["lead"] = ordify(s["lead"])

    # Studs and holes are both counted over the NINE priced offensive slots
    # (QB/RB/WR/TE and the flexes), not the eighteen-man lineup -- the labels
    # have to say so, or "top-twelve starters: 2" reads as two of eighteen.
    prose["strip"] = [
        {"fact": F("composite_rank"), "ord": True, "of": "f.league.teams", "label": "Overall"},
        {"fact": F("studs_today"), "label": "Offensive studs", "suffix": "of nine"},
        {"fact": F("holes_today"), "label": "Offensive holes", "suffix": "of nine"},
        {"fact": F("auction_spend"), "label": "Spent at auction"},
        {"fact": F("cap_current_room"), "label": "Cap room"},
    ]
    prose["card"] = {"rankFact": F("composite_rank"), "ofFact": "f.league.teams",
                     "featured": int(float(facts[F("composite_rank")]["value"])) == 1}

    # The pack's lineup is the strongest LEGAL lineup the roster can field, by
    # value -- not the lineup the owner actually started (the Week 1 table has
    # that, and they differ). Titled "The starting lineup" it contradicted the
    # Week 1 table's own Started?/Bench column in four reviews.
    secs["s1"].update(place=[tid("lineup")], placeAt={tid("lineup"): 0}, views={tid("lineup"): {
        "cols": ["slot", "player", "val"], "labels": {"val": "Grade"}, "title": "Strongest legal lineup"}})

    # No "(short of a lineup)" on the April columns. Keith: every roster is short
    # in April -- contracts expire and the auction refills them -- so saying so
    # is noise, and he had already said it once.
    secs["s2"].update(place=[tid("slot_bridge")], placeAt={tid("slot_bridge"): 0}, views={tid("slot_bridge"): {
        "cols": ["slot", "open", "pre", "now"], "stack": True, "title": "Who filled each priced slot",
        "labels": {"open": "April", "pre": "Before the auction", "now": "After it"}}})

    p3 = secs["s3"]["paragraphs"]
    place3 = [tid("auction")]
    at3 = {tid("auction"): _first(p3, lambda x: "Free Agent Auction" in x or "faa_" in x)}
    views3 = {tid("auction"): {"cols": ["player", "pos", "auction", "price"], "sortDesc": "price", "rows": 5,
                               "title": "Biggest buys", "labels": {"auction": "Where"}}}
    caps3 = {}
    # The league comparison from team_review_league.py, beside the paragraph that
    # uses it ("value per dollar" -- Keith asked for every owner's, not one).
    if "faa_value" in tables:
        place3.append(tid("faa_value"))
        k = _first(p3, lambda x: "faa_off_" in x, default=-1)
        if k >= 0:
            at3[tid("faa_value")] = k
        # Rank and dollars only. Keith: "you can say who is better based on calcs
        # but I don't want to put a value that wouldn't make sense for everyone
        # else" -- so the shares and the "1.28x" rate stay in the pack, unprinted.
        views3[tid("faa_value")] = {"cols": ["rank", "team", "spend"], "labels": {"spend": "Spent on offense"},
                                    "title": "Who got the most for his money"}
        caps3[tid("faa_value")] = ("Ranked by how much each owner's starting offense improved between the "
                                   "auction lock and the close, for every dollar he spent on quarterbacks, "
                                   "backs, receivers and tight ends at the Free Agent Auction.")
    secs["s3"].update(place=place3, placeAt=at3, views=views3, captions=caps3)

    if tables["trades"]["rows"]:
        p4 = secs["s4"]["paragraphs"]
        secs["s4"].update(
            place=[tid("trades")],
            placeAt={tid("trades"): _first(p4, lambda x: re.search(r'\btrade', x, re.I), start=1)},
            views={tid("trades"): {"cols": ["date", "partner", "gave", "got"], "stack": True, "title": "Trades"}})

    p5 = secs["s5"]["paragraphs"]
    wk = _first(p5, lambda x: "wk_points_final" in x or "wk_teams_final" in x, default=len(p5) - 1)
    place5 = [tid("division")]
    views5 = {tid("division"): {"cols": ["team", "comp"], "labels": {"comp": "League rank"},
                                "title": "The division"}}
    at5 = {tid("division"): 0}
    caps5 = {}
    if tables.get("week1") and tables["week1"]["rows"]:
        place5.append(tid("week1"))
        views5[tid("week1")] = {"cols": ["player", "pos", "slot", "pts", "line"], "stack": True,
                                "title": "Week one, so far", "labels": {"pts": "Points", "line": "What he did"}}
        at5[tid("week1")] = wk
        # The reader half of the pack note, which a view hides: what a blank
        # "What he did" cell means.
        caps5[tid("week1")] = ("Only games that had finished when this was written. A blank line "
                               "means he recorded no scoring stat or did not play.")
    secs["s5"].update(place=place5, placeAt=at5, views=views5, captions=caps5)
    return prose


def run(pack_id):
    season = pack_id.split("-")[0]
    pack_file = os.path.join(PACKS, season, "%s.pack.json" % pack_id)
    prose_file = os.path.join(PACKS, season, "%s.prose.json" % pack_id)
    pack = json.load(io.open(pack_file, encoding="utf-8"))
    raw = io.open(prose_file, encoding="utf-8").read()
    blob = json.loads(raw)
    blob["prose"] = apply_layout(blob["prose"], pack)
    out = json.dumps(blob, indent=1, ensure_ascii=False) + "\n"
    if out != raw:
        io.open(prose_file, "w", encoding="utf-8", newline="\n").write(out)
        print("layout: updated %s" % os.path.relpath(prose_file, REPO))
    else:
        print("layout: %s already laid out" % pack_id)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--pack", help="one team-review pack id, e.g. 2026-team-0008")
    g.add_argument("--all", metavar="SEASON", help="every team review in a season")
    args = ap.parse_args()
    if args.pack:
        ids = [args.pack]
    else:
        ids = sorted(os.path.basename(p)[:-len(".prose.json")] for p in
                     glob.glob(os.path.join(PACKS, args.all, "%s-team-*.prose.json" % args.all)))
    for pid in ids:
        run(pid)
    print("next: render each pack, then restyle, index, verify")
    return 0


if __name__ == "__main__":
    sys.exit(main())
