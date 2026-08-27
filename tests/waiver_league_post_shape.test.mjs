// The league's waiver-run post must ask for the CONSOLIDATED shape.
//   node tests/waiver_league_post_shape.test.mjs
//
// The one-post-per-run layout ("report") was built in #928 and then wired to the
// TEST channel only, as a preview (Keith 2026-08-21). The league's own post sent
// no `shape` at all, so it silently kept the per-team layout — and because both
// posts came from the same tick and both said "ok", nothing looked broken. The
// league simply never saw the shape that had been built for it.
//
// These assertions anchor on the SCHEDULED TICK'S league post specifically, not
// on a bare `shape: "report"` anywhere in the file — the admin route legitimately
// contains that string too, so a file-wide grep would pass even if the cron
// reverted to per-team.
import fs from 'fs';
import assert from 'assert';

const SRC = fs.readFileSync('worker/src/index.js', 'utf8');
let fails = 0;
const check = (n, fn) => { try { fn(); console.log('  ok   ' + n); }
  catch (e) { fails++; console.log('  FAIL ' + n + '\n         ' + e.message); } };

// Isolate the league post: the addAutoPost self-fetch inside scheduled().
// Anchored on the block itself and asserted NON-EMPTY, because an anchor that
// stops matching would otherwise make every check below pass vacuously against
// an empty string — which has happened in this repo before.
const start = SRC.indexOf('if (addAutoPost) {');
const end = SRC.indexOf('addsPosted = Number(apData?.posted_count)', start);
const leaguePost = start > 0 && end > start ? SRC.slice(start, end) : '';

console.log('the league post block is locatable');
check('anchors still match and the slice is substantial', () => {
  assert.ok(start > 0, 'anchor "if (addAutoPost) {" not found');
  assert.ok(end > start, 'anchor "addsPosted = Number(apData?.posted_count)" not found after it');
  assert.ok(leaguePost.length > 200,
    `slice is only ${leaguePost.length} chars — the anchors have drifted and these checks would be vacuous`);
});

console.log('\nthe league gets the consolidated shape');
check('it requests shape: "report"', () => {
  assert.ok(/shape:\s*"report"/.test(leaguePost),
    'the cron league post sends no shape — the route then falls back to the per-team layout, which is the bug this guards');
});
check('it posts to the configured league target, not a hardcoded channel', () => {
  assert.ok(/target:\s*addTarget/.test(leaguePost),
    'the league post must honour ADD_TRACKER_DISCORD_TARGET');
});

console.log('\nthe limit is high enough that one run is one post');
check('limit is 50, not the old 20', () => {
  const m = leaguePost.match(/limit:\s*(\d+)/);
  assert.ok(m, 'no limit found in the league post body');
  assert.strictEqual(Number(m[1]), 50,
    'dedupe is the per-row discord_posted flag, so a run larger than the limit posts its ' +
    'overflow on the next tick — under "report" that is a SECOND league-wide report for one run');
});

console.log('\nthe test-channel preview is gone, not merely disabled');
check('no second self-fetch posts the same shape to "test"', () => {
  assert.ok(!/target:\s*"test",\s*shape:\s*"report"/.test(SRC),
    'the preview still fires — it existed only because the league lacked this shape, ' +
    'and leaving it duplicates every run into the test channel');
});

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
