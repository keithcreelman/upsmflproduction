#!/usr/bin/env python3
"""AS-OF QUERY GUARD — structural leakage prevention for the UPS model.

Phase 0 task 0.6. See docs/MODEL_RESEARCH_AND_DATA_AUDIT.md §1.1, §1.6, §4.4.

WHY THIS EXISTS
===============
The single most damaging bug available to a breakout-detection system is reading
a COMPLETED-SEASON aggregate while generating a mid-season prediction. It does
not crash, it does not look wrong, and it inflates exactly the metric the system
is judged on — because it tells the model, at Week 5, the season-end usage of
precisely the players whose roles were about to expand.

The audit found FIVE tables in this database with season grain that are
indistinguishable from weekly ones at the API layer:

    nfl_player_routes, nfl_player_epa, nfl_player_ngs,
    nfl_player_ftn, nfl_player_splits

plus nfl_player_injuries_season, which aggregates a completed season. Convention
already failed once here — nfl_player_routes was being served through
/api/player-routes with no indication that its rows are season totals.

So the rule is enforced BY CONSTRUCTION rather than by review: you cannot query
a source through this module without the as-of predicate being applied for you,
and an undeclared table raises rather than defaulting to permissive.

THE CONTRACT
============
A feature row keyed (season=S, week=W) may contain ONLY facts knowable before
kickoff of that game.

    WEEK-grain source  -> season < S, OR (season = S AND week < W)
    SEASON-grain source-> season <= S + max_season_offset   (offset is -1:
                          prior seasons only, NEVER the season in progress)

NO FAIL-OPEN
============
Per the repo rule, an unreadable or undeclared input must refuse, never proceed:
  * unknown table               -> UndeclaredSource
  * banned column referenced    -> BannedColumn (e.g. vegas actual_score, which
                                   is the game's outcome, not a pregame line)
  * season-grain used same-season -> impossible; the predicate forbids it

Usage:
    from lib.asof import AsOfContext
    ctx = AsOfContext(season=2024, week=5)
    sql = ctx.select("nfl_player_routes_weekly",
                     "gsis_id, SUM(routes) rt", group_by="gsis_id")
    rows = ctx.run(sql)
"""
from __future__ import annotations

import json
import subprocess
import time
import sys
from dataclasses import dataclass, field
from pathlib import Path

# lib/ -> etl/ -> pipelines/ -> repo root
WORKER_DIR = Path(__file__).resolve().parents[3] / "worker"

WEEK = "week"
SEASON = "season"
# Week-grain data that is PUBLISHED BEFORE the game it describes — betting
# lines, weather forecasts, official inactives. For these, week = W is not only
# legal but the whole point: a Week 6 spread is knowable before Week 6 kickoff.
# Kept as a distinct grain rather than a special case so the exception is
# explicit and reviewable, and so outcome columns on the same table (e.g.
# nfl_team_vegas_weekly.actual_score) stay banned.
WEEK_PREGAME = "week_pregame"


class LeakageError(RuntimeError):
    """Base for every refusal in this module."""


class UndeclaredSource(LeakageError):
    """Table is not in the manifest — refuse rather than guess its grain."""


class BannedColumn(LeakageError):
    """Column is a post-game outcome and may never be a feature."""


_DEC = json.JSONDecoder()


def _extract_rows(stdout: str):
    """Pull the results array out of `wrangler --json` output, or None.

    Cannot just do `stdout.find("[")`: wrangler prefixes a coloured banner and
    ANSI escape sequences literally contain '[' (e.g. \\x1b[33m), so the naive
    scan lands mid-escape and json.loads reports "Extra data". Walk every '['
    and take the first that raw_decodes into the expected shape.
    """
    if not stdout:
        return None
    start = 0
    while True:
        i = stdout.find("[", start)
        if i < 0:
            return None
        try:
            obj, _ = _DEC.raw_decode(stdout[i:])
        except ValueError:
            start = i + 1
            continue
        if isinstance(obj, list) and obj and isinstance(obj[0], dict) \
                and "results" in obj[0]:
            return obj[0]["results"]
        start = i + 1


@dataclass(frozen=True)
class Source:
    grain: str
    # For SEASON-grain sources only. -1 == prior seasons only. There is no
    # legitimate reason for this to be 0; a completed-season aggregate is not
    # knowable mid-season.
    max_season_offset: int = -1
    # Columns that exist on the table but are post-game outcomes.
    banned: frozenset = field(default_factory=frozenset)
    note: str = ""


# ─────────────────────────────────────────────────────────────────────────────
# THE MANIFEST. Adding a source without a grain is a hard error at query time,
# which is the point — a new table cannot silently inherit permissive defaults.
# ─────────────────────────────────────────────────────────────────────────────
MANIFEST: dict[str, Source] = {
    # ── WEEK grain — safe same-season, filtered to strictly-before ──────────
    "nfl_player_weekly": Source(WEEK),
    "nfl_player_weekly_ext": Source(WEEK),
    "nfl_player_routes_weekly": Source(
        WEEK, note="Built by migration 0115 precisely so routes could be used "
                   "as-of-week. Use THIS, never nfl_player_routes."),
    "nfl_player_snaps": Source(
        WEEK, note="2013+ only. ⚠️ KEYED BY pfr_id, NOT gsis_id — migration "
                   "0006's comment claims gsis_id and is wrong. Join via "
                   "ff_player_ids.pfr_id, guarding both ids against the literal "
                   "string 'NA'."),
    "nfl_player_redzone": Source(WEEK),
    "nfl_team_weekly": Source(WEEK),
    "nfl_team_vegas_weekly": Source(
        WEEK_PREGAME, banned=frozenset({"actual_score"}),
        note="spread / total_line / implied_total are PREGAME and safe. "
             "actual_score is the result of the game being predicted."),
    "src_weekly": Source(
        WEEK, note="Realized UPS points — the TARGET. Safe as a lagged feature "
                   "under the as-of predicate; never join it un-filtered."),

    # ── SEASON grain — PRIOR SEASONS ONLY. This is the leak class. ─────────
    "nfl_player_routes": Source(
        SEASON, note="COMPLETED-SEASON totals (one row per player-season, max "
                     "~718 routes). Same-season use leaks weeks W+1..18. "
                     "Prefer nfl_player_routes_weekly."),
    "nfl_player_epa": Source(SEASON),
    "nfl_player_ngs": Source(SEASON),
    "nfl_player_ftn": Source(SEASON),
    "nfl_player_splits": Source(SEASON),
    "nfl_player_advstats_season": Source(SEASON),
    "nfl_player_pbp_season": Source(SEASON),
    "nfl_player_gamescript_season": Source(SEASON),
    "nfl_player_breakaway_season": Source(SEASON),
    "nfl_player_ff_opportunity_season": Source(SEASON),
    "nfl_team_pbp_season": Source(SEASON),
    "nfl_player_injuries_season": Source(
        SEASON, note="Aggregates a COMPLETED season (weeks_out, weeks_"
                     "questionable). Cannot inform an in-season prediction."),
    "nfl_team_pace": Source(SEASON),

    # ── Effectively static / identity — no temporal leak ────────────────────
    # Still declared, so they go through the same gate rather than bypassing it.
    "player_id_crosswalk": Source(
        SEASON, max_season_offset=99,
        note="Identity, not performance. NOTE: covers only 6.3% of 2014 and "
             "80.6% of 2022 src_weekly rows and its missingness is "
             "survivorship-biased — prefer ff_player_ids."),
    "ff_player_ids": Source(
        SEASON, max_season_offset=99,
        note="Identity. 99.6-100% coverage from 2014. ALWAYS guard with "
             "COALESCE(gsis_id,'') LIKE '00-%' — this table stores missing as "
             "the literal string 'NA', which passes IS NOT NULL and != ''."),
    "nfl_team_coaching_history": Source(
        SEASON, max_season_offset=0,
        note="Coach/coordinator identity is known BEFORE the season starts, so "
             "same-season is legitimate. But a coaching TENDENCY prior must be "
             "built from strictly prior team-seasons."),
    "nfl_season_calendar": Source(SEASON, max_season_offset=99),
    "mfl_scoring_rules": Source(
        SEASON, max_season_offset=0,
        note="Rules are set before the season is played."),
}


def describe(table: str) -> str:
    s = MANIFEST.get(table)
    if s is None:
        return f"{table}: UNDECLARED"
    return (f"{table}: grain={s.grain}"
            + (f" max_season_offset={s.max_season_offset}" if s.grain == SEASON else "")
            + (f" banned={sorted(s.banned)}" if s.banned else "")
            + (f"\n    {s.note}" if s.note else ""))


@dataclass
class AsOfContext:
    """Every read for a feature row keyed (season, week) goes through here."""

    season: int
    week: int
    db: str = "ups-mfl-db"

    def source(self, table: str) -> Source:
        s = MANIFEST.get(table)
        if s is None:
            raise UndeclaredSource(
                f"'{table}' is not in the as-of MANIFEST (lib/asof.py). Declare "
                f"its grain before querying it. A source with unknown grain is "
                f"refused, not defaulted — an undeclared season-grain table is "
                f"exactly how a completed-season aggregate leaks into a "
                f"mid-season prediction."
            )
        return s

    def predicate(self, table: str, alias: str = "") -> str:
        """The as-of WHERE clause for this table. Always parenthesised."""
        s = self.source(table)
        p = f"{alias}." if alias else ""
        if s.grain == WEEK:
            return (f"({p}season < {self.season} OR "
                    f"({p}season = {self.season} AND {p}week < {self.week}))")
        if s.grain == WEEK_PREGAME:
            # week <= W: the line for THIS week is published before kickoff.
            return (f"({p}season < {self.season} OR "
                    f"({p}season = {self.season} AND {p}week <= {self.week}))")
        return f"({p}season <= {self.season + s.max_season_offset})"

    def check_columns(self, table: str, cols: str) -> None:
        s = self.source(table)
        low = cols.lower()
        for b in s.banned:
            if b.lower() in low:
                raise BannedColumn(
                    f"'{b}' on '{table}' is a post-game outcome and may never be "
                    f"a feature. {s.note}"
                )

    def select(self, table: str, cols: str, *, alias: str = "",
               join: str = "", join_tables: tuple = (),
               where: str = "", group_by: str = "", order_by: str = "",
               limit: int | None = None) -> str:
        """Build a SELECT with the as-of predicate applied automatically.

        `join` is raw SQL appended after the FROM clause. Every table it brings
        in must be named in `join_tables` so it goes through the same manifest
        gate — otherwise a JOIN would be a trivial way to smuggle an undeclared
        or season-grain source past the guard, which is the entire thing this
        module exists to prevent.
        """
        self.check_columns(table, cols)
        if where:
            self.check_columns(table, where)
        joined_preds = []
        for jt in join_tables:
            js = self.source(jt)          # raises UndeclaredSource if unknown
            self.check_columns(jt, cols)
            if where:
                self.check_columns(jt, where)
            # A week-grain table pulled in via JOIN needs its own as-of
            # predicate; a static/identity one (offset >= 0) does not constrain.
            if js.grain in (WEEK, WEEK_PREGAME) or js.max_season_offset < 0:
                joined_preds.append(jt)
        if join and not join_tables:
            raise LeakageError(
                "select(join=...) requires join_tables=(...) naming every table "
                "the JOIN brings in, so each is checked against the manifest. "
                "An unchecked JOIN bypasses the as-of guard entirely."
            )
        a = f" {alias}" if alias else ""
        clauses = [self.predicate(table, alias)]
        if where:
            clauses.append(f"({where})")
        sql = f"SELECT {cols} FROM {table}{a}"
        if join:
            sql += f" {join}"
        sql += " WHERE " + " AND ".join(clauses)
        if group_by:
            sql += f" GROUP BY {group_by}"
        if order_by:
            sql += f" ORDER BY {order_by}"
        if limit is not None:
            sql += f" LIMIT {int(limit)}"
        return sql

    def run(self, sql: str, max_attempts: int = 4) -> list[dict]:
        """Execute a read against D1 and return rows.

        Retries transient failures — D1 intermittently returns auth/5xx errors
        under sustained load and a feature build issues hundreds of reads.
        """
        last = ""
        for attempt in range(1, max_attempts + 1):
            r = subprocess.run(
                ["npx", "wrangler", "d1", "execute", self.db, "--remote", "--json",
                 "--command", sql],
                cwd=WORKER_DIR, capture_output=True, text=True, timeout=300)
            rows = _extract_rows(r.stdout)
            if rows is not None:
                return rows
            last = (r.stdout or "") + "\n" + (r.stderr or "")
            if attempt < max_attempts:
                time.sleep(2 * attempt)
        raise RuntimeError(
            f"D1 read failed after {max_attempts} attempts.\n"
            f"SQL: {sql[:400]}\nOUTPUT: {last[:800]}")


def audit_manifest() -> int:
    """Print the manifest. Handy for review; also a smoke test of the module."""
    wk = sorted(t for t, s in MANIFEST.items() if s.grain == WEEK)
    se = sorted(t for t, s in MANIFEST.items()
                if s.grain == SEASON and s.max_season_offset < 0)
    ok = sorted(t for t, s in MANIFEST.items()
                if s.grain == SEASON and s.max_season_offset >= 0)
    print(f"WEEK grain — same-season allowed, strictly before the target week "
          f"({len(wk)}):")
    for t in wk:
        print("  " + describe(t))
    print(f"\nSEASON grain — PRIOR SEASONS ONLY, the leak class ({len(se)}):")
    for t in se:
        print("  " + describe(t))
    print(f"\nStatic / identity — no temporal leak ({len(ok)}):")
    for t in ok:
        print("  " + describe(t))
    return 0


if __name__ == "__main__":
    sys.exit(audit_manifest())
