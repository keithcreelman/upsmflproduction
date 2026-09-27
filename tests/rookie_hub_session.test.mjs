// Rookie Draft Hub: it must hand the worker the viewer's PROVEN MFL session for its trade calls,
// because the worker no longer accepts an unauthenticated request as an owner or substitutes the
// commissioner's cookie.   node tests/rookie_hub_session.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";

const restore = quiet();
const HUB = fs.readFileSync(new URL("../site/rookies/rookie_draft_hub.js", import.meta.url), "utf8");
const LOADER = fs.readFileSync(new URL("../site/rookies/mfl_hpm_embed_loader.js", import.meta.url), "utf8");

// ── the loader hands the outer page's session to the hub ──
async function runLoader({ cookie = "", search = "" }) {
  let srcdoc = "";
  const frame = { style: {}, setAttribute() {}, set srcdoc(v) { srcdoc = v; }, get srcdoc() { return srcdoc; }, scrollIntoView() {} };
  const mount = { innerHTML: "", appendChild() {} };
  const doc = { cookie, getElementById: (id) => (id === "draftHubMount" ? mount : null), createElement: () => frame, body: { appendChild() {} } };
  mount.appendChild = () => {};
  const win = { location: { href: `https://www48.myfantasyleague.com/2026/home/74598/0002${search}`, pathname: "/2026/home/74598/0002", search }, addEventListener() {}, UPS_DRAFT_HUB_RELEASE_SHA: "test" };
  const sb = { window: win, document: doc, URL, Promise, JSON, String, Number, Math, Date, RegExp, encodeURIComponent, decodeURIComponent,
    fetch: async () => ({ ok: true, text: async () => "<html><head></head><body></body></html>" }), setTimeout, console };
  vm.createContext(sb); vm.runInContext(LOADER, sb, { filename: "rookies/mfl_hpm_embed_loader.js" });
  for (let i = 0; i < 20 && !srcdoc; i++) await new Promise((r) => setTimeout(r, 0));
  return srcdoc;
}
const tokenIn = (srcdoc) => { const m = /window\.UPS_DRAFT_HUB_MFL_USER_ID=("(?:[^"\\]|\\.)*");/.exec(srcdoc); return m ? JSON.parse(m[1]) : null; };

test("LOADER: the viewer's MFL_USER_ID cookie is handed into the hub (in memory)", async () => {
  const s = await runLoader({ cookie: "other=1; MFL_USER_ID=tok-C%2Babc; x=2" });
  t.equal(tokenIn(s), "tok-C+abc");
});
test("LOADER: a signed-out page hands over an empty session (the hub then shows the server's sign-in message)", async () => {
  t.equal(tokenIn(await runLoader({ cookie: "" })), "");
});
test("LOADER: a hostile cookie value cannot break out of the injected <script>", async () => {
  const s = await runLoader({ cookie: "MFL_USER_ID=" + encodeURIComponent("</script><img src=x onerror=alert(1)>") });
  t.doesNotMatch(s.slice(s.indexOf("UPS_DRAFT_HUB_MFL_USER_ID"), s.indexOf("UPS_DRAFT_HUB_MFL_USER_ID") + 200), /<\/script>/i);
  t.match(tokenIn(s), /<\/script>/);          // round-trips intact, just escaped in the source
});

// ── the hub attaches it to every TRADE call ──
const helperSrc = /function withHubSession\(url\) \{[\s\S]*?\n  \}/.exec(HUB)[0];
const withSession = (tok) => { const sb = { window: { UPS_DRAFT_HUB_MFL_USER_ID: tok }, encodeURIComponent }; vm.createContext(sb); vm.runInContext(helperSrc + "; this.f = withHubSession;", sb); return sb.f; };

test("HUB: withHubSession appends the session, respects an existing query, and is a no-op when signed out", () => {
  t.equal(withSession("tok-C")("https://w/api/trade?L=74598"), "https://w/api/trade?L=74598&MFL_USER_ID=tok-C");
  t.equal(withSession("tok-C")("https://w/api/x"), "https://w/api/x?MFL_USER_ID=tok-C");
  t.equal(withSession("a+b/c=")("https://w/x?L=1"), "https://w/x?L=1&MFL_USER_ID=a%2Bb%2Fc%3D");
  t.equal(withSession("")("https://w/api/trade?L=74598"), "https://w/api/trade?L=74598");
});

test("HUB: every trade call (live trade, commissioner process, offer action, inbox poll) goes through withHubSession; no bare call remains", () => {
  // (the R6 Discord-announce helper also uses apiUrl(endpoint) but is not a trade route — excluded by name)
  const noAnnounce = HUB.replace(/async function _r6CallAnnounce[\s\S]*?\n  \}\n/, "");
  const tradeCalls = noAnnounce.split("\n").filter((l) => /apiUrl\((endpoint|"\/api\/trades?\/[^"]*"|`\/api\/trades?\/[^`]*`)\)/.test(l));
  t.equal(tradeCalls.length, 3, `found ${tradeCalls.length} trade call lines`);
  for (const l of tradeCalls) t.match(l, /withHubSession\(apiUrl\(/, l.trim());   // /api/trade + /api/trade/process share one fetch
  t.match(HUB, /window\.UPS_DRAFT_HUB_MFL_USER_ID = cookie;/);          // the cookie-paste login also becomes the session
});

// ── and the worker accepts exactly that request, refuses the old (session-less) one ──
const TRADE = { from_fid: "0001", to_fid: "0002", give: ["P_14056"], receive: ["P_13100"], comments: "", simulate: false, dry_run: true };
test("WORKER: the hub's live-trade request WITH the forwarded session passes the gate; WITHOUT it (the old hub/loader) is refused (401)", async () => {
  const env = makeWorkerEnv(); const mfl = makeMfl(); mfl.install();
  const withHub = withSession("tok-B");
  const ok = await callWorker(env, "POST", new URL(withHub("https://w/api/trade?L=74598")).pathname + new URL(withHub("https://w/api/trade?L=74598")).search, { body: TRADE });
  t.equal(ok.status, 200);
  const old = await callWorker(env, "POST", "/api/trade?L=74598", { body: TRADE });
  t.equal(old.status, 401); t.equal(old.json.code, "unauthenticated");
  const other = await callWorker(env, "POST", "/api/trade?L=74598&MFL_USER_ID=tok-C", { body: TRADE });    // a different owner claiming from_fid 0001
  t.equal(other.status, 403);
  t.equal(mfl.writes().length, 0);
});

test("WORKER: commissioner 'process trade' from the hub needs the COMMISSIONER's own session; an owner's or a body 'requested_by' is not enough", async () => {
  const env = makeWorkerEnv(); const mfl = makeMfl(); mfl.install();
  const body = { ...TRADE, requested_by: "0008" };
  t.equal((await callWorker(env, "POST", "/api/trade/process?L=74598", { body })).status, 401);
  t.equal((await callWorker(env, "POST", "/api/trade/process?L=74598&MFL_USER_ID=tok-B", { body })).status, 403);
  const ok = await callWorker(env, "POST", "/api/trade/process?L=74598&MFL_USER_ID=tok-commish", { body });
  t.equal(ok.status, 200); t.equal(ok.json.ok, true);
});

test("WORKER: the hub's offer-inbox poll and accept/decline need the session too", async () => {
  const env = makeWorkerEnv(); const mfl = makeMfl(); mfl.install();
  const id = mfl.addPending({ offeringteam: "0001", offeredto: "0002" });
  t.ok([401, 500].includes((await callWorker(env, "GET", "/api/trades/proposals?L=74598&to_fid=0002")).status));
  const poll = await callWorker(env, "GET", "/api/trades/proposals?L=74598&to_fid=0002&MFL_USER_ID=tok-C");
  t.equal(poll.status, 200);
  const noSession = await callWorker(env, "POST", "/api/trades/proposals/action?L=74598", { body: { proposal_id: id, trade_id: id, action: "reject", acting_franchise_id: "0002" } });
  t.equal(noSession.status, 401);
  const withS = await callWorker(env, "POST", "/api/trades/proposals/action?L=74598&MFL_USER_ID=tok-C", { body: { proposal_id: id, trade_id: id, action: "reject", acting_franchise_id: "0002" } });
  t.equal(withS.status, 200);
  t.equal(mfl.commishCookieWrites().length, 0);
});

await run("rookie_hub_session");
restore();
