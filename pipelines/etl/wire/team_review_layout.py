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
    for need in ("power_rank", "sim_p_playoffs", "sim_p_title", "auction_spend", "cap_current_room"):
        if F(need) not in facts:
            raise SystemExit("%s: pack has no fact %s" % (pack["packId"], F(need)))
    ents = pack.get("entities") or {}
    team = (ents.get("franchises") or [{}])[0].get("name")
    owner = (ents.get("owners") or [{}])[0].get("display")
    if not team or not owner:
        raise SystemExit("%s: pack entities lack a team or owner name" % pack["packId"])
    secs = dict((s["id"], s) for s in prose["sections"])
    # Four sections since 2026-09-11: history and the division are one
    # ("you can combine historical context with the divisional writeup").
    if sorted(secs) != ["s1", "s2", "s3", "s4"]:
        raise SystemExit("%s: expected sections s1-s4, got %s" % (pack["packId"], sorted(secs)))

    prose["kicker"] = "%s · %s" % (team, owner)
    for k in ("dek", "title"):
        prose[k] = ordify(prose.get(k) or "")
    for s in prose["sections"]:
        s["paragraphs"] = [ordify(x) for x in s.get("paragraphs") or []]
        if s.get("lead"):
            s["lead"] = ordify(s["lead"])

    # The strip leads with the preseason simulation now that it exists and is
    # backtested -- Keith held the power rankings until it was. Rank and the two
    # odds a reader asks about first, then the money.
    prose["strip"] = [
        {"fact": F("power_rank"), "ord": True, "of": "f.league.teams", "label": "Power rank"},
        {"fact": F("sim_p_playoffs"), "label": "Playoff odds"},
        {"fact": F("sim_p_title"), "label": "Title odds"},
        {"fact": F("auction_spend"), "label": "Spent at auction"},
        {"fact": F("cap_current_room"), "label": "Cap room"},
    ]
    # Never the front-page lead: the Season Forecast is (Keith 2026-09-11:
    # "Front Page should have a blurb like you do followed by Seasonal
    # Forecast"). The team-review family still reads in power-rank order.
    prose["card"] = {"rankFact": F("power_rank"), "ofFact": "f.league.teams", "featured": False}

    def lay(sid, items):
        """items: (table key, view, anchor, caption). A table with no rows is
        not placed -- an empty "Before the rookie draft" box says nothing. The
        anchor is a paragraph index, "last", or a regex: the table sits under
        the first paragraph matching it, or at the section's end if none does."""
        paras = secs[sid].get("paragraphs") or []
        place, at, views, caps = [], {}, {}, {}
        for key, view, anchor, cap in items:
            t = tables.get(key)
            if not t or not t["rows"]:
                continue
            place.append(tid(key))
            views[tid(key)] = view
            if cap:
                caps[tid(key)] = cap
            if not paras:
                continue
            if anchor == "last":
                at[tid(key)] = len(paras) - 1
            elif isinstance(anchor, int):
                at[tid(key)] = min(anchor, len(paras) - 1)
            elif anchor:
                k = _first(paras, lambda x, a=anchor: re.search(a, x, re.I), default=-1)
                if k >= 0:
                    at[tid(key)] = k
        secs[sid].update(place=place, placeAt=at, views=views, captions=caps)

    moves = {"cols": ["date", "move", "player", "detail", "grade"], "stack": True}
    # Keith: "give the lay of the land the way you do in the bridge, however
    # only show the 1st column of the table."
    lay("s1", [
        ("slot_bridge", {"cols": ["slot", "open"], "labels": {"open": "April"},
                         "title": "April: who held each priced slot"}, 0, None),
        ("moves_s1", dict(moves, title="Before the rookie draft"), r"\b(cut|releas|trad|extend)", None),
        ("expired", {"cols": ["player", "pos", "outcome"], "title": "Rookie deals that ran out"},
         r"expired_|ran out|rookie deal", None),
    ])
    lay("s2", [
        ("rookies", {"cols": ["pick", "player", "baseline", "val"], "title": "The rookie class",
                     "labels": {"baseline": "History at this slot", "val": "Grade today"}},
         r"draft|rookie_picks", None),
        ("moves_s2", dict(moves, title="From the draft to the auction lock"),
         r"\b(tag|cut|releas|trad)|Expired Rookie", None),
    ])
    s3 = [("faa", {"cols": ["player", "pos", "price", "grade"], "rows": 8, "title": "Biggest buys"},
           r"Free Agent Auction|faa_spend|faa_\d+_price", None)]
    # The league comparison from team_review_league.py. Rank, dollars and what
    # the money bought -- Keith: "We see $$ Spent, but we don't know what it
    # bought". The shares and the rate multiple stay in the pack, unprinted.
    if "faa_value" in tables:
        # Ranked by the IMPROVEMENT, not improvement per dollar: per dollar
        # put The Long Haulers third for three depth buys (Keith: "at best this
        # is a net neutral play ... it shouldn't be much different than PG or
        # Cleon").
        s3.append(("faa_value", {"cols": ["rank", "team", "spend", "gain_share", "bought"],
                                 "labels": {"spend": "Spent on offense", "gain_share": "Share of the improvement",
                                            "bought": "What it bought"},
                                 "title": "What every owner's auction money bought"},
                   r"faa_off_",
                   "Ranked by how much each owner's starting offense improved between the auction lock and "
                   "the close; a buy that never makes the lineup adds nothing. What it bought grades each "
                   "quarterback, back, receiver and tight end at his position: Elite is this year's "
                   "separated top, which is one man at some positions and nobody at others, Very good the "
                   "rest of the top twelve, Good the next twelve at quarterback, back and receiver (every "
                   "team starts two, counting the superflex), Starter depth anyone else who starts somewhere "
                   "in the league, and Bench depth the rest."))
    s3 += [("moves_s3", dict(moves, title="From the auction to week one"),
            r"restructur|multi-year|waiver|free-agent|picked up", None),
           # The pack's lineup is the strongest LEGAL lineup the roster can
           # field, by grade -- not the one the owner set (the Week table has
           # that, and they differ).
           ("lineup", {"cols": ["slot", "player", "val"], "labels": {"val": "Grade"},
                       "title": "The lineup it built"}, "last", None),
           # Keith: "review all injuries that have occurred thus far".
           ("injuries", {"cols": ["player", "slot", "status", "details", "returns", "held"],
                         "labels": {"details": "Injury", "returns": "Expected back",
                                    "held": "Forecast sits him (weeks)"},
                         "title": "Injuries"}, r"injur", None)]
    lay("s3", s3)
    # History and the division are ONE section -- Keith: "you can combine
    # historical context with the divisional writeup...it's a natural flow".
    wk = next((k for k in sorted(tables) if re.match(r"week\d+$", k)), None)
    s4 = [("history", {"stack": True, "title": "Owner history"}, 0, None),
          ("division", {"stack": True, "title": "The division"},
           r"division_name|power_rank_\d|sim_p_division", None),
          ("division_weeks", {"cols": ["week", "games", "byes", "rival_byes"], "title": "The division weeks",
                              "labels": {"games": "Division games", "byes": "His starters on bye",
                                         "rival_byes": "Rivals' starters on bye"}},
           r"div_weeks|div_week_", None)]
    if wk:
        s4.append((wk, {"cols": ["player", "pos", "slot", "pts", "line"], "stack": True,
                        "title": "Week one, so far", "labels": {"pts": "Points", "line": "What he did"}},
                   "last", "Only games that had finished when this was written. A blank line means he "
                           "recorded no scoring stat or did not play."))
    lay("s4", s4)
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
