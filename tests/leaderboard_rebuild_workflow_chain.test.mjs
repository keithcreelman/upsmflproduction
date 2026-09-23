// 2026-09-23 correction pass: leaderboard-current-season-rebuild.yml used to
// run on a FIXED 90-minutes-after cron, guessing how long
// nflverse-stats-refresh.yml takes. Measured wrong at least twice before
// (Sep 2, Sep 9 refresh failures both left a stale board reporting success)
// and again on 2026-09-23, when the refresh's own cron ran 4h19m late. This
// wires the rebuild to the refresh's ACTUAL completion via `workflow_run`,
// gated on conclusion == success, with workflow_dispatch preserved for
// manual runs and no fixed-time fallback.
//   node tests/leaderboard_rebuild_workflow_chain.test.mjs
//
// Plain string/regex checks against the YAML source — this repo's existing
// convention for workflow files (no YAML-parsing dependency is installed
// for these zero-dependency `node tests/*.test.mjs` files). A smoke check
// below independently confirms the file is at least well-formed YAML when
// python3+pyyaml happen to be available locally; its absence does not fail
// the suite, since CI environments are not guaranteed to have it.
import fs from 'fs';
import assert from 'assert';
import { execFileSync } from 'child_process';

const PATH = '.github/workflows/leaderboard-current-season-rebuild.yml';
const SRC = fs.readFileSync(PATH, 'utf8');
const REFRESH_NAME = 'nflverse stats refresh (Player Stats / FPA / Pace / EPA / SoS / ADP crosswalk)';
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   ' + n); }
  catch (e) { fails++; console.log('  FAIL ' + n + '\n         ' + e.message); } };

console.log('0. the file is well-formed YAML (best-effort smoke check)');
check('parses under python3+pyyaml when available, otherwise skipped (not a hard requirement)', () => {
  try {
    execFileSync('python3', ['-c', `import yaml, sys; yaml.safe_load(open("${PATH}"))`], { stdio: 'pipe' });
  } catch (e) {
    if (e.code === 'ENOENT' || /No module named .?yaml/.test(String(e.stderr || ''))) {
      console.log('    (python3/pyyaml unavailable in this environment — skipped, not a failure)');
      return;
    }
    throw new Error('YAML failed to parse: ' + (e.stderr || e.message));
  }
});

console.log("\n1. successful refresh completion triggers the rebuild");
check('workflow_run watches the exact refresh workflow NAME (must match its `name:` field verbatim)', () => {
  const re = new RegExp('workflow_run:\\s*\\n\\s*workflows:\\s*\\["' + REFRESH_NAME.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '"\\]');
  assert.ok(re.test(SRC), 'workflow_run.workflows must list the refresh workflow\'s exact `name:` string, or GitHub will never fire this trigger');
});
check('workflow_run is gated on types: [completed] (fires once per run, not per queued/in_progress state)', () => {
  assert.ok(/workflow_run:[\s\S]*?types:\s*\[completed\]/.test(SRC));
});
check('the job only proceeds on workflow_dispatch OR a successful workflow_run', () => {
  assert.ok(/if:\s*\|[\s\S]*?github\.event_name == 'workflow_dispatch'[\s\S]*?github\.event_name == 'workflow_run' && github\.event\.workflow_run\.conclusion == 'success'/.test(SRC));
});

console.log('\n2. a failed or cancelled refresh does NOT trigger a rebuild');
check('the job-level `if` never admits a workflow_run whose conclusion is not success', () => {
  // The only workflow_run branch of the `if` requires conclusion == 'success'
  // explicitly -- there is no separate `||` branch admitting 'failure' or
  // 'cancelled', and no bare `github.event_name == 'workflow_run'` clause
  // that would admit ANY conclusion.
  const ifMatch = SRC.match(/if:\s*\|([\s\S]*?)\n\s*runs-on:/);
  assert.ok(ifMatch, 'job-level `if` not found');
  const ifBody = ifMatch[1];
  assert.ok(!/github\.event_name == 'workflow_run'\s*\n?\s*$/.test(ifBody.trim()),
    'a bare workflow_run admission with no conclusion check would let failures through');
  assert.strictEqual((ifBody.match(/workflow_run\.conclusion/g) || []).length, 1,
    'exactly one conclusion check, and it must require success (checked above)');
});

console.log('\n3. workflow_dispatch is preserved for manual runs');
check('workflow_dispatch block still exists with season + pos inputs', () => {
  assert.ok(/workflow_dispatch:\s*\n\s*inputs:\s*\n\s*season:/.test(SRC));
  assert.ok(/pos:\s*\n\s*description:/.test(SRC));
  assert.ok(/options:\s*\[skill, qb, kicker, punter, idp, all\]/.test(SRC));
});
check('a manual dispatch is admitted by the `if` unconditionally (no conclusion check applies to it)', () => {
  assert.ok(/github\.event_name == 'workflow_dispatch'\s*\|\|/.test(SRC));
});

console.log('\n4. no fixed-time scheduled fallback (deliberate -- see file header comment)');
check('the old cron trigger is gone', () => {
  assert.ok(!/schedule:\s*\n\s*-\s*cron:\s*"30 12 \* \* 3"/.test(SRC), 'the fixed 90-minutes-later cron must be removed, not left alongside workflow_run');
  assert.ok(!/^\s*schedule:\s*$/m.test(SRC.split('concurrency:')[0]) || !/cron:/.test(SRC),
    'no schedule trigger of any kind should remain on this workflow');
});
check('the decision not to keep a scheduled fallback is documented, not silent', () => {
  assert.ok(/NO SCHEDULED FALLBACK, DELIBERATELY/.test(SRC));
});

console.log('\n5. concurrency prevents overlapping/duplicate rebuilds');
check('a workflow-level concurrency group with cancel-in-progress: false', () => {
  assert.ok(/concurrency:\s*\n\s*group:\s*leaderboard-current-season-rebuild\s*\n\s*cancel-in-progress:\s*false/.test(SRC));
});
check('concurrency is declared before the job (workflow-level, not accidentally job-scoped-only)', () => {
  const concIdx = SRC.indexOf('concurrency:');
  const jobsIdx = SRC.indexOf('\njobs:');
  assert.ok(concIdx > 0 && jobsIdx > concIdx, 'concurrency must precede `jobs:` to apply at the workflow level');
});

console.log('\n6. post-rebuild validation fails honestly when still behind the authoritative week');
check('a verification step exists and reads NO_CACHE=1 (bypasses the edge cache, sees fresh D1 state)', () => {
  assert.ok(/Verify the leaderboard is not behind the authoritative week/.test(SRC));
  assert.ok(/NO_CACHE=1/.test(SRC));
});
check('the verification step reuses the SAME read route the app itself serves (no second/competing check)', () => {
  assert.ok(/\/api\/advanced-stats-leaderboard\?seasons=\$\{SEASON\}&pos=\$\{P\}/.test(SRC));
});
check('the verification step exits non-zero when `stale` is true for any built alias', () => {
  assert.ok(/elif stale:[\s\S]*?sys\.exit\(1\)/.test(SRC));
});
check('a stale:null (non-current-season / non-precompute) response is treated as "nothing to verify", not a failure', () => {
  assert.ok(/if stale is None:/.test(SRC));
});
check('"all" expands to the five real aliases for verification (the read route does not accept pos=all)', () => {
  assert.ok(/ALIASES_TO_CHECK=\(skill qb kicker punter idp\)/.test(SRC));
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
