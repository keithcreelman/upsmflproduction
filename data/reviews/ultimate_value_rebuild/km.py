#!/usr/bin/env python3
"""Kaplan-Meier spell-survival + extension-branching transition matrix.

Handles right-censoring correctly (the long-lived stars are all censored, so
naive averaging of completed spells is severely downward-biased). Produces:
  - E[total years under contract] by (pos, entry ADP tier), with conditional
    E[remaining | already survived t years]
  - the extension branching Keith asked for (2yr then +1 vs +2 vs walk)
"""
import csv, os, json
from collections import defaultdict
SD=os.environ["SD"]
rows=list(csv.DictReader(open(f"{SD}/contract_spells.csv")))
for r in rows:
    r['length']=int(r['length_seasons']); r['cens']=r['censored']=='1'
    r['nExt']=int(r['n_extensions'])
    r['terms']=[t for t in (r['ext_terms'].split('|') if r['ext_terms'] else [])]
    r['ext_seasons']=[int(x) for x in (r['ext_seasons'].split('|') if r['ext_seasons'] else [])]

def km(spells, tmax=9):
    """Discrete Kaplan-Meier. Returns S[t]=P(length>t), t=0..tmax, and restricted mean."""
    S=[1.0]*(tmax+1)
    surv=1.0
    for t in range(1,tmax+1):
        at_risk=sum(1 for s in spells if s['length']>=t)
        events =sum(1 for s in spells if s['length']==t and not s['cens'])
        if at_risk>0:
            surv*= (1 - events/at_risk)
        S[t]=surv
    # E[length] restricted to tmax: sum_{t=0}^{tmax-1} S[t] (P(L>t)); L>=1 always
    E=sum(S[0:tmax])
    return S,E

def cond_expected_remaining(spells, elapsed, tmax=9):
    """E[additional years | already survived `elapsed` years] via KM conditioning."""
    S,_=km(spells,tmax)
    base=S[elapsed] if elapsed<=tmax else S[tmax]
    if base<=0: return 0.0
    # E[remaining] = sum_{t>elapsed} S[t]/S[elapsed]
    return sum(S[t]/base for t in range(elapsed+1, tmax+1))

print("=== Kaplan-Meier: expected TOTAL years under contract from entry, by pos x entry ADP tier ===")
print("   (levels the market via canonical positional tag tiers on entry ADP rank)\n")
print(f"  {'cohort':14s} {'n':>4s} {'cens%':>6s}  E[yrs]  cond E[remaining | survived t]")
grp=defaultdict(list)
for r in rows:
    if r['tier'] and r['pos'] in ('QB','RB','WR','TE') and r['entry_type'] in ('ROOKIE','FAA','ERA','AUC'):
        grp[(r['pos'],r['tier'])].append(r)
km_by={}
for (pos,tier) in sorted(grp):
    sp=grp[(pos,tier)]
    if len(sp)<8: continue
    S,E=km(sp)
    censpct=100*sum(1 for s in sp if s['cens'])/len(sp)
    conds=[f"t={t}:{cond_expected_remaining(sp,t):.2f}" for t in (1,2,3)]
    km_by[(pos,tier)]=dict(S=S,E=E,n=len(sp))
    print(f"  {pos+' '+tier:14s} {len(sp):>4d} {censpct:>5.0f}%  {E:5.2f}   "+"  ".join(conds))

# pooled by position (all tiers) for fallback
print("\n=== KM pooled by position (all tiers, rookie+auction entries) ===")
for pos in ('QB','RB','WR','TE'):
    sp=[r for r in rows if r['pos']==pos and r['entry_type'] in ('ROOKIE','FAA','ERA','AUC') and r['tier']]
    S,E=km(sp)
    km_by[(pos,'ALL')]=dict(S=S,E=E,n=len(sp))
    print(f"  {pos}: n={len(sp)} E[yrs]={E:.2f}  S(1..5)="+",".join(f"{S[t]:.2f}" for t in range(1,6)))

# ROOKIE-ONLY cohorts (McMillan-relevant): rookie WRs by tier
print("\n=== ROOKIE-entry cohorts (McMillan-relevant), by pos x tier ===")
rk_by={}
for pos in ('QB','RB','WR','TE'):
    for tier in ('T1','T2','T3','T4'):
        sp=[r for r in rows if r['pos']==pos and r['entry_type']=='ROOKIE' and r['tier']==tier]
        if len(sp)<5: continue
        S,E=km(sp)
        rk_by[(pos,tier)]=dict(S=S,E=E,n=len(sp))
        cens=100*sum(1 for s in sp if s['cens'])/len(sp)
        print(f"  {pos} {tier} rookie: n={len(sp):3d} cens={cens:.0f}%  E[total yrs]={E:.2f}  E[remaining|survived3]={cond_expected_remaining(sp,3):.2f}")

# ---- EXTENSION BRANCHING (Keith's core ask) ----
# Chain each player's extension events; term uses extension_term_years, else EXT1/EXT2 from cs; unknown-> impute later.
print("\n=== EXTENSION BRANCHING — P(re-extended after Nth extension) ===")
# consider spells that got at least one extension; look at the sequence of terms
def term_norm(t):
    return t if t in ('1','2') else '?'
# Build ordered ext term list per spell
seqs=defaultdict(list)  # pos -> list of term-sequences
for r in rows:
    if r['nExt']>=1 and r['pos'] in ('QB','RB','WR','TE'):
        seqs[r['pos']].append([term_norm(t) for t in r['terms']])
for pos in ('WR','RB','TE','QB'):
    S=seqs[pos]
    n1=len(S)                       # reached >=1 ext
    n2=sum(1 for s in S if len(s)>=2)
    n3=sum(1 for s in S if len(s)>=3)
    # NOTE: reached >=1 ext denominator is spells-with-ext; the TRUE P(1st ext) is from decision-point model below
    print(f"  {pos}: spells w/ >=1 ext={n1}; of those, got a 2nd={n2}({100*n2/max(1,n1):.0f}%), a 3rd={n3}({100*n3/max(1,n2 if n2 else 1):.0f}% of those w/2nd)")

# ---- DECISION-POINT extension hazard from the rosters_weekly panel ----
import sqlite3
A=sqlite3.connect(f"{SD}/mfl_archive.db")
E2=sqlite3.connect(f"{SD}/ext_master.db")
# EOS state per (season,pid)
eos={}
q="""WITH e AS (SELECT season,player_id,position,franchise_id,contract_year,contract_status,salary,
       ROW_NUMBER() OVER(PARTITION BY season,player_id ORDER BY week DESC) rn
       FROM rosters_weekly WHERE season BETWEEN 2017 AND 2025)
     SELECT season,player_id,position,franchise_id,contract_year,contract_status,salary FROM e WHERE rn=1"""
for s,pid,pos,fid,cy,cs,sal in A.execute(q):
    eos[(int(s),str(pid))]=dict(pos=(pos or '').upper(),fid=fid,cy=cy,cs=cs or '',sal=sal)
# auction-won set per season (pool return signal)
aucset=defaultdict(set)
for s,pid in A.execute("SELECT season,player_id FROM transactions_auction WHERE auction_event_type='WON'"):
    aucset[int(s)].add(str(pid))
# ext_master player-seasons
extset=set()
for pid,s in E2.execute("SELECT player_id, CAST(season AS INT) FROM ups_extension_master"):
    extset.add((str(pid),s))
def cyint(x):
    try:return int(x)
    except:return None
# decision points: EOS cy==1
print("\n=== DECISION-POINT model: player in FINAL contracted year (EOS cy=1) -> next-season outcome ===")
print("   EXTENDED/TAGGED = on roster next yr & NOT re-auctioned; POOL = re-auctioned next yr or not rostered\n")
dp=defaultdict(lambda: defaultdict(int))
for (S,pid),d in eos.items():
    if S>=2025: continue
    if cyint(d['cy'])!=1: continue
    pos=d['pos']
    if pos not in ('QB','RB','WR','TE'): continue
    nd=eos.get((S+1,pid))
    reauc = pid in aucset.get(S+1,set())
    ext = (pid,S+1) in extset or (pid,S) in extset
    cs_next=(nd['cs'] if nd else '').upper()
    if 'TAG' in (d['cs'] or '').upper() or (nd and 'TAG' in cs_next):
        out='TAGGED'
    elif nd and not reauc:
        # retained under contract (extension or multiyear carry); classify extended if ext evidence or cy grew
        out='EXTENDED/RETAINED'
    else:
        out='POOL (expired/re-auctioned)'
    dp[pos][out]+=1
for pos in ('WR','RB','TE','QB'):
    tot=sum(dp[pos].values())
    if not tot: continue
    print(f"  {pos} (n={tot}): "+", ".join(f"{k}={v}({100*v/tot:.0f}%)" for k,v in sorted(dp[pos].items())))

json.dump({f"{k[0]}|{k[1]}":v for k,v in km_by.items()}, open(f"{SD}/km_params.json","w"), indent=0)
json.dump({f"{k[0]}|{k[1]}":v for k,v in rk_by.items()}, open(f"{SD}/rookie_km.json","w"))
print("\nwrote km_params.json, rookie_km.json")
A.close();E2.close()
