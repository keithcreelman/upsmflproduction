// A cut is never "Cap penalty: unknown" just because the player arrived after the morning's roster snapshot (Keith 2026-10-16).
//   node tests/pre_drop_contract_hourly_snapshots.test.mjs
//
// 2026-10-16: Blake Bombers claimed Ryan Flournoy (16778, $1K Vet-WW) in Thursday's 9 AM ET run and cut him for Christian
// Kirk in Friday's. Thursday's daily snapshot was taken at 5:05 AM ET, before the claim, and Friday's was never written —
// so the drop ledger booked "no_pre_drop_contract" and the waiver card said "Cap penalty: unknown — needs review" for a
// $0 cut (a 1-year WW deal at $4K or less is cap-free, canon §D1).
//
// The REAL /admin/drops/scan-and-record and /admin/adds/post-discord (dry run) routes against one D1 and a fake MFL / R2.
import fs from "node:fs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const RealDate = Date;
let NOW = RealDate.parse("2026-10-16T13:06:00Z");
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ET = (iso) => Math.floor(RealDate.parse(iso) / 1000);
const THU = ET("2026-10-15T09:00:00-04:00"), FRI = ET("2026-10-16T09:00:00-04:00");
const TXS = [
  { type: "BBID_WAIVER", franchise: "0010", timestamp: String(THU), transaction: "16778,|1000|14943," },   // + Flournoy − Davis-Gaither
  { type: "BBID_WAIVER", franchise: "0010", timestamp: String(FRI), transaction: "13633,|1000|16778," },   // + Kirk − Flournoy
];
const flournoy = { id: "16778", salary: "1000", status: "ROSTER", contractStatus: "Vet-WW", contractInfo: "CL 1| TCV 1K| AAV 1K", contractYear: "1" };
const davisGaither = { id: "14943", salary: "3000", status: "ROSTER", contractStatus: "Vet-WW", contractInfo: "CL 1| TCV 3K| AAV 3K", contractYear: "1" };
const rosters = (byFid) => ({ rosters: { franchise: Object.entries(byFid).map(([id, player]) => ({ id, player })) } });

// ── R2: daily snapshots (snapshots/<day>/rosters.json) and hourly copies (snapshots/hourly/<day>/<HH>.json) ──
let R2 = {};
const putObj = (key, json, uploadedIso) => { R2[key] = { text: JSON.stringify(json), uploaded: new RealDate(uploadedIso) }; };
const r2 = {
  async get(key) { const o = R2[key]; return o ? { async text() { return o.text; }, uploaded: o.uploaded } : null; },
  async head(key) { return R2[key] ? { uploaded: R2[key].uploaded } : null; },
  async put(key, body, opts) { R2[key] = { text: String(body), uploaded: new RealDate(NOW), opts }; },
  async delete(key) { delete R2[key]; },
};
function morningOnly() {   // Thursday's daily snapshot (5:05 AM ET): Davis-Gaither still on Blake Bombers, no Flournoy; NO Friday snapshot
  R2 = {};
  putObj("snapshots/2026-10-15/rosters.json", rosters({ "0010": [davisGaither] }), "2026-10-15T09:05:30Z");
}
function hourlyCopies() {  // every hour from Thursday 10 AM ET (after the claim) to Friday 9:05 AM ET
  for (let ms = RealDate.parse("2026-10-15T14:05:00Z"); ms <= RealDate.parse("2026-10-16T13:05:00Z"); ms += 3600000) {
    const d = new RealDate(ms);
    putObj(`snapshots/hourly/${d.toISOString().slice(0, 10)}/${String(d.getUTCHours()).padStart(2, "0")}.json`, rosters({ "0010": [flournoy] }), d.toISOString());
  }
}

function nflSchedule(w) {
  const ko = (d, h, m) => String(Math.floor(RealDate.UTC(2026, 8, d, h, m) / 1000));
  const thu = w === 1 ? ko(10, 0, 20) : ko(18 + 7 * (w - 2), 0, 15), sun = ko(13 + 7 * (w - 1), 17, 0), mon = ko(15 + 7 * (w - 1), 0, 15);
  return { nflSchedule: { week: String(w), matchup: [{ kickoff: thu, team: [{ id: "KCC" }, { id: "BAL" }] }, { kickoff: sun, team: [{ id: "BUF" }, { id: "MIA" }] }, { kickoff: mon, team: [{ id: "NYG" }, { id: "DAL" }] }] } };
}
const liveWeek = () => { let w = 1; for (let k = 1; k <= 18; k++) if (Number(nflSchedule(k).nflSchedule.matchup[0].kickoff) * 1000 <= NOW) w = k; return w; };
const DISCORD_CALLS = [];
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (/discord\.com$/.test(u.hostname)) { DISCORD_CALLS.push(u.pathname); return json({ message: "test: Discord is unreachable" }, 500); }
  if (/myfantasyleague\.com$/.test(u.hostname)) {
    if (/\/import$/.test(u.pathname)) throw new Error("test: no MFL write may happen here");
    const type = u.searchParams.get("TYPE");
    if (type === "nflSchedule") return json(nflSchedule(Number(u.searchParams.get("W"))));
    if (type === "transactions") {
      const tt = u.searchParams.get("TRANS_TYPE");
      return json({ transactions: { transaction: TXS.filter((x) => Number(x.timestamp) <= NOW / 1000 && (!tt || x.type === tt)) } });
    }
    if (type === "liveScoring") return json({ liveScoring: { week: String(liveWeek()) } });
    if (type === "players") return json({ players: { player: [["16778", "Flournoy, Ryan", "WR", "DAL"], ["13633", "Kirk, Christian", "WR", "SFO"], ["14943", "Davis-Gaither, Akeem", "LB", "IND"]].map(([id, name, position, team]) => ({ id, name, position, team })) } });
    if (type === "league") return json({ league: { franchises: { franchise: [{ id: "0010", name: "Blake Bombers" }, { id: "0003", name: "Team Three" }] } } });
    if (type === "salaries") return json({ salaries: { leagueUnit: { player: [{ id: "13633", salary: "1000", contractStatus: "Vet-WW", contractYear: "1", contractInfo: "CL 1| TCV 1K| AAV 1K" }] } } });
    if (type === "injuries") return json({ injuries: { injury: [] } });
    return json({ error: "test: no such export " + type }, 503);
  }
  return json({ error: "test: no such call " + u.hostname }, 503);
};

function makeDb() {
  const db = makeD1({});
  db.raw.exec(`CREATE TABLE ups_drop_events (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT, league_id TEXT, player_id TEXT, player_name TEXT, position TEXT, nfl_team TEXT,
    franchise_id TEXT, franchise_name TEXT, dropped_at_unix INTEGER, dropped_at_iso TEXT, pre_drop_contract_status TEXT, pre_drop_salary INTEGER, pre_drop_contract_year INTEGER,
    pre_drop_contract_length INTEGER, pre_drop_contract_info TEXT, pre_drop_tcv INTEGER, pre_drop_aav INTEGER, pre_drop_years_remaining INTEGER, pre_drop_taxi INTEGER,
    earned_to_date INTEGER, guaranteed_amount INTEGER, penalty_amount INTEGER, penalty_basis TEXT, penalty_exempt INTEGER, penalty_exempt_reason TEXT, ledger_key TEXT UNIQUE,
    posted_to_mfl INTEGER DEFAULT 0, posted_at_utc TEXT, posted_amount INTEGER, posted_explanation TEXT, source TEXT, detected_at_utc TEXT, raw_transaction_json TEXT,
    snapshot_source TEXT, discord_posted INTEGER DEFAULT 0, discord_channel_id TEXT, discord_message_id TEXT, notes TEXT,
    applies_to_season INTEGER, cap_season_source TEXT, cap_season_resolved_at_utc TEXT, cap_season_needs_review INTEGER, cap_season_review_reason TEXT,
    UNIQUE (season, league_id, player_id, dropped_at_unix))`);
  const subCols = "id INTEGER, league_id TEXT, season TEXT, franchise_id TEXT, player_id TEXT, new_contract_status TEXT, new_salary INTEGER, new_contract_year INTEGER, new_contract_info TEXT, submitted_at_utc TEXT, dry_run INTEGER";
  db.raw.exec(`CREATE TABLE ups_extension_submissions (${subCols}); CREATE TABLE ups_mym_submissions (${subCols}); CREATE TABLE ups_restructure_submissions (${subCols}, voided_at_utc TEXT);`);
  db.raw.exec("CREATE TABLE ups_taxi_callups (player_id TEXT, pending INTEGER, became_permanent INTEGER DEFAULT 0)");
  applyMigrations(db, ["0112_ups_add_events.sql"]);
  db.raw.prepare(`INSERT INTO ups_add_events (season, league_id, player_id, player_name, franchise_id, franchise_name, acquired_at_unix, acquired_at_iso,
    source, bid_dollars, acquisition_week, detected_at_utc) VALUES ('2026', '74598', '13633', 'Christian Kirk', '0010', 'Blake Bombers', ?, ?, 'bbid', 1000, 7, ?)`)
    .run(FRI, new RealDate(FRI * 1000).toISOString(), new RealDate(FRI * 1000 + 60000).toISOString());
  return db;
}
const makeEnv = (d) => ({ UPS_MFL_DB: d, UPS_MFL_BACKUPS: r2, COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k",
  FA_AUCTION_START_AT: String(ET("2026-07-25T12:00:00-04:00")), DISCORD_BOT_TOKEN: "bot", DISCORD_DROPS_TEST_CHANNEL_ID: "999" });
async function call(env, path, body) {
  const res = await worker.fetch(new Request("https://w.test" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    env, { waitUntil() {}, passThroughOnException() {} });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  return { status: res.status, json: j, text };
}
const Q = "?L=74598&YEAR=2026&APIKEY=admin";
const scan = (env) => call(env, "/admin/drops/scan-and-record" + Q, { season: "2026", league_id: "74598", days: 2, include_waivers: true });
const poster = (env) => call(env, "/admin/adds/post-discord" + Q, { season: "2026", league_id: "74598", target: "test", shape: "report", limit: 50, dry_run: true });
const ledger = (db) => ({ ...db.raw.prepare("SELECT * FROM ups_drop_events WHERE player_id = '16778'").get() });
const kirkCard = (res) => {
  const m = res.json.runs.flatMap((r) => r.plan.move_messages || []).find((x) => JSON.stringify(x.body).includes("Waiver Claim — Christian Kirk"));
  if (!m) throw new Error("no Kirk card: " + res.text.slice(0, 300));
  return m.body.embeds[0].description.split("\n")[0];
};

test("1. today's case — no Friday snapshot, hourly copies kept: the ledger books Flournoy's cut at $0 and the card says 'No Cap Penalty'", async () => {
  morningOnly(); hourlyCopies();
  const db = makeDb(), env = makeEnv(db);
  NOW = RealDate.parse("2026-10-16T13:06:00Z");
  const p = await poster(env);                    // the card can be built before the scan has written its row
  const s = await scan(env);
  t.equal(s.status, 200, s.text.slice(0, 300));
  const row = ledger(db);
  t.deepEqual([row.penalty_amount, row.penalty_basis, row.pre_drop_contract_info], [0, "ww_under_5k_exempt", "CL 1| TCV 1K| AAV 1K"]);
  t.equal(row.snapshot_source, "hourly:2026-10-16T12:05:00.000Z", "the newest copy taken BEFORE the 13:00 cut (13:05's is after it)");
  t.equal(kirkCard(p), "# ✅ No Cap Penalty");
  t.equal(kirkCard(await poster(env)), "# ✅ No Cap Penalty", "and after the ledger row exists");
  t.deepEqual(DISCORD_CALLS, []);
});
test("2. without hourly copies it stays honest: unpriced on both, never a guessed $0", async () => {
  morningOnly();
  const db = makeDb(), env = makeEnv(db);
  NOW = RealDate.parse("2026-10-16T13:06:00Z");
  const p = await poster(env);
  await scan(env);
  t.deepEqual([ledger(db).penalty_basis, ledger(db).penalty_amount], ["no_pre_drop_contract", null]);
  t.equal(kirkCard(p), "# ⚠️ Cap penalty: unknown — needs review");
});
test("3. a daily snapshot taken AFTER the cut is never used for it — not even when it shows him re-claimed by another team on another contract", async () => {
  morningOnly(); hourlyCopies();
  // Friday's daily snapshot written late (the self-healing retry at 10:05 AM ET), after Team Three re-claimed him at $9K × 2
  putObj("snapshots/2026-10-16/rosters.json", rosters({ "0003": [{ ...flournoy, salary: "9000", contractInfo: "CL 2| TCV 18K| AAV 9K", contractYear: "2" }] }), "2026-10-16T14:05:00Z");
  const db = makeDb(), env = makeEnv(db);
  NOW = RealDate.parse("2026-10-16T14:10:00Z");
  const p = await poster(env);
  await scan(env);
  t.deepEqual([ledger(db).penalty_amount, ledger(db).pre_drop_contract_info], [0, "CL 1| TCV 1K| AAV 1K"], "Blake Bombers' own $1K deal, from the hourly copy");
  t.equal(kirkCard(p), "# ✅ No Cap Penalty");
  delete R2["snapshots/hourly/2026-10-16/12.json"];
  for (let h = 0; h <= 12; h += 1) delete R2[`snapshots/hourly/2026-10-16/${String(h).padStart(2, "0")}.json`];
  for (let h = 14; h <= 23; h += 1) delete R2[`snapshots/hourly/2026-10-15/${h}.json`];
  const db2 = makeDb(), env2 = makeEnv(db2);
  await scan(env2);
  t.deepEqual([ledger(db2).penalty_basis, ledger(db2).penalty_amount], ["no_pre_drop_contract", null], "only the late snapshot has him: unpriced, not Team Three's $9K deal");
});

// ── the snapshot writers ──
const SRC = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
const cut = (start, end) => { const i = SRC.indexOf(start); if (i < 0) throw new Error("not found: " + start); const j = SRC.indexOf(end, i); return SRC.slice(i, j); };
test("4. every hourly tick keeps a rosters copy and deletes the one from 10 days back", async () => {
  R2 = {};
  const code = cut("const HOURLY_ROSTERS_KEEP_DAYS", "// The contract a FRANCHISE's player held just before");
  const fetchFake = async (url) => { t.match(String(url), /\/2026\/export\?TYPE=rosters&L=74598&JSON=1$/); return json(rosters({ "0010": [flournoy] })); };
  const mk = new Function("activeSeason", "fetch", code + "\nreturn { snapshotRostersHourlyToR2, _hourlyRostersKey };");
  const { snapshotRostersHourlyToR2 } = mk(async () => ({ ok: true, season: "2026" }), fetchFake);
  putObj("snapshots/hourly/2026-10-06/12.json", {}, "2026-10-06T12:05:00Z");
  NOW = RealDate.parse("2026-10-16T12:05:00Z");
  await snapshotRostersHourlyToR2({ UPS_MFL_BACKUPS: r2 }, new RealDate(NOW));
  t.deepEqual(JSON.parse(R2["snapshots/hourly/2026-10-16/12.json"].text), rosters({ "0010": [flournoy] }));
  t.equal(R2["snapshots/hourly/2026-10-06/12.json"], undefined, "10 days back: deleted");
  const unresolved = mk(async () => ({ ok: false, reason: "mfl_down" }), fetchFake).snapshotRostersHourlyToR2;
  let threw = ""; try { await unresolved({ UPS_MFL_BACKUPS: r2 }, new RealDate(NOW)); } catch (e) { threw = e.message; }
  t.match(threw, /active season unresolved/, "never a copy under a guessed season");
});
test("5. the daily snapshot is retried every hourly tick from 09 UTC until today's exists; the hourly copy runs every tick", () => {
  const block = cut("// SELF-HEALING (2026-10-16)", "// UPS Rookie Draft picks → D1 cache.");
  t.match(block, /if \(nowUtc\.getUTCHours\(\) >= 9 && env\.UPS_MFL_BACKUPS\)/);
  t.match(block, /if \(await env\.UPS_MFL_BACKUPS\.head\(metaKey\)\) return;\s+[\s\S]{0,200}await snapshotMflToR2\(env, nowUtc\);/);
  t.match(block, /ctx\.waitUntil\(snapshotRostersHourlyToR2\(env, nowUtc\)/);
});

await run("pre_drop_contract_hourly_snapshots");
