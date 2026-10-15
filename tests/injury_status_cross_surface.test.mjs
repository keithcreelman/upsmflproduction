// The same player reads the same on all three surfaces (Keith 2026-10-14: "the same players on
// all three surfaces"). The REAL code of each surface runs in node:vm on a tree DOM, fed the
// same live Week 6 /api/player-status snapshot (tests/fixtures/injury_status_2026_wk6.json):
//   • desktop Game Day   site/gameday/gameday.html's inline script → Submit Lineup, bench open,
//                        every matchup card opened → the badges and the card's injury lines
//   • mobile Lineup      site/m/views/lineup.js (+ the app's status loader from player_sheet.js)
//                        → the bench tags, every card's injury lines, every dropdown choice
//   • mobile player sheet the sheet's own two calls (PSTAT.resolve + resolvedChipsHtml; the
//                        source check below pins that the sheet header renders exactly these)
// For every active-roster player of all 12 teams (taxi / IR slots excluded: Game Day doesn't
// list them), the tags (text, color class, dashed or not) and the lines must be identical.
// Also: the live cases Keith asked for, a constructed fixture whose every case is fixed in this file
// (section 4: none of it depends on how many players a live snapshot happens to tag, or on what
// any real player's designation is), and nothing writes.
//   node tests/injury_status_cross_surface.test.mjs        (PROOF_OUT=<file> writes the table)
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { makeDocument, settle } from "./fixtures/tree_dom.mjs";

const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const SNAPSHOT = JSON.parse(read("tests/fixtures/injury_status_2026_wk6.json"));
const MU = JSON.parse(read("tests/fixtures/lineup_matchups_2026_wk6.json")).response;
const GAMEDAY = read("site/gameday/gameday.html"), LINEUP = read("site/m/views/lineup.js"), SHEET = read("site/m/player_sheet.js");
const LIVE = read("site/shared/live_scoring.js"), OVERRIDES = read("site/shared/injury_overrides.js"), STATUS = read("site/shared/injury_status.js");
const INLINE = [...GAMEDAY.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1])[0];
const PSTAT_SRC = SHEET.slice(SHEET.indexOf("  var PSTAT = (function () {"), SHEET.indexOf("  window.UPS_MOBILE_PLAYER_STATUS = PSTAT;") + "  window.UPS_MOBILE_PLAYER_STATUS = PSTAT;".length);
const clone = (x) => JSON.parse(JSON.stringify(x));
const nameOf = (raw) => { const p = String(raw).split(","); return p.length > 1 ? p[1].trim() + " " + p[0].trim() : String(raw); };
// The fixture every surface below reads. useFixture() swaps it (and everything derived from it) in one place.
let FX, NOW, WEEK, PLAYERS, PBYID, BYE_TEAMS;
function useFixture(fx) {
  FX = fx;
  NOW = Date.parse(fx.player_status.generated_utc);
  WEEK = fx.lineup_week;
  PLAYERS = Object.entries(fx.players).map(([id, [name, position, team]]) => ({ id, name, position, team }));
  PBYID = Object.fromEntries(PLAYERS.map((p) => [p.id, p]));
  BYE_TEAMS = [...new Set(PLAYERS.map((p) => p.team))].filter((t) => t && !/^FA/.test(t) && !MU.matchups[t]);
}
useFixture(SNAPSHOT);
// "2026-10-14": the fixture's own day in ET (the resolver's "today"), never the machine's clock.
const etDay = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(ms));
const isActive = (r) => !/taxi/i.test(r.status) && !/ir|injured/i.test(r.status);

let fails = 0, passes = 0;
const check = async (n, fn) => { try { await fn(); passes++; console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };

function routes(fid, log, writes) {
  const resp = (status, body) => ({ ok: status < 400, status, json: () => Promise.resolve(clone(body)) });
  const roster = FX.rosters[fid].map((r) => ({ id: r.id, status: r.status, salary: "1000", contractYear: "2" }));
  const answer = (url) => {
    const u = new URL(url), q = (k) => u.searchParams.get(k);
    if (u.pathname === "/api/current-lineup-week") return resp(200, { ok: true, week: WEEK });
    if (u.pathname === "/api/lineup") return resp(200, { ok: true, known: false, state: "no_record", starters: null });
    if (u.pathname === "/api/player-status") return resp(200, FX.player_status);
    if (u.pathname === "/api/lineup-matchups") return resp(200, MU);
    if (u.pathname === "/api/mfl-export") {
      const T = q("TYPE");
      if (T === "league") return resp(200, { league: { franchises: { franchise: Object.keys(FX.rosters).map((id) => ({ id, name: "Team " + id })) } } });
      if (T === "rosters") return resp(200, { rosters: { franchise: [{ id: fid, player: roster }] } });
      if (T === "salaries") return resp(200, { salaries: {} });
      if (T === "players") return resp(200, { players: { player: PLAYERS } });
      if (T === "projectedScores") return resp(200, { projectedScores: { week: String(WEEK), playerScore: roster.map((r, i) => ({ id: r.id, score: String(20 - i / 4) })) } });
      if (T === "injuries") return resp(200, { injuries: { week: String(WEEK), timestamp: "1791979264", injury: [] } });
      if (T === "nflSchedule") return resp(200, { nflSchedule: { matchup: [] } });   // nothing locked: every player can be compared
      if (T === "nflByeWeeks") return resp(200, { nflByeWeeks: { team: BYE_TEAMS.map((id) => ({ id, bye_week: String(WEEK) })) } });
    }
    return resp(404, { error: "unrouted " + url });
  };
  return (url, init) => {
    const method = (init && init.method) || "GET";
    log.push({ method, url: String(url) });
    if (method !== "GET") { writes.push(String(url)); return Promise.reject(new Error("write refused")); }
    return Promise.resolve(answer(String(url)));
  };
}
const fakeDate = (now) => class extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
const chipOf = (el, re) => { const c = el.attrs.class || ""; const m = re.exec(c); return { t: el.textContent.replace(/\s+/g, " ").trim(), cls: m ? m[1] : "?", prior: /\bprior\b/.test(c) }; };

// ── desktop Game Day ──
async function desktop(fid) {
  const doc = makeDocument(), root = doc.mount("gd-root"), log = [], writes = [];
  const c = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, URLSearchParams, JSON, Math, RegExp, Object, Array, String, Number, isNaN, isFinite, parseInt, parseFloat });
  c.window = c; c.document = doc; c.fetch = routes(fid, log, writes);
  c.location = { search: "?L=74598&YEAR=2026&FRANCHISE_ID=" + fid, href: "https://x.test/gameday/gameday.html?L=74598&YEAR=2026&FRANCHISE_ID=" + fid, hostname: "x.test" };
  const store = {}; c.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  c.Date = fakeDate(NOW);
  vm.runInContext(LIVE, c); vm.runInContext(OVERRIDES, c); vm.runInContext(STATUS, c); vm.runInContext(INLINE, c);
  await settle(30);
  doc.getElementById("gd-bench-toggle").click(); await settle();
  for (const pid of root.querySelectorAll(".gd-bench .gd-slot-mu[data-mu-pid]").map((b) => b.getAttribute("data-mu-pid"))) {
    root.querySelector('.gd-slot-mu[data-mu-pid="' + pid + '"]').click(); await settle(2);
  }
  const out = {};
  const byName = {}; FX.rosters[fid].forEach((r) => { if (PBYID[r.id]) byName[nameOf(PBYID[r.id].name)] = r.id; });
  for (const row of root.querySelectorAll(".gd-bench-row")) {
    const pid = byName[row.querySelector(".nm").textContent]; if (!pid) continue;
    const card = doc.getElementById("gd-mu-d-" + pid);
    out[pid] = { chips: row.querySelectorAll(".gd-inj-badge").map((b) => chipOf(b, /\btier-(\w+)/)),
      lines: card ? card.querySelectorAll(".gd-mu-inj").map((l) => l.textContent) : null };
  }
  return { out, log, writes, note: (root.querySelector(".gd-mu-note.inj") || { textContent: "" }).textContent };
}

// ── mobile Lineup ──
async function mobile(fid) {
  const doc = makeDocument(), mount = doc.mount("ups-m-main"), log = [], writes = [];
  const U = { safeStr: (v) => (v == null ? "" : String(v).trim()), safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); } };
  U.escapeHtml = (v) => U.safeStr(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const env = {};
  const M = {
    util: U,
    data: { playerById: (id) => PBYID[String(id)] || null, getRosterFor: () => FX.rosters[fid].map((r) => ({ id: r.id, status: r.status, salary: 1000, contractYear: "2" })) },
    api: { workerUrl: (p) => "https://w.test" + p, getStoredMflUserId: () => "",
      mflExportUrl: (type, extra) => { let s = "https://w.test/api/mfl-export?TYPE=" + type; for (const k in extra || {}) s += "&" + k + "=" + extra[k]; return s; } },
    state: { ctx: { year: "2026", leagueId: "74598" }, viewerFranchiseId: fid },
    route: { renderRoute: () => env.render() },
  };
  const c = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, URLSearchParams, JSON, Math });
  c.window = c; c.document = doc; c.location = { search: "", href: "https://x.test/m/" }; c.fetch = routes(fid, log, writes);
  c.Date = fakeDate(NOW); c.UPS_MOBILE = M;
  vm.runInContext(STATUS, c);
  vm.runInContext("(function () { var M = window.UPS_MOBILE, U = M.util, API = M.api, DATA = M.data;\n" + PSTAT_SRC + "\n})();", c);
  vm.runInContext(read("site/m/front_office_lineup.js"), c);
  vm.runInContext(LIVE, c);
  vm.runInContext(LINEUP, c);
  env.render = () => M.lineupView.render(mount);
  for (let i = 0; i < 4; i++) { env.render(); await settle(); }
  doc.getElementById("ups-m-bench-toggle").click(); await settle();
  for (const pid of mount.querySelectorAll(".ups-m-bench .ups-m-slot-mu[data-mu-pid]").map((b) => b.getAttribute("data-mu-pid"))) {
    mount.querySelector('.ups-m-slot-mu[data-mu-pid="' + pid + '"]').click(); await settle(2);
  }
  const out = {};
  const byName = {}; FX.rosters[fid].forEach((r) => { if (PBYID[r.id]) byName[nameOf(PBYID[r.id].name)] = r.id; });
  for (const row of mount.querySelectorAll(".ups-m-bench-row")) {
    const pid = byName[row.querySelector(".nm").textContent]; if (!pid) continue;
    const card = doc.getElementById("ups-m-mu-d-" + pid);
    out[pid] = { chips: row.querySelectorAll(".ups-m-inj-chip").map((b) => chipOf(b, /ups-m-inj-chip (\w+)/)),
      lines: card ? card.querySelectorAll(".ups-m-mu-inj").map((l) => l.textContent) : null, opt: null };
  }
  // The dropdown choices (every slot lists every startable bench player): the injury part.
  for (const o of mount.querySelectorAll(".ups-m-slot-sel option")) {
    const pid = o.attrs.value; if (!pid || !out[pid] || out[pid].opt != null) continue;
    const m = /·\s+((?:MFL|NFL)[^·]*?(?:\s(?:MFL|NFL)[^·]*?)*)\s+·\s+[\d.]+ pts/.exec(o.textContent.replace(/\s+·\s+est\. return passed/g, " (est. return passed)"));
    out[pid].opt = m ? m[1].trim() : "";
  }
  return { out, log, writes, note: (mount.querySelector(".ups-m-mu-note.inj") || { textContent: "" }).textContent };
}

// ── mobile player sheet: its statusHtml() is `PSTAT.resolve(pid, team, lineupWeek)` + `PSTAT.resolvedChipsHtml(res)` + `res.lines` ──
async function sheet() {
  const doc = makeDocument(), log = [], writes = [];
  const U = { safeStr: (v) => (v == null ? "" : String(v).trim()) };
  U.escapeHtml = (v) => U.safeStr(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const M = { util: U, api: { workerUrl: (p) => "https://w.test" + p }, data: { irEligibilityFor: () => null }, state: { ctx: { year: "2026", leagueId: "74598" }, lineupWeek: WEEK } };
  const c = vm.createContext({ console, Promise, URL, JSON, Math });
  c.window = c; c.document = doc; c.fetch = routes(Object.keys(FX.rosters)[0], log, writes); c.Date = fakeDate(NOW); c.UPS_MOBILE = M;
  vm.runInContext(STATUS, c);
  vm.runInContext("(function () { var M = window.UPS_MOBILE, U = M.util, API = M.api, DATA = M.data;\n" + PSTAT_SRC + "\n})();", c);
  const PS = c.UPS_MOBILE_PLAYER_STATUS;
  await PS.load("2026");
  const holder = doc.mount("sheet");
  const one = (pid) => {
    const res = PS.resolve(pid, PBYID[pid].team, M.state.lineupWeek || null);
    holder.innerHTML = "<div>" + PS.resolvedChipsHtml(res) + "</div>";
    return { chips: holder.querySelectorAll(".ups-m-inj-chip").map((b) => chipOf(b, /ups-m-inj-chip (\w+)/)), lines: [...res.lines], disagree: res.disagree,   // (copied into this realm: deepStrictEqual compares prototypes)
      opt: c.UPSInjuryStatus.optText(res).replace(/^\s*·\s*/, "") };
  };
  return { one, log, writes };
}

console.log("1. the sheet renders exactly the resolver's tags and lines (source check)");
await check("player_sheet.js statusHtml(): PSTAT.resolve(pid, team, lineupWeek) → resolvedChipsHtml(res) beside the name, res.lines one per line", () => {
  assert.match(SHEET, /function statusHtml\(\) \{\s*var res = PSTAT\.resolve\(pid, team, window\.UPS_MOBILE\.state\.lineupWeek \|\| null\);\s*return \{ chips: PSTAT\.resolvedChipsHtml\(res\), lines: res\.lines \};\s*\}/);
  assert.match(SHEET, /\(U\.escapeHtml\(name\) \|\| \('Player ' \+ U\.escapeHtml\(pid\)\)\) \+ stNow\.chips \+/);
  assert.match(SHEET, /stNow\.lines\.map\(function \(l\) \{ return '<div>' \+ U\.escapeHtml\(l\) \+ '<\/div>'; \}\)/);
  assert.match(GAMEDAY, /<script src="\.\.\/shared\/injury_status\.js"><\/script>/);
  assert.match(read("site/m/index.html"), /<script src="\.\.\/shared\/injury_status\.js\?v=[0-9.]+"><\/script>[\s\S]*<script src="\.\/player_sheet\.js\?v=/);
});

console.log("\n2. the same player reads the same on all three surfaces (12 teams, live Week 6)");
const S = await sheet();
const table = [], PAST_TABLE = [], MOBILE_OUT = {}, DESKTOP_OUT = {};
const PS_ALL = FX.player_status.players;
let compared = 0, withLines = 0, withTags = 0, optCompared = 0;
const allWrites = [].concat(S.writes);
const notes = {};
for (const fid of Object.keys(FX.rosters).sort()) {
  const D = await desktop(fid), Mo = await mobile(fid);
  MOBILE_OUT[fid] = Mo.out; DESKTOP_OUT[fid] = D.out;
  allWrites.push(...D.writes, ...Mo.writes);
  notes[fid] = [D.note, Mo.note];
  for (const r of FX.rosters[fid].filter(isActive)) {
    const pid = r.id, s = S.one(pid), d = D.out[pid], m = Mo.out[pid];
    const p = PBYID[pid] || {};
    await check("team " + fid + " · " + (p.position || "?") + " " + (p.team || "?") + " (" + pid + "): tags and lines match", () => {
      assert.ok(d, "on desktop's bench"); assert.ok(m, "on mobile's bench");
      assert.deepStrictEqual(d.chips, s.chips, "desktop tags vs the sheet");
      assert.deepStrictEqual(m.chips, s.chips, "mobile Lineup tags vs the sheet");
      if (d.lines || m.lines) {
        assert.deepStrictEqual(d.lines, s.lines, "desktop Details vs the sheet's lines");
        assert.deepStrictEqual(m.lines, s.lines, "mobile Details vs the sheet's lines");
        withLines++;
      }
      if (m.opt != null) { assert.strictEqual(m.opt, s.opt, "mobile dropdown choice"); optCompared++; }
    });
    compared++; if (s.chips.length) withTags++;
    table.push({ fid, pid, name: p.name, pos: p.position, team: p.team, tags: s.chips, lines: s.lines, disagree: s.disagree });
  }
}
await check("the whole league was compared (every active-roster player; most with their Details lines and dropdown text)", () => {
  assert.ok(compared >= 300, compared); assert.ok(withLines >= compared * 0.8, withLines + "/" + compared); assert.ok(optCompared >= compared * 0.6, optCompared + "/" + compared);
  assert.ok(withTags >= 40, withTags);
});
await check("both screen notes say the same thing", () => {
  for (const [fid, [dn, mn]] of Object.entries(notes)) { assert.strictEqual(dn, mn, fid); assert.ok(/No tag doesn’t mean healthy\.$/.test(dn), dn); }
});

console.log("\n3. the live cases Keith asked for (Week 6, read " + FX.player_status.generated_utc + ")");
const ps = FX.player_status.players;
const mflOnly = table.filter((r) => ps[r.pid] && ps[r.pid].mfl && !ps[r.pid].report && !ps[r.pid].prior);
// Every such player the snapshot has, however many that is (none is fine: section 4 constructs them).
await check("players MFL tags that the official report doesn't (yet) list: MFL's tag (never claiming a week); the NFL line says why there's nothing", () => {
  for (const r of mflOnly) {
    assert.ok(/^MFL: (Q|D|OUT)( · est\. return passed)?$/.test(r.tags[0].t), r.pid + " " + JSON.stringify(r.tags));
    assert.ok(!/Wk/.test(r.tags[0].t), "an MFL tag never claims a week");
    assert.ok(r.lines.some((l) => /^NFL (Wk 6 report: (not out yet for|not listed)|report: free agent)/.test(l)), r.lines.join(" | "));
  }
});
// Every league-wide case the snapshot has (MFL designates him; his team's posted Wk 6 report doesn't list him). The
// expected tag is whatever MFL's designation IS in the snapshot (Out, Doubtful or Questionable), never an assumed one.
// "Not listed" is only ever claimed for a player the report can be matched to (a verified NFL id); without one, MFL's
// tag stands alone and the line says he can't be matched.
const SHORT_OF = { Out: "OUT", Doubtful: "D", Questionable: "Q" };
const MAPPED = new Set((FX.player_status.mapped_mfl_ids || []).map(String));
await check("a disagreement (league-wide: MFL designates him, his team's posted Wk 6 report doesn't list him): both shown, in words too", () => {
  for (const pid of FX.unrostered_disagreements || []) {
    const m = ps[pid].mfl, s = S.one(pid), passed = !!(m.return_date && m.return_date < etDay(NOW));
    const mflTag = "MFL: " + SHORT_OF[m.status] + (passed ? " · est. return passed" : "");
    if (!MAPPED.has(pid)) {
      assert.deepStrictEqual(s.chips.map((c) => c.t), [mflTag], pid + " (no verified NFL id)");
      assert.ok(!s.disagree && s.lines.includes("NFL report: no verified NFL id, so he can’t be matched to it."), s.lines.join(" | "));
      continue;
    }
    assert.deepStrictEqual(s.chips.map((c) => c.t), [mflTag, "NFL Wk 6: not listed"], pid);
    assert.ok(s.disagree && s.lines.includes("MFL and the NFL Wk 6 report disagree: MFL lists " + m.status + (passed ? " (its estimated return has passed)" : "") + "; the report doesn’t list him."), s.lines.join(" | "));
  }
});
await check("an NFL-final-only case (nothing from MFL): \"NFL: Q (Wk 5 final)\", dashed, with the Wk 5 final line", () => {
  const r = table.find((x) => x.tags.length === 1 && /^NFL: \w+ \(Wk 5 final\)$/.test(x.tags[0].t));
  assert.ok(r, "present"); assert.strictEqual(r.tags[0].prior, true);
  assert.ok(r.lines.some((l) => /^NFL Wk 5 final: /.test(l)) && r.lines.some((l) => /^MFL: no designation/.test(l)), r.lines.join(" | "));
});
// MFL designations whose expected return has PASSED (2026-10-14: 43 of MFL's 218 Q/D/OUT rows
// league-wide, the oldest dated Sep 13). On UPS rosters today: those listed below. Game Day
// doesn't list taxi / IR-slot players, so for those the check is mobile Lineup (its bench lists
// them) against the sheet.
const today = etDay(NOW);
const pastRows = [];
for (const [fid, rs] of Object.entries(FX.rosters)) for (const r of rs) {
  const x = PS_ALL[r.id]; if (x && x.mfl && x.mfl.return_date && x.mfl.return_date < today) pastRows.push({ fid, pid: r.id, status: r.status, mfl: x.mfl });
}
await check("UPS-rostered players whose MFL estimated return has passed: \"MFL: Q · est. return passed\", dashed, the line says only the estimate passed — same on mobile Lineup and the sheet (Game Day too, when it lists him)", async () => {
  assert.ok(pastRows.length >= 1, "today's snapshot has " + pastRows.length);
  for (const r of pastRows) {
    const s = S.one(r.pid), mo = MOBILE_OUT[r.fid][r.pid], de = DESKTOP_OUT[r.fid][r.pid];
    assert.ok(/^MFL: (Q|D|OUT) · est\. return passed$/.test(s.chips.find((c) => /^MFL: (Q|D|OUT)/.test(c.t)).t) && s.chips.some((c) => /est\. return passed/.test(c.t) && c.prior), JSON.stringify(s.chips));
    assert.ok(s.lines.some((l) => /^MFL still lists him .+ \(MFL’s Wk 6 list; MFL status read at .+ ET\)\. Its expected return \(.+\) has passed; that’s an estimate, so this doesn’t mean he’s healthy or that the designation is wrong\.$/.test(l)), s.lines.join(" | "));
    assert.ok(mo, r.pid + " on mobile Lineup's bench"); assert.deepStrictEqual(mo.chips, s.chips, "mobile Lineup vs the sheet");
    if (mo.lines) assert.deepStrictEqual(mo.lines, s.lines);
    if (isActive(r)) { assert.ok(de, "on Game Day"); assert.deepStrictEqual(de.chips, s.chips); } else assert.strictEqual(de, undefined, "Game Day doesn't list taxi / IR-slot players");
    PAST_TABLE.push({ fid: r.fid, pid: r.pid, rosterStatus: r.status, name: PBYID[r.pid].name, pos: PBYID[r.pid].position, team: PBYID[r.pid].team, tags: s.chips, lines: s.lines,
      on: ["sheet", "mobile Lineup"].concat(de ? ["Game Day"] : []) });
  }
});
await check("an IR case: \"MFL: IR\" (MFL's roster designation) with its line", () => {
  const r = table.find((x) => x.tags.some((t) => t.t === "MFL: IR"));
  assert.ok(r, "present"); assert.ok(r.lines.some((l) => /^MFL roster: Injured reserve/.test(l)), r.lines.join(" | "));
});
await check("a player on his team's posted Wk 6 report with practice only (no game status yet): the MFL tag, and the NFL practice line beside it", () => {
  const r = table.find((x) => ps[x.pid] && ps[x.pid].report && !ps[x.pid].report.status && ps[x.pid].mfl);
  assert.ok(r, "present"); assert.ok(/^MFL: /.test(r.tags[0].t));
  assert.ok(r.lines.some((l) => /^NFL Wk 6 report: listed, no game status yet — .+ · practice: /.test(l)), r.lines.join(" | "));
});
console.log("\n4. constructed cases (every designation is set here, so nothing depends on a live snapshot's counts or on any real player staying Out)");
// One team's roster from the snapshot, used only for its shape (ids, positions, slots). The feeds and every status in
// the read are replaced, then each case below sets one player's NFL team and designations by hand. In this read only
// DEN and SEA have posted their Wk 6 report; NOREPORT has a game this week and hasn't.
const SYN = clone(SNAPSHOT);
Object.assign(SYN.player_status.report_feed, { ok: true, week: SYN.lineup_week, current_week: SYN.lineup_week, current: true, reason: null, teams: ["DEN", "SEA"], teams_mfl: ["DEN", "SEA"], prior_weeks: [] });
Object.assign(SYN.player_status.mfl_feed, { ok: true, week: SYN.lineup_week, reason: null });
Object.assign(SYN.player_status.roster_feed, { ok: true, week: SYN.lineup_week, reason: null });
const synFid = Object.keys(SYN.rosters).sort()[0];
const synReady = (pid) => MOBILE_OUT[synFid][pid] && MOBILE_OUT[synFid][pid].lines && DESKTOP_OUT[synFid][pid] && DESKTOP_OUT[synFid][pid].lines;
const synPids = SYN.rosters[synFid].filter(isActive).map((r) => r.id).filter((id) => SYN.players[id] && synReady(id));
const posted = SYN.player_status.report_feed.teams_mfl;
const NOREPORT = Object.keys(MU.matchups).sort().find((t) => !posted.includes(t));
const synNow = Date.parse(SYN.player_status.generated_utc);
const dayFrom = (n) => etDay(synNow + n * 86400e3);
const READ = /\(MFL’s Wk 6 list; MFL status read at .+ ET\)/.source;
const CASES = [
  { key: "MFL Q, his team's Wk 6 report not out yet", team: NOREPORT, mfl: { status: "Questionable", details: "Hamstring", return_date: dayFrom(5) },
    chips: ["MFL: Q"], prior: [false], disagree: false,
    lineRe: [new RegExp("^MFL: Questionable — Hamstring · Expected return: \\w{3} \\d+ " + READ + "\\.$"), new RegExp("^NFL Wk 6 report: not out yet for " + NOREPORT + " \\(or a bye\\)\\.$")] },
  { key: "MFL OUT, his team's Wk 6 report not out yet", team: NOREPORT, mfl: { status: "Out", details: "Knee" },
    chips: ["MFL: OUT"], prior: [false], disagree: false, lineRe: [new RegExp("^MFL: Out — Knee " + READ + "\\.$")] },
  { key: "MFL D whose estimated return has passed", team: NOREPORT, mfl: { status: "Doubtful", details: "Ankle", return_date: dayFrom(-3) },
    chips: ["MFL: D · est. return passed"], prior: [true], disagree: false,
    lineRe: [new RegExp("^MFL still lists him Doubtful — Ankle " + READ + "\\. Its expected return \\(\\w{3} \\d+\\) has passed; that’s an estimate, so this doesn’t mean he’s healthy or that the designation is wrong\\.$")] },
  { key: "disagreement: MFL OUT, not on DEN's posted report", team: "DEN", mfl: { status: "Out" },
    chips: ["MFL: OUT", "NFL Wk 6: not listed"], disagree: true, line: "MFL and the NFL Wk 6 report disagree: MFL lists Out; the report doesn’t list him." },
  { key: "disagreement: MFL Q, not on SEA's posted report", team: "SEA", mfl: { status: "Questionable" },
    chips: ["MFL: Q", "NFL Wk 6: not listed"], disagree: true, line: "MFL and the NFL Wk 6 report disagree: MFL lists Questionable; the report doesn’t list him." },
  { key: "disagreement: MFL Q, the report says Out", team: "DEN", mfl: { status: "Questionable" }, report: { status: "Out", injury: "Knee", team: "DEN" },
    chips: ["MFL: Q", "NFL: OUT (Wk 6)"], disagree: true, line: "MFL and the NFL Wk 6 report disagree: MFL lists Questionable; the report says Out." },
  { key: "agreement: MFL OUT and the report Out", team: "SEA", mfl: { status: "Out" }, report: { status: "Out", injury: "Knee", team: "SEA" },
    chips: ["MFL: OUT"], disagree: false, lineRe: [/^NFL Wk 6 report: Out — Knee \(updated .+ ET\)\.$/] },
  { key: "MFL Q on DEN, but no verified NFL id: MFL's tag alone, never \"not listed\"", team: "DEN", mfl: { status: "Questionable" }, unmapped: true,
    chips: ["MFL: Q"], disagree: false, line: "NFL report: no verified NFL id, so he can’t be matched to it." },
  { key: "nothing from MFL or the NFL", team: NOREPORT,
    chips: [], disagree: false, lineRe: [new RegExp("^MFL: no designation " + READ + "\\.$")] },
];
await check("constructed fixture: one roster with room for every case, a team with a posted report and one without", () => {
  assert.ok(synPids.length >= CASES.length, synPids.length + " players"); assert.deepStrictEqual([...posted].sort(), ["DEN", "SEA"]); assert.ok(NOREPORT);
});
SYN.player_status.players = {};
SYN.unrostered_disagreements = [];
CASES.forEach((c, i) => {
  const pid = c.pid = synPids[i];
  SYN.players[pid] = [SYN.players[pid][0], SYN.players[pid][1], c.team];
  const e = {};
  if (c.mfl) e.mfl = { week: SYN.lineup_week, updated_utc: SYN.player_status.mfl_feed.updated_utc, ...c.mfl };
  if (c.report) e.report = c.report;
  if (Object.keys(e).length) SYN.player_status.players[pid] = e;
});
// Every roster player has a verified NFL id except the one case that says otherwise.
SYN.player_status.mapped_mfl_ids = Object.keys(SYN.players).filter((id) => !CASES.some((c) => c.unmapped && c.pid === id));
useFixture(SYN);
const S4 = await sheet(), D4 = await desktop(synFid), M4 = await mobile(synFid);
allWrites.push(...S4.writes, ...D4.writes, ...M4.writes);
for (const c of CASES) {
  await check("constructed · " + c.key + ": " + (c.chips.length ? c.chips.join(" + ") : "no tag") + ", identical on Game Day, mobile Lineup and the sheet", () => {
    const s = S4.one(c.pid), d = D4.out[c.pid], m = M4.out[c.pid];
    assert.ok(d && d.lines, "on desktop's bench, with Details"); assert.ok(m && m.lines, "on mobile's bench, with Details");
    assert.deepStrictEqual(s.chips.map((x) => x.t), c.chips, "the tags");
    if (c.prior) assert.deepStrictEqual(s.chips.map((x) => x.prior), c.prior, "dashed or not");
    assert.deepStrictEqual(d.chips, s.chips, "desktop tags vs the sheet"); assert.deepStrictEqual(m.chips, s.chips, "mobile Lineup tags vs the sheet");
    assert.deepStrictEqual(d.lines, s.lines, "desktop Details vs the sheet"); assert.deepStrictEqual(m.lines, s.lines, "mobile Details vs the sheet");
    if (m.opt != null) assert.strictEqual(m.opt, s.opt, "mobile dropdown choice");
    assert.strictEqual(s.disagree, c.disagree, "disagreement flag");
    if (c.line) assert.ok(s.lines.includes(c.line), s.lines.join(" | "));
    if (!c.disagree) assert.ok(!s.lines.some((l) => /disagree/.test(l)), s.lines.join(" | "));
    for (const re of c.lineRe || []) assert.ok(s.lines.some((l) => re.test(l)), re + " in " + s.lines.join(" | "));
  });
}
await check("constructed · everyone else on the team (nothing designated): no tag on any surface", () => {
  const others = SYN.rosters[synFid].filter(isActive).map((r) => r.id).filter((id) => SYN.players[id] && !CASES.some((c) => c.pid === id));
  assert.ok(others.length > 0);
  for (const pid of others) {
    const s = S4.one(pid); assert.deepStrictEqual(s.chips, [], pid);
    if (D4.out[pid]) assert.deepStrictEqual(D4.out[pid].chips, [], pid);
    if (M4.out[pid]) assert.deepStrictEqual(M4.out[pid].chips, [], pid);
  }
});
useFixture(SNAPSHOT);

await check("nothing on any surface wrote anything (every request a GET)", () => { assert.deepStrictEqual(allWrites, []); });

if (process.env.PROOF_OUT) fs.writeFileSync(process.env.PROOF_OUT, JSON.stringify({ at: FX.player_status.generated_utc, compared, withLines, optCompared, withTags, table, past: PAST_TABLE,
  pastLeague: Object.values(PS_ALL).filter((x) => x.mfl && x.mfl.return_date && x.mfl.return_date < today).length,
  disagreement: (() => { const pid = FX.unrostered_disagreements[0]; const s = S.one(pid); return { pid, name: PBYID[pid].name, pos: PBYID[pid].position, team: PBYID[pid].team, tags: s.chips, lines: s.lines }; })(),
  note: Object.values(notes)[0][0] }, null, 1));
console.log(fails ? `\n${fails} FAILED (${passes} passed)` : `\nall ${passes} passed (${compared} players compared, ${withLines} with Details lines, ${optCompared} dropdown choices, ${withTags} tagged)`);
process.exit(fails ? 1 : 0);
