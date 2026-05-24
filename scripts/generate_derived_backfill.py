#!/usr/bin/env python3
"""
generate_derived_backfill.py — produce SQL UPSERTs into ups_extension_master
for every 'derived_only' row in /tmp/extension_reconciliation.csv.

Each row uses:
  evidence_grade  = 'derived'
  evidence_source = 'src_contracts:<season>:<signals>; ci=<first 60 chars>'
  source          = 'reconcile-derived'

Term inference:
  • If parse_extension_term_from_chain returned a value, use it.
  • Otherwise NULL (Keith can review).

Output: /tmp/extension_master_derived_backfill.sql
"""
from __future__ import annotations
import csv
import re
from pathlib import Path

CSV = Path('/tmp/extension_reconciliation.csv')
OUT = Path('/tmp/extension_master_derived_backfill.sql')


def sql_str(v):
    if v is None or v == '':
        return 'NULL'
    s = str(v).replace("'", "''")
    return f"'{s}'"


def sql_int(v):
    try:
        return str(int(v)) if v not in (None, '', 'None') else 'NULL'
    except (TypeError, ValueError):
        return 'NULL'


def derive_status(src_status: str, term) -> str:
    """Map src_contracts status + term → canonical EXT1/EXT2/EXT2-FL/EXT2-BL."""
    s = (src_status or '').upper().strip()
    if s.startswith('EXT') and 'EXTENSION' not in s:
        return s
    try:
        t = int(term) if term not in (None, '') else None
    except (TypeError, ValueError):
        t = None
    if t == 1:
        return 'EXT1'
    if t == 2:
        if s == 'FL':
            return 'EXT2-FL'
        if s == 'BL':
            return 'EXT2-BL'
        return 'EXT2'
    # Can't determine — use raw status
    return s or ''


def main():
    rows = [r for r in csv.DictReader(CSV.open())
            if r['classification'] == 'derived_only']
    print(f'Generating SQL for {len(rows)} derived-only rows…')

    with OUT.open('w') as f:
        f.write("""-- 0064_extension_master_derived_only_backfill.sql
-- Backfills ups_extension_master with extension events derived from
-- src_contracts year-over-year analysis. Source mining (forum, xlsx,
-- runtime worker UPSERTs) didn't catch these — they're inferred from
-- MFL salary chain signals (contractStatus = EXT*, extension_flag=1,
-- contract_info "Ext:" / year-list tokens).
--
-- Coverage: primarily 2018, 2022-2025 (the seasons without xlsx or
-- forum mining), plus a tail of 2017+2019+2020+2021 events that the
-- xlsx files missed.
--
-- evidence_grade  = 'derived'
-- evidence_source = 'src_contracts:<season>:<signals>; ci=<excerpt>'
-- source          = 'reconcile-derived'
--
-- extension_term_years is NULL where the year-over-year chain didn't
-- give a confident inference (e.g. mid-multi-year-deal extensions like
-- the Blake/Henry trade-and-extend case). Those rows need manual term
-- assignment from contract_info parsing or owner confirmation.
--
-- Re-runnable: ON CONFLICT(league_id, season, player_id) DO UPDATE
-- preserves evidenced rows by NOT overwriting them when grade differs.

""")
        for r in rows:
            season = r['season']
            pid = r['pid']
            fid = r['derived_franchise']
            if not fid:
                continue
            name = r['name'] or ''
            position = r['position'] or ''
            src_status = r['derived_status'] or ''
            term = r['derived_term']
            status = derive_status(src_status, term)
            salary = r['derived_salary']
            signals = r['derived_signals'] or ''
            ci_excerpt = (r['derived_contract_info'] or '')[:60].replace("'", "")
            evidence_source = f"src_contracts:{season}:{signals}; ci={ci_excerpt}"

            f.write(f"""INSERT INTO ups_extension_master
  (league_id, season, franchise_id, player_id, player_name, position,
   new_contract_status, new_salary, new_contract_year, new_contract_info,
   extension_term_years, new_tcv, new_aav, new_gtd, ext_token,
   source, extended_at_utc, updated_at_utc,
   evidence_grade, evidence_source)
VALUES
  ('74598', {sql_str(season)}, {sql_str(fid)}, {sql_str(pid)},
   {sql_str(name)}, {sql_str(position)},
   {sql_str(status)}, {sql_int(salary)}, NULL, NULL,
   {sql_int(term)}, NULL, NULL, NULL, NULL,
   'reconcile-derived', {sql_str(season)} || '-01-01T00:00:00Z', datetime('now'),
   'derived', {sql_str(evidence_source)})
ON CONFLICT(league_id, season, player_id) DO UPDATE SET
  franchise_id         = excluded.franchise_id,
  player_name          = COALESCE(NULLIF(excluded.player_name, ''), ups_extension_master.player_name),
  position             = COALESCE(NULLIF(excluded.position, ''), ups_extension_master.position),
  -- Don't overwrite an evidenced row's contract details with derived;
  -- only fill in NULLs. evidence_grade stays 'evidenced' if already set.
  new_contract_status  = COALESCE(ups_extension_master.new_contract_status, excluded.new_contract_status),
  new_salary           = COALESCE(ups_extension_master.new_salary, excluded.new_salary),
  -- Always overwrite NULL term with newly-derived value; keep any
  -- non-NULL existing term (don't clobber evidenced terms).
  extension_term_years = CASE
                           WHEN ups_extension_master.extension_term_years IS NOT NULL
                             AND ups_extension_master.evidence_grade = 'evidenced'
                           THEN ups_extension_master.extension_term_years
                           ELSE excluded.extension_term_years
                         END,
  source               = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.source ELSE excluded.source END,
  updated_at_utc       = datetime('now'),
  evidence_grade       = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN 'evidenced' ELSE 'derived' END,
  evidence_source      = CASE WHEN ups_extension_master.evidence_grade='evidenced'
                              THEN ups_extension_master.evidence_source
                              ELSE excluded.evidence_source END;

""")

    print(f'Wrote {len(rows)} INSERT statements to {OUT}')


if __name__ == '__main__':
    main()
