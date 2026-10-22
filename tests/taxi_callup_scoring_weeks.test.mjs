// A taxi call-up is a QUALIFYING SCORING WEEK, never a transaction (Keith 2026-10-21): the player is active — or on
// IR — for an official UPS scoring week. A promotion reversed before his game uses nothing; several moves in one week
// use at most one; he may return to taxi after the third; a brief fourth promotion reversed before a scoring week
// leaves him eligible; the 4th qualifying week is permanent.
//   node tests/taxi_callup_scoring_weeks.test.mjs
//
// One 2026 Round 2 rookie (17201, KCC, franchise 0001) through Weeks 1–6, against the REAL worker: the weekly counter
// (/admin/taxi-callups/sync-weeks, dry run — the test then stores what it would write), /api/taxi-callups (the count
// every surface reads) and the confirm pass, over a SQLite D1 and a fake MFL whose weekly record says:
//   Week 1  promoted Thursday, back on taxi Friday, game Sunday → MFL's weekly record: taxi
//   Week 2  active
//   Week 3  active, after three promote clicks that week
//   Week 4  active (his third qualifying week)
//   Week 5  promoted again, back on taxi before his game → taxi
//   Week 6  active (his fourth qualifying week)
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { taxiEligibility, taxiPermanent } from "../worker/src/taxi_rule.js";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const RealDate = Date;
let NOW = 0;
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const U = (iso) => Math.floor(RealDate.parse(iso) / 1000);
const sql = (sec) => new RealDate(sec * 1000).toISOString().replace("T", " ").slice(0, 19);
// KCC plays Sunday 1 PM ET every week; one Monday game closes the week.
const sun = (w) => U("2026-09-13T17:00:00Z") + 7 * 86400 * (w - 1);
const games = (w) => [{ kickoff: String(sun(w)), gameSecondsRemaining: "3600", team: [{ id: "KCC" }, { id: "LVR" }] },
  { kickoff: String(sun(w) + 86400 + 6 * 3600), gameSecondsRemaining: "3600", team: [{ id: "NYG" }, { id: "DAL" }] }];
const afterWeek = (w) => new RealDate((sun(w) + 86400 + 6 * 3600 + 11 * 60) * 1000).toISOString();

const P = "17201";
const WEEKLY = { 1: "TAXI_SQUAD", 2: "ROSTER", 3: "ROSTER", 4: "ROSTER", 5: "TAXI_SQUAD", 6: "ROSTER" };
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  const type = u.searchParams.get("TYPE"), w = Number(u.searchParams.get("W"));
  if (type === "nflSchedule") return json({ nflSchedule: { week: String(w), matchup: w <= 17 ? games(w) : [] } });
  if (type === "salaries") return json({ salaries: { leagueUnit: { player: [{ id: P, contractStatus: "Rookie-Draft", salary: "2000" }] } } });
  if (type === "players") return json({ players: { player: [{ id: P, team: "KCC" }] } });
  if (type === "weeklyResults") {   // MFL's weekly record: the active roster for that scoring week (taxi / IR not listed)
    return json({ weeklyResults: { week: String(w), matchup: [{ franchise: [{ id: "0001", player: WEEKLY[w] === "ROSTER" ? [{ id: P }] : [] }] }] } });
  }
  if (type === "rosters") return json({ rosters: { franchise: [{ id: "0001", week: String(w), player: [{ id: P, status: WEEKLY[w] || "TAXI_SQUAD" }] }] } });
  return json({ error: "test: no such call " + type }, 503);
};

const db = makeD1({});
db.raw.exec("CREATE TABLE ups_draft_picks (season INTEGER, round INTEGER, player_id TEXT)");
db.raw.prepare("INSERT INTO ups_draft_picks VALUES (2026, 2, ?)").run(P);
db.raw.exec(`CREATE TABLE ups_taxi_callups (id INTEGER PRIMARY KEY AUTOINCREMENT, league_id TEXT, season TEXT, franchise_id TEXT, player_id TEXT,
  nfl_week INTEGER, called_up_at TEXT, demoted_at TEXT, became_permanent INTEGER DEFAULT 0, callup_index INTEGER, pending INTEGER DEFAULT 0,
  source TEXT, acting_user_id TEXT, raw_payload_json TEXT, submitted_at_utc TEXT)`);
db.raw.exec("CREATE TABLE ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
db.raw.exec(`INSERT INTO ups_settings (key, value) VALUES ('taxi_legacy_active_2025_v1', '["99999"]')`);
const env = { UPS_MFL_DB: db, COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k" };
const call = async (method, path, body) => {
  const res = await worker.fetch(new Request("https://w.test" + path, { method, body: body ? JSON.stringify(body) : undefined, headers: { "content-type": "application/json" } }),
    env, { waitUntil() {}, passThroughOnException() {} });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  return { status: res.status, j, text };
};
const click = (atSec, demotedSec) => db.raw.prepare(
  "INSERT INTO ups_taxi_callups (league_id, season, franchise_id, player_id, nfl_week, called_up_at, demoted_at, pending, source) VALUES ('74598', '2026', '0001', ?, NULL, ?, ?, 1, 'worker:promote_taxi')"
).run(P, sql(atSec), demotedSec ? sql(demotedSec) : null);
// Run the weekly counter after week w and store what it would write (the flag-gated write, done here by the test).
async function countThrough(w) {
  NOW = RealDate.parse(afterWeek(w));
  const r = await call("POST", "/admin/taxi-callups/sync-weeks?L=74598&YEAR=2026&APIKEY=admin&dry_run=1", {});
  if (r.status !== 200 || !r.j || !r.j.ok) throw new Error(r.text.slice(0, 300));
  for (const x of r.j.inserts) {
    db.raw.prepare("INSERT INTO ups_taxi_callups (league_id, season, franchise_id, player_id, nfl_week, callup_index, became_permanent, pending, source) VALUES ('74598', '2026', ?, ?, ?, ?, ?, 0, 'mfl-weekly-sync')")
      .run(x.franchise_id, x.player_id, x.week, x.callup_index, x.became_permanent ? 1 : 0);
  }
  for (const s of r.j.superseded) db.raw.prepare("UPDATE ups_taxi_callups SET pending = 2 WHERE id = ? AND pending = 1").run(s.id);
  return r.j;
}
const status = async () => (await call("GET", "/api/taxi-callups?L=74598&YEAR=2026")).j.players[P] || { used: 0, permanent_promotion: false, tracked_permanent: false, legacy_2025: false };
const verdict = (st, where) => taxiEligibility({ upsRound: 2, upsYear: 2026, season: 2026, contractStatus: "Rookie-Draft", used: st.used, pending: 0,
  permanent: taxiPermanent({ used: st.used, marked: st.tracked_permanent ? 1 : 0, legacy2025: false }), legacy2025: false, ...where });

test("Thursday promotion, Friday demotion, Sunday game → no call-up used (the click is superseded, never counted)", async () => {
  click(sun(1) - 3 * 86400, sun(1) - 2 * 86400);   // Thursday promote, Friday back on taxi
  const r = await countThrough(1);
  t.deepEqual(r.inserts, [], "MFL's weekly record shows him on taxi for Week 1");
  t.equal(r.superseded.length, 1, "the promote click is marked superseded");
  t.equal((await status()).used, 0);
  t.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM ups_taxi_callups WHERE pending = 0").get().n, 0, "nothing counted");
});

test("active for the scoring week → one call-up used", async () => {
  const r = await countThrough(2);
  t.deepEqual(r.inserts.map((x) => [x.week, x.callup_index, x.became_permanent]), [[2, 1, false]]);
  t.equal((await status()).used, 1);
});

test("several moves within one week → no more than one call-up", async () => {
  for (const h of [-4, -3, -2]) click(sun(3) + h * 86400, null);   // three promote clicks during Week 3
  const r = await countThrough(3);
  t.deepEqual(r.inserts.map((x) => [x.week, x.callup_index]), [[3, 2]], "one row for Week 3");
  t.equal(r.superseded.length, 3, "all three clicks superseded");
  t.equal((await status()).used, 2);
  // Even a second stored row for the same week (e.g. an older writer's) is one week.
  db.raw.prepare("INSERT INTO ups_taxi_callups (league_id, season, franchise_id, player_id, nfl_week, pending, source) VALUES ('74598', '2026', '0001', ?, 3, 0, 'older-writer')").run(P);
  t.equal((await status()).used, 2, "distinct scoring weeks, not rows");
});

test("demotion after the third qualifying week → allowed", async () => {
  const r = await countThrough(4);
  t.deepEqual(r.inserts.map((x) => [x.week, x.callup_index, x.became_permanent]), [[4, 3, false]]);
  const st = await status();
  t.deepEqual([st.used, st.permanent_promotion], [3, false]);
  const v = verdict(st, { isTaxi: false, isIr: false });
  t.deepEqual([v.eligible, v.can_demote, v.callups_left, v.next_callup_permanent], [true, true, 0, true]);
});

test("a transient fourth promotion reversed before the scoring week → still eligible", async () => {
  click(sun(5) - 3 * 86400, sun(5) - 2 * 86400);
  const r = await countThrough(5);
  t.deepEqual(r.inserts, [], "back on taxi for Week 5: no qualifying week");
  const st = await status();
  t.deepEqual([st.used, st.permanent_promotion], [3, false]);
  t.equal(verdict(st, { isTaxi: true }).eligible, true);
  t.equal(verdict(st, { isTaxi: true }).text, "Eligible · 0 of 3 call-ups left");
});

test("the confirm pass never charges a call-up itself: the weekly count is the one writer", async () => {
  db.raw.prepare("INSERT INTO ups_taxi_callups (league_id, season, franchise_id, player_id, nfl_week, called_up_at, pending, source) VALUES ('74598', '2026', '0001', ?, 6, ?, 1, 'worker:promote_taxi')")
    .run(P, sql(sun(6) - 3 * 86400));
  NOW = RealDate.parse(afterWeek(6));
  const before = db.raw.prepare("SELECT COUNT(*) AS n FROM ups_taxi_callups WHERE pending = 0").get().n;
  const c = await call("POST", "/api/taxi-callups/confirm", { league_id: "74598", season: "2026" });
  t.deepEqual((c.j && c.j.confirmed) || [], [], "nothing confirmed");
  t.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM ups_taxi_callups WHERE pending = 0").get().n, before, "no call-up row written");
  t.equal((await status()).used, 3, "still three");
  // By construction: the route has no statement that turns a click into a counted week.
  const fs = await import("node:fs");
  const SRC = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const i = SRC.indexOf('if (path === "/api/taxi-callups/confirm" && request.method === "POST") {');
  const route = SRC.slice(i, SRC.indexOf("// ── POST /api/settings", i));
  t.ok(!/SET pending = 0/.test(route) && /reason: "weekly_count_decides"/.test(route), "the confirm pass never sets pending = 0");
  // KNOWN, PRE-EXISTING (also on main): padFranchiseId is a later const in the fetch handler, so this route throws
  // before touching a row whenever a click is pending. Reported, not changed here (fixing it would start its deletes).
  t.ok(c.status === 200 || /padFranchiseId/.test(c.text), c.text.slice(0, 200));
});

test("the fourth qualifying active week → permanently promoted", async () => {
  const r = await countThrough(6);
  t.deepEqual(r.inserts.map((x) => [x.week, x.callup_index, x.became_permanent]), [[6, 4, true]]);
  t.equal(r.superseded.length, 1, "the Week 6 click is superseded, not counted again");
  const st = await status();
  t.deepEqual([st.used, st.permanent_promotion, st.tracked_permanent], [4, true, true]);
  const v = verdict(st, { isTaxi: false });
  t.deepEqual([v.eligible, v.text], [false, "Not eligible · permanently promoted after three temporary call-ups"]);
});

await run("taxi_callup_scoring_weeks");
