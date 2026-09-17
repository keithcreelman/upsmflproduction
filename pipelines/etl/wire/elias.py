#!/usr/bin/env python3
"""Official stat changes (Elias Sports Bureau) against what the recap published.

WHY (Keith 2026-09-17): "every thursday there are score changes courtesy of
Elias. We should have a section dedicated to Elias and essentially republish
those changes on Thursday and make a new discord post if/when there's any
changes that impact allplay." The Week 1 recap went out on Tuesday's numbers;
Elias's Week 1 changes (published Wed Sep 16, 10:49 PM ET) moved four team
scores by 0.5-1.5 points.

THREE STEPS, each reading MFL (the source of truth for the live season):

  freeze   what the recap PUBLISHED -- team scores, every rostered player's
           status and score, head-to-head results, all-play -- saved once to
           site/wire/data/scores_published_<season>_wk<NN>.json and never
           overwritten. Without it there is nothing to compare Thursday against.
  check    MFL's site news "Official Statistics Changes" posts for the week,
           MFL's live weeklyResults, and the comparison: player points that
           moved, team scores, head-to-head results that flipped, and every
           owner's all-play record -> site/wire/data/elias_<season>_wk<NN>.json.
  post     a Discord post, drafted ONLY when an all-play record changed (a
           flipped result always changes all-play too). Printing the draft is
           the default; sending it needs --send and a bot token, and is the
           commissioner's call.

Usage:
  python3 elias.py freeze --season 2026 --week 1
  python3 elias.py check  --season 2026 --week 1
  python3 elias.py post   --season 2026 --week 1            # prints the draft
"""

import argparse
import html
import io
import json
import os
import re
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone

import wire_data as D

MFL_HOST = "https://www48.myfantasyleague.com"
LEAGUE = "74598"
NEWS_URL = MFL_HOST + "/%d/site_news?L=" + LEAGUE + "&CATEGORY=Official+Statistics+Changes"
RESULTS_URL = MFL_HOST + "/%d/export?TYPE=weeklyResults&L=" + LEAGUE + "&W=%d&JSON=1"
DISCORD_API = "https://discord.com/api/v10/channels/%s/messages"


def _rel(kind, season, week):
    return "site/wire/data/%s_%d_wk%02d.json" % (kind, int(season), int(week))


def _path(kind, season, week):
    return os.path.join(D.REPO, _rel(kind, season, week))


def _get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "ups-wire-elias"})
    with urllib.request.urlopen(req, timeout=45) as resp:
        return resp.read().decode("utf-8", errors="replace")


def _now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def allplay(scores):
    """{fid: {"w","l","t"}} for one week's scores: every owner against every other."""
    out = {}
    for f, s in scores.items():
        w = sum(1 for g, t in scores.items() if g != f and s > t)
        l = sum(1 for g, t in scores.items() if g != f and s < t)
        out[f] = {"w": w, "l": l, "t": len(scores) - 1 - w - l}
    return out


def _state_from_rows(teams, players, games):
    return {"teams": teams, "players": players, "games": games, "allplay": allplay(teams)}


# ------------------------------------------------------------------ freeze
def freeze(season, week, force=False):
    """Save the recap's published numbers. Refuses to overwrite once an Elias check
    exists for the week: the baseline is what readers saw before Thursday, and a
    freeze after the changes would silently erase the thing Thursday is compared
    against. `force` only replaces a baseline that nothing has been checked against."""
    path = _path("scores_published", season, week)
    if os.path.exists(_path("elias", season, week)):
        raise D.DataError("an Elias check already exists for %d week %d; its baseline is never overwritten"
                          % (int(season), int(week)))
    if os.path.exists(path) and not force:
        raise D.DataError("%s already exists (pass force only before any Elias check)"
                          % _rel("scores_published", season, week))
    teams = dict((str(r["franchise_id"]).zfill(4), float(r["team_score"])) for r in D.d1(
        "SELECT franchise_id, team_score FROM src_franchise_weekly_score WHERE season = %d AND week = %d "
        "AND team_score IS NOT NULL" % (int(season), int(week))))
    if not teams:
        raise D.DataError("no team scores in src_franchise_weekly_score for %d week %d" % (season, week))
    players = [{"fid": str(r["fid"]).zfill(4), "pid": str(r["player_id"]), "status": r["status"],
                "score": None if r["score"] is None else float(r["score"])} for r in D.d1(
        "SELECT roster_franchise_id AS fid, player_id, status, score FROM src_weekly WHERE season = %d "
        "AND week = %d AND status IN ('starter','nonstarter') AND roster_franchise_id IS NOT NULL"
        % (int(season), int(week)))]
    games = [{"a": str(r["franchise_id"]).zfill(4), "b": str(r["opponent_franchise_id"]).zfill(4),
              "aScore": float(r["team_score"]), "bScore": float(r["opponent_score"]),
              "result": (r["result"] or "").upper()} for r in D.d1(
        "SELECT franchise_id, opponent_franchise_id, team_score, opponent_score, result FROM src_schedule "
        "WHERE season = %d AND week = %d AND franchise_id < opponent_franchise_id AND team_score IS NOT NULL"
        % (int(season), int(week)))]
    synced = D.d1("SELECT MAX(updated_at_utc) AS u FROM src_players WHERE season = %d" % int(season))[0]["u"]
    doc = dict(_state_from_rows(teams, players, games), season=int(season), week=int(week), frozenAtUtc=_now(),
               source="D1 src_franchise_weekly_score / src_weekly / src_schedule as last synced from MFL "
                      "(%s UTC) -- the numbers the recap was built on" % synced)
    with io.open(path, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1, sort_keys=True)
        fh.write("\n")
    return doc


def load_baseline(season, week):
    path = _path("scores_published", season, week)
    if not os.path.exists(path):
        return None
    return json.load(io.open(path, encoding="utf-8"))


# ------------------------------------------------------------------ MFL now
def pretty_published(text):
    """'Wed Sep 16 10:49:54 p.m. ET 2026' -> 'Wed Sep 16, 10:49 PM ET'. Unparseable text is
    returned unchanged rather than guessed at."""
    m = re.match(r"^(\w{3}) (\w{3}) (\d{1,2}) (\d{1,2}):(\d{2})(?::\d{2})? ([ap])\.?m\.? ET \d{4}$", str(text or "").strip())
    if not m:
        return text
    return "%s %s %d, %d:%s %s ET" % (m.group(1), m.group(2), int(m.group(3)), int(m.group(4)), m.group(5),
                                     "AM" if m.group(6) == "a" else "PM")


def official_changes(season, week, raw=None):
    """[{"published", "publishedText", "game", "player", "stat", "from", "to"}] from MFL's
    "Official Statistics Changes" news for this week. MFL lists every post in the
    category on one page; a week can have more than one post."""
    raw = raw if raw is not None else _get(NEWS_URL % int(season))
    body = re.sub(r"<script.*?</script>|<style.*?</style>", "", raw, flags=re.S)
    text = html.unescape(re.sub(r"<[^>]+>", "\n", body))
    lines = [re.sub(r"\s+", " ", x).strip() for x in text.split("\n")]
    lines = [x for x in lines if x]
    out, cur_pub, cur_game, in_post = [], None, None, False
    head = re.compile(r"^Stat Changes for Week #(\d+) \(Published (.+?)\)$")
    change = re.compile(r"^(.+?): from (-?[\d.]+) to (-?[\d.]+) (.+?)\.?$")
    game = re.compile(r"^.+ at .+$")
    for ln in lines:
        m = head.match(ln)
        if m:
            in_post = int(m.group(1)) == int(week)
            cur_pub, cur_game = m.group(2), None
            continue
        if not in_post:
            continue
        if ln.startswith("The following stat changes"):
            continue
        c = change.match(ln)
        if c:
            out.append({"publishedText": cur_pub, "game": cur_game, "player": c.group(1).strip(),
                        "from": float(c.group(2)), "to": float(c.group(3)), "stat": c.group(4).strip()})
            continue
        if game.match(ln) and len(ln) < 80:
            cur_game = ln
            continue
        in_post = False              # anything else ends the post (the page moves on to other panels)
    return out


def live_state(season, week, raw=None):
    """The same shape as the baseline, straight from MFL's weeklyResults."""
    doc = json.loads(raw) if raw is not None else json.loads(_get(RESULTS_URL % (int(season), int(week))))
    wr = doc.get("weeklyResults") or {}
    matchups = wr.get("matchup") or []
    matchups = matchups if isinstance(matchups, list) else [matchups]
    if not matchups:
        raise D.DataError("MFL weeklyResults for %d week %d has no matchups" % (season, week))
    teams, players, games = {}, [], []
    for m in matchups:
        fr = m.get("franchise") or []
        for f in fr:
            fid = str(f["id"]).zfill(4)
            if fid not in teams:
                teams[fid] = float(f["score"])
                for p in (f.get("player") or []):
                    if p.get("status") in ("starter", "nonstarter"):
                        players.append({"fid": fid, "pid": str(p["id"]), "status": p["status"],
                                        "score": None if p.get("score") in (None, "") else float(p["score"])})
        if len(fr) == 2:
            a, b = sorted(fr, key=lambda f: str(f["id"]))
            games.append({"a": str(a["id"]).zfill(4), "b": str(b["id"]).zfill(4), "aScore": float(a["score"]),
                          "bScore": float(b["score"]), "result": (a.get("result") or "").upper()})
    return _state_from_rows(teams, players, games)


# ------------------------------------------------------------------ compare
def compare(season, week, base, now, changes):
    names = dict((str(r["player_id"]), D.display_name(r["name"])) for r in D.d1(
        "SELECT player_id, name FROM src_players WHERE season = %d" % int(season)))
    squash = lambda n: re.sub(r"[^a-z]", "", re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", str(n or "").lower()))
    by_name = {}
    for c in changes:
        by_name.setdefault(squash(c["player"]), []).append(c)

    bp = dict(((p["fid"], p["pid"]), p) for p in base["players"])
    players = []
    for p in now["players"]:
        old = bp.get((p["fid"], p["pid"]))
        if not old or old["score"] is None or p["score"] is None:
            continue
        delta = round(p["score"] - old["score"], 2)
        if abs(delta) < 0.001:
            continue
        name = names.get(p["pid"], p["pid"])
        players.append({"fid": p["fid"], "pid": p["pid"], "player": name, "status": p["status"],
                        "before": old["score"], "after": p["score"], "delta": delta,
                        "elias": [{"stat": c["stat"], "from": c["from"], "to": c["to"]}
                                  for c in by_name.get(squash(name), [])]})
    players.sort(key=lambda x: (x["fid"], -abs(x["delta"])))

    teams = []
    for fid in sorted(now["teams"]):
        b, a = base["teams"].get(fid), now["teams"][fid]
        if b is None:
            raise D.DataError("baseline has no team score for %s" % fid)
        if abs(a - b) >= 0.001:
            teams.append({"fid": fid, "before": b, "after": a, "delta": round(a - b, 2)})

    bg = dict(((g["a"], g["b"]), g) for g in base["games"])
    games = []
    for g in now["games"]:
        old = bg.get((g["a"], g["b"]))
        if old is None:
            raise D.DataError("game %s-%s is not in the published baseline" % (g["a"], g["b"]))
        if abs(old["aScore"] - g["aScore"]) >= 0.001 or abs(old["bScore"] - g["bScore"]) >= 0.001:
            games.append({"a": g["a"], "b": g["b"], "before": [old["aScore"], old["bScore"]],
                          "after": [g["aScore"], g["bScore"]], "resultBefore": old["result"],
                          "resultAfter": g["result"], "flipped": old["result"] != g["result"]})
    ap = []
    for fid in sorted(now["allplay"]):
        b, a = base["allplay"][fid], now["allplay"][fid]
        if (b["w"], b["l"], b["t"]) != (a["w"], a["l"], a["t"]):
            ap.append({"fid": fid, "before": b, "after": a})
    rank = lambda sc: dict((f, 1 + sum(1 for t in sc.values() if t > s)) for f, s in sc.items())
    rb, ra = rank(base["teams"]), rank(now["teams"])
    return {"season": int(season), "week": int(week), "checkedAtUtc": _now(),
            "published": sorted(set(pretty_published(c["publishedText"]) for c in changes)),
            "officialChanges": changes, "players": players, "teams": teams, "games": games,
            "allplayChanges": ap, "rankChanges": [{"fid": f, "before": rb[f], "after": ra[f]}
                                                  for f in sorted(ra) if rb.get(f) != ra[f]],
            "resultsFlipped": sum(1 for g in games if g["flipped"]),
            "allplayChanged": bool(ap)}


def check(season, week):
    base = load_baseline(season, week)
    if base is None:
        raise D.DataError("no published baseline (%s) -- run `elias.py freeze` when the recap is built"
                          % _rel("scores_published", season, week))
    out = compare(season, week, base, live_state(season, week), official_changes(season, week))
    with io.open(_path("elias", season, week), "w", encoding="utf-8") as fh:
        json.dump(out, fh, indent=1, sort_keys=True)
        fh.write("\n")
    return out


# ------------------------------------------------------------------ discord
def discord_draft(report, owners):
    """The post, or None when no all-play record moved (Keith: post "if/when there's
    any changes that impact allplay")."""
    if not report["allplayChanged"]:
        return None
    who = lambda f: owners.get(f, {}).get("owner_name") or f
    wk = report["week"]
    lines = ["📋 **UPS Center: Elias stat changes, Week %d**" % wk,
             "Official stat corrections landed and they moved the all-play standings."]
    for g in report["games"]:
        if g["flipped"]:
            lines.append("🔁 **Result flipped:** %s %.1f, %s %.1f (was %.1f-%.1f)" % (
                who(g["a"]), g["after"][0], who(g["b"]), g["after"][1], g["before"][0], g["before"][1]))
    for c in report["allplayChanges"]:
        b, a = c["before"], c["after"]
        fmt = lambda r: "%d-%d" % (r["w"], r["l"]) + ("-%d" % r["t"] if r["t"] else "")
        lines.append("• %s: all-play %s → %s" % (who(c["fid"]), fmt(b), fmt(a)))
    for t in report["teams"]:
        lines.append("• %s: %.1f → %.1f (%+.1f)" % (who(t["fid"]), t["before"], t["after"], t["delta"]))
    lines.append("Full list of changes in UPS Center.")
    return "\n".join(lines)


def send_discord(channel_id, content):
    """Posts one message with the bot token from the macOS Keychain (never printed)."""
    token = subprocess.run(["security", "find-generic-password", "-s", "discord_bot_token", "-w"],
                           capture_output=True, text=True).stdout.strip()
    if not token:
        raise D.DataError("no discord_bot_token in the Keychain")
    req = urllib.request.Request(DISCORD_API % channel_id, method="POST",
                                 data=json.dumps({"content": content, "allowed_mentions": {"parse": []}}).encode(),
                                 headers={"Authorization": "Bot " + token, "Content-Type": "application/json",
                                          "User-Agent": "ups-wire-elias"})
    with urllib.request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8")).get("id")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("cmd", choices=("freeze", "check", "post"))
    ap.add_argument("--season", type=int, required=True)
    ap.add_argument("--week", type=int, required=True)
    ap.add_argument("--channel", help="Discord channel id for `post --send`")
    ap.add_argument("--send", action="store_true", help="actually post (default prints the draft)")
    a = ap.parse_args()
    try:
        if a.cmd == "freeze":
            doc = freeze(a.season, a.week)
            print("froze %s: %d teams, %d rostered players, %d games" % (
                _rel("scores_published", a.season, a.week), len(doc["teams"]), len(doc["players"]),
                len(doc["games"])))
        elif a.cmd == "check":
            r = check(a.season, a.week)
            print("wrote %s: %d official changes; %d player scores, %d team scores, %d results flipped; "
                  "all-play changed: %s" % (_rel("elias", a.season, a.week), len(r["officialChanges"]),
                                            len(r["players"]), len(r["teams"]), r["resultsFlipped"],
                                            "YES" if r["allplayChanged"] else "no"))
        else:
            path = _path("elias", a.season, a.week)
            if not os.path.exists(path):
                raise D.DataError("run `elias.py check` first")
            r = json.load(io.open(path, encoding="utf-8"))
            draft = discord_draft(r, D.owner_map(a.season))
            if draft is None:
                print("no all-play record changed -- nothing to post")
                return 0
            if not a.send:
                print(draft)
                print("\n(draft only -- pass --send --channel <id> to post)")
                return 0
            if not a.channel:
                raise D.DataError("--send needs --channel")
            print("posted message %s" % send_discord(a.channel, draft))
    except D.DataError as exc:
        print("elias REFUSED: %s" % exc, file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
