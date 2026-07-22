#!/usr/bin/env python3
"""Rebuild UPS 'ultimate value' on a canonical + empirical basis.

ultimate = dynasty_raw + contract_surplus
  contracted years:  DISC^(t-1) * (ep*decay^(t-1) - ACTUAL_remaining_cash_t)   <- fixes London
  expected ext years: p_j * DISC^(cy+j-1) * (ep*decay^(cy+j-1) - escalated_AAV_cost)  <- Keith's core ask
Option value (pure optionality upside) is reported as a SEPARATE labeled band.

Canonical citations:
  AAV / escalation base .......... claude_canonical_rules RULE-TERM-001, RULE-CONTRACT-005 (TCV/CL for
                                   un-extended; escalated lineage AAV = baseline+Σraises for extended)
  Extension escalator ............ league_context C4 / T3.3: Sch1 QB/RB/WR/TE +10K(1yr)/+20K(2yr);
                                   Sch2 DL/LB/DB/K/P +3K/+5K
  Actual remaining cash .......... league_context C1: earned/cost tracks the YEAR'S actual salary, not AAV
  contractYear = years remaining . memory + RULE-CONTRACT-002
  DISC 0.90, decay by pos ........ TUNABLE — canon is silent; carried from the task spec, flagged.
"""
import json, csv, os, re, sqlite3
from collections import defaultdict
SD=os.environ["SD"]
REPO="/Users/keithcreelman/Code/MFL/upsmflproduction/.claude/worktrees/agent-a4b9155df12b50b16"
SNAP=f"{REPO}/data/mfl-snapshots/2026-07-20"
DATA=f"{REPO}/docs/auction/data"

# ---- tunables (canon silent -> flagged) ----
DISC=0.90
DECAY={'QB':0.96,'RB':0.88,'WR':0.93,'TE':0.94}   # positional production aging; WR 0.93 per task
HORIZON=4          # cap on expected extension years modeled
SCH1={'QB','RB','WR','TE'}
def esc_rate(pos, yrs):    # canonical escalator
    if pos in SCH1: return 10000 if yrs==1 else 20000
    return 3000 if yrs==1 else 5000

# ---- crosswalk mfl_id -> (name,pos) ----
id2name={}; id2pos={}
def add_xw(season_id_name_pos):
    for mid,nm,pos in season_id_name_pos:
        if mid and mid not in id2name:
            id2name[mid]=nm; id2pos[mid]=(pos or '').upper()
# fpros (has 2026), adp_history, rosters_weekly
rowset=[]
with open(f"{DATA}/fpros_adp_history.csv") as f:
    for r in csv.DictReader(f): rowset.append((str(r['mfl_id']), r['name'], r['pos']))
with open(f"{DATA}/adp_history.csv") as f:
    for r in csv.DictReader(f):
        nm=r['name']
        if ',' in nm:
            a,b=nm.split(',',1); nm=f"{b.strip()} {a.strip()}"
        rowset.append((str(r['mfl_id']), nm, r['pos']))
add_xw(rowset)
A=sqlite3.connect(f"{SD}/mfl_archive.db")
for pid,nm,pos in A.execute("SELECT player_id,player_name,position FROM rosters_weekly GROUP BY player_id"):
    pid=str(pid)
    if pid not in id2name:
        n=nm
        if ',' in (n or ''):
            a,b=n.split(',',1); n=f"{b.strip()} {a.strip()}"
        id2name[pid]=n; id2pos[pid]=(pos or '').upper()

def norm(s): return re.sub(r'[^a-z]','',(s or '').lower())

# ---- value core keyed by normalized name+pos ----
vc={}
_vcraw=json.load(open(f"{DATA}/fa_value_core.json"))
_vclist=_vcraw['players'] if isinstance(_vcraw,dict) else _vcraw
for p in _vclist:
    vc[(norm(p['player']),p['pos'])]=p

# ---- spells: entry cohort + elapsed for current players ----
spells=list(csv.DictReader(open(f"{SD}/contract_spells.csv")))
# latest spell per pid (the one touching 2025/censored)
cur_spell={}
for s in spells:
    pid=s['pid']
    es=int(s['entry_season'])
    if pid not in cur_spell or es>int(cur_spell[pid]['entry_season']):
        cur_spell[pid]=s

km=json.load(open(f"{SD}/km_params.json"))
rkm=json.load(open(f"{SD}/rookie_km.json"))

# Pooled elite-rookie cohorts (T1+T2+T3) — elite rookie WR/RB/QB/TE studs are rare
# and recent (all censored), so the exact-tier cell is thin. Jefferson/Chase/London/JSN
# all ENTERED at WR T3 by ADP, so the pooled top-40 rookie cohort is the honest stud comp.
def _pool_rookie(pos):
    Ss=[rkm[f"{pos}|{t}"] for t in ('T1','T2','T3') if f"{pos}|{t}" in rkm]
    if not Ss: return None
    n=sum(x['n'] for x in Ss)
    # n-weighted average survival
    L=max(len(x['S']) for x in Ss)
    S=[sum(x['n']*(x['S'][i] if i<len(x['S']) else x['S'][-1]) for x in Ss)/n for i in range(L)]
    return S,n
def cohort_survival(pos,tier,entry_type):
    """Return KM S[] array for the best-matching cohort."""
    if entry_type=='ROOKIE' and tier in ('T1','T2') :
        pr=_pool_rookie(pos)
        if pr: return pr[0], pr[1], f"rookie {pos} top-tier(T1-3 pooled)"
    if entry_type=='ROOKIE' and f"{pos}|{tier}" in rkm: return rkm[f"{pos}|{tier}"]['S'], rkm[f"{pos}|{tier}"]['n'], f"rookie {pos} {tier}"
    if f"{pos}|{tier}" in km and km[f"{pos}|{tier}"]['n']>=20: return km[f"{pos}|{tier}"]['S'], km[f"{pos}|{tier}"]['n'], f"{pos} {tier}"
    if f"{pos}|ALL" in km: return km[f"{pos}|ALL"]['S'], km[f"{pos}|ALL"]['n'], f"{pos} pooled"
    return [1,.4,.2,.1,.06,.04,.03,.02,.02,.01], 0, "global fallback"

def cond_surv(S, elapsed, j):
    """P(under contract in spell-year elapsed+j | survived elapsed)."""
    base=S[elapsed] if elapsed<len(S) else S[-1]
    if base<=0: return 0.0
    idx=elapsed+j
    return (S[idx] if idx<len(S) else S[-1])/base

# ---- parse contractInfo ----
def parse_ci(ci):
    ci=ci or ''
    def num(pat):
        m=re.search(pat,ci,re.I);
        if not m: return None
        v=float(m.group(1));
        return v
    cl=num(r'\bCL\s*(\d+)')
    tcv=num(r'TCV\s*\$?([\d.]+)\s*K'); tcv=tcv*1000 if tcv else None
    # AAV list
    am=re.search(r'AAV\s*([^|]+)',ci,re.I)
    aavs=[]
    if am:
        seg=re.sub(r'\bY\d+.*$','',am.group(1))
        for tok in re.split(r'[\/,]',seg):
            mm=re.search(r'([\d.]+)\s*K',tok)
            if mm: aavs.append(float(mm.group(1))*1000)
    # Y-tokens (per-year cash)
    ys=[]
    for m in re.finditer(r'Y(\d+)\s*-\s*\$?([\d.]+)\s*K', ci, re.I):
        ys.append((int(m.group(1)), float(m.group(2))*1000))
    ys.sort()
    extended = bool(re.search(r'Ext:', ci, re.I))
    return dict(cl=int(cl) if cl else None, tcv=tcv, aavs=aavs, ymap={k:v for k,v in ys}, extended=extended)

def canon_aav(p, salary):
    """Canonical escalation base per RULE-CONTRACT-005."""
    if p['extended'] and p['aavs']:
        return max(p['aavs'])                      # escalated lineage AAV
    if p['tcv'] and p['cl']:
        return round(p['tcv']/p['cl'])             # TRUE AAV for un-extended (fixes corrupted token)
    if p['aavs']: return p['aavs'][0]
    return salary

# ---- load 2026 rosters ----
ros=json.load(open(f"{SNAP}/rosters.json"))['rosters']['franchise']
fr_names={}
try:
    lg=json.load(open(f"{SNAP}/league.json"))['league']['franchises']['franchise']
    for fr in lg: fr_names[fr['id']]=fr.get('name','')
except: pass

out=[]
for fr in ros:
    fid=fr['id']
    for pl in fr.get('player',[]):
        pid=str(pl['id']); status=pl.get('status','')
        if status=='TAXI_SQUAD': continue   # off-cap; not in the FA/asset-value board frame
        cy=int(pl.get('contractYear') or 0)
        sal=int(pl.get('salary') or 0)
        ci=pl.get('contractInfo','')
        cs=pl.get('contractStatus','')
        p=parse_ci(ci)
        pos=id2pos.get(pid) or ''
        name=id2name.get(pid,pid)
        v=vc.get((norm(name),pos)) or {}
        dyn_raw=v.get('dynasty_worth_k'); ep=v.get('ep_k') or v.get('ep_base_k')
        if dyn_raw is None or ep is None:
            # no value data (IDP/K/depth) -> skip value calc but keep row
            dyn_raw=v.get('dynasty_worth_k'); ep=v.get('ep_k')
        cl=p['cl'] or cy or 1
        # remaining per-year cash (current year index = cl - cy + 1 ... cl)
        cur_idx=cl-cy+1 if cy else cl
        rem_cash=[]
        for yi in range(cur_idx, cl+1):
            c=p['ymap'].get(yi)
            if c is None: c=sal if yi==cur_idx else (p['tcv']/cl if p['tcv'] else sal)
            rem_cash.append(c)
        if not rem_cash: rem_cash=[sal]
        aav=canon_aav(p,sal)
        decay=DECAY.get(pos,0.92)
        epk=(ep or 0)*1000

        # ---- CURRENT (defective) ultimate: cost = flat AAV=TCV/CL, only contracted yrs, no horizon ----
        cur_surplus=0.0
        flat=(p['tcv']/cl) if (p['tcv'] and cl) else sal
        for t in range(1,cy+1 if cy else 2):
            cur_surplus += (DISC**(t-1))*(epk*decay**(t-1) - flat)
        cur_ult=(dyn_raw or 0) + cur_surplus/1000.0

        # ---- REBUILT ultimate ----
        # contracted phase: actual remaining cash
        contr=0.0
        for t,c in enumerate(rem_cash, start=1):
            contr += (DISC**(t-1))*(epk*decay**(t-1) - c)
        # expected extension phase
        sp=cur_spell.get(pid)
        entry_type=sp['entry_type'] if sp else ('ROOKIE' if 'Rookie' in cs else 'FAA')
        tier=sp['tier'] if sp and sp['tier'] else None
        elapsed = (2025-int(sp['entry_season'])+1) if sp else max(1,cl-cy)
        elapsed=max(1,elapsed)
        S,ncoh,coh_label=cohort_survival(pos,tier,entry_type)
        ext_cost=aav+esc_rate(pos,1)   # canonical 1yr-extension annual cost
        # An extension is an OWNER OPTION — exercised only when the future year is +EV
        # (else the player walks to the pool). So per-year extension surplus is FLOORED at 0
        # in the scalar: a stud on a cheap deal gains option value; an overpaid vet just walks
        # (no forced negative). exp_ext_years still reflects the KM expectation (Keith's lifespan
        # answer), independent of the surplus sign.
        exp_ext_years=0.0; ext_surplus=0.0
        for j in range(1,HORIZON+1):
            pj=cond_surv(S, elapsed+ (len(rem_cash)-1), j)  # survive beyond contracted years
            exp_ext_years += pj
            tt=len(rem_cash)+j
            per=(DISC**(tt-1))*(epk*decay**(tt-1) - ext_cost)
            ext_surplus += pj*max(0.0, per)   # floored: owner won't extend at a loss
        reb_surplus=(contr+ext_surplus)/1000.0
        reb_ult=(dyn_raw or 0)+reb_surplus
        # option-value BAND (labeled, NOT in scalar): the right-tail premium if the player
        # outperforms and every favorable extension is exercised at full term, above the
        # probability-weighted expectation already in the scalar.
        opt_band=0.0
        for j in range(1,HORIZON+1):
            tt=len(rem_cash)+j
            per=(DISC**(tt-1))*(epk*decay**(tt-1) - ext_cost)/1000.0
            if per>0: opt_band+=per   # only positive-EV extension years, full-term
        opt_band -= ext_surplus/1000.0   # premium over the prob-weighted expectation

        E_remaining_years = len(rem_cash) + exp_ext_years
        out.append(dict(pid=pid,name=name,pos=pos,owner=fr_names.get(fid,fid),fid=fid,
            status=cs,cy=cy,cl=cl,salary=sal,tcv=p['tcv'],canon_aav=aav,extended=p['extended'],
            rem_cash="|".join(f"{int(c//1000)}" for c in rem_cash),
            dyn_raw=dyn_raw,ep=ep,cohort=coh_label,coh_n=ncoh,tier=tier,entry_type=entry_type,
            elapsed=elapsed,exp_ext_years=round(exp_ext_years,2),E_total_years=round(E_remaining_years,2),
            ext_ann_cost=int(ext_cost),
            cur_ultimate=round(cur_ult,1),reb_ultimate=round(reb_ult,1),
            delta=round(reb_ult-cur_ult,1),opt_band=round(opt_band,1)))

A.close()
# write CSV
cols=["pid","name","pos","owner","status","cy","cl","salary","tcv","canon_aav","extended","rem_cash",
      "dyn_raw","ep","entry_type","tier","cohort","coh_n","elapsed","exp_ext_years","E_total_years",
      "ext_ann_cost","cur_ultimate","reb_ultimate","delta","opt_band"]
with open(f"{SD}/ultimate_value_rebuilt.csv","w",newline="") as f:
    w=csv.DictWriter(f,fieldnames=cols); w.writeheader()
    for r in sorted(out,key=lambda x:-(x['reb_ultimate'] or -999)):
        w.writerow({k:r.get(k) for k in cols})

val=[r for r in out if r['dyn_raw'] is not None]
print(f"players valued: {len(val)} (of {len(out)} non-taxi rostered)")
print("\n=== BIGGEST MOVERS (rebuilt - current ultimate) ===")
for r in sorted(val,key=lambda x:-abs(x['delta']))[:16]:
    print(f"  {r['name']:22s} {r['pos']:3s} cy{r['cy']} sal{r['salary']//1000:>3}K remCash[{r['rem_cash']}] ext={r['extended']}"
          f"  cur={r['cur_ultimate']:6.1f} reb={r['reb_ultimate']:6.1f} Δ={r['delta']:+6.1f}  Eyrs={r['E_total_years']}")
print("\n=== McMillan detail ===")
for r in val:
    if 'Tetairoa' in r['name']:
        print(json.dumps(r,indent=1))
