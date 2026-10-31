// War Room P0 safety fixes (site/trades/trade_workbench.js), each run against the REAL client code:
//   S6a  three-team Send: a second click during the pre-send check never sends a second 3-way.
//   S7   Accept carries ONLY the offer's own terms -- an unrelated draft in the builder never rides along.
//   S8   no credentials in on-page error text, and no trade message / response body in the console.
//   node tests/trade_war_room_p0_safety.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, workerFetch, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { settle } from "./fixtures/fake_dom.mjs";
import { bootDesktop, pageWorld, pageText, readyOffer, WORKER } from "./fixtures/war_room_page.mjs";

const restore = quiet();
const DESK_SRC = fs.readFileSync(new URL("../site/trades/trade_workbench.js", import.meta.url), "utf8");

// A named function's full source, by brace matching (tests/fixtures/war_room_cap_harness.mjs's technique).
function fnSrc(name) {
  const re = new RegExp(`\\n  (async )?function ${name}\\(`);
  const m = re.exec(DESK_SRC);
  if (!m) throw new Error(`${name} not found in trade_workbench.js`);
  const start = m.index + 1;
  let i = DESK_SRC.indexOf("{", start), depth = 0;
  for (; i < DESK_SRC.length; i += 1) { if (DESK_SRC[i] === "{") depth += 1; else if (DESK_SRC[i] === "}" && --depth === 0) break; }
  return DESK_SRC.slice(start, i + 1);
}
const deferred = () => { let resolve; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; };
const resp = (status, body) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => (typeof body === "string" ? body : JSON.stringify(body)), json: async () => (typeof body === "string" ? JSON.parse(body) : body) });

// ══════════════════════ S6a: three-team Send, the REAL tw3Submit + render3WayPanel ══════════════════════
function load3Way({ preview }) {
  const posts = [];
  const els = {};
  const getEl = (id) => (els[id] = els[id] || { id, innerHTML: "", __l: {}, addEventListener(ev, fn) { this.__l[ev] = fn; }, querySelectorAll: () => [] });
  const ctx = {
    console, Promise, JSON, Math, String, Array, Object, setTimeout: () => 0,
    document: { getElementById: getEl },
    safeStr: (v) => (v == null ? "" : String(v).trim()),
    safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); },
    pad4: (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; },
    escapeHtml: (v) => String(v == null ? "" : v),
    tradeRulesReadyToSend: () => true,
    getLeagueContext: () => ({ leagueId: "74598", season: "2026" }),
    tw3Movements: () => [
      { from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0, summary: "a" },
      { from: "0001", to: "0012", asset_tokens: ["P_16181"], cap_k: 0, summary: "b" },
      { from: "0012", to: "0008", asset_tokens: ["P_16650"], cap_k: 0, summary: "c" },
    ],
    tw3TeamFids: () => ["0008", "0001", "0012"],
    tw3NameOf: (f) => "Team " + f,
    tw3TeamSelectHtml: () => "", tw3ColumnHtml: () => "", tw3SummaryHtml: () => "", tw3WarnText: () => "",
    tw3Reflow: () => {}, tw3BuildExtensionRequests: () => [], tw3WireDestPills: () => {}, tw3WireExtSegs: () => {}, tw3WireCapInputs: () => {},
    tw2sRunPreSendPreview: () => preview(),
    resolve3WayApiUrl: () => "https://worker.test/api/trades/3way?L=74598&YEAR=2026&MFL_USER_ID=tok-A",
    fetch: async (url, init) => { posts.push({ url: String(url), method: init && init.method }); return resp(200, { ok: true, id: "3w-1" }); },
    refresh3WayList: () => {}, close3WayBuilder: () => {},
  };
  vm.createContext(ctx);
  vm.runInContext(["var tw3 = null;", "tw3Fresh", "tw3SetStatus", "tw3State", "render3WayPanel", "tw3WireBody", "tw3Submit"]
    .map((n) => (n.startsWith("var ") ? n : fnSrc(n))).join("\n") + "\ntw3 = tw3Fresh(); tw3.aFid = '0008'; tw3.bFid = '0001'; tw3.cFid = '0012'; render3WayPanel();", ctx, { filename: "trade_workbench.js (3-way builder)" });
  const button = () => /<button[^>]*id="twb3wSubmitBtn"[^>]*>[^<]*<\/button>/.exec(els.twb3wBody.innerHTML)[0];
  return { ctx, posts, button, click: () => els.twb3wSubmitBtn.__l.click() };
}

test("S6a: two clicks while the pre-send check is still running send exactly ONE 3-way; the button reads 'Sending…' and is disabled during the check", async () => {
  const gate = deferred();
  const w = load3Way({ preview: () => gate.p });
  t.doesNotMatch(w.button(), /disabled/, "the button starts enabled");
  w.click();
  await settle();
  t.match(w.button(), /disabled/, "disabled while the check runs");
  t.match(w.button(), /Sending…/);
  w.click();                       // the owner clicks again before the check answers
  await settle();
  gate.resolve({ proceed: true });  // the check answers late
  await settle(20);
  const sends = w.posts.filter((p) => p.method === "POST" && /\/api\/trades\/3way/.test(p.url));
  t.equal(sends.length, 1, "exactly one POST /api/trades/3way");
});

test("S6a: 'Go back' on the pre-send check sends nothing and re-enables the button", async () => {
  const gate = deferred();
  const w = load3Way({ preview: () => gate.p });
  w.click();
  await settle();
  t.match(w.button(), /disabled/);
  gate.resolve({ proceed: false });
  await settle(20);
  t.equal(w.posts.length, 0, "zero POSTs");
  t.doesNotMatch(w.button(), /disabled/, "the button is enabled again");
  t.match(w.button(), /Send 3-way/);
  t.equal(w.ctx.tw3.submitting, false);
  // and the owner can still send it afterwards
  const again = deferred();
  w.ctx.tw2sRunPreSendPreview = () => again.p;
  w.click(); again.resolve({ proceed: true }); await settle(20);
  t.equal(w.posts.length, 1, "a later Send still works");
});

// ══════════════════════ S7: Accept carries only the offer's own terms (REAL performOfferAction → REAL worker) ══════════════════════
const player = (pid) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary: 5000, taxi: false, contract_info: "" });
const offerPayload = () => ({ schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [
    { role: "left", franchise_id: "0001", selected_assets: [player(14056)], traded_salary_adjustment_k: 0 },
    { role: "right", franchise_id: "0002", selected_assets: [player(13100)], traded_salary_adjustment_k: 0 },
  ],
  extension_requests: [], validation: { status: "ready" } });
// What the accepting owner happens to have drafted in the builder: an unrelated pre-trade extension.
const DRAFT_EXT = { player_id: "13100", from_franchise_id: "0002", to_franchise_id: "0001", extension_term: "2YR", new_TCV: 12, new_aav_future: 6, new_contract_length: 2 };

async function acceptWorld() {
  const env = makeWorkerEnv(); const mfl = makeMfl(); mfl.install();
  mfl.st.rosters["0001"] = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  const sent = await callWorker(env, "POST", "/api/trades/proposals?L=74598&YEAR=2026&MFL_USER_ID=tok-B", {
    body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "x", to_franchise_name: "y", message: "", payload: offerPayload() },
  });
  t.ok(sent.status < 300, `offer sent: ${sent.status}`);
  // the offer exactly as the War Room banner receives it
  const list = await callWorker(env, "GET", "/trade-offers?L=74598&YEAR=2026&MFL_USER_ID=tok-C&FRANCHISE_ID=0002");
  const offer = list.json.incoming[0];
  t.ok(offer && offer.trade_id, "the banner lists the offer");
  return { env, mfl, offer };
}

function loadAccept(env) {
  const log = [];
  let draftCalls = 0;
  const ctx = {
    console, Promise, JSON, Math, String, Array, Object, Error, isFinite, parseInt, Headers, URL,
    fetch: workerFetch(env, log),
    safeStr: (v) => (v == null ? "" : String(v).trim()),
    safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); },
    decodeBase64UrlToUtf8: () => "",
    state: { data: { meta: { league_id: "74598", season: "2026" } }, offers: { actionBusy: false }, submit: {} },
    getActiveFranchiseId: () => "0002",
    resolveTradeOffersActionApiUrl: () => "https://worker.test/trade-offers/action?L=74598&YEAR=2026&MFL_USER_ID=tok-C",
    reviewBeforeAccept: async () => true,          // the owner confirmed the accept review
    // The offer's OWN payload as the banner rebuilds it from MFL's tokens (unchanged by this fix).
    getOfferPayloadForWorkbench: () => offerPayload(),
    buildValidationSummary: () => ({ status: "ready", issues: [] }),
    // The builder's current draft -- the thing an accept must never pick up.
    buildTradePayload: () => { draftCalls += 1; return { ...offerPayload(), extension_requests: [DRAFT_EXT], comment: "draft note" }; },
    setAcceptDebug() {}, setSubmitStatus() {}, renderSummary() {}, renderBannerOffers() {}, showFeedbackModal() {}, loadCounterDraftFromOffer() {},
    triggerAfterTradeRefresh: async () => ({ ok: true }), refreshWorkbenchDataAfterTrade: async () => {}, refreshBannerOffers: async () => {},
    logTradeRequestFailure() {},
  };
  vm.createContext(ctx);
  vm.runInContext(["normalizeOfferStatus", "getOfferTradeId", "offerActionBusyKey", "clone", "parseTradeMetaFromComment", "summarizePostAcceptResult", "friendlyOfferError", "fetchJsonRequest", "performOfferAction"]
    .map(fnSrc).join("\n"), ctx, { filename: "trade_workbench.js (offer actions)" });
  return { ctx, log, draftCalls: () => draftCalls };
}

test("S7: with an unrelated extension drafted in the builder, the banner Accept sends ONLY the offer's own extension requests, and the worker accepts it (200, not 409)", async () => {
  const { env, mfl, offer } = await acceptWorld();
  const a = loadAccept(env);
  await a.ctx.performOfferAction("ACCEPT", { offer, bucket: "received" });
  const post = a.log.find((r) => r.method === "POST" && r.path === "/trade-offers/action");
  t.ok(post, "the accept was sent");
  t.deepEqual(post.body.offer_extension_requests, [], "offer_extension_requests = the offer's own (none)");
  t.deepEqual((post.body.payload && post.body.payload.extension_requests) || [], [], "the payload carries none either");
  t.doesNotMatch(JSON.stringify(post.body), /draft note/, "the draft's note doesn't ride along");
  t.equal(a.draftCalls(), 0, "the accept never reads the builder's draft");
  t.equal(post.status, 200, "the worker accepted it");
  t.equal(mfl.st.done.filter((d) => d.response === "accept").length, 1, "MFL recorded exactly one accept");
});

test("S7 (control): the same accept WITH the draft extension merged in is what the worker refuses (409) -- the failure the old merge caused", async () => {
  const { env, mfl, offer } = await acceptWorld();
  const r = await callWorker(env, "POST", "/trade-offers/action?L=74598&YEAR=2026&MFL_USER_ID=tok-C", {
    body: { league_id: "74598", season: "2026", offer_id: offer.id, proposal_id: offer.proposal_id, trade_id: offer.trade_id, action: "ACCEPT", message: "", acting_franchise_id: "0002",
      payload: { ...offerPayload(), extension_requests: [DRAFT_EXT] }, offer_extension_requests: [DRAFT_EXT], offer_twb_meta: null,
      offer_from_franchise_id: "0001", offer_to_franchise_id: "0002", offer_will_give_up: offer.will_give_up, offer_will_receive: offer.will_receive, direct_mfl: true },
  });
  t.equal(r.status, 409, r.text.slice(0, 200));
  t.equal(mfl.st.done.length, 0, "nothing accepted");
});

// ══════════════════════ S8: the REAL, whole War Room (tests/fixtures/war_room_page.mjs) ══════════════════════
const PAGE_KEY = "PAGE-APIKEY-SECRET";

test("S8: a 500 from /trade-workbench shows 'HTTP 500' with no MFL_USER_ID or APIKEY in the page text or the console", async () => {
  const w = pageWorld();
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", extraQuery: "&APIKEY=" + PAGE_KEY, override: async (u) => (/\/trade-workbench/.test(u) ? resp(500, "<html>boom</html>") : null) });
  await new Promise((r) => setTimeout(r, 450)); await settle(30);   // boot retries the load once after 350 ms
  t.equal(d.api, undefined, "boot stopped");
  t.match(d.els.twbBoard.innerHTML, /Could not load Trade War Room data\. HTTP 500/);
  for (const secret of ["MFL_USER_ID", "tok-B", "APIKEY", PAGE_KEY]) {
    t.ok(!pageText(d).includes(secret), `page text has no ${secret}`);
    t.ok(!d.consoleText().includes(secret), `console has no ${secret}`);
  }
  t.match(d.consoleText(), /Trade War Room load failed: HTTP 500/, "a short status-only console line remains for debugging");
});

const COMMENT = "Zebra-quartz private note 7731";

test("S8: a sent trade message never appears in the console (success path)", async () => {
  const w = pageWorld();
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001" });
  t.ok(d.api, "War Room booted");
  t.equal(readyOffer(d, COMMENT), "ready", "the builder's offer is ready to send");
  await d.api.submitOfferToQueue(); await settle(30);
  const post = w.log.find((r) => r.method === "POST" && /\/trade-offers$/.test(r.path));
  t.ok(post && post.body && String(post.body.message).includes(COMMENT), "the message itself still goes to MFL");
  t.equal(w.mfl.st.pending.length, 1, "the offer was created");
  t.ok(!d.consoleText().includes(COMMENT), "the message is not in the console");
  t.ok(!d.consoleText().includes("tok-B"), "no MFL_USER_ID value in the console");
});

test("S8: a failed send and its Retry never print the message, the response body, or the request URL to the console", async () => {
  const w = pageWorld();
  let failing = true;
  const echo = { ok: false, error: "MFL said no", comment: COMMENT, request_url: WORKER + "/trade-offers?MFL_USER_ID=tok-B" };
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i) => (failing && i && i.method === "POST" && /\/trade-offers\?/.test(u) ? resp(500, echo) : null) });
  t.equal(readyOffer(d, COMMENT), "ready", "the builder's offer is ready to send");
  await d.api.submitOfferToQueue(); await settle(30);
  t.equal(d.api.state.submit.canRetry, true, "the owner is offered Retry");
  d.api.state.submit.lastAttemptMs = Date.now() - 5 * 60 * 1000;   // past the wait for MFL to list a new offer
  d.els.twbSubmitRetryBtn.__l.click(); await settle(30);
  t.ok(d.consoleLines.some((l) => /Submit failed: status 500/.test(l)), "a status-only failure line is logged");
  t.ok(d.consoleLines.some((l) => /Retry failed: status 500/.test(l)), "and one for the retry");
  t.ok(!d.consoleText().includes(COMMENT), "the message is not in the console");
  t.ok(!d.consoleText().includes("tok-B"), "no MFL_USER_ID value in the console");
  t.ok(!d.consoleText().includes("MFL said no"), "no response body in the console");
  failing = false;
});

await run("trade_war_room_p0_safety");
