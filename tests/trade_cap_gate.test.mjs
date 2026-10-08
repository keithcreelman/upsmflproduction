// POST-TRADE SALARY CAP (HARD BLOCK) + ROSTER COUNTS (ADVISORY) — the REAL worker on real SQLite, MFL stubbed at the edge.
//   node tests/trade_cap_gate.test.mjs
//
// RULING (Keith, 2026-09-25): a trade must not execute if the authoritative post-trade calculation PROVES a participating
// franchise would exceed the salary cap; an unavailable / unresolved calculation fails closed and MFL is never called. Roster
// counts are projected and flagged, never a block; an MFL refusal is passed through untouched.
//
// Part 1  the calculation itself (pure): every input that can move a cap number
// Part 2  two-team accept + preview through the real worker (the 18 required cap cases)
// Part 3  three-team gates (Discord accept + execute) through the real worker, sharing the SAME calculation
// Part 4  roster-count warnings (advisory) — canonical responses
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, bindSelf, quiet } from "./fixtures/worker_harness.mjs";
import * as F from "./fixtures/trade_3way_fixture.mjs";
import { evaluateTradeCompliance, capHit, ROSTER_MIN } from "../worker/src/trade_cap_authority.js";
await import("./fixtures/register_md_loader.mjs");
const { handle3WayButton, execute3Way } = await import("../worker/src/trade_3way.js");

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const CAP = 300000;

// ───────────────────────────────── Part 1 — the pure calculation ─────────────────────────────────
const ok = (data) => ({ ok: true, status: 200, data });
const league = (o) => ok({ league: { salaryCapAmount: String(CAP), rosterSize: "35", franchises: { franchise: [{ id: "0001", name: "L.A. Looks" }, { id: "0002", name: "CBP" }, { id: "0003", name: "Gride" }] }, ...(o || {}) } });
const rosterOf = (map) => ok({ rosters: { franchise: Object.entries(map).map(([id, ps]) => ({ id, player: ps.map((p) => ({ id: p.id, salary: p.salary == null ? "" : String(p.salary), status: p.status || "ROSTER", ...(p.contractYear != null ? { contractYear: String(p.contractYear) } : {}), ...(p.contractStatus ? { contractStatus: p.contractStatus } : {}), ...(p.contractInfo ? { contractInfo: p.contractInfo } : {}) })) })) } });
const adjOf = (rows) => ok({ salaryAdjustments: rows === undefined ? "" : { salaryAdjustment: rows } });
const swap = (a, b) => [{ from: "0001", to: "0002", tokens: [a] }, { from: "0002", to: "0001", tokens: [b] }];
const noSalaries = ok({ salaries: { leagueUnit: { player: [] } } });
const calc = (o) => evaluateTradeCompliance({ league: league(), salaries: noSalaries, adjustments: adjOf([]), ...o });
const row = (c, fid) => c.cap.rows.find((r) => r.franchise_id === fid);

test("CALC: used = Σ roster salaries + Σ adjustments; taxi = 0, injured reserve = 50%, a KNOWN-expired contract = 0", () => {
  const c = calc({ rosters: rosterOf({
    "0001": [{ id: "1", salary: 10000 }, { id: "2", salary: 8000, status: "TAXI_SQUAD" }, { id: "3", salary: 6000, status: "INJURED_RESERVE" }, { id: "4", salary: 7000, contractYear: 0, contractStatus: "Vet-FAA" }, { id: "5", salary: 1000 }],
    "0002": [{ id: "9", salary: 2000 }] }), adjustments: adjOf([{ franchise_id: "0001", amount: "1500.00", description: "drop penalty" }, { franchise_id: "0001", amount: "-500", description: "credit" }]),
    movements: swap("5", "9") });
  // before(0001) = 10000 + 0(taxi) + 3000(IR half) + 0(expired) + 1000 + 1000(adj net) = 15000 ; after = −1000 + 2000
  t.equal(row(c, "0001").used_before, 15000); t.equal(row(c, "0001").used_after, 16000);
  t.equal(c.cap.status, "ok");
});
test("CALC: a received player lands as ROSTER at full salary — a taxi player too, even when the offer flags him taxi", () => {
  // 2026-10-07 (#1249): MFL never carries taxi status through a trade (7 of 7 taxi players traded in 2026
  // landed ACTIVE), and under lockout nothing moves him back at that moment. Matthew Golden was counted
  // taxi/$0 here and arrived on Gride's active roster at $5,000. The preview must not assume the move.
  const rosters = rosterOf({ "0001": [{ id: "1", salary: 4000, status: "TAXI_SQUAD" }, { id: "2", salary: 3000 }], "0002": [{ id: "9", salary: 100 }] });
  const mv = [{ from: "0001", to: "0002", tokens: ["1"] }, { from: "0002", to: "0001", tokens: ["9"] }];
  const plain = calc({ rosters, movements: mv });
  t.equal(row(plain, "0002").used_after, 4000, "no taxi flag → MFL lands him as ROSTER → full salary");
  const flagged = calc({ rosters, taxiFlags: { "1": true }, movements: mv });
  t.equal(row(flagged, "0002").used_after, 4000, "flagged taxi → STILL full salary: he arrives active");
  t.equal(row(flagged, "0001").used_after, 3100, "the sender saves nothing: his taxi salary was never on its cap");
  const r2 = flagged.roster.rows.find((r) => r.franchise_id === "0002");
  t.equal(r2.active_after, r2.active_before, "he counts as an active arrival (one in, one out)");
  t.equal(JSON.stringify(r2.taxi_arrivals), JSON.stringify(["1"]), "and is named as a taxi arrival");
});
test("CALC: a taxi arrival with no proven taxi destination counts as active — the roster maximum blocks, and says why", () => {
  // Gride's real shape: 30 active (maximum 30) and a player arriving from the other team's taxi squad.
  const thirty = Array.from({ length: 30 }, (_, i) => ({ id: String(100 + i), salary: 1000 }));
  const rosters = rosterOf({ "0001": [{ id: "1", salary: 5000, status: "TAXI_SQUAD" }, ...Array.from({ length: 28 }, (_, i) => ({ id: String(200 + i), salary: 1000 }))], "0003": thirty });
  const c = evaluateTradeCompliance({ league: league({ rosterSize: "30" }), salaries: noSalaries, adjustments: adjOf([]), rosters, taxiFlags: { "1": true },
    movements: [{ from: "0001", to: "0003", tokens: ["1"] }] });
  // (no taxiStep → nothing will move him to taxi, so his move can't be credited; see tests/trade_roster_qb_gates.test.mjs for the credited case)
  t.equal(c.roster_limit.status, "blocked"); t.equal(c.roster_limit.executable, false);
  const w = c.roster_limit.violations.find((x) => x.franchise_id === "0003");
  t.ok(w, JSON.stringify(c.roster_limit));
  t.equal(w.active_after, 31); t.equal(w.active_after_taxi, 31); t.equal(w.moves_needed, 1);
  t.equal(row(c, "0003").used_after, 35000, "and his $5,000 is on Gride's cap");
  t.match(w.message, /Gride would have 31 active players right after this trade — the maximum is 30\. Gride needs 1 more roster spot: make 1 legal roster move first/);
  t.match(w.message, /player 1 can't count as a taxi move: nothing in this trade moves him to the taxi squad afterward\./);
});
test("CALC: an injured-reserve player sent away frees only the half he was costing; he lands at full salary", () => {
  const rosters = rosterOf({ "0001": [{ id: "1", salary: 10000, status: "INJURED_RESERVE" }], "0002": [{ id: "9", salary: 100 }] });
  const c = calc({ rosters, movements: swap("1", "9") });
  t.equal(row(c, "0001").used_before, 5000); t.equal(row(c, "0001").used_after, 100);
  t.equal(row(c, "0002").used_before, 100); t.equal(row(c, "0002").used_after, 10000);
});
test("CALC: cap money — the franchise SENDING it is charged, the one RECEIVING it is credited (the salaryAdjustment rows the worker posts)", () => {
  const rosters = rosterOf({ "0001": [{ id: "1", salary: 4000 }], "0002": [{ id: "9", salary: 4000 }] });
  const c = calc({ rosters, movements: [{ from: "0001", to: "0002", tokens: ["1", "BB_2000"] }, { from: "0002", to: "0001", tokens: ["9", "BB_500"] }] });
  t.equal(row(c, "0001").used_after, 4000 - 4000 + 4000 + 2000 - 500);
  t.equal(row(c, "0002").used_after, 4000 - 4000 + 4000 - 2000 + 500);
});
test("CALC: a pre-trade extension's current-year salary is what the receiver carries; a loaded/front-loaded contract counts what it costs THIS year", () => {
  const rosters = rosterOf({ "0001": [{ id: "1", salary: 4000, contractYear: 1, contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 4K|AAV 4K|Y1-4K" }], "0002": [{ id: "9", salary: 100 }] });
  const plain = calc({ rosters, movements: swap("1", "9") });
  const ext = calc({ rosters, movements: swap("1", "9"), extensionSalary: { "1": 6000 } });
  t.equal(row(plain, "0002").used_after, 4000); t.equal(row(ext, "0002").used_after, 6000);
  // a front-loaded year: MFL's salary IS the current-year amount even though the contract's average (AAV) is lower
  const fl = calc({ rosters: rosterOf({ "0001": [{ id: "1", salary: 15000, contractYear: 3, contractStatus: "Vet-Ext2-FL", contractInfo: "CL 3|TCV 30K|AAV 10K|Y1-15K, Y2-10K, Y3-5K" }], "0002": [{ id: "9", salary: 100 }] }), movements: swap("1", "9") });
  t.equal(row(fl, "0001").used_before, 15000, "the current-year amount, not the AAV"); t.equal(row(fl, "0002").used_after, 15000);
});
test("CALC: exactly at the cap is allowed; one dollar over is blocked, and the message names the franchise and the amount", () => {
  const at = calc({ rosters: rosterOf({ "0001": [{ id: "1", salary: 5000 }, { id: "8", salary: 285000 }], "0002": [{ id: "9", salary: 15000 }] }), movements: swap("1", "9") });
  t.equal(row(at, "0001").used_after, CAP); t.equal(at.cap.status, "ok");
  const over = calc({ rosters: rosterOf({ "0001": [{ id: "1", salary: 5000 }, { id: "8", salary: 285000 }], "0002": [{ id: "9", salary: 15001 }] }), movements: swap("1", "9") });
  t.equal(over.cap.status, "blocked"); t.equal(over.cap.violations.length, 1);
  t.equal(over.cap.violations[0].amount_over, 1); t.equal(over.cap.violations[0].franchise_id, "0001");
  t.match(over.cap.message, /L\.A\. Looks would be \$1 over the \$300,000 salary cap/);
});
test("CALC: FAIL CLOSED — every unavailable or malformed input is 'unavailable', never 'ok'", () => {
  const good = { rosters: rosterOf({ "0001": [{ id: "1", salary: 5000 }], "0002": [{ id: "9", salary: 5000 }] }), movements: swap("1", "9") };
  const cases = {
    "league export failed": { league: { ok: false, status: 503, data: null } },
    "league has no cap amount": { league: ok({ league: { franchises: {} } }) },
    "league cap is zero/garbage": { league: ok({ league: { salaryCapAmount: "abc" } }) },
    "rosters export failed": { rosters: { ok: false, status: 503, data: null } },
    "rosters malformed (no franchises)": { rosters: ok({ rosters: {} }) },
    "a participant is missing from rosters": { rosters: rosterOf({ "0001": [{ id: "1", salary: 5000 }] }) },
    "a roster salary is BLANK (not $0)": { rosters: rosterOf({ "0001": [{ id: "1", salary: 5000 }, { id: "2", salary: null }], "0002": [{ id: "9", salary: 5000 }] }) },
    "the traded player is not on the sender's roster": { movements: swap("77", "9") },
    "adjustments export failed": { adjustments: { ok: false, status: 500, data: null } },
    "adjustments export has no salaryAdjustments key": { adjustments: ok({}) },
    "adjustments malformed (unknown shape)": { adjustments: ok({ salaryAdjustments: { junk: 1 } }) },
    "an adjustment amount is not a number": { adjustments: adjOf([{ franchise_id: "0001", amount: "n/a" }]) },
    "an adjustment has no franchise": { adjustments: adjOf([{ amount: "100" }]) },
    "cap money token is garbage": { movements: [{ from: "0001", to: "0002", tokens: ["1", "BB_x"] }, { from: "0002", to: "0001", tokens: ["9"] }] },
    "no movements": { movements: [] },
    "a movement from a team to itself": { movements: [{ from: "0001", to: "0001", tokens: ["1"] }] },
  };
  for (const [name, over] of Object.entries(cases)) {
    const c = calc({ ...good, ...over });
    t.equal(c.cap.status, "unavailable", `cap unavailable: ${name}`);
    t.notEqual(c.cap.status, "ok"); t.equal(c.roster.status, "unavailable", `roster unavailable (not compliant): ${name}`);
    t.doesNotMatch(c.cap.message + c.roster.message, /under the salary cap\.|within its roster limits/, `never reads as compliant: ${name}`);
  }
  t.equal(calc(good).cap.status, "ok", "control: the same inputs, healthy → ok");
});
test("CALC: an empty adjustments export is 'no adjustments' (a real answer), unlike a missing one", () => {
  for (const empty of [adjOf(undefined), ok({ salaryAdjustments: {} }), ok({ salaryAdjustments: null })]) {
    t.equal(calc({ rosters: rosterOf({ "0001": [{ id: "1", salary: 5000 }], "0002": [{ id: "9", salary: 5000 }] }), movements: swap("1", "9"), adjustments: empty }).cap.status, "ok");
  }
});
test("CALC: roster projection — counts exclude taxi and IR, the max comes from MFL's league export, the min from canon B1", () => {
  const many = (start, n, extra) => [...Array.from({ length: n }, (_, i) => ({ id: String(start + i), salary: 100 })), ...(extra || [])];
  const rosters = rosterOf({ "0001": many(100, 34, [{ id: "1", salary: 100 }, { id: "2", salary: 100, status: "TAXI_SQUAD" }, { id: "3", salary: 100, status: "INJURED_RESERVE" }]), "0002": many(500, 27, [{ id: "9", salary: 100 }]) });
  const c = calc({ rosters, movements: [{ from: "0002", to: "0001", tokens: ["9"] }, { from: "0001", to: "0002", tokens: ["2", "3"] }] });
  // 0001 active: 35 (34 + #1; taxi/IR excluded) +1 received(9) = 36 (> 35) ; taxi #2 leaves (not active) and IR #3 leaves (not active)
  const a = c.roster.rows.find((r) => r.franchise_id === "0001"), b = c.roster.rows.find((r) => r.franchise_id === "0002");
  t.equal(a.active_before, 35); t.equal(a.active_after, 36); t.equal(a.status, "above_max");
  // 0002 active: 28 − 1 sent + 2 received (taxi #2 lands as ROSTER; IR #3 lands as ROSTER) = 29
  t.equal(b.active_before, 28); t.equal(b.active_after, 29); t.equal(b.status, "within");
  t.equal(c.roster_limit.status, "blocked", "over the maximum is now a HARD gate (Keith 2026-10-07)"); t.equal(c.roster_limit.executable, false);
  t.equal(c.roster.status, "ok", "the advisory block now only carries the 27 minimum"); t.equal(c.roster.advisory, true); t.equal(ROSTER_MIN, 27);
  t.equal(c.cap.status, "ok", "an over-limit roster never affects the cap verdict");
  const low = calc({ rosters: rosterOf({ "0001": many(100, 25, [{ id: "1", salary: 100 }, { id: "2", salary: 100 }]), "0002": many(500, 27, [{ id: "9", salary: 100 }]) }), movements: [{ from: "0001", to: "0002", tokens: ["1", "2"] }, { from: "0002", to: "0001", tokens: ["9"] }] });
  t.equal(low.roster.rows.find((r) => r.franchise_id === "0001").status, "below_min");
  const noMax = calc({ league: league({ rosterSize: "" }), rosters, movements: swap("1", "9") });
  t.equal(noMax.roster.status, "unavailable", "no roster max from MFL → unavailable, not compliant");
  t.equal(noMax.roster_limit.status, "unavailable"); t.equal(noMax.roster_limit.executable, false, "and the hard gate fails CLOSED");
});
test("CALC: capHit mirrors the Front Office rule (contract unknown still counts its salary)", () => {
  t.equal(capHit({ salary: 5000, years: 0, unknown: true, taxi: false, ir: false }), 5000);
  t.equal(capHit({ salary: 5000, years: 0, unknown: false, taxi: false, ir: false }), 0);
  t.equal(capHit({ salary: 5001, years: 2, unknown: false, taxi: false, ir: true }), 2501);
  t.equal(capHit({ salary: 5000, years: 2, unknown: false, taxi: true, ir: false }), 0);
});

// ───────────────────────────────── shared world for Parts 2-4 ─────────────────────────────────
const player = (pid, salary = 5000, extra) => ({ asset_id: `P_${pid}`, type: "PLAYER", player_id: String(pid), player_name: `P${pid}`, salary, taxi: false, contract_info: "", ...(extra || {}) });
const payloadOf = (from, to, give, recv, o) => ({
  schema_version: 1, source: "test", league_id: "74598", season: "2026",
  teams: [
    { role: "left", franchise_id: from, selected_assets: give, traded_salary_adjustment_k: (o && o.fromCapK) || 0, traded_salary_adjustment_dollars: ((o && o.fromCapK) || 0) * 1000, selected_non_taxi_salary_dollars: 5000 },
    { role: "right", franchise_id: to, selected_assets: recv, traded_salary_adjustment_k: (o && o.toCapK) || 0, traded_salary_adjustment_dollars: ((o && o.toCapK) || 0) * 1000, selected_non_taxi_salary_dollars: 5000 },
  ],
  extension_requests: (o && o.ext) || [], ui: { left_team_id: from, right_team_id: to }, validation: { status: "ready" },
});
const clone = (o) => JSON.parse(JSON.stringify(o));
const bulk = (start, n, salary) => Array.from({ length: n }, (_, i) => ({ id: String(start + i), salary: salary == null ? 100 : salary, contractYear: 3, contractStatus: "Vet-FAA" }));

// 0001 owns 14056, 0002 owns 13100 (the harness defaults). `s1`/`s2` are their salaries; `fill1`/`fill2` are the rest of each
// team's payroll, so each team's used-before is exactly what a test needs.
function world(mfl, o) {
  o = o || {};
  mfl.st.rosters["0001"] = [{ id: "14056", salary: o.s1 == null ? 5000 : o.s1, contractYear: 3, contractStatus: "Vet-FAA", ...(o.p1 || {}) }, ...(o.fill1 ? [{ id: "90001", salary: o.fill1, contractYear: 3, contractStatus: "Vet-FAA" }] : []), ...(o.extra1 || [])];
  mfl.st.rosters["0002"] = [{ id: "13100", salary: o.s2 == null ? 5000 : o.s2, contractYear: 3, contractStatus: "Vet-FAA", ...(o.p2 || {}) }, ...(o.fill2 ? [{ id: "90002", salary: o.fill2, contractYear: 3, contractStatus: "Vet-FAA" }] : []), ...(o.extra2 || [])];
  if (o.adj) mfl.st.salaryAdjustments = clone(o.adj);
  if (o.league) mfl.st.league = o.league;
}
function fresh(o) {
  const env = makeWorkerEnv(o && o.env);
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } });
  mfl.install();
  return { env, mfl };
}
// Attempts the create; if refused because the SENDER (the initiator, 0001) needs to acknowledge
// their own projected overage, retries ONCE with the exact signature the server just computed --
// the real client flow (create -> shown the figure -> acknowledge -> retry). Pass {ackCap:false}
// to see the FIRST, unacknowledged response instead (for tests proving the create-time gate itself).
async function createOffer(env, mfl, payload, opts) {
  opts = opts || {};
  const body0 = { league_id: "74598", season: "2026", from_franchise_id: "0001", to_franchise_id: "0002", from_franchise_name: "x", to_franchise_name: "y", message: "", payload };
  const r0 = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: body0 });
  if (opts.ackCap === false || r0.status < 300 || !(r0.json && r0.json.code === "cap_overage_ack_required")) return r0;
  const r1 = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=tok-B`, { body: { ...body0, cap_ack: { signature: r0.json.cap_ack_needed.signature } } });
  r1.firstResponse = r0;
  return r1;
}
async function sendOffer(env, mfl, payload, opts) {
  const r = await createOffer(env, mfl, payload, opts);
  t.ok(r.status < 300, `offer sent: ${r.status} ${r.text.slice(0, 200)}`);
  return { id: mfl.st.pending[mfl.st.pending.length - 1].trade_id, payload };
}
const SWAP = () => payloadOf("0001", "0002", [player(14056)], [player(13100)]);
const mobileBody = (id, action) => ({ action: action || "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026", message: "" });
const desktopBody = (id, p, over) => ({
  league_id: "74598", season: "2026", offer_id: id, proposal_id: id, trade_id: id, action: "ACCEPT", message: "", acting_franchise_id: "0002", payload: clone(p),
  offer_comment: "", offer_comments: "", offer_notes: "", offer_raw_comment: "", offer_message: "", offer_twb_meta: null, offer_extension_requests: clone(p.extension_requests || []),
  offer_from_franchise_id: "0001", offer_to_franchise_id: "0002", offer_will_give_up: "", offer_will_receive: "", direct_mfl: true, ...(over || {}),
});
const act = (env, body) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body });
const outbox = (env) => env.UPS_MFL_DB.raw.prepare("SELECT action_type, status FROM twb_trade_outbox ORDER BY rowid").all();
// Nothing MFL-side changed after the offer was sent, and nothing was recorded as completed.
function nothingHappened(mfl, env, label) {
  t.equal(mfl.st.done.length, 0, `${label}: MFL never accepted`);
  t.equal(mfl.st.pending.length, 1, `${label}: the offer is still pending`);
  t.equal(mfl.writes("tradeResponse").length, 0, `${label}: no tradeResponse import`);
  t.equal(mfl.writes("salaryAdj").length, 0, `${label}: no salary adjustment import`);
  t.equal(mfl.writes("salaries").length, 0, `${label}: no contract import`);
  t.equal(outbox(env).filter((r) => r.action_type === "ACCEPT").length, 0, `${label}: no ACCEPT row written`);
  t.equal(outbox(env).filter((r) => ["VERIFIED", "COMPLETED"].includes(r.status)).length, 0, `${label}: nothing recorded as completed`);
}
// PREVIEW then ACCEPT, acknowledging the ACCEPTING franchise's own overage if the preview shows one
// for them (the real client flow: preview -> read the signature -> accept with it). A test that wants
// to see the unacknowledged accept refusal should call act() directly instead.
async function acceptAck(env, id, fid) {
  const p = await act(env, mobileBody(id, "PREVIEW"));
  const mine = p.json && p.json.cap_ack && (p.json.cap_ack.per_franchise || []).find((f) => f.franchise_id === (fid || "0002"));
  const body = mobileBody(id);
  if (mine && mine.status !== "acknowledged") body.cap_ack = { signature: mine.signature };
  return act(env, body);
}

// ───────────────────────────────── Part 2 — two-team accept + preview ─────────────────────────────────
test("CAP 1: every participant stays under the cap → the accept proceeds and MFL is called once", async () => {
  const { env, mfl } = fresh(); world(mfl, { fill1: 200000, fill2: 200000 });
  const o = await sendOffer(env, mfl, SWAP());
  const r = await act(env, mobileBody(o.id));
  t.equal(r.status, 200, r.text.slice(0, 300)); t.equal(mfl.st.done.length, 1); t.equal(r.json.compliance.cap.status, "ok");
  t.equal(r.json.compliance.cap.rows.find((x) => x.franchise_id === "0001").used_after, 205000);
});
test("CAP 2: the SENDER would exceed the cap → the OFFER ITSELF requires the sender's acknowledgment; unacknowledged, nothing is created or written; once acknowledged, the offer (and later accept) proceed", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 5000, s2: 20000, fill1: 290000, fill2: 100000 });      // 0001: 295000 − 5000 + 20000 = 310000
  const r0 = await createOffer(env, mfl, SWAP(), { ackCap: false });
  t.equal(r0.status, 409); t.equal(r0.json.code, "cap_overage_ack_required"); t.equal(r0.json.ok, false);
  t.match(r0.json.error, /This offer would put your team \$10,000 over the \$300,000 salary cap/);
  t.equal(r0.json.cap_ack_needed.franchise_id, "0001"); t.equal(r0.json.cap_ack_needed.amount_over, 10000);
  t.equal(mfl.st.pending.length, 0, "no offer was ever sent to MFL");
  const o = await sendOffer(env, mfl, SWAP());
  const r = await act(env, mobileBody(o.id));
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.st.done.length, 1);
  t.equal(r.json.compliance.cap.rows.find((x) => x.franchise_id === "0001").used_after, 310000, "the acknowledged overage still shows in the projection -- it's displayed, not hidden");
});
test("CAP 3: the RECIPIENT would exceed the cap → the offer is created normally (only the SENDER's own side gates creation), but ACCEPT requires the recipient's own acknowledgment first", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 20000, s2: 5000, fill1: 100000, fill2: 290000 });
  const o = await sendOffer(env, mfl, SWAP());
  const r0 = await act(env, mobileBody(o.id));
  t.equal(r0.status, 409); t.equal(r0.json.code, "cap_overage_ack_required");
  t.equal(r0.json.cap_ack[0].franchise_id, "0002"); t.equal(r0.json.cap_ack[0].amount_over, 10000); t.equal(r0.json.cap_ack[0].status, "missing");
  t.match(r0.json.compliance.cap.message, /CBP would be \$10,000 over/);
  nothingHappened(mfl, env, "recipient over, unacknowledged");
  const r = await acceptAck(env, o.id, "0002");
  t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.st.done.length, 1);
});
test("CAP 5 + 6: exactly AT the cap needs no acknowledgment; ONE DOLLAR over requires the SENDER's acknowledgment", async () => {
  { const { env, mfl } = fresh(); world(mfl, { s1: 5000, s2: 15000, fill1: 285000, fill2: 100000 });          // 0001 after = 300000
    const o = await sendOffer(env, mfl, SWAP()); const r = await act(env, mobileBody(o.id));
    t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(r.json.compliance.cap.rows.find((x) => x.franchise_id === "0001").used_after, CAP); t.equal(mfl.st.done.length, 1); }
  { const { env, mfl } = fresh(); world(mfl, { s1: 5000, s2: 15001, fill1: 285000, fill2: 100000 });          // 300001, the SENDER is over
    const r0 = await createOffer(env, mfl, SWAP(), { ackCap: false });
    t.equal(r0.status, 409); t.equal(r0.json.code, "cap_overage_ack_required"); t.equal(r0.json.cap_ack_needed.amount_over, 1); t.match(r0.json.error, /\$1 over/);
    t.equal(mfl.st.pending.length, 0, "no offer was ever sent to MFL");
    const o = await sendOffer(env, mfl, SWAP()); const r = await act(env, mobileBody(o.id));
    t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.st.done.length, 1); }
});
test("CAP 7 + 18: a false cap total, and a FORGED acknowledgment signature, are IGNORED -- an owner cannot bypass the requirement by lying in the request body", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 20000, s2: 5000, fill1: 100000, fill2: 290000 });          // the RECIPIENT (0002) is genuinely over -- offer creation is unaffected
  const o = await sendOffer(env, mfl, SWAP());
  const lies = {
    cap_total: 999999, franchise_cap: 999999, available_salary_dollars: 999999, salary_cap_amount: 999999, cap_space: 999999, used_after: 1, over_by: 0, cap_ok: true,
    compliance: { cap: { status: "ok", violations: [] } }, override_cap: true, force: true, skip_cap_check: true, commissioner_override: true, ignore_cap: true,
    cap_ack: { signature: "totally-forged-signature-not-computed-by-the-server" },
  };
  const evilPayload = SWAP(); evilPayload.teams[0].selected_non_taxi_salary_dollars = 1; evilPayload.teams[1].available_salary_dollars = 999999; evilPayload.teams[0].salary_cap_room = 999999;
  for (const [name, body] of Object.entries({
    "mobile shape + lies (incl. a forged cap_ack signature)": { ...mobileBody(o.id), ...lies },
    "desktop shape + lies": desktopBody(o.id, o.payload, lies),
    "desktop shape + a rewritten payload with cheaper salaries and fake room": desktopBody(o.id, evilPayload, lies),
    "desktop shape with cheaper asset salaries": (() => { const p = SWAP(); p.teams[1].selected_assets[0].salary = 100; return desktopBody(o.id, p); })(),
    "acting_franchise_id of the other team": { ...mobileBody(o.id), acting_franchise_id: "0001", franchise_id: "0001" },
  })) {
    const r = await act(env, body);
    t.ok([403, 409].includes(r.status), `${name} is refused (${r.status})`);
    t.notEqual(r.status, 200, name);
    nothingHappened(mfl, env, name);
  }
  // and the reverse: a false claim that the trade is OVER the cap does not block a legal one
  const { env: e2, mfl: m2 } = fresh(); world(m2, { s1: 5000, s2: 5000, fill1: 100000, fill2: 100000 });
  const o2 = await sendOffer(e2, m2, SWAP());
  const r2 = await act(e2, { ...mobileBody(o2.id), cap_ok: false, used_after: 999999, over_by: 500000 });
  t.equal(r2.status, 200, r2.text.slice(0, 200)); t.equal(m2.st.done.length, 1);
});
test("CAP 8: the cap changed AFTER the proposal was created → the CURRENT amount governs (both directions)", async () => {
  { const { env, mfl } = fresh(); world(mfl, { s1: 5000, s2: 5000, fill1: 100000, fill2: 100000 });           // fine when sent
    const o = await sendOffer(env, mfl, SWAP());
    world(mfl, { s1: 5000, s2: 5000, fill1: 100000, fill2: 100000, adj: [{ franchise_id: "0002", amount: "200000", description: "manual commissioner adjustment" }] });   // 0002 now at 300000+… after
    const r0 = await act(env, mobileBody(o.id));
    t.equal(r0.status, 409); t.equal(r0.json.code, "cap_overage_ack_required"); t.equal(r0.json.cap_ack[0].franchise_id, "0002");
    nothingHappened(mfl, env, "cap moved after sending, unacknowledged");
    const r = await acceptAck(env, o.id, "0002");
    t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.st.done.length, 1); }
  { const { env, mfl } = fresh(); world(mfl, { s1: 5000, s2: 15001, fill1: 290000, fill2: 100000 });          // over when sent (the SENDER) -- creation itself needs the sender's acknowledgment for that figure
    const o = await sendOffer(env, mfl, SWAP());
    world(mfl, { s1: 5000, s2: 15001, fill1: 200000, fill2: 100000 });                                        // …the sender cleared payroll since -- no violation left at all by accept time
    const r = await act(env, mobileBody(o.id));
    t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.st.done.length, 1); }
});
test("CAP 9 + 10: an existing salary adjustment, and DEAD MONEY, are part of the calculation -- and, when they push the SENDER over, gate offer creation on the sender's acknowledgment", async () => {
  { const { env, mfl } = fresh(); world(mfl, { s1: 5000, s2: 15000, fill1: 285000, fill2: 100000, adj: [{ franchise_id: "0001", amount: "5000.00", description: "UPS traded salary settlement (2025 trade)" }] });   // 0001 = 290000+5000 adj +10000 = 305000
    const r0 = await createOffer(env, mfl, SWAP(), { ackCap: false });
    t.equal(r0.status, 409); t.equal(r0.json.code, "cap_overage_ack_required"); t.equal(r0.json.cap_ack_needed.amount_over, 5000);
    t.equal(mfl.st.pending.length, 0, "no offer was ever sent to MFL");
    const o = await sendOffer(env, mfl, SWAP()); const r = await act(env, mobileBody(o.id));
    t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.st.done.length, 1); }
  { const { env, mfl } = fresh(); world(mfl, { s1: 5000, s2: 15000, fill1: 290000, fill2: 100000, adj: [{ franchise_id: "0001", amount: "-5000", description: "credit" }] });   // a credit brings 0001 to exactly the cap
    const o = await sendOffer(env, mfl, SWAP()); const r = await act(env, mobileBody(o.id));
    t.equal(r.status, 200, r.text.slice(0, 200)); }
  { const { env, mfl } = fresh(); world(mfl, { s1: 5000, s2: 15000, fill1: 285000, fill2: 100000, adj: [{ franchise_id: "0001", amount: "3000", description: "Cut player drop penalty (dead money) — Player X" }] });   // dead money alone tips 0001 over
    const r0 = await createOffer(env, mfl, SWAP(), { ackCap: false });
    t.equal(r0.status, 409); t.equal(r0.json.cap_ack_needed.amount_over, 3000);
    t.equal(mfl.st.pending.length, 0, "no offer was ever sent to MFL");
    const o = await sendOffer(env, mfl, SWAP()); const r = await act(env, mobileBody(o.id));
    t.equal(r.status, 200, r.text.slice(0, 200)); t.equal(mfl.st.done.length, 1); }
});
test("CAP 11: a loaded / front-loaded contract counts the CURRENT-year amount (and an extension's current-year salary), not its average", async () => {
  // 14056: front-loaded — this year's salary is 15K while its AAV is only 10K
  const { env, mfl } = fresh();
  world(mfl, { s1: 15000, s2: 5000, fill1: 100000, fill2: 285000, p1: { contractYear: 3, contractStatus: "Vet-Ext2-FL", contractInfo: "CL 3|TCV 30K|AAV 10K|Y1-15K, Y2-10K, Y3-5K" } });   // 0002: 290000 − 5000 + 15000 = 300000 (AT the cap)
  const o = await sendOffer(env, mfl, SWAP());
  t.equal((await act(env, mobileBody(o.id))).status, 200, "15K (this year's amount) lands exactly on the cap");
  const e2 = fresh();
  world(e2.mfl, { s1: 15001, s2: 5000, fill1: 100000, fill2: 285000, p1: { contractYear: 3, contractStatus: "Vet-Ext2-FL", contractInfo: "CL 3|TCV 30K|AAV 10K|Y1-15K, Y2-10K, Y3-5K" } });
  const o2 = await sendOffer(e2.env, e2.mfl, SWAP());
  const r0 = await act(e2.env, mobileBody(o2.id));
  t.equal(r0.status, 409); t.equal(r0.json.code, "cap_overage_ack_required"); t.equal(r0.json.cap_ack[0].franchise_id, "0002"); t.equal(r0.json.cap_ack[0].amount_over, 1, "AAV (10K) would have hidden this");
  const r2 = await acceptAck(e2.env, o2.id, "0002");
  t.equal(r2.status, 200, r2.text.slice(0, 200));
});
test("CAP 12 + 13: cap authority UNAVAILABLE or MALFORMED → fail closed (503 cap_check_unavailable); MFL is never called", async () => {
  const breakers = {
    "league export down": (m) => { m.st.exportFail = { league: 503 }; },
    "salaryAdjustments export down": (m) => { m.st.exportFail = { salaryAdjustments: 500 }; },
    "salaryAdjustments malformed": (m) => { m.st.exportBody = { salaryAdjustments: { salaryAdjustments: { garbage: true } } }; },
    "salaryAdjustments body missing its root": (m) => { m.st.exportBody = { salaryAdjustments: {} }; },
    "an adjustment amount is not a number": (m) => { m.st.salaryAdjustments = [{ franchise_id: "0001", amount: "lots", description: "x" }]; },
    "league has no cap amount": (m) => { m.st.exportBody = { league: { league: { franchises: {} } } }; },
    "a roster salary is blank": (m) => { m.st.rosters["0002"].push({ id: "90002", salary: null }); },
  };
  for (const [name, breakIt] of Object.entries(breakers)) {
    const { env, mfl } = fresh(); world(mfl, { fill1: 100000, fill2: 100000 });
    const o = await sendOffer(env, mfl, SWAP());
    breakIt(mfl);
    const r = await act(env, mobileBody(o.id));
    t.equal(r.status, 503, `${name}: 503 (${r.status} ${r.text.slice(0, 120)})`); t.equal(r.json.code, "cap_check_unavailable", name);
    t.doesNotMatch(r.text, /stack|Error:|SELECT |D1_/i, `${name}: no internals`);
    nothingHappened(mfl, env, name);
  }
});
test("CAP 14 + 15 + 16: an UNACKNOWLEDGED accept makes ZERO MFL writes and ZERO completed-state writes; a STALE acknowledgment (numbers changed) does not count either; a FRESH calculation governs the retry", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 20000, s2: 5000, fill1: 100000, fill2: 290000 });   // the RECIPIENT (0002) is over -- offer creation unaffected
  const o = await sendOffer(env, mfl, SWAP());
  const importsBefore = mfl.st.imports.length;
  const first = await act(env, mobileBody(o.id));
  t.equal(first.status, 409); t.equal(first.json.code, "cap_overage_ack_required");
  t.equal(first.json.compliance.cap.rows.find((x) => x.franchise_id === "0002").used_after, 310000);
  t.equal(mfl.st.imports.length, importsBefore, "not a single import after the offer was sent");
  nothingHappened(mfl, env, "unacknowledged");
  // acknowledge the CURRENT figure, then change the numbers before actually accepting -- the
  // stale acknowledgment must NOT satisfy the fresh recompute
  const p1 = await act(env, mobileBody(o.id, "PREVIEW"));
  const staleSig = p1.json.cap_ack.per_franchise.find((f) => f.franchise_id === "0002").signature;
  mfl.st.rosters["0002"].push({ id: "90003", salary: 1, contractYear: 3, contractStatus: "Vet-FAA" });   // the projected figure moves by $1 -- the old signature no longer matches
  const staleAttempt = await act(env, { ...mobileBody(o.id), cap_ack: { signature: staleSig } });
  t.equal(staleAttempt.status, 409, "a signature computed against the OLD numbers does not satisfy the NEW ones");
  t.equal(staleAttempt.json.code, "cap_overage_ack_required");
  nothingHappened(mfl, env, "stale acknowledgment");
  // the recipient clears cap room (drops payroll) entirely -- no violation left, nothing to acknowledge
  mfl.st.rosters["0002"] = mfl.st.rosters["0002"].filter((p) => p.id !== "90002"); mfl.st.rosters["0002"].push({ id: "90002", salary: 10000, contractYear: 3, contractStatus: "Vet-FAA" });
  const retry = await act(env, mobileBody(o.id));
  t.equal(retry.status, 200, retry.text.slice(0, 200));
  t.equal(retry.json.compliance.cap.status, "ok", "the retry recomputed from the live payroll -- no violation left at all");
  t.equal(mfl.st.done.length, 1);
});
test("PREVIEW: a read-only review returns the same picture the accept enforces, names WHO must acknowledge and the exact signature, and writes nothing", async () => {
  const { env, mfl } = fresh(); world(mfl, { s1: 20000, s2: 5000, fill1: 100000, fill2: 290000 });   // the RECIPIENT is over -- offer creation unaffected
  const o = await sendOffer(env, mfl, SWAP());
  const importsBefore = mfl.st.imports.length;
  const p = await act(env, mobileBody(o.id, "PREVIEW"));
  t.equal(p.status, 200, p.text.slice(0, 200)); t.equal(p.json.action, "PREVIEW"); t.equal(p.json.compliance.cap.status, "blocked");
  t.equal(p.json.compliance.cap.violations[0].amount_over, 10000); t.equal(mfl.st.imports.length, importsBefore); nothingHappened(mfl, env, "preview");
  t.equal(p.json.cap_ack.satisfied, false);
  t.equal(p.json.cap_ack.per_franchise[0].franchise_id, "0002"); t.equal(p.json.cap_ack.per_franchise[0].status, "missing");
  t.ok(p.json.cap_ack.per_franchise[0].signature, "PREVIEW hands back the exact signature ACCEPT will require");
  const real = await act(env, mobileBody(o.id));
  t.equal(real.status, 409); t.deepEqual(real.json.compliance.cap.rows, p.json.compliance.cap.rows, "preview == accept");
  // only the recipient may preview; a signed-out caller cannot
  const other = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-B`, { body: { ...mobileBody(o.id, "PREVIEW"), franchise_id: "0001" } });
  t.equal(other.status, 403);
  const anon = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}`, { body: mobileBody(o.id, "PREVIEW") });
  t.equal(anon.status, 401);
});
test("PREVIEW: unavailable cap data is 503, never a clean bill of health", async () => {
  const { env, mfl } = fresh(); world(mfl, { fill1: 100000, fill2: 100000 });
  const o = await sendOffer(env, mfl, SWAP());
  mfl.st.exportFail = { salaryAdjustments: 500 };
  const p = await act(env, mobileBody(o.id, "PREVIEW"));
  t.equal(p.status, 503); t.equal(p.json.code, "cap_check_unavailable"); t.equal(p.json.compliance.cap.status, "unavailable");
});
test("EXTENSION: the extension's current-year salary is the LIVE salary (the current year is never repriced) — a receiver's cap carries exactly that", async () => {
  // a LOADED final-year contract: salary $4K this year, AAV token $6K → canonical 2-year WR extension: future AAV 6K + 20K = 26K, Y1 stays 4K, TCV 4K + 52K = 56K
  const live = { id: "14056", salary: "4000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 12K|AAV 6K|Y1-4K, Y2-8K" };
  const ext = [{ player_id: "14056", player_name: "P14056", from_franchise_id: "0001", to_franchise_id: "0002", extension_term: "2YR", option_key: "2YR|NONE", loaded_indicator: "NONE", new_contract_status: "EXT2",
    new_TCV: 56000, new_aav_future: 26000, new_contract_length: 3, preview_contract_info_string: "CL 3| TCV 56K| AAV 6K, 26K| Y1-4K, Y2-26K, Y3-26K" }];
  const { env, mfl } = fresh(); world(mfl, { s1: 4000, s2: 5000, fill1: 100000, fill2: 291000 });          // 0002: 296000 − 5000 + 4000 (his live salary, unchanged) = 295000
  mfl.st.salaries = [live];
  const o = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056, 4000)], [player(13100)], { ext }));
  const p = await act(env, mobileBody(o.id, "PREVIEW"));
  t.equal(p.status, 200, p.text.slice(0, 300));
  t.equal(p.json.compliance.cap.rows.find((x) => x.franchise_id === "0002").used_after, 295000, "the receiver carries the extended contract's year 1 = his live $4K salary");
});

// ───────────────────────────────── Part 3 — three-team gates ─────────────────────────────────
const DISCORD = F.DISCORD;
function threeWayWorld(o) {
  o = o || {};
  const env = makeWorkerEnv({ TRADE_3WAY_EXECUTE: o.live ? "1" : "0", ...(o.env || {}) });
  const mfl = makeMfl({ tokens: { "tok-H": "0012" } }); mfl.install();
  bindSelf(env);
  for (const [fid, d] of [["0008", DISCORD.A], ["0001", DISCORD.B], ["0012", DISCORD.C]]) env.UPS_MFL_DB.raw.prepare("INSERT INTO discord_owners VALUES (?,?,?)").run(fid, "Y", d);
  // A(0008) sends 16614→B ; B(0001) sends 16181→C ; C(0012) sends 16650→A   (a clean ring)
  const legs = [{ from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0, summary: "P16614" }, { from: "0001", to: "0012", asset_tokens: ["P_16181"], cap_k: o.capK || 0, summary: "P16181" }, { from: "0012", to: "0008", asset_tokens: ["P_16650"], cap_k: 0, summary: "P16650" }];
  F.seedTrade(env, { legs_json: JSON.stringify(legs), ...(o.row || {}) });
  const s = o.sal || {};
  mfl.st.rosters = {
    "0008": [{ id: "16614", salary: s.a1 == null ? 5000 : s.a1, contractYear: 3, contractStatus: "Vet-FAA" }, ...(o.fillA ? [{ id: "90008", salary: o.fillA, contractYear: 3, contractStatus: "Vet-FAA" }] : [])],
    "0001": [{ id: "16181", salary: s.b1 == null ? 5000 : s.b1, contractYear: 3, contractStatus: "Vet-FAA" }, ...(o.fillB ? [{ id: "90001", salary: o.fillB, contractYear: 3, contractStatus: "Vet-FAA" }] : [])],
    "0012": [{ id: "16650", salary: s.c1 == null ? 5000 : s.c1, contractYear: 3, contractStatus: "Vet-FAA" }, ...(o.fillC ? [{ id: "90012", salary: o.fillC, contractYear: 3, contractStatus: "Vet-FAA" }] : [])],
  };
  if (o.adj) mfl.st.salaryAdjustments = clone(o.adj);
  return { env, mfl };
}
const press = (action, userId) => ({ data: { custom_id: `tr3:${action}:${F.TRADE_ID}` }, member: { user: { id: userId } } });
const say = async (resp) => (await resp.json()).data.content;
const ctxWait = () => { const p = []; return { waitUntil: (x) => p.push(x), flush: () => Promise.all(p) }; };
const dms = (mfl) => mfl.st.discord.filter((d) => /\/messages$/.test(d.url));
const blockDms = (mfl) => dms(mfl).filter((d) => /can't run yet|can't run:/.test(JSON.stringify(d.body || "")));

const ledgerRow = (env) => env.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_trade_executions WHERE exec_key=?").get(F.TRADE_ID);
const recheck = (env, tok) => callWorker(env, "POST", `/api/trades/3way/recheck?${Q}&MFL_USER_ID=${tok || "tok-A"}`, { body: { id: F.TRADE_ID } });
test("3-WAY CAP 4: the THIRD participant would exceed the cap → the accept IS recorded (consent is preserved), the cap is reported, nothing executes", async () => {
  // A: −16614(5000)+16650(a) ; B: −16181+16614 ; C: −16650(30000)+16181(5000) — make C the only one who goes over: C receives 16181 (20000)
  const { env, mfl } = threeWayWorld({ live: true, sal: { a1: 5000, b1: 20000, c1: 5000 }, fillA: 100000, fillB: 100000, fillC: 285000 });   // C: 290000 − 5000 + 20000 = 305000
  const ctx = ctxWait();
  const msg = await say(await handle3WayButton(press("accept", DISCORD.B), env, ctx));
  await ctx.flush();
  t.match(msg, /Hawks would be \$5,000 over the \$300,000 salary cap/); t.match(msg, /your accept is saved and nothing has moved/);
  const row = F.readRow(env);
  t.equal(row.team_b_state, "accepted", "the accept WAS recorded — a partner's consent is never discarded because someone is over the cap"); t.equal(row.status, "collecting");
  t.equal(mfl.writes().length, 0, "not one MFL write"); t.equal(env.__selfCalls.filter((u) => /\/admin\/3way\/compliance/.test(u)).length, 1, "the engine asked the worker's shared authority");
});
test("3-WAY CAP 4a: the LAST accept while over the cap → RECOVERABLE, waiting on an acknowledgment: stays collecting, both approvals kept, ledger blocked_cap, zero MFL writes, never `failed`; the affected owner's own acknowledgment then lets it through", async () => {
  const { env, mfl } = threeWayWorld({ live: true, sal: { a1: 5000, b1: 20000, c1: 5000 }, fillA: 100000, fillB: 100000, fillC: 285000 });
  const ctx = ctxWait();
  await say(await handle3WayButton(press("accept", DISCORD.B), env, ctx));
  const msg = await say(await handle3WayButton(press("accept", DISCORD.C), env, ctx));
  await ctx.flush();
  t.match(msg, /that's everyone/); t.match(msg, /Hawks would be \$5,000 over/);
  const row = F.readRow(env);
  t.equal(row.status, "collecting", "NOT failed, NOT executing"); t.equal(row.team_b_state, "accepted"); t.equal(row.team_c_state, "accepted");
  t.equal(row.failure_reason, null); t.equal(row.mfl_trade_ids, null); t.equal(row.executed_at_utc, null);
  const led = ledgerRow(env); t.equal(led.state, "blocked_cap");
  const blk = JSON.parse(led.block_json); t.equal(blk.kind, "cap_ack_required"); t.deepEqual(blk.violations.map((v) => [v.franchise_id, v.amount_over]), [["0012", 5000]]);
  t.equal(mfl.writes().length, 0, "zero MFL writes"); t.equal(mfl.st.done.length, 0);
  t.equal(blockDms(mfl).length, 3, "all three owners are told once");
  // the owner's view names the blocking franchise and amount
  const d = await callWorker(env, "GET", `/api/trades/3way?id=${F.TRADE_ID}&${Q}&MFL_USER_ID=tok-A`);
  t.equal(d.status, 200); t.equal(d.json.trade.execution.blocked, true); t.equal(d.json.trade.execution.state, "blocked_cap");
  // (this harness serves no player names, so the integrity code says `incomplete` — an integrity problem outranks the label; the message and block are unaffected)
  t.ok(["blocked_cap", "incomplete"].includes(d.json.trade.state_view.code));
  t.deepEqual(d.json.trade.execution.block.violations.map((v) => [v.franchise_name, v.amount_over]), [["Hawks", 5000]]);
  t.match(d.json.trade.state_view.message, /Everyone has already accepted/);
  // approvals are locked in: an owner cannot cancel it any more (commissioner's administrative cancel is the exit)
  const cancel = await callWorker(env, "POST", `/api/trades/3way/cancel?${Q}&MFL_USER_ID=tok-A`, { body: { id: F.TRADE_ID } });
  t.equal(cancel.status, 409); t.equal(cancel.json.code, "cannot_cancel_all_accepted");
  // a non-participant cannot even reach it; a participant with no overage of their own has nothing
  // to acknowledge -- and it does NOT clear Hawks' block
  const outsider = await callWorker(env, "POST", `/api/trades/3way/ack-cap?${Q}&MFL_USER_ID=tok-nobody`, { body: { id: F.TRADE_ID } });
  t.ok([401, 403].includes(outsider.status), `an unrecognized caller is refused (${outsider.status})`);
  const noViolation = await callWorker(env, "POST", `/api/trades/3way/ack-cap?${Q}&MFL_USER_ID=tok-A`, { body: { id: F.TRADE_ID } });
  t.equal(noViolation.status, 200); t.equal(noViolation.json.code, "nothing_to_acknowledge", "team A has no overage of its own to acknowledge");
  const stillBlocked = await recheck(env);
  t.equal(stillBlocked.status, 409, "Hawks' own overage is still unacknowledged"); t.equal(stillBlocked.json.code, "cap_overage_ack_required");
  t.equal(mfl.writes().length, 0, "still zero MFL writes");
  // Hawks' own owner (tok-H → 0012) acknowledges -- and a re-check lets the trade through
  const ack = await callWorker(env, "POST", `/api/trades/3way/ack-cap?${Q}&MFL_USER_ID=tok-H`, { body: { id: F.TRADE_ID } });
  t.equal(ack.status, 200, ack.text.slice(0, 200)); t.equal(ack.json.code, "acknowledged"); t.equal(ack.json.cap_ack.franchise_id, "0012"); t.equal(ack.json.cap_ack.amount_over, 5000);
  env.TRADE_3WAY_EXECUTE = "0";                                                     // dry run so the test doesn't drive live legs
  const recheckAfterAck = await recheck(env);
  t.equal(recheckAfterAck.status, 200, recheckAfterAck.text.slice(0, 200)); t.equal(recheckAfterAck.json.code, "rechecking");
  t.equal(F.readRow(env).status, "completed", "the acknowledged overage no longer blocks execution -- it was displayed and acknowledged, never itself a block");
});
test("3-WAY CAP 4b: cap changed between the accepts → the EXECUTE gate blocks RECOVERABLY before any MFL call, waiting on an acknowledgment; re-check recomputes, and the affected owner's acknowledgment lets it execute (still over cap)", async () => {
  const { env, mfl } = threeWayWorld({ live: true, sal: { a1: 5000, b1: 5000, c1: 5000 }, fillA: 100000, fillB: 100000, fillC: 100000, row: { status: "executing", team_b_state: "accepted", team_c_state: "accepted" } });
  const liveFlag = env.TRADE_3WAY_EXECUTE;
  mfl.st.salaryAdjustments = [{ franchise_id: "0012", amount: "200000", description: "manual commissioner adjustment" }];       // C is now far over
  const out = await execute3Way(env, F.TRADE_ID);
  t.equal(out.ok, false); t.equal(out.error, "cap_gate"); t.equal(out.blocked, true);
  let row = F.readRow(env);
  t.equal(row.status, "collecting", "recoverable — never `failed`"); t.equal(row.failure_reason, null); t.equal(row.mfl_trade_ids, null); t.equal(row.executed_at_utc, null);
  t.equal(row.team_b_state, "accepted"); t.equal(row.team_c_state, "accepted");
  t.equal(ledgerRow(env).state, "blocked_cap"); t.equal(JSON.parse(ledgerRow(env).block_json).kind, "cap_ack_required");
  t.equal(mfl.writes().length, 0, "zero MFL writes"); t.equal(mfl.st.done.length, 0);
  t.equal(blockDms(mfl).length, 3, "all three owners are told once");
  // an identical re-run is the SAME problem: not announced again
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_3way_trades SET status='executing'").run();
  await execute3Way(env, F.TRADE_ID);
  t.equal(blockDms(mfl).length, 3, "no repeat DM for the same block"); t.equal(F.readRow(env).status, "collecting");
  // a re-check while STILL unacknowledged: refused, recomputed, nothing changes
  const still = await recheck(env);
  t.equal(still.status, 409); t.equal(still.json.code, "cap_overage_ack_required"); t.match(still.json.message, /Hawks would be/); t.match(still.json.message, /to acknowledge/);
  t.equal(F.readRow(env).status, "collecting"); t.equal(mfl.writes().length, 0);
  // Hawks' own owner (tok-H → 0012) acknowledges the CURRENT figure -- this is what actually lets
  // it through, not a changed cap: the adjustment is left in place, so this proves the trade can
  // genuinely execute while still $200,000 over cap once acknowledged.
  const ack = await callWorker(env, "POST", `/api/trades/3way/ack-cap?${Q}&MFL_USER_ID=tok-H`, { body: { id: F.TRADE_ID } });
  t.equal(ack.status, 200, ack.text.slice(0, 200)); t.equal(ack.json.cap_ack.amount_over, 5000);
  t.equal(liveFlag, "1", "(the block happened with LIVE execution on)");
  env.TRADE_3WAY_EXECUTE = "0";                                                     // dry run so the test doesn't drive live legs
  const fixed = await recheck(env);
  t.equal(fixed.status, 200, fixed.text.slice(0, 200)); t.equal(fixed.json.code, "rechecking");
  row = F.readRow(env); t.equal(row.status, "completed"); t.equal(row.failure_reason, "dry_run");
  t.equal(row.team_b_state, "accepted");
});
test("3-WAY CAP 4c: re-check refuses what it must — a stranger, a trade that is not blocked, an unknown id", async () => {
  const { env } = threeWayWorld({ live: true, fillA: 100000, fillB: 100000, fillC: 100000 });
  const notBlocked = await recheck(env); t.equal(notBlocked.status, 409); t.equal(notBlocked.json.code, "not_blocked");
  const anon = await callWorker(env, "POST", `/api/trades/3way/recheck?${Q}`, { body: { id: F.TRADE_ID } });
  t.ok([401, 403].includes(anon.status), `anonymous: ${anon.status}`);
  const nope = await callWorker(env, "POST", `/api/trades/3way/recheck?${Q}&MFL_USER_ID=tok-A`, { body: { id: "00000000-0000-4000-8000-000000000000" } });
  t.equal(nope.status, 404);
});
test("3-WAY CAP 12/13: cap authority unavailable or malformed at accept OR execute → accept preserved, execution blocked RECOVERABLY (cap_check_unavailable), zero writes, heals on re-check", async () => {
  for (const [name, breakIt, heal] of [
    ["salaryAdjustments down", (m) => { m.st.exportFail = { salaryAdjustments: 500 }; }, (m) => { m.st.exportFail = {}; }],
    ["league down", (m) => { m.st.exportFail = { league: 503 }; }, (m) => { m.st.exportFail = {}; }],
    ["adjustments malformed", (m) => { m.st.exportBody = { salaryAdjustments: { salaryAdjustments: { junk: 1 } } }; }, (m) => { m.st.exportBody = {}; }],
  ]) {
    const { env, mfl } = threeWayWorld({ live: true, fillA: 100000, fillB: 100000, fillC: 100000 });
    breakIt(mfl);
    const msg = await say(await handle3WayButton(press("accept", DISCORD.B), env, ctxWait()));
    t.match(msg, /couldn't verify the salary cap/, `${name}: reported at accept`); t.equal(F.readRow(env).team_b_state, "accepted", `${name}: consent preserved`);
    t.equal(mfl.writes().length, 0);
    env.UPS_MFL_DB.raw.prepare("UPDATE ups_3way_trades SET status='executing', team_b_state='accepted', team_c_state='accepted'").run();
    const out = await execute3Way(env, F.TRADE_ID);
    t.equal(out.ok, false, `${name}: execute refused`); t.equal(out.kind, "unavailable");
    t.equal(F.readRow(env).status, "collecting", `${name}: recoverable, not failed`); t.equal(ledgerRow(env).state, "blocked_cap"); t.equal(JSON.parse(ledgerRow(env).block_json).kind, "unavailable");
    t.equal(mfl.writes().length, 0, `${name}: zero MFL writes`); t.equal(F.readRow(env).executed_at_utc, null);
    heal(mfl); env.TRADE_3WAY_EXECUTE = "0";
    const r = await recheck(env);
    t.equal(r.status, 200, `${name}: heals on re-check: ${r.text.slice(0, 160)}`); t.equal(F.readRow(env).status, "completed");
  }
  // no service binding at all / a dead binding → also unavailable, also recoverable
  const noSelf = threeWayWorld({ fillA: 100000, fillB: 100000, fillC: 100000 }); delete noSelf.env.SELF;
  t.match(await say(await handle3WayButton(press("accept", DISCORD.B), noSelf.env, ctxWait())), /couldn't verify the salary cap/);
  t.equal(F.readRow(noSelf.env).team_b_state, "accepted");
  const dead = threeWayWorld({ fillA: 100000, fillB: 100000, fillC: 100000 }); dead.env.SELF = { fetch: async () => { throw new Error("boom"); } };
  t.match(await say(await handle3WayButton(press("accept", DISCORD.B), dead.env, ctxWait())), /couldn't verify the salary cap/);
});
test("3-WAY: a healthy trade goes through (dry-run) and cap money is charged to the sender / credited to the receiver in the projection", async () => {
  const { env, mfl } = threeWayWorld({ capK: 2, fillA: 100000, fillB: 100000, fillC: 100000 });
  const ctx = ctxWait();
  t.match(await say(await handle3WayButton(press("accept", DISCORD.B), env, ctx)), /You're in/);
  t.match(await say(await handle3WayButton(press("accept", DISCORD.C), env, ctx)), /processing the trade now/);
  await ctx.flush();
  t.equal(F.readRow(env).status, "completed"); t.equal(F.readRow(env).failure_reason, "dry_run");
  const detail = await callWorker(env, "GET", `/api/trades/3way?id=${F.TRADE_ID}&${Q}&MFL_USER_ID=tok-A`);
  t.equal(detail.status, 200);                                                    // (terminal trades carry no live projection)
  t.equal(detail.json.trade.compliance, undefined);
});
test("CAP 17: two-team and three-team calculations use the SAME authority — identical inputs give identical numbers", async () => {
  // 3-way GET detail (real worker) for a collecting trade …
  const { env, mfl } = threeWayWorld({ sal: { a1: 5000, b1: 20000, c1: 5000 }, fillA: 100000, fillB: 100000, fillC: 285000 });
  const d = await callWorker(env, "GET", `/api/trades/3way?id=${F.TRADE_ID}&${Q}&MFL_USER_ID=tok-A`);
  t.equal(d.status, 200, d.text.slice(0, 200));
  const c3 = d.json.trade.compliance;
  // … equals what the shared module computes from the very same MFL exports
  const direct = evaluateTradeCompliance({
    league: ok({ league: { salaryCapAmount: "300000", franchises: { franchise: Object.entries({ "0008": "Real Deal Creel", "0001": "L.A. Looks", "0012": "Hawks" }).map(([id, name]) => ({ id, name })) } } }),
    rosters: rosterOf({ "0008": [{ id: "16614", salary: 5000 }, { id: "90008", salary: 100000 }], "0001": [{ id: "16181", salary: 20000 }, { id: "90001", salary: 100000 }], "0012": [{ id: "16650", salary: 5000 }, { id: "90012", salary: 285000 }] }),
    salaries: noSalaries, adjustments: adjOf([]),
    movements: [{ from: "0008", to: "0001", tokens: ["16614"] }, { from: "0001", to: "0012", tokens: ["16181"] }, { from: "0012", to: "0008", tokens: ["16650"] }],
  });
  const strip = (x) => x.rows.map((r) => ({ f: r.franchise_id, b: r.used_before, a: r.used_after, o: r.over_by }));
  t.deepEqual(strip(c3.cap), strip(direct.cap)); t.equal(c3.cap.status, "blocked"); t.equal(direct.cap.status, "blocked");
  t.deepEqual(c3.cap.violations.map((v) => [v.franchise_id, v.amount_over]), [["0012", 5000]]);
  // the same swap seen as a 2-team trade (the accept path) yields the same per-team arithmetic
  const two = fresh(); world(two.mfl, { s1: 5000, s2: 20000, fill1: 100000, fill2: 285000 });
  const o = await sendOffer(two.env, two.mfl, SWAP());
  const p = await act(two.env, mobileBody(o.id, "PREVIEW"));
  const twoDirect = evaluateTradeCompliance({
    league: ok({ league: { salaryCapAmount: "300000", franchises: { franchise: [{ id: "0001", name: "L.A. Looks" }, { id: "0002", name: "CBP" }] } } }),
    rosters: rosterOf({ "0001": [{ id: "14056", salary: 5000 }, { id: "90001", salary: 100000 }], "0002": [{ id: "13100", salary: 20000 }, { id: "90002", salary: 285000 }] }),
    salaries: noSalaries, adjustments: adjOf([]), movements: [{ from: "0001", to: "0002", tokens: ["14056"] }, { from: "0002", to: "0001", tokens: ["13100"] }],
  });
  t.deepEqual(p.json.compliance.cap.rows, twoDirect.cap.rows, "the 2-team accept path computes exactly what the shared module computes");
  t.equal(p.json.compliance.cap.rows.find((x) => x.franchise_id === "0002").used_after, 290000);
  t.equal(p.json.compliance.cap.rows.find((x) => x.franchise_id === "0001").used_after, 120000);
  t.equal(p.json.compliance.cap.cap_dollars, c3.cap.cap_dollars);
  t.equal(mfl.writes().length, 0);
});

// ─────────────── Part 4 — roster counts: the MAXIMUM is a hard gate, the 27 minimum a heads-up (Keith 2026-10-07) ───────────────
const SEATS = (start, n) => bulk(start, n, 100);
test("ROSTER: a balanced trade between legal rosters is clean (status ok, no warnings)", async () => {
  const { env, mfl } = fresh(); world(mfl, { fill1: 100000, fill2: 100000, extra1: SEATS(100, 28), extra2: SEATS(500, 28), league: { rosterSize: "35" } });
  const o = await sendOffer(env, mfl, SWAP());
  const p = await act(env, mobileBody(o.id, "PREVIEW"));
  t.equal(p.json.compliance.roster.status, "ok"); t.deepEqual(p.json.compliance.roster.warnings, []);
  t.equal(p.json.compliance.roster_limit.status, "ok"); t.equal(p.json.compliance.roster_limit.executable, true);
  t.match(p.json.compliance.roster_limit.message, /Every team stays at or under the roster maximum/);
});
test("ROSTER: an uneven trade that pushes one team over the maximum is REFUSED at accept — nothing sent to MFL, the team and the move it needs are named", async () => {
  const { env, mfl } = fresh(); world(mfl, { fill1: 100000, fill2: 100000, extra1: SEATS(100, 28), extra2: SEATS(500, 33), league: { rosterSize: "35" } });    // 0002: 36 active (13100+90002+33+... )
  const two = payloadOf("0001", "0002", [player(14056), player(90001)], [player(13100)]);       // 0002 receives two, sends one → +1
  const o = await sendOffer(env, mfl, two);
  const p = await act(env, mobileBody(o.id, "PREVIEW"));
  const rows = Object.fromEntries(p.json.compliance.roster.rows.map((r) => [r.franchise_id, r]));
  t.equal(rows["0002"].status, "above_max"); t.equal(rows["0002"].active_after, rows["0002"].active_before + 1); t.equal(rows["0002"].max, 35);
  t.equal(rows["0001"].status, "within");
  t.equal(p.json.compliance.roster_limit.status, "blocked");
  t.match(p.json.compliance.roster_limit.message, /CBP would have 36 active players right after this trade — the maximum is 35\. CBP needs 1 more roster spot: make 1 legal roster move/);
  t.ok(p.json.roster_limit_block && p.json.roster_limit_block.code === "roster_room_required", "the preview names the block");
  // the accept itself IS refused, before MFL
  const r = await act(env, mobileBody(o.id));
  t.equal(r.status, 409, r.text.slice(0, 200)); t.equal(r.json.code, "roster_room_required"); t.match(r.json.message, /Nothing was changed/);
  t.equal(mfl.st.done.length, 0, "MFL was never asked to accept"); t.equal(mfl.st.pending.length, 1, "the offer is still pending");
});
test("ROSTER: an MFL rejection is still surfaced, in MFL's own words, alongside the advisory (never swallowed)", async () => {
  const { env, mfl } = fresh(); world(mfl, { fill1: 100000, fill2: 100000, extra1: SEATS(100, 28), extra2: SEATS(500, 28), league: { rosterSize: "35" } });
  const o = await sendOffer(env, mfl, payloadOf("0001", "0002", [player(14056), player(90001)], [player(13100)]));
  mfl.st.failNext = { type: "tradeResponse", status: 200, message: "Roster limit exceeded: CBP would have 36 players (maximum 35)." };
  const r = await act(env, mobileBody(o.id));
  t.equal(r.status, 502); t.equal(r.json.code, "mfl_rejected"); t.equal(r.json.ok, false);
  t.match(r.json.message, /MFL didn't accept this trade: .*Roster limit exceeded/); t.match(r.json.error, /Roster limit exceeded/); t.match(r.json.mfl_message, /maximum 35/);
  t.equal(mfl.st.done.length, 0); t.equal(mfl.st.pending.length, 1);
  t.equal(outbox(env).filter((x) => ["VERIFIED", "COMPLETED"].includes(x.status)).length, 0);
});
test("ROSTER: roster-count authority missing is shown as UNAVAILABLE, not as compliant", async () => {
  const { env, mfl } = fresh(); world(mfl, { fill1: 100000, fill2: 100000, extra1: SEATS(100, 28), extra2: SEATS(500, 28), league: { rosterSize: "" } });
  const o = await sendOffer(env, mfl, SWAP());
  const p = await act(env, mobileBody(o.id, "PREVIEW"));
  t.equal(p.status, 200); t.equal(p.json.compliance.roster.status, "unavailable"); t.doesNotMatch(p.json.compliance.roster.message, /within its roster limits/);
  t.equal(p.json.compliance.roster_limit.status, "unavailable"); t.equal(p.json.compliance.roster_limit.executable, false);
  t.equal(p.json.compliance.cap.status, "ok", "the cap verdict is independent of the roster check");
  const r = await act(env, mobileBody(o.id));
  t.equal(r.status, 503, "an unreadable maximum refuses the accept (fail closed)"); t.equal(r.json.code, "roster_limit_check_unavailable"); t.equal(mfl.st.done.length, 0);
});
test("ROSTER (3-way): only ONE participant is over the maximum; the detail and the Discord accept say it can't run until that team makes its move (the accept itself is recorded)", async () => {
  const { env, mfl } = threeWayWorld({ fillA: 100000, fillB: 100000, fillC: 100000 });
  // give B and C legal-size rosters; A sits at the limit and receives one player without sending an equivalent
  mfl.st.rosters["0008"].push(...SEATS(100, 34)); mfl.st.rosters["0001"].push(...SEATS(200, 28)); mfl.st.rosters["0012"].push(...SEATS(300, 28));
  mfl.st.league = { rosterSize: "35" };
  // A: 36 active now (16614 + 90008 + 34) — sends 1, receives 1 → 36? make A send nothing extra: add a 2nd inbound movement
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_3way_trades SET legs_json=?").run(JSON.stringify([
    { from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0, summary: "P16614" }, { from: "0001", to: "0008", asset_tokens: ["P_16181", "P_200"], cap_k: 0, summary: "P16181+P200" }, { from: "0012", to: "0008", asset_tokens: ["P_16650"], cap_k: 0, summary: "P16650" },
  ]));
  const d = await callWorker(env, "GET", `/api/trades/3way?id=${F.TRADE_ID}&${Q}&MFL_USER_ID=tok-A`);
  t.equal(d.status, 200, d.text.slice(0, 200));
  const rl = d.json.trade.compliance.roster_limit;
  t.equal(rl.status, "blocked"); t.deepEqual(rl.violations.map((w) => w.franchise_id), ["0008"], "exactly one participant is over");
  t.equal(d.json.trade.compliance.cap.status, "ok");
  const msg = await say(await handle3WayButton(press("accept", DISCORD.B), env, ctxWait()));
  t.match(msg, /You're in/); t.match(msg, /Real Deal Creel would have 38 active players right after this trade — the maximum is 35/); t.match(msg, /can't run until that's resolved — your accept is saved and nothing has moved/);
  t.equal(F.readRow(env).team_b_state, "accepted", "a partner's accept is still recorded; the trade runs only once the over-limit team has made its move");
});
test("ROSTER (3-way, Keith 2026-10-07): a leg sends a TAXI player to a team already at 30 → judged on the ACTUAL count (31), never credited as a taxi move — the 3-way engine has no taxi step; the execute gate refuses before any MFL write", async () => {
  const { env, mfl } = threeWayWorld({ live: true, fillA: 100000, fillB: 100000, fillC: 100000, row: { status: "executing", team_b_state: "accepted", team_c_state: "accepted" } });
  // A(0008) → B: 16614 ; B(0001) → C: 16181, on B's TAXI squad and as taxi-eligible as a player can be (UPS R2 pick this
  // season, Rookie-Draft contract, no call-ups, game days away) ; C(0012) → A: a pick only. Hawks (C) sit at exactly 30 active.
  mfl.st.rosters["0001"][0] = { id: "16181", salary: 5000, status: "TAXI_SQUAD", contractYear: 3, contractStatus: "Rookie-Draft" };
  mfl.st.rosters["0008"].push(...SEATS(100, 26)); mfl.st.rosters["0001"].push(...SEATS(200, 26)); mfl.st.rosters["0012"].push(...SEATS(300, 28));
  mfl.st.league = { rosterSize: "30", taxiSquad: "10" };
  mfl.st.draftPicks = [{ round: "2", pick: "5", franchise: "0001", player: "16181" }];
  mfl.st.futurePicks["0012"] = [{ year: 2027, round: 3 }];
  env.UPS_MFL_DB.raw.prepare("UPDATE ups_3way_trades SET legs_json=?").run(JSON.stringify([
    { from: "0008", to: "0001", asset_tokens: ["P_16614"], cap_k: 0, summary: "P16614" },
    { from: "0001", to: "0012", asset_tokens: ["P_16181"], cap_k: 0, summary: "P16181 (taxi)" },
    { from: "0012", to: "0008", asset_tokens: ["FP_0012_2027_3"], cap_k: 0, summary: "2027 R3" },
  ]));
  const d = await callWorker(env, "GET", `/api/trades/3way?id=${F.TRADE_ID}&${Q}&MFL_USER_ID=tok-A`);
  t.equal(d.status, 200, d.text.slice(0, 200));
  const rl = d.json.trade.compliance.roster_limit;
  const hawks = rl.rows.find((r) => r.franchise_id === "0012");
  t.equal(hawks.active_before, 30); t.equal(hawks.active_after, 31, "MFL lands him ACTIVE");
  t.equal(hawks.active_after_taxi, 31, "and nothing moves him afterward in a 3-way, so no taxi credit"); t.equal(hawks.moves_needed, 1);
  t.deepEqual(hawks.taxi_moves, []); t.deepEqual(hawks.taxi_not_credited.map((x) => x.reason), ["no_taxi_step"]);
  t.equal(rl.status, "blocked"); t.equal(rl.executable, false); t.deepEqual(rl.violations.map((w) => w.franchise_id), ["0012"]);
  t.equal(rl.violations[0].message, "Hawks would have 31 active players right after this trade — the maximum is 30. Hawks needs 1 more roster spot: make 1 legal roster move first (for example, move an eligible injured player to IR), or revise the offer. Test P16181 can't count as a taxi move: a 3-way trade has no step that moves him to the taxi squad afterward.");
  // all three have accepted: the execute gate refuses RECOVERABLY before any MFL write
  const out = await execute3Way(env, F.TRADE_ID);
  t.equal(out.ok, false); t.equal(out.blocked, true);
  const led = ledgerRow(env); t.equal(led.state, "blocked_cap"); t.equal(JSON.parse(led.block_json).kind, "roster_room_required");
  t.deepEqual(JSON.parse(led.block_json).violations.map((v) => [v.franchise_id, v.active_after, v.active_after_taxi]), [["0012", 31, 31]]);
  t.equal(F.readRow(env).status, "collecting", "approvals kept; never `failed`"); t.equal(mfl.writes().length, 0, "zero MFL writes"); t.equal(mfl.st.done.length, 0);
  t.match(JSON.stringify(blockDms(mfl).map((x) => x.body)), /Hawks needs 1 more roster spot/);
  // a caller can't buy a credit for a 3-way: a taxi list sent to either compliance route is ignored for three teams
  const mv3 = [{ from: "0008", to: "0001", tokens: ["16614"] }, { from: "0001", to: "0012", tokens: ["16181"] }, { from: "0012", to: "0008", tokens: ["FP_0012_2027_3"] }];
  const adm = await callWorker(env, "POST", `/admin/3way/compliance?${Q}&APIKEY=admin-key-secret`, { body: { league_id: "74598", season: "2026", movements: mv3, taxi_step_player_ids: ["16181"] } });
  t.equal(adm.json.compliance.roster_limit.rows.find((r) => r.franchise_id === "0012").active_after_taxi, 31);
  const pre = await callWorker(env, "POST", `/api/trades/compliance-preview?${Q}&MFL_USER_ID=tok-A`, { body: { league_id: "74598", season: "2026", from_franchise_id: "0008", movements: mv3.map((m) => ({ from: m.from, to: m.to, asset_tokens: m.tokens })), taxi_step_player_ids: ["16181"] } });
  t.equal(pre.status, 200, pre.text.slice(0, 200));
  t.equal(pre.json.compliance.roster_limit.status, "blocked"); t.equal(pre.json.compliance.roster_limit.rows.find((r) => r.franchise_id === "0012").active_after_taxi, 31);
  t.equal(mfl.writes().length, 0);
  // the same arrival with Hawks one under (29) fits on the ACTUAL count: 29 + 1 = 30
  mfl.st.rosters["0012"].pop();
  const ok2 = await callWorker(env, "GET", `/api/trades/3way?id=${F.TRADE_ID}&${Q}&MFL_USER_ID=tok-A`);
  t.equal(ok2.json.trade.compliance.roster_limit.status, "ok"); t.equal(ok2.json.trade.compliance.roster_limit.rows.find((r) => r.franchise_id === "0012").active_after, 30);
});
test("3-WAY detail: a live trade carries its cap + roster picture; an unavailable calculation is shown as unavailable", async () => {
  const { env, mfl } = threeWayWorld({ fillA: 100000, fillB: 100000, fillC: 100000 });
  mfl.st.exportFail = { salaryAdjustments: 500 };
  const d = await callWorker(env, "GET", `/api/trades/3way?id=${F.TRADE_ID}&${Q}&MFL_USER_ID=tok-A`);
  t.equal(d.status, 200); t.equal(d.json.trade.compliance.cap.status, "unavailable"); t.equal(d.json.trade.compliance.roster.status, "unavailable");
  t.doesNotMatch(JSON.stringify(d.json.trade.compliance), /under the salary cap\.|within its roster limits/);
});
test("/admin/3way/compliance is an internal route: no key → 401, wrong key → 403; it never writes", async () => {
  const { env, mfl } = threeWayWorld({ fillA: 1, fillB: 1, fillC: 1 });
  const body = { league_id: "74598", season: "2026", movements: [{ from: "0008", to: "0001", tokens: ["16614"] }] };
  t.equal((await callWorker(env, "POST", `/admin/3way/compliance?${Q}`, { body })).status, 401);
  t.equal((await callWorker(env, "POST", `/admin/3way/compliance?${Q}&APIKEY=wrong`, { body })).status, 403);
  t.equal((await callWorker(env, "POST", `/admin/3way/compliance?${Q}&APIKEY=admin-key-secret&MFL_USER_ID=tok-A`, { body })).status, 200);
  t.equal(mfl.writes().length, 0);
});

await run("trade_cap_gate");
restore();
