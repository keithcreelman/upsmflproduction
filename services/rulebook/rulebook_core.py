#!/usr/bin/env python3
from __future__ import annotations

import csv
import json
import os
import re
import ssl
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parent
RULES_ROOT = SERVICE_ROOT / "sources" / "rules"
ARCHIVE_ROOT = RULES_ROOT / "archive"
GENERATED_ROOT = SERVICE_ROOT / "sources" / "generated" / "mfl"
DATA_ROOT = SERVICE_ROOT / "data"

CURRENT_RULEBOOK_STRUCT = ARCHIVE_ROOT / "current_rulebook_struct.json"
RULEBOOK_TEXT = ARCHIVE_ROOT / "UPS Rule Book.txt"
CONTRACT_GUIDE_TEXT = ARCHIVE_ROOT / "UPS Contract Rules.txt"
SETTINGS_CHANGES_PATH = RULES_ROOT / "settings_changes.md"
LEAGUE_SETTINGS_PATH = ARCHIVE_ROOT / "league_settings.csv"
STARTERS_METADATA_PATH = ARCHIVE_ROOT / "metadata_starters.csv"
CLASSIFIED_RULES_PATH = RULES_ROOT / "mfl_message_boards" / "classified" / "rules.md"
HIGHLIGHTS_RULES_PATH = RULES_ROOT / "mfl_message_boards" / "highlights" / "rules_2010_2011.md"
CONTRACT_EXAMPLES_PATH = RULES_ROOT / "contract_examples.md"
SCORING_EXAMPLES_PATH = RULES_ROOT / "scoring_examples.md"
MANUAL_CONFIRMATIONS_PATH = RULES_ROOT / "manual_confirmations.json"
MFL_MANIFEST_PATH = GENERATED_ROOT / "manifest.json"

RULES_JSON_PATH = DATA_ROOT / "rules.json"
RULES_AI_PATH = DATA_ROOT / "rules_ai.json"
RULEBOOK_BUNDLE_PATH = DATA_ROOT / "rulebook_bundle.json"

DEFAULT_TIMEOUT = 30
CURRENT_SEASON = int(os.getenv("RULEBOOK_CURRENT_SEASON", "2026"))

TOPIC_ORDER = [
    "Current Rules",
    "Contracts",
    "Scoring & Starters",
    "Roster / Lineup",
    "Acquisition Rules",
    "Trades",
    "League Finance & Penalties",
    "History",
    "Glossary",
    "Needs Confirmation",
]
TOPIC_INDEX = {label: index for index, label in enumerate(TOPIC_ORDER)}

ALLOWED_KINDS = {
    "rule",
    "contract_example",
    "math_example",
    "glossary",
    "scoring_rule",
    "settings_snapshot",
    "history_event",
    "open_item",
}
ALLOWED_STATUS = {"current", "historical", "needs_confirmation"}
ALLOWED_AUTHORITY = {
    "written_rulebook",
    "mfl_live_setting",
    "approved_amendment",
    "historical_reference",
    "discussion_only",
}

STATUS_AUTHORITY_RANK = {
    ("current", "written_rulebook"): 0,
    ("current", "mfl_live_setting"): 1,
    ("current", "approved_amendment"): 2,
    ("historical", "historical_reference"): 3,
    ("historical", "discussion_only"): 4,
    ("needs_confirmation", "historical_reference"): 5,
    ("needs_confirmation", "discussion_only"): 6,
}

SECTION_TOPIC_MAP = {
    "League Overview": "Current Rules",
    "League Calendar": "Current Rules",
    "Roster Management": "Roster / Lineup",
    "Rookie Draft": "Acquisition Rules",
    "Free Agent Auction": "Acquisition Rules",
    "Expired Rookie Auction": "Acquisition Rules",
    "Waivers": "Acquisition Rules",
    "Trades": "Trades",
    "Contract Management": "Contracts",
    "League Financing": "League Finance & Penalties",
    "Penalties and Miscellaneous League Rules": "League Finance & Penalties",
    "Scoring Settings": "Scoring & Starters",
    "League History & Records (In Progress)": "History",
}

CURRENT_RULEBOOK_VERSION = "2.1"
ALL_RULE_POSITIONS = {"QB", "RB", "WR", "TE", "PK", "PN", "DT", "DE", "LB", "CB", "S"}
OFFENSIVE_POSITIONS = {"QB", "RB", "WR", "TE"}
DEFENSIVE_POSITIONS = {"DT", "DE", "LB", "CB", "S"}
SPECIAL_POSITIONS = {"PK", "PN"}
RETURN_EVENTS = {"UY", "KY"}
SPECIAL_EVENTS = {
    "FG",
    "MG",
    "EP",
    "EM",
    "ANY",
    "PI",
    "PBLK",
    "PTD",
    "KRTD",
    "PRTD",
}
DEFENSIVE_EVENTS = {
    "TK",
    "AS",
    "TKL",
    "SK",
    "FF",
    "FR",
    "INT",
    "PD",
    "SF",
    "SFTY",
    "BLKK",
    "BLKP",
}

SEASON_HIGHLIGHTS = {
    2011: [
        "Punter scoring used punts inside the 20 at 2 points and still had the older gross-yardage era rules.",
    ],
    2012: [
        "Return-yardage scoring started in 2012.",
        "Rookie contracts moved to 3 years beginning with the 2013 class after the 2012 vote.",
    ],
    2015: [
        "Starter count increased to 15.",
    ],
    2018: [
        "Starter count moved to 17 and IDP starters expanded to 7.",
        "Roster size moved to 30 with auction overage up to 35.",
    ],
    2022: [
        "The current 18-starter superflex-era range model began in 2022.",
        "The regular season moved to 14 weeks.",
    ],
}

TOPIC_RECOMMENDED_HANDLING = {
    "League Overview": "Use the current written rulebook for governance and treat legacy structures as historical until the commissioner confirms otherwise.",
    "League Calendar": "Use the current written calendar dates unless a commissioner-approved amendment explicitly changes the deadline.",
    "Roster Management": "Use the current written roster and lineup rules, but treat mismatches against live MFL settings as flagged comparisons instead of silent overrides.",
    "Rookie Draft": "Use the current written rookie-draft process and treat omitted legacy salary details as unresolved until confirmed.",
    "Free Agent Auction": "Use the current written auction flow and nomination window unless a commissioner note resolves a legacy penalty rule.",
    "Expired Rookie Auction": "Use the current April 30 workflow while the older June and July references remain historical.",
    "Waivers": "Use the live MFL waiver mode plus the written blind-bid and FCFS descriptions.",
    "Trades": "Use the current immediate-processing trade model unless the commissioner reinstates a different review process.",
    "Contract Management": "Use the current written rulebook plus the current contract guide, but keep legacy contract-era debates in open items until resolved.",
    "League Financing": "Use the current dues schedule and payout structure in the written rulebook.",
    "Penalties and Miscellaneous League Rules": "Use the explicitly written current penalties and treat placeholders or legacy penalty tables as historical until replaced.",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="ignore")


def read_json(path: Path):
    return json.loads(read_text(path))


def read_csv_rows(path: Path) -> list[dict]:
    with path.open("r", encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def write_json(path: Path, payload) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + "\n", encoding="utf-8")


def write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def normalize_ws(value) -> str:
    if value is None:
        return ""
    value = str(value).replace("\u00a0", " ")
    return re.sub(r"\s+", " ", value).strip()


def compact_excerpt(value, limit=220) -> str:
    text = normalize_ws(value)
    if len(text) <= limit:
        return text
    return text[: limit - 3].rstrip() + "..."


def slugify(value: str) -> str:
    text = normalize_ws(value).lower()
    text = re.sub(r"[^a-z0-9]+", "-", text)
    return text.strip("-") or "untitled"


def parse_int(value):
    try:
        return int(str(value))
    except Exception:
        return None


def parse_float(value):
    try:
        return float(str(value))
    except Exception:
        return None


def coerce_season(value):
    season = parse_int(value)
    if season is None:
        return None
    return season


def keywordize(*parts) -> list[str]:
    keywords = []
    for part in parts:
        if not part:
            continue
        if isinstance(part, (list, tuple, set)):
            keywords.extend(keywordize(*part))
            continue
        text = normalize_ws(part).lower()
        keywords.extend(token for token in re.split(r"[^a-z0-9+#]+", text) if token)
    return sorted(dict.fromkeys(keywords))


def markdown_sections(sections: list[tuple[str, list[str] | str]]) -> str:
    blocks = []
    for heading, raw_lines in sections:
        if isinstance(raw_lines, str):
            lines = [line for line in raw_lines.splitlines()]
        else:
            lines = list(raw_lines)
        lines = [normalize_ws(line) for line in lines if normalize_ws(line)]
        if not lines:
            continue
        blocks.append(f"### {heading}")
        for line in lines:
            prefix = "- " if not line.startswith("- ") else ""
            blocks.append(prefix + line)
        blocks.append("")
    return "\n".join(blocks).strip()


def subsection_markdown(subsections: list[dict]) -> str:
    sections = []
    for subsection in subsections:
        title = normalize_ws(subsection.get("title"))
        title = re.sub(r"^\d+(?:\.\d+)?\s*", "", title).strip() or "Untitled"
        sections.append((title, subsection.get("content") or []))
    return markdown_sections(sections)


def first_sentence(text: str) -> str:
    text = normalize_ws(text)
    if not text:
        return ""
    parts = re.split(r"(?<=[.!?])\s+", text)
    return parts[0]


def source_ref(
    source_id: str,
    source_kind: str,
    path_or_url,
    season=None,
    date_text=None,
    excerpt="",
    confidence=0.8,
):
    return {
        "source_id": source_id,
        "source_kind": source_kind,
        "path_or_url": str(path_or_url),
        "season": str(season) if season is not None else None,
        "date_text": date_text,
        "excerpt": compact_excerpt(excerpt),
        "confidence": float(confidence),
    }


def make_document(
    doc_id: str,
    *,
    kind: str,
    topic: str,
    subcategory: str,
    title: str,
    summary: str,
    body_md: str,
    status: str,
    authority: str,
    effective_from_season,
    effective_to_season,
    keywords=None,
    source_refs=None,
    related_ids=None,
    example_ids=None,
    needs_confirmation_reason="",
    table_rows=None,
    comparison_cards=None,
    workflow_refs=None,
    example_sections=None,
    historical_note_ids=None,
    open_item_ids=None,
    recommended_handling="",
    sort_order=0,
):
    return {
        "id": doc_id,
        "slug": slugify(title),
        "kind": kind,
        "topic": topic,
        "subcategory": subcategory,
        "title": title,
        "summary": normalize_ws(summary),
        "body_md": body_md.strip(),
        "status": status,
        "authority": authority,
        "effective_from_season": effective_from_season,
        "effective_to_season": effective_to_season,
        "keywords": sorted(dict.fromkeys(keywords or [])),
        "source_refs": list(source_refs or []),
        "related_ids": list(related_ids or []),
        "example_ids": list(example_ids or []),
        "needs_confirmation_reason": needs_confirmation_reason,
        "table_rows": list(table_rows or []),
        "comparison_cards": list(comparison_cards or []),
        "workflow_refs": list(workflow_refs or []),
        "example_sections": dict(example_sections or {}),
        "historical_note_ids": list(historical_note_ids or []),
        "open_item_ids": list(open_item_ids or []),
        "recommended_handling": normalize_ws(recommended_handling),
        "sort_order": sort_order,
    }


def sort_documents(documents: list[dict]) -> list[dict]:
    def sort_key(doc):
        return (
            TOPIC_INDEX.get(doc.get("topic"), 999),
            STATUS_AUTHORITY_RANK.get((doc.get("status"), doc.get("authority")), 999),
            doc.get("subcategory", ""),
            doc.get("sort_order", 0),
            doc.get("title", ""),
        )

    return sorted(documents, key=sort_key)


def load_rulebook_sources():
    return {
        "rulebook_struct": read_json(CURRENT_RULEBOOK_STRUCT),
        "rulebook_text": read_text(RULEBOOK_TEXT),
        "contract_guide_text": read_text(CONTRACT_GUIDE_TEXT),
        "settings_changes": read_text(SETTINGS_CHANGES_PATH),
        "league_settings_rows": read_csv_rows(LEAGUE_SETTINGS_PATH),
        "starters_rows": read_csv_rows(STARTERS_METADATA_PATH),
        "classified_rules": read_text(CLASSIFIED_RULES_PATH),
        "highlights_rules": read_text(HIGHLIGHTS_RULES_PATH),
        "contract_examples": read_text(CONTRACT_EXAMPLES_PATH),
        "scoring_examples": read_text(SCORING_EXAMPLES_PATH),
        "manual_confirmations": read_json(MANUAL_CONFIRMATIONS_PATH),
        "mfl_manifest": read_json(MFL_MANIFEST_PATH) if MFL_MANIFEST_PATH.exists() else {},
    }


def parse_rulebook_metadata(rulebook_text: str) -> dict:
    def capture(label):
        match = re.search(rf"{label}:\s*(.+)", rulebook_text)
        return normalize_ws(match.group(1)) if match else ""

    return {
        "commissioner": capture("Commissioner"),
        "version": capture("Version"),
        "last_updated": capture("Last Updated"),
        "mission_statement": normalize_ws(
            re.search(r"Mission Statement:\s*(.+?)\s*Note:", rulebook_text, re.S).group(1)
        )
        if re.search(r"Mission Statement:\s*(.+?)\s*Note:", rulebook_text, re.S)
        else "",
    }


def parse_structured_examples(markdown_text: str) -> list[dict]:
    documents = []
    for block in re.split(r"^##\s+", markdown_text, flags=re.M):
        block = block.strip()
        if not block:
            continue
        lines = block.splitlines()
        head = lines[0].strip()
        if "|" not in head:
            continue
        doc_id, title = [normalize_ws(part) for part in head.split("|", 1)]
        metadata = {}
        sections = {}
        current_section = None
        section_lines = []

        for line in lines[1:]:
            raw = line.rstrip()
            if not raw.strip():
                if current_section:
                    section_lines.append("")
                continue
            if current_section is None and ":" in raw:
                key, value = raw.split(":", 1)
                if key.strip() in {
                    "Kind",
                    "Topic",
                    "Applies To",
                    "Keywords",
                    "Status",
                    "Authority",
                }:
                    metadata[key.strip()] = normalize_ws(value)
                    continue
            if raw.endswith(":") and normalize_ws(raw[:-1]) in {
                "Scenario",
                "Inputs",
                "Calculation",
                "Outcome",
                "Why it matters",
            }:
                if current_section:
                    sections[current_section] = "\n".join(section_lines).strip()
                current_section = normalize_ws(raw[:-1])
                section_lines = []
                continue
            section_lines.append(raw)

        if current_section:
            sections[current_section] = "\n".join(section_lines).strip()

        status = metadata.get("Status", "current")
        authority = metadata.get("Authority", "written_rulebook")
        applies_to = [item.strip() for item in metadata.get("Applies To", "").split(",") if item.strip()]
        body_md = markdown_sections([(name, text) for name, text in sections.items()])
        documents.append(
            make_document(
                doc_id,
                kind=metadata.get("Kind", "math_example"),
                topic=metadata.get("Topic", "Contracts"),
                subcategory="Worked Examples",
                title=title,
                summary=first_sentence(sections.get("Outcome") or sections.get("Scenario") or title),
                body_md=body_md,
                status=status,
                authority=authority,
                effective_from_season=CURRENT_SEASON if status == "current" else None,
                effective_to_season=None,
                keywords=keywordize(title, metadata.get("Keywords", ""), applies_to),
                source_refs=[
                    source_ref(
                        doc_id,
                        "markdown_source",
                        CONTRACT_EXAMPLES_PATH if doc_id.startswith("EX-CONTRACT") else SCORING_EXAMPLES_PATH,
                        season=CURRENT_SEASON if status == "current" else None,
                        excerpt=sections.get("Scenario", ""),
                        confidence=0.95,
                    )
                ],
                related_ids=applies_to,
                example_sections=sections,
                sort_order=900,
            )
        )
    return documents


def parse_settings_changes(markdown_text: str) -> list[dict]:
    sections = []
    current = None
    current_bucket = None
    for raw_line in markdown_text.splitlines():
        line = raw_line.rstrip()
        title_match = re.match(r"^\*\*(.+)\*\*$", line.strip())
        if title_match:
            title = normalize_ws(title_match.group(1))
            title = re.sub(r"^\d+\.\s*", "", title).strip()
            current = {"title": title, "change_notes": [], "needs_confirmation": [], "legacy_rules": []}
            sections.append(current)
            current_bucket = None
            continue
        label = normalize_ws(line.rstrip(":"))
        if label in {"Change Notes", "Needs Confirmation", "Legacy Rules Not In Current Rulebook"}:
            current_bucket = {
                "Change Notes": "change_notes",
                "Needs Confirmation": "needs_confirmation",
                "Legacy Rules Not In Current Rulebook": "legacy_rules",
            }[label]
            continue
        if current and current_bucket and line.strip().startswith("- "):
            current[current_bucket].append(normalize_ws(line.strip()[2:]))
    return sections


def group_starters_by_season(rows: list[dict]) -> dict[int, list[dict]]:
    grouped = defaultdict(list)
    for row in rows:
        season = coerce_season(row.get("season"))
        if season is None:
            continue
        grouped[season].append(
            {"position": normalize_ws(row.get("position_name")), "limit": normalize_ws(row.get("limit_range"))}
        )
    for season in grouped:
        grouped[season] = sorted(grouped[season], key=lambda item: item["position"])
    return dict(grouped)


def parse_mfl_manifest_seasons(manifest_payload: dict) -> list[int]:
    seasons = []
    for season_info in manifest_payload.get("seasons", []):
        season = coerce_season(season_info.get("season"))
        if season is not None:
            seasons.append(season)
    if CURRENT_SEASON not in seasons:
        seasons.append(CURRENT_SEASON)
    return sorted(dict.fromkeys(seasons))


def parse_all_rules_lookup(all_rules_path: Path) -> dict[str, dict]:
    if not all_rules_path.exists():
        return {}
    root = ET.fromstring(read_text(all_rules_path))
    lookup = {}
    for rule in root.findall("./rule"):
        abbreviation = normalize_ws(rule.findtext("abbreviation"))
        if not abbreviation:
            continue
        lookup[abbreviation] = {
            "short": normalize_ws(rule.findtext("shortDescription")),
            "detail": normalize_ws(rule.findtext("detailedDescription")),
        }
    return lookup


def parse_league_snapshot(path: Path, season: int) -> dict | None:
    if not path.exists():
        return None
    root = ET.fromstring(read_text(path))
    starters_node = root.find("./starters")
    roster_limits_node = root.find("./rosterLimits")
    divisions_node = root.find("./divisions")
    starter_positions = []
    for position in starters_node.findall("./position") if starters_node is not None else []:
        starter_positions.append(
            {
                "position": normalize_ws(position.attrib.get("name")),
                "limit": normalize_ws(position.attrib.get("limit")),
            }
        )
    roster_limits = []
    for position in roster_limits_node.findall("./position") if roster_limits_node is not None else []:
        roster_limits.append(
            {
                "position": normalize_ws(position.attrib.get("name")),
                "limit": normalize_ws(position.attrib.get("limit")),
            }
        )
    return {
        "season": season,
        "league_name": normalize_ws(root.attrib.get("name")),
        "league_id": normalize_ws(root.attrib.get("id")),
        "base_url": normalize_ws(root.attrib.get("baseURL")),
        "salary_cap_amount": normalize_ws(root.attrib.get("salaryCapAmount")),
        "roster_size": parse_int(root.attrib.get("rosterSize")),
        "injured_reserve": parse_int(root.attrib.get("injuredReserve")),
        "taxi_squad": parse_int(root.attrib.get("taxiSquad")),
        "start_week": parse_int(root.attrib.get("startWeek")),
        "end_week": parse_int(root.attrib.get("endWeek")),
        "last_regular_season_week": parse_int(root.attrib.get("lastRegularSeasonWeek")),
        "trade_expiration_days": parse_int(root.attrib.get("defaultTradeExpirationDays")),
        "waiver_type": normalize_ws(root.attrib.get("currentWaiverType")),
        "divisions_count": parse_int(divisions_node.attrib.get("count")) if divisions_node is not None else None,
        "starters_count": parse_int(starters_node.attrib.get("count")) if starters_node is not None else None,
        "idp_starters_count": parse_int(starters_node.attrib.get("idp_starters")) if starters_node is not None else None,
        "starter_positions": starter_positions,
        "starters": {"positions": starter_positions},
        "roster_limits": roster_limits,
        "source_file": str(path),
    }


def row_points_text(rule_node: ET.Element) -> str:
    points = normalize_ws(rule_node.findtext("points"))
    threshold = normalize_ws(rule_node.findtext("thresholdPoints"))
    if threshold:
        return f"{points} (threshold {threshold})"
    return points


def normalize_positions(value: str) -> list[str]:
    return [position.strip() for position in value.split("|") if position.strip()]


def scoring_group_for_row(row: dict) -> str:
    event = row["event"]
    positions = set(normalize_positions(row["positions_raw"]))
    if event in RETURN_EVENTS:
        return "Return Yardage"
    if event in SPECIAL_EVENTS or positions <= SPECIAL_POSITIONS:
        return "Special Teams"
    if event in DEFENSIVE_EVENTS or (positions and positions <= DEFENSIVE_POSITIONS):
        return "Defense / IDP"
    return "Offense"


def is_bonus_row(row: dict) -> bool:
    points = row["points"]
    return bool(row.get("threshold_points")) or row["range"] not in {
        "0-99",
        "0-49",
        "0-10",
        "0-20",
        "0-25",
        "0-100",
        "-50-999",
    } or "/" in points


def is_position_specific_row(row: dict) -> bool:
    positions = set(normalize_positions(row["positions_raw"]))
    return positions != ALL_RULE_POSITIONS


def parse_rules_snapshot(path: Path, season: int, all_rules_lookup: dict[str, dict]) -> list[dict]:
    if not path.exists():
        return []
    root = ET.fromstring(read_text(path))
    rows = []
    for position_rules in root.findall("./positionRules"):
        positions_raw = normalize_ws(position_rules.attrib.get("positions"))
        positions_text = "/".join(normalize_positions(positions_raw))
        for rule in position_rules.findall("./rule"):
            event = normalize_ws(rule.findtext("event"))
            details = all_rules_lookup.get(event, {})
            rows.append(
                {
                    "season": season,
                    "positions_raw": positions_raw,
                    "positions": positions_text,
                    "event": event,
                    "range": normalize_ws(rule.findtext("range")),
                    "points": row_points_text(rule),
                    "threshold_points": normalize_ws(rule.findtext("thresholdPoints")),
                    "short_description": details.get("short") or details.get("detail") or event,
                    "detail_description": details.get("detail") or "",
                    "group": scoring_group_for_row(
                        {
                            "positions_raw": positions_raw,
                            "event": event,
                            "range": normalize_ws(rule.findtext("range")),
                            "points": row_points_text(rule),
                        }
                    ),
                    "source_type": "mfl_live_setting" if season == CURRENT_SEASON else "historical_reference",
                }
            )
    return rows


def scoring_groups(rows: list[dict]) -> dict[str, list[dict]]:
    groups = {
        "Offense": [],
        "Defense / IDP": [],
        "Special Teams": [],
        "Return Yardage": [],
        "Bonus Scoring": [],
        "Position-Specific Scoring": [],
    }
    for row in rows:
        groups[row["group"]].append(row)
        if is_bonus_row(row):
            groups["Bonus Scoring"].append(row)
        if is_position_specific_row(row):
            groups["Position-Specific Scoring"].append(row)
    for name in groups:
        groups[name] = sorted(
            groups[name],
            key=lambda row: (row["event"], row["positions"], row["range"], row["points"]),
        )
    return groups


def rules_signature(row: dict) -> str:
    return "|".join(
        [
            row["positions_raw"],
            row["event"],
            row["range"],
            row["points"],
            row.get("threshold_points") or "",
        ]
    )


def build_scoring_diffs(rules_by_season: dict[int, list[dict]]) -> dict[int, dict]:
    diffs = {}
    seasons = sorted(rules_by_season)
    previous_signatures = None
    for season in seasons:
        current_rows = rules_by_season[season]
        current_signatures = {rules_signature(row): row for row in current_rows}
        if previous_signatures is None:
            previous_signatures = current_signatures
            continue
        added = [current_signatures[key] for key in current_signatures.keys() - previous_signatures.keys()]
        removed = [previous_signatures[key] for key in previous_signatures.keys() - current_signatures.keys()]
        if added or removed:
            diffs[season] = {
                "added": sorted(added, key=lambda row: (row["event"], row["positions"], row["range"])),
                "removed": sorted(removed, key=lambda row: (row["event"], row["positions"], row["range"])),
            }
        previous_signatures = current_signatures
    return diffs


def historical_settings_rows_to_snapshots(rows: list[dict], starters_by_season: dict[int, list[dict]]) -> list[dict]:
    snapshots = []
    for row in rows:
        season = coerce_season(row.get("season"))
        if season is None:
            continue
        snapshots.append(
            {
                "season": season,
                "league_name": normalize_ws(row.get("league_name")),
                "league_id": normalize_ws(row.get("league_id")),
                "base_url": normalize_ws(row.get("base_url")),
                "salary_cap_amount": normalize_ws(row.get("salary_cap_amount")),
                "roster_size": parse_int(row.get("roster_size")),
                "taxi_squad": parse_int(row.get("taxi_squad")),
                "injured_reserve": parse_int(row.get("injured_reserve")),
                "start_week": parse_int(row.get("start_week")),
                "end_week": parse_int(row.get("end_week")),
                "last_regular_season_week": parse_int(row.get("last_regular_season_week")),
                "divisions_count": parse_int(row.get("divisions_count")),
                "starters_count": parse_int(row.get("starters_count")),
                "idp_starters_count": parse_int(row.get("idp_starters_count")),
                "starter_positions": starters_by_season.get(season, []),
                "starters": {"positions": starters_by_season.get(season, [])},
                "roster_limits": [],
                "waiver_type": normalize_ws(row.get("h2h")),
                "trade_expiration_days": None,
                "source_file": str(LEAGUE_SETTINGS_PATH),
            }
        )
    return sorted(snapshots, key=lambda snapshot: snapshot["season"])


def index_current_rulebook_sections(struct_payload: dict) -> dict[str, dict]:
    sections = {}
    for key, value in struct_payload.items():
        title = normalize_ws(value.get("title"))
        sections[key] = value
        sections[title] = value
    return sections


def build_front_matter_docs(metadata: dict) -> list[dict]:
    docs = []
    docs.append(
        make_document(
            "CUR-RULEBOOK",
            kind="rule",
            topic="Current Rules",
            subcategory="Rulebook Overview",
            title="Official Rule Book",
            summary="The UPS Salary Cap Dynasty League rule book is the primary written authority for league operations.",
            body_md=markdown_sections(
                [
                    (
                        "What this document governs",
                        [
                            "League structure, season flow, roster rules, acquisitions, trades, contracts, league finance, and penalties.",
                            "Current written rulebook narrative is the top written source unless a later commissioner-approved clarification replaces it.",
                        ],
                    ),
                    (
                        "How to use it",
                        [
                            "Use Current Rules and Contracts for day-to-day owner actions.",
                            "Use Scoring & Starters for live MFL-enforced scoring and lineup settings.",
                            "Use History for change tracking and Needs Confirmation for unresolved conflicts.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("rulebook governance authority current rules"),
            source_refs=[source_ref("rulebook-text", "written_rulebook", RULEBOOK_TEXT, excerpt="official guide for all league operations", confidence=0.98)],
            sort_order=1,
        )
    )
    docs.append(
        make_document(
            "CUR-METADATA",
            kind="rule",
            topic="Current Rules",
            subcategory="Rulebook Overview",
            title="Commissioner and Rulebook Version",
            summary=f"Commissioner: {metadata.get('commissioner')}. Version: {metadata.get('version')}. Last updated: {metadata.get('last_updated')}.",
            body_md=markdown_sections(
                [
                    (
                        "Current written source",
                        [
                            f"Commissioner: {metadata.get('commissioner') or 'Unknown'}",
                            f"Version: {metadata.get('version') or 'Unknown'}",
                            f"Last updated: {metadata.get('last_updated') or 'Unknown'}",
                        ],
                    ),
                    (
                        "Owner note",
                        [
                            "When the written rulebook and live MFL platform settings disagree, this rulebook keeps both visible and flags the difference instead of silently picking one.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize(metadata.values(), "commissioner version updated"),
            source_refs=[source_ref("rulebook-metadata", "written_rulebook", RULEBOOK_TEXT, excerpt=f"Commissioner: {metadata.get('commissioner')}", confidence=0.98)],
            sort_order=2,
        )
    )
    if metadata.get("mission_statement"):
        docs.append(
            make_document(
                "CUR-MISSION",
                kind="rule",
                topic="Current Rules",
                subcategory="Rulebook Overview",
                title="League Mission and Owner Expectations",
                summary="The league positions itself as a highly engaged dynasty league that expects active participation and competitive integrity.",
                body_md=markdown_sections(
                    [
                        ("Mission statement", [metadata["mission_statement"]]),
                        (
                            "What it means for owners",
                            [
                                "Owners are expected to stay engaged year-round, communicate, respond to trades, and keep competitive lineups.",
                                "Actions that damage league integrity can lead to commissioner action or league removal.",
                            ],
                        ),
                    ]
                ),
                status="current",
                authority="written_rulebook",
                effective_from_season=CURRENT_SEASON,
                effective_to_season=None,
                keywords=keywordize(metadata["mission_statement"], "owner expectations mission"),
                source_refs=[source_ref("rulebook-mission", "written_rulebook", RULEBOOK_TEXT, excerpt=metadata["mission_statement"], confidence=0.9)],
                sort_order=3,
            )
        )
    return docs


def build_current_rule_docs(struct_sections: dict) -> list[dict]:
    section_specs = [
        (
            "CUR-OVERVIEW",
            "League Overview and Governance",
            "Current Rules",
            "League Overview",
            ["1"],
            "League size, divisional structure, owner expectations, membership, and commissioner authority.",
        ),
        (
            "CUR-CALENDAR",
            "League Calendar and Deadlines",
            "Current Rules",
            "League Calendar",
            ["2"],
            "The yearly calendar for season rollover, rookie draft, auction, contract deadline, trade deadline, and playoffs.",
        ),
        (
            "ROSTER-CORE",
            "Active Roster, IR, and Taxi Squad",
            "Roster / Lineup",
            "Roster Management",
            ["3"],
            "How owners manage roster size, IR, and taxi squad eligibility across the season.",
        ),
        (
            "ROSTER-LINEUP",
            "Starting Lineup and Superflex Governance",
            "Roster / Lineup",
            "Roster Management",
            ["3"],
            "Current lineup structure, lineup submission timing, and the 3-starting-QB roster restriction.",
        ),
        (
            "ACQ-ROOKIE-DRAFT",
            "Rookie Draft",
            "Acquisition Rules",
            "Rookie Draft",
            ["4"],
            "How the rookie draft works, what each round means, and which picks are taxi eligible.",
        ),
        (
            "ACQ-AUCTION",
            "Free Agent Auction",
            "Acquisition Rules",
            "Free Agent Auction",
            ["5"],
            "How the summer auction starts, when the roster lock hits, and how the auction salary floor works.",
        ),
        (
            "ACQ-EXPIRED-ROOKIE",
            "Expired Rookie Auction",
            "Acquisition Rules",
            "Expired Rookie Auction",
            ["6"],
            "How expiring rookie contracts move into the expired rookie auction workflow.",
        ),
        (
            "ACQ-WAIVERS",
            "Waivers and Sunday FCFS",
            "Acquisition Rules",
            "Waivers",
            ["7"],
            "Blind-bid waivers, Sunday FCFS, and owner responsibilities after a successful claim.",
        ),
        (
            "TRADES-OVERVIEW",
            "Trades and Compliance",
            "Trades",
            "Trades",
            ["8"],
            "Trade eligibility, trade review, trade comments, and post-trade roster and contract compliance.",
        ),
        (
            "FINANCE",
            "League Finance",
            "League Finance & Penalties",
            "League Financing",
            ["10"],
            "League dues, payment timing, payouts, and fee handling.",
        ),
        (
            "PENALTIES",
            "Penalties and Miscellaneous Rules",
            "League Finance & Penalties",
            "Penalties and Miscellaneous League Rules",
            ["11"],
            "Penalty placeholders, cap-floor language, and miscellaneous rules like retired-player handling.",
        ),
    ]

    docs = []
    for index, (doc_id, title, topic, subcategory, section_keys, summary) in enumerate(section_specs, start=10):
        subsections = []
        for section_key in section_keys:
            section = struct_sections.get(section_key)
            if not section:
                continue
            section_title = normalize_ws(section.get("title"))
            section_subsections = section.get("subsections") or []
            if doc_id == "ROSTER-CORE":
                section_subsections = [item for item in section_subsections if item.get("title", "").startswith(("3.1", "3.2", "3.3"))]
            elif doc_id == "ROSTER-LINEUP":
                section_subsections = [item for item in section_subsections if item.get("title", "").startswith(("3.4", "3.5"))]
            subsections.extend(section_subsections)
            if doc_id in {"ACQ-AUCTION", "ACQ-EXPIRED-ROOKIE", "ACQ-WAIVERS", "TRADES-OVERVIEW", "FINANCE", "PENALTIES"}:
                section_title = section_title
        body_md = subsection_markdown(subsections)
        section_titles = [normalize_ws(struct_sections.get(key, {}).get("title")) for key in section_keys]
        refs = [
            source_ref(
                f"{doc_id}-section",
                "written_rulebook",
                RULEBOOK_TEXT,
                season=CURRENT_SEASON,
                excerpt=summary,
                confidence=0.94,
            )
        ]
        docs.append(
            make_document(
                doc_id,
                kind="rule",
                topic=topic,
                subcategory=subcategory,
                title=title,
                summary=summary,
                body_md=body_md,
                status="current",
                authority="written_rulebook",
                effective_from_season=CURRENT_SEASON,
                effective_to_season=None,
                keywords=keywordize(title, summary, section_titles),
                source_refs=refs,
                workflow_refs=[],
                sort_order=index,
            )
        )

    roster_core = next(doc for doc in docs if doc["id"] == "ROSTER-CORE")
    roster_core["workflow_refs"] = ["Roster Review", "IR Management", "Taxi Squad Demotion"]
    roster_lineup = next(doc for doc in docs if doc["id"] == "ROSTER-LINEUP")
    roster_lineup["workflow_refs"] = ["Weekly Lineup Submission", "Starter Compliance Check"]
    auction_doc = next(doc for doc in docs if doc["id"] == "ACQ-AUCTION")
    auction_doc["workflow_refs"] = ["Auction Prep", "Auction Contract Submission"]
    waivers_doc = next(doc for doc in docs if doc["id"] == "ACQ-WAIVERS")
    waivers_doc["workflow_refs"] = ["Blind Bid Waiver Run", "Sunday FCFS Pickup"]
    trades_doc = next(doc for doc in docs if doc["id"] == "TRADES-OVERVIEW")
    trades_doc["workflow_refs"] = ["Trade Review", "Trade Salary Check", "Extension-in-Trade Review"]
    return docs


def build_contract_docs() -> list[dict]:
    contract_source_refs = [
        source_ref("rulebook-contracts", "written_rulebook", RULEBOOK_TEXT, season=CURRENT_SEASON, excerpt="9.1 Glossary of Contract Terms", confidence=0.96),
        source_ref("contract-guide", "written_rulebook", CONTRACT_GUIDE_TEXT, season=CURRENT_SEASON, excerpt="Contract Rules", confidence=0.96),
    ]
    docs = [
        make_document(
            "C-TERMINOLOGY",
            kind="rule",
            topic="Contracts",
            subcategory="Contract Primer",
            title="Contract Primer and Core Terms",
            summary="The contract system is built around salary, years remaining, TCV, AAV, guarantees, and whether a player is on a rookie, veteran, waiver, or loaded deal.",
            body_md=markdown_sections(
                [
                    (
                        "Definition",
                        [
                            "Every UPS contract controls current salary, future cap exposure, and cut liability.",
                            "Owners should think in both yearly salary terms and total contract value before extending or restructuring any player.",
                        ],
                    ),
                    (
                        "Core terms",
                        [
                            "Salary: the player’s current-year salary.",
                            "Contract length: the total number of contract years currently on the player.",
                            "Years remaining: the number of seasons left on the deal.",
                            "TCV: total contract value across the remaining years after any extension or restructure.",
                            "AAV: the evenly distributed yearly value used as the extension baseline.",
                        ],
                    ),
                    (
                        "Current baseline rules",
                        [
                            "Maximum contract length is 3 years at any time.",
                            "Most non-waiver contracts carry a 75% guarantee.",
                            "The first year of any multi-year contract must carry at least 20% of the TCV.",
                        ],
                    ),
                    (
                        "Why owners care",
                        [
                            "These terms drive Contract Command Center calculations, cap planning, trade review, and penalty exposure.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("contracts", "tcv", "aav", "years remaining", "guarantee"),
            source_refs=contract_source_refs,
            example_ids=["EX-CONTRACT-1", "EX-CONTRACT-2", "EX-CONTRACT-7"],
            workflow_refs=["Contract Command Center", "Roster Contract Review"],
            sort_order=100,
        ),
        make_document(
            "C-TYPES",
            kind="rule",
            topic="Contracts",
            subcategory="Contract Types",
            title="Contract Types and Eligibility",
            summary="UPS distinguishes rookie, veteran, waiver-wire, loaded, auction, and in-season multi-year contracts, and each type changes what an owner can do next.",
            body_md=markdown_sections(
                [
                    (
                        "Rookie contracts",
                        [
                            "Rookies drafted in the rookie draft are assigned 3 contract years by default.",
                            "Rookie deals stay evenly distributed and cannot be restructured until they expire into veteran status.",
                            "Rookies picked up on waivers start as short-term pickups and convert to rookie status later if retained.",
                        ],
                    ),
                    (
                        "Veteran and waiver contracts",
                        [
                            "Veteran is the standard contract type for players acquired outside their rookie year.",
                            "WW contracts are the default 1-year contracts for players added after the contract deadline.",
                            "WW contracts can later convert into veteran-style multi-year deals through MYM or extension workflows.",
                        ],
                    ),
                    (
                        "Loaded contracts",
                        [
                            "Front-loaded contracts put more than the AAV into year one.",
                            "Back-loaded contracts put less than the AAV into year one, but year one still must reach the 20% TCV floor.",
                            "Loaded structures are used in auctions and restructures to move cap burden across years without changing TCV.",
                        ],
                    ),
                    (
                        "Owner impact",
                        [
                            "Contract type determines which buttons and previews matter in Contract Command Center and whether current-season salary can change.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("rookie veteran waiver ww loaded auction contract types"),
            source_refs=contract_source_refs,
            related_ids=["C-AUCTION-CONTRACTS", "C-MYM", "C-RESTRUCTURES"],
            example_ids=["EX-CONTRACT-3", "EX-CONTRACT-4", "EX-CONTRACT-5"],
            workflow_refs=["Contract Command Center", "Auction Contract Submission"],
            sort_order=101,
        ),
        make_document(
            "C-LIMITS",
            kind="rule",
            topic="Contracts",
            subcategory="Contract Limits",
            title="Contract Limits and Compliance Caps",
            summary="The contract system caps max years, max loaded deals, and max 3-year non-rookie inventory, so owners need to check roster-level compliance before submitting changes.",
            body_md=markdown_sections(
                [
                    (
                        "Roster-level limits",
                        [
                            "Maximum contract length for any player is 3 years.",
                            "Maximum 3-year contracts is 6, excluding 3-year rookie contracts in the current written rulebook.",
                            "Maximum loaded contracts is 5 total front-loaded or back-loaded deals.",
                        ],
                    ),
                    (
                        "Timing rule",
                        [
                            "The contract guide also states teams may carry no more than 6 non-rookie contracts from the contract deadline through the end of the season.",
                            "If a proposed transaction would push a team over one of these caps, the owner must resolve that before the move is accepted.",
                        ],
                    ),
                    (
                        "Compliance check",
                        [
                            "Review the roster-wide contract mix before auction submissions, restructures, and trade-linked extensions.",
                            "When a move would solve a salary-floor issue, owners still need the structure to remain compliant with TCV and first-year rules.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("contract limits loaded cap three year contracts"),
            source_refs=contract_source_refs,
            related_ids=["C-RESTRUCTURES", "C-AUCTION-CONTRACTS"],
            example_ids=["EX-CONTRACT-4", "EX-CONTRACT-10"],
            workflow_refs=["Roster Contract Review"],
            sort_order=102,
        ),
        make_document(
            "C-AUCTION-CONTRACTS",
            kind="rule",
            topic="Contracts",
            subcategory="Auction Contracts",
            title="Auction Contracts and Loaded Structures",
            summary="Players acquired in the summer auction, expired rookie auction, or pre-deadline waivers can take multi-year auction contracts, including even, front-loaded, or back-loaded splits.",
            body_md=markdown_sections(
                [
                    (
                        "Eligibility",
                        [
                            "Players acquired in the free agent auction, expired rookie auction, or waivers before the contract deadline can receive a multi-year auction contract.",
                            "The owner can choose a 2-year or 3-year deal if they want more control than the default 1-year contract.",
                        ],
                    ),
                    (
                        "Structure choices",
                        [
                            "Even distribution creates a veteran contract with the same salary each year.",
                            "Front-loaded and back-loaded splits are allowed if the total still equals the TCV.",
                            "Back-loaded deals must still satisfy the 20% year-one minimum.",
                        ],
                    ),
                    (
                        "Default outcome",
                        [
                            "If no multi-year auction contract is submitted, the player defaults to a 1-year deal.",
                            "The default type is veteran unless the player is a rookie and later picks up rookie status.",
                        ],
                    ),
                    (
                        "Cap impact",
                        [
                            "Loading more salary into year one can help meet the salary floor.",
                            "Back-loading can reduce current cap pressure but pushes more risk into later seasons.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("auction contracts front-loaded back-loaded veteran contract"),
            source_refs=contract_source_refs,
            related_ids=["ACQ-AUCTION", "ACQ-EXPIRED-ROOKIE", "C-LIMITS"],
            example_ids=["EX-CONTRACT-3", "EX-CONTRACT-4", "EX-CONTRACT-10"],
            workflow_refs=["Auction Contract Submission", "Auction Salary Planning"],
            sort_order=103,
        ),
        make_document(
            "C-EXTENSIONS",
            kind="rule",
            topic="Contracts",
            subcategory="Extensions",
            title="Contract Extensions",
            summary="Extensions apply to players entering the final year of their deal and use fixed raise schedules that reset TCV and guarantees for the remaining contract.",
            body_md=markdown_sections(
                [
                    (
                        "Eligibility",
                        [
                            "Players entering the final year of their contract can be extended up to the contract deadline date.",
                            "Certain pre-deadline rookie and preseason waiver pickups can be extended by the end of Week 4 if they missed the original deadline and MYM window.",
                            "Players acquired by trade in the final year of their deal must be extended within 4 weeks of acquisition.",
                        ],
                    ),
                    (
                        "Extension math",
                        [
                            "Schedule 1 positions (QB/RB/WR/TE) add $10K for a 1-year extension and $20K for a 2-year extension.",
                            "Schedule 2 positions (DB/LB/DL/K/P) add $3K for a 1-year extension and $5K for a 2-year extension.",
                            "The extension resets TCV and guarantee math to the remaining years after the move.",
                        ],
                    ),
                    (
                        "Cap impact",
                        [
                            "Extensions increase future salary obligations and future penalty exposure.",
                            "Because the new TCV replaces the old one, owners should always review the new guarantee amount before finalizing.",
                        ],
                    ),
                    (
                        "Workflow rule",
                        [
                            "If an extension is attached to a trade, the terms must be documented in trade comments or with proof of discussion before approval.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("contract extension schedule 1 schedule 2 tcv aav"),
            source_refs=contract_source_refs,
            related_ids=["TRADES-OVERVIEW", "C-TRADE-HANDLING"],
            example_ids=["EX-CONTRACT-1", "EX-CONTRACT-2", "EX-CONTRACT-8"],
            workflow_refs=["Contract Extension", "Trade Review"],
            sort_order=104,
        ),
        make_document(
            "C-MYM",
            kind="rule",
            topic="Contracts",
            subcategory="Mid-Year Multi",
            title="Mid-Year Multi (MYM)",
            summary="MYM is the in-season retention tool that converts a 1-year contract into a multi-year deal without changing the current-season salary.",
            body_md=markdown_sections(
                [
                    (
                        "What it does",
                        [
                            "MYM converts a 1-year contract into a multi-year contract at the same current salary.",
                            "If the contract is a WW deal, MYM converts it into a veteran contract.",
                        ],
                    ),
                    (
                        "Eligibility and timing",
                        [
                            "Owners are allowed a maximum of 3 MYMs per season.",
                            "Players acquired in the auction or preseason waivers who missed pre-season contracts can be given a MYM through the end of NFL Week 2.",
                            "Players acquired in-season on waivers can be given a MYM within 2 weeks of acquisition.",
                        ],
                    ),
                    (
                        "Restrictions",
                        [
                            "MYM deals are not eligible to be loaded.",
                            "The current-season salary may not be modified when the MYM is submitted.",
                        ],
                    ),
                    (
                        "Why owners use it",
                        [
                            "MYM preserves a breakout player without forcing an immediate extension raise into the current season.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("mym mid year multi in-season contract"),
            source_refs=contract_source_refs,
            related_ids=["C-TYPES", "C-EXTENSIONS"],
            example_ids=["EX-CONTRACT-5"],
            workflow_refs=["Mid-Year Multi Submission", "Waiver Pickup Review"],
            sort_order=105,
        ),
        make_document(
            "C-RESTRUCTURES",
            kind="rule",
            topic="Contracts",
            subcategory="Restructures",
            title="Restructures and Salary Reallocation",
            summary="Restructures change how the remaining TCV is distributed across the remaining years without changing what the contract is worth in total.",
            body_md=markdown_sections(
                [
                    (
                        "What triggers a restructure",
                        [
                            "Restructures are used in the pre-season for contracts with multiple years remaining.",
                            "The contract guide limits restructures to 3 per season.",
                            "Beginning in 2019, mid-season acquisitions no longer receive restructure allowances.",
                        ],
                    ),
                    (
                        "Math rules",
                        [
                            "A restructure resets the remaining TCV to the new remaining salary plan.",
                            "Owners may split the remaining TCV evenly or create front-loaded or back-loaded years.",
                            "Year one still must satisfy the 20% TCV minimum if the deal is back-loaded.",
                        ],
                    ),
                    (
                        "Cap impact",
                        [
                            "Restructures change when cap pain hits, not how much total cap pain exists.",
                            "A restructure can help address salary-floor, auction, or short-term compliance problems while pushing salary into later seasons.",
                        ],
                    ),
                    (
                        "Owner caution",
                        [
                            "Because guarantee math follows the new remaining contract, restructures can make later cuts more expensive even when they help today.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("restructure loaded contract salary reallocation"),
            source_refs=contract_source_refs,
            related_ids=["C-AUCTION-CONTRACTS", "C-GUARANTEES"],
            example_ids=["EX-CONTRACT-4", "EX-CONTRACT-6", "EX-CONTRACT-10"],
            workflow_refs=["Contract Restructure", "Salary Floor Planning"],
            sort_order=106,
        ),
        make_document(
            "C-GUARANTEES",
            kind="rule",
            topic="Contracts",
            subcategory="Guarantees and Penalties",
            title="Guarantees, Earned Salary, and Cap Penalties",
            summary="Most non-waiver contracts are 75% guaranteed, so cut timing and earned-salary milestones matter as much as the raw salary number.",
            body_md=markdown_sections(
                [
                    (
                        "Guarantee baseline",
                        [
                            "The majority of contracts carry a 75% TCV guarantee requirement.",
                            "Salary is earned on a month-based schedule: 0% before October, then 25%, 50%, and 75% earned on October 1, November 1, and December 1.",
                        ],
                    ),
                    (
                        "Exceptions",
                        [
                            "1-year veteran or WW contracts under $5K are cap-free cuts with 0% guarantee.",
                            "Taxi-eligible players carry no guarantee until promotion.",
                            "WW contracts at $5K or more are treated as 65% earned and create a 35% cap penalty if cut before rollover.",
                        ],
                    ),
                    (
                        "Penalty formula",
                        [
                            "Cap penalty is calculated as guaranteed value minus earned salary.",
                            "Penalties after the start of the auction are accrued to the next season, while off-season penalties before the roster lock apply to the current season.",
                        ],
                    ),
                    (
                        "Practical meaning",
                        [
                            "Cutting early protects roster space but usually creates the largest cap hit.",
                            "Keeping a player until more salary is earned can materially reduce the penalty.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("guarantee earned salary cap penalty 75%"),
            source_refs=contract_source_refs,
            related_ids=["PENALTIES"],
            example_ids=["EX-CONTRACT-7", "EX-CONTRACT-9"],
            workflow_refs=["Cap Penalty Review", "Cut Candidate Review"],
            sort_order=107,
        ),
        make_document(
            "C-TRADE-HANDLING",
            kind="rule",
            topic="Contracts",
            subcategory="Trade Handling",
            title="Trade Salary Handling and Extension Language",
            summary="Trades can include salary movement and extension language, but both must be documented and the teams must remain roster and cap compliant immediately after the deal.",
            body_md=markdown_sections(
                [
                    (
                        "What must be documented",
                        [
                            "Trade comments need to show the players, assets, any salary being moved, and any extension terms agreed to as part of the deal.",
                            "Salary-only trades are not allowed; every trade must include an actual asset.",
                        ],
                    ),
                    (
                        "Compliance timing",
                        [
                            "Teams are expected to move back into roster and contract compliance immediately after the trade.",
                            "If the trade creates a contract-compliance issue, the teams have 24 hours to fix it.",
                        ],
                    ),
                    (
                        "Extension note",
                        [
                            "If the outgoing team is agreeing to apply an extension as part of the trade, the terms must be stated in comments or supported with proof of discussion.",
                        ],
                    ),
                    (
                        "Why owners care",
                        [
                            "Trade War Room can combine salary movement with extension planning, so owners need one place to review the combined rule set.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("trade salary extension comments compliance"),
            source_refs=contract_source_refs + [source_ref("trade-section", "written_rulebook", RULEBOOK_TEXT, season=CURRENT_SEASON, excerpt="Extensions and Salary Compliance", confidence=0.94)],
            related_ids=["TRADES-OVERVIEW", "C-EXTENSIONS"],
            example_ids=["EX-CONTRACT-8"],
            workflow_refs=["Trade Review", "Trade Salary Check"],
            sort_order=108,
        ),
        make_document(
            "C-HISTORICAL-LEGACY",
            kind="rule",
            topic="Contracts",
            subcategory="Historical Contract Notes",
            title="Legacy Contract Systems and Grandfathered Rules",
            summary="Older UPS contract eras used different cap-penalty formulas, tag systems, and grandfathered rules, so owners should separate historical memory from the current system.",
            body_md=markdown_sections(
                [
                    (
                        "Historical items owners still remember",
                        [
                            "Older rules used a 20% remaining-salary cap-hit model instead of the current guarantee schedule.",
                            "Grandfathered contracts were marked GF until touched by an extension, restructure, or release.",
                            "Legacy franchise and transition tag systems existed in older eras but are not present in the current written rulebook.",
                        ],
                    ),
                    (
                        "How to treat them now",
                        [
                            "Use these items as historical context only unless a commissioner-approved clarification revives or confirms them.",
                            "If an owner believes a legacy exception still applies, it should remain a Needs Confirmation item until resolved.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("grandfathered gf legacy tags historical contract rules"),
            source_refs=contract_source_refs + [source_ref("settings-changes-contracts", "historical_reference", SETTINGS_CHANGES_PATH, excerpt="Legacy docs include franchise/transition tag systems", confidence=0.85)],
            related_ids=["H-TOPIC-CONTRACT-MANAGEMENT"],
            example_ids=["EX-CONTRACT-9"],
            workflow_refs=["Historical Rule Review"],
            sort_order=109,
        ),
    ]
    return docs


def build_glossary_docs() -> list[dict]:
    terms = [
        ("G-TCV", "TCV", "Total Contract Value. The total value of a contract across all remaining years.", ["Contract length multiplied by the salary structure across the remaining years.", "Extensions and restructures reset TCV to the remaining years after the move."]),
        ("G-AAV", "AAV", "Average Annual Value. The evenly distributed yearly baseline used when evaluating extensions and loaded splits.", ["AAV is the baseline comparison point for front-loaded and back-loaded structures.", "The UPS extension schedule adds new salary relative to the player’s current-year AAV context."]),
        ("G-EXTENSION", "Extension", "A move that adds 1 or 2 years to a player entering the final year of a contract.", ["Extensions use schedule-based raises and reset TCV and guarantees."]),
        ("G-RESTRUCTURE", "Restructure", "A move that changes the yearly allocation of salary across the remaining contract years.", ["Restructures do not exist to create free value; they move cap burden across years."]),
        ("G-MYM", "MYM", "Mid-Year Multi. An in-season conversion from a 1-year deal into a multi-year contract.", ["MYM keeps the current-season salary unchanged and is capped at 3 uses per season."]),
        ("G-WW", "WW Contract", "The default 1-year waiver-wire contract for players added after the contract deadline date.", ["WW contracts can later convert through MYM or extension workflows, subject to timing and guarantee rules."]),
        ("G-LOADED", "Loaded Contract", "A front-loaded or back-loaded multi-year contract structure.", ["Back-loaded deals still must put at least 20% of TCV in year one."]),
        ("G-GUARANTEE", "Guarantee", "The protected portion of a contract that still counts against the cap if the player is cut before enough salary has been earned.", ["The standard current guarantee is 75% of TCV for most non-waiver contracts."]),
        ("G-SALARY-FLOOR", "Salary Floor", "The minimum salary threshold an owner must reach by the end of the auction or contract deadline period.", ["Loaded deals are one of the main tools owners use to reach the floor without adding another player."]),
        ("G-STARTING-QBS", "3 Starting QBs Rule", "The current roster governance rule limiting teams to three starting quarterbacks after the contract deadline date.", ["Taxi exceptions exist for late-emerging starters, but promoted taxi QBs can count against the cap."]),
    ]
    docs = []
    for index, (doc_id, title, summary, bullets) in enumerate(terms, start=400):
        docs.append(
            make_document(
                doc_id,
                kind="glossary",
                topic="Glossary",
                subcategory="League Terms",
                title=title,
                summary=summary,
                body_md=markdown_sections([("Definition", [summary]), ("Owner Notes", bullets)]),
                status="current",
                authority="written_rulebook",
                effective_from_season=CURRENT_SEASON,
                effective_to_season=None,
                keywords=keywordize(title, summary, bullets),
                source_refs=[source_ref(doc_id, "written_rulebook", RULEBOOK_TEXT, season=CURRENT_SEASON, excerpt=summary, confidence=0.88)],
                sort_order=index,
            )
        )
    return docs


def scoring_doc(
    doc_id: str,
    title: str,
    summary: str,
    rows: list[dict],
    *,
    example_ids=None,
    related_ids=None,
    comparison_cards=None,
    sort_order=200,
):
    return make_document(
        doc_id,
        kind="scoring_rule",
        topic="Scoring & Starters",
        subcategory="Current Scoring",
        title=title,
        summary=summary,
        body_md=markdown_sections(
            [
                (
                    "How to read this table",
                    [
                        "Positions shows which lineup slots are affected.",
                        "Event is the MFL abbreviation.",
                        "Range and Points reflect the live MFL scoring rule for the current season.",
                    ],
                )
            ]
        ),
        status="current",
        authority="mfl_live_setting",
        effective_from_season=CURRENT_SEASON,
        effective_to_season=None,
        keywords=keywordize(title, summary, [row["event"] for row in rows]),
        source_refs=[source_ref(doc_id, "mfl_live_setting", GENERATED_ROOT / str(CURRENT_SEASON) / "rules.xml", season=CURRENT_SEASON, excerpt=summary, confidence=0.99)],
        related_ids=related_ids or [],
        example_ids=example_ids or [],
        table_rows=rows,
        comparison_cards=comparison_cards or [],
        sort_order=sort_order,
    )


def build_scoring_docs(current_settings: dict, current_groups: dict[str, list[dict]]) -> list[dict]:
    docs = [
        scoring_doc(
            "S-OFFENSE",
            "Current Offensive Scoring",
            "Live MFL scoring rows for passing, rushing, receiving, and offensive bonuses.",
            current_groups["Offense"],
            related_ids=["ROSTER-LINEUP"],
            sort_order=200,
        ),
        scoring_doc(
            "S-DEFENSE",
            "Current Defense / IDP Scoring",
            "Live MFL scoring rows for tackles, assists, sacks, and other IDP production.",
            current_groups["Defense / IDP"],
            sort_order=201,
        ),
        scoring_doc(
            "S-SPECIAL",
            "Current Special Teams Scoring",
            "Live MFL scoring rows for kickers and punters, including punt average and punts inside the 20.",
            current_groups["Special Teams"],
            example_ids=["EX-SCORING-1"],
            sort_order=202,
        ),
        scoring_doc(
            "S-RETURNS",
            "Current Return Yardage Scoring",
            "Live MFL scoring rows for punt-return and kick-return yardage.",
            current_groups["Return Yardage"],
            example_ids=["EX-SCORING-2"],
            sort_order=203,
        ),
        scoring_doc(
            "S-BONUS",
            "Bonus Scoring and Tiered Ranges",
            "Tiered rules and threshold-based bonuses that add extra points beyond simple per-unit scoring.",
            current_groups["Bonus Scoring"],
            sort_order=204,
        ),
        scoring_doc(
            "S-POSITION-SPECIFIC",
            "Position-Specific Scoring Rules",
            "Rules that apply only to certain position families, such as DB-only tackle rates or DT/DE splits.",
            current_groups["Position-Specific Scoring"],
            sort_order=205,
        ),
    ]

    docs.append(
        make_document(
            "S-STARTERS",
            kind="settings_snapshot",
            topic="Scoring & Starters",
            subcategory="Current Starters",
            title="Current Starter Slots and Lineup Ranges",
            summary="The live 2026 MFL settings use 18 starters with range-based position limits that encode the flex, superflex, and defensive-flex lineup.",
            body_md=markdown_sections(
                [
                    (
                        "Owner-facing lineup view",
                        [
                            "1 QB",
                            "2 RB",
                            "2 WR",
                            "1 TE",
                            "2 Flex",
                            "1 SuperFlex",
                            "1 K",
                            "1 P",
                            "2 DL",
                            "2 LB",
                            "2 DB",
                            "1 Defensive Flex",
                        ],
                    ),
                    (
                        "Platform encoding",
                        [
                            "MyFantasyLeague stores this lineup as position ranges rather than named flex slots.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="mfl_live_setting",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("starters lineup flex superflex idp", [row["position"] for row in current_settings.get("starter_positions", [])]),
            source_refs=[source_ref("current-league", "mfl_live_setting", current_settings.get("source_file"), season=CURRENT_SEASON, excerpt="starters count and positions", confidence=0.99)],
            table_rows=current_settings.get("starter_positions", []),
            related_ids=["ROSTER-LINEUP"],
            sort_order=206,
        )
    )
    docs.append(
        make_document(
            "S-GOVERNANCE",
            kind="rule",
            topic="Scoring & Starters",
            subcategory="Lineup Governance",
            title="Lineup Submission and Starter Governance",
            summary="Owners must submit valid lineups before kickoff, respect the 3-starting-QB roster rule, and stay within active roster requirements.",
            body_md=markdown_sections(
                [
                    (
                        "Lineup timing",
                        [
                            "Lineups must be submitted before the kickoff of the first game each week.",
                            "Players lock individually when their games start, so later players can still be moved until their own kickoff.",
                        ],
                    ),
                    (
                        "Quarterback roster rule",
                        [
                            "After the contract deadline date, teams can carry only three starting quarterbacks on the roster.",
                            "Late-emerging taxi quarterbacks can create exceptions, but promoted taxi QBs can count against the cap.",
                        ],
                    ),
                    (
                        "Roster integrity",
                        [
                            "Owners still need to meet the active roster minimum and maximum rules described in Roster Management.",
                        ],
                    ),
                ]
            ),
            status="current",
            authority="written_rulebook",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("lineup kickoff 3 starting qbs roster compliance"),
            source_refs=[source_ref("rulebook-lineup", "written_rulebook", RULEBOOK_TEXT, season=CURRENT_SEASON, excerpt="Starting Lineup Requirements", confidence=0.94)],
            related_ids=["ROSTER-LINEUP", "S-STARTERS"],
            sort_order=207,
        )
    )

    comparison_cards = [
        {
            "label": "Roster Size",
            "platform_setting": f"MFL 2026 rosterSize = {current_settings.get('roster_size')}",
            "written_rule": "Written rulebook uses active-roster language of 27 minimum, 30 after contract deadline, and 35 during the auction.",
            "status": "Conflict: platform total roster size and written active-roster policy are not the same concept and should stay separately flagged.",
        },
        {
            "label": "Starter Encoding",
            "platform_setting": "MFL stores lineup limits as QB 1-2, RB 2-5, WR 2-5, TE 1-4, PK 1, PN 1, DT+DE 2-3, LB 2-3, CB+S 2-3.",
            "written_rule": "Written rulebook describes fixed slots plus flex, superflex, and defensive flex.",
            "status": "Aligned conceptually, but encoded differently.",
        },
        {
            "label": "Waiver Mode",
            "platform_setting": f"Live waiver type = {current_settings.get('waiver_type')}",
            "written_rule": "Written rulebook describes blind-bid waivers plus Sunday FCFS.",
            "status": "Generally aligned.",
        },
        {
            "label": "Trade Expiration",
            "platform_setting": f"MFL default trade expiration = {current_settings.get('trade_expiration_days')} days",
            "written_rule": "Written rulebook emphasizes immediate processing and post-review rather than long pending windows.",
            "status": "Operationally different enough to keep visible.",
        },
    ]
    docs.append(
        make_document(
            "S-COMPARISONS",
            kind="settings_snapshot",
            topic="Scoring & Starters",
            subcategory="Platform Comparisons",
            title="Platform Settings Versus Written Rulebook",
            summary="This section keeps live MFL settings and written rule text side by side whenever the two encode the same concept differently or conflict outright.",
            body_md=markdown_sections(
                [
                    (
                        "Why these cards exist",
                        [
                            "MFL is authoritative for platform-enforced behavior like scoring tables and live starter ranges.",
                            "The written rulebook is authoritative for narrative owner policy unless a later approved clarification replaces it.",
                        ],
                    )
                ]
            ),
            status="current",
            authority="mfl_live_setting",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("platform setting written rule mismatch roster size waiver trade expiration"),
            source_refs=[
                source_ref("current-league", "mfl_live_setting", current_settings.get("source_file"), season=CURRENT_SEASON, excerpt="league roster and starter settings", confidence=0.99),
                source_ref("rulebook-roster", "written_rulebook", RULEBOOK_TEXT, season=CURRENT_SEASON, excerpt="Maximum Active Roster Size", confidence=0.92),
            ],
            comparison_cards=comparison_cards,
            open_item_ids=["OI-ROSTER-SIZE-MISMATCH"],
            sort_order=208,
        )
    )
    return docs


def history_doc(doc_id: str, title: str, section: dict, sort_order: int) -> dict:
    body = markdown_sections(
        [
            ("Change Notes", section.get("change_notes") or ["No change notes captured."]),
            ("Legacy Rules Not In Current Rulebook", section.get("legacy_rules") or ["No legacy-only notes captured."]),
        ]
    )
    if section.get("needs_confirmation"):
        body = body + "\n\n" + markdown_sections([("Unresolved Follow-Ups", section["needs_confirmation"])])
    return make_document(
        doc_id,
        kind="history_event",
        topic="History",
        subcategory="Topic Timeline",
        title=f"Topic History: {title}",
        summary=first_sentence(" ".join(section.get("change_notes") or section.get("legacy_rules") or [title])),
        body_md=body,
        status="historical",
        authority="historical_reference",
        effective_from_season=None,
        effective_to_season=None,
        keywords=keywordize(title, section.get("change_notes"), section.get("legacy_rules")),
        source_refs=[
            source_ref(doc_id, "historical_reference", SETTINGS_CHANGES_PATH, excerpt=title, confidence=0.92),
            source_ref(f"{doc_id}-boards", "historical_reference", CLASSIFIED_RULES_PATH, excerpt=title, confidence=0.65),
        ],
        sort_order=sort_order,
    )


def build_season_summary(snapshot: dict, previous_snapshot: dict | None, starters_by_season: dict[int, list[dict]], scoring_diffs: dict[int, dict]) -> tuple[str, str]:
    season = snapshot["season"]
    changes = []
    snapshot_lines = [
        f"Salary cap: {snapshot.get('salary_cap_amount')}",
        f"Roster size: {snapshot.get('roster_size')}",
        f"Taxi squad: {snapshot.get('taxi_squad')}",
        f"Injured reserve: {snapshot.get('injured_reserve')}",
        f"Starters count: {snapshot.get('starters_count')}",
        f"IDP starters: {snapshot.get('idp_starters_count')}",
        f"Last regular season week: {snapshot.get('last_regular_season_week')}",
    ]
    if previous_snapshot:
        for key, label in [
            ("salary_cap_amount", "Salary cap"),
            ("roster_size", "Roster size"),
            ("taxi_squad", "Taxi squad"),
            ("starters_count", "Starter count"),
            ("idp_starters_count", "IDP starters"),
            ("last_regular_season_week", "Last regular season week"),
        ]:
            if snapshot.get(key) != previous_snapshot.get(key):
                changes.append(f"{label} changed from {previous_snapshot.get(key)} to {snapshot.get(key)}.")

    current_starters = starters_by_season.get(season, [])
    previous_starters = starters_by_season.get(previous_snapshot["season"], []) if previous_snapshot else []
    if current_starters != previous_starters and current_starters:
        current_label = ", ".join(f"{row['position']} {row['limit']}" for row in current_starters)
        changes.append(f"Starter ranges updated to {current_label}.")

    scoring_change = scoring_diffs.get(season)
    if scoring_change:
        added = scoring_change["added"][:4]
        removed = scoring_change["removed"][:4]
        if added:
            changes.append(
                "Scoring additions: "
                + "; ".join(f"{row['event']} {row['positions']} {row['range']} -> {row['points']}" for row in added)
                + "."
            )
        if removed:
            changes.append(
                "Scoring removals: "
                + "; ".join(f"{row['event']} {row['positions']} {row['range']} -> {row['points']}" for row in removed)
                + "."
            )

    changes.extend(SEASON_HIGHLIGHTS.get(season, []))
    summary = changes[0] if changes else f"Season {season} snapshot recorded with no major change note captured."
    body = markdown_sections(
        [
            ("Snapshot", snapshot_lines),
            ("Changes Introduced", changes or ["No change delta captured from the available sources."]),
        ]
    )
    return summary, body


def build_history_docs(
    settings_sections: list[dict],
    historical_snapshots: list[dict],
    starters_by_season: dict[int, list[dict]],
    scoring_diffs: dict[int, dict],
) -> list[dict]:
    docs = []
    for index, section in enumerate(settings_sections, start=500):
        doc_id = f"H-TOPIC-{slugify(section['title']).upper().replace('-', '-')}"
        docs.append(history_doc(doc_id, section["title"], section, index))

    previous = None
    for offset, snapshot in enumerate(historical_snapshots, start=650):
        summary, body = build_season_summary(snapshot, previous, starters_by_season, scoring_diffs)
        refs = [source_ref(f"season-{snapshot['season']}", "historical_reference", LEAGUE_SETTINGS_PATH, season=snapshot["season"], excerpt=summary, confidence=0.86)]
        mfl_snapshot_path = GENERATED_ROOT / str(snapshot["season"]) / "league.xml"
        if mfl_snapshot_path.exists():
            refs.append(source_ref(f"season-{snapshot['season']}-mfl", "historical_reference", mfl_snapshot_path, season=snapshot["season"], excerpt="league snapshot", confidence=0.9))
        docs.append(
            make_document(
                f"H-SEASON-{snapshot['season']}",
                kind="settings_snapshot",
                topic="History",
                subcategory="Season Timeline",
                title=f"Season Snapshot: {snapshot['season']}",
                summary=summary,
                body_md=body,
                status="historical" if snapshot["season"] < CURRENT_SEASON else "current",
                authority="historical_reference" if snapshot["season"] < CURRENT_SEASON else "mfl_live_setting",
                effective_from_season=snapshot["season"],
                effective_to_season=snapshot["season"],
                keywords=keywordize(snapshot["season"], summary, [row["position"] for row in snapshot.get("starter_positions", [])]),
                source_refs=refs,
                table_rows=snapshot.get("starter_positions", []),
                sort_order=offset,
            )
        )
        previous = snapshot
    return docs


def open_item_title(section_title: str, bullet: str, index: int) -> str:
    text = bullet
    text = re.sub(r"^(Confirm whether|Confirm the season when|Pin down the exact season the|Penalt(y|ies) amounts and appeal process are placeholders; requires authoritative update\.?)\s*", "", text, flags=re.I)
    text = text.rstrip(".")
    if not text:
        text = f"{section_title} open item {index}"
    return text[0].upper() + text[1:]


def build_open_item_docs(settings_sections: list[dict], current_settings: dict) -> list[dict]:
    docs = []
    counter = 0
    for section in settings_sections:
        title = section["title"]
        for bullet in section.get("needs_confirmation", []):
            counter += 1
            doc_id = f"OI-{counter:03d}"
            docs.append(
                make_document(
                    doc_id,
                    kind="open_item",
                    topic="Needs Confirmation",
                    subcategory=title,
                    title=open_item_title(title, bullet, counter),
                    summary=bullet,
                    body_md=markdown_sections(
                        [
                            ("Conflicting issue", [bullet]),
                            ("Why this remains open", ["Historical notes and current governing text do not line up cleanly enough to promote a single answer into current rules."]),
                            ("Recommended current handling", [TOPIC_RECOMMENDED_HANDLING.get(title, "Use the current written rulebook unless the commissioner resolves the conflict with an approved clarification.")]),
                        ]
                    ),
                    status="needs_confirmation",
                    authority="historical_reference",
                    effective_from_season=None,
                    effective_to_season=None,
                    keywords=keywordize(title, bullet, "needs confirmation"),
                    source_refs=[
                        source_ref(doc_id, "historical_reference", SETTINGS_CHANGES_PATH, excerpt=bullet, confidence=0.93),
                        source_ref(f"{doc_id}-current", "written_rulebook", RULEBOOK_TEXT, season=CURRENT_SEASON, excerpt=title, confidence=0.55),
                    ],
                    needs_confirmation_reason=bullet,
                    recommended_handling=TOPIC_RECOMMENDED_HANDLING.get(title, ""),
                    sort_order=700 + counter,
                )
            )
    docs.append(
        make_document(
            "OI-ROSTER-SIZE-MISMATCH",
            kind="open_item",
            topic="Needs Confirmation",
            subcategory="Roster Management",
            title="MFL Roster Size Versus Written Active-Roster Limits",
            summary="Live MFL 2026 settings show rosterSize 50, while the written rulebook still uses active-roster minimum and maximum language centered on 27, 30, and 35.",
            body_md=markdown_sections(
                [
                    (
                        "Conflicting statements",
                        [
                            f"Live MFL 2026 platform setting: rosterSize = {current_settings.get('roster_size')}.",
                            "Written rulebook: minimum active roster size is 27, maximum is 35 during the auction and 30 after the contract deadline.",
                        ],
                    ),
                    (
                        "Why this remains open",
                        [
                            "The live platform appears to describe total stored roster capacity, while the written rulebook describes active-roster policy. The two should not be flattened into one number without commissioner confirmation.",
                        ],
                    ),
                    (
                        "Recommended current handling",
                        [
                            "Display both numbers separately, use live MFL settings for platform behavior, and use the written 27/30/35 language as the active-roster policy until resolved.",
                        ],
                    ),
                ]
            ),
            status="needs_confirmation",
            authority="historical_reference",
            effective_from_season=CURRENT_SEASON,
            effective_to_season=None,
            keywords=keywordize("roster size active roster 50 30 35"),
            source_refs=[
                source_ref("current-league", "mfl_live_setting", current_settings.get("source_file"), season=CURRENT_SEASON, excerpt=f"rosterSize={current_settings.get('roster_size')}", confidence=0.99),
                source_ref("rulebook-roster", "written_rulebook", RULEBOOK_TEXT, season=CURRENT_SEASON, excerpt="Maximum Active Roster Size", confidence=0.96),
            ],
            needs_confirmation_reason="MFL total roster capacity and written active-roster policy are not expressed the same way.",
            comparison_cards=[
                {
                    "label": "Roster Size Conflict",
                    "platform_setting": f"MFL rosterSize = {current_settings.get('roster_size')}",
                    "written_rule": "Written rulebook uses 27 minimum, 30 post-deadline, and 35 during the auction.",
                    "status": "Needs confirmation",
                }
            ],
            recommended_handling="Display both concepts separately and do not silently merge them.",
            sort_order=899,
        )
    )
    return docs


def build_source_manifest(sources: dict) -> dict:
    return {
        "generated_at_utc": utc_now_iso(),
        "rules_files": [
            str(RULEBOOK_TEXT),
            str(CONTRACT_GUIDE_TEXT),
            str(SETTINGS_CHANGES_PATH),
            str(LEAGUE_SETTINGS_PATH),
            str(STARTERS_METADATA_PATH),
            str(CLASSIFIED_RULES_PATH),
            str(HIGHLIGHTS_RULES_PATH),
            str(CONTRACT_EXAMPLES_PATH),
            str(SCORING_EXAMPLES_PATH),
            str(MANUAL_CONFIRMATIONS_PATH),
        ],
        "generated_manifest": sources.get("mfl_manifest", {}),
    }


def season_snapshot_lookup(seasons: list[int]) -> tuple[dict[int, dict], dict[int, list[dict]], dict[int, list[dict]]]:
    all_rules_lookup = parse_all_rules_lookup(GENERATED_ROOT / f"allRules_{CURRENT_SEASON}.xml")
    league_snapshots = {}
    rules_by_season = {}
    for season in seasons:
        league_path = GENERATED_ROOT / str(season) / "league.xml"
        rules_path = GENERATED_ROOT / str(season) / "rules.xml"
        league_snapshot = parse_league_snapshot(league_path, season)
        if league_snapshot:
            league_snapshots[season] = league_snapshot
        rules_by_season[season] = parse_rules_snapshot(rules_path, season, all_rules_lookup)
    return league_snapshots, rules_by_season, scoring_groups(rules_by_season.get(CURRENT_SEASON, []))


def apply_manual_confirmations(documents: list[dict], manual_confirmations: dict) -> list[dict]:
    by_id = {doc["id"]: doc for doc in documents}
    for doc_id, overrides in (manual_confirmations.get("document_overrides") or {}).items():
        if doc_id in by_id:
            by_id[doc_id].update(overrides)
    resolved = manual_confirmations.get("resolved_open_items") or {}
    retired_ids = {doc_id for doc_id, payload in resolved.items() if payload.get("retire")}
    documents = [doc for doc in documents if doc["id"] not in retired_ids]
    return documents


def attach_cross_links(documents: list[dict], settings_sections: list[dict]) -> list[dict]:
    topic_history_ids = defaultdict(list)
    topic_open_ids = defaultdict(list)
    for doc in documents:
        if doc["topic"] == "History" and doc["id"].startswith("H-TOPIC-"):
            title = doc["title"].replace("Topic History: ", "")
            topic_history_ids[title].append(doc["id"])
        if doc["topic"] == "Needs Confirmation":
            topic_open_ids[doc["subcategory"]].append(doc["id"])

    for doc in documents:
        if doc["topic"] == "Current Rules":
            if doc["subcategory"] == "League Overview":
                doc["historical_note_ids"] = topic_history_ids.get("League Overview", [])
                doc["open_item_ids"] = topic_open_ids.get("League Overview", [])
            elif doc["subcategory"] == "League Calendar":
                doc["historical_note_ids"] = topic_history_ids.get("League Calendar", [])
                doc["open_item_ids"] = topic_open_ids.get("League Calendar", [])
        elif doc["topic"] == "Roster / Lineup":
            doc["historical_note_ids"] = topic_history_ids.get("Roster Management", [])
            doc["open_item_ids"] = topic_open_ids.get("Roster Management", [])
        elif doc["topic"] == "Acquisition Rules":
            doc["historical_note_ids"] = topic_history_ids.get(doc["subcategory"], [])
            doc["open_item_ids"] = topic_open_ids.get(doc["subcategory"], [])
        elif doc["topic"] == "Trades":
            doc["historical_note_ids"] = topic_history_ids.get("Trades", [])
            doc["open_item_ids"] = topic_open_ids.get("Trades", [])
        elif doc["topic"] == "Contracts":
            doc["historical_note_ids"] = topic_history_ids.get("Contract Management", [])
            doc["open_item_ids"] = topic_open_ids.get("Contract Management", [])
        elif doc["topic"] == "League Finance & Penalties":
            key = "League Financing" if "Finance" in doc["title"] else "Penalties and Miscellaneous League Rules"
            doc["historical_note_ids"] = topic_history_ids.get(key, [])
            doc["open_item_ids"] = topic_open_ids.get(key, [])
        elif doc["topic"] == "Scoring & Starters":
            doc["historical_note_ids"] = topic_history_ids.get("Scoring Settings", []) + topic_history_ids.get("Roster Management", [])
            doc["open_item_ids"] = topic_open_ids.get("Roster Management", [])
    return documents


def build_navigation(documents: list[dict]) -> list[dict]:
    counts = defaultdict(int)
    for doc in documents:
        counts[doc["topic"]] += 1
    return [{"label": label, "count": counts.get(label, 0)} for label in TOPIC_ORDER]


def ai_text_for_doc(doc: dict) -> str:
    parts = [doc["title"], doc["summary"], doc["body_md"]]
    if doc.get("table_rows"):
        if doc["table_rows"] and "event" in doc["table_rows"][0]:
            parts.append(
                "\n".join(
                    f"{row['positions']} | {row['event']} | {row['range']} | {row['points']} | {row['short_description']}"
                    for row in doc["table_rows"]
                )
            )
        else:
            parts.append("\n".join(f"{row['position']} {row['limit']}" for row in doc["table_rows"]))
    if doc.get("comparison_cards"):
        parts.append(
            "\n".join(
                f"{card['label']}: platform={card['platform_setting']} written={card['written_rule']} status={card['status']}"
                for card in doc["comparison_cards"]
            )
        )
    return "\n\n".join(part for part in parts if normalize_ws(part)).strip()


def build_ai_chunks(documents: list[dict]) -> list[dict]:
    chunks = []
    for index, doc in enumerate(documents, start=1):
        chunks.append(
            {
                "chunk_id": f"chunk-{index:04d}",
                "document_id": doc["id"],
                "title": doc["title"],
                "chunk_type": doc["kind"],
                "topic": doc["topic"],
                "status": doc["status"],
                "authority": doc["authority"],
                "effective_from_season": doc["effective_from_season"],
                "effective_to_season": doc["effective_to_season"],
                "text": ai_text_for_doc(doc),
                "keywords": doc["keywords"],
                "source_refs": doc["source_refs"],
            }
        )
    return chunks


def build_rulebook_bundle() -> dict:
    sources = load_rulebook_sources()
    metadata = parse_rulebook_metadata(sources["rulebook_text"])
    settings_sections = parse_settings_changes(sources["settings_changes"])
    starters_by_season = group_starters_by_season(sources["starters_rows"])
    seasons = parse_mfl_manifest_seasons(sources.get("mfl_manifest", {}))
    league_snapshots, rules_by_season, current_groups = season_snapshot_lookup(seasons)
    historical_snapshots = historical_settings_rows_to_snapshots(sources["league_settings_rows"], starters_by_season)
    current_settings = league_snapshots.get(CURRENT_SEASON) or next(
        (snapshot for snapshot in historical_snapshots if snapshot["season"] == CURRENT_SEASON),
        {},
    )
    scoring_diffs = build_scoring_diffs(rules_by_season)

    struct_sections = index_current_rulebook_sections(sources["rulebook_struct"])
    example_docs = parse_structured_examples(sources["contract_examples"]) + parse_structured_examples(sources["scoring_examples"])

    documents = []
    documents.extend(build_front_matter_docs(metadata))
    documents.extend(build_current_rule_docs(struct_sections))
    documents.extend(build_contract_docs())
    documents.extend(build_glossary_docs())
    documents.extend(build_scoring_docs(current_settings, current_groups))
    documents.extend(build_history_docs(settings_sections, historical_snapshots, starters_by_season, scoring_diffs))
    documents.extend(build_open_item_docs(settings_sections, current_settings))
    documents.extend(example_docs)

    documents = apply_manual_confirmations(documents, sources["manual_confirmations"])
    documents = attach_cross_links(documents, settings_sections)
    documents = sort_documents(documents)

    navigation = build_navigation(documents)
    ai_chunks = build_ai_chunks(documents)

    scoring_tables = {
        "current": {
            "season": CURRENT_SEASON,
            "groups": current_groups,
        }
    }
    history_events = [doc for doc in documents if doc["kind"] == "history_event"]
    open_items = [doc for doc in documents if doc["kind"] == "open_item"]
    bundle = {
        "version": CURRENT_RULEBOOK_VERSION,
        "league": {
            "name": current_settings.get("league_name") or "UPS Salary Cap Dynasty League",
            "current_season": CURRENT_SEASON,
        },
        "generated_at_utc": utc_now_iso(),
        "current_season": CURRENT_SEASON,
        "documents": documents,
        "navigation": navigation,
        "scoring_tables": scoring_tables,
        "current_settings": current_settings,
        "settings_history": historical_snapshots,
        "history_events": history_events,
        "open_items": open_items,
        "source_manifest": build_source_manifest(sources),
    }
    rules_payload = dict(bundle)
    rules_payload["rules"] = list(documents)
    ai_payload = {
        "version": CURRENT_RULEBOOK_VERSION,
        "league": bundle["league"],
        "generated_at_utc": bundle["generated_at_utc"],
        "chunks": ai_chunks,
    }
    return {"bundle": bundle, "rules": rules_payload, "ai": ai_payload}


def build_rulebook_outputs() -> dict:
    payloads = build_rulebook_bundle()
    write_json(RULEBOOK_BUNDLE_PATH, payloads["bundle"])
    write_json(RULES_JSON_PATH, payloads["rules"])
    write_json(RULES_AI_PATH, payloads["ai"])
    return payloads


def build_season_manifest(rows: list[dict], current_season: int, current_base_url: str, current_league_id: str) -> list[dict]:
    manifest = {}
    for row in rows:
        season = normalize_ws(row.get("season"))
        base_url = normalize_ws(row.get("base_url"))
        league_id = normalize_ws(row.get("league_id"))
        if not season or not base_url or not league_id:
            continue
        manifest[season] = {
            "season": season,
            "base_url": base_url.rstrip("/"),
            "league_id": league_id,
            "source": "league_settings.csv",
        }
    if str(current_season) not in manifest:
        manifest[str(current_season)] = {
            "season": str(current_season),
            "base_url": current_base_url.rstrip("/"),
            "league_id": str(current_league_id),
            "source": "current_default",
        }
    return [manifest[key] for key in sorted(manifest, key=int)]


def fetch_text(url: str, timeout: int) -> str:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "UPSRulebookFetcher/2.1 (+https://upsdynastycap.forumotion.com/forum)"},
    )
    context = ssl.create_default_context()
    with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
        return response.read().decode("utf-8", errors="ignore")


def fetch_mfl_sources() -> dict:
    current_base_url = os.getenv("RULEBOOK_CURRENT_BASE_URL", "https://www48.myfantasyleague.com")
    current_league_id = os.getenv("RULEBOOK_CURRENT_LEAGUE_ID", "74598")
    timeout = int(os.getenv("RULEBOOK_FETCH_TIMEOUT", str(DEFAULT_TIMEOUT)))

    rows = read_csv_rows(LEAGUE_SETTINGS_PATH)
    manifest_rows = build_season_manifest(rows, CURRENT_SEASON, current_base_url, current_league_id)
    manifest = {
        "generated_at_utc": utc_now_iso(),
        "current_season": CURRENT_SEASON,
        "all_rules_url": f"https://api.myfantasyleague.com/{CURRENT_SEASON}/export?TYPE=allRules",
        "seasons": [],
        "warnings": [],
    }

    for row in manifest_rows:
        season = row["season"]
        base_url = row["base_url"]
        league_id = row["league_id"]
        season_dir = GENERATED_ROOT / season
        season_meta = dict(row)
        season_meta["files"] = {}
        season_meta["warnings"] = []
        urls = {
            "league.xml": f"{base_url}/{season}/export?TYPE=league&L={league_id}",
            "rules.xml": f"{base_url}/{season}/export?TYPE=rules&L={league_id}",
        }
        for filename, url in urls.items():
            try:
                write_text(season_dir / filename, fetch_text(url, timeout))
                season_meta["files"][filename] = str(season_dir / filename)
            except urllib.error.URLError as exc:
                message = f"{season} {filename} fetch failed: {exc}"
                season_meta["warnings"].append(message)
                manifest["warnings"].append(message)
            except Exception as exc:
                message = f"{season} {filename} unexpected error: {exc}"
                season_meta["warnings"].append(message)
                manifest["warnings"].append(message)
        manifest["seasons"].append(season_meta)

    try:
        target = GENERATED_ROOT / f"allRules_{CURRENT_SEASON}.xml"
        write_text(target, fetch_text(manifest["all_rules_url"], timeout))
        manifest["all_rules_file"] = str(target)
    except urllib.error.URLError as exc:
        manifest["warnings"].append(f"allRules fetch failed: {exc}")
    except Exception as exc:
        manifest["warnings"].append(f"allRules unexpected error: {exc}")

    write_json(MFL_MANIFEST_PATH, manifest)
    return manifest


def validate_documents(documents: list[dict]) -> None:
    if not documents:
        raise ValueError("Bundle has no documents.")
    seen = set()
    for doc in documents:
        doc_id = doc.get("id")
        if not doc_id:
            raise ValueError("Document missing id.")
        if doc_id in seen:
            raise ValueError(f"Duplicate document id: {doc_id}")
        seen.add(doc_id)
        for key in [
            "slug",
            "kind",
            "topic",
            "subcategory",
            "title",
            "summary",
            "body_md",
            "status",
            "authority",
            "keywords",
            "source_refs",
            "related_ids",
            "example_ids",
        ]:
            if key not in doc:
                raise ValueError(f"Document {doc_id} missing key: {key}")
        if doc["kind"] not in ALLOWED_KINDS:
            raise ValueError(f"Document {doc_id} has invalid kind: {doc['kind']}")
        if doc["status"] not in ALLOWED_STATUS:
            raise ValueError(f"Document {doc_id} has invalid status: {doc['status']}")
        if doc["authority"] not in ALLOWED_AUTHORITY:
            raise ValueError(f"Document {doc_id} has invalid authority: {doc['authority']}")
        if doc["status"] == "needs_confirmation":
            if not doc.get("needs_confirmation_reason"):
                raise ValueError(f"Needs-confirmation document {doc_id} missing reason.")
            if not doc.get("source_refs"):
                raise ValueError(f"Needs-confirmation document {doc_id} missing source refs.")

    for doc in documents:
        if (
            doc["topic"] == "Contracts"
            and doc["status"] == "current"
            and doc["kind"] == "rule"
            and not doc.get("example_ids")
        ):
            raise ValueError(f"Current contract document {doc['id']} has no examples.")


def validate_rulebook_payloads(bundle: dict, rules_payload: dict, ai_payload: dict) -> None:
    validate_documents(bundle.get("documents", []))

    current_scoring = (bundle.get("scoring_tables", {}) or {}).get("current", {})
    if str(current_scoring.get("season")) != str(CURRENT_SEASON):
        raise ValueError(f"Current scoring season is not {CURRENT_SEASON}.")
    groups = current_scoring.get("groups", {})
    if not any(groups.get(name) for name in groups):
        raise ValueError("Current scoring groups are empty.")

    current_settings = bundle.get("current_settings", {})
    if str(current_settings.get("season")) != str(CURRENT_SEASON):
        raise ValueError(f"Current settings season is not {CURRENT_SEASON}.")
    if not current_settings.get("starters", {}).get("positions"):
        raise ValueError("Current settings missing starter positions.")

    navigation = bundle.get("navigation", [])
    labels = {item.get("label") for item in navigation}
    for label in {"Contracts", "Scoring & Starters", "History"}:
        if label not in labels:
            raise ValueError(f"Navigation missing required label: {label}")

    if "documents" not in rules_payload or "rules" not in rules_payload:
        raise ValueError("rules.json missing documents or legacy rules.")
    if not rules_payload["documents"]:
        raise ValueError("rules.json documents is empty.")

    chunks = ai_payload.get("chunks", [])
    if not chunks:
        raise ValueError("rules_ai.json has no chunks.")
    for chunk in chunks:
        for key in [
            "chunk_id",
            "document_id",
            "title",
            "chunk_type",
            "topic",
            "status",
            "authority",
            "text",
            "keywords",
            "source_refs",
        ]:
            if key not in chunk:
                raise ValueError(f"AI chunk missing key: {key}")


def validate_rulebook_files() -> None:
    bundle = read_json(RULEBOOK_BUNDLE_PATH)
    rules_payload = read_json(RULES_JSON_PATH)
    ai_payload = read_json(RULES_AI_PATH)
    validate_rulebook_payloads(bundle, rules_payload, ai_payload)


def load_rules_payload() -> dict:
    return read_json(RULES_JSON_PATH)


def load_rules_ai_payload() -> dict:
    return read_json(RULES_AI_PATH)


def load_rules_lookup() -> tuple[dict, set[str], dict[str, dict]]:
    payload = load_rules_payload()
    documents = payload.get("documents") or payload.get("rules") or []
    valid_rule_ids = {item["id"] for item in documents if item.get("id")}
    lookup = {item["id"]: item for item in documents if item.get("id")}
    return payload, valid_rule_ids, lookup
