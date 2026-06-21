#!/usr/bin/env python3
"""validate_scoring_alignment.py — recompute UPS fantasy points from nflverse
raw stats using the league scoring rules (export?TYPE=rules) and compare to
MFL's official weeklyResults, per player + per team. Set WEEK/YEAR below.

Findings (W8 2025): offense+IDP+kicking align tightly; 3 gaps to close for
exact parity — (1) punters need gross punt yds (D1 punt aggregates), (2) kicker
"ANY" bonus is longest-FG-once not per-FG, (3) TD length 50+yd=7 needs PBP.
See memory project_scoring_rules_alignment. Deps: nflreadpy, pandas, pyarrow.
"""

import json,re,urllib.request
UA={"User-Agent":"Mozilla/5.0 AppleWebKit/537.36 Chrome/124 Safari/537.36"}
WEEK=8;YEAR=2025;L="74598"
def get(u): return urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=90).read()
def norm(n):
    n=("" if (n is None or (isinstance(n,float) and n!=n)) else str(n)).lower().strip()
    if "," in n: a=n.split(","); n=(a[1].strip()+" "+a[0].strip()).strip()
    n=re.sub(r"[.\,'\-]","",n); n=re.sub(r"\b(jr|sr|ii|iii|iv|v)\b","",n); return re.sub(r"\s+"," ",n).strip()
pl=json.loads(get(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=players&L={L}&DETAILS=1&JSON=1"))["players"]["player"]
mfl_norm={}; 
for p in pl: mfl_norm[norm(p.get("name"))]=p["id"]
wr=json.loads(get(f"https://www48.myfantasyleague.com/{YEAR}/export?TYPE=weeklyResults&L={L}&W={WEEK}&JSON=1"))["weeklyResults"]
mfl_pts={}
for m in (wr["matchup"] if isinstance(wr["matchup"],list) else [wr["matchup"]]):
    for f in m["franchise"]:
        for pp in (f.get("player",[]) if isinstance(f.get("player",[]),list) else [f.get("player",{})]):
            if pp and pp.get("id"): mfl_pts[pp["id"]]=float(pp.get("score") or 0)
import nflreadpy as nfl
df=nfl.load_player_stats(seasons=[YEAR]); 
if hasattr(df,"to_pandas"): df=df.to_pandas()
df=df[df["week"]==WEEK]; cols=set(df.columns)
def gv(row,c): 
    if c not in cols: return 0.0
    v=row.get(c)
    try: return float(v) if v==v and v is not None else 0.0
    except: return 0.0
def pgroup(p):
    p=(p or "").upper()
    if p in("QB","RB","WR","TE","FB","HB"):return "OFF"
    if p in("K","PK"):return "K"
    if p in("P","PN"):return "P"
    if p in("DT","DE","NT","DL"):return "DL"
    if p in("LB","OLB","MLB","ILB"):return "LB"
    if p in("CB","S","SAF","FS","SS","DB"):return "DB"
    return "OTH"
TKM={"DL":(1.5,0.5,1.5),"DB":(1.3,0.8,1.5),"LB":(1.0,0.5,1.0),"OFF":(1.0,0.5,1.0),"K":(1,.5,1),"P":(1,.5,1),"OTH":(1,.5,1)}
def tier(v,ts):
    b=0
    for lo,p in ts:
        if v>=lo:b=p
    return b
def compute(row):
    pos=(row.get("position") or "")
    grp=pgroup(pos); ppr=1.5 if grp=="OFF" and pos.upper()=="TE" else (0.8 if pos.upper()=="RB" else 1.0)
    p=0.0
    # OFFENSE
    p+=gv(row,"passing_yards")*0.04+tier(gv(row,"passing_yards"),[(300,1),(375,2),(425,3)])
    p+=gv(row,"passing_tds")*6 + gv(row,"passing_interceptions")*-2 + gv(row,"sack_yards_lost")*-0.1 + gv(row,"passing_2pt_conversions")*2
    p+=gv(row,"rushing_yards")*0.1+tier(gv(row,"rushing_yards"),[(100,1),(150,2),(200,3),(250,5)])
    p+=gv(row,"rushing_tds")*6 + gv(row,"rushing_2pt_conversions")*2
    p+=gv(row,"receiving_yards")*0.1+tier(gv(row,"receiving_yards"),[(100,2),(150,3),(200,5)])
    p+=gv(row,"receiving_tds")*6 + gv(row,"receiving_2pt_conversions")*2 + gv(row,"receptions")*ppr
    p+=(gv(row,"rushing_fumbles_lost")+gv(row,"receiving_fumbles_lost")+gv(row,"sack_fumbles_lost"))*-2
    p+=(gv(row,"passing_first_downs")+gv(row,"rushing_first_downs")+gv(row,"receiving_first_downs"))*0.2  # MFL credits passing FDs to the QB
    # IDP
    tk,asx,tkl=TKM[grp]
    p+=gv(row,"def_tackles_solo")*tk + gv(row,"def_tackle_assists")*asx + gv(row,"def_tackles_for_loss")*tkl
    p+=gv(row,"def_sacks")*3 + gv(row,"def_qb_hits")*0.5 + gv(row,"def_pass_defended")*1.5
    p+=gv(row,"def_fumbles_forced")*2 + gv(row,"def_interceptions")*4 + gv(row,"def_safeties")*2
    p+=gv(row,"fumble_recovery_opp")*4 + gv(row,"def_tds")*6
    # KICKING
    p+=gv(row,"fg_made_distance")*0.1 + gv(row,"fg_made_50_59")*3 + gv(row,"fg_made_60_")*5
    p+=gv(row,"pat_made")*1 + gv(row,"pat_missed")*-1
    return round(p,2)
from collections import defaultdict
G=defaultdict(list)
COMPUTED={}
for row in df.to_dict("records"):
    nm=norm(row.get("player_display_name") or row.get("player_name"))
    pid=mfl_norm.get(nm)
    if not pid or pid not in mfl_pts: continue
    comp=compute(row); off=mfl_pts[pid]; grp=pgroup(row.get("position"))
    COMPUTED[pid]=comp
    G[grp].append((abs(comp-off),comp,off,row.get("player_display_name"),(row.get("position") or "")))
print(f"=== W{WEEK} {YEAR} ALL-POSITION alignment (computed from nflverse vs MFL official) ===")
order=["OFF","DL","LB","DB","K","P","OTH"]
alld=[]
for grp in order:
    rows=G.get(grp,[]); 
    if not rows: continue
    n=len(rows); w2=sum(1 for d,*_ in rows if d<=2); w05=sum(1 for d,*_ in rows if d<=0.5)
    mad=sum(d for d,*_ in rows)/n; alld+=rows
    print(f"  {grp:4}: n={n:3}  within0.5={w05:3} ({100*w05//n}%)  within2={w2:3} ({100*w2//n}%)  meanAbsDiff={mad:.2f}")
n=len(alld); w2=sum(1 for d,*_ in alld if d<=2)
print(f"  ALL : n={n}  within2={w2} ({100*w2//n}%)  meanAbsDiff={sum(d for d,*_ in alld)/n:.2f}")
alld.sort(reverse=True)
print("\n--- 20 largest diffs (comp vs MFL) ---")
for d,comp,off,name,pos in alld[:20]:
    print(f"  {name:24}{pos:4} comp={comp:7.2f} mfl={off:7.2f} diff={comp-off:+7.2f}")

# ---- TEAM TOTALS: sum each franchise's STARTERS (computed vs MFL franchise score) ----
print("\n=== TEAM-LEVEL alignment (starters only) ===")
fr_rows=[]
for m in (wr["matchup"] if isinstance(wr["matchup"],list) else [wr["matchup"]]):
    for f in m["franchise"]:
        fid=f.get("id"); mflscore=float(f.get("score") or 0)
        starters=[pp["id"] for pp in (f.get("player",[]) if isinstance(f.get("player",[]),list) else [f.get("player",{})]) if pp and pp.get("status")=="starter"]
        comp=sum(COMPUTED.get(pid,0) for pid in starters)
        miss=[pid for pid in starters if pid not in COMPUTED]
        fr_rows.append((abs(comp-mflscore),fid,comp,mflscore,len(starters),len(miss)))
fr_rows.sort(reverse=True)
for d,fid,comp,off,ns,miss in sorted(fr_rows,key=lambda x:x[1]):
    print(f"  F{fid}: computed={comp:7.2f}  MFL={off:7.2f}  diff={comp-off:+7.2f}  ({ns} starters, {miss} unmatched)")
mad=sum(d for d,*_ in fr_rows)/len(fr_rows)
print(f"  -> mean abs team diff: {mad:.2f}  (unmatched starters = punters/name-mismatch, scored 0 by us)")
PY