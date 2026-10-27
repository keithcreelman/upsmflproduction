// Trade Builder core (read-only): draft -> compliance-preview request, and how the server verdict is shown.
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const C = require("../site/shared/trade_builder_core.js");
const ctx = { leagueId: "74598", season: "2026", viewerFid: "0003" };

function twoTeam() {
  let d = C.emptyDraft(["0003", "0007"]);
  d = C.addItem(d, { from: "0003", to: "0007", token: "P_1234", label: "WR One", salary: 21000 });
  d = C.addItem(d, { from: "0003", to: "0007", token: "P_9", label: "Taxi guy", salary: 5000, taxi: true });
  d = C.addItem(d, { from: "0007", to: "0003", token: "FP_0003_2027_1", label: "2027 1st" });
  return d;
}

test("movements group by pair and carry cap money", () => {
  let d = C.setCapK(twoTeam(), "0003", "0007", 4);
  const ms = C.movements(d);
  assert.deepEqual(ms.find((m) => m.from === "0003").tokens, ["P_1234", "P_9"]);
  assert.equal(ms.find((m) => m.from === "0003").cap_k, 4);
  assert.equal(ms.find((m) => m.from === "0007").cap_k, 0);
  assert.deepEqual(C.parties(d), ["0003", "0007"]);
});

test("request has the shape the compliance-preview route reads", () => {
  const r = C.request(twoTeam(), ctx);
  assert.deepEqual(Object.keys(r).sort(), ["extension_requests", "from_franchise_id", "league_id", "movements", "season"]);
  assert.equal(r.from_franchise_id, "0003");
  assert.ok(r.movements.every((m) => /^\d{4}$/.test(m.from) && /^\d{4}$/.test(m.to) && Array.isArray(m.tokens)));
});

test("cap-money hint is 50% of NON-TAXI player salary, rounded down", () => {
  assert.equal(C.capMoneyHintK(twoTeam(), "0003"), 10); // 21000 only, taxi 5000 excluded
  assert.equal(C.capMoneyHintK(twoTeam(), "0007"), 0);  // picks carry no salary
});

test("gaps: empty, cap money alone, one team, unknown token, three teams", () => {
  assert.equal(C.gaps(C.emptyDraft(["0003", "0007"]))[0].code, "no_assets");
  const moneyOnly = C.setCapK(C.emptyDraft(["0003", "0007"]), "0003", "0007", 3);
  assert.equal(C.gaps(moneyOnly)[0].code, "no_assets");
  assert.equal(C.signature(moneyOnly, ctx) !== "", true);
  assert.deepEqual(C.gaps(twoTeam()), []);
  let bad = C.addItem(C.emptyDraft(["0003", "0007"]), { from: "0003", to: "0007", token: "XX_1" });
  bad = C.addItem(bad, { from: "0007", to: "0003", token: "P_5" });
  assert.equal(C.gaps(bad)[0].code, "unknown_asset");
});

test("three-team ring is accepted structurally; a fourth team is refused", () => {
  let d = C.emptyDraft(["0003", "0007", "0011"]);
  d = C.addItem(d, { from: "0003", to: "0007", token: "P_1" });
  d = C.addItem(d, { from: "0007", to: "0011", token: "P_2" });
  d = C.addItem(d, { from: "0011", to: "0003", token: "P_3" });
  assert.deepEqual(C.gaps(d), []);
  assert.equal(C.parties(d).length, 3);
  assert.equal(C.gaps(C.withTeams(d, ["0003", "0007", "0011", "0015"])).some((g) => g.code === "too_many_teams"), true);
});

test("removing a team drops its assets and cap money", () => {
  let d = C.setCapK(twoTeam(), "0003", "0007", 4);
  d = C.withTeams(d, ["0003"]);
  assert.equal(d.items.length, 0);
  assert.deepEqual(d.capK, {});
});

test("signature ignores token order and padding; changes with cap money", () => {
  const a = C.signature(twoTeam(), ctx);
  let d = C.emptyDraft(["0003", "0007"]);
  d = C.addItem(d, { from: "0007", to: "0003", token: "FP_0003_2027_1" });
  d = C.addItem(d, { from: "0003", to: "0007", token: "P_9" });
  d = C.addItem(d, { from: "0003", to: "0007", token: "P_1234" });
  assert.equal(C.signature(d, ctx), a);
  assert.notEqual(C.signature(C.setCapK(d, "0003", "0007", 2), ctx), a);
  assert.equal(C.signature(C.emptyDraft(["0003", "0007"]), ctx), "");
});

test("readiness: never sendable, every server status maps, failures never read as a pass", () => {
  const prov = { ok: true, verdict: { status: "provisional", send_ready: false, checks: {}, reasons: [], trade_lock: { state: "upcoming", label: "Wed, Nov 25, 8:00 PM ET" } } };
  const r = C.readiness([], "done", prov);
  assert.equal(r.state, "provisional");
  assert.equal(r.canSend, false);
  assert.match(r.lock.text, /Nov 25, 8:00 PM ET/);
  // even a verdict that (wrongly) claims send_ready stays unsendable here
  assert.equal(C.readiness([], "done", { ok: true, verdict: { status: "provisional", send_ready: true } }).canSend, false);
  const blocked = C.readiness([], "done", { ok: true, verdict: { status: "blocked", reasons: [{ code: "loaded_contract_limit", message: "x" }, { code: "pick_forfeited" }], trade_lock: { state: "closed", label: "Wed" } } });
  assert.equal(blocked.state, "blocked");
  assert.match(blocked.reasons[0].text, /five loaded contracts/);
  assert.match(blocked.lock.text, /closed/);
  assert.equal(C.readiness([], "done", { ok: true, verdict: { status: "needs_acknowledgment", reasons: [] } }).state, "needs_ack");
  for (const bad of [null, {}, { ok: false }, { ok: true }, { ok: true, verdict: "x" }]) assert.equal(C.readiness([], "done", bad).state, "unavailable");
  assert.equal(C.readiness([], "checking").state, "checking");
  assert.equal(C.readiness([{ code: "no_assets", message: "m" }], "done", prov).state, "none");
});

test("lock view: unresolved or missing never shows a time", () => {
  for (const l of [null, { state: "unresolved" }, { state: "upcoming" }]) {
    const v = C.lockView(l); assert.equal(v.tone, "warn"); assert.match(v.text, /could not be confirmed/);
  }
  assert.equal(C.lockView({ state: "none" }).tone, "ok");
});

test("the lock is said once: its reason is not repeated in the list", () => {
  const r = C.readiness([], "done", { ok: true, verdict: { status: "blocked", reasons: [{ code: "trade_closed" }], trade_lock: { state: "closed", label: "Wed" } } });
  assert.equal(r.reasons.length, 0);
  assert.equal(r.state, "blocked");
  assert.match(r.lock.text, /closed/);
});

test("send step may be offered only for provisional / needs-acknowledgment verdicts", () => {
  const mk = (status) => C.readiness([], "done", { ok: true, verdict: { status, reasons: [] } });
  assert.equal(mk("provisional").canAttempt, true);
  assert.equal(mk("needs_acknowledgment").canAttempt, true);
  for (const s of ["blocked", "unavailable", "weird"]) assert.equal(mk(s).canAttempt, false);
  assert.equal(C.readiness([], "checking").canAttempt, false);
  assert.equal(C.readiness([{ code: "x", message: "m" }], "done", { ok: true, verdict: { status: "provisional" } }).canAttempt, false);
  assert.equal(mk("provisional").canSend, false);
});

test("send plan carries the checked movements and a trimmed, capped note; kind follows the party count", () => {
  const p = C.sendPlan(twoTeam(), ctx, "  hello\n  ");
  assert.equal(p.kind, "two_team");
  assert.equal(p.note, "hello");
  assert.deepEqual(p.movements, C.request(twoTeam(), ctx).movements);
  assert.equal(C.sendPlan(twoTeam(), ctx, "x".repeat(900)).note.length, 500);
  let d = C.emptyDraft(["0003", "0007", "0011"]);
  d = C.addItem(d, { from: "0003", to: "0007", token: "P_1" }); d = C.addItem(d, { from: "0007", to: "0011", token: "P_2" }); d = C.addItem(d, { from: "0011", to: "0003", token: "P_3" });
  assert.equal(C.sendPlan(d, ctx, "").kind, "three_team");
});

test("summary lines name who sends what to whom, with cap money", () => {
  const lines = C.summary(C.setCapK(twoTeam(), "0003", "0007", 4), (f) => ({ "0003": "Owls", "0007": "Foxes" })[f]);
  assert.match(lines.find((l) => l.from === "0003").text, /^Owls sends WR One, Taxi guy, \$4K cap money to Foxes$/);
});

test("structure: one-sided is INCOMPLETE; both sides sending is complete; one asset anywhere is not enough", () => {
  const empty = C.emptyDraft(["0003", "0007"]);
  assert.equal(C.gaps(empty)[0].code, "no_assets");
  const oneSided = C.addItem(empty, { from: "0003", to: "0007", token: "P_1" });
  const g = C.gaps(oneSided, (f) => ({ "0003": "Owls", "0007": "Foxes" })[f]);
  assert.deepEqual(g.map((x) => x.code), ["receives_nothing", "sends_nothing"]);
  assert.match(g[0].message, /^Owls is sending assets but receiving nothing/); assert.match(g[1].message, /^Foxes is receiving assets but sending nothing/);
  assert.deepEqual(C.gaps(C.addItem(oneSided, { from: "0007", to: "0003", token: "P_2" })), []);
  // only me chosen (no partner) with an asset: incomplete, not fine
  const solo = C.addItem(C.emptyDraft(["0003"]), { from: "0003", to: "0007", token: "P_1" });
  assert.equal(C.gaps(solo).some((x) => x.code === "choose_team"), true);
});

const three = (edges) => { let d = C.emptyDraft(["0003", "0007", "0011"]); edges.forEach(([f, to, tok]) => { d = C.addItem(d, { from: f, to, token: tok }); }); return d; };
const codes = (d) => C.gaps(d).map((x) => x.code + (x.fid ? ":" + x.fid : ""));

test("three teams, each sending AND receiving: complete (a ring, and a non-ring shape)", () => {
  assert.deepEqual(codes(three([["0003", "0007", "P_1"], ["0007", "0011", "P_2"], ["0011", "0003", "P_3"]])), []);
  // A<->B swap, plus C sends to A and A sends to C
  assert.deepEqual(codes(three([["0003", "0007", "P_1"], ["0007", "0003", "P_2"], ["0011", "0003", "P_3"], ["0003", "0011", "P_4"]])), []);
});
test("Keith's example: C sends Daniels and receives nothing = incomplete, naming C", () => {
  const d = three([["0003", "0007", "P_16614"], ["0007", "0003", "P_14760"], ["0011", "0003", "P_15281"]]);
  assert.deepEqual(codes(d), ["receives_nothing:0011"]);
  const g = C.gaps(d, (f) => ({ "0003": "Real Deal Creel", "0007": "Blake Bombers", "0011": "C-Town Chivalry" })[f]);
  assert.equal(g[0].message, "C-Town Chivalry is sending assets but receiving nothing.");
  const r = C.readiness(g, "done", { ok: true, verdict: { status: "provisional" } });
  assert.equal(r.label, "Incomplete trade"); assert.equal(r.canAttempt, false); assert.equal(r.lock, null);
});
test("one team receiving but sending nothing = incomplete, naming that team", () => {
  assert.deepEqual(codes(three([["0003", "0007", "P_1"], ["0007", "0003", "P_2"], ["0003", "0011", "P_3"]])), ["sends_nothing:0011"]);
});
test("a team that neither sends nor receives is idle; a lone sender and a lone receiver are both named", () => {
  assert.deepEqual(codes(three([["0003", "0007", "P_1"]])), ["receives_nothing:0003", "sends_nothing:0007", "team_idle:0011"]);
});
test("an asset with no valid destination is refused (outside the trade, or back to its sender)", () => {
  let d = three([["0003", "0007", "P_1"], ["0007", "0003", "P_2"], ["0011", "0003", "P_3"], ["0003", "0011", "P_4"]]);
  d.items = d.items.concat([{ from: "0003", to: "0099", token: "P_9", label: "Stray" }]);
  assert.equal(C.gaps(d).some((g) => g.code === "bad_destination"), true);
  const loop = three([["0003", "0007", "P_1"]]); loop.items.push({ from: "0007", to: "0007", token: "P_8", label: "Loop" });
  assert.equal(C.gaps(loop).some((g) => g.code === "bad_destination"), true);
});
test("removing an asset that made a complete three-team trade incomplete is caught immediately", () => {
  const d = three([["0003", "0007", "P_1"], ["0007", "0011", "P_2"], ["0011", "0003", "P_3"]]);
  assert.deepEqual(codes(d), []);
  assert.deepEqual(codes(C.removeItem(d, "P_3", "0011")), ["receives_nothing:0003", "sends_nothing:0011"]);   // ring broken: A gets nothing, C gives nothing
  assert.deepEqual(codes(C.removeItem(d, "P_1", "0003")), ["sends_nothing:0003", "receives_nothing:0007"]);
});
test("two-team trades: both teams must send; one-sided is incomplete for the same reason", () => {
  assert.deepEqual(codes(twoTeam()), []);
  const noTaxiOrWr = C.removeItem(C.removeItem(twoTeam(), "P_1234", "0003"), "P_9", "0003");        // 0003 now sends nothing, still receives a pick
  assert.deepEqual(codes(noTaxiOrWr), ["sends_nothing:0003", "receives_nothing:0007"]);
  const oneSided = C.addItem(C.emptyDraft(["0003", "0007"]), { from: "0003", to: "0007", token: "P_1" });
  assert.deepEqual(codes(oneSided), ["receives_nothing:0003", "sends_nothing:0007"]);
});
test("cap money never completes a trade: money-only, and money into a team that sends/receives no asset", () => {
  assert.equal(C.gaps(C.setCapK(C.emptyDraft(["0003", "0007"]), "0003", "0007", 5))[0].code, "no_assets");
  // C sends nothing and receives only cap money from A: still incomplete for C, and the money has no salary behind it from a team sending only picks
  let d = three([["0003", "0007", "P_1"], ["0007", "0003", "P_2"]]);
  d = C.setCapK(d, "0003", "0011", 3);
  assert.equal(codes(d).includes("team_idle:0011"), true);
  const held = C.clampCap(d);
  assert.equal(held.draft.capK["0003>0011"], undefined);          // no salary sent to C: no cap money allowed
});

test("readiness: empty = No trade proposed; incomplete = Incomplete trade; neither can ever read a server answer", () => {
  const prov = { ok: true, verdict: { status: "provisional", send_ready: false, reasons: [], trade_lock: { state: "upcoming", label: "x" } } };
  const none = C.readiness(C.gaps(C.emptyDraft(["0003", "0007"])), "done", prov);
  assert.equal(none.label, "No trade proposed"); assert.equal(none.canAttempt, false); assert.equal(none.lock, null);
  const inc = C.readiness(C.gaps(C.addItem(C.emptyDraft(["0003", "0007"]), { from: "0003", to: "0007", token: "P_1" })), "done", prov);
  assert.equal(inc.label, "Incomplete trade"); assert.equal(inc.state, "incomplete"); assert.equal(inc.canAttempt, false); assert.equal(inc.lock, null);
  assert.equal(C.readiness([], "idle").canAttempt, false);
});

test("readiness: calculated blocks beat a provisional server answer; calculated acknowledgments upgrade it; neither is ever positive", () => {
  const prov = { ok: true, verdict: { status: "provisional", reasons: [] } };
  const b = C.readiness([], "done", prov, { blocked: ["Foxes would have 6 loaded contracts (the limit is 5): blocked."], ack: [] });
  assert.equal(b.state, "blocked"); assert.equal(b.canAttempt, false); assert.match(b.reasons[0].text, /6 loaded/);
  const a = C.readiness([], "done", prov, { blocked: [], ack: ["Owls would be $2K over the cap."] });
  assert.equal(a.state, "needs_ack"); assert.equal(a.canAttempt, true);
  assert.equal(C.readiness([], "done", prov, { blocked: [], ack: [] }).state, "provisional");
});

test("a SAMPLE trade lock is always labeled as sample, never as the live calendar", () => {
  assert.match(C.lockView({ state: "upcoming", label: "Wed", sample: true }).text, /^SAMPLE DATA, not the live trade calendar: Trades close Wed/);
  assert.doesNotMatch(C.lockView({ state: "upcoming", label: "Wed" }).text, /SAMPLE/);
});

test("pre-trade extension choices: stored per player, dropped with the player, in the signature, and become the War Room's request row", () => {
  let d = twoTeam();
  const opts = (i) => (i.token === "P_1234" ? [{ option_key: "1YR|NONE", extension_term: "1YR", loaded_indicator: "NONE", preview_contract_info_string: "CL 2| TCV 5K", new_contract_status: "EXT1", new_contract_length: 2, new_TCV: 5000, new_aav_current: 1000, new_aav_future: 4000 }] : []);
  const sig0 = C.signature(d, ctx);
  d = C.setExt(d, "0003", "P_1234", "1YR|NONE");
  assert.notEqual(C.signature(d, ctx), sig0);
  const rows = C.extensionRequests(d, opts);
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].player_id, rows[0].from_franchise_id, rows[0].to_franchise_id, rows[0].option_key, rows[0].applies_to_acquirer], ["1234", "0003", "0007", "1YR|NONE", true]);
  assert.equal(C.sendPlan(d, ctx, "", rows).extension_requests.length, 1);
  assert.equal(C.request(d, ctx, rows).extension_requests[0].new_aav_future, 4000);
  assert.match(C.summary(d, (f) => f)[0].text, /with a proposed 1-year pre-trade extension, not yet approved/);
  assert.equal(C.extensionRequests(C.setExt(d, "0003", "P_1234", "9YR|NONE"), opts).length, 0);       // no such option: dropped
  assert.equal(Object.keys(C.removeItem(d, "P_1234", "0003").ext).length, 0);                         // player removed: choice removed
  assert.equal(Object.keys(C.setExt(d, "0003", "P_NOT_THERE", "1YR|NONE").ext).length, 1);           // unselected player: ignored
});

test("cap money maximum: half the NON-TAXI player salary sent, per side for two teams and per destination for three", () => {
  const two = twoTeam();                                    // 0003 sends $21K (non-taxi) + $5K taxi + a pick? (pick is from 0007)
  assert.equal(C.capMoneyMaxK(two, "0003", "0007"), 10);
  assert.equal(C.capMoneyMaxK(two, "0007", "0003"), 0);     // a pick carries no salary
  let d = C.emptyDraft(["0003", "0007", "0011"]);
  d = C.addItem(d, { from: "0003", to: "0007", token: "P_1", salary: 9999 });
  d = C.addItem(d, { from: "0003", to: "0011", token: "P_2", salary: 10000 });
  assert.equal(C.capMoneyMaxK(d, "0003", "0007"), 4);       // floor(9999 / 2000)
  assert.equal(C.capMoneyMaxK(d, "0003", "0011"), 5);
});
test("clampCap holds an amount to its maximum and drops it when nothing supports it", () => {
  let d = C.setCapK(twoTeam(), "0003", "0007", 25);
  const r = C.clampCap(d);
  assert.deepEqual(r.clamped, ["0003>0007"]); assert.equal(r.draft.capK["0003>0007"], 10);
  const gone = C.clampCap(C.setCapK(C.removeItem(twoTeam(), "P_1234", "0003"), "0003", "0007", 3));
  assert.equal(gone.draft.capK["0003>0007"], undefined);
  assert.deepEqual(C.clampCap(C.setCapK(twoTeam(), "0003", "0007", 10)).clamped, []);
});

// ── Pre-trade extension facts (Codex MAT-1 on #1409, then the Front Office facts connection) ──
const X = require("../site/shared/pretrade_extension.js").UPS_PRETRADE_EXT;
// Rico Dowdle as recorded 2026-10-20 (data/mfl-snapshots/2026-10-20/rosters.json, Blake Bombers): one year left, contract already carries "Ext: Blake".
const rico = { id: "14823", position: "RB", salary: 11000, years: 1, type: "Vet-Ext1", special: "CL 2| TCV 12K| AAV 11K| Y1-1K, Y2-11K| GTD: 9K| Ext: Blake", isTaxi: false };
// A valid FIRST extension: a final-year WR whose franchise has not extended him.
const first = { id: "16614", position: "WR", salary: 14000, years: 1, type: "Rookie-Draft", special: "CL 1| TCV 14K| AAV 14K| Y1-14K", isTaxi: false };
const FULL = (already) => ({ history_ok: true, already_extended_by_this_franchise: already, server_confirmed: true });
const optionsFor = (p, facts) => { const a = C.extensionInput(p, facts); return a ? X.buildSyntheticExtensionOptions(a) : []; };

test("no complete facts -> no extension input at all: no badge, no choices (never inferred from the contract or its Ext: text)", () => {
  const missing = [null, undefined, {}, { already_extended_by_this_franchise: false },                    // the old, partial shape no longer suffices
    { history_ok: true, already_extended_by_this_franchise: false },                                         // history read, but the server did not confirm
    { history_ok: true, already_extended_by_this_franchise: false, server_confirmed: false },
    { history_ok: false, already_extended_by_this_franchise: false, server_confirmed: true },               // history unreadable
    { history_ok: "true", already_extended_by_this_franchise: false, server_confirmed: true },
    { history_ok: true, already_extended_by_this_franchise: null, server_confirmed: true },
    { history_ok: true, already_extended_by_this_franchise: "no", server_confirmed: true },
    { server_confirmed: true }];
  for (const facts of missing) { assert.equal(C.extensionInput(first, facts), null, JSON.stringify(facts)); assert.deepEqual(optionsFor(first, facts), []); }
});
test("a valid first extension: full facts (history read, not yet extended, server confirmed) -> the 1-year and 2-year options", () => {
  assert.deepEqual(optionsFor(first, FULL(false)).map((o) => o.option_key), ["1YR|NONE", "2YR|NONE"]);
});
test("Rico Dowdle: Blake already extended him (full facts say so) -> no 1YR or 2YR option, even though the server confirmed the probe", () => {
  assert.deepEqual(optionsFor(rico, FULL(true)), []);
  assert.deepEqual(optionsFor({ ...rico, special: "CL 2| TCV 12K| AAV 11K| Y1-1K, Y2-11K| GTD: 9K" }, FULL(true)), []);  // the flag decides, not the Ext: text
});
test("the shared rule's own gates still apply when the facts are complete (not final year, tagged)", () => {
  assert.deepEqual(optionsFor({ ...first, years: 2 }, FULL(false)), []);
  assert.deepEqual(optionsFor({ ...first, type: "Vet-Tag" }, FULL(false)), []);
});

// historyFacts: the worker's /trade-workbench response -> this franchise's history fact for one player
const WB = (ok, flagged) => ({ meta: { counts: { extension_history_ok: ok } }, teams: [
  { franchise_id: "0010", assets: [{ type: "PLAYER", player_id: "14823", ...(flagged ? { already_extended_by_this_franchise: true } : {}) }, { type: "PLAYER", player_id: "9" }, { type: "DRAFT_PICK", asset_id: "FP_x" }] },
  { franchise_id: "0008", assets: [{ type: "PLAYER", player_id: "16614" }] }] });
test("historyFacts: history_ok must be exactly true; the flag marks Rico; an unflagged player on a readable history is 'not extended'", () => {
  assert.deepEqual(C.historyFacts(WB(true, true), "0010", "14823"), { history_ok: true, already_extended_by_this_franchise: true });
  assert.deepEqual(C.historyFacts(WB(true, true), "0010", "9"), { history_ok: true, already_extended_by_this_franchise: false });
  assert.deepEqual(C.historyFacts(WB(true, false), "0008", "16614"), { history_ok: true, already_extended_by_this_franchise: false });
});
test("historyFacts: unreadable history (false / missing / not boolean) or an unknown franchise or player gives nothing, never 'not extended'", () => {
  for (const ok of [false, undefined, null, "true", 1]) assert.equal(C.historyFacts(WB(ok, false), "0008", "16614"), null);
  assert.equal(C.historyFacts({ teams: WB(true).teams }, "0008", "16614"), null);       // no meta at all
  assert.equal(C.historyFacts(WB(true, false), "0099", "16614"), null);                 // franchise not in the response
  assert.equal(C.historyFacts(WB(true, false), "0008", "77"), null);                    // player not among its assets
  assert.equal(C.historyFacts(null, "0008", "16614"), null);
});
// probeResult: the compliance-preview answer to a probe for ONE extension request
test("probeResult: confirmed only when the answer is ok, the extension part was evaluated, and the player is not refused", () => {
  const okResp = (skipped, cap) => ({ ok: true, compliance: { extension_skipped: skipped, cap: cap || { status: "ok" } } });
  assert.deepEqual(C.probeResult(okResp([]), "16614"), { confirmed: true, reason: "" });
  assert.deepEqual(C.probeResult(okResp([{ player_id: "999", reason: "x" }]), "16614"), { confirmed: true, reason: "" });   // another player's refusal
  const window = C.probeResult(okResp([{ player_id: "16614", reason: "outside_window" }]), "16614");                         // the acquisition window
  assert.deepEqual(window, { confirmed: false, reason: "outside_window" });
  assert.equal(C.probeResult(okResp([{ player_id: "16614", reason: "authority_unavailable:history" }]), "16614").confirmed, false);
  assert.equal(C.probeResult(okResp([], { status: "unavailable", reason: "extension_salaries_unavailable" }), "16614").confirmed, false);
  for (const bad of [null, undefined, {}, { ok: false }, { ok: true }, { ok: true, compliance: {} }, { ok: true, compliance: { extension_skipped: "x" } }, "x"]) assert.equal(C.probeResult(bad, "16614").confirmed, false, JSON.stringify(bad));
  // Codex MAT-1 (#1416): a response with NO ok field is not a confirmation, however clean its compliance part looks.
  assert.deepEqual(C.probeResult({ compliance: { extension_skipped: [] } }, "16614"), { confirmed: false, reason: "no_answer" });
  assert.equal(C.probeResult({ compliance: { extension_skipped: [], cap: { status: "ok" } } }, "16614").confirmed, false);
  for (const okv of [undefined, null, false, "true", 1, 0, "", {}]) assert.equal(C.probeResult({ ok: okv, compliance: { extension_skipped: [] } }, "16614").confirmed, false, "ok = " + JSON.stringify(okv));
  assert.equal(C.probeResult({ ok: true, compliance: { extension_skipped: [] } }, "16614").confirmed, true, "only ok === true confirms");
});
test("extensionFacts combines history and probe, and is null unless both are complete", () => {
  const h = { history_ok: true, already_extended_by_this_franchise: false }, p = { confirmed: true };
  assert.deepEqual(C.extensionFacts(h, p), FULL(false));
  assert.deepEqual(C.extensionFacts({ ...h, already_extended_by_this_franchise: true }, p), FULL(true));
  for (const [hh, pp] of [[null, p], [h, null], [h, { confirmed: false }], [{ history_ok: false, already_extended_by_this_franchise: false }, p], [{ history_ok: true }, p], [{}, {}]]) assert.equal(C.extensionFacts(hh, pp), null);
});
test("end to end on the pure pieces: Rico (flagged on Blake's history) and a valid first extension", () => {
  const ricoFacts = C.extensionFacts(C.historyFacts(WB(true, true), "0010", "14823"), { confirmed: true });
  assert.deepEqual(optionsFor(rico, ricoFacts), []);
  const firstFacts = C.extensionFacts(C.historyFacts(WB(true, false), "0008", "16614"), C.probeResult({ ok: true, compliance: { extension_skipped: [] } }, "16614"));
  assert.deepEqual(optionsFor(first, firstFacts).map((o) => o.option_key), ["1YR|NONE", "2YR|NONE"]);
  const noHistory = C.extensionFacts(C.historyFacts(WB(false, false), "0008", "16614"), { confirmed: true });
  assert.deepEqual(optionsFor(first, noHistory), []);
});
test("probeAsset carries no eligibility claim (the flag is false, for the worker to judge)", () => {
  assert.equal(C.probeAsset(first).already_extended_by_this_franchise, false);
  assert.equal(C.probeAsset(null), null);
});
