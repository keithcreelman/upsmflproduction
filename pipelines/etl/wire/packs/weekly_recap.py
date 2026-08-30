#!/usr/bin/env python3
"""Weekly recap data pack. Deterministic; no language model.

REBUILT 2026-08 after the first five generated recaps were rejected as
"terrible, boring". The diagnosis was mechanical, not stylistic: the pack
carried 46 facts and every one of them was a team total. There was not a single
player name in it. The writer had nothing concrete to say, so it wrote about
the format instead ("Multi-header weeks exist to strip away excuses") and
invented colour to fill the gaps ("somewhere a kicker doinked one in").

WHAT CHANGED
  * PLAYERS. The week's best performance with its real NFL box line -- Trevor
    Lawrence went 20-of-32 for 330 and five scores plus 51 on the ground. That
    is the honest replacement for the invented kicker.
  * BENCH BURNS. The specific miss, both names, both scores: Shawn Blake left
    Kyle Pitts on his bench for 55.7 and started Brenton Strange for 4.3.
  * WEEKLY all-play, not just season-to-date. "Eric Martel went 11-0 against
    the field" is a sentence; "89-65 on the season" is a spreadsheet.
  * MOMENTUM over a three-week window -- one week is noise, and eleven
    all-play games is exactly one week in a twelve-team league, so
    "won 9 of his last 11" is a meaningless phrasing here.
  * REAL QUOTES from the league's own Discord, placed by id and rendered
    verbatim (see wire_pack.Pack.quote).

MULTI-OPPONENT WEEKS. Most regular-season weeks are double- or triple-headers:
a franchise can face 2-3 opponents at once. The scoreboard is a list of distinct
GAMES (unordered pairs), never one row per franchise.

ALL-PLAY IS THE QUALITY YARDSTICK, not raw H2H record, which the multi-header
format inflates. Verified: wire_data.allplay_table() reproduces the official
src_standings.allplay_regseason_w/l/t exactly for the full 2025 season.

SEEDING. An earlier version of this docstring claimed the league's playoff
tiebreak had not been reverse-engineered and so refused to state standings
positions before week 14. That was wrong -- the rule is written down in
docs/league_context_v1.md section F.1 and reproduces the official 2025 top six.
Where the pack still hedges it is because a number is genuinely unknown, not
because the rule is.
"""

import os
import re
import sys
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import wire_data as D                                    # noqa: E402
from wire_pack import Pack                                # noqa: E402

PACK_ID_RE = re.compile(r"^(\d{4})-wk(\d{2})-recap$")

# Canon's own round names (docs/league_context_v1.md ~1170).
PLAYOFF_ROUND_NAME = {15: "UPS Playoffs -- Round 1", 16: "UPS Playoffs -- Round 2",
                      17: "UPS Bracket Finals"}


def _ordinal(n):
    n = int(n)
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return "%d%s" % (n, suffix)


def _slug(name):
    """'Lawrence, Trevor' -> 'lawrence-trevor', for readable fact ids."""
    out = []
    for ch in str(name or "").lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "-":
            out.append("-")
    return "".join(out).strip("-") or "unknown"


def _box_phrase(box):
    """A real box line as readable text, for the fact's fmt.

    The writer never assembles this from parts -- it places the whole phrase --
    so it cannot mix up whose yards were whose.
    """
    if not box:
        return None
    bits = []
    if box.get("pass_att"):
        p = "%s-of-%s for %s" % (box.get("pass_cmp", 0), box["pass_att"], box.get("pass_yds", 0))
        if box.get("pass_tds"):
            p += ", %d TD" % box["pass_tds"]
        if box.get("pass_ints"):
            p += ", %d INT" % box["pass_ints"]
        bits.append(p)
    if box.get("rush_att"):
        r = "%s carries for %s" % (box["rush_att"], box.get("rush_yds", 0))
        if box.get("rush_tds"):
            r += " and %d TD" % box["rush_tds"]
        bits.append(r)
    if box.get("receptions"):
        c = "%s catches on %s targets for %s" % (
            box["receptions"], box.get("targets", box["receptions"]), box.get("rec_yds", 0))
        if box.get("rec_tds"):
            c += " and %d TD" % box["rec_tds"]
        bits.append(c)
    if box.get("fg_made"):
        f = "%s-of-%s on field goals" % (box["fg_made"], box.get("fg_att", box["fg_made"]))
        if box.get("fg_long"):
            f += ", long of %s" % box["fg_long"]
        bits.append(f)
    if box.get("def_tackles_total"):
        d = "%s tackles" % box["def_tackles_total"]
        for k, lbl in (("def_sacks", "sack"), ("def_ints", "INT"), ("def_tds", "TD")):
            if box.get(k):
                d += ", %s %s" % (box[k], lbl)
        bits.append(d)
    return "; ".join(bits) if bits else None


def parse_pack_id(pack_id):
    m = PACK_ID_RE.match(pack_id)
    if not m:
        raise D.DataError("weekly_recap pack id must match <season>-wk<NN>-recap, got %r" % pack_id)
    return int(m.group(1)), int(m.group(2))


def build(pack_id):
    season, week = parse_pack_id(pack_id)
    is_playoff = week >= 15
    pack = Pack(pack_id, season, week=week,
                title="%d %s" % (season, PLAYOFF_ROUND_NAME.get(week, "Week %d" % week)))

    # ---------------------------------------------------------- attribution
    drift = D.check_attribution()
    if drift:
        raise D.DataError("owner attribution disagrees with the commish ruling:\n  "
                          + "\n  ".join(drift))
    owners = D.owner_map(season)
    pack.source("src_franchises", asof="%d season" % season, rows=len(owners),
                note="authoritative (season, franchise_id) -> owner map")
    for fid in sorted(owners):
        key = D.owner_key(owners[fid]["owner_name"])
        pack.owner(key, owners[fid]["owner_name"])
        pack.franchise(season, fid, key, owners[fid]["team_name"])

    def who(fid):
        return owners.get(str(fid).zfill(4), {}).get("owner_name") or ("Franchise %s" % fid)

    F = pack.fact

    # -------------------------------------------------------------- games
    games = D.d1("SELECT franchise_id, opponent_franchise_id, team_score, opponent_score, "
                 "is_divisional FROM src_schedule WHERE season = %d AND week = %d"
                 % (season, week))
    if not games:
        raise D.DataError("no src_schedule rows for %d week %d" % (season, week))
    pack.source("src_schedule", asof="%d wk%d" % (season, week), rows=len(games),
                note="double/triple-header weeks store one row per (franchise, opponent)")

    # Collapse to one row per unordered pair. The key must NOT include scores:
    # the two directions store them swapped, so a score-bearing key hashes
    # differently each way and every game prints twice.
    # SCORES COME FROM ONE TABLE. src_schedule and src_franchise_weekly_score
    # disagree for 2025 week 17 -- 233.7 against 233.2 for the same franchise --
    # and the two were being mixed on a single page: the header and the tale of
    # the tape read src_schedule while f.team.<fid>.score, points left on bench
    # and every all-play figure read src_franchise_weekly_score. A game page
    # printed two different numbers for one team's score.
    #
    # src_franchise_weekly_score wins. It is the table team_opt_pts comes from
    # and the one all-play is computed over, and that all-play was verified to
    # reproduce the official src_standings figures exactly. src_schedule is used
    # only for the PAIRING -- who played whom -- which is the one thing it alone
    # knows. Any disagreement is surfaced rather than smoothed over.
    fws = dict((str(r["franchise_id"]).zfill(4), float(r["team_score"])) for r in
               D.d1("SELECT franchise_id, team_score FROM src_franchise_weekly_score "
                    "WHERE season = %d AND week = %d" % (season, week)))

    def score_of(fid, fallback):
        return fws.get(fid, float(fallback))

    drifted = []
    seen, distinct_games = set(), []
    for g in games:
        a, b = str(g["franchise_id"]).zfill(4), str(g["opponent_franchise_id"]).zfill(4)
        key = tuple(sorted((a, b)))
        if key in seen:
            continue
        seen.add(key)
        a_score, b_score = score_of(a, g["team_score"]), score_of(b, g["opponent_score"])
        for fid, sched in ((a, g["team_score"]), (b, g["opponent_score"])):
            if fid in fws and abs(fws[fid] - float(sched)) >= 0.05 and fid not in drifted:
                drifted.append(fid)
        distinct_games.append({
            "a": a, "b": b, "a_score": a_score, "b_score": b_score,
            "margin": abs(a_score - b_score),
            "divisional": bool(g["is_divisional"]),
        })
    distinct_games.sort(key=lambda g: -g["margin"])
    if drifted:
        pack.warn("src_schedule and src_franchise_weekly_score disagree on the score for "
                  + ", ".join(sorted(drifted))
                  + " this week. Every figure here comes from src_franchise_weekly_score, "
                    "which is the table all-play and optimal-lineup are computed from and "
                    "which reproduces the official standings exactly.")

    # Per-game drilldown blocks. Built after the bench/efficiency data below is
    # available, so they are populated further down -- this list holds the ids.
    game_ids = []

    appearances = {}
    for g in distinct_games:
        appearances[g["a"]] = appearances.get(g["a"], 0) + 1
        appearances[g["b"]] = appearances.get(g["b"], 0) + 1
    multi_opponent = any(n > 1 for n in appearances.values())

    # -------------------------------------------------------- performances
    # Every starter, not a top-N slice: each game page carries a play card for
    # the best performance IN THAT GAME, so a franchise outside the league-wide
    # top forty still needs its own best man findable.
    perfs = D.top_performers(season, week, limit=260)
    pack.source("src_weekly", asof="%d wk%d" % (season, week), rows=len(perfs),
                note="per-player weekly scores; starters only")

    top_by_fid = {}
    for p in perfs:
        fid = str(p["fid"] or "").zfill(4)
        if fid and fid not in top_by_fid:
            top_by_fid[fid] = p

    if perfs:
        best = perfs[0]
        bslug = _slug(best["player_name"])
        F("f.star.name", "Top performer", best["player_name"], "text",
          "src_weekly", "wk%d" % week, fmt=best["player_name"])
        F("f.star.score", "Top performer score", float(best["score"]), "points",
          "src_weekly", "wk%d" % week)
        F("f.star.owner", "Top performer's manager", who(best["fid"]), "text",
          "src_weekly", "wk%d" % week, fmt=who(best["fid"]))
        box = D.nfl_box_line(season, week, best["player_id"])
        phrase = _box_phrase(box)
        if phrase:
            F("f.star.line", "Top performer's box line", phrase, "text",
              "nfl_player_weekly", "wk%d" % week, fmt=phrase)
            pack.source("nfl_player_weekly", asof="%d wk%d" % (season, week), rows=1,
                        note="real box scores, so performances are described not invented")
        # A fact for EVERY top performer, not just the best one. The writer
        # naturally wants to cite the second- and third-best days too -- the
        # first rebuilt draft tried to type "46.2" for Amon-Ra St. Brown and was
        # correctly blocked, because no fact existed for him. Blocking is the
        # right behaviour; having the fact is the right fix.
        for p in perfs[:10]:
            F("f.player.%s.score" % _slug(p["player_name"]),
              "%s (%s) -- week score" % (p["player_name"], who(p["fid"])),
              float(p["score"]), "points", "src_weekly", "wk%d" % week)

        form = D.player_prior_form(season, week, best["player_id"])
        if form and form["games"] >= 3:
            F("f.star.prior_avg", "Top performer's average before this week",
              form["avg"], "points", "src_weekly", "before wk%d" % week)
            if float(best["score"]) > form["best"]:
                F("f.star.prior_best", "Top performer's previous season high",
                  form["best"], "points", "src_weekly", "before wk%d" % week)

    # -------------------------------------------------------- bench burns
    burns = D.bench_burns(season, week)
    if burns:
        pack.source("src_weekly (bench comparison)", asof="%d wk%d" % (season, week),
                    rows=len(burns), note="benched player who outscored a starter at the "
                                          "same position group, classified process vs variance "
                                          "on each player's average BEFORE this week")
        # PROCESS FIRST. The biggest point swing is usually the RIGHT call that
        # went wrong -- in 2025 week 13 every single one was, including Bousquet
        # starting a 21-point-a-week receiver who caught nothing. The earlier
        # draft roasted him for it, which is roasting an outcome. Only a burn
        # where the benched man was the better player is a decision worth
        # criticising, so surface that one if it exists.
        proc = [f for f in burns if burns[f]["verdict"] == "process"]
        worst_fid = (max(proc, key=lambda f: burns[f]["diff"]) if proc
                     else max(burns, key=lambda f: burns[f]["diff"]))
        b = burns[worst_fid]
        _burn_fid = worst_fid
        F("f.burn.owner", "Biggest bench swing", who(worst_fid), "text",
          "src_weekly", "wk%d" % week, fmt=who(worst_fid))
        F("f.burn.benched", "Player left on the bench", b["benched"], "text",
          "src_weekly", "wk%d" % week, fmt=b["benched"])
        F("f.burn.benched_score", "What the benched player scored",
          b["benched_score"], "points", "src_weekly", "wk%d" % week)
        F("f.burn.started", "Who was started instead", b["started"], "text",
          "src_weekly", "wk%d" % week, fmt=b["started"])
        F("f.burn.started_score", "What the starter scored",
          b["started_score"], "points", "src_weekly", "wk%d" % week)
        F("f.burn.verdict", "Was that a bad DECISION or a bad result?",
          b["verdict"], "text", "derived", "wk%d" % week,
          fmt=("the wrong man started -- %s had been the better player all year" % b["benched"]
               if b["verdict"] == "process" else
               "the right man started and had a bad day"))
        if not proc:
            F("f.week.no_process_burns", "Bench calls that were actually wrong",
              0, "count", "derived", "wk%d" % week,
              fmt="not one of them")

    # ------------------------------------------------- starters who never played
    # The one genuinely rippable start. Everything else on a lineup card is a
    # judgement that can go wrong; an inactive player in a starting slot is an
    # information failure, and it is fair game. See wire_data.did_not_play for
    # why this is read from the NFL box and not from an injury table.
    dnp = D.did_not_play(season, week)
    if dnp:
        pack.source("nfl_player_weekly (activity check)", asof="%d wk%d" % (season, week),
                    rows=sum(len(v) for v in dnp.values()),
                    note="starters with no snap of any kind -- distinguishes an inactive player "
                         "from a healthy one who scored nothing")
        for fid in sorted(dnp):
            names = ", ".join("%s (%s)" % (p["player"], p["position"]) for p in dnp[fid])
            F("f.dnp.%s" % fid, "%s -- started someone who never took a snap" % who(fid),
              len(dnp[fid]), "count", "nfl_player_weekly", "wk%d" % week, fmt=names)

    # ------------------------------------------------- lineup efficiency
    opt = D.d1("SELECT franchise_id, team_score, team_opt_pts FROM src_franchise_weekly_score "
               "WHERE season = %d AND week = %d" % (season, week))
    opt_by_fid = dict((str(r["franchise_id"]).zfill(4), r) for r in opt)
    pack.source("src_franchise_weekly_score", asof="%d wk%d" % (season, week), rows=len(opt),
                note="team_opt_pts is MFL's own optimal-lineup figure -- never reconstructed "
                     "locally, which overstated one 2025 week by 9.1 points")

    # ------------------------------------------------- the counterfactual
    # For every loser: could their BEST AVAILABLE lineup have beaten what the
    # winner actually scored? This separates "beat himself" from "was beaten",
    # and in 2025 wk15 it split perfectly along bracket lines -- both
    # championship losers had a winning card and misplayed it, both consolation
    # losers were simply outgunned. Verified 4/4 against source before shipping.
    #
    # Uses MFL's own team_opt_pts, never a locally reconstructed optimum, which
    # overstated one 2025 week by 9.1 points.
    # Collect losses PER FRANCHISE first. In a double- or triple-header a team
    # can lose two or three games in the same week, so a per-game loop would
    # register the same fact id repeatedly (caught by the duplicate guard on
    # week 13 -- week 15 was single-opponent and could never have exposed it).
    #
    # It also changes the question. With several losses the honest framing is
    # "was there ANY game here he could have won with a perfect lineup?", so
    # compare his ceiling against the LOWEST score that beat him.
    losses = {}
    for g in distinct_games:
        lo = g["b"] if g["a_score"] >= g["b_score"] else g["a"]
        losses.setdefault(lo, []).append(max(g["a_score"], g["b_score"]))

    # WOULD THAT ONE SWAP ACTUALLY HAVE FLIPPED ANYTHING? The writer asserted it
    # would in week 16, when the swing (22.9) was smaller than the margin (35.9)
    # -- a spelled-out comparison, so there was no digit for the audit to catch.
    # Answered here from the data instead of estimated in prose. Placed after
    # `losses` because it needs the score that actually beat him.
    if burns and "f.burn.owner" in pack._facts:
        wf = _burn_fid
        wb2 = burns[wf]
        beat_him = min(losses.get(wf) or []) if losses.get(wf) else None
        if beat_him is not None and wf in opt_by_fid:
            swing = wb2["benched_score"] - wb2["started_score"]
            got = float(opt_by_fid[wf]["team_score"])
            covers = (got + swing) > beat_him
            F("f.burn.covers_margin",
              "%s -- would that one swap have won him a game he lost?" % who(wf),
              "yes" if covers else "no", "text", "derived", "wk%d" % week,
              fmt=("that single change wins him the game" if covers
                   else "even that change does not win him the game"))

    self_inflicted, outgunned = [], []
    for lo, winner_scores in sorted(losses.items()):
        o = opt_by_fid.get(lo)
        if not o:
            continue
        best = float(o["team_opt_pts"])
        easiest = min(winner_scores)          # the most winnable of his losses
        winnable = best > easiest
        (self_inflicted if winnable else outgunned).append(lo)
        F("f.team.%s.best_available" % lo, "%s -- best lineup available" % who(lo),
          best, "points", "src_franchise_weekly_score", "wk%d" % week)
        F("f.team.%s.could_have_won" % lo,
          "%s -- could his best lineup have won a game he lost?" % who(lo),
          "yes" if winnable else "no", "text", "derived", "wk%d" % week,
          fmt=("had a winning lineup on his bench" if winnable
               else "could not have won with a perfect card"))
    _WORD = {0: "none", 1: "one", 2: "two", 3: "three", 4: "four", 5: "five",
             6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
             11: "eleven", 12: "twelve"}
    if self_inflicted:
        F("f.week.self_inflicted", "Losers who had a winning lineup on the bench",
          len(self_inflicted), "count", "derived", "wk%d" % week,
          fmt=_WORD.get(len(self_inflicted), str(len(self_inflicted))))
    if outgunned:
        F("f.week.outgunned", "Losers who could not have won either way",
          len(outgunned), "count", "derived", "wk%d" % week,
          fmt=_WORD.get(len(outgunned), str(len(outgunned))))

    # ------------------------------------------------------- weekly all-play
    wap = D.weekly_allplay(season, week)
    pack.source("src_franchise_weekly_score (weekly self-join)", asof="%d wk%d" % (season, week),
                rows=len(wap), note="this week's record against the whole field")
    perfect = [f for f in wap if wap[f]["l"] == 0]
    winless = [f for f in wap if wap[f]["w"] == 0]
    if perfect:
        F("f.week.perfect", "Beat the entire field", who(perfect[0]), "text",
          "weekly all-play", "wk%d" % week, fmt=who(perfect[0]))
    if winless:
        F("f.week.winless", "Lost to the entire field", who(winless[0]), "text",
          "weekly all-play", "wk%d" % week, fmt=who(winless[0]))

    # ---------------------------------------------------- season all-play
    ap = D.allplay_table(season, week, playoff=is_playoff)
    ap_order = sorted(ap, key=lambda f: (-ap[f]["w"], -ap[f].get("pf", 0)))

    # ------------------------------------------------------------ momentum
    # Three weeks, not one: eleven all-play games IS one week here, so a
    # "last 11 games" framing carries no information at all.
    momentum = {}
    if week >= 4 and not is_playoff:
        prior = D.allplay_table(season, week - 3, playoff=False)
        for fid in ap:
            if fid not in prior:
                continue
            recent_w = ap[fid]["w"] - prior[fid]["w"]
            recent_l = ap[fid]["l"] - prior[fid]["l"]
            if recent_w + recent_l:
                momentum[fid] = {"w": recent_w, "l": recent_l,
                                 "pct": recent_w / float(recent_w + recent_l)}
        if momentum:
            hot = max(momentum, key=lambda f: momentum[f]["pct"])
            cold = min(momentum, key=lambda f: momentum[f]["pct"])
            # Label carries the name so the writer knows WHO; fmt carries only
            # the record, so a sentence naming him does not print it twice.
            F("f.mo.hot", "%s -- hottest three-week run" % who(hot),
              momentum[hot]["w"], "count", "rolling all-play", "wk%d" % week,
              fmt="%d-%d" % (momentum[hot]["w"], momentum[hot]["l"]))
            F("f.mo.cold", "%s -- coldest three-week run" % who(cold),
              momentum[cold]["w"], "count", "rolling all-play", "wk%d" % week,
              fmt="%d-%d" % (momentum[cold]["w"], momentum[cold]["l"]))

    # -------------------------------------------------- seeding / bracket
    seed_by_fid, bracket, final_place, is_season_finale = {}, {}, {}, False
    if week >= 14 or is_playoff:
        for r in D.d1("SELECT franchise_id, regular_season_finish FROM src_final_standings "
                      "WHERE season = %d" % season):
            seed_by_fid[str(r["franchise_id"]).zfill(4)] = int(r["regular_season_finish"])
        pack.source("src_final_standings", asof="%d final" % season, rows=len(seed_by_fid),
                    note="official regular-season finish")

    if is_playoff:
        ranked = sorted(seed_by_fid, key=lambda f: seed_by_fid[f])
        champ_pool = set(ranked[:6])
        rec = {}
        for r in D.d1("SELECT franchise_id, result FROM src_schedule WHERE season = %d "
                      "AND is_playoff = 1 AND week <= %d" % (season, week)):
            fid = str(r["franchise_id"]).zfill(4)
            d = rec.setdefault(fid, {"w": 0, "l": 0})
            if r["result"] == "W":
                d["w"] += 1
            elif r["result"] == "L":
                d["l"] += 1
        for fid in owners:
            r = rec.get(fid, {"w": 0, "l": 0})
            bracket[fid] = {"pool": "championship" if fid in champ_pool else "consolation",
                            "w": r["w"], "l": r["l"], "alive": r["l"] == 0}
        pack.warn("Bracket status is derived from playoff win/loss (no losses = still alive for "
                  "that pool's top spot), not read from an official bracket table. Correct for "
                  "single elimination with byes and hand-checked against every 2025 result, but "
                  "it does not assert a seed number.")

        meta = D.d1("SELECT total_weeks FROM src_league_season_meta WHERE season = %d" % season)
        is_season_finale = bool(meta) and week == int(meta[0]["total_weeks"])
        if is_season_finale:
            for r in D.d1("SELECT franchise_id, final_finish FROM src_final_standings "
                          "WHERE season = %d" % season):
                final_place[str(r["franchise_id"]).zfill(4)] = int(r["final_finish"])
            for fid in sorted(final_place, key=lambda f: final_place[f]):
                F("f.team.%s.final_place" % fid, "%s -- final place" % who(fid),
                  final_place[fid], "rank", "src_final_standings", "%d final" % season,
                  fmt=_ordinal(final_place[fid]))

    # ------------------------------------------------------------- per team
    for fid in sorted(owners):
        w = wap.get(fid)
        if w:
            F("f.team.%s.week_allplay" % fid, "%s -- record against the field this week" % who(fid),
              w["w"], "count", "weekly all-play", "wk%d" % week, fmt="%d-%d" % (w["w"], w["l"]))
        if fid in opt_by_fid:
            r = opt_by_fid[fid]
            F("f.team.%s.score" % fid, "%s -- score" % who(fid), float(r["team_score"]),
              "points", "src_franchise_weekly_score", "wk%d" % week)
            left = float(r["team_opt_pts"]) - float(r["team_score"])
            F("f.team.%s.left_on_bench" % fid, "%s -- points left on the bench" % who(fid),
              left, "points", "src_franchise_weekly_score", "wk%d" % week)
        if fid in top_by_fid:
            p = top_by_fid[fid]
            F("f.team.%s.best_player" % fid, "%s -- best starter" % who(fid),
              p["player_name"], "text", "src_weekly", "wk%d" % week,
              fmt="%s (%.1f)" % (p["player_name"], float(p["score"])))
        if is_playoff and fid in bracket:
            b = bracket[fid]
            status = ("alive for the title" if b["pool"] == "championship" and b["alive"] else
                      "out of the title race" if b["pool"] == "championship" else
                      "safe from the cellar" if b["alive"] else "sliding toward the cellar")
            F("f.team.%s.bracket" % fid, "%s -- bracket status" % who(fid), status, "text",
              "derived", "wk%d" % week, fmt=status)

    # ------------------------------------------------- waivers and trades
    # "Did the pickup come through" is a lead story, not a footnote: the add is
    # only interesting once you can say what it produced that same week.
    try:
        picks = D.week_pickups(season, week)
    except D.DataError:
        picks = []
    hits = [p for p in picks if p["score"] is not None and p["score"] >= 12.0]
    if picks:
        pack.source("src_adddrop", asof="%d wk%d" % (season, week), rows=len(picks),
                    note="waiver/FA adds made this week, joined to what the player then scored")
        F("f.wire.adds", "Players added this week", len(picks), "count",
          "src_adddrop", "wk%d" % week)
        if hits:
            best = hits[0]
            # Owner in the LABEL, not the fmt. With him in the fmt a sentence
            # that already named him printed it twice: "Eric Mannila left it on
            # his bench: Bam Knight (Eric Mannila, 17.9)."
            F("f.wire.best_add", "Best pickup of the week, added by %s" % who(best["fid"]),
              best["player"], "text", "src_adddrop", "wk%d" % week,
              fmt="%s (%.1f)" % (best["player"], best["score"]))
            pack.table("t.pickups", "Waiver wire: what the adds produced",
                       [{"key": "player", "label": "Player", "type": "text"},
                        {"key": "owner", "label": "Added by", "type": "text"},
                        {"key": "how", "label": "How", "type": "text"},
                        {"key": "pts", "label": "Points", "type": "points", "align": "right"},
                        {"key": "started", "label": "Started?", "type": "text"}],
                       [[p["player"], who(p["fid"]), p.get("method") or "",
                         p["score"], "yes" if p["started"] else "no"]
                        for p in hits[:10]])

    try:
        deals = D.week_trades(season, week)
    except D.DataError:
        deals = {}
    if deals:
        pack.source("src_trades", asof="%d wk%d" % (season, week), rows=len(deals),
                    note="trades completed inside this week")
        F("f.wire.trades", "Trades completed this week", len(deals), "count",
          "src_trades", "wk%d" % week)

    # -------------------------------------------------------------- quotes
    quote_ids = []
    try:
        chat = D.week_quotes(season, week, limit=60)
    except D.DataError:
        chat = []
    if chat:
        pack.source("ups_discord_messages", asof="%d wk%d" % (season, week), rows=len(chat),
                    note="league chat, archived from Discord; quotes render verbatim")
        mention_map = D.discord_id_to_owner()
        # Rank by RELEVANCE, never by length. Length ranking surfaced an
        # off-topic locker-room riff as the top pull quote for week 15 -- long
        # because it was a monologue, and completely unpublishable. A real
        # reaction ("Sweet job by Whitman playing Kamara lol") is short.
        names = [owners[f]["owner_name"] for f in owners] + \
                [owners[f]["team_name"] for f in owners] + \
                [owners[f]["owner_name"].split()[-1] for f in owners]
        ranked = [(D.score_quote_relevance(m["content"], names), m) for m in chat]
        ranked = [(s, m) for s, m in ranked if s > 0]
        ranked.sort(key=lambda sm: (-sm[0], sm[1]["posted_at_unix"]))
        scored = [m for _, m in ranked]
        if not scored:
            pack.warn("League chat exists for this week but none of it was about the league, "
                      "so no quotes are carried.")
        for i, m in enumerate(scored[:8], 1):
            when = datetime.fromtimestamp(int(m["posted_at_unix"]), timezone.utc).strftime("%a %b %d")
            qid = "q%d" % i
            cleaned = D.clean_discord_text(m["content"], mention_map)
            if len(cleaned) < 20:
                continue
            pack.quote(qid, cleaned, m["owner_name"], when,
                       owner_key=D.owner_key(m["owner_name"]),
                       context="#%s" % (m.get("channel_name") or "chat"))
            quote_ids.append(qid)
    else:
        pack.warn("No archived league chat for this week, so this recap carries no quotes.")

    # ------------------------------------------------------ league context
    # Everything a matchup needs to be judged against: the real standings coming
    # in, each side's division record, and what each team normally scores.
    divs = D.divisions(season)
    for _dn in sorted(set(v for v in divs.values() if v)):
        pack.division(_dn)
    h2h_in = D.h2h_records(season, week - 1) if week > 1 else {}
    h2h_now = D.h2h_records(season, week)
    form_in = D.season_form(season, week - 1) if week > 1 else {}
    pack.source("src_schedule (record derivation)", asof="%d through wk%d" % (season, week),
                rows=len(h2h_now),
                note="overall and DIVISIONAL W-L through a given week; src_standings carries "
                     "div_w/div_l but is a season-final snapshot with no week column. "
                     "Verified to reproduce the official 2025 figures exactly")

    proj = D.week_projections(season, week)
    if proj:
        pack.source("ups_player_projections", asof="%d wk%d" % (season, week), rows=len(proj),
                    note="projected starter totals, captured live during the week")
    else:
        pack.warn("Projections are not carried for this week. MFL serves them live and never "
                  "stores them, so they exist only from the point capture began (migration "
                  "0114) -- the tale of the tape omits the row rather than inventing it.")

    # ------------------------------------------------- per-game drilldown
    # Season form COMING IN (through the previous week), for the tale of the
    # tape and for billing. Billing is combined incoming all-play, so the deck
    # opens on the biggest matchup of the week rather than the biggest blowout
    # -- a lopsided game between two bad teams is not the game of the week.
    prior_form = D.allplay_table(season, week - 1, playoff=False) if week > 1 else {}

    def _prior(fid):
        f = prior_form.get(fid)
        if not f:
            return None
        played = f["w"] + f["l"] + f.get("t", 0)
        return {"rec": "%d-%d" % (f["w"], f["l"]), "w": f["w"],
                "pf": f.get("pf", 0.0),
                "avg": (f.get("pf", 0.0) / max(1, played / 11.0))}

    ordered = sorted(
        distinct_games,
        key=lambda g: -((_prior(g["a"]) or {}).get("w", 0) + (_prior(g["b"]) or {}).get("w", 0)))

    # A play card for the best performance IN EACH GAME. The previous build hung
    # three league-wide cards off the section instead, so a page about Martel and
    # Dunn opened with a card for a player neither of them owned -- right data,
    # meaningless placement. Box lines and prior form are fetched in one batched
    # call each; per-card round trips turned the build into a minute of waiting.
    game_star = {}
    for i, g in enumerate(ordered, 1):
        cands = [p for p in perfs if str(p["fid"] or "").zfill(4) in (g["a"], g["b"])]
        if cands:
            game_star["g.%d" % i] = cands[0]
    star_boxes = D.nfl_box_lines(season, week, [p["player_id"] for p in game_star.values()])
    star_forms = D.players_prior_form(season, week, [p["player_id"] for p in game_star.values()])

    # Quotes belong to the matchup they are ABOUT. Assigned biggest game first,
    # each quote used once, and only when it names one of the two owners --
    # a generic message on a game page is worse than no message.
    quote_pool = list(quote_ids)
    quote_by_id = dict((q, pack._quotes[q]) for q in quote_pool)

    def _claim_quotes(fid_a, fid_b, limit=2):
        want = []
        for f in (fid_a, fid_b):
            nm = owners.get(f, {})
            for token in (nm.get("owner_name") or "", nm.get("team_name") or ""):
                if token:
                    want.append(token.lower())
                    want.append(token.lower().split()[-1])
        got = []
        for qid in list(quote_pool):
            text = (quote_by_id[qid]["text"] or "").lower()
            author = (quote_by_id[qid]["author"] or "").lower()
            if any(t and t in text for t in want) or any(t and t == author for t in want):
                got.append(qid)
                quote_pool.remove(qid)
                if len(got) >= limit:
                    break
        return got

    def _signed(x):
        return ("+%.1f" if x >= 0 else "%.1f") % x

    # RANKS, SO THE WRITER NEVER HAS TO COUNT. An adversarial read of the first
    # eighteen game notes caught two ordinal claims that were simply wrong --
    # "the highest ceiling of any loser" (third) and "the second-biggest beating
    # of the slate" (also third). Both were the model ranking a list by eye. The
    # fix is not a cleverer audit, it is handing over the answer: every margin
    # and every loser's ceiling arrives pre-ranked, in words.
    margin_rank = {}
    for r, gg in enumerate(sorted(distinct_games, key=lambda x: -x["margin"]), 1):
        margin_rank[tuple(sorted((gg["a"], gg["b"])))] = r
    loser_ceilings = []
    for gg in distinct_games:
        lo = gg["b"] if gg["a_score"] >= gg["b_score"] else gg["a"]
        o = opt_by_fid.get(lo)
        if o:
            loser_ceilings.append((lo, float(o["team_opt_pts"])))
    loser_ceilings.sort(key=lambda t: -t[1])
    ceiling_rank = dict((fid, i) for i, (fid, _) in enumerate(loser_ceilings, 1))
    n_games = len(distinct_games)

    def _nth(r, n, noun):
        if r == 1:
            return "the largest of %d" % n
        if r == 2:
            return "2nd largest of %d" % n
        return "%s largest of %d" % (_ordinal(r), n)

    for i, g in enumerate(ordered, 1):
        gid = "g.%d" % i
        hi_fid, lo_fid = ((g["a"], g["b"]) if g["a_score"] >= g["b_score"]
                          else (g["b"], g["a"]))
        hi_s, lo_s = max(g["a_score"], g["b_score"]), min(g["a_score"], g["b_score"])
        wb, lb = top_by_fid.get(hi_fid), top_by_fid.get(lo_fid)
        burn = burns.get(lo_fid)
        o = opt_by_fid.get(lo_fid)
        ceiling = float(o["team_opt_pts"]) if o else None
        note = None
        if ceiling is not None:
            note = ("A perfect lineup wins this game." if ceiling > hi_s
                    else "Even a perfect lineup loses this game.")

        wp, lp = _prior(hi_fid), _prior(lo_fid)
        wopt, lopt = opt_by_fid.get(hi_fid), opt_by_fid.get(lo_fid)
        gfacts = []

        tale = [{"label": "Final", "a": "%.1f" % hi_s, "b": "%.1f" % lo_s, "better": "a"}]

        # Did they beat what they normally do? The single most direct answer to
        # "was this a good week for him", and it is not derivable from the score.
        wf, lf = form_in.get(hi_fid), form_in.get(lo_fid)
        if wf and lf:
            wd, ld = hi_s - wf["avg"], lo_s - lf["avg"]
            tale.append({"label": "vs their season average", "a": _signed(wd), "b": _signed(ld),
                         "better": "a" if wd >= ld else "b"})
            for fid, delta in ((hi_fid, wd), (lo_fid, ld)):
                key = "f.team.%s.vs_avg" % fid
                if key not in pack._facts:
                    F(key, "%s -- this week against his own season average" % who(fid),
                      delta, "points", "derived", "wk%d" % week, fmt=_signed(delta))
                gfacts.append(key)

        # Projected only exists from the week capture began. Omitted, never faked.
        wpr, lpr = proj.get(hi_fid), proj.get(lo_fid)
        if wpr and lpr:
            tale.append({"label": "Projected", "a": "%.1f" % wpr["proj"],
                         "b": "%.1f" % lpr["proj"],
                         "better": "a" if wpr["proj"] >= lpr["proj"] else "b"})
            wo, lo_ = hi_s - wpr["proj"], lo_s - lpr["proj"]
            tale.append({"label": "vs projection", "a": _signed(wo), "b": _signed(lo_),
                         "better": "a" if wo >= lo_ else "b"})

        wr, lr = h2h_in.get(hi_fid), h2h_in.get(lo_fid)
        if wr and lr:
            tale.append({"label": "Record coming in", "a": wr["rec"], "b": lr["rec"],
                         "better": "a" if wr["pct"] >= lr["pct"] else "b"})
            tale.append({"label": "Division record", "a": wr["div_rec"], "b": lr["div_rec"],
                         "better": "a" if wr["div_pct"] >= lr["div_pct"] else "b"})
        if wp and lp:
            tale.append({"label": "All-play coming in", "a": wp["rec"], "b": lp["rec"],
                         "better": "a" if wp["w"] >= lp["w"] else "b"})
            tale.append({"label": "Points for, YTD", "a": "%.1f" % wp["pf"],
                         "b": "%.1f" % lp["pf"],
                         "better": "a" if wp["pf"] >= lp["pf"] else "b"})
        if wopt and lopt:
            wceil, lceil = float(wopt["team_opt_pts"]), float(lopt["team_opt_pts"])
            tale.append({"label": "Best lineup available", "a": "%.1f" % wceil,
                         "b": "%.1f" % lceil, "better": "a" if wceil >= lceil else "b"})
            tale.append({"label": "Left on bench",
                         "a": "%.1f" % (wceil - hi_s), "b": "%.1f" % (lceil - lo_s),
                         "better": "a" if (wceil - hi_s) <= (lceil - lo_s) else "b"})

        # The reader cannot tell a division rival from a stranger by the names.
        da, db = divs.get(hi_fid), divs.get(lo_fid)
        if g["divisional"] and da:
            tag = "%s -- division game" % da
        elif da and db:
            tag = "%s v %s" % (da, db)
        else:
            tag = None

        mr = margin_rank.get(tuple(sorted((g["a"], g["b"]))), 0)
        F("f.game.%02d.margin" % i,
          "%s over %s -- margin, %s this week" % (who(hi_fid), who(lo_fid),
                                                  _nth(mr, n_games, "margin")),
          g["margin"], "points", "src_franchise_weekly_score", "wk%d" % week)
        gfacts.append("f.game.%02d.margin" % i)
        # The rank as its own placeable token, so a sentence can SAY it rather
        # than the writer counting the list and getting it wrong.
        F("f.game.%02d.margin_rank" % i,
          "%s over %s -- where that margin ranks among this week's %d games"
          % (who(hi_fid), who(lo_fid), n_games), mr, "rank",
          "derived", "wk%d" % week, fmt=_nth(mr, n_games, "margin"))
        gfacts.append("f.game.%02d.margin_rank" % i)
        cr = ceiling_rank.get(lo_fid)
        if cr:
            key = "f.team.%s.ceiling_rank" % lo_fid
            if key not in pack._facts:
                F(key, "%s -- where his best available lineup ranks among this week's "
                       "%d losers" % (who(lo_fid), len(loser_ceilings)), cr, "rank",
                  "derived", "wk%d" % week,
                  fmt=("the highest of any loser this week" if cr == 1
                       else "%s highest of the %d losers" % (_ordinal(cr), len(loser_ceilings))))
            gfacts.append(key)
        for fid in (hi_fid, lo_fid):
            for suffix in ("score", "week_allplay", "left_on_bench", "best_player",
                           "best_available", "week_rank_own", "season_pf_rank"):
                key = "f.team.%s.%s" % (fid, suffix)
                if key in pack._facts:
                    gfacts.append(key)

        # The card for THIS game, built from this game's best starter.
        card_id = None
        star = game_star.get(gid)
        if star:
            slug = _slug(star["player_name"])
            cid = "pc.%s" % slug
            if cid not in pack._playcards:
                pbox = star_boxes.get(str(star["player_id"]))
                pfm = star_forms.get(str(star["player_id"]))
                cnote = None
                if pfm and pfm["games"] >= 3 and float(star["score"]) > pfm["best"]:
                    cnote = "Season high -- previous best %.1f" % pfm["best"]
                pack.playcard(
                    cid, player=star["player_name"],
                    position=star.get("position") or star.get("pos_group") or "",
                    nfl_matchup=(pbox or {}).get("matchup") or (star.get("nfl_team") or ""),
                    score=float(star["score"]), box_line=_box_phrase(pbox),
                    owner=who(star["fid"]), note=cnote,
                    watch_url="https://www.youtube.com/results?search_query=" + "+".join(
                        (star["player_name"] + " week %d %d highlights" % (week, season)).split()))
            card_id = cid

        billing = ((wp or {}).get("w", 0) + (lp or {}).get("w", 0))
        headline = "Game of the week" if i == 1 else None

        pack.game(
            gid, winner=who(hi_fid), loser=who(lo_fid),
            tale=tale, billing=billing, headline=headline, tag=tag,
            card_id=card_id, quote_ids=_claim_quotes(hi_fid, lo_fid),
            fact_ids=sorted(set(gfacts)),
            winner_score=hi_s, loser_score=lo_s, margin=g["margin"],
            winner_best=("%s (%.1f)" % (wb["player_name"], float(wb["score"]))) if wb else None,
            loser_best=("%s (%.1f)" % (lb["player_name"], float(lb["score"]))) if lb else None,
            loser_bench_miss=("%s (%.1f) while %s started for %.1f"
                              % (burn["benched"], burn["benched_score"],
                                 burn["started"], burn["started_score"])) if burn else None,
            loser_ceiling=("%.1f" % ceiling) if ceiling is not None else None,
            divisional=g["divisional"], note=note)
        game_ids.append(gid)

    # ------------------------------------------------------- playoff odds
    # "He is a game back with two to play" is not an answer in a league seeded on
    # all-play percentage. The odds are, and the SWING is the story -- a Sunday
    # that moves a man from probable to cooked is the most interesting number the
    # week produces. Simulated before and after, so the move is real rather than
    # asserted. See wire_data.playoff_odds for the model and its limits.
    odds_now, odds_before, odds_move = {}, {}, {}
    if not is_playoff and week >= 8 and week < D.regular_season_weeks(season):
        odds_now = D.playoff_odds(season, week)
        odds_before = D.playoff_odds(season, week - 1)
        pack.source("Monte Carlo (playoff odds)", asof="%d after wk%d" % (season, week),
                    rows=len(odds_now),
                    note="each remaining week simulated from every franchise's own scoring mean "
                         "and spread, then seeded by canon F.1: four division winners plus the "
                         "best all-play percentages. Fixed seed, so the same week always "
                         "produces the same number")
        pack.warn("Playoff odds are a simulation. Scoring is assumed stable and independent, "
                  "which ignores injuries, byes, trades and anyone who has stopped setting a "
                  "lineup. Treat them as a forecast, not a result.")
        for fid in sorted(odds_now):
            mv = odds_now[fid]["make"] - odds_before.get(fid, {}).get("make", odds_now[fid]["make"])
            odds_move[fid] = mv
            F("f.odds.%s.make" % fid, "%s -- odds of making the playoffs" % who(fid),
              odds_now[fid]["make"], "percent", "Monte Carlo", "after wk%d" % week,
              fmt="%.0f%%" % odds_now[fid]["make"])
        if odds_move:
            up = max(odds_move, key=lambda f: odds_move[f])
            dn = min(odds_move, key=lambda f: odds_move[f])
            if odds_move[up] >= 5:
                F("f.odds.biggest_riser", "%s -- playoff odds gained this week" % who(up),
                  odds_move[up], "percent", "Monte Carlo", "wk%d" % week,
                  fmt="%.0f points" % odds_move[up])
            if odds_move[dn] <= -5:
                F("f.odds.biggest_faller", "%s -- playoff odds lost this week" % who(dn),
                  abs(odds_move[dn]), "percent", "Monte Carlo", "wk%d" % week,
                  fmt="%.0f points" % abs(odds_move[dn]))

    # ------------------------------------------------- season-scope context
    # THE SUPERLATIVE PROBLEM. A weekly pack knows one week, so a writer reaching
    # for a season-wide claim has to guess -- and did, three times: "Whitman
    # scored the fewest points in the league across the season" (Gerardi scored
    # fewer), "a career week" for a score that was not even that owner's best of
    # the year, and "never had a week where the whole thing wobbled" about a man
    # who twice finished 8th of twelve. None of those is a NUMBER, so nothing
    # caught them. The fix is the same as for the ranking bugs: stop making the
    # writer guess. Season totals and each owner's own weekly ordering become
    # facts, and the voice forbids any season-scope claim without a token.
    season_pf = D.d1("SELECT franchise_id, SUM(team_score) AS pf, MAX(team_score) AS hi, "
                     "COUNT(*) AS n FROM src_franchise_weekly_score "
                     "WHERE season = %d AND week <= %d GROUP BY franchise_id"
                     % (season, week))
    pf_by = dict((str(r["franchise_id"]).zfill(4), r) for r in season_pf)
    pf_order = sorted(pf_by, key=lambda f: -float(pf_by[f]["pf"] or 0))
    for rank, fid in enumerate(pf_order, 1):
        F("f.team.%s.season_pf_rank" % fid,
          "%s -- where his season points-for ranks in the league" % who(fid),
          rank, "rank", "src_franchise_weekly_score", "through wk%d" % week,
          fmt=("the most points in the league" if rank == 1 else
               "the fewest points in the league" if rank == len(pf_order) else
               "%s in the league for points" % _ordinal(rank)))

    # Where THIS week sits among that owner's own weeks -- the honest version of
    # "a career week", which a single-season pack can never support.
    own_weeks = {}
    for r in D.d1("SELECT franchise_id, week, team_score FROM src_franchise_weekly_score "
                  "WHERE season = %d AND week <= %d" % (season, week)):
        own_weeks.setdefault(str(r["franchise_id"]).zfill(4), []).append(
            (int(r["week"]), float(r["team_score"])))
    for fid in sorted(own_weeks):
        weeks_sorted = sorted(own_weeks[fid], key=lambda t: -t[1])
        pos = next((i for i, (w_, _s) in enumerate(weeks_sorted, 1) if w_ == week), None)
        if pos:
            F("f.team.%s.week_rank_own" % fid,
              "%s -- where this week ranks among his own weeks this season" % who(fid),
              pos, "rank", "src_franchise_weekly_score", "wk%d" % week,
              fmt=("his best week of the season" if pos == 1 else
                   "his worst week of the season" if pos == len(weeks_sorted) else
                   "his %s-best week of the season" % _ordinal(pos)))

    # ---------------------------------------------------- division picture
    div_order = sorted(set(divs.get(f) or "?" for f in owners))
    for name in div_order:
        pool = [f for f in owners if (divs.get(f) or "?") == name]
        if not pool:
            continue
        pool.sort(key=lambda f: (-h2h_now.get(f, {}).get("pct", 0),
                                 -h2h_now.get(f, {}).get("div_pct", 0),
                                 -ap.get(f, {}).get("w", 0)))
        lead = pool[0]
        F("f.div.%s.leader" % _slug(name), "%s -- leader" % name, who(lead), "text",
          "derived", "wk%d" % week,
          fmt="%s (%s)" % (who(lead), h2h_now.get(lead, {}).get("rec", "")))
    for fid in sorted(owners):
        r = h2h_now.get(fid)
        if r:
            F("f.team.%s.record" % fid, "%s -- record" % who(fid), r["w"], "count",
              "src_schedule", "through wk%d" % week, fmt=r["rec"])
            F("f.team.%s.div_record" % fid, "%s -- division record" % who(fid), r["dw"],
              "count", "src_schedule", "through wk%d" % week, fmt=r["div_rec"])

    # --------------------------------------------------------------- tables
    # NO SCOREBOARD TABLE, and no margin-of-victory chart. Both existed before
    # the deck did; a table listing eighteen results in front of eighteen full
    # game pages is the same information twice, and the chart was a column of
    # bars with an owner's name repeated three times and nothing to compare.
    if multi_opponent:
        pack.warn("Double/triple-header week -- an owner plays two or three opponents at once, "
                  "so the same name appears on more than one game page.")

    if perfs:
        pack.table("t.performers", "Top performances",
                   [{"key": "player", "label": "Player", "type": "text"},
                    {"key": "pos", "label": "Pos", "type": "text"},
                    {"key": "owner", "label": "Started by", "type": "text"},
                    {"key": "score", "label": "Points", "type": "points", "align": "right"}],
                   [[p["player_name"], p.get("position") or p.get("pos_group") or "",
                     who(p["fid"]), float(p["score"])] for p in perfs[:10]])

    if burns:
        # The verdict column is the point of this table. Without it the reader --
        # and the writer -- sees only a point swing and assumes a blunder.
        pack.table("t.burns", "Bench swings, and whether they were mistakes",
                   [{"key": "owner", "label": "Owner", "type": "text"},
                    {"key": "benched", "label": "Benched", "type": "text"},
                    {"key": "bscore", "label": "Scored", "type": "points", "align": "right"},
                    {"key": "started", "label": "Started instead", "type": "text"},
                    {"key": "sscore", "label": "Scored", "type": "points", "align": "right"},
                    {"key": "verdict", "label": "Verdict", "type": "text"}],
                   [[who(f), burns[f]["benched"], burns[f]["benched_score"],
                     burns[f]["started"], burns[f]["started_score"],
                     {"process": "wrong call", "variance": "right call, bad day"}.get(
                         burns[f]["verdict"], "unclear")]
                    for f in sorted(burns, key=lambda f: -burns[f]["diff"])],
                   note="\"Right call, bad day\" means the man who started had the better "
                        "season average going in. That is not a mistake.")

    # ONE standings table, not an all-play table plus a divisions table. The
    # league is seeded on all-play but WON by division, so a reader needs both
    # side by side or neither number means anything.
    std_cols = [{"key": "owner", "label": "Owner", "type": "text"},
                {"key": "div", "label": "Division", "type": "text"},
                {"key": "rec", "label": "Record", "type": "text"},
                {"key": "drec", "label": "Div", "type": "text"},
                {"key": "wk", "label": "This week AP", "type": "text"},
                {"key": "ap", "label": "All-play", "type": "text"},
                {"key": "pf", "label": "Points for", "type": "points", "align": "right"}]
    if odds_now:
        std_cols.append({"key": "odds", "label": "Playoff odds", "type": "text"})
    if is_playoff:
        std_cols.append({"key": "bracket", "label": "Bracket", "type": "text"})

    def _std_row(f):
        r = h2h_now.get(f, {})
        row = [who(f), divs.get(f) or "", r.get("rec", ""), r.get("div_rec", ""),
               ("%d-%d" % (wap[f]["w"], wap[f]["l"])) if f in wap else "",
               "%d-%d" % (ap[f]["w"], ap[f]["l"]), ap[f].get("pf", 0.0)]
        if odds_now:
            o = odds_now.get(f)
            mv = odds_move.get(f, 0.0)
            row.append(("%.0f%%" % o["make"]) + (" (%+.0f)" % mv if abs(mv) >= 1 else "")
                       if o else "")
        if is_playoff:
            row.append((bracket[f]["pool"].title() + (" (alive)" if bracket[f]["alive"] else ""))
                       if f in bracket else "")
        return row

    pack.table("t.standings", "Where everyone stands",
               std_cols, [_std_row(f) for f in ap_order],
               note=("Seeding is by all-play percentage, with the four division winners in "
                     "automatically -- so the Record column is not the seeding order."))

    if is_season_finale and final_place:
        pack.table("t.final", "Final standings",
                   [{"key": "place", "label": "Place", "type": "text"},
                    {"key": "owner", "label": "Owner", "type": "text"}],
                   [[_ordinal(final_place[f]), who(f)]
                    for f in sorted(final_place, key=lambda f: final_place[f])])

    # -------------------------------------------------------------- outline
    star_facts = [k for k in pack._facts if k.startswith("f.star.")]
    burn_facts = [k for k in pack._facts if k.startswith("f.burn.")]
    dnp_facts = [k for k in pack._facts if k.startswith("f.dnp.")]
    team_facts = sorted(k for k in pack._facts if k.startswith("f.team."))
    wire_facts = [k for k in pack._facts if k.startswith("f.wire.")]
    odds_facts = [k for k in pack._facts if k.startswith("f.odds.")]
    div_facts = [k for k in pack._facts if k.startswith("f.div.")]

    # Quotes the game deck did not claim. The deck takes first pick because a
    # quote about two named owners belongs on their page; what is left is
    # general enough for a section.
    spare = list(quote_pool)

    # THREE sections. The earlier five fragmented the week into topic silos --
    # a whole section just for benches -- so nothing built. Now: what happened,
    # the games themselves, and where the league stands.
    pack.section(
        "s1", "The Lead",
        "Open on the state of the league this week, through the people in it. Who tore it up "
        "and who fell apart -- named, with what they actually did. Fold in the week's business: "
        "any waiver pickup that paid off, any trade that mattered, and anyone whose playoff odds "
        "moved hard. This is the section that has to make someone want to read the next one. "
        "Three or four paragraphs, no lists.",
        fact_ids=star_facts + wire_facts + dnp_facts
        + [k for k in pack._facts if k.startswith("f.player.")]
        + [k for k in odds_facts if k in ("f.odds.biggest_riser", "f.odds.biggest_faller")]
        + [k for k in pack._facts if k.endswith(".week_rank_own")]
        + [k for k in ("f.week.perfect", "f.week.winless", "f.week.self_inflicted",
                       "f.week.outgunned") if k in pack._facts],
        table_ids=[t for t in ("t.performers", "t.pickups") if t in pack._tables],
        quote_ids=spare[:2])

    pack.section(
        "s2", "The Games",
        "Place EVERY game and write a note for EVERY ONE of them in gameNotes -- two or three "
        "sentences per matchup, about THAT matchup. One league-wide paragraph in front of "
        "eighteen game pages is a lead, not analysis. Each page already shows its own tale of "
        "the tape, its own big performance and its own chat, so do not recite the numbers; say "
        "what the game meant, who it hurt, and whether the loser had any business winning it. "
        "The deck is ordered so the biggest matchup leads. Open the section with a short "
        "scene-setter about how the slate broke, then let the deck carry it.",
        fact_ids=burn_facts + dnp_facts
        + [k for k in ("f.week.no_process_burns",) if k in pack._facts]
        + [k for k in pack._facts if k.endswith(".could_have_won")]
        + [k for k in pack._facts if k.endswith(".best_available")],
        table_ids=["t.burns"] if "t.burns" in pack._tables else [],
        game_ids=game_ids, quote_ids=spare[2:4])

    landscape_facts = ([k for k in ("f.mo.hot", "f.mo.cold") if k in pack._facts] + div_facts
                       + [k for k in team_facts if k.endswith(".season_pf_rank")])
    if is_season_finale:
        pack.section("s3", "The Landscape",
                     "The season is over. Exact final place for every owner, the champion, the "
                     "last-place finisher, and a verdict on the year.",
                     fact_ids=[k for k in team_facts if k.endswith(".final_place")] + landscape_facts,
                     table_ids=["t.final", "t.standings"], quote_ids=spare[4:])
    elif is_playoff:
        pack.section("s3", "The Landscape",
                     "Where the brackets stand. Who is alive, who is out, who is fighting the "
                     "cellar, and what next week decides.",
                     fact_ids=[k for k in team_facts if k.endswith(".bracket")] + landscape_facts,
                     table_ids=["t.standings"], quote_ids=spare[4:])
    else:
        pack.section("s3", "The Landscape",
                     "The race, told through the two things that decide it: the DIVISIONS, which "
                     "hand out four automatic bids, and ALL-PLAY, which settles every seed after "
                     "that. Name each division's leader and who is close enough to take it. Then "
                     "the playoff odds -- who is safe, who is cooked, and whose Sunday moved the "
                     "number furthest in either direction. Talk about what is still reachable, "
                     "not just what happened.",
                     fact_ids=landscape_facts + odds_facts
                     + [k for k in team_facts if k.endswith(".record")]
                     + [k for k in team_facts if k.endswith(".div_record")],
                     table_ids=["t.standings"], quote_ids=spare[4:])

    return pack
