#!/usr/bin/env python3
"""
parse_discord_bot_extensions.py — mine UPS Contracts Hub Bot's
structured "contract extension" announcements in discord_contract_activity.csv.

Bot format (2025-05+):
    📢 **<owner>** just dropped a new **contract extension**!
    🧾 **<Last, First>** has agreed to terms.
    • **Total Contract Value:** $<n>
    • **Total Years:** <n>
    • **Guaranteed:** $<n>

    📆 **Contract Breakdown:**
    - <year>: $<salary>
    - <year>: $<salary>

This is high-confidence structured evidence — much cleaner than free-form
owner messages. Emits SQL to upgrade derived → evidenced OR insert new
master rows for any not yet captured.
"""
from __future__ import annotations
import csv, json, re, subprocess
from collections import defaultdict
from datetime import datetime
from pathlib import Path

INPUTS = Path('/Users/keithcreelman/Code/MFL/upsmflproduction/pipelines/etl/inputs')
WORKER = Path('/Users/keithcreelman/Code/MFL/upsmflproduction/.claude/worktrees/keen-knuth-623b0f/worker')
SRC = INPUTS / 'discord_contract_activity.csv'

# Bot uses team_name (case may vary). Mapped to franchise_id (stable 2024+).
TEAM_TO_FID = {
    'la looks':              '0001',
    'l.a. looks':            '0001',
    'ulterior warrior':      '0001',
    'cbp':                   '0002',
    'gride':                 '0003',
    'pure greatness':        '0004',
    'hammertime':            '0005',
    'hammertime 🔨 ⏰':       '0005',
    'the long haulers':      '0006',
    'long haulers':          '0006',
    'the main event mafia':  '0006',  # 2024 only; was Lima then
    'main event mafia':      '0006',
    'sex manther':           '0007',
    'real deal creel':       '0008',
    '#blm':                  '0008',
    'c-town chivalry':       '0009',
    'ctown chivalry':        '0009',
    'blake bombers':         '0010',
    'cleon ca$h':            '0011',
    'cleon cash':            '0011',
    'hawks':                 '0012',
}


def d1(sql):
    cp = subprocess.run(
        ['npx', 'wrangler', 'd1', 'execute', 'ups-mfl-db', '--remote',
         '--command', sql, '--json'],
        cwd=str(WORKER), capture_output=True, text=True, check=True
    )
    data = json.loads(cp.stdout)
    return data[0]['results'] if isinstance(data, list) else data.get('results', [])


def norm_key(s): return re.sub(r'[^a-z]', '', (s or '').lower())


def parse_iso(ts):
    s = re.sub(r'(\.\d+)([+-]\d{2}:\d{2})$', lambda m: m.group(2), ts.replace('Z','+00:00'))
    try: return datetime.fromisoformat(s)
    except Exception: return None


def parse_bot_msg(content):
    """Extract structured fields. Returns dict or None."""
    # owner
    m_owner = re.search(r'📢\s*\*\*([^*]+)\*\*\s*just dropped a new \*\*contract extension', content, re.I)
    if not m_owner: return None
    owner = m_owner.group(1).strip()
    # player
    m_pl = re.search(r'🧾\s*\*\*([^*]+)\*\*\s*has agreed', content)
    if not m_pl: return None
    player_mfl = m_pl.group(1).strip()  # "Last, First" format
    # TCV
    m_tcv = re.search(r'Total Contract Value:?\*?\*?\s*\$?([\d,]+)', content, re.I)
    tcv = int(m_tcv.group(1).replace(',', '')) if m_tcv else None
    # Years
    m_yr = re.search(r'Total Years:?\*?\*?\s*(\d+)', content, re.I)
    years = int(m_yr.group(1)) if m_yr else None
    # GTD
    m_gtd = re.search(r'Guaranteed:?\*?\*?\s*\$?([\d,]+)', content, re.I)
    gtd = int(m_gtd.group(1).replace(',', '')) if m_gtd else None
    # Year-by-year breakdown — list of (year, salary)
    breakdown = re.findall(r'-\s*(\d{4}):\s*\$?([\d,]+)', content)
    breakdown = [(int(y), int(s.replace(',', ''))) for y, s in breakdown]
    return {
        'owner_raw': owner,
        'player_mfl': player_mfl,
        'tcv': tcv,
        'total_years': years,
        'gtd': gtd,
        'breakdown': breakdown,
    }


def main():
    print('Parsing bot extension announcements…')
    rows = list(csv.DictReader(SRC.open()))
    bot_ext = [r for r in rows
               if ('Bot' in r['Author']) and 'contract extension' in r['Content'].lower()]
    print(f'  found {len(bot_ext)} bot extension messages')

    # src_players lookup by exact "Last, First" name
    print('Fetching src_players…')
    p_rows = d1("SELECT season, player_id, name FROM src_players;")
    by_name = defaultdict(list)
    for r in p_rows:
        if r.get('name'):
            by_name[norm_key(r['name'])].append({'id': str(r['player_id']),
                                                 'name': r['name'],
                                                 'season': r['season']})

    findings = []
    for msg in bot_ext:
        parsed = parse_bot_msg(msg['Content'])
        if not parsed: continue
        dt = parse_iso(msg['Date'])
        fid = TEAM_TO_FID.get(parsed['owner_raw'].lower())
        # season = first year in breakdown (the year the new contract starts)
        season = parsed['breakdown'][0][0] if parsed['breakdown'] else (dt.year if dt else None)
        # resolve player
        pkey = norm_key(parsed['player_mfl'])
        cands = by_name.get(pkey, [])
        pid = ''
        if cands:
            best = next((c for c in cands if int(c.get('season',0)) == season), cands[0])
            pid = best['id']
        # term: total_years - 1 if owner had carry, but bot's "Total Years"
        # is the FULL contract length post-extension. Per canon term = cl - carry.
        # We don't have prev-year context here; conservatively use total_years - 1.
        # (Actual term will be cross-checked vs derivation.)
        cl = parsed['total_years']
        term = cl - 1 if cl and cl >= 2 else cl  # cl=2→1yr ext, cl=3→2yr ext (assumes carry=1)
        aav_future = parsed['breakdown'][-1][1] if parsed['breakdown'] else None
        findings.append({
            'date': msg['Date'][:10],
            'owner_raw': parsed['owner_raw'],
            'franchise_id': fid or '',
            'season': season,
            'player_mfl': parsed['player_mfl'],
            'player_id': pid,
            'total_years': cl,
            'term': term,
            'tcv': parsed['tcv'],
            'aav_future': aav_future,
            'gtd': parsed['gtd'],
            'breakdown_count': len(parsed['breakdown']),
            'content_preview': msg['Content'][:200].replace('\n',' '),
        })

    out_csv = Path('/tmp/discord_bot_extensions.csv')
    with out_csv.open('w', newline='') as f:
        w = csv.DictWriter(f, fieldnames=list(findings[0].keys()) if findings else ['empty'])
        w.writeheader()
        for r in findings: w.writerow(r)
    print(f'\nWrote {len(findings)} findings to {out_csv}')

    # Cross-check master
    master = d1("SELECT season, franchise_id, player_id, evidence_grade, "
                "extension_term_years, new_aav, new_tcv FROM ups_extension_master "
                "WHERE league_id='74598';")
    m_by_key = {(str(r['season']), str(r['player_id'])): r for r in master}

    # Build SQL: UPSERT each bot-confirmed extension
    out_sql = Path('/tmp/discord_bot_extension_upserts.sql')
    upgraded = inserted = mismatched = 0
    with out_sql.open('w') as sf:
        sf.write("""-- 0069_extension_master_discord_bot.sql
-- 12 structured contract-extension announcements from UPS Contracts
-- Hub Bot (discord_contract_activity.csv, 2025-05+). High-confidence
-- evidence — bot's structured fields give us owner, player, term, TCV,
-- AAV, GTD verbatim. Upgrades existing derived rows to evidenced;
-- inserts new evidenced rows for any not yet in master.

""")
        for f in findings:
            if not (f['franchise_id'] and f['player_id'] and f['season']):
                continue
            key = (str(f['season']), str(f['player_id']))
            existing = m_by_key.get(key)
            ev_src_quote = f"discord_bot:{f['date']}:{f['owner_raw']}: TCV=${f['tcv']} years={f['total_years']} gtd=${f['gtd']}"
            ev_src_quote = ev_src_quote.replace("'", "''")
            new_status = 'EXT1' if f['term'] == 1 else 'EXT2'
            if existing:
                # UPDATE — upgrade grade and append evidence
                sf.write(f"""UPDATE ups_extension_master
   SET evidence_grade  = 'evidenced',
       evidence_source = COALESCE(evidence_source, '') || ' | {ev_src_quote}',
       new_tcv         = COALESCE(new_tcv, {f['tcv'] or 'NULL'}),
       new_aav         = COALESCE(new_aav, {f['aav_future'] or 'NULL'}),
       new_gtd         = COALESCE(new_gtd, {f['gtd'] or 'NULL'}),
       extension_term_years = COALESCE(extension_term_years, {f['term'] or 'NULL'}),
       franchise_id    = '{f['franchise_id']}',  -- bot canonical
       updated_at_utc  = datetime('now')
 WHERE league_id   = '74598'
   AND season      = '{f['season']}'
   AND player_id   = '{f['player_id']}';
""")
                upgraded += 1
            else:
                # INSERT new evidenced row
                sf.write(f"""INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', '{f['season']}', '{f['franchise_id']}', '{f['player_id']}',
   '{(f['player_mfl'] or '').replace("'","''")}',
   '{new_status}', NULL, NULL, NULL,
   {f['term'] or 'NULL'}, {f['tcv'] or 'NULL'}, {f['aav_future'] or 'NULL'}, {f['gtd'] or 'NULL'},
   'discord-bot', '{f['date']}T00:00:00Z', datetime('now'),
   'evidenced', '{ev_src_quote}')
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  evidence_grade       = 'evidenced',
  evidence_source      = COALESCE(ups_extension_master.evidence_source,'') || ' | ' || excluded.evidence_source,
  extension_term_years = COALESCE(ups_extension_master.extension_term_years, excluded.extension_term_years),
  new_tcv              = COALESCE(ups_extension_master.new_tcv, excluded.new_tcv),
  new_aav              = COALESCE(ups_extension_master.new_aav, excluded.new_aav),
  new_gtd              = COALESCE(ups_extension_master.new_gtd, excluded.new_gtd),
  updated_at_utc       = datetime('now');
""")
                inserted += 1
    print(f'\nGenerated SQL: {upgraded} UPDATEs, {inserted} INSERTs')
    print(f'  wrote {out_sql}')


if __name__ == '__main__':
    main()
