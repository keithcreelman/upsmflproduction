"""Points-above-replacement value for IDP (DL/LB/DB).

WHY THIS EXISTS
    ADP does not price defensive players. The first cut of the team-review pack
    scraped FantasyPros' public IDP cheat sheet, which gave an ordinal rank and
    nothing else -- you could say "DL14" but never "worth X". Keith ruled out the
    other obvious source directly: "no i dont want to use auction prices to
    determine value...i neeed to understand idp value". Auction price is what the
    league PAID, which is circular when the question is what a player is WORTH.

    So value here is built from realized production under UPS's own scoring, and
    nothing else.

THE SCORING IS REAL, AND VERIFIED
    src_weekly.score is MFL's official league score, not a reconstruction. It was
    checked against MFL's own export?TYPE=playerScores on 5,321 player-weeks
    across 2023/2024/2025 with ZERO mismatches, and five player-weeks were
    hand-recomputed from MFL's per-stat `detailed?` breakdown, all exact. UPS
    scores tackles on a per-position tier (DL 1.5 / DB 1.3 / LB 1.0 per solo,
    with matching assist and TFL tiers), identical in 2024, 2025 and live 2026 --
    which is why DBs out-score DL at most ranks and why owners flex a DB ~55% of
    the time. Consume the score; never recompute it from nflverse, which disagrees
    with MFL's tackle feed on ~8% of rows.

THE MODEL
    par = max(0, SHRINK * (curve[pos][rank] - curve[pos][REPLACEMENT_RANK[pos]]))

    curve       points-by-positional-rank, averaged over the available seasons.
                Multi-season averaging belongs HERE: a given rank's point value is
                stable year to year, so averaging removes noise.
    rank        the player's rank in the MOST RECENT completed season only.
                Measured: adding earlier seasons to the player's own input makes
                out-of-sample prediction WORSE (RMSE 37.58 vs 37.13), because a
                defender's own history is weak signal -- see SHRINK.
    SHRINK      0.40, chosen by out-of-sample holdout, NOT by argument. Three
                independent design passes proposed 0.25, 0.55 and 0.73; sweeping
                the constant against realized next-season PAR gives a nearly FLAT
                objective (RMSE 37.13 at 0.40, 37.14 at 0.25, 37.97 at 0.73). The
                honest reading is that the data cannot strongly distinguish them,
                so this takes the pooled argmin and treats the precision as
                illusory. Do not quote this constant as if it were tuned.

WHAT THIS SUPPORTS, AND WHAT IT DOES NOT
    Supported:     "a top-12 DL", "startable", "replacement-level", and the size
                   of the gap between a team's defense and the waiver wire.
    NOT supported: fine ordering inside the elite tier. Year-over-year rank
                   correlation within the top 24 is ~0.32 for DL, ~0.30 for DB and
                   effectively ZERO for LB (0.004), and a within-season split-half
                   (which removes injury and role change) agrees. "The 4th-best
                   LB" is a coin flip wearing a decimal point. Emit tiers, not
                   ordinal claims.

    THE POSITION IS FLAT IN THE TAIL, STEEP AT THE TOP. An earlier version of
    this note said "flat" without qualification and claimed an elite defender is
    worth about a point a week over a waiver body. Both were wrong, and Keith
    caught it. Real 2025 DL, against a DL26 replacement of 88.5:

        DL1  Garrett      195.5   +107.0   (8.23/gm)
        DL2  Crosby       161.0    +72.5   (5.58/gm)
        DL12 Hutchinson   107.5    +19.0   (1.46/gm)
        DL24 Hunt          91.5     +3.0   (0.23/gm)

    The ~1 pt/week figure describes ranks 12-26, not the top. DL1 to DL2 alone is
    34.5 points -- a bigger step than DL12 to DL26 spans across fourteen ranks.
    An elite defender IS worth a lot; the replaceable middle is what is flat, and
    that is what the waiver-wire acquisition finding (52% of top-24 IDP came off
    the wire, versus 6% on offense) is really about.

    REGRESSION IS THE REAL EFFECT, AND IT BITES HARDEST AT THE TOP. That is why a
    realized +107 projects to roughly +35. Holdout error by prior tier, sweeping
    the shrink from 0.20 to 1.00:

        prior top-6   best 0.20   RMSE 42.8 -> 58.2 as shrink rises
        prior 7-12    best 0.40   RMSE 23.9 -> 27.6
        prior 13-26   best 0.20   RMSE 37.4 -> 42.0

    Last season's elite defenders are the group that repeats LEAST, and
    projecting them at full value is the single worst option available. Part of
    that is mechanical -- finishing top-6 selects for a peak season -- but that is
    exactly the effect a forward-looking number should carry. So `par` is a
    PROJECTION and is the primary value; `realized` is carried alongside it so an
    article can say what a player actually did without implying he will do it
    again.
"""

import json
import os

# Revealed weekly starter demand, the same rationale the vetted offense script
# uses (build_apw_seasonal.py's REPL_RANK = QB24/RB30/WR40/TE13). UPS starts
# 2 DL + 2 LB + 2 DB + 1 DFlex per team x 12 teams = 24 fixed per group plus 12
# DFlex; the DFlex split comes from ACTUAL submitted lineups (src_weekly
# status='starter', zero ambiguous shapes): DL ~20%, LB ~29%, DB ~51-55%.
# Measured, not assumed -- and DB carrying the highest demand is a consequence of
# the tiered scoring above, not an anomaly.
REPLACEMENT_RANK = {"DL": 26, "LB": 27, "DB": 30}

SHRINK = 0.40

IDP_GROUPS = ("DL", "LB", "DB")

# src_weekly RENAMED its IDP pos_group labels at the 2023->2024 boundary. Any
# query that does not alias these silently loses every season before 2024 --
# which is exactly the bug that made an earlier pass conclude "2023 has no DL or
# DB data" and treat a two-season window as a one-transition limitation.
_POS_ALIAS = {"DT+DE": "DL", "CB+S": "DB", "DL": "DL", "DB": "DB", "LB": "LB"}

_SEASON_SQL = """
SELECT season,
       CASE pos_group WHEN 'DT+DE' THEN 'DL' WHEN 'CB+S' THEN 'DB' ELSE pos_group END AS pos,
       player_id,
       ROUND(SUM(score), 2) AS tot,
       COUNT(*) AS gp
  FROM src_weekly
 WHERE season BETWEEN %d AND %d
   AND is_reg = 1
   AND score IS NOT NULL
   AND pos_group IN ('DL','DB','LB','DT+DE','CB+S')
 GROUP BY season, pos, player_id
"""

DEFAULT_CACHE = os.path.expanduser("~/.ups_jobs/wire_cache/idp_seasons_reg.json")


def load_seasons(d1, first=2023, last=2025, cache_path=DEFAULT_CACHE):
    """Player-season IDP totals, regular season only.

    is_reg=1 is not a detail. Weeks 15-17 carry ONLY rostered players (~45 per
    position-season versus ~400), so including them adds points exclusively to
    players good enough to be rostered and inflates the top of the curve -- the
    contaminated basis reads DL1 at 196 where the clean one reads 177.5.

    This is one large aggregate (~450k rows read). It is cached to disk and the
    cache is preferred on failure, because this exact query shape was a material
    contributor to blowing D1's daily read cap on 2026-09-07.
    """
    try:
        rows = d1(_SEASON_SQL % (first, last))
        if rows:
            try:
                os.makedirs(os.path.dirname(cache_path), exist_ok=True)
                with open(cache_path, "w") as fh:
                    json.dump(rows, fh)
            except OSError:
                pass
            return rows
    except Exception:
        pass
    with open(cache_path) as fh:
        return json.load(fh)


def _norm(rows):
    out = []
    for r in rows:
        pos = _POS_ALIAS.get(str(r.get("pos") or r.get("pos_group") or ""))
        if pos:
            out.append({"season": int(r["season"]), "pos": pos,
                        "pid": str(r["player_id"]), "tot": float(r["tot"]),
                        "gp": int(r["gp"])})
    return out


def seasons_present(rows):
    """{pos: [seasons]} -- so a caller can disclose what the curve rests on
    rather than implying three seasons everywhere."""
    seen = {}
    for r in _norm(rows):
        seen.setdefault(r["pos"], set()).add(r["season"])
    return {p: sorted(s) for p, s in seen.items()}


def build_curve(rows):
    """{pos: {rank: mean season points at that rank}} across available seasons."""
    per = {}
    for r in _norm(rows):
        per.setdefault((r["season"], r["pos"]), []).append(r["tot"])
    stacked = {}
    for (season, pos), tots in per.items():
        for i, v in enumerate(sorted(tots, reverse=True), 1):
            stacked.setdefault(pos, {}).setdefault(i, []).append(v)
    return {pos: {rank: sum(v) / len(v) for rank, v in ranks.items()}
            for pos, ranks in stacked.items()}


def curve_at(curve, pos, rank):
    c = curve.get(pos) or {}
    if not c:
        return 0.0
    ranks = sorted(c)
    if rank <= ranks[0]:
        return c[ranks[0]]
    if rank >= ranks[-1]:
        return c[ranks[-1]]
    if rank in c:
        return c[rank]
    lo = max(k for k in ranks if k < rank)
    hi = min(k for k in ranks if k > rank)
    return c[lo] + (rank - lo) / (hi - lo) * (c[hi] - c[lo])


def par_by_pid(rows, prior_season):
    """{pid: {par, par_unfloored, pos, rank, gp, tier}} for every defender with
    production in `prior_season`.

    A player absent from that season gets NO entry -- callers must treat a miss
    as UNKNOWN and exclude him from value sums, never as zero. Rookies with no
    NFL snaps and a retired veteran on a $1K roster stash are both "no data", and
    scoring either as 0 would assert something the record does not support. This
    mirrors how the pipeline already treats an offense player missing from the
    ADP board.
    """
    curve = build_curve(rows)
    norm = _norm(rows)
    out = {}
    for pos in IDP_GROUPS:
        season_rows = sorted((r for r in norm if r["pos"] == pos and r["season"] == prior_season),
                             key=lambda r: -r["tot"])
        repl = curve_at(curve, pos, REPLACEMENT_RANK[pos])
        # The realized bar is that season's OWN rank-N finisher, not the
        # multi-season curve: "what he actually beat the replacement by" has to
        # be measured against the replacement he actually played against.
        repl_actual = season_rows[REPLACEMENT_RANK[pos] - 1]["tot"] if len(season_rows) >= REPLACEMENT_RANK[pos] else repl
        for rank, r in enumerate(season_rows, 1):
            raw = SHRINK * (curve_at(curve, pos, rank) - repl)
            realized = r["tot"] - repl_actual
            out[r["pid"]] = {
                # PROJECTION -- the primary value. Regression is a real effect and
                # it bites hardest exactly at the top (see the module docstring),
                # so this is deliberately well below what the player just did.
                "par": round(max(0.0, raw), 1),
                "par_unfloored": round(raw, 1),
                # What he ACTUALLY produced above replacement last season. Real,
                # and much larger for elite players -- Garrett 2025 is +107.0 here
                # against a +34.9 projection. Quote it as history, never as an
                # expectation, and never sum the two.
                "realized": round(realized, 1),
                "realized_per_game": round(realized / max(r["gp"], 1), 2),
                "pos": pos,
                "rank": rank,
                "gp": r["gp"],
                "tier": tier_for(pos, rank),
            }
    return out


def tier_for(pos, rank):
    """Tiers, because ordering inside the elite group is not supported by the
    data (LB's within-top-24 year-over-year correlation is 0.004). Say
    "a top-12 DL", never "the 4th-best DL"."""
    if rank <= 6:
        return "elite"
    if rank <= 12:
        return "top-12"
    if rank <= REPLACEMENT_RANK[pos]:
        return "startable"
    return "replacement"


def par_floor_note():
    """Why PAR floors at zero, in one line a pack warning can quote."""
    return ("PAR is floored at zero: a below-replacement defender is a roster slot "
            "refillable from the waiver wire for nothing, so his marginal value is "
            "nil rather than negative. 52% of top-24 IDP producers arrived off the "
            "wire, versus 6% on offense.")
