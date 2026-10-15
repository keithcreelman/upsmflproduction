"""Apply Elias's official Week 5 changes to the live UPS Center Week 5 article (pre-authorized
post-publication correction, Keith 2026-10-14). Scores come from MFL's corrected weeklyResults
(mfl_wr5_elias.json, fetched 2026-10-15) and site/wire/data/elias_2026_wk05.json; every
replacement must match exactly once."""
import json, re, sys
ART = "site/wire/articles/2026/2026-wk05-ups-center.html"
W5 = sys.argv[1]
s = open(ART, encoding="utf-8").read()
wr = json.load(open(W5))["weeklyResults"]
score = {f["id"]: float(f["score"]) for m in wr["matchup"] for f in m["franchise"]}
rep = json.load(open("site/wire/data/elias_2026_wk05.json"))
moved = {t["fid"]: t for t in rep["teams"]}
assert set(moved) == {"0008", "0009"} and not rep["allplayChanged"] and rep["resultsFlipped"] == 0
assert score["0009"] == 280.5 and score["0008"] == 272.5
name = {"0009": "B. Dunn", "0008": "K. Creelman"}
opp = {"E. Martel": "0005", "B. Cross": "0006", "B. Cutting": "0004", "M. Gerardi": "0003", "D. Whitman": "0002", "S. Blake": "0010"}
CELL = r'(<td style="padding:\.4rem \.3rem;white-space:normal;line-height:1\.3;font-size:\.8rem"><b>%s</b> )%s(</td><td style="[^"]*"><b>%s</b> )%s(</td><td class="num" style="[^"]*">)%s(</td>)'
n = 0
for f, wins in (("0009", ("E. Martel", "B. Cross", "B. Cutting")), ("0008", ("M. Gerardi", "D. Whitman", "S. Blake"))):
    for o in wins:
        lo = score[opp[o]]
        old_w, new_w = moved[f]["before"], score[f]
        old_m, new_m = round(old_w - lo, 1), round(new_w - lo, 1)
        pat = CELL % (re.escape(name[f]), re.escape("%.1f" % old_w), re.escape(o), re.escape("%.1f" % lo), re.escape("%.1f" % old_m))
        s, k = re.subn(pat, lambda m: m.group(1) + "%.1f" % new_w + m.group(2) + "%.1f" % lo + m.group(3) + "%.1f" % new_m + m.group(4), s)
        assert k == 1, (f, o, k)
        n += 1
        print("row %s %.1f -> %.1f vs %s %.1f, margin %.1f -> %.1f" % (name[f], old_w, new_w, o, lo, old_m, new_m))
TEXT = [
    ("the top score of the week was Bear Dunn&rsquo;s 280.0,", "the top score of the week was Bear Dunn&rsquo;s 280.5,"),
    ("top scoring average over Weeks 3 to 5, 274.9 a week.", "top scoring average over Weeks 3 to 5, 275.1 a week."),
    ("And the team Bear just beat by 89.3 is", "And the team Bear just beat by 89.8 is"),
    ('<b>Not yet Elias-final.</b> Elias has not posted the official Week 5 stat changes yet. When it does, every change is added '
     'here, and the league hears about it if any All-Play record moves.',
     '<b>Elias-final.</b> Updated Thu Oct 15 with the official Week 5 changes Elias posted Wed Oct 14, 11:12 PM ET. '
     'Two moved UPS scores: Bear Dunn 280.0&nbsp;&rarr;&nbsp;280.5 (Alex Singleton, one more assist) and Keith Creelman '
     '271.5&nbsp;&rarr;&nbsp;272.5 (Zach Allen, two more QB hits). No result flipped and no All-Play record moved, so every '
     'standing holds and the scores above are the corrected ones; the playoff odds are still Tuesday&rsquo;s simulation.'),
    ("Scores are MFL&rsquo;s Week 5 results as of Tue Oct 13 and are not yet Elias-final; official changes will be added to "
     "the Elias segment when posted.",
     "Scores are MFL&rsquo;s Week 5 results, Elias-final: the official changes posted Wed Oct 14 moved two team scores and "
     "are applied throughout (see the Elias segment). The odds were simulated Tuesday, before them."),
]
for a, b in TEXT:
    assert s.count(a) == 1, a[:60]
    s = s.replace(a, b)
    n += 1
open(ART, "w", encoding="utf-8").write(s)
print("%d replacements" % n)
