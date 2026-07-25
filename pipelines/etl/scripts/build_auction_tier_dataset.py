#!/usr/bin/env python3
"""
Master auction-tier dataset builder.

Spine: lot_level_clean.csv (one row per auctioned lot, 2019-2025).
Enrich: position/name (bids_enriched) + Dynasty SF ECR tier (dynasty_adp via
fpros mfl_id<->fp_id bridge, redraft ADP backfill) + realized PAR (apw_seasonal).

Talent tiers:
  SKILL (QB/RB/WR/TE): by dynasty SF ECR -> Top12 / 13-25 / 26-50 / 51-75 /
     76-100 / 101-150 / 150+  (redraft overall_rank backfills missing ECR).
  IDP (DL/DE/DT/LB/CB/S/DB):  ADP does not rank IDP; tier by within-(year,posgroup)
     realized PAR rank -> IDP1-6 / 7-12 / 13-24 / 25+.
  K/P: own bucket.

Outputs (scratchpad):
  master_auction_tiers.csv   one row per lot, fully tiered
  master_bids_tiers.csv      bid-level (bids_enriched) tagged with lot tier
"""
import csv, os, sys
from collections import defaultdict, Counter

import pathlib
REPO = pathlib.Path(__file__).resolve().parents[3]
D = str(REPO / "docs" / "auction" / "data")
OUT = D

def load(f):
    with open(os.path.join(D, f)) as fh:
        return list(csv.DictReader(fh))

def fnum(x):
    try: return float(x)
    except: return None

SKILL = {"QB","RB","WR","TE"}
IDP   = {"DL","DE","DT","LB","CB","S","DB","EDGE"}
KP    = {"PK","PN","K","P","TMPK"}

def posgroup(pos):
    if pos in SKILL: return "SKILL"
    if pos in IDP:   return "IDP"
    if pos in KP:    return "KP"
    return "OTHER"

# ---- load sources
lots  = load("lot_level_clean.csv")
bids  = load("bids_enriched.csv")
dyn   = load("dynasty_adp_history.csv")     # season,player,pos,age,sf_ecr,sf_pos_rank,value_2qb,fp_id,asof
fpros = load("fpros_adp_history.csv")        # season,mfl_id,name,pos,fp_pos_rank,fp_id
adp   = load("adp_history.csv")              # season,mfl_id,...,overall_rank,...
apw   = load("apw_seasonal.csv")             # season,player_id,pos,...,par_started,apw_started

# ---- bid-derived pos/name per (season, player_id) -- most reliable
bidpos, bidname = {}, {}
for b in bids:
    k = (b["season"], b["player_id"])
    if b.get("pos"):    bidpos.setdefault(k, b["pos"])
    if b.get("player"): bidname.setdefault(k, b["player"])

# apw pos as secondary (apw pos uses combined labels DT+DE / CB+S; keep raw for fallback only)
apwpos = {}
apwpar = {}
for a in apw:
    k = (a["season"], a["player_id"])
    apwpos.setdefault(k, a["pos"])
    par = fnum(a.get("par_started"))
    if par is not None: apwpar[k] = par

# ---- SF ECR bridge: (season, mfl_id) -> fp_id -> sf_ecr
mfl2fp = {}
for r in fpros:
    mfl2fp[(r["season"], r["mfl_id"])] = r["fp_id"]
fp2ecr = {}
for r in dyn:
    e = fnum(r.get("sf_ecr"))
    if e is not None:
        fp2ecr[(r["season"], r["fp_id"])] = (e, r.get("sf_pos_rank",""))
# redraft overall_rank backfill: (season, mfl_id) -> overall_rank
mfl2ovr = {}
for r in adp:
    o = fnum(r.get("overall_rank"))
    if o is not None:
        mfl2ovr[(r["season"], r["mfl_id"])] = o

def skill_tier(rank):
    if rank is None: return "unranked"
    r = rank
    if r <= 12:  return "T1_top12"
    if r <= 25:  return "T2_13-25"
    if r <= 50:  return "T3_26-50"
    if r <= 75:  return "T4_51-75"
    if r <= 100: return "T5_76-100"
    if r <= 150: return "T6_101-150"
    return "T7_150+"

# ---- assign per-lot enrichment
rows = []
join_stat = Counter()
for lot in lots:
    yr, pid = lot["year"], lot["pid"]
    k = (yr, pid)
    pos = lot.get("pos") or bidpos.get(k) or ""
    if not pos:
        # apw combined labels -> pick a representative
        ap = apwpos.get(k, "")
        pos = {"DT+DE":"DL","CB+S":"DB"}.get(ap, ap)
    grp = posgroup(pos)
    name = (lot.get("player") or "")
    if name.startswith("#") or not name:
        name = bidname.get(k, name)

    ecr = fp2ecr.get((yr, mfl2fp.get(k)), (None,None))[0] if mfl2fp.get(k) else None
    ecr_src = "sf_ecr" if ecr is not None else None
    ovr = mfl2ovr.get(k)
    rank_used = ecr if ecr is not None else ovr
    if ecr is None and ovr is not None: ecr_src = "redraft_ovr"
    par = apwpar.get(k)
    win_k = fnum(lot.get("win_k"))
    win_d = fnum(lot.get("win_dollars"))
    dpar = (win_d / par) if (win_d and par and par > 0) else None

    if grp == "SKILL":
        tier = skill_tier(rank_used); join_stat["skill_lot"] += 1
        if rank_used is not None: join_stat["skill_ranked"] += 1
    else:
        tier = None  # IDP tier assigned after per-year PAR ranking below; KP/OTHER later
    rows.append({
        "year": yr, "pid": pid, "player": name, "pos": pos, "posgroup": grp,
        "win_k": win_k, "win_dollars": win_d,
        "sf_ecr": ecr, "overall_rank": ovr, "rank_used": rank_used, "rank_src": ecr_src,
        "par": par, "dollars_per_par": (round(dpar,1) if dpar is not None else None),
        "skill_tier": tier,
        "total_bids": lot.get("total_bids"), "forced": lot.get("forced"),
        "overtakes": lot.get("overtakes"), "duration_hrs": lot.get("duration_hrs"),
        "nominator": lot.get("nominator"), "winner": lot.get("winner"),
        "self_nom": lot.get("self_nom"),
    })

# ---- IDP tiers by within-(year, posgroup=IDP) PAR rank
idp_by_year = defaultdict(list)
for r in rows:
    if r["posgroup"] == "IDP" and r["par"] is not None:
        idp_by_year[r["year"]].append(r)
for yr, lst in idp_by_year.items():
    lst.sort(key=lambda r: -r["par"])
    for i, r in enumerate(lst, 1):
        r["idp_par_rank"] = i
        r["idp_tier"] = ("IDP1_1-6" if i<=6 else "IDP2_7-12" if i<=12 else
                          "IDP3_13-24" if i<=24 else "IDP4_25+")
for r in rows:
    if r["posgroup"]=="IDP":
        r.setdefault("idp_par_rank", None); r.setdefault("idp_tier","idp_unranked_par")
    # unified tier column
    r["tier"] = r.get("skill_tier") or r.get("idp_tier") or (r["posgroup"].lower())

# ---- write master lots
cols = ["year","pid","player","pos","posgroup","win_k","win_dollars","sf_ecr","overall_rank",
        "rank_used","rank_src","par","dollars_per_par","skill_tier","idp_par_rank","idp_tier","tier",
        "total_bids","forced","overtakes","duration_hrs","nominator","winner","self_nom"]
with open(os.path.join(OUT,"master_auction_tiers.csv"),"w",newline="") as fh:
    w=csv.DictWriter(fh, fieldnames=cols); w.writeheader()
    for r in rows: w.writerow({c:r.get(c) for c in cols})

# ---- bid-level tagged with lot tier
lot_tier = {(r["year"],r["pid"]):(r["tier"],r["posgroup"],r["pos"]) for r in rows}
bcols = list(bids[0].keys()) + ["tier","posgroup_lot"]
nbtag=0
with open(os.path.join(OUT,"master_bids_tiers.csv"),"w",newline="") as fh:
    w=csv.DictWriter(fh, fieldnames=bcols); w.writeheader()
    for b in bids:
        t = lot_tier.get((b["season"], b["player_id"]))
        b2=dict(b); b2["tier"]=t[0] if t else ""; b2["posgroup_lot"]=t[1] if t else ""
        if t: nbtag+=1
        w.writerow(b2)

# ================= DIAGNOSTICS =================
print("=== COVERAGE ===")
print(f"lots total: {len(rows)}")
gc=Counter(r['posgroup'] for r in rows)
print("posgroup:", dict(gc))
print(f"skill lots: {join_stat['skill_lot']}  ranked(ECR or redraft): {join_stat['skill_ranked']} ({100*join_stat['skill_ranked']//max(join_stat['skill_lot'],1)}%)")
sf_ct=sum(1 for r in rows if r['posgroup']=='SKILL' and r['rank_src']=='sf_ecr')
rd_ct=sum(1 for r in rows if r['posgroup']=='SKILL' and r['rank_src']=='redraft_ovr')
print(f"  skill rank src: sf_ecr={sf_ct} redraft_backfill={rd_ct}")
idp_par=sum(1 for r in rows if r['posgroup']=='IDP' and r['par'] is not None)
idp_tot=sum(1 for r in rows if r['posgroup']=='IDP')
print(f"IDP lots: {idp_tot}  with PAR(tierable): {idp_par}")
par_any=sum(1 for r in rows if r['par'] is not None)
print(f"PAR present (all pos): {par_any}/{len(rows)} ({100*par_any//len(rows)}%)")
print(f"bid rows tagged w/ tier: {nbtag}/{len(bids)}")
print()
print("=== SKILL tier x year (lot counts) ===")
sk=[r for r in rows if r['posgroup']=='SKILL']
years=sorted(set(r['year'] for r in rows))
tiers=["T1_top12","T2_13-25","T3_26-50","T4_51-75","T5_76-100","T6_101-150","T7_150+","unranked"]
print("tier\\yr    "+" ".join(f"{y[-2:]:>4}" for y in years))
for t in tiers:
    print(f"{t:<11}"+" ".join(f"{sum(1 for r in sk if r['year']==y and r['skill_tier']==t):>4}" for y in years))
print()
print("=== IDP tier x year ===")
idp=[r for r in rows if r['posgroup']=='IDP']
for t in ["IDP1_1-6","IDP2_7-12","IDP3_13-24","IDP4_25+","idp_unranked_par"]:
    print(f"{t:<17}"+" ".join(f"{sum(1 for r in idp if r['year']==y and r.get('idp_tier')==t):>4}" for y in years))
print()
print("=== sample skill rows (top12) ===")
for r in [x for x in sk if x['skill_tier']=='T1_top12'][:6]:
    print(f"  {r['year']} {r['player'][:20]:<20} {r['pos']} ecr={r['sf_ecr']} win={r['win_k']}k $/PAR={r['dollars_per_par']}")
print("=== sample IDP rows ===")
for r in [x for x in idp if x.get('idp_tier')=='IDP1_1-6'][:6]:
    print(f"  {r['year']} {r['player'][:20]:<20} {r['pos']} PARrank={r.get('idp_par_rank')} win={r['win_k']}k PAR={r['par']} $/PAR={r['dollars_per_par']}")
print("\\nwrote master_auction_tiers.csv + master_bids_tiers.csv")
