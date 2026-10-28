// Trade asset ELIGIBILITY through the REAL worker handler (Keith's rulings 2 and 3, 2026-10-28, #1385): the compliance preview, two-team
// create (/api/trades/proposals), staged two-team create (/api/trades/2way), three-team create (/api/trades/3way) and the two-team accept
// each judge players by the ONE shared rule (trade_rules.js tradeAssetEligibility) and refuse with a stable code:
//   409 player_not_tradeable            a provisional tag, an expired veteran, an expired rookie after the extension deadline
//   503 trade_eligibility_unavailable   the tag source could not be read before the deadline (fail closed)
//   409 cap_money_rule                  an expired rookie's 50% cap-money basis (his extension's new salary, else last season's), re-verified at accept
// Offline: D1 = node:sqlite (harness), MFL = the harness's stateful stub; any other outbound call throws. Nothing here writes to MFL
// except the harness's own simulated tradeProposal / tradeResponse, which never leaves the process.
//   node tests/trade_integration_eligibility.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const MAY = String(Date.parse("2026-05-15T16:00:00Z"));        // before the 2026 tag / rookie-extension deadline (2026-05-22 04:00 UTC)
const AUG = String(Date.parse("2026-08-20T16:00:00Z"));        // after it (the harness default)
const LOCK = { calendar: { calendar: { event: [{ id: "901", type: "TRADE", start_time: "1795654800" }] } } };
const STAGED = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];

const flat = (id, extra) => ({ id, salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K", ...(extra || {}) });
// 0001's player 14056 takes the shape a test needs; 0002 holds a plain flat contract.
function fresh({ now = AUG, p14056, env: envOver, migrations } = {}) {
  const env = makeWorkerEnv({ TWR_TEST_NOW_MS: now, ...(migrations ? { __migrations: migrations } : {}), ...(envOver || {}) });
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } });
  mfl.st.rosters["0001"] = [flat("14056", p14056)];
  mfl.st.rosters["0002"] = [flat("13100")];
  mfl.st.exportBody = LOCK;
  mfl.install();
  return { env, mfl };
}
const tagRow = (env, pid, lockedInAt) => {
  env.UPS_MFL_DB.raw.prepare("INSERT INTO ups_tag_master (league_id, season, franchise_id, tag_side, player_id) VALUES ('74598','2026','0001','OFFENSE',?)").run(pid);
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_tag_submissions (id INTEGER PRIMARY KEY, league_id TEXT, season TEXT, franchise_id TEXT, player_id TEXT, action TEXT, dry_run INTEGER DEFAULT 0, locked_in_at TEXT, submitted_at_utc TEXT)");
  env.UPS_MFL_DB.raw.prepare("INSERT INTO ups_tag_submissions (league_id, season, franchise_id, player_id, action, locked_in_at, submitted_at_utc) VALUES ('74598','2026','0001',?,'tag',?,'2026-04-01 12:00:00')").run(pid, lockedInAt);
};
const TAG = { contractStatus: "Tag", contractInfo: "CL 1|TCV 20K|AAV 20K|Tag", salary: "20000" };
const EXPIRED_VET = { contractYear: "0", contractStatus: "Vet-FAA", salary: "8000" };
const EXPIRED_ROOKIE = { contractYear: "0", contractStatus: "Rookie-Draft", salary: "", contractInfo: "" };

// ── the compliance preview ──
const preview = (env, movements, ext) => callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-B`, {
  body: { league_id: "74598", season: "2026", from_franchise_id: "0001", movements, extension_requests: ext || [] } });
const SWAP = [{ from: "0001", to: "0002", tokens: ["P_14056"] }, { from: "0002", to: "0001", tokens: ["P_13100"] }];

test("PREVIEW: a PROVISIONAL tag (tagged, not locked, before the deadline) is blocked — player_not_tradeable / tag_provisional", async () => {
  const { env, mfl } = fresh({ now: MAY, p14056: TAG });
  tagRow(env, "14056", null);
  const r = await preview(env, SWAP);
  t.equal(r.status, 200, r.text.slice(0, 200));
  t.equal(r.json.verdict.status, "blocked");
  t.equal(r.json.verdict.checks.assets, "blocked");
  t.ok(r.json.verdict.reasons.some((x) => x.code === "player_not_tradeable"), JSON.stringify(r.json.verdict.reasons));
  t.equal(r.json.verdict.send_ready, false);
  t.equal(mfl.st.imports.length, 0);
});

test("PREVIEW: an EARLY-LOCKED tag before the deadline is tradeable (the War Room used to refuse it) — but its pre-trade extension is refused", async () => {
  const { env, mfl } = fresh({ now: MAY, p14056: TAG });
  tagRow(env, "14056", "2026-05-01 12:00:00");
  const r = await preview(env, SWAP, [{ player_id: "14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "1YR", new_contract_length: 2, new_TCV: 50000, preview_contract_info_string: "CL 2| TCV 50K| AAV 25K| Y1-20K, Y2-30K" }]);
  t.equal(r.status, 200);
  t.ok(!r.json.verdict.reasons.some((x) => x.code === "player_not_tradeable"), "the asset check passes for a locked tag");
  t.equal(r.json.verdict.checks.assets, "ok");
  const skip = (r.json.compliance.extension_skipped || []).find((x) => x.player_id === "14056");
  t.ok(skip, "the extension of a locked tag is refused: " + JSON.stringify(r.json.compliance.extension_skipped));
  t.equal(mfl.st.imports.length, 0);
});

test("PREVIEW: after the deadline every tag is locked and tradeable, with NO D1 tag read at all", async () => {
  const { env } = fresh({ now: AUG, p14056: TAG });
  const db = env.UPS_MFL_DB, prepare = db.prepare.bind(db), sqls = [];
  db.prepare = (sql) => { sqls.push(sql); return prepare(sql); };
  const r = await preview(env, SWAP);
  t.equal(r.json.verdict.checks.assets, "ok");
  t.equal(sqls.filter((x) => /ups_tag_submissions/.test(x)).length, 0, "no lock-in read");
  t.equal(sqls.filter((x) => /FROM ups_tag_master WHERE season = \? AND league_id/.test(x)).length, 0, "no trade-gate tag read (the extension check has its own)");
});

test("PREVIEW: the tag source unreadable BEFORE the deadline → unavailable (never a pass)", async () => {
  const { env } = fresh({ now: MAY });
  env.UPS_MFL_DB.raw.exec("DROP TABLE ups_tag_master");
  const r = await preview(env, SWAP);
  t.equal(r.json.verdict.checks.assets, "unavailable");
  t.ok(r.json.verdict.reasons.some((x) => x.code === "trade_eligibility_unavailable"), JSON.stringify(r.json.verdict.reasons));
  t.notEqual(r.json.verdict.status, "provisional");
});

test("PREVIEW: an expired VETERAN is blocked (expired_veteran); an expired ROOKIE is fine before the deadline and blocked after it", async () => {
  let w = fresh({ now: MAY, p14056: EXPIRED_VET });
  let r = await preview(w.env, SWAP);
  t.equal(r.json.verdict.checks.assets, "blocked");
  t.ok(r.json.verdict.reasons.some((x) => x.code === "player_not_tradeable"));
  w = fresh({ now: MAY, p14056: EXPIRED_ROOKIE });
  r = await preview(w.env, SWAP);
  t.equal(r.json.verdict.checks.assets, "ok", "an expired rookie before the rookie-extension deadline");
  w = fresh({ now: AUG, p14056: EXPIRED_ROOKIE });
  r = await preview(w.env, SWAP);
  t.equal(r.json.verdict.checks.assets, "blocked", "an expired rookie after it");
});

// ── create + accept (two-team direct) ──
const player = (pid) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary: 5000, taxi: false, contract_info: "" });
const payloadOf = (fromCapK, ext) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [
    { role: "left", franchise_id: "0001", selected_assets: [player(14056)], traded_salary_adjustment_k: fromCapK || 0, traded_salary_adjustment_dollars: (fromCapK || 0) * 1000, selected_non_taxi_salary_dollars: 5000 },
    { role: "right", franchise_id: "0002", selected_assets: [player(13100)], traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0, selected_non_taxi_salary_dollars: 5000 },
  ],
  extension_requests: ext || [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" },
});
const send = (env, payload) => callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, {
  body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "x", to_franchise_name: "y", message: "", payload } });
const accept = (env, id) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "" } });
const accepted = (mfl) => mfl.st.done.filter((d) => d.response === "accept").length;
// Last season's salaries (MFL salaries export, season 2025): the expired rookie's prior-season salary.
const priorSalary = (mfl, dollars) => { mfl.st.salaries = [{ id: "14056", salary: String(dollars), contractYear: "1", contractStatus: "Rookie-Draft", contractInfo: "" }, { id: "13100", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }]; };

test("CREATE (two-team): an expired veteran is refused 409 player_not_tradeable; nothing reaches MFL", async () => {
  const { env, mfl } = fresh({ now: MAY, p14056: EXPIRED_VET });
  const r = await send(env, payloadOf(0));
  t.equal(r.status, 409, r.text.slice(0, 300));
  t.equal(r.json.code, "player_not_tradeable");
  t.equal(r.json.violations[0].reason, "expired_veteran");
  t.equal(mfl.st.pending.length, 0, "no offer was proposed to MFL");
});

test("CREATE (two-team): a provisional tag is refused; an EARLY-LOCKED one is sent (the old server copy of the War Room test refused it)", async () => {
  let w = fresh({ now: MAY, p14056: TAG });
  tagRow(w.env, "14056", null);
  let r = await send(w.env, payloadOf(0));
  t.equal(r.status, 409); t.equal(r.json.code, "player_not_tradeable"); t.equal(r.json.violations[0].reason, "tag_provisional");
  t.equal(w.mfl.st.pending.length, 0);
  w = fresh({ now: MAY, p14056: TAG });
  tagRow(w.env, "14056", "2026-05-10T00:00:00Z");
  r = await send(w.env, payloadOf(0));
  t.ok(r.status < 300, r.status + " " + r.text.slice(0, 300));
  t.equal(w.mfl.st.pending.length, 1, "the early-locked tag went out as an offer");
});

test("CREATE (two-team): the tag source unreadable before the deadline → 503 trade_eligibility_unavailable", async () => {
  const { env, mfl } = fresh({ now: MAY });
  env.UPS_MFL_DB.raw.exec("DROP TABLE ups_tag_master");
  const r = await send(env, payloadOf(0));
  t.equal(r.status, 503); t.equal(r.json.code, "trade_eligibility_unavailable");
  t.equal(mfl.st.pending.length, 0);
});

test("CAP MONEY (ruling 3): an expired rookie's 50% basis is his PRIOR-season salary; within it the offer goes out, over it it doesn't", async () => {
  let w = fresh({ now: MAY, p14056: EXPIRED_ROOKIE });
  priorSalary(w.mfl, 10000);                                         // max = floor(10,000 / 2,000) = $5K
  let r = await send(w.env, payloadOf(5));
  t.ok(r.status < 300, "$5K on a $10K prior salary: " + r.status + " " + r.text.slice(0, 300));
  w = fresh({ now: MAY, p14056: EXPIRED_ROOKIE });
  priorSalary(w.mfl, 10000);
  r = await send(w.env, payloadOf(6));
  t.equal(r.status, 400, "$6K is over");
  t.equal(r.json.code, "TRADE_CAP_MONEY_50PCT");
  t.equal(r.json.max_allowed_k, 5);
  t.equal(w.mfl.st.pending.length, 0);
});

test("CAP MONEY (ruling 3): with the expired rookie's pre-trade extension in the trade, the basis is its NEW current-season salary", async () => {
  const { env, mfl } = fresh({ now: MAY, p14056: EXPIRED_ROOKIE });
  priorSalary(mfl, 4000);                                            // prior basis would allow only $2K
  const ext = [{ player_id: "14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "1YR", new_contract_length: 1, preview_contract_info_string: "CL 1| TCV 16K| AAV 16K| Y1-16K" }];
  // The cap-money backstop runs before the extension is priced; it reads Y1 = $16K → max $8K. (The canonical price check that follows may still refuse the
  // extension itself — that is a different refusal, never TRADE_CAP_MONEY_50PCT.)
  const r = await send(env, payloadOf(8, ext));
  t.notEqual(r.json && r.json.code, "TRADE_CAP_MONEY_50PCT", r.text.slice(0, 300));
  const over = await send(fresh({ now: MAY, p14056: EXPIRED_ROOKIE }).env, payloadOf(9, ext));
  t.equal(over.json.code, "TRADE_CAP_MONEY_50PCT"); t.equal(over.json.max_allowed_k, 8);
});

test("ACCEPT re-verifies (ruling 3): last season's salary changed after the offer → the accept is refused 409 cap_money_rule, nothing executes", async () => {
  const { env, mfl } = fresh({ now: MAY, p14056: EXPIRED_ROOKIE });
  priorSalary(mfl, 10000);
  const r = await send(env, payloadOf(5));
  t.ok(r.status < 300, r.text.slice(0, 300));
  const id = mfl.st.pending[mfl.st.pending.length - 1].trade_id;
  priorSalary(mfl, 6000);                                           // now max = $3K
  const a = await accept(env, id);
  t.equal(a.status, 409, a.text.slice(0, 300));
  t.equal(a.json.code, "cap_money_rule");
  t.equal(a.json.violations[0].reason, "cap_money_over_50pct");
  t.equal(a.json.violations[0].max_dollars, 3000);
  t.equal(accepted(mfl), 0, "MFL was never asked to accept");
});

test("ACCEPT re-verifies (ruling 2): an expired rookie offered before the extension deadline is refused once it has passed", async () => {
  const { env, mfl } = fresh({ now: MAY, p14056: EXPIRED_ROOKIE });
  priorSalary(mfl, 10000);
  const r = await send(env, payloadOf(0));
  t.ok(r.status < 300, r.text.slice(0, 300));
  const id = mfl.st.pending[mfl.st.pending.length - 1].trade_id;
  env.TWR_TEST_NOW_MS = AUG;
  const a = await accept(env, id);
  t.equal(a.status, 409, a.text.slice(0, 300));
  t.equal(a.json.code, "player_not_tradeable");
  t.equal(accepted(mfl), 0);
});

test("ACCEPT: a legitimate offer (flat contracts, no tags) still accepts", async () => {
  const { env, mfl } = fresh({ now: AUG });
  const r = await send(env, payloadOf(0));
  t.ok(r.status < 300);
  const a = await accept(env, mfl.st.pending[mfl.st.pending.length - 1].trade_id);
  t.equal(a.status, 200, a.text.slice(0, 300));
  t.equal(accepted(mfl), 1);
});

// ── staged two-team and three-team create ──
test("CREATE (staged two-team, /api/trades/2way): a provisional tag is refused 409 player_not_tradeable and nothing is staged", async () => {
  const { env, mfl } = fresh({ now: MAY, p14056: TAG, migrations: STAGED, env: { TRADE_2WAY_STAGING_ENABLED: "1" } });
  tagRow(env, "14056", null);
  const r = await callWorker(env, "POST", `/api/trades/2way?MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from: { fid: "0001" }, to: { fid: "0002" },
    movements: [{ from: "0001", to: "0002", asset_tokens: ["P_14056"], cap_k: 0 }, { from: "0002", to: "0001", asset_tokens: ["P_13100"], cap_k: 0 }] } });
  t.equal(r.status, 409, r.text.slice(0, 300));
  t.equal(r.json.code, "player_not_tradeable");
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_2way_trades").get().n, 0);
  t.equal(mfl.writes().length, 0);
});

test("CREATE (three-team, /api/trades/3way): an expired veteran is refused 409 player_not_tradeable and nothing is stored", async () => {
  const { env, mfl } = fresh({ now: AUG, p14056: EXPIRED_VET });
  mfl.st.rosters["0012"] = [flat("16181")];
  const r = await callWorker(env, "POST", `/api/trades/3way?MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026",
    initiator: { fid: "0001", name: "x" }, team_b: { fid: "0002", name: "y" }, team_c: { fid: "0012", name: "z" },
    movements: [{ from: "0001", to: "0002", asset_tokens: ["P_14056"], cap_k: 0 }, { from: "0002", to: "0012", asset_tokens: ["P_13100"], cap_k: 0 }, { from: "0012", to: "0001", asset_tokens: ["P_16181"], cap_k: 0 }] } });
  t.equal(r.status, 409, r.text.slice(0, 300));
  t.equal(r.json.code, "player_not_tradeable");
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_3way_trades").get().n, 0);
  t.equal(mfl.writes().length, 0);
});

// NO FAIL-OPEN (integrator ruling on #1429): an unreadable source refuses staged and three-team create too, like two-team direct create.
const STAGED_BODY = { league_id: "74598", season: "2026", from: { fid: "0001" }, to: { fid: "0002" },
  movements: [{ from: "0001", to: "0002", asset_tokens: ["P_14056"], cap_k: 0 }, { from: "0002", to: "0001", asset_tokens: ["P_13100"], cap_k: 0 }] };
const THREE_BODY = { league_id: "74598", season: "2026", initiator: { fid: "0001", name: "x" }, team_b: { fid: "0002", name: "y" }, team_c: { fid: "0012", name: "z" },
  movements: [{ from: "0001", to: "0002", asset_tokens: ["P_14056"], cap_k: 0 }, { from: "0002", to: "0012", asset_tokens: ["P_13100"], cap_k: 0 }, { from: "0012", to: "0001", asset_tokens: ["P_16181"], cap_k: 0 }] };
for (const [what, breakIt] of [["the tag source (before the deadline)", (env) => env.UPS_MFL_DB.raw.exec("DROP TABLE ups_tag_master")], ["MFL's rosters export", (env, mfl) => { mfl.st.exportFail = { rosters: 502 }; }]]) {
  test(`CREATE (staged two-team): ${what} unreadable → 503 trade_eligibility_unavailable, nothing staged, no MFL write`, async () => {
    const { env, mfl } = fresh({ now: MAY, migrations: STAGED, env: { TRADE_2WAY_STAGING_ENABLED: "1" } });
    breakIt(env, mfl);
    const r = await callWorker(env, "POST", `/api/trades/2way?MFL_USER_ID=tok-B`, { body: STAGED_BODY });
    t.equal(r.status, 503, r.text.slice(0, 300)); t.equal(r.json.code, "trade_eligibility_unavailable");
    t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_2way_trades").get().n, 0);
    t.equal(mfl.writes().length, 0); t.equal(mfl.st.discord.filter((d) => /\/messages$/.test(d.url)).length, 0, "nobody was messaged");
  });
  test(`CREATE (three-team): ${what} unreadable → 503 trade_eligibility_unavailable, nothing stored, no MFL write`, async () => {
    const { env, mfl } = fresh({ now: MAY });
    mfl.st.rosters["0012"] = [flat("16181")];
    breakIt(env, mfl);
    const r = await callWorker(env, "POST", `/api/trades/3way?MFL_USER_ID=tok-B`, { body: THREE_BODY });
    t.equal(r.status, 503, r.text.slice(0, 300)); t.equal(r.json.code, "trade_eligibility_unavailable");
    t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_3way_trades").get().n, 0);
    t.equal(mfl.writes().length, 0); t.equal(mfl.st.discord.filter((d) => /\/messages$/.test(d.url)).length, 0, "nobody was messaged");
  });
}

// ── /trade-workbench carries the tag states the War Room and the Front Office read ──
test("/trade-workbench: each player carries tag_state (provisional / early_locked), and meta.tag_status says the source was read", async () => {
  const { env } = fresh({ now: MAY, p14056: TAG });
  tagRow(env, "14056", null);
  env.UPS_MFL_DB.raw.prepare("INSERT INTO ups_tag_master (league_id, season, franchise_id, tag_side, player_id) VALUES ('74598','2026','0002','OFFENSE','13100')").run();
  env.UPS_MFL_DB.raw.prepare("INSERT INTO ups_tag_submissions (league_id, season, franchise_id, player_id, action, locked_in_at) VALUES ('74598','2026','0002','13100','tag','2026-05-02 09:00:00')").run();
  const r = await callWorker(env, "GET", `/trade-workbench?${Q}&NO_CACHE=1&MFL_USER_ID=tok-B`);
  t.equal(r.status, 200, r.text.slice(0, 200));
  const asset = (fid, pid) => r.json.teams.find((x) => x.franchise_id === fid).assets.find((a) => a.player_id === pid);
  t.equal(asset("0001", "14056").tag_state, "provisional");
  t.equal(asset("0002", "13100").tag_state, "early_locked");
  t.equal(r.json.meta.tag_status.ok, true);
  t.equal(r.json.meta.tag_status.deadline_utc, "2026-05-22T04:00:00.000Z");
});

await run("trade_integration_eligibility");
restore();
