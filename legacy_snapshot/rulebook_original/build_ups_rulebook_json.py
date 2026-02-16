#!/usr/bin/env python3
import json
import re
from pathlib import Path

ARCHIVE = Path('/Users/keithcreelman/Documents/mfl_app_codex/rules/archive')
CURRENT_STRUCT = ARCHIVE / 'current_rulebook_struct.json'
RULEBOOK_TXT = ARCHIVE / 'UPS Rule Book.txt'
CONTRACT_TXT = ARCHIVE / 'UPS Contract Rules.txt'
BYLAWS_2014_TXT = ARCHIVE / 'UPS FFL Bylaws V2014.1.txt'
RULEBOOK_2013_TXT = ARCHIVE / 'UPS Dynasty Cap Rulebook 2013.1.txt'
OUT_PATH = Path('rulebook/rules.json')


def normalize_ws(value: str) -> str:
    value = value.replace('\u00a0', ' ')
    return re.sub(r'\s+', ' ', value).strip()


def clean_subsection_title(value: str) -> str:
    value = value.strip()
    value = re.sub(r'^\d+(?:\.\d+)?\s*[:.-]?\s*', '', value)
    return value.strip() or 'Untitled Rule'


def extract_rule_id_from_title(value: str, sec: str, idx: int) -> str:
    m = re.match(r'^(\d+(?:\.\d+)?)', value.strip())
    if m:
        return f"R-{m.group(1)}"
    return f"R-{sec}.{idx}"


def extract_front_matter() -> list:
    txt = RULEBOOK_TXT.read_text(encoding='utf-8', errors='ignore').splitlines()
    txt = [normalize_ws(x) for x in txt if normalize_ws(x)]

    commissioner = next((x for x in txt if x.lower().startswith('commissioner:')), 'Commissioner: Keith Creelman')
    version = next((x for x in txt if x.lower().startswith('version:')), 'Version: 2024.2')
    updated = next((x for x in txt if x.lower().startswith('last updated:')), 'Last Updated: 8/31/2024')

    mission = ''
    note = ''
    for i, line in enumerate(txt):
        if line.lower().startswith('mission statement'):
            if i + 1 < len(txt):
                mission = txt[i + 1]
            if i + 2 < len(txt) and txt[i + 2].lower().startswith('note:'):
                note = txt[i + 2]
            break

    if not mission:
        mission = (
            'Provide a competitive dynasty salary-cap league that rewards strategy, '
            'planning, and sustained owner engagement.'
        )

    return [
        {
            'id': 'R-FM-1',
            'category': 'Front Matter',
            'title': 'Official Rulebook',
            'body': 'UPS Salary Cap Dynasty League Rulebook. This is the official operating document for league rules and transactions.',
            'tags': ['official', 'rulebook']
        },
        {
            'id': 'R-FM-2',
            'category': 'Front Matter',
            'title': 'Commissioner And Version',
            'body': f"{commissioner}. {version}. {updated}.",
            'tags': ['commissioner', 'version']
        },
        {
            'id': 'R-FM-3',
            'category': 'Front Matter',
            'title': 'Mission Statement',
            'body': f"{mission} {note}".strip(),
            'tags': ['mission', 'league-culture']
        }
    ]


def build_current_rules() -> list:
    src = json.loads(CURRENT_STRUCT.read_text(encoding='utf-8'))
    rules = []

    for sec_key in sorted(src.keys(), key=lambda x: int(x)):
        section = src[sec_key]
        category = normalize_ws(section.get('title', f'Section {sec_key}'))
        subsections = section.get('subsections', [])

        for idx, subsection in enumerate(subsections, 1):
            lines = [normalize_ws(x) for x in subsection.get('content', []) if normalize_ws(x)]
            if not lines:
                continue

            raw_title = subsection.get('title', '').strip() or f'{sec_key}.{idx}'
            rid = extract_rule_id_from_title(raw_title, sec_key, idx)
            title = clean_subsection_title(raw_title)
            body = '\n'.join(lines)

            base_tags = {
                category.lower().replace(' ', '-'),
                title.lower().split('(')[0].strip().replace(' ', '-')
            }
            tags = sorted(t for t in base_tags if t)

            rules.append({
                'id': rid,
                'category': category,
                'title': title,
                'body': body,
                'tags': tags
            })

    return rules


def extract_legacy_addenda() -> list:
    contract_txt = CONTRACT_TXT.read_text(encoding='utf-8', errors='ignore')
    bylaw_2014_txt = BYLAWS_2014_TXT.read_text(encoding='utf-8', errors='ignore')
    rulebook_2013_txt = RULEBOOK_2013_TXT.read_text(encoding='utf-8', errors='ignore')

    addenda = [
        {
            'id': 'R-L-2019-1',
            'category': 'Legacy Contract Addenda',
            'title': 'Legacy Contract Baseline',
            'body': (
                'Legacy contract guide states maximum contract length of 3 years and defines Rookie, '
                'Veteran, Loaded, and WW as contract classes. This is retained for historical cross-reference.'
            ),
            'tags': ['legacy', 'contracts', 'history']
        },
        {
            'id': 'R-L-2019-2',
            'category': 'Legacy Contract Addenda',
            'title': 'Legacy Guarantees And Earn Schedule',
            'body': (
                'Legacy contract guidance references 75% guarantees with earned-salary checkpoints from October '
                'through December and cap-penalty treatment based on earned value.'
            ),
            'tags': ['legacy', 'guarantees', 'cap-penalty']
        },
        {
            'id': 'R-L-2019-3',
            'category': 'Legacy Contract Addenda',
            'title': 'Grandfathered Contract Concept',
            'body': (
                'Legacy contract rules describe grandfathered deals under prior cap rules until contract touchpoints '
                '(extension, restructure, or release) trigger modern treatment.'
            ),
            'tags': ['legacy', 'grandfathered', 'contracts']
        },
        {
            'id': 'R-L-2014-1',
            'category': 'Legacy League Addenda',
            'title': 'Legacy Governance Model (2014)',
            'body': (
                '2014 bylaws describe a three-member Competition Committee model, conference-based structure, '
                'and specific historical voting thresholds. These entries are legacy references, not automatic current policy.'
            ),
            'tags': ['legacy', 'governance', '2014']
        },
        {
            'id': 'R-L-2013-1',
            'category': 'Legacy League Addenda',
            'title': 'Legacy Tag And Contract Flow (2013)',
            'body': (
                '2013 cap rulebook documents franchise and transition tag bidding windows, compensation rules, '
                'and legacy contract-loading formulas used during earlier league eras.'
            ),
            'tags': ['legacy', 'tags', '2013']
        }
    ]

    if 'Beginning in 2019 there will no longer be any allowances for restructuring of mid-season acquisitions.' in contract_txt:
        addenda.append({
            'id': 'R-L-2019-4',
            'category': 'Legacy Contract Addenda',
            'title': '2019 Mid-Season Restructure Constraint',
            'body': (
                'Legacy contract file states that beginning in 2019 there is no restructuring allowance for '
                'mid-season acquisitions, reinforcing MYM and extension guardrails for in-season pickups.'
            ),
            'tags': ['legacy', 'mym', 'restructure']
        })

    if '2 Conferences with 2 Divisions of 3 teams each' in bylaw_2014_txt:
        addenda.append({
            'id': 'R-L-2014-2',
            'category': 'Legacy League Addenda',
            'title': 'Legacy Conference Alignment Model',
            'body': (
                '2014 bylaws include a two-conference, two-division-per-conference model with double-header scheduling. '
                'Current structure should use active season governance text unless amended.'
            ),
            'tags': ['legacy', 'alignment', 'scheduling']
        })

    if 'Franchise and Transition Tag Period' in rulebook_2013_txt:
        addenda.append({
            'id': 'R-L-2013-2',
            'category': 'Legacy League Addenda',
            'title': 'Legacy Calendar Anchors',
            'body': (
                '2013 rulebook sets historical calendar anchors for tags, rookie extension deadlines, auction timing, '
                'and contract roll-forward mechanics. Used for historical adjudication only.'
            ),
            'tags': ['legacy', 'calendar', 'history']
        })

    return addenda


def add_data_policy_rules() -> list:
    return [
        {
            'id': 'R-D-1',
            'category': 'Data Standards',
            'title': 'Contract Type Field',
            'body': 'Each normalized contract row must contain contract_type with values Auction, Extension, MYM, or Restructure.',
            'tags': ['data', 'contract_type']
        },
        {
            'id': 'R-D-2',
            'category': 'Data Standards',
            'title': 'Source Traceability Fields',
            'body': 'Each contract row must preserve source_section and source_raw_line (or equivalent) for audit traceability.',
            'tags': ['data', 'source_section', 'audit']
        },
        {
            'id': 'R-D-3',
            'category': 'Data Standards',
            'title': 'XML Payload Retention',
            'body': 'Each contract row must retain xml_payload for reconstruction and historical cross-reference.',
            'tags': ['data', 'xml_payload']
        },
        {
            'id': 'R-D-4',
            'category': 'Data Standards',
            'title': 'Legacy Guaranteed Handling',
            'body': 'Legacy guaranteed handling applies through 2018. For 2019 forward, normalized guaranteed remains primary while legacy cross-reference is retained.',
            'tags': ['data', 'legacy', 'guaranteed']
        },
        {
            'id': 'R-D-5',
            'category': 'Data Standards',
            'title': 'Duplicate Event Adjudication',
            'body': 'Potential duplicates are adjudicated by event semantics and timestamps. Extension and restructure events can both be valid for the same player.',
            'tags': ['data', 'duplicates', 'events']
        }
    ]


def dedupe_rules(rules: list) -> list:
    seen = set()
    out = []
    for r in rules:
        rid = r['id']
        if rid in seen:
            i = 2
            new_id = f"{rid}-{i}"
            while new_id in seen:
                i += 1
                new_id = f"{rid}-{i}"
            r = dict(r)
            r['id'] = new_id
            rid = new_id
        seen.add(rid)
        out.append(r)
    return out


def main():
    rules = []
    rules.extend(extract_front_matter())
    rules.extend(build_current_rules())
    rules.extend(add_data_policy_rules())
    rules.extend(extract_legacy_addenda())
    rules = dedupe_rules(rules)

    payload = {
        'version': '2026.5',
        'league': 'UPS Salary Cap Dynasty League',
        'last_updated': '2026-02-14',
        'sources_considered': [
            'UPS Rule Book.docx',
            'UPS Rule Book - Table of Contents.docx',
            'UPS Contract Rules.docx',
            'UPS Dynasty League By-Laws.doc.docx',
            'UPS Dynasty Cap Rulebook 2013.1.docx',
            'UPS FFL Bylaws V2014.1.pdf',
            'UPS_Master_Rulebook.html'
        ],
        'rules': rules
    }

    OUT_PATH.write_text(json.dumps(payload, indent=2, ensure_ascii=True) + '\n', encoding='utf-8')
    print(f'Wrote {OUT_PATH} with {len(rules)} rules')


if __name__ == '__main__':
    main()
