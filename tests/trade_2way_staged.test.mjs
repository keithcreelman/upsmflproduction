// STAGED 2-way trades — the new universal server-side staging engine
// (worker/src/trade_2way.js, worker/src/trade_2way_http.js). Keith's ruling (2026-09-29,
// docs/LOADED_CONTRACT_DROP_EXECUTION_DESIGN.md §8): no 2-way trade this app creates may
// become a real MFL tradeProposal while pending; both franchises' compliance is rechecked at
// every acceptance and before execution; a satisfied conditional-drop selection means
// "awaiting review," never permission for an automatic MFL write.
//
// installDiscordRecorder() below THROWS on any fetch() that isn't to discord.com — since
// TRADE_2WAY_STAGING_EXECUTE is never set to "1" anywhere in this file, execute2Way always
// takes the DRY-RUN branch and never reaches executeCommishTwoPartyTrade's real
// myfantasyleague.com fetch() at all. Any test that somehow DID reach a real MFL call would
// crash immediately with "unexpected network call in test" -- this is the zero-MFL-writes
// guarantee, enforced structurally, not just asserted after the fact.
//
// Run: node tests/trade_2way_staged.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1, applyMigrations, THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";
import { installDiscordRecorder, quietConsole, viewer, commishViewer, NAMES } from "./fixtures/trade_3way_fixture.mjs";
await import("./fixtures/register_md_loader.mjs");
const { createStaged2WayTrade, get2WayTrade, accept2WayTrade, cancel2WayTrade, select2WayLoadedContractDrops, execute2Way } = await import("../worker/src/trade_2way.js");
const { handle2WayStagedHttp } = await import("../worker/src/trade_2way_http.js");

const restoreConsole = quietConsole();
const discord = installDiscordRecorder();
// waitUntil is fire-and-forget in real Workers; the engine dispatches DMs and (in dry-run)
// execution through it. Tests must capture and await those promises before asserting on
// their side effects, or they'll race a still-pending microtask -- same pattern as
// tests/trade_3way_http.test.mjs's ctxWait().
const ctxWait = () => { const p = []; return { waitUntil: (x) => p.push(x), flush: () => Promise.all(p) }; };

const FR = { A: "0008", B: "0001" };
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];
// roster maximum + five active QBs, both fine (the real compliance route always carries them; the staged gate requires them)
const LIMITS_OK = { roster_limit: { status: "ok", max: 30, rows: [], violations: [], executable: true, message: "" }, qb_limit: { status: "ok", max: 5, rows: [], violations: [], executable: true, message: "" } };

function makeEnv(opts) {
  opts = opts || {};
  const db = makeD1(opts.d1);
  applyMigrations(db, MIGRATIONS);
  db.raw.exec("CREATE TABLE IF NOT EXISTS discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  db.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(FR.A, "Y", "100000000000000001");
  db.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(FR.B, "Y", "100000000000000002");
  const selfCalls = [];
  const healthy = { participants: [], cap: { status: "ok", reason: "", cap_dollars: 300000, rows: [], violations: [], message: "Every team stays under the salary cap." },
    roster: { status: "ok", advisory: true, rows: [], warnings: [], message: "Every team stays within its roster limits." },
    loaded_contracts: { status: "ok", max: 5, rows: [], violations: [], message: "Every team stays at or under the 5 loaded-contract limit." },
    // the real compliance route has carried these since #1189; the staged gate requires them (missing = unavailable)
    roster_limit: { status: "ok", max: 30, rows: [], violations: [], executable: true, message: "Every team stays at or under the roster maximum." },
    qb_limit: { status: "ok", max: 5, rows: [], violations: [], executable: true, message: "Every team stays at or under 5 active QBs." },
    lineup: { status: "ok", advisory: true, rows: [], warnings: [], message: "Every team can still field a complete legal lineup after this trade." },
    extension_skipped: [] };
  const self = opts.self === false ? undefined : { fetch: async (u, init) => {
    selfCalls.push({ url: String(u), body: init && init.body ? JSON.parse(init.body) : null });
    const c = typeof opts.compliance === "function" ? await opts.compliance(selfCalls[selfCalls.length - 1]) : (opts.compliance || healthy);
    if (c && c.__status) return { ok: false, status: c.__status, json: async () => ({ ok: false }) };
    return { ok: true, status: 200, json: async () => ({ ok: true, compliance: c }) };
  } };
  return { UPS_MFL_DB: db, DISCORD_BOT_TOKEN: "test-token", TRADE_2WAY_STAGING_ENABLED: "1", COMMISH_API_KEY: "admin-key-secret", MFL_APIKEY: "commish-mfl-key", ...(self ? { SELF: self } : {}), __selfCalls: selfCalls, ...(opts.env || {}) };
}

const CREATE_SPEC = (over) => ({
  leagueId: "74598", season: "2026",
  from: { fid: FR.A, name: "Real Deal Creel" }, to: { fid: FR.B, name: "L.A. Looks" },
  movements: [{ from: FR.A, to: FR.B, asset_tokens: ["P_16614"], cap_k: 0 }],
  ...(over || {}),
});

// ═══════════════════════ CREATE: stages, never touches MFL ═══════════════════════

test("CREATE: a staged 2-way trade lands in D1 as 'collecting' -- getRow directly proves no MFL trade id exists yet, and the disabled-fetch recorder proves no MFL call was ever attempted", async () => {
  const env = makeEnv();
  const r = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  t.ok(r.ok, JSON.stringify(r));
  const row = env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades WHERE id=?").get(r.id);
  t.equal(row.status, "collecting");
  t.equal(row.mfl_trade_id, null);
  t.equal(row.from_fid, FR.A);
  t.equal(row.to_fid, FR.B);
  t.equal(row.to_state, "pending");
});

test("CREATE: disabled by default -- TRADE_2WAY_STAGING_ENABLED unset refuses creation entirely, matching the safe-by-default pattern every other flag in this codebase uses", async () => {
  const env = makeEnv({ env: { TRADE_2WAY_STAGING_ENABLED: undefined } });
  const r = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  t.equal(r.ok, false);
  t.equal(r.error, "2way_staging_disabled");
});

test("CREATE: the recipient gets exactly one invite DM, and it says the offer is held server-side, not proposed on MFL", async () => {
  const env = makeEnv();
  discord.reset();
  const ctx = ctxWait();
  const r = await createStaged2WayTrade(env, ctx, CREATE_SPEC());
  t.ok(r.ok);
  await ctx.flush();
  const dms = discord.messages();
  t.equal(dms.length, 1);
  t.match(dms[0].body.content, /held server-side/);
});

// ═══════════════════════ ACCEPT: rechecks BOTH sides, not just the recipient's ═══════════════════════

test("ACCEPT: only the recipient can accept -- the sender attempting to accept their own offer is refused", async () => {
  const env = makeEnv();
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  const x = await accept2WayTrade(env, {}, created.id, viewer(FR.A, { leagueId: "74598", season: "2026" }), {});
  t.equal(x.ok, false);
  t.equal(x.http, 403);
});

test("ACCEPT with execution disabled (TRADE_2WAY_STAGING_EXECUTE off, the default): both sides ok -> accepted, but HELD -- never 'completed', never a real mfl_trade_id, never copy implying completion (Keith's ruling, 2026-09-30)", async () => {
  const env = makeEnv(); // default healthy compliance for both sides, TRADE_2WAY_STAGING_EXECUTE unset
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  discord.reset(); // isolate to just the accept's own DMs, not the earlier "invite" DM from create
  const ctx = ctxWait();
  const x = await accept2WayTrade(env, ctx, created.id, viewer(FR.B, { leagueId: "74598", season: "2026" }), {});
  t.ok(x.ok, JSON.stringify(x));
  t.equal(x.accepted, true);
  t.equal(x.executing, true);
  await ctx.flush(); // the held-for-execution-disabled path runs inside the waitUntil promise
  const row = env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades WHERE id=?").get(created.id);
  t.equal(row.status, "collecting", "never a terminal status -- resumable, not done");
  t.equal(row.to_state, "accepted", "the accept itself is still recorded");
  t.equal(row.mfl_trade_id, null, "nothing was ever sent to MFL");
  t.notEqual(row.failure_reason, "dry_run", "no longer marked as a finished dry run");
  const owner = discord.to("100000000000000001").concat(discord.to("100000000000000002"));
  t.ok(owner.length >= 2, "both sides were notified");
  for (const dm of owner) {
    const content = dm.body && dm.body.content;
    t.doesNotMatch(content, /✅/, "no checkmark -- this never reads as success");
    t.doesNotMatch(content, /trade itself cleared|is complete\b|fully cleared|turn on live/i, "no wording implying the trade itself went through, or naming an internal flag mechanism that goes stale once flags are on");
    t.match(content, /awaiting commissioner review/i, "says plainly what it's actually waiting on");
    t.match(content, /rosters and contract limits will be checked again/i, "tells the owner what still happens before anything moves");
  }
  // Resumable: the detail view says so too, distinctly from the generic "still reviewing
  // compliance" copy, and offers Re-check now that can_recheck matches this held shape.
  const detail = await get2WayTrade(env, created.id, viewer(FR.A, { leagueId: "74598", season: "2026" }), {});
  t.equal(detail.trade.state_view.code, "awaiting_commissioner");
  t.equal(detail.trade.state_view.label, "Accepted — awaiting commissioner review");
  t.match(detail.trade.state_view.message, /Rosters and contract limits will be checked again before any drop or trade/);
  t.equal(detail.trade.permissions.can_recheck, true, "Re-check is available (harmless/idempotent while the flag stays off, and what actually resumes it once the flag flips on)");
});

// LATER FLAG-ON RESUMPTION and ROLLBACK-WITH-AN-IN-FLIGHT-DEAL need a REAL (non-throwing) fake
// MFL to execute against once TRADE_2WAY_STAGING_EXECUTE flips on -- this file's own
// installDiscordRecorder() deliberately throws on any non-discord.com fetch (see this file's
// header), so those scenarios live in tests/trade_2way_execution_disabled_resume.test.mjs
// instead, which uses worker_harness.mjs's makeMfl() stateful fake MFL.

test("BOTH PARTIES' LOADED LIMITS: the RECIPIENT (not just the sender/initiator) being over the loaded-contract limit holds the trade at accept -- proves the recheck covers both sides, not only whoever created the offer", async () => {
  const env = makeEnv({
    compliance: () => ({
      participants: [], cap: { status: "ok", violations: [], message: "" },
      roster: { status: "ok", advisory: true, warnings: [], message: "" },
      // The RECIPIENT (0001 / FR.B) is over the limit -- the sender (FR.A) is fine.
      loaded_contracts: { status: "blocked", max: 5, message: "L.A. Looks would move to 6 loaded contracts.", violations: [{ franchise_id: FR.B, franchise_name: "L.A. Looks", projected: 6, max: 5 }], drop_requirements: [{ franchise_id: FR.B, franchise_name: "L.A. Looks", satisfied: false, loaded_before: 5, projected: 6, required_drops: 1, valid_count: 0 }] },
      lineup: { status: "ok", advisory: true, warnings: [], message: "" },
      extension_skipped: [],
    }),
  });
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  const ctx = ctxWait();
  const x = await accept2WayTrade(env, ctx, created.id, viewer(FR.B, { leagueId: "74598", season: "2026" }), {});
  t.ok(x.ok);
  t.equal(x.accepted, true, "the recipient's own consent is still recorded");
  t.equal(x.executing, false, "but execution never starts");
  t.equal(x.held, true);
  t.equal(x.kind, "loaded_contract_drops_required");
  const row = env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades WHERE id=?").get(created.id);
  t.equal(row.status, "collecting", "held trades stay in collecting, never advance to executing");
  t.equal(row.to_state, "accepted", "the accept itself is preserved even though execution is held");
});

// ═══════════════════════ ROSTER CHANGES BETWEEN OFFER AND ACCEPTANCE ═══════════════════════

test("ROSTER CHANGES BETWEEN OFFER AND ACCEPTANCE: creation itself never checks compliance (it only stages) -- a roster change that happens AFTER the offer was made (e.g. an unrelated trade lands) is caught by the fresh check accept runs, never a value cached from create time", async () => {
  let rosterChanged = false;
  const env = makeEnv({
    compliance: () => {
      if (!rosterChanged) {
        return { participants: [], cap: { status: "ok", violations: [], message: "" }, roster: { status: "ok", advisory: true, warnings: [], message: "" }, loaded_contracts: { status: "ok", max: 5, violations: [], message: "" }, lineup: { status: "ok", advisory: true, warnings: [], message: "" }, extension_skipped: [] };
      }
      return { participants: [], cap: { status: "ok", violations: [], message: "" }, roster: { status: "ok", advisory: true, warnings: [], message: "" }, loaded_contracts: { status: "blocked", max: 5, message: "Real Deal Creel would move to 6 loaded contracts.", violations: [{ franchise_id: FR.A, franchise_name: "Real Deal Creel", projected: 6, max: 5 }], drop_requirements: [{ franchise_id: FR.A, franchise_name: "Real Deal Creel", satisfied: false, loaded_before: 5, projected: 6, required_drops: 1, valid_count: 0 }] }, lineup: { status: "ok", advisory: true, warnings: [], message: "" }, extension_skipped: [] };
    },
  });
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  t.ok(created.ok);
  t.equal(env.__selfCalls.length, 0, "creation stages in D1 only -- it never calls the compliance service at all, so there is nothing to go stale");
  // Between offer and acceptance, an unrelated trade lands and pushes FR.A over the limit.
  rosterChanged = true;
  const ctx = ctxWait();
  const x = await accept2WayTrade(env, ctx, created.id, viewer(FR.B, { leagueId: "74598", season: "2026" }), {});
  await ctx.flush();
  t.equal(x.executing, false, "a roster change between offer and acceptance must hold execution, never wave it through on stale numbers");
  t.equal(x.kind, "loaded_contract_drops_required");
});

// ═══════════════════════ CHANGED DROP SELECTIONS ═══════════════════════

test("CHANGED DROP SELECTIONS: selecting a conditional drop is persisted and reflected on the NEXT compliance read, and NEVER itself writes to MFL or unblocks execution (needs_drops stays held)", async () => {
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
  const sel = await select2WayLoadedContractDrops(env, created.id, viewer(FR.A, { leagueId: "74598", season: "2026" }), ["90200"]);
  t.ok(sel.ok, JSON.stringify(sel));
  t.equal(sel.code, "selected");
  t.equal(sel.executable, false, "needs_drops is satisfied but STILL not permitted to write -- no executor exists yet");
  t.match(sel.message, /conditional-drop execution isn't built yet/);
  // Accepting now: both sides "agree" but capGate2Way must still hold on needs_drops.
  const ctx = ctxWait();
  const x = await accept2WayTrade(env, ctx, created.id, viewer(FR.B, { leagueId: "74598", season: "2026" }), {});
  t.equal(x.executing, false, "a SATISFIED needs_drops selection must never itself permit execution");
  t.equal(x.kind, "loaded_contract_drops_required");
  const row = env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades WHERE id=?").get(created.id);
  t.equal(row.status, "collecting");
  t.equal(row.mfl_trade_id, null, "no drop, no trade -- zero MFL writes for a needs_drops state, exactly like 3-way and the direct-MFL 2-way path");
});

// ═══════════════════════ ZERO MFL WRITES ON EVERY HOLD OR FAILURE ═══════════════════════

test("ZERO MFL WRITES: an unavailable compliance calculation holds the trade (never treated as compliant, never executes)", async () => {
  const env = makeEnv({ compliance: { __status: 500 } });
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  const ctx = ctxWait();
  const x = await accept2WayTrade(env, ctx, created.id, viewer(FR.B, { leagueId: "74598", season: "2026" }), {});
  t.equal(x.executing, false);
  t.equal(x.kind, "unavailable");
  const row = env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades WHERE id=?").get(created.id);
  t.equal(row.mfl_trade_id, null);
});

test("ZERO MFL WRITES: a cap overage with no acknowledgment holds the trade at accept, recorded as collecting, never executing", async () => {
  const env = makeEnv({
    compliance: () => ({
      participants: [], cap: { status: "blocked", cap_dollars: 300000, violations: [{ franchise_id: FR.A, franchise_name: "Real Deal Creel", amount_over: 5000 }], message: "x" },
      roster: { status: "ok", advisory: true, warnings: [], message: "" }, loaded_contracts: { status: "ok", max: 5, violations: [], message: "" }, ...LIMITS_OK,
      lineup: { status: "ok", advisory: true, warnings: [], message: "" }, extension_skipped: [],
    }),
  });
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  const ctx = ctxWait();
  const x = await accept2WayTrade(env, ctx, created.id, viewer(FR.B, { leagueId: "74598", season: "2026" }), {});
  t.equal(x.executing, false);
  t.equal(x.kind, "cap_ack_required");
  const row = env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades WHERE id=?").get(created.id);
  t.equal(row.status, "collecting");
});

test("REVIEW 2026-10-09: the staged engine (retired, flags off) is no path around the roster maximum or the five-QB rule — each holds the trade; a compliance answer without them is 'unavailable', never a pass", async () => {
  const base = { participants: [], cap: { status: "ok", cap_dollars: 300000, violations: [], message: "" }, roster: { status: "ok", advisory: true, warnings: [], message: "" },
    loaded_contracts: { status: "ok", max: 5, violations: [], message: "" }, lineup: { status: "ok", advisory: true, warnings: [], message: "" }, extension_skipped: [] };
  for (const [name, over, kind] of [
    ["roster maximum", { ...LIMITS_OK, roster_limit: { status: "blocked", max: 30, violations: [{ franchise_id: FR.B, franchise_name: "L.A. Looks", active_after: 31, max: 30, message: "L.A. Looks would have 31 active players right after this trade — the maximum is 30." }], executable: false, message: "L.A. Looks would have 31 active players right after this trade — the maximum is 30." } }, "roster_room_required"],
    ["five active QBs", { ...LIMITS_OK, qb_limit: { status: "blocked", max: 5, violations: [{ franchise_id: FR.B, franchise_name: "L.A. Looks", active_qbs_after: 6, max: 5, message: "L.A. Looks would have 6 QBs on the active roster right after this trade — the maximum is 5." }], executable: false, message: "L.A. Looks would have 6 QBs on the active roster right after this trade — the maximum is 5." } }, "qb_limit_exceeded"],
    ["no roster_limit in the answer", {}, "unavailable"],
  ]) {
    const env = makeEnv({ compliance: () => ({ ...base, ...over }) });
    const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
    const x = await accept2WayTrade(env, ctxWait(), created.id, viewer(FR.B, { leagueId: "74598", season: "2026" }), {});
    t.equal(x.executing, false, name); t.equal(x.held, true, name); t.equal(x.kind, kind, name);
    t.equal(env.UPS_MFL_DB.raw.prepare("SELECT status FROM ups_2way_trades WHERE id=?").get(created.id).status, "collecting", name);
  }
});

test("ZERO MFL WRITES: cancelling a staged trade before either side finishes deciding writes only to D1, never MFL", async () => {
  const env = makeEnv();
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  const x = await cancel2WayTrade(env, {}, created.id, viewer(FR.A, { leagueId: "74598", season: "2026" }), "changed my mind");
  t.ok(x.ok);
  const row = env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_2way_trades WHERE id=?").get(created.id);
  t.equal(row.status, "cancelled");
  t.equal(row.mfl_trade_id, null);
});

// ═══════════════════════ DETAIL GET: cap_ack survives a plain reload, not only the accept response ═══════════════════════

test("DETAIL: get2WayTrade exposes fresh cap_ack on a plain GET -- not only inside the accept/recheck response -- so re-opening a held trade never silently loses 'who still needs to acknowledge'", async () => {
  const env = makeEnv({
    compliance: () => ({
      participants: [], cap: { status: "blocked", cap_dollars: 300000, violations: [{ franchise_id: FR.A, franchise_name: "Real Deal Creel", amount_over: 5000 }], message: "x" },
      roster: { status: "ok", advisory: true, warnings: [], message: "" }, loaded_contracts: { status: "ok", max: 5, violations: [], message: "" }, ...LIMITS_OK,
      lineup: { status: "ok", advisory: true, warnings: [], message: "" }, extension_skipped: [],
    }),
  });
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  // A plain GET, never having gone through accept at all.
  const g = await get2WayTrade(env, created.id, viewer(FR.A, { leagueId: "74598", season: "2026" }), {});
  t.ok(g.ok, JSON.stringify(g));
  t.ok(g.trade.cap_ack, "cap_ack must be present on the canonical object whenever a live cap violation exists");
  t.equal(g.trade.cap_ack.satisfied, false);
  t.equal(g.trade.cap_ack.perFranchise[0].franchise_id, FR.A);
});

test("DETAIL: cap_ack is null when there is no live cap violation -- never a stale/fabricated entry", async () => {
  const env = makeEnv(); // default healthy compliance
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  const g = await get2WayTrade(env, created.id, viewer(FR.A, { leagueId: "74598", season: "2026" }), {});
  t.equal(g.trade.cap_ack, null);
});

// ═══════════════════════ HTTP surface: identity + the global L-guard exemption ═══════════════════════

test("HTTP: only the proven viewer can create as their own team -- a proven session for FR.B posting a trade whose 'from' claims FR.A is refused, never trusting the body's own fid claim", async () => {
  const env = makeEnv();
  // A real, resolvable session token for FR.B (0001) -- proves identity comes from the
  // server-verified token, not from whatever `from.fid` the request body claims.
  const url = new URL("https://worker.test/api/trades/2way?MFL_USER_ID=tok-B");
  const request = new Request(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ from: { fid: FR.A }, to: { fid: FR.B }, movements: [{ from: FR.A, to: FR.B, asset_tokens: ["P_1"] }] }) });
  const resp = await handle2WayStagedHttp({
    request, url, path: url.pathname, env, ctx: ctxWait(), corsHeaders: {},
    defaultLeagueId: "74598", defaultSeason: "2026",
    browserMflUserId: "tok-B", cookieMflUserId: "",
    deps: { detectFranchise: async (tok) => (tok === "tok-B" ? { franchise_id: FR.B, franchise_name: "L.A. Looks" } : { error: "HTTP 401" }), commishFids: () => [] },
  });
  t.equal(resp.status, 403);
  const j = await resp.json();
  t.equal(j.code, "forbidden");
});

await run("trade_2way_staged");
restoreConsole();
