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

test("seeding comes from the Worker's own ladders: Week 10 Hawks and CBP (both 57-53 All-Play) are separated on total Points For, not overall record", () => {
  // canon §F.1.2 (Keith 2026-11-25): wild cards All-Play % → total Points For → head-to-head. Before the correction the Worker's overall-record
  // step put Hawks (15-12) in at seed 6 over CBP (13-14); CBP scored more (2,097.4 vs 2,026.3), so CBP holds the last wild card.
  const M = ST.build(input());
  t.equal(M.state, "ok"); t.equal(M.through, 10); t.equal(M.lastReg, 14);
  t.deepEqual(M.rows.map((r) => r.playoff_seed), [1, 2, 3, 4, 5, 6, null, null, null, null, null, null]);
  const hawks = M.byFid[name(M, "Hawks")], cbp = M.byFid[name(M, "CBP")];
  t.equal(cbp.playoff_seed, 6); t.equal(cbp.playoff_status, "wild_card"); t.equal(hawks.playoff_seed, null);
  t.equal(ST.share(hawks.regular_season.all_play), ST.share(cbp.regular_season.all_play), "level on exact All-Play");
  const wl = (r) => r.w + "–" + r.l; t.equal(wl(hawks.regular_season.record), "15–12"); t.equal(wl(cbp.regular_season.record), "13–14");
  t.equal(SV.t1(cbp.regular_season.points_for), "2,097.4"); t.equal(SV.t1(hawks.regular_season.points_for), "2,026.3");
  t.equal(hawks.seed_reason.step, "points_for", "the Worker separated them on total Points For"); t.equal(hawks.seed_reason.rival_franchise_id, cbp.franchise_id);
  t.equal(hawks.seed_reason.pool, "outside");
  t.equal(M.why[hawks.franchise_id].text, "Outside the top six — 0 AP wins back; behind CBP (the last wild card) on season Points For.");
  // the forecast is the Week 10 replay under the same rules (its own seeding rule says so)
  t.equal(RECD.static.forecast.model.seedingRule, ST.SEEDING_RULE);
  t.equal(fs.readFileSync(path.join(REPO, "pipelines/etl/wire/season_sim.py"), "utf8").match(/^SEEDING_RULE = "(.*)"$/m)[1], ST.SEEDING_RULE, "the beta and the simulator name the same rule");
  t.equal(M.forecast.fresh, true); t.equal(M.forecast.by[cbp.franchise_id].playoffs, "56%"); t.equal(M.forecast.by[hawks.franchise_id].playoffs, "35%");
  t.equal(M.withheld.any, false, "no unresolved tie in the recorded season"); t.equal(JSON.stringify(STAND.regular_season.unresolved), "[]");
  // the deciding line opens to the wild-card steps: All-Play level, Points For decides, the games between them not needed
  const S = { lg: { sub: "race", open: { ["tie:" + hawks.franchise_id + ":" + cbp.franchise_id]: true } }, lgd: { model: M } }, h = SV.body(S);
  t.match(h, /Behind CBP on total Points For ▾/); t.match(h, /Ahead of Hawks on total Points For/);
  t.match(h, /<td class="t">All-Play<\/td><td>57–53 \(51\.8%\)<\/td><td>57–53 \(51\.8%\)<\/td><td>level<\/td>/);
  t.match(h, /<td class="t">Points For<\/td><td>2,026\.3<\/td><td>2,097\.4<\/td><td><b>decides<\/b><\/td>/);
  t.match(h, /<td class="t">Games between them<\/td><td><\/td><td><\/td><td>not needed<\/td>/);
  t.doesNotMatch(h, /overall record|Overall record/, "overall record is not a seeding step");
  // Help: the byes by All-Play, the pool ladders, and the forecast named as the Week 10 replay under the corrected tiebreakers
  const hs = SV.helpSheet(Object.assign({}, S, { recorded: { label: "Sun Nov 22, 2026, 10:22 AM ET" } }));
  t.match(hs, /Seeds 1–2 are the two division winners with the best All-Play %/);
  t.match(hs, /The two wild cards are the best other teams by All-Play %, then total Points For, then the games between the tied teams\. Seeds 3–6 are the other two division winners and the wild cards, by All-Play %, then total Points For\. Overall record is not a seeding tiebreaker\./);
  t.match(hs, /The forecast is the Week 10 forecast re-run .* on its recorded inputs under the corrected playoff tiebreakers \(2026-11-25\)\./);
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

test("Option B: a tie the Worker reports as unresolved withholds the seeds it affects, the tied teams' tags and Playoff %, and the line it spans", () => {
  const cbp = STAND.rows[5].franchise_id, hawks = STAND.rows[6].franchise_id;
  // the last wild card level through every step the site can apply (the next steps are Power Rank, then a coin flip)
  const s = clone(STAND); s.regular_season.unresolved = [{ pool: "wild_card", franchise_ids: [cbp, hawks], seeds: [6], why: "power_rank_coin_flip" }];
  let M = ST.build(input({ standings: s }));
  t.equal(M.withheld.any, true); t.deepEqual(Object.keys(M.withheld.seeds), ["6"]); t.equal(M.withheld.cutHidden, true); t.equal(M.withheld.byeHidden, false);
  t.equal(M.withheld.pctHeld[cbp], true); t.equal(M.withheld.pctHeld[hawks], true); t.ok(!M.withheld.pctHeld[STAND.rows[0].franchise_id], "others keep their Playoff %");
  let html = SV.body({ lg: { sub: "race", open: {} }, lgd: { model: M } });
  t.doesNotMatch(html, /Playoff line/, "the cutoff line the tie spans is not drawn"); t.match(html, /Bye line/);
  t.match(html, /CBP and Hawks are level on All-Play %, total Points For and the games between them for the last wild card\. No settled tiebreak orders them yet/);
  t.equal((html.match(/No settled tiebreak orders them yet/g) || []).length, 1, "explained once");
  t.doesNotMatch(html, new RegExp('data-fid="' + cbp + '">CBP</button> <span class="lgtag">'), "the tied wild card's tag is withheld");
  t.match(html, /<td class="rk">—<\/td><td class="t"><button class="lgtn" data-act="lgteam" data-fid="[0-9]+">CBP/, "and its seed reads —");
  // division winners level on All-Play for the second bye: seeds 2-6 move with it, and the bye line is not drawn
  const b = clone(STAND); b.regular_season.unresolved = [{ pool: "bye", franchise_ids: [STAND.rows[1].franchise_id, STAND.rows[2].franchise_id], seeds: [2, 3, 4, 5, 6], why: "pending_ruling" }];
  M = ST.build(input({ standings: b }));
  t.deepEqual(Object.keys(M.withheld.seeds).sort(), ["2", "3", "4", "5", "6"]); t.equal(M.withheld.byeHidden, true);
  html = SV.body({ lg: { sub: "race", open: {} }, lgd: { model: M } });
  t.doesNotMatch(html, /Bye line/); t.match(html, /level on All-Play % for a first-round bye/);
  t.equal(ST.unresolvedTies(STAND.rows, STAND.regular_season).length, 0, "the recorded season: none");
});

// ChatGPT's review of #1526 (item 2): the Worker's unresolved list is part of the response contract. f1f531c1 fell back to its own check (equal
// All-Play % AND Points For), so two division winners level on All-Play % with different Points For -- a bye still pending Keith's ruling -- showed
// seeds as settled. Without the list nothing says which seeds are final, so every seed-dependent figure is withheld, for every team.
test("a standings answer without the Worker's unresolved list: no seeds, tags, lines, magic numbers or simulated Playoff % for anyone (the bye case)", () => {
  const n = clone(STAND); delete n.regular_season.unresolved;
  const dw3 = n.rows.find((r) => r.playoff_status === "division_winner" && r.playoff_seed >= 3);
  t.ok(dw3, "the recording has a division winner seeded 3-6");
  dw3.regular_season.all_play = clone(n.rows[1].regular_season.all_play);          // level with seed 2 on All-Play %...
  t.notEqual(dw3.regular_season.points_for, n.rows[1].regular_season.points_for);  // ...with different Points For
  t.equal(ST.unresolvedTies(n.rows, n.regular_season), null, "no list: the answer can't say which ties are open");
  const M = ST.build(input({ standings: n }));
  t.equal(M.withheld.noReport, true);
  t.deepEqual(Object.keys(M.withheld.seeds).sort(), ["1", "2", "3", "4", "5", "6"], "every seed is withheld (the bye decides seeds 2-6)");
  t.equal(M.withheld.byeHidden, true); t.equal(M.withheld.cutHidden, true); t.equal(M.withheld.magicHidden, true);
  M.fids.forEach((f) => { t.equal(M.withheld.fids[f], true, f + ": tag withheld"); t.equal(M.withheld.pctHeld[f], true, f + ": simulated Playoff % withheld"); });
  const html = SV.body({ lg: { sub: "race", open: {} }, lgd: { model: M } });
  t.doesNotMatch(html, /Bye line|Playoff line/, "neither cutoff line is drawn");
  t.match(html, /This standings answer doesn’t list the ties no settled tiebreak decides, so no seeds, tags, cutoff lines, magic numbers or simulated Playoff % are shown for any team\./);
  t.doesNotMatch(html, /<span class="lgtag">(Bye|Division|Wild card)<\/span>/, "no position tag");
  const seedCells = [...html.matchAll(/<td class="rk">([^<]*)<\/td>/g)].map((m) => m[1]);
  M.rows.slice(0, 6).forEach((r, i) => t.equal(seedCells[i], (M.clinch[r.franchise_id] || {}).lock ? String(M.clinch[r.franchise_id].lock) : "—", "position " + (i + 1) + ": only a locked seed shows"));
  // a list, even an empty one, is trusted as the Worker's answer
  t.equal(ST.build(input()).withheld.any, false, "the recorded answer (an empty list): nothing withheld");
  t.equal(ST.build(input()).withheld.noReport, false);
});

test("live mode has no dated position list or forecast: no contributions (never today's positions), Playoff % only where verified", () => {
  const M = ST.build(input({ positions: null, forecast: null }));
  t.equal(M.contrib.state, "unavailable"); t.match(M.contrib.why, /dated, versioned position list/);
  M.fids.forEach((f) => { const v = M.forecast.by[f]; t.ok(v.playoffs === "—" || v.playoffs === "100%" || v.playoffs === "0%", f + " " + v.playoffs); });
  const stale = ST.build(input({ forecast: Object.assign(clone(RECD.static.forecast), { throughWeek: 9 }) }));
  t.equal(stale.forecast.fresh, false); t.match(stale.forecast.why, /Week 9, not Week 10/);
});

// ───────────── MAT-1..MAT-4 (ChatGPT review of ff3dc709). Each fails on ff3dc709's lib files. ─────────────
const BASE = ST.build(input());
function bumpQB(fid, wk, by) {   // ChatGPT's reproduction: +5 to franchise 0003's starting QB in Week 4
  const w = clone(WEEKS); let hit = null;
  for (const m of w[wk].weeklyResults.matchup) for (const f of m.franchise) if (f.id === fid) {
    const p = f.player.find((x) => x.status === "starter" && ST.GROUP[RECD.static.positions.positions[x.id]] === "QB" && x.score);
    p.score = String(Math.round((Number(p.score) + by) * 10) / 10); hit = p.id;
  }
  return { w, hit };
}
test("MAT-1: mismatched points never enter a displayed contribution or slot total, and no rank they would support is shown", () => {
  t.equal(BASE.contrib.groups.off["0003"].rank, 10, "baseline: 0003 is 10th on Offense");
  const { w, hit } = bumpQB("0003", 4, 5); t.ok(hit, "a Week 4 starting QB of 0003");
  const M = ST.build(input({ weeks: w })), C = M.contrib;
  t.equal(C.recon.find((r) => r.fid === "0003").ok, false, "reconciliation fails");
  // the displayed figures first (ff3dc709 fails here: Offense rose by 5.0 and the rank moved 10 -> 9)
  t.equal(C.groups.off["0003"].pts, null, "0003's Offense total is withheld, not " + (BASE.contrib.groups.off["0003"].pts + 5).toFixed(1));
  t.equal(C.groups.off["0003"].rank, null, "and no rank (ff3dc709 showed 9)");
  t.deepEqual(C.quarantined, { "0003": [4] }, "the affected team and week are identified");
  for (const tbl of [C.groups.off, C.groups.idp, C.groups.kp].concat(Object.values(C.byPos), Object.values(C.bySlot))) {
    t.equal(tbl["0003"].pts, null); t.equal(tbl["0003"].pw, null);
    for (const f of M.fids) t.equal(tbl[f].rank, null, "no rank for " + f + " (each would depend on 0003)");
  }
  for (const f of M.fids.filter((x) => x !== "0003")) t.equal(C.groups.off[f].pts, BASE.contrib.groups.off[f].pts, f + ": other teams' supported values unchanged");
  t.doesNotMatch(C.why, /excluded|left out of slot totals/, "the warning does not claim a week was excluded from a total");
  const S = { lg: { sub: "scoring", per: "season", cset: "grp", open: {}, team: "0003", brk: "pos" }, lgd: { model: M }, intel: { players: null } };
  let h = SV.body(S);
  t.doesNotMatch(h, /class="lgrk"/, "no rank is drawn"); t.doesNotMatch(h, new RegExp(BASE.contrib.groups.off["0003"].pts.toFixed(1)), "0003's old total is not drawn");
  S.lg.open["b:p:QB"] = true; S.lg.open["b:p:QB:4"] = true; h = SV.brkSheet(S);
  t.match(h, /Week 4<\/b><span>Not counted: the starters’ points don’t add up/, "the bad week shows no sum and no players' points");
  t.doesNotMatch(h, /Week 4 · /, "no Week 4 sum line");
  t.equal(ST.build(input({ weeks: bumpQB("0003", 4, 0).w })).contrib.state, "ok", "control: an unchanged score reconciles");
});

// the desktop page's own forecastReconcile (#1521), extracted from the HTML and run on the same inputs (parity)
const DESKTOP = fs.readFileSync(path.join(REPO, "site/standings/mfl_hpm_standings_v2.html"), "utf8");
const dsrc = DESKTOP.slice(DESKTOP.indexOf("  function forecastReconcile(sim, resp) {"), DESKTOP.indexOf("  // One display policy for every forecast probability"));
const deskReconcile = new Function("pad4", "rowsByFid", "nameOf", "rec", "SEEDING_RULE", dsrc + "\nreturn forecastReconcile;")(
  (v) => String(v).padStart(4, "0"), (rows) => Object.fromEntries(rows.map((r) => [String(r.franchise_id).padStart(4, "0"), r])), (r) => r.franchise_name, (w, l, t2) => w + "–" + l + (t2 ? "–" + t2 : ""), DESKTOP.match(/var SEEDING_RULE = "([^"]*)"/)[1]);
const deskResp = (st) => Object.assign({}, st, { rows: st.rows.map((r) => Object.assign({}, r, { allplay_w: r.regular_season.all_play.w, allplay_l: r.regular_season.all_play.l, allplay_t: r.regular_season.all_play.t || 0 })) });
test("MAT-2: a same-week forecast is shown only when it starts from these standings (teams, All-Play records, the week's results); same verdict as the desktop check", () => {
  t.ok(dsrc.length > 500, "the desktop function was found");
  const fc = RECD.static.forecast;
  ["weekScore", "currentApWins", "currentApLosses", "currentApTies"].forEach((k) => t.ok(fc.teams.every((x) => x[k] != null), "the recording keeps " + k));
  const cases = {
    changedRecord: (() => { const x = clone(fc); x.teams[3].currentApWins += 1; x.teams[3].currentApLosses -= 1; return x; })(),
    wrongTeams: (() => { const x = clone(fc); x.teams[0].franchiseId = "0099"; return x; })(),
    changedResult: (() => {   // flip one Week-10 game in the forecast's scores; All-Play records untouched
      const x = clone(fc), g = STAND.weekly.find((r) => r.w === 10 && r.po === 0 && r.fid < r.opp && Math.abs(r.ts - r.os) > 1);
      const A = x.teams.find((q) => q.franchiseId === g.fid), B = x.teams.find((q) => q.franchiseId === g.opp); const s = A.weekScore; A.weekScore = B.weekScore; B.weekScore = s; return x; })(),
    valid: clone(fc),
  };
  for (const [k, sim] of Object.entries(cases)) {
    const M = ST.build(input({ forecast: sim })), desk = deskReconcile(sim, deskResp(clone(STAND)));
    // what is displayed first (ff3dc709 fails here: it showed simulated probabilities for every same-week forecast)
    t.equal(M.forecast.fresh, k === "valid", k + ": probabilities shown only for the valid forecast");
    t.equal(desk.hard.length === 0, k === "valid", k + ": the desktop check agrees (" + desk.hard[0] + ")");
    const mine = ST.forecastReconcile(sim, clone(STAND));
    t.equal(mine.hard.length === 0, desk.hard.length === 0, k + ": same verdict as the desktop check (" + mine.hard[0] + " / " + desk.hard[0] + ")");
    if (k !== "valid") { M.fids.forEach((f) => t.ok(["—", "100%", "0%"].includes(M.forecast.by[f].playoffs), k + " " + f + ": no simulated probability")); t.match(M.forecast.why, /doesn’t start from these standings/); }
  }
  t.equal(ST.build(input()).forecast.by[BASE.rows[5].franchise_id].playoffs, "56%", "valid: CBP 56%");
  // a forecast simulated under the earlier seeding rules (the published Week 10 file: overall-record step) is refused, whatever its week
  const old = clone(fc); delete old.model.seedingRule;
  const Mo = ST.build(input({ forecast: old }));
  t.equal(Mo.forecast.fresh, false); t.match(Mo.forecast.why, /made under earlier seeding rules/);
  Mo.fids.forEach((f) => t.ok(["—", "100%", "0%"].includes(Mo.forecast.by[f].playoffs), "old rules " + f + ": no simulated probability"));
  // a verified clinch still shows when the forecast is refused
  const M2 = ST.build(input({ forecast: cases.wrongTeams })); M2.fids.forEach((f) => { const v = M2.forecast.by[f].verdicts; if (v.playoffs) t.ok(/^(100|0)%$/.test(M2.forecast.by[f].playoffs)); });
});

test("MAT-3: three teams level on win % and division win % (different All-Play and Points For) withhold seeds, tags, both cutoff lines, magic numbers and every team's simulated Playoff %; verified clinches and eliminations stay", () => {
  const s = clone(STAND); const d = s.rows[0].division; const g = s.rows.filter((r) => r.division === d);
  t.equal(g.length, 3);
  g.forEach((r) => { r.regular_season.record = { w: 18, l: 9, t: 0 }; r.regular_season.division = { w: 3, l: 3, t: 0 }; });
  t.ok(new Set(g.map((r) => ST.share(r.regular_season.all_play) + "|" + Math.round(r.regular_season.points_for * 10))).size === 3, "their All-Play and Points For all differ");
  t.deepEqual(ST.unresolvedTies(s.rows, s.regular_season), [], "the seeding-tie list alone would not catch this");
  const M = ST.build(input({ standings: s })), W = M.withheld;
  const S = { lg: { sub: "race", open: { rd: true } }, lgd: { model: M } };
  const h = SV.body(S);
  // what is displayed first (ff3dc709 fails here: it drew seeds, tags and the Playoff line as if the lead were settled)
  t.doesNotMatch(h, /Bye line|Playoff line/, "no cutoff line"); t.doesNotMatch(h, /<span class="lgtag">/, "no current-position tag");
  t.equal((h.match(/<td class="rk">—<\/td>/g) || []).length, 6, "seeds 1-6 read —");
  t.equal(W.divisionTies.length, 1); t.deepEqual(W.divisionTies[0].fids.slice().sort(), g.map((r) => r.franchise_id).sort());
  t.match(h, /Magic numbers are not shown while a division lead is unsettled/);
  // re-review of 18d45312: ANY team's wild-card chance can depend on which tied team takes the division, so no simulated percentage is shown for anyone
  M.fids.forEach((f) => t.equal(W.pctHeld[f], true, f + ": Playoff % withheld"));
  const pcts = [...h.matchAll(/<\/td><td>([^<]*)<\/td><\/tr>/g)].map((m) => m[1]).filter((x) => /%|—/.test(x));
  t.equal(pcts.length, 12, "a Playoff % cell per team"); pcts.forEach((x) => t.equal(x, "—", "no simulated percentage (was e.g. CBP 53%, Real Deal Creel 97%)"));
  t.match(h, /24–3|18–9/, "records still shown"); t.equal((h.match(/The rules don’t say how the games between three or more teams settle it/g) || []).length, 1, "explained once");
  t.match(h, /simulated Playoff % are shown for any team/, "the notice says so");
  // verified outcomes stay: with a clinch and an elimination proven by the clinch engine, those two show 100% / 0% while everything simulated stays withheld
  const ins = s.rows.find((r) => !g.includes(r)).franchise_id, out = s.rows.slice().reverse().find((r) => !g.includes(r) && r.franchise_id !== ins).franchise_id;
  const clinchMod = { analyze: (x) => { const res = MODS.clinch.analyze(x); res.byFid[ins] = Object.assign({}, res.byFid[ins], { x: true }); res.byFid[out] = Object.assign({}, res.byFid[out], { e: true }); return res; } };
  const MV = ST.build(input({ standings: s, mods: Object.assign({}, MODS, { clinch: clinchMod }) }));
  const hv = SV.body({ lg: { sub: "race", open: {} }, lgd: { model: MV } });
  t.equal(MV.forecast.by[ins].verified, "100%"); t.equal(MV.forecast.by[out].verified, "0%");
  t.match(hv, new RegExp('data-fid="' + ins + '"[\\s\\S]*?<td>100%</td></tr>'), "verified clinch still shows 100%");
  t.match(hv, new RegExp('data-fid="' + out + '"[\\s\\S]*?<td>0%</td></tr>'), "verified elimination still shows 0%");
  t.match(hv, /lgtag cl">Clinched playoffs</, "the verified clinch tag stays");
  const dv = SV.body({ lg: { sub: "div", open: {} }, lgd: { model: M } });
  t.match(dv, /3 teams are level on win % and division win %/); t.doesNotMatch(dv, /MFL’s division rules|MFL’s own order/);
  t.equal(ST.build(input()).withheld.divisionTies.length, 0, "control: the recorded season has no unsettled division lead");
});

test("MAT-4 + divisions: a deciding head-to-head step shows both teams' actual series and the meetings; a division tiebreak line opens to its figures", () => {
  const s = clone(STAND); const met = s.weekly.find((g) => g.po === 0 && g.ts !== g.os && s.rows.findIndex((r) => r.franchise_id === g.fid) >= 6 && s.rows.findIndex((r) => r.franchise_id === g.opp) >= 6);
  const a = met.ts > met.os ? met.fid : met.opp, b = a === met.fid ? met.opp : met.fid;
  const games = s.weekly.filter((g) => g.po === 0 && g.fid === a && g.opp === b);
  const aw = games.filter((g) => g.ts > g.os).length, al = games.filter((g) => g.ts < g.os).length, at = games.length - aw - al;
  const A = s.rows.find((r) => r.franchise_id === a), B = s.rows.find((r) => r.franchise_id === b);
  B.regular_season.all_play = clone(A.regular_season.all_play); B.regular_season.record = clone(A.regular_season.record); B.regular_season.points_for = A.regular_season.points_for;
  B.seed_reason = { basis: "ladder", pool: "outside", step: "head_to_head", position: "behind", rival_franchise_id: a, vs_above: { franchise_id: a, step: "head_to_head" } };
  const M = ST.build(input({ standings: s })), S = { lg: { sub: "race", open: {} }, lgd: { model: M } };
  if (aw === al) { t.ok(true, "split series: Option B covers it"); return; }
  S.lg.open["tie:" + a + ":" + b] = true;
  const h = SV.body(S), rec = (w, l, tt) => w + "–" + l + (tt ? "–" + tt : "");
  t.match(h, new RegExp("Games between them</td><td>" + rec(aw, al, at) + "</td><td>" + rec(al, aw, at) + "</td><td><b>decides</b>"), "both teams' series records");
  games.forEach((g) => t.match(h, new RegExp("Week " + g.w + "</span><span class=\"n\">" + SV.t1(g.ts).replace(".", "\\.") + "</span><span>–</span><span>" + SV.t1(g.os).replace(".", "\\."))), "each meeting");
  // a division tiebreak line (Div step) opens to the figures
  const s2 = clone(STAND); const r2 = s2.rows.find((r) => r.division_reason && r.division_reason.vs_above);
  r2.division_reason.vs_above.step = "DIVPCT";
  const M2 = ST.build(input({ standings: s2 })), k = "dtie:" + r2.franchise_id + ":" + r2.division_reason.vs_above.franchise_id;
  const dv = SV.body({ lg: { sub: "div", open: { [k]: true } }, lgd: { model: M2 } });
  t.match(dv, /Behind .* on division record ▾/); t.match(dv, /<td class="t">Division<\/td><td>\d+–\d+/); t.match(dv, /<b>decides<\/b>/);
});

test("screens: one decimal with separators, Points For (never overall or H2H record) as the deciding line, All-Play vs H2H, '—' for a missing score, xFP absent", () => {
  const M = ST.build(input());
  const S = { lg: { sub: "race", per: "season", cset: "pts", open: {}, team: null, brk: "pos" }, lgd: { model: M }, intel: { players: null } };
  let h = SV.body(S);
  t.match(h, /Ahead of Hawks on total Points For/); t.doesNotMatch(h, /H2H record|overall record/); t.match(h, /Playoff line/);
  S.lg.sub = "scoring"; h = SV.body(S); t.match(h, /2,732\.0/); t.match(h, /273\.2/);
  S.lg.cset = "grp"; h = SV.body(S); t.match(h, /<b class="lgv">197\.0<\/b><span class="lgrk">#1<\/span>/, "the value leads; the rank is the smaller, muted line under it");
  t.doesNotMatch(h, /Season total|lgtot|1,970\.0/, "no season-total rows in Contributions: Pts/Wk throughout");
  S.lg.sub = "race"; S.teamId = "0012"; h = SV.body(S);
  t.match(h, /<tr class="lgcut lgbye"><td colspan="5">Bye line<\/td><\/tr>/); t.ok(h.indexOf("Bye line") < h.indexOf("Blake Bombers"), "the bye line sits between seed 2 and seed 3");
  t.match(h, /<tr class="lgme" aria-current="true"><td class="rk"><\/td><td class="t"><button class="lgtn" data-act="lgteam" data-fid="0012">Hawks</, "the selected team (Hawks, first team out) is highlighted");
  t.ok(h.indexOf("Playoff line") < h.indexOf('aria-current="true"'), "Hawks sit below the playoff line");
  t.doesNotMatch(h, />(Show|Hide)</, "chevrons, not Show/Hide words");
  { const S2 = { lg: { team: "0012", brk: "slot", open: { "b:s:RB": true, "b:s:RB:1": true } }, lgd: { model: M }, intel: { players: null } }, b = SV.brkSheet(S2);
    t.doesNotMatch(b, />(Show|Hide)</, "breakdown rows and week rows: chevrons only"); t.doesNotMatch(b, /RB · RB/, "no repeated slot/position"); t.match(b, /RB ×2/); }
  S.lg.sub = "scoring";
  S.lg.per = "week"; S.lg.wk = 10; h = SV.body(S); t.match(h, /All-Play/); t.match(h, /H2H/);
  const ns = M.contrib.noScore[0]; S.lg.team = ns.fid; S.lg.brk = "pos";
  const pos = ST.GROUP[RECD.static.positions.positions[ns.id]];
  S.lg.open["b:p:" + pos] = true; S.lg.open["b:p:" + pos + ":" + ns.w] = true;
  h = SV.brkSheet(S); t.match(h, /· —<\/span>/, "a missing score shows —"); t.match(h, /isn’t a recorded zero/);
  t.doesNotMatch(SV.body(S) + SV.helpSheet(S) + SV.teamSheet(Object.assign({}, S, { lg: Object.assign({}, S.lg, { team: M.fids[0] }) })), /xFP/);
});

// Keith's Standings presentation feedback, as ChatGPT's review of #1526 restated it (item 5): Contributions opens position and lineup-slot detail
// directly, in Pts/Wk throughout, with controls that read as controls; regular-season total Points For stays where the playoff tiebreak uses it.
test("Contributions: › opens the team's points by position (or slot) directly, in Pts/Wk throughout; no season-total rows; Total Pts stays", () => {
  const M = ST.build(input()), f = M.fids[0];
  const S = { lg: { sub: "scoring", per: "season", cset: "grp", open: {}, team: f, brk: "pos" }, lgd: { model: M }, intel: { players: null } };
  const h = SV.body(S);
  const go = [...h.matchAll(/<button class="lgcgo" data-act="lgbrk" data-fid="(\d{4})" data-v="pos" aria-label="([^"]+)">/g)];
  t.equal(go.length, 12, "one direct control per team");
  t.match(go[0][2], /: points per week by position or lineup slot$/);
  t.doesNotMatch(h, /data-act="lgt" data-v="ct:/, "no + toggle for season totals"); t.doesNotMatch(h, /Season total/);
  t.match(h, /Tap › for a team’s points by position or lineup slot\./); t.match(h, /add up to each team’s Pts\/Wk/);
  t.match(h, /<span role="columnheader">Pos<\/span>/, "the column says what it opens");
  // the click handler takes the view from the control (app.js), so › opens By position and the team sheet's buttons open their own view
  t.match(read("app.js"), /act === "lgbrk"\) \{ var bf = el\.getAttribute\("data-fid"\); if \(bf && \/\^\\d\{4\}\$\/\.test\(bf\)\) \{ if \(v === "pos" \|\| v === "slot"\) S\.lg\.brk = v;/);
  // team detail: two visible entries, no Season totals toggle; Total Pts (the playoff tiebreak's figure) is still there
  const ts = SV.teamSheet(S);
  t.match(ts, /data-act="lgbrk" data-fid="\d{4}" data-v="pos"><span>By position<\/span><span class="lgchev"/);
  t.match(ts, /data-act="lgbrk" data-fid="\d{4}" data-v="slot"><span>By lineup slot<\/span><span class="lgchev"/);
  t.doesNotMatch(ts, /Season totals|data-v="tst"/); t.match(ts, /<div>Total Pts<\/div>/);
  // the breakdown: Pts/Wk rows, then each week's points, then the players; no season total inside
  for (const brk of ["pos", "slot"]) {
    const open = {}; ["QB", "RB"].forEach((k) => { open["b:" + brk[0] + ":" + k] = true; });
    const b = SV.brkSheet({ lg: { team: f, brk, open }, lgd: { model: M }, intel: { players: null } });
    t.match(b, /<div class="lgscope">Pts\/Wk · Regular season · Weeks 1–10/);
    t.match(b, new RegExp("Tap a " + (brk === "pos" ? "position" : "slot") + " for its points each week; tap a week for the players\\."));
    t.doesNotMatch(b, /Season total/, brk + ": no season total in the drilldown");
    t.match(b, /<span>Week 1 · [0-9,]+\.\d pts<\/span><span class="lgchev"/, brk + ": each week is a labeled control with a chevron");
  }
});

test("Help: the forecast's open ties get equal chances, an approved forecast assumption (not a league tiebreak), and are counted (63 of 10,000)", () => {
  const M = ST.build(input());
  t.equal(M.forecast.openTies, 63);
  const hs = SV.helpSheet({ lg: { open: {} }, lgd: { model: M }, intel: { players: null } });
  t.match(hs, /<h4>Open ties in the forecast<\/h4><p>Not every tie has a league rule yet .* the forecast gives each tied team an equal chance at that place\. That is a forecast assumption Keith approved on 2026-11-25, not a league tiebreak; the league’s rule for these ties is still pending\. This forecast: 63 of 10,000 seasons\.<\/p>/);
  t.match(hs, /<h4>No tie list<\/h4>/);
});

test("every Standings state draws no inline style, script, form field, link or event handler, and only the read-only Standings controls; data text is escaped", () => {
  const M = ST.build(input()); const evil = '"><img src=x onerror=alert(1)><script>x</script>';
  const M2 = ST.build(input()); M2.names[M2.fids[0]] = evil;
  const ALLOWED = ["lgsub", "lgper", "lgset", "lgwk", "lgt", "lgteam", "lgbrk", "lgbv", "lgretry", "help", "close", "about"];
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
  t.match(a.html(), /Standings/); t.match(a.html(), /Ahead of Hawks on total Points For/); t.match(a.html(), /through Week 10 of 14/); ok("race");
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
