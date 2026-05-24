#!/usr/bin/env python3
"""
correct_extender_franchise.py — fix ups_extension_master rows where
the recorded franchise_id is the post-trade ACQUIRER (the player's
EOS franchise per src_contracts) instead of the actual EXTENDING
franchise (per contract_info "Ext: <owner>" token).

Per Keith 2026-05-24: the pre-trade extension is the trading-AWAY
team's last action; master.franchise_id must be the franchise that
DID THE EXTENSION. The current acquirer can still extend post-trade
per canon §C4 4-week window.

For every derived master row with an "Ext: <token>" in src_contracts'
contract_info, parse the token, map to franchise_id, and UPDATE the
row if it disagrees with the current franchise_id.

Output: /tmp/extender_franchise_corrections.sql
"""
from __future__ import annotations
import json, re, subprocess
from pathlib import Path

WORKER = Path('/Users/keithcreelman/Code/MFL/upsmflproduction/.claude/worktrees/keen-knuth-623b0f/worker')
OUT = Path('/tmp/extender_franchise_corrections.sql')

# Owner-token → franchise_id. Tokens come from contract_info "Ext: X"
# annotations. Multi-token entries ("Ext: Mafia, LH, C-Town") are
# ambiguous and skipped — these record multiple owners across the
# contract's history; need separate handling.
TOKEN_TO_FID = {
    # 0001 — L.A. Looks / Ulterior Warrior / Ryan
    'la looks': '0001', 'l.a. looks': '0001', 'la': '0001', 'looks': '0001',
    'uw': '0001', 'ulterior': '0001', 'ryan': '0001', 'rybo': '0001',
    # 0002 — CBP / Whitman
    'cbp': '0002', 'whitman': '0002',
    # 0003 — Gride / Matt
    'gride': '0003', 'gr': '0003', 'gr ride': '0003', 'matt': '0003',
    # 0004 — Pure Greatness / Brian Cutting
    'pg': '0004', 'pure greatness': '0004', 'cutting': '0004', 'brian cutting': '0004',
    # 0005 — HammerTime / Eric Martel
    'hammer': '0005', 'hammertime': '0005', '🔨 ⏰': '0005', '🔨⏰': '0005',
    'eric martel': '0005',
    # 0006 — The Long Haulers (2025+) / Main Event Mafia (2024) / Good in Da Hood (pre)
    'lh': '0006', 'long haulers': '0006', 'cross': '0006', 'brian cross': '0006',
    'mafia': '0006', 'main event mafia': '0006', 'main event': '0006',
    'good in da hood': '0006', 'steve': '0006',
    # 0007 — Sex Manther / Josh Martel
    'sex': '0007', 'manther': '0007', 'sex manther': '0007', 'josh martel': '0007',
    # 0008 — Real Deal Creel / #BLM / Keith
    'creel': '0008', 'real deal': '0008', 'real deal creel': '0008',
    'blm': '0008', '#blm': '0008', 'keith': '0008',
    # 0009 — C-Town Chivalry / Bear
    'c-town': '0009', 'ctown': '0009', 'chivalry': '0009', 'c town': '0009',
    'bear': '0009', 'papa bear': '0009',
    # 0010 — Blake Bombers / Shawn
    'blake': '0010', 'bomb': '0010', 'bombers': '0010', 'shawn': '0010',
    # 0011 — Cleon Ca$h / Eric Mannila
    'cleon': '0011', 'cash': '0011', 'ca$h': '0011', 'cleon ca$h': '0011',
    'eric mannila': '0011',
    # 0012 — Hawks / Chris Klingenberg
    'hawks': '0012', 'kling': '0012', 'chris': '0012',
}


def d1(sql):
    cp = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'ups-mfl-db', '--remote',
         '--command', sql, '--json'],
        cwd=str(WORKER), capture_output=True, text=True, check=True
    )
    data = json.loads(cp.stdout)
    return data[0]['results'] if isinstance(data, list) else data.get('results', [])


def parse_ext_token(contract_info: str) -> str | None:
    """Return franchise_id if contract_info has unambiguous Ext token,
    else None (no token, or multi-owner — needs manual review)."""
    if not contract_info:
        return None
    m = re.search(r'Ext\.?\s*[:\s]\s*([^|]+?)(?:\||$)', contract_info, re.I)
    if not m:
        return None
    raw = m.group(1).strip()
    # Multi-owner — comma or "and" separated
    parts = re.split(r'[,/]|\band\b', raw, flags=re.I)
    if len(parts) > 1:
        return None  # ambiguous; skip
    token = parts[0].strip().lower()
    # Strip trailing GTD info and other garbage
    token = re.sub(r'\s*gtd:.*$', '', token, flags=re.I).strip()
    return TOKEN_TO_FID.get(token)


def main():
    print('Fetching derived master rows with contract_info hints…')
    # Pull master rows + matching src_contracts contract_info
    rows = d1("""
        SELECT m.season, m.franchise_id, m.player_id, m.player_name,
               c.contract_info
        FROM ups_extension_master m
        LEFT JOIN src_contracts c
          ON c.season = CAST(m.season AS INTEGER)
         AND c.player_id = m.player_id
        WHERE m.league_id = '74598'
          AND m.evidence_grade = 'derived'
        ORDER BY CAST(m.season AS INTEGER), m.player_id;
    """)
    print(f'  {len(rows)} derived master rows')

    corrections = []
    ambiguous = []
    no_token = 0
    no_change = 0
    for r in rows:
        ext_fid = parse_ext_token(r.get('contract_info'))
        if ext_fid is None:
            if r.get('contract_info') and 'Ext' in (r.get('contract_info') or ''):
                ambiguous.append(r)
            else:
                no_token += 1
            continue
        if ext_fid == r['franchise_id']:
            no_change += 1
            continue
        corrections.append({**r, 'correct_fid': ext_fid})

    print(f'  corrections needed:  {len(corrections)}')
    print(f'  multi-owner (skip):  {len(ambiguous)}')
    print(f'  no Ext token:        {no_token}')
    print(f'  already correct:     {no_change}')

    with OUT.open('w') as f:
        f.write("""-- 0072_extension_master_extender_franchise_fix.sql
-- Per Keith 2026-05-24 + reconciliation pass: rows where master
-- franchise_id was set to the post-trade EOS franchise (acquirer)
-- but contract_info "Ext: <owner>" identifies a DIFFERENT extending
-- franchise. The pre-trade extension is the trading-away team's last
-- action; master must record the extender, not the receiver.
--
-- Examples:
--   • Jordan Love 2024 master fr=0002 (CBP) but "Ext: PG" → fr=0004
--   • Michael Pittman 2025 master fr=0003 (Gride) but "Ext: PG" → fr=0004
--   • DeVonta Smith 2024 master fr=0002 (CBP) but "Ext: GR" → fr=0003
--
-- Multi-owner annotations like "Ext: Mafia, LH, C-Town" are SKIPPED
-- here — those record multiple owners across the contract's history
-- and need manual review.

""")
        for c in corrections:
            f.write(f"""UPDATE ups_extension_master
   SET franchise_id    = '{c['correct_fid']}',
       evidence_source = COALESCE(evidence_source,'') || ' | extender_fix:was_fr={c['franchise_id']}_per_ci_Ext_token',
       updated_at_utc  = datetime('now')
 WHERE league_id = '74598'
   AND season    = '{c['season']}'
   AND player_id = '{c['player_id']}';
""")

    print(f'\nWrote {len(corrections)} UPDATEs to {OUT}')
    if ambiguous:
        print(f'\nAmbiguous (multi-owner) — manual review needed:')
        for r in ambiguous[:15]:
            ci = (r.get('contract_info') or '')
            ext_part = re.search(r'Ext[\.\s:][^|]+', ci, re.I)
            print(f"  {r['season']} fr={r['franchise_id']} {r['player_name'][:20]:<20} → {ext_part.group(0)[:60] if ext_part else '?'}")


if __name__ == '__main__':
    main()
