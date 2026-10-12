// §G3 forfeited picks can't be traded; obligations, selections and native
// trades are handled after the fact; "applied" only once secured.
//   node tests/lineup_forfeits.test.mjs
//
// Keith 2026-10-11:
//   - block the reserved pick during Send, Accept, Execute and Recheck;
//   - a pick whose year MFL does not list yet stays an outstanding obligation,
//     resolved and reserved when that year appears;
//   - several qualifying picks → stop and ask which;
//   - a native MFL trade can't be blocked: detect it, tell the commissioner
//     and the owner, and never mark the forfeiture applied unless the pick is
//     actually secured;
//   - "assessed" and "applied" stay separate.
//
// Real SQLite (node:sqlite) with the real migrations 0129 → 0149 → 0171 → 0172.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations, THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";
import { installDiscordRecorder, quietConsole, viewer } from "./fixtures/trade_3way_fixture.mjs";
await import("./fixtures/register_md_loader.mjs");
const F = await import("../worker/src/lineup_forfeits.js");
const R = await import("../worker/src/lineup_rulings.js");
const { createStaged2WayTrade, accept2WayTrade, execute2Way } = await import("../worker/src/trade_2way.js");
const { executeCommishTwoPartyTrade } = await import("../worker/src/trade_3way.js");

const restoreConsole = quietConsole();
installDiscordRecorder();
const SEASON = 2026, L = "74598";
const LINEUP = ["0129_lineup_compliance.sql", "0149_lineup_sat_announce_log.sql", "0171_lineup_rulings.sql", "0172_lineup_pick_reservation_state.sql"];

function db() {
  const d = makeD1({});
  applyMigrations(d, LINEUP);
  return d;
}
function reserve(d, { holder, week = 5, year, round, orig, state = "reserved", basis = "mfl_future_picks", options = null }) {
  d.raw.prepare(`INSERT INTO ups_lineup_pick_reservations (season, league_id, holder_fid, week, pick_year, pick_round, original_owner, ownership_basis, reserved_at_utc, state, options_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'x', ?, ?)`).run(SEASON, L, holder, week, year, round, orig || holder, basis, state, options ? JSON.stringify(options) : null);
}
const resv = (d, holder, week = 5) => d.raw.prepare("SELECT * FROM ups_lineup_pick_reservations WHERE holder_fid=? AND week=?").get(holder, week);

// MFL futureDraftPicks stand-in (only that export is read by this module).
function mflPicks(byHolder, { ok = true } = {}) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("TYPE=futureDraftPicks")) {
      if (!ok) return { ok: false, status: 500, json: async () => null };
      return { ok: true, status: 200, json: async () => ({ futureDraftPicks: { franchise: Object.entries(byHolder).map(([id, ps]) => ({ id, futureDraftPick: ps.map(([y, r, o]) => ({ year: String(y), round: String(r), originalPickFor: o || id })) })) } }) };
    }
    if (u.includes("TYPE=salaryAdjustments")) return { ok: false, status: 404, json: async () => null };
    if (u.startsWith("https://discord.com/")) return { ok: true, status: 200, json: async () => ({ id: "1" }) };
    throw new Error("unexpected fetch " + u);
  };
}

// ── the token and the guard ─────────────────────────────────────────────────
test("every War Room spelling of a future pick canonicalizes to FP_<orig>_<year>_<round>", () => {
  for (const tok of ["FP_0004_2027_4", "FP_2027_4_0004", "fp_2027_04_0004", "FP_0004_2027_04"]) t.equal(F.canonFpToken(tok), "FP_0004_2027_4", tok);
  for (const bad of ["P_16614", "DP_02_03", "FP_2027_4", "BB_5", "FP_X_2027_4"]) t.equal(F.canonFpToken(bad), null, bad);
});

test("the guard: reserved, obligation and needs-selection picks are refused in either token order; others pass", async () => {
  const d = db(); const env = { UPS_MFL_DB: d };
  reserve(d, { holder: "0004", year: 2027, round: 4 });
  reserve(d, { holder: "0002", year: 2028, round: 4, state: "obligation", basis: "beyond_trade_horizon" });
  reserve(d, { holder: "0001", week: 6, year: 2027, round: 2, state: "needs_selection", options: [{ year: 2027, round: 2, original_owner: "0001" }, { year: 2027, round: 2, original_owner: "0009" }] });
  reserve(d, { holder: "0003", year: 2027, round: 3, state: "secured" });
  for (const tok of ["FP_0004_2027_4", "FP_2027_4_0004", "FP_0002_2028_4", "FP_0009_2027_2"]) {
    const g = await F.checkForfeitedPicks(env, L, { "0004": [tok, "P_123"] });
    t.equal(g.ok, false, tok); t.equal(g.code, "pick_forfeited"); t.equal(g.http, 409);
  }
  t.equal((await F.checkForfeitedPicks(env, L, { "0004": ["FP_0004_2027_3"] })).ok, true, "a different round is fine");
  t.equal((await F.checkForfeitedPicks(env, L, { "0003": ["FP_0003_2027_3"] })).ok, true, "a secured (removed) pick no longer blocks");
  const v = await F.checkForfeitedPicks(env, L, { "0004": ["FP_2027_4_0004"] });
  t.deepEqual(v.violations[0], { token: "FP_2027_4_0004", canonical: "FP_0004_2027_4", sender: "0004", forfeited_by: "0004", season: 2026, week: 5, state: "reserved" });
});

test("the guard never touches D1 for a trade without future picks, and fails closed when it must read and can't", async () => {
  t.equal((await F.checkForfeitedPicks({}, L, { "0004": ["P_1", "DP_00_03", "BB_5"] })).ok, true, "no DB needed");
  const broken = { UPS_MFL_DB: { prepare() { throw new Error("D1 down"); } } };
  const g = await F.checkForfeitedPicks(broken, L, { "0004": ["FP_0004_2027_4"] });
  t.equal(g.ok, false); t.equal(g.http, 503); t.equal(g.code, "forfeit_check_unavailable");
  t.equal((await F.checkForfeitedPicks({ UPS_MFL_DB: db() }, L, ["FP_garbled"])).code, "pick_token_unreadable");
  // 0171 applied but not 0172 (no state column): reservations may exist → fail closed.
  const half = makeD1({}); applyMigrations(half, ["0129_lineup_compliance.sql", "0171_lineup_rulings.sql"]);
  t.equal((await F.checkForfeitedPicks({ UPS_MFL_DB: half }, L, ["FP_0004_2027_4"])).code, "forfeit_check_unavailable");
  // No table at all (before 0171): nothing can be forfeited.
  const none = makeD1({});
  t.equal((await F.checkForfeitedPicks({ UPS_MFL_DB: none }, L, ["FP_0004_2027_4"])).ok, true);
});

// ── War Room phases, through the real engines ──────────────────────────────
function tradeEnv() {
  const d = makeD1({});
  applyMigrations(d, [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql", ...LINEUP]);
  d.raw.exec("CREATE TABLE IF NOT EXISTS discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  const healthy = { participants: [], cap: { status: "ok", rows: [], violations: [] }, roster: { status: "ok", rows: [] }, loaded_contracts: { status: "ok", max: 5, rows: [], violations: [] }, lineup: { status: "ok", rows: [] }, extension_skipped: [] };
  return { UPS_MFL_DB: d, DISCORD_BOT_TOKEN: "t", TRADE_2WAY_STAGING_ENABLED: "1", MFL_APIKEY: "k",
    SELF: { fetch: async () => ({ ok: true, status: 200, json: async () => ({ ok: true, compliance: healthy }) }) } };
}

test("staged 2-way: a trade created BEFORE the forfeiture is refused at Accept and at Execute", async () => {
  const env = tradeEnv();
  const c = await createStaged2WayTrade(env, {}, { leagueId: L, season: String(SEASON), from: { fid: "0004", name: "PG" }, to: { fid: "0001", name: "LA" },
    movements: [{ from: "0004", to: "0001", asset_tokens: ["FP_2027_4_0004"], cap_k: 0 }, { from: "0001", to: "0004", asset_tokens: ["P_16614"], cap_k: 0 }] });
  t.ok(c.ok, JSON.stringify(c));
  reserve(env.UPS_MFL_DB, { holder: "0004", year: 2027, round: 4 });
  const a = await accept2WayTrade(env, {}, c.id, viewer("0001", { leagueId: L, season: String(SEASON) }), {});
  t.equal(a.ok, false); t.equal(a.code, "pick_forfeited");
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT to_state FROM ups_2way_trades WHERE id=?").get(c.id).to_state, "pending", "consent not recorded");
  // Even if it reached execution, the gate holds it before MFL.
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_2way_trades SET to_state='accepted', status='executing' WHERE id=?").run(c.id);
  let mflCalled = false;
  const prev = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (String(u).includes("myfantasyleague.com")) mflCalled = true; return prev(u, i); };
  const x = await execute2Way(env, c.id).catch((e) => ({ threw: String(e) }));
  globalThis.fetch = prev;
  t.equal(x.blocked, true); t.equal(x.kind, "pick_forfeited", "refused by the forfeit gate, not by something else");
  t.equal(mflCalled, false, "MFL never called");
});

test("backstop: executeCommishTwoPartyTrade refuses a forfeited pick before proposing on MFL", async () => {
  const env = tradeEnv();
  reserve(env.UPS_MFL_DB, { holder: "0004", year: 2027, round: 4 });
  let mflCalled = false;
  globalThis.fetch = async () => { mflCalled = true; return { ok: true, status: 200, json: async () => ({}) }; };
  const r = await executeCommishTwoPartyTrade(env, { leagueId: L, year: SEASON, fromFid: "0004", toFid: "0001", give: ["FP_0004_2027_4"], receive: ["P_1"] });
  t.equal(r.ok, false); t.equal(r.step, "pick_forfeited"); t.equal(mflCalled, false);
});

test("every Send / Accept / Recheck / Execute path calls the guard", () => {
  const src = (f) => fs.readFileSync(new URL(`../worker/src/${f}`, import.meta.url), "utf8");
  const idx = src("index.js");
  t.ok(/SEND — §G3[\s\S]{0,200}checkForfeitedPicks\(env, leagueId, tokensByFranchise\(proposalAssets\)\)/.test(idx), "classic send");
  t.ok(/COUNTER \(SEND\)[\s\S]{0,300}checkForfeitedPicks\(env, leagueId, tokensByFranchise\(buildTradeProposalAssetLists\(counterPayload\)\)\)/.test(idx), "classic counter, before the original is rejected");
  t.ok(/ACCEPT — §G3[\s\S]{0,200}checkForfeitedPicks\(env, leagueId, byFranchise\)/.test(idx), "classic accept");
  t.ok(/EXECUTE — the last check before MFL is called[\s\S]{0,300}checkForfeitedPicks\(env, leagueId, tokensByFranchise\(acceptProposalAssets\)\)/.test(idx), "classic execute");
  t.ok(idx.indexOf("checkForfeitedPicks(env, leagueId, tokensByFranchise(buildTradeProposalAssetLists(counterPayload)))") < idx.indexOf("const rejectImport = await postMflImportFormAsViewer("), "counter checked before reject");
  t.ok(/SEND — §G3[\s\S]{0,300}checkForfeitedPicks\(env, _rdhLeagueId\(\), \{ \[fromFid\]: give, \[toFid\]: receive \}\)/.test(idx), "/api/trade");
  t.ok(/EXECUTE \(commissioner propose \+ accept\)[\s\S]{0,300}checkForfeitedPicks\(env, leagueId, \{ \[fromFid\]: give, \[toFid\]: receive \}\)/.test(idx), "/api/trade/process");
  const two = src("trade_2way.js");
  t.ok(/async function capGate2Way\(env, row\) \{[\s\S]{0,400}checkForfeitedPicks/.test(two), "staged 2-way gate");
  t.ok(/ACCEPT — §G3[\s\S]{0,200}checkForfeitedPicks/.test(two), "staged 2-way accept");
  t.ok(/RECHECK — §G3[\s\S]{0,200}checkForfeitedPicks/.test(two), "staged 2-way recheck");
  t.ok(/SEND — §G3[\s\S]{0,200}checkForfeitedPicks\(env, leagueId, movementsToTokens\(body\.movements\)\)/.test(src("trade_2way_http.js")), "staged 2-way send");
  const three = src("trade_3way.js");
  t.ok(/async function capGate\(env, row\) \{[\s\S]{0,500}checkForfeitedPicks/.test(three), "3-way gate (accept, recheck, execute)");
  t.ok(/BACKSTOP — §G3[\s\S]{0,400}checkForfeitedPicks/.test(three), "shared backstop");
  t.ok(/SEND — §G3[\s\S]{0,400}checkForfeitedPicks\(env, leagueId, movementsToTokens\(sendMoves\)\)/.test(src("trade_3way_http.js")), "3-way send");
});

// ── after the fact ──────────────────────────────────────────────────────────
const alerts = [];
const alertImpl = async (_e, text) => { alerts.push(["commish", text]); };
const ownerDmImpl = async (_e, fid, text) => { alerts.push([`owner:${fid}`, text]); return 1; };
const reconcile = (env) => F.reconcileForfeitedPicks(env, { season: SEASON, leagueId: L, alertImpl, ownerDmImpl });

test("obligation: kept while MFL doesn't list the year; reserved the moment it does", async () => {
  const d = db(); const env = { UPS_MFL_DB: d }; alerts.length = 0;
  reserve(d, { holder: "0002", year: 2028, round: 4, state: "obligation", basis: "beyond_trade_horizon" });
  mflPicks({ "0002": [[2027, 1]], "0001": [[2027, 4]] });
  await reconcile(env);
  t.equal(resv(d, "0002").state, "obligation", "2028 not listed yet");
  mflPicks({ "0002": [[2028, 4]], "0001": [[2028, 1]] });
  await reconcile(env);
  const r = resv(d, "0002");
  t.equal(r.state, "reserved"); t.equal(r.ownership_basis, "mfl_future_picks"); t.equal(r.original_owner, "0002");
  t.equal(alerts.length, 0);
});

test("obligation: its own pick and an acquired pick in the same draft → own pick reserved, nobody asked (Keith 2026-10-12)", async () => {
  const d = db(); const env = { UPS_MFL_DB: d }; alerts.length = 0;
  reserve(d, { holder: "0002", year: 2028, round: 4, state: "obligation", basis: "beyond_trade_horizon" });
  mflPicks({ "0002": [[2028, 4, "0007"], [2028, 4]] });
  await reconcile(env); await reconcile(env);
  const r = resv(d, "0002");
  t.equal(r.state, "reserved"); t.equal(r.original_owner, "0002"); t.equal(r.ownership_basis, "mfl_future_picks");
  t.equal(alerts.length, 0, "no question asked");
  t.equal((await F.checkForfeitedPicks(env, L, ["FP_0002_2028_4"])).code, "pick_forfeited", "its own pick is blocked");
  t.equal((await F.checkForfeitedPicks(env, L, ["FP_0007_2028_4"])).ok, true, "the acquired pick stays tradeable");
  const ev = d.raw.prepare("SELECT event, detail_json FROM ups_lineup_forfeit_events WHERE holder_fid='0002' AND event='obligation_resolved'").get();
  t.match(ev.detail_json, /own_pick_first/, "audit names the rule that chose it");
});

test("obligation: several qualifying picks, none its own → needs_selection, Keith asked once; his choice reserves it", async () => {
  const d = db(); const env = { UPS_MFL_DB: d }; alerts.length = 0;
  reserve(d, { holder: "0002", year: 2028, round: 4, state: "obligation", basis: "beyond_trade_horizon" });
  mflPicks({ "0002": [[2028, 4, "0011"], [2028, 4, "0007"]] });
  await reconcile(env); await reconcile(env);
  t.equal(resv(d, "0002").state, "needs_selection");
  t.equal(alerts.filter(([w]) => w === "commish").length, 1, "asked once");
  t.equal((await F.checkForfeitedPicks(env, L, ["FP_0007_2028_4"])).code, "pick_forfeited", "both candidates blocked while undecided");
  t.equal((await F.selectForfeitedPick(env, { season: SEASON, leagueId: L, fid: "0002", week: 5, pickChoice: "2028-4-0002" })).error, "not_an_option");
  const ok = await F.selectForfeitedPick(env, { season: SEASON, leagueId: L, fid: "0002", week: 5, pickChoice: "2028-4-0007" });
  t.equal(ok.ok, true);
  const r = resv(d, "0002");
  t.equal(r.state, "reserved"); t.equal(r.original_owner, "0007");
  t.equal((await F.checkForfeitedPicks(env, L, ["FP_0011_2028_4"])).ok, true, "the unchosen pick is free again");
});

test("obligation: no pick in that round that year → rolls to the next year, Keith told", async () => {
  const d = db(); const env = { UPS_MFL_DB: d }; alerts.length = 0;
  reserve(d, { holder: "0002", year: 2028, round: 4, state: "obligation", basis: "beyond_trade_horizon" });
  mflPicks({ "0002": [[2028, 1]], "0001": [[2028, 4]] });
  await reconcile(env);
  const r = resv(d, "0002");
  t.equal(r.state, "obligation"); t.equal(r.pick_year, 2029);
  t.match(alerts[0][1], /now applies to its 2029 fourth-round pick/);
});

test("native MFL trade of a reserved pick: TRADED_AWAY, commissioner and owner told once, never 'applied'", async () => {
  const d = db(); const env = { UPS_MFL_DB: d }; alerts.length = 0;
  reserve(d, { holder: "0004", year: 2027, round: 4 });
  mflPicks({ "0004": [[2027, 3]], "0009": [[2027, 4, "0004"]] });
  await reconcile(env); await reconcile(env);
  t.equal(resv(d, "0004").state, "traded_away");
  t.equal(alerts.filter(([w]) => w === "commish").length, 1); t.equal(alerts.filter(([w]) => w === "owner:0004").length, 1);
  t.match(alerts.find(([w]) => w === "commish")[1], /traded on MFL[\s\S]*now belongs to Team 0009[\s\S]*NOT applied/);
  t.equal((await F.checkForfeitedPicks(env, L, ["FP_0004_2027_4"])).code, "pick_forfeited", "still blocked from further War Room trades");
});

test("SECURED only when the pick is gone from every franchise; applied needs secured pick AND cap charge", async () => {
  const d = db(); const env = { UPS_MFL_DB: d };
  reserve(d, { holder: "0004", year: 2027, round: 4 });
  d.raw.prepare(`INSERT INTO ups_lineup_rulings (season, league_id, fid, week, ruling, offense_no, penalty_json, ruled_by, ruled_at_utc, status, sanction_status)
    VALUES (?, ?, '0004', 5, 'confirmed', 2, ?, 'auto', 'x', 'posted', 'assessed')`).run(SEASON, L, JSON.stringify({ pick: { year: 2027, round: 4, original_owner: "0004", basis: "mfl_future_picks" }, cap_k: 5, cap_season: 2027, cap_description: "UPS lineup violation 2026 W5 #2" }));
  const verify = () => R.verifyLineupSanction(env, { season: SEASON, leagueId: L, fid: "0004", week: 5 });
  mflPicks({ "0004": [[2027, 3]], "0009": [[2027, 4, "0004"]] });
  let v = await verify();
  t.equal(v.sanction_status, "assessed"); t.equal(v.detail.pick.reason, "pick_traded_away");
  mflPicks({ "0004": [[2027, 3]] });
  await reconcile(env);
  t.equal(resv(d, "0004").state, "secured");
  v = await verify();
  t.equal(v.detail.pick.verified, true); t.equal(v.sanction_status, "assessed", "cap charge not yet visible (2027 league)");
});

test("a reserved pick reaching its draft year unsecured is flagged to Keith", async () => {
  const d = db(); const env = { UPS_MFL_DB: d }; alerts.length = 0;
  reserve(d, { holder: "0004", year: 2027, round: 4 });
  mflPicks({ "0004": [[2028, 4]] });
  await reconcile(env);
  t.match(alerts[0][1], /reached its draft year without being removed/);
});

const events = (d, holder) => d.raw.prepare("SELECT event, pick_year, current_owner FROM ups_lineup_forfeit_events WHERE holder_fid=? ORDER BY id").all(holder);

test("the expected pick traded on MFL BEFORE it could be reserved: auditable record, both sides told once, obligation moves on", async () => {
  const d = db(); const env = { UPS_MFL_DB: d }; alerts.length = 0;
  reserve(d, { holder: "0002", year: 2028, round: 4, state: "obligation", basis: "beyond_trade_horizon" });
  mflPicks({ "0002": [[2028, 1]], "0009": [[2028, 4, "0002"]] });   // MFL now lists 2028; CBP's own 4th sits on 0009
  await reconcile(env); await reconcile(env);
  const ev = events(d, "0002");
  t.deepEqual(ev.slice(0, 2).map((x) => [x.event, x.pick_year, x.current_owner]), [["traded_before_reserve", 2028, "0009"], ["rolled_forward", 2029, null]]);
  t.equal(resv(d, "0002").state, "obligation"); t.equal(resv(d, "0002").pick_year, 2029);
  t.equal(alerts.filter(([w, x]) => w === "commish" && /traded on MFL to Team 0009 before it could be reserved/.test(x)).length, 1);
  t.equal(alerts.filter(([w, x]) => w === "owner:0002" && /traded on MFL before it could be reserved/.test(x)).length, 1);
});

test("every transition lands in the audit trail", async () => {
  const d = db(); const env = { UPS_MFL_DB: d };
  reserve(d, { holder: "0004", year: 2027, round: 4 });
  mflPicks({ "0004": [[2027, 3]], "0009": [[2027, 4, "0004"]] });
  await reconcile(env);
  reserve(d, { holder: "0005", year: 2027, round: 2 });
  mflPicks({ "0005": [[2027, 3]] });
  await reconcile(env);
  t.deepEqual(events(d, "0004").map((x) => [x.event, x.current_owner]), [["traded_away", "0009"]]);
  t.deepEqual(events(d, "0005").map((x) => x.event), ["secured"]);
});

test("assessed, reserved and applied are distinct stages", () => {
  t.equal(F.penaltyStage({ sanctionStatus: "none" }), "none");
  t.equal(F.penaltyStage({ sanctionStatus: "assessed", pickState: "obligation" }), "assessed", "an obligation is not reserved");
  t.equal(F.penaltyStage({ sanctionStatus: "assessed", pickState: "needs_selection" }), "assessed");
  t.equal(F.penaltyStage({ sanctionStatus: "assessed", pickState: "traded_away" }), "assessed", "a traded-away pick is not reserved");
  t.equal(F.penaltyStage({ sanctionStatus: "assessed", pickState: "reserved" }), "reserved");
  t.equal(F.penaltyStage({ sanctionStatus: "assessed", pickState: "secured" }), "reserved", "secured pick but cap not yet verified ≠ applied");
  t.equal(F.penaltyStage({ sanctionStatus: "applied", pickState: "secured" }), "applied");
});

test("the cases list shows each ruling's stage", async () => {
  const d = db(); const env = { UPS_MFL_DB: d };
  const ins = (fid, week, state) => {
    d.raw.prepare("INSERT INTO ups_lineup_violations (season, league_id, fid, week, offense_no, reasons_json) VALUES (?, ?, ?, ?, 2, '[]')").run(SEASON, L, fid, week);
    d.raw.prepare(`INSERT INTO ups_lineup_rulings (season, league_id, fid, week, ruling, offense_no, ruled_by, ruled_at_utc, status, sanction_status) VALUES (?, ?, ?, ?, 'confirmed', 2, 'auto', 'x', 'posted', 'assessed')`).run(SEASON, L, fid, week);
    reserve(d, { holder: fid, week, year: 2028, round: 4, state, basis: state === "obligation" ? "beyond_trade_horizon" : "mfl_future_picks" });
  };
  ins("0002", 7, "obligation"); ins("0004", 7, "reserved");
  const c = await R.listLineupCases(env, { season: SEASON, leagueId: L });
  t.deepEqual(c.cases.map((x) => [x.fid, x.pick_state, x.penalty_stage]), [["0002", "obligation", "assessed"], ["0004", "reserved", "reserved"]]);
});

test("0172 applies on top of 0171 and its rollback restores the exact 0171 schema", () => {
  const schema = (d) => d.raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE name LIKE '%lineup%' ORDER BY name").all();
  const base = makeD1({}); applyMigrations(base, ["0129_lineup_compliance.sql", "0149_lineup_sat_announce_log.sql", "0171_lineup_rulings.sql"]);
  const d = makeD1({}); applyMigrations(d, ["0129_lineup_compliance.sql", "0149_lineup_sat_announce_log.sql", "0171_lineup_rulings.sql", "0172_lineup_pick_reservation_state.sql"]);
  t.ok(d.raw.prepare("SELECT COUNT(*) n FROM pragma_table_info('ups_lineup_pick_reservations') WHERE name='state'").get().n === 1);
  d.raw.exec("CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY, name TEXT, applied_at TEXT); INSERT INTO d1_migrations (name) VALUES ('0172_lineup_pick_reservation_state.sql')");
  d.raw.exec("BEGIN;" + fs.readFileSync(new URL("../worker/migrations/manual/0172_lineup_pick_reservation_state_rollback.sql", import.meta.url), "utf8") + "COMMIT;");
  t.deepEqual(schema(d), schema(base), "schema identical to 0171");
  t.equal(d.raw.prepare("SELECT COUNT(*) n FROM d1_migrations WHERE name LIKE '0172%'").get().n, 0);
});

restoreConsole();
await run("lineup_forfeits");
