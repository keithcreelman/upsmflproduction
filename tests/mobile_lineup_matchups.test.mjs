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
// /api/player-status as the worker answers it (worker/src/player_status.js, 2026-10-14):
// MFL's own Q / D / Out in `mfl` (with the export's week), this week's official report,
// last week's final (`prior`) and MFL's roster designation (IR – to return).
//   Allen  MFL Q, his team (BUF) posted its Wk 6 report without him  → a disagreement
//   Taylor MFL Q, and the official report says Q too                    → they agree
//   Thomas MFL D, a return date already past, ATL hasn't reported yet
//   Chase  no MFL designation, the official report says Out             → a disagreement
//   Davis  MFL roster IR-R
// o.week/current: the report's week and whether it's this week's; o.prior: last week's
// final for teams without a current report; o.mflWeek: the MFL export's week.
function statusBody(o) {
  o = Object.assign({ week: 6, current: true, prior: false, mflWeek: 6 }, o || {});
  const at = "2026-10-14T12:01:04.000Z";
  const mfl = (status, details, exp, date) => ({ status, week: o.mflWeek, updated_utc: at, details, exp_return: exp, return_date: date });
  const players = {};
  const put = (id, k, v) => { (players[id] = players[id] || {})[k] = v; };
  put(ALLEN, "mfl", mfl("Questionable", "Ankle", "Oct 18, 2026", "2026-10-18"));
  put(TAYLOR, "mfl", mfl("Questionable", "Hamstring", "Oct 18, 2026", "2026-10-18"));
  put(THOMAS, "mfl", mfl("Doubtful", "Knee", "Oct 11, 2026", "2026-10-11"));
  if (o.current) {
    put(TAYLOR, "report", { status: "Questionable", injury: "Hamstring", practice: "Limited Participation in Practice" });
    if (!o.prior) put(CHASE, "report", { status: "Out", injury: "Ankle", practice: "Did Not Participate" });
  }
  if (o.prior) {
    if (!o.current) put(TAYLOR, "prior", { week: 5, status: "Questionable", injury: "Hamstring", team: "IND" });
    put(CHASE, "prior", { week: 5, status: "Out", injury: "Ankle", team: "CIN" });
  }
  put(DAVIS, "roster", { status: "IR-R", label: "Injured reserve – designated to return", chip: "IR-R" });
  return { ok: true, season: 2026, players, mapped_mfl_ids: FX.starters.concat(FX.bench),
    report_feed: { ok: true, week: o.week, current_week: o.mflWeek, current: o.current, updated_utc: "2026-10-14T20:00:00Z", reason: o.current ? null : "the newest report is Wk 5; Wk 6's is not out yet",
      teams_mfl: o.prior && o.current ? ["IND"] : ["IND", "CIN", "BUF", "NEP"], prior_weeks: o.prior ? [5] : [] },
    roster_feed: { ok: true, week: o.mflWeek, updated_utc: at },
    mfl_feed: { ok: true, week: o.mflWeek, read_utc: "2026-10-14T12:58:00.000Z", updated_utc: at, count: 3 } };   // read_utc: OUR read (8:58 AM ET); updated_utc: MFL's file time, never shown
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
  vm.runInContext(read("site/shared/injury_status.js"), c);
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
  env.M = M; env.c = c; env.tick = (ms) => { now += ms; };
  env.release = () => { while (held.length) held.shift()(); };
  env.line = (pid) => mount.querySelector('.ups-m-slot-mu[data-mu-pid="' + pid + '"]');
  env.card = (pid) => doc.getElementById(env.line(pid).getAttribute("aria-controls"));
  env.slot = (pid) => mount.querySelectorAll(".ups-m-slot").find((s) => (s.querySelector("select") || {}).value === pid) || null;
  // A starter's injury tags: their own line right under his slot (they name source + week).
  env.slotChips = (pid) => {
    const s = env.slot(pid); if (!s) return [];
    const sib = s.parentNode.children, out = [];
    for (let i = sib.indexOf(s) + 1; i < sib.length && !/(^|\s)ups-m-slot(\s|$)/.test(sib[i].attrs.class || "") && !/ups-m-slot-mu/.test(sib[i].attrs.class || ""); i++)
      out.push(...sib[i].querySelectorAll(".ups-m-inj-chip"));
    return out;
  };
  env.benchChips = (name) => { const r = mount.querySelectorAll(".ups-m-bench-row").find((x) => new RegExp(name).test(x.textContent)); return r ? r.querySelectorAll(".ups-m-inj-chip") : null; };
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
  await check("About also says where the spread comes from, in Keith's words (2026-10-14)", () => {
    const sp = e.text(e.mount.querySelector(".ups-m-mu-note details .ups-m-mu-about-spread"));
    assert.strictEqual(sp, "Spread is the current Vegas line from nflverse, the same source used by Stats → Vegas. If no line is available, the spread is left blank.");
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
  await check("the card: points allowed a game, #rank of 32 (tier colored), the weeks; \"vs usual\" too, uncolored (Keith: keep both); his average", () => {
    const w = want(ALLEN), card = e.card(ALLEN), t = e.text(card);
    assert.ok(t.indexOf(w.opp + " allows QBs " + w.r.perGame.toFixed(1) + " a game: #" + w.r.ppgRank + " of " + w.r.ppgOf + " · Wks 1–5") >= 0, t);
    const rk = card.querySelector(".ups-m-mu-rk"); assert.strictEqual(/\b(good|tough)\b/.exec(rk.attrs.class || "") ? RegExp.lastMatch : "", w.tier);
    const pw = FX.response.playerWindow[ALLEN];
    assert.ok(t.indexOf("His avg " + pw.avg.toFixed(1) + " pts a game (Wks 1–5, " + pw.games + " games)") >= 0, t);
    const pct = Math.round((w.r.ratio - 1) * 100), sp = pct === 0 ? "0%" : (pct > 0 ? "+" : "−") + Math.abs(pct) + "%";
    assert.ok(t.indexOf("Those QBs usually score " + w.r.usual.toFixed(1) + " a game: " + sp + " vs usual") >= 0, t);
    const usualRow = card.querySelectorAll(".r").find((r) => /vs usual/.test(r.textContent));
    assert.strictEqual(usualRow.querySelectorAll(".good, .tough, .up, .dn").length, 0, "uncolored");
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

console.log("\n2. injury status (Keith 2026-10-14): MFL first, the official report beside it, source + week on every tag and line");
{
  const e = boot(); await e.open(); await e.bench();
  const tags = (els) => els.map((c) => e.text(c));
  const cls = (c) => c.attrs.class;
  await check("MFL's Q is the tag: Allen's slot shows \"MFL: Q\" (amber, no week: MFL's list has one week, not one per designation) on its own line under the slot", () => {
    const ch = e.slotChips(ALLEN);
    assert.strictEqual(e.text(ch[0]), "MFL: Q"); assert.ok(/\bq\b/.test(cls(ch[0])) && /\blu\b/.test(cls(ch[0])), cls(ch[0]));
    assert.ok(!e.slot(ALLEN).querySelector(".ups-m-inj-chip"), "not squeezed into the 56px position column");
  });
  await check("a disagreement shows both: BUF posted its Wk 6 report without Allen → a neutral \"NFL Wk 6: not listed\" tag beside MFL's", () => {
    assert.deepStrictEqual(tags(e.slotChips(ALLEN)), ["MFL: Q", "NFL Wk 6: not listed"]);
    assert.ok(/\bna\b/.test(cls(e.slotChips(ALLEN)[1])));
    assert.ok(/color:var\(--fg-muted\);background:transparent/.test(e.slotChips(ALLEN)[1].getAttribute("style")), "drawn neutral, never like a status");
  });
  await check("they agree (Taylor: MFL Q, NFL Wk 6 Q): one tag, MFL's", () => {
    assert.deepStrictEqual(tags(e.slotChips(TAYLOR)), ["MFL: Q"]);
    assert.ok(/the NFL Wk 6 report agrees/.test(e.slotChips(TAYLOR)[0].getAttribute("title")));
  });
  await check("MFL has nothing but the official report says Out (Chase, bench): \"NFL: OUT (Wk 6)\" and \"MFL: none\" — neither hidden", () => {
    assert.deepStrictEqual(tags(e.benchChips("Chase")), ["NFL: OUT (Wk 6)", "MFL: none"]);
  });
  await check("IR / PUP stay MFL's roster designations, labeled as MFL's (Davis: \"MFL: IR-R\")", () => {
    assert.deepStrictEqual(tags(e.benchChips("Davis")), ["MFL: IR-R"]);
    assert.ok(/\bres\b/.test(cls(e.benchChips("Davis")[0])));
  });
  await check("the dropdown choice says it too, with source and week", () => {
    const opt = e.slot(TAYLOR).querySelectorAll("option").find((o) => o.attrs.value === TAYLOR);
    assert.ok(/^Jonathan Taylor\s+·\s+IND\s+·\s+MFL: Q\s+·/.test(opt.textContent), opt.textContent);
  });
  await check("Details always shows both sources, each with its week; MFL's description and expected return; the disagreement in words", async () => {
    e.line(ALLEN).click(); await settle();
    const t = e.text(e.card(ALLEN));
    assert.ok(t.indexOf("MFL: Questionable — Ankle · Expected return: Oct 18 (MFL’s Wk 6 list; MFL status read at Wed 8:58 AM ET).") === 0, t);
    assert.ok(/NFL Wk 6 report: not listed \(BUF’s report, updated .+ ET\)\./.test(t), t);
    assert.ok(t.indexOf("MFL and the NFL Wk 6 report disagree: MFL lists Questionable; the report doesn’t list him.") >= 0, t);
    e.line(TAYLOR).click(); await settle();
    const t2 = e.text(e.card(TAYLOR));
    assert.ok(/MFL: Questionable — Hamstring · Expected return: Oct 18 \(MFL’s Wk 6 list; MFL status read at Wed 8:58 AM ET\)\.\s*NFL Wk 6 report: Questionable — Hamstring · practice: limited \(updated .+ ET\)\./.test(t2), t2);
    assert.ok(!/disagree/.test(t2));
  });
  await check("MFL's estimated return already passed: the tag stays, dashed (\"MFL: D · est. return passed\"); Details says only the estimate passed (Thomas: back Oct 11)", async () => {
    e.line(THOMAS).click(); await settle();
    const ch = e.slotChips(THOMAS)[0];
    assert.strictEqual(e.text(ch), "MFL: D · est. return passed"); assert.ok(/\bprior\b/.test(cls(ch)) && /dashed/.test(ch.getAttribute("style")), cls(ch));
    assert.ok(/MFL still lists him Doubtful — Knee \(MFL’s Wk 6 list; MFL status read at Wed 8:58 AM ET\)\. Its expected return \(Oct 11\) has passed; that’s an estimate, so this doesn’t mean he’s healthy or that the designation is wrong\./.test(e.text(e.card(THOMAS))), e.text(e.card(THOMAS)));
    const opt = e.mount.querySelectorAll("option").find((o) => o.attrs.value === THOMAS);
    assert.ok(/·\s+MFL: D \(est\. return passed\)\s+·/.test(opt.textContent), opt.textContent);
    assert.ok(/NFL Wk 6 report: not out yet for ATL \(or a bye\)\./.test(e.text(e.card(THOMAS))));
  });
  await check("one note says where the tags come from, and that no tag isn't 'healthy'", () => {
    assert.ok(/^Tags: MFL first \(its Wk 6 list; MFL status read at Wed 8:58 AM ET; dashed = MFL’s estimated return has passed\); where MFL has none, the NFL report — Wk 6’s for 4 teams so far\. Details shows both\. No tag doesn’t mean healthy\.$/.test(e.text(e.mount.querySelector(".ups-m-mu-note.inj"))),
      e.text(e.mount.querySelector(".ups-m-mu-note.inj")));
  });
  await check("the status is read once, not on every repaint", async () => {
    e.render(); await settle(); e.render(); await settle();
    assert.strictEqual(e.log.filter((x) => /player-status/.test(x.url)).length, 1);
  });
  await check("this week's report not out: MFL's tags stay first; with nothing from MFL, the NFL's last final, labeled and dashed", async () => {
    const e5 = boot({ status: statusBody({ week: 5, current: false, prior: true }) }); await e5.open(); await e5.bench();
    assert.deepStrictEqual(e5.slotChips(TAYLOR).map((c) => e5.text(c)), ["MFL: Q"], "MFL's Q, not last week's NFL");
    const ch = e5.benchChips("Chase");
    assert.deepStrictEqual(ch.map((c) => e5.text(c)), ["NFL: OUT (Wk 5 final)"]);
    assert.ok(/\bprior\b/.test(ch[0].attrs.class) && /dashed/.test(ch[0].getAttribute("style")), ch[0].attrs.class);
    e5.line(TAYLOR).click(); await settle();
    const t = e5.text(e5.card(TAYLOR));
    assert.ok(/NFL injury report unavailable: the newest report is Wk 5; Wk 6's is not out yet\.\s*NFL Wk 5 final: Questionable — Hamstring\./.test(t), t);
    assert.ok(/^Tags: MFL first \(its Wk 6 list; MFL status read at Wed 8:58 AM ET; dashed = MFL’s estimated return has passed\); where MFL has none, the NFL’s last final report \(Wk 5\): Wk 6’s isn’t out yet\. Details shows both\. No tag doesn’t mean healthy\.$/.test(e5.text(e5.mount.querySelector(".ups-m-mu-note.inj"))));
  });
  await check("MFL's list still on last week (Wk 5) for a Wk 6 lineup: its tags are dashed and Details names the Wk 5 list, never this week's", async () => {
    const e3 = boot({ status: statusBody({ week: 5, current: true, mflWeek: 5 }) }); await e3.open();
    const ch = e3.slotChips(TAYLOR);
    assert.strictEqual(e3.text(ch[0]), "MFL: Q"); assert.ok(/\bprior\b/.test(ch[0].attrs.class));
    e3.line(TAYLOR).click(); await settle();
    assert.ok(/\(MFL’s Wk 5 list; MFL status read at /.test(e3.text(e3.card(TAYLOR))), e3.text(e3.card(TAYLOR)));
  });
  await check("status unreadable: MFL's designations from the app's own MFL read, labeled so; the note says the status couldn't be loaded", async () => {
    const e4 = boot({ status: { fail: true } });
    const store = e4.c.UPSLive.createInjuryStore();
    store.put({ injuries: { week: "6", timestamp: "1791979264", injury: [{ id: ALLEN, status: "Questionable", details: "Ankle" }, { id: DAVIS, status: "IR-R", details: "Knee" }] } }, { season: "2026" });
    e4.M.state.injuryStore = store;
    await e4.open(); await e4.bench();
    assert.deepStrictEqual(e4.slotChips(ALLEN).map((c) => e4.text(c)), ["MFL: Q"]);
    assert.deepStrictEqual(e4.benchChips("Davis").map((c) => e4.text(c)), ["MFL: IR-R"]);
    assert.strictEqual(e4.text(e4.mount.querySelector(".ups-m-mu-note.inj")), "Injury status couldn’t be loaded; tags are MFL’s from this page’s own read. No tag doesn’t mean healthy.");
    e4.line(ALLEN).click(); await settle();
    assert.ok(/^Injury status couldn’t be loaded\. No tag doesn’t mean healthy\.\s*MFL: Questionable — Ankle \(this page’s read of MFL’s Wk 6 list\)\./.test(e4.text(e4.card(ALLEN))), e4.text(e4.card(ALLEN)));
  });
  await check("nothing read at all yet: no tags, and it says it's checking (never 'healthy')", async () => {
    const e6 = boot({ hold: /player-status/ }); await e6.open();
    assert.strictEqual(e6.mount.querySelectorAll(".ups-m-inj-chip").length, 0);
    assert.strictEqual(e6.text(e6.mount.querySelector(".ups-m-mu-note.inj")), "Checking injury status…");
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
