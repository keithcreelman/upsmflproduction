// #1237 / #1289: the phone and the worker take the season from MFL's ACTIVE season (worker/src/league_year.js
// resolveActiveSeason — its rule and Week 17 finality are tested in season_active_finality.test.mjs, #1301), never the
// calendar; when it can't be resolved, they fail visibly or skip — they never guess.
//  1. The worker's read routes the phone and Game Day call without a season (GET /api/active-season, Lineup's week,
//     "which team am I").
//  2. WRITE routes resolve the season AFTER their own credential checks: no credentials → the same 401, no MFL read;
//     credentials + MFL unreadable → 503 season_unresolved and nothing written; a named season is used as given.
//  3. The cron jobs (scheduled()): every season-dependent job runs as the active season, or skips loudly.
//  4. The phone (site/m/app.js): detectContext + fetchSeason + the real loadAllData (sliced, node:vm).
// A fake MFL plays 2026 Week 17 by its REAL kickoffs (tests/fixtures/nfl_schedule_2026_wk17.json). Nothing here writes
// to a real service: every outbound request is a stub, imports/POSTs to MFL are recorded and refused.
//   node tests/mobile_season_from_mfl.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, t, run } from "./fixtures/mini_test.mjs";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.isAbsolute(p) ? p : path.join(ROOT, p), "utf8");
const APP = read(process.env.APP_JS || "site/m/app.js");
const WORKER = read("worker/src/index.js");
const WK17 = JSON.parse(read("tests/fixtures/nfl_schedule_2026_wk17.json"));
const LAST = Math.max(...WK17.games.map((g) => g.kickoff * 1000));
const H = 3600e3, GAME = 3.25 * H, LAG = 20 * 60e3;
const JAN2 = Date.parse("2027-01-02T18:00:00Z");
const NOT_FOUND_HTML = "<H1>Not Found</H1>\n<p>The requested URL was not found on this server.</p>\n";
function sliceFn(src, sig) {
  const at = src.indexOf(sig);
  if (at < 0) throw new Error("no " + sig);
  let depth = 0, i = src.indexOf("{", at);
  for (; i < src.length; i++) { if (src[i] === "{") depth++; else if (src[i] === "}" && --depth === 0) return src.slice(at, i + 1); }
  throw new Error("unbalanced: " + sig);
}
const settle = async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); };

// ── The fake MFL + network, at a fake clock ─────────────────────────────────────────────────────────────────────────
// o.renewed: the 2027 league exists (created early). o.down: true = every league export answers 500.
function network(o, now) {
  const hist = (upto) => Array.from({ length: upto - 2009 }, (_, i) => ({ year: String(2010 + i) }));
  const res = (status, body) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const game = (g, shift) => {
    const ko = g.kickoff * 1000 + shift, live = now >= ko && now < ko + GAME, over = now >= ko + GAME;
    return { kickoff: String(Math.floor(ko / 1000)), gameSecondsRemaining: over ? "0" : (live ? "900" : "3600"),
      team: g.teams.map((id, i) => ({ id, score: now >= ko ? String(20 - i) : "", hasPossession: live && i === 0 ? "1" : "0" })) };
  };
  const calls = [];
  const fetch = async (input, init) => {
    const u = new URL(typeof input === "string" ? input : input.url), method = (init && init.method) || (typeof input === "object" && input.method) || "GET";
    calls.push(method + " " + u.href);
    if (!/myfantasyleague\.com$/.test(u.hostname)) return res(503, { error: "test: no such call " + u.hostname });
    if (/\/import$/.test(u.pathname) || method !== "GET") return res(403, { error: "test: MFL writes are refused here" });
    const y = Number((u.pathname.match(/\/(\d{4})\//) || [])[1]), T = u.searchParams.get("TYPE"), w = Number(u.searchParams.get("W") || 0), L = u.searchParams.get("L") || "74598";
    const shift = y === 2026 ? 0 : -364 * 24 * H;
    if (T === "league") {
      if (o.down) return res(500, "MFL error");
      if (y === 2027 && !o.renewed) return new Response(NOT_FOUND_HTML, { status: 404 });
      if (y < 2010 || y > 2027) return new Response(NOT_FOUND_HTML, { status: 404 });
      return res(200, { league: { id: L, endWeek: "17", history: { league: hist(y === 2027 || o.renewed ? 2027 : 2026) } } });
    }
    if (T === "nflSchedule") {
      if (w === 17) return res(200, { nflSchedule: { week: "17", matchup: WK17.games.map((g) => game(g, shift)) } });
      return res(200, { nflSchedule: { week: String(w), matchup: [] } });
    }
    if (T === "playerScores") {
      const rows = WK17.games.filter((g) => now >= g.kickoff * 1000 + shift + GAME + LAG).flatMap((g) => g.teams.map((tm) => ({ id: "P_" + tm, score: "9" })));
      return res(200, { playerScores: { week: String(w), playerScore: rows } });
    }
    if (T === "players") return res(200, { players: { player: WK17.games.flatMap((g) => g.teams.map((tm) => ({ id: "P_" + tm, team: tm, position: "PK" }))) } });
    if (T === "liveScoring") return res(200, { liveScoring: { week: String(w || 17) } });
    if (T === "myleagues") {   // a real season only (MFL answers Not Found for anything else); 2027 lists leagues once renewed
      if (!(y >= 2010 && y <= 2027)) return new Response(NOT_FOUND_HTML, { status: 404 });
      if (y === 2027 && !o.renewed) return res(200, { leagues: {} });
      return res(200, { leagues: { league: Array.from({ length: 60 }, (_, i) => ({ league_id: String(74598 + i), franchise_id: "0003", name: "UPS" })) } });
    }
    if (T === "transactions") return res(200, { transactions: {} });
    return res(404, NOT_FOUND_HTML);
  };
  return { fetch, calls, mfl: () => calls.filter((c) => /myfantasyleague/.test(c)) };
}
await import("./fixtures/register_md_loader.mjs");
const worker = (await import("../worker/src/index.js")).default;
const RealDate = globalThis.Date, realFetch = globalThis.fetch;
// The worker remembers the active season per league for 10 minutes (and a season it proved complete for good), so each
// case below uses a league id of its own and can run at any moment — the fake MFL echoes whichever league is asked.
let nextLeague = 74599;
const newLeague = () => String(nextLeague++);
async function withWorld(o, now, fn) {
  const net = network(o, now);
  globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [now])); } static now() { return now; } };
  globalThis.fetch = net.fetch;
  try { return await fn(net); } finally { globalThis.Date = RealDate; globalThis.fetch = realFetch; }
}
const call = (pathQs, init, env) => worker.fetch(new Request("https://w.test" + pathQs, init), env || {}, { waitUntil() {}, passThroughOnException() {} })
  .then(async (r) => ({ status: r.status, json: await r.json().catch(() => null) }));

// ── 1. read routes ──
test("GET /api/active-season — Jan 2 with 2027 created early → 2026 (Week 17 not final); after MNF is final and scored → 2027", async () => {
  const L = newLeague();
  await withWorld({ renewed: true }, JAN2, async () => {
    const r = await call("/api/active-season?L=" + L);
    t.equal(r.status, 200); t.equal(r.json.season, "2026"); t.match(r.json.source, /^season_2026_not_complete:w17:/);
  });
  await withWorld({ renewed: true }, LAST + GAME + LAG + 11 * 60e3, async () => {
    const r = await call("/api/active-season?L=" + L);
    t.equal(r.json.season, "2027", JSON.stringify(r.json));
  });
});
test("a read that names no season (Lineup's week, \"which team am I\") reads the active season's league: 2026 on Jan 2 with 2027 created early (the calendar said 2027)", async () => {
  await withWorld({ renewed: true }, JAN2, async (net) => {
    await call("/api/current-lineup-week?L=" + newLeague());
    const live = net.calls.filter((c) => /TYPE=liveScoring/.test(c) && !/W=17/.test(c));
    t.ok(live.length > 0 && live.every((c) => /\/2026\/export/.test(c)), net.calls.join("\n"));
  });
  await withWorld({ renewed: true }, JAN2, async (net) => {
    await call("/api/me?MFL_USER_ID=tok&L=" + newLeague());
    t.ok(net.calls.some((c) => /\/2026\/export\?TYPE=myleagues/.test(c)) && !net.calls.some((c) => /\/2027\/export\?TYPE=myleagues/.test(c)), net.calls.join("\n"));
  });
});
test("(d) MFL unreadable → 503 season_unresolved with the reason for every read route that names no season; a named YEAR still works", async () => {
  await withWorld({ down: true }, LAST + 10 * 24 * H, async (net) => {
    for (const p of ["/api/active-season", "/api/current-lineup-week", "/api/me?MFL_USER_ID=tok", "/api/lineup?W=17"].map((q) => q + (q.includes("?") ? "&" : "?") + "L=" + newLeague())) {
      const r = await call(p);
      t.ok(r.status === 503 && r.json.error === "season_unresolved" && /unreadable/.test(r.json.reason), p + " → " + JSON.stringify(r));
    }
    const named = await call("/api/current-lineup-week?YEAR=2026&L=" + newLeague());
    t.equal(named.status, 200, JSON.stringify(named.json));
    t.ok(net.calls.every((c) => c.startsWith("GET ")), "reads only");
  });
});

// ── 2. writes: the season after the credential check ──
test("POST /api/submit-lineup: no credentials → the same 401 and NO MFL read at all, even with MFL down", async () => {
  await withWorld({ down: true }, LAST + 11 * 24 * H, async (net) => {
    const r = await call("/api/submit-lineup?L=" + newLeague(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ franchiseId: "0003", starters: ["1"] }) });
    t.equal(r.status, 401); t.match(r.json.error, /MFL_USER_ID/);
    t.deepEqual(net.mfl(), [], "no MFL request for a caller without credentials");
  });
});
test("POST /api/submit-lineup with credentials, MFL unreadable → 503 season_unresolved; nothing imported", async () => {
  await withWorld({ down: true }, LAST + 12 * 24 * H, async (net) => {
    const r = await call("/api/submit-lineup?MFL_USER_ID=tok&L=" + newLeague(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ franchiseId: "0003", starters: ["1"] }) });
    t.equal(r.status, 503); t.equal(r.json.error, "season_unresolved");
    t.ok(!net.calls.some((c) => /\/import/.test(c)), "no import");
  });
});
test("POST /api/submit-lineup with credentials on Jan 2 (2027 created early): the identity check reads 2026's myleagues; a franchise mismatch stops it (403) — nothing imported", async () => {
  await withWorld({ renewed: true }, JAN2, async (net) => {
    const r = await call("/api/submit-lineup?MFL_USER_ID=tok&L=" + newLeague(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ franchiseId: "0008", starters: ["1"] }) });
    t.equal(r.status, 403, JSON.stringify(r.json));
    t.ok(net.calls.some((c) => /\/2026\/export\?TYPE=myleagues/.test(c)) && !net.calls.some((c) => /\/2027\/export\?TYPE=myleagues/.test(c)), net.calls.join("\n"));
    t.ok(!net.calls.some((c) => /\/import/.test(c)), "no import");
  });
});
test("POST /api/submit-trade-bait: no credentials → 401, no MFL read; credentials + MFL unreadable → 503, nothing written", async () => {
  const body = JSON.stringify({ franchiseId: "0003", willGiveUp: ["1"], playerNames: { 1: "A Player" } });
  await withWorld({ down: true }, LAST + 13 * 24 * H, async (net) => {
    const a = await call("/api/submit-trade-bait?L=" + newLeague(), { method: "POST", headers: { "content-type": "application/json" }, body });
    t.equal(a.status, 401); t.deepEqual(net.mfl(), []);
    const b = await call("/api/submit-trade-bait?MFL_USER_ID=tok&L=" + newLeague(), { method: "POST", headers: { "content-type": "application/json" }, body });
    t.equal(b.status, 503); t.equal(b.json.error, "season_unresolved");
    t.ok(!net.calls.some((c) => /\/import/.test(c)));
  });
});
test("POST /bug-report naming no season with MFL unreadable → 503 (fails closed, never the calendar's year)", async () => {
  await withWorld({ down: true }, LAST + 14 * 24 * H, async () => {
    const r = await call("/bug-report?L=" + newLeague(), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ description: "x" }) });
    t.equal(r.status, 503); t.equal(r.json.error, "season_unresolved");
  });
});
test("POST /api/app-view (analytics) with MFL unreadable → 204, nothing recorded (never a calendar-year row)", async () => {
  const db = makeD1({});
  db.raw.exec("CREATE TABLE ups_app_views (league_id TEXT, season TEXT, franchise_id TEXT, surface TEXT, day TEXT, hits INTEGER, first_seen_utc TEXT, last_seen_utc TEXT, UNIQUE(league_id, season, franchise_id, surface, day))");
  await withWorld({ down: true }, LAST + 15 * 24 * H, async () => {
    const r = await worker.fetch(new Request("https://w.test/api/app-view?L=" + newLeague(), { method: "POST", body: JSON.stringify({ franchise_id: "0003", surface: "m" }) }), { UPS_MFL_DB: db }, { waitUntil() {}, passThroughOnException() {} });
    t.equal(r.status, 204);
    t.equal(db.raw.prepare("SELECT COUNT(*) AS n FROM ups_app_views").get().n, 0);
  });
});

// ── 3. the cron jobs ──
async function cronTick(o, now, cron) {
  const db = makeD1({});
  db.raw.exec("CREATE TABLE IF NOT EXISTS ups_bot_heartbeat (bot TEXT PRIMARY KEY, last_ts INTEGER, status TEXT, env TEXT)");
  const selfCalls = [], errors = [];
  const env = { UPS_MFL_DB: db, COMMISH_API_KEY: "admin", LEAGUE_ID: newLeague(), ADD_TRACKER_ENABLED: "1", MFL_APIKEY: "k" };
  env.SELF = { fetch: async (input, init) => { const u = new URL(String(input)); selfCalls.push({ path: u.pathname, year: u.searchParams.get("YEAR"), body: init && init.body ? JSON.parse(init.body) : null }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); } };
  const pending = [], realError = console.error, realLog = console.log, realWarn = console.warn;
  console.error = (...a) => errors.push(a.map(String).join(" ")); console.log = () => {}; console.warn = () => {};
  try {
    await withWorld(o, now, async () => {
      await worker.scheduled({ cron, scheduledTime: now }, env, { waitUntil(p) { pending.push(Promise.resolve(p).catch(() => {})); }, passThroughOnException() {} });
      for (let i = 0; i < pending.length; i++) await pending[i];
    });
  } finally { console.error = realError; console.log = realLog; console.warn = realWarn; }
  return { selfCalls, errors };
}
test("cron */5 on Sat Jan 2 with 2027 created early: the add tracker and the transactions ledger run as 2026 (the calendar said 2027); once Week 17 is final → 2027", async () => {
  const jobs = (k) => k.selfCalls.filter((c) => /^\/admin\/adds\/|^\/admin\/transactions\/scan-and-record$/.test(c.path));
  const k = await cronTick({ renewed: true }, Date.parse("2027-01-02T15:05:00Z"), "*/5 * * * *");
  t.ok(jobs(k).length >= 2 && jobs(k).some((c) => c.path === "/admin/transactions/scan-and-record"), JSON.stringify(k.selfCalls.map((c) => c.path)));
  t.ok(jobs(k).every((c) => c.year === "2026"), JSON.stringify(jobs(k).map((c) => [c.path, c.year])));
  const k2 = await cronTick({ renewed: true }, Date.parse("2027-01-08T15:05:00Z"), "*/5 * * * *");
  t.ok(jobs(k2).length >= 2 && jobs(k2).every((c) => c.year === "2027"), JSON.stringify(jobs(k2).map((c) => [c.path, c.year])));
});
test("(d) cron */5 with MFL unreadable: the add tracker and the transactions ledger do NOT run, and say so", async () => {
  const k = await cronTick({ down: true }, Date.parse("2027-01-02T15:05:00Z"), "*/5 * * * *");
  t.equal(k.selfCalls.filter((c) => /^\/admin\/adds\/|^\/admin\/transactions\//.test(c.path)).length, 0, JSON.stringify(k.selfCalls.map((c) => c.path)));
  t.ok(k.errors.some((e) => /add tracker SKIPPED this tick/.test(e)) && k.errors.some((e) => /transactions ledger SKIPPED this tick/.test(e)), k.errors.join("\n").slice(0, 600));
});
test("cron hourly at 13:05 UTC on Sat Jan 2 (2027 created early): taxi call-up confirm and deadline reminders run as 2026; MFL unreadable → skipped, loudly", async () => {
  const k = await cronTick({ renewed: true }, Date.parse("2027-01-02T13:05:00Z"), "5 * * * *");
  const taxi = k.selfCalls.find((c) => c.path === "/api/taxi-callups/confirm"), dl = k.selfCalls.find((c) => c.path === "/admin/deadline-reminders/run");
  t.ok(taxi && taxi.body && String(taxi.body.season) === "2026", JSON.stringify(taxi));
  t.ok(dl && dl.year === "2026", JSON.stringify(dl));
  const k2 = await cronTick({ down: true }, Date.parse("2027-01-02T13:05:00Z"), "5 * * * *");
  t.ok(!k2.selfCalls.some((c) => c.path === "/api/taxi-callups/confirm" || c.path === "/admin/deadline-reminders/run"), JSON.stringify(k2.selfCalls.map((c) => c.path)));
  t.ok(k2.errors.some((e) => /taxi call-up confirm SKIPPED/.test(e)) && k2.errors.some((e) => /deadline reminders SKIPPED/.test(e)), k2.errors.join("\n").slice(0, 600));
});
// ── 2b. every other write-capable route: the season after the credentials, never the calendar ──
const post = (p, body, headers) => call(p, { method: "POST", headers: { "content-type": "application/json", ...(headers || {}) }, body: JSON.stringify(body || {}) }, { COMMISH_API_KEY: "admin-key", MFL_COOKIE: "MFL_USER_ID=test-cookie" });
test("an /admin WRITE naming no season: a bad key → refused with NO MFL read; the key + MFL unreadable → 503, nothing run", async () => {
  await withWorld({ down: true }, JAN2, async (net) => {
    const a = await post("/admin/adds/scan-and-record?APIKEY=wrong&L=" + newLeague(), { days: 2 });
    t.ok(a.status === 401 || a.status === 403, String(a.status)); t.deepEqual(net.mfl(), []);
    const b = await post("/admin/adds/scan-and-record?APIKEY=admin-key&L=" + newLeague(), { days: 2 });
    t.equal(b.status, 503); t.equal(b.json.error, "season_unresolved");
    t.ok(!net.calls.some((c) => /TYPE=transactions/.test(c)), "nothing scanned");
  });
});
test("an /admin WRITE naming no season on Jan 2 (2027 created early) runs as 2026 (YEAR's calendar default said 2027); a season in the body or URL is used as given", async () => {
  const db = makeD1({});
  const run = (q, body) => worker.fetch(new Request("https://w.test/admin/adds/scan-and-record?APIKEY=admin-key&" + q, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { COMMISH_API_KEY: "admin-key", UPS_MFL_DB: db, MFL_COOKIE: "MFL_USER_ID=test-cookie" }, { waitUntil() {}, passThroughOnException() {} });
  await withWorld({ renewed: true }, JAN2, async (net) => {
    await run("L=" + newLeague(), { days: 2 });
    const tx = net.calls.filter((c) => /TYPE=transactions/.test(c));
    t.ok(tx.length > 0 && tx.every((c) => /\/2026\/export/.test(c)), net.calls.join("\n"));
  });
  await withWorld({ renewed: true }, JAN2, async (net) => {
    await run("L=" + newLeague(), { days: 2, season: "2025" });
    t.ok(net.calls.filter((c) => /TYPE=transactions/.test(c)).every((c) => /\/2025\/export/.test(c)));
    t.ok(!net.calls.some((c) => /TYPE=league&/.test(c) && /\/2027\//.test(c)), "a named season needs no season lookup");
  });
  await withWorld({ down: true }, JAN2, async (net) => {
    await run("YEAR=2026&L=" + newLeague(), { days: 2 });
    t.ok(net.calls.filter((c) => /TYPE=transactions/.test(c)).every((c) => /\/2026\/export/.test(c)) && !net.calls.some((c) => /TYPE=nflSchedule/.test(c)));
  });
});
test("trade identity (resolveTradeCaller → _rdhDetectFranchise) reads a real season's myleagues — never the league id as the year", async () => {
  await withWorld({ renewed: true }, JAN2, async (net) => {
    const L = newLeague();
    const r = await post("/api/trades/2way?MFL_USER_ID=tok&L=" + L, {});
    const ml = net.calls.filter((c) => /TYPE=myleagues/.test(c));
    t.ok(ml.length > 0 && ml.every((c) => /\/20\d\d\/export/.test(c)), ml.join("\n"));
    t.ok(r.status !== 401 && r.status !== 503, JSON.stringify(r));
  });
});
test("owner writes with no credentials keep their 401/403 and read nothing from MFL, even with MFL down (trade offer, 2-way trade, roster action, contract, waivers)", async () => {
  await withWorld({ down: true }, JAN2, async (net) => {
    const L = newLeague();
    const cases = [
      ["/trade-offers?L=" + L, { league_id: L, from_franchise_id: "0003", to_franchise_id: "0004" }, [401, 403]],
      ["/api/trades/2way?L=" + L, { from_franchise_id: "0003" }, [401, 403]],
      ["/roster-workbench/action?L=" + L, { action: "drop_player", player_id: "1", franchise_id: "0003" }, [401, 403]],
      ["/commish-contract-update?L=" + L, { player_id: "1", franchise_id: "0003" }, [401, 403]],
      ["/api/waivers/fcfs?L=" + L, { franchise_id: "0003", add: "1" }, [401, 403, 503]],
    ];
    for (const [p, b, ok] of cases) {
      net.calls.length = 0;
      const r = await post(p, b);
      t.ok(ok.includes(r.status) && (r.json || {}).error !== "season_unresolved", p + " → " + r.status + " " + JSON.stringify(r.json));
      t.deepEqual(net.mfl(), [], p + ": no MFL read");
    }
  });
});
test("owner writes WITH credentials and MFL unreadable → 503, nothing imported (roster action; 2-way trade)", async () => {
  await withWorld({ down: true }, JAN2, async (net) => {
    const L = newLeague();
    const a = await post("/roster-workbench/action?MFL_USER_ID=tok&L=" + L, { action: "drop_player", player_id: "1", franchise_id: "0003" });
    t.equal(a.status, 503); t.equal(a.json.error, "season_unresolved");
    const b = await post("/api/trades/2way?MFL_USER_ID=tok&L=" + L, { from_franchise_id: "0003" });
    t.equal(b.status, 503);
    t.ok(!net.calls.some((c) => /\/import/.test(c)));
  });
});
test("Acquisition Hub actions and auction bids name their season or are refused (400) — never the calendar, no MFL read", async () => {
  await withWorld({ down: true }, JAN2, async (net) => {
    for (const p of ["/acquisition-hub/rookie-draft/action", "/acquisition-hub/free-agent-auction/action", "/acquisition-hub/expired-rookie-auction/action", "/api/auction/bid", "/api/auction/nominate"]) {
      const r = await post(p + "?L=74598", {});
      t.ok(r.status === 400 && r.json.error === "season_required", p + " → " + JSON.stringify(r));
    }
    t.deepEqual(net.mfl(), []);
  });
});
test("worker source: no calendar-year default left for a season (`env.YEAR || new Date()…getUTCFullYear()` / UPS_SEASON) in index.js", () => {
  t.equal((WORKER.match(/(env\.YEAR|env\.UPS_SEASON) \|\| (new Date\(\)|nowUtc)\.getUTCFullYear\(\)/g) || []).length, 0);
  // submit-lineup: the credential check comes before the season read
  const at = WORKER.indexOf('if (path === "/api/submit-lineup" && request.method === "POST") {');
  const seg = WORKER.slice(at, at + 3000);
  t.ok(seg.indexOf("credPresent ? await _strictSeason()") > 0, "season read only with credentials");
  // contract writes: the active season is read after the caller is proven
  const c = WORKER.indexOf("let year = String(namedSeason || body.YEAR || body.year");
  const cc = WORKER.indexOf("const contractCallerIsCommish = sessionByApiKey", c), cs = WORKER.indexOf("const ssContract = await _strictSeason()", c);
  t.ok(c > 0 && cc > c && cs > cc, "contract season after the caller check");
  // the /admin write season comes after the admin credential gate
  const g = WORKER.indexOf("if (!adminAuth.ok) {"), as = WORKER.indexOf("const adminAct = await activeSeason(L, env);");
  t.ok(g > 0 && as > g && as - g < 3000, "admin season after the admin gate");
  // waiver writes: the season after the owner-session 401
  for (const k of ['"/api/waivers/bbid-plan"', '"/api/waivers/fcfs"']) {
    const at2 = WORKER.indexOf("if (path === " + k + ' && request.method === "POST")');
    const seg2 = WORKER.slice(at2, at2 + 4000);
    t.ok(seg2.indexOf("MISSING_VIEWER_COOKIE") < seg2.indexOf("await _strictSeason()"), k);
  }
});

// ── 4. the phone ──
const APP_FNS = ["safeStr", "safeInt", "pad4", "asArray", "fetchJson", "mflExportUrl", "mflExportUrlForYear", "detectContext", "fetchSeason", "loadAllData"];
const APP_SRC = APP_FNS.map((n) => sliceFn(APP, "function " + n + "(")).join("\n") + "\n" + (APP.match(/  var seasonSettled = [^\n]*\n/) || [""])[0];
const fetchers = [...new Set([...APP_SRC.matchAll(/\b(fetch[A-Z]\w*)\s*\(/g)].map((m) => m[1]))]
  .filter((n) => n !== "fetchJson" && !new RegExp("function " + n + "\\(").test(APP_SRC));
const STUBS = fetchers.map((n) => "function " + n + "() { return Promise.resolve(null); }").join("\n") + `
var LEAGUE_ID_DEFAULT = "74598";
function workerUrl(p) { return "https://w.test" + p; }
function repairTaxiContractsInPlace() {} function emptyContractLadder() { return { contractDeadline: "" }; }
function resolveViewerFranchise() {} function reconcileWaiverPlanAfterRun() {} function parseLeague() {} function tradeOffersUnavailable() { return {}; }`;
function phone({ worker: ws, search = "", clock = Date.parse("2030-06-01T12:00:00Z") }) {
  const calls = [];
  const res = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(JSON.parse(JSON.stringify(body))) });
  const fetch = (url, init) => {
    const u = new URL(url);
    calls.push({ path: u.pathname, year: u.searchParams.get("YEAR"), method: (init && init.method) || "GET" });
    if (u.pathname === "/api/active-season") return ws === "offline" ? Promise.reject(new Error("offline")) : res(ws.status, ws.body);
    return res(200, {});
  };
  const state = { ctx: { year: "", leagueId: "74598", embed: false }, loadErrors: [], loadingPromise: null, viewerFranchiseId: "0008" };
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, URL, URLSearchParams, Promise, JSON, fetch, state });
  ctx.Date = class extends RealDate { constructor(...a) { if (a.length) super(...a); else super(clock); } static now() { return clock; } };
  ctx.window = ctx; ctx.location = { search, href: "https://x.test/m/" + search, hash: "" };
  ctx.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  ctx.document = { body: { classList: { add() {} } } };
  vm.runInContext(APP_SRC + "\n" + STUBS, ctx);
  return { ctx, state, calls, async open() { calls.length = 0; ctx.detectContext(); try { await ctx.loadAllData(); await settle(); return { ok: true }; } catch (e) { return { ok: false, e }; } },
    years() { return [...new Set(calls.filter((c) => c.path === "/api/mfl-export").map((c) => c.year))]; } };
}
test("phone: the worker says 2026 → every read is 2026, though this device's clock says 2030", async () => {
  const p = phone({ worker: { status: 200, body: { ok: true, season: "2026", source: "season_2026_not_complete:w17:9_of_16_not_over" } } });
  t.ok((await p.open()).ok); t.equal(p.state.ctx.year, "2026"); t.deepEqual(p.years(), ["2026"]);
  t.equal(p.calls[0].path, "/api/active-season", "asked first, before any read"); t.ok(p.calls.length > 10);
});
test("(d) phone: the worker can't resolve the season (503) → nothing loads, a visible failure naming the reason, no read at all", async () => {
  const p = phone({ worker: { status: 503, body: { ok: false, error: "season_unresolved", reason: "league_2027_unreadable:http_500" } } });
  const r = await p.open();
  t.equal(r.ok, false); t.equal(r.e.seasonUnresolved, true);
  t.match(r.e.message, /^Couldn’t tell which season is active from MFL \(league_2027_unreadable:http_500\), so nothing is shown\. The app never guesses the season from the date\.$/);
  t.deepEqual(p.calls.map((c) => c.path), ["/api/active-season"]);
});
test("(d) phone: the worker unreachable, or an answer that isn't a season → the same visible failure", async () => {
  const a = await phone({ worker: "offline" }).open();
  t.ok(!a.ok && a.e.seasonUnresolved && /the worker couldn’t be reached/.test(a.e.message));
  const b = await phone({ worker: { status: 200, body: { ok: true, season: "" } } }).open();
  t.ok(!b.ok && b.e.seasonUnresolved);
});
test("phone: an explicit ?YEAR= is used as given; one question per app open", async () => {
  const p = phone({ worker: { status: 503, body: { ok: false } }, search: "?YEAR=2025" });
  t.ok((await p.open()).ok); t.deepEqual(p.years(), ["2025"]); t.ok(!p.calls.some((c) => c.path === "/api/active-season"));
  const q = phone({ worker: { status: 200, body: { ok: true, season: "2026" } } });
  await q.open(); q.state.loadingPromise = null; q.calls.length = 0; await q.ctx.loadAllData(); await settle();
  t.ok(!q.calls.some((c) => c.path === "/api/active-season"));
});
test("phone: no calendar anywhere in site/m/app.js; the failure screen offers Try again", () => {
  t.equal((APP.match(/get(UTC)?FullYear\(/g) || []).length, 0);
  t.match(APP, /if \(e && e\.seasonUnresolved\) \{/); t.match(APP, /id="ups-m-season-retry">Try again<\/button>/);
});

await run("mobile_season_from_mfl");
