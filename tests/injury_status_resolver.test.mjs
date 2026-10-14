// site/shared/injury_status.js — the ONE injury-status resolver (Keith 2026-10-14) — unit cases.
// The surfaces' rendering is covered by desktop_gameday_matchups / mobile_lineup_matchups /
// mobile_stats_players_review and injury_status_cross_surface; this file pins the rules.
//   node tests/injury_status_resolver.test.mjs
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";

const box = {};
new Function("window", fs.readFileSync(new URL("../site/shared/injury_status.js", import.meta.url), "utf8"))(box);
const IS = box.UPSInjuryStatus;
const NOW = Date.parse("2026-10-14T13:00:00Z");
const AT = "2026-10-14T12:01:04.000Z";
const mfl = (status, o) => Object.assign({ status, week: 6, updated_utc: AT, details: "Ankle", exp_return: "Oct 18, 2026", return_date: "2026-10-18" }, o || {});
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

test("MFL first: its Q is the tag (named + week), with its description and expected return in the line; the NFL line always beside it", () => {
  const r = R(read({ 1: { mfl: mfl("Questionable") } }), "1", "GBP");
  t.deepEqual(tags(r), ["MFL: Q (Wk 6)"]);
  t.deepEqual([r.chips[0].cls, r.chips[0].prior, r.chips[0].src], ["q", false, "mfl"]);
  t.equal(r.lines[0], "MFL Wk 6: Questionable — Ankle; expected back Oct 18 (updated Wed 8:01 AM ET).");
  t.equal(r.lines[1], "NFL Wk 6 report: not out yet for GBP (or a bye).");
  t.equal(r.disagree, false);
});

test("the NFL report is the tag only when MFL has nothing; when it differs from MFL's, both show", () => {
  const out = R(read({ 1: { report: { status: "Out", injury: "Knee", practice: "Did Not Participate In Practice" } } }), "1", "DEN");
  t.deepEqual(tags(out), ["NFL: OUT (Wk 6)", "MFL: none"]);
  t.equal(out.disagree, true);
  t.ok(out.lines.includes("MFL and the NFL Wk 6 report disagree: MFL has no game designation; the report says Out."), out.lines.join(" | "));
  const qVsOut = R(read({ 1: { mfl: mfl("Questionable"), report: { status: "Out", injury: "Knee" } } }), "1", "DEN");
  t.deepEqual(tags(qVsOut), ["MFL: Q (Wk 6)", "NFL: OUT (Wk 6)"]);
  t.ok(qVsOut.lines.includes("MFL and the NFL Wk 6 report disagree: MFL says Questionable; the report says Out."));
  const agree = R(read({ 1: { mfl: mfl("Out"), report: { status: "Out", injury: "Knee" } } }), "1", "DEN");
  t.deepEqual([tags(agree), agree.disagree], [["MFL: OUT (Wk 6)"], false]);
  t.ok(/the NFL Wk 6 report agrees/.test(agree.chips[0].title));
});

test("not on his team's POSTED report while MFL designates him: a disagreement; a team that hasn't reported isn't one", () => {
  const notListed = R(read({ 1: { mfl: mfl("Questionable") } }), "1", "SEA");
  t.deepEqual(tags(notListed), ["MFL: Q (Wk 6)", "NFL Wk 6: not listed"]);
  t.equal(notListed.chips[1].cls, "na");
  t.ok(notListed.lines.includes("NFL Wk 6 report: not listed (SEA’s report, updated Wed 2:01 AM ET)."));
  const unmatched = R(read({}), "77", "SEA");   // not in the matched-id list: can't be called "not listed"
  t.ok(unmatched.lines.includes("NFL report: no verified NFL id, so he can’t be matched to it."));
});

test("listed on this week's report with practice only: no extra tag; the line says it has no game status yet", () => {
  const r = R(read({ 1: { mfl: mfl("Questionable"), report: { status: null, injury: "Ankle", practice: "Limited Participation in Practice" } } }), "1", "DEN");
  t.deepEqual([tags(r), r.disagree], [["MFL: Q (Wk 6)"], false]);
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
  t.deepEqual(tags(b), ["MFL: Q (Wk 6)"]); t.ok(b.lines.includes("NFL Wk 5 final: Out — Hamstring."));
});

test("a tag from a week before the screen's is dashed (MFL's export still on Wk 5 for a Wk 6 lineup); its week is in the text", () => {
  const r = R(read({ 1: { mfl: mfl("Doubtful", { week: 5 }) } }, { mfl_feed: { week: 5 } }), "1", "GBP");
  t.deepEqual([tags(r), r.chips[0].prior], [["MFL: D (Wk 5)"], true]);
  const sheet = R(read({ 1: { mfl: mfl("Doubtful", { week: 5 }) } }, { mfl_feed: { week: 5 }, roster_feed: { week: 5 } }), "1", "GBP", { week: null });
  t.equal(sheet.chips[0].prior, false, "no screen week: the read's own week");
});

test("a return date already past says so", () => {
  const r = R(read({ 1: { mfl: mfl("Questionable", { exp_return: "Oct 11, 2026", return_date: "2026-10-11" }) } }), "1", "GBP");
  t.ok(/expected back Oct 11 \(already past\)/.test(r.lines[0]) && /already past/.test(r.chips[0].title), r.lines[0]);
  const raw = R(read({ 1: { mfl: mfl("Questionable", { exp_return: "Week 7", return_date: null }) } }), "1", "GBP");
  t.ok(/expected back Week 7 \(/.test(raw.lines[0]), "an unparsed return stays as MFL wrote it");
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
  t.deepEqual(quiet.lines, ["MFL Wk 6: no designation (updated Wed 8:01 AM ET).", "NFL Wk 6 report: not out yet for GBP (or a bye)."], "no tag: each source says what it has");
});

test("while there's no fresh read: the page's own MFL read, labeled as such (game and roster kinds; never invented)", () => {
  const store = { known: (s, w) => String(w) === "6", status: (s, w, id) => ({ 1: "QUESTIONABLE", 2: "IR-PUP", 3: "PROBABLE" })[id] || "", detail: () => "Hip" };
  const q = R({ state: "error" }, "1", "GBP", { fallback: IS.fromMflStore(store, "2026", 6, "1") });
  t.deepEqual(tags(q), ["MFL: Q (Wk 6)"]); t.ok(q.lines.includes("MFL Wk 6: Questionable — Hip (this page’s MFL read)."));
  t.deepEqual(tags(R({ state: "error" }, "2", "GBP", { fallback: IS.fromMflStore(store, "2026", 6, "2") })), ["MFL: PUP"]);
  const none = R({ state: "error" }, "4", "GBP", { fallback: IS.fromMflStore(store, "2026", 6, "4") });
  t.deepEqual([tags(none), none.lines[1]], [[], "MFL Wk 6: no designation (this page’s MFL read)."]);
  t.equal(IS.fromMflStore(store, "2026", 7, "1"), null, "a week the page never read: nothing");
  t.equal(IS.fromMflStore(null, "2026", 6, "1"), null);
});

test("the screen note: where tags come from, both sources, never 'healthy'", () => {
  t.equal(IS.noteText(read({}), { week: 6, now: NOW }), "Tags: MFL’s Wk 6 designations first (updated Wed 8:01 AM ET); where MFL has none, the NFL report — Wk 6’s for 2 teams so far, otherwise the last final (Wk 5). Details shows both. No tag doesn’t mean healthy.");
  t.equal(IS.noteText(read({}, { report_feed: { current: false, week: 5, reason: "the newest report is Wk 5; Wk 6's is not out yet" } }), { week: 6, now: NOW }),
    "Tags: MFL’s Wk 6 designations first (updated Wed 8:01 AM ET); where MFL has none, the NFL’s last final report (Wk 5): Wk 6’s isn’t out yet. Details shows both. No tag doesn’t mean healthy.");
  t.equal(IS.noteText({ state: "error" }, { fallback: true, now: NOW }), "Injury status couldn’t be loaded; tags are MFL’s from this page’s own read. No tag doesn’t mean healthy.");
  t.equal(IS.noteText({ state: "loading" }, { now: NOW }), "Checking injury status…");
  t.equal(IS.optText(R(read({ 1: { mfl: mfl("Out") } }), "1", "GBP")), "  ·  MFL: OUT (Wk 6)");
  t.equal(IS.optText(R(read({}), "1", "GBP")), "");
});

await run("injury_status_resolver");
