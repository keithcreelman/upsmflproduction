// The roster-maximum and five-active-QB gates through the REAL worker routes (Keith 2026-10-07), plus the
// after-trade check for trades accepted on MFL's own site. Stateful fake MFL + Discord; no real write anywhere.
//   node tests/trade_roster_qb_routes.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet, ADMIN_KEY, NFL_2026_WEEKS } from "./fixtures/worker_harness.mjs";

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
  // (Weeks 1 and 17 are the real 2026 schedule — the five-QB limit's in-season window is built from them)
  mfl.st.exportBody = { liveScoring: { liveScoring: { week: "6" } }, nflSchedule: (q) => NFL_2026_WEEKS[q.W]
    ? { nflSchedule: { week: q.W, matchup: NFL_2026_WEEKS[q.W] } }
    : { nflSchedule: { week: "6", matchup: [{ kickoff: String(Math.floor(Date.now() / 1000) + 3 * 86400), team: [{ id: "TST" }, { id: "OPP" }] }] } } };
  mfl.install();
  return { env, mfl };
}
async function send(env, mfl, p) {
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "", payload: p } });
  return { r, id: r.status < 300 ? mfl.st.pending[mfl.st.pending.length - 1].trade_id : null };
}
const act = (env, id, action) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: action || "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "" } });
const accepts = (mfl) => mfl.st.done.filter((d) => d.response === "accept").length;
const dms = (mfl) => mfl.st.discord.filter((d) => /\/messages$/.test(d.url) && /Roster check|Copy of what|Commissioner review|could NOT be reached/.test(String(d.body && d.body.content)));
const check = (env, body) => callWorker(env, "POST", `/admin/trades/roster-check?${Q}&APIKEY=${ADMIN_KEY}`, { body: { season: "2026", league_id: "74598", ...(body || {}) } });
const tx = (secsAgo, a, b) => ({ type: "TRADE", timestamp: String(Math.floor(Date.now() / 1000) - secsAgo), franchise: a || "0001", franchise2: b || "0002", franchise1_gave_up: "5100,", franchise2_gave_up: "FP_0002_2027_2," });
const d1Snapshot = (env) => JSON.stringify(env.UPS_MFL_DB.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
  .map(({ name }) => [name, env.UPS_MFL_DB.raw.prepare(`SELECT * FROM "${name}"`).all()]));
const claims = (env) => { try { return env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_roster_check ORDER BY created_at_utc").all(); } catch (_) { return []; } };

test("ROSTER: 30 active + 2 in, 1 out = 31 → the War Room accept is refused BEFORE MFL; the team and the move it needs are named", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters = { "0001": [P(14056), P(14057), ...fill(5000, 28)], "0002": [P(13100), ...fill(6000, 29)] };
  const { r, id } = await send(env, mfl, payload([asset(14056), asset(14057)], [asset(13100)]));
  t.ok(r.status < 300, `Send is allowed (the roster maximum is required before ACCEPT): ${r.status} ${r.text.slice(0, 160)}`);
  const pv = await act(env, id, "PREVIEW");
  t.equal(pv.json.compliance.roster_limit.status, "blocked"); t.equal(pv.json.roster_limit_block.code, "roster_room_required");
  const a = await act(env, id);
  t.equal(a.status, 409, a.text.slice(0, 200)); t.equal(a.json.code, "roster_room_required");
  t.match(a.json.message, /CBP would have 31 active players right after this trade — the maximum is 30\. CBP needs 1 more roster spot: make 1 legal roster move first/);
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
  t.match(r.json.message, /CBP would have 6 QBs on the active roster right after this trade — the maximum is 5\. QBs MFL already shows on taxi or IR don't count; an arriving QB counts as active\./);
  t.equal(mfl.writes("tradeProposal").length, proposals, "nothing was proposed to MFL");
});

test("QB (Keith 2026-10-07): an arriving rookie QB off the sender's TAXI squad — taxi-eligible and flagged taxi — still counts ACTIVE: 5 + 1 = 6 → Send refused", async () => {
  const { env, mfl } = fresh({ positions: { 9002: "QB", 9003: "QB", 9004: "QB", 9005: "QB", 9006: "QB", 17030: "QB", 13100: "WR" } });
  mfl.st.rosters = { "0001": [P(17030, "TAXI_SQUAD"), ...fill(5000, 28)], "0002": [P(9002), P(9003), P(9004), P(9005), P(9006), P(13100), ...fill(6000, 22)] };
  mfl.st.draftPicks = [{ round: "2", pick: "3", franchise: "0001", player: "17030" }];
  const proposals = mfl.writes("tradeProposal").length;
  const { r } = await send(env, mfl, payload([asset(17030, true)], [asset(13100)]));
  t.equal(r.status, 409, r.text.slice(0, 200)); t.equal(r.json.code, "qb_limit_exceeded"); t.equal(r.json.who, "recipient");
  t.equal(JSON.stringify(r.json.teams), JSON.stringify([{ franchise_id: "0002", franchise_name: "CBP", active_qbs_after: 6, max: 5 }]));
  t.equal(mfl.writes("tradeProposal").length, proposals, "nothing was proposed to MFL");
  // after CBP moves one of its CURRENT QBs to taxi (a legal move MFL already shows), the same offer can be sent
  mfl.st.rosters["0002"][4].status = "TAXI_SQUAD";
  const again = await send(env, mfl, payload([asset(17030, true)], [asset(13100)]));
  t.ok(again.r.status < 300, again.r.text.slice(0, 200));
});

test("SEND warning (Keith 2026-10-07): the two-team preview shows the actual count, the count after the accept's taxi move, and the spots still needed; only players the offer sends to taxi are counted", async () => {
  const { env, mfl } = fresh();
  mfl.st.rosters = { "0001": [P(14056), P(14057), P(17075, "TAXI_SQUAD"), ...fill(5000, 27)], "0002": [...fill(6000, 30)] };
  mfl.st.draftPicks = [{ round: "2", pick: "5", franchise: "0001", player: "17075" }];
  const mv = [{ from: "0001", to: "0002", asset_tokens: ["14056", "14057", "17075"], cap_k: 0 }];
  const preview = (ids) => callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", movements: mv, ...(ids ? { taxi_step_player_ids: ids } : {}) } });
  const withStep = await preview(["17075"]);
  t.equal(withStep.status, 200, withStep.text.slice(0, 200));
  const row = withStep.json.compliance.roster_limit.rows.find((x) => x.franchise_id === "0002");
  t.equal(row.active_after, 33, "actual"); t.equal(row.active_after_taxi, 32, "after the taxi move the accept will make"); t.equal(row.moves_needed, 2);
  t.equal(withStep.json.compliance.roster_limit.violations[0].message,
    "CBP would have 33 active players right after this trade and 32 once player 17075 is moved to its taxi squad — the maximum is 30. CBP needs 2 more roster spots: make 2 legal roster moves first (for example, move an eligible injured player to IR), or revise the offer.");
  const noStep = await preview(null);
  t.equal(noStep.json.compliance.roster_limit.rows.find((x) => x.franchise_id === "0002").active_after_taxi, 33, "an offer that doesn't send him to taxi gets no credit");
  t.equal(mfl.writes().length, 0, "a preview never writes");
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

test("REVIEW (dry run): a dry run is READ-ONLY end to end — not one D1 row, heartbeat, claim table, DM or MFL import — even when it replays a wider window", async () => {
  const { env, mfl } = fresh({ positions: { 6000: "WR" } });
  mfl.st.rosters = { "0001": fill(5000, 28), "0002": fill(6000, 31) };
  mfl.st.transactions = [tx(600), tx(5 * 86400)];
  const before = d1Snapshot(env);
  const calls = [], mflFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => { const u = new URL(typeof input === "string" ? input : input.url); calls.push({ method: String((init && init.method) || (input && input.method) || "GET").toUpperCase(), host: u.hostname, path: u.pathname }); return mflFetch(input, init); };
  let r;
  try { r = await check(env, { dry_run: true, window_hours: 240, since: "2026-01-01T00:00:00Z" }); } finally { globalThis.fetch = mflFetch; }
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(r.json.window_hours, 240);
  t.deepEqual(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.host}${c.path}`), [], "no write-method request to ANY host (MFL, Discord, GitHub)");
  t.equal(calls.filter((c) => /github/.test(c.host)).length, 0, "no GitHub call at all");
  t.deepEqual(r.json.findings.map((f) => f.action), ["would_notify", "covered_by_open_alert"], "the older trade would alert; the newer one is covered by it");
  t.equal(d1Snapshot(env), before, "no D1 change of any kind (no heartbeat, no claim table)");
  t.equal(dms(mfl).length, 0); t.equal(mfl.writes().length, 0);
  const live = await check(env, { window_hours: 240 });
  t.equal(live.json.window_hours, 36, "only a dry run may widen the window");
});

test("REVIEW (3-way): a 3-way War Room leg is NOT treated as a native trade (its stamp follows its last leg); a later native trade between the same teams still is", async () => {
  const { env, mfl } = fresh({ positions: { 6000: "WR" } });
  mfl.st.rosters = { "0001": fill(5000, 28), "0002": fill(6000, 31) };
  const legTs = Math.floor(Date.now() / 1000) - 3600;
  mfl.st.transactions = [{ ...tx(0), timestamp: String(legTs) }];
  env.UPS_MFL_DB.raw.prepare("INSERT INTO ups_trade_executions (league_id, season, exec_key, kind, state, participants, mfl_executed_at_utc, created_at_utc, updated_at_utc) VALUES ('74598','2026','3w-1','three_way','completed','0003,0001,0002',?, ?, ?)")
    .run(new Date((legTs + 240) * 1000).toISOString(), new Date().toISOString(), new Date().toISOString());
  t.equal((await check(env)).json.findings.length, 0, "the leg belongs to the 3-way");
  t.equal(dms(mfl).length, 0);
  mfl.st.transactions.push(tx(600));
  const r = await check(env);
  t.deepEqual(r.json.findings.map((f) => f.action), ["notified"], "the native trade an hour later is checked");
});

test("REVIEW (dedupe): two native trades while the team stays over → ONE alert; once MFL shows it back within the limit the alert closes, and a NEW overage alerts again", async () => {
  const { env, mfl } = fresh({ positions: { 6000: "WR" } });
  mfl.st.rosters = { "0001": fill(5000, 28), "0002": fill(6000, 31) };
  mfl.st.transactions = [tx(1200), tx(600)];
  const r1 = await check(env);
  t.deepEqual(r1.json.findings.map((f) => f.action), ["notified", "covered_by_open_alert"]);
  t.equal(dms(mfl).length, 2, "owner + commissioner, once");
  t.deepEqual((await check(env)).json.findings.map((f) => f.action), ["already_notified", "covered_by_open_alert"]); t.equal(dms(mfl).length, 2);
  mfl.st.rosters["0002"] = fill(6000, 30);                                          // the team made its move
  const r3 = await check(env);
  t.deepEqual(r3.json.findings.map((f) => f.action), ["resolved"]); t.equal(claims(env)[0].status, "resolved");
  mfl.st.rosters["0002"] = fill(6000, 31); mfl.st.transactions.push(tx(0));           // a NEW trade, after the fix, puts it over again
  const r4 = await check(env);
  t.deepEqual(r4.json.findings.map((f) => f.action), ["before_resolution", "before_resolution", "notified"], "the two old trades can't start or block it; the new one alerts");
  t.equal(dms(mfl).length, 4, "the new overage is its own alert");
  t.equal(r4.json.findings[2].trade_ts, Number(mfl.st.transactions[2].timestamp), "and it is attributed to the NEW trade");
});

test("REVIEW (crash recovery): a 'sending' claim left by a run that never finished is retried after 15 minutes — and never while it is fresh", async () => {
  const { env, mfl } = fresh({ positions: { 6000: "WR" } });
  mfl.st.rosters = { "0001": fill(5000, 28), "0002": fill(6000, 31) };
  mfl.st.transactions = [tx(1200)];
  t.equal((await check(env, { dry_run: true })).json.findings[0].action, "would_notify");
  await check(env);                                                                  // creates the table + claim, notifies
  const key = claims(env)[0].check_key;
  const set = (status, ageSec) => env.UPS_MFL_DB.raw.prepare("UPDATE ups_trade_roster_check SET status = ?, updated_at_utc = ? WHERE check_key = ?").run(status, new Date(Date.now() - ageSec * 1000).toISOString(), key);
  const sent = dms(mfl).length;
  set("sending", 60);
  t.equal((await check(env)).json.findings[0].action, "already_notified", "a fresh claim belongs to a run still in flight"); t.equal(dms(mfl).length, sent);
  set("sending", 20 * 60);
  t.equal((await check(env, { dry_run: true })).json.findings[0].action, "would_retry_stale_send");
  t.equal((await check(env)).json.findings[0].action, "notified", "a stale claim is taken over and sent"); t.equal(dms(mfl).length, sent + 2);
  t.equal(claims(env)[0].status, "notified");
});

test("REVIEW (owner unreachable): the commissioner is told the owner could NOT be reached — never 'a copy of what was sent'", async () => {
  const { env, mfl } = fresh({ positions: { 6000: "WR" } });
  env.UPS_MFL_DB.raw.prepare("DELETE FROM discord_owners WHERE franchise_id = '0002'").run();
  mfl.st.rosters = { "0001": fill(5000, 28), "0002": fill(6000, 31) };
  mfl.st.transactions = [tx(600)];
  const r = await check(env);
  t.equal(r.json.findings[0].action, "notified"); t.equal(r.json.findings[0].notified_owner, 0); t.equal(r.json.findings[0].notified_commish, 1);
  const sent = dms(mfl);
  t.equal(sent.length, 1); t.match(sent[0].body.content, /^⚠️ CBP's owner could NOT be reached on Discord \(no linked account, or the DM failed\) — please pass this on: ⚠️ Roster check after your trade/);
  t.doesNotMatch(sent[0].body.content, /Copy of what/);
});

test("REVIEW (escalation): past the deadline and still over → ONE commissioner escalation, claimed before it is sent; never repeated", async () => {
  const { env, mfl } = fresh({ positions: { 6000: "WR" } });
  mfl.st.rosters = { "0001": fill(5000, 28), "0002": fill(6000, 31) };
  mfl.st.transactions = [tx(30 * 3600)];                                            // 30 h ago: inside the 36 h window, past the 24 h deadline
  const r1 = await check(env);
  t.equal(r1.json.findings[0].action, "notified");
  t.equal((await check(env, { dry_run: true })).json.findings[0].action, "would_escalate");
  const r2 = await check(env);
  t.equal(r2.json.findings[0].action, "escalated");
  t.equal(dms(mfl).filter((d) => /Commissioner review/.test(d.body.content)).length, 1);
  t.equal((await check(env)).json.findings[0].action, "already_notified");
  t.equal(dms(mfl).filter((d) => /Commissioner review/.test(d.body.content)).length, 1, "never twice");
  t.match(dms(mfl).find((d) => /Commissioner review/.test(d.body.content)).body.content, /Nothing has been dropped, voided or penalized\./);
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
