// UPS 2027 Preview 0: Team roster + Player profile, read-only.
//   node tests/mobile2027_preview0.test.mjs
//
// Offline. The data is a trimmed recording of the public routes (tests/fixtures/mobile2027/public_reads.json); no test
// touches the network, MFL, D1 or Discord. What is proven here:
//   - read-only by construction: the only network code allows 4 GET paths, refuses everything else, and the source holds
//     no write verb, credential name or second transport;
//   - the contract numbers equal what the existing cap math and the worker say, and a missing fact is never drawn as $0;
//   - every piece of data text is escaped; no inline script or style; the page's content policy names only the worker;
//   - all skins meet the contrast targets; the build refuses extras and secrets; the deploy script can only name the preview.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const APP = path.join(ROOT, "apps", "mobile2027");
const SRC = path.join(APP, "src");
const require = createRequire(import.meta.url);
const F = require(path.join(SRC, "lib/format.js"));
const C = require(path.join(SRC, "lib/contract.js"));
const M = require(path.join(SRC, "lib/model.js"));
const D = require(path.join(SRC, "lib/data.js"));
const P = require(path.join(SRC, "lib/photo.js"));
const V = require(path.join(SRC, "lib/views.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const WORKER = "https://upsmflproduction.keith-creelman.workers.dev";
const CFG = { workerBase: WORKER, leagueId: "74598", season: "2026" };
const model = () => M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026);
const allPlayers = () => FX.roster_workbench.teams.flatMap((x) => x.players);
const penalty = (extra) => ({ state: "ok", data: FX.cap_penalty.players, meta: { calculatedAt: FX.cap_penalty.calculated_at, earnedThroughWeek: 10 }, ...(extra || {}) });
function state(over) {
  return {
    model: model(), load: { core: "ok", coreNotes: [] }, penalty: penalty(), teamId: "0010", tab: "team", sub: "roster", view: "lineup",
    open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [],
    requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}),
  };
}
const ALLOWED_ACTS = ["nav", "sub", "view", "grp", "expall", "card", "close", "teams", "pickteam", "about", "skin", "vib", "tog", "ptab", "retry", "retrypen"];
const findPlayer = (pred) => allPlayers().find(pred);

// ───────────────────────── 1. contract text and schedule ─────────────────────────
test("money tokens and the recorded contract text parse the way the Front Office reads them", () => {
  t.equal(C.moneyToken("13.5K"), 13500);
  t.equal(C.moneyToken("$1,000"), 1000);
  t.equal(C.moneyToken("2M"), 2000000);
  t.equal(C.moneyToken(""), null);
  t.equal(C.moneyToken("abc"), null);
  const r = C.parseSpecial("CL 3|TCV 18K|AAV 6K|Y1-6K, Y2-6K, Y3-6K, Y4-11K Option|GTD: 13.5K");
  t.equal(r.cl, 3); t.equal(r.tcv, 18000); t.equal(r.gtd, 13500);
  t.deepEqual(r.aav, [6000]); t.deepEqual(r.y, { 1: 6000, 2: 6000, 3: 6000 });
  t.deepEqual(r.option, { idx: 4, amount: 11000 });
  t.deepEqual(C.parseSpecial("CL 2|TCV 5K|AAV 1K, 4K|Y1-1K, Y2-4K|Ext: Bomb|GTD: 3.8K").aav, [1000, 4000]);
  t.deepEqual(C.parseSpecial("CL 3| TCV 90K| AAV 30K| Y1-50, Y2-20, Y3-20| GTD: 67.5K").y, { 1: 50000, 2: 20000, 3: 20000 }); // bare Y numbers are thousands
  t.equal(C.parseSpecial("").cl, null);
});

test("the year-by-year schedule: this season is the roster salary, later years come from the tokens, a gap is 'not recorded' (null), never 0", () => {
  const ext = C.schedule({ salary: 1000, years: 2, special: "CL 3| TCV 70K| AAV 30K| Y1-14K, Y2-1K, Y3-55K| GTD: 52.5K| Ext: C-Town" }, 2026);
  t.deepEqual(ext.rows, [{ year: 2026, amount: 1000 }, { year: 2027, amount: 55000 }]);
  t.equal(ext.yearsPlayed, 1); t.equal(ext.through, 2027); t.equal(ext.cl, 3);
  const rookie = C.schedule({ salary: 6000, years: 3, special: "CL 3|TCV 18K|AAV 6K|Y1-6K, Y2-6K, Y3-6K, Y4-11K Option|GTD: 13.5K" }, 2026);
  t.equal(rookie.rows.length, 3); t.equal(rookie.through, 2028);
  t.deepEqual(rookie.option, { year: 2029, amount: 11000 }); // shown separately, never one of the obligations
  const gap = C.schedule({ salary: 4000, years: 3, special: "CL 3|TCV 11K|AAV 4K|Y1-4K" }, 2026);
  t.deepEqual(gap.rows.map((r) => r.amount), [4000, null, null]);
  const none = C.schedule({ salary: 5000, years: 2, special: "" }, 2026);
  t.deepEqual(none.rows.map((r) => r.amount), [5000, null]);
  const blankSalary = C.schedule({ salary: "", years: 1, special: "CL 1|TCV 5K|AAV 5K" }, 2026);
  t.equal(blankSalary.rows[0].amount, null); // a blank salary is not $0
  t.deepEqual(C.schedule({ salary: 1000, years: 0, special: "CL 1|TCV 1K" }, 2026).rows, []);
  t.deepEqual(C.schedule({ salary: 9000, years: 1, special: "CL 1| TCV 8K| AAV 8K| Y1-8K" }, 2026).notes, ["current_year_token_differs"]);
});

test("contract parsing agrees with the shared cap math and with the worker for every recorded player", () => {
  const ctx = vm.createContext({});
  vm.runInContext(fs.readFileSync(path.join(ROOT, "site/shared/cap_math.js"), "utf8"), ctx);
  const CM = ctx.UPS_CAP_MATH;
  t.ok(CM && CM.parseContractInfo, "cap_math loaded");
  let n = 0;
  for (const p of allPlayers()) {
    n++;
    const mine = C.parseSpecial(p.special), theirs = CM.parseContractInfo(p.special);
    t.equal(mine.cl || 0, theirs.length, p.name + " length");
    t.equal(mine.tcv || 0, theirs.tcv, p.name + " tcv");
    t.equal(mine.gtd || 0, theirs.gtd, p.name + " gtd");
    Object.keys(mine.y).forEach((k) => t.equal(mine.y[k], theirs.yearVals[k], p.name + " Y" + k));
    const s = C.schedule(p, 2026);
    t.equal(s.rows.length, p.years, p.name + " rows = years left");
    t.equal(s.rows[0].amount, p.salary, p.name + " this season = salary");
    t.equal(s.notes.length, 0, p.name + " recorded year equals salary");
    t.ok(!s.rows.some((r) => r.amount == null), p.name + " every remaining year recorded");
    const w = FX.cap_penalty.players[p.id];
    if (w) { t.equal(w.years_remaining, p.years, p.name + " years vs worker"); t.equal(w.tcv, mine.tcv, p.name + " tcv vs worker"); t.equal(w.cl, mine.cl, p.name + " CL vs worker"); }
  }
  t.ok(n >= 100, "checked " + n + " players");
});

test("the worker's answer is shown as the worker states it; anything unconfirmed is 'unavailable', not $0", () => {
  const row = FX.cap_penalty.players[Object.keys(FX.cap_penalty.players).find((k) => !FX.cap_penalty.players[k].earned_rule && !FX.cap_penalty.players[k].exempt && FX.cap_penalty.players[k].guaranteed > FX.cap_penalty.players[k].earned)];
  const e = C.earned(row);
  t.equal(e.kind, "amount"); t.equal(e.amount, row.earned);
  t.equal(C.remainingGuarantee(row), row.guaranteed - row.earned);
  t.equal(C.cutNow(row).amount, row.penalty);
  t.equal(C.earned({ ...row, earned_rule: "full_year_sub_5k" }).label, "Full-year rule");
  t.equal(C.earned({ ...row, earned_rule: "ww_earned_na" }).label, "Not applicable");
  t.equal(C.remainingGuarantee({ ...row, earned_rule: "full_year_sub_5k" }), null);
  t.equal(C.earned({ ...row, earned_rule: "a_rule_from_the_future" }).kind, "unavailable");
  t.equal(C.earned({ ...row, needs_review: true, review_reason: "Check the acquisition week" }).kind, "unavailable");
  t.equal(C.cutNow({ ...row, needs_review: true, review_reason: "Check" }).kind, "unavailable");
  t.equal(C.earned(null).kind, "unavailable"); t.equal(C.cutNow(null).kind, "unavailable"); t.equal(C.remainingGuarantee(null), null);
  t.equal(C.earned({ ...row, earned: undefined }).kind, "unavailable");
  t.equal(C.cutNow({ ...row, penalty: undefined }).kind, "unavailable");
  t.equal(C.remainingGuarantee({ ...row, earned: row.guaranteed + 5000 }), 0); // never negative
});

// ───────────────────────── 2. read-only by construction ─────────────────────────
test("the request guard: four GET paths, the worker only, export types on a list, no credential-like name", () => {
  const L = D.createLoader(CFG, async () => { throw new Error("no network in tests"); });
  const u = L.urls;
  [u.roster, u.league, u.week, u.weekly(11), u.penalty].forEach((x) => t.ok(D.check(x, WORKER).ok, "allowed: " + x));
  const bad = [
    ["http://upsmflproduction.keith-creelman.workers.dev/roster-workbench?L=74598&YEAR=2026", "not https"],
    ["https://example.com/roster-workbench?L=74598&YEAR=2026", "other host"],
    ["https://api.myfantasyleague.com/2026/export?TYPE=league&L=74598", "MFL directly"],
    [`${WORKER}/api/mfl-export?TYPE=transactions&L=74598&YEAR=2026&JSON=1`, "transactions carry owner text"],
    [`${WORKER}/api/mfl-export?TYPE=tradeBait&L=74598&YEAR=2026&JSON=1`, "trade bait carries notes"],
    [`${WORKER}/api/mfl-export?TYPE=rosters&L=74598&YEAR=2026&JSON=1`, "unlisted export type"],
    [`${WORKER}/roster-workbench?L=74598&YEAR=2026&MFL_USER_ID=abc`, "session id"],
    [`${WORKER}/roster-workbench?L=74598&YEAR=2026&APIKEY=abc`, "api key"],
    [`${WORKER}/roster-workbench?L=74598&YEAR=2026&token=abc`, "token"],
    [`${WORKER}/roster-workbench?L=74598&YEAR=2026&NO_CACHE=1`, "a query name not on the list"],
    [`${WORKER}/api/settings?L=74598`, "a write route"],
    [`${WORKER}/api/pick?L=74598`, "a write route"],
    [`${WORKER}/admin/anything?L=74598`, "admin"],
    [`${WORKER}/api/bug-reports?L=74598`, "bug reports"],
    [`${WORKER}/roster-workbench/extra?L=74598&YEAR=2026`, "path not exact"],
    [`https://user:pw@upsmflproduction.keith-creelman.workers.dev/roster-workbench?L=74598&YEAR=2026`, "credentials in the address"],
    [`${WORKER}/roster-workbench?L=74598&YEAR=2026#x`, "fragment"],
    ["not a url", "garbage"],
  ];
  bad.forEach(([x, why]) => t.equal(D.check(x, WORKER).ok, false, "refused (" + why + "): " + x));
  t.equal(D.check(u.roster, "").ok, false, "no worker configured");
});

test("each guard layer refuses on its own, even if the layer beside it were widened by mistake", () => {
  const names = ["MFL_USER_ID", "APIKEY", "token", "session", "cookie", "Authorization"];
  const widened = [{ path: "/roster-workbench", query: ["L", "YEAR"].concat(names) }, { path: "/api/mfl-export", query: ["TYPE", "L", "YEAR", "JSON", "W"] }];
  names.forEach((n) => t.equal(D.check(`${WORKER}/roster-workbench?L=74598&YEAR=2026&${n}=x`, WORKER, widened).ok, false, "credential-name layer: " + n));
  t.equal(D.check(`${WORKER}/api/mfl-export?TYPE=transactions&L=74598&YEAR=2026&JSON=1`, WORKER, widened).ok, true, "(control) with no type list and no name layer this would pass: the type list is what refuses it");
  t.equal(D.check(`${WORKER}/api/mfl-export?TYPE=transactions&L=74598&YEAR=2026&JSON=1`, WORKER).ok, false);
  t.equal(D.check(`${WORKER}/roster-workbench?L=74598&YEAR=2026&NO_CACHE=1`, WORKER, widened).ok, false, "query-name layer");
  t.equal(D.check(`${WORKER}/api/settings?L=74598`, WORKER, widened).ok, false, "path layer");
  t.equal(D.check(`https://example.com/roster-workbench?L=74598&YEAR=2026`, WORKER, widened).ok, false, "host layer");
});

test("every request the loader makes is a bare GET with credentials omitted; a refused address never reaches fetch", async () => {
  const calls = [];
  const bodies = { "/roster-workbench": FX.roster_workbench, "/api/current-lineup-week": FX.current_lineup_week, "/api/cap-penalty/preview": FX.cap_penalty };
  const fake = async (url, opts) => {
    calls.push({ url, opts });
    const u = new URL(url);
    const body = u.pathname === "/api/mfl-export" ? (u.searchParams.get("TYPE") === "league" ? FX.league : FX.weekly_results) : bodies[u.pathname];
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const L = D.createLoader(CFG, fake);
  const core = await L.loadCore();
  const pen = await L.loadPenalty();
  t.equal(core.roster.state, "ok"); t.equal(core.week, 11); t.equal(core.weekly.state, "ok"); t.equal(pen.state, "ok");
  t.equal(pen.meta.earnedThroughWeek, 10);
  t.equal(calls.length, 5, "five reads in all: roster, league, week, lineups, calculations");
  calls.forEach((c) => {
    t.equal(c.opts.method, "GET"); t.equal(c.opts.credentials, "omit");
    t.equal(c.opts.headers, undefined, "no custom headers");
    t.equal(c.opts.body, undefined, "no body");
    t.ok(D.check(c.url, WORKER).ok);
  });
  t.deepEqual(L.summary(), { requests: 5, ok: 5, failed: 0, refused: 0, nonGet: 0 });
  const before = calls.length;
  let refused = null;
  try { await L.get(`${WORKER}/api/mfl-export?TYPE=transactions&L=74598&YEAR=2026&JSON=1`, "should not go"); } catch (e) { refused = e; }
  t.ok(refused && /refused/i.test(refused.message));
  t.equal(calls.length, before, "fetch was not called for a refused address");
  t.equal(L.summary().refused, 1);
});

test("a failed read is reported as failed, not as an empty league", async () => {
  const fail = async (url) => {
    if (/roster-workbench/.test(url)) return { ok: false, status: 502, text: async () => "bad gateway" };
    return { ok: true, status: 200, text: async () => JSON.stringify(/lineup-week/.test(url) ? FX.current_lineup_week : /league/.test(url) ? FX.league : FX.weekly_results) };
  };
  const core = await D.createLoader(CFG, fail).loadCore();
  t.equal(core.roster.state, "error"); t.match(core.roster.error, /HTTP 502/);
  const partial = async (url) => {
    if (/TYPE=weeklyResults/.test(url)) return { ok: true, status: 200, text: async () => "not json{" };
    return { ok: true, status: 200, text: async () => JSON.stringify(/roster-workbench/.test(url) ? FX.roster_workbench : /lineup-week/.test(url) ? FX.current_lineup_week : FX.league) };
  };
  const c2 = await D.createLoader(CFG, partial).loadCore();
  t.equal(c2.roster.state, "ok"); t.equal(c2.weekly.state, "error");
  const pen = await D.createLoader(CFG, async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: false }) })).loadPenalty();
  t.equal(pen.state, "error");
});

test("the source holds no write verb, credential name or second transport; fetch lives in one file", () => {
  const files = ["app.js", "config.js", "lib/format.js", "lib/contract.js", "lib/model.js", "lib/data.js", "lib/photo.js", "lib/views.js"];
  const forbidden = [/XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /document\.cookie/, /indexedDB/, /serviceWorker/, /importScripts/, /\beval\s*\(/, /new Function/,
    /\bPOST\b/, /\bPUT\b/, /\bDELETE\b/, /\bPATCH\b/, /MFL_USER_ID\s*[=:]/, /APIKEY\s*[=:]/i, /Authorization/, /method:\s*["'](?!GET)/];
  files.forEach((f) => { const s = read(f); forbidden.forEach((re) => t.doesNotMatch(s, re, f + " must not match " + re)); });
  files.filter((f) => f !== "lib/data.js").forEach((f) => t.doesNotMatch(read(f).replace(/window\.fetch\.bind\(window\)/, ""), /\bfetch\s*\(/, f + " does not call fetch itself"));
  t.match(read("app.js"), /window\.fetch\.bind\(window\)/); // the loader is handed fetch; nothing else is
  files.filter((f) => f !== "app.js").forEach((f) => t.doesNotMatch(read(f), /localStorage|sessionStorage/, f + " does not store anything"));
  t.deepEqual([...read("app.js").matchAll(/setPref\("([a-z]+)"/g)].map((m) => m[1]).sort().filter((x, i, a) => a.indexOf(x) === i), ["skin", "team", "vib"]);
});

// ───────────────────────── 3. the model ─────────────────────────
test("the model keeps an allowlist of fields, flips names, groups IDP positions and reads the submitted lineup", () => {
  const m = model();
  t.equal(m.teams.length, 12); t.equal(m.week, 11); t.deepEqual(m.limits, { roster: 30, ir: 15, taxi: 10, starters: 18 });
  const allowed = ["id", "rawName", "name", "rawPos", "pos", "nflTeam", "salary", "salaryUnresolved", "years", "type", "special", "aav", "acquisition", "status", "bye", "espnId", "points", "order", "franchiseId", "franchiseName", "starter", "taxi"].sort();
  Object.values(m.byId).forEach((p) => t.deepEqual(Object.keys(p).sort(), allowed, "no extra fields on " + p.name));
  const sn = findPlayer((p) => /Smith-Njigba/.test(p.name));
  t.equal(m.byId[sn.id].name, "Jaxon Smith-Njigba");
  const de = findPlayer((p) => p.position === "DE"), cb = findPlayer((p) => p.position === "CB"), s = findPlayer((p) => p.position === "S");
  t.equal(m.byId[de.id].pos, "DL"); t.equal(m.byId[cb.id].pos, "DB"); t.equal(m.byId[s.id].pos, "DB");
  const bombers = m.teams.find((x) => x.id === "0010");
  t.equal(bombers.counts.active + bombers.counts.taxi + bombers.counts.ir, bombers.players.length);
  t.equal(bombers.lineup.state, "ok");
  const st = M.starters(bombers);
  t.ok(st.length > 10 && st.every((p) => p.status === "active"));
  const groups = M.benchGroups(bombers);
  t.equal(st.length + groups.reduce((n, g) => n + g.players.length, 0), bombers.counts.active, "starters + bench = active");
  groups.forEach((g) => g.players.forEach((p) => t.ok(!p.starter && p.pos === g.pos)));
});

test("no submitted lineup means 'lineup not available', never an empty lineup", () => {
  const m = M.build(FX.roster_workbench, FX.league, null, null, 2026);
  const b = m.teams.find((x) => x.id === "0010");
  t.equal(b.lineup.state, "unavailable"); t.equal(M.starters(b).length, 0);
  t.equal(M.benchGroups(b).reduce((n, g) => n + g.players.length, 0), b.counts.active);
  t.equal(M.build(FX.roster_workbench, null, null, 11, 2026).limits.roster, null);
  t.equal(M.startersByFranchise({ weeklyResults: { matchup: [] } }), null);
  t.equal(M.startersByFranchise({ nothing: 1 }), null);
});

// ───────────────────────── 4. the screens ─────────────────────────
test("the Team screen: starters above bench, groups, reserve counts, and only read-only controls", () => {
  const S = state();
  const html = V.app(S);
  t.match(html, /Week 11 starters/); t.match(html, /Blake Bombers/); t.match(html, /Active \d+ of 30/); t.match(html, /Taxi \d+ of 10/); t.match(html, /IR \d+ of 15/);
  t.ok(html.indexOf("Week 11 starters") < html.indexOf("Bench ·"), "starters above bench");
  t.ok(html.indexOf("Bench ·") < html.indexOf("Injured reserve"), "bench above reserve");
  const acts = [...html.matchAll(/data-act="([a-z]+)"/g)].map((m) => m[1]);
  acts.forEach((a) => t.ok(ALLOWED_ACTS.includes(a), "allowed control: " + a));
  t.doesNotMatch(html, /\b(Swap|Start in lineup|Drop|Extend|Restructure|Submit|Save|Bid|Propose|Accept|Reject)\b/, "no transaction wording on the roster screen");
  t.equal((html.match(/<form/g) || []).length, 0); t.equal((html.match(/<input|<textarea|<select/g) || []).length, 0);
  t.doesNotMatch(html, /\sstyle=/); t.doesNotMatch(html, /\son[a-z]+=/i); t.doesNotMatch(html, /<script/i);
  const open = V.app(state({ open: { bQB: true, bRB: true, bWR: true, bTE: true, ir: true, taxi: true } }));
  t.ok((open.match(/data-act="card"/g) || []).length > (html.match(/data-act="card"/g) || []).length, "expanding groups lists more players");
});

test("the Contracts view of the roster shows recorded salary and years; a missing salary is 'Not recorded', not $0", () => {
  const S = state({ view: "contracts", open: { bQB: true, bRB: true, bWR: true, bTE: true, ir: true, taxi: true } });
  const html = V.app(S);
  t.match(html, /\$\d{1,3}(,\d{3})*/); t.match(html, /yrs left|Final year/);
  const S2 = state({ view: "contracts" }); const p = M.starters(S2.model.teams.find((x) => x.id === "0010"))[0]; p.salary = null;
  t.match(V.app(S2), /Not recorded/);
});

// Codex round-2 MAT-2: the worker sends salary 0 with salary_unresolved: true when MFL left a salary blank, and
// `Number(null)` / `Number("")` are 0 too. These go through the real model (not a hand-edited player) to the real screens.
test("a blank or unresolved salary stays unknown from the raw read to the roster and the profile: 'Not recorded', never $0", () => {
  const target = findPlayer((x) => x.years >= 2 && x.status === "ROSTER" && FX.cap_penalty.players[x.id]);
  const allOpen = { bQB: true, bRB: true, bWR: true, bTE: true, bDL: true, bLB: true, bDB: true, ir: true, taxi: true };
  const variants = {
    "salary 0 + salary_unresolved": { salary: 0, salary_unresolved: true },
    "salary null": { salary: null },
    "salary empty string": { salary: "" },
    "salary whitespace": { salary: "  " },
    "salary missing": { salary: undefined },
    "unresolved flag wins over a number": { salary: 7000, salary_unresolved: true },
  };
  const control = M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026).byId[target.id];
  t.ok(control.salary > 0 && control.salaryUnresolved === false, "a recorded salary is unchanged");
  Object.entries(variants).forEach(([name, patch]) => {
    const rw = JSON.parse(JSON.stringify(FX.roster_workbench));
    const raw = rw.teams.flatMap((tm) => tm.players).find((x) => String(x.id) === String(target.id));
    Object.assign(raw, patch); if (patch.salary === undefined) delete raw.salary;
    const model = M.build(rw, FX.league, FX.weekly_results, 11, 2026);
    const p = model.byId[target.id];
    t.equal(p.salary, null, name + ": the model keeps the salary unknown, not 0");
    t.equal(p.salaryUnresolved, patch.salary_unresolved === true, name + ": the unresolved flag is kept");
    // the player's roster card (Contracts view) and the profile's salary tile and current-year cell
    const roster = V.app(state({ model, teamId: p.franchiseId, view: "contracts", open: allOpen }));
    const at = roster.indexOf('data-pid="' + target.id + '"'); t.ok(at > 0, name + ": the player is on the open roster");
    const mine = roster.slice(at);
    const row = mine.slice(0, mine.indexOf('class="go"')); // from the name button to the end of this row: the salary sits after the button
    t.match(row, /<b class="wn">Not recorded<\/b>/, name + ": the roster row says Not recorded");
    t.doesNotMatch(row, /<b>\$0<\/b>/, name + ": the roster row is not $0");
    const html = V.app(state({ model, profile: { pid: String(target.id), tab: "contract" } }));
    t.match(html, /<b class="wn">Not recorded<\/b><small>Salary 2026<\/small>/, name + ": the salary tile says Not recorded");
    t.match(html, /<b class="wn">Not recorded<\/b><small>2026<\/small>/, name + ": this season's salary-by-year cell says Not recorded");
    t.doesNotMatch(html, /<b>\$0<\/b><small>(Salary 2026|2026)<\/small>/, name + ": neither is $0");
    t.doesNotMatch(html, /The recorded year amount differs/, name + ": an unknown salary does not raise a mismatch note");
    if (patch.salary_unresolved === true) t.match(html, /MFL has no salary recorded for this player/, name + ": the profile says why");
    else t.doesNotMatch(html, /MFL has no salary recorded for this player/);
  });
  // the same through the contract maths
  t.equal(C.schedule({ salary: null, years: 2, special: "CL 2|TCV 4K|AAV 2K|Y1-2K, Y2-2K" }, 2026).rows[0].amount, null);
  t.equal(C.schedule({ salary: "  ", years: 2, special: "CL 2|TCV 4K|AAV 2K|Y1-2K, Y2-2K" }, 2026).rows[0].amount, null);
  t.deepEqual(C.schedule({ salary: null, years: 2, special: "CL 2|TCV 4K|AAV 2K|Y1-2K, Y2-2K" }, 2026).notes, [], "no false 'differs' note for an unknown salary");
  t.equal(C.schedule({ salary: 0, years: 1, special: "" }, 2026).rows[0].amount, 0, "a recorded number, even 0, passes through the contract maths untouched");
});

test("when the lineup cannot be read the screen says so, and the bye chip shows only in the bye week", () => {
  const S = state({ model: M.build(FX.roster_workbench, FX.league, null, 11, 2026) });
  const html = V.app(S);
  t.match(html, /Lineup not available/); t.doesNotMatch(html, /Week 11 starters/);
  const S2 = state(); const b = S2.model.teams.find((x) => x.id === "0010").players.find((p) => p.starter); b.bye = 11;
  t.match(V.app(S2), /Bye week/);
  b.bye = 9; t.doesNotMatch(V.app(S2), /▲ Bye week/);
});

test("a failed or loading roster read shows a plain state with a retry, not an empty league", () => {
  t.match(V.app(state({ model: null, load: { core: "loading", coreNotes: [] } })), /aria-busy="true"/);
  const fail = V.app(state({ model: null, load: { core: "error", coreNotes: [], error: "HTTP 502" } }));
  t.match(fail, /Couldn’t read the league data/); t.match(fail, /data-act="retry"/); t.match(fail, /HTTP 502/);
  const partial = V.app(state({ load: { core: "partial", coreNotes: ["League roster limits did not load."] } }));
  t.match(partial, /Not everything loaded/);
});

test("the Player profile Contract tab: salary, years left, earned, remaining guarantee, salary by year, all labeled", () => {
  const p = findPlayer((x) => /Smith-Njigba/.test(x.name));
  const html = V.app(state({ profile: { pid: p.id, tab: "contract" } }));
  t.match(html, /Jaxon Smith-Njigba/); t.match(html, /\$1,000/); t.match(html, /Salary 2026/); t.match(html, /Years left/);
  t.match(html, /\$14,588/, "earned = the worker's earned"); t.match(html, /\$37,912/, "remaining guarantee = guarantee - earned");
  t.match(html, /\$55,000/, "next year from the recorded token");
  t.match(html, /Earned counts through Week 10/);
  t.match(html, /Where these numbers come from/);
  t.match(html, /data-chain="\[&quot;https:\/\/a\.espncdn\.com\/i\/headshots\/nfl\/players\/full\/\d+\.png&quot;,&quot;https:\/\/www48\.myfantasyleague\.com\/player_photos_2014\/\d+_thumb\.jpg&quot;\]"/);
  const opened = V.app(state({ profile: { pid: p.id, tab: "contract" }, flags: { rules: true, earned: true, cut: true, raw: true } }));
  t.match(opened, /Total value<\/b><span>\$70,000/); t.match(opened, /Guaranteed<\/b><span>\$52,500/); t.match(opened, /AAV \(as recorded\)<\/b><span>\$30,000/);
  t.match(opened, /\$14,000 from played years \+ \$588 this season/); t.match(opened, /Guarantee \$52,500 minus earned \$14,588/);
  t.match(opened, /CL 3\| TCV 70K/); t.match(opened, /Nothing can be cut from here/);
});

test("a rookie option year is shown separately and labeled, not as an obligation", () => {
  const p = findPlayer((x) => /Option/.test(x.special) && x.years === 3);
  const html = V.app(state({ profile: { pid: String(p.id), tab: "contract" } }));
  t.match(html, /Option 2029/); t.match(html, /not an obligation/);
  t.equal((html.match(/class="k3"/g) || []).length, 1);
});

test("nothing is drawn as $0 when the worker's answer is missing, loading, failed or flagged", () => {
  const p = findPlayer((x) => x.years >= 2 && x.status === "ROSTER" && FX.cap_penalty.players[x.id] && !FX.cap_penalty.players[x.id].earned_rule);
  const row = FX.cap_penalty.players[p.id];
  const cases = {
    loading: state({ penalty: { state: "loading" }, profile: { pid: p.id, tab: "contract" }, flags: { rules: true, earned: true, cut: true } }),
    idle: state({ penalty: { state: "idle" }, profile: { pid: p.id, tab: "contract" }, flags: { rules: true, earned: true, cut: true } }),
    failed: state({ penalty: { state: "error", error: "HTTP 500" }, profile: { pid: p.id, tab: "contract" }, flags: { rules: true, earned: true, cut: true } }),
    absent: state({ penalty: penalty({ data: {} }), profile: { pid: p.id, tab: "contract" }, flags: { rules: true, earned: true, cut: true } }),
    review: state({ penalty: penalty({ data: { [p.id]: { ...row, needs_review: true, review_reason: "Acquisition week unclear", penalty: 0, earned: 0 } } }), profile: { pid: p.id, tab: "contract" }, flags: { rules: true, earned: true, cut: true } }),
  };
  Object.entries(cases).forEach(([name, S]) => {
    const html = V.app(S);
    const tiles = html.slice(html.indexOf('class="k2"'), html.indexOf("Salary by year"));
    // the first tile is this season's real salary; the earned and guarantee tiles must not be a dollar amount
    t.doesNotMatch(tiles.split("Salary " + 2026)[1] || "", /<b>\$0<\/b>/, name + ": no $0 tile");
    t.doesNotMatch(html, /If cut now[\s\S]*<b>\$0<\/b>[\s\S]*Nothing can be cut/, name + ": no $0 cut cost");
    t.match(html, /Not available|Loading…/, name + ": says it is not available");
  });
  t.match(V.app(cases.failed), /data-act="retrypen"/);
  t.match(V.app(cases.review), /Acquisition week unclear/);
  const none = V.app(cases.absent);
  t.match(none, /The worker’s answer is not available/);
});

test("the worker's own zero is shown as $0 (exempt cut), and the earned rules read as the Front Office words them", () => {
  const ex = Object.entries(FX.cap_penalty.players).find(([id, r]) => r.exempt && r.penalty === 0 && !r.needs_review);
  const html = V.app(state({ profile: { pid: ex[0], tab: "contract" }, flags: { cut: true } }));
  t.match(html, /<b>\$0<\/b>/); t.match(html, new RegExp(ex[1].exempt_reason.slice(0, 20).replace(/[$.()§]/g, ".")));
  const full = Object.entries(FX.cap_penalty.players).find(([id, r]) => r.earned_rule === "full_year_sub_5k");
  t.match(V.app(state({ profile: { pid: full[0], tab: "contract" } })), /Full-year rule/);
  const wwna = Object.entries(FX.cap_penalty.players).find(([id, r]) => r.earned_rule === "ww_earned_na");
  if (wwna) t.match(V.app(state({ profile: { pid: wwna[0], tab: "contract" } })), /Not applicable/);
});

test("other tabs and states: placeholders say what is not here; taxi details; unknown player", () => {
  const tx = findPlayer((p) => p.status === "TAXI_SQUAD");
  const html = V.app(state({ profile: { pid: tx.id, tab: "more" } }));
  t.match(html, /Taxi squad/); t.match(html, /Call-ups used/); t.match(html, /not in Preview 0/i);
  t.match(V.app(state({ profile: { pid: tx.id, tab: "sched" } })), /not in Preview 0/);
  t.match(V.app(state({ profile: { pid: tx.id, tab: "perf" } })), /Season points/);
  const miss = V.app(state({ profile: { pid: "99999999", tab: "contract" } }));
  t.match(miss, /Player not found/);
  ["home", "market", "league"].forEach((id) => t.match(V.app(state({ tab: id })), /not in Preview 0/i));
  t.match(V.app(state({ sub: "contracts" })), /not in Preview 0/i); t.match(V.app(state({ sub: "cap" })), /Cap space is left out on purpose/);
});

test("data text is escaped everywhere it is drawn", () => {
  const S = state({ profile: null });
  const team = S.model.teams.find((x) => x.id === "0010");
  const evil = '"><img src=x onerror=alert(1)><script>alert(1)</script>';
  team.name = evil; team.icon = evil;
  const p = team.players[0]; p.name = evil; p.type = evil; p.nflTeam = evil; p.special = evil; p.acquisition = evil; p.franchiseName = evil;
  S.model.byId[p.id] = p;
  const checks = [V.app(S), V.app({ ...S, open: { bQB: true, bRB: true, bWR: true, bTE: true, ir: true, taxi: true }, view: "contracts" }), V.app({ ...S, profile: { pid: p.id, tab: "contract" }, flags: { rules: true, raw: true, earned: true, cut: true } }), V.app({ ...S, profile: { pid: p.id, tab: "more" } }), V.app({ ...S, sheet: "teams" })];
  checks.forEach((html) => {
    t.doesNotMatch(html, /<script/i); t.doesNotMatch(html, /<img src=x/i);
    // no real tag carries an event-handler attribute (text inside a quoted attribute value does not count)
    [...html.matchAll(/<[a-z][^>]*>/gi)].forEach((m) => t.doesNotMatch(m[0].replace(/"[^"]*"/g, '""'), /\son[a-z]+\s*=/i));
    // the only <img> tags are the ones the page draws itself, each with an empty or labeled alt and a data-chain attribute
    [...html.matchAll(/<img\b[^>]*>/gi)].forEach((m) => t.match(m[0], /^<img alt="[^"]*" data-chain="[^"]*" referrerpolicy="no-referrer"( decoding="async")?>$/));
  });
  t.equal(F.esc(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
});

test("no screen, tab, sheet or state draws an inline style, an event handler, a script, a form field or a control outside the read-only set", () => {
  const open = { bQB: true, bRB: true, bWR: true, bTE: true, bPK: true, bPN: true, bDL: true, bLB: true, bDB: true, ir: true, taxi: true };
  const flags = { rules: true, earned: true, cut: true, raw: true };
  const states = [];
  ["home", "market", "league"].forEach((tab) => states.push(state({ tab })));
  ["roster", "contracts", "cap"].forEach((sub) => ["lineup", "contracts"].forEach((view) => states.push(state({ sub, view, open }))));
  states.push(state({ model: null, load: { core: "loading", coreNotes: [] } }), state({ model: null, load: { core: "error", coreNotes: [], error: "x" } }), state({ sheet: "teams" }), state({ sheet: "about" }),
    state({ model: M.build(FX.roster_workbench, FX.league, null, null, 2026), open }));
  allPlayers().forEach((p) => ["perf", "sched", "contract", "more"].forEach((tab) => {
    states.push(state({ profile: { pid: p.id, tab }, flags, penalty: tab === "contract" ? penalty() : { state: "loading" } }));
  }));
  states.push(state({ profile: { pid: "1", tab: "contract" }, penalty: { state: "error", error: "HTTP 500" }, flags }));
  t.ok(states.length > 500, "drew " + states.length + " states");
  states.forEach((S) => {
    const html = V.app(S);
    t.doesNotMatch(html, /\sstyle=/i); t.doesNotMatch(html, /<script|<form|<input|<textarea|<select|<iframe|<object|<embed|<link|<style/i);
    [...html.matchAll(/<[a-z][^>]*>/gi)].forEach((m) => t.doesNotMatch(m[0].replace(/"[^"]*"/g, '""'), /\son[a-z]+\s*=|\shref=|\ssrc=/i));
    [...html.matchAll(/data-act="([a-z]+)"/g)].forEach((m) => t.ok(ALLOWED_ACTS.includes(m[1]), "control " + m[1]));
  });
});

test("About lists the requests made, the unavailable items and the display controls", () => {
  const S = state({ sheet: "about", requestLog: [{ label: "roster and contracts", path: "/roster-workbench", type: "", method: "GET", status: 200, bytes: 600000, ms: 900, refused: "" }, { label: "blocked", path: "/api/pick", type: "", method: "GET", status: null, refused: "path not allowed" }], requestSummary: { requests: 2, ok: 1, failed: 0, refused: 1, nonGet: 0 } });
  const html = V.app(S);
  t.match(html, /<b>2<\/b> data requests/); t.match(html, /Methods other than GET: <b>0<\/b>/); t.match(html, /Refused/);
  t.match(html, /Helmet badge and team colors \(not approved\)/); t.match(html, /you are not signed in as anyone/);
  t.match(html, /data-act="skin"/); t.match(html, /data-act="vib"/);
  t.match(V.app(state({ sheet: "teams" })), /does not sign you in and cannot change anything/);
});

// ───────────────────────── 5. photos ─────────────────────────
test("the headshot chain is ESPN, then MFL, then a placeholder, in that order", () => {
  t.deepEqual(P.chain("4685724", "16223"), ["https://a.espncdn.com/i/headshots/nfl/players/full/4685724.png", "https://www48.myfantasyleague.com/player_photos_2014/16223_thumb.jpg"]);
  t.deepEqual(P.chain("", "16223"), ["https://www48.myfantasyleague.com/player_photos_2014/16223_thumb.jpg"]);
  t.deepEqual(P.chain("x1", "y2"), []);
  const mk = () => { const h = {}; return { hidden: false, src: "", attrs: {}, handlers: h, addEventListener(e, f) { h[e] = f; }, removeAttribute(a) { this.removed = a; delete this.src; } }; };
  const img = mk(); const seen = [];
  P.attach(img, P.chain("1", "2"), (s) => seen.push(s));
  t.equal(img.hidden, true); t.match(img.src, /espncdn/);
  img.handlers.error(); t.match(img.src, /myfantasyleague/); t.equal(img.hidden, true);
  img.handlers.load(); t.equal(img.hidden, false); t.deepEqual(seen, ["mfl"]);
  const img2 = mk(); const seen2 = []; P.attach(img2, P.chain("1", "2"), (s) => seen2.push(s));
  img2.handlers.error(); img2.handlers.error(); t.equal(img2.hidden, true); t.deepEqual(seen2, ["placeholder"]);
  const img3 = mk(); P.attach(img3, [], (s) => seen2.push(s)); t.equal(img3.hidden, true);
  const known = { "https://a.espncdn.com/i/headshots/nfl/players/full/1.png": true };
  const img4 = mk(); P.attach(img4, P.chain("1", "2"), null, known); t.equal(img4.hidden, false, "a photo that already loaded does not flash the badge");
});

// ───────────────────────── 6. page policy ─────────────────────────
test("the page: content policy names only the worker and the photo hosts; zoom allowed; no inline script or style; not indexable", () => {
  const html = read("index.html");
  const csp = html.match(/Content-Security-Policy" content="([^"]+)"/)[1];
  t.match(csp, /default-src 'none'/); t.match(csp, /script-src 'self'/); t.match(csp, /style-src 'self'/);
  t.match(csp, /connect-src https:\/\/upsmflproduction\.keith-creelman\.workers\.dev(;|$)/);
  t.match(csp, /img-src https:\/\/a\.espncdn\.com https:\/\/\*\.myfantasyleague\.com data:/);
  t.doesNotMatch(csp, /unsafe-inline|unsafe-eval/); t.match(csp, /form-action 'none'/); t.match(csp, /base-uri 'none'/);
  t.doesNotMatch(html, /maximum-scale|user-scalable/i);
  t.match(html, /name="robots" content="noindex,nofollow"/); t.match(html, /name="referrer" content="no-referrer"/);
  t.doesNotMatch(html, /<script(?![^>]*\ssrc=)[^>]*>/i, "every script is a file"); t.doesNotMatch(html, /<style|\sstyle=|\son[a-z]+=/i);
  [...html.matchAll(/<script src="([^"]+)"/g)].forEach((m) => t.doesNotMatch(m[1], /^(https?:)?\/\//, "script from this site only"));
  t.doesNotMatch(read("styles.css"), /@import|url\(\s*["']?https?:/i, "no remote CSS");
  t.match(read("_headers"), /X-Robots-Tag: noindex/); t.match(read("_headers"), /frame-ancestors 'none'/);
});

// ───────────────────────── 7. contrast ─────────────────────────
test("every skin, with and without the position colors, meets the contrast targets (4.5:1; 7:1 in High contrast)", () => {
  const css = read("styles.css");
  const block = (sel) => { const i = css.indexOf(sel + "{"); if (i < 0) return {}; const body = css.slice(i + sel.length + 1, css.indexOf("}", i)); const o = {}; for (const m of body.matchAll(/(--[a-z0-9]+):([^;]+);?/g)) o[m[1]] = m[2].trim(); return o; };
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  let checked = 0;
  for (const skin of ["light", "dark", "hc"]) for (const vib of [false, true]) {
    const tok = { ...block(":root"), ...block(`:root[data-skin="${skin}"]`), ...(vib ? block(`:root[data-skin="${skin}"][data-vib="1"]`) : {}) };
    const val = (n) => { let v = tok["--" + n]; for (let i = 0; i < 6 && /^var\(/.test(v); i++) v = tok[v.slice(4, -1)]; return v; };
    const need = skin === "hc" ? 7 : 4.5, tag = `${skin}${vib ? "+vibrant" : ""}`;
    const pairs = [["tx", "bg"], ["tx", "sf"], ["tx", "s2"], ["mu", "bg"], ["mu", "sf"], ["mu", "s2"], ["ac", "bg"], ["ac", "sf"], ["on", "ac"], ["ok", "sf"], ["wn", "sf"], ["cr", "sf"], ["ok", "bg"], ["wn", "bg"], ["cr", "bg"], ["fc", "sf"]];
    if (vib) pairs.push(["on", "g2"], ["pqt", "pq"], ["prt", "pr"], ["pwt", "pw"], ["ptt", "pt"], ["pdt", "pd"]);
    pairs.forEach(([a, b]) => { const r = ratio(val(a), val(b)); checked++; t.ok(r >= (a === "fc" ? 3 : need), `${tag}: ${a} on ${b} is ${r.toFixed(2)}:1, needs ${a === "fc" ? 3 : need}`); });
  }
  t.ok(checked > 100, "checked " + checked + " pairs");
});

// ───────────────────────── 7b. team-colored profile header ─────────────────────────
test("the profile header is colored by the player's NFL team: every team and skin is readable, the stylesheet is exactly what the generator writes, and the headshot and contract details are unchanged", async () => {
  const TC = await import(pathToFileURL(path.join(APP, "scripts/team_colors.mjs")).href);
  const css = read("team-colors.css");
  t.equal(css, TC.generate(), "team-colors.css is the generator's output, byte for byte (run apps/mobile2027/scripts/team_colors.mjs)");
  t.doesNotMatch(css, /@import|url\(|https?:|<|expression\(/i, "the stylesheet loads nothing and holds no markup");
  t.match(read("index.html"), /<link rel="stylesheet" href="team-colors\.css">/);
  const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
  t.ok(B.FILES.includes("team-colors.css"), "the build ships it");

  // readable on every team in every skin (4.5:1; 7:1 in High contrast), plus the neutral palette for an unknown team
  const codes = Object.keys(TC.TEAMC);
  t.equal(codes.length, 32, "all 32 NFL teams");
  let checked = 0;
  for (const skin of TC.SKINS) for (const code of ["", ...codes]) {
    const p = TC.heroPal(code, skin), need = skin === "hc" ? 7 : 4.5, tag = `${skin} ${code || "(no team)"}`;
    [["t", "g1"], ["t", "g2"], ["m", "g1"], ["m", "g2"]].forEach(([a, b]) => { checked++; t.ok(TC.crat(p[a], p[b]) >= need, `${tag}: ${a} on ${b} is ${TC.crat(p[a], p[b]).toFixed(2)}:1, needs ${need}`); });
    checked++; t.ok(TC.crat(p.pillt, p.pill) >= need, `${tag}: pill text on pill`);
    checked++; t.ok(TC.crat(p.ring, p.g1) >= 3 || TC.crat(p.ring, p.g2) >= 3, `${tag}: the photo ring stands out from the ground`);
    checked++; t.ok(TC.crat(p.t, p.av) >= 3, `${tag}: the position badge text on the photo ground`);
  }
  t.equal(checked, 3 * 33 * 7, "3 skins x (32 teams + the neutral palette) x 7 pairs");
  // the stylesheet really has a rule for every team in every skin, and for the MFL spellings of the same teams
  for (const skin of TC.SKINS) {
    t.match(css, new RegExp(`:root\\[data-skin="${skin}"\\] \\.hero\\{--h1:`), skin + ": a neutral palette for an unknown team");
    for (const code of codes) t.ok(css.includes(`:root[data-skin="${skin}"] .hero.tm-${code}`), `${skin} ${code} has a rule`);
    Object.keys(TC.TMAP).forEach((mfl) => t.ok(css.includes(`:root[data-skin="${skin}"] .hero.tm-${mfl}`), `${skin} MFL code ${mfl} has a rule`));
  }
  // every real team code in the recorded data is covered; only free agents fall back to the neutral palette
  const known = new Set(codes.concat(Object.keys(TC.TMAP)));
  const dataCodes = [...new Set(allPlayers().map((p) => p.nfl_team))];
  t.deepEqual(dataCodes.filter((c) => !known.has(c)).sort(), ["FA"], "the only code without a team color is FA (a free agent)");

  // the header: team class, full name as the heading, the same headshot chain, the same contract details
  const p = findPlayer((x) => /Smith-Njigba/.test(x.name));
  const html = V.app(state({ profile: { pid: p.id, tab: "contract" } }));
  const hero = html.match(/<div class="hero[^"]*">[\s\S]*?<div class="hbar"><\/div><\/div>/)[0];
  t.match(hero, new RegExp(`class="hero tm-${p.nfl_team}"`), "the hero carries the player's team class");
  t.equal(hero.match(/<h3 class="hnm">([\s\S]*?)<\/h3>/)[1].replace(/<[^>]+>/g, ""), "Jaxon Smith-Njigba", "the heading still reads the full name");
  t.match(hero, /data-chain="\[&quot;https:\/\/a\.espncdn\.com\/i\/headshots\/nfl\/players\/full\/\d+\.png&quot;,&quot;https:\/\/www48\.myfantasyleague\.com\/player_photos_2014\/\d+_thumb\.jpg&quot;\]"/, "ESPN, then MFL");
  t.match(hero, /class="avpos">WR</, "the position badge underneath the photo");
  t.doesNotMatch(html, /helmet/i, "no helmet badge");
  ["\\$14,588", "\\$37,912", "\\$55,000", "Salary 2026", "Years left", "Earned counts through Week 10", "Where these numbers come from"].forEach((s) => t.match(html, new RegExp(s)));
  t.match(html, /data-act="close"/); t.equal((html.match(/data-act="close"/g) || []).length, 2, "the scrim and one Close button");
  // a free agent, a blank team and hostile text never produce a color class that is not a team, and never leave the attribute
  const mk = (nfl) => { const m = model(); const pl = m.byId[p.id]; pl.nflTeam = nfl; return V.app(state({ model: m, profile: { pid: p.id, tab: "contract" } })).match(/<div class="hero([^"]*)">/)[1]; };
  t.equal(mk(""), "", "blank: neutral"); t.equal(mk(null), "", "missing: neutral");
  t.equal(mk("FA"), " tm-FA", "FA gets a class that has no rule, so the neutral palette"); t.doesNotMatch(css, /tm-FA\b/);
  t.equal(mk("kcc"), " tm-KCC", "lowercase is read as the same team");
  ['BUF"><img src=x onerror=1>', "BUF BAL", "BÜF", "BUFFALO", "a'b", "<b>"].forEach((bad) => t.equal(mk(bad), "", "refused: " + bad));
  const shown = V.app(state({ model: (() => { const m = model(); m.byId[p.id].nflTeam = 'BUF"><img src=x onerror=1>'; return m; })(), profile: { pid: p.id, tab: "contract" } }));
  t.doesNotMatch(shown, /<img src=x/, "hostile team text is escaped where it is shown");
  // team colors are drawn only for the profile; the roster rows are not recolored
  t.doesNotMatch(V.app(state()), /class="hero/);
});

// ───────────────────────── 8. build and deploy guards ─────────────────────────
const COMMIT = "a".repeat(40), OTHER = "b".repeat(40);
const G = (commit = COMMIT, dirty = false) => () => ({ commit, dirty }); // a stand-in for the repository's state
test("the build copies exactly the allowlist, is repeatable, and refuses extras and secrets", async () => {
  const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
  const out1 = fs.mkdtempSync(path.join(os.tmpdir(), "m27a-")), out2 = fs.mkdtempSync(path.join(os.tmpdir(), "m27b-"));
  const r1 = B.build(out1, SRC, G()), r2 = B.build(out2, SRC, G());
  t.ok(r1.ok && r2.ok); t.equal(r1.digest, r2.digest, "the same sources give the same artifact digest");
  const listed = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else listed.push(path.relative(out1, p).split(path.sep).join("/")); } })(out1);
  t.deepEqual(listed.sort(), B.FILES.concat(["build-manifest.json"]).sort());
  B.FILES.forEach((f) => t.equal(fs.readFileSync(path.join(out1, f), "utf8"), read(f), f + " is byte for byte the reviewed source"));
  const hits = B.scan("x.js", "var a = 'APIKEY=abc123'; mfl_user_id: x");
  t.equal(hits.length, 2); t.ok(hits.some((h) => /MFL session id/.test(h)) && hits.some((h) => /API key/.test(h)));
  t.ok(B.scan("x", "contact me at someone@example.com").length === 1);
  t.ok(B.scan("x", "Authorization: Bearer abcdefghijklmnop1234").length >= 1);
  t.ok(B.scan("x", "ups_bs_ABCDEFGHIJKLMNOP").length === 1);
  t.equal(B.FILES.filter((f) => B.scan(f, read(f)).length).length, 0, "the real sources are clean");
  fs.rmSync(out1, { recursive: true, force: true }); fs.rmSync(out2, { recursive: true, force: true });
  // a copy of the sources, damaged on purpose: the build must refuse each damage and write nothing
  const mkSrc = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "m27s-")); fs.cpSync(SRC, d, { recursive: true }); return d; };
  const outDir = path.join(os.tmpdir(), "m27-should-not-exist-" + process.pid);
  const clean = mkSrc(); t.ok(B.build(outDir, clean, G()).ok, "an undamaged copy builds"); fs.rmSync(outDir, { recursive: true, force: true });
  const withSecret = mkSrc(); fs.appendFileSync(path.join(withSecret, "app.js"), '\nvar k = "APIKEY=abc123";\n');
  const rs = B.build(outDir, withSecret, G()); t.equal(rs.ok, false); t.match(rs.problems.join(" "), /app\.js: looks like an API key/); t.equal(fs.existsSync(outDir), false, "nothing written");
  const withExtra = mkSrc(); fs.writeFileSync(path.join(withExtra, "lib", "extra.js"), "var x = 1;");
  const re = B.build(outDir, withExtra, G()); t.equal(re.ok, false); t.match(re.problems.join(" "), /lib\/extra\.js/); t.equal(fs.existsSync(outDir), false);
  const withMissing = mkSrc(); fs.rmSync(path.join(withMissing, "lib", "photo.js"));
  const rm = B.build(outDir, withMissing, G()); t.equal(rm.ok, false); t.match(rm.problems.join(" "), /missing from src\/: lib\/photo\.js/); t.equal(fs.existsSync(outDir), false);
  // the source commit: recorded in the manifest; a dirty tree, a malformed commit or an unreadable git state is refused and writes nothing
  const ok = B.build(outDir, clean, G(OTHER)); t.ok(ok.ok); t.deepEqual(ok.manifest.source, { commit: OTHER }, "the manifest names the commit it was built at");
  t.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, "build-manifest.json"), "utf8")).source, { commit: OTHER }); fs.rmSync(outDir, { recursive: true, force: true });
  const rd = B.build(outDir, clean, G(COMMIT, true)); t.equal(rd.ok, false); t.match(rd.problems.join(" "), /uncommitted changes/); t.equal(fs.existsSync(outDir), false, "a dirty tree writes nothing");
  const rb = B.build(outDir, clean, G("main")); t.equal(rb.ok, false); t.match(rb.problems.join(" "), /40-character/); t.equal(fs.existsSync(outDir), false);
  const rx = B.build(outDir, clean, () => { throw new Error("not a git repository"); }); t.equal(rx.ok, false); t.match(rx.problems.join(" "), /git state/); t.equal(fs.existsSync(outDir), false);
  [clean, withSecret, withExtra, withMissing].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

test("the real git check sees a clean tree, an edit and an untracked file (tried on a throwaway repository)", async () => {
  const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
  const { execFileSync } = await import("node:child_process");
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "m27g-"));
  const g = (...a) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: repo, stdio: "ignore", env: { PATH: process.env.PATH, HOME: repo } });
  g("init", "-q"); fs.writeFileSync(path.join(repo, "a.txt"), "one"); g("add", "."); g("commit", "-q", "-m", "x", "--no-gpg-sign");
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH, HOME: repo } }).trim();
  const s0 = B.gitState(repo); t.equal(s0.commit, head); t.equal(s0.dirty, false);
  fs.writeFileSync(path.join(repo, "a.txt"), "two"); t.equal(B.gitState(repo).dirty, true, "an edited tracked file is dirty");
  g("checkout", "--", "a.txt"); t.equal(B.gitState(repo).dirty, false);
  fs.writeFileSync(path.join(repo, "new.txt"), "x"); t.equal(B.gitState(repo).dirty, true, "an untracked file is dirty");
  fs.rmSync(repo, { recursive: true, force: true });
});

test("the deploy script can only name the ups-mobile-beta preview address, and only for an unchanged build", async () => {
  const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
  const S = await import(pathToFileURL(path.join(APP, "scripts/deploy_preview.mjs")).href);
  t.equal(S.PROJECT, "ups-mobile-beta"); t.equal(S.BRANCH, "preview"); t.equal(S.PRODUCTION_BRANCH, "live"); t.ok(S.BRANCH !== S.PRODUCTION_BRANCH);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m27d-")); B.build(dir, SRC, G());
  const ctx = { git: G(), srcDir: SRC };
  const plan = (a, c = ctx) => S.plan(a, fs, c);
  const p = plan([dir]);
  t.equal(p.commit, COMMIT, "the plan names the source commit"); t.equal(p.digest.length, 64);
  t.equal(p.execute, false, "a dry run by default");
  t.deepEqual(p.command.slice(0, 3), ["wrangler", "pages", "deploy"]);
  t.equal(p.command[p.command.indexOf("--project-name") + 1], "ups-mobile-beta");
  t.equal(p.command[p.command.indexOf("--branch") + 1], "preview");
  t.equal(p.command.filter((c) => c === "--branch").length, 1, "an explicit --branch, once");
  t.ok(!p.command.includes("live") && !p.command.includes("--production") && !p.command.includes("main"));
  t.equal(plan([dir, "--execute"]).execute, true);
  ["--branch", "--project-name", "--production"].forEach((flag) => t.throws(() => plan([dir, flag, "live"]), /Usage|Unexpected/, flag + " cannot be passed"));
  t.throws(() => plan(["--branch=live"]), /Unexpected flag/);
  t.throws(() => plan([]), /Usage/);
  t.throws(() => plan([path.join(dir, "nope")]), /build-manifest/);
  fs.writeFileSync(path.join(dir, "extra.txt"), "x"); t.throws(() => plan([dir]), /do not match/); fs.rmSync(path.join(dir, "extra.txt"));
  fs.appendFileSync(path.join(dir, "app.js"), "\n// changed after the build\n"); t.throws(() => plan([dir]), /size differs|changed since the build/);
  fs.rmSync(dir, { recursive: true, force: true });
});

// Codex round-1 MAT-1: the manifest is data an attacker (or a mistake) can rewrite, so the deploy check must not trust it.
test("the deploy check refuses a tampered manifest: digest, file list, hashes, commit, dirty tree, bytes not from the commit", async () => {
  const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
  const S = await import(pathToFileURL(path.join(APP, "scripts/deploy_preview.mjs")).href);
  const { createHash } = await import("node:crypto");
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const ctx = { git: G(), srcDir: SRC };
  const fresh = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "m27t-")); t.ok(B.build(d, SRC, G()).ok); return d; };
  const mf = (d) => JSON.parse(fs.readFileSync(path.join(d, "build-manifest.json"), "utf8"));
  const save = (d, m) => fs.writeFileSync(path.join(d, "build-manifest.json"), JSON.stringify(m, null, 2) + "\n");
  const rehash = (m) => { m.digest = B.digestOf(m.files); return m; }; // a careful forger keeps the digest consistent with the list
  const refused = (name, d, re, c = ctx) => { t.throws(() => S.plan([d], fs, c), re, name); t.throws(() => S.plan([d, "--execute"], fs, c), re, name + " (with --execute)"); fs.rmSync(d, { recursive: true, force: true }); };

  { const d = fresh(); t.equal(S.plan([d], fs, ctx).digest, mf(d).digest, "an untouched build passes and reports its digest"); t.equal(B.digestOf(mf(d).files), mf(d).digest, "the digest is the canonical one"); fs.rmSync(d, { recursive: true, force: true }); }

  // 1. the aggregate digest changed, files untouched
  { const d = fresh(); const m = mf(d); m.digest = "0".repeat(64); save(d, m); refused("a rewritten digest", d, /digest does not match/); }
  { const d = fresh(); const m = mf(d); m.digest = m.digest.toUpperCase(); save(d, m); refused("an upper-case digest", d, /not a SHA-256/); }
  { const d = fresh(); const m = mf(d); delete m.digest; save(d, m); refused("no digest", d, /exactly these fields/); }
  // 2. a different file set, with matching hashes and a matching digest
  { const d = fresh(); fs.writeFileSync(path.join(d, "evil.js"), "x"); const m = mf(d); m.files.push({ path: "evil.js", bytes: 1, sha256: sha("x") }); save(d, rehash(m)); refused("an extra file listed with matching hash and digest", d, /not exactly the build allowlist/); }
  { const d = fresh(); fs.rmSync(path.join(d, "lib/photo.js")); const m = mf(d); m.files = m.files.filter((f) => f.path !== "lib/photo.js"); save(d, rehash(m)); refused("a file dropped from disk and manifest", d, /not exactly the build allowlist/); }
  { const d = fresh(); const m = mf(d); m.files.push({ ...m.files[0] }); save(d, rehash(m)); refused("a duplicated entry", d, /not exactly the build allowlist/); }
  { const d = fresh(); const m = mf(d); m.files.reverse(); save(d, rehash(m)); refused("a reordered list", d, /not exactly the build allowlist/); }
  { const d = fresh(); const m = mf(d); m.files[0].path = "../" + m.files[0].path; save(d, rehash(m)); refused("a path that escapes the folder", d, /not exactly the build allowlist/); }
  { const d = fresh(); fs.writeFileSync(path.join(d, "stray.txt"), "x"); refused("an unlisted file on disk", d, /do not match/); }
  // 3. a file changed and the manifest rewritten to match (hash, size and digest)
  { const d = fresh(); const f = path.join(d, "app.js"); fs.appendFileSync(f, "\n// edited\n"); const m = mf(d); const e = m.files.find((x) => x.path === "app.js"); const buf = fs.readFileSync(f); e.bytes = buf.length; e.sha256 = sha(buf); save(d, rehash(m)); refused("a changed file with a fully rewritten manifest", d, /not the source at the named commit/); }
  { const d = fresh(); const m = mf(d); m.files[0].bytes += 1; save(d, rehash(m)); refused("a wrong size", d, /size differs/); }
  { const d = fresh(); const m = mf(d); m.files[0].sha256 = "1".repeat(64); save(d, rehash(m)); refused("a wrong file hash", d, /changed since the build/); }
  // 4. the manifest's shape
  { const d = fresh(); const m = mf(d); m.extra = 1; save(d, m); refused("an unknown manifest field", d, /exactly these fields/); }
  { const d = fresh(); const m = mf(d); m.files[0].note = "x"; save(d, m); refused("an unknown file-entry field", d, /malformed/); }
  { const d = fresh(); const m = mf(d); m.build = "preview9"; save(d, m); refused("another build name", d, /not a Preview 0 build/); }
  { const d = fresh(); fs.writeFileSync(path.join(d, "build-manifest.json"), "{not json"); refused("unparseable JSON", d, /not valid JSON/); }
  // 5. the source commit
  { const d = fresh(); const m = mf(d); delete m.source; save(d, m); refused("no source commit", d, /exactly these fields/); }
  { const d = fresh(); const m = mf(d); m.source.commit = "main"; save(d, m); refused("a branch name instead of a commit", d, /40-character source commit/); }
  { const d = fresh(); const m = mf(d); m.source = { commit: COMMIT, dirty: false }; save(d, m); refused("an extra source field", d, /40-character source commit/); }
  { const d = fresh(); refused("HEAD is a different commit than the build's", d, /came from commit aaaaaaaa but HEAD is bbbbbbbb/, { git: G(OTHER), srcDir: SRC }); }
  { const d = fresh(); const m = mf(d); m.source.commit = OTHER; save(d, m); refused("a manifest rewritten to name another commit", d, /came from commit bbbbbbbb but HEAD is aaaaaaaa/); }
  { const d = fresh(); refused("a dirty tree, in a dry run too", d, /uncommitted changes/, { git: G(COMMIT, true), srcDir: SRC }); }
  { const d = fresh(); refused("an unreadable git state", d, /Could not read the git state/, { git: () => { throw new Error("no git"); }, srcDir: SRC }); }
  // 6. a build made at one commit, deployed after the source moved: the bytes are no longer that commit's source
  { const d = fresh(); const moved = fs.mkdtempSync(path.join(os.tmpdir(), "m27m-")); fs.cpSync(SRC, moved, { recursive: true }); fs.appendFileSync(path.join(moved, "config.js"), "\n// the source moved on\n");
    refused("built bytes that differ from the checked-out source", d, /not the source at the named commit: config\.js/, { git: G(), srcDir: moved }); fs.rmSync(moved, { recursive: true, force: true }); }
});

await run("mobile2027_preview0");
