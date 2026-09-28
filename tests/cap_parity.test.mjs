// FRONT OFFICE ⇄ TRADE WAR ROOM CAP PARITY — one calculation, proven end to end through the real worker.
//   node tests/cap_parity.test.mjs
//
// The Front Office roster workbench (GET /roster-workbench, "cap used") and the Trade War Room (PREVIEW / accept, "used before/after") both
// run worker/src/cap_math.js. These tests feed IDENTICAL raw MFL exports to both endpoints and require identical franchise totals (compared as
// JSON text, i.e. byte-equivalent), across every input that can move a cap number: taxi, IR, known-expired vs unknown contracts, loaded /
// front-loaded contracts, the salaries-export overlay, dead money, cap-money adjustments in every token form, rounding, and unresolved data.
// The Front Office is also used as the ORACLE for a whole trade: after the trade lands (rosters moved, the worker's own salaryAdj rows
// posted), the Front Office's number for each team must equal the Trade War Room's projected "used after".
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { evaluateTradeCompliance } from "../worker/src/trade_cap_authority.js";

const restore = quiet();
const Q = "L=74598&YEAR=2026";
const src = (f) => fs.readFileSync(new URL(f, import.meta.url), "utf8");

// ── the world: every team gets a different mix of the inputs that move a cap number ─────────────────────────────────────────────
const P = (id, salary, o) => ({ id: String(id), salary, ...(o || {}) });
const WORLD = () => ({
  rosters: {
    "0001": [P(14056, 5000, { contractYear: 2, contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 10K|AAV 5K|Y1-5K, Y2-5K" }),
      P(90101, 8001, { status: "INJURED_RESERVE", contractYear: 1, contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 8K|AAV 8K|Y1-8K" }),      // IR: half, rounded
      P(90102, 2000, { status: "TAXI_SQUAD", contractYear: 2, contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 4K|AAV 2K|Y1-2K, Y2-2K" }),
      P(90103, 3000, { contractYear: 0, contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 3K|AAV 3K|Y1-3K" }),                                  // KNOWN expired → 0
      P(90104, 1000, { contractYear: 2, contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 2K|AAV 1K|Y1-1K, Y2-1K" })],                        // a normal flat contract (see the dedicated cap-math test below for "unknown still counts" -- it can no longer share this HTTP-path fixture)
    "0002": [P(13100, 5000, { contractYear: 1, contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }),
      P(90201, 15000, { contractYear: 3, contractStatus: "Vet-Ext2-FL", contractInfo: "CL 3|TCV 30K|AAV 10K|Y1-15K, Y2-10K, Y3-5K" }),           // front-loaded: THIS year's 15K
      P(90202, 4000, { contractYear: 2, contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 8K|AAV 4K|Y1-4K, Y2-4K" })],
    "0003": [P(15000, 6000, { contractYear: 2, contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 12K|AAV 6K|Y1-6K, Y2-6K" }), P(90301, 7000, { contractYear: 1, contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 7K|AAV 7K|Y1-7K" })],
    "0005": [P(90501, 5000, { contractYear: 1, contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" })],
    "0007": [P(90701, 5000, { contractYear: 1, contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 5K|AAV 5K|Y1-5K" }), P(90702, 3000, { contractYear: 1, contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 3K|AAV 3K|Y1-3K" })],
  },
  // the salaries export OVERLAYS a roster row (it wins where it has a row with contractYear > 0), exactly as the Front Office reads it
  salaries: [{ id: "90301", salary: "9000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 9K|AAV 9K|Y1-9K" }],
  adjustments: [
    { franchise_id: "0001", amount: "1500.00", description: "drop penalty (dead money)" }, { franchise_id: "0001", amount: "-200", description: "rounding row" },
    { franchise_id: "0002", amount: "5K", description: "UPS traded salary settlement" }, { franchise_id: "0002", amount: "$1,000.60", description: "manual" },
    { franchise_id: "0003", amount: "-2500", description: "UPS traded salary settlement" },
    { franchise_id: "0005", amount: "0.4", description: "sub-dollar" },
  ],
});
function fresh(w) {
  const env = makeWorkerEnv(); const mfl = makeMfl({ tokens: { "tok-5": "0005", "tok-7": "0007" } }); mfl.install();
  w = w || WORLD();
  mfl.st.rosters = JSON.parse(JSON.stringify(w.rosters));
  mfl.st.salaries = JSON.parse(JSON.stringify(w.salaries || []));
  mfl.st.salaryAdjustments = JSON.parse(JSON.stringify(w.adjustments || []));
  return { env, mfl };
}
const foTotals = async (env) => {
  const r = await callWorker(env, "GET", `/roster-workbench?${Q}&disable_cache=1`);
  t.equal(r.status, 200, r.text.slice(0, 120));
  return Object.fromEntries(r.json.teams.map((tm) => [tm.franchise_id, { used: tm.summary.cap_total_dollars + tm.summary.salary_adjustment_total_dollars, unresolved: tm.summary.cap_unresolved, label: tm.summary.compliance.label }]));
};
const P2 = (id, salary) => ({ asset_id: `P_${id}`, type: "PLAYER", player_id: String(id), player_name: `P${id}`, salary, taxi: false, contract_info: "" });
const payloadOf = (from, to, give, recv, o) => ({
  schema_version: 1, source: "parity", league_id: "74598", season: "2026",
  teams: [{ role: "left", franchise_id: from, selected_assets: give.map((x) => P2(x, 1)), traded_salary_adjustment_k: (o && o.fromCapK) || 0 },
    { role: "right", franchise_id: to, selected_assets: recv.map((x) => P2(x, 1)), traded_salary_adjustment_k: (o && o.toCapK) || 0 }],
  extension_requests: [], ui: { left_team_id: from, right_team_id: to }, validation: { status: "ready" },
});
const TOK = { "0001": "tok-B", "0002": "tok-C", "0003": "tok-O", "0005": "tok-5", "0007": "tok-7" };
// A REAL offer from `from` to `to` through the real proposal route; returns the trade id.
async function offer(env, mfl, from, to, give, recv, o) {
  const r = await callWorker(env, "POST", `/api/trades/proposals?${Q}&MFL_USER_ID=${TOK[from]}`, { body: { league_id: "74598", season: "2026", from_franchise_id: from, to_franchise_id: to, message: "", payload: payloadOf(from, to, give, recv, o) } });
  t.ok(r.status < 300, `offer ${from}→${to}: ${r.status} ${r.text.slice(0, 160)}`);
  return mfl.st.pending[mfl.st.pending.length - 1].trade_id;
}
const preview = (env, id, recipient) => callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=${TOK[recipient]}`, { body: { action: "PREVIEW", trade_id: id, league_id: "74598", franchise_id: recipient, year: "2026" } });

test("PARITY: identical raw exports → identical franchise totals from the Front Office and the Trade War Room (every team, as JSON text)", async () => {
  const { env, mfl } = fresh();
  const fo = await foTotals(env);
  const seen = {};
  // every team appears on both sides of some real offer, so each one is computed by the Trade War Room path too
  const pairs = [["0001", "0002", [14056], [13100]], ["0003", "0002", [15000], [90202]], ["0005", "0003", [90501], [90301]], ["0007", "0001", [90701], [90104]]];
  for (const [from, to, give, recv] of pairs) {
    const id = await offer(env, mfl, from, to, give, recv);
    const p = await preview(env, id, to);
    t.equal(p.status, 200, `${from}→${to}: ${p.text.slice(0, 200)}`);
    for (const row of p.json.compliance.cap.rows) seen[row.franchise_id] = row.used_before;
    mfl.st.pending = [];
  }
  const teams = Object.keys(WORLD().rosters);
  for (const fid of teams) t.ok(fid in seen, `${fid} was computed by the Trade War Room path`);
  t.equal(JSON.stringify(Object.fromEntries(teams.map((f) => [f, seen[f]]))), JSON.stringify(Object.fromEntries(teams.map((f) => [f, fo[f].used]))), "byte-equivalent franchise totals");
  // and the hand-derived numbers (so 'equal' can't mean 'equally wrong')
  t.equal(fo["0001"].used, 5000 + 4001 + 0 + 0 + 1000 + 1500 - 200, "0001: flat + IR half (8001→4001) + taxi 0 + known-expired 0 + a second flat contract 1000 + dead money − rounding row");
  t.equal(fo["0002"].used, 5000 + 15000 + 4000 + 5000 + 1001, "0002: front-loaded counts THIS year's 15K; '5K' = 5000; '$1,000.60' = 1001");
  t.equal(fo["0003"].used, 6000 + 9000 - 2500, "0003: the salaries export (9000) overlays the roster row (7000); trade credit −2500");
});
test("PARITY: TAXI, IR, expired, loaded, overlay, adjustments and rounding are each individually identical (one input changed at a time)", async () => {
  const cases = {
    "taxi is free": (w) => { w.rosters["0007"][0].status = "TAXI_SQUAD"; },
    "IR is half (odd salary rounds)": (w) => { w.rosters["0007"][1].status = "INJURED_RESERVE"; w.rosters["0007"][1].salary = 3001; },
    "known-expired contract is free": (w) => { w.rosters["0007"][0].contractYear = 0; w.rosters["0007"][0].contractStatus = "Vet-FAA"; },
    "loaded contract = this year's amount": (w) => { Object.assign(w.rosters["0007"][0], { salary: 20000, contractYear: 3, contractStatus: "Vet-Ext2-BL", contractInfo: "CL 3|TCV 30K|AAV 10K|Y1-20K, Y2-5K, Y3-5K" }); },
    "salaries overlay wins": (w) => { w.salaries.push({ id: "90701", salary: "12345", contractYear: "2", contractStatus: "Vet-FAA", contractInfo: "CL 2|TCV 24K|AAV 12K|Y1-12K, Y2-12K" }); },
    "an overlay row with contractYear 0 is IGNORED": (w) => { w.salaries.push({ id: "90701", salary: "99999", contractYear: "0", contractStatus: "Vet-FAA", contractInfo: "CL 1|TCV 1K|AAV 1K|Y1-1K" }); },
    "positive dead money": (w) => { w.adjustments.push({ franchise_id: "0007", amount: "4000.00", description: "drop penalty" }); },
    "negative trade credit": (w) => { w.adjustments.push({ franchise_id: "0007", amount: "-1234", description: "UPS traded salary settlement" }); },
    "'K' unit token": (w) => { w.adjustments.push({ franchise_id: "0007", amount: "2.5K", description: "manual" }); },
    "fractional dollars round": (w) => { w.adjustments.push({ franchise_id: "0007", amount: "999.5", description: "x" }, { franchise_id: "0007", amount: "0.4", description: "x" }); },
    "salary with a decimal is truncated like the Front Office": (w) => { w.rosters["0007"][0].salary = "5000.9"; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const w = WORLD(); mutate(w);
    const { env, mfl } = fresh(w);
    const fo = await foTotals(env);
    const id = await offer(env, mfl, "0007", "0001", [90701], [90104]);
    const p = await preview(env, id, "0001");
    t.equal(p.status, 200, `${name}: ${p.text.slice(0, 160)}`);
    const row = p.json.compliance.cap.rows.find((r) => r.franchise_id === "0007");
    t.equal(JSON.stringify(row.used_before), JSON.stringify(fo["0007"].used), `${name}: Front Office ${fo["0007"].used} == Trade War Room ${row.used_before}`);
  }
});
test("PARITY (cap-math only, direct): a contract with NOTHING known -- years, status, AND contractInfo all blank -- still counts its FULL salary toward the cap, verified directly against evaluateTradeCompliance's cap block. Not through the full HTTP preview path: that SAME blank contract also makes loaded_contracts separately, honestly unavailable now (2026-09-28 review, row 6) -- the whole HTTP preview refuses before ever answering the cap question, so cap math's own 'unknown still counts' rule can only be exercised directly here, not end to end through a preview that MUST now decline to answer at all", () => {
  const ok = (data) => ({ ok: true, status: 200, data });
  const league = ok({ league: { salaryCapAmount: "300000", rosterSize: "35", franchises: { franchise: [{ id: "0007", name: "x" }, { id: "0001", name: "y" }] } } });
  const rosters = ok({ rosters: { franchise: [
    { id: "0007", player: [{ id: "90701", salary: "5000", status: "ROSTER" }] },   // NOTHING known at all -- the exact cap_math.js `unknown` shape
    { id: "0001", player: [{ id: "90104", salary: "1000", status: "ROSTER", contractYear: "2", contractStatus: "Vet-FAA" }] },
  ] } });
  const c = evaluateTradeCompliance({ league, salaries: ok({ salaries: { leagueUnit: { player: [] } } }), adjustments: ok({ salaryAdjustments: "" }), rosters, movements: [{ from: "0007", to: "0001", tokens: ["90701"] }] });
  const row = c.cap.rows.find((r) => r.franchise_id === "0007");
  t.equal(row.used_before, 5000, "a genuinely unknown contract still counts its full salary toward the cap -- silence is not proof of expiry");
  t.equal(c.cap.status, "ok", "the cap result is fully computed and valid");
  t.equal(c.loaded_contracts.status, "unavailable", "...even though the loaded-contract verdict for the exact SAME blank contract is honestly unresolved -- these are two separate results, and one being unavailable must never erase or block the other's already-valid number (this is what the review's row 6 actually requires: unavailable for loaded_contracts, NOT for cap)");
});
test("PARITY: a WHOLE TRADE — after it lands, the Front Office's number for each team equals the Trade War Room's projected 'used after' (players, IR/taxi handling, cap-money direction, rounding)", async () => {
  const { env, mfl } = fresh();
  // 0001 sends flat 14056 + IR 90101 + $2K cap money; 0002 sends front-loaded 90201 and $500 back
  const id = await offer(env, mfl, "0001", "0002", [14056, 90101], [90201], { fromCapK: 2, toCapK: 0 });
  const p = await preview(env, id, "0002");
  t.equal(p.status, 200, p.text.slice(0, 200));
  const after = Object.fromEntries(p.json.compliance.cap.rows.map((r) => [r.franchise_id, r.used_after]));
  // the real accept: MFL accepts, and the worker posts its cap-money adjustment rows to MFL (the stub records them)
  const acc = await callWorker(env, "POST", `/api/trades/proposals/action?${Q}&MFL_USER_ID=tok-C`, { body: { action: "ACCEPT", trade_id: id, league_id: "74598", franchise_id: "0002", year: "2026" } });
  t.equal(acc.status, 200, acc.text.slice(0, 200));
  // MFL then moves the players: they land as ROSTER (full salary, IR flag gone) on the receiving team
  const move = (from, to, pid) => { const i = mfl.st.rosters[from].findIndex((x) => x.id === String(pid)); const [pl] = mfl.st.rosters[from].splice(i, 1); mfl.st.rosters[to].push({ ...pl, status: "ROSTER" }); };
  move("0001", "0002", 14056); move("0001", "0002", 90101); move("0002", "0001", 90201);
  const fo = await foTotals(env);
  t.equal(JSON.stringify([fo["0001"].used, fo["0002"].used]), JSON.stringify([after["0001"], after["0002"]]), "byte-equivalent after-trade totals");
  t.ok(mfl.writes("salaryAdj").length === 1, "the cap money was posted as adjustment rows (sender +, receiver −)");
});
test("PARITY (unresolved data): a BLANK roster salary is unresolved in BOTH — the Front Office names it, the trade gate fails closed; neither guesses $0", async () => {
  const w = WORLD(); w.rosters["0007"][1].salary = null;
  const { env, mfl } = fresh(w);
  const fo = await foTotals(env);
  t.ok(fo["0007"].unresolved.some((u) => u.reason === "salary_blank" && u.player_id === "90702"), "Front Office reports the unresolved salary");
  t.match(fo["0007"].label, /Unavailable/);
  t.deepEqual(fo["0001"].unresolved, [], "other teams are unaffected");
  const id = await offer(env, mfl, "0001", "0007", [14056], [90701]);
  const p = await preview(env, id, "0007");
  t.equal(p.status, 503); t.equal(p.json.code, "cap_check_unavailable"); t.equal(p.json.compliance.cap.reason, "roster_salary_unresolved");
  // unreadable adjustment amount: the Front Office flags it (it used to be dropped silently); the trade gate fails closed
  const w2 = WORLD(); w2.adjustments.push({ franchise_id: "0001", amount: "n/a", description: "junk" });
  const b = fresh(w2);
  const fo2 = await foTotals(b.env);
  t.ok(fo2["0001"].unresolved.some((u) => u.reason === "salary_adjustment_amount_unreadable"));
  const id2 = await offer(b.env, b.mfl, "0001", "0002", [14056], [13100]);
  const p2 = await preview(b.env, id2, "0002");
  t.equal(p2.status, 503); t.equal(p2.json.compliance.cap.reason, "adjustments_malformed");
  // salary adjustments export down → both say so
  const c = fresh(); c.mfl.st.exportFail = { salaryAdjustments: 500 };
  const fo3 = await callWorker(c.env, "GET", `/roster-workbench?${Q}&disable_cache=1`);
  t.ok(fo3.status !== 200 || fo3.json.teams.every((tm) => tm.summary.cap_unresolved.some((u) => u.reason === "salary_adjustments_unavailable")));
});
test("ONE MODULE: both callers import worker/src/cap_math.js; neither carries its own copy of the rule or of the IR constant", () => {
  const cm = src("../worker/src/cap_math.js"), ta = src("../worker/src/trade_cap_authority.js"), ix = src("../worker/src/index.js");
  t.match(cm, /export function currentCapHit/); t.match(cm, /IR_RELIEF_RATE = 0\.5/);
  t.match(ta, /from "\.\/cap_math\.js"/); t.doesNotMatch(ta, /IR_RELIEF|\* 0\.5|function capHit|const capHit\s*=\s*\(/);
  t.match(ix, /from "\.\/cap_math\.js"/); t.match(ix, /sharedCurrentCapHit\(\{ salary: safeInt\(salary, 0\)/);
  const foBody = ix.slice(ix.indexOf("THE cap rule lives in worker/src/cap_math.js"), ix.indexOf("const formatContractK = (amount) => {"));
  t.doesNotMatch(foBody, /\* 0\.5|Math\.round\(amt/, "the Front Office no longer contains the formula");
  t.equal((ta.match(/currentCapHit\(/g) || []).length >= 3, true);
});

await run("cap_parity");
restore();
