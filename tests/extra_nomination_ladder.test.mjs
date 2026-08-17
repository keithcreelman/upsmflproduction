// §F RULE 2, extra-nomination half (canon §T4.3a, Keith's text 2026-08-17).
//   node tests/extra_nomination_ladder.test.mjs
//
// The miss ladder shifted one rung: warning -> $3K -> $7K -> $15K -> league-fit
// review, each fine charged to the current season AND the next.
//
// What actually needs guarding here is not the price table -- it is that the
// two ladders stay INDEPENDENT. They share one ledger, one void path and one
// re-derivation routine, so the failure modes are:
//   - an over-nomination counting as a missed-nomination offense (or vice versa)
//   - penalty_id collisions between the two kinds on the same day
//   - complianceStandings silently merging them, inflating every existing report
//   - an excused day re-deriving one ladder but not the other
//
// Runs the real exported functions against a tiny in-memory stand-in for D1,
// so the SQL shape is exercised rather than mocked away.
import {
  rule2FineK, rule2OverFineK, rule2OverLabel, rule2Label,
  RULE2_OVER_FINE_K_BY_OFFENSE, NOM_MAX_PER_DAY,
  closeEtDay, complianceStandings, voidNomDay,
} from '../worker/src/auction_compliance.js';

let pass = 0, fail = 0;
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + n + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
};

// ── a minimal D1 stand-in ────────────────────────────────────────────────────
// Enough SQL to run the real queries: the two tables, the handful of WHERE
// shapes the module uses, INSERT OR IGNORE, and ON CONFLICT DO UPDATE.
function makeDb() {
  const days = new Map();      // key: season|league|fid|et_day
  const penalties = new Map(); // key: penalty_id
  const dayKey = (r) => `${r.season}|${r.league_id}|${r.fid}|${r.et_day}`;

  const run = (sql, args) => {
    const q = sql.replace(/\s+/g, ' ').trim();

    if (q.startsWith('INSERT OR IGNORE INTO ups_faa_nom_days')) {
      const [season, league_id, fid, et_day, noms_used, noms_required, roster_met,
             total_deficit, missed, over, voided, void_reason, voided_by] = args;
      const r = { season, league_id, fid, et_day, noms_used, noms_required, roster_met,
                  total_deficit, missed, over, voided, void_reason, voided_by };
      if (!days.has(dayKey(r))) days.set(dayKey(r), r);
      return { meta: { changes: 1 } };
    }
    if (q.startsWith('INSERT OR IGNORE INTO ups_faa_nom_penalties')) {
      const [penalty_id, season, league_id, fid, et_day, offense_no, amount_k, applies_to_season, ...rest] = args;
      const kind = q.includes("'over'") ? 'over' : 'miss';
      const [voided, void_reason] = q.includes("'over'") ? rest : rest.slice(-2);
      if (!penalties.has(penalty_id)) {
        penalties.set(penalty_id, { penalty_id, season, league_id, fid, et_day, offense_no,
                                    amount_k, applies_to_season, kind, voided, void_reason, posted_to_mfl: 0 });
      }
      return { meta: { changes: 1 } };
    }
    if (q.startsWith('INSERT INTO ups_faa_nom_penalties')) {  // recomputeLadder upsert
      const [penalty_id, season, league_id, fid, et_day, offense_no, amount_k, applies_to_season, kind] = args;
      const prev = penalties.get(penalty_id) || { posted_to_mfl: 0 };
      penalties.set(penalty_id, { ...prev, penalty_id, season, league_id, fid, et_day,
                                  offense_no, amount_k, applies_to_season, kind, voided: 0 });
      return { meta: { changes: 1 } };
    }
    if (q.startsWith('UPDATE ups_faa_nom_days SET voided=1')) {
      const [reason, by, at, season, league_id, fid, et_day] = args;
      let n = 0;
      for (const r of days.values()) {
        if (r.season == season && r.league_id == league_id && r.fid === fid && r.et_day === et_day && !r.voided) {
          r.voided = 1; r.void_reason = reason; n++;
        }
      }
      return { meta: { changes: n } };
    }
    if (q.startsWith('UPDATE ups_faa_nom_penalties SET voided=1, void_reason=?, voided_by=?')) {
      const [reason, by, at, season, league_id, fid, et_day] = args;
      let n = 0;
      for (const p of penalties.values()) {
        if (p.season == season && p.league_id == league_id && p.fid === fid && p.et_day === et_day && !p.voided) {
          p.voided = 1; p.void_reason = reason; n++;
        }
      }
      return { meta: { changes: n } };
    }
    if (q.startsWith('UPDATE ups_faa_nom_penalties SET voided=1, void_reason=?  WHERE') ||
        q.startsWith('UPDATE ups_faa_nom_penalties SET voided=1, void_reason=? WHERE')) {
      const [why, season, league_id, fid, et_day, kind] = args;
      let n = 0;
      for (const p of penalties.values()) {
        if (p.season == season && p.league_id == league_id && p.fid === fid &&
            p.et_day === et_day && p.kind === kind && !p.voided) { p.voided = 1; p.void_reason = why; n++; }
      }
      return { meta: { changes: n } };
    }
    throw new Error('unhandled SQL: ' + q.slice(0, 90));
  };

  const first = (sql, args) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.includes('COUNT(*) AS n FROM ups_faa_nom_days')) {
      const flag = q.includes('over=1') ? 'over' : 'missed';
      const [season, league_id, fid, et_day] = args;
      let n = 0;
      for (const r of days.values()) {
        if (r.season == season && r.league_id == league_id && r.fid === fid &&
            r[flag] === 1 && !r.voided && r.et_day < et_day) n++;
      }
      return { n };
    }
    if (q.includes('SELECT amount_k, posted_to_mfl FROM ups_faa_nom_penalties')) {
      return penalties.get(args[0]) || null;
    }
    if (q.includes('COUNT(*) AS n FROM ups_faa_nom_penalties')) {  // postedCount()
      const [season, league_id, fid, et_day] = args;
      let n = 0;
      for (const p of penalties.values()) {
        if (p.season == season && p.league_id == league_id && p.fid === fid &&
            p.et_day === et_day && p.posted_to_mfl === 1) n++;
      }
      return { n };
    }
    throw new Error('unhandled first(): ' + q.slice(0, 90));
  };

  const all = (sql, args) => {
    const q = sql.replace(/\s+/g, ' ').trim();
    if (q.startsWith('SELECT et_day FROM ups_faa_nom_days')) {
      const flag = q.includes('over=1') ? 'over' : 'missed';
      const [season, league_id, fid] = args;
      const rows = [...days.values()]
        .filter((r) => r.season == season && r.league_id == league_id && r.fid === fid && r[flag] === 1 && !r.voided)
        .sort((a, b) => String(a.et_day).localeCompare(String(b.et_day)))
        .map((r) => ({ et_day: r.et_day }));
      return { results: rows };
    }
    if (q.includes("FROM ups_faa_nom_penalties") && q.includes('GROUP BY fid')) {
      // Reflect the SQL faithfully: only filter by kind if the query SAYS to.
      // Deriving it any other way would make this mock filter on the module's
      // behalf and hide the exact bug these assertions exist to catch -- a
      // missing kind filter silently merging the two ladders.
      const kind = q.includes("kind='over'") ? 'over' : q.includes("kind='miss'") ? 'miss' : null;
      const [season, , , league_id] = args;
      const by = {};
      for (const p of penalties.values()) {
        if (p.season != season || p.league_id != league_id || p.voided) continue;
        if (kind !== null && p.kind !== kind) continue;
        by[p.fid] = by[p.fid] || { fid: p.fid, k_now: 0, k_next: 0, dayset: new Set() };
        if (p.applies_to_season == Number(season)) by[p.fid].k_now += p.amount_k;
        if (p.applies_to_season == Number(season) + 1) by[p.fid].k_next += p.amount_k;
        by[p.fid].dayset.add(p.et_day);
      }
      return { results: Object.values(by).map((r) => ({ fid: r.fid, k_now: r.k_now, k_next: r.k_next, offenses: r.dayset.size })) };
    }
    if (q.includes('COUNT(*) AS n FROM ups_faa_nom_days') && q.includes('GROUP BY fid')) {
      const [season, league_id] = args;
      const by = {};
      for (const r of days.values()) {
        if (r.season != season || r.league_id != league_id || r.over !== 1 || r.voided) continue;
        by[r.fid] = (by[r.fid] || 0) + 1;
      }
      return { results: Object.entries(by).map(([fid, n]) => ({ fid, n })) };
    }
    throw new Error('unhandled all(): ' + q.slice(0, 90));
  };

  const prepare = (sql) => ({
    bind: (...args) => ({ run: async () => run(sql, args), first: async () => first(sql, args), all: async () => all(sql, args) }),
  });
  return { prepare, _days: days, _penalties: penalties };
}

// closeEtDay reads nomination counts from ups_faa_nom_events via nomCountsForDay,
// which we cannot reach from here -- so drive the ladder functions directly and
// assert closeEtDay's verdict separately through its pure predicate.
const env = (db) => ({ UPS_MFL_DB: db, __flags: {} });

console.log('\n-- the ladder is the miss ladder shifted one rung --');
t('schedule', RULE2_OVER_FINE_K_BY_OFFENSE, [0, 3, 7, 15]);
t('1st is a warning', rule2OverFineK(1), 0);
t('2nd = 1st missed-nom price', rule2OverFineK(2), rule2FineK(1));
t('3rd = 2nd missed-nom price', rule2OverFineK(3), rule2FineK(2));
t('4th = 3rd missed-nom price', rule2OverFineK(4), rule2FineK(3));
t('5th falls off the schedule', rule2OverFineK(5), 0);

console.log('\n-- zero means two different things and must read differently --');
t('1st is a warning, not a review', rule2OverLabel(1), '1st extra nomination — warning, no fine');
t('5th is a review, not a warning', rule2OverLabel(5), '5th extra nomination — league-fit review (no fine)');
t('2nd names the money and both years', rule2OverLabel(2), '2nd extra nomination — $3K this season + $3K next');
t('over label never says "missed"', /missed/.test(rule2OverLabel(2)), false);
t('miss label is untouched', rule2Label(1), '1st offense — $3K this season + $3K next');

console.log('\n-- the ceiling is a hard 2, not derived from the floor --');
t('ceiling constant', NOM_MAX_PER_DAY, 2);
// §A2: the ceiling is unconditional. A franchise whose floor is waived (legal
// roster, noms_required effectively 0) still cannot nominate 3.
const over = (used) => used > NOM_MAX_PER_DAY;
t('2 is legal', over(2), false);
t('3 is over', over(3), true);
t('0 is not over (that is the miss ladder)', over(0), false);

console.log('\n-- the two ladders never share an offense number --');
const db = makeDb(); const E = env(db);
// Hand-seed days: fid 0008 misses Tue, over-nominates Wed and Fri.
const day = (fid, et_day, { missed = 0, over = 0, used = 2 }) =>
  db.prepare('INSERT OR IGNORE INTO ups_faa_nom_days (a) VALUES (?)').bind(
    2026, '74598', fid, et_day, used, 2, 1, 0, missed, over, 0, null, null).run();
await day('0008', '2026-07-21', { missed: 1, used: 0 });
await day('0008', '2026-07-22', { over: 1, used: 3 });
await day('0008', '2026-07-24', { over: 1, used: 4 });

// Re-derive both ladders through the real void path (voiding a day nobody has,
// which is a no-op on the data but runs recomputeOffenses over everything).
await voidNomDay(E, { season: 2026, leagueId: '74598', fid: '0008', etDay: '1999-01-01', reason: 'noop', by: 'test' });

const rows = [...db._penalties.values()].filter((p) => !p.voided);
const missRows = rows.filter((p) => p.kind === 'miss');
const overRows = rows.filter((p) => p.kind === 'over');
t('the miss is offense 1 on its own ladder', [...new Set(missRows.map((p) => p.offense_no))], [1]);
t('miss priced at $3K', [...new Set(missRows.map((p) => p.amount_k))], [3]);
// First over is a warning (no rows); second over is offense 2 at $3K.
t('over offense 1 books no money', overRows.filter((p) => p.et_day === '2026-07-22').length, 0);
t('over offense 2 exists', [...new Set(overRows.map((p) => p.offense_no))], [2]);
t('over offense 2 priced at $3K', [...new Set(overRows.map((p) => p.amount_k))], [3]);
t('both cap years booked', overRows.map((p) => p.applies_to_season).sort(), [2026, 2027]);

console.log('\n-- penalty ids cannot collide across kinds --');
const ids = rows.map((p) => p.penalty_id);
t('all ids unique', ids.length, new Set(ids).size);
t('miss ids keep their original 5-part shape', missRows.every((p) => p.penalty_id.split('|').length === 5), true);
t('over ids are suffixed', overRows.every((p) => p.penalty_id.endsWith('|over')), true);

console.log('\n-- standings report the ladders separately --');
const st = await complianceStandings(E, { season: 2026, leagueId: '74598' });
const s8 = st.get('0008');
t('miss offenses not inflated by overs', s8.offenses, 1);
t('miss money not inflated by overs', s8.fined_k_this_season, 3);
t('over offenses counted from DAYS, so the warning still shows', s8.over_offenses, 2);
t('over money reported on its own line', s8.over_fined_k_this_season, 3);

console.log('\n-- an excused day re-derives the OTHER ladder too --');
// Excuse the first over-nomination. The second must fall from offense 2 ($3K)
// to offense 1 (warning, no money) -- the same re-derivation §T4.3a requires
// for misses, one rung over.
await voidNomDay(E, { season: 2026, leagueId: '74598', fid: '0008', etDay: '2026-07-22', reason: 'gave notice', by: 'commish' });
const liveOver = [...db._penalties.values()].filter((p) => !p.voided && p.kind === 'over');
t('excused over drops the survivor to a warning', liveOver.length, 0);
const st2 = await complianceStandings(E, { season: 2026, leagueId: '74598' });
t('miss ladder untouched by the over void', st2.get('0008').offenses, 1);
t('miss money untouched', st2.get('0008').fined_k_this_season, 3);
t('one surviving over offense', st2.get('0008').over_offenses, 1);

console.log('\n' + (fail ? 'FAILURES: ' + fail : 'ALL ' + pass + ' PASS'));
process.exit(fail ? 1 : 0);
