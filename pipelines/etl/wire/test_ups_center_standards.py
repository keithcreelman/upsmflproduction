#!/usr/bin/env python3
"""Offline tests for the UPS Center's editorial standards (Keith 2026-10-27), against the recorded Week 7 issue and constructed
edge cases. Nothing here touches the network, D1 or Discord.
   python3 pipelines/etl/wire/test_ups_center_standards.py

  1. Probabilities: nothing prints as 100% or 0% unless the clinching engine (site/shared/standings_clinch.js, run through node)
     says clinched or eliminated; probabilities near 0 and 1 print to two decimals or as <0.01%; the ledger keeps the exact percent.
  2. Lineup decisions: a hindsight lineup is judged by MFL's PREGAME projections (captured before each player's own kickoff); a
     start the projections supported is variance, not a mistake; no pregame projection means no verdict.
  3. The validator refuses the old hindsight sentence and any 100.0% / 0.0%.
"""
import copy
import html as H
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ups_center_issue as ISSUE      # noqa: E402
import ups_center_lineup as LINEUP    # noqa: E402
import ups_center_prob as PROB        # noqa: E402
import ups_center_validate as VAL     # noqa: E402

FX = os.path.join(HERE, "..", "..", "..", "tests", "fixtures", "ups_center_auto")
CTX7 = json.load(open(os.path.join(FX, "2026_wk07", "context.json")))
PACK7 = json.load(open(os.path.join(FX, "2026_wk07", "pack.json")))
SCHED = json.load(open(os.path.join(FX, "mfl_schedule_2026.json")))
HAVE_NODE = bool(shutil.which("node"))
T0 = 1793200000
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "\n         %s" % str(detail)[:400]))
    if not cond:
        fails += 1


def render(ctx):
    pack = copy.deepcopy(PACK7)
    res = ISSUE.render(pack, ctx, generated_at=T0, local_candidates=True)
    return res, VAL.validate(res, ctx, pack)


def page_text(res):
    t = re.sub(r"<style[\s\S]*?</style>|<script[\s\S]*?</script>", " ", res["html"])
    return re.sub(r"\s+", " ", H.unescape(re.sub(r"<[^>]+>", " ", t)))


def shift(ctx, key, src, dst, amount):
    """Move probability mass between two teams so every forecast total still holds. The Week 8 scenario cells are the same
    simulated seasons as the odds, so an edited forecast drops them (the preview gap is unrelated to what is tested here)."""
    ctx["forecast"]["preview"] = None
    t = ctx["forecast"]["sim"]["teams"]
    t[src][key] = round(t[src][key] - amount, 6)
    t[dst][key] = round(t[dst][key] + amount, 6)


BEAR, CROSS, JOSH = "0009", "0006", "0007"

print("1. how a probability prints")
check("0.9996 prints 99.96%, 0.00004 prints <0.01%, 0.0004 prints 0.04%", (PROB.text(0.9996), PROB.text(0.00004), PROB.text(0.0004)) == ("99.96%", "<0.01%", "0.04%"))
check("exactly 1.0 and 0.0 are NOT certainties: 99.99% and <0.01%", (PROB.text(1.0), PROB.text(0.0)) == ("99.99%", "<0.01%"))
check("only a clinched / eliminated outcome prints 100% / 0%", (PROB.text(1.0, high=True), PROB.text(0.0, low=True)) == ("100%", "0%"))
bad = []
for i in range(0, 100001):
    p = i / 100000.0
    t = PROB.text(p)
    if re.fullmatch(r"(100|0)(\.0+)?%", t) or float(t.lstrip("<").rstrip("%")) > 100:
        bad.append((p, t))
check("a sweep of 100,001 probabilities from 0 to 1 never prints 100% or 0%", not bad, bad[:3])
check("the middle keeps one decimal, the ends two", (PROB.text(0.5), PROB.text(0.9995), PROB.text(0.001), PROB.text(0.9990)) == ("50.0%", "99.95%", "0.1%", "99.9%"))
check("the ledger value keeps the simulation's precision (4 decimals), not the printed rounding", PROB.value(0.99963) == 99.963 and PROB.value(0.0, low=True) == 0.0)
check("an outcome cannot be both clinched and eliminated", (lambda: [PROB.text(0.5, True, True)])() if False else True)
try:
    PROB.text(0.5, True, True)
    check("a clinched-and-eliminated flag pair is refused", False)
except ValueError:
    check("a clinched-and-eliminated flag pair is refused", True)
audit = PROB.audit({"a": "100.0%", "b": "99.96%", "c": "0%", "d": "0.0%"}, {"c": True})
check("audit flags 100.0% and 0.0% and passes a flagged 0%", len(audit) == 2 and all("neither clinched nor eliminated" in x for x in audit), audit)
rounded = {"a": "100.0", "b": "0.0", "c": "0.0"}
cells = PROB.group_cells({"a": 0.99998, "b": 0.00001, "c": 0.00001}, rounded)
check("a group cell the largest-remainder rounding would print as 100.0 or 0.0 prints honestly instead",
      [v[0] for v in cells.values()] == ["99.99%", "<0.01%", "<0.01%"], cells)

print("2. the clinching engine decides certainty (node)")
if not HAVE_NODE:
    print("  skip  node is not installed: the engine-backed checks below are skipped (the rule itself fails closed without it)")
else:
    DIV = lambda i: "ABCD"[(i - 1) % 4]
    f = lambda i: str(i).zfill(4)

    def league(over):
        teams = []
        for i in range(1, 13):
            o = over.get(i, {})
            teams.append({"fid": f(i), "division": DIV(i), "h2h": o.get("h2h", {"w": 13, "l": 13, "t": 0}), "ap": o.get("ap", {"w": 70, "l": 73, "t": 0})})
        return teams

    spaced = lambda i: {"w": 132 - 12 * (i - 1), "l": 143 - (132 - 12 * (i - 1)), "t": 0}
    settled = {i: {"ap": spaced(i), "h2h": {"w": 24, "l": 2, "t": 0} if i <= 4 else {"w": 6, "l": 20, "t": 0}} for i in range(1, 13)}
    fl = PROB.clinch_flags(league(settled), {f(i): 28 for i in range(1, 13)}, 11)
    check("a settled league: seeds 1-6 clinched a spot, 7-12 eliminated, only the top two hold byes",
          all(fl[f(i)]["x"] for i in range(1, 7)) and all(fl[f(i)]["e"] for i in range(7, 13)) and fl[f(1)]["z"] and fl[f(2)]["z"] and not fl[f(3)]["z"], fl)
    check("so a clinched team prints 100% for the playoffs and 0% for the eliminated one",
          PROB.single(0.9999, "po", fl[f(1)])[0] == "100%" and PROB.single(0.0001, "po", fl[f(12)])[0] == "0%" and PROB.single(0.9, "bye", fl[f(3)])[0] == "90.0%")
    check("a clinched spot is not a clinched bye, division or title", PROB.single(0.9999, "bye", fl[f(3)])[0] == "99.99%" and PROB.single(0.9999, "title", fl[f(1)])[0] == "99.99%")
    open_ = PROB.clinch_flags(league({}), {f(i): 28 for i in range(1, 13)}, 11)
    check("a wide-open league: nobody is clinched or eliminated, so nothing may print as certain", not any(any(v.values()) for v in open_.values()), open_)
    check("no node, no schedule, unreadable input -> no flags (fail closed)", PROB.clinch_flags(league({}), None, 11, node="/nonexistent/node") == {})
    real = PROB.compute_clinch(CTX7["mfl"]["standings"], {k: v["division"] for k, v in CTX7["d1"]["franchises"].items()}, 7, 16, SCHED)
    check("the recorded Week 7 standings and MFL schedule: the engine runs, with the schedule, and nobody is clinched or eliminated",
          real["status"] == "ok" and real["schedule"] and not any(any(v.values()) for v in real["byFid"].values()), real)

print("3. the recorded Week 7 issue")
res7, val7 = render(CTX7)
t7 = page_text(res7)
check("it validates", val7["ok"], val7["errors"][:3])
check("Bear's playoff odds read 99.96%, never 100.0%; Cross's zero-odds cells read <0.01%, never 0.0%",
      "99.96%" in t7 and "100.0%" not in t7 and "<0.01%" in t7 and not re.search(r"(?<![\d.])0\.0%", t7))
check("the ledger keeps the exact percent beside the printed text", res7["claims"]["odds:po:" + BEAR]["raw"] == 99.96 and res7["claims"]["odds:po:" + BEAR]["shown"] == "99.96%")
check("the recorded Week 7 forecast has teams at exactly 1.0-adjacent and 0.0 values the old table printed as 100.0% / 0.0%",
      CTX7["forecast"]["sim"]["teams"][BEAR]["po"] >= 0.9995 and any(t["bye"] == 0 for t in CTX7["forecast"]["sim"]["teams"].values()))
check("the issue says why a figure is not a certainty (caption)", "clinched or eliminated" in t7)

print("4. near the ends, and with the engine's flags")
c = copy.deepcopy(CTX7)
shift(c, "po", CROSS, BEAR, round(0.9999 - c["forecast"]["sim"]["teams"][BEAR]["po"], 6))      # Bear to 0.9999, Cross absorbs the rest
r, v = render(c)
check("a forecast of 0.9999 prints 99.99% (not 100.0%) and still validates", v["ok"] and "99.99%" in page_text(r) and "100.0%" not in page_text(r), v["errors"][:2])
c = copy.deepcopy(CTX7)
c["clinch"] = {"status": "ok", "byFid": {fid: dict(x=False, y=False, z=False, e=False) for fid in c["d1"]["franchises"]}}
c["clinch"]["byFid"][BEAR]["x"] = True
shift(c, "po", CROSS, BEAR, round(1.0 - c["forecast"]["sim"]["teams"][BEAR]["po"], 6))
r, v = render(c)
check("clinched (engine flag + forecast 1.0): the playoff cell prints 100% and the issue validates", v["ok"] and r["claims"]["odds:po:" + BEAR]["shown"] == "100%", v["errors"][:2])
c2 = copy.deepcopy(c)
c2["clinch"]["byFid"][BEAR]["x"] = False
v2 = VAL.validate(r, c2, copy.deepcopy(PACK7))
check("the same page is refused when the engine does NOT say clinched (a rounded simulation is not certainty)", not v2["ok"], v2["errors"][:2])
c = copy.deepcopy(CTX7)
c["clinch"] = {"status": "ok", "byFid": {fid: dict(x=False, y=False, z=False, e=False) for fid in c["d1"]["franchises"]}}
c["clinch"]["byFid"][CROSS]["e"] = True
t = c["forecast"]["sim"]["teams"]
for key in ("po", "bye", "div", "title"):
    shift(c, key, CROSS, JOSH, t[CROSS][key])
r, v = render(c)
check("eliminated (engine flag + forecast 0): all four cells print 0% and the issue validates",
      v["ok"] and all(r["claims"]["odds:%s:%s" % (k, CROSS)]["shown"] == "0%" for k in ("po", "bye", "div", "title")), v["errors"][:2])

print("5. lineup decisions")


def rows_of(pairs):
    return [dict(pid=str(i), name="P%d" % i, pos_group=g, status=s, score=sc) for i, (g, s, sc) in enumerate(pairs)]


BASE = [("QB", "starter", 10), ("QB", "starter", 9), ("RB", "starter", 5), ("RB", "starter", 5), ("RB", "starter", 4), ("WR", "starter", 5),
        ("WR", "starter", 5), ("WR", "starter", 5), ("TE", "starter", 3), ("DL", "starter", 3), ("DL", "starter", 3), ("LB", "starter", 3),
        ("LB", "starter", 3), ("DB", "starter", 3), ("DB", "starter", 3), ("DB", "starter", 3), ("PK", "starter", 5), ("PN", "starter", 5),
        ("RB", "bench", 30)]
ROWS = rows_of(BASE)
OUT, IN = "4", "18"                                                # the RB (4.0) a 30-point bench RB would replace
pj = lambda pid, v: {"value": v, "captured": 100, "kickoff": 200}
j = LINEUP.judge(ROWS, {OUT: pj(OUT, 9.0), IN: pj(IN, 5.0)})
check("the starter out-projected the bench player: reasonable, and the sentence calls it variance, not a decision",
      j["summary"] == "reasonable" and "scoring variance, not a lineup decision" in LINEUP.sentence(j, "x")[0], j)
j = LINEUP.judge(ROWS, {OUT: pj(OUT, 5.0), IN: pj(IN, 9.0)})
check("the bench player out-projected the starter by more than a point: a miss, with both projections in the sentence",
      j["summary"] == "miss" and "against the projections" in LINEUP.sentence(j, "x")[0] and LINEUP.sentence(j, "x")[1] == [9.0, 5.0], j)
coin = LINEUP.sentence(LINEUP.judge(ROWS, {OUT: pj(OUT, 5.0), IN: pj(IN, 6.0)}), "x")[0]      # Codex MAT-1: bench 6.0 vs starter 5.0
check("the one-point coin flip does NOT say MFL favored the starters: it says there was no clear reason to change the lineup",
      "favored his starters" not in coin and "showed no clear reason to change the lineup" in coin and "scoring variance, not a lineup decision" in coin, coin)
check("an equal projection is not a bench edge: the starters were not out-projected, so 'favored his starters' is not claimed falsely either",
      "favored his starters" in LINEUP.sentence(LINEUP.judge(ROWS, {OUT: pj(OUT, 5.0), IN: pj(IN, 5.0)}), "x")[0])
ROWS2 = ROWS + rows_of([("WR", "bench", 25)])[:0] + [dict(pid="19", name="P19", pos_group="WR", status="bench", score=25.0)]
sw2 = LINEUP.judge(ROWS2, {})["swaps"]
part = LINEUP.judge(ROWS2, {sw2[0]["out"]["pid"]: pj("o", 5.0), sw2[0]["in"]["pid"]: pj("i", 6.0)})
ptxt = LINEUP.sentence(part, "x")[0]
check("two changes, one a coin flip and one with no pregame projection: the partial sentence also never claims the starters were favored",
      part["summary"] == "partial" and "favored his starters" not in ptxt and "showed no clear reason to change the lineup" in ptxt
      and "does not call those a mistake" in ptxt, (part["summary"], ptxt))
check("a one-point pregame edge is a coin flip, not a miss; one point and a tenth is",
      LINEUP.judge(ROWS, {OUT: pj(OUT, 5.0), IN: pj(IN, 6.0)})["summary"] == "reasonable" and LINEUP.judge(ROWS, {OUT: pj(OUT, 5.0), IN: pj(IN, 6.1)})["summary"] == "miss")
j = LINEUP.judge(ROWS, {OUT: pj(OUT, 5.0)}, {IN: "captured after his kickoff"})
txt = LINEUP.sentence(j, "x")[0]
check("one of the two has no pregame projection: unknown, and the sentence declines to judge",
      j["summary"] == "unknown" and "does not judge the lineup" in txt and "mistake" not in txt and "went against" not in txt, txt)
check("no projections at all: unknown, never invented", LINEUP.judge(ROWS, {})["summary"] == "unknown")
check("a team whose lineup was already the best has no swaps", LINEUP.judge(rows_of([(g, s, sc) for g, s, sc in BASE if s == "starter"]), {})["summary"] == "none")
check("the hindsight swap is a legal one (a bench RB cannot replace the QB)", all(s["out"]["pid"] != "0" for s in LINEUP.judge(ROWS, {})["swaps"]))

print("6. the recorded Week 7 desk lines")
sent = [t7[m.start():m.start() + 330] for m in re.finditer(r"His best lineup in hindsight", t7)]
check("every hindsight sentence names itself hindsight and none blames a start", len(sent) == 4 and all("hindsight" in x for x in sent) and not re.search(r"mistake|should have|blunder|wrong call", t7), sent)
check("kickoff-strict: Week 7's only captures came after the 1 PM kickoffs, so every one of the four says the report does not judge",
      sum("does not judge the lineup" in x for x in sent) == 4, sent)
c = copy.deepcopy(CTX7)
for fid, lineup in c["lineups"].items():                        # give every player a pregame projection equal to his score minus his rank noise
    for r_ in lineup:
        c["pregame"]["proj"][r_["pid"]] = {"value": 8.0 if r_["status"] == "starter" else 4.0, "captured": 1, "kickoff": 2}
r, v = render(c)
tt = page_text(r)
check("with pregame projections that favor every starter, the same four sentences call the gap variance", v["ok"] and tt.count("scoring variance, not a lineup decision") == 4, v["errors"][:2])
c = copy.deepcopy(CTX7)
for fid, lineup in c["lineups"].items():
    for r_ in lineup:
        c["pregame"]["proj"][r_["pid"]] = {"value": 4.0 if r_["status"] == "starter" else 9.0, "captured": 1, "kickoff": 2}
r, v = render(c)
check("with projections that favor the bench, the sentences cite both projections (and they are registered claims)",
      v["ok"] and page_text(r).count("went against the projections") == 4 and any(k.startswith("lineup:") for k in r["claims"]), v["errors"][:2])
c = copy.deepcopy(CTX7)
del c["lineups"]
r, v = render(c)
check("an issue with no lineup detail says so and blames nothing", v["ok"] and "has no lineup detail to judge" in page_text(r), v["errors"][:2])
r_old = copy.deepcopy(res7)
r_old["html"] = r_old["html"].replace("His best lineup in hindsight, 212.4, would have won a game he lost.", "His best available lineup, 212.4, would have won a game he lost.", 1)
v_old = VAL.validate(r_old, CTX7, copy.deepcopy(PACK7))
check("the validator refuses the old sentence (blame without the word hindsight)", not v_old["ok"] and any("hindsight blame" in e for e in v_old["errors"]), v_old["errors"][:2])
r_old = copy.deepcopy(res7)
r_old["html"] = r_old["html"].replace("99.96%", "100.0%", 1)
v_old = VAL.validate(r_old, CTX7, copy.deepcopy(PACK7))
check("the validator refuses a page that prints 100.0%", not v_old["ok"], v_old["errors"][:2])
check("the Heat Check labels the bench columns as hindsight, not as decisions", "hindsight, not a measure of lineup decisions" in t7 and "Losses a hindsight lineup would have won" in t7)

print("7. the source cannot drift back")
src = open(os.path.join(HERE, "ups_center_issue.py"), encoding="utf-8").read()
check("the issue formats odds only through ups_center_prob (no raw %.1f%% of a 100 * probability)", not re.search(r'"%\.\d+f%%"\s*%\s*\(100 \*', src))
check("the old hindsight sentence is gone from the issue source", "His best available lineup" not in src)

print()
print("ALL PASS" if not fails else "%d FAILURE(S)" % fails)
sys.exit(1 if fails else 0)
