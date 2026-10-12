// Migration numbers are unique, and 0169 + 0170 apply on production's schema.
//   node tests/migration_numbers_unique.test.mjs
//
// WHY (2026-10-10): #1219 first numbered its migrations 0168/0169 while draft
// #1189 already claimed 0168_trade_roster_check.sql. Wrangler applies by NAME,
// so two different 0168 files would both run, in an order nobody chose. The
// two pairs already applied in production (0050, 0148) are frozen here; any new
// duplicate fails. Before numbering a migration, check open PRs too:
//   gh pr list --state open --json number,files --jq '.[] | .files[].path' | grep worker/migrations/
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { t, test, run } from "./fixtures/mini_test.mjs";

const DIR = "worker/migrations/";
const FROZEN = new Set(["0050", "0148"]);   // duplicate pairs already applied in production

test("no new duplicate 4-digit migration number", () => {
  const seen = {};
  for (const f of fs.readdirSync(DIR).filter((x) => /^\d{4}_.*\.sql$/.test(x))) (seen[f.slice(0, 4)] ||= []).push(f);
  const dup = Object.entries(seen).filter(([n, fs_]) => fs_.length > 1 && !FROZEN.has(n));
  t.deepEqual(dup, [], "every migration number is used once");
});

test("0169 then 0170 apply on production's pre-0169 schema, and add what the worker reads", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(fs.readFileSync("tests/fixtures/leaderboard_schema_pre0169.sql", "utf8"));
  for (const f of ["0169_redzone_v2_epa_through_week.sql", "0170_player_id_map.sql"]) db.exec(fs.readFileSync(DIR + f, "utf8"));
  const cols = (tbl) => db.prepare(`SELECT name FROM pragma_table_info('${tbl}')`).all().map((r) => r.name);
  t.ok(["pass_cmp_i20", "sacks_i20"].every((c) => cols("nfl_player_redzone").includes(c)));
  t.ok(!cols("nfl_player_redzone").some((c) => c.startsWith("rz_qb_")), "no 'with him at QB' columns");
  t.ok(["rz_pass_att", "rz_sacks", "rz_carries", "rz_scrambles", "i5_carries", "rz_targets", "ez_targets", "rz_rec"].every((c) => cols("nfl_team_weekly").includes(c)));
  t.ok(cols("nfl_player_epa").includes("through_week"));
  t.ok(cols("nfl_player_weekly_ext").includes("def_targets"));
  t.ok(["mfl_id", "gsis_id", "pfr_id", "mfl_position", "accepted"].every((c) => cols("player_id_map").includes(c)));
});

await run("migration_numbers_unique");
