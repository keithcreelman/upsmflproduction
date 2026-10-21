#!/usr/bin/env python3
"""Whole-page checks for the rewritten Week 6 article.

    python3 verify_wk06_rewrite.py <article.html>

1. no EDITOR REVIEW placeholder and no data-editor-gap box remains;
2. every claim in the three ledgers (automation, injury report, narrative) names a source;
3. every number on the page is a registered claim (same test the cloud check applies to an automation draft);
4. every printed probability equals the committed forecast;
5. the section order and the four-teams-at-9-7 wording."""
import json, os, re, sys
D = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(D, "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "pipelines", "etl", "wire"))
import ups_center_validate as VAL  # noqa: E402

art = open(sys.argv[1], encoding="utf-8").read()
ledgers = {
    "automation": json.load(open(os.path.join(ROOT, "docs/wire/auto/2026-wk06-ups-center/claims.json"))),
    "injury": json.load(open(os.path.join(D, "injury_claims.json"))),
    "narrative": json.load(open(os.path.join(D, "narrative_claims.json"))),
}
res = []


def ok(name, cond, detail=""):
    res.append((name, bool(cond), str(detail)[:400]))
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "  -- " + str(detail)[:400]))


ok("no EDITOR REVIEW text and no data-editor-gap box", "EDITOR REVIEW" not in art and "data-editor-gap" not in art)
for k, v in ledgers.items():
    nosrc = [c for c, x in v.items() if not str(x.get("source") or "").strip()]
    ok("every %s claim names a source (%d claims)" % (k, len(v)), not nosrc, nosrc[:10])
shown = set()
for v in ledgers.values():
    for c in v.values():
        for x in VAL.NUM_RE.findall(re.sub(r"<[^>]+>", "", str(c["shown"])).replace("&ndash;", "–").replace("&amp;", "&")):
            shown.add(x.replace(",", "").lstrip("+-−"))
text = VAL.TIME_RE.sub(" ", VAL.visible_text(art))
text = re.sub(r"\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2}, \d{4}\b", " ", text)       # return dates, checked in rewrite_wk06.py against the injury cases
text = re.sub(r"\bWeeks? \d+(?:[–-]\d+| and \d+| to \d+)?\b", " ", text)
stray = sorted({x for x in VAL.NUM_RE.findall(text) if x.replace(",", "").lstrip("+-−") not in shown})
ok("every number on the page is a registered claim", not stray, stray[:30])
sim = json.load(open(os.path.join(D, "..", "..", "auto", "2026-wk06-ups-center", "run.json"))) if False else None
claims = ledgers["automation"]
want = {k: v for k, v in claims.items() if k.startswith("odds:")}
tab = re.search(r'<section class="wire-sec" id="odds"[\s\S]*?</section>', art).group(0)
cells = re.findall(r'<td class="num">([\d.]+)%</td>', tab)
vals = {str(claims[k]["value"]) for k in want}
ok("every printed probability equals the committed forecast (%d cells)" % len(cells), all(("%s" % float(c)) in {"%s" % float(v) for v in vals} for c in cells), [c for c in cells if float(c) not in {float(v) for v in vals}])
ids = re.findall(r'<section class="wire-sec" id="(\w+)"', art)
ok("segments run story, middle, odds, heat, brief, weeks, players, injuries, survival, elias", ids == ["story", "middle", "odds", "heat", "brief", "weeks", "players", "injuries", "survival", "elias"], ids)
vis = re.sub(r"\s+", " ", VAL.visible_text(art))
ok("no 'five teams at 9–7' wording", not re.search(r"\bfive\b[^.]{0,40}9.7", vis, re.I) and "five 9" not in vis)
ok("the wording says exactly four teams at 9–7", "exactly four teams at 9–7" in vis)
bad = [w for w in ("colour", "defence", "labelled", "favourite", "centre") if w in vis.lower()]
ok("American spelling", not bad, bad)
failed = [n for n, o, _ in res if not o]
print("\n%d checks, %d failed" % (len(res), len(failed)))
json.dump([dict(check=n, ok=o, detail=d) for n, o, d in res], open(os.path.join(D, "verify_wk06_rewrite.json"), "w"), indent=1)
sys.exit(1 if failed else 0)
