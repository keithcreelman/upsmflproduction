#!/usr/bin/env python3
"""Next-week preview data for the Wire: matchup stakes, win chances, weekly
scoring ranges, lineup/injury watch and forecast movement. No waiver watch
(Keith 2026-09-16: "NO WW watch").

    python pipelines/etl/wire/week_preview.py --season 2026 --week 2 \\
        --preseason-cache <dir the preseason forecast ran on> \\
        --out site/wire/data/week_preview_2026_wk02.json

WHY (Keith 2026-09-16, Round 3 brief): the recap needs a "Week 2 Preview --
What We're Watching" segment built from the live league, with win probability
and a scoring range "only if the model supports it", assumptions and cutoff
shown, and forecast movement that separates the banked result from projected
strength.

EVERYTHING HERE IS season_sim.py's OWN MODEL, not a second one:
  * same inputs (prepare(), injuries on, expected-value offense), same regression (k=0.7), same
    calibrated sigma_w / sigma_s (fit());
  * the published official form -- refresh-only, played weeks fixed to actual,
    shared un-updated season shock -- via simulate();
  * a matchup's win chance is the share of those same simulated seasons in
    which that team outscored its opponent that week, and "playoff odds with a
    win / with a loss" conditions on that game inside the same seasons, so a
    team's two or three games that week stay tied to its one score.

WHAT IS NOT VALIDATED, and must be printed wherever this is: the single-game
win chance and weekly range have not been backtested game by game (the
season_sim backtest scores season all-play, not individual weeks). Treat them
as provisional.

FORECAST MOVEMENT. Three states per team:
  preseason      -- site/wire/data/season_sim_<season>.json, never rewritten;
  banked only    -- the preseason run's own MFL inputs (--preseason-cache, the
                    exact cache it read) with played weeks fixed to what
                    happened: what the RESULT alone did;
  entering week  -- today's rosters, projections and injury feed with played
                    weeks fixed: adds what changed in projected STRENGTH.
Same seed for both simulated states, so the difference is the inputs, not the
dice.

Stdlib + D1 read-only (wire_data) only. Writes one JSON and never overwrites.
"""

import argparse
import json
import math
import os
import random
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lineup_engine as LE  # noqa: E402
import season_sim as S       # noqa: E402
import wire_data as D        # noqa: E402

TAGGED = ("Questionable", "Doubtful")

def _phi(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def _lineup(rows, pw, rep_wk):
    """(raw points, {slot: pid}) of the best legal lineup, replacement bodies included."""
    pw = dict(pw)
    pool = list(rows)
    for g, vals in (rep_wk or {}).items():
        for i, v in enumerate(vals):
            rid = "REP:%s:%d" % (g, i)
            pw[rid] = v
            pool.append({"pid": rid, "pos": g, "is_taxi": False, "is_ir": False})
    slots = LE.fill_slots(pool, lambda r: pw.get(r["pid"], 0.0))
    return sum(pw.get(pid, 0.0) for pid in slots.values() if pid), slots, pw


def _sides(slots, pw):
    return dict((side, sum(pw.get(slots.get(sid), 0.0) for sid in ids if slots.get(sid)))
                for side, ids in S.SLOT_SIDES.items())


def _regressed(raw, k):
    mean = sum(raw.values()) / len(raw)
    return dict((f, mean + k * (raw[f] - mean)) for f in raw)


def _div_winners(teams, st):
    divs = {}
    for f in teams:
        divs.setdefault(teams[f]["division"], []).append(f)
    return set(sorted(m, key=lambda f: S._div_winner_key(st[f]))[0] for m in divs.values())


def run_state(prep, actual, k, runs, seed, week=None):
    """Official refresh-only simulation of one input state. With `week`, also
    conditions every one of that week's games inside the same seasons."""
    teams, sched = prep["teams"], prep["sched"]
    res = S.fit(prep, k, runs, seed, collect=False)
    wp, sigma_w, sigma_s = res["wp"], res["sigma_w"], res["sigma_s"]
    games = list(sched.get(week, [])) if week else []
    cond = dict(((a, b), {"n": 0, "a_win": 0,
                          "a_po_w": 0, "a_po_l": 0, "b_po_w": 0, "b_po_l": 0,
                          "a_div_w": 0, "a_div_l": 0, "b_div_w": 0, "b_div_l": 0}) for a, b in games)
    wk_scores = dict((f, []) for f in teams)
    # One row per simulated season per game: both scores, who won, both teams'
    # all-play wins THAT week, and whether each made the playoffs -- so the
    # win/loss split can be taken apart afterwards (see split_result()).
    samples = dict((g, []) for g in cond)

    def hook(st, champ, runner, seeds, drawn):
        if not week:
            return
        sc = drawn[week]
        for f in teams:
            wk_scores[f].append(sc[f])
        po = set(seeds)
        dw = _div_winners(teams, st)
        wk_ap = dict((f, sum(1 for g in teams if g != f and sc[f] > sc[g])) for f in teams)
        for (a, b), c in cond.items():
            samples[(a, b)].append((sc[a], sc[b], sc[a] > sc[b], a in po, b in po, wk_ap[a], wk_ap[b]))
            c["n"] += 1
            if sc[a] > sc[b]:
                c["a_win"] += 1
                c["a_po_w"] += a in po; c["b_po_l"] += b in po
                c["a_div_w"] += a in dw; c["b_div_l"] += b in dw
            else:
                c["a_po_l"] += a in po; c["b_po_w"] += b in po
                c["a_div_l"] += a in dw; c["b_div_w"] += b in dw

    agg, _ = S.simulate(teams, sched, wp, prep["reg_end"], prep["end"], runs, sigma_w, sigma_s,
                        random.Random(seed), collect=True, hook=hook, actual=actual, posterior=None)
    odds = dict((f, {"playoff": agg[f]["po"] / runs, "division": agg[f]["div"] / runs,
                     "bye": agg[f]["bye"] / runs, "title": agg[f]["title"] / runs,
                     "endingAp": agg[f]["ap_pct"] / runs}) for f in teams)
    return {"wp": wp, "sigma_w": sigma_w, "sigma_s": sigma_s, "odds": odds,
            "cond": cond, "wk_scores": wk_scores, "samples": samples}


def split_result(rows, side, n_teams=12, bins=10, min_cell=40):
    """Take one team's "playoff odds with a win / with a loss" apart.

    Keith 2026-09-16: "You need to consider the Allplay as well. So what if
    Martel loses to Mannila [but] scores the 2nd most points... it's not so cut
    and dry." The simulation already scores all-play every week, but the plain
    split mixes two things: winning THIS game, and the kind of week that usually
    comes with a win -- a big score that also wins all-play and the team's other
    games that week. So, from the same simulated seasons:
      * byWeekAllPlay -- playoff odds by how many of the other eleven teams he
        outscored that week (top three = 9-11, middle = 5-8, bottom = 0-4);
      * sameScoreEffect -- the head-to-head result alone: within each tenth of
        his own score distribution that has both wins and losses, playoff odds
        when he won minus when he lost, averaged over those runs;
      * lossTopThree -- playoff odds when he LOSES this game but still posts a
        top-three score, and how often a loss looks like that.
    `side` is 0 for the first-listed team, 1 for the second.
    """
    own = [(r[0], r[2], r[3], r[5]) if side == 0 else (r[1], not r[2], r[4], r[6]) for r in rows]
    n = len(own)
    out = {"runs": n}

    def rate(xs):
        return (round(sum(1 for x in xs if x[2]) / float(len(xs)), 4), len(xs)) if xs else (None, 0)

    buckets = (("topThree", 9, 11), ("middle", 5, 8), ("bottomFour", 0, 4))
    out["byWeekAllPlay"] = dict((name, dict(zip(("playoffOdds", "runs"), rate([x for x in own if lo <= x[3] <= hi]))))
                                for name, lo, hi in buckets)
    order = sorted(own, key=lambda x: x[0])
    num = den = 0.0
    for b in range(bins):
        cell = order[b * n // bins:(b + 1) * n // bins]
        wins = [x for x in cell if x[1]]
        losses = [x for x in cell if not x[1]]
        if len(wins) >= min_cell and len(losses) >= min_cell:
            diff = rate(wins)[0] - rate(losses)[0]
            num += diff * len(cell)
            den += len(cell)
    out["sameScoreEffect"] = round(num / den, 4) if den else None
    out["sameScoreCoverage"] = round(den / n, 4) if n else 0.0
    losses = [x for x in own if not x[1]]
    top_losses = [x for x in losses if x[3] >= n_teams - 3]
    out["lossTopThree"] = {"playoffOdds": rate(top_losses)[0], "runs": len(top_losses),
                           "shareOfLosses": round(len(top_losses) / float(len(losses)), 4) if losses else None}
    return out


def _pct(xs, p):
    xs = sorted(xs)
    return xs[min(len(xs) - 1, int(p * len(xs)))] if xs else None


def projection_shift(prep_pre, prep, fid, weeks, names):
    """Why a team's projected strength moved between the preseason run and now.

    Keith 2026-09-16: "talk about teams that went up/down and why... despite a
    terrible weekly performance by Bear, his playoff chances increased. Why?"
    A team's odds move on its OWN projection and on everyone else's, so this
    returns both: the team's average projected lineup for the remaining regular
    season, before and after, and the players whose projection changes moved
    that lineup most. A player's lineup impact is measured by putting his
    preseason projections back into TODAY's best-lineup calculation, week by
    week -- a benched player whose projection fell costs nothing, and a
    starter who was ruled out costs the gap to his replacement.
    """
    n = float(len(weeks))
    pre_avg = sum(prep_pre["wp_raw"][fid][w] for w in weeks) / n
    now_avg = sum(prep["wp_raw"][fid][w] for w in weeks) / n

    def side_avg(pr, rows):
        tot = {"O": 0.0, "D": 0.0, "K": 0.0}
        for w in weeks:
            _, slots, pw = _lineup(rows, pr["proj"][w], pr["rep"][w])
            for side, v in _sides(slots, pw).items():
                tot[side] += v
        return dict((k, v / n) for k, v in tot.items())
    sides_before = side_avg(prep_pre, prep_pre["rosters"][fid])
    sides_now = side_avg(prep, prep["rosters"][fid])
    rows_now = prep["rosters"][fid]
    pids = set(r["pid"] for r in rows_now) | set(r["pid"] for r in prep_pre["rosters"].get(fid, []))
    cands = []
    for pid in pids:
        pre_t = sum(prep_pre["proj"][w].get(pid, 0.0) for w in weeks) / n
        now_t = sum(prep["proj"][w].get(pid, 0.0) for w in weeks) / n if any(r["pid"] == pid for r in rows_now) else 0.0
        if abs(now_t - pre_t) >= 1.0:
            cands.append((pid, pre_t, now_t))
    out = []
    for pid, pre_t, now_t in cands:
        on_now = any(r["pid"] == pid for r in rows_now)
        pool = list(rows_now)
        if not on_now:
            prow = [r for r in prep_pre["rosters"][fid] if r["pid"] == pid]
            pool = pool + prow
        impact = 0.0
        for w in weeks:
            base, _, _ = _lineup(rows_now, prep["proj"][w], prep["rep"][w])
            pw = dict(prep["proj"][w])
            pw[pid] = prep_pre["proj"][w].get(pid, 0.0)
            alt, _, _ = _lineup(pool, pw, prep["rep"][w])
            impact += base - alt
        impact /= n
        if abs(impact) < 0.5:
            continue
        # Only absences INSIDE these weeks explain these weeks: Brock Bowers was Out
        # for week 1 alone, so his rise over weeks 2-14 is a projection change.
        a_pre = prep_pre["absent"].get(pid)
        a_now = prep["absent"].get(pid)
        a_pre = a_pre if a_pre and any(w in weeks for w in a_pre["weeks"]) else None
        a_now = a_now if a_now and any(w in weeks for w in a_now["weeks"]) else None
        if not on_now:
            note = "no longer on the roster"
        elif not any(r["pid"] == pid for r in prep_pre["rosters"].get(fid, [])):
            note = "added since the preseason"
        elif a_now and not a_pre:
            note = "now out (%s, %s)" % (a_now["status"], a_now.get("details") or "no detail")
        elif a_pre and not a_now:
            note = "back from the preseason injury list (was %s)" % a_pre["status"]
        elif a_pre and a_now and len([w for w in a_now["weeks"] if w in weeks]) > len([w for w in a_pre["weeks"] if w in weeks]):
            note = "now out longer: %d of these weeks, up from %d (%s)" % (
                len([w for w in a_now["weeks"] if w in weeks]), len([w for w in a_pre["weeks"] if w in weeks]),
                a_now["status"])
        else:
            note = "MFL projection changed"
        out.append({"pid": pid, "player": names(pid), "perWeekBefore": round(pre_t, 1), "perWeekNow": round(now_t, 1),
                    "lineupImpactPerWeek": round(impact, 1), "note": note})
    out.sort(key=lambda x: -abs(x["lineupImpactPerWeek"]))
    return {"lineupPerWeekBefore": round(pre_avg, 1), "lineupPerWeekNow": round(now_avg, 1),
            "exactBefore": pre_avg, "exactNow": now_avg,
            "sidesBefore": dict((k, round(v, 1)) for k, v in sides_before.items()),
            "sidesNow": dict((k, round(v, 1)) for k, v in sides_now.items()),
            "players": out[:6]}


def build(season, week, runs, seed, preseason_cache, live_cache, k=S.REGRESS_DEFAULT, reuse_cache=False):
    through = week - 1
    cutoff = datetime.now(timezone.utc)
    if reuse_cache:
        # Re-run on the SAME live inputs (e.g. to add an analysis without moving
        # any published number). The cutoff is then when those inputs were
        # fetched, never "now".
        files = [os.path.join(live_cache, f) for f in os.listdir(live_cache) if f.endswith(".json")]
        if not files:
            raise SystemExit("week_preview: --reuse-cache but %s is empty" % live_cache)
        cutoff = datetime.fromtimestamp(max(os.path.getmtime(f) for f in files), timezone.utc)
    pre_path = "site/wire/data/season_sim_%d.json" % season
    preseason = json.load(open(pre_path, encoding="utf-8"))
    pre_by = dict((t["franchiseId"], t) for t in preseason["teams"])

    # ---- banked only: the preseason run's own cached inputs, nothing fetched.
    real_fetch = S.fetch

    def cached_only(url, cache_dir=None):
        import hashlib
        key = hashlib.sha1(url.encode()).hexdigest()[:16]
        if not os.path.exists(os.path.join(preseason_cache, key + ".json")):
            raise SystemExit("week_preview: %s is not in the preseason cache -- refusing to mix "
                             "today's data into the banked-only state" % url)
        return real_fetch(url, preseason_cache)

    S.LIVE_SEASON = None
    S.fetch = cached_only
    try:
        prep_pre = S.prepare(season, preseason_cache, injuries=True)
    finally:
        S.fetch = real_fetch
    actual = S.actual_scores_by_week(season, through, live_cache)
    banked = run_state(prep_pre, actual, k, runs, seed)
    # The decomposition is only honest if these cached inputs ARE the preseason
    # forecast's: re-run them with nothing banked and compare to the published file.
    repro = run_state(prep_pre, {}, k, runs, seed)
    repro_gap = max(abs(repro["odds"][f]["playoff"] - pre_by[f]["pPlayoffs"]) for f in pre_by)
    if repro_gap > 0.03:
        raise SystemExit("week_preview: the preseason cache reproduces the published playoff odds only "
                         "to within %.3f -- it is not the preseason run's input" % repro_gap)

    # ---- entering the week: today's inputs, fetched fresh (or the cached run's).
    S.LIVE_SEASON = None if reuse_cache else season
    # Expected-value offense (ev_projections, Keith 2026-09-16) is the official
    # input. The same inputs on MFL's own touchdown-rounded offense are run too,
    # only to measure how much of each team's move that rounding accounted for.
    prep = S.prepare(season, live_cache, injuries=True, ev_offense=True)
    now = run_state(prep, actual, k, runs, seed, week=week)
    S.LIVE_SEASON = None
    prep_mfl = S.prepare(season, live_cache, injuries=True)
    now_mfl = run_state(prep_mfl, actual, k, runs, seed)

    teams, sched = prep["teams"], prep["sched"]
    owners = D.owner_map(season)
    who = lambda f: owners[f]["owner_name"]
    players = dict((p["id"], p) for p in S.fetch(S.MFL_PLAYERS % season, live_cache)["players"]["player"])
    inj_feed = S.fetch(S.MFL_INJURIES % season, live_cache)["injuries"]
    injury = dict((r["id"], r) for r in S._as_list(inj_feed.get("injury")))
    kick = D.nfl_kickoffs(season, week)

    def pname(pid):
        n = (players.get(pid) or {}).get("name") or pid
        if "," in n:
            last, first = [x.strip() for x in n.split(",", 1)]
            n = "%s %s" % (first, last)
        return n

    def pteam(pid):
        return (players.get(pid) or {}).get("team") or ""

    proj = prep["proj"][week]
    rep = prep["rep"][week]
    raw, slots, pws = {}, {}, {}
    for f, rows in prep["rosters"].items():
        raw[f], slots[f], pws[f] = _lineup(rows, proj, rep)
    wp_chk = _regressed(raw, k)
    drift = max(abs(wp_chk[f] - now["wp"][f][week]) for f in teams)
    if drift > 0.05:
        raise SystemExit("week_preview: lineup rebuild disagrees with fit() by %.2f points" % drift)
    sd_team = math.sqrt(now["sigma_w"] ** 2 + now["sigma_s"] ** 2)
    sd_game = math.sqrt(2.0) * sd_team

    def win_closed(a, b, wa=None, wb=None):
        wa = now["wp"][a][week] if wa is None else wa
        wb = now["wp"][b][week] if wb is None else wb
        return _phi((wa - wb) / sd_game)

    # ---- every game this week
    games = []
    for (a, b), c in now["cond"].items():
        n = c["n"]
        pa = c["a_win"] / n
        a_w, a_l = c["a_win"], n - c["a_win"]
        g = {"a": a, "b": b, "division": teams[a]["division"] == teams[b]["division"],
             "pA": round(pa, 4), "pAClosedForm": round(win_closed(a, b), 4),
             "aPoWin": round(c["a_po_w"] / a_w, 4) if a_w else None,
             "aPoLoss": round(c["a_po_l"] / a_l, 4) if a_l else None,
             "bPoWin": round(c["b_po_w"] / a_l, 4) if a_l else None,
             "bPoLoss": round(c["b_po_l"] / a_w, 4) if a_w else None,
             "aDivWin": round(c["a_div_w"] / a_w, 4) if a_w else None,
             "aDivLoss": round(c["a_div_l"] / a_l, 4) if a_l else None,
             "bDivWin": round(c["b_div_w"] / a_l, 4) if a_l else None,
             "bDivLoss": round(c["b_div_l"] / a_w, 4) if a_w else None}
        g["aSplit"] = split_result(now["samples"][(a, b)], 0)
        g["bSplit"] = split_result(now["samples"][(a, b)], 1)
        g["stakes"] = round(abs((g["aPoWin"] or 0) - (g["aPoLoss"] or 0))
                            + abs((g["bPoWin"] or 0) - (g["bPoLoss"] or 0)), 4)
        fav, dog = (a, b) if pa >= 0.5 else (b, a)
        g["favorite"], g["underdog"] = fav, dog
        g["favoriteP"] = round(max(pa, 1 - pa), 4)

        # Upset path: where the underdog's projected lineup is ahead.
        sf, sd_ = _sides(slots[fav], pws[fav]), _sides(slots[dog], pws[dog])
        g["sides"] = {"favorite": dict((x, round(v, 1)) for x, v in sf.items()),
                      "underdog": dict((x, round(v, 1)) for x, v in sd_.items())}
        g["underdogAhead"] = [x for x in ("O", "D", "K") if sd_[x] > sf[x] + 0.05]

        # Flip factor: the projected starter whose absence moves this game most,
        # with an injury-tagged starter preferred when one moves it at all.
        best = None
        reg0 = _regressed(raw, k)
        base = win_closed(fav, dog, reg0[fav], reg0[dog])
        for side in (fav, dog):
            for sid, pid in slots[side].items():
                if not pid or pid.startswith("REP:"):
                    continue
                pw2 = dict(proj)
                pw2.pop(pid, None)
                r2 = dict(raw)
                r2[side], _, _ = _lineup(prep["rosters"][side], pw2, rep)
                reg = _regressed(r2, k)
                p_fav = win_closed(fav, dog, reg[fav], reg[dog])
                tag = (injury.get(pid) or {}).get("status") or ""
                cand = {"pid": pid, "player": pname(pid), "nflTeam": pteam(pid), "owner": side,
                        "status": tag, "proj": round(proj.get(pid, 0.0), 1),
                        "lineupLoss": round(raw[side] - r2[side], 1),
                        "favPBase": round(base, 4), "favPWithout": round(p_fav, 4),
                        "kickoff": kick.get(pteam(pid))}
                score = abs(p_fav - base) + (1.0 if tag in TAGGED and abs(p_fav - base) >= 0.01 else 0.0)
                if best is None or score > best[0]:
                    best = (score, cand)
        g["flip"] = best[1] if best else None
        g["scoreRange"] = dict((f, {"proj": round(now["wp"][f][week], 1),
                                    "p10": round(_pct(now["wk_scores"][f], 0.10), 1),
                                    "p90": round(_pct(now["wk_scores"][f], 0.90), 1)}) for f in (a, b))
        games.append(g)
    games.sort(key=lambda g: -g["stakes"])

    # ---- lineup / injury watch: tagged projected starters, league-wide
    watch = []
    for f in teams:
        for sid, pid in slots[f].items():
            if not pid or pid.startswith("REP:"):
                continue
            r = injury.get(pid)
            if not r or r.get("status") not in TAGGED:
                continue
            pw2 = dict(proj)
            pw2.pop(pid, None)
            r2, _, _ = _lineup(prep["rosters"][f], pw2, rep)
            watch.append({"pid": pid, "player": pname(pid), "nflTeam": pteam(pid), "owner": f,
                          "status": r["status"], "details": r.get("details") or "",
                          "proj": round(proj.get(pid, 0.0), 1), "lineupLoss": round(raw[f] - r2, 1),
                          "kickoff": kick.get(pteam(pid))})
    watch.sort(key=lambda w: -w["lineupLoss"])

    # ---- why projected strength moved (see projection_shift)
    weeks = list(range(week, prep["reg_end"] + 1))
    # Two separate "whys", one per step, so neither mixes sources:
    #   mflWhy    -- the preseason run's MFL projections vs MFL's own today (what MFL
    #                changed: injuries, roles, and its touchdown-rounding flips);
    #   switchWhy -- MFL's today vs RotoWire expected points today, MFL deciding who
    #                plays (what the change of scoring source did).
    shift = dict((f, projection_shift(prep_pre, prep_mfl, f, weeks, pname)) for f in sorted(teams))
    switch = dict((f, projection_shift(prep_mfl, prep, f, weeks, pname)) for f in sorted(teams))
    # Averaged from the exact team values -- averaging already-rounded numbers printed
    # 202.2 for a true 202.13 (caught by an independent recomputation, 2026-09-16).
    league_before = round(sum(x.pop("exactBefore") for x in shift.values()) / len(shift), 1)
    league_now = round(sum(x.pop("exactNow") for x in shift.values()) / len(shift), 1)
    league_rw = round(sum(x.pop("exactNow") for x in switch.values()) / len(switch), 1)
    for x in switch.values():
        x.pop("exactBefore", None)
    league_sides = dict((k, round(sum(x["sidesNow"][k] - x["sidesBefore"][k] for x in shift.values()) / len(shift), 1))
                        for k in ("O", "D", "K"))

    # WHAT MFL CHANGED, straight from its raw projectedScores feed (no absences, no
    # lineups): every player it projects, weeks 2-14, before vs now, and by position
    # for players projected 5+ a week either time. Keith asked whether a double-digit
    # drop was real; the all-player total is the fair measure, not a top-N list picked
    # by the preseason numbers (that selection exaggerates the drop).
    def raw_proj(fetcher, cache):
        out = {}
        for w in weeks:
            rows = S._as_list(fetcher(S.MFL % (season, "projectedScores", "&W=%d" % w), cache)["projectedScores"].get("playerScore"))
            out[w] = dict((r["id"], float(r["score"])) for r in rows if r.get("id") and r.get("score") not in (None, ""))
        return out
    raw_pre = raw_proj(cached_only, preseason_cache)
    raw_now = raw_proj(S.fetch, live_cache)
    tot_pre = sum(sum(v.values()) for v in raw_pre.values())
    tot_now = sum(sum(v.values()) for v in raw_now.values())
    by_group = {}
    for pid in set(p for w in weeks for p in raw_pre[w]) | set(p for w in weeks for p in raw_now[w]):
        a = sum(raw_pre[w].get(pid, 0.0) for w in weeks) / float(len(weeks))
        b = sum(raw_now[w].get(pid, 0.0) for w in weeks) / float(len(weeks))
        if max(a, b) < 5.0:
            continue
        g = LE.pos_group((players.get(pid) or {}).get("position") or "")
        g = {"DL": "IDP", "LB": "IDP", "DB": "IDP", "PK": "K/P", "PN": "K/P"}.get(g, g)
        x = by_group.setdefault(g, [0, 0.0, 0.0])
        x[0] += 1; x[1] += a; x[2] += b
    mfl_change = {"weeks": [weeks[0], weeks[-1]], "allPlayersPct": round(100.0 * (tot_now / tot_pre - 1), 1),
                  "byGroup": dict((g, {"players": v[0], "pct": round(100.0 * (v[2] / v[1] - 1), 1)})
                                  for g, v in by_group.items() if v[0] >= 5 and v[1] > 0)}

    # ---- forecast movement
    live_path = "site/wire/data/season_sim_%d_live_wk%02d.json" % (season, through)
    live = json.load(open(live_path, encoding="utf-8")) if os.path.exists(live_path) else None
    live_by = dict((t["franchiseId"], t) for t in (live or {}).get("teams", []))
    movement = []
    for f in sorted(teams):
        pre = pre_by.get(f, {})
        movement.append({
            "fid": f, "owner": who(f),
            "preseasonPlayoff": pre.get("pPlayoffs"), "preseasonTitle": pre.get("pTitle"),
            "bankedPlayoff": round(banked["odds"][f]["playoff"], 4),
            "bankedTitle": round(banked["odds"][f]["title"], 4),
            "afterWeekPlayoff": (live_by.get(f) or {}).get("currentPlayoffOdds"),
            "enteringPlayoff": round(now["odds"][f]["playoff"], 4),
            "enteringTitle": round(now["odds"][f]["title"], 4),
            "enteringDivision": round(now["odds"][f]["division"], 4),
            "resultEffect": (round(banked["odds"][f]["playoff"] - pre["pPlayoffs"], 4)
                             if pre.get("pPlayoffs") is not None else None),
            "strengthEffect": round(now["odds"][f]["playoff"] - banked["odds"][f]["playoff"], 4),
            "enteringPlayoffMflOffense": round(now_mfl["odds"][f]["playoff"], 4),
            "mflUpdateEffect": round(now_mfl["odds"][f]["playoff"] - banked["odds"][f]["playoff"], 4),
            "switchEffect": round(now["odds"][f]["playoff"] - now_mfl["odds"][f]["playoff"], 4),
            "mflWhy": shift[f],
            "switchWhy": switch[f],
        })

    # ---- division watch
    rec = dict((f, {"w": 0, "l": 0}) for f in teams)
    for wk in range(1, through + 1):
        for a, b in sched.get(wk, []):
            if actual[wk][a] == actual[wk][b]:
                continue
            w_, l_ = (a, b) if actual[wk][a] > actual[wk][b] else (b, a)
            rec[w_]["w"] += 1; rec[l_]["l"] += 1
    divisions = {}
    for f in teams:
        divisions.setdefault(teams[f]["division"], []).append(f)
    div_names = dict((x["id"], x.get("name") or x["id"])
                     for x in S._as_list((prep["league"].get("divisions") or {}).get("division")))
    if set(divisions) - set(div_names):
        raise SystemExit("week_preview: MFL league export has no name for division(s) %s"
                         % sorted(set(divisions) - set(div_names)))
    div_watch = []
    for d, members in sorted(divisions.items()):
        members.sort(key=lambda f: (-now["odds"][f]["division"]))
        div_watch.append({
            "division": d, "name": div_names[d],
            "teams": [{"fid": f, "owner": who(f), "record": "%d-%d" % (rec[f]["w"], rec[f]["l"]),
                       "divisionOdds": round(now["odds"][f]["division"], 4)} for f in members],
            "gamesThisWeek": [[a, b] for a, b in sched.get(week, []) if a in members and b in members],
        })

    return {
        "schema": 1, "season": season, "week": week, "throughWeek": through,
        "generatedAtUtc": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "provisional": True,
        "runs": runs, "seed": seed,
        "model": {
            "regress": k, "sigmaWeekly": round(now["sigma_w"], 2), "sigmaSeason": round(now["sigma_s"], 2),
            "teamWeekSd": round(sd_team, 2),
            "assumptions": [
                "each team starts its best legal lineup by its week projection (replacement-level free agents fill empty slots)",
                "players MFL lists Out/IR/Suspended, plus season_sim REPORTED_ABSENCES, are removed; Questionable and Doubtful players are assumed to play",
                "a team's week score = regressed projection + a season-long shock + a weekly swing, the two calibrated to UPS 2021-2025",
                "team scores are drawn independently of each other -- no shared NFL-game correlation",
                "played weeks are fixed to MFL's actual results; no trades or waiver moves after the cutoff",
                "offense is projected from RotoWire's projected stats (via Sleeper) scored with UPS rules -- a 40% chance at a touchdown counts as 40% of six points -- with MFL deciding who plays; defenders, kickers and punters use MFL's projections",
                "single-game win chances and weekly ranges have not been tested against past seasons game by game",
            ],
            "cutoffs": {"rostersProjectionsInjuries": cutoff.strftime("%Y-%m-%dT%H:%M:%SZ"),
                        "injuryFeedWeek": inj_feed.get("week"),
                        "sleeperProjectionsUpdated": (prep.get("evCoverage") or {}).get("sleeperUpdatedAt"),
                        "preseasonInputs": preseason.get("generatedAtUtc"),
                        "afterWeekSnapshot": (live or {}).get("generatedAtUtc")},
            "preseasonReproductionMaxPlayoffGap": round(repro_gap, 4),
            "evCoverage": prep.get("evCoverage"),
        },
        "games": games, "injuryWatch": watch[:12],
        "movement": movement, "divisionWatch": div_watch,
        "leagueLineupPerWeek": {"before": league_before, "now": league_now, "rotowireNow": league_rw,
                                "weeks": [weeks[0], weeks[-1]],
                                "sideChange": league_sides},
        "mflProjectionChange": mfl_change,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--week", type=int, required=True)
    ap.add_argument("--runs", type=int, default=8000)
    ap.add_argument("--seed", type=int, default=20260911)
    ap.add_argument("--preseason-cache", required=True)
    ap.add_argument("--live-cache", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--reuse-cache", action="store_true",
                    help="use --live-cache as-is (no refetch); the cutoff becomes that cache's fetch time")
    a = ap.parse_args()
    if os.path.exists(a.out):
        raise SystemExit("week_preview: %s exists -- a preview snapshot is never overwritten" % a.out)
    out = build(a.season, a.week, a.runs, a.seed, a.preseason_cache, a.live_cache, reuse_cache=a.reuse_cache)
    os.makedirs(os.path.dirname(a.out), exist_ok=True)
    open(a.out, "w", encoding="utf-8").write(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    for g in out["games"]:
        print("%s v %s  pA %.3f (closed %.3f)  stakes %.3f" % (g["a"], g["b"], g["pA"], g["pAClosedForm"], g["stakes"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
