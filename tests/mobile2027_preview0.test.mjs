// UPS 2027 Preview 0: Team roster + Player profile, read-only.
//   node tests/mobile2027_preview0.test.mjs
//
// Offline. The data is a trimmed recording of the public routes (tests/fixtures/mobile2027/public_reads.json); no test
// touches the network, MFL, D1 or Discord. What is proven here:
//   - read-only by construction: the only network code allows 6 GET paths, refuses everything else, and the source holds
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

// The suite's beta tests never read the LIVE classic files in site/shared/: they use reviewed copies (tests/fixtures/mobile2027/shared/),
// so a change made for the classic app can never turn a classic pull request red. apps/mobile2027/scripts/check_shared.mjs is where
// the real files are compared with the beta's pins, and the beta's own build and deploy refuse a module that no longer matches.
const FIXSH = path.join(HERE, "fixtures/mobile2027/shared");
const FIXLOCK = path.join(os.tmpdir(), "m27-fixture-lock-" + process.pid + ".json");
const B0 = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
const S0 = await import(pathToFileURL(path.join(APP, "scripts/deploy_preview.mjs")).href);
fs.writeFileSync(FIXLOCK, JSON.stringify(B0.computeLock(FIXSH), null, 2));
process.on("exit", () => { try { fs.rmSync(FIXLOCK, { force: true }); } catch (e) { /* ignore */ } });
const bld = (o, src, g, sd, lk, op) => B0.build(o, src, g, sd || FIXSH, lk || FIXLOCK, op);
const pln = (argv, f, ctx) => S0.plan(argv, f, Object.assign({ sharedDir: FIXSH, lockPath: FIXLOCK }, ctx));

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
const ALLOWED_ACTS = ["plan", "planpick", "planreset", "planfor", "planforpick", /* F4, Keith 2026-11-26: a bench player's badge opens his slots (plan only) */ "nav", "sub", "view", "grp", "expall", "card", "close", "teams", "pickteam", "about", "skin", "vib", "tog", "ptab", "retry", "retrypen", "sample", "weeks", "pickweek", "gdef", "ctf", "ctl", "cts", "cty", "ctx", "cth", "pfs", "pfx", "pfres", "retryperf", "help", "ctbd", "ctcat", "nsx", "retryns", "bdv", "bdg", "retrybox", "retrylog"];
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
  vm.runInContext(fs.readFileSync(path.join(FIXSH, "cap_math.js"), "utf8"), ctx);
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
test("the request guard: six GET paths (four from Preview 0, two added for Team › Roster), the worker only, export types on a list, no credential-like name", () => {
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

test("the source holds no write verb, credential name or second transport; fetch lives in one file", async () => {
  const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
  const files = ["app.js", "config.js", "lib/format.js", "lib/contract.js", "lib/model.js", "lib/data.js", "lib/recorded.js", "lib/photo.js", "lib/views.js", "lib/boxlog.js", "lib/breakdown.js"];
  const forbidden = [/XMLHttpRequest/, /sendBeacon/, /WebSocket/, /EventSource/, /document\.cookie/, /indexedDB/, /serviceWorker/, /importScripts/, /\beval\s*\(/, /new Function/,
    /\bPOST\b/, /\bPUT\b/, /\bDELETE\b/, /\bPATCH\b/, /MFL_USER_ID\s*[=:]/, /APIKEY\s*[=:]/i, /Authorization/, /method:\s*["'](?!GET)/];
  files.forEach((f) => { const s = read(f); forbidden.forEach((re) => t.doesNotMatch(s, re, f + " must not match " + re)); });
  files.forEach((f) => t.doesNotMatch(B.stripComments(read(f)).replace(/window\.fetch\(url, opts\)/, ""), /(^|[^A-Za-z0-9_$])fetch\b/, f + " does not name fetch itself"));
  t.match(read("app.js"), /window\.fetch\(url, opts\)/); // the one fetch, inside guardedFetch
  t.match(read("app.js"), /createLoader\(cfg, guardedFetch\)/); // the loader is handed only the guarded one
  t.match(read("app.js"), /if \(S\.sample\.on\) return Promise\.reject/, "and the guarded one refuses while Sample mode is on");
  files.filter((f) => f !== "app.js").forEach((f) => t.doesNotMatch(read(f), /localStorage|sessionStorage/, f + " does not store anything"));
  t.deepEqual([...read("app.js").matchAll(/setPref\("([a-z]+)"/g)].map((m) => m[1]).sort().filter((x, i, a) => a.indexOf(x) === i), ["skin", "team", "vib"]); // two display choices and the last team viewed (R6 retired the "Bench groups" choice)
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
  t.match(html, /Starting lineup · /); t.match(html, /Blake Bombers/); t.match(html, /Active \d+ of 30/); t.match(html, /Taxi \d+ of 10/); t.match(html, /IR \d+ of 15/);
  t.ok(html.indexOf("Starting lineup · ") < html.indexOf("Bench ·"), "starters above bench");
  t.ok(html.indexOf("Bench ·") < html.indexOf("Injured reserve"), "bench above reserve");
  const acts = [...html.matchAll(/data-act="([a-z]+)"/g)].map((m) => m[1]);
  acts.forEach((a) => t.ok(ALLOWED_ACTS.includes(a), "allowed control: " + a));
  t.doesNotMatch(html, /\b(Swap|Start in lineup|Drop|Extend|Restructure|Submit|Save|Bid|Propose|Accept|Reject)\b/, "no transaction wording on the roster screen");
  t.equal((html.match(/<form/g) || []).length, 0); t.equal((html.match(/<input|<textarea|<select/g) || []).length, 0);
  t.doesNotMatch(html, /\sstyle=/); t.doesNotMatch(html, /\son[a-z]+=/i); t.doesNotMatch(html, /<script/i);
  // R6: the Bench, Injured reserve and Taxi squad cards are open by default; collapsing them lists fewer players
  const shut = V.app(state({ open: { bench: false, ir: false, taxi: false } }));
  t.ok((shut.match(/data-act="card"/g) || []).length < (html.match(/data-act="card"/g) || []).length, "collapsing the section cards lists fewer players");
});

test("Team › Contracts shows recorded salary and years; a missing salary is 'n/r' in the table and 'Not recorded' in its row, never $0", () => {
  const S = state({ sub: "contracts" });
  const html = V.app(S);
  t.match(html, /\$\d+(\.\d+)?K/); t.match(html, /Expires 20\d\d/);
  const S2 = state({ sub: "contracts" }); const p = M.starters(S2.model.teams.find((x) => x.id === "0010"))[0]; p.salary = null;
  t.match(V.app(S2), /<span class="wn">n\/r<\/span>/);
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
    // the player's row on Team › Contracts (opened) and the profile's salary tile and current-year cell
    const roster = V.app(state({ model, teamId: p.franchiseId, sub: "contracts", ct: { f: "all", s: "end", open: { [target.id]: true } } }));
    const at = roster.indexOf('data-act="ctx" data-v="' + target.id + '"'); t.ok(at > 0, name + ": the player is on the Contracts table");
    const mine = roster.slice(at), nextRow = mine.indexOf('<div class="rw">');
    const row = nextRow > 0 ? mine.slice(0, nextRow) : mine;
    t.match(row, /<span class="wn">n\/r<\/span>/, name + ": the table cell says n/r (no amount recorded)");
    t.match(row, /<span class="wn">Not recorded<\/span>/, name + ": the opened row says Not recorded for this season");
    t.doesNotMatch(row, /\$0(?![,\d])/, name + ": the row is not $0");
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
  t.match(html, /Lineup not available/); t.doesNotMatch(html, /Starting lineup · /);
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
  t.match(opened, /Total value<\/b><span>\$70,000/); t.match(opened, /Guarantee<\/b><span>\$52,500<small>\$14,588 earned through Week 10<\/small>/); t.match(opened, /AAV<\/b><span>2026–2027 · \$30K<\/span>/, "R9: the recorded AAV labeled by its years");
  t.match(opened, /\$14,000 from played years \+ \$588 this season/); t.match(opened, /Cut charge<\/b><span><b>\$37,912<\/b><small>Guarantee rule: the guaranteed amount not yet earned\.<\/small>/);
  t.doesNotMatch(opened, /minus earned|Remaining guarantee|Vet-FAA|Rookie-Draft|>Type</, "R8: no arithmetic under If cut now, no duplicate guarantee, no internal type code");
  t.doesNotMatch(opened, /CL 3\| TCV 70K/); t.match(opened, /Nothing can be cut from here/);
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
  t.match(none, /The UPS cap calculation is not available/);
});

test("the worker's own zero is shown as $0 (exempt cut), and the earned rules read as the Front Office words them", () => {
  const ex = Object.entries(FX.cap_penalty.players).find(([id, r]) => r.exempt && r.penalty === 0 && !r.needs_review);
  const html = V.app(state({ profile: { pid: ex[0], tab: "contract" }, flags: { cut: true } }));
  t.match(html, /<b>\$0<\/b>/); const rw = C.cutRule(ex[1]); t.notEqual(rw.rule, "unknown", "the fixture's exempt basis is a known rule"); t.ok(html.includes(rw.words.replace(/’/g, "’")), "R8: the rule sentence, not the worker's exempt text");
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
  t.match(V.app(state({ profile: { pid: tx.id, tab: "perf" } })), /Breakdown/);   // R6: the profile's Performance tab is the Breakdown
  const miss = V.app(state({ profile: { pid: "99999999", tab: "contract" } }));
  t.match(miss, /Player not found/);
  ["home", "market", "league"].forEach((id) => t.match(V.app(state({ tab: id })), /not in Preview 0/i));
  t.match(V.app(state({ sub: "contracts" })), /Cap space · 2026 season/); t.doesNotMatch(V.app(state({ sub: "contracts" })), /gotoview/);
  const cap = V.app(state({ sub: "cap" })); t.match(cap, /Not in this preview\. Cap space is left out on purpose/); t.doesNotMatch(cap, /data-act="(?!nav|sub|about)/, "nothing on Cap & picks links anywhere");
});

test("data text is escaped everywhere it is drawn", () => {
  const S = state({ profile: null });
  const team = S.model.teams.find((x) => x.id === "0010");
  const evil = '"><img src=x onerror=alert(1)><script>alert(1)</script>';
  team.name = evil; team.icon = evil;
  const p = team.players[0]; p.name = evil; p.type = evil; p.nflTeam = evil; p.special = evil; p.acquisition = evil; p.franchiseName = evil;
  S.model.byId[p.id] = p;
  const checks = [V.app(S), V.app({ ...S, sub: "contracts", ct: { f: "all", s: "end", open: { [p.id]: true } } }), V.app({ ...S, profile: { pid: p.id, tab: "contract" }, flags: { rules: true, raw: true, earned: true, cut: true } }), V.app({ ...S, profile: { pid: p.id, tab: "more" } }), V.app({ ...S, sheet: "teams" })];
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
  ["roster", "contracts", "performance", "cap"].forEach((sub) => ["lineup", "byes"].forEach((view) => states.push(state({ sub, view, open }))));
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
  t.doesNotMatch(html, /team colors \(not approved\)/, "the old copy is gone: team colors and the Helmet TBD placeholder are in the preview"); t.match(html, /Return dates for injured players/); t.match(html, /a labeled placeholder is shown/); t.match(html, /you are not signed in as anyone/);
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
  // an image whose screen was redrawn (no longer in the page) stops walking the chain: no further address is requested for it
  const img5 = mk(); P.attach(img5, P.chain("1", "2"), null); const first = img5.src; img5.isConnected = false; img5.handlers.error(); t.equal(img5.src, first, "a detached image does not move on to the next address");
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
  t.equal((html.match(/class="hm ph"/g) || []).length, 1, "one helmet placeholder");
  t.match(hero, /<div class="pfw"><div class="av2"[\s\S]*?<\/div><div class="hm ph" role="img" aria-label="Team helmet placeholder: verified team art is not available"><span>Helmet<\/span><span>TBD<\/span><\/div><\/div>/, "the labeled placeholder sits on the photo, as the demo draws it");
  t.doesNotMatch(hero, /helmet[^"'<>]*\.(png|jpe?g|svg|webp|gif)|<svg|<canvas|url\(/i, "no helmet art is drawn or implied");
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
  // the header is the prototype's shape (measured against the prototype in a real browser: within half a pixel at 320 and 375 px):
  // a small outlined Close tag in the top row (inside a 44 px button), no franchise line, the common NFL abbreviation
  t.match(hero, /<div class="top"><span class="hlb">Player profile<\/span><button class="hx" data-act="close" aria-label="Close player profile"><span>Close<\/span><\/button><\/div>/, "the top row is the label and the small Close tag");
  t.match(read("styles.css"), /\.hero \.hx\{[^}]*min-height:44px/, "the Close button around the tag is still a 44 px tap target");
  const fname = model().byId[p.id].franchiseName;
  t.ok(fname && !hero.includes(fname), "the header has no franchise line (the owner is on the More tab)");
  t.match(V.app(state({ profile: { pid: p.id, tab: "more" } })), new RegExp("Team</b><span>" + fname.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const hsubOf = (nfl) => { const m = model(); m.byId[p.id].nflTeam = nfl; return V.app(state({ model: m, profile: { pid: p.id, tab: "contract" } })).match(/<div class="hsub"><b>([^<]*)<\/b>/)[1]; };
  t.deepEqual(["KCC", "GBP", "SFO", "NOS", "NEP", "TBB", "LVR", "JAC", "WSH", "BUF", "FA", "kcc"].map(hsubOf), ["KC", "GB", "SF", "NO", "NE", "TB", "LV", "JAX", "WAS", "BUF", "FA", "KC"], "the header prints the common abbreviation, as the prototype does");
  t.equal(hsubOf(""), "No NFL team"); t.equal(hsubOf(null), "No NFL team");
  t.match(V.app(state()), /<small>[^<]*(SFO|KCC|GBP|NOS)/, "the roster rows still print MFL's code");
  // team colors are drawn only for the profile; the roster rows are not recolored
  t.doesNotMatch(V.app(state()), /class="hero/);
});

// ───────────────────────── 8. build and deploy guards ─────────────────────────
const COMMIT = "a".repeat(40), OTHER = "b".repeat(40);
const G = (commit = COMMIT, dirty = false) => () => ({ commit, dirty }); // a stand-in for the repository's state
test("the build copies exactly the allowlist, is repeatable, and refuses extras and secrets", async () => {
  const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
  const out1 = fs.mkdtempSync(path.join(os.tmpdir(), "m27a-")), out2 = fs.mkdtempSync(path.join(os.tmpdir(), "m27b-"));
  const r1 = bld(out1, SRC, G()), r2 = bld(out2, SRC, G());
  t.ok(r1.ok && r2.ok); t.equal(r1.digest, r2.digest, "the same sources give the same artifact digest");
  const listed = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else listed.push(path.relative(out1, p).split(path.sep).join("/")); } })(out1);
  t.deepEqual(listed.sort(), B.ALL_PATHS.concat(["build-manifest.json"]).sort());
  B.FILES.forEach((f) => t.equal(fs.readFileSync(path.join(out1, f), "utf8"), read(f), f + " is byte for byte the reviewed source"));
  B.SHARED.forEach((n) => t.equal(fs.readFileSync(path.join(out1, "shared", n), "utf8"), fs.readFileSync(path.join(FIXSH, n), "utf8"), "shared/" + n + " is byte for byte the file in site/shared/"));
  t.equal(r1.manifest.mode, "preview", "the manifest names the build mode");
  const hits = B.scan("x.js", "var a = 'APIKEY=abc123'; mfl_user_id: x");
  t.equal(hits.length, 2); t.ok(hits.some((h) => /MFL session id/.test(h)) && hits.some((h) => /API key/.test(h)));
  t.ok(B.scan("x", "contact me at someone@example.com").length === 1);
  t.ok(B.scan("x", "Authorization: Bearer abcdefghijklmnop1234").length >= 1);
  t.ok(B.scan("x", "ups_bs_ABCDEFGHIJKLMNOP").length === 1);
  t.equal(B.FILES.filter((f) => B.scan(f, read(f)).length).length, 0, "the real sources are clean");
  t.equal(B.SHARED.filter((n) => B.scan(n, fs.readFileSync(path.join(FIXSH, n), "utf8")).length).length, 0, "the shared modules are clean");
  fs.rmSync(out1, { recursive: true, force: true }); fs.rmSync(out2, { recursive: true, force: true });
  // a copy of the sources, damaged on purpose: the build must refuse each damage and write nothing
  const mkSrc = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "m27s-")); fs.cpSync(SRC, d, { recursive: true }); return d; };
  const outDir = path.join(os.tmpdir(), "m27-should-not-exist-" + process.pid);
  const clean = mkSrc(); t.ok(bld(outDir, clean, G()).ok, "an undamaged copy builds"); fs.rmSync(outDir, { recursive: true, force: true });
  const withSecret = mkSrc(); fs.appendFileSync(path.join(withSecret, "app.js"), '\nvar k = "APIKEY=abc123";\n');
  const rs = bld(outDir, withSecret, G()); t.equal(rs.ok, false); t.match(rs.problems.join(" "), /app\.js: looks like an API key/); t.equal(fs.existsSync(outDir), false, "nothing written");
  const withExtra = mkSrc(); fs.writeFileSync(path.join(withExtra, "lib", "extra.js"), "var x = 1;");
  const re = bld(outDir, withExtra, G()); t.equal(re.ok, false); t.match(re.problems.join(" "), /lib\/extra\.js/); t.equal(fs.existsSync(outDir), false);
  const withMissing = mkSrc(); fs.rmSync(path.join(withMissing, "lib", "photo.js"));
  const rm = bld(outDir, withMissing, G()); t.equal(rm.ok, false); t.match(rm.problems.join(" "), /missing from src\/: lib\/photo\.js/); t.equal(fs.existsSync(outDir), false);
  // the source commit: recorded in the manifest; a dirty tree, a malformed commit or an unreadable git state is refused and writes nothing
  const ok = bld(outDir, clean, G(OTHER)); t.ok(ok.ok); t.deepEqual(ok.manifest.source, { commit: OTHER }, "the manifest names the commit it was built at");
  t.deepEqual(JSON.parse(fs.readFileSync(path.join(outDir, "build-manifest.json"), "utf8")).source, { commit: OTHER }); fs.rmSync(outDir, { recursive: true, force: true });
  const rd = bld(outDir, clean, G(COMMIT, true)); t.equal(rd.ok, false); t.match(rd.problems.join(" "), /uncommitted changes/); t.equal(fs.existsSync(outDir), false, "a dirty tree writes nothing");
  const rb = bld(outDir, clean, G("main")); t.equal(rb.ok, false); t.match(rb.problems.join(" "), /40-character/); t.equal(fs.existsSync(outDir), false);
  const rx = bld(outDir, clean, () => { throw new Error("not a git repository"); }); t.equal(rx.ok, false); t.match(rx.problems.join(" "), /git state/); t.equal(fs.existsSync(outDir), false);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m27d-")); bld(dir, SRC, G());
  const ctx = { git: G(), srcDir: SRC };
  const plan = (a, c = ctx) => pln(a, fs, c);
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
  const fresh = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "m27t-")); t.ok(bld(d, SRC, G()).ok); return d; };
  const mf = (d) => JSON.parse(fs.readFileSync(path.join(d, "build-manifest.json"), "utf8"));
  const save = (d, m) => fs.writeFileSync(path.join(d, "build-manifest.json"), JSON.stringify(m, null, 2) + "\n");
  const rehash = (m) => { m.digest = B.digestOf(m.files); return m; }; // a careful forger keeps the digest consistent with the list
  const refused = (name, d, re, c = ctx) => { t.throws(() => pln([d], fs, c), re, name); t.throws(() => pln([d, "--execute"], fs, c), re, name + " (with --execute)"); fs.rmSync(d, { recursive: true, force: true }); };

  { const d = fresh(); t.equal(pln([d], fs, ctx).digest, mf(d).digest, "an untouched build passes and reports its digest"); t.equal(B.digestOf(mf(d).files), mf(d).digest, "the digest is the canonical one"); fs.rmSync(d, { recursive: true, force: true }); }

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
  // 3b. the deploy runs the scans again on the files it will publish, so a manifest rewritten to match cannot carry write code
  const rewrite = (d, rel, edit) => { const f = path.join(d, rel); fs.writeFileSync(f, edit(fs.readFileSync(f, "utf8"))); const m = mf(d); const e = m.files.find((x) => x.path === rel); const buf = fs.readFileSync(f); e.bytes = buf.length; e.sha256 = sha(buf); save(d, rehash(m)); };
  { const d = fresh(); rewrite(d, "app.js", (x) => x + '\nfetch("/x", { method: "POST" });\n'); refused("write code in a built script, manifest rewritten to match", d, /fails the Preview scan: app\.js/); }
  { const d = fresh(); rewrite(d, "index.html", (x) => x.replace("connect-src https://upsmflproduction.keith-creelman.workers.dev", "connect-src *")); refused("a widened content policy, manifest rewritten to match", d, /fails the Preview scan: index\.html: page: the content policy is not the reviewed one/); }
  { const d = fresh(); rewrite(d, "_headers", (x) => x + "\n  Access-Control-Allow-Origin: *\n"); refused("an unreviewed response header, manifest rewritten to match", d, /fails the Preview scan: _headers/); }
  { const d = fresh(); rewrite(d, "styles.css", (x) => x + "\n@import url(https://evil.example/x.css);\n"); refused("a remote style import, manifest rewritten to match", d, /fails the Preview scan: styles\.css/); }
  // 4b. the build mode and the shared modules
  { const d = fresh(); const m = mf(d); m.mode = "test"; save(d, m); refused("another build mode", d, /mode is not "preview"/); }
  { const d = fresh(); const m = mf(d); delete m.mode; save(d, m); refused("no build mode", d, /exactly these fields/); }
  { const d = fresh(); const f = path.join(d, "shared/taxi_rule.js"); fs.appendFileSync(f, "\n// edited after the build\n"); const m = mf(d); const e = m.files.find((x) => x.path === "shared/taxi_rule.js"); const buf = fs.readFileSync(f); e.bytes = buf.length; e.sha256 = sha(buf); save(d, rehash(m));
    refused("a shared module changed with a fully rewritten manifest", d, /not the pinned, reviewed one: shared\/taxi_rule\.js/); }
  { const d = fresh(); const moved = fs.mkdtempSync(path.join(os.tmpdir(), "m27h-")); fs.cpSync(FIXSH, moved, { recursive: true }); fs.appendFileSync(path.join(moved, "contract_windows.js"), "\n// the shared file moved on\n");
    refused("a shared module that moved on after the build", d, /not the source at the named commit: shared\/contract_windows\.js/, { git: G(), srcDir: SRC, sharedDir: moved }); fs.rmSync(moved, { recursive: true, force: true }); }
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


// ───────────────────────── 9. R1: build target, shared modules, write-code scan ─────────────────────────
test("the build target: config.js names the mode, the build only makes 'preview', and a different mode is refused", async () => {
  const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
  t.equal(B.MODE, "preview"); t.match(read("config.js"), /\bmode:\s*"preview"/);
  const mkSrc = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "m27c-")); fs.cpSync(SRC, d, { recursive: true }); return d; };
  const outDir = path.join(os.tmpdir(), "m27-mode-" + process.pid);
  const wrong = mkSrc(); fs.writeFileSync(path.join(wrong, "config.js"), read("config.js").replace('mode: "preview"', 'mode: "test"'));
  const r = bld(outDir, wrong, G()); t.equal(r.ok, false); t.match(r.problems.join(" "), /mode "test", but this build only makes "preview"/); t.equal(fs.existsSync(outDir), false, "nothing written");
  const none = mkSrc(); fs.writeFileSync(path.join(none, "config.js"), read("config.js").replace(/,\s*\n\s*mode:[^\n]*/, ""));
  const r2 = bld(outDir, none, G()); t.equal(r2.ok, false); t.match(r2.problems.join(" "), /does not name a build mode/);
  [wrong, none].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
  // a dev build: a local working copy that may be made on a dirty tree, marked dev, and refused by the deploy script
  const S = await import(pathToFileURL(path.join(APP, "scripts/deploy_preview.mjs")).href);
  t.equal(bld(outDir, SRC, G(COMMIT, true)).ok, false, "a normal build refuses a dirty tree");
  const dev = bld(outDir, SRC, G(COMMIT, true), FIXSH, FIXLOCK, { dev: true }); t.ok(dev.ok); t.equal(dev.manifest.dev, true);
  t.ok(fs.existsSync(path.join(outDir, "shared", "taxi_rule.js")), "the working copy has its shared files next to the page");
  t.throws(() => pln([outDir], fs, { git: G(), srcDir: SRC }), /exactly these fields/, "the deploy script does not accept a dev build");
  t.equal(bld(outDir, SRC, G(COMMIT, false), FIXSH, FIXLOCK, { dev: false }).manifest.dev, undefined, "a normal build carries no dev mark"); fs.rmSync(outDir, { recursive: true, force: true });
});

test("shared modules: taken byte for byte, pinned by SHA-256, loadable in the page, and a changed one stops the build until it is re-pinned", async () => {
  const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
  const { createHash } = await import("node:crypto");
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  t.deepEqual(B.SHARED, ["contract_windows.js", "taxi_rule.js"], "the first intake is exactly the two pure modules the next stages need");
  // the committed lock is well formed (whether it matches the LIVE classic files is check_shared.mjs's job, not the suite's)
  const committed = B.readLock(); t.ok(committed && committed.files);
  t.deepEqual(Object.keys(committed.files).sort(), B.SHARED.slice().sort(), "the committed lock pins exactly the shared list");
  B.SHARED.forEach((n) => t.match(committed.files[n], /^[0-9a-f]{64}$/, n + " has a SHA-256 pin"));
  // the build logic is exercised on the reviewed copies in tests/fixtures/mobile2027/shared/
  const lock = B.readLock(FIXLOCK); t.ok(lock && lock.files);
  B.SHARED.forEach((n) => t.equal(lock.files[n], sha(fs.readFileSync(path.join(FIXSH, n))), n + ": the fixture lock pins the fixture bytes"));
  t.deepEqual(B.computeLock(FIXSH).files, lock.files, "the pins are exactly what the lock command writes");
  // each module loads as a plain script, attaches its one global, and makes no request while loading
  const calls = []; const sandbox = { fetch: (...a) => { calls.push(a); }, XMLHttpRequest: function () { calls.push("xhr"); } };
  sandbox.window = sandbox; vm.createContext(sandbox);
  B.SHARED.forEach((n) => vm.runInContext(fs.readFileSync(path.join(FIXSH, n), "utf8"), sandbox, { filename: n }));
  t.ok(sandbox.UPS_CONTRACT_WINDOWS && typeof sandbox.UPS_CONTRACT_WINDOWS === "object", "contract windows attach UPS_CONTRACT_WINDOWS");
  t.ok(sandbox.UPS_TAXI_RULE && typeof sandbox.UPS_TAXI_RULE === "object", "the taxi rule attaches UPS_TAXI_RULE");
  t.equal(calls.length, 0, "loading them makes no request");
  // the page loads them, before the app's own files
  const scripts = [...read("index.html").matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
  B.SHARED.forEach((n) => t.ok(scripts.includes("shared/" + n), n + " is loaded by the page"));
  t.ok(scripts.indexOf("shared/contract_windows.js") > scripts.indexOf("config.js") && scripts.indexOf("shared/taxi_rule.js") < scripts.indexOf("lib/format.js"), "after the configuration, before the app's own files");
  t.ok(scripts.includes("lib/sample.js"));
  // a shared file edited for the classic app stops the build until someone re-pins it
  const sharedCopy = fs.mkdtempSync(path.join(os.tmpdir(), "m27sh-")); fs.cpSync(FIXSH, sharedCopy, { recursive: true });
  const outDir = path.join(os.tmpdir(), "m27-shared-" + process.pid);
  t.ok(bld(outDir, SRC, G(), sharedCopy).ok, "the unchanged copy builds"); fs.rmSync(outDir, { recursive: true, force: true });
  fs.appendFileSync(path.join(sharedCopy, "taxi_rule.js"), "\n// changed for the classic app\n");
  const r = bld(outDir, SRC, G(), sharedCopy); t.equal(r.ok, false); t.match(r.problems.join(" "), /shared module changed since it was pinned: site\/shared\/taxi_rule\.js/); t.equal(fs.existsSync(outDir), false);
  fs.rmSync(path.join(sharedCopy, "contract_windows.js")); const r2 = bld(outDir, SRC, G(), sharedCopy); t.equal(r2.ok, false); t.match(r2.problems.join(" "), /missing shared module: site\/shared\/contract_windows\.js/);
  const noLock = bld(outDir, SRC, G(), FIXSH, path.join(os.tmpdir(), "no-such-lock.json")); t.equal(noLock.ok, false); t.match(noLock.problems.join(" "), /shared\.lock\.json is missing/);
  const extraPin = path.join(os.tmpdir(), "m27-lock-" + process.pid + ".json"); fs.writeFileSync(extraPin, JSON.stringify({ files: { ...lock.files, "injury_status.js": "0".repeat(64) } }));
  const r3 = bld(outDir, SRC, G(), FIXSH, extraPin); t.equal(r3.ok, false); t.match(r3.problems.join(" "), /pins a module that is not on the SHARED list: injury_status\.js/);
  fs.rmSync(sharedCopy, { recursive: true, force: true }); fs.rmSync(extraPin, { force: true });
  // why two shared modules are NOT taken: the scan refuses them on the real files
  const real = (n) => fs.readFileSync(path.join(FIXSH, n), "utf8");
  t.ok(B.scanWriteCode("shared/injury_status.js", real("injury_status.js")).some((h) => /reference to fetch/.test(h)), "injury_status.js carries a loader that calls fetch, so the Preview scan refuses it");
  t.ok(B.scanWriteCode("shared/cap_math.js", real("cap_math.js")).some((h) => /reference to fetch/.test(h)), "cap_math.js calls the worker itself, so the Preview scan refuses it");
});

test("the Preview write-code scan: what it refuses, what it allows, and that the built tree is clean", async () => {
  const B = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
  const hit = (name, code, re) => t.ok(B.scanWriteCode(name, code).some((h) => re.test(h)), `${name}: ${code.slice(0, 50)} is refused`);
  const clean = (name, code) => t.deepEqual(B.scanWriteCode(name, code), [], `${name}: ${code.slice(0, 50)} is allowed`);
  hit("lib/x.js", 'fetch(u, { method: "POST" })', /write verb|method other than/);
  hit("lib/x.js", 'var o = { method: "GET" }; o.method = "DELETE";', /write verb|method other than/);
  hit("lib/x.js", "var o = { method: m };", /method other than/);
  hit("lib/x.js", 'var o = { credentials: "include" };', /credentials other than omit/);
  hit("lib/x.js", "var f = new FormData();", /FormData/);
  hit("lib/x.js", 'navigator.sendBeacon("/x", b);', /sendBeacon/);
  hit("lib/x.js", "var x = new XMLHttpRequest();", /XMLHttpRequest/);
  hit("lib/x.js", 'new WebSocket("wss://x")', /WebSocket/);
  hit("lib/x.js", "eval(code)", /eval/);
  hit("lib/views.js", "window.fetch(url)", /reference to fetch/);
  hit("lib/views.js", "var go = fetch;", /reference to fetch/);
  hit("lib/submit_lineup.js", "var a = 1;", /file name says it writes/);
  hit("lib/save.js", "var a = 1;", /file name says it writes/);
  hit("lib/data.js", "fetch(u)", /reference to fetch/);
  hit("lib/x.js", "var f = window.fetch.bind(window);", /reference to fetch/);
  hit("app.js", "var f = window.fetch.bind(window);", /reference to fetch/);
  clean("lib/data.js", 'fetchImpl(url, { method: "GET", credentials: "omit" });');
  clean("app.js", "function guardedFetch(url, opts) {\n  return window.fetch(url, opts);\n}");
  // what the independent review tried, and the scan now refuses
  hit("lib/x.js", 'var s = "//"; fetch(u);', /reference to fetch/); // a // inside a string no longer hides the rest of the line
  hit("lib/x.js", 'var s = "/*"; fetch(u); var t = "*/";', /reference to fetch/);
  hit("lib/x.js", 'var a = "x"; /* c */ eval(a);', /eval/);
  hit("lib/x.js", "(0, eval)(c)", /eval/);
  hit("lib/x.js", 'window["fe" + "tch"](u)', /computed access to the global object/);
  hit("lib/x.js", 'self["fetch"](u)', /computed access to the global object/);
  hit("lib/x.js", "globalThis.fetch(u)", /reference to fetch/);
  hit("lib/x.js", "var f = Function('return 1'); f()", /Function constructor/);
  hit("lib/x.js", "new Image().src = u", /can load or send/);
  hit("lib/x.js", "new Request(u)", /can load or send/);
  hit("lib/x.js", "img.src = u", /loading property/);
  hit("lib/x.js", "a.href = u", /loading property/);
  hit("lib/x.js", 'el.setAttribute("src", u)', /loading attribute/);
  hit("lib/x.js", 'document.createElement("script")', /document write, create or cookie/);
  hit("lib/x.js", "document.write(x)", /document write, create or cookie/);
  hit("lib/x.js", "location.href = u", /navigating/);
  hit("lib/x.js", "location = u", /navigating/);
  hit("lib/x.js", "location.assign(u)", /navigating/);
  hit("lib/x.js", "window.open(u)", /window\.open/);
  hit("lib/x.js", "navigator.sendBeacon(u)", /sendBeacon|navigator/);
  hit("lib/x.js", 'var n = "\\u0066etch"; ', /escaped ASCII/);
  hit("lib/x.js", "var s = `x`;", /template literal/);
  hit("lib/x.js", "import('x.js')", /dynamic import/);
  hit("lib/x.js", "postMessage(x)", /postMessage/);
  hit("lib/x.js", 'o["method"] = "PUT";', /write verb/);
  hit("lib/x.js", "o.method = m;", /method other than/);
  hit("lib/x.js", "o.credentials = c;", /credentials other than omit/);
  // images are loaded by assigning src, in one file only (the content policy limits their hosts)
  clean("lib/photo.js", "img.src = urls[i];");
  // pages: a form, a frame, an inline script or handler, a remote script or image, a refresh, or a changed policy
  const page = (extra, csp) => '<!doctype html><meta http-equiv="Content-Security-Policy" content="' + (csp || B.EXPECTED_CSP) + '"><link rel="stylesheet" href="styles.css"><div id="app"></div>' + (extra || "") + '<script src="config.js"></script>';
  clean("index.html", page(""));
  hit("index.html", page('<script>fetch("/x")</script>'), /inline script/);
  hit("index.html", page('<button onclick="go()">x</button>'), /event handler/);
  hit("index.html", page('<form action="/x" method="post"></form>'), /a form/);
  hit("index.html", page('<iframe src="x.html"></iframe>'), /iframe/);
  hit("index.html", page('<img src="x.png">'), /image tag/);
  hit("index.html", page('<script src="https://evil.example/x.js"></script>'), /absolute or protocol-relative/);
  hit("index.html", page('<link rel="stylesheet" href="//evil.example/x.css">'), /absolute or protocol-relative/);
  hit("index.html", page('<meta http-equiv="refresh" content="0;url=x">'), /refresh/);
  hit("index.html", page('<style>a{}</style>'), /inline style/);
  hit("index.html", page('<div style="color:red"></div>'), /inline style/);
  hit("index.html", page("", B.EXPECTED_CSP.replace("connect-src https://upsmflproduction.keith-creelman.workers.dev", "connect-src *")), /content policy is not the reviewed one/);
  hit("index.html", page("", B.EXPECTED_CSP + "; frame-src https://x"), /content policy is not the reviewed one/);
  hit("index.html", '<!doctype html><div id="app"></div><script src="config.js"></script>', /no content policy/);
  // style sheets and the response-header file
  hit("styles.css", "@import 'x.css';", /@import/);
  hit("styles.css", "a{background:url(https://evil.example/x.png)}", /url\(\)/);
  clean("styles.css", "a{color:red} /* url(x) in a comment */");
  clean("_headers", "/*\n  X-Content-Type-Options: nosniff\n  Content-Security-Policy: frame-ancestors 'none'\n  Cache-Control: no-cache\n");
  hit("_headers", "/*\n  Access-Control-Allow-Origin: *\n", /header not on the reviewed list/);
  hit("_headers", "/*\n  Content-Security-Policy: default-src *\n", /header content policy is not the reviewed one/);
  hit("_headers", "/*\n  Link: <https://evil.example/x.js>; rel=preload\n", /header not on the reviewed list/);
  // file names: a whole word between separators, not a substring
  hit("lib/send_lineup.js", "var a = 1;", /file name says it writes/);
  hit("lib/sync.js", "var a = 1;", /file name says it writes/);
  clean("lib/postseason.js", "var a = 1;");
  clean("lib/x.js", '// POST is never used here\n/* method: "DELETE" and credentials: "include" in a comment */ var a = 1;');
  clean("lib/x.js", 'if (e.method !== "GET") n++; var u = "https://a.example/b";');
  clean("lib/photo.js", "var prefetchedImages = 1; // fetchable later");
  clean("styles.css", "body{color:red} /* POST */");
  // the real built tree: every script and page, source and shared, is clean
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "m27w-")); const r = bld(out, SRC, G()); t.ok(r.ok);
  const bad = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else { const rel = path.relative(out, p).split(path.sep).join("/"); if (rel !== "build-manifest.json") bad.push(...B.scanWriteCode(rel, fs.readFileSync(p, "utf8"))); } } })(out);
  t.deepEqual(bad, [], "the built Preview tree contains no write code"); fs.rmSync(out, { recursive: true, force: true });
  // the build refuses damage, and writes nothing
  const mkSrc = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), "m27x-")); fs.cpSync(SRC, d, { recursive: true }); return d; };
  const outDir = path.join(os.tmpdir(), "m27-scan-" + process.pid);
  const withPost = mkSrc(); fs.appendFileSync(path.join(withPost, "lib/views.js"), '\nfetch("/x", { method: "POST" });\n');
  const a = bld(outDir, withPost, G()); t.equal(a.ok, false); t.match(a.problems.join(" "), /lib\/views\.js: write code/); t.equal(fs.existsSync(outDir), false);
  const withSubmit = mkSrc(); fs.writeFileSync(path.join(withSubmit, "lib/submit_drop.js"), "var x = 1;");
  const b = bld(outDir, withSubmit, G()); t.equal(b.ok, false); t.match(b.problems.join(" "), /lib\/submit_drop\.js/);
  [withPost, withSubmit].forEach((d) => fs.rmSync(d, { recursive: true, force: true }));
});

test("Sample mode: client-only, labeled, off at every start, and it keeps the page from making any request", () => {
  const SM = require(path.join(SRC, "lib/sample.js"));
  const s = SM.create(); t.equal(s.on, false, "off at every start"); t.deepEqual(s.scenarios, {});
  t.equal(s.toggle(), true); t.equal(s.toggle(), false);
  t.throws(() => s.register("", {}), /needs an id/); t.throws(() => s.register("a", null), /plain data/); s.register("a", { week: 11 }); t.throws(() => s.register("a", {}), /already registered/);
  t.equal(SM.envText(false), "Preview: view only"); t.match(SM.envText(true), /^Sample data · nothing is real and nothing is sent$/);
  // the screens
  const off = V.app(state()), on = V.app(state({ sample: { on: true } }));
  t.match(off, /<div class="envbar"><span>Preview: view only<\/span>/); t.doesNotMatch(off, /Sample data/);
  t.match(on, /<div class="envbar sample"><span>Sample data · nothing is real and nothing is sent<\/span>/);
  t.match(on, /Nothing here is real, and nothing is sent\./); t.doesNotMatch(on, /Starting lineup · |class="rx"/, "no league data is drawn in Sample mode");
  t.equal((on.match(/data-act="sample"/g) || []).length, 1, "one control, to turn it off"); t.match(on, /data-act="sample" data-v="screen"/);
  const aboutOn = V.app(state({ sheet: "about", sample: { on: true } })); t.match(aboutOn, /data-act="sample" data-v="about"/, "the two Sample buttons are told apart, so focus returns to the right one"); t.doesNotMatch(aboutOn, /Reload the data/, "Reload is hidden while Sample mode is on"); t.match(V.app(state({ sheet: "about" })), /Reload the data/);
  const withProfile = V.app(state({ sample: { on: true }, profile: { pid: allPlayers()[0].id, tab: "contract" } })); t.doesNotMatch(withProfile, /role="dialog"/, "a profile is not drawn in Sample mode");
  // the label shows on every tab, every sheet and every state
  ["team", "home", "market", "league"].forEach((tab) => { t.match(V.app(state({ tab })), /class="envbar"/, tab + " carries the marker"); t.match(V.app(state({ tab, sample: { on: true } })), /class="envbar sample"/, tab + " carries the Sample label"); });
  t.match(V.app(state({ sheet: "about" })), /class="envbar"[\s\S]*Turn Sample mode on/); t.match(V.app(state({ sheet: "about", sample: { on: true } })), /Turn Sample mode off/);
  t.match(V.app(state({ model: null, load: { core: "loading", coreNotes: [] } })), /class="envbar"/); t.match(V.app(state({ model: null, load: { core: "error", coreNotes: [], error: "x" } })), /class="envbar"/);
  // the module itself holds no network or storage code
  const src = read("lib/sample.js"); t.doesNotMatch(src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, ""), /\bfetch\b|XMLHttpRequest|localStorage|sessionStorage|indexedDB|document\.cookie|sendBeacon/);
});

test("the Preview marker and the Sample banner: colors that read in every skin, and the helmet placeholder styled as the demo styles it", () => {
  const css = read("styles.css");
  t.match(css, /\.envbar\{[^}]*min-height:calc\(26px \+ env\(safe-area-inset-top/, "the marker clears the phone's top inset itself");
  t.match(css, /\.hd\{[^}]*padding:0 max\(8px/, "so the header no longer adds the inset a second time (R8: no top padding either, it scrolls under the marker)");
  t.match(css, /\.envbar\.sample\{background:var\(--wn\);color:var\(--on\)/);
  t.match(css, /\.pfw\{position:relative;flex:0 0 auto;width:clamp\(76px,26vw,100px\)\}/);
  t.match(css, /\.hm\.ph\{width:clamp\(52px,16vw,60px\);padding:0;border-style:dashed;border-color:#0b0f18;color:#0b0f18;/, "the dashed placeholder, exactly the demo's rule");
  t.match(css, /\.hm\{position:absolute;right:-6px;bottom:-8px;width:clamp\(46px,15vw,58px\);aspect-ratio:1;border-radius:50%;background:#fff;/);
  // contrast of the two marker states in every skin (4.5:1; 7:1 in High contrast)
  const block = (sel) => { const i = css.indexOf(sel + "{"); if (i < 0) return {}; const body = css.slice(i + sel.length + 1, css.indexOf("}", i)); const o = {}; for (const m of body.matchAll(/(--[a-z0-9]+):([^;]+);?/g)) o[m[1]] = m[2].trim(); return o; };
  const lum = (hex) => { const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
  const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  let n = 0;
  for (const skin of ["light", "dark", "hc"]) for (const vib of [false, true]) {
    const tok = { ...block(":root"), ...block(`:root[data-skin="${skin}"]`), ...(vib ? block(`:root[data-skin="${skin}"][data-vib="1"]`) : {}) };
    const need = skin === "hc" ? 7 : 4.5, tag = skin + (vib ? "+vibrant" : "");
    [["mu", "s2"], ["on", "wn"]].forEach(([a, b]) => { n++; t.ok(ratio(tok["--" + a], tok["--" + b]) >= need, `${tag}: ${a} on ${b} is ${ratio(tok["--" + a], tok["--" + b]).toFixed(2)}:1, needs ${need}`); });
  }
  t.equal(n, 12);
  t.ok(ratio("#0b0f18", "#ffffff") >= 7, "the placeholder's near-black text on white");
});

await run("mobile2027_preview0");
