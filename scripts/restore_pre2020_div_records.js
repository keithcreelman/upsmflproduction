#!/usr/bin/env node
/**
 * Restore pre-2020 div_w / div_l / div_pct in src_standings.
 *
 * Background — 2026-05-15:
 *
 * Migration 0044 zeroed div_w/div_l for 2010-2019 because src_schedule
 * is essentially empty for those years (~28 rows/season vs 470+ expected).
 * Root cause: MFL purges regular-season schedule rows from historical
 * leagues; only playoff matchups (W14-16) remain. So we can't recompute
 * divisional records from src_schedule for those years.
 *
 * BUT — MFL's TYPE=leagueStandings endpoint STILL carries the aggregated
 * `divwlt` field per franchise for every historical season we checked.
 * That's the authoritative ledger MFL kept after purging the underlying
 * matchups. Pull it once, write UPDATE statements, apply via wrangler.
 *
 * Usage:
 *   node scripts/restore_pre2020_div_records.js > /tmp/0045_restore.sql
 *   cd worker && npx wrangler d1 execute UPS_MFL_DB --remote --file=/tmp/0045_restore.sql
 *
 * Or pipe directly:
 *   node scripts/restore_pre2020_div_records.js | \
 *     npx --prefix worker wrangler d1 execute UPS_MFL_DB --remote --command -
 */

"use strict";

// Per-season MFL league IDs (from src_league_season_meta).
const LEAGUE_IDS = {
  2010: 60671, // pre-UPS; including for completeness
  2011: 40832,
  2012: 37227,
  2013: 42721,
  2014: 30590,
  2015: 29015,
  2016: 27191,
  2017: 74598,
  2018: 74598,
  2019: 74598,
};

async function fetchLeagueStandings(year, leagueId) {
  const url = `https://api.myfantasyleague.com/${year}/export?TYPE=leagueStandings&L=${leagueId}&JSON=1`;
  const res = await fetch(url, { headers: { "User-Agent": "ups-d1-restore" } });
  if (!res.ok) throw new Error(`MFL ${year} ${res.status}`);
  const j = await res.json();
  const arr = j?.leagueStandings?.franchise;
  if (!Array.isArray(arr)) throw new Error(`unexpected shape for ${year}`);
  return arr;
}

function parseDivwlt(s) {
  // Format examples: "8-0-0" or "5-3-1". W-L-T.
  const m = String(s || "").match(/^(\d+)-(\d+)-(\d+)$/);
  if (!m) return null;
  const w = parseInt(m[1], 10);
  const l = parseInt(m[2], 10);
  const t = parseInt(m[3], 10);
  const games = w + l + t;
  const pct = games > 0 ? (w + 0.5 * t) / games : 0;
  return { w, l, t, pct };
}

(async () => {
  const lines = [];
  lines.push("-- 0045 — Restore pre-2020 div_w / div_l / div_pct in src_standings");
  lines.push("-- Generated " + new Date().toISOString());
  lines.push("-- Source: MFL TYPE=leagueStandings.divwlt per franchise");
  lines.push("");
  for (const [yearStr, leagueId] of Object.entries(LEAGUE_IDS)) {
    const year = Number(yearStr);
    let franchises;
    try {
      franchises = await fetchLeagueStandings(year, leagueId);
    } catch (e) {
      lines.push(`-- ${year} FAILED: ${e.message}`);
      console.error(`[${year}] fetch failed:`, e.message);
      continue;
    }
    lines.push(`-- ${year} (L=${leagueId})`);
    let updated = 0;
    for (const f of franchises) {
      const fid = String(f.id || "").padStart(4, "0");
      const parsed = parseDivwlt(f.divwlt);
      if (!parsed) {
        lines.push(`-- ${year}/${fid}: no divwlt (${JSON.stringify(f.divwlt)}) — skipped`);
        continue;
      }
      const pctSql = parsed.pct.toFixed(4);
      lines.push(
        `UPDATE src_standings SET div_w=${parsed.w}, div_l=${parsed.l}, div_pct=${pctSql} ` +
        `WHERE season=${year} AND franchise_id='${fid}';`
      );
      updated += 1;
    }
    lines.push(`-- ${year}: ${updated} franchise rows`);
    lines.push("");
    // small delay to not hammer MFL
    await new Promise((r) => setTimeout(r, 200));
  }
  console.log(lines.join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
