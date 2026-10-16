// The waiver-run announcement prices a claim's conditional drop with the drop LEDGER's own inputs, so the number Discord
// announces is the number the ledger books (Keith 2026-10-16).
//   node tests/waiver_run_drop_pricing_parity.test.mjs
//
// Devin Neal (17046, Gride) was cut inside a blind-bid claim on Thu 2026-09-17 at 9:00 AM ET, before Week 2's first game.
// The waiver post announced $2.3K; the ledger now books $2,382 = $4,500 GTD − $2,118 earned (1 completed week). The poster
// priced the drop with its own inputs: no taxi call-up status at all, and its own week count (resolveCompletedPayableWeeks:
// "now" on the drop's UTC day, a kickoff-to-kickoff walk on any later day — $2,500 for the same cut).
//
// The REAL routes against one D1 and a fake MFL / R2, Discord unreachable (a dry run never contacts it):
//   /admin/drops/scan-and-record (the ledger) and /admin/adds/post-discord dry_run (the waiver-run card, shape "report").
// Every drop is compared dollar for dollar: penalty, earned, guaranteed and basis.
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const RealDate = Date;
let NOW = RealDate.parse("2026-09-17T13:06:00Z");
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ET = (iso) => Math.floor(RealDate.parse(iso) / 1000);
const RUN = ET("2026-09-17T09:00:00-04:00");   // Thursday 9 AM ET blind-bid run; Week 2 opens Thu 8:15 PM ET

// ── the run: three claims, each dropping a 2025/2026 rookie on his entry contract ──
//   17046 "Neal"   — Gride (0005). 3 call-ups in 2025, active at the end of 2025 → permanently promoted → the normal formula.
//   17134 "Kyle"   — 0007. 1 call-up, active at the end of 2025 → permanently promoted (the Kyle Williams case) → normal formula.
//   17052 "Callup" — 0003. A 2026 rookie on a temporary call-up (2 of 3), never on an active roster at a season's end → $0 (§D2).
const TXS = [
  { type: "BBID_WAIVER", franchise: "0005", timestamp: String(RUN), transaction: "20001,|1000|17046," },
  { type: "BBID_WAIVER", franchise: "0007", timestamp: String(RUN), transaction: "20002,|1000|17134," },
  { type: "BBID_WAIVER", franchise: "0003", timestamp: String(RUN), transaction: "20003,|1000|17052," },
];
const rookie = (id, k, cy) => ({ id, salary: String(k * 1000), status: "ROSTER", contractStatus: "Rookie-Draft",
  contractInfo: `CL 3| TCV ${3 * k}K| AAV ${k}K`, contractYear: String(cy) });
// Section E's Sunday 9/20 run: four 2026 rookies, each on his 3rd confirmed call-up, on four teams.
const SUNDAY_ROOKIES = [["0005", "17075", "ROSTER"], ["0007", "17076", "ROSTER"], ["0003", "17077", "INJURED_RESERVE"], ["0010", "17078", "TAXI_SQUAD"]];
const snapshotFor = (day) => (day >= "2026-09-10" && day <= "2026-09-17"
  ? { rosters: { franchise: [{ id: "0005", player: [rookie("17046", 2, 2)] }, { id: "0007", player: [rookie("17134", 5, 2)] }, { id: "0003", player: [rookie("17052", 2, 3)] }] } }
  : (day >= "2026-09-18" && day <= "2026-09-20"
    ? { rosters: { franchise: SUNDAY_ROOKIES.map(([id, pid, status]) => ({ id, player: [{ ...rookie(pid, 2, 3), status }] })) } }
    : null));
// MFL's nflSchedule: Week 1 Wed Sep 9 8:20 PM ET, then Thursday 8:15 PM ET openers, Sunday 1 PM, Monday 8:15 PM ET closers
function nflSchedule(w) {
  const ko = (d, h, m) => String(Math.floor(RealDate.UTC(2026, 8, d, h, m) / 1000));
  const thu = w === 1 ? ko(10, 0, 20) : ko(18 + 7 * (w - 2), 0, 15), sun = ko(13 + 7 * (w - 1), 17, 0), mon = ko(15 + 7 * (w - 1), 0, 15);
  return { nflSchedule: { week: String(w), matchup: [{ kickoff: thu, team: [{ id: "KCC" }, { id: "BAL" }] }, { kickoff: sun, team: [{ id: "BUF" }, { id: "MIA" }] }, { kickoff: mon, team: [{ id: "NYG" }, { id: "DAL" }] }] } };
}
const liveWeek = () => { let w = 1; for (let k = 1; k <= 18; k++) if (Number(nflSchedule(k).nflSchedule.matchup[0].kickoff) * 1000 <= NOW) w = k; return w; };

const MFL = { liveScoringDown: false, priorSeasonsDown: false };
const DISCORD_CALLS = [];
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (/discord\.com$/.test(u.hostname)) { DISCORD_CALLS.push(u.pathname); return json({ message: "test: Discord is unreachable" }, 500); }
  if (/myfantasyleague\.com$/.test(u.hostname)) {
    if (/\/import$/.test(u.pathname)) throw new Error("test: no MFL write may happen here");
    const year = (u.pathname.match(/\/(\d{4})\//) || [])[1];
    const type = u.searchParams.get("TYPE");
    if (type === "nflSchedule") return json(nflSchedule(Number(u.searchParams.get("W"))));
    if (year !== "2026") return MFL.priorSeasonsDown ? json({ error: "MFL down" }, 500) : json({ error: "test: prior seasons come from the D1 cache" }, 500);
    if (type === "transactions") {
      const tt = u.searchParams.get("TRANS_TYPE");
      return json({ transactions: { transaction: TXS.filter((x) => Number(x.timestamp) <= NOW / 1000 && (!tt || x.type === tt)) } });
    }
    if (type === "liveScoring") return MFL.liveScoringDown ? json({ error: "MFL down" }, 500) : json({ liveScoring: { week: String(liveWeek()) } });
    if (type === "players") return json({ players: { player: [["17046", "Neal, Devin", "RB"], ["17134", "Williams, Kyle", "WR"], ["17052", "Callup, Taxi", "WR"],
      ["20001", "Add, One", "WR"], ["20002", "Add, Two", "RB"], ["20003", "Add, Three", "TE"],
      ["17075", "Sunday, Buffalo", "WR"], ["17076", "Thursday, Kansas", "WR"], ["17077", "Reserve, Injured", "WR"], ["17078", "Squad, Taxi", "WR"],
      ["20101", "Sun, One", "WR"], ["20102", "Sun, Two", "WR"], ["20103", "Sun, Three", "WR"], ["20104", "Sun, Four", "WR"]]
      .map(([id, name, position]) => ({ id, name, position, team: id === "17075" ? "BUF" : "KCC" })) } });
    if (type === "rosters") return json(snapshotFor(new RealDate(NOW).toISOString().slice(0, 10)) || { rosters: { franchise: [] } });
    if (type === "league") return json({ league: { franchises: { franchise: [["0003", "Team Three"], ["0005", "Gride"], ["0007", "Team Seven"]].map(([id, name]) => ({ id, name })) } } });
    if (type === "salaries") return json({ salaries: { leagueUnit: { player: ["20001", "20002", "20003"].map((id) => ({ id, salary: "1000", contractStatus: "Vet-WW", contractYear: "1", contractInfo: "CL 1| TCV 1K| AAV 1K" })) } } });
    if (type === "injuries") return json({ injuries: { injury: [] } });
    return json({ error: "test: no such export " + type }, 503);
  }
  return json({ error: "test: no such call " + u.hostname }, 503);
};

function makeDb({ priorActiveCached }) {
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
  db.raw.exec("CREATE TABLE ups_taxi_callups (player_id TEXT, pending INTEGER, became_permanent INTEGER DEFAULT 0, season TEXT, nfl_week INTEGER)");
  const callups = { "17046": 3, "17134": 1, "17052": 2 };
  for (const [pid, n] of Object.entries(callups)) for (let i = 0; i < n; i++) db.raw.prepare("INSERT INTO ups_taxi_callups (player_id, pending) VALUES (?, 0)").run(pid);
  // taxiPriorActivePids' own D1 cache: who ended 2025 on an active / IR roster. Absent → it reads MFL's 2025/2024 exports.
  db.raw.exec("CREATE TABLE ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  if (priorActiveCached) db.raw.prepare("INSERT INTO ups_settings (key, value) VALUES ('taxi_prior_active_2026', ?)").run(JSON.stringify(["17134", "17046"]));
  applyMigrations(db, ["0112_ups_add_events.sql"]);
  for (const [fid, pid] of [["0005", "20001"], ["0007", "20002"], ["0003", "20003"]]) {
    db.raw.prepare(`INSERT INTO ups_add_events (season, league_id, player_id, player_name, franchise_id, franchise_name, acquired_at_unix, acquired_at_iso,
      source, bid_dollars, acquisition_week, detected_at_utc) VALUES ('2026', '74598', ?, ?, ?, ?, ?, ?, 'bbid', 1000, 2, ?)`)
      .run(pid, "Add " + pid, fid, "Team " + fid, RUN, new RealDate(RUN * 1000).toISOString(), new RealDate(RUN * 1000 + 300000).toISOString());
  }
  return db;
}
const r2 = { async get(key) {
  const m = /^snapshots\/(\d{4}-\d{2}-\d{2})\/rosters\.json$/.exec(key);
  const snap = m && snapshotFor(m[1]);
  return snap ? { async text() { return JSON.stringify(snap); }, uploaded: new RealDate(`${m[1]}T09:05:00.000Z`) } : null;
} };
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
const scan = (env) => call(env, "/admin/drops/scan-and-record" + Q, { season: "2026", league_id: "74598", days: 7, include_waivers: true });
// The cron's own shape ("report": one league-wide post per run), as a dry run: the exact payload, no Discord contact.
const poster = (env) => call(env, "/admin/adds/post-discord" + Q, { season: "2026", league_id: "74598", target: "test", shape: "report", limit: 50, dry_run: true });

const ledger = (db, pid) => ({ ...db.raw.prepare("SELECT * FROM ups_drop_events WHERE player_id = ?").get(pid) });
const announced = (res, pid) => {
  const d = (res.json.drop_pricing || []).find((x) => x.player_id === pid);
  if (!d) throw new Error(`no drop_pricing for ${pid}: ${res.text.slice(0, 400)}`);
  return d;
};
// The card itself: the move message whose drop is this player.
const card = (res, name) => {
  const msgs = res.json.runs.flatMap((r) => r.plan.move_messages || []);
  const m = msgs.find((x) => JSON.stringify(x.body).includes(name));
  if (!m) throw new Error("no card for " + name);
  return JSON.stringify(m.body);
};
// Discord equals the ledger: the same penalty, earned, guaranteed and basis, to the dollar.
const sameAsLedger = (a, row, label) => {
  t.equal(a.known, true, `${label}: priced`);
  t.deepEqual([a.penalty, a.earned, a.guaranteed, a.basis], [row.penalty_amount, row.earned_to_date, row.guaranteed_amount, row.penalty_basis], `${label}: announced = booked`);
};

// ═════════ A. the Thursday 9 AM run, posted on time, before AND after the ledger row exists, and again days later ═════════
const dbA = makeDb({ priorActiveCached: true }), envA = makeEnv(dbA);
const runs = {};
test("A1. 9:06 AM, the waiver card is built BEFORE the drop scan has written its rows (pre-drop contract from the R2 snapshot)", async () => {
  NOW = RealDate.parse("2026-09-17T13:06:00Z");
  runs.early = await poster(envA);
  t.equal(runs.early.status, 200, runs.early.text.slice(0, 400));
  t.equal(announced(runs.early, "17046").contract_source, "r2_snapshot:2026-09-17");
});
test("A2. 9:06 AM, the drop scan books the same three cuts", async () => {
  const s = await scan(envA);
  t.equal(s.status, 200, s.text.slice(0, 400));
  t.equal(s.json.written_count, 3, s.text.slice(0, 400));
  // Neal: $4,500 GTD (75% of $6K) − ($2,000 for 2025 + 1 of 17 weeks of $2,000) = $4,500 − $2,118
  t.deepEqual([ledger(dbA, "17046").penalty_amount, ledger(dbA, "17046").earned_to_date, ledger(dbA, "17046").guaranteed_amount], [2382, 2118, 4500]);
  // Kyle-like: $11,250 GTD (75% of $15K) − ($5,000 + 1 of 17 weeks of $5,000 = $5,294)
  t.deepEqual([ledger(dbA, "17134").penalty_amount, ledger(dbA, "17134").penalty_basis], [5956, "guarantee_minus_earned"]);
  // the call-up rookie keeps his cap-free cut
  t.deepEqual([ledger(dbA, "17052").penalty_amount, ledger(dbA, "17052").penalty_basis], [0, "taxi_callup_exempt"]);
});
test("A3. 9:10 AM, the card built AFTER the ledger row exists (pre-drop contract from ups_drop_events)", async () => {
  NOW = RealDate.parse("2026-09-17T13:10:00Z");
  runs.onTime = await poster(envA);
  t.equal(runs.onTime.status, 200, runs.onTime.text.slice(0, 400));
  t.equal(announced(runs.onTime, "17046").contract_source, "ups_drop_events");
});
test("A4. Tue 9/22, the same unposted run is built again (a retry or a late post, a different UTC day, Week 2 now complete)", async () => {
  NOW = RealDate.parse("2026-09-22T16:00:00Z");
  runs.late = await poster(envA);
  t.equal(runs.late.status, 200, runs.late.text.slice(0, 400));
});
for (const [pid, who] of [["17046", "Thursday-morning cut (Devin Neal)"], ["17134", "permanently promoted rookie (Kyle Williams-like)"], ["17052", "taxi call-up rookie"]]) {
  test(`A5. ${who}: every card announces exactly what the ledger booked`, () => {
    const row = ledger(dbA, pid);
    for (const k of ["early", "onTime", "late"]) {
      const a = announced(runs[k], pid);
      sameAsLedger(a, row, `${pid} ${k}`);
      t.equal(a.pricing_inputs.completed_payable_weeks, 1, `${pid} ${k}: 1 completed week as of the drop, whenever the card is built`);
      t.equal(a.pricing_inputs.weeks_source, "live_rule_at_instant");
    }
  });
}
test("A6. the cards read the ledger's numbers: Neal $2.4K ($4.5K − $2.1K), Kyle-like $6K, the call-up rookie 'No Cap Penalty'", () => {
  for (const k of ["early", "onTime", "late"]) {
    t.match(card(runs[k], "Devin Neal"), /Cap Penalty: \$2\.4K[\s\S]*\$4\.5K GTD − \$2\.1K Earned = \$2\.4K/, k);
    t.match(card(runs[k], "Kyle Williams"), /Cap Penalty: \$6K/, k);
    t.match(card(runs[k], "Taxi Callup"), /No Cap Penalty/, k);
  }
  t.equal(announced(runs.onTime, "17052").pricing_inputs.taxi_never_promoted, true, "the call-up status came from the shared resolver");
  t.equal(announced(runs.onTime, "17134").pricing_inputs.taxi_never_promoted, null, "permanently promoted → no exemption");
  t.deepEqual(DISCORD_CALLS, [], "a dry run never contacts Discord");
});

// ═════════ B. the ledger records the run LATE ═════════
test("B. the drop scan is down until Tue 9/22 (Week 2 complete by then): it books what Thursday's card announced, priced as of the 9 AM cut", async () => {
  const dbB = makeDb({ priorActiveCached: true }), envB = makeEnv(dbB);
  NOW = RealDate.parse("2026-09-17T13:06:00Z");
  const p = await poster(envB);
  NOW = RealDate.parse("2026-09-22T16:00:00Z");
  const s = await scan(envB);
  t.equal(s.status, 200, s.text.slice(0, 400));
  for (const pid of ["17046", "17134", "17052"]) sameAsLedger(announced(p, pid), ledger(dbB, pid), pid);
  t.equal(ledger(dbB, "17046").penalty_amount, 2382, "not $2,265: the tick's live count (2 weeks) is no longer what prices a late-recorded cut");
});

// ═════════ C. the taxi call-up history cannot be read ═════════
test("C. call-up history unreadable (no cached 2025 rosters, MFL's prior seasons down): the ledger HOLDS all three; every card says 'unknown — needs review', never $0", async () => {
  const dbC = makeDb({ priorActiveCached: false }), envC = makeEnv(dbC);
  NOW = RealDate.parse("2026-09-17T13:06:00Z"); MFL.priorSeasonsDown = true;
  const p = await poster(envC);
  const s = await scan(envC);
  MFL.priorSeasonsDown = false;
  t.equal(p.status, 200, p.text.slice(0, 400)); t.equal(s.status, 200, s.text.slice(0, 400));
  for (const [pid, name] of [["17046", "Devin Neal"], ["17134", "Kyle Williams"], ["17052", "Taxi Callup"]]) {
    const row = ledger(dbC, pid);
    t.deepEqual([row.penalty_basis, row.penalty_amount], ["week_authority_unresolved", null], `${pid}: held by the ledger`);
    const a = announced(p, pid);
    t.equal(a.known, false, `${pid}: not priced on the card either`);
    t.equal(a.pricing_inputs.taxi_never_promoted, "unresolved");
    t.match(a.unknown_reason, /permanently promoted could not be read[\s\S]*NOT a \$0/);
    const c = card(p, name);
    t.match(c, /Cap penalty: unknown — needs review/, name);
    t.doesNotMatch(c, /No Cap Penalty|Cap Penalty: \$/, name);
  }
  t.deepEqual(DISCORD_CALLS, []);
});

// ═════════ D. one rule, by construction ═════════
test("D. the poster calls the ledger's helpers, not its own week count, acquisition map or a missing taxi input", async () => {
  const fs = await import("node:fs");
  const SRC = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const i = SRC.indexOf('if (path === "/admin/adds/post-discord" && request.method === "POST")');
  const POSTER = SRC.slice(i, SRC.indexOf("const apResults = [];", i));
  t.match(POSTER, /_taxiNeverPromotedMap\(env, \[\.\.\.apDropPids\], \{ season: apSeason, leagueId: apLeagueId, atUnix: ts \}\)/, "as of each claim's drop");
  t.match(POSTER, /taxiNeverPromoted,\n/, "passed to the calculator as is (true | 'unresolved')");
  t.match(POSTER, /await _completedWeeksForDrop\(apSeason, apLeagueId, ts\)/);
  t.match(POSTER, /_acquisitionWeekAsOf\(apTxs, apSeason, dpid, ts\)/);
  t.doesNotMatch(POSTER, /resolveCompletedPayableWeeks\(|_acquisitionWeekMapFromTxs\(/, "no second week rule, no latest-add acquisition map");
  // and the ledger's held re-pricing counts weeks with the same helper
  t.match(SRC, /const hWeeks = await _completedWeeksForDrop\(hSeason, leagueId, dropUnix\);/);
});

// ═════════ E. a call-up week counts from HIS game's kickoff — the preview, the ledger and the card agree ═════════
// Keith 2026-10-16 ("a call-up week counts from lineup lock"). Sunday 9/20, 9 AM ET blind-bid run, Week 2 under way:
// KCC played Thursday night, BUF plays at 1 PM. Each dropped rookie has 3 confirmed call-ups and no prior-season roster.
//   17075 BUF, active         → Week 2 not yet his → 3 used: cap-free ($0 taxi_callup_exempt)
//   17076 KCC, active         → Week 2 is his 4th activation: permanent → $4,500 − $118 = $4,382
//   17077 KCC, on IR          → IR still burns the week (canon §B2): permanent → $4,382
//   17078 KCC, on taxi        → on taxi at the cut: $0 (taxi_exempt)
test("E. 3rd call-up, cut Sunday 9 AM: preview, drop ledger and waiver card give the same price for each — the 4th week counts from his own kickoff", async () => {
  const SUN = ET("2026-09-20T09:00:00-04:00");
  const added = [["0005", "20101", "17075"], ["0007", "20102", "17076"], ["0003", "20103", "17077"], ["0010", "20104", "17078"]];
  for (const [fid, add, drop] of added) TXS.push({ type: "BBID_WAIVER", franchise: fid, timestamp: String(SUN), transaction: `${add},|1000|${drop},` });
  const db = makeDb({ priorActiveCached: true }), env = makeEnv(db);
  for (const [, , pid] of added) for (let i = 0; i < 3; i += 1) db.raw.prepare("INSERT INTO ups_taxi_callups (player_id, pending) VALUES (?, 0)").run(pid);
  for (const [fid, add] of added) {
    db.raw.prepare(`INSERT INTO ups_add_events (season, league_id, player_id, player_name, franchise_id, franchise_name, acquired_at_unix, acquired_at_iso,
      source, bid_dollars, acquisition_week, detected_at_utc) VALUES ('2026', '74598', ?, ?, ?, ?, ?, ?, 'bbid', 1000, 2, ?)`)
      .run(add, "Add " + add, fid, "Team " + fid, SUN, new RealDate(SUN * 1000).toISOString(), new RealDate(SUN * 1000 + 60000).toISOString());
  }
  NOW = RealDate.parse("2026-09-20T13:06:00Z");
  const preview = {};
  for (const [, , pid] of added) {
    const r = await worker.fetch(new Request(`https://w.test/api/cap-penalty/preview?L=74598&YEAR=2026&player_id=${pid}&drop_date=${new RealDate(SUN * 1000).toISOString()}`),
      env, { waitUntil() {}, passThroughOnException() {} });
    preview[pid] = await r.json();
    t.equal(r.status, 200, JSON.stringify(preview[pid]).slice(0, 200));
  }
  const card = await poster(env);
  const s = await scan(env);
  TXS.length = 3;
  t.equal(s.status, 200, s.text.slice(0, 300));
  const want = { "17075": [0, "taxi_callup_exempt"], "17076": [4382, "guarantee_minus_earned"], "17077": [4382, "guarantee_minus_earned"], "17078": [0, "taxi_exempt"] };
  for (const [pid, [penalty, basis]] of Object.entries(want)) {
    t.deepEqual([preview[pid].penalty, preview[pid].basis], [penalty, basis], `${pid} preview`);
    t.deepEqual([ledger(db, pid).penalty_amount, ledger(db, pid).penalty_basis], [penalty, basis], `${pid} drop ledger`);
    const a = announced(card, pid);
    t.deepEqual([a.penalty, a.basis], [penalty, basis], `${pid} waiver card`);
  }
  t.deepEqual(DISCORD_CALLS, []);
});

await run("waiver_run_drop_pricing_parity");
