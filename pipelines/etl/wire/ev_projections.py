#!/usr/bin/env python3
"""Expected-value weekly projections for offense, in UPS scoring.

WHY (Keith 2026-09-16): MFL's projectedScores move in whole-touchdown steps --
Drake London sat at ~19 (one touchdown) in 14 of 15 future weeks before week 1
and at ~12 (none) in 2 of 15 after it, a seven-point swing per week from a tiny
change in how likely a touchdown is. His fix: "multiply the ratio by the points
it would generate, so a TD that's 0.49 = .49 * 6. That eliminates the noise and
keeps the numbers real."

MFL's export carries only the rounded point total, so the fractional stat line
has to come from somewhere else. Sleeper's public weekly projections (no key;
the numbers are RotoWire's) publish exactly that: 0.42 receiving touchdowns,
65.27 yards, 4.71 catches. This module scores those expected stats with THIS
league's rules (export?TYPE=rules, decoded in
pipelines/etl/scripts/validate_scoring_alignment.py and memory
project_scoring_rules_alignment):

  pass yds 0.04 (+1 @300, +2 @375, +3 @425)   pass TD 6   INT -2   pick-six -4
  rush yds 0.1  (+1 @100, +2 @150, +3 @200, +5 @250)          rush TD 6
  rec yds 0.1   (+2 @100, +3 @150, +5 @200)                   rec TD 6
  receptions: TE 1.5, WR/QB 1.0, RB 0.8        first downs (pass/rush/rec) 0.2
  2-pt conversions 2   fumbles lost -2   sack yards -0.1 a yard

APPROXIMATIONS, stated rather than hidden:
  * yardage bonuses are EXPECTED values: the chance of reaching each threshold
    under a normal spread around the projected yards (coefficient of variation
    0.35 passing, 0.60 rushing, 0.65 receiving);
  * the +1 for a 50+ yard touchdown is ignored (a fraction of a point a season);
  * sack yards are not in the feed, so a passer is charged the league-typical
    ~15 sack yards per 230 projected passing yards;
  * FIRST DOWNS ARE NOT TAKEN FROM THE FEED. Sleeper's rec_fd/pass_fd cannot be
    first downs (Drake London: 6.53 "first downs" on 4.71 projected catches; QBs
    at 20+ passing first downs against a real ~12), so they are rebuilt from
    projected yards at the NFL's 2025 rates, measured from D1 nfl_player_weekly
    (+ _ext): 0.0480 per passing yard, 0.0590 per rushing yard, 0.0498 per
    receiving yard.

Offense only. Kickers, punters and defenders stay on MFL's projections (Keith,
Phase 1: "continue to leverage the stats for MFL projections for IDP").
"""

import math

SLEEPER = ("https://api.sleeper.app/projections/nfl/%d/%d?season_type=regular"
           "&position[]=QB&position[]=RB&position[]=WR&position[]=TE")
OFFENSE = ("QB", "RB", "WR", "TE")
PPR = {"TE": 1.5, "RB": 0.8}
CV = {"pass": 0.35, "rush": 0.60, "rec": 0.65}
FD_PER_YARD = {"pass": 0.0480, "rush": 0.0590, "rec": 0.0498}
BONUS = {"pass": ((300, 1), (375, 2), (425, 3)),
         "rush": ((100, 1), (150, 2), (200, 3), (250, 5)),
         "rec": ((100, 2), (150, 3), (200, 5))}


def _p_at_least(mean, threshold, cv):
    if mean <= 0:
        return 0.0
    sd = max(cv * mean, 1e-6)
    return 0.5 * (1.0 - math.erf((threshold - mean) / (sd * math.sqrt(2.0))))


def _expected_bonus(mean, kind):
    """Tiered bonus: the points for the HIGHEST tier reached, in expectation."""
    tiers = BONUS[kind]
    total = 0.0
    for i, (lo, pts) in enumerate(tiers):
        nxt = tiers[i + 1][0] if i + 1 < len(tiers) else None
        p = _p_at_least(mean, lo, CV[kind]) - (_p_at_least(mean, nxt, CV[kind]) if nxt else 0.0)
        total += p * pts
    return total


def season_rules(season):
    """The two offensive rules that changed over the years (MFL TYPE=rules,
    checked for every season 2018-2026 on 2026-09-16): first downs scored 0.2
    from 2021 (none before), and the tight-end reception premium of 1.5 from
    2025 (1.0 before). Everything else in the table above is identical."""
    season = int(season)
    return {"fd": 0.2 if season >= 2021 else 0.0, "te_ppr": 1.5 if season >= 2025 else 1.0}


def ups_points(stats, position, season=2026):
    """Expected UPS points from a projected (fractional) stat line."""
    g = lambda k: float(stats.get(k) or 0.0)
    pos = (position or "").upper()
    rules = season_rules(season)
    pts = 0.0
    pass_yd = g("pass_yd")
    pts += pass_yd * 0.04 + _expected_bonus(pass_yd, "pass")
    pts += g("pass_td") * 6 + g("pass_int") * -2 + g("pass_int_td") * -4 + g("pass_2pt") * 2
    pts += -0.1 * 15.0 * (pass_yd / 230.0)
    rush_yd = g("rush_yd")
    pts += rush_yd * 0.1 + _expected_bonus(rush_yd, "rush") + g("rush_td") * 6 + g("rush_2pt") * 2
    rec_yd = g("rec_yd")
    pts += rec_yd * 0.1 + _expected_bonus(rec_yd, "rec") + g("rec_td") * 6 + g("rec_2pt") * 2
    pts += g("rec") * (rules["te_ppr"] if pos == "TE" else PPR.get(pos, 1.0))
    pts += (pass_yd * FD_PER_YARD["pass"] + max(rush_yd, 0.0) * FD_PER_YARD["rush"]
            + max(rec_yd, 0.0) * FD_PER_YARD["rec"]) * rules["fd"]
    pts += g("fum_lost") * -2
    return pts


def fetch_week(season, week, fetch):
    """{sleeper_id: {"pos", "points", "updatedAt", "name"}} for one week.

    `fetch(url)` returns parsed JSON (season_sim.fetch with its cache). Fails
    loudly on an unreadable payload -- an empty projection set is never
    silently treated as "everyone scores zero".
    """
    rows = fetch(SLEEPER % (int(season), int(week)))
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("Sleeper projections for %s week %s came back empty or unreadable" % (season, week))
    out = {}
    for r in rows:
        pos = ((r.get("player") or {}).get("position") or "").upper()
        if pos not in OFFENSE or not r.get("player_id"):
            continue
        p = r.get("player") or {}
        out[str(r["player_id"])] = {"pos": pos, "points": ups_points(r.get("stats") or {}, pos, season),
                                    "updatedAt": r.get("updated_at"), "team": (p.get("team") or "").upper(),
                                    "name": ("%s %s" % (p.get("first_name") or "", p.get("last_name") or "")).strip()}
    return out


def norm_name(n):
    """'Walker III, Kenneth' / 'Kenneth Walker III' -> 'kenneth walker'."""
    import re
    n = str(n or "").lower()
    if "," in n:
        last, first = n.split(",", 1)
        n = first.strip() + " " + last.strip()
    n = re.sub(r"[.'\-]", "", n)
    n = re.sub(r"\b(jr|sr|ii|iii|iv|v)\b", "", n)
    return re.sub(r"\s+", " ", n).strip()


# MFL team codes -> the codes Sleeper uses, where they differ.
MFL_TO_NFL_TEAM = {"GBP": "GB", "KCC": "KC", "LVR": "LV", "NEP": "NE", "NOS": "NO", "SFO": "SF",
                   "TBB": "TB", "JAC": "JAX"}
