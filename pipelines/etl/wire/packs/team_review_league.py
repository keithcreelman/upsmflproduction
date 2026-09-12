#!/usr/bin/env python3
"""League context for the team reviews: what each owner's Free Agent Auction
money bought, measured against everybody else's.

    python pipelines/etl/wire/packs/team_review_league.py --season 2026

Run after all twelve team packs are built (and before team_review_layout.py).
It reads the twelve packs, derives the comparison, and writes the result back
into every pack: a set of f.team.<fid>.faa_off_* facts and one league table,
t.<fid>.faa_value. Idempotent -- a second run changes nothing.

WHY. Keith, reviewing the first formatted reviews: "38,878 of lineup value
MEANS nothing" -- and "how much value did he add relative to the $$ spent?
Same context for other owners." A raw lineup-value total is an internal unit.
What a reader can use is a COMPARISON: this owner spent X% of the league's
money and got Y% of the league's improvement.

WHAT IS MEASURED, and why each choice:
  * OFFENSE ONLY, on both sides. Lineup value is the redraft value of the
    QB/RB/WR/TE starters; defenders carry no ADP. So the dollars are the
    offensive Free Agent Auction dollars too -- dividing offensive value by
    TOTAL spend would punish an owner for buying defense (The Long Haulers put
    most of their money there).
  * The window is the auction roster lock to the auction close, the same two
    snapshots every pack's bridge already uses. Expired Rookie Auction buys
    were rostered before the lock, so the FAA is the only market in it. A trade
    inside the window would also count; the pass warns if one exists.
  * Rate = (share of the league's gain) / (share of the league's spend). One is
    the league average. It cannot see bench depth, and an owner with no holes
    has little lineup to improve -- both are stated in the pack's caveats.

DERIVED, NOT FETCHED. Every input is already a fact or a table row in the
packs, so this adds no new data and cannot drift from them. It refuses to run
if the packs were valued on different ADP boards.

Stdlib only, invoked by path.
"""

import argparse
import glob
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import wire_pack as WP  # noqa: E402

REPO = os.path.abspath(os.path.join(HERE, "..", "..", "..", ".."))
PACKS = os.path.join(REPO, "site", "wire", "packs")

OFFENSE = ("QB", "RB", "WR", "TE")
SOURCE = "team_review_league (derived from the twelve team packs)"
WARN_MARK = "League value comparison:"
WINDOW = ("2026-07-23", "2026-08-05")
BANDS = ("Elite", "Very good", "Good", "Starter depth", "Bench depth")   # tiering.BOUGHT_BANDS


def fail(msg):
    raise SystemExit("team_review_league: " + msg)


def _fact(fid, label, value, unit, asof, fmt=None):
    if fmt is None:
        fmt = (WP.fmt_usd(value) if unit == "usd" else
               WP.fmt_percent(value) if unit == "percent" else
               WP.fmt_count(value) if unit in ("count", "rank") else str(value))
    return {"id": fid, "label": label, "value": value, "unit": unit, "fmt": fmt,
            "source": SOURCE, "asof": asof}


def _team_inputs(pack):
    fid = pack["packId"].split("-")[-1]
    facts = dict((f["id"], f["value"]) for f in pack["facts"])
    tables = dict((t["id"].split(".")[-1], t) for t in pack["tables"])
    need = ["f.team.%s.%s" % (fid, k) for k in ("lineup_value_preauction", "lineup_value_postauction", "faa_spend")]
    missing = [k for k in need if k not in facts]
    if missing:
        fail("%s lacks %s" % (pack["packId"], ", ".join(missing)))
    auc = tables.get("auction")
    if not auc:
        fail("%s has no auction table" % pack["packId"])
    keys = [c["key"] for c in auc["columns"]]
    ia, ip, ipr = keys.index("auction"), keys.index("pos"), keys.index("price")
    faa = [r for r in auc["rows"] if r[ia] == "FAA"]
    # The table must account for every FAA dollar, or the offensive split is a guess.
    if abs(sum(r[ipr] for r in faa) - facts[need[2]]) > 0.5:
        fail("%s: FAA rows sum to %s but faa_spend is %s" % (pack["packId"], sum(r[ipr] for r in faa), facts[need[2]]))
    trades = tables.get("trades") or {"rows": [], "columns": []}
    tkeys = [c["key"] for c in trades["columns"]]
    in_window = [r for r in trades["rows"] if "date" in tkeys and WINDOW[0] <= str(r[tkeys.index("date")]) <= WINDOW[1]]
    # WHAT IT BOUGHT. Keith, on this table: "We see $$ Spent, but we don't know
    # what it bought" -- so each owner's offensive buys are counted by grade,
    # from the band the pack's own FAA table already assigns.
    faa_t = tables.get("faa")
    if not faa_t:
        fail("%s has no faa table -- rebuild the pack" % pack["packId"])
    ib = [c["key"] for c in faa_t["columns"]].index("band")
    bands = {}
    for r in faa_t["rows"]:
        if r[ib] != "--":
            bands[r[ib]] = bands.get(r[ib], 0) + 1
    return {
        "fid": fid,
        "name": pack["entities"]["franchises"][0]["name"],
        "pre": facts[need[0]], "post": facts[need[1]],
        "off_spend": sum(r[ipr] for r in faa if r[ip] in OFFENSE),
        "trades_in_window": len(in_window),
        "bought": ", ".join("%d %s" % (bands[b], b) for b in BANDS if bands.get(b)) or "no offense",
    }


def _adp_asof(pack):
    return sorted(set(s.get("asof") for s in pack["sources"] if "adp" in (s.get("name") or "").lower()))


def run(season):
    paths = sorted(glob.glob(os.path.join(PACKS, str(season), "%s-team-*.pack.json" % season)))
    if len(paths) != 12:
        fail("expected 12 team packs for %s, found %d" % (season, len(paths)))
    raws = [io.open(p, encoding="utf-8").read() for p in paths]
    packs = [json.loads(r) for r in raws]
    boards = set(tuple(_adp_asof(p)) for p in packs)
    if len(boards) != 1:
        fail("packs were valued on different ADP boards %s -- rebuild them together first" % sorted(boards))

    teams = [_team_inputs(p) for p in packs]
    total_gain = sum(t["post"] - t["pre"] for t in teams)
    total_spend = sum(t["off_spend"] for t in teams)
    if total_gain <= 0 or total_spend <= 0:
        fail("league gain %s / spend %s -- nothing to compare" % (total_gain, total_spend))
    for t in teams:
        t["gain"] = t["post"] - t["pre"]
        t["gain_share"] = 100.0 * t["gain"] / total_gain
        t["spend_share"] = 100.0 * t["off_spend"] / total_spend
        t["rate"] = (t["gain_share"] / t["spend_share"]) if t["spend_share"] else None
        t["gain_pct"] = (100.0 * t["gain"] / t["pre"]) if t["pre"] else None
    by_rate = sorted(teams, key=lambda t: (t["rate"] is None, -(t["rate"] or 0), -t["gain"]))
    for i, t in enumerate(by_rate, 1):
        t["rate_rank"] = i
    # THE RANK IS THE IMPROVEMENT, NOT THE IMPROVEMENT PER DOLLAR. Per dollar
    # rewarded spending almost nothing: The Long Haulers put $7,000 into three
    # depth players, moved their lineup 2.7%, and ranked 3rd. Keith: "How is LH
    # #3 when all he bought was depth? ... at best this is a net neutral play.
    # It shouldn't be much different then PG or Cleon." The per-dollar rate
    # stays in the pack as faa_off_rate_rank, unprinted.
    by_gain = sorted(teams, key=lambda t: (-t["gain"], t["off_spend"]))
    for i, t in enumerate(by_gain, 1):
        t["gain_rank"] = i

    asof = max(p["generatedAtUtc"] for p in packs)
    rows = [[t["name"], t["off_spend"], round(t["spend_share"], 1), round(t["gain_share"], 1),
             ("%.2fx" % t["rate"]) if t["rate"] is not None else "--", t["gain_rank"], t["bought"]]
            for t in by_gain]
    warn = ("%s offense only. 'Value' is the redraft value of the QB/RB/WR/TE starters on the "
            "live board; 'money' is what each owner spent on QB/RB/WR/TE at the Free Agent Auction. "
            "Both are measured from the auction roster lock (%s) to the close (%s). The RANK is how much "
            "the starting offense improved -- a buy that never makes the lineup adds nothing, however "
            "cheap. 'What it bought' counts each owner's offensive buys by grade (tiering.bought_band: "
            "Elite = top 3 at the position, Very good = 4-12, Good = 13-24 at QB/RB/WR where every team "
            "starts two, Starter depth = he starts somewhere in the league or is inside its own starter "
            "demand, Bench depth = nobody starts him). "
            "An owner whose lineup had no holes "
            "had little room to improve it." % (WARN_MARK, WINDOW[0], WINDOW[1]))

    changed = 0
    for path, raw, pack, t in zip(paths, raws, packs, teams):
        fid = t["fid"]
        pre = "f.team.%s.faa_off_" % fid
        tid = "t.%s.faa_value" % fid
        pack["facts"] = [f for f in pack["facts"] if not f["id"].startswith(pre)]
        pack["tables"] = [x for x in pack["tables"] if x["id"] != tid]
        pack["warnings"] = [w for w in pack["warnings"] if not w.startswith(WARN_MARK)]
        pack["sources"] = [s for s in pack["sources"] if s.get("name") != SOURCE]

        new = [
            _fact(pre + "spend", "Spent on QB/RB/WR/TE at the Free Agent Auction", t["off_spend"], "usd", asof),
            _fact(pre + "spend_share", "Share of the league's offensive Free Agent Auction spend", round(t["spend_share"], 1), "percent", asof),
            _fact(pre + "gain_share", "Share of the league's offensive lineup-value gain, auction lock to close", round(t["gain_share"], 1), "percent", asof),
            _fact(pre + "rank", "League rank for how much the auction improved his starting offense (1 = most)", t["gain_rank"], "rank", asof),
            _fact(pre + "rate_rank", "League rank for offensive lineup value added per offensive auction dollar (1 = most; not printed)", t["rate_rank"], "rank", asof),
            _fact(pre + "gain_rank", "League rank for total offensive lineup value added, auction lock to close (1 = most)", t["gain_rank"], "rank", asof),
        ]
        if t["rate"] is not None:
            new.append(_fact(pre + "rate", "Offensive value added per auction dollar, as a multiple of the league rate (1.00x = average)",
                             round(t["rate"], 2), "ratio", asof, fmt="%.2fx" % t["rate"]))
        if t["gain_pct"] is not None:
            new.append(_fact(pre + "gain_pct", "Offensive lineup value added at the auction, as a share of what he had at the lock",
                             round(t["gain_pct"], 1), "percent", asof))
        pack["facts"].extend(new)
        pack["tables"].append({
            "id": tid,
            "title": "What the Free Agent Auction money bought, league-wide (offense)",
            "columns": [
                {"key": "team", "label": "Team", "type": "text"},
                {"key": "spend", "label": "Offense spend", "type": "usd"},
                {"key": "spend_share", "label": "Share of league spend", "type": "percent"},
                {"key": "gain_share", "label": "Share of league gain", "type": "percent"},
                {"key": "rate", "label": "Value per dollar", "type": "text"},
                {"key": "rank", "label": "Rank", "type": "count"},
                {"key": "bought", "label": "What it bought", "type": "text"},
            ],
            "rows": rows,
            "note": warn,
        })
        pack["warnings"].append(warn + (" This owner made %d trade(s) inside that window, which "
                                        "the gain also includes." % t["trades_in_window"]
                                        if t["trades_in_window"] else ""))
        pack["sources"].append({"name": SOURCE, "asof": asof, "rows": 12,
                                "note": "Derived from facts and tables already in the twelve packs; no new data."})
        # Offer the new facts and table to the section that discusses the auction.
        for s in pack["sections"]:
            if s["id"] == "s3":
                s["factIds"] = [x for x in s["factIds"] if not x.startswith(pre)] + [f["id"] for f in new]
                s["tableIds"] = [x for x in s["tableIds"] if x != tid] + [tid]

        problems = [p for p in WP.validate(pack) if not p.startswith("NOTE")]
        if problems:
            fail("%s no longer validates: %s" % (pack["packId"], "; ".join(problems[:3])))
        out = json.dumps(pack, indent=2, ensure_ascii=False, sort_keys=False) + "\n"
        if out != raw:
            io.open(path, "w", encoding="utf-8", newline="\n").write(out)
            changed += 1

    print("league: %d/12 pack(s) updated" % changed)
    for t in by_gain:
        print("  %2d %s %-18s spend %5.1f%%  gain %5.1f%%  %s" % (
            t["gain_rank"], t["fid"], t["name"], t["spend_share"], t["gain_share"],
            ("%.2fx" % t["rate"]) if t["rate"] is not None else "--"))
    return 0


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--season", required=True)
    return run(ap.parse_args().season)


if __name__ == "__main__":
    sys.exit(main())
