// STALE PRE-TRADE EXTENSIONS ON A LIVE OFFER (production incident, 2026-11-24): Keith's pending
// Real Deal Creel -> Pure Greatness offer (Dak Prescott + BB$ for Rodgers, MHJ, Douglas, a 2027 R1)
// showed "Pre-trade extensions: Goedert, Irving, Olave" -- none of them in the trade. Those came
// from an OLDER, different offer (MFL trade 1284, May) between the same two teams: the offers list
// matched a stored offer to the live MFL row BY TEAM PAIR when the trade id wasn't found, and
// attached that other offer's payload (and id, message, summary).
//
// Proven here through the REAL worker (GET /api/trades/proposals?include_payload=1, a stateful MFL
// stub, a served stored-offers doc) and the REAL mobile renderOfferCard. Nothing is ever created,
// accepted, cancelled or written; the accept path (which already reads the stored copy by exact
// trade id and verifies it against MFL) is untouched and is covered by tests/trade_loaded_contracts
// and trade_accept_integrity tests.
//   node tests/trade_offers_stale_extension_payload.test.mjs
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";

const restoreConsole = quiet();
const MOBILE_SRC = fs.readFileSync(new URL("../site/m/views/trade.js", import.meta.url), "utf8");
const Q = "L=74598&YEAR=2026";
const FROM = "0008", TO = "0004"; // Real Deal Creel -> Pure Greatness
const GIVE = "16614,16193", RECEIVE = "16598,15754";

const asset = (pid) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary: 5000, taxi: false, contract_info: "" });
const ext = (pid, name, from, to) => ({ player_id: String(pid), player_name: name, from_franchise_id: from, to_franchise_id: to, applies_to_acquirer: true, option_key: "k", extension_term: "1YR", new_aav_future: 17000 });
const payloadOf = (give, receive, extensionRequests) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [
    { role: "left", franchise_id: FROM, selected_assets: give.map(asset), traded_salary_adjustment_k: 0 },
    { role: "right", franchise_id: TO, selected_assets: receive.map(asset), traded_salary_adjustment_k: 0 },
  ],
  extension_requests: extensionRequests, ui: { left_team_id: FROM, right_team_id: TO }, validation: { status: "ready" },
});
// The old May offer, exactly as it sat in the stored doc: trade 1284, the three extensions, assets
// that are NOT the live offer's.
const staleStored = () => ({
  id: "MFL-1049", mfl_trade_id: "1284", status: "PENDING", created_at: "2026-05-24T13:23:38.732Z",
  from_franchise_id: FROM, to_franchise_id: TO, will_give_up: "16614,17043", will_receive: "16598,15754",
  message: "Pre-trade extension: Extend Goedert, Dallas 1-year", summary: { stale: true },
  payload: payloadOf(["16614", "17043"], ["16598", "15754"], [ext(17043, "Goedert, Dallas", FROM, TO), ext(15754, "Irving, Bucky", TO, FROM), ext(16598, "Olave, Chris", TO, FROM)]),
});

function setup(storedOffers) {
  const env = makeWorkerEnv();
  const mfl = makeMfl();
  mfl.install();
  mfl.st.pending.push({ trade_id: "2001", offeringteam: FROM, offeredto: TO, will_give_up: GIVE, will_receive: RECEIVE, comments: "Willing to take Devito instead of MHj", timestamp: String(Math.floor(Date.now() / 1000)) });
  // Serve the stored-offers doc (the worker reads it from GitHub Pages when no PAT is set).
  const delegate = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (/github\.io\/.*trade_offers_74598_2026\.json/.test(String(input))) {
      const doc = { meta: { league_id: "74598", season: 2026 }, offers: storedOffers };
      return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), text: async () => JSON.stringify(doc), json: async () => doc };
    }
    return delegate(input, init);
  };
  return { env, mfl, restore: () => { globalThis.fetch = delegate; } };
}
async function outgoing(env) {
  const r = await callWorker(env, "GET", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-A&acting_franchise_id=${FROM}&include_payload=1`);
  t.equal(r.status, 200, r.text.slice(0, 300));
  t.equal(r.json.outgoing.length, 1);
  return r.json.outgoing[0];
}

test("WORKER: a live offer is NEVER matched by team pair to a stored offer that has its own, different MFL trade id -- no stale payload, id, message or summary", async () => {
  const { env, mfl, restore } = setup([staleStored()]);
  try {
    const o = await outgoing(env);
    t.equal(o.trade_id, "2001");
    t.equal(o.payload, undefined, "the May offer's payload (Goedert/Irving/Olave) must not ride on this offer");
    t.equal(o.id, "MFL-2001", "nor its id");
    t.equal(o.message, "Willing to take Devito instead of MHj", "the live MFL comment, not the stored one");
    t.equal(o.summary, null);
    t.equal(o.will_give_up, GIVE, "the assets are MFL's own, as before");
    t.equal(mfl.st.imports.length, 0);
  } finally { restore(); }
});

test("WORKER: even a stored offer WITH the same trade id is shown only if its payload binds to the assets MFL holds", async () => {
  const unbound = { ...staleStored(), id: "MFL-2001", mfl_trade_id: "2001" }; // right id, but assets differ from MFL's
  const { env, restore } = setup([unbound]);
  try {
    const o = await outgoing(env);
    t.equal(o.payload, undefined, "a payload that doesn't describe MFL's offer is omitted, never displayed");
  } finally { restore(); }
});

test("WORKER: a genuine stored offer (same trade id, assets bind to MFL) still carries its payload and its extensions -- the fix hides stale data, not real data", async () => {
  const good = { id: "stored-good", mfl_trade_id: "2001", status: "PENDING", created_at: new Date().toISOString(), from_franchise_id: FROM, to_franchise_id: TO,
    will_give_up: GIVE, will_receive: RECEIVE, message: "real", payload: payloadOf(GIVE.split(","), RECEIVE.split(","), [ext(16614, "Real, Player", FROM, TO)]) };
  const { env, restore } = setup([staleStored(), good]); // the stale one is also present -- must not win
  try {
    const o = await outgoing(env);
    t.ok(o.payload, "the matching payload is attached");
    t.deepEqual(o.payload.extension_requests.map((e) => e.player_id), ["16614"]);
    t.equal(o.id, "stored-good");
  } finally { restore(); }
});

test("WORKER: a stored offer with NO trade id yet (still mid-post) is still matched by team pair, and its payload still has to bind", async () => {
  const midPost = { id: "mid", status: "PENDING", created_at: new Date().toISOString(), from_franchise_id: FROM, to_franchise_id: TO,
    will_give_up: GIVE, will_receive: RECEIVE, message: "mid", payload: payloadOf(GIVE.split(","), RECEIVE.split(","), [ext(16193, "Mid, Post", FROM, TO)]) };
  const { env, restore } = setup([midPost]);
  try {
    const o = await outgoing(env);
    t.ok(o.payload && o.payload.extension_requests.length === 1);
    t.equal(o.id, "mid");
  } finally { restore(); }
});

// ═══ MOBILE: the real renderOfferCard, handed the stale payload anyway (an older cached
// worker response, or any future mismatch) -- the card must still not list extensions for players
// who aren't in the trade ═══
function loadRenderOfferCard() {
  const s = MOBILE_SRC.indexOf("  function describeAssetCsv(csv) {");
  const e = MOBILE_SRC.indexOf("  // Deep-link to desktop Trade War Room");
  if (s < 0 || e < 0) throw new Error("could not locate describeAssetCsv..renderOfferCard -- source may have moved");
  const U = {
    safeStr: (v) => (v == null ? "" : String(v).trim()),
    safeInt: (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) ? n : (d == null ? 0 : d); },
    pad4: (v) => { const d = String(v || "").replace(/\D/g, ""); return d ? d.padStart(4, "0").slice(-4) : ""; },
    escapeHtml: (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])),
    fmtUsd: (v) => "$" + Math.round(Number(v) || 0).toLocaleString("en-US"),
  };
  const names = { 16614: "Dak Prescott", 16193: "Marvin Harrison Jr.", 16598: "Aaron Rodgers", 15754: "Caleb Douglas" };
  const M = { data: { describeTradeBaitToken: (tok) => names[String(tok).replace(/^P_/i, "")] || tok } };
  const franchiseName = (fid) => ({ "0008": "Real Deal Creel", "0004": "Pure Greatness" }[fid] || "Team " + fid);
  return new Function("U", "M", "franchiseName", s ? MOBILE_SRC.slice(s, e) + "\nreturn renderOfferCard;" : "")(U, M, franchiseName);
}

test("MOBILE: renderOfferCard drops extensions for players who aren't in the offer, keeps the ones who are, and shows none when none are", async () => {
  const renderOfferCard = loadRenderOfferCard();
  const live = { trade_id: "2001", from_franchise_id: FROM, to_franchise_id: TO, will_give_up: GIVE, will_receive: RECEIVE, message: "" };
  const stale = { player_id: "17043", player_name: "Goedert, Dallas", from_franchise_id: FROM, to_franchise_id: TO, extension_term: "1YR", new_aav_future: 17000 };
  const real = { player_id: "16614", player_name: "Prescott, Dak", from_franchise_id: FROM, to_franchise_id: TO, extension_term: "1YR", new_aav_future: 30000 };

  const onlyStale = renderOfferCard({ ...live, payload: { extension_requests: [stale, { ...stale, player_id: "15999", player_name: "Irving, Bucky" }] } }, "outgoing");
  t.doesNotMatch(onlyStale, /Pre-trade extension/, "no extension section at all when every row is for a player outside the trade");
  t.doesNotMatch(onlyStale, /Goedert|Irving/);

  const mixed = renderOfferCard({ ...live, payload: { extension_requests: [stale, real] } }, "outgoing");
  t.match(mixed, /Pre-trade extension</, "singular label -- exactly one real extension");
  t.match(mixed, /Prescott, Dak/);
  t.doesNotMatch(mixed, /Goedert/);

  // incoming flips the CSVs -- the player set is the union, so direction doesn't matter
  const incoming = renderOfferCard({ ...live, payload: { extension_requests: [stale, real] } }, "incoming");
  t.match(incoming, /Prescott, Dak/);
  t.doesNotMatch(incoming, /Goedert/);

  t.doesNotMatch(renderOfferCard({ ...live }, "outgoing"), /Pre-trade extension/, "no payload at all -> no section");
});

await run("trade_offers_stale_extension_payload");
restoreConsole();
