// Runs the local weekly reconstruction against a read-only copy of the league archive and writes a summary next to the archive copy (never into the repository, never to a database).
//   node scripts/league_record/weekly/run_reconstruct_weekly.mjs --db <decompressed archive copy> [--out <dir outside the repo>]
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { reconstructWeekly, compareAllPlayFixture } from "./reconstruct_weekly.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : null; };
const dbPath = arg("--db");
if (!dbPath) { console.error("usage: --db <path to a decompressed copy of data/db-archives/mfl_database_2026-06-05.db.gz>"); process.exit(1); }
const out = arg("--out") || path.join(path.dirname(path.resolve(dbPath)), "weekly_reconstruction");
if (path.resolve(out).startsWith(ROOT)) { console.error("refusing: the output folder must be outside the repository"); process.exit(1); }
const db = new DatabaseSync(dbPath, { readOnly: true });
const res = reconstructWeekly(db);
res.allplay_fixture = compareAllPlayFixture(db, JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "fixtures", "weekly_allplay_2010_2025.json"), "utf8")));
res.source = { db_sha256: crypto.createHash("sha256").update(fs.readFileSync(dbPath)).digest("hex"), table: "weeklyresults", generated_by: "scripts/league_record/weekly/reconstruct_weekly.mjs" };
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "weekly_reconstruction_summary.json"), `${JSON.stringify(res, null, 1)}\n`);
for (const [y, s] of Object.entries(res.seasons)) {
  const pct = (a, b) => (b ? `${a}/${b}` : "-");
  console.log(`${y}: rows ${s.player_rows} (starters ${s.starter_rows}, bench ${s.bench_rows}), weeks ${s.weeks_present.length}${s.weeks_missing.length ? ` missing ${s.weeks_missing.join(",")}` : ""}; starter sum = team ${pct(s.starter_sum_equals_team_score, s.franchise_weeks)}; team = summary ${pct(s.team_score_equals_summary, s.franchise_weeks_with_summary)}; player = MFL ${pct(s.player_score_equals_mfl, s.player_rows_with_mfl_score)}; all-play ${pct(s.allplay_recomputed_equals_summary, s.allplay_compared)}; fixture all-play ${pct(res.allplay_fixture[y]?.allplay_wins_equal ?? 0, res.allplay_fixture[y]?.compared ?? 0)}; contaminated fw ${s.contaminated_franchise_weeks}; dup weeks ${s.duplicate_of_next_week.join(",") || "-"}; playoff ${s.playoff_weeks.map((p) => `${p.week}:${p.franchises}`).join(" ")}; opponents ${pct(s.regular_season_with_opponent, s.regular_season_franchise_weeks)}; derived rows with franchise ${s.derived_rows_with_franchise}`);
}
console.log(`defects: ${res.defects.length}; summary written to ${out}`);
