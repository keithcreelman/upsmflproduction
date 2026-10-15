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
// list them), the one chip (text, color class, never dashed), the red "Injury sources disagree"
// warning (title and each source's line) and the detail lines must be identical.
// Keith 2026-10-15 (#1311): a chip is only the designation (Q, D, OUT, IR, PUP, SUSP), one per
// player, MFL's first; a disagreement is one chip plus the warning; no expected-return dates.
// Also: the live cases, constructed fixtures whose every case is fixed in this file (section 4,
// Keith's six examples: none of it depends on how many players a live snapshot happens to tag,
// or on what any real player's designation is), and nothing writes.
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
// The red warning block as { title, lines } (null when there's none), whichever surface drew it.
const warnOf = (el) => el ? { title: el.querySelector("b").textContent, lines: el.children.filter((c) => c.tagName === "DIV").map((c) => c.textContent) } : null;
const DESIG = "Q|D|OUT|IR|PUP|NFI|SUSP|HOLD|RET";

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
      warning: card ? warnOf(card.querySelector(".gd-mu-injwarn")) : null,
      lines: card ? card.querySelectorAll(".gd-mu-inj").map((l) => l.textContent) : null };
  }
  return { out, log, writes, note: (root.querySelector(".gd-mu-note.inj") || { textContent: "" }).textContent,
    about: (root.querySelector(".gd-mu-about-inj") || { textContent: "" }).textContent };
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
      warning: card ? warnOf(card.querySelector(".ups-m-inj-warn")) : null,
      lines: card ? card.querySelectorAll(".ups-m-mu-inj").map((l) => l.textContent) : null, opt: null };
  }
  // The dropdown choices (every slot lists every startable bench player): the injury part.
  for (const o of mount.querySelectorAll(".ups-m-slot-sel option")) {
    const pid = o.attrs.value; if (!pid || !out[pid] || out[pid].opt != null) continue;
    const m = new RegExp("\\s·\\s+(" + DESIG + ")(?=\\s+·|$)").exec(o.textContent);
    out[pid].opt = m ? m[1] : "";
  }
  return { out, log, writes, note: (mount.querySelector(".ups-m-mu-note.inj") || { textContent: "" }).textContent,
    about: (mount.querySelector(".ups-m-mu-about-inj") || { textContent: "" }).textContent };
}

// ── mobile player sheet: its statusHtml() is `PSTAT.resolve(pid, team, lineupWeek)` + `PSTAT.resolvedChipsHtml(res)` + `PSTAT.warningHtml(res)` + `res.lines` ──
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
    holder.innerHTML = "<div>" + PS.resolvedChipsHtml(res) + "</div>" + PS.warningHtml(res);
    return { chips: holder.querySelectorAll(".ups-m-inj-chip").map((b) => chipOf(b, /ups-m-inj-chip (\w+)/)), warning: warnOf(holder.querySelector(".ups-m-inj-warn")),
      lines: [...res.lines], disagree: res.disagree,   // (copied into this realm: deepStrictEqual compares prototypes)
      opt: c.UPSInjuryStatus.optText(res).replace(/^\s*·\s*/, "") };
  };
  return { one, log, writes, about: PS.aboutText(), note: PS.noteText(WEEK) };
}

console.log("1. the sheet renders exactly the resolver's chip, warning and lines (source check)");
await check("player_sheet.js statusHtml(): PSTAT.resolve(pid, team, lineupWeek) → resolvedChipsHtml(res) beside the name, warningHtml(res), res.lines one per line", () => {
  assert.match(SHEET, /function statusHtml\(\) \{\s*var res = PSTAT\.resolve\(pid, team, window\.UPS_MOBILE\.state\.lineupWeek \|\| null\);\s*return \{ chips: PSTAT\.resolvedChipsHtml\(res\), lines: res\.lines, warning: PSTAT\.warningHtml\(res\) \};\s*\}/);
  assert.match(SHEET, /\(U\.escapeHtml\(name\) \|\| \('Player ' \+ U\.escapeHtml\(pid\)\)\) \+ stNow\.chips \+/);
  assert.match(SHEET, /stNow\.warning \+\s*'<div class="ups-m-sheet-inj" id="ups-m-sheet-inj">' \+ stNow\.lines\.map\(function \(l\) \{ return '<div>' \+ U\.escapeHtml\(l\) \+ '<\/div>'; \}\)/);
  assert.match(GAMEDAY, /<script src="\.\.\/shared\/injury_status\.js\?v=[0-9.]+"><\/script>/, "Game Day loads the resolver cache-busted, so a cached old one can't bring back prefixed tags");
  assert.match(read("site/m/index.html"), /<script src="\.\.\/shared\/injury_status\.js\?v=[0-9.]+"><\/script>[\s\S]*<script src="\.\/player_sheet\.js\?v=/);
});

// One surface's view of one player vs the sheet's: the chip, the warning, the lines, the dropdown text.
function same(s, d, m, label) {
  assert.ok(s.chips.length <= 1, label + ": at most one chip");
  for (const c of s.chips) { assert.ok(new RegExp("^(" + DESIG + ")$").test(c.t), label + ": a plain designation, got " + c.t); assert.strictEqual(c.prior, false, label + ": never dashed"); }
  if (d) assert.deepStrictEqual(d.chips, s.chips, label + ": desktop chip vs the sheet");
  assert.deepStrictEqual(m.chips, s.chips, label + ": mobile Lineup chip vs the sheet");
  if (d && d.lines) { assert.deepStrictEqual(d.warning, s.warning, label + ": desktop warning vs the sheet"); assert.deepStrictEqual(d.lines, s.lines, label + ": desktop Details vs the sheet"); }
  if (m.lines) { assert.deepStrictEqual(m.warning, s.warning, label + ": mobile warning vs the sheet"); assert.deepStrictEqual(m.lines, s.lines, label + ": mobile Details vs the sheet"); }
  if (m.opt != null) assert.strictEqual(m.opt, s.opt, label + ": mobile dropdown choice");
  assert.strictEqual(!!s.warning, s.disagree, label + ": a warning exactly when the sources disagree");
}

console.log("\n2. the same player reads the same on all three surfaces (12 teams, live Week 6)");
const S = await sheet();
const table = [], PAST_TABLE = [], MOBILE_OUT = {}, DESKTOP_OUT = {};
const PS_ALL = FX.player_status.players;
let compared = 0, withLines = 0, withTags = 0, optCompared = 0, warned = 0;
const allWrites = [].concat(S.writes);
const notes = {};
for (const fid of Object.keys(FX.rosters).sort()) {
  const D = await desktop(fid), Mo = await mobile(fid);
  MOBILE_OUT[fid] = Mo.out; DESKTOP_OUT[fid] = D.out;
  allWrites.push(...D.writes, ...Mo.writes);
  notes[fid] = [D.note, Mo.note, D.about, Mo.about];
  for (const r of FX.rosters[fid].filter(isActive)) {
    const pid = r.id, s = S.one(pid), d = D.out[pid], m = Mo.out[pid];
    const p = PBYID[pid] || {};
    await check("team " + fid + " · " + (p.position || "?") + " " + (p.team || "?") + " (" + pid + "): chip, warning and lines match", () => {
      assert.ok(d, "on desktop's bench"); assert.ok(m, "on mobile's bench");
      same(s, d, m, pid);
      if (d.lines || m.lines) withLines++;
      if (m.opt != null) optCompared++;
    });
    compared++; if (s.chips.length) withTags++; if (s.warning) warned++;
    table.push({ fid, pid, name: p.name, pos: p.position, team: p.team, tags: s.chips, warning: s.warning, lines: s.lines, disagree: s.disagree });
  }
}
await check("the whole league was compared (every active-roster player; most with their Details lines and dropdown text)", () => {
  assert.ok(compared >= 300, compared); assert.ok(withLines >= compared * 0.8, withLines + "/" + compared); assert.ok(optCompared >= compared * 0.6, optCompared + "/" + compared);
  assert.ok(withTags >= 40, withTags);
});
await check("a healthy read: no screen note on either surface; About carries the one explanation on both", () => {
  for (const [fid, [dn, mn, da, ma]] of Object.entries(notes)) {
    assert.strictEqual(dn, "", fid + " desktop note"); assert.strictEqual(mn, "", fid + " mobile note");
    assert.strictEqual(da, S.about, fid + " desktop About"); assert.strictEqual(ma, S.about, fid + " mobile About");
  }
  assert.strictEqual(S.about, "Injury status uses MFL for the current designation and checks it against the official NFL report. If they disagree, the player page calls it out.");
  assert.strictEqual(S.note, "");
});

console.log("\n3. the live cases (Week 6, read " + FX.player_status.generated_utc + ")");
const ps = FX.player_status.players;
const SHORT_OF = { Out: "OUT", Doubtful: "D", Questionable: "Q" };
const MAPPED = new Set((FX.player_status.mapped_mfl_ids || []).map(String));
const POSTED = FX.player_status.report_feed.teams_mfl;
const mflLine = (m) => "MFL: " + m.status + (m.details ? " (" + m.details + ")" : "");
const NOT_LISTED = "Official NFL report: Not listed for Week " + FX.player_status.report_feed.week;
// Every such player the snapshot has, however many that is (none is fine: section 4 constructs them).
const mflOnly = table.filter((r) => ps[r.pid] && ps[r.pid].mfl && !ps[r.pid].report && !ps[r.pid].roster);
await check("players MFL designates that the official report doesn't (yet) list: MFL's plain chip; the warning only when his team's posted report can be matched to him", () => {
  for (const r of mflOnly) {
    const m = ps[r.pid].mfl;
    assert.deepStrictEqual(r.tags.map((c) => c.t), [SHORT_OF[m.status]], r.pid);
    if (MAPPED.has(r.pid) && POSTED.includes(r.team)) assert.deepStrictEqual(r.warning, { title: "Injury sources disagree", lines: [mflLine(m), NOT_LISTED] }, r.pid);
    else {
      assert.strictEqual(r.warning, null, r.pid);
      assert.ok(/^Official NFL report: (Week \d+ not posted yet for \w+ \(or a bye\)|No verified NFL id, so he can’t be matched|Free agent, not on a team’s report)$/.test(r.lines[1]), r.lines.join(" | "));
    }
  }
});
// Every league-wide case the snapshot has (MFL designates him; his team's posted Wk 6 report doesn't list him). The
// expected chip is whatever MFL's designation IS in the snapshot, never an assumed one. "Not listed" is only ever
// claimed for a player the report can be matched to (a verified NFL id); without one, there is no warning.
await check("a disagreement (league-wide: MFL designates him, his team's posted report doesn't list him): one chip, and the warning states each source", () => {
  assert.ok((FX.unrostered_disagreements || []).length >= 1);
  for (const pid of FX.unrostered_disagreements) {
    const m = ps[pid].mfl, s = S.one(pid);
    assert.deepStrictEqual(s.chips.map((c) => c.t), [SHORT_OF[m.status]], pid);
    if (!MAPPED.has(pid)) { assert.ok(!s.warning && s.lines.includes("Official NFL report: No verified NFL id, so he can’t be matched"), s.lines.join(" | ")); continue; }
    assert.deepStrictEqual(s.warning, { title: "Injury sources disagree", lines: [mflLine(m), NOT_LISTED] });
  }
});
await check("a previous week's final report only (nothing from MFL): no chip; the final is a detail line", () => {
  const r = table.find((x) => ps[x.pid] && ps[x.pid].prior && !ps[x.pid].mfl && !ps[x.pid].report && !ps[x.pid].roster);
  assert.ok(r, "present"); assert.deepStrictEqual([r.tags, r.warning], [[], null]);
  assert.ok(r.lines.some((l) => /^Official NFL report for Week \d+ \(final\): \w+/.test(l)) && r.lines.includes("MFL: No designation"), r.lines.join(" | "));
});
// MFL designations whose expected return has PASSED (2026-10-14: 43 of MFL's 218 Q/D/OUT rows
// league-wide). Keith 2026-10-15: no expected-return dates and no stale-style chip from them.
// Game Day doesn't list taxi / IR-slot players, so for those the check is mobile Lineup against the sheet.
const today = etDay(NOW);
const pastRows = [];
for (const [fid, rs] of Object.entries(FX.rosters)) for (const r of rs) {
  const x = PS_ALL[r.id]; if (x && x.mfl && x.mfl.return_date && x.mfl.return_date < today) pastRows.push({ fid, pid: r.id, status: r.status, mfl: x.mfl });
}
await check("UPS-rostered players whose MFL expected return has passed: the plain chip, solid; no date or 'return' wording anywhere — same on mobile Lineup, the sheet and Game Day", () => {
  assert.ok(pastRows.length >= 1, "today's snapshot has " + pastRows.length);
  for (const r of pastRows) {
    const s = S.one(r.pid), mo = MOBILE_OUT[r.fid][r.pid], de = DESKTOP_OUT[r.fid][r.pid];
    const text = s.chips.map((c) => c.t).concat(s.lines, s.warning ? s.warning.lines : []).join(" | ");
    assert.ok(!/return|passed|estimate|Sep \d|Oct \d/i.test(text), text);
    assert.ok(mo, r.pid + " on mobile Lineup's bench"); same(s, isActive(r) ? de : null, mo, r.pid);
    if (isActive(r)) assert.ok(de, "on Game Day"); else assert.strictEqual(de, undefined, "Game Day doesn't list taxi / IR-slot players");
    PAST_TABLE.push({ fid: r.fid, pid: r.pid, rosterStatus: r.status, name: PBYID[r.pid].name, pos: PBYID[r.pid].position, team: PBYID[r.pid].team, tags: s.chips, warning: s.warning, lines: s.lines,
      mflReturn: r.mfl.exp_return, on: ["sheet", "mobile Lineup"].concat(de ? ["Game Day"] : []) });
  }
});
await check("an IR case: \"IR\" (MFL's roster designation) with its line", () => {
  const r = table.find((x) => x.tags.some((t) => t.t === "IR"));
  assert.ok(r, "present"); assert.ok(r.lines.some((l) => /^MFL roster: Injured reserve/.test(l)) && !r.lines.includes("MFL: No designation"), r.lines.join(" | "));
});
await check("a player on his team's posted report with practice only (no game status yet): MFL's chip, no warning, the practice line", () => {
  const r = table.find((x) => ps[x.pid] && ps[x.pid].report && !ps[x.pid].report.status && ps[x.pid].report.practice && ps[x.pid].mfl);
  assert.ok(r, "present"); assert.deepStrictEqual([r.tags.length, r.warning], [1, null]);
  assert.ok(r.lines.some((l) => /^Official NFL report: Listed for Week 6, no game status yet( \(.+\))? · practice: /.test(l)), r.lines.join(" | "));
});

console.log("\n4. constructed cases: Keith's six examples (every designation is set here, so nothing depends on a live snapshot)");
// One team's roster from the snapshot, used only for its shape (ids, positions, slots): the team with the most
// players carrying Details on both surfaces. The feeds and every status in the read are replaced, then each case
// sets one player's NFL team and designations by hand. In these reads only DEN and SEA have posted their Wk 6
// report; NOREPORT has a game this week and hasn't.
const ready = (fid, pid) => MOBILE_OUT[fid][pid] && MOBILE_OUT[fid][pid].lines && DESKTOP_OUT[fid][pid] && DESKTOP_OUT[fid][pid].lines;
const synFid = Object.keys(SNAPSHOT.rosters).sort().map((fid) => [fid, SNAPSHOT.rosters[fid].filter(isActive).filter((r) => SNAPSHOT.players[r.id] && ready(fid, r.id)).length])
  .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0][0];
const synPids = SNAPSHOT.rosters[synFid].filter(isActive).map((r) => r.id).filter((id) => SNAPSHOT.players[id] && ready(synFid, id));
const NOREPORT = Object.keys(MU.matchups).sort().find((t) => !["DEN", "SEA"].includes(t));
const synNow = Date.parse(SNAPSHOT.player_status.generated_utc);
const dayFrom = (n) => etDay(synNow + n * 86400e3);
const W = SNAPSHOT.lineup_week;
const NOT_POSTED = "Official NFL report: Week " + W + " not posted yet for " + NOREPORT + " (or a bye)";
const WARN = (a, b) => ({ title: "Injury sources disagree", lines: [a, b] });
const KNEE_OUT = { status: "Out", injury: "Knee", practice: "Did Not Participate In Practice" };
const READS = [
  { name: "both sources read", feeds: {}, note: "", cases: [
    { key: "1. MFL Q, his team's report not out yet", team: NOREPORT, mfl: { status: "Questionable", details: "Hamstring", exp_return: "Oct 19, 2026", return_date: dayFrom(5) },
      chips: ["Q"], warning: null, lines: ["MFL: Questionable (Hamstring)", NOT_POSTED] },
    { key: "1. MFL Q, not on SEA's posted report", team: "SEA", mfl: { status: "Questionable", details: "Ankle" },
      chips: ["Q"], warning: WARN("MFL: Questionable (Ankle)", "Official NFL report: Not listed for Week " + W), lines: [] },
    { key: "1. MFL OUT, not on DEN's posted report", team: "DEN", mfl: { status: "Out" },
      chips: ["OUT"], warning: WARN("MFL: Out", "Official NFL report: Not listed for Week " + W), lines: [] },
    { key: "2. agree: MFL OUT, the report Out", team: "SEA", mfl: { status: "Out" }, report: { ...KNEE_OUT, team: "SEA" },
      chips: ["OUT"], warning: null, lines: ["MFL: Out", "Official NFL report: Out for Week " + W + " (Knee) · practice: did not practice"] },
    { key: "2. agree on nothing: no MFL designation, not on SEA's report", team: "SEA",
      chips: [], warning: null, lines: ["MFL: No designation", "Official NFL report: Not listed for Week " + W] },
    { key: "3. differ: MFL Q, the report Out", team: "DEN", mfl: { status: "Questionable" }, report: { ...KNEE_OUT, team: "DEN" },
      chips: ["Q"], warning: WARN("MFL: Questionable", "Official NFL report: Out for Week " + W + " (Knee)"), lines: ["Practice (official report): did not practice"] },
    { key: "4. MFL has none, the report Out", team: "DEN", report: { ...KNEE_OUT, team: "DEN" },
      chips: ["OUT"], warning: WARN("MFL: No designation", "Official NFL report: Out for Week " + W + " (Knee)"), lines: ["Practice (official report): did not practice"] },
    { key: "5. IR (MFL's IR-R) and the report's Q: never compared", team: "DEN", roster: { chip: "IR-R", label: "Injured reserve – designated to return", detail: "Knee", exp_return: "Nov 15, 2026" },
      report: { status: "Questionable", injury: "Knee", team: "DEN" },
      chips: ["IR"], warning: null, lines: ["MFL roster: Injured reserve – designated to return (Knee)", "Official NFL report: Questionable for Week " + W + " (Knee)"] },
    { key: "5. PUP", team: "SEA", roster: { chip: "PUP", label: "Physically unable to perform", detail: null },
      chips: ["PUP"], warning: null, lines: ["MFL roster: Physically unable to perform", "Official NFL report: Not listed for Week " + W] },
    { key: "MFL D whose expected return has passed: plain, no date", team: NOREPORT, mfl: { status: "Doubtful", details: "Ankle", exp_return: "Oct 11, 2026", return_date: dayFrom(-3) },
      chips: ["D"], warning: null, lines: ["MFL: Doubtful (Ankle)", NOT_POSTED] },
    { key: "MFL Q on DEN, no verified NFL id: never \"not listed\"", team: "DEN", mfl: { status: "Questionable" }, unmapped: true,
      chips: ["Q"], warning: null, lines: ["MFL: Questionable", "Official NFL report: No verified NFL id, so he can’t be matched"] },
  ] },
  // MFL's export failing, as the worker sends it (worker/src/player_status.js assemble()): no MFL
  // week, so the report can't be this week's either, and MFL's roster designations are unknown too.
  { name: "MFL's injury list unreadable", feeds: { mfl_feed: { ok: false, reason: "unreadable: HTTP 500" }, roster_feed: { ok: false, reason: "unreadable: HTTP 500" },
      report_feed: { ok: true, current: false, reason: "current NFL week unknown (MFL unreadable)" } },
    note: "Injury status couldn’t be read, so injury tags may be missing.", cases: [
    { key: "6. MFL unreadable: nothing can be tagged", team: "DEN",
      chips: [], warning: null, lines: ["MFL: Couldn’t be read", "Official NFL report: The current NFL week couldn’t be read"] },
  ] },
  { name: "the official report unreadable", feeds: { report_feed: { ok: false, current: false, reason: "unreadable: HTTP 502", teams: [], teams_mfl: [] } },
    note: "The official NFL report can’t be checked right now; tags are MFL’s alone.", cases: [
    { key: "6. the report unreadable, MFL Q", team: "DEN", mfl: { status: "Questionable", details: "Hip" },
      chips: ["Q"], warning: null, lines: ["MFL: Questionable (Hip)", "Official NFL report: Couldn’t be read"] },
  ] },
  { name: "the official report too old", feeds: { report_feed: { ok: true, current: false, reason: "report not updated for 40 h" } },
    note: "The official NFL report can’t be checked right now; tags are MFL’s alone.", cases: [
    { key: "6. the report too old, MFL Q (its old Out never used)", team: "DEN", mfl: { status: "Questionable", details: "Hip" }, report: { status: "Out", injury: "Knee", team: "DEN" },
      chips: ["Q"], warning: null, lines: ["MFL: Questionable (Hip)", "Official NFL report: Not updated recently"] },
  ] },
];
await check("constructed fixtures: one roster with room for every case, a team with a posted report and one without", () => {
  assert.ok(synPids.length >= Math.max(...READS.map((r) => r.cases.length)), synPids.length + " players"); assert.ok(NOREPORT);
});
const CASE_OUT = [];
for (const RD of READS) {
  const SYN = clone(SNAPSHOT);
  Object.assign(SYN.player_status.report_feed, { ok: true, week: W, current_week: W, current: true, reason: null, teams: ["DEN", "SEA"], teams_mfl: ["DEN", "SEA"], prior_weeks: [] }, RD.feeds.report_feed || {});
  Object.assign(SYN.player_status.mfl_feed, { ok: true, week: W, reason: null }, RD.feeds.mfl_feed || {});
  Object.assign(SYN.player_status.roster_feed, { ok: true, week: W, reason: null }, RD.feeds.roster_feed || {});
  SYN.player_status.players = {};
  RD.cases.forEach((c, i) => {
    const pid = c.pid = synPids[i];
    SYN.players[pid] = [SYN.players[pid][0], SYN.players[pid][1], c.team];
    const e = {};
    if (c.mfl && !RD.feeds.mfl_feed) e.mfl = { week: W, updated_utc: SYN.player_status.mfl_feed.updated_utc, details: null, ...c.mfl };
    if (c.roster) e.roster = c.roster;
    if (c.report && !RD.feeds.report_feed) e.report = c.report;
    else if (c.report) e.report = c.report;   // the too-old variant: an entry the resolver must not use
    if (Object.keys(e).length) SYN.player_status.players[pid] = e;
  });
  // Every roster player has a verified NFL id except the one case that says otherwise.
  SYN.player_status.mapped_mfl_ids = Object.keys(SYN.players).filter((id) => !RD.cases.some((c) => c.unmapped && c.pid === id));
  useFixture(SYN);
  const S4 = await sheet(), D4 = await desktop(synFid), M4 = await mobile(synFid);
  allWrites.push(...S4.writes, ...D4.writes, ...M4.writes);
  for (const c of RD.cases) {
    await check(RD.name + " · " + c.key + ": " + (c.chips.length ? c.chips.join(" + ") : "no chip") + (c.warning ? " + the warning" : "") + ", identical on Game Day, mobile Lineup and the sheet", () => {
      const s = S4.one(c.pid), d = D4.out[c.pid], m = M4.out[c.pid];
      assert.ok(d && d.lines, "on desktop's bench, with Details"); assert.ok(m && m.lines, "on mobile's bench, with Details");
      assert.deepStrictEqual(s.chips.map((x) => x.t), c.chips, "the chip");
      assert.deepStrictEqual(s.warning, c.warning, "the warning");
      assert.deepStrictEqual(s.lines, c.lines, "the lines");
      same(s, d, m, c.key);
    });
    const s = S4.one(c.pid);
    CASE_OUT.push({ read: RD.name, key: c.key, team: c.team, chips: s.chips, warning: s.warning, lines: s.lines, mflReturn: c.mfl && c.mfl.exp_return || null });
  }
  await check(RD.name + " · the screen note on both surfaces: " + (RD.note ? "“" + RD.note + "”" : "none"), () => {
    assert.strictEqual(D4.note, RD.note); assert.strictEqual(M4.note, RD.note); assert.strictEqual(S4.note, RD.note);
  });
  if (!RD.feeds.mfl_feed && !RD.feeds.report_feed) {
    await check(RD.name + " · everyone else on the team (nothing designated by either source): no chip, no warning on any surface", () => {
      const others = SYN.rosters[synFid].filter(isActive).map((r) => r.id).filter((id) => SYN.players[id] && !RD.cases.some((c) => c.pid === id));
      assert.ok(others.length > 0);
      for (const pid of others) {
        const s = S4.one(pid); assert.deepStrictEqual([s.chips, s.warning], [[], null], pid);
        if (D4.out[pid]) assert.deepStrictEqual([D4.out[pid].chips, D4.out[pid].warning], [[], null], pid);
        if (M4.out[pid]) assert.deepStrictEqual([M4.out[pid].chips, M4.out[pid].warning], [[], null], pid);
      }
    });
  }
}
useFixture(SNAPSHOT);

await check("nothing on any surface wrote anything (every request a GET)", () => { assert.deepStrictEqual(allWrites, []); });

if (process.env.PROOF_OUT) fs.writeFileSync(process.env.PROOF_OUT, JSON.stringify({ at: FX.player_status.generated_utc, compared, withLines, optCompared, withTags, warned, table, past: PAST_TABLE,
  pastLeague: Object.values(PS_ALL).filter((x) => x.mfl && x.mfl.return_date && x.mfl.return_date < today).length,
  disagreement: (() => { const pid = FX.unrostered_disagreements[0]; const s = S.one(pid); return { pid, name: PBYID[pid].name, pos: PBYID[pid].position, team: PBYID[pid].team, tags: s.chips, warning: s.warning, lines: s.lines }; })(),
  cases: CASE_OUT, about: S.about }, null, 1));
console.log(fails ? `\n${fails} FAILED (${passes} passed)` : `\nall ${passes} passed (${compared} players compared, ${withLines} with Details lines, ${optCompared} dropdown choices, ${withTags} tagged, ${warned} with the warning)`);
process.exit(fails ? 1 : 0);
