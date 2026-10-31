// IRREVERSIBLE EXECUTION — the state model for the one step that cannot be undone (MFL accepting a trade).
// The REAL worker on real SQLite, MFL stubbed at the edge; faults are injected exactly where they hurt:
//   • a lost HTTP response AFTER MFL executed the trade      • D1 failing AFTER MFL succeeded
//   • a contract/extension import failing after the trade    • a 3-way leg failing part-way
//   node tests/trade_execution_state.test.mjs
//
// The claims proved here:
//   1. the execution lock is written BEFORE MFL is called, and MFL is called at most once per trade (concurrent, repeated, or retried)
//   2. MFL success is preserved permanently (state + evidence) and no later failure turns an executed trade into "not executed"
//   3. post-processing (adjustments / extensions) runs only after MFL executed; its failure is `executed_needs_review` with the exact step
//   4. a retry re-runs ONLY the missing post-processing (never the trade, never a step already done); an ambiguous earlier attempt needs a human
//   5. an ambiguous outcome (lost response) is settled by ASKING MFL — never by calling it again
//   6. D1 failing after MFL succeeded is recoverable by reconciliation
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, bindSelf, quiet, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import * as F from "./fixtures/trade_3way_fixture.mjs";
await import("./fixtures/register_md_loader.mjs");
const { handle3WayButton, execute3Way } = await import("../worker/src/trade_3way.js");
const { findOwnPendingTrade } = await import("../worker/src/trade_execution.js");

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const clone = (o) => JSON.parse(JSON.stringify(o));
const player = (pid, salary = 5000) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false, contract_info: "" });
const LIVE = () => [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }, { id: "13100", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];   // 13100 is the OTHER leg's incidental roster player (not itself under test) -- a resolvable, flat, non-loaded contract keeps loaded_contracts "ok" instead of "unavailable" now that a fully blank contract anywhere on a participating roster refuses the whole compliance calc (2026-09-28 review)
const EXT = () => [{
  player_id: "14056", player_name: "P14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "2YR", option_key: "2YR|NONE",
  new_contract_status: "Vet-Ext2", new_TCV: 55000, new_aav_future: 25000, new_contract_length: 3, preview_contract_info_string: "CL 3| TCV 55K| AAV 5K, 25K| Y1-5K, Y2-25K, Y3-25K",
}];
const payloadOf = (o) => {
  o = o || {};
  return {
    schema_version: 1, source: "test", league_id: "74598", season: "2026",
    teams: [{ role: "left", franchise_id: "0001", selected_assets: [player(14056)], traded_salary_adjustment_k: o.capK || 0, traded_salary_adjustment_dollars: (o.capK || 0) * 1000 },
      { role: "right", franchise_id: "0002", selected_assets: [player(13100)], traded_salary_adjustment_k: 0, traded_salary_adjustment_dollars: 0 }],
    extension_requests: o.ext || [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" },
  };
};
function fresh(o) { const env = makeWorkerEnv(); const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install(); mfl.st.salaries = LIVE(); void o; return { env, mfl }; }
async function sendOffer(env, mfl, payload) {
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "", payload } });
  t.ok(r.status < 300, `offer sent ${r.status} ${r.text.slice(0, 160)}`);
  mfl.__offer = { ...mfl.st.pending[mfl.st.pending.length - 1] };   // what MFL was sent (its ledger will list exactly this)
  return mfl.st.pending[mfl.st.pending.length - 1].trade_id;
}
const accept = (env, id) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "" } });
const acceptCount = (mfl) => mfl.st.done.filter((d) => d.response === "accept").length;
const led = (env, key) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_executions WHERE exec_key=?").get(String(key));
const admin = (env, method, route, body) => callWorker(env, method, `${route}${route.includes("?") ? "&" : "?"}${Q}&APIKEY=${ADMIN_KEY}`, body === undefined ? {} : { body });
// MFL's ledger entry for the swap 14056 ⇄ 13100 (what `transactions` shows once MFL really executed it)
const tradeTx = (mfl) => { const o = mfl.__offer; mfl.st.transactions = [{ type: "TRADE", franchise: o.offeringteam, franchise1_gave_up: o.will_give_up, franchise2: o.offeredto, franchise2_gave_up: o.will_receive, timestamp: String(Math.floor(Date.now() / 1000)) }]; };
// Wrap the stubbed network so a test can act at the exact moment MFL executes the trade.
function onMflAccept(fn) {
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    const key = String(u) + " " + String((i && i.body) || "");
    const res = await inner(u, i);
    if (/TYPE=tradeResponse/.test(key) && /RESPONSE=accept/i.test(key)) await fn();
    return res;
  };
}

// ═══════════════════════════════ two-team: lock, evidence, ordering ═══════════════════════════════
test("LOCK: `executing` is written BEFORE MFL is called; MFL's success is then recorded permanently with evidence, and the trade completes", async () => {
  const { env, mfl } = fresh(); const id = await sendOffer(env, mfl, payloadOf({ capK: 2 }));
  let snap = null;
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (/TYPE=tradeResponse/.test(String(u) + String((i && i.body) || "")) && !snap) snap = led(env, id); return inner(u, i); };
  const r = await accept(env, id);
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(r.json.executed, true); t.equal(r.json.execution_state, "completed");
  t.ok(snap, "the ledger row already existed when MFL was called"); t.equal(snap.state, "executing", "…and said `executing`"); t.ok(snap.lock_token);
  const row = led(env, id);
  t.equal(row.state, "completed"); t.ok(row.mfl_executed_at_utc, "MFL's success time is recorded"); t.ok(row.completed_at_utc);
  t.ok(JSON.parse(row.mfl_evidence_json), "execution evidence is kept");
  t.deepEqual(JSON.parse(row.steps_json).salary_adjustments.ok, true); t.equal(acceptCount(mfl), 1);
});
test("ONCE: a stuck `executing` lock (a previous request died mid-flight) is never bypassed — a repeat accept cannot send the trade again", async () => {
  const { env, mfl } = fresh(); const id = await sendOffer(env, mfl, payloadOf());
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_trade_executions (league_id TEXT NOT NULL, season TEXT NOT NULL, exec_key TEXT NOT NULL, kind TEXT NOT NULL, state TEXT NOT NULL, lock_token TEXT, actor_fid TEXT, participants TEXT, payload_hash TEXT, payload_json TEXT, mfl_evidence_json TEXT, steps_json TEXT, failed_step TEXT, failure_detail TEXT, block_json TEXT, created_at_utc TEXT NOT NULL, updated_at_utc TEXT NOT NULL, mfl_executed_at_utc TEXT, completed_at_utc TEXT, PRIMARY KEY (league_id, season, exec_key))");
  env.UPS_MFL_DB.raw.prepare("INSERT INTO ups_trade_executions (league_id, season, exec_key, kind, state, lock_token, created_at_utc, updated_at_utc) VALUES ('74598','2026',?,'two_way','executing','held',?,?)").run(String(id), new Date().toISOString(), new Date().toISOString());
  const r = await accept(env, id);
  t.equal(r.status, 409); t.equal(r.json.code, "execution_in_progress"); t.equal(r.json.execution_state, "executing");
  t.equal(mfl.writes("tradeResponse").length, 0, "MFL was not called"); t.equal(mfl.st.done.length, 0);
});
test("CONCURRENT: many simultaneous accepts → exactly one MFL call, exactly one post-processing", async () => {
  const { env, mfl } = fresh(); const id = await sendOffer(env, mfl, payloadOf({ capK: 2 }));
  let release; mfl.st.holdAccept = new Promise((r) => { release = r; });
  const all = [accept(env, id), accept(env, id), accept(env, id), accept(env, id)];
  await new Promise((r) => setTimeout(r, 50)); release();
  const rs = await Promise.all(all);
  t.equal(acceptCount(mfl), 1); t.equal(rs.filter((r) => r.status === 200).length, 1, "one caller executed it");
  t.equal(mfl.writes("salaryAdj").length, 1, "the cap money was posted once");
  t.ok(rs.filter((r) => r.status !== 200).every((r) => ["execution_in_progress", "already_executed", "offer_not_pending"].includes(r.json.code)), "the others were told the truth");
});

// ═══════════════════════════════ lost response after MFL executed ═══════════════════════════════
test("LOST RESPONSE: MFL executed but the answer never arrived → the worker asks MFL, finds the trade, and continues as EXECUTED (MFL is not called again)", async () => {
  const { env, mfl } = fresh(); const id = await sendOffer(env, mfl, payloadOf({ capK: 2 }));
  mfl.st.loseResponseNext = "timeout"; onMflAccept(() => tradeTx(mfl));
  const r = await accept(env, id);
  t.equal(r.status, 200, r.text.slice(0, 250)); t.equal(r.json.executed, true); t.equal(r.json.ok, true);
  t.equal(acceptCount(mfl), 1, "MFL executed it once — and was never asked again");
  t.equal(led(env, id).state, "completed"); t.equal(JSON.parse(led(env, id).mfl_evidence_json).source, "transactions_reconcile", "the evidence says it was reconciled from MFL's ledger");
  t.equal(mfl.writes("salaryAdj").length, 1, "post-processing ran once, after MFL executed");
  const again = await accept(env, id); t.equal(again.status, 200); t.equal(again.json.already, true); t.equal(acceptCount(mfl), 1);
});
test("LOST RESPONSE (ambiguous): MFL cannot confirm either way → 503 execution_unconfirmed, the lock STAYS, nothing is re-sent; an admin reconcile settles it without double execution", async () => {
  const { env, mfl } = fresh(); const id = await sendOffer(env, mfl, payloadOf({ capK: 2 }));
  mfl.st.loseResponseNext = "504";                                                        // executed at MFL; MFL's ledger doesn't list it yet
  const r = await accept(env, id);
  t.equal(r.status, 503); t.equal(r.json.code, "execution_unconfirmed"); t.equal(r.json.execution_state, "executing");
  t.match(r.json.message, /NOT been sent again/); t.equal(acceptCount(mfl), 1);
  t.equal(led(env, id).state, "executing"); t.equal(mfl.writes("salaryAdj").length, 0, "no post-processing before MFL is confirmed");
  const again = await accept(env, id);                                                     // the owner tries again
  t.ok([409, 503].includes(again.status)); t.equal(again.json.execution_state, "executing");
  t.equal(mfl.writes("tradeResponse").length, 1, "MFL was called exactly once, in total");
  // an administrator reconciles: still ambiguous → nothing changes
  const still = await admin(env, "POST", "/admin/trade/reconcile-execution", { id });
  t.equal(still.status, 409); t.equal(still.json.code, "still_ambiguous"); t.equal(led(env, id).state, "executing");
  // MFL's ledger catches up → reconcile finds it, marks it executed and runs the post-processing once
  tradeTx(mfl);
  const rec = await admin(env, "POST", "/admin/trade/reconcile-execution", { id });
  t.equal(rec.status, 200, rec.text.slice(0, 200)); t.equal(rec.json.code, "reconciled_executed"); t.equal(rec.json.executed, true);
  t.equal(led(env, id).state, "completed"); t.equal(mfl.writes("salaryAdj").length, 1); t.equal(acceptCount(mfl), 1, "still exactly one MFL accept");
  const done = await accept(env, id); t.equal(done.status, 200); t.equal(done.json.already, true); t.equal(done.json.executed, true);
  const noop = await admin(env, "POST", "/admin/trade/reconcile-execution", { id }); t.equal(noop.json.code, "nothing_to_reconcile");
});
test("LOST RESPONSE (never executed): MFL still holds the offer as pending → proven NOT executed → the lock is released and a retry executes once", async () => {
  const { env, mfl } = fresh(); const id = await sendOffer(env, mfl, payloadOf());
  mfl.st.failNext = { type: "tradeResponse", status: 500 };                                // MFL refused before doing anything
  const r = await accept(env, id);
  t.ok(r.status >= 500); t.equal(mfl.st.done.length, 0); t.equal(led(env, id).state, "not_executed", "provably not executed → released");
  const ok = await accept(env, id); t.equal(ok.status, 200); t.equal(acceptCount(mfl), 1); t.equal(led(env, id).state, "completed");
});

// ═══════════════════════════════ D1 fails AFTER MFL succeeded ═══════════════════════════════
test("D1 FAILURE after MFL success: the trade is reported EXECUTED (never 'failed'), nothing is re-sent, and reconciliation completes the record without double-posting", async () => {
  const { env, mfl } = fresh(); const id = await sendOffer(env, mfl, payloadOf({ capK: 2 }));
  onMflAccept(() => { tradeTx(mfl); env.UPS_MFL_DB.opts.beforeRun = (sql) => { if (/UPDATE ups_trade_executions/i.test(sql)) throw new Error("D1_ERROR: simulated write failure"); }; });
  const r = await accept(env, id);
  t.equal(r.status, 200, r.text.slice(0, 250)); t.equal(r.json.executed, true, "MFL's success is what we report"); t.equal(r.json.execution_persisted, false, "…and we admit the record could not be saved");
  t.equal(acceptCount(mfl), 1); t.equal(led(env, id).state, "executing", "the ledger could not move — it still says `executing` (never `not_executed`)");
  t.equal(mfl.writes("salaryAdj").length, 1, "the cap money WAS posted");
  env.UPS_MFL_DB.opts.beforeRun = null;                                                     // D1 recovers
  const rec = await admin(env, "POST", "/admin/trade/reconcile-execution", { id });
  t.equal(rec.status, 200, rec.text.slice(0, 200)); t.equal(rec.json.code, "reconciled_executed");
  t.equal(led(env, id).state, "completed"); t.equal(mfl.writes("salaryAdj").length, 1, "the retried post-processing found its rows already posted — no double adjustment");
  t.equal(acceptCount(mfl), 1);
  const again = await accept(env, id); t.equal(again.status, 200); t.equal(again.json.already, true); t.equal(again.json.executed, true);
});

// ═══════════════════════════════ post-processing (extension) failure ═══════════════════════════════
test("EXTENSION FAILURE: the trade stays EXECUTED (needs review, exact step kept); only that step is retried — MFL is never asked to accept again", async () => {
  const { env, mfl } = fresh(); const id = await sendOffer(env, mfl, payloadOf({ ext: EXT() }));
  mfl.st.failNext = { type: "salaries", status: 500 };
  const r = await accept(env, id);
  t.equal(r.status, 200); t.equal(r.json.executed, true); t.equal(r.json.needs_review, true); t.equal(r.json.failed_step, "extensions");
  t.match(r.json.message, /WAS executed in MFL/);
  let row = led(env, id); t.equal(row.state, "executed_needs_review"); t.equal(row.failed_step, "extensions"); t.ok(row.failure_detail);
  t.equal(JSON.parse(row.steps_json).salary_adjustments.ok, true, "the step that DID succeed stays recorded as done");
  t.equal(JSON.parse(row.steps_json).extensions.ok, false);
  t.equal(acceptCount(mfl), 1);
  // the admin's view shows the failure, never the lock token or payload
  const view = await admin(env, "GET", `/admin/trade/execution?id=${id}`);
  t.equal(view.status, 200); t.equal(view.json.execution.state, "executed_needs_review"); t.equal(view.json.execution.failed_step, "extensions");
  t.equal(view.json.execution.lock_token, undefined); t.equal(view.json.execution.payload, undefined);
  // retry = post-processing ONLY
  const before = { accepts: mfl.writes("tradeResponse").length, adj: mfl.writes("salaryAdj").length, sal: mfl.writes("salaries").length };
  const retry = await admin(env, "POST", "/admin/trade/postprocess-retry", { id });
  t.equal(retry.status, 200, retry.text.slice(0, 200)); t.equal(retry.json.code, "completed"); t.equal(retry.json.state, "completed");
  t.equal(mfl.writes("tradeResponse").length, before.accepts, "the trade itself was NOT re-sent"); t.equal(mfl.writes("salaryAdj").length, before.adj, "the step that already succeeded was NOT re-run");
  t.equal(mfl.writes("salaries").length, before.sal + 1, "only the failed extension import ran");
  t.equal(mfl.st.salaries[0].contractInfo, "CL 3|TCV 55K|AAV 5K, 25K|Y1-5K, Y2-25K, Y3-25K|Ext: L.A.|GTD: 41.3K"); t.equal(mfl.st.salaries[0].contractYear, "3"); t.equal(led(env, id).state, "completed");
  const again = await admin(env, "POST", "/admin/trade/postprocess-retry", { id }); t.equal(again.status, 409); t.equal(again.json.code, "not_resumable", "nothing left to retry");
});
test("EXTENSION UNVERIFIED: an import MFL acknowledged but that could not be verified may already have landed → blind retry is REFUSED (it could extend twice); `force` after a human check", async () => {
  const { env, mfl } = fresh(); mfl.st.salariesImportIgnored = true; const id = await sendOffer(env, mfl, payloadOf({ ext: EXT() }));
  const r = await accept(env, id); t.equal(r.json.needs_review, true); t.equal(JSON.parse(led(env, id).steps_json).extensions.request_ok, true);
  const n = mfl.writes("salaries").length;
  const blind = await admin(env, "POST", "/admin/trade/postprocess-retry", { id });
  t.equal(blind.status, 409); t.equal(blind.json.code, "manual_verification_required"); t.equal(mfl.writes("salaries").length, n, "nothing was sent"); t.equal(led(env, id).state, "executed_needs_review");
  mfl.st.salariesImportIgnored = false;
  const forced = await admin(env, "POST", "/admin/trade/postprocess-retry", { id, force: true });
  t.equal(forced.status, 200, forced.text.slice(0, 200)); t.equal(forced.json.code, "completed"); t.equal(acceptCount(mfl), 1);
});
test("ADMIN routes: exact, authenticated, and never able to send a trade — no key/wrong key is refused; unknown ids are 404; release-info is secret-free", async () => {
  const { env, mfl } = fresh(); const id = await sendOffer(env, mfl, payloadOf());
  for (const route of ["/admin/trade/execution?id=1", "/admin/trade/postprocess-retry", "/admin/trade/reconcile-execution", "/admin/release-info"]) {
    for (const q of ["", "&APIKEY=wrong"]) {
      const r = await callWorker(env, route.includes("execution?") || route.includes("release") ? "GET" : "POST", `${route}${route.includes("?") ? "&" : "?"}${Q}${q}`, route.includes("execution?") || route.includes("release") ? {} : { body: { id } });
      t.ok([401, 403].includes(r.status), `${route}${q}: ${r.status}`); t.doesNotMatch(r.text, /executing|lock_token|admin-key/);
    }
  }
  const nf = await admin(env, "GET", "/admin/trade/execution?id=nope"); t.equal(nf.status, 404);
  const rc = await admin(env, "POST", "/admin/trade/reconcile-execution", { id: "nope" }); t.equal(rc.status, 404);
  const ri = await admin(env, "GET", "/admin/release-info"); t.equal(ri.status, 200); t.equal(ri.json.ok, true); t.match(ri.json.release, /^trade-war-room-/);
  t.ok(ri.json.features.execution_ledger && ri.json.features.recoverable_cap_block && ri.json.features.admin_front_door);
  t.doesNotMatch(ri.text, new RegExp(ADMIN_KEY)); t.equal(mfl.st.done.length, 0);
});

// ═══════════════════════════════ three-team ═══════════════════════════════
const DISCORD = F.DISCORD;
const say = async (resp) => (await resp.json()).data.content;
const press = (action, userId) => ({ data: { custom_id: `tr3:${action}:${F.TRADE_ID}` }, member: { user: { id: userId } } });
// The stubbed MFL doesn't move players on an accept; the 3-way hub path verifies that the pass-through player really landed on the hub's
// roster between legs, so make an accepted trade move the players it names (exactly what MFL does).
function movePlayersOnAccept(mfl) {
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    const k = String(u) + " " + String((i && i.body) || "");
    let offer = null;
    if (/TYPE=tradeResponse/.test(k) && /RESPONSE=accept/i.test(k)) { const id = (/TRADE_ID=(\d+)/.exec(k) || [])[1]; offer = mfl.st.pending.find((p) => p.trade_id === id) || null; }
    const res = await inner(u, i);
    if (offer && res.ok && mfl.st.done.some((d) => d.trade_id === offer.trade_id)) {
      const move = (csv, from, to) => { for (const pid of String(csv).split(",").map((x) => x.replace(/\D/g, "")).filter((x) => x.length >= 4)) {
        const src = mfl.st.rosters[from] || []; const idx = src.findIndex((p) => String(typeof p === "object" ? p.id : p) === pid);
        if (idx >= 0) { const [p] = src.splice(idx, 1); (mfl.st.rosters[to] = mfl.st.rosters[to] || []).push(p); } } };
      move(offer.will_give_up, offer.offeringteam, offer.offeredto); move(offer.will_receive, offer.offeredto, offer.offeringteam);
    }
    return res;
  };
}
function threeWay(o) {
  o = o || {};
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: "1" }); const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install(); movePlayersOnAccept(mfl); bindSelf(env);
  for (const [fid, d] of [["0008", DISCORD.A], ["0001", DISCORD.B], ["0012", DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", d);
  const legs = [{ from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0 }, { from: "0001", to: "0012", asset_tokens: ["P_16181"], cap_k: 0 }, { from: "0012", to: "0008", asset_tokens: ["P_16650"], cap_k: 0 }];
  const ext3 = [{ player_id: "16614", player_name: "P16614", from_franchise_id: "0008", to_franchise_id: "0001", applies_to_acquirer: true, option_key: "2YR|NONE", extension_term: "2YR", loaded_indicator: "NONE",
    new_contract_status: "Vet-Ext2", new_contract_length: 3, new_TCV: 55000, new_aav_future: 25000, preview_contract_info_string: "CL 3| TCV 55K| AAV 5K, 25K| Y1-5K, Y2-25K, Y3-25K" }];
  F.seedTrade(env, { legs_json: JSON.stringify(legs), status: "executing", team_b_state: "accepted", team_c_state: "accepted", ...(o.ext ? { extension_requests_json: JSON.stringify(ext3) } : {}) });
  mfl.st.rosters = { "0008": [{ id: "16614", salary: 5000 }], "0001": [{ id: "16181", salary: 5000 }], "0012": [{ id: "16650", salary: 5000 }] };
  mfl.st.salaries = [{ id: "16614", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }, { id: "16181", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }, { id: "16650", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];   // 16181/16650 are the OTHER two legs' incidental roster players -- resolvable, flat contracts, same reason as LIVE() above
  return { env, mfl };
}
const tradesDone = (mfl) => mfl.st.done.filter((d) => d.response === "accept").length;
const dmsWith = (mfl, re) => mfl.st.discord.filter((d) => /\/messages$/.test(d.url) && re.test(JSON.stringify(d.body || ""))).length;

test("3-WAY: the lock precedes the first MFL leg; success is recorded with the MFL trade ids as evidence; a second execute cannot send anything", async () => {
  const { env, mfl } = threeWay();
  let snap = null; const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (/TYPE=tradeProposal/.test(String(u) + String((i && i.body) || "")) && !snap) snap = led(env, F.TRADE_ID); return inner(u, i); };
  const out = await execute3Way(env, F.TRADE_ID);
  t.equal(out.ok, true, JSON.stringify(out).slice(0, 200)); t.ok(snap && snap.state === "executing", "the ledger said `executing` before the first leg reached MFL");
  const row = led(env, F.TRADE_ID); t.equal(row.state, "completed"); t.ok(JSON.parse(row.mfl_evidence_json).trade_ids.length >= 2, "the MFL trade ids are kept as evidence"); t.ok(row.mfl_executed_at_utc);
  t.equal(F.readRow(env).status, "completed");
  const n = mfl.writes().length;
  const again = await execute3Way(env, F.TRADE_ID);
  t.equal(mfl.writes().length, n, "a second execute sent nothing to MFL"); t.ok(again.skipped, "…and said why");
});
test("3-WAY CONCURRENT: two executes at once → the legs run exactly once", async () => {
  const { env, mfl } = threeWay();
  let release; mfl.st.holdAccept = new Promise((r) => { release = r; });
  const a = execute3Way(env, F.TRADE_ID), b = execute3Way(env, F.TRADE_ID);
  await new Promise((r) => setTimeout(r, 50)); release();
  const rs = await Promise.all([a, b]);
  t.equal(rs.filter((r) => r && r.ok).length, 1, "one run executed it"); t.equal(rs.filter((r) => r && r.skipped).length, 1, "the other was refused by the lock");
  const legs = tradesDone(mfl); const again = await execute3Way(env, F.TRADE_ID); t.equal(tradesDone(mfl), legs);
});
test("3-WAY EXTENSION FAILURE: the trade is EXECUTED (needs review, step `extensions`); owners are told it WAS executed; retry re-runs only the extension", async () => {
  const { env, mfl } = threeWay({ ext: true });
  mfl.st.failNext = { type: "salaries", status: 500 };
  const out = await execute3Way(env, F.TRADE_ID);
  t.equal(out.ok, true); t.equal(out.executed, true); t.equal(out.needs_review, true); t.equal(out.failed_step, "extensions");
  const row = led(env, F.TRADE_ID); t.equal(row.state, "executed_needs_review"); t.equal(row.failed_step, "extensions");
  t.equal(F.readRow(env).status, "completed", "never put back into a pending state"); t.match(F.readRow(env).failure_reason, /^executed_needs_review:extensions/);
  t.ok(dmsWith(mfl, /WAS executed/) >= 1, "the DM says the trade WAS executed");
  const detail = await callWorker(env, "GET", `/api/trades/3way?id=${F.TRADE_ID}&${Q}&MFL_USER_ID=tok-B`);
  t.equal(detail.status, 200); t.equal(detail.json.trade.executed, true); t.equal(detail.json.trade.execution.needs_review, true); t.equal(detail.json.trade.state_view.code === "executed_needs_review" || detail.json.trade.state_view.code === "incomplete", true);
  t.match(detail.json.trade.state_view.message, /WAS executed in MFL/); t.equal(detail.json.trade.execution.failed_step, undefined, "an owner is not shown the internal step");
  { const cm = await callWorker(env, "GET", `/api/trades/3way?id=${F.TRADE_ID}&${Q}&MFL_USER_ID=tok-A`); t.equal(cm.json.trade.execution.failed_step, "extensions", "the commissioner IS shown the exact failed step"); }
  const legs = tradesDone(mfl), sal = mfl.writes("salaries").length;
  const retry = await admin(env, "POST", "/admin/trade/postprocess-retry", { id: F.TRADE_ID, kind: "three_way" });
  t.equal(retry.status, 200, retry.text.slice(0, 200)); t.equal(retry.json.code, "completed");
  t.equal(tradesDone(mfl), legs, "no leg was re-sent"); t.equal(mfl.writes("salaries").length, sal + 1, "only the extension import ran");
  t.equal(led(env, F.TRADE_ID).state, "completed"); t.equal(F.readRow(env).failure_reason, null);
  t.equal((await admin(env, "POST", "/admin/trade/postprocess-retry", { id: F.TRADE_ID })).json.code, "already_completed");
});
test("3-WAY PARTIAL: a leg that fails after another landed is EXECUTED-NEEDS-REVIEW with the failed leg; it is never retried and never looks pending", async () => {
  const { env, mfl } = threeWay();
  let n = 0; const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => { const k = String(u) + String((i && i.body) || ""); if (/TYPE=tradeResponse/.test(k) && /RESPONSE=accept/i.test(k) && ++n === 2) return { ok: true, status: 200, text: async () => JSON.stringify({ error: "MFL boom" }), json: async () => ({ error: "MFL boom" }), headers: new Headers() }; return inner(u, i); };
  const out = await execute3Way(env, F.TRADE_ID);
  t.equal(out.ok, false);
  const row = led(env, F.TRADE_ID);
  t.equal(row.state, "executed_needs_review", "one leg landed → the trade is EXECUTED-needs-review, never not_executed");
  {
    t.equal(F.readRow(env).status, "failed", "legs partly executed → terminal, admin-reviewed");
    const retry = await admin(env, "POST", "/admin/trade/postprocess-retry", { id: F.TRADE_ID });
    t.equal(retry.status, 409); t.equal(retry.json.code, "legs_need_manual_fix", "post-processing retry cannot repair missing legs");
    const legs = tradesDone(mfl); await execute3Way(env, F.TRADE_ID); t.equal(tradesDone(mfl), legs, "no further MFL call, ever");
  }
});
test("3-WAY D1 FAILURE after the legs landed: the trade still reports executed and can never run again", async () => {
  const { env, mfl } = threeWay();
  onMflAccept(() => { env.UPS_MFL_DB.opts.beforeRun = (sql) => { if (/UPDATE ups_trade_executions/i.test(sql)) throw new Error("D1_ERROR: simulated write failure"); }; });
  const out = await execute3Way(env, F.TRADE_ID);
  env.UPS_MFL_DB.opts.beforeRun = null;
  t.ok(out && (out.ok === true || out.executed === true), "reported as executed: " + JSON.stringify(out).slice(0, 160));
  t.equal(F.readRow(env).status, "completed", "the trade row records the execution");
  const legs = tradesDone(mfl); const again = await execute3Way(env, F.TRADE_ID);
  t.equal(tradesDone(mfl), legs, "not sent again"); t.ok(again.skipped || again.ok === false);
  t.equal((await callWorker(env, "POST", `/api/trades/3way/recheck?${Q}&MFL_USER_ID=tok-A`, { body: { id: F.TRADE_ID } })).status, 409, "an executed trade cannot be 're-checked' into running");
});

// ═══════════════════════════════ three-team: unclear accepts and our own pending offer ═══════════════════════════════
// The commissioner's view of the offers MFL still holds, plus every MFL call made after a point (to prove a refusal reached MFL zero times).
const mflCalls = (mfl) => mfl.st.imports.length + mfl.st.exports.length;
// Wrap the stubbed network at a leg's accept: `fn(offer)` runs with the offer being accepted, BEFORE the (possibly throwing) answer returns.
function onLegAccept(mfl, fn) {
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    const k = String(u) + " " + String((i && i.body) || "");
    if (/TYPE=tradeResponse/.test(k) && /RESPONSE=accept/i.test(k)) {
      const id = (/TRADE_ID=(\d+)/.exec(k) || [])[1]; const offer = mfl.st.pending.find((p) => p.trade_id === id) || null;
      try { return await inner(u, i); } finally { if (offer) await fn(offer); }
    }
    return inner(u, i);
  };
}
const ledgerTx = (offer) => ({ type: "TRADE", franchise: offer.offeringteam, franchise1_gave_up: offer.will_give_up, franchise2: offer.offeredto, franchise2_gave_up: offer.will_receive, timestamp: String(Math.floor(Date.now() / 1000)) });

test("3-WAY OWN OFFER: MFL's propose answer carries no trade id and an UNRELATED offer between the same two teams is pending → it is never accepted (extract_trade_id, nothing moved)", async () => {
  const { env, mfl } = threeWay();
  mfl.addPending({ offeringteam: "0008", offeredto: "0001", will_give_up: "16193,", will_receive: "16181,", comments: "someone else's offer" });
  const inner = globalThis.fetch;
  globalThis.fetch = async (u, i) => (/TYPE=tradeProposal/.test(String(u) + String((i && i.body) || "")) ? { ok: true, status: 200, text: async () => JSON.stringify({ tradeProposal: { status: "OK" } }), json: async () => ({ tradeProposal: { status: "OK" } }), headers: new Headers() } : inner(u, i));
  const out = await execute3Way(env, F.TRADE_ID);
  t.equal(out.ok, false); t.equal(out.partial, false);
  t.equal(mfl.writes("tradeResponse").length, 0, "no accept was sent for anyone's offer");
  t.match(F.readRow(env).failure_reason, /^hub-1_extract_trade_id/); t.equal(F.readRow(env).status, "failed");
  t.equal(led(env, F.TRADE_ID).state, "not_executed", "provably nothing moved");
  t.equal(mfl.st.pending.length, 1, "the unrelated offer is still pending, untouched");
});
test("3-WAY UNCONFIRMED: leg 1's accept throws and MFL can't be read (transactions 502, pendingTrades 502) → UNCONFIRMED, the lock STAYS `executing`, one DM; /admin/3way/retry is refused 409 with zero MFL calls", async () => {
  const { env, mfl } = threeWay();
  onLegAccept(mfl, async () => { mfl.st.exportFail = { transactions: 502, pendingTrades: 502 }; });
  mfl.st.loseResponseNext = "timeout";
  const out = await execute3Way(env, F.TRADE_ID);
  t.equal(out.ok, false); t.equal(out.unconfirmed, true); t.equal(out.partial, false);
  t.equal(tradesDone(mfl), 1, "MFL did run the accept once"); t.equal(mfl.writes("tradeResponse").length, 1, "…and it was never sent again");
  t.equal(led(env, F.TRADE_ID).state, "executing", "the ledger stays `executing` — nothing can re-send it");
  t.equal(F.readRow(env).status, "failed"); t.match(F.readRow(env).failure_reason, /^UNCONFIRMED_hub-1/); t.ok(!F.readRow(env).mfl_trade_ids);
  t.equal(dmsWith(mfl, /couldn't confirm whether it went through/), 3, "one DM to each of the three teams");
  t.equal(dmsWith(mfl, /failed before anything moved/), 0, "never told nothing moved");
  const before = mflCalls(mfl);
  const retry = await admin(env, "POST", "/admin/3way/retry", { id: F.TRADE_ID });
  t.equal(retry.status, 409, retry.text.slice(0, 200)); t.equal(retry.json.execution_state, "executing");
  t.equal(mflCalls(mfl), before, "the refused retry made zero MFL calls"); t.equal(F.readRow(env).status, "failed", "…and left the row as it was");
});
test("3-WAY UNCLEAR BUT EXECUTED: leg 1's accept throws but MFL's transactions export lists it → the leg counts as landed and the trade completes (leg 1 never re-sent)", async () => {
  const { env, mfl } = threeWay();
  onLegAccept(mfl, async (offer) => {
    if (mfl.st.transactions && mfl.st.transactions.length) return;
    mfl.st.transactions = [ledgerTx(offer)];
    // MFL executed it: the players moved (the throwing answer skipped the stub's own roster move)
    const mv = (csv, from, to) => { for (const pid of String(csv).split(",").filter(Boolean)) { const src = mfl.st.rosters[from]; const ix = src.findIndex((p) => String(p.id) === pid); if (ix >= 0) mfl.st.rosters[to].push(...src.splice(ix, 1)); } };
    mv(offer.will_give_up, offer.offeringteam, offer.offeredto); mv(offer.will_receive, offer.offeredto, offer.offeringteam);
  });
  mfl.st.loseResponseNext = "timeout";
  const out = await execute3Way(env, F.TRADE_ID);
  t.equal(out.ok, true, JSON.stringify(out).slice(0, 200)); t.equal(out.trades.length, 2);
  t.equal(tradesDone(mfl), 2); t.equal(mfl.writes("tradeResponse").length, 2, "each leg accepted exactly once");
  t.equal(led(env, F.TRADE_ID).state, "completed"); t.equal(F.readRow(env).status, "completed");
});
test("3-WAY PROVABLY NOT EXECUTED: leg 1's accept returns an error, MFL's transactions export doesn't list it and the offer is still pending → not_executed; /admin/3way/retry is allowed and runs it once", async () => {
  const { env, mfl } = threeWay();
  mfl.st.failNext = { type: "tradeResponse", status: 500 };
  const out = await execute3Way(env, F.TRADE_ID);
  t.equal(out.ok, false); t.ok(!out.unconfirmed); t.equal(out.partial, false);
  t.equal(led(env, F.TRADE_ID).state, "not_executed"); t.match(F.readRow(env).failure_reason, /^hub-1_accept/);
  t.equal(dmsWith(mfl, /failed before anything moved/), 3);
  const retry = await admin(env, "POST", "/admin/3way/retry", { id: F.TRADE_ID });
  t.equal(retry.status, 200, retry.text.slice(0, 200)); t.equal(retry.json.ok, true);
  t.equal(led(env, F.TRADE_ID).state, "completed"); t.equal(tradesDone(mfl), 2, "both legs executed exactly once");
});

// ═══════════════════════════════ pure: finding our own pending offer ═══════════════════════════════
const PT = (...rows) => ({ pendingTrades: { pendingTrade: rows } });
const OWN = { from: "0008", to: "0001", give: "16614", receive: "16181", commentTag: "[Commish-processed: 3-way]" };
const row = (o) => ({ trade_id: "5001", offeringteam: "0008", offeredto: "0001", will_give_up: "16614,", will_receive: "16181,", comments: "[Commish-processed: 3-way] 3-way x hub-1", ...o });
test("OWN OFFER (pure): a row with a blank team is never a match", () => {
  t.deepEqual(findOwnPendingTrade(PT(row({ offeringteam: "" })), OWN), { match: "none" });
  t.deepEqual(findOwnPendingTrade(PT(row({ offeredto: undefined })), OWN), { match: "none" });
});
test("OWN OFFER (pure): the same two teams with different assets → none", () => {
  t.deepEqual(findOwnPendingTrade(PT(row({ will_give_up: "16614,16193," })), OWN), { match: "none" });
  t.deepEqual(findOwnPendingTrade(PT(row({ will_receive: "" })), OWN), { match: "none" });
  t.deepEqual(findOwnPendingTrade(PT(row({ offeringteam: "0001", offeredto: "0008" })), OWN), { match: "none" }, "the reversed direction is a different offer");
  t.deepEqual(findOwnPendingTrade(PT(row({ comments: "someone else's offer" })), OWN), { match: "none" }, "echoed comments without our tag → not ours");
});
test("OWN OFFER (pure): two identical matching rows → ambiguous (accept neither)", () => {
  t.deepEqual(findOwnPendingTrade(PT(row(), row({ trade_id: "5002" })), OWN), { match: "ambiguous", count: 2 });
});
test("OWN OFFER (pure): exactly one exact row → its id (also without echoed comments, and with MFL-token spellings)", () => {
  t.deepEqual(findOwnPendingTrade(PT(row(), row({ trade_id: "5003", will_receive: "99999," })), OWN), { match: "one", tradeId: "5001" });
  const noComments = row(); delete noComments.comments;
  t.deepEqual(findOwnPendingTrade({ pendingTrades: { pendingTrade: noComments } }, OWN), { match: "one", tradeId: "5001" }, "a single (non-array) row, no comments field → exact assets suffice");
  t.deepEqual(findOwnPendingTrade(PT(row({ will_give_up: "FP_0004_2027_4,111,DP_00_03,", will_receive: "222," })), { ...OWN, give: ["111", "FP_0004_2027_4", "DP_0_3"], receive: ["222"] }), { match: "one", tradeId: "5001" }, "mflTokens spellings normalize the same way");
  t.deepEqual(findOwnPendingTrade(null, OWN), { match: "none" });
});

await run("trade_execution_state");
restore();
