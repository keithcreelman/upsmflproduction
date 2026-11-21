// League Record S1: the build guard for Keith's rule (2026-11-20): "never derive draft slots from standings, league finishes or projected order".
//
// Two layers enforce it, and tests/league_record_s1_pilot.test.mjs (T9) runs both on every CI run:
//   1. RUNTIME: archive.mjs refuses any query on a table in BANNED_TABLES and any table not on its allowlist.
//   2. STATIC: scanExtractionSources() reads every extraction module (this file excluded, because it holds the lists), removes comments, and fails on any banned word or banned import.
// A change that makes the extraction read standings, finishes, brackets or a projection therefore fails the build, in CI and in the local suite.
import fs from "node:fs";
import path from "node:path";

export const BANNED_TABLES = Object.freeze([
  "standings", "metadata_finalstandings", "metadata_leaguehistory", "view_leaguehistory", "view_leaguehistory_ownertotals", "weeklyresults", "weeklyresults_summary",
  "schedule", "metadata_leaguewinprofile", "trade_value_picks", "trade_value_model", "early_projection_adp", "view_rookiedraft",
]);

// Column names the extraction may never select, even from an allowlisted table: a table that holds a franchise list can also hold a waiver order derived from the standings, and the weekly
// scoring table holds owner names and rank columns. A wildcard select is refused as well (archive.mjs), so no restricted column can ride along.
export const BANNED_COLUMNS = Object.freeze(["waiver_sort_order", "final_finish", "final_rank", "playoff_seed", "draft_order", "projected_order", "projected_finish",
  "owner_name", "pos_rank", "overall_rank", "winning_week", "win_chunks"]);

// Words and names that must not appear in extraction CODE (comments are removed first). Each one is a way of getting a slot, an order or a rank from somewhere other than MFL's
// draft results, slot tokens and slot lists.
export const BANNED_CODE_PATTERNS = Object.freeze([
  { re: /standing/i, why: "standings" },
  { re: /final[_ ]?finish/i, why: "final finishes" },
  { re: /finishes/i, why: "league finishes" },
  { re: /bracket/i, why: "playoff brackets" },
  { re: /SLOT_BY_FINISH/, why: "the finish-to-slot table" },
  { re: /seed(ing)?\b/i, why: "seeds" },
  { re: /project(ed|ion)/i, why: "projected order" },
  { re: /(?<!round1)draft[_ ]?order/i, why: "a derived draft order (MFL's own round1DraftOrder field is the one allowed name)" },
  { re: /history_finishes|historical-finishes|hall-of-champions|\/api\/eras/i, why: "the finish routes" },
  { re: /final_finish_history/i, why: "the finish fixture" },
]);

export const BANNED_IMPORT_RE = /from\s+["'][^"']*(?:desk\/tools\/history_finishes|desk\/tools\/standings_get|pick_valuation)[^"']*["']/;

export function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

export function scanSource(src, name = "source") {
  const code = stripComments(src);
  const out = [];
  code.split("\n").forEach((line, i) => {
    for (const p of BANNED_CODE_PATTERNS) if (p.re.test(line)) out.push({ file: name, line: i + 1, why: p.why, text: line.trim().slice(0, 120) });
    if (BANNED_IMPORT_RE.test(line)) out.push({ file: name, line: i + 1, why: "an import of finish or standings code", text: line.trim().slice(0, 120) });
  });
  return out;
}

// dir: the directory holding the extraction modules (scripts/league_record/s1). guard.mjs itself is skipped.
export function scanExtractionSources(dir) {
  const hits = [];
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".mjs") && x !== "guard.mjs").sort()) hits.push(...scanSource(fs.readFileSync(path.join(dir, f), "utf8"), f));
  return hits;
}
