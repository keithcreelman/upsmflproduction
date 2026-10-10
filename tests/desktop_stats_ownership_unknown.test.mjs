// Desktop Stats Workbench (site/stats_workbench/stats_workbench.html): the "MFL Team" column, the Free Agents /
// Rostered / per-team filter, the player + compare drawers and the whole-league search take ownership from ONE live
// read, GET /api/mfl-league-state. Before 2026-10-09 a FAILED, EMPTY or PARTIAL read left pidToFid empty or short and
// applyLiveOwnership called every player it couldn't find "FA" with $0 salary / AAV / 0 years: one bad read made the
// whole league look like free agents, and the FA filter listed rostered players (fail-open).
//
// The rule now (same as mobile's #1203, site/m/views/stats.js liveOwners/ownerOf):
//   - a player found on a roster shows that franchise (positive evidence);
//   - a player on NO roster is FA only when the read is CONFIRMED COMPLETE: readable, the league's franchise list is
//     non-empty, and it agrees with the roster map (every listed franchise has players; no roster outside the list);
//   - otherwise he is "owner unknown" (salary / AAV / years null, never 0), every Team filter lists nobody rather than
//     a partial list, and a note says why;
//   - the next query re-reads (a retry after a failed / partial read, or a complete read older than 60s), so a recovery
//     restores FA and a trade or claim shows the new owner without a page reload.
//
// Runs the REAL page code in node:vm — the ownership block, runQuery, getSelectedTeams, emptySearchHtml, the
// whole-league search and the "MFL Team" column's compute, sliced out of the HTML — with a stubbed fetch. The
// /api/mfl-league-state responses come from the REAL worker route (worker/src/index.js) fed stubbed MFL exports built
// from the live 2026-10-09 reads in tests/fixtures/mobile_stats_ownership_2026_10_09.json (the full rosters export).
//   node tests/desktop_stats_ownership_unknown.test.mjs
//   STATS_WORKBENCH_HTML=/path/to/other/stats_workbench.html node tests/desktop_stats_ownership_unknown.test.mjs
//     (run the same checks against another copy, e.g. origin/main's, to see the before)
import fs from "node:fs";
import vm from "node:vm";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HTML_PATH = process.env.STATS_WORKBENCH_HTML || new URL("../site/stats_workbench/stats_workbench.html", import.meta.url);
const SRC = fs.readFileSync(HTML_PATH, "utf8");
const WORKER = fs.readFileSync(new URL("../worker/src/index.js", import.meta.url), "utf8");
const FX = JSON.parse(fs.readFileSync(new URL("./fixtures/mobile_stats_ownership_2026_10_09.json", import.meta.url), "utf8"));
const clone = (x) => JSON.parse(JSON.stringify(x));
const QUIET = { log() {}, warn() {}, error() {} };   // the page + route log their failures; the cases below cause them on purpose

// ── slicing the real code ────────────────────────────────────────────────────
function blockFrom(src, openIdx) {            // `{` at/after openIdx → its matching `}` (inclusive)
  let i = src.indexOf("{", openIdx), depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}" && --depth === 0) return src.slice(src.indexOf("{", openIdx), i + 1);
  }
  throw new Error("unbalanced block at " + openIdx);
}
function fnSrc(src, name) {
  const at = src.indexOf("function " + name + "(");
  if (at < 0) throw new Error("no function " + name);
  return src.slice(at, at + ("function " + name).length) + src.slice(at + ("function " + name).length, src.indexOf("{", at)) + blockFrom(src, at);
}
const REGION_START = SRC.indexOf("// ---------- Live MFL ownership + contract overlay ----------");
const REGION_END = SRC.indexOf("var gsearch = { indexPromise");
const REGION = SRC.slice(REGION_START, REGION_END);
const GSEARCH = SRC.slice(REGION_END, SRC.indexOf("function gsearchListEl()"));
const COMPUTE = (/mfl_franchise_name:\s*\{\s*label:"MFL Team"[\s\S]*?compute:\s*(function\s*\(r\)\s*\{[^\n]*?\})\s*\}/.exec(SRC) || [])[1];
const PAGE_FNS = ["getSelectedTeams", "computePosRanks", "runQuery", "escapeHtml", "emptySearchHtml",
  "gsearchNormSpaced", "gsearchNormTight", "gsearchQueryTokens"].map((n) => fnSrc(SRC, n)).join("\n");

// The REAL worker route, run against stubbed MFL exports.
const ROUTE_AT = WORKER.indexOf('if (path === "/api/mfl-league-state" && request.method === "GET") {');
const ROUTE = blockFrom(WORKER, ROUTE_AT);
const PCD_AT = WORKER.indexOf("const _parseContractData = (");
const PCD = WORKER.slice(PCD_AT, WORKER.indexOf("=>", PCD_AT) + 2) + " " + blockFrom(WORKER, WORKER.indexOf("=>", PCD_AT)) + ";";
const S_LINE = (/const _s = \(v\) => [^\n]*\n/.exec(WORKER) || [""])[0];
const makeRoute = new Function("mflFetch", "console", `
  ${S_LINE}
  ${PCD}
  const jsonOut = (status, payload) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  return async function leagueStateRoute() {
    const url = new URL("https://w.test/api/mfl-league-state?L=74598&YEAR=2026");
    const path = url.pathname, request = { method: "GET" }, fetch = mflFetch;
    ${ROUTE}
    return null;
  };`);

// ── MFL exports (from the live 10-09 reads) → the worker route → the page ──
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const NAME = Object.fromEntries(FX.mfl_franchises.map((f) => [f.id, f.name]));
const mflLeague = (franchises = FX.mfl_franchises) => ({ league: { franchises: { franchise: franchises.map((f) => ({ id: f.id, name: f.name })) } } });
function mflRosters(edit) {                    // the complete live rosters export, + Love's contract fields
  const r = clone(FX.mfl_rosters);
  const love = r.rosters.franchise.find((f) => f.id === "0011").player.find((p) => p.id === "17472");
  Object.assign(love, { salary: "5000", contractYear: "3", contractInfo: "CL 3| TCV 15K| AAV 5K", contractStatus: "Rookie" });
  if (edit) edit(r.rosters);
  return r;
}
// one /api/mfl-league-state answer, produced by the real route. `league` / `rosters` are MFL bodies, or a function
// returning a Response (an MFL outage page), or "throw" (network error reaching MFL).
function viaRoute({ league = mflLeague(), rosters = mflRosters() } = {}) {
  const answer = (v) => (v === "throw" ? Promise.reject(new TypeError("fetch failed"))
    : typeof v === "function" ? Promise.resolve(v()) : Promise.resolve(json(200, v)));
  const route = makeRoute((u) => answer(String(u).includes("TYPE=league") ? league : rosters), QUIET);
  return () => route();
}
const literal = (status, body) => () => Promise.resolve(json(status, body));
const networkError = () => () => Promise.reject(new TypeError("Failed to fetch"));
const mflDown = () => new Response("<html>MyFantasyLeague is down for maintenance</html>", { status: 503 });

// leaderboard rows as the worker sends them, with D1 (src_contracts) contract fields — a stale snapshot
const LB = FX.leaderboard_skill.map((r) => ({ ...r, mfl_salary: 3000, mfl_aav: 3000, mfl_years_remaining: 2 }));
const ROSTERED = { 17472: "0011", 12626: "0010", 16601: "0008", 16171: "0003", 15711: "0005", 17500: "0010" };
const FREE = ["16387", "15787", "11679"];
const ALL = Object.keys(ROSTERED).concat(FREE).sort();

// ── boot the page code ───────────────────────────────────────────────────────
function boot(firstRead) {
  const clock = { now: Date.parse("2026-10-09T20:00:00Z") };
  const reads = [firstRead];
  const calls = { leagueState: 0 };
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, innerHTML: "", textContent: "", value: "" });
  const teamSel = { id: "asw-team", appendChild(o) { this.options.push(o); }, options: [
    { value: "__ALL__", textContent: "All (league-wide)", selected: true },
    { value: "__ROSTERED__", textContent: "All (Rostered)", selected: false },
    { value: "FA", textContent: "Free Agents", selected: false }] };
  const fetch = async (url) => {
    const u = new URL(url);
    if (u.pathname === "/api/mfl-league-state") {
      const answer = reads[Math.min(calls.leagueState, reads.length - 1)];   // read N gets answer N; the last repeats
      calls.leagueState++;
      return answer();
    }
    if (u.pathname === "/api/advanced-stats-leaderboard") return json(200, { rows: clone(LB), count: LB.length });
    if (u.pathname === "/api/mfl-export") return json(200, { players: { player: FX.mfl_players } });
    return new Response("not stubbed", { status: 404 });
  };
  class FakeDate extends Date { static now() { return clock.now; } }
  const ctx = {
    API_BASE: "https://w.test", LEAGUE_ID: "74598", THIS_YEAR: 2026,
    document: { createElement: () => ({}), getElementById: el },
    teamSel, bodyEl: el("asw-body"), metaEl: el("asw-meta"),
    state: { activeTab: "rb", rowsByWorkerPos: {}, sortKey: null },
    TABS: { rb: { label: "RB", workerPos: "skill" } },
    getSelectedSeasons: () => [2026], getScope: () => "mfl_total",
    getScopeQueryParams: () => "&week_min=1&week_max=17", getScopeLabel: () => "MFL Total",
    render() { if (typeof ctx.renderOwnershipNote === "function") ctx.renderOwnershipNote(); },
    fetch, Date: FakeDate, URL, setTimeout, clearTimeout,
    console: QUIET,
  };
  vm.createContext(ctx);
  vm.runInContext(REGION + "\n" + GSEARCH + "\n" + PAGE_FNS + "\nvar __mflTeamCompute = " + COMPUTE + ";", ctx);
  const v = {
    ctx, els, calls, clock,
    then(read) { reads.push(read); return v; },     // queue the NEXT read's answer
    pick(...values) {                               // the Team select; none = All
      // a franchise option this boot never read (its league list failed) stands for one left from an earlier read
      values.forEach((val) => { if (!teamSel.options.some((o) => o.value === val)) teamSel.options.push({ value: val, textContent: val }); });
      teamSel.options.forEach((o) => { o.selected = values.length ? values.includes(o.value) : o.value === "__ALL__"; });
      return v;
    },
    async query() { ctx.runQuery(); await settle(); return ctx.state.rowsByWorkerPos.skill || []; },
    note: () => (els["asw-ownership-slot"] || { innerHTML: "" }).innerHTML,
  };
  return v;
}
const settle = async () => { for (let i = 0; i < 25; i++) await new Promise((r) => setTimeout(r, 0)); };
const byPid = (rows) => Object.fromEntries(rows.map((r) => [String(r.mfl_pid), r]));
const pids = (rows) => Array.from(rows, (r) => String(r.mfl_pid)).sort();   // Array.from: a plain array of THIS realm (vm arrays fail deepStrictEqual)
const labels = (v, rows) => Object.fromEntries(rows.map((r) => [String(r.mfl_pid), v.ctx.__mflTeamCompute(r)]));
const NOTE = /Couldn.t read all of MFL.s rosters/;

// The "can't tell" contract, shared by every failed / empty / partial case: nobody reads FA, nobody gets a guessed
// $0 / 0 years, every Team filter lists nobody, and the page says why.
async function expectOwnershipUnknown(v, { found = {} } = {}) {
  v.pick();
  const rows = await v.query();
  t.deepEqual(pids(rows), ALL, "All: every row still listed");
  const lab = labels(v, rows), r = byPid(rows);
  for (const pid of ALL) {
    if (found[pid]) { t.equal(lab[pid], found[pid], pid + ": on a roster the read returned → that owner"); continue; }
    t.equal(lab[pid], "owner unknown", pid + ": not on a returned roster, read not complete → owner unknown, never FA");
    t.deepEqual([r[pid].mfl_salary, r[pid].mfl_aav, r[pid].mfl_years_remaining], [null, null, null],
      pid + ": salary / AAV / years unknown — not $0 / 0 years, not the D1 snapshot's 3000 / 2");
  }
  t.ok(!Object.values(lab).includes("FA"), "no row reads FA");
  t.match(v.note(), NOTE, "the note is visible above the table");
  for (const filter of [["FA"], ["__ROSTERED__"], ["0010"], ["FA", "0011"]]) {
    v.pick(...filter);
    t.deepEqual(pids(await v.query()), [], filter.join("+") + ": no rows rather than a partial (or rostered-as-FA) list");
    t.match(v.note(), NOTE, filter.join("+") + ": note");
    t.match(v.ctx.emptySearchHtml(v.ctx.TABS.rb, ""), NOTE, filter.join("+") + ": the empty table says why, not 'No rows match filters.'");
  }
  v.pick();
}

// ─────────────────────────────────────────────────────────────────────────────
test("anchors: the real page + worker code was sliced (else everything below is vacuous)", () => {
  t.ok(REGION_START > 0 && REGION_END > REGION_START && REGION.length > 3000, "ownership block");
  t.ok(GSEARCH.length > 1000, "whole-league search block");
  t.ok(/^function\s*\(r\)/.test(COMPUTE || ""), "the MFL Team column's compute");
  t.ok(ROUTE.includes("TYPE=rosters") && ROUTE.includes("pid_to_fid"), "the worker route");
  t.ok(PCD.includes("yearsRemaining"), "the worker's _parseContractData");
});

test("(f) COMPLETE read (live 10-09 rosters via the real route): rostered → franchise, real free agents → FA", async () => {
  const v = boot(viaRoute());
  const rows = await v.query();
  const lab = labels(v, rows), r = byPid(rows);
  for (const [pid, fid] of Object.entries(ROSTERED)) t.equal(lab[pid], NAME[fid], pid + " → " + NAME[fid]);
  t.equal(lab["12626"], "Blake Bombers", "Henry: live owner, not the D1 snapshot's The Long Haulers");
  for (const pid of FREE) {
    t.equal(lab[pid], "FA", pid + " is a confirmed free agent");
    t.deepEqual([r[pid].mfl_salary, r[pid].mfl_aav, r[pid].mfl_years_remaining], [0, 0, 0], pid + ": FA contract zeroed");
  }
  t.deepEqual([r["17472"].mfl_salary, r["17472"].mfl_aav, r["17472"].mfl_years_remaining], [5000, 5000, 3], "Love: live contract");
  t.equal(v.note(), "", "no ownership note");
  t.deepEqual(pids(await v.pick("FA").query()), FREE.slice().sort(), "FA filter: only the real free agents");
  t.deepEqual(pids(await v.pick("__ROSTERED__").query()), Object.keys(ROSTERED).sort(), "Rostered filter");
  t.deepEqual(pids(await v.pick("0010").query()), ["12626", "17500"], "one franchise");
  t.deepEqual(pids(await v.pick("FA", "0011").query()), FREE.concat("17472").sort(), "FA + a franchise");
  t.equal(v.ctx.emptySearchHtml(v.ctx.TABS.rb, ""), "No rows match filters.", "ordinary empty-state text unchanged");
  t.equal(v.ctx.teamSel.options.length, 3 + 12, "12 franchise options");
});

test("(a) league-state read FAILS — worker HTTP 500: nobody is FA, filters don't claim completeness", async () => {
  await expectOwnershipUnknown(boot(viaRoute({ rosters: "throw" })));          // the route's own catch → 500
  await expectOwnershipUnknown(boot(literal(500, { error: "boom" })));
});

test("(a) league-state read FAILS — network error reaching the worker", async () => {
  await expectOwnershipUnknown(boot(networkError()));
});

test("(a) MFL's rosters export down behind a 200 (route sends 12 franchises + an EMPTY pid_to_fid)", async () => {
  const answer = await viaRoute({ rosters: mflDown })().then((r) => r.json());
  t.deepEqual([answer.franchises.length, Object.keys(answer.pid_to_fid).length, answer.rostered_count], [12, 0, 0],
    "the real route answers this as a normal 200 — only the client can tell it's incomplete");
  await expectOwnershipUnknown(boot(viaRoute({ rosters: mflDown })));
});

test("(b) EMPTY response: {franchises:[], pid_to_fid:{}} — and both MFL exports empty through the route", async () => {
  await expectOwnershipUnknown(boot(literal(200, { franchises: [], pid_to_fid: {} })));
  await expectOwnershipUnknown(boot(viaRoute({ league: {}, rosters: { rosters: {} } })));
});

test("(c) PARTIAL: Cleon Ca$h (0011) missing from pid_to_fid → Love is owner unknown; players found keep their owner", async () => {
  const v = boot(viaRoute({ rosters: mflRosters((r) => { r.franchise = r.franchise.filter((f) => f.id !== "0011"); }) }));
  const found = Object.fromEntries(Object.entries(ROSTERED).filter(([, f]) => f !== "0011").map(([p, f]) => [p, NAME[f]]));
  await expectOwnershipUnknown(v, { found });
});

test("(c) PARTIAL: a franchise listed with ZERO players → incomplete", async () => {
  const v = boot(viaRoute({ rosters: mflRosters((r) => { r.franchise.find((f) => f.id === "0011").player = []; }) }));
  const found = Object.fromEntries(Object.entries(ROSTERED).filter(([, f]) => f !== "0011").map(([p, f]) => [p, NAME[f]]));
  await expectOwnershipUnknown(v, { found });
});

test("(c) PARTIAL: a franchise missing from the league's `franchises` list (rosters fine) → incomplete", async () => {
  const v = boot(viaRoute({ league: mflLeague(FX.mfl_franchises.filter((f) => f.id !== "0003")) }));
  const found = Object.fromEntries(Object.entries(ROSTERED).map(([p, f]) => [p, f === "0003" ? "Rostered" : NAME[f]]));
  await expectOwnershipUnknown(v, { found });
});

test("(c) league list unavailable entirely: rostered players say 'Rostered' — never FA, never the D1 snapshot's owner", async () => {
  const v = boot(viaRoute({ league: mflDown }));
  const found = Object.fromEntries(Object.keys(ROSTERED).map((p) => [p, "Rostered"]));
  await expectOwnershipUnknown(v, { found });
});

test("(c) payload disagrees with its own tallies (rostered_count) → not trusted as complete", async () => {
  const body = await viaRoute()().then((r) => r.json());
  body.rostered_count += 1;
  const found = Object.fromEntries(Object.entries(ROSTERED).map(([p, f]) => [p, NAME[f]]));
  await expectOwnershipUnknown(boot(literal(200, body)), { found });
});

test("(d) RECOVERY: the first read fails, the next query re-reads and FA labels return", async () => {
  const v = boot(literal(500, { error: "boom" })).then(viaRoute());
  let rows = await v.query();
  t.equal(labels(v, rows)["16387"], "owner unknown");
  t.equal(v.calls.leagueState, 1);
  rows = await v.query();
  t.equal(v.calls.leagueState, 2, "the next query retried the read");
  t.equal(labels(v, rows)["16387"], "FA", "confirmed free agent again");
  t.equal(labels(v, rows)["17472"], "Cleon Ca$h");
  t.equal(v.note(), "", "note cleared");
  t.deepEqual(pids(await v.pick("FA").query()), FREE.slice().sort(), "FA filter works again");
  t.equal(v.ctx.teamSel.options.length, 3 + 12, "franchise options not duplicated by the re-read");
});

test("(d) a partial read is retried too — a network error, then partial, then complete", async () => {
  const partial = viaRoute({ rosters: mflRosters((r) => { r.franchise = r.franchise.filter((f) => f.id !== "0004"); }) });
  const v = boot(networkError()).then(partial).then(viaRoute());
  t.equal(labels(v, await v.query())["16387"], "owner unknown");
  t.equal(labels(v, await v.query())["16387"], "owner unknown", "partial: still unknown");
  t.equal(labels(v, await v.query())["16387"], "FA", "complete: FA");
  t.equal(v.calls.leagueState, 3);
});

test("(e) ROSTER CHANGE between reads: a trade and a claim show the new owner on the next query, no page reload", async () => {
  const moved = viaRoute({ rosters: mflRosters((r) => {
    const cleon = r.franchise.find((f) => f.id === "0011"), bombers = r.franchise.find((f) => f.id === "0010");
    bombers.player.push(cleon.player.find((p) => p.id === "17472"));
    cleon.player = cleon.player.filter((p) => p.id !== "17472");                       // trade: Love → Blake Bombers
    r.franchise.find((f) => f.id === "0004").player.push({ id: "16387", status: "ROSTER" });   // claim: Brooks → Pure Greatness
  }) });
  const v = boot(viaRoute()).then(moved);
  let lab = labels(v, await v.query());
  t.deepEqual([lab["17472"], lab["16387"]], ["Cleon Ca$h", "FA"]);
  v.clock.now += 30 * 1000;
  await v.query();
  t.equal(v.calls.leagueState, 1, "a complete read under 60s old is reused (the worker edge-caches MFL rosters for 60s)");
  v.clock.now += 31 * 1000;
  lab = labels(v, await v.query());
  t.equal(v.calls.leagueState, 2, "older than 60s → re-read on the next query");
  t.deepEqual([lab["17472"], lab["16387"]], ["Blake Bombers", "Pure Greatness"]);
  t.ok(!pids(await v.pick("FA").query()).includes("16387"), "the claimed player left the FA filter");
});

test("(e) a FAILED re-read after a complete one → owner unknown (the latest read is the only evidence)", async () => {
  const v = boot(viaRoute()).then(literal(502, { error: "bad gateway" }));
  t.equal(labels(v, await v.query())["16387"], "FA");
  v.clock.now += 61 * 1000;
  const rows = await v.query();
  t.equal(labels(v, rows)["16387"], "owner unknown");
  t.equal(labels(v, rows)["17472"], "owner unknown", "not vouched for by the older roster");
  t.match(v.note(), NOTE);
});

test("whole-league search: an unconfirmed read never labels anyone 'Free Agent'; the label follows a later read", async () => {
  const v = boot(literal(500, { error: "boom" })).then(viaRoute());
  await v.ctx.gsearchBuildIndex(); await settle();
  const row = (pid) => v.ctx.gsearchRowHtml(v.ctx.gsearch.index.find((r) => r.pid === pid));
  t.ok(!/Free Agent/.test(row("16387")), "real FA not called 'Free Agent' on a failed read");
  t.ok(!/Free Agent/.test(row("17472")), "Love not called 'Free Agent' on a failed read");
  t.match(row("16387"), /Owner unknown/);
  await v.query();   // the next query re-reads — complete
  t.match(row("16387"), /Free Agent/);
  t.match(row("17472"), /Cleon Ca\$h/);
});

test("source: drawers / compare use the one label; runQuery + search + ADP re-read; ADP's filter is gated too", () => {
  t.ok(!/mfl_franchise_name \|\| "FA"/.test(SRC), "no bare `mfl_franchise_name || \"FA\"` left (player drawer, compare drawer, column)");
  t.equal((SRC.match(/mflTeamLabel\((p|playerRow)\)/g) || []).length, 2, "compare + player drawer");
  const rq = fnSrc(SRC, "runQuery");
  t.match(rq, /refreshLeagueState\(\)/, "runQuery re-reads (not the page-load promise)");
  t.match(rq, /filterRowsByTeams\(rows, teams\)/);
  t.match(fnSrc(SRC, "gsearchBuildIndex"), /refreshLeagueState\(\)/);
  t.match(SRC, /var adpOwnUnknown = !!\(adp\.team && adp\.team !== "__ALL__"\) && !ownership\.complete;/, "ADP Team filter gated");
  t.match(SRC, /rows = adpOwnUnknown \? \[\] :/);
  t.match(SRC, /adpOwnUnknown \? '<div class="asw-datanote">[^\n]*OWNERSHIP_UNKNOWN_MSG/, "ADP note");
  t.match(fnSrc(SRC, "adpLoad"), /refreshLeagueState\(\)/, "ADP board re-reads on load");
  t.match(SRC, /<div id="asw-ownership-slot"><\/div>/, "the note's slot exists in the page");
  t.match(fnSrc(SRC, "render"), /renderOwnershipNote\(\);/, "render() fills it");
});

await run("desktop_stats_ownership_unknown");
