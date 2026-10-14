import json, statistics as S
from core import *
rows = []
for f in FIDS:
    sc = [TW[(w, f)]["score"] for w in WEEKS]; op = [TW[(w, f)]["opt"] for w in WEEKS]
    games = [g for w in WEEKS for g in TW[(w, f)]["games"]]
    W = sum(g["result"] == "W" for g in games); Lo = sum(g["result"] == "L" for g in games); T = sum(g["result"] == "T" for g in games)
    apw = sum(AP[w][f][0] for w in WEEKS); apl = sum(AP[w][f][1] for w in WEEKS); apt = sum(AP[w][f][2] for w in WEEKS)
    ap3w = sum(AP[w][f][0] for w in (3, 4, 5)); ap3l = sum(AP[w][f][1] for w in (3, 4, 5))
    # expected H2H wins: each game's win chance = that week's all-play pct
    xw = sum(AP[w][f][0] / 11.0 for w in WEEKS for g in TW[(w, f)]["games"])
    close = [g for g in games if abs(g["margin"]) < 10]
    offp = sum(p["score"] for w in WEEKS for p in TW[(w, f)]["players"] if p["status"] == "starter" and side(ppos(p["pid"])) == "O")
    idpp = sum(p["score"] for w in WEEKS for p in TW[(w, f)]["players"] if p["status"] == "starter" and side(ppos(p["pid"])) == "D")
    rows.append(dict(fid=f, owner=owner(f), div=FR[f]["division"], W=W, L=Lo, T=T, apw=apw, apl=apl, apt=apt,
                     ppg=sum(sc) / 5, ppg3=sum(sc[2:]) / 3, ppg12=sum(sc[:2]) / 2, ap3=(ap3w, ap3l),
                     opt=sum(op) / 5, eff=sum(sc) / sum(op), eff3=sum(sc[2:]) / sum(op[2:]), sd=S.pstdev(sc),
                     best=max(sc), bestshare=max(sc) / sum(sc), xw=xw, luck=W - xw, close=(sum(g["result"] == "W" for g in close), sum(g["result"] == "L" for g in close)),
                     off=offp / 5, idp=idpp / 5, weekly=sc, apweekly=[AP[w][f][0] for w in WEEKS],
                     res=[[g["result"] for g in TW[(w, f)]["games"]] for w in WEEKS]))
p12 = {r["fid"]: r["ppg12"] for r in rows}; p3 = {r["fid"]: r["ppg3"] for r in rows}; pf = {r["fid"]: r["ppg"] for r in rows}
for r in rows:
    r["rk12"], r["rk3"], r["rkfull"] = rank(p12, r["fid"]), rank(p3, r["fid"]), rank(pf, r["fid"])
rows.sort(key=lambda r: (-(r["apw"] / (r["apw"] + r["apl"])), -r["W"]))
print("%-18s %-5s %-6s %-7s %6s %6s %6s %4s->%-4s %5s %5s %5s %5s %6s %5s %5s %s" % ("owner","div","H2H","AP","PPG","PPG3","opt","rk12","rk3","eff","eff3","SD","best%","xW","luck","close","weekly AP wins / results"))
for r in rows:
    print("%-18s %-5s %2d-%-3d %3d-%-3d %6.1f %6.1f %6.1f %4d->%-4d %5.3f %5.3f %5.1f %5.2f %6.1f %+5.1f %d-%d  %s  %s" % (
        r["owner"], r["div"], r["W"], r["L"], r["apw"], r["apl"], r["ppg"], r["ppg3"], r["opt"], r["rk12"], r["rk3"], r["eff"], r["eff3"],
        r["sd"], r["bestshare"], r["xw"], r["luck"], r["close"][0], r["close"][1], r["apweekly"], ["".join(x) for x in r["res"]]))
json.dump(rows, open(DIR + "/teams.json", "w"), indent=1)
print("\nOFF/IDP per game:"); [print("  %-18s off %5.1f idp %5.1f" % (r["owner"], r["off"], r["idp"])) for r in rows]
