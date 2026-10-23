// Mobile Lineup: the lineup week is asked again while the app stays open (#1277).
// The worker moves the week 7 h after week N's last kickoff; an app left open across that
// moment used to keep week N's opponents, projections, kickoffs, byes, injury week and
// lineup until a reload. The real view code (site/m/views/lineup.js) and the app's real
// injury/roster status loader (sliced from player_sheet.js) run in node:vm on a tree DOM,
// fed the 2026 Week 6 matchups fixture, with Week 7 built from the same fixture's
// "next" games (BUF is on bye in Week 7). Timers are fake (fired by hand); every request
// is logged; a non-GET is refused and counted. Submit is never clicked.
//   node tests/mobile_lineup_week_refresh.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { makeDocument, settle } from "./fixtures/tree_dom.mjs";

const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const FX = JSON.parse(read("tests/fixtures/lineup_matchups_2026_wk6.json"));
const LINEUP = process.env.LINEUP_JS ? fs.readFileSync(process.env.LINEUP_JS, "utf8") : read("site/m/views/lineup.js"), SHEET = read("site/m/player_sheet.js");
const PSTAT_SRC = SHEET.slice(SHEET.indexOf("  var PSTAT = (function () {"), SHEET.indexOf("  window.UPS_MOBILE_PLAYER_STATUS = PSTAT;") + "  window.UPS_MOBILE_PLAYER_STATUS = PSTAT;".length);
const PBYID = Object.fromEntries(FX.players.map((p) => [p.id, p]));
const clone = (x) => JSON.parse(JSON.stringify(x));

let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };

const ALLEN = "13589", GOFF = "12611", NIX = "16582", TAYLOR = "14802";   // real MFL ids from the fixture
const ROSTER = FX.starters.concat(FX.bench);
// MFL's saved lineup for each week: Week 7 starts Nix (DEN) instead of Goff (DET).
const SAVED = { 6: FX.starters, 7: FX.starters.map((p) => (p === GOFF ? NIX : p)) };
const T = (iso) => Date.parse(iso);
// Week 6: the fixture's real kickoffs (last game Tue 2026-10-20 00:15 UTC → the worker
// flips to Week 7 at 07:15 UTC). Week 7: the fixture's Week 7 opponents, a week later.
const WK6 = FX.response;
const WK7 = (() => {
  const r = clone(WK6); r.week = 7; r.matchups = {}; r.horizon = {}; r.horizonWeeks = [8, 9, 10];
  for (const [team, hz] of Object.entries(WK6.horizon)) {
    const h7 = hz.find((h) => h.wk === 7), m6 = WK6.matchups[team];
    if (h7) r.matchups[team] = { opp: h7.opp, isHome: h7.isHome, kickoff: (m6 ? m6.kickoff : 1792342800) + 7 * 86400, spread: null, status: "scheduled" };
    r.horizon[team] = hz.filter((h) => h.wk > 7);
  }
  return r;
})();
const LM = { 6: WK6, 7: WK7 };
function schedule(resp) {
  return { nflSchedule: { matchup: Object.entries(resp.matchups).filter(([t, m]) => m.isHome).map(([t, m]) => ({ kickoff: String(m.kickoff), team: [{ id: t }, { id: m.opp }] })) } };
}
// Byes: the teams with no game that week in the fixture (Week 6: Goff's DET among them).
const BYES = { 6: ["CIN", "DET", "MIA", "MIN"], 7: ["BUF", "LAC", "JAC", "WAS"] };
// /api/player-status: before the flip, Week 6's report (Taylor Q); after it, Week 7's isn't
// out yet, so the worker gives his Week 6 final designation as `prior` (a Details line, never a
// chip: Keith 2026-10-15). MFL's own export (mfl_feed, 2026-10-14) has no designation for him
// either week.
function statusBody(week) {
  const players = {};
  if (week === 6) players[TAYLOR] = { report: { status: "Questionable", injury: "Hamstring", practice: "Limited Participation in Practice" } };
  else players[TAYLOR] = { prior: { week: 6, status: "Questionable", injury: "Hamstring", team: "IND" } };
  return { ok: true, season: 2026, players, mapped_mfl_ids: ROSTER,
    report_feed: { ok: true, week: 6, current_week: week, current: week === 6, updated_utc: "2026-10-18T15:00:00Z", reason: week === 6 ? null : "Wk 7's report is not out yet",
      teams_mfl: week === 6 ? ["IND"] : [], prior_weeks: week === 6 ? [] : [6] },
    roster_feed: { ok: true, updated_utc: "2026-10-18T15:00:00Z" },
    mfl_feed: { ok: true, week, updated_utc: "2026-10-18T15:00:00Z", count: 0 } };
}

// opts.now; opts.lineup(w) → body override for GET /api/lineup; opts.hold: RegExp of
// requests held until env.release().
function boot(opts) {
  opts = Object.assign({ now: T("2026-10-18T12:00:00Z") }, opts || {});
  const doc = makeDocument(), mount = doc.mount("ups-m-main");
  const log = [], writes = [], held = [], timers = [], docL = {}, winL = {};
  let now = opts.now;
  const env = { doc, mount, log, writes, route: "myteam/lineup", liveWeek: 6 };
  const resp = (status, body) => ({ ok: status < 400, status, json: () => Promise.resolve(clone(body)) });
  const answer = (url) => {
    const u = new URL(url), q = (k) => u.searchParams.get(k);
    if (u.pathname === "/api/current-lineup-week") return resp(200, { ok: true, week: env.liveWeek, source: "live_scoring" });
    if (u.pathname === "/api/lineup") {
      const w = parseInt(q("W"), 10);
      if (opts.lineup) { const o = opts.lineup(w); if (o) return resp(o.status || 200, o.body); }
      return resp(200, { known: true, starters: (env.saved || SAVED)[w], state: "ok", week: w });
    }
    if (u.pathname === "/api/player-status") return resp(200, statusBody(env.liveWeek));
    if (u.pathname === "/api/lineup-matchups") return LM[q("W")] ? resp(200, LM[q("W")]) : resp(500, { ok: false });
    if (u.pathname === "/api/mfl-export") {
      const T2 = q("TYPE"), w = q("W");
      // MFL's keyless projections have already rolled to the next week (see reconcileProjWeek).
      if (T2 === "projectedScores") return resp(200, { projectedScores: { week: String(w || 7), playerScore: ROSTER.map((id, i) => ({ id, score: String((w || 7) === "6" ? 10 + i : 20 + i) })) } });
      if (T2 === "nflSchedule") return resp(200, schedule(LM[w] || WK6));
      if (T2 === "nflByeWeeks") return resp(200, { nflByeWeeks: { team: (BYES[w] || []).map((id) => ({ id, bye_week: w })) } });
    }
    return resp(404, { error: "unrouted " + url });
  };
  const fetch = (url, init) => {
    const method = (init && init.method) || "GET";
    log.push({ method, url: String(url) });
    if (method !== "GET") { writes.push(String(url)); return Promise.reject(new Error("write refused")); }
    if (opts.hold && opts.hold.test(String(url))) return new Promise((res) => held.push(() => res(answer(String(url)))));
    return Promise.resolve(answer(String(url)));
  };
  const U = { safeStr: (v) => (v == null ? "" : String(v).trim()), safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); } };
  U.escapeHtml = (v) => U.safeStr(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const M = {
    util: U,
    data: { playerById: (id) => PBYID[String(id)] || null,
      getRosterFor: () => ROSTER.map((id) => ({ id, status: "ROSTER", salary: 1000, contractYear: "2" })) },
    api: { workerUrl: (p) => "https://w.test" + p, getStoredMflUserId: () => "",
      mflExportUrl: (type, extra) => { let s = "https://w.test/api/mfl-export?TYPE=" + type; for (const k in extra || {}) s += "&" + k + "=" + extra[k]; return s; } },
    state: { ctx: { year: "2026", leagueId: "74598" }, viewerFranchiseId: "0001" },
    route: { renderRoute: () => env.render(), currentRoute: () => env.route },
  };
  // Long timers (the 5-minute re-check) are held for env.fire(); short ones run.
  const fakeSetTimeout = (fn, ms) => { if ((ms || 0) >= 1000) { timers.push({ fn, due: now + ms }); return timers.length; } return setTimeout(fn, ms); };
  const c = vm.createContext({ console, setTimeout: fakeSetTimeout, clearTimeout, Promise, URL, URLSearchParams, JSON, Math });
  c.window = c; c.document = doc; c.location = { search: "", href: "https://x.test/m/" }; c.fetch = fetch;
  doc.visibilityState = "visible";
  doc.addEventListener = (t, fn) => { (docL[t] = docL[t] || []).push(fn); };
  c.addEventListener = (t, fn) => { (winL[t] = winL[t] || []).push(fn); };
  c.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
  c.UPS_MOBILE = M;
  vm.runInContext(read("site/shared/injury_status.js"), c);
  vm.runInContext("(function () { var M = window.UPS_MOBILE, U = M.util, API = M.api, DATA = M.data;\n" + PSTAT_SRC + "\n})();", c);
  vm.runInContext(read("site/m/front_office_lineup.js"), c);
  vm.runInContext(read("site/shared/live_scoring.js"), c);
  vm.runInContext(read("site/m/season_scoring.js"), c);   // the page loads it first (index.html): the shared points formatter
  vm.runInContext(LINEUP, c);
  env.render = () => { if (/^myteam\/lineup/.test(env.route)) M.lineupView.render(mount); else mount.innerHTML = "<div>Home</div>"; };
  env.M = M;
  env.tickTo = (iso) => { now = T(iso); };
  env.tick = (ms) => { now += ms; };
  env.release = () => { while (held.length) held.shift()(); };
  // Fire every held timer that is due (a timer that re-arms is held again).
  env.fire = async () => { const due = timers.filter((t) => t.due <= now); due.forEach((t) => timers.splice(timers.indexOf(t), 1)); due.forEach((t) => t.fn()); await settle(); };
  env.timers = timers;
  env.hide = () => { doc.visibilityState = "hidden"; (docL.visibilitychange || []).forEach((f) => f({})); };
  env.show = async () => { doc.visibilityState = "visible"; (docL.visibilitychange || []).forEach((f) => f({})); await settle(); };
  env.pageshow = async (persisted) => { (winL.pageshow || []).forEach((f) => f({ persisted })); await settle(); };
  env.text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
  env.calls = (from) => log.slice(from || 0).map((x) => x.url.replace("https://w.test", ""));
  env.slots = () => Object.fromEntries(mount.querySelectorAll("select.ups-m-slot-sel").map((s) => [s.getAttribute("data-slot"), s.value]));
  env.starters = () => Object.values(env.slots()).filter(Boolean).sort();
  env.line = (pid) => mount.querySelector('.ups-m-slot-mu[data-mu-pid="' + pid + '"]');
  env.slotOf = (pid) => mount.querySelectorAll(".ups-m-slot").find((s) => (s.querySelector("select") || {}).value === pid) || null;
  // A starter's injury chip: on its own line right under his slot (2026-10-14).
  env.tagOf = (pid) => {
    const s = env.slotOf(pid); if (!s) return null;
    const sib = s.parentNode.children;
    for (let i = sib.indexOf(s) + 1; i < sib.length && !/(^|\s)ups-m-slot(\s|$)/.test(sib[i].attrs.class || ""); i++) {
      const c = sib[i].querySelector(".ups-m-inj-chip"); if (c) return c;
    }
    return null;
  };
  env.footer = () => mount.querySelector("#ups-m-lineup-submit");
  env.choice = () => doc.getElementById("ups-m-lu-wk-choice");
  env.msg = () => env.text(mount.querySelector(".ups-m-lineup-msg:not([id])") || mount.querySelectorAll(".ups-m-lineup-msg").find((m) => !m.getAttribute("id")));
  env.open = async () => { env.render(); await settle(); env.render(); await settle(); env.render(); await settle(); };
  // Pick a player in a slot the way the owner does (the select's change event).
  env.pick = async (fromPid, toPid) => { const sel = env.slotOf(fromPid).querySelector("select"); sel.value = toPid; sel.dispatch("change"); await settle(); };
  return env;
}
const sorted = (a) => a.slice().sort();
const reads = (calls) => calls.filter((u) => !/current-lineup-week/.test(u));

console.log("1. the same week: one question, nothing else read");
{
  const e = boot(); await e.open();
  await check("first open reads Week 6 (lineup, projections, kickoffs, byes, matchups) and arms the re-check timer", () => {
    const c = e.calls();
    assert.ok(c.includes("/api/lineup?W=6"), c.join("\n"));
    assert.ok(c.includes("/api/lineup-matchups?YEAR=2026&W=6"));
    assert.ok(c.includes("/api/mfl-export?TYPE=nflSchedule&W=6"));
    assert.deepStrictEqual(e.starters(), sorted(SAVED[6]));
    assert.strictEqual(e.timers.length, 1, "one 5-minute timer");
    assert.strictEqual(e.timers[0].due - T("2026-10-18T12:00:00Z"), 5 * 60 * 1000);
  });
  await check("back in the foreground after 2 minutes: one question (Week 6 again) and no other read, no repaint change", async () => {
    const n = e.log.length, html = e.mount.innerHTML;
    e.tick(2 * 60000); e.hide(); await e.show();
    assert.deepStrictEqual(e.calls(n), ["/api/current-lineup-week"]);
    assert.strictEqual(e.mount.innerHTML, html);
  });
  await check("back again 30 seconds later: not asked again (once a minute at most)", async () => {
    const n = e.log.length;
    e.tick(30000); e.hide(); await e.show(); await e.pageshow(true);
    assert.deepStrictEqual(e.calls(n), []);
  });
  await check("the 5-minute timer while Lineup is open: one question, no other read; it re-arms", async () => {
    const n = e.log.length;
    e.tick(3 * 60000); await e.fire();
    assert.deepStrictEqual(e.calls(n), ["/api/current-lineup-week"]);
    assert.strictEqual(e.timers.length, 1);
  });
  await check("off Lineup, the timer stops asking (and stops re-arming) until Lineup is drawn again", async () => {
    e.route = "home"; e.render();
    const n = e.log.length;
    e.tick(6 * 60000); await e.fire(); e.hide(); await e.show();
    assert.deepStrictEqual(e.calls(n), []);
    assert.strictEqual(e.timers.length, 0);
    e.route = "myteam/lineup"; e.render(); await settle();
    assert.strictEqual(e.calls(n).filter((u) => /current-lineup-week/.test(u)).length, 1, "Lineup drawn after > 5 min asks once");
    assert.ok(!e.calls(n).some((u) => /\/api\/lineup\?|projectedScores|nflSchedule|nflByeWeeks/.test(u)), e.calls(n).join(", "));
    assert.strictEqual(e.timers.length, 1);
  });
  await check("a hidden app's timer doesn't ask", async () => {
    const n = e.log.length;
    e.hide(); e.tick(6 * 60000); await e.fire();
    assert.deepStrictEqual(e.calls(n), []);
    await e.show();
  });
  await check("nothing wrote", () => { assert.deepStrictEqual(e.writes, []); });
}

console.log("\n2. the week flips while the app is open (no unsaved changes)");
async function flipped(how) {
  // Open Tuesday 06:00 UTC: Week 6 is still the lineup week (its last game kicked off at
  // 00:15 UTC; the worker flips at 07:15 UTC), so every Week 6 starter is locked.
  const e = boot({ now: T("2026-10-20T06:00:00Z") }); await e.open();
  const before = { locked: e.mount.querySelectorAll(".ups-m-slot.locked").length, allen: e.text(e.line(ALLEN)), taylor: e.text(e.tagOf(TAYLOR)) };
  const n = e.log.length;
  e.tickTo("2026-10-20T07:20:00Z"); e.liveWeek = 7;
  if (how === "timer") await e.fire();
  else if (how === "foreground") { e.hide(); await e.show(); }
  else if (how === "pageshow") { await e.pageshow(true); }
  await settle();
  const onEvent = e.calls(n);   // what the event itself set off, before anything else repaints
  e.render(); await settle(); e.render(); await settle();
  return { e, before, after: e.calls(n), onEvent };
}
{
  const { e, before, after, onEvent } = await flipped("timer");
  await check("before: Week 6, every starter with a Week 6 game locked (17; Goff's DET is on bye), Allen's Week 6 game, Taylor's Week 6 report chip (Q)", () => {
    assert.strictEqual(before.locked, 17);
    assert.ok(before.allen.indexOf("@ LVR") === 0, before.allen);
    assert.strictEqual(before.taylor, "Q");
  });
  await check("the 5-minute timer sees Week 7 and reads Week 7: the lineup, projections, kickoffs, byes, matchups and the injury status", () => {
    for (const u of ["/api/current-lineup-week", "/api/lineup?W=7", "/api/mfl-export?TYPE=projectedScores&W=7", "/api/mfl-export?TYPE=nflSchedule&W=7",
      "/api/mfl-export?TYPE=nflByeWeeks&W=7", "/api/lineup-matchups?YEAR=2026&W=7", "/api/player-status?season=2026&L=74598"]) assert.ok(onEvent.includes(u), u + " in\n" + onEvent.join("\n"));
    assert.ok(!after.some((u) => /W=6/.test(u)), "nothing for Week 6 again: " + after.join(", "));
  });
  await check("the screen is Week 7: MFL's Week 7 lineup (Nix, not Goff), Week 7 opponents, Allen's BYE, nothing locked", () => {
    assert.deepStrictEqual(e.starters(), sorted(SAVED[7]));
    const det = WK7.matchups.DEN;
    assert.ok(e.text(e.line(NIX)).indexOf((det.isHome ? "vs " : "@ ") + det.opp) === 0, e.text(e.line(NIX)));
    assert.ok(/\bbye\b/.test(e.slotOf(ALLEN).attrs.class), e.slotOf(ALLEN).attrs.class);
    assert.ok(e.text(e.mount).indexOf("BYE · Week 7 — bench him") >= 0);
    assert.strictEqual(e.mount.querySelectorAll(".ups-m-slot.locked").length, 0);
  });
  await check("the injury chip follows the week: Taylor's Week 6 report Q is no chip in Week 7 (its final is a Details line, never this week's)", async () => {
    assert.strictEqual(e.tagOf(TAYLOR), null);
    e.line(TAYLOR).click(); await settle();
    const card = e.mount.querySelector("#" + e.line(TAYLOR).getAttribute("aria-controls"));
    assert.ok(card.querySelectorAll(".ups-m-mu-inj").map((x) => e.text(x)).includes("Official NFL report for Week 6 (final): Questionable (Hamstring)"), e.text(card));
  });
  await check("one line says so: \"Week 6 is over: this screen now shows Week 7.\"", () => {
    assert.strictEqual(e.msg(), "Week 6 is over: this screen now shows Week 7.");
    assert.ok(!e.choice(), "no choice needed: nothing was unsaved");
  });
  await check("nothing wrote", () => { assert.deepStrictEqual(e.writes, []); });
}
for (const how of ["foreground", "pageshow"]) {
  const { e, onEvent } = await flipped(how);
  await check("back from the background (" + (how === "pageshow" ? "pageshow, restored page" : "visibilitychange") + ") the same way: Week 7's lineup and opponents", () => {
    assert.ok(onEvent.includes("/api/current-lineup-week") && onEvent.includes("/api/lineup?W=7"), onEvent.join(", "));
    assert.deepStrictEqual(e.starters(), sorted(SAVED[7]));
    assert.deepStrictEqual(e.writes, []);
  });
}
await check("a Week 6 lineup read still in flight when the week flips is dropped: the screen shows Week 7's", async () => {
  const e = boot({ now: T("2026-10-20T07:10:00Z"), hold: /\/api\/lineup\?W=6/ }); await e.open();
  assert.ok(/Loading your current lineup/.test(e.text(e.mount)));
  e.tickTo("2026-10-20T07:20:00Z"); e.liveWeek = 7; e.hide(); await e.show();
  e.render(); await settle();
  e.release(); await settle(); e.render(); await settle();
  assert.deepStrictEqual(e.starters(), sorted(SAVED[7]));
});

console.log("\n3. unsaved changes when the week flips: kept, and the owner chooses");
async function edited() {
  // Sunday morning: the owner starts Nix over Goff (both games still ahead) and doesn't submit.
  const e = boot({ now: T("2026-10-18T12:00:00Z") }); await e.open();
  await e.pick(GOFF, NIX);
  const draft = e.slots();
  // Tuesday, after the flip: back to the app.
  const n = e.log.length;
  e.tickTo("2026-10-20T08:00:00Z"); e.liveWeek = 7; e.hide(); await e.show();
  e.render(); await settle();
  return { e, draft, after: e.calls(n) };
}
{
  const { e, draft, after } = await edited();
  await check("one line + an explicit choice: \"Week 6 is over and Week 7 is open. Your unsaved changes are still below.\"", () => {
    assert.ok(e.choice(), "choice shown");
    assert.ok(e.text(e.choice()).indexOf("Week 6 is over and Week 7 is open. Your unsaved changes are still below.") === 0, e.text(e.choice()));
    assert.strictEqual(e.text(e.doc.getElementById("ups-m-lu-wk-load")), "Load my Week 7 lineup");
    assert.strictEqual(e.text(e.doc.getElementById("ups-m-lu-wk-keep")), "Keep my changes for Week 7");
  });
  await check("the changes are still on screen (Nix in Goff's slot), not replaced by Week 7's lineup, and Week 7's lineup isn't read yet", () => {
    assert.deepStrictEqual(e.slots(), draft);
    assert.ok(!after.includes("/api/lineup?W=7"), after.join(", "));
  });
  await check("nothing can be sent until the owner chooses: the button reads \"Choose above first (Week 7)\" and is disabled", () => {
    assert.strictEqual(e.text(e.footer()), "Choose above first (Week 7)");
    assert.ok(e.footer().hasAttribute("disabled"));
  });
  await check("the rest of the screen is Week 7 already (matchups read for Week 7)", () => {
    assert.ok(after.includes("/api/lineup-matchups?YEAR=2026&W=7"), after.join(", "));
  });
  await check("\"Load my Week 7 lineup\": reads Week 7's lineup from MFL and shows it; the choice goes away", async () => {
    const n = e.log.length;
    e.doc.getElementById("ups-m-lu-wk-load").click(); await settle(); e.render(); await settle();
    assert.ok(e.calls(n).includes("/api/lineup?W=7"));
    assert.deepStrictEqual(e.starters(), sorted(SAVED[7]));
    assert.ok(!e.choice());
    assert.notStrictEqual(e.text(e.footer()), "Choose above first (Week 7)");
  });
  await check("nothing wrote", () => { assert.deepStrictEqual(e.writes, []); });
}
await check("\"Keep my changes for Week 7\": Week 7's lineup is READ first, then the changes go on top, marked not submitted", async () => {
  const W7 = SAVED[7].filter((p) => p !== ALLEN).concat(["16617"]);   // MFL's Week 7 lineup differs (Coleman, not Allen)
  const { e, draft } = await edited();
  e.saved = { 6: SAVED[6], 7: W7 };
  const n = e.log.length;
  e.doc.getElementById("ups-m-lu-wk-keep").click(); await settle(); e.render(); await settle();
  assert.ok(e.calls(n).includes("/api/lineup?W=7"), "read before keeping");
  assert.deepStrictEqual(e.slots(), draft, "the owner's picks, slot for slot");
  assert.strictEqual(e.msg(), "Your changes are now for Week 7. Not submitted yet.");
  assert.ok(!e.choice());
  assert.notStrictEqual(e.text(e.footer()), "Choose above first (Week 7)");
  assert.deepStrictEqual(e.writes, []);
});
await check("\"Keep\" never goes on top of an unread lineup: Week 7's read fails → the read error, no editor, nothing to submit", async () => {
  const { e } = await (async () => {
    const e = boot({ now: T("2026-10-18T12:00:00Z"), lineup: (w) => (w === 7 ? { status: 502, body: { known: false, error: "MFL unavailable" } } : null) }); await e.open();
    await e.pick(GOFF, NIX);
    e.tickTo("2026-10-20T08:00:00Z"); e.liveWeek = 7; e.hide(); await e.show(); e.render(); await settle();
    return { e };
  })();
  e.doc.getElementById("ups-m-lu-wk-keep").click(); await settle(); e.render(); await settle();
  assert.ok(/Couldn’t read your current lineup from MFL/.test(e.text(e.mount)), e.text(e.mount));
  assert.strictEqual(e.mount.querySelectorAll("select.ups-m-slot-sel").length, 0);
  assert.ok(!e.footer());
});
await check("a lineup MFL accepted isn't \"unsaved\": after a successful submit the flip just loads Week 7 (no choice)", async () => {
  const e = boot({ now: T("2026-10-18T12:00:00Z") }); await e.open();
  await e.pick(GOFF, NIX);
  // What handleSubmit does around its POST (the POST itself is never sent here): busy +
  // repaint, then not busy + its success message + repaint.
  e.M.state.lineupSubmitting = true; e.render();
  e.M.state.lineupSubmitting = false; e.M.state.lineupMessage = { kind: "ok", text: "Lineup saved to MFL ✓ (Week 6)" }; e.render();
  e.tickTo("2026-10-20T08:00:00Z"); e.liveWeek = 7; e.hide(); await e.show(); e.render(); await settle();
  assert.ok(!e.choice());
  assert.deepStrictEqual(e.starters(), sorted(SAVED[7]));
});
await check("a submit that failed leaves the changes unsaved: the flip asks", async () => {
  const e = boot({ now: T("2026-10-18T12:00:00Z") }); await e.open();
  await e.pick(GOFF, NIX);
  e.M.state.lineupSubmitting = true; e.render();
  e.M.state.lineupSubmitting = false; e.M.state.lineupMessage = { kind: "err", text: "HTTP 500" }; e.render();
  e.tickTo("2026-10-20T08:00:00Z"); e.liveWeek = 7; e.hide(); await e.show(); e.render(); await settle();
  assert.ok(e.choice());
});
await check("a change put back the way MFL has it isn't \"unsaved\"", async () => {
  const e = boot({ now: T("2026-10-18T12:00:00Z") }); await e.open();
  await e.pick(GOFF, NIX); await e.pick(NIX, GOFF);
  e.tickTo("2026-10-20T08:00:00Z"); e.liveWeek = 7; e.hide(); await e.show(); e.render(); await settle();
  assert.ok(!e.choice());
  assert.deepStrictEqual(e.starters(), sorted(SAVED[7]));
});
await check("a flip while a submit is in flight waits for it: the week stays 6 until the submit settles", async () => {
  const e = boot({ now: T("2026-10-20T07:10:00Z") }); await e.open();
  e.M.state.lineupSubmitting = true;
  e.tickTo("2026-10-20T07:20:00Z"); e.liveWeek = 7; e.hide(); await e.show();
  assert.strictEqual(e.M.state.lineupWeek, 6);
  e.M.state.lineupSubmitting = false; e.render(); await settle(); e.render(); await settle();
  assert.strictEqual(e.M.state.lineupWeek, 7);
  assert.deepStrictEqual(e.starters(), sorted(SAVED[7]));
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
