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
const src = fs.readFileSync('worker/src/index.js','utf8');

function grab(startMarker, endMarker){
  const i = src.indexOf(startMarker);
  if (i < 0) throw new Error('not found: '+startMarker);
  const j = src.indexOf(endMarker, i);
  if (j < 0) throw new Error('end not found for '+startMarker);
  return src.slice(i, j+endMarker.length);
}
const parseFn = grab('const _parseContractData =', 'return { tcv, cl, aav, cy, yearsRemaining, yearsPlayed, yearSalaries, earned, priorEarned, currentYearEarned };\n        };');
const compFn  = grab('const _computeDropPenalty =', 'return { ...ctx, guaranteed, penalty, basis: "guarantee_minus_earned", exempt: false, exempt_reason: "" };\n        };');

const prelude = `
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
const mid = _computeDropPenalty({contractStatus:'Veteran',salary:1000,
  contractInfo:'CL 3| TCV 3K| AAV 1K| Y1-1K, Y2-1K, Y3-1K',contractYear:'2'},
  {dropDateIso:'2026-11-15T00:00:00Z', season:'2026'});
t('CL3 $1K/yr yr2, mid-season drop', mid.penalty, 1000);

console.log('\n-- FIX: taxi cap-free cut survives a temporary call-up --');
const taxiInput={contractStatus:'Rookie',salary:2000,
  contractInfo:'CL 3| TCV 6K| AAV 2K| Y1-2K, Y2-2K, Y3-2K',contractYear:'3'};
t('on taxi at drop', _computeDropPenalty({...taxiInput,isTaxi:true},{}).penalty, 0);
t('mid call-up, never promoted', _computeDropPenalty({...taxiInput,isTaxi:false,taxiNeverPromoted:true},{}).penalty, 0);
console.log('    (pre-fix this charged floor(6000*0.75) = 4500)');

console.log('\n-- guard: the exemption must NOT leak to non-taxi players --');
t('no callup history -> normal formula',
  _computeDropPenalty({contractStatus:'Veteran',salary:30000,
    contractInfo:'CL 3| TCV 90K| AAV 30K| Y1-30K, Y2-30K, Y3-30K',contractYear:'2',
    isTaxi:false},{}).penalty, 37500);
t('taxiNeverPromoted undefined -> normal formula',
  _computeDropPenalty({contractStatus:'Veteran',salary:30000,
    contractInfo:'CL 3| TCV 90K| AAV 30K| Y1-30K, Y2-30K, Y3-30K',contractYear:'2',
    isTaxi:false,taxiNeverPromoted:undefined},{}).penalty, 37500);
t('taxiNeverPromoted falsy-but-truthy-ish "false" string -> normal',
  _computeDropPenalty({contractStatus:'Veteran',salary:30000,
    contractInfo:'CL 3| TCV 90K| AAV 30K| Y1-30K, Y2-30K, Y3-30K',contractYear:'2',
    isTaxi:false,taxiNeverPromoted:'false'},{}).penalty, 37500);

console.log('\n'+(fail? 'FAILURES: '+fail : 'ALL '+pass+' PASS'));
process.exit(fail?1:0);
