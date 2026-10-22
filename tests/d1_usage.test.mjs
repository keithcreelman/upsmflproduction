// scripts/d1_usage.py: the Free-plan budget comes ONLY from the exact account-wide counter for the
// current UTC day; the per-query view is labeled as Cloudflare's sampled estimate (#1354).
//   node tests/d1_usage.test.mjs
//   • recorded 2026-10-22 analytics: the "145 runs × 50,750" leaderboard row is 1 stored sample at 1 in 145,
//     and the exact counter reconciles to 4,526,410 (UTC day 10-21) and 5,169,361 / 4,956,979 (rolling 24 h)
//   • failed, sampled or empty exact counter → usage UNKNOWN, exit 3, no sampled fallback
//   • UTC-day reset, rolling-24-h labeling, several D1 databases, near / over the 5M line
// Offline: every case runs the script with --fixture, so it reads no Cloudflare API and no D1 rows.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { t, test, run } from "./fixtures/mini_test.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = path.join(ROOT, "scripts/d1_usage.py");
const FX = path.join(ROOT, "tests/fixtures/d1_usage");
const MAIN_DB = "8cfe1ddd-749e-476a-9c2c-a359410c6fc1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "d1-usage-"));
const load = (name) => JSON.parse(fs.readFileSync(path.join(FX, name), "utf8"));

let n = 0;
function cli(fx, args = [], env = {}) {
  const file = path.join(tmp, `fx${n++}.json`);
  fs.writeFileSync(file, JSON.stringify(fx));
  const go = (extra) => spawnSync("python3", [SCRIPT, "--fixture", file, ...args, ...extra],
    { encoding: "utf8", env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1", ...env } });
  const j = go(["--json"]), txt = go([]);
  if (j.status !== txt.status) throw new Error(`exit differs: --json ${j.status}, text ${txt.status}`);
  if (j.stderr) throw new Error(j.stderr);
  return { status: j.status, json: JSON.parse(j.stdout), text: txt.stdout };
}

// Synthetic responses in the exact shape Cloudflare returns (see the recorded fixtures).
const grp = (db, read, written = 0, si = 1) => ({
  sum: { rowsRead: read, rowsWritten: written, readQueries: 1, writeQueries: 1 }, avg: { sampleInterval: si }, dimensions: { databaseId: db } });
const exact = ({ day = [grp(MAIN_DB, 1_000)], prev = [grp(MAIN_DB, 3_000_000)], roll = [grp(MAIN_DB, 3_500_000)] } = {}) =>
  ({ data: { viewer: { accounts: [{ utc_day: day, previous_utc_day: prev, rolling_24h: roll }] } } });
const qrow = (query, rowsRead, count, si) => ({
  sum: { queryDurationMs: 1, rowsRead, rowsWritten: 0, rowsReturned: 1 },
  avg: { queryDurationMs: 1, rowsRead: rowsRead / count, rowsWritten: 0, rowsReturned: 1, sampleInterval: si },
  count, dimensions: { query } });
const sampled = (rows) => ({ data: { viewer: { accounts: [{ d1QueriesAdaptiveGroups: rows }] } } });
const fixture = (o = {}) => ({ now: "2026-10-22T12:00:00Z", window: "1d", database_id: MAIN_DB,
  databases: [{ uuid: MAIN_DB, name: "ups-mfl-db" }], exact_response: exact(), sampled_response: sampled([]), ...o });

test("recorded 1-in-145 leaderboard example: one stored sample, flagged; budget from the UTC day, not the 10.46M", () => {
  const { status, json, text } = cli(load("2026-10-22T024131_1d_leaderboard_1_in_145.json"));
  const lb = json.sampled_queries.rows[0];
  t.equal(lb.label, "LEADERBOARD live query (/api/advanced-stats-leaderboard)");
  t.equal(lb.est_rows_read, 7_358_750); t.equal(lb.est_runs, 145); t.equal(lb.avg_rows_read_per_run, 50_750);
  t.equal(lb.sample_interval, 145); t.equal(lb.stored_samples, 1); t.equal(lb.thin, true);
  t.match(text, /!! THIN SAMPLE: LEADERBOARD live query/);
  t.match(text, /shows 7,358,750 rows over 145 runs, but that is 1 recorded query multiplied by 145 \(1 in 145\)/);
  t.match(text, /Do not read it as 145 executions/);
  t.match(text, /Sampling in this window: 1 in 1 to 1 in 145\./);
  // the old tool's alarm was 209% of the limit; the billing day so far was 21.4%
  t.equal(status, 0); t.equal(json.budget.status, "ok");
  t.equal(json.budget.reads.used, json.exact.utc_day.account.rows_read);
  t.equal(json.budget.reads.used, 1_071_653); t.equal(json.budget.reads.pct_of_limit, 21.4);
  t.doesNotMatch(text, /OVER/);
  // reconciliation with the 10-22 investigation (#1354 issuecomment-6338937178)
  t.equal(json.exact.previous_utc_day.date, "2026-10-21"); t.equal(json.exact.previous_utc_day.account.rows_read, 4_526_410);
  t.equal(json.exact.rolling_24h.account.rows_read, 5_169_361);
  t.equal(json.exact.rolling_24h.start_utc, "2026-10-21T02:41:00Z"); t.equal(json.exact.rolling_24h.end_utc, "2026-10-22T02:41:00Z");
});

test("recorded 10:26 window: rolling 24 h 4,956,979 (the 10:25 minute grew 3 → 7 after the 10:26 read of 4,956,975)", () => {
  const { json } = cli(load("2026-10-22T1026_1d.json"));
  t.equal(json.exact.rolling_24h.account.rows_read, 4_956_979);
  t.equal(json.exact.utc_day.account.rows_read, 2_050_461);
  t.equal(json.exact.previous_utc_day.account.rows_read, 4_526_410);
  t.equal(json.budget.reads.used, 2_050_461);
});

test("UTC-day reset: at 00:00:30 the budget restarts at 0; the full prior day and the rolling span are reported separately", () => {
  const { status, json, text } = cli(load("2026-10-22T000030_utc_reset_1h.json"));
  t.equal(status, 0);
  t.equal(json.exact.utc_day.date, "2026-10-22"); t.equal(json.exact.utc_day.start_utc, "2026-10-22T00:00:00Z");
  t.equal(json.exact.utc_day.resets_at_utc, "2026-10-23T00:00:00Z");
  t.equal(json.budget.reads.used, 0); t.equal(json.budget.reads.pct_of_limit, 0);
  t.equal(json.exact.previous_utc_day.account.rows_read, 4_526_410);   // UTC day 10-21, complete
  t.equal(json.exact.rolling_24h.account.rows_read, 4_526_410);        // here the rolling span IS that day
  t.match(text, /UTC billing day 2026-10-22 · resets 00:00 UTC \(24h 00m left\)/);
  t.match(text, /previous UTC day 2026-10-21 \(complete\): rows read 4,526,410 \(90\.5%\)/);
  // the boundary is UTC, whatever the local clock says
  const la = cli(load("2026-10-22T000030_utc_reset_1h.json"), [], { TZ: "America/Los_Angeles" });
  t.deepEqual(la.json, json);
  const before = cli(fixture({ now: "2026-10-21T23:59:59Z" })), after = cli(fixture({ now: "2026-10-22T00:00:00Z" }));
  t.equal(before.json.exact.utc_day.date, "2026-10-21"); t.equal(before.json.exact.utc_day.resets_at_utc, "2026-10-22T00:00:00Z");
  t.equal(after.json.exact.utc_day.date, "2026-10-22"); t.equal(after.json.exact.utc_day.resets_at_utc, "2026-10-23T00:00:00Z");
});

test("rolling 24 h is labeled diagnostic only and never turned into a % of the daily limit", () => {
  const { json, text } = cli(load("2026-10-22T024131_1d_leaderboard_1_in_145.json"));
  t.equal(json.exact.rolling_24h.diagnostic_only, true);
  t.ok(!JSON.stringify(json.exact.rolling_24h).includes("pct"));
  const line = text.split("\n").findIndex((l) => l.includes("ROLLING 24 H"));
  t.ok(line > 0); t.match(text.split("\n")[line], /DIAGNOSTIC ONLY/);
  t.match(text.split("\n")[line + 1], /never a % of the daily limit/);
  t.match(text.split("\n")[line + 2], /^ {4}rows read 5,169,361 · rows written 34,635$/);   // no percentage on the number
  // the rolling span is over 5M here, the billing day is not: the budget follows the billing day
  t.ok(json.exact.rolling_24h.account.rows_read > 5_000_000); t.equal(json.budget.status, "ok");
});

test("unsampled data (1 in 1): counts, not estimates, so nothing is flagged thin", () => {
  const { json, text } = cli(fixture({ sampled_response: sampled([
    qrow("SELECT * FROM nfl_player_weekly WHERE season = ? AND gsis_id = ?", 52_556, 1, 1),
    qrow("SELECT bot FROM ups_bot_heartbeat", 33, 3, 1)]) }));
  t.deepEqual(json.sampled_queries.rows.map((r) => [r.stored_samples, r.sample_interval, r.thin]), [[1, 1, false], [3, 1, false]]);
  t.equal(json.sampled_queries.thin_rows, 0);
  t.doesNotMatch(text, /THIN/); t.match(text, /Sampling in this window: 1 in 1 to 1 in 1\./);
  t.match(text, / 1 in 1  nfl_player_weekly/);
});

test("thin sampling is flagged whenever the interval is above 1 and fewer than 5 queries were stored", () => {
  const { json } = cli(fixture({ sampled_response: sampled([
    qrow("SELECT 1 FROM a", 1_000, 4, 2),         // 2 stored at 1 in 2  → thin
    qrow("SELECT 1 FROM b", 1_000, 40, 10),       // 4 stored at 1 in 10 → thin
    qrow("SELECT 1 FROM c", 1_000, 50, 10)]) }));  // 5 stored            → not thin
  t.deepEqual(json.sampled_queries.rows.map((r) => [r.label, r.stored_samples, r.thin]), [["a", 2, true], ["b", 4, true], ["c", 5, false]]);
});

for (const [name, resp] of [
  ["the analytics API failed", { error: "HTTP 429 from the analytics API" }],
  ["GraphQL returned an error", { errors: [{ message: "Rate limiter budget depleted, try again after 5 minutes" }], data: null }],
  ["the counter came back sampled", exact({ day: [grp(MAIN_DB, 900_000, 0, 3)] })],
  ["the counter returned no data for 24 h", exact({ day: [], prev: [], roll: [] })],
  ["the response is missing a span", { data: { viewer: { accounts: [{ utc_day: [grp(MAIN_DB, 1)] }] } } }],
]) {
  test(`exact counter unusable (${name}) → usage UNKNOWN, exit 3, fail closed, no sampled fallback`, () => {
    const { status, json, text } = cli(fixture({ exact_response: resp,
      sampled_response: sampled([qrow("WITH current_team AS (SELECT 1)", 7_358_750, 145, 145)]) }));
    t.equal(status, 3);
    t.equal(json.exact.status, "unknown"); t.ok(json.exact.error);
    t.equal(json.budget.status, "unknown"); t.equal(json.budget.ok, false);
    t.equal(json.budget.reads, null); t.equal(json.budget.writes, null);
    t.match(text, /USAGE UNKNOWN/); t.match(text, /Fail closed/); t.match(text, /NOT a substitute/);
    t.doesNotMatch(text, /of 5,000,000/); t.doesNotMatch(text, /ROLLING 24 H/);
    t.equal(json.sampled_queries.rows[0].est_rows_read, 7_358_750);   // diagnosis still shown, labeled sampled
    t.match(text, /SAMPLED ESTIMATES/);
  });
}

test("several D1 databases: the budget is account-wide; each database is listed as database-specific", () => {
  const B = "84ba2435-6a7a-49df-8df6-137b73ad11ff", C = "00000000-0000-0000-0000-00000000000c";
  const { status, json, text } = cli(fixture({
    databases: [{ uuid: MAIN_DB, name: "ups-mfl-db" }, { uuid: B, name: "ups-stats-store-preview" }],
    exact_response: exact({ day: [grp(MAIN_DB, 3_000_000, 40_000), grp(B, 1_200_000, 30_000), grp(C, 600_000, 35_000)],
                            roll: [grp(MAIN_DB, 4_000_000), grp(B, 1_300_000), grp(C, 700_000)] }) }));
  t.equal(json.exact.utc_day.account.rows_read, 4_800_000); t.equal(json.exact.utc_day.account.rows_written, 105_000);
  t.deepEqual(json.exact.utc_day.databases.map((d) => [d.name, d.rows_read]),
    [["ups-mfl-db", 3_000_000], ["ups-stats-store-preview", 1_200_000], [null, 600_000]]);
  // no single database is near the line; the account is near for reads and over for writes
  t.equal(json.budget.reads.used, 4_800_000); t.equal(json.budget.reads.level, "near");
  t.equal(json.budget.writes.level, "over"); t.equal(json.budget.status, "over"); t.equal(status, 4);
  t.match(text, /ACCOUNT-WIDE \(every D1 database\)/); t.match(text, /BY DATABASE \(database-specific, exact\)/);
  t.match(text, /ups-stats-store-preview/); t.match(text, new RegExp(C));   // unnamed database → its id
  t.equal(json.exact.rolling_24h.account.rows_read, 6_000_000);
});

test("near and over the 5M line, on exact totals only", () => {
  const at = (reads, writes = 0) => cli(fixture({ exact_response: exact({ day: [grp(MAIN_DB, reads, writes)] }) }));
  const cases = [[4_499_999, "ok", 0], [4_500_000, "near", 0], [4_999_999, "near", 0], [5_000_000, "over", 4], [5_169_361, "over", 4]];
  for (const [reads, level, code] of cases) {
    const r = at(reads);
    t.equal(r.json.budget.reads.level, level); t.equal(r.json.budget.status, level); t.equal(r.status, code);
    t.equal(r.json.budget.reads.remaining, Math.max(0, 5_000_000 - reads));
    t.equal(r.json.budget.ok, level !== "over");
  }
  t.match(at(5_000_000).text, /rows read {7}5,000,000 of 5,000,000  100\.0%  OVER/);
  t.match(at(4_600_000).text, /92\.0%  NEAR/);
  const w = at(10, 100_000);
  t.equal(w.json.budget.reads.level, "ok"); t.equal(w.json.budget.writes.level, "over"); t.equal(w.status, 4);
});

test("sampled estimates are never added together or used as usage", () => {
  const { json, text } = cli(fixture({ sampled_response: sampled([
    qrow("WITH current_team AS (SELECT 1)", 7_358_750, 145, 145), qrow("SELECT 1 FROM b", 3_000_000, 100, 10)]) }));
  t.equal(json.sampled_queries.estimates_are_sampled, true); t.equal(json.sampled_queries.summable, false);
  t.ok(!Object.keys(json.sampled_queries).some((k) => /total|^sum$|rows_read/i.test(k)));   // no grand total anywhere
  t.equal(json.budget.reads.used, 1_000);   // the exact counter, untouched by 10.36M of estimates
  t.doesNotMatch(text, /10,358,750/);
  t.match(text, /They are not\n {2}added up, are not account usage/);
});

test("labels: the truncated leaderboard CTE and /api/sos-adjusted-points are named by route", () => {
  const fx = load("2026-10-22T024131_1d_leaderboard_1_in_145.json");
  const labels = cli(fx).json.sampled_queries.rows.map((r) => r.label);
  t.ok(labels.includes("LEADERBOARD live query (/api/advanced-stats-leaderboard)"));
  t.ok(labels.includes("/api/sos-adjusted-points"));
  t.ok(!labels.includes("src_players"));
});

test("arguments: unknown window → exit 2; a fixture's own window is used", () => {
  const bad = spawnSync("python3", [SCRIPT, "2h"], { encoding: "utf8" });
  t.equal(bad.status, 2); t.match(bad.stderr, /window must be one of 1h, 6h, 12h, 1d, 7d/);
  t.equal(cli(fixture({ window: "6h" })).json.sampled_queries.window, "6h");
});

await run("d1_usage");
