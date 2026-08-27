// Regenerate the /api/advanced-stats-leaderboard SQL exactly as the worker builds it.
//
//   node scripts/leaderboard_sql.js <pos> <seasons-csv> <weekmode> [--explain]
//     pos       qb | skill | idp | kicker | punter
//     weekmode  reg (w.week <= 17, the default the endpoint uses when no week
//               params are sent) | post (1=1) | btw:LO-HI
//
// WHY: the SQL is a template literal assembled from a dozen interpolations, so
// it cannot be read out of the file and run. Profiling it, or proving a rewrite
// is output-identical, needs the REAL statement. This splices the live source so
// the generated SQL can never drift from what ships.
//
// Anchored on the code, NOT on line numbers — an earlier throwaway version of
// this used a hardcoded slice and silently produced garbage the moment anyone
// edited the file above it.
//
// EXPLAIN QUERY PLAN costs 0 rows read. RUNNING the output can cost millions;
// check the plan first.
const fs = require('fs');
const path = require('path');

const SRC_PATH = process.env.LB_SRC ||
  path.join(__dirname, '..', 'worker', 'src', 'index.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

const [pos, seasonsCsv, weekmode] = process.argv.slice(2);
const explain = process.argv.includes('--explain');
const PG = { skill: ['RB','WR','TE'], qb: ['QB'], idp: ['DL','LB','DB'],
             kicker: ['PK'], punter: ['PN','PK'] }[pos];
if (!PG) { console.error('pos must be qb|skill|idp|kicker|punter'); process.exit(2); }

// The statement: from `const sql = ` + backtick, to the next backtick. The SQL
// body contains no backticks (asserted below) so the first one closes it.
const START = 'const sql = `';
const i = src.indexOf(START + '\n            WITH current_team AS (');
if (i < 0) { console.error('could not find the leaderboard SQL template'); process.exit(1); }
const from = i + START.length;
const j = src.indexOf('`', from);
if (j < 0) { console.error('unterminated template literal'); process.exit(1); }
let body = src.slice(from, j);
if (!/ORDER BY \$\{orderExpr\}/.test(body)) {
  console.error('slice does not end at the ORDER BY — anchors have drifted'); process.exit(1);
}

const grab = (n) => {
  const k = src.indexOf('const ' + n + ' = `');
  return src.slice(k + ('const ' + n + ' = `').length, src.indexOf('`;', k));
};
const _phase = pos === 'idp' ? 'idp' : (pos === 'kicker' || pos === 'punter') ? 'special' : 'offense';
const projection = grab('COL_SHARED') + ',\n                   ' +
  (_phase === 'idp' ? grab('COL_IDP') : _phase === 'special' ? grab('COL_SPECIAL') : grab('COL_OFFENSE'));
const orderExpr = _phase === 'idp'
  ? '(COALESCE(a.def_tackles_total,0) + COALESCE(a.def_tackles_ast,0) + COALESCE(a.def_sacks,0)*2 + COALESCE(a.def_ints,0)*2 + COALESCE(a.def_tfl,0))'
  : 'a.rush_yds + a.rec_yds + a.pass_yds';

let wk, rzwk;
if (weekmode === 'post') { wk = '1=1'; rzwk = '1=1'; }
else if (weekmode && weekmode.startsWith('btw:')) {
  const [lo, hi] = weekmode.slice(4).split('-');
  wk = `w.week BETWEEN ${lo} AND ${hi}`; rzwk = `rz.week BETWEEN ${lo} AND ${hi}`;
} else { wk = 'w.week <= 17'; rzwk = 'rz.week <= 17'; }

const seasonList = seasonsCsv;
const paceSeason = Math.max(...seasonsCsv.split(',').map(Number));

// Evaluate each ${...} the way the worker does, by name. Anything left over is
// a fatal error rather than a silently-unsubstituted placeholder.
body = body.replace(/\$\{([^}]*)\}/g, (m, expr) => {
  const e = expr.trim();
  if (e === 'seasonList') return seasonList;
  if (e === 'posList') return PG.map((p) => `'${p}'`).join(',');
  if (e === 'paceSeason') return String(paceSeason);
  if (e === 'projection') return projection;
  if (e === 'orderExpr') return orderExpr;
  if (e === 'weekFilter' || e === 'weekSqlPredicate') return wk;
  if (e === 'rzWeekSqlPredicate') return rzwk;
  if (/^weekFilter\.replace/.test(e) || /^weekSqlPredicate\.replace/.test(e)) {
    if (/"pw\."/.test(e)) return wk.replace(/\bw\./g, 'pw.');
    if (/"tw\.week"/.test(e)) return wk.replace(/\bw\.week\b/g, 'tw.week');
    if (/"sw\.week"/.test(e)) return wk.replace(/\bw\.week\b/g, 'sw.week');
    if (/"s\.week"/.test(e)) return wk.replace(/\bw\.week\b/g, 's.week');
    if (/"week"/.test(e)) return wk.replace(/w\.week/g, 'week');
  }
  console.error('UNHANDLED interpolation: ${' + e + '}'); process.exit(1);
});
if (body.includes('${')) { console.error('unsubstituted placeholder remains'); process.exit(1); }

// The two bind params, in order: min_games then limit.
body = body.replace('a.games >= ?', 'a.games >= 1').replace('LIMIT ?', 'LIMIT 500');
process.stdout.write((explain ? 'EXPLAIN QUERY PLAN ' : '') + body.trim() + '\n');
