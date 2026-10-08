// The five-active-QB trade limit applies IN-SEASON only (Keith 2026-10-08) — its exact boundaries, from canon:
//   START = the September contract deadline (the league's configured instant: 2026-09-06 23:59 ET; with nothing
//           configured, 23:59 ET on the last Sunday before NFL Week 1)
//   END   = the end of the fantasy season = the end of NFL Week 17 (last Week-17 kickoff + 4 h: 2027-01-05 00:15 ET)
// Never MFL's own position-limit setting. Real 2026 schedule (MFL nflSchedule, read 2026-10-08).
//   node tests/qb_trade_window.test.mjs
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { qbTradeLimitWindow, contractDeadlineFromWeek1, seasonEndFromWeek17, SEASON_END_GAME_SEC } from "../worker/src/qb_trade_window.js";
import { evaluateTradeCompliance } from "../worker/src/trade_cap_authority.js";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY, NFL_2026_WEEKS } from "./fixtures/worker_harness.mjs";

const restore = quiet();
const W1 = { SEA: 1788999600, NEP: 1788999600, LAC: 1789431300 };                  // Wed 2026-09-09 8:20 PM ET opener … MNF
const W17 = { DAL: 1798766100, GBP: 1799111700 };                                   // Thu 12-31 … Mon 2027-01-04 8:15 PM ET
const START = Math.floor(Date.parse("2026-09-06T23:59:00-04:00") / 1000);          // the commissioner's calendar value
const END = 1799111700 + 4 * 3600;                                                  // Tue 2027-01-05 00:15 ET
const win = (now, o) => qbTradeLimitWindow({ nowUnix: now, contractDeadlineUnix: START, week1Kickoffs: null, week17Kickoffs: W17, ...(o || {}) });

test("BOUNDARIES (2026): not applied one second before the contract deadline; applied AT it; applied one second before the end of Week 17; not applied AT it", () => {
  t.deepEqual([START, END], [1788753540, 1799126100]);
  t.equal(new Date(START * 1000).toISOString(), "2026-09-07T03:59:00.000Z"); t.equal(new Date(END * 1000).toISOString(), "2027-01-05T05:15:00.000Z");
  const at = (now) => { const w = win(now); return [w.state, w.applies]; };
  t.deepEqual(at(START - 1), ["before_season", false]);
  t.deepEqual(at(START), ["in_season", true]);
  t.deepEqual(at(END - 1), ["in_season", true]);
  t.deepEqual(at(END), ["after_season", false]);
  t.equal(win(START).start_source, "league_calendar"); t.equal(win(START).end_unix, END);
  // the rest of the year, as canon reads it
  for (const [iso, state] of [["2026-03-15T12:00:00Z", "before_season"], ["2026-07-25T16:00:00Z", "before_season"], ["2026-09-06T12:00:00Z", "before_season"],
    ["2026-09-09T12:00:00Z", "in_season"], ["2026-11-26T17:00:00Z", "in_season"], ["2026-12-31T12:00:00Z", "in_season"], ["2027-01-06T12:00:00Z", "after_season"], ["2027-02-15T12:00:00Z", "after_season"]]) {
    t.equal(win(Date.parse(iso) / 1000).state, state, iso);
  }
});

test("START with nothing configured = 23:59 ET on the last Sunday BEFORE NFL Week 1 (canon §C2) — for 2026 exactly the configured instant", () => {
  t.equal(contractDeadlineFromWeek1(W1), START, "derived from the real 2026 schedule = the commissioner's value");
  const w = qbTradeLimitWindow({ nowUnix: START, contractDeadlineUnix: null, week1Kickoffs: W1, week17Kickoffs: W17 });
  t.equal(w.state, "in_season"); t.equal(w.start_source, "derived_last_sunday_before_week1"); t.equal(w.start_unix, START);
  t.equal(qbTradeLimitWindow({ nowUnix: START - 1, contractDeadlineUnix: null, week1Kickoffs: W1, week17Kickoffs: W17 }).state, "before_season");
  // a Thursday opener (2025: Thu 2025-09-04) → Sun 2025-08-31, the canon calendar's 2025 deadline
  t.equal(new Date(contractDeadlineFromWeek1({ PHI: Math.floor(Date.parse("2025-09-04T20:20:00-04:00") / 1000) }) * 1000).toISOString(), "2025-09-01T03:59:00.000Z");
  // a Sunday opener steps back a full week ("before" Week 1)
  t.equal(new Date(contractDeadlineFromWeek1({ X: Math.floor(Date.parse("2030-09-08T13:00:00-04:00") / 1000) }) * 1000).toISOString(), "2030-09-02T03:59:00.000Z");
  t.equal(seasonEndFromWeek17(W17), END); t.equal(SEASON_END_GAME_SEC, 4 * 3600);
});

test("FAIL CLOSED: an unreadable calendar, an unknown deadline, or an unreadable Week-17 schedule (once it matters) is 'unknown' — never 'not applied'", () => {
  t.equal(qbTradeLimitWindow({ nowUnix: START, calendarError: true }).state, "unknown");
  t.equal(qbTradeLimitWindow({ nowUnix: START, contractDeadlineUnix: null, week1Kickoffs: {} }).reason, "contract_deadline_unknown");
  t.equal(win(START, { week17Kickoffs: {} }).reason, "week17_schedule_unreadable");
  t.equal(win(START - 1, { week17Kickoffs: {} }).state, "before_season", "before the deadline the end date doesn't matter");
  t.equal(win(START, { week17Kickoffs: { X: START + 86400 } }).reason, "season_end_implausible", "a 'Week 17' a day after the deadline is not the real schedule");
  for (const w of [qbTradeLimitWindow({ nowUnix: START, calendarError: true }), win(START, { week17Kickoffs: {} })]) t.equal(w.applies, null);
});

test("THE GATE: 6 active QBs → blocked in-season; NOT applicable before the deadline or after Week 17 (still executable); unknown → unavailable; no window supplied → applied (strict)", () => {
  const ok = (data) => ({ ok: true, data });
  const pos = { 801: "QB", 802: "QB", 803: "QB", 804: "QB", 805: "QB", 806: "QB", 900: "WR" };
  const c = (qbWindow) => evaluateTradeCompliance({
    league: ok({ league: { salaryCapAmount: "300000", rosterSize: "30", taxiSquad: "10", franchises: { franchise: [{ id: "0003", name: "Gride" }, { id: "0010", name: "Blake Bombers" }] } } }),
    salaries: ok({ salaries: { leagueUnit: { player: [] } } }), adjustments: ok({ salaryAdjustments: { salaryAdjustment: [] } }),
    players: ok({ players: { player: Object.entries(pos).map(([id, position]) => ({ id, position, name: `P${id}` })) } }),
    rosters: ok({ rosters: { franchise: [{ id: "0003", player: ["801", "802", "803", "804", "805", "900"].map((id) => ({ id, salary: "1000", status: "ROSTER" })) }, { id: "0010", player: [{ id: "806", salary: "1000", status: "ROSTER" }] }] } }),
    movements: [{ from: "0010", to: "0003", tokens: ["806"] }, { from: "0003", to: "0010", tokens: ["900"] }], qbWindow,
  }).qb_limit;
  t.equal(c(win(START)).status, "blocked"); t.equal(c(win(START)).window.state, "in_season");
  for (const now of [START - 1, END]) {
    const q = c(win(now));
    t.equal(q.status, "not_applicable"); t.equal(q.executable, true); t.deepEqual(q.violations, []);
    t.match(q.message, /applies in-season only \(from the September contract deadline through the end of Week 17\)/);
  }
  const u = c(win(START, { week17Kickoffs: {} })); t.equal(u.status, "unavailable"); t.equal(u.executable, false);
  t.equal(c(undefined).status, "blocked", "a caller that supplies no window gets the strict gate");
});

test("NEVER MFL's own position-limit setting: the window reads only the league calendar and the NFL schedule", () => {
  const mod = fs.readFileSync(new URL("../worker/src/qb_trade_window.js", import.meta.url), "utf8");
  const src = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
  const a0 = src.indexOf("const loadQbTradeWindow = async");
  const loader = src.slice(a0, src.indexOf("// `taxiStep` (Keith 2026-10-07)", a0));
  t.ok(loader.length > 200, "loader found");
  for (const s of [mod, loader]) t.doesNotMatch(s, /rosterLimits|positionLimit|position_limit|limit=/i);
  t.match(loader, /resolveContractDeadlineUtc\(season, \{ readOnly: true \}\)/); t.match(loader, /nflWeekKickoffsByTeam\(season, 17\)/);
});

// ── through the real routes, at a controlled clock ──
const Q = "L=74598&YEAR=2026";
const C = { contractYear: "2", contractStatus: "Rookie-Draft", contractInfo: "CL 3| TCV 6K| AAV 2K| Y1-2K, Y2-2K, Y3-2K" };
const P = (id, status) => ({ id: String(id), salary: 2000, status: status || "ROSTER", ...C });
const asset = (pid) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary: 2000, taxi: false, contract_info: C.contractInfo });
const payload = (left, right) => ({ schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [{ role: "left", franchise_id: "0001", selected_assets: left, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0 },
    { role: "right", franchise_id: "0002", selected_assets: right, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0 }],
  extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" } });
function world() {
  const env = makeWorkerEnv({ TRADE_ROSTER_CHECK_ENABLED: "1", TRADE_ROSTER_CHECK_SINCE: "2026-01-01T00:00:00Z", COMMISH_DISCORD_USER_ID: "621530026831118346" });
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners (franchise_id, active_owner, discord_user_id) VALUES ('0002','Y','222222222222222222')").run();
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_taxi_callups (id INTEGER PRIMARY KEY, league_id TEXT, season TEXT, franchise_id TEXT, player_id TEXT, nfl_week INTEGER, pending INTEGER)");
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_bot_heartbeat (bot TEXT PRIMARY KEY, last_ts INTEGER NOT NULL, status TEXT DEFAULT 'ok', env TEXT DEFAULT '')");
  // the commissioner's calendar, as production holds it (contract_deadline_at 2026-09-06T23:59)
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  env.UPS_MFL_DB.raw.prepare("INSERT OR REPLACE INTO ups_settings (key, value, updated_at) VALUES ('auction_calendar', ?, '2026-08-06T11:51:58.312Z')").run(JSON.stringify({ season: "2026", faa: { contract_deadline_at: "2026-09-06T23:59" } }));
  const mfl = makeMfl(); mfl.st.league = { rosterSize: "30", taxiSquad: "10" };
  mfl.st.positions = { 9001: "QB", 9002: "QB", 9003: "QB", 9004: "QB", 9005: "QB", 9006: "QB", 13100: "WR" };
  mfl.st.exportBody = { nflSchedule: (q) => (NFL_2026_WEEKS[q.W] ? { nflSchedule: { week: q.W, matchup: NFL_2026_WEEKS[q.W] } } : {}) };
  mfl.st.rosters = { "0001": [P(9001), ...Array.from({ length: 28 }, (_, i) => P(5000 + i))], "0002": [P(9002), P(9003), P(9004), P(9005), P(9006), P(13100), ...Array.from({ length: 22 }, (_, i) => P(6000 + i))] };
  mfl.install();
  return { env, mfl };
}
async function at(iso, fn) { const real = Date.now; Date.now = () => Date.parse(iso); try { return await fn(); } finally { Date.now = real; } }
const send = (env) => callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "", payload: payload([asset(9001)], [asset(13100)]) } });

test("ROUTE (Send): the SAME 6-QB offer is refused in-season and goes through before the contract deadline and after Week 17", async () => {
  for (const [iso, want] of [["2026-09-07T03:58:59Z", "sent"], ["2026-09-07T03:59:00Z", "refused"], ["2026-11-20T15:00:00Z", "refused"], ["2027-01-05T05:14:59Z", "refused"], ["2027-01-05T05:15:00Z", "sent"]]) {
    const { env } = world();
    const r = await at(iso, () => send(env));
    if (want === "refused") { t.equal(r.status, 409, `${iso}: ${r.text.slice(0, 160)}`); t.equal(r.json.code, "qb_limit_exceeded", iso); }
    else t.ok(r.status < 300, `${iso}: ${r.status} ${r.text.slice(0, 160)}`);
  }
});

test("ROUTE (MFL-site accepts): a team over 5 active QBs gets a QB alert in-season only; the window is reported", async () => {
  const run1 = async (iso) => {
    const { env, mfl } = world();
    mfl.st.rosters["0002"].push(P(9007)); mfl.st.positions[9007] = "QB";                 // 6 active QBs after a native trade
    mfl.st.transactions = [{ type: "TRADE", timestamp: String(Date.parse(iso) / 1000 - 600), franchise: "0001", franchise2: "0002", franchise1_gave_up: "5100,", franchise2_gave_up: "FP_0002_2027_2," }];
    return at(iso, () => callWorker(env, "POST", `/admin/trades/roster-check?${Q}&APIKEY=${ADMIN_KEY}`, { body: { season: "2026", league_id: "74598", dry_run: true } }));
  };
  const inSeason = await run1("2026-11-20T15:00:00Z");
  t.deepEqual(inSeason.json.findings.map((f) => f.kind), ["qb"]); t.equal(inSeason.json.qb_window.state, "in_season");
  const off = await run1("2027-01-10T15:00:00Z");
  t.deepEqual(off.json.findings, [], "after Week 17 no QB alert"); t.equal(off.json.qb_window.state, "after_season");
  const pre = await run1("2026-08-20T15:00:00Z");
  t.deepEqual(pre.json.findings, [], "before the contract deadline no QB alert"); t.equal(pre.json.qb_window.state, "before_season");
});

await run("qb_trade_window");
restore();
