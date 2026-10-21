// Cap-penalty math vs canon's own worked examples.
//   node tests/cap_penalty_canon.test.mjs
// Extracts _parseContractData / _computeDropPenalty out of worker/src/index.js by
// text rather than importing, because index.js is a Workers module with top-level
// bindings. If those functions are renamed this file fails loudly, which is the
// intent — it should never silently stop testing.
// Extract _parseContractData + _computeDropPenalty from the worker and exercise
// them against canon's own worked examples. Text extraction (not import) because
// index.js is a Workers module with top-level env bindings.
import fs from 'fs';
import { taxiEligibility } from '../worker/src/taxi_rule.js';
const src = fs.readFileSync('worker/src/index.js','utf8');

function grab(startMarker, endMarker){
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('not found: '+startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('end not found for '+startMarker);
  return src.slice(i, j+endMarker.length);
}
const parseFn = grab('const _parseContractData =', 'return { tcv, cl, aav, cy, yearsRemaining, yearsPlayed, yearSalaries, earned, priorEarned, currentYearEarned, weekAuthorityUnresolved, eligibleWeeks, currentYearSalary };\n        };');
const compFn  = grab('const _computeDropPenalty =', 'return { ...ctx, guaranteed, penalty, basis: "guarantee_minus_earned", exempt: false, exempt_reason: "" };\n        };');

const prelude = `
import { applyFullYearRule, classifyWwEarnedNa, isSubFiveKMultiYearFlat, WW_EARNED_NA_BASIS } from "${new URL('../worker/src/fcfs_contract.js', import.meta.url).href}";
import { taxiEligibility, taxiCutVerdict } from "${new URL('../worker/src/taxi_rule.js', import.meta.url).href}";
const safeStr=(v)=>v==null?"":String(v);
const safeInt=(v,d)=>{const n=Number(v);return Number.isFinite(n)?Math.trunc(n):(d||0);};
const _nflWeekForUnix=()=>0;
const _s=(v)=>String(v==null?"":v).trim();
// real production helpers, copied verbatim so the test exercises real behavior
const _nflWeek1Iso=(year)=>{const y=Number(year)||0;if(!y)return "";const sept1=new Date(Date.UTC(y,8,1));const firstMonday=1+((8-sept1.getUTCDay())%7);const kickoff=new Date(Date.UTC(y,8,firstMonday+3));return kickoff.toISOString().slice(0,10);};
`;
const mod = prelude + parseFn + "\n" + compFn + "\nexport {_computeDropPenalty};";
fs.writeFileSync('/tmp/_extracted.mjs', mod);
const { _computeDropPenalty } = await import('/tmp/_extracted.mjs');

let pass=0, fail=0;
const t=(name, got, want)=>{
  const ok = got===want;
  ok?pass++:fail++;
  console.log((ok?'  PASS ':'  FAIL ')+name+'  got='+got+' want='+want);
};

console.log('\n-- canon cut-penalty worked examples (rulebook `cutting`) --');
// 3yr $30K veteran cut in March of yr2 -> TCV 90K, earned 30K, penalty 37.5K
t('3yr $30K, cut yr2',
  _computeDropPenalty({contractStatus:'Veteran',salary:30000,
    contractInfo:'CL 3| TCV 90K| AAV 30K| Y1-30K, Y2-30K, Y3-30K',contractYear:'2'},{}).penalty, 37500);

// front-loaded 40/30/20 cut in March of yr2 -> earned = actual Y1 40K
t('front-loaded 40/30/20, cut yr2',
  _computeDropPenalty({contractStatus:'Veteran',salary:30000,
    contractInfo:'CL 3| TCV 90K| AAV 30K| Y1-40K, Y2-30K, Y3-20K',contractYear:'2'},{}).penalty, 27500);

console.log('\n-- FIX: sub-$5K multi-year must be a FLAT $1K (canon D1 "overrides entirely") --');
const sub=(cy)=>_computeDropPenalty({contractStatus:'Veteran',salary:1000,
  contractInfo:'CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K',contractYear:String(cy)},{});
t('CL3 $1K/yr cut yr1 (remaining 3)', sub(3).penalty, 1000);
t('CL3 $1K/yr cut yr2 (remaining 2)', sub(2).penalty, 1000);  // Tanner McKee
t('CL3 $1K/yr final year (remaining 1)', sub(1).penalty, 0);
t('1-year sub-$5K deal is cap-free',
  _computeDropPenalty({contractStatus:'Veteran',salary:4000,
    contractInfo:'CL 1| TCV 4K| AAV 4K| Y1-4K',contractYear:'1'},{}).penalty, 0);

console.log('\n-- FIX: flat $1K must NOT drift with in-season earning --');
// same contract, mid-season drop date. Pre-fix this netted to ~$412.
// completedPayableWeeks now required alongside dropDateIso (post week-authority
// fix) — 2026 Week 1 opens 2026-09-09; floor((Nov 15 − Sep 9)/7) = 9 completed
// weeks. Without this the request now fails closed (basis
// "week_authority_unresolved") rather than silently guessing — see the new
// resolveCompletedPayableWeeks tests below for that behavior.
const mid = _computeDropPenalty({contractStatus:'Veteran',salary:1000,
  contractInfo:'CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K',contractYear:'2'},
  {dropDateIso:'2026-11-15T00:00:00Z', season:'2026', completedPayableWeeks:9, week1ThursdayIso:'2026-09-09'});
t('CL3 $1K/yr yr2, mid-season drop', mid.penalty, 1000);

console.log('\n-- Keith 2026-10-21 (T5.2 / §D2): cap-free protection follows TAXI ELIGIBILITY, not the roster slot --');
// taxiCut = _taxiCutContextMap's inputs as of the cut; the pricing asks the ONE taxi rule (worker/src/taxi_rule.js).
const cut = (o) => ({ season: 2026, upsRound: 3, upsYear: 2025, draftKnown: true, used: 0, pending: 0, permanent: false, ...o });
const taxiInput={contractStatus:'Rookie-Draft',salary:2000,
  contractInfo:'CL 3| TCV 6K| AAV 2K| Y1-2K, Y2-2K, Y3-2K',contractYear:'3'};
const onTaxi = _computeDropPenalty({...taxiInput,isTaxi:true,taxiCut:cut()},{});
t('eligible, cut from the TAXI SQUAD: $0', onTaxi.penalty, 0); t('  basis', onTaxi.basis, 'taxi_exempt');
const active = _computeDropPenalty({...taxiInput,isTaxi:false,taxiCut:cut()},{});
t('eligible, cut from the ACTIVE ROSTER (never on taxi): $0', active.penalty, 0); t('  basis', active.basis, 'taxi_eligible_exempt');
const callup = _computeDropPenalty({...taxiInput,isTaxi:false,taxiCut:cut({used:2})},{});
t('eligible, cut during a TEMPORARY CALL-UP (2 used): $0', callup.penalty, 0); t('  basis', callup.basis, 'taxi_callup_exempt');
t('  … with 3 used (the last temporary one): $0', _computeDropPenalty({...taxiInput,taxiCut:cut({used:3})},{}).penalty, 0);
t('  … and the release ends eligibility (said on the row)', /release ends his taxi eligibility/.test(active.exempt_reason), true);
t('legacy "Rookie" spelling is the entry contract too', _computeDropPenalty({...taxiInput,contractStatus:'Rookie',taxiCut:cut({used:1})},{}).basis, 'taxi_callup_exempt');

console.log('\n-- after the release: re-acquired, the player is never eligible again (a fresh contract status) --');
const normal = _computeDropPenalty({...taxiInput,isTaxi:false},{}).penalty;
t('normal formula for this contract is not $0', normal > 0, true);
for (const st of ['Rookie-FAA','Vet-FAA','Rookie-WW','Vet-MYM']) {
  t('re-acquired ('+st+'), even on taxi: normal formula', _computeDropPenalty({...taxiInput,contractStatus:st,isTaxi:true,taxiCut:cut()},{}).penalty, normal);
  t('  and the rule says released', taxiEligibility({...cut(),contractStatus:st}).reason, 'released');
}

console.log('\n-- permanent promotion, an expired window or Round 1 never get the cap-free cut --');
t('4th activation (permanent): normal', _computeDropPenalty({...taxiInput,taxiCut:cut({used:4,permanent:true})},{}).penalty, normal);
t('marked / prior season ended active (permanent): normal, even on taxi', _computeDropPenalty({...taxiInput,isTaxi:true,taxiCut:cut({used:1,permanent:true})},{}).penalty, normal);
t('window ended (2023 draft), even on taxi: normal', _computeDropPenalty({...taxiInput,isTaxi:true,taxiCut:cut({upsYear:2023})},{}).penalty, normal);
t('Round 1: normal', _computeDropPenalty({...taxiInput,taxiCut:cut({upsRound:1})},{}).penalty, normal);
t('converted contract (MYAC / extension): normal', _computeDropPenalty({...taxiInput,contractStatus:'Rookie-Ext',taxiCut:cut()},{}).penalty, normal);

console.log('\n-- unreadable history, draft or verdict: HELD (penalty null), never a guessed $0 or charge --');
for (const [label, c] of [['call-up history / prior rosters unknown', cut({permanent:null})], ['UPS draft unreadable', cut({draftKnown:false})]]) {
  const h = _computeDropPenalty({...taxiInput,taxiCut:c},{});
  t(label+': penalty null', h.penalty, null); t('  basis', h.basis, 'week_authority_unresolved'); t('  hold reason', h.hold_reason, 'taxi_history_unresolved');
  t('  says it is not $0', /NOT a \$0/.test(h.review_reason), true);
}
t('on taxi with no verdict supplied: HELD, not $0', _computeDropPenalty({...taxiInput,isTaxi:true},{}).penalty, null);

console.log('\n-- the exemption never leaks to veterans --');
const vet = {contractStatus:'Veteran',salary:30000,contractInfo:'CL 3| TCV 90K| AAV 30K| Y1-30K, Y2-30K, Y3-30K',contractYear:'2'};
t('veteran, no verdict: normal', _computeDropPenalty({...vet,isTaxi:false},{}).penalty, 37500);
t('veteran with an eligible-looking verdict: normal', _computeDropPenalty({...vet,isTaxi:false,taxiCut:cut()},{}).penalty, 37500);
t('veteran with an unknown verdict: normal (never held)', _computeDropPenalty({...vet,isTaxi:false,taxiCut:cut({permanent:null})},{}).penalty, 37500);

console.log('\n-- Kyle Williams (0007): 2025 2.08, permanently promoted (active at the end of 2025) --');
// 75% x $15K = $11,250 − ($5,000 in 2025 + 5/17 x $5,000) = $4,779.
const kyle = {contractStatus:'Rookie-Draft',salary:5000,contractInfo:'CL 3| TCV 15K| AAV 5K| Y1-5K, Y2-5K, Y3-5K| GTD: 11.3K',contractYear:'2',isTaxi:false};
const kOpts = {dropDateIso:'2026-10-16T12:00:00Z', season:'2026', completedPayableWeeks:5, week1ThursdayIso:'2026-09-09'};
t('permanent: $4,779', _computeDropPenalty({...kyle,taxiCut:cut({used:1,permanent:true})},kOpts).penalty, 4779);
t('if he were still eligible it would be $0', _computeDropPenalty({...kyle,taxiCut:cut({used:1})},kOpts).penalty, 0);

console.log('\n'+(fail? 'FAILURES: '+fail : 'ALL '+pass+' PASS'));
process.exit(fail?1:0);
