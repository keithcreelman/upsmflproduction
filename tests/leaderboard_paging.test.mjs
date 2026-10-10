// The leaderboard pages past 500 rows, and the precompute stores EVERY page.
//   node tests/leaderboard_paging.test.mjs
//
// THE GAP (2026-10-10). /api/advanced-stats-leaderboard capped a request at
// 500 rows, and the precompute builder stored exactly one 500-row request. The
// 2026 IDP board has 805 players with an nflverse line; the stored board cut it
// at impact 7 — inside a 36-way tie — so mobile listed ~350 scoring IDPs with
// "—" in every box-score column although their stats were in D1.
//
// This drives the REAL route under Node (D1 = node:sqlite from the real
// migrations). env.SELF — the builder's self-fetch of the live query — is the
// only fake: it serves a synthetic 805-row IDP board in pages exactly as the
// live path now does (limit/offset/next_offset), and the other aliases answer
// the OLD way (one page, no next_offset) to prove that shape still ends.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, callWorker, ADMIN_KEY, quiet } from "./fixtures/fcfs_worker_harness.mjs";

const MIG = (f) => fs.readFileSync("worker/migrations/" + f, "utf8");
const IDP_ROWS = 805;
const board = Array.from({ length: IDP_ROWS }, (_, i) => ({
  gsis_id: "00-IDP" + String(i).padStart(4, "0"), mfl_pid: String(20000 + i), games: 4, punts: 0,
  impact: IDP_ROWS - i, def_tackles_total: i % 7 === 0 ? null : 10,
}));

function setup() {
  const env = makeWorkerEnv();
  const db = env.UPS_MFL_DB.raw;
  for (const f of ["0002_mfl_source_tables.sql", "0006_advanced_stats_schema.sql", "0140_leaderboard_precompute.sql",
                   "0143_leaderboard_precompute_current_season.sql", "0161_leaderboard_precompute_week_coverage.sql",
                   "0165_leaderboard_precompute_mfl_scores_fingerprint.sql"]) db.exec(MIG(f));
  const teams = Array.from({ length: 32 }, (_, i) => "T" + String(i).padStart(2, "0"));
  const pw = db.prepare("INSERT INTO nfl_player_weekly (season, week, gsis_id, team, pos_group) VALUES (2026, ?, ?, ?, 'LB')");
  const vg = db.prepare("INSERT INTO nfl_team_vegas_weekly (season, week, team) VALUES (2026, ?, ?)");
  for (let w = 1; w <= 4; w++) teams.forEach((tm, i) => { pw.run(w, "00-" + w + "-" + i, tm); vg.run(w, tm); });
  const calls = [];
  env.SELF = {
    fetch: async (u) => {
      const url = new URL(String(u));
      const alias = url.searchParams.get("pos"), limit = Number(url.searchParams.get("limit")), offset = Number(url.searchParams.get("offset") || 0);
      calls.push(alias + "@" + offset);
      t.equal(url.searchParams.get("NO_PRECOMPUTE"), "1", "the builder bypasses the stored board");
      const body = alias === "idp"
        ? { rows: board.slice(offset, offset + limit), limit, offset, next_offset: offset + limit < IDP_ROWS ? offset + limit : null }
        : { rows: [{ gsis_id: "00-" + alias, mfl_pid: "1", games: 4, punts: alias === "punter" ? 9 : 0 }] };   // old shape: no next_offset
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
  const build = async () => {
    const restore = quiet();
    try {
      return await callWorker(env, "POST", `/admin/leaderboard-precompute/build?APIKEY=${ADMIN_KEY}&L=74598&YEAR=2026&season=2026`, { body: { season: 2026 } });
    } finally { restore(); }
  };
  const read = async (offset) => {
    const restore = quiet();
    try {
      return await callWorker(env, "GET", `/api/advanced-stats-leaderboard?season=2026&pos=idp&limit=500&offset=${offset}&YEAR=2026&L=74598`);
    } finally { restore(); }
  };
  return { env, db, build, read, calls };
}

test("the builder walks every page and stores all 805 IDP rows in rank order", async () => {
  const h = setup();
  const res = await h.build();
  t.equal(res.status, 200);
  const idp = res.json.built.find((b) => b.pos === "idp");
  t.deepEqual([idp.ok, idp.rows], [true, IDP_ROWS], "805 stored, not 500");
  t.deepEqual(h.calls.filter((c) => c.startsWith("idp@")), ["idp@0", "idp@500"], "two pages, then next_offset is null");
  t.deepEqual(h.calls.filter((c) => c.startsWith("qb@")), ["qb@0"], "a reply without next_offset is one page — never an endless loop");
  const stored = h.db.prepare("SELECT rank, gsis_id FROM nfl_leaderboard_precompute WHERE season = 2026 AND pos_alias = 'idp' ORDER BY rank").all();
  t.equal(stored.length, IDP_ROWS);
  t.ok(stored.every((r, i) => r.rank === i + 1 && r.gsis_id === board[i].gsis_id), "ranks 1..805 follow the live order across the page boundary");
  t.equal(h.db.prepare("SELECT row_count FROM nfl_leaderboard_precompute_meta WHERE season = 2026 AND pos_alias = 'idp'").get().row_count, IDP_ROWS);
});

test("the stored board reads back in pages: 500, then 305, then an empty last page (no live query)", async () => {
  const h = setup();
  await h.build();
  const p1 = await h.read(0), p2 = await h.read(500), p3 = await h.read(1000);
  t.deepEqual([p1.json.source, p1.json.count, p1.json.offset, p1.json.next_offset], ["precompute", 500, 0, 500]);
  t.deepEqual([p2.json.source, p2.json.count, p2.json.offset, p2.json.next_offset], ["precompute", 305, 500, null]);
  t.equal(p2.json.rows[0].gsis_id, board[500].gsis_id, "page 2 starts at rank 501");
  t.deepEqual([p3.json.source, p3.json.count, p3.json.next_offset], ["precompute", 0, null], "past the end: an empty precompute page");
  const all = p1.json.rows.concat(p2.json.rows);
  t.equal(new Set(all.map((r) => r.gsis_id)).size, IDP_ROWS, "every player exactly once");
  t.equal(all.find((r) => r.gsis_id === board[7].gsis_id).def_tackles_total, null, "an absent value stays null through store and read");
});

test("a request with no offset is the first page — every existing caller is unchanged", async () => {
  const h = setup();
  await h.build();
  const restore = quiet();
  let res;
  try { res = await callWorker(h.env, "GET", "/api/advanced-stats-leaderboard?season=2026&pos=idp&limit=500&YEAR=2026&L=74598"); } finally { restore(); }
  t.deepEqual([res.json.count, res.json.offset, res.json.next_offset], [500, 0, 500]);
});

await run("leaderboard_paging");
