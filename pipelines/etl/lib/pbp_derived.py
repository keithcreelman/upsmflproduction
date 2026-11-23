"""Play-by-play derivations added for the 2027 Performance screens (R6, 2026-11-23).

Pure functions over nflverse PBP rows (dicts, as `DataFrame.to_dict("records")`
gives them). No I/O: fetch_nflverse_pbp.py feeds the rows in and writes the
results; test_pbp_derived.py checks every rule on hand-built plays.

Three outputs:

1. TEAM PROE SUMS per (season, filter, week, team) -> nfl_team_proe_weekly.
   Additive sums only (plays, dropbacks, sum of xpass, sum of pass_oe), so any
   season or week range is recomputed exactly by summing rows; no rate is ever
   stored. Several NAMED filters are stored side by side; which one the app
   shows is Keith's decision, not this module's.

2. PLAYER-WEEK PBP COLUMNS -> nfl_player_weekly_ext (migration 0182):
   longest rush / reception / completion, sack fumbles (+ lost), missed and
   blocked FG distance lists, punts blocked, and the three mutually exclusive
   inside-20 bands. Each column is written only for player-weeks where it
   APPLIES (a carry, a catch, a completion, a sack, an FG attempt, a punt), so
   NULL means "not applicable / not measured", never zero.

3. PUNT END DISTANCE, the single field the inside-20 bands rest on.

Missing is not zero anywhere here: a play whose needed field is missing is
skipped for that stat and, where it would make a count incomplete, the whole
player-week value is withheld (NULL) instead of undercounted.
"""
from __future__ import annotations

import math

# Bump when a definition below changes, so readers can refuse to mix rows
# built under different rules (the nfl_player_epa.epa_def pattern, 0169).
PROE_DEF_VERSION = 1


# ── small coercions ──────────────────────────────────────────────────────────

def _num(v):
    """float or None. pandas hands missing values over as float NaN."""
    if v is None or isinstance(v, bool):
        return None if v is None else float(v)
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if math.isnan(f) else f


def _int(v):
    f = _num(v)
    return None if f is None else int(round(f))


def _flag(v) -> bool:
    return _num(v) == 1.0


def _id(v):
    """A real player id string, else None (a NaN id is truthy: see _valid_id
    in fetch_nflverse_pbp.py and the 2026-10-10 'nan' player audit)."""
    if isinstance(v, str) and v.strip() and v.strip().lower() != "nan":
        return v.strip()
    return None


def _team(v):
    return v.strip() if isinstance(v, str) and v.strip() else None


# ── 1. Team PROE ─────────────────────────────────────────────────────────────
#
# Source fields (nflverse PBP): play_type, two_point_attempt, posteam, week,
# `pass` (1 = dropback: pass attempt, sack or scramble), `xpass` (nflverse's
# modeled dropback probability, 0..1) and `pass_oe` (= 100 * (pass - xpass),
# verified identical to 0.0 on every 2026 row), plus wp, down, qtr,
# half_seconds_remaining, score_differential for the neutral filters.
#
# Base set ("qualifying plays"), shared by every filter:
#   * play_type is 'pass' or 'run'. That EXCLUDES no_play (penalty-nullified
#     snaps: 1,646 of them carry an xpass in 2026, so nflverse's own season
#     mean includes them), qb_kneel, qb_spike, punt, field_goal, kickoff,
#     extra_point and timeouts/quarter ends;
#   * not a two-point try (nflverse gives them no xpass anyway: 73 in 2026);
#   * xpass and pass_oe both present, pass is 0 or 1, posteam present.
# Fake punts/FGs would be pass/run plays; nflverse marks none with an xpass in
# 2026 (special_teams_play = 0 on every pass/run row), so no extra rule.
#
# Weighting: every stored sum is per play, so a range's PROE is
#   100 * (sum(pass) - sum(xpass)) / plays  ==  sum(pass_oe) / plays,
# i.e. the PLAY-WEIGHTED mean of pass_oe, which is exactly actual dropback rate
# minus expected dropback rate. The game-weighted mean of weekly PROE is a
# different number and is NOT what these rows reproduce.

def _in_wp_band(r) -> bool:
    wp = _num(r.get("wp"))
    return wp is not None and 0.2 <= wp <= 0.8


def _down_in(r, downs) -> bool:
    d = _int(r.get("down"))
    return d is not None and d in downs


def _f_neutral_a(r) -> bool:
    hs = _num(r.get("half_seconds_remaining"))
    return _in_wp_band(r) and _down_in(r, (1, 2, 3)) and hs is not None and hs > 120


def _f_neutral_b(r) -> bool:
    return _f_neutral_a(r) and _down_in(r, (1, 2))


def _f_neutral_c(r) -> bool:
    q = _int(r.get("qtr"))
    sd = _num(r.get("score_differential"))
    return (_in_wp_band(r) and _down_in(r, (1, 2)) and q is not None and q <= 3
            and sd is not None and abs(sd) <= 8)


# Named filters. Keep the names stable: they are stored in the table.
PROE_FILTERS = {
    "all": ("Every qualifying play", lambda r: True),
    "neutral_a": ("Win probability 20-80%, downs 1-3, more than 2:00 left in the half",
                  _f_neutral_a),
    "neutral_b": ("As neutral_a, downs 1-2 only", _f_neutral_b),
    "neutral_c": ("Win probability 20-80%, downs 1-2, quarters 1-3, score within 8",
                  _f_neutral_c),
}


def proe_base(r):
    """(team, week, pass, xpass, pass_oe) for a qualifying play, else None."""
    if r.get("play_type") not in ("pass", "run"):
        return None
    if _flag(r.get("two_point_attempt")):
        return None
    team = _team(r.get("posteam"))
    week = _int(r.get("week"))
    p = _num(r.get("pass"))
    xp = _num(r.get("xpass"))
    oe = _num(r.get("pass_oe"))
    if team is None or week is None or p not in (0.0, 1.0) or xp is None or oe is None:
        return None
    return team, week, p, xp, oe


def proe_team_week(rows, season: int) -> dict:
    """{(season, filter, week, team): {plays, dropbacks, xpass_sum, pass_oe_sum}}."""
    out = {}
    for r in rows:
        b = proe_base(r)
        if b is None:
            continue
        team, week, p, xp, oe = b
        for name, (_label, pred) in PROE_FILTERS.items():
            if not pred(r):
                continue
            k = (season, name, week, team)
            a = out.get(k)
            if a is None:
                a = out[k] = {"plays": 0, "dropbacks": 0, "xpass_sum": 0.0, "pass_oe_sum": 0.0}
            a["plays"] += 1
            a["dropbacks"] += int(p)
            a["xpass_sum"] += xp
            a["pass_oe_sum"] += oe
    # Round the float sums so an unchanged week re-sends byte-identical values
    # and the changed-only upsert (d1_io) writes nothing.
    for a in out.values():
        a["xpass_sum"] = round(a["xpass_sum"], 6)
        a["pass_oe_sum"] = round(a["pass_oe_sum"], 4)
    return out


PROE_COLS = ["season", "filter", "week", "team", "plays", "dropbacks", "xpass_sum", "pass_oe_sum", "proe_def"]


def proe_rows(agg: dict) -> list[tuple]:
    """Rows in PROE_COLS order for nfl_team_proe_weekly."""
    return [(s, f, w, t, a["plays"], a["dropbacks"], a["xpass_sum"], a["pass_oe_sum"], PROE_DEF_VERSION)
            for (s, f, w, t), a in sorted(agg.items())]


def proe_from_sums(rows) -> float | None:
    """PROE in percentage points from stored sums (any week/season range)."""
    plays = sum(r["plays"] for r in rows)
    if plays <= 0:
        return None
    return sum(r["pass_oe_sum"] for r in rows) / plays


# ── 3. Punt end distance and inside-20 bands ────────────────────────────────
#
# end = yardline_100 - kick_distance + return_yards   (return_yards NaN -> 0)
#
# yardline_100 is the punting team's distance to the opponent's goal, so `end`
# is where the play left the ball measured from the RECEIVING team's goal line.
# Not clamped: the old `max(0, kick - return)` clamp (fetch_nflverse_pbp.py) is
# the one v2 found inflating net yards; it changes no 2026 inside-20 call, but
# the bands use the unclamped value.
#
# Inside the 20 = 0 < end < 20 (a ball AT the 20 is not inside; end <= 0 is a
# touchback or end-zone ball). On the 2026 PBP (Weeks 1-11, 1,203 punts) this
# agrees with nflverse `punt_inside_twenty` on 1,203 of 1,203 punts, including
# the 14 returns where a penalty was enforced at the spot. The `<= 20` reading
# disagrees on 28; parsing the "to XXX NN" spot from `desc` disagrees on 60
# (it stops at the catch, before the return); the next scrimmage play's spot
# disagrees on 39 (penalties move it).
#
# Bands (mutually exclusive, together exactly inside-20):
#   lt5     0 < end < 5
#   5to10   5 <= end < 10
#   10to20  10 <= end < 20

PUNT_BANDS = (("punt_i20_lt5", 0, 5), ("punt_i20_5to10", 5, 10), ("punt_i20_10to20", 10, 20))


def punt_end_distance(r):
    yl = _num(r.get("yardline_100"))
    kd = _num(r.get("kick_distance"))
    if yl is None or kd is None:
        return None
    ret = _num(r.get("return_yards"))
    return yl - kd + (ret or 0.0)


def punt_band(end):
    """Band column name for an end distance, or None when not inside the 20."""
    if end is None:
        return None
    for name, lo, hi in PUNT_BANDS:
        if (end > lo if lo == 0 else end >= lo) and end < hi:
            return name
    return None


# ── 2. Player-week PBP columns ───────────────────────────────────────────────

EXT_COLS = [
    "rush_long_pbp", "rec_long_pbp", "pass_long_pbp",
    "sack_fumbles", "sack_fumbles_lost",
    "fg_missed_dists", "fg_blocked_dists",
    "punts_blocked", "punt_i20_lt5", "punt_i20_5to10", "punt_i20_10to20",
]


def _fmt_dists(ds):
    """'33;40' in play order ('' when the kicker missed none). nflverse's own
    fg_missed_list uses the same ';' separator."""
    return ";".join(str(d) for d in ds)


def player_week_ext(rows, season: int, warn=None) -> dict:
    """{(season, week, gsis): {col: value}} for the EXT_COLS that apply.

    Column rules (each set only when it applies to that player-week):
      rush_long_pbp   max rushing_yards over his rush attempts (run plays incl.
                      scrambles and aborted snaps, and kneels, as the box score
                      counts carries); can be negative.
      rec_long_pbp    max receiving_yards over his receptions.
      pass_long_pbp   max passing_yards over his completions.
      sack_fumbles    sacks on which HE fumbled (fumbled_1/2 = the passer);
      sack_fumbles_lost  ...and the other team recovered (fumble_lost = 1 and the
                      recovering team is not his). Both set for every passer
                      sacked at least once, so 0 is a measured zero.
      fg_missed_dists / fg_blocked_dists  ';'-joined kick distances of missed /
                      blocked FGs; '' when none; set for every kicker with an FG
                      attempt. UPS MG (2025/2026 rules) applies to both lists.
      punts_blocked   punt_blocked = 1 plays; set for every punter-week.
      punt_i20_*      bands above; set for every punter-week, and withheld
                      (all three NULL) if the bands do not sum to the count of
                      nflverse punt_inside_twenty flags for that punter-week.
    Two-point tries and no_play rows never count. Laterals: the lateral
    receiver's yards are not part of the original player's long (nflverse
    keeps them in lateral_* columns).
    """
    out = {}
    i20_flag = {}

    def b(gsis, week):
        k = (season, week, gsis)
        a = out.get(k)
        if a is None:
            a = out[k] = {}
        return a

    for r in rows:
        pt = r.get("play_type")
        if pt not in ("run", "pass", "qb_kneel", "field_goal", "punt"):
            continue
        if _flag(r.get("two_point_attempt")):
            continue
        week = _int(r.get("week"))
        if week is None:
            continue

        if pt in ("run", "qb_kneel"):
            rusher = _id(r.get("rusher_player_id"))
            yds = _int(r.get("rushing_yards"))
            if rusher and _flag(r.get("rush_attempt")) and yds is not None:
                a = b(rusher, week)
                a["rush_long_pbp"] = yds if a.get("rush_long_pbp") is None else max(a["rush_long_pbp"], yds)
            continue

        if pt == "pass":
            passer = _id(r.get("passer_player_id"))
            if _flag(r.get("sack")):
                if passer:
                    a = b(passer, week)
                    fumbled = passer in (_id(r.get("fumbled_1_player_id")), _id(r.get("fumbled_2_player_id")))
                    rec_team = _team(r.get("fumble_recovery_1_team"))
                    lost = fumbled and _flag(r.get("fumble_lost")) and rec_team is not None \
                        and rec_team != _team(r.get("posteam"))
                    a["sack_fumbles"] = a.get("sack_fumbles", 0) + (1 if fumbled else 0)
                    a["sack_fumbles_lost"] = a.get("sack_fumbles_lost", 0) + (1 if lost else 0)
                continue
            if _flag(r.get("complete_pass")):
                rcv = _id(r.get("receiver_player_id"))
                ry = _int(r.get("receiving_yards"))
                if rcv and ry is not None:
                    a = b(rcv, week)
                    a["rec_long_pbp"] = ry if a.get("rec_long_pbp") is None else max(a["rec_long_pbp"], ry)
                py = _int(r.get("passing_yards"))
                if passer and py is not None:
                    a = b(passer, week)
                    a["pass_long_pbp"] = py if a.get("pass_long_pbp") is None else max(a["pass_long_pbp"], py)
            continue

        if pt == "field_goal":
            kicker = _id(r.get("kicker_player_id"))
            if not kicker:
                continue
            a = b(kicker, week)
            a.setdefault("_missed", [])
            a.setdefault("_blocked", [])
            res = (r.get("field_goal_result") or "").lower() if isinstance(r.get("field_goal_result"), str) else ""
            dist = _int(r.get("kick_distance"))
            if res in ("missed", "blocked"):
                if dist is None:
                    a["_fg_incomplete"] = True
                else:
                    a["_missed" if res == "missed" else "_blocked"].append(dist)
            elif res != "made":
                a["_fg_incomplete"] = True
            continue

        if pt == "punt":
            punter = _id(r.get("punter_player_id"))
            if not punter:
                continue
            a = b(punter, week)
            for name, _lo, _hi in PUNT_BANDS:
                a.setdefault(name, 0)
            a.setdefault("punts_blocked", 0)
            if _flag(r.get("punt_blocked")):
                a["punts_blocked"] += 1
            band = punt_band(punt_end_distance(r))
            if band:
                a[band] += 1
            k = (season, week, punter)
            i20_flag[k] = i20_flag.get(k, 0) + (1 if _flag(r.get("punt_inside_twenty")) else 0)

    for k, a in out.items():
        if "_missed" in a:
            if a.pop("_fg_incomplete", False):
                a["fg_missed_dists"] = None
                a["fg_blocked_dists"] = None
                if warn:
                    warn(f"fg distances withheld {k}: a miss/block without a distance or an unknown result")
            else:
                a["fg_missed_dists"] = _fmt_dists(a["_missed"])
                a["fg_blocked_dists"] = _fmt_dists(a["_blocked"])
            a.pop("_missed"); a.pop("_blocked")
        if k in i20_flag:
            got = sum(a[n] for n, _lo, _hi in PUNT_BANDS)
            if got != i20_flag[k]:
                if warn:
                    warn(f"inside-20 bands withheld {k}: bands sum {got} != punt_inside_twenty {i20_flag[k]}")
                for n, _lo, _hi in PUNT_BANDS:
                    a[n] = None
    return out


def ext_row(key, a) -> tuple:
    """(season, week, gsis_id, *EXT_COLS) with None for columns that do not apply."""
    return (*key, *[a.get(c) for c in EXT_COLS])
