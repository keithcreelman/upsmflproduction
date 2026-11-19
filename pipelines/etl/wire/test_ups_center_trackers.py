#!/usr/bin/env python3
"""The arithmetic behind the UPS Center's trackers (Keith 2026-11-18), checked against the real Week 10 numbers he supplied:
  * Cross's Hurts + Lawrence = 332.0 vs Josh Martel's Williams + Jackson = 232.7, a 99.3 lead; a missed game is not a zero; future weeks are pending
  * the Hall of Shame: 154 comparisons, 31 wins is safe, 44 comparisons left after Week 10: Josh 24 wins needs 7, Cross 27 needs 4, Gerardi 32 is safe
  * the cap argument: Cross frees $2,000 with Addison on the active roster, $10,500 with him on injured reserve (counted at half)

Offline: tests/fixtures/qb_bet_hall_2026_wk10.json.    python3 pipelines/etl/wire/test_ups_center_trackers.py
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ups_center_trackers as TK       # noqa: E402

FX = json.load(open(os.path.join(HERE, "..", "..", "..", "tests", "fixtures", "qb_bet_hall_2026_wk10.json"), encoding="utf-8"))
fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "\n         %s" % str(detail)[:500]))
    if not cond:
        fails += 1


print("1. the quarterback bet")
rows = {p: {int(w): s for w, s in r.items()} for p, r in FX["scores"].items()}
bye = {t: set(w) for t, w in FX["byeWeeks"].items()}
status = lambda p, w: "bye" if w in bye[FX["teams"][p]] else "missed"
tb = TK.qb_table(rows, FX["sides"], 10, status)
check("17 weeks, 10 done and 7 pending", len(tb) == 17 and [r["state"] for r in tb].count("done") == 10 and tb[10]["state"] == "pending")
check("through Week 10: Cross 332.0, Josh 232.7, lead 99.3", (tb[9]["cum"]["cross"], tb[9]["cum"]["josh"], tb[9]["lead"]) == (332.0, 232.7, 99.3), tb[9])
check("the full-export figures: Hurts 99.2, Lawrence 232.8, Williams 135.6, Jackson 97.1",
      [round(sum(rows[p].values()), 1) for p in ("14783", "15237", "16579", "13593")] == [99.2, 232.8, 135.6, 97.1])
check("Week 8: Jackson played and scored 0.0 (not a miss)", tb[7]["pids"]["13593"] == ("played", 0.0), tb[7]["pids"])
check("Week 3: Williams missed a game his team played; Week 10: Williams on a bye", tb[2]["pids"]["16579"] == ("missed", None) and tb[9]["pids"]["16579"] == ("bye", None))
check("Week 7: Lawrence on a bye (no score), Cross's pair still totals 0.0 that week", tb[6]["pids"]["15237"] == ("bye", None) and tb[6]["pair"]["cross"] == 0.0)
check("cumulative = running sum of the pair totals, lead = Cross minus Josh, every week",
      all(abs(tb[i]["cum"]["cross"] - sum(t["pair"]["cross"] for t in tb[:i + 1])) < 0.051 and abs(tb[i]["lead"] - (tb[i]["cum"]["cross"] - tb[i]["cum"]["josh"])) < 0.051 for i in range(10)))
check("Josh Martel led after Weeks 1 and 2, Cross from Week 3", [tb[i]["lead"] < 0 for i in range(2)] == [True, True] and all(tb[i]["lead"] > 0 for i in range(2, 10)), [r["lead"] for r in tb[:10]])

print("2. the Hall of Shame: All-Play through ALL 17 weeks, playoffs included (Keith 2026-11-19)")
h = TK.hall_rows(FX["allplay"], 12, 17, 10)
check("187 comparisons, 38 wins is the no-tie minimum, 77 left after Week 10", (h["0007"]["games"], h["0007"]["safe"], h["0007"]["left"]) == (187, 38, 77), h["0007"])
check("Josh Martel (24-86) needs 14, Cross (27-83) needs 11, Gerardi (32-78) needs 6 and is NOT already safe",
      (h["0007"]["need"], h["0006"]["need"], h["0003"]["need"], h["0003"]["status"]) == (14, 11, 6, "candidate"), (h["0007"], h["0006"], h["0003"]))
check("38/187 = .203 is at or above .200; 37/187 = .198 is not", 38 / 187 >= 0.2 > 37 / 187)
check("a tie counts half: 37-100-1 (37.5) is safe, 36-100-2 (37.0) needs one more win",
      TK.hall_rows({"x": "37-100-1"}, 12, 17, 12)["x"]["need"] == 0 and TK.hall_rows({"x": "36-100-2"}, 12, 17, 12)["x"]["need"] == 1)
check("a team that cannot reach the line is locked in, and is inducted when Week 17 ends",
      TK.hall_rows({"x": "4-150-0"}, 12, 17, 14)["x"]["status"] == "locked" and TK.hall_rows({"x": "20-167-0"}, 12, 17, 17)["x"]["status"] == "inducted")
check("after the final week a team on the line is safe", TK.hall_rows({"x": "38-149-0"}, 12, 17, 17)["x"]["status"] == "safe")
# MFL standings that stop at the regular season: the playoff weeks are counted from the official weekly team scores
fids = ["%02d" % i for i in range(12)]
reg = {f: "%d-%d-0" % (i, 154 - i) for i, f in enumerate(fids)}               # 14 weeks x 11 = 154 comparisons
scores = {str(w): {f: 100.0 + i for i, f in enumerate(fids)} for w in (15, 16, 17)}
got = TK.hall_allplay(reg, 12, 14, 17, scores)
check("standings that stop at Week 14 are extended with Weeks 15-17 from the team scores (187 comparisons each; the top scorer gains 33 wins)",
      all(sum(int(x) for x in v.split("-")) == 187 for v in got.values()) and got["11"] == "%d-%d-0" % (11 + 33, 154 - 11), got["11"])
check("standings that already count the playoffs are used as they are",
      TK.hall_allplay({f: "%d-%d-0" % (i, 187 - i) for i, f in enumerate(fids)}, 12, 14, 17, None)["05"] == "5-182-0")
try:
    TK.hall_allplay({f: "1-1-0" for f in fids}, 12, 14, 17, scores)
    check("standings that are neither complete nor the regular season are refused", False)
except ValueError:
    check("standings that are neither complete nor the regular season are refused", True)

print("3. the cap argument")
c = FX["cap"]
check("Addison on the active roster: Cross frees only $2,000", -TK.cap_effect(c["lawrenceSalary"], c["capSpace"], c["addisonSalary"]) == 2000)
check("Addison on injured reserve (half salary): the trade frees $10,500", -TK.cap_effect(c["lawrenceSalary"], c["capSpace"], c["addisonSalary"], ir_got=True) == 10500)

print("FAIL" if fails else "ALL PASS")
sys.exit(1 if fails else 0)
