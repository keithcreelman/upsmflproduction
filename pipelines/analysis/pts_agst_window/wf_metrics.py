"""Metrics for the walk-forward backtest. Every metric is computed on one COMMON sample of targets."""
import math, random
from collections import defaultdict
import numpy as np
from scipy import stats

def mae(e): return float(np.mean(np.abs(e))) if len(e) else float("nan")
def rmse(e): return float(math.sqrt(np.mean(np.square(e)))) if len(e) else float("nan")

def corr(x, y):
    x, y = np.asarray(x, float), np.asarray(y, float)
    if len(x) < 3 or np.std(x) == 0 or np.std(y) == 0: return float("nan"), float("nan")
    return float(stats.pearsonr(x, y)[0]), float(stats.spearmanr(x, y)[0])

def concordance(rows):
    """rows: [(group_key, pred, actual)]. Pairwise share of correctly ordered pairs WITHIN each group
    (a season-week-position slate); ties in pred or actual are skipped. Returns (concordant, pairs)."""
    by = defaultdict(list)
    for k, p, a in rows: by[k].append((p, a))
    c = n = 0
    for v in by.values():
        for i in range(len(v)):
            pi, ai = v[i]
            for j in range(i + 1, len(v)):
                pj, aj = v[j]
                if pi == pj or ai == aj: continue
                n += 1
                if (pi - pj) * (ai - aj) > 0: c += 1
    return c, n

def quartile_lift(rows):
    """Within each slate: mean actual of the top quarter by prediction minus the bottom quarter;
    averaged over slates (weighted by slate size)."""
    by = defaultdict(list)
    for k, p, a in rows: by[k].append((p, a))
    tot = w = 0.0
    for v in by.values():
        if len(v) < 8: continue
        if len(set(p for p, _ in v)) < 2: continue        # a constant prediction can't sort teams: undefined
        v.sort(key=lambda z: z[0]); q = len(v) // 4
        lo = np.mean([a for _, a in v[:q]]); hi = np.mean([a for _, a in v[-q:]])
        tot += (hi - lo) * len(v); w += len(v)
    return tot / w if w else float("nan")

def direction(rows):
    """rows: [(pred_sign_value, actual_sign_value)] relative to the opponent baseline; ties skipped."""
    c = n = 0
    for p, a in rows:
        if p == 0 or a == 0: continue
        n += 1
        if (p > 0) == (a > 0): c += 1
    return (c / n if n else float("nan")), n

def boot_diff(clusters, f_a, f_b, B=600, seed=7):
    """Paired cluster bootstrap of metric(a) - metric(b). clusters: list of lists of row indices;
    f_a/f_b: functions(list_of_indices) -> metric value. Returns (point, lo, hi)."""
    rnd = random.Random(seed)
    allidx = [i for c in clusters for i in c]
    point = f_a(allidx) - f_b(allidx)
    vals = []
    for _ in range(B):
        idx = []
        for _ in range(len(clusters)): idx.extend(clusters[rnd.randrange(len(clusters))])
        vals.append(f_a(idx) - f_b(idx))
    vals.sort()
    return point, vals[int(0.025 * B)], vals[int(0.975 * B) - 1]
