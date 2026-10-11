// §G3 weekly booking: the right week's lineup, judged at the FINAL kickoff,
// one offense per franchise-week, and fail-closed everywhere.
//   node tests/lineup_booking_week.test.mjs
//
// Found 2026-10-11: ups_lineup_violations held a row for all 12 franchises in
// every week 1-4 of 2026 (48 rows), 44 of them "Only 0 of 18 starting slots
// filled". MFL's own weeklyResults shows 18 starters for every team every week.
// The booking pass ran ~1am ET Tuesday and read playerRosterStatus with no W=,
// which MFL answers for its CURRENT lineup week — already the next one, mostly
// unset. Keith's rulings the same evening (pinned here):
//   - judge the week at its FINAL scheduled kickoff (normally Monday night),
//     on the first worker run at or after it — the */5 fast path, with the
//     hourly run as the safety net;
//   - read the completed week's lineup explicitly by week, never MFL's implicit
//     current week;
//   - several bad starters are several REASONS for ONE weekly violation;
//   - retries and overlapping runs never create a second offense.
//
// Real SQLite (node:sqlite) with the real migrations 0093 + 0129. The voided
// 2026 weeks 1-4 come from the actual pre-image and the actual void file in
// docs/incidents/2026-10-11_lineup_false_violations/.
import fs from "node:fs";
import { makeD1, applyMigrations } from "./fixtures/d1_sqlite.mjs";
import { t, test, run } from "./fixtures/mini_test.mjs";
import * as wiring from "../worker/src/lineup_wiring.js";

const SEASON = 2026, L = "74598", WEEK = 5;
const et = (iso) => Math.floor(Date.parse(iso) / 1000);
// Week 5 of 2026 as MFL publishes it.
const SUN1 = 1791738000;            // Sun Oct 11 1:00pm ET  (MIN @ NOS)
const SUN425 = 1791750300;          // Sun Oct 11 4:25pm ET  (DET @ ARI)
const MNF = 1791850500;             // Mon Oct 12 8:15pm ET  (BUF @ LAR) — the final kickoff
const POLL_FROM = 1791507952;       // first Week 5 injury poll, Thu Oct 8 9:05pm ET

const FIDS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, "0"));
const pid = (f, i) => `9${f}${String(i).padStart(2, "0")}`;
const STARTERS = Object.fromEntries(FIDS.map((f) => [f, Array.from({ length: 18 }, (_, i) => pid(f, i))]));
// CBP (0002) started Kaden Elliss (NO) and Andrew Wingard (ARI) in Week 5.
const ELLISS = "14303", WINGARD = "14328";
STARTERS["0002"] = [ELLISS, WINGARD, ...STARTERS["0002"].slice(2)];

const games = (...gs) => gs.map(([home, away, kickoff]) => ({ kickoff: String(kickoff), team: [{ id: home, isHome: "1" }, { id: away, isHome: "0" }] }));
const WEEK5 = games(["NOS", "MIN", SUN1], ["ARI", "DET", SUN425], ["LAR", "BUF", MNF]);

function mfl({ schedule = WEEK5, results = STARTERS, resultsWeek = WEEK, resultsOk = true, seen } = {}) {
  const sched = typeof schedule === "function" ? schedule : () => schedule;
  return async (url) => {
    const u = String(url);
    seen && seen.push(u);
    const json = (body) => ({ ok: true, json: async () => body });
    if (u.includes("TYPE=nflSchedule")) return json({ nflSchedule: { matchup: sched() } });
    if (u.includes("TYPE=nflByeWeeks")) return json({ nflByeWeeks: { team: [] } });
    if (u.includes("TYPE=players")) {
      const player = FIDS.flatMap((f) => STARTERS[f].map((id) => ({ id, name: `P ${id}`, team: "MIN", position: "LB" })));
      for (const p of player) {
        if (p.id === ELLISS) Object.assign(p, { name: "Elliss, Kaden", team: "NOS" });
        if (p.id === WINGARD) Object.assign(p, { name: "Wingard, Andrew", team: "ARI", position: "S" });
      }
      return json({ players: { player } });
    }
    if (u.includes("TYPE=rosters")) {
      return json({ rosters: { franchise: FIDS.map((f) => ({ id: f, player: STARTERS[f].map((id) => ({ id, status: "ROSTER" })) })) } });
    }
    if (u.includes("TYPE=playerRosterStatus")) {
      // What MFL's implicit CURRENT week looks like once the week has rolled: nobody set.
      const ids = new URL(u).searchParams.get("P").split(",");
      return json({ playerRosterStatuses: { playerStatus: ids.map((id) => ({ id, roster_franchise: { franchise_id: "0001", status: "NS" } })) } });
    }
    if (u.includes("TYPE=weeklyResults")) {
      if (!resultsOk) return { ok: false, json: async () => null };
      const franchise = Object.entries(results).map(([id, s]) => ({ id, starters: s.length ? s.join(",") + "," : "" }));
      // Real shape: several matchups per week, a franchise can appear in more than one.
      return json({ weeklyResults: { week: String(resultsWeek), matchup: [{ franchise: franchise.slice(0, 6) }, { franchise: franchise.slice(6) }, { franchise: franchise.slice(0, 2) }] } });
    }
    return { ok: false, json: async () => null };
  };
}

// The D1 injury ledger as production recorded it for Week 5.
function env({ ledger = [] } = {}) {
  const d = makeD1({});
  applyMigrations(d, ["0093_ups_bot_heartbeat.sql", "0129_lineup_compliance.sql"]);
  d.raw.prepare("INSERT INTO ups_injury_polls (season, week, polled_unix, rows_seen) VALUES (?, ?, ?, 400)").run(SEASON, WEEK, POLL_FROM);
  for (const [p, status, first] of ledger) {
    d.raw.prepare("INSERT INTO ups_injury_status (season, week, player_id, status, first_seen_unix, last_seen_unix) VALUES (?, ?, ?, ?, ?, ?)")
      .run(SEASON, WEEK, p, status, first, MNF);
  }
  return { UPS_MFL_DB: d };
}
const CBP_LEDGER = [
  [ELLISS, "QUESTIONABLE", 1791507952], [ELLISS, "OUT", 1791579952],    // OUT first seen Fri Oct 9 5:05pm ET
  [WINGARD, "QUESTIONABLE", 1791507952], [WINGARD, "OUT", 1791569151],  // OUT first seen Fri Oct 9 2:05pm ET
];
const rows = (e, week = WEEK) => e.UPS_MFL_DB.raw.prepare("SELECT * FROM ups_lineup_violations WHERE season=? AND week=? ORDER BY fid").all(SEASON, week);
const book = (e, nowUnix, opts) => { globalThis.fetch = mfl(opts); return wiring.runLineupBooking(e, { season: SEASON, leagueId: L, week: WEEK, nowUnix }); };
const fast = (e, nowUnix, opts) => { globalThis.fetch = mfl(opts); return wiring.runLineupBookingFastPath(e, { season: SEASON, leagueId: L, week: WEEK, nowUnix }); };
const INCIDENT = new URL("../docs/incidents/2026-10-11_lineup_false_violations/", import.meta.url);
function loadFalseRows(e) {
  const pre = JSON.parse(fs.readFileSync(new URL("preimage.json", INCIDENT), "utf8"));
  const cols = Object.keys(pre[0]);
  const ins = e.UPS_MFL_DB.raw.prepare(`INSERT INTO ups_lineup_violations (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`);
  for (const r of pre) ins.run(...cols.map((c) => r[c]));
}
const VOID_SQL = () => fs.readFileSync(new URL("02_void_false_rows.sql", INCIDENT), "utf8");

// ── timing ──────────────────────────────────────────────────────────────────
test("normal Monday night: not before the final kickoff; books AT it", async () => {
  const e = env({ ledger: CBP_LEDGER });
  t.equal((await book(e, SUN425 + 6 * 3600)).skipped, "week_not_final", "Sunday night is not final");
  t.equal((await book(e, MNF - 1)).skipped, "week_not_final", "one second before MNF is not final");
  t.equal(rows(e).length, 0);
  const r = await book(e, MNF);
  t.equal(r.ok, true); t.equal(r.booked, 1, "books at the final kickoff itself");
});

test("*/5 fast path: books inside 15 min of the final kickoff, idle otherwise", async () => {
  const e = env({ ledger: CBP_LEDGER });
  t.equal((await fast(e, MNF - 60)).skipped, "outside_fast_window");
  t.equal((await fast(e, MNF + wiring.FAST_BOOKING_WINDOW_SEC)).skipped, "outside_fast_window", "past the window the hourly run owns it");
  t.equal(rows(e).length, 0);
  const r = await fast(e, MNF + 4 * 60 + 59);     // the first */5 tick after a kickoff is at most 5 min away
  t.equal(r.booked, 1);
});

test("Monday doubleheader: the LATER Monday kickoff is final", async () => {
  const MNF1 = et("2026-10-12T19:15:00-04:00"), MNF2 = et("2026-10-12T22:00:00-04:00");
  const schedule = games(["NOS", "MIN", SUN1], ["ARI", "DET", SUN425], ["LAR", "BUF", MNF1], ["SEA", "SFO", MNF2]);
  const e = env({ ledger: CBP_LEDGER });
  t.equal(wiring.finalKickoffUnix({ kickoffs: [SUN1, MNF2, MNF1] }), MNF2);
  t.equal((await book(e, MNF1 + 30 * 60, { schedule })).skipped, "week_not_final", "after the first Monday game is still not final");
  t.equal((await fast(e, MNF1 + 60, { schedule })).skipped, "outside_fast_window");
  t.equal((await book(e, MNF2, { schedule })).booked, 1);
});

test("final game on another day: a Sunday-night finale books Sunday night", async () => {
  const SNF = et("2026-10-11T20:20:00-04:00");
  const schedule = games(["NOS", "MIN", SUN1], ["ARI", "DET", SUN425], ["GBP", "CHI", SNF]);
  const e = env({ ledger: CBP_LEDGER });
  t.equal((await book(e, SNF - 1, { schedule })).skipped, "week_not_final");
  t.equal((await fast(e, SNF + 120, { schedule })).booked, 1);
});

test("postponed / rescheduled final game: the schedule is re-read every run", async () => {
  const TUE = et("2026-10-13T19:30:00-04:00");
  const moved = games(["NOS", "MIN", SUN1], ["ARI", "DET", SUN425], ["LAR", "BUF", TUE]);
  const e = env({ ledger: CBP_LEDGER });
  // Postponed to Tuesday before Monday's kickoff: Monday no longer ends the week.
  t.equal((await book(e, MNF + 60, { schedule: moved })).skipped, "week_not_final");
  t.equal((await fast(e, MNF + 60, { schedule: moved })).skipped, "outside_fast_window");
  t.equal(rows(e).length, 0);
  t.equal((await fast(e, TUE + 60, { schedule: moved })).booked, 1, "books at the rescheduled final kickoff");
  // Moved EARLIER (flexed to Sunday night): the earlier time ends the week.
  const SNF = et("2026-10-11T20:20:00-04:00");
  const e2 = env({ ledger: CBP_LEDGER });
  t.equal((await book(e2, SNF + 60, { schedule: games(["NOS", "MIN", SUN1], ["ARI", "DET", SUN425], ["LAR", "BUF", SNF]) })).booked, 1);
  // Schedule unreadable at that moment: no booking, no guess.
  const e3 = env({ ledger: CBP_LEDGER });
  t.equal((await book(e3, MNF + 60, { schedule: [] })).skipped, "schedule_unreadable");
});

// ── the lineup source ───────────────────────────────────────────────────────
test("the 2026 weeks 1-4 shape: full lineups never booked although MFL's live week is empty", async () => {
  const seen = [];
  const e = env();
  const r = await book(e, MNF, { seen });
  t.equal(rows(e).length, 0); t.equal(r.clean, 12);
  t.ok(seen.some((u) => u.includes("TYPE=weeklyResults") && u.includes(`&W=${WEEK}&`)), "reads weeklyResults for the booked week");
  t.equal(seen.some((u) => u.includes("TYPE=playerRosterStatus")), false, "never the implicit current-week lineup");
});

test("zero starters is no lineup (separate process), never 'Only 0 of 18'", async () => {
  const e = env();
  const r = await book(e, MNF, { results: { ...STARTERS, "0003": [] } });
  t.equal(rows(e).length, 0);
  t.deepEqual(r.detail.skipped.find((s) => s.fid === "0003"), { fid: "0003", reason: "no_record" });
});

test("a genuine 17-of-18 lineup still books, judged at the final kickoff", async () => {
  const e = env();
  await book(e, MNF, { results: { ...STARTERS, "0004": STARTERS["0004"].slice(0, 17) } });
  const r = rows(e);
  t.deepEqual(r.map((x) => x.fid), ["0004"]);
  t.deepEqual(JSON.parse(r[0].reasons_json).map((x) => x.reason), ["missing_starter"]);
});

test("unreadable or wrong-week results book nothing", async () => {
  const e = env({ ledger: CBP_LEDGER });
  t.equal((await book(e, MNF, { resultsOk: false })).skipped, "week_results_unreadable");
  t.equal((await book(e, MNF, { resultsWeek: WEEK + 1 })).skipped, "week_results_unreadable");
  t.equal(rows(e).length, 0);
});

test("pre-kickoff reads name their week (&W=)", async () => {
  const seen = [];
  globalThis.fetch = mfl({ seen });
  await wiring.submittedStarters(SEASON, L, "0002", STARTERS["0002"], "", 5);
  t.ok(seen.some((u) => u.includes("TYPE=playerRosterStatus") && u.includes("&W=5&")));
});

// ── the corrected history, then CBP Week 5 ─────────────────────────────────
test("voiding the 48 false rows returns all 12 teams to zero; nothing deleted", async () => {
  const e = env();
  loadFalseRows(e);
  const live = () => e.UPS_MFL_DB.raw.prepare("SELECT fid, COUNT(*) n FROM ups_lineup_violations WHERE voided=0 GROUP BY fid").all();
  t.equal(live().length, 12, "before: every team carries live false rows");
  t.deepEqual([...new Set(live().map((r) => r.n))], [4], "each at offense #4");
  e.UPS_MFL_DB.raw.exec("BEGIN;" + VOID_SQL() + "COMMIT;");
  t.equal(live().length, 0, "after: all 12 teams at zero");
  t.equal(e.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ups_lineup_violations").get().n, 48, "voided, not deleted");
  t.equal(e.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ups_lineup_violations WHERE reasons_json IS NULL OR void_reason IS NULL").get().n, 0, "evidence + reason kept");
  let threw = false;
  try { e.UPS_MFL_DB.raw.exec("BEGIN;" + VOID_SQL() + "COMMIT;"); } catch (_) { threw = true; e.UPS_MFL_DB.raw.exec("ROLLBACK"); }
  t.equal(threw, true, "running it again refuses: the rows no longer match the false state");
  t.equal(e.UPS_MFL_DB.raw.prepare("SELECT COUNT(DISTINCT voided_at_utc) n FROM ups_lineup_violations").get().n, 1, "one void stamp");
});

test("CBP Week 5: two OUT starters = two reasons, ONE violation, CBP's 1st of 2026", async () => {
  const e = env({ ledger: CBP_LEDGER });
  loadFalseRows(e);
  e.UPS_MFL_DB.raw.exec("BEGIN;" + VOID_SQL() + "COMMIT;");
  const r = await book(e, MNF);
  t.equal(r.booked, 1);
  const wk5 = rows(e);
  t.deepEqual(wk5.map((x) => x.fid), ["0002"], "only CBP, once");
  t.equal(wk5[0].offense_no, 1, "CBP's first offense of 2026");
  t.deepEqual(JSON.parse(wk5[0].reasons_json).map((x) => [x.player_id, x.reason]), [[ELLISS, "out"], [WINGARD, "out"]], "both starters kept as reasons");
});

test("without the void, the same booking would have read #5 — which is why it ran first", async () => {
  const e = env({ ledger: CBP_LEDGER });
  loadFalseRows(e);
  await book(e, MNF);
  t.equal(rows(e)[0].offense_no, 5);
});

// ── idempotency ─────────────────────────────────────────────────────────────
test("duplicate and overlapping runs never create a second offense", async () => {
  const e = env({ ledger: CBP_LEDGER });
  globalThis.fetch = mfl();
  // The hourly :05 run and the */5 tick fire together at :05 — overlap them.
  const [a, b] = await Promise.all([
    wiring.runLineupBooking(e, { season: SEASON, leagueId: L, week: WEEK, nowUnix: MNF + 600 }),
    wiring.runLineupBookingFastPath(e, { season: SEASON, leagueId: L, week: WEEK, nowUnix: MNF + 600 }),
  ]);
  t.ok(a.ok && b.ok);
  for (let i = 0; i < 3; i += 1) await book(e, MNF + 3600 * (i + 1));   // later hourly retries
  const r = rows(e);
  t.equal(r.length, 1, "one row for CBP Week 5"); t.equal(r[0].offense_no, 1);
  t.equal(e.UPS_MFL_DB.raw.prepare("SELECT COUNT(*) n FROM ups_lineup_violations WHERE fid='0002'").get().n, 1);
});

// ── mass-booking circuit breaker ────────────────────────────────────────────
test(`more than ${wiring.MAX_BOOKINGS_PER_WEEK} candidates in one week books NOTHING`, async () => {
  const more = ["0001", "0003", "0004", "0005", "0006"].map((f) => [pid(f, 0), "OUT", POLL_FROM]);
  const e = env({ ledger: [...CBP_LEDGER, ...more] });
  const r = await book(e, MNF);
  t.equal(r.refused, "mass_booking"); t.equal(rows(e).length, 0);
  t.equal(e.UPS_MFL_DB.raw.prepare("SELECT status FROM ups_bot_heartbeat WHERE bot='lineup_booking'").get().status, `refused:mass_booking wk${WEEK} n=6`);
  const three = ["0001", "0003", "0004"].map((f) => [pid(f, 0), "OUT", POLL_FROM]);
  const e2 = env({ ledger: [...CBP_LEDGER, ...three] });
  t.equal((await book(e2, MNF)).booked, 4, `exactly ${wiring.MAX_BOOKINGS_PER_WEEK} still books`);
});

await run("lineup_booking_week");
