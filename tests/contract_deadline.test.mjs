// ONE September contract-deadline resolver for every consumer (Keith 2026-10-08): the 2026 fallback agrees with the
// approved time (23:59 ET, open through 23:59:59), tested with the calendar deliberately unset, and no time is invented for
// a future season.
//   node tests/contract_deadline.test.mjs
import fs from "node:fs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import { resolveContractDeadline, deadlineState, determinateDeadlineUnix, etWallToUnix, PINNED_CONTRACT_DEADLINE_ET, loadContractDeadline } from "../worker/src/contract_deadline.js";
import { makeWorkerEnv, quiet } from "./fixtures/worker_harness.mjs";

const restore = quiet();
const U = (iso) => Math.floor(Date.parse(iso) / 1000);
const APPROVED = U("2026-09-06T23:59:59-04:00");                 // 2026-09-07T03:59:59Z
const CAL = (season, wall) => ({ season, faa: { contract_deadline_at: wall }, read_error: "" });

test("2026: the commissioner's calendar and the pinned fallback (calendar deliberately UNSET) give the SAME instant — 23:59 ET, open through 23:59:59", () => {
  t.deepEqual(PINNED_CONTRACT_DEADLINE_ET, { "2026": "2026-09-06T23:59" });
  const cal = resolveContractDeadline({ season: "2026", calendar: CAL("2026", "2026-09-06T23:59") });
  const unset = resolveContractDeadline({ season: "2026", calendar: { season: null, faa: { contract_deadline_at: "" }, read_error: "" } });
  const noRead = resolveContractDeadline({ season: "2026", calendar: null });
  t.equal(cal.source, "calendar"); t.equal(unset.source, "pinned"); t.equal(noRead.source, "pinned");
  for (const r of [cal, unset, noRead]) { t.equal(r.deadline_unix, APPROVED); t.equal(r.exact, true); }
  t.equal(new Date(APPROVED * 1000).toISOString(), "2026-09-07T03:59:59.000Z");
  t.equal(deadlineState(unset, APPROVED), "before", "the deadline second itself is still open");
  t.equal(deadlineState(unset, APPROVED + 1), "after");
  t.equal(deadlineState(unset, U("2026-09-06T21:00:01-04:00")), "before", "the old 21:00 fallback no longer closes anything early");
});

test("a commissioner-moved deadline is honoured exactly; a calendar kept for ANOTHER season is ignored", () => {
  const moved = resolveContractDeadline({ season: "2026", calendar: CAL("2026", "2026-09-05T18:00") });
  t.equal(moved.deadline_unix, U("2026-09-05T18:00:59-04:00"));
  const other = resolveContractDeadline({ season: "2027", calendar: CAL("2026", "2026-09-06T23:59"), eventDay: null });
  t.equal(other.source, "none", "the 2026 calendar says nothing about 2027");
});

test("NO INVENTED TIME for a future season: a date-only record answers at DAY precision (on the day: unknown); nothing at all → unknown", () => {
  const d27 = resolveContractDeadline({ season: "2027", calendar: CAL("2026", "2026-09-06T23:59"), eventDay: "2027-09-05" });
  t.equal(d27.source, "league_events_day"); t.equal(d27.exact, false); t.equal(d27.deadline_unix, null, "no time is made up");
  t.equal(deadlineState(d27, U("2027-09-04T23:59:59-04:00")), "before");
  t.equal(deadlineState(d27, U("2027-09-05T00:00:00-04:00")), "unknown"); t.equal(deadlineState(d27, U("2027-09-05T23:59:59-04:00")), "unknown");
  t.equal(deadlineState(d27, U("2027-09-06T00:00:00-04:00")), "after");
  t.equal(determinateDeadlineUnix(d27, U("2027-09-05T12:00:00-04:00")), null, "can't be decided on the day");
  const none = resolveContractDeadline({ season: "2028", calendar: null, eventDay: null });
  t.equal(none.source, "none"); t.equal(deadlineState(none, U("2028-01-01T00:00:00Z")), "unknown");
});

test("FAIL CLOSED: an unreadable calendar, an unreadable league_events row, or a malformed value is an error (unknown) — never 'not configured'", () => {
  t.equal(resolveContractDeadline({ season: "2026", calendar: { read_error: "D1 CPU limit" } }).source, "error");
  t.equal(resolveContractDeadline({ season: "2027", calendar: null, eventError: "D1 down" }).source, "error");
  t.equal(resolveContractDeadline({ season: "2026", calendar: CAL("2026", "Sept 6") }).source, "error");
  t.equal(deadlineState(resolveContractDeadline({ season: "2026", calendar: { read_error: "x" } }), APPROVED - 1), "unknown");
});

test("ET wall clock is DST-aware (no fixed -04:00)", () => {
  t.equal(etWallToUnix("2026-09-06T23:59"), U("2026-09-07T03:59:00Z"));
  t.equal(etWallToUnix("2026-12-31T20:15"), U("2027-01-01T01:15:00Z"), "EST in December");
  t.equal(etWallToUnix("bad"), null);
});

test("the loader (real worker D1): calendar unset → pinned 2026; reads only — no write statement", async () => {
  const env = makeWorkerEnv({});
  const writes = [];
  const prep = env.UPS_MFL_DB.prepare.bind(env.UPS_MFL_DB);
  env.UPS_MFL_DB.prepare = (sql) => { if (!/^\s*SELECT/i.test(sql)) writes.push(sql); return prep(sql); };
  const r = await loadContractDeadline(env, "2026");
  t.equal(r.source, "pinned"); t.equal(r.deadline_unix, APPROVED);
  t.deepEqual(writes, [], "no CREATE / INSERT / UPDATE");
  env.UPS_MFL_DB.raw.exec("CREATE TABLE IF NOT EXISTS ups_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  env.UPS_MFL_DB.raw.prepare("INSERT OR REPLACE INTO ups_settings (key, value, updated_at) VALUES ('auction_calendar', ?, 'x')").run(JSON.stringify({ season: "2026", faa: { contract_deadline_at: "2026-09-06T23:59" } }));
  const c = await loadContractDeadline(env, "2026");
  t.equal(c.source, "calendar"); t.equal(c.deadline_unix, APPROVED);
});

test("EVERY consumer uses the one resolver — no other contract-deadline instant left in the worker", () => {
  const dir = new URL("../worker/src/", import.meta.url);
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js"));
  const offenders = [];
  for (const f of files) {
    if (f === "contract_deadline.js" || f === "auction_calendar.js") continue;   // the resolver; the calendar's own projection into league_events
    const src = fs.readFileSync(new URL(f, dir), "utf8");
    if (/event = 'ups_contract_deadline'/.test(src)) offenders.push(`${f}: reads the ups_contract_deadline row itself`);
    if (/contractDeadlineUnixFromIso\(/.test(src) && f !== "league_events_ladder.js") offenders.push(`${f}: parses the deadline day itself`);
  }
  t.deepEqual(offenders, []);
  const idx = fs.readFileSync(new URL("index.js", dir), "utf8");
  t.match(idx, /const getContractDeadlineUtc = \(season\) => \{\s*const r = resolveContractDeadline\(\{ season, calendar: null \}\);/);
  t.match(idx, /const r = await loadContractDeadline\(env, season\);/, "resolveContractDeadlineUtc wraps the loader");
  t.doesNotMatch(idx, /hasContractDeadlinePassed/, "the dead 21:00 helper is gone");
  const reminder = idx.slice(idx.indexOf("contract_deadline: {\n            title: \"Contract Deadline\""), idx.indexOf("contract_deadline: {\n            title: \"Contract Deadline\"") + 200);
  t.match(reminder, /deadline_time_et: "23:59"/, "the reminder calendar says 11:59 PM too");
  t.match(fs.readFileSync(new URL("restructure_cap.js", dir), "utf8"), /loadContractDeadline\(env, season\)/);
});

await run("contract_deadline");
restore();
