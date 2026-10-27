#!/usr/bin/env python3
"""Render the Week 6 issue's "Injury Report -- Week 7" segment from injury_wk07.json (and the
counterfactual forecast), registering every printed number with its source in injury_claims.json.

    python3 injury_segment.py <season_sim_live_wk06.json> <cf_sim.json>   -> injury_segment.html, injury_claims.json
"""
import html as H
import json
import os
import sys
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

D = os.path.dirname(os.path.abspath(__file__))
ET = ZoneInfo("America/New_York")
inj = json.load(open(os.path.join(D, "injury_wk07.json")))
base = {t["franchiseId"]: t for t in json.load(open(sys.argv[1]))["teams"]}
cf = {t["franchiseId"]: t for t in json.load(open(sys.argv[2]))["teams"]}
CLAIMS = {}
e = H.escape


def put(key, value, source, shown=None):
    shown = shown if shown is not None else str(value)
    if key in CLAIMS and CLAIMS[key]["value"] != value:
        raise ValueError("claim %s twice with different values" % key)
    CLAIMS[key] = {"value": value, "shown": shown, "source": source}
    return shown


def et(iso):
    d = datetime.strptime(iso, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).astimezone(ET)
    return "%s, %d:%02d %s ET" % (d.strftime("%a %b %-d"), (d.hour % 12) or 12, d.minute, "AM" if d.hour < 12 else "PM")


SRC_P = "MFL playerScores W1-6 (league 74598 scoring) + nflverse games played"
SRC_L = "best legal lineup by 2026 PPG (injury_wk07.py), MFL rosters fetched %s" % inj["sources"]["fetchedAt"]["rosters"]
SRC_I = "MFL injury feed updated %s" % inj["sources"]["mflInjuryFeedUpdated"]
feed_et = et(inj["sources"]["mflInjuryFeedUpdated"])
nv_et = et(inj["sources"]["nflverseFetchedAt"])


def ordn(n):
    return "%d%s" % (n, "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th"))


def recent(key, vals):
    return ", ".join(put("%s:w%d" % (key, w), float(v), SRC_P, v) if v not in ("DNP", "bye") else v for w, v in zip((4, 5, 6), vals))


def row(label, value):
    return ('<div style="display:flex;gap:.6rem;padding:.18rem 0;border-top:1px solid var(--line-2)"><div style="flex:0 0 6.6rem;'
            'color:var(--muted);font-size:.78rem">%s</div><div style="flex:1;font-size:.86rem;line-height:1.35">%s</div></div>' % (label, value))


def card(title, sub, rows, accent=False):
    return ('<div class="injury-card" style="border:1px solid var(--line-2);border-radius:10px;padding:.65rem .8rem;margin:.55rem 0;'
            'background:var(--surface)%s"><div style="font-weight:700;font-size:.95rem">%s</div><div style="color:var(--muted);'
            'font-size:.8rem;margin-bottom:.3rem">%s</div>%s</div>' % (";border-left:4px solid var(--accent)" if accent else "", title, sub, "".join(rows)))


# ---------------------------------------------------------------- McLaurin / Blake
b = inj["blake"]
mc = next(c for c in b["candidates"] if c["player"] == "Terry McLaurin")
k = "inj:mclaurin"
cand_rows = []
for c in b["candidates"]:
    if c["pos"] not in ("WR", "RB", "TE") or c["roster"] != "ROSTER" or c["games"] == 0:
        continue
    kk = "inj:blake:%s" % c["pid"]
    slot = b["lineupWith"]["slots"].get(c["player"], "bench")
    cand_rows.append('<tr><td>%s <small>%s</small></td><td class="num">%s</td><td class="num">%s</td><td>%s</td><td>%s</td></tr>' % (
        e(c["player"]), c["pos"], put(kk + ":ppg", c["ppg"], SRC_P, "%.1f" % c["ppg"]), recent(kk, c["recent"]), slot,
        {"available": "plays", "bye": "bye", "Questionable": "Questionable (MFL)"}.get(c["wk7"], c["wk7"])))
blake_po, blake_cf = round(100 * base["0010"]["currentPlayoffOdds"], 1), round(100 * cf["0010"]["currentPlayoffOdds"], 1)
src_po = "season_sim live wk06 (Playoff Picture, 10,000 runs)"
src_cf = "same simulation, same inputs and seed, McLaurin removed from the injury feed (cf_sim.json)"
rk_w = next(c for c in inj["cases"] if c["fid"] == "0010") if any(c["fid"] == "0010" for c in inj["cases"]) else None
mcl = card(
    "Terry McLaurin (WR, Washington) &mdash; Shawn Blake", "Hurt Monday night; started properly, so not a lineup story", [
        row("Status", "Left Monday night&rsquo;s game at San Francisco after %s catch for %s yards (%s UPS points). MFL lists him "
                      "<b>Out, knee</b>, expected back %s (feed updated %s). Washington&rsquo;s Week 7 report was not yet in the official-report data "
                      "when checked (%s); no official Week 7 designation is implied." % (
                          put(k + ":rec", 1, "nflverse player_stats 2026 wk6"), put(k + ":yds", 27, "nflverse player_stats 2026 wk6"),
                          put(k + ":w6", 3.9, SRC_P, "3.9"), "Feb 15, 2027", feed_et, nv_et)),
        row("2026", "%s points a game in %s games; WR #%s in points, #%s in points per game. Weeks 4&ndash;6: %s." % (
            put(k + ":ppg", mc["ppg"], SRC_P, "%.1f" % mc["ppg"]), put(k + ":g", mc["games"], SRC_P), put(k + ":rkp", mc["rankPoints"], SRC_P),
            put(k + ":rkg", mc["rankPPG"], SRC_P), recent(k, mc["recent"]))),
        row("Healthy lineup", "<b>Not in Blake&rsquo;s best legal lineup.</b> DeVonta Smith and Drake London hold the receiver spots; "
                              "Denzel Boston and Brenton Strange take the flex spots ahead of him."),
        row("Replacement", "None needed in the best lineup: it scores %s a week with him or without him (league rank %s either way)." % (
            put("inj:blake:lu", b["lineupWith"]["ppg"], SRC_L, "%.1f" % b["lineupWith"]["ppg"]),
            put("inj:blake:rank", next(v["rank"] for f, v in inj["healthyLineups"].items() if f == "0010"), SRC_L,
                ordn(next(v["rank"] for f, v in inj["healthyLineups"].items() if f == "0010"))))),
        row("Depth", "<b>Enough.</b> Devaughn Vele and Quinshon Judkins are next at receiver/flex; the receiver room absorbs the loss."),
        row("Week 7", "The real squeeze is the bye: Josh Allen (Buffalo), Bhayshul Tuten and Brenton Strange (Jacksonville) are off, and "
                      "so is Washington. Blake&rsquo;s best available Week 7 lineup is %s a week, %s below the healthy one: Brock Purdy is "
                      "the only quarterback on Blake&rsquo;s active roster, and Vele and Rashid Shaheed move into the flex." % (
                          put("inj:blake:wk7", b["week7"]["ppg"], SRC_L, "%.1f" % b["week7"]["ppg"]),
                          put("inj:blake:wk7gap", round(b["lineupWith"]["ppg"] - b["week7"]["ppg"], 1), SRC_L,
                              "%.1f" % round(b["lineupWith"]["ppg"] - b["week7"]["ppg"], 1)))),
        row("Outlook", "The Playoff Picture has Blake at %s to make the playoffs; the same simulation with McLaurin listed healthy says "
                       "%s. Blake is one of four teams at %s (with Keith Creelman, Chris Klingenberg and Eric Mannila), and Blake&rsquo;s "
                       "%s All-Play is the best of the four." % (
                           put("odds:po:0010", blake_po, src_po, "%.1f%%" % blake_po), put("inj:blake:cfpo", blake_cf, src_cf, "%.1f%%" % blake_cf),
                           put("inj:nine7", "9-7", "MFL leagueStandings after Week 6 (h2hw/h2hl)", "9&ndash;7"),
                           put("inj:blake:ap", "44-22", "MFL leagueStandings after Week 6", "44&ndash;22"))),
    ], accent=True)
mcl += ('<div class="tablebox"><table><thead><tr><th>Blake&rsquo;s RB/WR/TE</th><th>PPG</th><th>Weeks 4&ndash;6</th><th>Healthy lineup</th>'
        '<th>Week 7</th></tr></thead><tbody>%s</tbody></table></div>' % "".join(cand_rows))

# ---------------------------------------------------------------- every other meaningful injury
new, ir = [], []
for c in inj["cases"]:
    if c["pid"] == "14109":
        continue
    kk = "inj:%s" % c["pid"]
    r = c["replacement"] or {}
    fa = c["bestFreeAgent"]
    fa_txt = ""
    if fa and r and fa["ppg"] > r["ppg"]:
        fa_txt = " Best free agent at the position: %s (%s, %s a game in %s games)." % (
            e(fa["player"]), fa["nfl"], put(kk + ":fa", fa["ppg"], SRC_P, "%.1f" % fa["ppg"]), put(kk + ":fag", fa["games"], SRC_P))
    press = []
    if c["byePressure"]:
        press.append("byes: " + ", ".join("%s (Week %d)" % (e(n), w) for n, w in c["byePressure"]))
    if c["otherInjuriesAtPosition"]:
        press.append("also hurt at the position: " + ", ".join(e(n) for n in c["otherInjuriesAtPosition"]))
    rk_txt = ("%s &rarr; %s" % (put(kk + ":rk1", c["rankHealthy"], SRC_L, ordn(c["rankHealthy"])), put(kk + ":rk2", c["rankWithout"], SRC_L, ordn(c["rankWithout"])))
              if c["rankHealthy"] != c["rankWithout"] else "%s, unchanged" % put(kk + ":rk1", c["rankHealthy"], SRC_L, ordn(c["rankHealthy"])))
    rows = [
        row("Status", "MFL: <b>%s</b>%s. %s." % (e(c["injury"]["mfl"]), (", " + e(c["injury"]["details"].lower())) if c["injury"]["details"] else "",
                                                  e(c["injury"]["corroboration"][0].upper() + c["injury"]["corroboration"][1:]))),
        row("2026", "%s a game in %s games; %s #%s in points%s. Weeks 4&ndash;6: %s." % (
            put(kk + ":ppg", c["ppg"], SRC_P, "%.1f" % c["ppg"]), put(kk + ":g", c["games"], SRC_P), c["pos"], put(kk + ":rkp", c["rankPoints"], SRC_P),
            (", #%s per game" % put(kk + ":rkg", c["rankPPG"], SRC_P)) if c["rankPPG"] else "", recent(kk, c["recent"]))),
        row("Lineup slot", "%s in the best healthy lineup" % c["slot"]),
        row("Replacement", ("%s (%s, %s a game; Week 7: %s)" % (e(r["player"]), r["pos"], put(kk + ":rppg", r["ppg"], SRC_P, "%.1f" % r["ppg"]),
                                                              {"available": "plays"}.get(r["wk7"], r["wk7"]))) if r else "none"),
        row("Lineup cost", "%s &rarr; %s a week (%s); league rank %s" % (
            put(kk + ":lu1", c["lineupHealthy"], SRC_L, "%.1f" % c["lineupHealthy"]), put(kk + ":lu2", c["lineupWithout"], SRC_L, "%.1f" % c["lineupWithout"]),
            put(kk + ":drop", c["lineupDrop"], SRC_L, "&minus;%.1f" % c["lineupDrop"]), rk_txt)),
        row("Depth", "<b>%s</b>.%s" % (c["verdict"][0].upper() + c["verdict"][1:], fa_txt)),
    ]
    if press:
        rows.append(row("Pressure", "; ".join(press) + "."))
    (ir if c["injury"]["mfl"] in ("IR", "IR-R", "PUP") else new).append(
        card("%s (%s, %s) &mdash; %s" % (e(c["player"]), c["pos"], c["nfl"], e(c["owner"])), "", rows))

intro = ('<div class="desk" style="margin-bottom:.6rem"><div class="lt rich"><div class="who">Rich</div><p>Injuries that change a lineup, '
         'not just a name on a list. &ldquo;Starter-caliber&rdquo; here means the player is in the team&rsquo;s best legal lineup '
         'by 2026 points per game with everyone healthy, not simply someone who started last week.</p></div></div>'
         '<p class="caption">Status: MFL&rsquo;s injury feed, updated %s, cross-checked against the official reports (Week 6 final; '
         'the official Week 7 report data covered only New England and Chicago when checked, %s). Depth: a lineup loss under '
         '3.0 points a week is enough depth, 3.0&ndash;6.0 is weaker but workable, 6.0 or more needs a waiver or trade look.</p>'
         % (feed_et, nv_et))
for t in ("3.0", "6.0"):
    put("inj:rule:%s" % t, float(t), "the segment's own stated depth rule", t)
body = (intro + mcl + '<h3 style="margin:1rem 0 .2rem;font-size:1rem">Hurt in or before Week 6</h3>' + "".join(new)
        + '<h3 style="margin:1rem 0 .2rem;font-size:1rem">Already on injured reserve</h3>' + "".join(ir))
html_out = ('<section class="wire-sec" id="injuries" data-title="Injury Report"><div class="label"><span class="seg">8</span> Injury Report '
            '<small>&mdash; who is hurt, who steps in, what it costs</small></div>%s</section>' % body)
open(os.path.join(D, "injury_segment.html"), "w").write(html_out)
json.dump(CLAIMS, open(os.path.join(D, "injury_claims.json"), "w"), indent=1)
print("segment: %d bytes, %d claims, %d new + %d IR cards" % (len(html_out), len(CLAIMS), len(new), len(ir)))
