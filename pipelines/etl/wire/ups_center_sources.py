#!/usr/bin/env python3
"""Every source a weekly UPS Center draft is built from and checked against, in one
snapshot ("context").

WHY (Keith 2026-10-08): "automate production of future UPS Center issues ... Validate
every score, record, projection timestamp, quote link and derived claim against its
source." The renderer (ups_center_issue.py) writes from the pack; the validator
(ups_center_validate.py) re-checks the result against THIS snapshot, which is fetched
independently of the pack -- MFL for scores/records/kickoffs/trades/Elias, D1 for the
league's own copies (which must agree with MFL), the worker for the order the site
shows, and ups_discord_messages for every quote. Tests replay a recorded snapshot.

Read-only: MFL GETs, D1 SELECTs (wire_data.d1 refuses anything else), one worker GET.
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import wire_data as D          # noqa: E402
import elias as E              # noqa: E402
import chat_exclusions         # noqa: E402

MFL = "https://www48.myfantasyleague.com/%d/export?TYPE=%s&L=74598&JSON=1%s"
WORKER = "https://upsmflproduction.keith-creelman.workers.dev"
GUILD = "1057655884475531324"
FINAL_AFTER_LAST_KICKOFF_S = 5 * 3600
DEADLINE_LEAD_S = 8 * 3600


def _get(url, timeout=45):
    req = urllib.request.Request(url, headers={"User-Agent": "ups-center-auto"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def _list(x):
    return x if isinstance(x, list) else ([x] if x else [])


def iso(ts):
    return datetime.fromtimestamp(int(ts), timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def week_timing(season, week):
    """{week kickoffs, final_at, next_first_kickoff, deadline} from MFL's nflSchedule."""
    k = D.nfl_kickoffs(season, week)
    out = {"kickoffs": k, "lastKickoff": max(k.values()), "finalAt": max(k.values()) + FINAL_AFTER_LAST_KICKOFF_S}
    try:
        nk = D.nfl_kickoffs(season, week + 1)
        out["nextFirstKickoff"] = min(nk.values())
        out["deadline"] = min(nk.values()) - DEADLINE_LEAD_S
    except D.DataError:
        out["nextFirstKickoff"] = None
        out["deadline"] = out["lastKickoff"] + 4 * 86400
    return out


def latest_finished_week(season, now, max_week=17):
    """The newest week whose last game ended (plus a settling margin) before `now`."""
    done = None
    for wk in range(1, max_week + 1):
        try:
            k = D.nfl_kickoffs(season, wk)
        except D.DataError:
            break
        if max(k.values()) + FINAL_AFTER_LAST_KICKOFF_S <= now:
            done = wk
        else:
            break
    return done


def projection_evidence(season, week):
    """The same evidence the pack's bust & bargain used: kickoff-strict last pregame
    captures, else the never-overwritten FIRST capture (Keith 2026-09-24 basis). Every
    row carries its value, capture time and its own kickoff."""
    ranked, unranked = D.starter_projections(season, week)
    basis = "last_pregame"
    if not ranked:
        ranked, unranked = D.first_pregame_fallback_projections(season, week)
        basis = "first_pregame_fallback"
    keep = ("fid", "player_id", "player", "pos_group", "nfl_team", "score", "proj", "captured", "kickoff", "reason")
    return {"basis": basis, "ranked": [{k: r.get(k) for k in keep if k in r} for r in ranked],
            "unranked": [{k: r.get(k) for k in keep if k in r} for r in unranked]}


def _slug(s):
    import re
    return re.sub(r"[^a-z0-9]+", "-", s.lower().replace("\u2019", " ").replace("'", " ")).strip("-")


def verify_highlight(player, video):
    """{url, verified, why}: an NFL.com page whose own title names the player (NFL.com
    serves a generic page with HTTP 200 for any bad slug, so the status proves nothing),
    else the NFL channel's YouTube upload confirmed by oEmbed. Unverified -> no link."""
    import re
    last = player.split()[-1].lower() if player.split()[-1].lower() not in ("jr.", "ii", "iii", "sr.") else player.split()[-2].lower()
    if video and video.get("title"):
        url = "https://www.nfl.com/videos/" + _slug(video["title"])
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
            body = urllib.request.urlopen(req, timeout=20).read().decode("utf-8", "replace")
            title = (re.findall(r"<title>([^<]*)</title>", body) or [""])[0]
            if last in title.lower() and "highlights, clips" not in title.lower():
                return {"url": url, "verified": True, "why": "NFL.com page title: " + title[:120]}
        except Exception:                                    # noqa: BLE001
            pass
    if video and video.get("videoId"):
        watch = "https://www.youtube.com/watch?v=" + video["videoId"]
        try:
            o = _get("https://www.youtube.com/oembed?url=%s&format=json" % watch)
            if o.get("author_name") == "NFL" and last in o.get("title", "").lower():
                return {"url": watch, "verified": True, "why": "YouTube oEmbed: NFL channel, " + o["title"][:100]}
        except Exception:                                    # noqa: BLE001
            pass
    return {"url": None, "verified": False, "why": "no NFL.com page or NFL-channel upload could be confirmed"}


def withhold(chat):
    """Blank the text of every ruled-out or never-material message AT THE SOURCE, so no
    snapshot, draft, preview or review copy downstream can carry it. The row stays (it is
    still a post, so the post counts hold) with `withheld` saying why."""
    ids = chat_exclusions.excluded_ids()
    for m in chat:
        why = chat_exclusions.reason(m.get("message_id"), m.get("content"), ids)
        if why:
            m["content"], m["withheld"] = None, why
    return chat


def gather(season, week, now=None, chat_since=None, pack=None):
    """The snapshot. `chat_since` (unix) starts the Coffee Shop window; default = the
    previous issue's publishedAt from the repo index, else the week's first kickoff."""
    now = int(now or datetime.now(timezone.utc).timestamp())
    ctx = {"season": int(season), "week": int(week), "gatheredAtUtc": iso(now), "mfl": {}, "d1": {}, "site": {}}
    ctx["timing"] = week_timing(season, week)

    # ---- MFL: the source of truth for the live season
    wr = _get(MFL % (season, "weeklyResults", "&W=%d" % week))["weeklyResults"]
    games = []
    for m in _list(wr.get("matchup")):
        fs = _list(m.get("franchise"))
        if len(fs) == 2:
            games.append({"a": fs[0]["id"], "b": fs[1]["id"], "as": float(fs[0]["score"]), "bs": float(fs[1]["score"]),
                          "ar": fs[0].get("result"), "br": fs[1].get("result")})
    scores = {}
    for g in games:
        scores[g["a"]] = g["as"]
        scores[g["b"]] = g["bs"]
    ctx["mfl"]["games"] = games
    ctx["mfl"]["scores"] = scores
    st = _get(MFL % (season, "leagueStandings", ""))["leagueStandings"]
    ctx["mfl"]["standings"] = {f["id"]: {"h2hw": int(f["h2hw"]), "h2hl": int(f["h2hl"]), "h2ht": int(f.get("h2ht") or 0),
                                         "allplay": f["all_play_wlt"], "pf": float(f["pf"])}
                               for f in _list(st.get("franchise"))}
    raw_news = E._get(E.NEWS_URL % int(season))
    ctx["mfl"]["elias"] = E.official_changes(season, week, raw=raw_news)
    since = int(chat_since or 0) or (min(ctx["timing"]["kickoffs"].values()))
    tx = _list(_get(MFL % (season, "transactions", "&TRANS_TYPE=TRADE&DAYS=14")).get("transactions", {}).get("transaction"))
    ctx["mfl"]["trades"] = [t for t in tx if int(t["timestamp"]) >= since]

    # ---- D1: the league's own copies (must agree with MFL) and the evidence tables
    ctx["d1"]["teamScores"] = {r["franchise_id"]: float(r["score"]) for r in D.d1(
        "SELECT franchise_id, team_score AS score FROM src_franchise_weekly_score WHERE season = %d AND week = %d"
        % (season, week))}
    ctx["d1"]["standings"] = {r["franchise_id"]: r for r in D.d1(
        "SELECT franchise_id, h2h_w, h2h_l, h2h_t, h2h_pct, allplay_w, allplay_l, allplay_t, allplay_pct, pf "
        "FROM src_standings WHERE season = %d" % season)}
    ctx["d1"]["franchises"] = {r["franchise_id"]: r for r in D.d1(
        "SELECT franchise_id, team_name, owner_name, logo, division FROM src_franchises WHERE season = %d" % season)}
    ctx["d1"]["regGames"] = D.d1(
        "SELECT franchise_id, opponent_franchise_id, team_score, opponent_score FROM src_schedule WHERE season = %d "
        "AND COALESCE(is_playoff,0) = 0 AND COALESCE(team_score,0) > 0 AND COALESCE(opponent_score,0) > 0" % season)
    ctx["d1"]["projections"] = {r["player_id"]: r for r in D.d1(
        "SELECT player_id, projected_score, updated_at, first_projected, first_captured_at, capture_count "
        "FROM ups_player_projections WHERE season = %d AND week = %d" % (season, week))}
    ctx["d1"]["adds"] = D.d1(
        "SELECT a.player_id, a.franchise_id, a.method, a.salary, a.datetime_et, a.unix_timestamp, p.name "
        "FROM src_adddrop a LEFT JOIN src_players p ON p.season = a.season AND p.player_id = a.player_id "
        "WHERE a.season = %d AND a.move_type = 'ADD' AND a.unix_timestamp >= %d" % (season, since))
    ctx["d1"]["chat"] = D.d1(
        "SELECT message_id, channel_id, channel_name, owner_name, franchise_id, posted_at_unix, content "
        "FROM ups_discord_messages WHERE posted_at_unix >= %d AND posted_at_unix <= %d "
        "AND COALESCE(is_bot,0) = 0 AND owner_name IS NOT NULL ORDER BY posted_at_unix" % (since, now))
    withhold(ctx["d1"]["chat"])
    ctx["chatWindow"] = {"since": since, "until": now}
    want = set(ctx["d1"]["projections"]) | set(a["player_id"] for a in ctx["d1"]["adds"])
    ctx["d1"]["players"] = {r["player_id"]: r for r in D.d1(
        "SELECT player_id, name, position, nfl_team FROM src_players WHERE season = %d" % season) if r["player_id"] in want}
    try:
        ctx["d1"]["recordBook"] = D.record_book(season, week)
    except D.DataError as exc:
        ctx["d1"]["recordBook"] = {"error": str(exc)}

    ctx["evidence"] = projection_evidence(season, week)
    ctx["links"] = {}
    for c in (pack or {}).get("playcards", []):
        ctx["links"][c["player"]] = verify_highlight(c["player"], c.get("video"))

    # ---- the site's own order (what a reader sees on the standings page)
    api = _get(WORKER + "/api/standings?year=%d" % season)
    ctx["site"]["standings"] = [{"franchise_id": r["franchise_id"], "owner_name": r["owner_name"],
                                 "is_division_leader": bool(r.get("is_division_leader")),
                                 "playoff_seed": r.get("playoff_seed")} for r in api.get("rows", [])]
    return ctx


def d1_matches_mfl(ctx):
    """[] when D1's copies of this week's scores and the season standings equal MFL's; else readable reasons."""
    out = []
    for fid, s in sorted(ctx["mfl"]["scores"].items()):
        d = ctx["d1"]["teamScores"].get(fid)
        if d is None or abs(d - s) > 0.05:
            out.append("D1 week %d score for %s is %s; MFL says %.1f" % (ctx["week"], fid, d, s))
    for fid, m in sorted(ctx["mfl"]["standings"].items()):
        d = ctx["d1"]["standings"].get(fid)
        if not d:
            out.append("D1 has no standings row for %s" % fid)
            continue
        ap = "%s-%s" % (d["allplay_w"], d["allplay_l"])
        if (d["h2h_w"], d["h2h_l"]) != (m["h2hw"], m["h2hl"]) or not m["allplay"].startswith(ap + "-") \
                or abs(float(d["pf"] or 0) - m["pf"]) > 0.05:
            out.append("D1 standings for %s (%s-%s, AP %s, PF %s) differ from MFL (%d-%d, AP %s, PF %.1f)" % (
                fid, d["h2h_w"], d["h2h_l"], ap, d["pf"], m["h2hw"], m["h2hl"], m["allplay"], m["pf"]))
    return out


def main():
    import argparse
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--week", type=int, required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()
    pack_path = os.path.join(D.REPO, "site/wire/packs/%d/%d-wk%02d-recap.pack.json" % (a.season, a.season, a.week))
    pack = json.load(open(pack_path)) if os.path.exists(pack_path) else None
    ctx = gather(a.season, a.week, pack=pack)
    json.dump(ctx, open(a.out, "w"), indent=1, default=str)
    print("wrote %s; D1 vs MFL: %s" % (a.out, d1_matches_mfl(ctx) or "match"))


if __name__ == "__main__":
    main()
