"""CBS stats pages -> per-season scoring coefficients, SOLVED not read.

WHY THIS EXISTS
===============
CBS serves no rules history: every /rules/scoring/<YEAR> returns byte-identical
content. But /stats/stats-main carries each player's RAW STATS and the FANTASY
POINTS those stats produced, on the same row — so the scoring coefficients can
be recovered by least squares, one fit per position per season. That is the
only route to "how did our scoring change" for this league.

⚠️ THE URL: /stats/stats-main/all:<POS>/<YEAR>
The POSITION FILTER MUST COME FIRST and is REQUIRED. Every year-first variant
(/2022, /all/2022, /2022/all, /2022/scoring) returns headers plus a zeroed
TOTALS row and NO players — which reads as "this season has no data" when it
actually means "the default FREE-AGENT view is empty for a completed season".

⚠️ THESE PAGES ARE JS-RENDERED for historical years. urllib gets headers only;
they must be fetched through a browser or JS-capable client. This module
therefore takes ALREADY-FETCHED HTML and never fetches anything itself.

THREE FAILURE MODES THIS MODULE EXISTS TO REFUSE
================================================
1. COLUMN LAYOUT VARIES BY POSITION. Group ORDER differs (QB is
   Passing→Rushing, WR is Receiving→Rushing), QB has NO receiving columns at
   all, and every group carries a DERIVED "Avg" (yards per carry) that is not
   a scoring input. A fixed right-edge offset map produced R²=0.999 with 5.15
   points per rushing yard. Columns are therefore read from the group banner's
   COLSPANs, never assumed.
2. EMPTY SEASONS THAT LOOK FULL. Older seasons return a complete 100-row table
   with no numbers in it (2010 RB: 100 rows, 0 populated). Least squares fits
   that to all-zero coefficients with a clean R², i.e. "touchdowns are worth
   zero" stated confidently. MIN_POPULATED_FRACTION refuses it.
3. A HIGH R² PROVING NOTHING. With the true inputs present the fit SHOULD be
   near-perfect, so R² cannot distinguish a good fit from a misaligned one —
   both scored 0.999. Only the coefficient PLAUSIBILITY bounds can.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from html.parser import HTMLParser

#: Groups that carry scoring inputs. Anything else (Upcoming, Trends, Pos Rank,
#: FPTS) is context or the target, never a feature.
SCORING_GROUPS = ("Passing", "Rushing", "Receiving", "Fumbles")

#: ⚠️ COVERAGE IS MEASURED AT THE TOP OF THE LIST, NOT ACROSS THE WHOLE LIST.
#: A whole-list fraction cannot tell "CBS has no stats for this season" apart
#: from "this position has a long tail of backups who genuinely scored zero".
#: QB 2022 is a COMPLETE season and still comes back 63/100 populated, because
#: a 100-deep QB list is mostly third-stringers with real zeros — an 80%
#: whole-list threshold rejected it. The top of the list is the discriminator:
#: in a real season the leading players always have stats; in an empty one
#: (2010: 0/100) even the #1 player has none.
TOP_N = 20
MIN_TOP_POPULATED = 0.80
MIN_ROWS = 20

#: Sanity bounds on solved coefficients. A per-yard value outside this range or
#: a TD outside it means the columns are misaligned — regardless of R².
PLAUSIBLE = {"Yds": (0.01, 0.25), "TD": (1.0, 25.0), "Rec": (0.0, 3.0),
             "Int": (-6.0, 0.0), "Lost": (-6.0, 0.0)}


class StatsError(RuntimeError):
    """Raised instead of returning coefficients that cannot be trusted."""


@dataclass
class SeasonFit:
    season: int
    position: str
    n: int
    coefficients: dict[str, float]
    r2: float
    rmse: float
    populated_fraction: float
    warnings: list[str] = field(default_factory=list)


class _Tables(HTMLParser):
    """Rows plus each cell's colspan — the colspans are the whole point."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.rows: list[list[str]] = []
        self.spans: list[list[int]] = []
        self._r: list[str] | None = None
        self._s: list[int] | None = None
        self._c: list[str] | None = None
        self._cs = 1

    def handle_starttag(self, tag, attrs):
        if tag == "tr":
            self._r, self._s = [], []
        elif tag in ("td", "th") and self._r is not None:
            self._c = []
            self._cs = 1
            for k, v in attrs:
                if k == "colspan":
                    try:
                        self._cs = max(1, int(v))
                    except ValueError:
                        self._cs = 1

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._c is not None:
            self._r.append(re.sub(r"\s+", " ", "".join(self._c)).strip())
            self._s.append(self._cs)
            self._c = None
        elif tag == "tr" and self._r is not None:
            if self._r:
                self.rows.append(self._r)
                self.spans.append(self._s)
            self._r = self._s = None

    def handle_data(self, data):
        if self._c is not None:
            self._c.append(data)


def _num(cell: str) -> float | None:
    t = (cell or "").strip().replace(",", "")
    if t in ("", "-", "--"):
        return None
    try:
        return float(t)
    except ValueError:
        return None


def _num0(cell: str) -> float:
    """⚠️ Blank means ZERO OCCURRENCES here, not 'unknown'. This is a counting
    table — a QB with no receptions renders "". That is the OPPOSITE of the
    rule everywhere else in this pipeline, and it is safe only because every
    column is a count. The TARGET (Total) still uses _num and must parse."""
    v = _num(cell)
    return 0.0 if v is None else v


def parse_stats_table(html: str) -> tuple[list[str], list[dict]]:
    """-> (feature names, rows of {x: [...], y: total}).

    Features are labelled "<Group>.<Header>" from the group banner's colspans,
    so a caller can see exactly which column produced which coefficient.
    """
    p = _Tables()
    p.feed(html)
    hi = -1
    for i, r in enumerate(p.rows):
        if len(r) > 10 and r and r[0].strip().lower() == "action":
            hi = i
            break
    if hi < 1:
        raise StatsError("no ACTION header row with a group banner above it — "
                         "the page did not render as a stats table")

    header = p.rows[hi]
    col_group: list[str] = []
    for name, span in zip(p.rows[hi - 1], p.spans[hi - 1]):
        col_group.extend([name] * span)

    feats: list[tuple[int, str]] = []
    for i, h in enumerate(header):
        g = col_group[i] if i < len(col_group) else ""
        if g not in SCORING_GROUPS:
            continue
        if h.strip().lower() == "avg":       # derived (yds/att), not scored
            continue
        feats.append((i, f"{g}.{h}"))
    if not feats:
        raise StatsError(f"no scoring columns found; groups seen: "
                         f"{sorted(set(col_group))} — wrong page or new layout")

    total_i = len(header) - 1
    out = []
    for row in p.rows:
        if len(row) != len(header):
            continue
        # ⚠️ Do NOT skip on an empty first cell. The live page puts JS in the
        # ACTION column so it is never blank there — but keying on that would
        # silently drop any row CBS renders with an empty action cell, and a
        # dropped player is invisible in the fit. Identify the rows we mean to
        # skip (repeated header, TOTALS) by their OWN markers instead.
        cells_lower = [c.strip().lower() for c in row[:3]]
        if "action" in cells_lower or "totals" in cells_lower:
            continue
        if len(row) < 3 or not row[2] or not re.search(r"[A-Za-z]", row[2]):
            continue
        y = _num(row[total_i])
        if y is None:
            continue
        out.append({"x": [_num0(row[i]) for i, _ in feats], "y": y})
    return [n for _, n in feats], out


def _solve(p: int, data: list[dict]) -> tuple[list[float], float, float]:
    """Normal equations + Gauss-Jordan. No numpy dependency in this repo."""
    A = [[0.0] * (p + 1) for _ in range(p)]
    ys = 0.0
    for d in data:
        x, y = d["x"], d["y"]
        for i in range(p):
            for j in range(p):
                A[i][j] += x[i] * x[j]
            A[i][p] += x[i] * y
        ys += y
    for i in range(p):
        A[i][i] += 1e-8                      # keep a singular column finite
    for c in range(p):
        piv = max(range(c, p), key=lambda r: abs(A[r][c]))
        if abs(A[piv][c]) < 1e-9:
            continue
        A[c], A[piv] = A[piv], A[c]
        for r in range(p):
            if r == c:
                continue
            f = A[r][c] / A[c][c]
            for k in range(c, p + 1):
                A[r][k] -= f * A[c][k]
    b = [0.0 if abs(A[i][i]) < 1e-9 else A[i][p] / A[i][i] for i in range(p)]
    n = len(data)
    mean = ys / n
    ssr = sst = 0.0
    for d in data:
        pred = sum(b[i] * d["x"][i] for i in range(p))
        ssr += (d["y"] - pred) ** 2
        sst += (d["y"] - mean) ** 2
    r2 = 1.0 - ssr / sst if sst > 0 else float("nan")
    return b, r2, (ssr / n) ** 0.5


def implausible(coefficients: dict[str, float]) -> list[str]:
    bad = []
    for name, v in coefficients.items():
        suffix = name.rsplit(".", 1)[-1]
        bounds = PLAUSIBLE.get(suffix)
        if bounds and not (bounds[0] <= v <= bounds[1]):
            bad.append(f"{name}={v:g} outside {bounds}")
    return bad


def solve_season(html: str, *, season: int, position: str) -> SeasonFit:
    feats, data = parse_stats_table(html)
    if len(data) < MIN_ROWS:
        raise StatsError(f"{position} {season}: only {len(data)} parsable rows "
                         f"(need {MIN_ROWS}) — refusing to fit")

    frac, top_frac, populated = coverage(data)
    if top_frac < MIN_TOP_POPULATED:
        # 2010 returns 100 rows with 0 populated; least squares would happily
        # report "every touchdown is worth 0.0" with a clean R².
        raise StatsError(
            f"{position} {season}: only {top_frac:.0%} of the top {TOP_N} rows "
            f"carry data (need {MIN_TOP_POPULATED:.0%}). CBS returns a full-size "
            f"EMPTY table for seasons it has no stats for; fitting it would "
            f"produce all-zero 'scoring rules'. (whole-list coverage was "
            f"{populated}/{len(data)}, which alone cannot distinguish an empty "
            f"season from a long tail of zero-stat backups.)")

    b, r2, rmse = _solve(len(feats), data)
    coef = {n: round(v, 3) for n, v in zip(feats, b)}
    bad = implausible(coef)
    if bad:
        # ⚠️ R² CANNOT CATCH THIS. A misaligned map scored 0.999 while claiming
        # 5.15 points per rushing yard. Only the bounds catch it.
        raise StatsError(
            f"{position} {season}: fit is implausible despite R²={r2:.4f} — "
            f"{'; '.join(bad)}. This is the signature of a column-mapping error, "
            f"not of unusual league scoring.")
    return SeasonFit(season=season, position=position, n=len(data),
                     coefficients=coef, r2=round(r2, 4), rmse=round(rmse, 2),
                     populated_fraction=round(frac, 3))


def coverage(data: list[dict]) -> tuple[float, float, int]:
    """-> (whole-list fraction, top-N fraction, populated count).

    Rows arrive in CBS's own descending-points order, so the first TOP_N are
    the leaders. Both numbers are returned because the whole-list figure is
    still worth REPORTING (it says how deep the data goes) even though only
    the top-N figure is safe to GATE on.
    """
    def has_data(d: dict) -> bool:
        return any(v for v in d["x"]) or bool(d["y"])
    populated = sum(1 for d in data if has_data(d))
    top = data[:TOP_N]
    top_frac = (sum(1 for d in top if has_data(d)) / len(top)) if top else 0.0
    return (populated / len(data) if data else 0.0), top_frac, populated


def diff_seasons(fits: list[SeasonFit]) -> dict[str, dict[int, float]]:
    """Coefficient by stat by season, for spotting a rules change."""
    out: dict[str, dict[int, float]] = {}
    for f in fits:
        for stat, v in f.coefficients.items():
            out.setdefault(f"{f.position}.{stat}", {})[f.season] = v
    return out


def solve_from_moments(feats: list[str], XtX: list[list[float]], Xty: list[float],
                       *, n: int, populated: int, ys: float, yy: float,
                       season: int, position: str,
                       top_populated: int | None = None) -> SeasonFit:
    """Same fit and the SAME GUARDS, from sufficient statistics instead of rows.

    ⚠️ WHY THIS EXISTS. The stats pages are JS-rendered for past seasons, so the
    HTML can only be obtained in a browser — but shipping 100 rows x 16
    position-seasons back for solving is impractical, and re-implementing the
    solver in page JavaScript would mean the numbers we report come from code
    the test suite never touches. The browser therefore computes only X'X and
    X'y (a 9x9 and a 9), and the fit, the coverage guard and the plausibility
    guard all still run HERE, in the tested module.

    X'X, X'y, n, ys=Σy and yy=Σy² are sufficient for both the coefficients and
    R², so nothing about the result is weaker than solve_season's.
    """
    if n < MIN_ROWS:
        raise StatsError(f"{position} {season}: only {n} rows (need {MIN_ROWS})")
    frac = populated / n if n else 0.0
    # ⚠️ Gate on the TOP of the list; see the TOP_N comment above. A caller that
    # cannot supply top_populated gets a conservative fallback to the whole-list
    # figure, which is why the extractor always sends it.
    top_frac = (top_populated / min(TOP_N, n)) if top_populated is not None else frac
    if top_frac < MIN_TOP_POPULATED:
        raise StatsError(
            f"{position} {season}: only {top_frac:.0%} of the top {TOP_N} rows "
            f"carry data (need {MIN_TOP_POPULATED:.0%}) — CBS returns a "
            f"full-size EMPTY table for seasons it has no stats for. "
            f"(whole-list coverage {populated}/{n}.)")

    p = len(feats)
    A = [[XtX[i][j] for j in range(p)] + [Xty[i]] for i in range(p)]
    for i in range(p):
        A[i][i] += 1e-8
    for c in range(p):
        piv = max(range(c, p), key=lambda r: abs(A[r][c]))
        if abs(A[piv][c]) < 1e-9:
            continue
        A[c], A[piv] = A[piv], A[c]
        for r in range(p):
            if r == c:
                continue
            f = A[r][c] / A[c][c]
            for k in range(c, p + 1):
                A[r][k] -= f * A[c][k]
    b = [0.0 if abs(A[i][i]) < 1e-9 else A[i][p] / A[i][i] for i in range(p)]

    # SSR = y'y - 2b'X'y + b'X'Xb ; SST = y'y - (Σy)²/n
    bXty = sum(b[i] * Xty[i] for i in range(p))
    bXXb = sum(b[i] * sum(XtX[i][j] * b[j] for j in range(p)) for i in range(p))
    ssr = max(0.0, yy - 2 * bXty + bXXb)
    sst = max(1e-12, yy - ys * ys / n)
    coef = {name: round(v, 3) for name, v in zip(feats, b)}
    bad = implausible(coef)
    if bad:
        raise StatsError(f"{position} {season}: implausible fit despite "
                         f"R²={1 - ssr / sst:.4f} — {'; '.join(bad)}")
    return SeasonFit(season=season, position=position, n=n, coefficients=coef,
                     r2=round(1 - ssr / sst, 4), rmse=round((ssr / n) ** 0.5, 2),
                     populated_fraction=round(frac, 3))


# ─────────────────────────────────────────────────────────────────────────────

def season_points_by_player(client, season: int, league_id: str = "grffl",
                            positions=("QB", "RB", "WR", "TE", "K", "DST"),
                            key_fn=None) -> dict:
    """player key -> season fantasy points, from CBS's own stats pages.

    ⚠️ WHY THIS EXISTS. CBS's draft-results page carried "Total Fpts"/"Active
    Fpts" columns through 2023 and DROPPED them in 2024 (7 header cells became
    5). Every pick from 2024 on therefore has a NULL points field, and an
    outcome analysis reading only the draft payload silently runs on the
    seasons that still have it while appearing to cover all of them.

    ⚠️ TOP-100-PER-POSITION ONLY. A player outside his position's top 100 is
    ABSENT from the returned map — not zero. Callers must treat a miss as
    unpriced and report the count, because a deep pick scoring nothing and a
    deep pick CBS declines to publish are different facts.
    """
    import re as _re
    if key_fn is None:
        def key_fn(n):
            return n.strip().lower()
    out: dict = {}
    for pos in positions:
        try:
            html = client.get_html(
                f"https://{league_id}.football.cbssports.com/stats/stats-main/"
                f"all:{pos}/{season}")
            _, rows = parse_stats_table(html)
        except (StatsError, ValueError):
            # A position CBS does not publish a stats table for is a gap, not a
            # failure — K and DST are served differently in some seasons.
            continue
        tb = _Tables()
        tb.feed(html)
        try:
            hi = next(i for i, r in enumerate(tb.rows)
                      if len(r) > 10 and r and r[0].strip().lower() == "action")
        except StopIteration:
            continue
        names = []
        for row in tb.rows:
            if len(row) != len(tb.rows[hi]):
                continue
            low = [c.strip().lower() for c in row[:3]]
            if "action" in low or "totals" in low:
                continue
            if len(row) < 3 or not row[2] or not _re.search(r"[A-Za-z]", row[2]):
                continue
            names.append(_re.split(r"\s+[A-Z/]{1,4}\s*\u2022", row[2])[0].strip())
        if len(names) != len(rows):
            raise StatsError(
                f"{pos} {season}: {len(names)} names vs {len(rows)} stat rows — "
                f"refusing to pair them positionally.")
        for nm, r in zip(names, rows):
            if r["y"]:
                out[key_fn(nm)] = float(r["y"])
    return out
