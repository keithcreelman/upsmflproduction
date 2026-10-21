// The waiver-run card reads a cut's contract through the drop ledger's own lookup (_preDropContractReader), so it prices
// the contract the ledger books — never an older one (Keith 2026-10-16).
//   node tests/waiver_card_contract_parity.test.mjs
//
// When the card is built before the drop scan has written its row (both run in the same */5 tick), it used its own R2
// walk, which differed from the ledger's in two ways:
//   - it never checked for a contract submitted after the snapshot (a MYAC / extension / MYM / restructure — the Colbie
//     Young case), so it priced the OLD deal while the ledger booked the new one;
//   - it skipped a BLANK roster entry and walked back to an older contract — a guessed price where the ledger books the cut
//     unpriced (contract_unstamped_needs_review).
// The REAL /admin/drops/scan-and-record and /admin/adds/post-discord (dry run) routes, one D1, a fake MFL / R2.
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
const FRI = ET("2026-10-16T09:00:00-04:00");   // Friday's 9 AM ET blind-bid run (Week 6 under way: 5 weeks complete)
const TXS = [
  { type: "BBID_WAIVER", franchise: "0010", timestamp: String(FRI), transaction: "20010,|1000|15500," },   // cuts "Extended" (MYAC'd at 7 AM)
  { type: "BBID_WAIVER", franchise: "0003", timestamp: String(FRI), transaction: "20003,|1000|15600," },   // cuts "Blank" (unstamped in MFL)
];
const vet = (id, info, cy, sal) => ({ id, salary: String(sal), status: "ROSTER", contractStatus: "Veteran", contractInfo: info, contractYear: String(cy) });
// Friday's daily snapshot (5:05 AM ET): 15500 on a 1-year $6K deal; 15600 BLANK. Thursday's had 15600 on a $2K deal.
const R2 = {
  "snapshots/2026-10-16/rosters.json": { json: { rosters: { franchise: [{ id: "0010", player: [vet("15500", "CL 1| TCV 6K| AAV 6K", 1, 6000)] },
    { id: "0003", player: [{ id: "15600", salary: "", status: "ROSTER", contractStatus: "", contractInfo: "", contractYear: "" }] }] } }, uploaded: "2026-10-16T09:05:00Z" },
  "snapshots/2026-10-15/rosters.json": { json: { rosters: { franchise: [{ id: "0010", player: [vet("15500", "CL 1| TCV 6K| AAV 6K", 1, 6000)] },
    { id: "0003", player: [{ id: "15600", salary: "2000", status: "ROSTER", contractStatus: "Vet-WW", contractInfo: "CL 1| TCV 2K| AAV 2K", contractYear: "1" }] }] } }, uploaded: "2026-10-15T09:05:00Z" },
};
const r2 = { async get(key) { const o = R2[key]; return o ? { async text() { return JSON.stringify(o.json); }, uploaded: new RealDate(o.uploaded) } : null; } };

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
    if (type === "players") return json({ players: { player: [["15500", "Extended, Player"], ["15600", "Blank, Player"], ["20010", "Add, Ten"], ["20003", "Add, Three"]].map(([id, name]) => ({ id, name, position: "WR", team: "KCC" })) } });
    if (type === "league") return json({ league: { franchises: { franchise: [{ id: "0010", name: "Blake Bombers" }, { id: "0003", name: "Team Three" }] } } });
    if (type === "salaries") return json({ salaries: { leagueUnit: { player: ["20010", "20003"].map((id) => ({ id, salary: "1000", contractStatus: "Vet-WW", contractYear: "1", contractInfo: "CL 1| TCV 1K| AAV 1K" })) } } });
    if (type === "injuries") return json({ injuries: { injury: [] } });
    return json({ error: "test: no such export " + type }, 503);
  }
  return json({ error: "test: no such call " + u.hostname }, 503);
};

function makeDb({ submissionsReadable }) {
  const db = makeD1({});
  db.raw.exec(`CREATE TABLE ups_drop_events (id INTEGER PRIMARY KEY AUTOINCREMENT, season TEXT, league_id TEXT, player_id TEXT, player_name TEXT, position TEXT, nfl_team TEXT,
    franchise_id TEXT, franchise_name TEXT, dropped_at_unix INTEGER, dropped_at_iso TEXT, pre_drop_contract_status TEXT, pre_drop_salary INTEGER, pre_drop_contract_year INTEGER,
    pre_drop_contract_length INTEGER, pre_drop_contract_info TEXT, pre_drop_tcv INTEGER, pre_drop_aav INTEGER, pre_drop_years_remaining INTEGER, pre_drop_taxi INTEGER,
    earned_to_date INTEGER, guaranteed_amount INTEGER, penalty_amount INTEGER, penalty_basis TEXT, penalty_exempt INTEGER, penalty_exempt_reason TEXT, ledger_key TEXT UNIQUE,
    posted_to_mfl INTEGER DEFAULT 0, posted_at_utc TEXT, posted_amount INTEGER, posted_explanation TEXT, source TEXT, detected_at_utc TEXT, raw_transaction_json TEXT,
    snapshot_source TEXT, discord_posted INTEGER DEFAULT 0, discord_channel_id TEXT, discord_message_id TEXT, notes TEXT,
    applies_to_season INTEGER, cap_season_source TEXT, cap_season_resolved_at_utc TEXT, cap_season_needs_review INTEGER, cap_season_review_reason TEXT,
    UNIQUE (season, league_id, player_id, dropped_at_unix))`);
  if (submissionsReadable) {
    const subCols = "id INTEGER, league_id TEXT, season TEXT, franchise_id TEXT, player_id TEXT, new_contract_status TEXT, new_salary INTEGER, new_contract_year INTEGER, new_contract_info TEXT, submitted_at_utc TEXT, dry_run INTEGER";
    db.raw.exec(`CREATE TABLE ups_extension_submissions (${subCols}); CREATE TABLE ups_mym_submissions (${subCols}); CREATE TABLE ups_restructure_submissions (${subCols}, voided_at_utc TEXT);`);
    // Blake Bombers MYAC'd 15500 to 3 years at 7 AM ET Friday — after the 5:05 AM snapshot, before the 9 AM cut
    db.raw.exec(`INSERT INTO ups_extension_submissions VALUES (727, '74598', '2026', '0010', '15500', 'Veteran', 6000, 3, 'CL 3| TCV 18K| AAV 6K', '2026-10-16T11:00:00Z', 0)`);
  }
  db.raw.exec("CREATE TABLE ups_taxi_callups (player_id TEXT, pending INTEGER, became_permanent INTEGER DEFAULT 0, season TEXT, nfl_week INTEGER)");
  applyMigrations(db, ["0112_ups_add_events.sql"]);
  for (const [fid, pid, name] of [["0010", "20010", "Ten Add"], ["0003", "20003", "Three Add"]]) {
    db.raw.prepare(`INSERT INTO ups_add_events (season, league_id, player_id, player_name, franchise_id, franchise_name, acquired_at_unix, acquired_at_iso,
      source, bid_dollars, acquisition_week, detected_at_utc) VALUES ('2026', '74598', ?, ?, ?, ?, ?, ?, 'bbid', 1000, 7, ?)`)
      .run(pid, name, fid, "Team " + fid, FRI, new RealDate(FRI * 1000).toISOString(), new RealDate(FRI * 1000 + 60000).toISOString());
  }
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
const row = (db, pid) => db.raw.prepare("SELECT * FROM ups_drop_events WHERE player_id = ?").get(pid);
// A claim's card: its heading and its penalty line.
const card = (res, addName) => {
  const m = res.json.runs.flatMap((r) => r.plan.move_messages || []).find((x) => JSON.stringify(x.body).includes("Waiver Claim — " + addName));
  if (!m) throw new Error("no card for " + addName + ": " + res.text.slice(0, 300));
  const e = m.body.embeds[0];
  const calc = (e.fields || []).find((f) => f.name === "Penalty calculation");
  return { heading: e.description.split("\n")[0], calc: calc ? calc.value.split("\n")[0] : "" };   // (line 2 is the cap-year note)
};

const dbA = makeDb({ submissionsReadable: true }), envA = makeEnv(dbA);
let early;
test("A. the card built BEFORE the scan and the ledger row agree", async () => {
  NOW = RealDate.parse("2026-10-16T13:06:00Z");
  early = await poster(envA);
  t.equal(early.status, 200, early.text.slice(0, 300));
  const s = await scan(envA);
  t.equal(s.status, 200, s.text.slice(0, 300));
  t.deepEqual(DISCORD_CALLS, []);
});
test("A1. a contract MYAC'd after the morning snapshot: both price the 3-year deal — $13,500 GTD − $1,765 (5 of 17 weeks of $6K) = $11,735, not the old 1-year deal's $2.7K", () => {
  const r = row(dbA, "15500");
  t.deepEqual([r.pre_drop_contract_info, r.penalty_amount, r.snapshot_source], ["CL 3| TCV 18K| AAV 6K", 11735, "ups_extension_submissions:727"]);
  t.deepEqual(card(early, "Ten Add"), { heading: "# 💰 Cap Penalty: $11.7K", calc: "$13.5K GTD − $1.8K Earned = $11.7K" });
});
test("A2. a BLANK roster entry (MFL has no contract stamped): the ledger books it unpriced, and the card says unknown — never the older $2K deal's 'No Cap Penalty'", () => {
  const r = row(dbA, "15600");
  t.deepEqual([r.penalty_basis, r.pre_drop_contract_info], ["contract_unstamped_needs_review", null]);
  const c = card(early, "Three Add");
  t.equal(c.heading, "# ⚠️ Cap penalty: unknown — needs review");
  t.match(c.calc, /MFL has no contract stamped for this player/);
});
test("B. the submission tables can't be read: the ledger does not record the cut (it retries next tick), and the card says unknown — not the snapshot's price", async () => {
  const db = makeDb({ submissionsReadable: false }), env = makeEnv(db);
  const p = await poster(env);
  const s = await scan(env);
  t.ok(!row(db, "15500"), "not recorded");
  t.ok(s.json.skipped.some((x) => x.pid === "15500" && x.reason === "contract_submission_check_failed"), s.text.slice(0, 300));
  const c = card(p, "Ten Add");
  t.equal(c.heading, "# ⚠️ Cap penalty: unknown — needs review");
  t.match(c.calc, /could not be checked — this drop has NOT been priced/);
});
test("C. one lookup: both routes read through _preDropContractReader, and nothing else walks the R2 roster snapshots", () => {
  const SRC = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  t.match(SRC, /const readPreDropContract = _preDropContractReader\(env\);/);
  t.match(SRC, /const apReadPreDrop = _preDropContractReader\(env\);/);
  t.equal((SRC.match(/snapshots\/\$\{dateStr\}\/rosters\.json/g) || []).length, 1, "the daily snapshot is read in ONE place");
});

await run("waiver_card_contract_parity");
