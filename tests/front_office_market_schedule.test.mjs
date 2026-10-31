// Front Office → Market: a row in Free agents, On the block or All players opens that player's upcoming schedule under the row,
// drawn by Roster → Schedule's OWN renderer (UPS_FO_ROSTER.schedule) from the ONE /api/fantasy-sos?season=<season>&v=2 answer
// (DATA "sos"), read the first time a row opens; never one request per player. Run on the REAL answer recorded 2026-10-13 (Wks 1-5 final).
//   node tests/front_office_market_schedule.test.mjs
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const code = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
const D26 = JSON.parse(read("tests/fixtures/sched_v2_2026_10_13.json")).v2_2026;
const MKSRC = read("site/rosters/v2/fo_market.js"), ROSRC = read("site/rosters/v2/fo_roster.js");

// The page's own modules in one context, with a small hub stand-in (escaping as the hub does) and a counting DATA stand-in.
const listeners = {};
const dialogs = [], loads = [];
const entries = {};
const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ctx = vm.createContext({
  document: { addEventListener(n, fn) { (listeners[n] = listeners[n] || []).push(fn); }, getElementById() { return null; }, querySelector() { return null; } },
  Intl, Date, console,
});
ctx.window = ctx;
ctx.UPS_FO_HUB = {
  esc, registerView() {}, registerAbout() {}, wireClicks() {}, injuryChip() { return ""; },
  playerButton: (pid, fid, label) => '<button type="button" class="fo-plink" data-fo-player="' + esc(pid) + '">' + esc(label) + "</button>",
  banner: (text, kind) => '<div class="fo-banner ' + (kind || "") + '" role="note">' + esc(text) + "</div>",
  loading() {}, openDialog: (title, html, opts) => dialogs.push({ title, html, opts }),
};
ctx.UPS_FO = {};
ctx.UPS_FO_DATA = { get: (k) => entries[k] || null, load: (k, arg) => { loads.push([k, arg]); return Promise.resolve(entries[k]); } };
for (const f of ["site/shared/player_schedule.js", "site/rosters/v2/fo_roster.js", "site/rosters/v2/fo_market.js"]) vm.runInContext(read(f), ctx, { filename: f });
(listeners["fo:ready"] || []).forEach((fn) => fn());
const S = ctx.UPS_FO_ROSTER.schedule, P = ctx.UPS_PLAYER_SCHEDULE, MK = ctx.UPS_FO_MARKET, V = MK._view;
const DEN_QB = { pid: "9001", name: "Sample QB", team: "DEN", group: "QB" };

test("the shared renderer: a week cell shows opponent (@ = away), the vs-usual %, per game and rank, as a real button, colored by the printed %", () => {
  const wk = P.weekList(D26).weeks, pr = P.playerRows(D26, { nflTeam: "DEN", group: "QB" }, wk);
  const reg = {};
  const game = pr.cells.find((c) => c.kind === "game" && c.allowed);
  const html = S.cell(game, "QB", { id: "1", name: "X" }, reg);
  const cp = P.allowedCompact(game.allowed);
  t.ok(html.includes('<button type="button" class="fo-sched-btn" data-sched-cell="1|' + game.wk + '"'), "a button (tap, Enter, Space)");
  t.ok(html.includes('<span class="fo-sched-opp">' + (game.home ? "" : "@") + game.opp + "</span>"), "opponent, @ when away");
  t.ok(html.includes(">" + cp.pct + "<") && html.includes(">" + cp.pg + "<") && html.includes(">" + cp.rank + "<"), "%, /g and rank printed in the cell");
  const tone = P.tone(game.allowed);
  t.ok(tone === "more" ? /fo-sched-more/.test(html) : tone === "less" ? /fo-sched-less/.test(html) : !/fo-sched-(more|less)/.test(html), "color from the shared ±10% / 3-game rule");
  t.equal(reg["1|" + game.wk].cell, game, "the detail panel finds the cell in the caller's map");
  t.ok(/fo-sched-bye/.test(S.cell({ wk: 10, kind: "bye" }, "QB", { id: "1" }, reg)) && /No game listed/.test(S.cell({ wk: 9, kind: "none" }, "QB", { id: "1" }, reg)), "BYE and no game, in words");
});
test("legend and note: same colors and wording as Roster (allowed so far, not a forecast)", () => {
  const lg = S.legend(), note = S.note(D26, P.basis(D26));
  for (const s of ["Green: that opponent has allowed 10% or more above usual", "Red: it has allowed 10% or more below usual", "fewer than 3 games counted", "@ = away game", "BYE = bye week"]) t.ok(lg.includes(s), s);
  t.ok(/allowed so far/.test(note) && /it is not a forecast/.test(note) && /Wks 1–5/.test(note), note);
});
test("a closed row shows a labelled Schedule control with aria-expanded=false; opening it flips aria-expanded and points at the panel", () => {
  V.open = {};
  const closed = MK._sched.toggle(DEN_QB);
  t.ok(/^<button type="button" class="fo-mk-sched-toggle" data-mk-sched="9001" aria-expanded="false" aria-controls="fo-mk-sched-9001"/.test(closed), closed);
  t.ok(/aria-label="Schedule: Sample QB’s upcoming weeks">Schedule /.test(closed), "the visible word starts the accessible name");
  V.open["9001"] = "next5";
  t.ok(/aria-expanded="true"/.test(MK._sched.toggle(DEN_QB)));
  const row = MK._sched.panelRow(DEN_QB, 10);
  t.ok(/^<tr class="fo-mk-sched-row" id="fo-mk-sched-9001" data-mk-panel="9001"><td colspan="10">/.test(row), "one full-width cell under the row");
  t.ok(/class="fo-mk-sched-panel" role="region" aria-label="Sample QB: upcoming schedule"/.test(row));
});
test("before the answer arrives the panel says so; an unreadable answer is said plainly", () => {
  delete entries.sos; V.open = { "9001": "next5" };
  t.ok(/Reading the schedule…/.test(MK._sched.panelBody(DEN_QB)));
  entries.sos = { state: "error", data: null };
  t.ok(/The schedule couldn’t be read right now/.test(MK._sched.panelBody(DEN_QB)));
});
test("Next 5 weeks (default): the SAME cells Roster draws for that player, five week heads, no player column, legend + note", () => {
  entries.sos = { state: "ok", data: D26 }; V.open = { "9001": "next5" };
  const html = MK._sched.panelBody(DEN_QB);
  const heads = [...html.matchAll(/title="League week (\d+)">W\1</g)].map((m) => +m[1]);
  t.equal(JSON.stringify(heads), JSON.stringify([6, 7, 8, 9, 10]));
  t.ok(!/fo-sched-who/.test(html), "no player column inside the panel");
  const pr = P.playerRows(D26, { nflTeam: "DEN", group: "QB" }, [6, 7, 8, 9, 10]);
  for (const c of pr.cells) t.ok(html.includes(S.cell(c, "QB", { id: "9001" }, {})), "week " + c.wk + " matches Roster's cell");
  t.ok(/fo-sched-bye/.test(html), "DEN's Week 10 bye shows");
  t.ok(/data-schedmode="next5" aria-pressed="true" data-mk-schedpid="9001"/.test(html) && /aria-labelledby="fo-lbl-schedwk-9001"/.test(html), "the weeks choice, labelled per player");
  t.ok(/allowed so far/.test(html) && /not a forecast/.test(html) && /fo-sched-legend/.test(html));
  t.ok(!/fo-sched-scroll"/.test(html), "five weeks fit: no scroll box");
});
test("Rest of season: Weeks 6–17 in a scroll box inside the panel (the page never scrolls sideways)", () => {
  V.open = { "9001": "rest" };
  const html = MK._sched.panelBody(DEN_QB);
  const heads = [...html.matchAll(/title="League week (\d+)">W\1</g)].map((m) => +m[1]);
  t.equal(heads[0], 6); t.equal(heads[heads.length - 1], 17); t.equal(heads.length, 12);
  t.ok(/<div class="fo-sched-scroll" tabindex="0" role="region" aria-label="Sample QB: schedule for the rest of the season\. Swipe sideways for later weeks\."/.test(html), "a focusable, labelled scroll region");
  t.ok(/fo-sched-wide" style="--n:12"/.test(html) && /Wks 6–17: swipe sideways for later weeks/.test(html));
});
test("missing data in words: no NFL team (MFL's FA), a position outside the nine, a team not in the answer", () => {
  V.open = { a: "next5", b: "next5", c: "next5" };
  t.ok(/No NFL team is listed for him, so there is no schedule\./.test(MK._sched.panelBody({ pid: "a", name: "A", team: "FA", group: "WR" })));
  t.ok(/not this position/.test(MK._sched.panelBody({ pid: "b", name: "B", team: "DEN", group: "XX" })));
  t.ok(/ZZZ is not in the schedule data\./.test(MK._sched.panelBody({ pid: "c", name: "C", team: "ZZZ", group: "WR" })));
});
test("a week opens the shared detail panel (the Front Office dialog), focus returns to the week", () => {
  V.open = { "9001": "next5" };
  MK._sched.panelBody(DEN_QB);
  const reg = MK._sched.cells(), key = Object.keys(reg).find((k) => k.startsWith("9001|") && reg[k].cell.kind === "game");
  const btn = { getAttribute: (a) => (a === "data-sched-cell" ? key : null) };
  dialogs.length = 0;
  S.openDetail(btn, reg);
  t.equal(dialogs.length, 1);
  t.ok(/^Wk \d+: (@ )?[A-Z]{2,3} · Sample QB$/.test(dialogs[0].title), dialogs[0].title);
  t.ok(/<dl class="fo-sched-detail">/.test(dialogs[0].html) && /Kickoff/.test(dialogs[0].html) && /It is not a forecast\./.test(dialogs[0].html));
  t.equal(dialogs[0].opts.returnFocus(), btn);
});
test("one read for the whole page: Market loads only the single 'sos' entry, on first open; no fetch, no URL, no D1, no write of its own", () => {
  const mk = code(MKSRC);
  t.equal((mk.match(/DATA\.load\("sos"\)/g) || []).length, 1, "one call site, no argument");
  t.ok(!/DATA\.load\("sos",/.test(mk) && !/fantasy-sos/.test(mk) && !/fetch\(/.test(mk), "no per-player request, no URL of its own");
  t.ok(/if \(!DATA\.get\("sos"\)\) DATA\.load\("sos"\)/.test(mk), "loaded only when a row opens and nothing is cached");
  t.ok(!/DATA\.load\("sos"/.test(mk.slice(mk.indexOf("function load()"), mk.indexOf("function after()"))), "the Market tab itself does not read it");
  t.ok(!/D1|prepare\(|method:/.test(mk), "read-only");
  t.equal(loads.filter((l) => l[0] === "sos").length, 0, "rendering panels never triggers a read");
});
test("one renderer: Market calls Roster's schedule pieces instead of copying the cell, legend or detail markup", () => {
  const mk = code(MKSRC);
  t.ok(!/fo-sched-btn|fo-sched-pct|fo-sched-legend|<dl/.test(mk), "no copied cell, legend or detail markup in Market");
  t.ok(/S\.strip\(/.test(mk) && /S\.legend\(\)/.test(mk) && /S\.note\(/.test(mk) && /S\.openDetail\(c, schedCells\)/.test(mk) && /S\.stateNote\(/.test(mk) && /S\.controls\(/.test(mk));
  t.ok(/schedule: \{ controls: schedControls, legend: schedLegend, note: schedNote, stateNote: schedStateNote, cell: schedCell, strip: schedStrip,/.test(ROSRC), "Roster exports its own pieces");
  t.ok(/schedCell\(byWk\[w\] \|\| \{ wk: w, kind: "none" \}, r\.pos, p\)/.test(ROSRC), "Roster's grid still draws with its own map");
  const html = read("site/rosters/v2/front_office.html");
  t.ok(html.indexOf("fo_roster.js") < html.indexOf("fo_market.js"), "Roster's renderer loads before Market");
});
test("phone layout: the panel sticks to the visible width of the market's scroll box", () => {
  const css = read("site/rosters/v2/front_office.css");
  t.ok(/\.fo-mk-scroll \{ container-type: inline-size; \}/.test(css) && /\.fo-mk-sched-panel \{ position: sticky; left: 0;[^}]*width: 100cqw;/.test(css));
  t.ok(/\.fo-mk-sched-panel \.fo-table\.fo-sched-grid \{ min-width: 0;/.test(css), "the five-week strip never inherits the wide-table minimum");
  t.ok(/<div class="fo-table-scroll fo-mk-scroll">/.test(MKSRC));
});

await run("front_office_market_schedule");
