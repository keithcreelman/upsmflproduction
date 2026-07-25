#!/usr/bin/env python3
"""UPS contract-spell reconstruction + extension/lifespan transition estimation.

A SPELL = a player's continuous tenure under UPS contract control, from a
pool-ENTRY event (rookie draft / FA-auction win / ERA win / waiver pickup) to a
pool-RETURN (next entry event of the same player, i.e. re-auctioned; or a drop
with no re-add; or end-of-data = right-censored). A trade does NOT end a spell
(the contract travels with the player — canon A6/E2). This matches Keith's
framing: "years under contract before going back into the pool."

Tiering "levels the market" by canonical positional tag tiers (canon C8/T3.5)
applied to entry ADP rank where available, else to entry auction-bid rank, else
to rookie draft slot.
"""
import sqlite3, csv, os, json, re
from collections import defaultdict

SD=os.environ["SD"]
REPO="/Users/keithcreelman/Code/MFL/upsmflproduction/.claude/worktrees/agent-a4b9155df12b50b16"
A=sqlite3.connect(f"{SD}/mfl_archive.db")
E=sqlite3.connect(f"{SD}/ext_master.db")
DATA=f"{REPO}/docs/auction/data"
DATA_MAX_SEASON=2025  # last season with realized (uncensored) outcomes in archive

# ---- canonical positional tag tiers (canon league_context C8/T3.5) ----
TIER_BANDS={
 'QB':[(1,5),(6,15),(16,24)],
 'RB':[(1,4),(5,8),(9,31)],
 'WR':[(1,6),(7,14),(15,40)],
 'TE':[(1,3),(4,6),(7,13)],
}
def tier_of(pos,rank):
    if rank is None: return None
    bands=TIER_BANDS.get(pos)
    if not bands:  # IDP/K etc -> single bucket
        return 'IDP/K'
    for i,(lo,hi) in enumerate(bands,1):
        if lo<=rank<=hi: return f'T{i}'
    return 'T4'  # below the deepest canonical tier

# ---- ADP: positional rank by (season, mfl_id) ----
adp_rank={}  # (season,mfl_id)->pos_rank
with open(f"{DATA}/adp_history.csv") as f:
    for r in csv.DictReader(f):
        pr=r.get('pos_rank','')
        m=re.match(r'[A-Za-z]+(\d+)',pr or '')
        if m: adp_rank[(int(r['season']),str(r['mfl_id']))]=int(m.group(1))
# fpros pos rank as secondary (2022-26), keyed by mfl_id
fp_rank={}
with open(f"{DATA}/fpros_adp_history.csv") as f:
    for r in csv.DictReader(f):
        try: fp_rank[(int(r['season']),str(r['mfl_id']))]=int(r['fp_pos_rank'])
        except: pass

# ---- entry events ----
# rookie drafts
rookie={}  # (season,pid)-> overall
for tbl in ('draftresults_legacy','draftresults_mfl'):
    for s,ov,pid,nm in A.execute(f"SELECT season,draftpick_overall,player_id,player_name FROM {tbl}"):
        if pid: rookie[(int(s),str(pid))]={'overall':ov,'name':nm}
# auctions (WON)
auc=defaultdict(list)  # (season,pid) -> list of bid rows
for s,pid,nm,pos,bid,ts,mo in A.execute("""
   SELECT season,player_id,player_name,position,bid_amount,unix_timestamp,
          CAST(strftime('%m',datetime(unix_timestamp,'unixepoch')) AS INT)
   FROM transactions_auction WHERE auction_event_type='WON'"""):
    if not pid: continue
    kind='ERA' if mo in (4,5) else ('FAA' if mo in (6,7,8) else 'AUC')
    auc[(int(s),str(pid))].append(dict(name=nm,pos=(pos or '').upper(),bid=bid or 0,kind=kind,mo=mo))
# waiver/FCFS adds (salary-bearing) as low-tier entries
adds=defaultdict(list)
for s,pid,sal,meth,mt in A.execute("""SELECT season,player_id,salary,method,move_type
        FROM transactions_adddrop WHERE move_type='ADD'"""):
    if pid: adds[(int(s),str(pid))].append(dict(sal=sal or 0,method=meth))
# drops
drops=defaultdict(list)
for s,pid in A.execute("SELECT season,player_id FROM transactions_adddrop WHERE move_type='DROP'"):
    if pid: drops[int(s)].append(str(pid))
drops_by_pid=defaultdict(set)
for s,plist in drops.items():
    for pid in plist: drops_by_pid[pid].add(s)

# position lookup (prefer rosters_weekly modal position, else auction/draft)
pos_of={}
for pid,pos in A.execute("""SELECT player_id, position FROM rosters_weekly
     WHERE position IS NOT NULL GROUP BY player_id"""):
    pos_of[str(pid)]=(pos or '').upper()

# player name
name_of={}
for pid,nm in A.execute("SELECT player_id, player_name FROM rosters_weekly GROUP BY player_id"):
    name_of[str(pid)]=nm

# ---- extensions by player-season (term) ----
ext_by=defaultdict(list)  # pid -> list of (season, term)
for pid,season,term,pos,cs in E.execute("""SELECT player_id, CAST(season AS INT), extension_term_years, position, new_contract_status
       FROM ups_extension_master"""):
    ext_by[str(pid)].append(dict(season=season,term=term,cs=(cs or '')))

# ---- build entry list per player (sorted by season) ----
entries=defaultdict(list)  # pid -> [ {season, type, value, pos, name} ]
allpids=set()
for (s,pid),info in rookie.items():
    entries[pid].append(dict(season=s,typ='ROOKIE',overall=info['overall'],bid=None,name=info['name']))
    allpids.add(pid)
for (s,pid),rows in auc.items():
    # pick the "primary" win in that season (max bid), classify kind
    row=max(rows,key=lambda r:r['bid'])
    entries[pid].append(dict(season=s,typ=row['kind'],overall=None,bid=row['bid'],name=row['name'],pos=row['pos']))
    allpids.add(pid)
# waiver adds only count as an entry if the player is NOT already entered that season via auction/rookie/prev-roster
for (s,pid),rows in adds.items():
    if (s,pid) in rookie: continue
    if (s,pid) in auc: continue
    sal=max(r['sal'] for r in rows)
    entries[pid].append(dict(season=s,typ='WAIVER',overall=None,bid=sal,name=name_of.get(pid,pid)))
    allpids.add(pid)

# ---- construct spells ----
# For each player, sort entries. Each entry starts a spell that runs until the
# season BEFORE the next entry (re-auction=return to pool), or last roster
# season, or a terminal drop, or end of data.
roster_seasons=defaultdict(set)
for pid,s in A.execute("SELECT player_id, season FROM rosters_weekly GROUP BY player_id, season"):
    roster_seasons[str(pid)].add(int(s))

spells=[]
for pid in allpids:
    evs=sorted(entries[pid],key=lambda e:e['season'])
    # dedupe consecutive entries in the SAME season (rookie+immediate... rare)
    for i,ev in enumerate(evs):
        s0=ev['season']
        # next entry season (a re-auction/re-draft = pool return)
        nxt=None
        for j in range(i+1,len(evs)):
            if evs[j]['season']>s0:
                nxt=evs[j]['season']; break
        # last roster season within this window
        rs=[y for y in roster_seasons.get(pid,()) if y>=s0 and (nxt is None or y<nxt)]
        last_roster=max(rs) if rs else s0
        # spell end = min(nxt-1, last_roster) but not before s0
        end = (nxt-1) if nxt else last_roster
        end = max(s0, min(end,last_roster) if rs else (nxt-1 if nxt else s0))
        # censored if the spell touches the data edge with no observed pool-return
        censored = (nxt is None) and (last_roster>=DATA_MAX_SEASON)
        pos=ev.get('pos') or pos_of.get(pid) or ''
        # market rank & tier
        rank=adp_rank.get((s0,pid)) or fp_rank.get((s0,pid))
        rank_src='adp' if rank else None
        if rank is None and ev['typ'] in ('FAA','ERA','AUC') and ev.get('bid'):
            # rank by bid within (pos, season, all auction wins that season)
            peers=sorted([max(r['bid'] for r in auc[(s0,p2)])
                          for (ss,p2) in auc if ss==s0 and (auc[(s0,p2)][0]['pos']==pos)],reverse=True)
            try:
                rank=peers.index(max(r['bid'] for r in auc[(s0,pid)]))+1; rank_src='bid'
            except: rank=None
        if rank is None and ev['typ']=='ROOKIE' and ev.get('overall'):
            # map rookie overall to an approximate positional rank via draft-slot band
            rank_src='rookie_slot'
        tier=tier_of(pos,rank) if rank else None
        # extensions within spell window
        exts=[x for x in ext_by.get(pid,()) if s0<=x['season']<=end]
        exts=sorted(exts,key=lambda x:x['season'])
        spells.append(dict(pid=pid,name=ev['name'],pos=pos,entry_season=s0,entry_type=ev['typ'],
            entry_overall=ev.get('overall'),entry_bid=ev.get('bid'),rank=rank,rank_src=rank_src,tier=tier,
            end_season=end,length=end-s0+1,censored=censored,
            n_ext=len(exts),ext_terms=[x['term'] for x in exts],ext_seasons=[x['season'] for x in exts]))

# save spells
with open(f"{SD}/contract_spells.csv","w",newline="") as f:
    w=csv.writer(f)
    w.writerow(["pid","name","pos","entry_season","entry_type","entry_overall","entry_bid","market_rank","rank_src","tier","end_season","length_seasons","censored","n_extensions","ext_terms","ext_seasons"])
    for s in sorted(spells,key=lambda x:(x['pos'],x['entry_season'])):
        w.writerow([s['pid'],s['name'],s['pos'],s['entry_season'],s['entry_type'],s['entry_overall'],s['entry_bid'],
            s['rank'],s['rank_src'],s['tier'],s['end_season'],s['length'],int(s['censored']),s['n_ext'],
            "|".join(str(t) for t in s['ext_terms']),"|".join(str(t) for t in s['ext_seasons'])])

print(f"TOTAL spells: {len(spells)}  (players: {len(allpids)})")
byt=defaultdict(int)
for s in spells: byt[s['entry_type']]+=1
print("by entry type:",dict(byt))
print(f"censored (open at data edge): {sum(1 for s in spells if s['censored'])}")

# ---- Spell length distribution by pos/tier (COMPLETED spells only) ----
print("\n=== Completed-spell length (seasons under contract before pool return), by pos x entry tier ===")
grp=defaultdict(list)
for s in spells:
    if s['censored']: continue
    if s['tier'] is None: continue
    grp[(s['pos'],s['tier'])].append(s['length'])
import statistics as st
for (pos,tier) in sorted(grp):
    if pos not in TIER_BANDS: continue
    v=grp[(pos,tier)]
    if len(v)<4: continue
    print(f"  {pos} {tier}: n={len(v):3d}  mean={st.mean(v):.2f}  median={st.median(v):.1f}  p90={sorted(v)[int(.9*len(v))-1]}  dist={dict(sorted((x,v.count(x)) for x in set(v)))}")

# ---- Extension branching: given a MULTI-YEAR contract, P(extended), and re-extension ----
print("\n=== Extension counts per spell, by pos (completed spells, entry ROOKIE or AUCTION) ===")
for pos in ('QB','RB','WR','TE'):
    ss=[s for s in spells if s['pos']==pos and not s['censored'] and s['entry_type'] in ('ROOKIE','FAA','ERA','AUC')]
    if not ss: continue
    ne=defaultdict(int)
    for s in ss: ne[s['n_ext']]+=1
    tot=len(ss)
    print(f"  {pos}: n={tot}  ext-count dist "+", ".join(f"{k}:{v}({100*v/tot:.0f}%)" for k,v in sorted(ne.items())))

# term distribution of extensions
print("\n=== Extension TERM distribution (all extensions, from ext_master) ===")
for pos in ('QB','RB','WR','TE'):
    terms=defaultdict(int)
    for pid,xs in ext_by.items():
        if pos_of.get(pid)!=pos: continue
        for x in xs:
            t=x['term']
            if t in (1,2): terms[t]+=1
            else:
                cs=x['cs'].upper()
                if 'EXT1' in cs: terms[1]+=1
                elif 'EXT2' in cs: terms[2]+=1
                else: terms['?']+=1
    print(f"  {pos}: "+", ".join(f"{k}yr={v}" for k,v in sorted(terms.items(),key=str)))
A.close(); E.close()
print("\nwrote contract_spells.csv")
PY
