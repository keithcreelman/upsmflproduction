// PRE-TRADE EXTENSION INTEGRITY — from the stored trade, through the accept, to the MFL request. The REAL worker on real SQLite,
// MFL stubbed at the edge (a stateful `salaries` export that applies the worker's TYPE=salaries import exactly as MFL would).
//   node tests/trade_extension_integrity.test.mjs
//
// What this proves (and, in the LIMITS test, what it cannot):
//   • the extension that is applied is the one in the STORED trade, traced byte-for-byte into the MFL request
//   • the accept request cannot replace it (a different extension is refused; an omitted one is ignored, the stored one runs)
//   • an extension that is no longer eligible is refused BEFORE any MFL call
//   • an extension that fails to apply can never leave the trade recorded as completed
//   • the 3-way accept gate refuses an ineligible extension the same way
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, bindSelf, quiet } from "./fixtures/worker_harness.mjs";
import * as F from "./fixtures/trade_3way_fixture.mjs";
await import("./fixtures/register_md_loader.mjs");
const { handle3WayButton } = await import("../worker/src/trade_3way.js");

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const clone = (o) => JSON.parse(JSON.stringify(o));
const player = (pid, salary = 5000) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false, contract_info: "" });

// The live contract MFL holds for 14056 (a final-year, flat $5K deal), in the shape of MFL's `salaries` export …
const LIVE = () => [{ id: "14056", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
// … and the extension the builder stored with the offer (the row shape both builders emit) — at the CANONICAL price (canon §C4): WR = Schedule 1,
// 2 years = +$20K on the $5K AAV → $25K for both extension years; the current year stays $5K; TCV $5K + $25K + $25K = $55K; CL 3.
const EXT = () => [{
  player_id: "14056", player_name: "P14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "2YR", option_key: "2YR|NONE", loaded_indicator: "NONE",
  new_contract_status: "EXT2", new_TCV: 55000, new_aav_future: 25000, new_contract_length: 3, preview_contract_info_string: "CL 3| TCV 55K| AAV 5K, 25K| Y1-5K, Y2-25K, Y3-25K",
}];
// The exact MFL request the accept must produce for that stored extension (TYPE=salaries, APPEND=1, this DATA): the CANONICAL contract —
// contractYear = the new length (MFL's contractYear is YEARS REMAINING), the AAV token "current, future", the extender's Ext: lineage, GTD = 75% of the TCV.
const CANON_INFO = "CL 3|TCV 55K|AAV 5K, 25K|Y1-5K, Y2-25K, Y3-25K|Ext: L.A.|GTD: 41.3K";
const EXPECTED_XML = `<salaries><leagueUnit unit="LEAGUE"><player id="14056" salary="5000" contractYear="3" contractInfo="${CANON_INFO}" contractStatus="Vet-Ext2" /></leagueUnit></salaries>`;
const payloadOf = (ext) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [{ role: "left", franchise_id: "0001", selected_assets: [player(14056)], traded_salary_adjustment_k: 0 }, { role: "right", franchise_id: "0002", selected_assets: [player(13100)], traded_salary_adjustment_k: 0 }],
  extension_requests: ext || [], ui: { left_team_id: "0001", right_team_id: "0002" }, validation: { status: "ready" },
});
function fresh() {
  const env = makeWorkerEnv(); const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install();
  mfl.st.salaries = LIVE();
  return { env, mfl };
}
async function sendOffer(env, mfl, payload) {
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", message: "", payload } });
  t.ok(r.status < 300, `offer sent ${r.status}`);
  return mfl.st.pending[mfl.st.pending.length - 1].trade_id;
}
const mobileBody = (id, o) => ({ action: "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "", ...(o || {}) });
const desktopBody = (id, p, o) => ({
  league_id: "74598", season: "2026", offer_id: id, proposal_id: id, trade_id: id, action: "ACCEPT", message: "", acting_franchise_id: "0002", payload: clone(p),
  offer_comment: "", offer_comments: "", offer_notes: "", offer_raw_comment: "", offer_message: "", offer_twb_meta: null, offer_extension_requests: clone(p.extension_requests || []),
  offer_from_franchise_id: "0001", offer_to_franchise_id: "0002", offer_will_give_up: "", offer_will_receive: "", direct_mfl: true, ...(o || {}),
});
const act = (env, body) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body });
const outbox = (env) => env.UPS_MFL_DB.raw.prepare("SELECT id, action_type, status, payload_xml_extensions, payload_json FROM twb_trade_outbox ORDER BY rowid").all();
const untouched = (mfl, env, label) => {
  t.equal(mfl.st.done.length, 0, `${label}: MFL never accepted`); t.equal(mfl.st.pending.length, 1, `${label}: still pending`);
  t.equal(mfl.writes("tradeResponse").length, 0, `${label}: no tradeResponse`); t.equal(mfl.writes("salaries").length, 0, `${label}: no contract import`);
  t.equal(outbox(env).filter((r) => r.action_type === "ACCEPT").length, 0, `${label}: no ACCEPT row`);
};

test("TRACE: the stored trade's extension → the accept's MFL requests, byte for byte, in the right order", async () => {
  const { env, mfl } = fresh();
  const id = await sendOffer(env, mfl, payloadOf(EXT()));
  const stored = outbox(env).find((r) => r.action_type === "SUBMIT");
  t.deepEqual(JSON.parse(stored.payload_json).extension_requests.map((x) => [x.player_id, x.preview_contract_info_string]), [["14056", "CL 3| TCV 55K| AAV 5K, 25K| Y1-5K, Y2-25K, Y3-25K"]], "the extension is in the stored trade");
  t.equal(stored.payload_xml_extensions, EXPECTED_XML, "and its MFL XML was built at send time from that stored row");
  const r = await act(env, mobileBody(id));                                           // mobile sends NOTHING about the extension
  t.equal(r.status, 200, r.text.slice(0, 300)); t.equal(r.json.ok, true); t.equal(r.json.extensions.ok, true);
  const order = mfl.st.imports.filter((i) => ["tradeResponse", "salaries", "salaryAdj"].includes(i.type)).map((i) => i.type);
  t.equal(order[0], "tradeResponse", "MFL's accept comes first; the contract import follows it");
  const sal = mfl.writes("salaries");
  t.ok(sal.length >= 1);
  t.equal(sal[0].fields.DATA, EXPECTED_XML, "the salaries import DATA is exactly the stored extension's contract");
  t.equal(sal[0].fields.APPEND, "1"); t.equal(sal[0].fields.L, "74598");
  // MFL now holds the new contract for the player (the stateful export applied the import)
  t.equal(mfl.st.salaries[0].contractInfo, CANON_INFO); t.equal(mfl.st.salaries[0].contractStatus, "Vet-Ext2"); t.equal(mfl.st.salaries[0].contractYear, "3");
  const acc = outbox(env).find((x) => x.action_type === "ACCEPT");
  t.ok(acc, "the accept is recorded"); t.equal(acc.payload_xml_extensions, EXPECTED_XML, "the recorded accept carries the same XML");
});

test("REPLACE: the accept request cannot substitute a different extension — every variant is refused and nothing is imported", async () => {
  const { env, mfl } = fresh();
  const id = await sendOffer(env, mfl, payloadOf(EXT()));
  const variants = {
    "a longer/richer extension (TCV, length, info)": (x) => { x.new_TCV = 40000; x.new_contract_length = 5; x.preview_contract_info_string = "CL 5| TCV 40K| AAV 8K| Y1-8K, Y2-8K, Y3-8K, Y4-8K, Y5-8K"; },
    "a different term": (x) => { x.extension_term = "1YR"; x.option_key = "1YR"; },
    "a different loaded contract status": (x) => { x.new_contract_status = "Vet-Ext2-FL"; x.option_key = "2YR|FL"; x.extension_term = "2YR-FL"; },
    "a different player": (x) => { x.player_id = "13100"; x.from_franchise_id = "0002"; x.to_franchise_id = "0001"; },
    "a different direction": (x) => { x.from_franchise_id = "0002"; x.to_franchise_id = "0001"; },
  };
  for (const [name, mutate] of Object.entries(variants)) {
    const p = payloadOf(EXT()); mutate(p.extension_requests[0]);
    for (const [shape, body] of Object.entries({
      "desktop payload": desktopBody(id, p),
      "offer_extension_requests claim": mobileBody(id, { offer_extension_requests: clone(p.extension_requests) }),
      "offer_twb_meta.ext claim": mobileBody(id, { offer_twb_meta: { ext: clone(p.extension_requests) } }),
    })) {
      const r = await act(env, body);
      t.equal(r.status, 409, `${name} / ${shape}`); t.equal(r.json.code, "payload_mismatch", `${name} / ${shape}`);
      untouched(mfl, env, `${name} / ${shape}`);
    }
  }
  // an extension smuggled into an offer that has none is refused too
  const bare = fresh(); const bid = await sendOffer(bare.env, bare.mfl, payloadOf([]));
  const inj = await act(bare.env, desktopBody(bid, payloadOf(EXT())));
  t.equal(inj.status, 409); t.equal(inj.json.code, "payload_mismatch"); untouched(bare.mfl, bare.env, "injected extension");
  // …and after all that, a clean accept applies the STORED extension, nothing else
  mfl.install();                                                                     // (the bare world above had installed its own MFL stub)
  const ok = await act(env, mobileBody(id));
  t.equal(ok.status, 200, ok.text.slice(0, 200)); t.equal(mfl.writes("salaries")[0].fields.DATA, EXPECTED_XML);
  t.ok(mfl.writes("salaries").every((w) => w.fields.DATA === EXPECTED_XML), "every contract import (incl. retries) is the stored extension");
});

test("REPLACE: a client that OMITS the extension does not remove it — the stored one still runs", async () => {
  const { env, mfl } = fresh();
  const id = await sendOffer(env, mfl, payloadOf(EXT()));
  const stripped = payloadOf([]);                                                    // desktop payload with the extension deleted
  const r = await act(env, desktopBody(id, stripped, { offer_extension_requests: [] }));
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.writes("salaries")[0].fields.DATA, EXPECTED_XML);
});

test("ELIGIBILITY: an extension that is no longer eligible / priced the same is refused BEFORE any MFL call (contract moved on / authority unreadable)", async () => {
  for (const [name, [status, code], breakIt] of [
    ["the live contract changed after the offer (the current salary moved → the stored price is stale)", [409, "extension_terms_stale"], (m) => { m.st.salaries = [{ id: "14056", salary: "12000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 12K|AAV 12K|Y1-12K" }]; }],
    ["the contracts export is unavailable (fail closed, retry later)", [503, "extension_check_unavailable"], (m) => { m.st.exportFail = { salaries: 503 }; }],
    ["the player has no contract row at all (fail closed)", [409, "extension_no_longer_eligible"], (m) => { m.st.salaries = []; }],
    ["the player is no longer in his final year (3 years left)", [409, "extension_no_longer_eligible"], (m) => { m.st.salaries = [{ id: "14056", salary: "5000", contractYear: "3", contractStatus: "Vet-FAA", contractInfo: "CL 3|TCV 15K|AAV 5K|Y1-5K, Y2-5K, Y3-5K" }]; }],
    ["the live contract year is unreadable (fail closed)", [503, "extension_check_unavailable"], (m) => { m.st.salaries = [{ id: "14056", salary: "5000", contractYear: "", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }]; }],
    ["the position authority is unreadable (his schedule is unknown → fail closed)", [503, "extension_check_unavailable"], (m) => { m.st.exportFail = { players: 503 }; }],
    ["the player's position is not one the schedule prices (fail closed, never assumed)", [503, "extension_check_unavailable"], (m) => { m.st.positions = { "14056": "TM" }; }],
  ]) {
    const { env, mfl } = fresh();
    const id = await sendOffer(env, mfl, payloadOf(EXT()));
    breakIt(mfl);
    const r = await act(env, mobileBody(id));
    t.equal(r.status, status, `${name}: ${r.text.slice(0, 150)}`); t.equal(r.json.code, code, name);
    t.ok(Array.isArray(r.json.skipped) && r.json.skipped.length === 1 && r.json.skipped[0].player_id === "14056", `${name}: the refusal names the player`);
    untouched(mfl, env, name);
  }
});

test("FAILURE: an extension that fails to apply after MFL accepted is reported as a FAILURE and the trade is never recorded as completed", async () => {
  { const { env, mfl } = fresh();
    const id = await sendOffer(env, mfl, payloadOf(EXT()));
    mfl.st.failNext = { type: "salaries", status: 500 };
    const r = await act(env, mobileBody(id));
    t.equal(r.status, 200); t.equal(r.json.executed, true); t.equal(r.json.needs_review, true); t.equal(r.json.execution_state, "executed_needs_review"); t.equal(r.json.failed_step, "extensions");
    t.equal(r.json.warning.error_type, "salary_contract_import_failure");
    t.equal(mfl.st.done.length, 1, "MFL's own accept had already landed (that part cannot be undone)");
    t.equal(outbox(env).filter((x) => ["VERIFIED", "COMPLETED"].includes(x.status)).length, 0, "…but nothing is recorded as verified/completed");
    const again = await act(env, mobileBody(id));
    t.equal(again.status, 200); t.equal(again.json.already, true); t.equal(again.json.needs_review, true); t.equal(mfl.st.done.length, 1, "a retry cannot accept twice"); }
  { // MFL ACKs the import but the contract does not change (verification fails) → still a failure, never a success
    const { env, mfl } = fresh(); mfl.st.salariesImportIgnored = true;
    const id = await sendOffer(env, mfl, payloadOf(EXT()));
    const r = await act(env, mobileBody(id));
    t.equal(r.status, 200); t.equal(r.json.needs_review, true); t.equal(r.json.execution_state, "executed_needs_review"); t.equal(r.json.failed_step, "extensions");
    t.equal(outbox(env).filter((x) => ["VERIFIED", "COMPLETED"].includes(x.status)).length, 0); }
});

// ── 3-way: the same eligibility rule at the accept gate ──────────────────────────────────────────────────
test("3-WAY: a pre-trade extension that is no longer eligible refuses the Discord accept (not recorded) — it is never silently dropped", async () => {
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: "0" }); const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install(); bindSelf(env);
  for (const [fid, d] of [["0008", F.DISCORD.A], ["0001", F.DISCORD.B], ["0012", F.DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", d);
  const ext3 = [{ player_id: "16614", player_name: "P16614", from_franchise_id: "0008", to_franchise_id: "0001", applies_to_acquirer: true, option_key: "2YR|NONE", extension_term: "2YR", loaded_indicator: "NONE",
    new_contract_status: "EXT2", new_contract_length: 3, new_TCV: 55000, new_aav_future: 25000, preview_contract_info_string: "CL 3| TCV 55K| AAV 5K, 25K| Y1-5K, Y2-25K, Y3-25K" }];
  F.seedTrade(env, { legs_json: JSON.stringify([{ from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0 }, { from: "0001", to: "0012", asset_tokens: ["P_16181"], cap_k: 0 }, { from: "0012", to: "0008", asset_tokens: ["P_16650"], cap_k: 0 }]), extension_requests_json: JSON.stringify(ext3) });
  mfl.st.rosters = { "0008": [{ id: "16614", salary: 5000 }], "0001": [{ id: "16181", salary: 5000 }], "0012": [{ id: "16650", salary: 5000 }] };
  const press = (a, u) => ({ data: { custom_id: `tr3:${a}:${F.TRADE_ID}` }, member: { user: { id: u } } });
  const say = async (r) => (await r.json()).data.content;
  // (a) eligible → the accept is recorded
  mfl.st.salaries = [{ id: "16614", salary: "5000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }];
  const good = await say(await handle3WayButton(press("accept", F.DISCORD.B), env, { waitUntil() {} }));
  t.match(good, /You're in/); t.equal(F.readRow(env).team_b_state, "accepted");
  // (b) the live contract moved on → the next accept is refused, with the reason, and nothing changes
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_3way_trades SET team_c_state='pending'").run();
  mfl.st.salaries = [{ id: "16614", salary: "12000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 12K|AAV 12K|Y1-12K" }];
  const bad = await say(await handle3WayButton(press("accept", F.DISCORD.C), env, { waitUntil() {} }));
  t.match(bad, /price of a pre-trade extension in this trade no longer matches the player's current contract/); t.match(bad, /wasn't recorded/);
  t.equal(F.readRow(env).team_c_state, "pending"); t.equal(F.readRow(env).status, "collecting"); t.equal(mfl.writes().length, 0);
});

test("LIMITS (documented, not testable without a live destructive transaction): MFL's real salaries-import response body and the real-money effect are stubbed", () => {
  // This suite proves the worker's side end to end: which extension is applied, the exact request it sends, its ordering after MFL's
  // accept, and what it records when the import or its verification fails. It cannot prove how MFL's production servers respond to
  // that request — the request shape (TYPE=salaries, APPEND=1, <salaries><leagueUnit unit="LEAGUE"><player …/>) is the one the worker's
  // existing production path already sends; the stub applies it the way MFL's documented import does. No production extension was run.
  t.ok(true);
});

await run("trade_extension_integrity");
restore();
