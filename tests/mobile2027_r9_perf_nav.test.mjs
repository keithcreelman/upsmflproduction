// UPS 2027 R9 (Keith 2026-11-23, items 4 and 5): Team › Performance navigation and cleanup, and search with state preservation.
//   node tests/mobile2027_r9_perf_nav.test.mjs
// Offline: recorded public reads drawn through the real views, plus source checks of app.js for the tap handlers. The scroll geometry
// (Breakdown scroll-into-view, the exact scroll offset restored after a profile) is measured in headless Chrome (S/r7notes/r9c.md).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const M = require(path.join(SRC, "lib/model.js")), D = require(path.join(SRC, "lib/data.js")), V = require(path.join(SRC, "lib/views.js")), X = require(path.join(SRC, "lib/complete.js"));
const TV = require(path.join(SRC, "lib/tabviews.js")), BL = require(path.join(SRC, "lib/boxlog.js")), SR = require(path.join(SRC, "lib/statranks.js"));
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const FX3 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r3_reads.json"), "utf8"));
const FX4 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r4_reads.json"), "utf8"));
const CAL = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/calendar_2026.json"), "utf8"));
const CFG = { workerBase: "https://upsmflproduction.keith-creelman.workers.dev", leagueId: "74598", season: "2026" };
const css = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
const appJs = fs.readFileSync(path.join(SRC, "app.js"), "utf8");
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const body = (html) => html.split('id="screen"')[1].split("<nav")[0];
const TEAM = "0010";
async function intel() {
  const ok = (b) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) });
  const fake = async (url) => {
    const u = new URL(url), ty = u.searchParams.get("TYPE"), w = u.searchParams.get("W");
    if (u.pathname === "/api/lineup-matchups") return ok(Object.assign({}, FX3.lineup_matchups_w11, FX4.hist, { week: Number(w) }));
    if (ty === "playerScores") return ok({ playerScores: { playerScore: FX4.scores[w] || (w === "11" ? [{ id: "1", score: "0" }] : []) } });
    if (ty === "players") return ok({ players: { player: FX4.players } });
    if (ty === "nflByeWeeks") return ok(CAL.byes);
    if (ty === "nflSchedule" && w === "ALL") return ok(CAL.full);
    if (ty === "nflSchedule") return ok(w === "10" ? FX4.schedule10 : w === "11" ? FX4.schedule11 : { nflSchedule: { matchup: [] } });
    return ok({});
  };
  const L = D.createLoader(CFG, fake), rec = (r) => ({ state: r.state, data: r.data, error: r.error, at: Date.now() });
  const out = { status: null, mu: { 11: rec(await L.loadMatchups(11)) }, wk: {}, scores: {}, sched: {}, players: rec(await L.loadPlayers()) };
  for (const w of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) out.scores[w] = rec(await L.loadScores(w));
  for (const w of [10, 11]) out.sched[w] = rec(await L.loadSchedule(w, X.parseSchedule));
  out.cal = rec(await L.loadCalendar(X.parseCalendar));
  Object.keys(out.scores).forEach((k) => { out.scores[k].at += 1000; });
  return out;
}
const PF = (o) => Object.assign({ s: "pos", open: {}, res: {}, q: "", pos: "all", xt: false }, o || {});
const state = (over) => ({ model: M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, ns: { state: "idle" }, teamId: TEAM, tab: "team", sub: "performance", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], gdef: "needs", wk: null, live: null, pf: PF(),
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}) });
const cards = (html) => [...html.matchAll(/data-act="card" data-pid="(\d+)"( data-x="1")? aria-label="Open ([^"]+?) profile/g)].map((m) => ({ id: m[1], x: !!m[2], name: m[3] }));
const LABEL = { PK: "K", PN: "P" };

// ---------------- 4. position filter, composed with search and sort ----------------
test("position filter: All · QB · RB · WR · TE · K · P · DL · LB · DB chips (not the By position sort), All by default", async () => {
  const I = await intel(), h = body(V.app(state({ intel: I })));
  const chips = [...h.matchAll(/data-act="pfpos" data-v="([A-Z]+|all)" aria-pressed="(true|false)">([^<]+)</g)];
  t.deepEqual(chips.map((m) => m[3]), ["All", "QB", "RB", "WR", "TE", "K", "P", "DL", "LB", "DB"]);
  t.deepEqual(chips.map((m) => m[1]), ["all", "QB", "RB", "WR", "TE", "PK", "PN", "DL", "LB", "DB"]);
  t.deepEqual(chips.filter((m) => m[2] === "true").map((m) => m[1]), ["all"], "All is pressed by default");
  t.match(h, /<div class="lbl">Position<\/div><div class="chs pfpos" role="group" aria-label="Position">/);
  t.ok(h.indexOf('id="pfq"') < h.indexOf('data-act="pfpos"') && h.indexOf('data-act="pfpos"') < h.indexOf('data-act="pfs"'), "search, then position, then sort");
  t.match(h, /data-act="pfs" data-v="pos"[^>]*>By position</, "By position is still a sort");
  t.ok(TV.pfPosOk("PK") && TV.pfPosOk("all") && !TV.pfPosOk("K") && !TV.pfPosOk("<x>"), "only known values");
  t.match(appJs, /act === "pfpos"\) \{ if \(U\.tabviews\.pfPosOk\(v\)\) \{ S\.pf\.pos = v; render\(true\); \} \}/, "the tap validates the value");
  t.match(css, /\.pfpos \.ch\{min-width:44px;padding:0 9px\}/, "44px targets");
});

test("position filter + search + each sort: only that position, only this team, only matching names; IR/Taxi filtered too; empty state names the position", async () => {
  const I = await intel(), S0 = state({ intel: I }), team = S0.model.teams.find((x) => x.id === TEAM), byId = S0.model.byId;
  const ids = new Set(team.players.map((p) => String(p.id)));
  for (const pos of ["QB", "RB", "WR", "PK", "DB"]) {
    for (const s of ["pos", "tot", "ppg"]) {
      const got = cards(body(V.app(state({ intel: I, pf: PF({ pos, s, res: { ir: true, taxi: true } }) }))));
      const want = team.players.filter((p) => p.pos === pos).map((p) => String(p.id)).sort();
      t.deepEqual(got.map((c) => c.id).sort(), want, pos + "/" + s + ": exactly this team's " + pos + " players (reserve groups open)");
    }
  }
  // composed: WR + a fragment of one WR's name + Tot. Pts. sort
  const wr = team.players.filter((p) => p.pos === "WR" && p.status === "active");
  const who = wr[0], frag = who.name.split(/[ ,]+/).pop().slice(0, 3);
  const h = body(V.app(state({ intel: I, pf: PF({ pos: "WR", s: "tot", q: frag }) }))), got = cards(h);
  t.ok(got.length >= 1 && got.some((c) => c.id === String(who.id)), "the WR searched for is there");
  t.ok(got.every((c) => ids.has(c.id) && byId[c.id].pos === "WR"), "every card is one of this team's WRs");
  t.match(h, /Tot\. Pts\., highest first/, "the sort still applies");
  t.match(h, /data-act="pfpos" data-v="WR" aria-pressed="true"/);
  // a name on this team, but at another position: no match, and the empty state names the position
  const qb = team.players.find((p) => p.pos === "QB"), last = qb.name.split(/[ ,]+/)[0];
  const e = body(V.app(state({ intel: I, pf: PF({ pos: "PK", q: last }) })));
  if (!team.players.some((p) => p.pos === "PK" && TV.pfMatcher(last)(p))) t.match(text(e), new RegExp("No K on " + team.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " has a name containing"));
});

// ---------------- 5. Search other teams ----------------
function otherOnly(S) {
  const team = S.model.teams.find((x) => x.id === TEAM), mine = team.players.map((p) => p.name.toLowerCase());
  for (const o of S.model.teams) { if (o.id === TEAM) continue; for (const p of o.players) { const w = p.name.split(/[ ,]+/).filter((x) => x.length >= 4)[0]; if (w && !mine.some((n) => n.includes(w.toLowerCase())) && TV.pfMatcher(w)) return { p, team: o, q: w }; } }
  return null;
}
test("Search other teams: offered only when nothing on this team matches; on tap lists other teams' ROSTERED players with their team; this team's results stay separate", async () => {
  const I = await intel(), S0 = state({ intel: I }), hit = otherOnly(S0), team = S0.model.teams.find((x) => x.id === TEAM);
  t.ok(hit, "a name only another team has");
  const before = body(V.app(state({ intel: I, pf: PF({ q: hit.q }) })));
  t.match(before, /No players match/); t.match(before, /<button class="btn xtb" data-act="pfxt" aria-controls="pflist">Search other teams<\/button>/);
  t.equal(cards(before).length, 0, "nothing from another team until the owner asks");
  const h = body(V.app(state({ intel: I, pf: PF({ q: hit.q, xt: true }) }))), got = cards(h);
  t.match(h, /<div class="gh2 xth"><span>Other teams · rostered players only<\/span>/, "labeled: other teams, rostered only");
  t.ok(got.length >= 1 && got.every((c) => c.x), "every result opens the profile as a cross-team result");
  t.ok(got.some((c) => c.id === String(hit.p.id)), "the player is listed");
  t.ok(got.every((c) => !team.players.some((p) => String(p.id) === c.id)), "no player of this team in the other-teams list");
  t.match(h, new RegExp('data-pid="' + hit.p.id + '" data-x="1"[^>]*>[\\s\\S]*?<b class="xtt">' + hit.team.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "</b>"), "his UPS team beside him");
  t.doesNotMatch(h, /data-act="pfxt"/, "the action is spent once shown");
  t.doesNotMatch(text(h), /free agents? (are|is) searched/i);
  // the same data the screen already holds: crossHits reads S.model.teams only (every team's roster from the one roster read)
  const hits = TV.crossHits(S0, team, { pos: "all" }, TV.pfMatcher(hit.q));
  const all = S0.model.teams.filter((o) => o.id !== TEAM).flatMap((o) => o.players).filter(TV.pfMatcher(hit.q));
  t.equal(hits.length, all.length, "every matching rostered player on the other " + (S0.model.teams.length - 1) + " teams");
  t.ok(S0.model.teams.length === 12, "the roster read holds all 12 teams");
  // composed with the position filter: another position gives none of his position
  const pos2 = TV.PF_POS.map((o) => o[0]).find((g) => g !== "all" && g !== hit.p.pos);
  const h2 = body(V.app(state({ intel: I, pf: PF({ q: hit.q, xt: true, pos: pos2 }) })));
  t.ok(cards(h2).every((c) => S0.model.byId[c.id].pos === pos2), "the position filter applies to the other teams too");
  t.match(h2, new RegExp("Other teams · " + (LABEL[pos2] || pos2) + " · rostered players only"));
  // a name that also matches this team: local results only, no other-teams action
  const local = team.players[0].name.split(/[ ,]+/)[0];
  const h3 = body(V.app(state({ intel: I, pf: PF({ q: local, xt: true }) })));
  t.doesNotMatch(h3, /data-act="pfxt"|Other teams ·/, "with local matches only this team's players show");
  t.ok(cards(h3).every((c) => !c.x));
  // typed text escaped in the cross-team empty state
  t.doesNotMatch(body(V.app(state({ intel: I, pf: PF({ q: '"><i>zz', xt: true }) }))), /"><i>zz/);
});

test("Search other teams: the tap is explicit, makes no read; clearing the search ends it; the profile opens without switching team and closing restores team and scroll", () => {
  t.match(appJs, /act === "pfxt"\) \{ if \(S\.pf\.q && S\.pf\.q\.trim\(\)\) \{ S\.pf\.xt = true; render\(true\); \} \}/);
  t.match(appJs, /if \(!S\.pf\.q\.trim\(\)\) S\.pf\.xt = false;/);
  t.match(appJs, /act === "card"\) openProfile\(el\.getAttribute\("data-pid"\), false, el\.getAttribute\("data-x"\) === "1"\)/);
  const op = appJs.split("function openProfile(")[1].split("\n  }\n")[0];
  t.match(op, /S\.ret = fromAddress \? null : \{ teamId: S\.teamId, top: scr \? scr\.scrollTop : 0 \}/, "where it was opened is remembered");
  t.match(op, /if \(p && p\.franchiseId && !keepTeam\) \{ S\.teamId = p\.franchiseId; \}/, "a cross-team result keeps the selected team");
  t.doesNotMatch(op, /S\.pf\b/, "the profile never touches the search, filter or sort state");
  const rf = appJs.split("function returnFromProfile()")[1].split("\n  }\n")[0];
  t.match(rf, /S\.teamId = r\.teamId;[\s\S]*render\(\);[\s\S]*scr\.scrollTop = r\.top/, "closing puts back the team, then the scroll offset");
  t.match(appJs.split("function closeLayer()")[1].split("\n  }\n")[0], /if \(wasProfile\) returnFromProfile\(\)/);
  t.match(appJs.split('addEventListener("popstate"')[1].split("});")[0], /if \(wasP\) returnFromProfile\(\)/, "the Back gesture restores too");
  const handlers = appJs.split('act === "pfxt"')[1].split("\n")[0] + appJs.split("function crossHits")[0].slice(-10);
  t.doesNotMatch(handlers, /loader\.|ensure|fetch/, "no read");
  const tv = fs.readFileSync(path.join(SRC, "lib/tabviews.js"), "utf8"), cl = tv.split("function crossHits")[1].split("function perfList")[0];
  t.doesNotMatch(cl, /fetch|XMLHttpRequest|loader|D\.|load[A-Z]/, "cross-team search uses the roster read already in memory");
});

// ---------------- Breakdown navigation ----------------
test("Breakdown: opening content scrolls it into view (card, Season stats | Game log, a game) in #scroll or the profile sheet; changing the view closes an open game", () => {
  t.match(appJs, /act === "pfx"\) \{ S\.pf\.open\[v\] = !S\.pf\.open\[v\]; if \(S\.pf\.open\[v\]\) openAndReveal\("pfx", v\); else render\(true\); \}/);
  t.match(appJs, /act === "bdt"\)[^\n]*if \(was !== v\) openAndReveal\("bdt", tp\)/);
  t.match(appJs, /act === "bdg"\)[^\n]*if \(S\.bd\.g\[gp\]\) openAndReveal\("bdg", gp, gw\)/);
  t.match(appJs, /act === "bdv"\)[^\n]*if \(S\.bd\.v\[bp\] !== v\) S\.bd\.g\[bp\] = null;/, "a different view closes the open game");
  const rv = appJs.split("function revealNow(r)")[1].split("\n  }\n")[0];
  t.match(rv, /\.tabs\.stk[\s\S]*\.ptabs/, "below the sticky tabs, in #scroll and in the sheet");
  t.match(rv, /Math\.min\(need, room\)/, "never past the player's card (or the tapped game row)");
  t.match(appJs.split("function revealTargets(r)")[1].split("\n  }\n")[0], /appEl\.querySelector\("\.sheet"\) \|\| document\.getElementById\("scroll"\)/);
});

// ---------------- QB game detail ----------------
test("QB game detail: attempts once (in completions/attempts), sacks taken and sack yards lost separate, no '1-0'", () => {
  const r = { box: { pass_cmp: 20, pass_att: 31, pass_yds: 250, pass_tds: 2, pass_ints: 1, pass_sacks: 1, pass_sack_yds: -7, rush_att: 3, rush_yds: 12, rush_tds: 0, passing_air_yards: 280 }, snaps: { off: 60, team_off: 62 }, rz: null };
  const d = BL.detailStats("QB", r), lab = d.map((x) => x[0]), val = Object.fromEntries(d);
  t.equal(val["Completions/attempts"], "20/31");
  t.ok(!lab.includes("Pass attempts"), "the separate attempts line is gone from the detail");
  t.equal(lab.filter((l) => /attempt/i.test(l) && !/^Red-zone|^End-zone/.test(l)).length, 1, "attempts appear once");
  t.equal(val["Sacks taken"], "1"); t.equal(val["Sack yards lost"], "7");
  t.ok(!d.some((x) => /^\d+-\d+$/.test(String(x[1]))), "no 'sacks-yards' pair");
  t.deepEqual(BL.columns("QB", "st").map((c) => c.h), ["C/A", "Yds", "TD", "INT", "Sk", "SkYd", "Car", "RuYd", "RuTD"]);
  t.equal(BL.columns("QB", "use").map((c) => c.h).join(" "), "Snaps Snap % Att Air", "the Usage table keeps its attempts column (one figure per table)");
  // RB and WR: Usage repeats of Stats figures are listed once
  const rb = BL.detailStats("RB", { box: { rush_att: 10, targets: 4 }, snaps: { off: 30, team_off: 60 } }).map((x) => x[0]);
  t.equal(rb.filter((l) => l === "Carries").length, 1); t.equal(rb.filter((l) => l === "Targets").length, 1);
  const wr = BL.detailStats("WR", { box: { targets: 8, receiving_air_yards: 90 }, snaps: { off: 50, team_off: 60 } });
  t.equal(Object.fromEntries(wr)["Air yards per target"], "11.3", "a derived figure (aDOT) stays");
  // a sack with 0 yards is "1" and "0", never "1-0"
  const z = Object.fromEntries(BL.detailStats("QB", { box: { pass_sacks: 1, pass_sack_yds: 0 } }));
  t.equal(z["Sacks taken"], "1"); t.equal(z["Sack yards lost"], "0");
});

// ---------------- K and P ----------------
test("K and P on badges, headings and ranks (never PK / PN on screen); PK/PN stay only as the color class", async () => {
  const I = await intel(), S0 = state({ intel: I });
  let kp = 0;
  for (const tm of S0.model.teams) {
    for (const sub of ["roster", "performance", "contracts"]) {
      const h = V.app(state({ intel: I, teamId: tm.id, sub }));
      t.doesNotMatch(text(h), /\bPK\b|\bPN\b/, tm.id + " " + sub + ": no PK/PN text");
    }
    tm.players.filter((p) => p.pos === "PK" || p.pos === "PN").forEach((p) => {
      kp++;
      const pr = V.app(state({ intel: I, teamId: tm.id, profile: { pid: String(p.id), tab: "perf" } }));
      t.match(pr, new RegExp('<span class="avpos">' + LABEL[p.pos] + "</span>"), p.name + ": profile badge");
      t.match(pr, new RegExp("<span>" + LABEL[p.pos] + "</span><span>"), p.name + ": profile line");
      t.doesNotMatch(text(pr), /\bPK\b|\bPN\b/);
    });
  }
  t.ok(kp >= 5, "kickers and punters checked: " + kp);
  const ph = body(V.app(state({ intel: I, pf: PF({ pos: "PK" }) })));
  t.match(ph, /<span class="pc PK">K<\/span>/, "the card badge reads K with the PK color class");
  t.match(ph, /<div class="gh2"><span>K · /, "the heading reads K");
  t.equal(SR.prefix("PK") + SR.prefix("PN"), "KP", "season stat ranks read K1 / P1");
});

// ---------------- INT rate ----------------
const pool = (group, players) => ({ ok: true, season: 2026, through: 10, group, data_max_week: 10, unmapped_box_players: 0, ambiguous_ids: 0, fields: [], players });
const E = (id, s) => ({ mfl_id: String(id), gsis_id: "00-" + id, games: 9, snap_games: 9, s });
const rank = (j, id, key) => SR.rankOf(SR.checkPool(j, 2026, 10, j.group), id, key, { group: j.group, G: 9 });
test("INT rate: two decimals on screen; ranked on the exact rate with shared ties; the INT count has no rank; bar 15 x fewest club games", () => {
  const rows = (ints, att) => [{ week: 1, box: { pass_ints: ints, pass_att: att, pass_cmp: 1 }, snaps: null, rz: null }];
  const it = (ints, att) => BL.rollup({ pos: "QB", cutoff: 10, box: { state: "ok", through: 10, weeks: {} } }, rows(ints, att)).sections[0].items.find((x) => x.label === "INT rate");
  t.equal(it(7, 368).value, "1.90%"); t.equal(it(3, 154).value, "1.95%"); t.equal(it(0, 200).value, "0.00%", "a recorded 0 INT is a real 0.00%");
  t.equal(it(1, 3).value, "33.33%");
  t.equal(BL.rollup({ pos: "QB", cutoff: 10, box: { state: "ok", through: 10, weeks: {} } }, rows(7, 368)).sections[0].items.find((x) => x.label === "Interceptions").key, null, "no raw-count rank");
  // Murray and Hurts, Week 10: 3/154 each -> tied, shared rank
  const j = pool("QB", [E(1, { pass_ints: 3, pass_att: 154 }), E(2, { pass_ints: 3, pass_att: 154 }), E(3, { pass_ints: 2, pass_att: 160 }), E(4, { pass_ints: 4, pass_att: 140 })]);
  t.equal(rank(j, 1, "int_rate").text, "QB2"); t.equal(rank(j, 2, "int_rate").text, "QB2", "identical rates share a rank"); t.equal(rank(j, 4, "int_rate").text, "QB4");
  // two rates that SHOW the same two decimals rank on the exact value (19/1000 = 1.90%, 7/368 = 1.902% -> 1.90%)
  const k = pool("QB", [E(1, { pass_ints: 19, pass_att: 1000 }), E(2, { pass_ints: 7, pass_att: 368 })]);
  t.equal(it(19, 1000).value, it(7, 368).value); t.equal(rank(k, 1, "int_rate").text, "QB1"); t.equal(rank(k, 2, "int_rate").text, "QB2");
  t.equal(SR.barOf("int_rate", "QB", 9), 135); t.deepEqual(SR.RATE_BARS.bars.int_rate.perGame, { QB: 15 });
  t.match(SR.helpText(), /fewest games any NFL club has played through that week \(for example 15 pass attempts × 9 games = 135\)/, "Help documents the denominator");
  t.match(SR.helpText(), /INT rate shows two decimals; the rank uses the exact rate/);
});

// ---------------- copy ----------------
test("Help: compact, week-labeled projection; the position filter, search and Search other teams explained once; xFP stays Not Available", async () => {
  const I = await intel(), h = V.app(state({ intel: I, sheet: "help" }));
  t.match(text(h), /Provider: MFL\. “Week N Proj\.” is MFL’s last projection for the lineup week captured before the player’s game kicked off\. Not Available when there is none \(for example a bye\)\./);
  t.match(text(h), /Search other teams lists rostered players on the other league teams with their team; free agents are not searched\./);
  const p = body(V.app(state({ intel: I })));
  t.match(p, /Week 11 Proj\./);
  const xf = [...p.matchAll(/<span>xFP PPG<\/span><b><span class="na">([^<]+)<\/span>/g)].map((m) => m[1]);
  t.ok(xf.length > 10 && xf.every((x) => x === "Not Available"), "xFP PPG Not Available on every card");
  t.doesNotMatch(text(p), /[Ff]umbles? lost/);
});

run("mobile2027_r9_perf_nav");
