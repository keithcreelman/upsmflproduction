#!/usr/bin/env python3
"""Price one completed trade at a saved preview cutoff, without live fetches.

The saved inputs must reproduce the published preview before a counterfactual
is reported. Then only the traded players move back to their prior rosters;
banked scores, projections, injuries, schedule, and model seed stay fixed.
Future draft picks do not enter season_sim and are excluded from this estimate.
"""

import argparse
import copy
from datetime import datetime, timezone
import json
import os
import random

import season_sim as S
import week_preview as P


def load_inputs(path):
    blob = json.load(open(path, encoding="utf-8"))
    if blob.get("schema") != 1:
        raise ValueError("unsupported model-input snapshot")
    prep = blob["prep"]
    for key in ("sched", "proj", "rep"):
        prep[key] = {int(w): value for w, value in prep[key].items()}
    actual = {int(w): value for w, value in blob["actualScores"].items()}
    refresh_lineups(prep)
    return blob, prep, actual


def refresh_lineups(prep):
    prep["wp_raw"], prep["fills"], prep["parts"] = S.weekly_projections(
        prep["rosters"], prep["proj"], prep["end"], prep["rep"],
        reg_end=prep["reg_end"])


def player_ids(raw):
    return [part for part in raw.split(",") if part and not part.startswith("FP_")]


def reverse_trade(post, trade):
    pre = copy.deepcopy(post)
    a, b = trade["franchise"], trade["franchise2"]
    gave_a = player_ids(trade["franchise1_gave_up"])
    gave_b = player_ids(trade["franchise2_gave_up"])

    def move(pid, src, dst):
        matches = [row for row in pre["rosters"][src] if row["pid"] == pid]
        if len(matches) != 1 or any(row["pid"] == pid for row in pre["rosters"][dst]):
            raise ValueError("trade player %s is not uniquely on post-trade roster %s" % (pid, src))
        pre["rosters"][src].remove(matches[0])
        pre["rosters"][dst].append(matches[0])

    for pid in gave_a:
        move(pid, b, a)
    for pid in gave_b:
        move(pid, a, b)
    refresh_lineups(pre)
    return pre, {"fromFranchise1": gave_a, "fromFranchise2": gave_b}


def lineup_per_week(prep, fid, start):
    weeks = range(start, prep["reg_end"] + 1)
    return round(sum(prep["wp_raw"][fid][wk] for wk in weeks) / len(weeks), 2)


def odds_for(prep, actual, runs, seed, k):
    return P.run_state(prep, actual, k, runs, seed)


def fixed_noise_no_trade(pre, post_state, actual, runs, seed, k):
    """Second definition: change rosters while holding calibrated noise fixed."""
    agg, _ = S.simulate(
        pre["teams"], pre["sched"], S.regress(pre["wp_raw"], k),
        pre["reg_end"], pre["end"], runs,
        post_state["sigma_w"], post_state["sigma_s"], random.Random(seed),
        collect=True, actual=actual, posterior=None)
    return {fid: {"playoff": agg[fid]["po"] / runs, "title": agg[fid]["title"] / runs,
                  "division": agg[fid]["div"] / runs} for fid in pre["teams"]}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--inputs", required=True)
    ap.add_argument("--preview", required=True)
    ap.add_argument("--transactions", required=True)
    ap.add_argument("--trade-timestamp", required=True)
    ap.add_argument("--sensitivity-runs", type=int, default=0)
    ap.add_argument("--seed-check", default="",
                    help="comma-separated extra seeds; reruns both definitions at the published run count")
    ap.add_argument("--out", required=True)
    args = ap.parse_args()

    blob, post, actual = load_inputs(args.inputs)
    preview = json.load(open(args.preview, encoding="utf-8"))
    if (blob["season"], blob["week"], blob["previewGeneratedAtUtc"]) != (
            preview["season"], preview["week"], preview["generatedAtUtc"]):
        raise ValueError("input snapshot and published preview have different cutoffs")
    txs = json.load(open(args.transactions, encoding="utf-8"))["transactions"]["transaction"]
    matches = [tx for tx in txs if tx.get("type") == "TRADE"
               and tx.get("timestamp") == args.trade_timestamp]
    if len(matches) != 1:
        raise ValueError("expected exactly one trade at timestamp %s" % args.trade_timestamp)
    cutoff = datetime.fromisoformat(preview["generatedAtUtc"].replace("Z", "+00:00"))
    if datetime.fromtimestamp(int(args.trade_timestamp), timezone.utc) >= cutoff:
        raise ValueError("trade did not occur before the saved preview cutoff")
    trade = matches[0]
    pre, moved = reverse_trade(post, trade)
    runs, seed, k = preview["runs"], preview["seed"], preview["model"]["regress"]
    post_state = odds_for(post, actual, runs, seed, k)
    pre_state = odds_for(pre, actual, runs, seed, k)
    for row in preview["movement"]:
        fid = row["fid"]
        if (round(post_state["odds"][fid]["playoff"], 4) != row["enteringPlayoff"]
                or round(post_state["odds"][fid]["title"], 4) != row["enteringTitle"]
                or round(post_state["odds"][fid]["division"], 4) != row["enteringDivision"]):
            raise ValueError("saved inputs do not reproduce published odds for %s" % fid)
    fixed = fixed_noise_no_trade(pre, post_state, actual, runs, seed, k)

    owners = {row["fid"]: row["owner"] for row in preview["movement"]}
    teams = {}
    for fid in sorted(post["teams"]):
        current = post_state["odds"][fid]
        no_trade = pre_state["odds"][fid]
        teams[fid] = {
            "owner": owners[fid],
            "withTrade": {m: round(current[m], 4) for m in ("playoff", "title", "division")},
            "withoutTrade": {m: round(no_trade[m], 4) for m in ("playoff", "title", "division")},
            "fullRerunEffectPoints": {m: round(100 * (current[m] - no_trade[m]), 2)
                                      for m in ("playoff", "title", "division")},
            "fixedNoiseEffectPoints": {m: round(100 * (current[m] - fixed[fid][m]), 2)
                                       for m in ("playoff", "title", "division")},
            "lineupPerWeek": {"withTrade": lineup_per_week(post, fid, preview["week"]),
                              "withoutTrade": lineup_per_week(pre, fid, preview["week"])}
        }

    out = {
        "schema": 1, "season": preview["season"], "week": preview["week"],
        "previewGeneratedAtUtc": preview["generatedAtUtc"],
        "tradeTimestampUnix": args.trade_timestamp,
        "franchises": [trade["franchise"], trade["franchise2"]],
        "playersMoved": moved,
        "method": "Same saved forecast inputs and banked scores; reverse only traded players. "
                  "Full rerun recalibrates the model's noise; fixed-noise sensitivity keeps "
                  "the published run's noise. Draft picks have no model input.",
        "baselineReproducesPublishedOdds": True,
        "runs": runs, "seed": seed, "regress": k,
        "noise": {"withTrade": {"weekly": round(post_state["sigma_w"], 3),
                                "season": round(post_state["sigma_s"], 3)},
                  "withoutTrade": {"weekly": round(pre_state["sigma_w"], 3),
                                   "season": round(pre_state["sigma_s"], 3)}},
        "teams": teams,
    }
    if args.sensitivity_runs:
        n = args.sensitivity_runs
        if n < runs:
            raise ValueError("sensitivity runs must be at least the published run count")
        higher_post = odds_for(post, actual, n, seed, k)
        higher_pre = odds_for(pre, actual, n, seed, k)
        higher_fixed = fixed_noise_no_trade(pre, higher_post, actual, n, seed, k)
        out["sensitivity"] = {"runs": n, "seed": seed,
                              "fullRerunEffectPoints": {
                                  fid: {m: round(100 * (higher_post["odds"][fid][m]
                                                       - higher_pre["odds"][fid][m]), 2)
                                        for m in ("playoff", "title", "division")}
                                  for fid in sorted(post["teams"])},
                              "fixedNoiseEffectPoints": {
                                  fid: {m: round(100 * (higher_post["odds"][fid][m]
                                                       - higher_fixed[fid][m]), 2)
                                        for m in ("playoff", "title", "division")}
                                  for fid in sorted(post["teams"])}}
    if args.seed_check:
        # Seed spread at the published run count: the same comparison, other random draws.
        rows = []
        for s in [int(x) for x in args.seed_check.split(",") if x.strip()]:
            a, b = odds_for(post, actual, runs, s, k), odds_for(pre, actual, runs, s, k)
            fx = fixed_noise_no_trade(pre, a, actual, runs, s, k)
            rows.append({"seed": s, "effects": {
                fid: {"fullRerun": {m: round(100 * (a["odds"][fid][m] - b["odds"][fid][m]), 2)
                                    for m in ("playoff", "title")},
                      "fixedNoise": {m: round(100 * (a["odds"][fid][m] - fx[fid][m]), 2)
                                     for m in ("playoff", "title")}}
                for fid in out["franchises"]}})
        out["seedCheck"] = {"runs": runs, "seeds": rows}
    if os.path.exists(args.out):
        raise ValueError("refusing to overwrite %s" % args.out)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    for fid in out["franchises"]:
        print(owners[fid], out["teams"][fid])
    print("wrote", args.out)


if __name__ == "__main__":
    main()
