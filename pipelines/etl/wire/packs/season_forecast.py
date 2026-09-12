#!/usr/bin/env python3
"""The 2026 Season Forecast -- the UPS Wire front page's lead story.

    python pipelines/etl/wire/wire.py build --pack 2026-season-forecast

Keith 2026-09-11: "Front Page should have a blurb like you do followed by
Seasonal Forecast. Show me the Forecast, as well as all the other relevant
numbers...playoff %, title %, projected all play, as a table and a blurb about
the season in general...review the Discord messages to just get the lay of the
land and make it more fun. Bring up funny chats that have happened in discord as
well as the divisional draft."

WHAT IS IN IT
  * The forecast: every team's row from the preseason simulation
    (site/wire/data/season_sim_2026.json) -- power rank, projected all-play and
    wins, and division, playoff, bye and title odds. The same file the twelve
    team reviews quote, so the front page cannot disagree with them.
  * The 2026 Owner Divisional Draft, the league's first: captains in seat order
    and every pick, from team_review_2026.DIVISION_DRAFT_2026 (checked there
    against MFL's divisions on every build).
  * League chat, VERBATIM. Quotes are read from
    site/wire/data/discord_quotes_2026_preseason.json -- curated by hand from
    the league Discord and re-checked against the raw messages -- and placed by
    id; the writer never types one. No file, no quotes: the pack still builds.

Deterministic; no language model. Stdlib + the Wire's own modules.
"""

import io
import json
import statistics
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import wire_data as D                                         # noqa: E402
from wire_pack import Pack                                    # noqa: E402
from team_review_2026 import DIVISION_DRAFT_2026, _division_draft_picker, _fresh_adp_board  # noqa: E402
from lineup_engine import pos_group as LE_pos                  # noqa: E402

SEASON = 2026
PACK_ID = "2026-season-forecast"
SIM_PATH = os.path.join(D.REPO, "site", "wire", "data", "season_sim_%d.json" % SEASON)
QUOTES_PATH = os.path.join(D.REPO, "site", "wire", "data", "discord_quotes_%d_preseason.json" % SEASON)
BACKTEST_PATH = os.path.join(D.REPO, "site", "wire", "data", "forecast_backtest_2021_2025.json")
DRAFT_SRC = "Keith (commissioner), 2026-09-11; checked against MFL's divisions"
DRAFT_DAY = "2026-05-24"


def _pct(x):
    return round(100.0 * float(x), 1)


def build(pack_id=None):
    now = __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    sim = json.load(io.open(SIM_PATH, encoding="utf-8"))
    teams = sorted(sim["teams"], key=lambda t: t["powerRank"])
    if len(teams) != 12:
        raise SystemExit("season_forecast: the sim has %d teams, expected 12" % len(teams))
    lg = (D.worker_get("/api/mfl-export", TYPE="league", JSON=1).get("league") or {})
    div_name = dict((str(d.get("id")), d.get("name"))
                    for d in ((lg.get("divisions") or {}).get("division") or []))
    if not div_name:
        raise SystemExit("season_forecast: MFL's league export has no divisions")
    hist = dict((str(r["franchise_id"]).zfill(4), r) for r in D.d1("SELECT * FROM ups_owner_career_stats"))

    _shape_curve = ((sim.get("seasonShape") or {}).get("byFinish") or [])
    if len(_shape_curve) != 12:
        raise SystemExit("season_forecast: the sim has no seasonShape block -- rerun season_sim.py")

    pack = Pack(PACK_ID, SEASON, title="The %d Season Forecast" % SEASON)
    sim_src = "season_sim.py, %d runs" % sim["runs"]
    pack.source("site/wire/data/season_sim_%d.json -- preseason Monte Carlo over MFL's weekly projections"
                % SEASON, sim["generatedAtUtc"], rows=len(teams),
                note="%d seasons; each team's projected edge kept at %.0f%% (backtested 2021-2025); power "
                     "rank = expected regular-season all-play %%" % (sim["runs"], 100 * sim["model"]["regress"]))
    pack.source("MFL league export (divisions)", now, rows=len(div_name))
    pack.source("D1 ups_owner_career_stats (each owner's documented record)", now, rows=len(hist))

    name = {}
    for t in teams:
        fid = t["franchiseId"]
        okey = "owner:%s" % fid
        pack.owner(okey, (hist.get(fid) or {}).get("owner_display") or t["team"])
        pack.franchise(SEASON, fid, okey, t["team"])
        name[fid] = t["team"]
    for dn in sorted(set(div_name.values())):
        pack.division(dn)

    F = pack.fact
    F("f.league.teams", "Teams in the league", 12, "count", "src_franchises", str(SEASON))
    F("f.league.sim_runs", "Seasons simulated", sim["runs"], "count", sim_src, sim["generatedAtUtc"])
    F("f.league.sim_games", "Regular-season games per team", teams[0]["games"], "count", sim_src, sim["generatedAtUtc"])
    team_ids = []
    for t in teams:
        fid = t["franchiseId"]
        for key, label, v, unit, fmt in (
                ("power_rank", "Preseason power rank", t["powerRank"], "rank", None),
                ("sim_exp_allplay", "Projected regular-season all-play %", _pct(t["expAllPlayPct"]), "percent", None),
                ("sim_exp_wins", "Projected head-to-head wins", round(t["expWins"], 1), "ratio", "%.1f" % t["expWins"]),
                ("sim_p_division", "Division odds", _pct(t["pDivision"]), "percent", None),
                ("sim_p_playoffs", "Playoff odds", _pct(t["pPlayoffs"]), "percent", None),
                ("sim_p_bye", "First-round bye odds", _pct(t["pBye"]), "percent", None),
                ("sim_p_title", "Title odds", _pct(t["pTitle"]), "percent", None),
                ("sim_p_top3", "Share of simulated seasons finishing top three in all-play",
                 _pct(sum(t["apRankDist"][:3])), "percent", None),
                ("sim_p_last", "Share of simulated seasons finishing last in all-play",
                 _pct(t["apRankDist"][-1]), "percent", None)):
            fact_id = "f.team.%s.%s" % (fid, key)
            F(fact_id, "%s: %s" % (label, t["team"]), v, unit, sim_src, sim["generatedAtUtc"], fmt=fmt)
            team_ids.append(fact_id)
        h = hist.get(fid) or {}
        if h:
            fact_id = "f.team.%s.allplay_career" % fid
            F(fact_id, "Career all-play %%: %s" % h.get("owner_display"),
              _pct(h.get("owner_allplay_pct") or 0), "percent", "ups_owner_career_stats", now)
            team_ids.append(fact_id)

    t_forecast = pack.table(
        "t.league.forecast", "The %d forecast" % SEASON,
        [{"key": "rank", "label": "Rank", "type": "count"},
         {"key": "team", "label": "Team", "type": "text"},
         {"key": "owner", "label": "Owner", "type": "text"},
         {"key": "division", "label": "Division", "type": "text"},
         {"key": "ap", "label": "Projected all-play", "type": "percent"},
         {"key": "sim", "label": "The simulation", "type": "percent"},
         {"key": "hi", "label": "In a big year", "type": "percent"},
         {"key": "lo", "label": "In a bad one", "type": "percent"},
         {"key": "wins", "label": "Projected wins", "type": "text"},
         {"key": "div", "label": "Division odds", "type": "percent"},
         {"key": "po", "label": "Playoff odds", "type": "percent"},
         {"key": "bye", "label": "Bye odds", "type": "percent"},
         {"key": "title", "label": "Title odds", "type": "percent"}],
        [[t["powerRank"], t["team"], (hist.get(t["franchiseId"]) or {}).get("owner_display") or "",
          div_name.get(str(t["division"]), str(t["division"])), _pct(t["expAllPlayPct"]),
          _pct(_shape_curve[t["powerRank"] - 1]), _pct(t["apP90"]), _pct(t["apP10"]),
          "%.1f of %d" % (t["expWins"], t["games"]), _pct(t["pDivision"]), _pct(t["pPlayoffs"]),
          _pct(t["pBye"]), _pct(t["pTitle"])] for t in teams],
        note="Projected all-play is the AVERAGE of %d simulated seasons, so it bunches -- good years and bad "
             "years cancel. THE SIMULATION column is what a season finishing in that place actually pays out "
             "across those runs, which is the number to read if a team lands where it is projected; the two "
             "beside it are that team's own best and worst tenth of seasons. Wins are head-to-head out of the "
             "%d-game schedule; odds are the share of seasons in which it happened." % (
                 sim["runs"], teams[0]["games"]))

    # THE SHAPE OF A SEASON. Keith 2026-09-12: "if you look at real life UPS we
    # certainly have more winners coming from a much higher AP ... The playoffs
    # is variance but worth analyzing best allplay in regular season vs playoff
    # finish." So: what all-play actually lands at each finishing place, in the
    # completed seasons and in the simulated ones, and what became of the team
    # that led it.
    _real = D.d1("SELECT s.season, s.franchise_id, s.allplay_regseason_w w, s.allplay_regseason_l l, "
                 "f.final_finish FROM src_standings s JOIN src_final_standings f "
                 "ON f.season = s.season AND f.franchise_id = s.franchise_id "
                 "WHERE s.allplay_regseason_w IS NOT NULL")
    _by_season = {}
    for r in _real:
        tot = (r["w"] or 0) + (r["l"] or 0)
        if tot:
            _by_season.setdefault(r["season"], []).append((r["franchise_id"], r["w"] / float(tot), r["final_finish"]))
    _seasons = [v for v in _by_season.values() if len(v) == 12]
    if len(_seasons) < 10:
        raise SystemExit("season_forecast: only %d complete all-play seasons in D1" % len(_seasons))
    # THE LEADER'S FLOOR IS THE BRACKET'S, NOT HIS. Keith 2026-09-12, on the
    # first draft's "never finished worse than fourth": "This is by design they
    # have a bye for 1st round of playoffs." He is right, and the record is
    # unanimous -- the all-play leader won his division in every completed
    # season, so he took a bye every time, and a bye means your first game is
    # the semi-final. What he EARNED is the title count.
    _div_wins = {}
    for r in _real:
        _div_wins.setdefault(r["season"], {})[r["franchise_id"]] = r
    _real_curve, _leader_finish, _champ_ap_rank, _leader_titles = [], [], [], 0
    for v in _seasons:
        order = sorted(v, key=lambda t: -t[1])
        _real_curve.append([t[1] for t in order])
        _leader_finish.append(order[0][2])
        _leader_titles += 1 if order[0][2] == 1 else 0
        ch = [t for t in v if t[2] == 1]
        if ch:
            _champ_ap_rank.append([i for i, t in enumerate(order, 1) if t[0] == ch[0][0]][0])
    _real_mean = [sum(c[i] for c in _real_curve) / len(_real_curve) for i in range(12)]
    _shape = sim.get("seasonShape") or {}
    _sim_curve = _shape_curve
    _ORD = ["First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth", "Ninth",
            "Tenth", "Eleventh", "Twelfth"]
    t_shape = pack.table(
        "t.league.shape", "What a season actually looks like",
        [{"key": "finish", "label": "Finish in all-play", "type": "text"},
         {"key": "real", "label": "The completed seasons", "type": "percent"},
         {"key": "sim", "label": "The simulation", "type": "percent"}],
        [[_ORD[i], _pct(_real_mean[i]), _pct(_sim_curve[i])] for i in range(12)],
        note="Mean regular-season all-play by where a team finished in it: the %d completed UPS seasons in D1 "
             "against the %d simulated ones. This is the shape the forecast's averages hide -- the team that "
             "leads all-play wins about three quarters of the matchups available and the team that finishes "
             "last wins about a quarter, and no team's AVERAGE ever looks like either." % (len(_seasons), sim["runs"]))
    _top3_real = 100.0 * sum(1 for r in _champ_ap_rank if r <= 3) / len(_champ_ap_rank)
    _top3_sim = 100.0 * sum((_shape.get("champApRank") or [0, 0, 0])[:3])
    SRC_H = "D1 src_standings + src_final_standings"
    F("f.league.shape_first_real", "All-play of the team that led it, on average, in the completed seasons",
      _pct(_real_mean[0]), "percent", SRC_H, now)
    F("f.league.shape_last_real", "All-play of the team that finished last in it, on average",
      _pct(_real_mean[11]), "percent", SRC_H, now)
    F("f.league.shape_first_sim", "All-play of the team that leads it, on average, in the simulation",
      _pct(_sim_curve[0]), "percent", sim_src, sim["generatedAtUtc"])
    F("f.league.champ_top3_real", "Champions who came from the top three in all-play", round(_top3_real, 1),
      "percent", SRC_H, now)
    F("f.league.champ_top3_sim", "Simulated champions who came from the top three in all-play",
      round(_top3_sim, 1), "percent", sim_src, sim["generatedAtUtc"])
    F("f.league.ap_leader_titles", "Seasons the all-play leader went on to win the title",
      _leader_titles, "count", SRC_H, now)
    F("f.league.ap_leader_title_pct", "Share of seasons the all-play leader won the title",
      round(100.0 * _leader_titles / len(_seasons), 1), "percent", SRC_H, now)
    F("f.league.title_odds_even", "A team's share of the title if every season were a coin toss",
      round(100.0 / 12, 1), "percent", "twelve teams", now)
    F("f.league.seasons_measured", "Completed seasons behind those figures", len(_seasons), "count", SRC_H, now)
    _season_shape_ids = ["f.league.shape_first_real", "f.league.shape_last_real", "f.league.shape_first_sim",
                         "f.league.champ_top3_real", "f.league.champ_top3_sim", "f.league.ap_leader_titles",
                         "f.league.ap_leader_title_pct", "f.league.title_odds_even",
                         "f.league.seasons_measured"]

    # The divisional draft, pick by pick.
    dd = DIVISION_DRAFT_2026
    div_of = dict((t["franchiseId"], div_name.get(str(t["division"]), str(t["division"]))) for t in teams)
    for i, pk in enumerate(dd["picks"]):
        if div_of[pk] != div_of[_division_draft_picker(i)]:
            raise SystemExit("season_forecast: divisional-draft pick %d disagrees with MFL's divisions" % (i + 1))
    draft_ids = []
    for seat, cap in enumerate(dd["captains"], 1):
        fact_id = "f.league.div_draft_captain_%s" % cap
        F(fact_id, "Captain's seat in the 2026 Owner Divisional Draft: %s" % name[cap], seat, "rank", DRAFT_SRC, DRAFT_DAY)
        draft_ids.append(fact_id)
    for i, pk in enumerate(dd["picks"]):
        fact_id = "f.league.div_draft_pick_%s" % pk
        F(fact_id, "Overall pick in the 2026 Owner Divisional Draft: %s" % name[pk], i + 1, "rank", DRAFT_SRC, DRAFT_DAY)
        draft_ids.append(fact_id)
    t_captains = pack.table(
        "t.league.captains", "The four captains",
        [{"key": "seat", "label": "Seat", "type": "count"},
         {"key": "team", "label": "Captain", "type": "text"},
         {"key": "owner", "label": "Owner", "type": "text"},
         {"key": "ap", "label": "Career all-play", "type": "percent"},
         {"key": "division", "label": "Division", "type": "text"}],
        [[seat, name[cap], (hist.get(cap) or {}).get("owner_display") or "",
          _pct((hist.get(cap) or {}).get("owner_allplay_pct") or 0), div_of[cap]]
         for seat, cap in enumerate(dd["captains"], 1)],
        note="Seat order as the draft was run. The career all-play beside each captain is his own documented record; the printed seats do not descend by it, so the seeding rule is not asserted here.")
    t_draft = pack.table(
        "t.league.division_draft", "The 2026 Owner Divisional Draft",
        [{"key": "pick", "label": "Pick", "type": "count"},
         {"key": "round", "label": "Round", "type": "count"},
         {"key": "captain", "label": "Captain", "type": "text"},
         {"key": "took", "label": "Took", "type": "text"},
         {"key": "division", "label": "Division", "type": "text"}],
        [[i + 1, 1 if i < len(dd["captains"]) else 2, name[_division_draft_picker(i)], name[pk], div_of[pk]]
         for i, pk in enumerate(dd["picks"])],
        note="A two-round snake at the rookie draft: seats one to four, then four to one. 2026 is year one "
             "of the three-year alignment.")

    # ---- THE LEAGUE FROM THE ROSTER SIDE (Keith 2026-09-12: "more of the
    # overall league feel much like each team just at a macro level ... build a
    # table to show rankings by starters at each position"). Every figure is
    # read from the twelve team packs, which must be built first -- this pack
    # never recomputes a team's numbers, so the front page cannot disagree with
    # the review it links to.
    PACKS_DIR = os.path.join(D.REPO, "site", "wire", "packs", str(SEASON))
    tp = {}
    for fid in sorted(name):
        path = os.path.join(PACKS_DIR, "%d-team-%s.pack.json" % (SEASON, fid))
        if not os.path.exists(path):
            raise SystemExit("season_forecast: %s is missing -- build the twelve team packs first" % path)
        d = json.load(io.open(path, encoding="utf-8"))
        pre = "f.team.%s." % fid
        tp[fid] = dict((f["id"][len(pre):], f["value"]) for f in d["facts"] if f["id"].startswith(pre))
    _need = ("lineup_value_opening", "lineup_value_preauction", "lineup_value_postauction",
             "lineup_value_current", "auction_spend", "faa_spend", "faa_lots_won",
             "slot_off_rank", "slot_def_rank", "slot_sf_rank", "slot_of_rank", "slot_df_rank")
    for fid, f in tp.items():
        miss = [k for k in _need if k not in f]
        if miss:
            raise SystemExit("season_forecast: team pack %s lacks %s -- rebuild the twelve packs" % (fid, ", ".join(miss)))
    pack.source("the twelve %d team-review packs (starters, money and lineup value)" % SEASON, now, rows=len(tp))

    _n = lambda fid, k, dflt=0: tp[fid].get(k, dflt) or 0
    L = lambda k: sum(_n(fid, k) for fid in tp)
    _order = [t["franchiseId"] for t in teams]          # power rank order

    def _ratio(vals):
        lo = min(v for v in vals if v)
        return round(max(vals) / float(lo), 2) if lo else 0

    FS = "the twelve team packs"
    F("f.league.auction_spend", "Spent across both auctions, league-wide", L("auction_spend"), "usd", FS, now)
    F("f.league.auction_lots", "Players bought at the two auctions", L("faa_lots_won") + L("era_lots_won"),
      "count", FS, now)
    F("f.league.faa_spend", "Spent at the Free Agent Auction, league-wide", L("faa_spend"), "usd", FS, now)
    F("f.league.faa_top_price", "The highest price paid at the Free Agent Auction",
      max(_n(fid, "top_buy_price") for fid in tp), "usd", FS, now)
    F("f.league.lineup_value_opening", "Starting-lineup value in April, league-wide", L("lineup_value_opening"),
      "count", FS, now)
    F("f.league.lineup_value_preauction", "Starting-lineup value at the auction lock, league-wide",
      L("lineup_value_preauction"), "count", FS, now)
    F("f.league.lineup_value_postauction", "Starting-lineup value at the auction close, league-wide",
      L("lineup_value_postauction"), "count", FS, now)
    F("f.league.lineup_value_current", "Starting-lineup value now, league-wide", L("lineup_value_current"),
      "count", FS, now)
    _gap_open = _ratio([_n(fid, "lineup_value_opening") for fid in tp])
    _gap_now = _ratio([_n(fid, "lineup_value_current") for fid in tp])
    F("f.league.value_gap_opening", "Best starting lineup against the worst, in April", _gap_open,
      "ratio", FS, now, fmt="%.2fx" % _gap_open)
    F("f.league.value_gap_current", "Best starting lineup against the worst, now", _gap_now,
      "ratio", FS, now, fmt="%.2fx" % _gap_now)
    F("f.league.holes_opening", "Holes in the twelve lineups in April", L("holes_opening"), "count", FS, now)
    F("f.league.holes_today", "Holes in the twelve lineups now", L("holes_today"), "count", FS, now)
    F("f.league.studs_today", "Top-twelve starters across the league now", L("studs_today"), "count", FS, now)
    F("f.league.no_lineup_opening", "Teams that could not field a legal lineup in April",
      sum(1 for fid in tp if str(tp[fid].get("can_field_lineup_opening")).lower() == "no"), "count", FS, now)
    F("f.league.cap_committed", "Salary committed across the league", L("cap_current_spent"), "usd", FS, now)
    F("f.league.cap_room", "Cap room left across the league", L("cap_current_room"), "usd", FS, now)
    F("f.league.pickups", "Waiver and free-agent pickups since the auction closed",
      L("pickups_s1") + L("pickups_s2") + L("pickups_s3"), "count", FS, now)
    F("f.league.rookie_picks", "Rookie picks made", L("rookie_picks_count"), "count", FS, now)
    F("f.league.injured_starters", "Starters the forecast holds out of week one", L("injured_starters"), "count", FS, now)

    # THE POSITIONAL BOARDS -- every starting SLOT, ranked league-wide, split
    # offense from defense (Keith 2026-09-12: "Can we see teams Split offense vs
    # Defense as well? I would also want to see offense flex ranking and
    # defensive Flex ... because it normalizes the rankings"). Slot by slot, so
    # every team is compared on the same number of places and no man is counted
    # twice.
    OFF_UNITS = [("off", "Offense"), ("qb", "QB"), ("sf", "SF"), ("rb", "RB"), ("wr", "WR"),
                 ("te", "TE"), ("of", "Flex")]
    DEF_UNITS = [("def", "Defense"), ("dl", "DL"), ("lb", "LB"), ("db", "DB"), ("df", "Flex"),
                 ("pk", "K"), ("pn", "P")]

    def _board(tid, title, units, note):
        return pack.table(
            tid, title,
            [{"key": "rank", "label": "Pwr", "type": "count"}, {"key": "team", "label": "Team", "type": "text"}]
            + [{"key": k, "label": lab, "type": "count"} for k, lab in units],
            [[tp[fid].get("power_rank"), name[fid]] + [tp[fid].get("slot_%s_rank" % k) for k, _ in units]
             for fid in _order],
            note=note)

    t_offense = _board(
        "t.league.offense_board", "Offense, slot by slot",
        OFF_UNITS,
        "1 is best. Each column ranks what a team STARTS in those slots, by its players' value on the live "
        "redraft board: one quarterback slot, the superflex, two running backs, two receivers, a tight end "
        "and the two flexes. Offense is all nine of them together. Ranking by slot rather than by position "
        "keeps the comparison even -- a team is measured on the same places as everyone else, and a "
        "quarterback in the superflex is counted once.")
    t_defense = _board(
        "t.league.defense_board", "Defense and the specialists, slot by slot",
        DEF_UNITS,
        "1 is best, on MFL's own 2026 season projections (weeks 1-17), the only value source for defenders, "
        "kickers and punters: two defensive line slots, two linebackers, two defensive backs and the "
        "defensive flex, with the kicker and the punter beside them. Defense is the seven defensive slots "
        "together. A starter MFL does not project adds nothing to his team's total -- unprojected is "
        "unranked, never zero.")

    # THE FOUR PHASES, league-wide -- the same spine as a team review.
    t_phases = pack.table(
        "t.league.phases", "What each lineup was worth, phase by phase",
        [{"key": "team", "label": "Team", "type": "text"},
         {"key": "april", "label": "April", "type": "count"},
         {"key": "lock", "label": "At the lock", "type": "count"},
         {"key": "close", "label": "At the close", "type": "count"},
         {"key": "now", "label": "Now", "type": "count"},
         {"key": "spend", "label": "Spent at auction", "type": "usd"},
         {"key": "change", "label": "April to now", "type": "count"}],
        [[name[fid], _n(fid, "lineup_value_opening"), _n(fid, "lineup_value_preauction"),
          _n(fid, "lineup_value_postauction"), _n(fid, "lineup_value_current"), _n(fid, "auction_spend"),
          _n(fid, "lineup_value_current") - _n(fid, "lineup_value_opening")] for fid in _order],
        note="VALUE is one number for a starting lineup: every offensive starter priced at his current "
             "redraft-superflex market value on the live ADP board, added up. It is a market price, not a "
             "points projection -- the forecast runs on MFL's own weekly projections instead, which is why a "
             "team can rank higher here than it does there. The redraft value of the best legal lineup each "
             "roster could field on 2026-04-21, at the auction "
             "roster lock (07-23), at the close (08-05) and today. Six teams could not field a legal lineup in "
             "April and five could not at the lock: those columns are the optimizer filling slots with whoever "
             "was on hand, never the owner's lineup. Spend is both auctions.")

    # WHERE A TEAM'S POINTS COME FROM, and where help is still free. Keith
    # 2026-09-12, challenging Cleon Ca$h at 8th with the third-best offense:
    # "This tells me something is wrong with the forecast because defense isn't
    # that big of a factor based on your prior analysis" -- and then: "advise
    # that the WW is most fruitful at IDP during the season and there is an
    # opportunity to improve in this facet easier than offense." Both belong in
    # the paper, and both are measurable.
    t_points = pack.table(
        "t.league.points", "Where the points come from",
        [{"key": "rank", "label": "Pwr", "type": "count"},
         {"key": "team", "label": "Team", "type": "text"},
         {"key": "off", "label": "Offense a week", "type": "text"},
         {"key": "def", "label": "Defense a week", "type": "text"},
         {"key": "kp", "label": "Kicker and punter", "type": "text"},
         {"key": "tot", "label": "Projected a week", "type": "text"}],
        [[t["powerRank"], t["team"], "%.1f" % t["projWeeklyOffense"], "%.1f" % t["projWeeklyDefense"],
          "%.1f" % t["projWeeklyKicking"], "%.1f" % t["projWeekly"]] for t in teams],
        note="MFL's own weekly projections for the best legal lineup each roster can field, split by the "
             "slots that produce them: nine offensive, seven defensive, a kicker and a punter. This is the "
             "currency the forecast runs on, and it is not the same as the redraft-market value the lineup "
             "tables use -- a team can rank higher on one than the other.")

    _last_snap = D.snapshot_dates()[-1]
    _owned = set()
    for _fr in D.snapshot(_last_snap, "rosters")["rosters"]["franchise"]:
        _pl = _fr.get("player") or []
        if isinstance(_pl, dict):
            _pl = [_pl]
        for _p in _pl:
            _owned.add(str(_p.get("id")))
    _rsf, _bname, _brank, _bconf = _fresh_adp_board()
    _pos_of = dict((str(r["player_id"]), str(r["position"] or "")) for r in
                   D.d1("SELECT player_id, position FROM src_players"))
    _proj = (sim.get("seasonProjections") or {}).get("players") or {}

    def _best(pos):
        """The position's players, best first: offense on the redraft board,
        everyone else on MFL's season projection."""
        if pos in ("QB", "RB", "WR", "TE"):
            xs = [(r, p) for p, r in _brank.items() if LE_pos(_pos_of.get(str(p), "")) == pos]
            return [p for _, p in sorted(xs)]
        xs = [(-v["seasonProj"], p) for p, v in _proj.items() if v.get("pos") == pos]
        return [p for _, p in sorted(xs)]

    _free_rows, _free = [], {}
    for _pos, _label in (("QB", "Quarterback"), ("RB", "Running back"), ("WR", "Receiver"),
                         ("TE", "Tight end"), ("DL", "Defensive line"), ("LB", "Linebacker"),
                         ("DB", "Defensive back"), ("PK", "Kicker"), ("PN", "Punter")):
        ranked = _best(_pos)
        if not ranked:
            continue
        top12 = sum(1 for p in ranked[:12] if str(p) not in _owned)
        top24 = sum(1 for p in ranked[:24] if str(p) not in _owned)
        _free[_pos] = (top12, top24)
        _free_rows.append([_label, top12, top24])
    t_free = pack.table(
        "t.league.free", "Where help is still free",
        [{"key": "pos", "label": "Position", "type": "text"},
         {"key": "top12", "label": "Unowned, of the best twelve", "type": "count"},
         {"key": "top24", "label": "Unowned, of the best twenty-four", "type": "count"}],
        _free_rows,
        note="Players nobody rosters as of %s, counted among the best at each position: offense by the live "
             "redraft board, defenders, kickers and punters by MFL's 2026 season projection. Twelve teams "
             "start two defensive backs each, so the top twenty-four is roughly the league's demand." % _last_snap)
    F("f.league.free_db", "Unowned among the twelve best projected defensive backs", _free.get("DB", (0, 0))[0],
      "count", "MFL rosters + season projections", now)
    F("f.league.free_kickers", "Unowned among the twelve best projected kickers", _free.get("PK", (0, 0))[0],
      "count", "MFL rosters + season projections", now)
    F("f.league.free_punters", "Unowned among the twelve best projected punters", _free.get("PN", (0, 0))[0],
      "count", "MFL rosters + season projections", now)
    F("f.league.free_offense", "Unowned among the twenty-four best at each offensive position, all four added",
      sum(_free.get(p, (0, 0))[1] for p in ("QB", "RB", "WR", "TE")), "count",
      "MFL rosters + live redraft board", now)

    # WHAT IT COMMITTED AGAINST WHAT IT GOT. Keith 2026-09-12: "How about we look
    # at this as Teams represented: X% of the salary in April and y% of the value
    # ... I had 100K committed at start (33%) but my value was 22% ... Is the
    # league getting better via the auction? Yes, but it obviously cost more to do
    # so ... those that have the best value coming can be more selective with
    # their auction spending." Shares normalise it: a team holding more of the
    # league's value than of its payroll is getting more for its money.
    _sal_open = float(L("cap_opening")) or 1.0
    _val_open = float(L("lineup_value_opening")) or 1.0
    _sal_now = float(L("cap_current_spent")) or 1.0
    _val_now = float(L("lineup_value_current")) or 1.0
    _spend_tot = float(L("auction_spend")) or 1.0

    def _share(v, tot):
        return round(100.0 * v / tot, 1)

    def _idx(val, val_tot, sal, sal_tot):
        vs, ss = val / val_tot, sal / sal_tot
        return "%.2fx" % (vs / ss) if ss else "--"

    t_shares = pack.table(
        "t.league.shares", "What each owner committed, and what he got for it",
        [{"key": "team", "label": "Team", "type": "text"},
         {"key": "sal_apr", "label": "Share of April salary", "type": "percent"},
         {"key": "val_apr", "label": "Share of April value", "type": "percent"},
         {"key": "idx_apr", "label": "April, value per dollar", "type": "text"},
         {"key": "spend", "label": "Share of auction money", "type": "percent"},
         {"key": "sal_now", "label": "Share of salary now", "type": "percent"},
         {"key": "val_now", "label": "Share of value now", "type": "percent"},
         {"key": "idx_now", "label": "Now, value per dollar", "type": "text"}],
        [[name[fid],
          _share(_n(fid, "cap_opening"), _sal_open), _share(_n(fid, "lineup_value_opening"), _val_open),
          _idx(_n(fid, "lineup_value_opening"), _val_open, _n(fid, "cap_opening"), _sal_open),
          _share(_n(fid, "auction_spend"), _spend_tot),
          _share(_n(fid, "cap_current_spent"), _sal_now), _share(_n(fid, "lineup_value_current"), _val_now),
          _idx(_n(fid, "lineup_value_current"), _val_now, _n(fid, "cap_current_spent"), _sal_now)]
         for fid in _order],
        note="Every share column is this team's slice of the twelve-team total, so each adds to a hundred per "
             "cent. Value per dollar is his slice of the league's lineup value divided by his slice of its "
             "salary: above 1.00x he holds more of the league's talent than he pays for, below it he pays for "
             "more than he has. April salary is active-roster salary; the figure for now is cap committed, "
             "which includes salary adjustments.")
    F("f.league.cap_opening", "Active-roster salary across the league in April", int(_sal_open), "usd", FS, now)

    # DIVISION STRENGTH.
    div_of = dict((t["franchiseId"], div_name.get(str(t["division"]), str(t["division"]))) for t in teams)
    dsum = {}
    for t in teams:
        fid, dn = t["franchiseId"], div_of[t["franchiseId"]]
        d = dsum.setdefault(dn, {"fids": [], "ap": 0.0, "po": 0.0, "title": 0.0, "faa": 0, "idp": 0.0, "holes": 0})
        d["fids"].append(fid)
        d["ap"] += t["expAllPlayPct"]
        d["po"] += t["pPlayoffs"]
        d["title"] += t["pTitle"]
        d["faa"] += _n(fid, "faa_spend")
        d["idp"] += _n(fid, "slot_dl_value") + _n(fid, "slot_lb_value") + _n(fid, "slot_db_value") + _n(fid, "slot_df_value")
        d["holes"] += _n(fid, "holes_today")
    dord = sorted(dsum, key=lambda dn: -dsum[dn]["ap"])
    for dn in dord:
        d = dsum[dn]
        key = "".join(ch for ch in dn.lower() if ch.isalnum())[:16]
        F("f.league.div_%s_allplay" % key, "%s: mean projected all-play" % dn,
          round(100.0 * d["ap"] / len(d["fids"]), 1), "percent", sim_src, sim["generatedAtUtc"])
        F("f.league.div_%s_playoff_spots" % key, "%s: expected playoff spots of the six" % dn,
          round(d["po"], 2), "ratio", sim_src, sim["generatedAtUtc"], fmt="%.2f" % d["po"])
        F("f.league.div_%s_title" % key, "%s: combined title odds" % dn, _pct(d["title"]), "percent",
          sim_src, sim["generatedAtUtc"])
    t_divisions = pack.table(
        "t.league.divisions", "The four divisions, strongest to weakest",
        [{"key": "division", "label": "Division", "type": "text"},
         {"key": "teams", "label": "Teams, by power rank", "type": "text"},
         {"key": "ap", "label": "Mean projected all-play", "type": "percent"},
         {"key": "spots", "label": "Expected playoff spots", "type": "text"},
         {"key": "title", "label": "Combined title odds", "type": "percent"},
         {"key": "spread", "label": "All-play, best to worst", "type": "text"},
         {"key": "idp", "label": "Defensive starters projected", "type": "count"},
         {"key": "faa", "label": "Spent at the auction", "type": "usd"}],
        [[dn, ", ".join("%s (%s)" % (name[f2], tp[f2].get("power_rank")) for f2 in
                        sorted(dsum[dn]["fids"], key=lambda f2: tp[f2].get("power_rank") or 99)),
          round(100.0 * dsum[dn]["ap"] / len(dsum[dn]["fids"]), 1),
          "%.2f of 6" % dsum[dn]["po"], _pct(dsum[dn]["title"]),
          "%.1f%% to %.1f%%" % (100.0 * max(t["expAllPlayPct"] for t in teams if div_of[t["franchiseId"]] == dn),
                                100.0 * min(t["expAllPlayPct"] for t in teams if div_of[t["franchiseId"]] == dn)),
          round(dsum[dn]["idp"], 1), dsum[dn]["faa"]] for dn in dord],
        note="Ordered by the mean of its three teams' projected all-play. Expected playoff spots sum each "
             "team's playoff odds; the six add up across the league. Defensive starters are the projected "
             "season points of the seven defenders each team starts, added across the division. All-play is a "
             "projected percentage, not "
             "points per game. Divisions are year one of a three-year alignment the owners drafted themselves.")

    # THE APPENDIX: HOW THE FORECAST IS CALCULATED, AND HOW IT WOULD HAVE DONE.
    # Keith 2026-09-12: "build a 'Projection: Calculation Source' as an appendix
    # essentially. Simulations are based off projected points ... breakdown the
    # historical projections vs. historical finish." Every figure comes from the
    # backtest file, which replays 2021-2025 through season_sim.py itself.
    if not os.path.exists(BACKTEST_PATH):
        raise SystemExit("season_forecast: %s is missing -- the appendix has no source" % BACKTEST_PATH)
    bt = json.load(io.open(BACKTEST_PATH, encoding="utf-8"))
    pack.source("site/wire/data/forecast_backtest_2021_2025.json -- 2021-2025 replayed through season_sim.py "
                "from cached MFL exports", bt["generatedAtUtc"], rows=len(bt["teams"]), note=bt["method"])
    BT = "forecast backtest 2021-2025"
    _bsum = bt["summary"]
    F("f.league.sim_regress", "Share of each team's projected edge the forecast keeps", round(100 * sim["model"]["regress"]),
      "percent", sim_src, sim["generatedAtUtc"])
    F("f.league.sim_shock", "Season-long luck, one standard deviation, in points a week",
      round(sim["model"]["sigmaSeason"], 1), "ratio", sim_src, sim["generatedAtUtc"],
      fmt="%.1f" % sim["model"]["sigmaSeason"])
    F("f.league.bt_team_seasons", "Team-seasons in the backtest", _bsum["team_seasons"], "count", BT, bt["generatedAtUtc"])
    F("f.league.bt_r2", "Share of the spread in final all-play the backtest explained", _bsum["r_squared_pct"],
      "percent", BT, bt["generatedAtUtc"])
    F("f.league.bt_rmse", "Typical miss in all-play points, backtest", _bsum["rmse_allplay_pts_k07"], "ratio", BT,
      bt["generatedAtUtc"], fmt="%.1f" % _bsum["rmse_allplay_pts_k07"])
    F("f.league.bt_rmse_500", "Typical miss in all-play points calling every team .500", _bsum["rmse_everyone_500_pts"],
      "ratio", BT, bt["generatedAtUtc"], fmt="%.1f" % _bsum["rmse_everyone_500_pts"])
    # Inside means inside AS PRINTED: CBP 2025 finished exactly on its printed
    # bad-year edge, and a reader counting the table must get the same number.
    _inside = sum(1 for x in bt["teams"]
                  if round(x["band_lo"], 1) <= round(x["actual_allplay"], 1) <= round(x["band_hi"], 1))
    F("f.league.bt_inside_band", "Team-seasons that finished inside their own big-year to bad-year range, edges "
      "included as printed", _inside, "count", BT, bt["generatedAtUtc"])
    for _row in bt["seasons"]:
        F("f.league.bt_rho_%d" % _row["season"], "Rank correlation, projection against finish, %d" % _row["season"],
          _row["rank_corr"], "ratio", BT, bt["generatedAtUtc"], fmt="%.2f" % _row["rank_corr"])
    # LIKE FOR LIKE. The backtest file measured each season twice: on week-one
    # projections carried all season ("preseason") and on MFL's archived
    # week-of projections ("weekly", which already knew each week's news). The
    # first appendix compared this year's weekly spread with the tested
    # PRESEASON rows, and the table under it contradicted the text. This year's
    # published row is also read from the simulation actually published, not
    # from the backtest file, which was written before the last rerun.
    _sd_now = statistics.pstdev([100 * t["expAllPlayPct"] for t in sim["teams"]])
    _tested = [x for x in bt["spread"] if x["season"] != "2026"]
    _pre_now = [x for x in bt["spread"] if x["season"] == "2026" and x["basis"] == "preseason"]
    if not _pre_now:
        raise SystemExit("season_forecast: backtest file has no 2026 preseason spread row")
    for _basis, _key in (("preseason", "pre"), ("weekly", "weekly")):
        _rows = [x for x in _tested if x["basis"] == _basis]
        F("f.league.bt_sd_low_%s" % _key, "Smallest spread of projected all-play in a tested season (%s)" % _basis,
          min(x["sd_projected_allplay"] for x in _rows), "ratio", BT, bt["generatedAtUtc"],
          fmt="%.1f" % min(x["sd_projected_allplay"] for x in _rows))
        F("f.league.bt_shock_high_%s" % _key, "Largest season-long luck fitted in a tested season (%s)" % _basis,
          max(x["season_shock"] for x in _rows), "ratio", BT, bt["generatedAtUtc"],
          fmt="%.1f" % max(x["season_shock"] for x in _rows))
    F("f.league.bt_sd_now_pre", "Spread of projected all-play this year on week-one projections",
      _pre_now[0]["sd_projected_allplay"], "ratio", BT, bt["generatedAtUtc"], fmt="%.1f" % _pre_now[0]["sd_projected_allplay"])
    F("f.league.bt_sd_now", "Spread of projected all-play in this year's published forecast", round(_sd_now, 2),
      "ratio", sim_src, sim["generatedAtUtc"], fmt="%.1f" % _sd_now)
    _bt_ids = [f for f in pack._facts if f.startswith("f.league.bt_")] + ["f.league.sim_regress", "f.league.sim_shock"]

    t_bt_seasons = pack.table(
        "t.league.bt_seasons", "How the forecast would have done, season by season",
        [{"key": "season", "label": "Season", "type": "text"},
         {"key": "rho", "label": "Order it got right", "type": "text"},
         {"key": "off", "label": "Places off, per team", "type": "text"},
         {"key": "miss", "label": "Typical miss", "type": "text"},
         {"key": "miss500", "label": "Miss if everyone .500", "type": "text"},
         {"key": "top6", "label": "Projected top six who made the playoffs", "type": "text"},
         {"key": "champ", "label": "The champion", "type": "text"}],
        [[str(x["season"]), "%.2f" % x["rank_corr"], "%.1f" % x["avg_places_off"], "%.1f" % x["rmse_pts"],
          "%.1f" % x["rmse_500_pts"], "%d of 6" % x["proj_top6_made_playoffs"], x["champion"]] for x in bt["seasons"]],
        note="Order it got right is the rank correlation between projected and actual all-play: 1.00 is the exact "
             "order, 0 is no relation. Places off is how far the average team finished from its projected rank. "
             "Misses are in all-play percentage points; the last column is how badly you would do by calling "
             "every team .500.")
    t_bt_dial = pack.table(
        "t.league.bt_dial", "How much of the projection to trust",
        [{"key": "k", "label": "Share of each team's edge kept", "type": "text"},
         {"key": "miss", "label": "Typical miss", "type": "text"},
         {"key": "slope", "label": "Real gap per projected gap", "type": "text"},
         {"key": "rho", "label": "Order it got right", "type": "text"}],
        [["%d%%" % round(100 * x["k"]), "%.1f" % x["rmse_pts"], "%.2f" % x["slope"], "%.2f" % x["mean_rank_corr"]]
         for x in bt["dial"]],
        note="The forecast trims every team's projected edge over the league before simulating. Kept whole, the "
             "projected gaps between teams came out too big -- real gaps were only about two thirds of them. "
             "At the chosen setting the projected gaps matched the real ones almost exactly, and the typical miss "
             "was at its smallest.")
    t_bt_calib = pack.table(
        "t.league.bt_calibration", "Were the playoff odds honest?",
        [{"key": "group", "label": "Playoff odds it gave", "type": "text"},
         {"key": "n", "label": "Team-seasons", "type": "count"},
         {"key": "avg", "label": "Average odds given", "type": "text"},
         {"key": "made", "label": "How many made it", "type": "text"}],
        [[x["group"].replace("playoff odds ", "").capitalize(), x["team_seasons"], x["average_forecast"], x["actual"]]
         for x in bt["calibration"]],
        note="Teams grouped by the playoff odds the forecast gave them before the season, against how many "
             "actually made the six-team bracket.")
    t_bt_teams = pack.table(
        "t.league.bt_teams", "Every team, projection against finish, 2021-2025",
        [{"key": "season", "label": "Season", "type": "text"},
         {"key": "team", "label": "Team (owner then)", "type": "text"},
         {"key": "proj_rank", "label": "Projected", "type": "count"},
         {"key": "proj", "label": "Projected all-play", "type": "percent"},
         {"key": "band", "label": "Big year to bad year", "type": "text"},
         {"key": "actual", "label": "Actual all-play", "type": "percent"},
         {"key": "rank", "label": "Finished", "type": "text"},
         {"key": "places", "label": "Places", "type": "text"},
         {"key": "final", "label": "Final finish", "type": "count"}],
        [[str(x["season"]), "%s (%s)" % (x["team"], x["owner"]), x["proj_rank"], x["proj_allplay"],
          "%.1f%% to %.1f%%" % (x["band_hi"], x["band_lo"]), x["actual_allplay"], x["actual_rank"],
          x["places"], x["final_finish"]] for x in bt["teams"]],
        note="One row per team-season, team and owner as they were that year. Projected is the preseason rank; "
             "Finished is the actual all-play rank (T means tied). Places is projected rank minus finish, so a "
             "plus sign means the team beat its projection. Final finish is where the season ended, "
             "one through six being the playoff bracket.")
    _BASIS_LABEL = {"preseason": "Week-one projections, all season",
                    "weekly": "Each week's own projections, made that week"}
    t_bt_spread = pack.table(
        "t.league.bt_spread", "Why this year is harder to call",
        [{"key": "season", "label": "Season", "type": "text"},
         {"key": "basis", "label": "Projections used", "type": "text"},
         {"key": "sd", "label": "Spread of projected all-play", "type": "text"},
         {"key": "shock", "label": "Season luck needed", "type": "text"}],
        [[x["season"], _BASIS_LABEL[x["basis"]], "%.1f" % x["sd_projected_allplay"], "%.1f" % x["season_shock"]]
         for x in bt["spread"] if x["season"] != "2026"]
        + [["2026", _BASIS_LABEL["preseason"], "%.1f" % _pre_now[0]["sd_projected_allplay"],
            "%.1f" % _pre_now[0]["season_shock"]],
           ["2026", "This forecast: this week's projections for every week, injuries held out",
            "%.1f" % _sd_now, "%.1f" % sim["model"]["sigmaSeason"]]],
        note="How far apart the twelve teams project (a standard deviation of projected all-play), and how much "
             "season-long luck the model has to add for the finish to spread out like a real UPS season. The "
             "flatter the projections, the more of the forecast is luck.")

    # League chat, verbatim, from the hand-curated file.
    quote_ids = []
    if os.path.exists(QUOTES_PATH):
        qs = json.load(io.open(QUOTES_PATH, encoding="utf-8"))
        for q in qs.get("quotes") or []:
            quote_ids.append(pack.quote(q["id"], q["text"], q["author"], q.get("when"),
                                        owner_key=("owner:%s" % q["fid"]) if q.get("fid") else None,
                                        context=q.get("context"), source="discord"))
        pack.source("site/wire/data/discord_quotes_%d_preseason.json -- league Discord, curated by hand, each "
                    "quote re-checked against the raw message" % SEASON, qs.get("asof") or now, rows=len(quote_ids))
    else:
        pack.warn("No curated Discord quotes file (%s): the chat section has nothing to quote -- do not "
                  "paraphrase anyone." % os.path.relpath(QUOTES_PATH, D.REPO))

    pack.warn("The forecast simulates today's rosters on MFL's weekly projections, with each team's edge pulled "
              "back toward the league average. Replayed on 2021-2025 it explained about 40% of the spread in "
              "final all-play, but its rank correlation was only .31 to .42 in each of the last three seasons, "
              "and this year's projections are flatter than any season it was tested on. It cannot see trades, "
              "waiver moves, injuries after the build or lineup choices, and future injuries appear only as "
              "random noise.")
    pack.coverage = {"seasonsComplete": [2010, 2025], "currentSeason": SEASON, "currentSeasonPartial": True}

    _lg = lambda *keys: ["f.league.%s" % k for k in keys]
    _div_ids = [f for f in pack._facts if f.startswith("f.league.div_") and "draft" not in f]
    _money_ids = _lg("auction_spend", "auction_lots", "faa_spend", "faa_top_price", "cap_committed", "cap_room")
    _value_ids = _lg("lineup_value_opening", "lineup_value_preauction", "lineup_value_postauction",
                     "lineup_value_current", "value_gap_opening", "value_gap_current")
    _shape_ids = _lg("teams", "sim_runs", "sim_games", "holes_opening", "holes_today", "studs_today",
                     "no_lineup_opening", "pickups", "rookie_picks", "injured_starters")

    pack.section(
        "s1", "The Board",
        "The opener, and it has to stand on its own: where the twelve teams sit in the simulation, the shape "
        "of the table (who is clear, where the pack is, who is adrift), the handful of offseason moves that "
        "actually changed a contender, and which teams own which positions. Then the forecast table and the "
        "positional board. Say 'projected' and 'odds', never 'will'; read each position column against itself.",
        fact_ids=team_ids + _shape_ids + _money_ids + _value_ids + _season_shape_ids,
        table_ids=[t_forecast, t_offense, t_defense, t_shape], quote_ids=quote_ids)
    pack.section(
        "s2", "April: What Twelve Teams Had",
        "The league before anyone did anything, the same way a team review opens. How many teams could not "
        "even field a legal lineup, how far apart the best and worst rosters were, where the holes were, and "
        "the one or two spring trades that mattered league-wide. Where a team could not field a lineup there "
        "was no lineup: those figures are the optimizer filling slots, never an owner's choice.",
        fact_ids=_value_ids + _shape_ids, quote_ids=quote_ids)
    pack.section(
        "s3", "The Draft and the Tags",
        "Late May: the rookie draft, the tags, and the league's first Owner Divisional Draft -- the four "
        "captains, the snake, who went first and what the room made of it. This is year one of a three-year "
        "alignment, which is why the divisions are worth an argument. Place the league's own chat by id.",
        fact_ids=draft_ids + _lg("rookie_picks"), table_ids=[t_captains, t_draft], quote_ids=quote_ids)
    pack.section(
        "s4", "The Two Auctions",
        "The thirteen days that did most of the work: what the league spent, what it bought, who improved and "
        "who only spent. The phase table is the spine -- April, the lock, the close, today -- and the story is "
        "which lineups moved, not which owners were loudest. Never add the Expired Rookie Auction and the Free "
        "Agent Auction into one number without saying so: they sell different calibres of player.",
        fact_ids=_money_ids + _value_ids, table_ids=[t_phases, t_shares], quote_ids=quote_ids)
    pack.section(
        "s5", "Since the Auction",
        "Five weeks in which the board barely moved: waivers and churn, a league with almost no cap room left, "
        "the injuries the forecast holds out, and week one as an opening data point and nothing more -- only a "
        "handful of NFL teams had played when this was built.",
        fact_ids=_shape_ids + _money_ids, quote_ids=quote_ids)
    pack.section(
        "s6", "The Divisions, Strongest to Weakest",
        "Rank the four divisions and say what makes each what it is: the mean projection, how the three teams "
        "inside it are spread, what it spent, what it starts on defense, and how many playoff spots it can "
        "expect of the six. Name the teams. Close on the stakes -- year one of three -- and on the model's own "
        "limits.",
        fact_ids=_div_ids + team_ids, table_ids=[t_divisions], quote_ids=quote_ids)
    pack.section(
        "s7", "Appendix: How the Forecast Is Calculated",
        "For the reader who wants to check the work. Plain English, step by step: where the projections come from, "
        "how a week and a season are played, how much the projection is trusted and why, and the evidence -- how "
        "the same model would have called 2021 through 2025, team by team, projection against finish. Then what "
        "it cannot do. No sales pitch: the last three seasons were hard to call and the page should say so.",
        fact_ids=_bt_ids + ["f.league.sim_runs"],
        table_ids=[t_bt_seasons, t_bt_dial, t_bt_calib, t_bt_spread, t_bt_teams])
    return pack
