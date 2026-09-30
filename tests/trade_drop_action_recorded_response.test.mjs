// RECORDED-RESPONSE INTEGRATION TEST for the actual MFL drop action (Keith, 2026-09-30, third
// pass): "Finish the recorded-response integration test for the actual MFL drop action." Every
// OTHER test in this feature (trade_2way_drop_first_execute.test.mjs and friends) stubs
// /roster-workbench/action at the OUTER JSON-response layer (installFakeUnloadPlayer,
// intercepting env.SELF.fetch directly) -- proven, deliberate, and stated plainly as a boundary
// since the very first pass: MFL's own real roster-edit HTML-form page
// (fetchLoadRostFormForCookie / postLoadRostFormForCookie, worker/src/index.js) has never been
// exercised by any test in this repo.
//
// THIS file closes that gap differently: it does NOT stub /roster-workbench/action at all. It
// lets the REAL route handler run end to end -- the real HTML-form GET, the real field-parsing
// regex (parseLoadRostForm), the real POST construction, and the real post-write rosters-export
// verification (which was ALREADY exercised everywhere else via mfl.st.rosters -- unchanged
// here). Only the two HTTP calls that would otherwise leave this sandbox (the GET for MFL's own
// LOADROST page, and the POST to whatever action URL that page declares) are stubbed, at the
// global fetch() layer index.js itself calls through.
//
// HONESTY ABOUT WHAT THIS DOES NOT PROVE: this session has no live, credentialed MFL access, and
// performing a real drop to capture a real response is exactly what Keith's standing instruction
// forbids ("Do not perform a live trade or drop as a test"). The HTML fixture below is NOT an
// actual captured page -- it is reconstructed from the parser's own real, already-shipped
// knowledge of the page: the two field names it deliberately excludes (`sel_pid`,
// `picker_filt_name` -- worker/src/index.js's parseLoadRostForm), the `ROSTER` <select> it reads
// options from, and the `PLAYER_NAMES` field it defaults when absent. Every OTHER hidden field on
// the real page is structurally plausible filler, not independently verified. If Keith can supply
// an actual saved copy of MFL's own roster-edit page (View Source on a real league), it should
// replace this fixture; until then, this proves the REAL PARSING AND POSTING CODE works correctly
// against a page shaped the way the parser itself says a real page must be, which is real coverage
// this route never had -- not a claim that MFL's actual page is proven byte-for-byte.
//   node tests/trade_drop_action_recorded_response.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, bindSelf, quiet } from "./fixtures/worker_harness.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";

const restoreConsole = quiet();
await import("./fixtures/register_md_loader.mjs");
const { createStaged2WayTrade, accept2WayTrade, select2WayLoadedContractDrops, executeDropFirstDeal } = await import("../worker/src/trade_2way.js");

const Q = "L=74598&YEAR=2026";
const MIGRATIONS = [...THREE_WAY_MIGRATIONS, "0162_ups_trade_cap_acknowledgments.sql", "0163_ups_trade_conditional_drops.sql", "0164_ups_2way_trades.sql"];
const FR = { A: "0008", B: "0001" };
const flat = (id) => ({ id, salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" });
const loaded = (id) => ({ id, salary: "5000", contractYear: "2", contractStatus: "Vet-BL", contractInfo: "CL 2|TCV 20K|AAV 10K|Y1-5K|Y2-15K" });
const fiveLoaded = (start) => [0, 1, 2, 3, 4].map((i) => loaded(String(start + i)));

function fresh(over) {
  const env = makeWorkerEnv({ __migrations: MIGRATIONS, TRADE_2WAY_STAGING_ENABLED: "1", COMMISH_DISCORD_USER_ID: "621530026831118346", ...(over || {}) });
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS discord_owners (franchise_id TEXT, active_owner TEXT, discord_user_id TEXT)");
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(FR.A, "Y", "100000000000000001");
  env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(FR.B, "Y", "100000000000000002");
  bindSelf(env);
  const mfl = makeMfl(over && over.mfl);
  mfl.install();
  return { env, mfl };
}
const CREATE_SPEC = (over) => ({
  leagueId: "74598", season: "2026",
  from: { fid: FR.A, name: "Real Deal Creel" }, to: { fid: FR.B, name: "L.A. Looks" },
  movements: [{ from: FR.A, to: FR.B, asset_tokens: ["90000"], cap_k: 0 }],
  ...(over || {}),
});
async function stageAcceptWithDrop(env, mfl, { senderLoadedIds, dropPlayerId }) {
  mfl.st.rosters[FR.A] = [...senderLoadedIds.map((id) => loaded(id)), flat("90000")];
  mfl.st.rosters[FR.B] = [flat("13100")];
  const created = await createStaged2WayTrade(env, {}, CREATE_SPEC());
  const ctx = { waitUntil: (p) => p };
  await select2WayLoadedContractDrops(env, created.id, { fid: FR.A, leagueId: "74598", season: "2026" }, [dropPlayerId]);
  await accept2WayTrade(env, ctx, created.id, { fid: FR.B, leagueId: "74598", season: "2026" }, {});
  return created.id;
}
const ledgerRow = (env, id) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_executions WHERE exec_key=?").get(id);

// ═══════ THE HTML FIXTURE (see file header: reconstructed from the parser's own real,
// documented field knowledge -- not a live capture) ═══════
const ACTION_URL = "https://www48.myfantasyleague.com/2026/csetup";
function loadRostPageHtml(leagueId, franchiseId, rosterIds) {
  const options = rosterIds.map((pid) => `<option value="${pid}">Player ${pid}</option>`).join("\n        ");
  // sel_pid / picker_filt_name are the two field names parseLoadRostForm deliberately excludes
  // (worker/src/index.js) -- real, documented knowledge of the actual page's own player-search
  // widget, included here so the parser's own exclusion logic is genuinely exercised, not just
  // trivially satisfied by their absence.
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
const LOCKOUT_PAGE_HTML = `<!DOCTYPE html><html><body><h1>Commissioner Access Required</h1><p>You must be logged in as the commissioner to view this page.</p></body></html>`;

// Intercepts ONLY the two calls that would otherwise leave this sandbox: the LOADROST page GET,
// and the POST to that same page's own declared action URL. Everything else (rosters/salaries/
// transactions export, tradeProposal import, etc.) delegates to the ALREADY-INSTALLED fake MFL
// handler (captured here, after mfl.install() ran) -- unchanged, still the same proven harness
// every other test in this repo uses for those calls.
function installRealDropActionFetchStub(env, mfl, { pageResponder, postResponder } = {}) {
  const delegate = globalThis.fetch;
  const postedCalls = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    const isCsetupLoadRost = url.pathname.endsWith("/csetup") && url.searchParams.get("C") === "LOADROST";
    if (isCsetupLoadRost && (!init || (init.method || "GET").toUpperCase() === "GET")) {
      const res = (pageResponder ? pageResponder(url) : null) || { status: 200, body: loadRostPageHtml(url.searchParams.get("L"), url.searchParams.get("FRANCHISE"), (mfl.st.rosters[url.searchParams.get("FRANCHISE")] || []).map((p) => p.id)) };
      return new Response(res.body, { status: res.status, headers: { "content-type": "text/html" } });
    }
    if (url.pathname.endsWith("/csetup") && init && (init.method || "").toUpperCase() === "POST") {
      const params = new URLSearchParams(init.body);
      const rosterIds = params.getAll("ROSTER");
      postedCalls.push({ franchiseId: params.get("FRANCHISE"), rosterIds });
      const res = postResponder ? postResponder(params, postedCalls.length) : { status: 200, body: "OK" };
      if (res.applyToRoster !== false) {
        const fid = params.get("FRANCHISE");
        if (fid && mfl.st.rosters[fid]) {
          const keep = new Set(rosterIds);
          mfl.st.rosters[fid] = mfl.st.rosters[fid].filter((p) => keep.has(String(p.id)));
        }
      }
      return new Response(res.body, { status: res.status, headers: { "content-type": "text/html" } });
    }
    return delegate(input, init);
  };
  globalThis.fetch.__postedCalls = postedCalls;
  return { postedCalls, restore: () => { globalThis.fetch = delegate; } };
}

test("RECORDED-RESPONSE: the REAL parse -> POST -> verify pipeline confirms a drop -- real HTML parsed, real form fields extracted, the desired ROSTER list correctly omits the dropped player, and the SAME already-proven rosters-export verification (mfl.st.rosters) sees the player genuinely gone", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  const stub = installRealDropActionFetchStub(env, mfl);
  try {
    const r = await executeDropFirstDeal(env, {}, id);
    t.equal(r.ok, true, JSON.stringify(r));
    t.equal(stub.postedCalls.length, 1, "exactly one real POST to MFL's own roster-edit action");
    t.ok(!stub.postedCalls[0].rosterIds.includes("80000"), "the POSTED roster list must genuinely omit the dropped player -- proves the real form-field extraction + desired-list computation, not a canned response");
    t.ok(stub.postedCalls[0].rosterIds.includes("80001"), "every OTHER rostered player must still be posted back -- this is a full roster replace, not a partial delta");
    const steps = JSON.parse(ledgerRow(env, id).steps_json);
    t.equal(steps["drop:80000"].status, "confirmed");
    t.equal(steps["drop:80000"].mfl_verification.ok, true, "the real post-write rosters-export re-check (not a stubbed verification object) confirmed the player is gone");
    t.equal(ledgerRow(env, id).state, "completed");
  } finally {
    stub.restore();
  }
});

test("RECORDED-RESPONSE: the REAL page reports 'Commissioner Access Required' -- fetchLoadRostFormForCookie's own real detection classifies this as a lockout-shaped failure, exactly as every other test in this feature has always assumed but never proven against real parsing code", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  const stub = installRealDropActionFetchStub(env, mfl, { pageResponder: () => ({ status: 200, body: LOCKOUT_PAGE_HTML }) });
  try {
    const r = await executeDropFirstDeal(env, {}, id);
    t.equal(r.ok, false);
    t.equal(stub.postedCalls.length, 0, "the real code must never even attempt the POST once the page load itself shows lockout");
    const steps = JSON.parse(ledgerRow(env, id).steps_json);
    t.equal(steps["drop:80000"].status, "failed");
    t.match(steps["drop:80000"].reason, /lockout/);
    t.equal(ledgerRow(env, id).state, "executed_needs_review");
  } finally {
    stub.restore();
  }
});

test("RECORDED-RESPONSE: the REAL POST succeeds, but the REAL post-write verification (mfl.st.rosters) still shows the player present -- classified as a genuine, proven failure, not an ambiguity, exactly matching classifyDropActionResponse's own real branch for this case", async () => {
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  // applyToRoster:false -- the real POST returns success, but (exactly like a real MFL request
  // that silently no-ops) mfl.st.rosters is deliberately left untouched, so the SEPARATE,
  // already-proven verification re-check genuinely still finds the player.
  const stub = installRealDropActionFetchStub(env, mfl, { postResponder: () => ({ status: 200, body: "OK", applyToRoster: false }) });
  try {
    const r = await executeDropFirstDeal(env, {}, id);
    t.equal(r.ok, false);
    t.equal(stub.postedCalls.length, 1, "the real POST WAS attempted, unlike the lockout case above");
    const steps = JSON.parse(ledgerRow(env, id).steps_json);
    t.equal(steps["drop:80000"].status, "failed");
    t.match(steps["drop:80000"].mfl_verification.reason, /player_still_found_on_roster/);
    t.equal(ledgerRow(env, id).state, "executed_needs_review");
  } finally {
    stub.restore();
  }
});

test("RECORDED-RESPONSE: a page with no parseable <form> at all is classified FAILED, not unconfirmed -- a genuine finding from running the real code, corrected from this test's own first guess", async () => {
  // First draft of this test expected "unconfirmed" here, assuming an unparseable page is a pure
  // unknown. Running it against the REAL classifyDropActionResponse proved that wrong: when
  // fetchLoadRostFormForCookie can't even find a <form> on the page, index.js's own route
  // returns data.ok===false OUTRIGHT (never attempting the POST -- proven below by
  // postedCalls.length===0) -- and classifyDropActionResponse treats an EXPLICIT `ok:false`
  // (never a network hiccup, absent data, or the one named "export failed" ambiguity) as a
  // PROVEN failure, not an unknown, because the write demonstrably never happened. This is
  // exactly the kind of thing a stubbed-JSON test could never have caught, since the stub always
  // hand-wrote a plausible shape -- running the real parser against real-shaped input is what
  // surfaced the actual behavior.
  const { env, mfl } = fresh({ TRADE_2WAY_DROP_EXECUTE_ENABLED: "1" });
  const id = await stageAcceptWithDrop(env, mfl, { senderLoadedIds: ["80000", "80001", "80002", "80003", "80004", "80005"], dropPlayerId: "80000" });
  const stub = installRealDropActionFetchStub(env, mfl, { pageResponder: () => ({ status: 200, body: "<html><body>Something unexpected</body></html>" }) });
  try {
    const r = await executeDropFirstDeal(env, {}, id);
    t.equal(r.ok, false);
    t.equal(stub.postedCalls.length, 0, "the POST must never be attempted when the page itself couldn't even be parsed");
    const steps = JSON.parse(ledgerRow(env, id).steps_json);
    t.equal(steps["drop:80000"].status, "failed");
    t.match(steps["drop:80000"].reason, /Unable to load commissioner roster form/);
    t.equal(ledgerRow(env, id).state, "executed_needs_review");
  } finally {
    stub.restore();
  }
});

await run("trade_drop_action_recorded_response");
restoreConsole();
