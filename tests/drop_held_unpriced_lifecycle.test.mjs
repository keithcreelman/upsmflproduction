// A drop recorded UNPRICED (an MFL read failed) is HELD — visible, never announced as "No Cap Penalty", never charged — and is
// priced on a later tick once MFL recovers, then booked exactly once (Keith 2026-10-09, review of #1202).
//   node tests/drop_held_unpriced_lifecycle.test.mjs
//
// The REAL routes, in sequence, against one D1 and a stateful fake MFL / Discord / R2:
//   /admin/drops/scan-and-record → /admin/drops/post-discord → /admin/drops/post-mfl → GET /api/cap-adjustments/next-season
// Timeline (2026, ET; Week 1 opened Wed Sep 9; Thursday openers):
//   Thu 09-24 09:00  0010 blind-bids $1K for Will Shipley (Week 3)            ← the EARLIER Shipley contract
//   Thu 09-24 09:00  0001 blind-bids $8K for player 15000 (Week 3)
//   Fri 09-25 09:00  0010's blind bid for 17207 drops Shipley                   — cap-free ($1K WW), priced even while MFL is down
//   Tue 10-06 12:00  0001 drops 15000                                           — HELD (MFL transactions unreadable)
//   Thu 10-08 09:00  0008 blind-bids $11K for Shipley (Week 5)                  ← Shipley RE-ACQUIRED
//   Thu 10-15 09:00  0005 blind-bids $9K for 15000 (Week 6)                     ← 15000 re-acquired AFTER his drop
//   Tue 10-27 12:00  0008 drops Shipley                                         — HELD (still unreadable)
//   then MFL recovers → both priced AS OF THEIR OWN DROP (the recorder's own live week rule at that instant), on the contract
//   each ENDED — exactly what a recorder that never lost MFL charges (the control run, test 10):
//     15000: Week-3 contract (not the Week-6 one that came later), 15 weeks; Week 4 ended Monday → 4 completed → 2 eligible:
//            earned round(2/15 × 8000) = $1,067, penalty floor(8000 × .75) − 1,067 = $4,933  (latest add: $6,000; 17 weeks: $4,118)
//     Shipley: Week-5 contract (not 0010's Week-3 one), 13 weeks; Week 7 ended Monday → 7 completed → 3 eligible:
//            earned round(3/13 × 11000) = $2,538, penalty 8,250 − 2,538 = $5,712          (17 weeks: $3,721; the Week-3 contract: $4,583)
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

// ── a controllable clock (the scanner prices "now"; the held-row re-price is as of each drop) ──
const RealDate = Date;
let NOW = RealDate.parse("2026-10-06T16:05:00Z");
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ET = (iso) => Math.floor(RealDate.parse(iso) / 1000);

// ── MFL state ──
const TXS = [
  { type: "BBID_WAIVER", franchise: "0010", timestamp: String(ET("2026-09-24T09:00:00-04:00")), transaction: "16601,|1000|" },
  { type: "BBID_WAIVER", franchise: "0001", timestamp: String(ET("2026-09-24T09:00:00-04:00")), transaction: "15000,|8000|" },
  { type: "BBID_WAIVER", franchise: "0010", timestamp: String(ET("2026-09-25T09:00:00-04:00")), transaction: "17207,|1000|16601," },
  { type: "FREE_AGENT", franchise: "0001", timestamp: String(ET("2026-10-06T12:00:00-04:00")), transaction: "|15000," },
  { type: "BBID_WAIVER", franchise: "0008", timestamp: String(ET("2026-10-08T09:00:00-04:00")), transaction: "16601,|11000|" },
  { type: "BBID_WAIVER", franchise: "0005", timestamp: String(ET("2026-10-15T09:00:00-04:00")), transaction: "15000,|9000|" },
  { type: "FREE_AGENT", franchise: "0008", timestamp: String(ET("2026-10-27T12:00:00-04:00")), transaction: "|16601," },
];
const ww = (id, k) => ({ id, salary: String(k * 1000), status: "ROSTER", contractStatus: "Vet-WW", contractInfo: `CL 1| TCV ${k}K| AAV ${k}K`, contractYear: "1" });
// R2 roster snapshot for a day: who held what that morning
function snapshotFor(day) {
  const fr = {};
  const add = (fid, p) => (fr[fid] = fr[fid] || []).push(p);
  if (day >= "2026-09-24" && day <= "2026-09-25") add("0010", ww("16601", 1));
  if (day >= "2026-09-24" && day <= "2026-10-06") add("0001", ww("15000", 8));
  if (day >= "2026-10-08" && day <= "2026-10-27") add("0008", ww("16601", 11));
  if (day >= "2026-10-15") add("0005", ww("15000", 9));
  return { rosters: { franchise: Object.entries(fr).map(([id, player]) => ({ id, player })) } };
}
// MFL's nflSchedule: Week 1 Wed Sep 9 8:20 PM ET, then Thursday 8:15 PM ET openers, Sunday 1 PM, Monday 8:15 PM ET closers
function nflSchedule(w) {
  const ko = (d, h, m) => String(Math.floor(RealDate.UTC(2026, 8, d, h, m) / 1000));
  const thu = w === 1 ? ko(10, 0, 20) : ko(18 + 7 * (w - 2), 0, 15), sun = ko(13 + 7 * (w - 1), 17, 0), mon = ko(15 + 7 * (w - 1), 0, 15);
  return { nflSchedule: { week: String(w), matchup: [{ kickoff: thu, team: [{ id: "KCC" }, { id: "BAL" }] }, { kickoff: sun, team: [{ id: "BUF" }, { id: "MIA" }] }, { kickoff: mon, team: [{ id: "NYG" }, { id: "DAL" }] }] } };
}
const liveWeek = () => { let w = 1; for (let k = 1; k <= 18; k++) if (Number(nflSchedule(k).nflSchedule.matchup[0].kickoff) * 1000 <= NOW) w = k; return w; };

const MFL = { failAllTransactions: false, imports: [], exports: [] };
const DISCORD = { posts: [] };
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "discord.com") {
    if ((init?.method || "GET") === "POST" && /\/messages$/.test(u.pathname)) {
      const body = JSON.parse(init.body || "{}");
      DISCORD.posts.push({ path: u.pathname, body });
      return json({ id: "msg" + DISCORD.posts.length });
    }
    return json({ id: "thr" + Date.now() });
  }
  if (/myfantasyleague\.com$/.test(u.hostname)) {
    if (/\/import$/.test(u.pathname)) { MFL.imports.push(String(init?.body || "")); return new Response("<status>OK</status>", { status: 200 }); }
    const type = u.searchParams.get("TYPE");
    MFL.exports.push(type + (u.searchParams.get("TRANS_TYPE") ? ":" + u.searchParams.get("TRANS_TYPE") : ""));
    if (type === "transactions") {
      const tt = u.searchParams.get("TRANS_TYPE");
      if (!tt && MFL.failAllTransactions) return json({ error: "MFL boom" }, 500);
      const upto = Math.floor(NOW / 1000);
      return json({ transactions: { transaction: TXS.filter((x) => Number(x.timestamp) <= upto && (!tt || x.type === tt)) } });
    }
    if (type === "nflSchedule") return json(nflSchedule(Number(u.searchParams.get("W"))));
    if (type === "liveScoring") return json({ liveScoring: { week: String(liveWeek()) } });
    if (type === "players") return json({ players: { player: [{ id: "16601", name: "Shipley, Will", position: "RB", team: "PHI" }, { id: "15000", name: "Player, Test", position: "WR", team: "KCC" }, { id: "17207", name: "Other, Guy", position: "TE", team: "BUF" }] } });
    // (the commissioner cookie sees owners' e-mail addresses — what post-mfl's admin check looks for)
    if (type === "league") return json({ league: { franchises: { franchise: [["0001", "L.A. Looks"], ["0005", "HammerTime"], ["0008", "Real Deal Creel"], ["0010", "Team 10"]].map(([id, name]) => ({ id, name, email: id + "@ups.test" })) } } });
    if (type === "injuries") return json({ injuries: { injury: [] } });
    if (type === "salaryAdjustments") return json({ salaryAdjustments: { salaryAdjustment: [] } });
    return json({ error: "test: no such export " + type }, 503);
  }
  return json({ error: "test: no such call " + u.hostname }, 503);
};

// ── a D1 per run ──
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
db.raw.exec("CREATE TABLE ups_taxi_callups (player_id TEXT, pending INTEGER)");
db.raw.exec("CREATE TABLE ups_faa_nom_penalties (penalty_id TEXT, season INTEGER, league_id TEXT, fid TEXT, et_day TEXT, offense_no INTEGER, amount_k INTEGER, applies_to_season INTEGER, voided INTEGER DEFAULT 0, posted_to_mfl INTEGER DEFAULT 0)");
return db;
}
const db = makeDb();
const r2 = { async get(key) {
  const m = /^snapshots\/(\d{4}-\d{2}-\d{2})\/rosters\.json$/.exec(key);
  if (!m) return null;
  return { async text() { return JSON.stringify(snapshotFor(m[1])); }, uploaded: new RealDate(`${m[1]}T09:05:00.000Z`) };
} };
const makeEnv = (d) => ({ UPS_MFL_DB: d, UPS_MFL_BACKUPS: r2, COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k",
  FA_AUCTION_START_AT: String(ET("2026-07-25T12:00:00-04:00")), DISCORD_BOT_TOKEN: "bot", DISCORD_DROPS_TEST_CHANNEL_ID: "999" });
let env = makeEnv(db);

async function call(method, path, body) {
  const req = new Request("https://w.test" + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const res = await worker.fetch(req, env, { waitUntil() {}, passThroughOnException() {} });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  return { status: res.status, json: j, text };
}
const Q = "?L=74598&YEAR=2026&APIKEY=admin";
const scan = () => call("POST", "/admin/drops/scan-and-record" + Q, { season: "2026", league_id: "74598", days: 40, include_waivers: true });
const postDiscord = (extra) => call("POST", "/admin/drops/post-discord" + Q, { season: "2026", league_id: "74598", target: "test", limit: 20, ...(extra || {}) });
const postMfl = () => call("POST", "/admin/drops/post-mfl" + Q, { season: "2026", league_id: "74598", limit: 20 });
const nextSeason = () => call("GET", "/api/cap-adjustments/next-season?L=74598&YEAR=2026");
const rowOf = (pid, fid) => ({ ...db.raw.prepare("SELECT * FROM ups_drop_events WHERE player_id = ? AND franchise_id = ?").get(pid, fid) });
const cardsFor = (name) => DISCORD.posts.filter((p) => JSON.stringify(p.body).includes(name));
const NO_PENALTY = /No Cap Penalty/;

test("1. Tue 10-06, MFL's transactions export DOWN: 0010's cap-free Shipley drop is priced; 0001's $8K drop is HELD, not guessed", async () => {
  NOW = RealDate.parse("2026-10-06T16:05:00Z");
  MFL.failAllTransactions = true;
  const s = await scan();
  t.equal(s.status, 200, s.text.slice(0, 300));
  t.equal(s.json.acquisition_week_source, "unresolved");
  const ship = rowOf("16601", "0010");
  t.equal(ship.penalty_amount, 0, "the earlier Shipley contract ($1K WW, Week 3): cap-free whatever the window");
  t.ok(ship.penalty_basis !== "week_authority_unresolved", "…so it is NOT held: " + ship.penalty_basis);
  t.equal(ship.earned_to_date, null, "its earned figure is unknown without the window — not a 17-week guess");
  const p = rowOf("15000", "0001");
  t.equal(p.penalty_basis, "week_authority_unresolved", "the $8K drop is HELD"); t.equal(p.penalty_amount, null); t.equal(p.earned_to_date, null);
  t.match(p.notes || "", /HELD — unpriced: The acquisition week could not be resolved/);
  t.equal(s.json.held_unpriced_count, 1); t.equal(s.json.held_unpriced[0].pid, "15000");
});

test("2. …the Discord poster does NOT announce the held drop (and no card anywhere says 'No Cap Penalty' for it); an explicit repost is refused too", async () => {
  const d = await postDiscord();
  t.equal(d.status, 200, d.text.slice(0, 300));
  t.equal(cardsFor("Player, Test").length + cardsFor("Test Player").length, 0, "no card for the held drop");
  t.equal(d.json.held_unpriced_count, 1); t.equal(d.json.held_unpriced[0].player_id, "15000");
  t.equal(rowOf("15000", "0001").discord_posted, 0, "still unposted, so it goes out once it is priced");
  const id = rowOf("15000", "0001").id;
  const forced = await postDiscord({ repost_ids: [id] });
  t.equal(forced.json.posted_count, 0, "a repost of a held row is refused");
  t.ok((forced.json.results || []).some((r) => r.row_id === id && r.held === true));
  t.equal(DISCORD.posts.filter((p) => NO_PENALTY.test(JSON.stringify(p.body)) && /Test/.test(JSON.stringify(p.body))).length, 0);
});

test("3. …post-mfl charges nothing for it and says it is held; the next-season ledger lists it as held with no amount", async () => {
  const m = await postMfl();
  t.equal(m.status, 200, m.text.slice(0, 300));
  t.equal(MFL.imports.length, 0, "no MFL write");
  t.equal((m.json.deferred_next_season || []).length, 0, "nothing booked");
  t.equal((m.json.held_unpriced || []).length, 1); t.match(m.json.message, /HELD unpriced/);
  const n = await nextSeason();
  t.equal(n.json.rows.length, 0); t.equal(n.json.held_unpriced.length, 1); t.equal(n.json.held_unpriced[0].amount, null);
});

test("4. Tue 10-27, STILL down: 0008 drops the re-acquired Shipley → HELD as well; 15000 stays held (its re-price can't resolve either)", async () => {
  NOW = RealDate.parse("2026-10-27T16:05:00Z");
  const s = await scan();
  t.equal(s.status, 200, s.text.slice(0, 300));
  const ship = rowOf("16601", "0008");
  t.equal(ship.penalty_basis, "week_authority_unresolved"); t.equal(ship.penalty_amount, null);
  t.equal(s.json.repriced_count, 0);
  t.equal(s.json.held_unpriced_count, 2);
  t.deepEqual(s.json.held_unpriced.map((h) => h.pid).sort(), ["15000", "16601"]);
  t.ok(s.json.held_unpriced.find((h) => h.pid === "15000").reason === "acquisition_week_unresolved");
  const d = await postDiscord();
  t.equal(d.json.posted_count, 0); t.equal(d.json.held_unpriced_count, 2);
  t.equal(cardsFor("Will Shipley").filter((p) => /0008|Real Deal/.test(JSON.stringify(p.body))).length, 0, "no Shipley card for 0008's drop yet");
  t.equal((await postMfl()).json.held_unpriced.length, 2); t.equal(MFL.imports.length, 0);
});

test("5. MFL RECOVERS: the next tick prices both AS OF THEIR OWN DROP, on the contract each ended", async () => {
  NOW = RealDate.parse("2026-10-27T16:10:00Z");
  MFL.failAllTransactions = false;
  const s = await scan();
  t.equal(s.status, 200, s.text.slice(0, 300));
  t.equal(s.json.acquisition_week_source, "transactions");
  t.equal(s.json.repriced_count, 2); t.equal(s.json.held_unpriced_count, 0);
  const p = rowOf("15000", "0001");
  t.equal(p.penalty_basis, "guarantee_minus_earned");
  t.equal(p.earned_to_date, 1067, "Week-3 contract (15 weeks), 2 eligible completed weeks at his Oct-6 drop — NOT the Week-6 re-acquisition");
  t.equal(p.guaranteed_amount, 6000); t.equal(p.penalty_amount, 4933);
  t.match(p.notes, /Priced .* after being HELD unpriced \(acquisition week 3, 4 completed week\(s\) as of the drop\)/);
  const ship = rowOf("16601", "0008");
  t.equal(ship.earned_to_date, 2538, "Week-5 contract (13 weeks), 3 eligible completed weeks — not 0010's Week-3 contract, not 17 weeks");
  t.equal(ship.guaranteed_amount, 8250); t.equal(ship.penalty_amount, 5712);
  t.equal(rowOf("16601", "0010").penalty_amount, 0, "the earlier Shipley drop is untouched");
  t.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM ups_drop_events").get().n, 3, "re-priced in place — no new rows");
});

test("6. …the drop cards go out ONCE, with the real numbers; nothing ever said 'No Cap Penalty' for either", async () => {
  const before = DISCORD.posts.length;
  const d = await postDiscord();
  t.equal(d.json.posted_count, 2, JSON.stringify(d.json.results).slice(0, 300));
  const fresh = DISCORD.posts.slice(before).map((p) => JSON.stringify(p.body));
  t.ok(fresh.some((b) => /Player, Test|Test Player/.test(b) && /Cap Penalty: \$4\.9K/.test(b)), "15000: $4,933");
  t.ok(fresh.some((b) => /Will Shipley/.test(b) && /Cap Penalty: \$5\.7K/.test(b)), "Shipley: $5,712");
  t.equal(fresh.filter((b) => NO_PENALTY.test(b)).length, 0);
  t.equal(rowOf("15000", "0001").discord_posted, 1); t.equal(rowOf("16601", "0008").discord_posted, 1);
  t.equal((await postDiscord()).json.posted_count, 0, "a second run posts nothing");
});

test("7. …and each becomes exactly ONE booked charge: next season's ledger (in-season drop, canon §6), never this season's MFL cap", async () => {
  const m = await postMfl();
  t.equal(m.status, 200, m.text.slice(0, 300));
  t.equal(MFL.imports.length, 0, "an in-season drop never posts to the 2026 cap");
  const booked = (m.json.deferred_next_season || []).map((r) => [r.ledger_key, r.amount, r.applies_to_season]);
  t.deepEqual(booked.sort(), [[rowOf("15000", "0001").ledger_key, 4933, 2027], [rowOf("16601", "0008").ledger_key, 5712, 2027]].sort());
  t.equal((m.json.held_unpriced || []).length, 0);
  const n = await nextSeason();
  t.equal(n.json.held_unpriced.length, 0);
  t.deepEqual(n.json.rows.map((r) => [r.player_id, r.amount]).sort(), [["15000", 4933], ["16601", 5712]]);
});

test("8. Another tick changes nothing: no re-price, no new row, no second card, still one booked charge each", async () => {
  NOW = RealDate.parse("2026-10-27T16:15:00Z");
  const s = await scan();
  t.equal(s.json.repriced_count, 0); t.equal(s.json.held_unpriced_count, 0);
  const cards = DISCORD.posts.length;
  t.equal((await postDiscord()).json.posted_count, 0); t.equal(DISCORD.posts.length, cards);
  const m = await postMfl();
  t.equal((m.json.deferred_next_season || []).length, 2); t.equal(MFL.imports.length, 0);
  t.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM ups_drop_events").get().n, 3);
  t.equal(rowOf("15000", "0001").penalty_amount, 4933); t.equal(rowOf("16601", "0008").penalty_amount, 5712);
});

test("9. The fire-once rounding true-up refuses to lock a cap year while a drop booking to it is held", async () => {
  const keep = rowOf("15000", "0001");
  db.raw.prepare("UPDATE ups_drop_events SET penalty_basis = 'week_authority_unresolved', penalty_amount = NULL WHERE player_id = '15000'").run();
  const r = await call("POST", "/admin/drops/reconcile-post" + Q + "&force=1", { season: "2027", league_id: "74598" });
  t.equal(r.json.skipped, true, r.text.slice(0, 200)); t.equal(r.json.reason, "held_unpriced_drops"); t.equal(r.json.held_unpriced_count, 1);
  db.raw.prepare("UPDATE ups_drop_events SET penalty_basis = ?, penalty_amount = ? WHERE id = ?").run(keep.penalty_basis, keep.penalty_amount, keep.id);
});

test("10. CONTROL — the same timeline with MFL never down: identical penalties, earned and bases (a hold changes WHEN, never WHAT)", async () => {
  const held = { p: rowOf("15000", "0001"), s: rowOf("16601", "0008"), e: rowOf("16601", "0010") };
  const cdb = makeDb(); env = makeEnv(cdb);
  MFL.failAllTransactions = false;
  NOW = RealDate.parse("2026-10-06T16:05:00Z"); t.equal((await scan()).status, 200);
  NOW = RealDate.parse("2026-10-27T16:05:00Z"); const s = await scan(); t.equal(s.status, 200);
  t.equal(s.json.held_unpriced_count, 0);
  const row = (pid, fid) => ({ ...cdb.raw.prepare("SELECT * FROM ups_drop_events WHERE player_id = ? AND franchise_id = ?").get(pid, fid) });
  for (const [k, pid, fid] of [["p", "15000", "0001"], ["s", "16601", "0008"], ["e", "16601", "0010"]]) {
    const c = row(pid, fid);
    // held rows were priced after the fact; the restored one may lack the earned figure the on-time path could compute (cap-free classes)
    t.equal(c.penalty_amount, held[k].penalty_amount, pid + "/" + fid + " penalty");
    t.equal(c.penalty_basis, held[k].penalty_basis, pid + "/" + fid + " basis");
    if (k !== "e") { t.equal(c.earned_to_date, held[k].earned_to_date, pid + "/" + fid + " earned"); t.equal(c.guaranteed_amount, held[k].guaranteed_amount); }
  }
  env = makeEnv(db);
});

await run("drop_held_unpriced_lifecycle");
globalThis.Date = RealDate;
