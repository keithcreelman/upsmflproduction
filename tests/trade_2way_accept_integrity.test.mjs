// ACCEPT-PATH INTEGRITY (two-team trades) — the REAL worker on real SQLite, MFL stubbed at the edge.
//   node tests/trade_2way_accept_integrity.test.mjs
//
// An accept is an ACTION REQUEST. What is accepted is what MFL holds + the server's own stored record of
// the offer; the client may not restate the contents. Every mutable asset type is tampered with, through
// both request shapes the deployed clients use: MOBILE (action fields only) and DESKTOP (action fields +
// payload + offer_* claims, exactly as trade_workbench.js builds them).
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";

const restore = quiet();
const Q = "L=74598&YEAR=2026";

// ── builders ───────────────────────────────────────────────────────────────────────
const player = (pid, salary = 5000, extra) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false, contract_info: "", ...(extra || {}) });
const fpick = (orig, yr, rd) => ({ asset_id: `FP_${orig}_${yr}_${rd}`, type: "PICK", pick_key: `FP_${orig}_${yr}_${rd}`, pick_season: yr, pick_round: rd, description: `${yr} R${rd}`, salary: 0 });
const dpick = (rd0, slot0) => ({ asset_id: `DP_${String(rd0).padStart(2, "0")}_${String(slot0).padStart(2, "0")}`, type: "PICK", pick_key: `DP_${String(rd0).padStart(2, "0")}_${String(slot0).padStart(2, "0")}`, pick_season: 2026, pick_round: rd0 + 1, pick_slot: slot0 + 1, description: `2026 ${rd0 + 1}.${String(slot0 + 1).padStart(2, "0")}`, salary: 0 });
const payloadOf = (from, to, give, recv, o) => {
  o = o || {};
  return {
    schema_version: 1, source: "test", league_id: "74598", season: "2026",
    teams: [
      { role: "left", franchise_id: from, selected_assets: give, traded_salary_adjustment_k: o.fromCapK || 0, traded_salary_adjustment_dollars: (o.fromCapK || 0) * 1000, selected_non_taxi_salary_dollars: 5000 },
      { role: "right", franchise_id: to, selected_assets: recv, traded_salary_adjustment_k: o.toCapK || 0, traded_salary_adjustment_dollars: (o.toCapK || 0) * 1000, selected_non_taxi_salary_dollars: 5000 },
    ],
    extension_requests: o.ext || [], ui: { left_team_id: from, right_team_id: to }, validation: { status: "ready" },
  };
};
const clone = (o) => JSON.parse(JSON.stringify(o));

function fresh(over) {
  const env = makeWorkerEnv(over && over.env);
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } });
  mfl.install();
  if (over && over.rosters) Object.assign(mfl.st.rosters, over.rosters);
  return { env, mfl };
}
// Send a REAL offer through the real proposal route as the 0001 owner; returns { id, payload }.
async function sendOffer(env, mfl, payload) {
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, {
    body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "x", to_franchise_name: "y", message: "", payload },
  });
  t.ok(r.status < 300, `offer accepted for sending: ${r.status} ${r.text.slice(0, 200)}`);
  return { id: mfl.st.pending[mfl.st.pending.length - 1].trade_id, payload };
}
// The two request shapes the deployed clients use.
const mobileBody = (id) => ({ action: "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "" });
const desktopBody = (id, p, over) => ({
  league_id: "74598", season: "2026", offer_id: id, proposal_id: id, trade_id: id, action: "ACCEPT", message: "",
  acting_franchise_id: "0002", payload: clone(p), offer_comment: "", offer_comments: "", offer_notes: "", offer_raw_comment: "", offer_message: "",
  offer_twb_meta: null, offer_extension_requests: clone(p.extension_requests || []), offer_from_franchise_id: "0001", offer_to_franchise_id: "0002",
  offer_will_give_up: "", offer_will_receive: "", direct_mfl: true, ...(over || {}),
});
const accept = (env, body) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body });
const acceptCount = (mfl) => mfl.st.done.filter((d) => d.response === "accept").length;
const untouched = (mfl) => { t.equal(mfl.st.done.length, 0); t.equal(mfl.st.pending.length, 1); t.equal(mfl.writes("tradeResponse").length, 0); t.equal(mfl.commishCookieWrites().length, 0); };

// A rich, valid offer: a player + a future pick + a current-year pick + cap money each way.
const RICH = () => payloadOf("0001", "0002", [player(14056), fpick("0001", 2027, 1), dpick(0, 3)], [player(13100), fpick("0002", 2027, 2), dpick(0, 4)], { fromCapK: 2, toCapK: 1 });
// (0001 owns 14056, FP_0001_2027_1, DP_0_3 ; 0002 owns 13100, FP_0002_2027_2, DP_0_4 — see the harness defaults)
const RICH_ROSTERS = { "0002": ["13100"] };

// ══════════════════════════════ legitimate accepts ══════════════════════════════
test("LEGIT: a rich offer (player + future pick + current pick + cap money) accepts through the MOBILE shape", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  const r = await accept(env, mobileBody(o.id));
  t.equal(r.status, 200, r.text.slice(0, 300)); t.equal(r.json.ok, true);
  t.equal(acceptCount(mfl), 1); t.equal(mfl.st.done[0].by, "0002"); t.equal(mfl.st.done[0].cookie, "MFL_USER_ID=tok-C");
  t.equal(r.json.compliance && r.json.compliance.cap.status, "ok", "the live cap picture is returned with the accept");
  t.ok(r.json.compliance && r.json.compliance.roster, "the (advisory) roster picture is returned too");
  noCommish(mfl);
});
test("LEGIT: the same offer accepts through the DESKTOP shape (full payload + offer_* claims that MATCH the stored offer)", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  const r = await accept(env, desktopBody(o.id, o.payload));
  t.equal(r.status, 200, r.text.slice(0, 300)); t.equal(acceptCount(mfl), 1);
});
// The worker's own commissioner credential is used ONLY for the post-accept salary/contract import (an explicit
// administrative step that runs after the OWNER's accept succeeded) — never for an owner-scoped write.
function noCommish(mfl) { t.equal(mfl.commishCookieWrites().filter((w) => /trade(Proposal|Response)/.test(w.type)).length, 0); }

test("LEGIT: cap money is imported from the STORED offer, never from the request (mobile sends none; desktop's matches)", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  await accept(env, mobileBody(o.id));
  const adj = mfl.writes("salaryAdj");
  t.equal(adj.length, 1, "one salaryAdj import");
  t.match(adj[0].fields.DATA, /franchise_id="0001" amount="1000"/);       // net of 2K out and 1K back = 1K
  t.match(adj[0].fields.DATA, /franchise_id="0002" amount="-1000"/);
});

// ══════════════════════════════ tampering: every mutable asset type ══════════════════════════════
// Each mutation is applied to the payload/claims the DESKTOP client would send. Every one must be refused
// (409 payload_mismatch) with NOTHING written, and the untouched offer must still be acceptable afterwards.
const MUTATIONS = {
  "player: recipient's payload adds another of the sender's players": (p) => { p.teams[0].selected_assets.push(player(16614)); },
  "player: a player is removed from the sender's side": (p) => { p.teams[0].selected_assets = p.teams[0].selected_assets.filter((a) => a.asset_id !== "P_14056"); },
  "player: a player is swapped for a different one": (p) => { p.teams[0].selected_assets[0] = player(16193); },
  "player: the recipient's own side is changed": (p) => { p.teams[1].selected_assets = [player(15000)]; },
  "future pick: year altered": (p) => { p.teams[0].selected_assets[1] = fpick("0001", 2028, 1); },
  "future pick: round altered": (p) => { p.teams[0].selected_assets[1] = fpick("0001", 2027, 2); },
  "future pick: original owner altered": (p) => { p.teams[0].selected_assets[1] = fpick("0002", 2027, 1); },
  "current-year pick: slot altered": (p) => { p.teams[0].selected_assets[2] = dpick(0, 9); },
  "current-year pick: dropped": (p) => { p.teams[0].selected_assets.splice(2, 1); },
  "cap money (BBID): sender's amount raised": (p) => { p.teams[0].traded_salary_adjustment_k = 30; },
  "cap money (BBID): recipient's amount raised": (p) => { p.teams[1].traded_salary_adjustment_k = 30; },
  "cap money (BBID): removed": (p) => { p.teams[0].traded_salary_adjustment_k = 0; p.teams[1].traded_salary_adjustment_k = 0; },
  "asset direction: the two sides are swapped": (p) => { const a = p.teams[0].selected_assets; p.teams[0].selected_assets = p.teams[1].selected_assets; p.teams[1].selected_assets = a; },
  "asset direction: the franchise labels are swapped": (p) => { p.teams[0].franchise_id = "0002"; p.teams[1].franchise_id = "0001"; },
  "extension: the recipient adds an extension request": (p) => { p.extension_requests = [{ player_id: "14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "2YR", new_TCV: 1, new_aav_future: 1, new_contract_length: 2 }]; },
};
for (const [name, mutate] of Object.entries(MUTATIONS)) {
  test(`TAMPER (desktop shape) — ${name}`, async () => {
    const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
    const evil = clone(o.payload); mutate(evil);
    const body = desktopBody(o.id, evil, { offer_extension_requests: clone(evil.extension_requests || []) });
    const r = await accept(env, body);
    t.equal(r.status, 409, `${r.status} ${r.text.slice(0, 200)}`); t.equal(r.json.code, "payload_mismatch");
    untouched(mfl);
    // the offer is intact and still acceptable, exactly as stored
    const ok = await accept(env, desktopBody(o.id, o.payload));
    t.equal(ok.status, 200); t.equal(acceptCount(mfl), 1);
  });
}

test("IGNORED (not identity): an asset's salary / contract text / taxi flag as the CLIENT renders it never matters — the accept goes through and only stored + live values apply", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  const drifted = clone(o.payload);
  drifted.teams[0].selected_assets[0].salary = 1; drifted.teams[0].selected_assets[0].contract_info = "CL 1; TCV 1; AAV 1";
  drifted.teams[0].selected_assets[0].contract_length = 1; drifted.teams[0].selected_assets[0].taxi = true;
  drifted.teams[1].selected_assets[0].asset_id = "player:13100";           // the deployed desktop renders ids differently
  const r = await accept(env, desktopBody(o.id, drifted));
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(acceptCount(mfl), 1);
  const adj = mfl.writes("salaryAdj");
  t.equal(adj.length, 1);
  t.match(adj[0].fields.DATA, /franchise_id="0001" amount="1000"/); t.match(adj[0].fields.DATA, /franchise_id="0002" amount="-1000"/);   // the STORED cap money, not the drifted salary
});

test("TAMPER (desktop shape) — the loose claims: offer_will_give_up / offer_will_receive / offer_extension_requests / offer_twb_meta.ext", async () => {
  for (const over of [
    { offer_will_give_up: "14056,16614" }, { offer_will_receive: "13100,15000" },
    { offer_extension_requests: [{ player_id: "14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "1YR" }] },
    { offer_twb_meta: { ext: [{ player_id: "13100", from_franchise_id: "0002", to_franchise_id: "0001", extension_term: "3YR" }] } },
  ]) {
    const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
    const r = await accept(env, desktopBody(o.id, o.payload, over));
    t.equal(r.status, 409); t.equal(r.json.code, "payload_mismatch");
    untouched(mfl);
  }
});

test("TAMPER (mobile shape + injected content) — an attacker adding a payload to the mobile request is refused the same way", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  const evil = clone(o.payload); evil.teams[0].selected_assets.push(player(16614));
  const r = await accept(env, { ...mobileBody(o.id), payload: evil });
  t.equal(r.status, 409); t.equal(r.json.code, "payload_mismatch");
  untouched(mfl);
  const r2 = await accept(env, { ...mobileBody(o.id), offer_extension_requests: [{ player_id: "13100", extension_term: "1YR" }] });
  t.equal(r2.status, 409); untouched(mfl);
  t.equal((await accept(env, mobileBody(o.id))).status, 200);
});

test("TAMPER — the client cannot point the accept at a DIFFERENT stored offer (comment / outbox id / trade id are not trusted)", async () => {
  const { env, mfl } = fresh(); const a = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  const evil = payloadOf("0001", "0002", [player(14056)], [player(13100)], { fromCapK: 2 });
  const r = await accept(env, desktopBody(a.id, evil, { offer_comment: "UPS_OUTBOX_ID:999 UPS_PAYLOAD_HASH:deadbeef", offer_raw_comment: "[UPS_TWB_INTENT_BEGIN]\nUPS_OUTBOX_ID:999\n[UPS_TWB_INTENT_END]", outbox_id: "999" }));
  t.equal(r.status, 409); t.equal(r.json.code, "payload_mismatch");
  untouched(mfl);
});

test("STALE: a payload hash from another version of the offer is refused (trailer mode)", async () => {
  const { env, mfl } = fresh({ env: { TWB_INCLUDE_COMMENT_META: "1" } }); const o = await sendOffer(env, mfl, RICH());
  t.match(mfl.st.pending[0].comments, /UPS_PAYLOAD_HASH:/);
  const stale = await accept(env, desktopBody(o.id, o.payload, { payload_hash: "0".repeat(64) }));
  t.equal(stale.status, 409); t.equal(stale.json.code, "payload_mismatch"); untouched(mfl);
  const ok = await accept(env, desktopBody(o.id, o.payload));
  t.equal(ok.status, 200, ok.text.slice(0, 200)); t.equal(acceptCount(mfl), 1);
});

// ══════════════════════════════ authority is the stored offer, not the client ══════════════════════════════
test("AUTHORITY: a legit accept uses the STORED offer — a client that sends nothing gets the stored cap money", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)], { fromCapK: 2 }));
  t.equal((await accept(env, mobileBody(o.id))).status, 200);
  t.equal(mfl.writes("salaryAdj").length, 1);
  t.match(mfl.writes("salaryAdj")[0].fields.DATA, /2/);
});
test("AUTHORITY: a native MFL offer with no stored record is accepted from what MFL holds (no extensions can be invented)", async () => {
  const { env, mfl } = fresh();
  const id = mfl.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,", will_receive: "13100," });
  const r = await accept(env, mobileBody(id));
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(acceptCount(mfl), 1);
  t.equal(mfl.writes("salaryAdj").length, 0);
  const { env: e2, mfl: m2 } = fresh();
  const id2 = m2.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,", will_receive: "13100," });
  const evil = await accept(e2, desktopBody(id2, payloadOf("0001", "0002", [player(14056)], [player(13100)], { ext: [{ player_id: "14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "1YR", new_TCV: 5000 }] })));
  t.equal(evil.status, 409); t.equal(evil.json.code, "payload_mismatch"); untouched(m2);
});
test("AUTHORITY: a stored record that no longer matches MFL is never used — its cap money/extensions are not applied", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)], { fromCapK: 2 }));
  // someone edits the saved copy to move different assets/cap money than MFL holds
  const row = env.UPS_MFL_DB.raw.prepare("SELECT id, payload_json FROM twb_trade_outbox WHERE action_type='SUBMIT'").get();
  const p = JSON.parse(row.payload_json); p.teams[0].traded_salary_adjustment_k = 40; p.teams[0].selected_assets.push(player(16614));
  env.UPS_MFL_DB.raw.prepare("UPDATE twb_trade_outbox SET payload_json=? WHERE id=?").run(JSON.stringify(p), row.id);
  const r = await accept(env, mobileBody(o.id));
  t.equal(r.status, 200, r.text.slice(0, 200));
  const adj = mfl.writes("salaryAdj");
  t.equal(adj.length, 1); t.doesNotMatch(adj[0].fields.DATA, /40/);       // MFL's own cap money (2) is what applied
  // ...and with an extension inside the tampered record, the accept is refused outright
  const { env: e2, mfl: m2 } = fresh(); const o2 = await sendOffer(e2, m2, payloadOf("0001", "0002", [player(14056)], [player(13100)]));
  const row2 = e2.UPS_MFL_DB.raw.prepare("SELECT id, payload_json FROM twb_trade_outbox WHERE action_type='SUBMIT'").get();
  const p2 = JSON.parse(row2.payload_json); p2.teams[0].selected_assets.push(player(16614)); p2.extension_requests = [{ player_id: "14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "1YR" }];
  e2.UPS_MFL_DB.raw.prepare("UPDATE twb_trade_outbox SET payload_json=? WHERE id=?").run(JSON.stringify(p2), row2.id);
  const r2 = await accept(e2, mobileBody(o2.id));
  t.equal(r2.status, 409); t.equal(r2.json.code, "stored_offer_mismatch"); untouched(m2);
});

// ══════════════════════════════ revalidation at action time (fail closed) ══════════════════════════════
test("REVALIDATE: a player who moved after the offer was sent blocks the accept", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  mfl.st.rosters["0001"] = []; mfl.st.rosters["0003"].push("14056");
  const r = await accept(env, mobileBody(o.id));
  t.equal(r.status, 409); t.equal(r.json.code, "asset_ownership_mismatch"); t.equal(r.json.ownership_mismatches[0].kind, "player");
  untouched(mfl);
});
test("REVALIDATE: a future pick that moved blocks the accept", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  mfl.st.futurePicks["0001"] = mfl.st.futurePicks["0001"].filter((p) => !(p.year === 2027 && p.round === 1));
  const r = await accept(env, mobileBody(o.id));
  t.equal(r.status, 409); t.equal(r.json.code, "asset_ownership_mismatch"); t.equal(r.json.ownership_mismatches[0].kind, "future_pick");
  untouched(mfl);
});
test("REVALIDATE: a current-year pick that was already used, or moved, blocks the accept", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  mfl.st.draftPicks.find((p) => p.round === "1" && p.pick === "4").player = "99999";
  const r = await accept(env, mobileBody(o.id));
  t.equal(r.status, 409); t.equal(r.json.ownership_mismatches[0].kind, "draft_pick"); untouched(mfl);
  const { env: e2, mfl: m2 } = fresh(); const o2 = await sendOffer(e2, m2, RICH());
  m2.st.draftPicks.find((p) => p.round === "1" && p.pick === "4").franchise = "0003";
  t.equal((await accept(e2, mobileBody(o2.id))).status, 409); untouched(m2);
});
test("REVALIDATE: a future pick beyond current year + 1 is refused; a round-6 pick is refused", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056), fpick("0001", 2029, 1)], [player(13100)]));
  const r = await accept(env, mobileBody(o.id));
  t.equal(r.status, 409); t.equal(r.json.code, "pick_not_tradeable"); untouched(mfl);
  const { env: e2, mfl: m2 } = fresh();
  const id = m2.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,FP_0001_2027_6", will_receive: "13100," });
  const r2 = await accept(e2, mobileBody(id));
  t.ok([400, 409].includes(r2.status), `status ${r2.status}`); untouched(m2);
});
test("REVALIDATE: cap money over 50% of the traded-away NON-TAXI salary is refused (a taxi player's salary doesn't count)", async () => {
  const { env, mfl } = fresh();
  const id = mfl.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,BB_3000", will_receive: "13100," });      // 3K of 5K → over 50%
  const r = await accept(env, mobileBody(id));
  t.equal(r.status, 409); t.equal(r.json.code, "cap_money_rule"); untouched(mfl);
  const { env: e2, mfl: m2 } = fresh({ rosters: { "0001": [{ id: "14056", salary: 8000, status: "TAXI_SQUAD" }] } });
  const id2 = m2.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,BB_1000", will_receive: "13100," });   // taxi salary excluded → max 0
  t.equal((await accept(e2, mobileBody(id2))).status, 409); untouched(m2);
  const { env: e3, mfl: m3 } = fresh();
  const id3 = m3.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "14056,BB_2000", will_receive: "13100," });      // exactly 50% → legal
  t.equal((await accept(e3, mobileBody(id3))).status, 200);
});
test("REVALIDATE: cap money with no player or pick on that side is refused", async () => {
  const { env, mfl } = fresh();
  const id = mfl.addPending({ offeringteam: "0001", offeredto: "0002", will_give_up: "BB_1000", will_receive: "13100," });
  const r = await accept(env, mobileBody(id));
  t.ok([400, 409].includes(r.status), `status ${r.status}`); untouched(mfl);
});
test("REVALIDATE: if MFL cannot confirm rosters / picks the accept FAILS CLOSED (503) and writes nothing", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  const real = globalThis.fetch;
  for (const type of ["rosters", "futureDraftPicks", "draftResults"]) {
    globalThis.fetch = async (u, i) => (new RegExp(`TYPE=${type}`).test(String(u)) ? { ok: false, status: 502, headers: new Headers(), text: async () => "bad gateway", json: async () => ({}) } : real(u, i));
    const r = await accept(env, mobileBody(o.id));
    t.equal(r.status, 503, `${type}: ${r.status}`); t.equal(r.json.code, "unavailable");
    untouched(mfl);
  }
  globalThis.fetch = real;
  t.equal((await accept(env, mobileBody(o.id))).status, 200);
});
test("REVALIDATE: if the saved-offer store (D1) is unavailable the accept fails closed and MFL is never called", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  env.TWB_OUTBOX_DB = { prepare: () => { throw new Error("D1_ERROR: simulated"); }, exec: async () => { throw new Error("D1_ERROR: simulated"); } };
  const r = await accept(env, mobileBody(o.id));
  t.equal(r.status, 503); t.doesNotMatch(r.text, /D1_ERROR|simulated/); untouched(mfl);
});
test("REVALIDATE: a promised extension is priced at CREATION and again at the accept — a non-canonical offer is never stored; a contract that moved on blocks the accept", async () => {
  // (a) creation: garbled / non-canonical stored terms are refused before anything is stored or sent to MFL
  { const { env, mfl } = fresh(); mfl.st.salaries = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
    const bad = [{ player_id: "14056", player_name: "P14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "2YR", option_key: "K", new_TCV: 15000, new_aav_future: 5000, new_contract_length: 3, preview_contract_info_string: "CL 3; TCV 15000; AAV 5000" }];
    const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "", payload: payloadOf("0001", "0002", [player(14056)], [player(13100)], { ext: bad }) } });
    t.equal(r.status, 409, r.text.slice(0, 200)); t.equal(r.json.code, "extension_terms_stale"); t.equal(mfl.st.pending.length, 0, "nothing was sent to MFL");
    t.equal(env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='twb_trade_outbox'").get().n, 0, "and nothing was stored (the outbox table was never even created)"); }
  // (b) accept: a canonical offer whose player's contract then moved on is a stale price
  { const { env, mfl } = fresh();
    const ext = [{ player_id: "14056", player_name: "P14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "2YR", option_key: "2YR|NONE", new_contract_status: "EXT2", new_TCV: 55000, new_aav_future: 25000, new_contract_length: 3, preview_contract_info_string: "CL 3| TCV 55K| AAV 5K, 25K| Y1-5K, Y2-25K, Y3-25K" }];
    mfl.st.salaries = [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
    const o = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056)], [player(13100)], { ext }));
    mfl.st.salaries = [{ id: "14056", salary: "7000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 7K|AAV 7K|Y1-7K" }];
    const r = await accept(env, mobileBody(o.id));
    t.equal(r.status, 409); t.equal(r.json.code, "extension_terms_stale"); untouched(mfl); }
});

// ══════════════════════════════ staleness, idempotency, concurrency ══════════════════════════════
test("STALE: after a counter-offer the original can't be accepted (it was rejected in MFL); the new offer is a new trade id", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  const counter = payloadOf("0002", "0001", [player(13100)], [player(14056)]);
  const c = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "COUNTER", trade_id: o.id, league_id: "74598", franchise_id: "0002", year: "2026", counter_offer: { from_franchise_id: "0002", to_franchise_id: "0001", payload: counter } } });
  t.equal(c.status, 200, c.text.slice(0, 200));
  const replay = await accept(env, mobileBody(o.id));
  t.equal(replay.status, 409); t.equal(replay.json.code, "offer_not_pending");
  t.equal(acceptCount(mfl), 0);
});
test("IDEMPOTENT: accepting twice is ONE execution; the repeat is told the truth (already executed), and a finished trade can't be revived", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  t.equal((await accept(env, mobileBody(o.id))).status, 200);
  const again = await accept(env, mobileBody(o.id));
  t.equal(again.status, 200); t.equal(again.json.already, true); t.equal(again.json.executed, true); t.equal(again.json.execution_state, "completed");
  t.equal(acceptCount(mfl), 1); t.equal(mfl.writes("salaryAdj").length, 1, "no second contract/adjustment import either");
  // a stranger can't learn about it, and PREVIEW of an executed trade says so
  const other = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-O`, { body: { ...mobileBody(o.id), franchise_id: "0003" } });
  t.equal(other.status, 409); t.equal(other.json.code, "offer_not_pending"); t.equal(other.json.execution_state, undefined, "an unrelated team learns nothing about the ledger");
  const pv = await accept(env, { ...mobileBody(o.id), action: "PREVIEW" });
  t.equal(pv.status, 409); t.equal(pv.json.code, "already_executed");
});
test("CONCURRENT: two accepts with DIFFERENT payloads execute at most once, and only the stored content ever runs", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  let release; mfl.st.holdAccept = new Promise((r) => { release = r; });
  const evil = clone(o.payload); evil.teams[0].traded_salary_adjustment_k = 30;
  const a = accept(env, desktopBody(o.id, o.payload)), b = accept(env, desktopBody(o.id, evil)), c = accept(env, mobileBody(o.id));
  await new Promise((r) => setTimeout(r, 40)); release();
  const rs = await Promise.all([a, b, c]);
  t.equal(acceptCount(mfl), 1, "MFL accepted once");
  t.equal(rs[1].status, 409);                                   // the tampered one is refused outright
  t.ok(rs.filter((r) => r.status === 200).length <= 1);
  const adj = mfl.writes("salaryAdj");
  t.ok(adj.length <= 1); if (adj.length) t.doesNotMatch(adj[0].fields.DATA, /30/);
});

// ══════════════════════════════ failures never leave a false 'completed' ══════════════════════════════
test("FAILURE: an MFL accept failure is a 502, the offer stays pending, nothing is imported, and a retry succeeds once", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  mfl.st.failNext = { type: "tradeResponse", status: 500 };
  const r = await accept(env, mobileBody(o.id));
  t.ok(r.status >= 500); t.notEqual(r.json && r.json.ok, true);
  t.equal(mfl.st.pending.length, 1); t.equal(mfl.st.done.length, 0); t.equal(mfl.writes("salaryAdj").length, 0);
  const verified = env.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) AS n FROM twb_trade_outbox WHERE action_type='ACCEPT' AND status='VERIFIED'").get().n;
  t.equal(verified, 0, "no VERIFIED accept row after a failed MFL write");
  const ok = await accept(env, mobileBody(o.id));
  t.equal(ok.status, 200); t.equal(acceptCount(mfl), 1);
});
test("FAILURE: a failed cap-money import after MFL accepted is reported as EXECUTED-NEEDS-REVIEW (never as success, never as 'not executed'); a repeat is a truthful answer, not a second accept", async () => {
  const { env, mfl } = fresh(); const o = await sendOffer(env, mfl, RICH());
  mfl.st.failNext = { type: "salaryAdj", status: 500 };
  const r = await accept(env, mobileBody(o.id));
  t.equal(r.status, 200); t.equal(r.json.executed, true); t.equal(r.json.needs_review, true); t.equal(r.json.execution_state, "executed_needs_review"); t.equal(r.json.failed_step, "salary_adjustments");
  t.match(r.json.message, /WAS executed in MFL/);
  t.equal(acceptCount(mfl), 1);
  const again = await accept(env, mobileBody(o.id));
  t.equal(again.status, 200); t.equal(again.json.already, true); t.equal(again.json.needs_review, true); t.equal(acceptCount(mfl), 1);
});

await run("trade_2way_accept_integrity");
restore();
