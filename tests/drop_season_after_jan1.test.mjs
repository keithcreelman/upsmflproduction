// The */5 drop pipeline after Jan 1. NFL Week 17 runs into January (2026: Thu Dec 31 – Mon Jan 4) and MFL keeps the 2026
// league live until its rollover; the 2027 league doesn't exist yet (its exports 404). The cron ran the drop pipeline as the
// CALENDAR year, so from Jan 1 it scanned a league that doesn't exist (the recorder 502s on the failed pull) and every drop
// made in the live 2026 league was missed. It now runs as the LIVE league year, read from MFL itself (worker/src/league_year.js).
// Drives the REAL scheduled handler — worker.scheduled({ cron: "*/5 * * * *" }) with env.SELF looping back into worker.fetch —
// against one D1 and a per-year fake MFL / Discord / R2:
//   0. league_year.js on the shapes MFL really serves (verified live 2026-10-09).
//   a. a $20K Week-16 pickup in the 2026 league dropped Sun 2027-01-03 → recorded ONCE as season 2026, priced on 2026's weeks
//      (Week 17 is IN PROGRESS until Monday night: 1 of 2 eligible weeks → $10,000 earned → $5,000), booked to the 2027 cap
//      (canon §6 bucket 2); its card posts once; the 2026 next-season ledger lists it once.
//      a4. the same deal dropped Wed 2027-01-06, after Week 17 completed → 2 of 2 weeks earned → $0.
//   b. origin/main, same ticks (this file run against main's worker): every January tick ran the drop routes as YEAR=2027 —
//      scan-and-record 502 "transactions fetch failed for TRANS_TYPE=FREE_AGENT", post-mfl "auction_start_unresolved" — and
//      recorded NOTHING: no row, no card, no ledger entry, still none after MFL created 2027 (its export never holds a 2026 drop).
//   c. MFL creates the 2027 league → the cron runs as 2027; no 2026 row changes season or doubles; a drop after the 2027
//      FA Auction opens is season 2027, booked to 2028, as before.
//   d. the live league year can't be determined → the drop pipeline runs NOTHING (no row, card or charge under a guessed
//      season) and says so every tick; the first tick that resolves records the drop under the right season and price.
//   node tests/drop_season_after_jan1.test.mjs
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;
const { classifyLeagueExport, resolveLiveLeagueYear } = await import("../worker/src/league_year.js");

const RealDate = Date;
let NOW = RealDate.parse("2026-12-24T15:00:00Z");
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ET = (iso) => String(Math.floor(RealDate.parse(iso) / 1000));

// ── MFL's real answers (verified 2026-10-09) ──
const NOT_FOUND_HTML = "<H1>Not Found</H1>\n<p>The requested URL was not found on this server.</p>\n";   // /2027/export?… before MFL opens 2027
const invalidLeague = (lid) => JSON.stringify({ version: "1.0", error: { $t: `Invalid league ID ${lid}` }, encoding: "utf-8" });   // year open, league not renewed
const historyTo = (y) => Array.from({ length: y - 2009 }, (_, i) => String(2010 + i));     // a league's history lists 2010 … its latest year

// ── MFL, per league year. state: ok | 404 (year not opened) | invalid (league not renewed) | 500 (MFL can't answer) ──
const MFL = {
  "2026": { state: "ok", leagueState: "ok", history: historyTo(2026), txs: [
    { type: "BBID_WAIVER", franchise: "0005", timestamp: ET("2026-12-24T09:00:00-05:00"), transaction: "18000,|20000|" },   // Week 16 waiver pickups
    { type: "BBID_WAIVER", franchise: "0010", timestamp: ET("2026-12-24T09:00:00-05:00"), transaction: "18003,|20000|" },
    { type: "BBID_WAIVER", franchise: "0008", timestamp: ET("2026-12-24T09:00:00-05:00"), transaction: "18004,|20000|" },
    { type: "FREE_AGENT", franchise: "0008", timestamp: ET("2027-01-02T10:00:00-05:00"), transaction: "|18004," },          // Sat, Week 17 (d)
    { type: "FREE_AGENT", franchise: "0005", timestamp: ET("2027-01-03T11:00:00-05:00"), transaction: "|18000," },          // Sun before kickoff, Week 17 (a)
    { type: "FREE_AGENT", franchise: "0010", timestamp: ET("2027-01-06T12:00:00-05:00"), transaction: "|18003," },          // Wed, Week 17 complete (a2)
  ] },
};
const ALL_2026 = MFL["2026"].txs;
const only = (...pids) => ALL_2026.filter((x) => pids.some((p) => x.transaction.includes(p + ",")));   // one section's players
const ROLLOVER_DAY = "2027-02-15";
const ww = (id, k) => ({ id, salary: String(k * 1000), status: "ROSTER", contractStatus: "Vet-WW", contractInfo: `CL 1| TCV ${k}K| AAV ${k}K`, contractYear: "1" });
function snapshotFor(day) {
  // The daily R2 snapshot pulls the CALENDAR year's league, which 404s from Jan 1 until the rollover — so there is none for those
  // days, and the recorder's 7-day lookback reads Dec 31's.
  if (day >= "2027-01-01" && day < ROLLOVER_DAY) return null;
  const fr = {};
  const add = (fid, p) => (fr[fid] = fr[fid] || []).push(p);
  if (day >= "2026-12-24" && day <= "2027-01-03") add("0005", ww("18000", 20));
  if (day >= "2026-12-24" && day <= "2027-01-06") add("0010", ww("18003", 20));
  if (day >= "2026-12-24" && day <= "2027-01-02") add("0008", ww("18004", 20));
  if (day >= "2027-07-30" && day <= "2027-08-20") add("0003", { id: "19000", salary: "10000", status: "ROSTER", contractStatus: "Vet-FAA", contractInfo: "CL 1| TCV 10K| AAV 10K", contractYear: "1" });
  return { rosters: { franchise: Object.entries(fr).map(([id, player]) => ({ id, player })) } };
}
function nflSchedule(w, year) {       // 2026: Wed Sep 9 opener, then Thu 8:15 PM / Sun 1 PM / Mon 8:15 PM ET (Week 17 = Dec 31 – Jan 4); 2027 = +52 weeks
  const shift = (Number(year || 2026) - 2026) * 364 * 86400;
  const ko = (d, h, m) => String(Math.floor(RealDate.UTC(2026, 8, d, h, m) / 1000) + shift);
  const thu = w === 1 ? ko(10, 0, 20) : ko(18 + 7 * (w - 2), 0, 15), sun = ko(13 + 7 * (w - 1), 17, 0), mon = ko(15 + 7 * (w - 1), 0, 15);
  return { nflSchedule: { week: String(w), matchup: [{ kickoff: thu, team: [{ id: "KCC" }, { id: "BAL" }] }, { kickoff: sun, team: [{ id: "BUF" }, { id: "MIA" }] }, { kickoff: mon, team: [{ id: "NYG" }, { id: "DAL" }] }] } };
}
const liveWeek = (year) => { let w = 1; for (let k = 1; k <= 18; k++) if (Number(nflSchedule(k, year).nflSchedule.matchup[0].kickoff) * 1000 <= NOW) w = k; return w; };
const DISCORD = { posts: [] };
const IMPORTS = [];
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
const notFound = () => new Response(NOT_FOUND_HTML, { status: 404, headers: { "content-type": "text/html" } });
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "discord.com") {
    if ((init?.method || "GET") === "POST" && /\/messages$/.test(u.pathname)) { DISCORD.posts.push(JSON.parse(init.body || "{}")); return json({ id: "msg" + DISCORD.posts.length }); }
    return json({ id: "thr" + RealDate.now() });
  }
  if (/myfantasyleague\.com$/.test(u.hostname)) {
    const year = (u.pathname.match(/\/(\d{4})\//) || [])[1];
    const Y = MFL[year];
    if (!Y || Y.state === "404") return notFound();                                   // MFL hasn't opened that year at all
    if (/\/import$/.test(u.pathname)) { IMPORTS.push(year + ":" + String(init?.body || "").slice(0, 200)); return new Response("<status>OK</status>", { status: 200 }); }
    const type = u.searchParams.get("TYPE");
    if (type === "nflSchedule") return json(nflSchedule(Number(u.searchParams.get("W")), Number(year)));
    if (type === "injuries") return json({ injuries: { injury: [] } });
    if (Y.state === "invalid") return new Response(invalidLeague(u.searchParams.get("L")), { status: 200, headers: { "content-type": "application/json" } });
    if (Y.state === "500") return json({ error: "MFL boom" }, 500);
    if (type === "league") {
      if (Y.leagueState === "500") return json({ error: "MFL boom" }, 500);
      return json({ version: "1.0", league: { id: "74598", name: "UPS Salary Cap Dynasty",
        franchises: { franchise: [["0003", "Gride"], ["0005", "HammerTime"], ["0008", "Real Deal Creel"], ["0010", "Blake Bombers"]].map(([id, name]) => ({ id, name, email: id + "@ups.test" })) },
        history: { league: Y.history.map((y) => ({ year: y, url: `https://www48.myfantasyleague.com/${y}/home/74598` })) } } });
    }
    if (type === "transactions") {
      const tt = u.searchParams.get("TRANS_TYPE"), days = Number(u.searchParams.get("DAYS")) || 0;
      return json({ transactions: { transaction: Y.txs.filter((x) => Number(x.timestamp) <= NOW / 1000 && (!tt || x.type === tt) && (!days || Number(x.timestamp) >= NOW / 1000 - days * 86400)) } });
    }
    if (type === "liveScoring") return json({ liveScoring: { week: String(liveWeek(Number(year))) } });
    if (type === "players") return json({ players: { player: [["18000", "Pickup, Late"], ["18003", "Drop, Gap"], ["18004", "Drop, Outage"], ["19000", "Auction, Vet"]].map(([id, name]) => ({ id, name, position: "WR", team: "KCC" })) } });
    if (type === "salaryAdjustments") return json({ salaryAdjustments: { salaryAdjustment: [] } });
    return json({ error: "test: no such export " + type }, 503);
  }
  return json({ error: "test: no such call " + u.hostname }, 503);
};

function makeDb(calendar) {
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
  db.raw.exec("CREATE TABLE ups_taxi_callups (player_id TEXT, pending INTEGER)");
  db.raw.exec("CREATE TABLE ups_faa_nom_penalties (penalty_id TEXT, season INTEGER, league_id TEXT, fid TEXT, et_day TEXT, offense_no INTEGER, amount_k INTEGER, applies_to_season INTEGER, voided INTEGER DEFAULT 0, posted_to_mfl INTEGER DEFAULT 0)");
  db.raw.exec("CREATE TABLE ups_bot_heartbeat (bot TEXT PRIMARY KEY, last_ts INTEGER, status TEXT, env TEXT)");
  setCalendar(db, calendar);
  return db;
}
// The commish-maintained League Calendar (ups_settings 'auction_calendar') — the FA Auction start that decides a drop's cap year.
function setCalendar(db, { season, faaOpen }) {
  db.raw.exec("CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  db.raw.prepare("INSERT INTO ups_settings (key, value, updated_at) VALUES ('auction_calendar', ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify({ season, faa: { faa_open_at: faaOpen } }), "2026-07-01T00:00:00Z");
}
const r2 = { async get(key) {
  const m = /^snapshots\/(\d{4}-\d{2}-\d{2})\/rosters\.json$/.exec(key);
  const snap = m ? snapshotFor(m[1]) : null;
  return snap ? { async text() { return JSON.stringify(snap); }, uploaded: new RealDate(`${m[1]}T09:05:00.000Z`) } : null;
} };
const makeEnv = (d) => ({ UPS_MFL_DB: d, UPS_MFL_BACKUPS: r2, COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k", LEAGUE_ID: "74598",
  DISCORD_BOT_TOKEN: "bot", DISCORD_DROPS_TEST_CHANNEL_ID: "999",
  DROP_TRACKER_ENABLED: "1", DROP_TRACKER_AUTO_POST: "1", DROP_TRACKER_POST_MFL: "1", DROP_TRACKER_DISCORD_TARGET: "test" });

// ── One REAL */5 tick: worker.scheduled, its self-fetches looped back through worker.fetch, every waitUntil awaited ──
const ERRORS = [];
const realError = console.error;
console.error = (...a) => { ERRORS.push(a.map(String).join(" ")); realError(...a); };
async function tick(env) {
  const pending = [], calls = [];
  const ctx = { waitUntil(p) { pending.push(Promise.resolve(p)); }, passThroughOnException() {} };
  env.SELF = { fetch: async (input, init) => {
    const req = new Request(input, init);
    const u = new URL(req.url);
    const res = await worker.fetch(req, env, ctx);
    const body = await res.clone().json().catch(() => null);
    calls.push({ path: u.pathname, year: u.searchParams.get("YEAR"), status: res.status, body });
    return res;
  } };
  const err0 = ERRORS.length;
  await worker.scheduled({ cron: "*/5 * * * *", scheduledTime: NOW }, env, ctx);
  for (let i = 0; i < pending.length; i++) await pending[i];
  const drops = calls.filter((c) => c.path.startsWith("/admin/drops/"));
  return { drops, of: (p) => drops.find((c) => c.path === "/admin/drops/" + p), errors: ERRORS.slice(err0) };
}
const rowsOf = (db, pid) => db.raw.prepare("SELECT * FROM ups_drop_events WHERE player_id = ? ORDER BY id").all(pid).map((r) => ({ ...r }));
const allRows = (db) => db.raw.prepare("SELECT * FROM ups_drop_events ORDER BY id").all().map((r) => ({ ...r }));
const priced = (r) => ({ season: r.season, earned: r.earned_to_date, guaranteed: r.guaranteed_amount, penalty: r.penalty_amount, basis: r.penalty_basis, applies_to_season: r.applies_to_season });
const nextSeasonLedger = async (env, y) => {
  const res = await worker.fetch(new Request(`https://w.test/api/cap-adjustments/next-season?L=74598&YEAR=${y}`), env, { waitUntil() {}, passThroughOnException() {} });
  return res.json();
};
const DROP_ROUTES = ["/admin/drops/scan-and-record", "/admin/drops/post-discord", "/admin/drops/capfree-notify", "/admin/drops/post-mfl", "/admin/drops/reconcile-post"];

// ═════════ 0. league_year.js on MFL's real shapes ═════════
test("0a. classifyLeagueExport: 404 page and 'Invalid league ID' are ABSENT; this league's export EXISTS (with its history); anything else is UNKNOWN", () => {
  t.deepEqual(classifyLeagueExport({ status: 404, text: NOT_FOUND_HTML }, "74598").state, "absent");
  t.equal(classifyLeagueExport({ status: 200, text: invalidLeague("74598") }, "74598").state, "absent");
  const ok = classifyLeagueExport({ status: 200, text: JSON.stringify({ league: { id: "74598", history: { league: [{ year: "2026" }, { year: "2010" }, { year: "2025" }] } } }) }, "74598");
  t.equal(ok.state, "exists"); t.deepEqual(ok.history_years, [2026, 2010, 2025]);
  for (const [res, why] of [[{ status: 500, text: "{}" }, "http_500"], [{ status: 200, text: "<html>maintenance</html>" }, "non_json"],
    [{ status: 200, text: JSON.stringify({ error: { $t: "API Key Validation Failed" } }) }, "mfl_error:API Key Validation Failed"],
    [{ status: 200, text: JSON.stringify({ league: { id: "25625" } }) }, "not_this_league"], [{ status: 0, text: "" }, "no_response"]]) {
    const c = classifyLeagueExport(res, "74598");
    t.equal(c.state, "unknown", why); t.equal(c.detail, why);
  }
});
test("0b. resolveLiveLeagueYear: pin › this year exists › last year still the latest › otherwise UNRESOLVED (never a guess)", async () => {
  const league = (years) => ({ status: 200, text: JSON.stringify({ league: { id: "74598", history: { league: years.map((year) => ({ year })) } } }) });
  const reader = (answers) => { const asked = []; return { asked, readLeague: async (y) => { asked.push(y); const a = answers[y]; if (a instanceof Error) throw a; return a || { status: 404, text: NOT_FOUND_HTML }; } }; };
  const at = (iso) => RealDate.parse(iso);
  let r = reader({}); t.deepEqual(await resolveLiveLeagueYear({ leagueId: "74598", nowMs: at("2027-01-03T16:00:00Z"), pinnedYear: "2026", readLeague: r.readLeague }),
    { ok: true, season: "2026", source: "env.YEAR", calendar_year: 2027 }); t.deepEqual(r.asked, [], "a pin reads nothing");
  r = reader({ 2026: league(historyTo(2026)) });
  let x = await resolveLiveLeagueYear({ leagueId: "74598", nowMs: at("2026-10-27T16:00:00Z"), readLeague: r.readLeague });
  t.deepEqual([x.ok, x.season, r.asked], [true, "2026", [2026]], "Mar–Dec: one read");
  r = reader({ 2026: league(historyTo(2026)) });
  x = await resolveLiveLeagueYear({ leagueId: "74598", nowMs: at("2027-01-03T16:00:00Z"), readLeague: r.readLeague });
  t.deepEqual([x.ok, x.season, x.source, r.asked], [true, "2026", "mfl_league_2027_http_404+league_2026_latest", [2027, 2026]]);
  r = reader({ 2027: { status: 200, text: invalidLeague("74598") }, 2026: league(historyTo(2026)) });
  t.equal((await resolveLiveLeagueYear({ leagueId: "74598", nowMs: at("2027-02-01T16:00:00Z"), readLeague: r.readLeague })).season, "2026", "2027 opened, league not renewed yet");
  r = reader({ 2027: league(historyTo(2027)), 2026: league(historyTo(2027)) });
  t.equal((await resolveLiveLeagueYear({ leagueId: "74598", nowMs: at("2027-02-15T16:00:00Z"), readLeague: r.readLeague })).season, "2027", "after the rollover");
  for (const [answers, reason] of [
    [{ 2027: { status: 503, text: "" } }, /^league_2027_unreadable:http_503$/],
    [{ 2027: new Error("The operation was aborted") }, /^league_2027_unreadable:fetch_failed:The operation was aborted$/],
    [{ 2026: league(historyTo(2027)) }, /^contradiction:league_2026_history_lists_2027_but_league_2027_http_404$/],
    [{ 2026: { status: 500, text: "{}" } }, /^league_2027_absent:http_404\+league_2026_unknown:http_500$/],
    [{ 2026: { status: 200, text: JSON.stringify({ league: { id: "74598" } }) } }, /^league_2027_absent\+league_2026_history_unreadable$/],
  ]) {
    r = reader(answers);
    x = await resolveLiveLeagueYear({ leagueId: "74598", nowMs: at("2027-01-03T16:00:00Z"), readLeague: r.readLeague });
    t.equal(x.ok, false); t.equal(x.season, null); t.match(x.reason, reason);
  }
});

// ═════════ a. a 2026-league drop on Sun 2027-01-03 ═════════
const dbA = makeDb({ season: "2026", faaOpen: "2026-07-25T12:00" }), envA = makeEnv(dbA);
test("a1. Sun 2027-01-03 11:05 AM ET (Week 17 in progress): the */5 tick runs every drop route as 2026 → ONE row, season 2026, $5,000, 2027 cap", async () => {
  MFL["2026"].txs = only("18000", "18003");
  NOW = RealDate.parse("2027-01-03T16:05:00Z");
  const d0 = DISCORD.posts.length;
  const k = await tick(envA);
  t.deepEqual(k.drops.map((c) => [c.path, c.year]), DROP_ROUTES.map((p) => [p, "2026"]), "every drop route ran as the LIVE league year, not the calendar year 2027");
  t.equal(k.of("scan-and-record").status, 200, JSON.stringify(k.of("scan-and-record").body).slice(0, 300));
  t.equal(k.of("scan-and-record").body.written_count, 1);
  const rows = rowsOf(dbA, "18000");
  t.equal(rows.length, 1);
  // Week-16 pickup: Weeks 16–17 = 2 eligible; Week 17 is in progress until Monday night → 1 completed → earned 10,000; 15,000 − 10,000
  t.deepEqual(priced(rows[0]), { season: "2026", earned: 10000, guaranteed: 15000, penalty: 5000, basis: "guarantee_minus_earned", applies_to_season: 2027 });
  t.equal(rows[0].cap_season_source, "auction_calendar.faa_open_at");
  t.equal(rows[0].ledger_key, "18000_" + ET("2027-01-03T11:00:00-05:00"));
  t.equal(DISCORD.posts.length, d0 + 1, "its card went out");
  const card = JSON.stringify(DISCORD.posts.at(-1));
  t.match(card, /Drop: Late Pickup[\s\S]*Cap Penalty: \$5K/); t.match(card, /applies to the \*\*2027\*\* cap/); t.ok(!/could not be resolved/.test(card));
  t.equal(rows[0].discord_posted, 1);
  // post-mfl (2026) books it to NEXT season's cap: ledger-only, nothing written to MFL
  t.deepEqual(k.of("post-mfl").body.deferred_next_season.map((x) => [x.player_id, x.amount, x.applies_to_season]), [["18000", 5000, 2027]]);
  t.equal(k.of("post-mfl").body.posted, 0); t.deepEqual(IMPORTS, [], "no MFL salaryAdjustment import");
  t.equal(rows[0].posted_to_mfl, 0);
  t.ok(!k.errors.some((e) => /drop-tracker (SKIPPED|failed)/.test(e)), k.errors.join("\n"));
});
test("a2. the next ticks: nothing recorded or posted twice", async () => {
  const d0 = DISCORD.posts.length, before = allRows(dbA);
  for (const iso of ["2027-01-03T16:10:00Z", "2027-01-03T16:15:00Z"]) {
    NOW = RealDate.parse(iso);
    const k = await tick(envA);
    t.equal(k.of("scan-and-record").body.written_count, 0);
    t.equal(k.of("post-discord").body.posted_count, 0);
  }
  t.equal(DISCORD.posts.length, d0); t.deepEqual(allRows(dbA), before);
});
test("a3. the 2026 next-season ledger lists it ONCE — $5,000 on the 2027 cap", async () => {
  const n = await nextSeasonLedger(envA, "2026");
  t.deepEqual(n.rows.map((x) => [x.player_id, x.amount, x.applies_to_season]), [["18000", 5000, 2027]]);
  t.deepEqual(n.held_unpriced, []);
});
test("a4. Wed 2027-01-06 (Week 17 complete, before Week 18): the same $20K deal dropped is fully earned → $0, season 2026, 2027 cap; card says so", async () => {
  NOW = RealDate.parse("2027-01-06T17:05:00Z");
  const d0 = DISCORD.posts.length;
  const k = await tick(envA);
  t.deepEqual(k.drops.map((c) => c.year), DROP_ROUTES.map(() => "2026"));
  const rows = rowsOf(dbA, "18003");
  t.equal(rows.length, 1);
  // Weeks 16–17 = 2 eligible, both complete → earned 20,000 ≥ the 15,000 guarantee
  t.deepEqual(priced(rows[0]), { season: "2026", earned: 20000, guaranteed: 15000, penalty: 0, basis: "no_penalty_zero", applies_to_season: 2027 });
  t.equal(DISCORD.posts.length, d0 + 1); t.match(JSON.stringify(DISCORD.posts.at(-1)), /Drop: Gap Drop[\s\S]*No Cap Penalty/);
  const n = await nextSeasonLedger(envA, "2026");
  t.deepEqual(n.rows.map((x) => [x.player_id, x.amount]), [["18000", 5000]], "a $0 drop books nothing");
});

// ═════════ c. MFL rolls the league over to 2027 ═════════
test("c1. Feb 15 2027, MFL creates the 2027 league: the tick runs as 2027 — no 2026 row changes season, nothing re-recorded", async () => {
  MFL["2027"] = { state: "ok", leagueState: "ok", history: historyTo(2027), txs: [] };
  MFL["2026"].history = historyTo(2027);                    // renewing lists the new year in every linked year's history
  NOW = RealDate.parse("2027-02-15T15:05:00Z");
  const before = allRows(dbA), d0 = DISCORD.posts.length;
  const k = await tick(envA);
  t.deepEqual(k.drops.map((c) => [c.path, c.year]), DROP_ROUTES.map((p) => [p, "2027"]));
  t.equal(k.of("scan-and-record").status, 200);
  t.deepEqual(allRows(dbA), before, "the 2026 rows are byte-identical (season 2026, applies_to_season 2027)");
  t.equal(DISCORD.posts.length, d0);
});
test("c2. Fri 2027-08-20, after the 2027 FA Auction opened: a 2027 auction contract dropped is season 2027, booked to 2028, as before", async () => {
  setCalendar(dbA, { season: "2027", faaOpen: "2027-07-24T12:00" });   // the commish rolls the League Calendar forward
  MFL["2027"].txs = [
    { type: "AUCTION_WON", franchise: "0003", timestamp: ET("2027-07-30T21:00:00-04:00"), transaction: "19000|10000|" },
    { type: "FREE_AGENT", franchise: "0003", timestamp: ET("2027-08-20T12:00:00-04:00"), transaction: "|19000," },
  ];
  NOW = RealDate.parse("2027-08-20T16:05:00Z");
  const before = allRows(dbA), d0 = DISCORD.posts.length;
  const k = await tick(envA);
  t.deepEqual(k.drops.map((c) => c.year), DROP_ROUTES.map(() => "2027"));
  const rows = rowsOf(dbA, "19000");
  t.equal(rows.length, 1);
  // preseason: 0 weeks earned → the full 75% guarantee of $10,000
  t.deepEqual(priced(rows[0]), { season: "2027", earned: 0, guaranteed: 7500, penalty: 7500, basis: "guarantee_minus_earned", applies_to_season: 2028 });
  t.equal(DISCORD.posts.length, d0 + 1); t.match(JSON.stringify(DISCORD.posts.at(-1)), /Drop: Vet Auction[\s\S]*Cap Penalty: \$7\.5K/);
  t.deepEqual(allRows(dbA).filter((r) => r.player_id !== "19000"), before, "the 2026 rows are still untouched");
  t.deepEqual(allRows(dbA).map((r) => [r.player_id, r.season]), [["18000", "2026"], ["18003", "2026"], ["19000", "2027"]]);
  delete MFL["2027"]; MFL["2026"].history = historyTo(2026);
});

// ═════════ d. the live league year can't be determined ═════════
const dbD = makeDb({ season: "2026", faaOpen: "2026-07-25T12:00" }), envD = makeEnv(dbD);
async function refusedTick(reason) {
  const d0 = DISCORD.posts.length, i0 = IMPORTS.length, before = allRows(dbD);
  const k = await tick(envD);
  t.deepEqual(k.drops, [], "no drop route ran — nothing recorded, posted or charged under a guessed season");
  t.ok(k.errors.some((e) => /\[scheduled \*\/5\] drop-tracker SKIPPED: live MFL league year unresolved/.test(e) && reason.test(e)), "said so: " + k.errors.join(" | ").slice(0, 400));
  t.deepEqual(allRows(dbD), before); t.equal(DISCORD.posts.length, d0); t.equal(IMPORTS.length, i0);
}
test("d1. Sat 2027-01-02, MFL answers 500 for 2027 (does it exist yet? unknown) → the drop pipeline runs nothing, loudly", async () => {
  MFL["2026"].txs = only("18004");
  MFL["2027"] = { state: "500" };
  NOW = RealDate.parse("2027-01-02T15:05:00Z");
  await refusedTick(/league_2027_unreadable:http_500/);
  delete MFL["2027"];
});
test("d2. 2027 is absent but 2026's own history already lists 2027 — MFL contradicts itself → nothing runs", async () => {
  MFL["2026"].history = historyTo(2027);
  NOW = RealDate.parse("2027-01-02T15:10:00Z");
  await refusedTick(/contradiction:league_2026_history_lists_2027_but_league_2027_http_404/);
  MFL["2026"].history = historyTo(2026);
});
test("d3. 2027 is absent and 2026's league export is unreadable → nothing runs", async () => {
  MFL["2026"].leagueState = "500";
  NOW = RealDate.parse("2027-01-02T15:15:00Z");
  await refusedTick(/league_2027_absent:http_404\+league_2026_unknown:http_500/);
  MFL["2026"].leagueState = "ok";
  t.deepEqual(allRows(dbD), [], "the Saturday drop has not been recorded under any season");
  const n = await nextSeasonLedger(envD, "2026");
  t.deepEqual([n.rows, n.held_unpriced], [[], []], "and nothing is booked for it");
});
test("d4. the first tick that resolves (MFL has opened 2027 but not renewed the league) records it ONCE: season 2026, $5,000, 2027 cap", async () => {
  MFL["2027"] = { state: "invalid" };
  NOW = RealDate.parse("2027-01-02T15:30:00Z");
  const d0 = DISCORD.posts.length;
  const k = await tick(envD);
  t.deepEqual(k.drops.map((c) => c.year), DROP_ROUTES.map(() => "2026"));
  const rows = rowsOf(dbD, "18004");
  t.equal(rows.length, 1);
  // Week 17 in progress on Saturday (Thursday's game played) → Week 16 is the last complete week: 1 of 2 → 10,000 earned
  t.deepEqual(priced(rows[0]), { season: "2026", earned: 10000, guaranteed: 15000, penalty: 5000, basis: "guarantee_minus_earned", applies_to_season: 2027 });
  t.equal(DISCORD.posts.length, d0 + 1); t.match(JSON.stringify(DISCORD.posts.at(-1)), /Drop: Outage Drop[\s\S]*Cap Penalty: \$5K/);
  t.deepEqual(IMPORTS, []);
  delete MFL["2027"];
});

await run("drop_season_after_jan1");

globalThis.Date = RealDate;
console.error = realError;
