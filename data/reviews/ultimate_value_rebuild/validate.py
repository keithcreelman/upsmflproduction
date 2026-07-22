#!/usr/bin/env python3
"""Task 3 validation:
 (A) Backtest the lifespan model: predict E[total years] for 2019-2021 entrants
     from their cohort KM, compare to REALIZED length (now observable through 2025).
 (B) Extension-branching transition matrix (Keith's exact ask), with sample sizes.
 (C) Trade-return signal: do positive contract-surplus (cheap-control) players fetch
     more assets in trades? Rank correlation, honestly caveated.
"""
import csv, os, json, sqlite3
from collections import defaultdict
SD=os.environ["SD"]
spells=list(csv.DictReader(open(f"{SD}/contract_spells.csv")))
for s in spells:
    s['length']=int(s['length_seasons']); s['cens']=s['censored']=='1'; s['es']=int(s['entry_season'])

# ---------- (A) backtest lifespan on older, now-complete cohorts ----------
# Build cohort KM from spells ENTERING <=2018 (fully observable), predict for 2019-2021 entrants,
# compare predicted E[len] to realized (their spells are mostly complete by 2025).
def km_E(sp, tmax=9):
    surv=1.0; S=[1.0]
    for t in range(1,tmax+1):
        ar=sum(1 for s in sp if s['length']>=t); ev=sum(1 for s in sp if s['length']==t and not s['cens'])
        if ar: surv*=(1-ev/ar)
        S.append(surv)
    return sum(S[:tmax])
train=[s for s in spells if s['es']<=2018 and s['pos'] in ('QB','RB','WR','TE') and s['tier']]
test =[s for s in spells if 2019<=s['es']<=2021 and s['pos'] in ('QB','RB','WR','TE') and s['tier'] and not s['cens']]
print("=== (A) Lifespan backtest: train entries<=2018, test 2019-2021 (completed) ===")
print(f"  {'cohort':10s}  {'pred E[len]':>10s}  {'realized mean':>13s}  n_test")
import statistics as st
for pos in ('QB','RB','WR','TE'):
    for tier in ('T1','T2','T3','T4'):
        tr=[s for s in train if s['pos']==pos and s['tier']==tier]
        te=[s for s in test if s['pos']==pos and s['tier']==tier]
        if len(tr)<8 or len(te)<5: continue
        pred=km_E(tr); real=st.mean([s['length'] for s in te])
        print(f"  {pos+' '+tier:10s}  {pred:10.2f}  {real:13.2f}  {len(te)}")
# pooled position check
print("  -- pooled by position --")
for pos in ('QB','RB','WR','TE'):
    tr=[s for s in train if s['pos']==pos]; te=[s for s in test if s['pos']==pos]
    if len(tr)<15 or len(te)<10: continue
    print(f"  {pos:10s}  {km_E(tr):10.2f}  {st.mean([s['length'] for s in te]):13.2f}  {len(te)}")

# ---------- (B) extension branching matrix ----------
print("\n=== (B) Extension branching (conditional transition probabilities) ===")
seqs=defaultdict(list)
for s in spells:
    if int(s['n_extensions'])>=1 and s['pos'] in ('QB','RB','WR','TE'):
        terms=[t for t in s['ext_terms'].split('|') if t]
        seqs[s['pos']].append(terms)
for pos in ('WR','RB','TE','QB'):
    S=seqs[pos]; n1=len(S)
    n2=sum(1 for x in S if len(x)>=2); n3=sum(1 for x in S if len(x)>=3)
    # term of FIRST extension (1yr vs 2yr) where known
    t1=[x[0] for x in S if x and x[0] in ('1','2')]
    d1=defaultdict(int)
    for t in t1: d1[t]+=1
    tot1=len(t1)
    print(f"  {pos}: reached 1st ext={n1} | P(2nd|1st)={n2/max(1,n1):.0%} | P(3rd|2nd)={n3/max(1,n2):.0%}"
          f" | 1st-ext term: 1yr={d1.get('1',0)/max(1,tot1):.0%} 2yr={d1.get('2',0)/max(1,tot1):.0%} (n_known={tot1})")

# ---------- (C) trade-return rank check ----------
print("\n=== (C) Trade-return signal: cheap-control surplus vs assets received ===")
A=sqlite3.connect(f"{SD}/mfl_archive.db")
# For each PLAYER acquired in a trade 2021-2025, count non-salary assets the acquirer gave up
# (i.e., assets released by the franchise that received this player, in the same trade group).
rows=A.execute("""SELECT transactionid, season, franchise_id, asset_role, asset_type, player_id
                  FROM transactions_trades WHERE season BETWEEN 2021 AND 2025""").fetchall()
by_txn=defaultdict(list)
for tid,se,fid,role,atype,pid in rows:
    by_txn[(tid,se)].append(dict(fid=fid,role=role,atype=atype,pid=str(pid) if pid else None))
# EOS salary/contract at the season of trade to estimate "surplus proxy" = worth vs salary.
# Use rosters_weekly EOS salary + a rough worth from fa proxy not available historically ->
# instead use CHEAPNESS proxy: lower salary + more years remaining = more control. We correlate
# "years_remaining * (1/(salary+1))" style control score at trade time with assets received.
eos={}
for s,pid,cy,sal in A.execute("""WITH e AS(SELECT season,player_id,contract_year,salary,
      ROW_NUMBER() OVER(PARTITION BY season,player_id ORDER BY week DESC) rn FROM rosters_weekly)
      SELECT season,player_id,contract_year,salary FROM e WHERE rn=1"""):
    try: eos[(int(s),str(pid))]=(int(cy) if cy not in (None,'') else None, int(sal) if sal not in (None,'') else None)
    except: pass
pairs=[]
for (tid,se),assets in by_txn.items():
    # acquiring franchise of each player = the franchise whose role/asset_role marks ACQUIRE
    for a in assets:
        if a['atype']!='PLAYER' or not a['pid']: continue
        if (a['role'] or '').upper() not in ('ACQUIRE','ACQUIRED','ADD'): continue
        acq=a['fid']
        # assets given up by acq = assets in same txn with role RELEASE and fid==acq
        given=[b for b in assets if b['fid']==acq and (b['role'] or '').upper() in ('RELEASE','RELEASED','DROP')]
        n_assets=len([b for b in given if b['atype'] in ('PLAYER','DRAFT_PICK','FUTURE_PICK')])
        cy,sal=eos.get((se,a['pid']),(None,None))
        if cy is None or sal is None: continue
        control=cy/((sal/1000.0)+1.0)   # more yrs + cheaper = more control/surplus
        pairs.append((control,n_assets))
if len(pairs)>=30:
    import math
    # Spearman rank correlation
    def rank(v):
        order=sorted(range(len(v)),key=lambda i:v[i]); r=[0]*len(v)
        for i,o in enumerate(order): r[o]=i
        return r
    xs=[p[0] for p in pairs]; ys=[p[1] for p in pairs]
    rx=rank(xs); ry=rank(ys)
    n=len(pairs); mx=sum(rx)/n; my=sum(ry)/n
    num=sum((rx[i]-mx)*(ry[i]-my) for i in range(n))
    den=math.sqrt(sum((rx[i]-mx)**2 for i in range(n))*sum((ry[i]-my)**2 for i in range(n)))
    rho=num/den if den else 0
    print(f"  n_traded_players={n}  Spearman rho(control-surplus, assets_received)={rho:+.3f}")
    print(f"  (positive rho => cheaper/longer-control players fetch more assets, validating the surplus premium)")
else:
    print(f"  insufficient clean trade pairs ({len(pairs)}) for correlation")
A.close()
