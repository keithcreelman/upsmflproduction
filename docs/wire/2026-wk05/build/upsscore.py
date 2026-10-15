"""UPS 2026 offensive scoring applied to an nflverse box score (exact, not expected).
Rule table: ev_projections.py docstring (MFL TYPE=rules). Not modeled: +1 for a 50+ yd TD,
pick-six extra, return TDs -- nflverse weekly stats carry no TD lengths."""
def tier(v, tiers):
    pts = 0
    for lo, p in tiers:
        if v >= lo: pts = p
    return pts
PPR = {"TE": 1.5, "RB": 0.8}
def ups(r, pos, fd=0.2, te_ppr=1.5):
    g = lambda k: float(r.get(k) or 0)
    p = 0.0
    p += g("passing_yards") * 0.04 + tier(g("passing_yards"), ((300, 1), (375, 2), (425, 3)))
    p += g("passing_tds") * 6 + g("passing_interceptions") * -2 + g("passing_2pt_conversions") * 2
    p += abs(g("sack_yards_lost")) * -0.1
    p += g("rushing_yards") * 0.1 + tier(g("rushing_yards"), ((100, 1), (150, 2), (200, 3), (250, 5)))
    p += g("rushing_tds") * 6 + g("rushing_2pt_conversions") * 2
    p += g("receiving_yards") * 0.1 + tier(g("receiving_yards"), ((100, 2), (150, 3), (200, 5)))
    p += g("receiving_tds") * 6 + g("receiving_2pt_conversions") * 2
    p += g("receptions") * (te_ppr if pos == "TE" else PPR.get(pos, 1.0))
    p += (g("passing_first_downs") + g("rushing_first_downs") + g("receiving_first_downs")) * fd
    p += (g("sack_fumbles_lost") + g("rushing_fumbles_lost") + g("receiving_fumbles_lost")) * -2
    return round(p, 2)
