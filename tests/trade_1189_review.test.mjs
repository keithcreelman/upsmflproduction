// Independent review of #1189 (2026-10-09) — the fixes, each with the scenario that broke it.
//   1. ANOTHER SEASON'S CALENDAR VALUE: the league calendar holds ONE season and the Commish Settings panel re-sends every
//      field on Save, so changing Season to 2027 while the deadline still reads 2026-09-06T23:59 stored a 2026 instant as
//      2027's (and a Push wrote 2027 league_events rows dated 2026). Taken at face value 2027 was "after the deadline" all
//      offseason: restructures/extensions locked, the trade gates in-season (30 + five QBs). Now ignored, next source tried.
//   2. AN UNESTABLISHED SEASON WINDOW IS NAMED: which calendar input is missing, in words, and that the commissioner sets it —
//      a missing input refuses the Accept with 409 (it won't fix itself), not a 503 "try again in a moment".
//   3. NO FAIL-OPEN WINDOW: an unknown phase with no candidates, or a phase that isn't one of canon's, is "nothing is known".
//   4. The taxi-eligibility reason for a player with no Rookie Draft record in his first 3 league years.
// Fake MFL and an in-memory D1 only; nothing here reaches a real service.
//   node tests/trade_1189_review.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { tradeSeasonWindow, resolveAuctionStart, candidateRosterMaxes, windowReasonText, CALENDAR_FIX_TEXT } from "../worker/src/trade_season_window.js";
import { resolveContractDeadline, deadlineState, isOtherSeasonValue } from "../worker/src/contract_deadline.js";
import { evaluateTradeCompliance } from "../worker/src/trade_cap_authority.js";
import { evaluateTaxiDestinations } from "../worker/src/trade_taxi_destination.js";
import { checkRestructureWindow } from "../worker/src/restructure_cap.js";
import { makeWorkerEnv, makeMfl, callWorker, quiet, bindSelf, NFL_2026_WEEKS } from "./fixtures/worker_harness.mjs";
import { DISCORD } from "./fixtures/trade_3way_fixture.mjs";

const restore = quiet();
const U = (iso) => Math.floor(Date.parse(iso) / 1000);
// what production would hold after the commissioner changes the panel's Season to 2027 and saves (every field re-sent as is)
const STALE_2027 = { season: "2027", faa: { faa_open_at: "2026-07-25T12:00", contract_deadline_at: "2026-09-06T23:59", trade_deadline_at: "2026-11-25T20:00" }, read_error: "" };
const W17_2027 = { GBP: U("2028-01-03T20:15:00-05:00") };   // a plausible 2027 Week 17 (MFL publishes it each May)
const APRIL_2027 = U("2027-04-15T12:00:00-04:00");

test("1. a calendar value from ANOTHER season is ignored: 2027 falls through to its own league_events date, never the 2026 instant", () => {
  t.equal(isOtherSeasonValue("2026-09-06T23:59", "2027"), true); t.equal(isOtherSeasonValue("2027-09-05", "2027"), false);
  t.equal(isOtherSeasonValue("Sept 6", "2027"), false, "a malformed value is left to the malformed-value check"); t.equal(isOtherSeasonValue("2026-09-06", "x"), false);
  const cd = resolveContractDeadline({ season: "2027", calendar: STALE_2027, eventDay: "2027-09-05" });
  t.equal(cd.source, "league_events_day", "production's real 2027 row (a date, no time)"); t.equal(cd.day, "2027-09-05");
  t.deepEqual(cd.ignored, ['calendar contract_deadline_at "2026-09-06T23:59" is not in season 2027']);
  t.equal(deadlineState(cd, APRIL_2027), "before", "April 2027 is BEFORE the 2027 deadline (it read 'after' before the fix)");
  const au = resolveAuctionStart({ season: "2027", calendar: STALE_2027, eventDay: null });
  t.equal(au.source, "none"); t.deepEqual(au.ignored, ['calendar faa_open_at "2026-07-25T12:00" is not in season 2027']);
  // the stale calendar PUSHED: league_events rows for 2027 dated 2026 — ignored too, so nothing is known (never "after")
  const pushed = resolveContractDeadline({ season: "2027", calendar: STALE_2027, eventDay: "2026-09-06" });
  t.equal(pushed.source, "none"); t.equal(pushed.ignored.length, 2); t.equal(deadlineState(pushed, APRIL_2027), "unknown");
  t.equal(resolveAuctionStart({ season: "2027", calendar: null, eventDay: "2026-07-25" }).source, "none");
  // unchanged: the 2026 calendar for 2026, the pinned 2026 instant, a calendar without a season, a calendar for another season
  t.equal(resolveContractDeadline({ season: "2026", calendar: { season: "2026", faa: { contract_deadline_at: "2026-09-06T23:59" } } }).source, "calendar");
  t.equal(resolveContractDeadline({ season: "2026", calendar: { season: "2026", faa: { contract_deadline_at: "2025-09-07T23:59" } } }).source, "pinned", "a stale 2025 value in the 2026 row falls back to the approved 2026 instant");
  t.equal(resolveContractDeadline({ season: "2027", calendar: { season: null, faa: { contract_deadline_at: "2027-09-05T23:59" } } }).source, "calendar");
  t.equal(resolveContractDeadline({ season: "2027", calendar: { season: null, faa: { contract_deadline_at: "2026-09-06T23:59" } } }).source, "none");
});

test("1. the TRADE WINDOW in April 2027 with that stale calendar is the offseason/auction question it really is — not in-season 30 + five QBs", () => {
  const w = tradeSeasonWindow({ nowUnix: APRIL_2027, auctionStart: resolveAuctionStart({ season: "2027", calendar: STALE_2027 }),
    contractDeadline: resolveContractDeadline({ season: "2027", calendar: STALE_2027, eventDay: "2027-09-05" }), week17Kickoffs: W17_2027 });
  t.deepEqual(w.candidates, ["offseason", "auction"]); t.equal(w.reason, "auction_start_other_season");
  t.equal(w.reason_text, "the league calendar's FA Auction start is from another season, not 2027"); t.equal(w.calendar_input_missing, true);
  t.equal(w.boundaries.ignored.length, 2);
  // (before the fix: auction "after" 2026-07-25 + deadline "after" 2026-09-06 + a plausible Week 17 → ["in_season"])
  const c = trade({ receiverActive: 30, receiverQbs: 5, arrivingQb: true, window: w });
  t.equal(c.roster_limit.status, "ok", "31 fits every limit that could apply in April (none, or 35)");
  t.equal(c.qb_limit.status, "not_applicable", "no candidate phase has the five-QB trade rule");
});

test("1. through the REAL loader and the RESTRUCTURE window (D1): that stale calendar no longer locks 2027 restructures in April", async () => {
  const env = makeWorkerEnv({});
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS league_events (event TEXT, date TEXT, nfl_season TEXT, description TEXT)");
  env.UPS_MFL_DB.raw.prepare("INSERT OR REPLACE INTO ups_settings (key, value, updated_at) VALUES ('auction_calendar', ?, 'x')").run(JSON.stringify({ season: "2027", faa: STALE_2027.faa }));
  env.UPS_MFL_DB.raw.prepare("INSERT INTO league_events (event, date, nfl_season, description) VALUES ('ups_contract_deadline', '2027-09-05', '2027', 'x')").run();
  const open = await checkRestructureWindow(env, { season: "2027", nowUnix: APRIL_2027 });
  t.equal(open.open, true, `open in April 2027: ${JSON.stringify(open)}`);
  // and after a stale PUSH (2027 rows dated 2026) it refuses AND says why — never "closed at the deadline"
  env.UPS_MFL_DB.raw.prepare("UPDATE league_events SET date = '2026-09-06' WHERE event = 'ups_contract_deadline'").run();
  const stale = await checkRestructureWindow(env, { season: "2027", nowUnix: APRIL_2027 });
  t.equal(stale.open, false); t.equal(stale.reason, "window_unreadable"); t.match(stale.detail, /No contract deadline on file for 2027/);
});

test("2. reason codes become words; a calendar input says who fixes it", () => {
  t.equal(windowReasonText("contract_deadline_not_set,auction_start_not_set", "2028"), "the 2028 contract deadline isn't on the league calendar; the 2028 FA Auction start isn't on the league calendar");
  t.equal(windowReasonText(["week17_schedule_unreadable"], "2026"), "MFL's 2026 NFL Week 17 schedule couldn't be read");
  t.equal(windowReasonText(["something_new"], "2026"), "something new", "an unknown code still reads as words");
  // 2028: no calendar, no league_events row — every phase possible, every gate that depends on it refuses, and says why
  const w = tradeSeasonWindow({ nowUnix: U("2028-03-01T12:00:00Z"), auctionStart: resolveAuctionStart({ season: "2028", calendar: null }),
    contractDeadline: resolveContractDeadline({ season: "2028", calendar: null }), week17Kickoffs: {} });
  t.equal(w.phase, "unknown"); t.deepEqual(w.candidates, ["offseason", "auction", "in_season"]); t.equal(w.calendar_input_missing, true);
  const c = trade({ receiverActive: 30, receiverQbs: 5, arrivingQb: true, window: w });
  t.equal(c.roster_limit.status, "unavailable"); t.equal(c.qb_limit.status, "unavailable");
  t.equal(c.roster_limit.message, `We couldn't confirm which roster limit applies right now: the 2028 contract deadline isn't on the league calendar; the 2028 FA Auction start isn't on the league calendar; MFL's 2028 NFL Week 17 schedule couldn't be read. This trade depends on it — a team would be over 30. ${CALENDAR_FIX_TEXT}`);
  t.match(c.qb_limit.message, /^We couldn't confirm whether the in-season five-QB limit applies right now: the 2028 contract deadline isn't on the league calendar/);
  t.match(c.qb_limit.message, /Commish Settings → Update League Calendar/);
  t.equal(c.roster_limit.window.calendar_input_missing, true);
  // an unreadable calendar is a READ failure: words, but no "the commissioner sets it"
  const r = tradeSeasonWindow({ nowUnix: U("2026-10-01T12:00:00Z"), auctionStart: resolveAuctionStart({ season: "2026", calendar: { read_error: "D1 CPU" } }),
    contractDeadline: resolveContractDeadline({ season: "2026", calendar: { read_error: "D1 CPU" } }), week17Kickoffs: {} });
  t.equal(r.calendar_input_missing, false); t.doesNotMatch(trade({ receiverActive: 30, window: r }).roster_limit.message, /Commish Settings/);
});

test("3. NO FAIL-OPEN WINDOW: no candidates, an unknown phase name, or a window carrying its own (wrong) maximum never loosens the limit", () => {
  t.deepEqual(candidateRosterMaxes({ phase: "unknown", candidates: [] }), { strict: 30, lenient: null });
  t.deepEqual(candidateRosterMaxes({ phase: "unknown", candidates: ["bogus"] }), { strict: 30, lenient: null });
  t.deepEqual(candidateRosterMaxes(null), { strict: 30, lenient: null });
  // before: candidates [] → strict null → "ok" for ANY count
  const empty = trade({ receiverActive: 30, window: { phase: "unknown", candidates: [], reason: "window_load_failed" } });
  t.equal(empty.roster_limit.status, "unavailable", "31 with nothing known is refused, not waved through");
  // before: a phase name canon doesn't have → roster_max undefined → "not_applicable", executable
  const bogus = trade({ receiverActive: 30, receiverQbs: 5, arrivingQb: true, window: { phase: "preseason", roster_max: null, qb_limit: false } });
  t.equal(bogus.roster_limit.status, "unavailable"); t.equal(bogus.roster_limit.executable, false); t.equal(bogus.qb_limit.status, "unavailable");
  t.equal(bogus.roster_limit.window.reason, "window_malformed");
  // before: an in_season window object carrying roster_max null / qb_limit false was obeyed → no limit at all
  const lying = trade({ receiverActive: 30, receiverQbs: 5, arrivingQb: true, window: { phase: "in_season", candidates: ["in_season"], roster_max: null, qb_limit: false } });
  t.deepEqual([lying.roster_limit.status, lying.roster_limit.max, lying.qb_limit.status], ["blocked", 30, "blocked"], "canon's numbers for the phase");
});

test("4. TAXI: a player with no Rookie Draft pick in his first 3 league years is told exactly that (not 'no record')", () => {
  const out = evaluateTaxiDestinations({ season: 2026, arrivals: [{ player_id: "15000", contract_status: "Rookie-Draft", nfl_team: "DAL" }], draftPicks: {}, callupCounts: {}, priorSeasonActive: new Set(), kickoffByTeam: {}, nowUnix: U("2026-10-09T12:00:00Z") });
  t.equal(out["15000"].reason, "not_drafted"); t.equal(out["15000"].eligible, false);
  t.equal(out["15000"].text, "he isn't a UPS Rookie Draft pick from his first 3 league years (only Round 2+ picks in those years are taxi-eligible)");
});

// ── the real two-team ACCEPT route: a missing calendar input is a 409 that names it, never a 503 "try again" ──
const Q = "L=74598&YEAR=2026";
const C = { contractYear: "2", contractStatus: "Rookie-Draft", contractInfo: "CL 3| TCV 6K| AAV 2K| Y1-2K, Y2-2K, Y3-2K" };
const P = (id, status) => ({ id: String(id), salary: 500, status: status || "ROSTER", ...C });
const asset = (pid) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary: 500, taxi: false, contract_info: C.contractInfo });
const pick = (key) => ({ asset_id: key, type: "PICK", description: key });
const payload = (left, right) => ({ schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [{ role: "left", franchise_id: "0001", selected_assets: left, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0 },
    { role: "right", franchise_id: "0002", selected_assets: right, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0 }],
  extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" } });
function world(receiverSize, calendar) {
  const env = makeWorkerEnv({});
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_taxi_callups (id INTEGER PRIMARY KEY, league_id TEXT, season TEXT, franchise_id TEXT, player_id TEXT, nfl_week INTEGER, pending INTEGER)");
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  env.UPS_MFL_DB.raw.prepare("INSERT OR REPLACE INTO ups_settings (key, value, updated_at) VALUES ('auction_calendar', ?, 'x')").run(JSON.stringify(calendar));
  const mfl = makeMfl(); mfl.st.league = { rosterSize: "35", taxiSquad: "10" };
  mfl.st.positions = { 14056: "WR" };
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
const NO_AUCTION = { season: "2026", faa: { contract_deadline_at: "2026-09-06T23:59" } };   // the FA Auction start never entered

test("2. ROUTE (Accept): the FA Auction start isn't on the calendar and the trade depends on it (35 → 36) → 409 roster_limit_calendar_missing, in words; MFL never asked", async () => {
  const { env, mfl } = world(35, NO_AUCTION);
  const r = await at("2026-07-01T16:00:00Z", () => sendAndAccept(env, mfl));
  t.ok(r.send.status < 300, `Send is allowed (the roster maximum never blocks Send): ${r.send.status} ${r.send.text.slice(0, 160)}`);
  t.equal(r.accept.status, 409, r.accept.text.slice(0, 300)); t.equal(r.accept.json.code, "roster_limit_calendar_missing");
  t.match(r.accept.json.message, /^We couldn't confirm which roster limit applies right now: the 2026 FA Auction start isn't on the league calendar\. This trade depends on it — a team would be over 35\. The commissioner sets it in Commish Settings → Update League Calendar; until then a trade that depends on it can't be accepted\. Nothing was changed\.$/);
  t.doesNotMatch(r.accept.json.message, /try again/i, "it won't fix itself in a moment");
  t.equal(mfl.st.done.filter((d) => d.response === "accept").length, 0, "MFL was never asked to accept");
  // the same trade that fits every possible limit (34 → 35) goes through; once the start is entered, 35 → 36 is blocked as over 35
  const fits = world(34, NO_AUCTION); const ok = await at("2026-07-01T16:00:00Z", () => sendAndAccept(fits.env, fits.mfl));
  t.equal(ok.accept.status, 200, ok.accept.text.slice(0, 200));
  const set = world(35, { season: "2026", faa: { contract_deadline_at: "2026-09-06T23:59", faa_open_at: "2026-06-30T12:00" } });
  const b = await at("2026-07-01T16:00:00Z", () => sendAndAccept(set.env, set.mfl));
  t.equal(b.accept.status, 409); t.equal(b.accept.json.code, "roster_room_required");
});

// ── 5. the 3-way SEND: canon §B1 "no War Room trade (two-team or 3-way) can be SENT or accepted if either team would have more
// than five QBs on its active roster right after MFL executes the trade". The two-team Send refused it; the 3-way create did not
// (the execute gate caught it, but only after both partners had been invited). ──
function threeWayCreate(cbpQbs) {
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: "0" });
  const mfl = makeMfl({}); mfl.install(); bindSelf(env);
  for (const [fid, d] of [["0008", DISCORD.A], ["0001", DISCORD.B], ["0002", DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", d);
  const qbs = Array.from({ length: cbpQbs }, (_, i) => String(9101 + i));
  mfl.st.positions = { 16614: "WR", 16181: "QB", 13100: "WR", ...Object.fromEntries(qbs.map((id) => [id, "QB"])) };
  mfl.st.rosters = {
    "0008": [{ id: "16614", salary: 5000, contractStatus: "Vet-FAA" }],
    "0001": [{ id: "16181", salary: 5000, contractStatus: "Vet-FAA" }],
    "0002": [{ id: "13100", salary: 5000, contractStatus: "Vet-FAA" }, ...qbs.map((id) => ({ id, salary: 1000, contractStatus: "Vet-FAA" }))],
  };
  return { env, mfl };
}
const create3WayBody = { initiator: { fid: "0008", name: "Real Deal Creel" }, team_b: { fid: "0001", name: "L.A. Looks" }, team_c: { fid: "0002", name: "CBP" },
  movements: [{ from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0 }, { from: "0001", to: "0002", asset_tokens: ["P_16181"], cap_k: 0 }, { from: "0002", to: "0008", asset_tokens: ["P_13100"], cap_k: 0 }] };
test("5. 3-WAY SEND (in-season): a 3-way that would leave a PARTNER with 6 active QBs is refused at create — nothing stored, nobody DMed; at 5 it's created", async () => {
  await at("2026-10-01T16:00:00Z", async () => {
    const { env, mfl } = threeWayCreate(5);
    const r = await callWorker(env, "POST", `/api/trades/3way?L=74598&YEAR=2026&MFL_USER_ID=tok-A`, { body: create3WayBody });
    t.equal(r.status, 409, r.text.slice(0, 300)); t.equal(r.json.code, "qb_limit_exceeded");
    t.match(r.json.error, /^CBP would have 6 QBs on the active roster right after this trade — the maximum is 5\./);
    t.deepEqual(r.json.teams, [{ franchise_id: "0002", franchise_name: "CBP", active_qbs_after: 6, max: 5 }]);
    t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_3way_trades").get().n, 0, "nothing stored");
    t.equal(mfl.st.discord.filter((d) => /\/messages$/.test(d.url)).length, 0, "no partner was invited");
    t.equal(mfl.writes().length, 0, "no MFL write");
    const fine = threeWayCreate(4);
    const ok = await callWorker(fine.env, "POST", `/api/trades/3way?L=74598&YEAR=2026&MFL_USER_ID=tok-A`, { body: create3WayBody });
    t.equal(ok.status, 201, ok.text.slice(0, 300));
  });
  // before the contract deadline the five-QB trade rule doesn't apply: the same 6-QB 3-way is created
  await at("2026-08-20T16:00:00Z", async () => {
    const { env } = threeWayCreate(5);
    const r = await callWorker(env, "POST", `/api/trades/3way?L=74598&YEAR=2026&MFL_USER_ID=tok-A`, { body: create3WayBody });
    t.equal(r.status, 201, `pre-deadline: ${r.text.slice(0, 200)}`);
  });
});

await run("trade_1189_review");
restore();

// a two-team trade: the receiver (0002) gets one player (a QB when arrivingQb); the sender gives a pick back
function trade({ receiverActive, receiverQbs, arrivingQb, window }) {
  const ok = (data) => ({ ok: true, data });
  const pos = { 9000: arrivingQb ? "QB" : "WR" };
  const recv = Array.from({ length: receiverActive }, (_, i) => { const id = String(6000 + i); pos[id] = i < (receiverQbs || 0) ? "QB" : "WR"; return { id, salary: "500", status: "ROSTER" }; });
  return evaluateTradeCompliance({
    league: ok({ league: { salaryCapAmount: "300000", rosterSize: "30", taxiSquad: "10", franchises: { franchise: [{ id: "0001", name: "L.A. Looks" }, { id: "0002", name: "CBP" }] } } }),
    salaries: ok({ salaries: { leagueUnit: { player: [] } } }), adjustments: ok({ salaryAdjustments: { salaryAdjustment: [] } }),
    players: ok({ players: { player: Object.entries(pos).map(([id, position]) => ({ id, position, name: `P${id}` })) } }),
    rosters: ok({ rosters: { franchise: [{ id: "0001", player: [{ id: "9000", salary: "500", status: "ROSTER" }, ...Array.from({ length: 28 }, (_, i) => ({ id: String(5000 + i), salary: "500", status: "ROSTER" }))] }, { id: "0002", player: recv }] } }),
    movements: [{ from: "0001", to: "0002", tokens: ["9000"] }, { from: "0002", to: "0001", tokens: ["FP_0002_2027_3"] }],
    seasonWindow: window,
  });
}
