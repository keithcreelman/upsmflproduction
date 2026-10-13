// The worker couldn't open MFL's commissioner setup pages (Keith 2026-10-13).
// HARDENING (confirmed defects, not the cause — Keith's stored value has no "="):
//   1. the MFL_COOKIE format test read "contains =" as "already a header";
//   2. the page reader followed MFL's login redirect, then said "form not found",
//      and scoped forms from "<form" text inside the league's custom-header scripts.
// AUTH CANDIDATE (unconfirmed live): an MFL session starts in OWNER mode; setup
// pages need the commissioner identity (GET logout?L=…&BECOME=0000), which the
// lockout reader never requested.
//   node tests/mfl_cookie_page_reader.test.mjs
//
// Fake MFL only, with made-up cookies. No network call, no real setting.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { readFileSync, readdirSync } from "node:fs";
const { mflCookieHeader, mflCookieShape, sessionIdentity } = await import("../worker/src/mfl_cookie.js");
const LK = await import("../worker/src/mfl_lockout.js");

const L = "25625", SEASON = 2026;
const BARE_WITH_EQUALS = "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v=";   // made-up, base64-like with padding
const BARE_PLAIN = "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vWx";       // made-up
const COMMISH = "commish-session-made-up";

// The league's custom header, as MFL injects it into every page: JS strings that
// contain "<form" and "<input" text (the live page had 3 such openers, no closer).
const CUSTOM_HEADER = `<script>var w='<form action="/2026/search" method="get"><input name="<playerId" value="x">';
  function box(){ return '<form class="hdr"><input type="checkbox" name="HDR_TOGGLE" checked>'; }</script>
  <style>.x{content:"<form>"}</style><!-- <form action="/evil"> -->`;
// MFL's header line, as the read-only waiver workflow logged it (2026-08-21 / 08-22).
const AS_COMMISH = `<div id="auth">Commissioner ( <a href="/logout">Logout</a> | <a href="?BECOME=0001">Become Owner</a> )</div>`;
const AS_OWNER = `<div id="auth">Real Deal Creel ( <a href="/logout">Logout</a> | <a href="?BECOME=0000">Become Commissioner</a> )</div>`;
const abilitiesPage = (lockout = "N") => `<html><head><title>TEST UPS Abilities Setup</title>${CUSTOM_HEADER}</head><body>${AS_COMMISH}
  <form method="POST" action="/2026/options">
    <input type="hidden" name="L" value="${L}"><input type="hidden" name="O" value="93">
    <table><tr><td>Team 0001</td><td><input type="checkbox" name="ABIL_0001_TRADE" value="1" checked></td></tr></table>
    <table><tr><td>Commissioner Lockout:</td><td>
      <input type="radio" name="COMMISH_LOCKOUT" value="N"${lockout === "N" ? " checked" : ""}> No, the commissioner can view pending transactions.<br>
      <input type="radio" name="COMMISH_LOCKOUT" value="Y"${lockout === "Y" ? " checked" : ""}> Yes, the commissioner cannot view them.<br>
    </td></tr></table>
    <input type="submit" name="SAVE" value="SAVE ABILITIES"></form></body></html>`;
const tradesPage = (years = "0") => `<html><head><title>TEST UPS Trades Setup</title>${CUSTOM_HEADER}</head><body>${AS_COMMISH}
  <form method="POST" action="/2026/csetup"><input type="hidden" name="L" value="${L}"><input type="hidden" name="C" value="TRADES">
    Future Draft Pick Trading: <select name="FUTURE_YEARS"><option value="0"${years === "0" ? " selected" : ""}>None</option><option value="1"${years === "1" ? " selected" : ""}>1 year</option></select>
    <input type="submit" name="SAVE" value="Save Trades Setup"></form></body></html>`;
const SIGNED_OUT = `<div id="auth"><a href="/2026/login?L=${L}">Login</a></div>`;   // the live signed-out page showed "Login" links
const accessRequiredPage = (who = "") => `<html><head><title>TEST UPS Trades Setup</title>${CUSTOM_HEADER}</head><body>${who}
  <h2>Trades Setup</h2><h3>Commissioner Access Required.</h3><a href="javascript:history.back()">Go Back To Previous Page</a></body></html>`;

// A fake MFL modeled on the observed behavior: a named MFL_USER_ID for a known account
// is signed in as OWNER; GET logout?L=…&BECOME=0000 answers 302 + Set-Cookie with the
// commissioner session; only the commissioner session gets setup pages.
function fakeMfl({ ownerValue, page }) {
  const calls = [];
  const res = (status, body = "", hdrs = {}) => {
    const h = new Headers();
    for (const [k, v] of Object.entries(hdrs)) for (const x of [].concat(v)) h.append(k, x);
    return { status, headers: h, text: async () => body };
  };
  const fetchImpl = async (url, init = {}) => {
    const cookie = String((init.headers && init.headers.Cookie) || "");
    calls.push({ url: String(url), cookie, redirect: init.redirect, method: init.method || "GET" });
    const has = (v) => cookie.split(/;\s*/).some((c) => c === `MFL_USER_ID=${v}`);
    const u = new URL(String(url));
    if (u.pathname.endsWith("/logout") && u.searchParams.get("BECOME") === "0000") {
      if (!has(ownerValue) && !has(COMMISH)) return res(302, "", { location: `/2026/login?L=${L}` });
      return res(302, "", { location: `/2026/home/${L}`, "set-cookie": [`MFL_USER_ID=${COMMISH}; path=/; domain=.myfantasyleague.com`, "MFL_IS_COMMISH=1; path=/"] });
    }
    const commish = has(COMMISH), owner = has(ownerValue);
    if (u.pathname.endsWith("/login")) return res(200, `<html><head><title>TEST UPS Login</title></head><body>${SIGNED_OUT}<form method="POST" action="/2026/login"><input type="password" name="PASSWORD"></form></body></html>`);
    if (u.pathname.endsWith(`/home/${L}`)) return res(200, `<html><body>${commish ? AS_COMMISH : owner ? AS_OWNER : SIGNED_OUT}<h1>TEST UPS</h1></body></html>`);
    if (u.pathname.endsWith("/options") && !commish) return res(302, "", { location: `https://www48.myfantasyleague.com/2026/login?L=${L}&URL=x` });
    if (u.pathname.endsWith("/csetup") && !commish) return res(200, accessRequiredPage(owner ? AS_OWNER : SIGNED_OUT));
    return res(200, page(u));
  };
  return { fetchImpl, calls };
}
const pageFor = (u) => (u.pathname.endsWith("/csetup") ? tradesPage() : abilitiesPage());
const leaks = (obj, ...values) => values.some((v) => JSON.stringify(obj).includes(v));

// ═══════════════════════════════ HARDENING ═══════════════════════════════

test("hardening: cookie header — a bare value is always sent with its name, even when it contains '='", () => {
  t.equal(mflCookieHeader(BARE_WITH_EQUALS), `MFL_USER_ID=${BARE_WITH_EQUALS}`, "the old rule sent this with no name");
  t.equal(mflCookieHeader(BARE_PLAIN), `MFL_USER_ID=${BARE_PLAIN}`);
  t.equal(mflCookieHeader(`MFL_USER_ID=${BARE_WITH_EQUALS}`), `MFL_USER_ID=${BARE_WITH_EQUALS}`, "a full fragment is kept as is");
  t.equal(mflCookieHeader(`  Cookie: MFL_USER_ID=${BARE_PLAIN} `), `MFL_USER_ID=${BARE_PLAIN}`, "a pasted 'Cookie:' prefix and spaces are dropped");
  t.equal(mflCookieHeader(`MFL_LAST_LEAGUE_ID=1; MFL_USER_ID=${BARE_PLAIN}`), `MFL_LAST_LEAGUE_ID=1; MFL_USER_ID=${BARE_PLAIN}`, "several cookies: kept");
  t.equal(mflCookieHeader(""), ""); t.equal(mflCookieHeader(null), "");
  t.equal(mflCookieHeader("a%3D"), "MFL_USER_ID=a%3D", "never re-encoded or decoded");
});

test("hardening: cookie shape — reports format and a fingerprint, never the value", async () => {
  const s = await mflCookieShape(BARE_WITH_EQUALS);
  t.equal(s.present, true); t.equal(s.stored_as, "bare_value"); t.equal(s.value_contains_equals, true);
  t.equal(s.old_rule_would_send_cookie_name, false, "the shape the old rule broke");
  t.match(s.sha256_12, /^[0-9a-f]{12}$/);
  t.equal(leaks(s, BARE_WITH_EQUALS, BARE_WITH_EQUALS.slice(0, 8)), false, "neither the value nor a prefix of it appears");
  t.equal((await mflCookieShape(`MFL_USER_ID=${BARE_WITH_EQUALS}`)).sha256_12, s.sha256_12, "bare and fragment forms fingerprint the same value");
  t.equal((await mflCookieShape(BARE_PLAIN)).old_rule_would_send_cookie_name, true, "a value without '=' was always sent correctly");
  t.deepEqual(await mflCookieShape(""), { present: false });
});

test("hardening: no worker file builds the MFL session header with the old 'contains =' rule any more", () => {
  const dir = new URL("../worker/src/", import.meta.url);
  const offenders = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    readFileSync(new URL(f, dir), "utf8").split("\n").forEach((line, i) => {
      if (/includes\("="\)\s*\?\s*\w+\s*:\s*(`MFL_USER_ID=|\("MFL_USER_ID=")/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  t.deepEqual(offenders, []);
});

test("hardening: signed out — Abilities reads as 'redirected_to_login' and Trades as 'commissioner_access_required', not 'form not found'", async () => {
  const mfl = fakeMfl({ ownerValue: "some-other-account", page: pageFor });
  const a = await LK.inspectAbilities({ MFL_COOKIE: BARE_PLAIN }, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  t.equal(a.ok, false); t.equal(a.error, "redirected_to_login"); t.equal(a.http, 302); t.equal(a.location_path, "/2026/login");
  const tr = await LK.snapshotPage({ MFL_COOKIE: BARE_PLAIN }, { season: SEASON, leagueId: L, page: "trades", fetchImpl: mfl.fetchImpl });
  t.equal(tr.ok, false); t.equal(tr.error, "commissioner_access_required"); t.equal(tr.identity, "signed_out");
  t.deepEqual(a.identity_before, { http: 200, identity: "signed_out" }, "an unknown session reads as signed out before the switch");
  t.deepEqual(a.elevation.set_cookie_names, [], "the switch returned no session cookie");
  t.equal(a.elevation.identity_after_switch, "signed_out", "…and landed on the login page");
  t.ok(mfl.calls.every((c) => c.method === "GET" && c.redirect === "manual"), "nothing submitted, no redirect followed blindly");
});

test("hardening: the league's custom-header scripts never become the form — real action, method and fields only", () => {
  const p = LK.parseAbilitiesPage(abilitiesPage("Y"));
  t.equal(p.ok, true, JSON.stringify(p));
  t.equal(p.form.action, "/2026/options"); t.equal(p.form.method, "POST");
  t.deepEqual(p.form.fields.map(([k]) => k), ["L", "O", "ABIL_0001_TRADE", "COMMISH_LOCKOUT", "SAVE"]);
  t.equal(p.lockout.current, "Yes");
  const naive = [...abilitiesPage("Y").matchAll(/<form\b[\s\S]*?<\/form>/gi)].map((m) => m[0]);
  t.match(naive[0], /^<form action="\/2026\/search" method="get">/, "the old scoping started at the script's fake form");
});

test("hardening: Trades Setup — the real form is found through the custom header", async () => {
  const mfl = fakeMfl({ ownerValue: BARE_PLAIN, page: pageFor });
  const r = await LK.snapshotPage({ MFL_COOKIE: BARE_PLAIN }, { season: SEASON, leagueId: L, page: "trades", fetchImpl: mfl.fetchImpl });
  t.equal(r.ok, true, JSON.stringify(r));
  t.equal(r.method, "POST", "the real form's method, not the script's GET");
  t.deepEqual(r.fields.map(([k]) => k), ["L", "C", "FUTURE_YEARS", "SAVE"], "real fields only");
});

// ═════════════════════ AUTH CANDIDATE (unconfirmed live) ═════════════════════

test("auth candidate: the owner session alone is refused; after BECOME=0000 the commissioner session reads both setup pages", async () => {
  const mfl = fakeMfl({ ownerValue: BARE_PLAIN, page: pageFor });
  const directA = await mfl.fetchImpl(LK.abilitiesUrl(SEASON, L), { headers: { Cookie: `MFL_USER_ID=${BARE_PLAIN}` }, redirect: "manual" });
  t.equal(directA.status, 302, "what the old reader did: owner → Abilities redirects to login");
  const directT = await mfl.fetchImpl(`https://www48.myfantasyleague.com/2026/csetup?L=${L}&C=TRADES`, { headers: { Cookie: `MFL_USER_ID=${BARE_PLAIN}` } });
  t.match(await directT.text(), /Commissioner Access Required/, "owner → Trades Setup says Commissioner Access Required");
  mfl.calls.length = 0;
  const a = await LK.inspectAbilities({ MFL_COOKIE: BARE_PLAIN }, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  t.equal(a.ok, true, JSON.stringify(a));
  t.deepEqual(a.identity_before, { http: 200, identity: "owner" }, "before the switch MFL serves the stored session as the owner");
  t.equal(a.elevation.identity_after_switch, "commissioner"); t.equal(a.identity, "commissioner", "the Abilities page was served to the commissioner");
  t.deepEqual(a.elevation.set_cookie_names, ["MFL_USER_ID", "MFL_IS_COMMISH"]); t.equal(a.elevation.hops, 2); t.equal(a.elevation.user_id_changed, true);
  t.deepEqual(a.elevation.set_cookies.map((c) => [c.name, c.length]), [["MFL_USER_ID", COMMISH.length], ["MFL_IS_COMMISH", 1]]);
  t.ok(a.elevation.set_cookies.every((c) => /^[0-9a-f]{12}$/.test(c.sha256_12)), "fingerprints only");
  t.match(mfl.calls[0].url, /\/2026\/home\/25625$/, "first a plain read of the league home page as stored");
  t.match(mfl.calls[1].url, /\/2026\/logout\?L=25625&BECOME=0000$/, "then the switch, for the same league");
  t.match(mfl.calls.at(-1).cookie, new RegExp(`MFL_USER_ID=${COMMISH}`), "the page is read as commissioner");
  t.equal(leaks(a, BARE_PLAIN, COMMISH), false, "no session value in the result");
  const tr = await LK.snapshotPage({ MFL_COOKIE: BARE_PLAIN }, { season: SEASON, leagueId: L, page: "trades", fetchImpl: mfl.fetchImpl });
  t.equal(tr.ok, true, JSON.stringify(tr)); t.equal(leaks(tr, BARE_PLAIN, COMMISH), false);
});

test("auth candidate: a save uses the commissioner session for load, submit and verify; the stored secret is never rewritten", async () => {
  const env = { MFL_COOKIE: BARE_PLAIN };
  const st = { years: "0" };
  const base = fakeMfl({ ownerValue: BARE_PLAIN, page: (u) => (u.pathname.endsWith("/csetup") ? tradesPage(st.years) : abilitiesPage()) });
  const posts = [];
  const fetchImpl = async (url, init = {}) => {
    if ((init.method || "GET") === "POST") {
      posts.push(String(init.headers.Cookie)); st.years = new URLSearchParams(init.body).get("FUTURE_YEARS");
      return { status: 200, headers: new Headers(), text: async () => "ok" };
    }
    return base.fetchImpl(url, init);
  };
  const r = await LK.setPageFields(env, { season: SEASON, leagueId: L, page: "trades", changes: { FUTURE_YEARS: "1" }, fetchImpl });
  t.equal(r.ok, true, JSON.stringify(r)); t.deepEqual(r.after, [["FUTURE_YEARS", "1"]]);
  t.equal(posts.length, 1); t.match(posts[0], new RegExp(`MFL_USER_ID=${COMMISH}`), "submitted as commissioner");
  t.equal(env.MFL_COOKIE, BARE_PLAIN, "the stored secret is untouched");
  t.equal(leaks(r, BARE_PLAIN, COMMISH), false, "no session value in the result");
});

test("auth candidate: page identity is read from MFL's header line, never from script text", () => {
  t.equal(sessionIdentity(abilitiesPage()), "commissioner");
  t.equal(sessionIdentity(accessRequiredPage(AS_OWNER)), "owner");
  t.equal(sessionIdentity(`<a href="/login">Login</a>`), "signed_out");
  t.equal(sessionIdentity(`<script>x='Become Owner'</script><a>Login</a>`), "signed_out");
});

console.error = () => {};
await run("mfl_cookie_page_reader");
