// Mobile beta, Stage 1 (#1475): the REAL worker on real SQLite, MFL stubbed at the edge.
//   node tests/beta_worker.test.mjs
//
// Proves, end to end: the handoff -> redemption -> beta request lifecycle (the stored MFL session is decrypted only for the route and the
// route's existing proof is unchanged); commissioner authority is switched off for beta requests; the kill switches, invitations, sign-out and
// purge take effect on the very next request; expired / revoked / paused / malformed / wrong-environment credentials NEVER fall back to
// classic authentication and never reach an MFL call; no credential appears in any response, log line or database row; the original app is
// unaffected; and CORS allows the two beta headers.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { quiet } from "./fixtures/worker_harness.mjs";
import { makeBetaEnv, makeMfl, callWorker, ADMIN_KEY, LEAGUE, MARKER, TEST_KEY, ALL_FLAGS, setFlags, allOn, signIn, bearer, captureConsole } from "./fixtures/beta_worker_harness.mjs";
import { makeBetaStore, sha256Hex, SESSION_TTL_MS } from "../worker/src/beta_session.js";
import { handleBetaRoute } from "../worker/src/beta_routes.js";

const restore = quiet();
const fresh = (over) => { const env = makeBetaEnv(over); const mfl = makeMfl({}); mfl.install(); allOn(env); return { env, mfl }; };
const q = `L=${LEAGUE}&YEAR=2026`;
const mflCalls = (mfl) => mfl.st.exports.length + mfl.st.imports.length;
const rowsChanged = (env) => env.UPS_MFL_DB.raw.prepare("SELECT total_changes() AS n").get().n;   // rows actually modified (a zero-row UPDATE is not a write)
const writes = (env) => env.UPS_MFL_DB.log.filter((l) => /^\s*(INSERT|UPDATE|DELETE)/i.test(l.sql)).length;

// ───────────────────────────── the lifecycle ─────────────────────────────
test("LIFECYCLE: invite -> handoff -> redeem -> a beta request runs the existing route as the proven franchise; the stored session is ciphertext", async () => {
  const { env, mfl } = fresh();
  const s = await signIn(env);
  t.equal(s.handoff.status, 200); t.match(s.handoff.json.code, /^ups_bh_/); t.equal(s.handoff.json.expires_in, 60);
  t.equal(s.session.status, 200); t.match(s.sid, /^ups_bs_/); t.equal(s.session.json.environment, "live");
  const before = mfl.st.exports.length;
  const me = await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(s.sid) });
  t.equal(me.status, 200); t.equal(me.json.configured, true); t.equal(me.json.franchise_id, "0008");
  const proofs = mfl.st.exports.slice(before).filter((e) => e.type === "myleagues");
  t.equal(proofs.length, 1, "the route proved the owner with MFL's own league lookup");
  t.match(proofs[0].cookie, /MFL_USER_ID=tok-A/, "using the decrypted session");
  const dump = JSON.stringify(env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_beta_sessions").all());
  t.ok(!dump.includes("tok-A") && !dump.includes(s.sid) && !dump.includes(s.code), "no plaintext session, session id or code in any row");
  const original = await callWorker(env, "GET", `/api/me?${q}&MFL_USER_ID=tok-A`);
  t.equal(original.json.franchise_id, me.json.franchise_id, "the original app (session in the query) proves the same franchise");
  t.equal(original.json.is_commish, true, "0008 is a commissioner franchise: the original app says so");
  t.equal(me.json.is_commish, false, "and the beta, by design, never does (commissioner authority is off for beta requests)");
});

test("COMMISSIONER AUTHORITY IS OFF FOR BETA REQUESTS: the same commissioner session is_commish in the original app and is not through the beta", async () => {
  const { env } = fresh();
  const s = await signIn(env, { token: "tok-commish", fid: "0000" });
  t.equal(s.session.status, 200);
  const beta = await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(s.sid) });
  t.equal(beta.json.franchise_id, "0000"); t.equal(beta.json.is_commish, false, "no commissioner authority through the beta");
  const orig = await callWorker(env, "GET", `/api/me?${q}&MFL_USER_ID=tok-commish`);
  t.equal(orig.json.is_commish, true, "the original app is unchanged");
  // a commissioner-only read (commishSessionProven) is not even handed the session: an unlisted GET passes as anonymous
  const intel = await callWorker(env, "GET", `/api/auction/intel?${q}`, { headers: bearer(s.sid) });
  const intelOrig = await callWorker(env, "GET", `/api/auction/intel?${q}&MFL_USER_ID=tok-commish`);
  t.ok(intel.status >= 400, "beta commissioner session gets no commissioner data: " + intel.status);
  t.ok(intelOrig.status !== intel.status || JSON.stringify(intelOrig.json) !== JSON.stringify(intel.json), "while the original app's commissioner session is treated differently");
});

// ───────────────────────────── kill switches take effect on the next request ─────────────────────────────
test("KILL SWITCHES: the master, a flow switch, an invitation, sign-out and a purge each end the beta's access on the very next request; the original app is untouched", async () => {
  const { env, mfl } = fresh();
  const s = await signIn(env);
  const call = () => callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(s.sid) });
  const orig = () => callWorker(env, "GET", `/api/me?${q}&MFL_USER_ID=tok-A`);
  const origBefore = JSON.stringify((await orig()).json);
  t.equal((await call()).status, 200);
  setFlags(env, { BETA_ENABLED: false });
  let r = await call(); t.equal(r.status, 503); t.equal(r.json.code, "beta_paused");
  t.equal(JSON.stringify((await orig()).json), origBefore, "the original app is unaffected by the master switch");
  const stale = await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(s.sid, { "X-UPS-Client": "beta/0.0.1-cached-copy" }) });
  t.equal(stale.json.code, "beta_paused", "an older cached copy is refused too");
  setFlags(env, { BETA_ENABLED: true }); t.equal((await call()).status, 200, "switching back on restores it (the session itself was never touched)");
  // a flow switch: /api/lineup needs BETA_FLOW_LINEUP, /api/me needs only the master
  setFlags(env, { BETA_FLOW_LINEUP: false });
  const lineup = await callWorker(env, "GET", `/api/lineup?${q}&franchise_id=0008`, { headers: bearer(s.sid) });
  t.equal(lineup.json.code, "flow_off"); t.equal((await call()).status, 200, "identity read is unaffected by a flow switch");
  setFlags(env, { BETA_FLOW_LINEUP: true });
  // un-invite
  await callWorker(env, "POST", `/admin/beta/invites?L=${LEAGUE}&APIKEY=${ADMIN_KEY}`, { body: { franchise_id: "0008", league_id: LEAGUE, action: "uninvite" } });
  r = await call(); t.equal(r.status, 401); t.equal(r.json.code, "session_invalid", "un-inviting revokes the session at once");
  // sign-out and purge
  const s2 = await signIn(env);
  t.equal((await callWorker(env, "POST", `/api/beta/signout?${q}`, { headers: bearer(s2.sid), body: {} })).status, 200);
  t.equal((await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(s2.sid) })).json.code, "session_invalid");
  const s3 = await signIn(env);
  const purge = await callWorker(env, "POST", `/admin/beta/purge-sessions?${q}&APIKEY=${ADMIN_KEY}`, { body: {} });
  t.equal(purge.status, 200);
  t.equal((await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(s3.sid) })).json.code, "session_invalid");
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_beta_sessions WHERE mfl_enc IS NOT NULL").get().n, 0, "purge wipes every stored MFL session");
  void mfl;
});

test("EXPIRY: a session is refused the moment its expiry passes, with no cleanup involved (the row and its ciphertext are still there)", async () => {
  const { env } = fresh();
  const s = await signIn(env);
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_beta_sessions SET live_until = ?").run(Date.now() - 1);
  const r = await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(s.sid) });
  t.equal(r.status, 401); t.equal(r.json.code, "session_expired");
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_beta_sessions WHERE mfl_enc IS NOT NULL").get().n, 1, "cleanup has not run, and was not needed");
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_beta_sessions SET live_until = ?").run(Date.now() + 60_000);
  t.equal((await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(s.sid) })).status, 200, "and a not-yet-expired session still works");
});

// ───────────────────────────── no fallback to classic authentication ─────────────────────────────
test("NO FALLBACK: expired, revoked, paused, malformed and wrong-environment credentials are refused on every kind of route, make no MFL call and write nothing", async () => {
  const { env, mfl } = fresh();
  const good = await signIn(env);
  const revoked = await signIn(env, { token: "tok-B", fid: "0001" });
  await callWorker(env, "POST", `/api/beta/signout?${q}`, { headers: bearer(revoked.sid), body: {} });
  const expired = await signIn(env, { token: "tok-C", fid: "0002" });
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_beta_sessions SET live_until = ? WHERE franchise_id = '0002'").run(Date.now() - 5);
  mfl.st.otherLeague["tok-T"] = { league: "25625", fid: "0003" };                     // an MFL login that is a member of the TEST league (25625)
  const testLeagueFid = await signIn(env, { token: "tok-T", fid: "0003", league: "25625", environment: "test" });   // a test-environment session
  t.equal(testLeagueFid.session.status, 200, "a test-environment session exists");
  const bad = {
    expired: [bearer(expired.sid), "session_expired"],
    revoked: [bearer(revoked.sid), "session_invalid"],
    malformed_short: [bearer("ups_bs_short"), "session_invalid"],
    malformed_prefix: [bearer("ups_bs_" + "A".repeat(44)), "session_invalid"],
    wrong_kind: [bearer(good.code), "session_invalid"],            // a handoff code presented as a session id
    unknown: [bearer("ups_bs_" + "B".repeat(43)), "session_invalid"],
  };
  const routes = [
    ["POST", `/api/submit-lineup?${q}`, { franchise_id: "0008", week: 12 }],     // allowlisted write
    ["GET", `/api/me?${q}`, undefined],                                        // allowlisted read
    ["GET", `/api/lineup?${q}`, undefined],
    ["POST", `/api/trades/proposals?${q}`, { from_franchise_id: "0008" }],
    ["POST", `/roster-workbench/action?${q}`, { action: "drop_player", franchise_id: "0008", player_id: "16614" }],
    ["POST", `/commish-contract-update?${q}`, { franchise_id: "0008" }],
    ["GET", `/api/mfl-export?${q}&TYPE=league`, undefined],                     // a public read: still refused WITH a bad credential
    ["GET", `/api/auction/intel?${q}`, undefined],                              // an unlisted commissioner read
    ["POST", `/api/pick?${q}`, { franchise_id: "0008", player_id: "1" }],       // not on the allowlist
    ["POST", `/api/settings?${q}`, { mfl_user_id: "tok-A" }],
    ["POST", `/admin/3way/cancel?${q}`, {}],
    ["GET", `/admin/config-health?${q}`, undefined],
    ["POST", `/api/beta/signout?${q}`, { mfl_user_id: "tok-A" }],                   // a lifecycle route with a raw original-app session mixed in (round-1 MAT-1)
  ];
  const mflBefore = mflCalls(mfl), writesBefore = writes(env);
  for (const [name, [headers, code]] of Object.entries(bad)) {
    for (const [method, path, body] of routes) {
      const r = await callWorker(env, method, path, { headers, body });
      const isAdmin = path.startsWith("/admin"), isRawSignout = path.startsWith("/api/beta/signout");
      t.equal(r.json && r.json.code, isAdmin ? "beta_route_not_allowed" : isRawSignout ? "ambiguous_credentials" : code, `${name} ${method} ${path.split("?")[0]} -> ${r.status} ${r.text.slice(0, 80)}`);
      t.ok(r.status >= 400, `${name} ${path.split("?")[0]} is a refusal`);
    }
  }
  t.equal(mflCalls(mfl), mflBefore, "not one MFL call was made for any bad credential");
  t.equal(writes(env), writesBefore, "not one D1 write was made for any bad credential");
  // paused: a perfectly good session is refused everywhere owner-scoped
  setFlags(env, { BETA_ENABLED: false });
  for (const [method, path, body] of routes.filter((r) => !r[1].startsWith("/admin") && !r[1].startsWith("/api/beta/"))) {
    const r = await callWorker(env, method, path, { headers: bearer(good.sid), body });
    t.equal(r.json.code, "beta_paused", `paused ${method} ${path.split("?")[0]}`);
  }
  t.equal(mflCalls(mfl), mflBefore, "paused: no MFL call"); t.equal(writes(env), writesBefore, "paused: no D1 write");
  setFlags(env, { BETA_ENABLED: true });
  // wrong environment: the test-environment session used against the live league, and the live session against the test league
  const w1 = await callWorker(env, "GET", `/api/me?L=${LEAGUE}&YEAR=2026`, { headers: bearer(testLeagueFid.sid) });
  t.equal(w1.json.code, "league_not_allowed", "a test-environment session is not valid for the live league");
  const w2 = await callWorker(env, "GET", `/api/me?L=25625&YEAR=2026`, { headers: bearer(good.sid) });
  t.equal(w2.json.code, "league_not_allowed", "a live session is not valid for the test league");
  const w3 = await callWorker(env, "GET", `/api/me?L=99999&YEAR=2026`, { headers: bearer(good.sid) });
  t.equal(w3.json.code, "league_not_allowed", "an unknown league");
  t.equal(mflCalls(mfl), mflBefore); t.equal(writes(env), writesBefore);
});

test("NO FALLBACK: a bad beta credential accompanied by a VALID classic session is refused, not authenticated the classic way", async () => {
  const { env, mfl } = fresh();
  const mflBefore = mflCalls(mfl);
  const withQuery = await callWorker(env, "GET", `/api/me?${q}&MFL_USER_ID=tok-A`, { headers: bearer("ups_bs_" + "C".repeat(43)) });
  t.equal(withQuery.json.code, "ambiguous_credentials");
  const withCookie = await callWorker(env, "GET", `/api/me?${q}`, { headers: { ...bearer("ups_bs_" + "C".repeat(43)), Cookie: "MFL_USER_ID=tok-A" } });
  t.equal(withCookie.json.code, "ambiguous_credentials");
  const markerOnly = await callWorker(env, "POST", `/api/submit-lineup?${q}`, { headers: { ...MARKER, Cookie: "MFL_USER_ID=tok-A" }, body: { franchise_id: "0008" } });
  t.equal(markerOnly.json.code, "ambiguous_credentials", "the marker alone (no session id) plus a classic cookie is refused");
  const markerBody = await callWorker(env, "POST", `/api/submit-lineup?${q}`, { headers: MARKER, body: { franchise_id: "0008", mfl_user_id: "tok-A" } });
  t.equal(markerBody.json.code, "session_required", "no session id: a write is refused outright");
  const withKey = await callWorker(env, "GET", `/api/me?${q}&APIKEY=${ADMIN_KEY}`, { headers: MARKER });
  t.equal(withKey.json.code, "ambiguous_credentials", "a beta request never carries the commissioner key");
  t.equal(mflCalls(mfl), mflBefore, "none of them reached MFL");
  // and the same classic requests WITHOUT the beta marker are the original app, which still works
  t.equal((await callWorker(env, "GET", `/api/me?${q}&MFL_USER_ID=tok-A`)).json.franchise_id, "0008");
});

// ───────────────────────────── the session lifecycle routes ─────────────────────────────
test("HANDOFF/STATUS: refusals are stable codes and create nothing; the beta page cannot start a handoff; no key, no handoff", async () => {
  const { env, mfl } = fresh();
  const hand = (body, o) => callWorker(env, "POST", `/api/beta/handoff?${o && o.q || q}`, { body, headers: o && o.headers });
  const rows = () => env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_beta_sessions").get().n;
  t.equal((await hand({ mfl_user_id: "tok-A" })).json.code, "not_invited", "not invited");
  t.equal(rows(), 0);
  await callWorker(env, "POST", `/admin/beta/invites?${q}&APIKEY=${ADMIN_KEY}`, { body: { franchise_id: "0008", league_id: LEAGUE, action: "invite" } });
  t.equal((await hand({})).json.code, "session_required");
  t.equal((await hand({ mfl_user_id: "tok-nobody" })).json.code, "session_expired", "an MFL session MFL rejects");
  t.equal((await hand({ mfl_user_id: "tok-x" })).status, 403, "an MFL login that is not a member of this league");
  t.equal((await hand({ mfl_user_id: "tok-A" }, { q: "L=99999&YEAR=2026" })).json.code, "league_not_allowed");
  t.equal((await hand({ mfl_user_id: "tok-A" }, { headers: MARKER })).json.code, "beta_route_not_allowed", "a beta page cannot start a handoff");
  t.equal(rows(), 0, "no refusal created a row");
  const noKey = fresh({ BETA_SESSION_KEY: "" });
  await callWorker(noKey.env, "POST", `/admin/beta/invites?${q}&APIKEY=${ADMIN_KEY}`, { body: { franchise_id: "0008", league_id: LEAGUE, action: "invite" } });
  const nk = await callWorker(noKey.env, "POST", `/api/beta/handoff?${q}`, { body: { mfl_user_id: "tok-A" } });
  t.equal(nk.json.code, "key_unavailable"); t.equal(noKey.env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_beta_sessions").get().n, 0, "no key: nothing is sealed or stored");
  const down = fresh(); down.mfl.restore(); const mflDown = makeMfl({ myleaguesDown: true }); mflDown.install();
  await callWorker(down.env, "POST", `/admin/beta/invites?${q}&APIKEY=${ADMIN_KEY}`, { body: { franchise_id: "0008", league_id: LEAGUE, action: "invite" } });
  t.equal((await callWorker(down.env, "POST", `/api/beta/handoff?${q}`, { body: { mfl_user_id: "tok-A" } })).json.code, "identity_unavailable", "MFL down at handoff: nothing created");
  mflDown.restore(); mfl.install();
  // status: booleans only; off = no MFL call
  const st = await callWorker(env, "POST", `/api/beta/status?${q}`, { body: { mfl_user_id: "tok-A" } });
  t.deepEqual(st.json, { ok: true, enabled: true, invited: true });
  setFlags(env, { BETA_ENABLED: false });
  const before = mflCalls(mfl);
  t.deepEqual((await callWorker(env, "POST", `/api/beta/status?${q}`, { body: { mfl_user_id: "tok-A" } })).json, { ok: true, enabled: false, invited: false });
  t.equal(mflCalls(mfl), before, "paused status makes no MFL call");
  t.equal((await hand({ mfl_user_id: "tok-A" })).json.code, "beta_paused");
});

test("REDEEM ROUTE: the same answer for a used, expired, unknown, malformed or wrong-environment code; the session id is returned exactly once", async () => {
  const { env } = fresh();
  const s = await signIn(env);
  const redeem = (code, environment) => callWorker(env, "POST", `/api/beta/session?${q}`, { headers: MARKER, body: { code, environment: environment || "live" } });
  const replay = await redeem(s.code);
  t.equal(replay.status, 400); t.equal(replay.json.code, "code_invalid");
  const h = await callWorker(env, "POST", `/api/beta/handoff?${q}`, { body: { mfl_user_id: "tok-A" } });
  const answers = [await redeem("ups_bh_" + "A".repeat(22)), await redeem("garbage"), await redeem(h.json.code, "test"), await redeem(h.json.code, "bogus"), replay];
  for (const a of answers) { t.equal(a.status, 400); t.equal(a.text, replay.text, "byte-identical refusal: no oracle"); }
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_beta_sessions SET handoff_expires_at = ? WHERE handoff_hash IS NOT NULL").run(Date.now() - 1);
  t.equal((await redeem(h.json.code)).json.code, "code_invalid", "expired");
  const h2 = await callWorker(env, "POST", `/api/beta/handoff?${q}`, { body: { mfl_user_id: "tok-A" } });
  const okOnce = await redeem(h2.json.code); t.equal(okOnce.status, 200); t.match(okOnce.json.session_id, /^ups_bs_/);
  t.equal((await redeem(h2.json.code)).json.code, "code_invalid", "the second redemption of a good code");
  t.equal(JSON.stringify(okOnce.json).split(okOnce.json.session_id).length - 1, 1, "the id appears once in the one response");
  t.equal((await callWorker(env, "POST", `/api/beta/session?${q}`, { headers: MARKER, body: { code: h.json.code, environment: "live" } })).json.code, "code_invalid");
});

test("CONCURRENCY THROUGH THE ROUTES: simultaneous redemptions of one code give exactly one session; simultaneous handoffs leave at most three live sessions", async () => {
  const { env } = fresh();
  await callWorker(env, "POST", `/admin/beta/invites?${q}&APIKEY=${ADMIN_KEY}`, { body: { franchise_id: "0008", league_id: LEAGUE, action: "invite" } });
  const h = await callWorker(env, "POST", `/api/beta/handoff?${q}`, { body: { mfl_user_id: "tok-A" } });
  const reds = await Promise.all(Array.from({ length: 8 }, () => callWorker(env, "POST", `/api/beta/session?${q}`, { headers: MARKER, body: { code: h.json.code, environment: "live" } })));
  t.equal(reds.filter((r) => r.status === 200).length, 1, "exactly one of 8 simultaneous redemptions succeeds");
  t.equal(reds.filter((r) => r.status === 400 && r.json.code === "code_invalid").length, 7, "the other seven get the identical refusal");
  const winner = reds.find((r) => r.status === 200).json.session_id;
  t.equal((await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(winner) })).status, 200, "and the winner's id works");
  const many = await Promise.all(Array.from({ length: 12 }, () => callWorker(env, "POST", `/api/beta/handoff?${q}`, { body: { mfl_user_id: "tok-A" } })));
  t.ok(many.every((r) => r.status === 200), "every handoff succeeds");
  const liveNow = env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_beta_sessions WHERE revoked_at IS NULL AND live_until > ?").get(Date.now()).n;
  t.ok(liveNow <= 3, "at most three live sessions remain after 12 simultaneous handoffs: " + liveNow);
  t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM ups_beta_sessions WHERE revoked_at IS NOT NULL AND (mfl_enc IS NOT NULL OR sid_hash IS NOT NULL OR handoff_hash IS NOT NULL)").get().n, 0, "every evicted session was wiped");
});

// ── round-1 MAT-1: a beta-classified sign-out never falls back to a raw MFL session ──
test("SIGN-OUT NEVER FALLS BACK: a beta-classified sign-out with a bad, wrong-kind, other-scheme or missing credential AND a valid original-app session in the body makes no MFL call, writes nothing and revokes nothing", async () => {
  const { env, mfl } = fresh();
  const a = await signIn(env), a2 = await signIn(env), other = await signIn(env, { token: "tok-B", fid: "0001" });
  const alive = async (s) => (await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(s.sid) })).status === 200;
  const out = (headers, body) => callWorker(env, "POST", `/api/beta/signout?${q}`, { headers, body });
  const raw = { mfl_user_id: "tok-A" };                                    // a VALID original-app session for franchise 0008
  const kinds = {
    malformed_bearer: bearer("ups_bs_short"),
    wrong_kind_bearer: bearer(a.code),                                     // a handoff code presented as a session id
    unknown_bearer: bearer("ups_bs_" + "E".repeat(43)),
    marker_only: MARKER,
    other_scheme: { ...MARKER, Authorization: "Basic dXNlcjpwYXNz" },
    valid_bearer_plus_raw: bearer(a2.sid),                                 // even a GOOD beta session id may not be mixed with a raw session
    beta_shaped_without_marker: { Authorization: "Bearer ups_bs_short" },  // classified as beta by the credential alone
  };
  for (const paused of [false, true]) {
    setFlags(env, { BETA_ENABLED: !paused });
    for (const [name, headers] of Object.entries(kinds)) {
      const mflBefore = mflCalls(mfl), writesBefore = rowsChanged(env);
      const r = await out(headers, raw);
      t.equal(r.status, 400, `${name}${paused ? " (paused)" : ""}: refused`);
      t.equal(r.json.code, "ambiguous_credentials", `${name}${paused ? " (paused)" : ""}`);
      t.equal(mflCalls(mfl), mflBefore, `${name}: no MFL call (the raw session was never proven)`);
      t.equal(rowsChanged(env), writesBefore, `${name}: no D1 write`);
    }
  }
  setFlags(env, { BETA_ENABLED: true });
  t.ok(await alive(a) && await alive(a2) && await alive(other), "no session of that franchise, or of another, was revoked by any of them");
  // the same bad credentials WITHOUT a raw session: quiet, idempotent, no MFL call, no write
  for (const [name, headers] of Object.entries(kinds)) {
    if (name === "valid_bearer_plus_raw") continue;
    const mflBefore = mflCalls(mfl), writesBefore = rowsChanged(env);
    const r = await out(headers, {});
    t.equal(r.status, 200, name); t.deepEqual(r.json, { ok: true });
    t.equal(mflCalls(mfl), mflBefore, `${name} without a body session: no MFL call`); t.equal(rowsChanged(env), writesBefore, `${name} without a body session: no D1 write`);
  }
  t.ok(await alive(a) && await alive(a2) && await alive(other), "still nothing revoked");
  // a valid beta sign-out ends ONLY that session, is idempotent, and works while paused
  t.equal((await out(bearer(a2.sid), {})).status, 200);
  t.ok(!(await alive(a2)) && await alive(a) && await alive(other), "only that one session ended");
  t.equal((await out(bearer(a2.sid), {})).status, 200, "idempotent: the same sign-out again");
  setFlags(env, { BETA_ENABLED: false });
  t.equal((await out(bearer(a.sid), {})).status, 200, "a valid beta sign-out works while the beta is paused");
  setFlags(env, { BETA_ENABLED: true });
  t.ok(!(await alive(a)) && await alive(other), "and it ended that session");
  // the ORIGINAL app (unmarked) still proves its own session and ends every beta session of the franchise
  const b1 = await signIn(env), b2 = await signIn(env);
  const orig = await callWorker(env, "POST", `/api/beta/signout?${q}`, { headers: { "X-UPS-Client": "classic/2026.11.19.1" }, body: raw });
  t.equal(orig.status, 200);
  t.ok(!(await alive(b1)) && !(await alive(b2)) && await alive(other), "unmarked original-app sign-out is unchanged: all of that franchise's beta sessions end, others do not");
});

test("SIGN-OUT, SECOND LAYER: even if the gate were bypassed, the handler itself never proves a raw MFL session for a beta-classified sign-out (the original app still does)", async () => {
  const mk = (headers, body) => {
    const calls = { detect: 0, revoke: 0, signout: 0 };
    const store = { signout: async () => { calls.signout++; return 0; }, revokeFranchise: async () => { calls.revoke++; return 1; } };
    const a = { request: new Request("https://worker.test/api/beta/signout?L=74598&YEAR=2026", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }),
      url: new URL("https://worker.test/api/beta/signout?L=74598&YEAR=2026"), env: {}, corsHeaders: {}, now: 1, store, getFlags: async () => ({ ok: true, flags: { BETA_ENABLED: true } }),
      detectFranchise: async () => { calls.detect++; return { franchise_id: "0008" }; }, leagueId: "74598", season: "2026" };
    return { a, calls };
  };
  const raw = { mfl_user_id: "tok-A" };
  for (const headers of [{ "X-UPS-Client": "beta/1" }, { Authorization: "Bearer ups_bs_short" }, { "X-UPS-Client": "beta/1", Authorization: "Bearer " + "x".repeat(10) }, { Authorization: "Bearer ups_bh_" + "A".repeat(22) }]) {
    const { a, calls } = mk(headers, raw);
    const r = await handleBetaRoute(a);
    t.equal(r.status, 200); t.deepEqual(await r.json(), { ok: true });
    t.equal(calls.detect, 0, "no MFL proof for " + JSON.stringify(headers)); t.equal(calls.revoke, 0, "no franchise-wide revocation"); t.equal(calls.signout, 0, "and no session ended without a valid id");
  }
  const { a, calls } = mk({ "X-UPS-Client": "classic/1" }, raw);                  // control: not beta-classified
  t.equal((await handleBetaRoute(a)).status, 200);
  t.equal(calls.detect, 1, "an unmarked original-app request still proves its session"); t.equal(calls.revoke, 1, "and ends the franchise's beta sessions");
  const good = mk({ Authorization: "Bearer ups_bs_" + "A".repeat(43) }, {});
  t.equal((await handleBetaRoute(good.a)).status, 200); t.equal(good.calls.signout, 1, "a well-formed beta id signs that session out"); t.equal(good.calls.detect, 0);
});

test("ORIGINAL-APP SIGN-OUT: a proven original-app session ends every beta session of that franchise; an unknown credential gets the same quiet answer", async () => {
  const { env } = fresh();
  const a = await signIn(env), b = await signIn(env);
  const r = await callWorker(env, "POST", `/api/beta/signout?${q}`, { body: { mfl_user_id: "tok-A" } });
  t.equal(r.status, 200);
  for (const s of [a, b]) t.equal((await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(s.sid) })).json.code, "session_invalid");
  const none = await callWorker(env, "POST", `/api/beta/signout?${q}`, { headers: bearer("ups_bs_" + "D".repeat(43)), body: {} });
  t.equal(none.status, 200); t.deepEqual(none.json, { ok: true });
  setFlags(env, { BETA_ENABLED: false });
  t.equal((await callWorker(env, "POST", `/api/beta/signout?${q}`, { headers: bearer("ups_bs_" + "D".repeat(43)), body: {} })).status, 200, "sign-out works while the beta is paused");
});

// ───────────────────────────── credentials never leak ─────────────────────────────
test("CANARY: the MFL session, the session id and the handoff code appear in no response header, no log line and no database row, except the one response that delivers each", async () => {
  const { env } = fresh();
  const cap = await captureConsole(async () => {
    const seen = [];
    const keep = (r) => { seen.push(r.text + JSON.stringify([...r.headers])); return r; };
    const inv = keep(await callWorker(env, "POST", `/admin/beta/invites?${q}&APIKEY=${ADMIN_KEY}`, { body: { franchise_id: "0008", league_id: LEAGUE, action: "invite" } }));
    const h = keep(await callWorker(env, "POST", `/api/beta/handoff?${q}`, { body: { mfl_user_id: "tok-A" } }));
    const st = keep(await callWorker(env, "POST", `/api/beta/status?${q}`, { body: { mfl_user_id: "tok-A" } }));
    const s = keep(await callWorker(env, "POST", `/api/beta/session?${q}`, { headers: MARKER, body: { code: h.json.code, environment: "live" } }));
    const sid = s.json.session_id;
    const calls = [];
    for (const [m, p, b] of [["GET", `/api/me?${q}`], ["GET", `/api/lineup?${q}&franchise_id=0008`], ["POST", `/api/submit-lineup?${q}`, { franchise_id: "0008" }], ["GET", `/api/waivers/state?${q}`], ["POST", `/api/auction/bid?${q}`, { franchise_id: "0008" }], ["GET", `/api/mfl-export?${q}&TYPE=league`]]) calls.push(keep(await callWorker(env, m, p, { headers: bearer(sid), body: b })));
    for (const bad of ["ups_bs_" + "Z".repeat(43), "nope"]) keep(await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(bad) }));
    keep(await callWorker(env, "POST", `/api/beta/signout?${q}`, { headers: bearer(sid), body: {} }));
    keep(await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer(sid) }));
    return { seen, code: h.json.code, sid, deliveredIn: { code: h.text, sid: s.text }, inv };
  });
  const { seen, code, sid, deliveredIn } = cap.result;
  const everything = seen.join("\n");
  t.ok(!everything.includes("tok-A"), "the MFL session is in no response body or header");
  t.equal(everything.split(sid).length - 1, 1, "the session id is in exactly one response (the one that delivers it)");
  t.equal(everything.split(code).length - 1, 1, "the handoff code is in exactly one response");
  t.ok(deliveredIn.sid.includes(sid) && deliveredIn.code.includes(code));
  const logs = cap.lines.join("\n");
  t.ok(!logs.includes("tok-A") && !logs.includes(sid) && !logs.includes(code), "no console line carries a credential");
  const dump = JSON.stringify(env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_beta_sessions").all()) + JSON.stringify(env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_beta_invites").all());
  t.ok(!dump.includes("tok-A") && !dump.includes(sid) && !dump.includes(code), "no database row carries a credential");
  const stmts = JSON.stringify(env.UPS_MFL_DB.log.map((l) => [l.sql, l.args]));
  t.ok(!stmts.includes(sid) && !stmts.includes(code) && !stmts.includes("tok-A"), "no D1 statement carries a credential (the beta tables see only hashes and ciphertext)");
  for (const r of seen) t.ok(true, r.length > 0 ? "checked" : "checked");
});

test("RESPONSES: every beta lifecycle and refusal response is no-store JSON with stable codes, and carries the CORS headers the beta needs", async () => {
  const { env } = fresh();
  const s = await signIn(env);
  const rs = [
    await callWorker(env, "POST", `/api/beta/handoff?${q}`, { body: { mfl_user_id: "tok-A" } }),
    await callWorker(env, "POST", `/api/beta/session?${q}`, { headers: MARKER, body: { code: "x", environment: "live" } }),
    await callWorker(env, "GET", `/api/me?${q}`, { headers: bearer("ups_bs_" + "Q".repeat(43)) }),
    await callWorker(env, "POST", `/api/submit-lineup?${q}`, { headers: MARKER, body: {} }),
  ];
  for (const r of rs) { t.match(r.headers.get("cache-control") || "", /no-store/); t.match(r.headers.get("access-control-allow-origin") || "", /\*/); }
  const pre = await callWorker(env, "OPTIONS", `/api/submit-lineup?${q}`, { headers: { "Access-Control-Request-Headers": "authorization, x-ups-client, content-type", Origin: "https://ups-mobile-beta.pages.dev" } });
  const allow = (pre.headers.get("access-control-allow-headers") || "").toLowerCase();
  t.ok(allow.includes("authorization") && allow.includes("x-ups-client") && allow.includes("content-type"), "preflight allows the two beta headers and still Content-Type: " + allow);
  void s;
});

await run("beta_worker");
restore();
