// Desktop Game Day → Submit Lineup matchup info and injury tags (site/gameday/gameday.html),
// issue #1276: the released mobile Lineup design (#1257, Keith's rulings 2026-10-13).
// gameday.html's REAL inline script runs in node:vm on a tree DOM, after the real
// site/shared/live_scoring.js and injury_overrides.js, fed the worker's own 2026 Week 6
// /api/lineup-matchups answer (read 2026-10-13 16:32 UTC).
// Checks: rank + green/red by MFL points allowed per game (only with 20+ ranked), "vs
// usual" uncolored, a pronounced Details button that is a real <button> with
// aria-expanded and gets focus back, several cards open, one window (no &last), a failed
// or ok:false read says so with Try again and retries after a minute, a re-read after 5
// minutes, Week 1 "(2025)", "Next" with byes. Injury badges stay exactly as on main (MFL's
// injuries export + the week-scoped override list): Keith 2026-10-14 ruled the injury source
// moves in its own PR (one shared resolver for phone and desktop). The lock / bye / IR-slot
// rules are unchanged. Nothing here writes: every request is a GET, Submit is never pressed.
//   node tests/desktop_gameday_matchups.test.mjs
//   GAMEDAY_HTML=<path> node tests/desktop_gameday_matchups.test.mjs   (mutation checks)
import fs from "node:fs";
import vm from "node:vm";
import assert from "node:assert";
import { makeDocument, settle } from "./fixtures/tree_dom.mjs";

const read = (p) => fs.readFileSync(p.startsWith("/") ? p : new URL("../" + p, import.meta.url), "utf8");
const FX = JSON.parse(read("tests/fixtures/lineup_matchups_2026_wk6.json"));
const GAMEDAY = read(process.env.GAMEDAY_HTML || "site/gameday/gameday.html");
const LIVE = read("site/shared/live_scoring.js"), OVERRIDES = read("site/shared/injury_overrides.js");
const INLINE = (() => {
  const blocks = [...GAMEDAY.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  assert.strictEqual(blocks.length, 1, "gameday.html has one inline script");
  return blocks[0];
})();
const PBYID = Object.fromEntries(FX.players.map((p) => [p.id, p]));
const ALL = FX.starters.concat(FX.bench);
const clone = (x) => JSON.parse(JSON.stringify(x));

let fails = 0, passes = 0;
const check = async (n, fn) => { try { await fn(); passes++; console.log("  ok   " + n); } catch (e) { fails++; console.log("  FAIL " + n + "\n         " + (e && e.message)); } };

// Real MFL ids from the fixture.
const ALLEN = "13589", GOFF = "12611", TAYLOR = "14802", THOMAS = "15814", ALSHAAIR = "14590", AJOHNSON = "16246";
const COLEMAN = "16617", HAMPTON = "17044", DAVIS = "13710", NIX = "16582", EWILSON = "16432";
// Roster status on MFL (not the injury feed): one bench player in an IR slot, one on taxi.
const IR_SLOT = NIX, TAXI = EWILSON;
const BYES_W6 = ["DET", "MIA", "CIN", "MIN"];   // the four teams with no Week 6 game in the fixture

// MFL's own injuries export for Week 6 (what Game Day's badges read today): a Questionable,
// a Doubtful and an IR-R roster designation.
const MFL_INJURIES = { injuries: { week: "6", timestamp: "1791936064", injury: [
  { id: ALLEN, status: "Questionable", details: "Ankle", exp_return: "Oct 18, 2026" },
  { id: HAMPTON, status: "Doubtful", details: "Groin", exp_return: "Oct 18, 2026" },
  { id: DAVIS, status: "IR-R", details: "Knee", exp_return: "Nov 15, 2026" }] } };

// opts.lm(u) → { status, body } overrides /api/lineup-matchups; opts.injuries → MFL's
// injuries export; opts.liveWeek / projWeek; opts.now.
function boot(opts) {
  opts = Object.assign({ liveWeek: 6, projWeek: 6, now: Date.parse("2026-10-14T21:00:00Z") }, opts || {});
  const doc = makeDocument(), root = doc.mount("gd-root");
  const log = [], writes = [], env = {};
  let now = opts.now;
  const resp = (status, body) => ({ ok: status < 400, status, json: () => Promise.resolve(clone(body)) });
  const roster = ALL.map((id) => ({ id, status: id === IR_SLOT ? "INJURED_RESERVE" : (id === TAXI ? "TAXI_SQUAD" : "ROSTER"), salary: "1000", contractYear: "2" }));
  const answer = (url) => {
    const u = new URL(url), q = (k) => u.searchParams.get(k);
    if (u.pathname === "/api/current-lineup-week") return resp(200, { ok: true, week: opts.liveWeek });
    if (u.pathname === "/api/lineup") return resp(200, { known: true, starters: FX.starters, state: "ok", source: "mfl_player_status" });
    if (u.pathname === "/api/lineup-matchups") {
      if (opts.lm) { const o = opts.lm(u); if (o) return resp(o.status, o.body); }
      return q("W") === "6" && !q("last") ? resp(200, FX.response) : resp(500, { ok: false, error: "no fixture" });
    }
    if (u.pathname === "/api/mfl-export") {
      const T = q("TYPE");
      if (T === "league") return resp(200, { league: { franchises: { franchise: [{ id: "0001", name: "Test Team" }] } } });
      if (T === "rosters") return resp(200, { rosters: { franchise: [{ id: "0001", player: roster }] } });
      if (T === "salaries") return resp(200, { salaries: {} });
      if (T === "players") return resp(200, { players: { player: FX.players } });
      if (T === "projectedScores") return resp(200, { projectedScores: { week: String(q("W") || opts.projWeek), playerScore: ALL.map((id, i) => ({ id, score: String(30 - i / 2) })) } });
      if (T === "injuries") return resp(200, opts.injuries || MFL_INJURIES);
      if (T === "nflSchedule") return resp(200, { nflSchedule: { matchup: Object.entries(FX.response.matchups).filter(([t, m]) => m.isHome).map(([t, m]) => ({ kickoff: String(m.kickoff), team: [{ id: t }, { id: m.opp }] })) } });
      if (T === "nflByeWeeks") return resp(200, { nflByeWeeks: { team: BYES_W6.map((id) => ({ id, bye_week: "6" })) } });
    }
    return resp(404, { error: "unrouted " + url });
  };
  const fetch = (url, init) => {
    const method = (init && init.method) || "GET";
    log.push({ method, url: String(url) });
    if (method !== "GET") { writes.push(String(url)); return Promise.reject(new Error("write refused")); }
    return Promise.resolve(answer(String(url)));
  };
  const store = {};
  const c = vm.createContext({ console, setTimeout, clearTimeout, Promise, URL, URLSearchParams, JSON, Math, RegExp, Object, Array, String, Number, isNaN, isFinite, parseInt, parseFloat });
  c.window = c; c.document = doc; c.fetch = fetch;
  c.location = { search: "?L=74598&YEAR=2026&FRANCHISE_ID=0001", href: "https://keithcreelman.github.io/upsmflproduction/gameday/gameday.html?L=74598&YEAR=2026&FRANCHISE_ID=0001", hostname: "keithcreelman.github.io" };
  c.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
  c.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(now); } static now() { return now; } };
  vm.runInContext(LIVE, c);
  vm.runInContext(OVERRIDES, c);
  vm.runInContext(INLINE, c);
  env.doc = doc; env.root = root; env.log = log; env.writes = writes; env.c = c;
  env.tick = (ms) => { now += ms; };
  // A repaint, the way the page repaints on any click: the lineup tab's own button.
  env.repaint = async () => { const t = doc.querySelector('button[data-gdtab="taxi"]'); t.click(); await settle(); doc.querySelector('button[data-gdtab="lineup"]').click(); await settle(); };
  env.line = (pid) => root.querySelector('.gd-slot-mu[data-mu-pid="' + pid + '"]');
  env.card = (pid) => { const l = env.line(pid); return l && l.getAttribute("aria-controls") ? doc.getElementById(l.getAttribute("aria-controls")) : null; };
  env.slot = (pid) => root.querySelectorAll(".gd-slot").find((s) => (s.querySelector("select") || {}).value === pid) || null;
  // A slot's badge line(s) follow the slot row as siblings until the next slot / matchup line.
  env.slotBadges = (pid) => {
    const s = env.slot(pid); if (!s) return [];
    const sib = s.parentNode.children, out = [];
    for (let i = sib.indexOf(s) + 1; i < sib.length && /gd-slot-inj-row/.test(sib[i].attrs.class || ""); i++) out.push(...sib[i].querySelectorAll(".gd-inj-badge, .gd-lock-badge, .gd-bye-badge"));
    return out;
  };
  env.benchRow = (pid) => root.querySelectorAll(".gd-bench-row").find((r) => r.querySelector(".nm") && r.querySelector(".nm").textContent === nameOf(pid)) || null;
  env.text = (el) => (el ? el.textContent.replace(/\s+/g, " ").trim() : null);
  env.lmCalls = () => log.filter((x) => x.url.indexOf("/api/lineup-matchups") >= 0).map((x) => x.url.replace(/^.*\/api\/lineup-matchups\?/, ""));
  env.open = async () => { await settle(30); };
  env.bench = async () => { doc.getElementById("gd-bench-toggle").click(); await settle(); };
  env.note = () => env.text(root.querySelector(".gd-mu-note"));
  return env;
}
function nameOf(pid) { const raw = PBYID[pid].name, p = raw.split(","); return p.length > 1 ? p[1].trim() + " " + p[0].trim() : raw; }
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
const tierCls = (el) => { const c = (el && el.attrs.class) || ""; return /\bgood\b/.test(c) ? "good" : (/\btough\b/.test(c) ? "tough" : ""); };

console.log("1. rank and color by MFL points allowed per game (Keith 2026-10-13)");
{
  const e = boot(); await e.open();
  await check("the lineup renders from MFL's saved starters (the harness drives the real page)", () => {
    assert.strictEqual(e.root.querySelectorAll(".gd-slot.filled").length, 18, e.text(e.root).slice(0, 300));
  });
  await check("Josh Allen's line: where, when, and \"#rank vs QBs\" by points allowed per game (the opponent named once)", () => {
    const w = want(ALLEN), t = e.text(e.line(ALLEN));
    assert.ok(t.indexOf((w.m.isHome ? "vs " : "@ ") + w.opp + " · ") === 0, t);
    assert.ok(t.indexOf(w.text) > 0, t + " ≠ " + w.text);
    assert.strictEqual(t.split(w.opp).length - 1, 1, "opponent once: " + t);
    assert.ok(w.r.ppgRank !== w.r.rank, "the fixture tells ppgRank from the old adjusted rank");
  });
  await check("every chip is green for ranks 1–10 and red for the bottom 10, plain between (starters + bench)", async () => {
    await e.bench();
    let n = 0, colored = 0;
    for (const pid of ALL) {
      const w = want(pid), line = e.line(pid);
      if (!w || !line) continue;
      const chip = line.querySelector(".gd-mu-chip");
      assert.strictEqual(tierCls(chip), w.tier, pid + " #" + w.r.ppgRank + " " + chip.attrs.class);
      assert.strictEqual(e.text(chip), w.text);
      n++; if (w.tier) colored++;
    }
    assert.ok(n >= 23 && colored > 0, n + "/" + colored);
  });
  await check("a bye-week player has no matchup line (DET is off in Week 6)", () => {
    assert.strictEqual(e.line(GOFF), null);
  });
  await check("one window: no Season/L3/L5 buttons, and one read for the lineup week without &last", () => {
    assert.strictEqual(e.root.querySelectorAll(".gd-win-btn").length, 0);
    assert.ok(!/\bL3\b|\bL5\b/.test(e.text(e.root.querySelector(".gd-lu-status"))));
    assert.deepStrictEqual(e.lmCalls(), ["YEAR=2026&W=6"]);
  });
  await check("the note says what the rank is, the weeks, the colors and when MFL was read; About has ≤ 3 sentences with the measured size", () => {
    const n = e.root.querySelector(".gd-mu-note"), t = e.text(n);
    assert.ok(/^Rank = MFL points allowed per game to the position, Wks 1–5 \(#1 = most\)\. Green: top 10 · red: bottom 10\. MFL read \d{1,2}:\d\d (AM|PM)\. Games already played, not a forecast\./.test(t), t);
    const about = e.text(n.querySelector("details div"));
    assert.ok(about.split(/(?<=\.)\s+/).length <= 3, about);
    assert.ok(/scored about 1 point more than facing one of the 10 allowing the least \(QB about 2\)\./.test(about), about);
    assert.ok(e.text(n.querySelector("details summary")) === "About");
  });
  await check("a pronounced Details button on every line: \"Details ▾\", then \"Hide ▴\"; the line is a <button> with aria-expanded, and focus comes back to it", async () => {
    const b = e.line(ALLEN);
    assert.strictEqual(b.tagName, "BUTTON"); assert.strictEqual(b.getAttribute("type"), "button");
    assert.strictEqual(b.getAttribute("aria-expanded"), "false");
    assert.strictEqual(e.text(b.querySelector(".gd-mu-more")), "Details ▾");
    assert.strictEqual(e.root.querySelectorAll(".gd-mu-more").length, e.root.querySelectorAll(".gd-slot-mu").length);
    assert.ok(/in MFL points allowed per game to quarterbacks/.test(b.getAttribute("aria-label")), b.getAttribute("aria-label"));
    b.click(); await settle();
    const b2 = e.line(ALLEN);
    assert.notStrictEqual(b2, b, "the page re-rendered");
    assert.strictEqual(b2.getAttribute("aria-expanded"), "true"); assert.strictEqual(e.text(b2.querySelector(".gd-mu-more")), "Hide ▴");
    assert.ok(/\bon\b/.test(b2.querySelector(".gd-mu-more").attrs.class));
    assert.ok(e.card(ALLEN), "aria-controls points at the card");
    assert.strictEqual(e.doc.activeElement, b2, "focus is back on the clicked line");
  });
  await check("the card: points allowed a game, #rank of 32 (tier colored), the weeks; \"vs usual\" too, uncolored (Keith: keep both); his average", () => {
    const w = want(ALLEN), card = e.card(ALLEN), t = e.text(card);
    assert.ok(t.indexOf(w.opp + " allows QBs " + w.r.perGame.toFixed(1) + " a game: #" + w.r.ppgRank + " of " + w.r.ppgOf + " · Wks 1–5") >= 0, t);
    assert.strictEqual(tierCls(card.querySelector(".gd-mu-rk")), w.tier);
    const pw = FX.response.playerWindow[ALLEN];
    assert.ok(t.indexOf("His avg " + pw.avg.toFixed(1) + " pts a game (Wks 1–5, " + pw.games + " games)") >= 0, t);
    const pct = Math.round((w.r.ratio - 1) * 100), sp = pct === 0 ? "0%" : (pct > 0 ? "+" : "−") + Math.abs(pct) + "%";
    assert.ok(t.indexOf("Those QBs usually score " + w.r.usual.toFixed(1) + " a game: " + sp + " vs usual") >= 0, t);
    const usualRow = card.querySelectorAll(".r").find((r) => /vs usual/.test(r.textContent));
    assert.strictEqual(usualRow.querySelectorAll(".good, .tough").length, 0, "uncolored");
    assert.ok(!/allows \+|vs expected|Defense #|Form /.test(t), "none of the old wording: " + t);
  });
  await check("opening a second card leaves the first open (the clicked line never jumps); closing one leaves the other", async () => {
    e.line(THOMAS).click(); await settle();
    assert.strictEqual(e.line(ALLEN).getAttribute("aria-expanded"), "true");
    assert.strictEqual(e.line(THOMAS).getAttribute("aria-expanded"), "true");
    assert.strictEqual(e.doc.activeElement, e.line(THOMAS));
    e.line(ALLEN).click(); await settle();
    assert.strictEqual(e.line(ALLEN).getAttribute("aria-expanded"), "false"); assert.strictEqual(e.card(ALLEN), null);
    assert.strictEqual(e.line(THOMAS).getAttribute("aria-expanded"), "true");
    assert.strictEqual(e.doc.activeElement, e.line(ALLEN), "focus back on the line that closed");
    e.line(ALLEN).click(); await settle();
  });
  await check("an IDP's chip and card name the opponent's OFFENSE (the team his points come against)", () => {
    const w = want(THOMAS), t = e.text(e.card(THOMAS));
    assert.ok(t.indexOf(w.opp + "’s offense allows DL " + w.r.perGame.toFixed(1) + " a game") >= 0, t);
    assert.ok(/'s offense is \d+(st|nd|rd|th) of \d+ in MFL points allowed per game to defensive linemen/.test(e.line(THOMAS).getAttribute("aria-label")), e.line(THOMAS).getAttribute("aria-label"));
  });
  await check("Next lists Wks 7–9 with each opponent's rank (tier colored), a bye as a bye", () => {
    for (const pid of [ALLEN, THOMAS]) {
      const p = PBYID[pid], grp = GRP[p.position], hz = FX.response.horizon[p.team] || [], t = e.text(e.card(pid));
      const exp = FX.response.horizonWeeks.map((wk) => { const h = hz.find((x) => x.wk === wk); return h ? "Wk " + wk + " " + (h.isHome ? "" : "@") + h.opp + " #" + FX.response.defRatings[h.opp][grp].ppgRank : "Wk " + wk + " bye"; });
      assert.ok(t.indexOf("Next: " + exp.join(" · ")) >= 0, t + "\n≠ Next: " + exp.join(" · "));
      const rks = e.card(pid).querySelectorAll(".gd-hz .gd-mu-rk");
      hz.filter((h) => FX.response.horizonWeeks.indexOf(h.wk) >= 0).forEach((h, i) => { const r = FX.response.defRatings[h.opp][grp]; assert.strictEqual(tierCls(rks[i]), tierOf(r.ppgRank, r.ppgOf), pid + " wk" + h.wk); });
    }
    // a team with a bye in Wks 7–9 shows it as a bye
    const byeTeam = Object.keys(FX.response.horizon).find((t) => FX.response.matchups[t] && FX.response.horizon[t].length < 3);
    assert.ok(byeTeam, "the fixture has a team with a bye in Wks 7–9");
  });
  await check("a bye in Wks 7–9 reads \"Wk N bye\"", async () => {
    const r = clone(FX.response), team = PBYID[ALLEN].team;
    r.horizon[team] = r.horizon[team].filter((h) => h.wk !== 8);
    const e2 = boot({ lm: () => ({ status: 200, body: r }) }); await e2.open();
    e2.line(ALLEN).click(); await settle();
    assert.ok(/Next: Wk 7 .+ · Wk 8 bye · Wk 9 /.test(e2.text(e2.card(ALLEN))), e2.text(e2.card(ALLEN)));
  });
  await check("nothing on this screen wrote anything (every request a GET)", () => { assert.deepStrictEqual(e.writes, []); assert.ok(e.log.every((x) => x.method === "GET")); });
}

console.log("\n2. tiers, the line, weather");
{
  await check("with fewer than 20 teams ranked (the first days of a season), nothing is colored", async () => {
    const r2 = clone(FX.response); for (const t in r2.defRatings) for (const g in r2.defRatings[t]) r2.defRatings[t][g].ppgOf = 12;
    const e2 = boot({ lm: () => ({ status: 200, body: r2 }) }); await e2.open();
    assert.ok(e2.root.querySelectorAll(".gd-mu-chip").length > 10);
    assert.strictEqual(e2.root.querySelectorAll(".gd-mu-chip.good, .gd-mu-chip.tough").length, 0);
  });
  const r = clone(FX.response), team = PBYID[ALLEN].team, opp = r.matchups[team].opp;
  r.matchups[team].spread = -3.5; r.matchups[opp].spread = 3.5;
  r.weather[team] = { tempF: 41, windMph: 18, precip: 0.2, summary: "Rain" }; r.weather[opp] = r.weather[team];
  await check("spread in words (MFL's −3.5 = favored; +3.5 = underdog), and the forecast labeled as one", async () => {
    const e = boot({ lm: () => ({ status: 200, body: r }) }); await e.open();
    e.line(ALLEN).click(); await settle();
    const t = e.text(e.card(ALLEN));
    assert.ok(t.indexOf("Favored by 3.5") >= 0, t);
    assert.ok(t.indexOf("Forecast at kickoff: 41°F · wind 18 mph · Rain · 0.2\" precip") >= 0, t);
    const r3 = clone(r); r3.matchups[team].spread = 3.5;
    const e3 = boot({ lm: () => ({ status: 200, body: r3 }) }); await e3.open(); e3.line(ALLEN).click(); await settle();
    assert.ok(e3.text(e3.card(ALLEN)).indexOf("Underdog by 3.5") >= 0);
  });
  await check("no spread (MFL's null) → no Favored/Underdog line at all", async () => {
    const e = boot(); await e.open(); e.line(ALLEN).click(); await settle();
    assert.ok(!/Favored|Underdog|Line /.test(e.text(e.card(ALLEN))), e.text(e.card(ALLEN)));
  });
  await check("a neutral-site game says so instead of a forecast; a dome says Indoors", async () => {
    const r2 = clone(r); r2.weather[team] = { neutral: true };
    const e3 = boot({ lm: () => ({ status: 200, body: r2 }) }); await e3.open(); e3.line(ALLEN).click(); await settle();
    assert.ok(e3.text(e3.card(ALLEN)).indexOf("Neutral site: no forecast here") >= 0);
    r2.weather[team] = { dome: true };
    const e4 = boot({ lm: () => ({ status: 200, body: r2 }) }); await e4.open(); e4.line(ALLEN).click(); await settle();
    assert.ok(e4.text(e4.card(ALLEN)).indexOf("Indoors") >= 0);
  });
}

console.log("\n3. the right week, failures, last season, freshness");
await check("the answer is for the LINEUP week: projections on Wk 7, lineup week 6 → only W=6 is read", async () => {
  const e = boot({ projWeek: 7, liveWeek: 6 }); await e.open();
  assert.deepStrictEqual(e.lmCalls(), ["YEAR=2026&W=6"]);
  assert.ok(e.text(e.line(ALLEN)).indexOf(want(ALLEN).opp) > 0);
});
await check("MFL down (502): no lines, a one-line reason and Try again; clicking it reads again and the lines come back", async () => {
  let down = true;
  const e = boot({ lm: () => (down ? { status: 502, body: { ok: false, error: "mfl_unavailable" } } : null) });
  await e.open();
  assert.strictEqual(e.root.querySelectorAll(".gd-slot-mu").length, 0);
  assert.ok(/^Matchup numbers couldn’t be read from MFL right now\. Try again$/.test(e.note()), e.note());
  assert.strictEqual(e.doc.getElementById("gd-mu-retry").tagName, "BUTTON");
  down = false;
  e.doc.getElementById("gd-mu-retry").click(); await settle(); await settle();
  assert.ok(e.line(ALLEN), "lines back after Try again");
  assert.strictEqual(e.lmCalls().length, 2);
});
await check("a 200 that says ok:false is a failure too (never 'no matchups')", async () => {
  const e = boot({ lm: () => ({ status: 200, body: { ok: false } }) }); await e.open();
  assert.ok(e.root.querySelector("#gd-mu-retry"));
  assert.ok(/^Matchup numbers couldn’t be read right now\./.test(e.note()), e.note());
});
await check("a failure is tried again by itself after a minute (on the next render), not kept for the session", async () => {
  let n = 0;
  const e = boot({ lm: () => (++n === 1 ? { status: 500, body: { ok: false } } : null) }); await e.open();
  await e.repaint(); assert.strictEqual(e.lmCalls().length, 1, "not hammered within the minute");
  e.tick(61000); await e.repaint(); await settle();
  assert.strictEqual(e.lmCalls().length, 2); assert.ok(e.line(ALLEN));
});
await check("a good answer is re-read after 5 minutes; a failed refresh keeps it and says so", async () => {
  let n = 0;
  const e = boot({ lm: () => (++n === 2 ? { status: 502, body: { ok: false, error: "mfl_unavailable" } } : null) }); await e.open();
  e.tick(4 * 60000); await e.repaint(); assert.strictEqual(e.lmCalls().length, 1);
  e.tick(2 * 60000); await e.repaint(); await settle();
  assert.strictEqual(e.lmCalls().length, 2); assert.ok(e.line(ALLEN), "still shown");
  assert.ok(/Couldn’t refresh; showing MFL read \d{1,2}:\d\d (AM|PM)\./.test(e.note()), e.note());
});
await check("Week 1 before any game: last season's ranks, labeled on the chip and in the note", async () => {
  const r = clone(FX.response); r.priorSeason = true; r.ratingYear = "2025"; r.ratingsBasis = "2025 season"; r.weeksAvailable = 0;
  const e = boot({ lm: () => ({ status: 200, body: r }) }); await e.open();
  assert.ok(e.text(e.line(ALLEN)).indexOf(want(ALLEN).text + " (2025)") > 0, e.text(e.line(ALLEN)));
  assert.ok(/^No 2026 games yet, so the ranks are from the 2025 season\./.test(e.note()), e.note());
});

console.log("\n4. injury badges: unchanged from main (MFL's export + overrides); the source moves in its own PR");
{
  const e = boot(); await e.open(); await e.bench();
  const badges = (els) => els.filter((x) => /gd-inj-badge/.test(x.attrs.class)).map((x) => ({ t: e.text(x), cls: x.attrs.class, title: x.getAttribute("title") }));
  await check("a starter MFL marks Questionable keeps the big amber QUESTIONABLE badge, description in the tooltip", () => {
    assert.deepStrictEqual(badges(e.slotBadges(ALLEN)), [{ t: "QUESTIONABLE", cls: "gd-inj-badge tier-q", title: "QUESTIONABLE: Ankle" }]);
  });
  await check("bench: MFL's Doubtful and IR-R keep their red badges, as on main", () => {
    assert.deepStrictEqual(badges(e.benchRow(HAMPTON).querySelectorAll(".gd-inj-badge")), [{ t: "DOUBTFUL", cls: "gd-inj-badge tier-out", title: "DOUBTFUL: Groin" }]);
    assert.deepStrictEqual(badges(e.benchRow(DAVIS).querySelectorAll(".gd-inj-badge")), [{ t: "IR-R", cls: "gd-inj-badge tier-out", title: "IR-R: Knee" }]);
    assert.strictEqual(e.root.querySelectorAll(".gd-inj-badge").length, 3, "no other tags");
  });
  await check("no /api/player-status read, no injury line in Details, no injury note (all of that is the resolver PR)", async () => {
    assert.strictEqual(e.log.filter((x) => /player-status/.test(x.url)).length, 0);
    e.line(ALLEN).click(); await settle();
    assert.ok(!/injury|Roster:|Wk \d+ .*report/i.test(e.text(e.card(ALLEN))), e.text(e.card(ALLEN)));
    assert.strictEqual(e.root.querySelectorAll(".gd-mu-note").length, 1, "one note: the matchups one");
  });
  await check("a week-scoped override still applies to its own week only", async () => {
    const e2 = boot({ injuries: { injuries: { week: "6", timestamp: "1791936064", injury: [] } } });
    e2.c.UPS_INJURY_OVERRIDES[TAYLOR] = { status: "OUT", season: 2026, week: 6, source: "https://example.test", added: "2026-10-14" };
    e2.c.UPS_INJURY_OVERRIDES[THOMAS] = { status: "OUT", season: 2026, week: 5, source: "https://example.test", added: "2026-10-07" };
    await e2.open();
    assert.deepStrictEqual(badges(e2.slotBadges(TAYLOR)).map((b) => b.t), ["OUT"]);
    assert.strictEqual(badges(e2.slotBadges(THOMAS)).length, 0, "a Week 5 entry is inert in Week 6");
  });
}

console.log("\n5. the lock, bye and IR-slot rules are unchanged");
{
  // Sunday 14:00 UTC: HOU @ JAC (London, 13:30 UTC) has kicked off; nothing else has.
  const sunday = Date.parse("2026-10-18T14:00:00Z");
  const snap = (e) => e.root.querySelectorAll(".gd-slot").map((s) => {
    const sel = s.querySelector("select");
    return { v: sel.value, disabled: sel.disabled, opts: sel.querySelectorAll("option").map((o) => o.attrs.value).join(",") };
  });
  const errs = (e) => e.root.querySelectorAll(".gd-lu-errors li").map((li) => e.text(li));
  const tagged = boot({ now: sunday }), clean = boot({ now: sunday, injuries: { injuries: { week: "6", timestamp: "1791936064", injury: [] } } });
  await tagged.open(); await clean.open(); await tagged.bench(); await clean.bench();
  await check("a started game still locks his slot (disabled + Locked badge)", () => {
    for (const pid of [ALSHAAIR, AJOHNSON]) {
      const s = tagged.slot(pid); assert.ok(s.querySelector("select").disabled, pid + " locked");
      assert.ok(tagged.slotBadges(pid).some((b) => /gd-lock-badge/.test(b.attrs.class)), pid + " lock badge");
    }
    assert.ok(!tagged.slot(TAYLOR).querySelector("select").disabled, "Taylor hasn't kicked off: not locked");
  });
  await check("every slot's value, lock and candidate list is the same with or without injury entries", () => {
    assert.deepStrictEqual(snap(tagged), snap(clean));
  });
  await check("the bye starter (Goff, DET) is still flagged and blocks the submit; the errors are the same either way", () => {
    assert.ok(tagged.slotBadges(GOFF).some((b) => /gd-bye-badge/.test(b.attrs.class)));
    assert.ok(errs(tagged).some((x) => /Jared Goff \(DET\) is on a bye in Week 6/.test(x)), errs(tagged).join(" | "));
    assert.deepStrictEqual(errs(tagged), errs(clean));
    assert.ok(tagged.doc.getElementById("gd-submit").disabled, "Submit disabled by the bye error (never pressed here)");
  });
  await check("IR-slot and taxi players stay off the bench and out of every dropdown", () => {
    for (const e of [tagged, clean]) {
      assert.strictEqual(e.benchRow(IR_SLOT), null); assert.strictEqual(e.benchRow(TAXI), null);
      assert.ok(e.root.querySelectorAll("option").every((o) => o.attrs.value !== IR_SLOT && o.attrs.value !== TAXI));
    }
  });
  await check("still no writes", () => { assert.deepStrictEqual(tagged.writes.concat(clean.writes), []); });
}

console.log(fails ? `\n${fails} FAILED (${passes} passed)` : `\nall ${passes} passed`);
process.exit(fails ? 1 : 0);
