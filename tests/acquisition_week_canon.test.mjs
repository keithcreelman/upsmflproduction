// The 18-W earning window is the length of the CONTRACT, not the length of
// your ownership.
//   node tests/acquisition_week_canon.test.mjs
//
// A waiver/FCFS/auction pickup in Week 9 gets a 9-week denominator because his
// contract BEGINS in Week 9 -- its TCV only ever covered Weeks 9-17 and nobody
// paid him for Weeks 1-8 under it. A trade creates no contract: the deal has
// been running since Week 1, its TCV covers the whole season, and the earning
// clock keeps running straight through the trade.
//
// This file exists because I got that backwards on 2026-08-16. Canon D1 line
// 574 listed "trade" beside WW/FCFS, so I parsed trades as acquisitions and
// called the old behavior an undercharge bug. Keith: "the 1st 9 weeks were
// paid and therefore the new owner wouldn't owe. So it's essentially the
// same." He is right, and resetting the window would have OVERCHARGED --
// erasing the salary the sending team already paid against the same guarantee
// and billing the receiving team for it twice.
//
// The cost of getting it wrong, on a $25K deal cut after Week 12 ($18,750
// guaranteed): $1,103 when one owner holds him the whole way, $9,375 if he
// changed hands in Week 10. An $8,272 surcharge for the identical player cut
// on the identical day, owed only because the contract moved -- a tax on
// exactly the deadline trades the league wants. It also contradicts G7.6
// ("you inherit the contract as you received it"): as received means with
// 12/17 already earned.
//
// So these are REGRESSION GUARDS, not feature tests. If a trade ever starts
// producing an entry in this map, something re-introduced the overcharge.
import fs from 'fs';
const src=fs.readFileSync('worker/src/index.js','utf8');
const grab=(s,e)=>{const i=src.indexOf(s);const j=src.indexOf(e,i);return src.slice(i,j+e.length);};
const fn=grab('const _acquisitionWeekMapFromTxs =','  return map;\n};');
const prelude=`
const _s=(v)=>String(v==null?"":v).trim();
const _nflWeek1Iso=(y)=>{y=Number(y)||0;if(!y)return "";const s=new Date(Date.UTC(y,8,1));const fm=1+((8-s.getUTCDay())%7);return new Date(Date.UTC(y,8,fm+3)).toISOString().slice(0,10);};
const _nflWeekForUnix=(u,y)=>{const w=_nflWeek1Iso(y);if(!w||!u)return 0;const s=new Date(w+"T00:00:00Z").getTime()/1000;if(u<s)return 0;const k=Math.floor((u-s)/(7*86400))+1;return (k>=1&&k<=17)?k:0;};
`;
fs.writeFileSync('/tmp/_acq.mjs', prelude+fn+"\nexport {_acquisitionWeekMapFromTxs,_nflWeek1Iso};");
const {_acquisitionWeekMapFromTxs,_nflWeek1Iso}=await import('/tmp/_acq.mjs?'+fs.statSync('worker/src/index.js').mtimeMs);

let pass=0,fail=0;
const t=(n,g,w)=>{const ok=JSON.stringify(g)===JSON.stringify(w);ok?pass++:fail++;
  console.log((ok?'  PASS ':'  FAIL ')+n+'  got='+JSON.stringify(g)+' want='+JSON.stringify(w));};

const wk = (y,w)=>{const s=new Date(_nflWeek1Iso(y)+"T00:00:00Z").getTime()/1000; return Math.floor(s+(w-1)*7*86400+3600);};
const trade={type:'TRADE',timestamp:String(wk(2026,10)),
  franchise:'0008',franchise2:'0012',
  franchise1_gave_up:'15808,FP_0008_2027_5,',franchise2_gave_up:'13142,'};

console.log('\n-- a trade must NOT reset the earning window --');
t('trade alone yields no acquisition week', _acquisitionWeekMapFromTxs([trade],2026), {});
t('a 3-way-ish multi-player trade is still inert',
  _acquisitionWeekMapFromTxs([{...trade,franchise1_gave_up:'15808,13142,FP_0001_2028_1,'}],2026), {});

console.log('\n-- the original contract start is what survives a trade --');
// 15808 signed as a Week-3 free agent, then changed hands in Week 10. His
// contract still began in Week 3, so the denominator stays 18-3 = 15.
t('week-3 signing survives a later trade',
  _acquisitionWeekMapFromTxs([{type:'FREE_AGENT',timestamp:String(wk(2026,3)),transaction:'15808,|'},
                              trade],2026),
  {'15808':3});
t('transaction ordering does not matter',
  _acquisitionWeekMapFromTxs([trade,
                              {type:'FREE_AGENT',timestamp:String(wk(2026,3)),transaction:'15808,|'}],2026),
  {'15808':3});
// A player acquired at auction or before Week 1 is absent from the map
// entirely, so trading him leaves him on the full 17-week window.
t('preseason contract stays absent after a trade',
  _acquisitionWeekMapFromTxs([{type:'AUCTION_WON',timestamp:String(wk(2026,1)),transaction:'15808,|'},
                              trade],2026), {});

console.log('\n-- a genuinely new contract still opens a new window --');
t('week-5 free agent', _acquisitionWeekMapFromTxs([{type:'FREE_AGENT',timestamp:String(wk(2026,5)),transaction:'99999,|'}],2026), {'99999':5});
t('blind-bid waiver claim', _acquisitionWeekMapFromTxs([{type:'BBID_WAIVER',timestamp:String(wk(2026,7)),transaction:'99999,|'}],2026), {'99999':7});
// Re-signing the same player later in the season IS a new contract, so the
// later window wins. This is the one case where "latest wins" is correct.
t('later re-signing opens the later window',
  _acquisitionWeekMapFromTxs([{type:'FREE_AGENT',timestamp:String(wk(2026,3)),transaction:'99999,|'},
                              {type:'FREE_AGENT',timestamp:String(wk(2026,11)),transaction:'99999,|'}],2026),
  {'99999':11});

console.log('\n'+(fail?'FAILURES: '+fail:'ALL '+pass+' PASS'));
process.exit(fail?1:0);
