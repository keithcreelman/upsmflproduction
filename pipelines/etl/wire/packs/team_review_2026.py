"""2026 Team Review pack builder -- parameterized by franchise id.

TEST SCOPE (Keith 2026-09-06): only franchises 0006 and 0008 are wired up
via wire.py's PACK_BUILDERS/PACK_FAMILY, to compare one team that spent
heavily at auction against one that spent little. No quote-finder yet, no
summary article, no other 10 teams -- those are the deferred phases in the
full plan.

Legal-lineup engine: lineup_engine.py, ported from
site/m/front_office_lineup.js. Player value: current REDRAFT ADP (rsf) via
a FRESH pull of the worker's live /api/adp-board (NOT the committed
2026-07-21 docs/auction/data/adp_board_current.json snapshot -- Keith asked
for current ADP, and the auction closed a month after that snapshot was
taken, so it is materially stale for a post-auction team review).
"""
import os
import re
import sys
import json
import urllib.request
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)) + "/..")
import wire_data as D
import wire_pack
import lineup_engine as LE
import idp_value as IV
import tiering

PACK_ID_RE = re.compile(r"^2026-team-(\d{4})$")
SEASON = 2026
PREAUCTION_DATE = "2026-07-23"  # faa_roster_lock_at, from ups_settings.auction_calendar
# The offseason ENDS when the auction does. The last FAA lot was won 2026-08-04
# 15:40 UTC, so this is the first snapshot that contains its result. Reading the
# arc's final stage off "today" instead measured a roster that had since been
# churned by in-season waiver work -- and understated the finish badly: 35
# active here (the roster maximum at the time) versus 30 now. Keith: "you would
# need to look at my roster at the conclusion of the auction not 9/6."
POSTAUCTION_DATE = "2026-08-05"
ROSTER_MAX_AT_AUCTION = 35        # csetup; drops to 30 at the September deadline
# The UPS minimum salary is $1,000 (canon §A1: R6 rookie slot, the $1K flat WW
# salary, and the 2025 switch to a flat $1K opening auction bid all sit here).
# Stated once so nothing downstream can call a $2,000 deal "minimum" -- that
# error reached print in the first 0008 review, on Kayshon Boutte.
LEAGUE_MIN_SALARY = 1000

# canon §B3: an IR player is charged HALF his salary against the cap. Dropping
# him therefore frees only that half, not the full number.
IR_RELIEF_RATE = 0.5

# THE OFFSEASON IN KEITH'S PHASES (2026-09-11). The review follows the calendar
# an owner actually lives through, not a list of topics:
#   s1 Early Preseason  -- April to the rookie draft (first pick 2026-05-24
#                          22:41 UTC, MFL draftResults): cuts, trades,
#                          extensions, and which rookie deals expired
#   s2 Pre-Auction      -- the draft through the auction roster lock: the draft,
#                          the Expired Rookie Auction, tags, and the cuts made
#                          to get under the lock (lock-day cuts included)
#   s3 Auction and Preseason Contracts -- the Free Agent Auction to week one:
#                          buys, every restructure, multi-year contracts, waivers
# Two kinds of move are filed by WHAT they are, not when. Tags are a pre-auction
# decision even though all four landed 05-17..05-22, days before the draft. And
# every restructure belongs with the auction -- "one opens money for the draft,
# but doesn't mean it's fully used" -- split into before/during and after it.
ROOKIE_DRAFT_DATE = "2026-05-24"
WEEK1_DATE = "2026-09-10"
SIM_PATH = os.path.join(D.REPO, "site", "wire", "data", "season_sim_%d.json" % SEASON)
KP_MIN_GAMES = 8


def _phase(day):
    day = str(day)[:10]
    return "s1" if day < ROOKIE_DRAFT_DATE else "s2" if day <= PREAUCTION_DATE else "s3"


def _ord(n):
    n = int(n)
    return "%d%s" % (n, "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th"))


def _poss(name):
    """"The Long Haulers'" -- not "The Long Haulers's"."""
    name = str(name)
    return name + "'" if name.endswith("s") else name + "'s"


_SIM = {}


def _season_sim():
    """The preseason Monte Carlo (pipelines/etl/wire/season_sim.py), committed
    beside the Wire. Fails closed: a review that prints power rankings must be
    reading this season's run, not an old one or none."""
    if not _SIM:
        if not os.path.exists(SIM_PATH):
            raise SystemExit("team_review_2026: %s is missing -- run season_sim.py --season %d --out %s"
                             % (SIM_PATH, SEASON, os.path.relpath(SIM_PATH, D.REPO)))
        d = json.load(open(SIM_PATH, encoding="utf-8"))
        if int(d.get("season") or 0) != SEASON or len(d.get("teams") or []) != 12:
            raise SystemExit("team_review_2026: %s is not a twelve-team %d run" % (SIM_PATH, SEASON))
        if not (d.get("specialTeams") or {}).get("players"):
            raise SystemExit("team_review_2026: %s has no specialTeams block -- rerun season_sim.py" % SIM_PATH)
        _SIM.update(d)
    return _SIM


_SAL_BY_DAY = {}


def _salary_on_or_after(pid, day, horizon=30):
    """A player's salary in the first daily snapshot on or after `day` that
    carries him, looking at most `horizon` snapshots ahead. A trade does not
    change a salary, so this is what moved. The snapshots begin 2026-04-21, so
    the March and April trades read the first snapshot after them. None when no
    snapshot in range has him -- unknown, never $0."""
    seen = 0
    for d in D.snapshot_dates():
        if d < str(day)[:10]:
            continue
        idx = _SAL_BY_DAY.get(d)
        if idx is None:
            idx = {}
            for fr in D.snapshot(d, "rosters")["rosters"]["franchise"]:
                for p in _as_list(fr.get("player")):
                    idx[str(p.get("id"))] = _money(p.get("salary"))
            _SAL_BY_DAY[d] = idx
        if pid in idx and idx[pid] >= LEAGUE_MIN_SALARY:
            return idx[pid]
        seen += 1
        if seen >= horizon:
            break
    return None


_PRIOR_ROSTERS = {}


def _prior_season_rosters():
    """pid -> {fid, status, cy} from MFL's final rosters of the season before.
    contractYear is YEARS REMAINING, so a 'Rookie' deal at cy 1 was in its last
    year and expired into this offseason -- the pool the Expired Rookie Auction
    sold from (all fourteen 2026 ERA players were on a 2025 roster)."""
    if not _PRIOR_ROSTERS:
        url = "https://www48.myfantasyleague.com/%d/export?TYPE=rosters&L=74598&JSON=1" % (SEASON - 1)
        req = urllib.request.Request(url, headers={"User-Agent": "ups-wire-pack-builder"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            d = json.loads(resp.read().decode("utf-8"))
        for fr in _as_list(d["rosters"]["franchise"]):
            for p in _as_list(fr.get("player")):
                _PRIOR_ROSTERS[str(p.get("id"))] = {"fid": str(fr.get("id")).zfill(4),
                                                     "status": str(p.get("contractStatus") or ""),
                                                     "cy": str(p.get("contractYear") or "")}
    return _PRIOR_ROSTERS


def _money(v):
    s = str(v or "").replace("$", "").replace(",", "").strip()
    if not s:
        return 0
    try:
        return int(round(float(s)))
    except ValueError:
        return 0


def _fresh_adp_board():
    """Live redraft-ADP pull, VALUE AND RANK BOTH FROM THE REDRAFT BOARD.

    (bypasses the stale committed July snapshot)

    Uses the endpoint's own `redraft.rsfConsensus` field, NOT a hand-rolled
    mean(fc.rsf, ktc.rsf). First version of this function did the naive mean,
    and it was a real bug (Keith 2026-09-06): when only ONE source has a
    value, KTC and FantasyCalc run on very different scales for backup-tier
    players (e.g. Dallas Goedert: fc=893 vs ktc=3389 -- a ~4x gap), so a
    player missing FC entirely (Michael Mayer: fc=None, ktc=2715) inherited
    KTC's number whole and came out looking BETTER than Goedert and Chig
    Okonkwo, who were correctly dragged down by their own low FC values.
    Same bug inflated Trey Benson (fc=None, ktc=3932) above TreVeyon
    Henderson (fc=1624, ktc=6037, genuinely the better player). The
    endpoint's `redraft.rsfConsensus` already does this correctly (a
    percentile-blend across whichever sources exist, not a raw-dollar
    average) -- confirmed against all four cases above, every one came out
    right. `rsfConfidence` ("single-source" / "agree" / "elevated") is
    carried through as a real caveat on the value, not silently dropped.

    ONE BOARD FOR A WHOLE SEASON'S BUILD. The board is live and moves during
    the day -- the Hawks pack rebuilt at 16:13 read 220 players where the other
    eleven, built 15:02-15:07, read 221 -- so twelve packs built one after
    another are not valued on the same market, and team_review_league.py
    compares them with each other. Set WIRE_ADP_BOARD_CACHE to a file path: the
    first build fetches the board and saves it there, and every later build
    reads the same bytes back. The pack's source entry records when THAT board
    was fetched, not when each build ran.
    """
    global _BOARD_FETCHED_AT
    import datetime as _dt
    import io as _io
    import os as _os
    cache = _os.environ.get("WIRE_ADP_BOARD_CACHE")
    if cache and _os.path.exists(cache):
        c = json.load(_io.open(cache, encoding="utf-8"))
        _BOARD_FETCHED_AT = c["fetchedAt"]
        return c["rsf"], c["name"], c["pos_rank"], c["confidence"]
    _BOARD_FETCHED_AT = _dt.datetime.now(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    base = D.WORKER_BASE + "/api/adp-board"
    rsf, name, pos_rank, confidence = {}, {}, {}, {}
    board_rows = {}
    for pos in ("QB", "RB", "WR", "TE"):
        url = base + "?" + urllib.parse.urlencode({"pos": pos})
        req = urllib.request.Request(url, headers={"User-Agent": "ups-wire-pack-builder"})
        with urllib.request.urlopen(req, timeout=40) as resp:
            d = json.loads(resp.read().decode("utf-8"))
        for x in d.get("board") or []:
            pid = str(x.get("pid") or "")
            if not pid:
                continue
            redraft = x.get("redraft") or {}
            v = redraft.get("rsfConsensus")
            if v is not None:
                rsf[pid] = v
                confidence[pid] = redraft.get("rsfConfidence")
            name[pid] = x.get("name")
            if v is not None:
                # No consensus value means the board has no redraft opinion on
                # him, so he cannot hold a redraft rank either. Leaving him out
                # keeps "unranked" distinct from "ranked last".
                board_rows.setdefault(pos, []).append((pid, v))

    # RANK ON THE SAME NUMBER THE VALUE USES. The board's top-level `posRank`
    # is the DYNASTY rank -- it sits beside `value`, `rank`, `ovr` and `tier`,
    # all dynasty fields, while everything redraft lives under `redraft`. Using
    # it to tier a redraft value silently mixed the two boards, and dynasty
    # punishes age hard: Dak Prescott is posRank 14 (age 33) but REDRAFT QB8,
    # Matthew Stafford posRank 24 but redraft QB11. Every tier, and the entire
    # studs/solid/holes count, was computed off the wrong board until Keith
    # caught the Prescott label. Rank here, from rsfConsensus, over the full
    # board for the position.
    for pos, rows in board_rows.items():
        for i, (pid, _v) in enumerate(sorted(rows, key=lambda r: -r[1]), 1):
            pos_rank[pid] = i
    if cache:
        _io.open(cache, "w", encoding="utf-8").write(json.dumps(
            {"fetchedAt": _BOARD_FETCHED_AT, "rsf": rsf, "name": name,
             "pos_rank": pos_rank, "confidence": confidence}))
    return rsf, name, pos_rank, confidence


_BOARD_FETCHED_AT = None


# The 9 legal-lineup slots whose eligible positions ADP actually prices.
# K/P/DL/LB/DB are salary-filled (see lineup_engine) and excluded here --
# "studs/holes" is a redraft-market read, and ADP has no opinion on them.
_ADP_SLOTS = ("QB1", "RB1", "RB2", "WR1", "WR2", "TE1", "OF1", "OF2", "SF1")


def _tier_counts(lu_, pos_rank, pos_of=None):
    """Classify each of the 9 ADP-priced starting slots by the occupying
    player's position rank: this is the "how many holes, not just how much
    total value" read Keith asked for -- a lineup with a few elite starters
    and real gaps elsewhere looks very different from one that is merely
    adequate everywhere, even at an identical summed value.
      stud  = league-wide top-12 at his position
      solid = top-24
      hole  = startable but outside the top 24 (or the slot has no rank at
              all -- unrostered/off-board, which is also a hole)
    """
    out = {"stud": 0, "solid": 0, "hole": 0}
    if not lu_:
        return out
    for slot_id in _ADP_SLOTS:
        pid = lu_["slots"].get(slot_id)
        rank = pos_rank.get(pid) if pid else None
        if rank is None:
            out["hole"] += 1
        elif pos_of and not tiering.is_starter_grade(pos_of(pid), rank):
            # Past his position's replacement bar he is a hole whatever the raw
            # rank: tight end's bar is 13, so a TE14-24 is "Replacement-level TE"
            # in the slot table and was "solid" here -- the Hawks' Dalton Kincaid
            # read as both, and the count and the named holes disagreed.
            out["hole"] += 1
        elif rank <= 12:
            out["stud"] += 1
        elif rank <= 24:
            out["solid"] += 1
        else:
            out["hole"] += 1
    return out


def _band_for(tiers, rnd, slot):
    """Historical outcome band for a draft slot, exact key or covering range.

    rookie_draft_tiers.json keys rounds 1-3 per exact slot ("3.04") but rounds
    4-6 ONLY as ranges ("4.01-04", "6.05-08"). Looking up an exact label always
    missed there, so every round 4-6 pick printed "no band data" while a real
    band sat in the file -- 0008's 6.08 Zion Young is covered by 6.05-08.
    """
    bands = (tiers or {}).get("bands", {})
    exact = "%d.%02d" % (int(rnd), int(slot))
    hit = bands.get(exact)
    if hit:
        return hit.get("offense", {})
    for key, val in bands.items():
        if "-" not in key or not key.startswith("%d." % int(rnd)):
            continue
        try:
            lo, hi = key.split(".")[1].split("-")
            if int(lo) <= int(slot) <= int(hi):
                return val.get("offense", {})
        except (ValueError, IndexError):
            continue
    return {}


def _tier_slots(lu_, pos_rank, name_of, pos_of):
    """Per-slot occupant + rank + tier, in _ADP_SLOTS order.

    The counts alone were lossy in the way that matters most: replacing a
    top-24 receiver with a top-3 one moves the summed value enormously and the
    stud count by at most one, so the single upgrade an owner actually made can
    read as noise. Keith caught this on his own 2026 review -- the McMillan ->
    Nacua swap was invisible in "1 stud, then 1 stud". Emitting WHO occupies
    each slot at each stage makes the swap legible and lets the prose obey the
    "every ranking claim names players" rule instead of quoting bare integers.
    """
    out = []
    for slot_id in _ADP_SLOTS:
        pid = lu_["slots"].get(slot_id) if lu_ else None
        rank = pos_rank.get(pid) if pid else None
        if not pid:
            out.append((slot_id, None, "(empty)", None, "hole", None))
            continue
        tier = "hole" if rank is None else ("stud" if rank <= 12 else
                                            "solid" if rank <= 24 else "hole")
        out.append((slot_id, pid, name_of(pid), rank, tier, pos_of(pid)))
    return out


def _slot_cell(entry):
    """"Puka Nacua, Elite WR1" -- the same vocabulary the lineup table uses.

    A bare rank in parentheses was still a raw number pretending to be a verdict;
    the tier says the same thing in the words an owner actually uses, and makes
    the McMillan -> Nacua move legible as Low-end WR1 -> Elite WR1 instead of
    "(12)" -> "(3)".
    """
    _slot, _pid, nm, rank, _tier, pos = entry
    if nm == "(empty)":
        return "(nobody rostered)"
    lab = tiering.tier_label(pos, rank)
    return "%s, %s" % (nm, lab) if lab else "%s (unranked)" % nm


_LIVE_ROSTERS = {}


def _live_roster_rows(fid, positions):
    """Today's roster for `fid`, straight from MFL, or None if unreachable.

    The pack used to build EVERY "current" number from the newest committed
    snapshot while reading drops, cap and compliance live. The snapshot lags --
    on the 2026-09-09 build it was three days old -- so the same pack asserted
    in one table that Deshaun Watson and Keenan Allen were useful bench depth
    and in another that they had been released two days earlier, and every
    figure derived from that lineup (value, studs, holes, the four position
    ranks, composite and division rank) was computed over a roster containing
    released players. Fetched once for all twelve franchises and memoised.
    """
    if not _LIVE_ROSTERS:
        try:
            d = D.worker_get("/api/mfl-export", TYPE="rosters", JSON=1)
            for fr in (d.get("rosters") or {}).get("franchise") or []:
                players = fr.get("player") or []
                if isinstance(players, dict):
                    players = [players]
                _LIVE_ROSTERS[str(fr.get("id", "")).zfill(4)] = players
        except Exception:
            _LIVE_ROSTERS["__failed__"] = True
    if _LIVE_ROSTERS.get("__failed__"):
        return None
    players = _LIVE_ROSTERS.get(fid)
    if players is None:
        return None
    out = []
    for p in players:
        pid = str(p.get("id"))
        status = str(p.get("status", "")).upper()
        out.append({
            "pid": pid,
            "pos": positions.get(pid, ""),
            "salary": _money(p.get("salary")),
            "is_taxi": status == "TAXI_SQUAD",
            "is_ir": status == "INJURED_RESERVE",
            "is_expired": False,
        })
    return out


def _roster_rows(date, fid, positions):
    raw = D.snapshot(date, "rosters")
    out = []
    for fr in raw["rosters"]["franchise"]:
        if str(fr["id"]).zfill(4) != fid:
            continue
        players = fr.get("player") or []
        if isinstance(players, dict):
            players = [players]
        for p in players:
            pid = str(p.get("id"))
            status = str(p.get("status", "")).upper()
            out.append({
                "pid": pid,
                "pos": positions.get(pid, ""),
                "salary": _money(p.get("salary")),
                "is_taxi": status == "TAXI_SQUAD",
                "is_ir": status == "INJURED_RESERVE",
                "is_expired": "expired" in str(p.get("contractStatus") or "").lower(),
            })
    return out


def _status_before(fid, iso_date, pid, positions, _cache={}):
    """Where `pid` was sitting just before he was dropped, or None if unknown.

    ROSTER / TAXI_SQUAD / INJURED_RESERVE decide how much cap a drop actually
    frees (taxi none, IR half), so getting this wrong overstates relief.

    The first version walked back from the drop DAY and stopped at the first
    snapshot with any rows -- but the daily snapshot is usually taken AFTER the
    day's transactions, so the dropped player was already gone from it and the
    lookup returned None, which the caller then read as "ordinary roster
    player" and credited full relief. That is how 0006's Luke McCaffrey and
    Xavier Restrepo, both taxi, got a full-salary relief figure. Keep walking
    until a snapshot actually CONTAINS him, and return None only when no
    snapshot in range does -- which the caller must treat as unknown, never as
    ROSTER.
    """
    key = (fid, str(iso_date)[:10], str(pid))
    if key in _cache:
        return _cache[key]
    import datetime
    try:
        d0 = datetime.date.fromisoformat(str(iso_date)[:10])
    except Exception:
        return None
    found = None
    for back in range(0, 45):
        day = (d0 - datetime.timedelta(days=back)).isoformat()
        try:
            rows = _roster_rows(day, fid, positions)
        except Exception:
            continue
        if not rows:
            continue
        for r in rows:
            if r["pid"] == str(pid):
                found = ("TAXI_SQUAD" if r["is_taxi"] else
                         "INJURED_RESERVE" if r["is_ir"] else "ROSTER")
                break
        if found:
            break
    _cache[key] = found
    return found


def _active_salary(date, fid):
    d = D.snapshot(date, "rosters")
    for fr in d["rosters"]["franchise"]:
        if str(fr["id"]).zfill(4) != fid:
            continue
        players = fr.get("player") or []
        if isinstance(players, dict):
            players = [players]
        return sum(_money(p.get("salary")) for p in players
                   if str(p.get("status", "")).upper() == "ROSTER")
    return 0


def _pick_label(round_, roundorder):
    return "%d.%02d" % (round_, roundorder)


_NON_PLAYER_POS = ("Def", "Coach", "Off", "ST")


def _player_universe():
    """pid -> position AND pid -> name in one pass (D.player_positions()
    only keeps position; a name lookup miss must never fall back to
    "Player <id>" in prose -- that anonymous-id bug is exactly what got a
    stale/off-roster player posted to the live OTB Discord channel earlier
    this session)."""
    payload = D.worker_get("/api/mfl-export", TYPE="players", JSON=1)
    players = (payload.get("players") or {}).get("player") or []
    pos, name = {}, {}
    for p in players:
        p_pos = str(p.get("position") or "").strip()
        if not p_pos or p_pos.startswith("TM") or p_pos in _NON_PLAYER_POS:
            continue
        pid = p.get("id")
        if pid:
            pos[str(pid)] = p_pos
            name[str(pid)] = D.display_name(p.get("name"))
    return pos, name



# ---------------------------------------------------------------- week one

def _as_list(v):
    """MFL collapses a one-element collection to a bare object.

    Iterating that dict yields its KEYS -- strings -- so every downstream
    `.get()` raises AttributeError, and it only happens for the teams with
    exactly one match. Franchises 0002 and 0008 (one finished player each) were
    the only two of twelve that crashed.
    """
    if v is None:
        return []
    return v if isinstance(v, list) else [v]


def _live_clock(_cache={}):
    """(week, {nfl_team: game_seconds_remaining}) for MFL's CURRENT scoring week.

    liveScoring carries a per-player `gameSecondsRemaining`, but it lists
    STARTERS only, so the clock is collapsed onto the NFL TEAM and then applied
    to every rostered player -- a benched Patriot is in the same game as a
    started one. 3600 means not kicked off; 0 means final.

    Read from liveScoring, NOT projectedScores: MFL rolls the projection week
    forward the moment the first game starts, so projectedScores.week was 2
    while week 1 was still being played (measured 2026-09-10). Using it here
    would have reported an empty week against a week's worth of real results.
    """
    if _cache:
        return _cache["week"], _cache["clock"]
    ls = D.worker_get("/api/mfl-export", TYPE="liveScoring", JSON="1")
    node = ls.get("liveScoring") or ls.get("data", {}).get("liveScoring") or {}
    week = str(node.get("week") or "")
    positions, _ = _player_universe()
    nfl = _nfl_team_map()
    clock = {}
    for m in _as_list(node.get("matchup")):
        for f in _as_list(m.get("franchise")):
            for p in _as_list((f.get("players") or {}).get("player")):
                secs = p.get("gameSecondsRemaining")
                team = nfl.get(str(p.get("id")))
                if not team or secs is None:
                    continue
                # A team appears once per rostered starter; every one of them
                # reports the same game, so last-write-wins is safe.
                clock[team] = int(secs)
    _cache["week"], _cache["clock"] = week, clock
    return week, clock


def _nfl_team_map(_cache={}):
    """player_id -> NFL team abbreviation, from the MFL players export."""
    if _cache:
        return _cache["m"]
    js = D.worker_get("/api/mfl-export", TYPE="players", JSON="1", DETAILS="1")
    rows = _as_list((js.get("players") or js.get("data", {}).get("players") or {}).get("player"))
    _cache["m"] = {str(p.get("id")): (p.get("team") or "") for p in rows}
    return _cache["m"]


def _week_scores(week, pids, _cache={}):
    """player_id -> fantasy points for `week`, for the given players."""
    key = (week, tuple(sorted(pids)))
    if key in _cache:
        return _cache[key]
    js = D.worker_get("/api/mfl-export", TYPE="playerScores", JSON="1",
                      W=str(week), PLAYERS=",".join(sorted(pids)))
    node = js.get("playerScores") or js.get("data", {}).get("playerScores") or {}
    out = {}
    for r in _as_list(node.get("playerScore")):
        try:
            out[str(r.get("id"))] = float(r.get("score") or 0.0)
        except (TypeError, ValueError):
            continue
    _cache[key] = out
    return out


def _stat_line(pid, week):
    """A human stat line for one completed game, from MFL's `detailed?` report.

    Returns "" when the report has nothing -- a player who did not take a snap
    has no line, and an empty cell must never be dressed up as a zero-yard one.
    """
    try:
        js = D.worker_get("/api/mfl-detailed", YEAR=str(SEASON), P=str(pid), W=str(week))
    except Exception:                                    # noqa: BLE001
        return ""
    if not js.get("found"):
        return ""
    parts = []
    for ln in _as_list(js.get("lines")):
        stat = str(ln.get("stat") or "")
        # "0 Fumbles Lost", "0 Interceptions" -- absence of a bad thing is not
        # a stat line, and printing it makes every line read the same. First
        # downs ARE kept: they score 0.2 each in this league, and dropping them
        # left a line that visibly failed to sum to its own points column.
        if stat.startswith("0 "):
            continue
        parts.append(stat)
    return ", ".join(parts)


def _started_pids(fid, week):
    """The player ids this franchise actually STARTED in `week`, per liveScoring.

    Returns None -- not an empty set -- when liveScoring does not carry the
    franchise, so a missing read can never be mistaken for a team that started
    nobody (canon: an unreadable input is never an empty one).
    """
    ls = D.worker_get("/api/mfl-export", TYPE="liveScoring", JSON="1")
    node = ls.get("liveScoring") or ls.get("data", {}).get("liveScoring") or {}
    for m in _as_list(node.get("matchup")):
        for f in _as_list(m.get("franchise")):
            if str(f.get("id")) != fid:
                continue
            return {str(p.get("id")) for p in _as_list((f.get("players") or {}).get("player"))
                    if str(p.get("status") or "") == "starter"}
    return None


def build(pack_id):
    m = PACK_ID_RE.match(pack_id)
    if not m:
        raise ValueError("team_review_2026 cannot build %r" % pack_id)
    fid = m.group(1)

    owners = D.owner_map(SEASON)
    owner = owners.get(fid, {})
    owner_name = owner.get("owner_name") or fid
    team_name = owner.get("team_name") or fid

    pack = wire_pack.Pack("2026-team-%s" % fid, SEASON,
                           title="2026 Team Review: %s" % team_name)
    pack.owner("owner:%s" % fid, owner_name)
    pack.franchise(SEASON, fid, "owner:%s" % fid, team_name)

    positions, mfl_name = _player_universe()
    pack.source("MFL players export", D.snapshot_dates()[-1] if D.snapshot_dates() else "live", rows=len(positions))

    rsf, adp_name, pos_rank, rsf_confidence = _fresh_adp_board()
    single_source_n = sum(1 for c in rsf_confidence.values() if c == "single-source")
    pack.warn("%d rostered-relevant offense values above come from a single source "
              "(FantasyCalc or KTC alone, not a genuine multi-source agreement) -- these "
              "carry more uncertainty than a value both sources agree on, per the endpoint's "
              "own rsfConfidence flag." % single_source_n)
    pack.source("worker /api/adp-board (live redraft consensus, fc+ktc mean rsf)",
               _BOARD_FETCHED_AT,
               rows=len(rsf), note="current, NOT the 2026-07-21 committed snapshot")

    dates = D.snapshot_dates()
    opening_date = dates[0]
    current_date = dates[-1]
    # `current_date` is the newest COMMITTED SNAPSHOT and is the wrong stamp for
    # anything read live -- it put a three-day-old asof on the compliance, auction
    # and MFL-roster facts in the 2026-09-09 build.
    NOW_UTC = __import__("datetime").datetime.now(
        __import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    pack.warn("Player value throughout is CURRENT redraft-superflex ADP (today's market), "
              "applied to every snapshot -- including the opening and pre-auction rosters. "
              "This measures which players a team held or acquired, not what the market "
              "thought of them at the time. Never read as a claim about historical ADP.")

    idp_rows = IV.load_seasons(D.d1)
    idp_value = IV.par_by_pid(idp_rows, SEASON - 1)
    idp_seasons = IV.seasons_present(idp_rows)
    pack.source("D1 src_weekly (MFL's own official weekly scores, regular season only)",
               current_date, rows=len(idp_rows),
               note="IDP points-above-replacement; seasons per group: " +
                    ", ".join("%s %s" % (p, "-".join(str(s) for s in ss))
                              for p, ss in sorted(idp_seasons.items())))
    pack.warn("IDP value is points-above-replacement computed from REAL production under UPS's own "
              "scoring rules -- not ADP (which does not price defenders) and not auction price (which "
              "is what the league paid, not what a player is worth). A defender's rank comes from the "
              "last completed season; the points-per-rank curve is averaged across seasons. "
              + IV.par_floor_note())
    pack.warn("IDP value supports TIER claims -- 'a top-12 DL', 'startable', 'replacement-level' -- and "
              "NOT fine ordering inside a tier. Year-over-year rank correlation within the top 24 is "
              "about 0.32 at DL, 0.30 at DB and effectively zero at LB, and a within-season split-half "
              "agrees. Never write 'the 4th-best linebacker'.")
    pack.warn("Two DIFFERENT numbers per defender, and they must never be conflated or summed. "
              "'PAR' is a PROJECTION for this season, already regressed. 'realized' is what he actually "
              "produced above replacement LAST season. Myles Garrett is +107.0 realized (8.23 per game) "
              "against a +34.9 projection -- both true, answering different questions. Quote realized as "
              "history ('was worth eight points a game last year'), never as an expectation.")
    pack.warn("The IDP tail is flat but the TOP IS STEEP -- do not describe the position as uniformly "
              "flat. Against a DL26 replacement of 88.5 in 2025: DL1 +107.0, DL2 +72.5, DL12 +19.0, "
              "DL24 +3.0. DL1 to DL2 alone is 34.5 points, a bigger step than DL12 to DL26 spans across "
              "fourteen ranks. An elite defender IS worth a lot; it is the replaceable middle that is "
              "flat, which is what the waiver-wire finding (52%% of top-24 IDP came off the wire vs 6%% "
              "on offense) actually describes. Separately: IDP PAR and offense redraft value are "
              "different scales -- never compare or add them.")
    pack.warn("Regression is the real effect and it bites HARDEST at the top: sweeping the shrink on "
              "last season's top-6 defenders, error rises monotonically from 42.8 at 0.20 to 58.2 at no "
              "shrink. Last year's elite defenders are the group that repeats least, which is why a "
              "realized +107 projects to roughly +35. That gap is the model working, not a bug.")
    pack.warn("The shrink constant (%.2f) was picked by out-of-sample holdout, but the objective is "
              "nearly flat -- 0.25 and 0.73 score within about 2%% of it. Treat it as 'roughly this "
              "much regression', never as a tuned figure." % IV.SHRINK)

    sim = _season_sim()
    kp_proj = sim["specialTeams"]["players"]
    pack.source("site/wire/data/season_sim_%d.json -- preseason Monte Carlo; K/P from MFL projectedScores "
                "weeks %d-%d" % (SEASON, sim["specialTeams"]["weeks"][0], sim["specialTeams"]["weeks"][1]),
                sim["generatedAtUtc"], rows=len(sim["teams"]),
                note="%d runs, regression %.1f (backtested 2021-2025); power rank = expected regular-season "
                     "all-play %%" % (sim["runs"], sim["model"]["regress"]))
    kp_ppg = {}
    _kp_rows = D.d1("SELECT player_id, pos_group, COUNT(DISTINCT week) g, SUM(score) pts FROM src_weekly "
                    "WHERE season=%d AND is_reg=1 AND pos_group IN ('PK','PN') AND score IS NOT NULL "
                    "GROUP BY player_id, pos_group" % (SEASON - 1))
    for _g in ("PK", "PN"):
        _el = sorted(((str(r["player_id"]), float(r["pts"]) / int(r["g"])) for r in _kp_rows
                      if r["pos_group"] == _g and int(r["g"]) >= KP_MIN_GAMES), key=lambda x: (-x[1], x[0]))
        for i, (_pid, _ppg) in enumerate(_el, 1):
            kp_ppg[_pid] = {"rank": i, "ppg": _ppg}
    for r in _kp_rows:
        kp_ppg.setdefault(str(r["player_id"]), {"rank": None, "games": int(r["g"])})
    pack.warn("Kickers and punters are graded on MFL's own %d projections -- weeks 1-17 summed, ranked "
              "league-wide at the position (Keith: 'MFL has kicker forecasts for this season, let's use "
              "that as our source of truth') -- with last season's points-per-game rank beside it "
              "(%d regular-season games minimum). A kicker or punter is a footnote, like defense: one "
              "clause, never a paragraph." % (SEASON, KP_MIN_GAMES))

    def offense_score(r):
        return rsf.get(r["pid"], 0.0)

    def other_score(r):
        # Slot-FILLING only. A defender with no prior-season production has no
        # value here and must never be scored 0 into a reported sum, but the
        # lineup still has to put somebody in the slot -- salary is the
        # tiebreaker for that and nothing else. K/P are scored on MFL's own
        # season projection -- they compete only with each other for the slot.
        if LE.pos_group(r.get("pos") or "") in ("PK", "PN"):
            kp = kp_proj.get(r["pid"])
            if kp:
                return float(kp["seasonProj"])
        hit = idp_value.get(r["pid"])
        return float(hit["par"]) if hit else float(r["salary"]) / 100000.0

    # ---- legal lineup, all 12 teams (needed for league-relative ranks) ----
    all_lineups = {}
    current_rows_by_fid = {}
    _live_ok = True
    for franchise_row in D.d1("SELECT DISTINCT franchise_id FROM src_franchises WHERE season=%d" % SEASON):
        f = str(franchise_row["franchise_id"]).zfill(4)
        rows = _live_roster_rows(f, positions)
        if rows is None:
            _live_ok = False
            rows = _roster_rows(current_date, f, positions)
        if rows:
            all_lineups[f] = LE.build_legal_lineup(rows, offense_score, other_score)
            current_rows_by_fid[f] = rows
    if _live_ok:
        pack.source("MFL rosters export, live (all 12 franchises, for league-relative ranks)",
                   NOW_UTC, rows=sum(len(v["slots"]) for v in all_lineups.values()))
    else:
        # NEVER label a snapshot as live. The lineup and the drop log now
        # disagree about who is rostered, so say so instead of publishing a
        # contradiction quietly.
        pack.source("data/mfl-snapshots/%s/rosters.json (LIVE FETCH FAILED, fell back)" % current_date,
                   current_date, rows=sum(len(v["slots"]) for v in all_lineups.values()))
        pack.warn("The live roster fetch FAILED and the current lineup, bench, position ranks and "
                  "composite fall back to the %s snapshot, while cuts and cap figures are live. "
                  "Those two can disagree about who is on the roster -- do not assert roster "
                  "membership from the lineup or bench table in this build." % current_date)

    pos_value = {"QB": {}, "RB": {}, "WR": {}, "TE": {}}
    flex_fills = {"OF": {}, "SF": {}}
    for f, lu in all_lineups.items():
        by_pos = {"QB": 0, "RB": 0, "WR": 0, "TE": 0}
        for pid in lu["starter_pids"]:
            pg = LE.pos_group(positions.get(pid, ""))
            if pg in by_pos:
                by_pos[pg] += rsf.get(pid, 0)
        for p in pos_value:
            pos_value[p][f] = by_pos[p]
        for slotid, key in (("OF1", "OF"), ("OF2", "OF"), ("SF1", "SF")):
            pid = lu["slots"].get(slotid)
            if pid:
                pg = LE.pos_group(positions.get(pid, ""))
                flex_fills[key][pg] = flex_fills[key].get(pg, 0) + 1

    ranks = {}
    for p, vals in pos_value.items():
        order = sorted(vals.items(), key=lambda kv: -kv[1])
        ranks[p] = {f: i + 1 for i, (f, v) in enumerate(order)}

    weights = {"QB": 1.0, "RB": 2.0, "WR": 2.0, "TE": 1.0}
    of_total = sum(flex_fills["OF"].values()) or 1
    sf_total = sum(flex_fills["SF"].values()) or 1
    for p in ("QB", "RB", "WR", "TE"):
        weights[p] += 2.0 * flex_fills["OF"].get(p, 0) / of_total
        weights[p] += 1.0 * flex_fills["SF"].get(p, 0) / sf_total
    pack.warn("Position weights for the composite score are DERIVED, not asserted: the 6 "
              "single-position starting slots (1 QB, 2 RB, 2 WR, 1 TE) count exactly; the "
              "3 shared slots (2 Flex, 1 SuperFlex) are split by what all 12 teams' own "
              "optimal lineups actually did with them this year. Weights: "
              + ", ".join("%s=%.2f" % (p, w) for p, w in sorted(weights.items())))

    composite = {}
    per_slot = {"QB": 1, "RB": 2, "WR": 2, "TE": 1}
    for f in all_lineups:
        composite[f] = sum(weights[p] * (pos_value[p][f] / per_slot[p]) for p in weights)
    comp_order = sorted(composite.items(), key=lambda kv: -kv[1])
    comp_rank = {f: i + 1 for i, (f, v) in enumerate(comp_order)}

    # ---- this team's detail ----
    lu = all_lineups[fid]
    F = pack.fact

    F("f.team.%s.qb_rank" % fid, "QB starters rank", ranks["QB"][fid], "rank", "lineup_engine", NOW_UTC)
    F("f.team.%s.rb_rank" % fid, "RB starters rank", ranks["RB"][fid], "rank", "lineup_engine", NOW_UTC)
    F("f.team.%s.wr_rank" % fid, "WR starters rank", ranks["WR"][fid], "rank", "lineup_engine", NOW_UTC)
    F("f.team.%s.te_rank" % fid, "TE starters rank", ranks["TE"][fid], "rank", "lineup_engine", NOW_UTC)
    F("f.team.%s.qb_value" % fid, "QB starters redraft value", pos_value["QB"][fid], "count", "adp-board", current_date)
    F("f.team.%s.rb_value" % fid, "RB starters redraft value", pos_value["RB"][fid], "count", "adp-board", current_date)
    F("f.team.%s.wr_value" % fid, "WR starters redraft value", pos_value["WR"][fid], "count", "adp-board", current_date)
    F("f.team.%s.te_value" % fid, "TE starters redraft value", pos_value["TE"][fid], "count", "adp-board", current_date)
    F("f.team.%s.composite_rank" % fid, "Overall power rank", comp_rank[fid], "rank", "lineup_engine", NOW_UTC)
    F("f.team.%s.composite_value" % fid, "Composite score", round(composite[fid]), "count", "lineup_engine", NOW_UTC)
    F("f.league.teams", "Teams in the league", 12, "count", "src_franchises", str(SEASON))

    def _val_display(pid, pg):
        """ONE vocabulary for all 18 slots -- see tiering.py.

        This column used to print a redraft price for offense and a PAR sentence
        for defenders, which is two scales in one column and, worse, two scales
        neither of which a reader can act on. Keith: "these numbers dont make
        sense to people ... high end RB2 or Elite WR1, not 'Worth 6733'". Both
        underlying models still do the work; what they EMIT here is the tier
        they each support.
        """
        if pg in ("QB", "RB", "WR", "TE"):
            lab = tiering.tier_label(pg, pos_rank.get(pid))
            return lab or "unranked by the redraft board"
        if pg in ("DL", "LB", "DB"):
            hit = idp_value.get(pid)
            if not hit:
                # No prior season is UNKNOWN, never zero -- a rookie and a
                # washed veteran are not the same thing and neither is a 0.
                return "no prior-season production"
            return tiering.tier_label(hit["pos"], hit["rank"]) or "unranked"
        if pg in ("PK", "PN"):
            kp = kp_proj.get(pid)
            if not kp:
                return "not projected by MFL"
            lab = tiering.tier_label(pg, kp["rank"]) or "unranked"
            last = kp_ppg.get(pid)
            # Comma-separated: wire_render.tier_strings splits cells on commas to
            # learn which tier labels prose may quote.
            if last and last.get("rank"):
                return "%s, %s in points per game in %d" % (lab, _ord(last["rank"]), SEASON - 1)
            if last:
                return "%s, only %d games in %d" % (lab, last["games"], SEASON - 1)
            return "%s, no %d games" % (lab, SEASON - 1)
        return "no ranking source (salary-filled)"

    # lineup table
    lineup_rows = []
    for s in LE.LINEUP_SLOTS:
        pid = lu["slots"].get(s["id"])
        if not pid:
            lineup_rows.append([s["label"], "—", "—", "—"])
            continue
        pg = LE.pos_group(positions.get(pid, ""))
        name = adp_name.get(pid) or mfl_name.get(pid, "Unknown player %s" % pid)
        lineup_rows.append([s["label"], name, positions.get(pid, "?"), _val_display(pid, pg)])
    t_lineup = pack.table("t.%s.lineup" % fid, "Legal starting lineup",
                          [{"key": "slot", "label": "Slot", "type": "text"},
                           {"key": "player", "label": "Player", "type": "text"},
                           {"key": "pos", "label": "Pos", "type": "text"},
                           {"key": "val", "label": "Value", "type": "text"}],
                          lineup_rows,
                          note="Offense (QB/RB/WR/TE) filled by current redraft ADP. DL/LB/DB filled by "
                               "points-above-replacement from real production under UPS scoring, where the "
                               "player has a prior season. A defender with no prior-season production is "
                               "unvalued (not zero) and only salary-filled if the slot would otherwise go "
                               "empty. K/P have neither source and are salary-filled. Fixed slots before flex.")

    # bench / depth
    # ONE sort key cannot span two scales. rsf is redraft dollars (thousands)
    # and other_score is PAR (tens) or salary/100000 (a fraction), so every
    # priced offense player outranked every defender and the bench of the
    # league's most active IDP manager came out as ten offense players and zero
    # defenders. Rank within each side, then interleave, so the table shows
    # depth on both sides of the ball.
    _off, _def = [], []
    for r in lu["bench"]:
        (_off if LE.pos_group(r["pos"]) in ("QB", "RB", "WR", "TE") else _def).append(r)
    _off.sort(key=lambda r: -(rsf.get(r["pid"]) or 0))
    _def.sort(key=lambda r: -other_score(r))
    bench_sorted = []
    while len(bench_sorted) < 10 and (_off or _def):
        if _off:
            bench_sorted.append(_off.pop(0))
        if len(bench_sorted) < 10 and _def:
            bench_sorted.append(_def.pop(0))
    bench_rows = []
    for r in bench_sorted:
        pg = LE.pos_group(r["pos"])
        bench_rows.append([adp_name.get(r["pid"]) or mfl_name.get(r["pid"], "Unknown player %s" % r["pid"]), r["pos"],
                           _val_display(r["pid"], pg), r["salary"]])
    t_bench = pack.table("t.%s.bench" % fid, "Useful depth (bench, top 10 by value)",
                         [{"key": "player", "label": "Player", "type": "text"},
                          {"key": "pos", "label": "Pos", "type": "text"},
                          {"key": "val", "label": "2026 redraft value", "type": "text"},
                          {"key": "sal", "label": "Salary", "type": "usd"}],
                         bench_rows, note="Descriptive only -- does not feed the composite score.")

    # ---- the bridge ----
    open_rows = _roster_rows(opening_date, fid, positions)
    pre_rows = _roster_rows(PREAUCTION_DATE, fid, positions)
    # The arc's final stage is the auction close and must be that date in EVERY
    # column. The first cut moved only the roster count to POSTAUCTION_DATE and
    # left the cap live and the lineup on the newest snapshot, so one row read
    # "When the auction closed / 2026-08-05" while carrying today's cap and a
    # 2026-09-06 lineup -- and the slot table claimed Parker Washington and
    # Kyler Murray filled their slots on 08-05, which nothing establishes.
    post_rows = _roster_rows(POSTAUCTION_DATE, fid, positions)
    lu_open = LE.build_legal_lineup(open_rows, offense_score, other_score) if open_rows else None
    lu_pre = LE.build_legal_lineup(pre_rows, offense_score, other_score) if pre_rows else None
    lu_post = LE.build_legal_lineup(post_rows, offense_score, other_score) if post_rows else None

    def lineup_val(lu_):
        if not lu_:
            return 0
        return sum(rsf.get(pid, 0) for pid in lu_["starter_pids"]
                   if LE.pos_group(positions.get(pid, "")) in ("QB", "RB", "WR", "TE"))

    cap_open = _active_salary(opening_date, fid)
    cap_pre = _active_salary(PREAUCTION_DATE, fid)
    cap_post = _active_salary(POSTAUCTION_DATE, fid)
    compliance = D.worker_get("/api/auction/compliance", YEAR=SEASON)
    comp_row = next((c for c in compliance.get("franchises", [])
                     if str(c.get("fid", "")).zfill(4) == fid), {})
    cap_current_spent = (comp_row.get("cap_spent_k") or 0) * 1000
    cap_current_room = (comp_row.get("cap_room_k") or 0) * 1000
    active_count = comp_row.get("active_count")

    F("f.team.%s.cap_opening" % fid, "Active-roster salary, opening snapshot", cap_open, "usd", "roster_salaries", opening_date)
    F("f.team.%s.cap_preauction" % fid, "Active-roster salary, entering the auction", cap_pre, "usd", "roster_salaries", PREAUCTION_DATE)
    if not comp_row:
        pack.warn("This franchise is absent from /api/auction/compliance, so cap committed, cap "
                  "room and the active-roster count are NOT KNOWN. They are omitted rather than "
                  "published as zero.")
    F("f.team.%s.cap_current_spent" % fid, "Cap committed now", cap_current_spent, "usd", "auction/compliance", NOW_UTC)
    F("f.team.%s.cap_current_room" % fid, "Cap room now", cap_current_room, "usd", "auction/compliance", NOW_UTC)
    F("f.team.%s.active_now" % fid, "Active roster now", active_count or 0, "count", "auction/compliance", NOW_UTC)
    F("f.team.%s.lineup_value_opening" % fid, "Legal-lineup offense value, opening (today's market)", lineup_val(lu_open), "count", "lineup_engine+adp-board", opening_date)
    F("f.team.%s.lineup_value_preauction" % fid, "Legal-lineup offense value, entering the auction (today's market)", lineup_val(lu_pre), "count", "lineup_engine+adp-board", PREAUCTION_DATE)
    F("f.team.%s.lineup_value_postauction" % fid, "Legal-lineup offense value when the auction closed (today's market)", lineup_val(lu_post), "count", "lineup_engine+adp-board", POSTAUCTION_DATE)
    F("f.team.%s.lineup_value_current" % fid, "Legal-lineup offense value, today", lineup_val(lu), "count", "lineup_engine+adp-board", NOW_UTC)
    pack.warn("Opening/pre-auction cap figures are ACTIVE-ROSTER SALARY ONLY (no salaryAdjustments); "
              "the live 'cap committed now' figure DOES include adjustments. The two are not "
              "subtractable -- they measure different things.")

    _pos_of = lambda pid: LE.pos_group(positions.get(pid, ""))
    tiers_open = _tier_counts(lu_open, pos_rank, _pos_of)
    tiers_pre = _tier_counts(lu_pre, pos_rank, _pos_of)
    tiers_post = _tier_counts(lu_post, pos_rank, _pos_of)
    tiers_now = _tier_counts(lu, pos_rank, _pos_of)
    F("f.team.%s.holes_opening" % fid, "Starting-lineup holes, opening (of 9 ADP-priced slots)", tiers_open["hole"], "count", "lineup_engine+adp-board", opening_date)
    F("f.team.%s.studs_opening" % fid, "Starting-lineup studs, opening (top-12 at position)", tiers_open["stud"], "count", "lineup_engine+adp-board", opening_date)
    F("f.team.%s.holes_postauction" % fid, "Starting-lineup holes when the auction closed (of 9 ADP-priced slots)", tiers_post["hole"], "count", "lineup_engine+adp-board", POSTAUCTION_DATE)
    F("f.team.%s.studs_postauction" % fid, "Starting-lineup studs when the auction closed (top-12 at position)", tiers_post["stud"], "count", "lineup_engine+adp-board", POSTAUCTION_DATE)
    F("f.team.%s.holes_today" % fid, "Starting-lineup holes today (of 9 ADP-priced slots)", tiers_now["hole"], "count", "lineup_engine+adp-board", NOW_UTC)
    F("f.team.%s.studs_today" % fid, "Starting-lineup studs today (top-12 at position)", tiers_now["stud"], "count", "lineup_engine+adp-board", NOW_UTC)
    pack.warn("Studs/solid/holes classify each of the 9 ADP-priced starting slots (QB, 2xRB, "
              "2xWR, TE, 2x Flex, SuperFlex) by the occupying player's LEAGUE-WIDE position rank: "
              "stud = top 12 at his position, solid = top 24, hole = outside the top 24 or the slot "
              "has no rank at all. This is a needs read, not a value total -- two teams can carry "
              "the identical summed lineup value with completely different hole counts (a few elite "
              "starters and real gaps, versus adequate-everywhere), and that difference is the point.")

    # THE OPTIMIZER ALWAYS RETURNS A LINEUP. THAT IS NOT THE SAME AS HAVING ONE.
    # fill_slots() assigns the best available body to every slot no matter how
    # thin the roster, so an April roster of 14 active players still produced a
    # tidy nine-slot "lineup" -- and the article then reported those assignments
    # as decisions: "Emanuel Wilson at RB2", "Keon Coleman occupying the
    # superflex". Keith, correctly: "don't say so and so was in the flex because
    # that's not true ... my lineup wasn't fully built." UPS starts 18. A roster
    # below that cannot field a lineup, and its slot assignments are artefacts of
    # the optimizer, not facts about the team. Same bug class as the Submit
    # Lineup panel showing optimizer output as a submitted lineup.
    STARTING_SLOTS = len(LE.LINEUP_SLOTS)

    def _roster_shape(date, live=False):
        # "Now" has to mean now. The committed snapshot lags by days, and on this
        # build it was three days stale -- reporting 32 active when the real
        # number was 30, because two in-year flyers had been dropped since.
        # Keith caught the total the same way ("it really went to 35"). For the
        # current stage, read MFL directly and fall back to the snapshot only if
        # that fails; a stale number here is worse than a slow build.
        rows = None
        if live:
            try:
                d = D.worker_get("/api/mfl-export", TYPE="rosters", JSON=1)
                for fr in (d.get("rosters") or {}).get("franchise") or []:
                    if str(fr.get("id", "")).zfill(4) != fid:
                        continue
                    players = fr.get("player") or []
                    if isinstance(players, dict):
                        players = [players]
                    rows = [{"pid": str(p.get("id")),
                             "pos": positions.get(str(p.get("id")), ""),
                             "salary": _money(p.get("salary")),
                             "is_taxi": str(p.get("status", "")).upper() == "TAXI_SQUAD",
                             "is_ir": str(p.get("status", "")).upper() == "INJURED_RESERVE",
                             "is_expired": False} for p in players]
            except Exception:
                rows = None                      # fall through to the snapshot
        if rows is None:
            rows = _roster_rows(date, fid, positions)
        active = [r for r in rows if not r["is_taxi"] and not r["is_ir"]]
        return {"total": len(rows), "active": len(active),
                "taxi": sum(1 for r in rows if r["is_taxi"]),
                "ir": sum(1 for r in rows if r["is_ir"]),
                "can_field": len(active) >= STARTING_SLOTS}

    shape_open, shape_pre, shape_now = (_roster_shape(opening_date),
                                        _roster_shape(PREAUCTION_DATE),
                                        _roster_shape(POSTAUCTION_DATE))
    F("f.team.%s.roster_total_postauction" % fid,
      "Players on the roster when the auction closed, including taxi and IR",
      shape_now["total"], "count", "src rosters", POSTAUCTION_DATE)
    F("f.league.roster_max_at_auction", "Roster maximum while the auction was open",
      ROSTER_MAX_AT_AUCTION, "count", "csetup", str(SEASON))
    shape_today = _roster_shape(current_date, live=True)
    F("f.team.%s.active_today" % fid, "Active players on the roster today",
      shape_today["active"], "count", "MFL rosters (live)", NOW_UTC)
    F("f.team.%s.taxi_now" % fid, "Taxi-squad players today", shape_today["taxi"],
      "count", "MFL rosters (live)", NOW_UTC)
    F("f.team.%s.ir_now" % fid, "Players on injured reserve today", shape_today["ir"],
      "count", "MFL rosters (live)", NOW_UTC)
    for tag, date, sh in (("opening", opening_date, shape_open),
                          ("preauction", PREAUCTION_DATE, shape_pre),
                          ("current", POSTAUCTION_DATE, shape_now)):
        F("f.team.%s.active_roster_%s" % (fid, tag),
          "Active players on the roster (%s)" % tag, sh["active"], "count", "src rosters", date)
        F("f.team.%s.can_field_lineup_%s" % (fid, tag),
          "Could field a legal %d-man lineup (%s)" % (STARTING_SLOTS, tag),
          "yes" if sh["can_field"] else "no", "text", "src rosters", date)
    if not shape_open["can_field"]:
        pack.warn("AT %s THIS ROSTER COULD NOT FIELD A LINEUP: %d active players against %d "
                  "starting slots (taxi and IR do not count toward either). There was no lineup "
                  "at that stage, so the slot-by-slot table's opening column is the OPTIMIZER'S "
                  "best available body per slot, NOT a lineup the owner set or intended. Do not "
                  "write that a player 'was in the flex' or 'started at RB2' in a stage marked "
                  "no -- say what the roster actually was: how many players, and which contracts "
                  "were still on it. Contracts expiring on schedule is the league's normal cycle "
                  "and is not itself a finding."
                  % (opening_date, shape_open["active"], STARTING_SLOTS))

    t_bridge = pack.table("t.%s.bridge" % fid, "The offseason bridge",
                          [{"key": "stage", "label": "Stage", "type": "text"},
                           {"key": "date", "label": "Date", "type": "text"},
                           {"key": "roster", "label": "Active roster (min 27, starts 18)", "type": "count"},
                           {"key": "fieldable", "label": "Could field a lineup?", "type": "text"},
                           {"key": "cap", "label": "Active salary / cap spent", "type": "usd"},
                           {"key": "lineupval", "label": "Legal-lineup offense value (today's market)", "type": "count"},
                           {"key": "studs", "label": "Studs (top-12)", "type": "count"},
                           {"key": "solid", "label": "Solid (top-24)", "type": "count"},
                           {"key": "holes", "label": "Holes (of 9)", "type": "count"}],
                          [
                              ["Entering the offseason", opening_date, shape_open["active"],
                               "yes" if shape_open["can_field"] else "no", cap_open, lineup_val(lu_open),
                               tiers_open["stud"], tiers_open["solid"], tiers_open["hole"]],
                              ["Entering the auction", PREAUCTION_DATE, shape_pre["active"],
                               "yes" if shape_pre["can_field"] else "no", cap_pre, lineup_val(lu_pre),
                               tiers_pre["stud"], tiers_pre["solid"], tiers_pre["hole"]],
                              ["When the auction closed", POSTAUCTION_DATE, shape_now["active"],
                               "yes" if shape_now["can_field"] else "no", cap_post, lineup_val(lu_post),
                               tiers_post["stud"], tiers_post["solid"], tiers_post["hole"]],
                          ],
                          note="'Could field a lineup?' is the gate on every other number in that "
                               "row: where it says no, the roster had fewer than %d active players "
                               "and there was NO lineup -- the value and stud/hole figures come from "
                               "the optimizer filling slots with whoever was on hand, and must never "
                               "be described as the owner's lineup or his choices." % STARTING_SLOTS)

    # Same three stages, but slot by slot and BY NAME -- see _tier_slots for why
    # the counts on their own were not enough.
    _nm = lambda pid: adp_name.get(pid) or mfl_name.get(pid, "Unknown player %s" % pid)
    _pg = lambda pid: LE.pos_group(positions.get(pid, ""))
    slots_open, slots_pre, slots_now = (_tier_slots(lu_open, pos_rank, _nm, _pg),
                                        _tier_slots(lu_pre, pos_rank, _nm, _pg),
                                        _tier_slots(lu_post, pos_rank, _nm, _pg))
    t_slots = pack.table("t.%s.slot_bridge" % fid, "Who filled each priced slot, stage by stage",
                         [{"key": "slot", "label": "Slot", "type": "text"},
                          {"key": "open", "label": "Entering the offseason%s"
                           % ("" if shape_open["can_field"] else " (NO LINEUP -- best available only)"), "type": "text"},
                          {"key": "pre", "label": "Entering the auction%s"
                           % ("" if shape_pre["can_field"] else " (NO LINEUP -- best available only)"), "type": "text"},
                          {"key": "now", "label": "When the auction closed", "type": "text"}],
                         [[a[0], _slot_cell(a), _slot_cell(b), _slot_cell(c)]
                          for a, b, c in zip(slots_open, slots_pre, slots_now)],
                         note="Parenthesised number is the player's LEAGUE-WIDE rank at his "
                              "position on the live redraft board: <=12 is a stud, <=24 solid, "
                              "beyond that (or unranked, or empty) a hole. Use these NAMES when "
                              "describing how the lineup changed -- a stud count moving 1 -> 2 can "
                              "conceal the largest single upgrade of the offseason.")

    # ---- auction ----
    # UPS RUNS TWO SEPARATE AUCTIONS AND THEY ARE NOT ONE EVENT (Keith
    # 2026-09-09). The Expired Rookie Auction (ERA) sells players whose rookie
    # deals ran out; the Free Agent Auction (FAA) is the open market months
    # later. Different pools, different money, different strategy -- summing
    # them into one "auction spend" reported a $194,000 auction that never
    # happened, and buried a $9,000 ERA inside a $185,000 FAA.
    lots = D.worker_get("/api/auction/lots", status="won").get("lots", [])
    my_lots = [l for l in lots if str(l.get("winner_fid", "")).zfill(4) == fid and not l.get("is_test")]

    def _cycle(l):
        return "ERA" if l.get("is_era_eligible") else "FAA"

    # The flag and the calendar have to agree. They do for 2026 (ERA opened
    # 05-25..05-28, FAA 07-25..08-03, a two-month gap), but a silent
    # disagreement would mis-attribute spend, so assert it rather than assume.
    _windows = {}
    for l in lots:
        if l.get("is_test"):
            continue
        t = l.get("opened_at_unix") or 0
        w = _windows.setdefault(_cycle(l), [t, t])
        w[0], w[1] = min(w[0], t), max(w[1], t)
    if len(_windows) < 2:
        pack.warn("Only one auction cycle was identifiable from is_era_eligible, so the ERA/FAA "
                  "split could NOT be cross-checked against the calendar. Every dollar may be "
                  "attributed to one auction -- treat the ERA and FAA figures as unverified.")
    elif not (_windows["ERA"][0] and _windows["FAA"][0]):
        pack.warn("Auction lots are missing opened_at_unix, so the ERA/FAA calendar cross-check "
                  "could not run. The split rests on is_era_eligible alone here.")
    elif _windows["ERA"][1] >= _windows["FAA"][0]:
        pack.warn("ERA and FAA lot windows OVERLAP on the calendar -- the "
                  "is_era_eligible split may no longer identify the auction cycle. "
                  "Auction figures below are suspect until this is checked.")

    # THE TWO POOLS ARE NOT THE SAME CALIBER AND MUST NOT BE GRADED ALIKE
    # (Keith: "the ERA doesn't have the same caliber of talent"). The ERA sells
    # players whose ROOKIE DEALS EXPIRED -- by construction, men who did not
    # earn a second contract -- and it is tiny. Judging an ERA buy by whether it
    # starts, next to a free-agent market whose top player went for more than
    # ten times the ERA's most expensive, is a category error.
    _all_era = [l for l in lots if not l.get("is_test") and _cycle(l) == "ERA"]
    _all_faa = [l for l in lots if not l.get("is_test") and _cycle(l) == "FAA"]
    _px = lambda ls: max([(l.get("current_high_bid_k") or 0) * 1000 for l in ls] or [0])
    F("f.league.era_pool_size", "Players sold in the Expired Rookie Auction, league-wide",
      len(_all_era), "count", "auction/lots", NOW_UTC)
    F("f.league.era_top_price", "Most expensive player in the Expired Rookie Auction, league-wide",
      _px(_all_era), "usd", "auction/lots", NOW_UTC)
    F("f.league.faa_top_price", "Most expensive player in the Free Agent Auction, league-wide",
      _px(_all_faa), "usd", "auction/lots", NOW_UTC)
    pack.warn("The Expired Rookie Auction and the Free Agent Auction sell different CALIBERS of "
              "player, not just different players. The ERA pool is expired rookie contracts -- men "
              "who did not earn a second deal -- and league-wide its most expensive player went for "
              "$%s against the FAA's $%s. Never grade an ERA buy against an FAA buy, and never treat "
              "'no ERA purchase is starting' as a finding; that is what the pool is."
              % ("{:,}".format(_px(_all_era)), "{:,}".format(_px(_all_faa))))

    era_lots = [l for l in my_lots if _cycle(l) == "ERA"]
    faa_lots = [l for l in my_lots if _cycle(l) == "FAA"]
    _sp = lambda ls: sum((l.get("current_high_bid_k") or 0) * 1000 for l in ls)
    spend, era_spend, faa_spend = _sp(my_lots), _sp(era_lots), _sp(faa_lots)
    top = max(faa_lots, key=lambda l: l.get("current_high_bid_k") or 0) if faa_lots else None

    F("f.team.%s.era_spend" % fid, "Expired Rookie Auction spend", era_spend, "usd", "auction/lots", NOW_UTC)
    F("f.team.%s.era_lots_won" % fid, "Expired Rookie Auction lots won", len(era_lots), "count", "auction/lots", NOW_UTC)
    F("f.team.%s.faa_spend" % fid, "Free Agent Auction spend", faa_spend, "usd", "auction/lots", NOW_UTC)
    F("f.team.%s.faa_lots_won" % fid, "Free Agent Auction lots won", len(faa_lots), "count", "auction/lots", NOW_UTC)
    F("f.team.%s.auction_spend" % fid, "Both auctions combined", spend, "usd", "auction/lots", NOW_UTC)
    if top:
        F("f.team.%s.top_buy_price" % fid, "Top Free Agent Auction buy, price", (top.get("current_high_bid_k") or 0) * 1000, "usd", "auction/lots", NOW_UTC)
        pct = 100.0 * ((top.get("current_high_bid_k") or 0) * 1000) / faa_spend if faa_spend else 0
        F("f.team.%s.top_buy_pct_of_spend" % fid, "Top buy as % of Free Agent Auction spend", pct, "percent", "auction/lots", NOW_UTC)
    t_auction = pack.table("t.%s.auction" % fid, "Auction wins",
                           [{"key": "auction", "label": "Auction", "type": "text"},
                            {"key": "player", "label": "Player", "type": "text"},
                            {"key": "pos", "label": "Pos", "type": "text"},
                            {"key": "price", "label": "Price", "type": "usd"},
                            {"key": "bids", "label": "Bids", "type": "count"}],
                           sorted([[_cycle(l), l.get("player_name"), l.get("position"),
                                    (l.get("current_high_bid_k") or 0) * 1000, l.get("bid_count") or 0]
                                  for l in my_lots], key=lambda r: (r[0], -r[3])),
                           note="TWO SEPARATE AUCTIONS. ERA = Expired Rookie Auction (players whose "
                                "rookie contracts ran out); FAA = Free Agent Auction, the open market "
                                "months later. Never add them into a single 'auction spend' and never "
                                "describe an ERA buy as a free-agent signing or vice versa.")

    # ---- cuts ----
    # Scoped to THIS season and league. The previous query selected on
    # franchise_id alone, which is how a 2027-deferred obligation ended up
    # summed into a "total cap penalty" headline alongside 2026 charges.
    drops = D.d1("SELECT player_id, dropped_at_iso, dropped_at_unix, pre_drop_salary, pre_drop_tcv, "
                 "pre_drop_contract_length, penalty_amount, penalty_basis, penalty_exempt, "
                 "applies_to_season FROM ups_drop_events "
                 "WHERE franchise_id='%s' AND season=%d ORDER BY dropped_at_iso" % (fid, SEASON))

    # A drop is not automatically a CUT. Three things were being counted as one:
    #   1. the make-room leg of a BBID waiver claim (you bid $1K and drop a body
    #      to fit him) -- that is a roster swap, not a release;
    #   2. an in-year flyer signed and discarded inside the same offseason,
    #      which was never part of the team you carried. NOTE this is a TIMING
    #      test (not on the opening roster), never a salary one -- 0008's Mac
    #      Jones flyer was $4,000. Calling the bucket "minimum-salary" was a
    #      claim the code does not check and in that case was simply false.
    #   3. an actual cut of a contract carried into the league year.
    # Only (3) is what an owner means by "I cut him", and conflating them turned
    # 6 real cuts into a headline of 20.
    waiver_swap_pids = set()
    try:
        tx = D.worker_get("/api/mfl-export", TYPE="transactions", JSON=1)
        rows_tx = (tx.get("transactions") or {}).get("transaction") or []
        if isinstance(rows_tx, dict):
            rows_tx = [rows_tx]
        for t in rows_tx:
            if str(t.get("type")) != "BBID_WAIVER" or str(t.get("franchise", "")).zfill(4) != fid:
                continue
            parts = str(t.get("transaction") or "").split("|")
            # BBID_WAIVER is "<added>,|<bid>|<dropped>,": the third segment is
            # the body released to make room for the claim.
            for seg in parts[2:]:
                for tok in seg.split(","):
                    tok = tok.strip()
                    if tok.isdigit():
                        waiver_swap_pids.add(tok)
        _waiver_ok = True
    except Exception:
        # This claimed to "classify nothing, do not guess" and then guessed: with
        # an empty set _kind() calls every make-room drop a cut or a flyer, which
        # is the 6-into-20 inflation the block exists to prevent (12 of 0008's 20
        # removals). Say so loudly instead of publishing a wrong headline.
        waiver_swap_pids = set()
        _waiver_ok = False

    if not _waiver_ok:
        pack.warn("The MFL transaction log could not be read, so NO drop could be identified as "
                  "the make-room half of a waiver claim. 'Contracts cut' is therefore an UPPER "
                  "BOUND and is probably badly inflated -- do not quote the cut count or name "
                  "these as releases in this build.")
    _open_roster = _roster_rows(opening_date, fid, positions)
    if not _open_roster:
        pack.warn("The opening-day roster snapshot (%s) is empty or unreadable, so every drop "
                  "looks like a player who was never on the opening roster and is classified an "
                  "'in-year flyer'. That classification is unusable in this build."
                  % opening_date)
    opening_pids = {r["pid"] for r in _open_roster}

    def _kind(d):
        pid = str(d.get("player_id"))
        if pid in waiver_swap_pids:
            return "waiver swap"
        if pid not in opening_pids:
            return "in-year flyer"
        return "cut"

    cut_rows = []
    for d in drops:
        pid = str(d.get("player_id"))
        # Deliberately NOT `or 0`. A NULL is unknown -- and so is a stored ZERO:
        # no rostered player in this league can cost $0 (the minimum is $1,000),
        # so a 0 is MFL's blank contract already coerced to a number at ingest
        # (canon: blank != $0). 2 NULL and 7 zero rows exist for 2026; publishing
        # "$0 salary removed" asserts a measurement in every one of them.
        sal = d.get("pre_drop_salary")
        try:
            sal = int(sal)
        except (TypeError, ValueError):
            sal = None
        if sal is not None and sal < LEAGUE_MIN_SALARY:
            sal = None
        pen = d.get("penalty_amount") or 0
        # Which cap year the penalty lands in is a per-row fact and has to be
        # readable AS a row. The totals were already split (cuts_penalty_2026 vs
        # _deferred), but the table showed a bare "Penalty" column, so a reader
        # -- human or model -- could only add them up into one number, which is
        # exactly the §D1 error the split was meant to prevent.
        # migration 0125 adds applies_to_season with "NO BACKFILL HERE,
        # DELIBERATELY" -- the worker stamps a row only when it next touches it,
        # so NULL is a normal state, not an anomaly. Defaulting it to SEASON
        # asserts a 2027 obligation is due now, which is exactly the §D1 error
        # the split exists to prevent.
        _raw_applies = d.get("applies_to_season")
        applies = int(_raw_applies) if _raw_applies not in (None, "") else None
        if not pen:
            charged = "--"
        elif applies is None:
            charged = "not yet stamped"
        elif applies > SEASON:
            charged = "%d (deferred)" % applies
        else:
            charged = str(applies)
        # NET RELIEF IS ONLY WHAT THE CAP WAS ACTUALLY BEING CHARGED (Keith
        # 2026-09-09, on Blake Watson: "Watson was a taxi player so there's no
        # net relief"). Taxi salaries are excluded from cap-used entirely, and
        # an IR player is charged at 50%, so `salary - penalty` overstates the
        # relief for both. Blake Watson showed $2,000 of relief for a body that
        # was never on the cap.
        where = _status_before(fid, d.get("dropped_at_iso"), pid, positions)
        # Taxi first: a taxi salary is not on the cap AT ALL, so the relief is
        # known to be zero even when the salary itself is not recorded.
        if where == "TAXI_SQUAD":
            relief, basis = -pen, "taxi -- salary was never on the cap"
        elif sal is None:
            # Blank/zero salary is UNKNOWN, not zero -- see above. Without it the
            # relief for a ROSTER or IR player cannot be computed at all.
            relief, basis = None, "salary not recorded -- relief cannot be computed"
        elif where == "INJURED_RESERVE":
            relief, basis = int(round(sal * IR_RELIEF_RATE)) - pen, "IR -- only the 50% charged"
        elif where == "ROSTER":
            relief, basis = sal - pen, ""
        else:
            relief, basis = None, "roster status before the drop unknown"
        cut_rows.append([adp_name.get(pid) or mfl_name.get(pid, "Unknown player %s" % pid), positions.get(pid, "?"),
                         str(d.get("dropped_at_iso"))[:10], _kind(d),
                         sal if sal is not None else "not recorded", pen, charged,
                         relief if relief is not None else "—", basis])

    real_cuts = [d for d in drops if _kind(d) == "cut"]
    def _applies(d):
        v = d.get("applies_to_season")
        return int(v) if v not in (None, "") else None
    pen_2026 = sum((d.get("penalty_amount") or 0) for d in drops if _applies(d) == SEASON)
    pen_next = sum((d.get("penalty_amount") or 0) for d in drops
                   if _applies(d) is not None and _applies(d) > SEASON)
    pen_unstamped = sum((d.get("penalty_amount") or 0) for d in drops
                        if _applies(d) is None and (d.get("penalty_amount") or 0))
    if pen_unstamped:
        # No fact for it any more. Keith, on "$14,500 of penalty ... sits in the
        # ledger unassigned": "Way too much details". It is bookkeeping, not a
        # story, so the review is given nothing to quote.
        pack.warn("$%s of cap penalty has NO applies_to_season stamp yet (migration 0125 "
                  "backfills nothing; the worker stamps a row when it next touches it). That "
                  "money is NOT in either the this-season or the deferred total. Do not mention "
                  "it in the review at all -- Keith: 'way too much details'."
                  % "{:,}".format(pen_unstamped))

    F("f.team.%s.cuts_count" % fid, "Contracts cut (carried into the season)", len(real_cuts),
      "count", "ups_drop_events", NOW_UTC)
    F("f.team.%s.roster_removals_total" % fid, "Roster removals of all kinds", len(drops),
      "count", "ups_drop_events", NOW_UTC)
    F("f.team.%s.waiver_swaps" % fid, "Drops that were the make-room leg of a waiver claim",
      sum(1 for d in drops if _kind(d) == "waiver swap"), "count", "mfl transactions", NOW_UTC)
    F("f.team.%s.inyear_flyers" % fid, "Players signed and discarded inside the same offseason",
      sum(1 for d in drops if _kind(d) == "in-year flyer"), "count", "ups_drop_events", NOW_UTC)
    F("f.team.%s.cuts_penalty_%d" % (fid, SEASON), "Cap penalty charged to this season", pen_2026,
      "usd", "ups_drop_events", NOW_UTC)
    F("f.team.%s.cuts_penalty_%d_deferred" % (fid, SEASON + 1),
      "Cap penalty deferred to next season (ledger-only, not yet charged)", pen_next,
      "usd", "ups_drop_events", NOW_UTC)
    pack.warn("Cut figures separate three things the old count merged. 'Contracts cut' means a "
              "contract carried INTO the league year and then released. A drop that was the "
              "make-room leg of a BBID waiver claim is a roster swap, and a body signed and "
              "discarded inside the same offseason was never part of the team (that is a TIMING "
              "test, not a salary one -- do not describe those as minimum-salary) -- both "
              "are reported separately and must not be described as cuts. Penalties are likewise "
              "split by cap year: a drop on or after the FA Auction open is charged to the FOLLOWING "
              "season and is ledger-only until rollover (canon §D1), so it must never be added to "
              "this season's cap figure.")
    t_cuts = pack.table("t.%s.cuts" % fid, "Roster removals",
                        [{"key": "player", "label": "Player", "type": "text"},
                         {"key": "pos", "label": "Pos", "type": "text"},
                         {"key": "date", "label": "Date", "type": "text"},
                         {"key": "kind", "label": "Kind", "type": "text"},
                         {"key": "sal", "label": "Salary removed", "type": "usd"},
                         {"key": "pen", "label": "Penalty", "type": "usd"},
                         {"key": "charged", "label": "Charged to", "type": "text"},
                         {"key": "relief", "label": "Net cap relief", "type": "usd"},
                         {"key": "basis", "label": "Why", "type": "text"}],
                        cut_rows,
                        note="'cut' = a contract carried into the league year and released. "
                             "'waiver swap' = the make-room drop leg of a BBID claim. "
                             "'in-year flyer' = signed and discarded inside the same offseason "
                             "(a timing classification, NOT a salary one -- read the salary column, "
                             "these are not all minimum-salary deals). 'Charged to' is the cap year "
                             "the penalty actually hits: a drop on or after the FA Auction open is "
                             "charged to the FOLLOWING season (canon §D1) and is ledger-only until "
                             "rollover, so rows marked deferred must never be added into this "
                             "season's cap total.")

    # ---- trades ----
    # ups_transactions' added_players/dropped_players column NAMES are
    # misleading -- verified against raw_json on every 2026 row for this
    # league: added_players == raw_json.franchise1_gave_up (what `franchise`
    # GAVE UP, not received) and dropped_players ==
    # raw_json.franchise2_gave_up (what `franchise2` gave up, i.e. what
    # `franchise` RECEIVED). Trusting the column names instead of raw_json
    # is exactly what put Quentin Johnston on the wrong side of his own
    # trade in the first draft (Keith 2026-09-06).
    # SOURCED FROM MFL, NOT D1 (2026-09-07). ups_transactions' TRADE ingest only
    # begins 2026-05-07 and silently misses every earlier trade -- for 0008 that
    # dropped a real one on the floor: 2026-04-13, Kenneth Walker III to
    # HammerTime for their 2027 first, with Walker extended a year immediately
    # before he was shipped. Four league trades sit in that blind spot
    # (03-27, 04-09, 04-13, 04-17). MFL's export is authoritative and complete,
    # so read it directly and keep D1 out of the trade path entirely.
    all_trades = []
    _tx = D.worker_get("/api/mfl-export", TYPE="transactions", JSON=1)
    _rows = (_tx.get("transactions") or {}).get("transaction") or []
    if isinstance(_rows, dict):
        _rows = [_rows]
    for rj in _rows:
        if str(rj.get("type")) != "TRADE":
            continue
        m3 = re.search(r"3-way\s+([0-9a-f-]{36})", str(rj.get("comments") or ""))
        all_trades.append({
            "ts": int(rj.get("timestamp") or 0),
            "f1": str(rj.get("franchise") or "").zfill(4),
            "f2": str(rj.get("franchise2") or "").zfill(4),
            "f1_gave": [t for t in (rj.get("franchise1_gave_up") or "").split(",") if t],
            "f2_gave": [t for t in (rj.get("franchise2_gave_up") or "").split(",") if t],
            "group": m3.group(1) if m3 else None,
        })
    all_trades.sort(key=lambda t: t["ts"])

    # Collapse mirror-image swaps that net to nothing. Two commish-executed rows
    # 42 seconds apart sent 0008's 2027 third to 0007 and pulled it straight
    # back; MFL has since deleted both, but any mirror pair like it would
    # otherwise be narrated as two real trades. Matching on the exchanged token
    # SET (not the row) means a genuine swap-and-swap-back is still caught even
    # if the two legs are hours apart.
    _dropped_mirror = 0
    _by_pair = {}
    for t in all_trades:
        key = tuple(sorted([t["f1"], t["f2"]]))
        _by_pair.setdefault(key, []).append(t)
    _mirror_ids = set()
    for key, lst in _by_pair.items():
        for i, a in enumerate(lst):
            for b in lst[i + 1:]:
                if id(a) in _mirror_ids or id(b) in _mirror_ids:
                    continue
                a_out, a_in = set(a["f1_gave"]), set(a["f2_gave"])
                b_out, b_in = (set(b["f1_gave"]), set(b["f2_gave"])) if b["f1"] == a["f1"] \
                    else (set(b["f2_gave"]), set(b["f1_gave"]))
                if a_out and a_out == b_in and a_in == b_out:
                    _mirror_ids.update({id(a), id(b)})
    if _mirror_ids:
        _dropped_mirror = len(_mirror_ids)
        all_trades = [t for t in all_trades if id(t) not in _mirror_ids]
        pack.warn("%d trade row(s) were mirror-image swaps that net to zero -- the same assets sent "
                  "and returned between the same two franchises -- and are excluded. They are real "
                  "MFL history, not corruption, but narrating them as trades would invent activity "
                  "that never changed a roster." % _dropped_mirror)

    # A multi-way trade (verified so far: exactly one, a 3-way, in the whole
    # 2026 ledger -- Keith/Bear Dunn/Chris Klingenberg, McMillan for Nacua
    # with Dunn as a facilitator) is recorded as one pairwise row PER LEG.
    # Reading Keith's McMillan leg alone said he gave up a WR1 for literally
    # nothing -- true only of that one leg, not the trade. Group every leg
    # sharing the same embedded group id and treat the group as one event.
    groups = {}
    ungrouped = []
    for t in all_trades:
        if t["group"]:
            groups.setdefault(t["group"], []).append(t)
        else:
            ungrouped.append(t)

    my_events = []  # each: {ts, partners: [fid,...], gave: [tok,...], got: [tok,...]}
    for t in ungrouped:
        if fid in (t["f1"], t["f2"]):
            theirs = t["f2"] if t["f1"] == fid else t["f1"]
            gave = t["f1_gave"] if t["f1"] == fid else t["f2_gave"]
            got = t["f2_gave"] if t["f1"] == fid else t["f1_gave"]
            my_events.append({"ts": t["ts"], "partners": [theirs], "gave": gave, "got": got,
                              "elsewhere": []})
    for legs in groups.values():
        if not any(fid in (t["f1"], t["f2"]) for t in legs):
            continue
        gave, got, partners, elsewhere = [], [], set(), []
        for t in legs:
            for side_fid, side_tokens in ((t["f1"], t["f1_gave"]), (t["f2"], t["f2_gave"])):
                if side_fid != fid:
                    partners.add(side_fid)
            if t["f1"] == fid:
                gave += t["f1_gave"]; got += t["f2_gave"]
            elif t["f2"] == fid:
                gave += t["f2_gave"]; got += t["f1_gave"]
            else:
                # A leg between two OTHER franchises. It is not something this
                # team gave or got, so it must never land in gave/got -- but
                # dropping it entirely is how the 2026-07-22 three-way came to
                # be described as pure talent consolidation when Drake London
                # and $19,000 of blind-bid money changed hands inside the same
                # deal (Keith, 2026-09-09: "There was blind bid $$ that was
                # also sent"). Carried separately so the row can show the whole
                # shape of the trade without misattributing any of it.
                for src, toks in ((t["f1"], t["f1_gave"]), (t["f2"], t["f2_gave"])):
                    if toks:
                        dst = t["f2"] if src == t["f1"] else t["f1"]
                        elsewhere.append((src, dst, list(toks)))
        my_events.append({"ts": min(t["ts"] for t in legs), "partners": sorted(partners),
                          "gave": gave, "got": got, "elsewhere": elsewhere})
    my_events.sort(key=lambda e: e["ts"])

    # DP_<round>_<slot> IS resolvable, and the reason an earlier pass thought it
    # wasn't is a plain off-by-one: MFL ZERO-INDEXES BOTH FIELDS of this token.
    # DP_0_3 is round 1 pick 4, not "round 0 pick 3".
    #
    # That earlier pass gave up after two apparent contradictions, and BOTH are
    # explained by the same off-by-one (re-verified against draftResults +
    # src_draft_picks on 2026-09-09):
    #   DP_2_5 -- read as R2.05 that is 0006's pick, which is why it looked like
    #             0008 held a slot it did not draft at. Read correctly it is
    #             R3.06, which IS 0008's, and 0008 took Sonny Styles there.
    #   DP_1_2 -- read as R1.02 that is 0012's pick, i.e. the "Carnell Tate
    #             misattribution" the old note is named after. Read correctly it
    #             is R2.03, which IS 0003's, and 0003 took Chris Bell there.
    # Neither was a broken trade chain; the chain was right and the decoder was
    # wrong. Keith, 2026-09-09, after spotting it in his own article: the Gride
    # draft-night deal he described as "I moved from 4 to 7, he took Price at 4
    # and I took Concepcion at 7" is exactly DP_0_3 out / DP_0_6 back.
    #
    # The encoder half of this convention was already correct elsewhere in the
    # repo -- worker/src/trade_3way.js subtracts 1 from both fields when it
    # BUILDS a token -- so the knowledge existed and simply never reached here.
    #
    # Verified end to end on all seven tokens in 0008's trades: 0_3->R1.04
    # Price, 0_6->R1.07 Concepcion, 1_5->R2.06 Stribling, 1_8->R2.09 Johnson,
    # 2_5->R3.06 Styles, 2_8->R3.09 Randall, 2_11->R3.12 Brazzell II.
    draft_by_slot = {}
    for p in D.d1("SELECT draftpick_round r, draftpick_roundorder ro, franchise_id fid, "
                  "player_name pn FROM src_draft_picks WHERE season=2026"):
        draft_by_slot[(int(p["r"]), int(p["ro"]))] = {
            "fid": str(p["fid"]).zfill(4), "name": D.display_name(p["pn"]),
        }

    def _describe_dp(token):
        """DP_<round-1>_<slot-1> -> '2026 pick 1.04 (became Jadarian Price, Gride)'.

        The parenthetical is what the slot BECAME -- who actually drafted there
        and who they took -- not who the pick was traded to in this particular
        leg. A pick can change hands more than once (3.06 went Long Haulers ->
        Gride -> Real Deal Creel), so 'to X' would read as a transfer that did
        not happen; 'became' is the outcome and is true from any leg's angle.

        Falls back to the bare slot when the draft table has no row for it --
        a pick that exists in a trade but not in src_draft_picks is a real
        gap (forfeited, or a season whose draft has not happened), and
        inventing a player for it would be worse than saying less.
        """
        try:
            _, r, s = token.split("_")
            rnd, slot = int(r) + 1, int(s) + 1
        except (ValueError, TypeError):
            return "an unparseable pick token (%s)" % token
        label = "2026 pick %s" % _pick_label(rnd, slot)
        hit = draft_by_slot.get((rnd, slot))
        if not hit:
            return label
        team = owners.get(hit["fid"], {}).get("team_name", hit["fid"])
        return "%s (became %s, %s)" % (label, hit["name"], team)

    current_salary_by_pid = {}
    for f, rows in current_rows_by_fid.items():
        for r in rows:
            current_salary_by_pid[r["pid"]] = r["salary"]

    def describe_side(tokens):
        out = []
        for t in tokens:
            if t.startswith("DP_"):
                out.append(_describe_dp(t))
            elif t.startswith("FP_"):
                _, own_fid, yr, rnd = t.split("_")
                out.append("%s round-%s pick (%s natural pick)" %
                           (yr, rnd, _poss(owners.get(own_fid.zfill(4), {}).get("team_name", own_fid))))
            elif t.startswith("BB_"):
                out.append("$%s of blind-bid consideration" % format(int(t.split("_")[1]), ","))
            else:
                pg = LE.pos_group(positions.get(t, ""))
                nm = adp_name.get(t) or mfl_name.get(t, "Unknown player %s" % t)
                if pg in ("QB", "RB", "WR", "TE"):
                    # A tier, not "redraft value 6,733" -- Keith: numbers like
                    # that "dont make sense to people".
                    out.append("%s (%s)" % (nm, tiering.tier_label(pg, pos_rank.get(t))
                                            or "%s, off the redraft board" % positions.get(t, "?")))
                else:
                    idp_hit = idp_value.get(t)
                    if idp_hit:
                        out.append("%s (%s, %s %s, +%.1f PAR)" %
                                  (nm, positions.get(t, "?"), idp_hit["tier"],
                                   idp_hit["pos"], idp_hit["par"]))
                    else:
                        sal = current_salary_by_pid.get(t)
                        out.append("%s (%s, unranked -- %s)" %
                                  (nm, positions.get(t, "?"),
                                   ("$%s salary" % format(sal, ",d")) if sal is not None else "not currently rostered"))
        return "; ".join(out) if out else "—"

    from datetime import datetime, timezone
    trade_rows = []
    for e in my_events:
        partner = " + ".join(owners.get(p, {}).get("team_name", p) for p in e["partners"])
        if len(e["partners"]) > 1:
            partner += " (3-way)"
        dt = datetime.fromtimestamp(e["ts"], tz=timezone.utc).strftime("%Y-%m-%d")
        other = "; ".join(
            "%s sent %s to %s" % (owners.get(src, {}).get("team_name", src),
                                  describe_side(toks),
                                  owners.get(dst, {}).get("team_name", dst))
            for src, dst, toks in e.get("elsewhere", []))
        trade_rows.append([dt, partner, describe_side(e["gave"]), describe_side(e["got"]),
                           other or "—"])
    F("f.team.%s.trades_count" % fid, "Trades made", len(my_events), "count", "mfl transactions export", current_date)
    t_trades = pack.table("t.%s.trades" % fid, "Trades",
                          [{"key": "date", "label": "Date", "type": "text"},
                           {"key": "partner", "label": "Partner", "type": "text"},
                           {"key": "gave", "label": "Gave up", "type": "text"},
                           {"key": "got", "label": "Received", "type": "text"},
                           {"key": "other", "label": "Elsewhere in the deal", "type": "text"}],
                          trade_rows,
                          note="Direction verified against each trade's raw MFL payload, not the "
                               "MFL's own field names. Traded picks resolve to the player actually "
                               "taken at that slot: DP_<r>_<s> is ZERO-INDEXED on both fields, so "
                               "DP_0_3 is pick 1.04. An earlier pass read it one-indexed, which is "
                               "what produced the Carnell Tate misattribution and the two apparent "
                               "chain contradictions that stopped picks being resolved at all. "
                               "'Elsewhere in the deal' carries legs of a multi-way trade between "
                               "two OTHER franchises -- this team neither gave nor got those, but "
                               "leaving them out made a three-way with cash in it read as a "
                               "straight talent swap. Non-ADP positions (IDP/K/P) show current "
                               "salary, not a redraft value ADP does not produce for them.")

    # WHAT A TRADE TOOK OFF THE CAP IS HALF OF WHY IT HAPPENED. The Kenneth
    # Walker deal read as "a running back for a pick" and was buried in a
    # subordinate clause; it also removed the single biggest annual contract
    # this team has moved (Keith: "it freed up 32K for me and got me a 1st
    # rounder"). Roster snapshots begin after that trade, so the salary is
    # recovered from the player's own contractInfo AAV, which MFL still serves
    # wherever he sits today.
    _shed = []
    try:
        _live = D.worker_get("/api/mfl-export", TYPE="rosters", JSON=1)
        _by_pid = {}
        for _fr in (_live.get("rosters") or {}).get("franchise") or []:
            _pl = _fr.get("player") or []
            if isinstance(_pl, dict):
                _pl = [_pl]
            for _p in _pl:
                _by_pid[str(_p.get("id"))] = _p
        for _t in my_events:
            for _tok in (_t.get("gave") or []):
                if not str(_tok).isdigit():
                    continue
                _ci = str(_by_pid.get(str(_tok), {}).get("contractInfo") or "")
                _m = re.search(r"AAV\s+(\d+(?:\.\d+)?)K", _ci)
                if _m:
                    _shed.append((int(float(_m.group(1)) * 1000), str(_tok)))
    except (KeyError, ValueError, TypeError, OSError):
        # Deliberately NOT a bare Exception: this block referenced an undefined
        # `my_trades` for a full build cycle and the broad catch swallowed the
        # NameError, so the fact simply never appeared and nothing said why.
        _shed = []
    if _shed:
        _amt, _pid = max(_shed)
        F("f.team.%s.biggest_contract_traded_away" % fid,
          "Largest annual contract value this team traded away", _amt,
          "usd", "MFL contractInfo (live)", NOW_UTC)

    pack.warn("THREE-WAY TRADES: ups_3way_trades only records deals routed through the league's "
              "in-app trade tool, which did not exist before 2026 -- it is NOT an all-time ledger. "
              "Multi-team deals did happen in earlier years (Keith 2026-09-09: historical ones "
              "exist, involving owners since departed). Say three-way trades are RARE, and that "
              "this is the only one completed through the league's trade tool; never say it is the "
              "only one on record, and do not characterise the historical ones -- this pack has no "
              "data on them.")

    _bb = 0
    # Columns are [date, partner, gave, got, elsewhere]. "Elsewhere" is money
    # that moved between two OTHER franchises -- 0008's $19,000 went C-Town to
    # Blake Bombers and was never this team's. Scan only what this team gave or
    # received.
    for _row in trade_rows:
        for _cell in _row[2:4]:
            for _m in re.finditer(r"\$([\d,]+) of blind-bid", str(_cell)):
                _bb = max(_bb, int(_m.group(1).replace(",", "")))
    _bb_elsewhere = 0
    for _row in trade_rows:
        for _m in re.finditer(r"\$([\d,]+) of blind-bid", str(_row[4] if len(_row) > 4 else "")):
            _bb_elsewhere = max(_bb_elsewhere, int(_m.group(1).replace(",", "")))
    if _bb_elsewhere:
        F("f.team.%s.trade_blind_bid_elsewhere" % fid,
          "Blind-bid cash that moved between the OTHER two teams in a multi-way trade",
          _bb_elsewhere, "usd", "mfl transactions", NOW_UTC)
    if _bb:
        F("f.team.%s.trade_blind_bid_cash" % fid,
          "Largest blind-bid sum this team itself sent or received in a trade", _bb,
          "usd", "mfl transactions", NOW_UTC)

    # ---- contracts handed out (extensions/restructures/tags/MYM/FA) ----
    activity_rows, activity_provenance = D.contract_activity(SEASON)
    from preseason_review import distinct_outcomes as _distinct_outcomes
    outcomes = _distinct_outcomes(activity_rows)
    my_contracts = [r for r in outcomes if str(r.get("franchise_id", "")).zfill(4) == fid]
    # A RESTRUCTURE THAT WAS UNDONE IS NOT A CONTRACT CHANGE (Keith 2026-09-09:
    # "Puka was restructured mid auction to open up cap space and then reverted
    # back after the auction"). distinct_outcomes keeps "the shape that stuck",
    # which for a round trip is the shape it started in -- so a temporary cap
    # manoeuvre surfaced as a single dated "Restructure" and got written up as
    # the most important contract of the offseason. It moved no total value: it
    # freed room for the auction and gave it back afterwards.
    # THE CHAIN IS THE CONTRACT'S, NOT THE FRANCHISE'S. Scoping these events to
    # one franchise hid the round trip entirely: Nacua's baseline $22,000 was set
    # by the PREVIOUS owner's extension, so inside 0008's own two events the
    # manoeuvre looked like a plain raise (9,000 -> 22,000) instead of what it
    # was (22,000 -> 9,000 -> 22,000). Walk every event for the player in season
    # order whoever submitted it, then ask what THIS franchise did to it.
    by_player = {}
    for r in activity_rows:
        by_player.setdefault(str(r.get("player_id")), []).append(r)
    round_trip, prior_owner_work = {}, {}
    for pid, evs in by_player.items():
        evs = sorted(evs, key=lambda r: str(r.get("submitted_at_utc") or ""))
        mine = [i for i, e in enumerate(evs)
                if str(e.get("franchise_id", "")).zfill(4) == fid]
        if not mine:
            continue
        # Anything done to this contract BEFORE this owner touched it is someone
        # else's work and must not be credited to him.
        if mine[0] > 0:
            prev = evs[mine[0] - 1]
            prior_owner_work[pid] = {
                "type": prev.get("activity_type"),
                "by": str(prev.get("franchise_id", "")).zfill(4),
                "on": str(prev.get("submitted_at_utc") or "")[:10],
            }
        if len(mine) < 2:
            continue
        baseline = (evs[mine[0] - 1].get("salary") if mine[0] > 0 else evs[mine[0]].get("salary"))
        last = evs[mine[-1]]
        # `or 0` here turned any NULL salary into a dip to zero, which invents a
        # round trip and a strongly-worded warning about a cap manoeuvre that
        # never happened. An unstamped salary is unknown -- skip the player.
        _sals = [evs[i].get("salary") for i in mine]
        if baseline is None or any(v is None for v in _sals):
            continue
        dip = min(_sals)
        if last.get("salary") == baseline and dip < baseline:
            round_trip[pid] = {"freed": (baseline or 0) - dip, "n": len(mine),
                               "from": str(evs[mine[0]].get("submitted_at_utc") or "")[:10],
                               "to": str(last.get("submitted_at_utc") or "")[:10],
                               "baseline": baseline}

    contract_rows = []
    for r in sorted(my_contracts, key=lambda r: r.get("submitted_at_utc") or ""):
        pid = str(r.get("player_id"))
        nm = adp_name.get(pid) or mfl_name.get(pid) or D.display_name(r.get("player_name"))
        rt = round_trip.get(pid)
        kind = r.get("activity_type")
        if rt and rt["freed"] > 0:
            kind = "%s, then reverted (temporary cap room)" % kind
        contract_rows.append([
            nm, r.get("position") or positions.get(pid, "?"), kind,
            r.get("contract_status") or "", r.get("salary") or 0,
            "yes" if (r.get("salary") or 0) == LEAGUE_MIN_SALARY else "no",
            r.get("tcv") or 0,
            str(r.get("submitted_at_utc") or "")[:10],
        ])
    _rt_max = max((r["freed"] for r in round_trip.values()), default=0)
    if _rt_max > 0:
        F("f.team.%s.restructure_room_freed" % fid,
          "Cap room freed by a restructure that was later reverted", _rt_max,
          "usd", "contract_activity_2026", NOW_UTC)
    for pid, rt in round_trip.items():
        if rt["freed"] <= 0:
            continue
        nm = adp_name.get(pid) or mfl_name.get(pid, pid)
        pack.warn("%s's salary was cut from $%s to free room and then put straight back: %d events "
                  "between %s and %s, ending on exactly the salary and total value it started with. "
                  "That is a TEMPORARY CAP MANOEUVRE to create bidding room during the auction, NOT a "
                  "contract change. Do not describe it as restructuring, re-signing or extending the "
                  "player, do not say the deal was re-based, and do not call it the most significant "
                  "contract of the offseason. If you mention it at all, say what it did: it bought "
                  "$%s of temporary auction room."
                  % (nm, "{:,}".format(rt["baseline"] or 0), rt["n"], rt["from"], rt["to"],
                     "{:,}".format(rt["freed"])))
    for pid, pw in prior_owner_work.items():
        nm = adp_name.get(pid) or mfl_name.get(pid, pid)
        who = owners.get(pw["by"], {}).get("team_name", pw["by"])
        pack.warn("%s's %s (%s) was done by %s BEFORE this owner acquired him -- it is not this "
                  "owner's contract work and must not be credited to him."
                  % (nm, str(pw["type"]).lower(), pw["on"], who))
    F("f.team.%s.contracts_count" % fid, "Contract moves (extensions/restructures/tags/MYM/FA)",
      len(my_contracts), "count", "contract_activity_2026", NOW_UTC)
    t_contracts = pack.table("t.%s.contracts" % fid, "Contracts handed out this offseason",
                             [{"key": "player", "label": "Player", "type": "text"},
                              {"key": "pos", "label": "Pos", "type": "text"},
                              {"key": "type", "label": "Type", "type": "text"},
                              {"key": "status", "label": "New status", "type": "text"},
                              {"key": "salary", "label": "Current-year salary", "type": "usd"},
                              {"key": "atmin", "label": "At league minimum?", "type": "text"},
                              {"key": "tcv", "label": "TCV", "type": "usd"},
                              {"key": "date", "label": "Date", "type": "text"}],
                             contract_rows,
                             note="Distinct deals, not raw Front Office submissions -- a deal revised "
                                  "several times in one sitting counts once, as the shape that stuck. "
                                  "'At league minimum?' answers the only question that word means: the "
                                  "UPS minimum salary is $%s, so a $2,000 deal is NOT a minimum deal and "
                                  "must never be called one. Provenance: %s"
                                  % ("{:,}".format(LEAGUE_MIN_SALARY), activity_provenance))

    # What he DECLINED to spend on defense, which is the other half of the
    # churn story (Keith: "because i dont typically spend on it in the auction").
    _IDP_POS = ("DE", "DT", "LB", "CB", "S")
    idp_spend, all_spend = {}, {}
    for l in lots:
        f = str(l.get("winner_fid", "")).zfill(4)
        price = (l.get("current_high_bid_k") or 0) * 1000
        all_spend[f] = all_spend.get(f, 0) + price
        if str(l.get("position")) in _IDP_POS:
            idp_spend[f] = idp_spend.get(f, 0) + price
    if fid in all_spend and all_spend[fid]:
        share = 100.0 * idp_spend.get(fid, 0) / all_spend[fid]
        F("f.team.%s.idp_auction_spend" % fid, "Spent on defenders across both auctions",
          idp_spend.get(fid, 0), "usd", "auction/lots", NOW_UTC)
        F("f.team.%s.idp_auction_share" % fid, "Share of auction money spent on defenders",
          share, "percent", "auction/lots", NOW_UTC)
        # Rank over EVERY current franchise, not just those that won something;
        # a team that bought nobody has a 0% share and belongs in the ordering.
        # Ties share the better rank via a strict "how many are below me" count.
        _shares = {}
        for f in owners:
            tot_f = all_spend.get(f, 0)
            _shares[f] = (100.0 * idp_spend.get(f, 0) / tot_f) if tot_f else 0.0
        _rank = 1 + sum(1 for f in _shares if _shares[f] < share)
        F("f.team.%s.idp_auction_share_rank" % fid,
          "League rank for share of auction money spent on defenders, of %d teams "
          "(1 = smallest share)" % len(_shares),
          _rank, "count", "auction/lots", NOW_UTC)

    # ---- IDP: how hard does this owner actually work the position? ----
    # A September snapshot of a defense is nearly meaningless on its own for an
    # owner who churns IDP all season, and the first draft of this article read
    # three replacement-level starters as neglect. Keith, correctly: "you talk
    # about my defense but fail to discuss i'm the most active league member on
    # IDP historically." He is, by a distance -- and the interesting part is
    # that it buys him a mid-table defense, not a good one. Both halves belong
    # in the article; one without the other is propaganda in either direction.
    idp_adds = D.d1(
        "SELECT a.season season, a.franchise_id fid, COUNT(*) adds "
        "  FROM src_adddrop a JOIN src_players p "
        "    ON p.player_id = a.player_id AND p.season = a.season "
        " WHERE a.move_type='ADD' AND p.position IN ('DE','DT','LB','CB','S') "
        " GROUP BY a.season, a.franchise_id")
    tot_adds, seasons_seen, by_season = {}, {}, {}
    for r in idp_adds:
        f = str(r["fid"]).zfill(4)
        tot_adds[f] = tot_adds.get(f, 0) + int(r["adds"])
        seasons_seen.setdefault(f, set()).add(int(r["season"]))
        by_season.setdefault(int(r["season"]), {})[f] = int(r["adds"])
    live = [f for f in tot_adds if f in owners]
    ranked = sorted(live, key=lambda f: -tot_adds[f])
    if fid in tot_adds and fid in ranked:
        my_rank = ranked.index(fid) + 1
        # "The next team on that list" means the team immediately BELOW this one,
        # for everybody. The first version returned the league LEADER's total to
        # every non-leader, so 0006 (rank 4, 234 adds) published 428 -- 0008's
        # number -- under that label.
        _below = ranked[my_rank] if my_rank < len(ranked) else None
        runner = tot_adds[_below] if _below else None
        streak = 0
        for yr in sorted(by_season, reverse=True):
            row = {f: n for f, n in by_season[yr].items() if f in owners}
            if row and max(row, key=row.get) == fid:
                streak += 1
            else:
                break
        F("f.team.%s.idp_adds_alltime" % fid, "Defensive players acquired since 2010",
          tot_adds[fid], "count", "src_adddrop + src_players", NOW_UTC)
        F("f.team.%s.idp_adds_rank" % fid, "League rank for defensive acquisitions since 2010",
          my_rank, "count", "src_adddrop + src_players", NOW_UTC)
        if runner is not None:
            F("f.team.%s.idp_adds_next_best" % fid,
              "Defensive acquisitions by the next team below this one on that list", runner,
              "count", "src_adddrop + src_players", NOW_UTC)
        F("f.team.%s.idp_adds_league_leader" % fid,
          "Defensive acquisitions by the league leader", tot_adds[ranked[0]],
          "count", "src_adddrop + src_players", NOW_UTC)
        F("f.team.%s.idp_adds_lead_streak" % fid,
          "Consecutive seasons leading the league in defensive acquisitions", streak,
          "count", "src_adddrop + src_players", NOW_UTC)

    # And what all that work actually returns, on the scoreboard.
    idp_pts = D.d1(
        "SELECT roster_franchise_id fid, ROUND(SUM(score),1) pts, COUNT(score) n "
        "  FROM src_weekly WHERE is_reg=1 AND status='starter' AND score IS NOT NULL "
        "   AND pos_group IN ('DL','DB','LB','DT+DE','CB+S') "
        "   AND season BETWEEN %d AND %d "
        "   AND roster_franchise_id IS NOT NULL AND roster_franchise_id NOT IN ('','FA') "
        " GROUP BY fid" % (SEASON - 3, SEASON - 1))
    ppw = {}
    for r in idp_pts:
        f = str(r["fid"]).zfill(4)
        if f in owners and r["n"]:
            ppw[f] = r["pts"] / r["n"]
    if fid in ppw:
        order = sorted(ppw, key=lambda f: -ppw[f])
        F("f.team.%s.idp_ppw_rank" % fid,
          "League rank for points per started defender, %d-%d" % (SEASON - 3, SEASON - 1),
          order.index(fid) + 1, "count", "src_weekly", NOW_UTC)
        t_idp = pack.table("t.%s.idp_activity" % fid,
                           "Defensive acquisitions since 2010, and what they returned",
                           [{"key": "team", "label": "Team", "type": "text"},
                            {"key": "adds", "label": "Defenders acquired", "type": "count"},
                            {"key": "ppw", "label": "Points per started defender (%d-%d)"
                             % (SEASON - 3, SEASON - 1), "type": "text"}],
                           [[owners.get(f, {}).get("team_name", f), tot_adds.get(f, 0),
                             "%.2f" % ppw[f] if f in ppw else "--"] for f in ranked],
                           note="Acquisitions are every ADD of a player listed DE/DT/LB/CB/S, all "
                                "methods, 2010 to last completed season. Points per started "
                                "defender is regular-season only and counts only weeks the "
                                "defender was actually STARTED, so it measures the defense an "
                                "owner fielded rather than the one he rostered. Working the wire "
                                "hardest and scoring most are plainly not the same thing here.")
    else:
        t_idp = None

    # ---- division ----
    # "6th of 12" is an abstraction nobody plays against. You play your division
    # -- FIVE times each in 2026's 37-game, multi-game-week schedule (MFL
    # export?TYPE=schedule), not twice as this once said and every review printed
    # (Keith: "finish by including how i look within the division").
    try:
        _lg = (D.worker_get("/api/mfl-export", TYPE="league", JSON=1).get("league") or {})
        _dnames = {str(x.get("id")): x.get("name")
                   for x in ((_lg.get("divisions") or {}).get("division") or [])}
        _mem = {}
        for _f in ((_lg.get("franchises") or {}).get("franchise") or []):
            _mem.setdefault(str(_f.get("division")), []).append(str(_f.get("id")).zfill(4))
        _mydiv = next((k for k, v in _mem.items() if fid in v), None)
    except Exception as _e:
        _mydiv, _dnames, _mem = None, {}, {}
        pack.warn("Could not read MFL's league export, so DIVISION name, rank and table are all "
                  "missing from this pack (%s). Section 5 asks for a divisional finish and has "
                  "nothing to build it from -- say the division standing is unavailable rather "
                  "than substituting the league-wide rank for it." % type(_e).__name__)
    # The division TABLE is built further down, with the season simulation and
    # the owners' records; here only the membership and the name. The name is
    # registered as an entity so the digit audit reads "DOG POUND 4 LIFE" as a
    # name -- this builder never did, so no review could print its division.
    t_div = None
    _div_members = list(_mem.get(_mydiv, [])) if _mydiv is not None else []
    if _mydiv is not None:
        _dname = _dnames.get(_mydiv, _mydiv)
        pack.division(_dname)
        F("f.team.%s.division_name" % fid, "Division", _dname, "text", "MFL league export", NOW_UTC)
        F("f.team.%s.division_size" % fid, "Teams in the division", len(_div_members),
          "count", "MFL league export", NOW_UTC)

    # ---- rookie picks ----
    tiers = json.load(open(os.path.join(D.REPO, "site", "rookies", "rookie_draft_tiers.json")))
    picks = D.d1("SELECT draftpick_round, draftpick_overall, draftpick_roundorder, player_id, "
                "player_name FROM src_draft_picks WHERE season=2026 AND franchise_id='%s' "
                "ORDER BY draftpick_overall" % fid)
    rookie_rows = []
    for p in picks:
        label = _pick_label(p["draftpick_round"], p["draftpick_roundorder"])
        band = _band_for(tiers, p["draftpick_round"], p["draftpick_roundorder"])
        pid = str(p["player_id"])
        val = rsf.get(pid)
        pg = LE.pos_group(positions.get(pid, ""))
        # "off the redraft board yet" implies the board looked and passed. For a
        # DEFENDER the board does not cover the position at all, so that phrasing
        # invented a verdict (Keith 2026-09-09, on Sonny Styles and Zion Young:
        # "IDP needs a different way to analyze these players"). ADP prices
        # offense; the IDP model needs a prior NFL season, which a 2026 rookie by
        # definition does not have. Neither source has an opinion -- say that,
        # and do not let a blank read as a bad grade.
        if pg in ("DL", "LB", "DB"):
            valcol = "IDP -- not priced by ADP, and no NFL season yet to measure"
        elif val is not None:
            valcol = tiering.tier_label(pg, pos_rank.get(pid)) or "{:,}".format(val)
        else:
            valcol = "not yet on the redraft board"
        rookie_rows.append([label, D.display_name(p["player_name"]),
                            "%.0f%% usable historically at this slot" % (band.get("usable_pct", 0) * 100) if band else "no band data",
                            valcol])
    F("f.team.%s.rookie_picks_count" % fid, "Rookie picks made", len(picks), "count", "src_draft_picks", current_date)
    t_rookies = pack.table("t.%s.rookies" % fid, "2026 rookie draft class",
                           [{"key": "pick", "label": "Pick", "type": "text"},
                            {"key": "player", "label": "Player", "type": "text"},
                            {"key": "baseline", "label": "Historical baseline at this slot", "type": "text"},
                            {"key": "val", "label": "Current redraft value", "type": "text"}],
                           rookie_rows,
                           note="Baseline = 2015-2025 smash/hit/contrib/bust outcome rates at that exact "
                                "draft slot. 2026 rookies have zero seasons of outcome data, so this is "
                                "the PRE-outcome expectation, not a grade on the player yet. The "
                                "historical band is measured on OFFENSE outcomes; for a defensive pick "
                                "neither the redraft board (which does not price IDP) nor the IDP model "
                                "(which needs a completed NFL season) can value the player at all, and "
                                "an empty value column there means NO SOURCE HAS AN OPINION -- never "
                                "report it as a low or bad valuation.")

    # ---- week one, so far -----------------------------------------------
    # Keith 2026-09-10: "add a little context as well for injuries to AJ Brown,
    # Sam Darnold & the fact that Drake Maye sucks." This is an OFFSEASON
    # review, so the live week gets a small closing table and nothing more --
    # only players whose game is actually FINAL, so a Thursday build cannot
    # report a Sunday starter as having scored nothing.
    t_wk1 = None
    _lw, _clock = _live_clock()
    _live_rows = _live_roster_rows(fid, positions)
    if _lw and _clock and _live_rows:
        _nfl = _nfl_team_map()
        _started = _started_pids(fid, _lw)
        _final = [r for r in _live_rows
                  if _clock.get(_nfl.get(r["pid"], ""), 3600) == 0
                  and not r["is_taxi"] and not r["is_ir"]]
        # _clock is keyed by NFL TEAM, so this counts TEAMS whose game has
        # ended -- calling it "games" reported one finished game as two.
        _teams_final = sum(1 for v in _clock.values() if v == 0)
        _teams_seen = len(_clock)
        if _final:
            _scores = _week_scores(_lw, [r["pid"] for r in _final])
            _wk1_rows = []
            for r in sorted(_final, key=lambda x: -_scores.get(x["pid"], 0.0)):
                pid = r["pid"]
                # `_started` is None when liveScoring did not carry this
                # franchise at all -- that is unknown, not benched.
                if _started is None:
                    slot = "--"
                elif pid in _started:
                    slot = "Started"
                else:
                    slot = "Bench"
                _wk1_rows.append([mfl_name.get(pid, pid), r["pos"], _nfl.get(pid, ""),
                                  slot, int(r["salary"]),
                                  "%.1f" % _scores.get(pid, 0.0),
                                  _stat_line(pid, _lw)])
            t_wk1 = pack.table(
                "t.%s.week%s" % (fid, _lw), "Week %s, so far" % _lw,
                [{"key": "player", "label": "Player", "type": "text"},
                 {"key": "pos", "label": "Pos", "type": "text"},
                 {"key": "nfl", "label": "NFL", "type": "text"},
                 {"key": "slot", "label": "Started?", "type": "text"},
                 {"key": "salary", "label": "Salary", "type": "usd"},
                 {"key": "pts", "label": "Points", "type": "text"},
                 {"key": "line", "label": "What he did", "type": "text"}],
                _wk1_rows,
                note="ONLY players whose Week %s game has finished -- %d of the %d NFL "
                     "teams carrying a rostered starter had played at build time. "
                     "This is a handful of snaps, not a season, and it grades nothing. "
                     "An empty 'What he did' cell means the player took the field and "
                     "recorded no scoring stat, or did not play at all; it is not a "
                     "zero-yard line." % (_lw, _teams_final, _teams_seen))
            _pts_final = sum(_scores.get(r["pid"], 0.0) for r in _final
                             if _started and r["pid"] in _started)
            F("f.team.%s.wk_live" % fid, "Live NFL week", int(_lw), "count",
              "MFL liveScoring", NOW_UTC)
            F("f.team.%s.wk_players_final" % fid,
              "Rostered players whose Week %s game is final" % _lw, len(_final),
              "count", "MFL liveScoring + rosters", NOW_UTC)
            F("f.team.%s.wk_points_final" % fid,
              "Points already banked from finished Week %s games" % _lw,
              round(_pts_final, 1), "points", "MFL playerScores", NOW_UTC)
            F("f.league.wk_teams_final", "NFL teams that have played this week", _teams_final,
              "count", "MFL liveScoring", NOW_UTC)
            pack.warn("The Week %s table is an OPENING DATA POINT, not a result. Only %d of %d "
                      "NFL teams had played when this was built. Never write a verdict, a "
                      "trend or a told-you-so off it, and never call a player injured "
                      "from a low score alone -- MFL's injuries export is the only "
                      "source for a designation, and it carried none for these players."
                      % (_lw, _teams_final, _teams_seen))

    # =====================================================================
    # KEITH'S STRUCTURE (2026-09-11) -- the offseason phase by phase (see
    # _phase), the owner's history, and the division with the preseason
    # simulation. Every amount a moves row names also gets its own fact, so the
    # review can quote it: "Tony Pollard give me his total".
    # =====================================================================
    def _nm_pid(pid):
        return adp_name.get(pid) or mfl_name.get(pid, "Unknown player %s" % pid)

    def _who(pid):
        return "%s (%s)" % (_nm_pid(pid), positions.get(pid, "?"))

    def _usd(v):
        return "$%s" % format(int(v), ",d")

    def _day(ts):
        return datetime.fromtimestamp(int(ts or 0), tz=timezone.utc).strftime("%Y-%m-%d")

    PHASES = ("s1", "s2", "s3")
    PHASE_WORDS = {"s1": "before the rookie draft", "s2": "from the rookie draft to the auction lock",
                   "s3": "from the auction to week one"}
    moves = {p: [] for p in PHASES}
    row_facts = {p: [] for p in PHASES + ("s4", "s5")}

    def _rf(sec, key, label, value, unit="usd", source="ups_drop_events"):
        fact_id = "f.team.%s.%s" % (fid, key)
        n = 2
        while fact_id in pack._facts:
            fact_id = "f.team.%s.%s_%d" % (fid, key, n)
            n += 1
        F(fact_id, label, value, unit, source, NOW_UTC)
        row_facts[sec].append(fact_id)
        return fact_id

    def _move(ph, day, kind, player, detail):
        # Week one is the season, not the offseason.
        if str(day)[:10] >= WEEK1_DATE:
            return False
        moves[ph].append([str(day)[:10], kind, player, detail])
        return True

    prior = _prior_season_rosters()
    era_won = {str(l.get("player_id")): l for l in era_lots}
    faa_won = {str(l.get("player_id")): l for l in faa_lots}

    # -- tags applied straight in MFL. The Front Office log is missing tags that
    # MFL itself carries as commissioner roster loads inside the tag window:
    # George Pickens to C-Town on 05-22 (Keith: "Pickens and the tag") and two
    # for L.A. Looks. A load counts only if it STUCK -- he is on this roster in
    # the next daily snapshot -- and was not unloaded again inside the window.
    # That second test is what keeps out the phantom Mahomes tag (loaded 05-19,
    # unloaded 05-21) and the 0008 test loads that netted to nothing.
    tagged_fo = {str(r.get("player_id")) for r in my_contracts if r.get("activity_type") == "Tag"}
    mfl_tags = {}
    _tag_days = sorted(str(r.get("submitted_at_utc") or "")[:10] for r in activity_rows
                       if r.get("activity_type") == "Tag")
    if _tag_days:
        import datetime as _dt
        _lo = (_dt.date.fromisoformat(_tag_days[0]) - _dt.timedelta(days=1)).isoformat()
        _hi = (_dt.date.fromisoformat(_tag_days[-1]) + _dt.timedelta(days=1)).isoformat()
        _loads = []
        for t in _rows:
            if str(t.get("type")) != "LOAD_ROSTERS" or str(t.get("franchise", "")).zfill(4) != fid:
                continue
            day = _day(t.get("timestamp"))
            if _lo <= day <= _hi:
                add, _, rem = str(t.get("transaction") or "").partition("|")
                _loads.append((int(t.get("timestamp") or 0), day,
                               [x for x in add.split(",") if x.strip().isdigit()],
                               [x for x in rem.split(",") if x.strip().isdigit()]))
        _loads.sort()
        for ts, day, adds, _rems in _loads:
            for pid in adds:
                if pid in tagged_fo or pid in mfl_tags:
                    continue
                if any(pid in r2 for ts2, _d2, _a2, r2 in _loads if ts2 > ts):
                    continue
                nxt = next((d for d in D.snapshot_dates() if d > day), None)
                if not nxt:
                    continue
                if any(str(p.get("id")) == pid for fr in D.snapshot(nxt, "rosters")["rosters"]["franchise"]
                       if str(fr["id"]).zfill(4) == fid for p in _as_list(fr.get("player"))):
                    mfl_tags[pid] = (day, _salary_on_or_after(pid, day))
    if mfl_tags:
        pack.warn("%d tag(s) for this team exist only as MFL commissioner roster loads inside the tag window "
                  "(%s), not in the Front Office contract log; they are reported as tags at the salary MFL "
                  "carried the next day." % (len(mfl_tags), ", ".join(_nm_pid(p) for p in sorted(mfl_tags))))
    tagged_pids = tagged_fo | set(mfl_tags)

    # -- pickups. MFL writes FREE_AGENT as "added|dropped" and BBID_WAIVER as
    # "added|bid|dropped". The dropped half goes in the pickup's own row, so a
    # make-room release is not listed a second time as a cut. A FREE_AGENT row
    # with nothing added is a bare release, which ups_drop_events already has.
    pickup_drops = set()
    pickups = {p: 0 for p in PHASES}
    for t in _rows:
        typ = str(t.get("type"))
        if typ not in ("FREE_AGENT", "BBID_WAIVER") or str(t.get("franchise", "")).zfill(4) != fid:
            continue
        parts = str(t.get("transaction") or "").split("|")
        added = [x.strip() for x in parts[0].split(",") if x.strip().isdigit()]
        if not added:
            continue
        seg = (parts[2] if len(parts) > 2 else "") if typ == "BBID_WAIVER" else (parts[1] if len(parts) > 1 else "")
        dropped = [x.strip() for x in seg.split(",") if x.strip().isdigit()]
        day = _day(t.get("timestamp"))
        for p in dropped:
            pickup_drops.add((p, day))
        ph = _phase(day)
        bid = parts[1].strip() if typ == "BBID_WAIVER" and len(parts) > 1 else ""
        det = ["won on waivers for %s" % _usd(int(bid))] if bid.isdigit() else ["signed off the free-agent pool"]
        if dropped:
            det.append("released " + ", ".join(_nm_pid(p) for p in dropped))
        if _move(ph, day, "Waiver claim" if bid.isdigit() else "Free-agent pickup",
                 ", ".join(_who(p) for p in added), "; ".join(det)):
            pickups[ph] += len(added)

    # -- cuts. Keith: "Any large cap hits or mostly small". The small ones --
    # no penalty, and at the minimum salary or off the taxi squad (whose salary
    # was never on the cap) -- share one row per phase; every release that cost
    # something keeps its own row and its own facts.
    cut_tot = {p: {"n": 0, "sal": 0, "pen": 0} for p in PHASES}
    small = {p: [] for p in PHASES}
    for d in drops:
        pid = str(d.get("player_id"))
        day = str(d.get("dropped_at_iso"))[:10]
        k = _kind(d)
        if k == "waiver swap" or (pid, day) in pickup_drops or day >= WEEK1_DATE:
            continue
        ph = _phase(day)
        try:
            sal = int(d.get("pre_drop_salary"))
        except (TypeError, ValueError):
            sal = None
        if sal is not None and sal < LEAGUE_MIN_SALARY:
            sal = None
        pen = int(d.get("penalty_amount") or 0)
        taxi = _status_before(fid, day, pid, positions) == "TAXI_SQUAD"
        cut_tot[ph]["n"] += 1
        cut_tot[ph]["sal"] += 0 if taxi else (sal or 0)
        cut_tot[ph]["pen"] += pen
        if not pen and (taxi or sal is None or sal <= LEAGUE_MIN_SALARY):
            small[ph].append((day, _nm_pid(pid)))
            continue
        ap = _applies(d)
        det = ["off the taxi squad" if taxi else ("%s salary" % _usd(sal)) if sal else "salary not recorded",
               "no penalty" if not pen else "%s penalty%s" % (
                   _usd(pen), (", charged to %d" % ap) if ap and ap > SEASON else "")]
        _move(ph, day, "Released after a tag" if pid in tagged_pids else
              "Cut" if k == "cut" else "Released (signed this offseason)", _who(pid), "; ".join(det))
        if sal and not taxi:
            _rf(ph, "cut_%s_salary" % pid, "%s's salary when released (%s)" % (_nm_pid(pid), day), sal)
        _rf(ph, "cut_%s_penalty" % pid, "Cap penalty for releasing %s (%s)" % (_nm_pid(pid), day), pen)
    for ph in PHASES:
        if small[ph]:
            days = sorted(set(d for d, _ in small[ph]))
            moves[ph].append([days[0] if len(days) == 1 else "%s to %s" % (days[0], days[-1]),
                              "Released at no cost", ", ".join(n for _, n in sorted(small[ph])),
                              "minimum salary or taxi squad; no penalty on any of them"])

    # -- trades, with the salary that moved. "Extend and trades" (Keith): a
    # player this owner extended and then shipped is marked in the row.
    extended_on = {}
    for r in my_contracts:
        if r.get("activity_type") == "Extension":
            extended_on.setdefault(str(r.get("player_id")), str(r.get("submitted_at_utc") or "")[:10])

    def _brief(tokens, day):
        out, total = [], 0
        for tok in tokens:
            if tok.startswith("DP_"):
                out.append(_describe_dp(tok))
            elif tok.startswith("FP_"):
                _, own, yr, rnd = tok.split("_")
                out.append("%s round-%s pick (%s)" % (yr, rnd, _poss(owners.get(own.zfill(4), {}).get("team_name", own))))
            elif tok.startswith("BB_"):
                out.append("%s of blind-bid money" % _usd(int(tok.split("_")[1])))
            else:
                s = _salary_on_or_after(tok, day)
                total += s or 0
                ext = (", extended %s" % extended_on[tok]) if extended_on.get(tok, "9999") <= day else ""
                out.append("%s (%s%s%s)" % (_nm_pid(tok), positions.get(tok, "?"),
                                            (", " + _usd(s)) if s else "", ext))
        return ("; ".join(out) or "nothing"), total

    trade_tot = {p: {"n": 0, "out": 0, "in": 0} for p in PHASES}
    for i, e in enumerate(my_events, 1):
        day = _day(e["ts"])
        ph = _phase(day)
        gave, s_out = _brief(e["gave"], day)
        got, s_in = _brief(e["got"], day)
        partner = " + ".join(owners.get(p, {}).get("team_name", p) for p in e["partners"])
        if not _move(ph, day, "Trade", "with %s" % partner, "Gave %s. Got %s." % (gave, got)):
            continue
        trade_tot[ph]["n"] += 1
        trade_tot[ph]["out"] += s_out
        trade_tot[ph]["in"] += s_in
        _rf(ph, "trade%d_salary_out" % i, "Salary sent away in the %s trade with %s" % (day, partner), s_out,
            source="mfl transactions + roster snapshots")
        _rf(ph, "trade%d_salary_in" % i, "Salary taken on in the %s trade with %s" % (day, partner), s_in,
            source="mfl transactions + roster snapshots")

    # -- contracts. Tags are a pre-auction decision; every restructure goes with
    # the auction, split before/during vs after; a multi-year contract (MYAC)
    # says which market the player came from.
    ctr = {"ext": {p: 0 for p in PHASES}, "rookie_ext": 0, "tags": 0, "rs_pre": 0, "rs_post": 0,
           "myac_era": 0, "myac_faa": 0, "myac_trade": 0, "myac_other": 0}
    got_by_trade = {tok for e in my_events for tok in e["got"]}
    # One deal logged under two types on the same day (Justin Jefferson: "FA
    # Contract" and "MYM", both $71,000 / $96,000 on 06-05) is one move. Keep the
    # more specific MYM label and drop the twin.
    _seen_deal = {}
    _contract_rows = []
    for r in sorted(my_contracts, key=lambda r: (str(r.get("submitted_at_utc") or ""),
                                                  r.get("activity_type") != "MYM")):
        key = (str(r.get("player_id")), str(r.get("submitted_at_utc") or "")[:10],
               int(r.get("salary") or 0), int(r.get("tcv") or 0))
        if key in _seen_deal and {_seen_deal[key], r.get("activity_type")} <= {"MYM", "FA Contract"}:
            continue
        _seen_deal.setdefault(key, r.get("activity_type"))
        _contract_rows.append(r)
    for r in _contract_rows:
        pid = str(r.get("player_id"))
        day = str(r.get("submitted_at_utc") or "")[:10]
        typ = str(r.get("activity_type") or "")
        sal, tcv = int(r.get("salary") or 0), int(r.get("tcv") or 0)
        money = ("%s this year, %s in all" % (_usd(sal), _usd(tcv))) if tcv else "%s this year" % _usd(sal)
        rt = round_trip.get(pid)
        if typ == "Tag":
            ph, kind, det = "s2", "Tag", "tagged at %s" % _usd(sal)
            ctr["tags"] += 1
        elif typ == "Restructure":
            ph = "s3"
            pre = day <= POSTAUCTION_DATE
            kind = "Auction restructure" if pre else "Post-auction restructure"
            det = money + ("; put back after the auction -- temporary room" if rt and rt["freed"] > 0 else "")
            ctr["rs_pre" if pre else "rs_post"] += 1
        elif typ == "Multi-Year Contract":
            ph, kind = "s3", "Multi-year contract"
            src = ("era" if pid in era_won else "faa" if pid in faa_won else
                   "trade" if pid in got_by_trade else "other")
            det = {"era": "an Expired Rookie Auction buy", "faa": "a Free Agent Auction buy",
                   "trade": "acquired in a trade", "other": "a waiver or free-agent pickup"}[src] + ": " + money
            ctr["myac_" + src] += 1
        elif typ == "Extension":
            ph = _phase(day)
            rookie = "Rookie" in prior.get(pid, {}).get("status", "")
            kind = "Rookie extension" if rookie else "Extension"
            det = money
            ctr["ext"][ph] += 1
            ctr["rookie_ext"] += 1 if rookie else 0
        else:
            ph, kind, det = _phase(day), typ, money
        if not _move(ph, day, kind, _who(pid), det):
            continue
        _rf(ph, "contract_%s_salary" % pid, "%s's %d salary after the %s (%s)" % (_nm_pid(pid), SEASON, typ.lower(), day),
            sal, source="contract_activity_2026")
        if tcv:
            _rf(ph, "contract_%s_tcv" % pid, "Total value of %s's %s (%s)" % (_nm_pid(pid), typ.lower(), day),
                tcv, source="contract_activity_2026")

    for pid, (day, sal) in sorted(mfl_tags.items(), key=lambda kv: kv[1][0]):
        ctr["tags"] += 1
        _move("s2", day, "Tag", _who(pid), ("tagged at %s" % _usd(sal)) if sal else "tagged")
        if sal:
            _rf("s2", "tag_%s_salary" % pid, "%s's tag salary (%s)" % (_nm_pid(pid), day), sal,
                source="MFL roster load + daily snapshot")

    # -- Expired Rookie Auction buys
    for l in sorted(era_lots, key=lambda l: l.get("won_at_unix") or 0):
        pid = str(l.get("player_id"))
        price = (l.get("current_high_bid_k") or 0) * 1000
        own = prior.get(pid, {}).get("fid") == fid
        if _move("s2", _day(l.get("won_at_unix") or l.get("locks_at_unix")), "Expired Rookie Auction buy", _who(pid),
                 _usd(price) + ("; his own expired rookie, bought back" if own else "")):
            _rf("s2", "era_%s_price" % pid, "Expired Rookie Auction price for %s" % _nm_pid(pid), price,
                source="auction/lots")

    # -- rookie deals that ran out, and what became of each
    era_all = {str(l.get("player_id")): l for l in _all_era}
    faa_all = {str(l.get("player_id")): l for l in _all_faa}
    traded_away = {tok for e in my_events for tok in e["gave"]}
    now_team = {}
    for _f2, _pl in _LIVE_ROSTERS.items():
        if _f2 != "__failed__":
            for _p in _pl:
                now_team[str(_p.get("id"))] = _f2
    exp = sorted((pid for pid, v in prior.items()
                  if v["fid"] == fid and "Rookie" in v["status"] and v["cy"] == "1"), key=_nm_pid)
    exp_rows, n_ext, n_era = [], 0, 0
    for pid in exp:
        if pid in extended_on:
            out = "Extended (%s)" % extended_on[pid]
            n_ext += 1
        elif pid in era_all:
            l = era_all[pid]
            w = str(l.get("winner_fid", "")).zfill(4)
            price = (l.get("current_high_bid_k") or 0) * 1000
            out = ("Went to the Expired Rookie Auction; he bought him back for %s" % _usd(price) if w == fid else
                   "Went to the Expired Rookie Auction; %s paid %s" % (owners.get(w, {}).get("team_name", w), _usd(price)))
            n_era += 1
        elif pid in traded_away:
            out = "Traded before it ran out"
        elif pid in faa_all:
            l = faa_all[pid]
            w = str(l.get("winner_fid", "")).zfill(4)
            out = "Went to the Free Agent Auction; %s paid %s" % (
                "he" if w == fid else owners.get(w, {}).get("team_name", w),
                _usd((l.get("current_high_bid_k") or 0) * 1000))
        elif now_team.get(pid) == fid:
            # Devon Witherspoon: his rookie deal ran out and he is still on the
            # roster -- "not kept; now with The Long Haulers" said both at once.
            out = "Still on his roster"
        elif now_team.get(pid):
            out = "Not kept; now with %s" % owners.get(now_team[pid], {}).get("team_name", now_team[pid])
        else:
            out = "Not kept"
        exp_rows.append([_nm_pid(pid), positions.get(pid, "?"), out])
    _exp_src = "MFL %d rosters (Rookie, contractYear 1)" % (SEASON - 1)
    F("f.team.%s.expired_rookies" % fid, "Rookie contracts that ran out into this offseason", len(exp), "count", _exp_src, NOW_UTC)
    F("f.team.%s.expired_extended" % fid, "Of those, extended before they ran out", n_ext, "count", _exp_src, NOW_UTC)
    F("f.team.%s.expired_to_era" % fid, "Of those, sold at the Expired Rookie Auction", n_era, "count", _exp_src, NOW_UTC)

    # -- phase totals
    for ph in PHASES:
        w = PHASE_WORDS[ph]
        F("f.team.%s.cuts_%s" % (fid, ph), "Players released %s" % w, cut_tot[ph]["n"], "count", "ups_drop_events", NOW_UTC)
        F("f.team.%s.cuts_%s_salary" % (fid, ph), "Salary released %s" % w, cut_tot[ph]["sal"], "usd", "ups_drop_events", NOW_UTC)
        F("f.team.%s.cuts_%s_penalty" % (fid, ph), "Cap penalty from releases %s, whichever season it is charged to" % w,
          cut_tot[ph]["pen"], "usd", "ups_drop_events", NOW_UTC)
        F("f.team.%s.trades_%s" % (fid, ph), "Trades %s" % w, trade_tot[ph]["n"], "count", "mfl transactions", NOW_UTC)
        F("f.team.%s.trade_salary_out_%s" % (fid, ph), "Salary traded away %s" % w, trade_tot[ph]["out"], "usd",
          "mfl transactions + roster snapshots", NOW_UTC)
        F("f.team.%s.trade_salary_in_%s" % (fid, ph), "Salary taken on in trades %s" % w, trade_tot[ph]["in"], "usd",
          "mfl transactions + roster snapshots", NOW_UTC)
        F("f.team.%s.extensions_%s" % (fid, ph), "Extensions %s" % w, ctr["ext"][ph], "count", "contract_activity_2026", NOW_UTC)
        F("f.team.%s.pickups_%s" % (fid, ph), "Players picked up off waivers or free agency %s" % w, pickups[ph],
          "count", "mfl transactions", NOW_UTC)
    for key, label, v in (("rookie_extensions", "Rookie extensions this offseason", ctr["rookie_ext"]),
                          ("tags", "Players tagged", ctr["tags"]),
                          ("restructures_auction", "Restructures before or during the auction", ctr["rs_pre"]),
                          ("restructures_post", "Restructures after the auction", ctr["rs_post"]),
                          ("myac_era", "Multi-year contracts given to Expired Rookie Auction buys", ctr["myac_era"]),
                          ("myac_faa", "Multi-year contracts given to Free Agent Auction buys", ctr["myac_faa"]),
                          ("myac_trade", "Multi-year contracts given to players acquired by trade", ctr["myac_trade"]),
                          ("myac_other", "Multi-year contracts given to waiver or free-agent pickups", ctr["myac_other"])):
        F("f.team.%s.%s" % (fid, key), label, v, "count", "contract_activity_2026", NOW_UTC)

    _mcols = [{"key": "date", "label": "Date", "type": "text"},
              {"key": "move", "label": "Move", "type": "text"},
              {"key": "player", "label": "Player", "type": "text"},
              {"key": "detail", "label": "Detail", "type": "text"}]
    _mtitle = {"s1": "Before the rookie draft", "s2": "From the draft to the auction lock",
               "s3": "From the auction to week one"}
    t_moves = {}
    for ph in PHASES:
        t_moves[ph] = pack.table(
            "t.%s.moves_%s" % (fid, ph), _mtitle[ph], _mcols,
            sorted(moves[ph], key=lambda r: (r[0], r[1], r[2])),
            note="Every roster and contract move %s, in date order. Salaries in a trade row are each "
                 "player's salary in the first daily roster snapshot after the trade (snapshots begin "
                 "2026-04-21). A penalty 'charged to %d' is ledger-only this season. Tags always sit in the "
                 "pre-auction phase and every restructure in the auction phase, whatever their date."
                 % (PHASE_WORDS[ph], SEASON + 1))
    t_expired = pack.table(
        "t.%s.expired" % fid, "Rookie deals that ran out",
        [{"key": "player", "label": "Player", "type": "text"},
         {"key": "pos", "label": "Pos", "type": "text"},
         {"key": "outcome", "label": "What happened", "type": "text"}],
        exp_rows,
        note="Rookie contracts in their final year on MFL's final %d rosters (contractYear 1 = the last "
             "year). Extended = this owner extended him in %d before the deal ran out." % (SEASON - 1, SEASON))

    # -- Free Agent Auction buys, each with what it bought. Keith, on the value
    # table: "We see $$ Spent, but we don't know what it bought".
    def _band(pid):
        if LE.pos_group(positions.get(pid, "")) not in ("QB", "RB", "WR", "TE"):
            return "--"
        rank = pos_rank.get(pid)
        # Past the position's replacement bar is Depth whatever the raw rank --
        # Mark Andrews (TE, "Replacement-level TE") came out "Good" otherwise.
        if rank is None or not tiering.is_starter_grade(LE.pos_group(positions.get(pid, "")), rank):
            return "Depth"
        return "Elite" if rank <= 3 else "Very good" if rank <= 12 else "Good" if rank <= 24 else "Depth"

    faa_rows = []
    for l in sorted(faa_lots, key=lambda l: (-(l.get("current_high_bid_k") or 0), str(l.get("player_id")))):
        pid = str(l.get("player_id"))
        price = (l.get("current_high_bid_k") or 0) * 1000
        faa_rows.append([_nm_pid(pid), positions.get(pid, l.get("position") or "?"), price,
                         l.get("bid_count") or 0, _val_display(pid, LE.pos_group(positions.get(pid, ""))), _band(pid)])
        _rf("s3", "faa_%s_price" % pid, "Free Agent Auction price for %s" % _nm_pid(pid), price, source="auction/lots")
    t_faa = pack.table(
        "t.%s.faa" % fid, "Free Agent Auction buys",
        [{"key": "player", "label": "Player", "type": "text"},
         {"key": "pos", "label": "Pos", "type": "text"},
         {"key": "price", "label": "Price", "type": "usd"},
         {"key": "bids", "label": "Bids", "type": "count"},
         {"key": "grade", "label": "Grade today", "type": "text"},
         {"key": "band", "label": "Bought", "type": "text"}],
        faa_rows,
        note="Grade is today's tier at his position, the same vocabulary as the lineup. 'Bought' buckets "
             "OFFENSE by league-wide position rank on the live redraft board: Elite = top 3, Very good = "
             "4-12, Good = 13-24, Depth = everything below, off-board players included. The league value "
             "table counts these buckets for every owner.")

    # -- the owner's history (D1, rebuilt weekly by owner-career-stats.yml)
    _hist_all = {str(r["franchise_id"]).zfill(4): r for r in D.d1("SELECT * FROM ups_owner_career_stats")}
    h = _hist_all.get(fid)
    if not h:
        raise SystemExit("team_review_2026: ups_owner_career_stats has no row for %s" % fid)

    def _years(s):
        try:
            return [int(y) for y in json.loads(s or "[]")]
        except (TypeError, ValueError):
            return []

    def _n_years(n, s):
        ys = _years(s)
        return ("%d (%s)" % (n, ", ".join(str(y) for y in ys))) if n and ys else str(n or 0)

    H_SRC = "D1 ups_owner_career_stats"
    H_ASOF = str(h.get("updated_at") or NOW_UTC)
    for key, label, v, unit in (
            ("hist_seasons", "UPS seasons this owner has completed", int(h["owner_seasons_count"] or 0), "count"),
            ("hist_first_season", "This owner's first UPS season", str(h["owner_first_season"]), "text"),
            ("hist_titles", "Championships", int(h["owner_championships"] or 0), "count"),
            ("hist_runner_ups", "Runner-up finishes", int(h["owner_runner_ups"] or 0), "count"),
            ("hist_ap_titles", "Seasons with the league's best all-play record", int(h["owner_allplay_titles"] or 0), "count"),
            ("hist_playoffs", "Playoff appearances", int(h["owner_playoff_appearances"] or 0), "count"),
            ("hist_div_titles", "Division titles (2011 on)", int(h["owner_division_titles"] or 0), "count"),
            ("hist_allplay_pct", "Career all-play winning percentage", round(100.0 * float(h["owner_allplay_pct"] or 0), 1), "percent")):
        F("f.team.%s.%s" % (fid, key), label, v, unit, H_SRC, H_ASOF)
        row_facts["s4"].append("f.team.%s.%s" % (fid, key))
    for key, col, label in (("hist_title_years", "owner_title_years", "Championship years"),
                            ("hist_runner_up_years", "owner_runner_up_years", "Runner-up years"),
                            ("hist_ap_title_years", "owner_allplay_title_years", "Best all-play record, years"),
                            ("hist_div_title_years", "owner_division_title_years", "Division title years")):
        ys = _years(h.get(col))
        if ys:
            F("f.team.%s.%s" % (fid, key), label, ", ".join(str(y) for y in ys), "text", H_SRC, H_ASOF)
            row_facts["s4"].append("f.team.%s.%s" % (fid, key))
    t_hist = pack.table(
        "t.%s.history" % fid, "Owner history",
        [{"key": "seasons", "label": "Seasons", "type": "count"},
         {"key": "titles", "label": "Titles", "type": "text"},
         {"key": "runner", "label": "Runner-up", "type": "text"},
         {"key": "ap", "label": "All-play titles", "type": "text"},
         {"key": "playoffs", "label": "Playoff trips", "type": "count"},
         {"key": "divs", "label": "Division titles", "type": "text"},
         {"key": "ap_pct", "label": "Career all-play", "type": "percent"}],
        [[int(h["owner_seasons_count"] or 0),
          _n_years(int(h["owner_championships"] or 0), h.get("owner_title_years")),
          _n_years(int(h["owner_runner_ups"] or 0), h.get("owner_runner_up_years")),
          _n_years(int(h["owner_allplay_titles"] or 0), h.get("owner_allplay_title_years")),
          int(h["owner_playoff_appearances"] or 0),
          _n_years(int(h["owner_division_titles"] or 0), h.get("owner_division_title_years")),
          round(100.0 * float(h["owner_allplay_pct"] or 0), 1)]],
        note="The league's own documented record, by OWNER: a season counts for whoever owned the team at "
             "kickoff. All-play is regular season only 2010-2016 and the full season from 2017 (league "
             "context D.1); an all-play title is the season's best all-play record. Playoff trips are "
             "actual seeds. Division titles from 2011 (2010 had two divisions).")

    # -- the division, by the preseason simulation (season_sim.py)
    sim_by = {t["franchiseId"]: t for t in sim["teams"]}
    if fid not in sim_by:
        raise SystemExit("team_review_2026: the season sim has no row for %s" % fid)
    S_SRC = "season_sim.py, %d runs" % sim["runs"]
    S_ASOF = sim["generatedAtUtc"]
    me = sim_by[fid]
    for key, label, v, unit, fmt in (
            ("power_rank", "Preseason power rank (simulated expected all-play %)", me["powerRank"], "rank", None),
            ("sim_exp_allplay", "Simulated expected regular-season all-play %", round(100.0 * me["expAllPlayPct"], 1), "percent", None),
            ("sim_exp_wins", "Simulated expected head-to-head wins", round(me["expWins"], 1), "ratio", "%.1f" % me["expWins"]),
            ("sim_games", "Regular-season games", me["games"], "count", None),
            ("sim_p_division", "Simulated chance of winning the division", round(100.0 * me["pDivision"], 1), "percent", None),
            ("sim_p_playoffs", "Simulated playoff odds", round(100.0 * me["pPlayoffs"], 1), "percent", None),
            ("sim_p_bye", "Simulated chance of a first-round bye", round(100.0 * me["pBye"], 1), "percent", None),
            ("sim_p_title", "Simulated title odds", round(100.0 * me["pTitle"], 1), "percent", None)):
        F("f.team.%s.%s" % (fid, key), label, v, unit, S_SRC, S_ASOF, fmt=fmt)
        row_facts["s5"].append("f.team.%s.%s" % (fid, key))
    for f2 in sorted(sim_by):
        t2, h2 = sim_by[f2], _hist_all.get(f2) or {}
        F("f.league.power_rank_%s" % f2, "Preseason power rank: %s" % t2["team"], t2["powerRank"], "rank", S_SRC, S_ASOF)
        F("f.league.p_playoffs_%s" % f2, "Simulated playoff odds: %s" % t2["team"], round(100.0 * t2["pPlayoffs"], 1), "percent", S_SRC, S_ASOF)
        F("f.league.p_title_%s" % f2, "Simulated title odds: %s" % t2["team"], round(100.0 * t2["pTitle"], 1), "percent", S_SRC, S_ASOF)
        row_facts["s5"] += ["f.league.power_rank_%s" % f2, "f.league.p_playoffs_%s" % f2, "f.league.p_title_%s" % f2]
        if h2:
            F("f.league.allplay_career_%s" % f2, "Career all-play %%: %s" % h2.get("owner_display"),
              round(100.0 * float(h2.get("owner_allplay_pct") or 0), 1), "percent", H_SRC, H_ASOF)
            F("f.league.titles_%s" % f2, "Championships: %s" % h2.get("owner_display"),
              int(h2.get("owner_championships") or 0), "count", H_SRC, H_ASOF)
            row_facts["s5"] += ["f.league.allplay_career_%s" % f2, "f.league.titles_%s" % f2]
            ys = _years(h2.get("owner_title_years"))
            if ys:
                F("f.league.title_years_%s" % f2, "Championship years: %s" % h2.get("owner_display"),
                  ", ".join(str(y) for y in ys), "text", H_SRC, H_ASOF)
                row_facts["s5"].append("f.league.title_years_%s" % f2)
    pack.warn("POWER RANKINGS are the preseason simulation's (site/wire/data/season_sim_%d.json): %d seasons "
              "simulated from today's rosters and MFL's weekly projections, each team's projected edge kept at "
              "%.0f%% (regressed toward the league; backtested on 2021-2025, where it explained about 40%% of "
              "the spread in final all-play and ranked the field with a correlation of about .57 -- but only "
              ".3 to .4 in each of the last three seasons). Say 'projected' and 'odds', never 'will'. It cannot "
              "see trades, waiver moves or owners' lineup choices."
              % (SEASON, sim["runs"], 100 * sim["model"]["regress"]))
    if _div_members:
        _dord = sorted(_div_members, key=lambda f2: sim_by[f2]["powerRank"])
        F("f.team.%s.division_rank" % fid, "Rank inside the division, by preseason power rank",
          _dord.index(fid) + 1, "count", S_SRC, S_ASOF)
        t_div = pack.table(
            "t.%s.division" % fid, "The division",
            [{"key": "team", "label": "Team", "type": "text"},
             {"key": "owner", "label": "Owner", "type": "text"},
             {"key": "power", "label": "Power rank", "type": "count"},
             {"key": "playoffs", "label": "Playoff odds", "type": "percent"},
             {"key": "title", "label": "Title odds", "type": "percent"},
             {"key": "ap", "label": "Career all-play", "type": "percent"},
             {"key": "titles", "label": "Titles", "type": "text"}],
            [[owners.get(f2, {}).get("team_name", f2), (_hist_all.get(f2) or {}).get("owner_display") or "",
              sim_by[f2]["powerRank"], round(100.0 * sim_by[f2]["pPlayoffs"], 1),
              round(100.0 * sim_by[f2]["pTitle"], 1),
              round(100.0 * float((_hist_all.get(f2) or {}).get("owner_allplay_pct") or 0), 1),
              _n_years(int((_hist_all.get(f2) or {}).get("owner_championships") or 0),
                       (_hist_all.get(f2) or {}).get("owner_title_years"))] for f2 in _dord],
            note="Power rank, playoff and title odds are the preseason simulation's. Career all-play and titles "
                 "are each OWNER's documented record. Each division rival is played FIVE times in the 37-game "
                 "schedule -- never write that division rivals meet twice.")

    pack.coverage = {"seasonsComplete": [2010, 2025], "currentSeason": SEASON, "currentSeasonPartial": True}

    _f = lambda *keys: ["f.team.%s.%s" % (fid, k) for k in keys]
    _have = lambda ids: [x for x in ids if x in pack._facts]

    pack.section(
        "s1", "Early Preseason",
        "The lay of the land in April, then everything before the rookie draft. Open with the April column of "
        "the slot table -- which priced slots were filled, and by whom -- and the active players and salary he "
        "carried. Then, from the moves table, in date order: cuts (say whether they were large cap hits or "
        "mostly small, and quote a big one with its salary and penalty facts), trades with the salary that "
        "moved (and any player he extended and then traded), rookie extensions, and his rookie deals that ran "
        "out and what became of each (the expired table). A contract running out on schedule is the league's "
        "normal cycle, not a crisis. If the roster shrank before the auction, say WHY from the rows: which "
        "players were cut, traded, or ran out.",
        fact_ids=_have(_f("active_roster_opening", "cap_opening", "studs_opening", "holes_opening",
                          "can_field_lineup_opening", "expired_rookies", "expired_extended", "expired_to_era",
                          "rookie_extensions", "cuts_s1", "cuts_s1_salary", "cuts_s1_penalty", "trades_s1",
                          "trade_salary_out_s1", "trade_salary_in_s1", "extensions_s1", "pickups_s1",
                          "biggest_contract_traded_away", "trade_blind_bid_cash", "trade_blind_bid_elsewhere"))
        + row_facts["s1"],
        table_ids=[t_slots, t_bridge, t_moves["s1"], t_expired, t_trades, t_contracts, t_cuts])
    pack.section(
        "s2", "Pre-Auction",
        "The rookie draft, the Expired Rookie Auction, tags, and the cuts and trades from the draft to the "
        "auction roster lock (lock-day cuts included). For each rookie pick compare the player with the "
        "historical baseline at that slot -- an expectation before any outcome, not a grade. ERA players are "
        "expired rookie deals, a different caliber from the free-agent market; never grade them against it. "
        "A TAG IS A CHIP (Keith): an owner tags a player to trade him, or to let him go and get the money back "
        "to spend on someone else, so a tag followed by a release is not automatically a mistake -- say what "
        "the money did next. Give a released player's salary and penalty from his row facts.",
        fact_ids=_have(_f("rookie_picks_count", "era_spend", "era_lots_won", "tags", "cuts_s2", "cuts_s2_salary",
                          "cuts_s2_penalty", "trades_s2", "trade_salary_out_s2", "trade_salary_in_s2",
                          "extensions_s2", "pickups_s2", "active_roster_preauction", "cap_preauction",
                          "can_field_lineup_preauction"))
        + _have(["f.league.era_pool_size", "f.league.era_top_price"]) + row_facts["s2"],
        table_ids=[t_rookies, t_moves["s2"], t_auction])
    pack.section(
        "s3", "The Auction and Preseason Contracts",
        "The Free Agent Auction: what he spent and what it BOUGHT -- the grade column, and the league table's "
        "Bought column (Elite / Very good / Good / Depth), which is how his money compares with everyone "
        "else's; never print a value-per-dollar multiple. Every restructure: those before or during the "
        "auction opened room for it -- say whether the room was then used -- and those after it are "
        "post-auction restructures. Multi-year contracts, from the ERA and the FAA alike. Then the preseason "
        "waiver and free-agent moves to week one and the contracts that came from them. Close on the lineup "
        "it built: NAME the holes and the studs rather than counting them. Defense and the kicker are "
        "footnotes -- one clause each.",
        fact_ids=_have(_f("faa_spend", "faa_lots_won", "auction_spend", "top_buy_price", "top_buy_pct_of_spend",
                          "restructures_auction", "restructures_post", "restructure_room_freed", "myac_era",
                          "myac_faa", "myac_trade", "myac_other", "cuts_s3", "cuts_s3_salary", "cuts_s3_penalty", "trades_s3",
                          "trade_salary_out_s3", "trade_salary_in_s3", "extensions_s3", "pickups_s3",
                          "studs_postauction", "holes_postauction", "studs_today", "holes_today",
                          "active_roster_current", "active_today", "taxi_now", "ir_now", "cap_current_spent",
                          "cap_current_room", "qb_rank", "rb_rank", "wr_rank", "te_rank", "idp_auction_spend",
                          "idp_auction_share", "idp_adds_alltime", "idp_adds_rank", "idp_adds_next_best",
                          "idp_adds_lead_streak", "idp_ppw_rank"))
        + _have(["f.league.faa_top_price", "f.league.roster_max_at_auction"]) + row_facts["s3"],
        table_ids=[t_faa, t_moves["s3"], t_lineup, t_bench] + ([t_idp] if t_idp else []))
    pack.section(
        "s4", "Historical Context",
        "This owner's record in the league, from the history table: seasons, titles with their years, "
        "runner-up finishes, all-play titles, playoff trips and division titles. It is the league's own "
        "documented record, by owner. Two or three sentences of context, not a eulogy.",
        fact_ids=row_facts["s4"],
        table_ids=[t_hist])
    pack.section(
        "s5", "The Division",
        "The division by the preseason simulation -- each team's power rank and its playoff and title odds, "
        "beside each owner's career all-play and title years. Division rivals meet FIVE times each. Then a "
        "short, fun look at the next three years, clearly framed as a projection. If a Week table is present, "
        "close on it in a sentence or two: an opening data point, never a verdict, and never call a player "
        "injured from a score.",
        fact_ids=_have(_f("division_name", "division_size", "division_rank", "wk_live", "wk_players_final",
                          "wk_points_final")) + _have(["f.league.wk_teams_final", "f.league.teams"]) + row_facts["s5"],
        table_ids=([t_div] if t_div else []) + ([t_wk1] if t_wk1 else []))

    return pack

