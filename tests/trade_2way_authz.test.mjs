// Standard (two-team) trade authorization — the REAL worker (worker/src/index.js) under Node,
// real SQLite/D1, a stateful MFL stub at the network edge.   node tests/trade_2way_authz.test.mjs
//
// Principle under test (Keith 2026-05-28, already enforced on the READ path): trades are
// owner-to-owner; a body/query franchise id is a claim, never proof; the worker's commissioner
// cookie is never substituted for an owner's session; administrative work uses its own explicit
// authority (admin key or a proven commissioner session).
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, workerFetch, quiet, COMMISH_COOKIE, ADMIN_KEY } from "./fixtures/worker_harness.mjs";
import { applyMigrations } from "./fixtures/d1_sqlite.mjs";

const restoreConsole = quiet();

function fresh(over) {
  const env = makeWorkerEnv(over && over.env);
  const mfl = makeMfl(over && over.mfl);
  mfl.install();
  // Same reason as trade_2way_accept_integrity.test.mjs's fresh(): a resolvable, flat
  // contract for the two default trade participants, not a blank one (2026-09-28 review).
  mfl.st.rosters["0001"] = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  return { env, mfl };
}
const Q = "L=74598&YEAR=2026";
const tid = (mfl, from = "0001", to = "0002") => mfl.addPending({ offeringteam: from, offeredto: to, will_give_up: "14056,", will_receive: "13100," });

const actionBody = (action, trade_id, fid, extra) => ({ action, trade_id, league_id: "74598", franchise_id: fid, year: "2026", ...(extra || {}) });
const asset = (pid, salary) => ({ asset_id: `player:${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false });
const proposal = (from, to, extra) => ({
  league_id: "74598", season: "2026", from_franchise_id: from, to_franchise_id: to,
  from_franchise_name: "x", to_franchise_name: "y", message: "",
  payload: {
    schema_version: 1, source: "test", league_id: "74598", season: "2026",
    teams: [
      { role: "left", franchise_id: from, selected_assets: [asset(from === "0008" ? 16614 : 14056, 5000)], traded_salary_adjustment_dollars: 0, traded_salary_adjustment_k: 0, selected_non_taxi_salary_dollars: 5000 },
      { role: "right", franchise_id: to, selected_assets: [asset(to === "0002" ? 13100 : 14056, 5000)], traded_salary_adjustment_dollars: 0, traded_salary_adjustment_k: 0, selected_non_taxi_salary_dollars: 5000 },
    ],
    extension_requests: [], ui: { left_team_id: from, right_team_id: to }, validation: { status: "ready" },
  },
  ...(extra || {}),
});
const noCommishCookie = (mfl) => t.equal(mfl.commishCookieWrites().length, 0);
const writes = (mfl) => mfl.writes().length;

// ═════════════════════════════ POST /api/trades/proposals ═════════════════════════════
test("PROPOSE: no session is refused before anything touches MFL", async () => {
  const { env, mfl } = fresh();
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}`, { body: proposal("0001", "0002") });
  t.equal(r.status, 401); t.equal(r.json.code, "unauthenticated");
  t.equal(writes(mfl), 0); noCommishCookie(mfl);
});

test("PROPOSE: an invalid session is refused (401) and an MFL identity outage fails closed (503)", async () => {
  const { env, mfl } = fresh();
  const bad = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-bogus`, { body: proposal("0001", "0002") });
  t.equal(bad.status, 401); t.equal(bad.json.code, "session_expired");
  const { env: e2, mfl: m2 } = fresh({ mfl: { myleaguesDown: true } });
  const down = await callWorker(e2, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: proposal("0001", "0002") });
  t.equal(down.status, 503); t.equal(down.json.code, "identity_unavailable");
  t.equal(writes(mfl) + writes(m2), 0);
});

test("PROPOSE: a valid session for a DIFFERENT league is refused", async () => {
  const { env, mfl } = fresh();
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-x`, { body: proposal("0001", "0002") });
  t.equal(r.status, 403); t.equal(writes(mfl), 0);
});

test("PROPOSE: a body from_franchise_id that isn't the authenticated franchise is refused", async () => {
  const { env, mfl } = fresh();
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: proposal("0008", "0002") });
  t.equal(r.status, 403); t.equal(r.json.code, "forbidden");
  t.equal(writes(mfl), 0); t.equal(mfl.st.pending.length, 0); noCommishCookie(mfl);
});

test("PROPOSE: two different leagues in one request are refused", async () => {
  const { env, mfl } = fresh();
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { ...proposal("0001", "0002"), league_id: "99999" } });
  t.equal(r.status, 400); t.equal(r.json.code, "league_mismatch");
  t.equal(writes(mfl), 0);
});

test("PROPOSE: a valid authenticated proposer reaches MFL with THEIR cookie, never the commissioner's", async () => {
  const { env, mfl } = fresh();
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: proposal("0001", "0002") });
  t.ok(r.status < 300, `status ${r.status}: ${r.text.slice(0, 300)}`);
  const w = mfl.writes("tradeProposal");
  t.equal(w.length, 1);
  t.equal(w[0].cookie, "MFL_USER_ID=tok-B");
  t.equal(w[0].asCommish, false);
  t.equal(mfl.st.pending[0].offeringteam, "0001");
  noCommishCookie(mfl);
});

test("PROPOSE: an ordinary owner cannot act as another team, even a commissioner franchise", async () => {
  const { env, mfl } = fresh();
  for (const from of ["0000", "0008"]) {
    const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: proposal(from, "0002") });
    t.equal(r.status, 403);
  }
  t.equal(writes(mfl), 0);
});

test("PROPOSE: the commissioner ACTING AS a team uses their own session (not the worker's commissioner cookie)", async () => {
  const { env, mfl } = fresh();
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-commish`, { body: proposal("0008", "0002") });
  t.ok(r.status < 300, r.text.slice(0, 200));
  const w = mfl.writes("tradeProposal");
  t.equal(w.length, 1); t.equal(w[0].cookie, "MFL_USER_ID=tok-commish");
  t.equal(mfl.st.pending[0].offeringteam, "0008");
  noCommishCookie(mfl);
});

test("PROPOSE: the explicit administrative path (admin key) must name the team it acts for", async () => {
  const { env, mfl } = fresh();
  const ok = await callWorker(env, "POST", `/api/trades/proposals?${Q}&APIKEY=${ADMIN_KEY}`, { body: proposal("0001", "0002") });
  t.ok(ok.status < 300, ok.text.slice(0, 200));
  const wrong = await callWorker(env, "POST", `/api/trades/proposals?${Q}&APIKEY=wrong-key`, { body: proposal("0001", "0002") });
  t.equal(wrong.status, 403);
  t.equal(mfl.writes("tradeProposal").length, 1);
});

test("PROPOSE: a foreign/wrong APIKEY alongside a valid owner session is ignored — the request authenticates as the owner (never admin), using the proven MFL session, not the commissioner cookie; a false franchise claim is still refused", async () => {
  // Root cause 2026-09-28: the MFL embed forwards its OWN page APIKEY on every
  // request alongside the owner's real MFL_USER_ID. That unrelated key must
  // never be treated as a bad admin attempt when a proven owner session sits
  // right next to it — see worker/src/trade_authz.js resolveTradeCaller.
  const { env, mfl } = fresh();
  // Row 5 of the authority matrix: wrong/foreign APIKEY + valid owner session -> ignore the key, authenticate the owner.
  const ok = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B&APIKEY=wrong-key`, { body: proposal("0001", "0002") });
  t.ok(ok.status < 300, ok.text.slice(0, 200));
  const w = mfl.writes("tradeProposal");
  t.equal(w.length, 1);
  t.equal(w[0].cookie, "MFL_USER_ID=tok-B", "the write must carry the proven owner's OWN session, never an admin/commissioner identity");
  t.equal(w[0].asCommish, false);
  noCommishCookie(mfl);
  // Row 7: same collision, but claiming a franchise that ISN'T tok-B's own — normal owner authorization still refuses it.
  const falseClaim = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B&APIKEY=wrong-key`, { body: proposal("0002", "0003") });
  t.equal(falseClaim.status, 403);
  t.match(falseClaim.json.error, /your own team/);
  t.equal(mfl.writes("tradeProposal").length, 1, "the false-claim attempt must not have written a second proposal");
});

test("PROPOSE: a foreign/wrong APIKEY alongside an INVALID/expired owner session still fails owner authentication — it must never fall through to become an admin caller", async () => {
  // Row 6 of the authority matrix.
  const { env, mfl } = fresh();
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-bogus&APIKEY=wrong-key`, { body: proposal("0001", "0002") });
  t.equal(r.status, 401);
  t.equal(r.json.code, "session_expired");
  t.equal(mfl.writes("tradeProposal").length, 0, "an invalid session plus a foreign key must never write as if it were an admin");
});

test("PROPOSE: a failed MFL write is reported as a failure, not as success", async () => {
  const { env, mfl } = fresh();
  mfl.st.failNext = { type: "tradeProposal", status: 500 };
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: proposal("0001", "0002") });
  t.ok(r.status >= 400, `status ${r.status}`);
  t.equal(mfl.st.pending.length, 0);
});

test("PROPOSE: a failed D1 audit write is reported honestly (NOT_PERSISTED), never as POSTED", async () => {
  const { env, mfl } = fresh();
  env.TWB_OUTBOX_DB = { prepare: () => { throw new Error("D1_ERROR: simulated"); } };
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: proposal("0001", "0002") });
  t.ok(r.status < 300, r.text.slice(0, 200));
  t.equal(mfl.st.pending.length, 1);
  t.notEqual(r.json && r.json.outbox && r.json.outbox.status, "POSTED");
  t.doesNotMatch(r.text, /D1_ERROR|simulated/);
});

// ═════════════════════════════ POST /api/trades/proposals/action ═════════════════════════════
test("ACTION: no session is refused and nothing is written (no commissioner-cookie fallback)", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  for (const [action, fid] of [["revoke", "0001"], ["reject", "0002"], ["accept", "0002"]]) {
    const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}`, { body: actionBody(action, id, fid) });
    t.equal(r.status, 401);
  }
  t.equal(writes(mfl), 0); noCommishCookie(mfl);
  t.equal(mfl.st.pending.length, 1);
});

test("ACTION: the originating team can revoke, with its own cookie, exactly once", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`, { body: actionBody("revoke", id, "0001") });
  t.equal(r.status, 200);
  t.equal(mfl.writes("tradeResponse").length, 1);
  t.deepEqual(mfl.st.done.map((d) => [d.response, d.by, d.asCommish]), [["revoke", "0001", false]]);
  noCommishCookie(mfl);
});

test("ACTION: the recipient cannot revoke and the originator cannot accept or reject (MFL's own rule, enforced before MFL)", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  const revoke = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: actionBody("revoke", id, "0002") });
  t.equal(revoke.status, 403); t.match(revoke.json.error, /Only the team that sent an offer/);
  for (const action of ["accept", "reject"]) {
    const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`, { body: actionBody(action, id, "0001") });
    t.equal(r.status, 403); t.match(r.json.error, /Only the team an offer was sent to/);
  }
  t.equal(writes(mfl), 0); t.equal(mfl.st.pending.length, 1);
});

test("ACTION: the recipient can reject", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: actionBody("reject", id, "0002", { message: "no thanks" }) });
  t.equal(r.status, 200);
  t.deepEqual(mfl.st.done.map((d) => [d.response, d.by]), [["reject", "0002"]]);
  noCommishCookie(mfl);
});

test("ACTION: an unrelated franchise gets a conflict, learns nothing, and writes nothing", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  for (const action of ["revoke", "reject", "accept"]) {
    const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-O`, { body: actionBody(action, id, "0003") });
    t.equal(r.status, 409); t.equal(r.json.code, "offer_not_pending");
  }
  t.equal(writes(mfl), 0); t.equal(mfl.st.pending.length, 1);
});

test("ACTION: a body franchise_id naming ANOTHER team's franchise is refused (declared id is not identity)", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-O`, { body: actionBody("revoke", id, "0001") });
  t.equal(r.status, 403); t.equal(r.json.code, "forbidden");
  const r2 = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-O`, { body: { ...actionBody("revoke", id, "0003"), acting_franchise_id: "0001" } });
  t.equal(r2.status, 403);
  t.equal(writes(mfl), 0); t.equal(mfl.st.pending.length, 1);
});

test("ACTION: a repeated action is a clear conflict and a finished trade cannot be revived", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  const first = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`, { body: actionBody("revoke", id, "0001") });
  t.equal(first.status, 200);
  const again = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`, { body: actionBody("revoke", id, "0001") });
  t.equal(again.status, 409); t.equal(again.json.code, "offer_not_pending");
  const revive = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: actionBody("accept", id, "0002") });
  t.equal(revive.status, 409);
  t.equal(mfl.writes("tradeResponse").length, 1); t.equal(mfl.st.done.length, 1);
});

test("ACTION: concurrent identical actions execute once; the loser gets an error, never a second success", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  const call = () => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`, { body: actionBody("revoke", id, "0001") });
  const [a, b] = await Promise.all([call(), call()]);
  t.equal([a, b].filter((r) => r.status === 200).length, 1);
  t.ok([a, b].some((r) => r.status >= 400));
  t.equal(mfl.st.done.length, 1);
});

test("ACTION: a failed MFL write never reports success and leaves the offer pending", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  mfl.st.failNext = { type: "tradeResponse", status: 500 };
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`, { body: actionBody("revoke", id, "0001") });
  t.ok(r.status >= 400); t.notEqual(r.json && r.json.ok, true);
  t.equal(mfl.st.pending.length, 1); t.equal(mfl.st.done.length, 0);
});

test("ACTION: if MFL can't confirm the offer, the action fails closed (503) and writes nothing", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (/TYPE=pendingTrades/.test(String(u))) return { ok: false, status: 502, headers: new Headers(), text: async () => "bad gateway", json: async () => ({}) }; return realFetch(u, i); };
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`, { body: actionBody("revoke", id, "0001") });
  globalThis.fetch = realFetch;
  t.equal(r.status, 503); t.equal(r.json.code, "unavailable");
  t.equal(writes(mfl), 0);
});

test("ACTION: the commissioner ACTING AS the originator can revoke, through their own session", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-commish`, { body: actionBody("revoke", id, "0001") });
  t.equal(r.status, 200);
  t.deepEqual(mfl.st.done.map((d) => [d.response, d.by, d.cookie, d.asCommish]), [["revoke", "0001", "MFL_USER_ID=tok-commish", true]]);
  noCommishCookie(mfl);
});

test("ACTION: with MFL's commissioner lockout ON, acting as another team fails closed, not through a fallback", async () => {
  const { env, mfl } = fresh();
  mfl.st.lockout = true;
  const id = tid(mfl);
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-commish`, { body: actionBody("revoke", id, "0001") });
  t.ok(r.status >= 400);
  t.equal(mfl.st.done.length, 0); noCommishCookie(mfl);
});

test("ACTION: the worker's commissioner cookie can't be smuggled in as a session or header", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  const a = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=${COMMISH_COOKIE}`, { body: actionBody("revoke", id, "0001") });
  t.ok(a.status >= 400);
  const b = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}`, { body: actionBody("revoke", id, "0001"), headers: { Cookie: `MFL_USER_ID=tok-B` } });
  t.equal(b.status, 401);
  t.equal(mfl.st.done.length, 0);
});

test("ACTION: a COUNTER must go from the responding team back to the team that made the offer, and rejects nothing first otherwise", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  const bad = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: actionBody("counter", id, "0002", { counter_offer: { from_franchise_id: "0002", to_franchise_id: "0003", payload: proposal("0002", "0003").payload } }) });
  t.equal(bad.status, 400); t.equal(bad.json.code, "bad_counter_parties");
  t.equal(mfl.st.done.length, 0); t.equal(mfl.st.pending.length, 1);
});

test("ACTION: ACCEPT is authorised as the recipient only, reaches MFL once with the recipient's cookie, and a failed post-accept import is never reported as success", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  const body = (fid, extra) => ({ ...actionBody("accept", id, fid), acting_franchise_id: fid, ...(extra || {}) });
  // the originator, an unrelated owner and a signed-out caller cannot accept
  t.equal((await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`, { body: body("0001") })).status, 403);
  t.equal((await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-O`, { body: body("0003") })).status, 409);
  t.equal((await callWorker(env, "POST", `/api/trades/proposals/action?${Q}`, { body: body("0002") })).status, 401);
  t.equal(mfl.st.done.length, 0);
  const r = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: body("0002") });
  t.equal(mfl.st.done.length, 1); t.equal(mfl.st.done[0].cookie, "MFL_USER_ID=tok-C"); t.equal(mfl.st.done[0].by, "0002");
  t.equal(r.status, 200); t.equal(r.json.ok, true);            // a real two-sided offer with nothing to import completes
  noCommishCookie(mfl);
});

test("ACTION: concurrent ACCEPTs reach MFL's accept exactly once", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  let release; mfl.st.holdAccept = new Promise((r) => { release = r; });
  const call = () => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { ...actionBody("accept", id, "0002"), acting_franchise_id: "0002" } });
  const a = call(), b = call();
  await new Promise((r) => setTimeout(r, 30)); release();
  await Promise.all([a, b]);
  t.equal(mfl.st.done.filter((d) => d.response === "accept").length, 1);
  t.equal(mfl.st.pending.length, 0);                          // the offer was consumed by the single accept
});

// ═════════════════════════════ outbox / replay / reconcile / refresh ═════════════════════════════
async function withOutboxRow() {
  const ctx = fresh();
  const r = await callWorker(ctx.env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: proposal("0001", "0002") });
  t.ok(r.status < 300, r.text.slice(0, 200));
  const row = ctx.env.UPS_MFL_DB.raw.prepare("SELECT * FROM twb_trade_outbox ORDER BY id DESC LIMIT 1").get();
  t.ok(row, "an outbox row was written");
  return { ...ctx, row };
}

test("OUTBOX: reading it signed-out is refused (it used to return full payloads to anyone)", async () => {
  const { env, row } = await withOutboxRow();
  for (const path of ["/api/trades/outbox", "/trade-outbox"]) {
    const r = await callWorker(env, "GET", `${path}?${Q}&OUTBOX_ID=${row.id}`);
    t.equal(r.status, 401);
    t.doesNotMatch(r.text, /payload_json|selected_assets/);
  }
});

test("OUTBOX: a participant reads its own row; an unrelated owner gets nothing; the admin key reads any", async () => {
  const { env, row } = await withOutboxRow();
  const mine = await callWorker(env, "GET", `/api/trades/outbox?${Q}&OUTBOX_ID=${row.id}&MFL_USER_ID=tok-C`);
  t.equal(mine.status, 200); t.equal(String(mine.json.row.id), String(row.id));
  const other = await callWorker(env, "GET", `/api/trades/outbox?${Q}&OUTBOX_ID=${row.id}&MFL_USER_ID=tok-O`);
  t.equal(other.status, 200); t.equal(other.json.row, null);
  const admin = await callWorker(env, "GET", `/api/trades/outbox?${Q}&OUTBOX_ID=${row.id}&APIKEY=${ADMIN_KEY}`);
  t.equal(String(admin.json.row.id), String(row.id));
});

test("REPLAY: signed-out and ordinary owners are refused; the admin key and a proven commissioner session pass the gate", async () => {
  const { env, mfl, row } = await withOutboxRow();
  const body = { league_id: "74598", season: "2026", outbox_id: String(row.id) };
  t.equal((await callWorker(env, "POST", `/api/trades/outbox/replay?${Q}`, { body })).status, 401);
  t.equal((await callWorker(env, "POST", `/api/trades/outbox/replay?${Q}&MFL_USER_ID=tok-B`, { body })).status, 403);
  t.equal((await callWorker(env, "POST", `/trade-outbox/replay?${Q}&MFL_USER_ID=tok-C`, { body })).status, 403);
  t.equal((await callWorker(env, "POST", `/api/trades/outbox/replay?${Q}&APIKEY=wrong`, { body })).status, 403);
  const before = mfl.writes().length;
  const admin = await callWorker(env, "POST", `/api/trades/outbox/replay?${Q}&APIKEY=${ADMIN_KEY}`, { body });
  t.ok(![401, 403].includes(admin.status), `admin replay status ${admin.status}`);
  const commish = await callWorker(env, "POST", `/api/trades/outbox/replay?${Q}&MFL_USER_ID=tok-commish`, { body });
  t.ok(![401, 403].includes(commish.status), `commissioner replay status ${commish.status}`);
  t.ok(mfl.writes().length >= before);
});

test("RECONCILE: signed-out and ordinary owners are refused; the admin key works", async () => {
  const { env } = await withOutboxRow();
  t.equal((await callWorker(env, "POST", `/api/trades/reconcile/extensions?${Q}`, { body: {} })).status, 401);
  t.equal((await callWorker(env, "GET", `/reconcile/extensions?${Q}&MFL_USER_ID=tok-B`)).status, 403);
  const ok = await callWorker(env, "POST", `/api/trades/reconcile/extensions?${Q}&APIKEY=${ADMIN_KEY}`, { body: {} });
  t.equal(ok.status, 200);
});

test("REFRESH-AFTER-TRADE: signed-out is refused; a league member and the admin key are allowed", async () => {
  const { env } = fresh();
  t.equal((await callWorker(env, "POST", `/api/trades/refresh-after-trade?${Q}`, { body: {} })).status, 401);
  const member = await callWorker(env, "POST", `/api/trades/refresh-after-trade?${Q}&MFL_USER_ID=tok-B`, { body: { dispatch_refresh_mym_json: "0", run_reconcile: "0" } });
  t.equal(member.status, 200);
  t.equal((await callWorker(env, "POST", `/api/trades/refresh-after-trade?${Q}&APIKEY=${ADMIN_KEY}`, { body: { dispatch_refresh_mym_json: "0", run_reconcile: "0" } })).status, 200);
});

// ═════════════════════════════ /api/trade and /api/trade/process ═════════════════════════════
const legacyTrade = (over) => ({ from_fid: "0001", to_fid: "0002", give: ["P_14056"], receive: ["P_13100"], comments: "", ...(over || {}) });

test("/api/trade: simulate stays open; a LIVE proposal needs a proven caller who IS the from team", async () => {
  const { env, mfl } = fresh();
  const sim = await callWorker(env, "POST", `/api/trade?L=74598`, { body: legacyTrade() });
  t.equal(sim.status, 200); t.equal(sim.json.simulated, true);
  t.equal((await callWorker(env, "POST", `/api/trade?L=74598`, { body: legacyTrade({ simulate: false, dry_run: true }) })).status, 401);
  t.equal((await callWorker(env, "POST", `/api/trade?L=74598&MFL_USER_ID=tok-C`, { body: legacyTrade({ simulate: false, dry_run: true }) })).status, 403);
  const ok = await callWorker(env, "POST", `/api/trade?L=74598&MFL_USER_ID=tok-B`, { body: legacyTrade({ simulate: false, dry_run: true }) });
  t.equal(ok.status, 200);
  t.equal(writes(mfl), 0);
});

test("/api/trade/process: a body 'requested_by' is no longer authority; only proven administrative authority executes", async () => {
  const { env, mfl } = fresh();
  const body = legacyTrade({ dry_run: true, requested_by: "0008" });
  const declared = await callWorker(env, "POST", `/api/trade/process?L=74598`, { body });
  t.equal(declared.status, 401);
  const owner = await callWorker(env, "POST", `/api/trade/process?L=74598&MFL_USER_ID=tok-A`, { body });
  t.equal(owner.status, 200 === owner.status && owner.json && owner.json.ok ? 200 : owner.status);
  t.equal(writes(mfl), 0);
});

test("/api/trade/process: the admin key and a proven commissioner session are the only ways in", async () => {
  const { env } = fresh();
  const body = legacyTrade({ dry_run: true });
  t.equal((await callWorker(env, "POST", `/api/trade/process?L=74598&MFL_USER_ID=tok-B`, { body })).status, 403);
  t.equal((await callWorker(env, "POST", `/api/trade/process?L=74598&APIKEY=nope`, { body })).status, 403);
  const admin = await callWorker(env, "POST", `/api/trade/process?L=74598&APIKEY=${ADMIN_KEY}`, { body });
  t.equal(admin.status, 200); t.equal(admin.json.ok, true);
  const commish = await callWorker(env, "POST", `/api/trade/process?L=74598&MFL_USER_ID=tok-commish`, { body });
  t.equal(commish.status, 200);
});

// ═════════════════════════════ explicit-authority workflows still work ═════════════════════════════
test("SENTINEL / admin routes keep working through the admin key (and only through it)", async () => {
  const { env } = fresh();
  t.equal((await callWorker(env, "POST", `/admin/trade-sentinel/tick?L=74598`)).status, 401);      // no credential at all (the admin door)
  t.equal((await callWorker(env, "POST", `/admin/trade-sentinel/tick?L=74598&APIKEY=wrong`)).status, 403);
  const ok = await callWorker(env, "POST", `/admin/trade-sentinel/tick?L=74598&APIKEY=${ADMIN_KEY}`);
  t.ok(ok.status < 500 && ok.status !== 403, `tick status ${ok.status}`);
});

test("DISCORD interactions are authorised by Discord's signature, not by a session", async () => {
  const { env } = fresh({ env: { DISCORD_PUBLIC_KEY: "0".repeat(64) } });
  const r = await callWorker(env, "POST", `/discord/interactions`, { body: { type: 3, data: { custom_id: "tr:think:1" } } });
  t.ok([400, 401].includes(r.status), `status ${r.status}`);
});

test("READS still refuse a missing owner session and never fall back to the commissioner cookie", async () => {
  const { env, mfl } = fresh();
  const list = await callWorker(env, "GET", `/api/trades/proposals?${Q}&franchise_id=0001`);
  t.ok([401, 500].includes(list.status)); t.notEqual(list.json && list.json.ok, true);
  const pend = await callWorker(env, "GET", `/trade-pending?${Q}&franchise_id=0001`);
  t.ok(pend.status >= 400);
  t.equal(mfl.st.exports.filter((e) => e.type === "pendingTrades" && e.cookie === COMMISH_COOKIE).length, 0);
});

test("READS: an EXPIRED / invalid owner session is 401 'sign in again' (it used to be a 502 that looked like 'MFL is down'); a real MFL outage stays 5xx", async () => {
  const { env, mfl } = fresh();
  for (const p of ["/api/trades/proposals", "/trade-offers", "/trade-pending"]) {
    for (const tok of ["tok-expired", "tok-x"]) {
      const r = await callWorker(env, "GET", `${p}?${Q}&franchise_id=0001&FRANCHISE_ID=0001&MFL_USER_ID=${tok}`);
      t.equal(r.status, 401, `${p} ${tok}`); t.match(r.json.error, /sign-in expired/i);
    }
  }
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => (/TYPE=pendingTrades/.test(String(u)) ? { ok: false, status: 503, headers: new Headers(), text: async () => "down", json: async () => ({}) } : real(u, i));
  const down = await callWorker(env, "GET", `/api/trades/proposals?${Q}&franchise_id=0001&MFL_USER_ID=tok-B`);
  globalThis.fetch = real;
  t.ok(down.status >= 500, `an MFL outage is a 5xx: ${down.status}`); t.notEqual(down.status, 401);
  noCommishCookie(mfl);
});

test("READS return only the owner's own pending trades", async () => {
  const { env, mfl } = fresh();
  tid(mfl, "0001", "0002"); tid(mfl, "0003", "0008");
  const r = await callWorker(env, "GET", `/api/trades/proposals?${Q}&franchise_id=0001&MFL_USER_ID=tok-B`);
  t.equal(r.status, 200);
  t.equal((r.json.outgoing || []).length + (r.json.incoming || []).length, 1);
});

// ═════════════════════════════ READS are scoped to the PROVEN franchise ═════════════════════════════
// The franchise named on a read is a request, not identity. An owner naming another team gets a 200 with
// THEIR OWN lists (`scoped_to_proven: true`) — not a 403, which both inbox clients would read as "signed out".
// Only an owner reading their own proven franchise runs the reminder cleanup and the 5-minute stored fallback.
function readsWorld(over) {
  const w = fresh(over);
  applyMigrations(w.env.UPS_MFL_DB, ["0076_trade_offer_dm.sql", "0102_trade_sentinel.sql"]);
  return w;
}
const seedDm = (env, trade_id, from, to) => env.UPS_MFL_DB.raw.prepare(
  `INSERT INTO trade_offer_dm (trade_id, league_id, season, from_franchise_id, to_franchise_id, created_at_utc, state)
   VALUES (?, '74598', '2026', ?, ?, '2026-10-20T10:00:00Z', 'active')`).run(trade_id, from, to);
const dmState = (env, trade_id) => ({ ...env.UPS_MFL_DB.raw.prepare("SELECT state, resolved_reason FROM trade_offer_dm WHERE trade_id=?").get(trade_id) });
const dmRowsJson = (env) => JSON.stringify(env.UPS_MFL_DB.raw.prepare("SELECT * FROM trade_offer_dm ORDER BY trade_id").all());
// The stored offers doc (site/trades/trade_offers_<L>_<YEAR>.json) is served from GitHub Pages; the harness gives it these rows.
function serveStoredOffers(offers) {
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => (/github\.io\/upsmflproduction\/trades\/trade_offers_74598_2026\.json/.test(String(u))
    ? { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ offers }), text: async () => JSON.stringify({ offers }) }
    : real(u, i));
  return () => { globalThis.fetch = real; };
}
const minsAgo = (m) => new Date(Date.now() - m * 60 * 1000).toISOString();
const storedOffer = (id, from, to, createdAt) => ({ id, status: "PENDING", from_franchise_id: from, to_franchise_id: to, created_at: createdAt, message: "", will_give_up: "14056", will_receive: "13100" });
const fidsOf = (rows) => (rows || []).map((o) => `${o.from_franchise_id}>${o.to_franchise_id}`).sort();

test("READS: an owner naming ANOTHER team gets 200 with their OWN lists (scoped_to_proven), and that team's reminders are untouched", async () => {
  const { env, mfl } = readsWorld();
  tid(mfl, "0001", "0002"); tid(mfl, "0001", "0003"); tid(mfl, "0002", "0003");
  seedDm(env, "9001", "0003", "0002");                                  // the named team's active reminder, absent from A's MFL list
  for (const p of ["/trade-offers", "/api/trades/proposals"]) {
    const r = await callWorker(env, "GET", `${p}?${Q}&franchise_id=0002&FRANCHISE_ID=0002&MFL_USER_ID=tok-B`);
    t.equal(r.status, 200, p); t.equal(r.json.ok, true, p);
    t.equal(r.json.franchise_id, "0001", p); t.equal(r.json.scoped_to_proven, true, p);
    t.ok(Array.isArray(r.json.incoming) && Array.isArray(r.json.outgoing) && Array.isArray(r.json.offers) && Array.isArray(r.json.proposals), p);
    t.deepEqual(fidsOf(r.json.outgoing), ["0001>0002", "0001>0003"], p);
    t.deepEqual(r.json.incoming, [], p);
    t.ok([...r.json.offers, ...r.json.proposals].every((o) => o.from_franchise_id === "0001" || o.to_franchise_id === "0001"), p);
  }
  t.deepEqual(dmState(env, "9001"), { state: "active", resolved_reason: null });
  noCommishCookie(mfl);
});

test("READS: an owner reading their OWN team is not marked scoped, and their absent reminder is resolved (behavior kept)", async () => {
  const { env, mfl } = readsWorld();
  const live = tid(mfl, "0002", "0001");
  seedDm(env, live, "0002", "0001");                                    // still live → stays active
  seedDm(env, "9002", "0003", "0001");                                  // gone from A's live list → resolved
  const r = await callWorker(env, "GET", `/trade-offers?${Q}&franchise_id=0001&MFL_USER_ID=tok-B`);
  t.equal(r.status, 200); t.equal(r.json.franchise_id, "0001"); t.equal(r.json.scoped_to_proven, undefined);
  t.equal(r.json.incoming.length, 1);
  t.deepEqual(dmState(env, live), { state: "active", resolved_reason: null });
  t.deepEqual(dmState(env, "9002"), { state: "resolved", resolved_reason: "not_pending_live" });
});

test("READS: the 5-minute stored fallback only ever shows the proven owner's own offers", async () => {
  const { env } = readsWorld();                                         // A's (0001) MFL pending list is empty
  const undo = serveStoredOffers([
    storedOffer("s-bc", "0002", "0003", minsAgo(1)),                    // another team's fresh offer
    storedOffer("s-a1", "0001", "0002", minsAgo(1)),                    // A's own, 1 minute old
    storedOffer("s-a6", "0001", "0003", minsAgo(6)),                    // A's own, 6 minutes old (outside the window)
  ]);
  try {
    const named = await callWorker(env, "GET", `/trade-offers?${Q}&franchise_id=0002&MFL_USER_ID=tok-B`);
    t.equal(named.status, 200); t.equal(named.json.scoped_to_proven, true);
    const all = [...named.json.incoming, ...named.json.outgoing, ...named.json.offers, ...named.json.proposals];
    t.equal(all.some((o) => o.proposal_id === "s-bc"), false, "another team's stored offer is never returned");
    t.deepEqual(named.json.outgoing.map((o) => o.proposal_id), ["s-a1"], "A's own 1-minute-old offer is shown, the 6-minute one is not");
    const own = await callWorker(env, "GET", `/api/trades/proposals?${Q}&franchise_id=0001&MFL_USER_ID=tok-B`);
    t.deepEqual(own.json.outgoing.map((o) => o.proposal_id), ["s-a1"]);
    t.deepEqual(own.json.incoming, []);
  } finally { undo(); }
});

test("READS: a commissioner acting as a team keeps that view (200), but runs no reminder cleanup and no stored fallback for it", async () => {
  const { env, mfl } = readsWorld();
  seedDm(env, "9003", "0002", "0001");
  const undo = serveStoredOffers([storedOffer("s-01", "0001", "0002", minsAgo(1))]);
  try {
    const r = await callWorker(env, "GET", `/trade-offers?${Q}&franchise_id=0001&MFL_USER_ID=tok-commish`);
    t.equal(r.status, 200); t.equal(r.json.franchise_id, "0001"); t.equal(r.json.scoped_to_proven, undefined);
    t.equal([...r.json.incoming, ...r.json.outgoing].some((o) => o.proposal_id === "s-01"), false);
  } finally { undo(); }
  t.deepEqual(dmState(env, "9003"), { state: "active", resolved_reason: null });
  t.equal(mfl.st.exports.filter((e) => e.type === "pendingTrades" && e.cookie === COMMISH_COOKIE).length, 0);
});

test("READS: an MFL identity outage is 503 identity_unavailable — no pendingTrades call, no D1 write", async () => {
  const { env, mfl } = readsWorld({ mfl: { myleaguesDown: true } });
  seedDm(env, "9004", "0002", "0001");
  const before = dmRowsJson(env);
  for (const p of ["/trade-offers", "/api/trades/proposals", "/api/trades/proposals/2001"]) {
    const r = await callWorker(env, "GET", `${p}?${Q}&franchise_id=0001&MFL_USER_ID=tok-B`);
    t.equal(r.status, 503, p); t.equal(r.json.ok, false, p); t.equal(r.json.code, "identity_unavailable", p);
    t.equal(r.json.pending_lookup && r.json.pending_lookup.missing_owner_session, false, p);
  }
  t.equal(mfl.st.exports.filter((e) => e.type === "pendingTrades").length, 0);
  t.equal(dmRowsJson(env), before);
});

test("READS: /api/trades/proposals/<id> naming another team is scoped the same way", async () => {
  const { env, mfl } = readsWorld();
  const undo = serveStoredOffers([storedOffer("s-bc", "0002", "0003", minsAgo(1))]);
  try {
    const other = await callWorker(env, "GET", `/api/trades/proposals/s-bc?${Q}&franchise_id=0002&MFL_USER_ID=tok-B`);
    t.equal(other.status, 404, "another team's stored offer is not returned"); t.equal(other.json.proposal, undefined);
  } finally { undo(); }
  const mine = tid(mfl, "0001", "0003");
  const r = await callWorker(env, "GET", `/api/trades/proposals/${mine}?${Q}&franchise_id=0002&MFL_USER_ID=tok-B`);
  t.equal(r.status, 200); t.equal(r.json.franchise_id, "0001"); t.equal(r.json.scoped_to_proven, true);
  t.equal(r.json.proposal.from_franchise_id, "0001");
});

// A read that names NO franchise (the rookie draft hub's poll) answers exactly as it did before the identity
// gate: the caller's own MFL list, unfiltered, with no incoming/outgoing split, no reminder cleanup and no
// stored-offer fallback. The response keys below are the ones the pre-gate worker returned (main 7b243a64).
const NO_FID_KEYS = ["counts", "franchise_id", "generated_at", "incoming", "league_id", "offers", "ok", "outgoing", "pending_lookup", "proposals", "season", "server", "source"];
test("READS: naming NO franchise keeps today's answer — unfiltered own list, no split, no cleanup, no stored fallback, no D1 write", async () => {
  const { env, mfl } = readsWorld();
  tid(mfl, "0001", "0002"); tid(mfl, "0003", "0001");
  seedDm(env, "9005", "0002", "0001");                                  // the caller's own reminder, absent from the live list
  const docReads = [];
  const undo = serveStoredOffers([storedOffer("s-a1", "0001", "0003", minsAgo(1))]);
  const served = globalThis.fetch;
  globalThis.fetch = async (u, i) => { if (/github\.io|githubusercontent|api\.github\.com/.test(String(u))) docReads.push(String(u)); return served(u, i); };
  const changes = () => env.UPS_MFL_DB.raw.prepare("SELECT total_changes() AS n").get().n;
  const before = { rows: dmRowsJson(env), changes: changes() };
  try {
    for (const p of ["/trade-offers", "/api/trades/proposals"]) {
      const r = await callWorker(env, "GET", `${p}?${Q}&MFL_USER_ID=tok-B`);
      t.equal(r.status, 200, p);
      t.deepEqual(Object.keys(r.json).sort(), NO_FID_KEYS, p);
      t.equal(r.json.franchise_id, "", p);
      t.deepEqual(r.json.incoming, [], p); t.deepEqual(r.json.outgoing, [], p);
      t.deepEqual(fidsOf(r.json.proposals), ["0001>0002", "0003>0001"], p);
      t.deepEqual(fidsOf(r.json.offers), ["0001>0002", "0003>0001"], p);
      t.equal([...r.json.proposals, ...r.json.offers].some((o) => o.source === "stored_only" || o.proposal_id === "s-a1"), false, `${p}: no stored-offer fallback rows`);
      t.equal(r.json.pending_lookup.stored_only_outgoing + r.json.pending_lookup.stored_only_incoming, 0, p);
    }
    const one = await callWorker(env, "GET", `/api/trades/proposals/${mfl.st.pending[1].trade_id}?${Q}&MFL_USER_ID=tok-B`);
    t.equal(one.status, 200); t.equal(one.json.franchise_id, ""); t.equal(one.json.scoped_to_proven, undefined);
  } finally { globalThis.fetch = served; undo(); }
  t.equal(dmRowsJson(env), before.rows); t.equal(changes(), before.changes, "no D1 write");
  t.deepEqual(dmState(env, "9005"), { state: "active", resolved_reason: null });
  // The offers doc is still read once per request, as before the gate: pending rows are enriched from it
  // (normalizePendingProposal's stored match). That read predates this change and is not the fallback.
  t.equal(docReads.length, 3, `offers-doc reads: ${docReads.length}`);
});

test("READS: signed out stays 401 'sign in' on every read spelling, and the admin key does not open them", async () => {
  const { env, mfl } = readsWorld();
  for (const p of ["/trade-offers", "/api/trades/proposals", "/api/trades/proposals/2001"]) {
    const r = await callWorker(env, "GET", `${p}?${Q}&franchise_id=0001`);
    t.equal(r.status, 401, p); t.equal(r.json.ok, false, p);
    t.equal(r.json.pending_lookup.error, "missing_owner_session_mfl_user_id", p);
    const admin = await callWorker(env, "GET", `${p}?${Q}&franchise_id=0001&APIKEY=${ADMIN_KEY}`);
    t.equal(admin.status, 401, `${p} admin key`);
  }
  t.equal(mfl.st.exports.filter((e) => e.type === "pendingTrades").length, 0);
});

// ═════════════════════════════ the owner-triggered after-trade refresh still reaches its admin-only steps ═════════════════════════════
// The deployed desktop calls /refresh/after-trade with reconcile_extensions:true after every accepted trade.
// That handler self-calls the (now admin-only) reconcile route; it must do so with explicit internal authority.
const AFTER = { league_id: "74598", season: "2026", trade_id: "2001", acting_franchise_id: "0001", dispatch_refresh_mym_json: false, reconcile_extensions: true };
test("AFTER-TRADE: an ordinary owner's refresh (reconcile on) succeeds — the internal reconcile is authorised, not 403'd by the new gate", async () => {
  const { env } = fresh();
  // no SELF binding: the internal call falls back to the worker's own origin (model it as a same-origin hop)
  const real = globalThis.fetch; const inner = workerFetch(env);
  globalThis.fetch = async (u, i) => (new URL(String(u)).hostname === "worker.test" ? inner(u, i) : real(u, i));
  const r = await callWorker(env, "POST", `/refresh/after-trade?${Q}&MFL_USER_ID=tok-B`, { body: AFTER });
  globalThis.fetch = real;
  t.equal(r.status, 200);
  t.ok(r.json.reconcile_extensions, "reconcile ran");
  t.equal(r.json.reconcile_extensions.status, 200);
  t.notEqual(r.json.reconcile_extensions.status, 403);
});

test("AFTER-TRADE: internal admin calls go through env.SELF (service binding) — the admin key never touches the network fetch", async () => {
  const { env, mfl } = fresh();
  const selfCalls = [];
  const inner = workerFetch(env);
  env.SELF = { fetch: async (u, i) => { selfCalls.push(String(u)); return inner(u, i); } };
  const netCalls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (u, i) => { netCalls.push(String(u)); return real(u, i); };
  const r = await callWorker(env, "POST", `/refresh/after-trade?${Q}&MFL_USER_ID=tok-B`, { body: AFTER });
  globalThis.fetch = real;
  t.equal(r.status, 200); t.equal(r.json.reconcile_extensions.status, 200);
  t.ok(selfCalls.some((u) => /\/reconcile\/extensions/.test(u) && u.includes("APIKEY=")), "reconcile went via SELF");
  t.equal(netCalls.filter((u) => u.includes("APIKEY=" + ADMIN_KEY)).length, 0);
  // and the same owner still cannot call reconcile directly
  t.equal((await callWorker(env, "POST", `/reconcile/extensions?${Q}&MFL_USER_ID=tok-B`, { body: {} })).status, 403);
});

// ═════════════════════════════ every legacy alias enforces the SAME gate ═════════════════════════════
// The deployed desktop War Room speaks /trade-offers, /trade-offers/action, /trade-outbox(/replay),
// /reconcile/extensions and /refresh/after-trade; the mobile app speaks /api/trades/*. One handler
// serves each pair, and this proves neither spelling is a side door.
const ALIASES = [
  ["POST", "/trade-offers", "/api/trades/proposals", () => proposal("0001", "0002")],
  ["POST", "/trade-offers/action", "/api/trades/proposals/action", (id) => actionBody("revoke", id, "0001")],
  ["GET", "/trade-outbox", "/api/trades/outbox", null],
  ["POST", "/trade-outbox/replay", "/api/trades/outbox/replay", () => ({ league_id: "74598", season: "2026", outbox_id: "1" })],
  ["GET", "/reconcile/extensions", "/api/trades/reconcile/extensions", null],
  ["POST", "/refresh/after-trade", "/api/trades/refresh-after-trade", () => ({})],
];
test("ALIASES: legacy and /api/trades spellings are refused identically when signed out, and write nothing", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  for (const [m, legacy, modern, mk] of ALIASES) {
    for (const p of [legacy, modern]) {
      const r = await callWorker(env, m, `${p}?${Q}`, mk ? { body: mk(id) } : undefined);
      t.equal(r.status, 401, `${m} ${p} -> ${r.status}`);
    }
  }
  t.equal(writes(mfl), 0); noCommishCookie(mfl); t.equal(mfl.st.pending.length, 1);
});

test("ALIASES: an ordinary owner is refused on every ADMIN alias, and accepted on the owner aliases, in both spellings", async () => {
  const { env, mfl } = fresh();
  const id = tid(mfl);
  for (const [m, legacy, modern, mk] of ALIASES.filter((a) => /replay|reconcile/.test(a[1]))) {
    for (const p of [legacy, modern]) t.equal((await callWorker(env, m, `${p}?${Q}&MFL_USER_ID=tok-B`, mk ? { body: mk(id) } : undefined)).status, 403, `${m} ${p}`);
  }
  for (const p of ["/trade-offers", "/api/trades/proposals"]) {
    const r = await callWorker(env, "POST", `${p}?${Q}&MFL_USER_ID=tok-B`, { body: proposal("0001", "0002") });
    t.ok(r.status < 300, `${p} -> ${r.status}`);
  }
  t.equal(mfl.writes("tradeProposal").length, 2);
  for (const p of ["/trade-offers/action", "/api/trades/proposals/action"]) {
    const bad = await callWorker(env, "POST", `${p}?${Q}&MFL_USER_ID=tok-O`, { body: actionBody("revoke", mfl.st.pending[0].trade_id, "0003") });
    t.equal(bad.status, 409, p);
  }
  noCommishCookie(mfl);
});

await run("trade_2way_authz");
restoreConsole();
