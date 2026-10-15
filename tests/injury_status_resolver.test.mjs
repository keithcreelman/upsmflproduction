// site/shared/injury_status.js — the ONE injury-status resolver — unit cases.
// The surfaces' rendering is covered by desktop_gameday_matchups / mobile_lineup_matchups /
// mobile_stats_players_review and injury_status_cross_surface; this file pins the rules.
//   node tests/injury_status_resolver.test.mjs
//
// Keith 2026-10-15 (#1311): a chip is only the designation (Q, D, OUT, IR, PUP, SUSP), one per
// player, MFL's first. When MFL and the CURRENT official NFL report disagree, the player page
// gets a red "Injury sources disagree" warning stating each source; it is information only.
// No expected-return dates, "est. return passed" or dashed chips. One explanation, under About;
// a screen line only when a source is unavailable.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";

const box = {};
new Function("window", fs.readFileSync(new URL("../site/shared/injury_status.js", import.meta.url), "utf8"))(box);
const IS = box.UPSInjuryStatus;
const NOW = Date.parse("2026-10-14T13:00:00Z");   // Wed Oct 14 (ET)
const AT = "2026-10-14T12:01:04.000Z";
const READ = "2026-10-14T12:58:00.000Z";
// Every MFL row carries an expected return (one already passed): none of it may ever show.
const mfl = (status, o) => Object.assign({ status, week: 6, updated_utc: AT, details: "Ankle", exp_return: "Sep 13, 2026", return_date: "2026-09-13" }, o || {});
function read(players, o) {
  o = o || {};
  const data = { ok: true, players, mapped_mfl_ids: "mapped" in o ? o.mapped : Object.keys(players).concat(["9"]),
    report_feed: Object.assign({ ok: true, week: 6, current_week: 6, current: true, updated_utc: "2026-10-14T06:01:28.000Z", reason: null, teams_mfl: ["DEN", "SEA"], prior_weeks: [5] }, o.report_feed || {}),
    roster_feed: Object.assign({ ok: true, week: 6, updated_utc: AT }, o.roster_feed || {}) };
  data.generated_utc = READ;
  if (o.mfl_feed !== null) data.mfl_feed = Object.assign({ ok: true, week: 6, read_utc: READ, updated_utc: AT, count: 1 }, o.mfl_feed || {});
  return { state: "ok", data, at: o.at != null ? o.at : NOW - 60000 };
}
const R = (rd, pid, team, opts) => JSON.parse(JSON.stringify(IS.resolve(rd, pid, team, Object.assign({ week: 6, now: NOW }, opts || {}))));
const tags = (r) => r.chips.map((c) => c.t);
const ALLOWED = /^(Q|D|OUT|IR|PUP|NFI|SUSP|HOLD|RET)$/;
// Nothing the owner reads may carry machinery or verdicts.
function clean(r, label) {
  t.ok(r.chips.length <= 1, label + ": at most one chip");
  for (const c of r.chips) t.ok(ALLOWED.test(c.t), label + ": the chip is just a designation: " + c.t);
  const all = r.chips.map((c) => c.t + " " + c.title).concat(r.lines, r.warning ? [r.warning.title].concat(r.warning.lines) : []).join(" | ");
  t.ok(!/est\. return|expected return|Sep 13|Oct 18|Nov 15|return date|stale|dashed/i.test(all), label + ": no expected-return dates or stale wording: " + all);
  t.ok(!/read at|updated|\d:\d\d [AP]M|ET\b/.test(all), label + ": no read times: " + all);
  t.ok(!/healthy|wrong|incorrect|out of date|error in/i.test(all), label + ": never calls a source wrong or the player healthy: " + all);
  t.ok(!r.chips.some((c) => c.prior), label + ": no dashed (prior) chip");
}

// ── Keith's six required examples (2026-10-15) ──

test("1. MFL Q, no current NFL designation: one Q chip; his team's posted report doesn't list him → the warning; not posted → no warning", () => {
  const notListed = R(read({ 1: { mfl: mfl("Questionable") } }), "1", "SEA");   // SEA posted Week 6
  t.deepEqual(tags(notListed), ["Q"]);
  t.deepEqual([notListed.chips[0].cls, notListed.chips[0].src], ["q", "mfl"]);
  t.equal(notListed.disagree, true);
  t.deepEqual(notListed.warning, { title: "Injury sources disagree", lines: ["MFL: Questionable (Ankle)", "Official NFL report: Not listed for Week 6"] });
  t.equal(IS.optText(notListed), "  ·  Q", "the dropdown choice: just the designation");
  clean(notListed, "not listed");
  const notPosted = R(read({ 1: { mfl: mfl("Questionable") } }), "1", "GBP");   // GBP hasn't posted (or a bye)
  t.deepEqual([tags(notPosted), notPosted.warning, notPosted.disagree], [["Q"], null, false]);
  t.deepEqual(notPosted.lines, ["MFL: Questionable (Ankle)", "Official NFL report: Week 6 not posted yet for GBP (or a bye)"]);
  clean(notPosted, "not posted");
  const practiceOnly = R(read({ 1: { mfl: mfl("Questionable"), report: { status: null, injury: "Ankle", practice: "Limited Participation in Practice" } } }), "1", "DEN");
  t.deepEqual([tags(practiceOnly), practiceOnly.warning], [["Q"], null], "listed with practice only (no game status yet): nothing to disagree with");
  t.deepEqual(practiceOnly.lines, ["MFL: Questionable (Ankle)", "Official NFL report: Listed for Week 6, no game status yet (Ankle) · practice: limited"]);
});

test("2. both sources agree: one chip, no warning, both stated on the player page", () => {
  const r = R(read({ 1: { mfl: mfl("Out"), report: { status: "Out", injury: "Knee", practice: "Did Not Participate In Practice" } } }), "1", "DEN");
  t.deepEqual([tags(r), r.warning, r.disagree], [["OUT"], null, false]);
  t.deepEqual(r.lines, ["MFL: Out (Ankle)", "Official NFL report: Out for Week 6 (Knee) · practice: did not practice"]);
  const none = R(read({ 1: {} }), "1", "SEA");   // neither has him: also agreement
  t.deepEqual([tags(none), none.warning], [[], null]);
  t.deepEqual(none.lines, ["MFL: No designation", "Official NFL report: Not listed for Week 6"]);
  clean(r, "agree"); clean(none, "agree on nothing");
});

test("3. MFL and the official report differ: MFL's chip, and the warning states each", () => {
  const r = R(read({ 1: { mfl: mfl("Questionable"), report: { status: "Out", injury: "Knee", practice: "Did Not Participate In Practice" } } }), "1", "DEN");
  t.deepEqual(tags(r), ["Q"], "MFL stays primary");
  t.deepEqual(r.warning, { title: "Injury sources disagree", lines: ["MFL: Questionable (Ankle)", "Official NFL report: Out for Week 6 (Knee)"] });
  t.deepEqual(r.lines, ["Practice (official report): did not practice"], "the warning already says both; the practice line stays");
  const d = R(read({ 1: { mfl: mfl("Doubtful", { details: null }), report: { status: "Questionable", injury: null } } }), "1", "DEN");
  t.deepEqual([tags(d), d.warning.lines], [["D"], ["MFL: Doubtful", "Official NFL report: Questionable for Week 6"]]);
  clean(r, "Q vs Out"); clean(d, "D vs Q");
});

test("4. MFL has no designation, the official report does: the report's chip, and the warning", () => {
  const r = R(read({ 1: { report: { status: "Out", injury: "Knee", practice: "Did Not Participate In Practice" } } }), "1", "DEN");
  t.deepEqual(tags(r), ["OUT"]);
  t.deepEqual([r.chips[0].cls, r.chips[0].src], ["out", "nfl"]);
  t.deepEqual(r.warning, { title: "Injury sources disagree", lines: ["MFL: No designation", "Official NFL report: Out for Week 6 (Knee)"] });
  clean(r, "MFL absent");
});

test("5. IR / PUP: MFL's roster designation is the chip (IR-R shows IR), never compared with the game report", () => {
  const ir = R(read({ 1: { roster: { chip: "IR-R", label: "Injured reserve – designated to return", detail: "Knee", exp_return: "Nov 15, 2026" }, report: { status: "Questionable", injury: "Knee" } } }), "1", "DEN");
  t.deepEqual(tags(ir), ["IR"]);
  t.deepEqual([ir.chips[0].cls, ir.chips[0].src, ir.warning], ["res", "roster", null]);
  t.deepEqual(ir.lines, ["MFL roster: Injured reserve – designated to return (Knee)", "Official NFL report: Questionable for Week 6 (Knee)"], "never followed by 'MFL: No designation'");
  const pup = R(read({ 1: { roster: { chip: "PUP", label: "Physically unable to perform", detail: null } } }), "1", "SEA");
  t.deepEqual([tags(pup), pup.warning], [["PUP"], null]);
  t.deepEqual(pup.lines, ["MFL roster: Physically unable to perform", "Official NFL report: Not listed for Week 6"]);
  const susp = R(read({ 1: { roster: { chip: "SUSP", label: "Suspended", detail: null } } }), "1", "GBP");
  t.deepEqual(tags(susp), ["SUSP"]);
  clean(ir, "IR"); clean(pup, "PUP"); clean(susp, "SUSP");
});

test("6. either source unavailable: the other's chip, no warning (nothing to compare), the page says which couldn't be read", () => {
  const mflDown = R(read({ 1: { report: { status: "Out", injury: "Knee" } } }, { mfl_feed: { ok: false, reason: "unreadable: HTTP 500" } }), "1", "DEN");
  t.deepEqual([tags(mflDown), mflDown.warning], [["OUT"], null]);
  t.deepEqual(mflDown.lines, ["MFL: Couldn’t be read", "Official NFL report: Out for Week 6 (Knee)"]);
  t.equal(IS.noteText(read({}, { mfl_feed: { ok: false } }), { now: NOW }), "MFL’s injury list couldn’t be read; tags come from the official NFL report.");
  const oldServer = R(read({ 1: {} }, { mfl_feed: null }), "1", "SEA");
  t.deepEqual([oldServer.warning, oldServer.lines[0]], [null, "MFL: Couldn’t be read"], "a server without MFL's field: unknown, never 'No designation'");
  const nflDown = R(read({ 1: { mfl: mfl("Questionable") } }, { report_feed: { ok: false, current: false, reason: "unreadable: HTTP 502" } }), "1", "DEN");
  t.deepEqual([tags(nflDown), nflDown.warning], [["Q"], null]);
  t.deepEqual(nflDown.lines, ["MFL: Questionable (Ankle)", "Official NFL report: Couldn’t be read"]);
  t.equal(IS.noteText(read({}, { report_feed: { ok: false, current: false } }), { now: NOW }), "The official NFL report couldn’t be read; tags are MFL’s alone.");
  t.equal(IS.noteText(read({}, { mfl_feed: { ok: false }, report_feed: { ok: false, current: false } }), { now: NOW }),
    "Neither MFL’s injury list nor the official NFL report could be read, so injury tags may be missing.");
  const notOut = R(read({ 1: { mfl: mfl("Doubtful") } }, { report_feed: { current: false, week: 5, reason: "the newest report is Wk 5; Wk 6's is not out yet" } }), "1", "DEN");
  t.deepEqual([tags(notOut), notOut.warning, notOut.lines[1]], [["D"], null, "Official NFL report: Not posted yet"]);
  t.equal(IS.noteText(read({}, { report_feed: { current: false, week: 5, reason: "not out yet" } }), { now: NOW }), "", "a report not posted yet isn't a failure");
  // the status read itself: failed / loading / older than 5 minutes → no chip unless the page's own MFL read
  const failed = R({ state: "error" }, "1", "GBP");
  t.deepEqual([tags(failed), failed.lines, failed.warning], [[], ["Injury status couldn’t be loaded."], null]);
  t.deepEqual(R({ state: "loading" }, "1", "GBP").lines, ["Checking injury status…"]);
  const old = R(read({ 1: { mfl: mfl("Out") } }, { at: NOW - IS.TTL - 1000 }), "1", "GBP");
  t.deepEqual([tags(old), old.lines], [[], ["Checking injury status…"]], "a read older than 5 minutes is never shown as current");
  t.equal(IS.noteText({ state: "error" }, { now: NOW }), "Injury status couldn’t be loaded, so no injury tags are shown.");
  t.equal(IS.noteText({ state: "error" }, { fallback: true, now: NOW }), "Injury status couldn’t be loaded; tags are MFL’s from this page’s own read.");
  t.equal(IS.noteText({ state: "loading" }, { now: NOW }), "Checking injury status…");
  for (const [r, l] of [[mflDown, "MFL down"], [nflDown, "NFL down"], [notOut, "not out"], [failed, "failed"], [oldServer, "old server"]]) clean(r, l);
});

// ── the guards around "not listed" and the warning ──

test("'not listed' needs a verified NFL id and a team on a posted report: no id or a free agent never disagrees", () => {
  const noId = R(read({ 77: { mfl: mfl("Questionable") } }, { mapped: ["9"] }), "77", "SEA");
  t.deepEqual([tags(noId), noId.warning, noId.disagree], [["Q"], null, false]);
  t.deepEqual(noId.lines, ["MFL: Questionable (Ankle)", "Official NFL report: No verified NFL id, so he can’t be matched"]);
  const noMap = R(read({ 1: { mfl: mfl("Questionable") } }, { mapped: null }), "1", "SEA");
  t.deepEqual([noMap.warning, noMap.lines], [null, ["MFL: Questionable (Ankle)", "Official NFL report: Couldn’t tell whether he’s on it"]], "no id list at all: can't tell, never 'not listed'");
  const fa = R(read({ 1: { mfl: mfl("Out") } }), "1", "FA");
  t.deepEqual([fa.warning, fa.lines[1]], [null, "Official NFL report: Free agent, not on a team’s report"]);
  t.deepEqual(R(read({ 1: { mfl: mfl("Questionable") } }), "1", "sea").warning.lines[1], "Official NFL report: Not listed for Week 6", "team codes in any case");
  t.equal(R(read({ 1: { mfl: mfl("Questionable") } }, { report_feed: { teams_mfl: ["GBP"] } }), "1", "GB").disagree, true, "nflverse's GB = MFL's GBP");
});

test("a previous week's final report is a detail line, never a chip", () => {
  const rd = read({ 1: { prior: { week: 5, status: "Out", injury: "Hamstring" } }, 2: { mfl: mfl("Questionable"), prior: { week: 5, status: "Out", injury: "Hamstring" } } },
    { report_feed: { current: false, week: 5, reason: "the newest report is Wk 5; Wk 6's is not out yet" } });
  const a = R(rd, "1", "GBP");
  t.deepEqual([tags(a), a.warning], [[], null]);
  t.deepEqual(a.lines, ["MFL: No designation", "Official NFL report: Not posted yet", "Official NFL report for Week 5 (final): Out (Hamstring)"]);
  const b = R(rd, "2", "GBP");
  t.deepEqual([tags(b), b.lines[2]], [["Q"], "Official NFL report for Week 5 (final): Out (Hamstring)"]);
  clean(a, "prior only"); clean(b, "prior + MFL");
});

test("while there's no fresh read: the page's own MFL read, labeled as such (game and roster kinds; never invented)", () => {
  const store = { known: (s, w) => String(w) === "6", status: (s, w, id) => ({ 1: "QUESTIONABLE", 2: "IR-PUP", 3: "PROBABLE", 5: "IR-R" })[id] || "", detail: () => "Hip" };
  const q = R({ state: "error" }, "1", "GBP", { fallback: IS.fromMflStore(store, "2026", 6, "1") });
  t.deepEqual([tags(q), q.lines], [["Q"], ["Injury status couldn’t be loaded.", "MFL (this page’s read): Questionable (Hip)"]]);
  t.deepEqual(tags(R({ state: "error" }, "2", "GBP", { fallback: IS.fromMflStore(store, "2026", 6, "2") })), ["PUP"]);
  const irr = R({ state: "loading" }, "5", "GBP", { fallback: IS.fromMflStore(store, "2026", 6, "5") });
  t.deepEqual([tags(irr), irr.lines[1]], [["IR"], "MFL roster (this page’s read): Injured reserve – designated to return (Hip)"]);
  const none = R({ state: "error" }, "4", "GBP", { fallback: IS.fromMflStore(store, "2026", 6, "4") });
  t.deepEqual([tags(none), none.lines[1]], [[], "MFL (this page’s read): No designation"]);
  t.equal(IS.fromMflStore(store, "2026", 7, "1"), null, "a week the page never read: nothing");
  t.equal(IS.fromMflStore(null, "2026", 6, "1"), null);
  t.deepEqual(tags(R({ state: "error" }, "3", "GBP", { fallback: IS.fromMflStore(store, "2026", 6, "3") })), [], "Probable is no chip");
  for (const [r, l] of [[q, "fallback Q"], [irr, "fallback IR-R"], [none, "fallback none"]]) clean(r, l);
});

test("About is the one explanation; the screen note is empty when all is well", () => {
  t.equal(IS.aboutText(), "Injury status uses MFL for the current designation and checks it against the official NFL report. If they disagree, the player page calls it out.");
  t.equal(IS.noteText(read({}), { week: 6, now: NOW }), "");
  t.equal(IS.optText(R(read({ 1: { mfl: mfl("Out") } }), "1", "GBP")), "  ·  OUT");
  t.equal(IS.optText(R(read({}), "9", "GBP")), "");
});

await run("injury_status_resolver");
