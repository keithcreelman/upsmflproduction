// Commissioner Desk tools 5 to 10: roster.current, cap.position, cap.penalty_quote, cap.adjustments, extension.price, calendar.events.
//   node tests/ai_desk_tools_cap.test.mjs
//
// Every route-backed tool runs through the REAL registry (runTool) against the REAL worker handler (worker/src/index.js default.fetch,
// the same harness the other worker tests use), with fetchSelf = the worker's own self fetch. Only the network edges are faked: a
// stateful MFL (tests/fixtures/worker_harness.mjs) plus the NFL schedule / calendar the routes read. Offline and deterministic: the clock
// (`Date`) is fixed per test, and the tool receives the same instant as `now`.
//
// Expected values come from canon (docs/league_context_v1.md section 6.C4 worked examples, 6.F, C3 and the extension schedule), not from
// the code under test. Where code and canon differ the test says so and does not bend.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeD1 } from "./fixtures/d1_sqlite.mjs";
import { THREE_WAY_MIGRATIONS } from "./fixtures/d1_sqlite.mjs";
import { makeWorkerEnv, bindSelf, makeMfl } from "./fixtures/worker_harness.mjs";
const worker = (await import("../worker/src/index.js")).default;
const { runTool, listTools, _resetRegistryForTests } = await import("../worker/src/desk/registry.js");
const { makeCommishCaller } = await import("../worker/src/desk/contract.js");
// importing a tool file registers it (defineTool); a fresh registry first so a re-import cannot collide
_resetRegistryForTests();
const T = {
  roster: (await import("../worker/src/desk/tools/roster_current.js")).default,
  position: (await import("../worker/src/desk/tools/cap_position.js")).default,
  quote: (await import("../worker/src/desk/tools/cap_penalty_quote.js")).default,
  adjust: (await import("../worker/src/desk/tools/cap_adjustments.js")).default,
  ext: (await import("../worker/src/desk/tools/extension_price.js")).default,
  cal: (await import("../worker/src/desk/tools/calendar_events.js")).default,
};
const { PRICING_VERSION } = await import("../worker/src/extension_pricing.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ── a fixed clock ──────────────────────────────────────────────────────────────────────────────
const RealDate = Date;
let NOW = RealDate.parse("2026-03-15T16:00:00Z");
globalThis.Date = class extends RealDate { constructor(...a) { super(...(a.length ? a : [NOW])); } static now() { return NOW; } };
const setNow = (iso) => { NOW = RealDate.parse(iso); };

// ── the world: one worker env over a stateful MFL, plus the NFL schedule and MFL calendar the routes read ──
// 2026 as MFL has it: Week 1 opens Wed 9/9 8:20 PM ET; Week w >= 2 opens Thu 8:15 PM ET (9/17, 9/24, ...).
const kickoff = (w) => Math.floor((w === 1 ? RealDate.UTC(2026, 8, 10, 0, 20) : RealDate.UTC(2026, 8, 18 + 7 * (w - 2), 0, 15)) / 1000);
const TUE_NOV24_NOON_ET = Math.floor(RealDate.parse("2026-11-24T12:00:00-05:00") / 1000);
const jsonRes = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json" } });

const env = bindSelf(makeWorkerEnv({ __migrations: [...THREE_WAY_MIGRATIONS, "0026_league_events.sql"] }));
const mfl = makeMfl({});
mfl.install();
const mflFetch = globalThis.fetch;
const edge = async (input, init) => {
  const u = new URL(String(input));
  if (/myfantasyleague\.com$/.test(u.hostname)) {
    const type = u.searchParams.get("TYPE");
    if (type === "nflSchedule") {
      const w = Number(u.searchParams.get("W"));
      return jsonRes({ nflSchedule: { week: String(w), matchup: [{ kickoff: String(kickoff(w)), team: [{ id: "AAA" }, { id: "BBB" }] }] } });
    }
    if (type === "calendar") return jsonRes({ calendar: { event: [{ id: "901", type: "TRADE", start_time: String(TUE_NOV24_NOON_ET) }] } });
  }
  return mflFetch(input, init);
};
globalThis.fetch = edge;

// the tool's only network capability: the worker's own handler, as env.SELF would be
const fetchSelf = (u, init) => env.SELF.fetch(u, init);
const KNOW = { leagueId: "74598", currentSeason: 2026, calendar: { faAuctionStart: "2026-07-22" } };
const caller = makeCommishCaller("0008");
let seq = 0;
async function call(tool, args, o) {
  o = o || {};
  env.__selfCalls.length = 0;
  const deps = { fetchSelf: o.fetchSelf || fetchSelf, now: () => new RealDate(NOW), nowMs: () => NOW, knowledge: o.knowledge || KNOW };
  const raw = Object.prototype.hasOwnProperty.call(o, "raw") ? o.raw : { as_of: o.as_of || "current" };
  const e = await runTool({ caller, callSeq: (seq += 1) }, tool.id, { ...args, ...raw }, deps);
  return e;
}
const fact = (e, key) => { const f = e.facts.find((x) => x.id.endsWith("." + key)); return f ? f.value : undefined; };
const factOf = (e, key) => e.facts.find((x) => x.id.endsWith("." + key));
const dump = (e) => JSON.stringify(e);
async function rawPreview(query) {
  env.__selfCalls.length = 0;
  const r = await env.SELF.fetch(`https://self.invalid/api/cap-penalty/preview?L=74598&YEAR=2026&${query}`);
  return r.json();
}

// rosters: franchise 0008 holds whatever a test sets
const P = (id, salary, cy, info, o) => ({ id, salary, contractYear: cy, contractInfo: info, contractStatus: (o && o.status) || "Veteran", status: (o && o.slot) || "ROSTER" });
const setRoster = (...players) => { mfl.st.rosters = { "0008": players }; };
const FLAT90 = "CL 3| TCV 90K| AAV 30K| Y1-30K, Y2-30K, Y3-30K";

// ── 0. definitions ─────────────────────────────────────────────────────────────────────────────
test("six tools register with the contract's ids; EXT_URL is in no allowlist; only roster/cap tools may reach the workbench", () => {
  const ids = listTools().map((x) => x.id).sort();
  t.equal(JSON.stringify(ids), JSON.stringify(["calendar.events", "cap.adjustments", "cap.penalty_quote", "cap.position", "extension.price", "roster.current"]));
  for (const tool of listTools()) {
    t.equal(tool.dataClass, "P0"); t.equal(tool.readOnly, true);
    for (const r of tool.allowlist.routes) t.ok(!r.params.includes("EXT_URL"), `${tool.id} ${r.path} must not allow EXT_URL`);
    t.equal(tool.allowlist.tables.length, 0);
  }
  const wb = (id) => listTools().find((x) => x.id === id).allowlist.routes.find((r) => r.path === "/roster-workbench");
  t.equal(JSON.stringify(wb("roster.current").params), JSON.stringify(["L", "YEAR", "NO_CACHE"]));
  t.equal(JSON.stringify(wb("cap.position").params), JSON.stringify(["L", "YEAR", "NO_CACHE"]));
  t.ok(listTools().find((x) => x.id === "extension.price").allowlist.modules.includes("extension_pricing.js"));
});

// ── 1. roster.current ──────────────────────────────────────────────────────────────────────────
test("roster.current: always NO_CACHE=1 with L and YEAR, never EXT_URL; contractInfo preserved exactly", async () => {
  setNow("2026-03-15T16:00:00Z");
  setRoster(P("16614", 30000, 2, FLAT90), P("16193", 40000, 2, "CL 3| TCV 90K| AAV 30K| Y1-40K, Y2-30K, Y3-20K", { slot: "INJURED_RESERVE" }));
  const e = await call(T.roster, { franchise_id: "8" });
  t.equal(e.status, "ok");
  const urls = env.__selfCalls.map((u) => new URL(u));
  t.equal(urls.length, 1);
  t.equal(urls[0].pathname, "/roster-workbench");
  t.equal(urls[0].searchParams.get("NO_CACHE"), "1"); t.equal(urls[0].searchParams.get("L"), "74598"); t.equal(urls[0].searchParams.get("YEAR"), "2026");
  t.ok(!env.__selfCalls.some((u) => /EXT_URL/i.test(u)), "EXT_URL never on the wire");
  t.equal(e.data.franchise_id, "0008");
  t.equal(e.data.players.find((p) => p.id === "16614").special, FLAT90, "the contract text is the route's, byte for byte");
  t.equal(fact(e, "p16614_contract"), FLAT90);
  t.equal(fact(e, "p16614_salary"), 30000); t.equal(fact(e, "p16614_years_remaining"), 2);
  t.equal(factOf(e, "p16614_years_remaining").unit, "years");
  t.equal(fact(e, "ir_count"), 1); t.equal(fact(e, "active_count"), 2);
  t.ok(e.facts.every((f) => f.grade === "A"));
  t.equal(e.provenance.ext_url_sent, false); t.equal(e.provenance.no_cache, true); t.equal(e.freshness.cache, "bypassed");
});

test("roster.current: owner e-mails, tokens and upstream URLs never leave, even if the route leaked them", async () => {
  setRoster(P("16614", 30000, 2, FLAT90));
  const leaky = async (u, init) => {
    const r = await env.SELF.fetch(u, init);
    const j = await r.json();
    for (const team of j.teams) { team.owner_email = "boss@ups.test"; for (const p of team.players) { p.owner_email = "x@ups.test"; p.mfl_user_id = "tok-secret"; } }
    j.meta.api_token = "api-secret"; j.owner_email = "top@ups.test";
    return new Response(JSON.stringify(j), { status: 200 });
  };
  const e = await call(T.roster, { franchise_id: "0008" }, { fetchSelf: leaky });
  t.equal(e.status, "ok");
  const s = dump(e);
  for (const bad of ["@ups.test", "tok-secret", "api-secret", "APIKEY", "myfantasyleague.com", "owner_email"]) t.ok(!s.includes(bad), `no '${bad}' in the envelope`);
  // and the unmodified route has none either
  const clean = await call(T.roster, { franchise_id: "0008" });
  t.ok(!dump(clean).includes("@ups.test"));
});

test("roster.current: an unknown franchise is no_record, an EXT_URL argument is rejected before any route call", async () => {
  const none = await call(T.roster, { franchise_id: "0099" });
  t.equal(none.status, "no_record"); t.equal(none.facts.length, 0); t.equal(none.coverage.gaps[0].why, "NO_RECORD");
  const bad = await call(T.roster, { franchise_id: "0008", EXT_URL: "https://evil.example/x.json" });
  t.equal(bad.status, "error"); t.equal(bad.error.code, "bad_arguments"); t.equal(env.__selfCalls.length, 0);
});

// ── 2. cap.position ────────────────────────────────────────────────────────────────────────────
const tenK = (n, base) => Array.from({ length: n }, (_, i) => P(String(base + i), 10000, 1, "CL 1| TCV 10K| AAV 10K| Y1-10K"));

test("cap.position (canon 6.F1): 26 active, $230K committed, $0 adjustments -> $70K available, $69K max bid", async () => {
  setNow("2026-03-15T16:00:00Z");
  mfl.st.salaryAdjustments = [];
  setRoster(...tenK(22, 20000), ...Array.from({ length: 4 }, (_, i) => P(String(20100 + i), 2500, 1, "CL 1| TCV 3K| AAV 3K| Y1-3K")));
  const e = await call(T.position, { franchise_id: "0008", include_max_bid: true });
  t.equal(e.status, "ok");
  t.equal(fact(e, "roster_count"), 26); t.equal(fact(e, "committed_salary"), 230000); t.equal(fact(e, "salary_cap"), 300000);
  t.equal(fact(e, "cap_used"), 230000); t.equal(fact(e, "cap_available"), 70000); t.equal(fact(e, "max_bid"), 69000);
  t.equal(factOf(e, "cap_available").grade, "C"); t.equal(factOf(e, "salary_cap").grade, "A");
  t.ok(e.coverage.gaps.some((g) => g.why === "partial_coverage" && /position minimums/.test(g.what)), "max bid names what it leaves out");
  const noBid = await call(T.position, { franchise_id: "0008" });
  t.equal(fact(noBid, "max_bid"), undefined, "no max bid unless asked"); t.equal(noBid.coverage.gaps.length, 0);
  const urls = env.__selfCalls.map((u) => new URL(u));
  t.equal(urls[0].searchParams.get("NO_CACHE"), "1"); t.ok(!env.__selfCalls.some((u) => /EXT_URL/.test(u)));
});

test("cap.position: $270K committed; a $40K player moved to IR -> $250K (IR counts 50%)", async () => {
  setRoster(P("20001", 40000, 1, "CL 1| TCV 40K| AAV 40K| Y1-40K"), ...tenK(23, 20100));
  const before = await call(T.position, { franchise_id: "0008" });
  t.equal(fact(before, "committed_salary"), 270000); t.equal(fact(before, "cap_available"), 30000);
  setRoster(P("20001", 40000, 1, "CL 1| TCV 40K| AAV 40K| Y1-40K", { slot: "INJURED_RESERVE" }), ...tenK(23, 20100));
  const after = await call(T.position, { franchise_id: "0008" });
  t.equal(fact(after, "committed_salary"), 250000); t.equal(fact(after, "cap_used"), 250000); t.equal(fact(after, "cap_available"), 50000);
  t.equal(fact(after, "p20001_cap_hit"), 20000, "the IR player's own hit is half his salary");
});

test("cap.position: a $20K IR player is a $10K hit; a $15K taxi player is $0", async () => {
  setRoster(P("20001", 20000, 1, "CL 1| TCV 20K| AAV 20K| Y1-20K", { slot: "INJURED_RESERVE" }), P("20002", 15000, 3, "CL 3| TCV 45K| AAV 15K| Y1-15K, Y2-15K, Y3-15K", { status: "Rookie-Draft", slot: "TAXI_SQUAD" }), P("20003", 10000, 1, "CL 1| TCV 10K| AAV 10K| Y1-10K"));
  const e = await call(T.position, { franchise_id: "0008" });
  t.equal(e.status, "ok");
  t.equal(fact(e, "p20001_cap_hit"), 10000); t.equal(fact(e, "p20002_cap_hit"), 0);
  t.equal(fact(e, "committed_salary"), 20000, "10K (IR half) + 0 (taxi) + 10K");
  t.equal(e.data.taxi_count, 1); t.equal(e.data.ir_count, 1); t.equal(fact(e, "roster_count"), 2, "taxi is not counted toward the roster");
});

test("cap.position: a salary adjustment is a CHARGE when positive, a credit when negative; labels say so", async () => {
  setRoster(...tenK(20, 20000));
  mfl.st.salaryAdjustments = [{ franchise_id: "0008", amount: "5000", description: "UPS drop penalty Someone 5000 id:adddrop2026_1.1" }, { franchise_id: "0008", amount: "-2000", description: "UPS traded salary settlement (trade_1): net -2K" }];
  const e = await call(T.position, { franchise_id: "0008" });
  t.equal(e.status, "ok");
  t.equal(fact(e, "committed_salary"), 200000); t.equal(fact(e, "salary_adjustments"), 3000);
  t.equal(fact(e, "cap_used"), 203000, "committed + adjustments: a net charge raises cap used");
  t.equal(fact(e, "cap_available"), 97000);
  t.match(factOf(e, "salary_adjustments").label, /positive = a charge/); t.match(factOf(e, "cap_used").label, /positive = a charge/);
  mfl.st.salaryAdjustments = [];
});

test("cap.position: unresolved cap inputs (a blank salary) and a route/cap_math mismatch are refused, never a number", async () => {
  setRoster(P("20001", null, 1, "CL 1| TCV 10K| AAV 10K| Y1-10K"), ...tenK(3, 20100));
  const e = await call(T.position, { franchise_id: "0008" });
  t.equal(e.status, "refused"); t.equal(e.refusal.code, "unverified_calculation"); t.equal(e.facts.length, 0); t.equal(e.data, null);
  setRoster(...tenK(3, 20000));
  const tamper = async (u, init) => { const r = await env.SELF.fetch(u, init); const j = await r.json(); j.teams.forEach((x) => { x.summary.cap_total_dollars += 1000; }); return new Response(JSON.stringify(j), { status: 200 }); };
  const m = await call(T.position, { franchise_id: "0008" }, { fetchSelf: tamper });
  t.equal(m.status, "refused"); t.equal(m.facts.length, 0); t.match(m.refusal.reason, /disagree/);
});

// ── 3. cap.penalty_quote: canon goldens (6.C4) ─────────────────────────────────────────────────
const quote = (pid, args, o) => call(T.quote, { player_id: pid, ...(args || {}) }, o);

test("quote golden C4.1: 3-year flat $30K (TCV $90K), Y2 offseason cut = $37,500", async () => {
  setNow("2026-03-15T16:00:00Z");
  setRoster(P("16614", 30000, 2, FLAT90));
  const e = await quote("16614");
  t.equal(e.status, "ok"); t.equal(fact(e, "penalty"), 37500); t.equal(fact(e, "guaranteed"), 67500); t.equal(fact(e, "earned"), 30000);
  t.equal(factOf(e, "penalty").grade, "C"); t.match(factOf(e, "penalty").label, /current-rule quote/);
  t.equal(e.provenance.guards.g1, "passed (year-by-year salaries verified)");
  const paths = env.__selfCalls.map((u) => new URL(u).pathname);
  t.ok(paths.includes("/api/cap-penalty/preview"));
  const pv = new URL(env.__selfCalls.find((u) => /cap-penalty/.test(u)));
  t.equal(pv.searchParams.get("YEAR"), "2026", "the season is always explicit (the route would default to a hard-coded 2026)"); t.equal(pv.searchParams.get("L"), "74598");
});

test("quote golden C4.3: 40/30/20 front-loaded, Y2 offseason cut = $27,500 (earned is the year's actual $40K, not AAV)", async () => {
  setRoster(P("16614", 30000, 2, "CL 3| TCV 90K| AAV 30K| Y1-40K, Y2-30K, Y3-20K"));
  const e = await quote("16614");
  t.equal(e.status, "ok"); t.equal(fact(e, "penalty"), 27500); t.equal(fact(e, "earned"), 40000);
});

test("quote golden C4.6: Ext1 TCV $60K (Y1 $25K), cut in the extension year offseason = $20,000", async () => {
  setRoster(P("16614", 35000, 1, "CL 2| TCV 60K| AAV 25K, 35K| Y1-25K, Y2-35K", { status: "Vet-Ext1" }));
  const e = await quote("16614");
  t.equal(e.status, "ok"); t.equal(fact(e, "penalty"), 20000); t.equal(fact(e, "guaranteed"), 45000); t.equal(fact(e, "earned"), 25000);
});

test("quote golden D1/C2: CL3 TCV $3K with 1 year left = $0, with 2 years left = $1,000 (flat, final year free)", async () => {
  const info = "CL 3|TCV 3K|AAV 1K|Y1-1K, Y2-1K, Y3-1K";
  setRoster(P("16614", 1000, 1, info, { status: "Vet-WW" }));
  const one = await quote("16614");
  t.equal(one.status, "ok"); t.equal(fact(one, "penalty"), 0);
  setRoster(P("16614", 1000, 2, info, { status: "Vet-WW" }));
  const two = await quote("16614");
  t.equal(two.status, "ok"); t.equal(fact(two, "penalty"), 1000);
});

test("quote golden C3 (code per-week rule): WW $25K picked up Week 5, 9 completed weeks -> earned $9,615, penalty $9,135 (unrounded, per drop)", async () => {
  setNow("2026-11-19T16:00:00Z");
  setRoster(P("16614", 25000, 1, "CL 1| TCV 25K| AAV 25K| Y1-25K", { status: "Vet-WW" }));
  const e = await quote("16614", { drop_date: "2026-11-14", acquisition_week: 5 });
  t.equal(e.status, "ok");
  t.equal(fact(e, "completed_weeks"), 9); t.equal(fact(e, "earned"), 9615); t.equal(fact(e, "penalty"), 9135);
  t.equal(fact(e, "guaranteed"), 18750); t.equal(e.data.eligible_weeks, 13, "Weeks 5 through 17");
  t.equal(e.data.what_if, true); t.match(factOf(e, "penalty").label, /what-if/);
  // The route exposes no rounding: RULE-CAP-002 rounds at the TEAM level (a reconcile-post write route), so a $10,238 total -> $10,000
  // and a $1,500 -> $2,000 cannot be tested through any read route. The per-drop figure stays raw.
  t.notEqual(fact(e, "penalty") % 1000, 0, "the per-drop penalty is not rounded to $1K");
});

test("quote vs canon C4.7: WW $25K, Week 5 pickup, cut about Nov 5 (8 completed weeks) -> earned $7,692, penalty $11,058, as canon's worked example", async () => {
  setNow("2026-11-19T16:00:00Z");
  setRoster(P("16614", 25000, 1, "CL 1| TCV 25K| AAV 25K| Y1-25K", { status: "Vet-WW" }));
  const e = await quote("16614", { drop_date: "2026-11-07", acquisition_week: 5 });
  t.equal(e.status, "ok");
  t.equal(fact(e, "completed_weeks"), 8); t.equal(fact(e, "earned"), 7692); t.equal(fact(e, "penalty"), 11058);
});

test("quote golden: the same contract, 12 of 17 weeks completed (a 17-week window) -> earned $17,647, penalty $1,103", async () => {
  setNow("2026-12-20T16:00:00Z");
  setRoster(P("16614", 25000, 1, "CL 1| TCV 25K| AAV 25K| Y1-25K", { status: "Vet-WW" }));
  const e = await quote("16614", { drop_date: "2026-12-05" });
  t.equal(e.status, "ok");
  t.equal(fact(e, "completed_weeks"), 12); t.equal(fact(e, "earned"), 17647); t.equal(fact(e, "penalty"), 1103);
});

test("quote: what-if overrides reach the calculator (salary, status, info, years) and are labeled", async () => {
  setNow("2026-03-15T16:00:00Z");
  setRoster(P("16614", 10000, 1, "CL 1| TCV 10K| AAV 10K| Y1-10K"));
  const e = await quote("16614", { contractInfo: FLAT90, contractYear: 2, salary: 30000, contractStatus: "Veteran" });
  t.equal(e.status, "ok"); t.equal(fact(e, "penalty"), 37500); t.equal(e.data.what_if, true);
  t.equal(env.__selfCalls.filter((u) => /roster-workbench/.test(u)).length, 0, "every input stated: no workbench read needed");
  const u = new URL(env.__selfCalls[0]);
  t.equal(u.searchParams.get("contractInfo"), FLAT90); t.equal(u.searchParams.get("contractYear"), "2");
});

// ── 4. G1: no guessed earned salary ────────────────────────────────────────────────────────────
const G1_NO_TOKENS = "CL 3| TCV 12K| AAV 3K";
const G1_TOKENS = "CL 3| TCV 12K| AAV 3K| Y1-4K, Y2-4K, Y3-4K";

test("G1: 'CL 3| TCV 12K| AAV 3K', 1 year left, no Y-tokens -> refused/incomplete_contract_data, and NO number anywhere in the envelope", async () => {
  setNow("2026-03-15T16:00:00Z");
  setRoster(P("16614", 4000, 1, G1_NO_TOKENS));
  const raw = await rawPreview("player_id=16614");
  t.equal(raw.penalty, 3000, "the raw route falls back to AAV x years played and returns $3K");
  t.notEqual(raw.penalty, 1000, "the posted figure for this archive contract is $1K: the fallback is wrong, so the guard matters");
  const e = await quote("16614");
  t.equal(e.status, "refused"); t.equal(e.refusal.code, "incomplete_contract_data");
  t.equal(e.facts.length, 0); t.equal(e.data, null);
  t.equal(e.coverage.supported, false); t.ok(e.coverage.gaps.length >= 1 && /year-by-year salaries/.test(e.coverage.gaps[0].what), "names the missing source");
  const s = dump(e);
  for (const n of ["3000", "9000", "6000", "3,000", "$3K", "penalty\":"])t.ok(!s.includes(n), `route figure '${n}' is not in the envelope`);
});

test("G1: the same contract WITH per-year tokens is quoted normally ($9K guarantee - $8K earned = $1,000)", async () => {
  setRoster(P("16614", 4000, 1, G1_TOKENS));
  const e = await quote("16614");
  t.equal(e.status, "ok"); t.equal(fact(e, "penalty"), 1000); t.equal(fact(e, "earned"), 8000);
  const raw = await rawPreview("player_id=16614");
  t.equal(raw.penalty, 1000, "with tokens the route and the tool agree");
});

test("G1: partial tokens (a completed year missing), no CL/TCV, a blank contractInfo, and a what-if string without tokens are all refused", async () => {
  setRoster(P("16614", 4000, 1, "CL 3| TCV 12K| AAV 3K| Y1-4K"));
  const partial = await quote("16614");
  t.equal(partial.status, "refused"); t.equal(partial.refusal.code, "incomplete_contract_data"); t.equal(partial.facts.length, 0);
  setRoster(P("16614", 4000, 1, "AAV 3K| Y1-4K, Y2-4K"));
  const noClTcv = await quote("16614");
  t.equal(noClTcv.status, "refused"); t.equal(noClTcv.refusal.code, "incomplete_contract_data");
  setRoster(P("16614", 4000, 2, FLAT90));
  const whatIf = await quote("16614", { contractInfo: G1_NO_TOKENS, contractYear: 1 });
  t.equal(whatIf.status, "refused"); t.equal(whatIf.refusal.code, "incomplete_contract_data");
  t.equal(env.__selfCalls.filter((u) => /roster-workbench/.test(u)).length, 1, "only the status was missing, so the workbench was read once");
});

test("G1: a contract the calculator itself holds for review (unstamped, or week authority unresolved) is never a $0 quote", async () => {
  setNow("2026-03-15T16:00:00Z");
  setRoster({ id: "16614", salary: null, status: "ROSTER" });
  const raw = await rawPreview("player_id=16614");
  t.equal(raw.penalty, 0); t.equal(raw.needs_review, true); t.equal(raw.basis, "contract_unstamped_needs_review");
  const unstamped = await quote("16614");
  t.equal(unstamped.status, "refused"); t.equal(unstamped.refusal.code, "unverified_calculation"); t.equal(unstamped.facts.length, 0);
  setNow("2026-11-19T16:00:00Z");     // in season, "now": only live scoring may answer, and this MFL has none
  setRoster(P("16614", 25000, 1, "CL 1| TCV 25K| AAV 25K| Y1-25K", { status: "Vet-WW" }));
  const held = await quote("16614");
  t.equal(held.status, "refused"); t.equal(held.refusal.code, "unverified_calculation"); t.equal(held.facts.length, 0);
  setNow("2026-03-15T16:00:00Z");
});

test("quote: a player not on any roster is no_record; a drop date outside the season is refused", async () => {
  setRoster(P("16614", 30000, 2, FLAT90));
  const none = await quote("99999");
  t.equal(none.status, "no_record"); t.equal(none.facts.length, 0);
  const wrongYear = await quote("16614", { drop_date: "2025-12-01" });
  t.equal(wrongYear.status, "refused"); t.equal(wrongYear.facts.length, 0);
});

// ── 5. G2: tag cut near the FA Auction ─────────────────────────────────────────────────────────
const TAG = () => setRoster(P("16614", 30000, 1, "CL 1| TCV 30K| AAV 30K| Y1-30K", { status: "Tag" }));

test("G2: a tag cut quoted only when route and canon agree: both before the auction start -> cap-free $0", async () => {
  setNow("2026-05-20T16:00:00Z"); TAG();
  const e = await quote("16614");
  t.equal(e.status, "ok"); t.equal(fact(e, "penalty"), 0); t.equal(fact(e, "basis"), "tag_pre_auction_exempt");
  t.equal(e.data.guards.g2.applies, true); t.equal(e.data.guards.g2.auction_start, "2026-07-22"); t.equal(e.data.guards.g2.canon_view, "cap-free");
});

test("G2: both on or after Aug 1 -> the standard formula, quoted ($30K tag: 75% guarantee, nothing earned in preseason = $22,500)", async () => {
  setNow("2026-08-10T16:00:00Z"); TAG();
  const e = await quote("16614");
  t.equal(e.status, "ok"); t.equal(fact(e, "penalty"), 22500); t.equal(e.data.guards.g2.route_view, "standard formula");
});

test("G2: between the auction start and Aug 1 the route says cap-free, canon says standard -> refused/tag_cutoff_unreliable, no number", async () => {
  setNow("2026-07-25T16:00:00Z"); TAG();
  const raw = await rawPreview("player_id=16614");
  t.equal(raw.penalty, 0); t.equal(raw.basis, "tag_pre_auction_exempt");
  const e = await quote("16614");
  t.equal(e.status, "refused"); t.equal(e.refusal.code, "tag_cutoff_unreliable"); t.equal(e.facts.length, 0); t.equal(e.data, null);
  t.ok(!dump(e).includes("tag_pre_auction_exempt"), "the route's answer is not leaked");
});

test("G2: a past drop date is judged by today's date by the route -> refused", async () => {
  setNow("2026-11-19T16:00:00Z"); TAG();
  const raw = await rawPreview("player_id=16614&drop_date=2026-06-01");
  t.notEqual(raw.basis, "tag_pre_auction_exempt"); t.ok(raw.penalty > 0, "the route prices a June cut with the standard formula because today is past Aug 1");
  const e = await quote("16614", { drop_date: "2026-06-01" });
  t.equal(e.status, "refused"); t.equal(e.refusal.code, "tag_cutoff_unreliable"); t.equal(e.facts.length, 0);
  t.ok(!dump(e).includes(String(raw.penalty)), "the route's number never appears");
});

test("G2: a future drop date from before the auction is refused too (today and the drop date straddle the cutoffs)", async () => {
  setNow("2026-05-20T16:00:00Z"); TAG();
  const e = await quote("16614", { drop_date: "2026-08-15" });
  t.equal(e.status, "refused"); t.equal(e.refusal.code, "tag_cutoff_unreliable");
});

test("G2: an unresolvable auction start is refused: no knowledge.calendar, a typed placeholder row, or another season's date", async () => {
  setNow("2026-05-20T16:00:00Z"); TAG();
  const none = await quote("16614", {}, { knowledge: { leagueId: "74598", currentSeason: 2026 } });
  t.equal(none.status, "refused"); t.equal(none.refusal.code, "tag_cutoff_unreliable"); t.equal(none.coverage.gaps[0].why, "NO_RECORD"); t.equal(none.facts.length, 0);
  t.ok(env.__selfCalls.some((u) => /league-events/.test(u)), "the calendar route was consulted as the fallback");
  const stale = await quote("16614", {}, { knowledge: { leagueId: "74598", currentSeason: 2026, calendar: { faAuctionStart: "2025-07-22" } } });
  t.equal(stale.status, "refused"); t.equal(stale.refusal.code, "tag_cutoff_unreliable");
  const bad = await quote("16614", {}, { knowledge: { leagueId: "74598", currentSeason: 2026, calendar: { faAuctionStart: "soon" } } });
  t.equal(bad.status, "refused");
});

test("G2: a confirmed auction-start row in the league calendar is accepted as the fallback source", async () => {
  setNow("2026-05-20T16:00:00Z"); TAG();
  env.UPS_MFL_DB.raw.exec("UPDATE league_events SET date='2026-07-22', description='FA Auction opens (confirmed by the commissioner)' WHERE event='ups_fa_auction_start' AND nfl_season='2026'");
  const e = await quote("16614", {}, { knowledge: { leagueId: "74598", currentSeason: 2026 } });
  t.equal(e.status, "ok"); t.equal(fact(e, "penalty"), 0); t.match(e.data.guards.g2.auction_start_source, /league-events/);
  env.UPS_MFL_DB.raw.exec("UPDATE league_events SET date='2026-07-25', description='Last weekend of July (~10-day window — placeholder until 2026 date confirmed)' WHERE event='ups_fa_auction_start' AND nfl_season='2026'");
});

test("a non-tag cut is not affected by G2 (the same date that refuses a tag is quoted for a veteran)", async () => {
  setNow("2026-07-25T16:00:00Z");
  setRoster(P("16614", 30000, 2, FLAT90));
  const e = await quote("16614");
  t.equal(e.status, "ok"); t.equal(fact(e, "penalty"), 37500); t.equal(e.data.guards.g2.applies, false);
});

// ── 6. cap.adjustments ─────────────────────────────────────────────────────────────────────────
const FX = JSON.parse(fs.readFileSync(path.join(ROOT, "tests/fixtures/salary_adjustments_2026_10_06.json"), "utf8"));
const REPORT = fs.readFileSync(path.join(ROOT, "site/reports/salary_adjustments/salary_adjustments_2026.json"), "utf8");
const FX_ROWS = FX.salaryAdjustments.salaryAdjustments.salaryAdjustment;
async function withLedgerWorld(fn) {
  const saved = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const u = new URL(typeof input === "string" ? input : input.url);
    if (u.host === "keithcreelman.github.io" && u.pathname.endsWith("/reports/salary_adjustments/salary_adjustments_2026.json")) return new Response(REPORT, { status: 200 });
    if (u.pathname.endsWith("/export")) {
      const type = u.searchParams.get("TYPE");
      if (type === "salaryAdjustments") return jsonRes(FX.salaryAdjustments);
      if (type === "league") return jsonRes({ league: { franchises: { franchise: FX.franchises } } });
      if (type === "transactions" && u.searchParams.get("TRANS_TYPE") === "TRADE") return jsonRes(FX.trades);
      if (type === "players") { const ids = String(u.searchParams.get("P") || "").split(","); return jsonRes({ players: { player: FX.players.filter((p) => ids.includes(p.id)) } }); }
    }
    return jsonRes({ error: "test: no such call" }, 503);
  };
  const db = makeD1({});
  const cols = Object.keys(FX.drop_events[0]);
  db.raw.exec(`CREATE TABLE ups_drop_events (${cols.map((c) => c + (/(_unix|_salary|_year|_length|_tcv|_aav|earned|guaranteed|penalty_amount|exempt|posted)/.test(c) ? " INTEGER" : " TEXT")).join(", ")})`);
  const ins = db.raw.prepare(`INSERT INTO ups_drop_events (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const r of FX.drop_events) ins.run(...cols.map((c) => r[c]));
  db.raw.exec("CREATE TABLE ups_faa_nom_penalties (penalty_id TEXT, season INTEGER, league_id TEXT, fid TEXT, et_day TEXT, offense_no INTEGER, amount_k INTEGER, applies_to_season INTEGER, posted_to_mfl INTEGER, voided INTEGER)");
  const wenv = { UPS_MFL_DB: db, MFL_COOKIE: "COMMISH", MFL_APIKEY: "k", FA_AUCTION_START_AT: String(FX.auction_start_unix) };
  wenv.SELF = { fetch: (u, i) => worker.fetch(new Request(String(u), i), wenv, { waitUntil() {}, passThroughOnException() {} }) };
  try { return await fn((u, i) => wenv.SELF.fetch(u, i)); } finally { globalThis.fetch = saved; }
}

test("cap.adjustments 2026 (complete): league and franchise totals equal MFL's posted rows; sign convention in every label", async () => {
  setNow("2026-11-19T16:00:00Z");
  await withLedgerWorld(async (fs2) => {
    const all = await call(T.adjust, {}, { fetchSelf: fs2 });
    t.equal(all.status, "ok"); t.equal(all.data.completeness, "complete");
    const expectAll = FX_ROWS.reduce((a, r) => a + Math.round(Number(r.amount)), 0);
    t.equal(fact(all, "season_total"), expectAll); t.equal(fact(all, "row_count"), FX_ROWS.length);
    t.equal(fact(all, "trade_total") + fact(all, "drop_total") + fact(all, "misc_total"), expectAll, "the three types add up to the posted total");
    t.equal(fact(all, "season"), 2026);
    t.ok(all.facts.filter((f) => f.unit === "usd").every((f) => /positive = a charge/.test(f.label)), "every dollar fact states the sign convention");
    t.equal(all.coverage.gaps.length, 0, "a complete season carries no completeness gap");
    t.ok(factOf(all, "next_season_total"), "next season's booked rows are surfaced for the current season");
    const one = await call(T.adjust, { franchise_id: "1" }, { fetchSelf: fs2 });
    const expect1 = FX_ROWS.filter((r) => String(r.franchise_id) === "0001").reduce((a, r) => a + Math.round(Number(r.amount)), 0);
    t.equal(fact(one, "season_total"), expect1); t.equal(one.data.franchise_id, "0001");
    t.ok(one.data.rows.every((r) => r.franchise_id === "0001"));
    const s = dump(all);
    for (const bad of ["unsettled_traded_salary", "partially_settled", "review\":", "pending_fid"]) t.ok(!s.includes(bad), `the commissioner review block ('${bad}') is not exposed`);
    t.equal(all.provenance.review_block, "not exposed");
  });
});

test("cap.adjustments 2017-2025 is partial with the review_required caveat; 2016 and earlier and a past date in the current season are unsupported_as_of", async () => {
  await withLedgerWorld(async (fs2) => {
    const y = await call(T.adjust, {}, { fetchSelf: fs2, as_of: "2024-12-31" });
    t.equal(y.status, "ok"); t.equal(y.data.completeness, "partial"); t.equal(y.data.season, 2024);
    t.ok(y.coverage.gaps.some((g) => g.why === "partial_coverage" && /review_required/.test(g.what) && /2020/.test(g.what)));
    t.ok(y.coverage.gaps.some((g) => /as recorded now, not the ledger as it stood/.test(g.what)), "a dated question about a past season is answered as the season ledger and says so");
    t.equal(factOf(y, "season_total").grade, "C", "a total is derived by code, not an MFL record");
    t.equal(factOf(y, "next_season_total"), undefined, "no next-season facts for a past season");
    const old = await call(T.adjust, {}, { fetchSelf: fs2, as_of: "2016-06-01" });
    t.equal(old.status, "unsupported_as_of"); t.equal(old.facts.length, 0); t.equal(old.data, null);
    const inSeason = await call(T.adjust, {}, { fetchSelf: fs2, as_of: "2026-03-01" });
    t.equal(inSeason.status, "unsupported_as_of"); t.equal(inSeason.facts.length, 0);
    t.equal(inSeason.coverage.gaps[0].why, "unsupported_as_of");
  });
});

// ── 7. extension.price: canon C4 worked examples ───────────────────────────────────────────────
const price = (args, o) => call(T.ext, args, o);
const WHAT = (position, yrsLeft, salary, info, years, extra) => ({ years, position, years_remaining: yrsLeft, salary, contract_info: info, ...(extra || {}) });

test("extension golden: WR $17K AAV, 1 year left, Ext1 -> future $27K, TCV $44K, GTD $33K; version in provenance", async () => {
  const e = await price(WHAT("WR", 1, 17000, "CL 1| TCV 17K| AAV 17K| Y1-17K", 1));
  t.equal(e.status, "ok");
  t.equal(fact(e, "aav_future"), 27000); t.equal(fact(e, "tcv"), 44000); t.equal(fact(e, "gtd"), 33000); t.equal(fact(e, "aav_current"), 17000); t.equal(fact(e, "salary_year1"), 17000);
  t.equal(fact(e, "contract_length"), 2); t.equal(e.data.schedule, 1);
  t.equal(e.provenance.pricing_version, PRICING_VERSION); t.equal(fact(e, "pricing_version"), PRICING_VERSION);
  t.equal(e.coverage.gaps.length, 0); t.equal(factOf(e, "tcv").grade, "C"); t.match(factOf(e, "tcv").label, /what-if/);
  t.equal(env.__selfCalls.length, 0, "a pure what-if reads no route");
});

test("extension golden: $30K AAV, Ext2, Schedule 1 -> $50K / $50K, TCV $130K", async () => {
  const e = await price(WHAT("WR", 1, 30000, "CL 1| TCV 30K| AAV 30K| Y1-30K", 2));
  t.equal(e.status, "ok"); t.equal(fact(e, "aav_future"), 50000); t.equal(fact(e, "tcv"), 130000); t.equal(e.data.salary_by_year["2"], 50000); t.equal(e.data.salary_by_year["3"], 50000);
  t.equal(fact(e, "escalator"), 20000); t.equal(fact(e, "contract_length"), 3);
});

test("extension golden: LB $5K AAV Ext2 -> future $10K, TCV $25K (Schedule 2)", async () => {
  const e = await price(WHAT("LB", 1, 5000, "CL 1| TCV 5K| AAV 5K| Y1-5K", 2));
  t.equal(e.status, "ok"); t.equal(fact(e, "aav_future"), 10000); t.equal(fact(e, "tcv"), 25000); t.equal(e.data.schedule, 2); t.equal(fact(e, "escalator"), 5000);
});

test("extension golden: PK maps to Schedule 2 (+$3K for one year)", async () => {
  const e = await price(WHAT("PK", 1, 5000, "CL 1| TCV 5K| AAV 5K| Y1-5K", 1));
  t.equal(e.status, "ok"); t.equal(e.data.schedule, 2); t.equal(e.data.position_group, "PK"); t.equal(fact(e, "aav_future"), 8000); t.equal(fact(e, "tcv"), 13000);
});

test("extension: an unknown position, an expired contract, more than a year left and a loaded extension are refused with the module's reason, never a number", async () => {
  const cases = [
    [WHAT("ZZ", 1, 17000, "CL 1| TCV 17K| AAV 17K", 1), "incomplete_contract_data", "pricing_position_unavailable"],
    [WHAT("WR", 0, 17000, "CL 1| TCV 17K| AAV 17K", 1), "unverified_calculation", "expired_contract_not_priced"],
    [WHAT("WR", 2, 17000, "CL 2| TCV 34K| AAV 17K", 1), "unverified_calculation", "not_final_year"],
    [WHAT("WR", 1, 17000, "CL 1| TCV 17K| AAV 17K", 2, { loaded: "FL" }), "unverified_calculation", "loaded_extension_unsupported"],
    [WHAT("WR", 1, 17000, "CL 2| TCV 34K", 1), "incomplete_contract_data", "aav_derived_from_tcv_over_cl"],
  ];
  for (const [args, code, why] of cases) {
    const e = await price(args);
    t.equal(e.status, "refused", why); t.equal(e.refusal.code, code, why); t.equal(e.facts.length, 0); t.equal(e.data, null); t.equal(e.provenance.module_reason, why);
    const s = dump(e);
    for (const n of ["27000", "44000", "34000", "13000"]) t.ok(!s.includes(n), `no price '${n}' in a refusal (${why})`);
  }
});

test("extension: a fractional AAV token (16.5K) is priced WITH a caveat that canon states no rounding rule", async () => {
  const e = await price(WHAT("WR", 1, 17000, "CL 1| TCV 17K| AAV 16.5K| Y1-17K", 1));
  t.equal(e.status, "ok"); t.equal(fact(e, "aav_current"), 17000, "the module rounds halves up to the nearest $1K");
  t.equal(e.coverage.gaps.length, 1); t.equal(e.coverage.gaps[0].why, "unverified_calculation"); t.match(e.coverage.gaps[0].what, /no rounding rule/);
});

test("extension: a rostered player is priced from his current contract through the workbench (NO_CACHE=1, no EXT_URL)", async () => {
  setNow("2026-03-15T16:00:00Z");
  setRoster(P("16614", 17000, 1, "CL 1| TCV 17K| AAV 17K| Y1-17K"));
  const e = await price({ years: 1, player_id: "16614" });
  t.equal(e.status, "ok"); t.equal(fact(e, "tcv"), 44000); t.equal(e.data.mode, "player"); t.equal(e.data.position_group, "WR");
  const u = new URL(env.__selfCalls[0]);
  t.equal(u.pathname, "/roster-workbench"); t.equal(u.searchParams.get("NO_CACHE"), "1"); t.ok(!env.__selfCalls.some((x) => /EXT_URL/.test(x)));
  t.ok(!/what-if/.test(factOf(e, "tcv").label));
  const none = await price({ years: 1, player_id: "99999" });
  t.equal(none.status, "no_record");
  const both = await price({ years: 1, player_id: "16614", position: "WR" });
  t.equal(both.status, "refused");
  const neither = await price({ years: 1 });
  t.equal(neither.status, "refused"); t.equal(neither.refusal.code, "incomplete_contract_data");
  mfl.st.positions = { "16614": "ZZ" };
  const unk = await price({ years: 1, player_id: "16614" });
  t.equal(unk.status, "refused"); t.equal(unk.provenance.module_reason, "pricing_position_unavailable");
  mfl.st.positions = undefined;
});

// ── 8. calendar.events ─────────────────────────────────────────────────────────────────────────
test("calendar.events 2026: MFL's values are grade-A facts; canon's two contradictions are conflict_in_canon gaps naming both readings and the file lines", async () => {
  setNow("2026-10-21T16:00:00Z");
  const e = await call(T.cal, {});
  t.equal(e.status, "ok");
  t.equal(fact(e, "week1_kickoff_et"), "2026-09-09", "MFL's nflSchedule: Week 1 opens Wed Sept 9 (8:20 PM ET)"); t.equal(factOf(e, "week1_kickoff_et").grade, "A");
  t.equal(fact(e, "trade_lock_et"), "2026-11-24"); t.equal(factOf(e, "trade_lock_et").grade, "A"); t.equal(fact(e, "trade_lock_label"), "Tue, Nov 24, 12:00 PM ET");
  t.equal(fact(e, "trade_deadline_stored"), "2026-11-26", "the commissioner's typed row (Thanksgiving Thursday) is shown, as grade B, not chosen"); t.equal(factOf(e, "trade_deadline_stored").grade, "B");
  t.equal(fact(e, "ev_nfl_kickoff"), "2026-09-10", "the stored row says Sept 10: a third reading, shown, not chosen"); t.equal(factOf(e, "ev_nfl_kickoff").grade, "B");
  const conflicts = e.coverage.gaps.filter((g) => g.why === "conflict_in_canon");
  t.equal(conflicts.length, 2);
  const td = conflicts.find((g) => /trade deadline/.test(g.what)), wk = conflicts.find((g) => /Week 1/.test(g.what));
  t.ok(td && wk);
  t.match(td.what, /league_context_v1\.md lines 265/); t.match(td.what, /Thanksgiving-week kickoff, Thanksgiving Thursday, and MFL's enforced calendar time/);
  t.match(wk.what, /Wed Sept 9 and Thu Sept 10/); t.match(wk.what, /lines 1281/);
  t.equal(e.data.conflicts.length, 2);
  const w1 = e.data.conflicts.find((c) => c.topic === "week1_2026");
  t.equal(w1.mfl_value, "2026-09-09"); t.equal(w1.stored_value, "2026-09-10"); t.equal(w1.canon_readings.length, 2);
  t.ok(w1.canon_readings.every((c) => c.file === "docs/league_context_v1.md" && c.reading.length < 90), "cited by file and line with short paraphrases, no long quotes");
  const urls = env.__selfCalls.map((u) => new URL(u));
  t.equal(urls.length, 1); t.equal(urls[0].pathname, "/api/league-events"); t.equal(urls[0].searchParams.get("season"), "2026"); t.equal(urls[0].searchParams.get("L"), "74598");
});

test("calendar.events: another season carries the trade-deadline wording conflict only; before 2011 is unsupported_as_of", async () => {
  const e = await call(T.cal, {}, { as_of: "2024-06-01" });
  t.equal(e.status, "ok"); t.equal(e.data.season, 2024);
  t.equal(e.coverage.gaps.filter((g) => g.why === "conflict_in_canon").length, 1);
  t.ok(!e.coverage.gaps.some((g) => /Week 1/.test(g.what)), "the Sept 9 / Sept 10 conflict is a 2026 question");
  const old = await call(T.cal, {}, { as_of: "2010-06-01" });
  t.equal(old.status, "unsupported_as_of"); t.equal(old.facts.length, 0);
});

// ── 9. every current-only tool refuses a past as_of; none answers for today ────────────────────
test("a past as_of is unsupported_as_of for every tool that prices or reads CURRENT state, with no facts and no data", async () => {
  const calls = [
    [T.roster, { franchise_id: "0008" }], [T.position, { franchise_id: "0008" }], [T.quote, { player_id: "16614" }],
    [T.ext, WHAT("WR", 1, 17000, "CL 1| TCV 17K| AAV 17K", 1)],
  ];
  for (const [tool, args] of calls) {
    const e = await call(tool, args, { as_of: "2025-06-01" });
    t.equal(e.status, "unsupported_as_of", tool.id); t.equal(e.facts.length, 0, tool.id); t.equal(e.data, null, tool.id);
    t.equal(e.coverage.gaps[0].why, "unsupported_as_of", tool.id); t.equal(env.__selfCalls.length, 0, `${tool.id} made no route call`);
  }
  const adj = await call(T.adjust, {}, { as_of: "2026-03-01" });
  t.equal(adj.status, "unsupported_as_of"); t.equal(adj.facts.length, 0);
  const missing = await call(T.roster, { franchise_id: "0008" }, { raw: {} });
  t.equal(missing.status, "error"); t.equal(missing.error.code, "bad_arguments");
});

await run("ai_desk_tools_cap");
