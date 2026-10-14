// site/shared/injury_status.js — the ONE injury-status resolver (Keith 2026-10-14) — unit cases.
// The surfaces' rendering is covered by desktop_gameday_matchups / mobile_lineup_matchups /
// mobile_stats_players_review and injury_status_cross_surface; this file pins the rules.
//   node tests/injury_status_resolver.test.mjs
//
// MFL's export has ONE week for the whole file and no date per designation, so an MFL tag
// never claims a week ("MFL: Q"); its line names "MFL's Wk 6 list". A designation whose
// expected return has PASSED is shown as possibly stale: "MFL: Q · return passed", dashed.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";

const box = {};
new Function("window", fs.readFileSync(new URL("../site/shared/injury_status.js", import.meta.url), "utf8"))(box);
const IS = box.UPSInjuryStatus;
const NOW = Date.parse("2026-10-14T13:00:00Z");   // Wed Oct 14 (ET)
const AT = "2026-10-14T12:01:04.000Z";
const SRC = "(MFL’s Wk 6 list, updated Wed 8:01 AM ET)";
const mfl = (status, o) => Object.assign({ status, week: 6, updated_utc: AT, details: "Ankle", exp_return: "Oct 18, 2026", return_date: "2026-10-18" }, o || {});
const PAST = { exp_return: "Sep 13, 2026", return_date: "2026-09-13", details: "Hamstring" };
function read(players, o) {
  o = o || {};
  const data = { ok: true, players, mapped_mfl_ids: Object.keys(players).concat(["9"]),
    report_feed: Object.assign({ ok: true, week: 6, current_week: 6, current: true, updated_utc: "2026-10-14T06:01:28.000Z", reason: null, teams_mfl: ["DEN", "SEA"], prior_weeks: [5] }, o.report_feed || {}),
    roster_feed: Object.assign({ ok: true, week: 6, updated_utc: AT }, o.roster_feed || {}) };
  if (o.mfl_feed !== null) data.mfl_feed = Object.assign({ ok: true, week: 6, updated_utc: AT, count: 1 }, o.mfl_feed || {});
  return { state: "ok", data, at: o.at != null ? o.at : NOW - 60000 };
}
const R = (rd, pid, team, opts) => JSON.parse(JSON.stringify(IS.resolve(rd, pid, team, Object.assign({ week: 6, now: NOW }, opts || {}))));
const tags = (r) => r.chips.map((c) => c.t);

test("MFL first: \"MFL: Q\" — never a week on an MFL tag (the export's week is its LIST's, not the designation's)", () => {
  const r = R(read({ 1: { mfl: mfl("Questionable") } }), "1", "GBP");
  t.deepEqual(tags(r), ["MFL: Q"]);
  t.deepEqual([r.chips[0].cls, r.chips[0].prior, r.chips[0].src], ["q", false, "mfl"]);
  t.equal(r.lines[0], "MFL: Questionable — Ankle; expected back Oct 18 " + SRC + ".");
  t.equal(r.chips[0].title, "MFL: Questionable — Ankle; expected back Oct 18 " + SRC);
  t.equal(r.lines[1], "NFL Wk 6 report: not out yet for GBP (or a bye).");
  t.equal(r.disagree, false);
  for (const s of ["Doubtful", "Out"]) t.ok(!/Wk/.test(tags(R(read({ 1: { mfl: mfl(s) } }), "1", "GBP"))[0]), s);
});

test("a future expected return: solid tag; a missing one: no date invented", () => {
  const r = R(read({ 1: { mfl: mfl("Doubtful", { exp_return: "Oct 19, 2026", return_date: "2026-10-19" }) } }), "1", "GBP");
  t.deepEqual([tags(r), r.chips[0].prior], [["MFL: D"], false]);
  const none = R(read({ 1: { mfl: mfl("Out", { exp_return: null, return_date: null }) } }), "1", "GBP");
  t.equal(none.lines[0], "MFL: Out — Ankle " + SRC + ".");
  const raw = R(read({ 1: { mfl: mfl("Questionable", { exp_return: "Week 7", return_date: null }) } }), "1", "GBP");
  t.equal(raw.lines[0], "MFL: Questionable — Ankle; expected back Week 7 " + SRC + ".", "an unparsed return stays as MFL wrote it, never judged past");
  t.equal(raw.chips[0].prior, false);
});

test("an expected return that has PASSED: the tag says so and is dashed; the line says it may be out of date, then the NFL line for comparison", () => {
  const rd = read({ 1: { mfl: mfl("Questionable", PAST), prior: { week: 5, status: "Out", injury: "Hamstring" } } });
  const r = R(rd, "1", "GBP");
  t.deepEqual(tags(r), ["MFL: Q · return passed"]);
  t.deepEqual([r.chips[0].cls, r.chips[0].prior], ["q", true]);
  t.equal(r.lines[0], "MFL still lists him Questionable — Hamstring, with an expected return of Sep 13, which has passed, so the designation may be out of date " + SRC + ".");
  t.equal(r.lines[1], "NFL Wk 6 report: not out yet for GBP (or a bye).");
  t.equal(r.lines[2], "NFL Wk 5 final: Out — Hamstring.", "last week's final for comparison");
  t.equal(IS.optText(r), "  ·  MFL: Q (return passed)", "the dropdown says it too");
  const yesterday = R(read({ 1: { mfl: mfl("Out", { return_date: "2026-10-13", exp_return: "Oct 13, 2026" }) } }), "1", "GBP");
  t.equal(tags(yesterday)[0], "MFL: OUT · return passed", "the day after the return date (ET)");
  const today = R(read({ 1: { mfl: mfl("Out", { return_date: "2026-10-14", exp_return: "Oct 14, 2026" }) } }), "1", "GBP");
  t.equal(tags(today)[0], "MFL: OUT", "the return date itself isn't past yet");
});

test("a passed return date AND his team's posted report doesn't list him: both shown, and counted as a disagreement", () => {
  const r = R(read({ 1: { mfl: mfl("Questionable", PAST) } }), "1", "SEA");
  t.deepEqual(tags(r), ["MFL: Q · return passed", "NFL Wk 6: not listed"]);
  t.equal(r.disagree, true);
  t.ok(r.lines.includes("NFL Wk 6 report: not listed (SEA’s report, updated Wed 2:01 AM ET)."), r.lines.join(" | "));
  t.ok(r.lines.includes("MFL and the NFL Wk 6 report disagree: MFL lists Questionable (its return date has passed); the report doesn’t list him."), r.lines.join(" | "));
});

test("the NFL report is the tag only when MFL has nothing (with its week); when it differs from MFL's, both show", () => {
  const out = R(read({ 1: { report: { status: "Out", injury: "Knee", practice: "Did Not Participate In Practice" } } }), "1", "DEN");
  t.deepEqual(tags(out), ["NFL: OUT (Wk 6)", "MFL: none"]);
  t.equal(out.disagree, true);
  t.equal(out.lines[0], "MFL: no designation (MFL’s Wk 6 list, updated Wed 8:01 AM ET).");
  t.ok(out.lines.includes("MFL and the NFL Wk 6 report disagree: MFL has no game designation; the report says Out."), out.lines.join(" | "));
  const qVsOut = R(read({ 1: { mfl: mfl("Questionable"), report: { status: "Out", injury: "Knee" } } }), "1", "DEN");
  t.deepEqual(tags(qVsOut), ["MFL: Q", "NFL: OUT (Wk 6)"]);
  t.ok(qVsOut.lines.includes("MFL and the NFL Wk 6 report disagree: MFL lists Questionable; the report says Out."));
  const agree = R(read({ 1: { mfl: mfl("Out"), report: { status: "Out", injury: "Knee" } } }), "1", "DEN");
  t.deepEqual([tags(agree), agree.disagree], [["MFL: OUT"], false]);
  t.ok(/the NFL Wk 6 report agrees/.test(agree.chips[0].title));
});

test("not on his team's POSTED report while MFL designates him: a disagreement; a team that hasn't reported isn't one", () => {
  const notListed = R(read({ 1: { mfl: mfl("Questionable") } }), "1", "SEA");
  t.deepEqual(tags(notListed), ["MFL: Q", "NFL Wk 6: not listed"]);
  t.equal(notListed.chips[1].cls, "na");
  t.ok(notListed.lines.includes("NFL Wk 6 report: not listed (SEA’s report, updated Wed 2:01 AM ET)."));
  const unmatched = R(read({}), "77", "SEA");   // not in the matched-id list: can't be called "not listed"
  t.ok(unmatched.lines.includes("NFL report: no verified NFL id, so he can’t be matched to it."));
});

test("listed on this week's report with practice only: no extra tag; the line says it has no game status yet", () => {
  const r = R(read({ 1: { mfl: mfl("Questionable"), report: { status: null, injury: "Ankle", practice: "Limited Participation in Practice" } } }), "1", "DEN");
  t.deepEqual([tags(r), r.disagree], [["MFL: Q"], false]);
  t.ok(r.lines.includes("NFL Wk 6 report: listed, no game status yet — Ankle · practice: limited (updated Wed 2:01 AM ET)."));
});

test("an MFL roster designation is MFL saying something: IR + the report's Q shows both, never 'MFL: none'", () => {
  const r = R(read({ 1: { roster: { chip: "IR-R", label: "Injured reserve – designated to return", detail: "Knee" }, report: { status: "Questionable", injury: "Knee" } } }), "1", "DEN");
  t.deepEqual(tags(r), ["MFL: IR-R", "NFL: Q (Wk 6)"]);
  t.equal(r.disagree, false);
  t.deepEqual([r.chips[0].cls, r.chips[0].src], ["res", "roster"]);
  t.ok(r.lines.includes("MFL roster: Injured reserve – designated to return (Knee) (updated Wed 8:01 AM ET)."));
});

test("nothing from MFL and nothing current from the NFL: his last final, labeled and dashed; with MFL, the final is a line only", () => {
  const rd = read({ 1: { prior: { week: 5, status: "Out", injury: "Hamstring", team: "GB" } }, 2: { mfl: mfl("Questionable"), prior: { week: 5, status: "Out", injury: "Hamstring" } } });
  const a = R(rd, "1", "GBP");
  t.deepEqual(tags(a), ["NFL: OUT (Wk 5 final)"]); t.equal(a.chips[0].prior, true);
  t.ok(a.lines.includes("NFL Wk 5 final: Out — Hamstring."));
  const b = R(rd, "2", "GBP");
  t.deepEqual(tags(b), ["MFL: Q"]); t.ok(b.lines.includes("NFL Wk 5 final: Out — Hamstring."));
});

test("MFL's list still on last week (Wk 5) for a Wk 6 lineup: its tag is dashed and the line names the Wk 5 list", () => {
  const r = R(read({ 1: { mfl: mfl("Doubtful", { week: 5 }) } }, { mfl_feed: { week: 5 } }), "1", "GBP");
  t.deepEqual([tags(r), r.chips[0].prior], [["MFL: D"], true]);
  t.ok(/\(MFL’s Wk 5 list, updated /.test(r.lines[0]), r.lines[0]);
  const sheet = R(read({ 1: { mfl: mfl("Doubtful", { week: 5 }) } }, { mfl_feed: { week: 5 }, roster_feed: { week: 5 } }), "1", "GBP", { week: null });
  t.equal(sheet.chips[0].prior, false, "no screen week: the read's own week");
});

test("never 'healthy': an unread / failed / old read, an unreadable MFL feed, an old server without MFL's field — each said in words", () => {
  const loading = R({ state: "loading" }, "1", "GBP");
  t.deepEqual([tags(loading), loading.lines], [[], ["Checking injury status…"]]);
  const failed = R({ state: "error" }, "1", "GBP");
  t.deepEqual(failed.lines, ["Injury status couldn’t be loaded. No tag doesn’t mean healthy."]);
  const old = R(read({ 1: { mfl: mfl("Out") } }, { at: NOW - IS.TTL - 1000 }), "1", "GBP");
  t.deepEqual([tags(old), old.lines], [[], ["Checking injury status…"]], "a read older than 5 minutes is never shown as current");
  const mflDown = R(read({}, { mfl_feed: { ok: false, reason: "unreadable: HTTP 500" } }), "1", "GBP");
  t.equal(mflDown.lines[0], "MFL’s injury designations couldn’t be read, so MFL’s is unknown.");
  const oldServer = R(read({}, { mfl_feed: null }), "1", "GBP");
  t.equal(oldServer.lines[0], "MFL’s designation isn’t available from this server yet.");
  const nflDown = R(read({}, { report_feed: { ok: false, current: false, reason: "unreadable: HTTP 502" } }), "1", "GBP");
  t.ok(nflDown.lines.includes("NFL injury report unavailable: it couldn’t be read."), nflDown.lines.join(" | "));
  const quiet = R(read({}), "9", "GBP");
  t.deepEqual(quiet.lines, ["MFL: no designation (MFL’s Wk 6 list, updated Wed 8:01 AM ET).", "NFL Wk 6 report: not out yet for GBP (or a bye)."], "no tag: each source says what it has");
});

test("while there's no fresh read: the page's own MFL read, labeled as such (game and roster kinds; never invented)", () => {
  const store = { known: (s, w) => String(w) === "6", status: (s, w, id) => ({ 1: "QUESTIONABLE", 2: "IR-PUP", 3: "PROBABLE" })[id] || "", detail: () => "Hip" };
  const q = R({ state: "error" }, "1", "GBP", { fallback: IS.fromMflStore(store, "2026", 6, "1") });
  t.deepEqual(tags(q), ["MFL: Q"]); t.ok(q.lines.includes("MFL: Questionable — Hip (this page’s read of MFL’s Wk 6 list)."), q.lines.join(" | "));
  t.deepEqual(tags(R({ state: "error" }, "2", "GBP", { fallback: IS.fromMflStore(store, "2026", 6, "2") })), ["MFL: PUP"]);
  const none = R({ state: "error" }, "4", "GBP", { fallback: IS.fromMflStore(store, "2026", 6, "4") });
  t.deepEqual([tags(none), none.lines[1]], [[], "MFL: no designation (this page’s read of MFL’s Wk 6 list)."]);
  t.equal(IS.fromMflStore(store, "2026", 7, "1"), null, "a week the page never read: nothing");
  t.equal(IS.fromMflStore(null, "2026", 6, "1"), null);
});

test("the screen note: where tags come from, what a dashed MFL tag means, both sources, never 'healthy'", () => {
  t.equal(IS.noteText(read({}), { week: 6, now: NOW }), "Tags: MFL’s list first (its Wk 6 list, updated Wed 8:01 AM ET; dashed = MFL’s return date has passed); where MFL has none, the NFL report — Wk 6’s for 2 teams so far, otherwise the last final (Wk 5). Details shows both. No tag doesn’t mean healthy.");
  t.equal(IS.noteText(read({}, { report_feed: { current: false, week: 5, reason: "the newest report is Wk 5; Wk 6's is not out yet" } }), { week: 6, now: NOW }),
    "Tags: MFL’s list first (its Wk 6 list, updated Wed 8:01 AM ET; dashed = MFL’s return date has passed); where MFL has none, the NFL’s last final report (Wk 5): Wk 6’s isn’t out yet. Details shows both. No tag doesn’t mean healthy.");
  t.equal(IS.noteText({ state: "error" }, { fallback: true, now: NOW }), "Injury status couldn’t be loaded; tags are MFL’s from this page’s own read. No tag doesn’t mean healthy.");
  t.equal(IS.noteText({ state: "loading" }, { now: NOW }), "Checking injury status…");
  t.equal(IS.optText(R(read({ 1: { mfl: mfl("Out") } }), "1", "GBP")), "  ·  MFL: OUT");
  t.equal(IS.optText(R(read({}), "9", "GBP")), "");
});

await run("injury_status_resolver");
