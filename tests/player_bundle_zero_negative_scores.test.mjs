// /api/player-bundle must count MFL's 0.0 and negative weeks — they are real,
// scored weeks.
//   node tests/player_bundle_zero_negative_scores.test.mjs
//
// THE BUG (2026-10-01). The career_summary and game-log queries filtered
// `w.score > 0`, and the MFL fallback filtered `season_points > 0`. So:
//   - Andy Dalton's 2026 (one game, -2.0) had NO season row at all;
//   - Tyler Higbee's 2026 read 2 G / 13.8 PPG instead of MFL's 3 G / 9.20
//     (his Wk 2 0.0 was dropped);
//   - in src_weekly as of 10-01: 1,054 player-seasons with totals missing their
//     negative weeks, 1,502 with no row at all, 15,623 of 26,057 with G/PPG off.
// The rule now is the one the leaderboard adopted on 09-29 and MFL's own W=AVG
// uses: a week counts when MFL posted a score for it (score IS NOT NULL); a
// rostered week MFL posted nothing for (NULL) is still not a game.
//
// Drives the REAL route under Node: D1 = node:sqlite built from every real
// migration (+ player_contracts / player_contract_stints, legacy tables with no
// migration — created here with exactly the columns the route reads); the only fake is
// MFL's HTTP export, which answers playerScores per season for the fallback
// path. Values are MFL league 74598's real 2026 Wks 1-3, captured 2026-10-01.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, callWorker, quiet } from "./fixtures/fcfs_worker_harness.mjs";

function setup({ d1Ready = true, mflYtd = {} } = {}) {
  const env = makeWorkerEnv();
  const db = env.UPS_MFL_DB.raw;
  for (const f of fs.readdirSync("worker/migrations").filter((x) => /^\d{4}_.*\.sql$/.test(x)).sort()) {
    // Three historical migrations ALTER tables that predate the migration set
    // (src_standings, ups_extension_history); none touch the tables read here.
    try { db.exec(fs.readFileSync("worker/migrations/" + f, "utf8")); } catch (_) { /* see above */ }
  }
  if (d1Ready) {
    db.exec(`CREATE TABLE IF NOT EXISTS player_contracts (
      player_id TEXT, contract_id TEXT, contract_seq INTEGER, origin_event TEXT, origin_date_iso TEXT,
      origin_franchise_id TEXT, origin_owner_name TEXT, contract_type TEXT, contract_length_cl INTEGER,
      aav_usd INTEGER, tcv_usd INTEGER, year_salaries_json TEXT, last_modification_event TEXT,
      last_modification_date_iso TEXT, origin_aav_usd INTEGER, origin_tcv_usd INTEGER, origin_cl INTEGER,
      termination_event TEXT, termination_date_iso TEXT, termination_franchise_id TEXT,
      termination_owner_name TEXT, cap_hit_usd INTEGER, earned_at_termination_usd INTEGER, notes TEXT)`);
    db.exec(`CREATE TABLE IF NOT EXISTS player_contract_stints (
      contract_id TEXT, stint_seq INTEGER, start_date_iso TEXT, end_date_iso TEXT, start_event TEXT, end_event TEXT,
      franchise_id TEXT, owner_name TEXT, earned_during_stint_usd INTEGER, earned_era TEXT,
      cumulative_earned_at_start_usd INTEGER, cumulative_earned_at_end_usd INTEGER)`);
  }
  const ins = db.prepare("INSERT INTO src_weekly (season, week, player_id, score, status, pos_group, is_reg) VALUES (2026, ?, ?, ?, ?, ?, 1)");
  for (const r of [
    [3, "10313", -2.0, "fa", "QB"],                                              // Dalton
    [1, "12678", 2.2, "fa", "TE"], [2, "12678", 0.0, "fa", "TE"], [3, "12678", 25.4, "fa", "TE"],   // Higbee
    [1, "14057", 15.7, "fa", "QB"], [2, "14057", 29.2, "nonstarter", "QB"], [3, "14057", null, "nonstarter", "QB"], // Lock
  ]) ins.run(...r);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(String(input));
    const year = (u.pathname.match(/\/(\d{4})\//) || [])[1];
    if (u.searchParams.get("TYPE") === "playerScores" && u.searchParams.get("W") === "YTD" && year && u.searchParams.get("P")) {
      const score = mflYtd[year];
      return new Response(JSON.stringify({ playerScores: { week: "YTD", playerScore: { id: u.searchParams.get("P"), week: "YTD", score: score == null ? "" : score } } }),
        { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  };
  const bundle = async (pid) => {
    const restore = quiet();
    try { return (await callWorker(env, "GET", `/api/player-bundle?pid=${pid}&L=74598&YEAR=2026&NO_CACHE=1`)).json; }
    finally { restore(); }
  };
  return { bundle, done: () => { globalThis.fetch = realFetch; } };
}
const season = (b, y) => (b.career_summary || []).find((r) => Number(r.season) === y);

test("a negative-only season gets its row (Dalton 2026: 1 G, -2.0)", async () => {
  const h = setup();
  try {
    const b = await h.bundle("10313");
    t.equal(b.enrichment_source, "d1");
    const s = season(b, 2026);
    t.ok(s, "2026 row exists");
    t.equal(Number(s.games_played), 1);
    t.equal(Number(s.season_points), -2);
    t.equal(Number(s.avg_ppg), -2);
    const wk = (b.weekly || []).find((w) => Number(w.season) === 2026 && Number(w.week) === 3);
    t.ok(wk && Number(wk.score) === -2, "the -2.0 week is in the game log");
  } finally { h.done(); }
});

test("a 0.0 week is a game: Higbee 2026 = 3 G / 27.6 / 9.20 PPG, MFL's own AVG", async () => {
  const h = setup();
  try {
    const s = season(await h.bundle("12678"), 2026);
    t.equal(Number(s.games_played), 3, "was 2 with the 0.0 week dropped");
    t.equal(Number(s.season_points), 27.6);
    t.equal(Number(s.avg_ppg), 9.2, "MFL W=AVG says 9.20 (was 13.8)");
  } finally { h.done(); }
});

test("a rostered week MFL posted NO score for (NULL) is still not a game: Lock 2026 = 2 G / 44.9 / 22.45", async () => {
  const h = setup();
  try {
    const b = await h.bundle("14057");
    const s = season(b, 2026);
    t.equal(Number(s.games_played), 2);
    t.equal(Number(s.season_points), 44.9);
    t.equal(Number(s.avg_ppg), 22.45, "MFL W=AVG says 22.45");
    t.ok(!(b.weekly || []).some((w) => Number(w.season) === 2026 && Number(w.week) === 3), "the NULL week is not in the game log");
  } finally { h.done(); }
});

test("MFL fallback keeps 0.0 and negative seasons, drops only seasons MFL left blank", async () => {
  // D1 unusable (player_contracts missing -> the D1 block throws) -> fallback.
  const h = setup({ d1Ready: false, mflYtd: { 2026: "-2.0", 2025: "", 2024: "0.0", 2023: "153.2" } });
  try {
    const b = await h.bundle("10313");
    t.equal(b.enrichment_source, "mfl_fallback");
    const ys = (b.career_summary || []).map((r) => r.season + ":" + r.season_points);
    t.ok(ys.includes("2026:-2"), "negative season kept: " + ys.join(","));
    t.ok(ys.includes("2024:0"), "0.0 season kept");
    t.ok(ys.includes("2023:153.2"));
    t.ok(!ys.some((y) => y.startsWith("2025:")), "blank (no games) season dropped");
    t.ok((b.career_summary || []).every((r) => !("scored" in r)), "internal flag not leaked to clients");
  } finally { h.done(); }
});

await run("player_bundle_zero_negative_scores");
