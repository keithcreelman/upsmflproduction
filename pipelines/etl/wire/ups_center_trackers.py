#!/usr/bin/env python3
"""Continuing trackers and trade context for the UPS Center (Keith 2026-11-18).

What this module gathers, from MFL's public exports only (never an offer's comment, never private chat):
  * qb      the Cross-vs-Josh Martel quarterback bet: each of the four quarterbacks' MFL player scores for every week so far, which weeks
            each NFL team played (a week with no score is a BYE when his team had no game, MISSED when it did), the fantasy trades that moved
            each quarterback, and a verified headshot (wire_data.player_photo: ESPN after two live checks, MFL's archive as the fallback)
  * trade   the earlier trade between the same two franchises that the printed trade partly reverses, the posted cap-space ledger entries of
            both trades (salaryAdjustments), and the roster status/salary of the players the cap argument needs
  * hos     the regular-season length (league export) for the Hall of Shame math (standings are already in the build's snapshot)

and the few hand-sourced notes (site/wire/data/tracker_notes_2026.json: injury captions, each with its team-page URL and date) that no feed
carries. Everything the page prints from here is a registered claim re-derived by ups_center_validate from THIS snapshot.

The pure functions below (qb_table, hall_rows, cap_effect) hold the arithmetic so the page and the validator share one definition.
"""
import json
import math
import os
import re
import time
import urllib.error

QB_THROUGH = 17          # the bet's finish line: total UPS fantasy points through Week 17, inclusive
HALL_LINE = 0.200        # Keith 2026-11-18: a final regular-season All-Play percentage BELOW .200 is a Hall of Shame year
IR_SHARE = 0.5           # league settings includeIRWithSalary = 50; canon B3


# ----------------------------------------------------------------------------------------------- pure arithmetic
def qb_table(rows, sides, through, status_of, last=QB_THROUGH):
    """rows {pid: {week: score}}; sides {"cross": [pid, pid], "josh": [pid, pid]}; status_of(pid, week) in played|bye|missed.
    Returns [{week, state, pids: {pid: (kind, score|None)}, pair: {side: total|None}, cum: {side}, lead}] for weeks 1..last, where a
    week after `through` is pending. A week counts when it is complete (<= through); a QB's missing score adds nothing."""
    out, cum = [], {s: 0.0 for s in sides}
    for w in range(1, last + 1):
        if w > through:
            out.append({"week": w, "state": "pending", "pids": {p: ("pending", None) for ps in sides.values() for p in ps},
                        "pair": {s: None for s in sides}, "cum": {s: None for s in sides}, "lead": None})
            continue
        cells, pair = {}, {}
        for s, ps in sides.items():
            tot = 0.0
            for p in ps:
                sc = (rows.get(p) or {}).get(w)
                if sc is not None:
                    cells[p] = ("played", round(float(sc), 1))
                    tot += float(sc)
                else:
                    cells[p] = (status_of(p, w), None)
            pair[s] = round(tot, 1)
            cum[s] = round(cum[s] + tot, 1)
        out.append({"week": w, "state": "done", "pids": cells, "pair": pair, "cum": dict(cum),
                    "lead": round(cum["cross"] - cum["josh"], 1)})
    return out


def hall_allplay(reg_allplay, teams, reg_weeks, through, playoff_scores=None):
    """{fid: "W-L-T"} All-Play through `through` weeks. MFL's standings cover the regular season; if they stop accumulating in the playoffs, the
    later weeks are counted here from the official weekly team scores (every team scores every week, UPS plays all twelve in weeks 15-17).
    Raises ValueError when the standings are neither complete through `through` nor exactly the regular season."""
    games_full = (teams - 1) * through
    games_reg = (teams - 1) * min(through, reg_weeks)
    totals = {f: sum(int(x) for x in rec.split("-")) for f, rec in reg_allplay.items()}
    if all(t == games_full for t in totals.values()):
        return dict(reg_allplay)
    if through <= reg_weeks or not all(t == games_reg for t in totals.values()):
        raise ValueError("MFL All-Play comparisons are %s, expected %d (through Week %d) or %d (the regular season)" % (sorted(set(totals.values())), games_full, through, games_reg))
    out = {}
    for f, rec in reg_allplay.items():
        w, l, t = (int(x) for x in rec.split("-"))
        for wk in range(reg_weeks + 1, through + 1):
            sc = (playoff_scores or {}).get(str(wk)) or (playoff_scores or {}).get(wk)
            if not sc or len(sc) != teams or f not in sc:
                raise ValueError("no team scores for Week %d" % wk)
            for o, v in sc.items():
                if o == f:
                    continue
                if sc[f] > v:
                    w += 1
                elif sc[f] < v:
                    l += 1
                else:
                    t += 1
        out[f] = "%d-%d-%d" % (w, l, t)
    return out


def hall_rows(allplay, teams, weeks, through):
    """The Hall of Shame arithmetic (Keith 2026-11-19: All-Play through ALL 17 weeks, playoffs included; below .200 qualifies).
    games = (teams - 1) * weeks                                    (187 for twelve teams and 17 weeks)
    safe  = the fewest wins that stay at or above .200 with no ties (38; a tie counts half)
    left  = comparisons still to play = (teams - 1) * (weeks - through)    (77 after Week 10)
    need  = more wins to reach .200, whole wins; status safe | candidate | locked (cannot reach it) | inducted (the season is over)."""
    games = (teams - 1) * weeks
    line = HALL_LINE * games
    left = (teams - 1) * (weeks - through)
    out = {}
    for f, rec in allplay.items():
        w, l, t = (int(x) for x in rec.split("-"))
        have = w + t / 2.0
        need = max(0, math.ceil(line - have - 1e-9))
        if need == 0:
            status = "safe"
        elif through >= weeks:
            status = "inducted"
        elif need > left:
            status = "locked"
        else:
            status = "candidate"
        out[f] = {"w": w, "l": l, "t": t, "games": games, "safe": math.ceil(line - 1e-9), "left": left, "need": need, "status": status,
                  "pct": have / (w + l + t) if (w + l + t) else 0.0}
    return out


def cap_effect(sent_salary, sent_cap_space, got_salary, ir_got=False):
    """Change in the sender's cap charge (negative = room freed): the salary that left, plus the cap space it sent, plus the salary that came
    back (at half while on injured reserve, league setting includeIRWithSalary = 50)."""
    return -sent_salary + sent_cap_space + (got_salary * IR_SHARE if ir_got else got_salary)


# ----------------------------------------------------------------------------------------------- gathering
def _list(x):
    return x if isinstance(x, list) else ([x] if x else [])


def retrying(fn, tries=4, pause=4.0):
    """MFL answers 429 (too many requests) when a build is busy: wait and try again before calling a feed unreadable."""
    def g(*a, **k):
        for i in range(tries):
            try:
                return fn(*a, **k)
            except urllib.error.HTTPError as exc:
                if exc.code not in (429, 500, 502, 503, 504) or i == tries - 1:
                    raise
                time.sleep(pause * (i + 1))
    return g


def plain(msg):
    """An error message for the page's EDITOR REVIEW box, without digits (an HTTP code is not a number the page claims)."""
    return re.sub(r"\d+", "#", str(msg))[:160]


def load_notes(data_dir, season):
    p = os.path.join(data_dir or "", "tracker_notes_%d.json" % season)
    if data_dir and os.path.exists(p):
        return json.load(open(p, encoding="utf-8"))
    return None


def gather(season, week, get, mfl, parse_trades, current, trades_all, photo=None, notes=None):
    """`get(url)` -> parsed JSON, `mfl % (season, TYPE, extra)` the export URL, `nfl_kickoffs(season, week)` -> {team: kickoff},
    `parse_trades(season, [raw trades])` -> parsed trades, `current` the parsed trades of this build (the printed one), `trades_all` the
    season's raw TRADE transactions. Every failure is recorded in
    out["errors"] and leaves that piece out: a tracker that cannot be proven is not printed."""
    get = retrying(get)
    out = {"through": int(week), "errors": [], "notes": notes or {}, "gatheredAtUtc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    notes = notes or {}
    bet = notes.get("bet") or {}
    sides = {"cross": bet.get("cross", {}).get("qbs") or [], "josh": bet.get("josh", {}).get("qbs") or []}
    # ---- league: regular-season length
    try:
        lg = get(mfl % (season, "league", ""))["league"]
        out["regWeeks"] = int(lg["lastRegularSeasonWeek"])
        out["allWeeks"] = int(lg["endWeek"])
        out["irShare"] = float(lg.get("includeIRWithSalary") or 50) / 100.0
    except Exception as exc:                                            # noqa: BLE001
        out["errors"].append("league settings unreadable: %s" % plain(exc))
    if out.get("regWeeks") and int(week) > out["regWeeks"]:
        try:
            ps = {}
            for w in range(out["regWeeks"] + 1, int(week) + 1):
                wr = get(mfl % (season, "weeklyResults", "&W=%d" % w))["weeklyResults"]
                sc = {}
                for m in _list(wr.get("matchup")):
                    for f in _list(m.get("franchise")):
                        sc[f["id"]] = float(f["score"])
                ps[str(w)] = sc
            out["playoffScores"] = ps
        except Exception as exc:                                        # noqa: BLE001
            out["errors"].append("playoff team scores unreadable: %s" % plain(exc))
    # ---- the quarterback bet
    if sides["cross"] and sides["josh"]:
        try:
            pids = sides["cross"] + sides["josh"]
            pl = {str(p["id"]): p for p in _list(get(mfl % (season, "players", "&DETAILS=1&PLAYERS=" + ",".join(pids)))["players"]["player"])}
            allw = get(mfl % (season, "playerScores", "&W=ALL"))["playerScoresAllWeeks"]["playerScores"]
            scores = {p: {} for p in pids}
            for wk in _list(allw):
                for s in _list(wk.get("playerScore")):
                    if str(s["id"]) in scores and s.get("score") not in (None, ""):
                        scores[str(s["id"])][int(wk["week"])] = float(s["score"])
            teams = {p: pl[p].get("team") for p in pids}
            games = {}
            for w in range(1, int(week) + 1):
                sch = get("https://api.myfantasyleague.com/%d/export?TYPE=nflSchedule&W=%d&JSON=1" % (int(season), w))["nflSchedule"]
                playing = {t["id"] for m in _list(sch.get("matchup")) for t in _list(m.get("team"))}
                if len(playing) < 20:
                    raise ValueError("MFL nflSchedule lists only %d teams in Week %d" % (len(playing), w))
                games[w] = sorted(t for t in set(teams.values()) if t in playing)
            moved = {p: [] for p in pids}
            for t in trades_all:
                for key, side_key in (("franchise1_gave_up", "franchise"), ("franchise2_gave_up", "franchise2")):
                    for tok in str(t.get(key) or "").split(","):
                        if tok in moved:
                            to = t["franchise2"] if side_key == "franchise" else t["franchise"]
                            moved[tok].append({"timestamp": int(t["timestamp"]), "from": t[side_key], "to": to})
            ph = {}
            for p in pids:
                try:
                    nm_ = str(pl[p].get("name") or "")
                    ph[p] = photo(p, (nm_.split(", ")[-1] + " " + nm_.split(", ")[0]) if ", " in nm_ else nm_) if photo else None
                except Exception as exc:                               # noqa: BLE001
                    ph[p] = {"url": None, "note": "photo lookup failed: %s" % str(exc)[:80]}
            out["qb"] = {"sides": sides, "players": {p: {"name": pl[p].get("name"), "team": pl[p].get("team"), "pos": pl[p].get("position")} for p in pids},
                         "scores": {p: {str(w): v for w, v in sorted(r.items())} for p, r in scores.items()},
                         "gameTeams": {str(w): t for w, t in games.items()}, "moves": moved, "photos": ph}
        except Exception as exc:                                        # noqa: BLE001
            out["errors"].append("quarterback bet data unreadable: %s" % plain(exc))
    # ---- the earlier trade between the same two franchises, the cap ledger, the cap argument's roster facts
    try:
        cur = [t for t in trades_all if str(t.get("timestamp")) in {str(x["timestamp"]) for x in (current or [])}]
        out["trade"] = {}
        tr = cur[0] if cur else None
        if tr:
            pair = {tr["franchise"], tr["franchise2"]}
            picks_now = {x for k in ("franchise1_gave_up", "franchise2_gave_up") for x in str(tr.get(k) or "").split(",") if x.startswith("FP_")}
            prior = [t for t in trades_all if int(t["timestamp"]) < int(tr["timestamp"]) and {t["franchise"], t["franchise2"]} == pair
                     and picks_now & {x for k in ("franchise1_gave_up", "franchise2_gave_up") for x in str(t.get(k) or "").split(",")}]
            if prior:
                pr = max(prior, key=lambda t: int(t["timestamp"]))
                out["trade"]["priorRaw"] = {k: pr.get(k) for k in ("timestamp", "franchise", "franchise2", "franchise1_gave_up", "franchise2_gave_up")}
                out["trade"]["prior"] = (parse_trades(season, [pr]) or [None])[0]
            adj = _list(get(mfl % (season, "salaryAdjustments", ""))["salaryAdjustments"]["salaryAdjustment"])
            stamps = {int(tr["timestamp"])} | ({int(out["trade"]["priorRaw"]["timestamp"])} if out["trade"].get("priorRaw") else set())
            out["trade"]["cap"] = [{"id": a["id"], "franchise": a["franchise_id"], "amount": float(a["amount"]), "timestamp": int(a["timestamp"]),
                                    "description": a["description"]}
                                   for a in adj if any(0 <= int(a["timestamp"]) - s <= 900 for s in stamps) and "traded salary settlement" in a["description"]]
            ro = _list(get(mfl % (season, "rosters", ""))["rosters"]["franchise"])
            want = {x for k in ("franchise1_gave_up", "franchise2_gave_up") for x in str(tr.get(k) or "").split(",") if x.isdigit()}
            if out["trade"].get("priorRaw"):
                want |= {x for k in ("franchise1_gave_up", "franchise2_gave_up") for x in str(out["trade"]["priorRaw"].get(k) or "").split(",") if x.isdigit()}
            out["trade"]["roster"] = {str(p["id"]): {"fid": f["id"], "status": p.get("status"), "salary": float(p.get("salary") or 0),
                                                       "years": p.get("contractYear"), "contractStatus": p.get("contractStatus")}
                                      for f in ro for p in _list(f.get("player")) if str(p["id"]) in want}
    except Exception as exc:                                            # noqa: BLE001
        out["errors"].append("trade context unreadable: %s" % plain(exc))
    return out

