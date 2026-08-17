// §G3 lineup compliance — every rule confirmed by Keith 2026-08-17.
//   node tests/lineup_compliance.test.mjs
//
// The case being caught is Keith's own: "guys submit players then those players
// get declared out on Friday." The lineup was legal at submit and went bad
// afterwards, so everything reduces to one question — what did the owner know
// by his notice deadline for THIS player's game?
//
// Every scenario below was walked through with Keith and confirmed before it
// was written, which is why the assertions quote him rather than canon alone.
import {
  evaluateStarter, evaluateLineup, statusAsOf, normalizeInjuryStatus,
  lineupLadderRung, lineupLadderLabel, composeLineupDm,
  saturdayCapUnix, noticeMarkUnix,
  LINEUP_LADDER, REQUIRED_STARTERS, INJURY_NOTICE_SECONDS,
} from '../worker/src/lineup_compliance.js';

let pass = 0, fail = 0;
const t = (n, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  ok ? pass++ : fail++;
  console.log((ok ? '  PASS ' : '  FAIL ') + n + '  got=' + JSON.stringify(got) + ' want=' + JSON.stringify(want));
};

const H = (n) => n * 3600;
const hist = (...pairs) => pairs.map(([status, at]) => ({ status, first_seen_unix: at }));
const P = { id: '13142', name: 'Test Player' };
const et = (iso) => Math.floor(Date.parse(iso) / 1000);

// A real 2026 week, so the DST offset is the genuine EDT one rather than a
// number I picked. Week 2: Thu Sep 17, Sun Sep 20, Mon Sep 21.
const THU = et('2026-09-17T20:15:00-04:00');
const SUN1 = et('2026-09-20T13:00:00-04:00');
const SNF = et('2026-09-20T20:20:00-04:00');
const MNF = et('2026-09-21T20:15:00-04:00');
const SAT8 = et('2026-09-19T20:00:00-04:00');

const MARK = SUN1 - INJURY_NOTICE_SECONDS;   // Sat 1:00pm ET
// Default: polling covered the whole week, so coverage is never why a case
// passes unless a test says so.
const ctx = (o) => ({ kickoffUnix: SUN1, observedFromUnix: SUN1 - H(168), ...o });

console.log('\n-- status normalization --');
t('Out', normalizeInjuryStatus('Out'), 'OUT');
t('Doubtful', normalizeInjuryStatus('Doubtful'), 'DOUBTFUL');
t('Questionable', normalizeInjuryStatus('Questionable'), 'QUESTIONABLE');
t('IR', normalizeInjuryStatus('IR'), 'IR');
t('empty is ACTIVE', normalizeInjuryStatus(''), 'ACTIVE');
// Only OUT and DOUBTFUL can fine anybody, so anything unrecognized must land on
// the harmless side of the fence.
t('garbage is ACTIVE, never OUT', normalizeInjuryStatus('¯\\_(ツ)_/¯'), 'ACTIVE');

console.log('\n-- statusAsOf reads the past, not the present --');
t('nothing seen yet', statusAsOf(hist(['OUT', MARK + H(1)]), MARK), null);
t('exactly at the mark counts', statusAsOf(hist(['OUT', MARK]), MARK), 'OUT');
t('latest prior status wins', statusAsOf(hist(['QUESTIONABLE', MARK - H(48)], ['OUT', MARK - H(2)]), MARK), 'OUT');
t('a later upgrade is invisible at the mark', statusAsOf(hist(['OUT', MARK - H(2)], ['ACTIVE', MARK + H(6)]), MARK), 'OUT');

console.log('\n-- §1 the core timing cases (Keith: "correct on all") --');
t('1. Out Friday, Sunday game -> violation',
  evaluateStarter(P, ctx({ history: hist(['OUT', MARK - H(20)]) })).verdict, 'violation');
t('2. Out Sat 6pm, Sunday 1pm game -> advisory',
  evaluateStarter(P, ctx({ history: hist(['OUT', SUN1 - H(19)]) })).verdict, 'advisory');
t('3. Questionable all week then Out 90min before -> advisory',
  evaluateStarter(P, ctx({ history: hist(['QUESTIONABLE', MARK - H(40)], ['OUT', SUN1 - 5400]) })).verdict, 'advisory');
t('4. Doubtful Friday, does not play -> violation',
  evaluateStarter(P, ctx({ history: hist(['DOUBTFUL', MARK - H(20)], ['OUT', SUN1 - H(1)]) })).verdict, 'violation');
t('5. Doubtful Friday, plays -> clean',
  evaluateStarter(P, ctx({ history: hist(['DOUBTFUL', MARK - H(20)]) })).verdict, 'clean');

console.log('\n-- §6 Out then upgraded and played: NEVER a penalty (Keith) --');
// "no this would never be a penalty. Upgraded Sun AM is inside the window."
const upgraded = evaluateStarter(P, ctx({ history: hist(['OUT', MARK - H(20)], ['ACTIVE', SUN1 - H(4)]) }));
t('verdict', upgraded.verdict, 'clean');
t('reason', upgraded.reason, 'upgraded_and_played');
t('and never flagged for review', !!upgraded.needs_review, false);

console.log('\n-- §7 Doubtful at the mark, Out late, did not play -> violation --');
t('the Doubtful branch governs, not the late Out',
  evaluateStarter(P, ctx({ history: hist(['DOUBTFUL', MARK - H(2)], ['OUT', SUN1 - H(1)]) })).reason,
  'doubtful_did_not_play');

console.log('\n-- §8 IR is treated exactly as Out (Keith) --');
t('IR with notice -> violation', evaluateStarter(P, ctx({ history: hist(['IR', MARK - H(10)]) })).verdict, 'violation');
// "unless it's a late IR submission" — the anchor already handles that.
t('late IR -> advisory', evaluateStarter(P, ctx({ history: hist(['IR', SUN1 - H(3)]) })).verdict, 'advisory');

console.log('\n-- §9a no eligible replacement, no penalty (Keith) --');
t('Out but nobody to sub in -> advisory',
  evaluateStarter(P, ctx({ history: hist(['OUT', MARK - H(20)]), replacementAvailable: false })).verdict, 'advisory');
t('reason', evaluateStarter(P, ctx({ history: hist(['OUT', MARK - H(20)]), replacementAvailable: false })).reason, 'no_replacement');
t('Doubtful-no-play with nobody to sub in -> advisory',
  evaluateStarter(P, ctx({ history: hist(['DOUBTFUL', MARK - H(20)], ['OUT', SUN1 - H(1)]), replacementAvailable: false })).verdict, 'advisory');
// Unchecked is NOT the same as "there was none" — it must not silently excuse.
t('undefined does not excuse',
  evaluateStarter(P, ctx({ history: hist(['OUT', MARK - H(20)]) })).verdict, 'violation');

console.log('\n-- §9b the Saturday 8pm ET cap (Keith\'s MNF rule) --');
t('Sunday game is capped by Saturday 8pm', saturdayCapUnix(SUN1), SAT8);
t('MNF is capped by the same Saturday', saturdayCapUnix(MNF), SAT8);
t('Thursday game has no cap', saturdayCapUnix(THU), null);
// The cap can only ever move the mark EARLIER, never later.
t('Sunday 1pm mark stays at kickoff-24h', noticeMarkUnix(SUN1), SUN1 - INJURY_NOTICE_SECONDS);
t('MNF mark moves back to Saturday 8pm', noticeMarkUnix(MNF), SAT8);
t('SNF mark is capped too', noticeMarkUnix(SNF), SAT8);
t('Thursday mark is plain 24h', noticeMarkUnix(THU), THU - INJURY_NOTICE_SECONDS);
t('the cap is never later than the plain mark', noticeMarkUnix(MNF) <= MNF - INJURY_NOTICE_SECONDS, true);

// Keith's worked example: MNF player declared Out Sunday 4pm. Under a plain
// 24-hour rule the mark is Sunday 8:15pm, so Sunday 4pm would be a violation —
// but by then your whole roster has played and locked.
const mnfCtx = (o) => ({ kickoffUnix: MNF, observedFromUnix: MNF - H(168), ...o });
t('MNF player ruled Out Sunday 4pm -> NOT a violation',
  evaluateStarter(P, mnfCtx({ history: hist(['OUT', et('2026-09-20T16:00:00-04:00')]) })).verdict, 'advisory');
t('MNF player ruled Out Friday -> still a violation',
  evaluateStarter(P, mnfCtx({ history: hist(['OUT', et('2026-09-18T12:00:00-04:00')]) })).verdict, 'violation');
t('MNF violation copy names the Saturday deadline',
  /Sat 8pm ET/.test(evaluateStarter(P, mnfCtx({ history: hist(['OUT', et('2026-09-18T12:00:00-04:00')]) })).detail), true);

console.log('\n-- bye weeks ignore the injury clock entirely --');
t('bye is a violation', evaluateStarter(P, ctx({ onBye: true, history: [] })).verdict, 'violation');
// Byes are published months ahead, so a bye must fire even with zero coverage.
t('bye fires with no polling at all',
  evaluateStarter(P, { kickoffUnix: SUN1, onBye: true, observedFromUnix: 0, history: [] }).verdict, 'violation');

console.log('\n-- it refuses to guess --');
t('polling started after the mark -> unknown',
  evaluateStarter(P, { kickoffUnix: SUN1, observedFromUnix: MARK + H(2), history: [] }).verdict, 'unknown');
t('no kickoff resolved -> unknown',
  evaluateStarter(P, { kickoffUnix: 0, observedFromUnix: SUN1 - H(168), history: [] }).verdict, 'unknown');
// A designation we DID see is real evidence even if coverage began late.
t('late coverage that still caught an OUT -> violation',
  evaluateStarter(P, { kickoffUnix: SUN1, observedFromUnix: MARK + H(2), history: hist(['OUT', MARK - H(1)]) }).verdict, 'violation');

console.log('\n-- §11 "did not play" is injury status and nothing else (Keith) --');
// Still Out at kickoff = did not play. Anything else = played. No snap counts,
// no fantasy points — a 0-point active player is indistinguishable from an
// inactive one by score, and distinguishable by status.
t('still Out at kickoff -> did not play', evaluateStarter(P, ctx({ history: hist(['OUT', MARK - H(6)]) })).reason, 'out');
t('upgraded before kickoff -> played', evaluateStarter(P, ctx({ history: hist(['OUT', MARK - H(6)], ['QUESTIONABLE', SUN1 - H(2)]) })).verdict, 'clean');

console.log('\n-- §10 a short lineup is judged at END OF WEEK, not at kickoff --');
const shortMid = evaluateLineup([{ id: '1', name: 'A' }], () => ctx({ history: [] }), { requiredStarters: 3, final: false });
const shortEnd = evaluateLineup([{ id: '1', name: 'A' }], () => ctx({ history: [] }), { requiredStarters: 3, final: true });
t('mid-week it is only an advisory', shortMid.verdict, 'advisory');
t('mid-week copy says it is fixable', /still fixable/.test(shortMid.lines[0].detail), true);
t('at week end it is a violation', shortEnd.verdict, 'violation');
t('counted once, not per empty slot', shortEnd.violations.length, 1);
t('default required is 18', REQUIRED_STARTERS, 18);

console.log('\n-- §14 one violation per week, however many bad starters --');
const many = evaluateLineup(
  [{ id: '1', name: 'A' }, { id: '2', name: 'B' }, { id: '3', name: 'C' }],
  () => ctx({ history: hist(['OUT', MARK - H(20)]) }),
  { requiredStarters: 3 });
t('one weekly verdict', many.verdict, 'violation');
t('all three still listed for the DM', many.violations.length, 3);

console.log('\n-- a clean week is clean, and advisories never outrank a violation --');
t('clean', evaluateLineup([{ id: '1', name: 'A' }], () => ctx({ history: hist(['QUESTIONABLE', MARK - H(30)]) }), { requiredStarters: 1 }).verdict, 'clean');
const mixed = evaluateLineup(
  [{ id: '1', name: 'Real' }, { id: '2', name: 'Late' }],
  (p) => p.id === '1' ? ctx({ history: hist(['OUT', MARK - H(20)]) }) : ctx({ history: hist(['OUT', SUN1 - H(2)]) }),
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
t('nothing escalates past expulsion', lineupLadderRung(6).membership, 'expulsion');
t('label reads plainly', lineupLadderLabel(2), '2nd violation — 4th-round pick + $5K next season');

console.log('\n-- §H: the two DMs must not read alike --');
const dmV = composeLineupDm({ franchiseName: 'Team', week: 3, result: many, windowLabel: 'Sun 1:00pm' });
const dmA = composeLineupDm({ franchiseName: 'Team', week: 3, result: { ...mixed, verdict: 'advisory', violations: [] }, windowLabel: 'Sun 1:00pm' });
t('violation DM says so', /Possible lineup violation/.test(dmV), true);
t('advisory DM says NOT a violation', /not a violation/i.test(dmA), true);
t('advisory DM never claims a violation', /Possible lineup violation/.test(dmA), false);
t('violation DM explains the 24-hour rule', /24 hours/.test(dmV), true);

console.log('\n' + (fail ? 'FAILURES: ' + fail : 'ALL ' + pass + ' PASS'));
process.exit(fail ? 1 : 0);
