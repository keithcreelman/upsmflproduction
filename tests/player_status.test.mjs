// Injury status for the mobile Players list and sheet (2026-10-10).
//   node tests/player_status.test.mjs
//
// The report designation (Out / Doubtful / Questionable) comes from this
// week's official NFL injury report; the roster designation (IR, IR-R, PUP …)
// from MFL's injuries export. A feed that can't be read, a report for another
// week, or one over 36 h old is UNAVAILABLE — never "no designation".
// Pure assembly first, then the real route with the network stubbed.
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, callWorker, quiet } from "./fixtures/fcfs_worker_harness.mjs";
import { assemble, parseCsv, STALE_HOURS } from "../worker/src/player_status.js";

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
  t.deepEqual([lastWeek.report_feed.current, lastWeek.report_feed.week, lastWeek.players["101"]], [false, 4, undefined]);
  t.ok(/Wk 5's is not out yet/.test(lastWeek.report_feed.reason), lastWeek.report_feed.reason);
  const old = assemble({ reportRows: rows, reportModified: new Date(NOW - (STALE_HOURS + 1) * 3600e3).toUTCString(),
                         mflPayload: mflPayload(5, []), gsisToMfl: MAP, now: NOW });
  t.deepEqual([old.report_feed.current, old.players["101"]], [false, undefined]);
  t.ok(/not updated/.test(old.report_feed.reason));
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

test("MFL's own Q / D / Out never become a designation (it keeps them long after they lapse)", () => {
  const a = assemble({ reportRows: parseCsv(csv(line("BUF", 5, "00-0000001", "Out", "Ankle", ""))), reportModified: FRESH,
                       mflPayload: mflPayload(5, [{ id: "104", status: "Questionable", details: "Hamstring", exp_return: "Sep 13, 2026" }]),
                       gsisToMfl: MAP, now: NOW });
  t.equal(a.players["104"], undefined);
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
      return new Response(JSON.stringify(mflPayload(5, [{ id: "101", status: "IR-R", details: "Calf" }])), { status: 200, headers: { "content-type": "application/json" } });
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
    report = null;
    const b = await get();
    t.deepEqual([b.json.report_feed.ok, b.json.report_feed.current, b.json.players["101"].report], [false, false, undefined],
      "report down: unavailable, the roster designation still shown");
  } finally { globalThis.fetch = real; }
});

await run("player_status");
