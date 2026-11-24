// League › Standings (#1503) in the 2027 preview: the recording, the model (seeding from existing code, Option B, contributions and derived slots,
// reconciliation, missing scores, corrections), the screens, and zero network. Offline: committed files only.
//   node tests/mobile2027_standings.test.mjs     (or: node scripts/safe_tests/run.mjs)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..");
const APP = path.join(REPO, "apps", "mobile2027");
const SRC = path.join(APP, "src");
const require = createRequire(import.meta.url);
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const tick = async (n = 12) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };
const ST = require(path.join(SRC, "lib/standings.js"));
const SV = require(path.join(SRC, "lib/standview.js"));
const REC = await import(pathToFileURL(path.join(APP, "scripts/record_standings.mjs")).href);
const BUILD = await import(pathToFileURL(path.join(APP, "scripts/build.mjs")).href);
// the beta's tests run the REVIEWED copies of shared modules (tests/fixtures/mobile2027/shared), so a classic change never breaks them; each copy must equal its pin
const FIXSH = path.join(HERE, "fixtures/mobile2027/shared");
const SHARED3 = ["standings_race.js", "standings_clinch.js", "odds_display.js"];
const sharedText = (f) => fs.readFileSync(path.join(FIXSH, f), "utf8");

function loadRecording() {
  const c = vm.createContext({}); c.window = c;
  vm.runInContext(read("recorded_data.js"), c); vm.runInContext(read("recorded_standings.js"), c);
  return c.UPS2027_RECORDED;
}
const RECD = loadRecording();
function mods() { const c = vm.createContext({}); c.window = c; for (const f of SHARED3) vm.runInContext(sharedText(f), c, { filename: f }); return { race: c.UPS_STANDINGS_RACE, clinch: c.UPS_STANDINGS_CLINCH, odds: c.UPS_ODDS_DISPLAY }; }
const MODS = mods();
const routes = RECD.routes;
const STAND = routes["/api/standings?year=2026"];
const SCHED_RAW = routes["/api/mfl-export?JSON=1&L=74598&TYPE=schedule&YEAR=2026"];
const byWeek = {}; SCHED_RAW.schedule.weeklySchedule.forEach((e) => { byWeek[Number(e.week)] = e.matchup.map((m) => [m.franchise[0].id, m.franchise[1].id]); });
const WEEKS = {}; for (let w = 1; w <= 10; w++) WEEKS[w] = routes["/api/mfl-export?JSON=1&L=74598&TYPE=weeklyResults&W=" + w + "&YEAR=2026"];
const clone = (x) => JSON.parse(JSON.stringify(x));
const input = (over = {}) => Object.assign({ standings: clone(STAND), schedule: { byWeek, raw: SCHED_RAW }, weeks: clone(WEEKS), positions: RECD.static.positions, forecast: RECD.static.forecast, mods: MODS, season: 2026 }, over);
const name = (M, n) => M.fids.find((f) => M.names[f] === n);

test("recording: recorded_standings.js is the generator's exact output from committed files; recorded_data.js is untouched; shared copies equal their pins", async () => {
  t.equal(read("recorded_standings.js"), await REC.build(), "regenerate with node apps/mobile2027/scripts/record_standings.mjs");
  const lock = JSON.parse(fs.readFileSync(path.join(APP, "shared.lock.json"), "utf8"));
  const pinOf = (f) => { const e = (lock.files || lock.shared || lock)[f] || (Array.isArray(lock.files) ? lock.files.find((x) => x.name === f) : null); return e && (e.sha256 || e); };
  for (const f of SHARED3) {
    const sha = crypto.createHash("sha256").update(fs.readFileSync(path.join(FIXSH, f))).digest("hex");
    t.ok(JSON.stringify(lock).includes(sha), f + ": the reviewed copy equals the pinned bytes");
  }
  t.equal(RECD.static.positions.version, "ups-positions-2026-wk10-v1");
  const posText = fs.readFileSync(path.join(REPO, REC.POSITIONS), "utf8");
  t.equal(RECD.static.positions.sha256_16, crypto.createHash("sha256").update(posText).digest("hex").slice(0, 16), "the frozen list's hash prefix");
  t.equal(STAND.generated, "offline", "the standings answer says it was generated offline, not read live");
  t.ok(BUILD.FILES.includes("recorded_standings.js") && BUILD.SHARED.includes("standings_clinch.js") && BUILD.SHARED.includes("odds_display.js"), "the build ships the standings files and the #1521 shared modules by its allowlist");
});

test("seeding comes from the Worker's own ladder: order, seeds and the Hawks/CBP overall-record step", () => {
  const M = ST.build(input());
  t.equal(M.state, "ok"); t.equal(M.through, 10); t.equal(M.lastReg, 14);
  t.deepEqual(M.rows.map((r) => r.playoff_seed), [1, 2, 3, 4, 5, 6, null, null, null, null, null, null]);
  const hawks = M.byFid[name(M, "Hawks")], cbp = M.byFid[name(M, "CBP")];
  t.equal(hawks.playoff_seed, 6); t.equal(cbp.playoff_seed, null);
  t.equal(ST.share(hawks.regular_season.all_play), ST.share(cbp.regular_season.all_play), "level on exact All-Play");
  t.equal(cbp.seed_reason.step, "overall", "the Worker separated CBP from Hawks on overall record (step 2)"); t.equal(cbp.seed_reason.rival_franchise_id, hawks.franchise_id);
  t.equal(M.forecast.fresh, true); t.equal(M.forecast.by[hawks.franchise_id].playoffs, "38%"); t.equal(M.forecast.by[cbp.franchise_id].playoffs, "53%");
  t.equal(M.withheld.any, false, "no unresolved tie in the recorded season");
});

test("contributions reconcile exactly: groups and derived slots equal each team's official total for every team; 18 starters; 13 missing scores never zeroed", () => {
  const M = ST.build(input()), C = M.contrib;
  t.equal(C.state, "ok"); t.deepEqual(C.problems, []);
  t.equal(C.recon.length, 12); C.recon.forEach((r) => t.ok(r.ok, r.fid + " groups " + r.groups + " slots " + r.slots + " team " + r.team));
  t.equal(C.noScore.length, 13, "starters listed with no score");
  let n = 0; for (const f of M.fids) for (let w = 1; w <= 10; w++) { const a = C.audit[f][w]; t.equal(a.list.length, 18); t.equal(a.status, "ok"); t.ok(a.reconciles); n++; }
  t.equal(n, 120);
  // Offense + IDP + K&P = Points For (to the tenth), and MFL's own op/dp split from the committed standings snapshot (op includes K/P)
  const ls = JSON.parse(fs.readFileSync(path.join(REPO, "data/mfl-snapshots/2026-11-17/leagueStandings.json"), "utf8")).leagueStandings.franchise;
  ls.forEach((x) => { const g = C.groups; t.equal(Math.round((g.off[x.id].pts + g.kp[x.id].pts) * 10), Math.round(Number(x.op) * 10), x.id + " op = Offense + K&P"); t.equal(Math.round(g.idp[x.id].pts * 10), Math.round(Number(x.dp) * 10), x.id + " dp = IDP"); });
});

test("derived slot allocation rules, weekly, with a stable tie rule; zero and negative scores count; a missing score adds nothing", () => {
  const R = ST.RULES[2026];
  const base = () => [["QB", 20], ["RB", 10], ["RB", 9], ["WR", 12], ["WR", 11], ["TE", 6], ["PK", 8], ["PN", 4], ["DL", 5], ["DL", 4], ["LB", 7], ["LB", 6], ["DB", 3], ["DB", 2]];
  const mk = (rows) => rows.map((r, i) => ({ id: String(r[2] || 1000 + i), pos: r[0], score: r[1] }));
  // second QB -> SFX; best remaining RB/WR/TE -> OFX1/OFX2; best remaining DL/LB/DB -> DFX
  let a = ST.allocate(mk(base().concat([["QB", 15], ["WR", 8], ["RB", 7], ["LB", 1]])), R);
  t.equal(a.status, "ok"); t.equal(a.slots.SFX.pos, "QB"); t.equal(a.slots.OFX1.score, 8); t.equal(a.slots.OFX2.score, 7); t.equal(a.slots.DFX.pos, "LB");
  // no second QB: the best remaining RB/WR/TE goes to SFX BEFORE OFX
  a = ST.allocate(mk(base().concat([["TE", 14], ["WR", 8], ["RB", 7], ["DB", 1]])), R);
  t.equal(a.slots.TE.score, 14, "the required TE is the highest-scoring TE"); t.equal(a.slots.SFX.score, 8); t.equal(a.slots.SFX.pos, "WR"); t.equal(a.slots.OFX1.score, 7); t.equal(a.slots.OFX2.score, 6);
  // required slots take the highest scorers; equal scores go to the lower MFL id
  a = ST.allocate(mk(base().concat([["TE", 6, "500"], ["WR", 8], ["RB", 7], ["DB", 1]])).map((p) => (p.pos === "TE" && p.score === 6 && p.id !== "500" ? Object.assign(p, { id: "900" }) : p)), R);
  t.equal(a.slots.TE.id, "500", "tie at TE: lower id is the required TE"); t.equal(a.slots.OFX2.id, "900", "the other 6.0 TE goes to flex after the higher scorers");
  // zero and negative are scores; a missing score sorts after every scored starter and adds nothing
  a = ST.allocate(mk(base().concat([["WR", 0], ["WR", -2], ["RB", null], ["DB", 1]])), R);
  t.equal(a.slots.SFX.score, 0); t.equal(a.slots.OFX1.score, -2); t.equal(a.slots.OFX2.score, null);
  t.equal(Math.round(a.sum * 10), Math.round((20 + 10 + 9 + 12 + 11 + 6 + 8 + 4 + 5 + 4 + 7 + 6 + 3 + 2 + 0 - 2 + 1) * 10));
  // incomplete: a lineup outside the season's rules, or an unknown position, is flagged, never forced
  t.equal(ST.allocate(mk(base().concat([["WR", 3], ["WR", 2], ["RB", 1]])), R).status, "invalid", "17 starters");
  t.equal(ST.allocate(mk(base().concat([["QB", 1], ["QB", 1], ["RB", 1], ["DB", 1]])), R).status, "invalid", "three QBs");
  const u = mk(base().concat([["QB", 15], ["WR", 8], ["RB", 7], ["LB", 1]])); u[3].pos = null;
  t.equal(ST.allocate(u, R).status, "unknown_position");
});

test("Option B: a group level after total Points For that the rules do not order withholds the seeds, tags, cutoff line and Playoff % it spans; a decided pair stays explained", () => {
  // three teams at positions 5-7 made level on All-Play, overall record and Points For
  const s = clone(STAND); const tgt = s.rows[4].regular_season;
  for (const i of [5, 6]) { const rs = s.rows[i].regular_season; rs.all_play = clone(tgt.all_play); rs.record = clone(tgt.record); rs.points_for = tgt.points_for; }
  let M = ST.build(input({ standings: s }));
  t.equal(M.withheld.any, true); t.deepEqual(Object.keys(M.withheld.seeds).sort(), ["5", "6"]); t.equal(M.withheld.cutHidden, true);
  const S = { lg: { sub: "race", open: {} }, lgd: { model: M } };
  const html = SV.body(S);
  t.doesNotMatch(html, /Playoff line/, "the cutoff line the group spans is not drawn");
  t.match(html, /the rules don’t say how to order them/); t.equal((html.match(/rules don’t say/g) || []).length, 1, "explained once");
  M.rows.slice(4, 7).forEach((r) => t.equal(M.withheld.fids[r.franchise_id], true));
  // two level teams that met with a clear record between them: ordered by those games, not withheld
  const two = clone(STAND); const a = two.rows[6], b = two.rows[7];
  b.regular_season.all_play = clone(a.regular_season.all_play); b.regular_season.record = clone(a.regular_season.record); b.regular_season.points_for = a.regular_season.points_for;
  const met = two.weekly.filter((g) => g.fid === a.franchise_id && g.opp === b.franchise_id);
  M = ST.build(input({ standings: two }));
  const aw = met.filter((g) => g.ts > g.os).length, bw = met.length - aw;
  t.equal(M.withheld.groups.length, met.length && aw !== bw ? 0 : 1, met.length + " game(s) between them, " + aw + "-" + bw);
});

test("live mode has no dated position list or forecast: no contributions (never today's positions), Playoff % only where verified", () => {
  const M = ST.build(input({ positions: null, forecast: null }));
  t.equal(M.contrib.state, "unavailable"); t.match(M.contrib.why, /dated, versioned position list/);
  M.fids.forEach((f) => { const v = M.forecast.by[f]; t.ok(v.playoffs === "—" || v.playoffs === "100%" || v.playoffs === "0%", f + " " + v.playoffs); });
  const stale = ST.build(input({ forecast: Object.assign(clone(RECD.static.forecast), { throughWeek: 9 }) }));
  t.equal(stale.forecast.fresh, false); t.match(stale.forecast.why, /Week 9, not Week 10/);
});

test("corrections: a completed week whose lineups no longer add up to the standings is flagged for that week only, and left out of slot totals", () => {
  const w = clone(WEEKS); const f = w[4].weeklyResults.matchup[0].franchise[0]; const p = f.player.find((x) => x.status === "starter" && x.score);
  p.score = String(Number(p.score) + 5);
  const M = ST.build(input({ weeks: w }));
  t.equal(M.contrib.state, "partial"); t.equal(M.contrib.problems.length, 1); t.equal(M.contrib.problems[0].w, 4); t.equal(M.contrib.problems[0].fid, f.id);
  t.equal(M.contrib.recon.find((r) => r.fid === f.id).ok, false, "never forced to look complete");
});

test("screens: one decimal with separators, overall record (never H2H record), All-Play vs H2H, '—' for a missing score, xFP absent", () => {
  const M = ST.build(input());
  const S = { lg: { sub: "race", per: "season", cset: "pts", open: {}, team: null, brk: "pos" }, lgd: { model: M }, intel: { players: null } };
  let h = SV.body(S);
  t.match(h, /Ahead of CBP on overall record/); t.doesNotMatch(h, /H2H record/); t.match(h, /Playoff line/);
  S.lg.sub = "scoring"; h = SV.body(S); t.match(h, /2,732\.0/); t.match(h, /273\.2/);
  S.lg.cset = "grp"; h = SV.body(S); t.match(h, /197\.0<span class="lgsub">#1<\/span>/);
  S.lg.per = "week"; S.lg.wk = 10; h = SV.body(S); t.match(h, /All-Play/); t.match(h, /H2H/);
  const ns = M.contrib.noScore[0]; S.lg.team = ns.fid; S.lg.brk = "pos";
  const pos = ST.GROUP[RECD.static.positions.positions[ns.id]];
  S.lg.open["b:p:" + pos] = true; S.lg.open["b:p:" + pos + ":" + ns.w] = true;
  h = SV.brkSheet(S); t.match(h, /· —<\/span>/, "a missing score shows —"); t.match(h, /isn’t a recorded zero/);
  t.doesNotMatch(SV.body(S) + SV.helpSheet(S) + SV.teamSheet(Object.assign({}, S, { lg: Object.assign({}, S.lg, { team: M.fids[0] }) })), /xFP/);
});

test("every Standings state draws no inline style, script, form field, link or event handler, and only the read-only Standings controls; data text is escaped", () => {
  const M = ST.build(input()); const evil = '"><img src=x onerror=alert(1)><script>x</script>';
  const M2 = ST.build(input()); M2.names[M2.fids[0]] = evil;
  const ALLOWED = ["lgsub", "lgper", "lgset", "lgwk", "lgt", "lgteam", "lgbrk", "lgbv", "lgretry", "help", "close"];
  const open = {}; M.fids.forEach((f) => { open["ct:" + f] = true; open["wg:10:" + f] = true; }); open.rd = true; open.tst = true; open.twk = true;
  ["QB", "RB", "WR", "TE", "DL", "LB", "DB", "PK", "PN"].forEach((p) => { open["b:p:" + p] = true; for (let w = 1; w <= 10; w++) open["b:p:" + p + ":" + w] = true; });
  ST.SLOT_GROUPS.forEach((g) => { open["b:s:" + g[0]] = true; for (let w = 1; w <= 10; w++) open["b:s:" + g[0] + ":" + w] = true; });
  Object.keys(M.divisions).forEach((d) => { open["h2h:" + d] = true; });
  let n = 0;
  for (const model of [M, M2, null, { state: "unavailable", why: "x" }]) for (const sub of ["race", "div", "scoring"]) for (const per of ["season", "week"]) for (const cset of ["pts", "fin", "grp"]) for (const brk of ["pos", "slot"]) {
    const S = { lg: { sub, per, cset, wk: 10, open, team: M.fids[0], brk }, lgd: { model, st: model ? { state: "ok" } : { state: "error", error: evil } }, intel: { players: null } };
    const html = SV.tabs(S) + SV.body(S) + (model && model.state === "ok" ? SV.teamSheet(S) + SV.brkSheet(S) + SV.helpSheet(S) : ""); n++;
    t.doesNotMatch(html, /\sstyle=/i); t.doesNotMatch(html, /<script|<form|<input|<textarea|<select|<iframe|<img/i);
    [...html.matchAll(/<[a-z][^>]*>/gi)].forEach((m) => t.doesNotMatch(m[0].replace(/"[^"]*"/g, '""'), /\son[a-z]+\s*=|\shref=|\ssrc=/i));
    [...html.matchAll(/data-act="([a-z]+)"/g)].forEach((m) => t.ok(ALLOWED.includes(m[1]), "control " + m[1]));
  }
  t.ok(n >= 100, n + " states");
});

// ───────────── the real page in a vm: fetch, XMLHttpRequest and sendBeacon throw ─────────────
const INJURY_PURE = BUILD.derivedBytes(BUILD.DERIVED[0], FIXSH).toString("utf8");
function boot() {
  const net = [];
  const trap = (nm) => (...a) => { net.push(nm + " " + String(a[0])); throw new Error("NETWORK ATTEMPT: " + nm); };
  const listeners = {}, winL = {}, storage = {};
  const appEl = { innerHTML: "", addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); }, contains: () => true, querySelector: () => null, querySelectorAll: () => [] };
  const location = { hash: "", pathname: "/", search: "" };
  const history = { state: null, pushState(s, _t, u) { this.state = s; location.hash = u; }, replaceState() { this.state = null; location.hash = ""; }, back() { this.state = null; location.hash = ""; (winL.popstate || (() => {}))(); } };
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, URL, URLSearchParams, AbortController: undefined,
    document: { getElementById: (id) => (id === "app" ? appEl : null), documentElement: { setAttribute() {} }, activeElement: null, title: "" },
    localStorage: { getItem: (k) => (k in storage ? storage[k] : null), setItem: (k, v) => { storage[k] = String(v); } }, history, location, navigator: { sendBeacon: trap("sendBeacon") } });
  ctx.window = ctx; ctx.fetch = trap("fetch");
  ctx.XMLHttpRequest = function () { net.push("XMLHttpRequest"); throw new Error("NETWORK ATTEMPT"); };
  ctx.matchMedia = () => ({ matches: false, addEventListener() {} }); ctx.addEventListener = (type, fn) => { winL[type] = fn; };
  vm.runInContext(INJURY_PURE, ctx);
  for (const f of SHARED3) vm.runInContext(sharedText(f), ctx, { filename: "shared/" + f });
  const files = ["config.js", "recorded_data.js", "recorded_standings.js", "lib/format.js", "lib/contract.js", "lib/reviewed_names.js", "lib/adjust.js", "lib/model.js", "lib/roster.js", "lib/coverage.js", "lib/data.js", "lib/recorded.js", "lib/photo.js", "lib/sample.js", "lib/clubhist.js", "lib/ranks.js", "lib/complete.js", "lib/boxlog.js", "lib/statranks.js", "lib/tabviews.js", "lib/breakdown.js", "lib/standings.js", "lib/standview.js", "lib/views.js", "app.js"];
  for (const f of files) vm.runInContext(read(f), ctx, { filename: f });
  const click = async (attrs, n = 30) => { const el = { getAttribute: (k) => (k in attrs ? attrs[k] : null) }; (listeners.click || []).forEach((fn) => fn({ target: { closest: () => el } })); await tick(n); };
  return { net, click, html: () => appEl.innerHTML, misses: () => Array.from(ctx.UPS2027.recorded.misses) };
}

test("ZERO NETWORK: League › Standings tapped through every view; nothing unrecorded; Team › Roster still draws", async () => {
  const a = boot(); await tick(80);
  const ok = (where) => { t.deepEqual(a.net, [], where + ": no network attempt"); t.deepEqual(a.misses(), [], where + ": nothing asked that is not recorded"); };
  t.match(a.html(), /Starting lineup · /, "the accepted Team › Roster is unchanged at boot"); ok("boot");
  await a.click({ "data-act": "nav", "data-v": "league" }, 120);
  t.match(a.html(), /Standings/); t.match(a.html(), /Ahead of CBP on overall record/); t.match(a.html(), /through Week 10 of 14/); ok("race");
  const steps = [["lgt", "rd"], ["lgsub", "div"], ["lgsub", "scoring"], ["lgset", "fin"], ["lgset", "grp"], ["lgper", "week"], ["lgwk", "3"]];
  for (const [act, v] of steps) { await a.click({ "data-act": act, "data-v": v }); ok(act + " " + v); }
  t.match(a.html(), /Week 3 · Regular season/);
  await a.click({ "data-act": "lgteam", "data-fid": "0012" }); t.match(a.html(), /Wins expected from All-Play/); ok("team");
  await a.click({ "data-act": "lgbrk", "data-fid": "0012" }); t.match(a.html(), /By lineup slot/); ok("breakdown");
  await a.click({ "data-act": "lgbv", "data-v": "slot" }); t.match(a.html(), /SFX/); ok("slots");
  await a.click({ "data-act": "close" }); await a.click({ "data-act": "help" }); t.match(a.html(), /ups-positions-2026-wk10-v1/); t.match(a.html(), /derived, not recorded owner choices/); ok("help");
  await a.click({ "data-act": "close" }); await a.click({ "data-act": "nav", "data-v": "team" }); t.match(a.html(), /Starting lineup · /, "back on Team, nothing lost"); ok("team again");
});

await run();
