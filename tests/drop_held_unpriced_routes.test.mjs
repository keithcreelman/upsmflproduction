// #1202 review findings 2–4 (Keith 2026-10-09), through the REAL routes against one D1 and a stateful fake MFL / Discord / R2:
//   2. /admin/drops/post-discord never posts, recomputes or reposts an UNPRICED drop — not even with repost_ids + recompute.
//      Only the recorder (/admin/drops/scan-and-record) resolves a held row.
//   3. A drop held across Jan 1 stays visible and is still priced — the cron's season is the calendar year, NFL Week 17
//      runs into January, and MFL has not created next year's league yet.
//   4. Overlapping recorder runs: the run that loses the race reports the WINNER's result, with no false held alert.
//   5. (pre-merge review) post-discord's recompute of a PREVIOUS season's held-then-priced row prices it on THAT row's season —
//      Week 1, transactions, acquisition week, the penalty itself and the card's cap-year note — never the poster's season.
//   6. (pre-merge review) cap-free routing of a previous-season held row reads THAT season's MFL designations.
//   node tests/drop_held_unpriced_routes.test.mjs
import fs from "node:fs";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;

const RealDate = Date;
let NOW = RealDate.parse("2026-10-27T16:05:00Z");
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const ET = (iso) => String(Math.floor(RealDate.parse(iso) / 1000));

// ── MFL, per league year. 2027 does not exist yet (MFL creates the next league year at its rollover). ──
const YEARS = {
  "2026": { failAll: false, txs: [
    { type: "BBID_WAIVER", franchise: "0008", timestamp: ET("2026-10-08T09:00:00-04:00"), transaction: "16601,|11000|" },
    { type: "FREE_AGENT", franchise: "0008", timestamp: ET("2026-10-27T12:00:00-04:00"), transaction: "|16601," },          // held (A)
    { type: "FREE_AGENT", franchise: "0010", timestamp: ET("2026-10-27T12:01:00-04:00"), transaction: "|17469," },          // no pre-drop contract (A)
    { type: "BBID_WAIVER", franchise: "0005", timestamp: ET("2026-12-24T09:00:00-04:00"), transaction: "18000,|20000|" },   // Week 16 pickup
    { type: "FREE_AGENT", franchise: "0005", timestamp: ET("2026-12-29T12:00:00-05:00"), transaction: "|18000," },          // held across Jan 1 (B)
    { type: "BBID_WAIVER", franchise: "0005", timestamp: ET("2026-12-17T09:00:00-05:00"), transaction: "18001,|20000|" },   // Week 15 pickup
    { type: "FREE_AGENT", franchise: "0005", timestamp: ET("2026-12-26T12:00:00-05:00"), transaction: "|18001," },          // priced on time (5d)
  ] },
};
const ww = (id, k) => ({ id, salary: String(k * 1000), status: "ROSTER", contractStatus: "Vet-WW", contractInfo: `CL 1| TCV ${k}K| AAV ${k}K`, contractYear: "1" });
function snapshotFor(day) {           // 17469 is never in a snapshot (claimed and dropped between two of them)
  const fr = {};
  const add = (fid, p) => (fr[fid] = fr[fid] || []).push(p);
  if (day >= "2026-10-08" && day <= "2026-10-27") add("0008", ww("16601", 11));
  if (day >= "2026-12-24" && day <= "2026-12-29") add("0005", ww("18000", 20));
  if (day >= "2026-12-17" && day <= "2026-12-26") add("0005", ww("18001", 20));
  return { rosters: { franchise: Object.entries(fr).map(([id, player]) => ({ id, player })) } };
}
function nflSchedule(w, year) {       // 2026: Wed Sep 9 opener, then Thu 8:15 PM ET / Sun 1 PM / Mon 8:15 PM ET; 2027 = +52 weeks
  const shift = (Number(year || 2026) - 2026) * 364 * 86400;
  const ko = (d, h, m) => String(Math.floor(RealDate.UTC(2026, 8, d, h, m) / 1000) + shift);
  const thu = w === 1 ? ko(10, 0, 20) : ko(18 + 7 * (w - 2), 0, 15), sun = ko(13 + 7 * (w - 1), 17, 0), mon = ko(15 + 7 * (w - 1), 0, 15);
  return { nflSchedule: { week: String(w), matchup: [{ kickoff: thu, team: [{ id: "KCC" }, { id: "BAL" }] }, { kickoff: sun, team: [{ id: "BUF" }, { id: "MIA" }] }, { kickoff: mon, team: [{ id: "NYG" }, { id: "DAL" }] }] } };
}
const liveWeek = () => { let w = 1; for (let k = 1; k <= 18; k++) if (Number(nflSchedule(k).nflSchedule.matchup[0].kickoff) * 1000 <= NOW) w = k; return w; };
const DISCORD = { posts: [] };
const EXPORTS = [];
const NEWS = [];   // /api/player-news reads — the cap-free routing's budgeted fallback when MFL's designation can't be read
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });
globalThis.fetch = async (input, init) => {
  const u = new URL(typeof input === "string" ? input : input.url);
  if (u.hostname === "discord.com") {
    if ((init?.method || "GET") === "POST" && /\/messages$/.test(u.pathname)) { DISCORD.posts.push(JSON.parse(init.body || "{}")); return json({ id: "msg" + DISCORD.posts.length }); }
    return json({ id: "thr" + RealDate.now() });
  }
  if (/myfantasyleague\.com$/.test(u.hostname)) {
    if (/\/import$/.test(u.pathname)) return new Response("<status>OK</status>", { status: 200 });
    const year = (u.pathname.match(/\/(\d{4})\//) || [])[1];
    const type = u.searchParams.get("TYPE");
    EXPORTS.push(year + ":" + type + (u.searchParams.get("TRANS_TYPE") ? ":" + u.searchParams.get("TRANS_TYPE") : ""));
    if (type === "nflSchedule") return json(nflSchedule(Number(u.searchParams.get("W")), Number(year)));
    const Y = YEARS[year];
    if (!Y) return json({ error: "No league " + year }, 500);            // next year's league does not exist yet
    if (type === "transactions") {
      const tt = u.searchParams.get("TRANS_TYPE");
      if (!tt && Y.failAll) return json({ error: "MFL boom" }, 500);
      return json({ transactions: { transaction: Y.txs.filter((x) => Number(x.timestamp) <= NOW / 1000 && (!tt || x.type === tt)) } });
    }
    if (type === "liveScoring") return json({ liveScoring: { week: String(liveWeek()) } });
    if (type === "players") return json({ players: { player: [{ id: "16601", name: "Shipley, Will", position: "RB", team: "PHI" }, { id: "17469", name: "Daniels, Jalon", position: "QB", team: "TBB" }, { id: "18000", name: "Pickup, Late", position: "WR", team: "KCC" }, { id: "18001", name: "Pickup, Early", position: "WR", team: "KCC" }] } });
    if (type === "league") return json({ league: { franchises: { franchise: [["0005", "HammerTime"], ["0008", "Real Deal Creel"], ["0010", "Blake Bombers"]].map(([id, name]) => ({ id, name, email: id + "@ups.test" })) } } });
    if (type === "injuries") return json({ injuries: { injury: Y.injuries || [] } });
    if (type === "salaryAdjustments") return json({ salaryAdjustments: { salaryAdjustment: [] } });
    return json({ error: "test: no such export " + type }, 503);
  }
  if (u.pathname === "/api/player-news") NEWS.push(u.search);
  return json({ error: "test: no such call " + u.hostname }, 503);
};

function makeDb(opts) {
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
  if (opts && opts.capfree) {
    for (const c of ["capfree_route TEXT", "capfree_review_status TEXT", "capfree_mfl_designation TEXT", "capfree_evidence_json TEXT",
                     "capfree_settlement_amount INTEGER", "capfree_decided_at_utc TEXT", "capfree_decided_by TEXT"]) db.raw.exec(`ALTER TABLE ups_drop_events ADD COLUMN ${c}`);
  }
  db.raw.exec("CREATE TABLE ups_faa_nom_penalties (penalty_id TEXT, season INTEGER, league_id TEXT, fid TEXT, et_day TEXT, offense_no INTEGER, amount_k INTEGER, applies_to_season INTEGER, voided INTEGER DEFAULT 0, posted_to_mfl INTEGER DEFAULT 0)");
  return db;
}
const r2 = { async get(key) {
  const m = /^snapshots\/(\d{4}-\d{2}-\d{2})\/rosters\.json$/.exec(key);
  return m ? { async text() { return JSON.stringify(snapshotFor(m[1])); }, uploaded: new RealDate(`${m[1]}T09:05:00.000Z`) } : null;
} };
const makeEnv = (d) => ({ UPS_MFL_DB: d, UPS_MFL_BACKUPS: r2, COMMISH_API_KEY: "admin", MFL_COOKIE: "COMMISH", MFL_APIKEY: "k",
  FA_AUCTION_START_AT: String(ET("2026-07-25T12:00:00-04:00")), DISCORD_BOT_TOKEN: "bot", DISCORD_DROPS_TEST_CHANNEL_ID: "999" });
async function call(env, method, path, body) {
  const res = await worker.fetch(new Request("https://w.test" + path, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }),
    env, { waitUntil() {}, passThroughOnException() {} });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  return { status: res.status, json: j, text };
}
const Q = (y) => `?L=74598&YEAR=${y}&APIKEY=admin`;
const scan = (env, y) => call(env, "POST", "/admin/drops/scan-and-record" + Q(y), { season: y, league_id: "74598", days: 40, include_waivers: true });
const postDiscord = (env, y, extra) => call(env, "POST", "/admin/drops/post-discord" + Q(y), { season: y, league_id: "74598", target: "test", limit: 20, ...(extra || {}) });
const postMfl = (env, y) => call(env, "POST", "/admin/drops/post-mfl" + Q(y), { season: y, league_id: "74598", limit: 20 });
const rowOf = (db, pid) => ({ ...db.raw.prepare("SELECT * FROM ups_drop_events WHERE player_id = ?").get(pid) });

// ═════════ 2. post-discord: never posts, recomputes or reposts an unpriced drop ═════════
const dbA = makeDb(), envA = makeEnv(dbA);
test("2a. setup — MFL's transactions export down on Tue 10-27: Shipley's drop is HELD; Jalon Daniels has NO pre-drop contract", async () => {
  NOW = RealDate.parse("2026-10-27T16:05:00Z"); YEARS["2026"].failAll = true;
  const s = await scan(envA, "2026");
  t.equal(s.status, 200, s.text.slice(0, 300));
  t.equal(rowOf(dbA, "16601").penalty_basis, "week_authority_unresolved");
  t.equal(rowOf(dbA, "17469").penalty_basis, "no_pre_drop_contract"); t.equal(rowOf(dbA, "17469").penalty_amount, null);
});
test("2b. post-discord, default run: neither unpriced drop is posted; both are listed with their reason", async () => {
  const before = DISCORD.posts.length;
  const d = await postDiscord(envA, "2026");
  t.equal(d.status, 200, d.text.slice(0, 300));
  t.equal(DISCORD.posts.length, before, "no Discord card at all");
  const why = Object.fromEntries((d.json.held_unpriced || []).map((h) => [h.player_id, h.reason]));
  t.match(why["16601"], /^held_unpriced: the recorder prices it/); t.match(why["17469"], /^unpriced_needs_review: no_pre_drop_contract/);
  // …and the */5 cron says so out loud for the no-contract drop (the held one is already alerted from the recorder's count)
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  t.match(src, /const needsReview = \(postData\?\.held_unpriced \|\| \[\]\)\.filter\(\(h\) => \/\^unpriced_needs_review\/[\s\S]{0,80}if \(needsReview\.length\) \{\s*console\.error\(/);
});
test("2c. post-discord with repost_ids + recompute: REFUSED for both — nothing posted, nothing recomputed, both rows byte-identical", async () => {
  const ids = [rowOf(dbA, "16601").id, rowOf(dbA, "17469").id];
  const snap = ids.map((id) => ({ ...dbA.raw.prepare("SELECT * FROM ups_drop_events WHERE id = ?").get(id) }));
  YEARS["2026"].failAll = false;                       // even with MFL readable again — only the RECORDER may resolve a held row
  NOW = RealDate.parse("2026-10-28T16:00:00Z");        // a Wednesday: the recompute's kickoff walk would have priced Shipley a week short
  const before = DISCORD.posts.length;
  const d = await postDiscord(envA, "2026", { repost_ids: ids, recompute: true });
  t.equal(d.json.posted_count, 0); t.equal(DISCORD.posts.length, before);
  t.deepEqual(d.json.results.map((r) => [r.row_id, r.held]), ids.map((id) => [id, true]));
  ids.forEach((id, i) => t.deepEqual({ ...dbA.raw.prepare("SELECT * FROM ups_drop_events WHERE id = ?").get(id) }, snap[i], "row " + id + " untouched"));
});
test("2d. only the RECORDER resolves the held row (as of its drop: $5,712); its card then goes out ONCE. The no-contract row stays unposted until a contract is verified", async () => {
  const s = await scan(envA, "2026");
  t.equal(s.json.repriced_count, 1); t.equal(rowOf(dbA, "16601").penalty_amount, 5712, "the recorder's own price (Week 7 complete at the Tue drop)");
  const before = DISCORD.posts.length;
  const d = await postDiscord(envA, "2026");
  t.equal(d.json.posted_count, 1); t.equal(DISCORD.posts.length, before + 1);
  t.match(JSON.stringify(DISCORD.posts.at(-1)), /Drop: Will Shipley/); t.match(JSON.stringify(DISCORD.posts.at(-1)), /Cap Penalty: \$5\.7K/);
  t.equal((await postDiscord(envA, "2026")).json.posted_count, 0, "never twice");
  t.equal(rowOf(dbA, "17469").discord_posted, 0, "the no-contract drop is still unposted — never announced as 'No Cap Penalty'");
  // a commissioner verifies his contract (the Oct-1 Jalon Daniels correction, in miniature): only then does the card go out
  dbA.raw.prepare("UPDATE ups_drop_events SET pre_drop_contract_status='Rookie-WW', pre_drop_salary=4000, pre_drop_contract_year=1, pre_drop_contract_info='CL 1| TCV 4K| AAV 4K', penalty_amount=0, penalty_basis='ww_under_5k_earned_na', penalty_exempt=1 WHERE player_id='17469'").run();
  const d2 = await postDiscord(envA, "2026");
  t.equal(d2.json.posted_count, 1); t.match(JSON.stringify(DISCORD.posts.at(-1)), /Drop: Jalon Daniels[\s\S]*No Cap Penalty/);
});

// ═════════ 3. a drop held across Jan 1 ═════════
const dbB = makeDb(), envB = makeEnv(dbB);
const ALL_2026 = YEARS["2026"].txs;
const only = (...pids) => ALL_2026.filter((x) => pids.some((p) => x.transaction.includes(p + ",")));
test("3a. Tue 12-29-2026, MFL's 2026 transactions down: HammerTime's $20K Week-16 pickup is dropped → HELD (season 2026)", async () => {
  YEARS["2026"].txs = only("18000");
  NOW = RealDate.parse("2026-12-29T17:05:00Z"); YEARS["2026"].failAll = true;
  const s = await scan(envB, "2026");
  t.equal(s.status, 200, s.text.slice(0, 300));
  t.equal(rowOf(dbB, "18000").penalty_basis, "week_authority_unresolved"); t.equal(rowOf(dbB, "18000").season, "2026");
});
test("3b. Sat 1-2-2027, the cron now runs season 2027 and MFL has NO 2027 league yet: the 2026 hold is still visible everywhere", async () => {
  NOW = RealDate.parse("2027-01-02T17:00:00Z");
  const s = await scan(envB, "2027");
  t.equal(s.status, 502, "the 2027 new-drop pull fails — MFL has not created 2027");
  t.equal(s.json.held_unpriced_count, 1); t.equal(s.json.held_unpriced[0].season, "2026"); t.equal(s.json.held_unpriced[0].reason, "acquisition_week_unresolved");
  const d = await postDiscord(envB, "2027");
  t.ok((d.json.held_unpriced || []).some((h) => h.player_id === "18000" && h.season === "2026"), "post-discord (2027) lists it");
  const n = await call(envB, "GET", "/api/cap-adjustments/next-season?L=74598&YEAR=2026");
  t.deepEqual(n.json.rows, [], "nothing booked for it yet"); t.deepEqual(n.json.held_unpriced.map((h) => h.player_id), ["18000"], "the ledger shows it HELD, not $0");
  // post-mfl (2027) in January: the 2027 FA Auction date is not on the calendar yet, so it refuses outright (fail closed, pre-existing)…
  const m = await postMfl(envB, "2027");
  t.equal(m.json.error, "auction_start_unresolved"); t.equal(m.json.posted_count, 0);
  // …and once the date is set and MFL has created the 2027 league, the 2026 hold is still listed there — never charged
  YEARS["2027"] = { failAll: false, txs: [] };
  const m2 = await postMfl({ ...envB, FA_AUCTION_START_AT: String(ET("2027-07-24T12:00:00-04:00")) }, "2027");
  delete YEARS["2027"];
  t.equal(m2.json.posted, 0, m2.text.slice(0, 200));
  t.ok((m2.json.held_unpriced || []).some((h) => h.player_id === "18000" && h.season === "2026"), "post-mfl (2027) lists it: " + m2.text.slice(0, 200));
  t.equal(rowOf(dbB, "18000").posted_to_mfl, 0);
});
test("3c. MFL's 2026 export recovers: the 2027-season recorder run prices the 2026 drop anyway — as of Dec 29, on 2026's own data", async () => {
  YEARS["2026"].failAll = false; NOW = RealDate.parse("2027-01-02T17:10:00Z");
  const s = await scan(envB, "2027");
  t.equal(s.status, 502, "the 2027 pull still fails — and does not block the re-price");
  t.equal(s.json.repriced_count, 1); t.equal(s.json.repriced[0].season, "2026"); t.equal(s.json.held_unpriced_count, 0);
  const r = rowOf(dbB, "18000");
  // Week-16 pickup: Weeks 16–17 = 2 eligible; Week 16 ended Monday 12-28 → 1 eligible completed: earned 10,000, penalty 15,000 − 10,000
  t.equal(r.earned_to_date, 10000); t.equal(r.guaranteed_amount, 15000); t.equal(r.penalty_amount, 5000); t.equal(r.penalty_basis, "guarantee_minus_earned");
  t.ok(r.notes.includes("[repriced-after-hold]"));
});
test("3d. …its card goes out ONCE from the 2027 poster, and it is ONE booked charge in 2026's next-season ledger", async () => {
  const before = DISCORD.posts.length;
  const d = await postDiscord(envB, "2027");
  t.equal(d.json.posted_count, 1); t.match(JSON.stringify(DISCORD.posts.at(-1)), /Drop: Late Pickup[\s\S]*Cap Penalty: \$5K/);
  // the card's cap-year note is judged on the row's OWN season (2026's FA Auction): a 2027 cap charge, ledger-only — never
  // "could not be resolved" because the 2027 auction date isn't on the calendar yet
  t.match(JSON.stringify(DISCORD.posts.at(-1)), /applies to the \*\*2027\*\* cap/); t.ok(!/could not be resolved/.test(JSON.stringify(DISCORD.posts.at(-1))));
  t.equal((await postDiscord(envB, "2027")).json.posted_count, 0); t.equal(DISCORD.posts.length, before + 1);
  const n = await call(envB, "GET", "/api/cap-adjustments/next-season?L=74598&YEAR=2026");
  t.deepEqual(n.json.rows.map((x) => [x.player_id, x.amount, x.applies_to_season]), [["18000", 5000, 2027]]);
  t.deepEqual(n.json.held_unpriced, []);
});

// ═════════ 4. overlapping recorder runs ═════════
test("4. two overlapping recorder runs: ONE prices the held drop; the other reports the winner's result — no false held alert", async () => {
  const dbC = makeDb(), envC = makeEnv(dbC);
  YEARS["2026"].txs = only("16601");
  NOW = RealDate.parse("2026-10-27T16:05:00Z"); YEARS["2026"].failAll = true;
  await scan(envC, "2026");
  t.equal(rowOf(dbC, "16601").penalty_basis, "week_authority_unresolved");
  YEARS["2026"].failAll = false; NOW = RealDate.parse("2026-10-27T16:10:00Z");
  // Run B's held-row UPDATE is held back until run A has finished — B read the row while it was still held.
  let releaseB; const gate = new Promise((r) => (releaseB = r));
  const gatedDb = { ...dbC, prepare(sql) {
    const st = dbC.prepare(sql);
    if (!/UPDATE ups_drop_events\s+SET earned_to_date = \?/.test(sql)) return st;
    return { ...st, bind: (...a) => { const w = st.bind(...a); return { ...w, run: async () => { await gate; return w.run(); } }; } };
  } };
  const envB2 = { ...envC, UPS_MFL_DB: gatedDb };
  const pB = scan(envB2, "2026");
  const a = await scan(envC, "2026");
  releaseB();
  const b = await pB;
  t.equal(a.json.repriced_count, 1); t.equal(a.json.repriced[0].penalty_amount, 5712);
  t.equal(b.json.repriced_count, 0); t.equal(b.json.held_unpriced_count, 0, "no false hold → the cron logs no HELD alert");
  t.deepEqual(b.json.repriced_by_other_run.map((x) => [x.pid, x.penalty_amount, x.penalty_basis]), [["16601", 5712, "guarantee_minus_earned"]], "the WINNER's result");
  t.equal(dbC.raw.prepare("SELECT COUNT(*) AS n FROM ups_drop_events WHERE player_id = '16601'").get().n, 1);
  // the alert the */5 cron raises is exactly held_unpriced_count > 0
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  t.match(src, /const heldN = Number\(scanData\?\.held_unpriced_count\) \|\| 0;[\s\S]{0,120}if \(heldN\) \{\s*console\.error\(`\[scheduled \*\/5\] drop-tracker: \$\{heldN\} drop\(s\) HELD unpriced/);
});

// ═════════ 5. post-discord recompute of a previous season's held-then-priced row ═════════
// The 3a–3c timeline, fresh each time: a $20K Week-16 pickup dropped Tue 12-29-2026 while MFL's 2026 transactions were down
// (held), then priced by the 2027-season recorder on Sat 1-2-2027 at $5,000 — not yet announced.
async function heldThenPricedAcrossJan1(dbOpts) {
  const db = makeDb(dbOpts), env = makeEnv(db);
  YEARS["2026"].txs = only("18000"); YEARS["2026"].failAll = true; delete YEARS["2027"];
  NOW = RealDate.parse("2026-12-29T17:05:00Z");
  await scan(env, "2026");
  YEARS["2026"].failAll = false; NOW = RealDate.parse("2027-01-02T17:10:00Z");
  const s = await scan(env, "2027");
  return { db, env, s };
}
const priced = (r) => [r.penalty_amount, r.earned_to_date, r.guaranteed_amount, r.penalty_basis];
test("5a. January (no 2027 league yet): post-discord(2027) with recompute:true re-prices the 2026 row on 2026 — $5,000 stands, card once, 2027-cap note", async () => {
  const { db, env } = await heldThenPricedAcrossJan1();
  t.deepEqual(priced(rowOf(db, "18000")), [5000, 10000, 15000, "guarantee_minus_earned"]);
  const n0 = DISCORD.posts.length;
  const d = await postDiscord(env, "2027", { recompute: true });
  t.equal(d.json.posted_count, 1, d.text.slice(0, 300));
  t.deepEqual(priced(rowOf(db, "18000")), [5000, 10000, 15000, "guarantee_minus_earned"], "NOT re-priced on 2027's calendar (0 weeks earned → the full $15,000)");
  const card = JSON.stringify(DISCORD.posts.at(-1));
  t.match(card, /Cap Penalty: \$5K/); t.match(card, /applies to the \*\*2027\*\* cap/); t.ok(!/could not be resolved/.test(card));
  t.equal((await postDiscord(env, "2027", { recompute: true })).json.posted_count, 0); t.equal(DISCORD.posts.length, n0 + 1);
});
test("5b. after MFL creates the 2027 league: the same recompute still prices it on 2026's transactions + calendar", async () => {
  const { db, env } = await heldThenPricedAcrossJan1();
  YEARS["2027"] = { failAll: false, txs: [] };
  const ex0 = EXPORTS.length;
  const d = await postDiscord(env, "2027", { recompute: true });
  delete YEARS["2027"];
  t.equal(d.json.posted_count, 1, d.text.slice(0, 300));
  t.deepEqual(priced(rowOf(db, "18000")), [5000, 10000, 15000, "guarantee_minus_earned"]);
  t.ok(EXPORTS.slice(ex0).includes("2026:transactions"), "the recompute read 2026's transactions: " + EXPORTS.slice(ex0).join(" "));
  t.ok(!EXPORTS.slice(ex0).includes("2027:transactions"), "…not 2027's");
  t.match(JSON.stringify(DISCORD.posts.at(-1)), /Cap Penalty: \$5K/);
});
test("5c. 2026's transactions unreadable at recompute time: the recompute is skipped, the verified $5,000 stands and the card still posts once", async () => {
  const { db, env } = await heldThenPricedAcrossJan1();
  YEARS["2026"].failAll = true;
  const d = await postDiscord(env, "2027", { recompute: true });
  YEARS["2026"].failAll = false;
  t.equal(d.json.posted_count, 1, d.text.slice(0, 300));
  t.deepEqual(priced(rowOf(db, "18000")), [5000, 10000, 15000, "guarantee_minus_earned"]);
  t.match(JSON.stringify(DISCORD.posts.at(-1)), /Cap Penalty: \$5K/);
  t.equal(rowOf(db, "18000").discord_posted, 1);
});

test("5d. an explicit repost of a NORMAL (never held) 2026 row from the 2027 poster recomputes it on 2026 too — $8,333 stands", async () => {
  const db = makeDb(), env = makeEnv(db);
  YEARS["2026"].txs = only("18001"); YEARS["2026"].failAll = false; delete YEARS["2027"];
  NOW = RealDate.parse("2026-12-26T17:05:00Z");           // Sat 12-26: Week 15 complete, Week 16 under way
  await scan(env, "2026");
  // Week-15 pickup: Weeks 15–17 = 3 eligible, 1 completed → earned round(20,000 / 3) = 6,667; penalty 15,000 − 6,667
  t.deepEqual(priced(rowOf(db, "18001")), [8333, 6667, 15000, "guarantee_minus_earned"]);
  NOW = RealDate.parse("2027-01-02T17:10:00Z");
  const ex0 = EXPORTS.length;
  const d = await postDiscord(env, "2027", { repost_ids: [rowOf(db, "18001").id], recompute: true });
  t.equal(d.json.posted_count, 1, d.text.slice(0, 300));
  t.deepEqual(priced(rowOf(db, "18001")), [8333, 6667, 15000, "guarantee_minus_earned"], "not 2027's 0 weeks → $15,000");
  t.ok(EXPORTS.slice(ex0).includes("2026:transactions") && !EXPORTS.slice(ex0).includes("2027:transactions"), EXPORTS.slice(ex0).join(" "));
  t.match(JSON.stringify(DISCORD.posts.at(-1)), /Cap Penalty: \$8\.3K[\s\S]*applies to the \*\*2027\*\* cap/);
});

// ═════════ 6. cap-free routing of a previous season's held row ═════════
test("6. a 2026 held drop priced in January takes its cap-free routing from 2026's MFL designations (RETIRED) — no 2027 read, no news-budget fallback", async () => {
  YEARS["2026"].injuries = [{ id: "18000", status: "Retired" }];
  const ex0 = EXPORTS.length, news0 = NEWS.length;
  const { db, s } = await heldThenPricedAcrossJan1({ capfree: true });
  delete YEARS["2026"].injuries;
  t.equal(s.json.repriced_count, 1, s.text.slice(0, 300));
  const r = rowOf(db, "18000");
  t.equal(r.capfree_mfl_designation, "RETIRED", "read from 2026's injuries export");
  t.equal(r.capfree_route, "auto");
  t.equal(r.capfree_decided_by, "auto:mfl_retired_flag");
  t.equal(NEWS.length, news0, "no player-news lookup: the designation answered (the news path is budgeted — 5 per run — and a miss is never re-routed)");
  const janExports = EXPORTS.slice(ex0);
  t.ok(janExports.includes("2026:injuries"), janExports.join(" "));
  t.ok(!janExports.includes("2027:injuries"), "never 2027's (no 2027 league in January): " + janExports.join(" "));
});

await run("drop_held_unpriced_routes");
globalThis.Date = RealDate;
