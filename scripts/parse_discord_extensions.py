#!/usr/bin/env python3
"""
parse_discord_extensions.py — mine Discord channel exports for explicit
extension submissions, match to ups_extension_master rows, and emit:
  • SQL UPDATEs to upgrade derived rows to evidenced (with discord URL +
    quote in evidence_source).
  • CSV log of every extension message we found (matched + unmatched)
    for review.

Sources (in pipelines/etl/inputs/):
  • discord_contract_activity.csv — Aug 2024+, 59 ext-mentioning rows
  • discord_contract_links.csv    — pinned thread, scattered ext msgs
  • discord_coffee_shop.csv       — 11K rows, 2023-03+; informal chatter

Match strategy:
  1. Pattern-match content for "extend <player> <N> year(s)" or "extend
     <player> <N>/<salary>" etc.
  2. Map author → franchise_id (with season-aware franchise map for
     2024 vs 2025 ownership swaps — e.g. fr=0006 was Lima in 2024,
     Cross in 2025).
  3. Player name fuzzy match against src_players for the year.
  4. Determine "season" from message date: extensions submitted in
     April-Sept apply to the current calendar year; Oct-Dec submissions
     apply to the NEXT calendar year (offseason kickoff). Per canon §C4.
  5. Match (season, player_id, franchise_id) against ups_extension_master.

Output:
  /tmp/discord_extensions_parsed.csv     — all matches + misses
  /tmp/discord_extension_evidence_upserts.sql  — UPDATE/UPSERT for master
"""
from __future__ import annotations

import csv
import json
import re
import subprocess
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

INPUTS = Path('/Users/keithcreelman/Code/MFL/upsmflproduction/pipelines/etl/inputs')
WORKER = Path('/Users/keithcreelman/Code/MFL/upsmflproduction/.claude/worktrees/keen-knuth-623b0f/worker')

SOURCES = [
    ('discord_contract_activity', INPUTS / 'discord_contract_activity.csv',
     'https://discord.com/channels/UPS/contract-activity'),
    ('discord_contract_links', INPUTS / 'discord_contract_links.csv',
     'https://discord.com/channels/UPS/contract-links'),
    ('discord_coffee_shop', INPUTS / 'discord_coffee_shop.csv',
     'https://discord.com/channels/UPS/coffee-shop'),
]

# Discord author handle → (franchise_id valid_seasons). Some owners
# changed franchise (Brian Cross was new in 2025 fr=0006; before that
# fr=0006 was Steve Bousquet/Josh Lima).
AUTHOR_TO_FID = {
    'cleoncash366':   '0011',  # Eric Mannila / Cleon Ca$h
    'briancross0914': '0006',  # Brian Cross / Long Haulers (2025+)
    'sexmanther':     '0007',  # Josh Martel / Sex Manther
    'gride09':        '0003',  # Matt Gerardi / Gride
    'shawnblake':     '0010',  # Shawn Blake / Blake Bombers
    'hawks4559':      '0012',  # Chris Klingenberg / Hawks
    'cutting4987':    '0004',  # Brian Cutting / Pure Greatness
    'rybo4591':       '0001',  # Ryan Bousquet / Ulterior Warrior / LA Looks
    'emart7733':      '0005',  # Eric Martel / HammerTime
    'whitman8352':    '0002',  # Derrick Whitman / CBP
    'papabear4110':   '0009',  # Bear Dunn / C-Town Chivalry
    # ups_commish / upscommish — admin (could be acting on behalf of any
    # owner). Don't auto-assign franchise from these.
}

# Owner short-references inside messages (when commish posts "for <owner>")
OWNER_REF_TO_FID = {
    'cleon':         '0011',
    'cleon ca$h':    '0011',
    'cleon cash':    '0011',
    'long haulers':  '0006',
    'cross':         '0006',
    'sex manther':   '0007',
    'manther':       '0007',
    'gride':         '0003',
    'gride09':       '0003',
    'matt':          '0003',
    'blake':         '0010',
    'shawn':         '0010',
    'bombers':       '0010',
    'hawks':         '0012',
    'chris':         '0012',
    'kling':         '0012',
    'pure greatness':'0004',
    'pg':            '0004',
    'brian cutting': '0004',
    'cutting':       '0004',
    'ryan':          '0001',
    'rybo':          '0001',
    'ulterior':      '0001',
    'la looks':      '0001',
    'l.a. looks':    '0001',
    'hammertime':    '0005',
    'hammer':        '0005',
    'eric martel':   '0005',
    'cbp':           '0002',
    'whitman':       '0002',
    'derrick':       '0002',
    'c-town':        '0009',
    'ctown':         '0009',
    'bear':          '0009',
    'real deal':     '0008',
    'real deal creel':'0008',
    'creel':         '0008',
    'keith':         '0008',
    '#blm':          '0008',
}

# Patterns matching extension messages. We require an "Extend" verb to
# avoid false-positives on "extension" used as a noun in general chatter.
EXT_PATTERNS = [
    # "Extend <player>, <N> year(s)"
    re.compile(r'\bextend(?:ing|ed|s)?\s+([A-Z][A-Za-z .,\'-]+?)\s+(\d)\s*[-/]?\s*y(?:ea)?rs?\b', re.I),
    # "Extend <player> for <N> year(s)"
    re.compile(r'\bextend(?:ing|ed|s)?\s+([A-Z][A-Za-z .,\'-]+?)\s+for\s+(\d)\s*y(?:ea)?rs?\b', re.I),
    # "<N> year extension on <player>"
    re.compile(r'\b(\d)\s*[-]?\s*y(?:ea)?rs?\s*extension\s+(?:on|for)\s+([A-Z][A-Za-z .,\'-]+?)\b', re.I),
    # "Extend <player> 1 yr" (single digit no s)
    re.compile(r'\bextend(?:ing|ed|s)?\s+([A-Z][A-Za-z .,\'-]+?)\s+(\d)\s*yr\b', re.I),
    # "Extend <player>" (no term — infer 1 from canon EXT1 default)
    re.compile(r'\bextend(?:ing|ed|s)?\s+([A-Z][A-Za-z .,\'-]{3,})', re.I),
]


def d1(sql):
    cp = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'ups-mfl-db', '--remote',
         '--command', sql, '--json'],
        cwd=str(WORKER), capture_output=True, text=True, check=True
    )
    data = json.loads(cp.stdout)
    return data[0]['results'] if isinstance(data, list) else data.get('results', [])


def normalize_player_key(name):
    return re.sub(r'[^a-z]', '', (name or '').lower())


def parse_iso(ts):
    try:
        s = ts.replace('Z', '+00:00')
        # Discord format: 2024-12-07T12:12:38.6920000-05:00
        s = re.sub(r'(\.\d+)([+-]\d{2}:\d{2})$', lambda m: m.group(2), s)
        return datetime.fromisoformat(s)
    except Exception:
        return None


def season_from_date(dt):
    """Per canon §C4: extensions submitted in spring/summer apply to that
    NFL season. Submissions in late season / playoffs typically still
    apply to the current season. We use a simple rule: if message is in
    Jan-Aug, it's for the same calendar year; Sep-Dec is for the next
    NFL season iff it happens after the contract deadline (~Sept).
    Conservatively: use the calendar year of the message.

    Actually for UPS specifically, extension events get stamped to the
    NFL season in which the player plays the new contract. An extension
    submitted in Oct 2024 for a player whose contract was running out
    after the 2024 season takes effect in 2025.

    Heuristic: Sep-Dec messages → next year. Jan-Aug → same year.
    """
    if dt.month >= 9:
        return dt.year + 1
    return dt.year


def find_extension(content):
    """Try each pattern, return (player_name, term, pattern_idx) or None."""
    # Normalize: "I year" / "i year" typo for "1 year"
    content = re.sub(r'\b[iI]\s+year', '1 year', content)
    for i, pat in enumerate(EXT_PATTERNS):
        m = pat.search(content)
        if m:
            groups = m.groups()
            if i == 2:  # (term, player) order
                term, player = int(groups[0]), groups[1]
            elif i < 4:  # (player, term) order
                player, term = groups[0], int(groups[1])
            else:
                # pattern 4: no term, infer 1
                player, term = groups[0], 1
            # Strip trailing punct/quote
            player = re.sub(r'[\.\!\,\?\:\)\(\"\']+$', '', player.strip())
            # Strip leading articles
            player = re.sub(r'^(the|my|his|her)\s+', '', player, flags=re.I).strip()
            # Strip trailing prepositional phrases ("by the Long Haulers",
            # "for 1 year", "and give him")
            player = re.split(
                r'\s+(?:by|for|and|so|then|at|to|with|in|on)\b',
                player, maxsplit=1, flags=re.I
            )[0].strip()
            # Cap at 30 chars to avoid eating an entire sentence
            player = player[:30].strip()
            return player, term, i
    return None


def main():
    # Build src_players lookup. Index by:
    #   • full normalized key ("derrick henry" → "derrickhenry")
    #   • last-name only key (Discord chat often uses last-name only:
    #     "Extend Gibbs 2yrs", "Extend Kincaid 2 years")
    print('Fetching src_players…', file=sys.stderr)
    rows = d1("SELECT season, player_id, name, position FROM src_players;")
    by_name = defaultdict(list)
    by_last = defaultdict(list)
    for r in rows:
        nm = r.get('name') or ''
        if ',' in nm:
            last, first = nm.split(',', 1)
            last = last.strip()
            first = first.strip()
            nm_norm = f"{first} {last}"
        else:
            nm_norm = nm
            last = nm.split()[-1] if nm else ''
        key = normalize_player_key(nm_norm)
        last_key = normalize_player_key(last)
        record = {
            'id': str(r['player_id']),
            'name': nm_norm,
            'position': r.get('position', ''),
            'season': r.get('season'),
            'last': last,
        }
        if key:
            by_name[key].append(record)
        if last_key and last_key != key:
            by_last[last_key].append(record)
    print(f'  {len(rows)} player-seasons, {len(by_name)} unique names, '
          f'{len(by_last)} last-names', file=sys.stderr)

    # Aliases — Discord chat short-forms → MFL canonical name
    ALIASES = {
        'ceedee':           'CeeDee Lamb',
        'jsn':              'Jaxon Smith-Njigba',
        'wandale robinson': 'Wan\'Dale Robinson',
        'wan dale robinson':'Wan\'Dale Robinson',
        'kincaid':          'Dalton Kincaid',
        'achane':           'De\'Von Achane',
        'tykee smith':      'Tykee Smith',
        'r rice':           'Rachaad White',  # might be Rashee Rice — ambiguous, leave
        'gibbs':            'Jahmyr Gibbs',
    }

    # Parse all sources
    findings = []
    for src_label, path, base_url in SOURCES:
        if not path.exists():
            print(f'! missing: {path}', file=sys.stderr)
            continue
        with path.open(newline='') as f:
            r = csv.DictReader(f)
            n_msgs = 0
            n_matched = 0
            for msg in r:
                n_msgs += 1
                content = msg.get('Content', '') or ''
                if not re.search(r'\bextend', content, re.I):
                    continue
                # Skip pure commentary (no clear pattern match)
                match = find_extension(content)
                if not match:
                    continue
                player, term, pat_idx = match
                date = msg.get('Date', '')
                dt = parse_iso(date)
                if not dt:
                    continue
                author = msg.get('Author', '')
                # Author franchise is the SOURCE OF TRUTH for owner-typed
                # messages. Only fall back to OWNER_REF lookup if author
                # is commish (admin posting on someone's behalf).
                fid = AUTHOR_TO_FID.get(author)
                if not fid and author.lower().replace('_', '').startswith('upscommish'):
                    # commish post — look for owner reference in body
                    content_l = content.lower()
                    for ref, ref_fid in OWNER_REF_TO_FID.items():
                        if ref in content_l:
                            fid = ref_fid
                            break
                if not fid:
                    continue
                # Resolve player_id with cascading lookups:
                #   1. Alias check (CeeDee → Lamb, JSN → Smith-Njigba)
                #   2. Full-name key
                #   3. Last-name-only fallback
                player_lookup = ALIASES.get(player.lower().strip(), player)
                key = normalize_player_key(player_lookup)
                cands = by_name.get(key, [])
                if not cands:
                    cands = by_last.get(key, [])
                if not cands:
                    findings.append({
                        'source': src_label, 'date': date[:10], 'author': author,
                        'franchise_id': fid, 'player_raw': player,
                        'player_id': '', 'term': term,
                        'season': season_from_date(dt),
                        'content': content[:200].replace('\n',' '),
                        'match_status': 'no_player_match',
                        'pattern_idx': pat_idx,
                    })
                    continue
                # Prefer the one whose season matches
                target_season = season_from_date(dt)
                best = None
                for c in cands:
                    if int(c.get('season', 0)) == target_season:
                        best = c
                        break
                if not best:
                    best = cands[0]
                findings.append({
                    'source': src_label, 'date': date[:10], 'author': author,
                    'franchise_id': fid, 'player_raw': player,
                    'player_id': best['id'], 'player_name': best['name'],
                    'term': term, 'season': target_season,
                    'content': content[:200].replace('\n',' '),
                    'match_status': 'matched',
                    'pattern_idx': pat_idx,
                })
                n_matched += 1
        print(f'  {src_label}: {n_msgs} msgs, {n_matched} extension matches',
              file=sys.stderr)

    # Cross-check against ups_extension_master
    print('\nFetching ups_extension_master for cross-check…', file=sys.stderr)
    master = d1("""
        SELECT season, franchise_id, player_id, new_contract_status,
               extension_term_years, evidence_grade, evidence_source
        FROM ups_extension_master WHERE league_id = '74598';
    """)
    master_by_key = {(str(r['season']), str(r['player_id'])): r for r in master}

    for f in findings:
        key = (str(f['season']), str(f['player_id'] or ''))
        m = master_by_key.get(key)
        if m:
            f['master_grade'] = m.get('evidence_grade') or ''
            f['master_fr'] = m.get('franchise_id') or ''
            f['master_term'] = m.get('extension_term_years') or ''
            f['can_upgrade'] = (
                m.get('evidence_grade') == 'derived'
                and str(m.get('franchise_id')) == f['franchise_id']
            )
        else:
            f['master_grade'] = ''
            f['master_fr'] = ''
            f['master_term'] = ''
            f['can_upgrade'] = False

    # Write CSV
    out_csv = Path('/tmp/discord_extensions_parsed.csv')
    cols = ['source','date','author','franchise_id','season','player_id','player_name',
            'player_raw','term','master_grade','master_fr','master_term',
            'can_upgrade','match_status','pattern_idx','content']
    with out_csv.open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction='ignore')
        w.writeheader()
        for r in findings:
            w.writerow(r)
    print(f'\nWrote {len(findings)} findings to {out_csv}', file=sys.stderr)

    # Summary
    matched = [f for f in findings if f['match_status']=='matched']
    upgradable = [f for f in matched if f.get('can_upgrade')]
    print(f'\nSummary:')
    print(f'  total ext-messages parsed:     {len(findings)}')
    print(f'  player resolved (matched):     {len(matched)}')
    print(f'  in master as DERIVED (upgrade):{len(upgradable)}')

    # Emit UPDATE SQL to upgrade derived → evidenced
    out_sql = Path('/tmp/discord_extension_evidence_upserts.sql')
    with out_sql.open('w') as f:
        f.write("""-- 0068_extension_master_discord_evidence.sql
-- Upgrades evidence_grade='derived' rows to 'evidenced' for any
-- (season, player_id, franchise_id) we found a Discord extension
-- message confirming. Preserves derived contract details; just adds
-- the Discord URL + quote to evidence_source.

""")
        for u in upgradable:
            quote = (u['content'] or '').replace("'", "''")[:150]
            ev_src = f"discord:{u['source']}:{u['date']}:{u['author']}: \"{quote}\""
            ev_src_esc = ev_src.replace("'", "''")
            f.write(f"""UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | {ev_src_esc}',
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '{u['season']}'
   AND player_id   = '{u['player_id']}'
   AND franchise_id = '{u['franchise_id']}'
   AND evidence_grade = 'derived';
""")
    print(f'  wrote {len(upgradable)} UPDATE statements to {out_sql}')


if __name__ == '__main__':
    main()
