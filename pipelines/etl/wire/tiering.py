"""One vocabulary for every starting slot, offense and defense.

WHY THIS EXISTS
    The lineup table used to print two incompatible things in one Value column:
    offense as a redraft-ADP price ("9,104 redraft") and defenders as a
    points-above-replacement sentence ("startable DL -- proj +1.7, was +5.5 last
    season"). You cannot read down that column, and Keith's objection went
    further than the mismatch:

        "These numbers dont make sense to people ... you need to use this to
         understand their value ... high end RB2 or Elite WR1, not 'Worth 6733'"

    He is right, and the fix is not to convert one scale into the other -- ADP is
    a PRICE and PAR is POINTS, and no honest arithmetic turns one into the other.
    The fix is that both scales exist only to answer the same question a manager
    actually asks: how good is this guy for his position? That answer is a TIER,
    and a tier is directly comparable across positions in the way the raw numbers
    never were.

    It also happens to be the only claim the IDP model supports. idp_value's own
    docstring: within-top-24 year-over-year rank correlation is ~0.32 for DL and
    0.004 for LB, so "the 4th-best LB" is a coin flip wearing a decimal point --
    "emit tiers, not ordinal claims". Tiering offense the same way makes the whole
    lineup speak one language, and it is the LOWER-precision side that sets the
    shared vocabulary, which is the right direction for a joint claim.

THE BANDS
    Starter demand in a 12-team league sets the band width: 12 of a position is
    one full round of starters, so ranks 1-12 are "1s", 13-24 are "2s", and so on
    -- exactly what an owner means by "he's my WR2".

    Inside band 1 the top is genuinely steep, so it splits three ways; deeper
    bands split two ways, because precision there is not real.

    Past the position's REPLACEMENT rank the band number stops meaning anything
    -- that is the point where the waiver wire supplies the same production for
    free -- so those players are named replacement-level with no band at all.
"""

# Replacement ranks. Offense is build_apw_seasonal.py's vetted REPL_RANK
# (QB24/RB30/WR40/TE13); defense is idp_value.REPLACEMENT_RANK, measured off
# revealed weekly starter demand. K/P start one per team and nothing else, so 12.
REPLACEMENT_RANK = {"QB": 24, "RB": 30, "WR": 40, "TE": 13,
                    "DL": 26, "LB": 27, "DB": 30,
                    "PK": 12, "PN": 12}

BAND = 12

# WHERE ELITE ENDS, SET EVERY YEAR FROM THE BOARD. Keith 2026-09-11, after the
# nine-season study of what "elite" has actually been worth: "Review it every
# year and confirm it with me. But for now let the board decide. I don't think
# we can't ever say someone isn't elite. But history should serve as a balancer
# to ensure things stay within reason."
#
# THE YEARLY RULE (elite_cut): the top man, plus anyone within ELITE_NEAR of
# him, and only if the first man outside is at least ELITE_CLIFF below the last
# man inside -- so the line never splits a virtual tie, and a position whose top
# is flat gets no elite tier at all.
#
# THE BALANCER (ELITE_MAX): the widest tier the 2017-2025 record can justify at
# each position, from the adversarially verified study on 2026-09-11. Only RB,
# WR, TE and DL showed a repeatable break near the top; at QB, LB, DB, PK and PN
# no gap in the top eight beat a tier-free null (preseason top-3 DBs finished
# top-3 in 3 of 27 tries; punter year-over-year correlation is 0.06). Those are
# capped at one, so a genuinely separated player can still be called elite in a
# year that earns it, but a flat crowd never can.
ELITE_NEAR, ELITE_CLIFF = 0.05, 0.05
ELITE_MAX = {"QB": 1, "RB": 2, "WR": 3, "TE": 2, "DL": 3, "LB": 1, "DB": 1, "PK": 1, "PN": 1}
_ELITE = {}


def elite_cut(pos, values):
    """How many at `pos` are Elite this year. `values` = the season's own value
    series at the position (board value for offense, projected season points for
    defense, kickers and punters), best first. 0 = no elite tier this year."""
    vals = [float(v) for v in values if v]
    if len(vals) < 3:
        return 0
    k = sum(1 for v in vals if v >= (1.0 - ELITE_NEAR) * vals[0])
    if k >= len(vals):
        return 0
    if (vals[k - 1] - vals[k]) < ELITE_CLIFF * vals[k - 1]:
        return 0
    return min(k, ELITE_MAX.get(pos, 1))


def set_elite_cuts(cuts):
    """Called once per build, after the board and the projections are loaded."""
    _ELITE.clear()
    _ELITE.update(dict((p, int(n)) for p, n in cuts.items()))


def elite_rank(pos):
    return int(_ELITE.get(pos, 0))


def tier_label(pos, rank):
    """"Elite WR1" / "High-end RB2" / "Replacement-level TE" / None.

    `rank` is the player's LEAGUE-WIDE rank at his position -- redraft-ADP rank
    for offense, prior-season PAR rank for defense. None means the source has no
    opinion, which is NOT the same as bad: return None and let the caller say
    "unranked", never a number.
    """
    if rank is None:
        return None
    try:
        rank = int(rank)
    except (TypeError, ValueError):
        return None
    if rank < 1:
        return None
    repl = REPLACEMENT_RANK.get(pos)
    if repl is None:
        # An unknown position has no replacement bar, so every band below would
        # be pure invention -- "High-end XX9" for rank 100. Refuse instead.
        return None
    if rank > repl:
        return "Replacement-level %s" % pos
    # THE LAST LEGAL BAND IS NOT A FULL BAND. Where the replacement rank is not
    # a multiple of 12 the top of the final band gets the flattering grade for
    # free: TE13 is the single worst startable tight end and came out
    # "High-end TE2"; same at DL25-26 and LB25-27. Grade the last, partial band
    # against how much of it is actually startable.
    band = (rank - 1) // BAND + 1
    if rank > BAND * (band - 1) and repl < BAND * band:
        span = repl - BAND * (band - 1)          # how many ranks are startable here
        within = rank - BAND * (band - 1)
        if span <= 2:
            grade = "Low-end"
        else:
            frac = (within - 1) / float(span - 1)
            grade = "High-end" if frac < 0.34 else ("Mid" if frac < 0.67 else "Low-end")
        return "%s %s%d" % (grade, pos, band)

    band = (rank - 1) // BAND + 1
    within = rank - BAND * (band - 1)          # 1..12
    # FOUR grades inside a band, not three. The first cut called ranks 4-8
    # "High-end", which made the QB8 and the RB8 "High-end QB1 / RB1" -- and
    # Keith rejected exactly that: nobody calls the eighth-best starter at his
    # position high-end. In common use "high-end" is the shoulder of the elite
    # tier and the middle of a band is just "Mid". Quartering the band matches
    # how the label is actually spoken and stops rank 8 from flattering itself.
    if band == 1:
        # The elite slice is this year's, not a fixed three; the rest of the
        # band splits evenly into High-end / Mid / Low-end below it.
        _e = elite_rank(pos)
        if within <= _e:
            grade = "Elite"
        else:
            frac = (within - _e - 1) / float(max(BAND - _e - 1, 1))
            grade = "High-end" if frac < 0.34 else ("Mid" if frac < 0.67 else "Low-end")
    else:
        grade = ("High-end" if within <= 4 else "Mid" if within <= 8 else "Low-end")
    return "%s %s%d" % (grade, pos, band)


def is_starter_grade(pos, rank):
    """True when the position's own replacement bar has not been crossed."""
    if rank is None:
        return False
    repl = REPLACEMENT_RANK.get(pos)
    return repl is None or int(rank) <= repl


# WHAT AN AUCTION BUY BOUGHT. Keith 2026-09-11, on the league value table:
# "It's Super Flex that needs to be considered. Also what is Depth? Anyone
# that's a starter should be considered better than depth." The first cut was
# top 3 / 4-12 / 13-24 / everything else, so a receiver who starts in his
# owner's flex (Parker Washington, WR30) read as Depth.
#   Elite      top 3 at the position
#   Very good  the rest of the top 12 -- every team's first starter
#   Good       13-24 where every team starts two: RB and WR by slot, and QB
#              because the superflex is a second quarterback in practice (11
#              of the 12 superflex slots held one in the 2026-09-11 build)
#   Starter    still inside the league's own starter demand -- how many at the
#              position the 12 best legal lineups actually start, flex included
#   Depth      everyone else, and anyone past the position's replacement bar
BOUGHT_BANDS = ("Elite", "Very good", "Good", "Starter depth", "Bench depth")
TWO_STARTER = ("QB", "RB", "WR")


def bought_band(pos, rank, demand, starts=False):
    """One of BOUGHT_BANDS for an offensive player at league-wide `rank`.

    `demand` = how many at `pos` start across the league's 12 lineups.
    `starts` = he holds a slot in one of those twelve lineups.

    STARTING BEATS RANK (Keith 2026-09-11: "Anyone that's a starter should be
    considered better than depth", and "call it starter depth and bench depth").
    The replacement bar used to override the league's own demand, so a tight end
    at 14 or a back at 31 who starts every week read as Depth alongside players
    nobody rosters."""
    if rank is not None:
        rank = int(rank)
        if rank >= 1 and is_starter_grade(pos, rank):
            if rank <= elite_rank(pos):
                return "Elite"
            if rank <= BAND:
                return "Very good"
            if pos in TWO_STARTER and rank <= 2 * BAND:
                return "Good"
            return "Starter depth"
        if rank >= 1 and demand and rank <= int(demand):
            return "Starter depth"
    return "Starter depth" if starts else "Bench depth"
