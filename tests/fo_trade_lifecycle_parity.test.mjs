// Front Office offer lifecycle ↔ Trade War Room request parity (#1338, Keith's ruling 4, 2026-10-28).
// Same inputs → the Front Office sends the War Room's request byte for byte, plus `idempotency_key` as the last field on a create.
//   1. END TO END: the REAL whole War Room (site/trades/trade_workbench.js, booted by tests/fixtures/war_room_page.mjs against the
//      REAL worker, MFL stubbed) sends a two-team offer; the Front Office lifecycle, fed the SAME /trade-workbench answer and the
//      same draft, builds the identical bytes. Also with a staging_required answer (the War Room's staged fallback body).
//   2. The Front Office's create reaches the real worker and is accepted (the offer lands in the MFL stub), with the key.
//   3. LITERAL CHECKS: the request bodies assembled inside War Room click handlers (accept/decline/revoke, PREVIEW, ACK_CAP,
//      the three-team create, after-trade refresh, staged and three-team management) are evaluated FROM THE WAR ROOM'S OWN SOURCE
//      TEXT and compared with the lifecycle's bodies.
// Offline: worker = real handler on node:sqlite; MFL = the harness stub; no other network.
//   node tests/fo_trade_lifecycle_parity.test.mjs
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { quiet, workerFetch } from "./fixtures/worker_harness.mjs";
import { settle } from "./fixtures/fake_dom.mjs";
import { bootDesktop, pageWorld, readyOffer, resp, WORKER } from "./fixtures/war_room_page.mjs";
import { scan } from "../scripts/generate_war_room_requests.mjs";

const restore = quiet();
const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WR_SRC = fs.readFileSync(path.join(ROOT, "site/trades/trade_workbench.js"), "utf8");
const RULES = require("../site/shared/trade_rules.js");
const WRQ = require("../site/shared/war_room_requests.js");
const LC = require("../site/shared/trade_offer_lifecycle.js");

const isCreate = (u, i) => !!(i && i.method === "POST" && /\/trade-offers\?/.test(u));
const isStage = (u, i) => !!(i && i.method === "POST" && /\/api\/trades\/2way\?/.test(u));
const omitKey = (s) => { const o = JSON.parse(s); delete o.idempotency_key; return JSON.stringify(o); };
const DRAFT = (capK) => ({ teams: ["0001", "0002"], items: [{ from: "0001", to: "0002", token: "P_14056" }, { from: "0002", to: "0001", token: "P_13100" }], capK: capK ? { "0001>0002": capK } : {}, ext: {} });
const sessionUrl = (tok) => (u) => u + "&MFL_USER_ID=" + tok;

// Boot the real War Room as 0001, capture its /trade-workbench answer and every create body it posts.
async function warRoomSend({ capK = 0, message = "hi", staging = false } = {}) {
  const w = pageWorld();
  const cap = { raw: null, creates: [], stages: [], href: "" };
  const d = await bootDesktop(w, { token: "tok-B", fid: "0001", override: async (u, i, real) => {
    if (/\/trade-workbench\?/.test(u) && (!i || !i.method || i.method === "GET")) { const r = await real(u, i); const txt = await r.text(); cap.raw = JSON.parse(txt); return resp(r.status, txt); }
    if (isCreate(u, i)) { cap.creates.push(i.body); if (staging) return resp(409, { ok: false, code: "staging_required", error: "staged" }); }
    if (isStage(u, i)) { cap.stages.push(i.body); return resp(200, { ok: true, id: "st-1" }); }
    return null;
  } });
  t.equal(readyOffer(d, message, { capK }), "ready", "the War Room's own builder says ready");
  await d.api.submitOfferToQueue(); await settle(40);
  return { w, d, cap };
}
function foWarRoom(cap) {
  return LC.warRoom({ raw: cap.raw, acquisitionRows: [], href: "https://keithcreelman.github.io/upsmflproduction/trades/trade_workbench.html?embed=1&L=74598&YEAR=2026&FRANCHISE_ID=0001", rules: RULES });
}

test("two-team direct create: the Front Office body is the War Room's, byte for byte (+ idempotency_key last)", async () => {
  const { cap } = await warRoomSend({ capK: 2, message: "  Two for one?  " });
  t.equal(cap.creates.length, 1, "the War Room posted one create");
  const wrBody = cap.creates[0], wrObj = JSON.parse(wrBody);
  const built = LC.twoTeam(foWarRoom(cap), DRAFT(2), "0001", "  Two for one?  ", { generatedAt: wrObj.payload.generated_at });
  t.ok(built.ok, JSON.stringify(built.problems));
  t.equal(JSON.stringify(built.body), wrBody, "identical bytes");
  const keyed = JSON.stringify(LC.withKey(built.body, "k-12345678"));
  t.ok(keyed.endsWith(',"idempotency_key":"k-12345678"}'), "the key is the last field");
  t.equal(omitKey(keyed), wrBody, "removing the key gives the War Room's bytes back");
});

test("two-team with no cap money and an empty note: still byte for byte", async () => {
  const { cap } = await warRoomSend({ capK: 0, message: "" });
  const wrBody = cap.creates[0];
  const built = LC.twoTeam(foWarRoom(cap), DRAFT(0), "0001", "", { generatedAt: JSON.parse(wrBody).payload.generated_at });
  t.equal(JSON.stringify(built.body), wrBody);
});

test("staging_required → the War Room's staged body; the Front Office builds the same (drops never set, key added)", async () => {
  const { cap } = await warRoomSend({ capK: 2, message: "staged please", staging: true });
  t.equal(cap.stages.length, 1, "the War Room fell back to /api/trades/2way");
  const wr = foWarRoom(cap);
  const built = LC.twoTeam(wr, DRAFT(2), "0001", "staged please", { generatedAt: JSON.parse(cap.creates[0]).payload.generated_at });
  const staged = LC.stagedFromDirect(wr, built.body);
  t.equal(JSON.stringify(staged), cap.stages[0], "identical staged bytes");
  t.ok(!/loaded_contract_drops/.test(JSON.stringify(staged)), "no loaded_contract_drops field is ever sent (R8 open)");
});

test("the Front Office client's create reaches the REAL worker with the War Room body + key, and MFL gets the offer", async () => {
  const { w, cap } = await warRoomSend({ capK: 2, message: "same" });
  const before = w.mfl.st.pending.length;
  const sent = [];
  const real = workerFetch(w.env, w.log);
  const send = async (req) => { sent.push(req); const r = await real(req.url, { method: req.method, headers: req.headers, body: req.body }); const txt = await r.text(); let b = null; try { b = JSON.parse(txt); } catch (e) {} return { ok: r.ok, status: r.status, body: b }; };
  const wr = foWarRoom(cap);
  const c = LC.client({ cfg: { FO_TRADE_BUILDER_SEND: true }, send, warRoom: wr, me: { sessionFid: "0001", isCommish: false }, lockout: "Y",
    routes: LC.routes({ apiBase: WORKER, leagueId: "74598", season: "2026", sessionUrl: sessionUrl("tok-B") }) });
  const r = await c.sendTwoTeam(DRAFT(2), "0001", "same", { generatedAt: JSON.parse(cap.creates[0]).payload.generated_at, newKey: () => "fo-key-0001-abcdef" });
  t.equal(r.state, "sent", JSON.stringify(r));
  t.equal(sent.length, 1, "exactly one request");
  t.equal(omitKey(sent[0].body), cap.creates[0], "the bytes the worker received = the War Room's + key");
  t.equal(JSON.parse(sent[0].body).idempotency_key, "fo-key-0001-abcdef");
  t.equal(w.mfl.st.pending.length, before + 1, "the offer reached MFL (stub)");
  t.ok(r.tradeId, "the MFL trade id is reported");
});

// ── Literal checks: evaluate the War Room's own body literals (from its source text) ──
const fnText = (name) => { const f = scan(WR_SRC).fns.get(name); if (!f) throw new Error("no " + name); return f.text; };
function literal(text, marker) {
  const at = text.indexOf(marker); if (at < 0) throw new Error("marker not found: " + marker);
  let i = text.indexOf("{", at), d = 0, j = i;
  for (; j < text.length; j++) { if (text[j] === "{") d++; else if (text[j] === "}") { d--; if (!d) break; } }
  return text.slice(i, j + 1);
}
const evalIn = (src, scope) => new Function(...Object.keys(scope), "return (" + src + ");")(...Object.values(scope));

const OFFER = { id: "2001", trade_id: "2001", proposal_id: "2001", from_franchise_id: "0002", to_franchise_id: "0001", will_give_up: "13100,", will_receive: "14056,", comments: "a note" };

test("accept / decline / revoke body: the War Room's performOfferAction literal, evaluated, equals the lifecycle's", async () => {
  const { cap } = await warRoomSend({ capK: 0, message: "" });
  const text = fnText("performOfferAction"), lit = literal(text, "var body = {");
  for (const action of ["ACCEPT", "REJECT", "REVOKE"]) {
    const wr = foWarRoom(cap);
    const mine = LC.offerActionBody(wr, action, OFFER, "0001", "no thanks", { generatedAt: "2026-10-28T00:00:00.000Z" });
    const g = WRQ.create({ href: "https://x/?L=74598&YEAR=2026", rules: RULES });
    g.state.data = g.normalizeData(cap.raw); g.state.activeFranchiseId = "0001";
    const raw = g.safeStr(OFFER.raw_comment || OFFER.comments || OFFER.comment || OFFER.message || OFFER.notes);
    let meta = OFFER.twb_meta || null; if (!meta && raw) meta = g.parseTradeMetaFromComment(raw);
    const actionPayload = g.getOfferPayloadForWorkbench(OFFER, { keepOriginalOrientation: true }) || null;
    if (actionPayload) actionPayload.generated_at = "2026-10-28T00:00:00.000Z";   // the clock is an input
    let explicit = [];
    if (action === "ACCEPT") { if (actionPayload && Array.isArray(actionPayload.extension_requests) && actionPayload.extension_requests.length) explicit = JSON.parse(JSON.stringify(actionPayload.extension_requests)); else if (meta && Array.isArray(meta.ext) && meta.ext.length) explicit = JSON.parse(JSON.stringify(meta.ext)); }
    const theirs = evalIn(lit, { leagueId: "74598", season: g.safeStr(g.state.data.meta.season), offer: OFFER, safeStr: g.safeStr, tradeId: g.getOfferTradeId(OFFER), normalizedAction: action,
      meta: { message: "no thanks" }, actingFranchiseId: g.getActiveFranchiseId(), actionPayload, offerRawCommentText: raw, offerMeta: meta, explicitOfferExtensionRequests: explicit });
    t.equal(JSON.stringify(mine), JSON.stringify(theirs), action + " body");
  }
});

test("PREVIEW and ACK_CAP bodies: the War Room's reviewBeforeAccept literals", async () => {
  const { cap } = await warRoomSend({ capK: 0, message: "" });
  const pre = literal(fnText("performOfferAction"), "reviewBeforeAccept(resolveTradeOffersActionApiUrl(), {");
  const ack = literal(fnText("reviewBeforeAccept"), "fetchAcceptPreview(actionUrl, {");
  const wr = foWarRoom(cap);
  const p = evalIn(pre, { leagueId: "74598", season: "2026", tradeId: "2001", actingFranchiseId: "0001", safeStr: wr.safeStr, offer: OFFER });
  t.equal(JSON.stringify(LC.offerActionBody(wr, "PREVIEW", OFFER, "0001")), JSON.stringify(p), "PREVIEW");
  const a = evalIn(ack, { previewBody: p });
  t.equal(JSON.stringify(LC.offerActionBody(wr, "ACK_CAP", OFFER, "0001")), JSON.stringify(a), "ACK_CAP");
});

test("three-team create body: the War Room's tw3Submit literal (bodyObj), evaluated with the same tw3 state", async () => {
  const { cap } = await warRoomSend({ capK: 0, message: "" });
  // A third team: reuse 0002's world but add 0003 with one player in the raw answer the Front Office reads.
  const raw = JSON.parse(JSON.stringify(cap.raw));
  const t2 = raw.teams.find((x) => x.franchise_id === "0002");
  const third = t2.assets.filter((a) => String(a.player_id) === "13100").map((a) => ({ ...a, asset_id: String(a.asset_id).replace("13100", "13999"), player_id: "13999", player_name: "P13999, Test", franchise_id: "0003" }));
  const t3 = raw.teams.find((x) => x.franchise_id === "0003");
  if (t3) t3.assets = (t3.assets || []).concat(third); else raw.teams.push({ ...JSON.parse(JSON.stringify(t2)), franchise_id: "0003", franchise_name: "Third Team", assets: third });
  const href = "https://x/?L=74598&YEAR=2026";
  const wr = LC.warRoom({ raw, href, rules: RULES });
  const draft = { teams: ["0001", "0002", "0003"], items: [{ from: "0001", to: "0002", token: "P_14056" }, { from: "0002", to: "0003", token: "P_13100" }, { from: "0003", to: "0001", token: "P_13999" }], capK: { "0001>0002": 1 }, ext: {} };
  const built = LC.threeTeam(wr, draft, "0001", "three ways");
  t.ok(built.ok, JSON.stringify(built.problems));
  const lit = literal(fnText("tw3Submit"), "var bodyObj = {");
  const g = LC.warRoom({ raw, href, rules: RULES });
  const tw3 = { aFid: "0001", bFid: "0002", cFid: "0003", give: { "0001": {}, "0002": {}, "0003": {} }, cap: { "0001": { "0002": 1 }, "0002": {}, "0003": {} }, ext: { "0001": {}, "0002": {}, "0003": {} }, notes: "three ways" };
  draft.items.forEach((i) => { const a = g.getTeamById(i.from).assets.find((x) => x.player_id === i.token.slice(2)); tw3.give[i.from][a.asset_id] = i.to; });
  g.setTw3(tw3);
  const theirs = evalIn(lit, { ctx: g.getLeagueContext(), pad4: g.pad4, tw3, tw3NameOf: g.tw3NameOf, st: { movements: g.tw3Movements() }, safeInt: g.safeInt, tw3BuildExtensionRequests: g.tw3BuildExtensionRequests });
  t.equal(JSON.stringify(built.body), JSON.stringify(theirs), "identical three-team body");
  t.equal(built.body.movements[0].cap_k, 1, "cap money rides on the giving movement");
});

test("after-trade refresh, staged and three-team management bodies: the War Room's literals", async () => {
  const { cap } = await warRoomSend({ capK: 0, message: "" });
  const wr = foWarRoom(cap);
  const ref = literal(fnText("triggerAfterTradeRefresh"), "var body = {");
  const theirs = evalIn(ref, { args: { trade_id: "2001" }, meta: wr.state.data.meta, leagueCtx: { leagueId: "", season: "" }, safeStr: wr.safeStr, getActiveFranchiseId: () => "0001" });
  t.equal(JSON.stringify(LC.afterTradeRefreshBody(wr, "2001", "0001")), JSON.stringify(theirs), "after-trade refresh");
  t.match(fnText("doCancel2WayStaged"), /JSON\.stringify\(\{ id: id, reason: "cancelled from the Trade War Room" \}\)/);
  t.equal(JSON.stringify(LC.stagedActionBody("cancel", "st-1")), JSON.stringify({ id: "st-1", reason: "cancelled from the Trade War Room" }));
  t.match(fnText("doAccept2WayStaged"), /JSON\.stringify\(\{ id: id \}\)/);
  t.match(fnText("doRecheck2WayStaged"), /JSON\.stringify\(\{ id: id \}\)/);
  t.match(fnText("doDecline2WayStaged"), /return doCancel2WayStaged\(id\);/, "a staged decline IS the War Room's cancel");
  t.equal(JSON.stringify(LC.stagedActionBody("decline", "st-1")), JSON.stringify(LC.stagedActionBody("cancel", "st-1")));
  for (const fn of ["doCancel3Way", "doRecheck3Way", "doAckCap3Way"]) t.match(fnText(fn), /var body = \{ id: id \};\n\s+var fid = getActiveFranchiseId\(\);\n\s+if \(fid\) body\.acting_franchise_id = fid;/, fn);
  t.equal(JSON.stringify(LC.threeWayActionBody("cancel", "x9", "0001")), JSON.stringify({ id: "x9", acting_franchise_id: "0001" }));
  t.equal(LC.stagedActionBody("select-drops", "st-1"), null, "no drop selection from the Front Office");
});

test("the War Room's submit lines the lifecycle copies are still the War Room's (drift tripwire)", () => {
  const s = fnText("submitOfferToQueue");
  t.match(s, /var userMessage = els\.offerMessageInput \? safeStr\(els\.offerMessageInput\.value\)\.slice\(0, 2000\) : "";/);
  t.match(s, /source: "trade-workbench-ui",\n\s+direct_mfl: true,\n\s+submit_mode: "mfl"\n\s+\};/);
  const f = fnText("submitViaStagingFallback");
  t.match(f, /loaded_contract_drops: pre\.drops, notes: directBody\.message \|\| directBody\.comment \|\| ""/);
});

await run("fo_trade_lifecycle_parity");
restore();
