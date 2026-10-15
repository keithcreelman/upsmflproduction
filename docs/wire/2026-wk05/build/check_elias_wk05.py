"""Independent check of the Elias correction: every Week 5 result row, the week's top score, Bear's
Weeks 3-5 average, the Bear-Eric margin and the Elias note, against MFL's corrected weeklyResults."""
import html as H, json, re, sys
art, wr5, M, rep = sys.argv[1], json.load(open(sys.argv[2])), json.load(open(sys.argv[3])), json.load(open(sys.argv[4]))
doc = open(art, encoding="utf-8").read()
txt = lambda h: re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", " ", h))).strip()
names = {f: r["owner_name"] for f, r in json.load(open(sys.argv[5]))["d1"]["franchises"].items()}
owner = {f: "%s. %s" % (n.split()[0][0], " ".join(n.split()[1:])) for f, n in names.items()}
sc = {f["id"]: float(f["score"]) for m in wr5["weeklyResults"]["matchup"] for f in m["franchise"]}
games = []
for m in wr5["weeklyResults"]["matchup"]:
    a, b = m["franchise"]
    w, l = (a, b) if float(a["score"]) > float(b["score"]) else (b, a)
    games.append((owner[w["id"]], float(w["score"]), owner[l["id"]], float(l["score"])))
rows = [txt(r) for r in re.findall(r"<tr><td[^>]*><b>[^<]+</b> [\d.]+</td><td[^>]*><b>[^<]+</b> [\d.]+</td><td class=\"num\"[^>]*>[\d.]+</td></tr>", doc)]
fails = []
for wn, ws, ln, ls in games:
    want = "%s %.1f %s %.1f %.1f" % (wn, ws, ln, ls, round(ws - ls, 1))
    if want not in rows:
        fails.append("result row missing: " + want)
print("week 5 games: %d, result rows on the page: %d" % (len(games), len(rows)))
top = max(sc, key=sc.get)
if ("the top score of the week was Bear Dunn’s %.1f," % sc[top]) not in txt(doc) or owner[top] != "B. Dunn":
    fails.append("top score line does not say Bear Dunn's %.1f" % sc[top])
def s_(wk, fid):
    src = wr5 if wk == 5 else M["weeklyResults_%d" % wk]
    return next(float(f["score"]) for m in src["weeklyResults"]["matchup"] for f in m["franchise"] if f["id"] == fid)
avg = round(sum(s_(w, "0009") for w in (3, 4, 5)) / 3 + 1e-9, 1)
if ("top scoring average over Weeks 3 to 5, %.1f a week." % avg) not in txt(doc):
    fails.append("Stuart's Weeks 3-5 average is not %.1f" % avg)
mg = round(sc["0009"] - sc["0005"], 1)
if ("And the team Bear just beat by %.1f is" % mg) not in txt(doc):
    fails.append("Rich's margin is not %.1f" % mg)
note = txt(re.search(r'<section class="wire-sec" id="elias"[\s\S]*?</section>', doc).group(0))
for t in rep["teams"]:
    nm = {"0008": "Keith Creelman", "0009": "Bear Dunn"}[t["fid"]]
    if "%s %.1f → %.1f" % (nm, t["before"], t["after"]) not in note:
        fails.append("Elias note lacks %s %.1f → %.1f" % (nm, t["before"], t["after"]))
if "Elias-final" not in note or "Not yet" in note:
    fails.append("Elias note is not Elias-final")
print("\n".join("FAIL " + f for f in fails) or "all Elias-correction checks pass")
sys.exit(1 if fails else 0)
