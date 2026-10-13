// The commissioner switch (GET logout?L=…&BECOME=0000) answered with an EMPTY
// MFL_USER_ID Set-Cookie; merging cookies by name alone wiped the session (live check,
// Keith 2026-10-13). The worker now keeps a browser-faithful jar: name + domain +
// host-only flag + path, empty/expired cookies applied only to their exact scope, and
// fails closed if the switch deletes the cookie that signed the session in.
//   node tests/mfl_cookie_jar.test.mjs
//
// Fake MFL only, made-up values. No network call.
import { t, test, run } from "./fixtures/mini_test.mjs";
const C = await import("../worker/src/mfl_cookie.js");
const LK = await import("../worker/src/mfl_lockout.js");

const L = "25625", SEASON = 2026;
const WWW = "https://www48.myfantasyleague.com";
const STORED = "aB3dE5fG7hJ9kL1mN3pQ5r%2BT9vW";   // made-up, 28 chars, a %-escape like the real one
const FLAG = "commishflag-made-up-26chrs";          // made-up, 26 chars
const PAST = "Thu, 01 Jan 1970 00:00:00 GMT";
const BECOME = `${WWW}/2026/logout?L=${L}&BECOME=0000`;
const ABIL = `${WWW}/2026/options?L=${L}&O=93`;

const AS_COMMISH = `<div>Commissioner ( <a>Logout</a> | <a>Become Owner</a> )</div>`;
const AS_OWNER = `<div>Real Deal Creel ( <a>Logout</a> | <a>Become Commissioner</a> )</div>`;
const abilities = `<html><body>${AS_COMMISH}<form method="POST" action="/2026/options"><input type="hidden" name="L" value="${L}"><input type="hidden" name="O" value="93">
  <table><tr><td>Commissioner Lockout:</td><td><input type="radio" name="COMMISH_LOCKOUT" value="N" checked> No, can view.<br>
  <input type="radio" name="COMMISH_LOCKOUT" value="Y"> Yes, cannot view.<br></td></tr></table><input type="submit" name="SAVE" value="SAVE ABILITIES"></form></body></html>`;

// A fake MFL: the switch replies with `switchCookies` (raw Set-Cookie lines) and a 302 to
// the league home; a page is served to whoever carries the stored session AND the flag.
function fakeMfl(switchCookies) {
  const calls = [];
  const res = (status, body = "", hdrs = {}) => {
    const h = new Headers();
    for (const [k, v] of Object.entries(hdrs)) for (const x of [].concat(v)) h.append(k, x);
    return { status, headers: h, text: async () => body };
  };
  const fetchImpl = async (url, init = {}) => {
    const cookie = String((init.headers && init.headers.Cookie) || "");
    calls.push({ url: String(url), cookie });
    const u = new URL(String(url));
    const sent = cookie.split(/;\s*/).filter(Boolean);
    const first = (n) => { const c = sent.find((x) => x.startsWith(`${n}=`)); return c ? c.slice(n.length + 1) : null; };
    if (u.pathname.endsWith("/logout")) return res(302, "", { location: `/2026/home/${L}`, "set-cookie": switchCookies });
    if (u.pathname.endsWith(`/home/${L}`)) return res(200, `<html><body>${first("MFL_IS_COMMISH") ? AS_COMMISH : first("MFL_USER_ID") ? AS_OWNER : "<a>Login</a>"}</body></html>`);
    if (u.pathname.endsWith("/options")) {
      return first("MFL_USER_ID") === STORED && first("MFL_IS_COMMISH") === FLAG ? res(200, abilities) : res(302, "", { location: `${WWW}/2026/login?L=${L}` });
    }
    throw new Error("unexpected " + url);
  };
  return { fetchImpl, calls };
}
const flagLine = `MFL_IS_COMMISH=${FLAG}; Domain=.myfantasyleague.com; Path=/`;
const leaks = (obj, ...vals) => vals.some((v) => JSON.stringify(obj).includes(v));

test("1. the parent-domain session survives the switch deleting a host-specific duplicate", async () => {
  // The switch's empty MFL_USER_ID carries no Domain → it targets the www48 host-only copy.
  const mfl = fakeMfl([`MFL_USER_ID=; Path=/; Expires=${PAST}`, flagLine]);
  const r = await C.becomeCommissioner(`MFL_USER_ID=${STORED}`, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  t.equal(r.ok, true, JSON.stringify(r));
  t.deepEqual(r.session_cookie, { domain: "myfantasyleague.com", host_only: false, path: "/", survived: true });
  const del = r.set_cookies.find((e) => e.name === "MFL_USER_ID");
  t.deepEqual([del.host_only, del.scope_domain, del.scope_path, del.expires_attr, del.action], [true, "www48.myfantasyleague.com", "/", PAST, "expired_no_matching_cookie"]);
  t.equal(r.cookieFor(ABIL), `MFL_USER_ID=${STORED}; MFL_IS_COMMISH=${FLAG}`);
  // And when a host-only duplicate really exists, only that copy goes.
  const jar = C.createCookieJar();
  jar.seed("MFL_USER_ID", STORED);
  jar.seed("MFL_USER_ID", "stale-host-copy", { domain: "www48.myfantasyleague.com", hostOnly: true, path: "/" });
  t.equal(jar.apply(`MFL_USER_ID=; Path=/; Max-Age=0`, BECOME).action, "deleted");
  t.equal(jar.header(ABIL), `MFL_USER_ID=${STORED}`);
});

test("2. a host-specific session survives the switch deleting a parent-domain duplicate", async () => {
  const jar = C.createCookieJar();
  const HOST = { domain: "www48.myfantasyleague.com", hostOnly: true, path: "/" };
  jar.seed("MFL_USER_ID", "stale-parent-copy");          // parent-domain duplicate
  jar.seed("MFL_USER_ID", STORED, HOST);                  // the session, host-only
  const ev = jar.apply(`MFL_USER_ID=; Domain=.myfantasyleague.com; Path=/; Max-Age=0`, BECOME);
  t.deepEqual([ev.action, ev.host_only, ev.domain_attr, ev.max_age_attr], ["deleted", false, ".myfantasyleague.com", "0"]);
  t.equal(jar.header(ABIL), `MFL_USER_ID=${STORED}`);
  // Through the switch, with the stored session held host-only.
  const mfl = fakeMfl([`MFL_USER_ID=; Domain=.myfantasyleague.com; Path=/; Max-Age=0`, flagLine]);
  const r = await C.becomeCommissioner(`MFL_USER_ID=${STORED}`, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl, sessionScope: HOST });
  t.equal(r.ok, true, JSON.stringify(r)); t.equal(r.session_cookie.survived, true);
  t.equal(r.cookieFor(ABIL), `MFL_USER_ID=${STORED}; MFL_IS_COMMISH=${FLAG}`);
});

test("3. deleting the cookie that actually signed the session in fails closed — no page is read", async () => {
  for (const line of [`MFL_USER_ID=; Domain=.myfantasyleague.com; Path=/; Expires=${PAST}`,   // expired, exact scope
                      `MFL_USER_ID=; Domain=.myfantasyleague.com; Path=/; Max-Age=-1`,
                      `MFL_USER_ID=; Domain=.myfantasyleague.com; Path=/`]) {               // emptied, exact scope
    const mfl = fakeMfl([line, flagLine]);
    const r = await C.becomeCommissioner(`MFL_USER_ID=${STORED}`, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
    t.equal(r.ok, false, line); t.equal(r.error, "switch_deleted_session");
    t.equal(r.session_cookie.survived, false); t.equal(r.cookieFor, undefined, "no header builder is handed out");
    const a = await LK.inspectAbilities({ MFL_COOKIE: STORED }, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
    t.equal(a.error, "switch_deleted_session");
    t.equal(mfl.calls.filter((c) => c.url.includes("/options")).length, 0, "the Abilities page is never requested");
  }
});

test("4. the commissioner flag is added for the call only — the stored secret is never replaced or shown", async () => {
  const env = { MFL_COOKIE: STORED };
  const mfl = fakeMfl([`MFL_USER_ID=; Path=/; Expires=${PAST}`, flagLine]);
  const a = await LK.inspectAbilities(env, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  t.equal(a.ok, true, JSON.stringify(a)); t.equal(a.lockout, "No");
  t.deepEqual(a.identity_before, { http: 200, identity: "owner" });
  t.equal(a.identity, "commissioner");
  t.equal(env.MFL_COOKIE, STORED, "the stored secret is unchanged");
  const abil = mfl.calls.find((c) => c.url.includes("/options"));
  t.equal(abil.cookie, `MFL_USER_ID=${STORED}; MFL_IS_COMMISH=${FLAG}`, "the session plus the flag, in browser order");
  t.equal(leaks(a, STORED, FLAG), false, "neither value is in the result");
  const flag = a.elevation.set_cookies.find((e) => e.name === "MFL_IS_COMMISH");
  t.deepEqual([flag.value_length, flag.domain_attr, flag.path_attr, flag.action], [26, ".myfantasyleague.com", "/", "added"]);
  t.match(flag.sha256_12, /^[0-9a-f]{12}$/);
});

test("5. duplicate names go out in browser order: longer path first, then oldest first; scope decides who gets what", () => {
  const jar = C.createCookieJar();
  jar.seed("MFL_USER_ID", "parent-root");                                         // oldest
  jar.apply("MFL_USER_ID=host-2026; Path=/2026", `${WWW}/2026/home/${L}`);         // host-only, longer path
  jar.apply("MFL_USER_ID=host-root; Path=/", `${WWW}/2026/home/${L}`);             // host-only, same path, newer
  t.equal(jar.header(ABIL), "MFL_USER_ID=host-2026; MFL_USER_ID=parent-root; MFL_USER_ID=host-root");
  t.equal(jar.header("https://www48.myfantasyleague.com/2027/home/1"), "MFL_USER_ID=parent-root; MFL_USER_ID=host-root", "/2026 copy stays in its path");
  t.equal(jar.header("https://api.myfantasyleague.com/2026/export"), "MFL_USER_ID=parent-root", "host-only copies stay on www48");
  t.equal(jar.header("https://www48.myfantasyleague.com/2026x"), "MFL_USER_ID=parent-root; MFL_USER_ID=host-root", "/2026 does not path-match /2026x");
  // Replacing in the exact scope keeps the cookie's place (creation order).
  t.equal(jar.apply("MFL_USER_ID=parent-new; Domain=myfantasyleague.com; Path=/", ABIL).action, "replaced");
  t.equal(jar.header(ABIL), "MFL_USER_ID=host-2026; MFL_USER_ID=parent-new; MFL_USER_ID=host-root");
  t.equal(jar.apply("X=1; Domain=example.com", ABIL).action, "rejected_domain_mismatch", "a foreign domain is refused, as a browser would");
});

test("6. no cookie value ever appears in a result or a log line", async () => {
  const seen = [];
  const keep = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  for (const k of Object.keys(keep)) console[k] = (...a) => seen.push(a.map(String).join(" "));
  const results = [];
  try {
    for (const lines of [[`MFL_USER_ID=; Path=/; Expires=${PAST}`, flagLine], [`MFL_USER_ID=; Domain=.myfantasyleague.com; Path=/; Max-Age=0`, flagLine]]) {
      const mfl = fakeMfl(lines);
      results.push(await LK.inspectAbilities({ MFL_COOKIE: STORED }, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl }));
      const b = await C.becomeCommissioner(`MFL_USER_ID=${STORED}`, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
      const { cookieFor, ...safe } = b; results.push(safe);
      results.push(await LK.snapshotPage({ MFL_COOKIE: STORED }, { season: SEASON, leagueId: L, page: "abilities", fetchImpl: mfl.fetchImpl }));
    }
    results.push(await C.mflCookieShape(STORED));
  } finally { Object.assign(console, keep); }
  t.equal(results.some((r) => leaks(r, STORED, FLAG, STORED.slice(0, 10))), false, "no value or value prefix in any result");
  t.equal(seen.some((line) => line.includes(STORED) || line.includes(FLAG)), false, "no value in any log line");
});

test("review fix: a secret holding MFL_USER_ID twice is refused (a deletion couldn't be judged); seeding one scope twice keeps one copy", async () => {
  const mfl = fakeMfl([`MFL_USER_ID=; Domain=.myfantasyleague.com; Path=/; Max-Age=0`, flagLine]);
  const r = await C.becomeCommissioner(`MFL_USER_ID=${STORED}; MFL_USER_ID=other-made-up`, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  t.equal(r.ok, false); t.equal(r.error, "ambiguous_session_cookie"); t.equal(r.cookieFor, undefined);
  t.equal(mfl.calls.length, 0, "nothing is requested");
  const a = await LK.inspectAbilities({ MFL_COOKIE: `MFL_USER_ID=${STORED}; MFL_USER_ID=other-made-up` }, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  t.equal(a.error, "ambiguous_session_cookie");
  t.equal(mfl.calls.filter((c) => c.url.includes("/options")).length, 0);
  const jar = C.createCookieJar();
  jar.seed("MFL_USER_ID", "first"); jar.seed("MFL_USER_ID", "second");
  t.equal(jar.header(ABIL), "MFL_USER_ID=second", "one cookie per scope, as in a browser");
  t.equal(jar.apply(`MFL_USER_ID=; Domain=.myfantasyleague.com; Path=/; Max-Age=0`, BECOME).action, "deleted");
  t.equal(jar.find("MFL_USER_ID", C.SESSION_SCOPE), null, "a deletion leaves no second copy behind");
});

test("review fix: an empty, non-expiring host-only copy keeps the session, and goes first on /2026 pages exactly as a browser sends it", async () => {
  // No Domain, no Path, no Expires from /2026/logout → www48-only, default path /2026.
  const mfl = fakeMfl([`MFL_USER_ID=`, flagLine]);
  const r = await C.becomeCommissioner(`MFL_USER_ID=${STORED}`, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  t.equal(r.ok, true, JSON.stringify(r)); t.equal(r.session_cookie.survived, true);
  const ev = r.set_cookies.find((e) => e.name === "MFL_USER_ID");
  t.deepEqual([ev.host_only, ev.scope_domain, ev.scope_path, ev.expires_attr, ev.max_age_attr, ev.action, ev.value_length], [true, "www48.myfantasyleague.com", "/2026", null, null, "added", 0]);
  t.equal(r.cookieFor(ABIL), `MFL_USER_ID=; MFL_USER_ID=${STORED}; MFL_IS_COMMISH=${FLAG}`, "longer path first — what Chrome would send");
  t.equal(r.cookieFor("https://api.myfantasyleague.com/2026/export"), `MFL_USER_ID=${STORED}; MFL_IS_COMMISH=${FLAG}`, "the host-only copy stays on www48");
});

test("review fix: a session cookie that has already expired counts as deleted", () => {
  let clock = 1_000_000;
  const jar = C.createCookieJar({ now: () => clock });
  jar.seed("MFL_USER_ID", STORED);
  jar.apply(`MFL_USER_ID=${STORED}; Domain=.myfantasyleague.com; Path=/; Max-Age=5`, BECOME);
  t.ok(jar.find("MFL_USER_ID", C.SESSION_SCOPE));
  clock += 10_000;
  t.equal(jar.find("MFL_USER_ID", C.SESSION_SCOPE), null); t.equal(jar.header(ABIL), "");
});

console.error = () => {};
await run("mfl_cookie_jar");
