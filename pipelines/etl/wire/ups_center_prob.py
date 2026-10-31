#!/usr/bin/env python3
"""How the UPS Center prints a probability (Keith 2026-10-27: "You can't allow 100%").

THE RULE. A probability prints as 100% only when the outcome is clinched, and as 0% only when it is eliminated, and both are
decided by the league's deterministic clinching engine (site/shared/standings_clinch.js, the one behind the standings page's
X / Y / Z / E letters), never by a simulation that rounds to 100.0 or 0.0. A forecast of 0.9996 is "99.96%", a forecast of
0.00004 is "<0.01%". The simulation's own precision is kept: the ledger stores the exact percent beside the printed text.

The engine runs in node. If node or the standings cannot be read, there are no clinch flags at all. If only MFL's schedule is
missing, the engine still runs but makes no division, bye or elimination claims: only the playoff-spot letter (X) can show.
Whatever it cannot prove prints below 100% and above 0%: the rule fails closed.

    python3 ups_center_prob.py            # self-check
"""
import json
import os
import shutil
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
CLINCH_JS = os.path.normpath(os.path.join(HERE, "..", "..", "..", "site", "shared", "standings_clinch.js"))

FLOOR_PCT = 0.01      # a probability under this prints as "<0.01%"
NONE = {"x": False, "y": False, "z": False, "e": False}
# which engine letter makes which probability certain (high) or impossible (low)
#   playoffs: X clinched a spot / E eliminated;  bye: Z clinched a bye / E (no field, no bye);
#   division: Y clinched the title / E (no division title is possible without a playoff path);  title: never certain / E
CERTAIN_HIGH = {"po": "x", "bye": "z", "div": "y", "title": None}
CERTAIN_LOW = {"po": "e", "bye": "e", "div": "e", "title": "e"}


def clinch_flags(teams, h2h_games, ap_games_left, byes=2, wild_cards=2, node=None):
    """{fid: {x, y, z, e}} from the standings page's own engine, or {} when it cannot say (fail closed).
    teams: [{fid, division, h2h: {w, l, t}, ap: {w, l, t}}]; h2h_games: {fid: regular-season H2H games} or None."""
    node = node or shutil.which("node")
    if not node or not os.path.exists(CLINCH_JS):
        return {}
    payload = {"teams": teams, "h2hGames": h2h_games, "apGamesLeft": ap_games_left, "byes": byes, "wildCards": wild_cards}
    prog = ("const C=require(%s);let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const r=C.analyze(JSON.parse(s));"
            "process.stdout.write(JSON.stringify({status:r.status,byFid:r.byFid,disagreements:r.disagreements}))})"
            % json.dumps(CLINCH_JS))
    try:
        p = subprocess.run([node, "-e", prog], input=json.dumps(payload), capture_output=True, text=True, timeout=60)
        out = json.loads(p.stdout)
    except Exception:                                           # noqa: BLE001  (any failure means no flags)
        return {}
    if p.returncode != 0 or out.get("status") != "ok" or out.get("disagreements"):
        return {}
    return {fid: {k: bool(v.get(k)) for k in "xyze" if k in v} | {k: False for k in "xyze" if k not in v}
            for fid, v in out["byFid"].items()}


def certain(kind, flags):
    """(high, low): is this outcome clinched / eliminated, per the engine's flags for one team (None = unknown = neither)."""
    flags = flags or NONE
    hi = CERTAIN_HIGH.get(kind)
    return (bool(hi and flags.get(hi)), bool(flags.get(CERTAIN_LOW.get(kind))))


def text(p, high=False, low=False):
    """The printed text for a probability p (0..1). 100%/0% only when high/low (clinched/eliminated); otherwise the most
    precise honest figure: one decimal in the middle, two near the ends, never 100% or 0%."""
    if high and low:
        raise ValueError("an outcome cannot be both clinched and eliminated")
    if high:
        return "100%"
    if low:
        return "0%"
    pct = 100.0 * float(p)
    if pct >= 99.995:
        return "99.99%"
    if pct < 0.005:
        return "<%s%%" % FLOOR_PCT
    if 0.1 <= pct <= 99.9:
        return "%.1f%%" % pct
    return "%.2f%%" % pct


def value(p, high=False, low=False):
    """The number the ledger keeps: the exact percent (4 decimals), or 100.0 / 0.0 only for a clinched / eliminated outcome."""
    if high:
        return 100.0
    if low:
        return 0.0
    return round(100.0 * float(p), 4)


def group_cells(probs, rounded, certain_hi=(), certain_lo=()):
    """{key: (text, value)} for a group that must total 100 (one division's title odds, the league's title odds).
    `rounded` is season_sim.display_percentages(probs): the largest-remainder text that makes the group add up. It is used as is
    EXCEPT where it would print 100.0 or 0.0 for a team that is not clinched / eliminated: that cell is printed by text()."""
    out = {}
    for k, p in probs.items():
        hi, lo = k in certain_hi, k in certain_lo
        shown = rounded[k]
        if hi or lo or float(shown) in (0.0, 100.0):
            out[k] = (text(p, hi, lo), value(p, hi, lo))
        else:
            out[k] = (shown + "%", float(shown))
    return out


def single(p, kind, flags):
    hi, lo = certain(kind, flags)
    return text(p, hi, lo), value(p, hi, lo)


def guard(printed, p):
    """For code that still prints a probability its own way (the weekly recap pack): the text it would print, unless that
    text is 100% or 0% (also 100.0%, 0.0%), in which case the honest figure. A probability p (0..1) is never certain here:
    these callers have no clinch flags."""
    import re
    return text(p) if re.fullmatch(r"(100(\.0+)?|0(\.0+)?)%", printed.strip()) else printed


def audit(shown_texts, flags_by_label=None):
    """[problem] for any printed probability that is 100% or 0% (also 100.0%, 0.0%, 0.00%) unless its label is certain.
    `shown_texts`: {label: text}; `flags_by_label`: {label: True} where the outcome is clinched/eliminated."""
    import re
    out = []
    for label, t in shown_texts.items():
        if re.fullmatch(r"(100(\.0+)?|0(\.0+)?)%", t.strip()) and not (flags_by_label or {}).get(label):
            out.append("%s prints %s but is neither clinched nor eliminated" % (label, t))
    return out


def league_input(standings, divisions, through_week, last_week, schedule=None):
    """The engine's input from what the generator already holds, or (None, reason) when it cannot be built honestly.
    standings: {fid: {h2hw, h2hl, h2ht, allplay: 'w-l-t'}}; divisions: {fid: division id};
    schedule: MFL's full-season schedule export (`schedule.weeklySchedule[].matchup[].franchise[].id`) or None.
    Without a schedule the engine makes no division, bye or elimination claims (only the playoff-spot letter can show)."""
    n = len(standings)
    if n < 8 or not (1 <= through_week < last_week) or set(standings) != set(divisions):
        return None, "standings, divisions or weeks unreadable"
    teams = []
    for fid in sorted(standings):
        r = standings[fid]
        try:
            parts = str(r["allplay"]).split("-")
            w, l, t = int(parts[0]), int(parts[1]), int(parts[2]) if len(parts) > 2 else 0
        except (ValueError, IndexError):
            return None, "all-play unreadable for %s" % fid
        if w + l + t != (n - 1) * through_week:
            return None, "all-play games for %s do not match the weeks played" % fid
        teams.append({"fid": fid, "division": str(divisions[fid]), "h2h": {"w": int(r["h2hw"]), "l": int(r["h2hl"]), "t": int(r.get("h2ht") or 0)},
                      "ap": {"w": w, "l": l, "t": t}})
    games = None
    if schedule:
        try:
            weeks = {int(x["week"]): x for x in schedule["schedule"]["weeklySchedule"]}
            total = {t["fid"]: 0 for t in teams}
            played = {t["fid"]: 0 for t in teams}
            for wk in range(1, last_week + 1):
                ms = weeks[wk].get("matchup") or []
                ms = ms if isinstance(ms, list) else [ms]
                for m in ms:
                    for fr in m["franchise"]:
                        total[fr["id"]] += 1
                        if wk <= through_week:
                            played[fr["id"]] += 1
            if all(played[t["fid"]] == t["h2h"]["w"] + t["h2h"]["l"] + t["h2h"]["t"] for t in teams):
                games = total
        except (KeyError, TypeError, ValueError):
            games = None
    return {"teams": teams, "h2h_games": games, "ap_games_left": (n - 1) * (last_week - through_week)}, None


def compute_clinch(standings, divisions, through_week, last_week, schedule=None, node=None):
    """{status, reason, byFid} for ctx["clinch"]. status 'ok' = the engine ran (with no schedule, only the X letter can be set); anything else = no flags (fail closed)."""
    inp, why = league_input(standings, divisions, through_week, last_week, schedule)
    if inp is None:
        return {"status": "unavailable", "reason": why, "byFid": {}}
    flags = clinch_flags(inp["teams"], inp["h2h_games"], inp["ap_games_left"], node=node)
    return {"status": "ok" if flags else "unavailable", "reason": None if flags else "the clinching engine could not run",
            "schedule": inp["h2h_games"] is not None, "byFid": flags}


if __name__ == "__main__":
    assert text(0.99996) == "99.99%" and text(0.9996) == "99.96%" and text(0.00004) == "<0.01%" and text(0.0004) == "0.04%"
    assert text(0.5) == "50.0%" and text(1.0) == "99.99%" and text(0.0) == "<0.01%" and text(1.0, high=True) == "100%"
    print("ok")
