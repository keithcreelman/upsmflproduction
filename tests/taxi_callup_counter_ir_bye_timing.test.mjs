// The weekly taxi call-up counter (syncTaxiCallupWeeks), Keith's rulings of 2026-10-16:
//   - IR COUNTS (canon §B2) — weeklyResults never lists IR players, so IR weeks were never counted;
//   - a BYE week is never an active week;
//   - a week is recorded 10 minutes after its LAST kickoff (the late Monday game when there are two), not the next morning.
//   node tests/taxi_callup_counter_ir_bye_timing.test.mjs
//
// The REAL /admin/taxi-callups/sync-weeks route in dry_run (nothing is written) against a SQLite D1 and a fake MFL; then
// _taxiCallupWeekDue, which the */5 tick asks before running the counter.
import fs from "node:fs";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const RealDate = Date;
let NOW = 0;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const U = (iso) => Math.floor(RealDate.parse(iso) / 1000);
// 2026 weeks: Thursday 8:15 PM ET opener (KCC), Sunday 1 PM (BUF), Monday DOUBLEHEADER 7:15 PM (NYG) and 8:15 PM ET (PHI).
// Week 2: NYG has a bye.
function games(w) {
  const thu = w === 1 ? U("2026-09-10T00:20:00Z") : U("2026-09-18T00:15:00Z") + 7 * 86400 * (w - 2);
  const sun = U("2026-09-13T17:00:00Z") + 7 * 86400 * (w - 1);
  const mon1 = U("2026-09-14T23:15:00Z") + 7 * 86400 * (w - 1), mon2 = U("2026-09-15T00:15:00Z") + 7 * 86400 * (w - 1);
  const g = [[thu, "KCC", "BAL"], [sun, "BUF", "MIA"], [mon1, "NYG", "DAL"], [mon2, "PHI", "WAS"]];
  return (w === 2 ? g.filter((x) => x[1] !== "NYG") : g).map(([ko, a, b]) => ({ kickoff: String(ko), gameSecondsRemaining: "3600", team: [{ id: a }, { id: b }] }));
}
const lastKickoff = (w) => Math.max(...games(w).map((g) => Number(g.kickoff)));

// Four 2026 Round-2 rookies on 0001, none ever called up:
//   A 17101 KCC — active weeks 1–3        → 3 weeks
//   B 17102 BUF — on IR weeks 1–2         → 2 weeks (were 0: weeklyResults never lists IR)
//   C 17103 NYG — active weeks 1–3        → weeks 1 and 3 (Week 2 is his bye; was 3)
//   D 17104 KCC — on taxi all along       → 0
const TEAM = { "17101": "KCC", "17102": "BUF", "17103": "NYG", "17104": "KCC" };
const STATUS = { "17101": "ROSTER", "17102": "INJURED_RESERVE", "17103": "ROSTER", "17104": "TAXI_SQUAD" };
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
const MFL = { rostersDown: false, playersDown: false };
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const type = u.searchParams.get("TYPE"), w = Number(u.searchParams.get("W"));
  if (type === "nflSchedule") return json({ nflSchedule: { week: String(w), matchup: games(w) } });
  if (type === "salaries") return json({ salaries: { leagueUnit: { player: Object.keys(TEAM).map((id) => ({ id, contractStatus: "Rookie-Draft", salary: "2000" })) } } });
  if (type === "players") return MFL.playersDown ? json({ error: "down" }, 503) : json({ players: { player: Object.entries(TEAM).map(([id, team]) => ({ id, team })) } });
  if (type === "weeklyResults") {   // active roster only: taxi and IR players are not listed
    return json({ weeklyResults: { week: String(w), matchup: [{ franchise: [{ id: "0001", player: Object.keys(TEAM).filter((id) => STATUS[id] === "ROSTER").map((id) => ({ id })) }] }] } });
  }
  if (type === "rosters") {
    if (MFL.rostersDown) return json({ error: "down" }, 503);
    const st = (id) => (id === "17102" && w > 2 ? "ROSTER_OFF" : STATUS[id]);   // B came off IR (and off the roster) after Week 2
    return json({ rosters: { franchise: [{ id: "0001", week: String(w), player: Object.keys(TEAM).filter((id) => st(id) !== "ROSTER_OFF").map((id) => ({ id, status: st(id) })) }] } });
  }
  if (type === "myleagues") return json({ leagues: { league: [] } });
  return json({ error: "test: no such call " + type }, 503);
};
const db = makeD1({});
db.raw.exec("CREATE TABLE ups_draft_picks (season INTEGER, round INTEGER, player_id TEXT)");
for (const id of Object.keys(TEAM)) db.raw.prepare("INSERT INTO ups_draft_picks VALUES (2026, 2, ?)").run(id);
db.raw.exec("CREATE TABLE ups_taxi_callups (id INTEGER PRIMARY KEY AUTOINCREMENT, league_id TEXT, season TEXT, franchise_id TEXT, player_id TEXT, nfl_week INTEGER, called_up_at TEXT, demoted_at TEXT, became_permanent INTEGER DEFAULT 0, callup_index INTEGER, pending INTEGER DEFAULT 0, source TEXT, raw_payload_json TEXT)");
db.raw.exec("CREATE TABLE ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
db.raw.exec(`INSERT INTO ups_settings (key, value) VALUES ('taxi_legacy_active_2025_v1', '["99999"]')`);
const env = { UPS_MFL_DB: db, COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k" };
async function count(atIso) {
  NOW = RealDate.parse(atIso);
  const res = await worker.fetch(new Request("https://w.test/admin/taxi-callups/sync-weeks?L=74598&YEAR=2026&APIKEY=admin&dry_run=1", { method: "POST", body: "{}" }),
    env, { waitUntil() {}, passThroughOnException() {} });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  return { status: res.status, j, text };
}
const weeksOf = (r) => {
  const by = {};
  for (const x of r.j.inserts || []) (by[x.player_id] = by[x.player_id] || []).push(x.week);
  return by;
};

test("1. IR counts, a bye doesn't, taxi never does — through Week 3 (counted at 10 minutes after Week 3's last Monday kickoff)", async () => {
  const r = await count(new RealDate((lastKickoff(3) + 11 * 60) * 1000).toISOString());
  t.equal(r.status, 200, r.text.slice(0, 300));
  t.equal(r.j.counted_through_week, 3);
  t.deepEqual(weeksOf(r), { "17101": [1, 2, 3], "17102": [1, 2], "17103": [1, 3] });
  t.deepEqual(r.j.inserts.filter((x) => x.player_id === "17102").map((x) => x.basis), ["weekly rosters INJURED_RESERVE", "weekly rosters INJURED_RESERVE"]);
});
test("2. a week waits for its LAST kickoff + 10 min: 9 minutes after the late Monday game (doubleheader), Week 3 is not recorded yet", async () => {
  const r = await count(new RealDate((lastKickoff(3) + 9 * 60) * 1000).toISOString());
  t.equal(r.j.counted_through_week, 2);
  t.deepEqual(r.j.stopped_at, { week: 3, reason: "week_not_locked" });
  // 10 minutes after the EARLY Monday game is not enough either
  const mon1 = Number(games(3).find((g) => g.team[0].id === "NYG").kickoff);
  t.equal((await count(new RealDate((mon1 + 11 * 60) * 1000).toISOString())).j.counted_through_week, 2);
});
test("3. FAILS CLOSED: unreadable weekly rosters stop the count; unreadable NFL teams count nothing", async () => {
  MFL.rostersDown = true;
  const a = await count(new RealDate((lastKickoff(3) + 11 * 60) * 1000).toISOString());
  MFL.rostersDown = false;
  t.equal(a.j.error, "weekly_rosters_unreadable", "nothing counted (the first week already could not be read)");
  MFL.playersDown = true;
  const b = await count(new RealDate((lastKickoff(3) + 11 * 60) * 1000).toISOString());
  MFL.playersDown = false;
  t.equal(b.j.error, "players_unreadable");
});

// ── the */5 trigger ──
const SRC = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
const cut = (start, end) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not found: " + start); return SRC.slice(i, SRC.indexOf(end, i)); };
const dueCode = cut("const TAXI_CALLUP_WEEK_RECORD_DELAY_SEC", "// Runs the counter (a real write)");
const { _taxiCallupWeekDue } = new Function("nflWeekLastKickoffUnix", dueCode + "\nreturn { _taxiCallupWeekDue };")(async (season, w) => lastKickoff(w));
test("4. _taxiCallupWeekDue: the latest week past its last kickoff + 10 min, until the counter has recorded it", async () => {
  db.raw.exec("DELETE FROM ups_settings WHERE key = 'taxi_callup_weeks_through_2026'");
  t.equal(await _taxiCallupWeekDue(env, "2026", lastKickoff(3) + 9 * 60), 2);
  t.equal(await _taxiCallupWeekDue(env, "2026", lastKickoff(3) + 11 * 60), 3);
  db.raw.exec("INSERT INTO ups_settings (key, value) VALUES ('taxi_callup_weeks_through_2026', '3')");
  t.equal(await _taxiCallupWeekDue(env, "2026", lastKickoff(3) + 11 * 60), 0, "already recorded");
  t.equal(await _taxiCallupWeekDue(env, "2026", lastKickoff(4) + 11 * 60), 4);
});
test("5. the */5 tick asks _taxiCallupWeekDue, behind the same flag, and the run records how far it got", () => {
  const block = cut("// Taxi call-up weeks: each week recorded 10 minutes after its LAST kickoff", "// Drop tracker — scan MFL FREE_AGENT txs");
  t.match(block, /if \(!\(await _taxiCallupWeekDue\(env, season, Math\.floor\(Date\.now\(\) \/ 1000\)\)\)\) return;\s+if \(!\(await getFeatureFlag\(env, "TAXI_CALLUP_WEEKLY_SYNC_ENABLED"\)\)\) return;\s+await _runTaxiCallupWeekCount\(/);
  t.match(cut("async function _runTaxiCallupWeekCount", "async function syncTaxiCallupWeeks"), /_taxiCallupWeeksMarkerKey\(season\), String\(ws\.counted_through_week\)/);
});

await run("taxi_callup_counter_ir_bye_timing");
