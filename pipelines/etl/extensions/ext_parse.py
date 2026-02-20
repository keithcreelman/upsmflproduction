"""
ext_parse.py — Deterministic contract_info parser (Phase 2 / Step 1 spec).

Parses the raw contractInfo string into the 7 locked derived fields
defined in Step 1 Section 3.

Rules:
    - CL {n}             -> contract_length (default: 1)
    - TCV {amount}       -> total_contract_value (default: salary)
    - AAV {val}[, {val}] -> aav_current, aav_future (default: salary)
    - Y#-{amount}        -> year_salary_breakdown (default: {Y1: salary})
    - Ext: {list}        -> extension_history (default: [])
    - GTD: {amount}      -> contract_guarantee (default: None)
    - no_extension_flag is not parsed from contractInfo; sourced from extension_blocks

Unit conversion:
    - K = thousands (e.g., 5K -> 5000)
    - Strip commas/spaces before numeric conversion
"""
from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# Unit conversion
# ---------------------------------------------------------------------------

def _convert_k(token: str) -> Optional[int]:
    """
    Convert a K-notation token to integer dollars.

    Examples:
        "5K"    -> 5000
        "15K"   -> 15000
        "162K"  -> 162000
        "5000"  -> 5000
        "5,000" -> 5000
        ""      -> None

    Returns None if parsing fails.
    """
    if not token:
        return None
    s = token.strip().replace(",", "").replace(" ", "")
    if not s:
        return None
    if s.upper().endswith("K"):
        num_part = s[:-1]
        try:
            return int(float(num_part) * 1000)
        except (ValueError, TypeError):
            return None
    else:
        try:
            return int(float(s))
        except (ValueError, TypeError):
            return None


# ---------------------------------------------------------------------------
# Segment parsers (pure functions)
# ---------------------------------------------------------------------------

def _parse_cl(text: str) -> Tuple[int, Optional[str]]:
    """
    Parse CL {n} from contractInfo.

    Returns:
        (contract_length, warning_or_None)

    Default: 1 if missing/NULL/empty or only "CL 1|"
    """
    if not text:
        return 1, None

    m = re.search(r'\bCL\s+(\d+)', text)
    if m:
        val = int(m.group(1))
        if val < 1:
            return 1, f"CL value {val} < 1; defaulted to 1"
        return val, None

    return 1, None


def _parse_tcv(text: str, salary: Optional[int]) -> Tuple[Optional[int], Optional[str]]:
    """
    Parse TCV {amount} from contractInfo.

    Default: salary if missing.
    """
    if not text:
        return salary, None

    m = re.search(r'\bTCV\s+([\d,\.]+K?)', text, re.IGNORECASE)
    if m:
        val = _convert_k(m.group(1))
        if val is not None:
            return val, None
        return salary, f"TCV token '{m.group(1)}' unparseable; defaulted to salary"

    return salary, None


def _parse_aav(
    text: str, salary: Optional[int]
) -> Tuple[Optional[int], Optional[int], Optional[str]]:
    """
    Parse AAV from contractInfo.

    Formats:
        AAV 5K              -> single: aav_current = aav_future = 5000
        AAV 5K, 15K         -> multi:  aav_current = 5000, aav_future = 15000
        AAV 5K/15K          -> multi:  aav_current = 5000, aav_future = 15000

    Default: both = salary if missing.

    Returns:
        (aav_current, aav_future, warning_or_None)
    """
    if not text:
        return salary, salary, None

    # Match "AAV" followed by one or more K-notation values separated by , or /
    m = re.search(r'\bAAV\s+([\d,\.\s/K]+)', text, re.IGNORECASE)
    if not m:
        return salary, salary, None

    raw = m.group(1).strip()
    # Split on comma or slash
    parts = re.split(r'[,/]', raw)
    parts = [p.strip() for p in parts if p.strip()]

    if len(parts) == 0:
        return salary, salary, f"AAV segment found but no values parsed; defaulted to salary"

    if len(parts) == 1:
        val = _convert_k(parts[0])
        if val is not None:
            return val, val, None
        return salary, salary, f"AAV token '{parts[0]}' unparseable; defaulted to salary"

    # Multi-value: first = current, last = future
    first = _convert_k(parts[0])
    last = _convert_k(parts[-1])
    if first is not None and last is not None:
        return first, last, None

    warning = f"AAV multi-value parse partial: first='{parts[0]}', last='{parts[-1]}'"
    return (
        first if first is not None else salary,
        last if last is not None else salary,
        warning,
    )


def _parse_year_breakdown(
    text: str, salary: Optional[int]
) -> Tuple[Dict[str, int], Optional[str]]:
    """
    Parse Y#-{amount} pairs from contractInfo.

    Examples:
        "Y1-33K, Y2-64K, Y3-65K"  -> {Y1: 33000, Y2: 64000, Y3: 65000}

    Default when missing: {Y1: salary}
    """
    if not text:
        if salary is not None:
            return {"Y1": salary}, None
        return {}, "No year breakdown and no salary for fallback"

    # Find all Y#-{amount} pairs
    matches = re.findall(r'\b(Y\d+)\s*-\s*([\d,\.]+K?)', text, re.IGNORECASE)
    if not matches:
        if salary is not None:
            return {"Y1": salary}, None
        return {}, "No Y#-amount pairs found and no salary for fallback"

    breakdown = {}
    warnings = []
    for year_label, amount_token in matches:
        year_key = year_label.upper()
        val = _convert_k(amount_token)
        if val is not None:
            breakdown[year_key] = val
        else:
            warnings.append(f"{year_key} token '{amount_token}' unparseable")

    warning = "; ".join(warnings) if warnings else None
    return breakdown, warning


def _parse_extension_history(text: str) -> Tuple[List[str], Optional[str]]:
    """
    Parse Ext: segment from contractInfo.

    Example: "Ext: Creel, Hammer" -> ["Creel", "Hammer"]

    Returns:
        (list_of_abbrevs, warning_or_None)
    """
    if not text:
        return [], None

    m = re.search(r'\bExt:\s*(.+?)(?:\||$)', text)
    if not m:
        return [], None

    raw = m.group(1).strip()
    if not raw:
        return [], None

    parts = [p.strip() for p in raw.split(",")]
    parts = [p for p in parts if p]
    return parts, None


def _parse_guarantee(text: str) -> Tuple[Optional[int], Optional[str]]:
    """
    Parse GTD: {amount} from contractInfo.

    Returns:
        (contract_guarantee_int, warning_or_None)

    Default: None if missing.
    """
    if not text:
        return None, None

    m = re.search(r'\bGTD:\s*([\d,\.]+K?)', text, re.IGNORECASE)
    if not m:
        return None, None

    val = _convert_k(m.group(1))
    if val is not None:
        return val, None
    return None, f"GTD token '{m.group(1)}' unparseable"


def _parse_no_extension_flag(text: str) -> bool:
    """
    RETIRED — no longer called by parse_contract_info.

    no_extension_flag is now sourced exclusively from the extension_blocks
    table (block_type = 'NO_EXTENSION', active = 1).
    It is NOT parsed from contract_info_raw.

    This function is retained for reference / historical parsing only.
    Do NOT call from production paths.
    """
    if not text:
        return False
    lower = text.lower()
    return "no further extensions" in lower or "no future extensions" in lower


# ---------------------------------------------------------------------------
# Main parser
# ---------------------------------------------------------------------------

def parse_contract_info(
    contract_info_raw: Optional[str],
    salary: Optional[int],
    contract_year: Optional[int],
) -> Dict[str, Any]:
    """
    Parse a contractInfo string into all Step 1 derived fields.

    Args:
        contract_info_raw: Raw contractInfo string (may be None/empty).
        salary:            Current year salary in integer dollars (may be None).
        contract_year:     Years remaining (may be None).

    Returns:
        Dict with keys:
            contract_length         (int)
            total_contract_value    (int or None)
            aav_current             (int or None)
            aav_future              (int or None)
            year_salary_breakdown   (dict)
            extension_history       (list)
            contract_guarantee      (int or None)
            no_extension_flag       (bool) — always False here; set to True by
                                    Phase 2 extension_blocks sync step
            parse_warnings          (list of strings)
    """
    text = contract_info_raw or ""
    warnings: List[str] = []

    # CL
    contract_length, w = _parse_cl(text)
    if w:
        warnings.append(w)

    # TCV
    total_contract_value, w = _parse_tcv(text, salary)
    if w:
        warnings.append(w)

    # AAV
    aav_current, aav_future, w = _parse_aav(text, salary)
    if w:
        warnings.append(w)

    # Year breakdown
    year_salary_breakdown, w = _parse_year_breakdown(text, salary)
    if w:
        warnings.append(w)

    # Extension history
    extension_history, w = _parse_extension_history(text)
    if w:
        warnings.append(w)

    # Guarantee
    contract_guarantee, w = _parse_guarantee(text)
    if w:
        warnings.append(w)

    # no_extension_flag: always False at parse time.
    # True value is applied by Phase 2 extension_blocks sync (not from contract_info_raw).
    no_extension_flag = False

    return {
        "contract_length": contract_length,
        "total_contract_value": total_contract_value,
        "aav_current": aav_current,
        "aav_future": aav_future,
        "year_salary_breakdown": year_salary_breakdown,
        "extension_history": extension_history,
        "contract_guarantee": contract_guarantee,
        "no_extension_flag": no_extension_flag,
        "parse_warnings": warnings,
    }


# ---------------------------------------------------------------------------
# DB loader
# ---------------------------------------------------------------------------

def load_roster_snapshot_parsed(
    conn,
    rows: List[Tuple],
) -> int:
    """
    INSERT OR REPLACE parsed roster rows into roster_snapshot_parsed.

    Each row tuple must be:
        (nfl_season, franchise_id, player_id,
         contract_status, contract_year, salary, contract_info_raw,
         contract_length, total_contract_value, aav_current, aav_future,
         year_salary_breakdown_json, extension_history_json,
         contract_guarantee, no_extension_flag, parse_warnings)

    Returns count of rows inserted.
    """
    cur = conn.cursor()
    cur.executemany(
        """
        INSERT OR REPLACE INTO roster_snapshot_parsed
            (nfl_season, franchise_id, player_id,
             contract_status, contract_year, salary, contract_info_raw,
             contract_length, total_contract_value, aav_current, aav_future,
             year_salary_breakdown_json, extension_history_json,
             contract_guarantee, no_extension_flag, parse_warnings)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        rows,
    )
    conn.commit()
    return len(rows)
