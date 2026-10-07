// The roster-maximum and five-active-QB gates through the REAL worker routes (Keith 2026-10-07), plus the
// after-trade check for trades accepted on MFL's own site. Stateful fake MFL + Discord; no real write anywhere.
//   node tests/trade_roster_qb_routes.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const COMMISH = "621530026831118346", OWNER_0002 = "222222222222222222";
const C = { contractYear: "2", contractStatus: "Rookie-Draft", contractInfo: "CL 3|TCV 6K|AAV 2K|Y1-2K, Y2-2K, Y3-2K" };
const P = (id, status, salary) => ({ id: String(id), salary: salary == null ? 2000 : salary, status: status || "ROSTER", ...C });
const fill = (start, n, status) => Array.from({ length: n }, (_, i) => P(start + i, status));
const asset = (pid, taxi) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary: 2000, taxi: !!taxi, contract_info: C.contractInfo });
const pick = (key) => ({ asset_id: key, type: "PICK", description: key });
const payload = (left, right) => ({ schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [{ role: "left", franchise_id: "0001", selected_assets: left, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0 },
    { role: "right", franchise_id: "0002", selected_assets: right, traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0 }],
  extension_requests: [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" } });

function fresh(opts) {
  const env = makeWorkerEnv({ COMMISH_DISCORD_USER_ID: COMMISH, TRADE_ROSTER_CHECK_ENABLED: "1", TRADE_ROSTER_CHECK_SINCE: "2026-01-01T00:00:00Z", ...(opts && opts.env) });
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners (franchise_id, active_owner, discord_user_id) VALUES ('0002','Y',?)").run(OWNER_0002);
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_taxi_callups (id INTEGER PRIMARY KEY, league_id TEXT, season TEXT, franchise_id TEXT, player_id TEXT, nfl_week INTEGER, pending INTEGER)");
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_bot_heartbeat (bot TEXT PRIMARY KEY, last_ts INTEGER NOT NULL, status TEXT DEFAULT 'ok', env TEXT DEFAULT '')");
  const mfl = makeMfl();
  mfl.st.league = { rosterSize: "30", taxiSquad: "10" };
  mfl.st.positions = { ...(opts && opts.positions) };
  // this week's NFL schedule: every test player's team ("TST") kicks off in 3 days, so nobody is locked
  mfl.st.exportBody = { liveScoring: { liveScoring: { week: "6" } }, nflSchedule: { nflSchedule: { week: "6", matchup: [{ kickoff: String(Math.floor(Date.now() / 1000) + 3 * 86400), team: [{ id: "TST" }, { id: "OPP" }] }] } } };
  mfl.install();
  return { env, mfl };
}
async function send(env, mfl, p) {
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "", payload: p } });
  return { r, id: r.status < 300 ? mfl.st.pending[mfl.st.pending.length - 1].trade_id : null };
}
const act = (env, id, action) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: action || "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "" } });
const accepts = (mfl) => mfl.st.done.filter((d) => d.response === "accept").length;
const dms = (mfl) => mfl.st.discord.filter((d) => /\/messages$/.test(d.url) && /Roster check|Copy of what|Commissioner review/.test(String(d.body && d.body.content)));

test("ROSTER: 30 active + 2 in, 1 out = 31 → the War Room accept is refused BEFORE MFL; the team and the move it needs are named", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters = { "0001": [P(14056), P(14057), ...fill(5000, 28)], "0002": [P(13100), ...fill(6000, 29)] };
  const { r, id } = await send(env, mfl, payload([asset(14056), asset(14057)], [asset(13100)]));
  t.ok(r.status < 300, `Send is allowed (the roster maximum is required before ACCEPT): ${r.status} ${r.text.slice(0, 160)}`);
  const pv = await act(env, id, "PREVIEW");
  t.equal(pv.json.compliance.roster_limit.status, "blocked"); t.equal(pv.json.roster_limit_block.code, "roster_room_required");
  const a = await act(env, id);
  t.equal(a.status, 409, a.text.slice(0, 200)); t.equal(a.json.code, "roster_room_required");
  t.match(a.json.message, /CBP would have 31 active players right after this trade — the maximum is 30\. CBP must first make 1 legal roster move/);
  t.equal(accepts(mfl), 0, "MFL was never asked to accept"); t.equal(mfl.st.pending.length, 1, "the offer stays pending");
});

test("ROSTER: an arriving TAXI-ELIGIBLE player with a valid destination is credited — 29 + 2 in = 31 actual, 30 after his taxi move → allowed", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters = { "0001": [P(14056), P(17075, "TAXI_SQUAD"), ...fill(5000, 28)], "0002": [...fill(6000, 29)] };
  mfl.st.futurePicks["0002"] = [{ year: 2027, round: 2 }];
  mfl.st.draftPicks = [{ round: "2", pick: "5", franchise: "0001", player: "17075" }];          // UPS 2.05, current season
  mfl.st.positions = { "14056": "WR", "17075": "WR" };
  const { r, id } = await send(env, mfl, payload([asset(14056), asset(17075, true)], [pick("FP_0002_2027_2")]));
  t.ok(r.status < 300, r.text.slice(0, 200));
  const pv = await act(env, id, "PREVIEW");
  const row = pv.json.compliance.roster_limit.rows.find((x) => x.franchise_id === "0002");
  t.equal(row.active_after, 31, "the ACTUAL count shown first"); t.equal(row.active_after_taxi, 30, "and the count once he's on taxi");
  t.equal(JSON.stringify(row.taxi_moves.map((m) => m.player_id)), JSON.stringify(["17075"]));
  t.equal(pv.json.compliance.roster_limit.status, "ok");
  const capRow = pv.json.compliance.cap.rows.find((x) => x.franchise_id === "0002");
  t.equal(capRow.used_after - capRow.used_before, 4000, "the cap carries BOTH salaries — no credit for an unverified move");
  const a = await act(env, id);
  t.equal(a.status, 200, a.text.slice(0, 200)); t.equal(a.json.executed, true); t.equal(accepts(mfl), 1);
});

test("ROSTER: the same trade with the player's call-ups used up (permanent) is NOT credited → refused, and the reason is named", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters = { "0001": [P(14056), P(17075, "TAXI_SQUAD"), ...fill(5000, 28)], "0002": [...fill(6000, 29)] };
  mfl.st.futurePicks["0002"] = [{ year: 2027, round: 2 }];
  mfl.st.draftPicks = [{ round: "2", pick: "5", franchise: "0001", player: "17075" }];
  for (let w = 1; w <= 4; w += 1) env.UPS_MFL_DB.raw.prepare("INSERT INTO ups_taxi_callups (league_id, season, franchise_id, player_id, nfl_week, pending) VALUES ('74598','2026','0010','17075',?,0)").run(w);
  const { id } = await send(env, mfl, payload([asset(14056), asset(17075, true)], [pick("FP_0002_2027_2")]));
  const a = await act(env, id);
  t.equal(a.status, 409); t.equal(a.json.code, "roster_room_required");
  t.match(a.json.message, /P17075, Test|player 17075|17075/); t.match(a.json.message, /used all 3 taxi call-ups/);
  t.equal(accepts(mfl), 0);
});

test("QB: at SEND, a trade that would give a team 6 active QBs is refused before any MFL write; taxi and IR QBs don't count", async () => {
  const { env, mfl } = fresh({ positions: { 9001: "QB", 9002: "QB", 9003: "QB", 9004: "QB", 9005: "QB", 9006: "QB", 9007: "QB", 9008: "QB", 13100: "WR" } });
  mfl.st.rosters = { "0001": [P(9001), ...fill(5000, 28)], "0002": [P(9002), P(9003), P(9004), P(9005), P(9006), P(9007, "TAXI_SQUAD"), P(9008, "INJURED_RESERVE"), P(13100), ...fill(6000, 22)] };
  const proposals = mfl.writes("tradeProposal").length;
  const { r } = await send(env, mfl, payload([asset(9001)], [asset(13100)]));
  t.equal(r.status, 409, r.text.slice(0, 200)); t.equal(r.json.code, "qb_limit_exceeded"); t.equal(r.json.who, "recipient");
  t.match(r.json.message, /CBP would have 6 QBs on the active roster after this trade — the maximum is 5 \(taxi and IR QBs don't count\)/);
  t.equal(mfl.writes("tradeProposal").length, proposals, "nothing was proposed to MFL");
});

test("QB: an offer sent at 5 is refused at ACCEPT if the team has added a QB since — rechecked live", async () => {
  const { env, mfl } = fresh({ positions: { 9001: "QB", 9002: "QB", 9003: "QB", 9004: "QB", 9005: "QB", 9009: "QB", 13100: "QB" } });
  mfl.st.rosters = { "0001": [P(9001), ...fill(5000, 28)], "0002": [P(9002), P(9003), P(9004), P(13100), ...fill(6000, 23)] };   // 27 active, 4 QBs
  const { r, id } = await send(env, mfl, payload([asset(9001)], [asset(13100)]));
  t.ok(r.status < 300, r.text.slice(0, 160));
  mfl.st.rosters["0002"].push(P(9005), P(9009));                                                     // two QB adds after the offer
  const a = await act(env, id);
  t.equal(a.status, 409); t.equal(a.json.code, "qb_limit_exceeded"); t.equal(accepts(mfl), 0);
});

test("AFTER-TRADE CHECK (accepted on MFL's site): the over-limit owner and the commissioner each get ONE DM; a rerun sends none", async () => {
  const { env, mfl } = fresh({ positions: { 6000: "WR" } });
  mfl.st.rosters = { "0001": fill(5000, 28), "0002": fill(6000, 31) };
  mfl.st.transactions = [{ type: "TRADE", timestamp: String(Math.floor(Date.now() / 1000) - 600), franchise: "0001", franchise2: "0002", franchise1_gave_up: "5100,", franchise2_gave_up: "FP_0002_2027_2," }];
  const dry = await callWorker(env, "POST", `/admin/trades/roster-check?${Q}&APIKEY=${ADMIN_KEY}`, { body: { season: "2026", league_id: "74598", dry_run: true } });
  t.equal(dry.status, 200); t.equal(dry.json.findings.length, 1); t.equal(dry.json.findings[0].action, "would_notify"); t.equal(dms(mfl).length, 0, "a dry run sends nothing");
  const r = await callWorker(env, "POST", `/admin/trades/roster-check?${Q}&APIKEY=${ADMIN_KEY}`, { body: { season: "2026", league_id: "74598" } });
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(r.json.notified, 1);
  const f = r.json.findings[0];
  t.equal(f.franchise_id, "0002"); t.equal(f.kind, "roster"); t.equal(f.active, 31);
  t.match(f.message, /CBP has 31 active players — the maximum is 30\. Make 1 legal move to get back to 30/);
  t.match(f.message, /Nothing will be dropped, voided or penalized automatically\./);
  const sent = dms(mfl);
  t.equal(sent.length, 2, "owner + commissioner");
  const again = await callWorker(env, "POST", `/admin/trades/roster-check?${Q}&APIKEY=${ADMIN_KEY}`, { body: { season: "2026", league_id: "74598" } });
  t.equal(again.json.findings[0].action, "already_notified"); t.equal(dms(mfl).length, 2, "never twice");
  t.equal(mfl.writes().length, 0, "read-only on MFL: no import of any kind");
});

test("AFTER-TRADE CHECK: a War Room trade is skipped (its gates and #1187 cover it); unreadable MFL sends nothing", async () => {
  const { env, mfl } = fresh({ positions: { 6000: "WR" } });
  mfl.st.rosters = { "0001": fill(5000, 28), "0002": fill(6000, 31) };
  const ts = Math.floor(Date.now() / 1000) - 600;
  mfl.st.transactions = [{ type: "TRADE", timestamp: String(ts), franchise: "0001", franchise2: "0002", franchise1_gave_up: "5100,", franchise2_gave_up: "FP_0002_2027_2," }];
  env.UPS_MFL_DB.raw.prepare("INSERT INTO ups_trade_executions (league_id, season, exec_key, kind, state, participants, mfl_executed_at_utc, created_at_utc, updated_at_utc) VALUES ('74598','2026','2001','two_way','completed','0001,0002',?, ?, ?)")
    .run(new Date((ts + 2) * 1000).toISOString(), new Date().toISOString(), new Date().toISOString());
  const r = await callWorker(env, "POST", `/admin/trades/roster-check?${Q}&APIKEY=${ADMIN_KEY}`, { body: { season: "2026", league_id: "74598" } });
  t.equal(r.json.findings.length, 0); t.equal(dms(mfl).length, 0);
  mfl.st.exportFail = { rosters: 503 };
  const blind = await callWorker(env, "POST", `/admin/trades/roster-check?${Q}&APIKEY=${ADMIN_KEY}`, { body: { season: "2026", league_id: "74598" } });
  t.equal(blind.json.ok, false); t.equal(blind.json.error, "mfl_unreadable"); t.equal(dms(mfl).length, 0);
});

test("AFTER-TRADE CHECK ships OFF and needs the commissioner key", async () => {
  const { env } = fresh({ env: { TRADE_ROSTER_CHECK_ENABLED: "0" } });
  const off = await callWorker(env, "POST", `/admin/trades/roster-check?${Q}&APIKEY=${ADMIN_KEY}`, { body: { season: "2026", league_id: "74598" } });
  t.equal(off.json.skipped, "flag_off");
  const nokey = await callWorker(env, "POST", `/admin/trades/roster-check?${Q}`, { body: {} });
  t.ok(nokey.status === 401 || nokey.status === 403, String(nokey.status));
  const fs = await import("node:fs");
  t.match(fs.readFileSync(new URL("../worker/wrangler.toml", import.meta.url), "utf8"), /\nTRADE_ROSTER_CHECK_ENABLED = "0"\n/);
});

await run("trade_roster_qb_routes");
restore();
