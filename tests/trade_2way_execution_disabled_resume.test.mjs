// EXECUTION-DISABLED HOLD + RESUMPTION + ROLLBACK (Keith, 2026-09-30): "with execution
// disabled, an accepted staged deal must NEVER enter a terminal `completed` state or send copy
// implying completion. It must remain held and resumable. Test flag-off acceptance, later
// flag-on resumption, and rollback with an in-flight deal."
//
// Root cause fixed: execute2Way's and runTradeLegAfterDrops' own TRADE_2WAY_STAGING_EXECUTE=0
// branches used to mark the row 'completed' (failure_reason 'dry_run') and DM a checkmark
// ("cleared") message with the caveat buried in a parenthetical -- an owner would reasonably
// read that as done. Worse for the drop-first path: real, irreversible drops can already have
// happened by the time that branch ran, and it moved the LEDGER itself all the way to
// COMPLETED, a permanent-fact state this codebase trusts everywhere else, when the trade was
// never sent to MFL. Both are fixed to hold instead (see trade_2way.js).
//
// Uses the SAME real-fake-MFL harness as tests/trade_hammer_chig_end_to_end.test.mjs (real
// worker, real D1, a stateful fake MFL) -- this is the actual Hammer/Chig scenario Keith asked
// about, run with the execution flags OFF first, then flipped on to prove resumption.
//   node tests/trade_2way_execution_disabled_resume.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, bindSelf, quiet } from "./fixtures/worker_harness.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const restoreConsole = quiet();
const { createStaged2WayTrade, accept2WayTrade, recheck2WayExecution, select2WayLoadedContractDrops, executeDropFirstDeal, get2WayTrade } = await import("../worker/src/trade_2way.js");

const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];
const SENDER = "0001", HAMMER = "0005";
const flat = (id) => ({ id, salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" });
const loaded = (id) => ({ id, salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" });

function fresh(over) {
  const env = makeWorkerEnv({ __migrations: MIGRATIONS, TRADE_2WAY_STAGING_ENABLED: "1", COMMISH_DISCORD_USER_ID: "621530026831118346", ...((over && over.env) || {}) });
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(SENDER, "Y", "100000000000000001");
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(HAMMER, "Y", "100000000000000005");
  bindSelf(env);
  const mfl = makeMfl({ tokens: { "tok-H": HAMMER }, ...(over && over.mfl) });
  mfl.install();
  return { env, mfl };
}
const ledgerRow = (env, id) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_executions WHERE exec_key=?").get(id);
const tradeRow = (env, id) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades WHERE id=?").get(id);
// makeMfl's fake Discord channel id is deterministically "dm-<recipient_id>" (worker_harness.mjs);
// a DM message POSTs to /api/v10/channels/dm-<recipient_id>/messages.
const dmsTo = (mfl, userId) => mfl.st.discord.filter((c) => c.url === `/api/v10/channels/dm-${userId}/messages` && c.body).map((c) => ({ content: c.body.content }));

// The real drop-action fetch stub, reused byte-identical from trade_hammer_chig_end_to_end.test.mjs.
const ACTION_URL = "https://www48.myfantasyleague.com/2026/csetup";
function loadRostPageHtml(leagueId, franchiseId, rosterIds) {
  const options = rosterIds.map((pid) => `<option value="${pid}">Player ${pid}</option>`).join("\n        ");
  return `<!DOCTYPE html><html><body>
    <form action="${ACTION_URL}?L=${leagueId}&FRANCHISE=${franchiseId}&C=LOADROST" method="POST">
      <input type="hidden" name="L" value="${leagueId}">
      <input type="hidden" name="FRANCHISE" value="${franchiseId}">
      <input type="hidden" name="C" value="LOADROST">
      <input type="text" name="sel_pid" value="">
      <input type="text" name="picker_filt_name" value="">
      <select name="ROSTER" multiple="multiple">
        ${options}
      </select>
      <input type="submit" value="Submit">
    </form>
  </body></html>`;
}
function installRealDropActionFetchStub(env, mfl) {
  const delegate = globalThis.fetch;
  const postedCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const isCsetupLoadRost = url.pathname.endsWith("/csetup") && url.searchParams.get("C") === "LOADROST";
    if (isCsetupLoadRost && (!init || (init.method || "GET").toUpperCase() === "GET")) {
      return new Response(loadRostPageHtml(url.searchParams.get("L"), url.searchParams.get("FRANCHISE"), (mfl.st.rosters[url.searchParams.get("FRANCHISE")] || []).map((p) => p.id)), { status: 200, headers: { "content-type": "text/html" } });
    }
    if (url.pathname.endsWith("/csetup") && init && (init.method || "").toUpperCase() === "POST") {
      const params = new URLSearchParams(init.body);
      const rosterIds = params.getAll("ROSTER");
      postedCalls.push({ franchiseId: params.get("FRANCHISE"), rosterIds });
      const fid = params.get("FRANCHISE");
      if (fid && mfl.st.rosters[fid]) { const keep = new Set(rosterIds); mfl.st.rosters[fid] = mfl.st.rosters[fid].filter((p) => keep.has(String(p.id))); }
      return new Response("OK", { status: 200, headers: { "content-type": "text/html" } });
    }
    return delegate(input, init);
  };
  return { postedCalls, restore: () => { globalThis.fetch = delegate; } };
}

// ═══════════════════════ NO DROPS REQUIRED ═══════════════════════

test("NO-DROPS-REQUIRED, FLAG OFF: accept holds the deal -- never completed, never a fabricated mfl_trade_id, DM never implies completion", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_STAGING_EXECUTE: "0" } });
  const created = await createStaged2WayTrade(env, {}, {
    leagueId: "74598", season: "2026", from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" },
    movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056"], cap_k: 0 }],
  });
  mfl.st.rosters[SENDER] = [flat("14056")];
  mfl.st.rosters[HAMMER] = [flat("13100")];
  const ctx = { waits: [], waitUntil(p) { this.waits.push(p); }, async flush() { await Promise.allSettled(this.waits); } };
  const acc = await accept2WayTrade(env, ctx, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});
  t.equal(acc.ok, true); t.equal(acc.accepted, true); t.equal(acc.executing, true);
  await ctx.flush();

  const row = tradeRow(env, created.id);
  t.equal(row.status, "collecting", "never terminal");
  t.equal(row.to_state, "accepted");
  t.equal(row.mfl_trade_id, null);
  t.notEqual(row.failure_reason, "dry_run");
  t.equal(mfl.st.imports.length, 0, "nothing was ever sent to MFL");

  const detail = await get2WayTrade(env, created.id, { fid: SENDER, leagueId: "74598", season: "2026" }, {});
  t.equal(detail.trade.state_view.code, "awaiting_commissioner");
  t.equal(detail.trade.state_view.label, "Accepted — awaiting commissioner review");
  t.doesNotMatch(detail.trade.state_view.message, /✅|completed|fully cleared|turn on live/i, "never stale/completion-implying copy");
  t.match(detail.trade.state_view.message, /Rosters and contract limits will be checked again before any drop or trade/);
  t.equal(detail.trade.permissions.can_recheck, true, "Re-check is now reachable for this hold (fixed can_recheck)");
});

test("NO-DROPS-REQUIRED, LATER FLAG-ON RESUMPTION: the SAME held deal completes for real once TRADE_2WAY_STAGING_EXECUTE is turned on and the owner re-checks -- no re-creation, no re-acceptance", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_STAGING_EXECUTE: "0" } });
  mfl.st.rosters[SENDER] = [flat("14056")];
  mfl.st.rosters[HAMMER] = [flat("13100")];
  const created = await createStaged2WayTrade(env, {}, {
    leagueId: "74598", season: "2026", from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" },
    movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056"], cap_k: 0 }],
  });
  const ctx1 = { waits: [], waitUntil(p) { this.waits.push(p); }, async flush() { await Promise.allSettled(this.waits); } };
  await accept2WayTrade(env, ctx1, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});
  await ctx1.flush();
  t.equal(tradeRow(env, created.id).status, "collecting", "sanity: held");

  env.TRADE_2WAY_STAGING_EXECUTE = "1";
  const ctx2 = { waits: [], waitUntil(p) { this.waits.push(p); }, async flush() { await Promise.allSettled(this.waits); } };
  const r = await recheck2WayExecution(env, ctx2, created.id, { fid: SENDER, leagueId: "74598", season: "2026" });
  t.ok(r.ok, JSON.stringify(r)); t.equal(r.rechecking, true);
  await ctx2.flush();

  const row = tradeRow(env, created.id);
  t.equal(row.status, "completed", "now genuinely completed -- the flag is live");
  t.ok(row.mfl_trade_id, "a real MFL trade id this time");
  const tradeImports = mfl.st.imports.filter((x) => x.type === "tradeProposal" || x.type === "tradeResponse");
  t.equal(tradeImports.length, 2, "a real commissioner-run propose+accept pair actually ran");
});

test("NO-DROPS-REQUIRED, ROLLBACK WITH AN IN-FLIGHT DEAL: flag on then back off before anyone rechecks leaves the held deal untouched; a recheck while still off changes nothing; turning it on again resumes correctly", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_STAGING_EXECUTE: "0" } });
  mfl.st.rosters[SENDER] = [flat("14056")];
  mfl.st.rosters[HAMMER] = [flat("13100")];
  const created = await createStaged2WayTrade(env, {}, {
    leagueId: "74598", season: "2026", from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" },
    movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056"], cap_k: 0 }],
  });
  const ctx1 = { waits: [], waitUntil(p) { this.waits.push(p); }, async flush() { await Promise.allSettled(this.waits); } };
  await accept2WayTrade(env, ctx1, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});
  await ctx1.flush();
  t.equal(tradeRow(env, created.id).status, "collecting");

  // Flip ON then back OFF before anyone acts -- simulating an operator who reconsidered
  // mid-rollout. Nothing in this codebase runs merely because an env var changed -- only the
  // NEXT actual call reads it -- so the already-held deal is untouched either way.
  env.TRADE_2WAY_STAGING_EXECUTE = "1";
  env.TRADE_2WAY_STAGING_EXECUTE = "0";
  t.equal(tradeRow(env, created.id).status, "collecting");
  t.equal(tradeRow(env, created.id).mfl_trade_id, null);

  const ctx2 = { waits: [], waitUntil(p) { this.waits.push(p); }, async flush() { await Promise.allSettled(this.waits); } };
  const r2 = await recheck2WayExecution(env, ctx2, created.id, { fid: SENDER, leagueId: "74598", season: "2026" });
  t.ok(r2.ok); await ctx2.flush();
  t.equal(tradeRow(env, created.id).status, "collecting", "a recheck while still off changes nothing");
  t.equal(mfl.st.imports.length, 0);

  env.TRADE_2WAY_STAGING_EXECUTE = "1";
  const ctx3 = { waits: [], waitUntil(p) { this.waits.push(p); }, async flush() { await Promise.allSettled(this.waits); } };
  const r3 = await recheck2WayExecution(env, ctx3, created.id, { fid: SENDER, leagueId: "74598", season: "2026" });
  t.ok(r3.ok); await ctx3.flush();
  t.equal(tradeRow(env, created.id).status, "completed", "the same deal, never lost or re-created, now completes");
  t.ok(tradeRow(env, created.id).mfl_trade_id);
});

// ═══════════════════════ DROP-FIRST (the actual Hammer/Chig scenario) ═══════════════════════

test("HAMMER/CHIG, DROPS ON BUT TRADE EXECUTION OFF: the conditional drop happens for REAL, but the trade itself HOLDS -- never completed, ledger never fabricates COMPLETED, both owners are told it's awaiting the commissioner", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_DROP_EXECUTE_ENABLED: "1", TRADE_2WAY_STAGING_EXECUTE: "0" } });
  mfl.st.rosters[SENDER] = [{ id: "14056", salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" }]; // Chig Okonkwo
  mfl.st.rosters[HAMMER] = [flat("13100"), loaded("9000"), loaded("9001"), loaded("9002"), loaded("9003"), loaded("9004")];

  const created = await createStaged2WayTrade(env, {}, {
    leagueId: "74598", season: "2026", from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" },
    movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056"], cap_k: 0 }],
  });
  const sel = await select2WayLoadedContractDrops(env, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, ["9004"]);
  t.equal(sel.ok, true, JSON.stringify(sel)); t.equal(sel.drop_requirement.satisfied, true);

  const ctx = { waitUntil: (p) => p };
  const acc = await accept2WayTrade(env, ctx, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});
  t.equal(acc.ok, true); t.equal(acc.executing, false, "held at accept -- the selection is conditional, not yet executed");

  const stub = installRealDropActionFetchStub(env, mfl);
  let r;
  try {
    r = await executeDropFirstDeal(env, {}, created.id);
  } finally { stub.restore(); }

  // The DROP is real and irreversible -- proven directly against the fake MFL's own roster state.
  t.equal(mfl.st.rosters[HAMMER].some((p) => p.id === "9004"), false, "the player really is off HammerTime's roster");
  t.equal(stub.postedCalls.length, 1, "exactly one real drop write happened");

  // The TRADE did not go through, and NOTHING here claims otherwise.
  t.equal(r.ok, true, JSON.stringify(r));
  t.equal(r.held, true);
  t.equal(r.reason, "execution_disabled");
  const led = ledgerRow(env, created.id);
  t.equal(led.state, "partial_executed", "the ledger reflects the TRUE fact -- drop done, trade not -- never fabricated as completed");
  const steps = JSON.parse(led.steps_json);
  t.equal(steps["drop:9004"].status, "confirmed", "the drop step really is recorded confirmed (it happened)");
  t.ok(!steps.trade || steps.trade.status !== "confirmed", "the trade step was never recorded confirmed -- it never happened");
  const row = tradeRow(env, created.id);
  t.equal(row.status, "collecting", "never 'completed' -- the trade itself did not go through");
  t.equal(row.mfl_trade_id, null);

  // Zero trade-proposal/response MFL writes -- only the roster-workbench drop action posted.
  const tradeImports = mfl.st.imports.filter((x) => x.type === "tradeProposal" || x.type === "tradeResponse");
  t.equal(tradeImports.length, 0, "the trade leg was never sent to MFL");

  // Both owners were told plainly, not with completion language.
  const owner = dmsTo(mfl, "100000000000000001").concat(dmsTo(mfl, "100000000000000005"));
  const held = owner.filter((d) => /awaiting commissioner review/.test(d.content || ""));
  t.ok(held.length >= 1, "at least one DM says plainly it's awaiting commissioner review");
  for (const d of held) {
    t.doesNotMatch(d.content, /✅|fully cleared|turn on live/i);
    t.match(d.content, /rosters and contract limits will be checked again/i);
  }
});

test("HAMMER/CHIG, LATER FLAG-ON RESUMPTION: re-running POST /api/trades/2way/execute (the commissioner action) after the flag is turned on skips the already-confirmed drop and completes the trade for real", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_DROP_EXECUTE_ENABLED: "1", TRADE_2WAY_STAGING_EXECUTE: "0" } });
  mfl.st.rosters[SENDER] = [{ id: "14056", salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" }];
  mfl.st.rosters[HAMMER] = [flat("13100"), loaded("9000"), loaded("9001"), loaded("9002"), loaded("9003"), loaded("9004")];
  const created = await createStaged2WayTrade(env, {}, {
    leagueId: "74598", season: "2026", from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" },
    movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056"], cap_k: 0 }],
  });
  await select2WayLoadedContractDrops(env, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, ["9004"]);
  await accept2WayTrade(env, { waitUntil: (p) => p }, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});

  const stub1 = installRealDropActionFetchStub(env, mfl);
  let r1; try { r1 = await executeDropFirstDeal(env, {}, created.id); } finally { stub1.restore(); }
  t.equal(r1.held, true);
  t.equal(ledgerRow(env, created.id).state, "partial_executed");

  // Commissioner turns live execution on, then re-runs the SAME commissioner action.
  env.TRADE_2WAY_STAGING_EXECUTE = "1";
  const stub2 = installRealDropActionFetchStub(env, mfl);
  let r2; try { r2 = await executeDropFirstDeal(env, {}, created.id); } finally { stub2.restore(); }
  t.equal(r2.ok, true, JSON.stringify(r2));
  t.equal(stub2.postedCalls.length, 0, "the already-confirmed drop is never repeated");
  t.equal(ledgerRow(env, created.id).state, "completed");
  t.equal(tradeRow(env, created.id).status, "completed");
  t.ok(tradeRow(env, created.id).mfl_trade_id);
});

test("HAMMER/CHIG, ROLLBACK WITH AN IN-FLIGHT (PARTIALLY EXECUTED) DEAL: flipping the flag on then back off before the commissioner resumes changes nothing -- the confirmed drop stays confirmed, the trade stays unattempted, and resuming later still works", async () => {
  const { env, mfl } = fresh({ env: { TRADE_2WAY_DROP_EXECUTE_ENABLED: "1", TRADE_2WAY_STAGING_EXECUTE: "0" } });
  mfl.st.rosters[SENDER] = [{ id: "14056", salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" }];
  mfl.st.rosters[HAMMER] = [flat("13100"), loaded("9000"), loaded("9001"), loaded("9002"), loaded("9003"), loaded("9004")];
  const created = await createStaged2WayTrade(env, {}, {
    leagueId: "74598", season: "2026", from: { fid: SENDER, name: "Sender Squad" }, to: { fid: HAMMER, name: "HammerTime" },
    movements: [{ from: SENDER, to: HAMMER, asset_tokens: ["14056"], cap_k: 0 }],
  });
  await select2WayLoadedContractDrops(env, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, ["9004"]);
  await accept2WayTrade(env, { waitUntil: (p) => p }, created.id, { fid: HAMMER, leagueId: "74598", season: "2026" }, {});
  const stub1 = installRealDropActionFetchStub(env, mfl);
  try { await executeDropFirstDeal(env, {}, created.id); } finally { stub1.restore(); }
  t.equal(ledgerRow(env, created.id).state, "partial_executed");
  const confirmedSteps = JSON.parse(ledgerRow(env, created.id).steps_json);

  // Rollback: on, then off again, before the commissioner ever resumes.
  env.TRADE_2WAY_STAGING_EXECUTE = "1";
  env.TRADE_2WAY_STAGING_EXECUTE = "0";
  t.equal(ledgerRow(env, created.id).state, "partial_executed", "untouched by the flag flips themselves");
  t.deepEqual(JSON.parse(ledgerRow(env, created.id).steps_json), confirmedSteps, "the confirmed drop step is exactly as it was -- never re-attempted, never lost");
  t.equal(tradeRow(env, created.id).status, "collecting");

  // A commissioner re-run while STILL off: correctly held again, no new MFL write.
  const stub2 = installRealDropActionFetchStub(env, mfl);
  let r2; try { r2 = await executeDropFirstDeal(env, {}, created.id); } finally { stub2.restore(); }
  t.equal(r2.held, true);
  t.equal(stub2.postedCalls.length, 0, "the already-confirmed drop is not repeated just because execute was re-run");
  t.equal(ledgerRow(env, created.id).state, "partial_executed");

  // NOW turn it on for real -- the deal resumes and completes correctly.
  env.TRADE_2WAY_STAGING_EXECUTE = "1";
  const stub3 = installRealDropActionFetchStub(env, mfl);
  let r3; try { r3 = await executeDropFirstDeal(env, {}, created.id); } finally { stub3.restore(); }
  t.equal(r3.ok, true, JSON.stringify(r3));
  t.equal(ledgerRow(env, created.id).state, "completed");
  t.equal(tradeRow(env, created.id).status, "completed");
});

await run("trade_2way_execution_disabled_resume");
