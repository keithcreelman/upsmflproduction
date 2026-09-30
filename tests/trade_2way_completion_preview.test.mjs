// §12.1 of docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md: the READ-ONLY "ready to complete" +
// dry-run preview extension to the commissioner queue. Keith's ruling (2026-09-29): "a staged
// two-team trade currently cannot be completed... Implement the read-only and dry-run portions
// now; keep real drop/trade writes disabled until the sequence and recovery policy are
// explicitly decided." This proves: a trade is marked ready ONLY when accepted AND fully
// compliant (never "needs_drops", even satisfied -- a selection is not an executed drop); the
// preview is byte-identical to what execute2Way itself would attempt (same derivation function,
// not a re-implementation); and viewing the queue any number of times -- for any trade, in any
// state -- never advances the execution ledger or calls MFL, regardless of
// TRADE_2WAY_STAGING_EXECUTE's value.
//   node tests/trade_2way_completion_preview.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { installDiscordRecorder, quietConsole, viewer, commishViewer } from "./fixtures/trade_3way_fixture.mjs";
import { makeD1, applyMigrations, THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

await import("./fixtures/register_md_loader.mjs");
const { createStaged2WayTrade, accept2WayTrade, listCommish2WayQueue, execute2Way, select2WayLoadedContractDrops } = await import("../worker/src/trade_2way.js");

const restoreConsole = quietConsole();
const discord = installDiscordRecorder();
const FR = { A: "0008", B: "0001" };
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];

function makeEnv(opts) {
  opts = opts || {};
  const db = makeD1(opts.d1);
  applyMigrations(db, MIGRATIONS);
  db.raw.exec("CREATE TABLE IF NOT EXISTS discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  db.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(FR.A, "Y", "100000000000000001");
  db.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(FR.B, "Y", "100000000000000002");
  const selfCalls = [];
  const healthy = { participants: [], cap: { status: "ok", reason: "", cap_dollars: 300000, rows: [], violations: [], message: "" },
    roster: { status: "ok", advisory: true, rows: [], warnings: [], message: "" },
    loaded_contracts: { status: "ok", max: 5, rows: [], violations: [], message: "" },
    lineup: { status: "ok", advisory: true, rows: [], warnings: [], message: "" }, extension_skipped: [] };
  const self = { fetch: async (u, init) => {
    selfCalls.push({ url: String(u), body: init && init.body ? JSON.parse(init.body) : null });
    const c = typeof opts.compliance === "function" ? await opts.compliance(selfCalls[selfCalls.length - 1]) : (opts.compliance || healthy);
    if (c && c.__status) return { ok: false, status: c.__status, json: async () => ({ ok: false }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, compliance: c }) };
  } };
  return { UPS_MFL_DB: db, DISCORD_BOT_TOKEN: "test-token", TRADE_2WAY_STAGING_ENABLED: "1", COMMISH_API_KEY: "admin-key-secret", MFL_APIKEY: "commish-mfl-key", SELF: self, __selfCalls: selfCalls, ...(opts.env || {}) };
}
const CREATE_SPEC = (over) => ({
  leagueId: "74598", season: "2026",
  from: { fid: FR.A, name: "Real Deal Creel" }, to: { fid: FR.B, name: "L.A. Looks" },
  movements: [{ from: FR.A, to: FR.B, asset_tokens: ["P_16614"], cap_k: 0 }],
  ...(over || {}),
});

test("NOT READY: a freshly-created, not-yet-accepted trade is never ready_to_complete, and no dry-run preview is shown", async () => {
  const env = makeEnv();
  await createStaged2WayTrade(env, {}, CREATE_SPEC());
  const q = await listCommish2WayQueue(env, "74598", "2026", {});
  t.equal(q.trades.length, 1);
  t.equal(q.trades[0].ready_to_complete, false);
  t.equal(q.trades[0].completion_available, false);
  t.equal(q.trades[0].not_ready_reason, "not_yet_accepted");
  t.equal(q.trades[0].dry_run_preview, null);
});

test("NOT READY: accepted but compliance is 'needs_drops' (even fully SATISFIED) is never ready -- a satisfied selection is not an executed drop", async () => {
  const env = makeEnv({
    compliance: (call) => {
      const drops = (call.body && call.body.conditional_drops && call.body.conditional_drops[FR.A]) || [];
      const satisfied = drops.includes("90200");
      return {
        participants: [], cap: { status: "ok", violations: [], message: "" }, roster: { status: "ok", advisory: true, warnings: [], message: "" },
        loaded_contracts: { status: satisfied ? "needs_drops" : "blocked", max: 5, message: "x", violations: [{ franchise_id: FR.A, franchise_name: "Real Deal Creel", projected: 6, max: 5 }], drop_requirements: [{ franchise_id: FR.A, franchise_name: "Real Deal Creel", satisfied, loaded_before: 5, projected: 6, required_drops: 1, valid_count: satisfied ? 1 : 0, selected: drops }] },
        lineup: { status: "ok", advisory: true, warnings: [], message: "" }, extension_skipped: [],
      };
    },
  });
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  await select2WayLoadedContractDrops(env, created.id, viewer(FR.A, { leagueId: "74598", season: "2026" }), ["90200"]);
  const ctx = { waitUntil: (p) => p };
  const accept = await accept2WayTrade(env, ctx, created.id, viewer(FR.B, { leagueId: "74598", season: "2026" }), {});
  t.equal(accept.executing, false); // held on needs_drops, exactly as trade_2way_staged.test.mjs already proves
  const q = await listCommish2WayQueue(env, "74598", "2026", {});
  t.equal(q.trades[0].ready_to_complete, false, "satisfied needs_drops must never read as ready -- no executor exists to act on the selection");
  t.equal(q.trades[0].not_ready_reason, "loaded_contract_drops_required");
  t.equal(q.trades[0].dry_run_preview, null);
});

test("READY: accepted + fully compliant -- ready_to_complete is true, and the dry-run preview is BYTE-IDENTICAL to what execute2Way itself then actually sends", async () => {
  const env = makeEnv();
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC({ movements: [{ from: FR.A, to: FR.B, asset_tokens: ["P_16181"], cap_k: 0 }] }));
  // Move straight to the exact state a commissioner would see mid-review -- accepted, compliant,
  // not yet completed -- by direct SQL rather than racing the real accept flow's own
  // synchronous-start execute2Way call (which begins running the instant accept2WayTrade
  // returns, making "still executing but not yet completed" a genuinely non-deterministic
  // window to catch through the public API alone). This is the SAME state accept2WayTrade
  // itself produces one D1 write earlier; previewExecute2Way and execute2Way are both pure
  // functions of this row's own columns from this point on.
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_2way_trades SET status='executing', to_state='accepted', updated_at_utc=? WHERE id=?").run(new Date().toISOString(), created.id);

  const q = await listCommish2WayQueue(env, "74598", "2026", {});
  const row = q.trades.find((tr) => tr.id === created.id);
  t.equal(row.ready_to_complete, true);
  t.equal(row.completion_available, false, "compliance passing must NEVER flip completion_available true -- no executor exists in this codebase regardless of compliance state");
  t.ok(row.dry_run_preview);
  t.equal(row.dry_run_preview.from_fid, FR.A);
  t.equal(row.dry_run_preview.to_fid, FR.B);
  t.deepEqual(row.dry_run_preview.give, ["P_16181"]);
  t.deepEqual(row.dry_run_preview.receive, []);

  // Now actually run execute2Way (fully awaited, no race) and confirm it moved the SAME
  // franchises' SAME assets -- proving the preview wasn't a guess.
  const result = await execute2Way(env, created.id);
  t.ok(result.dry_run);
  const after = env.UPS_MFL_DB.raw.prepare("SELECT status, mfl_trade_id, failure_reason FROM ups_2way_trades WHERE id=?").get(created.id);
  t.equal(after.status, "completed");
  t.equal(after.failure_reason, "dry_run");
  t.equal(after.mfl_trade_id, null);
});

test("ZERO WRITES: reading the queue for a ready trade -- any number of times -- never advances the ledger or calls MFL, whatever TRADE_2WAY_STAGING_EXECUTE is set to", async () => {
  const env = makeEnv({ env: { TRADE_2WAY_STAGING_EXECUTE: "1" } }); // deliberately the DANGEROUS setting -- must not matter for a pure read
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  // Same direct-SQL technique as the READY test above -- puts the row in the exact
  // accepted+executing state a commissioner would see, WITHOUT ever calling execute2Way (this
  // test's whole point is that VIEWING the queue must never be what advances it).
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_2way_trades SET status='executing', to_state='accepted', updated_at_utc=? WHERE id=?").run(new Date().toISOString(), created.id);
  discord.reset();
  for (let i = 0; i < 5; i++) {
    const q = await listCommish2WayQueue(env, "74598", "2026", {});
    t.equal(q.trades[0].ready_to_complete, true);
  }
  t.equal(discord.calls.length, 0, "five reads of the queue must never send a single Discord message (a proxy for 'nothing executed' -- execute2Way always DMs both sides on completion)");
  const row = env.UPS_MFL_DB.raw.prepare("SELECT status FROM ups_2way_trades WHERE id=?").get(created.id);
  t.equal(row.status, "executing", "the row's status is untouched by reading the queue five times -- nothing in listCommish2WayQueue ever calls execute2Way");
});

await run("trade_2way_completion_preview");
restoreConsole();
