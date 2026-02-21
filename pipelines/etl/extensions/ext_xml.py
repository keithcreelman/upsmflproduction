"""
ext_xml.py — XML safe-encoding helper for MFL salary import.

Builds the <salaries> XML payload per Step 6 spec and produces a
URL-safe encoded string for the DATA POST parameter.

All values come from Step 4 version outputs (post-mutation state).
This module performs NO calculations — it formats only.
"""
from __future__ import annotations

from typing import Dict, List, Optional
from xml.sax.saxutils import escape as xml_escape


def _to_k(amount: int) -> str:
    """
    Convert integer dollars to K notation (thousands).

    Examples:
        5000  -> "5K"
        33000 -> "33K"
        162000 -> "162K"

    Raises ValueError if amount is not a multiple of 1000.
    """
    if amount % 1000 != 0:
        raise ValueError(
            f"Salary amount {amount} is not a multiple of 1000. "
            f"All extension salaries must be in $1,000 increments."
        )
    return f"{amount // 1000}K"


def build_contract_info(
    contract_length: int,
    total_contract_value: int,
    aav_current: int,
    aav_future: int,
    year_salary_breakdown: Dict[str, int],
    extension_history: List[str],
) -> str:
    """
    Build the contractInfo string per Step 6 locked format.

    Segment order (pipe-separated):
        CL {n}| TCV {x}K| AAV {x}K, {y}K| Y1-{x}K, Y2-{y}K, ...| Ext: {list}

    Rules:
        - Exactly ONE "AAV" label (even if multi-valued).
        - Ext segment omitted entirely if extension_history is empty.
        - Values in K notation (thousands).
        - No commas inside numeric tokens.
    """
    segments = []

    # CL
    segments.append(f"CL {contract_length}")

    # TCV
    segments.append(f"TCV {_to_k(total_contract_value)}")

    # AAV — single label, may be single or multi-valued
    if aav_current == aav_future:
        segments.append(f"AAV {_to_k(aav_current)}")
    else:
        segments.append(f"AAV {_to_k(aav_current)}, {_to_k(aav_future)}")

    # Year salary breakdown (Y1-{x}K, Y2-{y}K, ...)
    year_parts = []
    for i in range(1, len(year_salary_breakdown) + 1):
        key = f"Y{i}"
        if key in year_salary_breakdown:
            year_parts.append(f"{key}-{_to_k(year_salary_breakdown[key])}")
    if year_parts:
        segments.append(", ".join(year_parts))

    # Extension history — omit entirely if empty
    if extension_history:
        segments.append(f"Ext: {', '.join(extension_history)}")

    return "| ".join(segments)


def build_player_xml(
    player_id: str,
    salary: int,
    contract_year: int,
    contract_status: str,
    contract_info: str,
) -> str:
    """
    Build a single <player .../> XML element for MFL salary import.

    Args:
        player_id:       MFL player ID (string).
        salary:          Current year salary in integer dollars.
        contract_year:   Years remaining (integer).
        contract_status: e.g., "EXT1", "EXT2-FL", etc.
        contract_info:   Pre-built contractInfo string.

    Returns:
        XML string for one player element.
    """
    return (
        f'    <player'
        f' id="{xml_escape(str(player_id))}"'
        f' salary="{salary}"'
        f' contractYear="{contract_year}"'
        f' contractStatus="{xml_escape(contract_status)}"'
        f' contractInfo="{xml_escape(contract_info)}"'
        f' />'
    )


def build_salaries_xml(player_elements: List[str]) -> str:
    """
    Wrap player elements in the MFL <salaries> XML structure.

    Args:
        player_elements: List of XML strings from build_player_xml().

    Returns:
        Complete XML payload string.
    """
    players_block = "\n".join(player_elements)
    return (
        f'<salaries>\n'
        f'  <leagueUnit unit="LEAGUE">\n'
        f'{players_block}\n'
        f'  </leagueUnit>\n'
        f'</salaries>'
    )
