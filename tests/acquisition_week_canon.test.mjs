// Acquisition-week map vs canon D1 line 574 / 6.B, which list TRADE beside
// WW/FCFS as a mid-season pickup on the 18-W window.
//   node tests/acquisition_week_canon.test.mjs
// Trades were previously unparsed ("a known v1 gap" in the source), so a traded
// player was priced as if his new owner had held him since Week 1 -- which
// inflates earned and UNDERCHARGES. A $25K player traded Wk10 and cut Wk12 came
// out at $1,103 instead of $9,375.
// Trade parsing for the acquisition-week map (canon D1 line 574: a trade is a
// mid-season pickup on the 18-W window, same as WW/FCFS).
import fs from 'fs';
const src=fs.readFileSync('worker/src/index.js','utf8');
const grab=(s,e)=>{const i=src.indexOf(s);const j=src.indexOf(e,i);return src.slice(i,j+e.length);};
const helper=grab('const _tradePidsFromGaveUp =','/^\\d{3,6}$/.test(x));');
const fn=grab('const _acquisitionWeekMapFromTxs =','  return map;\n};');
const prelude=`
const _s=(v)=>String(v==null?"":v).trim();
const _nflWeek1Iso=(y)=>{y=Number(y)||0;if(!y)return "";const s=new Date(Date.UTC(y,8,1));const fm=1+((8-s.getUTCDay())%7);return new Date(Date.UTC(y,8,fm+3)).toISOString().slice(0,10);};
const _nflWeekForUnix=(u,y)=>{const w=_nflWeek1Iso(y);if(!w||!u)return 0;const s=new Date(w+"T00:00:00Z").getTime()/1000;if(u<s)return 0;const k=Math.floor((u-s)/(7*86400))+1;return (k>=1&&k<=17)?k:0;};
`;
fs.writeFileSync('/tmp/_acq.mjs', prelude+helper+"\n"+fn+"\nexport {_acquisitionWeekMapFromTxs,_tradePidsFromGaveUp,_nflWeek1Iso};");
const {_acquisitionWeekMapFromTxs,_tradePidsFromGaveUp,_nflWeek1Iso}=await import('/tmp/_acq.mjs');

let pass=0,fail=0;
const t=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?pass++:fail++;
  console.log((ok?'  PASS ':'  FAIL ')+n+'  got='+JSON.stringify(g)+' want='+JSON.stringify(w));};

console.log('\n-- pick ids must never be mistaken for player ids --');
t('FP_ pick tokens excluded', _tradePidsFromGaveUp('15808,FP_0008_2027_5,'), ['15808']);
t('picks only -> no players',  _tradePidsFromGaveUp('FP_0012_2027_4,'), []);
t('multiple players',          _tradePidsFromGaveUp('15808,13142,FP_0001_2028_1,'), ['15808','13142']);

console.log('\n-- a trade is an acquisition for BOTH sides --');
const wk = (y,w)=>{const s=new Date(_nflWeek1Iso(y)+"T00:00:00Z").getTime()/1000; return Math.floor(s+(w-1)*7*86400+3600);};
const trade={type:'TRADE',timestamp:String(wk(2026,10)),
  franchise:'0008',franchise2:'0012',
  franchise1_gave_up:'15808,FP_0008_2027_5,',franchise2_gave_up:'13142,'};
t('both traded players get week 10', _acquisitionWeekMapFromTxs([trade],2026), {'15808':10,'13142':10});

console.log('\n-- existing behavior must be unchanged --');
const fa={type:'FREE_AGENT',timestamp:String(wk(2026,5)),transaction:'99999,|'};
t('free agent still parsed', _acquisitionWeekMapFromTxs([fa],2026), {'99999':5});
t('preseason trade ignored (continuing window)',
  _acquisitionWeekMapFromTxs([{...trade,timestamp:String(wk(2026,1))}],2026), {});

console.log('\n-- latest acquisition wins (current owner) --');
// 15808 was a Week-3 free-agent add, then traded in Week 10 -> the LATER
// acquisition must win, because that is the current owner's window. 13142
// also lands at 10: the same trade acquires him for the other side.
t('later trade overrides earlier pickup',
  _acquisitionWeekMapFromTxs([{type:'FREE_AGENT',timestamp:String(wk(2026,3)),transaction:'15808,|'},
                              trade],2026),
  {'15808':10,'13142':10});
// and the reverse ordering must not matter
t('earlier pickup does not override a later trade',
  _acquisitionWeekMapFromTxs([trade,
                              {type:'FREE_AGENT',timestamp:String(wk(2026,3)),transaction:'15808,|'}],2026),
  {'15808':10,'13142':10});

console.log('\n'+(fail?'FAILURES: '+fail:'ALL '+pass+' PASS'));
process.exit(fail?1:0);
