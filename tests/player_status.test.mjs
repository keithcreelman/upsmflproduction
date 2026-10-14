// Injury status for the mobile Players list and sheet (2026-10-10).
//   node tests/player_status.test.mjs
//
// The report designation (Out / Doubtful / Questionable) comes from this
// week's official NFL injury report; the roster designation (IR, IR-R, PUP …)
// from MFL's injuries export; and (2026-10-14, additive) MFL's own game
// designation rides apart in `mfl`, labeled with the export's week. A feed that can't be read, a report for another
// week, or one over 36 h old is UNAVAILABLE — never "no designation".
// Pure assembly first, then the real route with the network stubbed.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, callWorker, quiet } from "./fixtures/fcfs_worker_harness.mjs";
import { assemble, parseCsv, mflReturnDate, STALE_HOURS } from "../worker/src/player_status.js";

const HEAD = "season,season_type,game_type,team,week,gsis_id,position,full_name,first_name,last_name,report_primary_injury,report_secondary_injury,report_status,practice_primary_injury,practice_secondary_injury,practice_status";
const line = (team, week, gsis, status, inj, prac) => `2026,REG,REG,${team},${week},${gsis},WR,"Last, First",F,L,${inj || ""},,${status || ""},${inj || ""},,${prac || ""}`;
const csv = (...lines) => [HEAD, ...lines].join("\n") + "\n";
const NOW = Date.parse("2026-10-10T15:00:00Z");
const FRESH = "Sat, 10 Oct 2026 13:33:06 GMT";
const mflPayload = (week, rows) => ({ injuries: { week: String(week), timestamp: String(Math.floor(Date.parse("2026-10-10T14:01:03Z") / 1000)), injury: rows } });
const MAP = { "00-0000001": "101", "00-0000002": "102", "00-0000003": "103", "00-0000004": "104" };

test("CSV: quoted commas and doubled quotes survive", () => {
  const r = parseCsv('a,b,c\n1,"x, ""y""",3\r\n4,,6\n');
  t.deepEqual(r, [{ a: "1", b: 'x, "y"', c: "3" }, { a: "4", b: "", c: "6" }]);
});

test("a status change: Questionable on one read, Out on the next; the roster designation is kept apart", () => {
  const mfl = mflPayload(5, [{ id: "102", status: "IR-R", details: "Knee" }]);
  const a = assemble({ reportRows: parseCsv(csv(line("BUF", 5, "00-0000001", "Questionable", "Hamstring", "Limited Participation in Practice"),
                                               line("BUF", 5, "00-0000002", "Questionable", "Knee", "Full Participation in Practice"))),
                       reportModified: FRESH, mflPayload: mfl, gsisToMfl: MAP, now: NOW });
  t.equal(a.report_feed.current, true, JSON.stringify(a.report_feed));
  t.deepEqual([a.players["101"].report.status, a.players["101"].report.injury, a.players["101"].report.practice],
    ["Questionable", "Hamstring", "Limited Participation in Practice"]);
  t.deepEqual([a.players["102"].report.status, a.players["102"].roster.chip, a.players["102"].roster.label],
    ["Questionable", "IR-R", "Injured reserve – designated to return"], "both shown, each from its own source");
  const b = assemble({ reportRows: parseCsv(csv(line("BUF", 5, "00-0000001", "Out", "Hamstring", "Did Not Participate In Practice"))),
                       reportModified: FRESH, mflPayload: mfl, gsisToMfl: MAP, now: NOW });
  t.equal(b.players["101"].report.status, "Out", "the newer report wins");
  t.equal(b.players["102"].report, undefined, "dropped from the report: no game designation now");
  t.equal(b.players["102"].roster.chip, "IR-R");
});

test("no designation: his team's report was read and he isn't on it -> nothing, and the team is listed as reported", () => {
  const a = assemble({ reportRows: parseCsv(csv(line("GB", 5, "00-0000001", "Out", "Ankle", "Did Not Participate In Practice"))),
                       reportModified: FRESH, mflPayload: mflPayload(5, []), gsisToMfl: MAP, now: NOW });
  t.equal(a.players["103"], undefined);
  t.deepEqual([a.report_feed.teams, a.report_feed.teams_mfl], [["GB"], ["GBP"]], "MFL's code for the UI");
});

test("unavailable: an unreadable report, an unreadable MFL feed, last week's report, an old file", () => {
  const rows = parseCsv(csv(line("BUF", 5, "00-0000001", "Out", "Ankle", "")));
  const down = assemble({ reportError: "HTTP 503", mflPayload: mflPayload(5, [{ id: "102", status: "IR", details: "Knee" }]), gsisToMfl: MAP, now: NOW });
  t.deepEqual([down.report_feed.ok, down.report_feed.current, down.players["101"]], [false, false, undefined]);
  t.ok(/unreadable/.test(down.report_feed.reason));
  t.equal(down.players["102"].roster.chip, "IR", "the roster feed still answers");
  const noMfl = assemble({ reportRows: rows, reportModified: FRESH, mflError: "HTTP 500", gsisToMfl: MAP, now: NOW });
  t.deepEqual([noMfl.report_feed.current, noMfl.roster_feed.ok, Object.keys(noMfl.players).length], [false, false, 0],
    "without MFL's current week the report can't be called current");
  const lastWeek = assemble({ reportRows: parseCsv(csv(line("BUF", 4, "00-0000001", "Out", "Ankle", ""))), reportModified: FRESH,
                              mflPayload: mflPayload(5, []), gsisToMfl: MAP, now: NOW });
  t.deepEqual([lastWeek.report_feed.current, lastWeek.report_feed.week, lastWeek.players["101"].report], [false, 4, undefined],
    "no CURRENT designation from last week's report");
  t.deepEqual(lastWeek.players["101"].prior, { week: 4, status: "Out", team: "BUF", injury: "Ankle" }, "only as last week's, labeled with its week");
  t.ok(/Wk 5's is not out yet/.test(lastWeek.report_feed.reason), lastWeek.report_feed.reason);
  const old = assemble({ reportRows: rows, reportModified: new Date(NOW - (STALE_HOURS + 1) * 3600e3).toUTCString(),
                         mflPayload: mflPayload(5, []), gsisToMfl: MAP, now: NOW });
  t.deepEqual([old.report_feed.current, old.players["101"]], [false, undefined]);
  t.ok(/not updated/.test(old.report_feed.reason));
});

test("last week's final designation (Lineup, Keith 2026-10-13): only for teams without a current-week report, from the team's latest report, ≤ 2 weeks back, Q/D/Out only", () => {
  const rows = parseCsv(csv(
    line("BUF", 4, "00-0000001", "Out", "Ankle", ""),          // BUF's Wk 4 report …
    line("BUF", 5, "00-0000002", "Questionable", "Knee", ""),  // … and its Wk 5 report (the latest): 101 isn't on it any more
    line("GB", 3, "00-0000003", "Doubtful", "Hip", ""),        // GB's latest is Wk 3: too old for a Wk 6 lineup
    line("NYJ", 5, "00-0000004", "", "Rest", "Full Participation in Practice")));   // practice only: no designation
  const a = assemble({ reportRows: rows, reportModified: FRESH, mflPayload: mflPayload(6, []), gsisToMfl: MAP, now: NOW });
  t.equal(a.report_feed.current, false, "Wk 6's report isn't out");
  t.equal(a.players["101"], undefined, "dropped from his team's latest report: not designated");
  t.deepEqual(a.players["102"].prior, { week: 5, status: "Questionable", team: "BUF", injury: "Knee" });
  t.equal(a.players["103"], undefined, "more than two weeks back");
  t.equal(a.players["104"], undefined, "practice status only");
  t.deepEqual(a.report_feed.prior_weeks, [5]);
  // Wk 6's report is out for BUF only: BUF players use it (102 isn't on it → nothing); NYJ keeps last week's.
  const b = assemble({ reportRows: parseCsv(csv(line("BUF", 5, "00-0000002", "Questionable", "Knee", ""), line("NYJ", 5, "00-0000004", "Out", "Calf", ""),
                                               line("BUF", 6, "00-0000001", "Doubtful", "Ankle", ""))),
                       reportModified: FRESH, mflPayload: mflPayload(6, []), gsisToMfl: MAP, now: NOW });
  t.equal(b.report_feed.current, true);
  t.deepEqual([b.players["101"].report.status, b.players["101"].prior], ["Doubtful", undefined]);
  t.equal(b.players["102"], undefined, "his team reported this week without him");
  t.deepEqual(b.players["104"].prior, { week: 5, status: "Out", team: "NYJ", injury: "Calf" }, "NYJ hasn't reported this week yet");
  // No id map or no MFL week: no prior either (fail closed).
  const c = assemble({ reportRows: rows, reportModified: FRESH, mflPayload: mflPayload(6, []), gsisToMfl: {}, now: NOW });
  t.equal(Object.keys(c.players).length, 0);
});

test("the file already holds next week's early reports while MFL is still on this week: this week's rows are used (QA 2026-10-11)", () => {
  const rows = parseCsv(csv(line("BUF", 5, "00-0000001", "Out", "Ankle", ""), line("NYJ", 6, "00-0000002", "Questionable", "Knee", "")));
  const a = assemble({ reportRows: rows, reportModified: FRESH, mflPayload: mflPayload(5, []), gsisToMfl: MAP, now: NOW });
  t.deepEqual([a.report_feed.current, a.report_feed.week, a.players["101"].report.status, a.players["102"]], [true, 5, "Out", undefined],
    "Wk 5 rows, not the newer Wk 6 ones");
  t.deepEqual(a.report_feed.teams, ["BUF"], "teams reported are Wk 5's");
  const onlyNext = assemble({ reportRows: parseCsv(csv(line("NYJ", 6, "00-0000002", "Questionable", "Knee", ""))), reportModified: FRESH,
                              mflPayload: mflPayload(5, []), gsisToMfl: MAP, now: NOW });
  t.deepEqual([onlyNext.report_feed.current, onlyNext.report_feed.week, Object.keys(onlyNext.players).length], [false, 6, 0], "fails closed");
  t.ok(/no Wk 5 rows \(its newest is Wk 6\)/.test(onlyNext.report_feed.reason), onlyNext.report_feed.reason);
  t.doesNotMatch(onlyNext.report_feed.reason, /not out yet/, "never says this week's report isn't out when the file is ahead");
});

test("fail closed: an unreadable or empty id map means nobody can be matched — the report is unavailable, never 'not on the report'", () => {
  const rows = parseCsv(csv(line("BUF", 5, "00-0000001", "Out", "Ankle", "")));
  for (const [what, opt] of [["read failed", { gsisToMfl: {}, mapError: "no such table: player_id_map" }], ["empty map", { gsisToMfl: {} }]]) {
    const a = assemble(Object.assign({ reportRows: rows, reportModified: FRESH, mflPayload: mflPayload(5, [{ id: "102", status: "IR" }]), now: NOW }, opt));
    t.deepEqual([a.report_feed.current, Object.values(a.players).some((p) => p.report)], [false, false], what);
    t.ok(/id map/.test(a.report_feed.reason), a.report_feed.reason);
    t.equal(a.players["102"].roster.chip, "IR", what + ": roster designations are by MFL id and still show");
  }
});

test("MFL's own Q / D / Out never become an OFFICIAL designation: they ride in `mfl` only (it keeps them after they lapse)", () => {
  const a = assemble({ reportRows: parseCsv(csv(line("BUF", 5, "00-0000001", "Out", "Ankle", ""))), reportModified: FRESH,
                       mflPayload: mflPayload(5, [{ id: "104", status: "Questionable", details: "Hamstring", exp_return: "Sep 13, 2026" }]),
                       gsisToMfl: MAP, now: NOW });
  t.deepEqual(Object.keys(a.players["104"]), ["mfl"], "no report, no prior, no roster");
  t.equal(a.players["101"].report.status, "Out", "the official report is unchanged");
  t.equal(a.players["101"].mfl, undefined);
});

test("`mfl` (Keith 2026-10-14): MFL's Q / D / Out with the export's week and time, the description and the expected return", () => {
  const rows = [
    { id: "101", status: "Questionable", details: "Ankle", exp_return: "Oct 18, 2026" },
    { id: "0102", status: "out", details: " Knee - ACL ", exp_return: "Nov 8, 2026" },
    { id: "103", status: "Doubtful", details: "", exp_return: "" },
    { id: "104", status: "IR-R", details: "Knee", exp_return: "Nov 15, 2026" },
    { id: "105", status: "Probable", details: "Rest" },
    { id: "106", status: "Questionable", details: "Hip", exp_return: "Week 7" }];
  const a = assemble({ reportRows: parseCsv(csv(line("BUF", 6, "00-0000001", "", "Ankle", "Limited Participation in Practice"))), reportModified: FRESH,
                       mflPayload: mflPayload(6, rows), gsisToMfl: MAP, now: NOW });
  const at = "2026-10-10T14:01:03.000Z";
  t.deepEqual(a.players["101"].mfl, { status: "Questionable", week: 6, updated_utc: at, details: "Ankle", exp_return: "Oct 18, 2026", return_date: "2026-10-18" });
  t.deepEqual(a.players["101"].report, { status: null, injury: "Ankle", practice: "Limited Participation in Practice", team: "BUF" }, "the official line stays beside it");
  t.deepEqual(a.players["102"].mfl, { status: "Out", week: 6, updated_utc: at, details: "Knee - ACL", exp_return: "Nov 8, 2026", return_date: "2026-11-08" }, "case and a padded id normalized");
  t.deepEqual([a.players["103"].mfl.details, a.players["103"].mfl.exp_return, a.players["103"].mfl.return_date], [null, null, null], "blank stays blank, never invented");
  t.deepEqual([a.players["104"].mfl, a.players["104"].roster.chip], [undefined, "IR-R"], "a roster kind is `roster`, not `mfl`");
  t.equal(a.players["105"], undefined, "only Questionable / Doubtful / Out");
  t.deepEqual([a.players["106"].mfl.exp_return, a.players["106"].mfl.return_date], ["Week 7", null], "an unparsed return stays as MFL wrote it");
  t.deepEqual([a.mfl_feed.ok, a.mfl_feed.week, a.mfl_feed.updated_utc, a.mfl_feed.count], [true, 6, at, 4]);
  const down = assemble({ reportRows: parseCsv(csv(line("BUF", 6, "00-0000001", "Out", "Ankle", ""))), reportModified: FRESH, mflError: "HTTP 500", gsisToMfl: MAP, now: NOW });
  t.deepEqual([down.mfl_feed.ok, down.mfl_feed.reason], [false, "unreadable: HTTP 500"], "MFL down: said so, never 'no designation'");
  t.equal(mflReturnDate("Sept 3, 2026"), "2026-09-03"); t.equal(mflReturnDate("Feb 31x"), null); t.equal(mflReturnDate(null), null);
});

test("the route: /api/player-status joins by the verified id map and says when each feed was updated", async () => {
  const env = makeWorkerEnv();
  const db = env.UPS_MFL_DB.raw;
  db.exec(fs.readFileSync("worker/migrations/0170_player_id_map.sql", "utf8"));
  db.prepare("INSERT INTO player_id_map (mfl_id, gsis_id, status, accepted) VALUES ('101', '00-0000001', 'verified', 1), ('103', '00-0000003', 'id_disagree', 0)").run();
  const real = globalThis.fetch;
  let report = csv(line("BUF", 5, "00-0000001", "Doubtful", "Calf", "Limited Participation in Practice"), line("BUF", 5, "00-0000003", "Out", "Knee", ""));
  globalThis.fetch = async (u) => {
    const s = String(u);
    if (s.includes("nflverse-data/releases/download/injuries/injuries_2026.csv"))
      return report == null ? new Response("boom", { status: 502 }) : new Response(report, { status: 200, headers: { "last-modified": new Date(Date.now() - 3600e3).toUTCString() } });
    if (s.includes("api.myfantasyleague.com/2026/export") && s.includes("TYPE=injuries"))
      return new Response(JSON.stringify(mflPayload(5, [{ id: "101", status: "IR-R", details: "Calf" }, { id: "102", status: "Questionable", details: "Ankle", exp_return: "Oct 11, 2026" }])), { status: 200, headers: { "content-type": "application/json" } });
    return real(u);
  };
  const get = async () => { const r = quiet(); try { return await callWorker(env, "GET", "/api/player-status?season=2026&L=74598"); } finally { r(); } };
  try {
    const a = await get();
    t.equal(a.status, 200, a.text.slice(0, 300));
    t.deepEqual([a.json.report_feed.current, a.json.report_feed.week, a.json.players["101"].report.status, a.json.players["101"].roster.chip],
      [true, 5, "Doubtful", "IR-R"]);
    t.equal(a.json.players["103"], undefined, "an unaccepted map row resolves nobody");
    t.deepEqual(a.json.mapped_mfl_ids, ["101"], "anyone not in this list is 'no verified NFL id', never 'not on the report'");
    t.ok(a.json.report_feed.updated_utc && a.json.roster_feed.updated_utc === "2026-10-10T14:01:03.000Z");
    t.deepEqual([a.json.players["102"].mfl.status, a.json.players["102"].mfl.week, a.json.players["102"].mfl.return_date, a.json.players["102"].report],
      ["Questionable", 5, "2026-10-11", undefined], "MFL's own designation is served (by MFL id, no map needed), apart from the report");
    t.deepEqual([a.json.mfl_feed.ok, a.json.mfl_feed.week, a.json.mfl_feed.count], [true, 5, 1]);
    report = null;
    const b = await get();
    t.deepEqual([b.json.report_feed.ok, b.json.report_feed.current, b.json.players["101"].report], [false, false, undefined],
      "report down: unavailable, the roster designation still shown");
  } finally { globalThis.fetch = real; }
});

await run("player_status");
