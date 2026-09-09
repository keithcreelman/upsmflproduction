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

PACK_ID_RE = re.compile(r"^2026-team-(\d{4})$")
SEASON = 2026
PREAUCTION_DATE = "2026-07-23"  # faa_roster_lock_at, from ups_settings.auction_calendar
# The UPS minimum salary is $1,000 (canon §A1: R6 rookie slot, the $1K flat WW
# salary, and the 2025 switch to a flat $1K opening auction bid all sit here).
# Stated once so nothing downstream can call a $2,000 deal "minimum" -- that
# error reached print in the first 0008 review, on Kayshon Boutte.
LEAGUE_MIN_SALARY = 1000


def _money(v):
    s = str(v or "").replace("$", "").replace(",", "").strip()
    if not s:
        return 0
    try:
        return int(round(float(s)))
    except ValueError:
        return 0


def _fresh_adp_board():
    """Live redraft-ADP pull (bypasses the stale committed July snapshot).

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
    """
    base = D.WORKER_BASE + "/api/adp-board"
    rsf, name, pos_rank, confidence = {}, {}, {}, {}
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
            pos_rank[pid] = x.get("posRank")
    return rsf, name, pos_rank, confidence


# The 9 legal-lineup slots whose eligible positions ADP actually prices.
# K/P/DL/LB/DB are salary-filled (see lineup_engine) and excluded here --
# "studs/holes" is a redraft-market read, and ADP has no opinion on them.
_ADP_SLOTS = ("QB1", "RB1", "RB2", "WR1", "WR2", "TE1", "OF1", "OF2", "SF1")


def _tier_counts(lu_, pos_rank):
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
        elif rank <= 12:
            out["stud"] += 1
        elif rank <= 24:
            out["solid"] += 1
        else:
            out["hole"] += 1
    return out


def _tier_slots(lu_, pos_rank, name_of):
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
            out.append((slot_id, None, "(empty)", None, "hole"))
            continue
        tier = "hole" if rank is None else ("stud" if rank <= 12 else
                                            "solid" if rank <= 24 else "hole")
        out.append((slot_id, pid, name_of(pid), rank, tier))
    return out


def _slot_cell(entry):
    """"Puka Nacua (WR3)" -- or the bare name when the board has no rank."""
    _slot, _pid, nm, rank, _tier = entry
    if nm == "(empty)":
        return "(empty)"
    return nm if rank is None else "%s (%s)" % (nm, rank)


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
               __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
               .strftime("%Y-%m-%dT%H:%M:%SZ"),
               rows=len(rsf), note="current, NOT the 2026-07-21 committed snapshot")

    dates = D.snapshot_dates()
    opening_date = dates[0]
    current_date = dates[-1]
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

    def offense_score(r):
        return rsf.get(r["pid"], 0.0)

    def other_score(r):
        # Slot-FILLING only. A defender with no prior-season production has no
        # value here and must never be scored 0 into a reported sum, but the
        # lineup still has to put somebody in the slot -- salary is the
        # tiebreaker for that and nothing else. K/P reach this too; ADP and this
        # model both decline to price them.
        hit = idp_value.get(r["pid"])
        return float(hit["par"]) if hit else float(r["salary"]) / 100000.0

    # ---- legal lineup, all 12 teams (needed for league-relative ranks) ----
    all_lineups = {}
    current_rows_by_fid = {}
    for franchise_row in D.d1("SELECT DISTINCT franchise_id FROM src_franchises WHERE season=%d" % SEASON):
        f = str(franchise_row["franchise_id"]).zfill(4)
        rows = _roster_rows(current_date, f, positions)
        if rows:
            all_lineups[f] = LE.build_legal_lineup(rows, offense_score, other_score)
            current_rows_by_fid[f] = rows
    pack.source("data/mfl-snapshots/%s/rosters.json (all 12 franchises, for league-relative ranks)" % current_date,
               current_date, rows=sum(len(v["slots"]) for v in all_lineups.values()))

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

    F("f.team.%s.qb_rank" % fid, "QB starters rank", ranks["QB"][fid], "rank", "lineup_engine", current_date)
    F("f.team.%s.rb_rank" % fid, "RB starters rank", ranks["RB"][fid], "rank", "lineup_engine", current_date)
    F("f.team.%s.wr_rank" % fid, "WR starters rank", ranks["WR"][fid], "rank", "lineup_engine", current_date)
    F("f.team.%s.te_rank" % fid, "TE starters rank", ranks["TE"][fid], "rank", "lineup_engine", current_date)
    F("f.team.%s.qb_value" % fid, "QB starters redraft value", pos_value["QB"][fid], "count", "adp-board", current_date)
    F("f.team.%s.rb_value" % fid, "RB starters redraft value", pos_value["RB"][fid], "count", "adp-board", current_date)
    F("f.team.%s.wr_value" % fid, "WR starters redraft value", pos_value["WR"][fid], "count", "adp-board", current_date)
    F("f.team.%s.te_value" % fid, "TE starters redraft value", pos_value["TE"][fid], "count", "adp-board", current_date)
    F("f.team.%s.composite_rank" % fid, "Overall power rank", comp_rank[fid], "rank", "lineup_engine", current_date)
    F("f.team.%s.composite_value" % fid, "Composite score", round(composite[fid]), "count", "lineup_engine", current_date)
    F("f.league.teams", "Teams in the league", 12, "count", "src_franchises", str(SEASON))

    def _val_display(pid, pg):
        if pg in ("QB", "RB", "WR", "TE"):
            v = rsf.get(pid)
            return "{:,} redraft".format(v) if v is not None else "off ADP board"
        if pg in ("DL", "LB", "DB"):
            hit = idp_value.get(pid)
            # Tier + PAR, never a bare ordinal: the ordering inside a tier is
            # not supported by the data (see the pack warning).
            if not hit:
                return "no prior-season production"
            # Both numbers, both labelled. The projection is the value; the
            # realized figure is why the reader should care about the name.
            # Sign the realized figure explicitly: it goes NEGATIVE for
            # below-replacement defenders (Chuck Clark 2025 was -49.3), and a
            # hardcoded "+" rendered that as "+-49.3".
            return "%s %s — proj +%.1f, was %+.1f last season (%+.2f/gm)" % (
                hit["tier"], hit["pos"], hit["par"], hit["realized"], hit["realized_per_game"])
        return "—"

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
    bench_sorted = sorted(lu["bench"], key=lambda r: -(other_score(r) if LE.pos_group(r["pos"]) not in ("QB","RB","WR","TE") else rsf.get(r["pid"], 0)))[:10]
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
    lu_open = LE.build_legal_lineup(open_rows, offense_score, other_score) if open_rows else None
    lu_pre = LE.build_legal_lineup(pre_rows, offense_score, other_score) if pre_rows else None

    def lineup_val(lu_):
        if not lu_:
            return 0
        return sum(rsf.get(pid, 0) for pid in lu_["starter_pids"]
                   if LE.pos_group(positions.get(pid, "")) in ("QB", "RB", "WR", "TE"))

    cap_open = _active_salary(opening_date, fid)
    cap_pre = _active_salary(PREAUCTION_DATE, fid)
    compliance = D.worker_get("/api/auction/compliance", YEAR=SEASON)
    comp_row = next((c for c in compliance.get("franchises", [])
                     if str(c.get("fid", "")).zfill(4) == fid), {})
    cap_current_spent = (comp_row.get("cap_spent_k") or 0) * 1000
    cap_current_room = (comp_row.get("cap_room_k") or 0) * 1000
    active_count = comp_row.get("active_count")

    F("f.team.%s.cap_opening" % fid, "Active-roster salary, opening snapshot", cap_open, "usd", "roster_salaries", opening_date)
    F("f.team.%s.cap_preauction" % fid, "Active-roster salary, entering the auction", cap_pre, "usd", "roster_salaries", PREAUCTION_DATE)
    F("f.team.%s.cap_current_spent" % fid, "Cap committed now", cap_current_spent, "usd", "auction/compliance", current_date)
    F("f.team.%s.cap_current_room" % fid, "Cap room now", cap_current_room, "usd", "auction/compliance", current_date)
    F("f.team.%s.active_now" % fid, "Active roster now", active_count or 0, "count", "auction/compliance", current_date)
    F("f.team.%s.lineup_value_opening" % fid, "Legal-lineup offense value, opening (today's market)", lineup_val(lu_open), "count", "lineup_engine+adp-board", opening_date)
    F("f.team.%s.lineup_value_preauction" % fid, "Legal-lineup offense value, entering the auction (today's market)", lineup_val(lu_pre), "count", "lineup_engine+adp-board", PREAUCTION_DATE)
    F("f.team.%s.lineup_value_current" % fid, "Legal-lineup offense value, now", lineup_val(lu), "count", "lineup_engine+adp-board", current_date)
    pack.warn("Opening/pre-auction cap figures are ACTIVE-ROSTER SALARY ONLY (no salaryAdjustments); "
              "the live 'cap committed now' figure DOES include adjustments. The two are not "
              "subtractable -- they measure different things.")

    tiers_open = _tier_counts(lu_open, pos_rank)
    tiers_pre = _tier_counts(lu_pre, pos_rank)
    tiers_now = _tier_counts(lu, pos_rank)
    F("f.team.%s.holes_opening" % fid, "Starting-lineup holes, opening (of 9 ADP-priced slots)", tiers_open["hole"], "count", "lineup_engine+adp-board", opening_date)
    F("f.team.%s.studs_opening" % fid, "Starting-lineup studs, opening (top-12 at position)", tiers_open["stud"], "count", "lineup_engine+adp-board", opening_date)
    F("f.team.%s.holes_current" % fid, "Starting-lineup holes, now (of 9 ADP-priced slots)", tiers_now["hole"], "count", "lineup_engine+adp-board", current_date)
    F("f.team.%s.studs_current" % fid, "Starting-lineup studs, now (top-12 at position)", tiers_now["stud"], "count", "lineup_engine+adp-board", current_date)
    pack.warn("Studs/solid/holes classify each of the 9 ADP-priced starting slots (QB, 2xRB, "
              "2xWR, TE, 2x Flex, SuperFlex) by the occupying player's LEAGUE-WIDE position rank: "
              "stud = top 12 at his position, solid = top 24, hole = outside the top 24 or the slot "
              "has no rank at all. This is a needs read, not a value total -- two teams can carry "
              "the identical summed lineup value with completely different hole counts (a few elite "
              "starters and real gaps, versus adequate-everywhere), and that difference is the point.")

    t_bridge = pack.table("t.%s.bridge" % fid, "The offseason bridge",
                          [{"key": "stage", "label": "Stage", "type": "text"},
                           {"key": "date", "label": "Date", "type": "text"},
                           {"key": "cap", "label": "Active salary / cap spent", "type": "usd"},
                           {"key": "lineupval", "label": "Legal-lineup offense value (today's market)", "type": "count"},
                           {"key": "studs", "label": "Studs (top-12)", "type": "count"},
                           {"key": "solid", "label": "Solid (top-24)", "type": "count"},
                           {"key": "holes", "label": "Holes (of 9)", "type": "count"}],
                          [
                              ["Entering the offseason", opening_date, cap_open, lineup_val(lu_open),
                               tiers_open["stud"], tiers_open["solid"], tiers_open["hole"]],
                              ["Entering the auction", PREAUCTION_DATE, cap_pre, lineup_val(lu_pre),
                               tiers_pre["stud"], tiers_pre["solid"], tiers_pre["hole"]],
                              ["Now", current_date, cap_current_spent, lineup_val(lu),
                               tiers_now["stud"], tiers_now["solid"], tiers_now["hole"]],
                          ])

    # Same three stages, but slot by slot and BY NAME -- see _tier_slots for why
    # the counts on their own were not enough.
    _nm = lambda pid: adp_name.get(pid) or mfl_name.get(pid, "Unknown player %s" % pid)
    slots_open, slots_pre, slots_now = (_tier_slots(lu_open, pos_rank, _nm),
                                        _tier_slots(lu_pre, pos_rank, _nm),
                                        _tier_slots(lu, pos_rank, _nm))
    t_slots = pack.table("t.%s.slot_bridge" % fid, "Who filled each priced slot, stage by stage",
                         [{"key": "slot", "label": "Slot", "type": "text"},
                          {"key": "open", "label": "Entering the offseason", "type": "text"},
                          {"key": "pre", "label": "Entering the auction", "type": "text"},
                          {"key": "now", "label": "Now", "type": "text"}],
                         [[a[0], _slot_cell(a), _slot_cell(b), _slot_cell(c)]
                          for a, b, c in zip(slots_open, slots_pre, slots_now)],
                         note="Parenthesised number is the player's LEAGUE-WIDE rank at his "
                              "position on the live redraft board: <=12 is a stud, <=24 solid, "
                              "beyond that (or unranked, or empty) a hole. Use these NAMES when "
                              "describing how the lineup changed -- a stud count moving 1 -> 2 can "
                              "conceal the largest single upgrade of the offseason.")

    # ---- auction ----
    lots = D.worker_get("/api/auction/lots", status="won").get("lots", [])
    my_lots = [l for l in lots if str(l.get("winner_fid", "")).zfill(4) == fid and not l.get("is_test")]
    spend = sum((l.get("current_high_bid_k") or 0) * 1000 for l in my_lots)
    top = max(my_lots, key=lambda l: l.get("current_high_bid_k") or 0) if my_lots else None
    F("f.team.%s.auction_spend" % fid, "Auction spend", spend, "usd", "auction/lots", current_date)
    F("f.team.%s.auction_lots_won" % fid, "Auction lots won", len(my_lots), "count", "auction/lots", current_date)
    if top:
        F("f.team.%s.top_buy_price" % fid, "Top auction buy, price", (top.get("current_high_bid_k") or 0) * 1000, "usd", "auction/lots", current_date)
        pct = 100.0 * ((top.get("current_high_bid_k") or 0) * 1000) / spend if spend else 0
        F("f.team.%s.top_buy_pct_of_spend" % fid, "Top buy as % of total auction spend", pct, "percent", "auction/lots", current_date)
    t_auction = pack.table("t.%s.auction" % fid, "Auction wins",
                           [{"key": "player", "label": "Player", "type": "text"},
                            {"key": "pos", "label": "Pos", "type": "text"},
                            {"key": "price", "label": "Price", "type": "usd"},
                            {"key": "bids", "label": "Bids", "type": "count"}],
                           sorted([[l.get("player_name"), l.get("position"),
                                    (l.get("current_high_bid_k") or 0) * 1000, l.get("bid_count") or 0]
                                  for l in my_lots], key=lambda r: -r[2]))

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
    except Exception:
        waiver_swap_pids = set()          # MFL unreachable -> classify nothing, do not guess

    opening_pids = {r["pid"] for r in _roster_rows(opening_date, fid, positions)}

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
        sal = d.get("pre_drop_salary") or 0
        pen = d.get("penalty_amount") or 0
        # Which cap year the penalty lands in is a per-row fact and has to be
        # readable AS a row. The totals were already split (cuts_penalty_2026 vs
        # _deferred), but the table showed a bare "Penalty" column, so a reader
        # -- human or model -- could only add them up into one number, which is
        # exactly the §D1 error the split was meant to prevent.
        applies = int(d.get("applies_to_season") or SEASON)
        charged = "--" if not pen else ("%d (deferred)" % applies if applies > SEASON else str(applies))
        cut_rows.append([adp_name.get(pid) or mfl_name.get(pid, "Unknown player %s" % pid), positions.get(pid, "?"),
                         str(d.get("dropped_at_iso"))[:10], _kind(d), sal, pen, charged, sal - pen])

    real_cuts = [d for d in drops if _kind(d) == "cut"]
    pen_2026 = sum((d.get("penalty_amount") or 0) for d in drops
                   if int(d.get("applies_to_season") or SEASON) == SEASON)
    pen_next = sum((d.get("penalty_amount") or 0) for d in drops
                   if int(d.get("applies_to_season") or SEASON) > SEASON)

    F("f.team.%s.cuts_count" % fid, "Contracts cut (carried into the season)", len(real_cuts),
      "count", "ups_drop_events", current_date)
    F("f.team.%s.roster_removals_total" % fid, "Roster removals of all kinds", len(drops),
      "count", "ups_drop_events", current_date)
    F("f.team.%s.waiver_swaps" % fid, "Drops that were the make-room leg of a waiver claim",
      sum(1 for d in drops if _kind(d) == "waiver swap"), "count", "mfl transactions", current_date)
    F("f.team.%s.inyear_flyers" % fid, "Players signed and discarded inside the same offseason",
      sum(1 for d in drops if _kind(d) == "in-year flyer"), "count", "ups_drop_events", current_date)
    F("f.team.%s.cuts_penalty_%d" % (fid, SEASON), "Cap penalty charged to this season", pen_2026,
      "usd", "ups_drop_events", current_date)
    F("f.team.%s.cuts_penalty_%d_deferred" % (fid, SEASON + 1),
      "Cap penalty deferred to next season (ledger-only, not yet charged)", pen_next,
      "usd", "ups_drop_events", current_date)
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
                         {"key": "relief", "label": "Net relief", "type": "usd"}],
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
                out.append("%s round-%s pick (%s's natural pick)" %
                           (yr, rnd, owners.get(own_fid.zfill(4), {}).get("team_name", own_fid)))
            elif t.startswith("BB_"):
                out.append("$%s of blind-bid consideration" % format(int(t.split("_")[1]), ","))
            else:
                pg = LE.pos_group(positions.get(t, ""))
                nm = adp_name.get(t) or mfl_name.get(t, "Unknown player %s" % t)
                if pg in ("QB", "RB", "WR", "TE"):
                    val = rsf.get(t)
                    out.append("%s (%s, redraft value %s)" % (nm, positions.get(t, "?"),
                               "{:,}".format(val) if val is not None else "unpriced -- off the redraft board"))
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

    # ---- contracts handed out (extensions/restructures/tags/MYM/FA) ----
    activity_rows, activity_provenance = D.contract_activity(SEASON)
    from preseason_review import distinct_outcomes as _distinct_outcomes
    outcomes = _distinct_outcomes(activity_rows)
    my_contracts = [r for r in outcomes if str(r.get("franchise_id", "")).zfill(4) == fid]
    contract_rows = []
    for r in sorted(my_contracts, key=lambda r: r.get("submitted_at_utc") or ""):
        pid = str(r.get("player_id"))
        nm = adp_name.get(pid) or mfl_name.get(pid) or D.display_name(r.get("player_name"))
        contract_rows.append([
            nm, r.get("position") or positions.get(pid, "?"), r.get("activity_type"),
            r.get("contract_status") or "", r.get("salary") or 0,
            "yes" if (r.get("salary") or 0) == LEAGUE_MIN_SALARY else "no",
            r.get("tcv") or 0,
            str(r.get("submitted_at_utc") or "")[:10],
        ])
    F("f.team.%s.contracts_count" % fid, "Contract moves (extensions/restructures/tags/MYM/FA)",
      len(my_contracts), "count", "contract_activity_2026", current_date)
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

    # ---- rookie picks ----
    tiers = json.load(open(os.path.join(D.REPO, "site", "rookies", "rookie_draft_tiers.json")))
    picks = D.d1("SELECT draftpick_round, draftpick_overall, draftpick_roundorder, player_id, "
                "player_name FROM src_draft_picks WHERE season=2026 AND franchise_id='%s' "
                "ORDER BY draftpick_overall" % fid)
    rookie_rows = []
    for p in picks:
        label = _pick_label(p["draftpick_round"], p["draftpick_roundorder"])
        band = tiers.get("bands", {}).get(label, {}).get("offense", {})
        pid = str(p["player_id"])
        val = rsf.get(pid)
        rookie_rows.append([label, D.display_name(p["player_name"]),
                            "%.0f%% usable historically at this slot" % (band.get("usable_pct", 0) * 100) if band else "no band data",
                            "{:,}".format(val) if val is not None else "off the redraft board yet"])
    F("f.team.%s.rookie_picks_count" % fid, "Rookie picks made", len(picks), "count", "src_draft_picks", current_date)
    t_rookies = pack.table("t.%s.rookies" % fid, "2026 rookie draft class",
                           [{"key": "pick", "label": "Pick", "type": "text"},
                            {"key": "player", "label": "Player", "type": "text"},
                            {"key": "baseline", "label": "Historical baseline at this slot", "type": "text"},
                            {"key": "val", "label": "Current redraft value", "type": "text"}],
                           rookie_rows,
                           note="Baseline = 2015-2025 smash/hit/contrib/bust outcome rates at that exact "
                                "draft slot. 2026 rookies have zero seasons of outcome data, so this is "
                                "the PRE-outcome expectation, not a grade on the player yet.")

    pack.coverage = {"seasonsComplete": [2010, 2025], "currentSeason": SEASON, "currentSeasonPartial": True}

    pack.section("s1", "The Lineup", "How this team's legal starting lineup stacks up against the "
                "other 11 -- name every starter, name the position ranks, and say whether the "
                "strength is balanced or concentrated in one or two players.",
                fact_ids=["f.team.%s.qb_rank" % fid, "f.team.%s.rb_rank" % fid,
                         "f.team.%s.wr_rank" % fid, "f.team.%s.te_rank" % fid,
                         "f.team.%s.qb_value" % fid, "f.team.%s.rb_value" % fid,
                         "f.team.%s.wr_value" % fid, "f.team.%s.te_value" % fid,
                         "f.team.%s.composite_rank" % fid, "f.team.%s.composite_value" % fid,
                         "f.league.teams"],
                table_ids=[t_lineup, t_bench])
    pack.section("s2", "The Bridge", "Tell the offseason arc in three stages -- entering the "
                "offseason, entering the auction, now -- using the two bridge tables. Keep "
                "'strongest team' (carried on existing contracts) and 'best offseason' (created "
                "this year) explicitly separate. NOTHING HERE IS INHERITED: this owner kept the "
                "same franchise, contracts expired, and he rebuilt -- an empty April roster is the "
                "normal state of that cycle, not a crisis and not news. Use the slot-by-slot table "
                "to name who actually filled each priced slot at each stage; a stud count that "
                "moves 1 -> 2 can hide the single biggest upgrade of the offseason, so report the "
                "NAME CHANGE in the slot, not just the count. "
                "The studs/solid/holes columns are a NEEDS read, separate from the value total: say "
                "explicitly whether this is a lineup of a few elite starters with real gaps, or one "
                "that is merely adequate everywhere -- two teams can carry the same summed value and "
                "look completely different on this axis, and that difference is the story, not the total.",
                fact_ids=["f.team.%s.cap_opening" % fid, "f.team.%s.cap_preauction" % fid,
                         "f.team.%s.cap_current_spent" % fid, "f.team.%s.cap_current_room" % fid,
                         "f.team.%s.active_now" % fid, "f.team.%s.lineup_value_opening" % fid,
                         "f.team.%s.lineup_value_preauction" % fid, "f.team.%s.lineup_value_current" % fid,
                         "f.team.%s.holes_opening" % fid, "f.team.%s.studs_opening" % fid,
                         "f.team.%s.holes_current" % fid, "f.team.%s.studs_current" % fid],
                table_ids=[t_bridge, t_slots])
    pack.section("s3", "The Auction", "What this owner bought and for how much. Use the "
                "top-buy-percent fact for any 'most of his spend' style claim -- never estimate one.",
                fact_ids=["f.team.%s.auction_spend" % fid, "f.team.%s.auction_lots_won" % fid]
                + (["f.team.%s.top_buy_price" % fid, "f.team.%s.top_buy_pct_of_spend" % fid] if top else []),
                table_ids=[t_auction])
    pack.section("s4", "Contracts, Trades, Cuts and the Rookie Class", "Use each table's own "
                "words: the contracts table's Type column already says Restructure or Extension, "
                "and those are different operations -- never merge them into a phrase like "
                "'restructured into extension years'. Call a deal minimum-salary ONLY where the "
                "'At league minimum?' column says yes; if you name a group of players as "
                "minimum-salary signings, check every single name against that column first. Do "
                "not name a subset of a table's rows in a way that skips a row contradicting the "
                "point. In the cuts table, the 'Charged to' column is the cap year the penalty "
                "actually lands in -- deferred rows are NOT part of this season's cap. "
                "Cover the contracts table "
                "first -- extensions, restructures, tags, MYM and FA deals are as much a part of the "
                "offseason as trades or auction buys. Classify each trade as talent-driven, "
                "cap-driven, mixed or unclear from the actual assets on both sides -- never from "
                "guessing motive, and never claim a traded draft pick 'became' a specific player "
                "unless the table names one; where it does not, describe the pick by round and slot "
                "only, because it was moved again before the draft and this dataset cannot follow it "
                "further. For every cut, say whether it removed a starter, depth, or a "
                "non-contributor. For every rookie pick, compare the actual player to the historical "
                "baseline at that exact slot -- that baseline is a PRE-outcome expectation, not a "
                "grade on a rookie with zero games played.",
                fact_ids=["f.team.%s.contracts_count" % fid, "f.team.%s.trades_count" % fid,
                         "f.team.%s.cuts_count" % fid, "f.team.%s.cuts_penalty_%d" % (fid, SEASON),
                         "f.team.%s.cuts_penalty_%d_deferred" % (fid, SEASON + 1),
                         "f.team.%s.roster_removals_total" % fid, "f.team.%s.waiver_swaps" % fid,
                         "f.team.%s.inyear_flyers" % fid,
                         "f.team.%s.rookie_picks_count" % fid],
                table_ids=[t_contracts, t_trades, t_cuts, t_rookies])
    pack.section("s5", "The Verdict", "Close with a direct verdict: is this the strongest team in "
                "the league right now, and separately, was this a good offseason? They can disagree. "
                "Name the single biggest advantage and the single biggest weakness, each with players.",
                fact_ids=["f.team.%s.composite_rank" % fid, "f.team.%s.qb_rank" % fid,
                         "f.team.%s.rb_rank" % fid, "f.team.%s.wr_rank" % fid, "f.team.%s.te_rank" % fid])

    return pack

