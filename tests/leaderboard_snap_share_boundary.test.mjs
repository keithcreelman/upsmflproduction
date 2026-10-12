// Snap% counts on the leaderboard across a whole season, regular season through
// the Super Bowl (Keith 2026-10-12: "Test the full regular season plus postseason
// boundary and prove the stored and displayed values cannot wrap, truncate or
// exceed 100% incorrectly").
//   node tests/leaderboard_snap_share_boundary.test.mjs
//
// Drives the REAL /api/advanced-stats-leaderboard route under node:sqlite with
// production's schema (tests/fixtures/leaderboard_schema_pre0169.sql) plus the
// real 0169/0170 migrations. What it pins:
//   1. Default board (what the mobile list reads) = Weeks 1–17, for BOTH counts:
//      his snaps and his team's, in the same games. Week 18 and the postseason
//      (19–22) are added only by include_post=1 or an explicit week range.
//   2. A full season is four digits over four (2025's busiest defender: Kamren
//      Curl, 1057/1067 in Wks 1–17, 1324/1337 with the postseason). They come
//      back as exact integers: no truncation, no wrap.
//   3. The team's per-game total (most-used player's snaps ÷ his share) is never
//      below any player's own snaps that game, whatever the rounding of the
//      shares — proven on 400 random team-games — so a season sum can't pass
//      100% either. (Production 2013–2026, read 2026-10-12: 0 of 138,930
//      defensive and 0 of 133,127 offensive player-games over the team total;
//      0 shares above 1.)
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, callWorker, quiet } from "./fixtures/fcfs_worker_harness.mjs";

const SCHEMA = fs.readFileSync("tests/fixtures/leaderboard_schema_pre0169.sql", "utf8");
const M0169 = fs.readFileSync("worker/migrations/0169_redzone_v2_epa_through_week.sql", "utf8");
const M0170 = fs.readFileSync("worker/migrations/0170_player_id_map.sql", "utf8");

function setup() {
  const env = makeWorkerEnv();
  const db = env.UPS_MFL_DB.raw;
  db.exec(SCHEMA); db.exec(M0169); db.exec(M0170);
  const wk = db.prepare(`INSERT INTO nfl_player_weekly (season, week, gsis_id, position, pos_group, team, targets, receptions, rush_att, pass_att)
                         VALUES (2026, ?, ?, ?, ?, ?, 0, 0, 0, 0)`);
  const def = db.prepare("INSERT INTO nfl_player_snaps (season, week, pfr_id, team, off_snaps, off_snap_pct, def_snaps, def_snap_pct, st_snaps) VALUES (2026, ?, ?, ?, 0, 0, ?, ?, 0)");
  const off = db.prepare("INSERT INTO nfl_player_snaps (season, week, pfr_id, team, off_snaps, off_snap_pct, def_snaps, def_snap_pct, st_snaps) VALUES (2026, ?, ?, ?, ?, ?, 0, 0, 0)");
  const xw = db.prepare("INSERT INTO player_id_crosswalk (mfl_player_id, gsis_id, pfr_id, confidence) VALUES (?, ?, ?, 'exact')");
  return { env, db, wk, def, off, xw };
}
// nflverse publishes a share rounded to hundredths.
const pct = (s, team) => Math.round((s / team) * 100) / 100;
async function board(env, pos, extra = "") {
  const restore = quiet();
  try {
    const r = await callWorker(env, "GET", `/api/advanced-stats-leaderboard?season=2026&pos=${pos}&YEAR=2026&L=74598&min_games=1&limit=500&NO_PRECOMPUTE=1&NO_CACHE=1${extra}`);
    t.equal(r.status, 200, JSON.stringify(r.json).slice(0, 300));
    return Object.fromEntries((r.json.rows || []).map((x) => [x.gsis_id, x]));
  } finally { restore(); }
}

// LB "D" plays every AAA game Weeks 1–21 but Week 9 (the bye): 69 of the team's 70
// defensive snaps, except 35 in Week 12. LB "T" plays all 70 (100%). Week 20 nobody
// plays every snap (T 68 = 0.97, D 66 = 0.94), so the team total is read back from
// a rounded share: round(68 / 0.97) = 70. AAA is out after Week 21 (no Week 22).
function season(s) {
  s.xw.run(40001, "00-D", "DdddDd00"); s.xw.run(40002, "00-T", "TtttTt00");
  for (let w = 1; w <= 21; w++) {
    if (w === 9) continue;
    s.wk.run(w, "00-D", "LB", "LB", "AAA"); s.wk.run(w, "00-T", "LB", "LB", "AAA");
    if (w === 20) { s.def.run(w, "TtttTt00", "AAA", 68, pct(68, 70)); s.def.run(w, "DdddDd00", "AAA", 66, pct(66, 70)); continue; }
    const d = w === 12 ? 35 : 69;
    s.def.run(w, "TtttTt00", "AAA", 70, 1); s.def.run(w, "DdddDd00", "AAA", d, pct(d, 70));
  }
}

test("default board = Weeks 1–17 for BOTH counts: four digits over four, exact integers, 96%", async () => {
  const s = setup(); season(s);
  const d = (await board(s.env, "idp"))["00-D"];
  // 16 games (Wk 9 bye): 15 × 69 + 35 = 1070 of 16 × 70 = 1120
  t.deepEqual([d.def_snaps_total, d.def_snaps_team], [1070, 1120], "Weeks 1–17 only; Week 18 and the postseason left out of both");
  t.ok(Number.isInteger(d.def_snaps_total) && Number.isInteger(d.def_snaps_team), "integers, not 1070.0000001 or a truncated 1069");
  t.equal(Math.round(100 * d.def_snaps_total / d.def_snaps_team), 96);
  const tm = (await board(s.env, "idp"))["00-T"];
  t.deepEqual([tm.def_snaps_total, tm.def_snaps_team], [1120, 1120], "a 100% player reads exactly 100%, never 101%");
});

test("include_post=1 adds Week 18 and the postseason to BOTH counts — the same games", async () => {
  const s = setup(); season(s);
  const d = (await board(s.env, "idp", "&include_post=1"))["00-D"];
  // + Wk 18 69/70, Wk 19 69/70, Wk 20 66/70 (team total read from a 0.97 share), Wk 21 69/70
  t.deepEqual([d.def_snaps_total, d.def_snaps_team], [1070 + 69 + 69 + 66 + 69, 1120 + 70 * 4], "1343 of 1400");
  t.ok(d.def_snaps_total <= d.def_snaps_team);
  const tm = (await board(s.env, "idp", "&include_post=1"))["00-T"];
  t.deepEqual([tm.def_snaps_total, tm.def_snaps_team], [1120 + 70 + 70 + 68 + 70, 1400], "Week 20's 68 of 70: under 100% for the first time");
});

test("explicit ranges at the boundary: 17–18, the postseason alone, and a Super Bowl week AAA didn't play", async () => {
  const s = setup(); season(s);
  const r1718 = (await board(s.env, "idp", "&weeks=17,18"))["00-D"];
  t.deepEqual([r1718.def_snaps_total, r1718.def_snaps_team], [138, 140]);
  const post = (await board(s.env, "idp", "&week_min=19&week_max=22"))["00-D"];
  t.deepEqual([post.def_snaps_total, post.def_snaps_team], [69 + 66 + 69, 210], "Weeks 19–21; Week 22 has no AAA game, so it adds nothing to either count");
  const reg = (await board(s.env, "idp", "&week_min=1&week_max=17"))["00-D"];
  t.deepEqual([reg.def_snaps_total, reg.def_snaps_team], [1070, 1120], "week_min=1&week_max=17 = the default");
});

test("offense: the same rule for Snap% on the Usage set (his offensive snaps ÷ his team's, Weeks 1–17 by default)", async () => {
  const s = setup();
  s.xw.run(40003, "00-W", "WwwwWw00"); s.xw.run(40004, "00-Q", "QqqqQq00");
  for (let w = 1; w <= 22; w++) {
    s.wk.run(w, "00-W", "WR", "WR", "BBB"); s.wk.run(w, "00-Q", "QB", "QB", "BBB");
    s.off.run(w, "QqqqQq00", "BBB", 66, 1); s.off.run(w, "WwwwWw00", "BBB", 61, pct(61, 66));
  }
  const reg = (await board(s.env, "skill"))["00-W"];
  t.deepEqual([reg.off_snaps_total, reg.off_snaps_team], [61 * 17, 66 * 17], "1037 of 1122");
  const all = (await board(s.env, "skill", "&include_post=1"))["00-W"];
  t.deepEqual([all.off_snaps_total, all.off_snaps_team], [61 * 22, 66 * 22], "1342 of 1452: four digits over four");
});

test("property: 400 random team-games with rounded shares and no 100% player — no player-game and no season sum over the team total", async () => {
  const s = setup();
  // a fixed-seed LCG: the same 400 games every run
  let seed = 20261012;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const players = [];
  for (let p = 0; p < 24; p++) {
    const gs = "00-P" + String(p).padStart(2, "0"), pfr = "Pppp" + String(p).padStart(2, "0") + "00";
    s.xw.run(41000 + p, gs, pfr); players.push({ gs, pfr, team: p < 12 ? "CCC" : "DDD" });
  }
  for (let w = 1; w <= 22; w++) {
    for (const team of ["CCC", "DDD"]) {
      const T = 50 + rnd(41);                       // 50–90 team defensive snaps
      const top = T - rnd(4);                        // the busiest player: sometimes not 100%
      players.filter((p) => p.team === team).forEach((p, i) => {
        if (rnd(10) === 0) return;                   // a missed game
        const sn = i === 0 ? top : 1 + rnd(top);
        s.wk.run(w, p.gs, "DB", "DB", team);
        s.def.run(w, p.pfr, team, sn, pct(sn, T));
      });
    }
  }
  // per game, by the worker's own formula
  const games = s.db.prepare(`SELECT s.week, s.team, s.def_snaps,
      (SELECT CAST(ROUND(MAX(def_snaps) * 1.0 / NULLIF(MAX(def_snap_pct), 0)) AS INTEGER) FROM nfl_player_snaps x
        WHERE x.season = s.season AND x.week = s.week AND x.team = s.team AND COALESCE(x.def_snaps, 0) > 0) AS team_total
      FROM nfl_player_snaps s WHERE s.season = 2026`).all();
  t.ok(games.length > 400, games.length + " player-games");
  t.equal(games.filter((g) => !(g.def_snaps <= g.team_total)).length, 0, "no player-game over its team total");
  for (const extra of ["", "&include_post=1"]) {
    const rows = Object.values(await board(s.env, "idp", extra)).filter((r) => r.gsis_id.startsWith("00-P"));
    t.equal(rows.length, 24);
    t.equal(rows.filter((r) => !(Number.isInteger(r.def_snaps_total) && Number.isInteger(r.def_snaps_team) && r.def_snaps_total <= r.def_snaps_team)).length, 0,
      (extra || "default") + ": every season sum is an integer pair with his ≤ his team's");
  }
});

await run("leaderboard_snap_share_boundary");
