#!/usr/bin/env python3
"""BREAKOUT RADAR — lead-time measurement. Spec §10.

THE QUESTION THIS ANSWERS
=========================
Does a signal flag a player BEFORE his first elite week, earlier and more
precisely than simply watching his box score do it?

That is the premise of the whole system. Next-week MAE cannot test it — by
construction it asks "how close was the points estimate", never "how early did
we know". Three of the inputs added on 2026-08-05 (injury, depth rank, role
deltas) exist ONLY for this question, which is why they ablated to ~zero on
point accuracy and why that was not evidence against them.

THREE DEFINITIONS THAT DECIDE EVERYTHING
========================================
1. ELITE WEEK — top-12 finish at the player's MFL position that week, on
   realized UPS points. Top-12 because UPS starts roughly a dozen at the skill
   positions, so it is where a player becomes genuinely startable.

2. BREAKOUT — a player's FIRST elite week in a season, AND he must not already
   have been performing like a starter going into it. Without that clause every
   good week by an established WR1 counts and the radar gets credit for noticing
   Ja'Marr Chase. Operationally: season-to-date UPS PPG entering that week below
   his position's 24th-best — not yet a startable asset, therefore plausibly
   cheap.

3. FLAG — each radar gets the SAME BUDGET: top K per (season, week, position),
   drawn only from the not-yet-established pool. Equal budget is what makes the
   comparison fair.

READ PRECISION, NOT RECALL
==========================
Flags ACCUMULATE across a season, so over 13 weeks even random selection
eventually shortlists a large share of the pool and earns recall for free. The
budget is equal PER WEEK; the distinct-player count is not. Precision — of the
distinct players shortlisted, the share that broke out AFTER being flagged — is
budget-fair and maps to the real decision: a roster spot spent.

THE RADARS
==========
  role        d_route_pct_l3, d_tgt_share_l3, d_snap_pct_l3, depth promotion.
              The thesis: opportunity moves before production does.
  volume      recent route volume. Level, not change. "He is playing a lot."
  production  recent PPG minus season PPG. The null hypothesis — what a person
              scanning a box score does.
  combined    role + volume, hand-weighted after rank-normalising each. Tests
              whether the two are complementary INDEPENDENT of any learning.
  learned     a gradient-boosted classifier over role AND volume AND production
              features, trained on strictly earlier seasons. This is the
              combined radar done properly, and it is spec Model E (elite-week
              classification) pointed at the radar problem.
  random      the floor. A radar that cannot beat shuffled noise on precision at
              equal budget is measuring nothing.

⚠️ NULL-DELTA HANDLING — this materially changed the answer.
An earlier version scored a missing delta as 0.0, which parked players with NO
role-change evidence in the MIDDLE of the ranking rather than excluding them.
Since deltas are only 66-77% populated, that handicapped the role radar
specifically — it was the only radar depending on them. A player with no delta
data is now INELIGIBLE for the role and combined radars (we have no evidence
about his role, which is not the same as evidence of no change), and the learned
model receives NaN, which gradient boosting handles natively.

EVERY FLAG IS AS-OF CLEAN. Radar scores come from model_player_week_features,
built under the leakage guard, so a flag in week W uses only weeks < W. Elite
weeks and breakouts are LABELS from realized results, used to score the radars
afterwards and never to produce a flag. The learned radar trains only on
STRICTLY EARLIER SEASONS.

Usage:
  python3 pipelines/etl/scripts/breakout_radar_leadtime.py --seasons 2021-2025
  python3 pipelines/etl/scripts/breakout_radar_leadtime.py --seasons 2021-2025 --topk 10
"""
from __future__ import annotations
import argparse
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from lib.asof import AsOfContext  # noqa: E402

ELITE_RANK = 12
ESTABLISHED_RANK = 24
POSITIONS = ("WR", "TE", "RB", "QB")

# Features for the learned radar: role CHANGE (at BOTH window lengths),
# opportunity LEVEL, and recent production — so it can discover the combination
# rather than being told one.
#
# The 1-week deltas are DERIVED, not stored columns (see fast_role_score), so
# this is a name list for reporting and learn_row() builds the vector.
#
# Both window lengths are offered deliberately. The hand-weighted comparison
# showed the 3-week delta is too slow — role 14.9% vs role_fast 17.5% — so
# giving the model only the slow version would have handicapped it by exactly
# the defect under investigation. Given both, it can weight them however the
# data warrants, and if it still fails to beat the hand-weighted combined_fast
# radar that is a real result rather than an artefact of what it was fed.
LEARN_FEATURES = [
    "d_routes_fast", "d_targets_fast",                       # 1-week (derived)
    "d_route_pct_l3", "d_tgt_share_l3", "d_snap_pct_l3", "d_depth_rank",  # 3-week
    "routes_l1", "routes_l3", "routes_std",                  # opportunity level
    "targets_l1", "targets_l3", "depth_rank",
    "ups_ppg_l3", "ups_ppg_std",                             # recent production
]

# ── SHRINKAGE VARIANTS ─────────────────────────────────────────────────────
# The full learned radar (14 features, 250 iterations, depth 5) loses to a
# hand-weighted rank sum of two signals. The evidence points at VARIANCE rather
# than missing signal — few sparse positives, many features — so these shrink it
# three different ways, kept separate so their effects do not confound.
#
#   small  4 features, the ones the hand-weighted radar actually uses
#   reg    all 14 features but heavily regularised — shallow, few iterations,
#          large leaves, real L2
#   rank   small feature set, RANK-TRANSFORMED within each position-week
#
# `rank` is the pointed test. combined_fast wins partly BECAUSE ranking discards
# magnitude — which is mostly noise here — and makes two differently-scaled
# signals commensurable. The GBM currently has to learn that structure from
# sparse data; this hands it over. If ranking is what matters, this closes the
# gap; if it does not, the gap is something else.
SMALL_FEATS = ["d_routes_fast", "d_targets_fast", "routes_l3", "ups_ppg_std"]

_BASE_KW = dict(max_iter=250, learning_rate=0.06, max_depth=5,
                min_samples_leaf=40, random_state=0)
_REG_KW = dict(max_iter=80, learning_rate=0.05, max_depth=3,
               min_samples_leaf=200, l2_regularization=5.0, random_state=0)

LEARN_VARIANTS = {
    "learned":    dict(feats=None,        kw=_BASE_KW, rank=False),
    "learn_small": dict(feats=SMALL_FEATS, kw=_BASE_KW, rank=False),
    "learn_reg":  dict(feats=None,        kw=_REG_KW,  rank=False),
    "learn_rank": dict(feats=SMALL_FEATS, kw=_REG_KW,  rank=True),
}

# THE PRODUCTION RADAR — and the honest reason for it.
#
# Picked on a 9-definition sweep (elite-rank x est-rank) rather than a single
# operating point. Under PPG-cheapness learn_reg led 7 of 9. Re-running that
# same sweep under `--cheap-by salary` — the definition that actually matches
# the spec — DOES NOT reproduce the lead:
#
#   mean precision, 9 definitions, 2021-2025 w5-17, --cheap-by salary
#     learn_reg  16.0%  (4 wins)     combined_fast 12.6%
#     learn_rank 15.9%  (4 wins)     volume        12.4%
#     learned    14.9%  (0)          role_fast     11.9%   random 8.8%
#
#   pooled:  learn_reg 16.05% vs learn_rank 15.32%   z=+0.94   NOT significant
#            learn_reg 16.05% vs role_fast  11.84%   z=+6.11   significant
#
# So learn_reg over learn_rank is a coin flip. What IS robust across both
# cheapness definitions and all 9 thresholds is that the LEARNED family beats
# every hand-weighted radar. learn_reg stays PRIMARY because it is a
# co-leader and already in place, not because it was shown to be best.
#
# One structural result worth keeping — the ordering flips along the
# cheap-strictness axis (mean lift vs random):
#                     est_rank 12 (loose)   est_rank 36 (strict)
#     learn_reg              1.85x                 1.91x
#     role_fast              1.16x                 1.97x   <- best at strict
#     volume                 1.53x                 1.40x
#     production             0.88x                 1.23x
# Among genuinely cheap players everyone is low-volume, so opportunity LEVEL
# stops discriminating and opportunity CHANGE takes over: a four-line
# hand-written delta matches the GBM exactly where the spec's definition is
# tightest. `production` sits at or BELOW random when cheap is loose (0.68x at
# 18/12) — recent box-score output is anti-predictive here, which is precisely
# what the spec says to ignore.
PRIMARY = "learn_reg"

RNG = np.random.default_rng(0)


def parse_seasons(s: str) -> list[int]:
    out: list[int] = []
    for part in s.split(","):
        part = part.strip()
        if "-" in part:
            a, b = part.split("-")
            out += list(range(int(a), int(b) + 1))
        elif part:
            out.append(int(part))
    return sorted(set(out))


def _f(v, default=0.0):
    try:
        x = float(v)
    except (TypeError, ValueError):
        return default
    return default if x != x else x


def _fn(v):
    """float or None — preserves 'unknown' instead of collapsing it to zero."""
    try:
        x = float(v)
    except (TypeError, ValueError):
        return None
    return None if x != x else x


def load_season(season: int, weeks):
    ctx = AsOfContext(season=season, week=1)
    poslist = ",".join("'" + p + "'" for p in POSITIONS)
    rows = []
    for wk in weeks:
        got = ctx.run(
            "SELECT f.gsis_id, f.player_name, f.mfl_pos, f.week,"
            " f.d_route_pct_l3, f.d_tgt_share_l3, f.d_snap_pct_l3,"
            " f.d_depth_rank, f.depth_rank, f.routes_l3, f.routes_std,"
            " f.routes_l1, f.targets_l1, f.targets_l3,"
            " f.ups_ppg_l3, f.ups_ppg_std, f.mfl_salary, s.score"
            " FROM model_player_week_features f"
            " JOIN ff_player_ids p ON p.gsis_id = f.gsis_id"
            " JOIN src_weekly s ON s.player_id = CAST(p.mfl_id AS INTEGER)"
            f"  AND s.season = {season} AND s.week = {wk}"
            f" WHERE f.season = {season} AND f.week = {wk}"
            f"   AND f.mfl_pos IN ({poslist}) AND s.score IS NOT NULL")
        rows += got
        print(f"  {season} W{wk}: {len(got)}", file=sys.stderr, flush=True)
    return rows


def season_labels(rows, elite_rank=None, est_rank=None):
    """elite weeks, per-position 'established' cutoffs, and breakout weeks.

    Both thresholds are PARAMETERS because both are arbitrary. A radar that only
    wins at (12, 24) has not been shown to win at all, so they get swept.
    """
    elite_rank = ELITE_RANK if elite_rank is None else elite_rank
    est_rank = ESTABLISHED_RANK if est_rank is None else est_rank
    by_week = defaultdict(list)
    for r in rows:
        by_week[r["week"]].append(r)

    elite, established, salary_cut = set(), {}, {}
    for wk, rs in by_week.items():
        for pos in POSITIONS:
            p = [x for x in rs if x["mfl_pos"] == pos]
            if not p:
                continue
            for x in sorted(p, key=lambda z: -_f(z["score"]))[:elite_rank]:
                elite.add((x["gsis_id"], wk))
            ppg = sorted((_f(x["ups_ppg_std"], -1) for x in p), reverse=True)
            established[(pos, wk)] = (ppg[est_rank - 1]
                                      if len(ppg) >= est_rank else -1)
            # Cost cutoff: the position's est_rank-th HIGHEST salary. At or
            # below it he is still cheap. NULL salary -> 0 = cheapest, which the
            # data supports (no contract row averages 2.73 UPS vs 10.98).
            sal = sorted((_f(x.get("mfl_salary"), 0.0) for x in p), reverse=True)
            salary_cut[(pos, wk)] = (sal[est_rank - 1]
                                     if len(sal) >= est_rank else 1e12)

    first_elite = {}
    for g, wk in sorted(elite, key=lambda t: t[1]):
        first_elite.setdefault(g, wk)

    breakout = {}
    for r in rows:
        g, wk = r["gsis_id"], r["week"]
        if first_elite.get(g) != wk:
            continue
        if _f(r["ups_ppg_std"], -1) < established.get((r["mfl_pos"], wk), -1):
            breakout[g] = wk
    return by_week, established, breakout, salary_cut


def eligible(r, established, salary_cut=None):
    """Is he still a plausible pre-breakout candidate?

    TWO WAYS TO ASK THIS, and they are not the same question:

      PERFORMANCE (default) — season-to-date PPG below the position's Nth-best.
        Cheap-by-proxy, and the proxy leaks: a known star having a poor season
        passes, so reverting to form scores as a "breakout". Ezekiel Elliott,
        Chris Godwin, Michael Pittman, Tony Pollard and Kirk Cousins all reached
        the caught list this way, and none was ever a cheap add.

      COST (--cheap-by salary) — MFL salary below the position's Nth-highest.
        This is what the spec actually means: value moved, price did not.

    A NULL salary counts as CHEAP, and that is measured rather than assumed —
    player-weeks with no contract row average 2.73 UPS points against 10.98 for
    salaried ones, spread evenly across all 13 franchises. They are the roster
    fringe, i.e. the cheapest things you can acquire.
    """
    if salary_cut is not None:
        return _f(r.get("mfl_salary"), 0.0) <= salary_cut.get(
            (r["mfl_pos"], r["week"]), 0.0)
    return _f(r["ups_ppg_std"], -1) < established.get((r["mfl_pos"], r["week"]), -1)


def has_role_evidence(r):
    """A role radar needs at least one observed role-change delta.

    Missing deltas are NOT zeros. Scoring them 0.0 parks a player with no
    evidence in the middle of the ranking, which is how the first version of
    this script quietly handicapped the role radar — deltas are only 66-77%
    populated, and role was the only radar that depended on them.
    """
    return any(_fn(r.get(k)) is not None
               for k in ("d_route_pct_l3", "d_tgt_share_l3", "d_snap_pct_l3"))


def role_score(r):
    return (_f(r.get("d_route_pct_l3")) * 3.0
            + _f(r.get("d_tgt_share_l3")) * 3.0
            + _f(r.get("d_snap_pct_l3")) * 1.0
            - _f(r.get("d_depth_rank")) * 0.15)


def fast_role_score(r):
    """ONE-WEEK role change: last week vs the two before it.

    The stored deltas compare a 3-week window against the prior 3-week window,
    which spans six weeks end to end. If a role change matters over 1-2 weeks —
    a starter goes down on Sunday and the backup plays Thursday — that window
    smears the signal across weeks where it had not happened yet.

    No rebuild needed: the feature store already carries routes_l1 (week W-1)
    and routes_l3 (weeks W-3..W-1), so

        routes_l1                      = his most recent week
        (routes_l3 - routes_l1) / 2    = his average over the two before it

    and the difference is a clean one-week change. Same for targets.

    Deliberately NOT normalised by team dropbacks: the stored route_pct is only
    available at l3/l4 granularity, and mixing a 1-week numerator with a 3-week
    denominator would reintroduce exactly the lag this is meant to remove.
    """
    r1, r3 = _fn(r.get("routes_l1")), _fn(r.get("routes_l3"))
    t1, t3 = _fn(r.get("targets_l1")), _fn(r.get("targets_l3"))
    d = 0.0
    if r1 is not None and r3 is not None:
        d += (r1 - (r3 - r1) / 2.0) * 1.0
    if t1 is not None and t3 is not None:
        d += (t1 - (t3 - t1) / 2.0) * 3.0
    return d


def has_fast_evidence(r):
    """Needs a most-recent week AND a window to compare it against."""
    return (_fn(r.get("routes_l1")) is not None
            and _fn(r.get("routes_l3")) is not None)


def _rank01(vals):
    """Rank-normalise to [0,1] so two differently-scaled scores can be added."""
    n = len(vals)
    if n <= 1:
        return [0.5] * n
    order = sorted(range(n), key=lambda i: vals[i])
    out = [0.0] * n
    for pos, i in enumerate(order):
        out[i] = pos / (n - 1)
    return out


def learn_row(r):
    """Feature vector for the learned radar, incl. DERIVED 1-week deltas.

    Missing values become NaN rather than 0.0 — gradient boosting handles NaN
    natively, and a zero would assert "no change observed" where the truth is
    "no observation". That distinction is what made the stored deltas misleading
    when they were zero-filled.
    """
    r1, r3 = _fn(r.get("routes_l1")), _fn(r.get("routes_l3"))
    t1, t3 = _fn(r.get("targets_l1")), _fn(r.get("targets_l3"))
    d_routes_fast = (r1 - (r3 - r1) / 2.0) if (r1 is not None and r3 is not None) else None
    d_tgts_fast = (t1 - (t3 - t1) / 2.0) if (t1 is not None and t3 is not None) else None
    vals = [
        d_routes_fast, d_tgts_fast,
        _fn(r.get("d_route_pct_l3")), _fn(r.get("d_tgt_share_l3")),
        _fn(r.get("d_snap_pct_l3")), _fn(r.get("d_depth_rank")),
        r1, r3, _fn(r.get("routes_std")),
        t1, t3, _fn(r.get("depth_rank")),
        _fn(r.get("ups_ppg_l3")), _fn(r.get("ups_ppg_std")),
    ]
    return [np.nan if v is None else v for v in vals]


def learn_matrix(rows, feats=None, rank=False):
    """Feature matrix, optionally column-subset and rank-transformed.

    Rank transform is applied WITHIN THE SUPPLIED POOL, which is why callers
    pass one position-week at a time: ranking across pools would compare a WR in
    week 6 against a TE in week 14 and destroy the very comparability it exists
    to create. NaNs rank to the bottom, which is the right default here — no
    observed change is not evidence of a big one.
    """
    idx = (None if feats is None
           else [LEARN_FEATURES.index(f) for f in feats])
    M = np.array([learn_row(r) for r in rows], dtype=float)
    if idx is not None:
        M = M[:, idx]
    if rank and len(M) > 1:
        R = np.empty_like(M)
        for c in range(M.shape[1]):
            col = M[:, c]
            ok = ~np.isnan(col)
            R[:, c] = 0.0
            if ok.sum() > 1:
                vals = col[ok]
                order = vals.argsort().argsort().astype(float)
                R[ok, c] = order / (len(vals) - 1)
            elif ok.sum() == 1:
                R[ok, c] = 0.5
        M = R
    return M


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seasons", default="2021-2025")
    ap.add_argument("--weeks", default="5-17")
    ap.add_argument("--topk", type=int, default=5)
    ap.add_argument("--elite-rank", type=int, default=ELITE_RANK,
                    help="A top-N week counts as elite. ARBITRARY — sweep it.")
    ap.add_argument("--est-rank", type=int, default=ESTABLISHED_RANK,
                    help="PPG above the position's Nth-best = already startable, "
                         "so not a breakout candidate. ARBITRARY — sweep it.")
    ap.add_argument("--cheap-by", choices=("ppg", "salary"), default="ppg",
                    help="How 'not yet expensive' is decided. 'ppg' uses recent "
                         "performance as a proxy and admits star bounce-backs; "
                         "'salary' uses actual MFL cost, which is what the spec "
                         "means by a pre-breakout candidate.")
    ap.add_argument("--show", action="store_true",
                    help="List the actual players the production radar caught "
                         "before they broke out, with lead times.")
    ap.add_argument("--cache", default="",
                    help="Path to cache the loaded rows. The D1 read dominates "
                         "runtime, so a threshold sweep should pay it once.")
    args = ap.parse_args()
    a, b = (args.weeks.split("-") + [args.weeks])[:2]
    weeks = range(int(a), int(b) + 1)
    seasons = parse_seasons(args.seasons)

    from sklearn.ensemble import HistGradientBoostingClassifier

    # Load once. Optionally persist, so sweeping thresholds does not re-pay the
    # D1 read — the labels change per definition, the underlying rows do not.
    raw = None
    if args.cache and Path(args.cache).exists():
        import pickle
        raw = pickle.loads(Path(args.cache).read_bytes())
        print(f"loaded {sum(len(v) for v in raw.values())} rows from cache",
              file=sys.stderr)
    if raw is None:
        raw = {}
        for s_ in seasons:
            rws = load_season(s_, weeks)
            if rws:
                raw[s_] = rws
        if args.cache:
            import pickle
            Path(args.cache).write_bytes(pickle.dumps(raw))

    cache = {sn: (rws,) + season_labels(rws, args.elite_rank, args.est_rank)
             for sn, rws in raw.items()}
    # None => the performance test; a dict => the cost test.
    use_salary = args.cheap_by == "salary"

    names = (("role", "role_fast", "volume", "production",
              "combined", "combined_fast", "random")
             + tuple(LEARN_VARIANTS))
    caught = []
    tot = {n: defaultdict(int) for n in names}
    lead = {n: [] for n in names}
    n_flagged = {n: 0 for n in names}
    n_break = 0
    skipped_learned = []

    for si, season in enumerate(seasons):
        if season not in cache:
            continue
        rows, by_week, established, breakout, salary_cut = cache[season]
        scut = salary_cut if use_salary else None
        n_break += len(breakout)

        # ── learned radars: train on STRICTLY EARLIER seasons ──────────────
        # Training rows are kept GROUPED BY POOL (season, week, position) so the
        # rank variant can be ranked within the same unit it will be ranked
        # within at prediction time. Ranking across pools would compare a WR in
        # week 6 to a TE in week 14 and destroy the comparability it exists for.
        clfs = {}
        prior = [p for p in seasons[:si] if p in cache]
        if prior:
            pools, labels = [], []
            for p in prior:
                prows, pw, pest, pbrk, pcut = cache[p]
                pscut = pcut if use_salary else None
                for wk in sorted(pw):
                    for pos in POSITIONS:
                        grp = [r for r in pw[wk]
                               if r["mfl_pos"] == pos and eligible(r, pest, pscut)]
                        if not grp:
                            continue
                        pools.append(grp)
                        for r in grp:
                            bw = pbrk.get(r["gsis_id"])
                            # Label: does he break out LATER this season?
                            labels.append(1 if (bw is not None and bw > r["week"]) else 0)
            ytr = np.array(labels)
            if len(ytr) and 0 < ytr.sum() < len(ytr):
                for vname, cfg in LEARN_VARIANTS.items():
                    X = np.vstack([learn_matrix(g, cfg["feats"], cfg["rank"])
                                   for g in pools])
                    m = HistGradientBoostingClassifier(**cfg["kw"])
                    m.fit(X, ytr)
                    clfs[vname] = m
        if not clfs:
            skipped_learned.append(season)

        first_flag = {n: {} for n in names}
        seen = {n: set() for n in names}
        for wk in sorted(by_week):
            for pos in POSITIONS:
                pool = [x for x in by_week[wk]
                        if x["mfl_pos"] == pos and eligible(x, established, scut)]
                if not pool:
                    continue
                # role / combined require actual role evidence
                rpool = [x for x in pool if has_role_evidence(x)]
                fpool = [x for x in pool if has_fast_evidence(x)]

                scores = {
                    "role": [(x, role_score(x)) for x in rpool],
                    "volume": [(x, _f(x.get("routes_l3"))) for x in pool],
                    "production": [(x, _f(x.get("ups_ppg_l3")) - _f(x.get("ups_ppg_std")))
                                   for x in pool],
                    "random": [(x, float(RNG.random())) for x in pool],
                    "role_fast": [(x, fast_role_score(x)) for x in fpool],
                }
                if rpool:
                    rr = _rank01([role_score(x) for x in rpool])
                    vv = _rank01([_f(x.get("routes_l3")) for x in rpool])
                    scores["combined"] = [(x, rr[i] + vv[i])
                                          for i, x in enumerate(rpool)]
                else:
                    scores["combined"] = []
                if fpool:
                    fr = _rank01([fast_role_score(x) for x in fpool])
                    fv = _rank01([_f(x.get("routes_l3")) for x in fpool])
                    scores["combined_fast"] = [(x, fr[i] + fv[i])
                                               for i, x in enumerate(fpool)]
                else:
                    scores["combined_fast"] = []
                for vname, cfg in LEARN_VARIANTS.items():
                    m = clfs.get(vname)
                    if m is None:
                        scores[vname] = []
                        continue
                    pv = m.predict_proba(
                        learn_matrix(pool, cfg["feats"], cfg["rank"]))[:, 1]
                    scores[vname] = list(zip(pool, pv))

                for n in names:
                    for x, _sc in sorted(scores[n], key=lambda t: -t[1])[:args.topk]:
                        seen[n].add(x["gsis_id"])
                        first_flag[n].setdefault(x["gsis_id"], wk)

        if args.show:
            meta = {r["gsis_id"]: (r["player_name"], r["mfl_pos"]) for r in rows}
            best = {}
            for r in rows:
                g = r["gsis_id"]
                if breakout.get(g) == r["week"]:
                    best[g] = _f(r["score"])
            for g, bw in breakout.items():
                fw = first_flag[PRIMARY].get(g)
                if fw is not None and fw < bw:
                    nm, ps = meta.get(g, ("?", "?"))
                    caught.append((bw - fw, season, nm, ps, fw, bw, best.get(g, 0.0)))

        for n in names:
            n_flagged[n] += len(seen[n])
            for g, bw in breakout.items():
                fw = first_flag[n].get(g)
                if fw is None:
                    tot[n]["never"] += 1
                elif fw >= bw:
                    tot[n]["after"] += 1
                else:
                    lead[n].append(bw - fw)
                    tot[n]["5plus" if bw - fw >= 5 else
                           "2to4" if bw - fw >= 2 else "1wk"] += 1
        print(f"[{season}] {len(breakout)} breakouts"
              + ("" if clfs else "  (learned: no prior season, skipped)"),
              file=sys.stderr, flush=True)

    if not n_break:
        sys.exit("no breakouts identified — check the definitions")

    print(f"\nBREAKOUT RADAR — {n_break} breakouts, top-{args.topk} per "
          f"position-week, seasons {seasons[0]}-{seasons[-1]}, "
          f"elite=top{args.elite_rank} established=top{args.est_rank}\n")
    hdr = (f"{'radar':>12} {'5+ wk':>7} {'2-4 wk':>7} {'1 wk':>6} {'after':>7} "
           f"{'never':>7} {'recall':>7} {'players':>8} {'PRECISION':>10} {'lift':>6}")
    print(hdr)
    print("-" * len(hdr))
    rand_prec = (tot["random"]["5plus"] + tot["random"]["2to4"]
                 + tot["random"]["1wk"]) / max(n_flagged["random"], 1)
    ordered = sorted(names, key=lambda n: -((tot[n]["5plus"] + tot[n]["2to4"]
                                             + tot[n]["1wk"])
                                            / max(n_flagged[n], 1)))
    for n in ordered:
        t = tot[n]
        early = t["5plus"] + t["2to4"] + t["1wk"]
        prec = early / max(n_flagged[n], 1)
        print(f"{n:>12} {t['5plus']:>7} {t['2to4']:>7} {t['1wk']:>6} {t['after']:>7} "
              f"{t['never']:>7} {100*early/n_break:>6.1f}% {n_flagged[n]:>8} "
              f"{100*prec:>9.1f}% {prec/max(rand_prec,1e-9):>5.2f}x")

    if skipped_learned:
        print(f"\nNOTE: 'learned' had no prior season for {skipped_learned} and "
              f"produced no flags there, so its player count is lower by "
              f"construction — precision stays comparable, recall does not.")
    if args.show and caught:
        print(f"\n\nWHAT {PRIMARY} ACTUALLY CAUGHT — flagged BEFORE the breakout\n")
        hdr = (f"{'lead':>5} {'season':>7} {'player':<24} {'pos':>4} "
               f"{'flagged':>8} {'broke out':>10} {'UPS pts':>8}")
        print(hdr); print("-" * len(hdr))
        for lead_wk, sn, nm, ps, fw, bw, pts in sorted(caught, reverse=True)[:40]:
            print(f"{lead_wk:>4}w {sn:>7} {nm[:24]:<24} {ps:>4} "
                  f"{'W'+str(fw):>8} {'W'+str(bw):>10} {pts:>8.1f}")
        print(f"\n{len(caught)} players flagged before breaking out. 'lead' is")
        print("weeks between the flag and his first elite week — the window in")
        print("which he was still cheap.")

    print("\nPRECISION = of the distinct players shortlisted, the share that")
    print("broke out AFTER being flagged. Budget-fair; recall is not, because")
    print("flags accumulate and a radar that names more players earns recall")
    print("for free. 'lift' is precision relative to random.")


if __name__ == "__main__":
    main()
