// UPS 2027 beta, R9: Team › Roster › Byes lineup coverage (apps/mobile2027/src/lib/coverage.js) and the one IR badge.
//   node tests/mobile2027_r9_coverage.test.mjs
//
// Offline. The slots are roster.js SLOTS (canon docs/league_context_v1.md §B4); the injury resolver is the beta's DERIVED copy (tests never read site/shared/);
// the real cases come from the committed recording (apps/mobile2027/src/recorded_data.js). What is proven:
//   - the fill is an exact assignment: required slots first, flex by eligibility, never one player in two slots, a flex-only shortage is found;
//   - only a bye, or in the current week an Out or an MFL designation, removes a player; Questionable and Doubtful never do; a later week ignores injuries;
//   - taxi options list every fitting taxi player (low scores included) with verified eligibility, call-ups left or "Not recorded", recent points;
//     team-wide obstacles sit above the list and player obstacles beside the player; IR returns need evidence in the current week's NFL report;
//   - both option sections start collapsed; no activation, call-up or lineup control; the IR badge is red, carries a medical cross and keeps "IR".
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, "..", "apps", "mobile2027", "src");
const require = createRequire(import.meta.url);
const B = await import(pathToFileURL(path.join(HERE, "..", "apps", "mobile2027", "scripts", "build.mjs")).href);
const EQ = await import(pathToFileURL(path.join(HERE, "..", "apps", "mobile2027", "scripts", "injury_equivalence.mjs")).href);
globalThis.UPSInjuryStatus = EQ.loadResolver(B.derivedBytes(B.DERIVED[0], path.join(HERE, "fixtures/mobile2027/shared")).toString("utf8"), "injury_status.pure.js");
const M = require(path.join(SRC, "lib/model.js"));
const R = require(path.join(SRC, "lib/roster.js"));
const COV = require(path.join(SRC, "lib/coverage.js"));
const V = require(path.join(SRC, "lib/views.js"));
const TV = require(path.join(SRC, "lib/tabviews.js"));
const text = (html) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");
const NOW = Date.UTC(2026, 10, 22, 15, 30);

// ---------- synthetic players ----------
let seq = 1000;
function P(pos, o) { seq++; return Object.assign({ id: String(seq), name: pos + " Player " + seq, pos, nflTeam: "AAA", status: "active", bye: 14, salary: 1000, years: 1, taxi: { used: null, max: null, eligible: false, text: "" } }, o || {}); }
// a full legal lineup with nothing to spare: 1 QB, 2 RB, 2 WR, 1 TE, then OFX/SFX need three more
function baseline() { return [P("QB"), P("RB"), P("RB"), P("WR"), P("WR"), P("TE"), P("PK"), P("PN"), P("DL"), P("DL"), P("LB"), P("LB"), P("DB"), P("DB"), P("DL")]; }
function teamOf(players, active) { return { id: "0001", name: "Test", players, counts: { active: active != null ? active : players.filter((p) => p.status === "active").length, taxi: 0, ir: 0 }, lineup: { state: "unavailable" } }; }
function stateOf(team, over) {
  const byId = {}; team.players.forEach((p) => { byId[p.id] = p; });
  return Object.assign({ model: { week: 11, limits: { roster: 30, ir: 15, taxi: 10, starters: 18 }, teams: [team], byId }, teamId: team.id, nowMs: NOW, view: "byes", open: {}, load: { core: "ok", coreNotes: [] }, intel: { status: { state: "ok", data: { ok: true, report_feed: { ok: true, current: true, week: 11, teams_mfl: ["AAA"] }, roster_feed: { ok: true }, mfl_feed: { ok: true }, mapped_mfl_ids: team.players.map((p) => p.id), players: {} }, at: NOW }, mu: {}, wk: {}, scores: {} } }, over || {});
}

test("assignment: required slots first, then flex by eligibility; one player per slot; a flex-only shortage is found", () => {
  const base = baseline();
  // 15 players, 18 slots: every required slot fills, OFX1, OFX2 and SFX cannot (no RB/WR/TE/QB is left over)
  let a = COV.assign(R.SLOTS, base);
  t.equal(a.filled, 15); t.equal(a.total, 18);
  t.deepEqual(a.open.map((s) => s.tag).sort(), ["OFX1", "OFX2", "SFX"], "the shortage is in the flex slots, not in a required one");
  const ids = a.inSlot.filter(Boolean).map((p) => p.id); t.equal(new Set(ids).size, ids.length, "nobody fills two slots");
  // one more RB fills one flex slot, a QB the superflex, and a WR the last OFX
  a = COV.assign(R.SLOTS, base.concat([P("RB"), P("QB"), P("WR")])); t.equal(a.filled, 18); t.equal(a.open.length, 0);
  // two QBs and nothing else extra: the second QB can go only to SFX (§B4: SFX is the only slot a second QB may take); OFX stays short
  a = COV.assign(R.SLOTS, base.concat([P("QB"), P("QB")])); t.equal(a.filled, 16); t.deepEqual(a.open.map((s) => s.tag).sort(), ["OFX1", "OFX2"]);
  // required before flex: with exactly two RBs, both take RB1/RB2 (an RB is never spent on OFX while RB2 is empty)
  a = COV.assign(R.SLOTS, base); t.ok(a.inSlot[R.SLOTS.findIndex((s) => s.tag === "RB2")], "RB2 is filled");
  // an augmenting path: whatever order the players come in, an earlier choice is moved to make room (never a greedy miss)
  const sl = [{ tag: "SFX", acc: ["QB", "RB"], flex: true }, { tag: "OFX1", acc: ["RB"], flex: true }];
  t.equal(COV.assign(sl, [P("RB"), P("QB")]).filled, 2, "SFX first took the RB, then gave it up to OFX and took the QB");
  // DFX takes any defender left over
  a = COV.assign(R.SLOTS, base.filter((p) => p.pos !== "DL" || p !== base[14]).concat([P("DB")])); t.ok(a.inSlot[R.SLOTS.findIndex((s) => s.tag === "DFX")].pos === "DB");
});

test("coverage per week: byes and confirmed absences remove a player; Questionable and Doubtful never do; a later week ignores this week's injuries", () => {
  const ps = baseline().concat([P("RB"), P("QB"), P("WR")]);
  const rb = ps[1], wr = ps[3], q = ps[2];
  rb.bye = 13; // an RB on bye in Week 13
  const tm = teamOf(ps), S = stateOf(tm);
  const st = S.intel.status.data.players;
  st[q.id] = { mfl: { status: "Questionable", details: "Ankle" } };
  st[wr.id] = { mfl: { status: "Out", details: "Knee" } };
  let w11 = COV.week(S, tm, 11);
  t.deepEqual(w11.absent.map((a) => a.player.id), [wr.id], "Out is a confirmed absence this week");
  t.ok(w11.pool === ps.length - 1, "the Questionable RB still counts");
  t.equal(w11.filled, 17, "Out WR leaves one flex slot open (the spare WR moves up)"); t.deepEqual(w11.short.map((s) => s.key), ["OFX"]);
  st[q.id] = { mfl: { status: "Doubtful" } }; t.ok(COV.week(S, tm, 11).pool === ps.length - 1, "Doubtful still counts");
  st[q.id] = { roster: { chip: "HOLD", label: "Holdout" } }; t.ok(COV.week(S, tm, 11).pool === ps.length - 1, "a Holdout chip is not a confirmed absence");
  st[q.id] = { roster: { chip: "PUP", label: "Physically unable to perform" } };
  w11 = COV.week(S, tm, 11); t.ok(w11.absent.some((a) => a.player.id === q.id && /PUP/.test(a.text)), "an MFL designation is a confirmed absence");
  // Week 13: this week's Out is not carried forward (R10: an MFL designation is, see mobile2027_r10_coverage); with two Outs and no designation only the bye counts
  st[q.id] = { mfl: { status: "Out" } };
  const w13 = COV.week(S, tm, 13);
  t.deepEqual(w13.byes.map((p) => p.id), [rb.id]); t.equal(w13.absent.length, 0); t.equal(w13.filled, 17);
  t.deepEqual(w13.short.map((s) => s.key), ["OFX"]);
  // a required-position shortage reads "available / required"
  ps[2].bye = 13; const w13b = COV.week(S, tm, 13);
  t.ok(w13b.short.some((s) => s.key === "RB" && s.available === 1 && s.required === 2), JSON.stringify(w13b.short));
  // with the injury read out, the current week is not "checked" and nobody is removed for injury
  const S2 = stateOf(tm, { intel: Object.assign({}, S.intel, { status: { state: "error", error: "x" } }) });
  const off = COV.week(S2, tm, 11); t.equal(off.injuriesChecked, false); t.equal(off.absent.length, 0);
  // a full lineup reports no shortage and no options
  const full = COV.week(stateOf(teamOf(baseline().concat([P("RB"), P("QB"), P("WR")]))), teamOf(baseline().concat([P("RB"), P("QB"), P("WR")])), 12);
  t.equal(full.short.length, 0); t.equal(full.taxi, null); t.equal(full.ir, null);
});

function shortTeam(active) {
  const ps = baseline().concat([P("QB"), P("WR")]); // OFX short by one in every week
  const lowTaxi = P("RB", { status: "taxi", name: "Low Scorer", taxi: { used: 0, max: 3, eligible: true, text: "Eligible · 3 of 3 call-ups left" } });
  const lastTaxi = P("TE", { status: "taxi", name: "Last Callup", taxi: { used: 3, max: 3, eligible: true, text: "Eligible · 0 of 3 call-ups left" } });
  const noTaxi = P("WR", { status: "taxi", name: "Legacy Case", taxi: { used: 0, max: 3, eligible: false, text: "Not eligible · active during 2025 (legacy promotion)" } });
  const unrec = P("WR", { status: "taxi", name: "Unrecorded Count", taxi: { used: null, max: null, eligible: true, text: "Eligible" } });
  const kTaxi = P("PK", { status: "taxi", name: "Taxi Kicker", taxi: { used: 0, max: 3, eligible: true, text: "Eligible" } });
  const irBack = P("RB", { status: "ir", name: "Practicing Back" }), irDes = P("WR", { status: "ir", name: "Designated Only" }), irOut = P("TE", { status: "ir", name: "Still Out" }), irDnp = P("RB", { status: "ir", name: "No Practice" });
  const all = ps.concat([lowTaxi, lastTaxi, noTaxi, unrec, kTaxi, irBack, irDes, irOut, irDnp]);
  const tm = teamOf(all, active), S = stateOf(tm);
  const st = S.intel.status.data.players;
  st[irBack.id] = { report: { status: "Questionable", injury: "Groin", practice: "Full Participation in Practice" }, roster: { chip: "IR-R", label: "Injured reserve – designated to return" } };
  st[irDes.id] = { roster: { chip: "IR-R", label: "Injured reserve – designated to return" } };
  st[irOut.id] = { report: { status: "Out", injury: "Knee", practice: "Limited Participation in Practice" }, roster: { chip: "IR", label: "Injured reserve" } };
  st[irDnp.id] = { report: { status: "Questionable", practice: "Did Not Participate In Practice" }, roster: { chip: "IR", label: "Injured reserve" } };
  S.intel.mu[11] = { state: "ok", data: { lastComplete: 10, games: { AAA: { opp: "BBB", isHome: true, kickoff: 1795370400, status: "scheduled" } }, avg: {} } };
  S.intel.scores = { 8: { state: "ok", data: { week: 8, scores: { [lowTaxi.id]: 0.4 } } }, 9: { state: "ok", data: { week: 9, scores: {} } }, 10: { state: "error", error: "x" } };
  return { S, tm, lowTaxi, lastTaxi, noTaxi, unrec, kTaxi, irBack, irDes, irOut, irDnp };
}

test("taxi options: every fitting taxi player, low scores included; eligibility, call-ups left or Not recorded, recent points; obstacles in their place", () => {
  const { S, tm, lowTaxi, lastTaxi, noTaxi, unrec, kTaxi } = shortTeam(30);
  const w = COV.week(S, tm, 11, { state: "ok", week: 10 });   // R10: recent weeks run through the shared cutoff W* (here 10)
  t.deepEqual(w.short.map((s) => s.key), ["OFX"]);
  const names = w.taxi.options.map((o) => o.player.name);
  [lowTaxi, lastTaxi, noTaxi, unrec].forEach((p) => t.ok(names.includes(p.name), p.name + " is listed"));
  t.ok(!names.includes(kTaxi.name), "a kicker cannot fill an OFX slot, so he is not an option");
  t.equal(w.taxi.eligible, 3, "eligible = call-up eligible ones (not the legacy-promoted one)");
  const o = (p) => w.taxi.options.find((x) => x.player.id === p.id);
  t.equal(o(lowTaxi).leftText, "3 of 3 call-ups left"); t.equal(o(unrec).leftText, "Call-ups left: Not recorded");
  t.deepEqual(o(lowTaxi).points.map((x) => x.week + ":" + x.text), ["8:0.4", "9:—", "10:Unavailable"], "a missing score is —, a failed read Unavailable, never 0");
  t.ok(o(lastTaxi).obstacles.some((x) => /permanent/.test(x.text)), "no temporary call-ups left: the next is permanent (canon §B2)");
  t.ok(o(noTaxi).obstacles.some((x) => /legacy promotion/.test(x.text)));
  t.deepEqual(w.taxi.team.map((x) => x.kind), ["full"], "a full active roster (30 of 30) is a team-wide obstacle");
  t.equal(COV.week(shortTeam(29).S, shortTeam(29).tm, 11).taxi.team.length, 0, "an open active spot: no team-wide obstacle");
  const S3 = Object.assign({}, S, { model: Object.assign({}, S.model, { limits: { roster: null } }) });
  t.equal(COV.teamObstacles(S3, tm)[0].kind, "limit", "an unknown roster limit is said, not assumed");
});

test("possible IR returns: only with this week's NFL report evidence (not Out, practicing); a designation alone or a later week is never enough", () => {
  const { S, tm, irBack, irDes, irOut, irDnp } = shortTeam(30);
  const w = COV.week(S, tm, 11);
  t.deepEqual(w.ir.options.map((o) => o.player.id), [irBack.id], "only the practicing, not-Out IR player");
  t.match(w.ir.options[0].evidence, /NFL report Week 11: Questionable · full practice · MFL: designated to return/);
  [irDes, irOut, irDnp].forEach((p) => t.equal(COV.irEvidence(S, p, 11), null, p.name + " has no supported return evidence"));
  t.equal(COV.irEvidence(S, irBack, 13), null, "the report speaks for Week 11 only");
  const later = COV.week(Object.assign({}, S), tm, 13); t.equal(later.ir.options.length, 0);
  const stale = Object.assign({}, S, { intel: Object.assign({}, S.intel, { status: { state: "ok", data: S.intel.status.data, at: NOW - 60 * 60 * 1000 } }) });
  t.equal(COV.irEvidence(stale, irBack, 11), null, "an expired injury read is no evidence");
});

test("the Byes view: coverage in each heading, option sections collapsed, team obstacles above the list, no write control", () => {
  const { S, tm } = shortTeam(30);
  tm.lineup = { state: "ok", count: 0, ids: [] };
  const html = V.rosterBody(S), tx = text(html);
  t.match(tx, /Lineup coverage · ▲ Short in Week 11 \(OFX, depends on a return\)/, "R10: an IR-R player on the team's IR would complete it (dependency note)");
  t.match(tx, /This week · Week 11 · no byes ▲ Short 1: OFX 1\/2/);
  const open = V.rosterBody(Object.assign({}, S, { open: { bw11: true } })), ot = text(open);
  t.match(ot, /OFX \(RB\/WR\/TE\) · 1 available \/ 2 required/);
  t.match(open, /data-g="bwtx11" aria-expanded="false"/, "Taxi options start collapsed"); t.match(open, /data-g="bwir11" aria-expanded="false"/, "IR returns start collapsed");
  t.match(ot, /Taxi options · 3 eligible of 4/); t.match(ot, /Possible IR returns · 1/);
  t.ok(ot.indexOf("Taxi options") < ot.indexOf("Possible IR returns"));
  const both = V.rosterBody(Object.assign({}, S, { open: { bw11: true, bwtx11: true, bwir11: true } })), bt = text(both);
  const tx1 = bt.split("Taxi options")[1].split("Possible IR returns")[0];
  t.ok(tx1.indexOf("Active roster is full (30 of 30)") >= 0 && tx1.indexOf("Active roster is full") < tx1.indexOf("Low Scorer"), "the team-wide obstacle is above the candidates");
  t.match(tx1, /Low Scorer [^▲]*Call-up eligible · 3 of 3 call-ups left/); t.match(tx1, /Recent points: checking which weeks are settled…/, "R10: no schedule read yet, so W* is not established and no week is guessed");
  t.match(tx1, /Last Callup[^]*?▲ No temporary call-ups left: another call-up is permanent/);
  t.match(tx1, /Unrecorded Count[^]*?Call-ups left: Not recorded/);
  t.match(bt.split("Possible IR returns")[1], /Possible, not confirmed[^]*Practicing Back IR NFL report Week 11: Questionable · full practice/);
  t.match(both, /chip irb/, "an IR candidate carries the IR badge");
  // read-only: every control is a profile link or an open/close toggle
  const acts = [...both.matchAll(/data-act="([^"]+)"/g)].map((m) => m[1]);
  t.ok(acts.every((a) => ["card", "grp", "teams", "help", "view"].includes(a)), "controls: " + [...new Set(acts)].join(","));
  t.doesNotMatch(both, /<input|<form|<select|activate now|Call up\b|Promote|Set lineup/i);
  // an open spot: no team-wide obstacle line, and the cap is not claimed
  const s29 = shortTeam(29); s29.tm.lineup = { state: "ok", count: 0, ids: [] };
  const t29 = text(V.rosterBody(Object.assign({}, s29.S, { open: { bw11: true, bwtx11: true } })));
  t.doesNotMatch(t29, /Active roster is full/); t.match(t29, /An active roster spot is open\. Cap room is not checked here\./);
  // a later short week has no IR evidence and says why
  s29.tm.players.filter((p) => p.status === "active" && p.pos === "PK")[0].bye = 13;
  const t13 = text(V.rosterBody(Object.assign({}, s29.S, { open: { bw13: true } })));
  t.match(t13, /Week 13 · 1 on bye ▲ Short 2: OFX 1\/2, K 0\/1/); t.match(t13, /Possible IR returns · none The NFL injury report covers Week 11 only\./);
});

test("the recorded league: real shortages found by the calculation (DL, RB, K, P), a taxi option behind a full roster, and the IR returns the report supports", () => {
  const src = fs.readFileSync(path.join(SRC, "recorded_data.js"), "utf8"), self = {};
  new Function("window", src)(self);
  const routes = self.UPS2027_RECORDED.routes, get = (p) => routes[Object.keys(routes).find((k) => k.startsWith(p))];
  const model = M.build(get("/roster-workbench"), get("/api/mfl-export?JSON=1&L=74598&TYPE=league"), get("/api/mfl-export?JSON=1&L=74598&TYPE=weeklyResults&W=11&"), 11, 2026);
  const intel = { status: { state: "ok", data: get("/api/player-status"), at: NOW }, mu: {}, wk: {}, scores: {} };
  const S = { model, nowMs: NOW, intel, view: "byes", open: {} };
  const team = (id) => model.teams.find((x) => x.id === id);
  t.equal(model.limits.roster, 30, "the active limit comes from the league read (rosterSize 30)");
  const lh = COV.week(S, team("0006"), 13);
  t.deepEqual(lh.short.map((s) => s.key + " " + s.available + "/" + s.required), ["DL 1/2"], "The Long Haulers, Week 13: one DL left");
  t.ok(lh.taxi.options.some((o) => o.player.pos === "DL" && o.eligible), "a call-up-eligible taxi DL"); t.equal(lh.taxi.team[0].kind, "full", "behind a full active roster");
  const cc = COV.week(S, team("0011"), 14);
  t.deepEqual(cc.short.map((s) => s.key + " " + s.available + "/" + s.required), ["RB 1/2"], "Cleon Ca$h, Week 14: one RB left");
  t.equal(cc.taxi.team.length, 0, "29 of 30 active: no team-wide obstacle");
  const all = []; model.teams.forEach((tm) => COV.weeks(Object.assign({}, S, { teamId: tm.id }), tm).forEach((w) => { if (w.short.length) all.push(tm.id + ":" + w.week); }));
  t.deepEqual(all.sort(), ["0001:14", "0002:13", "0004:14", "0006:13", "0007:13", "0010:13", "0011:13", "0011:14"].sort(), "every short team-week in the recording");
  const ire = []; model.teams.forEach((tm) => tm.players.filter((p) => p.status === "ir").forEach((p) => { if (COV.irEvidence(S, p, 11)) ire.push(p.name); }));
  t.deepEqual(ire.sort(), ["Jacory Croskey-Merritt", "Jonathon Brooks", "Michael Pittman", "Tyjae Spears"].sort(), "IR players with Week 11 report evidence");
});

test("the IR badge: one red badge with a medical cross that keeps the text IR, on rows, Contracts and the profile header", () => {
  const b = R.irBadge();
  t.match(b, /^<span class="chip irb"><svg class="irx" viewBox="0 0 10 10" aria-hidden="true" focusable="false"><path d="[^"]+"\/><\/svg>IR<\/span>$/);
  const css = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
  t.match(css, /\.chip\.irb\{background:var\(--cr\);border-color:var\(--cr\);color:var\(--on\)/, "red, from the existing critical color in every skin");
  t.match(css, /\.chip\.irb \.irx\{[^}]*fill:currentColor/);
  const views = fs.readFileSync(path.join(SRC, "lib/views.js"), "utf8"), tabs = fs.readFileSync(path.join(SRC, "lib/tabviews.js"), "utf8");
  t.match(views, /p\.status === "ir" \? R\.irBadge\("IR", "hpb"\)/, "the profile header"); t.doesNotMatch(views, /pill\("IR"\)/);
  t.match(tabs, /p\.status === "ir" \? " " \+ R\.irBadge\(\)/, "the Contracts row"); t.doesNotMatch(tabs, /chip\("", "IR"\)/);
  t.match(tabs, /c\.code === "IR" \? R\.irBadge\(\)/, "an IR designation chip on Performance rows");
});

await run("mobile2027_r9_coverage");
