"""
trade_announcement.py — Build the trade announcement Discord embed.

This is Message 1 of the trade post sequence. Roast lands in a thread off
this message; GIF lands in the same thread.

Structure (Keith 2026-05-22, refined through v7):
  Per side:
    {Team} gives up:
      • Player X (POS · NFL) — Yrs remaining, $X salary, contract status
      • Current-year pick:  {Year} {Team}'s Pick R.SS  (e.g. "2026 X's Pick 3.11")
      • Future-year pick:   {Year} {Team}'s Nth Round Pick  (slot unknown)
    Receives $X Cap Credit  (only if BB received)
    Gives $X Cap Credit     (only if BB given)
    Net Salary Change = $X commitment | $X relief

Net Salary Change math:
  + salary of acquired players (current-year salary)
  - salary of given players (current-year salary)
  + BB given (you committed cash → cap commitment)
  - BB received (cash credit → cap relief)
  + rookie slot AAV for R1 picks acquired in CURRENT_YEAR (you'll owe the rookie)
  R2+ picks are taxi-eligible → $0 cap impact.
  Future-year picks (year > current_year) → $0 cap impact in current season.

Built from the same TradeAnalysis the roast uses, so they stay in sync.
"""

from datetime import datetime, timezone

CURRENT_YEAR = 2026  # UPS current league year; bump when 2027 season opens


def _ordinal(n: int) -> str:
    if n <= 0:
        return f"{n}"
    suffixes = {1: "st", 2: "nd", 3: "rd"}
    # 11/12/13 are exceptions
    if 11 <= (n % 100) <= 13:
        return f"{n}th"
    return f"{n}{suffixes.get(n % 10, 'th')}"


def _fmt_dollars(amount: int) -> str:
    """Format dollars in K-rounded shortform: $48K, $1.2M."""
    if abs(amount) >= 1_000_000:
        return f"${amount / 1_000_000:.1f}M"
    return f"${amount // 1000}K"


def _format_pick(pk, franchises: dict) -> str:
    """Render a pick as '{year} {OwnerTeam}'s {ord} Round Pick'.

    Keith 2026-05-22: drop slot, always show originating owner by team name.
    Use the canonical current team_name from franchises lookup.
    """
    year = pk.year
    rnd = pk.round
    # Originating owner — empty string means "this side's own pick" (use sender fid)
    orig = (pk.original_owner or "").strip().zfill(4) if (pk.original_owner or "").strip() else ""
    # If orig is empty, the caller should have passed sender_fid; we don't have it here so
    # this function will be called WITH the proper fid resolution upstream.
    return f"{year} {franchises.get(orig, '(unknown)')}'s {_ordinal(rnd)} Round Pick"


def _possessive(name: str) -> str:
    """Render the possessive form of a team name.

    "The Long Haulers" → "The Long Haulers'" (drop final s for names ending in s)
    "HammerTime" → "HammerTime's"
    """
    name = name.rstrip()
    if name.endswith(("s", "S")):
        return f"{name}'"
    return f"{name}'s"


def _format_pick_with_sender(pk, sender_fid: str, franchises: dict) -> str:
    """Same as _format_pick but with sender_fid fallback when original_owner is blank.

    Current-year picks (year == CURRENT_YEAR) include slot since we know the
    draft order: "2026 The Long Haulers' Pick 3.11". Future picks have unknown
    slot: "2027 The Long Haulers' 1st Round Pick".
    """
    year = pk.year
    rnd = pk.round
    slot = getattr(pk, "predicted_slot", 0) or 0
    orig_raw = (getattr(pk, "original_owner", "") or "").strip()
    orig = orig_raw.zfill(4) if orig_raw else sender_fid.zfill(4)
    team_name = franchises.get(orig, f"Franchise {orig}")
    if year == CURRENT_YEAR and 1 <= slot <= 12:
        return f"{year} {_possessive(team_name)} Pick {rnd}.{slot:02d}"
    return f"{year} {_possessive(team_name)} {_ordinal(rnd)} Round Pick"


def _format_player(p) -> str:
    """Render a player as 'Name (POS · NFL) — Yrs remaining, $X salary[, contract_status]'."""
    from trade_roast_context import display_name  # local import to avoid circular dep
    name = display_name(p.name)
    pos_nfl = p.position
    if getattr(p, "team", ""):
        pos_nfl = f"{p.position} · {p.team}"
    yrs = getattr(p, "contract_year", 0)
    yrs_str = f"{yrs}yr remaining" if yrs else "contract details unknown"
    sal = p.salary or 0
    parts = [f"**{name}** ({pos_nfl})", yrs_str, f"{_fmt_dollars(sal)} salary"]
    cs = getattr(p, "contract_status", "") or ""
    if cs:
        parts.append(cs)
    return "  • " + " — ".join([parts[0], ", ".join(parts[1:])])


def _net_salary_change(side) -> int:
    """Compute net salary change for `side`.

    Positive = commitment added (cap going DOWN).
    Negative = relief gained (cap going UP).

    Math:
      + sum(salaries of acquired players, current-year)
      - sum(salaries of given players, current-year)
      + BB given (committed cash you handed away)
      - BB received (cash credit you got)
      + rookie slot AAV for R1 picks ACQUIRED in CURRENT_YEAR
        (commits the acquirer to the drafted rookie's current-year salary)
      Note: R2+ picks → $0 (taxi-eligible). Future-year picks → $0.
      The team GIVING a current-year R1 doesn't get relief either —
      they hadn't yet drafted, so no current obligation to shed.
    """
    salary_in = sum(int(p.salary or 0) for p in side.players_received)
    salary_out = sum(int(p.salary or 0) for p in side.players_given)
    bb_given = int(side.salary_given or 0)
    bb_received = int(side.salary_received or 0)
    # Current-year R1 acquired → rookie salary commitment
    r1_rookie_in = sum(
        int(getattr(pk, "rookie_aav", 0) or 0)
        for pk in side.picks_received
        if pk.year == CURRENT_YEAR and pk.round == 1
    )
    return salary_in - salary_out + bb_given - bb_received + r1_rookie_in


def _build_side_block(side, sender_fid: str, franchises: dict) -> str:
    """Build the multi-line value for one side's embed field."""
    lines = []
    # Players given (bullets)
    for p in side.players_given:
        lines.append(_format_player(p))
    # Picks given (bullets)
    for pk in side.picks_given:
        lines.append(f"  • {_format_pick_with_sender(pk, sender_fid, franchises)}")
    # Placeholder if nothing in the gives-up list
    if not lines:
        lines.append("  • (nothing)")
    # Cap credit lines (Keith 2026-05-22: mirror "Receives" / "Gives" phrasing,
    # NOT a bulleted "$X Budget Bucks" entry).
    if side.salary_received:
        lines.append("")
        lines.append(f"_Receives {_fmt_dollars(side.salary_received)} Cap Credit_")
    if side.salary_given:
        if not side.salary_received:
            lines.append("")
        lines.append(f"_Gives {_fmt_dollars(side.salary_given)} Cap Credit_")
    # Net salary change
    net = _net_salary_change(side)
    lines.append("")
    if net > 0:
        lines.append(f"**Net Salary Change: {_fmt_dollars(net)} commitment**")
    elif net < 0:
        lines.append(f"**Net Salary Change: {_fmt_dollars(abs(net))} relief**")
    else:
        lines.append("**Net Salary Change: $0**")
    return "\n".join(lines)


def build_announcement_embed(analysis, franchises: dict, trade_dt_iso: str = "") -> dict:
    """Build the Discord embed for the trade announcement (Message 1).

    Args:
        analysis: TradeAnalysis from trade_grader.analyze_trade
        franchises: dict[franchise_id → current team_name]
        trade_dt_iso: ISO timestamp of the trade for the embed footer
    """
    a = analysis.side_a
    b = analysis.side_b
    team_a = franchises.get(a.franchise_id, a.franchise_name or f"Franchise {a.franchise_id}")
    team_b = franchises.get(b.franchise_id, b.franchise_name or f"Franchise {b.franchise_id}")

    # Format date
    date_str = ""
    if trade_dt_iso:
        try:
            dt = datetime.fromisoformat(trade_dt_iso.replace("Z", "+00:00"))
            date_str = dt.strftime("%b %d, %Y")
        except Exception:
            date_str = trade_dt_iso

    description_lines = ["# 🤝 Trade Alert", "", f"**{team_a}** ↔ **{team_b}**"]
    if date_str:
        description_lines.append(f"_{date_str}_")

    embed = {
        "title": "TRADE",
        "description": "\n".join(description_lines),
        "color": 0xc8a24d,  # gold
        "fields": [
            {
                "name": f"{team_a} gives up",
                "value": _build_side_block(a, a.franchise_id, franchises),
                "inline": False,
            },
            {
                "name": f"{team_b} gives up",
                "value": _build_side_block(b, b.franchise_id, franchises),
                "inline": False,
            },
        ],
    }
    return embed
