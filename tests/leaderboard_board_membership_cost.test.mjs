// The leaderboard's board-membership CTE (elig) must not re-read the season once per id-map row.
//   node tests/leaderboard_board_membership_cost.test.mjs
//
// THE COST (#1266, 2026-10-15). The 2026-10-10 board rule (a player is on his MFL lineup
// group's board, from the verified id map) added a second half to elig that started from
// player_id_map and, per map row, checked nflverse's box score for an off-board row. D1
// answered that check with the (season, pos_group) index, so each of ~1,000 map rows re-read
// the season's off-board rows: ~17M rows read per run in production, every finished-season
// window but Wks 1-17 and every season before 2023 (2025 on a copy of the same rows: skill
// ~33M, idp ~51M). Nothing looked wrong; only the bill did.
//
// The fix starts from the season's DISTINCT off-board players and probes the map by gsis_id.
// This test holds both halves of that: the set is exactly the old rule's (the old SQL is kept
// below as the definition, run on generated players covering every mapping case), and the
// plan never drives nflverse's box score from a scan of the map.
// Real worker source (the elig template is sliced out of it), node:sqlite, production schema.
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { t, test, run } from "./fixtures/mini_test.mjs";

const SRC = fs.readFileSync(process.env.LB_WORKER_SRC || "worker/src/index.js", "utf8");
const SCHEMA = fs.readFileSync("tests/fixtures/leaderboard_schema_pre0169.sql", "utf8");
const M0170 = fs.readFileSync("worker/migrations/0170_player_id_map.sql", "utf8");

// ── the shipped template ─────────────────────────────────────────────────────
const eStart = SRC.indexOf("            elig AS (\n");
const eEnd = SRC.indexOf("\n            ),\n", eStart);
const ELIG = eStart > 0 && eEnd > eStart ? SRC.slice(eStart + "            elig AS (\n".length, eEnd) : "";
const bStart = SRC.indexOf("const mflBoardSql = (col) => `");
const bEnd = SRC.indexOf("END)`;", bStart);
const mflBoardSql = new Function("return " + SRC.slice(bStart + "const mflBoardSql = ".length, bEnd + "END)`".length))();
const POS_GROUPS = { qb: ["QB"], skill: ["RB", "WR", "TE"], idp: ["DL", "LB", "DB"], kicker: ["PK"], punter: ["PN", "PK"] };
const render = (tpl, pos, seasons) => new Function("seasonList", "posList", "pos", "mflBoardSql", "return `" + tpl + "`;")(
  seasons.join(","), POS_GROUPS[pos].map((p) => `'${p}'`).join(","), pos, mflBoardSql);

// ── the rule as 2026-10-10 shipped it (the definition the new SQL must match) ──
const OLD = `
              SELECT DISTINCT w.gsis_id
                FROM nfl_player_weekly w
               WHERE w.season IN (\${seasonList}) AND w.pos_group IN (\${posList})
                 AND NOT EXISTS (SELECT 1 FROM player_id_map m
                                  WHERE m.gsis_id = w.gsis_id AND m.accepted = 1
                                    AND \${mflBoardSql("m.mfl_position")} <> '\${pos}')
              UNION
              SELECT m.gsis_id
                FROM player_id_map m
               WHERE m.accepted = 1 AND \${mflBoardSql("m.mfl_position")} = '\${pos}'
                 AND EXISTS (SELECT 1 FROM nfl_player_weekly w
                              WHERE w.gsis_id = m.gsis_id AND w.season IN (\${seasonList})
                                AND w.pos_group IS NOT NULL AND w.pos_group NOT IN (\${posList}))`;

const elig = (db, tpl, pos, seasons) =>
  db.prepare(`WITH elig AS (${render(tpl, pos, seasons)}) SELECT gsis_id FROM elig ORDER BY gsis_id`).all().map((r) => r.gsis_id);

// Players: every nflverse group (and NULL) x every MFL position (and none, an unknown one,
// an unaccepted row, two rows that disagree), across two seasons, from a fixed seed.
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec(SCHEMA); db.exec(M0170);
  const wk = db.prepare("INSERT INTO nfl_player_weekly (season, week, gsis_id, position, pos_group, team) VALUES (?, ?, ?, ?, ?, 'AAA')");
  const map = db.prepare("INSERT INTO player_id_map (mfl_id, gsis_id, pfr_id, mfl_position, status, accepted) VALUES (?, ?, NULL, ?, 'verified', ?)");
  const groups = ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN", null];
  const mflPos = ["QB", "RB", "WR", "TE", "PK", "PN", "DE", "DT", "LB", "CB", "S", null, "XX"];
  let seed = 1266;   // mulberry32: a plain LCG's low bits cycle, and seed % 4 picked one season every time
  const rnd = (n) => {
    seed = (seed + 0x6D2B79F5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) % n;
  };
  let mflId = 10000;
  for (let i = 0; i < 400; i++) {
    const g = "00-P" + String(i).padStart(4, "0");
    const weeks = 1 + rnd(6);
    for (let w = 1; w <= weeks; w++) {
      const grp = rnd(5) === 0 ? groups[rnd(groups.length)] : groups[i % groups.length];   // most weeks one group, some another
      wk.run(rnd(4) === 0 ? 2024 : 2025, w, g, grp || "", grp);
    }
    const kind = rnd(6);   // 0 none · 1-3 one accepted row · 4 unaccepted · 5 two accepted rows (positions may disagree)
    if (kind >= 1 && kind <= 3) map.run(String(mflId++), g, mflPos[rnd(mflPos.length)], 1);
    if (kind === 4) map.run(String(mflId++), g, mflPos[rnd(mflPos.length)], 0);
    if (kind === 5) { map.run(String(mflId++), g, mflPos[rnd(mflPos.length)], 1); map.run(String(mflId++), g, mflPos[rnd(mflPos.length)], 1); }
  }
  // Map rows whose player has no box score at all, and one with no gsis_id.
  for (let i = 0; i < 40; i++) map.run(String(mflId++), "00-NOBOX" + i, mflPos[i % mflPos.length], 1);
  map.run(String(mflId++), null, "WR", 1);
  return db;
}

test("elig and mflBoardSql are sliced out of worker/src/index.js", () => {
  t.ok(ELIG.length > 300, `elig slice is ${ELIG.length} chars`);
  t.match(ELIG, /UNION/, "both halves are present");
  t.equal(mflBoardSql("m.mfl_position").includes("WHEN 'CB' THEN 'idp'"), true);
});

test("every board, one season and two, is exactly the 2026-10-10 rule's set", () => {
  const db = setup();
  const sizes = {};
  for (const pos of Object.keys(POS_GROUPS)) for (const seasons of [[2025], [2024, 2025], [2023]]) {
    const want = elig(db, OLD, pos, seasons), got = elig(db, ELIG, pos, seasons);
    t.deepEqual(got, want, `${pos} ${seasons.join("+")}`);
    sizes[pos + " " + seasons.join("+")] = want.length;
  }
  t.equal(Object.keys(sizes).length, 15);
  // 2023 has no box score: every board is empty there, under both rules.
  const filled = Object.entries(sizes).filter(([k, n]) => !k.endsWith("2023") && n >= 10).length;
  t.equal(filled, 10, "the generated players fill every 2024/2025 board: " + JSON.stringify(sizes));
});

test("the mapping cases the board rule exists for still land where they did", () => {
  const db = setup();
  const wk = db.prepare("INSERT INTO nfl_player_weekly (season, week, gsis_id, position, pos_group, team) VALUES (2025, 1, ?, ?, ?, 'AAA')");
  const map = db.prepare("INSERT INTO player_id_map (mfl_id, gsis_id, pfr_id, mfl_position, status, accepted) VALUES (?, ?, NULL, ?, 'verified', ?)");
  wk.run("00-HUNT", "CB", "DB"); map.run("17074", "00-HUNT", "WR", 1);     // MFL WR, nflverse CB
  wk.run("00-VANS", "RB", "RB"); map.run("16527", "00-VANS", "LB", 1);     // MFL LB, nflverse RB
  wk.run("00-NOMAP", "CB", "DB"); map.run("19999", "00-NOMAP", "WR", 0);   // unaccepted: nflverse decides
  const skill = elig(db, ELIG, "skill", [2025]), idp = elig(db, ELIG, "idp", [2025]);
  t.ok(skill.includes("00-HUNT") && !idp.includes("00-HUNT"), "Hunter: skill board only");
  t.ok(idp.includes("00-VANS") && !skill.includes("00-VANS"), "VanSumeren: IDP board only");
  t.ok(idp.includes("00-NOMAP") && !skill.includes("00-NOMAP"), "an unaccepted map row moves nobody");
});

test("no half of elig asks nflverse's box score once per id-map row", () => {
  t.doesNotMatch(ELIG, /EXISTS\s*\(\s*SELECT 1 FROM nfl_player_weekly/,
    "a correlated EXISTS into nfl_player_weekly per map row re-reads the season for every row (~17M rows read per run)");
  t.doesNotMatch(ELIG, /FROM player_id_map m\s+WHERE m\.accepted = 1/,
    "player_id_map must be probed by gsis_id, never scanned as the driving table");
});

test("the plan never scans the id map to drive a box-score search", () => {
  const db = setup();
  const plan = (tpl) => db.prepare(`EXPLAIN QUERY PLAN WITH elig AS (${render(tpl, "skill", [2025])}) SELECT gsis_id FROM elig`).all().map((r) => r.detail);
  const oldPlan = plan(OLD), newPlan = plan(ELIG);
  // The check proves itself on the old SQL first: if this SQLite plans the old rule without
  // scanning the map, the assertion below would pass for the wrong reason.
  t.ok(oldPlan.some((d) => /^SCAN m\b/.test(d)), "the old rule scans player_id_map (sanity)\n" + oldPlan.join("\n"));
  t.ok(!newPlan.some((d) => /^SCAN m\b/.test(d)), "the new rule never scans player_id_map\n" + newPlan.join("\n"));
  t.ok(newPlan.some((d) => /SEARCH m USING (COVERING )?INDEX idx_player_id_map_gsis/.test(d)), "it probes the map by gsis_id\n" + newPlan.join("\n"));
});

await run("leaderboard board-membership cost");
