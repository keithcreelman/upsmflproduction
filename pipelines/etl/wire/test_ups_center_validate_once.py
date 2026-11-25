#!/usr/bin/env python3
"""Offline regression test: the UPS Center validator computes each cached truth table ONCE per validation.
   python3 pipelines/etl/wire/test_ups_center_validate_once.py
   python3 pipelines/etl/wire/test_ups_center_validate_once.py --write-golden   (regenerate the golden reports; review the diff)

Why: validate() memoizes five expensive calculations per call in a dict `n`. The memo was written as
`n.setdefault(key, f(ctx))`, which evaluates f(ctx) BEFORE setdefault looks at the key, so every claim of that kind
recomputed the whole table and the stored copy was never used (about 95% of the Week 8 test's time). The fix computes on
the first claim only. This file proves two things on the recorded Week 4 and Week 8 fixtures:
  1. each calculation runs at most once per validate() call, on scenarios that carry many claims of that kind
     (so an eager call would have run it dozens of times);
  2. the validation REPORT is unchanged: the golden file holds the reports the old, eager code produced
     (tests/fixtures/ups_center_auto/validate_once.golden.json), and the new code must match them exactly,
     including the failure messages for tampered claims.
Nothing here touches the network, D1, GitHub or Discord.
"""
import copy
import hashlib
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import ups_center_issue as ISSUE          # noqa: E402
import ups_center_validate as VAL         # noqa: E402

ROOT = os.path.join(HERE, "..", "..", "..")
FX4 = os.path.join(ROOT, "tests", "fixtures", "ups_center_auto", "2026_wk04")
FX8 = os.path.join(ROOT, "tests", "fixtures", "ups_center_auto", "2026_wk08")
GOLDEN = os.path.join(ROOT, "tests", "fixtures", "ups_center_auto", "validate_once.golden.json")
PACK4 = json.load(open(os.path.join(FX4, "pack.json")))
CTX4 = json.load(open(os.path.join(FX4, "context.json")))
HIST4 = json.load(open(os.path.join(FX4, "history.json")))
CTX8 = json.load(open(os.path.join(FX8, "context.json")))
# These scenarios test validation, not the forecast gate: their recorded forecasts were simulated before the playoff-ladder
# correction (canon §F.1, 2026-11-25), so mark them as the corrected run the builder now requires (else every scenario would
# carry an odds:rule blocker instead of its Playoff Picture). test_ups_center_auto.py tests the blocker itself.
import season_sim as _SS  # noqa: E402
for _c in (CTX4, CTX8):
    if (_c.get("forecast") or {}).get("sim"):
        _c["forecast"]["sim"]["seedingRule"] = _SS.SEEDING_RULE
PACK8 = json.load(open(os.path.join(ROOT, "site", "wire", "packs", "2026", "2026-wk08-recap.pack.json")))
T0 = 1791475200

# the five memoized calculations, by the name validate() calls them
GUARDED = ("_season_truth", "_trig_truth", "_archive_truth", "_table_counts", "_trade_binding")
calls = {}
for _name in GUARDED:
    def _wrap(*a, _orig=getattr(VAL, _name), _n=_name, **k):
        calls[_n] = calls.get(_n, 0) + 1
        return _orig(*a, **k)
    setattr(VAL, _name, _wrap)

fails = 0


def check(name, cond, detail=""):
    global fails
    print(("  ok   " if cond else "  FAIL ") + name + ("" if cond else "\n         %s" % str(detail)[:600]))
    if not cond:
        fails += 1


# a big executed trade, copied from test_ups_center_auto.py section S11 (same shape the story builder consumes)
SYN = {"timestamp": 1794338860, "a": "0008", "b": "0011", "a_salary": 77000.0, "b_salary": 60000.0,
       "a_gave": [{"kind": "player", "id": "15789", "name": "Test Receiver", "pos": "WR", "team": "GBP", "salary": 45000.0, "years": "1", "status": "Vet"},
                  {"kind": "player", "id": "17501", "name": "Test Runner", "pos": "RB", "team": "CLE", "salary": 32000.0, "years": "3", "status": "Vet"},
                  {"kind": "pick", "origin": "0005", "year": 2027, "round": 1}],
       "b_gave": [{"kind": "player", "id": "16161", "name": "Test Quarterback", "pos": "QB", "team": "ATL", "salary": 60000.0, "years": "2", "status": "Vet"}]}
RAW_SYN = {"timestamp": str(SYN["timestamp"]), "franchise": "0008", "franchise2": "0011",
           "franchise1_gave_up": "15789,17501,FP_0005_2027_1", "franchise2_gave_up": "16161"}


def with_trade(c):
    c["tradeInfo"] = [copy.deepcopy(SYN)]
    c["mfl"]["trades"] = [dict(RAW_SYN)]
    pre = copy.deepcopy(c["forecast"]["sim"])
    pre["teams"]["0008"]["po"] = max(0.0, pre["teams"]["0008"]["po"] - 0.12)
    pre["teams"]["0011"]["title"] = max(0.0, pre["teams"]["0011"]["title"] - 0.03)
    c["forecastPre"] = pre


def render(ctx, pack, fmt=None, mut=None):
    c, p = copy.deepcopy(ctx), copy.deepcopy(pack)
    if mut:
        mut(c)
    kw = {"generated_at": T0, "local_candidates": True}
    if fmt:
        kw["fmt"] = fmt
    return ISSUE.render(p, c, **kw), c, p


def kinds(res):
    out = {}
    for k in res["claims"]:
        out[k.partition(":")[0]] = out.get(k.partition(":")[0], 0) + 1
    return out


def inject_table_claims(res):
    """No page builder emits the Big Story table claims today, but the validator still checks them; register three so the
    table-count calculation is exercised by many claims of its kind."""
    cl = copy.deepcopy(res["claims"])
    for name in ("champs", "runnerup", "tablek"):
        cl["arch:" + name] = {"value": 1, "shown": "1", "source": "synthetic: regression test for the memo"}
    return dict(res, claims=cl)


def validated(res, c, p):
    calls.clear()
    return VAL.validate(res, c, p), dict(calls)


def tamper(res, prefix, mutate):
    cl = copy.deepcopy(res["claims"])
    key = sorted(k for k in cl if k.startswith(prefix))[0]
    cl[key]["value"] = mutate(cl[key]["value"])
    return dict(res, claims=cl), key


def fingerprint(rep):
    blob = json.dumps(rep, sort_keys=True, default=str).encode("utf-8")
    return {"ok": rep["ok"], "publishable": rep["publishable"], "errors": rep["errors"], "warnings": rep["warnings"],
            "checkedClaims": rep["checkedClaims"], "sha256": hashlib.sha256(blob).hexdigest()}


reports, counts, claim_kinds = {}, {}, {}


def scenario(name, res, c, p):
    rep, n = validated(res, c, p)
    reports[name], counts[name], claim_kinds[name] = fingerprint(rep), n, kinds(res)
    return rep


print("1. build the scenarios (Week 4 and Week 8 recorded fixtures)")
r4, c4, p4 = render(CTX4, PACK4, "legacy")
scenario("wk04_legacy_valid", r4, c4, p4)
rh, ch, ph = render(CTX4, PACK4, "legacy", lambda c: c.update(history=HIST4))
scenario("wk04_history_valid", rh, ch, ph)
r8, c8, p8 = render(CTX8, PACK8)
scenario("wk08_story_valid", r8, c8, p8)
rt, ct, pt = render(CTX8, PACK8, None, with_trade)
scenario("wk08_trade_valid", rt, ct, pt)
rt2, ct2, pt2 = render(CTX8, PACK8, None, with_trade)
scenario("wk08_table_claims", inject_table_claims(rt2), ct2, pt2)

bad_heat, k_heat = tamper(rh, "heat:bench:", lambda v: round(v + 1.0, 1))
scenario("wk04_history_bad_heat", bad_heat, ch, ph)
bad_trig, k_trig = tamper(r8, "trig:", lambda v: v + 10 if isinstance(v, (int, float)) else v)
scenario("wk08_bad_trig", bad_trig, c8, p8)
bad_arch, k_arch = tamper(r8, "arch:n", lambda v: v + 7)
scenario("wk08_bad_arch", bad_arch, c8, p8)
bad_trade, k_trade = tamper(rt, "trade:sal:a", lambda v: 99999.0)
scenario("wk08_bad_trade", bad_trade, ct, pt)

print("2. the scenarios really carry many claims of each kind (an eager call would have run once per claim)")
check("Week 4 + history carries 144 heat/hist claims", claim_kinds["wk04_history_valid"].get("heat", 0) + claim_kinds["wk04_history_valid"].get("hist", 0) >= 100, claim_kinds["wk04_history_valid"])
check("Week 8 carries trig and arch claims", claim_kinds["wk08_story_valid"].get("trig", 0) >= 2 and claim_kinds["wk08_story_valid"].get("arch", 0) >= 10, claim_kinds["wk08_story_valid"])
check("the trade scenario carries several trade claims", claim_kinds["wk08_trade_valid"].get("trade", 0) >= 3, claim_kinds["wk08_trade_valid"])
check("the table-count scenario carries three arch table claims",
      claim_kinds["wk08_table_claims"].get("arch", 0) == claim_kinds["wk08_trade_valid"].get("arch", 0) + 3, (claim_kinds["wk08_table_claims"], claim_kinds["wk08_trade_valid"]))
check("tamper targets exist: heat %s, trig %s, arch %s, trade %s" % (k_heat, k_trig, k_arch, k_trade), all((k_heat, k_trig, k_arch, k_trade)))

print("3. each calculation runs at most once per validate() call, and at least once where its claims are present")
EXPECT_ONCE = {
    "wk04_history_valid": ("_season_truth",),
    "wk08_story_valid": ("_season_truth", "_trig_truth", "_archive_truth"),
    "wk08_trade_valid": ("_season_truth", "_trig_truth", "_archive_truth", "_trade_binding"),
    "wk08_table_claims": ("_season_truth", "_trig_truth", "_archive_truth", "_trade_binding", "_table_counts"),
    "wk04_history_bad_heat": ("_season_truth",),
    "wk08_bad_trig": ("_season_truth", "_trig_truth", "_archive_truth"),
    "wk08_bad_arch": ("_season_truth", "_trig_truth", "_archive_truth"),
    "wk08_bad_trade": ("_season_truth", "_trig_truth", "_archive_truth", "_trade_binding"),
}
for name, want in EXPECT_ONCE.items():
    got = counts[name]
    check("%s: %s run exactly once each (saw %s)" % (name, ", ".join(want), got),
          all(got.get(f) == 1 for f in want) and set(got) <= set(want), got)
check("Week 4 legacy has no memoized claims, so none of the calculations run", counts["wk04_legacy_valid"] == {}, counts["wk04_legacy_valid"])
check("no calculation ever runs more than once in any scenario", all(v <= 1 for n in counts.values() for v in n.values()), counts)

print("4. a second validation starts clean: it computes once again and returns the same report (no memo leaks across calls)")
rep_a, n_a = validated(r8, c8, p8)
rep_b, n_b = validated(r8, c8, p8)
check("two successive validations each compute once", n_a == n_b == counts["wk08_story_valid"] and all(v == 1 for v in n_a.values()) and n_a, (n_a, n_b))
check("the memo keys are removed from the report's claim counts", not any(k.startswith("_") for k in rep_a["checkedClaims"]), rep_a["checkedClaims"])
check("the two reports are identical", json.dumps(rep_a, sort_keys=True, default=str) == json.dumps(rep_b, sort_keys=True, default=str))

print("5. the validation report is unchanged by the fix (golden = what the old eager code produced)")
check("the tampered claims are caught with the same messages (each names its claim)",
      any(k_heat in e for e in reports["wk04_history_bad_heat"]["errors"])
      and any(k_trig in e for e in reports["wk08_bad_trig"]["errors"])
      and any(k_arch in e for e in reports["wk08_bad_arch"]["errors"])
      and any(k_trade in e for e in reports["wk08_bad_trade"]["errors"]),
      {k: v["errors"][:2] for k, v in reports.items() if k.startswith(("wk04_history_bad", "wk08_bad"))})
check("the valid scenarios still validate", all(reports[k]["ok"] for k in ("wk04_legacy_valid", "wk04_history_valid", "wk08_story_valid", "wk08_trade_valid")),
      {k: reports[k]["errors"][:2] for k in reports if not reports[k]["ok"]})
if "--write-golden" in sys.argv:
    with open(GOLDEN, "w", encoding="utf-8") as fh:
        json.dump(reports, fh, indent=1, sort_keys=True)
        fh.write("\n")
    print("  wrote %s (%d scenarios)" % (os.path.relpath(GOLDEN, ROOT), len(reports)))
else:
    golden = json.load(open(GOLDEN, encoding="utf-8"))
    check("the golden file covers exactly these scenarios", sorted(golden) == sorted(reports), (sorted(golden), sorted(reports)))
    for name in sorted(reports):
        same = golden.get(name) == reports[name]
        check("report identical to the golden: %s" % name, same,
              None if same else {"golden": {k: v for k, v in (golden.get(name) or {}).items() if k != "sha256"},
                                 "now": {k: v for k, v in reports[name].items() if k != "sha256"}})

print("\nALL PASS" if not fails else "\n%d FAILED" % fails)
sys.exit(1 if fails else 0)
