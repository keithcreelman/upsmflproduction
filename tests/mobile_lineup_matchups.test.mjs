// Mobile Lineup matchup info (site/m/views/lineup.js) and the Players picker line that
// shares it (views/players.js faIntelHtml), review #1249. The real view code runs in
// node:vm on a tree DOM, fed the draft worker's own 2026 Week 6 answer (read 2026-10-13
// 16:32 UTC). What's checked: one window and the Pts Agst board's words and color rule
// ("QBs +29% vs DEN", no good/tough tiers), the answer is for the week on screen, a
// failure says so and can be retried, Week 1's last-season numbers are labeled, "Next"
// shows byes, the line is a real button, and nothing here ever writes.
//   node tests/mobile_lineup_matchups.test.mjs
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { makeDocument, settle } from "./fixtures/tree_dom.mjs";

const read = (p) => fs.readFileSync(new URL("../" + p, import.meta.url), "utf8");
const FX = JSON.parse(read("tests/fixtures/lineup_matchups_2026_wk6.json"));
const LINEUP = read("site/m/views/lineup.js"), PLAYERS = read("site/m/views/players.js"), STATS = read("site/m/views/stats.js");
// The board's own color constant, read from stats.js (the app reads it through M.statsView).
const COLOR_K = JSON.parse(/var FPA_COLOR_K = (\{[^}]*\});/.exec(STATS)[1].replace(/(\w+):/g, '"$1":'));
const PBYID = Object.fromEntries(FX.players.map((p) => [p.id, p]));
const clone = (x) => JSON.parse(JSON.stringify(x));
function sliceFn(src, sig) { const at = src.indexOf(sig); let i = src.indexOf("{", at), d = 0; for (; i < src.length; i++) { if (src[i] === "{") d++; else if (src[i] === "}" && --d === 0) return src.slice(at, i + 1); } }

let fails = 0;
const check = async (n, fn) => { try { await fn(); console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };

// opts.lm(u) → { status, body } overrides /api/lineup-matchups; opts.liveWeek / projWeek
// = what /api/current-lineup-week and projectedScores say; opts.now = the clock.
function boot(opts) {
  opts = Object.assign({ liveWeek: 6, projWeek: 6, now: Date.parse("2026-10-13T17:00:00Z") }, opts || {});
  const doc = makeDocument(), mount = doc.mount("ups-m-main");
  const log = [], writes = [];
  let now = opts.now;
  const resp = (status, body) => ({ ok: status < 400, status, json: () => Promise.resolve(clone(body)) });
  const answer = (url) => {
    const u = new URL(url), q = (k) => u.searchParams.get(k);
    if (u.pathname === "/api/current-lineup-week") return resp(200, { ok: true, week: opts.liveWeek });
    if (u.pathname === "/api/lineup") return resp(200, { known: true, starters: FX.starters, state: "ok" });
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
  const held = [];
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
    statsView: opts.noStats ? undefined : { ptsAgstDefaults: { colorK: COLOR_K } },
    route: { renderRoute: () => env.render() },
  };
  const c = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, URLSearchParams, JSON, Math });
  c.window = c; c.document = doc; c.location = { search: "", href: "https://x.test/m/" }; c.fetch = fetch;
  c.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
  c.UPS_MOBILE = M;
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
  env.text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
  env.lmCalls = () => log.filter((x) => x.url.indexOf("/api/lineup-matchups") >= 0).map((x) => x.url.replace("https://w.test/api/lineup-matchups?", ""));
  env.open = async () => { env.render(); await settle(); env.render(); await settle(); };
  return env;
}
// What the chip should say for a player, straight from the fixture and the board's rule.
function want(pid, resp) {
  resp = resp || FX.response;
  const p = PBYID[pid], grp = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "PK", PN: "PN", DE: "DL", DT: "DL", LB: "LB", CB: "DB", S: "DB" }[p.position];
  const m = resp.matchups[p.team]; if (!m) return null;
  const r = (resp.defRatings[m.opp] || {})[grp];
  const pct = Math.round((r.ratio - 1) * 100), k = COLOR_K[grp];
  const colored = pct !== 0 && Math.abs((r.games * r.ratio + k) / (r.games + k) - 1) >= 0.08;
  const plural = { QB: "QBs", RB: "RBs", WR: "WRs", TE: "TEs", DL: "DL", LB: "LBs", DB: "DBs", PK: "Ks", PN: "Ps" }[grp];
  return { grp, opp: m.opp, m, r, colored, text: plural + " " + (pct === 0 ? "0%" : (pct > 0 ? "+" : "−") + Math.abs(pct) + "%") + " vs " + m.opp };
}
const ALLEN = "13589", THOMAS = "15814";   // QB (BUF) and a DE (ATL): real MFL ids from the fixture

console.log("1. the board's words and color rule");
{
  const e = boot(); await e.open();
  await check("Josh Allen's line: where, when, and the chip in the board's words (no rank, no good/tough)", () => {
    const w = want(ALLEN), t = e.text(e.line(ALLEN));
    assert.ok(t.indexOf((w.m.isHome ? "vs " : "@ ") + w.opp) === 0, t);
    assert.ok(t.indexOf(w.text) > 0, t + " ≠ " + w.text);
    assert.ok(!/#\d+ to /.test(t), "no rank on the line: " + t);
  });
  await check("no good/tough class or word anywhere on the screen", () => {
    assert.strictEqual(e.mount.querySelectorAll(".good, .tough").length, 0);
    assert.ok(!/\b(good|tough|easiest|expected)\b/i.test(e.text(e.mount)), "verdict word found");
  });
  await check("color only where the Pts Agst rule holds: every chip's up/dn class equals the rule's answer (starters + bench)", async () => {
    e.doc.getElementById("ups-m-bench-toggle").click(); await settle();
    let n = 0;
    for (const pid of FX.starters.concat(FX.bench)) {
      const w = want(pid); if (!w) continue;
      const chip = e.line(pid).querySelector(".ups-m-mu-chip");
      const cls = chip.attrs.class || "";
      assert.strictEqual(/\b(up|dn)\b/.test(cls), w.colored, pid + " " + cls);
      n++;
    }
    assert.ok(n >= 25, String(n));
  });
  await check("one window: no Season/L3/L5 buttons and one read for the week, without &last", () => {
    assert.strictEqual(e.mount.querySelectorAll(".ups-m-win-btn").length, 0);
    assert.deepStrictEqual(e.lmCalls(), ["YEAR=2026&W=6"]);
  });
  await check("one note says which games, when MFL was read, and that it's not a forecast; About has ≤ 3 sentences", () => {
    const n = e.mount.querySelector(".ups-m-mu-note"), t = e.text(n);
    assert.ok(/^Matchups: Wks 1–5\. MFL read \d{1,2}:\d\d (AM|PM)\. Games already played, not a forecast\./.test(t), t);
    const about = e.text(n.querySelector("details div"));
    assert.ok(about.split(/(?<=\.)\s+/).length <= 3, about);
    assert.ok(/Color appears only when the difference remains large after adjusting for small sample sizes\./.test(about));
  });
  await check("the line is a button with aria-expanded and a spoken sentence; tapping opens its card and keeps focus on it", async () => {
    const b = e.line(ALLEN);
    assert.strictEqual(b.tagName, "BUTTON"); assert.strictEqual(b.getAttribute("aria-expanded"), "false");
    assert.ok(/have scored \d+ percent (above|below) their usual \(Wks 1–5\)/.test(b.getAttribute("aria-label")) || /the same as their usual/.test(b.getAttribute("aria-label")), b.getAttribute("aria-label"));
    b.click(); await settle();
    const b2 = e.line(ALLEN);
    assert.strictEqual(b2.getAttribute("aria-expanded"), "true");
    assert.ok(e.doc.getElementById(b2.getAttribute("aria-controls")), "aria-controls points at the card");
    assert.strictEqual(e.doc.activeElement, b2, "focus is back on the tapped line");
  });
  await check("the card: Allowed and Usual a game, the %, #rank of 32 and the weeks — the board's numbers", () => {
    const w = want(ALLEN), card = e.doc.getElementById(e.line(ALLEN).getAttribute("aria-controls"));
    const t = e.text(card);
    const row = "QBs vs " + w.opp + ": " + w.r.perGame.toFixed(1) + " a game, usual " + w.r.usual.toFixed(1);
    assert.ok(t.indexOf(row) >= 0, t + "\n≠ " + row);
    assert.ok(t.indexOf("#" + w.r.rank + " of " + w.r.of + " · Wks 1–5") > 0, t);
    const pw = FX.response.playerWindow[ALLEN];
    assert.ok(t.indexOf("Avg " + pw.avg.toFixed(1) + " pts a game (Wks 1–5, " + pw.games + " games)") >= 0, t);
  });
  await check("opening a second card leaves the first open (the tapped line never jumps)", async () => {
    e.line(THOMAS).click(); await settle();
    assert.strictEqual(e.line(ALLEN).getAttribute("aria-expanded"), "true");
    assert.strictEqual(e.line(THOMAS).getAttribute("aria-expanded"), "true");
  });
  await check("an IDP's card names the opponent's OFFENSE (the team his points come against)", () => {
    const w = want(THOMAS), t = e.text(e.doc.getElementById(e.line(THOMAS).getAttribute("aria-controls")));
    assert.ok(t.indexOf("DL vs " + w.opp + "’s offense:") >= 0, t);
    assert.ok(/'s offense, defensive linemen have scored/.test(e.line(THOMAS).getAttribute("aria-label")), e.line(THOMAS).getAttribute("aria-label"));
  });
  await check("nothing on this screen wrote anything", () => { assert.deepStrictEqual(e.writes, []); });
}

console.log("\n2. a colored chip, the line, weather and Next");
{
  const r = clone(FX.response);
  const w0 = want(THOMAS);
  r.defRatings[w0.opp].DL = { rank: 1, of: 32, ratio: 1.5, games: 5, perGame: 12, usual: 8 };   // (5×1.5 + 20) ÷ 25 = 1.10 → colored
  const allenTeam = PBYID[ALLEN].team, opp = r.matchups[allenTeam].opp;
  r.matchups[allenTeam].spread = -3.5; r.matchups[opp].spread = 3.5;
  r.weather[allenTeam] = { tempF: 41, windMph: 18, precip: 0.2, summary: "Rain" }; r.weather[opp] = r.weather[allenTeam];
  const e = boot({ lm: () => ({ status: 200, body: r }) }); await e.open();
  await check("a gap that holds up after shrinking is colored 'up', and the chip still says it in words", () => {
    const chip = e.line(THOMAS).querySelector(".ups-m-mu-chip");
    assert.ok(/\bup\b/.test(chip.attrs.class), chip.attrs.class); assert.strictEqual(e.text(chip), "DL +50% vs " + w0.opp);
  });
  await check("without the board's constant (stats.js not loaded) nothing is colored, never a guess", async () => {
    const e2 = boot({ noStats: true, lm: () => ({ status: 200, body: r }) }); await e2.open();
    assert.strictEqual(e2.mount.querySelectorAll(".ups-m-mu-chip.up, .ups-m-mu-chip.dn").length, 0);
  });
  await check("spread in words (MFL's −3.5 = favored), and the forecast labeled as one", async () => {
    e.line(ALLEN).click(); await settle();
    const t = e.text(e.doc.getElementById(e.line(ALLEN).getAttribute("aria-controls")));
    assert.ok(t.indexOf("Favored by 3.5") >= 0, t);
    assert.ok(t.indexOf("Forecast at kickoff: 41°F · wind 18 mph · Rain · 0.2\" precip") >= 0, t);
    assert.ok(!/Line [+-]/.test(t));
  });
  await check("Next lists Wks 7–9 with a bye shown as a bye", () => {
    const t = e.text(e.doc.getElementById(e.line(ALLEN).getAttribute("aria-controls")));
    const hz = FX.response.horizon[allenTeam] || [], wks = FX.response.horizonWeeks;
    const want = wks.map((wk) => { const h = hz.find((x) => x.wk === wk); return h ? "Wk " + wk + " " + (h.isHome ? "" : "@") + h.opp : "Wk " + wk + " bye"; });
    assert.ok(t.indexOf("Next: " + want.join(" · ")) >= 0, t + "\n≠ Next: " + want.join(" · "));
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

console.log("\n3. the right week, failures, last season, freshness");
await check("the answer shown is for the week on screen: projections answer first with Wk 7, then the lineup week (6) → Wk 6's opponents", async () => {
  const r7 = clone(FX.response); for (const t in r7.matchups) r7.matchups[t].opp = "ZZZ";
  const e = boot({ projWeek: 7, liveWeek: 6, hold: /current-lineup-week/, lm: (u) => (u.searchParams.get("W") === "7" ? { status: 200, body: r7 } : null) });
  await e.open();
  assert.ok(/ZZZ/.test(e.text(e.line(ALLEN))), "while the week is still Wk 7, Wk 7's answer is shown");
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
await check("Week 1 before any game: last season's numbers, labeled on the chip and in the note", async () => {
  const r = clone(FX.response); r.priorSeason = true; r.ratingYear = "2025"; r.ratingsBasis = "2025 season"; r.weeksAvailable = 0;
  const e = boot({ lm: () => ({ status: 200, body: r }) }); await e.open();
  assert.ok(e.text(e.line(ALLEN)).indexOf(want(ALLEN).text + " (2025)") > 0, e.text(e.line(ALLEN)));
  assert.ok(/^No 2026 games yet, so the matchup numbers are from the 2025 season\./.test(e.text(e.mount.querySelector(".ups-m-mu-note"))));
});

console.log("\n4. the Players picker line");
await check("same chip and color rule, the season window, no rank and no hover-only explanation", async () => {
  const e = boot(); e.route = "players"; await e.open();
  const row = e.mount.querySelector('.ups-m-fa-row[data-pid="' + ALLEN + '"]'), t = e.text(row), w = want(ALLEN);
  assert.ok(t.indexOf((w.m.isHome ? "vs " : "@ ") + w.opp + " · " + w.text) >= 0, t);
  assert.ok(!row.querySelector("[title]"), "no tooltip-only meaning");
  assert.deepStrictEqual(e.lmCalls(), ["YEAR=2026&W=6"]);
  assert.deepStrictEqual(e.writes, []);
});

console.log(fails ? `\n${fails} FAILED` : "\nall passed");
process.exit(fails ? 1 : 0);
