// Tag price + extension escalator vs the cases canon names by player.
//   node tests/tag_and_extension_canon.test.mjs
// Covers the surfaces that disagreed: the mobile submit path (which is what
// actually gets WRITTEN — the worker never re-derives a tag price), the roster
// workbench, and Front Office v2.
import fs from 'fs';
const safeInt=(v,d)=>{const n=Number(v);return Number.isFinite(n)?Math.trunc(n):(d||0);};
const safeStr=(v)=>v==null?"":String(v);
const roundToK=(n)=>Math.round((Number(n)||0)/1000)*1000;

let pass=0,fail=0;
const t=(n,g,w)=>{const ok=g===w;ok?pass++:fail++;console.log((ok?'  PASS ':'  FAIL ')+n+'  got='+g+' want='+w);};

function extractFn(file, name){
  const src=fs.readFileSync(file,'utf8');
  const re=new RegExp('(?:function\\s+'+name+'\\s*\\()','g');
  const m=re.exec(src); if(!m) throw new Error('no '+name+' in '+file);
  let i=src.indexOf('{', m.index), depth=0, j=i;
  for(;j<src.length;j++){ if(src[j]==='{')depth++; else if(src[j]==='}'){depth--; if(!depth){j++;break;}} }
  return src.slice(m.index, j);
}

console.log('\n== TAG PRICE: canon C8-A, bump base is the DEADLINE SNAPSHOT only ==');
for (const [label,file] of [['mobile submit','site/m/front_office_tag_submit.js'],
                            ['roster workbench','site/rosters/roster_workbench.js']]) {
  const fn=extractFn(file,'effectiveTagSalaryForRow');
  const f=new Function('safeInt','safeStr', fn+'; return effectiveTagSalaryForRow;')(safeInt,safeStr);
  // Malik Willis: deadline AAV $2K, claimed in-season for $37K, tier price $16K.
  // Canon says $16K. The bug priced him at $41K.
  t(label+' — Willis (deadline $2K, current $37K, tier $16K)',
    f({tag_base_bid:16000, tag_salary:16000, prior_aav_week1:2000, aav:37000, salary:37000, prior_salary_week1:2000}), 16000);
  // Kyler Murray, symmetric: high deadline AAV, cheap late re-sign -> snapshot still governs
  t(label+' — Murray (deadline $35K, current $8K, tier $16K)',
    f({tag_base_bid:16000, tag_salary:16000, prior_aav_week1:35000, aav:8000, salary:8000, prior_salary_week1:8000}), 39000);
  // Mahomes back-load: AAV $54K deadline, loaded Y2 salary $68K -> salary must not enter
  t(label+' — Mahomes BL (deadline AAV $54K, loaded salary $68K)',
    f({tag_base_bid:50000, tag_salary:50000, prior_aav_week1:54000, aav:54000, salary:68000, prior_salary_week1:68000}), 60000);
  // absent from the snapshot -> no baseline, tier price governs
  t(label+' — no deadline snapshot -> tier price',
    f({tag_base_bid:16000, tag_salary:16000, prior_aav_week1:0, aav:37000, salary:37000}), 16000);
}

console.log('\n== EXTENSION ESCALATOR: base is AAV, not loaded current-year salary ==');
for (const [label,file] of [['roster workbench','site/rosters/roster_workbench.js'],
                            ['front office v2','site/rosters/v2/front_office.js']]) {
  const src=fs.readFileSync(file,'utf8');
  const base=extractFn(file,'extensionAavBase');
  const proj=extractFn(file,'projectedExtensionSalary');
  const rates=`const EXTENSION_RATES={QB:{1:10000,2:20000},RB:{1:10000,2:20000},WR:{1:10000,2:20000},TE:{1:10000,2:20000},DL:{1:3000,2:5000},LB:{1:3000,2:5000},DB:{1:3000,2:5000},OTHER:{1:3000,2:5000}};
  function extensionRaiseForPlayer(p,y){y=safeInt(y,0);if(y!==1&&y!==2)return 0;const k=safeStr(p&&p.positionGroup).toUpperCase()||"OTHER";const r=EXTENSION_RATES[k]||EXTENSION_RATES.OTHER;return safeInt(r&&r[y],0);}
  function currentAavForContractInfo(){return 0;}`;
  const f=new Function('safeInt','safeStr','roundToK', rates+base+proj+'; return projectedExtensionSalary;')(safeInt,safeStr,roundToK);
  // Drake London: TCV 66K / CL 2 = 33K AAV, loaded to 52K current year. +1yr = 43K.
  t(label+' — Drake London loaded final year (+1yr)',
    f({positionGroup:'WR', aav:33000, salary:52000}, 1), 43000);
  t(label+' — flat contract unaffected (+1yr)',
    f({positionGroup:'WR', aav:25000, salary:25000}, 1), 35000);
  t(label+' — defense schedule (+2yr)',
    f({positionGroup:'LB', aav:12000, salary:12000}, 2), 17000);
  t(label+' — falls back to salary when no AAV',
    f({positionGroup:'WR', aav:0, salary:25000}, 1), 35000);
}

console.log('\n'+(fail?'FAILURES: '+fail:'ALL '+pass+' PASS'));
process.exit(fail?1:0);
