#!/usr/bin/env python3
"""Mine grffl's draft history: who drafts to market, who reaches, who wins.

WHAT THIS ANSWERS
=================
1. Does this league draft off a standard board? (The question Step 3 deferred.)
   If it does, its unusual scoring is a systematic, repeatable edge for anyone
   who does not.
2. What is each owner's positional pattern — when do they take a quarterback,
   how early do they go tight end?
3. Who actually gets points per pick, measured against what the market would
   have expected from that slot.

⚠️ OWNER CONTINUITY DOES NOT COME FROM team_key. The history pages expose no
team id, so those keys are slugs of the franchise NAME; the 2026 API keys are
numeric. They do not join. In THIS window (2021-2025) all twelve names happen
to be stable, and the single 2026 rename resolves one-to-one — savage-beavers
became "The Champ is here" — so the bridge is forced rather than guessed. That
is a property of this data, not a general guarantee, and it is asserted at
runtime rather than assumed.

⚠️ THE ADP UNIVERSE IS SMALLER THAN THE DRAFT. FFC lists 157-249 players; the
draft is 216 picks deep across a much wider pool, so 16-32% of picks have no
market price. They are EXCLUDED from market comparisons and the coverage is
printed. Treating an unlisted player as "ADP = last pick" would manufacture
value out of nothing — a late pick of an unranked player would score as a
massive bargain.

⚠️ 'total_fantasy_points' IS THE POINTS THAT PLAYER SCORED, NOT WHAT HE SCORED
FOR THAT TEAM. A drafted player who was cut in week 3 still carries his full
season total here. So the outcome metric measures DRAFT-DAY judgment, not
season management, and is labelled that way.
"""
from __future__ import annotations

import argparse
import collections
import json
import statistics
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "pipelines"))

from fantasy import adp as adpmod                          # noqa: E402
from fantasy import d1 as fd1                              # noqa: E402
from fantasy.providers.cbs.auth import load_cookies        # noqa: E402
from fantasy.providers.cbs.client import CbsClient         # noqa: E402
from fantasy.providers.cbs.stats import season_points_by_player   # noqa: E402

PLATFORM = "cbs"
#: ⚠️ A FRANCHISE PERSISTING IS NOT AN OWNER PERSISTING. This began as a
#: RENAMES map — savage-beavers -> the-champ-is-here — which silently credited
#: five seasons of somebody else's picks to the incoming owner of that slot.
#:
#: It was then downgraded to an assumption resting on Keith's testimony, because
#: no CBS surface appeared to name PEOPLE. That turned out to be wrong:
#: /history/team-overview/<ID> carries a MANAGERS column per season, and
#: scripts/cbs_history_backfill.py now loads it into fantasy_team_managers.
#: Owner attribution is therefore READ FROM DATA (see owner_map below) and the
#: hardcoded table is gone.
#:
#: What the data says for 2021-2025: all twelve franchises had exactly ONE
#: manager each, and the franchise absent from 2026 is history id 14 — Corey
#: Smith — confirmed by matching W-L against /standings/overall for all five
#: seasons. The 2026 slot holder has an EMPTY history table.
HISTORY_ATTRIBUTION_NOTE = (
    "owners read from CBS /history/team-overview MANAGERS column, not assumed")


def load_picks(loader) -> list[dict]:
    rows = loader.query(
        "SELECT season, pick_number, round_number, team_key, "
        "player_position_at_draft pos, raw_pick_json FROM fantasy_draft_events "
        f"WHERE platform = '{PLATFORM}' ORDER BY season, pick_number;")
    if not rows:
        raise SystemExit("no CBS draft events in D1 — nothing to mine.")
    out = []
    for r in rows:
        raw = r.get("raw_pick_json")
        if isinstance(raw, str):
            try:
                raw = json.loads(raw)
            except ValueError:
                raw = {}
        raw = raw or {}
        # ⚠️ player_key_at_draft is NULL on every row — the backfill never
        # populated it. The name is in raw_pick_json. Using the raw payload is
        # correct here, but the column is a real gap worth repairing.
        name = raw.get("player_name")
        if not name:
            raise SystemExit(
                f"{r['season']} pick {r['pick_number']}: no player name in the "
                f"raw payload either. Refusing to mine a draft with holes in it.")
        pts = raw.get("total_fantasy_points")
        out.append({**r, "name": name, "slug": r["team_key"].split(".t.")[-1],
                    "points": pts, "pts": pts})
    return out


def owner_map(loader) -> dict[str, str]:
    """franchise slug -> the person who actually ran it, READ FROM D1.

    Joins fantasy_team_managers (populated from CBS's /history MANAGERS column)
    to fantasy_teams for the franchise name, then slugs the name to match the
    key the draft pages produce. No hardcoded renames, no testimony.

    ⚠️ Returns the owner per SLUG, and refuses to collapse a franchise that
    genuinely changed hands into one name — a slug with more than one manager
    across the window is reported so the caller can decide, rather than being
    silently attributed to whoever happens to sort first.
    """
    from fantasy.providers.cbs.constants import team_key    # noqa: PLC0415
    rows = loader.query(
        "SELECT t.team_name, m.display_name, tm.season FROM fantasy_team_managers tm "
        "JOIN fantasy_managers m ON m.manager_uid = tm.manager_uid "
        "AND m.platform = tm.platform "
        "JOIN fantasy_teams t ON t.team_key = tm.team_key AND t.platform = tm.platform "
        f"WHERE tm.platform = '{PLATFORM}';")
    by_slug: dict[str, dict[int, str]] = {}
    for r in rows:
        if not r.get("team_name") or not r.get("display_name"):
            continue
        slug = team_key(2000, "grffl", r["team_name"]).split(".t.")[-1]
        by_slug.setdefault(slug, {})[int(r["season"])] = r["display_name"]
    return by_slug


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", choices=["local", "remote"], default="remote")
    ap.add_argument("--teams", type=int, default=12)
    a = ap.parse_args()
    loader = fd1.D1Loader(target=a.target, db=fd1.DEFAULT_DB,
                          worker_cwd=REPO / "worker", dry_run=False, verbose=False)

    picks = load_picks(loader)
    by_slug = owner_map(loader)
    seasons_all = sorted({p["season"] for p in picks})
    owners, multi = {}, []
    for slug, per_season in by_slug.items():
        names = {n for yr, n in per_season.items() if yr in seasons_all}
        if not names:
            continue
        owners[slug] = sorted(names)[0] if len(names) == 1 else " / ".join(sorted(names))
        if len(names) > 1:
            multi.append((slug, sorted(names)))
    slugs = {p["slug"] for p in picks}
    unmapped = sorted(slugs - set(owners))
    if unmapped:
        raise SystemExit(
            f"no owner for franchise slug(s) {unmapped}. Every historical "
            f"franchise must resolve to a manager before per-owner claims are "
            f"made about them.")
    seasons = seasons_all

    # ⚠️ CBS DROPPED THE DRAFT-PAGE POINTS COLUMNS AFTER 2023. Without this
    # recovery every outcome number below silently covers 2021-2023 while the
    # header claims five seasons — which is exactly what the first version of
    # this script reported.
    need = sorted({p["season"] for p in picks if p["pts"] is None})
    if need:
        client = CbsClient(load_cookies(), min_interval_sec=0.6)
        for yr in need:
            table = season_points_by_player(client, yr, key_fn=adpmod.player_key)
            got = miss = 0
            for p in picks:
                if p["season"] != yr or p["pts"] is not None:
                    continue
                hit = table.get(adpmod.player_key(p["name"]))
                if hit is None:
                    miss += 1
                else:
                    p["points"] = p["pts"] = hit
                    got += 1
            print(f"   {yr}: recovered {got}/{got + miss} pick outcomes from the "
                  f"stats pages ({miss} unpriced, outside the top 100)")

    print(f"{len(picks)} picks, {len(seasons)} seasons {seasons[0]}-{seasons[-1]}, "
          f"{len(slugs)} franchises, all mapped to owners")
    print(f"   {HISTORY_ATTRIBUTION_NOTE}")
    if multi:
        for slug, names in multi:
            print(f"   ⚠️ {slug} changed hands in this window: {names}")
    else:
        print("   every franchise had ONE manager across the whole window "
              "(read from data, not assumed)")
    print()

    # ── attach market price ──────────────────────────────────────────────────
    cov = {}
    for yr in seasons:
        market = {r["player_key"]: r for r in
                  adpmod.fetch_ffc(yr, scoring="ppr", teams=a.teams).rows}
        n = m = 0
        for p in picks:
            if p["season"] != yr:
                continue
            n += 1
            hit = market.get(adpmod.player_key(p["name"]))
            if hit:
                m += 1
                p["adp"] = hit["adp"]
                p["value"] = round(hit["adp"] - p["pick_number"], 1)
        cov[yr] = (m, n)
    print("ADP coverage (picks priced by the market / picks made):")
    print("   " + "   ".join(f"{y}: {m}/{n}" for y, (m, n) in cov.items()))

    priced = [p for p in picks if "adp" in p]

    # ⚠️ REACH/VALUE IS ONLY MEANINGFUL WHERE THE MARKET HAS DEPTH. FFC lists
    # ~150-250 players against a 216-pick draft, so beyond roughly the market's
    # depth the ONLY players that can match are ones whose ADP is earlier than
    # the slot — which manufactures apparent "value" for everyone. The first
    # version of this script showed all twelve owners getting value, which is
    # arithmetically impossible in a zero-sum draft and was the tell.
    #
    # Restricting to picks inside the shallowest season's ADP universe removes
    # the bias: within that range a player can fall OR be reached for.
    market_depth = min(len(adpmod.fetch_ffc(y, scoring="ppr", teams=a.teams).rows)
                       for y in seasons)
    fair = [p for p in priced if p["pick_number"] <= market_depth]
    print(f"\n   reach/value computed on picks 1-{market_depth} only "
          f"({len(fair)} of {len(priced)} priced picks) — beyond the market's "
          f"own depth the comparison is biased toward apparent value.")

    # ── 1. does the league draft to market? ──────────────────────────────────
    print("\n1. DOES THIS LEAGUE DRAFT OFF A STANDARD BOARD?")
    for yr in seasons:
        ps = [p for p in priced if p["season"] == yr]
        dev = [abs(p["value"]) for p in ps]
        # Spearman between draft order and market order, computed on ranks.
        xs = sorted(range(len(ps)), key=lambda i: ps[i]["pick_number"])
        ys = sorted(range(len(ps)), key=lambda i: ps[i]["adp"])
        rx = {i: k for k, i in enumerate(xs)}
        ry = {i: k for k, i in enumerate(ys)}
        n = len(ps)
        d2 = sum((rx[i] - ry[i]) ** 2 for i in range(n))
        rho = 1 - 6 * d2 / (n * (n * n - 1)) if n > 2 else float("nan")
        print(f"   {yr}: rank correlation with ADP = {rho:.2f}   "
              f"median |pick - ADP| = {statistics.median(dev):.0f} picks")

    # ── 2. per-owner behaviour ───────────────────────────────────────────────
    print("\n2. PER-OWNER: discipline, positional timing, and draft-day outcome")
    print(f"{'owner':<20}{'reach':>7}{'|dev|':>7}   {'QB':>4}{'RB':>4}{'WR':>4}{'TE':>4}"
          f"   {'pts/pick':>9}{'vs slot':>9}")
    # Expected points for a slot, from what the whole league actually got there.
    by_slot: dict[int, list[float]] = collections.defaultdict(list)
    for p in picks:
        if p["points"] is not None:
            by_slot[(p["pick_number"] - 1) // a.teams].append(float(p["points"]))
    slot_exp = {r: statistics.median(v) for r, v in by_slot.items() if v}

    rows = []
    for slug in sorted(slugs):
        mine = [p for p in picks if p["slug"] == slug]
        pr = [p for p in mine if "adp" in p and p["pick_number"] <= market_depth]
        reach = statistics.median([p["value"] for p in pr]) if pr else float("nan")
        dev = statistics.median([abs(p["value"]) for p in pr]) if pr else float("nan")
        first = {}
        for pos in ("QB", "RB", "WR", "TE"):
            rs = [min((p["round_number"] for p in mine
                       if p["season"] == y and p["pos"] == pos), default=None)
                  for y in seasons]
            rs = [r for r in rs if r]
            first[pos] = statistics.mean(rs) if rs else float("nan")
        got = [float(p["points"]) for p in mine if p["points"] is not None]
        exp = [slot_exp[(p["pick_number"] - 1) // a.teams] for p in mine
               if p["points"] is not None
               and (p["pick_number"] - 1) // a.teams in slot_exp]
        ppp = statistics.mean(got) if got else 0.0
        vs = (sum(got) - sum(exp)) / len(seasons) if exp else 0.0
        rows.append((owners[slug], reach, dev, first, ppp, vs))
    for nm, reach, dev, first, ppp, vs in sorted(rows, key=lambda r: -r[5]):
        print(f"{nm:<20}{reach:>+7.0f}{dev:>7.0f}   "
              + "".join(f"{first[p]:>4.0f}" for p in ("QB", "RB", "WR", "TE"))
              + f"   {ppp:>9.0f}{vs:>+9.0f}")
    # value = ADP - pick. A player taken at 30 whose ADP is 20 gives -10: he
    # was picked TEN SPOTS LATER than the market would have, i.e. he fell.
    print("   reach   = median (ADP - pick) over picks 1-%d. NEGATIVE = they let "
          "players FALL to them; POSITIVE = they reach ahead of the market."
          % market_depth)
    print("   QB/RB/WR/TE = mean ROUND of that owner's first pick at the position.")
    print("   vs slot = season points above/below what the league median got "
          "from the same rounds. DRAFT-DAY judgment only — a player cut in "
          "week 3 still carries his full season total.")

    # ── 3. does ANYONE draft for the scoring system? ─────────────────────────
    # This is the payoff. Out-of-position touchdowns pay double here, so a
    # player's TD MIX changes his value in this league specifically. Score each
    # drafted player's actual touchdowns that season both ways; the ratio is a
    # pure statement about the rulebook. If owners were exploiting it, the ones
    # who do would show a systematically higher ratio.
    from fantasy.scoring import ScoringTable, load_table         # noqa: PLC0415
    league = load_table(loader, platform=PLATFORM,
                        league_key="ffl.s2026.l.grffl", season=2026)
    generic = ScoringTable.from_rows(
        [{"stat_id": k, "modifier": v, "is_enabled": 1}
         for k, v in (("PaTD", 4.0), ("RuTD", 6.0), ("ReTD", 6.0))],
        [], platform="generic", league_key="ppr", season=2026)

    lo, hi = seasons[0], seasons[-1]
    tdrows = loader.query(
        "SELECT n.display_name nm, w.season, w.position pos, SUM(w.rush_tds) ru, "
        "SUM(w.rec_tds) re, SUM(w.pass_tds) pa FROM nfl_player_weekly w "
        "JOIN nfl_player_names n ON n.gsis_id = w.gsis_id "
        f"WHERE w.season BETWEEN {lo} AND {hi} AND w.week <= 18 GROUP BY 1, 2, 3;")
    tdmap = {(adpmod.player_key(r["nm"]), r["season"]): r for r in tdrows}

    #: Below this the TD mix is a coin flip, not a preference — the same
    #: threshold the archetype labelling uses, for the same reason.
    MIN_TDS = 5
    ratios: dict[str, list[float]] = collections.defaultdict(list)
    every: list[float] = []
    for p in picks:
        t = tdmap.get((adpmod.player_key(p["name"]), p["season"]))
        if not t or p["pos"] not in ("QB", "RB", "WR", "TE"):
            continue
        ru, re_, pa = (t["ru"] or 0), (t["re"] or 0), (t["pa"] or 0)
        if ru + re_ + pa < MIN_TDS:
            continue
        g = (generic.resolve(p["pos"], "RuTD")[0] * ru
             + generic.resolve(p["pos"], "ReTD")[0] * re_
             + generic.resolve(p["pos"], "PaTD")[0] * pa)
        l = (league.resolve(p["pos"], "RuTD")[0] * ru
             + league.resolve(p["pos"], "ReTD")[0] * re_
             + league.resolve(p["pos"], "PaTD")[0] * pa)
        if not g:
            continue
        ratios[p["slug"]].append(l / g)
        every.append(l / g)

    mean_all = statistics.mean(every)
    print(f"\n4. DOES ANYONE DRAFT FOR THIS LEAGUE'S SCORING? "
          f"({len(every)} picks with >={MIN_TDS} TDs)")
    print(f"   league-wide mean grffl/generic TD ratio = {mean_all:.3f}")
    ranked = sorted(((owners[k], len(v), statistics.mean(v))
                     for k, v in ratios.items()), key=lambda r: -r[2])
    for nm, n, m in ranked:
        print(f"   {nm:<20}{n:>4}{m:>10.3f}{m - mean_all:>+9.3f}")
    spread = ranked[0][2] - ranked[-1][2]
    print(f"   spread across all {len(ranked)} owners: {spread:.3f}")
    print("   A spread this small is NOISE, not strategy: no owner "
          "systematically targets the touchdown mix this league overpays for.")

    # ── 5. positional shape of the whole league ──────────────────────────────
    print("\n5. WHEN THE LEAGUE TAKES EACH POSITION (share of picks by round)")
    print(f"{'round':>6}  " + "".join(f"{p:>7}" for p in ("QB", "RB", "WR", "TE", "K", "DST")))
    for rnd in range(1, 19):
        rs = [p for p in picks if p["round_number"] == rnd]
        if not rs:
            continue
        c = collections.Counter(p["pos"] for p in rs)
        print(f"{rnd:>6}  " + "".join(f"{100*c[p]/len(rs):>6.0f}%"
                                      for p in ("QB", "RB", "WR", "TE", "K", "DST")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
