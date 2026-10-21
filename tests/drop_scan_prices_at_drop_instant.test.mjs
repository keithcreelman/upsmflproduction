// The drop ledger prices every drop with the completed weeks AS OF THAT DROP — the count held re-pricing, the post-discord
// recompute and the waiver-run card already use — never the live count at the tick that happens to record it (Keith 2026-10-16).
//   node tests/drop_scan_prices_at_drop_instant.test.mjs
//
// The REAL /admin/drops/scan-and-record and /admin/drops/post-discord routes against one D1 and a fake MFL / R2 / Discord.
// 2026 calendar (as MFL's schedule has it): Week 2's last game is Mon 9/21 8:15 PM ET, so Week 2 is complete from Tue 9/22
// 3:15 AM ET (last kickoff + 7h grace); Week 3 opens Thu 9/24 8:15 PM ET.
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const RealDate = Date;
let NOW = RealDate.parse("2026-09-22T02:05:00Z");
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ET = (iso) => Math.floor(RealDate.parse(iso) / 1000);

// ── the cuts ──
const MON_NIGHT = ET("2026-09-21T22:00:00-04:00");   // Week 2's last game kicked off 8:15 PM — Week 2 NOT complete yet
const TUE_MORNING = ET("2026-09-22T10:00:00-04:00"); // Week 2 complete since 3:15 AM
const MARCH_2027 = ET("2027-03-15T12:00:00-04:00");  // after the March rollover; the NFL has not published 2027's schedule
const TXS = {
  "2026": [
    { type: "FREE_AGENT", franchise: "0001", timestamp: String(MON_NIGHT), transaction: "|15000," },
    { type: "FREE_AGENT", franchise: "0001", timestamp: String(TUE_MORNING), transaction: "|15001," },
    { type: "FREE_AGENT", franchise: "0002", timestamp: String(TUE_MORNING), transaction: "|17052," },
  ],
  "2027": [{ type: "FREE_AGENT", franchise: "0001", timestamp: String(MARCH_2027), transaction: "|15100," }],
};
let ONLY = null;   // the pids this scenario's MFL log carries
// $17K × 2 veteran in his first year: $25,500 GTD (75% of $34K); each completed week earns $1,000 (17,000 / 17)
const vet = (id, cy) => ({ id, salary: "17000", status: "ROSTER", contractStatus: "Veteran", contractInfo: "CL 2| TCV 34K| AAV 17K", contractYear: String(cy) });
function snapshotFor(day) {
  if (day >= "2026-09-15" && day <= "2026-09-22") {
    return { rosters: { franchise: [{ id: "0001", player: [vet("15000", 2), vet("15001", 2)] },
      { id: "0002", player: [{ id: "17052", salary: "2000", status: "ROSTER", contractStatus: "Rookie-Draft", contractInfo: "CL 3| TCV 6K| AAV 2K", contractYear: "3" }] }] } };
  }
  if (day >= "2027-03-10" && day <= "2027-03-15") return { rosters: { franchise: [{ id: "0001", player: [vet("15100", 1)] }] } };
  return null;
}
function nflSchedule(w) {
  const ko = (d, h, m) => String(Math.floor(RealDate.UTC(2026, 8, d, h, m) / 1000));
  const thu = w === 1 ? ko(10, 0, 20) : ko(18 + 7 * (w - 2), 0, 15), sun = ko(13 + 7 * (w - 1), 17, 0), mon = ko(15 + 7 * (w - 1), 0, 15);
  return { nflSchedule: { week: String(w), matchup: [{ kickoff: thu, team: [{ id: "KCC" }, { id: "BAL" }] }, { kickoff: sun, team: [{ id: "BUF" }, { id: "MIA" }] }, { kickoff: mon, team: [{ id: "NYG" }, { id: "DAL" }] }] } };
}
const liveWeek = () => { let w = 1; for (let k = 1; k <= 18; k++) if (Number(nflSchedule(k).nflSchedule.matchup[0].kickoff) * 1000 <= NOW) w = k; return w; };

const MFL = { scheduleDown: false, liveDown: false };
const DISCORD = { posts: [] };
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "discord.com") {   // the fake Discord: records, never leaves the process
    if ((init?.method || "GET") === "POST" && /\/messages$/.test(u.pathname)) { DISCORD.posts.push(JSON.parse(init.body || "{}")); return json({ id: "msg" + DISCORD.posts.length }); }
    return json({ id: "thr1" });
  }
  if (/myfantasyleague\.com$/.test(u.hostname)) {
    if (/\/import$/.test(u.pathname)) throw new Error("test: no MFL write may happen here");
    const year = (u.pathname.match(/\/(\d{4})\//) || [])[1];
    const type = u.searchParams.get("TYPE");
    if (type === "nflSchedule") {
      if (year === "2027") return new Response("<H1>Not Found</H1>", { status: 404 });   // what MFL serves for an unpublished season
      return MFL.scheduleDown ? json({ error: "MFL down" }, 503) : json(nflSchedule(Number(u.searchParams.get("W"))));
    }
    // UPS Rookie Draft results (the taxi rule's window): 17052 is a 2026 Round 2 pick.
    if (type === "draftResults") return json({ draftResults: { draftUnit: { draftPick: year === "2026" ? [{ player: "17052", round: "2" }] : [] } } });
    if (!TXS[year]) return json({ error: "No league " + year }, 500);
    if (type === "liveScoring") return MFL.liveDown ? json({ error: "MFL down" }, 503) : json({ liveScoring: { week: year === "2027" ? "1" : String(liveWeek()) } });
    if (type === "transactions") {
      const tt = u.searchParams.get("TRANS_TYPE");
      return json({ transactions: { transaction: TXS[year].filter((x) => Number(x.timestamp) <= NOW / 1000 && (!tt || x.type === tt)
        && (!ONLY || ONLY.some((p) => x.transaction.includes(p + ",")))) } });
    }
    if (type === "players") return json({ players: { player: [["15000", "Night, Monday"], ["15001", "Morning, Tuesday"], ["17052", "Callup, Taxi"], ["15100", "March, Cut"]].map(([id, name]) => ({ id, name, position: "WR", team: "KCC" })) } });
    if (type === "league") return json({ league: { franchises: { franchise: [["0001", "Team One"], ["0002", "Team Two"]].map(([id, name]) => ({ id, name, email: id + "@ups.test" })) } } });
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
  // 17052: a 2026 rookie on his 2nd of 3 call-ups, never on an active roster at a season's end → his cut stays cap-free (§D2)
  db.raw.exec("CREATE TABLE ups_taxi_callups (player_id TEXT, pending INTEGER, became_permanent INTEGER DEFAULT 0, season TEXT, nfl_week INTEGER)");
  db.raw.exec("INSERT INTO ups_taxi_callups (player_id, pending, season) VALUES ('17052', 0, '2026'), ('17052', 0, '2026')");
  db.raw.exec("CREATE TABLE ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  db.raw.exec(`INSERT INTO ups_settings (key, value) VALUES ('taxi_legacy_active_2025_v1', '["16000"]')`);
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
const scan = (env, y) => call(env, `/admin/drops/scan-and-record?L=74598&YEAR=${y}&APIKEY=admin`, { season: y, league_id: "74598", days: 2 });
const row = (db, pid) => ({ ...db.raw.prepare("SELECT * FROM ups_drop_events WHERE player_id = ?").get(pid) });
const money = (r) => [r.penalty_amount, r.earned_to_date, r.guaranteed_amount, r.penalty_basis];

// ═════════ 1. recorded on time vs recorded late ═════════
test("1. a Monday-night cut books $24,500 (1 week earned) whether the scan records it at 10:05 PM or, after an outage, on Tuesday morning", async () => {
  ONLY = ["15000"];
  const onTime = makeDb(), late = makeDb();
  NOW = RealDate.parse("2026-09-22T02:05:00Z");                     // Mon 10:05 PM ET
  t.equal((await scan(makeEnv(onTime), "2026")).status, 200);
  NOW = RealDate.parse("2026-09-22T14:00:00Z");                     // Tue 10:00 AM ET — Week 2 complete since 3:15 AM
  const s = await scan(makeEnv(late), "2026");
  t.equal(s.status, 200, s.text.slice(0, 300));
  t.deepEqual(money(row(onTime, "15000")), [24500, 1000, 25500, "guarantee_minus_earned"], "on time");
  t.deepEqual(money(row(late, "15000")), money(row(onTime, "15000")), "late = on time (the tick's live count said 2 weeks: $23,500)");
});

// ═════════ 2. the schedule is unreadable mid-season ═════════
const db2 = makeDb(), env2 = makeEnv(db2);
test("2a. Tue 11:30 AM, MFL's NFL schedule unreadable: the veteran's cut is HELD — never the un-rolled live count (1 week: $24,500)", async () => {
  ONLY = ["15001", "17052"];
  // 11:30 AM: past the worker's 1-hour kickoff memo from test 1, so the schedule really is read (and fails)
  NOW = RealDate.parse("2026-09-22T15:30:00Z"); MFL.scheduleDown = true;
  const s = await scan(env2, "2026");
  MFL.scheduleDown = false;
  t.equal(s.status, 200, s.text.slice(0, 300));
  t.deepEqual([row(db2, "15001").penalty_basis, row(db2, "15001").penalty_amount], ["week_authority_unresolved", null]);
  t.ok(s.json.held_unpriced.some((h) => h.pid === "15001"), "listed as held");
});
test("2b. …the taxi call-up rookie's cut is $0 either way, but this year's earned is UNKNOWN (null), not the prior years alone", () => {
  const r = row(db2, "17052");
  t.deepEqual([r.penalty_amount, r.penalty_basis, r.earned_to_date], [0, "taxi_callup_exempt", null]);
});
test("2c. the schedule readable again: the next tick prices the held cut as of its drop — 2 weeks complete at 10 AM Tuesday: $23,500", async () => {
  NOW = RealDate.parse("2026-09-22T15:35:00Z");
  const s = await scan(env2, "2026");
  t.equal(s.json.repriced_count, 1, s.text.slice(0, 300));
  t.deepEqual(money(row(db2, "15001")), [23500, 2000, 25500, "guarantee_minus_earned"]);
});

// ═════════ 3. the offseason, before the NFL publishes the schedule ═════════
test("3a. Mar 15 2027 (MFL rolled to 2027, its NFL schedule 404s): a cut is still priced — live scoring says no week is complete now, so none was at the cut", async () => {
  ONLY = null;
  const db = makeDb();
  NOW = RealDate.parse("2027-03-15T16:05:00Z");
  const s = await scan(makeEnv(db), "2027");
  t.equal(s.status, 200, s.text.slice(0, 300));
  // 2nd year of $17K × 2: $25,500 GTD − $17,000 (2026, fully earned) − $0 (no 2027 week played) = $8,500
  t.deepEqual(money(row(db, "15100")), [8500, 17000, 25500, "guarantee_minus_earned"]);
  t.equal(s.json.held_unpriced_count, 0);
});
test("3b. …and with live scoring unreadable too, it is HELD, never guessed", async () => {
  const db = makeDb();
  NOW = RealDate.parse("2027-03-15T16:05:00Z"); MFL.liveDown = true;
  const s = await scan(makeEnv(db), "2027");
  MFL.liveDown = false;
  t.deepEqual([row(db, "15100").penalty_basis, row(db, "15100").penalty_amount], ["week_authority_unresolved", null], s.text.slice(0, 300));
});

// ═════════ 4. the post-discord recompute prices with the recorder's taxi input ═════════
test("4. post-discord with recompute: the call-up rookie's $0 cut stays $0 — the recompute used to re-price it by the normal formula and write the charge", async () => {
  ONLY = ["17052"];
  const db = makeDb(), env = makeEnv(db);
  NOW = RealDate.parse("2026-09-22T14:05:00Z");
  await scan(env, "2026");
  t.deepEqual([row(db, "17052").penalty_amount, row(db, "17052").penalty_basis], [0, "taxi_callup_exempt"]);
  const d = await call(env, "/admin/drops/post-discord?L=74598&YEAR=2026&APIKEY=admin", { season: "2026", league_id: "74598", target: "test", limit: 20, recompute: true });
  t.equal(d.json.posted_count, 1, d.text.slice(0, 300));
  t.deepEqual([row(db, "17052").penalty_amount, row(db, "17052").penalty_basis], [0, "taxi_callup_exempt"], "the stored $0 is not rewritten");
  t.match(JSON.stringify(DISCORD.posts.at(-1)), /Drop: Taxi Callup[\s\S]*No Cap Penalty/);
});

// ═════════ 5. one count, by construction ═════════
test("5. every drop path counts weeks with _completedWeeksForDrop — the new-drop scan, held re-pricing, the recompute and the waiver card", async () => {
  const fs = await import("node:fs");
  const SRC = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  t.match(SRC, /const dropWeeks = await _completedWeeksForDrop\(targetSeason, leagueId, drop\.ts\);/);
  t.match(SRC, /const hWeeks = await _completedWeeksForDrop\(hSeason, leagueId, dropUnix\);/);
  t.match(SRC, /const rcWeekAuthority = await _completedWeeksForDrop\(rs, leagueId, Number\(r\.dropped_at_unix\) \|\| 0\);/);
  t.match(SRC, /const weekAuthority = await _completedWeeksForDrop\(apSeason, apLeagueId, ts\);/);
  t.equal((SRC.match(/_completedWeeksAtLiveRule\(/g) || []).length, 2, "the definition and its one caller, _completedWeeksForDrop");
  t.match(SRC, /taxiCut: \(await _taxiCutContextMap\(env, \[safeStr\(r\.player_id\)\], \{ season: rs, leagueId, atUnix: Number\(r\.dropped_at_unix\) \|\| 0 \}\)\)/, "the recompute passes the taxi verdict's inputs, as of the drop");
});

await run("drop_scan_prices_at_drop_instant");
