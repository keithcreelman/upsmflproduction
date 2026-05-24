#!/usr/bin/env python3
"""
update_derived_terms.py — recompute extension_term_years for every
ups_extension_master row with evidence_grade='derived' using the
canonical carry-based formula:

    term = cl - carry
    carry = 0 if prev was Rookie cy=1
    carry = 1 otherwise

Writes /tmp/extension_master_term_updates.sql for review + apply.

Doesn't touch 'evidenced' rows (those have authoritative source data).
"""
from __future__ import annotations
import json
import subprocess
from collections import defaultdict
from pathlib import Path

REPO = Path('/Users/keithcreelman/Code/MFL/upsmflproduction/.claude/worktrees/keen-knuth-623b0f')
WORKER = REPO / 'worker'
OUT = Path('/tmp/extension_master_term_updates.sql')


def d1(sql):
    cp = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'ups-mfl-db', '--remote',
         '--command', sql, '--json'],
        cwd=str(WORKER), capture_output=True, text=True, check=True
    )
    data = json.loads(cp.stdout)
    return data[0]['results'] if isinstance(data, list) else data.get('results', [])


def safe_int(v, d=0):
    try:
        return int(v) if v not in (None, '', 'None') else d
    except (TypeError, ValueError):
        return d


def main():
    print('Fetching derived master rows with NULL term…')
    derived = d1("""
        SELECT season, player_id, franchise_id
        FROM ups_extension_master
        WHERE evidence_grade = 'derived'
          AND extension_term_years IS NULL
        ORDER BY player_id, CAST(season AS INTEGER);
    """)
    print(f'  {len(derived)} rows to recompute')
    if not derived:
        return

    pids = sorted({r['player_id'] for r in derived})
    pid_clause = ','.join(f"'{p}'" for p in pids)
    print(f'  fetching src_contracts for {len(pids)} players…')
    contracts = d1(f"""
        SELECT season, player_id, contract_status, contract_year, contract_length
        FROM src_contracts
        WHERE player_id IN ({pid_clause})
        ORDER BY player_id, season;
    """)
    chains = defaultdict(list)
    for r in contracts:
        chains[str(r['player_id'])].append(r)
    for pid in chains:
        chains[pid].sort(key=lambda r: safe_int(r['season']))

    updates = []
    unchanged = 0
    for row in derived:
        pid = str(row['player_id'])
        season = safe_int(row['season'])
        chain = chains.get(pid, [])
        curr = next((c for c in chain if safe_int(c['season']) == season), None)
        if not curr:
            continue
        curr_cl = safe_int(curr['contract_length'])
        if curr_cl < 1:
            continue
        prev = next((c for c in reversed(chain)
                     if safe_int(c['season']) < season), None)
        if not prev:
            term = max(0, curr_cl - 1)
        else:
            prev_cy = safe_int(prev['contract_year'])
            prev_status = (prev.get('contract_status') or '').upper()
            if prev_status.startswith('ROOKIE') and prev_cy == 1:
                term = curr_cl
            else:
                term = max(0, curr_cl - 1)
        if term <= 0:
            unchanged += 1
            continue
        updates.append({
            'season': row['season'],
            'player_id': pid,
            'term': term,
        })

    print(f'  computed terms for {len(updates)} rows; {unchanged} unchanged')

    with OUT.open('w') as f:
        f.write("""-- 0067_extension_master_derived_terms_recompute.sql
-- Recomputes extension_term_years for every evidence_grade='derived'
-- row using the canonical carry formula (Keith 2026-05-24):
--   term = contract_length - carry
--   carry = 0 if prev season was Rookie cy=1, else 1
--
-- Only touches rows where term is currently NULL AND grade='derived'.
-- Doesn't touch evidenced rows.

""")
        for u in updates:
            f.write(f"""UPDATE ups_extension_master
   SET extension_term_years = {u['term']},
       updated_at_utc = datetime('now')
 WHERE league_id = '74598'
   AND season = '{u['season']}'
   AND player_id = '{u['player_id']}'
   AND evidence_grade = 'derived'
   AND extension_term_years IS NULL;
""")
    print(f'\nWrote {len(updates)} UPDATEs to {OUT}')


if __name__ == '__main__':
    main()
