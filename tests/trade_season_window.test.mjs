// WHICH roster limits a War Room trade is held to, and WHEN (Keith 2026-10-08) — canon, from the league calendar:
//   offseason (before the FA Auction; after the season): no roster limit · FA Auction start → contract deadline: maximum 35
//   · contract deadline → end of NFL Week 17: maximum 30 and the five-active-QB limit. Never MFL's own roster/position settings.
// 2026 boundaries: FA Auction 2026-07-25 12:00 ET (calendar faa_open_at) · deadline 2026-09-06 23:59 ET, open through
// 23:59:59 (contract_deadline.js) · season end = last Week-17 kickoff (Mon 2027-01-04 8:15 PM ET) + 4 h.
//   node tests/trade_season_window.test.mjs
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { tradeSeasonWindow, resolveAuctionStart, candidateRosterMaxes, SEASON_END_GAME_SEC } from "../worker/src/trade_season_window.js";
import { resolveContractDeadline } from "../worker/src/contract_deadline.js";
import { evaluateTradeCompliance } from "../worker/src/trade_cap_authority.js";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY, NFL_2026_WEEKS } from "./fixtures/worker_harness.mjs";

const restore = quiet();
const U = (iso) => Math.floor(Date.parse(iso) / 1000);
const AUCTION = U("2026-07-25T12:00:00-04:00");
const DEADLINE = U("2026-09-06T23:59:59-04:00");
const END = 1799111700 + SEASON_END_GAME_SEC;                       // Tue 2027-01-05 00:15 ET
const W17 = { DAL: 1798766100, GBP: 1799111700 };
const CAL = { season: "2026", faa: { faa_open_at: "2026-07-25T12:00", contract_deadline_at: "2026-09-06T23:59" }, read_error: "" };
const win = (now, o) => tradeSeasonWindow({ nowUnix: now, auctionStart: resolveAuctionStart({ season: "2026", calendar: CAL }), contractDeadline: resolveContractDeadline({ season: "2026", calendar: CAL }), week17Kickoffs: W17, ...(o || {}) });

test("THE PHASES on both sides of every boundary (2026)", () => {
  const at = (now) => { const w = win(now); return [w.phase, w.roster_max, w.qb_limit]; };
  t.deepEqual(at(AUCTION - 1), ["offseason", null, false], "1s before the FA Auction: no roster limit");
  t.deepEqual(at(AUCTION), ["auction", 35, false], "the FA Auction start: 35");
  t.deepEqual(at(DEADLINE), ["auction", 35, false], "the contract deadline second itself: still 35");
  t.deepEqual(at(DEADLINE + 1), ["in_season", 30, true], "1s after the deadline: 30 + five QBs");
  t.deepEqual(at(END - 1), ["in_season", 30, true]);
  t.deepEqual(at(END), ["offseason", null, false], "the end of Week 17: no limit");
  for (const [iso, ph] of [["2026-03-15T12:00:00Z", "offseason"], ["2026-05-24T18:00:00Z", "offseason"], ["2026-08-04T12:00:00Z", "auction"], ["2026-11-20T12:00:00Z", "in_season"], ["2027-02-01T12:00:00Z", "offseason"]]) t.equal(win(U(iso)).phase, ph, iso);
  const b = win(DEADLINE + 1).boundaries;
  t.deepEqual([b.auction_start_unix, b.contract_deadline_unix, b.season_end_unix, b.auction_start_source, b.contract_deadline_source], [AUCTION, DEADLINE, END, "calendar", "calendar"]);
});

// a trade that leaves Gride (0003) with `n` active players and `q` active QBs (one player in, a pick out)
const ok = (data) => ({ ok: true, data });
function trade(n, q, now, rosterSize, o) {
  const pos = {}; const gride = [];
  for (let i = 0; i < n - 1; i += 1) { const id = String(1000 + i); gride.push({ id, salary: "500", status: "ROSTER" }); pos[id] = i < q - 1 ? "QB" : "WR"; }
  pos["9000"] = q > 0 ? "QB" : "WR";
  return evaluateTradeCompliance({
    league: ok({ league: { salaryCapAmount: "300000", rosterSize: String(rosterSize || "30"), taxiSquad: "10", franchises: { franchise: [{ id: "0003", name: "Gride" }, { id: "0010", name: "Blake Bombers" }] } } }),
    salaries: ok({ salaries: { leagueUnit: { player: [] } } }), adjustments: ok({ salaryAdjustments: { salaryAdjustment: [] } }),
    players: ok({ players: { player: Object.entries(pos).map(([id, position]) => ({ id, position, name: `P${id}` })) } }),
    rosters: ok({ rosters: { franchise: [{ id: "0003", player: gride }, { id: "0010", player: [{ id: "9000", salary: "500", status: "ROSTER" }, ...Array.from({ length: 28 }, (_, i) => ({ id: String(5000 + i), salary: "500", status: "ROSTER" }))] }] } }),
    movements: [{ from: "0010", to: "0003", tokens: ["9000"] }, { from: "0003", to: "0010", tokens: ["FP_0003_2027_3"] }],
    seasonWindow: (o && o.window) || win(now),
  });
}
const R = (c) => [c.roster_limit.status, c.roster_limit.max];
test("ROSTER GATE on both sides of each boundary — the trade that would be refused in-season is legal in the offseason", () => {
  t.deepEqual(R(trade(36, 0, AUCTION - 1)), ["not_applicable", null], "offseason: 36 is legal");
  t.equal(trade(36, 0, AUCTION - 1).roster_limit.executable, true);
  t.deepEqual(R(trade(36, 0, AUCTION)), ["blocked", 35], "the auction opens: 36 is over 35");
  t.deepEqual(R(trade(35, 0, AUCTION)), ["ok", 35]);
  t.deepEqual(R(trade(31, 0, DEADLINE)), ["ok", 35], "the deadline second: 31 is still legal");
  t.deepEqual(R(trade(31, 0, DEADLINE + 1)), ["blocked", 30], "1s later: 31 is over 30");
  t.deepEqual(R(trade(30, 0, DEADLINE + 1)), ["ok", 30]);
  t.deepEqual(R(trade(31, 0, END - 1)), ["blocked", 30]);
  t.deepEqual(R(trade(31, 0, END)), ["not_applicable", null], "after Week 17: no limit");
  t.match(trade(31, 0, END).roster_limit.message, /no roster limit in the offseason/);
  t.match(trade(36, 0, AUCTION).roster_limit.violations[0].message, /Gride would have 36 active players right after this trade — the maximum is 35\./);
});

test("NEVER MFL's own number: MFL saying 35 in-season still means 30; MFL saying 30 in the auction window still means 35", () => {
  t.deepEqual(R(trade(31, 0, DEADLINE + 1, "35")), ["blocked", 30]);
  t.deepEqual(R(trade(33, 0, AUCTION + 3600, "30")), ["ok", 35]);
  const mod = fs.readFileSync(new URL("../worker/src/trade_season_window.js", import.meta.url), "utf8");
  t.doesNotMatch(mod.replace(/^\s*\/\/.*$/gm, ""), /rosterSize|rosterLimits|positionLimit/i);
});

test("FIVE-QB GATE: in-season only — 6 active QBs are refused 1s after the deadline, legal at the deadline second and after Week 17", () => {
  const Qs = (now) => trade(30, 6, now).qb_limit.status;
  t.equal(Qs(DEADLINE), "not_applicable"); t.equal(Qs(DEADLINE + 1), "blocked"); t.equal(Qs(END - 1), "blocked"); t.equal(Qs(END), "not_applicable"); t.equal(Qs(AUCTION), "not_applicable");
});

test("UNKNOWN PHASE fails closed only where it matters: within every possible limit → fine; over a possible limit → unavailable; over every one → blocked", () => {
  // the FA Auction start not on file, before the deadline → offseason OR auction
  const noAuction = win(U("2026-07-01T12:00:00Z"), { auctionStart: resolveAuctionStart({ season: "2026", calendar: { season: "2026", faa: {} } }) });
  t.equal(noAuction.phase, "unknown"); t.deepEqual(noAuction.candidates, ["offseason", "auction"]); t.match(noAuction.reason, /auction_start_not_set/);
  t.deepEqual(candidateRosterMaxes(noAuction), { strict: 35, lenient: null });
  t.deepEqual(R(trade(34, 0, 0, null, { window: noAuction })), ["ok", 35]);
  t.deepEqual(R(trade(36, 0, 0, null, { window: noAuction })), ["unavailable", 35]);
  t.match(trade(36, 0, 0, null, { window: noAuction }).roster_limit.message, /couldn't confirm which roster limit applies right now \(auction_start_not_set\)/);
  t.equal(trade(30, 6, 0, null, { window: noAuction }).qb_limit.status, "not_applicable", "neither candidate has the QB limit");
  // a date-only contract deadline, ON that day (2027-style record) → auction OR in_season
  const day = tradeSeasonWindow({ nowUnix: U("2026-09-06T12:00:00-04:00"), auctionStart: resolveAuctionStart({ season: "2026", calendar: CAL }),
    contractDeadline: resolveContractDeadline({ season: "2099", calendar: null, eventDay: "2026-09-06" }), week17Kickoffs: W17 });
  t.deepEqual(day.candidates, ["auction", "in_season"]); t.match(day.reason, /contract_deadline_time_not_set/);
  t.deepEqual(R(trade(30, 0, 0, null, { window: day })), ["ok", 30]);
  t.deepEqual(R(trade(33, 0, 0, null, { window: day })), ["unavailable", 30]);
  t.deepEqual(R(trade(36, 0, 0, null, { window: day })), ["blocked", 35], "over 35 is over every possible limit");
  t.equal(trade(30, 6, 0, null, { window: day }).qb_limit.status, "unavailable"); t.equal(trade(30, 5, 0, null, { window: day }).qb_limit.status, "ok");
  // Week 17 unreadable after the deadline → in_season OR offseason
  const noEnd = win(DEADLINE + 86400, { week17Kickoffs: {} });
  t.deepEqual(noEnd.candidates, ["in_season", "offseason"]); t.deepEqual(R(trade(30, 0, 0, null, { window: noEnd })), ["ok", 30]); t.deepEqual(R(trade(31, 0, 0, null, { window: noEnd })), ["unavailable", 30]);
});

// ── through the REAL routes at a controlled clock: the commissioner's calendar as production holds it ──
const Q = "L=74598&YEAR=2026";
const C = { contractYear: "2", contractStatus: "Rookie-Draft", contractInfo: "CL 3| TCV 6K| AAV 2K| Y1-2K, Y2-2K, Y3-2K" };
const P = (id, status) => ({ id: String(id), salary: 500, status: status || "ROSTER", ...C });
const asset = (pid) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary: 500, taxi: false, contract_info: C.contractInfo });
const pick = (key) => ({ asset_id: key, type: "PICK", description: key });
const payload = (left, right) => ({ schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [{ role: "left", franchise_id: "0001", selected_assets: left, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0 },
    { role: "right", franchise_id: "0002", selected_assets: right, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0 }],
  extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" } });
function world(receiverSize, opts) {
  const env = makeWorkerEnv({ TRADE_ROSTER_CHECK_ENABLED: "1", TRADE_ROSTER_CHECK_SINCE: "2026-01-01T00:00:00Z", COMMISH_DISCORD_USER_ID: "621530026831118346" });
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners (franchise_id, active_owner, discord_user_id) VALUES ('0002','Y','222222222222222222')").run();
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_bot_heartbeat (bot TEXT PRIMARY KEY, last_ts INTEGER NOT NULL, status TEXT DEFAULT 'ok', env TEXT DEFAULT '')");
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_taxi_callups (id INTEGER PRIMARY KEY, league_id TEXT, season TEXT, franchise_id TEXT, player_id TEXT, nfl_week INTEGER, pending INTEGER)");
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  if (!(opts && opts.calendarUnset)) env.UPS_MFL_DB.raw.prepare("INSERT OR REPLACE INTO ups_settings (key, value, updated_at) VALUES ('auction_calendar', ?, '2026-08-06T11:51:58.312Z')").run(JSON.stringify(CAL));
  const mfl = makeMfl(); mfl.st.league = { rosterSize: (opts && opts.mflRosterSize) || "30", taxiSquad: "10" };
  mfl.st.positions = { 9001: "QB", 9002: "QB", 9003: "QB", 9004: "QB", 9005: "QB", 9006: "QB", 14056: "WR" };
  mfl.st.exportBody = { nflSchedule: (q) => (NFL_2026_WEEKS[q.W] ? { nflSchedule: { week: q.W, matchup: NFL_2026_WEEKS[q.W] } } : {}) };
  mfl.st.rosters = { "0001": [P(14056), ...Array.from({ length: 28 }, (_, i) => P(5000 + i))], "0002": Array.from({ length: receiverSize }, (_, i) => P(6000 + i)) };
  mfl.st.futurePicks["0002"] = [{ year: 2027, round: 3 }];
  mfl.install();
  return { env, mfl };
}
async function at(iso, fn) { const real = Date.now; Date.now = () => Date.parse(iso); try { return await fn(); } finally { Date.now = real; } }
async function sendAndAccept(env, mfl) {
  const s = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "", payload: payload([asset(14056)], [pick("FP_0002_2027_3")]) } });
  if (s.status >= 300) return { send: s };
  const id = mfl.st.pending[mfl.st.pending.length - 1].trade_id;
  const a = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "" } });
  return { send: s, accept: a };
}
const iso = (u) => new Date(u * 1000).toISOString();

test("ROUTE (Accept): CBP receiving one player — accepted 1s before each limit starts, refused at it; accepted again when the season ends", async () => {
  for (const [now, size, want] of [
    [AUCTION - 1, 40, 200], [AUCTION, 35, 409], [AUCTION, 34, 200],
    [DEADLINE, 30, 200], [DEADLINE + 1, 30, 409],
    [END - 1, 30, 409], [END, 30, 200],
  ]) {
    const { env, mfl } = world(size);
    const r = await at(iso(now), () => sendAndAccept(env, mfl));
    t.ok(r.send.status < 300, `${iso(now)} send: ${r.send.status} ${r.send.text.slice(0, 120)}`);
    t.equal(r.accept.status, want, `${iso(now)} CBP ${size}→${size + 1}: ${r.accept.text.slice(0, 160)}`);
    if (want === 409) t.equal(r.accept.json.code, "roster_room_required");
    t.equal(mfl.st.done.filter((d) => d.response === "accept").length, want === 200 ? 1 : 0);
  }
});

test("ROUTE: the calendar deliberately UNSET — the pinned 2026 deadline (23:59 ET) still splits 35 from 30 at the same second", async () => {
  for (const [now, want] of [[DEADLINE, 200], [DEADLINE + 1, 409]]) {
    const { env, mfl } = world(30, { calendarUnset: true });
    const r = await at(iso(now), () => sendAndAccept(env, mfl));
    t.equal(r.accept.status, want, `${iso(now)}: ${r.accept.text.slice(0, 160)}`);
  }
});

test("ROUTE (Send): the same 6-QB offer is refused in-season only (the deadline second and after Week 17 are fine)", async () => {
  const sendQb = async (now) => {
    const { env, mfl } = world(28);
    mfl.st.rosters["0001"] = [P(9001), ...Array.from({ length: 28 }, (_, i) => P(5000 + i))];
    mfl.st.rosters["0002"] = [P(9002), P(9003), P(9004), P(9005), P(9006), ...Array.from({ length: 22 }, (_, i) => P(6000 + i))];
    return at(iso(now), () => callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "", payload: payload([asset(9001)], [pick("FP_0002_2027_3")]) } }));
  };
  for (const [now, refused] of [[DEADLINE, false], [DEADLINE + 1, true], [END - 1, true], [END, false]]) {
    const r = await sendQb(now);
    if (refused) { t.equal(r.status, 409, iso(now)); t.equal(r.json.code, "qb_limit_exceeded"); } else t.ok(r.status < 300, `${iso(now)}: ${r.status} ${r.text.slice(0, 140)}`);
  }
});

test("ROUTE (MFL-site accepts): alerts follow the same window — none in the offseason, 35 in the auction window, 30 in-season", async () => {
  const check = async (now, size) => {
    const { env, mfl } = world(size);
    mfl.st.transactions = [{ type: "TRADE", timestamp: String(now - 600), franchise: "0001", franchise2: "0002", franchise1_gave_up: "5100,", franchise2_gave_up: "FP_0002_2027_3," }];
    return at(iso(now), () => callWorker(env, "POST", `/admin/trades/roster-check?${Q}&APIKEY=${ADMIN_KEY}`, { body: { season: "2026", league_id: "74598", dry_run: true } }));
  };
  const off = await check(AUCTION - 1, 40); t.deepEqual(off.json.findings, []); t.equal(off.json.season_window.phase, "offseason");
  const au35 = await check(AUCTION + 3600, 35); t.deepEqual(au35.json.findings, [], "35 is legal in the auction window");
  const au36 = await check(AUCTION + 3600, 36); t.deepEqual(au36.json.findings.map((f) => [f.kind, f.active, f.max]), [["roster", 36, 35]]);
  const ins = await check(DEADLINE + 3600, 31); t.deepEqual(ins.json.findings.map((f) => [f.kind, f.active, f.max]), [["roster", 31, 30]]);
  const after = await check(END + 3600, 31); t.deepEqual(after.json.findings, []); t.equal(after.json.season_window.phase, "offseason");
});

await run("trade_season_window");
restore();
