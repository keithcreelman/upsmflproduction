// Front Office → Overview → Needs attention (Keith 2026-10-28): every attention check knows whether its data loaded.
// A check whose source failed shows "check unavailable" instead of being skipped; "Nothing needs you right now." only
// when EVERY check loaded and found nothing; each check shows when its data was read ("checked 9:42 AM"). Layout:
// Needs attention spans three of four columns beside Draft picks, stacked (Needs attention first) on phones.
//   node tests/front_office_overview_checks.test.mjs
//   FO_OVERVIEW_JS=<path> FO_CSS=<path> node tests/front_office_overview_checks.test.mjs   (defect check against another copy)
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = fs.readFileSync(process.env.FO_OVERVIEW_JS || path.join(ROOT, "site/rosters/v2/fo_overview.js"), "utf8");
const CSS = fs.readFileSync(process.env.FO_CSS || path.join(ROOT, "site/rosters/v2/front_office.css"), "utf8");
const DATA_SRC = fs.readFileSync(path.join(ROOT, "site/rosters/v2/fo_data.js"), "utf8");
const FO_SRC = fs.readFileSync(path.join(ROOT, "site/rosters/v2/front_office.js"), "utf8");

function load() {
  const listeners = {};
  const body = { innerHTML: "", addEventListener() {} };
  const ctx = vm.createContext({
    document: { addEventListener(n, f) { (listeners[n] = listeners[n] || []).push(f); }, getElementById(id) { return id === "fo-overview-body" ? body : null; } },
    Intl, Date, setTimeout, Promise
  });
  ctx.window = ctx;
  vm.runInContext(SRC, ctx);
  return { ctx, OV: ctx.UPS_FO_OVERVIEW, listeners, body };
}
const { OV } = load();
const at = (h, m) => new Date(2026, 9, 28, h, m).getTime();   // viewer-local clock, like the page
const NOW = at(10, 5);

test("a source: a DATA entry ok → ok with its read time; error → unavailable; no entry yet → loading", () => {
  t.equal(JSON.stringify(OV.sourceFromEntry("bye weeks", { state: "ok", at: at(9, 42) })), JSON.stringify({ name: "bye weeks", state: "ok", at: at(9, 42) }));
  t.equal(OV.sourceFromEntry("bye weeks", { state: "error", at: at(9, 42), error: "HTTP 503" }).state, "unavailable");
  t.equal(OV.sourceFromEntry("bye weeks", null).state, "loading");
});

test("sources → one check: any unavailable wins, then loading; 'checked' is the OLDEST read; the note names what didn't load", () => {
  const ok1 = { name: "MFL scores", state: "ok", at: at(9, 40) }, ok2 = { name: "bye weeks", state: "ok", at: at(9, 42) };
  const c = OV.combineSources([ok2, ok1]);
  t.equal(c.state, "ok"); t.equal(c.at, at(9, 40), "oldest read: never fresher than the data used"); t.equal(c.note, "");
  const bad = OV.combineSources([ok1, { name: "bye weeks", state: "unavailable", at: at(9, 42) }]);
  t.equal(bad.state, "unavailable"); t.equal(bad.at, 0, "no 'checked' time for a check that didn't run"); t.equal(bad.note, "bye weeks didn’t load");
  t.equal(OV.combineSources([ok1, { name: "bye weeks", state: "loading", at: 0 }]).state, "loading");
  t.equal(OV.combineSources([{ name: "x", state: "loading" }, { name: "MFL’s claims", state: "unavailable", note: "sign in to MFL" }]).state, "unavailable", "unavailable beats loading");
  t.equal(OV.combineSources([{ name: "MFL scores", state: "unavailable" }, { name: "bye weeks", state: "unavailable" }]).note, "MFL scores and bye weeks didn’t load");
  t.equal(OV.combineSources([{ name: "MFL’s claims", state: "unavailable", note: "sign in to MFL" }]).note, "sign in to MFL", "a source's own reason is kept");
});

test("'checked 9:42 AM' (compact); a read from another day adds the date", () => {
  t.equal(OV.checkedLabel(at(9, 42), NOW), "checked 9:42 AM");
  t.equal(OV.checkedLabel(at(13, 5), NOW), "checked 1:05 PM");
  t.equal(OV.checkedLabel(new Date(2026, 9, 27, 21, 0).getTime(), NOW), "checked Oct 27, 9:00 PM");
  t.equal(OV.checkedLabel(0, NOW), "checked", "no time is never invented");
});

test("summary: all clear ONLY when every check loaded and found nothing; an unavailable check is named and blocks it", () => {
  const ok = (id, label, items) => ({ id, label, state: "ok", at: at(9, 42), items: items || [] });
  const clear = OV.summarizeChecks([ok("cap", "Cap and roster size"), ok("lineup", "Lineup and byes")], NOW);
  t.equal(clear.allClear, true); t.equal(clear.rows[1].status, "checked 9:42 AM");
  const oneDown = OV.summarizeChecks([ok("cap", "Cap and roster size"), { id: "lineup", label: "Lineup and byes", state: "unavailable", note: "bye weeks didn’t load", items: [] }], NOW);
  t.equal(oneDown.allClear, false, "a failed bye read is never 'nothing needs you'");
  t.equal(JSON.stringify(oneDown.unavailable), JSON.stringify(["Lineup and byes"]));
  t.equal(oneDown.rows[1].status, "check unavailable"); t.equal(oneDown.rows[1].note, "bye weeks didn’t load");
  const waiting = OV.summarizeChecks([ok("cap", "Cap and roster size"), { id: "claims", label: "Waiver claims", state: "loading" }], NOW);
  t.equal(waiting.allClear, false, "still loading is not all clear"); t.equal(waiting.rows[1].status, "checking…");
  const found = OV.summarizeChecks([ok("cap", "Cap and roster size", ["<li>over</li>"]), ok("lineup", "Lineup and byes", ["<li>wk9</li>"])], NOW);
  t.equal(found.allClear, false); t.equal(JSON.stringify(found.items), JSON.stringify(["<li>over</li>", "<li>wk9</li>"]), "items keep check order");
  t.equal(OV.summarizeChecks([], NOW).allClear, false, "no checks at all is not all clear");
  t.equal(OV.summarizeChecks([{ id: "x", label: "X", state: "weird" }], NOW).rows[0].state, "loading", "an unknown state never counts as loaded");
});

// The real paint path with stand-in Front Office objects: one source fails → that check says so and no all-clear.
function paintWith({ byes, pending, lockState }) {
  const { ctx, listeners, body } = load();
  const esc = (s) => String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const team = { fid: "0008", name: "Team 8", players: [{ id: "1", name: "Doe, John", position: "QB" }] };
  const read = at(9, 42);
  const entries = {
    scores: { state: "ok", at: read, data: { known: true, lineupWeek: 9, fetchedAt: read, windowFor: () => ({}) } },
    byes: byes || { state: "ok", at: read, data: {} },
    picks: { state: "ok", at: read, data: { futureDraftPicks: { franchise: [{ id: "0008", futureDraftPick: [{ year: "2027", round: "1", originalPickFor: "0008" }] }] } } },
    waiverPending: pending || { state: "ok", at: read, data: { known: true, rounds: [] } },
    waiverAvailability: { state: "ok", at: read, data: { known: true } },
    waiverState: { state: "ok", at: read, data: {} }
  };
  ctx.UPS_FO_HUB = {
    esc, money: (v) => "$" + v, banner: (x, k) => '<div class="fo-banner ' + k + '">' + esc(x) + "</div>", goLink: (s, l) => "<button>" + l + "</button>",
    playerButton: (p, f, l) => "<button>" + esc(l) + "</button>", wireClicks() {}, scoring: () => entries.scores.data, values: () => ({}),
    modelTeams: () => [{ fid: "0008", players: [] }], injuryChip: () => "", asArray: (x) => (x == null ? [] : Array.isArray(x) ? x : [x]), playerIndex: () => ({}),
    displayName: (n) => n, setFreshness() {}, clock: () => "9:42 AM", setupAbout() {}, registerAbout() {}, dayLabel: () => "", teamName: (f) => f, registerView() {}
  };
  ctx.UPS_FO = {
    viewerFid: () => "0008", teams: () => [team], capFor: () => ({ capSpace: 1000, activeN: 30, activeMax: 35, activeMin: 27, taxiN: 0, taxiMax: 4, irN: 0, capAlloc: 0, salaryCap: 0, adjTotal: 0 }),
    capLedger: () => null, tradeLock: () => ({ state: lockState || "none", verified_at_utc: new Date(at(9, 30)).toISOString() }),
    readState: () => ({ state: "ok", at: read }), eligibility: () => null, extensionDeadline: () => null, injury: () => null, warRoomUrl: () => "#", capCeiling: 0
  };
  ctx.UPS_FO_DATA = { get: (k) => entries[k] || null, load: () => new Promise(() => {}), injury() {}, injuryState: () => ({ state: "ok", at: read }) };
  ctx.UPS_BYE_PLANNER = { plan: () => ({ fullStarters: {}, weeks: [] }), byesFromMfl: () => ({}) };
  (listeners["fo:ready"] || []).forEach((f) => f());
  return body.innerHTML;
}

test("rendered: everything loaded and nothing found → the all-clear, with every check's 'checked' time", () => {
  const html = paintWith({});
  t.ok(html.includes("Nothing needs you right now."), "all clear");
  for (const l of ["Cap and roster size", "Injuries", "Lineup and byes", "Contract windows", "Waiver claims", "Trade deadline"]) t.ok(html.includes(">" + l + "<"), "check row: " + l);
  t.equal((html.match(/checked 9:42 AM/g) || []).length, 5, "five checks read at 9:42");
  t.ok(html.includes('data-ov-check="deadline"><span class="fo-ov-ck-lbl">Trade deadline</span> <span class="fo-ov-ck-st">checked 9:30 AM'), "the trade lock's time is the worker's MFL-verified time");
  t.ok(!html.includes("check unavailable"));
});

test("rendered: the bye-weeks read fails → Lineup and byes (and Injuries, which uses the same lineup) say 'check unavailable'; no all-clear", () => {
  const html = paintWith({ byes: { state: "error", at: at(9, 42), error: "HTTP 503" } });
  t.ok(!html.includes("Nothing needs you"), "never all clear when a check couldn't run");
  t.ok(/data-ov-check="lineup"><span class="fo-ov-ck-lbl">Lineup and byes<\/span> <span class="fo-ov-ck-st">check unavailable \(bye weeks didn’t load\)/.test(html));
  t.ok(/data-ov-check="injury">[^]*?check unavailable/.test(html), "Injuries can't pick the lineup's players either");
  t.ok(html.includes("Couldn’t check Injuries, Lineup and byes, so this list may be incomplete."), "says which checks could not run");
  t.ok(html.includes('class="fo-ov-ck is-unavailable"'));
});

test("rendered: not signed in to MFL (claims read 401) → Waiver claims 'check unavailable (sign in to MFL)', no all-clear", () => {
  const html = paintWith({ pending: { state: "error", at: at(9, 42), error: "HTTP 401" } });
  t.ok(!html.includes("Nothing needs you"));
  t.ok(html.includes("Waiver claims</span> <span class=\"fo-ov-ck-st\">check unavailable (sign in to MFL)"));
  const other = paintWith({ pending: { state: "error", at: at(9, 42), error: "HTTP 500" } });
  t.ok(other.includes("check unavailable (MFL’s claims didn’t load)"), "any other failure is said as a failed read");
  const unknown = paintWith({ pending: { state: "ok", at: at(9, 42), data: { known: false } } });
  t.ok(unknown.includes("check unavailable (sign in to MFL)"), "known:false is never 'no claims'");
});

test("rendered: an unreadable trade lock → Trade deadline 'check unavailable'", () => {
  const html = paintWith({ lockState: "unresolved" });
  t.ok(html.includes("check unavailable (MFL’s trade lock couldn’t be read)") && !html.includes("Nothing needs you"));
});

test("sources record their real read time: fo_data entry.at, the injury loader's at, the Front Office's own roster / league-events reads", () => {
  t.ok(/entries\[id\] = \{ key: id, state: "ok", data: data, at: Date\.now\(\) \}/.test(DATA_SRC), "fo_data entry.at = when the read finished");
  t.ok(/function injuryState\(\) \{ return injuryLoader \? injuryLoader\.read\(\) : null; \}/.test(DATA_SRC) && /injuryState: injuryState/.test(DATA_SRC), "injury state read without starting a read");
  t.ok(/STATE\.reads\.rosters = \{ state: "ok", at: Date\.now\(\) \};/.test(FO_SRC) && /STATE\.reads\.rosters = \{ state: "error", at: Date\.now\(\) \};/.test(FO_SRC), "rosters: ok and error recorded");
  t.ok(/STATE\.reads\.leagueEvents = \{ state: data \? "ok" : "error", at: Date\.now\(\) \};/.test(FO_SRC) && /STATE\.reads\.leagueEvents = \{ state: "error", at: Date\.now\(\) \};/.test(FO_SRC), "league events: ok and error recorded");
  const ev = FO_SRC.slice(FO_SRC.indexOf("async function loadContractDeadline()"), FO_SRC.indexOf("async function loadContractDeadline()") + 6000);
  t.ok(ev.indexOf('new CustomEvent("fo:events")') > ev.indexOf("STATE.contractLadderServer =") && ev.indexOf("STATE.reads.leagueEvents = { state: data") > ev.indexOf("STATE.contractLadderServer ="),
    "fo:events fires (and the read counts as done) only after the deadline, kickoffs and ladder are set, not right after the trade lock");
  t.equal((ev.match(/new CustomEvent\("fo:events"\)/g) || []).length, 1, "one announcement, success or failure");
  t.ok(/readState: function \(key\) \{ return \(STATE\.reads && STATE\.reads\[key\]\) \|\| null; \}/.test(FO_SRC), "exposed read-only");
  t.ok(!/kickoff reminder|lineup lock/i.test(SRC), "no kickoff reminder (needs a verified lock source; left out on purpose)");
});

test("layout: Needs attention spans 3 of the top row's 4 columns, Draft picks 1; one column (Needs attention first) at 820 px and below", () => {
  t.ok(/\.fo-ov-grid \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); gap: 12px;/.test(CSS), "four columns, the top row's gap");
  t.ok(/\.fo-ov-row \{ display: grid; grid-template-columns: repeat\(4, minmax\(0, 1fr\)\); gap: 12px;/.test(CSS), "same as the top row");
  t.ok(/\.fo-ov-grid > \.fo-ov-main \{ grid-column: span 3;/.test(CSS) && /\.fo-ov-grid > \.fo-ov-side \{ grid-column: span 1;/.test(CSS));
  t.ok(/@media \(max-width: 820px\) \{ \.fo-ov-grid \{ grid-template-columns: 1fr; \} \.fo-ov-grid > \.fo-ov-main, \.fo-ov-grid > \.fo-ov-side \{ grid-column: auto; \} \}/.test(CSS), "stacked on phones");
  t.ok(/'<div class="fo-ov-grid"><div class="fo-ov-main">' \+ needs \+ '<\/div><div class="fo-ov-side">' \+ side/.test(SRC), "Needs attention comes first in the page order");
});

await run("front_office_overview_checks");
