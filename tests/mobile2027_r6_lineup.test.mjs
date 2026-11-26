// UPS 2027 beta, R6 Lineup revisions (Keith, 2026-11-22, assignment section 3): Team › Roster › Lineup.
//   node tests/mobile2027_r6_lineup.test.mjs
//
// Offline, over the same trimmed public recordings as the R2 tests (tests/fixtures/mobile2027/public_reads.json and r2_reads.json).
// What is proven here:
//   - slot badges: numbered labels kept, flex labels OFX1/OFX2, SFX, DFX; a filled badge carries the occupying player's position color
//     class (a QB in SFX is QB-colored) and a flex badge prints that position as text too; empty badges are neutral; a past week has none
//   - one count, "Starting lineup · N/18", from the slot model; MFL's own starter count agrees on the recording; a mismatch is warned about
//   - no success box, no "nothing needs attention", no read-only explanations; a warning card only for a real lineup issue
//   - every matchup shows its kickoff in Eastern Time, the Sunday 1:00 PM games included; the formatter follows daylight saving time
//   - Bench, Injured reserve, Taxi squad: one card each, open by default with the full list, collapsible; bench grouped by position;
//     no "Return: Unavailable"; taxi call-ups visible; every player name opens his profile; no write or swap control
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const FX = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/public_reads.json"), "utf8"));
const FX2 = JSON.parse(fs.readFileSync(path.join(HERE, "fixtures/mobile2027/r2_reads.json"), "utf8"));
const FIXSH = path.join(HERE, "fixtures/mobile2027/shared");
const B = await import(pathToFileURL(path.join(HERE, "..", "apps", "mobile2027", "scripts", "build.mjs")).href);
const EQ = await import(pathToFileURL(path.join(HERE, "..", "apps", "mobile2027", "scripts", "injury_equivalence.mjs")).href);
globalThis.UPSInjuryStatus = EQ.loadResolver(B.derivedBytes(B.DERIVED[0], FIXSH).toString("utf8"), "injury_status.pure.js");
const F = require(path.join(SRC, "lib/format.js"));
const M = require(path.join(SRC, "lib/model.js"));
const D = require(path.join(SRC, "lib/data.js"));
const R = require(path.join(SRC, "lib/roster.js"));
const V = require(path.join(SRC, "lib/views.js"));
const CSS = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");

const CFG = { workerBase: "https://upsmflproduction.keith-creelman.workers.dev", leagueId: "74598", season: "2026" };
const clone = (x) => JSON.parse(JSON.stringify(x));
const TEAM = "0009", SHORT = "0010";
const model = () => M.build(FX.roster_workbench, FX.league, FX.weekly_results, 11, 2026);
async function intelFor(over) {
  const fetchFake = async (url) => {
    const u = new URL(url); let body = {};
    if (u.pathname === "/api/player-status") body = (over && over.status) || FX2.player_status;
    else if (u.pathname === "/api/lineup-matchups") body = Object.assign({}, FX2.lineup_matchups_w11, { week: Number(u.searchParams.get("W")) });
    else if (u.searchParams.get("TYPE") === "weeklyResults") body = u.searchParams.get("W") === "10" ? FX2.weekly_results_w10 : FX.weekly_results;
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  const L = D.createLoader(CFG, fetchFake), rec = (r) => ({ state: r.state, data: r.data, at: r.at || Date.now() });
  return { status: rec(await L.loadStatus()), mu: { 11: rec(await L.loadMatchups(11)) }, wk: { 11: rec(await L.loadWeekly(11)), 10: rec(await L.loadWeekly(10)) } };
}
const state = (intel, over) => ({
  model: model(), load: { core: "ok", coreNotes: [] }, penalty: { state: "idle" }, teamId: TEAM, tab: "team", sub: "roster", view: "lineup",
  open: {}, flags: {}, profile: null, sheet: null, skin: "system", vib: "1", build: "test", requestLog: [], wk: null, intel,
  requestSummary: { requests: 0, ok: 0, failed: 0, refused: 0, nonGet: 0 }, ...(over || {}),
});
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const team = (S) => S.model.teams.find((x) => x.id === S.teamId);
const badgeOf = (html, pid) => { const r = html.split('<div class="rx').find((x) => x.includes('data-pid="' + pid + '"') && /^[^>]*><(?:span|button) class="tag /.test(x)); return r ? (/<(?:span|button) class="(tag [^"]*)"[^>]*>(.*?)<\/(?:span|button)>(?=<div class="in">)/.exec(r) || [])[0] || "" : ""; };

test("slot badges: numbered labels, OFX/SFX/DFX, the occupying player's position color, and the position as text on a flex badge", async () => {
  const intel = await intelFor(), S = state(intel), lu = R.lineupFor(S, team(S), 11), html = V.rosterBody(S);
  t.deepEqual(R.SLOTS.filter((s) => s.flex).map((s) => s.tag), ["OFX1", "OFX2", "SFX", "DFX"]);
  t.equal(R.SLOTS.length, 18);
  lu.slots.forEach((x) => {
    const b = badgeOf(html, x.player.id);
    t.ok(b, x.slot.tag + ": badge drawn");
    t.match(b, new RegExp('class="tag sl ps ' + x.player.pos + (x.slot.flex ? " fx" : "") + ' pbt"'), x.slot.tag + " carries " + x.player.pos + "'s color class");
    t.ok(b.includes(">" + x.slot.tag + "<"), x.slot.tag + ": the text label stays");
    if (x.slot.flex) { t.match(b, new RegExp("<i>" + x.player.pos + "</i>"), x.slot.tag + ": the position is printed too"); t.match(b, /aria-label="[A-Z0-9]+, [A-Za-z ]+, [A-Z]{2}\. Plan a change for this slot"/); }   // R12: the current-week badge is the planner's button; same label
  });
  // a QB in SFX uses the QB color: put the team's bench QB (or any other QB) into the superflex spot
  const m = model(), tm = m.teams.find((x) => x.id === TEAM), sfx = R.lineupFor(state(intel, { model: m }), tm, 11).slots.find((x) => x.slot.tag === "SFX").player;
  const otherQB = Object.values(m.byId).find((p) => p.pos === "QB" && !tm.lineup.ids.includes(p.id));
  t.ok(otherQB, "a QB not in this lineup exists in the recording");
  tm.lineup.ids = tm.lineup.ids.map((id) => (id === sfx.id ? otherQB.id : id)); m.byId[otherQB.id].franchiseId = TEAM; m.byId[otherQB.id].status = "active";
  const S2 = state(intel, { model: m }), slot = R.lineupFor(S2, tm, 11).slots.find((x) => x.slot.tag === "SFX");
  t.equal(slot.player.id, otherQB.id, "the second QB fills SFX");
  const b2 = badgeOf(V.rosterBody(S2), otherQB.id);
  t.match(b2, /class="tag sl ps QB fx pbt"/); t.match(b2, /<b>SFX<\/b><i>QB<\/i>/);
  // the CSS gives .ps.QB the existing QB color variables (vibrant skin); plain skin stays neutral
  t.match(CSS, /\[data-vib="1"\] \.tag\.sl\.ps\.QB\{background:var\(--pq\);color:var\(--pqt\);border-color:var\(--pq\)\}/);
  ["RB", "WR", "TE"].forEach((p) => t.match(CSS, new RegExp("\\.tag\\.sl\\.ps\\." + p + "\\{")));
  t.match(CSS, /\.tag\.sl\.ps\.DL,\[data-vib="1"\] \.tag\.sl\.ps\.LB,\[data-vib="1"\] \.tag\.sl\.ps\.DB\{/);
  // an empty slot is neutral and keeps its label; a past week's rows are recorded order numbers, never a slot or a color
  const short = V.rosterBody(state(intel, { teamId: SHORT }));
  t.match(short, /<button class="tag sl fx pbt" data-act="plan" data-v="DFX" aria-label="DFX, Defensive flex, empty\. Plan a change for this slot"><b>DFX<\/b><\/button><div class="in"><b>Empty<\/b>/);
  t.doesNotMatch(V.rosterBody(state(intel, { wk: 10 })), /class="tag sl ps|class="tag sl fx/);
  // bench, IR and taxi rows keep the existing colored position badge; F4 (Keith 2026-11-26): on the current week's Lineup the bench badge is the
  // planner control (it opens the slots the player can fill); the name still opens the profile
  const html3 = V.rosterBody(S);
  M.benchGroups(team(S)).forEach((g) => g.players.forEach((p) => t.match(html3, new RegExp('<button class="tag pp pbt" data-act="planfor" data-v="' + p.id + '" aria-label="[^"]*">' + '<span class="pc ' + p.pos + '">' + ({ PK: "K", PN: "P" }[p.pos] || p.pos) + '</span></button><div class="in"><button class="nm" data-act="card" data-pid="' + p.id + '"'))));
  t.doesNotMatch(V.rosterBody(state(intel, { view: "byes" })), /data-act="planfor"/, "the bench badge is a control only on the Lineup view");
  M.reserve(team(S), "ir").concat(M.reserve(team(S), "taxi")).forEach((p) => t.match(html3, new RegExp('<span class="pc ' + p.pos + '">' + ({ PK: "K", PN: "P" }[p.pos] || p.pos) + '</span></span><div class="in"><button class="nm" data-act="card" data-pid="' + p.id + '"')));
});

test("one count: 'Starting lineup · N/18' from the slot model, MFL's own count agrees, and a mismatch is said", async () => {
  const intel = await intelFor();
  t.equal(model().limits.starters, 18, "the recorded league read lists 18 starting spots"); t.equal(R.SLOTS.length, model().limits.starters);
  const html = V.rosterBody(state(intel)), tx = text(html);
  t.equal((tx.match(/Starting lineup · 18\/18/g) || []).length, 1, "said once");
  t.doesNotMatch(tx, /of 18 starters|Week 11 starters|starters · 18 of 18/);
  t.match(text(V.rosterBody(state(intel, { teamId: SHORT }))), /Starting lineup · 17\/18/, "a short lineup counts what MFL lists");
  const m = model(); m.limits.starters = 19;
  const mm = text(V.rosterBody(state(intel, { model: m })));
  t.match(mm, /MFL lists 19 starting spots; this lineup has 18 slots\./); t.match(mm, /Starting lineup · 18\/18/);
  const m2 = model(); m2.limits.starters = null;
  t.doesNotMatch(V.rosterBody(state(intel, { model: m2 })), /lwarn/, "an unread limit is not a mismatch");
});

test("no success box and no repeated explanations; a concise warning only when an issue exists", async () => {
  const intel = await intelFor(), html = V.rosterBody(state(intel)), tx = text(html);
  t.doesNotMatch(html, /okc|lwarn|class="card warnc/);
  t.doesNotMatch(tx, /nothing needs attention|Read only|Nothing here can change|A kickoff time is shown|As MFL has it|Return: Unavailable|View all|Expand all|Collapse all/);
  // an Out starter: one card, one line, the name opens his profile
  const S0 = state(intel), p = R.lineupFor(S0, team(S0), 11).slots[2].player;
  const s2 = clone(FX2.player_status); s2.players[p.id] = { mfl: { status: "Out", week: 11, details: "Knee" } };
  const h2 = V.rosterBody(state(await intelFor({ status: s2 })));
  t.equal((h2.match(/class="card warnc lwarn"/g) || []).length, 1);
  t.match(text(h2), new RegExp("▲ 1 needs attention RB2 · " + p.name + " Out · (vs|@) [A-Z]+ · \\w{3} \\d{1,2}:\\d{2} [AP]M ET"));
  const card = h2.split('class="card warnc lwarn"')[1].split('<div class="card')[0];
  t.match(card, new RegExp('data-act="card" data-pid="' + p.id + '"'));
  t.doesNotMatch(card, /class="ex/, "no explanation paragraph in the card");
});

test("kickoffs: every matchup in Eastern Time, Sunday 1:00 PM included; the formatter follows daylight saving time", async () => {
  // 2026-11-22 18:00 UTC = Sun 1:00 PM EST; 2026-09-13 17:00 UTC = Sun 1:00 PM EDT; 2026-11-27 01:15 UTC = Thu 8:15 PM EST
  t.equal(F.etKickoff(Date.UTC(2026, 10, 22, 18, 0) / 1000), "Sun 1:00 PM");
  t.equal(F.etKickoff(Date.UTC(2026, 8, 13, 17, 0) / 1000), "Sun 1:00 PM");
  t.equal(F.etKickoff(Date.UTC(2026, 10, 27, 1, 15) / 1000), "Thu 8:15 PM");
  t.equal(F.etKickoff(0), ""); t.equal(F.etKickoff(null), ""); t.equal(F.etKickoff("x"), "");
  const intel = await intelFor(), S = state(intel), html = V.rosterBody(S);
  const active = team(S).players.filter((p) => p.status === "active");
  let shown = 0, sun1 = 0;
  active.forEach((p) => {
    const k = R.kickoffInfo(S, p, 11), row = html.split('<div class="rx').find((x) => x.includes('data-pid="' + p.id + '"') && /^[^>]*><(?:span|button) class="tag /.test(x));
    if (!row || R.onBye(p, 11)) return;
    if (k.state === "known") { t.ok(text(row).includes(k.text), p.name + ": " + k.text); shown++; if (k.text === "Sun 1:00 PM ET") sun1++; }
    if (k.state === "unknown") t.match(text(row), /Kickoff unavailable/);
  });
  t.ok(shown >= 20, "kickoffs on starters and bench: " + shown); t.ok(sun1 >= 5, "Sunday 1:00 PM games shown: " + sun1);
});

test("Bench, IR and Taxi: one card each, open with the full list, collapsible, bench grouped by position, call-ups visible, names open profiles", async () => {
  const intel = await intelFor(), S = state(intel), html = V.rosterBody(S), tm = team(S);
  const bench = M.benchGroups(tm), ir = M.reserve(tm, "ir"), tx = M.reserve(tm, "taxi");
  ["bench", "ir", "taxi"].forEach((k) => t.equal((html.match(new RegExp('data-g="' + k + '" aria-expanded="true"', "g")) || []).length, 1, k + ": one open heading"));
  t.match(text(html), new RegExp("Bench · " + bench.reduce((n, g) => n + g.players.length, 0)));
  t.match(text(html), new RegExp("Injured reserve · " + ir.length + " of 15")); t.match(text(html), new RegExp("Taxi squad · " + tx.length + " of 10"));
  // each section is ONE card; the bench lists every bench player, grouped under position labels in the league's order
  const benchCard = html.split('data-g="bench"')[1].split('data-g="ir"')[0];
  t.deepEqual([...benchCard.matchAll(/<div class="lps">([A-Z]+) · (\d+)<\/div>/g)].map((m) => m[1] + m[2]), bench.map((g) => ({ PK: "K", PN: "P" }[g.pos] || g.pos) + g.players.length), "R9: K and P labels");
  bench.forEach((g) => g.players.forEach((p) => t.ok(benchCard.includes('data-pid="' + p.id + '"'), p.name + " listed")));
  t.equal((benchCard.match(/class="card/g) || []).length, 1, "the bench is one card (the next card is IR's)");
  // IR: no repeated return line; taxi: call-ups on every row
  const irCard = html.split('data-g="ir"')[1].split('data-g="taxi"')[0], txCard = html.split('data-g="taxi"')[1];
  t.ok(ir.length >= 1 && tx.length >= 1, "the team has IR and taxi players");
  t.doesNotMatch(text(irCard), /Return/);
  tx.forEach((p) => t.match(text(txCard), new RegExp(p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + " [A-Z]* ?· ?(\\d+/\\d+ call-ups|Call-ups unavailable)")));
  // every listed name opens the profile; the only controls are read-only ones
  [...html.matchAll(/data-act="card" data-pid="(\d+)" aria-label="([^"]+), open player profile"/g)].forEach((m) => t.ok(S.model.byId[m[1]], m[2]));
  const acts = new Set([...html.matchAll(/data-act="([a-z]+)"/g)].map((m) => m[1]));
  [...acts].forEach((a) => t.ok(["card", "grp", "weeks", "view", "teams", "help", "plan", "planfor"].includes(a), "read-only control: " + a));
  t.doesNotMatch(text(html), /\b(Swap|Replace|Start|Sit|Move|Promote|Activate|Call up)\b/);
  // collapsing: the heading flips, the players disappear, the count stays
  const shut = V.rosterBody(state(intel, { open: { bench: false, ir: false, taxi: false } }));
  ["bench", "ir", "taxi"].forEach((k) => t.match(shut, new RegExp('data-g="' + k + '" aria-expanded="false"')));
  bench.concat([{ players: ir }, { players: tx }]).forEach((g) => g.players.forEach((p) => t.ok(!shut.includes('data-pid="' + p.id + '"') || R.lineupFor(S, tm, 11).slots.some((x) => x.player && x.player.id === p.id), p.name + " hidden")));
  t.match(text(shut), /Bench · \d+/);
  // an empty section is a heading with nothing to open
  const m = model(); m.teams.find((x) => x.id === TEAM).players.forEach((p) => { if (p.status === "ir") p.status = "gone"; });
  const noIr = V.rosterBody(state(intel, { model: m }));
  t.match(text(noIr), /Injured reserve · 0 of 15/); t.doesNotMatch(noIr, /data-g="ir"/); t.doesNotMatch(text(noIr), /No one on injured reserve/);
  // bench rows keep injury status and bye clear: a bench player on a bye says so in words
  // (a real bye: MFL's bye week is this week AND the week's games read has no game for his club)
  const m2 = model(), b0 = M.benchGroups(m2.teams.find((x) => x.id === TEAM))[0].players[0]; m2.byId[b0.id].bye = 11;
  const mu = clone(intel.mu[11].data); delete mu.games[String(b0.nflTeam).toUpperCase()];
  const r = V.rosterBody(state({ ...intel, mu: { 11: { state: "ok", data: mu, at: Date.now() } } }, { model: m2 })).split('<div class="rx').find((x) => x.includes('data-pid="' + b0.id + '"'));
  t.match(text(r), /Bye week/); t.doesNotMatch(text(r), /\d:\d\d [AP]M/, "no kickoff for a bye");
});

await run("mobile2027_r6_lineup");
