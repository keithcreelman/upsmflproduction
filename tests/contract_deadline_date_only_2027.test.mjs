// 2027 has only a DATE-ONLY contract deadline (league_events ups_contract_deadline 2027-09-05, source
// "commish:2027-seed-sunday-before-week1"; the commish calendar still holds 2026). Keith 2026-10-09: "do not infer a time
// from the date-only entry. Keep the boundary fail-closed." The resolver already answers at DAY precision (before the day /
// on the day: unknown → refused / after the day). Two outputs still STATED a time nobody set — 23:59:59 ET:
//   - the contract ladder's MYAC rung end (end_unix), which the Front Office and mobile turn into a date / countdown;
//   - the veteran-extension refusal after the day ("the deadline passed (2027-09-06T03:59:59.000Z)", deadline_utc).
// Now both carry the DAY with no time; an exact deadline (once the commish sets it) is unchanged.
//   node tests/contract_deadline_date_only_2027.test.mjs
import { t, test, run } from "./fixtures/mini_test.mjs";
import { makeWorkerEnv, makeMfl, callWorker, quiet } from "./fixtures/worker_harness.mjs";
import { resolveContractDeadline, withDateOnlyLadderEnd } from "../worker/src/contract_deadline.js";

const restoreConsole = quiet();
const RealDate = Date;
let NOW = RealDate.parse("2027-08-20T12:00:00-04:00");
globalThis.Date = class extends RealDate {
  constructor(...a) { super(...(a.length ? a : [NOW])); }
  static now() { return NOW; }
};
const at = (iso) => (NOW = RealDate.parse(iso));
const U = (iso) => Math.floor(RealDate.parse(iso) / 1000);

function fresh({ calendar } = {}) {
  const env = makeWorkerEnv({ YEAR: "2027", LEAGUE_ID: "74598" });
  const db = env.UPS_MFL_DB.raw;
  db.exec("CREATE TABLE IF NOT EXISTS league_events (event TEXT, date TEXT, nfl_season TEXT, description TEXT, source TEXT, created_at_utc TEXT)");
  db.prepare("INSERT INTO league_events (event, date, nfl_season, description, source, created_at_utc) VALUES ('ups_contract_deadline', '2027-09-05', '2027', 'Final-year veteran extensions + MYAC close', 'commish:2027-seed-sunday-before-week1', '2026-08-23 12:41:13')").run();
  db.exec("CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  db.prepare("INSERT OR REPLACE INTO ups_settings (key, value, updated_at) VALUES ('auction_calendar', ?, '2026-08-06T11:51:58Z')").run(JSON.stringify(calendar || {
    season: "2026", faa: { contract_deadline_at: "2026-09-06T23:59", faa_open_at: "2026-07-25T12:00", trade_deadline_at: "2026-11-25T20:00" },
  }));
  const mfl = makeMfl();
  mfl.st.rosters = { "0003": [{ id: "15000", salary: 30000, status: "ROSTER", contractYear: 1, contractStatus: "Vet-FAA", contractInfo: "CL 2| TCV 60K| AAV 30K| Y1-30K, Y2-30K" }] };
  mfl.st.salaries = [{ id: "15000", salary: "30000", contractYear: "1", contractStatus: "Vet-FAA", contractInfo: "CL 2| TCV 60K| AAV 30K| Y1-30K, Y2-30K" }];
  mfl.install();
  return { env, mfl };
}
const extend = (env) => callWorker(env, "POST", "/commish-contract-update?L=74598&YEAR=2027&MFL_USER_ID=tok-O", { body: {
  type: "MANUAL_CONTRACT_UPDATE", submission_kind: "extension", L: "74598", YEAR: "2027",
  player_id: "15000", player_name: "Test", franchise_id: "0003", franchise_name: "Gride", position: "WR",
  prior_contract_status: "Vet-FAA", prior_contract_year: 1,
  salary: 30000, contract_year: 2, contract_status: "Vet-Ext1", contract_info: "CL 3| TCV 90K| AAV 30K",
} });

test("withDateOnlyLadderEnd: a date-only deadline's MYAC rung ends on a DAY (end_unix null); exact deadlines and other rungs untouched", () => {
  const d27 = resolveContractDeadline({ season: "2027", calendar: null, eventDay: "2027-09-05" });
  t.deepEqual(withDateOnlyLadderEnd({ stage: "myac", end_unix: U("2027-09-05T23:59:59-04:00") }, d27),
    { stage: "myac", end_unix: null, end_day: "2027-09-05", end_time_known: false });
  const exact = resolveContractDeadline({ season: "2027", calendar: { season: "2027", faa: { contract_deadline_at: "2027-09-05T21:00" }, read_error: "" } });
  t.deepEqual(withDateOnlyLadderEnd({ stage: "myac", end_unix: exact.deadline_unix }, exact), { stage: "myac", end_unix: exact.deadline_unix });
  t.deepEqual(withDateOnlyLadderEnd({ stage: "mym", end_unix: 123 }, d27), { stage: "mym", end_unix: 123 }, "a kickoff rung has a real time");
});

test("/api/league-events (2027, Aug 20): the MYAC rung ends on 2027-09-05 with NO time — not an invented 11:59:59 PM", async () => {
  const { env, mfl } = fresh();
  at("2027-08-20T12:00:00-04:00");
  const r = await callWorker(env, "GET", "/api/league-events?L=74598&season=2027");
  t.equal(r.status, 200, r.text.slice(0, 200));
  t.deepEqual(r.json.contract_ladder, { stage: "myac", end_unix: null, end_day: "2027-09-05", end_time_known: false });
  mfl.restore();
});

test("…once the commish sets the exact 2027 time (Season 2027, contract_deadline_at 2027-09-05T21:00), the rung ends at that minute", async () => {
  const { env, mfl } = fresh({ calendar: { season: "2027", faa: { contract_deadline_at: "2027-09-05T21:00" } } });
  at("2027-08-20T12:00:00-04:00");
  const r = await callWorker(env, "GET", "/api/league-events?L=74598&season=2027");
  t.equal(r.json.contract_ladder.stage, "myac");
  t.equal(r.json.contract_ladder.end_unix, U("2027-09-05T21:00:59-04:00"));
  t.ok(!("end_day" in r.json.contract_ladder));
  mfl.restore();
});

test("a veteran extension ON 2027-09-05 is refused (fail closed) and the owner is told the TIME is missing — not 'retry shortly'", async () => {
  const { env, mfl } = fresh();
  at("2027-09-05T12:00:00-04:00");
  const r = await extend(env);
  t.equal(r.status, 503, r.text.slice(0, 300));
  t.equal(r.json.details.code, "CONTRACT_DEADLINE_UNRESOLVED");
  t.match(r.json.details.reason, /^Only the date of the 2027 contract deadline \(2027-09-05\) is on the league calendar, not its time/);
  t.match(r.json.details.reason, /Commish Settings → Update League Calendar/);
  t.equal(mfl.writes("salaries").length, 0, "nothing written");
  mfl.restore();
});

test("…and AFTER the day it is refused as passed, stating the DAY — no deadline_utc invented from the date", async () => {
  const { env, mfl } = fresh();
  at("2027-09-06T09:00:00-04:00");
  const r = await extend(env);
  t.equal(r.status, 410, r.text.slice(0, 300));
  t.equal(r.json.details.code, "EXTENSION_DEADLINE_PASSED");
  t.match(r.json.details.reason, /the deadline passed \(2027-09-05; its time isn't on the league calendar\)/);
  t.ok(!/T03:59:59/.test(r.text), "no 23:59:59 ET instant anywhere in the response");
  t.equal(r.json.details.deadline_utc, null);
  t.equal(r.json.details.deadline_day, "2027-09-05");
  t.equal(r.json.details.deadline_time_known, false);
  t.equal(mfl.writes("salaries").length, 0);
  mfl.restore();
});

await run("contract_deadline_date_only_2027");
globalThis.Date = RealDate;
restoreConsole();
