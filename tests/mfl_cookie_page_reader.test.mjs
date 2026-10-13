// Why the worker couldn't open MFL's commissioner setup pages (Keith 2026-10-13):
//   1. the MFL_COOKIE secret's format test — "contains =" was read as "already a
//      header", but MFL_USER_ID values can contain "=", so a bare value went out
//      with no cookie name and MFL treated the worker as signed out;
//   2. the page reader followed MFL's login redirect and then reported "form not
//      found", and it scoped forms from "<form" text inside the league's
//      custom-header scripts.
//   node tests/mfl_cookie_page_reader.test.mjs
//
// Fake MFL only, with made-up cookies. No network call, no real setting.
import { t, test, run } from "./fixtures/mini_test.mjs";
import { readFileSync, readdirSync } from "node:fs";
const { mflCookieHeader, mflCookieShape } = await import("../worker/src/mfl_cookie.js");
const LK = await import("../worker/src/mfl_lockout.js");

const L = "25625", SEASON = 2026;
const BARE_WITH_EQUALS = "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9v=";   // made-up, base64-like with padding
const BARE_PLAIN = "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vWx";

// The league's custom header, as MFL injects it into every page: JS strings that
// contain "<form" and "<input" text (the live page had 3 such openers, no closer).
const CUSTOM_HEADER = `<script>var w='<form action="/2026/search" method="get"><input name="<playerId" value="x">';
  function box(){ return '<form class="hdr"><input type="checkbox" name="HDR_TOGGLE" checked>'; }</script>
  <style>.x{content:"<form>"}</style><!-- <form action="/evil"> -->`;
const abilitiesPage = (lockout = "N") => `<html><head><title>TEST UPS Abilities Setup</title>${CUSTOM_HEADER}</head><body>
  <form method="POST" action="/2026/options">
    <input type="hidden" name="L" value="${L}"><input type="hidden" name="O" value="93">
    <table><tr><td>Team 0001</td><td><input type="checkbox" name="ABIL_0001_TRADE" value="1" checked></td></tr></table>
    <table><tr><td>Commissioner Lockout:</td><td>
      <input type="radio" name="COMMISH_LOCKOUT" value="N"${lockout === "N" ? " checked" : ""}> No, the commissioner can view pending transactions.<br>
      <input type="radio" name="COMMISH_LOCKOUT" value="Y"${lockout === "Y" ? " checked" : ""}> Yes, the commissioner cannot view them.<br>
    </td></tr></table>
    <input type="submit" name="SAVE" value="SAVE ABILITIES"></form></body></html>`;
const tradesPage = () => `<html><head><title>TEST UPS Trades Setup</title>${CUSTOM_HEADER}</head><body>
  <form method="POST" action="/2026/csetup"><input type="hidden" name="L" value="${L}"><input type="hidden" name="C" value="TRADES">
    Future Draft Pick Trading: <select name="FUTURE_YEARS"><option value="0" selected>None</option><option value="1">1 year</option></select>
    <input type="submit" name="SAVE" value="Save Trades Setup"></form></body></html>`;
const accessRequiredPage = () => `<html><head><title>TEST UPS Trades Setup</title>${CUSTOM_HEADER}</head><body>
  <h2>Trades Setup</h2><h3>Commissioner Access Required.</h3><a href="javascript:history.back()">Go Back To Previous Page</a></body></html>`;

// A fake MFL that only honors a correctly named session cookie, the way MFL does.
function fakeMfl({ validValue, page }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const cookie = String((init.headers && init.headers.Cookie) || "");
    calls.push({ url: String(url), cookie, redirect: init.redirect });
    const signedIn = cookie.split(/;\s*/).some((c) => c === `MFL_USER_ID=${validValue}`);
    const u = new URL(String(url));
    if (u.pathname.endsWith("/options") && !signedIn) {
      return { status: 302, headers: { get: (h) => (h.toLowerCase() === "location" ? `https://www48.myfantasyleague.com/2026/login?L=${L}&URL=x` : null) }, text: async () => "" };
    }
    if (u.pathname.endsWith("/csetup") && !signedIn) return { status: 200, headers: { get: () => null }, text: async () => accessRequiredPage() };
    return { status: 200, headers: { get: () => null }, text: async () => page(u) };
  };
  return { fetchImpl, calls };
}
const pageFor = (u) => (u.pathname.endsWith("/csetup") ? tradesPage() : abilitiesPage());

test("cookie header: a bare value is always sent with its name — even when the value contains '='", () => {
  t.equal(mflCookieHeader(BARE_WITH_EQUALS), `MFL_USER_ID=${BARE_WITH_EQUALS}`, "the bug: the old rule sent this with no name");
  t.equal(mflCookieHeader(BARE_PLAIN), `MFL_USER_ID=${BARE_PLAIN}`);
  t.equal(mflCookieHeader(`MFL_USER_ID=${BARE_WITH_EQUALS}`), `MFL_USER_ID=${BARE_WITH_EQUALS}`, "a full fragment is kept as is");
  t.equal(mflCookieHeader(`  Cookie: MFL_USER_ID=${BARE_PLAIN} `), `MFL_USER_ID=${BARE_PLAIN}`, "a pasted 'Cookie:' prefix and spaces are dropped");
  t.equal(mflCookieHeader(`MFL_LAST_LEAGUE_ID=1; MFL_USER_ID=${BARE_PLAIN}`), `MFL_LAST_LEAGUE_ID=1; MFL_USER_ID=${BARE_PLAIN}`, "several cookies: kept");
  t.equal(mflCookieHeader(""), ""); t.equal(mflCookieHeader(null), "");
  t.equal(mflCookieHeader("a%3D"), "MFL_USER_ID=a%3D", "never re-encoded or decoded");
});

test("cookie shape: reports format and a fingerprint, never the value", async () => {
  const s = await mflCookieShape(BARE_WITH_EQUALS);
  t.equal(s.present, true); t.equal(s.stored_as, "bare_value"); t.equal(s.value_contains_equals, true);
  t.equal(s.old_rule_would_send_cookie_name, false, "this is the shape the old rule broke");
  t.match(s.sha256_12, /^[0-9a-f]{12}$/);
  t.equal(JSON.stringify(s).includes(BARE_WITH_EQUALS), false, "the value never appears");
  t.equal(JSON.stringify(s).includes(BARE_WITH_EQUALS.slice(0, 8)), false, "nor any prefix of it");
  t.equal((await mflCookieShape(`MFL_USER_ID=${BARE_WITH_EQUALS}`)).sha256_12, s.sha256_12, "bare and fragment forms fingerprint the same value");
  t.equal((await mflCookieShape(`MFL_USER_ID=${BARE_WITH_EQUALS}`)).old_rule_would_send_cookie_name, true);
  t.deepEqual(await mflCookieShape(""), { present: false });
});

test("no worker file builds the MFL session header with the old 'contains =' rule any more", () => {
  const dir = new URL("../worker/src/", import.meta.url);
  const offenders = [];
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".js"))) {
    const src = readFileSync(new URL(f, dir), "utf8");
    src.split("\n").forEach((line, i) => {
      if (/includes\("="\)\s*\?\s*\w+\s*:\s*(`MFL_USER_ID=|\("MFL_USER_ID=")/.test(line)) offenders.push(`${f}:${i + 1}`);
    });
  }
  t.deepEqual(offenders, []);
});

test("a stored bare value with '=' now signs the worker in; the old rule would have been sent to the login page", async () => {
  const mfl = fakeMfl({ validValue: BARE_WITH_EQUALS, page: pageFor });
  const r = await LK.inspectAbilities({ MFL_COOKIE: BARE_WITH_EQUALS }, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  t.equal(r.ok, true, JSON.stringify(r)); t.equal(r.lockout, "No");
  t.equal(mfl.calls[0].cookie, `MFL_USER_ID=${BARE_WITH_EQUALS}`);
  t.equal(mfl.calls[0].redirect, "manual", "redirects are never followed");
  // What the old rule sent: the bare value with no name → MFL redirects to login.
  const old = await fakeMfl({ validValue: BARE_WITH_EQUALS, page: pageFor }).fetchImpl(LK.abilitiesUrl(SEASON, L), { headers: { Cookie: BARE_WITH_EQUALS } });
  t.equal(old.status, 302);
});

test("signed out: Abilities reads as 'redirected_to_login' and Trades as 'commissioner_access_required' — not 'form not found'", async () => {
  const mfl = fakeMfl({ validValue: "something-else", page: pageFor });
  const a = await LK.inspectAbilities({ MFL_COOKIE: BARE_PLAIN }, { season: SEASON, leagueId: L, fetchImpl: mfl.fetchImpl });
  t.equal(a.ok, false); t.equal(a.error, "redirected_to_login"); t.equal(a.http, 302); t.equal(a.location_path, "/2026/login");
  const tr = await LK.snapshotPage({ MFL_COOKIE: BARE_PLAIN }, { season: SEASON, leagueId: L, page: "trades", fetchImpl: mfl.fetchImpl });
  t.equal(tr.ok, false); t.equal(tr.error, "commissioner_access_required");
  t.equal(mfl.calls.length, 2, "one GET each, nothing followed or submitted");
});

test("the league's custom-header scripts never become the form: real action, method and fields only", () => {
  const p = LK.parseAbilitiesPage(abilitiesPage("Y"));
  t.equal(p.ok, true, JSON.stringify(p));
  t.equal(p.form.action, "/2026/options"); t.equal(p.form.method, "POST");
  t.deepEqual(p.form.fields.map(([k]) => k), ["L", "O", "ABIL_0001_TRADE", "COMMISH_LOCKOUT", "SAVE"]);
  t.equal(p.lockout.current, "Yes");
  t.equal(p.form.fields.some(([k]) => /playerId|HDR_TOGGLE/.test(k)), false, "no script-string inputs");
  // Before the fix, the first "<form" (inside the script) opened the match.
  const naive = [...abilitiesPage("Y").matchAll(/<form\b[\s\S]*?<\/form>/gi)].map((m) => m[0]);
  t.match(naive[0], /^<form action="\/2026\/search" method="get">/, "the old scoping started at the script's fake form");
});

test("Trades Setup: the real form is found through the custom header", async () => {
  const mfl = fakeMfl({ validValue: BARE_PLAIN, page: pageFor });
  const r = await LK.snapshotPage({ MFL_COOKIE: BARE_PLAIN }, { season: SEASON, leagueId: L, page: "trades", fetchImpl: mfl.fetchImpl });
  t.equal(r.ok, true, JSON.stringify(r));
  t.equal(r.method, "POST", "the real form's method, not the script's GET");
  t.deepEqual(r.fields.map(([k]) => k), ["L", "C", "FUTURE_YEARS", "SAVE"], "real fields only");
});

console.error = () => {};
await run("mfl_cookie_page_reader");
