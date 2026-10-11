// §G3 end-of-week booking reads THE WEEK BEING BOOKED, and fails closed.
//   node tests/lineup_booking_week.test.mjs
//
// Found 2026-10-11: ups_lineup_violations held a row for all 12 franchises in
// every week 1-4 of 2026 (48 rows), 44 of them "Only 0 of 18 starting slots
// filled". MFL's own weeklyResults shows 18 starters for every team every week.
// The booking pass runs ~1am ET Tuesday and read playerRosterStatus with no W=,
// which MFL answers for its CURRENT lineup week — already the next one, mostly
// unset. These tests pin the fix: the booking lineup comes from
// weeklyResults&W=<booked week>, zero starters is never booked as a short
// lineup, and a week that would book more than MAX_BOOKINGS_PER_WEEK teams
// books nothing.
import * as wiring from '../worker/src/lineup_wiring.js';

let pass = 0, fail = 0;
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + n + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
};

// ── fixtures ────────────────────────────────────────────────────────────────
const SEASON = 2026, L = '74598', WEEK = 5;
const KO = 1791738000;                 // Sun Oct 11 2026 1:00pm ET
const NOW = KO + 2 * 86400;            // Tue, long after the week settled
const FIDS = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(4, '0'));
// 12 teams x 18 starters; every player on NOS, which kicks off at KO.
const pid = (f, i) => `${f}${String(i).padStart(2, '0')}`;
const STARTERS = Object.fromEntries(FIDS.map((f) => [f, Array.from({ length: 18 }, (_, i) => pid(f, i))]));

function mflFetch({ results, rosterStatus = 'NS', resultsWeek = WEEK, resultsOk = true, seen }) {
  return async (url) => {
    const u = String(url);
    seen && seen.push(u);
    const json = (body) => ({ ok: true, json: async () => body });
    if (u.includes('TYPE=nflSchedule')) {
      return json({ nflSchedule: { matchup: [{ kickoff: String(KO), team: [{ id: 'NOS', isHome: '1' }, { id: 'MIN', isHome: '0' }] }] } });
    }
    if (u.includes('TYPE=nflByeWeeks')) return json({ nflByeWeeks: { team: [] } });
    if (u.includes('TYPE=players')) {
      const player = FIDS.flatMap((f) => STARTERS[f].map((id) => ({ id, name: `P ${id}`, team: 'NOS', position: 'LB' })));
      return json({ players: { player } });
    }
    if (u.includes('TYPE=rosters')) {
      return json({ rosters: { franchise: FIDS.map((f) => ({ id: f, player: STARTERS[f].map((id) => ({ id, status: 'ROSTER' })) })) } });
    }
    if (u.includes('TYPE=playerRosterStatus')) {
      // What MFL's CURRENT (next) week looks like at 1am Tuesday: nobody set.
      const ids = new URL(u).searchParams.get('P').split(',');
      return json({ playerRosterStatuses: { playerStatus: ids.map((id) => ({ id, roster_franchise: { franchise_id: id.slice(0, 4), status: rosterStatus } })) } });
    }
    if (u.includes('TYPE=weeklyResults')) {
      if (!resultsOk) return { ok: false, json: async () => null };
      const franchise = Object.entries(results).map(([id, s]) => ({ id, starters: s.length ? s.join(',') + ',' : '' }));
      return json({ weeklyResults: { week: String(resultsWeek), matchup: [{ franchise: franchise.slice(0, 6) }, { franchise: franchise.slice(6) }] } });
    }
    return { ok: false, json: async () => null };
  };
}

// Minimal D1 stand-in: just the statements the booking pass issues.
function fakeDb({ outPids = [] } = {}) {
  const violations = [];
  const heartbeats = {};
  const injury = outPids.map((p) => ({ player_id: p, status: 'OUT', first_seen_unix: KO - 3 * 86400 }));
  const db = {
    violations, heartbeats,
    prepare(sql) {
      let args = [];
      const stmt = {
        bind(...a) { args = a; return stmt; },
        async first() {
          if (/MIN\(polled_unix\)/.test(sql)) return { first: KO - 7 * 86400 };
          if (/SELECT 1 FROM ups_lineup_violations/.test(sql)) {
            const [, , fid, week] = args;
            return violations.find((v) => v.fid === fid && v.week === week) ? { 1: 1 } : null;
          }
          if (/COUNT\(\*\) AS n FROM ups_lineup_violations/.test(sql)) {
            const [, , fid, week] = args;
            return { n: violations.filter((v) => v.fid === fid && !v.voided && v.week < week).length };
          }
          return null;
        },
        async all() {
          if (/FROM ups_injury_status/.test(sql)) return { results: injury };
          return { results: [] };
        },
        async run() {
          if (/INSERT INTO ups_lineup_violations/.test(sql)) {
            const [, , fid, week, offense_no, reasons_json] = args;
            violations.push({ fid, week, offense_no, reasons_json, voided: 0 });
          }
          if (/INSERT INTO ups_bot_heartbeat/.test(sql)) heartbeats[args[0]] = args[2];
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

const run = async ({ results, outPids, resultsWeek, resultsOk, seen }) => {
  globalThis.fetch = mflFetch({ results, resultsWeek, resultsOk, seen });
  const db = fakeDb({ outPids });
  const res = await wiring.runLineupBooking({ UPS_MFL_DB: db }, { season: SEASON, leagueId: L, week: WEEK, nowUnix: NOW });
  return { res, db };
};

// ── 1. the 2026 weeks 1-4 shape: full lineups, MFL's live week empty ─────────
console.log('\n-- full lineups are never booked because next week is empty --');
{
  const seen = [];
  const { res, db } = await run({ results: STARTERS, seen });
  t('nothing booked', db.violations.length, 0);
  t('all 12 judged clean', res.clean, 12);
  t('booking read weeklyResults for the booked week', seen.some((u) => u.includes('TYPE=weeklyResults') && u.includes(`&W=${WEEK}&`)), true);
  t('booking never read the live lineup', seen.some((u) => u.includes('TYPE=playerRosterStatus')), false);
}

// ── 2. zero starters is "no lineup", a separate process ─────────────────────
console.log('\n-- zero starters is skipped as no_record, never "0 of 18" --');
{
  const results = { ...STARTERS, '0003': [] };
  const { res, db } = await run({ results });
  t('nothing booked', db.violations.length, 0);
  t('0003 skipped as no_record', res.detail.skipped.find((s) => s.fid === '0003'), { fid: '0003', reason: 'no_record' });
}

// ── 3. a genuine short lineup is still a violation ──────────────────────────
console.log('\n-- a real 17-of-18 lineup still books --');
{
  const results = { ...STARTERS, '0004': STARTERS['0004'].slice(0, 17) };
  const { db } = await run({ results });
  t('one row, for 0004', db.violations.map((v) => v.fid), ['0004']);
  t('reason is missing_starter', JSON.parse(db.violations[0].reasons_json).map((r) => r.reason), ['missing_starter']);
  t('offense 1', db.violations[0].offense_no, 1);
}

// ── 4. two starters Out with notice who did not play ──────────────────────
console.log('\n-- an Out-with-notice starter books once for the team --');
{
  const { db } = await run({ results: STARTERS, outPids: [pid('0002', 4), pid('0002', 9)] });
  t('one row (one per franchise-week), for 0002', db.violations.map((v) => v.fid), ['0002']);
  t('both starters recorded as reasons', JSON.parse(db.violations[0].reasons_json).map((r) => r.reason), ['out', 'out']);
}

// ── 5. mass-booking guard ───────────────────────────────────────────────────
console.log(`\n-- more than ${wiring.MAX_BOOKINGS_PER_WEEK} candidates books NOTHING --`);
{
  const outPids = ['0001', '0002', '0003', '0004', '0005'].map((f) => pid(f, 0));
  const { res, db } = await run({ results: STARTERS, outPids });
  t('nothing written', db.violations.length, 0);
  t('refused as mass_booking', res.refused, 'mass_booking');
  t('heartbeat says refused', db.heartbeats.lineup_booking, `refused:mass_booking wk${WEEK} n=5`);
}
{
  const outPids = ['0001', '0002', '0003', '0004'].map((f) => pid(f, 0));
  const { db } = await run({ results: STARTERS, outPids });
  t(`exactly ${wiring.MAX_BOOKINGS_PER_WEEK} still books`, db.violations.length, 4);
}

// ── 6. unreadable or wrong-week results fail closed ─────────────────────────
console.log('\n-- an unreadable or mismatched weeklyResults books nothing --');
{
  const { res, db } = await run({ results: STARTERS, resultsOk: false, outPids: [pid('0002', 4)] });
  t('unreadable: nothing written', db.violations.length, 0);
  t('unreadable: skipped', res.skipped, 'week_results_unreadable');
}
{
  const { res, db } = await run({ results: STARTERS, resultsWeek: WEEK + 1, outPids: [pid('0002', 4)] });
  t('wrong week: nothing written', db.violations.length, 0);
  t('wrong week: skipped', res.skipped, 'week_results_unreadable');
}

// ── 7. the pre-kickoff read names its week too ──────────────────────────────
console.log('\n-- submittedStarters passes &W= --');
{
  const seen = [];
  globalThis.fetch = mflFetch({ results: STARTERS, seen });
  await wiring.submittedStarters(SEASON, L, '0002', STARTERS['0002'], '', 5);
  t('W=5 in the playerRosterStatus URL', seen.some((u) => u.includes('TYPE=playerRosterStatus') && u.includes('&W=5&')), true);
}

console.log('\n' + (fail ? 'FAILURES: ' + fail : 'ALL ' + pass + ' PASS'));
process.exit(fail ? 1 : 0);
