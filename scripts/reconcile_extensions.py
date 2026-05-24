#!/usr/bin/env python3
"""
reconcile_extensions.py — derive vs. source comparison for every row in
ups_extension_master.

For each player_id that has either:
  • A row in ups_extension_master (any season), OR
  • An "extension signal" in src_contracts (contractStatus starts with EXT,
    OR contract_info contains an "Ext " / "Ext:" token)

…walk their full year-by-year contract chain from src_contracts and
classify each season:
  • evidence + derived   — master row exists AND MFL chain signals
                           an extension in that season.
  • evidence only        — master row exists but no derivation signal
                           (xlsx/forum might have mis-classified, OR
                           our derivation is missing a case).
  • derived only         — MFL chain signals extension but no master
                           row (source mining missed it).
  • evidence unverifiable — master row exists but src_contracts has
                           no data for that season (pre-2017 mostly).

Output: writes
  /tmp/extension_reconciliation.md   — full report by player
  /tmp/extension_reconciliation.csv  — flat table for sorting/filtering

Reads from D1 (remote) via wrangler. No D1 writes.

Canon basis (docs/league_context_v1.md §C4):
  • Extensions yield contractStatus = EXT1 / EXT2 (or EXT2-FL / EXT2-BL).
  • AAV escalator per position (RB/WR/TE/QB Sched 1: +10K/1yr, +20K/2yr;
    DL/LB/DB/K Sched 2: +3K/1yr, +5K/2yr).
  • TCV = sum of remaining year salaries (current year stays, extension
    years take new AAV).
  • contract_info often carries an "Ext: <token>" annotation pre-2021;
    year-list tokens like "'19/20" pin which years were extended.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path

REPO_ROOT = Path('/Users/keithcreelman/Code/MFL/upsmflproduction')
WORKER_DIR = REPO_ROOT / '.claude/worktrees/keen-knuth-623b0f/worker'


def d1_query(sql: str) -> list[dict]:
    """Run a read-only SELECT against remote D1 and return rows."""
    cp = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'ups-mfl-db', '--remote',
         '--command', sql, '--json'],
        cwd=str(WORKER_DIR), capture_output=True, text=True, check=True
    )
    data = json.loads(cp.stdout)
    return data[0]['results'] if isinstance(data, list) else data.get('results', [])


def safe_int(v, d=0):
    try:
        return int(v) if v is not None and str(v).strip() != '' else d
    except (TypeError, ValueError):
        return d


def has_extension_signal(row: dict) -> bool:
    """Does this src_contracts row suggest an extension event in this
    season?

    Excludes:
      • "Extension Available" — MFL UI label for eligibility, NOT an
        executed extension. (2011 had 25 such rows that were tripping
        my derivation; they're status hints, not events.)
      • Restructure rows — canon §C5 restructure has extension_flag=1
        but doesn't add years (only redistributes salary). Exclude
        rows with 'Restructure' / 'Restructured' / 'RESTRUCTURED'
        contract_status.
      • Tag rows — Franchise/Transition tags also can have ext_flag set;
        tagged players cannot be extended per canon §C6.
    """
    status = (row.get('contract_status') or '').strip()
    status_u = status.upper()
    # Hard exclusions — these aren't extensions even if ext_flag is set
    # or contract_info has tokens.
    if 'RESTRUCTUR' in status_u:
        return False
    if 'FRANCHISE' in status_u or 'TRANSITION' in status_u:
        return False
    # Pure EXT-prefixed status (EXT1, EXT2, EXT2-FL, EXT2-BL) is the
    # signal. "Extension Available" / "Extension Eligible" is NOT.
    if status_u.startswith('EXT') and 'EXTENSION' not in status_u:
        return True
    if safe_int(row.get('extension_flag')) == 1:
        return True
    ci = (row.get('contract_info') or '').lower()
    # "Ext:" / "Ext." / "Ext " token followed by owner abbreviation.
    # Matches: "Ext: GRide", "Ext. Hawks", "Ext PG", "Ext BLM '20".
    if re.search(r'\bext\.?\s*[:\s]\s*[A-Za-z]', ci):
        return True
    # Pre-2021 year-list annotations:
    #   '19/20  '21/'22       (paired years — already caught)
    #   '20                   (single year stamp after "Ext.")
    if re.search(r"'\d{2}\s*/\s*'?\d{2}", ci):
        return True
    # Single-year stamp like " '19" or " '20" — but ONLY when paired
    # with an "Ext" marker earlier in the string (avoid false-positives
    # on "Tag '18" / "Tagged '17" etc. — though those are tag rows
    # already excluded by status check).
    if re.search(r'\bext\b', ci) and re.search(r"\s'\d{2}\b", ci):
        return True
    return False


def derive_contract_status(row: dict, term: int | None) -> str:
    """Normalize the derived contract_status to canonical EXT1 / EXT2
    (with FL/BL suffix if loaded). Used when populating ups_extension_master
    for derived-only rows where src_contracts status may be 'Veteran'
    (post-extension MFL relabel) or 'BL' (loaded extension).

    Returns 'EXT1', 'EXT2', 'EXT2-FL', 'EXT2-BL', or '' if undetermined.
    """
    status_u = (row.get('contract_status') or '').upper().strip()
    # If MFL still labels it EXT*, use that directly.
    if status_u.startswith('EXT') and 'EXTENSION' not in status_u:
        return status_u  # EXT1, EXT2, EXT2-FL, EXT2-BL
    # Otherwise derive from term
    if term == 1:
        return 'EXT1'
    if term == 2:
        # Detect loaded contracts by status suffix on src_contracts row
        if status_u == 'FL':
            return 'EXT2-FL'
        if status_u == 'BL':
            return 'EXT2-BL'
        # Could also detect from year_values being unequal but term=2;
        # leave as plain EXT2 for now.
        return 'EXT2'
    return ''


def parse_extension_term_from_chain(curr: dict, prev: dict | None) -> int | None:
    """Per Keith 2026-05-24: derivation logic for extension term.

    An extension always works the same way structurally:
      • Some number of CARRY years (already on contract) become Y1, Y2…
      • The TERM years (1 or 2 per canon) append onto the back.
      • total cl = carry + term.

    Carry equals:
      • 0 if prev season was Rookie with cy=1 (expired rookie gets a
        fresh contract — every year of the new cl is an extension year).
      • 1 if prev season was Vet / EXT / Tag / BL / FL / etc with
        cy >= 1 (one year carries into the new contract as Y1).
      • If no prev row, can't tell carry — best guess curr_cl - 1.

    So term = cl - carry.

    Worked examples Keith confirmed (Derrick Henry):
      • 2019 (prev=Rookie cy=1 in 2018) → cl=2, carry=0 → term=2 ✓ EXT2
      • 2020 (prev=Veteran GF cy=2 in 2019) → cl=3, carry=1 → term=2 ✓ EXT2
        (Blake's mid-contract extension added 2 years onto remaining year)
      • 2025 (prev=BL cy=2 in 2024) → cl=2, carry=1 → term=1 ✓ EXT1
        (LH added 1 year onto Y2 of Gride's 2024 BL deal)
      • 2021 PG xlsx entry — DOES NOT FIRE because no extension signal
        in 2021 chain (cl unchanged, no Ext token). Correctly identified
        as data-entry error.
    """
    curr_cl = safe_int(curr.get('contract_length'), 0)
    if not prev:
        # Best guess: assume 1 year of carry (common case).
        return max(0, curr_cl - 1) if curr_cl >= 1 else None

    prev_cy = safe_int(prev.get('contract_year'), 0)
    prev_status = (prev.get('contract_status') or '').upper()

    # Expired rookie → fresh contract, no carry.
    if prev_status.startswith('ROOKIE') and prev_cy == 1:
        return curr_cl

    # Everything else carries one year.
    return max(0, curr_cl - 1) if curr_cl >= 1 else None


def derive_extension_events(player_chain: list[dict]) -> list[dict]:
    """For one player's year-sorted src_contracts rows, return a list
    of derived extension events: [{season, franchise_id, term, signals, ...}]."""
    out = []
    chain = sorted(player_chain, key=lambda r: safe_int(r.get('season')))
    for i, row in enumerate(chain):
        if not has_extension_signal(row):
            continue
        prev = chain[i - 1] if i > 0 else None
        # Skip if previous year ALSO had EXT status — means the EXT contract
        # is just rolling forward (we already recorded the event in the
        # season it started). The "event year" is when EXT first appears
        # OR when contract_length grows.
        if prev:
            prev_status = (prev.get('contract_status') or '').upper()
            curr_status = (row.get('contract_status') or '').upper()
            prev_cl = safe_int(prev.get('contract_length'), 0)
            curr_cl = safe_int(row.get('contract_length'), 0)
            # If both are EXT and cl didn't grow, this is a rollforward.
            if (prev_status.startswith('EXT') and curr_status.startswith('EXT')
                    and curr_cl <= prev_cl):
                continue
        term = parse_extension_term_from_chain(row, prev)
        out.append({
            'season': safe_int(row.get('season')),
            'franchise_id': row.get('franchise_id') or '',
            'contract_status': row.get('contract_status') or '',
            'contract_year': safe_int(row.get('contract_year')),
            'contract_length': safe_int(row.get('contract_length')),
            'salary': safe_int(row.get('salary')),
            'contract_info': row.get('contract_info') or '',
            'derived_term': term,
            'signals': [
                s for s, present in [
                    ('status_starts_with_ext',
                     (row.get('contract_status') or '').upper().startswith('EXT')),
                    ('extension_flag',
                     safe_int(row.get('extension_flag')) == 1),
                    ('ci_ext_token',
                     bool(re.search(r'\bext\s*[:\s][A-Za-z]',
                                    (row.get('contract_info') or '').lower()))),
                    ('ci_year_list',
                     bool(re.search(r"'\d{2}\s*/\s*'?\d{2}",
                                    row.get('contract_info') or ''))),
                ] if present
            ],
        })
    return out


def main():
    print('Fetching ups_extension_master…', file=sys.stderr)
    master = d1_query("""
        SELECT season, franchise_id, player_id, player_name, position,
               new_contract_status, extension_term_years, new_salary, new_aav,
               source, evidence_grade, evidence_source
        FROM ups_extension_master
        ORDER BY player_id, CAST(season AS INTEGER);
    """)
    print(f'  master rows: {len(master)}', file=sys.stderr)

    master_by_player: dict[str, list[dict]] = defaultdict(list)
    for r in master:
        master_by_player[str(r['player_id'])].append(r)

    print('Fetching src_contracts for all master + EXT-signal players…',
          file=sys.stderr)
    # Pull ALL src_contracts rows for any player_id in master OR with
    # an extension signal anywhere. To keep the query simple, pull all
    # src_contracts and filter in Python (it's ~50K rows).
    contracts = d1_query("""
        SELECT season, franchise_id, player_id, contract_status,
               contract_year, contract_length, salary, contract_info,
               extension_flag, year_values_json
        FROM src_contracts
        WHERE player_id IS NOT NULL AND player_id != ''
        ORDER BY player_id, season;
    """)
    print(f'  src_contracts rows: {len(contracts)}', file=sys.stderr)

    contracts_by_player: dict[str, list[dict]] = defaultdict(list)
    for r in contracts:
        contracts_by_player[str(r['player_id'])].append(r)

    # Players to analyze: union of master + EXT-signal contracts.
    ext_signal_players = {
        pid for pid, rows in contracts_by_player.items()
        if any(has_extension_signal(r) for r in rows)
    }
    analyze_pids = set(master_by_player.keys()) | ext_signal_players
    print(f'  players to analyze: {len(analyze_pids)} '
          f'({len(master_by_player)} master + '
          f'{len(ext_signal_players - master_by_player.keys())} derive-only)',
          file=sys.stderr)

    # Player name lookup via src_players (most recent season wins).
    print('Fetching src_players names…', file=sys.stderr)
    players_rows = d1_query("""
        SELECT player_id, name, position, MAX(season) AS season
        FROM src_players
        GROUP BY player_id;
    """)
    name_by_pid = {str(r['player_id']): (r['name'] or '', r['position'] or '')
                   for r in players_rows}
    print(f'  src_players entries: {len(name_by_pid)}', file=sys.stderr)

    # Build reconciliation
    classifications = {'evidence+derived': 0, 'evidence_only': 0,
                       'derived_only': 0, 'evidence_unverifiable': 0}
    per_row_records = []
    per_player_summary = []

    for pid in sorted(analyze_pids):
        chain = contracts_by_player.get(pid, [])
        chain_seasons = {safe_int(r.get('season')) for r in chain}
        derived = derive_extension_events(chain)
        derived_by_season = {d['season']: d for d in derived}
        master_rows = master_by_player.get(pid, [])
        master_by_season = {safe_int(r['season']): r for r in master_rows}

        name, position = name_by_pid.get(pid, ('?', ''))
        if not name and master_rows:
            name = master_rows[0].get('player_name') or '?'

        # Walk both sets
        all_seasons = sorted(set(master_by_season) | set(derived_by_season))
        player_record = {'pid': pid, 'name': name, 'position': position,
                         'rows': []}
        for season in all_seasons:
            mrow = master_by_season.get(season)
            drow = derived_by_season.get(season)
            if mrow and drow:
                cls = 'evidence+derived'
            elif mrow and not drow:
                # If src_contracts has no row for this season at all,
                # mark as unverifiable rather than evidence_only.
                cls = 'evidence_unverifiable' if season not in chain_seasons \
                      else 'evidence_only'
            elif drow and not mrow:
                cls = 'derived_only'
            else:
                continue
            classifications[cls] += 1
            rec = {
                'classification': cls,
                'season': season,
                'pid': pid,
                'name': name,
                'position': position,
                'master_franchise': mrow.get('franchise_id') if mrow else '',
                'master_status': mrow.get('new_contract_status') if mrow else '',
                'master_term': mrow.get('extension_term_years') if mrow else '',
                'master_aav': mrow.get('new_aav') if mrow else '',
                'master_evidence_source': mrow.get('evidence_source') if mrow else '',
                'derived_franchise': drow.get('franchise_id') if drow else '',
                'derived_status': drow.get('contract_status') if drow else '',
                'derived_term': drow.get('derived_term') if drow else '',
                'derived_salary': drow.get('salary') if drow else '',
                'derived_signals': ','.join(drow.get('signals') or []) if drow else '',
                'derived_contract_info': (drow.get('contract_info') or '')[:80] if drow else '',
                'mismatch_notes': '',
            }
            # Flag franchise mismatches when both present
            if mrow and drow:
                if str(mrow.get('franchise_id')) != str(drow.get('franchise_id')):
                    rec['mismatch_notes'] += f"franchise: master={mrow.get('franchise_id')} vs derived={drow.get('franchise_id')}; "
                if mrow.get('extension_term_years') and drow.get('derived_term') and \
                        mrow['extension_term_years'] != drow['derived_term']:
                    rec['mismatch_notes'] += f"term: master={mrow['extension_term_years']} vs derived={drow['derived_term']}; "
            per_row_records.append(rec)
            player_record['rows'].append(rec)
        per_player_summary.append(player_record)

    # Write CSV
    import csv
    out_csv = Path('/tmp/extension_reconciliation.csv')
    with out_csv.open('w', newline='') as f:
        if per_row_records:
            w = csv.DictWriter(f, fieldnames=list(per_row_records[0].keys()))
            w.writeheader()
            for r in per_row_records:
                w.writerow(r)
    print(f'\nWrote {len(per_row_records)} rows to {out_csv}', file=sys.stderr)

    # Write markdown report
    out_md = Path('/tmp/extension_reconciliation.md')
    with out_md.open('w') as f:
        f.write('# Extension Reconciliation Report\n\n')
        f.write('Canon §C4 derive vs source comparison for every row in '
                '`ups_extension_master` (plus any extension events found in '
                '`src_contracts` not yet in master).\n\n')
        f.write(f'**Generated:** {subprocess.check_output(["date", "-u", "+%Y-%m-%dT%H:%M:%SZ"]).decode().strip()}\n\n')
        f.write('## Summary\n\n')
        total = sum(classifications.values())
        f.write(f'| Classification | Count | % |\n|---|---:|---:|\n')
        for cls in ('evidence+derived', 'evidence_only', 'derived_only',
                    'evidence_unverifiable'):
            n = classifications[cls]
            pct = (100.0 * n / total) if total else 0
            f.write(f'| {cls} | {n} | {pct:.1f}% |\n')
        f.write(f'| **TOTAL** | **{total}** | |\n\n')
        f.write('### Classification meaning\n\n')
        f.write('- **evidence+derived** — master row exists AND MFL chain '
                'signals an extension in that season. *Highest confidence.*\n')
        f.write('- **evidence_only** — master row exists but no derivation '
                'signal in MFL chain. Either (a) source is wrong, '
                '(b) derivation logic is missing a case, or '
                '(c) the salary chain rolled the extension into an existing '
                'contract without changing status/length. **Needs review.**\n')
        f.write('- **derived_only** — MFL chain signals an extension but no '
                'master row. Source mining missed this extension. '
                '**Needs backfill.**\n')
        f.write('- **evidence_unverifiable** — master row exists but '
                '`src_contracts` has no data for that season (pre-2017 '
                'mostly). Can\'t derive; trust the source.\n\n')

        # By season
        by_season = defaultdict(lambda: defaultdict(int))
        for r in per_row_records:
            by_season[safe_int(r['season'])][r['classification']] += 1
        f.write('## By season\n\n')
        f.write('| Season | evidence+derived | evidence_only | derived_only | evidence_unverifiable |\n')
        f.write('|---:|---:|---:|---:|---:|\n')
        for s in sorted(by_season):
            row = by_season[s]
            f.write(f'| {s} | {row["evidence+derived"]} | {row["evidence_only"]} | '
                    f'{row["derived_only"]} | {row["evidence_unverifiable"]} |\n')
        f.write('\n')

        # Per-player detail — group by classification for quick scanning
        for header_cls, label in [
            ('evidence_only', '## Evidence only (needs review)'),
            ('derived_only', '## Derived only (missing from master)'),
            ('evidence+derived', '## Evidence + derived (✅ confirmed)'),
            ('evidence_unverifiable', '## Evidence unverifiable (no src_contracts data)'),
        ]:
            matched = [r for r in per_row_records
                       if r['classification'] == header_cls]
            f.write(f'\n{label}\n\n')
            f.write(f'_{len(matched)} rows_\n\n')
            if not matched:
                f.write('_(none)_\n')
                continue
            f.write('| Season | Player (pid) | Pos | Master Fr / Status / Term / AAV | '
                    'Derived Fr / Status / Term / $ | Signals | Notes |\n')
            f.write('|---:|---|---|---|---|---|---|\n')
            for r in sorted(matched, key=lambda x: (safe_int(x['season']),
                                                    str(x['name']))):
                mfr = r['master_franchise']
                mst = r['master_status']
                mt = r['master_term']
                ma = r['master_aav']
                dfr = r['derived_franchise']
                ds = r['derived_status']
                dt = r['derived_term']
                dsl = r['derived_salary']
                sigs = r['derived_signals']
                notes = r['mismatch_notes'] or r['derived_contract_info']
                f.write(f"| {r['season']} | {r['name']} ({r['pid']}) | {r['position']} | "
                        f"{mfr or '—'} / {mst or '—'} / {mt or '—'} / {ma or '—'} | "
                        f"{dfr or '—'} / {ds or '—'} / {dt or '—'} / ${dsl or '—'} | "
                        f"{sigs or '—'} | {notes} |\n")
        f.write('\n')

    print(f'Wrote markdown report to {out_md}', file=sys.stderr)
    print(f'\n=== Summary ===', file=sys.stderr)
    for cls, n in classifications.items():
        print(f'  {cls}: {n}', file=sys.stderr)


if __name__ == '__main__':
    main()
