// MFL sometimes redirects a commissioner setup page to "/" right after a GOOD switch
// (2026-10-13 supervised run: 4 times; the next try read fine), and once a lockout change
// landed but its check re-read was redirected, so it was reported as a failure.
// Now: a non-login redirect gets up to 3 page tries, each after a fresh switch; a login
// redirect is reported at once; a submitted lockout change whose check read fails is read
// again before it is called a failure (Keith 2026-10-13).
//   node tests/mfl_page_redirect_retry.test.mjs
//
// Fake MFL only, made-up values. No network call.
import { t, test, run } from "./fixtures/mini_test.mjs";
const LK = await import("../worker/src/mfl_lockout.js");

const L = "25625", SEASON = 2026;
const WWW = "https://www48.myfantasyleague.com";
const STORED = "aB3dE5fG7hJ9kL1mN3pQ5r%2BT9vW";   // made-up
const FLAG = "commishflag-made-up-26chrs";          // made-up
const AS_COMMISH = `<div>Commissioner ( <a>Logout</a> | <a>Become Owner</a> )</div>`;
const abilities = (lockout) => `<html><body>${AS_COMMISH}<form method="POST" action="owner_abilities_setup"><input type="hidden" name="L" value="${L}">
  <input type="checkbox" name="FDP_TRADES0001" value="1" checked>
  <table><tr><td>Commissioner Lockout:</td><td><input type="radio" name="LOCKOUT" value="N"${lockout === "No" ? " checked" : ""}> No, can view.<br>
  <input type="radio" name="LOCKOUT" value="Y"${lockout === "Yes" ? " checked" : ""}> Yes, cannot view.<br></td></tr></table><input type="submit" name="SAVE" value="SAVE ABILITIES"></form></body></html>`;

// redirectGets / loginGets: which Abilities GETs (1-based) MFL turns away. applyPost: whether
// a submitted change actually takes.
function fakeMfl({ redirectGets = [], loginGets = [], applyPost = true, lockout = "No" } = {}) {
  const st = { lockout, gets: 0, posts: [], switches: 0 };
  const res = (status, body = "", hdrs = {}) => {
    const h = new Headers();
    for (const [k, v] of Object.entries(hdrs)) for (const x of [].concat(v)) h.append(k, x);
    return { status, headers: h, text: async () => body };
  };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(String(url));
    const cookie = String((init.headers && init.headers.Cookie) || "");
    if (u.pathname.endsWith("/logout")) {
      st.switches += 1;
      return res(302, "", { location: `/2026/home/${L}`, "set-cookie": `MFL_IS_COMMISH=${FLAG}; Domain=.myfantasyleague.com; Path=/; Expires=Tue, 11-May-2027 16:00:00 GMT` });
    }
    if (u.pathname.endsWith(`/home/${L}`)) return res(200, `<html><body>${AS_COMMISH}</body></html>`);
    if (u.pathname.endsWith("/owner_abilities_setup") && (init.method || "GET") === "POST") {
      st.posts.push(cookie);
      if (applyPost) st.lockout = new URLSearchParams(init.body).get("LOCKOUT") === "Y" ? "Yes" : "No";
      return res(200, "saved");
    }
    if (u.pathname.endsWith("/options")) {
      st.gets += 1;
      if (loginGets.includes(st.gets)) return res(302, "", { location: `${WWW}/2026/login?L=${L}&URL=x` });
      if (redirectGets.includes(st.gets)) return res(302, "", { location: `${WWW}/` });
      return res(200, abilities(st.lockout));
    }
    throw new Error("unexpected " + url);
  };
  return { fetchImpl, st };
}
const ENV = { MFL_COOKIE: STORED };
const leaks = (obj) => [STORED, FLAG, STORED.slice(0, 10)].some((v) => JSON.stringify(obj).includes(v));

test("a page redirected to '/' after a good switch is retried with a fresh switch and read", async () => {
  const mfl = fakeMfl({ redirectGets: [1] });
  const a = await LK.inspectAbilities(ENV, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  t.equal(a.ok, true, JSON.stringify(a)); t.equal(a.lockout, "No"); t.equal(a.identity, "commissioner");
  t.deepEqual(a.page_attempts, [{ attempt: 1, outcome: "redirected", location_path: "/" }, { attempt: 2, outcome: "ok", location_path: null }]);
  t.equal(mfl.st.switches, 2, "the retry switched afresh");
});

test("redirected on every try → fails after exactly 3 page tries; nothing is submitted", async () => {
  const mfl = fakeMfl({ redirectGets: [1, 2, 3, 4] });
  const r = await LK.setLockout(ENV, { season: SEASON, leagueId: L, on: true, fetchImpl: mfl.fetchImpl });
  t.equal(r.ok, false); t.equal(r.step, "load"); t.equal(r.error, "redirected");
  t.equal(mfl.st.gets, LK.PAGE_ATTEMPTS); t.equal(LK.PAGE_ATTEMPTS, 3);
  t.equal(mfl.st.posts.length, 0, "no write"); t.equal(mfl.st.lockout, "No");
});

test("a login redirect (signed out) is reported at once, not retried", async () => {
  const mfl = fakeMfl({ loginGets: [1] });
  const a = await LK.inspectAbilities(ENV, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  t.equal(a.error, "redirected_to_login"); t.equal(mfl.st.gets, 1); t.equal(a.page_attempts, undefined);
});

test("a lockout change whose check read is redirected is read again before any failure — no false alarm", async () => {
  // GET 1 = setLockout's read, GET 2 = the write's own read, POST, GETs 3-5 = the check read (all turned away), GET 6 = the re-read.
  const mfl = fakeMfl({ redirectGets: [3, 4, 5] });
  const r = await LK.setLockout(ENV, { season: SEASON, leagueId: L, on: true, fetchImpl: mfl.fetchImpl });
  t.equal(r.ok, true, JSON.stringify(r)); t.equal(r.changed, true); t.equal(r.to, "Yes"); t.equal(r.verified_by_reread, true);
  t.equal(mfl.st.posts.length, 1, "exactly one submit"); t.equal(mfl.st.lockout, "Yes");
  t.match(r.digest_after, /^[0-9a-f]{64}$/);
});

test("if the re-read shows the change did not land, it reports failure with the real state", async () => {
  const mfl = fakeMfl({ redirectGets: [3, 4, 5], applyPost: false });
  const r = await LK.setLockout(ENV, { season: SEASON, leagueId: L, on: true, fetchImpl: mfl.fetchImpl });
  t.equal(r.ok, false); t.equal(r.submitted, true); t.match(r.error, /^reload_failed: redirected/);
  t.deepEqual(r.reread, { lockout: "No" }); t.equal(mfl.st.posts.length, 1, "never re-submitted blindly");
});

test("a write whose first read is redirected retries the read, then submits exactly once and verifies", async () => {
  const mfl = fakeMfl({ redirectGets: [1] });
  const r = await LK.setLockout(ENV, { season: SEASON, leagueId: L, on: true, fetchImpl: mfl.fetchImpl });
  t.equal(r.ok, true, JSON.stringify(r)); t.equal(r.verified_by_reread, undefined, "verified by the normal check");
  t.equal(mfl.st.posts.length, 1); t.equal(mfl.st.lockout, "Yes");
  t.equal(mfl.st.posts[0], `MFL_USER_ID=${STORED}; MFL_IS_COMMISH=${FLAG}`, "submitted as commissioner");
});

test("retry diagnostics carry no cookie value", async () => {
  const a = await LK.inspectAbilities(ENV, { season: SEASON, leagueId: L, fetchImpl: fakeMfl({ redirectGets: [1] }).fetchImpl });
  const b = await LK.setLockout(ENV, { season: SEASON, leagueId: L, on: true, fetchImpl: fakeMfl({ redirectGets: [3, 4, 5], applyPost: false }).fetchImpl });
  t.equal(leaks(a), false); t.equal(leaks(b), false);
});

console.error = () => {};
await run("mfl_page_redirect_retry");
