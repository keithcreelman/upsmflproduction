// Mobile Lineup matchup info and injury status (site/m/views/lineup.js), and the Players
// picker line that shares it (views/players.js faIntelHtml), review #1249. The real view
// code — and the app's real injury/roster status loader, sliced from player_sheet.js —
// runs in node:vm on a tree DOM, fed the draft worker's own 2026 Week 6 answer (read
// 2026-10-13 16:32 UTC). Keith 2026-10-13: rank and color by MFL points allowed per game
// to the position (green = top 10, red = bottom 10), a pronounced Details button, and
// each player's injury status. Also: one window, the answer is for the week on screen,
// a failure says so and can be retried, Week 1's last-season ranks are labeled, "Next"
// shows byes, the line is a real button, and nothing here ever writes.
//   node tests/mobile_lineup_matchups.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { makeDocument, settle } from "./fixtures/tree_dom.mjs";

const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const FX = JSON.parse(read("tests/fixtures/lineup_matchups_2026_wk6.json"));
const LINEUP = read("site/m/views/lineup.js"), PLAYERS = read("site/m/views/players.js"), SHEET = read("site/m/player_sheet.js");
const PSTAT_SRC = SHEET.slice(SHEET.indexOf("  var PSTAT = (function () {"), SHEET.indexOf("  window.UPS_MOBILE_PLAYER_STATUS = PSTAT;") + "  window.UPS_MOBILE_PLAYER_STATUS = PSTAT;".length);
const PBYID = Object.fromEntries(FX.players.map((p) => [p.id, p]));
const clone = (x) => JSON.parse(JSON.stringify(x));
function sliceFn(src, sig) { const at = src.indexOf(sig); let i = src.indexOf("{", at), d = 0; for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) return src.slice(at, i + 1); } }

let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };

const ALLEN = "13589", THOMAS = "15814", TAYLOR = "14802", CHASE = "15281", DAVIS = "13710";   // real MFL ids from the fixture
// /api/player-status as the worker answers it: this week's official report (Q for a
// starter, OUT for a bench player) and an MFL roster designation (IR – to return).
function statusBody(o) {
  o = Object.assign({ week: 6, current: true }, o || {});
  const players = {};
  if (o.current) {
    players[TAYLOR] = { report: { status: "Questionable", injury: "Hamstring", practice: "Limited Participation in Practice" } };
    players[CHASE] = { report: { status: "Out", injury: "Ankle", practice: "Did Not Participate" } };
  }
  players[DAVIS] = { roster: { status: "IR-R", label: "Injured reserve – designated to return", chip: "IR-R" } };
  return { ok: true, season: 2026, players, mapped_mfl_ids: FX.starters.concat(FX.bench),
    report_feed: { ok: true, week: o.week, current_week: 6, current: o.current, updated_utc: "2026-10-14T20:00:00Z", reason: o.current ? null : "the newest report is Wk 5; Wk 6's is not out yet",
      teams_mfl: ["IND", "CIN", "BUF", "NEP", "ATL"] },
    roster_feed: { ok: true, updated_utc: "2026-10-14T16:00:00Z" } };
}

// opts.lm(u) → { status, body } overrides /api/lineup-matchups; opts.status → the
// /api/player-status body (or { fail: true }); opts.liveWeek / projWeek; opts.now.
function boot(opts) {
  opts = Object.assign({ liveWeek: 6, projWeek: 6, now: Date.parse("2026-10-14T21:00:00Z") }, opts || {});
  const doc = makeDocument(), mount = doc.mount("ups-m-main");
  const log = [], writes = [], held = [];
  let now = opts.now;
  const resp = (status, body) => ({ ok: status < 400, status, json: () => Promise.resolve(clone(body)) });
  const answer = (url) => {
    const u = new URL(url), q = (k) => u.searchParams.get(k);
    if (u.pathname === "/api/current-lineup-week") return resp(200, { ok: true, week: opts.liveWeek });
    if (u.pathname === "/api/lineup") return resp(200, { known: true, starters: FX.starters, state: "ok" });
    if (u.pathname === "/api/player-status") return opts.status && opts.status.fail ? resp(500, { ok: false }) : resp(200, opts.status || statusBody());
    if (u.pathname === "/api/lineup-matchups") {
      if (opts.lm) { const o = opts.lm(u); if (o) return resp(o.status, o.body); }
      return q("W") === "6" ? resp(200, FX.response) : resp(500, { ok: false, error: "no fixture" });
    }
    if (u.pathname === "/api/mfl-export") {
      const T = q("TYPE");
      if (T === "projectedScores") return resp(200, { projectedScores: { week: String(q("W") || opts.projWeek), playerScore: FX.starters.concat(FX.bench).map((id) => ({ id, score: "10" })) } });
      if (T === "nflSchedule") return resp(200, { nflSchedule: { matchup: [] } });
      if (T === "nflByeWeeks") return resp(200, { nflByeWeeks: { team: [] } });
    }
    return resp(404, { error: "unrouted " + url });
  };
  const fetch = (url, init) => {
    const method = (init && init.method) || "GET";
    log.push({ method, url: String(url) });
    if (method !== "GET") { writes.push(String(url)); return Promise.reject(new Error("write refused")); }
    // opts.hold: a request held back until env.release() (to force an answer order).
    if (opts.hold && opts.hold.test(String(url))) return new Promise((res) => held.push(() => res(answer(String(url)))));
    return Promise.resolve(answer(String(url)));
  };
  const U = { safeStr: (v) => (v == null ? "" : String(v).trim()), safeInt: (v, d) => { const n = parseInt(v, 10); return isFinite(n) ? n : (d == null ? 0 : d); } };
  U.escapeHtml = (v) => U.safeStr(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  const env = { doc, mount, log, writes, route: "lineup" };
  const M = {
    util: U,
    data: { playerById: (id) => PBYID[String(id)] || null,
      getRosterFor: () => FX.starters.concat(FX.bench).map((id) => ({ id, status: "ROSTER", salary: 1000, contractYear: "2" })) },
    api: { workerUrl: (p) => "https://w.test" + p, getStoredMflUserId: () => "",
      mflExportUrl: (type, extra) => { let s = "https://w.test/api/mfl-export?TYPE=" + type; for (const k in extra || {}) s += "&" + k + "=" + extra[k]; return s; } },
    state: { ctx: { year: "2026", leagueId: "74598" }, viewerFranchiseId: "0001" },
    route: { renderRoute: () => env.render() },
  };
  const c = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, URLSearchParams, JSON, Math });
  c.window = c; c.document = doc; c.location = { search: "", href: "https://x.test/m/" }; c.fetch = fetch;
  c.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
  c.UPS_MOBILE = M;
  if (!opts.noStatus) vm.runInContext("(function () { var M = window.UPS_MOBILE, U = M.util, API = M.api, DATA = M.data;\n" + PSTAT_SRC + "\n})();", c);
  vm.runInContext(read("site/m/front_office_lineup.js"), c);
  vm.runInContext(read("site/shared/live_scoring.js"), c);
  vm.runInContext(LINEUP, c);
  vm.runInContext("var M = window.UPS_MOBILE, U = M.util; function intel() { return M.lineupIntel || null; }" +
    "function projLabel() { return 'Wk 6 proj'; }\n" + sliceFn(PLAYERS, "function faIntelHtml(") + "\nthis.faIntelHtml = faIntelHtml;", c);
  env.render = () => {
    if (env.route === "lineup") return M.lineupView.render(mount);
    M.lineupIntel.load();
    mount.innerHTML = '<div class="ups-m-fa-list">' + FX.starters.concat(FX.bench).map((id) => '<div class="ups-m-fa-row" data-pid="' + id + '">' + c.faIntelHtml({ id }) + "</div>").join("") + "</div>";
  };
  env.M = M; env.tick = (ms) => { now += ms; };
  env.release = () => { while (held.length) held.shift()(); };
  env.line = (pid) => mount.querySelector('.ups-m-slot-mu[data-mu-pid="' + pid + '"]');
  env.card = (pid) => doc.getElementById(env.line(pid).getAttribute("aria-controls"));
  env.slot = (pid) => mount.querySelectorAll(".ups-m-slot").find((s) => (s.querySelector("select") || {}).value === pid) || null;
  env.text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
  env.lmCalls = () => log.filter((x) => x.url.indexOf("/api/lineup-matchups") >= 0).map((x) => x.url.replace("https://w.test/api/lineup-matchups?", ""));
  env.open = async () => { env.render(); await settle(); env.render(); await settle(); env.render(); await settle(); };
  env.bench = async () => { doc.getElementById("ups-m-bench-toggle").click(); await settle(); };
  return env;
}
const GRP = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "PK", PN: "PN", DE: "DL", DT: "DL", LB: "LB", CB: "DB", S: "DB" };
const PLURAL = { QB: "QBs", RB: "RBs", WR: "WRs", TE: "TEs", DL: "DL", LB: "LBs", DB: "DBs", PK: "Ks", PN: "Ps" };
const tierOf = (r, of) => (!(of >= 20) ? "" : (r <= 10 ? "good" : (r > of - 10 ? "tough" : "")));
// What the chip should say for a player, straight from the fixture.
function want(pid, resp) {
  resp = resp || FX.response;
  const p = PBYID[pid], grp = GRP[p.position];
  const m = resp.matchups[p.team]; if (!m) return null;
  const r = (resp.defRatings[m.opp] || {})[grp];
  return { grp, opp: m.opp, m, r, tier: tierOf(r.ppgRank, r.ppgOf), text: "#" + r.ppgRank + " vs " + PLURAL[grp] };
}

console.log("1. rank and color by MFL points allowed per game (Keith 2026-10-13)");
{
  const e = boot(); await e.open();
  await check("Josh Allen's line: where, when, and \"#rank vs QBs\" by points allowed per game (the opponent named once)", () => {
    const w = want(ALLEN), t = e.text(e.line(ALLEN));
    assert.ok(t.indexOf((w.m.isHome ? "vs " : "@ ") + w.opp) === 0, t);
    assert.ok(t.indexOf(w.text) > 0, t + " ≠ " + w.text);
    assert.strictEqual(t.split(w.opp).length - 1, 1, "opponent once: " + t);
  });
  await check("every chip is green for ranks 1–10 and red for the bottom 10, plain between (starters + bench)", async () => {
    await e.bench();
    let n = 0, colored = 0;
    for (const pid of FX.starters.concat(FX.bench)) {
      const w = want(pid); if (!w) continue;
      const chip = e.line(pid).querySelector(".ups-m-mu-chip"), cls = chip.attrs.class || "";
      assert.strictEqual(/\bgood\b/.test(cls) ? "good" : (/\btough\b/.test(cls) ? "tough" : ""), w.tier, pid + " #" + w.r.ppgRank + " " + cls);
      assert.strictEqual(e.text(chip), w.text);
      n++; if (w.tier) colored++;
    }
    assert.ok(n >= 25 && colored > 0, n + "/" + colored);
  });
  await check("one window: no Season/L3/L5 buttons and one read for the week, without &last", () => {
    assert.strictEqual(e.mount.querySelectorAll(".ups-m-win-btn").length, 0);
    assert.deepStrictEqual(e.lmCalls(), ["YEAR=2026&W=6"]);
  });
  await check("the note says what the rank is, the weeks, the colors and when MFL was read; About has ≤ 3 sentences with the measured size", () => {
    const n = e.mount.querySelector(".ups-m-mu-note"), t = e.text(n);
    assert.ok(/^Rank = MFL points allowed per game to the position, Wks 1–5 \(#1 = most\)\. Green: top 10 · red: bottom 10\. MFL read \d{1,2}:\d\d (AM|PM)\. Games already played, not a forecast\./.test(t), t);
    const about = e.text(n.querySelector("details div"));
    assert.ok(about.split(/(?<=\.)\s+/).length <= 3, about);
    assert.ok(/scored about 1 point more than facing one of the 10 allowing the least \(QB about 2\)\./.test(about), about);
  });
  await check("a pronounced Details button on every line: \"Details ▾\", then \"Hide ▴\"; the line is a button with aria-expanded and focus comes back", async () => {
    const b = e.line(ALLEN);
    assert.strictEqual(b.tagName, "BUTTON"); assert.strictEqual(b.getAttribute("aria-expanded"), "false");
    assert.strictEqual(e.text(b.querySelector(".ups-m-mu-more")), "Details ▾");
    assert.strictEqual(e.mount.querySelectorAll(".ups-m-mu-more").length, e.mount.querySelectorAll(".ups-m-slot-mu").length);
    assert.ok(/in MFL points allowed per game to quarterbacks/.test(b.getAttribute("aria-label")), b.getAttribute("aria-label"));
    b.click(); await settle();
    const b2 = e.line(ALLEN);
    assert.strictEqual(b2.getAttribute("aria-expanded"), "true"); assert.strictEqual(e.text(b2.querySelector(".ups-m-mu-more")), "Hide ▴");
    assert.ok(e.card(ALLEN), "aria-controls points at the card");
    assert.strictEqual(e.doc.activeElement, b2, "focus is back on the tapped line");
  });
  await check("the card: points allowed a game, #rank of 32 (tier colored), the weeks; his average; no 'vs usual' to contradict the chip", () => {
    const w = want(ALLEN), card = e.card(ALLEN), t = e.text(card);
    assert.ok(t.indexOf(w.opp + " allows QBs " + w.r.perGame.toFixed(1) + " a game: #" + w.r.ppgRank + " of " + w.r.ppgOf + " · Wks 1–5") >= 0, t);
    const rk = card.querySelector(".ups-m-mu-rk"); assert.strictEqual(/\b(good|tough)\b/.exec(rk.attrs.class || "") ? RegExp.lastMatch : "", w.tier);
    const pw = FX.response.playerWindow[ALLEN];
    assert.ok(t.indexOf("His avg " + pw.avg.toFixed(1) + " pts a game (Wks 1–5, " + pw.games + " games)") >= 0, t);
    assert.ok(!/vs usual/.test(t), t);
  });
  await check("opening a second card leaves the first open (the tapped line never jumps)", async () => {
    e.line(THOMAS).click(); await settle();
    assert.strictEqual(e.line(ALLEN).getAttribute("aria-expanded"), "true");
    assert.strictEqual(e.line(THOMAS).getAttribute("aria-expanded"), "true");
  });
  await check("an IDP's card names the opponent's OFFENSE (the team his points come against)", () => {
    const w = want(THOMAS), t = e.text(e.card(THOMAS));
    assert.ok(t.indexOf(w.opp + "’s offense allows DL " + w.r.perGame.toFixed(1) + " a game") >= 0, t);
    assert.ok(/'s offense is \d+(st|nd|rd|th) of \d+ in MFL points allowed per game to defensive linemen/.test(e.line(THOMAS).getAttribute("aria-label")), e.line(THOMAS).getAttribute("aria-label"));
  });
  await check("Next lists Wks 7–9 with each opponent's rank (tier colored) and a bye as a bye", () => {
    const team = PBYID[ALLEN].team, t = e.text(e.card(ALLEN));
    const hz = FX.response.horizon[team] || [];
    const exp = FX.response.horizonWeeks.map((wk) => { const h = hz.find((x) => x.wk === wk); return h ? "Wk " + wk + " " + (h.isHome ? "" : "@") + h.opp + " #" + FX.response.defRatings[h.opp].QB.ppgRank : "Wk " + wk + " bye"; });
    assert.ok(t.indexOf("Next: " + exp.join(" · ")) >= 0, t + "\n≠ Next: " + exp.join(" · "));
  });
  await check("nothing on this screen wrote anything", () => { assert.deepStrictEqual(e.writes, []); });
}

console.log("\n2. injury status (Keith 2026-10-13)");
{
  const e = boot(); await e.open(); await e.bench();
  await check("a starter on this week's report shows his chip under the slot's position label (Q)", () => {
    const s = e.slot(TAYLOR); assert.ok(s, "Taylor is a starter");
    const chip = s.querySelector(".ups-m-slot-tag .ups-m-inj-chip");
    assert.ok(chip, "chip in the slot tag"); assert.strictEqual(e.text(chip), "Q"); assert.ok(/\bq\b/.test(chip.attrs.class));
  });
  await check("the dropdown choice says it too (\"· Q\"), so it shows while picking", () => {
    const opt = e.slot(TAYLOR).querySelectorAll("option").find((o) => o.attrs.value === TAYLOR);
    assert.ok(/^Jonathan Taylor\s+·\s+IND\s+·\s+Q\s+·/.test(opt.textContent), opt.textContent);
  });
  await check("bench players show theirs (OUT from the report; IR-R from MFL)", () => {
    const chase = e.mount.querySelectorAll(".ups-m-bench-row").find((r) => /Chase/.test(r.textContent));
    const davis = e.mount.querySelectorAll(".ups-m-bench-row").find((r) => /Davis/.test(r.textContent));
    assert.strictEqual(e.text(chase.querySelector(".ups-m-inj-chip")), "OUT");
    assert.strictEqual(e.text(davis.querySelector(".ups-m-inj-chip")), "IR-R");
  });
  await check("Details shows the report line (status, injury, practice, source and time)", async () => {
    e.line(TAYLOR).click(); await settle();
    const t = e.text(e.card(TAYLOR));
    assert.ok(/Wk 6 injury report: Questionable — Hamstring · practice: Limited \(NFL report, updated .+ ET\)\./.test(t), t);
  });
  await check("one line says which report the tags come from", () => {
    assert.ok(/^Injury tags: NFL injury report Wk 6; IR\/PUP from MFL\./.test(e.text(e.mount.querySelector(".ups-m-mu-note.inj"))));
  });
  await check("this week's report not out yet: no Q/D/OUT tags, roster tags stay, and it says so (never 'healthy')", async () => {
    const e2 = boot({ status: statusBody({ week: 5, current: false }) }); await e2.open(); await e2.bench();
    assert.ok(!e2.slot(TAYLOR).querySelector(".ups-m-inj-chip"));
    assert.ok(e2.mount.querySelectorAll(".ups-m-inj-chip").every((c) => /\bres\b/.test(c.attrs.class)), "only roster chips");
    e2.line(TAYLOR).click(); await settle();
    assert.ok(!/injury report/i.test(e2.text(e2.card(TAYLOR))), "the card doesn't repeat the screen note: " + e2.text(e2.card(TAYLOR)));
    e2.line(DAVIS).click(); await settle();
    assert.ok(/Roster: Injured reserve – designated to return — MFL/.test(e2.text(e2.card(DAVIS))), e2.text(e2.card(DAVIS)));
    const n = e2.text(e2.mount.querySelector(".ups-m-mu-note.inj"));
    assert.ok(/Wk 6’s NFL report isn’t out or couldn’t be read, so no Q\/D\/OUT tags yet; IR\/PUP from MFL\. No tag doesn’t mean healthy\./.test(n), n);
  });
  await check("a current report for another week than the lineup's (Wk 5 on a Wk 6 lineup) never tags this week", async () => {
    const e3 = boot({ status: statusBody({ week: 5, current: true }) }); await e3.open();
    assert.ok(!e3.slot(TAYLOR).querySelector(".ups-m-inj-chip"));
    assert.ok(/Wk 6’s NFL report isn’t out yet \(the newest is Wk 5\)/.test(e3.text(e3.mount.querySelector(".ups-m-mu-note.inj"))));
  });
  await check("status unreadable: no tags, and the note says so", async () => {
    const e4 = boot({ status: { fail: true } }); await e4.open();
    assert.strictEqual(e4.mount.querySelectorAll(".ups-m-inj-chip").length, 0);
    assert.strictEqual(e4.text(e4.mount.querySelector(".ups-m-mu-note.inj")), "Injury status couldn’t be loaded. No tag doesn’t mean healthy.");
  });
  await check("the status is read once, not on every repaint", async () => {
    e.render(); await settle(); e.render(); await settle();
    assert.strictEqual(e.log.filter((x) => /player-status/.test(x.url)).length, 1);
  });
}

console.log("\n3. tiers, the line, weather");
{
  const r = clone(FX.response);
  const allenTeam = PBYID[ALLEN].team, opp = r.matchups[allenTeam].opp;
  r.matchups[allenTeam].spread = -3.5; r.matchups[opp].spread = 3.5;
  r.weather[allenTeam] = { tempF: 41, windMph: 18, precip: 0.2, summary: "Rain" }; r.weather[opp] = r.weather[allenTeam];
  const e = boot({ lm: () => ({ status: 200, body: r }) }); await e.open();
  await check("with fewer than 20 teams ranked (the first days of a season), nothing is colored", async () => {
    const r2 = clone(FX.response); for (const t in r2.defRatings) for (const g in r2.defRatings[t]) r2.defRatings[t][g].ppgOf = 12;
    const e2 = boot({ lm: () => ({ status: 200, body: r2 }) }); await e2.open();
    assert.strictEqual(e2.mount.querySelectorAll(".ups-m-mu-chip.good, .ups-m-mu-chip.tough").length, 0);
  });
  await check("spread in words (MFL's −3.5 = favored), and the forecast labeled as one", async () => {
    e.line(ALLEN).click(); await settle();
    const t = e.text(e.card(ALLEN));
    assert.ok(t.indexOf("Favored by 3.5") >= 0, t);
    assert.ok(t.indexOf("Forecast at kickoff: 41°F · wind 18 mph · Rain · 0.2\" precip") >= 0, t);
  });
  await check("a neutral-site game says so instead of a forecast; a dome says Indoors", async () => {
    const r2 = clone(r); r2.weather[allenTeam] = { neutral: true }; r2.weather[opp] = { neutral: true };
    const e3 = boot({ lm: () => ({ status: 200, body: r2 }) }); await e3.open();
    e3.line(ALLEN).click(); await settle();
    assert.ok(e3.text(e3.mount).indexOf("Neutral site: no forecast here") >= 0);
    r2.weather[allenTeam] = { dome: true };
    const e4 = boot({ lm: () => ({ status: 200, body: r2 }) }); await e4.open(); e4.line(ALLEN).click(); await settle();
    assert.ok(e4.text(e4.mount).indexOf("Indoors") >= 0);
  });
}

console.log("\n4. the right week, failures, last season, freshness");
await check("the answer shown is for the week on screen: projections answer first with Wk 7, then the lineup week (6) → Wk 6's opponents", async () => {
  const r7 = clone(FX.response); for (const t in r7.matchups) r7.matchups[t].opp = "ZZZ";
  const e = boot({ projWeek: 7, liveWeek: 6, hold: /current-lineup-week/, lm: (u) => (u.searchParams.get("W") === "7" ? { status: 200, body: r7 } : null) });
  await e.open();
  e.release(); await settle(); e.render(); await settle(); e.render(); await settle();
  assert.deepStrictEqual(e.lmCalls(), ["YEAR=2026&W=7", "YEAR=2026&W=6"]);
  assert.ok(e.text(e.line(ALLEN)).indexOf(want(ALLEN).opp) > 0, e.text(e.line(ALLEN)));
  assert.ok(!/ZZZ/.test(e.text(e.mount)));
});
await check("MFL down (502): no lines, a reason and Try again; tapping it reads again and the lines come back", async () => {
  let down = true;
  const e = boot({ lm: () => (down ? { status: 502, body: { ok: false, error: "mfl_unavailable" } } : null) });
  await e.open();
  assert.strictEqual(e.mount.querySelectorAll(".ups-m-slot-mu").length, 0);
  assert.ok(/Matchup numbers couldn’t be read from MFL right now\./.test(e.text(e.mount.querySelector(".ups-m-mu-note"))));
  down = false;
  e.doc.getElementById("ups-m-mu-retry").click(); await settle(); await settle();
  assert.ok(e.line(ALLEN), "lines back after Try again");
  assert.strictEqual(e.lmCalls().length, 2);
});
await check("a 200 that says ok:false is a failure too (never 'no matchups')", async () => {
  const e = boot({ lm: () => ({ status: 200, body: { ok: false } }) }); await e.open();
  assert.ok(e.mount.querySelector("#ups-m-mu-retry"));
});
await check("a failure is tried again by itself after a minute, not kept for the session", async () => {
  let n = 0;
  const e = boot({ lm: () => (++n === 1 ? { status: 500, body: { ok: false } } : null) }); await e.open();
  e.render(); await settle(); assert.strictEqual(e.lmCalls().length, 1, "not hammered");
  e.tick(61000); e.render(); await settle(); e.render(); await settle();
  assert.strictEqual(e.lmCalls().length, 2); assert.ok(e.line(ALLEN));
});
await check("a good answer is re-read after 5 minutes; a failed refresh keeps it and says so", async () => {
  let n = 0;
  const e = boot({ lm: () => (++n === 2 ? { status: 502, body: { ok: false, error: "mfl_unavailable" } } : null) }); await e.open();
  e.tick(4 * 60000); e.render(); await settle(); assert.strictEqual(e.lmCalls().length, 1);
  e.tick(2 * 60000); e.render(); await settle(); e.render(); await settle();
  assert.strictEqual(e.lmCalls().length, 2); assert.ok(e.line(ALLEN), "still shown");
  assert.ok(/Couldn’t refresh; showing MFL read/.test(e.text(e.mount.querySelector(".ups-m-mu-note"))));
});
await check("Week 1 before any game: last season's ranks, labeled on the chip and in the note", async () => {
  const r = clone(FX.response); r.priorSeason = true; r.ratingYear = "2025"; r.ratingsBasis = "2025 season"; r.weeksAvailable = 0;
  const e = boot({ lm: () => ({ status: 200, body: r }) }); await e.open();
  assert.ok(e.text(e.line(ALLEN)).indexOf(want(ALLEN).text + " (2025)") > 0, e.text(e.line(ALLEN)));
  assert.ok(/^No 2026 games yet, so the ranks are from the 2025 season\./.test(e.text(e.mount.querySelector(".ups-m-mu-note"))));
});

console.log("\n5. the Players picker line");
await check("same chip and tiers, one window, no rank-only tooltip", async () => {
  const e = boot(); e.route = "players"; await e.open();
  const row = e.mount.querySelector('.ups-m-fa-row[data-pid="' + ALLEN + '"]'), t = e.text(row), w = want(ALLEN);
  assert.ok(t.indexOf((w.m.isHome ? "vs " : "@ ") + w.opp + " · " + w.text) >= 0, t);
  assert.ok(!row.querySelector("[title]"), "no tooltip-only meaning");
  assert.deepStrictEqual(e.lmCalls(), ["YEAR=2026&W=6"]);
  assert.deepStrictEqual(e.writes, []);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
