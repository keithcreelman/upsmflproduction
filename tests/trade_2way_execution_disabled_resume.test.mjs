// EXECUTION-DISABLED HOLD + RESUMPTION + ROLLBACK (Keith, 2026-09-30): "with execution
// disabled, an accepted staged deal must NEVER enter a terminal `completed` state or send copy
// implying completion. It must remain held and resumable. Test flag-off acceptance, later
// flag-on resumption, and rollback with an in-flight deal."
//
// Root cause fixed: execute2Way's own TRADE_2WAY_STAGING_EXECUTE=0 branch used to mark the row
// 'completed' (failure_reason 'dry_run') and DM a checkmark ("cleared") message with the caveat
// buried in a parenthetical -- an owner would reasonably read that as done, when nothing was
// ever sent to MFL. Fixed to hold instead (see trade_2way.js). This branch (#1149) has no
// drop-first orchestrator -- that lives in the sibling drop-first-execution branch, whose own
// test file of this same name additionally covers the drop-first (Hammer/Chig) version of this
// exact fix. This file covers the no-drops-required path only.
//   node tests/trade_2way_execution_disabled_resume.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, bindSelf, quiet } from "./fixtures/worker_harness.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const restoreConsole = quiet();
const { createStaged2WayTrade, accept2WayTrade, recheck2WayExecution, get2WayTrade } = await import("../worker/src/trade_2way.js");

const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];
const SENDER = "0001", HAMMER = "0005";
const flat = (id) => ({ id, salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" });

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
const tradeRow = (env, id) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades WHERE id=?").get(id);

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
  t.doesNotMatch(detail.trade.state_view.message, /✅|completed/i);
  t.match(detail.trade.state_view.message, /waiting on the commissioner to turn on live trade execution/);
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

await run("trade_2way_execution_disabled_resume");
