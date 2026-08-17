// §G3 lineup compliance on the 24-hour anchor.
//   node tests/lineup_compliance.test.mjs
//
// The rule (canon §G3, Keith 2026-08-16, anchor confirmed 2026-08-17): a lineup
// is a violation when it contains a missing starter, a player on bye, a player
// listed Out, or a player listed Doubtful who does not play — with injury timing
// measured 24 HOURS BEFORE THAT PLAYER'S KICKOFF.
//
// The case that matters is Keith's own: "guys submit players then those players
// get declared out on Friday." The lineup was legal at submit and went bad
// afterwards, so every assertion here is really asking one question — what did
// the owner know 24 hours before this particular game?
//
// Two things are guarded harder than the rest, because both can cost somebody a
// 4th-round pick:
//   1. late news is NEVER a violation (the whole point of the 24-hour rule)
//   2. an unobserved polling window is NEVER a violation (absence of data is
//      not evidence of a healthy player)
import {
  evaluateStarter, evaluateLineup, statusAsOf, normalizeInjuryStatus,
  lineupLadderRung, lineupLadderLabel, composeLineupDm,
  LINEUP_LADDER, REQUIRED_STARTERS, INJURY_NOTICE_SECONDS,
} from '../worker/src/lineup_compliance.js';

let pass = 0, fail = 0;
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + n + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
};

// Sunday 1:00pm ET kickoff, as a unix second. The 24-hour mark is Sat 1:00pm.
const KICK = 1789491600;
const MARK = KICK - INJURY_NOTICE_SECONDS;
const H = (n) => n * 3600;
const hist = (...pairs) => pairs.map(([status, at]) => ({ status, first_seen_unix: at }));
const P = { id: '13142', name: 'Test Player' };
// Default: polling has covered the whole week, so coverage is never the reason
// a case passes or fails unless a test says so.
const ctx = (o) => ({ kickoffUnix: KICK, observedFromUnix: KICK - H(168), ...o });

console.log('\n-- status normalization --');
t('Out', normalizeInjuryStatus('Out'), 'OUT');
t('OUT (caps)', normalizeInjuryStatus('OUT'), 'OUT');
t('Doubtful', normalizeInjuryStatus('Doubtful'), 'DOUBTFUL');
t('Questionable', normalizeInjuryStatus('Questionable'), 'QUESTIONABLE');
t('IR', normalizeInjuryStatus('IR'), 'IR');
t('empty is ACTIVE', normalizeInjuryStatus(''), 'ACTIVE');
// Only OUT and DOUBTFUL can fine anybody, so anything unrecognized must land
// on the harmless side of the fence.
t('garbage is ACTIVE, never OUT', normalizeInjuryStatus('¯\\_(ツ)_/¯'), 'ACTIVE');

console.log('\n-- statusAsOf reads the past, not the present --');
t('nothing seen yet', statusAsOf(hist(['OUT', MARK + H(1)]), MARK), null);
t('seen before the mark', statusAsOf(hist(['OUT', MARK - H(1)]), MARK), 'OUT');
t('exactly at the mark counts', statusAsOf(hist(['OUT', MARK]), MARK), 'OUT');
t('latest prior status wins',
  statusAsOf(hist(['QUESTIONABLE', MARK - H(48)], ['OUT', MARK - H(2)]), MARK), 'OUT');
t('a later upgrade is invisible at the mark',
  statusAsOf(hist(['OUT', MARK - H(2)], ['ACTIVE', MARK + H(6)]), MARK), 'OUT');

console.log('\n-- KEITH\'S CASE: declared Out with a day\'s notice --');
const outEarly = evaluateStarter(P, ctx({ history: hist(['OUT', MARK - H(6)]), played: false }));
t('verdict', outEarly.verdict, 'violation');
t('reason', outEarly.reason, 'out');

console.log('\n-- late news is never a violation --');
// Ruled out 6 hours before kickoff: inside the window, nothing you could do.
const outLate = evaluateStarter(P, ctx({ history: hist(['OUT', KICK - H(6)]), played: false }));
t('verdict is advisory', outLate.verdict, 'advisory');
t('reason', outLate.reason, 'late_out');
// One second inside the window is still inside it.
const outJustInside = evaluateStarter(P, ctx({ history: hist(['OUT', MARK + 1]), played: false }));
t('one second inside -> advisory', outJustInside.verdict, 'advisory');
// And one second outside is outside.
const outJustOutside = evaluateStarter(P, ctx({ history: hist(['OUT', MARK - 1]), played: false }));
t('one second outside -> violation', outJustOutside.verdict, 'violation');

console.log('\n-- Doubtful: start at your own risk --');
t('Doubtful at the mark, did not play -> violation',
  evaluateStarter(P, ctx({ history: hist(['DOUBTFUL', MARK - H(3)]), played: false })).verdict, 'violation');
t('Doubtful at the mark, PLAYED -> clean',
  evaluateStarter(P, ctx({ history: hist(['DOUBTFUL', MARK - H(3)]), played: true })).verdict, 'clean');
t('Doubtful only AFTER the mark, did not play -> advisory',
  evaluateStarter(P, ctx({ history: hist(['DOUBTFUL', KICK - H(4)]), played: false })).verdict, 'advisory');
// Doubtful at the mark then ruled Out late: you were on notice at the mark, so
// it is the Doubtful branch that governs, not the late Out.
t('Doubtful at mark then Out late -> violation',
  evaluateStarter(P, ctx({ history: hist(['DOUBTFUL', MARK - H(2)], ['OUT', KICK - H(1)]), played: false })).reason,
  'doubtful_did_not_play');

console.log('\n-- Questionable is not a violation status --');
t('Questionable at the mark, played', evaluateStarter(P, ctx({ history: hist(['QUESTIONABLE', MARK - H(20)]), played: true })).verdict, 'clean');
// Questionable at the mark then Out late is exactly §H's "courtesy advisory".
t('Questionable then late Out -> advisory',
  evaluateStarter(P, ctx({ history: hist(['QUESTIONABLE', MARK - H(20)], ['OUT', KICK - H(3)]), played: false })).verdict,
  'advisory');

console.log('\n-- bye weeks ignore the injury clock entirely --');
const bye = evaluateStarter(P, ctx({ onBye: true, history: [], played: false }));
t('bye is a violation', bye.verdict, 'violation');
t('reason', bye.reason, 'bye');
// Byes are published months ahead, so no notice question exists — a bye must be
// a violation even with zero injury coverage.
t('bye still fires with no polling at all',
  evaluateStarter(P, { kickoffUnix: KICK, onBye: true, observedFromUnix: 0, history: [] }).verdict, 'violation');

console.log('\n-- it refuses to guess --');
// Absence of injury data is not evidence of a healthy player.
t('polling started after the mark -> unknown',
  evaluateStarter(P, { kickoffUnix: KICK, observedFromUnix: MARK + H(2), history: [], played: false }).verdict, 'unknown');
t('no kickoff resolved -> unknown',
  evaluateStarter(P, { kickoffUnix: 0, observedFromUnix: KICK - H(168), history: [], played: false }).verdict, 'unknown');
// But a designation we DID see is real evidence even if coverage began late —
// refusing there would let a gap erase a genuine violation.
t('late coverage that still caught an OUT -> violation',
  evaluateStarter(P, { kickoffUnix: KICK, observedFromUnix: MARK + H(2), history: hist(['OUT', MARK - H(1)]), played: false }).verdict,
  'violation');

console.log('\n-- Out but played: booked, and flagged for a human --');
const oddity = evaluateStarter(P, ctx({ history: hist(['OUT', MARK - H(5)]), played: true }));
t('canon books it', oddity.verdict, 'violation');
t('and asks for review', oddity.needs_review, true);

console.log('\n-- a week is ONE violation, however many bad starters --');
const many = evaluateLineup(
  [{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }],
  (p) => ctx({ history: hist(['OUT', MARK - H(5)]), played: false }),
  { requiredStarters: 3 });
t('one weekly verdict', many.verdict, 'violation');
t('all three listed for the DM', many.violations.length, 3);

console.log('\n-- a short lineup is its own violation, no injury data needed --');
const short = evaluateLineup([{ id: '1', name: 'A' }], () => ctx({ history: [], played: true }), { requiredStarters: 3 });
t('verdict', short.verdict, 'violation');
t('reason', short.violations[0].reason, 'missing_starter');
t('counted once, not per empty slot', short.violations.length, 1);
t('default required is 18', REQUIRED_STARTERS, 18);

console.log('\n-- a clean week is clean --');
const clean = evaluateLineup(
  [{ id: '1', name: 'A' }, { id: '2', name: 'B' }],
  () => ctx({ history: hist(['QUESTIONABLE', MARK - H(30)]), played: true }),
  { requiredStarters: 2 });
t('verdict', clean.verdict, 'clean');
t('nothing to report', clean.violations.length, 0);

console.log('\n-- advisories never outrank a real violation --');
const mixed = evaluateLineup(
  [{ id: '1', name: 'Real' }, { id: '2', name: 'Late' }],
  (p) => p.id === '1'
    ? ctx({ history: hist(['OUT', MARK - H(5)]), played: false })
    : ctx({ history: hist(['OUT', KICK - H(2)]), played: false }),
  { requiredStarters: 2 });
t('week reads as a violation', mixed.verdict, 'violation');
t('the late one stays an advisory', mixed.advisories.length, 1);

console.log('\n-- the §G3 ladder --');
t('5 rungs', LINEUP_LADDER.length, 5);
t('1st is a warning', lineupLadderRung(1).cap_k, 0);
t('2nd = 4th-rounder + $5K', [lineupLadderRung(2).pick, lineupLadderRung(2).cap_k], ['4th', 5]);
t('3rd = 2nd-rounder + $5K', [lineupLadderRung(3).pick, lineupLadderRung(3).cap_k], ['2nd', 5]);
t('4th = retention vote', lineupLadderRung(4).membership, 'retention');
t('5th = expulsion', lineupLadderRung(5).membership, 'expulsion');
// Nothing escalates past expulsion — clamp rather than invent a 6th rung.
t('6th clamps to expulsion', lineupLadderRung(6).membership, 'expulsion');
t('0 is not a rung', lineupLadderRung(0), null);
t('label reads plainly', lineupLadderLabel(2), '2nd violation — 4th-round pick + $5K next season');

console.log('\n-- §H: the two DMs must not read alike --');
const dmV = composeLineupDm({ franchiseName: 'Team', week: 3, result: many, windowLabel: 'Sun 1:00pm' });
const dmA = composeLineupDm({ franchiseName: 'Team', week: 3, result: mixed.advisories.length ? { ...mixed, verdict: 'advisory', violations: [] } : mixed, windowLabel: 'Sun 1:00pm' });
const dmC = composeLineupDm({ franchiseName: 'Team', week: 3, result: clean, windowLabel: 'Sun 1:00pm' });
t('violation DM says so', /Possible lineup violation/.test(dmV), true);
t('advisory DM says NOT a violation', /not a violation/i.test(dmA), true);
t('advisory DM never claims a violation', /Possible lineup violation/.test(dmA), false);
t('clean DM confirms compliance', /clean/i.test(dmC), true);
// The 24-hour rule is the thing owners will argue about; the DM should say it.
t('violation DM explains the 24-hour rule', /24 hours/.test(dmV), true);

console.log('\n' + (fail ? 'FAILURES: ' + fail : 'ALL ' + pass + ' PASS'));
process.exit(fail ? 1 : 0);
