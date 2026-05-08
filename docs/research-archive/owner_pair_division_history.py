#!/usr/bin/env python3
"""
Compute, for each pair of UPS league owners, how many seasons they've
shared a division — keyed by owner name (not franchise id, not team name).

Data source: ~/Library/Mobile Documents/com~apple~CloudDocs/Desktop/
             MFL_Scripts/Datastorage/mfl_database.db
             franchises table — covers 2010-2025 (16 seasons, 192 rows).
             Owner identity persists; franchise IDs do not (they get
             reshuffled across years), so keying by owner_name is the
             only correct pivot.

Outputs:
  - scripts/owner_pair_division_history.csv     (all-time pair matrix)
  - scripts/owner_pair_division_history.md      (markdown summary report)

Caveats handled:
  - "Dave Murray" / "David Murray" → normalized to "David Murray"
  - "John Richard, Jarrade Nieber" — co-owner pair, kept as one entity
  - "AJ Balderelli" + "Rico Balderelli" — different people (brothers,
     different franchises 2018-2022), kept distinct
"""

from __future__ import annotations
import sqlite3
import csv
from collections import defaultdict
from itertools import combinations
from pathlib import Path

DB_PATH = Path(
    "/Users/keithcreelman/Library/Mobile Documents/com~apple~CloudDocs/"
    "Desktop/MFL_Scripts/Datastorage/mfl_database.db"
)
OUT_DIR = Path(__file__).resolve().parent
OUT_CSV = OUT_DIR / "owner_pair_division_history.csv"
OUT_MD = OUT_DIR / "owner_pair_division_history.md"
OUT_CONTEXT = OUT_DIR / "owner_divisional_history_for_context.md"

# Coverage: 2011 (initial league realignment) through 2025. 2010 excluded
# (pre-realignment seed era). Realignment cycles below match the league's
# 3-year reset cadence per Keith's directive.
SEASON_MIN = 2011
SEASON_MAX = 2025

REALIGNMENT_CYCLES = [
    ("2011–2013", 2011, 2013),
    ("2014–2016", 2014, 2016),
    ("2017–2019", 2017, 2019),
    ("2020–2022", 2020, 2022),
    ("2023–2025", 2023, 2025),
]


def cycle_for_season(season: int) -> str | None:
    for label, lo, hi in REALIGNMENT_CYCLES:
        if lo <= season <= hi:
            return label
    return None

# 12 current UPS owners. Used to slice the "current league pair matrix"
# from the broader all-time matrix.
CURRENT_OWNERS = {
    "Bear Dunn", "Brian Cross", "Brian Cutting", "Chris Klingenberg",
    "Derrick Whitman", "Eric Mannila", "Eric Martel", "Josh Martel",
    "Keith Creelman", "Matt Gerardi", "Ryan Bousquet", "Shawn Blake",
}

# Light name normalization. Anything not in this dict passes through unchanged.
NAME_NORMALIZE = {
    "Dave Murray": "David Murray",  # same person, different label years
}


def normalize(name: str) -> str:
    return NAME_NORMALIZE.get(name, name).strip()


def fetch_rows() -> list[tuple]:
    """Return list of (season, franchise_id, owner_name, division) for SEASON_MIN..SEASON_MAX."""
    if not DB_PATH.exists():
        raise SystemExit(f"DB not found at {DB_PATH}")
    conn = sqlite3.connect(str(DB_PATH))
    rows = conn.execute(f"""
        SELECT season, franchise_id, owner_name, division
        FROM franchises
        WHERE season BETWEEN {SEASON_MIN} AND {SEASON_MAX}
          AND division IS NOT NULL
          AND owner_name IS NOT NULL AND owner_name != ''
        ORDER BY season, division, franchise_id
    """).fetchall()
    conn.close()
    return rows


def compute_cycle_allplay_leaders() -> list[dict]:
    """For each realignment cycle, aggregate AP wins/losses per owner across
    the cycle's 3 seasons, then rank owners by aggregate AP%. Returns a list
    of dicts: { cycle, leader, ranked, seasons }.

    Source: mfl_database.db `standings` table — has owner_name + allplay_w/l
    per (season, franchise_id) for full 2010-2025 coverage.
    """
    if not DB_PATH.exists():
        return []
    conn = sqlite3.connect(str(DB_PATH))
    out = []
    for cycle_label, lo, hi in REALIGNMENT_CYCLES:
        rows = conn.execute(f"""
            SELECT owner_name, allplay_w, allplay_l, season
            FROM standings
            WHERE season BETWEEN {lo} AND {hi}
              AND owner_name IS NOT NULL AND owner_name != ''
        """).fetchall()
        agg: dict[str, dict[str, int]] = defaultdict(lambda: {"w": 0, "l": 0})
        seasons_in_data = sorted({int(r[3]) for r in rows})
        for owner, w, l, _season in rows:
            owner = normalize(owner)
            agg[owner]["w"] += int(w or 0)
            agg[owner]["l"] += int(l or 0)
        ranked = []
        for owner, rec in agg.items():
            total = rec["w"] + rec["l"]
            if total == 0:
                continue
            ranked.append({"owner": owner, "w": rec["w"], "l": rec["l"], "pct": rec["w"] / total})
        ranked.sort(key=lambda r: -r["pct"])
        out.append({
            "cycle": cycle_label,
            "seasons": seasons_in_data,
            "leader": ranked[0] if ranked else None,
            "ranked": ranked,
        })
    conn.close()
    return out


def main():
    rows = fetch_rows()
    # season -> division -> [owner names]
    season_div_owners: dict[int, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
    owner_active_seasons: dict[str, set[int]] = defaultdict(set)
    seasons_seen: set[int] = set()

    for season, fid, owner, division in rows:
        season = int(season)
        owner = normalize(owner)
        division = str(division).strip()
        season_div_owners[season][division].append(owner)
        owner_active_seasons[owner].add(season)
        seasons_seen.add(season)

    # pair (a,b sorted) -> sorted set of seasons they shared a division
    pair_seasons: dict[tuple[str, str], set[int]] = defaultdict(set)
    # pair -> sorted set of cycle labels they shared at least one season in
    pair_cycles: dict[tuple[str, str], set[str]] = defaultdict(set)
    # per-owner: set of distinct owner names they've ever been division-mates with
    owner_unique_mates: dict[str, set[str]] = defaultdict(set)
    # per-owner: set of cycles they were active in
    owner_active_cycles: dict[str, set[str]] = defaultdict(set)

    for season, divs in season_div_owners.items():
        cyc = cycle_for_season(season)
        for div, owners_in_div in divs.items():
            unique = sorted(set(owners_in_div))
            for o in unique:
                if cyc:
                    owner_active_cycles[o].add(cyc)
            for a, b in combinations(unique, 2):
                pair_seasons[(a, b)].add(season)
                if cyc:
                    pair_cycles[(a, b)].add(cyc)
                owner_unique_mates[a].add(b)
                owner_unique_mates[b].add(a)

    all_owners = sorted(owner_active_seasons.keys())
    seasons_sorted = sorted(seasons_seen)

    # ------- CSV -------
    with OUT_CSV.open("w", newline="") as f:
        w = csv.writer(f)
        w.writerow([
            "owner_a", "owner_b", "years_paired",
            "seasons_paired", "owner_a_active_count",
            "owner_b_active_count", "max_possible_overlap",
        ])
        for a, b in combinations(all_owners, 2):
            sa = owner_active_seasons[a]
            sb = owner_active_seasons[b]
            overlap = sorted(sa & sb)
            paired = sorted(pair_seasons.get((a, b), set()))
            w.writerow([
                a, b, len(paired),
                ",".join(str(s) for s in paired),
                len(sa), len(sb), len(overlap),
            ])

    # ------- Markdown -------
    md = []
    md.append("# UPS League — Owner Pair Divisional History")
    md.append("")
    md.append(f"_Source: `mfl_database.db.franchises` — full coverage **{seasons_sorted[0]}–{seasons_sorted[-1]}** ({len(seasons_seen)} seasons, {len(rows)} franchise-seasons, {len(all_owners)} distinct owners across history)._")
    md.append("")
    md.append("## Current 12 owners — pair matrix (all-time)")
    md.append("")
    md.append("Filtered to the 12 owners currently in the league. Columns:")
    md.append("- **Years paired**: seasons both owners were in the same division")
    md.append("- **Both-active seasons**: seasons both owners were in the league")
    md.append("- **Pair rate**: years paired ÷ both-active seasons")
    md.append("")
    md.append("| Owner A | Owner B | Years paired | Both-active seasons | Pair rate | Seasons |")
    md.append("|---------|---------|-------------:|--------------------:|----------:|---------|")
    current = sorted(CURRENT_OWNERS & set(all_owners))
    rows_for_md = []
    for a, b in combinations(current, 2):
        seasons = sorted(pair_seasons.get((a, b), set()))
        sa = owner_active_seasons.get(a, set())
        sb = owner_active_seasons.get(b, set())
        overlap = len(sa & sb)
        rows_for_md.append((a, b, len(seasons), seasons, overlap))
    rows_for_md.sort(key=lambda r: (-r[2], -r[4], r[0], r[1]))
    for a, b, yrs, seasons, overlap in rows_for_md:
        rate = f"{(yrs / overlap):.0%}" if overlap else "—"
        seasons_str = ", ".join(str(s) for s in seasons) if seasons else "—"
        md.append(f"| {a} | {b} | {yrs} | {overlap} | {rate} | {seasons_str} |")

    md.append("")
    md.append("## Current owners — never paired (despite years of shared league time)")
    md.append("")
    md.append("Sorted by both-active seasons descending — the longer they've shared the league without ever being divisional opponents-of-record, the more glaring.")
    md.append("")
    md.append("| Owner A | Owner B | Both-active seasons |")
    md.append("|---------|---------|--------------------:|")
    never = [r for r in rows_for_md if r[2] == 0]
    never.sort(key=lambda r: (-r[4], r[0], r[1]))
    for a, b, yrs, seasons, overlap in never:
        md.append(f"| {a} | {b} | {overlap} |")

    md.append("")
    md.append("## Per-owner active-season count (current owners)")
    md.append("")
    md.append("| Owner | First season | Last season | Active seasons |")
    md.append("|-------|-------------:|------------:|--------------:|")
    for o in current:
        sa = sorted(owner_active_seasons[o])
        md.append(f"| {o} | {sa[0]} | {sa[-1]} | {len(sa)} |")

    md.append("")
    md.append("## All-time pair leaderboard (top 25, any owners ever)")
    md.append("")
    md.append("Includes former owners. Useful for spotting historical divisional rivalries that current owners 'inherit' contextually.")
    md.append("")
    md.append("| # | Owner A | Owner B | Years paired | Both-active |")
    md.append("|---|---------|---------|-------------:|------------:|")
    all_pairs = []
    for a, b in combinations(all_owners, 2):
        seasons = pair_seasons.get((a, b), set())
        sa = owner_active_seasons[a]
        sb = owner_active_seasons[b]
        all_pairs.append((a, b, len(seasons), len(sa & sb)))
    all_pairs.sort(key=lambda r: (-r[2], -r[3], r[0], r[1]))
    for i, (a, b, yrs, overlap) in enumerate(all_pairs[:25], 1):
        md.append(f"| {i} | {a} | {b} | {yrs} | {overlap} |")

    md.append("")
    md.append("## Notes")
    md.append("")
    md.append('- "Dave Murray" / "David Murray" normalized to a single owner.')
    md.append('- "John Richard, Jarrade Nieber" treated as one entity (co-owner pair, F0005, 2017-2018).')
    md.append('- "AJ Balderelli" and "Rico Balderelli" are separate people (different franchises 2018-2022).')
    md.append('- Pair rate excludes seasons where one or both owners were not in the league.')
    md.append(f"- Coverage starts at {SEASON_MIN} (the league's initial divisional alignment); 2010 is excluded as the pre-realignment seed era.")

    OUT_MD.write_text("\n".join(md))

    # ------- Per-owner detail (for league context grounding) -------
    ctx = []
    ctx.append("## Appendix — Divisional Co-tenancy History (2011-2025)")
    ctx.append("")
    ctx.append(f"Source: `mfl_database.db.franchises`. Coverage: {SEASON_MIN}-{SEASON_MAX} ({len(seasons_sorted)} seasons across 5 realignment cycles: {', '.join(c[0] for c in REALIGNMENT_CYCLES)}). Realignment cadence is every 3 years; next realignment 2026.")
    ctx.append("")
    ctx.append("This appendix is grounding for the AI explainer when owners ask questions like *\"how often have I been in the same division as X?\"* — names + numbers are intentionally included here because the bot needs them to answer specifically.")
    ctx.append("")
    ctx.append("### Aggregate (current 12 owners)")
    ctx.append("")
    total_possible = len(list(combinations(current, 2)))
    ever = sum(1 for r in rows_for_md if r[2] > 0)
    never = sum(1 for r in rows_for_md if r[2] == 0)
    ctx.append(f"- **{total_possible}** possible pairs among current owners")
    ctx.append(f"- **{ever}** pairs have shared a division at least once")
    ctx.append(f"- **{never}** pairs have NEVER shared a division")
    ctx.append("- Pairs with the most seasons-of-overlap that have STILL never been paired: see the body of this appendix.")
    ctx.append("")
    ctx.append("### Realignment cycles (for context)")
    ctx.append("")
    ctx.append("Every 3 years the league realigns divisions. Owners only get the chance to be paired in a new way at each realignment boundary.")
    ctx.append("")
    ctx.append("| Cycle | Seasons |")
    ctx.append("|-------|---------|")
    for label, lo, hi in REALIGNMENT_CYCLES:
        ctx.append(f"| {label} | {lo}, {lo+1}, {hi} |")
    ctx.append("")
    ctx.append("### Per-owner: division mates ever, mates still in league")
    ctx.append("")
    ctx.append("| Owner | Cycles in league | Distinct mates ever | Mates still in league today | Current owners NEVER paired with |")
    ctx.append("|-------|-----------------:|--------------------:|----------------------------:|---------------------------------:|")
    for o in sorted(CURRENT_OWNERS & set(all_owners)):
        cycles = len(owner_active_cycles.get(o, set()))
        mates_ever = owner_unique_mates.get(o, set())
        mates_current = mates_ever & CURRENT_OWNERS
        # Current owners they've never been paired with (excluding themselves)
        never_with = (CURRENT_OWNERS - {o}) - mates_current
        ctx.append(f"| {o} | {cycles} | {len(mates_ever)} | {len(mates_current)} | {len(never_with)} |")
    ctx.append("")
    ctx.append("### Per-owner detail")
    ctx.append("")
    ctx.append("For each current owner: their cycle-by-cycle division-mates among current owners, plus the current owners they've never shared a division with.")
    ctx.append("")
    for o in sorted(CURRENT_OWNERS & set(all_owners)):
        ctx.append(f"#### {o}")
        sa = sorted(owner_active_seasons.get(o, []))
        cycles_in = sorted(owner_active_cycles.get(o, set()))
        ctx.append(f"- **Active:** {sa[0]}-{sa[-1]} ({len(sa)} seasons, {len(cycles_in)} cycles: {', '.join(cycles_in) or '—'})")
        # Current-owner pair detail
        paired_current = []
        for other in sorted(CURRENT_OWNERS - {o}):
            key = tuple(sorted([o, other]))
            seasons = sorted(pair_seasons.get(key, set()))
            cycles = sorted(pair_cycles.get(key, set()))
            if seasons:
                paired_current.append((other, len(seasons), seasons, cycles))
        paired_current.sort(key=lambda r: (-r[1], r[0]))
        if paired_current:
            ctx.append("- **Current owners paired with (years · cycles · seasons):**")
            for other, n, seasons, cycles in paired_current:
                ctx.append(f"    - {other}: **{n}** seasons across {len(cycles)} cycle(s) — {', '.join(str(s) for s in seasons)}")
        never_with = sorted((CURRENT_OWNERS - {o}) - {p[0] for p in paired_current})
        if never_with:
            ctx.append(f"- **Current owners NEVER paired with:** {', '.join(never_with)}")
        ctx.append("")

    # ------- Historical cycle AP% leaders -------
    cycle_leaders = compute_cycle_allplay_leaders()
    ctx.append("### Historical 3-Year Cycle AP% Leaders (informal, never officially recognized)")
    ctx.append("")
    ctx.append("Aggregate All-Play win% across each 3-year cycle, by owner. **Never paid out** — informal record only. Included here so the bot can answer 'who would have won the Dynasty Pot in cycle X?' if Dynasty Pot vote passes.")
    ctx.append("")
    ctx.append("| Cycle | Leader | AP record | AP% | Runner-up | Runner-up AP% |")
    ctx.append("|-------|--------|-----------|----:|-----------|---------------:|")
    for c in cycle_leaders:
        leader = c["leader"]
        runner = c["ranked"][1] if len(c["ranked"]) > 1 else None
        if leader:
            ctx.append(
                f"| {c['cycle']} | **{leader['owner']}** | {leader['w']}–{leader['l']} | "
                f"{leader['pct']:.1%} | {runner['owner'] if runner else '—'} | "
                f"{(runner['pct']):.1%}".rstrip(' ') if runner else
                f"| {c['cycle']} | **{leader['owner']}** | {leader['w']}–{leader['l']} | {leader['pct']:.1%} | — | — |"
            )
            # safer single-line format below replaces the conditional above
        else:
            ctx.append(f"| {c['cycle']} | _(no data)_ | — | — | — | — |")
    # Replace the conditional rendering above with a deterministic loop.
    # (The prior conditional had brittle string-join; below overwrites the rows cleanly.)
    # Rebuild rows cleanly:
    while ctx[-1].startswith("| "):
        ctx.pop()
    for c in cycle_leaders:
        leader = c["leader"]
        runner = c["ranked"][1] if len(c["ranked"]) > 1 else None
        if leader:
            leader_str = f"**{leader['owner']}**"
            rec_str = f"{leader['w']}–{leader['l']}"
            pct_str = f"{leader['pct']:.1%}"
        else:
            leader_str = rec_str = pct_str = "—"
        if runner:
            ru_str = runner["owner"]
            ru_pct = f"{runner['pct']:.1%}"
        else:
            ru_str = ru_pct = "—"
        ctx.append(f"| {c['cycle']} | {leader_str} | {rec_str} | {pct_str} | {ru_str} | {ru_pct} |")
    ctx.append("")

    OUT_CONTEXT.write_text("\n".join(ctx))

    print(f"Wrote {OUT_CSV.name} ({len(list(combinations(all_owners, 2)))} pairs across {len(all_owners)} owners)")
    print(f"Wrote {OUT_MD.name}")
    print(f"Wrote {OUT_CONTEXT.name} (for inclusion in league_context_v1.md)")
    print(f"Coverage: {seasons_sorted[0]}-{seasons_sorted[-1]} ({len(seasons_seen)} seasons)")
    print(f"Current-12-owner pairs: {ever} ever paired, {never} never paired")


if __name__ == "__main__":
    main()
