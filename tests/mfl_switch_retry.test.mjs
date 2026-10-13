// MFL's commissioner switch (GET logout?L=…&BECOME=0000) INTERMITTENTLY logs the
// session out: hop 2 answers `MFL_USER_ID=; Domain=.myfantasyleague.com; Path=/;
// Expires=<now>` (seen 2026-10-13, about 2 of 6 switches); the very next switch works.
// The worker now retries a logged-out switch from a fresh start, at most 3 attempts in
// all, and still fails closed if every attempt is logged out (Keith 2026-10-13).
//   node tests/mfl_switch_retry.test.mjs
//
// Fake MFL only, made-up values. No network call.
import { t, test, run } from "./fixtures/mini_test.mjs";
const C = await import("../worker/src/mfl_cookie.js");
const LK = await import("../worker/src/mfl_lockout.js");

const L = "25625", SEASON = 2026;
const WWW = "https://www48.myfantasyleague.com";
const STORED = "aB3dE5fG7hJ9kL1mN3pQ5r%2BT9vW";   // made-up, 28 chars
const FLAG = "commishflag-made-up-26chrs";          // made-up, 26 chars
const NOW = () => new Date().toUTCString();
const AS_COMMISH = `<div>Commissioner ( <a>Logout</a> | <a>Become Owner</a> )</div>`;
const AS_OWNER = `<div>Real Deal Creel ( <a>Logout</a> | <a>Become Commissioner</a> )</div>`;
const abilities = (lockout = "N") => `<html><body>${AS_COMMISH}<form method="POST" action="owner_abilities_setup"><input type="hidden" name="L" value="${L}">
  <input type="checkbox" name="FDP_TRADES0001" value="1" checked>
  <table><tr><td>Commissioner Lockout:</td><td><input type="radio" name="LOCKOUT" value="N"${lockout === "N" ? " checked" : ""}> No, can view.<br>
  <input type="radio" name="LOCKOUT" value="Y"${lockout === "Y" ? " checked" : ""}> Yes, cannot view.<br></td></tr></table><input type="submit" name="SAVE" value="SAVE ABILITIES"></form></body></html>`;

// plan: one entry per switch attempt — "logout" (hop 2 deletes the session) or "keep".
function fakeMfl(plan, { lockout = "N" } = {}) {
  const calls = [], posts = [];
  let switches = 0;
  const state = { lockout };
  const res = (status, body = "", hdrs = {}) => {
    const h = new Headers();
    for (const [k, v] of Object.entries(hdrs)) for (const x of [].concat(v)) h.append(k, x);
    return { status, headers: h, text: async () => body };
  };
  const fetchImpl = async (url, init = {}) => {
    const cookie = String((init.headers && init.headers.Cookie) || "");
    const u = new URL(String(url));
    calls.push({ path: u.pathname, cookie, method: init.method || "GET" });
    const sent = cookie.split(/;\s*/).filter(Boolean);
    const first = (n) => { const c = sent.find((x) => x.startsWith(`${n}=`)); return c ? c.slice(n.length + 1) : null; };
    if (u.pathname.endsWith("/logout")) {
      switches += 1;
      return res(302, "", { location: `/2026/home/${L}`, "set-cookie": `MFL_IS_COMMISH=${FLAG}; Domain=.myfantasyleague.com; Path=/; Expires=Tue, 11-May-2027 16:00:00 GMT` });
    }
    if (u.pathname.endsWith(`/home/${L}`)) {
      if (!first("MFL_IS_COMMISH")) return res(200, `<html><body>${first("MFL_USER_ID") ? AS_OWNER : "<a>Login</a>"}</body></html>`);   // before any switch
      if ((plan[switches - 1] || "keep") === "logout") {
        return res(302, "", { location: "/", "set-cookie": [`MFL_USER_ID=; Domain=.myfantasyleague.com; Path=/; Expires=${NOW()}`, `MFL_USER_SETTINGS=; Domain=.myfantasyleague.com; Path=/; Expires=${NOW()}`] });
      }
      return res(200, `<html><body>${AS_COMMISH}</body></html>`);
    }
    const commish = first("MFL_USER_ID") === STORED && first("MFL_IS_COMMISH") === FLAG;
    if (u.pathname.endsWith("/options") || u.pathname.endsWith("/owner_abilities_setup")) {
      if (!commish) return res(302, "", { location: `${WWW}/2026/login?L=${L}` });
      if ((init.method || "GET") === "POST") { posts.push(cookie); state.lockout = new URLSearchParams(init.body).get("LOCKOUT"); return res(200, "saved"); }
      return res(200, abilities(state.lockout));
    }
    throw new Error("unexpected " + url);
  };
  return { fetchImpl, calls, posts, switches: () => switches, state };
}
const leaks = (obj, ...vals) => vals.some((v) => JSON.stringify(obj).includes(v));

test("the switch logs the session out once, then holds: a fresh second switch reads the page as commissioner", async () => {
  const mfl = fakeMfl(["logout", "keep"]);
  const a = await LK.inspectAbilities({ MFL_COOKIE: STORED }, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  t.equal(a.ok, true, JSON.stringify(a)); t.equal(a.identity, "commissioner"); t.equal(a.lockout, "No");
  t.deepEqual(a.elevation.attempts.map((x) => [x.attempt, x.outcome]), [[1, "switch_deleted_session"], [2, "ok"]]);
  t.deepEqual(a.elevation.attempts[0].hop_log, [{ hop: 1, path: "/2026/logout", status: 302, location_path: `/2026/home/${L}` }, { hop: 2, path: `/2026/home/${L}`, status: 302, location_path: "/" }],
    "where MFL sent the logged-out attempt — paths only");
  t.deepEqual(a.elevation.session_cookie, { domain: "myfantasyleague.com", host_only: false, path: "/", survived: true });
  t.equal(mfl.switches(), 2);
  const read = mfl.calls.find((c) => c.path.endsWith("/options"));
  t.equal(read.cookie, `MFL_USER_ID=${STORED}; MFL_IS_COMMISH=${FLAG}`, "the page is read with the session and the flag");
});

test("every attempt logged out → fails closed after exactly 3 switches; the page is never requested", async () => {
  const mfl = fakeMfl(["logout", "logout", "logout", "keep"]);
  const slept = [];
  const r = await C.becomeCommissioner(`MFL_USER_ID=${STORED}`, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl, sleepImpl: async (ms) => slept.push(ms) });
  t.equal(r.ok, false); t.equal(r.error, "switch_deleted_session"); t.equal(r.cookieFor, undefined);
  t.equal(r.session_cookie.survived, false);
  t.equal(r.attempts.length, C.SWITCH_ATTEMPTS); t.equal(C.SWITCH_ATTEMPTS, 3);
  t.ok(r.attempts.every((x) => x.outcome === "switch_deleted_session"));
  t.deepEqual(slept, [C.SWITCH_RETRY_DELAY_MS, C.SWITCH_RETRY_DELAY_MS], "a short pause before each retry");
  const mfl2 = fakeMfl(["logout", "logout", "logout"]);
  const a = await LK.inspectAbilities({ MFL_COOKIE: STORED }, { season: SEASON, leagueId: L, fetchImpl: mfl2.fetchImpl });
  t.equal(a.error, "switch_deleted_session"); t.equal(mfl2.switches(), 3);
  t.equal(mfl2.calls.filter((c) => c.path.endsWith("/options")).length, 0);
});

test("each retry starts from a fresh jar: its first request carries the stored session again", async () => {
  const mfl = fakeMfl(["logout", "keep"]);
  const r = await C.becomeCommissioner(`MFL_USER_ID=${STORED}`, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl, sleepImpl: async () => {} });
  t.equal(r.ok, true, JSON.stringify(r));
  const switchCalls = mfl.calls.filter((c) => c.path.endsWith("/logout"));
  t.equal(switchCalls.length, 2);
  t.equal(switchCalls[1].cookie, `MFL_USER_ID=${STORED}`, "the retry is not carrying the deleted state forward");
  t.equal(r.cookieFor(`${WWW}/2026/options?L=${L}&O=93`), `MFL_USER_ID=${STORED}; MFL_IS_COMMISH=${FLAG}`);
});

test("only a logged-out switch is retried — a network failure is reported at once", async () => {
  let n = 0;
  const r = await C.becomeCommissioner(`MFL_USER_ID=${STORED}`, { season: SEASON, leagueId: L, sleepImpl: async () => {},
    fetchImpl: async () => { n += 1; throw new Error("network down"); } });
  t.equal(r.ok, false); t.match(r.error, /^become_failed: network down/); t.equal(n, 1); t.equal(r.attempts.length, 1);
});

test("a settings write retries the switch too, then submits once as commissioner and verifies", async () => {
  const mfl = fakeMfl(["logout", "keep"]);
  const r = await LK.setLockout({ MFL_COOKIE: STORED }, { season: SEASON, leagueId: L, on: true, fetchImpl: mfl.fetchImpl });
  t.equal(r.ok, true, JSON.stringify(r)); t.equal(r.changed, true); t.equal(mfl.state.lockout, "Y");
  t.equal(mfl.posts.length, 1, "exactly one submit");
  t.equal(mfl.posts[0], `MFL_USER_ID=${STORED}; MFL_IS_COMMISH=${FLAG}`, "submitted as commissioner");
});

test("retry diagnostics carry no cookie value", async () => {
  const mfl = fakeMfl(["logout", "keep"]);
  const a = await LK.inspectAbilities({ MFL_COOKIE: STORED }, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  const b = await C.becomeCommissioner(`MFL_USER_ID=${STORED}`, { season: SEASON, leagueId: L, fetchImpl: fakeMfl(["logout", "logout", "logout"]).fetchImpl, sleepImpl: async () => {} });
  t.equal(leaks(a, STORED, FLAG, STORED.slice(0, 10)), false);
  t.equal(leaks(b, STORED, FLAG, STORED.slice(0, 10)), false);
  t.ok(a.elevation.attempts.every((x) => x.hop_log.every((h) => !/[?&=]/.test(h.path + (h.location_path || "")))), "paths carry no query string");
});

console.error = () => {};
await run("mfl_switch_retry");
