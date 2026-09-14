#!/usr/bin/env python3
"""
sync_trade_outcomes_to_d1.py — mirror real 2-way src_trades outcomes into D1
(ups_trade_outcomes, migration 0152) so the Discord /therapy bot can draw a
real, checkable "here's what actually happened in that trade" story at
request time.

WHY THIS EXISTS (Keith 2026-09-14): Keith vented that Hammer (franchise
0005) "violated him" via a Trey McBride trade. The real src_trades record
(trade_group_id trade2023_75, 2023-08-20) shows the OPPOSITE of what he
remembered: Keith (0008) GAVE Trey McBride away to Hammer for Richie James +
Jayson Oweh + cap. Keith's own words once shown the real data: "yes that's
what makes therapy important... keep it real but find the positive." This
script is the ammo for that: real gave/got facts plus what those specific
players actually scored the very next season, and any PROVEN top-5
positional-rank superlative for that season — never a fabricated or
estimated one. Same reason ups_bad_beats mirrors bench_burns(): the
Cloudflare Worker cannot query src_trades/src_weekly directly at request
time — same reason ups_owner_career_stats, ups_roast_owner_ammo and
ups_bad_beats exist as D1 mirrors of Python-computed facts.

DESIGN NOTES:
  * v1 handles ONLY trade_group_ids with EXACTLY 2 distinct franchise_id
    values. A 3+-way (or degenerate 1-side) trade has no single "other
    side" to frame a gave/got pair against, so it is skipped and counted —
    see the skip summary this script prints.
  * next_season is always trade season + 1 — a strict "what did these
    players do the very next year" window, not "ever since". A trade whose
    real vindication/regret only showed up two seasons later (McBride's
    2025 #1-TE season is a good example — that is TWO years after
    trade2023_75, season+1 for that trade is 2024) will not surface that
    later fact here. That is a real, deliberate scope limit, not a bug.
    RETENTION (below) is the deliberate way a later-season fact like that
    still reaches the bot: it isn't bounded to next_season.
  * This table stores ONLY real, directly-computed numbers and PROVEN
    positional-rank superlatives (top-5 in next_season, computed by
    actually ranking every player at that position that season — never
    estimated). It never encodes a winner/grade/verdict. The Discord bot's
    prompt does the "keep it real but find the positive" framing at
    generation time; that wiring is a separate concern, not this script's
    job.
  * ACQUIRE/RELINQUISH direction is exactly the kind of thing that already
    got misremembered by hand once this session — see build_groups()'s
    docstring and the trade2023_75 self-check in --dry-run output.
  * NEXT-SEASON ATTRIBUTION IS GATED ON ACTUAL ROSTER MEMBERSHIP (fixed
    2026-09-14): proven bug -- trade2024_30 (2024-07-24) had Keith (0008)
    GIVE A.J. Brown and GET Christian McCaffrey from Hammer (0005). McCaffrey
    moved on to a THIRD franchise (0007) before 2025 started, yet the old
    got_next_season_pts/notable_json attributed his real 2025 #1-RB season
    (415.6 pts, on 0007's roster) to what Keith "got" -- Keith's actual 2024
    with McCaffrey was 48.4 pts across 4 games, badly injured. gave/got
    _next_season_pts and notable_json now GATE on a direct
    contract_history[player_id][next_season]['franchise_id'] == holding_fid
    check (holding_fid is other_franchise_id for a gave_players entry,
    franchise_id for a got_players entry -- same "whoever has them now" logic
    as retention_info(), but checked at next_season exactly, not via the
    years_retained consecutive-run proxy). A player who fails the check is
    excluded from the SUM entirely (not counted as 0), and never gets a
    next_season notable line. If NO player on a side passes the check, that
    side's pts field is NULL (not 0) so the bot can tell "no valid
    next-season data" apart from "scored zero". See cmc_trade_check() for the
    explicit self-check on this exact case.
  * TRADE-SEASON STATS (added 2026-09-14, same fix): gave_trade_season_pts /
    got_trade_season_pts / trade_season_notable_json (migration 0153) capture
    how each traded player performed in the TRADE'S OWN season, fresh on the
    new roster -- unconditionally valid (no gate needed; whoever the trade
    gave them to is who actually held them for those weeks). This is the
    only way McCaffrey's real, brutal, injury-marred 2024 with Keith is
    expressible at all -- the gated next-season fact for that side is NULL,
    but the trade-season fact is real and present.
  * RETENTION + CURRENT CONTRACT (Keith 2026-09-14, same conversation as the
    McBride correction above: "look at the player if they stay on the same
    team after a trade for long years that is worth highlighting... that's
    what makes the Trey McBride trade so bad"). Each player entry in
    gave_players_json/got_players_json is enriched with real retention facts
    from src_contracts (the analysis-grade contract mirror, same "src_*"
    trust tier as src_trades/src_weekly — verified against McBride's real
    row: 2022 rookie deal with 0004, moved to 0005 in 2023 alongside the
    trade, AAV jumped from $2,000 to $22,000 by 2025, still on 0005's
    roster in 2026):
      - years_retained: consecutive seasons, starting the trade's own
        season, that this player has been under contract to the holding
        franchise (the ACQUIRER for a got_players entry, the COUNTERPARTY
        for a gave_players entry — i.e. always "whoever has them now").
        Consecutive from the START, not total appearances -- a player who
        left and was re-acquired later does not count as one unbroken run.
      - still_there: true if the holding franchise still has them as of
        CURRENT_SEASON (the max season present in src_contracts -- derived,
        never hardcoded, so this does not silently go stale next year).
      - current_contract: only present when still_there -- a plain-language
        real contract summary (AAV, TCV, contract year/length, status) as
        of CURRENT_SEASON, straight from src_contracts columns, never
        reformatted from contract_info's free-text string (that string's
        exact wording is a display convenience elsewhere in the codebase
        and not a contract this script should re-parse).

RUN THIS BY HAND (no cron). Re-run any time src_trades/src_weekly inputs
change. Safe to re-run: UPSERT on (trade_group_id, franchise_id).

Usage:
  python3 sync_trade_outcomes_to_d1.py                    # 2018-2024
  python3 sync_trade_outcomes_to_d1.py --seasons 2023      # one season
  python3 sync_trade_outcomes_to_d1.py --seasons 2023-2024
  python3 sync_trade_outcomes_to_d1.py --seasons 2023 --dry-run
"""

import argparse
import json
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
WIRE_DIR = SCRIPT_DIR.parent / "wire"
WORKER_DIR = SCRIPT_DIR.resolve().parents[2] / "worker"

sys.path.insert(0, str(WIRE_DIR))
import wire_data as D  # noqa: E402

COLS = [
    "trade_group_id", "season", "datetime_et",
    "franchise_id", "other_franchise_id",
    "gave_players_json", "got_players_json",
    "gave_extra", "got_extra",
    "next_season", "gave_next_season_pts", "got_next_season_pts",
    "notable_json",
    "gave_trade_season_pts", "got_trade_season_pts", "trade_season_notable_json",
    "synced_at_utc",
]

# Non-PLAYER asset types get folded into a plain-text "plus ..." note rather
# than resolved to a value — task explicitly says don't try to price picks.
_EXTRA_LABELS = {
    "DRAFTPICK_CURRENT": "draft pick",
    "DRAFTPICK_FUTURE": "draft pick",
    "CAP": "cap",
}


def _sql_quote(v):
    if v is None:
        return "NULL"
    if isinstance(v, bool):
        return "1" if v else "0"
    if isinstance(v, (int, float)):
        return str(v)
    s = str(v).replace("'", "''")
    return f"'{s}'"


def parse_season_range(spec):
    if "-" in spec:
        lo, hi = spec.split("-", 1)
        return range(int(lo), int(hi) + 1)
    return [int(spec)]


# ------------------------------------------------------------- grouping

def fetch_trades(season):
    """All src_trades rows for one season, one row per (franchise, asset)."""
    return D.d1(
        "SELECT trade_group_id, franchise_id, franchise_name, asset_role, "
        "asset_type, player_id, player_name, comments, datetime_et "
        "FROM src_trades WHERE season = %d AND trade_group_id IS NOT NULL "
        "ORDER BY trade_group_id, franchise_id" % int(season)
    )


def build_groups(rows):
    """trade_group_id -> list of its rows, kept only for exactly-2-franchise
    groups.

    Returns (kept, skipped_not_2way) where skipped_not_2way is a dict
    trade_group_id -> distinct franchise count, for reporting.

    DIRECTION IS THE WHOLE POINT OF THIS TABLE: asset_role is ACQUIRE (this
    franchise received it) or RELINQUISH (this franchise gave it up) — never
    infer direction from row order or from who appears first. A franchise's
    "gave" pile is its RELINQUISH+PLAYER rows; "got" is its ACQUIRE+PLAYER
    rows. Nothing else.
    """
    groups = defaultdict(list)
    for r in rows:
        groups[r["trade_group_id"]].append(r)

    kept = {}
    skipped_not_2way = {}
    for gid, grp in groups.items():
        fids = sorted({r["franchise_id"] for r in grp})
        if len(fids) == 2:
            kept[gid] = (grp, fids)
        else:
            skipped_not_2way[gid] = len(fids)
    return kept, skipped_not_2way


def describe_extra(rows):
    """Plain-text note for non-PLAYER assets on one side of one trade, or
    None if there were none. Counts/types only, never a resolved value —
    e.g. 'plus a draft pick and cap', 'plus 2 draft picks'."""
    if not rows:
        return None
    counts = Counter(_EXTRA_LABELS.get(r["asset_type"], r["asset_type"]) for r in rows)
    parts = []
    for label, n in counts.items():
        if label == "cap":
            parts.append("cap")
        elif n == 1:
            parts.append("a %s" % label)
        else:
            parts.append("%d %ss" % (n, label))
    return "plus " + " and ".join(parts)


def _fmt_k(cents_or_dollars):
    """src_contracts' salary/aav/tcv are already whole dollars (see McBride's
    real row: aav=22000 == "$22K" in the league's own contract_info string).
    Formats as e.g. "$22K"; never introduces a cents/dollars mismatch by
    guessing -- if the value is missing, returns None and the caller omits
    the fact rather than printing "$None"."""
    if cents_or_dollars is None:
        return None
    return "$%dK" % round(cents_or_dollars / 1000)


def retention_info(player_id, holding_fid, start_season, current_season, contract_history):
    """Real retention facts for one player relative to whoever holds them now.

    contract_history: player_id -> {season: {franchise_id, aav, tcv,
    contract_year, contract_length, contract_status}}, pre-fetched once for
    every player this run touches (see contract_history_for()).

    years_retained counts the CONSECUTIVE run starting at start_season where
    franchise_id == holding_fid -- stops at the first gap or franchise
    change, never total appearances. still_there is a separate, simple
    check against current_season alone (a player could have left and come
    back; that is a real gap, not something to paper over)."""
    by_season = contract_history.get(player_id) or {}
    run = 0
    for s in range(start_season, current_season + 1):
        row = by_season.get(s)
        if not row or row.get("franchise_id") != holding_fid:
            break
        run += 1
    current_row = by_season.get(current_season)
    still_there = bool(current_row and current_row.get("franchise_id") == holding_fid)
    out = {"years_retained": run, "still_there": still_there}
    if still_there:
        aav = _fmt_k(current_row.get("aav"))
        tcv = _fmt_k(current_row.get("tcv"))
        cy, cl = current_row.get("contract_year"), current_row.get("contract_length")
        status = current_row.get("contract_status")
        parts = []
        if aav:
            parts.append("%s AAV" % aav)
        if tcv:
            parts.append("%s TCV" % tcv)
        if cy and cl:
            parts.append("year %d of %d" % (cy, cl))
        if status:
            parts.append(status)
        out["current_contract"] = ", ".join(parts) if parts else None
    return out


def held_by_in_season(player_id, holding_fid, target_season, contract_history):
    """Direct, season-exact roster-membership check: was this player under
    contract to holding_fid in target_season SPECIFICALLY (not "for N
    consecutive seasons starting somewhere" -- that's years_retained, a
    different question). Looks up
    contract_history[player_id][target_season]['franchise_id'] directly,
    since contract_history already carries season-level granularity -- no
    reason to go through a consecutive-run proxy for a single-season
    question. Used to gate next_season pts/notable attribution onto whoever
    actually held the player that season (see trade2024_30/McCaffrey in the
    module docstring for the proven case this fixes)."""
    row = (contract_history.get(player_id) or {}).get(target_season)
    return bool(row and row.get("franchise_id") == holding_fid)


def player_entries(rows, positions, holding_fid, start_season, current_season, contract_history):
    out = []
    for r in rows:
        entry = {
            "player_id": r["player_id"],
            "player_name": r["player_name"],
            "pos": positions.get(r["player_id"]),
        }
        entry.update(retention_info(r["player_id"], holding_fid, start_season, current_season, contract_history))
        out.append(entry)
    return out


# --------------------------------------------------------------- lookups

def positions_for(season, player_ids):
    """player_id -> position, from src_players in the TRADE's own season
    (the roster spot each side actually knew about at the time)."""
    ids = {pid for pid in player_ids if pid}
    if not ids:
        return {}
    id_list = ",".join(_sql_quote(pid) for pid in sorted(ids))
    rows = D.d1(
        "SELECT player_id, position FROM src_players "
        "WHERE season = %d AND player_id IN (%s)" % (int(season), id_list)
    )
    return {r["player_id"]: r["position"] for r in rows}


def season_totals(season, player_ids):
    """player_id -> SUM(src_weekly.score) in the given season, across all
    weeks, whatever roster they were on. Missing from the map == no rows ==
    0.0. Generic over `season` -- reused for both next_season (gated) and
    trade-season (unconditional) totals, no reason to duplicate this query."""
    ids = {pid for pid in player_ids if pid}
    if not ids:
        return {}
    id_list = ",".join(_sql_quote(pid) for pid in sorted(ids))
    rows = D.d1(
        "SELECT player_id, ROUND(SUM(score), 1) AS total FROM src_weekly "
        "WHERE season = %d AND player_id IN (%s) GROUP BY player_id"
        % (int(season), id_list)
    )
    return {r["player_id"]: float(r["total"] or 0.0) for r in rows}


def current_season_from_contracts():
    """MAX(season) present in src_contracts -- derived, never hardcoded, so
    retention/"still there" checks don't silently go stale a year from now."""
    rows = D.d1("SELECT MAX(season) AS s FROM src_contracts")
    s = rows[0]["s"] if rows else None
    if not s:
        raise RuntimeError("src_contracts is empty -- cannot derive current_season")
    return int(s)


def contract_history_for(player_ids, current_season):
    """player_id -> {season: {franchise_id, aav, tcv, contract_year,
    contract_length, contract_status}} for every season on record, capped at
    current_season (a later/stale snapshot should never exist, but this is
    the same defensive posture as everywhere else in this script)."""
    ids = {pid for pid in player_ids if pid}
    if not ids:
        return {}
    id_list = ",".join(_sql_quote(pid) for pid in sorted(ids))
    rows = D.d1(
        "SELECT player_id, season, franchise_id, aav, tcv, contract_year, "
        "contract_length, contract_status FROM src_contracts "
        "WHERE player_id IN (%s) AND season <= %d" % (id_list, current_season)
    )
    out = defaultdict(dict)
    for r in rows:
        out[r["player_id"]][int(r["season"])] = {
            "franchise_id": r["franchise_id"],
            "aav": r["aav"], "tcv": r["tcv"],
            "contract_year": r["contract_year"], "contract_length": r["contract_length"],
            "contract_status": r["contract_status"],
        }
    return dict(out)


def position_ranks(next_season):
    """(position, player_id) -> rank (1 = highest scoring) among every
    player who logged a src_weekly score at that position in next_season.
    Computed once per next_season and reused across every trade in the
    season loop — this IS the "actually ranked" proof, not an estimate."""
    rows = D.d1(
        "SELECT w.player_id AS player_id, p.position AS position, "
        "ROUND(SUM(w.score), 1) AS total "
        "FROM src_weekly w JOIN src_players p "
        "ON p.player_id = w.player_id AND p.season = w.season "
        "WHERE w.season = %d AND p.position IS NOT NULL "
        "GROUP BY w.player_id, p.position" % int(next_season)
    )
    by_pos = defaultdict(list)
    for r in rows:
        by_pos[r["position"]].append((r["player_id"], float(r["total"] or 0.0)))
    ranks = {}
    for pos, lst in by_pos.items():
        lst.sort(key=lambda x: -x[1])
        for i, (pid, _total) in enumerate(lst, start=1):
            ranks[(pos, pid)] = i
    return ranks


def notable_for(players, ranks, next_season, top_n=5):
    """PROVEN top-N positional-rank superlatives only. players is a list of
    {player_id, player_name, pos} dicts (gave or got side)."""
    out = []
    for p in players:
        pos = p.get("pos")
        rank = ranks.get((pos, p["player_id"])) if pos else None
        if rank is not None and rank <= top_n:
            out.append(
                "%s finished as the #%d scoring %s in %d"
                % (D.display_name(p["player_name"]), rank, pos, next_season)
            )
    return out


# ------------------------------------------------------------- row build

def build_rows_for_season(season, current_season):
    """Returns (rows, stats) for one trade season. stats is a dict of
    counters for the summary print / final report."""
    next_season = season + 1
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    raw = fetch_trades(season)
    kept, skipped_not_2way = build_groups(raw)

    stats = {
        "groups_total": len({r["trade_group_id"] for r in raw}),
        "groups_2way": len(kept),
        "groups_skipped_not_2way": len(skipped_not_2way),
        "skipped_not_2way_detail": skipped_not_2way,
        "sides_skipped_pick_only": 0,
    }

    # Batch position lookups (trade-season) and outcome lookups
    # (next_season) once per season instead of once per trade — this is the
    # same "cache the dataset once" shape as bad_beats, just batched instead
    # of per-week, since D1 access shells out to wrangler and is slow.
    all_player_ids = {
        r["player_id"] for grp, _fids in kept.values() for r in grp
        if r["asset_type"] == "PLAYER" and r["player_id"]
    }
    positions = positions_for(season, all_player_ids)
    totals = season_totals(next_season, all_player_ids)
    ranks = position_ranks(next_season)
    trade_season_pts_map = season_totals(season, all_player_ids)
    trade_season_ranks = position_ranks(season)
    contract_history = contract_history_for(all_player_ids, current_season)

    rows = []
    for gid, (grp, fids) in kept.items():
        dt = grp[0].get("datetime_et")
        for fid in fids:
            other_fid = fids[0] if fid == fids[1] else fids[1]
            side = [r for r in grp if r["franchise_id"] == fid]

            gave_player_rows = [r for r in side if r["asset_role"] == "RELINQUISH" and r["asset_type"] == "PLAYER"]
            got_player_rows = [r for r in side if r["asset_role"] == "ACQUIRE" and r["asset_type"] == "PLAYER"]
            gave_extra_rows = [r for r in side if r["asset_role"] == "RELINQUISH" and r["asset_type"] != "PLAYER"]
            got_extra_rows = [r for r in side if r["asset_role"] == "ACQUIRE" and r["asset_type"] != "PLAYER"]

            if not gave_player_rows and not got_player_rows:
                # Pick-only side of the trade for this franchise -- nothing
                # a "gave X, got Y" player story can be built from. Skip
                # just this franchise's row; the other side may still be
                # valid (rare in a 2-way trade but not impossible).
                stats["sides_skipped_pick_only"] += 1
                continue

            # Retention is relative to whoever holds the player NOW: the
            # COUNTERPARTY for a player this franchise gave away, THIS
            # franchise for a player it acquired. Tracked from the trade's
            # own season (season), not next_season -- a player who is
            # already re-signed/extended in the trade season itself still
            # counts as retained starting there.
            gave_players = player_entries(gave_player_rows, positions, other_fid, season, current_season, contract_history)
            got_players = player_entries(got_player_rows, positions, fid, season, current_season, contract_history)

            # GATE next-season attribution on actual roster membership at
            # next_season SPECIFICALLY (held_by_in_season, a direct
            # contract_history[player_id][next_season] lookup -- NOT the
            # years_retained consecutive-run proxy). A player who was moved
            # on before next_season contributes nothing to the pts SUM and
            # gets no next_season notable line -- see module docstring for
            # the proven trade2024_30/McCaffrey case this fixes.
            gave_gated = [p for p in gave_players if held_by_in_season(p["player_id"], other_fid, next_season, contract_history)]
            got_gated = [p for p in got_players if held_by_in_season(p["player_id"], fid, next_season, contract_history)]
            gave_pts = round(sum(totals.get(p["player_id"], 0.0) for p in gave_gated), 1) if gave_gated else None
            got_pts = round(sum(totals.get(p["player_id"], 0.0) for p in got_gated), 1) if got_gated else None

            notable = notable_for(gave_gated, ranks, next_season) + notable_for(got_gated, ranks, next_season)

            # TRADE-SEASON stats are unconditional -- the trade's own season
            # is, by definition, when the acquiring side actually held the
            # player, so no gate is needed (or possible: gave_players lists
            # the RELINQUISHING side's own former players, who are never
            # "held" by other_fid before the trade completes). Reuses the
            # exact same season_totals()/position_ranks()/notable_for() as
            # next_season, just called with `season` instead.
            gave_trade_pts = round(sum(trade_season_pts_map.get(p["player_id"], 0.0) for p in gave_players), 1) if gave_players else None
            got_trade_pts = round(sum(trade_season_pts_map.get(p["player_id"], 0.0) for p in got_players), 1) if got_players else None
            trade_season_notable = (
                notable_for(gave_players, trade_season_ranks, season)
                + notable_for(got_players, trade_season_ranks, season)
            )

            rows.append({
                "trade_group_id": gid,
                "season": season,
                "datetime_et": dt,
                "franchise_id": fid,
                "other_franchise_id": other_fid,
                "gave_players_json": json.dumps(gave_players),
                "got_players_json": json.dumps(got_players),
                "gave_extra": describe_extra(gave_extra_rows),
                "got_extra": describe_extra(got_extra_rows),
                "next_season": next_season,
                "gave_next_season_pts": gave_pts,
                "got_next_season_pts": got_pts,
                "notable_json": json.dumps(notable),
                "gave_trade_season_pts": gave_trade_pts,
                "got_trade_season_pts": got_trade_pts,
                "trade_season_notable_json": json.dumps(trade_season_notable),
                "synced_at_utc": now,
            })

    return rows, stats


def build_rows(seasons):
    current_season = current_season_from_contracts()
    print("current_season (from src_contracts) = %d\n" % current_season)
    all_rows = []
    for season in seasons:
        rows, stats = build_rows_for_season(season, current_season)
        all_rows.extend(rows)
        print(
            "  %d -> next_season %d: %d trade group(s), %d kept (2-way), "
            "%d skipped (not 2-way), %d row(s) built, %d side(s) skipped (pick-only)"
            % (season, season + 1, stats["groups_total"], stats["groups_2way"],
               stats["groups_skipped_not_2way"], len(rows), stats["sides_skipped_pick_only"])
        )
        if stats["skipped_not_2way_detail"]:
            for gid, n in sorted(stats["skipped_not_2way_detail"].items()):
                print("      skipped %s: %d distinct franchise(s) (not a 2-way trade)" % (gid, n))
    return all_rows


def build_sql(rows):
    update_clause = ", ".join(f"{c} = excluded.{c}" for c in COLS if c not in ("trade_group_id", "franchise_id"))
    parts = []
    for r in rows:
        values = ", ".join(_sql_quote(r.get(c)) for c in COLS)
        parts.append(
            f"INSERT INTO ups_trade_outcomes ({', '.join(COLS)}) VALUES ({values}) "
            f"ON CONFLICT(trade_group_id, franchise_id) DO UPDATE SET {update_clause};"
        )
    return "\n".join(parts) + "\n"


def d1_execute_file(sql_text):
    import subprocess
    import tempfile
    with tempfile.NamedTemporaryFile(mode="w", suffix=".sql", delete=False) as f:
        f.write(sql_text)
        sql_path = f.name
    result = subprocess.run(
        ["npx", "wrangler", "d1", "execute", "ups-mfl-db", "--remote", "--file", sql_path],
        capture_output=True, text=True, cwd=str(WORKER_DIR),
    )
    if result.returncode != 0:
        sys.stderr.write(f"D1 execute failed:\n{result.stderr}\n")
        sys.exit(1)
    print(result.stdout[-2000:])


def _retention_note(p):
    if p.get("still_there"):
        yrs = p.get("years_retained") or 0
        note = "still there, %d yr%s" % (yrs, "" if yrs == 1 else "s")
        if p.get("current_contract"):
            note += " (%s)" % p["current_contract"]
        return note
    return None


def print_plain_english_sample(rows, owners_by_season, n=10):
    print("\n--- plain-English sample (%d of %d row(s)) ---" % (min(n, len(rows)), len(rows)))
    for r in rows[:n]:
        gave = json.loads(r["gave_players_json"])
        got = json.loads(r["got_players_json"])
        gave_names = ", ".join(D.display_name(p["player_name"]) + (" (%s)" % p["pos"] if p["pos"] else "") for p in gave) or "(nothing)"
        got_names = ", ".join(D.display_name(p["player_name"]) + (" (%s)" % p["pos"] if p["pos"] else "") for p in got) or "(nothing)"
        owners = owners_by_season.get(r["season"], {})
        who = owners.get(r["franchise_id"], {}).get("owner_name", r["franchise_id"])
        vs = owners.get(r["other_franchise_id"], {}).get("owner_name", r["other_franchise_id"])
        print("\n[%s] %s (%s) vs %s (%s) -- %s" % (r["trade_group_id"], who, r["franchise_id"], vs, r["other_franchise_id"], r["datetime_et"]))
        print("  GAVE: %s%s" % (gave_names, "  " + r["gave_extra"] if r["gave_extra"] else ""))
        print("   GOT: %s%s" % (got_names, "  " + r["got_extra"] if r["got_extra"] else ""))
        gave_next_str = "no data" if r["gave_next_season_pts"] is None else "%d pts" % round(r["gave_next_season_pts"])
        got_next_str = "no data" if r["got_next_season_pts"] is None else "%d pts" % round(r["got_next_season_pts"])
        print("  NEXT SEASON (%d, gated to actual roster membership): gave side %s, got side %s" % (
            r["next_season"], gave_next_str, got_next_str))
        notable = json.loads(r["notable_json"])
        if notable:
            for nline in notable:
                print("  NOTABLE (next season): %s" % nline)
        gave_trade_str = "no data" if r["gave_trade_season_pts"] is None else "%d pts" % round(r["gave_trade_season_pts"])
        got_trade_str = "no data" if r["got_trade_season_pts"] is None else "%d pts" % round(r["got_trade_season_pts"])
        print("  TRADE SEASON (%d, fresh on the new roster, unconditional): gave side %s, got side %s" % (
            r["season"], gave_trade_str, got_trade_str))
        trade_notable = json.loads(r["trade_season_notable_json"])
        if trade_notable:
            for nline in trade_notable:
                print("  NOTABLE (trade season): %s" % nline)
        for p in gave + got:
            note = _retention_note(p)
            if note:
                print("  RETENTION: %s -- %s" % (D.display_name(p["player_name"]), note))


def trade2023_75_check(rows):
    """Explicit self-check for the already-known-correct case: Keith (0008)
    GAVE Trey McBride to Hammer (0005), 2023-08-20, for Richie James +
    Jayson Oweh + cap. Prints PASS/FAIL and the actual row values."""
    print("\n--- trade2023_75 direction self-check ---")
    r8 = next((r for r in rows if r["trade_group_id"] == "trade2023_75" and r["franchise_id"] == "0008"), None)
    r5 = next((r for r in rows if r["trade_group_id"] == "trade2023_75" and r["franchise_id"] == "0005"), None)
    if not r8 or not r5:
        print("  FAIL: trade2023_75 not found for both franchises in this row set "
              "(did you run with --seasons 2023?)")
        return False
    gave8 = [p["player_name"] for p in json.loads(r8["gave_players_json"])]
    got8 = [p["player_name"] for p in json.loads(r8["got_players_json"])]
    gave5 = [p["player_name"] for p in json.loads(r5["gave_players_json"])]
    got5 = [p["player_name"] for p in json.loads(r5["got_players_json"])]
    ok = (
        "McBride, Trey" in gave8 and "McBride, Trey" not in got8
        and "McBride, Trey" in got5 and "McBride, Trey" not in gave5
        and "James, Richie" in got8 and "Oweh, Jayson" in got8
    )
    print("  0008 gave: %s" % gave8)
    print("  0008 got:  %s" % got8)
    print("  0005 gave: %s" % gave5)
    print("  0005 got:  %s" % got5)
    print("  0008 gave_next_season_pts (%d): %s" % (r8["next_season"], r8["gave_next_season_pts"]))
    print("  0008 got_next_season_pts (%d):  %s" % (r8["next_season"], r8["got_next_season_pts"]))
    print("  0008 notable: %s" % json.loads(r8["notable_json"]))
    print("  0005 notable: %s" % json.loads(r5["notable_json"]))

    mcbride5 = next((p for p in json.loads(r5["got_players_json"]) if p["player_name"] == "McBride, Trey"), None)
    print("  0005 McBride retention: %s" % mcbride5)
    ok_retention = bool(mcbride5 and mcbride5.get("still_there") and (mcbride5.get("years_retained") or 0) >= 3)

    print("  RESULT: %s" % ("PASS -- 0008 gave McBride, got James+Oweh, matches known-correct direction"
                             if ok else "FAIL -- direction does not match the known-correct case"))
    print("  RETENTION RESULT: %s" % ("PASS -- McBride still on 0005 (Hammer), retained 3+ consecutive seasons"
                                       if ok_retention else "FAIL -- retention data does not match expected McBride history"))
    return ok and ok_retention


def cmc_trade_check(rows):
    """Explicit self-check for the proven next-season-attribution bug this
    fix addresses: trade2024_30 (2024-07-24), Keith (0008) GAVE A.J. Brown
    and GOT Christian McCaffrey from Hammer (0005). McCaffrey was traded off
    0008's roster (to a THIRD franchise, 0007) before 2025 started -- so
    got_next_season_pts for 0008 must be NULL (no valid next-season data,
    not a real 0) and no notable_json line may attribute his real 2025 #1-RB
    season to 0008. His real, immediate 2024 performance on 0008 -- 48.4 pts
    across 4 games, badly injured -- must show up instead as
    got_trade_season_pts. Prints PASS/FAIL and the actual row values."""
    print("\n--- cmc_trade_check (trade2024_30 next-season gate) self-check ---")
    r8 = next((r for r in rows if r["trade_group_id"] == "trade2024_30" and r["franchise_id"] == "0008"), None)
    if not r8:
        print("  FAIL: trade2024_30/0008 not found in this row set (did you run with --seasons 2024?)")
        return False

    got = json.loads(r8["got_players_json"])
    got_names = [p["player_name"] for p in got]
    notable = json.loads(r8["notable_json"])
    trade_notable = json.loads(r8["trade_season_notable_json"])

    print("  0008 got: %s" % got_names)
    print("  0008 got_next_season_pts (%s): %s" % (r8["next_season"], r8["got_next_season_pts"]))
    print("  0008 got_trade_season_pts (%s): %s" % (r8["season"], r8["got_trade_season_pts"]))
    print("  0008 notable (next season): %s" % notable)
    print("  0008 notable (trade season): %s" % trade_notable)

    mccaffrey_present = "McCaffrey, Christian" in got_names
    gate_ok = r8["got_next_season_pts"] is None
    no_mis_notable = not any("McCaffrey" in n and str(r8["next_season"]) in n for n in notable)
    trade_pts_ok = r8["got_trade_season_pts"] is not None and abs((r8["got_trade_season_pts"] or 0) - 48.4) < 1.0

    ok = mccaffrey_present and gate_ok and no_mis_notable and trade_pts_ok
    print("  RESULT: %s" % (
        "PASS -- got_trade_season_pts ~= 48.4 (real injured 2024), got_next_season_pts is NULL "
        "(McCaffrey was not on 0008 in 2025), no 2025 McCaffrey notable attributed to 0008"
        if ok else "FAIL -- next-season gate or trade-season pts do not match the known-correct McCaffrey case"
    ))
    if not mccaffrey_present:
        print("    (McCaffrey not found in 0008's got_players_json)")
    if not gate_ok:
        print("    (got_next_season_pts should be NULL, was %s)" % r8["got_next_season_pts"])
    if not no_mis_notable:
        print("    (a next-season notable line still attributes McCaffrey's %s season to 0008)" % r8["next_season"])
    if not trade_pts_ok:
        print("    (got_trade_season_pts should be ~48.4, was %s)" % r8["got_trade_season_pts"])
    return ok


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--seasons", default="2018-2024", help="e.g. 2023 or 2018-2024")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    seasons = list(parse_season_range(args.seasons))
    print(f"Computing trade outcomes for seasons {seasons[0]}-{seasons[-1]} "
          f"(next_season = season+1)...")
    rows = build_rows(seasons)
    print(f"\n{len(rows)} trade-outcome row(s) built across {len(seasons)} season(s).")
    if not rows:
        return 0

    if args.dry_run:
        sql_text = build_sql(rows)
        print("\n--- generated SQL (first 4000 chars) ---")
        print(sql_text[:4000])

        owners_by_season = {s: D.owner_map(s) for s in seasons}
        print_plain_english_sample(rows, owners_by_season, n=10)

        if 2023 in seasons:
            trade2023_75_check(rows)
        if 2024 in seasons:
            cmc_trade_check(rows)

        print(f"\nDRY RUN — would UPSERT {len(rows)} row(s), not writing")
        return 0

    sql_text = build_sql(rows)
    d1_execute_file(sql_text)
    print(f"D1 sync: {len(rows)} row(s) UPSERTed into ups_trade_outcomes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
