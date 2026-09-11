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
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
sys.path.insert(0, HERE)

import wire_data as D                                         # noqa: E402
from wire_pack import Pack                                    # noqa: E402
from team_review_2026 import DIVISION_DRAFT_2026, _division_draft_picker  # noqa: E402

SEASON = 2026
PACK_ID = "2026-season-forecast"
SIM_PATH = os.path.join(D.REPO, "site", "wire", "data", "season_sim_%d.json" % SEASON)
QUOTES_PATH = os.path.join(D.REPO, "site", "wire", "data", "discord_quotes_%d_preseason.json" % SEASON)
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
                ("sim_p_title", "Title odds", _pct(t["pTitle"]), "percent", None)):
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
         {"key": "wins", "label": "Projected wins", "type": "text"},
         {"key": "div", "label": "Division odds", "type": "percent"},
         {"key": "po", "label": "Playoff odds", "type": "percent"},
         {"key": "bye", "label": "Bye odds", "type": "percent"},
         {"key": "title", "label": "Title odds", "type": "percent"}],
        [[t["powerRank"], t["team"], (hist.get(t["franchiseId"]) or {}).get("owner_display") or "",
          div_name.get(str(t["division"]), str(t["division"])), _pct(t["expAllPlayPct"]),
          "%.1f of %d" % (t["expWins"], t["games"]), _pct(t["pDivision"]), _pct(t["pPlayoffs"]),
          _pct(t["pBye"]), _pct(t["pTitle"])] for t in teams],
        note="Power rank = projected regular-season all-play %%, schedule-neutral. Wins are head-to-head, "
             "out of the %d-game schedule. Odds are the share of %d simulated seasons." % (teams[0]["games"], sim["runs"]))

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
        note="Seated by career all-play %, the rule for the first draft under the 2026 realignment rule.")
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

    pack.warn("The forecast is a SIMULATION of today's rosters on MFL's weekly projections, regressed toward the "
              "league (backtested on 2021-2025: it explained about 40%% of the spread in final all-play, but "
              "ranked the field at only .3 to .4 in each of the last three seasons). Say 'projected' and 'odds', "
              "never 'will'. It cannot see trades, waiver moves, injuries after the build, or lineup choices.")
    pack.warn("Every team plays each division rival five times in the %d-game schedule -- that is never news." % teams[0]["games"])
    pack.coverage = {"seasonsComplete": [2010, 2025], "currentSeason": SEASON, "currentSeasonPartial": True}

    pack.section(
        "s1", "The Forecast",
        "Open with a blurb about the season as the simulation sees it -- who is the favorite, how close the "
        "middle is, which division is a fight and which is a runaway -- then the forecast table. Quote odds as "
        "odds. Fun, but every number is a token.",
        fact_ids=team_ids + ["f.league.teams", "f.league.sim_runs", "f.league.sim_games"],
        table_ids=[t_forecast], quote_ids=quote_ids)
    pack.section(
        "s2", "The Divisional Draft",
        "The league's first Owner Divisional Draft: the four captains and every pick, who went first, who went "
        "last, and how each division looks now that the simulation has seen it. Place the league's own chat "
        "about it by id.",
        fact_ids=draft_ids, table_ids=[t_captains, t_draft], quote_ids=quote_ids)
    pack.section(
        "s3", "The Lay of the Land",
        "The season in general, as the league chat tells it: the running jokes and the trash talk heading into "
        "week one. Good-natured only. Quotes are placed by id, never typed.",
        fact_ids=team_ids, quote_ids=quote_ids)
    return pack
